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

// --- test doubles (verbatim from stream-proxy-filtering.test.ts) ----------

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call. */
function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info: (e, f) => events.push({ level: "info", event: e, fields: f }),
    warn: (e, f) => events.push({ level: "warn", event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}

/** Minimal Model stand-in. */
function makeModel() {
  return { id: "glm-4.7", api: "openai-completions", provider: "zai" } as unknown as Parameters<
    typeof StreamProxy
  >[0];
}

/** Build a synthetic AssistantMessageEvent. */
function ev(partial: { type: string } & Partial<AssistantMessageEvent>): AssistantMessageEvent {
  return { ...partial } as unknown as AssistantMessageEvent;
}

const DONE_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;

/** Polling helper: wait until `pred()` returns true (or timeout). */
async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

/**
 * Two-phase upstream mock (shape from stream-proxy-replacement.test.ts).
 * 1st call → PRIMARY iterable (yields events, throws on its signal abort);
 * 2nd call → REPLACEMENT iterable (yields events, throws on its signal abort).
 * Separate queues + signals.
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
  };
}

// --- pending-stop end-to-end tests -----------------------------------------

describe("StreamProxy — pending stop (EC-002, end-to-end)", () => {

  test("EC-002 auto-trigger on first reasoning event", async () => {
    const { diag, events } = makeCaptureDiag();
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

    // Push start → Delegating
    mock.pushPrimary(ev({ type: "start" }));
    await waitFor(() => proxy.isDelegating(), 200);

    // Press during Delegating → returns false (pending stop recorded)
    expect(coordinator.requestStop()).toBe(false);
    const recordTrace = events.find((e) => e.event === "coordinator.request-stop" && e.fields?.reason === "pending-stop-recorded");
    expect(recordTrace).toBeDefined();

    // Push reasoning → proxy auto-triggers the pending stop
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));

    // Replacement should be launched WITHOUT any manual triggerStop()
    await waitFor(() => mock.calls.length === 1, 500);

    // Assert pending-stop.triggered trace
    expect(events.some((e) => e.event === "proxy.pending-stop.triggered")).toBe(true);

    // Complete the replacement stream
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Exactly one start + one terminal
    expect(seen.filter((t) => t === "start")).toHaveLength(1);
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);
  });

  test("EC-002 clear-on-text: pending stop discarded when provider answers without reasoning", async () => {
    const { diag, events } = makeCaptureDiag();
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

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Push start → Delegating
    mock.pushPrimary(ev({ type: "start" }));
    await waitFor(() => proxy.isDelegating(), 200);

    // Press during Delegating → pending stop recorded
    expect(coordinator.requestStop()).toBe(false);

    // Push text (provider answers without reasoning) → pending stop cleared
    mock.pushPrimary(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // NO replacement launched
    expect(mock.calls.length).toBe(0);

    // Pending stop is cleared
    expect(coordinator.consumePendingStop()).toBe(false);

    // isReasoning stays false (never entered Reasoning)
    expect(proxy.isReasoning()).toBe(false);

    // One start + one terminal
    expect(seen.filter((t) => t === "start")).toHaveLength(1);
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);
  });

  test("no coordinator: pending stop is a safe no-op", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeReplacementUpstream();

    // Construct proxy WITHOUT coordinator (production shape)
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
      // coordinator: undefined
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Push start + reasoning — should just reason normally, no auto-trigger
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // No auto-trigger, no replacement
    expect(mock.calls.length).toBe(0);

    // Complete normally
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;

    expect(seen.filter((t) => t === "start")).toHaveLength(1);
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);
  });

  test("EC-005/EC-006 proxy-level lock-in: after transition completes, requestStop rejected", async () => {
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

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive into Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // First press — accepted, triggers transition
    expect(coordinator.requestStop()).toBe(true);
    await waitFor(() => mock.calls.length === 1, 500);

    // Second press — rejected (first-press-wins: FSM left Reasoning)
    expect(coordinator.requestStop()).toBe(false);

    // Complete the replacement normally
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;

    expect(seen.filter((t) => t === "start")).toHaveLength(1);
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);
  });

});
