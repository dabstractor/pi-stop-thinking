/**
 * # Shared Event & State Types
 *
 * **Responsibility** (PRD §27 Module Overview / Appendix F): define the shared vocabulary every
 * streaming and transition module imports — the {@link TransitionState} FSM union, the
 * {@link ProxyPhase} proxy-authority phase, and the four event-classification **type guards**
 * ({@link isThinkingEvent}/{@link isTextEvent}/{@link isToolCallEvent}/{@link isTerminalEvent}) over
 * {@link AssistantMessageEvent}.
 *
 * **Ownership**: type definitions + four pure functions. Owns NO runtime state.
 *
 * **Lifecycle**: stateless — imported for its exports; no init/dispose.
 *
 * **Invariants**: (1) The four guards partition every `AssistantMessageEvent` *except* `start` into
 * exactly one family; `start` matches none. (2) `isTerminalEvent` matches BOTH `done` and `error`
 * (PRD §18: "only one `message_end` event may ever reach the Pi agent runtime"). (3) State is a
 * string-literal union — never an enum, never boolean flags (PRD Appendix F).
 *
 * **Failure modes**: pure functions; the only failure is a malformed event with an unknown `type`,
 * for which every guard returns `false` (the event is treated as unclassified — safe default).
 *
 * Consumed by: StreamProxy (P1.M2.T2.S1), TransitionController (P1.M3.T1.S1), reasoning detection
 * (P1.M4.T2), stream splicing (P1.M7).
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
/** Re-export so downstream modules import from a single local entry point. */
export type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * The explicit finite-state-machine states for the stop-thinking transition (PRD §15 State Machine,
 * §16 State Transition Table, §17 State Invariants).
 *
 * Per PRD Appendix F: *"State transitions shall be represented explicitly using discriminated unions
 * or equivalent strongly typed constructs. Boolean flag combinations shall not be used to encode
 * lifecycle state."* — hence a string-literal union (not an enum, not booleans). The
 * TransitionController (P1.M3.T1.S1) switches on this union exhaustively.
 *
 * Flow: `Idle → Delegating → Reasoning → StopRequested → Aborting → Capturing → Restarting →
 * Splicing → Answering → Completed → Idle`; `Any → Failed → Idle`.
 *
 * - Preconditions: none (pure type definition).
 * - Postconditions: closed set of 11 FSM states; downstream modules switch exhaustively.
 * - Side effects: none.
 */
export type TransitionState =
  | "Idle"
  | "Delegating"
  | "Reasoning"
  | "StopRequested"
  | "Aborting"
  | "Capturing"
  | "Restarting"
  | "Splicing"
  | "Answering"
  | "Completed"
  | "Failed";

/**
 * The StreamProxy's event-authority phase (PRD §18 Event Forwarding Rules columns + §21 Stream
 * Splicing / §39 Transition Event Rules).
 * - `"forwarding"` — §18 "Before Stop": forward all upstream events unmodified.
 * - `"transitioning"` — §18 "During Transition": suppress obsolete thinking + the upstream terminal
 *   completion; suspend tool calls.
 * - `"splicing"` — §21/§39: primary (upstream) suppressed, replacement stream authoritative.
 *
 * - Preconditions: none (pure type definition).
 * - Postconditions: closed set of 3 proxy-authority phases.
 * - Side effects: none.
 */
export type ProxyPhase = "forwarding" | "transitioning" | "splicing";

// ─────────────────────────────────────────────────────────────────────────────
// Event classification (PRD §18 Event Forwarding Rules)
// Each family: a discriminator union → an Extract-narrowed alias → a type guard.
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminators of the reasoning/thinking event family (PRD §18 `thinking_*` rows). */
export type ThinkingEventType = "thinking_start" | "thinking_delta" | "thinking_end";
/** Discriminators of the answer/text event family (PRD §18 `text_*` rows). */
export type TextEventType = "text_start" | "text_delta" | "text_end";
/** Discriminators of the tool-call event family (PRD §18 `tool_call` row; real discriminators are `toolcall_*`). */
export type ToolCallEventType = "toolcall_start" | "toolcall_delta" | "toolcall_end";
/** Discriminators of the terminal event family (PRD §18 `message_end` row → real `done` | `error`). */
export type TerminalEventType = "done" | "error";

/** A reasoning/thinking event (thinking_start | thinking_delta | thinking_end). */
export type ThinkingEvent = Extract<AssistantMessageEvent, { type: ThinkingEventType }>;
/** An answer/text event (text_start | text_delta | text_end). */
export type TextEvent = Extract<AssistantMessageEvent, { type: TextEventType }>;
/** A tool-call event (toolcall_start | toolcall_delta | toolcall_end). */
export type ToolCallEvent = Extract<AssistantMessageEvent, { type: ToolCallEventType }>;
/** A terminal event (done | error). */
export type TerminalEvent = Extract<AssistantMessageEvent, { type: TerminalEventType }>;

// Centralized family-membership sets (PRD Appendix F: "magic numbers are prohibited";
// "Provider-specific constants shall be centralized" — no inline discriminator strings in guards).
const THINKING_TYPES: ReadonlySet<string> = new Set<ThinkingEventType>([
  "thinking_start",
  "thinking_delta",
  "thinking_end",
]);
const TEXT_TYPES: ReadonlySet<string> = new Set<TextEventType>([
  "text_start",
  "text_delta",
  "text_end",
]);
const TOOLCALL_TYPES: ReadonlySet<string> = new Set<ToolCallEventType>([
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);
const TERMINAL_TYPES: ReadonlySet<string> = new Set<TerminalEventType>(["done", "error"]);

/**
 * Type guard: is `event` a reasoning/thinking event (`thinking_start` | `thinking_delta` |
 * `thinking_end`)?
 *
 * PRD §18 (thinking rows): Forward before stop / Ignore during transition / Never emit after restart.
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {thinking_start, thinking_delta, thinking_end}`;
 *   narrows to {@link ThinkingEvent} (exposes `contentIndex`, and `delta`/`content` for *_delta/*_end).
 * - Side effects: none. Ownership changes: none.
 */
export function isThinkingEvent(event: AssistantMessageEvent): event is ThinkingEvent {
  return THINKING_TYPES.has(event.type);
}

/**
 * Type guard: is `event` an answer/text event (`text_start` | `text_delta` | `text_end`)?
 *
 * PRD §18 (text rows): Forward before stop / Replacement-only during transition / Forward after restart.
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {text_start, text_delta, text_end}`; narrows to
 *   {@link TextEvent} (exposes `contentIndex`, and `delta`/`content` for *_delta/*_end).
 * - Side effects: none. Ownership changes: none.
 */
export function isTextEvent(event: AssistantMessageEvent): event is TextEvent {
  return TEXT_TYPES.has(event.type);
}

/**
 * Type guard: is `event` a tool-call event (`toolcall_start` | `toolcall_delta` | `toolcall_end`)?
 *
 * PRD §18 (tool_call row): Forward before stop / Suspend until replacement during transition /
 * Forward after restart. (Note: §18 names this `tool_call`; the real `AssistantMessageEvent.type`
 * discriminators are `toolcall_*`.)
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {toolcall_start, toolcall_delta, toolcall_end}`;
 *   narrows to {@link ToolCallEvent} (exposes `contentIndex`, and `delta`/`toolCall` for *_delta/*_end).
 * - Side effects: none. Ownership changes: none.
 */
export function isToolCallEvent(event: AssistantMessageEvent): event is ToolCallEvent {
  return TOOLCALL_TYPES.has(event.type);
}

/**
 * Type guard: is `event` a terminal event (`done` | `error`)?
 *
 * PRD §18 invariant: *"only one `message_end` event may ever reach the Pi agent runtime, regardless
 * of how many upstream provider requests occur internally."* §18 names this `message_end`; the real
 * terminal `AssistantMessageEvent.type` values are `done` (success) and `error` (failure/abort) —
 * this guard matches BOTH. During splicing the StreamProxy uses it to single-flush exactly one
 * terminal event downstream while suppressing upstream completion (PRD §39).
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {done, error}`; narrows to {@link TerminalEvent}
 *   (exposes `reason`, and `message` for `done` / `error` for `error`).
 * - Side effects: none. Ownership changes: none.
 */
export function isTerminalEvent(event: AssistantMessageEvent): event is TerminalEvent {
  return TERMINAL_TYPES.has(event.type);
}

/**
 * FM-013 / PRD §52 Validation Rules: is a RECOGNIZED-type event missing its critical payload?
 *
 * Recognized type but structurally broken (vs. an UNKNOWN type, which §52 passes through unchanged):
 *   - `done`  without a `message` (the AssistantMessage Pi dereferences at completion) — FATAL downstream.
 *   - `error` without an `error`  (the AssistantMessage carrying the failure)                — FATAL downstream.
 *   - `*_delta` (`thinking`/`text`/`toolcall`) whose `delta` is not a string                  — recoverable.
 * `start` / `*_start` / `*_end` and every unknown type return `false` (recoverable / pass-through).
 *
 * The caller (`StreamProxy._emit`) decides severity: a malformed TERMINAL (`isTerminalEvent` true)
 * cannot carry a valid completion → synthesize a clean error + fail (PRD §54 L4); a malformed
 * NON-terminal is logged + forwarded best-effort (recoverable).
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff the event is a recognized type missing critical payload.
 * - Side effects: none. Pure.
 */
export function isMalformedEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "done":
      return !(event as Extract<AssistantMessageEvent, { type: "done" }>).message;
    case "error":
      return !(event as Extract<AssistantMessageEvent, { type: "error" }>).error;
    case "thinking_delta":
    case "text_delta":
    case "toolcall_delta":
      return typeof (event as Extract<AssistantMessageEvent, { type: "thinking_delta" }>).delta !== "string";
    default:
      return false; // start / *_start / *_end / unknown → not malformed (pass through / recoverable)
  }
}
