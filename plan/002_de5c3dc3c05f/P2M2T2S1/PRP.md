# PRP — P2.M2.T2.S1: Modify RequestBuilder constructor + buildReplacement for gated directive injection

---

## Goal

**Feature Goal**: Implement the §53 Ephemeral Execution Directive in `RequestBuilder.buildReplacement`
(ADR-006 / PRD §53 h1.73 h2.176 / INV-013 h2.232): the frozen reasoning snapshot, previously accepted
but **NOT read**, is now rendered to text, gated on `reasoningInjection && rendered.length > 0`, and —
when the gate passes — injected as a clearly-delimited, read-only `UserMessage` appended to a **fresh
copy** of the conversation `Context`. When the gate fails (injection disabled OR empty snapshot) the
original `Context` reference is returned unchanged (gated fallback, observational equivalence ADR-005).
Reasoning-disabled options scoping (INV-014) is preserved via the existing fresh `{ ...options,
reasoning: undefined }`, now also given a best-effort bounded `maxTokens` default. All module/method
JSDoc is rewritten (Mode A) to remove the "NOT read in MVP" language.

**Deliverable**: A modified **`src/request/builder.ts`** (single source file). Concretely:
1. Two new imports (`UserMessage` from pi-ai; `DEFAULT_CONFIG` value import from `../config`).
2. One new module-level constant `DEFAULT_REPLACEMENT_MAX_TOKENS = 16384`.
3. `RequestBuilder` constructor gains two params (`_reasoningInjection`, `_delimiter`) with
   `DEFAULT_CONFIG.*` defaults (existing `new RequestBuilder(diagnostics)` call sites stay valid).
4. `buildReplacement` body fully rewritten to render → gate → inject/same-ref → fresh options +
   bounded maxTokens → debug milestone → return triple.
5. Full JSDoc rewrite (module + `buildReplacement`) per item logic step (c).

**No test files are modified by this subtask** — directive + invariant tests (INV-013/INV-014,
gating, same-ref, non-mutation) belong to **P2.M3.T1.S2**. This PRP only requires the existing
`tests/request-builder.test.ts` suite to remain green (it does — see Known Gotchas).

**Success Definition**:
- `bun run typecheck` (`tsc --noEmit`) passes with zero errors on `src/`.
- `bun test tests/request-builder.test.ts` passes — the existing suite stays green (incl. the
  `renderReasoningText` block added by P2.M2.T1.S1) and `bun test` (full suite) passes.
- Default (`reasoningInjection === true`) + **non-empty** snapshot ⇒ `triple.context` is a FRESH
  object (NOT `===` input context), `triple.context.messages.length === original + 1`, and the last
  message is a `UserMessage` whose `content` starts with `delimiter.open` and ends with the
  non-continuation directive sentence.
- `reasoningInjection === false` (OR empty snapshot) ⇒ `triple.context === input context` (same ref).
- `triple.options.reasoning === undefined` always (INV-014); input `options` object is never mutated.
- `triple.options.maxTokens === undefined` input ⇒ becomes `16384`; defined input ⇒ preserved verbatim.
- Input `context` is never mutated (fresh objects only when injecting).
- Debug milestone fires exactly once with fields `=== {}` (Appendix H privacy).

## User Persona (if applicable)

**Target User**: Downstream developer (the P2.M2.T3.S1 proxy-wiring author + the P2.M3.T1.S2 test
author). Internal building block — no end-user surface in this subtask.
**Use Case**: The `StreamProxy` calls `RequestBuilder.buildReplacement(model, context, options,
buffer.snapshot())` at proxy.ts:890 to produce the thinking-disabled replacement triple that gets fed
to `original.streamSimple(...)`. This subtask makes that triple actually carry the reused reasoning.
**User Journey**: aborted reasoning phase → frozen `ReasoningBuffer.snapshot()` → `buildReplacement`
→ `renderReasoningText` → gated directive `UserMessage` → fresh augmented `Context` → replacement
stream reads its own prior reasoning and answers informed (ADR-006).
**Pain Points Addressed**: Today the snapshot is discarded (the replacement answers from scratch,
empirically weaker — Appendix P.1). This subtask is the mechanical satisfaction of INV-013:
reasoning is reused, not discarded, by default.

## Why

- **Business value**: This is the core of ADR-006 / §53 — the mechanism that preserves answer quality
  in proportion to how far reasoning progressed before the shortcut. Directly satisfies INV-013
  (reasoning reused, not discarded).
- **Integration**: Sits in the P2.M2 chain:
  - Consumes **P2.M2.T1.S1**'s `renderReasoningText` (now present in the file) for the rendered text
    and the emptiness gate.
  - Consumes **P2.M1.T1.S1**'s `DEFAULT_CONFIG.reasoningInjection` / `reasoningInjectionDelimiter`
    (Complete) as constructor defaults.
  - Is consumed by **P2.M2.T3.S1** (proxy wiring) — the new constructor params are how config reaches
    the gate. Because the defaults match `DEFAULT_CONFIG`, T2 is independently shippable and
    behavior-preserving WITHOUT T3 (proxy.ts:276 keeps calling `new RequestBuilder(diagnostics)`).
  - Is tested by **P2.M3.T1.S2** (directive + invariant tests) — that subtask exercises the gating
    and INV-013/INV-014 behavior built here; T2 itself adds no tests.
- **Problems solved**: Removes the "NOT read in MVP" gap identified in
  `architecture/current-impl-state.md` §1: snapshot now drives the directive instead of being inert.

## What

User-visible behavior: none directly (internal transform). Observable contract for `buildReplacement`:

1. **Render**: `const rendered = renderReasoningText(reasoningSnapshot);` (PRD §53 h3.70).
2. **Gate**: `const shouldInject = this._reasoningInjection && rendered.length > 0;`
   (PRD §53 h3.70 — "If reasoningInjection is disabled or the snapshot is empty, the directive is
   omitted").
3. **When `shouldInject === true`** (PRD §53 h3.71 delimiter + h3.72 positioning + h3.73 scoping):
   - Build a directive `UserMessage`:
     ```ts
     const directiveMessage: UserMessage = {
       role: "user",
       content: `${this._delimiter.open}\n${rendered}\n${this._delimiter.close}\n\n` +
         `Using the prior reasoning above as reference context only, produce your best available ` +
         `answer to the user's request now. Do not continue or extend reasoning.`,
       timestamp: Date.now(),
     };
     ```
   - Build a **fresh** `Context` copy (h3.73 ephemeral/scoping — must NOT mutate the original):
     ```ts
     const replacementContext: Context = { ...context, messages: [...context.messages, directiveMessage] };
     ```
4. **When `shouldInject === false`**: `const replacementContext = context;` (same reference —
   preserves observational equivalence, ADR-005 / INV-008).
5. **Options** (INV-014 h2.233 / §25.6 h2.97): `const replacementOptions = { ...options, reasoning: undefined };`
   — fresh object, original unmutated, reasoning forced OFF for exactly this one request.
6. **maxTokens bound** (§25.6 h2.97 + Appendix P.3 h2.236): `if (replacementOptions.maxTokens === undefined)
   replacementOptions.maxTokens = DEFAULT_REPLACEMENT_MAX_TOKENS;` z.ai does NOT reliably enforce this;
   completion relies on the stream's terminal event. Preserve any caller-supplied `maxTokens`.
7. **Debug milestone**: `this.diagnostics.debug("request.replacement-built", {});` (privacy — `{}` only,
   Appendix H h2.203).
8. **Return**: `{ model, context: replacementContext, options: replacementOptions };`

### Constructor change (logic step a)

```ts
constructor(
  private readonly diagnostics: Diagnostics,
  private readonly _reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
  private readonly _delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
) {}
```

### Success Criteria

- [ ] `renderReasoningText` is called inside `buildReplacement` (snapshot is now READ).
- [ ] Gate `this._reasoningInjection && rendered.length > 0` controls inject vs. same-ref fallback.
- [ ] Injected path: fresh `Context` + fresh `messages` array + trailing directive `UserMessage`.
- [ ] Directive `content` = `open\n{rendered}\nclose\n\n{non-continuation sentence}` (exact string).
- [ ] Directive message `role === "user"`, `content` is a bare `string`, `timestamp` is a `number`.
- [ ] Omitted path: `triple.context === input context` (same reference).
- [ ] `triple.options.reasoning === undefined` always; input `options` never mutated (INV-014).
- [ ] `maxTokens === undefined` input ⇒ `16384`; defined input ⇒ preserved.
- [ ] Input `context` never mutated (fresh objects only when injecting).
- [ ] Constructor adds 2 default params; existing `new RequestBuilder(diagnostics)` still compiles.
- [ ] All "NOT read in MVP" / "reserved for forward-compat" JSDoc language removed.
- [ ] `bun run typecheck` passes; `bun test tests/request-builder.test.ts` passes; `bun test` passes.

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes** — this PRP names the single file to modify (`src/request/builder.ts`), quotes
the exact current constructor + body verbatim, specifies the exact two imports to add (and notes
`DEFAULT_CONFIG` must be a VALUE import, `UserMessage` a type), gives the exact constructor signature,
the exact directive string, the exact gating expression, the exact `Context`/`messages`/`options`
construction, the new constant value, the full JSDoc content requirements (six areas), enumerates every
existing test that must stay green and WHY it stays green, and states the verified validation commands.
The authoritative architecture contract (`directive_design.md`) and type reference
(`pi-ai-context-types.md`) are cited by section. Scope boundaries vs. sibling subtasks (T1 done, T3
wiring, M3 tests) are explicit to prevent over-reaching.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: src/request/builder.ts
  why: THE ONLY source file to modify. Contains the module JSDoc, imports (lines 30-35), the
        ReplacementRequest interface, renderReasoningText (already present from P2.M2.T1.S1 — CALL it),
        the RequestBuilder class, its constructor (lines ~91-93), and buildReplacement (lines ~114-119).
  pattern: Rich JSDoc with PRD anchors like "(PRD §53)". Mirror that density in the rewrite.
  gotcha: renderReasoningText ALREADY EXISTS in this file (P2.M2.T1.S1 landed it). Do NOT redefine it —
          call `renderReasoningText(reasoningSnapshot)`. Do NOT add a second ThinkingEntry import.

- file: src/config/index.ts
  why: Source of DEFAULT_CONFIG (the value imported as constructor-param defaults). Confirms
        DEFAULT_CONFIG.reasoningInjection === true and DEFAULT_CONFIG.reasoningInjectionDelimiter is
        Object.freeze({ open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
        close: "[End of prior reasoning]\n---" }). Already Complete (P2.M1.T1.*) — READ-ONLY here.
  pattern: DEFAULT_CONFIG is exported as a runtime value (`export const DEFAULT_CONFIG: Config = ...`).
  gotcha: Import it as `import { DEFAULT_CONFIG } from "../config";` — a VALUE import, NOT `import type`.
          A `import type` would be erased at emit and the runtime default-param lookup would fail to
          typecheck as a value (TS error TS1361 / "cannot be used as a value because it was imported
          using 'import type'").

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: THE authoritative implementation contract for this exact delta.
  section: "§2 Directive Message Construction" (exact directive string + UserMessage shape),
           "§3 Context Augmentation (Non-Mutating)" (fresh copy + identity rule), "§4 Gating Logic"
           (the exact `shouldInject` + ternary), "§5 Constructor Change" (exact constructor signature),
           "§8 Test Contract" (key assertions for M3 — listed here only as the spec T2 must enable),
           "§9 Constants" (DEFAULT_REPLACEMENT_MAX_TOKENS = 16384). Implement verbatim.

- docfile: plan/002_de5c3dc3c05f/architecture/pi-ai-context-types.md
  why: Exact type shapes for the injection.
  section: "Context Type" ({ systemPrompt?, messages: Message[], tools? } — plain mutable object, so
           `{ ...context, messages: [...] }` is valid), "Message Types" (UserMessage:
           { role:"user"; content: string | (TextContent|ImageContent)[]; timestamp: number } — a bare
           `string` content satisfies the type), "SimpleStreamOptions" (reasoning?: ThinkingLevel;
           undefined = OFF; maxTokens?: number inherited from StreamOptions).

- docfile: plan/002_de5c3dc3c05f/architecture/current-impl-state.md
  why: Confirms the gap ("reasoningSnapshot accepted but NOT read") and the exact current body to
        replace, plus the proxy call site (line 890) and builder construction (line 276).
  section: "§1 src/request/builder.ts" (current body + constructor) + "§4 src/provider/proxy.ts" (call sites).

- docfile: plan/002_de5c3dc3c05f/P2M2T1S1/PRP.md
  why: Defines renderReasoningText (the helper this task calls) and confirms it is a standalone export,
        pure, content-only, empty→"". Read to confirm the contract you are consuming.
  section: "Success Definition" + "Implementation Tasks" (Task 1 function body + JSDoc).

- file: tests/request-builder.test.ts
  why: The existing suite that MUST stay green. Uses `new RequestBuilder(diag)` only (no 2nd/3rd arg →
        defaults apply). Test doubles `makeCaptureDiag()`, `makeModel()`, `makeContext()` are reusable.
        NOTE: this subtask adds NO tests; directive/invariant tests are P2.M3.T1.S2.
  gotcha: The "context is the same reference as the input" test passes an EMPTY `[]` snapshot — with
          injection defaulting to true but empty text, shouldInject=false → same ref → still passes.
          The "frozen snapshot accepted" test passes a NON-empty real snapshot → shouldInject=true →
          fresh context copy; it only asserts `triple.options.reasoning===undefined` so it still passes.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/
  request/builder.ts      # <-- MODIFY (single file): imports, constant, constructor, buildReplacement, JSDoc.
  config/index.ts         # READ-ONLY: DEFAULT_CONFIG w/ reasoningInjection + delimiter (P2.M1.T1.* Complete)
  buffer/index.ts         # READ-ONLY: ThinkingEntry + ReasoningBuffer.snapshot()
  diagnostics/index.ts    # READ-ONLY: Diagnostics.debug(event, fields?) signature
  provider/proxy.ts       # NOT touched (wiring is P2.M2.T3.S1; default params keep it behavior-preserving)
  provider/decorator.ts   # NOT touched (wiring is P2.M2.T3.S1)
tests/
  request-builder.test.ts # NOT modified (directive/invariant tests are P2.M3.T1.S2); must stay green
package.json              # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit
tsconfig.json             # strict:true; EXCLUDES "tests" from tsc (typecheck covers src/ only)
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. One MODIFIED file:
src/request/builder.ts     # +2 imports (UserMessage type; DEFAULT_CONFIG value),
                           # +1 module constant (DEFAULT_REPLACEMENT_MAX_TOKENS = 16384),
                           # constructor gains 2 default params (_reasoningInjection, _delimiter),
                           # buildReplacement body fully rewritten (render→gate→inject/same-ref→options+maxTokens),
                           # full JSDoc rewrite (module + buildReplacement). renderReasoningText UNCHANGED.
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: renderReasoningText ALREADY EXISTS in src/request/builder.ts (P2.M2.T1.S1, ~lines 76-86).
// CALL it as `renderReasoningText(reasoningSnapshot)`. Do NOT redefine it. Do NOT add a second
// `import type { ThinkingEntry }` (it is already imported at line ~32).

// CRITICAL: DEFAULT_CONFIG must be a VALUE import: `import { DEFAULT_CONFIG } from "../config";`.
// It is used in constructor default-param position (`= DEFAULT_CONFIG.reasoningInjection`) — a RUNTIME
// value lookup. `import type { DEFAULT_CONFIG }` would be erased and fail to typecheck as a value.

// CRITICAL: UserMessage is a TYPE (interface) — add it to the existing `import type { ... } from
// "@earendil-works/pi-ai";` block alongside Api/Context/Model/SimpleStreamOptions. Do NOT make it a
// value import. `role:"user"`, `content: <string>`, `timestamp: <number>` satisfy UserMessage.

// CRITICAL (purity vs Date.now()): the directive message uses `timestamp: Date.now()` (contract §2/§4).
// This makes buildReplacement NOT strictly referentially-transparent/deterministic WHEN injection is
// active (wall-clock timestamp). The method REMAINS a non-mutating transform: it mutates NONE of its
// inputs, performs NO network/stream (PRD §31 h2.121 still holds), and constructs only fresh objects.
// JSDoc MUST be updated to state this honestly (referential transparency modulo the directive timestamp).
// Do NOT add Date.now() to renderReasoningText — it stays fully pure.

// CRITICAL (non-mutation, h3.73): inject via `{ ...context, messages: [...context.messages, directiveMessage] }`.
// The spread on `context` + a NEW messages array + the new message guarantee the ORIGINAL context object
// AND its original `messages` array are untouched. NEVER `context.messages.push(...)`.

// CRITICAL (INV-014 options scoping): `{ ...options, reasoning: undefined }` creates a FRESH options
// object. Setting `replacementOptions.maxTokens` afterward mutates the FRESH object (ours), NOT the input.
// Do NOT write to `options.maxTokens` (the input). The input options must remain byte-identical.

// CRITICAL (gated same-ref): when shouldInject is FALSE, return the SAME context reference
// (`replacementContext = context`), NOT a shallow copy. ADR-005 / INV-008 observational equivalence
// requires `triple.context === context` to hold in the omitted case. Copying would break that identity.

// CRITICAL (maxTokens best-effort, §25.6 h2.97 + P.3 h2.236): only default when the caller OMITTED it
// (`replacementOptions.maxTokens === undefined`). A defined caller value (e.g. 4096) MUST be preserved.
// z.ai does NOT reliably enforce maxTokens — rely on the stream's terminal event. Do NOT clamp/override.

// CRITICAL (privacy, Appendix H h2.203): the debug milestone MUST emit `{}` — never log rendered text,
// prompt, options, or reasoning content. Keep `this.diagnostics.debug("request.replacement-built", {});`.

// CRITICAL (non-continuation positioning, §53 h3.72 / §26 h1.37): the trailing directive sentence MUST
// be EXACTLY: "Using the prior reasoning above as reference context only, produce your best available
// answer to the user's request now. Do not continue or extend reasoning." Do not reword — it is the
// read-only-reference framing that prevents the model from resuming/extending the reasoning chain.

// CRITICAL (delimiter format): the directive content template is `${open}\n${rendered}\n${close}\n\n`
// followed by the directive sentence. The default open/close come from DEFAULT_CONFIG (multi-line fences
// with embedded \n). Render with a template literal preserving those newlines verbatim.

// CRITICAL (scope): do NOT touch proxy.ts / decorator.ts (wiring = P2.M2.T3.S1), config (P2.M1 done),
// buffer, or tests (P2.M3.T1.S2). The default constructor params make proxy.ts:276 behavior-preserving.
```

## Implementation Blueprint

### Data models and structure

No new data models. The transform consumes existing types (all already defined/importable):

```typescript
// From @earendil-works/pi-ai (UserMessage to be ADDED to the existing type import):
export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number; }
export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; } // plain mutable obj
export interface SimpleStreamOptions extends StreamOptions { reasoning?: ThinkingLevel; /* ... */ }
// StreamOptions.maxTokens?: number  (undefined-able)

// From ../buffer (already imported):
export interface ThinkingEntry { readonly offset: number; readonly timestamp: number; readonly content: string; }

// From ../config (DEFAULT_CONFIG to be ADDED as a value import):
export const DEFAULT_CONFIG: Config;  // .reasoningInjection === true; .reasoningInjectionDelimiter = {open,close}
```

One new module constant:

```typescript
/** Best-effort maxTokens bound for the replacement request (PRD §25.6 h2.97 + Appendix P.3 h2.236).
 *  z.ai does NOT reliably enforce maxTokens; completion relies on the stream's terminal event. */
const DEFAULT_REPLACEMENT_MAX_TOKENS = 16384;
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/request/builder.ts — imports
  - ADD `UserMessage` to the existing pi-ai type import block:
      import type {
        Api,
        Context,
        Model,
        SimpleStreamOptions,
        UserMessage,            // ← ADD (directive message type, PRD §53 h3.71)
      } from "@earendil-works/pi-ai";
  - ADD a NEW runtime value import AFTER the existing imports:
      import { DEFAULT_CONFIG } from "../config";   // constructor default params (P2.M1.T1.*)
  - GOTCHA: UserMessage is a TYPE → stays in `import type`. DEFAULT_CONFIG is a VALUE → plain `import`.
  - DO NOT add a second ThinkingEntry import (already present, line ~32).

Task 2: MODIFY src/request/builder.ts — add the maxTokens constant
  - PLACE: module level, after the import block (before the ReplacementRequest interface), e.g.:
      /** Best-effort maxTokens bound for the replacement request (PRD §25.6 h2.97 + Appendix P.3 h2.236).
       *  z.ai does NOT reliably enforce maxTokens; completion relies on the stream's terminal event. */
      const DEFAULT_REPLACEMENT_MAX_TOKENS = 16384;
  - NAMING: DEFAULT_REPLACEMENT_MAX_TOKENS (matches directive_design.md §9).

Task 3: MODIFY src/request/builder.ts — constructor (logic step a)
  - REPLACE the current single-param constructor:
      constructor(private readonly diagnostics: Diagnostics) {}
    WITH:
      constructor(
        private readonly diagnostics: Diagnostics,
        private readonly _reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
        private readonly _delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
      ) {}
  - WHY defaults: existing call sites (proxy.ts:276 `new RequestBuilder(diagnostics)`, all tests
    `new RequestBuilder(diag)`) omit params 2-3 → they fall back to DEFAULT_CONFIG values → behavior-
    preserving (injection ON by default). T3 (P2.M2.T3.S1) later passes real config through.

Task 4: MODIFY src/request/builder.ts — buildReplacement body (logic step b)
  - REPLACE the current body:
      const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
      this.diagnostics.debug("request.replacement-built", {});
      return { model, context, options: replacementOptions };
    WITH (render → gate → inject/same-ref → fresh options + bounded maxTokens → debug → return):
      const rendered = renderReasoningText(reasoningSnapshot);
      const shouldInject = this._reasoningInjection && rendered.length > 0; // §53 h3.70

      let replacementContext: Context;
      if (shouldInject) {
        // §53 h3.71 delimiter + h3.72 non-continuation positioning. Bare-string content satisfies UserMessage.
        const directiveMessage: UserMessage = {
          role: "user",
          content:
            `${this._delimiter.open}\n${rendered}\n${this._delimiter.close}\n\n` +
            `Using the prior reasoning above as reference context only, produce your best available ` +
            `answer to the user's request now. Do not continue or extend reasoning.`,
          timestamp: Date.now(),
        };
        // §53 h3.73 ephemeral/scoping — FRESH context copy + NEW messages array (original untouched).
        replacementContext = { ...context, messages: [...context.messages, directiveMessage] };
      } else {
        replacementContext = context; // gated fallback — SAME ref (ADR-005 / INV-008)
      }

      // INV-014 (§25.6 h2.97): reasoning OFF for exactly this one request via a FRESH options object.
      const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
      // Best-effort maxTokens bound (§25.6 h2.97 + Appendix P.3 h2.236); preserve caller value if set.
      if (replacementOptions.maxTokens === undefined) {
        replacementOptions.maxTokens = DEFAULT_REPLACEMENT_MAX_TOKENS;
      }

      this.diagnostics.debug("request.replacement-built", {}); // privacy-safe — {} only (Appendix H h2.203)
      return { model, context: replacementContext, options: replacementOptions };
  - KEEP the reasoningSnapshot parameter declaration + its existing inline comment (or update the comment
    to note it is now READ). Remove the "NOT read in MVP" wording anywhere it appears.
  - GOTCHA: `let replacementContext: Context;` + branch assignment is the cleanest way to keep the
    `directiveMessage: UserMessage` typing legible. A ternary is also acceptable (see directive_design.md
    §4) but inlines the message construction. Do NOT invent a `buildDirectiveMessage` helper — none exists;
    inline per contract §2.

Task 5: MODIFY src/request/builder.ts — JSDoc rewrite (Mode A, logic step c)
  - MODULE JSDoc (top of file): remove ALL "NOT read in MVP" / "reserved for forward-compat" / "Omit (MVP)"
    language. Rewrite the "Transformation" bullets to document:
      (1) directive construction from the snapshot (render → gate → inject as ephemeral UserMessage);
      (2) the TWO distinct uses of one snapshot — INPUT injection (here) vs OUTPUT stitching (already done
          in the StreamProxy; the snapshot is stitched into the persisted assistant message for display);
      (3) the gated fallback — injection disabled OR empty snapshot ⇒ directive omitted, SAME context
          reference returned (ADR-005 observational equivalence);
      (4) INV-014 options-level scoping — `{ ...options, reasoning: undefined }` is fresh, original
          untouched, reasoning OFF for exactly this one request;
      (5) the maxTokens best-effort caveat — bounded default when omitted; z.ai does not reliably enforce;
          rely on the stream's terminal event;
      (6) the non-continuation positioning (§26 / §53 h3.72) — the directive is read-only reference
          context, never a continuation prompt.
    Update the purity paragraph honestly: non-mutating transform (no input mutation, no network/stream —
    §31 h2.121), referentially transparent MODULO the directive message's `timestamp: Date.now()` (the
    ONE wall-clock-dependent element, present only when injection is active). The single debug milestone
    remains behaviorally inert.
  - buildReplacement JSDoc: remove "NOT read in MVP" / "unused in MVP" / "forward-compat". Rewrite to
    describe: render+gate+inject-or-same-ref; the freshness of context (when injected) and options
    (always); maxTokens defaulting; postconditions (context same-ref iff gate fails; options fresh w/
    reasoning===undefined; inputs never mutated; no network/stream); the non-continuation directive
    sentence; that reasoningSnapshot is now a REQUIRED input (without it the directive is omitted and
    quality degrades to from-scratch — §31 h2.120).
  - ReplacementRequest.context field JSDoc: update to note it is the SAME ref when injection is omitted
    and a FRESH augmented copy when injected (was "Same reference as the input").
  - renderReasoningText JSDoc: UNCHANGED (it is still pure; P2.M2.T1.S1 owns it). Do NOT regress it.

Task 6 (NO-OP for this subtask): tests belong to P2.M3.T1.S2
  - Do NOT add directive/invariant tests here. Only run the existing suite to confirm it stays green
    (see Validation Loop). M3.T1.S2 will add: non-empty snapshot → context length +1 + trailing
    UserMessage; disabled/empty → same-ref; non-mutation of original context; INV-014 options;
    maxTokens default vs preserved; privacy {}.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: gated directive construction — render once, branch on the gate (directive_design.md §4).
buildReplacement(model, context, options, reasoningSnapshot): ReplacementRequest {
  const rendered = renderReasoningText(reasoningSnapshot);          // pure (P2.M2.T1.S1)
  const shouldInject = this._reasoningInjection && rendered.length > 0; // §53 h3.70

  let replacementContext: Context;
  if (shouldInject) {
    const directiveMessage: UserMessage = {                          // §53 h3.71/h3.72
      role: "user",
      content:
        `${this._delimiter.open}\n${rendered}\n${this._delimiter.close}\n\n` +
        `Using the prior reasoning above as reference context only, produce your best available ` +
        `answer to the user's request now. Do not continue or extend reasoning.`,
      timestamp: Date.now(),
    };
    replacementContext = { ...context, messages: [...context.messages, directiveMessage] }; // h3.73 fresh copy
  } else {
    replacementContext = context;                                    // ADR-005 / INV-008 same-ref
  }

  const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined }; // INV-014
  if (replacementOptions.maxTokens === undefined) {                 // §25.6 h2.97 best-effort
    replacementOptions.maxTokens = DEFAULT_REPLACEMENT_MAX_TOKENS;
  }
  this.diagnostics.debug("request.replacement-built", {});          // Appendix H privacy
  return { model, context: replacementContext, options: replacementOptions };
}

// PATTERN: constructor with config defaults (directive_design.md §5) — keeps existing call sites valid.
constructor(
  private readonly diagnostics: Diagnostics,
  private readonly _reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
  private readonly _delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
) {}

// CRITICAL: the THREE distinct freshness guarantees (all hold when injecting):
//   context      → fresh object (spread)            — original context untouched
//   messages     → fresh array (spread + append)    — original messages array untouched
//   options      → fresh object (spread)            — original options untouched (INV-014)
// When NOT injecting, context is the SAME ref (do not copy — identity is the contract).

// CRITICAL: maxTokens default mutates the FRESH replacementOptions (ours), never the input options.
```

### Integration Points

```yaml
DATABASE: none (pure-ish transform over plain data).

CONFIG: READ via constructor defaults. DEFAULT_CONFIG.reasoningInjection + .reasoningInjectionDelimiter
  are the fallback values. Real config threading (proxy → builder) lands in P2.M2.T3.S1, which will
  pass `this.config.reasoningInjection` / `this.config.reasoningInjectionDelimiter` positionally into
  the RequestBuilder constructor. Until then, proxy.ts:276 `new RequestBuilder(diagnostics)` uses the
  DEFAULT_CONFIG values → injection ON with the default fence. No config edit is made by this subtask.

ROUTES/SERVICES: none. The proxy.ts:890 call site (`buildReplacement(model, context, options,
  this._buffer.snapshot())`) and proxy.ts:276 construction site are UNCHANGED here (T3 owns wiring).
  The 4-arg buildReplacement signature is unchanged; only its body + the constructor changed.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# TypeScript + Bun project. There is NO ruff/mypy/eslint/biome — do NOT run them (template artifacts).
bun run typecheck          # = tsc --noEmit  (covers src/ only; tsconfig EXCLUDES tests)
# Expected: zero errors. Watch for:
#   - DEFAULT_CONFIG imported as a VALUE (not `import type`) — else TS "cannot be used as a value".
#   - UserMessage imported as a TYPE in the pi-ai block.
#   - `let replacementContext: Context;` definitely assigned on both branches (TS no implicit any /
#     "used before assigned" only fires if a branch leaves it unassigned — both branches assign).
#   - directiveMessage: UserMessage satisfies the interface (role/content/timestamp).
#   - replacementOptions.maxTokens assignment typechecks (maxTokens?: number → assignable).
```

### Level 2: Unit Tests (Component Validation)

```bash
# This subtask adds NO tests (directive/invariant tests are P2.M3.T1.S2). Run the EXISTING suite to
# confirm it stays green — every existing test must still pass unchanged.
bun test tests/request-builder.test.ts
# Expected: all pass. The renderReasoningText block (P2.M2.T1.S1) passes; the RequestBuilder suite
# passes: empty-[]-snapshot tests hit the gated same-ref fallback (shouldInject=false), maxTokens-
# bearing option tests keep their value (guard skips default), non-empty "frozen snapshot accepted"
# test triggers injection but only asserts options.reasoning===undefined.

bun test
# Expected: all pass (full suite; only src/request/builder.ts changed; no other module is touched).
```

### Level 3: Integration Testing (System Validation)

```bash
# Pure-ish transform — no network/streaming/service startup. Smoke-check the gating + non-mutation
# directly against the builder with hand-built inputs (mirrors what P2.M3.T1.S2 will formalize):
bun -e '
import { RequestBuilder, renderReasoningText } from "./src/request/builder.ts";
const diag = { trace(){}, debug(){}, info(){}, warn(){}, error(){} };
const mk = (offset,content) => ({offset, timestamp:offset, content});
const model = { id:"m", api:"openai-completions" } ;
const ctx = { messages:[{role:"user",content:"hi"}] };
const opts = { reasoning:"high" };

// (1) injection ON + non-empty → fresh context, +1 message, trailing UserMessage, directive fence
let b = new RequestBuilder(diag);  // defaults: injection=true, default delimiter
let t = b.buildReplacement(model, ctx, opts, [mk(0,"step1"),mk(1,"step2")]);
console.log(t.context !== ctx ? "ok:fresh-context" : "FAIL:same-ref-when-injecting");
console.log(t.context.messages.length === 2 ? "ok:len+1" : "FAIL:len:"+t.context.messages.length);
let last = t.context.messages[1];
console.log(last.role==="user" && typeof last.content==="string" ? "ok:usermsg" : "FAIL:role/content");
console.log(last.content.startsWith("---\n[Prior reasoning") && last.content.endsWith("Do not continue or extend reasoning.") ? "ok:fence" : "FAIL:fence");
console.log(last.content.includes("step1step2") ? "ok:rendered-inside" : "FAIL:rendered");
console.log(ctx.messages.length===1 ? "ok:original-context-untouched" : "FAIL:mutated");

// (2) injection OFF → same ref; reasoning still undefined; maxTokens defaulted
b = new RequestBuilder(diag, false);
t = b.buildReplacement(model, ctx, opts, [mk(0,"x")]);
console.log(t.context === ctx ? "ok:disabled-same-ref" : "FAIL:disabled-copied");
console.log(t.options.reasoning===undefined ? "ok:reasoning-off-disabled" : "FAIL:reasoning");

// (3) empty snapshot → same ref (injection default true but empty)
b = new RequestBuilder(diag);
t = b.buildReplacement(model, ctx, opts, []);
console.log(t.context === ctx ? "ok:empty-same-ref" : "FAIL:empty-copied");

// (4) maxTokens preserved when supplied; defaulted when omitted
b = new RequestBuilder(diag);
t = b.buildReplacement(model, ctx, { reasoning:"high", maxTokens:4096 }, [mk(0,"x")]);
console.log(t.options.maxTokens===4096 ? "ok:maxtokens-preserved" : "FAIL:preserved:"+t.options.maxTokens);
t = b.buildReplacement(model, ctx, { reasoning:"high" }, [mk(0,"x")]);
console.log(t.options.maxTokens===16384 ? "ok:maxtokens-defaulted" : "FAIL:defaulted:"+t.options.maxTokens);

// (5) INV-014: input options never mutated
const inp = { reasoning:"high" };
b = new RequestBuilder(diag);
b.buildReplacement(model, ctx, inp, [mk(0,"x")]);
console.log(inp.reasoning==="high" && !("maxTokens" in inp) ? "ok:input-options-untouched" : "FAIL:mutated:"+JSON.stringify(inp));
'
# Expected (all lines ok:...):
#   ok:fresh-context / ok:len+1 / ok:usermsg / ok:fence / ok:rendered-inside / ok:original-context-untouched
#   ok:disabled-same-ref / ok:reasoning-off-disabled
#   ok:empty-same-ref
#   ok:maxtokens-preserved / ok:maxtokens-defaulted
#   ok:input-options-untouched
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Confirm the directive sentence is EXACTLY the non-continuation framing (§53 h3.72 / §26) — a rewording
# would invite the model to resume reasoning. Also confirm privacy (debug fields === {}).
bun -e '
import { RequestBuilder } from "./src/request/builder.ts";
const events=[];
const diag = { trace(){}, debug(e,f){events.push({e,f})}, info(){}, warn(){}, error(){} };
const mk=(o,c)=>({offset:o,timestamp:o,content:c});
const b=new RequestBuilder(diag);
const t=b.buildReplacement({id:"m",api:"openai-completions"},{messages:[{role:"user",content:"q"}]},{reasoning:"high"},[mk(0,"r")]);
const last=t.context.messages[1];
console.log(last.content.endsWith(
  "Using the prior reasoning above as reference context only, produce your best available answer to the user"+String.fromCharCode(39)+"s request now. Do not continue or extend reasoning."
) ? "ok:exact-directive-sentence" : "FAIL:sentence");
const built=events.filter(x=>x.e==="request.replacement-built");
console.log(built.length===1 && JSON.stringify(built[0].f)==="{}" ? "ok:privacy-empty-fields" : "FAIL:privacy:"+JSON.stringify(built));
'
# grep the export surface + removed MVP language (informational):
grep -n "NOT read in MVP\|reserved for forward-compat\|Omit (MVP)" src/request/builder.ts  # Expected: NO matches
grep -n "DEFAULT_REPLACEMENT_MAX_TOKENS\|renderReasoningText(reasoningSnapshot)\|shouldInject" src/request/builder.ts  # Expected: matches
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun run typecheck` passes (zero errors on `src/`).
- [ ] `bun test tests/request-builder.test.ts` passes (existing suite + P2.M2.T1.S1 render tests).
- [ ] `bun test` (full suite) passes.
- [ ] Level 3 smoke script prints all `ok:` lines.

### Feature Validation

- [ ] `buildReplacement` calls `renderReasoningText(reasoningSnapshot)` (snapshot is now READ).
- [ ] Gate `this._reasoningInjection && rendered.length > 0` controls inject vs. same-ref.
- [ ] Injected: `triple.context !== input` (fresh); `messages.length === original+1`; last = UserMessage.
- [ ] Directive `content` = `open\n{rendered}\nclose\n\n{exact non-continuation sentence}`.
- [ ] Directive `role==="user"`, `content` is `string`, `timestamp` is `number`.
- [ ] Omitted (disabled OR empty): `triple.context === input` (same reference).
- [ ] `triple.options.reasoning === undefined` always (INV-014); input options never mutated.
- [ ] `maxTokens`: undefined→16384; defined→preserved.
- [ ] Input context never mutated (fresh objects only when injecting).
- [ ] Constructor adds 2 default params; `new RequestBuilder(diag)` still compiles + behaves.
- [ ] Debug milestone fires once with fields `=== {}` (Appendix H).

### Code Quality Validation

- [ ] `renderReasoningText` UNCHANGED (P2.M2.T1.S1's function; only CALLED here).
- [ ] `DEFAULT_CONFIG` imported as a value; `UserMessage` imported as a type.
- [ ] No second `ThinkingEntry` import added.
- [ ] `DEFAULT_REPLACEMENT_MAX_TOKENS = 16384` module constant present.
- [ ] JSDoc rewritten (Mode A): all "NOT read in MVP"/"forward-compat" removed; six content areas present;
      purity stated honestly (non-mutating transform, referentially transparent modulo directive timestamp).
- [ ] No modification to proxy.ts / decorator.ts / config / buffer / tests.

### Documentation & Deployment

- [ ] Module JSDoc + buildReplacement JSDoc + ReplacementRequest.context field JSDoc updated.
- [ ] No standalone docs file, no README/CHANGELOG change (those are P2.M3.T2.* — out of scope).

---

## Anti-Patterns to Avoid

- ❌ Do NOT redefine `renderReasoningText` — it already exists (P2.M2.T1.S1). CALL it.
- ❌ Do NOT add a second `import type { ThinkingEntry }` — it is already imported.
- ❌ Do NOT import `DEFAULT_CONFIG` with `import type` — it is a RUNTIME value used in default params;
  use `import { DEFAULT_CONFIG } from "../config";`.
- ❌ Do NOT mutate the input `context` or its `messages` array — always spread into fresh objects/arrays.
- ❌ Do NOT return a shallow copy of `context` when injection is OMITTED — the same reference is the
  contract (ADR-005 / INV-008). `triple.context === context` must hold in the omitted case.
- ❌ Do NOT write to the input `options` object — `maxTokens` defaulting mutates the FRESH
  `replacementOptions` (ours), never the caller's `options`.
- ❌ Do NOT override/clamp a caller-supplied `maxTokens` — only default when `=== undefined`.
- ❌ Do NOT log rendered text, prompt, or reasoning in the debug milestone — fields must be `{}`.
- ❌ Do NOT reword the non-continuation directive sentence — the exact framing prevents reasoning
  resumption (§26 / §53 h3.72).
- ❌ Do NOT invent a `buildDirectiveMessage` helper — none exists; inline the message per contract §2.
- ❌ Do NOT add `Date.now()` to `renderReasoningText` — it stays pure; only the directive message uses it.
- ❌ Do NOT add directive/invariant tests here — those are P2.M3.T1.S2. Only keep the existing suite green.
- ❌ Do NOT touch proxy.ts / decorator.ts (wiring = P2.M2.T3.S1), config (P2.M1 done), buffer, or tests.
- ❌ Do NOT run ruff/mypy/eslint/biome — TypeScript+Bun project; those tools do not exist here.

---

**Confidence Score: 10/10** for one-pass implementation success.
Rationale: Single-file change (`src/request/builder.ts`) with the exact current constructor + body quoted
verbatim, the exact replacement code given line-for-line (imports, constant, constructor, buildReplacement
body), the exact directive string, and the full JSDoc content requirements enumerated as six explicit
areas. `renderReasoningText` — the only upstream dependency — is already present in the file (P2.M2.T1.S1
landed it), so there is no forward dependency risk. `DEFAULT_CONFIG` fields are Complete (P2.M1.T1.*). All
type shapes (`Context`/`UserMessage`/`SimpleStreamOptions`) are documented with the exact fields. Every
existing test is analyzed and shown to remain green (defaults preserve `new RequestBuilder(diag)`;
empty-snapshot tests hit the same-ref fallback; maxTokens-bearing tests keep their value). The one subtle
honesty fix — the `Date.now()` timestamp breaking strict referential transparency — is flagged for the
JSDoc rewrite so the implementer does not leave a now-false "deterministic/referentially transparent"
claim. Scope boundaries (T3 wiring, M3 tests) are explicit to prevent over-reaching.
