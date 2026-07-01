/**
 * # Realistic Two-Phase Mock Provider
 *
 * Faithful mini-provider that reproduces the `@earendil-works/pi-ai`
 * `openai-completions` provider's per-call **output accumulation** behavior:
 *   - ONE live `output` object per call (`output.content` mutated in place).
 *   - `contentIndex` derived via `output.content.indexOf(block)` (never invented).
 *   - Every non-terminal event stamped `partial: output` (the live reference).
 *   - Terminal `done` stamped `message: output` (same live reference).
 *
 * Builds a **primary** call (reasoning ON → thinking block at content[0]) and a
 * **replacement** call (reasoning OFF → fresh output, text block at content[0]).
 * Both phases use `contentIndex: 0` — the exact collision that causes Issue 1
 * when a verbatim-forwarding proxy switches the consumer's `partialMessage`.
 *
 * Primary iterator throws `new Error("aborted")` on AbortSignal abort (mirrors
 * the existing `makeScriptedTwoPhaseUpstream`), which is the trigger for the
 * proxy's abort→freeze→replacement path.
 *
 * **Consumed by**:
 *   - P1.M2.T1.S1: capture test (frozen primary content blocks).
 *   - P1.M2.T3.S1: Issue 1 end-to-end integration test.
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";

// ─── Types ────────────────────────────────────────────────────────────

export interface RealisticTwoPhaseMock {
  /** The mock provider fn — drop-in for an ApiStreamSimpleFunction (cast). */
  fn: ApiStreamSimpleFunction;
  /** Per-call recorded options (calls[1] = replacement; assert .options.reasoning === undefined). */
  calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[];
  /** Push a primary event spec (mock owns contentIndex + partial). */
  pushPrimary: (spec: MockEventSpec) => void;
  /** Push a replacement event spec (mock owns contentIndex + partial). */
  pushReplacement: (spec: MockEventSpec) => void;
  /** End the primary iterator cleanly (no-abort path). */
  closePrimary: () => void;
  /** The live primary accumulating output (driven by pushPrimary). */
  primaryOutput: AssistantMessage;
  /** The live replacement accumulating output — FRESH (never includes primary thinking). */
  replacementOutput: AssistantMessage;
}

/** Minimal event spec the caller pushes; the mock derives contentIndex + partial from the live output. */
export type MockEventSpec =
  | { type: "start" }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "text_start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end" }
  | { type: "done" }
  | { type: "error"; reason?: string };

// ─── Internal helpers ──────────────────────────────────────────────────

/** Provider-shaped AssistantMessage factory (content:[] live array; full Usage). */
const makeOutput = (): AssistantMessage =>
  ({
    role: "assistant",
    content: [], // ← mutated IN PLACE (never reassigned)
    api: "openai-completions",
    provider: "zai",
    model: "glm-4.7",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }) as AssistantMessage;

interface BlockRefs {
  thinking: { type: "thinking"; thinking: string } | null;
  text: { type: "text"; text: string } | null;
}

/**
 * Mutate the LIVE `output.content` in place per the provider's ensure*Block + delta-append
 * mechanics, and return a fully-formed AssistantMessageEvent. This is the ONLY place
 * contentIndex is derived (output.content.indexOf(block)) and partial/message is stamped —
 * mirroring openai-completions.js.
 */
function applySpec(
  output: AssistantMessage,
  spec: MockEventSpec,
  refs: BlockRefs,
): AssistantMessageEvent {
  const blocks = output.content; // same array reference, mutated in place
  const idx = (b: { type: string }) => blocks.indexOf(b as never);

  switch (spec.type) {
    case "start":
      return { type: "start", partial: output };
    case "thinking_start": {
      const block: { type: "thinking"; thinking: string } = { type: "thinking", thinking: "" };
      blocks.push(block as never);
      refs.thinking = block;
      return {
        type: "thinking_start",
        contentIndex: idx(block),
        partial: output,
      };
    }
    case "thinking_delta": {
      const block = refs.thinking!;
      block.thinking += spec.delta; // accumulate (live mutation)
      return {
        type: "thinking_delta",
        contentIndex: idx(block),
        delta: spec.delta,
        partial: output,
      };
    }
    case "thinking_end": {
      const block = refs.thinking!;
      return {
        type: "thinking_end",
        contentIndex: idx(block),
        content: block.thinking,
        partial: output,
      };
    }
    case "text_start": {
      const block: { type: "text"; text: string } = { type: "text", text: "" };
      blocks.push(block as never);
      refs.text = block;
      return {
        type: "text_start",
        contentIndex: idx(block),
        partial: output,
      };
    }
    case "text_delta": {
      const block = refs.text!;
      block.text += spec.delta; // accumulate (live mutation)
      return {
        type: "text_delta",
        contentIndex: idx(block),
        delta: spec.delta,
        partial: output,
      };
    }
    case "text_end": {
      const block = refs.text!;
      return {
        type: "text_end",
        contentIndex: idx(block),
        content: block.text,
        partial: output,
      };
    }
    case "done":
      return { type: "done" as const, reason: output.stopReason as AssistantMessageEvent & { type: "done" } extends { reason: infer R } ? R : never, message: output };
    case "error":
      output.stopReason = "error";
      return {
        type: "error" as const,
        reason: (spec.reason ?? "error") as AssistantMessageEvent & { type: "error" } extends { reason: infer R } ? R : string,
        error: output,
      };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function makeRealisticTwoPhaseMock(
  _opts?: Record<string, unknown>,
): RealisticTwoPhaseMock {
  const primaryOutput = makeOutput(); // live; driven by pushPrimary
  const replacementOutput = makeOutput(); // FRESH live; driven by pushReplacement

  const primaryRefs: BlockRefs = { thinking: null, text: null };
  const replacementRefs: BlockRefs = { thinking: null, text: null };

  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];

  const calls: RealisticTwoPhaseMock["calls"] = [];
  let callCount = 0;
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  let primaryClosed = false;

  // Iterator control-flow mirrors makeScriptedTwoPhaseUpstream:
  // drain queue → check closed → check aborted → await 0ms with abort listener
  // `waitHolder.resolve` is an escape hatch so closePrimary() can wake a blocked iterator.
  const makeIterator = (
    queue: AssistantMessageEvent[],
    signal: AbortSignal | undefined,
    closed: () => boolean,
    waitHolder: { resolve: () => void },
  ) => ({
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          const event = queue.shift()!;
          yield event;
          // After yielding a terminal (done/error), return — the stream is complete.
          if (event.type === "done" || event.type === "error") return;
          continue;
        }
        if (closed()) return;
        if (signal?.aborted) throw new Error("aborted");
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 0);
          waitHolder.resolve = resolve;
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }
    },
  });

  const primaryWaitHolder = { resolve: () => {} };
  const replacementWaitHolder = { resolve: () => {} };

  const fn = (
    (_m: unknown, _c: unknown, streamOpts?: { signal?: AbortSignal; reasoning?: unknown }) => {
      callCount++;
      calls.push({ options: streamOpts });

      if (callCount === 1) {
        // PRIMARY — reasoning ON, throws on abort
        primarySignal = streamOpts?.signal;
        return makeIterator(
          primaryQueue,
          primarySignal,
          () => primaryClosed,
          primaryWaitHolder,
        );
      }

      // REPLACEMENT — fresh output already created at factory time
      replacementSignal = streamOpts?.signal;
      return makeIterator(
        replacementQueue,
        replacementSignal,
        () => false,
        replacementWaitHolder,
      );
    }
  ) as unknown as ApiStreamSimpleFunction;

  return {
    fn,
    calls,
    pushPrimary: (spec) =>
      primaryQueue.push(applySpec(primaryOutput, spec, primaryRefs)),
    pushReplacement: (spec) =>
      replacementQueue.push(
        applySpec(replacementOutput, spec, replacementRefs),
      ),
    closePrimary: () => {
      primaryClosed = true;
      primaryWaitHolder.resolve(); // wake the iterator if blocked on await
    },
    primaryOutput,
    replacementOutput,
  };
}
