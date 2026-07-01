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
  ) {
    this.diagnostics = diagnostics;
    this._output = createAssistantMessageEventStream();
    this._controller = controller ?? new TransitionController(diagnostics);
    this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);
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
      const upstream = upstreamStreamFn(model, context, options);
      for await (const event of upstream) {
        this.trackEvent(event);   // side-effect reasoning detection; never throws; never mutates event
        this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
      }
      // Natural exit — terminal already pushed; nothing more to do.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
