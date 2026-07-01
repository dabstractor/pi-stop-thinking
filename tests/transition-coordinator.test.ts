import { describe, test, expect } from "bun:test";
import { TransitionCoordinator } from "../src/state/coordinator";
import type { ActiveProxy } from "../src/state/coordinator";
import type { Diagnostics } from "../src/diagnostics";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call (verbatim from reasoning-buffer.test.ts). */
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

/** Build a controllable fake satisfying the `ActiveProxy` structural interface. */
function makeFakeProxy(overrides?: {
  reasoning?: boolean;
  canInterrupt?: boolean;
  interrupting?: boolean;
  triggerThrows?: boolean;
}): { proxy: ActiveProxy; triggerStopCalls: { value: number } } {
  let reasoning = overrides?.reasoning ?? false;
  let canInterruptFlag = overrides?.canInterrupt ?? false;
  let interrupting = overrides?.interrupting ?? false;
  const triggerThrows = overrides?.triggerThrows ?? false;
  const callCount = { value: 0 };

  const proxy: ActiveProxy = {
    isReasoning: () => reasoning,
    canInterrupt: () => canInterruptFlag,
    isInterrupting: () => interrupting,
    triggerStop: () => {
      callCount.value++;
      if (triggerThrows) throw new Error("boom");
      // Emulate FSM: triggerStop moves out of Reasoning so a second requestStop is rejected.
      canInterruptFlag = false;
      interrupting = true;
      return true;
    },
  };

  return { proxy, triggerStopCalls: callCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TransitionCoordinator — no active proxy (EC-001)", () => {
  test("requestStop/isReasoning/alreadyInterrupting all return false; triggerStop never called", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);

    expect(c.requestStop()).toBe(false);
    expect(c.isReasoning()).toBe(false);
    expect(c.alreadyInterrupting()).toBe(false);

    // Traced with reason
    const stop = events.find((e) => e.event === "coordinator.request-stop");
    expect(stop).toBeDefined();
    expect(stop!.fields).toEqual({ accepted: false, reason: "no-active-proxy" });
  });
});

describe("TransitionCoordinator — isReasoning delegates to active proxy", () => {
  test("returns true when proxy.isReasoning() is true; false when cleared", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy } = makeFakeProxy({ reasoning: true });

    c.setActiveProxy(proxy);
    expect(c.isReasoning()).toBe(true);

    c.setActiveProxy(undefined);
    expect(c.isReasoning()).toBe(false);
  });

  test("setActiveProxy traces coordinator.set-active / coordinator.clear-active", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy } = makeFakeProxy();

    c.setActiveProxy(proxy);
    expect(events.some((e) => e.event === "coordinator.set-active")).toBe(true);

    c.setActiveProxy(undefined);
    expect(events.some((e) => e.event === "coordinator.clear-active")).toBe(true);
  });
});

describe("TransitionCoordinator — alreadyInterrupting delegates to active proxy", () => {
  test("returns true when proxy.isInterrupting() is true; false when cleared", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy } = makeFakeProxy({ interrupting: true });

    c.setActiveProxy(proxy);
    expect(c.alreadyInterrupting()).toBe(true);

    c.setActiveProxy(undefined);
    expect(c.alreadyInterrupting()).toBe(false);
  });
});

describe("TransitionCoordinator — requestStop happy path (PRD §51 Stop Request)", () => {
  test("canInterrupt()==true → requestStop returns true and triggerStop called exactly once", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy, triggerStopCalls } = makeFakeProxy({ canInterrupt: true });

    c.setActiveProxy(proxy);
    expect(c.requestStop()).toBe(true);
    expect(triggerStopCalls.value).toBe(1);

    const stop = events.find((e) => e.event === "coordinator.request-stop" && (e.fields as Record<string, unknown>)?.accepted === true);
    expect(stop).toBeDefined();
  });
});

describe("TransitionCoordinator — outside Reasoning (PRD §22.5 / FM-001)", () => {
  test("canInterrupt()==false → requestStop returns false; triggerStop never called", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy, triggerStopCalls } = makeFakeProxy({ canInterrupt: false });

    c.setActiveProxy(proxy);
    expect(c.requestStop()).toBe(false);
    expect(triggerStopCalls.value).toBe(0);

    const stop = events.find((e) => e.event === "coordinator.request-stop");
    expect(stop).toBeDefined();
    expect(stop!.fields).toEqual({ accepted: false, reason: "not-reasoning" });
  });
});

describe("TransitionCoordinator — first-press-wins (PRD §24.3 / INV-004)", () => {
  test("second requestStop returns false after FSM-emulating triggerStop; triggerStop called exactly once", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy, triggerStopCalls } = makeFakeProxy({ canInterrupt: true });

    c.setActiveProxy(proxy);

    // First press — accepted
    expect(c.requestStop()).toBe(true);
    expect(triggerStopCalls.value).toBe(1);

    // Second press — rejected because fake's triggerStop flipped canInterrupt to false
    expect(c.requestStop()).toBe(false);
    expect(triggerStopCalls.value).toBe(1); // still exactly one call
  });
});

describe("TransitionCoordinator — never-crash (PRD Appendix K)", () => {
  test("a triggerStop that throws is swallowed; requestStop returns false; error is logged", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy, triggerStopCalls } = makeFakeProxy({ canInterrupt: true, triggerThrows: true });

    c.setActiveProxy(proxy);

    // Does NOT throw
    expect(c.requestStop()).toBe(false);
    // triggerStop WAS called (it threw inside)
    expect(triggerStopCalls.value).toBe(1);

    // Error event logged
    const err = events.find((e) => e.event === "coordinator.request-stop-error");
    expect(err).toBeDefined();
    expect(err!.level).toBe("error");
    expect((err!.fields as Record<string, unknown>)?.error).toBe("boom");

    // Rejection traced
    const fault = events.find((e) => e.event === "coordinator.request-stop" && (e.fields as Record<string, unknown>)?.reason === "proxy-fault");
    expect(fault).toBeDefined();
  });
});

describe("TransitionCoordinator — privacy guard (PRD Appendix H)", () => {
  test("every captured fields object contains ONLY allow-listed keys", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionCoordinator(diag);
    const { proxy } = makeFakeProxy({ canInterrupt: true, triggerThrows: true });

    c.setActiveProxy(proxy);
    c.requestStop();  // trigger and triggerStop throw path

    const ALLOWED = new Set(["accepted", "reason", "error"]);

    for (const e of events) {
      const fields = e.fields;
      if (fields === undefined) continue; // {} is fine
      for (const key of Object.keys(fields)) {
        expect(ALLOWED.has(key)).toBe(true);
      }
    }
  });
});
