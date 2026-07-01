/**
 * # Consumer Integration Test — Issue 1 end-to-end regression guard (P1.M2.T3.S1).
 *
 * Drives the REAL StreamProxy through the realistic two-call mock provider and consumes proxy.output with
 * consumeLikeAgentLoop — a faithful copy of pi-agent-core's agent-loop.js consumer
 * (`partialMessage = event.partial` on every non-terminal event; `finalMessage = response.result()` =
 * the done event's `message`). Asserts the Issue-1 fix end-to-end: an interrupted reasoning stream
 * PERSISTS as [thinking, text] (full reasoning preserved) with NO streaming flicker, and is
 * observationally equivalent to a normal (uninterrupted) response (Story 3 / G4 / ADR-005).
 *
 * REGRESSION GUARD: this test FAILS before the P1.M2.T2.S1+S2 fix. Pre-fix the proxy forwarded
 * replacement events verbatim → the replacement's fresh text-only `partial` replaced the primary reasoning
 * on every event (finalMessage.content = [text] only) and the streaming view led with a text block
 * (flicker). Both are asserted-against here.
 */

import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { consumeLikeAgentLoop } from "./helpers/consumer-harness";
import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";

/** Build the proxy over a fresh realistic mock (close to the production assembly path). */
function buildRealisticProxy() {
  const { diag, events } = makeCaptureDiag();
  const controller = new TransitionController(diag);
  const buffer = new ReasoningBuffer(diag, 1_000_000);
  const mock = makeRealisticTwoPhaseMock();
  const proxy = new StreamProxy(
    makeModel(),
    {} as never,
    { reasoning: "high" } as never, // original request has reasoning enabled
    mock.fn,
    diag,
    controller,
    buffer,
    DEFAULT_CONFIG.transitionTimeoutMs, // abort timeout — generous
    undefined,                           // requestBuilder — default
    2000,                                // replacementStartupTimeoutMs — generous
  );
  return { proxy, diag, events, controller, buffer, mock };
}

const PRIMARY_REASONING = ["Let", " me", " think"]; // 3 deltas → "Let me think"
const REPLACEMENT_ANSWER = "Here is the answer.";

describe("Consumer integration — Issue 1 end-to-end (P1.M2.T3.S1)", () => {
  test("interrupted reasoning PERSISTS as [thinking, text] through the real consumer (regression guard)", async () => {
    const { proxy, events, mock } = buildRealisticProxy();

    // (b) PRIMARY reasoning stream: start → thinking_start[0] → 3× thinking_delta[0] → thinking_end[0].
    //     (Mock derives contentIndex=0 + stamps the live accumulating partial — exactly like the provider.)
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    for (const d of PRIMARY_REASONING) mock.pushPrimary({ type: "thinking_delta", delta: d });
    mock.pushPrimary({ type: "thinking_end" });

    // (c) wait until the proxy has entered Reasoning (run() processed the thinking events → offset will be 1).
    await waitFor(() => proxy.isReasoning());

    // (d) trigger the stop mid-reasoning → abort → freeze → snapshot → launch replacement.
    expect(proxy.triggerStop()).toBe(true);
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot done

    // (3) the replacement call was invoked with reasoning === undefined (mock records every call).
    //     calls[0] = primary (reasoning: "high"); calls[1] = replacement (reasoning forced undefined).
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].options?.reasoning).toBeUndefined(); // PRD §25.6 — thinking disabled

    // (e) REPLACEMENT (reasoning OFF): start (proxy-SUPPRESSED, INV-002) → text_start → text_delta → done.
    mock.pushReplacement({ type: "start" });
    mock.pushReplacement({ type: "text_start" });
    mock.pushReplacement({ type: "text_delta", delta: REPLACEMENT_ANSWER });
    mock.pushReplacement({ type: "done" });

    // (f) consume proxy.output through the FAITHFUL agent-loop consumer.
    const result = await consumeLikeAgentLoop(proxy.output);

    // (g) PERSISTENCE (the persisted message = response.result() = the rewritten done.message):
    //     [thinking, text] with the FULL primary reasoning preserved (was [text] only, pre-fix).
    expect(result.finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(result.finalMessage.content).toHaveLength(2);
    expect(result.finalMessage.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Let me think", // ← FULL primary reasoning preserved (lost pre-fix)
    });
    expect(result.finalMessage.content[1]).toMatchObject({
      type: "text",
      text: REPLACEMENT_ANSWER,
    });

    // (h) NO FLICKER / RESTART ARTIFACT (G4). The streaming partial view (partialMessage = event.partial)
    //     must NEVER lead with a text block — pre-fix the replacement's fresh [text] partial replaced the
    //     reasoning on every event (content[0] === 'text'). Two-part assertion (robust to the empty
    //     content:[] of the primary `start` partial):
    //       (1) NO partial ever leads with text;
    //       (2) every post-splice partial (one carrying a text block) leads with the frozen reasoning.
    for (const partial of result.partialHistory) {
      expect(partial.content[0]?.type).not.toBe("text");
    }
    const postSplice = result.partialHistory.filter((p) =>
      p.content.some((b) => b.type === "text"),
    );
    expect(postSplice.length).toBeGreaterThan(0); // the rewritten text_start/text_delta partials
    for (const partial of postSplice) {
      expect(partial.content[0]?.type).toBe("thinking");
    }
  });

  test("NEGATIVE CONTROL: an uninterrupted stream through the same mock yields the SAME [thinking, text] structure (observational equivalence — Story 3 / G4)", async () => {
    const { proxy, mock } = buildRealisticProxy();

    // A NORMAL z.ai reasoning→answer response (NO stop): start → thinking_* → text_* → done, all in PRIMARY.
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    for (const d of PRIMARY_REASONING) mock.pushPrimary({ type: "thinking_delta", delta: d });
    mock.pushPrimary({ type: "thinking_end" });
    mock.pushPrimary({ type: "text_start" });
    mock.pushPrimary({ type: "text_delta", delta: REPLACEMENT_ANSWER });
    mock.pushPrimary({ type: "text_end" });
    mock.pushPrimary({ type: "done" });

    // Consume through the SAME faithful consumer.
    const result = await consumeLikeAgentLoop(proxy.output);

    // The uninterrupted response has the SAME [thinking, text] structure as the interrupted one
    // (Story 3 "appear identical to a normal assistant response"; G4 "single continuous assistant response").
    expect(result.finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(result.finalMessage.content).toHaveLength(2);
    expect(result.finalMessage.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Let me think",
    });
    expect(result.finalMessage.content[1]).toMatchObject({
      type: "text",
      text: REPLACEMENT_ANSWER,
    });
  });
});
