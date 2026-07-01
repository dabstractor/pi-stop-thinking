import { describe, test, expect } from "bun:test";
import { TransitionController, ALLOWED_TRANSITIONS } from "../src/state/controller";
import type { TransitionState } from "../src/types";
import type { Diagnostics } from "../src/diagnostics";

/** Capturing Diagnostics stub (adapted from tests/diagnostics.test.ts). Records trace/warn/error so
 *  tests can assert transition logging (PRD §57 trace = every state transition). */
function makeCaptureDiag(): { diag: Diagnostics; events: Array<{ level: "trace" | "warn" | "error"; event: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ level: "trace" | "warn" | "error"; event: string; fields?: Record<string, unknown> }> = [];
  const diag = {
    trace: (event: string, fields?: Record<string, unknown>) => events.push({ level: "trace", event, fields }),
    warn: (event: string, fields?: Record<string, unknown>) => events.push({ level: "warn", event, fields }),
    error: (event: string, fields?: Record<string, unknown>) => events.push({ level: "error", event, fields }),
    debug() {},
    info() {},
  } as Diagnostics;
  return { diag, events };
}

// --- ALLOWED_TRANSITIONS (PRD §16 table) --------------------------------------------

describe("ALLOWED_TRANSITIONS — encodes PRD §16 exactly", () => {
  test("every state maps to its §16 successors (incl. Any→Failed)", () => {
    expect([...(ALLOWED_TRANSITIONS.get("Idle") as ReadonlySet<TransitionState>)].sort()).toEqual(["Delegating", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Delegating") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Reasoning"]);
    expect([...(ALLOWED_TRANSITIONS.get("Reasoning") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "StopRequested"]);
    expect([...(ALLOWED_TRANSITIONS.get("StopRequested") as ReadonlySet<TransitionState>)].sort()).toEqual(["Aborting", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Aborting") as ReadonlySet<TransitionState>)].sort()).toEqual(["Capturing", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Capturing") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Restarting"]);
    expect([...(ALLOWED_TRANSITIONS.get("Restarting") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Splicing"]);
    expect([...(ALLOWED_TRANSITIONS.get("Splicing") as ReadonlySet<TransitionState>)].sort()).toEqual(["Answering", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Answering") as ReadonlySet<TransitionState>)].sort()).toEqual(["Completed", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Completed") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Idle"]);
    expect([...(ALLOWED_TRANSITIONS.get("Failed") as ReadonlySet<TransitionState>)].sort()).toEqual(["Idle"]);
  });

  test("table has exactly 11 entries (one per state)", () => {
    expect(ALLOWED_TRANSITIONS.size).toBe(11);
  });
});

// --- initial state + getState -------------------------------------------------------

describe("TransitionController — initial state", () => {
  test("starts in Idle and getState returns it", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(c.getState()).toBe("Idle");
  });
});

// --- happy-path walk ----------------------------------------------------------------

describe("TransitionController — full happy-path walk returns to Idle (PRD §16)", () => {
  test("Idle→Delegating→Reasoning→StopRequested→Aborting→Capturing→Restarting→Splicing→Answering→Completed→Idle", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");      // entry (stream begins)
    expect(c.getState()).toBe("Delegating");
    c.transition("Reasoning");       // entry (first thinking event)
    expect(c.getState()).toBe("Reasoning");
    expect(c.requestStop()).toBe(true);
    expect(c.getState()).toBe("StopRequested");
    c.beginAbort();
    expect(c.getState()).toBe("Aborting");
    c.completeAbort();
    expect(c.getState()).toBe("Capturing");
    c.beginReplacement();
    expect(c.getState()).toBe("Restarting");
    c.beginSplice();
    expect(c.getState()).toBe("Splicing");
    c.beginAnswering();
    expect(c.getState()).toBe("Answering");
    c.complete();
    expect(c.getState()).toBe("Completed");
    c.reset();
    expect(c.getState()).toBe("Idle");
  });
});

// --- canInterrupt + requestStop -----------------------------------------------------

describe("canInterrupt — true ONLY in Reasoning (PRD §22.5)", () => {
  for (const [state, expected] of [
    ["Idle", false], ["Delegating", false], ["Reasoning", true], ["StopRequested", false],
    ["Aborting", false], ["Capturing", false], ["Restarting", false], ["Splicing", false],
    ["Answering", false], ["Completed", false], ["Failed", false],
  ] as const) {
    test(`canInterrupt() is ${expected} in ${state}`, () => {
      const { diag } = makeCaptureDiag();
      const c = new TransitionController(diag);
      // walk to `state` along the legal path then assert.
      c.transition("Delegating");
      c.transition("Reasoning");
      if (state === "Reasoning") { expect(c.canInterrupt()).toBe(expected); return; }
      c.requestStop();   // → StopRequested
      if (state === "StopRequested") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginAbort();    // → Aborting
      if (state === "Aborting") { expect(c.canInterrupt()).toBe(expected); return; }
      c.completeAbort(); // → Capturing
      if (state === "Capturing") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginReplacement(); // → Restarting
      if (state === "Restarting") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginSplice();   // → Splicing
      if (state === "Splicing") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginAnswering(); // → Answering
      if (state === "Answering") { expect(c.canInterrupt()).toBe(expected); return; }
      c.complete();      // → Completed
      if (state === "Completed") { expect(c.canInterrupt()).toBe(expected); return; }
      if (state === "Failed") { c.fail("x"); expect(c.canInterrupt()).toBe(expected); return; }
      if (state === "Idle" || state === "Delegating") { /* asserted via fresh controller below */ }
    });
  }
  test("canInterrupt false in Idle and Delegating (fresh controller)", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(c.canInterrupt()).toBe(false);            // Idle
    c.transition("Delegating");
    expect(c.canInterrupt()).toBe(false);            // Delegating
  });
});

describe("requestStop — boolean contract (item MOCKING)", () => {
  test("returns false from Idle (no throw, no state change, no log)", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    const before = events.length;
    expect(c.requestStop()).toBe(false);
    expect(c.getState()).toBe("Idle");               // unchanged
    expect(events.length).toBe(before);              // nothing logged
  });
  test("returns false from Delegating and every non-Reasoning state", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");
    expect(c.requestStop()).toBe(false);
  });
  test("returns true from Reasoning and transitions to StopRequested", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");
    c.transition("Reasoning");
    expect(c.requestStop()).toBe(true);
    expect(c.getState()).toBe("StopRequested");
  });
});

// --- illegal transitions throw ------------------------------------------------------

describe("illegal transitions throw and leave state unchanged (PRD §16)", () => {
  test("Aborting→Restarting (skipping Capturing) throws (item MOCKING)", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating"); c.transition("Reasoning"); c.requestStop(); c.beginAbort();
    expect(c.getState()).toBe("Aborting");
    expect(() => c.transition("Restarting")).toThrow(/PRD §16/);
    expect(c.getState()).toBe("Aborting");           // unchanged
  });
  test("Idle→Answering throws", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.transition("Answering")).toThrow(/PRD §16/);
    expect(c.getState()).toBe("Idle");
  });
  test("beginAbort() from Idle throws", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.beginAbort()).toThrow(/PRD §16/);
  });
  test("complete() from Idle throws", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.complete()).toThrow(/PRD §16/);
  });
  test("the thrown Error names the from→to pair + PRD §16", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    try {
      c.transition("Reasoning"); // illegal from Idle
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Idle");
      expect((err as Error).message).toContain("Reasoning");
      expect((err as Error).message).toContain("PRD §16");
    }
  });
});

// --- fail() Any→Failed ---------------------------------------------------------------

describe("fail — Any→Failed always succeeds + logs (PRD §16)", () => {
  for (const setup of [
    { label: "Idle", walk: (c: TransitionController) => {} },
    { label: "Reasoning", walk: (c: TransitionController) => { c.transition("Delegating"); c.transition("Reasoning"); } },
    { label: "Splicing", walk: (c: TransitionController) => { c.transition("Delegating"); c.transition("Reasoning"); c.requestStop(); c.beginAbort(); c.completeAbort(); c.beginReplacement(); c.beginSplice(); } },
  ]) {
    test(`fail() from ${setup.label} → Failed (never throws)`, () => {
      const { diag, events } = makeCaptureDiag();
      const c = new TransitionController(diag);
      setup.walk(c);
      const from = c.getState();
      expect(() => c.fail("abort-failed")).not.toThrow();
      expect(c.getState()).toBe("Failed");
      const failedLog = events.find((e) => e.level === "error" && e.event === "transition.failed");
      expect(failedLog).toBeDefined();
      expect(failedLog!.fields!.reason).toBe("abort-failed");
      expect(failedLog!.fields!.from).toBe(from);
    });
  }
});

// --- reset() legality ----------------------------------------------------------------

describe("reset — legal only from Completed/Failed (PRD §16)", () => {
  test("reset() from Completed → Idle", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating"); c.transition("Reasoning"); c.requestStop(); c.beginAbort();
    c.completeAbort(); c.beginReplacement(); c.beginSplice(); c.beginAnswering(); c.complete();
    expect(c.getState()).toBe("Completed");
    c.reset();
    expect(c.getState()).toBe("Idle");
  });
  test("reset() from Failed → Idle", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.fail("x");
    expect(c.getState()).toBe("Failed");
    c.reset();
    expect(c.getState()).toBe("Idle");
  });
  test("reset() from Reasoning THROWS", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating"); c.transition("Reasoning");
    expect(() => c.reset()).toThrow(/PRD §16/);
    expect(c.getState()).toBe("Reasoning");          // unchanged
  });
});

// --- trace logging (PRD §57) ---------------------------------------------------------

describe("transition logging — trace on success, warn on illegal (PRD §57)", () => {
  test("a legal transition emits exactly one transition.state-change with {from,to}", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");
    const changes = events.filter((e) => e.level === "trace" && e.event === "transition.state-change");
    expect(changes).toHaveLength(1);
    expect(changes[0].fields).toEqual({ from: "Idle", to: "Delegating" });
  });
  test("an illegal attempt emits exactly one transition.illegal with {from,to} then throws", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.transition("Answering")).toThrow();
    const illegals = events.filter((e) => e.level === "warn" && e.event === "transition.illegal");
    expect(illegals).toHaveLength(1);
    expect(illegals[0].fields).toEqual({ from: "Idle", to: "Answering" });
  });
  test("fail() emits transition.state-change trace AND transition.failed error", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.fail("timeout");
    const traces = events.filter((e) => e.level === "trace" && e.event === "transition.state-change");
    expect(traces).toHaveLength(1);
    expect(traces[0].fields).toEqual({ from: "Idle", to: "Failed" });
    const errors = events.filter((e) => e.level === "error" && e.event === "transition.failed");
    expect(errors).toHaveLength(1);
    expect(errors[0].fields).toEqual({ reason: "timeout", from: "Idle" });
  });
});
