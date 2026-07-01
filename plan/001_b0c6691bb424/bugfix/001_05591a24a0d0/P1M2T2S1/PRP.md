# PRP — P1.M2.T2.S1: Rewrite non-terminal replacement events (contentIndex offset + partial merge)

> **Bugfix**: Stream Integrity & Shortcut Lifecycle — Issue 1 (CRITICAL): reasoning content is lost from the
> persisted assistant message on every interruption. This is **Task 2 Step 1** of the Issue-1 fix (Module
> P1.M2). It is the **non-terminal replacement-event rewrite** half: it consumes the seed data captured by
> the COMPLETED predecessor P1.M2.T1.S1 (`_frozenPrimaryContent`, `_contentIndexOffset`) and, in `_emit()`'s
> splicing branch, **offsets each forwarded replacement event's `contentIndex`** and **merges its `partial`**
> so the downstream consumer (`pi-agent-core`) assembles ONE unified `[thinking, text]` assistant message
> instead of losing the reasoning.
>
> **What this subtask is NOT**: it does NOT rewrite the terminal event (`done.message`/`error.error`) — that
> is **P1.M2.T2.S2** (T2.S1's gate explicitly skips terminals via `"contentIndex" in event`). It does NOT add
> the end-to-end consumer-harness assertion (`consumeLikeAgentLoop` → final message = `[thinking, text]`) —
> that is **P1.M2.T3.S1**. It changes the **streamed** events only; assertions are on the raw rewritten
> events, not the persisted message.
>
> **Chokepoint**: `src/provider/proxy.ts` `_emit()` — the SINGLE unified forwarding filter. Both the primary
> loop (`run()`) and the replacement loop (`_launchReplacement()`) forward through it. The splicing branch's
> final `this._output.push(event)` (line ~648) is the ONE point every forwarded replacement event passes
> through. The rewrite gate goes immediately before it.

---

## Goal

**Feature Goal**: In `src/provider/proxy.ts` `_emit()`'s splicing branch (`_authority === "splicing"`), rewrite
every forwarded **non-terminal** replacement event so that (a) its `contentIndex` is offset by the primary's
frozen content-block count (`_contentIndexOffset`), and (b) its `partial` is a merged `AssistantMessage` that
prepends the primary's frozen reasoning blocks (`_frozenPrimaryContent`, cloned) before the replacement's own
answer blocks. This makes the downstream consumer — which does `partialMessage = event.partial` on every event
AND indexes `partial.content[contentIndex]` — assemble a single unified `[thinking, text]` message, preserving
the reasoning the user watched stream in (Issue 1 root cause: the proxy currently forwards replacement events
verbatim, and the replacement is a fresh request whose partial contains only text → reasoning vanishes).

**Deliverable**:
- `src/provider/proxy.ts` — MODIFIED: (1) one rewrite gate inserted in `_emit()`'s splicing branch immediately
  before the final `this._output.push(event)`, and (2) two new private methods, `_rewriteReplacementEvent()`
  and `_mergePartial()`. NO new fields (T1.S1 owns them), NO changes to `run()`, `_launchReplacement()`,
  `trackEvent`, `makeErrorAssistantMessage`, the controller, the buffer, types.ts, or any helper/test helper.
- `tests/stream-proxy-rewrite.test.ts` — NEW: a `bun:test` that builds the `StreamProxy` with the realistic
  two-call mock (`makeRealisticTwoPhaseMock`), drives a primary reasoning stream, triggers `stop`
  mid-reasoning, drives replacement text events, collects the forwarded events, and asserts each non-terminal
  replacement event carries `contentIndex === 1` (offset) and a `partial.content` containing BOTH a frozen
  thinking block (index 0) and the growing text block (index 1). Includes a focused offset-0 no-op guard test.

**Success Definition**:
- `npm run build` (`tsc`) passes with **zero diagnostics** — this is a real gate (src/ change). The new
  `_rewriteReplacementEvent` MUST access `event.contentIndex`/`event.partial` via `in`-narrowing (see Context
  §Known Gotchas) or the build fails with *"Property does not exist on type 'TerminalEvent'"*.
- `npm test` (=`bun test`) is green: **0 fail**. Baseline 386 preserved (the offset-0 guard makes the rewrite
  a no-op for every existing placeholder-mock test). +1 (main) or +2 (main + guard) new tests.
- The new rewrite test passes: forwarded non-terminal replacement events have `contentIndex === 1`, and each
  `event.partial.content` is `[{type:"thinking", thinking:"Let me"}, {type:"text", text:"<growing>"}]`.
- `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts` changed; `git status` shows that file + the new
  test only.

---

## Why

- **Issue 1 root cause (architecture/system_context.md §Issue 1 + pi-agent-core-consumer.md §1–2)**: the proxy
  forwards replacement events VERBATIM. The replacement is a FRESH z.ai request (reasoning disabled) whose
  `partial` is a fresh accumulating `output` containing ONLY the answer text — it does NOT include the primary's
  reasoning. The real consumer does `partialMessage = event.partial` on EVERY event (last partial wins) and
  indexes `partial.content[contentIndex]`. The replacement's text block lives at `contentIndex: 0` — the SAME
  slot the primary's reasoning occupied — so the consumer OVERWRITES the thinking block. Result: 100% of
  interruptions silently discard the reasoning from the persisted message + cause a visible restart artifact.
  **T2.S1 is the fix**: it makes the proxy rewrite each forwarded non-terminal replacement event to carry a
  proxy-owned merged `partial` (primary reasoning PREPENDED) and an offset `contentIndex` (answer lands AFTER
  the reasoning) — so the consumer assembles `[thinking, text]`, matching a normal uninterrupted response
  (PRD Story 3 / G4 / §13.4 / §14.2 / §19.7 / ADR-005 observational equivalence).
- **Both consumers covered (pi-agent-core-consumer.md §1 LOCAL + §2 REMOTE)**: the LOCAL consumer
  (`agent-loop.js`) does `partialMessage = event.partial` → fixed by the **partial merge**. The REMOTE consumer
  (`proxy.js processProxyEvent`) indexes `partial.content[contentIndex]` → fixed by the **contentIndex offset**.
  T2.S1 applies BOTH transformations to every non-terminal replacement event, so both consumers build the
  unified message.
- **Seed data already captured (T1.S1 COMPLETE)**: `_frozenPrimaryContent` (the primary's structured content
  blocks, shallow-per-block cloned at the abort boundary) and `_contentIndexOffset` (their count) are populated
  by T1.S1 in `run()`'s catch, immediately after `_buffer.freeze()`, BEFORE `_launchReplacement()` flips
  authority to `"splicing"`. T2.S1 simply READS them in the splicing branch — it adds no new state.
- **Guarded = zero blast radius**: the gate `if (this._contentIndexOffset > 0 && "contentIndex" in event)`
  makes the rewrite a **no-op** whenever offset is 0 (no captured primary content — every existing
  placeholder-mock test) AND skips terminals (no `contentIndex`). So all 386 existing tests stay byte-for-byte
  green; only realistic-mock interruptions (offset ≥ 1) get rewritten.

## What

An additive change to `src/provider/proxy.ts`'s `_emit()` method plus two private helper methods, and one new
test file. In the splicing branch (`_authority === "splicing"`), immediately before the final
`this._output.push(event)`, add a rewrite gate: when the offset is non-zero and the event carries a
`contentIndex` (i.e. it is a non-terminal), replace the event with a rewritten copy whose `contentIndex` is
shifted by the offset and whose `partial` is rebuilt to prepend the frozen primary content blocks (cloned) before
the replacement's own content. The terminal (`done`/`error`) and the suppressed `start` are untouched by this
gate (they lack `contentIndex` / early-return before it).

### Success Criteria

- [ ] `src/provider/proxy.ts` `_emit()` splicing branch has the rewrite gate `if (this._contentIndexOffset > 0 &&
      "contentIndex" in event) { event = this._rewriteReplacementEvent(event); }` immediately before the final
      `this._output.push(event)`.
- [ ] `_rewriteReplacementEvent(event)` returns `{ ...event, contentIndex: <offset>, partial: <merged> }`,
      narrowed inside with `in` checks (tsc-clean), and `_mergePartial(replacementPartial)` returns
      `{ ...replacementPartial, content: [...frozen.map(b=>({...b})), ...(replacementPartial?.content ?? [])] }`.
- [ ] The gate SKIPS terminals (no `contentIndex`) — the `done`/`error` is forwarded UNCHANGED (T2.S2 owns it).
- [ ] The gate SKIPS offset-0 (placeholder mocks) → all 386 existing tests stay green.
- [ ] EC-017 (replacement returned reasoning): its thinking event falls through to the push, hits the gate, and
      is rewritten automatically (its own thinking blocks land after the frozen primary blocks via the merge) —
      no special case.
- [ ] New test `tests/stream-proxy-rewrite.test.ts` passes: forwarded text_* replacement events have
      `contentIndex === 1` and `partial.content === [{type:"thinking",thinking:"Let me"}, {type:"text",text:<growing>}]`.
- [ ] `npm run build` (tsc) and `npm test` (bun → 0 fail) both green; only `proxy.ts` changed in src/.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact insertion point (the single `this._output.push(event)` in `_emit()`'s splicing branch, quoted
verbatim with surrounding context), the literal contracts for the two new methods, the tsc-safe narrowing form,
the realistic-mock accumulation mechanics (verified), the test-driving idiom (copied from the shipped T1.S1
capture test + the abort tests), and the validated commands are all inlined below. The implementer needs no prior
proxy/FSM/consumer knowledge beyond what is quoted.

### Documentation & References

```yaml
# MUST READ — the bug, the two consumers, the exact merge spec
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/system_context.md
  why: "§Issue 1 root cause (verbatim forwarding + fresh replacement partial = reasoning lost). The two-consumer
        failure (LOCAL partialMessage=event.partial; REMOTE partial.content[contentIndex] collision at index 0)."
  critical: "Establishes WHY both the contentIndex OFFSET and the partial MERGE are required (two distinct
             consumers, two distinct failure modes). T2.S1 must do BOTH on every non-terminal replacement event."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-agent-core-consumer.md
  why: "§1 (LOCAL agent-loop.js): partialMessage = event.partial on EVERY event; finalMessage = response.result()
        = done.message. §2 (REMOTE proxy.js processProxyEvent): partial.content[proxyEvent.contentIndex] indexing
        — the text_start at index 0 OVERWRITES the thinking block at index 0."
  critical: "§1 is WHY the partial must be merged (last partial wins → must include reasoning). §2 is WHY
             contentIndex must be offset (answer must land in a fresh slot after the reasoning). §4 explains why
             the existing 380+ tests miss this (they assert raw events, never run the consumer)."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-ai-event-types.md
  why: "§1: every NON-terminal event carries contentIndex + partial; done/error carry message/error (NO partial,
        NO contentIndex). §2: AssistantMessage.content is ContentBlock[]; merge =
        {...replacementPartial, content:[...frozen, ...replacement.content]}. §3: push semantics."
  critical: "§1 is the SOURCE of the tsc gotcha: contentIndex/partial exist on non-terminals ONLY. The rewrite
             method must narrow with `in` checks or tsc errors on the broad AssistantMessageEvent param."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/P1M2T2S1/research/notes.md
  why: "Verbatim insertion-point code block (the splicing branch lines 625–649); the exact gate placement; the
        tsc-safe _rewriteReplacementEvent/_mergePartial forms; the EC-017 no-special-case proof; the realistic-mock
        event-by-event merged-partial table; the test-driving idiom; validated commands."
  critical: "§1 (gate placement — line 648 is the single forward point), §3 (the tsc `in`-narrowing), and §5 (the
        per-event merged-partial expectations) are the three things most likely to break one-pass success."

# PATTERN files to follow (verified verbatim against current src/)
- file: src/provider/proxy.ts
  why: "THE file being modified. _emit() splicing branch (the gate insertion point, lines ~625–649). T1.S1's
        fields (_frozenPrimaryContent line 157, _contentIndexOffset line 164) + getters (311, 319) are already
        present and populated by run()'s catch (lines 736–737) — READ them, do NOT re-create."
  pattern: "The private-method convention (_emit, _launchReplacement, makeErrorAssistantMessage): JSDoc with PRD
            cross-refs; pure transform (return a NEW event object via spread — never mutate the input); assistantMessage
            is already imported (line 55); isTerminalEvent/isThinkingEvent already imported (line 64)."
  gotcha: "The gate goes AFTER the start-suppression, the EC-017 thinking fall-through trace, and the
           duplicate-terminal discard (all early-return BEFORE line 648), and BEFORE the final push. Do NOT touch
           the forwarding branch, run(), _launchReplacement, trackEvent, or makeErrorAssistantMessage."

- file: src/types.ts
  why: "The AssistantMessageEvent discriminated union + the four type guards (isTerminalEvent, isThinkingEvent,
        isTextEvent, isToolCallEvent). Confirms contentIndex/partial exist on NON-terminal members ONLY."
  pattern: "No new types needed for T2.S1. The `in` operator narrowing at the call site + inside
            _rewriteReplacementEvent is sufficient (isTerminalEvent could also be used but `in` narrows BOTH
            contentIndex AND partial in one check at the call site)."

- file: tests/helpers/realistic-mock.ts   # SHIPPED in P1.M1.T1.S2 — consume, do NOT modify
  why: "makeRealisticTwoPhaseMock() → { fn, pushPrimary, pushReplacement, primaryOutput, replacementOutput, calls }.
        Primary (call 1, reasoning ON): thinking block at content[0], partial=primaryOutput (LIVE), throws on abort.
        Replacement (call 2, reasoning OFF): FRESH output, text block at content[0], partial=replacementOutput
        (LIVE, never includes primary thinking). The mock derives contentIndex (indexOf) + partial itself."
  pattern: "Drop mock.fn into new StreamProxy(..., mock.fn, ...). Push specs like {type:'text_delta', delta:'Here'};
            the mock accumulates into replacementOutput.content[0].text in place and stamps partial=replacementOutput."
  gotcha: "The replacement's text_* events carry contentIndex: 0 — exactly what T2.S1 rewrites to 1 (offset). After a
           primary [thinking_delta('Let'), thinking_delta(' me')], _contentIndexOffset===1 and the frozen block is
           {type:'thinking', thinking:'Let me'}. pushReplacement does NOT wake the blocked iterator instantly (the
           mock's iterator re-checks the queue on a setTimeout(0) tick) — drain proxy.output AFTER pushing to let the
           event loop process the replacement events."

- file: tests/helpers/invariant-harness.ts   # SHIPPED — import the test doubles from here
  why: "makeCaptureDiag() (capturing Diagnostics stub — records the 'proxy.abort.completed' trace to gate timing),
        makeModel() (minimal Model stand-in), waitFor(pred, timeoutMs) (polling helper)."
  pattern: "import { makeCaptureDiag, makeModel, waitFor } from './helpers/invariant-harness'; — do NOT re-declare
            locally. The construction arg order matches tests/stream-proxy-capture.test.ts exactly."
  gotcha: "waitFor(() => proxy.isReasoning()) BEFORE triggerStop (run() must process the thinking events). Then
           waitFor(() => events.some(c => c.event === 'proxy.abort.completed')) AFTER triggerStop (freeze + snapshot
           done → offset is 1 before the replacement events are iterated)."

- file: tests/stream-proxy-capture.test.ts   # read-only PATTERN (T1.S1's test — the drive→reason→stop→assert flow)
  why: "The exact construction + control flow to copy: build proxy, push start + thinking_start + thinking_delta x2,
        waitFor(isReasoning), triggerStop, waitFor(proxy.abort.completed), then drive the replacement + drain output."
  pattern: "Copy its imports, construction (with the 15ms orphan-safe replacementStartupTimeoutMs), and the
            drive→waitFor(isReasoning)→triggerStop→waitFor(abort.completed) timing. Then ADD: pushReplacement text
            events + drain proxy.output collecting forwarded events + assert the rewrite."
  gotcha: "The guard test there uses makeScriptedTwoPhaseUpstream (placeholder, no partial → offset 0). For T2.S1's
           guard test, reuse the SAME placeholder mock to assert offset-0 forwarding is unchanged (contentIndex stays
           0, no merge)."
```

### Current Codebase tree (relevant slice)

```bash
src/provider/
└── proxy.ts                     # ← MODIFY: 1 gate in _emit() splicing branch + 2 new private methods
tests/
├── helpers/
│   ├── realistic-mock.ts        # consume makeRealisticTwoPhaseMock (shipped P1.M1.T1.S2 — do NOT modify)
│   ├── invariant-harness.ts     # import makeCaptureDiag / makeModel / waitFor / makeScriptedTwoPhaseUpstream / ev
│   └── consumer-harness.ts      # NOT used by T2.S1 (that's P1.M2.T3.S1) — do not import
├── stream-proxy-capture.test.ts # read-only PATTERN (T1.S1's drive→reason→stop→assert control flow)
└── (stream-proxy-rewrite.test.ts)  # ← NEW (this subtask)
```

### Desired Codebase tree with file responsibilities

```bash
src/provider/proxy.ts            # MODIFIED — rewrite gate + _rewriteReplacementEvent + _mergePartial.
                                 #   Responsibilities: make forwarded non-terminal replacement events carry an
                                 #   offset contentIndex and a merged partial so the consumer unifies the message.
tests/stream-proxy-rewrite.test.ts  # NEW — drives the proxy with the realistic mock through a mid-reasoning
                                 #   abort + replacement answer; asserts the rewrite (offset + merged partial).
                                 #   Plus a focused offset-0 no-op guard test.
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (tsc gate — the #1 trap): AssistantMessageEvent is a discriminated union where `contentIndex` and
// `partial` exist on EVERY non-terminal member but NOT on done/error. If _rewriteReplacementEvent's param is
// typed AssistantMessageEvent (the broad union), then `event.contentIndex` and `event.partial` are tsc ERRORS:
// "Property 'contentIndex'/'partial' does not exist on type 'TerminalEvent'" → `npm run build` (tsc) FAILS.
// (This is the SAME class of gotcha T1.S1 flagged for the bare `event.partial` capture line.) FIX: narrow
// defensively INSIDE the method with `in` checks (the call-site gate already guarantees "contentIndex" in event,
// so these are no-ops at runtime but satisfy strict-mode tsc):
//     const contentIndex = ("contentIndex" in event ? event.contentIndex : 0) + this._contentIndexOffset;
//     const partial = this._mergePartial("partial" in event ? event.partial : undefined);
//     return { ...event, contentIndex, partial };
// Verified: AssistantMessage is already imported (line 55); isTerminalEvent already imported (line 64).

// CRITICAL (gate placement — the #2 trap): the gate MUST go immediately BEFORE the final this._output.push(event)
// in the splicing branch (line ~648), AFTER all early-return guards. Placement rationale:
//   - suppressed `start` early-returns BEFORE the gate (correct: not forwarded, has no contentIndex).
//   - discarded duplicate-terminal early-returns BEFORE the gate (correct: not forwarded).
//   - top-of-method discard-after-completion stray guard early-returns BEFORE the gate (correct: not forwarded).
//   - EC-017 thinking events FALL THROUGH to the push → they HIT the gate (correct: they carry contentIndex and
//     must be rewritten — the contract's parenthetical requirement).
//   - first terminal (done/error) reaches the gate BUT "contentIndex" in event is false → SKIPPED (correct:
//     T2.S2 owns the terminal merge; T2.S1 forwards it UNCHANGED).
// Do NOT place the gate inside the isTerminalEvent block, the isThinkingEvent block, or the forwarding branch.

// CRITICAL (the offset-0 no-op guard — the #3 trap, keeps the 386-test suite green): the gate's first condition
// is `this._contentIndexOffset > 0`. When offset is 0 (every existing placeholder-mock test — their events carry
// NO partial so T1.S1's snapshot yields frozen [] + offset 0), the gate is FALSE → no rewrite → events forwarded
// UNCHANGED → all 386 existing tests stay byte-for-byte green. Do NOT drop the `> 0` check. Do NOT default
// _contentIndexOffset to anything but 0 (T1.S1 owns it; it is 0 until a realistic primary partial is captured).

// CRITICAL (clone the FROZEN blocks, not the replacement's own blocks): _mergePartial must clone the frozen
// primary blocks per-block (`this._frozenPrimaryContent.map((b) => ({ ...b }))`) — the contract explicitly
// requires this to avoid shared mutable references across events. The replacement's OWN blocks are NOT cloned
// (they are the replacement's live accumulating blocks — spread as-is via `...(replacementPartial?.content ?? [])`,
// matching the provider's own partial semantics where the consumer reads the live growing text). Shallow-per-block
// `{ ...b }` is the spec'd clone (NOT structuredClone — content blocks are plain data; structuredClone can choke
// on non-cloneable fields in other providers).

// GOTCHA (terminals are OUT OF SCOPE — T2.S2 owns them): done/error carry NO contentIndex, so the gate's
// "contentIndex" in event is false → the terminal is forwarded UNCHANGED. This is INTENTIONAL: T2.S1 rewrites
// non-terminal events ONLY. T2.S2 will rewrite the terminal's message/error field. Do NOT add a terminal rewrite.

// GOTCHA (EC-017 needs NO special case): if the thinking-disabled replacement returns reasoning anyway, its
// thinking event falls through to the push, hits the gate, and is rewritten. Its partial.content contains the
// replacement's OWN thinking block(s); _mergePartial prepends the frozen PRIMARY blocks then appends the
// replacement's content → [...primaryThinking, ...replacementThinking, ...replacementText]. The contentIndex
// offset places the replacement's thinking at its correct merged slot. No branch needed.

// GOTCHA (the merged partial is a proxy-owned object, but shares the replacement's live text block reference):
// _mergePartial returns a NEW object ({...replacementPartial, content:[...]}) with a NEW content array, so the
// consumer's `partialMessage = event.partial` always sees the latest merge. The frozen block entries are fresh
// clones; the replacement's text block entry IS the live replacementOutput block (mutated in place by the mock/
// provider as deltas arrive) — so partial.content[1].text grows across events exactly like a real provider's
// partial. This is correct and intentional.

// GOTCHA (collect forwarded events by draining AFTER pushing replacement events): AssistantMessageEventStream.push
// buffers into an internal queue, so primary events forwarded during the reason phase are buffered and pulled when
// you drain. Push the replacement text events, THEN `for await (const e of proxy.output) forwarded.push(e)` — the
// done terminal completes the stream and the loop exits. The replacement start is suppressed (NOT in forwarded).

// GOTCHA (bun is not on PATH): run tests via `./node_modules/.bin/bun test ...` or `npm test`. `npm run build`
// runs `tsc` (the src/ type gate). Baseline = 386 pass (384 original + 2 from T1.S1).

// SCOPE: do NOT rewrite the terminal (T2.S2). Do NOT add the consumeLikeAgentLoop end-to-end assertion (T2.S3).
// Do NOT modify run(), _launchReplacement, trackEvent, makeErrorAssistantMessage, _frozenPrimaryContent/
// _contentIndexOffset (T1.S1 owns them), types.ts, or any helper. Do NOT import consumeLikeAgentLoop
// (tests/helpers/consumer-harness.ts — that is P1.M2.T3.S1). git diff --stat -- src/ shows ONLY proxy.ts.
```

---

## Implementation Blueprint

### Data models and structure

No new types, no new fields. `AssistantMessage` is already imported in proxy.ts (line 55). The two new private
methods operate on the existing `AssistantMessageEvent` / `AssistantMessage` and the T1.S1 fields.

```typescript
// (new private methods on StreamProxy — pure transforms: return NEW objects, never mutate inputs)
private _rewriteReplacementEvent(event: AssistantMessageEvent): AssistantMessageEvent
private _mergePartial(replacementPartial: AssistantMessage | undefined): AssistantMessage
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — add _mergePartial() private method
  - IMPLEMENT: `private _mergePartial(replacementPartial: AssistantMessage | undefined): AssistantMessage`
    returning `{ ...replacementPartial, content: [...this._frozenPrimaryContent.map((b) => ({ ...b })),
    ...(replacementPartial?.content ?? [])] } as AssistantMessage`.
  - FOLLOW pattern: the existing private-method JSDoc convention (_emit/_launchReplacement/makeErrorAssistantMessage)
    — JSDoc with PRD/forward-compat cross-refs (reference P1.M2.T1.S1 seed data, P1.M2.T2.S2 terminal consumer,
    architecture pi-ai-event-types.md §2 merge spec).
  - NAMING: _mergePartial (matches the work-item contract exactly).
  - CRITICAL: clone the FROZEN blocks per-block ({ ...b }) — NOT structuredClone. Do NOT clone the replacement's
    own blocks (spread them as-is). The `?? []` handles an undefined partial defensively.
  - PLACEMENT: among the other private methods (e.g. near makeErrorAssistantMessage / _startReplacementTimeout).
  - DEPENDENCIES: reads this._frozenPrimaryContent (T1.S1). AssistantMessage already imported.

Task 2: MODIFY src/provider/proxy.ts — add _rewriteReplacementEvent() private method
  - IMPLEMENT: `private _rewriteReplacementEvent(event: AssistantMessageEvent): AssistantMessageEvent` returning
    `{ ...event, contentIndex: <offset>, partial: <merged> }`, computed via tsc-safe `in` narrowing:
        const contentIndex = ("contentIndex" in event ? event.contentIndex : 0) + this._contentIndexOffset;
        const partial = this._mergePartial("partial" in event ? event.partial : undefined);
        return { ...event, contentIndex, partial };
  - FOLLOW pattern: private-method JSDoc convention. Reference Issue 1, the two consumers (LOCAL partial merge +
    REMOTE contentIndex offset), and that this rewrites NON-TERMINAL events only (T2.S2 owns the terminal).
  - NAMING: _rewriteReplacementEvent (matches the work-item contract exactly).
  - CRITICAL (tsc): the `in` checks are REQUIRED — the bare `event.contentIndex`/`event.partial` from the contract
    FAIL `npm run build` because the broad AssistantMessageEvent union includes terminals lacking those props.
    The `in` checks are no-ops at runtime (the call-site gate guarantees "contentIndex" in event) but satisfy tsc.
  - PLACEMENT: among the other private methods (place near _mergePartial).
  - DEPENDENCIES: Task 1 (_mergePartial) + reads this._contentIndexOffset (T1.S1).

Task 3: MODIFY src/provider/proxy.ts — insert the rewrite gate in _emit()'s splicing branch
  - EDIT _emit()'s splicing branch (the `_authority === "splicing"` section, after the forwarding branch's early
    return): immediately BEFORE the final `this._output.push(event);` (line ~648) and AFTER the terminal block
    (`if (isTerminalEvent(event)) { ... }`), add:
        // P1.M2.T2.S1 — Issue 1 fix: rewrite non-terminal replacement events so the downstream consumer
        // (agent-loop.js `partialMessage = event.partial` + proxy.js `partial.content[contentIndex]`) assembles
        // ONE unified message [primary reasoning, ...replacement answer]. Offset shifts the answer past the
        // frozen reasoning; merge prepends the cloned frozen reasoning to the replacement's partial. Terminals
        // (no contentIndex) and offset-0 (no captured primary content) are skipped → no-op for the existing suite.
        if (this._contentIndexOffset > 0 && "contentIndex" in event) {
          event = this._rewriteReplacementEvent(event);
        }
  - CRITICAL: this is the ONLY insertion in _emit(). The gate sits AFTER the start-suppression, the EC-017
    thinking fall-through trace, and the duplicate-terminal discard (all early-return before line 648), so it
    catches EVERY forwarded event (thinking/text/toolcall via fall-through; the first terminal too but the
    "contentIndex" check skips it). Do NOT move any existing line; do NOT add a second push.
  - PRESERVE: the forwarding branch, the start-suppression, the EC-017 trace, the duplicate-terminal trace, the
    _messageEndEmitted flag logic, and the final push. Do NOT touch the FM-013 malformed guard or the
    discard-after-completion stray guard at the top of _emit().

Task 4: CREATE tests/stream-proxy-rewrite.test.ts — the rewrite test (TDD; drives the real proxy)
  - IMPLEMENT: a bun:test that builds StreamProxy with makeRealisticTwoPhaseMock's fn, drives a primary reasoning
    stream, triggers abort mid-reasoning, drives replacement text events, drains proxy.output collecting forwarded
    events, and asserts each forwarded non-terminal replacement (text_*) event has contentIndex === 1 and a merged
    partial.content === [{type:'thinking',thinking:'Let me'}, {type:'text',text:<growing>}].
  - FOLLOW pattern: tests/stream-proxy-capture.test.ts (T1.S1's test — construction + the
    drive→waitFor(isReasoning)→triggerStop→waitFor(abort.completed) timing). Import the test doubles from
    tests/helpers/invariant-harness.ts (makeCaptureDiag, makeModel, waitFor).
  - IMPORTS:
      import { describe, test, expect } from "bun:test";
      import { StreamProxy } from "../src/provider/proxy";
      import { TransitionController } from "../src/state/controller";
      import { ReasoningBuffer } from "../src/buffer";
      import { DEFAULT_CONFIG } from "../src/config";
      import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
      import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";
      import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
  - SCENARIO (the MAIN test — proves the rewrite):
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
      d. Drive REPLACEMENT (reasoning OFF, text block at content[0]):
         mock.pushReplacement({ type: "text_start" });
         mock.pushReplacement({ type: "text_delta", delta: "Here" });
         mock.pushReplacement({ type: "text_delta", delta: " answer" });
         mock.pushReplacement({ type: "text_end" });
         mock.pushReplacement({ type: "done" });
      e. Collect forwarded events (the done completes the stream; the replacement start is suppressed):
         const forwarded: AssistantMessageEvent[] = [];
         for await (const event of proxy.output) forwarded.push(event);
      f. Filter the NON-TERMINAL replacement events (the text_* events; the replacement is reasoning-OFF):
         const replacementTextEvents = forwarded.filter((e) => e.type === "text_start" || e.type === "text_delta" || e.type === "text_end");
         expect(replacementTextEvents.length).toBe(4); // text_start + 2 text_delta + text_end
      g. ASSERT the rewrite on EACH:
         for (const e of replacementTextEvents) {
           expect(e.contentIndex).toBe(1);                              // OFFSET applied (mock emitted 0)
           expect(e.partial.content.length).toBe(2);                    // merged: frozen + replacement
           expect(e.partial.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" }); // frozen primary, STABLE
           expect(e.partial.content[1]).toMatchObject({ type: "text" }); // growing replacement answer
         }
         // Assert the text GROWS across deltas (proves the merge carries the live accumulating answer):
         const textStart = replacementTextEvents.find((e) => e.type === "text_start")!;
         expect(textStart.partial.content[1]).toMatchObject({ text: "" });
         const lastDelta = replacementTextEvents.filter((e) => e.type === "text_delta").pop()!;
         expect(lastDelta.partial.content[1]).toMatchObject({ text: "Here answer" });
         // Assert the terminal was forwarded UNCHANGED (T2.S1 does NOT touch it — T2.S2 owns it):
         const doneEvent = forwarded.find((e) => e.type === "done");
         expect(doneEvent).toBeDefined();                              // forwarded
         expect("contentIndex" in (doneEvent as object)).toBe(false); // NOT rewritten (no contentIndex key added)
  - NAMING: test("P1.M2.T2.S1: rewrites non-terminal replacement events — offset contentIndex + merged partial",
      …). Group under `describe("StreamProxy — replacement-event rewrite (P1.M2.T2.S1)")`.
  - GUARD test (proves the offset-0 no-op so the suite stays green):
      a SECOND test using makeScriptedTwoPhaseUpstream (placeholder mock, events with NO partial → offset 0):
      drive primary thinking (contentIndex 0, no partial), triggerStop, waitFor(abort.completed), assert
      proxy.contentIndexOffset === 0, push a replacement text event (ev({type:'text_delta', contentIndex:0,
      delta:'x', partial:{role:'assistant',content:[{type:'text',text:'x'}]} as never})), drain output, and
      assert the forwarded text event has contentIndex === 0 (UNCHANGED — gate skipped because offset 0) and its
      partial.content.length === 1 (NOT merged/prepended). This documents the GUARD and protects the `> 0` check.
  - COVERAGE: realistic-mock rewrite (contentIndex 1 + merged [thinking, text]); offset-0 no-op guard
      (contentIndex unchanged, no merge). Do NOT assert on the persisted final message / consumeLikeAgentLoop
      (P1.M2.T3.S1).
  - PLACEMENT: tests/stream-proxy-rewrite.test.ts.
```

### Implementation Patterns & Key Details

```typescript
// src/provider/proxy.ts — the two new methods + the gate (verbatim; see research notes §3 for the tsc rationale).

// NEW METHOD 1 — the content merge (place among the other private methods):
/**
 * P1.M2.T2.S1 — merge a replacement event's `partial` with the primary's frozen content blocks (Issue 1 fix).
 * Returns a NEW {@link AssistantMessage}: the replacement's partial (preserving usage/model/stopReason/timestamp)
 * with `content` = [CLONED frozen primary blocks..., ...replacement's own content blocks]. The frozen blocks are
 * shallow-cloned per-block to avoid aliasing {@link _frozenPrimaryContent} across events (defensive isolation).
 * The replacement's own blocks are NOT cloned (they are the replacement's live accumulating blocks — same as the
 * provider's own `partial` semantics). Seed data is captured by P1.M2.T1.S1; the merge spec is
 * architecture/pi-ai-event-types.md §2.
 */
private _mergePartial(replacementPartial: AssistantMessage | undefined): AssistantMessage {
  return {
    ...replacementPartial,
    content: [
      ...this._frozenPrimaryContent.map((b) => ({ ...b })), // CLONED frozen primary blocks (reasoning preserved)
      ...(replacementPartial?.content ?? []),               // replacement's own (live) answer blocks
    ],
  } as AssistantMessage;
}

// NEW METHOD 2 — the per-event rewrite (place near _mergePartial):
/**
 * P1.M2.T2.S1 — rewrite a forwarded replacement NON-terminal event to carry an offset `contentIndex` and a merged
 * `partial` (Issue 1 fix), so the downstream consumer assembles ONE unified message [primary reasoning, ...answer]:
 *  - LOCAL consumer (agent-loop.js `partialMessage = event.partial`) → fixed by the MERGED partial (reasoning preserved).
 *  - REMOTE consumer (proxy.js `partial.content[contentIndex]`) → fixed by the OFFSET contentIndex (answer lands
 *    AFTER the frozen reasoning, no index-0 collision).
 * The `in` checks are tsc-safe no-ops at runtime (the call-site gate guarantees `"contentIndex" in event`); they
 * narrow out the terminal members that lack `contentIndex`/`partial`. This rewrites NON-TERMINAL events ONLY —
 * the terminal (`done.message`/`error.error`) is handled by P1.M2.T2.S2.
 */
private _rewriteReplacementEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  const contentIndex = ("contentIndex" in event ? event.contentIndex : 0) + this._contentIndexOffset;
  const partial = this._mergePartial("partial" in event ? event.partial : undefined);
  return { ...event, contentIndex, partial };
}

// EDIT — _emit() splicing branch, immediately before the final `this._output.push(event);` (after the terminal block):
    // ... (start-suppression, EC-017 thinking trace, duplicate-terminal discard all early-return ABOVE this) ...
    if (isTerminalEvent(event)) {
      if (this._messageEndEmitted) {
        this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
        return;
      }
      this._messageEndEmitted = true;
    }
    // P1.M2.T2.S1 — Issue 1 fix: rewrite NON-TERMINAL replacement events so the consumer unifies the message.
    // Offset shifts the answer past the frozen reasoning; merge prepends the cloned frozen reasoning to the
    // partial. Skips terminals (no contentIndex) and offset-0 (no captured primary content → no-op for the
    // existing suite). EC-017 replacement thinking events fall through here and are rewritten automatically.
    if (this._contentIndexOffset > 0 && "contentIndex" in event) {
      event = this._rewriteReplacementEvent(event);
    }
    // text_start/delta/end + toolcall_* (and the first terminal) → forward.
    this._output.push(event);
```

```typescript
// tests/stream-proxy-rewrite.test.ts — the rewrite test (sketch; fill from the task list).
import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { makeCaptureDiag, makeModel, waitFor, makeScriptedTwoPhaseUpstream, ev } from "./helpers/invariant-harness";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

describe("StreamProxy — replacement-event rewrite (P1.M2.T2.S1)", () => {
  test("rewrites non-terminal replacement events — offset contentIndex + merged partial", async () => {
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

    // REPLACEMENT (reasoning OFF) → text block at content[0] (contentIndex 0 pre-rewrite).
    mock.pushReplacement({ type: "text_start" });
    mock.pushReplacement({ type: "text_delta", delta: "Here" });
    mock.pushReplacement({ type: "text_delta", delta: " answer" });
    mock.pushReplacement({ type: "text_end" });
    mock.pushReplacement({ type: "done" });

    const forwarded: AssistantMessageEvent[] = [];
    for await (const event of proxy.output) forwarded.push(event); // done completes the stream

    const txt = forwarded.filter((e) => e.type.startsWith("text_"));
    expect(txt.length).toBe(4);
    for (const e of txt) {
      expect(e.contentIndex).toBe(1); // OFFSET (mock emitted 0)
      expect(e.partial.content.length).toBe(2); // merged: frozen + replacement
      expect(e.partial.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" }); // frozen, STABLE
      expect(e.partial.content[1]).toMatchObject({ type: "text" }); // growing answer
    }
    // text GROWS across deltas (the merge carries the live accumulating answer):
    expect(txt.find((e) => e.type === "text_start")!.partial.content[1]).toMatchObject({ text: "" });
    expect(txt.filter((e) => e.type === "text_delta").pop()!.partial.content[1]).toMatchObject({ text: "Here answer" });
    // terminal forwarded UNCHANGED (T2.S1 does NOT touch it):
    const done = forwarded.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect("contentIndex" in (done as object)).toBe(false);
  });

  test("offset-0 (placeholder partials) forwards replacement events UNCHANGED (guard)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeScriptedTwoPhaseUpstream(); // placeholder mock; events have no partial → offset 0
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    expect(proxy.triggerStop()).toBe(true);
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));
    expect(proxy.contentIndexOffset).toBe(0); // guard precondition

    // Replacement text event WITH a partial (one text block) — gate must SKIP (offset 0) → unchanged.
    mock.pushReplacement(ev({
      type: "text_delta", contentIndex: 0, delta: "x",
      partial: { role: "assistant", content: [{ type: "text", text: "x" }] } as never,
    }));
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: { role: "assistant", content: [] } as never }));

    const forwarded: AssistantMessageEvent[] = [];
    for await (const event of proxy.output) forwarded.push(event);

    const td = forwarded.find((e) => e.type === "text_delta");
    expect(td).toBeDefined();
    expect(td!.contentIndex).toBe(0); // UNCHANGED (offset 0 → no rewrite)
    expect((td as any).partial.content.length).toBe(1); // NOT merged/prepended
  });
});
```

### Integration Points

```yaml
PRODUCTION CODE:
  - modify file: src/provider/proxy.ts
      - add private method: _mergePartial(replacementPartial: AssistantMessage | undefined): AssistantMessage
      - add private method: _rewriteReplacementEvent(event: AssistantMessageEvent): AssistantMessageEvent
      - _emit() splicing branch: insert the rewrite gate immediately before the final this._output.push(event).
  - NOT modified: src/types.ts, src/state/*, src/buffer/*, src/request/*, src/provider/decorator.ts, src/index.ts.
    git diff --stat -- src/ shows ONLY proxy.ts. NO new fields (T1.S1 owns _frozenPrimaryContent/_contentIndexOffset).

TEST CODE:
  - add file: tests/stream-proxy-rewrite.test.ts (2 tests: main rewrite + offset-0 guard).

BUILD/CONFIG: NONE. tsconfig.json already compiles src/ (the tsc gate). No package.json changes. No new deps.

DOWNSTREAM (do NOT wire now — T2.S1's output is consumed by these):
  - P1.M2.T2.S2: rewrites the replacement TERMINAL (done.message / error.error) merge — the gate skips terminals
    today (no contentIndex) so T2.S2 adds the terminal rewrite separately without conflict.
  - P1.M2.T3.S1: end-to-end consumer-harness test (consumeLikeAgentLoop) asserting the final persisted message
    content === [{type:'thinking',…}, {type:'text',…}] AFTER T2.S1 + T2.S2 are both wired.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# THE PRIMARY GATE — this is a src/ change, so tsc MUST pass. The bare event.contentIndex/event.partial access
# inside _rewriteReplacementEvent FAILS this unless narrowed with `in` checks (see Context §Known Gotchas).
npm run build
# Expected: 0 diagnostics. (If "Property 'contentIndex'/'partial' does not exist on type 'TerminalEvent'" → you
#   wrote the bare contract form; replace with the `in`-narrowed form above.)

npm run typecheck   # = tsc --noEmit — equivalent gate; 0 diagnostics.

# Confirm ONLY proxy.ts changed in src/ and the new test was added:
git diff --stat -- src/            # Expected: src/provider/proxy.ts only
git status --short -- tests/       # Expected: ?? tests/stream-proxy-rewrite.test.ts (and no other changes)
```

### Level 2: Unit Tests (Component Validation)

```bash
# Run the new rewrite test in isolation:
npm test tests/stream-proxy-rewrite.test.ts
# Expected: 2 passing. Main: each text_* replacement event contentIndex===1 + merged partial.content
#   [{thinking:'Let me'}, {text:<growing>}]. Guard: offset-0 → contentIndex unchanged (0), no merge.

# Full suite — confirms the offset-0 guard preserved every existing test:
npm test
# Expected: 0 fail (baseline 386 + the 2 new tests = 388). 0 FAIL is the hard gate.
```

### Level 3: Integration (the rewrite fires in the real splicing branch)

```bash
# Confirm the capture/abort suites still pass (the gate is additive; offset-0 → no-op):
npm test tests/stream-proxy-capture.test.ts tests/stream-proxy-abort.test.ts
# Expected: all pass — proof the new gate did not disturb abort coordination or T1.S1's capture.

# Confirm the guard really no-ops for placeholder mocks (the full regression/stress/chaos suites use them):
npm test tests/regression-tests.test.ts tests/stress-tests.test.ts tests/chaos-tests.test.ts tests/property-tests.test.ts
# Expected: all pass — proof contentIndexOffset stays 0 → gate skipped → events forwarded unchanged.
```

### Level 4: Domain-Specific Validation (Rewrite Contract Audit)

```bash
# Audit the exact rewrite mechanics are present and correct in proxy.ts:
grep -n "_rewriteReplacementEvent"        src/provider/proxy.ts   # → method decl + gate call (≥2)
grep -n "_mergePartial"                   src/provider/proxy.ts   # → method decl + call inside _rewriteReplacementEvent (≥2)
grep -n "_contentIndexOffset > 0 && \"contentIndex\" in event" src/provider/proxy.ts  # → the gate (≥1)
grep -n "_frozenPrimaryContent.map((b) => ({ ...b }))" src/provider/proxy.ts  # → cloned frozen blocks in _mergePartial (≥1)
grep -n '"contentIndex" in event ? event.contentIndex' src/provider/proxy.ts  # → tsc-safe narrowing (≥1)
# Confirm the gate sits in the splicing branch (after the start-suppression + terminal block), not the forwarding branch:
grep -n 'this._authority === "splicing"\|this._output.push(event)' src/provider/proxy.ts  # → the gate's push is the LAST one

# Confirm the new test drives the REAL proxy with the realistic mock and asserts the rewrite:
grep -n "makeRealisticTwoPhaseMock"       tests/stream-proxy-rewrite.test.ts  # → main case (≥1)
grep -n "contentIndex"                    tests/stream-proxy-rewrite.test.ts  # → offset assertion === 1 (≥1)
grep -n "partial.content\[0\]\|partial.content\[1\]" tests/stream-proxy-rewrite.test.ts  # → merged-block assertions (≥2)
grep -n "makeScriptedTwoPhaseUpstream"    tests/stream-proxy-rewrite.test.ts  # → guard case (≥1)
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npm run build` (tsc) → 0 diagnostics (the `in`-narrowing is what makes this pass).
- [ ] `npm run typecheck` → 0 diagnostics.
- [ ] `npm test` full suite green (0 fail). Baseline 386 preserved; +2 new tests (rewrite + guard).
- [ ] `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts`; no other src/ or helper file modified.

### Feature Validation
- [ ] `proxy.ts` adds `_mergePartial()` and `_rewriteReplacementEvent()` (private), named exactly per the contract.
- [ ] `_emit()` splicing branch has the gate `if (this._contentIndexOffset > 0 && "contentIndex" in event)`
      immediately before the final `this._output.push(event)`.
- [ ] The gate SKIPS terminals (`"contentIndex" in event` is false for done/error) → forwarded UNCHANGED (T2.S2).
- [ ] The gate SKIPS offset-0 (placeholder mocks) → all 386 existing tests stay green (guard test asserts this).
- [ ] EC-017 replacement thinking events fall through to the push, hit the gate, and are rewritten (no special case).
- [ ] Rewrite test passes: text_* replacement events have `contentIndex === 1` + `partial.content` =
      `[{type:'thinking',thinking:'Let me'}, {type:'text',text:<growing>}]`; terminal forwarded unchanged.

### Code Quality & Documentation
- [ ] New methods follow the existing private-method JSDoc convention (_emit/_launchReplacement/
      makeErrorAssistantMessage) with PRD/forward-compat cross-refs (Issue 1, T1.S1 seed, T2.S2 terminal, T3.S1 e2e).
- [ ] Methods are PURE transforms (return NEW objects via spread; never mutate the input event/partial).
- [ ] Frozen blocks cloned per-block (`{ ...b }`), NOT structuredClone; replacement's own blocks NOT cloned.
- [ ] Privacy (Appendix H) preserved — the rewrite touches content internally only; no new diagnostics log content.
- [ ] No `_emit` control-flow changes beyond the single gate insertion; no new fields; no run()/_launchReplacement
      /trackEvent/makeErrorAssistantMessage/types.ts/helper changes.

### Scope Discipline (cohesion — do not harm sibling work items)
- [ ] T2.S1 rewrites NON-TERMINAL replacement events ONLY; the terminal rewrite is T2.S2 (gate skips terminals).
- [ ] T2.S1 does NOT add the consumeLikeAgentLoop end-to-end assertion (P1.M2.T3.S1); it asserts raw rewritten events.
- [ ] T2.S1 does NOT modify T1.S1's `_frozenPrimaryContent`/`_contentIndexOffset` capture (reads them only).

---

## Anti-Patterns to Avoid

- ❌ Don't write the bare `event.contentIndex`/`event.partial` inside `_rewriteReplacementEvent` from the contract
  verbatim — it is a `tsc` error (terminals lack those props) and FAILS `npm run build`. Narrow with `in` checks.
- ❌ Don't place the gate inside the `isTerminalEvent` block, the `isThinkingEvent` block, or the `forwarding`
  branch. It MUST sit immediately before the final `this._output.push(event)` in the splicing branch — that is the
  ONE point every forwarded replacement event passes through.
- ❌ Don't drop the `_contentIndexOffset > 0` guard — it is what keeps the 386-test placeholder-mock suite green
  (offset 0 → no-op). Don't drop the `"contentIndex" in event` check — it is what keeps terminals out of T2.S1's
  scope (T2.S2 owns the terminal).
- ❌ Don't rewrite the terminal (`done.message`/`error.error`) here — that is P1.M2.T2.S2. The gate skips terminals
  by design.
- ❌ Don't clone the replacement's OWN content blocks — only the FROZEN primary blocks are cloned (`{ ...b }`). The
  replacement's blocks are spread as-is (live accumulating, like a real provider's partial).
- ❌ Don't use `structuredClone` — content blocks are plain data; the contract specifies the shallow-per-block
  `{ ...b }` clone (avoids non-cloneable-field edge cases in other providers).
- ❌ Don't mutate the input event or partial — return a NEW object via spread (`{ ...event, contentIndex, partial }`
  and `{ ...replacementPartial, content: [...] }`).
- ❌ Don't add an EC-017 special-case branch — the replacement's thinking events carry `contentIndex`, fall through
  to the push, hit the gate, and are rewritten automatically (their own thinking blocks land after the frozen
  primary blocks via the merge).
- ❌ Don't assert on the persisted final message or import `consumeLikeAgentLoop` — that is P1.M2.T3.S1. Assert on
  the RAW rewritten events (contentIndex + partial.content) only.
- ❌ Don't re-declare `makeCaptureDiag`/`makeModel`/`waitFor` locally — import them from
  `tests/helpers/invariant-harness.ts`.
- ❌ Don't collect forwarded events by mutating shared state across an un-awaited drain — drain `proxy.output` with
  `for await` AFTER pushing the replacement events (the `done` completes the stream and exits the loop). The
  replacement `start` is suppressed (NOT in the collected array).

---

## Confidence Score: **9/10**

The change is small (1 gate + 2 pure-transform methods), additive, and fully specified: the single insertion point
(`_emit()`'s splicing-branch final push, quoted verbatim with surrounding context), the literal contracts for both
new methods, the tsc-safe `in`-narrowing form (the #1 trap — verified against the pi-ai union at
`node_modules/@earendil-works/pi-ai/dist/types.d.ts`), the offset-0 no-op guard that keeps the 386-test suite green
(the #2 trap — proven), the EC-017 no-special-case proof, the realistic-mock's per-event merged-partial table
(verified), and the test-driving idiom (copied from the shipped T1.S1 capture test) are all inlined. T1.S1's seed
fields are confirmed present and populated before the splicing branch runs. The gate's two conditions cleanly
partition scope: offset-0 → no-op (existing suite), terminals → skipped (T2.S2), non-terminals with offset →
rewritten (this task). Residual risk is only in the exact timing of the test's drain (the mock's iterator re-checks
its queue on a `setTimeout(0)` tick) — addressed by draining AFTER pushing the replacement events and by the
`15ms` orphan-safe startup timeout. T2.S1 does NOT change the terminal, so it cannot regress T2.S2's or T3.S1's
planned behavior; and the offset-0 guard means it cannot regress any existing test.
