import { describe, test, expect } from "bun:test";
import {
  Telemetry,
  type FailureCategory,
  type CounterName,
  type TransitionStartedFields,
  type TransitionCompletedFields,
  type TransitionFailedFields,
} from "../src/telemetry";
import type { Diagnostics } from "../src/diagnostics";

type Level = "trace" | "debug" | "info" | "warn" | "error";

interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub (from tests/shortcut-manager.test.ts pattern). */
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

describe("Telemetry", () => {
  // 1. No-op when disabled
  test("no-op when disabled: no events, no Map mutation, getCounter undefined", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(false, diag);

    t.recordTransitionStarted({
      transitionId: "t1",
      provider: "zai",
      model: "glm-4.6",
      reasoningElapsedMs: 250,
    });
    t.recordTransitionCompleted({
      transitionId: "t2",
      abortLatencyMs: 100,
      restartLatencyMs: 200,
      spliceLatencyMs: 10,
      completionLatencyMs: 500,
      totalDurationMs: 1000,
      success: true,
    });
    t.recordTransitionFailed({
      transitionId: "t3",
      failureCategory: "ProviderTimeout",
      failurePhase: "abort",
      provider: "zai",
      model: "glm-4.6",
    });
    t.incrementCounter("TransitionsRequested");

    expect(events.length).toBe(0);
    expect(Object.keys(t.snapshot()).length).toBe(0);
    expect(t.getCounter("TransitionsRequested")).toBeUndefined();
  });

  // 2. recordTransitionStarted emits the right event + fields
  test("recordTransitionStarted emits telemetry.transition.started with correct fields", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.recordTransitionStarted({
      transitionId: "t1",
      provider: "zai",
      model: "glm-4.6",
      reasoningElapsedMs: 250,
    });

    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.level).toBe("info");
    expect(e.event).toBe("telemetry.transition.started");
    expect(e.fields?.transitionId).toBe("t1");
    expect(e.fields?.provider).toBe("zai");
    expect(e.fields?.model).toBe("glm-4.6");
    expect(e.fields?.reasoningElapsedMs).toBe(250);
    expect(typeof e.fields?.timestamp).toBe("number");
  });

  // 3. recordTransitionStarted honors an explicit timestamp
  test("recordTransitionStarted honors explicit timestamp over Date.now() default", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.recordTransitionStarted({
      transitionId: "t1",
      provider: "zai",
      model: "glm-4.6",
      reasoningElapsedMs: 250,
      timestamp: 1234567890,
    });

    expect(events.length).toBe(1);
    expect(events[0].fields?.timestamp).toBe(1234567890);
  });

  // 4. recordTransitionCompleted emits all seven fields AND updates the three averages (first sample)
  test("recordTransitionCompleted emits all seven fields + updates three Average* counters (first sample)", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.recordTransitionCompleted({
      transitionId: "t9",
      abortLatencyMs: 100,
      restartLatencyMs: 200,
      spliceLatencyMs: 10,
      completionLatencyMs: 500,
      totalDurationMs: 1000,
      success: true,
    });

    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.event).toBe("telemetry.transition.completed");
    expect(e.fields?.transitionId).toBe("t9");
    expect(e.fields?.abortLatencyMs).toBe(100);
    expect(e.fields?.restartLatencyMs).toBe(200);
    expect(e.fields?.spliceLatencyMs).toBe(10);
    expect(e.fields?.completionLatencyMs).toBe(500);
    expect(e.fields?.totalDurationMs).toBe(1000);
    expect(e.fields?.success).toBe(true);

    // First sample → average equals the value itself
    expect(t.getCounter("AverageTransitionLatency")).toBe(1000);
    expect(t.getCounter("AverageAbortLatency")).toBe(100);
    expect(t.getCounter("AverageRestartLatency")).toBe(200);
  });

  // 5. Averages are a running mean (second sample)
  test("Average* counters compute a running mean across multiple samples", () => {
    const { diag, events: _ } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    // First sample: totalDurationMs = 1000
    t.recordTransitionCompleted({
      transitionId: "t1",
      abortLatencyMs: 100,
      restartLatencyMs: 200,
      spliceLatencyMs: 10,
      completionLatencyMs: 500,
      totalDurationMs: 1000,
      success: true,
    });
    expect(t.getCounter("AverageTransitionLatency")).toBe(1000);

    // Second sample: totalDurationMs = 2000 → mean = (1000 + 2000) / 2 = 1500
    t.recordTransitionCompleted({
      transitionId: "t2",
      abortLatencyMs: 200,
      restartLatencyMs: 400,
      spliceLatencyMs: 20,
      completionLatencyMs: 1000,
      totalDurationMs: 2000,
      success: true,
    });
    expect(t.getCounter("AverageTransitionLatency")).toBe(1500);
    expect(t.getCounter("AverageAbortLatency")).toBe(150); // (100 + 200) / 2
    expect(t.getCounter("AverageRestartLatency")).toBe(300); // (200 + 400) / 2
  });

  // 6. recordTransitionFailed emits the right fields incl. failureCategory + failurePhase
  test("recordTransitionFailed emits telemetry.transition.failed with failureCategory + failurePhase", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.recordTransitionFailed({
      transitionId: "t7",
      failureCategory: "ProviderTimeout",
      failurePhase: "replacement",
      provider: "zai",
      model: "glm-4.6",
    });

    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.level).toBe("info");
    expect(e.event).toBe("telemetry.transition.failed");
    expect(e.fields?.transitionId).toBe("t7");
    expect(e.fields?.failureCategory).toBe("ProviderTimeout");
    expect(e.fields?.failurePhase).toBe("replacement");
    expect(e.fields?.provider).toBe("zai");
    expect(e.fields?.model).toBe("glm-4.6");
    expect(typeof e.fields?.timestamp).toBe("number");
  });

  // 7. incrementCounter bumps +1 and emits a counter event
  test("incrementCounter bumps +1 and emits telemetry.counter info events with value", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.incrementCounter("TransitionsRequested");
    t.incrementCounter("TransitionsRequested");
    t.incrementCounter("TransitionsRequested");

    expect(t.getCounter("TransitionsRequested")).toBe(3);

    const counterEvents = events.filter((e) => e.event === "telemetry.counter");
    expect(counterEvents.length).toBe(3);
    expect(counterEvents[0].fields?.value).toBe(1);
    expect(counterEvents[1].fields?.value).toBe(2);
    expect(counterEvents[2].fields?.value).toBe(3);
    expect(counterEvents.every((e) => e.fields?.name === "TransitionsRequested")).toBe(true);
  });

  // 8. Each simple counter is independent
  test("simple counters are independent — no cross-contamination", () => {
    const { diag, events: _ } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.incrementCounter("IgnoredShortcutPresses");
    t.incrementCounter("IgnoredShortcutPresses");
    t.incrementCounter("RequestsDelegated");

    expect(t.getCounter("IgnoredShortcutPresses")).toBe(2);
    expect(t.getCounter("RequestsDelegated")).toBe(1);
  });

  // 9. Failure swallow (PRD §35)
  test("failure swallow: a throwing diagnostics.info does not escape the method", () => {
    const throwingDiag: Diagnostics = {
      trace: () => {},
      debug: () => {},
      info: () => {
        throw new Error("diag boom");
      },
      warn: () => {},
      error: () => {},
    };
    const t = new Telemetry(true, throwingDiag);

    expect(() => t.incrementCounter("TransitionsRequested")).not.toThrow();
    expect(() =>
      t.recordTransitionStarted({
        transitionId: "t1",
        provider: "zai",
        model: "glm-4.6",
        reasoningElapsedMs: 250,
      }),
    ).not.toThrow();

    // Map should NOT have been mutated (the throw happens after set, but the incrementCounter
    // sets before calling info — verify it's still 1 because the catch prevented re-throw but
    // the set already happened; the important thing is no exception escaped).
    // For recordTransitionStarted, no set happens before info, so the method is fully swallowed.
    // For incrementCounter, the set happens before info, so the counter is already bumped.
    expect(t.getCounter("TransitionsRequested")).toBe(1);
  });

  // 10. getCounter / snapshot are pure reads
  test("getCounter returns undefined for untouched counter; snapshot is a defensive copy", () => {
    const { diag, events: _ } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    t.incrementCounter("TransitionsRequested");

    // Untouched counter → undefined
    expect(t.getCounter("IgnoredShortcutPresses")).toBeUndefined();

    // snapshot() returns a fresh object whose mutation does NOT affect internal Map
    const s = t.snapshot();
    expect(s["TransitionsRequested"]).toBe(1);
    s["TransitionsRequested"] = 999;
    expect(t.getCounter("TransitionsRequested")).toBe(1); // internal unchanged
  });

  // 11. PRIVACY (Appendix H) — the field types structurally exclude content
  test("PRIVACY: emitted fields contain no content-bearing keys or long strings", () => {
    const { diag, events } = makeCaptureDiag();
    const t = new Telemetry(true, diag);

    // Emit one of each event type with realistic operational values
    t.recordTransitionStarted({
      transitionId: "t-priv-1",
      provider: "zai",
      model: "glm-4.6",
      reasoningElapsedMs: 300,
    });
    t.recordTransitionCompleted({
      transitionId: "t-priv-2",
      abortLatencyMs: 50,
      restartLatencyMs: 150,
      spliceLatencyMs: 10,
      completionLatencyMs: 800,
      totalDurationMs: 1200,
      success: false,
    });
    t.recordTransitionFailed({
      transitionId: "t-priv-3",
      failureCategory: "NetworkFailure",
      failurePhase: "splice",
      provider: "zai",
      model: "glm-4.6",
    });
    t.incrementCounter("TransitionsFailed");

    // The TYPE system (the *Fields interfaces) is the primary guard — a caller literally cannot
    // pass a `prompt` field without a TS error. The runtime assertion below is a belt-and-suspenders
    // check that no emitted field key/value matches the deny-list.
    const denyKeyPattern = /(?:^|(?<=[^a-z]))(?:prompt|reasoning|output|apiKey|auth|token|content|message|tool)(?:$|(?=[^a-z]))/i;
    const MAX_OPERATIONAL_STRING_LENGTH = 64;

    for (const ev of events) {
      if (!ev.fields) continue;
      for (const [key, value] of Object.entries(ev.fields)) {
        expect(denyKeyPattern.test(key)).toBe(false); // key must not match deny-list
        if (typeof value === "string") {
          expect(value.length).toBeLessThanOrEqual(MAX_OPERATIONAL_STRING_LENGTH);
        }
      }
    }
  });
});
