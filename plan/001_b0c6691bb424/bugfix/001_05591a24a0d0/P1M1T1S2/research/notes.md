# Research Notes — P1.M1.T1.S2: Realistic two-call mock provider

> Companion research for the PRP. Captures the EXACT provider mechanics the mock must reproduce,
> the existing placeholder-mock structure to extend, and the consumer contract this mock must
> satisfy. All facts are verified against local `node_modules` source.

---

## 1. The real provider's output-accumulation mechanics (the behavior to FAITHFULLY reproduce)

Source: `node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js`
(`streamOpenAICompletions`). One call == ONE accumulating `output` object:

```js
const output = {
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0,
           cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} },
  stopReason: "stop",
  timestamp: Date.now(),
};
const blocks = output.content;                 // ← output.content IS the blocks array (mutated in place)
const getContentIndex = (block) => blocks.indexOf(block);  // ← contentIndex derived from position

let textBlock = null, thinkingBlock = null;

// reasoning ON (reasoning: "high"):
const ensureThinkingBlock = () => {
  if (!thinkingBlock) {
    thinkingBlock = { type: "thinking", thinking: "" };   // pushed to content[]
    blocks.push(thinkingBlock);
    stream.push({ type:"thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
  }
  return thinkingBlock;
};
// delta: block.thinking += delta; push({type:"thinking_delta", contentIndex, delta, partial: output})
// end:   push({type:"thinking_end", contentIndex, content: block.thinking, partial: output})

// reasoning OFF (reasoning: undefined): NO thinking block; text block is first/only → content[0]
const ensureTextBlock = () => {
  if (!textBlock) {
    textBlock = { type: "text", text: "" };
    blocks.push(textBlock);
    stream.push({ type:"text_start", contentIndex: getContentIndex(textBlock), partial: output });
  }
  return textBlock;
};
// delta: block.text += delta; push({type:"text_delta", contentIndex, delta, partial: output})

// terminal:
stream.push({ type:"done", reason: output.stopReason, message: output });
stream.end();
```

**Key facts for the mock**:
- `output.content` is mutated IN PLACE (same array reference across all events of one stream). → the
  mock must push to the SAME `output.content` array, never replace it. `partial: output` is a LIVE ref.
- `contentIndex` is derived via `output.content.indexOf(block)` — for primary thinking → 0; for
  replacement text → 0. BOTH use index 0 in their OWN output objects. That is the collision (Issue 1).
- Primary (reasoning ON): first block is `thinking` at content[0]. Replacement (reasoning OFF): first
  block is `text` at content[0] (fresh output → does NOT contain the primary's thinking).
- Terminal `done` carries `message: output` (same live ref, full content).

## 2. Abort behavior — the mock must THROW (mirroring the EXISTING mock, NOT the provider's catch)

The real provider, on `options.signal` abort: the OpenAI client stream throws → provider CATCH sets
`stopReason="aborted"` and pushes `{type:"error", reason:"aborted", error: output}` then `stream.end()`.

HOWEVER the proxy's `run()` abort path is gated on the upstream **THROWING** while
`controller.getState() === "Aborting"`:
```
run() catch: if (this._upstreamCompleted) {...natural-completion...}
             if (this._controller.getState() === "Aborting") {
                completeAbort(); _buffer.freeze(); _launchReplacement(); return;
             }
```
→ For the proxy to take the abort→freeze→replacement path, the upstream iterator must THROW, not push
an error terminal. The existing placeholder mock
(`makeScriptedTwoPhaseUpstream` in `tests/helpers/invariant-harness.ts`) does EXACTLY this: its primary
iterator throws `new Error("aborted")` on `primarySignal.aborted`. The contract REQUIRES the new mock to
do the same ("throw on its AbortSignal abort ... exactly like makeScriptedTwoPhaseUpstream"). So:
- **Primary iterator throws `new Error("aborted")` on abort** (mirrors existing mock; makes proxy take
  the abort→freeze→replacement path). It does NOT push an error event.
- The replacement iterator is NOT aborted in the Issue 1 scenario (it completes normally via `done`).

## 3. The existing placeholder mock — the structure to extend

`tests/helpers/invariant-harness.ts` → `makeScriptedTwoPhaseUpstream`:
- Returns `{ fn, calls, pushPrimary, pushReplacement, closePrimary }`.
- `fn` is `(_m, _c, streamOpts?) => async iterable`, cast `as unknown as ApiStreamSimpleFunction`.
  - call 1 (primary): records `primarySignal = streamOpts.signal`; returns an async generator that
    drains `primaryQueue` then on empty queue checks `primarySignal?.aborted` → throw, else awaits a 0ms
    timer whose abort-listener rejects with "aborted". `closePrimary()` sets `primaryStopped` so the
    iterator returns cleanly.
  - call 2 (replacement): pushes to `calls`, records `replacementSignal`; returns a generator draining
    `replacementQueue` with the same await-0ms/abort pattern.
- **The gap**: its events come from `ev({type:'text_start', contentIndex:0})` — a SPREAD placeholder with
  NO real `partial` AssistantMessage and NO accumulation. That is exactly what masked Issue 1 (per PRD
  §Testing Summary "Areas needing more attention": "Mocks should carry realistic `partial` objects and
  be consumed by a faithful assembler").
- `ApiStreamSimpleFunction = (model, context, options?: SimpleStreamOptions) => AssistantMessageEventStream`
  (`node_modules/@earendil-works/pi-ai/dist/api-registry.d.ts`). `SimpleStreamOptions extends StreamOptions`
  → has `signal?: AbortSignal` (types.d.ts line 31) + `reasoning?: ThinkingLevel` (line 132).
  `ThinkingLevel = "minimal"|"low"|"medium"|"high"|"xhigh"` (line 12).
- The proxy invokes: primary `upstreamStreamFn(model, context, { ...options, signal: _internalAbort.signal })`;
  replacement `originalStreamFn(triple.model, triple.context, { ...triple.options, signal: _replacementAbort.signal })`
  with `triple.options.reasoning === undefined` (proxy.ts run() + _launchReplacement()). So the mock's `fn`
  receives reasoning via `streamOpts.reasoning` and records it.

## 4. The consumer contract this mock must satisfy (so Issue 1 is observable)

`consumeLikeAgentLoop` (P1.M1.T1.S1, `tests/helpers/consumer-harness.ts`):
- `partialMessage = event.partial` on start + every non-terminal (shallow-copied into `partialHistory`).
- `finalMessage = await stream.result()` (resolves to the terminal's `message`/`error`).

With a faithful mock driving a verbatim-forwarding proxy:
- Replacement events carry `partial: replacementOutput` (text-only) → `partialMessage` is replaced →
  streaming view loses thinking (flicker). `done.message = replacementOutput` (text-only) →
  `finalMessage.content === [{type:"text"}]` (reasoning lost from history). **This is Issue 1 — the
  regression the fix (P1.M2) and integration test (P1.M2.T3.S1) target.**

## 5. Design decision: PUSH-TIME accumulation, mock owns contentIndex + partial

- `pushPrimary`/`pushReplacement` accept a minimal event spec; the mock mutates the live `output.content`
  in place (mirroring ensure*Block + delta-append) and is the SOLE source of truth for `contentIndex`
  (via `output.content.indexOf(block)`) and `partial` (the live `output` ref). The caller does NOT pass
  `partial` or `contentIndex`.
- Both `output` objects are created at FACTORY time (stable exposed refs): `primaryOutput` (driven by
  pushPrimary) and `replacementOutput` (driven by pushReplacement, fresh content:[]). The replacement is
  "fresh" because it is a distinct object whose content never includes the primary's thinking.
- `primaryOutput`/`replacementOutput` are exposed for assertions (the integration test asserts
  `replacementOutput.content` is text-only pre-fix, and `[thinking,text]` post-fix via the proxy rewrite).

## 6. Validation (project-verified)
- `bun test` (package.json "test") — discovers `*.test.ts` under tests/.
- `bun run build` (=`tsc`) — tsconfig excludes tests/; mock won't be compiled into dist.
- Self-contained type-check (S1's pattern): `bunx tsc --noEmit --strict --module ES2022
  --moduleResolution bundler --target ES2022 --skipLibCheck --lib ES2022 --types bun <files>`.
- No production (src/) files touched — test infrastructure only.
