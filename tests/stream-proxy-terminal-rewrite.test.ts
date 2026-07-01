import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { consumeLikeAgentLoop } from "./helpers/consumer-harness";
import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";

describe("StreamProxy — replacement terminal rewrite (P1.M2.T2.S2)", () => {
  test("done.message is merged so result() persists [thinking, text] (the Issue-1 persistence fix)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeRealisticTwoPhaseMock();

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15, // orphan-safe replacement startup timeout
    );

    // PRIMARY (reasoning ON) → primaryOutput.content grows to [{thinking:'Let me'}].
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
    mock.pushPrimary({ type: "thinking_delta", delta: " me" });
    await waitFor(() => proxy.isReasoning()); // run() processed the thinking events → offset will be 1

    expect(proxy.triggerStop()).toBe(true); // abort → freeze → snapshot (offset now 1)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot done

    // REPLACEMENT (reasoning OFF) → done.message = replacementOutput (content = [{text:'Here answer'}]).
    mock.pushReplacement({ type: "text_start" });
    mock.pushReplacement({ type: "text_delta", delta: "Here" });
    mock.pushReplacement({ type: "text_delta", delta: " answer" });
    mock.pushReplacement({ type: "text_end" });
    mock.pushReplacement({ type: "done" });

    // Consume through the FAITHFUL consumer — finalMessage = stream.result() = the rewritten done.message.
    const result = await consumeLikeAgentLoop(proxy.output);

    // PERSISTENCE FIX: the persisted message has BOTH reasoning and answer (was text-only before T2.S2).
    expect(result.finalMessage.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text"]);
    expect(result.finalMessage.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" }); // primary reasoning preserved
    expect(result.finalMessage.content[1]).toMatchObject({ type: "text" });                          // replacement answer
    expect(result.finalMessage.content.length).toBe(2);
  });
});
