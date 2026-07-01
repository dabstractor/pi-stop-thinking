import { describe, test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
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
 * Drive the proxy with INJECTED controller + buffer (test owns the refs so it can inspect state/buffer).
 * Returns the observed downstream event types.
 */
async function drive(
  mockUpstream: AssistantMessageEventStream,
  events: AssistantMessageEvent[],
  controller: TransitionController,
  buffer: ReasoningBuffer,
  diag: Diagnostics,
): Promise<{ seen: string[] }> {
  const proxy = new StreamProxy(
    makeModel(),
    {} as never,
    {} as never,
    () => mockUpstream,
    diag,
    controller,
    buffer,
  );
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
  })();
  for (const e of events) {
    mockUpstream.push(e);
    await new Promise((r) => setTimeout(r, 0));
  }
  await consumer;
  return { seen };
}

// --- detection tests -------------------------------------------------------

describe("StreamProxy — reasoning detection (P1.M4.T2.S1)", () => {
  test("reaches Reasoning on thinking_start and isReasoning() is true", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => upstream,
      diag,
      controller,
      buffer,
    );
    // drain consumer concurrently so the async iterator processes events
    const consumer = (async () => {
      for await (const _e of proxy.output) { /* drain */ void _e; }
    })();
    upstream.push(ev({ type: "start" }));
    await new Promise((r) => setTimeout(r, 0)); // let run() process the start event
    upstream.push(ev({ type: "thinking_start", contentIndex: 0 }));
    await new Promise((r) => setTimeout(r, 0)); // let run() process the thinking_start event
    expect(controller.getState()).toBe("Reasoning"); // entered on first thinking event
    expect(proxy.isReasoning()).toBe(true);
    upstream.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer; // wait for stream completion
  });

  test("reaches Reasoning on first thinking_delta when there is no thinking_start (PRD §22.3)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(
      upstream,
      [
        ev({ type: "start" }),
        ev({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
        ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      ],
      controller,
      buffer,
      diag,
    );
    expect(controller.getState()).toBe("Reasoning");
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["hm"]); // entering delta IS captured
  });

  test("buffer accumulates thinking deltas in order; bytes accumulate", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(
      upstream,
      [
        ev({ type: "start" }),
        ev({ type: "thinking_start", contentIndex: 0 }),
        ev({ type: "thinking_delta", contentIndex: 0, delta: "Let me " }),
        ev({ type: "thinking_delta", contentIndex: 0, delta: "think" }),
        ev({ type: "thinking_end", contentIndex: 0, content: "Let me think" }),
        ev({ type: "text_start", contentIndex: 1 }),
        ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
        ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      ],
      controller,
      buffer,
      diag,
    );
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["Let me ", "think"]);
    expect(buffer.snapshot().map((e) => e.offset)).toEqual([0, 1]);
    expect(buffer.getByteSize()).toBe("Let me ".length + "think".length);
  });

  test("forwarding is byte-for-byte unchanged WITH detection active (transparency proof)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const { seen } = await drive(
      upstream,
      [
        ev({ type: "start" }),
        ev({ type: "thinking_start", contentIndex: 0 }),
        ev({ type: "thinking_delta", contentIndex: 0, delta: "a" }),
        ev({ type: "thinking_end", contentIndex: 0, content: "a" }),
        ev({ type: "text_start", contentIndex: 1 }),
        ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
        ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      ],
      controller,
      buffer,
      diag,
    );
    expect(seen).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "done",
    ]); // detection did not alter output
  });

  test("a no-reasoning stream never enters Reasoning and leaves the buffer empty", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => upstream,
      diag,
      controller,
      buffer,
    );
    // drain consumer concurrently
    const consumer = (async () => {
      for await (const _e of proxy.output) { /* drain */ void _e; }
    })();
    upstream.push(ev({ type: "start" }));
    await new Promise((r) => setTimeout(r, 0)); // let run() process the start event
    expect(controller.getState()).toBe("Delegating");
    expect(proxy.isReasoning()).toBe(false);
    // now push the rest of the stream and verify buffer stays empty
    upstream.push(ev({ type: "text_start", contentIndex: 0 }));
    await new Promise((r) => setTimeout(r, 0));
    upstream.push(ev({ type: "text_delta", contentIndex: 0, delta: "Hi" }));
    await new Promise((r) => setTimeout(r, 0));
    upstream.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
    expect(buffer.snapshot()).toHaveLength(0);
    expect(buffer.getByteSize()).toBe(0);
  });

  test("an error terminal cleanly resets the controller to Idle (fail → Failed → reset)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(
      upstream,
      [
        ev({ type: "start" }),
        ev({ type: "error", reason: "error", error: ERROR_MESSAGE }),
      ],
      controller,
      buffer,
      diag,
    );
    expect(controller.getState()).toBe("Idle");
  });

  test("a normal done throws nothing and emits NO transition.illegal warn (controller left Reasoning)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await expect(
      drive(
        upstream,
        [
          ev({ type: "start" }),
          ev({ type: "thinking_start", contentIndex: 0 }),
          ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
          ev({ type: "thinking_end", contentIndex: 0, content: "x" }),
          ev({ type: "text_start", contentIndex: 1 }),
          ev({ type: "text_delta", contentIndex: 1, delta: "y" }),
          ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
        ],
        controller,
        buffer,
        diag,
      ),
    ).resolves.toBeDefined(); // no throw
    expect(events.filter((c) => c.event === "transition.illegal")).toHaveLength(0); // no spurious warn
    expect(controller.getState()).toBe("Reasoning"); // documented §16 normal-flow gap (no Reasoning→Completed)
  });

  test("reasoning enter is idempotent — many thinking events enter Reasoning exactly once", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(
      upstream,
      [
        ev({ type: "start" }),
        ev({ type: "thinking_start", contentIndex: 0 }),
        ev({ type: "thinking_delta", contentIndex: 0, delta: "a" }),
        ev({ type: "thinking_delta", contentIndex: 0, delta: "b" }),
        ev({ type: "thinking_end", contentIndex: 0, content: "ab" }),
        ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      ],
      controller,
      buffer,
      diag,
    );
    const enters = events.filter(
      (c) =>
        c.level === "trace" &&
        c.event === "transition.state-change" &&
        c.fields?.from === "Delegating" &&
        c.fields?.to === "Reasoning",
    );
    expect(enters).toHaveLength(1); // entered exactly once despite many thinking events
  });

  test("injected controller + buffer are the ones the proxy uses", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => upstream,
      diag,
      controller,
      buffer,
    );
    expect(proxy.controller).toBe(controller);
    expect(proxy.buffer).toBe(buffer);
    // drive events through the same proxy (not creating a second proxy)
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    })();
    const events = [
      ev({ type: "start" }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "captured" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ];
    for (const e of events) {
      upstream.push(e);
      await new Promise((r) => setTimeout(r, 0));
    }
    await consumer;
    expect(seen).toEqual(["start", "thinking_delta", "done"]);
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["captured"]); // the injected buffer accumulated
  });
});
