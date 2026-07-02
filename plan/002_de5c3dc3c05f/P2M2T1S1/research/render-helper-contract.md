# Research Note — renderReasoningText pure helper (P2.M2.T1.S1)

> Companion research for the PRP. Establishes the exact contract, placement, gotchas, and scope
> boundaries for adding a single exported pure function to `src/request/builder.ts`.

## 1. Authoritative contract (architecture/directive_design.md §1)

**Location:** `src/request/builder.ts` — exported function (same module as `RequestBuilder`; no new file).

**Signature:**
```ts
export function renderReasoningText(entries: readonly ThinkingEntry[]): string
```

**Logic:** `entries.map((e) => e.content).join("")`
- Empty snapshot (`[]`) → `""` → directive omitted (gated fallback — handled in **T2**, not here).
- Entries are already offset-ordered (append-order; `snapshot()` preserves order).
- **Pure:** no side effects, no diagnostics calls, referentially transparent.

## 2. ThinkingEntry shape (src/buffer/index.ts:61)

```ts
export interface ThinkingEntry {
  readonly offset: number;    // append-order index (0,1,2,…)
  readonly timestamp: number; // epoch ms
  readonly content: string;   // raw reasoning delta, stored verbatim
}
```

`snapshot()` returns `readonly ThinkingEntry[]` — a `Object.freeze`'d array of `Object.freeze`'d
entry copies (verified in src/buffer/index.ts). **Already offset-ordered** (offset = push index).

## 3. Already-imported (no new import needed)

`src/request/builder.ts:44` already has `import type { ThinkingEntry } from "../buffer";`.
The new function reuses this existing import — **do not add a duplicate import.**

## 4. Consumer chain (where the output flows)

- **This task (S1):** defines + exports `renderReasoningText`.
- **P2.M2.T2.S1 (buildReplacement):** calls `renderReasoningText(reasoningSnapshot)` inside the
  gating logic: `const shouldInject = this._reasoningInjection && rendered.length > 0;`. The empty
  string from an empty snapshot is exactly what drives the gate's "omit directive" branch.
- **proxy.ts:890** passes the live snapshot: `buildReplacement(model, context, options, this._buffer.snapshot())`.

The function is a leaf dependency — nothing in this task depends on config or wiring (those land in
T2/T3). S1 is deliberately standalone and can be implemented + validated in isolation.

## 5. Purity / opaque-buffer guarantees (PRD §53 h3.70, §13.4 h2.41)

- **Opaque buffer (§13.4 / h2.41):** "The extension does not interpret reasoning." `renderReasoningText`
  must NOT summarize, compress, truncate, reformat, or filter content. It concatenates `content`
  verbatim, offset-ordered. The `offset`/`timestamp` fields are NOT part of the output (h3.70: "No
  deltas, offsets, timestamps, or provider event envelopes are injected — only the rendered text").
- **Referentially transparent:** same input snapshot ⇒ identical output string. No `this`, no
  module-level mutable state, no I/O, no `Date.now()`, no diagnostics.
- **Not a class method:** exported standalone function. The `RequestBuilder` class is untouched in S1.

## 6. Placement decision

The function is an exported module-level helper. Recommended placement: immediately AFTER the
`ReplacementRequest` interface block (src/request/builder.ts ~line 100, the interface ends before the
`RequestBuilder` class comment) and BEFORE the `RequestBuilder` class. This groups the module's
exported types/helpers above the class. Alternative (acceptable): at the end of the file after the
class. Either works; the ONLY hard requirement is `export function`. No `src/index.ts` barrel
re-export is required — the consumer (T2 buildReplacement) is co-located in the same module.

## 7. Type-safety note (readonly array + map/join)

- `entries: readonly ThinkingEntry[]` supports `.map()` (returns `string[]`) and `.join("")` (returns
  `string`) without any cast. `[].map(...).join("") === ""` — the empty case is handled naturally by
  `Array.prototype.join`; no special-case branch is needed.
- `noUncheckedIndexedAccess` is NOT enabled (tsconfig `strict: true` only), so `e.content` is `string`
  (not `string | undefined`). No non-null assertions required.

## 8. Scope boundaries (do NOT do these in S1)

| Concern | Owner | Why it's out of scope here |
|---|---|---|
| Delimiter wrapping (`open`/`close` fence) | P2.M2.T2.S1 | `renderReasoningText` returns RAW text only |
| Gating (`reasoningInjection && length > 0`) | P2.M2.T2.S1 | buildReplacement owns the gate |
| Directive message construction (UserMessage) | P2.M2.T2.S1 | separate concern |
| `RequestBuilder` constructor change (`_reasoningInjection`, `_delimiter`) | P2.M2.T2.S1 | builder wiring |
| StreamProxy ctor params / decorator call site | P2.M2.T3.S1 | proxy wiring |
| Config field tests / validateConfig edge cases | P2.M3.T1.S1/S2 | config module tests |
| Directive + invariant tests (INV-013, INV-014) | P2.M3.T1.S2 | gating/invariant behavior, NOT the pure helper |
| README / CHANGELOG | P2.M3.T2.S1/S2 | docs sync |

The unit tests for `renderReasoningText` itself (pure function: empty → "", multi-entry join, order,
content-only / no offset/timestamp leakage) DO belong in S1 — they are the function's own validation
and are distinct from the gating/invariant tests owned by M3.T1.S2.

## 9. Validation commands (verified against package.json/tsconfig)

- `bun run typecheck` → `tsc --noEmit`. Covers `src/` ONLY (tsconfig `exclude: ["tests"]`).
- `bun test` → runs `tests/` via `bun:test` (runtime type-stripping).
- No ruff/mypy/eslint/biome — TypeScript+Bun project. Do not invoke nonexistent tools.

## 10. Existing test conventions (tests/request-builder.test.ts)

- `import { describe, test, expect } from "bun:test";`
- Imports from `"../src/request/builder"` and `"../src/buffer"`. Adding a named import
  `renderReasoningText` to the existing `import { RequestBuilder } from "../src/request/builder";`
  line (or a new line) is the convention.
- Test doubles exist: `makeCaptureDiag()`, `makeModel()`, `makeContext()`. The render helper needs
  NONE of these — it is a pure function over plain data, so tests build `ThinkingEntry[]` literals
  directly (or use a real `ReasoningBuffer` snapshot).
- `describe`/`test` blocks per concern; terse assertions.

## 11. JSDoc requirements (work-item DOCS = Mode A)

Document on the exported function:
1. **Purpose** — PRD §53 h3.70 "What is injected": render the captured reasoning text as plain text
   from the frozen snapshot, offset-ordered, unmodified.
2. **Purity** — no side effects, no diagnostics, referentially transparent; deterministic.
3. **Opaque-buffer guarantee** — does NOT interpret, summarize, compress, or transform reasoning
   (§13.4 h2.41); injects rendered text only, never offsets/timestamps/deltas/event envelopes.

No standalone docs subtask (Mode A = JSDoc only). README/CHANGELOG are M3.T2.
