import { describe, test, expect } from "bun:test";
import { ReasoningBuffer } from "../src/buffer";
import type { ThinkingEntry } from "../src/buffer";
import type { Diagnostics } from "../src/diagnostics";

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

describe("ReasoningBuffer — append + snapshot (order, offset, content, bytes)", () => {
  test("append preserves order/content; offset is the array index; bytes accumulate", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    expect(buf.snapshot()).toHaveLength(0);
    expect(buf.getByteSize()).toBe(0);

    buf.append("first");
    buf.append("second");
    buf.append("third");

    const snap = buf.snapshot();
    expect(snap.map((e) => e.content)).toEqual(["first", "second", "third"]);
    expect(snap.map((e) => e.offset)).toEqual([0, 1, 2]); // monotonic, === array index
    for (const e of snap) {
      expect(typeof e.timestamp).toBe("number");
      expect(Number.isFinite(e.timestamp)).toBe(true);
      expect(e.timestamp).toBeGreaterThan(0);
    }
    expect(buf.getByteSize()).toBe("first".length + "second".length + "third".length); // 5+6+5 = 16
  });
});

describe("ReasoningBuffer — freeze (mutable → frozen)", () => {
  test("append after freeze throws an Error citing PRD §41 and leaves the buffer unchanged", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("kept");
    buf.freeze();
    expect(() => buf.append("rejected")).toThrow(/PRD §41/);
    expect(buf.snapshot().map((e) => e.content)).toEqual(["kept"]); // unchanged
    expect(buf.getByteSize()).toBe("kept".length); // byte count unchanged
  });

  test("freeze is idempotent (calling twice does not throw)", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("a");
    expect(() => buf.freeze()).not.toThrow();
    expect(() => buf.freeze()).not.toThrow(); // idempotent
    expect(() => buf.append("b")).toThrow(/PRD §41/); // still frozen
  });
});

describe("ReasoningBuffer — snapshot immutability + decoupling", () => {
  test("snapshot is a frozen array of frozen entries", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("x");
    const snap = buf.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap[0])).toBe(true);
  });

  test("a snapshot is decoupled from later appends (deep copy)", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("one");
    const early = buf.snapshot();
    buf.append("two"); // mutate the live buffer AFTER taking the snapshot
    const late = buf.snapshot();
    expect(early.map((e) => e.content)).toEqual(["one"]); // earlier snapshot unaffected
    expect(late.map((e) => e.content)).toEqual(["one", "two"]); // fresh snapshot sees the new entry
  });
});

describe("ReasoningBuffer — reset (clear + unfreeze)", () => {
  test("reset clears entries, zeroes bytes, and unfreezes so append succeeds again", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("a");
    buf.append("b");
    buf.freeze();
    buf.reset();
    expect(buf.snapshot()).toHaveLength(0);
    expect(buf.getByteSize()).toBe(0);
    expect(() => buf.append("c")).not.toThrow(); // unfrozen → mutable again
    expect(buf.snapshot().map((e) => e.content)).toEqual(["c"]);
    expect(buf.getByteSize()).toBe(1);
  });
});

describe("ReasoningBuffer — overflow (no truncation + privacy-safe warn)", () => {
  test("an append that would exceed the limit is STILL appended (no truncation, PRD §23.5)", () => {
    const { diag, events } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 10); // tiny ceiling
    buf.append("0123456789"); // exactly 10 → no warn
    expect(events.filter((c) => c.event === "buffer.overflow")).toHaveLength(0);

    buf.append("x"); // → 11 > 10
    // NOT truncated: the delta IS the last entry
    expect(buf.snapshot().at(-1)!.content).toBe("x");
    expect(buf.getByteSize()).toBe(11);
    // exactly one overflow warn
    const overflows = events.filter((c) => c.event === "buffer.overflow");
    expect(overflows).toHaveLength(1);
  });

  test("overflow warn fields are counts only — delta content is never logged (Appendix H)", () => {
    const { diag, events } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 4);
    const secret = "SUPER-SECRET-REASONING-TEXT";
    buf.append(secret); // exceeds 4 → overflow warn fires
    const overflows = events.filter((c) => c.event === "buffer.overflow");
    expect(overflows).toHaveLength(1);
    const fields = overflows[0].fields ?? {};
    // privacy-safe keys only
    expect(Object.keys(fields).sort()).toEqual(["entries", "maximumBytes", "totalBytes"].sort());
    // defense-in-depth: no field VALUE contains the secret delta
    for (const value of Object.values(fields)) {
      expect(String(value)).not.toContain(secret);
    }
  });
});
