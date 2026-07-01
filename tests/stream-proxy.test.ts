import { describe, test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StreamProxy } from "../src/provider/proxy";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles ---------------------------------------------------------

/** Reuse the exact noop Diagnostics stub style from provider-decorator.test.ts. */
const noopDiagnostics: Diagnostics = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as Diagnostics;

/** A minimal Model<Model["api"]> stand-in. Only .id/.api/.provider are read by the proxy. */
function makeModel() {
  return { id: "glm-4.7", api: "openai-completions", provider: "zai" } as unknown as Parameters<
    typeof StreamProxy
  >[0]; // model ctor param type
}

/** Build a synthetic AssistantMessageEvent carrying only what each case needs. */
function ev(partial: { type: string } & Partial<AssistantMessageEvent>): AssistantMessageEvent {
  return { ...partial } as unknown as AssistantMessageEvent;
}

const DONE_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;
const ERROR_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;

/**
 * Drive the proxy: concurrently iterate proxy.output into `seen`, push `events` into `mockUpstream`
 * (one per tick), then flush. Returns the drained events + the resolved result (if any).
 */
async function drive(
  mockUpstream: AssistantMessageEventStream,
  events: AssistantMessageEvent[],
): Promise<{ seen: string[]; result?: AssistantMessage }> {
  const proxy = new StreamProxy(
    makeModel(),
    {} as never,
    {} as never,
    () => mockUpstream,
    noopDiagnostics,
  );
  const seen: string[] = [];
  let result: AssistantMessage | undefined;
  const consumer = (async () => {
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    result = await proxy.output.result();
  })();
  // Push one event per macrotask so the async iterators interleave deterministically.
  for (const e of events) {
    mockUpstream.push(e);
    await new Promise((r) => setTimeout(r, 0));
  }
  await consumer;
  return { seen, result };
}

// --- forwarding + order ---------------------------------------------------

describe("StreamProxy — forward-only pipeline", () => {
  test("forwards a full legal event sequence unchanged and in order", async () => {
    const upstream = createAssistantMessageEventStream();
    const { seen } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
      ev({ type: "thinking_end", contentIndex: 0, content: "hm" }),
      ev({ type: "text_start", contentIndex: 1 }),
      ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
      ev({ type: "text_delta", contentIndex: 1, delta: "!" }),
      ev({ type: "text_end", contentIndex: 1, content: "Hi!" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]);
    expect(seen).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  test("preserves order across many deltas (no reordering, no drops)", async () => {
    const upstream = createAssistantMessageEventStream();
    const deltas = Array.from({ length: 50 }, (_, i) =>
      ev({ type: "text_delta", contentIndex: 0, delta: String(i) }),
    );
    const { seen } = await drive(upstream, [
      ev({ type: "start" }),
      ...deltas,
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]);
    expect(seen.length).toBe(52); // start + 50 deltas + done
    expect(seen[0]).toBe("start");
    expect(seen.at(-1)).toBe("done");
  });
});

// --- terminal forwarding + result() --------------------------------------

describe("StreamProxy — terminal forwarding", () => {
  test("forwards `done` and result() resolves to its carried message (no output.end needed)", async () => {
    const upstream = createAssistantMessageEventStream();
    const { result } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]);
    expect(result).toBe(DONE_MESSAGE); // identity preserved — same object the upstream carried
  });

  test("forwards `error` and result() resolves to its carried message", async () => {
    const upstream = createAssistantMessageEventStream();
    const { seen, result } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "error", reason: "error", error: ERROR_MESSAGE }),
    ]);
    expect(seen).toEqual(["start", "error"]);
    expect(result).toBe(ERROR_MESSAGE);
  });
});

// --- defensive error synthesis (single-terminal / no-hang invariant) ------

describe("StreamProxy — defensive error synthesis", () => {
  test("a throwing upstreamStreamFn still terminates output with exactly one error (no hang)", async () => {
    const boom = () => {
      throw new Error("upstream blew up");
    };
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      boom,
      noopDiagnostics,
    );
    const seen: string[] = [];
    let result: AssistantMessage | undefined;
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    result = await proxy.output.result();
    expect(seen).toEqual(["error"]); // exactly one terminal
    expect(result).toBeDefined(); // result() resolved → no hang
    expect(result!.stopReason).toBe("error");
    expect(result!.errorMessage).toBe("upstream blew up");
  });

  test("an upstream iterator that throws mid-stream terminates output with one error", async () => {
    async function* throwingIterator(): AsyncIterable<AssistantMessageEvent> {
      yield ev({ type: "start" });
      yield ev({ type: "thinking_delta", contentIndex: 0, delta: "x" });
      throw new Error("iterator exploded");
    }
    const throwingStream = {
      [Symbol.asyncIterator]: () => throwingIterator()[Symbol.asyncIterator](),
    } as unknown as AssistantMessageEventStream;
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => throwingStream,
      noopDiagnostics,
    );
    const seen: string[] = [];
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    expect(seen).toEqual(["start", "thinking_delta", "error"]); // forwarded-then-synthesized
    expect(await proxy.output.result()).toBeDefined();
  });
});

// --- observational equivalence -------------------------------------------

describe("StreamProxy — observational equivalence", () => {
  test("output stream IS a fresh AssistantMessageEventStream (not the upstream identity)", () => {
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => upstream,
      noopDiagnostics,
    );
    expect(proxy.output).not.toBe(upstream); // downstream never touches the upstream directly (§20.5)
  });
});
