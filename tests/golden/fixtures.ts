/**
 * # Golden Replay fixtures — representative captures of real provider event streams.
 *
 * **Responsibility** (PRD §55.178): the captured-stream inputs the harness replays. Three shapes
 * spanning the Phase-1 inactive surface: a full reasoning→answer lifecycle, a no-reasoning answer,
 * and an immediate error. All events carry realistic {@link AssistantMessage} objects (via
 * {@link partialAssistantMessage}) so the byte-for-byte deep-equal is meaningful.
 *
 * **GUARDRAIL (critical)**: EVERY fixture MUST end with a terminal event (`done` or `error`).
 * `replayEvents` iterates `proxy.output`, which completes only when the proxy forwards a terminal.
 * A fixture lacking a terminal would hang the replay forever. Do not add a non-terminal-ending
 * fixture.
 *
 * **Reuse**: consumed by `golden-replay.test.ts` (now), P1.M7 (integration), P1.M8 (stress).
 * Additions are APPEND-ONLY — never mutate an existing fixture (it would silently change the baseline).
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { partialAssistantMessage } from "./replay";

/** start → thinking_start → thinking_delta×2 → thinking_end → text_start → text_delta×2 →
 *  text_end → done. The canonical reasoning-then-answer lifecycle (PRD §38 legal ordering). */
export const NORMAL_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialAssistantMessage() },
  { type: "thinking_start", contentIndex: 0, partial: partialAssistantMessage() },
  { type: "thinking_delta", contentIndex: 0, delta: "Let me think", partial: partialAssistantMessage() },
  { type: "thinking_delta", contentIndex: 0, delta: " about this", partial: partialAssistantMessage() },
  { type: "thinking_end", contentIndex: 0, content: "Let me think about this", partial: partialAssistantMessage() },
  { type: "text_start", contentIndex: 1, partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 1, delta: "Hello", partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 1, delta: " world", partial: partialAssistantMessage() },
  { type: "text_end", contentIndex: 1, content: "Hello world", partial: partialAssistantMessage() },
  { type: "done", reason: "stop", message: partialAssistantMessage() },
] as never;

/** start → text_start → text_delta×2 → done. A model that answers without reasoning
 *  (EC-003/EC-004 shape). */
export const NO_REASONING_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialAssistantMessage() },
  { type: "text_start", contentIndex: 0, partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 0, delta: "Hi", partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 0, delta: "!", partial: partialAssistantMessage() },
  { type: "done", reason: "stop", message: partialAssistantMessage() },
] as never;

/** start → error. A provider that fails immediately (EC-019 / FM). */
export const ERROR_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialAssistantMessage() },
  { type: "error", reason: "error", error: partialAssistantMessage({ stopReason: "error", errorMessage: "provider error" }) },
] as never;
