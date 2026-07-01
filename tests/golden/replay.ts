/**
 * # Golden Replay — harness for the Phase-1 inactive-baseline invariant.
 *
 * **Responsibility** (PRD §50 Phase-1 success criterion + §55.178): prove that a captured provider
 * event stream, replayed through the transparent `StreamProxy`, produces byte-for-byte identical
 * downstream output while the feature is INACTIVE (forward-only; no transition logic). In Phase 1 the
 * proxy is always inactive, so every replay is identical to its input by construction — this harness
 * locks that in as a regression guard for every later phase (P1.M4 detection, P1.M5 abort, P1.M7
 * splicing) that adds ACTIVE branches which must NOT leak into the inactive path.
 *
 * **Ownership**: pure test helpers + shared doubles. Owns NO production state. Mutates nothing.
 *
 * **Reuse** (consumed by future milestones): `replayEvents` + the fixtures in `./fixtures` are
 * imported by P1.M7 (full integration) and P1.M8 (stress — replays a fixture thousands of times).
 *
 * **Invariant**: every fixture replayed by `replayEvents` MUST end with a terminal event (`done` or
 * `error`). The proxy forwards the terminal to `proxy.output`, which completes the stream and lets the
 * consumer's `for await` exit naturally. A fixture without a terminal would hang the replay. (PRD §13.2
 * single-terminal/single-result guarantee; enforced by the fixture design in `./fixtures`.)
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StreamProxy } from "../../src/provider/proxy";
import type {
  ApiStreamSimpleFunction,
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../../src/diagnostics";

/** No-op Diagnostics stub (same shape as tests/stream-proxy.test.ts). The forward-only replay path
 *  never logs in the happy case; this stub absorbs the proxy's defensive-path calls if they fire. */
export const NOOP_DIAGNOSTICS: Diagnostics = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as Diagnostics;

/** Minimal typed stand-ins for the 3 positional StreamProxy ctor args that are NOT the upstream fn.
 *  Only model.id/.api/.provider are read (defensive path only, which never fires on these replays). */
export const GOLDEN_MODEL = {
  id: "glm-4.7",
  name: "GLM-4.7",
  api: "openai-completions",
  provider: "zai",
} as never;
export const GOLDEN_CONTEXT = { messages: [] } as never;
export const GOLDEN_OPTIONS = { temperature: 0.7 } as never;

/** Fixed timestamp so fixture messages are deterministic across runs (the forwarded event is the SAME
 *  object, but a fixed value is cleaner + clone-safe for future phases). */
const GOLDEN_TIMESTAMP = 1_700_000_000_000;

/**
 * Build a realistic, fully-populated {@link AssistantMessage} carried on a fixture event's
 * `partial` / `message` / `error` field. Usage/cost are zeroed (mirrors the proxy's own
 * makeErrorAssistantMessage shape); `over` lets callers override fields (e.g. stopReason:'error').
 */
export function partialAssistantMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "zai",
    model: "glm-4.7",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: GOLDEN_TIMESTAMP,
    ...over,
  } as AssistantMessage;
}

/**
 * Replay a captured event stream through the transparent {@link StreamProxy} and return the downstream
 * events. The Phase-1 proxy is forward-only, so the output is byte-for-byte identical to `events`
 * (proven by `toEqual` in golden-replay.test.ts).
 *
 * Steps (item contract):
 *  (a) build a mock {@link ApiStreamSimpleFunction} returning a REAL, PRE-FILLED
 *      `AssistantMessageEventStream` (every event pushed up front; the terminal push completes it);
 *  (b) construct `new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT, GOLDEN_OPTIONS, mockFn, NOOP_DIAGNOSTICS)`
 *      — exactly as the ProviderDecorator does in production (P1.M2.T3.S1);
 *  (c) fully iterate `proxy.output`, collecting every emitted event;
 *  (d) return the collected array.
 *
 * No `setTimeout` pump is needed: the proxy's fire-and-forget `run()` and the consumer's `for await`
 * interleave on the microtask queue (the consumer awaits while `proxy.output` is empty; `run()` pushes
 * → delivers to the waiter → consumer yields → re-awaits). The loop exits naturally once the terminal
 * event is forwarded and `proxy.output` completes.
 *
 * @param events A captured provider event stream. MUST end with a terminal (`done` or `error`).
 * @returns      The events as observed on `proxy.output` (byte-for-byte identical in Phase 1).
 */
export async function replayEvents(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]> {
  // (a) mock upstream: a fresh, fully-pre-filled real stream per call (reentrancy-safe for P1.M8 loops)
  const mockUpstreamFn: ApiStreamSimpleFunction = (() => {
    const stream = createAssistantMessageEventStream();
    for (const e of events) stream.push(e); // terminal push completes the stream in-place
    return stream;
  }) as ApiStreamSimpleFunction;

  // (b) construct the proxy exactly as production does
  const proxy = new StreamProxy(
    GOLDEN_MODEL,
    GOLDEN_CONTEXT,
    GOLDEN_OPTIONS,
    mockUpstreamFn,
    NOOP_DIAGNOSTICS,
  );

  // (c)+(d) drain proxy.output to natural completion
  const collected: AssistantMessageEvent[] = [];
  for await (const event of proxy.output) {
    collected.push(event);
  }
  return collected;
}
