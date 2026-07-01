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
 * DETERMINISTIC natural-completion race mock (EC-007). Phase 1: drain pending events as they arrive
 * (blocks when empty) and DOES NOT throw on abort — so a queued terminal is ALWAYS forwarded before the
 * abort resolves. Phase 2: once a terminal (done/error) is yielded, either THROW the abort error
 * (`afterDone === "throw"`) or RETURN naturally (`afterDone === "close"`). Models "the done was already
 * in flight and gets delivered despite the abort" — the exact EC-007 timeline.
 */
function makeNaturalCompletionRaceMock(afterDone: "throw" | "close") {
  let signal: AbortSignal | undefined;
  const queue: AssistantMessageEvent[] = [];
  const iterable = {
    async *[Symbol.asyncIterator]() {
      // Phase 1 — forward everything queued; never throw on abort here (so the terminal is delivered).
      while (true) {
        if (queue.length > 0) {
          const e = queue.shift()!;
          yield e;
          if (e.type === "done" || e.type === "error") {
            // Phase 2 — terminal just forwarded; now resolve the race.
            if (afterDone === "throw" && signal?.aborted) throw new Error("aborted");
            return; // close naturally
          }
          continue;
        }
        await new Promise<void>((r) => setTimeout(r, 0)); // block until more events are queued
      }
    },
  };
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    signal = opts?.signal;
    return iterable;
  }) as unknown as ApiStreamSimpleFunction;
  return { fn, push: (e: AssistantMessageEvent) => queue.push(e) };
}

// --- race tests -----------------------------------------------------------

describe("StreamProxy — race detection (P1.M5.T2.S1)", () => {

  test("done race — catch path (afterDone: throw): natural completion wins", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeNaturalCompletionRaceMock("throw");

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
    );

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch the abort — the mock will forward done THEN throw the abort error
    expect(proxy.triggerStop()).toBe(true);

    // Push the terminal — it gets forwarded BEFORE the abort resolves (EC-007 timeline)
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Consumer must see the original done
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toEqual(["done"]); // exactly one terminal, the original done
    expect(seen).toContain("done");

    // Controller must be Idle (natural completion won — abort cancelled)
    await waitFor(() => controller.getState() === "Idle");

    // Buffer must NOT be frozen
    expect(() => buffer.append("x")).not.toThrow();

    // proxy.abort.natural-completion-won must be traced
    expect(events.some((c) => c.event === "proxy.abort.natural-completion-won")).toBe(true);

    // proxy.abort.completed must NOT be traced (T1's clean-abort marker)
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false);
  });

  test("done race — natural-exit path (afterDone: close): natural completion wins", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeNaturalCompletionRaceMock("close");

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
    );

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch the abort — the mock will forward done then return (no throw)
    expect(proxy.triggerStop()).toBe(true);

    // Push the terminal
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Consumer must see the original done
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toEqual(["done"]);

    // Controller must be Idle
    await waitFor(() => controller.getState() === "Idle");

    // Buffer must NOT be frozen
    expect(() => buffer.append("x")).not.toThrow();

    // proxy.abort.natural-completion-won must be traced
    expect(events.some((c) => c.event === "proxy.abort.natural-completion-won")).toBe(true);

    // proxy.abort.completed must NOT be traced
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false);
  });

  test("error race (afterDone: throw): natural completion wins for error terminal", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeNaturalCompletionRaceMock("throw");

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
    );

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch the abort
    expect(proxy.triggerStop()).toBe(true);

    // Push an error terminal — trackEvent resets FSM to Idle on error
    mock.push(ev({ type: "error", reason: "error", error: ERROR_MESSAGE }));

    await consumer;

    // Consumer must see the original error
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toEqual(["error"]);

    // Controller must be Idle (trackEvent already reset it on error; natural-completion branch confirms)
    await waitFor(() => controller.getState() === "Idle");

    // Buffer must NOT be frozen
    expect(() => buffer.append("x")).not.toThrow();

    // proxy.abort.natural-completion-won must be traced
    expect(events.some((c) => c.event === "proxy.abort.natural-completion-won")).toBe(true);

    // proxy.abort.completed must NOT be traced
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false);
  });

  test("genuine clean-abort regression (no terminal forwarded): T1 behavior preserved", async () => {
    // Use T1's makeAbortableUpstream — but inline it since we can't import from another test file.
    // This mock checks signal.aborted BEFORE yielding → no terminal is forwarded → pure clean abort.
    let signal: AbortSignal | undefined;
    const queue: AssistantMessageEvent[] = [];
    const iterable = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (signal?.aborted) throw new Error("aborted");
          if (queue.length > 0) { yield queue.shift()!; continue; }
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
    const push = (e: AssistantMessageEvent) => queue.push(e);

    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined, // requestBuilder
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    // Drive to Reasoning
    push(ev({ type: "start" }));
    push(ev({ type: "thinking_start", contentIndex: 0 }));
    push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch the abort — mock throws immediately (no terminal queued)
    expect(proxy.triggerStop()).toBe(true);

    // Wait for clean abort — use the stable proxy.abort.completed trace
    // (FSM continues past Capturing → Restarting; waitFor(Capturing) can never observe it)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));

    // Buffer must be frozen (genuine clean abort)
    expect(() => buffer.append("no")).toThrow();

    // proxy.abort.completed must be traced (T1 marker)
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(true);

    // proxy.abort.natural-completion-won must NOT be traced
    expect(events.some((c) => c.event === "proxy.abort.natural-completion-won")).toBe(false);

    // No terminal was synthesized
    const abortWarns = events.filter((c) => c.event === "proxy.forward.upstream-threw");
    expect(abortWarns).toHaveLength(0);
  });

  test("normal forwarding regression: non-aborted stream unchanged", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    // Use the race mock in "close" mode with no abort — just a normal stream
    const mock = makeNaturalCompletionRaceMock("close");

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
    );

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "a" }));
    mock.push(ev({ type: "thinking_end", contentIndex: 0, content: "a" }));
    mock.push(ev({ type: "text_start", contentIndex: 1 }));
    mock.push(ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }));
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // All events forwarded unchanged
    expect(seen).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "done",
    ]);

    // No abort-related diagnostics fired
    expect(events.filter((c) => c.event.startsWith("proxy.abort."))).toHaveLength(0);

    // Buffer accumulated reasoning
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["a"]);
  });

  test("privacy guard: natural-completion-won diagnostics log only empty object", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeNaturalCompletionRaceMock("throw");

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
    );

    // Drain consumer concurrently
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();

    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    proxy.triggerStop();
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Filter abort-related diagnostic events
    const abortEvents = events.filter((c) => c.event.startsWith("proxy.abort."));
    const ALLOWED_KEYS = new Set([
      "timeoutMs", "error",
      // empty-object events are fine
    ]);

    for (const captured of abortEvents) {
      if (!captured.fields) continue;
      for (const key of Object.keys(captured.fields)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }

    // Specifically: proxy.abort.natural-completion-won logs {} only
    const naturalWon = events.find((c) => c.event === "proxy.abort.natural-completion-won");
    expect(naturalWon).toBeDefined();
    expect(Object.keys(naturalWon!.fields ?? {})).toHaveLength(0);
  });
});
