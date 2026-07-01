/**
 * # Realistic Two-Phase Mock — companion unit test.
 *
 * Scripts a primary thinking stream + replacement text stream and asserts:
 *   - Live accumulation (partial === same output object on every non-terminal event)
 *   - contentIndex derived via indexOf (both phases at index 0 — the collision)
 *   - done.message === replacementOutput (live ref)
 *   - calls[1].options.reasoning === undefined
 *   - Primary throws new Error("aborted") on AbortSignal abort
 *   - Issue 1 reproducibility via consumeLikeAgentLoop (text-only final message)
 */

import { test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { makeRealisticTwoPhaseMock } from "./realistic-mock";
import { consumeLikeAgentLoop } from "./consumer-harness";

const modelStub = {
  id: "glm-4.7",
  api: "openai-completions",
  provider: "zai",
} as never;
const ctxStub = { messages: [] } as never;

const drain = async (
  it: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> => {
  const out: AssistantMessageEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

test("makeRealisticTwoPhaseMock accumulates a live output per call and stamps partial/contentIndex like the provider", async () => {
  const mock = makeRealisticTwoPhaseMock();
  const primaryAc = new AbortController();

  // ── PRIMARY (reasoning ON): start → thinking_start → 2× delta → thinking_end ──
  const upstream1 = mock.fn(modelStub, ctxStub, {
    signal: primaryAc.signal,
    reasoning: "high",
  });
  mock.pushPrimary({ type: "start" });
  mock.pushPrimary({ type: "thinking_start" });
  mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
  mock.pushPrimary({ type: "thinking_delta", delta: " me" });
  mock.pushPrimary({ type: "thinking_end" });
  mock.closePrimary(); // no-abort path → iterator returns cleanly
  const primaryEvents = await drain(upstream1);

  // Live accumulation: every non-terminal partial === the SAME primaryOutput object (live ref)
  for (const e of primaryEvents) {
    if (e.type !== "done" && e.type !== "error") {
      expect(e.partial).toBe(mock.primaryOutput);
    }
  }
  expect(mock.primaryOutput.content).toHaveLength(1);
  expect(mock.primaryOutput.content[0]).toMatchObject({
    type: "thinking",
    thinking: "Let me",
  });

  // contentIndex derived via indexOf → 0 for the single thinking block
  const thinkings = primaryEvents.filter((e) =>
    e.type.startsWith("thinking"),
  );
  for (const e of thinkings) {
    expect((e as { contentIndex: number }).contentIndex).toBe(0);
  }

  // ── REPLACEMENT (reasoning OFF): start → text_start → 2× delta → done ──
  const replAc = new AbortController();
  const upstream2 = mock.fn(modelStub, ctxStub, { signal: replAc.signal });
  expect(mock.calls[1].options?.reasoning).toBeUndefined(); // proxy forced reasoning === undefined

  mock.pushReplacement({ type: "start" });
  mock.pushReplacement({ type: "text_start" });
  mock.pushReplacement({ type: "text_delta", delta: "Here" });
  mock.pushReplacement({ type: "text_delta", delta: " is the answer." });
  mock.pushReplacement({ type: "done" });
  const replEvents = await drain(upstream2);

  // FRESH output — distinct object, text-only, NEVER contains the primary's thinking
  expect(mock.replacementOutput).not.toBe(mock.primaryOutput);
  expect(mock.replacementOutput.content).toHaveLength(1);
  expect(mock.replacementOutput.content[0]).toMatchObject({
    type: "text",
    text: "Here is the answer.",
  });

  // Every replacement event carries contentIndex 0 (the collision) and the live partial
  for (const e of replEvents) {
    if (e.type === "done") {
      expect(e.message).toBe(mock.replacementOutput);
      expect(e.reason).toBe("stop");
    } else if (e.type !== "start") {
      expect((e as { contentIndex: number }).contentIndex).toBe(0);
      expect((e as { partial: unknown }).partial).toBe(mock.replacementOutput);
    } else {
      // start event: has partial but no contentIndex
      expect((e as { partial: unknown }).partial).toBe(mock.replacementOutput);
    }
  }
});

test("makeRealisticTwoPhaseMock reproduces the contentIndex-0 collision a real consumer observes (Issue 1)", async () => {
  const mock = makeRealisticTwoPhaseMock();

  // ── PRIMARY: reasoning ON → thinking at content[0] ──
  const u1 = mock.fn(modelStub, ctxStub, {
    signal: new AbortController().signal,
    reasoning: "high",
  });
  mock.pushPrimary({ type: "start" });
  mock.pushPrimary({ type: "thinking_start" });
  mock.pushPrimary({ type: "thinking_delta", delta: "reasoning" });
  mock.pushPrimary({ type: "thinking_end" });
 mock.closePrimary(); // end primary cleanly (no abort path for this collision test)
  const primaryEvents = await drain(u1);

  // ── REPLACEMENT: reasoning OFF → text at content[0] of a FRESH output ──
  const u2 = mock.fn(modelStub, ctxStub, {
    signal: new AbortController().signal,
  });
  mock.pushReplacement({ type: "start" });
  mock.pushReplacement({ type: "text_start" });
  mock.pushReplacement({ type: "text_delta", delta: "answer" });
  mock.pushReplacement({ type: "done" });
  const replEvents = await drain(u2);

  // Concatenate the two phases exactly as a verbatim-forwarding proxy would emit,
  // then run the REAL consumer. Pre-fix: the replacement's fresh partial replaces
  // the primary's reasoning → text-only (Issue 1 reproduced).
  const stream = createAssistantMessageEventStream();
  for (const e of [...primaryEvents, ...replEvents]) {
    (stream as unknown as { push: (e: unknown) => void }).push(e);
  }
  const { finalMessage } = await consumeLikeAgentLoop(stream);
  expect(finalMessage.content.map((b) => b.type)).toEqual(["text"]); // ← Issue 1 reproduced
});

test("makeRealisticTwoPhaseMock primary throws on AbortSignal abort (mirrors the existing mock)", async () => {
  const mock = makeRealisticTwoPhaseMock();
  const ac = new AbortController();
  const u1 = mock.fn(modelStub, ctxStub, {
    signal: ac.signal,
    reasoning: "high",
  });
  mock.pushPrimary({ type: "start" });
  mock.pushPrimary({ type: "thinking_start" });
  mock.pushPrimary({ type: "thinking_delta", delta: "x" });

  // Drain queued events first, then abort
  let first = true;
  try {
    for await (const _e of u1) {
      if (first) {
        first = false;
        // All 3 queued events are now drained; abort now
        ac.abort();
      }
    }
    // Iterator returned without throwing — fail
    expect.unreachable("expected iterator to throw on abort");
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("aborted");
  }
});
