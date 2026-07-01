import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { makeCaptureDiag, makeModel, waitFor, makeScriptedTwoPhaseUpstream, ev } from "./helpers/invariant-harness";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

describe("StreamProxy — primary content capture (P1.M2.T1.S1)", () => {
  test("captures the primary frozen thinking block + contentIndex offset at the abort boundary", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeRealisticTwoPhaseMock();

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15, // orphan-safe replacement startup timeout
    );

    // Drive PRIMARY (reasoning ON) with realistic partials → primaryOutput.content grows to [{thinking}].
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
    mock.pushPrimary({ type: "thinking_delta", delta: " me" });
    await waitFor(() => proxy.isReasoning()); // run() has processed the thinking events

    expect(proxy.triggerStop()).toBe(true); // Aborting + _internalAbort.abort() → primary throws
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot

    // THE CAPTURE: one structured thinking block (NOT a raw delta string) + offset = block count.
    expect(proxy.frozenPrimaryContent).toHaveLength(1);
    expect(proxy.frozenPrimaryContent[0]).toMatchObject({ type: "thinking", thinking: "Let me" });
    expect(proxy.contentIndexOffset).toBe(1);

    // Clean up: let the replacement complete so no timer/rejection leaks.
    mock.pushReplacement({ type: "done" });
    for await (const _e of proxy.output) { /* drain to completion */ }
  });

  test("placeholder partials (no partial) yield empty frozen content and zero offset (guard)", async () => {
    // The existing suite uses ev({...}) events with NO partial — this MUST stay a no-op (→ 384 tests green).
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeScriptedTwoPhaseUpstream(); // placeholder mock; events have no `partial`

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15,
    );

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    expect(proxy.triggerStop()).toBe(true);
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));

    expect(proxy.frozenPrimaryContent).toEqual([]); // guard: undefined partial → []
    expect(proxy.contentIndexOffset).toBe(0);       // guard: → T2 rewrite is a no-op

    // Clean up: push a replacement error and drain
    mock.pushReplacement(ev({ type: "error", reason: "error", error: { role: "assistant", content: [] } as never }));
    for await (const _e of proxy.output) { /* drain */ }
  });
});
