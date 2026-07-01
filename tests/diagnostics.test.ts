import { describe, test, expect } from "bun:test";
import { createDiagnostics, LEVEL_WEIGHT } from "../src/diagnostics";
import type { Diagnostics, DiagnosticsSink } from "../src/diagnostics";
import type { DiagnosticsLevel } from "../src/config";

/** A sink that captures every line + which channel it used. */
function captureSink(): DiagnosticsSink & { log: (l: string) => void; error: (l: string) => void; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (l: string) => void logs.push(l),
    error: (l: string) => void errors.push(l),
  };
}

// Which methods should emit at a given configured level (weight <= threshold).
const EMITS_AT: Record<DiagnosticsLevel, Array<keyof Diagnostics>> = {
  error: ["error"],
  warn: ["error", "warn"],
  info: ["error", "warn", "info"],
  debug: ["error", "warn", "info", "debug"],
  trace: ["error", "warn", "info", "debug", "trace"],
};
const ALL_METHODS: Array<keyof Diagnostics> = ["error", "warn", "info", "debug", "trace"];

describe("createDiagnostics — level filtering", () => {
  for (const level of ["error", "warn", "info", "debug", "trace"] as DiagnosticsLevel[]) {
    test(`at level "${level}" only the expected methods emit`, () => {
      const sink = captureSink();
      const d = createDiagnostics(level, sink);
      const emitted = new Set<string>();
      for (const m of ALL_METHODS) {
        const before = sink.logs.length + sink.errors.length;
        (d[m] as (e: string) => void)(`evt.${m}`);
        const after = sink.logs.length + sink.errors.length;
        if (after > before) emitted.add(m);
      }
      expect([...emitted].sort()).toEqual([...EMITS_AT[level]].sort());
    });
  }

  test("dropped messages are true no-ops (nothing written to either channel)", () => {
    const sink = captureSink();
    const d = createDiagnostics("error", sink); // only error emits
    d.trace("t"); d.debug("db"); d.info("i"); d.warn("w");
    expect(sink.logs).toEqual([]);
    expect(sink.errors).toEqual([]);
  });
});

describe("createDiagnostics — sink routing", () => {
  test("warn/error -> sink.error; trace/debug/info -> sink.log", () => {
    const sink = captureSink();
    const d = createDiagnostics("trace", sink); // everything emits
    d.trace("t"); d.debug("db"); d.info("i"); d.warn("w"); d.error("e");
    expect(sink.logs).toHaveLength(3);   // trace, debug, info
    expect(sink.errors).toHaveLength(2); // warn, error
    for (const line of sink.logs) expect(JSON.parse(line).level).toMatch(/trace|debug|info/);
    for (const line of sink.errors) expect(JSON.parse(line).level).toMatch(/warn|error/);
  });
});

describe("createDiagnostics — JSON structure", () => {
  test("every emitted line is valid JSON with ts/level/event and spread fields", () => {
    const sink = captureSink();
    const d = createDiagnostics("info", sink);
    d.info("transition.started", { provider: "zai", model: "glm-4.7", transitionId: "t1" });
    expect(sink.logs).toHaveLength(1);
    const obj = JSON.parse(sink.logs[0]);
    expect(obj.level).toBe("info");
    expect(obj.event).toBe("transition.started");
    expect(typeof obj.ts).toBe("string");
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(obj.provider).toBe("zai");
    expect(obj.model).toBe("glm-4.7");
    expect(obj.transitionId).toBe("t1");
  });

  test("fields are optional (omitting fields still produces a valid line)", () => {
    const sink = captureSink();
    createDiagnostics("error", sink).error("boom");
    expect(sink.errors).toHaveLength(1);
    const obj = JSON.parse(sink.errors[0]);
    expect(obj).toEqual({ ts: obj.ts, level: "error", event: "boom" });
  });

  test("reserved keys (level/event) are authoritative — caller cannot clobber them", () => {
    const sink = captureSink();
    const d = createDiagnostics("info", sink);
    // Caller tries to forge level/event — must be ignored (logger-owned keys win).
    d.info("real.event", { level: "trace", event: "fake", ts: "EVIL" });
    const obj = JSON.parse(sink.logs[0]);
    expect(obj.level).toBe("info");
    expect(obj.event).toBe("real.event");
    expect(obj.ts).not.toBe("EVIL");
  });
});

describe("createDiagnostics — object safety", () => {
  test("returned Diagnostics object is frozen", () => {
    expect(Object.isFrozen(createDiagnostics("error"))).toBe(true);
  });

  test("default sink (no sink arg) does not throw", () => {
    expect(() => {
      const d = createDiagnostics("trace");
      d.trace("t"); d.error("e");
    }).not.toThrow();
  });
});

describe("LEVEL_WEIGHT", () => {
  test("implements error < warn < info < debug < trace", () => {
    expect(LEVEL_WEIGHT.error).toBeLessThan(LEVEL_WEIGHT.warn);
    expect(LEVEL_WEIGHT.warn).toBeLessThan(LEVEL_WEIGHT.info);
    expect(LEVEL_WEIGHT.info).toBeLessThan(LEVEL_WEIGHT.debug);
    expect(LEVEL_WEIGHT.debug).toBeLessThan(LEVEL_WEIGHT.trace);
  });
});
