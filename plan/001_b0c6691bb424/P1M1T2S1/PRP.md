# PRP — P1.M1.T2.S1: Configuration Module (Config type, defaults, validation)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer)
> **Subtask**: P1.M1.T2.S1 (Phase 0 Foundation, 2 pts) — Configuration module.
> **Builds on**: P1.M1.T1.S1 (project scaffold). Assumes `package.json`, `tsconfig.json`,
> `src/index.ts` (factory stub), and `src/config/.gitkeep` already exist exactly as that PRP
> specifies. **This subtask replaces `src/config/.gitkeep` with a real, pure module.**

---

## Goal

**Feature Goal**: Implement a **dependency-free, pure** Configuration module that defines the
extension's `Config` schema, its frozen immutable defaults, and two validation functions —
`loadConfig(partial?)` and `validateConfig(unknown)` — such that *no invalid value can ever escape
the module*: any missing or invalid field deterministically falls back to its default and normal
provider delegation can never be blocked (PRD §47, Appendix K Configuration Validation Rules).

**Deliverable**:
- `src/config/index.ts` exporting: `Config` interface, `DiagnosticsLevel` type, frozen
  `DEFAULT_CONFIG` constant, `loadConfig(partial?: Partial<Config>): Config`, and
  `validateConfig(config: unknown): Config`.
- Full JSDoc (Mode A) on the `Config` interface and every field (purpose + default value).
- `tests/config.test.ts` — comprehensive Bun unit tests (defaults, immutability, per-field
  fallbacks, merge behavior, fresh-object guarantees).

**Success Definition**: From a clean checkout (after T1 scaffold lands), `bun install &&
bunx tsc --noEmit && bun run build && bun test` all exit 0; `dist/config/index.js` +
`dist/config/index.d.ts` are emitted; `DEFAULT_CONFIG` and its `supportedProviders` array are both
`Object.isFrozen === true`; every test in `tests/config.test.ts` passes; no `@earendil-works/*`
import exists in `src/config/` (module is pure).

---

## Why

- **Single source of truth for all tunable behavior.** Every downstream module reads config:
  P1.M1.T4.S1 (ProviderDecorator — `enabled`, `supportedProviders`), P1.M4.T3.S1 (ShortcutManager —
  `shortcut`), P1.M8.T1.S1 (Telemetry — `telemetryEnabled`), plus timeouts/buffer/diagnostics level.
  A correct, frozen-defaults config is the dependency root for Phase 0→7.
- **Observational-equivalence safety net.** Appendix K mandates that invalid config must *fall back
  to defaults and never prevent normal provider delegation*. Centralizing that rule in
  `validateConfig` guarantees a malformed `pi.registerFlag`/env value can never take the extension
  (or Pi) down — the decorator will simply keep delegating transparently.
- **Deterministic defaults (PRD §47).** Every option resolves to one fixed default; freezing
  `DEFAULT_CONFIG` enforces Appendix G's "Configuration defaults shall be immutable."

## What

A pure TypeScript module with no runtime dependencies on `@earendil-works/*`:
1. `Config` interface — 8 fields, exact types/defaults per the module contract.
2. `DiagnosticsLevel` type alias — `"error" | "warn" | "info" | "debug" | "trace"`.
3. `DEFAULT_CONFIG` — **deep-frozen** constant (object + nested `supportedProviders` array).
4. `validateConfig(config: unknown): Config` — strict per-field type+range validation; invalid/missing
   field → its default; ignores unknown keys; returns fresh objects (never leaks `DEFAULT_CONFIG`
   references); pure (no diagnostics emission).
5. `loadConfig(partial?: Partial<Config>): Config` — merges `partial` over `DEFAULT_CONFIG` then
   validates (so invalid typed values still fall back).
6. JSDoc on the interface and each field.
7. `tests/config.test.ts` covering all of the above.

**Out of scope** (owned by other subtasks — do NOT implement here):
- Reading `pi.getFlag`/env to build the partial → **P1.M1.T5.S1** (init/factory wiring).
- Emitting diagnostics for invalid fields → **P1.M1.T3.S1** (Diagnostics) + **P1.M1.T5.S1** (wiring).
- Wiring `loadConfig()` into `src/index.ts` → **P1.M1.T5.S1**. The factory stub stays empty.

### Success Criteria

- [ ] `src/config/index.ts` exports `Config`, `DiagnosticsLevel`, `DEFAULT_CONFIG`, `loadConfig`,
      `validateConfig` (nothing else required, nothing forbidden-but-keep minimal).
- [ ] `bunx tsc --noEmit` reports **zero** diagnostics.
- [ ] `bun run build` emits `dist/config/index.js` + `dist/config/index.d.ts`.
- [ ] `bun test` passes (all config tests green; existing `tests/smoke.test.ts` still green).
- [ ] `Object.isFrozen(DEFAULT_CONFIG) === true` and
      `Object.isFrozen(DEFAULT_CONFIG.supportedProviders) === true`.
- [ ] Assigning to a frozen field throws in strict mode (Bun runs ESM = strict).
- [ ] `validateConfig(<anything>)` never throws and always returns a fully-valid `Config`.
- [ ] No `import ... from "@earendil-works/..."` in `src/config/index.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the exact interface, default values, validation rules, the full reference
implementation, the exact test cases, and the exact validation commands. No prior Pi-extension
knowledge is required. The only external assumption — that the T1 scaffold exists — is stated
explicitly above with the exact files it produces.

### Documentation & References

```yaml
# MUST READ — authoritative contracts for THIS module
- file: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "The 'Configuration' block defines the exact Config field set, types, defaults, and the
        load()/validate() interface + DiagnosticsLevel union. This is the single source of truth."
  critical: "Field-by-field defaults: enabled=true, shortcut='ctrl+.', supportedProviders=['zai'],
             transitionTimeoutMs=5000, replacementStartupTimeoutMs=10000,
             maximumReasoningBufferBytes=8388608, telemetryEnabled=false, diagnosticsLevel='error'."

- url: (PRD.md in repo root) §47 "Configuration Specification"
  why: "States every option has deterministic defaults; changes apply to future requests only."
  critical: "Do not introduce config-derived runtime mutation of in-flight requests."

- url: (PRD.md in repo root) Appendix K "Configuration Schema" + "Configuration Validation Rules"
  why: "The three validation invariants: validated during init; invalid → produce diagnostics +
        fall back to defaults; NEVER prevent normal provider delegation."
  critical: "validateConfig is the 'fall back to defaults' half. The 'produce diagnostics' half is
             the init flow's job (P1.M1.T5.S1) — this module stays pure and must NOT import Pi APIs."

- url: (PRD.md in repo root) Appendix G "Architectural Success Criteria"
  why: "'Configuration defaults shall be immutable.' → DEFAULT_CONFIG must be frozen (deep)."

- url: (PRD.md in repo root) §55 "Testing Strategy" → "Unit Tests"
  why: "Lists 'Configuration' as an explicit unit-test target — justifies the test file scope."

# REFERENCE — consumer integration (so the exported shape matches what they will call)
- file: plan/001_b0c6691bb424/architecture/system_context.md
  why: "Confirms config.shortcut is passed to pi.registerShortcut as a KeyId (lowercase form,
        e.g. 'ctrl+.'), and config.enabled + config.supportedProviders drive the decorator decision."
  gotcha: "Pi KEYBINDINGS uses lowercase 'ctrl+.', NOT Appendix K's display form 'Ctrl+.'.
           Default must be the lowercase KeyId so registerShortcut works unchanged."
```

### Current Codebase tree (after P1.M1.T1.S1 scaffold lands)

```bash
.
├── package.json          # from T1: name pi-stop-thinking, type module, scripts build/test/typecheck
├── tsconfig.json         # from T1: ES2022, strict, bundler, outDir ./dist, rootDir ./src,
│                         #         include src/**/*.ts, exclude [node_modules, dist, tests]
├── README.md             # from T1 (skeleton)
├── src/
│   ├── index.ts          # from T1: factory STUB (empty body) — DO NOT modify here
│   ├── types.ts          # from T1: placeholder — DO NOT modify here
│   ├── provider/{decorator,proxy}.ts   # from T1 stubs
│   ├── state/{controller,coordinator}.ts
│   ├── config/.gitkeep   # ← THIS becomes src/config/index.ts (remove the .gitkeep)
│   ├── diagnostics/.gitkeep
│   ├── buffer/.gitkeep
│   ├── shortcut/.gitkeep
│   └── request/.gitkeep
├── tests/
│   └── smoke.test.ts     # from T1 (must stay green)
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── package.json          # UNCHANGED (owned by T1) — reuse existing `bun test` / `build` scripts
├── tsconfig.json         # UNCHANGED (owned by T1)
├── src/
│   ├── config/
│   │   └── index.ts      # NEW (replaces .gitkeep) — Config/DiagnosticsLevel/DEFAULT_CONFIG/loadConfig/validateConfig
│   └── ...               # all other T1 files UNCHANGED
├── tests/
│   ├── smoke.test.ts     # UNCHANGED
│   └── config.test.ts    # NEW — Bun unit tests
└── dist/config/{index.js,index.d.ts}  # GENERATED by `bun run build`
```
**File responsibilities**: `src/config/index.ts` = sole runtime surface — schema, frozen defaults,
and two pure validation functions. `tests/config.test.ts` = exhaustive validation/merge/immutability
coverage. No other file is touched.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (scope): This module MUST NOT import @earendil-works/*. Reading flags/env
// (pi.getFlag) and emitting diagnostics are the init flow's job (P1.M1.T5.S1). Keeping it pure
// makes it dependency-free and unit-testable with zero Pi runtime.

// CRITICAL (immutability): Object.freeze is SHALLOW. DEFAULT_CONFIG.supportedProviders must be
// frozen separately, else a consumer doing DEFAULT_CONFIG.supportedProviders.push("x") mutates the
// shared default. Deep-freeze explicitly (object + nested array). Appendix G: "defaults immutable."

// GOTCHA (defaults must not leak for mutation): validateConfig must return a FRESH object with
// COPIED arrays ([...value] / [...DEFAULT_CONFIG.supportedProviders]), never return DEFAULT_CONFIG
// itself nor its internal array. Otherwise a consumer mutating the result would corrupt defaults.

// GOTCHA (strict type validation — NO coercion): enabled: "true" (string) and enabled: 1 (number)
// are INVALID → default. Appendix K says "validate types"; do not coerce.

// GOTCHA (range validation): timeouts accept finite numbers > 0; maximumReasoningBufferBytes
// requires Number.isInteger && > 0 (byte count); supportedProviders is an array where EVERY element
// is a non-empty string (one bad element → whole field falls back). One invalid field must NOT
// poison the other valid fields (per-field fallback).

// GOTCHA (shortcut casing): PRD Appendix K writes the default as "Ctrl+." (display notation), but
// Pi's KeyId format (and the item contract) is lowercase "ctrl+.". Use "ctrl+." so the downstream
// ShortcutManager can pass it straight to pi.registerShortcut.

// GOTCHA (resolution): place the module at src/config/index.ts and import via "./config"
// (from src) / "../src/config" (from tests). moduleResolution:"bundler" and Bun BOTH resolve a
// bare directory to its index.ts. Do NOT name it config.ts (would shadow the dir) — index.ts is
// the intended barrel-for-a-single-module convention.

// GOTCHA (build excludes tests): tsconfig has exclude:["tests"]. So `bunx tsc --noEmit` checks
// src ONLY. tests/config.test.ts is validated by `bun test` (Bun runs TS natively). Do not try to
// add tests to the build include (owned by T1); just run `bun test`.
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// The complete type surface for this module:

export type DiagnosticsLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface Config {
  enabled: boolean;
  shortcut: string;
  supportedProviders: string[];
  transitionTimeoutMs: number;
  replacementStartupTimeoutMs: number;
  maximumReasoningBufferBytes: number;
  telemetryEnabled: boolean;
  diagnosticsLevel: DiagnosticsLevel;
}

export const DEFAULT_CONFIG: Config;            // deep-frozen
export function validateConfig(config: unknown): Config;
export function loadConfig(partial?: Partial<Config>): Config;
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REMOVE src/config/.gitkeep; CREATE src/config/index.ts
  - DELETE: src/config/.gitkeep (the dir is now tracked by index.ts — .gitkeep is redundant).
  - IMPLEMENT: Config interface + DiagnosticsLevel type + DEFAULT_CONFIG + validateConfig + loadConfig
    EXACTLY per the reference implementation in "Implementation Patterns" below.
  - NAMING: PascalCase types (Config, DiagnosticsLevel); UPPER_SNAKE constant (DEFAULT_CONFIG);
    camelCase functions (loadConfig, validateConfig).
  - JSDOC (Mode A): document Config interface + EVERY field (purpose + default value) per the
    reference below. Also JSDoc the two functions (purpose, purity, fallback behavior).
  - PLACEMENT: src/config/index.ts (single module; dir import resolves via bundler/Bun).
  - GOTCHA: DEFAULT_CONFIG deep-frozen; validateConfig returns fresh copies; no Pi imports.

Task 2: CREATE tests/config.test.ts
  - IMPLEMENT: the test suite specified in "Test Specification" below using `bun:test`.
  - IMPORT: `import { DEFAULT_CONFIG, loadConfig, validateConfig } from "../src/config";`
    (also `import type { Config } from "../src/config";` if referenced).
  - FOLLOW pattern: tests/smoke.test.ts (Bun `test`/`expect` style; no extra test framework).
  - NAMING: describe("DEFAULT_CONFIG" / "validateConfig" / "loadConfig"); test("...") descriptive.
  - COVERAGE: defaults object, deep-freeze (object + supportedProviders), strict-mutation throws,
    validateConfig happy/defaults/per-field-fallback/unknown-keys/fresh-objects,
    loadConfig merge/validate/fresh-object, DiagnosticsLevel union acceptance.
  - PLACEMENT: tests/config.test.ts (matches scaffold flat tests/ dir; excluded from build).

Task 3: VERIFY (no code changes — validation only)
  - RUN: bunx tsc --noEmit  → 0 diagnostics.
  - RUN: bun run build      → dist/config/index.js + dist/config/index.d.ts created.
  - RUN: bun test           → all green (config tests + existing smoke test).
  - RUN: purity check (Level 4) → no @earendil-works import in src/config.
```

### Implementation Patterns & Key Details

```typescript
// src/config/index.ts — COMPLETE reference implementation. Author this (JSDoc included).

/**
 * Diagnostics verbosity level (PRD §36 + Appendix M trace levels).
 * The DEFAULT is `"error"` (PRD Appendix K). PRD §36 "Diagnostics disabled by default" concerns the
 * Diagnostics MODULE (no verbose/trace logging) — this field merely stores the requested level.
 */
export type DiagnosticsLevel = "error" | "warn" | "info" | "debug" | "trace";

/**
 * Configuration for the Stop Thinking & Do extension.
 *
 * Every field has a deterministic default (see {@link DEFAULT_CONFIG}). Configuration is validated
 * during extension initialization; any invalid field deterministically falls back to its default and
 * NEVER prevents normal provider delegation (PRD Appendix K — Configuration Validation Rules).
 * Configuration changes apply only to future requests (PRD §47).
 */
export interface Config {
  /** Master switch. When `false`, the provider decorator delegates transparently (EC-016). Default: `true`. */
  enabled: boolean;
  /** Keyboard shortcut (Pi `KeyId`, lowercase) that raises the stop signal. Default: `"ctrl+."`. */
  shortcut: string;
  /** Provider ids whose reasoning streams may be interrupted (decorator activation check A). Default: `["zai"]`. */
  supportedProviders: string[];
  /** Hard ceiling (ms) for the full reasoning→answer transition before it fails (PRD §43). Default: `5000`. */
  transitionTimeoutMs: number;
  /** Timeout (ms) waiting for the replacement stream's first event (PRD §43). Default: `10000`. */
  replacementStartupTimeoutMs: number;
  /** Max bytes captured by the reasoning buffer before overflow handling (PRD §23.4). Default: `8388608` (8 MiB). */
  maximumReasoningBufferBytes: number;
  /** Whether anonymous telemetry metrics are emitted (PRD Appendix I). Default: `false`. */
  telemetryEnabled: boolean;
  /** Diagnostics verbosity level. Default: `"error"`. */
  diagnosticsLevel: DiagnosticsLevel;
}

/**
 * Frozen, immutable default configuration (PRD §47 + Appendix K; immutability required by Appendix G).
 * Deep-frozen: the object AND its `supportedProviders` array are both `Object.isFrozen`.
 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enabled: true,
  shortcut: "ctrl+.",
  supportedProviders: Object.freeze(["zai"]),
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
}) as Config;

// --- per-field type guards (strict; NO coercion) ---
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPositiveFinite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const isPositiveInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmptyStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((el) => typeof el === "string" && el.length > 0);
const DIAGNOSTICS_LEVELS: readonly DiagnosticsLevel[] = ["error", "warn", "info", "debug", "trace"];
const isDiagnosticsLevel = (v: unknown): v is DiagnosticsLevel =>
  typeof v === "string" && (DIAGNOSTICS_LEVELS as readonly string[]).includes(v);

/** Return `value` when it satisfies `guard`, otherwise `fallback`. */
function pick<T>(value: unknown, guard: (v: unknown) => v is T, fallback: T): T {
  return guard(value) ? value : fallback;
}

/**
 * Validate an unknown configuration object and return a fully-valid {@link Config}.
 *
 * Behavior (PRD Appendix K — Configuration Validation Rules):
 *  - Missing or invalid field → that field's default (per-field fallback; one bad field does NOT
 *    invalidate the rest). Unknown keys are ignored.
 *  - Strict type checks — no coercion (`enabled: "true"` is invalid → default `true`).
 *  - Ranges: timeouts finite & > 0; `maximumReasoningBufferBytes` integer & > 0;
 *    `supportedProviders` an array of non-empty strings; `shortcut` a non-empty string;
 *    `diagnosticsLevel` one of the allowed literals (case-sensitive).
 *
 * Pure: never throws, never emits diagnostics (diagnostics-on-invalid is the init flow's job,
 * P1.M1.T5.S1). Returns a fresh object with copied arrays — never exposes {@link DEFAULT_CONFIG}
 * references for mutation.
 */
export function validateConfig(config: unknown): Config {
  const src =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  return {
    enabled: pick(src.enabled, isBool, DEFAULT_CONFIG.enabled),
    shortcut: pick(src.shortcut, isNonEmptyString, DEFAULT_CONFIG.shortcut),
    supportedProviders: isNonEmptyStringArray(src.supportedProviders)
      ? [...src.supportedProviders]
      : [...DEFAULT_CONFIG.supportedProviders],
    transitionTimeoutMs: pick(src.transitionTimeoutMs, isPositiveFinite, DEFAULT_CONFIG.transitionTimeoutMs),
    replacementStartupTimeoutMs: pick(
      src.replacementStartupTimeoutMs,
      isPositiveFinite,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
    ),
    maximumReasoningBufferBytes: pick(
      src.maximumReasoningBufferBytes,
      isPositiveInteger,
      DEFAULT_CONFIG.maximumReasoningBufferBytes,
    ),
    telemetryEnabled: pick(src.telemetryEnabled, isBool, DEFAULT_CONFIG.telemetryEnabled),
    diagnosticsLevel: pick(src.diagnosticsLevel, isDiagnosticsLevel, DEFAULT_CONFIG.diagnosticsLevel),
  };
}

/**
 * Merge a (typed) partial configuration over {@link DEFAULT_CONFIG} and validate.
 *
 * Equivalent to `validateConfig({ ...DEFAULT_CONFIG, ...(partial ?? {}) })`. Because `Partial<Config>`
 * is only a compile-time guarantee, runtime-invalid values in `partial` still fall back to their
 * defaults — so no invalid value can ever escape.
 */
export function loadConfig(partial?: Partial<Config>): Config {
  return validateConfig({ ...DEFAULT_CONFIG, ...(partial ?? {}) });
}
```

```typescript
// tests/config.test.ts — reference test suite (implement with bun:test).

import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, loadConfig, validateConfig } from "../src/config";

const FULL_DEFAULTS = {
  enabled: true,
  shortcut: "ctrl+.",
  supportedProviders: ["zai"],
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
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
      expect(validateConfig({ shortcut: bad }).shortcut).toBe("ctrl+."); // invalid -> default
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
});

describe("validateConfig — composition rules", () => {
  test("one invalid field does not poison valid fields", () => {
    const r = validateConfig({ enabled: false, transitionTimeoutMs: "bad", shortcut: "escape" });
    expect(r).toEqual({ ...FULL_DEFAULTS, enabled: false, shortcut: "escape" });
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
    expect(loadConfig({ shortcut: "" as unknown as string }).shortcut).toBe("ctrl+.");
  });
  test("returns a fresh object distinct from DEFAULT_CONFIG", () => {
    expect(loadConfig({ enabled: true })).not.toBe(DEFAULT_CONFIG);
  });
});
```

### Integration Points

```yaml
CONSUMERS (downstream PRPs import from this module — DO NOT implement them here):
  P1.M1.T4.S1 (ProviderDecorator): reads config.enabled, config.supportedProviders
    (decorator decision tree §19.6 conditions A/C).
  P1.M4.T3.S1 (ShortcutManager): passes config.shortcut to pi.registerShortcut.
  P1.M8.T1.S1 (Telemetry): gates emission on config.telemetryEnabled.
  Timeouts/buffer: config.transitionTimeoutMs / replacementStartupTimeoutMs /
    maximumReasoningBufferBytes / diagnosticsLevel consumed by later phases.

  Import shape they will use:
    import { loadConfig } from "./config";              // from src modules
    import type { Config } from "./config";
    const config: Config = loadConfig(await readPartialFromFlags(pi));  // T5 reads flags

BUILD:
  - entry: src/config/index.ts
  - emit: dist/config/index.js + dist/config/index.d.ts (tsc, rootDir src / outDir dist)
  - resolution: dir import "./config" → "./config/index.ts" (bundler + Bun index resolution)

NO CHANGES TO: package.json, tsconfig.json, src/index.ts, .gitignore (all owned by T1 or forbidden).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — that's intentional, owned by T1):
bunx tsc --noEmit            # or: bun run typecheck
# Expected: ZERO diagnostics. A "Cannot find name 'Object'"-class error would mean a typo;
#   an error about "./config" resolution → confirm file is src/config/index.ts.

# Build (emit dist):
bun run build                # = tsc
# Expected: dist/config/index.js and dist/config/index.d.ts created; exit 0.
ls dist/config/              # must show index.js + index.d.ts (+ maps)
```

### Level 2: Unit Tests (Component Validation)

```bash
# Run the config suite alone:
bun test tests/config.test.ts
# Expected: all green (defaults, deep-freeze, per-field fallbacks, merge, fresh-object checks).

# Full suite (config tests + existing smoke test):
bun test
# Expected: every test passes; nothing regressed.
```
> Bun test API: https://bun.sh/docs/test/writers (uses `import { test, expect, describe } from "bun:test"`).

### Level 3: Integration (Package Integrity)

```bash
# Verify the emitted module is importable as built JS and exports the public API:
node -e "import('./dist/config/index.js').then(m => console.log('exports:', Object.keys(m).sort().join(',')))"
# Expected: includes DEFAULT_CONFIG, loadConfig, validateConfig.

# Verify immutability at the built boundary:
node -e "import('./dist/config/index.js').then(m => {
  const c = m.DEFAULT_CONFIG;
  console.log('object frozen:', Object.isFrozen(c));
  console.log('array frozen:', Object.isFrozen(c.supportedProviders));
  console.log('defaults:', JSON.stringify(c));
});"
# Expected: object frozen: true | array frozen: true | defaults: {...ctrl+. / zai / 5000 ...}

# Verify validateConfig never throws on hostile input via the built artifact:
node -e "import('./dist/config/index.js').then(m => {
  const tries = [undefined, null, 1, 'x', [], {}, {enabled:'true', shortcut:'', supportedProviders:[1,2]},
    {transitionTimeoutMs:-1, maximumReasoningBufferBytes:1.5, diagnosticsLevel:'LOUD'}];
  for (const t of tries) console.log(JSON.stringify(m.validateConfig(t)));
});"
# Expected: each line is a complete, valid defaults-or-merged Config object; no exceptions.
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Purity gate — the config module must NOT depend on Pi APIs (stays unit-testable, init-flow-owned):
grep -c "@earendil-works" src/config/index.ts
# Expected: 0   (any match = scope violation — diagnostics/flag reading belongs to P1.M1.T5.S1).

# Scope gate — do not wire config into the factory (owned by P1.M1.T5.S1):
grep -c "config\|loadConfig\|validateConfig\|DEFAULT_CONFIG" src/index.ts
# Expected: 0   (the factory stub must remain untouched in this subtask).

# Confirm the .gitkeep was replaced (dir now tracked by a real file):
test ! -f src/config/.gitkeep && test -f src/config/index.ts && echo "config module placement OK"

# Confirm git sees only the intended changes (no edits to T1-owned files):
git add -A && git status --short
# Expected NEW files only: src/config/index.ts, tests/config.test.ts
#   (and the src/config/.gitkeep deletion). package.json/tsconfig.json/src/index.ts unchanged.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `bunx tsc --noEmit` → **zero** diagnostics.
- [ ] `bun run build` emits `dist/config/index.js` + `dist/config/index.d.ts`.
- [ ] `bun test tests/config.test.ts` → all green.
- [ ] `bun test` → all green (smoke test still passing).
- [ ] Built module `node -e` import prints the expected exports and never throws on hostile input.

### Feature Validation
- [ ] Exports: `Config`, `DiagnosticsLevel`, `DEFAULT_CONFIG`, `loadConfig`, `validateConfig`.
- [ ] Field defaults EXACTLY: enabled `true`, shortcut `"ctrl+."`, supportedProviders `["zai"]`,
      transitionTimeoutMs `5000`, replacementStartupTimeoutMs `10000`,
      maximumReasoningBufferBytes `8388608`, telemetryEnabled `false`, diagnosticsLevel `"error"`.
- [ ] `validateConfig(<any input>)` never throws and always returns a complete valid `Config`.
- [ ] Per-field fallback: one invalid field does not poison valid fields; unknown keys ignored.
- [ ] `loadConfig` merges over defaults AND still validates (invalid typed values fall back).
- [ ] JSDoc present on `Config` interface and all 8 fields (Mode A).

### Code Quality Validation
- [ ] `Object.isFrozen(DEFAULT_CONFIG)` and `Object.isFrozen(DEFAULT_CONFIG.supportedProviders)` both `true`.
- [ ] `validateConfig`/`loadConfig` return fresh objects/copies (no `DEFAULT_CONFIG` reference leaked).
- [ ] No `@earendil-works/*` import in `src/config/index.ts` (pure module).
- [ ] `src/index.ts` (factory) untouched; no edits to `package.json`/`tsconfig.json`/`.gitignore`.

### Documentation & Deployment
- [ ] JSDoc on both functions documents purity and fallback behavior.
- [ ] `dist/config/index.d.ts` carries the JSDoc for downstream consumers.

---

## Anti-Patterns to Avoid

- ❌ Don't import `@earendil-works/*` (or any Pi API) in `src/config/` — reading flags/env and
  emitting diagnostics are the init flow's job (P1.M1.T5.S1). Keep the module pure.
- ❌ Don't coerce types ("true"→true, 1→true). Strict validation only; invalid → default (Appendix K).
- ❌ Don't shallow-freeze only — `supportedProviders` must also be frozen, or the shared default can be mutated.
- ❌ Don't return `DEFAULT_CONFIG` (or its internal array) from `validateConfig`/`loadConfig` — return
  fresh copies so consumers cannot mutate the frozen defaults.
- ❌ Don't make one invalid field invalidate the whole config — per-field fallback is required.
- ❌ Don't wire `loadConfig()` into `src/index.ts` or read flags here — that's P1.M1.T5.S1 scope.
- ❌ Don't default `shortcut` to `"Ctrl+."` (display notation) — use the lowercase `KeyId` `"ctrl+."`.
- ❌ Don't modify `package.json`, `tsconfig.json`, `.gitignore`, or `src/index.ts` (owned by T1 / forbidden).

---

## Confidence Score: **9/10**

This is a small, deterministic, dependency-free module with the full reference implementation and
test suite inlined, exact field defaults/types/ranges specified, and validated build/test commands.
Residual risk is minimal: (a) confirming bundler/Bun index resolution for `./config` (well-supported,
mitigated by the explicit gotcha); (b) the deliberate shortcut-casing/diagnostics-level
interpretations, both documented as decisions grounded in the contracts. No behavioral coupling to
unbuilt modules — consumers import only the exported pure API later.
