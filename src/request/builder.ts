/**
 * # RequestBuilder — construct the thinking-disabled replacement provider request (PRD §31 / §53 / §25).
 *
 * **Responsibility** (PRD §31): "Construct replacement provider request." This module is the single producer of the
 * PRD §53 Replacement Request: a pure transform of the interrupted request's `(model, context, options)` into a triple
 * that continues the SAME logical interaction with reasoning turned OFF.
 *
 * **Ownership**: NONE beyond its inputs/outputs. Owns NO stream, NO abort controller, NO buffer, NO network. The method
 * constructs one fresh options object and returns the triple; it holds no state across calls.
 *
 * **Purity** (PRD §31 + work-item contract "pure, no side effects, no network"): the transformation is deterministic and
 * side-effect-free — it performs NO network call, mutates NONE of its arguments, and is referentially transparent (same
 * inputs ⇒ structurally equal output). The only observable "effect" is a single fire-and-forget `debug` diagnostics
 * milestone, which by the {@link Diagnostics} contract "never modifies runtime behavior" — so behaviorally the method
 * remains pure. (Mirrors `ReasoningBuffer`, an otherwise-pure collection that still emits lifecycle diagnostics.)
 *
 * **Transformation** (PRD §25.6 / §53 "Modify: thinking configuration"):
 *  - Preserve: conversation/context, user prompt, assistant history, model, sampling parameters, provider, session
 *    identity (PRD §25.3/§25.4/§25.7/§53 "Preserve").
 *  - Modify: `options.reasoning → undefined` (the ONE field touched).
 *  - Omit (MVP): the optional ephemeral execution directive (PRD §53 "Ephemeral Execution Directive" / §25.5). The
 *    `reasoningSnapshot` parameter is accepted for API completeness and forward-compat but is NOT read in MVP.
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
} from "@earendil-works/pi-ai";
import type { ThinkingEntry } from "../buffer";
import type { Diagnostics } from "../diagnostics";

/**
 * The output of {@link RequestBuilder.buildReplacement}: the thinking-disabled replacement provider request triple
 * (PRD §53 Outputs / §31 Outputs "Replacement request"). A ready-to-invoke bundle passed straight to
 * `original.streamSimple(model, context, options)` by the splicing pipeline (P1.M7.T1).
 *
 * - `model`    The SAME `Model<Api>` reference as the input (PRD §25.7 model preserved — no copy, no switching).
 * - `context`  The SAME `Context` reference as the input (PRD §25.3 context reuse / §25.4 prompt reuse — never rewritten).
 * - `options`  A FRESH `SimpleStreamOptions` object = `{ ...originalOptions, reasoning: undefined }`: every original
 *              field preserved verbatim (apiKey, temperature, maxTokens, sessionId, headers, signal, …) with the single
 *              exception that `reasoning` is forced to `undefined` to disable thinking (PRD §25.6). Plain (unfrozen) so
 *              the consumer (P1.M7) may spread/override it (e.g. inject a fresh abort signal) before invoking the stream.
 */
export interface ReplacementRequest {
  /** Same reference as the input model (PRD §25.7). */
  readonly model: Model<Api>;
  /** Same reference as the input context (PRD §25.3/§25.4). */
  readonly context: Context;
  /** Fresh options object: all original fields preserved, `reasoning` forced to `undefined` (PRD §25.6). */
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
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Build the thinking-disabled replacement request triple (PRD §25 / §31 / §53).
   *
   * Pure transform: returns `{ model, context, options }` where
   *   - `model` and `context` are the **same references** as the inputs (PRD §25.3/§25.4/§25.7 — no rewrite, no copy);
   *   - `options` is a fresh object = `{ ...options, reasoning: undefined }` — every original field preserved verbatim
   *     with `reasoning` forced to `undefined` (disables thinking per PRD §25.6 / the z.ai `enable_thinking` mechanism).
   *
   * The `reasoningSnapshot` (the frozen `ReasoningBuffer.snapshot()` from the aborted reasoning phase) is accepted for
   * the optional ephemeral execution directive (PRD §53 "Ephemeral Execution Directive" / §25.5) and forward-compat;
   * it is **NOT read in MVP** (the directive is omitted by default).
   *
   * - Preconditions: `model`, `context`, `options` are the values from the interrupted request; `reasoningSnapshot` is
   *   the frozen snapshot (`ReasoningBuffer.snapshot()`, post-`freeze()`). `options` may or may not carry `reasoning`.
   * - Postconditions: returns a {@link ReplacementRequest} with same-ref `model`/`context` and a fresh `options` whose
   *   `reasoning === undefined`; the input `options` object is NOT mutated; NO network/stream is touched.
   * - Side effects: one `debug("request.replacement-built", {})` lifecycle milestone (privacy-safe — `{}` only).
   * - @throws never (object construction + a fire-and-forget log; total function).
   *
   * @param model             The interrupted request's model (PRD §25.7 — preserved).
   * @param context           The interrupted request's conversation context (PRD §25.3/§25.4 — preserved).
   * @param options           The interrupted request's stream options (all fields preserved; `reasoning` → `undefined`).
   * @param reasoningSnapshot Frozen reasoning snapshot (PRD §53). Reserved for the optional ephemeral directive; unused
   *                          in MVP.
   * @returns The thinking-disabled replacement request triple (PRD §53 Outputs).
   */
  buildReplacement(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    // Reserved for the optional ephemeral execution directive (PRD §53/§25.5); NOT read in MVP.
    // tsconfig has no `noUnusedParameters`, so the documented-but-unused param compiles cleanly.
    reasoningSnapshot: readonly ThinkingEntry[],
  ): ReplacementRequest {
    // PURE TRANSFORM (PRD §25.6 / §53 "Modify: thinking configuration"): preserve every original field, force
    // reasoning OFF. `{ ...options, reasoning: undefined }` overrides any original level ("high"/"medium"/…) with
    // undefined, which makes the z.ai provider set enable_thinking=false (see module JSDoc). model + context are the
    // SAME references (PRD §25.3/§25.4/§25.7). options is left UNFROZEN so P1.M7 may override its signal before invoking.
    const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
    this.diagnostics.debug("request.replacement-built", {}); // lifecycle milestone; privacy-safe — {} only
    return { model, context, options: replacementOptions };
  }
}
