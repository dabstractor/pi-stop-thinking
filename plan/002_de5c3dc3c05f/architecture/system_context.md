# System Context — Stop Thinking & Do: Reasoning Reuse Delta (ADR-006 / §53)

## 1. Project State

The `pi-stop-thinking` extension is a **mature, production-implemented MVP**. All 8 original
milestones (P1.M1–P1.M8) described in PRD §50 are fully implemented with **412 passing tests**
and comprehensive coverage (property tests, stress tests, chaos tests, golden replay, regression
suites). The extension is functional and shippable as-is.

## 2. What Changed (The Delta)

The PRD was updated in commit `a87d0fe` ("Define ephemeral text injection for reasoning reuse")
to add **ADR-006** and elevate the **§53 Ephemeral Execution Directive** from an
optional/forward-compat feature to a **first-class, normative requirement** (INV-013).

**Original MVP behavior (implemented):** When the user presses `Ctrl+Q`, the extension aborts
the reasoning stream, freezes the `ReasoningBuffer`, and issues a thinking-disabled replacement
request. The captured reasoning is **discarded** for input purposes (the replacement answers
**from scratch**). Reasoning is preserved only for **display** via output stitching (forwarding
primary `thinking_*` events + merging frozen content into the replacement terminal's
`message`/`partial`).

**Updated PRD requirement (ADR-006):** The captured reasoning must now be **reused** — the frozen
`ReasoningBuffer` snapshot is injected as **ephemeral, delimited plain-text reference context**
into the thinking-disabled replacement request, so the model conditions its answer on its own
prior reasoning. This is **input injection** — distinct from the output stitching that already
works.

## 3. The Gap (Narrow & Well-Contained)

The infrastructure already exists. The gap is **one method that accepts a parameter but doesn't
read it**:

```
src/request/builder.ts → buildReplacement(... reasoningSnapshot)
  └─ reasoningSnapshot: readonly ThinkingEntry[]  ← PLUMBED BUT EXPLICITLY NOT READ
  └─ JSDoc: "NOT read in MVP"                     ← MUST BE REWRITTEN
```

### Specific changes required:

| ID | Gap | File(s) | Status |
|---|---|---|---|
| R1 | `buildReplacement` must read snapshot, render to text, wrap in delimiter fence, inject into fresh Context copy | `src/request/builder.ts` | ❌ Core gap |
| R2 | `Config` lacks `reasoningInjection` (bool, default `true`) and `reasoningInjectionDelimiter` ({open,close}) | `src/config/index.ts` | ❌ Missing |
| R3 | Context augmentation must be ephemeral + non-mutating (fresh copy, never mutate original) | `src/request/builder.ts` | ❌ New constraint |
| R4 | INV-014 (reasoning-disabled scope) needs explicit test coverage | `tests/` | ⚠️ Largely satisfied, needs attestation |
| R5 | INV-013 (reasoning reused not discarded) — satisfied once R1 lands | `tests/` | ❌ New invariant |

## 4. Key Architecture Decisions (Validated by Research)

### 4.1 How to inject content into the replacement request

**Research finding:** `Context` is `{ systemPrompt?: string; messages: Message[]; tools?: Tool[] }` —
a plain, mutable JS object. The provider's `streamSimple` passes it straight to the provider
implementation, which reads `context.systemPrompt` and `context.messages` directly.

**Decision: Append an ephemeral `UserMessage` to a COPY of `context.messages`.**

```ts
const directiveMessage: UserMessage = {
  role: "user",
  content: `${delimiter.open}\n${renderedReasoning}\n${delimiter.close}\n\n` +
    `Using the prior reasoning above as reference context only, ` +
    `produce your best available answer to the user's request now. ` +
    `Do not continue or extend reasoning.`,
  timestamp: Date.now(),
};
const augmentedContext: Context = {
  ...context,
  messages: [...context.messages, directiveMessage], // COPY — never mutate original
};
```

**Rationale:** Preserves the original `context` object untouched (non-mutating), the directive
rides as the last message (the model reads it as the most recent context), and it does not change
the system prompt (preserving prefix-cache boundaries for the shared conversation prefix).

### 4.2 Config threading (decorator → proxy → builder)

The `ProviderDecorator` holds the `Config`. The `StreamProxy` takes scalar params (not a Config
reference). The `RequestBuilder` is constructed inside the proxy.

**Decision: Add two new scalar params to StreamProxy's constructor** (mirroring the existing
`abortTimeoutMs`/`replacementStartupTimeoutMs` pattern), forwarded to the `RequestBuilder`.

### 4.3 maxTokens bound (§25.6 / Appendix P.3)

z.ai does NOT reliably enforce `maxTokens` (observed ~733 tokens emitted under a 220-token
limit). Preserve any caller-supplied `maxTokens`; when absent, set a sane answer budget.
Completion relies on the stream's terminal event, not the cap.

### 4.4 Observational equivalence (ADR-005)

When `reasoningInjection` is disabled OR the snapshot is empty, the directive is omitted and
`buildReplacement` returns the same behavior as today (same-ref context). The existing
context-identity test continues to pass for the empty-snapshot case.

## 5. pi-ai Provider API Types (from research)

- `Context`: `{ systemPrompt?: string; messages: Message[]; tools?: Tool[] }` — plain mutable object.
- `UserMessage`: `{ role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }`.
- `SimpleStreamOptions`: extends `StreamOptions` with `reasoning?: ThinkingLevel` and `thinkingBudgets?`.
- `StreamOptions`: `{ temperature?, maxTokens?, signal?, apiKey?, onPayload?, ... }`.
- `streamSimple(model, context, options)` resolves the provider and passes (model, context, options) straight through.
- The provider reads `context.systemPrompt` and `context.messages` directly in `convertMessages`.
- No built-in "augment system prompt" API — injection must construct a new Context value.
- `options.onPayload` hook exists but operates on provider-native payload (less type-safe).

## 6. Files Changed

| File | Change Type | Description |
|---|---|---|
| `src/config/index.ts` | Modified | Add `reasoningInjection` + `reasoningInjectionDelimiter` to Config, DEFAULT_CONFIG, validateConfig, loadConfigFromEnv |
| `src/request/builder.ts` | Modified | Add `renderReasoningText` helper; modify constructor + `buildReplacement` for directive injection; rewrite JSDoc |
| `src/provider/proxy.ts` | Modified | Thread two config fields through constructor to RequestBuilder |
| `src/provider/decorator.ts` | Modified | Pass config fields when constructing StreamProxy |
| `tests/config.test.ts` | Modified | Extend FULL_DEFAULTS + validation/env tests |
| `tests/request-builder.test.ts` | Modified | Directive content, gated fallback, non-mutation, privacy, invariants |
| `README.md` | Modified | Features, config/env tables, how-it-works disambiguation |
| `CHANGELOG.md` | Modified | Add entry for reasoning reuse |
