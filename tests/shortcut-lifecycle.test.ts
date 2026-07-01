/**
 * P1.M3.T2.S1 (Issue 2) — end-to-end shortcut-lifecycle regression guard.
 *
 * Validates EC-005 (shortcut disabled after `thinking_end`) and EC-006 (shortcut disabled on the first
 * answer token `text_start`) through the REAL coordinator entry point (`coordinator.requestStop()`) —
 * proving no abort AND no replacement request occurs. Plus a positive control proving the shortcut
 * remains armed (returns `true`) while genuinely mid-reasoning (before any leave-condition).
 *
 * Uses a coordinator-wired 11-arg `StreamProxy` + `coordinator.setActiveProxy(proxy)` and a two-phase
 * mock (`makeReplacementUpstream` copied from `stream-proxy-pending-stop.test.ts` + added
 * `isPrimaryAborted` accessor). This is the end-to-end layer — T1.S1's unit tests
 * (`stream-proxy-reasoning-ended.test.ts`) cover `proxy.canInterrupt()`/`triggerStop()` with a
 * single-call mock and NO coordinator.
 */

import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionCoordinator } from "../src/state/coordinator";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";
import {
  makeCaptureDiag,
  makeModel,
  ev,
  waitFor,
  DONE_MESSAGE,
} from "./helpers/invariant-harness";

// --- Two-phase upstream mock (copied from stream-proxy-pending-stop.test.ts + isPrimaryAborted) ---

/**
 * Two-phase upstream mock (shape from stream-proxy-replacement.test.ts).
 * 1st call → PRIMARY iterable (yields events, throws on its signal abort);
 * 2nd call → REPLACEMENT iterable (yields events, throws on its signal abort).
 * Separate queues + signals.
 *
 * Added accessor `isPrimaryAborted` exposing the closure-captured `primarySignal.aborted` —
 * needed to assert the primary upstream was NOT aborted (EC-005/EC-006).
 */
function makeReplacementUpstream() {
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = [];
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];
  let callCount = 0;
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    callCount++;
    if (callCount === 1) {
      primarySignal = opts?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (primarySignal?.aborted) throw new Error("aborted");
            if (primaryQueue.length) { yield primaryQueue.shift()!; continue; }
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 0);
              primarySignal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
            });
          }
        },
      };
    }
    // 2nd call = REPLACEMENT
    calls.push({ options: opts as { reasoning?: unknown; signal?: AbortSignal } | undefined });
    replacementSignal = opts?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (replacementSignal?.aborted) throw new Error("aborted");
          if (replacementQueue.length) { yield replacementQueue.shift()!; continue; }
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 0);
            replacementSignal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
          });
        }
      },
    };
  }) as unknown as ApiStreamSimpleFunction;
  return {
    fn,
    calls,
    pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e),
    pushReplacement: (e: AssistantMessageEvent) => replacementQueue.push(e),
    isPrimaryAborted: () => !!primarySignal?.aborted,
  };
}

// --- tests ------------------------------------------------------------------

describe("StreamProxy — shortcut lifecycle / EC-005 / EC-006 (P1.M3.T2.S1, coordinator end-to-end)", () => {

  test("EC-005: triggerStop()/requestStop() return false after thinking_end (no abort, 0 replacements)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const coordinator = new TransitionCoordinator(diag);
    const mock = makeReplacementUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      2000,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Push the §22.4 leave-condition: thinking_end
    mock.pushPrimary(ev({ type: "thinking_end", contentIndex: 0, content: "thinking..." }));
    await waitFor(() => seen.includes("thinking_end")); // trackEvent ran → _reasoningEnded set

    // THE FOUR ASSERTIONS (the contract)
    expect(proxy.triggerStop()).toBe(false);       // (1) proxy: no abort dispatched
    expect(coordinator.requestStop()).toBe(false); // (2) coordinator (the real entry point): false
    expect(mock.isPrimaryAborted()).toBe(false);   // (3) upstream AbortSignal NOT aborted
    expect(mock.calls.length).toBe(0);             // (4) NO replacement provider call

    // Finish the primary stream cleanly (shortcut not taken → primary still streaming)
    mock.pushPrimary(ev({ type: "text_start", contentIndex: 1 }));
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 1, delta: "answer" }));
    mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });

  test("EC-006: triggerStop()/requestStop() return false on first answer token text_start (no abort, 0 replacements)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const coordinator = new TransitionCoordinator(diag);
    const mock = makeReplacementUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      2000,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Push the §22.4 leave-condition: first answer token (text_start), NO thinking_end
    mock.pushPrimary(ev({ type: "text_start", contentIndex: 1 }));
    await waitFor(() => seen.includes("text_start")); // trackEvent ran → flag set

    // THE FOUR ASSERTIONS
    expect(proxy.triggerStop()).toBe(false);       // (1) proxy: no abort dispatched
    expect(coordinator.requestStop()).toBe(false); // (2) coordinator: false
    expect(mock.isPrimaryAborted()).toBe(false);   // (3) upstream NOT aborted
    expect(mock.calls.length).toBe(0);             // (4) NO replacement provider call

    // Finish the primary stream cleanly
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 1, delta: "answer" }));
    mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });

  test("positive control: triggerStop()===true DURING reasoning (before any leave-condition) launches 1 replacement", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const coordinator = new TransitionCoordinator(diag);
    const mock = makeReplacementUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      2000,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // SANITY: shortcut still armed DURING reasoning (before any leave-condition)
    expect(proxy.canInterrupt()).toBe(true);

    // FIRE THE SHORTCUT — flag still false → canInterrupt()===true
    expect(proxy.triggerStop()).toBe(true);              // shortcut ACTIVE while mid-reasoning
    await waitFor(() => mock.calls.length === 1, 500);  // replacement provider call WAS made
    expect(mock.isPrimaryAborted()).toBe(true);          // upstream AbortSignal WAS aborted

    // Complete the launched replacement so run() exits cleanly
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });

});
