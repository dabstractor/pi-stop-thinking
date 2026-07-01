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
 * **Ownership**: one outbound `AssistantMessageEventStream` (created in the constructor). Owns NO
 * transition state, NO reasoning buffer, NO abort controller in this phase.
 *
 * **Lifecycle**: constructed per request on the z.ai reasoning path (P1.M2.T3.S1). The constructor
 * starts the pipeline (`run`) fire-and-forget; the pipeline completes when the upstream's terminal
 * event is forwarded. No explicit dispose — the streams garbage-collect once drained.
 *
 * **Invariants** (PRD §13.2 Guarantees):
 *  - Exactly **one** `message_start` (`start`) reaches the downstream consumer (the upstream emits
 *    exactly one; it is forwarded unchanged).
 *  - Exactly **one** terminal `message_end` (`done` OR `error`) reaches the consumer.
 *  - Exactly **one** completed result — `output.result()` resolves exactly once, to the
 *    `AssistantMessage` carried by the (single) terminal event.
 *  - No duplicate, missing, or reordered events (pure forwarding preserves order).
 *  - The downstream consumer never interacts with an upstream stream directly (PRD §20.5).
 *
 * **Failure modes**: in the normal path the upstream emits its own terminal `done`/`error` event,
 * which is forwarded and completes the stream. If `run` throws *before* a terminal is pushed (e.g.
 * `upstreamStreamFn` throws synchronously, or the upstream iterator throws), a single synthesized
 * `error` terminal is pushed so the downstream never hangs and the single-terminal/single-result
 * invariants still hold. (Network/provider failures surface as `error` *events* from the upstream and
 * are forwarded normally — the synthesis path is a defensive guard for the degenerate throw case;
 * formal failure-mode handling is P1.M8.T2.)
 *
 * Consumed by: P1.M2.T3.S1 (decorator wiring), P1.M4 (reasoning detection), P1.M5 (abort),
 * P1.M7 (splicing).
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
import type { AssistantMessageEvent } from "../types";

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
   * @post `this.output` is a live `AssistantMessageEventStream`; the forwarding pipeline is running.
   */
  constructor(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
    diagnostics: Diagnostics,
  ) {
    this.diagnostics = diagnostics;
    this._output = createAssistantMessageEventStream();
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

  /**
   * Forward every event from the single authoritative upstream into {@link output}, unchanged.
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
        this._output.push(event);
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
