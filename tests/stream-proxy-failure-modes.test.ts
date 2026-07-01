/**
 * Provider failure-mode lock-in tests (PRD §54 Recovery Hierarchy).
 *
 * One test per FM-006…FM-015. Each test drives the proxy to the relevant state,
 * injects the failure via a controlled mock, awaits the outcome, and asserts:
 *   - The correct recovery behavior (terminal forwarded / error synthesized / etc.)
 *   - The FSM ends in Idle
 *   - Cleanup traces: coordinator.clear-active + proxy.lifecycle.cleanup (PRD §54)
 *   - Privacy: diagnostics log only allow-listed fields
 *
 * Consumes: StreamProxy (src/provider/proxy.ts), TransitionController (src/state/controller.ts),
 * TransitionCoordinator (src/state/coordinator.ts), ReasoningBuffer (src/buffer).
 */

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

// --- test doubles (verbatim from stream-proxy-replacement.test.ts) ----------

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

/** Minimal Model stand-in — only .id/.api/.provider are read. */
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

// --- mock helpers ----------------------------------------------------------

/**
 * Single-phase upstream mock that IGNORES the abort signal and yields from a queue.
 * Used for FM-006: provider ignores abort → timeout fires → original stream preserved.
 * Call close() to terminate the iterator (so run() can exit naturally).
 */
function makeIgnoreAbortUpstream() {
  const queue: AssistantMessageEvent[] = [];
  let stopped = false;
  const state = { calls: 0 };
  const fn = ((_m: unknown, _c: unknown, _opts?: unknown) => {
    state.calls++;
    return {
      async *[Symbol.asyncIterator]() {
        while (!stopped) {
          if (queue.length > 0) { yield queue.shift()!; continue; }
          // Poll — don't observe the signal (FM-006: provider ignores abort).
          await new Promise<void>(r => setTimeout(r, 1));
        }
      },
    };
  }) as unknown as ApiStreamSimpleFunction;
  return {
    fn,
    push: (e: AssistantMessageEvent) => queue.push(e),
    close: () => { stopped = true; },
    state,
  };
}

/**
 * Configurable two-phase upstream mock. Primary phase yields from a queue and throws on abort
 * (standard behavior). Replacement phase is configurable via the factory function.
 * Call closePrimary() to end the primary iterator (for tests that don't abort the primary).
 */
function makeTwoPhaseUpstream(
  replacementFactory?: (signal?: AbortSignal) => AsyncIterable<AssistantMessageEvent>,
) {
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = [];
  let primarySignal: AbortSignal | undefined;
  let primaryStopped = false;
  const primaryQueue: AssistantMessageEvent[] = [];
  let callCount = 0;
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    callCount++;
    if (callCount === 1) {
      primarySignal = opts?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          while (!primaryStopped) {
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
    if (replacementFactory) return replacementFactory(opts?.signal);
    // Default: block until the replacement abort signal fires (startup timeout aborts it).
    const replSignal = opts?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        if (replSignal?.aborted) throw new Error("aborted");
        await new Promise<void>((_resolve, reject) => {
          replSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
  }) as unknown as ApiStreamSimpleFunction;
  return { fn, calls, pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e), closePrimary: () => { primaryStopped = true; } };
}

/**
 * Helper to create an async iterable that yields the given events then ends.
 * Used for replacement phases that need specific event sequences.
 */
function asyncIterableFrom(events: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}

// --- privacy assertion helper ----------------------------------------------

const ALLOWED_KEYS = new Set([
  "timeoutMs", "error", "type", "reason", "from", "to", "accepted",
  // empty-object events (fields={}) are always fine
]);

function assertPrivacy(events: Captured[], prefix: string): void {
  const relevant = events.filter(c => c.event.startsWith(prefix));
  for (const captured of relevant) {
    if (!captured.fields) continue;
    for (const key of Object.keys(captured.fields)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  }
}

// --- FM-006…FM-015 lock-in tests ------------------------------------------

describe("Provider failure modes — recovery hierarchy lock-in (FM-006…FM-015)", () => {

  // ─── FM-006: abort ignored → timeout→Failed; original stream preserved ───

  test("FM-006: abort ignored → timeout→Failed; original stream preserved; cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeIgnoreAbortUpstream();

    // Queue pre-abort events
    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "pre-abort thinking" }));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      20, // tiny abortTimeoutMs
      undefined, // requestBuilder
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    // Drain consumer concurrently
    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning
    await waitFor(() => proxy.isReasoning());

    // Dispatch abort — mock ignores it
    expect(proxy.triggerStop()).toBe(true);

    // Wait for FM-006 timeout → Aborting → Failed
    await waitFor(() => controller.getState() === "Failed", 200);
    expect(events.some(c => c.event === "proxy.abort.timeout")).toBe(true);

    // Push post-timeout events (original stream preserved — FM-006 L2)
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "post-timeout" }));
    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));

    // Wait for consumer to drain the done terminal
    await waitFor(() => seen.some(e => e.type === "done"), 200);

    // Post-timeout events reached consumer (original stream preserved)
    const types = seen.map(e => e.type);
    expect(types).toContain("thinking_delta"); // post-timeout delta
    expect(types).toContain("done");

    // Exactly one terminal
    const terminals = types.filter(t => t === "done" || t === "error");
    expect(terminals).toHaveLength(1);

    // Replacement was NOT launched (fn called only once — primary)
    expect(mock.state.calls).toBe(1);

    // Release the mock so run() exits → _terminate(true) → cleanup
    mock.close();
    await waitFor(() => events.some(c => c.event === "proxy.lifecycle.cleanup"), 200);

    // Cleanup traces (PRD §54)
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);

    // Final state Idle
    await waitFor(() => controller.getState() === "Idle", 200);

    await consumer;
  });

  // ─── FM-007: replacement rejected before first event ─────────────────────

  test("FM-007: replacement throws synchronously before first event → synthesized error + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeTwoPhaseUpstream((_signal) => {
      throw new Error("429 Too Many Requests");
    });

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

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

    // Wait for replacement failure → synthesized error
    await consumer;

    // Consumer sees exactly one error terminal (synthesized from the thrown message)
    const terminals = seen.filter(e => e.type === "error");
    expect(terminals).toHaveLength(1);
    expect((terminals[0] as { error?: AssistantMessage }).error?.errorMessage).toBe("429 Too Many Requests");

    // proxy.replacement.failed warn
    expect(events.some(c => c.event === "proxy.replacement.failed")).toBe(true);

    // Cleanup (PRD §54)
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);

    // FSM ends Idle
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-008: replacement auth failure (401) ────────────────────────────

  test("FM-008: replacement auth failure (401) → provider error forwarded + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeTwoPhaseUpstream((_signal) => {
      throw new Error("401 Unauthorized — auth expired");
    });

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

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

    await consumer;

    // Consumer sees one error terminal carrying the auth error
    const terminals = seen.filter(e => e.type === "error");
    expect(terminals).toHaveLength(1);
    expect((terminals[0] as { error?: AssistantMessage }).error?.errorMessage).toBe("401 Unauthorized — auth expired");

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-009: primary error-event (delegated / forwarded) ────────────────

  test("FM-009: primary error-event → forwarded + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeTwoPhaseUpstream(); // replacement never launched

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    // Primary yields an error event (not a throw — the throw path is covered in stream-proxy.test.ts)
    mock.pushPrimary(ev({ type: "error", error: ERROR_MESSAGE }));

    // Wait for consumer to drain (error terminal completes output)
    await waitFor(() => seen.some(e => e.type === "error"), 200);

    // Consumer sees exactly one error terminal
    const terminals = seen.filter(e => e.type === "error");
    expect(terminals).toHaveLength(1);

    // Close primary so run() can exit → _terminate → cleanup
    mock.closePrimary();
    await waitFor(() => events.some(c => c.event === "proxy.lifecycle.cleanup"), 200);

    // Cleanup (PRD §54)
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);

    // FSM Idle
    await waitFor(() => controller.getState() === "Idle", 200);

    await consumer;
  });

  // ─── FM-010: replacement throws mid-stream ──────────────────────────────

  test("FM-010: replacement yields one event then throws → text + synthesized error + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    const mock = makeTwoPhaseUpstream((_signal) => ({
      async *[Symbol.asyncIterator]() {
        yield ev({ type: "text_start", contentIndex: 0 });
        yield ev({ type: "text_delta", contentIndex: 0, delta: "partial" });
        throw new Error("connection reset by peer");
      },
    }));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for replacement failure
    await consumer;

    // Consumer sees the text events + exactly one synthesized error terminal
    const types = seen.map(e => e.type);
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    const terminals = types.filter(t => t === "error");
    expect(terminals).toHaveLength(1);
    expect((seen.find(e => e.type === "error") as { error?: AssistantMessage }).error?.errorMessage).toBe("connection reset by peer");

    // proxy.replacement.failed warn
    expect(events.some(c => c.event === "proxy.replacement.failed")).toBe(true);

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-011: replacement immediate/empty done ───────────────────────────

  test("FM-011: replacement yields only done (immediate completion) → forwarded; FSM Idle; cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    const mock = makeTwoPhaseUpstream((_signal) => asyncIterableFrom([
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for completion
    await consumer;

    // Consumer sees the done terminal (forwarded)
    const terminals = seen.filter(e => e.type === "done");
    expect(terminals).toHaveLength(1);

    // NO failure (replacement succeeded — it's a valid immediate completion)
    expect(events.some(c => c.event === "proxy.replacement.failed")).toBe(false);

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-012: replacement never starts → startup timeout ─────────────────

  test("FM-012: replacement never yields → startup timeout → error terminal + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    // Default replacement blocks forever → startup timeout fires
    const mock = makeTwoPhaseUpstream();

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      15, // tiny replacementStartupTimeoutMs → timeout fires quickly
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

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

    // Wait for startup timeout + synthesized error
    await waitFor(() => events.some(c => c.event === "proxy.replacement.startup-timeout"), 200);
    await consumer;

    // proxy.replacement.startup-timeout warn
    expect(events.some(c => c.event === "proxy.replacement.startup-timeout")).toBe(true);

    // Consumer sees exactly one error terminal (synthesized by the catch)
    const terminals = seen.filter(e => e.type === "error");
    expect(terminals).toHaveLength(1);

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-013 (terminal): malformed done / error ──────────────────────────

  test("FM-013 (terminal): malformed done without message → synthesized error + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    // Replacement yields a malformed done (no message) — FM-013 terminal
    const mock = makeTwoPhaseUpstream((_signal) => asyncIterableFrom([
      ev({ type: "done" }), // malformed: no `message`
    ]));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for consumer to drain
    await consumer;

    // proxy.event.malformed warn with {type: "done"}
    const malformed = events.find(c => c.event === "proxy.event.malformed");
    expect(malformed).toBeDefined();
    expect(malformed?.fields?.type).toBe("done");

    // Consumer sees exactly one SYNTHESIZED error terminal (NOT the malformed done)
    const terminals = seen.filter(e => e.type === "error");
    expect(terminals).toHaveLength(1);
    // The malformed done must NOT reach the consumer
    expect(seen.some(e => e.type === "done")).toBe(false);
    expect((terminals[0] as { error?: AssistantMessage }).error?.errorMessage).toBe("malformed terminal event");

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  test("FM-013 (terminal): malformed error without error field → synthesized error + cleanup", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    // Replacement yields a malformed error (no error field)
    const mock = makeTwoPhaseUpstream((_signal) => asyncIterableFrom([
      ev({ type: "error" }), // malformed: no `error` field
    ]));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await consumer;

    // proxy.event.malformed warn with {type: "error"}
    const malformed = events.find(c => c.event === "proxy.event.malformed");
    expect(malformed).toBeDefined();
    expect(malformed?.fields?.type).toBe("error");

    // Consumer sees one synthesized error terminal (the malformed error is replaced)
    const terminals = seen.filter(e => e.type === "error");
    expect(terminals).toHaveLength(1);

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-013 (non-terminal): malformed delta → warn + forward best-effort ─

  test("FM-013 (non-terminal): malformed text_delta without delta → warn + forward best-effort", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never,
      // Single-phase mock: primary yields events, then we close it
      ((_m: unknown, _c: unknown, _opts?: unknown) => {
        const queue: AssistantMessageEvent[] = [
          ev({ type: "start" }),
          ev({ type: "text_start", contentIndex: 0 }),
          ev({ type: "text_delta", contentIndex: 0 }), // malformed: no delta
          ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
        ];
        let idx = 0;
        return {
          async *[Symbol.asyncIterator]() { while (idx < queue.length) yield queue[idx++]; },
        };
      }) as unknown as ApiStreamSimpleFunction,
      diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined, DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    await consumer;

    // proxy.event.malformed warn
    const malformed = events.find(c => c.event === "proxy.event.malformed");
    expect(malformed).toBeDefined();
    expect(malformed?.fields?.type).toBe("text_delta");

    // The malformed non-terminal was forwarded best-effort (recoverable per EC-020)
    expect(seen.some(e => e.type === "text_delta")).toBe(true);

    // Stream continued normally to a done terminal
    expect(seen.some(e => e.type === "done")).toBe(true);

    // Cleanup (PRD §54 — coordinator cleared + lifecycle cleanup trace emitted)
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    // NOTE: on the non-interrupted path, the FSM stays in its pre-terminal state (§16 has no
    // normal-completion exit from Reasoning). The cleanup still ran; we verify via the traces above.
  });

  // ─── FM-014: duplicate completion suppressed ──────────────────────────────

  test("FM-014: replacement yields done then another done → exactly one terminal + duplicate trace", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    const mock = makeTwoPhaseUpstream((_signal) => asyncIterableFrom([
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }), // duplicate
    ]));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await consumer;

    // Exactly one done terminal
    const terminals = seen.filter(e => e.type === "done");
    expect(terminals).toHaveLength(1);

    // proxy.splice.duplicate-terminal trace for the suppressed duplicate
    expect(events.some(c => c.event === "proxy.splice.duplicate-terminal")).toBe(true);

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── FM-015: stray non-terminal after completion discarded with trace ─────

  test("FM-015: replacement yields done then stray text_delta → discarded with trace", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    const mock = makeTwoPhaseUpstream((_signal) => asyncIterableFrom([
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      ev({ type: "text_delta", contentIndex: 0, delta: "stray" }), // stray after completion
    ]));

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    // Drive to Reasoning → abort → replacement
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await consumer;

    // Exactly one terminal (the done)
    const terminals = seen.filter(e => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);

    // The stray text_delta was discarded — NOT in consumer
    const strayDeltas = seen.filter(e => e.type === "text_delta" && (e as { delta?: string }).delta === "stray");
    expect(strayDeltas).toHaveLength(0);

    // proxy.splice.discard-after-completion trace for the stray
    expect(events.some(c => c.event === "proxy.splice.discard-after-completion")).toBe(true);

    // Cleanup
    expect(events.some(c => c.event === "coordinator.clear-active")).toBe(true);
    expect(events.some(c => c.event === "proxy.lifecycle.cleanup")).toBe(true);
    await waitFor(() => controller.getState() === "Idle", 200);
  });

  // ─── PRIVACY guard: all diagnostics log only allow-listed fields ─────────

  test("PRIVACY guard: all proxy.*/coordinator.*/transition.* diagnostics log only safe fields", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);

    // Use FM-012 (startup timeout) to exercise multiple diagnostic events quickly
    const mock = makeTwoPhaseUpstream();

    const coordinator = new TransitionCoordinator(diag);
    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag,
      controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs,
      undefined,
      15, // tiny timeout
      coordinator,
    );
    coordinator.setActiveProxy(proxy);

    const seen: AssistantMessageEvent[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push(e);
    })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Wait for the full flow to complete
    await waitFor(() => events.some(c => c.event === "proxy.lifecycle.cleanup"), 500);
    await consumer;

    // Assert ALL captured diagnostics (proxy.*, coordinator.*, transition.*) use only safe fields
    assertPrivacy(events, "proxy.");
    assertPrivacy(events, "coordinator.");
    assertPrivacy(events, "transition.");
  });

});
