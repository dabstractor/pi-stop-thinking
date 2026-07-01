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
import type { AssistantMessageEvent, TransitionState } from "../types";
import { isTerminalEvent } from "../types";
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
   * FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): set `true` the moment the upstream emits its OWN terminal
   * (`done`/`error`) event AND it is forwarded into `output`. Lets `run()` distinguish a CLEAN abort
   * (upstream threw on abort, no terminal yet → proceed to Capturing) from a race the UPSTREAM WON
   * (it completed naturally despite/with an in-flight abort → natural completion wins; cancel the abort).
   * Checked FIRST in the catch and in the natural-exit path. Set in `run()`'s loop right after `push`.
   */
  private _upstreamCompleted = false;

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
  ) {
    this.diagnostics = diagnostics;
    this._output = createAssistantMessageEventStream();
    this._controller = controller ?? new TransitionController(diagnostics);
    this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);
    this._abortTimeoutMs = abortTimeoutMs;

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

  /** Whether reasoning is currently flowing (PRD §22.5). P1.M4.T4's coordinator delegates to this. */
  isReasoning(): boolean {
    return this._controller.getState() === "Reasoning";
  }

  /** Shortcut availability: `true` ONLY in `Reasoning` (PRD §22.5). Pure delegate to the FSM. */
  canInterrupt(): boolean {
    return this._controller.canInterrupt();
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
        this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
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
        this.diagnostics.trace("proxy.abort.completed", {});
        return; // leave output OPEN — replacement stream (P1.M6/P1.M7) owns the terminal
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
    }
  }

  /**
   * Build the minimal valid {@link AssistantMessage} carried by the synthesized terminal `error`
   * event when `run` catches a thrown upstream. Content/usage are zeroed; stopReason is `"error"`;
   * `errorMessage` carries the thrown message. Only used on the defensive path (never in normal flow).
   */
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
