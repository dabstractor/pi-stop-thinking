/**
 * # Consumer Harness — companion unit test.
 *
 * Hand-builds a realistic start→thinking→text→done stream and asserts the harness
 * assembles finalMessage.content with BOTH a thinking and text block.
 */

import { test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { consumeLikeAgentLoop } from "./consumer-harness";

/** Build a synthetic AssistantMessage with the given content blocks. */
const msg = (content: AssistantMessage["content"]): AssistantMessage =>
  ({
    role: "assistant",
    content,
    model: "glm-4.7",
    api: "openai-completions",
    provider: "zai",
    usage: { input: 0, output: 0 },
    stopReason: "stop",
    timestamp: 0,
  }) as AssistantMessage;

test("consumeLikeAgentLoop assembles finalMessage with both thinking and text blocks", async () => {
  const thinking = { type: "thinking" as const, thinking: "Let me reason." };
  const text = { type: "text" as const, text: "Here is the answer." };

  const stream = createAssistantMessageEventStream();

  const events: AssistantMessageEvent[] = [
    { type: "start", partial: msg([{ ...thinking }]) },
    { type: "thinking_start", contentIndex: 0, partial: msg([{ ...thinking }]) },
    { type: "thinking_delta", contentIndex: 0, delta: "Let me reason.", partial: msg([{ ...thinking }]) },
    { type: "thinking_end", contentIndex: 0, content: "Let me reason.", partial: msg([{ ...thinking }]) },
    { type: "text_start", contentIndex: 1, partial: msg([{ ...thinking }, { type: "text", text: "" }]) },
    { type: "text_delta", contentIndex: 1, delta: "Here is the answer.", partial: msg([{ ...thinking }, { ...text }]) },
    { type: "text_end", contentIndex: 1, content: "Here is the answer.", partial: msg([{ ...thinking }, { ...text }]) },
    { type: "done", reason: "stop", message: msg([{ ...thinking }, { ...text }]) },
  ] as unknown as AssistantMessageEvent[];

  for (const e of events) stream.push(e);

  const { finalMessage, events: out, partialHistory } = await consumeLikeAgentLoop(stream);

  expect(out).toHaveLength(8);
  expect(partialHistory).toHaveLength(7); // 8 events minus the `done` terminal
  expect(finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]); // ← BOTH blocks preserved
  expect(finalMessage.content[0]).toMatchObject({ type: "thinking", thinking: "Let me reason." });
  expect(finalMessage.content[1]).toMatchObject({ type: "text", text: "Here is the answer." });
});
