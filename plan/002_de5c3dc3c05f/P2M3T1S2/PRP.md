# PRP — P2.M3.T1.S2: RequestBuilder directive + invariant tests (INV-013, INV-014)

---

## Goal

**Feature Goal**: Close the directive test-coverage gap in `tests/request-builder.test.ts` for the
**Ephemeral Execution Directive** implemented in P2.M2.T2.S1 (PRD §53 / ADR-006). The `RequestBuilder`
is **already fully implemented and verified** — `buildReplacement(model, context, options,
reasoningSnapshot)` now renders the frozen snapshot, gates on `reasoningInjection && rendered.length > 0`,
injects a clearly-fenced ephemeral `UserMessage` into a FRESH context copy (non-mutating), and forces
`options.reasoning = undefined` on a fresh options object (INV-014). This task adds the **9 missing
test cases** (contract items a–i) so the directive behavior and invariants **INV-013** (reasoning is
reused, not discarded) and **INV-014** (reasoning disabled for exactly one request; original unmutated;
directive carries no reasoning field) are defended against future regression.

**Deliverable**: ONE modified test file — `tests/request-builder.test.ts`. **No source files touched.**
No new files. Specifically: ADD one value import (`DEFAULT_CONFIG`), one small helper
(`makeSnapshot`), **three new describe blocks** (5+2+1 = 8 tests) at the end of the file, and **one
new test** inside the existing privacy-guard describe block (1 test) → **9 net-new tests total**.

**Success Definition**:
- `bun test tests/request-builder.test.ts` exits 0. Test count goes **20 → 29** (9 new cases); 0 failures.
- `bun test` (full suite) exits 0 — no regression (request-builder tests are independent of the parallel
  sibling P2.M3.T1.S1 config tests and the now-complete P2.M2.T3.S1 proxy/decorator wiring).
- All 9 directive contract items (a–i) are covered; INV-013 and INV-014 each have a dedicated,
  self-named test.
- **No existing test is modified** — the 20 baseline tests pass unchanged because constructor defaults
  preserve prior behavior and the empty-`[]` context-identity assertion still holds (item i).
- **No duplicate tests** — the existing privacy test (empty snapshot) is left in place; the new privacy
  test targets the *materially stronger* active-injection case (reasoning text actually present).

## User Persona (if applicable)

**Target User**: Maintainers / future test authors of the pi-stop-thinking extension. Internal test
hardening — no end-user, API, or behavior change.
**Use Case**: Regression protection for the §53 directive injection and invariants INV-013/INV-014.
When someone later refactors `buildReplacement` (gating, context copying, options scoping, or the
directive message construction), these tests fail loudly if any of: (1) reasoning stops being reused
by default, (2) the original context/options get mutated, (3) reasoning leaks into the debug payload,
or (4) the directive message picks up a stray `reasoning` field.
**Pain Points Addressed**: Today the directive path is implemented but **only the empty-snapshot /
no-injection paths are exercised** (the 20 baseline tests all pass `[]`). A regression that, e.g.,
mutates the original context, discards the snapshot when it should inject, or leaks reasoning text to
diagnostics would pass CI silently. This fills that blind spot.

## Why

- **Business value**: The §53 Ephemeral Execution Directive is the headline feature of Phase 2
  (ADR-006 / INV-013). PRD §55 h2.178 lists "RequestBuilder (directive injection from
  `reasoningSnapshot`)" as a mandatory unit-test target; PRD §55 h2.182 (Property Tests) requires
  "Reasoning is disabled for exactly one request." This subtask is the directive portion of those targets.
- **Integration** (P2.M3 chain position):
  - **Consumes P2.M2.T2.S1** (Complete): the `RequestBuilder` constructor `(diagnostics,
    _reasoningInjection?, _delimiter?)`, `buildReplacement` snapshot-gated injection, fresh-context copy,
    fresh-options `{...options, reasoning: undefined}`, and the `DEFAULT_REPLACEMENT_MAX_TOKENS` bound.
    This subtask tests that completed behavior.
  - **Consumes P2.M2.T1.S1** (Complete): `renderReasoningText` (already unit-tested in the baseline file).
  - **Sibling P2.M3.T1.S1** (config tests): operates on `tests/config.test.ts`, NOT this file — no
    overlap, no conflict.
  - **Parallel P2.M2.T3.S1** (Complete, proxy/decorator wiring): touched `src/provider/proxy.ts` +
    `decorator.ts` ONLY. `request-builder.test.ts` imports neither, so it is unaffected.
- **Problems solved**: Eliminates the "directive injection implemented but the injection path is not
  asserted" gap. Pins the exact directive-message shape (`["role","content","timestamp"]`, no
  `reasoning`) so a future "fix" cannot silently turn message content into a reasoning-level signal
  (which would violate INV-014's per-request independence clause).

## What

User-visible behavior: none — test code only. The observable contract being asserted (already
implemented and **empirically verified** in `src/request/builder.ts` via `bun -e`, see
`research/notes.md`):

1. **Directive content (item a)** — non-empty snapshot + injection enabled (default): `triple.context`
   is a **NEW reference** (`not.toBe` original); `messages.length === original + 1`; the last message is
   a `UserMessage` (`role === "user"`) whose `content` contains the rendered reasoning wrapped in the
   delimiter fence (`open` at start, `close` present) plus the non-continuation positioning instruction
   (`"reference context only"`, `"Do not continue or extend reasoning."`).
2. **Gated fallback — disabled (item b)** — `reasoningInjection: false` + non-empty snapshot:
   `triple.context IS the same reference` (`toBe`); no directive appended; `options.reasoning` still `undefined`.
3. **Gated fallback — empty (item c)** — injection `true` (default) + `[]`: `triple.context IS the same
   reference`; no directive appended.
4. **Non-mutation (item d / §53 h3.73)** — after `buildReplacement` with injection active: original
   `context.messages` is the same array reference, same length, same `systemPrompt`; original `options`
   is unmutated (`reasoning`, `temperature` intact; no new `maxTokens` key added).
5. **Privacy (item e / Appendix H h2.203)** — with injection **active** (reasoning text present): the
   `request.replacement-built` debug event fires exactly once and its `fields === {}` (no
   reasoning/directive/prompt/options content leak).
6. **INV-013 (item f)** — `new RequestBuilder(diag)` (default `reasoningInjection: true`) + non-empty
   snapshot → augmented context with the directive; reasoning is reused, not discarded.
7. **INV-014 (item g)** — `triple.options.reasoning === undefined` on a FRESH options object; original
   `options.reasoning` unmutated; the directive message carries NO `reasoning` field (its keys are
   exactly `["role","content","timestamp"]`).
8. **maxTokens (item h / §25.6 h2.97)** — when original options has no `maxTokens`,
   `triple.options.maxTokens === 16384`; when it HAS `maxTokens`, it is preserved verbatim.
9. **Existing tests (item i)** — the 20 baseline tests (including the empty-`[]` context-identity
   assertion) pass unchanged; defaults preserve prior behavior. No edit required.

### Success Criteria

- [ ] 9 net-new `test(...)` cases added to `tests/request-builder.test.ts` (8 in 3 new describes + 1
      inside the existing privacy describe).
- [ ] Each contract item a–i has at least one dedicated assertion (INV-013 and INV-014 each get a
      self-named test).
- [ ] The privacy test covers the **active-injection** case (reasoning text present), not just empty.
- [ ] The INV-014 test asserts the directive message's keys are exactly `["role","content","timestamp"]`
      (no `reasoning` field).
- [ ] `bun test tests/request-builder.test.ts` → **29 pass / 0 fail** (was 20 pass).
- [ ] `bun test` (full suite) → 0 fail.
- [ ] No source file modified (`git status --porcelain src/` shows nothing new from this task).
- [ ] No existing test modified; no duplicate of the baseline privacy test.

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes.** This PRP names the single file to edit, quotes the EXACT current insertion
anchors verbatim (import block, `makeContext` helper, privacy describe block), gives the EXACT new
import + helper + test code (whose every assertion was **empirically verified** against the live
`src/request/builder.ts` via `bun -e`), cites the authoritative behavior source (`src/request/builder.ts`
`buildReplacement` + `directive_design.md` §2/§4/§8), and pins the verified validation commands and
expected test counts (20→29).

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: tests/request-builder.test.ts
  why: THE ONLY file to modify. Contains the test doubles (makeCaptureDiag/makeModel/makeContext) the
        new tests reuse, the renderReasoningText describe block (the snapshot-renderer half, already
        covered — do NOT duplicate), and the "RequestBuilder — privacy guard (Appendix H)" describe
        block (insertion point for the new active-injection privacy test). The 20 baseline tests all
        pass `[]` as the snapshot — none exercises the injection path, which is exactly the gap.
  pattern: Each test is self-contained: build `{ diag, events } = makeCaptureDiag()`, `new
        RequestBuilder(diag[, injection[, delimiter]])`, `makeModel()`, `makeContext()`, hand-built
        options (cast `as SimpleStreamOptions`), then assert on the returned triple. Assertions use
        `.toBe` for primitives/refs, `.not.toBe` for "fresh copy", `.toContain` for directive content.
  gotcha: The 3 NEW describe blocks are APPENDED at the end of the file (after the privacy describe).
        The 1 new privacy test is INSERTED INSIDE the existing privacy describe (before its closing
        `});`). Do not put the privacy test at the end of the file.

- file: src/request/builder.ts
  why: READ-ONLY. Defines the behavior under test (already Complete, P2.M2.T2.S1). Key facts:
        - Constructor: `new RequestBuilder(diagnostics, _reasoningInjection = DEFAULT_CONFIG.reasoningInjection,
          _delimiter = DEFAULT_CONFIG.reasoningInjectionDelimiter)`.
        - Gate: `shouldInject = this._reasoningInjection && rendered.length > 0`.
        - Directive message literal: `{ role:"user", content: open + "\n" + rendered + "\n" + close +
          "\n\nUsing the prior reasoning above as reference context only, produce your best available
          answer to the user's request now. Do not continue or extend reasoning.", timestamp: Date.now() }`
          → keys are exactly `["role","content","timestamp"]` (NO `reasoning` field — INV-014).
        - Fresh context: `{ ...context, messages: [...context.messages, directiveMessage] }` (NEW ref).
        - Fresh options: `{ ...options, reasoning: undefined }`; then `if (maxTokens === undefined)
          maxTokens = DEFAULT_REPLACEMENT_MAX_TOKENS` (= 16384).
        - Privacy: `this.diagnostics.debug("request.replacement-built", {})`.
  section: buildReplacement (the class method); DEFAULT_REPLACEMENT_MAX_TOKENS const (16384).
  gotcha: A VALID injected context is a NEW object — so `.toBe(context)` is WRONG for the
        active-injection case; use `.not.toBe(context)`. The gated-fallback cases return the SAME ref —
        there `.toBe(context)` is correct. Do not mix these up (item a vs items b/c).

- file: src/config/index.ts
  why: READ-ONLY. Source of `DEFAULT_CONFIG` (the value the new import pulls in) — specifically
        `DEFAULT_CONFIG.reasoningInjectionDelimiter = { open: "---\n[Prior reasoning captured before
        you were asked to stop thinking]", close: "[End of prior reasoning]\n---" }`. Referencing it
        via the import (rather than hand-copying the fence literal) keeps the test decoupled from the
        exact fence string.
  section: DEFAULT_CONFIG (frozen object).

- file: src/buffer/index.ts
  why: READ-ONLY. `ReasoningBuffer` (used by the new `makeSnapshot` helper) + `ThinkingEntry` type
        (already imported in the test file). `append` → `freeze` → `snapshot()` is the lifecycle the
        helper mirrors. `snapshot()` returns a frozen array of frozen entry copies.
  section: ReasoningBuffer class.

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: Authoritative implementation contract for the directive delta. §2 = exact directive-message
        construction + delimiter defaults; §4 = gating logic; §8 = the test-contract assertions
        (directive content, gated fallbacks, non-mutation, INV-014 options scoping, privacy, INV-013).
  section: §2 (directive message), §4 (gating), §8 (test contract).

- docfile: plan/002_de5c3dc3c05f/architecture/current-impl-state.md
  why: §5 documents the existing test helpers (makeCaptureDiag/makeModel/makeContext) and confirms the
        existing context-identity test passes with empty `[]` (still valid after the directive change).
  section: §5 Test infrastructure.

- docfile: plan/002_de5c3dc3c05f/P2M3T1S2/research/notes.md
  why: The empirically-verified input→result mapping for ALL 9 contract items (a–i), each confirmed
        via `bun -e` against the live builder. Every assertion in the new tests is backed by a row here.

- prd: §53 (Replacement Request Specification — h1.73/h2.176/h3.70–h3.74), §48 (Acceptance h1.68),
       §55 (Testing h2.178/h2.179), Appendix O (INV-013 h2.232 / INV-014 h2.233), Appendix H
       (Logging h2.203), §60 (Readiness h2.184/h2.185).
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/request/builder.ts      # READ-ONLY — behavior source (buildReplacement directive injection). Complete (P2.M2.T2.S1).
src/config/index.ts         # READ-ONLY — DEFAULT_CONFIG (delimiter fence) imported by the new tests.
src/buffer/index.ts         # READ-ONLY — ReasoningBuffer + ThinkingEntry (used by makeSnapshot helper).
tests/request-builder.test.ts  # <-- MODIFY: +1 import, +1 helper, +3 describe blocks, +1 privacy test (9 new tests total).
package.json                # scripts: test=bun test, typecheck=tsc --noEmit, build=tsc
tsconfig.json               # strict:true; "exclude": ["node_modules","dist","tests"]  <-- typecheck DOES NOT cover tests/
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. ONE MODIFIED file:
tests/request-builder.test.ts   # +9 test(...) cases across 3 new describes + 1 new privacy test, plus
                                #   the DEFAULT_CONFIG import and a makeSnapshot helper:
                                #   • "Ephemeral Execution Directive (§53 / ADR-006)" — 5 tests
                                #       (directive content, gated-disabled, gated-empty, INV-013, custom delimiter)
                                #   • "directive non-mutation & INV-014 (§53 h3.73)" — 2 tests
                                #   • "maxTokens bound (§25.6 h2.97)" — 1 test
                                #   • privacy guard (existing describe) — 1 new test (active-injection case)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (ref-vs-copy discipline — the #1 way to write a wrong assertion here): buildReplacement
// returns a NEW context reference ONLY when the injection gate passes (non-empty snapshot + injection
// enabled). When the gate FAILS (disabled OR empty), it returns the SAME context reference. So:
//   active injection:  expect(triple.context).not.toBe(context);   // CORRECT (fresh copy)
//   gated fallback:   expect(triple.context).toBe(context);        // CORRECT (same ref)
// Do NOT swap these. Items a (not.toBe) vs b/c (toBe) hinge on this.

// CRITICAL (capture the ref BEFORE the call for non-mutation): makeContext() returns a fresh object
// each call, and buildReplacement spreads a NEW messages array. To assert the ORIGINAL is untouched
// you must grab `const originalMessagesRef = context.messages;` BEFORE calling buildReplacement, then
// assert `context.messages === originalMessagesRef` AFTER. Re-calling makeContext() would compare
// against a different object and prove nothing.

// CRITICAL (typecheck is NOT the gate): tsconfig.json EXCLUDES tests/ from tsc, so
// `bun run typecheck` does NOT type-check tests/request-builder.test.ts. The authoritative gate is
// `bun test tests/request-builder.test.ts`. (Run typecheck only to confirm src/ was not accidentally
// touched — it should be a no-op.) Do NOT invent an eslint/biome/ruff/mypy step — Bun+TS project.

// CRITICAL (DEFAULT_CONFIG must be a VALUE import): the new tests reference
// DEFAULT_CONFIG.reasoningInjectionDelimiter (open/close fence). DEFAULT_CONFIG is a `const` object,
// so the import is `import { DEFAULT_CONFIG } from "../src/config";` (NOT `import type`). This is the
// ONLY import change; all other symbols (RequestBuilder, renderReasoningText, ReasoningBuffer,
// ThinkingEntry, Diagnostics) are already imported.

// CRITICAL (no duplicate of the baseline privacy test): the existing "debug event fires once with
// fields === {}" test passes an EMPTY snapshot (reasoning text never flows). The new privacy test must
// pass a NON-EMPTY snapshot (injection active) so it proves reasoning text does NOT leak even when it
// is present — the materially stronger assertion. Do NOT delete or merge the existing one.

// CRITICAL (directive message has exactly 3 keys, no reasoning): the directive is constructed as a
// plain object literal `{ role, content, timestamp }`. Asserting
// `Object.keys(directive).sort()).toEqual(["content","role","timestamp"])` pins the shape and proves a
// future change cannot sneak a `reasoning` field onto the message (which would conflate message content
// with the per-request reasoning option — an INV-014 violation).
```

## Implementation Blueprint

### Data models and structure

No new data models — pure test code exercising the existing `ReplacementRequest` triple and the
`ThinkingEntry` snapshot. The only structural additions are one import and one helper:

```typescript
// NEW value import (top of file, after the Diagnostics type import):
import { DEFAULT_CONFIG } from "../src/config";

// NEW helper (in the test-doubles section, after makeContext()) — builds a frozen snapshot:
function makeSnapshot(diagnostics: Diagnostics, ...deltas: string[]): readonly ThinkingEntry[] {
  const buffer = new ReasoningBuffer(diagnostics, 1_000_000);
  for (const delta of deltas) buffer.append(delta);
  buffer.freeze();
  return buffer.snapshot();
}
// (Diagnostics, ReasoningBuffer, ThinkingEntry are all ALREADY imported in the file.)
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY tests/request-builder.test.ts — ADD the DEFAULT_CONFIG value import
  - FIND the import block at the top of the file (lines 1–6):
        import { describe, test, expect } from "bun:test";
        import { RequestBuilder, renderReasoningText } from "../src/request/builder";
        import type { ReplacementRequest } from "../src/request/builder";
        import { ReasoningBuffer } from "../src/buffer";
        import type { ThinkingEntry } from "../src/buffer";
        import type { Diagnostics } from "../src/diagnostics";
  - INSERT one new line immediately AFTER the Diagnostics import:
        import { DEFAULT_CONFIG } from "../src/config";
  - NAMING/PLACEMENT: value import (NOT `import type`), grouped with the other `../src/*` imports.
  - GOTCHA: DEFAULT_CONFIG is a const object → must be a value import or the delimiter assertions
        won't resolve.

Task 2: MODIFY tests/request-builder.test.ts — ADD the makeSnapshot helper
  - FIND the end of the makeContext() helper (the existing test-doubles section):
        /** Minimal Context mock. */
        function makeContext() {
          return {
            systemPrompt: "You are helpful.",
            messages: [{ role: "user" as const, content: "Hello" }],
          } as unknown as import("@earendil-works/pi-ai").Context;
        }
  - INSERT immediately AFTER makeContext's closing `}`:
        /** Build a frozen ReasoningBuffer snapshot from the given deltas (mirrors the buffer lifecycle). */
        function makeSnapshot(diagnostics: Diagnostics, ...deltas: string[]): readonly ThinkingEntry[] {
          const buffer = new ReasoningBuffer(diagnostics, 1_000_000);
          for (const delta of deltas) buffer.append(delta);
          buffer.freeze();
          return buffer.snapshot();
        }
  - FOLLOW pattern: the baseline "frozen snapshot accepted" test inlines this exact buffer lifecycle;
        the helper just DRYs it for the directive tests.
  - NAMING: `makeSnapshot` — mirrors `makeModel` / `makeContext` / `makeCaptureDiag`.

Task 3: MODIFY tests/request-builder.test.ts — ADD "Ephemeral Execution Directive" describe (5 tests)
  - APPEND at the END of the file (after the final `});` of the privacy-guard describe). Full block:
        describe("RequestBuilder — Ephemeral Execution Directive (§53 / ADR-006)", () => {
          test("directive content — non-empty snapshot appends exactly one fenced UserMessage directive", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag); // DEFAULT: injection enabled, default delimiter
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high", temperature: 0.7 } as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "Step 1: analyze. ", "Step 2: conclude.");

            const triple = builder.buildReplacement(model, context, options, snapshot);

            // Augmented context is a NEW reference (§53 h3.73 fresh copy).
            expect(triple.context).not.toBe(context);
            // Exactly ONE directive message appended.
            expect(triple.context.messages.length).toBe(context.messages.length + 1);
            // The appended message is a UserMessage.
            const directive = triple.context.messages[triple.context.messages.length - 1] as { role: string; content: string };
            expect(directive.role).toBe("user");
            // Content: rendered reasoning wrapped in the delimiter fence + non-continuation positioning.
            expect(directive.content).toContain("Step 1: analyze. Step 2: conclude."); // rendered, offset-ordered
            expect(directive.content.startsWith(DEFAULT_CONFIG.reasoningInjectionDelimiter.open)).toBe(true); // fenced open
            expect(directive.content).toContain(DEFAULT_CONFIG.reasoningInjectionDelimiter.close); // fenced close
            expect(directive.content).toContain("reference context only"); // §53 h3.72 positioning
            expect(directive.content).toContain("Do not continue or extend reasoning."); // non-continuation
          });

          test("gated fallback — reasoningInjection: false returns the SAME context reference (no directive)", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag, false); // injection DISABLED
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "reasoning that should be ignored"); // non-empty

            const triple = builder.buildReplacement(model, context, options, snapshot);

            // Gated fallback (disabled): context IS the same reference; no directive appended.
            expect(triple.context).toBe(context);
            expect(triple.context.messages.length).toBe(context.messages.length);
            // INV-014 holds regardless of the injection gate.
            expect(triple.options.reasoning).toBeUndefined();
          });

          test("gated fallback — empty snapshot returns the SAME context reference (no directive)", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag); // injection DEFAULT true
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;

            const triple = builder.buildReplacement(model, context, options, []); // empty snapshot

            // Gated fallback (empty): context IS the same reference; no directive appended.
            expect(triple.context).toBe(context);
            expect(triple.context.messages.length).toBe(context.messages.length);
          });

          test("INV-013 — by default (constructor defaults), a non-empty snapshot is reused, not discarded", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag); // NO explicit injection arg → DEFAULT true (INV-013)
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "captured material reasoning");

            const triple = builder.buildReplacement(model, context, options, snapshot);

            // INV-013: reasoning is reused — the directive is present (augmented context).
            expect(triple.context).not.toBe(context);
            expect(triple.context.messages.length).toBeGreaterThan(context.messages.length);
            const directive = triple.context.messages[triple.context.messages.length - 1] as { content: string };
            expect(directive.content).toContain("captured material reasoning");
          });

          test("custom delimiter — the builder renders reasoning inside the supplied open/close fence", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag, true, { open: "<<<OPEN>>>", close: "<<<CLOSE>>>" });
            const model = makeModel();
            const context = makeContext();
            const options = {} as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "MYTEXT");

            const triple = builder.buildReplacement(model, context, options, snapshot);

            const directive = triple.context.messages[triple.context.messages.length - 1] as { content: string };
            expect(directive.content).toContain("<<<OPEN>>>");
            expect(directive.content).toContain("<<<CLOSE>>>");
            expect(directive.content).toContain("MYTEXT");
          });
        });
  - FOLLOW pattern: the baseline tests (self-contained per test, `as SimpleStreamOptions` cast).
  - GOTCHA: the directive-content test uses `.not.toBe(context)` (NEW ref) while the two gated-fallback
        tests use `.toBe(context)` (SAME ref) — do not swap.

Task 4: MODIFY tests/request-builder.test.ts — ADD non-mutation & INV-014 describe (2 tests)
  - APPEND at the END of the file (after the Task 3 block). Full block:
        describe("RequestBuilder — directive non-mutation & INV-014 (§53 h3.73)", () => {
          test("non-mutation — original context, messages array, systemPrompt, and options are unchanged after injection", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag);
            const model = makeModel();
            const context = makeContext();
            const originalMessagesRef = context.messages; // capture BEFORE the call
            const options = { reasoning: "high", temperature: 0.7 } as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "prior reasoning");

            builder.buildReplacement(model, context, options, snapshot);

            // §53 h3.73: the directive is ephemeral — original context & options are NOT mutated.
            expect(context.messages).toBe(originalMessagesRef);    // same messages array reference
            expect(context.messages.length).toBe(1);               // unchanged length
            expect(context.systemPrompt).toBe("You are helpful."); // untouched
            expect(options.reasoning).toBe("high");                // original reasoning level intact
            expect(options.temperature).toBe(0.7);                 // original sampling intact
            expect("maxTokens" in options).toBe(false);            // no new keys added to original options
          });

          test("INV-014 — triple.options.reasoning === undefined (fresh options); directive message carries NO reasoning field", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag);
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "some reasoning");

            const triple = builder.buildReplacement(model, context, options, snapshot);

            // INV-014: reasoning disabled for EXACTLY this one request via a FRESH options object.
            expect(triple.options).not.toBe(options);              // fresh object (not the original ref)
            expect(triple.options.reasoning).toBeUndefined();      // reasoning OFF for the replacement
            expect(options.reasoning).toBe("high");                // original options UNMUTATED
            // The directive message is plain message CONTENT — it carries no reasoning-level field.
            const directive = triple.context.messages[triple.context.messages.length - 1] as Record<string, unknown>;
            expect("reasoning" in directive).toBe(false);
            expect(Object.keys(directive).sort()).toEqual(["content", "role", "timestamp"]);
          });
        });
  - GOTCHA: capture `originalMessagesRef` BEFORE buildReplacement; assert `context.messages ===
        originalMessagesRef` AFTER (item d).

Task 5: MODIFY tests/request-builder.test.ts — ADD maxTokens describe (1 test)
  - APPEND at the END of the file (after the Task 4 block). Full block:
        describe("RequestBuilder — maxTokens bound (§25.6 h2.97)", () => {
          test("maxTokens — caller value preserved; bounded default applied only when absent", () => {
            const { diag } = makeCaptureDiag();
            const builder = new RequestBuilder(diag);
            const model = makeModel();
            const context = makeContext();
            const snapshot = makeSnapshot(diag, "x");

            // Absent maxTokens → bounded default (DEFAULT_REPLACEMENT_MAX_TOKENS = 16384).
            const absent = builder.buildReplacement(
              model, context,
              { temperature: 0.5 } as import("@earendil-works/pi-ai").SimpleStreamOptions,
              snapshot,
            );
            expect(absent.options.maxTokens).toBe(16384);

            // Caller-supplied maxTokens → preserved verbatim.
            const present = builder.buildReplacement(
              model, context,
              { maxTokens: 4096 } as import("@earendil-works/pi-ai").SimpleStreamOptions,
              snapshot,
            );
            expect(present.options.maxTokens).toBe(4096);
          });
        });
  - GOTCHA: the maxTokens bound is independent of the injection gate (it applies even for empty
        snapshots); testing it with a non-empty snapshot is sufficient.

Task 6: MODIFY tests/request-builder.test.ts — ADD active-injection privacy test (1 test)
  - FIND the existing privacy-guard describe block at the END of the file:
        describe("RequestBuilder — privacy guard (Appendix H)", () => {
          test("debug event fires once with fields === {} (no content/prompt/options keys)", () => {
            const { diag, events } = makeCaptureDiag();
            const builder = new RequestBuilder(diag);
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high", apiKey: "secret-key" } as import("@earendil-works/pi-ai").SimpleStreamOptions;

            builder.buildReplacement(model, context, options, []);

            // Exactly one replacement-built event
            const builtEvents = events.filter((c) => c.event === "request.replacement-built");
            expect(builtEvents).toHaveLength(1);
            // Fields must be exactly {} — no content, no prompt, no options, no reasoning
            expect(builtEvents[0].fields).toEqual({});
          });
        });
  - INSERT a SECOND test immediately AFTER the existing test's closing `});` and BEFORE the
        describe's closing `});`:
          test("fields remain {} even when directive injection is active (reasoning text present)", () => {
            const { diag, events } = makeCaptureDiag();
            const builder = new RequestBuilder(diag);
            const model = makeModel();
            const context = makeContext();
            const options = { reasoning: "high", apiKey: "secret-key" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
            const snapshot = makeSnapshot(diag, "sensitive reasoning content"); // NON-empty → injection active

            builder.buildReplacement(model, context, options, snapshot);

            const builtEvents = events.filter((c) => c.event === "request.replacement-built");
            expect(builtEvents).toHaveLength(1);
            // Even with reasoning text + directive flowing through, the debug payload leaks NOTHING.
            expect(builtEvents[0].fields).toEqual({});
          });
  - GOTCHA: this goes INSIDE the existing privacy describe (before its `});`), NOT at the end of the
        file. It is the materially stronger privacy assertion (reasoning text actually present).
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: directive test = capture the original refs, build a non-empty snapshot via makeSnapshot,
// call buildReplacement, then assert on the augmented context's LAST message. (Mirrors the baseline
// "frozen snapshot accepted" test but adds directive-content assertions.)
test("directive content — …", () => {
  const { diag } = makeCaptureDiag();
  const builder = new RequestBuilder(diag);                 // DEFAULT injection
  const context = makeContext();
  const snapshot = makeSnapshot(diag, "Step 1: ", "Step 2.");
  const triple = builder.buildReplacement(makeModel(), context,
    { reasoning: "high" } as SimpleStreamOptions, snapshot);
  expect(triple.context).not.toBe(context);                 // NEW ref (gate passed)
  expect(triple.context.messages.length).toBe(context.messages.length + 1);
  const d = triple.context.messages.at(-1) as { role: string; content: string };
  expect(d.role).toBe("user");
  expect(d.content).toContain("Step 1: Step 2.");           // rendered
});

// PATTERN: gated fallback = SAME reference (toBe, not not.toBe). Two triggers: injection disabled,
// OR empty snapshot.
test("gated fallback — empty → same ref", () => {
  const triple = new RequestBuilder(makeCaptureDiag().diag)
    .buildReplacement(makeModel(), makeContext(), { reasoning: "high" } as SimpleStreamOptions, []);
  expect(triple.context).toBe(/* the context you passed */); // SAME ref
});

// PATTERN: INV-014 = assert BOTH the fresh options (reasoning undefined) AND the directive message's
// exact key set (proves no reasoning field sneaks onto the message).
expect(triple.options).not.toBe(options);
expect(triple.options.reasoning).toBeUndefined();
expect(options.reasoning).toBe("high");                     // original unmutated
expect(Object.keys(directive).sort()).toEqual(["content", "role", "timestamp"]);

// CRITICAL: every assertion above was verified against the live src/request/builder.ts via `bun -e`
// (see research/notes.md). The input→result mapping is deterministic; no flakiness expected.
```

### Integration Points

```yaml
DATABASE: none.
CONFIG: none — READ-ONLY consumer of src/config (DEFAULT_CONFIG import only). No config edit.
ROUTES/SERVICES: none — pure unit test of RequestBuilder.buildReplacement. No network, no streaming,
  no provider, no proxy. The directive path is exercised directly with hand-built snapshots.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Bun + TypeScript project. NO ruff/mypy/eslint/biome — do NOT run them (template artifacts).
# NOTE: tsconfig EXCLUDES tests/, so `bun run typecheck` does NOT type-check the test file. Run it only
# to confirm src/ was NOT accidentally touched (zero errors expected = no-op on tests/).
bun run typecheck          # = tsc --noEmit (covers src/ only). Expected: zero errors, no output.
# Expected: clean. If errors appear in src/, you accidentally edited a source file — revert it.
```

### Level 2: Unit Tests (Component Validation)

```bash
# THE authoritative gate for this task. Target: 29 pass / 0 fail (was 20 pass — 9 new cases added).
bun test tests/request-builder.test.ts
# Expected: "29 pass / 0 fail". If a new test fails, READ the diff between the assertion and the actual
# value printed by bun — research/notes.md confirms each input→result mapping, so a failure means the
# test assertion diverges from the verified behavior OR a `.toBe`/`.not.toBe` was swapped (items a vs b/c).

# Spot-check the new directive tests specifically:
bun test tests/request-builder.test.ts -t "Ephemeral Execution Directive"
bun test tests/request-builder.test.ts -t "INV-013"
bun test tests/request-builder.test.ts -t "INV-014"
bun test tests/request-builder.test.ts -t "maxTokens"
bun test tests/request-builder.test.ts -t "directive injection is active"
# Expected: each -t filter matches the new tests and they pass.
```

### Level 3: Integration Testing (System Validation)

```bash
# Full-suite regression. request-builder tests are independent of the sibling config tests and the
# complete proxy/decorator wiring (request-builder.test.ts imports ../src/request/builder,
# ../src/buffer, ../src/config, ../src/diagnostics only), so the suite must stay green.
bun test
# Expected: 0 fail across all files. (If any other test file fails it is THAT task's concern, not this
# one — request-builder tests will still pass.)

# Confirm NO source file was touched by this task (test-only):
git status --porcelain src/             # Expected: empty (nothing new from this task).
git diff --stat tests/request-builder.test.ts   # Expected: +N lines (the import, helper, 9 tests), 0 deletions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Confirm exactly 9 net-new test cases were added (no accidental duplication/removal of baseline tests):
git diff tests/request-builder.test.ts | grep -c '^+.*test('   # Expected: 9
git diff tests/request-builder.test.ts | grep -c '^-'          # Expected: 0 (pure additions)

# Confirm the directive path is now covered end-to-end (sanity, optional) — re-verify the live builder:
bun -e 'import { RequestBuilder } from "./src/request/builder.ts";
import { ReasoningBuffer } from "./src/buffer/index.ts";
const d:any={debug:()=>{}}; const b=new ReasoningBuffer(d,1e6); b.append("hi"); b.freeze();
const rb=new RequestBuilder(d); const t=rb.buildReplacement({} as any, {messages:[]} as any, {} as any, b.snapshot());
console.log("augmented:", t.context.messages.length, "reasoning:", t.options.reasoning, "maxTokens:", t.options.maxTokens);'
# Expected: augmented: 1 reasoning: undefined maxTokens: 16384

# Confirm the new describe blocks are present and named per the contract:
grep -n 'describe(' tests/request-builder.test.ts
# Expected: the existing describes PLUS the 3 new ones ("Ephemeral Execution Directive",
# "directive non-mutation & INV-014", "maxTokens bound").
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun test tests/request-builder.test.ts` → **29 pass / 0 fail** (9 new cases; was 20 pass).
- [ ] `bun test` (full suite) → 0 fail (no regression; independent of sibling config tests).
- [ ] `bun run typecheck` → zero errors (no-op on tests/; confirms src/ untouched).
- [ ] Level 4 greps confirm exactly 9 net-new `test(` additions and 0 deletions.

### Feature Validation

- [ ] **Item a** — directive content: non-empty snapshot → NEW context ref, `+1` message, `UserMessage`
      with rendered reasoning + fence + positioning instruction.
- [ ] **Item b** — gated fallback disabled: `reasoningInjection: false` → SAME context ref, no directive.
- [ ] **Item c** — gated fallback empty: `[]` snapshot → SAME context ref, no directive.
- [ ] **Item d** — non-mutation: original `context.messages` ref/length + `systemPrompt` + `options`
      fields unchanged; no new `maxTokens` key on original options.
- [ ] **Item e** — privacy: `fields === {}` with injection ACTIVE (reasoning text present).
- [ ] **Item f (INV-013)** — default ctor reuses reasoning (augmented context + directive present).
- [ ] **Item g (INV-014)** — `triple.options.reasoning === undefined` on fresh options; original
      unmutated; directive message keys exactly `["content","role","timestamp"]` (no `reasoning`).
- [ ] **Item h** — maxTokens: absent → `16384`; present → preserved.
- [ ] **Item i** — 20 baseline tests pass unchanged (no edit to existing tests).
- [ ] All success criteria from the "What" section met.

### Code Quality Validation

- [ ] Follows the existing `tests/request-builder.test.ts` conventions: self-contained tests,
      `makeCaptureDiag`/`makeModel`/`makeContext` reuse, `as SimpleStreamOptions` casts, `.toBe`/
      `.not.toBe`/`.toContain` discipline.
- [ ] Describe-block names are self-documenting and cite the PRD section/invariant.
- [ ] New describes appended at end of file; the privacy test inserted INSIDE the existing privacy
      describe (correct placement).
- [ ] Only ONE import added (`DEFAULT_CONFIG`, value import); one helper added (`makeSnapshot`).
- [ ] No source file modified; no other test file touched.

### Documentation & Deployment

- [ ] No docs/README/CHANGELOG change (item DOCS note: "none — test code only"; those are P2.M3.T2.*).
- [ ] Test names are self-documenting (each names the invariant/contract item it defends).

---

## Anti-Patterns to Avoid

- ❌ Do NOT modify any of the 20 baseline tests — they pass unchanged (defaults preserve behavior;
  empty-`[]` context identity still holds). This is a pure-addition task.
- ❌ Do NOT swap `.toBe(context)` and `.not.toBe(context)`: active injection = NEW ref (`.not.toBe`);
  gated fallback (disabled/empty) = SAME ref (`.toBe`). Items a vs b/c hinge on this.
- ❌ Do NOT re-capture the context ref for the non-mutation assertion — grab
  `originalMessagesRef = context.messages` BEFORE `buildReplacement`, assert equality AFTER.
- ❌ Do NOT duplicate the baseline privacy test (empty snapshot). The new privacy test must use a
  NON-empty snapshot (injection active) — the materially stronger assertion.
- ❌ Do NOT hand-copy the delimiter fence literal in assertions — reference
  `DEFAULT_CONFIG.reasoningInjectionDelimiter` via the new import (keeps the test decoupled from the
  exact fence string; mirrors the config-test idiom).
- ❌ Do NOT assert the directive message has a `reasoning` field — it does NOT (keys are exactly
  `["role","content","timestamp"]`). Asserting the absence (INV-014) is the point.
- ❌ Do NOT touch any source file (`src/**`), any other test file, or the import lines beyond adding
  the single `DEFAULT_CONFIG` value import.
- ❌ Do NOT run ruff/mypy/eslint/biome — TypeScript+Bun project; those tools do not exist here.
- ❌ Do NOT rely on `bun run typecheck` to validate the test code — tsconfig excludes `tests/`;
  `bun test tests/request-builder.test.ts` is the authoritative gate.
- ❌ Do NOT place the new privacy test at the end of the file — it goes INSIDE the existing
  `"RequestBuilder — privacy guard (Appendix H)"` describe block.

---

**Confidence Score: 10/10** for one-pass implementation success.
Rationale: A single-file, pure-addition test change where every assertion has been **empirically
verified** against the live `src/request/builder.ts` via `bun -e` (input→result mapping for all 9
contract items in research/notes.md, each confirmed `true`). The exact current insertion anchors
(import block, `makeContext`, privacy describe) are quoted verbatim; the exact target import, helper,
and all 9 test bodies are given in full; and the file's existing conventions (self-contained tests,
helper reuse, `as SimpleStreamOptions` casts, `.toBe`/`.not.toBe`/`.toContain` discipline) are mirrored
line-for-line. The principal risks — swapping ref-vs-copy assertions, mis-placing the privacy test, and
duplicating the baseline privacy test — are called out explicitly in the gotchas and anti-patterns. The
authoritative validation command (`bun test tests/request-builder.test.ts`) and expected count (20→29)
are pinned, and the scope boundary (sibling P2.M3.T1.S1 owns config tests; P2.M2.T3.S1 already touched
proxy/decorator source only) prevents overlap. The builder under test is already Complete (P2.M2.T2.S1),
so this task asserts existing, frozen behavior — no implementation risk, only test-authoring risk.
