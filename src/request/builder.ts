/**
 * # RequestBuilder — construct the thinking-disabled replacement provider request (PRD §31 / §53 / §25).
 *
 * **Responsibility** (PRD §31): "Construct replacement provider request." This module is the single producer of the
 * PRD §53 Replacement Request: a non-mutating transform of the interrupted request's `(model, context, options)` into a
 * triple that continues the SAME logical interaction with reasoning turned OFF, optionally augmented with an ephemeral
 * execution directive containing the prior reasoning snapshot (PRD §53 / ADR-006).
 *
 * **Ownership**: NONE beyond its inputs/outputs. Owns NO stream, NO abort controller, NO buffer, NO network. The method
 * constructs fresh context and options objects (when injecting) and returns the triple; it holds no state across calls.
 *
 * **Purity** (PRD §31 + work-item contract "pure, no side effects, no network"): the transformation is non-mutating
 * and side-effect-free — it performs NO network call, mutates NONE of its arguments, and is referentially transparent
 * MODULO the directive message's `timestamp: Date.now()` (the one wall-clock-dependent element, present only when
 * injection is active). The only observable "effect" is a single fire-and-forget `debug` diagnostics milestone, which by
 * the {@link Diagnostics} contract "never modifies runtime behavior" — so behaviorally the method remains a non-mutating
 * transform. (Mirrors `ReasoningBuffer`, an otherwise-pure collection that still emits lifecycle diagnostics.)
 *
 * **Transformation** (PRD §25.6 / §53 "Modify: thinking configuration"):
 *  - Preserve: conversation/context, user prompt, assistant history, model, sampling parameters, provider, session
 *    identity (PRD §25.3/§25.4/§25.7/§53 "Preserve").
 *  - Modify: `options.reasoning → undefined` (INV-014 — reasoning OFF for exactly this one request, via a fresh
 *    options object; original untouched).
 *  - Directive construction from the snapshot (PRD §53 / ADR-006): when the gate passes
 *    (`reasoningInjection && rendered.length > 0`), the frozen reasoning snapshot is rendered to text via
 *    {@link renderReasoningText}, wrapped in the configured delimiter fence, and injected as a clearly-delimited
 *    ephemeral `UserMessage` appended to a FRESH copy of the conversation {@link Context}. The directive is read-only
 *    reference context — the non-continuation framing (PRD §26 / §53 h3.72) instructs the model NOT to resume or extend
 *    the reasoning chain.
 *  - Gated fallback (ADR-005 / INV-008): when injection is disabled OR the snapshot is empty, the directive is omitted
 *    and the SAME `Context` reference is returned unchanged (observational equivalence — `triple.context === context`).
 *  - Two distinct uses of one snapshot: (1) INPUT injection (here — ephemeral `UserMessage` in the replacement
 *    request); (2) OUTPUT stitching (in the StreamProxy — the snapshot is stitched into the persisted assistant
 *    message for display). The snapshot is never persisted into conversation history via injection.
 *  - maxTokens best-effort bound (PRD §25.6 h2.97 + Appendix P.3 h2.236): when the caller omits `maxTokens`,
 *    `DEFAULT_REPLACEMENT_MAX_TOKENS` (16384) is applied as a safety bound. z.ai does NOT reliably enforce
 *    `maxTokens`; completion relies on the stream's terminal event. A caller-supplied value is preserved verbatim.
 *  - Do NOT modify: user intent, conversation ordering, visible history (PRD §53 "Do not modify").
 *
 * **How reasoning is disabled for z.ai** (PRD §25.6; confirmed in
 * `@earendil-works/pi-ai/dist/providers/openai-completions.js`): the provider derives
 * `reasoningEffort = options?.reasoning ? clampThinkingLevel(...) : undefined`, then sets
 * `params.enable_thinking = !!reasoningEffort`. With `options.reasoning === undefined`, `reasoningEffort` is `undefined`,
 * so `enable_thinking = !!undefined === false` → reasoning DISABLED. Setting `reasoning: undefined` (NOT `"off"`) is the
 * minimal, unconditionally-safe knob: `undefined` short-circuits BEFORE `clampThinkingLevel` runs.
 *
 * **Non-responsibilities** (PRD §31): Network, Streaming, Retries.
 *
 * Consumed by: P1.M7.T1 (StreamProxy invokes the replacement via `original.streamSimple(triple.model,
 * triple.context, triple.options)`; P1.M7 owns the replacement's abort signal — it overrides `options.signal` at
 * invocation time, NOT here).
 */
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ThinkingEntry } from "../buffer";
import type { Diagnostics } from "../diagnostics";
import { DEFAULT_CONFIG } from "../config";

/**
 * The output of {@link RequestBuilder.buildReplacement}: the thinking-disabled replacement provider request triple
 * (PRD §53 Outputs / §31 Outputs "Replacement request"). A ready-to-invoke bundle passed straight to
 * `original.streamSimple(model, context, options)` by the splicing pipeline (P1.M7.T1).
 *
 * - `model`    The SAME `Model<Api>` reference as the input (PRD §25.7 model preserved — no copy, no switching).
 * - `context`  SAME reference when injection is omitted (ADR-005 / INV-008); FRESH augmented copy when injection is
 *              active (PRD §53 h3.73). Original context is never mutated.
 * - `options`  A FRESH `SimpleStreamOptions` object = `{ ...originalOptions, reasoning: undefined }` (INV-014): every
 *              original field preserved verbatim (apiKey, temperature, maxTokens, sessionId, headers, signal, …) with
 *              `reasoning` forced to `undefined` to disable thinking (PRD §25.6). Plain (unfrozen) so the consumer
 *              (P1.M7) may spread/override it (e.g. inject a fresh abort signal) before invoking the stream.
 */
/**
 * Best-effort maxTokens bound for the replacement request (PRD §25.6 h2.97 + Appendix P.3 h2.236).
 * z.ai does NOT reliably enforce maxTokens; completion relies on the stream's terminal event.
 */
const DEFAULT_REPLACEMENT_MAX_TOKENS = 16384;

export interface ReplacementRequest {
  /** Same reference as the input model (PRD §25.7). */
  readonly model: Model<Api>;
  /** When injection is omitted (disabled or empty snapshot): SAME reference as the input context (ADR-005 / INV-008).
   *  When injection is active: a FRESH augmented copy with the directive `UserMessage` appended. */
  readonly context: Context;
  /** Fresh options object: all original fields preserved, `reasoning` forced to `undefined` (INV-014 / PRD §25.6). */
  readonly options: SimpleStreamOptions;
}

/**
 * Render the frozen reasoning snapshot to plain text (PRD §53 h3.70 "What is injected").
 *
 * Concatenates each entry's `content` verbatim, in offset/append order (the snapshot from
 * {@link ReasoningBuffer.snapshot} is already offset-ordered). The result is the RAW reasoning
 * text — no deltas, offsets, timestamps, or provider event envelopes are included; only the
 * rendered text (PRD §53 h3.70).
 *
 * **Pure / opaque-buffer guarantee** (PRD §13.4 h2.41 — "The extension does not interpret
 * reasoning"): this function does NOT summarize, compress, truncate, reformat, or filter
 * content. It performs no side effects, no diagnostics, no I/O; it is referentially transparent
 * and deterministic (same snapshot ⇒ identical string). An empty snapshot yields `""`, which the
 * {@link RequestBuilder.buildReplacement} gate uses to omit the directive (PRD §53 h3.70).
 *
 * @param entries The frozen reasoning snapshot (already offset-ordered).
 * @returns The concatenated reasoning text; `""` for an empty snapshot.
 */
export function renderReasoningText(entries: readonly ThinkingEntry[]): string {
  return entries.map((entry) => entry.content).join("");
}

/**
 * Pure constructor of the thinking-disabled replacement provider request (PRD §31 / §53 / §25).
 */
export class RequestBuilder {
  /**
   * @param diagnostics Shared structured logger (PRD §36). **Privacy (Appendix H):** only the lifecycle event name is
   *                    ever logged — never prompt/context/options/reasoning content. The single milestone emits `{}`.
   * @param _reasoningInjection Whether the ephemeral execution directive is enabled (PRD §53 / ADR-006).
   *                             Defaults to {@link DEFAULT_CONFIG.reasoningInjection} (`true`). When `false`, the
   *                             snapshot is ignored and the directive is omitted.
   * @param _delimiter The open/close fence text wrapping the injected reasoning block (PRD §53 h3.71 / Appendix K).
   *                   Defaults to {@link DEFAULT_CONFIG.reasoningInjectionDelimiter}.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly _reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
    private readonly _delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
  ) {}

  /**
   * Build the thinking-disabled replacement request triple (PRD §25 / §31 / §53).
   *
   * Non-mutating transform: returns `{ model, context, options }` where
   *   - `model` is the **same reference** as the input (PRD §25.7 — no copy, no switching).
   *   - `context` is the SAME reference when injection is omitted (ADR-005 / INV-008 observational equivalence), or
   *     a FRESH augmented copy with the directive `UserMessage` appended when injection is active.
   *   - `options` is ALWAYS a fresh object = `{ ...options, reasoning: undefined }` (INV-014) — every original field
   *     preserved verbatim with `reasoning` forced to `undefined` (disables thinking per PRD §25.6). A best-effort
   *     `maxTokens` default is applied when the caller omits it (PRD §25.6 h2.97 + Appendix P.3 h2.236).
   *
   * **Reasoning reuse (PRD §53 / ADR-006 / INV-013):** the frozen `reasoningSnapshot` is now READ — rendered to
   * text via {@link renderReasoningText}, gated on `this._reasoningInjection && rendered.length > 0` (PRD §53 h3.70).
   * When the gate passes, a clearly-delimited ephemeral `UserMessage` is constructed (PRD §53 h3.71/h3.72) with
   * non-continuation positioning — the directive is read-only reference context, never a continuation prompt.
   * The directive is injected into a FRESH copy of the conversation context (PRD §53 h3.73); the original context
   * and its messages array are never mutated. When the gate fails (injection disabled OR empty snapshot), the
   * original `context` reference is returned unchanged.
   *
   * `reasoningSnapshot` is a REQUIRED input — without it the directive is omitted and replacement quality degrades
   * to a from-scratch answer (PRD §31 h2.120).
   *
   * - Preconditions: `model`, `context`, `options` are the values from the interrupted request; `reasoningSnapshot` is
   *   the frozen snapshot (`ReasoningBuffer.snapshot()`, post-`freeze()`). `options` may or may not carry `reasoning`.
   * - Postconditions: returns a {@link ReplacementRequest} with same-ref `model`, same-or-fresh `context`, and a fresh
   *   `options` whose `reasoning === undefined`; the input `context` and `options` objects are NEVER mutated;
   *   NO network/stream is touched. Context identity (`triple.context === context`) holds iff the gate fails.
   * - Side effects: one `debug("request.replacement-built", {})` lifecycle milestone (privacy-safe — `{}` only).
   * - @throws never (object construction + a fire-and-forget log; total function).
   *
   * @param model             The interrupted request's model (PRD §25.7 — preserved).
   * @param context           The interrupted request's conversation context (PRD §25.3/§25.4).
   * @param options           The interrupted request's stream options (all fields preserved; `reasoning` → `undefined`).
   * @param reasoningSnapshot Frozen reasoning snapshot (PRD §53 / INV-013). Rendered, gated, and (when the gate
   *                          passes) injected as an ephemeral directive `UserMessage`.
   * @returns The thinking-disabled replacement request triple (PRD §53 Outputs).
   */
  buildReplacement(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    reasoningSnapshot: readonly ThinkingEntry[],
  ): ReplacementRequest {
    // Render the frozen reasoning snapshot to plain text (PRD §53 h3.70).
    const rendered = renderReasoningText(reasoningSnapshot);
    const shouldInject = this._reasoningInjection && rendered.length > 0; // §53 h3.70 gate

    let replacementContext: Context;
    if (shouldInject) {
      // §53 h3.71 delimiter + h3.72 non-continuation positioning. Bare-string content satisfies UserMessage.
      const directiveMessage: UserMessage = {
        role: "user",
        content:
          `${this._delimiter.open}\n${rendered}\n${this._delimiter.close}\n\n` +
          `Using the prior reasoning above as reference context only, produce your best available ` +
          `answer to the user's request now. Do not continue or extend reasoning.`,
        timestamp: Date.now(),
      };
      // §53 h3.73 ephemeral/scoping — FRESH context copy + NEW messages array (original untouched).
      replacementContext = { ...context, messages: [...(context.messages ?? []), directiveMessage] };
    } else {
      replacementContext = context; // gated fallback — SAME ref (ADR-005 / INV-008)
    }

    // INV-014 (§25.6 h2.97): reasoning OFF for exactly this one request via a FRESH options object.
    const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
    // Best-effort maxTokens bound (§25.6 h2.97 + Appendix P.3 h2.236); preserve caller value if set.
    if (replacementOptions.maxTokens === undefined) {
      replacementOptions.maxTokens = DEFAULT_REPLACEMENT_MAX_TOKENS;
    }

    this.diagnostics.debug("request.replacement-built", {}); // privacy-safe — {} only (Appendix H h2.203)
    return { model, context: replacementContext, options: replacementOptions };
  }
}
