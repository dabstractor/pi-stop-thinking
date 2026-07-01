/**
 * # Regression Tests — byte-identical golden replay through the full proxy.
 *
 * Replays every golden fixture through the full StreamProxy (no interruption) and asserts
 * byte-identical downstream output. Adds new append-only fixtures for wider coverage.
 */

import { describe, test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { isTerminalEvent } from "../src/types";
import {
  replayEvents,
  NOOP_DIAGNOSTICS,
  GOLDEN_MODEL,
  GOLDEN_CONTEXT,
  GOLDEN_OPTIONS,
} from "./golden/replay";
import {
  NORMAL_REPLAY,
  NO_REASONING_REPLAY,
  ERROR_REPLAY,
} from "./golden/fixtures";
import {
  makeCaptureDiag,
  makeModel,
  makeScriptedTwoPhaseUpstream,
  buildProxy,
  collectOutput,
} from "./helpers/invariant-harness";

// ─── New append-only fixtures (defined INLINE — not in fixtures.ts) ──────

const GOLDEN_TIMESTAMP = 1_700_000_000_000;

function partialMsg(over: Partial<AssistantMessage> = {}): AssistantMessage {
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

/** Tool-call replay: start → toolcall_start → toolcall_delta → toolcall_end → done. */
const TOOLCALL_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialMsg() },
  { type: "toolcall_start", contentIndex: 0, toolCallId: "tc_1", toolName: "search", partial: partialMsg() },
  { type: "toolcall_delta", contentIndex: 0, delta: '{"qu', partial: partialMsg() },
  { type: "toolcall_end", contentIndex: 0, toolCall: '{"query":"test"}', partial: partialMsg() },
  { type: "done", reason: "stop", message: partialMsg() },
] as never;

/** Multi-block reasoning replay. */
const MULTI_BLOCK_REASONING_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialMsg() },
  { type: "thinking_start", contentIndex: 0, partial: partialMsg() },
  { type: "thinking_delta", contentIndex: 0, delta: "First block", partial: partialMsg() },
  { type: "thinking_end", contentIndex: 0, content: "First block", partial: partialMsg() },
  { type: "thinking_start", contentIndex: 1, partial: partialMsg() },
  { type: "thinking_delta", contentIndex: 1, delta: "Second block", partial: partialMsg() },
  { type: "thinking_end", contentIndex: 1, content: "Second block", partial: partialMsg() },
  { type: "text_start", contentIndex: 2, partial: partialMsg() },
  { type: "text_delta", contentIndex: 2, delta: "Answer", partial: partialMsg() },
  { type: "done", reason: "stop", message: partialMsg() },
] as never;

/** No-reasoning with toolcall. */
const NO_REASONING_WITH_TOOLCALL_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialMsg() },
  { type: "toolcall_start", contentIndex: 0, toolCallId: "tc_2", toolName: "calc", partial: partialMsg() },
  { type: "toolcall_delta", contentIndex: 0, delta: "2+2", partial: partialMsg() },
  { type: "toolcall_end", contentIndex: 0, toolCall: "2+2", partial: partialMsg() },
  { type: "text_start", contentIndex: 1, partial: partialMsg() },
  { type: "text_delta", contentIndex: 1, delta: "4", partial: partialMsg() },
  { type: "done", reason: "stop", message: partialMsg() },
] as never;

// ─── Byte-identical replay tests ────────────────────────────────────────

describe("Regression — byte-identical replay through the FULL proxy (no interruption)", () => {
  test("NORMAL_REPLAY byte-identical", async () => {
    const result = await replayEvents(NORMAL_REPLAY);
    expect(result).toEqual(NORMAL_REPLAY);
  });

  test("NO_REASONING_REPLAY byte-identical", async () => {
    const result = await replayEvents(NO_REASONING_REPLAY);
    expect(result).toEqual(NO_REASONING_REPLAY);
  });

  test("ERROR_REPLAY byte-identical", async () => {
    const result = await replayEvents(ERROR_REPLAY);
    expect(result).toEqual(ERROR_REPLAY);
  });

  test("NEW tool-call replay byte-identical", async () => {
    const result = await replayEvents(TOOLCALL_REPLAY);
    expect(result).toEqual(TOOLCALL_REPLAY);
  });

  test("NEW multi-block reasoning replay byte-identical", async () => {
    const result = await replayEvents(MULTI_BLOCK_REASONING_REPLAY);
    expect(result).toEqual(MULTI_BLOCK_REASONING_REPLAY);
  });

  test("NEW no-reasoning-with-toolcall replay byte-identical", async () => {
    const result = await replayEvents(NO_REASONING_WITH_TOOLCALL_REPLAY);
    expect(result).toEqual(NO_REASONING_WITH_TOOLCALL_REPLAY);
  });

  test("full-proxy ctor (decorator shape) preserves byte-identity", async () => {
    const fixture = NORMAL_REPLAY;
    const mockUpstreamFn = (() => {
      const stream = createAssistantMessageEventStream();
      for (const e of fixture) stream.push(e);
      return stream;
    }) as Parameters<typeof StreamProxy>[3];

    const proxy = new StreamProxy(
      GOLDEN_MODEL,
      GOLDEN_CONTEXT,
      GOLDEN_OPTIONS,
      mockUpstreamFn,
      NOOP_DIAGNOSTICS,
    );

    const collected: AssistantMessageEvent[] = [];
    for await (const event of proxy.output) {
      collected.push(event);
    }

    expect(collected).toEqual(fixture);
  });

  test("every replay satisfies INV-001/002/003/010 (invariants hold when inactive)", async () => {
    const fixtures = [
      { events: NORMAL_REPLAY },
      { events: NO_REASONING_REPLAY },
      { events: ERROR_REPLAY },
      { events: TOOLCALL_REPLAY },
      { events: MULTI_BLOCK_REASONING_REPLAY },
      { events: NO_REASONING_WITH_TOOLCALL_REPLAY },
    ];

    for (const { events: fixture } of fixtures) {
      const { diag, events: diagEvents } = makeCaptureDiag();
      const mockUpstreamFn = (() => {
        const stream = createAssistantMessageEventStream();
        for (const e of fixture) stream.push(e);
        return stream;
      }) as Parameters<typeof StreamProxy>[3];

      const proxy = new StreamProxy(
        makeModel(),
        {} as never,
        {} as never,
        mockUpstreamFn,
        diag,
        new TransitionController(diag),
        new ReasoningBuffer(diag, 1_000_000),
      );

      const collected = await collectOutput(proxy);

      // INV-001: drained
      expect(collected.length).toBeGreaterThan(0);
      // INV-002: exactly one start
      expect(collected.filter((e) => e.type === "start")).toHaveLength(1);
      // INV-003: exactly one terminal
      expect(collected.filter(isTerminalEvent)).toHaveLength(1);
      // INV-010: exactly one cleanup
      expect(
        diagEvents.filter((c) => c.event === "proxy.lifecycle.cleanup")
          .length,
      ).toBe(1);
    }
  });
});
