# PRP — P2.M2.T1.S1: Add renderReasoningText pure helper to src/request/builder.ts

---

## Goal

**Feature Goal**: Add an exported **pure** helper function `renderReasoningText(entries: readonly ThinkingEntry[]): string`
to `src/request/builder.ts` that renders the frozen reasoning snapshot to plain text — offset-ordered,
unmodified content concatenated — exactly as specified by PRD §53 h3.70 ("What is injected") and the
implementation contract in `plan/002_de5c3dc3c05f/architecture/directive_design.md §1`. This is the leaf
dependency that P2.M2.T2.S1's `buildReplacement` gating logic (`reasoningInjection && rendered.length > 0`)
will call. It is the first code-producing subtask of P2.M2 (Directive Construction & Integration).

**Deliverable**: A modified `src/request/builder.ts` exporting one new standalone module-level function
`renderReasoningText`, plus JSDoc (Mode A). No other source file changes. A focused unit-test block for
the pure function appended to the existing `tests/request-builder.test.ts`.

**Success Definition**:
- `bun run typecheck` (`tsc --noEmit`) passes with zero errors on `src/`.
- `bun test tests/request-builder.test.ts` passes (existing suite stays green; new render tests pass).
- `renderReasoningText([])` returns `""` (empty snapshot → empty string → directive omitted by T2's gate).
- `renderReasoningText([{offset:0,timestamp:1,content:"a"},{offset:1,timestamp:2,content:"b"}])` returns `"ab"`.
- The output contains ONLY `content` (no `offset`, `timestamp`, deltas, or envelope text leaks through).
- The function is exported from `src/request/builder.ts` (importable as a named export) and is NOT a class method.

## User Persona (if applicable)

**Target User**: Downstream developer (the P2.M2.T2.S1 author). This is an internal building block, not
an end-user-facing feature.
**Use Case**: `buildReplacement` calls `renderReasoningText(reasoningSnapshot)` to obtain the raw text
that drives both the inject/directive-omit gate and the directive message body.
**User Journey**: snapshot (frozen, offset-ordered) → `renderReasoningText` → plain text string → T2 gate
(`length > 0`?) + delimiter wrapping → ephemeral `UserMessage` in the replacement request.
**Pain Points Addressed**: Today `buildReplacement` accepts `reasoningSnapshot` but does NOT read it (MVP
omission, see current `src/request/builder.ts` comment "NOT read in MVP"). There is no canonical renderer,
so T2 cannot gate or wrap reasoning text. This task supplies the canonical, pure renderer.

## Why

- **Business value**: `renderReasoningText` is the textual core of ADR-006 / PRD §53 "Ephemeral Execution
  Directive" — the mechanism that reuses captured reasoning by injecting it as ephemeral reference context
  into the replacement request instead of discarding it. Without a renderer there is nothing to inject.
- **Integration**: This is the foundational subtask of P2.M2. Every downstream P2.M2 subtask depends on it:
  - **P2.M2.T2.S1** (buildReplacement gating + directive) calls `renderReasoningText` and uses its output
    for the `length > 0` gate and the directive message body.
  - **P2.M2.T3.S1** (proxy wiring) is unaffected by S1 directly but feeds the config the gate reads.
  - **P2.M3.T1.S2** (directive + invariant tests INV-013/INV-014) tests the gating behavior built on this
    renderer — the pure-function unit tests belong to S1; the gating/invariant tests belong to M3.
  Getting the renderer pure + opaque here (no interpretation, content-only) prevents a class of defects
  downstream (e.g. offsets/timestamps leaking into the injected text, violating h3.70).
- **Problems solved**: No canonical, pure renderer exists. PRD §53 h3.70 mandates that ONLY the rendered
  reasoning text is injected (no deltas, offsets, timestamps, or provider event envelopes). This function
  is the single, testable embodiment of that rule.

## What

User-visible behavior: none (internal helper). Observable contract for `renderReasoningText`:

1. **Input**: `entries: readonly ThinkingEntry[]` — the frozen snapshot from
   `ReasoningBuffer.snapshot()` (already offset-ordered append-order; entries are `readonly`).
2. **Logic**: `entries.map((e) => e.content).join("")` — concatenate each entry's `content` verbatim, in
   array order. **No** reordering, filtering, summarization, compression, trimming, or transformation.
3. **Output**: `string`. Empty snapshot (`[]`) → `""`. Non-empty → the concatenation of all `content`
   fields in offset order.
4. **Purity**: no `this`, no module-level mutable state, no I/O, no `Date.now()`, no diagnostics calls,
   no logging. Referentially transparent (same input ⇒ identical output). Deterministic. Total (never throws).
5. **Opaque-buffer guarantee** (PRD §13.4 h2.41 / §53 h3.70): the function does NOT interpret reasoning.
   The output is rendered text ONLY — `offset`, `timestamp`, and any provider-event metadata are NOT
   part of the output.
6. **Docs (Mode A)**: JSDoc on the exported function documenting purpose (PRD §53 "What is injected"),
   purity, and the opaque-buffer guarantee. No standalone docs subtask.

### Success Criteria

- [ ] `src/request/builder.ts` exports `renderReasoningText(entries: readonly ThinkingEntry[]): string`.
- [ ] Implementation body is `entries.map((e) => e.content).join("")` (or equivalent one-liner).
- [ ] `renderReasoningText([])` returns `""`.
- [ ] Output contains ONLY `content` (no offset/timestamp/envelope leakage — verified by a test).
- [ ] Order preserved (entries concatenated in array/offset order — verified by a test).
- [ ] Function is pure: no side effects, no diagnostics, not a class method, no mutation of input.
- [ ] JSDoc (Mode A) documents purpose (§53 h3.70), purity, and opaque-buffer guarantee (§13.4 h2.41).
- [ ] `RequestBuilder` class, `buildReplacement`, constructor, `ReplacementRequest` interface are UNCHANGED.
- [ ] `bun run typecheck` passes; `bun test tests/request-builder.test.ts` passes (existing + new tests).

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes** — this PRP names the single file to modify, quotes the exact function signature
and one-line body from the authoritative architecture contract, confirms `ThinkingEntry` is ALREADY
imported in that file (no new import), specifies exact placement, gives the exact JSDoc content
requirements (Mode A: purpose/purity/opaque guarantee with PRD anchors), defines the precise test
assertions (empty → "", join, order, content-only/no-leakage, purity), and states the verified
validation commands. No external libraries are involved; no config/wiring dependency exists (those land
in T2/T3). Scope boundaries vs. sibling subtasks are enumerated to prevent over-building.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: src/request/builder.ts
  why: THE ONLY source file to modify. Currently imports `ThinkingEntry` (line 44, "import type {
        ThinkingEntry } from "../buffer";") — REUSE this import; do NOT add a duplicate. Exports
        ReplacementRequest (interface) and RequestBuilder (class). Add renderReasoningText as a NEW
        exported module-level function.
  pattern: The file is pure TypeScript with rich JSDoc (see ReplacementRequest interface + buildReplacement
           method JSDoc for the doc style: purpose, pre/postconditions, PRD anchors like "(PRD §53)").
           Mirror that doc density for the new function.
  gotcha: Place the function AFTER the ReplacementRequest interface and BEFORE the RequestBuilder class
          (or at the end of the file) — but it MUST be `export function`, standalone, NOT a method on
          RequestBuilder. The class is intentionally UNCHANGED in S1 (T2 owns the constructor + gate).

- file: src/buffer/index.ts
  why: Defines ThinkingEntry (line 61): { readonly offset: number; readonly timestamp: number;
        readonly content: string }. snapshot() (returns readonly ThinkingEntry[]) is documented as
        "already offset-ordered" + "frozen array of frozen entry copies" — so renderReasoningText can
        rely on input order and never needs to sort.
  pattern: ThinkingEntry fields are `readonly`; .content is `string` (not string|undefined; tsconfig has
           only `strict`, NOT `noUncheckedIndexedAccess`). `.map((e) => e.content)` type-checks with no cast.
  gotcha: The buffer is OPAQUE (§13.4 / module JSDoc h2.41: "does not interpret reasoning"). The renderer
          must mirror that: concatenate content verbatim; never read offset/timestamp into the output.

- file: tests/request-builder.test.ts
  why: The existing test file for this module. Append a new describe("renderReasoningText — ...") block.
  pattern: `import { describe, test, expect } from "bun:test";`; imports `RequestBuilder`/`ReplacementRequest`
           from "../src/request/builder" and `ThinkingEntry` from "../src/buffer". ADD renderReasoningText
           to the existing "../src/request/builder" import (or a new named import line). Tests build
           ThinkingEntry[] literals directly (the function is pure over plain data — no stubs needed).
  gotcha: Directive/gating/invariant tests (INV-013/INV-014, shouldInject, context same-ref, options
          reasoning===undefined) belong to P2.M3.T1.S2 — do NOT add them here. S1 tests cover the PURE
          FUNCTION only (empty, join, order, content-only, no side effects).

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: THE authoritative implementation contract for the whole reasoning-reuse delta.
  section: "§1 renderReasoningText — Pure Snapshot Renderer" — gives the EXACT signature, the EXACT logic
           (`entries.map(e => e.content).join("")`), the empty→"" rule, offset-ordering note, and purity
           requirements. Implement verbatim.

- docfile: plan/002_de5c3dc3c05f/P2M1T1S1/PRP.md
  why: Context for the Config fields (reasoningInjection / reasoningInjectionDelimiter) that the gate in
        T2 reads. NOT a dependency of S1 (the renderer takes a snapshot, not config), but useful to
        understand where the gate's `reasoningInjection` flag comes from.
  section: Success Criteria (Config fields + validateConfig).

- docfile: plan/002_de5c3dc3c05f/P2M2T1S1/research/render-helper-contract.md
  why: Companion research note — placement decision, consumer chain, type-safety notes, scope-boundary
        matrix, JSDoc requirements.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/
  request/builder.ts      # <-- MODIFY: add exported renderReasoningText + JSDoc. (ThinkingEntry already imported.)
  buffer/index.ts         # READ-ONLY: defines ThinkingEntry + ReasoningBuffer.snapshot()
  config/index.ts         # NOT touched (config fields added by P2.M1.T1.* — not consumed by S1)
  provider/{decorator,proxy}.ts  # NOT touched (wiring is P2.M2.T3.*)
tests/
  request-builder.test.ts # <-- MODIFY: append a describe("renderReasoningText …") unit-test block
package.json              # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit
tsconfig.json             # strict:true; EXCLUDES "tests" from tsc (typecheck covers src/ only)
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. Two MODIFIED files:
src/request/builder.ts     # +1 exported module-level function renderReasoningText (pure one-liner) + JSDoc.
                           #   Reuses the existing ThinkingEntry import. RequestBuilder class UNCHANGED.
tests/request-builder.test.ts  # +1 describe block: renderReasoningText unit tests (empty/join/order/
                           #   content-only/no-leakage/purity). NO gating/invariant tests (those are M3).
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: ThinkingEntry is ALREADY imported in src/request/builder.ts (line 44): 
//   import type { ThinkingEntry } from "../buffer";
// REUSE it. Do NOT add a second import (TS error TS2300 duplicate identifier / lint noise).

// CRITICAL: The function is a STANDALONE exported function, NOT a method on RequestBuilder. It must be
// `export function renderReasoningText(...)`. Do NOT add it inside the class, and do NOT change the
// class's constructor or buildReplacement (those are P2.M2.T2.S1's scope).

// CRITICAL: `entries: readonly ThinkingEntry[]` — `.map()` IS available on readonly arrays (returns a
// fresh mutable array). `.join("")` returns `string`. NO cast needed. `[].map(...).join("") === ""` —
// the empty case needs NO special-case branch; join handles it natively.

// CRITICAL (purity): do NOT call this.diagnostics, Date.now(), console, or any module-level mutable
// variable. No `this`. Pure + referentially transparent + deterministic. Unlike buildReplacement (which
// emits one fire-and-forget debug milestone), renderReasoningText emits NOTHING (it has no Diagnostics
// dependency at all).

// CRITICAL (opaque-buffer, §13.4 h2.41 / §53 h3.70): output is rendered text ONLY. The implementation
// reads e.content ONLY. Do NOT include e.offset, e.timestamp, deltas, separators, or any envelope text.
// "No deltas, offsets, timestamps, or provider event envelopes are injected; only the rendered text."

// CRITICAL: tsconfig.json EXCLUDES "tests" from `tsc --noEmit`. Run BOTH `bun run typecheck` (src) AND
// `bun test` (tests). The test file is runtime-type-stripped by bun, not compiled by tsc.

// CRITICAL (scope): do NOT add delimiter wrapping (open/close fence), gating logic, directive message
// construction, or the RequestBuilder constructor change here — all are P2.M2.T2.S1. renderReasoningText
// returns RAW rendered text; T2 wraps + gates it. Do NOT touch proxy/decorator/config (T3 / M1).
```

## Implementation Blueprint

### Data models and structure

No new data models. The function operates on the existing `ThinkingEntry` (already defined in
`src/buffer/index.ts` and already imported in `src/request/builder.ts`):

```typescript
export interface ThinkingEntry {   // existing, from ../buffer
  readonly offset: number;
  readonly timestamp: number;
  readonly content: string;
}
```

`renderReasoningText` consumes `readonly ThinkingEntry[]` and returns `string`. No new types.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/request/builder.ts — add the exported renderReasoningText function (+ JSDoc)
  - LOCATE the insertion point: AFTER the ReplacementRequest interface block (ends ~line 100, before the
    `RequestBuilder` class comment "/**\n * Pure constructor of the thinking-disabled replacement...")
    OR at the end of the file after the class. Either is acceptable; pick AFTER the interface for grouping.
  - DO NOT add a new import: ThinkingEntry is already imported (line 44).
  - IMPLEMENT (verbatim body per architecture §1):
      /**
       * Render the frozen reasoning snapshot to plain text (PRD §53 h3.70 "What is injected").
       *
       * Concatenates each entry's `content` verbatim, in offset/append order (the snapshot from
       * {@link ReasoningBuffer.snapshot} is already offset-ordered). The result is the RAW reasoning
       * text — no deltas, offsets, timestamps, or provider event envelopes are included; only the
       * rendered text (PRD §53 h3.70).
       *
       * **Pure / opaque-buffer guarantee** (PRD §13.4 h2.41 — "The extension does not interpret
       * reasoning"): this function does NOT summarize, compress, truncate, reformat, or filter
       * content. It performs no side effects, no diagnostics, no I/O; it is referentially transparent
       * and deterministic (same snapshot ⇒ identical string). An empty snapshot yields `""`, which the
       * {@link RequestBuilder.buildReplacement} gate uses to omit the directive (PRD §53 h3.70).
       *
       * @param entries The frozen reasoning snapshot (already offset-ordered).
       * @returns The concatenated reasoning text; `""` for an empty snapshot.
       */
      export function renderReasoningText(entries: readonly ThinkingEntry[]): string {
        return entries.map((entry) => entry.content).join("");
      }
  - NAMING: function `renderReasoningText`; param `entries` (matches architecture §1); loop var `entry`.
  - FOLLOW pattern: the module's existing JSDoc density (see ReplacementRequest interface + buildReplacement
    method) — purpose, PRD anchors, purity notes. The block above already matches that style.
  - GOTCHA: the function body is intentionally a ONE-LINER. Do not over-engineer (no guards, no caching,
    no trimming, no sorting — the input is already ordered and frozen). Resist adding delimiter/gate logic.
  - PRESERVE: the ReplacementRequest interface, the RequestBuilder class, its constructor, buildReplacement,
    all existing imports, and all existing JSDoc. Zero changes outside the new function.

Task 2: MODIFY tests/request-builder.test.ts — append a renderReasoningText unit-test block
  - ADD renderReasoningText to the module import. The file currently has:
      import { RequestBuilder } from "../src/request/builder";
      import type { ReplacementRequest } from "../src/request/builder";
    CHANGE the first to: import { RequestBuilder, renderReasoningText } from "../src/request/builder";
    (ThinkingEntry is ALREADY imported: `import type { ThinkingEntry } from "../src/buffer";`.)
  - APPEND (at end of file, top-level):
      describe("renderReasoningText — pure snapshot renderer (PRD §53 h3.70)", () => {
        const mk = (offset: number, content: string, timestamp = offset): ThinkingEntry =>
          ({ offset, timestamp, content });

        test("empty snapshot → empty string", () => {
          expect(renderReasoningText([])).toBe("");
        });

        test("single entry → its content verbatim", () => {
          expect(renderReasoningText([mk(0, "hello")])).toBe("hello");
        });

        test("multiple entries → concatenated in offset/array order", () => {
          expect(renderReasoningText([mk(0, "a"), mk(1, "b"), mk(2, "c")])).toBe("abc");
        });

        test("output contains ONLY content (no offset/timestamp leakage)", () => {
          const out = renderReasoningText([mk(7, "reason"), mk(99, "ing")]);
          expect(out).toBe("reasoning");
          // Numbers 7 and 99 must not appear as text; verify no accidental envelope leakage.
          expect(out.includes("7")).toBe(false);
          expect(out.includes("99")).toBe(false);
          expect(out.includes("offset")).toBe(false);
          expect(out.includes("timestamp")).toBe(false);
        });

        test("content is NOT interpreted/trimmed (opaque buffer, §13.4 h2.41)", () => {
          // Whitespace and newlines preserved verbatim — no normalization.
          expect(renderReasoningText([mk(0, "  spaced\n"), mk(1, "end ")])).toBe("  spaced\nend ");
        });

        test("purity — no mutation of input entries/array", () => {
          const entries = [mk(0, "x"), mk(1, "y")] as readonly ThinkingEntry[];
          const snapshot = entries.map((e) => ({ ...e })); // defensive copy
          renderReasoningText(snapshot);
          expect(snapshot).toEqual(entries);          // unchanged
          expect(snapshot.map((e) => e.content)).toEqual(["x", "y"]);
        });

        test("referentially transparent — same input ⇒ same output", () => {
          const a = renderReasoningText([mk(0, "ab"), mk(1, "cd")]);
          const b = renderReasoningText([mk(0, "ab"), mk(1, "cd")]);
          expect(a).toBe(b);
          expect(a).toBe("abcd");
        });

        test("works against a real frozen ReasoningBuffer.snapshot()", () => {
          const { diag } = makeCaptureDiag();
          const buffer = new ReasoningBuffer(diag, 1_000_000);
          buffer.append("delta-one ");
          buffer.append("delta-two");
          buffer.freeze();
          expect(renderReasoningText(buffer.snapshot())).toBe("delta-one delta-two");
        });
      });
  - NOTE: `makeCaptureDiag` and `ReasoningBuffer` are ALREADY imported in the test file (top of file).
  - SCOPE: these cover the PURE FUNCTION ONLY. Do NOT add gating/directive/invariant tests (those are
    P2.M3.T1.S2). Do NOT test buildReplacement's new behavior (that does not exist yet — T2 owns it).
  - FOLLOW pattern: existing describe/test blocks; terse assertions; ThinkingEntry literals inline.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: the function is a leaf pure helper — minimal, no dependencies, no config.
export function renderReasoningText(entries: readonly ThinkingEntry[]): string {
  return entries.map((entry) => entry.content).join("");
}
// - readonly array → .map() yields a fresh string[] → .join("") yields string. No cast.
// - Empty ([]) → [].join("") === "" → exactly what T2's gate (`rendered.length > 0`) treats as "omit".
// - Reads entry.content ONLY → opaque-buffer compliant (§13.4 h2.41 / §53 h3.70): no offset/timestamp leak.

// PATTERN: export placement (module-level, not a class method)
//   [existing module JSDoc]
//   import type { ... } from "@earendil-works/pi-ai";
//   import type { ThinkingEntry } from "../buffer";   // ← ALREADY PRESENT (reuse)
//   import type { Diagnostics } from "../diagnostics";
//   export interface ReplacementRequest { ... }
//   // ↓↓↓ INSERT renderReasoningText HERE (after interface, before class) ↓↓↓
//   export function renderReasoningText(entries: readonly ThinkingEntry[]): string { ... }
//   // ↑↑↑
//   export class RequestBuilder { ... }   // ← UNCHANGED

// PATTERN: JSDoc (Mode A) — mirror the module's existing doc density (see ReplacementRequest JSDoc):
//   purpose (§53 h3.70), purity (no side effects/diagnostics, referentially transparent, deterministic),
//   opaque-buffer guarantee (§13.4 h2.41: no interpretation/summarization/compression).
```

### Integration Points

```yaml
DATABASE: none (pure function over plain data).

CONFIG: none. renderReasoningText takes a snapshot, NOT config. The gate that reads
  config.reasoningInjection is added in P2.M2.T2.S1 (buildReplacement), not here. No config import needed.

ROUTES/SERVICES: none. The function is consumed IN-MODULE by buildReplacement in P2.M2.T2.S1 (same file,
  no cross-module import). proxy.ts:890 passes the live snapshot into buildReplacement (unchanged by S1).
  No src/index.ts barrel re-export is required (consumer is co-located).
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# TypeScript + Bun project. There is NO ruff/mypy/eslint/biome — do NOT run them (template artifacts).
bun run typecheck          # = tsc --noEmit  (covers src/ only; tsconfig EXCLUDES tests)
# Expected: zero errors. Watch for: a duplicate `import type { ThinkingEntry }` (don't add one),
# the function body type-checking (entries.map(e => e.content).join("") — no cast needed),
# and confirming renderReasoningText is `export function` (not accidentally a class method).
```

### Level 2: Unit Tests (Component Validation)

```bash
bun test tests/request-builder.test.ts
# Expected: all pass. New renderReasoningText tests (empty, single, multi/order, content-only/no-leakage,
# no-trim/opaque, purity/no-mutation, referential transparency, real-buffer snapshot) pass; the existing
# RequestBuilder suite stays green (the class is UNCHANGED in S1, so its tests are unaffected).

bun test
# Expected: all pass (full suite; no other module is touched — S1 only adds an export to builder.ts +
# tests to request-builder.test.ts).
```

### Level 3: Integration Testing (System Validation)

```bash
# Pure helper — no network/streaming/service startup. One-off smoke check:
bun -e 'import { renderReasoningText } from "./src/request/builder.ts";
const mk = (offset:number,content:string,timestamp=offset) => ({offset,timestamp,content});
console.log(renderReasoningText([]) === "" ? "ok:empty" : "FAIL:empty");
console.log(renderReasoningText([mk(0,"a"),mk(1,"b")]) === "ab" ? "ok:join-order" : "FAIL:join-order");
const out = renderReasoningText([mk(7,"x"),mk(99,"y")]);
console.log(out === "xy" && !out.includes("7") && !out.includes("99") ? "ok:content-only" : "FAIL:content-only:"+JSON.stringify(out));'
# Expected (all lines):
#   ok:empty
#   ok:join-order
#   ok:content-only
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Confirm the export surface + purity (informational):
bun -e 'import * as B from "./src/request/builder.ts";
console.log(typeof B.renderReasoningText === "function" ? "ok:exported-fn" : "FAIL:export");
// purity: same input twice → same output, deterministic
const mk = (offset:number,content:string) => ({offset,timestamp:offset,content});
const a = B.renderReasoningText([mk(0,"p"),mk(1,"q")]);
const b = B.renderReasoningText([mk(0,"p"),mk(1,"q")]);
console.log(a === b && a === "pq" ? "ok:pure-deterministic" : "FAIL:pure");'
# grep the export + JSDoc (informational):
grep -n "export function renderReasoningText\|does not interpret\|What is injected" src/request/builder.ts
# Expected: exported-fn; pure-deterministic; grep shows the export + the §13.4/§53 JSDoc anchors.
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun run typecheck` passes (zero errors on `src/`).
- [ ] `bun test tests/request-builder.test.ts` passes (existing RequestBuilder suite + new render tests).
- [ ] `bun test` (full suite) passes.
- [ ] Level 3 smoke script prints all three `ok:` lines.

### Feature Validation

- [ ] `renderReasoningText([])` returns `""`.
- [ ] Multi-entry input concatenates `content` in array/offset order (e.g. `[a,b,c]` → `"abc"`).
- [ ] Output contains ONLY `content` — no `offset`/`timestamp`/envelope text leakage (test verifies).
- [ ] Content is unmodified (whitespace/newlines preserved — no trim/normalize).
- [ ] Function is pure: no mutation of input; deterministic; referentially transparent (tests verify).
- [ ] Works against a real `ReasoningBuffer.snapshot()` (frozen, offset-ordered).
- [ ] Function is an exported standalone module-level function (not a class method); importable by name.

### Code Quality Validation

- [ ] `renderReasoningText` is a one-liner (`entries.map((e) => e.content).join("")`); no over-engineering.
- [ ] Reuses the existing `ThinkingEntry` import (no duplicate import added).
- [ ] JSDoc (Mode A) documents purpose (§53 h3.70), purity, and opaque-buffer guarantee (§13.4 h2.41).
- [ ] JSDoc density matches the module's existing doc style (ReplacementRequest / buildReplacement).
- [ ] No modification to `RequestBuilder`, `buildReplacement`, the constructor, `ReplacementRequest`, or any
      other module (config/proxy/buffer/decorator). Only `src/request/builder.ts` source + tests touched.

### Documentation & Deployment

- [ ] JSDoc on `renderReasoningText` present with the three required content areas (purpose/purity/opaque).
- [ ] No standalone docs file, no README/CHANGELOG change (those are P2.M3.T2.* — out of scope).

---

## Anti-Patterns to Avoid

- ❌ Do NOT add a second `import type { ThinkingEntry }` — it already exists at `src/request/builder.ts:44`.
- ❌ Do NOT make `renderReasoningText` a method on `RequestBuilder` — it is a standalone exported function.
- ❌ Do NOT modify `RequestBuilder`, its constructor, or `buildReplacement` — those are P2.M2.T2.S1's scope
  (constructor gains `_reasoningInjection`/`_delimiter`; buildReplacement gains the gate + directive).
- ❌ Do NOT add delimiter wrapping (`open`/`close` fence), gating (`reasoningInjection && length > 0`), or
  directive `UserMessage` construction — all belong to P2.M2.T2.S1. This function returns RAW text only.
- ❌ Do NOT include `offset`, `timestamp`, deltas, or any envelope text in the output — §53 h3.70 mandates
  rendered text ONLY; §13.4 h2.41 mandates the buffer is opaque (no interpretation).
- ❌ Do NOT trim/normalize/reformat content — concatenate verbatim (whitespace + newlines preserved).
- ❌ Do NOT call `this.diagnostics`, `Date.now()`, `console`, or any module-level mutable state — the
  function is pure and takes no `Diagnostics` dependency (unlike `buildReplacement`).
- ❌ Do NOT add gating/invariant tests (INV-013/INV-014, `shouldInject`, context same-ref, options
  `reasoning===undefined`) — those are P2.M3.T1.S2. S1 tests cover the pure function only.
- ❌ Do NOT touch `src/config/index.ts`, `src/provider/proxy.ts`, `src/provider/decorator.ts`, or
  `src/buffer/index.ts` — config is P2.M1.*, wiring is P2.M2.T3.*, the buffer is already correct.
- ❌ Do NOT add a `src/index.ts` barrel re-export — the consumer (T2 buildReplacement) is co-located in the
  same module; cross-module import is unnecessary.
- ❌ Do NOT run ruff/mypy/eslint/biome — TypeScript+Bun project; those tools do not exist here.

---

**Confidence Score: 10/10** for one-pass implementation success.
Rationale: This is a single, self-contained one-line pure function with a verbatim body specified by the
authoritative architecture contract (directive_design.md §1: `entries.map(e => e.content).join("")`). The
only file to modify is named; the type (`ThinkingEntry`) is already imported; placement and JSDoc content
are fully specified with exact PRD anchors; the test assertions are concrete (empty→"", join/order,
content-only/no-leakage, no-mutation/purity, real-buffer snapshot); and there is NO upstream dependency —
unlike sibling subtasks, S1 does not depend on config/wiring landing (it takes a snapshot, not config).
Scope boundaries vs. T2/T3/M3 are enumerated to prevent the implementer from over-building into the gate,
delimiter, or invariant concerns. The −0 reflects that there is genuinely nothing ambiguous left.
