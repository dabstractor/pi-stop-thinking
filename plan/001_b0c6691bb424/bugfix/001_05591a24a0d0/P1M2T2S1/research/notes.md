# Research Notes — P1.M2.T2.S1: Rewrite non-terminal replacement events (contentIndex offset + partial merge)

> Issue 1 (CRITICAL): reasoning content is lost from the persisted assistant message on every
> interruption. This is **Task 2 Step 1** — the **non-terminal replacement-event rewrite**. It
> consumes the seed data captured by P1.M2.T1.S1 (`_frozenPrimaryContent`, `_contentIndexOffset`)
> and, in `_emit()`'s splicing branch, offsets each forwarded replacement event's `contentIndex`
> and merges its `partial` so the downstream consumer assembles ONE unified
> `[thinking, text]` message.

---

## 1. The single chokepoint — `_emit()` splicing branch (src/provider/proxy.ts)

`_emit()` (line 574) is the UNIFIED forwarding filter: both the primary loop (`run()`) and the
replacement loop (`_launchReplacement()`) forward through it. It branches on `this._authority`:

- `"forwarding"` (== primary) — forward ALL events unchanged (lines 607–622).
- `"splicing"` (== replacement) — PRD §18 "After Restart" filtering (lines 625–649):

```ts
// REPLACEMENT phase (_authority === "splicing") — PRD §18 "After Restart" / §39.
if (event.type === "start") {                       // ← SUPPRESSED (early return)
  this.diagnostics.trace("proxy.splice.start-suppressed", {});
  return;
}
if (isThinkingEvent(event)) {                       // ← EC-017 (replacement returned reasoning)
  this.diagnostics.trace("proxy.splice.reasoning-forwarded", {});
  // fall through to push(event) below
}
if (isTerminalEvent(event)) {
  if (this._messageEndEmitted) {                    // ← DUPLICATE terminal (early return, discarded)
    this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
    return;
  }
  this._messageEndEmitted = true;                   // ← FIRST terminal → fall through
}
// text_start/delta/end + toolcall_* (and the first terminal) → forward.
this._output.push(event);                           // ← LINE 648 — THE single forward point
```

**KEY**: every event the splicing branch FORWARDS passes through the ONE `this._output.push(event)`
at line 648. Events that are suppressed/discarded `return` BEFORE line 648.

### WHERE the rewrite gate goes

Immediately BEFORE line 648 (the final push), AFTER all the early-return guards:

```ts
// P1.M2.T2.S1 — Issue 1 fix: rewrite non-terminal replacement events so the consumer assembles
// ONE unified message [primary reasoning, ...replacement answer]. See _rewriteReplacementEvent.
if (this._contentIndexOffset > 0 && "contentIndex" in event) {
  event = this._rewriteReplacementEvent(event);
}
this._output.push(event);
```

This placement is the correct, minimal one. The contract's parenthetical — *"(a thinking event from
the replacement that is forwarded must be rewritten too)"* — is satisfied because EC-017 thinking
events fall through to line 648 and hit the gate. The events that early-return (suppressed `start`,
discarded duplicate terminal, and the top-of-method `discard-after-completion` stray guard at line
602) do NOT reach the gate — correct, they are not forwarded.

### Why the gate's two conditions

- `this._contentIndexOffset > 0` — **the no-op guard**: when offset is 0 (no captured primary
  content — e.g. every existing placeholder-mock test), the rewrite is skipped entirely → ALL 386
  existing tests stay byte-for-byte green. (T1.S1 guarantees offset 0 when `_primaryPartial` is
  undefined.) CRITICAL for blast radius.
- `"contentIndex" in event` — **the non-terminal selector**: only non-terminal events carry
  `contentIndex`. Terminals (`done`/`error`) do NOT → the gate skips them → the terminal is
  forwarded UNCHANGED. **T2.S2 owns the terminal** (`done.message`/`error.error` merge). T2.S1 must
  NOT touch the terminal.

---

## 2. T1.S1 seed data is IN PLACE (verified against current src/)

The predecessor subtask P1.M2.T1.S1 is COMPLETE and shipped:

- `private _primaryPartial: AssistantMessage | undefined;` — line 150
- `private _frozenPrimaryContent: ReadonlyArray<Record<string, unknown>> = [];` — line 157
- `private _contentIndexOffset = 0;` — line 164
- `get frozenPrimaryContent()` — line 311; `get contentIndexOffset()` — line 319
- Primary-loop capture (line 683–684): `if (!isTerminalEvent(event) && event.partial) { this._primaryPartial = event.partial; }`
- Abort-branch snapshot (line 736–737, immediately after `this._buffer.freeze()`):
  `this._frozenPrimaryContent = (this._primaryPartial?.content ?? []).map((b) => ({ ...b }));`
  `this._contentIndexOffset = this._frozenPrimaryContent.length;`

So T2.S1 reads `this._contentIndexOffset` and `this._frozenPrimaryContent` — both already populated
by the time the splicing branch runs (the snapshot runs in `run()`'s catch BEFORE
`_launchReplacement()` flips authority to `"splicing"`). **T2.S1 adds NO new fields.**

---

## 3. The two new private methods (literal contract + tsc-safe forms)

### `_mergePartial(replacementPartial)` — the content merge

Contract-literal:
```ts
{ ...replacementPartial, content: [...this._frozenPrimaryContent.map((b) => ({ ...b })),
                                  ...(replacementPartial?.content ?? [])] }
```
- Spread `replacementPartial` (preserve its `usage`/`model`/`stopReason`/`timestamp`).
- OVERRIDE `content` with a NEW array: [**cloned** frozen primary blocks, ...replacement's own content blocks].
- The frozen blocks are CLONED (`{ ...b }`) to avoid aliasing the `_frozenPrimaryContent` snapshot
  across events (defensive isolation — the contract explicitly requires this).
- The replacement's own blocks are NOT cloned (they are the replacement's live accumulating blocks —
  same as the provider's own `partial` semantics; the consumer reads them live).
- Param typed `AssistantMessage | undefined` (the contract uses `replacementPartial?.content ?? []`),
  return cast `as AssistantMessage` (the spread + override is structurally an AssistantMessage).

### `_rewriteReplacementEvent(event)` — the per-event rewrite

Contract-literal:
```ts
{ ...event, contentIndex: event.contentIndex + this._contentIndexOffset,
            partial: this._mergePartial(event.partial) }
```

### tsc GOTCHA (the #1 trap — same class as T1.S1's `.partial` narrowing)

`AssistantMessageEvent` is a discriminated union. `contentIndex` exists on every NON-terminal member
but NOT on `done`/`error`; `partial` likewise. If `_rewriteReplacementEvent`'s param is typed
`AssistantMessageEvent` (broad), then `event.contentIndex` and `event.partial` are **tsc errors**:
*"Property 'contentIndex'/'partial' does not exist on type 'TerminalEvent'"* → `npm run build` (tsc)
FAILS. (`npm run build` IS a real gate — src/ is compiled.)

FIX — narrow defensively INSIDE the method with `in` checks (the call-site gate already guarantees
`"contentIndex" in event`, so these are no-ops at runtime but make tsc strict-mode happy):

```ts
private _rewriteReplacementEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  const contentIndex = ("contentIndex" in event ? event.contentIndex : 0) + this._contentIndexOffset;
  const partial = this._mergePartial("partial" in event ? event.partial : undefined);
  return { ...event, contentIndex, partial };
}
```

This is the idiomatic, contract-faithful, tsc-clean form. (Equivalent to T1.S1's
`!isTerminalEvent(event)` narrowing; here `in` is used because BOTH `contentIndex` AND `partial` must
be narrowed, and the call-site already used `in`.)

---

## 4. EC-017 (replacement returned reasoning) — NO special case (verified)

EC-017 = the thinking-disabled replacement returned reasoning anyway. The splicing branch's
`isThinkingEvent` arm forwards it (falls through to line 648). Its `partial.content` contains the
replacement's OWN thinking block(s) (it is the replacement's live `output`, reasoning was emitted).
The `_mergePartial` prepends the frozen PRIMARY blocks THEN appends `replacementPartial.content`
(which includes the replacement's own thinking). So merged content =
`[...primaryThinking, ...replacementThinking, ...replacementText]`. The replacement's thinking block
lives AFTER the primary's — correct, no special case. The contentIndex offset (0→N) shifts the
replacement's thinking block to its correct slot in the merged array. **The single gate before line
648 handles this automatically** (thinking events have `contentIndex`, so the gate fires).

---

## 5. The realistic mock surface (shipped P1.M1.T1.S2 — consume, do NOT modify)

`tests/helpers/realistic-mock.ts` → `makeRealisticTwoPhaseMock()` returns
`{ fn, pushPrimary, pushReplacement, closePrimary, primaryOutput, replacementOutput, calls }`:

- `mock.fn` — drop-in `ApiStreamSimpleFunction` for the StreamProxy ctor's `upstreamStreamFn` arg.
- Call 1 (primary) → reasoning ON; `primaryOutput.content` grows a `thinking` block at index 0;
  every primary non-terminal event stamped `partial: primaryOutput` (LIVE reference). Throws
  `new Error("aborted")` on `_internalAbort` abort → triggers `run()`'s abort→freeze→snapshot path.
- Call 2 (replacement) → reasoning OFF; FRESH `replacementOutput` (`content` starts `[]`); the first
  pushed `text_*` spec creates a `text` block at index 0; replacement non-terminal events stamped
  `partial: replacementOutput` (LIVE, never includes primary thinking); `done` stamped
  `message: replacementOutput`.
- `pushReplacement({type:'text_start'})` → `contentIndex: 0`, `partial: replacementOutput`
  (replacementOutput.content === [{type:'text', text:''}]).
- `pushReplacement({type:'text_delta', delta:'Here'})` → appends to the text block,
  `contentIndex: 0`, `partial: replacementOutput` (content[0].text === 'Here').
- `calls[1].options.reasoning === undefined` (the replacement is thinking-disabled).

So after a primary `[start, thinking_start, thinking_delta('Let'), thinking_delta(' me')]` + abort,
`_contentIndexOffset === 1` and `_frozenPrimaryContent === [{type:'thinking', thinking:'Let me'}]`.
Then replacement `[text_start, text_delta('Here'), text_delta(' answer'), text_end, done]`:
- text_start → rewritten: contentIndex `0+1=1`, partial.content = `[{thinking:'Let me'}, {text:''}]`
- text_delta('Here') → contentIndex `1`, partial.content = `[{thinking:'Let me'}, {text:'Here'}]`
- text_delta(' answer') → contentIndex `1`, partial.content = `[{thinking:'Let me'}, {text:'Here answer'}]`
- text_end → contentIndex `1`, partial.content = `[{thinking:'Let me'}, {text:'Here answer'}]`
- done → NO contentIndex → gate skips → forwarded UNCHANGED (T2.S2 owns it).

---

## 6. Test-driving idiom (copied from T1.S1's stream-proxy-capture.test.ts + abort tests)

Construction (exact arg order — matches `new StreamProxy(model, ctx, opts, upstreamFn, diag,
controller, buffer, transitionTimeoutMs, coordinator, replacementStartupTimeoutMs)`):

```ts
import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

const { diag, events } = makeCaptureDiag();
const controller = new TransitionController(diag);
const buffer = new ReasoningBuffer(diag, 1_000_000);
const mock = makeRealisticTwoPhaseMock();
const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller,
  buffer, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15 /* orphan-safe replacement startup */);
```

Control flow (drive → reason → stop → drive replacement → collect → assert):
1. `mock.pushPrimary(start, thinking_start, thinking_delta('Let'), thinking_delta(' me'))`.
2. `await waitFor(() => proxy.isReasoning())` — primary events processed.
3. `expect(proxy.triggerStop()).toBe(true)` — Aborting + `_internalAbort.abort()` → primary throws.
4. `await waitFor(() => events.some(c => c.event === 'proxy.abort.completed'))` — freeze + snapshot
   (offset now 1, frozen now [{thinking:'Let me'}]).
5. `mock.pushReplacement(text_start, text_delta('Here'), text_delta(' answer'), text_end, done)`.
6. Collect forwarded events by draining `proxy.output` to completion (the `done` completes it).

**Collecting forwarded events** — `AssistantMessageEventStream.push` buffers into an internal queue,
so the primary events forwarded during steps 1–3 are buffered and pulled when the drain iterates.
Drain AFTER step 5:
```ts
const forwarded: AssistantMessageEvent[] = [];
for await (const event of proxy.output) forwarded.push(event);
```
This yields `[start, thinking_start, thinking_delta, thinking_delta, text_start, text_delta,
text_delta, text_end, done]` (the replacement `start` is suppressed — NOT in the array).

Filter the NON-TERMINAL replacement events = the `text_*` events (this test's replacement is
reasoning-OFF → emits text only): `forwarded.filter(e => e.type.startsWith('text_'))`. For EACH:
- `e.contentIndex === 1` (offset applied; mock emitted 0).
- `e.partial.content.length === 2`.
- `e.partial.content[0]` ≈ `{type:'thinking', thinking:'Let me'}` (frozen primary, stable).
- `e.partial.content[1]` ≈ `{type:'text', text:'<accumulated>'}` (grows: '', 'Here', 'Here answer').

---

## 7. Baseline + blast-radius (validated commands)

- `bun` is NOT on PATH → run tests via `./node_modules/.bin/bun test ...` or `npm test`.
- `npm run build` runs `tsc` (the src/ type gate). `npm test` runs `bun test`.
- **Current baseline: 386 pass / 0 fail** (384 original + 2 from T1.S1). After T2.S1: 387 (main test)
  or 388 (main + offset-0 guard test). **0 fail is the hard gate.**
- The offset-0 guard (`_contentIndexOffset > 0` in the gate) keeps the entire existing 386-test suite
  green (placeholder mocks → offset 0 → no rewrite). Verify with `npm test`.

## 8. Scope discipline (cohesion — do NOT harm sibling work items)

- T2.S1 rewrites NON-TERMINAL replacement events ONLY. It does NOT touch the terminal
  (`done.message`/`error.error`) — that is **P1.M2.T2.S2**.
- T2.S1 does NOT add the end-to-end consumer-harness assertion (`consumeLikeAgentLoop` final message
  = `[thinking, text]`) — that is **P1.M2.T3.S1**. T2.S1 asserts on the RAW rewritten events only.
- T2.S1 does NOT modify `_frozenPrimaryContent`/`_contentIndexOffset` capture (T1.S1 owns it), nor
  `run()`, `_launchReplacement`, `trackEvent`, `makeErrorAssistantMessage`, types.ts, or any helper.
- `git diff --stat -- src/` must show ONLY `src/provider/proxy.ts` changed (1 gate + 2 methods).
