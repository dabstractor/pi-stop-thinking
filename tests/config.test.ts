import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, loadConfig, loadConfigFromEnv, validateConfig } from "../src/config";

const FULL_DEFAULTS = {
  enabled: true,
  shortcut: "ctrl+q",
  supportedProviders: ["zai"],
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
  reasoningInjection: true,
  reasoningInjectionDelimiter: {
    open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
    close: "[End of prior reasoning]\n---",
  },
};

describe("DEFAULT_CONFIG", () => {
  test("has the expected default values", () => {
    expect({ ...DEFAULT_CONFIG, supportedProviders: [...DEFAULT_CONFIG.supportedProviders] })
      .toEqual(FULL_DEFAULTS);
  });
  test("the object is frozen", () => expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true));
  test("supportedProviders is frozen", () =>
    expect(Object.isFrozen(DEFAULT_CONFIG.supportedProviders)).toBe(true));
  test("mutating a frozen field throws (strict mode)", () => {
    expect(() => void ((DEFAULT_CONFIG as { enabled?: boolean }).enabled = false)).toThrow();
  });
  test("mutating the frozen supportedProviders array throws", () => {
    expect(() => (DEFAULT_CONFIG.supportedProviders as string[]).push("x")).toThrow();
  });
});

describe("validateConfig — defaults on invalid container input", () => {
  for (const input of [undefined, null, "oops", 42, true, []]) {
    test(`returns full defaults for ${JSON.stringify(input)}`, () => {
      expect(validateConfig(input)).toEqual(FULL_DEFAULTS);
    });
  }
  test("returns full defaults for empty object", () =>
    expect(validateConfig({})).toEqual(FULL_DEFAULTS));
});

describe("validateConfig — per-field fallback (strict types, no coercion)", () => {
  test("enabled", () => {
    expect(validateConfig({ enabled: false }).enabled).toBe(false); // valid
    for (const bad of ["true", 1, 0, null, "yes"]) {
      expect(validateConfig({ enabled: bad }).enabled).toBe(true); // invalid -> default
    }
  });
  test("shortcut", () => {
    expect(validateConfig({ shortcut: "escape" }).shortcut).toBe("escape"); // valid
    for (const bad of [123, true, null, "", undefined]) {
      expect(validateConfig({ shortcut: bad }).shortcut).toBe("ctrl+q"); // invalid -> default
    }
  });
  test("supportedProviders", () => {
    expect(validateConfig({ supportedProviders: ["zai", "openai"] }).supportedProviders)
      .toEqual(["zai", "openai"]); // valid
    // invalid containers / bad elements -> default ["zai"]
    for (const bad of ["zai", 42, null, [], ["zai", ""], ["zai", 7], [42]]) {
      expect(validateConfig({ supportedProviders: bad }).supportedProviders).toEqual(["zai"]);
    }
  });
  test("transitionTimeoutMs (finite & > 0)", () => {
    expect(validateConfig({ transitionTimeoutMs: 1234 }).transitionTimeoutMs).toBe(1234); // valid
    for (const bad of [0, -1, NaN, Infinity, -Infinity, "5", true, null]) {
      expect(validateConfig({ transitionTimeoutMs: bad }).transitionTimeoutMs).toBe(5000);
    }
  });
  test("replacementStartupTimeoutMs (finite & > 0)", () => {
    expect(validateConfig({ replacementStartupTimeoutMs: 250 }).replacementStartupTimeoutMs).toBe(250);
    for (const bad of [0, -5, NaN, Infinity, "10"]) {
      expect(validateConfig({ replacementStartupTimeoutMs: bad }).replacementStartupTimeoutMs).toBe(10000);
    }
  });
  test("maximumReasoningBufferBytes (integer & > 0)", () => {
    expect(validateConfig({ maximumReasoningBufferBytes: 1024 }).maximumReasoningBufferBytes).toBe(1024);
    for (const bad of [0, -1, 1.5, NaN, Infinity, "8", true]) {
      expect(validateConfig({ maximumReasoningBufferBytes: bad }).maximumReasoningBufferBytes)
        .toBe(8388608);
    }
  });
  test("telemetryEnabled", () => {
    expect(validateConfig({ telemetryEnabled: true }).telemetryEnabled).toBe(true);
    for (const bad of ["true", 1, null]) {
      expect(validateConfig({ telemetryEnabled: bad }).telemetryEnabled).toBe(false);
    }
  });
  test("diagnosticsLevel (case-sensitive union)", () => {
    for (const lvl of ["error", "warn", "info", "debug", "trace"] as const) {
      expect(validateConfig({ diagnosticsLevel: lvl }).diagnosticsLevel).toBe(lvl);
    }
    for (const bad of ["ERROR", "verbose", "off", "", 1, null, undefined]) {
      expect(validateConfig({ diagnosticsLevel: bad }).diagnosticsLevel).toBe("error");
    }
  });
  test("reasoningInjection (strict boolean)", () => {
    expect(validateConfig({ reasoningInjection: false }).reasoningInjection).toBe(false); // valid
    expect(validateConfig({ reasoningInjection: true }).reasoningInjection).toBe(true);   // valid
    for (const bad of ["true", 1, 0, null, undefined]) {
      expect(validateConfig({ reasoningInjection: bad }).reasoningInjection).toBe(true);  // invalid -> default
    }
  });
  test("reasoningInjectionDelimiter (open & close both non-empty)", () => {
    // valid: passes through as a fresh copy
    expect(validateConfig({ reasoningInjectionDelimiter: { open: "x", close: "y" } })
      .reasoningInjectionDelimiter).toEqual({ open: "x", close: "y" });
    // invalid: missing a part, empty part, wrong type, null, undefined -> default object
    for (const bad of [
      { open: "x" },            // missing close
      { close: "y" },           // missing open
      { open: "", close: "y" }, // empty open
      "x",                       // non-object (string)
      42,                        // non-object (number)
      [],                        // array (no open/close)
      null,
      undefined,
    ]) {
      expect(validateConfig({ reasoningInjectionDelimiter: bad }).reasoningInjectionDelimiter)
        .toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter });
    }
  });
});

describe("validateConfig — composition rules", () => {
  test("one invalid field does not poison valid fields", () => {
    const r = validateConfig({ enabled: false, transitionTimeoutMs: "bad", shortcut: "escape" });
    expect(r).toEqual({ ...FULL_DEFAULTS, enabled: false, shortcut: "escape" });
  });
  test("one invalid directive field does not poison the other directive field", () => {
    // invalid reasoningInjection (string) -> default true; valid delimiter kept
    const a = validateConfig({ reasoningInjection: "bad", reasoningInjectionDelimiter: { open: "p", close: "q" } });
    expect(a.reasoningInjection).toBe(true);
    expect(a.reasoningInjectionDelimiter).toEqual({ open: "p", close: "q" });
    // valid reasoningInjection kept; invalid delimiter (non-object) -> default
    const b = validateConfig({ reasoningInjection: false, reasoningInjectionDelimiter: "bad" });
    expect(b.reasoningInjection).toBe(false);
    expect(b.reasoningInjectionDelimiter).toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter });
  });
  test("unknown keys are ignored", () => {
    const r = validateConfig({ enabled: false, unknownKey: 123, debugMode: true });
    expect((r as Record<string, unknown>).unknownKey).toBeUndefined();
    expect(r.enabled).toBe(false);
  });
  test("returns a fresh object, not DEFAULT_CONFIG", () => {
    expect(validateConfig({})).not.toBe(DEFAULT_CONFIG);
  });
  test("returns a fresh supportedProviders array, not the default one", () => {
    expect(validateConfig({}).supportedProviders).not.toBe(DEFAULT_CONFIG.supportedProviders);
  });
  test("valid full object round-trips", () => {
    const valid = FULL_DEFAULTS;
    expect(validateConfig(valid)).toEqual(valid);
  });
});

describe("loadConfigFromEnv — production loader (PI_STOP_THINKING_*)", () => {
  const E = "PI_STOP_THINKING_";
  test("empty env yields defaults", () => {
    expect(loadConfigFromEnv({})).toEqual(FULL_DEFAULTS);
  });
  test("parses a shortcut override", () => {
    expect(loadConfigFromEnv({ [E + "SHORTCUT"]: "ctrl+b" }).shortcut).toBe("ctrl+b");
  });
  test("parses booleans (true/false/1/0/yes/no)", () => {
    expect(loadConfigFromEnv({ [E + "ENABLED"]: "false" }).enabled).toBe(false);
    expect(loadConfigFromEnv({ [E + "ENABLED"]: "0" }).enabled).toBe(false);
    expect(loadConfigFromEnv({ [E + "TELEMETRY"]: "yes" }).telemetryEnabled).toBe(true);
  });
  test("parses diagnostics level", () => {
    expect(loadConfigFromEnv({ [E + "DIAGNOSTICS"]: "trace" }).diagnosticsLevel).toBe("trace");
  });
  test("parses comma-separated providers", () => {
    expect(loadConfigFromEnv({ [E + "PROVIDERS"]: "zai, openai" }).supportedProviders)
      .toEqual(["zai", "openai"]);
  });
  test("parses numeric timeouts", () => {
    expect(loadConfigFromEnv({ [E + "TRANSITION_TIMEOUT_MS"]: "2500" }).transitionTimeoutMs).toBe(2500);
  });
  test("invalid values fall back to defaults (never throw, never break)", () => {
    expect(loadConfigFromEnv({ [E + "ENABLED"]: "maybe" }).enabled).toBe(true); // default
    expect(loadConfigFromEnv({ [E + "DIAGNOSTICS"]: "VERBOSE" }).diagnosticsLevel).toBe("error");
    expect(loadConfigFromEnv({ [E + "TRANSITION_TIMEOUT_MS"]: "fast" }).transitionTimeoutMs).toBe(5000);
    expect(loadConfigFromEnv({ [E + "PROVIDERS"]: ",," }).supportedProviders).toEqual(["zai"]);
  });
  test("parses reasoningInjection (true/false/1/0/yes/no)", () => {
    expect(loadConfigFromEnv({ [E + "REASONING_INJECTION"]: "false" }).reasoningInjection).toBe(false);
    expect(loadConfigFromEnv({ [E + "REASONING_INJECTION"]: "0" }).reasoningInjection).toBe(false);
    expect(loadConfigFromEnv({ [E + "REASONING_INJECTION"]: "yes" }).reasoningInjection).toBe(true);
  });
  test("invalid reasoningInjection falls back to default true", () => {
    expect(loadConfigFromEnv({ [E + "REASONING_INJECTION"]: "maybe" }).reasoningInjection).toBe(true);
  });
  test("parses delimiter OPEN-only (CLOSE defaults)", () => {
    const r = loadConfigFromEnv({ [E + "REASONING_INJECTION_DELIMITER_OPEN"]: "<<start>>" });
    expect(r.reasoningInjectionDelimiter.open).toBe("<<start>>");
    expect(r.reasoningInjectionDelimiter.close).toBe(DEFAULT_CONFIG.reasoningInjectionDelimiter.close);
  });
  test("parses delimiter CLOSE-only (OPEN defaults)", () => {
    const r = loadConfigFromEnv({ [E + "REASONING_INJECTION_DELIMITER_CLOSE"]: "<<end>>" });
    expect(r.reasoningInjectionDelimiter.open).toBe(DEFAULT_CONFIG.reasoningInjectionDelimiter.open);
    expect(r.reasoningInjectionDelimiter.close).toBe("<<end>>");
  });
  test("parses delimiter BOTH", () => {
    const r = loadConfigFromEnv({
      [E + "REASONING_INJECTION_DELIMITER_OPEN"]: "<a>",
      [E + "REASONING_INJECTION_DELIMITER_CLOSE"]: "<b>",
    });
    expect(r.reasoningInjectionDelimiter).toEqual({ open: "<a>", close: "<b>" });
  });
  test("empty delimiter values are treated as unset (default delimiter)", () => {
    const r = loadConfigFromEnv({ [E + "REASONING_INJECTION_DELIMITER_OPEN"]: "" });
    expect(r.reasoningInjectionDelimiter).toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter });
  });
  test("no delimiter env => default delimiter", () => {
    expect(loadConfigFromEnv({}).reasoningInjectionDelimiter)
      .toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter });
  });
  test("does not read process.env when an explicit env is passed", () => {
    // Ensures determinism: a stray process.env value must not leak in.
    const orig = process.env[E + "SHORTCUT"];
    process.env[E + "SHORTCUT"] = "ctrl+y";
    try {
      expect(loadConfigFromEnv({}).shortcut).toBe("ctrl+q"); // default, ignores process.env
    } finally {
      if (orig === undefined) delete process.env[E + "SHORTCUT"];
      else process.env[E + "SHORTCUT"] = orig;
    }
  });
});

describe("loadConfig", () => {
  test("no argument returns full defaults (fresh object)", () => {
    const r = loadConfig();
    expect(r).toEqual(FULL_DEFAULTS);
    expect(r).not.toBe(DEFAULT_CONFIG);
  });
  test("merges a partial over defaults", () => {
    expect(loadConfig({ enabled: false })).toEqual({ ...FULL_DEFAULTS, enabled: false });
    expect(loadConfig({ shortcut: "escape" }).shortcut).toBe("escape");
  });
  test("full partial returns all provided values", () => {
    const full = { ...FULL_DEFAULTS, transitionTimeoutMs: 9999 };
    expect(loadConfig(full)).toEqual(full);
  });
  test("still validates: an invalid typed value falls back to default", () => {
    // Partial<Config> is a compile-time guarantee only; runtime value is invalid.
    expect(loadConfig({ transitionTimeoutMs: -5 as unknown as number }).transitionTimeoutMs).toBe(5000);
    expect(loadConfig({ shortcut: "" as unknown as string }).shortcut).toBe("ctrl+q");
  });
  test("returns a fresh object distinct from DEFAULT_CONFIG", () => {
    expect(loadConfig({ enabled: true })).not.toBe(DEFAULT_CONFIG);
  });
});
