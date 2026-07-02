# Directive Design — §53 Ephemeral Execution Directive Implementation Contract

> This document is the authoritative implementation contract for the reasoning reuse delta.
> It defines the exact interfaces, rendering logic, delimiter format, and gating rules.

## 1. renderReasoningText — Pure Snapshot Renderer

**Location:** `src/request/builder.ts` (exported function).

**Signature:**
```ts
export function renderReasoningText(entries: readonly ThinkingEntry[]): string
```

**Logic:** `entries.map(e => e.content).join("")`
- Empty snapshot (`[]`) → `""` → directive omitted (gated fallback).
- Entries are already offset-ordered (append-order; `snapshot()` preserves order).
- Pure: no side effects, no diagnostics, referentially transparent.

## 2. Directive Message Construction

**Type:** `UserMessage` (from `@earendil-works/pi-ai`)

```ts
const rendered = renderReasoningText(reasoningSnapshot);
const directiveContent =
  `${delimiter.open}\n${rendered}\n${delimiter.close}\n\n` +
  `Using the prior reasoning above as reference context only, ` +
  `produce your best available answer to the user's request now. ` +
  `Do not continue or extend reasoning.`;

const directiveMessage: UserMessage = {
  role: "user",
  content: directiveContent,
  timestamp: Date.now(),
};
```

**Delimiter defaults (PRD §53 / Appendix K):**
```ts
reasoningInjectionDelimiter: {
  open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
  close: "[End of prior reasoning]\n---",
}
```

**Positioning (§53 / §26):** Read-only reference context. Must NOT invite resumption/extension.

## 3. Context Augmentation (Non-Mutating)

```ts
const augmentedContext: Context = {
  ...context,
  messages: [...context.messages, directiveMessage], // COPY — never push into original
};
```

- Original `context` object is UNTOUCHED.
- Directive is **ephemeral**: exists only within this single replacement request.
- NOT persisted into conversation history (persisted reasoning reaches history via output stitching only).

**Identity rule:** `triple.context === originalContext` holds ONLY when injection is disabled
or snapshot is empty.

## 4. Gating Logic (buildReplacement)

```ts
const rendered = renderReasoningText(reasoningSnapshot);
const shouldInject = this._reasoningInjection && rendered.length > 0;

const replacementContext: Context = shouldInject
  ? { ...context, messages: [...context.messages, buildDirectiveMessage(rendered, this._delimiter)] }
  : context;  // same reference

const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
if (replacementOptions.maxTokens === undefined) {
  replacementOptions.maxTokens = DEFAULT_REPLACEMENT_MAX_TOKENS;
}
```

**Gating conditions (both must be true):**
1. `config.reasoningInjection === true` (default `true`)
2. `rendered.length > 0` (snapshot non-empty)

## 5. Constructor Change

**Current:** `constructor(private readonly diagnostics: Diagnostics) {}`

**Updated:**
```ts
constructor(
  private readonly diagnostics: Diagnostics,
  private readonly _reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
  private readonly _delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
) {}
```

## 6. Config Type Additions

```ts
reasoningInjection: boolean;                                    // default: true
reasoningInjectionDelimiter: { open: string; close: string };   // default: fence per §53
```

**Validation:** `reasoningInjection` → `isBool`; `reasoningInjectionDelimiter` → new guard checking
both `open` and `close` are non-empty strings (fallback to entire default object on failure).

**Env vars:**
- `PI_STOP_THINKING_REASONING_INJECTION` → `envBool`
- `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` → non-empty string
- `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE` → non-empty string

## 7. Proxy Wiring

StreamProxy constructor gains params 12-13 (appended):
```ts
reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
```

Forwarded to: `this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics, reasoningInjection, delimiter);`

Decorator passes: `this.config.reasoningInjection`, `this.config.reasoningInjectionDelimiter`.

## 8. Test Contract (Key Assertions)

- **Directive content:** non-empty snapshot → context.messages length = original + 1; last = UserMessage.
- **Gated fallback (disabled):** reasoningInjection: false → context is same reference.
- **Gated fallback (empty):** empty snapshot → context is same reference.
- **Non-mutation:** original context unchanged.
- **Options scoping (INV-014):** reasoning === undefined; original unmutated.
- **Privacy:** debug fields are `{}`.
- **INV-013:** default behavior reuses reasoning.

## 9. Constants

```ts
const DEFAULT_REPLACEMENT_MAX_TOKENS = 16384;
```
z.ai does NOT reliably enforce this; completion relies on the stream's terminal event.
