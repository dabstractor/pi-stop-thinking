# PRP — P1.M3.T1.S1: Add `_reasoningEnded` flag, set on §22.4 leave-conditions, gate `canInterrupt()` and `triggerStop()`

> **Bugfix**: Stream Integrity & Shortcut Lifecycle — Issue 2 (MAJOR): the shortcut stays armed during
> the answer phase, so pressing Ctrl+. AFTER reasoning ends **aborts the in-progress answer** and
> launches a fresh replacement. This is **Task 1 Step 1** of the Issue-2 fix (Module P1.M3).
>
> **Root cause** (architecture/system_context.md §Issue 2): `ALLOWED_TRANSITIONS`
> (`src/state/controller.ts`) has **no normal `Reasoning → *` exit** (only `StopRequested`/`Failed`).
> `trackEvent()` (`src/provider/proxy.ts`) performs no state change on `thinking_end` /
> `text_start` / `toolcall_start`, so the controller **stays in `Reasoning` for the entire answer
> phase**. `canInterrupt()` returns `state === "Reasoning"` → `true` during the answer → the
> shortcut stays armed.
>
> **The fix — minimal flag approach (NOT the FSM-extension approach).** Per the contract: add a
> proxy-level `private _reasoningEnded = false` flag, set it in `trackEvent()` on the PRD §22.4
> leave-conditions (`thinking_end` OR first answer token `text_start`/`toolcall_start`), and gate
> `canInterrupt()` + `triggerStop()` on it. The FSM (`src/state/controller.ts`) is **UNCHANGED** —
> this avoids breaking `stream-proxy-lifecycle.test.ts` line ~441 which asserts
> `controller.getState() === "Reasoning"` on a normal completion. `trackEvent()` runs **ONLY in the
> primary loop** (before `_emit` in `run()`); replacement events do NOT run `trackEvent` (the buffer
> is frozen during splicing), so the flag correctly applies solely to the primary reasoning phase.
>
> **What this subtask is NOT**: it does NOT extend the FSM (`Reasoning → Answering`) — that would
> break the lifecycle test. It does NOT change `isReasoning()` (that stays a pure FSM delegate —
> telemetry only, per system_context.md). It does NOT add the end-to-end EC-005/EC-006 consumer-harness
> tests — that is **P1.M3.T2.S1**. It does NOT touch the coordinator — that is **P1.M4.T1.S1** (Issue 3).
>
> **Chokepoint**: `src/provider/proxy.ts` — three localized edits (a new private field, one detection
> step inside `trackEvent()`, the `canInterrupt()` body, the `triggerStop()` guard) + JSDoc.

---

## Goal

**Feature Goal**: Disable the "stop thinking" shortcut the moment reasoning ends, so pressing the
shortcut during answer generation (after `thinking_end`, or on the first answer token) is a no-op.
Concretely, once any PRD §22.4 leave-condition fires on the primary stream, `StreamProxy.canInterrupt()`
returns `false` and `triggerStop()` returns `false` (no abort, no replacement, no state change). This
makes the proxy honor EC-005 ("Shortcut during `thinking_end` → Ignore — reasoning already completed"),
EC-006 ("Shortcut during first answer token → Ignore — the model is already answering"), RC-002
("Answer start wins"), and §22.5 ("shortcut active only while `Current State == Reasoning`") without
extending the §16 FSM.

**Deliverable**:
- `src/provider/proxy.ts` — MODIFIED: (1) one new private field `_reasoningEnded`; (2) one detection
  step in `trackEvent()` setting the flag on the §22.4 leave-conditions; (3) `canInterrupt()` body
  changed to `return this._controller.getState() === "Reasoning" && !this._reasoningEnded;`;
  (4) `triggerStop()` guard changed from `this._controller.canInterrupt()` to `this.canInterrupt()`;
  (5) JSDoc updates on `canInterrupt()` and `trackEvent()`. NO changes to the controller FSM,
  `isReasoning()`, `run()`, `_emit`, `_launchReplacement`, `makeErrorAssistantMessage`, `types.ts`,
  or any helper.
- `tests/stream-proxy-reasoning-ended.test.ts` — NEW: a `bun:test` that drives a primary reasoning
  stream with the `makeAbortableUpstream` mock pattern (copied from `tests/stream-proxy-abort.test.ts`)
  and asserts: (a) EC-005 — after `thinking_end`, `canInterrupt()===false` + `triggerStop()===false`
  + no abort/replacement; (b) EC-006 — after `text_start` (first answer token), the same three
  assertions; (c) a sanity check that `canInterrupt()===true` is still true DURING reasoning (before
  any leave-condition) so the happy path is preserved.

**Success Definition**:
- `npm run build` (`tsc`) passes with **zero diagnostics** — this is a real gate (src/ change). The
  flag condition uses the already-imported `isTextEvent`/`isToolCallEvent` guards + a direct
  `event.type === "thinking_end"` compare (NOT `isThinkingEvent`, which would wrongly catch
  `thinking_start`/`thinking_delta`).
- `npm test` (=`bun test`) is green: **0 fail**. Baseline 391 preserved + the new test file. The
  controller is NOT modified, so `stream-proxy-lifecycle.test.ts` line 441
  (`controller.getState() === "Reasoning"`) and `transition-controller.test.ts` stay green, and
  `stream-proxy-abort.test.ts`'s `canInterrupt()` delegation test (line 254 asserts `=== true` during
  Reasoning **before** any leave-condition) stays green.
- `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts` changed; `git status` shows that file
  + the new test file only.

---

## Why

- **Issue 2 root cause (architecture/system_context.md §Issue 2 + PRD §22.4/§22.5/EC-005/EC-006/RC-002)**:
  the §16 FSM models the **interruption lifecycle** and defines NO normal `Reasoning` exit. So a
  non-interrupted stream leaves the controller in `Reasoning` for the whole answer phase. Because
  `canInterrupt()` returned `state === "Reasoning"`, the shortcut stayed armed while the answer
  streamed — pressing Ctrl+. aborted the in-progress answer and launched a SECOND replacement request
  (console-verified in the PRD: after `start → thinking_* → thinking_end → text_start`,
  `triggerStop()` returned `true`, the upstream was aborted, and the replacement call count became 1).
  This contradicts EC-005, EC-006, RC-002, and §22.5.
- **The flag approach is the minimal correct fix (system_context.md "Why the flag approach (not FSM
  extension)")**: extending the FSM (`Reasoning → Answering`) is riskier — it changes §16 semantics
  AND breaks existing tests that assert the controller stays in `Reasoning` on normal completion
  (`stream-proxy-lifecycle.test.ts` line ~441). The flag leaves the FSM untouched and gates ONLY
  shortcut availability → functionally correct, minimal blast radius. The existing 391-test suite
  stays byte-for-byte green.
- **Side benefit**: this also prevents the Issue-1 compounding — a re-aborted answer would be replaced
  by yet another fresh request and the reasoning dropped again. Gating the shortcut disables that path.
- **Why `trackEvent()` is the right place (and why it is safe)**: `trackEvent()` is the per-event
  reasoning-detection side effect that runs BEFORE `_emit` in `run()`'s PRIMARY loop. Replacement
  events NEVER run `trackEvent` (the reasoning buffer is FROZEN during the splicing phase), so the
  flag cannot be (re)set by the replacement stream — it applies solely to the primary reasoning phase.
  Setting a boolean is idempotent, so catching all three leave-conditions in one block is harmless.

## What

A localized additive change to `src/provider/proxy.ts` plus one new test file. Add a private
`_reasoningEnded` boolean (default `false`). In `trackEvent()`, after the `thinking_delta` accumulation
step and before the terminal handling, set it `true` whenever the controller is in `Reasoning` AND the
event is a §22.4 leave-condition (`thinking_end`, `text_start`/`text_delta`/`text_end` via
`isTextEvent`, or `toolcall_start`/`toolcall_delta`/`toolcall_end` via `isToolCallEvent`). Change
`canInterrupt()` to AND in `!_reasoningEnded`. Change the `triggerStop()` guard to call `this.canInterrupt()`
(so the proxy-level gate is enforced at the abort entry point). Update JSDoc. The controller FSM,
`isReasoning()`, and all forwarding/splicing logic are untouched.

### Success Criteria

- [ ] `src/provider/proxy.ts` declares `private _reasoningEnded = false;` (among the other private flags).
- [ ] `trackEvent()` has a new step (AFTER the `thinking_delta` accumulation, BEFORE the terminal
      handling) that sets `this._reasoningEnded = true` when `getState() === "Reasoning"` AND
      (`event.type === "thinking_end" || isTextEvent(event) || isToolCallEvent(event)`).
- [ ] `canInterrupt()` returns `this._controller.getState() === "Reasoning" && !this._reasoningEnded`
      (NOT the old `this._controller.canInterrupt()` delegate).
- [ ] `triggerStop()` guard is `if (!this.canInterrupt()) return false;` (NOT `this._controller.canInterrupt()`).
- [ ] `isReasoning()` is UNCHANGED (still `this._controller.getState() === "Reasoning"`).
- [ ] `src/state/controller.ts` is UNCHANGED (the FSM's own `canInterrupt()` stays `state === "Reasoning"`).
- [ ] New test `tests/stream-proxy-reasoning-ended.test.ts` passes: EC-005 (after `thinking_end`) and
      EC-006 (after `text_start`) both assert `canInterrupt()===false`, `triggerStop()===false`,
      `mock.isAborted()===false`, no `proxy.abort.completed` trace, no replacement call; plus a sanity
      case that `canInterrupt()===true` holds DURING reasoning (before a leave-condition).
- [ ] `npm run build` (tsc) and `npm test` (bun → 0 fail) both green; only `proxy.ts` changed in src/.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact three edit sites (the field declaration neighborhood, the `trackEvent()` insertion
point quoted verbatim with the surrounding step 3 → step 4 boundary, the `canInterrupt()` body, and the
`triggerStop()` guard line), the exact flag condition, the type guards already imported (line 64), the
"do not break" constraints (the lifecycle test line 441 + the abort delegation test line 254), the test
timing discipline (forwarded-event-as-proof that `trackEvent` ran), and the validated commands are all
inlined below. The implementer needs no prior proxy/FSM knowledge beyond what is quoted.

### Documentation & References

```yaml
# MUST READ — the bug + the exact fix strategy
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/system_context.md
  why: "§Issue 2 root cause (no Reasoning exit in ALLOWED_TRANSITIONS → controller stuck in Reasoning
        during the answer → canInterrupt()===true). §Issue 2 'Fix strategy (reasoningEnded flag — minimal,
        low-risk)' lists all 4 code steps verbatim. 'Why the flag approach (not FSM extension)' explains
        WHY the FSM must stay untouched (the lifecycle test line ~441 asserts getState()==='Reasoning')."
  critical: "Establishes that isReasoning() must NOT be changed (telemetry only) and that the flag is set
             ONLY in trackEvent (primary loop; replacement never runs trackEvent). The 4-step contract is
             authoritative — implement it verbatim."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-ai-event-types.md
  why: "§1 confirms thinking_end / text_start / toolcall_start are the non-terminal discriminator types
        (so the flag condition's type guards are correct). Confirms done/error are terminals (handled in
        step 4 of trackEvent, AFTER the new flag step — so they never set the flag, which is intended)."
  critical: "Confirms why event.type === 'thinking_end' must be a DIRECT compare (isThinkingEvent would
             wrongly match thinking_start/thinking_delta — those are NOT leave-conditions)."

# PATTERN files to follow (verified verbatim against current src/)
- file: src/provider/proxy.ts
  why: "THE file being modified. (1) Field decl neighborhood: the private _-flags block (e.g. _upstreamCompleted,
        _messageStartEmitted, _messageEndEmitted, _terminated). (2) trackEvent() (lines ~543–600) — the
        step-numbered detection sequence; the new step goes between step 3 (thinking_delta accumulate) and
        step 4 (terminal handling). (3) canInterrupt() body (lines 328–329). (4) triggerStop() guard (line 356).
        Line 64 already imports isTextEvent + isToolCallEvent (NO new import needed)."
  pattern: "Private-field JSDoc convention (each _flag has a /** ... */ block citing PRD/invariants).
            trackEvent()'s step comments (// 1. // 2. // 2b. // 3. // 4.) — the new step is // 3b. or // 3½.
            canInterrupt() / triggerStop() JSDoc convention (PRD §22.5 cross-refs)."
  gotcha: "Do NOT change isReasoning() (line ~394). Do NOT change _emit, run, _launchReplacement,
           makeErrorAssistantMessage, or the controller. The flag step goes AFTER the thinking_delta
           accumulation (step 3) so that a thinking_delta that ENTERS Reasoning (step 2 flips state) then
           appends in step 3 still happens BEFORE the flag check — correct, since thinking_delta is NOT a
           leave-condition."

- file: src/state/controller.ts
  why: "READ-ONLY — confirms ALLOWED_TRANSITIONS (Reasoning → {StopRequested, Failed} only) so the flag is
        REQUIRED (the FSM genuinely cannot model the normal exit). The CONTROLLER's canInterrupt()
        (line ~) stays `return this.state === 'Reasoning'` — do NOT change it."
  pattern: "No changes here. transition-controller.test.ts tests the controller's own canInterrupt(); it is
            untouched and stays green."
  gotcha: "The PROXY canInterrupt() now diverges from the CONTROLLER canInterrupt() — that is intentional
           and the whole point (the proxy adds the !_reasoningEnded gate; the controller keeps pure FSM state)."

- file: src/types.ts
  why: "Confirms isTextEvent matches {text_start,text_delta,text_end} and isToolCallEvent matches
        {toolcall_start,toolcall_delta,toolcall_end}. The flag condition uses these guards for the answer-token
        leave-conditions, and event.type === 'thinking_end' (direct) for the third."
  pattern: "No new types needed. Both guards are already imported in proxy.ts (line 64)."

- file: tests/stream-proxy-abort.test.ts   # read-only PATTERN — copy the makeAbortableUpstream mock
  why: "The contract mandates using this file's mock pattern. It defines makeAbortableUpstream() locally
        (push(e) + isAborted()) — the isAborted() accessor is how the new test proves 'no abort happened'.
        It also defines makeCaptureDiag/makeModel/ev/waitFor locally (the harness exports the same ones —
        prefer importing from ./helpers/invariant-harness)."
  pattern: "Copy makeAbortableUpstream() verbatim into the new test file (it is NOT exported from the harness).
            Copy the construction idiom: new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag,
            controller, buffer, DEFAULT_CONFIG.transitionTimeoutMs, undefined, <small ms>)."
  gotcha: "makeAbortableUpstream yields pushed events then BLOCKS when the queue is empty (it does not end the
           stream). To let run() exit cleanly at the end of each test, push a terminal (done) and await the
           consumer — the done completes output.result() and the for-await exits. Use waitFor(seen.includes(...))
           as the proof that trackEvent ran on a given event (trackEvent runs BEFORE _emit/push)."

- file: tests/helpers/invariant-harness.ts   # import the shared test doubles
  why: "Exports makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE — import these (do NOT re-declare)."
  pattern: "import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from './helpers/invariant-harness';"
  gotcha: "waitFor(() => proxy.isReasoning()) BEFORE pushing the leave-condition (run must process the thinking
           events and reach Reasoning). Then waitFor(() => seen.includes('thinking_end')) AFTER pushing the
           leave-condition (proves trackEvent ran → flag set). ONLY THEN assert canInterrupt()===false."

- file: tests/stream-proxy-lifecycle.test.ts   # READ-ONLY — the critical 'do not break' test
  why: "Line 441: expect(controller.getState()).toBe('Reasoning') — asserts the FSM stays in Reasoning on a
        normal completion. The flag fix does NOT touch controller state, so this passes. This is WHY the FSM
        must not be extended."
  pattern: "No change needed — it stays green because the controller is untouched."
  gotcha: "If you (wrongly) add a Reasoning→Answering transition to the controller, this test breaks. Don't."
```

### Current Codebase tree (relevant slice)

```bash
src/provider/
└── proxy.ts                     # ← MODIFY: _reasoningEnded field + trackEvent step + canInterrupt + triggerStop
src/state/
└── controller.ts                # READ-ONLY (FSM unchanged — the whole reason for the flag approach)
tests/
├── helpers/
│   └── invariant-harness.ts     # import makeCaptureDiag / makeModel / ev / waitFor / DONE_MESSAGE
├── stream-proxy-abort.test.ts   # read-only PATTERN (makeAbortableUpstream mock + construction idiom)
├── stream-proxy-lifecycle.test.ts  # read-only (line 441 'do not break' assertion)
└── (stream-proxy-reasoning-ended.test.ts)  # ← NEW (this subtask)
```

### Desired Codebase tree with file responsibilities

```bash
src/provider/proxy.ts                       # MODIFIED — _reasoningEnded flag + trackEvent leave-condition
                                           #   detection + canInterrupt()/triggerStop() gating. Disables the
                                           #   shortcut once reasoning ends (§22.4) without touching the FSM.
tests/stream-proxy-reasoning-ended.test.ts # NEW — EC-005 (thinking_end) + EC-006 (text_start) unit tests:
                                           #   drive a primary reasoning stream with makeAbortableUpstream,
                                           #   assert canInterrupt()===false + triggerStop()===false + no
                                           #   abort/replacement after each leave-condition; sanity-check
                                           #   canInterrupt()===true DURING reasoning (happy path preserved).
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (the FSM MUST stay unchanged — the #1 trap): do NOT add a Reasoning→Answering (or →Completed)
// transition to src/state/controller.ts. The flag approach exists PRECISELY because §16 defines no normal
// Reasoning exit, and tests/stream-proxy-lifecycle.test.ts line 441 asserts getState()==='Reasoning' on a
// normal completion. If you extend the FSM, that test (and transition-controller.test.ts) break. The proxy's
// _reasoningEnded flag is a ROUTING/gating flag (like _upstreamCompleted/_messageStartEmitted), NOT an FSM
// state — PRD Appendix F's "no boolean lifecycle flags" rule applies to TransitionState, not these internal
// proxy routing counters (the proxy already uses several such _-flags; see the proxy.ts class doc).

// CRITICAL (canInterrupt() vs the CONTROLLER's canInterrupt() — the #2 trap): the PROXY canInterrupt() and
// the CONTROLLER canInterrupt() now DIVERGE — intentionally. The proxy adds `&& !_reasoningEnded`; the
// controller keeps `state === "Reasoning"`. The coordinator/ShortcutManager reach the proxy (not the controller),
// so they get the gated result. transition-controller.test.ts tests the CONTROLLER's method (unchanged) → stays
// green. Do NOT make the proxy canInterrupt() delegate to the controller any more.

// CRITICAL (triggerStop guard — the #3 trap): change `if (!this._controller.canInterrupt()) return false;` to
// `if (!this.canInterrupt()) return false;` (note `this.` not `this._controller.`). If you leave the controller
// check, the proxy-level flag gate is bypassed at the abort entry point and the bug persists even after fixing
// canInterrupt(). The rest of triggerStop() (requestStop / beginAbort / _internalAbort.abort /
// _startAbortTimeout / return true) is UNCHANGED — it only runs after the new gate passes, which it now never
// does once reasoning has ended.

// CRITICAL (use event.type === "thinking_end", NOT isThinkingEvent — the #4 trap): isThinkingEvent matches
// thinking_start | thinking_delta | thinking_end. thinking_delta is NOT a leave-condition (it is reasoning
// STILL flowing). So use a direct `event.type === "thinking_end"` compare for the third condition. isTextEvent
// and isToolCallEvent are correct as-is (every text_*/toolcall_* event is a "first answer token" class signal
// and is a leave-condition; subsequent tokens re-set the boolean harmlessly).

// CRITICAL (insert AFTER step 3, BEFORE step 4 in trackEvent — the #5 trap): the new flag step goes between
// `// 3. Accumulate reasoning deltas while Reasoning` (the this._buffer.append(event.delta) block) and
// `// 4. Terminals` (the if (event.type === "error") block). Rationale: a thinking_delta that ENTERS Reasoning
// (step 2 flips Delegating→Reasoning) then appends in step 3 must finish BEFORE the flag check — and thinking_delta
// is not a leave-condition anyway, so order is correct. The flag step must NOT run after the terminal step
// (done/error are not leave-conditions here; the contract limits the flag to thinking_end/text_*/toolcall_*).

// CRITICAL (trackEvent runs ONLY in the PRIMARY loop — the #6 trap, why the flag is safe): trackEvent() is
// called in run()'s for-await BEFORE _emit (line ~702). Replacement events are iterated in _launchReplacement()
// and pass through _emit ONLY — they NEVER call trackEvent (the reasoning buffer is FROZEN during splicing, and
// the JSDoc on _emit states "This method NEVER calls trackEvent"). Therefore _reasoningEnded can only ever be
// set by the PRIMARY reasoning phase; a replacement stream cannot re-arm or reset it. No reset-on-replacement
// logic is needed (and none exists — the flag is per-request, created fresh each StreamProxy construction).

// CRITICAL (timing in the test — forwarded event = proof trackEvent ran — the #7 trap): trackEvent(event) runs
// BEFORE _emit(event)/this._output.push(event) in run()'s loop. So once an event appears in the drained
// proxy.output, trackEvent has ALREADY run on it → the flag is set. The test must NOT assert canInterrupt()
// synchronously after mock.push(thinking_end) — run() has not processed it yet. Use
// `await waitFor(() => seen.includes("thinking_end"))` (draining output concurrently) as the proof, THEN assert.

// GOTCHA (isReasoning() is UNCHANGED — telemetry only): do NOT add `&& !_reasoningEnded` to isReasoning()
// (line ~394). system_context.md is explicit: isReasoning() continues to reflect FSM state for TELEMETRY, not
// shortcut gating. Changing it would alter telemetry semantics and is out of scope. Only canInterrupt() (the
// shortcut-availability API) is gated.

// GOTCHA (makeAbortableUpstream blocks forever when its queue empties): to let each test's run() exit cleanly
// without a dangling handle, push a `done` terminal and await the consumer at the end (done completes
// output.result() and the for-await exits). Alternatively call done via mock.push(ev({ type:'done', ... })).

// GOTCHA (bun is not on PATH): run tests via `npm test` or `./node_modules/.bin/bun test ...`. `npm run build`
// runs `tsc` (the src/ type gate). Baseline = 391 pass / 0 fail at HEAD.

// SCOPE: do NOT touch src/state/controller.ts, isReasoning(), run(), _emit, _launchReplacement,
// makeErrorAssistantMessage, types.ts, any helper, or the coordinator. git diff --stat -- src/ shows ONLY
// proxy.ts. Do NOT add end-to-end consumer tests (P1.M3.T2.S1) or coordinator changes (P1.M4.T1.S1).
```

---

## Implementation Blueprint

### Data models and structure

No new types. One new private boolean field on `StreamProxy`. The change is logic-only (a gate + a
side-effect flag); it introduces no new data structures, no new imports (`isTextEvent` /
`isToolCallEvent` are already imported at proxy.ts line 64), and no API surface changes.

```typescript
// (new private field on StreamProxy — a routing/gating flag, NOT an FSM state)
private _reasoningEnded = false;
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — add the _reasoningEnded field
  - IMPLEMENT: `private _reasoningEnded = false;` with a /** */ JSDoc block citing P1.M3.T1.S1, PRD §22.4
    (leave-conditions) + §22.5 (shortcut active only while Reasoning), and noting it is set in trackEvent
    (primary loop only) and consumed by canInterrupt()/triggerStop().
  - FOLLOW pattern: the existing private _-flag declarations (e.g. _upstreamCompleted, _messageStartEmitted,
    _terminated) — each has a JSDoc block explaining its purpose, who sets it, who reads it.
  - NAMING: _reasoningEnded (matches the work-item contract + system_context.md exactly).
  - PLACEMENT: among the other private _-flags (a natural home is adjacent to _upstreamCompleted /
    _messageStartEmitted / _messageEndEmitted, since it is another primary-loop signal). PRIVATE (the
    contract names it `private _reasoningEnded`).
  - DEPENDENCIES: none (default false; set in Task 2; read in Tasks 3–4).

Task 2: MODIFY src/provider/proxy.ts — add the §22.4 leave-condition detection step in trackEvent()
  - EDIT trackEvent(): insert a new detection step AFTER step 3 (`// 3. Accumulate reasoning deltas while
    Reasoning` — the `if (event.type === "thinking_delta" && this._controller.getState() === "Reasoning")`
    block that calls this._buffer.append(event.delta)) and BEFORE step 4 (`// 4. Terminals` — the
    `if (event.type === "error")` block). Verbatim:
        // 3b. P1.M3.T1.S1 — set the reasoningEnded flag on the PRD §22.4 leave-conditions. The §16 FSM has
        //     NO normal Reasoning→* exit, so this is a pure proxy-level flag; trackEvent() runs ONLY in the
        //     primary loop (replacement events never run trackEvent — the buffer is frozen), so the flag
        //     applies solely to the primary reasoning phase. Setting a boolean is idempotent, so catching all
        //     three conditions (thinking_end / first answer token) here is harmless.
        if (
          this._controller.getState() === "Reasoning" &&
          (event.type === "thinking_end" || isTextEvent(event) || isToolCallEvent(event))
        ) {
          this._reasoningEnded = true;
        }
  - FOLLOW pattern: the step-numbered comment convention inside trackEvent() (// 1. // 2. // 2b. // 3. …).
  - NAMING: the comment label `// 3b.` (between step 3 and step 4).
  - CRITICAL: use `event.type === "thinking_end"` (direct) — NOT isThinkingEvent (which wrongly matches
    thinking_start/thinking_delta). isTextEvent/isToolCallEvent are correct (already imported line 64).
  - CRITICAL: insert AFTER step 3 (so a thinking_delta entering Reasoning via step 2 still appends in step 3
    first) and BEFORE step 4 (terminals). Do NOT reorder existing steps.
  - DEPENDENCIES: Task 1 (_reasoningEnded) + the already-imported isTextEvent/isToolCallEvent.
  - PRESERVE: steps 1, 2, 2b, 3, 4 unchanged; the NOTE block about §22.4 at the end of trackEvent can stay
    (or be lightly updated to reference the flag — see Task 5).

Task 3: MODIFY src/provider/proxy.ts — gate canInterrupt() on the flag
  - EDIT canInterrupt() (lines 328–329): change
        return this._controller.canInterrupt();
    to
        return this._controller.getState() === "Reasoning" && !this._reasoningEnded;
  - FOLLOW pattern: the existing one-liner getter style; update its JSDoc (Task 5) to document the flag +
    §22.4 leave-conditions + that this now DIVERGES from the controller's canInterrupt() (proxy adds the gate).
  - NAMING: unchanged method name; just the body.
  - CRITICAL: the result is `state === "Reasoning" && !reasoningEnded` (per system_context.md step 3).
    During Reasoning before any leave-condition, flag is false → returns true (happy path preserved → the
    abort test line 254 assertion holds). After a leave-condition, flag is true → returns false.
  - DEPENDENCIES: Task 1 (_reasoningEnded).

Task 4: MODIFY src/provider/proxy.ts — route the triggerStop() guard through this.canInterrupt()
  - EDIT triggerStop() guard (line 356): change
        if (!this._controller.canInterrupt()) return false; // (a) PRD §22.5 — not in Reasoning
    to
        if (!this.canInterrupt()) return false; // (a) PRD §22.5 — not in Reasoning (gated on _reasoningEnded)
  - FOLLOW pattern: the existing guard comment; the rest of triggerStop() (requestStop/beginAbort/
    _internalAbort.abort/_startAbortTimeout/return true) is UNCHANGED — it now simply never runs once
    reasoning has ended (the gate short-circuits before it).
  - NAMING: unchanged; just the guard condition.
  - CRITICAL: `this.canInterrupt()` (proxy) — NOT `this._controller.canInterrupt()`. This is the abort entry
    point; the proxy-level flag gate MUST be enforced here, else the bug persists despite Task 3.
  - DEPENDENCIES: Task 3 (the new canInterrupt() body).

Task 5: MODIFY src/provider/proxy.ts — update JSDoc on canInterrupt() and trackEvent() [Mode A docs ride-with]
  - EDIT the JSDoc above canInterrupt(): replace "Pure delegate to the FSM." with text documenting that it
    returns true ONLY while Reasoning AND reasoning has not yet ended (§22.4 leave-conditions), that it
    diverges from the controller's canInterrupt() (the proxy adds the _reasoningEnded gate), and that it is
    the shortcut-availability API (§22.5).
  - EDIT the JSDoc/class NOTE in trackEvent() (or the §22.4 NOTE block at its end): reference the new
    _reasoningEnded flag + §22.4 leave-conditions, and note trackEvent runs ONLY in the primary loop so the
    flag is primary-phase-only.
  - FOLLOW pattern: the existing JSDoc convention (PRD § + P-subtask cross-refs; privacy note where relevant).
  - DEPENDENCIES: Tasks 1–4. (Lightweight text edits; no logic.)

Task 6: CREATE tests/stream-proxy-reasoning-ended.test.ts — EC-005 / EC-006 unit tests (TDD)
  - IMPLEMENT: a bun:test with 3 tests (EC-005 after thinking_end; EC-006 after text_start; sanity that
    canInterrupt()===true DURING reasoning). Uses makeAbortableUpstream (copied from stream-proxy-abort.test.ts)
    so it exposes isAborted() (proves no abort). Imports makeCaptureDiag/makeModel/ev/waitFor/DONE_MESSAGE
    from ./helpers/invariant-harness.
  - FOLLOW pattern: tests/stream-proxy-abort.test.ts — its imports, its makeAbortableUpstream mock, its
    construction idiom, its "normal forwarding regression" concurrent-consumer drain idiom (for-await over
    proxy.output into seen[]).
  - IMPORTS:
      import { describe, test, expect } from "bun:test";
      import { StreamProxy } from "../src/provider/proxy";
      import { TransitionController } from "../src/state/controller";
      import { ReasoningBuffer } from "../src/buffer";
      import { DEFAULT_CONFIG } from "../src/config";
      import type { AssistantMessageEvent, ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
      import type { Diagnostics } from "../src/diagnostics";
      import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from "./helpers/invariant-harness";
  - MOCK (copy makeAbortableUpstream verbatim from tests/stream-proxy-abort.test.ts — it is NOT exported from
    the harness; the contract mandates using this file's mock pattern). It yields queued events and, when its
    injected signal aborts, throws (replicating a real provider abort). Exposes push(e) + isAborted().
  - SCENARIO A — EC-005 (shortcut after thinking_end):
      a. const { diag, events } = makeCaptureDiag(); const controller = new TransitionController(diag);
         const buffer = new ReasoningBuffer(diag, 1_000_000); const mock = makeAbortableUpstream();
         const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
           DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15);
      b. Start a concurrent consumer draining proxy.output into `const seen: string[] = []`:
         const consumer = (async () => { for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type); })();
      c. Drive to Reasoning: mock.push(ev({ type: "start" }));
         mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
         mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
         await waitFor(() => proxy.isReasoning());
      d. SANITY (happy path preserved): expect(proxy.canInterrupt()).toBe(true);   // armed DURING reasoning
      e. Push the §22.4 leave-condition: mock.push(ev({ type: "thinking_end", contentIndex: 0, content: "thinking..." }));
         await waitFor(() => seen.includes("thinking_end"));   // trackEvent ran on it (it ran BEFORE the push) → flag set
      f. THE FIX assertions: expect(proxy.canInterrupt()).toBe(false);   // reasoning ended → disabled
         expect(proxy.triggerStop()).toBe(false);                // no abort dispatched
         expect(mock.isAborted()).toBe(false);                   // upstream NOT aborted
         expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false);  // no abort path taken
      g. Let the stream finish cleanly: mock.push(ev({ type: "text_start", contentIndex: 1 }));
         mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
         await consumer;   // done completes output → for-await exits; no dangling handle
  - SCENARIO B — EC-006 (shortcut on first answer token):
      Same setup as A, but after reaching Reasoning push the answer token FIRST (no thinking_end):
         mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
         mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
         await waitFor(() => proxy.isReasoning());
         expect(proxy.canInterrupt()).toBe(true);                 // sanity
         mock.push(ev({ type: "text_start", contentIndex: 1 }));  // EC-006: first answer token
         await waitFor(() => seen.includes("text_start"));        // trackEvent ran → flag set
         expect(proxy.canInterrupt()).toBe(false);                // THE FIX
         expect(proxy.triggerStop()).toBe(false);
         expect(mock.isAborted()).toBe(false);
         expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false);
         mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE })); await consumer;
  - SCENARIO C — sanity (toolcall_start leave-condition — optional third assertion mirroring EC-006 with a
      tool-call-first answer token; same shape as B but push ev({ type: "toolcall_start", contentIndex: 1 })):
      optional but recommended — proves the toolcall_* arm of the condition works.
  - NAMING: group under `describe("StreamProxy — reasoningEnded flag (P1.M3.T1.S1 / Issue 2)")`. Test names:
      "EC-005: canInterrupt()/triggerStop() disabled after thinking_end (no abort/replacement)";
      "EC-006: canInterrupt()/triggerStop() disabled on first answer token (no abort/replacement)";
      "sanity: canInterrupt()===true DURING reasoning before any leave-condition".
  - COVERAGE: the three §22.4 leave-condition arms that this subtask sets the flag on (thinking_end via A,
      text_start via B, toolcall_start via optional C); the gate in canInterrupt(); the gate in triggerStop();
      the no-abort/no-replacement outcome. Do NOT add end-to-end consumer assertions (P1.M3.T2.S1).
  - PLACEMENT: tests/stream-proxy-reasoning-ended.test.ts.
```

### Implementation Patterns & Key Details

```typescript
// src/provider/proxy.ts — the field + the trackEvent step + the two gating edits (verbatim).

// NEW FIELD (place among the private _-flags):
/**
 * P1.M3.T1.S1 (Issue 2) — set `true` in {@link trackEvent} on a PRD §22.4 reasoning leave-condition
 * (`thinking_end` OR the first answer token `text_*`/`toolcall_*`) while the controller is in `Reasoning`.
 * Consumed by {@link canInterrupt} (and, via it, {@link triggerStop}) to DISABLE the shortcut once reasoning
 * has ended. The §16 FSM has NO normal `Reasoning` exit, so this is a proxy-level gate — NOT an FSM state
 * (PRD Appendix F's "no boolean lifecycle flags" rule governs `TransitionState`, not these internal routing
 * counters; see `_upstreamCompleted`/`_messageStartEmitted`). `trackEvent` runs ONLY in the primary loop
 * (`run`'s for-await, before `_emit`); replacement events NEVER run `trackEvent` (the buffer is frozen), so
 * the flag applies solely to the primary reasoning phase. Per-request (fresh per `StreamProxy` construction);
 * never reset (a replacement stream cannot re-arm reasoning). See PRD §22.4/§22.5/EC-005/EC-006/RC-002.
 */
private _reasoningEnded = false;

// EDIT 1 — trackEvent(), after step 3 (thinking_delta accumulate) and before step 4 (terminals):
      // 3. Accumulate reasoning deltas while Reasoning (PRD §13.4/§23.2). …
      if (event.type === "thinking_delta" && this._controller.getState() === "Reasoning") {
        this._buffer.append(event.delta);
      }
      // 3b. P1.M3.T1.S1 (Issue 2) — set the reasoningEnded flag on the PRD §22.4 leave-conditions. The §16 FSM
      //     has NO normal Reasoning→* exit, so this is a pure proxy-level flag; trackEvent() runs ONLY in the
      //     primary loop (replacement events never run trackEvent — the buffer is frozen), so the flag applies
      //     solely to the primary reasoning phase. `event.type === "thinking_end"` is a DIRECT compare (NOT
      //     isThinkingEvent, which would wrongly match thinking_start/thinking_delta). Setting a boolean is
      //     idempotent, so catching all three conditions here is harmless.
      if (
        this._controller.getState() === "Reasoning" &&
        (event.type === "thinking_end" || isTextEvent(event) || isToolCallEvent(event))
      ) {
        this._reasoningEnded = true;
      }
      // 4. Terminals (PRD §16). …
      if (event.type === "error") { … }

// EDIT 2 — canInterrupt() (lines 328–329):
  /** Shortcut availability: `true` ONLY while `Reasoning` AND reasoning has not yet ended (PRD §22.5 + §22.4).
   *  P1.M3.T1.S1 (Issue 2): gates on {@link _reasoningEnded} so the shortcut disables the moment reasoning
   *  ends (on `thinking_end` OR the first answer token). This DIVERGES from the controller's `canInterrupt()`
   *  (the proxy adds the `!_reasoningEnded` gate; the controller keeps pure FSM state for transition legality).
   *  {@link isReasoning} is NOT gated (telemetry-only, pure FSM delegate). */
  canInterrupt(): boolean {
    return this._controller.getState() === "Reasoning" && !this._reasoningEnded;
  }

// EDIT 3 — triggerStop() guard (line 356):
  triggerStop(): boolean {
    if (!this.canInterrupt()) return false; // (a) PRD §22.5 — not in Reasoning (P1.M3.T1.S1: gated on _reasoningEnded)
    this._controller.requestStop();  // (b) … (rest unchanged)
    …
```

```typescript
// tests/stream-proxy-reasoning-ended.test.ts — EC-005 / EC-006 (sketch; fill from the task list).
import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import type { AssistantMessageEvent, ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";
import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from "./helpers/invariant-harness";

// makeAbortableUpstream — copied VERBATIM from tests/stream-proxy-abort.test.ts (not exported by the harness).
function makeAbortableUpstream() { /* …yields queued events; throws on signal.abort; exposes push()+isAborted()… */ }

describe("StreamProxy — reasoningEnded flag (P1.M3.T1.S1 / Issue 2)", () => {
  test("EC-005: canInterrupt()/triggerStop() disabled after thinking_end (no abort/replacement)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeAbortableUpstream();
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15);
    const seen: string[] = [];
    const consumer = (async () => { for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type); })();

    mock.push(ev({ type: "start" }));
    mock.push(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.push(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());
    expect(proxy.canInterrupt()).toBe(true); // sanity: armed DURING reasoning (happy path preserved)

    mock.push(ev({ type: "thinking_end", contentIndex: 0, content: "thinking..." }));
    await waitFor(() => seen.includes("thinking_end")); // trackEvent ran BEFORE the forward → flag set

    expect(proxy.canInterrupt()).toBe(false);        // THE FIX — disabled after reasoning ends
    expect(proxy.triggerStop()).toBe(false);         // THE FIX — no abort dispatched
    expect(mock.isAborted()).toBe(false);            // upstream NOT aborted
    expect(events.some((c) => c.event === "proxy.abort.completed")).toBe(false); // no abort path

    mock.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE })); await consumer; // clean exit
  });

  test("EC-006: canInterrupt()/triggerStop() disabled on first answer token (no abort/replacement)", async () => {
    // same setup; after reaching Reasoning push text_start (NO thinking_end), waitFor(seen includes "text_start"),
    // assert canInterrupt()===false + triggerStop()===false + isAborted()===false + no proxy.abort.completed.
  });

  test("sanity: canInterrupt()===true DURING reasoning before any leave-condition", async () => {
    // drive to Reasoning; assert canInterrupt()===true + (optionally) triggerStop()===true then let it settle.
  });
});
```

### Integration Points

```yaml
PRODUCTION CODE:
  - modify file: src/provider/proxy.ts
      - add private field: _reasoningEnded: boolean (default false)
      - trackEvent(): add step 3b (the §22.4 leave-condition flag set) between step 3 and step 4
      - canInterrupt(): body → `this._controller.getState() === "Reasoning" && !this._reasoningEnded`
      - triggerStop(): guard → `if (!this.canInterrupt()) return false;`
      - JSDoc updates on canInterrupt() + trackEvent()
  - NOT modified: src/state/controller.ts (FSM unchanged — the whole reason for the flag approach),
    src/types.ts, src/buffer/*, src/request/*, src/state/coordinator.ts, src/provider/decorator.ts, src/index.ts.
    git diff --stat -- src/ shows ONLY proxy.ts. isReasoning() is UNCHANGED.

TEST CODE:
  - add file: tests/stream-proxy-reasoning-ended.test.ts (2–3 tests: EC-005, EC-006, sanity; optional toolcall_start).

BUILD/CONFIG: NONE. tsconfig.json already compiles src/ (the tsc gate). No package.json changes. No new deps.
  No new imports in proxy.ts (isTextEvent/isToolCallEvent already imported line 64).

DOWNSTREAM (do NOT wire now — this subtask's output is consumed by these):
  - P1.M3.T2.S1: end-to-end EC-005/EC-006 tests via the consumer harness (consumeLikeAgentLoop) asserting the
    shortcut returns false AND no abort/replacement through the full real-consumer path. Layers on this flag.
  - P1.M4.T1.S1 (Issue 3): coordinator guarded clearActiveProxy — independent; no overlap with the flag.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# THE PRIMARY GATE — this is a src/ change, so tsc MUST pass. No new types/imports, so this is low-risk;
# the main thing to verify is that isTextEvent/isToolCallEvent resolve (already imported line 64).
npm run build
# Expected: 0 diagnostics.

npm run typecheck   # = tsc --noEmit — equivalent gate; 0 diagnostics.

# Confirm ONLY proxy.ts changed in src/ and the new test was added:
git diff --stat -- src/            # Expected: src/provider/proxy.ts only
git status --short -- tests/       # Expected: ?? tests/stream-proxy-reasoning-ended.test.ts (and nothing else)
```

### Level 2: Unit Tests (Component Validation)

```bash
# Run the new reasoningEnded test in isolation:
npm test tests/stream-proxy-reasoning-ended.test.ts
# Expected: 2–3 passing. EC-005: canInterrupt()===false + triggerStop()===false after thinking_end (no abort).
#   EC-006: same after text_start. Sanity: canInterrupt()===true DURING reasoning.

# Full suite — confirms the controller is untouched (no §16 change) so lifecycle + abort + controller tests pass:
npm test
# Expected: 0 fail (baseline 391 + the new tests). 0 FAIL is the hard gate.
# NOTE: stream-proxy-rewrite.test.ts's realistic-mock main case is timing-sensitive and has been seen to flake to
#   1 fail on rare runs (a sibling-task artifact, NOT this subtask). If a SINGLE timing flake appears there,
#   re-run `npm test`; do not treat it as a regression from this change.
```

### Level 3: Regression (the fix does not disturb existing gating/abort/lifecycle behavior)

```bash
# The critical 'do not break' suite — controller untouched + canInterrupt() still true DURING reasoning:
npm test tests/stream-proxy-lifecycle.test.ts   # line 441 getState()==='Reasoning' still holds (FSM unchanged)
npm test tests/stream-proxy-abort.test.ts       # line 254 canInterrupt()===true during Reasoning still holds
npm test tests/transition-controller.test.ts    # the CONTROLLER's canInterrupt() (unchanged) still passes
# Expected: all pass — proof the flag did not change controller state or pre-leave-condition shortcut availability.

# The property/stress/chaos/regression suites (INV-004 ≤1 interruption) — the flag only makes canInterrupt()
# stricter, so interruption is still allowed exactly once during reasoning and never after:
npm test tests/regression-tests.test.ts tests/stress-tests.test.ts tests/chaos-tests.test.ts tests/property-tests.test.ts
# Expected: all pass.
```

### Level 4: Domain-Specific Validation (Flag/Gating Contract Audit)

```bash
# Audit the exact fix is present and correct in proxy.ts:
grep -n "private _reasoningEnded"                       src/provider/proxy.ts   # → field decl (≥1)
grep -n "this._reasoningEnded = true"                   src/provider/proxy.ts   # → set in trackEvent (≥1)
grep -n "event.type === \"thinking_end\" || isTextEvent(event) || isToolCallEvent(event)" src/provider/proxy.ts  # → the §22.4 condition (≥1)
grep -n "!this._reasoningEnded"                         src/provider/proxy.ts   # → canInterrupt gate (≥1)
grep -n "if (!this.canInterrupt()) return false"        src/provider/proxy.ts   # → triggerStop guard (≥1)
# Confirm the controller was NOT touched (the FSM must stay unchanged — the lifecycle test depends on it):
git diff --stat -- src/state/                         # Expected: EMPTY (no changes)
grep -n "return this.state === \"Reasoning\""          src/state/controller.ts  # → CONTROLLER canInterrupt unchanged (≥1)

# Confirm the new test drives the real proxy and asserts the gating outcome:
grep -n "makeAbortableUpstream\|isAborted"             tests/stream-proxy-reasoning-ended.test.ts  # → mock + no-abort assertion (≥2)
grep -n "canInterrupt()"                               tests/stream-proxy-reasoning-ended.test.ts  # → false-after-leave + true-during assertions (≥3)
grep -n "proxy.triggerStop()"                          tests/stream-proxy-reasoning-ended.test.ts  # → ===false assertions (≥2)
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npm run build` (tsc) → 0 diagnostics.
- [ ] `npm run typecheck` → 0 diagnostics.
- [ ] `npm test` full suite green (0 fail). Baseline 391 preserved; +2–3 new tests.
- [ ] `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts`; `git diff --stat -- src/state/` is EMPTY.

### Feature Validation
- [ ] `proxy.ts` declares `private _reasoningEnded = false;` (named exactly per the contract).
- [ ] `trackEvent()` has step 3b setting `_reasoningEnded = true` when `getState()==="Reasoning"` AND
      (`event.type === "thinking_end" || isTextEvent(event) || isToolCallEvent(event)`), AFTER step 3 / BEFORE step 4.
- [ ] `canInterrupt()` returns `this._controller.getState() === "Reasoning" && !this._reasoningEnded`.
- [ ] `triggerStop()` guard is `if (!this.canInterrupt()) return false;` (proxy gate, not controller check).
- [ ] New test passes: after `thinking_end` (EC-005) AND after `text_start` (EC-006),
      `canInterrupt()===false`, `triggerStop()===false`, `mock.isAborted()===false`, no `proxy.abort.completed`.
- [ ] Sanity case: `canInterrupt()===true` DURING reasoning (before any leave-condition) — happy path preserved.

### Code Quality & Documentation
- [ ] New field follows the private _-flag JSDoc convention (cites P1.M3.T1.S1 + PRD §22.4/§22.5 + that it is
      primary-loop-only and per-request).
- [ ] `canInterrupt()`/`trackEvent()` JSDoc updated (Mode A docs ride-with) — documents the flag, the §22.4
      leave-conditions, and the proxy-vs-controller divergence.
- [ ] Privacy (Appendix H) preserved — no new diagnostics; no content logged.
- [ ] No changes to `isReasoning()`, the controller FSM, `_emit`, `run`, `_launchReplacement`,
      `makeErrorAssistantMessage`, `types.ts`, helpers, or the coordinator.

### Scope Discipline (cohesion — do not harm sibling work items)
- [ ] The controller FSM is UNCHANGED (the lifecycle test line 441 depends on it; the FSM-extension alternative
      is explicitly rejected by the contract).
- [ ] No end-to-end consumer tests added (that is P1.M3.T2.S1).
- [ ] No coordinator changes (that is P1.M4.T1.S1 / Issue 3).

---

## Anti-Patterns to Avoid

- ❌ Don't extend the FSM with a `Reasoning → Answering` transition — it breaks `stream-proxy-lifecycle.test.ts`
  line 441 and `transition-controller.test.ts`. The flag approach is mandated precisely to avoid this.
- ❌ Don't gate `isReasoning()` on the flag — it is telemetry-only (pure FSM delegate); only `canInterrupt()`
  (the shortcut-availability API) is gated.
- ❌ Don't leave the `triggerStop()` guard calling `this._controller.canInterrupt()` — that bypasses the proxy
  flag gate at the abort entry point and the bug persists. Use `this.canInterrupt()`.
- ❌ Don't use `isThinkingEvent` for the leave-condition (it wrongly matches `thinking_start`/`thinking_delta`);
  use `event.type === "thinking_end"` directly.
- ❌ Don't assert `canInterrupt()` synchronously after pushing `thinking_end`/`text_start` — `run()` processes
  events asynchronously. Wait for the forwarded event (`seen.includes(...)`) to prove `trackEvent` ran.
- ❌ Don't reset `_reasoningEnded` on the replacement stream — `trackEvent` never runs for replacement events, so
  the flag is inherently primary-phase-only; no reset logic is needed.
- ❌ Don't catch all exceptions broadly or add diagnostics that log content — no new diagnostics are introduced.

---

## Confidence Score

**9/10** — one-pass implementation success likelihood. The change is small (1 field + 1 detection step + 2
one-line gating edits + JSDoc), the type guards are already imported, the "do not break" constraints are
explicitly enumerated (lifecycle line 441, abort delegation line 254, controller-unchanged), and the test
timing discipline (forwarded-event-as-proof) is fully specified. The only residual risk is a test-timing flake
in the unrelated sibling `stream-proxy-rewrite.test.ts` (a known realistic-mock timing artifact) — re-running
`npm test` resolves it and it is not caused by this subtask.
