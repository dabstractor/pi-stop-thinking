/**
 * P1.M3.T1.S1 (Issue 2) — _reasoningEnded flag unit tests.
 *
 * Validates EC-005 (shortcut disabled after `thinking_end`) and EC-006 (shortcut disabled on the first
 * answer token `text_start`/`toolcall_start`). Also verifies the sanity case that `canInterrupt()`
 * remains `true` DURING reasoning (before any leave-condition), preserving the happy-path abort path.
 *
 * Uses the `makeAbortableUpstream` mock pattern copied from `tests/stream-proxy-abort.test.ts` (not
 * exported from the invariant harness) so we can assert `isAborted()===false` (no abort dispatched).
 */

import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";
import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from "./helpers/invariant-harness";

// --- test doubles (copied from stream-proxy-abort.test.ts — not exported by the harness) ---

/**
 * Async-iterable mock: yields queued events; when the injected signal aborts, the iterator throws
 * (replicating a real provider aborting on signal.abort).
 */
function makeAbortableUpstream() {
  let signal: AbortSignal | undefined;
  const queue: AssistantMessageEvent[] = [];
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (signal?.aborted) throw new Error("aborted");
        if (queue.length > 0) { yield queue.shift()!; continue; }
        // Block until a new event arrives OR the signal aborts.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 0);
          signal?.addEventListener(
            "abort",
            () => { clearTimeout(t); reject(new Error("aborted")); },
            { once: true },
          );
        });
      }
    },
  };
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    signal = opts?.signal;
    return iterable;
  }) as unknown as ApiStreamSimpleFunction;
  return {
    fn,
    push: (e: AssistantMessageEvent) => queue.push(e),
    isAborted: () => !!signal?.aborted,
  };
}

// --- tests ------------------------------------------------------------------

describe("StreamProxy — reasoningEnded flag (P1.M3.T1.S1 / Issue 2)", () => {

  test("EC-005: canInterrupt()/triggerStop() disabled after thinking_end (no abort/replacement)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15,
    );

    // Concurrent consumer draining proxy.output into `seen`
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // SANITY: shortcut is still armed DURING reasoning (happy path preserved)
    expect(proxy.canInterrupt()).toBe(true);

    // Push the §22.4 leave-condition: thinking_end
    mock.push(ev({ type: "thinking_end", contentIndex: 0, content: "thinking..." }));
    await waitFor(() => seen.includes("thinking_end")); // trackEvent ran BEFORE the forward → flag set

    // THE FIX assertions
    expect(proxy.canInterrupt()).toBe(false);        // reasoning ended → shortcut disabled
    expect(proxy.triggerStop()).toBe(false);          // no abort dispatched
    expect(mock.isAborted()).toBe(false);             // upstream NOT aborted
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false); // no abort path taken

    // Let the stream finish cleanly
    mock.push(ev({ type: "text_start", contentIndex: 1 }));
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });

  test("EC-006: canInterrupt()/triggerStop() disabled on first answer token (no abort/replacement)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15,
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning (NO thinking_end — direct answer token leave-condition)
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // SANITY: shortcut is still armed DURING reasoning
    expect(proxy.canInterrupt()).toBe(true);

    // Push the §22.4 leave-condition: first answer token (text_start)
    mock.push(ev({ type: "text_start", contentIndex: 1 }));
    await waitFor(() => seen.includes("text_start")); // trackEvent ran → flag set

    // THE FIX assertions
    expect(proxy.canInterrupt()).toBe(false);        // reasoning ended → shortcut disabled
    expect(proxy.triggerStop()).toBe(false);          // no abort dispatched
    expect(mock.isAborted()).toBe(false);             // upstream NOT aborted
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false); // no abort path taken

    // Let the stream finish cleanly
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });

  test("sanity: canInterrupt()===true DURING reasoning before any leave-condition", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15,
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // SANITY: canInterrupt() is true DURING reasoning (before any leave-condition)
    expect(proxy.canInterrupt()).toBe(true);
    // isReasoning() also true (telemetry — unchanged)
    expect(proxy.isReasoning()).toBe(true);

    // triggerStop() should succeed (happy path preserved)
    expect(proxy.triggerStop()).toBe(true);
    expect(mock.isAborted()).toBe(true);

    // Let the stream settle (abort will resolve once run() processes it)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));
  });

  test("EC-006 variant: canInterrupt() disabled on toolcall_start (first tool-call answer token)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15,
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    expect(proxy.canInterrupt()).toBe(true); // sanity

    // Push toolcall_start — the third §22.4 leave-condition arm
    mock.push(ev({ type: "toolcall_start", contentIndex: 1 }));
    await waitFor(() => seen.includes("toolcall_start"));

    expect(proxy.canInterrupt()).toBe(false);
    expect(proxy.triggerStop()).toBe(false);
    expect(mock.isAborted()).toBe(false);
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false);

    // Let the stream finish cleanly
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });
});
