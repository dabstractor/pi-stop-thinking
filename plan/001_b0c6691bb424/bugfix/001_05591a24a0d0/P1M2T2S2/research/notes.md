# Research Notes — P1.M2.T2.S2: Rewrite replacement TERMINAL event (merge done message / error content)

> Issue 1 (CRITICAL): reasoning content is lost from the persisted assistant message on every interruption.
> This is **Task 2 Step 2** — the **terminal replacement-event rewrite**. T2.S1 (COMPLETE) rewrites the
> NON-TERMINAL replacement events (contentIndex offset + merged `partial`). T2.S2 rewrites the replacement
> **TERMINAL** (`done.message` / `error.error`) so `output.result()` — what the consumer PERSISTS — resolves to
> the unified `[thinking, ...answer]` message instead of the replacement's text-only output. It REUSES T2.S1's
> `_mergePartial` (no new merge logic) and T1.S1's seed data (`_frozenPrimaryContent`, `_contentIndexOffset`).

---

## 1. Why the terminal is a SEPARATE concern from T2.S1 (the root cause of the persisted bug)

T2.S1 fixed the STREAMING view (`partialMessage = event.partial` on every non-terminal event). But the
**persisted** message is NOT the last `partial` — it is `finalMessage = await response.result()`, and `result()`
resolves to the **terminal event's `message`/`error` field** (architecture/pi-agent-core-consumer.md §1
takeaway #2 + pi-ai-event-types.md §3):

```js
// agent-loop.js (the REAL consumer):
case "done": case "error": {
  const finalMessage = await response.result(); // ← resolves to done.message / error.error
  context.messages[last] = finalMessage;
  return finalMessage;                          // ← THIS is persisted to history
}
```

`push({type:"done", message: X})` **immediately** sets `done=true` and resolves `result()` with `X`
(pi-ai-event-types.md §3). The proxy forwards the replacement's `done` with `message: replacementOutput`
(text-only, reasoning dropped). So even WITH T2.S1's merged partials on the streamed events, the PERSISTED
message is still text-only → reasoning STILL lost from history. **T2.S2 is what actually fixes persistence.**

> The merge MUST happen BEFORE the push (push resolves result() in the same call). This is the #1 ordering
> invariant for T2.S2.

## 2. Current state of `_emit()` splicing branch (post-T2.S1, verified verbatim)

`src/provider/proxy.ts` lines 638–655:

```ts
if (isTerminalEvent(event)) {
  if (this._messageEndEmitted) {
    this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
    return;                                    // ← duplicate terminal discarded BEFORE the gate (correct)
  }
  this._messageEndEmitted = true;              // ← first terminal: set flag, fall through
}
// P1.M2.T2.S1 — Issue 1 fix: rewrite NON-TERMINAL replacement events ...
if (this._contentIndexOffset > 0 && "contentIndex" in event) {
  event = this._rewriteReplacementEvent(event);  // ← line 652 — NON-terminal gate (skips terminals: no contentIndex)
}
// text_start/delta/end + toolcall_* (and the first terminal) → forward.
this._output.push(event);                       // ← line 655 — THE single forward point (push resolves result())
```

The T2.S2 gate goes **between line 653 (T2.S1 gate close) and line 655 (the push)**, AFTER the
`_messageEndEmitted` flag is set (correct: dedup logic runs first) and BEFORE the push (CRITICAL: push resolves
`result()`). T2.S1's non-terminal gate is UNCHANGED (it skips terminals via `"contentIndex" in event`).

## 3. The terminal types + the tsc narrowing (verified against node_modules/@earendil-works/pi-ai/dist/types.d.ts)

```ts
// pi-ai AssistantMessageEvent terminal members (types.d.ts lines 294–302):
| { type: "done";   reason: Extract<StopReason,"stop"|"length"|"toolUse">; message: AssistantMessage }
| { type: "error";  reason: Extract<StopReason,"aborted"|"error">;         error:   AssistantMessage }
```

- `done` carries `message` (NOT `partial`, NOT `contentIndex`). `error` carries `error`.
- `TerminalEvent` is ALREADY exported from `src/types.ts` (line 94:
  `export type TerminalEvent = Extract<AssistantMessageEvent, { type: TerminalEventType }>;`).
- `isTerminalEvent(event)` is `event is TerminalEvent` (types.ts line 174) → narrows at the call site.
- **`TerminalEvent` is NOT currently imported in proxy.ts.** Line 63 is
  `import type { AssistantMessageEvent, TransitionState, ProxyPhase } from "../types";` → **ADD `TerminalEvent`**.

### tsc-safe method form (narrow inside with `event.type === "done"`)

The `done`/`error` members are mutually exclusive (`message` vs `error`). Inside a method typed
`(event: TerminalEvent): TerminalEvent`, narrow with the discriminant `event.type`:

```ts
private _rewriteReplacementTerminal(event: TerminalEvent): TerminalEvent {
  if (event.type === "done") {
    return { ...event, message: this._mergePartial(event.message) }; // event.message: AssistantMessage
  }
  // event is narrowed to the "error" member here
  return { ...event, error: this._mergePartial(event.error) };
}
```

`event.message` / `event.error` are `AssistantMessage` → `_mergePartial(AssistantMessage | undefined)` accepts
them directly (no cast needed). The spread `{ ...event, message/error: <merged> }` produces a valid `TerminalEvent`
(discriminant `type` preserved). NO bare `as` needed (the discriminant narrowing is exhaustive); an optional
`as TerminalEvent` is harmless but unnecessary. Verified: this is the SAME narrowing idiom T2.S1 used internally
(via `in`), applied here via the `type` discriminant.

## 4. `_mergePartial` reuse (no new merge logic — T2.S1 ships it, lines 932–940)

```ts
private _mergePartial(replacementPartial: AssistantMessage | undefined): AssistantMessage {
  return { ...replacementPartial,
    content: [ ...this._frozenPrimaryContent.map((b) => ({ ...b })),  // CLONED frozen primary blocks
               ...(replacementPartial?.content ?? []) ] } as AssistantMessage; // + replacement's own blocks
}
```

For the terminal: `_mergePartial(event.message)` where `event.message.content` = the replacement's answer blocks
(e.g. `[{type:"text", text:"Here answer"}]`). Merged content = `[...frozenThinking, ...answer]` =
`[{type:"thinking",thinking:"Let me"}, {type:"text",…}]`. This is EXACTLY the contract spec.

## 5. The gate + guard (the offset-0 no-op preserves existing error-path tests)

```ts
// between T2.S1's gate and the push:
if (this._contentIndexOffset > 0 && isTerminalEvent(event)) {
  event = this._rewriteReplacementTerminal(event);
}
```

- `this._contentIndexOffset > 0` — **the no-op guard** (identical to T2.S1's first condition). When offset is 0
  (every existing placeholder-mock error-path test — their primary events carry NO partial → T1.S1 yields frozen
  `[]` + offset 0), the gate is FALSE → terminal forwarded UNCHANGED → existing tests stay green.
- `isTerminalEvent(event)` — **the terminal selector**. The first terminal reaches here; duplicates already
  `return`ed above. Terminals carry NO `contentIndex`, so they correctly SKIP T2.S1's contentIndex-offset gate
  (the `in` check is false) but DO need the message/error content merge — T2.S2's gate supplies it.

### GOTCHA (synthesized error terminals also flow through here): when the replacement THROWS or ends without a
terminal, `_launchReplacement` synthesizes `{type:"error", error: makeErrorAssistantMessage(...)}` (content `[]`)
and calls `_emit` with it (proxy.ts lines ~866–870, ~889–893). With offset > 0, T2.S2's gate merges the frozen
reasoning into that synthesized error too → persisted error message becomes `[thinking]`. This is INTENTIONAL and
CORRECT (preserves the reasoning the user watched even on replacement failure) and CONSISTENT with the done case.
The contract explicitly specifies the error merge. Existing error-path tests use offset-0 placeholder mocks
(unchanged); verify with the full suite that no realistic-mock (offset>0) error test asserts an empty-content
synthesized error (none found in audit — all offset>0 tests use the done path).

## 6. The realistic mock terminal surface (shipped P1.M1.T1.S2 — consume, do NOT modify)

`tests/helpers/realistic-mock.ts` `applySpec` (lines 164–172):
- `pushReplacement({ type: "done" })` → `{ type:"done", reason: output.stopReason, message: replacementOutput }`
  (`message` = the replacement's LIVE `replacementOutput`; content = `[{type:"text", text:"Here answer"}]`).
- `pushReplacement({ type: "error", reason? })` → sets `output.stopReason="error"`, returns
  `{ type:"error", reason, error: replacementOutput }` (`error` = the same live output).

So after a primary `[start, thinking_start, thinking_delta('Let'), thinking_delta(' me')]` + abort + replacement
`[text_start, text_delta('Here'), text_delta(' answer'), text_end, done]`:
- offset = 1; frozen = `[{type:"thinking", thinking:"Let me"}]`.
- replacement `done.message` (pre-rewrite) = `replacementOutput` = `{role:"assistant", content:[{type:"text",text:"Here answer"}], …}`.
- T2.S2 rewrite → `done.message` = `_mergePartial(replacementOutput)` =
  `{role:"assistant", content:[{type:"thinking",thinking:"Let me"},{type:"text",text:"Here answer"}], …}`.
- `consumeLikeAgentLoop` → `finalMessage = stream.result()` = the REWRITTEN done.message →
  `finalMessage.content` block types === `["thinking","text"]`, `content[0].thinking === "Let me"`. ✅ contract met.

## 7. consumeLikeAgentLoop (shipped P1.M1.T1.S1 — tests/helpers/consumer-harness.ts — consume, do NOT modify)

```ts
export async function consumeLikeAgentLoop(stream): Promise<{ finalMessage, events, partialHistory }> {
  for await (const event of stream) { events.push(event); if (event.type !== "done" && event.type !== "error") partialHistory.push({...event.partial}); }
  const finalMessage = await Promise.race([stream.result(), <5s timeout>]); // ← resolves to terminal message
  return { finalMessage, events, partialHistory };
}
```

- `finalMessage` = `stream.result()` = the terminal's `message`/`error`. **THIS is what T2.S2's gate rewrites.**
- It iterates the FULL stream (primary + replacement events) then awaits `result()`. The realistic mock's
  iterator re-checks its queue on a `setTimeout(0)` tick, so push-then-consume is deterministic (the MAIN T2.S1
  test, which uses the realistic mock, passes reliably in the FULL suite — verified 2 consecutive full runs).

## 8. PRE-EXISTING BASELINE STATE (IMPORTANT — read before asserting "0 fail")

Current baseline (verified, deterministic across 2 full-suite runs): **387 pass / 1 fail / 388 total**.
The 1 failure is **T2.S1's placeholder-mock guard test** (`offset-0 (placeholder partials) forwards replacement
events UNCHANGED`) — it passes in ISOLATION but fails in the FULL suite because the placeholder mock
(`makeScriptedTwoPhaseUpstream`) yields its queue synchronously, racing the drain (the replacement `text_delta`
is not yet forwarded when `done` completes the stream under full-suite timing). The realistic-mock MAIN T2.S1
test passes reliably. **This failure is UNRELATED to T2.S2** (it is a T2.S1 test-isolation bug — out of scope for
T2.S2; do NOT touch tests/stream-proxy-rewrite.test.ts). 

**T2.S2 success gate**: the new terminal test passes (in isolation AND full suite), and T2.S2 introduces **0 NEW
failures** (i.e. still exactly the 1 pre-existing T2.S1 guard failure, +1 new passing test → 388 pass / 1 fail /
389 total). Use the REALISTIC mock (not the placeholder) for T2.S2's test to inherit the reliable timing.

## 9. Scope discipline (cohesion — do NOT harm sibling work items)

- T2.S2 rewrites the replacement TERMINAL ONLY (done.message / error.error). It REUSES T2.S1's `_mergePartial`
  (no new merge primitive) and T1.S1's seed fields (no new state). It does NOT touch T2.S1's non-terminal gate or
  method, run(), _launchReplacement, trackEvent, makeErrorAssistantMessage, types.ts logic, or any helper.
- T2.S2 does NOT add the comprehensive end-to-end integration test — that is **P1.M2.T3.S1** (which will also use
  consumeLikeAgentLoop but as a full multi-scenario suite). T2.S2's test is a FOCUSED terminal-merge assertion
  (finalMessage.content block types === ["thinking","text"]).
- `git diff --stat -- src/` must show ONLY `src/provider/proxy.ts` (1 gate + 1 method + 1 type import).
