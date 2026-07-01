import { describe, test, expect } from "bun:test";
import {
  isThinkingEvent,
  isTextEvent,
  isToolCallEvent,
  isTerminalEvent,
} from "../src/types";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

// --- test doubles ---------------------------------------------------------

/**
 * Build a synthetic AssistantMessageEvent carrying only a `type`. The guards read ONLY `event.type`,
 * so the rest of the payload is irrelevant to classification (same sentinel style as
 * provider-decorator.test.ts). `as unknown as` is safe because no guard touches other fields.
 */
function makeEvent(type: string): AssistantMessageEvent {
  return { type } as unknown as AssistantMessageEvent;
}

const ALL_TYPES = [
  "start",
  "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
  "done", "error",
] as const;

// Expected guard results per event type: [thinking, text, toolcall, terminal].
const EXPECTED: Record<string, [boolean, boolean, boolean, boolean]> = {
  start:          [false, false, false, false],
  text_start:     [false, true,  false, false],
  text_delta:     [false, true,  false, false],
  text_end:       [false, true,  false, false],
  thinking_start: [true,  false, false, false],
  thinking_delta: [true,  false, false, false],
  thinking_end:   [true,  false, false, false],
  toolcall_start: [false, false, true,  false],
  toolcall_delta: [false, false, true,  false],
  toolcall_end:   [false, false, true,  false],
  done:           [false, false, false, true],
  error:          [false, false, false, true],
};

function classify(type: string): [boolean, boolean, boolean, boolean] {
  const e = makeEvent(type);
  return [isThinkingEvent(e), isTextEvent(e), isToolCallEvent(e), isTerminalEvent(e)];
}

// --- per-guard groups (table-driven) --------------------------------------

describe("isThinkingEvent", () => {
  test("true only for the thinking_* family", () => {
    for (const t of ["thinking_start", "thinking_delta", "thinking_end"]) {
      expect(isThinkingEvent(makeEvent(t))).toBe(true);
    }
    for (const t of ALL_TYPES) {
      if (!t.startsWith("thinking")) expect(isThinkingEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("isTextEvent", () => {
  test("true only for the text_* family", () => {
    for (const t of ["text_start", "text_delta", "text_end"]) {
      expect(isTextEvent(makeEvent(t))).toBe(true);
    }
    for (const t of ALL_TYPES) {
      if (!t.startsWith("text_")) expect(isTextEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("isToolCallEvent", () => {
  test("true only for the toolcall_* family (NOT 'tool_call')", () => {
    for (const t of ["toolcall_start", "toolcall_delta", "toolcall_end"]) {
      expect(isToolCallEvent(makeEvent(t))).toBe(true);
    }
    for (const t of ALL_TYPES) {
      if (!t.startsWith("toolcall")) expect(isToolCallEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("isTerminalEvent", () => {
  test("true for BOTH done and error (the single message_end invariant, PRD §18)", () => {
    expect(isTerminalEvent(makeEvent("done"))).toBe(true);
    expect(isTerminalEvent(makeEvent("error"))).toBe(true);
  });

  test("false for start (lifecycle) and every partial-update family", () => {
    expect(isTerminalEvent(makeEvent("start"))).toBe(false);
    for (const t of ALL_TYPES) {
      if (t !== "done" && t !== "error") expect(isTerminalEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("event classification — exhaustiveness & partition", () => {
  test("'start' matches NO guard (it is a lifecycle event)", () => {
    expect(classify("start")).toEqual([false, false, false, false]);
  });

  test("every non-start event matches EXACTLY ONE guard (no double-classification, none unclassified)", () => {
    for (const t of ALL_TYPES) {
      const results = classify(t);
      const trueCount = results.filter(Boolean).length;
      if (t === "start") {
        expect(trueCount).toBe(0); // lifecycle: unclassified by design
      } else {
        expect(trueCount).toBe(1); // every other event → exactly one family
      }
    }
  });

  test("classification matches the EXPECTED table for ALL 12 types", () => {
    for (const t of ALL_TYPES) {
      expect(classify(t)).toEqual(EXPECTED[t]);
    }
  });

  test("an unknown type matches NO guard (safe default for malformed events)", () => {
    const e = makeEvent("totally_bogus_type");
    expect(isThinkingEvent(e)).toBe(false);
    expect(isTextEvent(e)).toBe(false);
    expect(isToolCallEvent(e)).toBe(false);
    expect(isTerminalEvent(e)).toBe(false);
  });
});
