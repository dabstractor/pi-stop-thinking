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

/**
 * Mock that IGNORES the abort signal and blocks forever until released (simulates FM-006:
 * provider ignores abort). The test releases it AFTER asserting the timeout → Failed.
 */
function makeUnresponsiveUpstream() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const queue: AssistantMessageEvent[] = [];
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (queue.length > 0) yield queue.shift()!;
      await gate; // never observes the signal; test calls release() to let run() exit
    },
  };
  const fn = ((_m: unknown, _c: unknown, _opts?: unknown) => iterable) as unknown as ApiStreamSimpleFunction;
  return { fn, push: (e: AssistantMessageEvent) => queue.push(e), release };
}

/** Polling helper: wait until `pred()` returns true (or timeout). */
async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

// --- abort tests -----------------------------------------------------------

describe("StreamProxy — abort coordination (P1.M5.T1.S1)", () => {

  test("clean abort happy path (PRD §51): triggerStop → Capturing + buffer frozen + no terminal", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined, // requestBuilder
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    // Drive events to reach Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch the abort
    expect(proxy.triggerStop()).toBe(true);
    expect(mock.isAborted()).toBe(true);

    // Wait for run()'s catch to observe the abort → completeAbort → freeze → proxy.abort.completed
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));

    // Buffer must be frozen (append throws)
    expect(() => buffer.append("no")).toThrow();

    // proxy.abort.completed must have been traced
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(true);

    // NO terminal was synthesized — output is left OPEN for replacement (P1.M6/P1.M7).
    // We verify by checking that no error terminal was pushed on the abort path.
    const abortWarns = events.filter((c) => c.event === "proxy.forward.upstream-threw");
    expect(abortWarns).toHaveLength(0);
  });

  test("triggerStop outside Reasoning → false; no abort dispatched", () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();

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
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    // Before any event, controller is still Idle (the upstream hasn't yielded start yet, but even if it did,
    // Delegating is not Reasoning). triggerStop should return false.
    expect(proxy.triggerStop()).toBe(false);
    expect(mock.isAborted()).toBe(false);
    expect(controller.getState()).toBe("Idle"); // unchanged
  });

  test("first-press-wins / isInterrupting: second triggerStop returns false", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();

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
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    // First press succeeds
    expect(proxy.triggerStop()).toBe(true);

    // isInterrupting should be true (state left Reasoning)
    expect(proxy.isInterrupting()).toBe(true);

    // Second press fails (canInterrupt now false)
    expect(proxy.triggerStop()).toBe(false);

    // Let the abort settle — wait for the stable proxy.abort.completed trace
    // (FSM continues past Capturing → Restarting; waitFor(Capturing) can never observe it)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));
  });

  test("canInterrupt()/isInterrupting() delegation", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();

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
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    // Idle: canInterrupt false, isInterrupting false
    expect(proxy.canInterrupt()).toBe(false);
    expect(proxy.isInterrupting()).toBe(false);

    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    // Reasoning: canInterrupt true, isInterrupting false
    expect(proxy.canInterrupt()).toBe(true);
    expect(proxy.isInterrupting()).toBe(false);

    proxy.triggerStop();
    // Now Aborting (then Capturing/Restarting): canInterrupt false, isInterrupting true
    await waitFor(() => proxy.isInterrupting());
    expect(proxy.canInterrupt()).toBe(false);
  });

  test("FM-006 timeout: unresponsive upstream → Failed + proxy.abort.timeout warn", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeUnresponsiveUpstream();

    // Push events BEFORE constructing the proxy — the unresponsive mock's generator
    // exhausts the queue then blocks on `await gate`, so events must be queued first.
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      20, // tiny abortTimeoutMs to exercise FM-006 quickly
    );

    // Wait for the upstream to yield the events and the proxy to reach Reasoning
    await waitFor(() => proxy.isReasoning());

    expect(proxy.triggerStop()).toBe(true);

    // Wait for the timeout to fire → Aborting → Failed
    await waitFor(() => controller.getState() === "Failed", 200);

    // proxy.abort.timeout must have been warned
    expect(events.some((c) => c.event === "proxy.abort.timeout")).toBe(true);

    // Buffer must NOT be frozen on the Failed path
    expect(() => buffer.append("still mutable")).not.toThrow();

    // Release the upstream so run() exits (no dangling handle)
    mock.release();
  });

  test("Pi escape propagates: external abort reaches upstream via internal controller", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();
    const externalCtrl = new AbortController();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      { signal: externalCtrl.signal } as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    // Drive to Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    // Pi aborts (user escape / ctrl+c) — no triggerStop call
    externalCtrl.abort();
    await waitFor(() => mock.isAborted());

    // The upstream mock's injected signal is aborted — Pi's escape reached it
    expect(mock.isAborted()).toBe(true);
  });

  test("normal forwarding regression: complete non-aborted stream forwards unchanged", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();

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
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
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

  // ─── Real-provider abort regression (error event instead of throw) ────────

  /**
   * Mock that mirrors the REAL openai-completions provider's abort behavior:
   * catches the abort internally and emits `{ type: "error", reason: "aborted" }`
   * as a terminal event, then returns cleanly (never throws). This is the exact
   * pattern that caused the CRITICAL finding — the proxy's catch-only abort path
   * was unreachable.
   */
  function makeErrorEventAbortUpstream() {
    let signal: AbortSignal | undefined;
    const queue: AssistantMessageEvent[] = [];
    const iterable = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) {
            const e = queue.shift()!;
            yield e;
            if (e.type === "done" || e.type === "error") return;
            continue;
          }
          if (signal?.aborted) {
            // Real-provider behavior: emit error event with reason="aborted"
            const abortedMsg = {
              ...ERROR_MESSAGE,
              stopReason: "aborted" as const,
              errorMessage: "Request was aborted",
            } as AssistantMessage;
            yield {
              type: "error" as const,
              reason: "aborted" as const,
              error: abortedMsg,
            } as AssistantMessageEvent;
            return; // stream ends cleanly — no throw
          }
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 0);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                // Resolve so next loop iteration sees signal.aborted
                resolve();
              },
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

  /**
   * Two-phase mock where the primary emits an error event on abort (real-provider
   * behavior) and the replacement is a standard two-phase mock.
   */
  function makeErrorEventAbortTwoPhase() {
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
              if (primaryQueue.length > 0) {
                const e = primaryQueue.shift()!;
                yield e;
                if (e.type === "done" || e.type === "error") return;
                continue;
              }
              if (primarySignal?.aborted) {
                const abortedMsg = {
                  ...ERROR_MESSAGE,
                  stopReason: "aborted" as const,
                  errorMessage: "Request was aborted",
                } as AssistantMessage;
                yield {
                  type: "error" as const,
                  reason: "aborted" as const,
                  error: abortedMsg,
                } as AssistantMessageEvent;
                return;
              }
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, 0);
                primarySignal?.addEventListener(
                  "abort",
                  () => { clearTimeout(t); resolve(); },
                  { once: true },
                );
              });
            }
          },
        };
      }
      // 2nd call = REPLACEMENT
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
      pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e),
      pushReplacement: (e: AssistantMessageEvent) => replacementQueue.push(e),
    };
  }

  test("real-provider abort: error event on abort triggers freeze+replacement (CRITICAL regression)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeErrorEventAbortUpstream();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined, // requestBuilder
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    // Drive events to reach Reasoning
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch the abort — mock will emit error event, NOT throw
    expect(proxy.triggerStop()).toBe(true);
    expect(mock.isAborted()).toBe(true);

    // The proxy MUST detect the aborted error event in the loop and route to
    // the freeze/replacement path — NOT forward it as a terminal.
    // Wait for proxy.abort.completed (the clean-abort marker that proves the
    // freeze/replacement path was reached).
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"), 500);

    // Buffer must be frozen
    expect(() => buffer.append("no")).toThrow();

    // proxy.abort.completed must have been traced
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(true);
  });

  test("real-provider abort: replacement launched and completes with text (full E2E)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeErrorEventAbortTwoPhase();

    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      mock.fn,
      diag,
      controller,
      buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined, // requestBuilder
      2000, // replacementStartupTimeoutMs — generous for replacement to complete
    );

    // Drain consumer concurrently
    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive primary to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Dispatch abort — mock emits { type: "error", reason: "aborted" }
    expect(proxy.triggerStop()).toBe(true);

    // Wait for replacement to be launched (proxy.abort.completed means we passed through Capturing)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"), 500);

    // Push replacement events
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "Answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Consumer must see: primary thinking events + replacement text + done
    // The aborted error event must NOT be forwarded downstream
    const types = seen.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("done");

    // Exactly one terminal (the replacement's done — NOT the abort error)
    const terminals = types.filter((t) => t === "done" || t === "error");
    expect(terminals).toEqual(["done"]);

    // Authority must have flipped to splicing
    expect(proxy.authority).toBe("splicing");

    // Controller must have reached Idle
    await waitFor(() => controller.getState() === "Idle", 500);
  });

  test("privacy guard: abort diagnostics log only allow-listed fields", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();

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
      15, // replacementStartupTimeoutMs — small so orphaned replacement fails fast
    );

    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    proxy.triggerStop();
    // Wait for clean-abort trace (FSM continues past Capturing → Restarting)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));

    // Filter abort-related diagnostic events
    const abortEvents = events.filter((c) => c.event.startsWith("proxy.abort."));
    const ALLOWED_KEYS = new Set([
      "timeoutMs", "error",
      // empty-object events are fine (proxy.abort.completed has {})
    ]);

    for (const captured of abortEvents) {
      if (!captured.fields) continue;
      for (const key of Object.keys(captured.fields)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }
  });
});
