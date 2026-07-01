# PRP — P1.M2.T2.S2: Rewrite replacement TERMINAL event (merge done message / error content)

> **Bugfix**: Stream Integrity & Shortcut Lifecycle — Issue 1 (CRITICAL): reasoning content is lost from the
> persisted assistant message on every interruption. This is **Task 2 Step 2** of the Issue-1 fix (Module P1.M2).
> It is the **terminal replacement-event rewrite** half: it REUSES the `_mergePartial` shipped by the COMPLETED
> predecessor P1.M2.T2.S1 and, in `_emit()`'s splicing branch, rewrites the replacement's **terminal** event
> (`done.message` / `error.error`) to merge the frozen primary reasoning so `output.result()` — what the
> downstream consumer (`pi-agent-core` agent-loop.js) **PERSISTS** to conversation history — resolves to the
> unified `[thinking, ...answer]` message instead of the replacement's text-only output.
>
> **Why this is a SEPARATE concern from T2.S1**: T2.S1 fixed the STREAMING view (`partialMessage = event.partial`
> on every non-terminal event). But the PERSISTED message is NOT the last `partial` — it is
> `finalMessage = await response.result()`, which resolves to the terminal event's `message`/`error` field
> (architecture/pi-agent-core-consumer.md §1 takeaway #2). `push({type:"done", message: X})` IMMEDIATELY resolves
> `result()` with `X` (pi-ai-event-types.md §3). The proxy forwards the replacement's `done` with
> `message: replacementOutput` (text-only) → even WITH T2.S1's merged streamed partials, the persisted message is
> STILL text-only → reasoning STILL lost from history. **T2.S2 is what actually fixes persistence.**
>
> **What this subtask is NOT**: it does NOT rewrite non-terminal events (T2.S1 owns those — its gate already
> skips terminals via `"contentIndex" in event`). It does NOT add the comprehensive end-to-end integration test
> suite (that is **P1.M2.T3.S1**). It does NOT change the merge primitive (`_mergePartial`) or add new state
> (T2.S1/T1.S1 own those). It changes the **terminal** event ONLY; the new test asserts on the persisted
> `finalMessage` via `consumeLikeAgentLoop`.
>
> **Chokepoint**: `src/provider/proxy.ts` `_emit()` splicing branch — the SINGLE unified forwarding filter. The
> final `this._output.push(event)` (line ~655) is the ONE point every forwarded replacement event passes through,
> and `push(terminal)` resolves `result()` in the SAME call. The terminal-rewrite gate goes immediately BEFORE
> that push (after T2.S1's non-terminal gate), so the merge runs before `result()` is resolved.

---

## Goal

**Feature Goal**: In `src/provider/proxy.ts` `_emit()`'s splicing branch (`_authority === "splicing"`), rewrite
the forwarded replacement **terminal** event (`done`/`error`) so its `message`/`error` field is a merged
`AssistantMessage` produced by reusing T2.S1's `_mergePartial(replacementMessage)` — which prepends the frozen
primary reasoning blocks (`_frozenPrimaryContent`, cloned) before the replacement's own answer blocks. Because
`push(terminal)` IMMEDIATELY resolves `output.result()` with that `message`/`error` field, this rewrite MUST
happen before the push. The result: the real downstream consumer's
`finalMessage = await response.result()` resolves to a unified `[thinking, ...answer]` message (the persisted
assistant message), preserving the reasoning the user watched stream in (Issue 1 root cause: the proxy currently
forwards the replacement's text-only `done.message` verbatim, so `result()` resolves to text-only → reasoning is
lost from conversation history even after T2.S1 fixed the streamed partials).

**Deliverable**:
- `src/provider/proxy.ts` — MODIFIED: (1) one terminal-rewrite gate inserted in `_emit()`'s splicing branch
  immediately before the final `this._output.push(event)` (and immediately after T2.S1's non-terminal gate), and
  (2) one new private method `_rewriteReplacementTerminal()`, plus (3) adding `TerminalEvent` to the existing
  `import type { ... } from "../types"` line (it is exported but not yet imported). REUSES `_mergePartial` (T2.S1)
  and reads `_contentIndexOffset`/`_frozenPrimaryContent` (T1.S1) — NO new fields, NO new merge logic, NO changes
  to `run()`, `_launchReplacement`, `trackEvent`, `makeErrorAssistantMessage`, T2.S1's `_rewriteReplacementEvent`,
  the controller, the buffer, types.ts logic, or any helper/test helper.
- `tests/stream-proxy-terminal-rewrite.test.ts` — NEW: a `bun:test` that builds the `StreamProxy` with the
  realistic two-call mock (`makeRealisticTwoPhaseMock`), drives a primary reasoning stream, triggers `stop`
  mid-reasoning, drives the replacement answer + `done`, consumes the proxy output through `consumeLikeAgentLoop`,
  and asserts the persisted `finalMessage.content` block types are exactly `["thinking","text"]` and the thinking
  block text matches the primary reasoning (`"Let me"`). Proves the persistence fix end-to-end through the
  faithful consumer (the existing suite's blind spot — architecture/pi-agent-core-consumer.md §4).

**Success Definition**:
- `npm run build` (`tsc`) passes with **zero diagnostics** — this is a real gate (src/ change). The new
  `_rewriteReplacementTerminal` MUST take a `TerminalEvent` param (narrowed via `isTerminalEvent` at the call site)
  and narrow `event.message`/`event.error` via the `event.type === "done"` discriminant INSIDE (see Context
  §Known Gotchas) or the build fails. `TerminalEvent` MUST be imported from `"../types"`.
- The new terminal test passes BOTH in isolation AND in the full suite (uses the realistic mock + consumeLikeAgentLoop — the reliable timing pattern, NOT the flaky placeholder mock).
- T2.S2 introduces **0 NEW failures**. Pre-existing baseline = 387 pass / 1 fail / 388 total (the 1 failure is
  T2.S1's placeholder-mock guard test, a test-isolation timing bug UNRELATED to T2.S2 — do NOT touch it). After
  T2.S2: 388 pass / 1 fail / 389 total (the +1 is your new test). See Validation Loop §"Pre-existing baseline".
- The new terminal test asserts `result.finalMessage.content.map(b => b.type)` deep-equals `["thinking","text"]`
  and `finalMessage.content[0]` matches `{ type:"thinking", thinking:"Let me" }`.
- `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts` changed; `git status` shows that file + the new
  test only.

---

## Why

- **Issue 1 root cause (the PERSISTENCE half — architecture/pi-agent-core-consumer.md §1 takeaway #2 +
  pi-ai-event-types.md §3)**: the proxy forwards the replacement's `done` event VERBATIM. The replacement's
  `done.message` is its FRESH live `replacementOutput` whose `content` is text-only (reasoning was disabled for
  the replacement). The real consumer does `finalMessage = await response.result()`, and `result()` resolves to
  the `done` event's `message` field. So `result()` resolves to text-only → **the persisted assistant message is
  `content: [{type:"text",…}]` only — the reasoning is gone from history**, even though T2.S1 already merged it
  into the streamed `partial`s. T2.S2 is the fix: rewrite the terminal's `message`/`error` to merge the frozen
  primary reasoning BEFORE the push resolves `result()`, so the persisted message is `[thinking, text]` — matching
  a normal uninterrupted z.ai response (PRD Story 3 / G4 / §13.4 / §14.2 / §19.7 / ADR-005 observational
  equivalence).
- **`push(terminal)` resolves `result()` synchronously in the same call** (pi-ai-event-types.md §3): the merge is
  USELESS if applied AFTER the push — `result()` would already be locked to the unmerged message. This is the #1
  ordering invariant: **gate before push, not after.**
- **REUSES T2.S1's `_mergePartial` — no new logic**: the terminal merge is the SAME primitive as the non-terminal
  partial merge (`{...msg, content:[...frozen(cloned), ...msg.content]}`). T2.S1 shipped `_mergePartial` exactly
  for this reuse; T2.S2 simply calls `_mergePartial(event.message)` / `_mergePartial(event.error)`. Cohesion with
  T2.S1 is by design.
- **The error terminal is covered too (consistency)**: if the replacement FAILS (provider error, startup timeout,
  empty return — `_launchReplacement` synthesizes `{type:"error", error: makeErrorAssistantMessage(...)}` and
  forwards it through `_emit`), the same gate merges the frozen reasoning into the error's message. This preserves
  the reasoning the user watched even when the replacement fails — and matches the contract's explicit `error`
  branch. The offset-0 guard keeps every existing offset-0 error-path test byte-for-byte unchanged.

## What

An additive change to `src/provider/proxy.ts`'s `_emit()` method (one gate) plus one private helper method, one
type import, and one new test file. In the splicing branch (`_authority === "splicing"`), immediately before the
final `this._output.push(event)` (and immediately after T2.S1's non-terminal gate), add a terminal-rewrite gate:
when the offset is non-zero and the event is a terminal (`done`/`error`), replace the event with a rewritten copy
whose `message` (done) or `error` (error) field is rebuilt via `_mergePartial` to prepend the frozen primary
content blocks (cloned). Non-terminal events are untouched (T2.S1's gate already handled them). The duplicate
terminal early-return (above the gate) is untouched (duplicates are discarded before the gate, correct).

### Success Criteria

- [ ] `src/provider/proxy.ts` `_emit()` splicing branch has the terminal-rewrite gate
      `if (this._contentIndexOffset > 0 && isTerminalEvent(event)) { event = this._rewriteReplacementTerminal(event); }`
      immediately after T2.S1's `if (this._contentIndexOffset > 0 && "contentIndex" in event)` gate and
      immediately before the final `this._output.push(event)`.
- [ ] `_rewriteReplacementTerminal(event: TerminalEvent): TerminalEvent` returns, for `done`,
      `{ ...event, message: this._mergePartial(event.message) }`, and for `error`,
      `{ ...event, error: this._mergePartial(event.error) }` — narrowed INSIDE via `event.type === "done"`
      (tsc-clean). `TerminalEvent` is imported on the existing `import type { … } from "../types"` line.
- [ ] The gate SKIPS offset-0 (placeholder mocks) → all existing offset-0 error-path tests stay green (the guard
      preserves them; verified by the full suite).
- [ ] The gate runs BEFORE the push → `output.result()` resolves to the MERGED message (the persistence fix).
- [ ] The duplicate-terminal early-return (above the gate, guarded by `_messageEndEmitted`) is UNCHANGED — only
      the FIRST terminal is forwarded + rewritten; duplicates are discarded.
- [ ] New test `tests/stream-proxy-terminal-rewrite.test.ts` passes (isolation + full suite): drives the realistic
      mock through a mid-reasoning abort + replacement answer, consumes via `consumeLikeAgentLoop`, and asserts
      `finalMessage.content` block types === `["thinking","text"]` with `content[0].thinking === "Let me"`.
- [ ] `npm run build` (tsc) green; the suite has 0 NEW failures (still exactly the 1 pre-existing T2.S1 guard
      failure); only `proxy.ts` changed in src/.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact insertion point (the single `this._output.push(event)` in `_emit()`'s splicing branch, quoted
verbatim with the T2.S1 gate directly above it), the literal contract for the one new method, the tsc-safe
discriminant-narrowing form, the missing `TerminalEvent` import, the realistic-mock `done.message` mechanics
(verified), the `consumeLikeAgentLoop` consumption idiom (copied from the shipped harness), and the validated
commands are all inlined below. The implementer needs no prior proxy/FSM/consumer knowledge beyond what is quoted.

### Documentation & References

```yaml
# MUST READ — the bug, the consumer, the exact terminal-merge + push-ordering spec
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-agent-core-consumer.md
  why: "§1 (LOCAL agent-loop.js) takeaway #2: finalMessage = response.result() = the terminal's message/error
        field — THIS is what gets persisted. The proxy forwards the replacement's done.message (text-only)
        verbatim, so result() resolves to text-only → reasoning lost from history even with T2.S1's merged
        partials. §4 explains why the existing 380+ tests miss this (they assert raw events, never call result())."
  critical: "§1 takeaway #2 is the SOURCE of the persistence bug and the REASON the terminal (not the partial) is
             the fix target. §3 documents push(done) sets done=true + resolves result() in the same call."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-ai-event-types.md
  why: "§1: done carries message (NOT partial, NOT contentIndex); error carries error. §2: AssistantMessage merge
        spec = {...msg, content:[...frozen, ...msg.content]}. §3: push(terminal) IMMEDIATELY resolves result()
        with event.message/event.error — the merge MUST be BEFORE the push (the #1 ordering invariant)."
  critical: "§3 is WHY the gate goes before the push, not after. §1 is the SOURCE of the tsc gotcha: terminals
             carry message/error (NOT partial/contentIndex), so the method narrows via the `type` discriminant,
             NOT the `in` operator T2.S1 used."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/system_context.md
  why: "§Issue 1 root cause: verbatim forwarding + fresh replacement partial = reasoning lost. Confirms the
        two-consumer failure (LOCAL result() + REMOTE contentIndex) and that BOTH the partial (T2.S1) and the
        terminal message (T2.S2) must be rewritten."
  critical: "Establishes WHY both T2.S1 (non-terminal) and T2.S2 (terminal) are required — two halves of one fix."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/P1M2T2S2/research/notes.md
  why: "Verbatim insertion-point code block (splicing branch lines 638–655, post-T2.S1); the exact gate placement
        (between T2.S1's gate close at line 653 and the push at line 655); the tsc-safe _rewriteReplacementTerminal
        form (discriminant narrowing); the missing TerminalEvent import; the realistic-mock done.message → merged
        [thinking,text] table; the consumeLikeAgentLoop finalMessage=result() mechanics; the pre-existing-baseline
        caveat; validated commands."
  critical: "§2 (gate placement), §3 (the tsc `type`-discriminant narrowing + the TerminalEvent import), §5
        (the synthesized-error-terminal gotcha), and §8 (the pre-existing T2.S1 guard failure) are the four things
        most likely to break one-pass success."

# PATTERN files to follow (verified verbatim against current src/)
- file: src/provider/proxy.ts
  why: "THE file being modified. _emit() splicing branch (the gate insertion point, lines 638–655). T2.S1's
        _mergePartial (lines 932–940) is the REUSED primitive — READ it, do NOT re-create. T2.S1's
        _rewriteReplacementEvent (lines 952–955) is the SIBLING pattern to follow (JSDoc + in-narrowing style).
        T1.S1's _frozenPrimaryContent/_contentIndexOffset getters (lines 311/319) are READ, not modified."
  pattern: "The private-method convention (_emit/_mergePartial/_rewriteReplacementEvent/makeErrorAssistantMessage):
            JSDoc with PRD/forward-compat cross-refs; pure transform (return a NEW event object via spread — never
            mutate the input). isTerminalEvent already imported (line 64). TerminalEvent is NOT imported yet — add it."
  gotcha: "The gate goes AFTER the duplicate-terminal discard (early-return before it), AFTER the _messageEndEmitted
           flag set (correct: dedup first), AFTER T2.S1's non-terminal gate (correct: non-terminals already handled),
           and BEFORE the final push (CRITICAL: push resolves result()). Do NOT touch T2.S1's gate/method, the
           forwarding branch, run(), _launchReplacement, trackEvent, or makeErrorAssistantMessage."

- file: src/types.ts
  why: "Exports TerminalEvent (line 94: Extract<AssistantMessageEvent, {type:TerminalEventType}>) and
        isTerminalEvent (line 174: `event is TerminalEvent`). Confirms done/error carry message/error (no
        contentIndex/partial) and that the call-site isTerminalEvent narrows the param to TerminalEvent."
  pattern: "No new types needed for T2.S2. Import the EXISTING TerminalEvent type. The `event.type === \"done\"`
            discriminant narrowing inside the method is tsc-sufficient (no new guard)."

- file: node_modules/@earendil-works/pi-ai/dist/types.d.ts
  why: "The terminal members (lines 294–302): {type:\"done\", reason, message: AssistantMessage} and
        {type:\"error\", reason, error: AssistantMessage}. Confirms message/error are mutually exclusive (narrow by
        the `type` discriminant, not `in`)."
  pattern: "Read-only reference for the exact field shapes the method spreads/overrides."

- file: tests/helpers/realistic-mock.ts   # SHIPPED in P1.M1.T1.S2 — consume, do NOT modify
  why: "makeRealisticTwoPhaseMock() → { fn, pushPrimary, pushReplacement, primaryOutput, replacementOutput, calls }.
        Replacement (call 2, reasoning OFF): FRESH replacementOutput; text block at content[0]; done stamped
        message: replacementOutput (LIVE); error stamped error: replacementOutput. pushReplacement derives
        contentIndex/partial/message itself."
  pattern: "Drop mock.fn into new StreamProxy(..., mock.fn, ...). Push specs like {type:'text_delta', delta:'Here'}
            then {type:'done'}; the mock accumulates into replacementOutput.content[0].text and stamps
            message: replacementOutput on done."
  gotcha: "The replacement's done.message is replacementOutput (content = [{type:'text',text:'Here answer'}]).
           T2.S2's _mergePartial(done.message) → content = [{thinking:'Let me'}, {text:'Here answer'}]. The mock's
           iterator re-checks its queue on a setTimeout(0) tick, so push-then-consume is deterministic (the realistic-
           mock MAIN T2.S1 test passes reliably in the FULL suite — the reliable pattern; do NOT use the placeholder
           makeScriptedTwoPhaseUpstream which has a full-suite timing race)."

- file: tests/helpers/consumer-harness.ts   # SHIPPED in P1.M1.T1.S1 — consume, do NOT modify
  why: "consumeLikeAgentLoop(stream) → { finalMessage, events, partialHistory }. It iterates the FULL stream then
        awaits stream.result() (resolves to the terminal's message/error, with a 5s timeout). finalMessage is
        EXACTLY what the consumer PERSISTS — and EXACTLY what T2.S2's gate rewrites."
  pattern: "import { consumeLikeAgentLoop } from './helpers/consumer-harness'; — do NOT re-declare. Call it on
            proxy.output AFTER driving primary + abort + replacement. Assert result.finalMessage.content."
  gotcha: "consumeLikeAgentLoop iterates the stream to completion (the done completes it) THEN calls result().
           result() returns the SAME message that push(done) locked in — so T2.S2's pre-push merge is what it sees."

- file: tests/stream-proxy-rewrite.test.ts   # read-only PATTERN (T2.S1's MAIN test — the reliable drive→reason→stop→consume flow)
  why: "The exact construction + control flow to copy: build proxy with makeRealisticTwoPhaseMock's fn, push
        start + thinking_start + thinking_delta x2, waitFor(isReasoning), triggerStop,
        waitFor(proxy.abort.completed), then drive the replacement + drain. T2.S1 drains manually; T2.S2 swaps the
        manual drain for consumeLikeAgentLoop and asserts on finalMessage instead of raw events."
  pattern: "Copy its imports (minus makeScriptedTwoPhaseUpstream/ev — T2.S2 uses the realistic mock ONLY),
            construction (with the 15ms orphan-safe replacementStartupTimeoutMs), and the
            drive→waitFor(isReasoning)→triggerStop→waitFor(abort.completed) timing. Then ADD: pushReplacement text
            events + done + `const result = await consumeLikeAgentLoop(proxy.output)` + assert finalMessage."
  gotcha: "Do NOT copy T2.S1's placeholder-mock GUARD test (it has a full-suite timing race — see Pre-existing
           baseline). T2.S2's test uses the realistic mock (reliable) and does NOT need a placeholder guard test:
           the offset-0 no-op is covered by the existing error-path suite + a lightweight inline assertion."
```

### Current Codebase tree (relevant slice)

```bash
src/provider/
└── proxy.ts                          # ← MODIFY: 1 terminal gate in _emit() + 1 new private method + 1 type import
tests/
├── helpers/
│   ├── realistic-mock.ts             # consume makeRealisticTwoPhaseMock (shipped P1.M1.T1.S2 — do NOT modify)
│   ├── consumer-harness.ts           # consume consumeLikeAgentLoop (shipped P1.M1.T1.S1 — do NOT modify)
│   └── invariant-harness.ts          # import makeCaptureDiag / makeModel / waitFor
├── stream-proxy-rewrite.test.ts      # read-only PATTERN (T2.S1's MAIN test control flow) — do NOT modify
└── (stream-proxy-terminal-rewrite.test.ts)  # ← NEW (this subtask)
```

### Desired Codebase tree with file responsibilities

```bash
src/provider/proxy.ts                 # MODIFIED — terminal-rewrite gate + _rewriteReplacementTerminal + TerminalEvent import.
                                      #   Responsibilities: make the forwarded replacement terminal carry a merged
                                      #   message/error so output.result() (the persisted message) keeps the reasoning.
tests/stream-proxy-terminal-rewrite.test.ts  # NEW — drives the proxy with the realistic mock through a mid-reasoning
                                      #   abort + replacement answer + done; consumes via consumeLikeAgentLoop and
                                      #   asserts the persisted finalMessage.content === [thinking, text].
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (ordering invariant — the #1 trap): push({type:"done", message: X}) IMMEDIATELY sets done=true AND
// resolves output.result() with X IN THE SAME CALL (pi-ai-event-types.md §3). So the merge is USELESS if applied
// after the push — result() would already be locked to the unmerged message. The gate MUST go BEFORE the final
// this._output.push(event) in the splicing branch (line ~655), never after. (The _messageEndEmitted flag is set
// ABOVE the gate in the duplicate-terminal block — that is fine; flag-setting does not resolve result().)

// CRITICAL (tsc gate — the #2 trap): done carries `message` and error carries `error` (mutually exclusive), NOT
// `partial`/`contentIndex`. T2.S1 narrowed contentIndex/partial with the `in` operator; that does NOT apply here.
// If _rewriteReplacementTerminal's param is typed AssistantMessageEvent (the broad union), `event.message` and
// `event.error` are tsc ERRORS ("Property does not exist on type …") → `npm run build` (tsc) FAILS. FIX:
//   (1) type the param TerminalEvent (narrowed at the call site by the `isTerminalEvent(event)` gate), and
//   (2) narrow INSIDE with the `type` discriminant: `if (event.type === "done") { …event.message… } else { …event.error… }`.
// `event.message`/`event.error` are then AssistantMessage → _mergePartial(AssistantMessage|undefined) accepts them
// directly. Verified: isTerminalEvent is already imported (line 64). TerminalEvent is NOT imported yet — ADD it.

// CRITICAL (the missing import — the #3 trap): TerminalEvent IS exported from src/types.ts (line 94) but is NOT
// in proxy.ts's import list. Line 63 is `import type { AssistantMessageEvent, TransitionState, ProxyPhase } from
// "../types";` → change to `import type { AssistantMessageEvent, TransitionState, ProxyPhase, TerminalEvent } from
// "../types";`. Without this, the method's `event: TerminalEvent` param is an unknown-name tsc error.

// CRITICAL (gate placement — the #4 trap): the gate goes IMMEDIATELY AFTER T2.S1's non-terminal gate
// (`if (this._contentIndexOffset > 0 && "contentIndex" in event) { … }`, line ~651) and IMMEDIATELY BEFORE the
// final push (line ~655). It does NOT replace or merge into T2.S1's gate — keep them as two separate, clearly-
// commented gates (cohesion: T2.S1 owns non-terminals, T2.S2 owns terminals). Do NOT move the push, the duplicate-
// terminal discard, or the _messageEndEmitted flag logic.

// CRITICAL (the offset-0 no-op guard — the #5 trap, keeps the error-path suite green): the gate's first condition
// is `this._contentIndexOffset > 0` (IDENTICAL to T2.S1's first condition). When offset is 0 (every existing
// placeholder-mock error-path test — primary events carry NO partial → T1.S1 yields frozen [] + offset 0), the
// gate is FALSE → terminal forwarded UNCHANGED → existing error-path tests stay green. Do NOT drop the `> 0`
// check. Do NOT default _contentIndexOffset to anything but 0 (T1.S1 owns it; 0 until a realistic primary partial
// is captured). The contract explicitly requires this: "no-op when offset is 0 (preserves existing error-path tests)."

// GOTCHA (synthesized error terminals ALSO hit this gate): when the replacement THROWS or ends without a terminal,
// _launchReplacement synthesizes {type:"error", error: makeErrorAssistantMessage(...)} (content []) and forwards
// it through _emit (proxy.ts lines ~866–870, ~889–893). With offset > 0, T2.S2's gate merges the frozen reasoning
// into that synthesized error too → the persisted error message becomes [thinking]. This is INTENTIONAL + CORRECT
// (preserves the reasoning even on replacement failure) and CONSISTENT with the done case — the contract specifies
// the error branch. Existing offset-0 error tests are unaffected (offset 0 → no-op). If a full-suite run shows a
// NEW failure on a realistic-mock (offset>0) error scenario asserting an empty-content synthesized error, that
// assertion needs updating (none found in audit — all offset>0 tests use the done path).

// GOTCHA (only the FIRST terminal is rewritten): the duplicate-terminal early-return (`if (this._messageEndEmitted)
// { trace; return; }`) sits ABOVE the gate. So the FIRST terminal sets the flag + falls through to the gate
// (rewritten); any DUPLICATE terminal returns before the gate (discarded). This is correct — exactly one terminal
// reaches the consumer (INV-003). Do NOT change the dedup logic.

// GOTCHA (consumeLikeAgentLoop iterates THEN calls result()): it does `for await (const event of stream) {...}`
// (which completes when the done is forwarded) then `await stream.result()`. result() returns the message that
// push(done) locked in — i.e. the T2.S2-merged message. So driving the replacement + done, THEN awaiting
// consumeLikeAgentLoop(proxy.output), yields finalMessage = the merged [thinking, text]. Push ALL replacement
// events (including done) BEFORE awaiting consumeLikeAgentLoop (the realistic mock's setTimeout(0) queue tick makes
// this deterministic; verified the T2.S1 realistic-mock MAIN test passes reliably in the full suite).

// GOTCHA (bun is not on PATH): run tests via `./node_modules/.bin/bun test ...` or `npm test`. `npm run build`
// runs `tsc` (the src/ type gate). See Validation Loop §"Pre-existing baseline" for the 1 known unrelated failure.

// GOTCHA (use the REALISTIC mock, NOT the placeholder): T2.S1's placeholder-mock (makeScriptedTwoPhaseUpstream)
// guard test has a full-suite timing race (the replacement text_delta isn't forwarded before done completes the
// stream). T2.S2's test uses makeRealisticTwoPhaseMock (reliable timing). Do NOT add a placeholder-mock guard
// test for T2.S2 — the offset-0 no-op is covered by the existing error-path suite; if desired, add a lightweight
// inline assertion in the realistic-mock test (e.g. assert finalMessage.text includes the answer).

// SCOPE: do NOT modify T2.S1's _rewriteReplacementEvent/_mergePartial (reuse them), the non-terminal gate, run(),
// _launchReplacement, trackEvent, makeErrorAssistantMessage, _frozenPrimaryContent/_contentIndexOffset (T1.S1 owns
// them), types.ts logic, or any helper. Do NOT add the comprehensive end-to-end suite (P1.M2.T3.S1). git diff
// --stat -- src/ shows ONLY proxy.ts. Do NOT modify tests/stream-proxy-rewrite.test.ts (T2.S1's file — its guard
// failure is out of scope).
```

---

## Implementation Blueprint

### Data models and structure

No new types, no new fields. `TerminalEvent` is the EXISTING exported type (`src/types.ts` line 94). The one new
private method reuses T2.S1's `_mergePartial` and operates on the existing `TerminalEvent` / `AssistantMessage`.

```typescript
// (new private method on StreamProxy — pure transform: returns a NEW event object, never mutates the input)
private _rewriteReplacementTerminal(event: TerminalEvent): TerminalEvent
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — add the TerminalEvent import
  - EDIT line 63: `import type { AssistantMessageEvent, TransitionState, ProxyPhase } from "../types";` → add
    `TerminalEvent` to the named-import list.
  - CRITICAL: without this, the new method's `event: TerminalEvent` param is an unknown-name tsc error → build fails.
  - VERIFY: TerminalEvent is exported from src/types.ts line 94 (already confirmed). isTerminalEvent (line 174) is
    the narrowing guard already imported on line 64.

Task 2: MODIFY src/provider/proxy.ts — add _rewriteReplacementTerminal() private method
  - IMPLEMENT:
        private _rewriteReplacementTerminal(event: TerminalEvent): TerminalEvent {
          if (event.type === "done") {
            return { ...event, message: this._mergePartial(event.message) };
          }
          // event is narrowed to the "error" member here
          return { ...event, error: this._mergePartial(event.error) };
        }
  - FOLLOW pattern: the existing private-method JSDoc convention (_emit/_mergePartial/_rewriteReplacementEvent/
    makeErrorAssistantMessage) — JSDoc with PRD/forward-compat cross-refs (reference Issue 1, the persistence root
    cause = result() resolves to the terminal message, T2.S1's _mergePartial reuse, T1.S1 seed data,
    pi-ai-event-types.md §3 push-resolves-result() ordering, P1.M2.T3.S1 end-to-end consumer).
  - NAMING: _rewriteReplacementTerminal (matches the work-item contract's "splicing terminal path").
  - CRITICAL (tsc): the `event.type === "done"` discriminant narrows `event.message` (AssistantMessage) in the
    `done` branch and `event.error` in the else branch. event.message/event.error are AssistantMessage →
    _mergePartial(AssistantMessage | undefined) accepts them. NO bare `as` needed (the discriminant is exhaustive);
    an optional `as TerminalEvent` is harmless but unnecessary. The param MUST be TerminalEvent (narrowed at the
    call site by isTerminalEvent) — NOT the broad AssistantMessageEvent (that would tsc-error on .message/.error).
  - CRITICAL (purity): return NEW objects via spread — NEVER mutate the input event/event.message/event.error.
  - CRITICAL (reuse): call this._mergePartial (T2.S1 ships it, lines 932–940) — do NOT inline a new merge. This
    guarantees the terminal merge is byte-identical to the non-terminal partial merge (cohesion with T2.S1).
  - PLACEMENT: among the other private methods — place immediately AFTER T2.S1's _rewriteReplacementEvent (lines
    952–955) so the two rewrite methods sit together.
  - DEPENDENCIES: Task 1 (TerminalEvent import) + reads this._mergePartial (T2.S1) + this._frozenPrimaryContent/
    this._contentIndexOffset (T1.S1, transitively via _mergePartial).

Task 3: MODIFY src/provider/proxy.ts — insert the terminal-rewrite gate in _emit()'s splicing branch
  - EDIT _emit()'s splicing branch: immediately AFTER T2.S1's gate
    (`if (this._contentIndexOffset > 0 && "contentIndex" in event) { event = this._rewriteReplacementEvent(event); }`,
    line ~653) and immediately BEFORE the final `this._output.push(event);` (line ~655), add:
        // P1.M2.T2.S2 — Issue 1 fix: rewrite the replacement TERMINAL (done.message / error.error) to merge the
        // frozen primary reasoning, so output.result() — what the consumer PERSISTS (agent-loop.js
        // finalMessage = response.result() = done.message) — resolves to the unified [thinking, ...] message
        // instead of the replacement's text-only output. push(terminal) IMMEDIATELY resolves result() with
        // event.message/event.error (pi-ai-event-types.md §3), so this MUST run BEFORE the push below. Same
        // offset>0 guard as T2.S1 → no-op when offset is 0 (preserves the existing offset-0 error-path suite).
        // Terminals carry NO contentIndex (they skip T2.S1's contentIndex-offset gate above) but still need the
        // message/error content merge so the PERSISTED message keeps the reasoning. Only the FIRST terminal reaches
        // here (duplicates early-return above). REUSES _mergePartial (T2.S1) — no new merge logic.
        if (this._contentIndexOffset > 0 && isTerminalEvent(event)) {
          event = this._rewriteReplacementTerminal(event);
        }
  - CRITICAL: this is the ONLY insertion in _emit() for T2.S2. The gate sits AFTER T2.S1's non-terminal gate (so
    non-terminals are NOT re-processed), AFTER the duplicate-terminal discard + _messageEndEmitted flag set (so
    only the first terminal is rewritten), and BEFORE the push (so the merge precedes result() resolution). Do NOT
    move any existing line; do NOT merge into T2.S1's gate; do NOT add a second push.
  - PRESERVE: T2.S1's non-terminal gate + _rewriteReplacementEvent, the forwarding branch, the start-suppression,
    the EC-017 reasoning-forwarded trace, the duplicate-terminal trace, the _messageEndEmitted flag logic, and the
    final push. Do NOT touch the FM-013 malformed guard or the discard-after-completion stray guard at the top.

Task 4: CREATE tests/stream-proxy-terminal-rewrite.test.ts — the terminal-merge test (TDD; drives the real proxy + the real consumer)
  - IMPLEMENT: a bun:test that builds StreamProxy with makeRealisticTwoPhaseMock's fn, drives a primary reasoning
    stream, triggers abort mid-reasoning, drives replacement text events + done, consumes proxy.output through
    consumeLikeAgentLoop, and asserts result.finalMessage.content block types === ["thinking","text"] and
    content[0].thinking === "Let me" (the primary reasoning). This is the PERSISTENCE proof — the existing suite's
    blind spot (it never calls result()).
  - FOLLOW pattern: tests/stream-proxy-rewrite.test.ts (T2.S1's MAIN test — construction + the
    drive→waitFor(isReasoning)→triggerStop→waitFor(abort.completed) timing). Import the test doubles from
    tests/helpers/invariant-harness.ts (makeCaptureDiag, makeModel, waitFor) and consumeLikeAgentLoop from
    tests/helpers/consumer-harness.ts.
  - IMPORTS:
      import { describe, test, expect } from "bun:test";
      import { StreamProxy } from "../src/provider/proxy";
      import { TransitionController } from "../src/state/controller";
      import { ReasoningBuffer } from "../src/buffer";
      import { DEFAULT_CONFIG } from "../src/config";
      import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
      import { consumeLikeAgentLoop } from "./helpers/consumer-harness";
      import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";
  - SCENARIO (the MAIN test — proves the terminal merge / persistence fix):
      a. const { diag, events } = makeCaptureDiag();
         const controller = new TransitionController(diag);
         const buffer = new ReasoningBuffer(diag, 1_000_000);
         const mock = makeRealisticTwoPhaseMock();
         const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
           DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15);
      b. Drive PRIMARY (reasoning ON, realistic partials → primaryOutput.content grows to [{thinking:'Let me'}]):
         mock.pushPrimary({ type: "start" });
         mock.pushPrimary({ type: "thinking_start" });
         mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
         mock.pushPrimary({ type: "thinking_delta", delta: " me" });
         await waitFor(() => proxy.isReasoning());   // run() processed the thinking events → offset will be 1
      c. Abort mid-reasoning: expect(proxy.triggerStop()).toBe(true);
         await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot → offset 1
      d. Drive REPLACEMENT (reasoning OFF, text block at content[0]; done.message = replacementOutput):
         mock.pushReplacement({ type: "text_start" });
         mock.pushReplacement({ type: "text_delta", delta: "Here" });
         mock.pushReplacement({ type: "text_delta", delta: " answer" });
         mock.pushReplacement({ type: "text_end" });
         mock.pushReplacement({ type: "done" });        // ← message: replacementOutput (content = [{text:'Here answer'}])
      e. Consume through the FAITHFUL consumer (the persistence path):
         const result = await consumeLikeAgentLoop(proxy.output);  // result() resolves to the rewritten done.message
      f. ASSERT the persistence fix:
         // finalMessage.content block types === [thinking, text] — the reasoning is PRESERVED in the persisted msg.
         expect(result.finalMessage.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text"]);
         // the thinking block text matches the PRIMARY reasoning that streamed before the interrupt.
         expect(result.finalMessage.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" });
         // the answer text follows it (the replacement's full answer).
         expect(result.finalMessage.content[1]).toMatchObject({ type: "text" });
         // SANITY: finalMessage is the merged object (NOT the raw replacementOutput) — it has 2 content blocks.
         expect(result.finalMessage.content.length).toBe(2);
  - NAMING: test("P1.M2.T2.S2: replacement terminal done.message is merged so result() persists [thinking, text]",
      …). Group under `describe("StreamProxy — replacement terminal rewrite (P1.M2.T2.S2)")`.
  - NO PLACEHOLDER-MOCK GUARD TEST: do NOT add a makeScriptedTwoPhaseUpstream guard test (it has a full-suite timing
    race). The offset-0 no-op is covered by the existing error-path suite (run the full suite, confirm 0 NEW failures).
    If an explicit guard assertion is desired, add it INLINE in the realistic-mock test is NOT possible (realistic
    mock always yields offset≥1); instead rely on the full-suite regression (Level 2 below).
  - COVERAGE: realistic-mock done-path persistence (finalMessage.content === [thinking, text]). Do NOT assert on the
    raw streamed partial events (T2.S1's test already does) and do NOT add the comprehensive multi-scenario
    end-to-end suite (P1.M2.T3.S1). Optional: a SECOND test pushing {type:"error"} instead of {type:"done"} and
    asserting finalMessage.content[0] is the frozen thinking block (proves the error branch + the synthesized-error
    merge). If added, it MUST use the realistic mock (reliable timing).
  - PLACEMENT: tests/stream-proxy-terminal-rewrite.test.ts.
```

### Implementation Patterns & Key Details

```typescript
// src/provider/proxy.ts — the one new method + the gate + the import (verbatim; see research notes §2–§5).

// EDIT 1 — the import (line 63): add TerminalEvent.
import type { AssistantMessageEvent, TransitionState, ProxyPhase, TerminalEvent } from "../types";

// NEW METHOD — the terminal rewrite (place immediately AFTER T2.S1's _rewriteReplacementEvent):
/**
 * P1.M2.T2.S2 — rewrite the replacement TERMINAL event (`done`/`error`) to merge the frozen primary reasoning
 * into its `message`/`error` field (Issue 1 fix — the PERSISTENCE half). The downstream consumer
 * (`pi-agent-core` agent-loop.js) persists `finalMessage = await response.result()`, which resolves to the
 * terminal's `message`/`error` field. Without this rewrite, `result()` resolves to the replacement's text-only
 * output → the reasoning the user watched is lost from conversation history (even though T2.S1 already merged it
 * into the streamed `partial`s). `push(terminal)` IMMEDIATELY resolves `result()` with `event.message`/`event.error`
 * (pi-ai-event-types.md §3), so the call-site gate runs this BEFORE the push. REUSES {@link _mergePartial} (T2.S1)
 * so the terminal merge is byte-identical to the non-terminal partial merge. Seed data is captured by P1.M2.T1.S1.
 */
private _rewriteReplacementTerminal(event: TerminalEvent): TerminalEvent {
  if (event.type === "done") {
    return { ...event, message: this._mergePartial(event.message) }; // prepend frozen reasoning to done.message
  }
  // event.type === "error" — merge the frozen reasoning into the error message (covers replacement failures too).
  return { ...event, error: this._mergePartial(event.error) };
}

// EDIT 2 — _emit() splicing branch, immediately AFTER T2.S1's non-terminal gate and BEFORE the final push:
    // ... (T2.S1's gate directly above) ...
    // if (this._contentIndexOffset > 0 && "contentIndex" in event) {
    //   event = this._rewriteReplacementEvent(event);
    // }
    // P1.M2.T2.S2 — Issue 1 fix: rewrite the replacement TERMINAL (done.message / error.error) so output.result()
    // (the consumer's PERSISTED finalMessage) resolves to the unified [thinking, ...] message. push(terminal)
    // resolves result() in the same call, so this MUST run BEFORE the push. Same offset>0 guard → no-op when
    // offset 0 (preserves the existing offset-0 error-path suite). Terminals carry NO contentIndex (they skip
    // T2.S1's contentIndex gate) but need the message/error content merge. Only the FIRST terminal reaches here.
    if (this._contentIndexOffset > 0 && isTerminalEvent(event)) {
      event = this._rewriteReplacementTerminal(event);
    }
    // text_start/delta/end + toolcall_* (and the first terminal) → forward.
    this._output.push(event);
```

```typescript
// tests/stream-proxy-terminal-rewrite.test.ts — the terminal-merge / persistence test (sketch; fill from the task list).
import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { consumeLikeAgentLoop } from "./helpers/consumer-harness";
import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";

describe("StreamProxy — replacement terminal rewrite (P1.M2.T2.S2)", () => {
  test("done.message is merged so result() persists [thinking, text] (the Issue-1 persistence fix)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeRealisticTwoPhaseMock();
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15);

    // PRIMARY (reasoning ON) → primaryOutput.content grows to [{thinking:'Let me'}].
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
    mock.pushPrimary({ type: "thinking_delta", delta: " me" });
    await waitFor(() => proxy.isReasoning());

    expect(proxy.triggerStop()).toBe(true); // abort → freeze → snapshot (offset now 1)
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));

    // REPLACEMENT (reasoning OFF) → done.message = replacementOutput (content = [{text:'Here answer'}]).
    mock.pushReplacement({ type: "text_start" });
    mock.pushReplacement({ type: "text_delta", delta: "Here" });
    mock.pushReplacement({ type: "text_delta", delta: " answer" });
    mock.pushReplacement({ type: "text_end" });
    mock.pushReplacement({ type: "done" });

    // Consume through the FAITHFUL consumer — finalMessage = stream.result() = the rewritten done.message.
    const result = await consumeLikeAgentLoop(proxy.output);

    // PERSISTENCE FIX: the persisted message has BOTH reasoning and answer (was text-only before T2.S2).
    expect(result.finalMessage.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text"]);
    expect(result.finalMessage.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" }); // primary reasoning preserved
    expect(result.finalMessage.content[1]).toMatchObject({ type: "text" });                          // replacement answer
    expect(result.finalMessage.content.length).toBe(2);
  });
});
```

### Integration Points

```yaml
PRODUCTION CODE:
  - modify file: src/provider/proxy.ts
      - edit import (line 63): add `TerminalEvent` to the named type import from "../types".
      - add private method: `_rewriteReplacementTerminal(event: TerminalEvent): TerminalEvent` (reuses _mergePartial).
      - _emit() splicing branch: insert the terminal-rewrite gate after T2.S1's non-terminal gate, before the push.
  - NOT modified: src/types.ts, src/state/*, src/buffer/*, src/request/*, src/provider/decorator.ts, src/index.ts.
    git diff --stat -- src/ shows ONLY proxy.ts. NO new fields (T1.S1 owns _frozenPrimaryContent/_contentIndexOffset);
    NO new merge logic (T2.S1 owns _mergePartial — reused, not duplicated); T2.S1's _rewriteReplacementEvent is untouched.

TEST CODE:
  - add file: tests/stream-proxy-terminal-rewrite.test.ts (1 main test; optional 1 error-branch test).
  - NOT modified: tests/stream-proxy-rewrite.test.ts (T2.S1's file — its pre-existing guard failure is out of scope),
    tests/helpers/* (consume the shipped helpers).

BUILD/CONFIG: NONE. tsconfig.json already compiles src/ (the tsc gate). No package.json changes. No new deps.

DOWNSTREAM (do NOT wire now — T2.S2's output is consumed by these):
  - P1.M2.T3.S1: the comprehensive end-to-end consumer-harness integration suite (consumeLikeAgentLoop across
    multiple scenarios) asserting the final persisted message content === [{type:'thinking',…}, {type:'text',…}]
    AFTER T2.S1 + T2.S2 are both wired. T2.S2's single test is the focused precursor.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# THE PRIMARY GATE — this is a src/ change, so tsc MUST pass. The missing TerminalEvent import AND the bare
# event.message/event.error access on the broad union each FAIL this unless fixed (see Context §Known Gotchas).
npm run build
# Expected: 0 diagnostics.
#   - If "Cannot find name 'TerminalEvent'" → you forgot Task 1 (add it to the line 63 import).
#   - If "Property 'message'/'error' does not exist on type …" → you typed the param as the broad
#     AssistantMessageEvent instead of TerminalEvent, OR you did not narrow inside with event.type === "done".

npm run typecheck   # = tsc --noEmit — equivalent gate; 0 diagnostics.

# Confirm ONLY proxy.ts changed in src/ and the new test was added:
git diff --stat -- src/            # Expected: src/provider/proxy.ts only
git status --short -- tests/       # Expected: ?? tests/stream-proxy-terminal-rewrite.test.ts (and no other changes)
```

### Level 2: Unit Tests (Component Validation)

```bash
# Run the new terminal test in isolation (uses the realistic mock — reliable timing):
npm test tests/stream-proxy-terminal-rewrite.test.ts
# Expected: 1 (or 2 with the optional error-branch test) passing. finalMessage.content block types ===
#   ["thinking","text"]; content[0].thinking === "Let me".

# Full suite — confirms the offset-0 guard kept the existing error-path suite green (0 NEW failures).
npm test
# Expected: 0 NEW failures. Pre-existing baseline = 387 pass / 1 fail / 388 total (the 1 fail is T2.S1's
#   placeholder-mock guard test — UNRELATED to T2.S2; do NOT touch it). After T2.S2: 388 pass / 1 fail / 389 total
#   (the +1 pass is your new test). If a SECOND failure appears, it is a T2.S2 regression — root-cause it:
#   most likely a realistic-mock (offset>0) error test asserting an empty-content synthesized error (update it).
```

### Level 3: Integration (the terminal merge fires in the real splicing branch + the real consumer)

```bash
# Confirm the capture/abort/rewrite suites still pass (the terminal gate is additive; offset-0 → no-op):
npm test tests/stream-proxy-capture.test.ts tests/stream-proxy-abort.test.ts tests/stream-proxy-rewrite.test.ts
# Expected: T2.S1's MAIN realistic-mock test passes (the terminal gate is additive). NOTE: T2.S1's placeholder
#   guard test fails ONLY in the full suite (pre-existing) — if you run this trio in isolation it passes; that is
#   the known timing-race, NOT a T2.S2 regression.

# Confirm the error-path / failure-mode suites still pass (offset-0 placeholders → terminal forwarded unchanged):
npm test tests/stream-proxy-failure-modes.test.ts tests/stream-proxy-replacement.test.ts tests/regression-tests.test.ts tests/stress-tests.test.ts tests/chaos-tests.test.ts
# Expected: all pass — proof contentIndexOffset stays 0 for placeholder mocks → terminal gate skipped → terminals
#   forwarded unchanged. 0 NEW failures.
```

### Level 4: Domain-Specific Validation (Terminal-Rewrite Contract Audit)

```bash
# Audit the exact terminal-rewrite mechanics are present and correct in proxy.ts:
grep -n "_rewriteReplacementTerminal"       src/provider/proxy.ts   # → method decl + gate call (≥2)
grep -n "isTerminalEvent(event))"           src/provider/proxy.ts   # → the terminal gate (the splicing-branch one is T2.S2)
grep -n "TerminalEvent"                     src/provider/proxy.ts   # → import (Task 1) + param type (≥2)
grep -n "_mergePartial(event.message)\|_mergePartial(event.error)" src/provider/proxy.ts  # → the two branches (≥2)
# Confirm the gate sits AFTER T2.S1's non-terminal gate and BEFORE the push (not inside the terminal dedup block):
grep -n "_contentIndexOffset > 0 && \"contentIndex\" in event\|_contentIndexOffset > 0 && isTerminalEvent(event)\|this._output.push(event)" src/provider/proxy.ts
#   → expect the order: T2.S1 gate  …  T2.S2 gate  …  push  (the splicing-branch push is the LAST push)

# Confirm the new test drives the REAL proxy + the REAL consumer and asserts the persisted message:
grep -n "makeRealisticTwoPhaseMock\|consumeLikeAgentLoop" tests/stream-proxy-terminal-rewrite.test.ts  # → both (≥1 each)
grep -n 'toEqual(\["thinking", "text"\])\|thinking: "Let me"' tests/stream-proxy-terminal-rewrite.test.ts  # → persistence assertion (≥1)
```

### Pre-existing baseline (IMPORTANT — read before asserting "0 fail")

The current baseline has **1 deterministic failure**: T2.S1's placeholder-mock guard test
(`StreamProxy — replacement-event rewrite (P1.M2.T1.S1) > offset-0 (placeholder partials) forwards replacement
events UNCHANGED`) passes in isolation but fails in the full suite (the placeholder mock's synchronous queue
yields race the drain — the replacement `text_delta` is not yet forwarded when `done` completes the stream under
full-suite timing). **This failure is UNRELATED to T2.S2** and is OUT OF SCOPE (it is a T2.S1 test-isolation bug;
do NOT modify `tests/stream-proxy-rewrite.test.ts`). T2.S2's success gate is: **0 NEW failures** + your new test
passes (isolation + full suite). If the implementer is also empowered to fix the T2.S1 guard flake (optional,
separate concern), the robust fix is to drain the placeholder mock's replacement events with an explicit await/
tick before the `done` — but that is NOT required by this PRP.

---

## Final Validation Checklist

### Technical Validation
- [ ] `npm run build` (tsc) → 0 diagnostics (the `TerminalEvent` import + the `type`-discriminant narrowing make this pass).
- [ ] `npm run typecheck` → 0 diagnostics.
- [ ] Full suite has 0 NEW failures (still exactly the 1 pre-existing T2.S1 placeholder-guard failure); +1 new test passing.
- [ ] `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts`; no other src/ or helper file modified.

### Feature Validation
- [ ] `proxy.ts` adds `_rewriteReplacementTerminal()` (private), named per the contract's "splicing terminal path".
- [ ] `TerminalEvent` is imported from `"../types"` on the existing type-import line.
- [ ] `_emit()` splicing branch has the terminal gate `if (this._contentIndexOffset > 0 && isTerminalEvent(event))`
      immediately AFTER T2.S1's non-terminal gate and immediately BEFORE the final `this._output.push(event)`.
- [ ] The gate runs BEFORE the push → `output.result()` resolves to the MERGED message (the persistence fix).
- [ ] The gate SKIPS offset-0 (placeholder mocks) → the existing error-path suite stays green (0 NEW failures).
- [ ] Only the FIRST terminal is rewritten (duplicates early-return above the gate); dedup logic unchanged.
- [ ] The gate REUSES `_mergePartial` (T2.S1) — no new merge logic; the terminal merge is byte-identical to the partial merge.
- [ ] Terminal test passes: `consumeLikeAgentLoop` → `finalMessage.content` block types === `["thinking","text"]`,
      `content[0].thinking === "Let me"`, in BOTH isolation and the full suite.

### Code Quality & Documentation
- [ ] New method follows the existing private-method JSDoc convention (_emit/_mergePartial/_rewriteReplacementEvent/
      makeErrorAssistantMessage) with PRD/forward-compat cross-refs (Issue 1, the result()-resolves-to-terminal root
      cause, T2.S1 _mergePartial reuse, T1.S1 seed, pi-ai-event-types.md §3 ordering, T3.S1 end-to-end).
- [ ] The method is a PURE transform (returns a NEW event via spread; never mutates the input event/message/error).
- [ ] Frozen blocks cloned per-block (`{ ...b }`) via `_mergePartial` (T2.S1) — NOT re-cloned or structuredClone.
- [ ] Privacy (Appendix H) preserved — the rewrite touches content internally only; no new diagnostics log content.
- [ ] No `_emit` control-flow changes beyond the single gate insertion; no new fields; no run()/_launchReplacement/
      trackEvent/makeErrorAssistantMessage/T2.S1-method/types.ts-logic/helper changes.

### Scope Discipline (cohesion — do not harm sibling work items)
- [ ] T2.S2 rewrites the replacement TERMINAL ONLY; non-terminal events are T2.S1's (its gate is untouched).
- [ ] T2.S2 REUSES `_mergePartial` (no duplication); does NOT add the comprehensive end-to-end suite (T3.S1).
- [ ] T2.S2 does NOT modify `tests/stream-proxy-rewrite.test.ts` (T2.S1's pre-existing guard failure is out of scope).

---

## Anti-Patterns to Avoid

- ❌ Don't merge the terminal AFTER the push — `result()` is already locked to the unmerged message (the #1 trap).
- ❌ Don't type `_rewriteReplacementTerminal`'s param as the broad `AssistantMessageEvent` — `event.message`/`event.error`
  are tsc errors there (terminals are a mutually-exclusive union; narrow via the `type` discriminant on `TerminalEvent`).
- ❌ Don't forget the `TerminalEvent` import — it is exported from types.ts but not yet imported in proxy.ts.
- ❌ Don't duplicate the merge logic — REUSE `_mergePartial` (T2.S1) so the terminal and partial merges stay identical.
- ❌ Don't drop the `> 0` guard — it is what keeps the offset-0 error-path suite green (the contract requires it).
- ❌ Don't add a placeholder-mock guard test — it has a full-suite timing race; use the realistic mock (reliable).
- ❌ Don't modify T2.S1's gate/method or its test file — T2.S2 is additive and isolated.
- ❌ Don't mutate the input event/message/error — return NEW objects via spread (pure transform).
