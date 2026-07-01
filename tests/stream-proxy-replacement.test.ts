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

// --- test doubles ---------------------------------------------------------

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call (adapted from transition-controller.test.ts). */
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

/** Minimal Model stand-in — only .id/.api/.provider are read (defensive path only). */
function makeModel() {
  return { id: "glm-4.7", api: "openai-completions", provider: "zai" } as unknown as Parameters<
    typeof StreamProxy
  >[0];
}

/** Build a synthetic AssistantMessageEvent carrying only what each case needs. */
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
 * Two-phase upstream mock: 1st call → PRIMARY iterable (yields thinking, throws on its signal abort);
 * 2nd call → REPLACEMENT iterable (records its options, yields replacement events, throws on its signal
 * abort). The two phases use SEPARATE queues + signals (the replacement gets a fresh signal from the proxy).
 */
function makeReplacementUpstream() {
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = []; // recorded REPLACEMENT invocations
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
    // 2nd call = REPLACEMENT. Record the invocation args (the headline MOCKING assertion target).
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
    calls, // calls[0] is the REPLACEMENT invocation (primary call is not recorded)
    pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e),
    pushReplacement: (e: AssistantMessageEvent) => replacementQueue.push(e),
  };
}

// --- replacement tests -----------------------------------------------------------

describe("StreamProxy — replacement launch (P1.M7.T1.S1)", () => {

  test("replacement invoked with reasoning === undefined + a fresh signal", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeReplacementUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      { reasoning: "high" } as never, // original request has reasoning enabled
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined, // requestBuilder — use default
      2000, // replacementStartupTimeoutMs — generous
    );

    // Drive primary to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch abort → triggers replacement launch
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Headline assertion: replacement was invoked with reasoning === undefined
    expect(mock.calls[0].options?.reasoning).toBeUndefined();
    // Fresh signal — not the already-aborted primary signal
    expect(mock.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(mock.calls[0].options?.signal?.aborted).toBe(false);

    // Clean abort precondition still holds
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(true);
  });

  test("FSM: Capturing → Restarting → Splicing on first replacement event", async () => {
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

    // Drive to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for replacement to be invoked (means we passed through Capturing + Restarting)
    await waitFor(() => mock.calls.length === 1, 500);

    // Now push the first replacement event → triggers Splicing (+ Answering via T3 beginAnswering)
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));

    // Wait for Splicing→Answering (T3: beginAnswering fires on first text/toolcall in Splicing)
    await waitFor(() => controller.getState() === "Answering", 500);

    // proxy.replacement.first-event trace confirms the splice transition
    expect(events.some((c) => c.event === "proxy.replacement.first-event")).toBe(true);
  });

  test("authority flips from forwarding to splicing on first replacement event", async () => {
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

    // Before any replacement event, authority is forwarding
    expect(proxy.authority).toBe("forwarding");

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await waitFor(() => mock.calls.length === 1, 500);

    // Still forwarding until first replacement event
    expect(proxy.authority).toBe("forwarding");

    // Push first replacement event → Splicing + authority flip (+ Answering via T3 beginAnswering)
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    await waitFor(() => controller.getState() === "Answering", 500);

    // Authority is now splicing (irreversible)
    expect(proxy.authority).toBe("splicing");
  });

  test("replacement startup timeout → Failed when no first event arrives", async () => {
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
      15, // tiny replacementStartupTimeoutMs to fail fast
    );

    // Drive to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for replacement to be invoked
    await waitFor(() => mock.calls.length === 1, 500);

    // Do NOT push any replacement events — let the timeout fire (T3: _terminate moves Failed→Idle after catch)
    await waitFor(() => events.some((c) => c.event === "proxy.replacement.startup-timeout"), 200);

    // proxy.replacement.startup-timeout must have been warned
    expect(events.some((c) => c.event === "proxy.replacement.startup-timeout")).toBe(true);
  });

  test("replacement text events forwarded into output", async () => {
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
    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for replacement invocation
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement events (text_start + delta + done)
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "Hello" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Consumer must see the replacement text events + the done terminal
    const types = seen.map((e) => e.type);
    // Primary events before abort are also forwarded (start, thinking_*)
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("done");

    // Exactly one terminal
    const terminals = types.filter((t) => t === "done" || t === "error");
    expect(terminals).toEqual(["done"]);
  });

  test("privacy guard: replacement diagnostics log only safe fields", async () => {
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
      15, // tiny timeout so replacement fails quickly
    );

    // Drive to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for replacement invocation and timeout (T3: _terminate moves Failed→Idle after catch)
    await waitFor(() => mock.calls.length === 1, 500);
    await waitFor(() => events.some((c) => c.event === "proxy.replacement.startup-timeout"), 200);

    // Filter replacement-related diagnostic events
    const replacementEvents = events.filter((c) => c.event.startsWith("proxy.replacement."));
    const ALLOWED_KEYS = new Set([
      "timeoutMs", "error",
      // empty-object events are fine (proxy.replacement.first-event has {})
    ]);

    for (const captured of replacementEvents) {
      if (!captured.fields) continue;
      for (const key of Object.keys(captured.fields)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }
  });
});
