# Research Note — P2.M2.T2.S1: Gated Directive Injection

> Snapshot of the EXACT current state of `src/request/builder.ts` at PRP-authoring time, and the
> precise edit surface required. The parallel subtask P2.M2.T1.S1 (`renderReasoningText`) has
> ALREADY landed its code in the file — confirmed by `rg renderReasoningText` and a fresh read.

## 1. Current state of `src/request/builder.ts` (authoritative)

- **Module JSDoc** (lines 1–29): heavy on purity / "NOT read in MVP" language — must be rewritten
  (item logic step c).
- **Imports** (lines 30–35):
  ```ts
  import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
  import type { ThinkingEntry } from "../buffer";
  import type { Diagnostics } from "../diagnostics";
  ```
  - `UserMessage` is **NOT** imported → ADD to the pi-ai `import type` block.
  - `DEFAULT_CONFIG` is **NOT** imported → ADD a NEW runtime value import
    `import { DEFAULT_CONFIG } from "../config";` (it is used as constructor-param defaults; must be
    a value import, NOT `import type`).
- **`ReplacementRequest` interface** (lines ~37–53): UNCHANGED by this task.
- **`renderReasoningText`** (lines ~76–86): ALREADY PRESENT (P2.M2.T1.S1). CALL it; do NOT redefine.
- **`RequestBuilder` class** (lines ~89–end):
  - Constructor (lines ~91–93): `constructor(private readonly diagnostics: Diagnostics) {}` →
    gains two default params.
  - `buildReplacement` JSDoc (lines ~95–113): "NOT read in MVP" language → rewrite.
  - `buildReplacement` body (lines ~114–119): does NOT read `reasoningSnapshot` → full rewrite.

## 2. Required edits (single file: `src/request/builder.ts`)

1. **Imports**: add `UserMessage` to pi-ai type import; add `import { DEFAULT_CONFIG } from "../config";`.
2. **New module constant**: `const DEFAULT_REPLACEMENT_MAX_TOKENS = 16384;` (directive_design.md §9).
3. **Constructor**: add `_reasoningInjection` + `_delimiter` params with `DEFAULT_CONFIG.*` defaults.
4. **buildReplacement body**: render → gate → inject (fresh context copy) OR same-ref → fresh options
   (`reasoning: undefined`) → bounded `maxTokens` default → debug milestone → return triple.
5. **JSDoc rewrite** (Mode A): module JSDoc + buildReplacement JSDoc — remove ALL "NOT read in MVP" /
   "reserved for forward-compat" language; document the six content areas from item logic step (c).

## 3. Purity / `Date.now()` tension (CRITICAL doc gotcha)

- Current module + method JSDoc claim **strict referential transparency / determinism**.
- The directive message carries `timestamp: Date.now()` (directive_design.md §2 / §4 contract).
  This makes `buildReplacement` **NOT** strictly referentially-transparent WHEN injection is active
  (the timestamp is wall-clock-dependent).
- JSDoc MUST be updated honestly: the method remains a **non-mutating transform** (no mutation of
  inputs, no network/stream — PRD §31 h2.121 non-responsibilities still hold), but it is
  referentially-transparent ONLY modulo the directive's wall-clock timestamp.
- `renderReasoningText` (the pure renderer) is unaffected — it remains fully pure (it has no
  `Date.now()`, no `Diagnostics`). Do NOT regress its JSDoc.

## 4. Test green-keeping analysis (this task adds NO tests; P2.M3.T1.S2 owns them)

All existing tests in `tests/request-builder.test.ts` remain green:
- Every existing `new RequestBuilder(diag)` still compiles + behaves identically (new params default
  to `DEFAULT_CONFIG.reasoningInjection === true` and the default delimiter).
- Tests passing empty `[]` snapshot: `shouldInject = true && "".length>0 === false` →
  `replacementContext = context` (SAME ref). The existing same-ref test ("context is the same
  reference as the input") still passes. ✓
- Tests passing options WITH `maxTokens` (e.g. `4096`): the `=== undefined` guard skips the default
  → caller value preserved. The "full option preservation" test still passes. ✓
- Tests passing options WITHOUT `maxTokens` (e.g. `{ reasoning:"high" }`): `maxTokens` becomes
  `16384`, but those tests only assert `triple.options.reasoning === undefined` → unaffected. ✓
- "exact triple shape" test: triple still has exactly `["context","model","options"]`. ✓
- "frozen snapshot accepted" test: appends real content → shouldInject=true → fresh context copy;
  test only asserts `triple.options.reasoning === undefined` + no-throw → still passes. ✓
- Privacy test: debug still emits `{}`. ✓

## 5. Scope boundaries (do NOT touch)

- `src/provider/proxy.ts` (line 276 `new RequestBuilder(diagnostics)` + line 890 call site): wiring
  is **P2.M2.T3.S1**. The default params keep proxy.ts behavior-preserving as-is — no edit needed here.
- `src/provider/decorator.ts`: wiring is **P2.M2.T3.S1**.
- `src/config/index.ts`: already has the fields (P2.M1.T1.* Complete) — READ-ONLY here.
- `src/buffer/index.ts`: READ-ONLY — `ThinkingEntry` + `snapshot()` already correct.
- Tests (`tests/request-builder.test.ts`): directive/invariant tests are **P2.M3.T1.S2**. Do NOT add
  them here. Only ensure the existing suite stays green.

## 6. No external research warranted

- The pi-ai type shapes (`Context`, `UserMessage`, `SimpleStreamOptions`, `maxTokens`, `reasoning`)
  are fully captured in `architecture/pi-ai-context-types.md`.
- The exact implementation contract (constructor, gating, delimiter format, context augmentation,
  maxTokens, constants) is fully specified in `architecture/directive_design.md` §§2–5, 8, 9.
- No third-party library or external API is involved — this is internal TypeScript following an
  existing, well-documented in-repo pattern. External subagent research would add no signal.
