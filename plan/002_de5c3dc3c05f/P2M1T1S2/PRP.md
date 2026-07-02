# PRP — P2.M1.T1.S2: Add env-var parsing for directive fields in loadConfigFromEnv

---

## Goal

**Feature Goal**: Teach `loadConfigFromEnv` (in `src/config/index.ts`) to recognize and parse three
new `PI_STOP_THINKING_*` environment variables for the Ephemeral Execution Directive fields that
P2.M1.T1.S1 added to the `Config` schema — `PI_STOP_THINKING_REASONING_INJECTION` (bool) and
`PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` / `..._CLOSE` (non-empty strings) — and merge
them into the `partial` object that is spread over `DEFAULT_CONFIG` before `validateConfig`. An
unset or invalid value is always omitted so the field falls back to its default (PRD Appendix K h2.210
/ h2.211: "Fall back to defaults", "Never prevent normal provider delegation").

**Deliverable**: A modified `loadConfigFromEnv` (and its JSDoc) where:
1. `PI_STOP_THINKING_REASONING_INJECTION` is parsed via the existing `envBool()` helper into
   `partial.reasoningInjection` (omitted when `undefined`).
2. `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` / `..._CLOSE` are read as raw strings; when
   EITHER is a non-empty string, `partial.reasoningInjectionDelimiter` is constructed as a complete
   `{ open, close }` object (the missing/empty side coalesces to the default via `??`).
3. A short **Configurable surface** list documenting all three env-var names is added to the
   `loadConfigFromEnv` JSDoc (no "Configurable surface" list exists in code today — see Context).
Plus a focused set of env-parsing tests appended to the existing `describe("loadConfigFromEnv")`
block in `tests/config.test.ts`.

**Success Definition**:
- `bun run typecheck` (`tsc --noEmit`) passes with zero errors on `src/`.
- `bun test tests/config.test.ts` passes (existing suite stays green; new env-parsing tests pass).
- `loadConfigFromEnv({ [ENV_PREFIX + "REASONING_INJECTION"]: "false" }).reasoningInjection === false`.
- `loadConfigFromEnv({ [ENV_PREFIX + "REASONING_INJECTION"]: "maybe" }).reasoningInjection === true`
  (invalid → default, per Appendix K).
- Setting only the OPEN delimiter var yields a delimiter whose `close` equals the §53 default and
  whose `open` equals the supplied value; the reverse holds for CLOSE-only.
- `loadConfigFromEnv({})` still `toEqual(FULL_DEFAULTS)` (no regression — relies on S1's
  `FULL_DEFAULTS` update being present).

## User Persona (if applicable)

**Target User**: Operator/admin who configures the extension via `PI_STOP_THINKING_*` env vars (Pi
exposes no settings object — PRD §47 / h2.211).
**Use Case**: Disable reasoning reuse (`..._REASONING_INJECTION=false`) or customize the fence text
wrapping the injected reasoning block (`..._DELIMITER_OPEN` / `..._CLOSE`).
**User Journey**: Set env var in shell/launcher → start `pi` → extension init calls
`loadConfigFromEnv(process.env)` → directive config takes effect for future requests only (§47).
**Pain Points Addressed**: No way today to toggle/customize the reasoning-reuse directive from the
shell (fields exist in the schema after S1 but are unreachable from env until this task).

## Why

- **Business value**: This is the runtime-config half of ADR-006 / PRD §53 "Ephemeral Execution
  Directive". S1 added the fields + validation; S2 makes them operator-controllable. Without S2 the
  directive is permanently locked to defaults.
- **Integration**: P2.M1.T1.S1 produces the `Config` fields, `DEFAULT_CONFIG.reasoningInjectionDelimiter`,
  and `validateConfig` (with `isOpenCloseShape`). S2 consumes those — it ONLY touches
  `loadConfigFromEnv` + its JSDoc + S2-specific tests. Downstream P2.M2.* reads the validated config;
  P2.M3.T1.S1 adds deeper validateConfig edge-case tests; P2.M3.T2.S1 updates the README config table.
- **Problems solved**: Operators cannot today influence the reasoning-reuse feature. Env vars are the
  ONLY configuration channel (h2.211), so parsing them is mandatory for the feature to be configurable.

## What

User-visible behavior is configuration-only (no streaming/UI change). Observable contract for
`loadConfigFromEnv`:

1. **`PI_STOP_THINKING_REASONING_INJECTION`** → `envBool()` → `partial.reasoningInjection`.
   Omitted when `undefined` (unset or unrecognized value like `"maybe"`); `validateConfig` then
   applies the default `true`. Accepts the existing bool vocabulary (`true/1/yes/on`,
   `false/0/no/off`, case-insensitive).
2. **`PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN`** and **`..._CLOSE`** → raw string read.
   A value is "set" only when it is a **non-empty** string (`length > 0`, mirroring the existing
   `shortcut`/`diag` parse). If EITHER open or close is set, construct a COMPLETE delimiter object:
   `{ open: delimOpen ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.open,
       close: delimClose ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.close }`.
   If NEITHER is set, omit `partial.reasoningInjectionDelimiter` entirely (validateConfig fills the
   default). (Because defaults are non-empty, the constructed object always has two non-empty strings,
   so S1's `isOpenCloseShape` always passes — the env path can never trigger the whole-object fallback.)
3. Invalid/unparseable values silently fall back to defaults (PRD h2.210) — an unset or invalid value
   never prevents normal provider delegation (h2.211).
4. **Docs (Mode A)**: the three env-var names are documented in the `loadConfigFromEnv` JSDoc (a new
   "Configurable surface" list — none exists in code today; see Context).

### Success Criteria

- [ ] `loadConfigFromEnv` parses `REASONING_INJECTION` via `envBool`, omitting when `undefined`.
- [ ] `loadConfigFromEnv` parses `REASONING_INJECTION_DELIMITER_OPEN/CLOSE`, constructing a complete
      `{open,close}` object when EITHER is a non-empty string (missing side `??` default), omitting
      the field when NEITHER is set.
- [ ] Empty-string delimiter values are treated as UNSET (never leak an empty string into the partial).
- [ ] `loadConfigFromEnv` JSDoc documents all three new env-var names (added "Configurable surface" list).
- [ ] `loadConfigFromEnv` signature, return type, and `validateConfig`-delegation are unchanged.
- [ ] Existing `loadConfigFromEnv` tests stay green; new env-parsing tests added & pass.
- [ ] `bun run typecheck` passes; `bun test` passes.

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes** — this PRP names the single source file, gives the exact function to modify,
quotes the EXACT existing parsing patterns to mirror (verbatim style for `envBool`/non-empty-string),
specifies the precise delimiter-assembly logic (incl. the `??`-empties gotcha), confirms the JSDoc
gap (no existing "Configurable surface" list → add one), defines the test pattern (`loadConfigFromEnv({ [E+...]: ... })`),
and states the verified validation commands. It also pins the dependency on the parallel task S1
(whose outputs are treated as a hard contract). No external libraries are involved.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: src/config/index.ts
  why: THE ONLY source file to modify. loadConfigFromEnv (currently line 215, shifts to ~252 after
        S1's edits) ends in `return validateConfig({ ...DEFAULT_CONFIG, ...partial });`. New parsing
        goes IMMEDIATELY BEFORE that return, after the existing `diag` block.
  pattern: Mirror the EXACT existing per-field shapes — envBool for the bool; raw read + non-empty
           guard (`!== undefined && length > 0`) for the two string delimiter vars. See Implementation
           Tasks for the exact block.
  gotcha: LOCATE the insertion point by the function name / the final `return validateConfig(...)`
           line — NOT by absolute line number, because S1 inserts ~37 lines above this function.
  gotcha: The "Configurable surface" list referenced by the work-item contract does NOT currently
           exist in this JSDoc (grep-verified). You must ADD it (short bullet list of env vars),
           not "update" one. README config table is out of scope (P2.M3.T2.S1).

- file: tests/config.test.ts
  why: The `describe("loadConfigFromEnv — production loader (PI_STOP_THINKING_*)")` block (uses
        `const E = "PI_STOP_THINKING_"`) is where new env-parsing tests go. `FULL_DEFAULTS` (line ~4)
        is compared via `toEqual` against `loadConfigFromEnv({})`.
  pattern: `expect(loadConfigFromEnv({ [E + "X"]: "v" }).field).toBe(expected)`.
  gotcha: S1 already extended FULL_DEFAULTS with the 2 new fields — do NOT re-add them. Existing
           `loadConfigFromEnv({})` ⇒ `toEqual(FULL_DEFAULTS)` stays green automatically (empty env
           omits the new partial keys → validateConfig fills defaults).

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: Authoritative contract for the reasoning-reuse delta.
  section: §6 "Config Type Additions" — lists the exact env-var names and the per-field parse helpers
           (`REASONING_INJECTION` → envBool; `..._DELIMITER_OPEN/CLOSE` → non-empty string).

- docfile: plan/002_de5c3dc3c05f/P2M1T1S1/PRP.md
  why: The DEPENDENCY. S1 produces the Config fields, DEFAULT_CONFIG.reasoningInjectionDelimiter
        (frozen, with the §53 fence strings), validateConfig (isOpenCloseShape + whole-object
        fallback), and the FULL_DEFAULTS test update. S2 assumes all of that is present.
  section: "Success Criteria" + "Implementation Tasks (Task 4 validateConfig, Task 5 FULL_DEFAULTS)".

- docfile: plan/002_de5c3dc3c05f/P2M1T1S2/research/env_parsing_patterns.md
  why: Companion research note — line-anchoring, the `??`-empties gotcha proof, why the env path
        can never hit the whole-object fallback, and the JSDoc "Configurable surface" gap.

- url: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Nullish_coalescing
  why: Nullish coalescing (`??`) — ONLY coalesces null/undefined, NOT empty-string/0/false.
  critical: `"" ?? default === ""` (empty string survives!). So the delimiter locals MUST be
           pre-normalized to `undefined` for empty/missing values BEFORE applying `??`. The naive
           `env[...] ?? DEFAULT` is WRONG for a present-but-empty env value.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/
  config/index.ts        # <-- MODIFY: loadConfigFromEnv (+ JSDoc). Interface/DEFAULT_CONFIG/
                          #                  validateConfig are S1's edits — already present.
  request/builder.ts     # NOT touched (consumes Config in P2.M2.*)
  provider/{decorator,proxy}.ts  # NOT touched (wiring in P2.M2.T3.*)
tests/
  config.test.ts         # <-- MODIFY: append env-parsing tests to describe("loadConfigFromEnv")
package.json             # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit
tsconfig.json            # strict:true; EXCLUDES "tests" from tsc (typecheck covers src/ only)
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. Two MODIFIED files:
src/config/index.ts     # +3 env-var parses in loadConfigFromEnv (REASONING_INJECTION,
                        #   REASONING_INJECTION_DELIMITER_OPEN/CLOSE),
                        # + "Configurable surface" bullet list in loadConfigFromEnv JSDoc.
tests/config.test.ts    # + focused env-parsing tests in describe("loadConfigFromEnv"):
                        #   reasoningInjection (true/false/invalid), delimiter open-only / close-only
                        #   / both / neither. (No validateConfig edge-case tests — that's M3.)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: S1 inserts ~37 lines ABOVE loadConfigFromEnv (interface +2 fields/JSDoc, DEFAULT_CONFIG
// +nested freeze, isOpenCloseShape guard, validateConfig return +2 lines). So loadConfigFromEnv will
// have shifted from line 215 to ~252. LOCATE IT BY NAME / by the final `return validateConfig(...)`
// line — never by a hard line number.

// CRITICAL (?? empties gotcha): `"" ?? default === ""` — empty string is NOT nullish, so `??` does
// NOT coalesce it. A present-but-empty env value would leak an empty string into the delimiter,
// which S1's isOpenCloseShape (.length > 0) then rejects → whole-object default (happens to be
// correct output, but via the wrong path AND contradicts the contract's "treat empty as unset").
// FIX: normalize each delimiter local to `undefined` when missing OR empty, THEN apply `??`:
//   const delimOpen = rawOpen !== undefined && rawOpen.length > 0 ? rawOpen : undefined;
//   ... partial.reasoningInjectionDelimiter.open = delimOpen ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.open;

// CRITICAL: the delimiter locals must be `string | undefined` (normalized) so the `?? default`
// expression type-checks cleanly and the "if EITHER is set" condition reads
// `delimOpen !== undefined || delimClose !== undefined`. Do NOT store the raw `env[...]` value
// (which is `string | undefined` but where "" is a defined-but-empty string).

// CRITICAL: tsconfig.json EXCLUDES "tests" from tsc --noEmit. Run BOTH `bun run typecheck` (src)
// AND `bun test` (src + tests). Tests are runtime-type-stripped by bun.

// CRITICAL: bun:test expect(...).toEqual() requires EXACT deep key match. S1 already updated
// FULL_DEFAULTS for the 2 new fields — do NOT modify FULL_DEFAULTS again. loadConfigFromEnv({})
// omits the new partial keys → validateConfig fills defaults → still === FULL_DEFAULTS. ✓

// REASSURING: because DEFAULT_CONFIG.reasoningInjectionDelimiter.open/close are non-empty (§53
// fence) and normalized user values are non-empty-or-coalesced, the constructed delimiter object
// ALWAYS has two non-empty strings → isOpenCloseShape ALWAYS passes. The env path NEVER triggers
// the delimiter whole-object fallback. (That fallback is only reachable via direct
// loadConfig({...}) / validateConfig({...}) — tested in P2.M3.T1.S1, not reachable here.)

// envBool vocabulary (existing helper, do NOT reimplement): true/1/yes/on, false/0/no/off
// (case-insensitive, trimmed). Anything else → undefined → field omitted → default.
```

## Implementation Blueprint

### Data models and structure

No new data models. S2 reads two kinds of env values:
- `reasoningInjection` → `boolean | undefined` via the existing `envBool(raw: string | undefined)`.
- delimiter open/close → `string | undefined` (normalized: a non-empty string, else `undefined`).

The assembly target is `partial.reasoningInjectionDelimiter: { open: string; close: string }` — a
plain inline object, matching the `Config.reasoningInjectionDelimiter` type S1 added.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 0: CONFIRM S1 dependency is present (read-only sanity check — do NOT modify S1's work)
  - VERIFY src/config/index.ts already has: Config.reasoningInjection / Config.reasoningInjectionDelimiter,
    DEFAULT_CONFIG.reasoningInjection (true) / DEFAULT_CONFIG.reasoningInjectionDelimiter (frozen fence),
    isOpenCloseShape guard, validateConfig lines for both fields.
  - VERIFY tests/config.test.ts FULL_DEFAULTS already includes reasoningInjection + delimiter.
  - IF absent: S1 has not landed yet — STOP and report (this PRP assumes S1 is complete).
  - WHY: S2 reads DEFAULT_CONFIG.reasoningInjectionDelimiter.open/.close and relies on validateConfig
    validating both. (Per parallel-execution context, S1's PRP is a hard contract.)

Task 1: MODIFY src/config/index.ts — add the REASONING_INJECTION bool parse in loadConfigFromEnv
  - LOCATE loadConfigFromEnv (by name / final `return validateConfig({ ...DEFAULT_CONFIG, ...partial });`).
  - INSERT after the existing `diag` block, before the return:
        const reasoningInjection = envBool(env[ENV_PREFIX + "REASONING_INJECTION"]);
        if (reasoningInjection !== undefined) partial.reasoningInjection = reasoningInjection;
  - FOLLOW pattern: EXACTLY the `enabled`/`telemetry` lines (envBool → guard undefined → assign).
  - NAMING: local `reasoningInjection` (matches field); key suffix `"REASONING_INJECTION"`.

Task 2: MODIFY src/config/index.ts — add the delimiter OPEN/CLOSE parse + assembly in loadConfigFromEnv
  - INSERT immediately after Task 1's block, before the return:
        const rawDelimOpen = env[ENV_PREFIX + "REASONING_INJECTION_DELIMITER_OPEN"];
        const rawDelimClose = env[ENV_PREFIX + "REASONING_INJECTION_DELIMITER_CLOSE"];
        const delimOpen = rawDelimOpen !== undefined && rawDelimOpen.length > 0 ? rawDelimOpen : undefined;
        const delimClose = rawDelimClose !== undefined && rawDelimClose.length > 0 ? rawDelimClose : undefined;
        if (delimOpen !== undefined || delimClose !== undefined) {
          partial.reasoningInjectionDelimiter = {
            open: delimOpen ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.open,
            close: delimClose ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.close,
          };
        }
  - CRITICAL: the two `delim*` locals are normalized to `undefined` for missing/empty BEFORE `??`
    (see gotcha — `"" ?? default === ""` would be wrong). This makes empty == unset, matching the
    contract ("if non-empty string → store") and the existing shortcut/diag non-empty guard.
  - CRITICAL: the assembly is all-or-nothing — when EITHER side is set, BOTH sides are populated
    (missing side coalesces to default). Do NOT set `partial.reasoningInjectionDelimiter` to a
    partial `{open}` / `{close}` object.
  - FOLLOW pattern: the raw-read + `length > 0` guard mirrors the existing `shortcut`/`diag` lines;
    the `?? DEFAULT_CONFIG...` coalescing mirrors the spread-default style of the final return.
  - DEPENDENCIES: reads DEFAULT_CONFIG.reasoningInjectionDelimiter.open/.close (added by S1).

Task 3: MODIFY src/config/index.ts — document the three env vars in the loadConfigFromEnv JSDoc
  - ADD a "Configurable surface" bullet list to the loadConfigFromEnv JSDoc (between the general
    description and the existing **Limitations** section). Mirror PRD §47/h1.41. Include the THREE
    new vars, and (recommended) the existing ones for completeness:
        * `PI_STOP_THINKING_REASONING_INJECTION` — enable/disable the directive (bool; default true).
        * `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` / `_CLOSE` — delimiter fence text
          (non-empty strings; defaults are the §53 fence).
        * (existing) SHORTCUT, ENABLED, PROVIDERS, MAX_REASONING_BUFFER_BYTES,
          TRANSITION_TIMEOUT_MS, REPLACEMENT_TIMEOUT_MS, DIAGNOSTICS, TELEMETRY.
  - GOTCHA: NO "Configurable surface" list exists in code today (grep-verified) — you are ADDING it,
    not editing one. The contract's word "update" presumes its existence; resolve by adding.
  - DO NOT touch README.md (config table update is P2.M3.T2.S1's scope).
  - FOLLOW style: terse bullets, reference PRD §47/§53, state the default per var (matches the JSDoc
    style on the Config fields S1 added and the existing Limitations bullets).

Task 4: MODIFY tests/config.test.ts — append focused env-parsing tests to describe("loadConfigFromEnv")
  - ADD (inside the existing `describe("loadConfigFromEnv — production loader ...")`, `const E`):
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
        // OPEN empty => treated as unset => NEITHER set => field omitted => validateConfig default.
        expect(r.reasoningInjectionDelimiter).toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter });
      });
      test("no delimiter env => default delimiter", () => {
        expect(loadConfigFromEnv({}).reasoningInjectionDelimiter)
          .toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter });
      });
  - IMPORT: ensure `DEFAULT_CONFIG` is in the test file's existing import (it is — top of file).
  - SCOPE: these cover the env-PARSING behavior ONLY. Do NOT add validateConfig malformed-delimiter
    / whole-object-fallback tests — that is P2.M3.T1.S1 (the env path can't reach that branch anyway).
  - FOLLOW pattern: the existing block uses `const E = "PI_STOP_THINKING_"` and
    `expect(loadConfigFromEnv({ [E + ...]: ... }).field).toBe(...)`.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: envBool bool parse — mirror loadConfigFromEnv's existing enabled/telemetry lines exactly
const reasoningInjection = envBool(env[ENV_PREFIX + "REASONING_INJECTION"]);
if (reasoningInjection !== undefined) partial.reasoningInjection = reasoningInjection;
// envBool accepts true/1/yes/on | false/0/no/off (case-insensitive, trimmed); else undefined.
// "undefined" => omit => validateConfig fills default `true` (PRD Appendix K).

// PATTERN: delimiter parse + assembly — normalize empties to undefined BEFORE `??`
const rawDelimOpen = env[ENV_PREFIX + "REASONING_INJECTION_DELIMITER_OPEN"];
const rawDelimClose = env[ENV_PREFIX + "REASONING_INJECTION_DELIMITER_CLOSE"];
const delimOpen  = rawDelimOpen  !== undefined && rawDelimOpen.length  > 0 ? rawDelimOpen  : undefined;
const delimClose = rawDelimClose !== undefined && rawDelimClose.length > 0 ? rawDelimClose : undefined;
if (delimOpen !== undefined || delimClose !== undefined) {
  partial.reasoningInjectionDelimiter = {
    open:  delimOpen  ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.open,
    close: delimClose ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.close,
  };
}
// CRITICAL: do NOT write `env[...] ?? DEFAULT` directly — `"" ?? DEFAULT === ""` (empty is non-nullish).
// CRITICAL: assemble BOTH sides together; never a partial {open}/{close} object.
// The non-empty guard (`length > 0`) mirrors the existing shortcut/diag string parse.

// PATTERN: insertion point — immediately before the final return (do not disturb existing parses)
return validateConfig({ ...DEFAULT_CONFIG, ...partial });
```

### Integration Points

```yaml
DATABASE: none (pure config module, no persistence).

CONFIG:
  - This task ADDS env parsing for 3 new vars. No new config keys beyond those S1 defined.
  - Reuses ENV_PREFIX ("PI_STOP_THINKING_") and the existing envBool helper — no new helpers.
  - No DEFAULT_CONFIG / validateConfig changes (S1 owns those; S2 only reads DEFAULT_CONFIG).

ROUTES/SERVICES:
  - none. The RequestBuilder/StreamProxy/decorator consume these config fields in P2.M2.* (NOT S2).
  - S2 only makes the fields env-controllable; nothing reads them at runtime yet beyond the loader.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# TypeScript + Bun project. There is NO ruff/mypy/eslint — do NOT run them (template artifacts).
bun run typecheck          # = tsc --noEmit  (covers src/ only; tsconfig EXCLUDES tests)
# Expected: zero errors. Watch for: `??` applied to a raw `env[...]` (string|undefined) is fine
# type-wise but WRONG at runtime if empties aren't normalized — the type-check won't catch that;
# the empty-value unit test (Task 4) will. Also confirm DEFAULT_CONFIG.reasoningInjectionDelimiter
# resolves (i.e. S1 landed).
```

### Level 2: Unit Tests (Component Validation)

```bash
bun test tests/config.test.ts
# Expected: all pass. New env-parsing tests (reasoningInjection, delimiter open/close/both/neither/
# empty) pass; existing suite stays green (S1's FULL_DEFAULTS update already in place).
# If `loadConfigFromEnv({})` toEqual(FULL_DEFAULTS) fails with missing reasoningInjection* keys,
# S1's FULL_DEFAULTS update is missing → that's an S1 problem, not S2.

bun test
# Expected: all pass (full suite; no other module should be affected — config is read-only here).
```

### Level 3: Integration Testing (System Validation)

```bash
# Pure config module — no network/streaming/service startup. One-off smoke check:
bun -e 'import { loadConfigFromEnv } from "./src/config/index.ts";
const E = "PI_STOP_THINKING_";
console.log(loadConfigFromEnv({ [E+"REASONING_INJECTION"]: "false" }).reasoningInjection === false ? "ok:bool-false" : "FAIL");
console.log(loadConfigFromEnv({ [E+"REASONING_INJECTION"]: "maybe" }).reasoningInjection === true ? "ok:bool-invalid-default" : "FAIL");
const o = loadConfigFromEnv({ [E+"REASONING_INJECTION_DELIMITER_OPEN"]: "X" }).reasoningInjectionDelimiter;
console.log(o.open === "X" && o.close.length > 0 ? "ok:open-only-close-defaults" : "FAIL");
const e = loadConfigFromEnv({ [E+"REASONING_INJECTION_DELIMITER_OPEN"]: "" }).reasoningInjectionDelimiter;
console.log(e.open.length > 0 && e.open !== "X" ? "ok:empty-treated-as-unset" : "FAIL");
console.log(loadConfigFromEnv({}).reasoningInjection === true ? "ok:default-bool" : "FAIL");
'
# Expected (all lines):
#   ok:bool-false
#   ok:bool-invalid-default
#   ok:open-only-close-defaults
#   ok:empty-treated-as-unset
#   ok:default-bool
```

### Level 4: Creative & Domain-Specific Validation

```bash
# (Optional) confirm the env path never throws and the JSDoc lists the new vars:
bun -e 'import { loadConfigFromEnv } from "./src/config/index.ts";
const E = "PI_STOP_THINKING_";
// hostile inputs must not throw and must not break delegation
const r = loadConfigFromEnv({ [E+"REASONING_INJECTION"]: "not-a-bool", [E+"REASONING_INJECTION_DELIMITER_OPEN"]: "   " });
console.log("reasoningInjection", r.reasoningInjection === true ? "default" : "UNEXPECTED");
console.log("delimOpenIsDefault", r.reasoningInjectionDelimiter.open.startsWith("---"));'
# grep the JSDoc surface (informational):
grep -n "REASONING_INJECTION_DELIMITER_OPEN\|Configurable surface" src/config/index.ts
# Expected: reasoningInjection default; delimOpenIsDefault true; grep shows the JSDoc list + the parse.
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun run typecheck` passes (zero errors on `src/`).
- [ ] `bun test tests/config.test.ts` passes (existing + new env-parsing tests).
- [ ] `bun test` (full suite) passes.
- [ ] Level 3 smoke script prints all five `ok:` lines.

### Feature Validation

- [ ] `PI_STOP_THINKING_REASONING_INJECTION=false` → `reasoningInjection === false` (and the rest of
      the bool vocabulary works); invalid → default `true`.
- [ ] Setting only OPEN (or only CLOSE) yields a complete delimiter with the unset side equal to the
      §53 default; setting both uses both supplied values.
- [ ] Empty-string delimiter value treated as unset (field omitted → default delimiter, never an
      empty string leaking through).
- [ ] `loadConfigFromEnv({})` still `toEqual(FULL_DEFAULTS)` (no regression).
- [ ] `loadConfigFromEnv` signature, return type, and `validateConfig` delegation unchanged.
- [ ] loadConfigFromEnv JSDoc documents the three new env-var names (added "Configurable surface" list).

### Code Quality Validation

- [ ] New parse lines mirror the existing `envBool`/non-empty-string shapes exactly (no new helpers,
      no new patterns).
- [ ] Delimiter locals normalized to `undefined` before `??`; assembly populates BOTH sides together.
- [ ] No modification to Config interface / DEFAULT_CONFIG / validateConfig / FULL_DEFAULTS (S1/M3).
- [ ] No README change (P2.M3.T2.S1); no RequestBuilder/StreamProxy/decorator change (P2.M2.*).

### Documentation & Deployment

- [ ] JSDoc "Configurable surface" list added with the 3 new env vars (purpose + default each).
- [ ] No new env vars beyond the 3 specified; no new config keys.

---

## Anti-Patterns to Avoid

- ❌ Do NOT write `partial.reasoningInjectionDelimiter.open = env[ENV_PREFIX + "..._OPEN"] ?? DEFAULT`
  inline — empty-string env values are non-nullish and would leak `""` (wrong path + contradicts the
  "treat empty as unset" contract). Normalize empties to `undefined` first.
- ❌ Do NOT assemble a partial delimiter object (`{ open }` or `{ close }` alone) — when EITHER side
  is set, populate BOTH (missing side `??` default). S1's `isOpenCloseShape` requires both non-empty.
- ❌ Do NOT modify `Config`, `DEFAULT_CONFIG`, `validateConfig`, `isOpenCloseShape`, or `FULL_DEFAULTS`
  — those are S1's deliverables (already landed) / M3's scope.
- ❌ Do NOT add validateConfig malformed-delimiter / whole-object-fallback tests in S2 — that is
  P2.M3.T1.S1 (and the env path cannot reach that branch anyway).
- ❌ Do NOT update README.md's config table — that is P2.M3.T2.S1.
- ❌ Do NOT reimplement `envBool` — reuse the existing helper (vocabulary: true/1/yes/on, false/0/no/off).
- ❌ Do NOT locate `loadConfigFromEnv` by absolute line number — S1 inserts ~37 lines above it; locate
  by function name / the final `return validateConfig(...)` line.
- ❌ Do NOT run ruff/mypy/eslint — TypeScript+Bun project; those tools do not exist here.
- ❌ Do NOT touch `RequestBuilder`, `StreamProxy`, or the decorator — wiring is P2.M2.*.

---

**Confidence Score: 9/10** for one-pass implementation success.
Rationale: Single small source-file edit to a well-understood function with verbatim existing
patterns to mirror (envBool bool parse; raw-read + `length > 0` string parse). The one subtle trap
(`"" ?? default === ""` — empties are non-nullish) is flagged with an empirical proof and a
mandatory normalize-before-`??` implementation. The dependency on the parallel S1 task is stated as a
hard contract with a read-only sanity check (Task 0), and the test scope is deliberately bounded to
env-parsing (no overlap with M3's validateConfig edge cases). The JSDoc "update the existing list"
ambiguity (no such list exists) is resolved explicitly (add one). The −1 reserves for the possibility
that S1 has not fully landed when S2 starts (Task 0 guards this) and for the minor judgment call of
how exhaustively to list existing vars in the new "Configurable surface" list.
