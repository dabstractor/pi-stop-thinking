# Research Notes — P1.M6.T1.S1: RequestBuilder (thinking-disabled transformation)

## 0. The work-item contract (verbatim, authoritative)

> INPUT: Original model (`Model<Api>`), original context (`Context`), original options
> (`SimpleStreamOptions`), frozen reasoningSnapshot from `ReasoningBuffer`.
> LOGIC: `RequestBuilder.buildReplacement(model, context, options, reasoningSnapshot): { model,
> context, options }`. Return new options object `{ ...options, reasoning: undefined }`. This
> preserves apiKey, temperature, maxTokens, sessionId, headers, etc. while disabling reasoning. The
> model and context are passed through unchanged (PRD §25.3 context reuse, §25.4 prompt reuse, §25.7
> model preserved). The ephemeral execution directive (PRD §53, §25.5) is optional — for MVP, omit it
> by default. **The method is pure (no side effects, no network).**
> OUTPUT: `RequestBuilder.buildReplacement()` returning a `{ model, context, options }` triple that
> can be passed to `original.streamSimple()`. Consumed by P1.M7.T1 (StreamProxy invokes replacement).
> DOCS: [Mode A] JSDoc documenting that reasoning is disabled by setting `options.reasoning` to
> `undefined`, which causes `enable_thinking=false` in z.ai's API payload.

So the deliverable is EXACTLY one pure transform: `{ ...options, reasoning: undefined }`, returning
the triple with `model`/`context` as the **same references** (no rewrite, no copy).

## 1. The z.ai "disable thinking" mechanism — CONFIRMED in compiled provider source

`node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js`:

```js
export const streamSimpleOpenAICompletions = (model, context, options) => {
    const apiKey = options?.apiKey || getEnvApiKey(model.provider);
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const base = buildBaseOptions(model, options, apiKey);
    const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    const toolChoice = options?.toolChoice;
    return streamOpenAICompletions(model, context, {
        ...base,
        reasoningEffort,   // ← derived from options.reasoning
        toolChoice,
    });
};
```

…then later in the payload builder (same file, lines 433–434):

```js
if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
}
```

**Chain** (with `options.reasoning === undefined`):
1. `options?.reasoning` is `undefined` (falsy) → `clampedReasoning = undefined`.
2. `clampedReasoning === "off"` is false → `reasoningEffort = undefined`.
3. `params.enable_thinking = !!undefined` → `false` → **reasoning DISABLED.**

✓ The contract's `{ ...options, reasoning: undefined }` is the exact, sufficient, minimal knob.

**Why NOT `reasoning: "off"`?** `clampThinkingLevel` may not accept `"off"` for z.ai models (z.ai has no
"off" thinking level in `model.thinkingLevelMap`), and `"off"` would route through `clampThinkingLevel`
which could throw or clamp unexpectedly. `undefined` short-circuits BEFORE the clamp (`options?.reasoning ?
clamp : undefined`), so it is unconditionally safe. **Use `undefined`, not `"off"`.**

## 2. Type-level safety of `{ ...options, reasoning: undefined }`

`SimpleStreamOptions extends StreamOptions` and declares `reasoning?: ThinkingLevel`. An optional field
legally holds `undefined`, so `reasoning: undefined` type-checks under `strict: true`. Spreading
`{ ...options, reasoning: undefined }` creates a FRESH plain object that:
- copies every own enumerable property from `options` (apiKey, temperature, maxTokens, sessionId,
  headers, signal, thinkingBudgets, timeoutMs, maxRetries, metadata, …), then
- sets/overrides `reasoning` to `undefined`.

Because it is a shallow spread, nested objects (headers, metadata) are shared by reference — that is fine
(we never mutate them) and matches "preserve everything".

## 3. Purity + the diagnostics convention

The contract says "pure (no side effects, no network)". Every sibling module (`ReasoningBuffer`,
`TransitionController`, `TransitionCoordinator`, `StreamProxy`, `ProviderDecorator`) injects a
`Diagnostics` and emits privacy-safe lifecycle milestones. The `Diagnostics` contract itself states
"Verbose logging shall never modify runtime behavior" — so a fire-and-forget `debug` trace is NOT a
behavior-affecting side effect.

**Decision**: inject `diagnostics` (consistency + P1.M8 observability) and emit exactly ONE
`debug("request.replacement-built", {})` milestone (privacy-safe — `{}` only, matching
`proxy.abort.completed`'s `{}`). The *transformation* remains pure/deterministic: no network, no input
mutation, no I/O that affects program behavior. This mirrors how `ReasoningBuffer` (an otherwise-pure
append-only collection) still emits lifecycle diagnostics.

## 4. The `reasoningSnapshot` parameter — accepted, unused in MVP

PRD §53 Inputs list "Frozen reasoning snapshot"; the contract INPUT includes it. It exists for the
optional **ephemeral execution directive** (PRD §53 "Ephemeral Execution Directive" / §25.5) — explicitly
**omitted by default in MVP**. So the param is accepted for API completeness + forward-compat but NOT read
during the MVP transform.

- `tsconfig.json` has `strict: true` but **no** `noUnusedParameters`/`noUnusedLocals` → an
  unused-but-documented param compiles cleanly. Type it `readonly ThinkingEntry[]` (the exact return of
  `ReasoningBuffer.snapshot()`). JSDoc marks it "reserved for the optional ephemeral directive; unused in
  MVP." Do NOT add hacky `void reasoningSnapshot;` — the documented param is the clean contract.

## 5. Boundary with the consumer (P1.M7.T1) — the SIGNAL

The contract preserves `options.signal` **verbatim** (`{ ...options, reasoning: undefined }` only touches
`reasoning`). But the replacement stream is launched by `StreamProxy` (P1.M7), which must control the
replacement's abort independently (PRD §51). `StreamProxy.run()` already demonstrates the override pattern:

```ts
const upstream = upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal });
```

→ **P1.M7.T1 owns the replacement signal**: it will invoke
`original.streamSimple(triple.model, triple.context, { ...triple.options, signal: <fresh internal>.signal })`.
`RequestBuilder` deliberately does NOT touch the signal — it returns Pi's original signal unchanged, and
P1.M7 overrides it at invocation time. This PRP documents that boundary; it does NOT change it.

## 6. Placement & naming (matches existing scaffold)

- `src/request/.gitkeep` already exists → create `src/request/builder.ts` (RequestBuilder module).
- Delete `src/request/.gitkeep` once `builder.ts` exists (it is only a dir placeholder).
- Test: `tests/request-builder.test.ts` (run by `bun test`; excluded from `tsc` by tsconfig `exclude`).
- Class `RequestBuilder`; instance method `buildReplacement(...)` (DI of `diagnostics`, consistent with
  siblings); return type interface `ReplacementRequest { readonly model; readonly context; readonly options }`.
- `options` returned is a plain (UNFROZEN) object so P1.M7 can spread/override (e.g. signal); the triple's
  fields are `readonly` (the triple itself is not to be reshaped).

## 7. Build / validation commands (verified present in package.json)

```bash
npx bun run typecheck   # tsc --noEmit (src/** only; tests excluded)
npx bun run build       # tsc → exit 0
npx bun test            # full suite (incl. new request-builder tests)
```
No `ruff`/`mypy` (TS project). Style = 2-space indent + Mode-A JSDoc (matches all of src/).

## 8. Reused test-double pattern (from tests/reasoning-buffer.test.ts & stream-proxy-abort.test.ts)

- `makeCaptureDiag()` — the canonical capturing Diagnostics stub (records every call).
- `makeModel()` — minimal `Model<Api>` stand-in (`{ id, api, provider, reasoning, baseUrl, compat }`).
- Construct `Context` + `SimpleStreamOptions` inline (typed, only the fields each case needs).
- Assert purity by checking the ORIGINAL `options.reasoning` is unchanged after the call.
