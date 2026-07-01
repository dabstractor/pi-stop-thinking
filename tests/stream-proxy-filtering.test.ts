import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles (verbatim from stream-proxy-abort.test.ts) ----------------

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
const ERROR_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;

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

// --- filtering tests -----------------------------------------------------------

describe("StreamProxy — event filtering (P1.M7.T2.S1)", () => {

  test("full interruption cycle: exactly one start + one done (INV-002/INV-003)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
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
    );

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive primary: start + thinking → Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch abort → replacement launched
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement events: start (suppressed) + text + done
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "text_end", contentIndex: 0, content: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Exactly one start and one done
    const starts = seen.filter((t) => t === "start");
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(starts).toHaveLength(1);
    expect(terminals).toHaveLength(1);

    // Sequence: start (primary), thinking_*, text_*, done (replacement) — replacement start absent
    expect(seen).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  test("replacement start suppressed with proxy.splice.start-suppressed trace", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
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
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement start (should be suppressed)
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Exactly one start in output (the primary's)
    expect(seen.filter((t) => t === "start")).toHaveLength(1);

    // The suppression trace must have been emitted
    expect(events.some((c) => c.event === "proxy.splice.start-suppressed")).toBe(true);
  });

  test("replacement thinking_* suppressed (EC-017: reasoning returned anyway)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
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
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "primary thinking" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Replacement emits thinking_* before its text (EC-017)
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "thinking_delta", contentIndex: 0, delta: "stray reasoning" }));
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Only the primary's thinking events should appear (2: thinking_start + thinking_delta)
    const thinkingEvents = seen.filter((t) => t === "thinking_start" || t === "thinking_delta" || t === "thinking_end");
    expect(thinkingEvents).toHaveLength(2);
    expect(thinkingEvents).toEqual(["thinking_start", "thinking_delta"]);
  });

  test("duplicate terminal suppressed (FM-014) with trace", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
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
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement text + done + a SECOND done (duplicate terminal)
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE })); // duplicate

    await consumer;

    // Exactly one terminal in output
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);

    // FM-014 trace must have been emitted
    expect(events.some((c) => c.event === "proxy.splice.duplicate-terminal")).toBe(true);
  });

  test("replacement text_* + toolcall_* forwarded", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
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
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement: text + toolcall + text + done
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "toolcall_start", contentIndex: 0, toolCallIndex: 0 }));
    mock.pushReplacement(ev({ type: "toolcall_delta", contentIndex: 0, toolCallIndex: 0, delta: "tool" }));
    mock.pushReplacement(ev({ type: "toolcall_end", contentIndex: 0, toolCallIndex: 0, toolCall: { name: "fn", args: [] } as never }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // All text + toolcall events must appear in order
    const replacementTypes = seen.filter((t) =>
      t !== "start" && t !== "thinking_start" && t !== "thinking_delta"
    );
    expect(replacementTypes).toEqual([
      "text_start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "text_delta",
      "done",
    ]);

    // Exactly one terminal
    expect(seen.filter((t) => t === "done" || t === "error")).toHaveLength(1);
  });

  test("output.result() resolves to the forwarded done.message", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
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
    );

    // Drain consumer concurrently (required for output to resolve)
    const consumer = (async () => {
      for await (const _e of proxy.output) { /* drain */ }
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    // await result() — it resolves to the message from the forwarded done terminal
    const result = await proxy.output.result();
    expect(result).toBe(DONE_MESSAGE);

    await consumer;
  });

  test("privacy guard: proxy.splice.* traces log {} only", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeReplacementUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      { reasoning: "high", apiKey: "secret-key", prompt: "user secret" } as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      2000,
    );

    const consumer = (async () => {
      for await (const _e of proxy.output) { /* drain */ }
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement with start (suppressed) + text + done + duplicate done (FM-014)
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Filter proxy.splice.* diagnostic events
    const spliceEvents = events.filter((c) => c.event.startsWith("proxy.splice."));
    expect(spliceEvents.length).toBeGreaterThanOrEqual(1); // at least start-suppressed

    for (const captured of spliceEvents) {
      // proxy.splice.* events log {} only (Appendix H)
      expect(captured.fields).toEqual({});
    }
  });
});
