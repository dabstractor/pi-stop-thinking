/**
 * # StreamProxy — transparent forward-only event pipeline.
 *
 * **Responsibility** (PRD §13.2 Stream Proxy / §20 Stream Proxy Design): present exactly one
 * continuous {@link AssistantMessageEventStream} to Pi regardless of upstream activity. In this
 * forward-only phase there is a single upstream stream that is authoritative for the whole response;
 * later phases add reasoning detection (P1.M4), abort (P1.M5), and a second spliced upstream
 * (P1.M7). This class owns the **one outbound queue** (PRD §20.5) and forwards every upstream event
 * into it unchanged.
 *
 * **Ownership**: one outbound `AssistantMessageEventStream` (created in the constructor), one
 * per-request {@link TransitionController} (PRD §16 FSM), one per-request {@link ReasoningBuffer}
 * (PRD §13.4/§23 reasoning capture). The controller + buffer are injected or self-created with
 * defaults (optional DI — existing 5-arg callers unchanged).
 *
 * **Lifecycle**: constructed per request on the z.ai reasoning path (P1.M2.T3.S1). The constructor
 * starts the pipeline (`run`) fire-and-forget; the pipeline completes when the upstream's terminal
 * event is forwarded. No explicit dispose — the streams + controller + buffer garbage-collect once
 * drained.
 *
 * **Invariants** (PRD §13.2 Guarantees):
 *  - Exactly **one** `message_start` (`start`) reaches the downstream consumer (the upstream emits
 *    exactly one; it is forwarded unchanged).
 *  - Exactly **one** terminal `message_end` (`done` OR `error`) reaches the consumer.
 *  - Exactly **one** completed result — `output.result()` resolves exactly once, to the
 *    `AssistantMessage` carried by the (single) terminal event.
 *  - No duplicate, missing, or reordered events (pure forwarding preserves order).
 *  - The downstream consumer never interacts with an upstream stream directly (PRD §20.5).
 *  - Reasoning detection is a **pure side effect** layered onto the forwarding loop (PRD §19.7 / ADR-005
 *    observational equivalence): `trackEvent(event)` runs, then `push(event)` runs unchanged. Detection
 *    never mutates, drops, reorders, or duplicates an event.
 *
 * **Failure modes**: in the normal path the upstream emits its own terminal `done`/`error` event,
 * which is forwarded and completes the stream. If `run` throws *before* a terminal is pushed (e.g.
 * `upstreamStreamFn` throws synchronously, or the upstream iterator throws), a single synthesized
 * `error` terminal is pushed so the downstream never hangs and the single-terminal/single-result
 * invariants still hold. (Network/provider failures surface as `error` *events* from the upstream and
 * are forwarded normally — the synthesis path is a defensive guard for the degenerate throw case;
 * formal failure-mode handling is P1.M8.T2.)
 *
 * **§16 normal-flow limitation**: the FSM models the interruption lifecycle and has NO normal-completion
 * exit from `Reasoning` (only `StopRequested`/`Failed`). A normal (non-interrupted) stream leaves the
 * controller in `Reasoning` — this is acceptable (P1.M4, no shortcut wired) and reconciled when the
 * interruption flow (Reasoning→StopRequested) is active (P1.M5).
 *
 * Consumed by: P1.M2.T3.S1 (decorator wiring), P1.M4 (reasoning detection — this subtask),
 * P1.M4.T4 (TransitionCoordinator queries `isReasoning()`), P1.M5 (abort: `controller`/`buffer.freeze()`),
 * P1.M6 (RequestBuilder reads `buffer.snapshot()`), P1.M7 (splicing).
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  ApiStreamSimpleFunction,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../diagnostics";
// Re-exported by P1.M2.T1.S1 (single local vocabulary); same type as the pi-ai symbol.
import type { AssistantMessageEvent, TransitionState, ProxyPhase } from "../types";
import { isTerminalEvent, isThinkingEvent, isTextEvent, isToolCallEvent, isMalformedEvent } from "../types";
import type { TransitionCoordinator } from "../state/coordinator";
import { RequestBuilder } from "../request/builder";
// Reasoning detection collaborators (P1.M4.T2.S1: PRD §22 detection + §16 FSM + §13.4/§23 buffer).
import { TransitionController, ALLOWED_TRANSITIONS } from "../state/controller";
import { ReasoningBuffer } from "../buffer";
import { DEFAULT_CONFIG } from "../config";

/**
 * Transparent forward-only event pipeline: hides upstream provider requests behind exactly one
 * outbound {@link AssistantMessageEventStream} (PRD §13.2 / §20.1–§20.6).
 *
 * **Single-output invariant** (PRD §13.2 Guarantees): the proxy emits exactly one `start`,
 * exactly one terminal (`done` OR `error`), and completes `output.result()` exactly once.
 * No duplicate, missing, or reordered events — pure forwarding preserves upstream order.
 *
 * In the forward-only phase there is a single authoritative upstream (PRD §20.6); later phases
 * add reasoning detection (P1.M4), abort (P1.M5), and a second spliced upstream (P1.M7).
 */
export class StreamProxy {
  /** The single owned outbound stream Pi consumes (PRD §20.3/§20.5). */
  private readonly _output: AssistantMessageEventStream;
  private readonly diagnostics: Diagnostics;
  /** Per-request FSM (PRD §16). Forward-compat: P1.M4.T4/P1.M5 reach it via the proxy. */
  private readonly _controller: TransitionController;
  /** Per-request reasoning capture (PRD §13.4/§23). Forward-compat: P1.M5 (freeze) / P1.M6 (snapshot). */
  private readonly _buffer: ReasoningBuffer;

  /** The streamed model — retained so _emit can synthesize a clean error terminal on a malformed
   *  terminal event (FM-013). Only .id/.api/.provider are read (makeErrorAssistantMessage). */
  private readonly _model: Model<Api>;

  /**
   * Internal abort controller for the UPSTREAM stream ONLY (PRD §51 Abort Phase). Per-request, so the proxy
   * can abort the reasoning stream WITHOUT aborting Pi's overall request (whose signal is `options.signal`).
   * `triggerStop()` aborts this; `run()` passes `this._internalAbort.signal` to `upstreamStreamFn`. The
   * upstream's async iterator throws when aborted — `run()`'s catch treats that throw as the expected exit.
   */
  private readonly _internalAbort: AbortController = new AbortController();

  /**
   * Pending abort-timeout timer (FM-006/§43). Armed by `triggerStop()` when abort is dispatched; cleared when
   * `run()` observes the upstream exit (clean abort) or when it fires (→ `Failed`). `undefined` when idle.
   */
  private _abortTimer: ReturnType<typeof setTimeout> | undefined;

  /** Hard ceiling (ms) for the upstream to close after abort before the transition fails (PRD §43). Defaults
   *  to `DEFAULT_CONFIG.transitionTimeoutMs`; tests inject a small value to exercise FM-006 quickly. */
  private readonly _abortTimeoutMs: number;

  /**
   * Per-request RequestBuilder (PRD §31) — produces the thinking-disabled replacement triple (PRD §53).
   * Optional DI; production omits and the proxy self-creates `new RequestBuilder(diagnostics)`.
   */
  private readonly _requestBuilder: RequestBuilder;

  /**
   * Hard ceiling (ms) waiting for the replacement stream's FIRST event before the transition fails
   * (PRD §43 "Replacement startup timeout — Configurable"). Defaults to
   * `DEFAULT_CONFIG.replacementStartupTimeoutMs` (10000); tests inject a small value to fail fast.
   */
  private readonly _replacementStartupTimeoutMs: number;

  /**
   * Internal abort controller for the REPLACEMENT stream ONLY (PRD §51 Replacement Phase). FRESH per
   * replacement — the primary's `_internalAbort` is ALREADY aborted (used by `triggerStop`), so it CANNOT
   * be reused. Pi's external signal (`options.signal`) is fan-in'd into this so `ctrl+c` still aborts the
   * replacement. `undefined` until `_launchReplacement` creates it.
   */
  private _replacementAbort: AbortController | undefined;

  /** Pending replacement-startup-timeout timer (PRD §43). Armed by `_launchReplacement` before iterating;
   *  cleared on the first replacement event (clean) or when it fires (→ `Failed`). `undefined` when idle. */
  private _replacementStartupTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The StreamProxy's event-authority phase (PRD §18 / §20.6 / §21). `"forwarding"` while the primary is
   * authoritative; flips to `"splicing"` when the first replacement event is accepted (authority transfer —
   * irreversible per PRD §39/§51). Read by P1.M7.T2/T3.
   */
  /**
   * P1.M2.T1.S1 — the most-recent primary `event.partial` (the provider's live accumulating
   * `output` object). Set on every non-terminal primary event (last one wins, carrying the most-complete
   * content). Undefined when no primary partial was captured (placeholder mocks). Seed data for the
   * replacement rewrite (P1.M2.T2.S1).
   */
  private _primaryPartial: AssistantMessage | undefined;

  /**
   * P1.M2.T1.S1 — shallow-per-block clone of `_primaryPartial.content` at the abort/freeze boundary.
   * Each block is `{ ...b }` (plain data clone; NOT structuredClone). Empty when no primary partial was
   * captured. Seed data for the replacement rewrite (P1.M2.T2.S1).
   */
  private _frozenPrimaryContent: ReadonlyArray<Record<string, unknown>> = [];

  /**
   * P1.M2.T1.S1 — the number of primary content blocks at freeze time (= `_frozenPrimaryContent.length`).
   * Used by the replacement rewrite (P1.M2.T2.S1) to offset replacement contentIndex so text lands after
   * the prepended reasoning blocks.
   */
  private _contentIndexOffset = 0;

  private _authority: ProxyPhase = "forwarding";

  /**
   * FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): set `true` the moment the upstream emits its OWN terminal
   * (`done`/`error`) event AND it is forwarded into `output`. Lets `run()` distinguish a CLEAN abort
   * (upstream threw on abort, no terminal yet → proceed to Capturing) from a race the UPSTREAM WON
   * (it completed naturally despite/with an in-flight abort → natural completion wins; cancel the abort).
   * Checked FIRST in the catch and in the natural-exit path. Set in `run()`'s loop right after `push`.
   */
  private _upstreamCompleted = false;

  /**
   * INV-002 (Appendix O): exactly one downstream `start` is forwarded, regardless of how many upstream
   * streams are spliced. Set by {@link _emit} the first time it forwards a `start` (always the PRIMARY's
   * start, in the "forwarding" phase). The REPLACEMENT's `start` is suppressed (PRD §18 "Already emitted").
   * Routing flag (NOT lifecycle state — see PRD Appendix F: the "no boolean lifecycle flags" rule applies to
   * the FSM `TransitionState`, not internal routing counters; the proxy already uses `_upstreamCompleted`).
   */
  private _messageStartEmitted = false;

  /**
   * INV-003 (Appendix O): exactly one downstream terminal (`done`/`error`) is forwarded, regardless of how
   * many upstream streams are spliced. Set by {@link _emit} the first time it forwards a terminal. Any
   * subsequent terminal is discarded with a `proxy.splice.duplicate-terminal` trace (PRD FM-014 duplicate
   * completion / FM-015 terminal after authority transfer — identical handling: discard + log).
   *
   * NOTE: `EventStream.push` ALREADY no-ops once a terminal has set `done=true`, so dedup is correct even
   * without this flag; the flag exists ONLY to emit the FM-014/FM-015 diagnostic trace.
   */
  private _messageEndEmitted = false;

  /**
   * Optional session-scoped {@link TransitionCoordinator} whose active-proxy reference this proxy clears on
   * cleanup (PRD §44 "Transition token"). `undefined` in production until the decorator wiring passes the
   * session coordinator in; T3's cleanup path calls `this._coordinator?.setActiveProxy(undefined)` so the
   * no-coordinator case is a safe no-op. The proxy does NOT call `setActiveProxy(this)` on construct — that
   * is the decorator's responsibility.
   */
  private readonly _coordinator?: TransitionCoordinator;

  /**
   * INV-010 (Appendix O): terminal handling (FSM→Idle + resource release) runs EXACTLY ONCE regardless of
   * success, failure, timeout, or cancellation. Guarded by {@link _terminate}.
   */
  private _terminated = false;

  /**
   * States in which a transition is IN FLIGHT (past `Reasoning`, not yet terminal). `isInterrupting()` is
   * `true` here (PRD §24.3 / INV-004) — used by the coordinator/ShortcutManager to discard repeat presses.
   */
  private static readonly INTERRUPTING_STATES: ReadonlySet<TransitionState> = new Set<TransitionState>([
    "StopRequested", "Aborting", "Capturing", "Restarting", "Splicing", "Answering",
  ]);

  /**
   * Construct the proxy and immediately start forwarding.
   *
   * @param model            The model being streamed (api/provider/id used for diagnostics + the
   *                         synthesized-error AssistantMessage).
   * @param context          Conversation context (forwarded to upstreamStreamFn; never inspected/logged).
   * @param options          Stream options incl. reasoning level (forwarded to upstreamStreamFn).
   * @param upstreamStreamFn The captured built-in `streamSimple` (P1.M1.T4.S1) that yields the real
   *                         provider event stream. Typed {@link ApiStreamSimpleFunction}.
   * @param diagnostics      Structured logger. **Privacy (Appendix H):** only provider/model/api
   *                         metadata + error categories are ever logged — never context, options, or
   *                         event payloads.
   * @param controller        Optional DI: per-request FSM (PRD §16). Tests inject to inspect state;
   *                         production omits and the proxy self-creates a real instance.
   * @param buffer            Optional DI: per-request reasoning capture (PRD §13.4/§23). Tests inject
   *                         to inspect buffer; production omits and the proxy self-creates with the
   *                         default 8 MiB ceiling from `DEFAULT_CONFIG.maximumReasoningBufferBytes`.
   * @post `this.output` is a live `AssistantMessageEventStream`; the forwarding pipeline is running;
   *       `this.controller` and `this.buffer` are ready for detection.
   */
  constructor(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
    diagnostics: Diagnostics,
    controller?: TransitionController,
    buffer?: ReasoningBuffer,
    abortTimeoutMs: number = DEFAULT_CONFIG.transitionTimeoutMs,
    // NEW (P1.M7.T1.S1) — appended; production omits both:
    requestBuilder?: RequestBuilder,
    replacementStartupTimeoutMs: number = DEFAULT_CONFIG.replacementStartupTimeoutMs,
    coordinator?: TransitionCoordinator, // P1.M7.T3.S1 — optional session coordinator
  ) {
    this._model = model;
    this.diagnostics = diagnostics;
    this._output = createAssistantMessageEventStream();
    this._controller = controller ?? new TransitionController(diagnostics);
    this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);
    this._abortTimeoutMs = abortTimeoutMs;
    this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics);
    this._replacementStartupTimeoutMs = replacementStartupTimeoutMs;
    this._coordinator = coordinator;

    // Propagate Pi's abort (user escape / ctrl+c) into the INTERNAL controller so the upstream still stops on
    // escape, while keeping a SEPARATE controller the extension can abort via triggerStop() without touching
    // Pi's request. (One-way fan-in: external.aborted → internal.abort(); never the reverse.)
    const external = options?.signal;
    if (external) {
      if (external.aborted) this._internalAbort.abort();
      else external.addEventListener("abort", () => this._internalAbort.abort(), { once: true });
    }

    // Fire-and-forget: run() never rethrows (it converts any error into a single terminal event).
    void this.run(model, context, options, upstreamStreamFn);
  }

  /**
   * The single outbound stream downstream consumers (Pi) iterate. Read-only: there is no setter —
   * the queue is owned solely by this proxy (PRD §20.5 Queue Ownership). No upstream ever writes to
   * the downstream consumer directly.
   */
  get output(): AssistantMessageEventStream {
    return this._output;
  }

  /** The per-request FSM (PRD §16). Forward-compat: P1.M4.T4/P1.M5 reach it via the proxy. */
  get controller(): TransitionController {
    return this._controller;
  }

  /** The per-request reasoning capture (PRD §13.4/§23). Forward-compat: P1.M5 (freeze) / P1.M6 (snapshot). */
  get buffer(): ReasoningBuffer {
    return this._buffer;
  }

  /**
   * The StreamProxy's event-authority phase (PRD §18 / §20.6 / §21). `"forwarding"` until the first
   * replacement event is accepted; `"splicing"` thereafter (replacement authoritative). Read by P1.M7.T2/T3
   * to decide which stream's events to forward.
   */
  get authority(): ProxyPhase {
    return this._authority;
  }

  /**
   * P1.M2.T1.S1 — read-only snapshot of the primary stream's content blocks at the abort boundary.
   * Each block is a shallow clone of the original `event.partial.content` entry. Consumed by the
   * replacement rewrite (P1.M2.T2.S1) to prepend reasoning to the replacement answer.
   */
  get frozenPrimaryContent(): ReadonlyArray<Record<string, unknown>> {
    return this._frozenPrimaryContent;
  }

  /**
   * P1.M2.T1.S1 — the contentIndex offset (= number of frozen primary content blocks). Consumed by the
   * replacement rewrite (P1.M2.T2.S1) to offset replacement contentIndex so text lands after reasoning.
   */
  get contentIndexOffset(): number {
    return this._contentIndexOffset;
  }

  /** Whether reasoning is currently flowing (PRD §22.5). P1.M4.T4's coordinator delegates to this. */
  isReasoning(): boolean {
    return this._controller.getState() === "Reasoning";
  }

  /** Shortcut availability: `true` ONLY in `Reasoning` (PRD §22.5). Pure delegate to the FSM. */
  canInterrupt(): boolean {
    return this._controller.canInterrupt();
  }

  /** Stream started, reasoning not yet begun (PRD §16 `Delegating`). EC-002 pending-stop window.
   *  Pure delegate to the FSM. */
  isDelegating(): boolean {
    return this._controller.getState() === "Delegating";
  }

  /** A transition is in flight (PRD §24.3 / INV-004): state has left `Reasoning` but not reached terminal.
   *  Used by the coordinator/ShortcutManager to discard repeat presses (EC-009/EC-010). */
  isInterrupting(): boolean {
    return StreamProxy.INTERRUPTING_STATES.has(this._controller.getState());
  }

  /**
   * Dispatch the stop transition (PRD §51 Stop Request → Abort Phase). This method only DISPATCHES the abort;
   * it does NOT await the upstream exit. The Aborting→Capturing move + `buffer.freeze()` happen in `run()`'s
   * catch when the upstream iterator throws (asynchronously). See T1/T2 boundary in JSDoc/PRP.
   *
   * Steps: (a) gate on `canInterrupt()` (PRD §22.5); (b) `requestStop()` Reasoning→StopRequested; (c)
   * `beginAbort()` StopRequested→Aborting; (d) `_internalAbort.abort()` (upstream throws); arm the FM-006
   * timeout; (g) return `true`.
   *
   * @returns `true` if the abort was dispatched; `false` if not in `Reasoning` (no abort, no state change).
   */
  triggerStop(): boolean {
    if (!this._controller.canInterrupt()) return false; // (a) PRD §22.5 — not in Reasoning
    this._controller.requestStop();  // (b) Reasoning → StopRequested (PRD §16; legal after the gate)
    this._controller.beginAbort();   // (c) StopRequested → Aborting (PRD §16)
    this._internalAbort.abort();     // (d) upstream iterator throws an abort error (PRD §51 "Await Upstream Exit")
    this._startAbortTimeout();       // FM-006 safety net
    return true;                     // (g)
  }

  /** Arm the FM-006/§43 abort timeout. If the upstream ignores the abort and never closes within
   *  `_abortTimeoutMs`, fail the transition. */
  private _startAbortTimeout(): void {
    this._clearAbortTimeout();
    this._abortTimer = setTimeout(() => {
      // Only act if we are STILL aborting (a clean abort cleared this timer; a natural completion is T2).
      if (this._controller.getState() === "Aborting") {
        this.diagnostics.warn("proxy.abort.timeout", { timeoutMs: this._abortTimeoutMs });
        this._controller.fail("abort-timeout"); // Aborting → Failed (PRD §16 Any→Failed; never throws)
      }
    }, this._abortTimeoutMs);
  }

  /**
   * FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): cancel an in-flight abort because the upstream completed
   * naturally. PRD §16 has NO `Aborting → {Completed, Idle}` edge, so the only legal path back to a clean
   * `Idle` is `fail()` (Any→Failed, the FSM's escape hatch already used by FM-006 / upstream-error) then
   * `reset()` (Failed→Idle). Reason `"natural-completion-won"` classifies this as a BENIGN cancellation
   * (RC-001 winner resolution) for P1.M8 telemetry — NOT a true transition failure. Never throws.
   *
   * PRECONDITION: caller has verified `getState() === "Aborting"` and already cleared the FM-006 net.
   */
  private _cancelInFlightAbort(): void {
    this._controller.fail("natural-completion-won"); // Aborting → Failed (Any→Failed; always legal)
    this._controller.reset();                         // Failed → Idle
  }

  /** Cancel any pending abort timeout (clean-abort completion / unexpected throw / disposal). */
  private _clearAbortTimeout(): void {
    if (this._abortTimer !== undefined) {
      clearTimeout(this._abortTimer);
      this._abortTimer = undefined;
    }
  }

  /**
   * Transition to `target` ONLY if it is legal from the current state per PRD §16 (the exported
   * {@link ALLOWED_TRANSITIONS} map); otherwise a no-op. NEVER throws and NEVER triggers the
   * controller's `transition.illegal` warn — essential because the FSM has NO normal-completion exit
   * from `Reasoning` (§16 models the interruption lifecycle), so `done` on a normal stream would
   * otherwise be illegal.
   *
   * @returns whether the transition was taken.
   */
  private transitionIfLegal(target: TransitionState): boolean {
    const allowed = ALLOWED_TRANSITIONS.get(this._controller.getState());
    if (allowed && allowed.has(target)) {
      this._controller.transition(target); // pre-validated legal → cannot throw / cannot warn
      return true;
    }
    return false; // unreachable from current state → skip
  }

  /**
   * The SINGLE terminal handler (PRD §51 Completion + §44 Resource Management + Appendix O INV-010/INV-011).
   * Drives the FSM to `Idle` and releases every allocated per-request resource, EXACTLY ONCE (the
   * {@link _terminated} guard makes every duplicate call a structural no-op).
   *
   * FSM drive (PRD §16), via the no-throw {@link transitionIfLegal}:
   *   - success: `Splicing → Answering → Completed → Idle` (each step a no-op if already past it; on the
   *     NORMAL non-interrupted path the FSM sits in `Reasoning`, which has no §16 exit, so ALL THREE are
   *     no-ops → FSM correctly left in `Reasoning` with NO misleading `transition.failed`, yet resources
   *     are still released).
   *   - failure: `fail(reason)` (Any→Failed, skipped if already `Failed`) then `Failed → Idle`.
   *
   * Resource release (PRD §44): clear both timers, reset the reasoning buffer (wrapped in try/catch — §17
   * "cleanup must succeed even if telemetry fails"), release the replacement abort-controller reference,
   * and clear the coordinator's active-proxy reference.
   *
   * PRIVACY (Appendix H): the `proxy.lifecycle.cleanup` trace logs `{}` only — never content/reasoning.
   *
   * @param success `true` for a forwarded `done` terminal or a natural/race-won completion; `false` for
   *                any error/throw/timeout.
   * @param reason  an error CATEGORY (e.g. "replacement-error", "upstream-error") — never user content.
   */
  private _terminate(success: boolean, reason?: string): void {
    if (this._terminated) return; // INV-010 — exactly once
    this._terminated = true;

    if (success) {
      this.transitionIfLegal("Answering"); // Splicing→Answering (no-op if beginAnswering ran / no-op from Reasoning)
      this.transitionIfLegal("Completed"); // Answering→Completed
      this.transitionIfLegal("Idle");      // Completed→Idle
    } else {
      if (this._controller.getState() !== "Failed") {
        this._controller.fail(reason ?? "transition-failed"); // Any→Failed (never throws)
      }
      this.transitionIfLegal("Idle"); // Failed→Idle
    }

    // Resource release (PRD §44) — order-independent; each is total.
    this._clearAbortTimeout();         // release the FM-006 abort-timeout timer handle
    this._clearReplacementTimeout();   // release the replacement-startup-timeout timer handle
    // Buffer reset: only on the transition path (authority flipped to "splicing" — PRD §44 "Reasoning buffer").
    // On the normal non-interrupted path, the buffer preserves captured reasoning for inspection.
    if (this._authority === "splicing") {
      try {
        this._buffer.reset();             // destroy captured reasoning (PRD §44 "Reasoning buffer")
      } catch (err) {
        // §17 "Completed: cleanup must succeed even if telemetry fails" — never let a buffer fault escape.
        this.diagnostics.warn("proxy.cleanup.buffer-reset-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this._replacementAbort = undefined;          // release the replacement abort-controller reference (§44)
    this._coordinator?.setActiveProxy(undefined); // release the transition token / coordinator handle (§44)
    this.diagnostics.trace("proxy.lifecycle.cleanup", {}); // privacy-safe — {} only
  }

  /**
   * Per-event reasoning-detection side effect (PRD §22), invoked once per event in {@link run}
   * BEFORE the unchanged forward. Drives the FSM (§16) and the buffer (§13.4/§23). NEVER throws out
   * to {@link run}'s catch (which would synthesize a terminal and alter output — violating §19.7):
   * any fault is logged (event.type ONLY — Appendix H) and swallowed. The `event` is only READ,
   * never mutated.
   */
  private trackEvent(event: AssistantMessageEvent): void {
    try {
      // 1. Stream begins → Delegating (PRD §16 Idle→Delegating; guarded on Idle → enters once).
      if (event.type === "start" && this._controller.getState() === "Idle") {
        this.transitionIfLegal("Delegating");
      }
      // 2. Enter Reasoning on the FIRST thinking event (PRD §22.3: thinking_start OR first thinking_delta;
      //    §16 Delegating→Reasoning; guarded on Delegating → enters exactly once).
      if (
        (event.type === "thinking_start" || event.type === "thinking_delta") &&
        this._controller.getState() === "Delegating"
      ) {
        this.transitionIfLegal("Reasoning");
        // EC-002 (P1.M8.T2.S1): a stop pressed during the Delegating network-stall window is honored now.
        // consumePendingStop() is true at most once (it clears itself); triggerStop() is legal (state==Reasoning).
        if (this._coordinator?.consumePendingStop()) {
          this.diagnostics.trace("proxy.pending-stop.triggered", {});
          this.triggerStop();
        }
      }
      // 2b. EC-003/EC-004 (P1.M8.T2.S1): provider answers WITHOUT reasoning → discard any pending stop.
      if (isTextEvent(event) && this._controller.getState() === "Delegating") {
        this._coordinator?.clearPendingStop();
      }
      // 3. Accumulate reasoning deltas while Reasoning (PRD §13.4/§23.2).
      //    `event.type === "thinking_delta"` narrows the union → event.delta: string.
      //    (Order matters: step 2 may run first on the entering delta, flipping state to Reasoning,
      //    so step 3 then appends that same delta — correct per PRD §22.3.)
      if (event.type === "thinking_delta" && this._controller.getState() === "Reasoning") {
        this._buffer.append(event.delta);
      }
      // 4. Terminals (PRD §16). error → Any→Failed (fail never throws) → Failed→Idle.
      //    done → Completed→Idle ONLY when legal (the interrupted flow reaches Answering→Completed
      //    in P1.M5–P1.M7). In the NORMAL flow §16 defines no Reasoning→Completed exit, so done
      //    is a guarded no-op and the per-request controller is left in its legal state.
      if (event.type === "error") {
        this._controller.fail("upstream-error"); // Any→Failed, always legal, never throws
        this.transitionIfLegal("Idle");           // Failed→Idle (reset)
      } else if (event.type === "done") {
        if (this.transitionIfLegal("Completed")) { // legal only from Answering (interrupted flow)
          this.transitionIfLegal("Idle");           // Completed→Idle (reset)
        }
      }
      // NOTE (PRD §22.4 "leave reasoning on thinking_end / first answer token"): §16 defines no
      // normal Reasoning exit, so thinking_end / text_start / toolcall_start perform NO transition here.
      // Reasoning detection remains Reasoning-true until the stream terminates. Acceptable in
      // P1.M4 (no shortcut/coordinator wired); reconciled when the interruption flow
      // (Reasoning→StopRequested, P1.M5) is the active path.
    } catch (err) {
      // Tracking MUST NEVER break forwarding (observational equivalence — ADR-005/§19.7).
      // Log the fault (event.type ONLY — never content, Appendix H) and swallow;
      // run()'s push still executes.
      this.diagnostics.warn("proxy.tracking-error", {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Performs FM-013 malformed-event validation and FM-015 stray-discard at the top (before authority
   * branching); then the §18 filtering. Both guards apply uniformly to primary + replacement events.
   *
   * The unified downstream forwarding filter (PRD §18 Event Forwarding Rules / §39 Transition Event Rules).
   * Both {@link run}'s primary loop and {@link _launchReplacement}'s replacement loop (plus its catch's
   * synthesized terminal) forward through HERE, so the single-`start` (INV-002) and single-terminal (INV-003)
   * invariants hold across the spliced primary+replacement streams.
   *
   * Branches on {@link _authority} (the contract's `authority === 'primary'/'replacement'`, modeled as
   * `ProxyPhase`: `"forwarding"` == primary, `"splicing"` == replacement):
   *
   * PRIMARY (`"forwarding"`, PRD §18 "Before Stop"): forward EVERY event unchanged; on `start` set
   *   {@link _messageStartEmitted}; on a terminal set {@link _messageEndEmitted} (a duplicate terminal here is
   *   discarded with a trace — defensive, INV-003).
   *
   * REPLACEMENT (`"splicing"`, PRD §18 "After Restart"):
   *   - `start`            → SUPPRESS (already emitted — PRD §18); trace `proxy.splice.start-suppressed`.
   *   - `thinking_*`       → FORWARD (EC-017: replacement returned reasoning anyway; no recursive interruption).
   *   - `done`/`error`     → forward ONCE (set {@link _messageEndEmitted}); a duplicate/after-transfer terminal
   *                          is discarded with `proxy.splice.duplicate-terminal` (PRD FM-014 / FM-015).
   *   - `text_*`/`toolcall_*` → forward.
   *
   * COMPLETION: forwarding a terminal via `this._output.push(event)` ALREADY completes `output` and resolves
   * `output.result()` with `event.message` (done) / `event.error` (error) — see `EventStream` semantics. So NO
   * explicit `output.end()` is made (consistent with the primary path; the existing JSDoc forbids it as
   * "unnecessary and contrary to the exits-naturally contract"). The contract's "output.end(result)" is the
   * guarantee `push(terminal)` fulfills.
   *
   * This method NEVER calls {@link trackEvent} (trackEvent runs only in the primary loop, before `_emit`; the
   * reasoning buffer is FROZEN during the replacement phase). It never mutates/reorders/duplicates an event.
   *
   * PRIVACY (Appendix H): `proxy.splice.*` traces log `{}` only — never content/options/reasoning/prompt.
   */
  private _emit(event: AssistantMessageEvent): void {
    // FM-013 / PRD §52 Validation Rules — detect malformed recognized-type events. Unknown-type events
    // are NOT malformed (isMalformedEvent returns false) and pass through unchanged (§52 "Unknown events").
    if (isMalformedEvent(event)) {
      this.diagnostics.warn("proxy.event.malformed", { type: event.type }); // privacy — type ONLY (Appendix H)
      if (isTerminalEvent(event)) {
        // A malformed TERMINAL (done w/o message / error w/o error) cannot carry a valid completion →
        // downstream integrity at risk. Synthesize ONE clean error terminal (preserves single-terminal /
        // single-result invariants) and fail the transition (PRD §54 L4 / §52 "terminate only if downstream
        // integrity cannot be preserved"). _terminate is idempotent → safe if a terminal was already pushed.
        if (!this._messageEndEmitted) {
          this._messageEndEmitted = true;
          this._output.push({
            type: "error",
            reason: "error",
            error: this.makeErrorAssistantMessage(this._model, "malformed terminal event"),
          });
        }
        this._terminate(false, "malformed-terminal");
        return;
      }
      // Malformed NON-terminal (e.g. *_delta missing delta) → forward best-effort (fall through).
    }

    // FM-015 / PRD §39 "Forbidden: emit upstream completion after replacement begins": after the single
    // terminal was forwarded, any further NON-terminal event is a stray from the post-transfer stream.
    // Discard with a trace. (Terminal strays are deduped per-phase below with proxy.splice.duplicate-terminal;
    // this guard is gated on !isTerminalEvent so it never shadows that trace.)
    if (this._messageEndEmitted && !isTerminalEvent(event)) {
      this.diagnostics.trace("proxy.splice.discard-after-completion", {}); // privacy — {} only (Appendix H)
      return;
    }

    if (this._authority === "forwarding") {
      // PRIMARY phase (PRD §18 "Before Stop") — forward all, track the start/terminal flags.
      if (event.type === "start") {
        this._messageStartEmitted = true; // the primary's start is THE downstream start (INV-002)
      }
      if (isTerminalEvent(event)) {
        if (this._messageEndEmitted) {
          this.diagnostics.trace("proxy.splice.duplicate-terminal", {}); // defensive dedup (INV-003)
          return;
        }
        this._messageEndEmitted = true; // push(terminal) below completes output + resolves result()
        this._output.push(event);
        return;
      }
      this._output.push(event); // forward unchanged
      return;
    }

    // REPLACEMENT phase (_authority === "splicing") — PRD §18 "After Restart" / §39.
    if (event.type === "start") {
      // Already emitted by the primary (INV-002) — suppress the replacement's duplicate start.
      this.diagnostics.trace("proxy.splice.start-suppressed", {});
      return;
    }
    if (isThinkingEvent(event)) {
      // EC-017 (P1.M8.T2.S1): the thinking-disabled replacement returned reasoning anyway. PRD mandates FORWARD
      // it (single transition per response; recursive interruption out of scope). No recursion is possible:
      // replacement events reach _emit only — they NEVER run trackEvent, so the FSM is not driven; triggerStop()
      // is additionally gated on canInterrupt() which is false once the first transition left Reasoning.
      this.diagnostics.trace("proxy.splice.reasoning-forwarded", {});
      // fall through to push(event) below
    }
    if (isTerminalEvent(event)) {
      if (this._messageEndEmitted) {
        // FM-014 (duplicate completion) / FM-015 (terminal after authority transfer) — discard + trace.
        this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
        return;
      }
      this._messageEndEmitted = true; // the replacement's terminal is THE downstream terminal (INV-003)
    }
    // text_start/delta/end + toolcall_* (and the first terminal) → forward.
    this._output.push(event);
  }

  /**
   * Forward every event from the single authoritative upstream into {@link output}, unchanged.
   * Before each forward, runs {@link trackEvent} to drive reasoning detection (PRD §22) as a
   * pure side effect — detection never mutates, drops, reorders, or duplicates an event.
   *
   * PATTERN (pure forwarding): `for await (const event of upstream) this._output.push(event)`.
   * When the upstream emits its terminal `done`/`error` event, that `push` completes `output`
   * (sets `done` + resolves `result()` in the same call — see EventStream semantics), and the loop
   * exits naturally on the upstream iterator's next `next()`. **No `output.end()` call is made** —
   * it is unnecessary and contrary to the "exits naturally" contract.
   *
   * SAFETY NET: if this method throws before a terminal is pushed, exactly one synthesized `error`
   * terminal is pushed so `output.result()` never hangs (single-terminal/single-result invariant).
   * `push` is a no-op once the stream is complete, so this catch is transparent in the normal path.
   *
   * @returns never rejects (the catch converts any error into a terminal event or, failing that,
   *          logs + swallows so the constructor's fire-and-forget never surfaces an unhandled rejection).
   */
  private async run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
  ): Promise<void> {
    try {
      // Inject the INTERNAL signal (NOT options.signal) so triggerStop() can abort reasoning without
      // aborting Pi's overall request. options.signal was already fan-in'd into _internalAbort in the ctor.
      const upstream = upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal });
      for await (const event of upstream) {
        this.trackEvent(event);   // side-effect reasoning detection; never throws; never mutates event
        this._emit(event);        // §18 filtering: forwarding phase → forward all; set INV-002/INV-003 flags
        // P1.M2.T1.S1 — capture the provider's live accumulating partial (last non-terminal wins).
        // Narrow with !isTerminalEvent FIRST: done/error members lack .partial → tsc error if bare.
        if (!isTerminalEvent(event) && event.partial) {
          this._primaryPartial = event.partial;
        }
        // FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): the upstream emitted its OWN terminal. If an abort is in
        // flight but the upstream completed naturally, this flag lets natural completion win (see below).
        if (isTerminalEvent(event)) {
          this._upstreamCompleted = true;
        }
      }
      // Natural loop exit. FM-005/EC-007: if the upstream completed naturally WHILE an abort was in flight
      // (triggerStop set Aborting, but the upstream emitted its terminal instead of throwing), natural
      // completion wins — cancel the in-flight abort: clear the FM-006 net + reset the FSM to Idle. Gated on
      // getState()==="Aborting" so a NORMAL completion (state is Reasoning/Idle) is untouched and does NOT emit
      // the race trace. (For an `error` terminal that already reset the FSM to Idle via trackEvent, this gate is
      // false → harmless; its FM-006 net, if any, no-ops on fire since the timeout also checks Aborting.)
      if (this._upstreamCompleted && this._controller.getState() === "Aborting") {
        this._clearAbortTimeout();
        this._cancelInFlightAbort();
        this.diagnostics.trace("proxy.abort.natural-completion-won", {});
      }
      // P1.M7.T3.S1 — release resources on every natural completion (normal OR race-won)
      this._terminate(true);
    } catch (err) {
      // FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): if the upstream already emitted its terminal BEFORE the abort
      // error was thrown, NATURAL COMPLETION WINS. The terminal was already forwarded above; do NOT take the
      // abort path (no Capturing/freeze) and do NOT synthesize a second terminal (push is idempotent anyway).
      if (this._upstreamCompleted) {
        this._clearAbortTimeout();
        if (this._controller.getState() === "Aborting") {
          this._cancelInFlightAbort();
        }
        this.diagnostics.trace("proxy.abort.natural-completion-won", {});
        this._terminate(true); // P1.M7.T3.S1 — release resources
        return; // the original terminal was already forwarded; output is complete
      }
      // EXPECTED ABORT (PRD §51 Abort Phase): triggerStop() set Aborting + aborted _internalAbort; the
      // upstream iterator threw an abort error. This is the graceful "upstream exit" — complete the transition
      // and freeze reasoning. Do NOT synthesize a terminal: the replacement stream (P1.M6/P1.M7) owns the
      // downstream terminal, so output must stay OPEN while the transition is in flight.
      if (this._controller.getState() === "Aborting") {
        this._clearAbortTimeout(); // clean abort — cancel the FM-006 safety net
        try {
          this._controller.completeAbort(); // Aborting → Capturing (PRD §16)
        } catch (e) {
          // Should not happen (state is Aborting), but never let completion break the catch.
          this.diagnostics.warn("proxy.abort.complete-abort-failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        this._buffer.freeze(); // (PRD §41: reasoning immutable once frozen; §40: replacement needs this)
        // P1.M2.T1.S1 — snapshot the primary's structured content blocks (shallow-per-block clone).
        // When _primaryPartial is undefined (placeholder mocks), frozen content is [] and offset is 0.
        this._frozenPrimaryContent = (this._primaryPartial?.content ?? []).map((b) => ({ ...b }));
        this._contentIndexOffset = this._frozenPrimaryContent.length;
        this.diagnostics.trace("proxy.abort.completed", {});
        // PRD §40: primary aborted + reasoning frozen → launch the thinking-disabled replacement and drive the
        // FSM through Restarting → Splicing (PRD §16/§51). output stays OPEN; the replacement owns the terminal.
        await this._launchReplacement(model, context, options, upstreamStreamFn);
        return;
      }
      // UNEXPECTED throw (network/provider error, or an abort-timeout-then-throw) → synthesize ONE terminal
      // so output.result() never hangs (single-terminal/single-result invariant). (Existing behavior.)
      const message = err instanceof Error ? err.message : String(err);
      this._clearAbortTimeout();
      this.diagnostics.warn("proxy.forward.upstream-threw", {
        provider: String(model.provider),
        model: model.id,
        error: message,
      });
      // push() no-ops if already complete → safe whether or not a terminal was already forwarded.
      this._output.push({
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, message),
      });
      this._terminate(false, "upstream-error"); // P1.M7.T3.S1 — fail→Idle + release resources (§17 reset before exit)
    }
  }

  /**
   * Launch the thinking-disabled replacement stream and drive the FSM through Restarting → Splicing
   * (PRD §16 / §40 / §51 Replacement Phase + Authority Transfer). Invoked from `run()`'s clean-abort branch
   * AFTER `completeAbort()` + `freeze()` (state is `Capturing`).
   *
   * Steps (work-item contract): (a) build the replacement triple via RequestBuilder; (b) `beginReplacement()`
   * → `Restarting`; (c) create a FRESH `_replacementAbort` + fan-in Pi's external signal; (d) invoke the SAME
   * captured provider `streamSimple` with `{ ...triple.options, signal }` (reasoning === undefined disables
   * z.ai thinking); arm the startup timeout; (e) iterate; (f) on the FIRST event → `beginSplice()` →
   * `Splicing` + clear the timeout; (g) flip authority to `"splicing"` (irreversible — PRD §39/§51).
   *
   * BASELINE FORWARDING: replacement events are pushed into `output` unchanged. The primary pushed NO
   * terminal (output left open by the abort path), so the replacement's events are the single forward path
   * and its `done` becomes the single terminal (single-start/single-terminal/single-result invariants hold).
   * P1.M7.T2 adds the filtering/suppression RULES (EC-017 stray reasoning, primary-terminal suppression);
   * P1.M7.T3 adds the full Splicing→Answering→Completed lifecycle. Replacement events do NOT run
   * `trackEvent` (the buffer is FROZEN and replacement processing is T2/T3's job).
   *
   * SAFETY NET: if the replacement throws (startup-timeout abort, provider error) and no terminal was
   * forwarded, exactly ONE synthesized `error` terminal is pushed so `output.result()` never hangs (push is
   * idempotent once complete → transparent in the normal path).
   *
   * @returns never rejects (the catch converts any error into a terminal event or logs + swallows).
   */
  private async _launchReplacement(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    originalStreamFn: ApiStreamSimpleFunction,
  ): Promise<void> {
    try {
      // (a) Build the thinking-disabled replacement triple (PRD §25/§31/§53). `options` is the ORIGINAL
      //     request options (reasoning level intact); buildReplacement spreads + forces reasoning: undefined.
      const triple = this._requestBuilder.buildReplacement(model, context, options, this._buffer.snapshot());

      // (b) Capturing → Restarting (PRD §16). Legal: we are in Capturing (just completeAbort()'d).
      this._controller.beginReplacement();

      // (c) FRESH abort controller for the replacement (the primary's _internalAbort is ALREADY aborted).
      this._replacementAbort = new AbortController();
      // Fan-in Pi's external signal so ctrl+c still aborts the replacement (mirrors the ctor fan-in).
      const external = options?.signal;
      if (external) {
        if (external.aborted) this._replacementAbort.abort();
        else external.addEventListener("abort", () => this._replacementAbort!.abort(), { once: true });
      }

      // (d) Invoke the SAME captured provider streamSimple (PRD §51). triple.options.reasoning === undefined
      //     disables z.ai thinking; we inject the replacement signal (preserving every other option field).
      const replacementStream = originalStreamFn(triple.model, triple.context, {
        ...triple.options,
        signal: this._replacementAbort.signal,
      });

      // (h) Arm the replacement-startup timeout (PRD §43). Cleared on the first accepted event.
      this._startReplacementTimeout();

      let firstSeen = false;
      // (e) Begin iterating the replacement stream.
      for await (const event of replacementStream) {
        if (!firstSeen) {
          firstSeen = true;
          this._clearReplacementTimeout(); // first replacement event accepted → cancel the startup timeout
          // (f) Restarting → Splicing (PRD §16). Legal: we are in Restarting (just beginReplacement()'d).
          this._controller.beginSplice();
          // (g) Authority transfer — irreversible (PRD §39/§51). "splicing" == replacement authoritative.
          this._authority = "splicing";
          this.diagnostics.trace("proxy.replacement.first-event", {}); // privacy-safe — {} only (Appendix H)
        }
        // §18 filtering: replacement start suppressed (already emitted); thinking_* skipped; text_*/toolcall_*
        // forwarded; first terminal forwarded (+ completes output), duplicates discarded (FM-014/FM-015).
        this._emit(event);

        // P1.M7.T3.S1 — completion FSM (PRD §16/§51), AFTER the forward (T2's flip-before-_emit ordering preserved).
        // (1) First answer token → Splicing→Answering (streaming FSM accuracy; a no-op once past Splicing).
        if (
          this._controller.getState() === "Splicing" &&
          (isTextEvent(event) || isToolCallEvent(event))
        ) {
          this._controller.beginAnswering(); // Splicing → Answering (PRD §16; legal here)
        }
        // (2) The forwarded terminal completes the transition. _emit forwards the FIRST terminal and dedups
        //     the rest; _terminate is idempotent, so a duplicate/stray terminal is a safe no-op (INV-010).
        if (isTerminalEvent(event)) {
          if (event.type === "done") {
            this._terminate(true); // Splicing/Answering → Completed → Idle + cleanup
          } else {
            // error terminal from the replacement → fail→Idle + cleanup (terminal already forwarded).
            this._terminate(false, "replacement-error");
          }
        }
      }
      // P1.M7.T3.S1 — EC-018 (empty/clean-return-without-terminal): the replacement ended without emitting a
      // terminal. output would hang; synthesize ONE error terminal so output.result() resolves (single-terminal
      // invariant), then tear down. If a terminal WAS forwarded, _terminate already ran inside the loop and the
      // _terminated guard makes this a no-op.
      if (!this._messageEndEmitted) {
        this._emit({
          type: "error",
          reason: "error",
          error: this.makeErrorAssistantMessage(model, "replacement stream ended without a terminal"),
        });
        this._terminate(false, "replacement-empty");
      }
    } catch (err) {
      // Replacement threw (startup-timeout abort, provider error, or an upstream throw). Synthesize ONE
      // error terminal so output.result() never hangs (single-terminal invariant), unless one was already
      // forwarded (push is idempotent once complete).
      this._clearReplacementTimeout();
      const message = err instanceof Error ? err.message : String(err);
      // CLASSIFY (gotcha): the startup-timeout handler ALREADY moved us to Failed + aborted _replacementAbort
      // (→ this throw) and logged `proxy.replacement.startup-timeout`. By the time the blocked iterator throws,
      // getState() is "Failed" — so a `getState() === "Restarting"` check would be a DEAD branch and would
      // DOUBLE-WARN. Therefore: SKIP the classify-warn on the timeout path (state already Failed); a throw
      // while NOT yet Failed is a GENUINE replacement failure → classify + log it. Synthesize the terminal in
      // BOTH cases so output.result() never hangs (single-terminal invariant).
      if (this._controller.getState() !== "Failed") {
        this.diagnostics.warn("proxy.replacement.failed", { error: message });
      }
      this._emit({
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, message),
      });
      this._terminate(false, "replacement-failed"); // P1.M7.T3.S1 — fail→Idle (skipped if already Failed) + cleanup
    }
  }

  /**
   * Arm the replacement-startup timeout (PRD §43). If the replacement emits NO first event within
   * `_replacementStartupTimeoutMs`, fail the transition and abort the replacement (which unblocks the
   * blocked iterator → `_launchReplacement`'s catch synthesizes a terminal). Mirrors `_startAbortTimeout`.
   */
  private _startReplacementTimeout(): void {
    this._clearReplacementTimeout();
    this._replacementStartupTimer = setTimeout(() => {
      // Only act if we are STILL Restarting (a first event cleared this timer and moved us to Splicing).
      if (this._controller.getState() === "Restarting") {
        this.diagnostics.warn("proxy.replacement.startup-timeout", { timeoutMs: this._replacementStartupTimeoutMs });
        this._controller.fail("replacement-startup-timeout"); // Restarting → Failed (Any→Failed; never throws)
        this._replacementAbort?.abort(); // unblock the blocked iterator so the loop exits
      }
    }, this._replacementStartupTimeoutMs);
  }

  /** Cancel any pending replacement-startup timeout (first event accepted / throw / disposal). */
  private _clearReplacementTimeout(): void {
    if (this._replacementStartupTimer !== undefined) {
      clearTimeout(this._replacementStartupTimer);
      this._replacementStartupTimer = undefined;
    }
  }

  private makeErrorAssistantMessage(model: Model<Api>, message: string): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    };
  }
}
