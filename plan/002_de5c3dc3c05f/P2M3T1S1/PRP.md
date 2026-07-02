# PRP — P2.M3.T1.S1: Extend config tests for reasoningInjection + reasoningInjectionDelimiter

---

## Goal

**Feature Goal**: Close the directive test-coverage gap in `tests/config.test.ts` for the two config
fields added in P2.M1.T1 (PRD §47 / ADR-006 / §53): `reasoningInjection` (boolean) and
`reasoningInjectionDelimiter` (`{ open: string; close: string }`). Implement PRD §55 / h2.178
"Configuration" unit-test coverage by adding the **three missing test cases** for `validateConfig`
that currently have no coverage: (b) per-field validation for `reasoningInjection`, (c) per-field
validation for `reasoningInjectionDelimiter`, and (e) a directive-specific composition rule.

**Deliverable**: ONE modified test file — `tests/config.test.ts`. **No source files touched.**
No new files. Specifically, ADD exactly **3 new `test(...)` cases** at two precise insertion points:

1. In the `"validateConfig — per-field fallback (strict types, no coercion)"` describe block (after
   the existing `diagnosticsLevel` test):
   - a `reasoningInjection` per-field test (valid `true`/`false` pass through; invalid `"true"`,
     `1`, `null`, `undefined` → default `true`);
   - a `reasoningInjectionDelimiter` per-field test (valid `{open,close}` passes through as a copy;
     missing `open`/`close`, empty string, non-object, `null`, `undefined` → default object).
2. In the `"validateConfig — composition rules"` describe block (after the existing
   `"one invalid field does not poison valid fields"` test):
   - a directive-specific composition test: one invalid directive field does NOT poison the other
     directive field (and does not poison other fields).

**Success Definition**:
- `bun test tests/config.test.ts` exits 0. Test count goes **45 → 48** (3 new cases); 0 failures.
- `bun test` (full suite) exits 0 — no regression (config tests are independent of the parallel
  P2.M2.T3.S1 proxy/decorator wiring changes).
- The 3 new tests genuinely exercise `validateConfig`'s `isBool` guard (reasoningInjection) and
  `isOpenCloseShape` guard (reasoningInjectionDelimiter) plus the per-field-fallback composition rule.
- **No duplicate tests**: the FULL_DEFAULTS literal (item a) and env tests (item d) are ALREADY
  present in the committed file — this PRP must NOT re-add them.

## User Persona (if applicable)

**Target User**: Maintainers / future test authors of the pi-stop-thinking extension. Internal test
hardening — no end-user, API, or config surface change.
**Use Case**: Regression protection for the §53 directive config validation. When someone later
refactors `validateConfig` / `loadConfigFromEnv`, these tests fail loudly if the strict
no-coercion, per-field-fallback contract for the directive fields regresses.
**Pain Points Addressed**: Today a refactor of the `isOpenCloseShape` guard or the
`reasoningInjection` boolean guard would silently change behavior with no test catching it (only
`enabled`/`telemetryEnabled` booleans and `supportedProviders`/`diagnosticsLevel` have per-field
tests). This fills that blind spot for the directive fields specifically.

## Why

- **Business value**: The §53 Ephemeral Execution Directive is the headline feature of Phase 2
  (ADR-006). Its two config fields are the user-facing control surface (enable/disable the directive;
  customize the reasoning fence). PRD §55 h2.178 lists "Configuration" as a mandatory unit-test
  target; this subtask is the directive portion of that target.
- **Integration** (P2.M3 chain position):
  - **Consumes P2.M1.T1.S1/S2** (Complete): the `Config.reasoningInjection` +
    `reasoningInjectionDelimiter` fields, `DEFAULT_CONFIG` values, `validateConfig` guards
    (`isBool`, `isOpenCloseShape`), and `loadConfigFromEnv` env parsing. This subtask tests the
    `validateConfig` half (the env-parsing half is already covered).
  - **Sibling P2.M3.T1.S2** (planned, RequestBuilder directive + INV-013/INV-014 tests): operates on
    `tests/request-builder.test.ts`, NOT `tests/config.test.ts` — no overlap, no conflict.
  - **Parallel P2.M2.T3.S1** (Implementing, proxy/decorator wiring): touches `src/provider/proxy.ts`
    + `src/provider/decorator.ts` ONLY. Config tests do not import those modules, so they are
    unaffected by the parallel change.
- **Problems solved**: Eliminates the "directive config fields validated but not tested" gap noted in
  `architecture/current-impl-state.md` §5 ("Must extend").

## What

User-visible behavior: none — test code only. The observable contract being asserted (already
implemented and **empirically verified** in src/config/index.ts):

1. **`reasoningInjection`** (`validateConfig`, guard `isBool = typeof v === "boolean"`):
   - valid `true` → `true`; valid `false` → `false` (passes through, no coercion).
   - invalid `"true"` (string), `1` (number), `0`, `null`, `undefined` → default `true`.
2. **`reasoningInjectionDelimiter`** (`validateConfig`, guard `isOpenCloseShape`: object, non-null,
   both `open` & `close` present and non-empty strings):
   - valid `{ open: "x", close: "y" }` → passes through **as a fresh copy** (`.toEqual` matches,
     `.not.toBe(inputRef)`).
   - missing `open` or `close` (e.g. `{ open: "x" }`) → default object.
   - empty-string member (e.g. `{ open: "", close: "y" }`) → default object.
   - non-object (`"x"`, `42`, `[]`) → default object.
   - `null` → default object; `undefined` → default object.
   - The default object is a **fresh copy** of `DEFAULT_CONFIG.reasoningInjectionDelimiter`.
3. **Composition**: one invalid directive field does NOT poison the other directive field
   (per-field fallback, item logic step e), e.g. `{ reasoningInjection: "bad", ... }` leaves a
   valid delimiter intact and vice-versa.

### Success Criteria

- [ ] 3 new `test(...)` cases added to `tests/config.test.ts` (2 in the per-field block, 1 in the
      composition block).
- [ ] The `reasoningInjection` test asserts valid `true`/`false` pass through AND a table of invalid
      values (`"true"`, `1`, `null`, `undefined`) fall back to default `true`.
- [ ] The `reasoningInjectionDelimiter` test asserts a valid object passes through AND a table of
      invalid values (missing open/close, empty string, non-object, `null`, `undefined`) fall back
      to the default delimiter object.
- [ ] The composition test asserts one invalid directive field does not poison the other directive field.
- [ ] `bun test tests/config.test.ts` → 48 pass / 0 fail (was 45 pass).
- [ ] `bun test` (full suite) → 0 fail.
- [ ] No source file modified (`git status --porcelain src/` shows nothing new from this task).
- [ ] No duplicate tests (FULL_DEFAULTS literal + env tests already present are left untouched).

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes.** This PRP names the single file to edit, quotes the EXACT current insertion
anchors verbatim, gives the EXACT new test code (whose every assertion was **empirically verified**
against the live `src/config/index.ts` via `bun -e`), states precisely which contract items already
exist (so they are not duplicated), cites the authoritative validation behavior source
(`src/config/index.ts` guards `isBool` / `isOpenCloseShape`), and pins the verified validation
commands and expected test counts.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: tests/config.test.ts
  why: THE ONLY file to modify. Contains FULL_DEFAULTS literal (lines 5–18), the
        "validateConfig — per-field fallback (strict types, no coercion)" describe block (insertion
        point 1, after the `diagnosticsLevel` test), and the "validateConfig — composition rules"
        describe block (insertion point 2, after the "one invalid field does not poison valid fields"
        test). Also contains the ALREADY-PRESENT env tests for the directive fields (lines ~153–184)
        that must NOT be duplicated.
  pattern: Existing per-field tests use a `for (const bad of [...])` table of invalid values, each
        asserted to fall back to the default, PLUS one positive line for a valid value that passes
        through. Booleans use `.toBe`; objects/arrays use `.toEqual`. See the `enabled`,
        `telemetryEnabled`, and `supportedProviders` tests for the exact idiom.
  gotcha: The file's idiom for "the default delimiter object" is `expect(...).toEqual({
        ...DEFAULT_CONFIG.reasoningInjectionDelimiter })` (see lines ~180, ~184) — MIRROR this rather
        than hand-copying the fence literal, so the test does not couple to the exact fence string.

- file: src/config/index.ts
  why: READ-ONLY. Defines the behavior being tested (already Complete, P2.M1.T1.S1/S2). The two
        guards the tests must exercise:
        - `isBool = (v) => typeof v === "boolean"` (reasoningInjection)
        - `isOpenCloseShape = (v) => typeof v === "object" && v !== null && "open" in v && "close" in v
          && typeof v.open === "string" && v.open.length > 0 && typeof v.close === "string" &&
          v.close.length > 0` (reasoningInjectionDelimiter)
        And the validateConfig lines:
        - `reasoningInjection: pick(src.reasoningInjection, isBool, DEFAULT_CONFIG.reasoningInjection)`
        - `reasoningInjectionDelimiter: isOpenCloseShape(src.reasoningInjectionDelimiter)
            ? { open: src.reasoningInjectionDelimiter.open, close: src.reasoningInjectionDelimiter.close }
            : { ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`
  section: guards (lines ~63–75), validateConfig return (lines ~120–145).
  gotcha: A VALID delimiter is returned as a NEW object (`{ open: src..., close: src... }`), NOT the
        caller's input ref — so a `.toBe(input)` assertion would be wrong; use `.toEqual`. An INVALID
        delimiter returns a fresh copy of DEFAULT_CONFIG (`.not.toBe(DEFAULT_CONFIG.reasoningInjectionDelimiter)`).

- docfile: plan/002_de5c3dc3c05f/architecture/current-impl-state.md
  why: Authoritative gap analysis that motivates this subtask.
  section: "§5 Test infrastructure" — confirms FULL_DEFAULTS "Must extend" and describes the
        existing `.toEqual(FULL_DEFAULTS)` snapshot pattern and the env-test `const E = "PI_STOP_THINKING_"` idiom.

- docfile: plan/002_de5c3dc3c05f/P2M3T1S1/research/notes.md
  why: The empirically-verified behavior tables (input → result) for both fields + composition.
        Every assertion in the new tests below is backed by a row in this table, confirmed via `bun -e`.

- prd: §47 (Configuration Specification), §55 h2.178 (Unit Tests — Configuration), Appendix K h1.117
        (Configuration Schema). The directive fields' defaults and validation rules live here.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/config/index.ts        # READ-ONLY — behavior source (isBool / isOpenCloseShape guards). Complete (P2.M1.T1.*).
tests/config.test.ts       # <-- MODIFY: +3 test cases (2 per-field, 1 composition).
package.json               # scripts: test=bun test, typecheck=tsc --noEmit, build=tsc
tsconfig.json              # strict:true; "exclude": ["node_modules","dist","tests"]  <-- typecheck DOES NOT cover tests/
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. ONE MODIFIED file:
tests/config.test.ts       # +3 test(...) cases:
                           #   • reasoningInjection per-field (valid pass-through + invalid→default table)
                           #   • reasoningInjectionDelimiter per-field (valid copy + invalid→default table)
                           #   • directive composition (one invalid directive field ≠ poison the other)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (no duplication): The FULL_DEFAULTS literal (item a) and the env tests (item d) ALREADY
// EXIST in tests/config.test.ts (committed in P2.M1.T1.S1/S2 — `git log -- tests/config.test.ts`).
// Do NOT re-add them. This subtask adds ONLY the validateConfig per-field tests (b, c) + the
// directive composition test (e). Duplicating (a)/(d) would create dead tests and bloat.

// CRITICAL (assertion shape — .toEqual, not .toBe, for the delimiter): validateConfig returns a
// valid delimiter as a FRESH object (`{ open: src..., close: src... }`), and an invalid one as a
// fresh copy (`{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`). So:
//   expect(result.reasoningInjectionDelimiter).toEqual({ open: "a", close: "b" });   // CORRECT
//   expect(result.reasoningInjectionDelimiter).toBe(inputRef);                       // WRONG — fresh copy
// Use the existing idiom `expect(...).toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter })`
// for the default-object assertions (matches lines ~180, ~184 of the existing file).

// CRITICAL (boolean guard is strict typeof, no truthiness): `isBool = typeof v === "boolean"`. So
// `1`, `0`, `"true"` are all INVALID (they are number/number/string, not boolean). The invalid
// table for reasoningInjection MUST include `1` and `"true"` to prove no coercion happens (this is
// the same strictness the `enabled` test already asserts: `"true", 1, 0, null, "yes"` → default).

// CRITICAL (delimiter guard requires BOTH non-empty): `isOpenCloseShape` fails if EITHER open or
// close is missing OR empty. So `{ open: "x" }` (missing close), `{ open: "", close: "y" }` (empty),
// and `{ close: "y" }` (missing open) all fall back to default. The invalid table MUST cover the
// "missing one part" and "empty part" cases, not just non-object/null.

// CRITICAL (typecheck is NOT the gate here): tsconfig.json EXCLUDES tests/ from tsc, so
// `bun run typecheck` does NOT type-check tests/config.test.ts. The authoritative gate is
// `bun test tests/config.test.ts`. (You may still run typecheck to confirm src/ is untouched —
// it should be a no-op.) Do NOT invent an eslint/biome/ruff/mypy step — this is a Bun+TS project.

// CRITICAL (no new imports): `DEFAULT_CONFIG`, `loadConfig`, `loadConfigFromEnv`, `validateConfig`
// are ALREADY imported at the top of tests/config.test.ts. The new tests reference only
// `validateConfig` and `DEFAULT_CONFIG` — both already in scope. Do NOT touch the import line.
```

## Implementation Blueprint

### Data models and structure

No new data models — this is pure test code exercising the existing `Config` shape:

```typescript
// Already-defined Config fields under test (src/config/index.ts):
reasoningInjection: boolean;                                  // default true
reasoningInjectionDelimiter: { open: string; close: string }; // default fence object

// Already-imported in tests/config.test.ts:
import { DEFAULT_CONFIG, loadConfig, loadConfigFromEnv, validateConfig } from "../src/config";
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY tests/config.test.ts — ADD reasoningInjection per-field test
  - FIND the insertion anchor — the END of the `diagnosticsLevel` test inside the describe block
        `"validateConfig — per-field fallback (strict types, no coercion)"`. The block currently
        ends like this (the last test + the describe's closing `});`):
            test("diagnosticsLevel (case-sensitive union)", () => {
              for (const lvl of ["error", "warn", "info", "debug", "trace"] as const) {
                expect(validateConfig({ diagnosticsLevel: lvl }).diagnosticsLevel).toBe(lvl);
              }
              for (const bad of ["ERROR", "verbose", "off", "", 1, null, undefined]) {
                expect(validateConfig({ diagnosticsLevel: bad }).diagnosticsLevel).toBe("error");
              }
            });
          });
  - INSERT immediately AFTER that test's closing `});` and BEFORE the describe block's `});`:
            test("reasoningInjection (strict boolean)", () => {
              expect(validateConfig({ reasoningInjection: false }).reasoningInjection).toBe(false); // valid
              expect(validateConfig({ reasoningInjection: true }).reasoningInjection).toBe(true);   // valid
              for (const bad of ["true", 1, 0, null, undefined]) {
                expect(validateConfig({ reasoningInjection: bad }).reasoningInjection).toBe(true);  // invalid -> default
              }
            });
  - FOLLOW pattern: the existing `enabled` / `telemetryEnabled` tests — one valid-passes-through
        line, then a `for (const bad of [...])` table of invalid values each falling back to default.
  - NAMING: `"reasoningInjection (strict boolean)"` — mirrors `"diagnosticsLevel (case-sensitive union)"`.
  - GOTCHA: include `1` and `"true"` in the invalid table to prove NO coercion (typeof guard).

Task 2: MODIFY tests/config.test.ts — ADD reasoningInjectionDelimiter per-field test
  - INSERT immediately AFTER the new reasoningInjection test (Task 1), still inside the SAME
        per-field describe block:
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
  - FOLLOW pattern: the existing `supportedProviders` test — `.toEqual` for the object, a
        `for (const bad of [...])` table covering missing/empty/wrong-type/null/undefined.
  - GOTCHA: use the file's existing idiom `expect(...).toEqual({
        ...DEFAULT_CONFIG.reasoningInjectionDelimiter })` for the default-object assertions (NOT
        `.toBe`, and NOT a hand-copied fence literal). Cover "missing one part" AND "empty part"
        because `isOpenCloseShape` rejects both.

Task 3: MODIFY tests/config.test.ts — ADD directive-specific composition test
  - FIND the insertion anchor — the existing composition test at the top of the describe block
        `"validateConfig — composition rules"`:
            test("one invalid field does not poison valid fields", () => {
              const r = validateConfig({ enabled: false, transitionTimeoutMs: "bad", shortcut: "escape" });
              expect(r).toEqual({ ...FULL_DEFAULTS, enabled: false, shortcut: "escape" });
            });
  - INSERT immediately AFTER that test:
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
  - FOLLOW pattern: the existing composition tests — mutate one field, assert the other is intact.
  - GOTCHA: this is the directive-specific counterpart to the existing generic composition test; do
        NOT delete or merge with the generic one (different concerns).
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: per-field test = one valid-passes-through assertion + a `for (const bad of [...])` table
// of invalid values each falling back to the field's default. (Mirrors `enabled`, `telemetryEnabled`.)
test("reasoningInjection (strict boolean)", () => {
  expect(validateConfig({ reasoningInjection: false }).reasoningInjection).toBe(false); // valid
  expect(validateConfig({ reasoningInjection: true }).reasoningInjection).toBe(true);   // valid
  for (const bad of ["true", 1, 0, null, undefined]) {
    expect(validateConfig({ reasoningInjection: bad }).reasoningInjection).toBe(true);  // invalid -> default
  }
});

// PATTERN: object-valued field — `.toEqual` for pass-through AND for the default-object fallback,
// using the file idiom `{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`.
test("reasoningInjectionDelimiter (open & close both non-empty)", () => {
  expect(validateConfig({ reasoningInjectionDelimiter: { open: "x", close: "y" } })
    .reasoningInjectionDelimiter).toEqual({ open: "x", close: "y" }); // valid -> fresh copy
  for (const bad of [{ open: "x" }, { close: "y" }, { open: "", close: "y" }, "x", 42, [], null, undefined]) {
    expect(validateConfig({ reasoningInjectionDelimiter: bad }).reasoningInjectionDelimiter)
      .toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }); // invalid -> default object
  }
});

// PATTERN: composition — assert per-field fallback isolation (one bad field != poison others).
test("one invalid directive field does not poison the other directive field", () => {
  const a = validateConfig({ reasoningInjection: "bad", reasoningInjectionDelimiter: { open: "p", close: "q" } });
  expect(a.reasoningInjection).toBe(true);                                 // invalid -> default
  expect(a.reasoningInjectionDelimiter).toEqual({ open: "p", close: "q" }); // valid kept
  const b = validateConfig({ reasoningInjection: false, reasoningInjectionDelimiter: "bad" });
  expect(b.reasoningInjection).toBe(false);                                       // valid kept
  expect(b.reasoningInjectionDelimiter).toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }); // invalid -> default
});

// CRITICAL: every assertion above was verified against the live src/config/index.ts via `bun -e`
// (see research/notes.md). The input→result mapping is deterministic; no flakiness expected.
```

### Integration Points

```yaml
DATABASE: none.
CONFIG: none — READ-ONLY consumer of src/config/index.ts (already Complete). No config edit.
ROUTES/SERVICES: none — pure unit test of validateConfig. No network, no streaming, no provider.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Bun + TypeScript project. NO ruff/mypy/eslint/biome — do NOT run them (template artifacts).
# NOTE: tsconfig EXCLUDES tests/, so `bun run typecheck` does NOT type-check the test file. It is a
# no-op here but worth running to confirm src/ was NOT accidentally touched (zero errors expected).
bun run typecheck          # = tsc --noEmit (covers src/ only). Expected: zero errors, no output.
# Expected: clean. If errors appear in src/, you accidentally edited a source file — revert it.
```

### Level 2: Unit Tests (Component Validation)

```bash
# THE authoritative gate for this task. Target: 48 pass / 0 fail (was 45 pass — 3 new cases added).
bun test tests/config.test.ts
# Expected: "48 pass / 0 fail". If the 3 new tests fail, READ the diff between the assertion and the
# actual value printed by bun — the research/notes.md tables confirm each input→result mapping, so a
# failure means the test assertion diverges from the verified behavior (re-check src/config/index.ts
# guards `isBool` / `isOpenCloseShape`) OR the test was inserted in the wrong describe block.

# Spot-check the new tests specifically:
bun test tests/config.test.ts -t "reasoningInjection"
bun test tests/config.test.ts -t "directive field does not poison"
# Expected: each -t filter matches the new tests and they pass.
```

### Level 3: Integration Testing (System Validation)

```bash
# Full-suite regression. Config tests are independent of the parallel P2.M2.T3.S1 proxy/decorator
# wiring (config.test.ts imports only ../src/config), so the suite must stay green regardless.
bun test
# Expected: 0 fail across all files. (The parallel P2.M2.T3.S1 changes proxy.ts/decorator.ts; if any
# proxy/decorator test fails it is THAT task's concern, not this one — config tests will still pass.)

# Confirm NO source file was touched by this task (test-only):
git status --porcelain src/        # Expected: empty (nothing new from this task).
git diff --stat tests/config.test.ts   # Expected: +N lines (the 3 new test cases), 0 deletions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Confirm exactly 3 net-new test cases were added (no accidental duplication/removal):
git diff tests/config.test.ts | grep -c '^+.*test('   # Expected: 3
git diff tests/config.test.ts | grep -c '^-'          # Expected: 0 (no deletions; pure additions)

# Confirm the directive tests now span validateConfig (Task b/c) AND composition (Task e), and that
# the pre-existing env tests (item d) were NOT duplicated:
grep -n 'reasoningInjection\|Delimiter' tests/config.test.ts
# Expected: the pre-existing matches (FULL_DEFAULTS literal lines ~13-18 + env tests ~153-184) PLUS
# the 3 new validateConfig/composition tests in the per-field and composition blocks.

# Re-verify the implemented behavior matches the PRP assertions end-to-end (sanity, optional):
bun -e 'import { validateConfig } from "./src/config/index.ts";
console.log(validateConfig({ reasoningInjection: "x" }).reasoningInjection);          // true
console.log(validateConfig({ reasoningInjectionDelimiter: { open: "a" } }).reasoningInjectionDelimiter.open.startsWith("---")); // true (default fence)'
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun test tests/config.test.ts` → **48 pass / 0 fail** (3 new cases; was 45 pass).
- [ ] `bun test` (full suite) → 0 fail (no regression; independent of parallel P2.M2.T3.S1).
- [ ] `bun run typecheck` → zero errors (no-op on tests/; confirms src/ untouched).
- [ ] Level 4 greps confirm exactly 3 net-new `test(` additions and 0 deletions.

### Feature Validation

- [ ] `reasoningInjection` per-field test asserts valid `true`/`false` pass through AND invalid
      (`"true"`, `1`, `0`, `null`, `undefined`) → default `true`.
- [ ] `reasoningInjectionDelimiter` per-field test asserts valid `{open,close}` passes through AND
      invalid (missing open, missing close, empty string, non-object, array, `null`, `undefined`)
      → default delimiter object.
- [ ] Composition test asserts one invalid directive field does NOT poison the other directive field
      (both directions).
- [ ] No duplicate tests: FULL_DEFAULTS literal (item a) and env tests (item d) left untouched.
- [ ] All success criteria from the "What" section met.

### Code Quality Validation

- [ ] Follows the existing `tests/config.test.ts` conventions: `for (const bad of [...])` table
      style, `.toBe` for booleans, `.toEqual` (with `{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`
      idiom) for the delimiter object.
- [ ] Test names match existing field-led naming (`"reasoningInjection (…)"`,
      `"reasoningInjectionDelimiter (…)"`).
- [ ] New tests placed in the CORRECT describe blocks (per-field block vs composition block).
- [ ] No new imports added (all referenced symbols already imported).
- [ ] No source file modified.

### Documentation & Deployment

- [ ] No docs/README/CHANGELOG change (item DOCS note: "none — test code only"; those are P2.M3.T2.*).
- [ ] Test names are self-documenting.

---

## Anti-Patterns to Avoid

- ❌ Do NOT re-add the FULL_DEFAULTS literal update or the env tests — they are ALREADY committed
  (P2.M1.T1.S1/S2). This task adds ONLY the 3 `validateConfig`/composition cases.
- ❌ Do NOT use `.toBe` for the delimiter object — `validateConfig` returns a fresh copy; use `.toEqual`.
- ❌ Do NOT hand-copy the fence literal in assertions — use the file idiom
  `{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`.
- ❌ Do NOT omit `1`/`"true"`/`0` from the reasoningInjection invalid table — they prove the strict
  `typeof === "boolean"` guard does NO coercion (the whole point of the test).
- ❌ Do NOT omit the "missing one part" and "empty part" delimiter cases — `isOpenCloseShape` rejects
  both; only testing non-object/null would miss half the guard.
- ❌ Do NOT touch any source file, the import line, or any other test file — this is a 3-test
  addition to ONE file.
- ❌ Do NOT run ruff/mypy/eslint/biome — TypeScript+Bun project; those tools do not exist here.
- ❌ Do NOT rely on `bun run typecheck` to validate the test code — tsconfig excludes `tests/`;
  `bun test tests/config.test.ts` is the authoritative gate.
- ❌ Do NOT delete or merge the existing generic composition test — add the directive-specific one
  alongside it (different concerns).

---

**Confidence Score: 10/10** for one-pass implementation success.
Rationale: A single-file, pure-addition test change where every assertion has been **empirically
verified** against the live `src/config/index.ts` (input→result tables in research/notes.md, each
confirmed via `bun -e`). The exact current insertion anchors are quoted verbatim, the exact target
test code is given for all three cases, and the file's existing conventions (table-style invalid
sweeps, `.toBe`/`.toEqual` discipline, the `{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }`
default-object idiom) are mirrored line-for-line. The principal risk — accidental duplication of the
already-present FULL_DEFAULTS/env coverage — is called out explicitly in the gotchas and anti-patterns.
The authoritative validation command (`bun test tests/config.test.ts`) and expected count (45→48) are
pinned, and the scope boundary (sibling P2.M3.T1.S2 owns request-builder tests; parallel P2.M2.T3.S1
owns proxy/decorator source) prevents overlap.
