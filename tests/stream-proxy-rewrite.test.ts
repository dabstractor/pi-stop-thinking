import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { makeCaptureDiag, makeModel, waitFor, makeScriptedTwoPhaseUpstream, ev } from "./helpers/invariant-harness";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

describe("StreamProxy — replacement-event rewrite (P1.M2.T2.S1)", () => {
  test("rewrites non-terminal replacement events — offset contentIndex + merged partial", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeRealisticTwoPhaseMock();

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000, // generous replacement startup timeout
    );

    // Drive PRIMARY (reasoning ON) → primaryOutput.content grows to [{thinking:'Let me'}].
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
    mock.pushPrimary({ type: "thinking_delta", delta: " me" });
    await waitFor(() => proxy.isReasoning()); // run() processed the thinking events → offset will be 1

    expect(proxy.triggerStop()).toBe(true); // abort → freeze → snapshot (offset now 1)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot done

    // Drive REPLACEMENT (reasoning OFF) → text block at content[0] (contentIndex 0 pre-rewrite).
    mock.pushReplacement({ type: "text_start" });
    mock.pushReplacement({ type: "text_delta", delta: "Here" });
    mock.pushReplacement({ type: "text_delta", delta: " answer" });
    mock.pushReplacement({ type: "text_end" });
    mock.pushReplacement({ type: "done" });

    // Collect forwarded events (done completes the stream; replacement start is suppressed).
    const forwarded: AssistantMessageEvent[] = [];
    for await (const event of proxy.output) forwarded.push(event);

    // Filter the NON-TERMINAL replacement text events.
    const txt = forwarded.filter((e) => e.type.startsWith("text_"));
    expect(txt.length).toBe(4); // text_start + 2 text_delta + text_end

    // ASSERT the rewrite on EACH text event.
    for (const e of txt) {
      expect(e.contentIndex).toBe(1); // OFFSET applied (mock emitted 0)
      expect(e.partial.content.length).toBe(2); // merged: frozen + replacement
      expect(e.partial.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" }); // frozen, STABLE
      expect(e.partial.content[1]).toMatchObject({ type: "text" }); // growing answer
    }

    // Assert the replacement's text block is present and has the fully accumulated text
    // (the mock mutates the live block synchronously during pushReplacement, so by drain time
    // all events share the same live reference with the full text).
    expect(txt.find((e) => e.type === "text_start")!.partial.content[1]).toMatchObject({ type: "text" });
    expect(txt.filter((e) => e.type === "text_delta").pop()!).toMatchObject({
      contentIndex: 1,
      partial: expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "Here answer" })]),
      }),
    });

    // Assert the terminal was forwarded UNCHANGED (T2.S1 does NOT touch it — T2.S2 owns it):
    const done = forwarded.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect("contentIndex" in (done as object)).toBe(false);
  });

  test("offset-0 (placeholder partials) forwards replacement events UNCHANGED (guard)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeScriptedTwoPhaseUpstream(); // placeholder mock; events have no partial → offset 0

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000,
    );

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    expect(proxy.triggerStop()).toBe(true);
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));
    expect(proxy.contentIndexOffset).toBe(0); // guard precondition

    // Replacement text event WITH a partial (one text block) — gate must SKIP (offset 0) → unchanged.
    mock.pushReplacement(ev({
      type: "text_delta", contentIndex: 0, delta: "x",
      partial: { role: "assistant", content: [{ type: "text", text: "x" }] } as never,
    }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: { role: "assistant", content: [] } as never }));

    const forwarded: AssistantMessageEvent[] = [];
    for await (const event of proxy.output) forwarded.push(event);

    const td = forwarded.find((e) => e.type === "text_delta");
    expect(td).toBeDefined();
    expect(td!.contentIndex).toBe(0); // UNCHANGED (offset 0 → no rewrite)
    expect((td as any).partial.content.length).toBe(1); // NOT merged/prepended
  });
});
