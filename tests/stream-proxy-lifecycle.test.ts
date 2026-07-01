import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { TransitionCoordinator } from "../src/state/coordinator";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles (verbatim from stream-proxy-replacement.test.ts + stream-proxy-abort.test.ts) -------

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
 * Two-phase upstream mock: 1st call → PRIMARY iterable (yields thinking, throws on its signal abort);
 * 2nd call → REPLACEMENT iterable (records its options, yields replacement events, throws on its signal
 * abort). Separate queues + signals. Extended with `endReplacement()` for EC-018 testing.
 */
function makeReplacementUpstream() {
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = [];
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];
  let primaryDone = false;
  let replacementDone = false;
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
            if (primaryDone) return; // cleanly end the iterator
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
          if (replacementDone) return; // cleanly end the iterator (EC-018)
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
    endPrimary: () => { primaryDone = true; },
    endReplacement: () => { replacementDone = true; },
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

// --- lifecycle tests -----------------------------------------------------------

describe("StreamProxy — end-to-end transition lifecycle (P1.M7.T3.S1)", () => {

  // ── Case 1: Full success lifecycle (PRD §7 Story 1 + §48) ─────────────────────

  test("full success lifecycle: one start + one terminal + FSM→Idle + cleanup + coordinator cleared", async () => {
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
      undefined, // requestBuilder
      2000,      // replacementStartupTimeoutMs
      coordinator, // 11th arg — P1.M7.T3.S1
    );
    coordinator.setActiveProxy(proxy); // simulate decorator wiring

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

    // Dispatch abort → replacement launched
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement: start (suppressed) + text + done
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    // Drain consumer
    await consumer;

    // Exactly one start and one terminal
    const types = seen.map((e) => e.type);
    const starts = types.filter((t) => t === "start");
    const terminals = types.filter((t) => t === "done" || t === "error");
    expect(starts).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toBe("done");

    // output.result() resolves to DONE_MESSAGE
    const result = await proxy.output.result();
    expect(result).toBe(DONE_MESSAGE);

    // FSM → Idle (Splicing→Answering→Completed→Idle)
    expect(controller.getState()).toBe("Idle");

    // proxy.replacement.first-event + proxy.lifecycle.cleanup traced
    expect(events.some((c) => c.event === "proxy.replacement.first-event")).toBe(true);
    expect(events.some((c) => c.event === "proxy.lifecycle.cleanup")).toBe(true);

    // Coordinator cleared
    expect(events.some((c) => c.event === "coordinator.clear-active")).toBe(true);

    // Buffer reset after completion
    expect(buffer.snapshot().length).toBe(0);
  });

  // ── Case 2: beginAnswering fires on the first answer token ──────────────────

  test("beginAnswering fires on first answer token (text_*) → FSM passes through Answering", async () => {
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
    const consumer = (async () => {
      for await (const _e of proxy.output) { /* drain */ }
    })();

    // Drive primary to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push first replacement answer token (text_start) → beginAnswering should fire
    mock.pushReplacement(ev({ type: "start" })); // suppressed
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    await waitFor(() => controller.getState() === "Answering", 500);

    // Now push done → complete the lifecycle
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await waitFor(() => controller.getState() === "Idle", 500);

    await consumer;
  });

  // ── Case 3: Failure lifecycle (replacement error event) ────────────────────

  test("failure lifecycle: replacement error → fail→Idle + cleanup + coordinator cleared", async () => {
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
    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive primary to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement text then error terminal
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "partial" }));
    mock.pushReplacement(ev({ type: "error", reason: "error", error: { role: "assistant", content: [], model: "x" } as never }));

    await consumer;

    // FSM → Idle (fail→Idle)
    expect(controller.getState()).toBe("Idle");

    // transition.failed traced with reason "replacement-error"
    expect(events.some((c) => c.event === "transition.failed" && c.fields?.reason === "replacement-error")).toBe(true);

    // Cleanup traced + coordinator cleared
    expect(events.some((c) => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    expect(events.some((c) => c.event === "coordinator.clear-active")).toBe(true);

    // Exactly one terminal (error) reached the consumer
    const terminals = seen.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("error");

    // output.result() resolves (to the error message)
    const result = await proxy.output.result();
    expect(result).toBeDefined();
  });

  // ── Case 4: EC-018 empty replacement (clean return without a terminal) ──────

  test("EC-018: replacement ends without terminal → synthesized error + cleanup", async () => {
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
    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive primary to Reasoning → abort
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Push replacement start (suppressed, triggers firstSeen + Splicing)
    mock.pushReplacement(ev({ type: "start" }));
    await waitFor(() => controller.getState() === "Splicing", 500);

    // Push non-terminal text (triggers beginAnswering → Answering)
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "partial" }));

    // End the replacement cleanly (no terminal) → EC-018 guard fires
    mock.endReplacement();

    // Wait for the synthesized error terminal + cleanup
    await waitFor(() => events.some((c) => c.event === "proxy.lifecycle.cleanup"), 1000);

    await consumer;

    // Exactly one synthesized error terminal reached the consumer
    const terminals = seen.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("error");

    // output.result() resolves
    const result = await proxy.output.result();
    expect(result).toBeDefined();

    // FSM is Idle
    expect(controller.getState()).toBe("Idle");

    // Cleanup traced
    expect(events.some((c) => c.event === "proxy.lifecycle.cleanup")).toBe(true);
  });

  // ── Case 5: Normal non-interrupted path still cleans up ─────────────────────

  test("normal non-interrupted path: FSM left in Reasoning but resources released", async () => {
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
      for await (const e of proxy.output) seen.push(e.type);
    })();

    // Do NOT triggerStop — push a complete primary stream then end the primary
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    mock.endPrimary(); // let the primary iterator exit cleanly → for-await loop exits → _terminate fires

    await consumer;

    // Wait for _terminate to fire (fires after the for-await loop exits, which is after consumer completes)
    await waitFor(() => events.some((c) => c.event === "proxy.lifecycle.cleanup"), 500);

    // FSM is left in Reasoning (no §16 normal exit)
    expect(controller.getState()).toBe("Reasoning");

    // BUT resources are released
    expect(events.some((c) => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    expect(events.some((c) => c.event === "coordinator.clear-active")).toBe(true);

    // Buffer preserved on normal path (no transition — reasoning intact for inspection)
    expect(buffer.snapshot().length).toBeGreaterThan(0);

    // Exactly one start + one done
    expect(seen.filter((t) => t === "start")).toHaveLength(1);
    const terminals = seen.filter((t) => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toBe("done");

    // No misleading transition.failed
    expect(events.filter((c) => c.event === "transition.failed")).toHaveLength(0);
  });

  // ── Case 6: Cleanup runs EXACTLY ONCE (INV-010) ────────────────────────────

  test("INV-010: cleanup runs exactly once despite duplicate terminal", async () => {
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
    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Full success cycle
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    // Push a DUPLICATE done (second terminal — should be dedup'd by _emit, _terminate no-op)
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Cleanup traced EXACTLY once
    expect(events.filter((c) => c.event === "proxy.lifecycle.cleanup")).toHaveLength(1);
    expect(events.filter((c) => c.event === "coordinator.clear-active")).toHaveLength(1);

    // Still exactly ONE terminal reached the consumer (the duplicate was dedup'd)
    const terminals = seen.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);
  });

  // ── Case 7: Abort-timeout → failure → cleanup (FM-006) ───────────────────

  test("FM-006: abort timeout → failure → cleanup + coordinator cleared + FSM Idle", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const coordinator = new TransitionCoordinator(diag);
    const mock = makeUnresponsiveUpstream();

    // Push events BEFORE constructing the proxy (unresponsive mock exhausts queue then blocks on gate)
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
      undefined,
      2000,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    // Wait for the upstream to yield events and reach Reasoning
    await waitFor(() => proxy.isReasoning());

    // Dispatch abort
    expect(proxy.triggerStop()).toBe(true);

    // Wait for the timeout to fire → Aborting → Failed
    await waitFor(() => controller.getState() === "Failed", 200);

    // Release the unresponsive upstream so run() exits (no dangling handle)
    mock.release();

    // Wait for _terminate(true) to fire after the loop exits → cleanup
    await waitFor(() => events.some((c) => c.event === "proxy.lifecycle.cleanup"), 1000);

    // Coordinator cleared
    expect(events.some((c) => c.event === "coordinator.clear-active")).toBe(true);

    // FSM is Idle (Failed → Idle via _terminate)
    expect(controller.getState()).toBe("Idle");
  });

  // ── Case 8: Privacy guard ───────────────────────────────────────────────────

  test("privacy guard: proxy.lifecycle.* and proxy.cleanup.* events log {} or {error} only", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const coordinator = new TransitionCoordinator(diag);
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
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    // Drain consumer concurrently
    const consumer = (async () => {
      for await (const _e of proxy.output) { /* drain */ }
    })();

    // Full success cycle
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(ev({ type: "start" }));
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    await consumer;

    // Filter proxy.lifecycle.* + proxy.cleanup.* events
    const lifecycleEvents = events.filter(
      (c) => c.event.startsWith("proxy.lifecycle.") || c.event.startsWith("proxy.cleanup."),
    );

    for (const captured of lifecycleEvents) {
      if (!captured.fields) continue;
      const keys = Object.keys(captured.fields);
      // Only allowed keys: "error" (for buffer-reset-failed) — never content/options/reasoning/prompt
      for (const key of keys) {
        expect(["error"]).toContain(key);
      }
    }

    // Also check coordinator events log {} only
    const coordEvents = events.filter((c) => c.event.startsWith("coordinator."));
    for (const captured of coordEvents) {
      expect(captured.fields).toEqual({});
    }
  });
});
