/**
 * # Invariant Harness — shared test engine for property/stress/chaos/regression suites.
 *
 * **Responsibility**: deterministic PRNG, generalized two-phase upstream mock, scenario generator,
 * output collector, invariant counter/asserter, and shared test doubles. Consumed by the four test files
 * (property-tests, stress-tests, chaos-tests, regression-tests) — NOT a *.test.ts (bun won't run it).
 *
 * INV→assertion table (Appendix O):
 *   INV-001: exactly one downstream stream (drained to completion)
 *   INV-002: exactly one `start` event
 *   INV-003: exactly one terminal (done|error) + output.result() resolves
 *   INV-004: at most one interruption (≤1 triggerStop true + ≤1 first-event trace)
 *   INV-005: authority transfer is irreversible (forwarding→splicing, never reverts)
 *   INV-010: cleanup runs exactly once (proxy.lifecycle.cleanup trace === 1)
 */

import { StreamProxy } from "../../src/provider/proxy";
import { TransitionController } from "../../src/state/controller";
import { TransitionCoordinator } from "../../src/state/coordinator";
import { ReasoningBuffer } from "../../src/buffer";
import { DEFAULT_CONFIG } from "../../src/config";
import { isTerminalEvent } from "../../src/types";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../../src/diagnostics";
import type { TransitionState, ProxyPhase } from "../../src/types";

// ─── Types ───────────────────────────────────────────────────────────────

export interface Scenario {
  seed: number;
  interrupt: boolean;
  thinkingDeltasBeforeStop: number; // 1..8 (≥1 so the proxy reaches Reasoning)
  replacementTextDeltas: number;    // 1..5 (replacement answer length)
  injectError: boolean;
  errorPhase: "primary" | "replacement";
  errorAs: "throw" | "event";
  errorAtIndex: number;             // index within the phase's events
}

export interface InvariantReport {
  downstreamDrained: boolean;        // INV-001
  startCount: number;                // INV-002
  terminalCount: number;             // INV-003
  resultResolved: boolean;           // INV-003
  interruptionCount: number;        // INV-004
  finalAuthority: ProxyPhase;       // INV-005
  cleanupCount: number;             // INV-010
  finalState: TransitionState;      // may be non-Idle on no-interruption path
}

export interface ErrorInject {
  phase: "primary" | "replacement";
  atIndex: number;
  as: "throw" | "event";
}

// ─── Seeded PRNG ─────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) — every seed produces the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] (inclusive). */
export const ri = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

/** Random pick from array. */
export const pick = <T>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)];

// ─── Shared doubles ─────────────────────────────────────────────────────

type Level = "trace" | "debug" | "info" | "warn" | "error";
export interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call. */
export function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
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
export function makeModel() {
  return {
    id: "glm-4.7",
    api: "openai-completions",
    provider: "zai",
    reasoning: true,
  } as unknown as Parameters<typeof StreamProxy>[0];
}

/** Build a synthetic AssistantMessageEvent carrying only what each case needs. */
export function ev(
  partial: { type: string } & Partial<AssistantMessageEvent>,
): AssistantMessageEvent {
  return { ...partial } as unknown as AssistantMessageEvent;
}

export const DONE_MESSAGE = {
  role: "assistant",
  content: [],
  model: "glm-4.7",
} as unknown as AssistantMessage;
export const ERROR_MESSAGE = {
  role: "assistant",
  content: [],
  model: "glm-4.7",
} as unknown as AssistantMessage;

/** Polling helper: wait until `pred()` returns true (or timeout). */
export async function waitFor(
  pred: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

// ─── Generalized two-phase upstream mock ────────────────────────────────

export interface TwoPhaseMock {
  fn: ApiStreamSimpleFunction;
  calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[];
  pushPrimary: (e: AssistantMessageEvent) => void;
  pushReplacement: (e: AssistantMessageEvent) => void;
  closePrimary: () => void;
}

/**
 * Generalized two-phase upstream mock.
 * 1st call → primary (throws on signal abort); 2nd call → replacement (records options, fresh signal).
 * Optional errorInject: throws or pushes an error event at the given index within each phase.
 */
export function makeScriptedTwoPhaseUpstream(
  harnessOpts: { errorInject?: ErrorInject } = {},
): TwoPhaseMock {
  const errorInject = harnessOpts.errorInject;
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = [];
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];
  let callCount = 0;
  let primaryStopped = false;
  let primaryIndex = 0;
  let replacementIndex = 0;

  const fn = (
    (_m: unknown,
     _c: unknown,
     streamOpts?: { signal?: AbortSignal; reasoning?: unknown },
    ) => {
      callCount++;
      if (callCount === 1) {
        primarySignal = streamOpts?.signal;
        return {
          async *[Symbol.asyncIterator]() {
            while (true) {
              // Drain queued events first (with error-injection interception)
              if (primaryQueue.length) {
                if (
                  errorInject &&
                  errorInject.phase === "primary" &&
                  primaryIndex === errorInject.atIndex
                ) {
                  primaryIndex++;
                  primaryQueue.shift(); // consume & discard
                  if (errorInject.as === "throw") {
                    throw new Error("injected-primary-error");
                  }
                  yield ev({
                    type: "error",
                    reason: "error",
                    error: ERROR_MESSAGE,
                  });
                  primaryStopped = true;
                  return;
                }
                const event = primaryQueue.shift()!;
                primaryIndex++;
                yield event;
                continue;
              }
              // Queue empty — error injection at this index (no event to consume)
              if (
                errorInject &&
                errorInject.phase === "primary" &&
                primaryIndex === errorInject.atIndex
              ) {
                primaryIndex++;
                if (errorInject.as === "throw") {
                  throw new Error("injected-primary-error");
                }
                yield ev({
                  type: "error",
                  reason: "error",
                  error: ERROR_MESSAGE,
                });
                primaryStopped = true;
                return;
              }
              if (primaryStopped) return;
              if (primarySignal?.aborted) throw new Error("aborted");
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, 0);
                primarySignal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(t);
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              });
            }
          },
        };
      }
      // 2nd call = REPLACEMENT
      calls.push({
        options: streamOpts as
          | { reasoning?: unknown; signal?: AbortSignal }
          | undefined,
      });
      replacementSignal = streamOpts?.signal;

      // Synchronous throw at index 0 for replacement
      if (
        errorInject &&
        errorInject.phase === "replacement" &&
        errorInject.as === "throw" &&
        errorInject.atIndex === 0
      ) {
        throw new Error("injected-replacement-error");
      }

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            // Drain queued events first (with error-injection interception)
            if (replacementQueue.length) {
              if (
                errorInject &&
                errorInject.phase === "replacement" &&
                replacementIndex === errorInject.atIndex
              ) {
                replacementIndex++;
                replacementQueue.shift(); // consume & discard
                if (errorInject.as === "throw") {
                  throw new Error("injected-replacement-error");
                }
                yield ev({
                  type: "error",
                  reason: "error",
                  error: ERROR_MESSAGE,
                });
                return;
              }
              const event = replacementQueue.shift()!;
              replacementIndex++;
              yield event;
              continue;
            }
            // Queue empty — error injection at this index
            if (
              errorInject &&
              errorInject.phase === "replacement" &&
              replacementIndex === errorInject.atIndex
            ) {
              replacementIndex++;
              if (errorInject.as === "throw") {
                throw new Error("injected-replacement-error");
              }
              yield ev({
                type: "error",
                reason: "error",
                error: ERROR_MESSAGE,
              });
              return;
            }
            if (replacementSignal?.aborted) throw new Error("aborted");
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 0);
              replacementSignal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            });
          }
        },
      };
    },
  ) as unknown as ApiStreamSimpleFunction;

  return {
    fn: fn as ApiStreamSimpleFunction,
    calls,
    pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e),
    pushReplacement: (e: AssistantMessageEvent) => replacementQueue.push(e),
    closePrimary: () => {
      primaryStopped = true;
    },
  };
}

// ─── Scenario generation ───────────────────────────────────────────────

/** Generate a deterministic scenario from the seeded PRNG. */
export function genScenario(
  rng: () => number,
  opts: { interrupt?: boolean; chaos?: boolean } = {},
): Scenario {
  const interrupt = opts.interrupt ?? pick(rng, [true, false]);
  return {
    seed: 0,
    interrupt,
    thinkingDeltasBeforeStop: ri(rng, 1, 8),
    replacementTextDeltas: ri(rng, 1, 5),
    injectError: opts.chaos ? pick(rng, [true, false]) : false,
    errorPhase: pick(rng, ["primary", "replacement"]),
    errorAs: pick(rng, ["throw", "event"]),
    errorAtIndex: ri(rng, 0, 6),
  };
}

// ─── Output collection + invariant counting ─────────────────────────────

/**
 * Drain proxy.output via for-await, returning the collected events.
 * Also races output.result() with a timeout to prove it resolves (INV-003).
 */
export async function collectOutput(
  proxy: StreamProxy,
): Promise<AssistantMessageEvent[]> {
  const collected: AssistantMessageEvent[] = [];
  // Race output.result() with a timeout to prove it resolves
  const resultPromise = Promise.race([
    proxy.output.result(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("output.result() did not resolve")),
        3000,
      ),
    ),
  ]);
  // Drain output
  for await (const e of proxy.output) collected.push(e);
  await resultPromise; // must resolve (INV-003)
  return collected;
}

/** Count invariants from drained events, diagnostics events, and proxy state. */
export function countInvariants(
  collected: AssistantMessageEvent[],
  diagEvents: Captured[],
  proxy: StreamProxy,
  accepted: { acceptedCount: number },
): InvariantReport {
  return {
    downstreamDrained: true,
    startCount: collected.filter((e) => e.type === "start").length,
    terminalCount: collected.filter(isTerminalEvent).length,
    resultResolved: true,
    interruptionCount:
      Math.max(
        accepted.acceptedCount,
        diagEvents.filter(
          (c) => c.event === "proxy.replacement.first-event",
        ).length,
      ),
    finalAuthority: proxy.authority,
    cleanupCount: diagEvents.filter(
      (c) => c.event === "proxy.lifecycle.cleanup",
    ).length,
    finalState: proxy.controller.getState(),
  };
}

/**
 * Assert all invariants from a report.
 * `requireIdle`: set to false for no-interruption cases where FSM stays in Reasoning/Delegating
 * (§16 has no normal-completion exit).
 */
export function assertInvariants(
  r: InvariantReport,
  o: { allowInterruption: boolean; requireIdle?: boolean },
): void {
  expect(r.downstreamDrained).toBe(true); // INV-001
  expect(r.startCount).toBe(1); // INV-002
  expect(r.terminalCount).toBe(1); // INV-003
  expect(r.resultResolved).toBe(true); // INV-003
  if (o.allowInterruption) {
    expect(r.interruptionCount).toBeLessThanOrEqual(1); // INV-004
  } else {
    expect(r.interruptionCount).toBe(0);
  }
  expect(
    r.finalAuthority === "forwarding" || r.finalAuthority === "splicing",
  ).toBe(true); // INV-005
  expect(r.cleanupCount).toBe(1); // INV-010
  if (o.requireIdle !== false) {
    expect(r.finalState).toBe("Idle");
  }
}

// ─── Proxy builder ─────────────────────────────────────────────────────

export interface ProxyHarnessOpts {
  coordinator?: TransitionCoordinator;
  bufferBytes?: number;
  abortTimeoutMs?: number;
  replacementStartupTimeoutMs?: number;
}

/** Construct a StreamProxy with injectable small timeouts for fast test cycles. */
export function buildProxy(
  mock: TwoPhaseMock,
  opts: ProxyHarnessOpts = {},
): {
  proxy: StreamProxy;
  diag: Diagnostics;
  events: Captured[];
  controller: TransitionController;
  buffer: ReasoningBuffer;
} {
  const { diag, events } = makeCaptureDiag();
  const controller = new TransitionController(diag);
  const buffer = new ReasoningBuffer(diag, opts.bufferBytes ?? 1_000_000);
  const proxy = new StreamProxy(
    makeModel(),
    {} as never,
    {} as never,
    mock.fn,
    diag,
    controller,
    buffer,
    opts.abortTimeoutMs ?? DEFAULT_CONFIG.transitionTimeoutMs,
    undefined,
    opts.replacementStartupTimeoutMs ?? 2000,
    opts.coordinator,
  );
  return { proxy, diag, events, controller, buffer };
}

// ─── Privacy asserter ──────────────────────────────────────────────────

const ALLOWED_KEYS = new Set([
  "timeoutMs", "error", "type", "reason", "from", "to", "accepted",
  "entries", "totalBytes", "maximumBytes", "provider", "model",
]);

/** Assert all diagnostic events with the given prefix use only allow-listed fields. */
export function assertPrivacy(
  events: Captured[],
  prefix: string,
): void {
  const relevant = events.filter((c) => c.event.startsWith(prefix));
  for (const captured of relevant) {
    if (!captured.fields) continue;
    for (const key of Object.keys(captured.fields)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  }
}
