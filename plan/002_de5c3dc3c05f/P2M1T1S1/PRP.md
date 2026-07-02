# PRP — P2.M1.T1.S1: Add fields to Config interface, DEFAULT_CONFIG, and validateConfig

---

## Goal

**Feature Goal**: Extend the `Config` schema (`src/config/index.ts`) with the two Ephemeral
Execution Directive fields — `reasoningInjection: boolean` and
`reasoningInjectionDelimiter: { open: string; close: string }` — across the `Config` interface,
the deep-frozen `DEFAULT_CONFIG`, and the `validateConfig` function (including a new
`isOpenCloseShape` guard). This is the schema foundation that P2.M1.T1.S2 (env parsing),
P2.M2.* (directive construction/wiring), and P2.M3.* (tests + docs) build on.

**Deliverable**: A modified `src/config/index.ts` where:
1. The `Config` interface declares the two new fields.
2. `DEFAULT_CONFIG` includes the two new defaults (nested delimiter `Object.freeze`'d), still
   `Object.freeze`'d itself.
3. `validateConfig` validates both new fields with strict per-field/whole-object fallback to
   defaults, never throwing, never exposing mutable `DEFAULT_CONFIG` references.
Plus a minimal update to `tests/config.test.ts`'s `FULL_DEFAULTS` constant so the existing test
suite stays green (see Implementation Tasks — this is NOT the comprehensive new-field test work,
which is P2.M3.T1.S1).

**Success Definition**:
- `bun run typecheck` (`tsc --noEmit`) passes with zero errors on `src/`.
- `bun test` passes (existing `tests/config.test.ts` updated minimally to include the two new
  defaults in `FULL_DEFAULTS`).
- `validateConfig({})` returns an object `toEqual` the full default object including the two new
  fields, and the returned `reasoningInjectionDelimiter` is a fresh object (not the
  `DEFAULT_CONFIG` reference) and its nested default is frozen.
- `reasoningInjection` validates via `isBool`; an invalid delimiter (any partial failure) falls
  back to the ENTIRE default delimiter object, never a hybrid.

## Why

- **Business value**: `reasoningInjection` + `reasoningInjectionDelimiter` are the config knobs for
  ADR-006 / PRD §53 "Ephemeral Execution Directive" — the mechanism that reuses captured reasoning
  by injecting it as ephemeral, clearly-fenced reference context into the replacement request
  (instead of discarding it). Without these config fields the directive cannot be gated or
  customized, and the reasoning-reuse feature (entire P2 milestone) has no schema to read from.
- **Integration**: This is the first subtask of P2.M1 (Configuration Extension). Every downstream
  P2 subtask (env loader, RequestBuilder directive injection, StreamProxy wiring, decorator call
  site, tests) depends on these fields existing in the validated `Config`. Getting the schema +
  validation right here (strict, immutable, whole-object fallback) prevents a class of defects
  downstream (e.g. a malformed delimiter surviving into the directive payload).
- **Problems solved**: Today the `Config` interface (8 fields) has no notion of reasoning reuse.
  PRD §47 lists `reasoningInjection` / `reasoningInjectionDelimiter` as config options with
  deterministic defaults; this task adds them with the required immutability (Appendix G) and
  validation semantics (Appendix K).

## What

User-visible behavior is none directly (this is internal config schema). Observable effects for
downstream consumers:

1. `Config` type gains two fields:
   - `reasoningInjection: boolean` (default `true`).
   - `reasoningInjectionDelimiter: { open: string; close: string }` (default: the PRD §53 fence).
2. `validateConfig(unknown)` accepts and validates both. Strict typing, no coercion
   (`reasoningInjection: "true"` → invalid → default `true`). A delimiter missing/invalid on
   EITHER `open` or `close` → the ENTIRE default delimiter object (not a partial hybrid).
3. `DEFAULT_CONFIG` remains deeply immutable: top-level `Object.freeze` AND the nested
   `reasoningInjectionDelimiter` is `Object.freeze`'d (Appendix G / F: configuration defaults
   shall be immutable).
4. `loadConfig` and `loadConfigFromEnv` are NOT changed in S1 — they spread `DEFAULT_CONFIG`
   (now containing the frozen new fields) into `validateConfig`, which already validates them, so
   correct default pass-through is automatic. Env-var parsing is a separate task (P2.M1.T1.S2).

### Success Criteria

- [ ] `Config` interface declares `reasoningInjection: boolean` and
      `reasoningInjectionDelimiter: { open: string; close: string }`, each with JSDoc (purpose,
      default value, env var name; Appendix H privacy note kept current — reasoning text is never
      logged/telemetered).
- [ ] `DEFAULT_CONFIG` includes `reasoningInjection: true` and a nested `Object.freeze`'d
      `reasoningInjectionDelimiter` with the exact PRD §53 / Appendix K default strings; the
      top-level object is still `Object.freeze`'d.
- [ ] `validateConfig` validates `reasoningInjection` via `isBool`/`pick` and validates the
      delimiter via a new `isOpenCloseShape` guard with whole-object fallback.
- [ ] `validateConfig` never throws on bad input and never returns a `reasoningInjectionDelimiter`
      that aliases the `DEFAULT_CONFIG` reference (it copies: `{ open, close }` or
      `{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`).
- [ ] `loadConfig` / `loadConfigFromEnv` are untouched (S2 owns env parsing).
- [ ] `tests/config.test.ts` `FULL_DEFAULTS` updated minimally so the existing suite passes.
- [ ] `bun run typecheck` passes; `bun test` passes.

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes** — this PRP names the single source file, gives exact line anchors, shows the
exact existing patterns (interface, `Object.freeze` + `as Config` cast, arrow-const guards, `pick`
helper, the `validateConfig` return shape), quotes the exact default delimiter strings from the
PRD, specifies the exact new guard semantics and the whole-object-fallback rule, and flags the one
cross-cutting test breakage (`FULL_DEFAULTS` must be extended). No external libraries are involved.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- url: https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates
  why: Type guards (the `v is T` predicate syntax used by isBool/isNonEmptyString/isOpenCloseShape)
  critical: The new isOpenCloseShape guard MUST be a type predicate `(v: unknown): v is {open:string; close:string}`
    so the pick() call type-checks. A plain boolean-returning function will NOT compile against pick<T>'s signature.

- file: src/config/index.ts
  why: THE ONLY source file to modify. Contains the Config interface (line 16), DEFAULT_CONFIG (line 44),
        the arrow-const guards (lines 56-66), pick<T>() (line 69), and validateConfig (line 88).
  pattern: Follow the existing guard style EXACTLY: `const isOpenCloseShape = (v: unknown): v is {open:string; close:string} => {...}`
  gotcha: validateConfig's delimiter line must NOT use the simple pick() helper - it needs a ternary that
           returns a fresh object in BOTH branches (whole-object fallback, see Implementation Tasks).

- file: tests/config.test.ts
  why: FULL_DEFAULTS constant (~line 4) is compared via toEqual() against validateConfig() output in ~8 tests.
  pattern: toEqual() does deep equality requiring EXACT own-key match (extra defined keys FAIL, verified empirically).
  gotcha: You MUST add the two new default fields to FULL_DEFAULTS or the ENTIRE existing config test suite breaks.
           This minimal update is in-scope for S1; the fuller edge-case tests are NOT (P2.M3.T1.S1).

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: Authoritative implementation contract for the reasoning-reuse delta.
  section: §6 "Config Type Additions" + §2 "Directive Message Construction" (delimiter defaults) + §4 (gating, for context only - NOT implemented here).

- docfile: plan/002_de5c3dc3c05f/architecture/current-impl-state.md
  why: Confirms current Config shape / what already exists.
  section: Config module section.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/
  config/index.ts        # <-- MODIFY (Config interface, DEFAULT_CONFIG, guards, validateConfig)
  request/builder.ts     # NOT touched in S1 (uses Config in P2.M2.*)
  provider/{decorator,proxy}.ts  # NOT touched in S1 (wiring in P2.M2.T3.*)
  ...other modules...
tests/
  config.test.ts         # <-- MODIFY minimally: extend FULL_DEFAULTS with the 2 new default fields
package.json             # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit
tsconfig.json            # strict:true; EXCLUDES "tests" from tsc (so typecheck only covers src/)
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. Two MODIFIED files:
src/config/index.ts     # +Config.reasoningInjection, +Config.reasoningInjectionDelimiter,
                        # +DEFAULT_CONFIG.reasoningInjection (true),
                        # +DEFAULT_CONFIG.reasoningInjectionDelimiter (frozen fence),
                        # +isOpenCloseShape guard,
                        # +validateConfig lines for both fields.
tests/config.test.ts    # +FULL_DEFAULTS.reasoningInjection (true),
                        # +FULL_DEFAULTS.reasoningInjectionDelimiter ({open,close}) -- minimal, keeps suite green.
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: tsconfig.json EXCLUDES "tests" from tsc --noEmit. So `bun run typecheck` only typechecks src/.
// Tests are validated at RUNTIME by `bun test` (bun does type-stripping, not full typecheck).
// => Run BOTH `bun run typecheck` (src) AND `bun test` (src + tests) for full validation.

// CRITICAL: bun:test's expect(...).toEqual() requires EXACT own-key match (deep equality).
// Verified empirically: expect({a:1,b:2}).toEqual({a:1}) THROWS.
// => Adding 2 defined keys to validateConfig()'s output WILL break tests/config.test.ts unless
//    FULL_DEFAULTS is extended with the same 2 keys. This is mandatory, not optional.

// CRITICAL: DEFAULT_CONFIG is `Object.freeze({...}) as Config`. The nested delimiter MUST be frozen
// too: `reasoningInjectionDelimiter: Object.freeze({ open: "...", close: "..." })`.
// This mirrors the existing supportedProviders: Object.freeze(["zai"]) pattern.

// CRITICAL (delimiter fallback semantics): A malformed delimiter falls back to the ENTIRE default
// object, NOT a per-field hybrid. e.g. {open:"valid", close:""} => BOTH branches ignore "valid" and
// use { ...DEFAULT_CONFIG.reasoningInjectionDelimiter }. Do NOT pick() open/close independently.

// CRITICAL: validateConfig must return FRESH objects (never alias DEFAULT_CONFIG) so callers cannot
// mutate the frozen defaults. The delimiter branch returns a new {open,close} literal or a spread
// copy - never DEFAULT_CONFIG.reasoningInjectionDelimiter itself. (Mirrors the existing
// `[...DEFAULT_CONFIG.supportedProviders]` copy pattern.)

// The default delimiter strings contain literal \n newlines in the TS source (NOT actual line breaks):
//   open:  "---\n[Prior reasoning captured before you were asked to stop thinking]"
//   close: "[End of prior reasoning]\n---"
// Copy these EXACTLY from PRD §53 h3.71 / Appendix K h1.117.

// pick<T>(value, guard, fallback) requires guard to be a TYPE PREDICATE (v is T), not a plain boolean fn.
```

## Implementation Blueprint

### Data models and structure

The relevant data model is the `Config` interface (a plain TS interface, no ORM/pydantic in this
project — TypeScript + Bun). Add exactly two fields:

```typescript
// In the Config interface (src/config/index.ts ~line 16), after `diagnosticsLevel`:
  /**
   * Whether the Ephemeral Execution Directive is enabled (PRD §47 / ADR-006 / §53): the captured
   * reasoning snapshot is injected into the replacement request as ephemeral, clearly-fenced
   * reference context (INPUT injection for the model to reuse), NOT output stitching. When `false`
   * (or the snapshot is empty) the replacement behaves as a from-scratch thinking-disabled answer.
   * Default: `true`. Env: `PI_STOP_THINKING_REASONING_INJECTION`.
   *
   * [Appendix H privacy] Enabling this does NOT cause reasoning text to be logged, telemetered, or
   * persisted beyond the single ephemeral replacement request; diagnostics never log reasoning text.
   */
  reasoningInjection: boolean;

  /**
   * The open/close fence text wrapping the injected reasoning block (PRD §47 / §53 h3.71 /
   * Appendix K h1.117). Defaults to a deterministic, clearly-labeled fence so the model can
   * unambiguously distinguish prior reasoning from the live prompt. Both parts must be non-empty
   * strings; an invalid value on EITHER part falls back to the ENTIRE default delimiter object.
   * Changing this does not affect the shortcut or the env-var config mechanism.
   * Default: `{ open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
   *            close: "[End of prior reasoning]\n---" }`.
   * Env: `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` /
   *      `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE` (parsing is P2.M1.T1.S2).
   */
  reasoningInjectionDelimiter: { open: string; close: string };
```

No new types, enums, or schemas beyond `{ open: string; close: string }` (an inline object type,
matching `directive_design.md` §6).

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/config/index.ts — extend the Config interface (line ~16)
  - ADD field: `reasoningInjection: boolean` with JSDoc (purpose, default `true`, env var
    `PI_STOP_THINKING_REASONING_INJECTION`, Appendix H privacy note — reasoning text never logged).
  - ADD field: `reasoningInjectionDelimiter: { open: string; close: string }` with JSDoc (purpose,
    default fence, env vars `..._DELIMITER_OPEN` / `..._DELIMITER_CLOSE` [parsing is S2], privacy note).
  - PLACEMENT: After the existing `diagnosticsLevel: DiagnosticsLevel;` field (keep field order tidy).
  - NAMING: camelCase field names (matches existing 8 fields); inline object type for delimiter.
  - FOLLOW pattern: existing JSDoc blocks on `enabled`, `shortcut`, `diagnosticsLevel`
    (terse, reference PRD sections, state the default).

Task 2: MODIFY src/config/index.ts — extend DEFAULT_CONFIG (line ~44)
  - ADD: `reasoningInjection: true,`  (PRD §47 / Appendix K default).
  - ADD: `reasoningInjectionDelimiter: Object.freeze({`
           `open: "---\n[Prior reasoning captured before you were asked to stop thinking]",`
           `close: "[End of prior reasoning]\n---",`
         `}),`
  - CRITICAL: The nested delimiter MUST be Object.freeze'd (Appendix G immutability). Mirror the
    existing `supportedProviders: Object.freeze(["zai"])` pattern.
  - PRESERVE: The outer `Object.freeze({...}) as Config` wrapper and `as Config` cast stay as-is.
  - GOTCHA: The `\n` are literal escape sequences in the TS source string (copy EXACTLY).

Task 3: MODIFY src/config/index.ts — add the isOpenCloseShape guard (near lines 56-66)
  - ADD (as an arrow-const type-predicate, matching isBool/isNonEmptyString style):
        `const isOpenCloseShape =`
        `  (v: unknown): v is { open: string; close: string } =>`
        `    typeof v === "object" && v !== null &&`
        `    "open" in v && "close" in v &&`
        `    typeof (v as { open: unknown }).open === "string" && (v as { open: string }).open.length > 0 &&`
        `    typeof (v as { close: unknown }).close === "string" && (v as { close: string }).close.length > 0;`
  - FOLLOW pattern: existing guards are one-liner `(v: unknown): v is T => <boolean expr>`.
  - GOTCHA: It MUST be a type predicate (`v is {...}`) so pick()/the ternary type-checks. Both open
    AND close must be non-empty strings (this drives the whole-object fallback in Task 4).
  - PLACEMENT: Among the other guards (before `pick` at line 69); keep them grouped.

Task 4: MODIFY src/config/index.ts — extend validateConfig (line ~88)
  - ADD after the `diagnosticsLevel: ...` line in the returned object literal:
        `reasoningInjection: pick(src.reasoningInjection, isBool, DEFAULT_CONFIG.reasoningInjection),`
        `reasoningInjectionDelimiter: isOpenCloseShape(src.reasoningInjectionDelimiter)`
        `  ? { open: src.reasoningInjectionDelimiter.open, close: src.reasoningInjectionDelimiter.close }`
        `  : { ...DEFAULT_CONFIG.reasoningInjectionDelimiter },`
  - CRITICAL (whole-object fallback): on ANY failure of isOpenCloseShape (missing, not object,
    open/close not strings, OR either empty), use the ENTIRE default object via spread — do NOT
    pick open/close independently (a valid open + empty close must NOT yield a hybrid).
  - CRITICAL (fresh object): BOTH branches return a NEW object literal — never alias
    DEFAULT_CONFIG.reasoningInjectionDelimiter. (Mirrors the existing
    `[...DEFAULT_CONFIG.supportedProviders]` fresh-copy guarantee.)
  - FOLLOW pattern: the supportedProviders line uses a ternary-with-fresh-copy already; mirror that
    "validate-or-copy-default" shape for the delimiter.

Task 5: MODIFY tests/config.test.ts — minimally extend FULL_DEFAULTS (line ~4)
  - ADD to the FULL_DEFAULTS object literal:
        `reasoningInjection: true,`
        `reasoningInjectionDelimiter: {`
        `  open: "---\n[Prior reasoning captured before you were asked to stop thinking]",`
        `  close: "[End of prior reasoning]\n---",`
        `},`
  - WHY: ~8 existing tests do `expect(validateConfig(input)).toEqual(FULL_DEFAULTS)`; toEqual
    requires exact key match (verified), so without this the existing suite breaks.
  - SCOPE: This is the ONLY test change for S1. Do NOT add new describe blocks / edge-case tests
    for the new fields — that is P2.M3.T1.S1. (You may OPTIONALLY verify Object.isFrozen on the
    default delimiter by eye, but its assertion test belongs to P2.M3.T1.S1.)
  - GOTCHA: Copy the delimiter strings EXACTLY (with \n escapes) so toEqual deep-matches.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: arrow-const type-predicate guard (src/config/index.ts lines 56-66)
const isOpenCloseShape = (v: unknown): v is { open: string; close: string } =>
  typeof v === "object" && v !== null &&
  "open" in v && "close" in v &&
  typeof (v as { open: unknown }).open === "string" && (v as { open: string }).open.length > 0 &&
  typeof (v as { close: unknown }).close === "string" && (v as { close: string }).close.length > 0;
// CRITICAL: predicate form (`v is T`) is REQUIRED for pick<T>() to accept it. A plain boolean fn
// will produce a TS2345/compile error. Narrowing via `in` then `typeof` keeps `strict` mode happy.

// PATTERN: validateConfig return — fresh object, whole-object fallback for the delimiter
//   (mirror the existing supportedProviders ternary: validate-or-copy-default)
reasoningInjection: pick(src.reasoningInjection, isBool, DEFAULT_CONFIG.reasoningInjection),
reasoningInjectionDelimiter: isOpenCloseShape(src.reasoningInjectionDelimiter)
  ? { open: src.reasoningInjectionDelimiter.open, close: src.reasoningInjectionDelimiter.close }
  : { ...DEFAULT_CONFIG.reasoningInjectionDelimiter },
// GOTCHA: the truthy branch ALSO constructs a fresh {open,close} (does NOT return the src object
//   verbatim) so a caller holding the validated config cannot mutate the source. The falsy branch
//   spreads the frozen default (a shallow copy is sufficient: open/close are primitives).
// GOTCHA: NEVER write `: DEFAULT_CONFIG.reasoningInjectionDelimiter` (would alias the frozen
//   singleton and violate the "never exposes DEFAULT_CONFIG references for mutation" rule).

// PATTERN: deeply-frozen default (src/config/index.ts line 44)
reasoningInjection: true,
reasoningInjectionDelimiter: Object.freeze({
  open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
  close: "[End of prior reasoning]\n---",
}),
// CRITICAL: nested Object.freeze required (Appendix G). Matches supportedProviders: Object.freeze([...]).
```

### Integration Points

```yaml
DATABASE:
  - none (pure config module, no persistence)

CONFIG:
  - NO env-var parsing in S1. (P2.M1.T1.S2 adds PI_STOP_THINKING_REASONING_INJECTION,
    PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN/CLOSE to loadConfigFromEnv.)
  - loadConfig / loadConfigFromEnv need NO code change: they spread DEFAULT_CONFIG (now containing
    the frozen new fields) into validateConfig, which already validates them. Pass-through automatic.

ROUTES/SERVICES:
  - none. The RequestBuilder/StreamProxy/decorator consume these fields in P2.M2.* (NOT this task).
  - This task only defines + validates the schema; nothing reads the new fields yet.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# TypeScript + Bun project. There is NO ruff/mypy/eslint — do NOT run them (template artifacts).
# Typecheck src/ (tsconfig.json EXCLUDES tests, so this is src-only):
bun run typecheck          # = tsc --noEmit
# Expected: zero errors. The `as Config` cast on DEFAULT_CONFIG must still satisfy the new interface.
# If the isOpenCloseShape guard is a plain boolean fn (not a `v is T` predicate), tsc will error on
# the pick() call — fix the predicate.

# (Optional) build to be sure declarations emit:
bun run build             # = tsc  (emits dist/)
# Expected: zero errors.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Run the existing config suite (it MUST stay green after the FULL_DEFAULTS update):
bun test tests/config.test.ts
# Expected: all pass. If toEqual failures mention extra keys reasoningInjection /
# reasoningInjectionDelimiter, you forgot Task 5 (extend FULL_DEFAULTS).

# Full suite (sanity — no other test should be affected; config is read-only here):
bun test
# Expected: all pass.
```

### Level 3: Integration Testing (System Validation)

```bash
# This is a pure config module with no network/streaming. No service startup. Minimal smoke check:
bun -e 'import { validateConfig, DEFAULT_CONFIG } from "./src/config/index.ts";
const c = validateConfig({ reasoningInjection: false });
console.log(c.reasoningInjection === false ? "ok:reasoningInjection=false" : "FAIL");
const d = validateConfig({ reasoningInjectionDelimiter: { open: "x", close: "y" } });
console.log(d.reasoningInjectionDelimiter.open === "x" && d.reasoningInjectionDelimiter.close === "y" ? "ok:valid-delimiter" : "FAIL");
const e = validateConfig({ reasoningInjectionDelimiter: { open: "x", close: "" } });
console.log(e.reasoningInjectionDelimiter.open === DEFAULT_CONFIG.reasoningInjectionDelimiter.open ? "ok:whole-object-fallback" : "FAIL");
console.log(Object.isFrozen(DEFAULT_CONFIG.reasoningInjectionDelimiter) ? "ok:frozen-nested" : "FAIL");
console.log(validateConfig({}).reasoningInjectionDelimiter !== DEFAULT_CONFIG.reasoningInjectionDelimiter ? "ok:fresh-object" : "FAIL");
'
# Expected (all lines):
#   ok:reasoningInjection=false
#   ok:valid-delimiter
#   ok:whole-object-fallback
#   ok:frozen-nested
#   ok:fresh-object
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Appendix G immutability + Appendix H privacy sanity (no tools — manual reasoning + a one-off check):
bun -e 'import { DEFAULT_CONFIG } from "./src/config/index.ts";
console.log("topFrozen", Object.isFrozen(DEFAULT_CONFIG));
console.log("delimFrozen", Object.isFrozen(DEFAULT_CONFIG.reasoningInjectionDelimiter));
try { (DEFAULT_CONFIG.reasoningInjectionDelimiter as any).open = "x"; console.log("FAIL:mutable-nested"); }
catch { console.log("ok:strict-mutation-throws"); }'
# Expected: topFrozen true, delimFrozen true, ok:strict-mutation-throws.
# (Full assertion coverage for these is deferred to P2.M3.T1.S1; S1 only guarantees the behavior.)
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun run typecheck` passes (zero errors on `src/`).
- [ ] `bun test tests/config.test.ts` passes (existing suite green after `FULL_DEFAULTS` update).
- [ ] `bun test` (full suite) passes.
- [ ] Level 3 smoke script prints all five `ok:` lines.

### Feature Validation

- [ ] `Config` interface has both new fields with JSDoc (purpose, default, env var name; privacy note).
- [ ] `DEFAULT_CONFIG.reasoningInjection === true`.
- [ ] `DEFAULT_CONFIG.reasoningInjectionDelimiter` equals the PRD §53 / Appendix K fence and is
      `Object.freeze`'d; top-level `DEFAULT_CONFIG` still frozen.
- [ ] `validateConfig({ reasoningInjection: false }).reasoningInjection === false` (strict bool).
- [ ] `validateConfig({ reasoningInjection: "true" }).reasoningInjection === true` (no coercion).
- [ ] Valid delimiter passes through (open/close copied into a fresh object).
- [ ] Partially-invalid delimiter (`close` empty) falls back to the ENTIRE default delimiter.
- [ ] `validateConfig({}).reasoningInjectionDelimiter` is NOT the `DEFAULT_CONFIG` reference (fresh).
- [ ] `loadConfig` and `loadConfigFromEnv` are UNCHANGED (S2 owns env parsing).

### Code Quality Validation

- [ ] New guard follows the arrow-const type-predicate style of the existing guards.
- [ ] Field placement is tidy (after `diagnosticsLevel`); JSDoc style matches existing fields.
- [ ] No new patterns invented — reuses `pick`, ternary-with-fresh-copy, `Object.freeze` nesting.
- [ ] Anti-patterns avoided (see below): no per-field hybrid fallback, no aliasing frozen singletons,
      no env parsing (S2), no RequestBuilder/StreamProxy changes (P2.M2.*).

### Documentation & Deployment

- [ ] JSDoc on both new fields is self-documenting (purpose + default + env var + privacy).
- [ ] No new env vars are PARSED in S1 (only DOCUMENTED in JSDoc as forward-references for S2).
- [ ] README/CHANGELOG updates are NOT part of S1 (P2.M3.T2.* owns docs sync).

---

## Anti-Patterns to Avoid

- ❌ Do NOT pick `open`/`close` independently — a partially-valid delimiter must fall back to the
  WHOLE default object (whole-object fallback rule from the contract §3c).
- ❌ Do NOT make `isOpenCloseShape` a plain boolean function — it must be a `v is {...}` type
  predicate or `pick<T>()` / the ternary will not type-check under `strict`.
- ❌ Do NOT return `DEFAULT_CONFIG.reasoningInjectionDelimiter` (aliasing) from `validateConfig` —
  always return a fresh `{open,close}` literal or a spread copy (never exposes mutable refs).
- ❌ Do NOT forget to `Object.freeze` the nested default delimiter (Appendix G immutability).
- ❌ Do NOT skip the `FULL_DEFAULTS` update in `tests/config.test.ts` — `toEqual` requires exact key
  match and the existing suite WILL break (verified empirically). This is mandatory for S1.
- ❌ Do NOT add env-var parsing for the new fields — that is P2.M1.T1.S2 (out of scope).
- ❌ Do NOT add the comprehensive edge-case test suite for the new fields — that is P2.M3.T1.S1.
- ❌ Do NOT modify `loadConfig`, `loadConfigFromEnv`, `RequestBuilder`, `StreamProxy`, or the
  decorator — S1 is schema + validation only; pass-through is already correct via `DEFAULT_CONFIG`
  spread, and wiring is P2.M2.*.
- ❌ Do NOT run ruff/mypy/eslint — this is a TypeScript+Bun project; those tools do not exist here.
- ❌ Do NOT copy the delimiter strings with real line breaks — the `\n` are literal escapes in the
  TS source (matches PRD §53 / Appendix K exactly).

---

**Confidence Score: 9/10** for one-pass implementation success.
Rationale: Single small source file with exact line anchors, exact existing patterns to mirror,
an authoritative architecture contract (directive_design.md §6) specifying the precise types and
validation semantics, and the one non-obvious cross-cutting risk (test breakage from `toEqual`)
is explicitly flagged with an empirical proof and a mandatory minimal fix. The −1 reserves for the
subtle `in`-based narrowing needed to keep `isOpenCloseShape` compiling under `strict` (the exact
casting snippet is provided, but TS narrowing of `in` on `unknown` can occasionally surprise).
