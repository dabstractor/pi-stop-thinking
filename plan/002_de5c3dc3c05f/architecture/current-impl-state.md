# Current Implementation State — Reasoning Reuse Gap Analysis

> Scout of the already-built MVP against the updated PRD (ADR-006 §53).

## TL;DR — the gap is narrow and well-contained

| Area | Status |
|---|---|
| `ReasoningBuffer` capture + `freeze()` + immutable `snapshot()` | ✅ Built |
| Snapshot plumbed into `RequestBuilder.buildReplacement(...)` (4th arg) | ✅ Built |
| **`reasoningSnapshot` parameter is ACCEPTED but explicitly NOT READ** | ❌ **Core gap** |
| `Config` has `reasoningInjection` / `reasoningInjectionDelimiter` | ❌ **Missing** |
| Replacement `Context` augmentation (ephemeral, non-mutating copy) | ❌ **Missing** |
| `{ ...options, reasoning: undefined }` override (INV-014 options scoping) | ✅ Built |
| Output stitching (forward primary `thinking_*` to Pi output) | ✅ Built (proxy rewrite) |

## 1. src/request/builder.ts

### Current buildReplacement (lines ~114–119)
```ts
buildReplacement(model, context, options, reasoningSnapshot) {
  const replacementOptions = { ...options, reasoning: undefined };
  this.diagnostics.debug("request.replacement-built", {});
  return { model, context, options: replacementOptions };
}
```
- `reasoningSnapshot` is the 4th param — **accepted but NOT read** ("NOT read in MVP").
- Constructor: `constructor(private readonly diagnostics: Diagnostics) {}` — takes only Diagnostics.
- Pure transform: no network, no mutation of args.
- `ReplacementRequest`: `{ readonly model; readonly context; readonly options }`.

### Gap
Must now: render snapshot → text; gate on config; wrap in delimiter fence; inject into fresh
Context copy (non-mutating); set bounded maxTokens; rewrite JSDoc.

## 2. src/config/index.ts

### Current Config interface (8 fields)
```ts
enabled, shortcut, supportedProviders, transitionTimeoutMs,
replacementStartupTimeoutMs, maximumReasoningBufferBytes,
telemetryEnabled, diagnosticsLevel
```

### Missing (PRD §47 + Appendix K)
```ts
reasoningInjection: boolean;                                  // default: true
reasoningInjectionDelimiter: { open: string; close: string }; // default fence
```

Must be added to: Config interface, DEFAULT_CONFIG (deep-frozen), validateConfig (strict guards),
loadConfigFromEnv (3 new env vars).

## 3. src/buffer/index.ts — available data

```ts
interface ThinkingEntry {
  readonly offset: number;     // append-order index
  readonly timestamp: number;  // epoch ms
  readonly content: string;    // raw reasoning delta, verbatim
}
snapshot(): readonly ThinkingEntry[]  // frozen array of frozen entry copies
```
Render = `snapshot.map(e => e.content).join("")`.

## 4. src/provider/proxy.ts — builder call site

Line 890: `this._requestBuilder.buildReplacement(model, context, options, this._buffer.snapshot())`
Inside `_launchReplacement`, after `completeAbort()` + `buffer.freeze()`.

Builder construction (line 276): `this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics)`

StreamProxy constructor: 11 positional params (model through coordinator). Config threading:
add params 12-13 (reasoningInjection, delimiter) with DEFAULT_CONFIG defaults.

Decorator StreamProxy construction (decorator.ts wrapperStreamSimple): passes config scalar
fields. Add: `this.config.reasoningInjection`, `this.config.reasoningInjectionDelimiter`.

## 5. Test infrastructure

- `tests/config.test.ts`: `FULL_DEFAULTS` literal mirrors DEFAULT_CONFIG via `.toEqual`. Must extend.
- `tests/request-builder.test.ts`: `makeCaptureDiag()`, `makeModel()`, `makeContext()`. Existing
  context-identity test (`triple.context === context`) passes with empty `[]` snapshot — still
  valid after changes (injection omitted for empty). Add non-empty-snapshot cases.
- `tests/helpers/realistic-mock.ts`: two-phase mock (primary + replacement queues). Does NOT
  inspect context content — directive injection is transparent to it.
- `tests/helpers/consumer-harness.ts`: `consumeLikeAgentLoop(stream)` mirrors agent-loop.js.
