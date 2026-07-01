# PRP — P1.M3.T2.S1: Add EC-005 / EC-006 end-to-end tests (via `TransitionCoordinator.requestStop()`) asserting the shortcut returns `false` and no abort/replacement occurs

> **Bugfix**: Stream Integrity & Shortcut Lifecycle — Issue 2 (MAJOR). This is **Task 2 Step 1** of the
> Issue-2 fix (Module P1.M3). **P1.M3.T1.S1 (the production fix — the `_reasoningEnded` flag + the
> `canInterrupt()`/`triggerStop()` gates) is COMPLETE and LIVE in `src/provider/proxy.ts`.** This
> subtask is **TEST-ONLY**: it adds the end-to-end regression guard that the PRD §2.4 "Areas needing more
> attention" demands and that T1.S1 deliberately deferred ("Do NOT add end-to-end consumer assertions
> (P1.M3.T2.S1)").
>
> **What this subtask is NOT**: it does NOT touch any production code (`git diff --stat -- src/` is EMPTY).
> It does NOT duplicate T1.S1's unit tests (those live in `tests/stream-proxy-reasoning-ended.test.ts`
> and exercise `proxy.canInterrupt()`/`triggerStop()` directly with a single-call mock and NO coordinator).
> It does NOT add coordinator overlap-guard tests (that is P1.M4.T1.S1 / Issue 3). It does NOT add
> consumer-message-assembly assertions (that is P1.M2.T3.S1, COMPLETE).
>
> **The end-to-end delta over T1.S1**: (1) wire a **`TransitionCoordinator`** and assert the real
> `coordinator.requestStop()` → `false` path (the entry point the `ShortcutManager` actually uses —
> T1.S1 never reaches it because it omits the coordinator); (2) use a **two-phase** mock so we can prove
> the **replacement call count stays 0** (T1.S1's `makeAbortableUpstream` is single-call and cannot).
>
> **Chokepoint**: ONE new file `tests/shortcut-lifecycle.test.ts` — a coordinator-wired, two-phase-mock
> end-to-end test with three scenarios (EC-005, EC-006, positive control).

---

## Goal

**Feature Goal**: Provide a deterministic, regression-guarding end-to-end test proving that once the
primary reasoning stream hits any PRD §22.4 leave-condition (`thinking_end` OR the first answer token
`text_start`/`toolcall_start`), the shortcut is **disabled through the real coordinator → proxy stack**:
pressing Ctrl+. (a) returns `false` from BOTH `proxy.triggerStop()` and `coordinator.requestStop()`,
(b) does NOT abort the in-progress upstream stream, and (c) does NOT launch a fresh replacement request.
Plus a positive control proving the shortcut is STILL armed (returns `true`) while genuinely mid-reasoning
(before any leave-condition) — so the flag is proven to disable *only* after reasoning ends, not earlier.

**Deliverable**:
- `tests/shortcut-lifecycle.test.ts` — NEW: a `bun:test` with 3 tests:
  - **EC-005** — drive `start → thinking_start[0] → thinking_delta[0] → thinking_end`, then
    `proxy.triggerStop() === false`, `coordinator.requestStop() === false`, upstream NOT aborted
    (`mock.isPrimaryAborted() === false`), replacement call count is 0 (`mock.calls.length === 0`).
  - **EC-006** — drive `start → thinking_start[0] → thinking_delta[0] → text_start` (first answer token,
    NO `thinking_end`), then the same four assertions.
  - **POSITIVE control** — drive `start → thinking_start[0] → thinking_delta[0]` (still reasoning, NO
    leave-condition), then `proxy.triggerStop() === true` (shortcut still armed), upstream IS aborted,
    replacement IS launched (`mock.calls.length === 1`); then complete the replacement cleanly.
  - Uses the coordinator wiring idiom from `tests/stream-proxy-pending-stop.test.ts` (11-arg `StreamProxy`
    constructor with `coordinator` as the last arg + `coordinator.setActiveProxy(proxy)`).
  - Uses a two-phase mock = `makeReplacementUpstream()` copied verbatim from
    `tests/stream-proxy-pending-stop.test.ts` + ONE added accessor `isPrimaryAborted()` (see Mock gap).

**Success Definition**:
- `npm test tests/shortcut-lifecycle.test.ts` → the 3 new tests **pass**.
- These 3 tests **FAIL before the P1.M3.T1.S1 fix** (regression guard): with the old `canInterrupt()`
  (`return state === "Reasoning"`, no flag), EC-005/EC-006 would see `canInterrupt()===true` during the
  answer phase → `triggerStop()===true`, `requestStop()===true`, upstream aborted, `calls.length===1`.
- `npm run build` (`tsc`) passes — but note: **`tsc` compiles `src/` only** (see `tsconfig.json`); the new
  test file is type-checked by `bun test`'s transpiler, so a clean `bun test` run is the real type gate.
- `npm test` (full suite): the 3 new tests pass and **NO NEW failures** are introduced beyond the 2 known
  pre-existing Issue-1 timing flakes (`stream-proxy-rewrite.test.ts`, `stream-proxy-terminal-rewrite.test.ts`
  — see Known Gotchas). `git diff --stat -- src/` is EMPTY.

---

## Why

- **Issue 2 regression guard (PRD §2.4 "Areas needing more attention")**: the original 380-test suite
  "asserts on raw forwarded events but never validates" the shortcut-availability AFTER reasoning ends
  (EC-005/EC-006/RC-002). The bug — the shortcut staying armed during the answer phase and aborting the
  in-progress answer — was only caught by a hand-driven console reproduction. T1.S1 added UNIT coverage
  (proxy-local, no coordinator, single-call mock). This subtask closes the remaining gap: it exercises the
  REAL entry point (`coordinator.requestStop()` — what `ShortcutManager` calls on Ctrl+.) AND proves no
  second provider call is made (the actual user-visible harm). Without it, a future refactor that re-wires
  `canInterrupt()` back to the controller (or drops the `_reasoningEnded` gate) would re-open Issue 2 with
  the unit suite still green.
- **Why assert `requestStop()` AND `triggerStop()`?** `requestStop()` is the public coordinator seam;
  `triggerStop()` is the lower-level proxy method. The fix gates BOTH (the `triggerStop()` guard was
  changed from `this._controller.canInterrupt()` to `this.canInterrupt()` precisely so the flag is
  enforced at the abort entry point). Asserting both proves the gate is wired at both layers.
- **Why the replacement-count assertion?** The user-visible harm of Issue 2 is "the partial answer is
  discarded and a SECOND request is made." `mock.calls.length === 0` is the direct proof no second request
  happens — something the unit-level `isAborted()` assertion alone does not capture (abort and replacement
  are coordinated but distinct side effects).
- **Why a positive control?** A test that only asserts `false` after reasoning ends could pass even if the
  flag were always `true` (shortcut permanently disabled). The positive control (shortcut `true` DURING
  reasoning) proves the flag disables ONLY after reasoning ends, preserving the happy-path abort.
- **Scope cohesion**: this test rides cleanly on the COMPLETE T1.S1 fix and the COMPLETE P1.M2 work. It
  touches no production code and adds no coordinator behavior (Issue 3 / P1.M4 is separate). It cannot
  regress any sibling work item.

## What

A single new test file. Three `bun:test` cases, each: construct a coordinator-wired `StreamProxy` over a
two-phase mock, start a concurrent output consumer, drive the primary stream to the target state, fire the
shortcut, and assert the gating + no-side-effect outcomes. The mock is `makeReplacementUpstream()`
(copied from `tests/stream-proxy-pending-stop.test.ts`) augmented with `isPrimaryAborted()`. EC-005 and
EC-006 then push the remaining answer events + `done` to let the primary stream finish cleanly (no
replacement, no abort). The positive control pushes replacement events to complete the launched replacement.

### Success Criteria

- [ ] New file `tests/shortcut-lifecycle.test.ts` exists and defines exactly 3 passing tests under a
      `describe("StreamProxy — shortcut lifecycle / EC-005 / EC-006 (P1.M3.T2.S1, coordinator end-to-end)")`.
- [ ] **EC-005** test: after `start → thinking_start → thinking_delta → thinking_end` (with
      `waitFor(() => proxy.isReasoning())` THEN `waitFor(() => seen.includes("thinking_end"))`):
      `proxy.triggerStop() === false`, `coordinator.requestStop() === false`,
      `mock.isPrimaryAborted() === false`, `mock.calls.length === 0`.
- [ ] **EC-006** test: after `start → thinking_start → thinking_delta → text_start` (NO `thinking_end`,
      with `waitFor(() => seen.includes("text_start"))`): the same four assertions.
- [ ] **POSITIVE control**: after `start → thinking_start → thinking_delta` (still reasoning, NO
      leave-condition): `proxy.triggerStop() === true`, then `waitFor(() => mock.calls.length === 1)`,
      `mock.isPrimaryAborted() === true`; replacement then completed with pushed events.
- [ ] Every test drains `proxy.output` to completion (single `done` terminal) so `run()` exits cleanly
      with no dangling handle/timer (the `await consumer;` idiom).
- [ ] `git diff --stat -- src/` is EMPTY (no production change). `git status` shows ONLY the new test file.
- [ ] The 3 tests would FAIL against the pre-T1.S1 `canInterrupt()` body (manually verified or reasoned).

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact coordinator-wiring idiom (quoted verbatim with the 11-arg constructor + `setActiveProxy`),
the exact mock to copy (with the one-line accessor addition spelled out), the exact event sequences
(copying the field shapes `ev({ type, contentIndex, delta/content })` used throughout the suite), the
exact timing discipline (`waitFor` on forwarded events = proof `trackEvent` already ran → flag already
set), the exact four assertions per scenario, the "finish the stream cleanly" epilogue, and the
pre-existing-flake caveat are all inlined below. The implementer needs no prior proxy/FSM/coordinator
knowledge beyond what is quoted.

### Documentation & References

```yaml
# MUST READ — the bug, the fix, and the canonical coordinator-wiring pattern
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/system_context.md
  why: "§Issue 2 root cause + 'Fix strategy (reasoningEnded flag)' (the 4 code steps T1.S1 implemented —
        this test guards them). Explains WHY the FSM is NOT extended (stream-proxy-lifecycle.test.ts
        asserts getState()==='Reasoning' on normal completion) — relevant because our positive control
        relies on the controller genuinely staying in Reasoning during the answer phase."
  critical: "Establishes the §22.4 leave-conditions (thinking_end OR first answer token text_*/toolcall_*)
             are exactly what disables the shortcut. EC-005 = thinking_end; EC-006 = text_start. The
             'Steps to Reproduce' (start→thinking_start[0]→thinking_delta[0]→thinking_end→text_start,
             then triggerStop) is the EC-005 script verbatim."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/P1M3T1S1/PRP.md
  why: "The COMPLETED fix this test guards. Documents the exact assertions T1.S1's unit tests make
        (canInterrupt/triggerStop/isAborted) so this PRP does NOT duplicate them — the delta here is
        coordinator.requestStop() + replacement-call-count, which T1.S1 explicitly deferred."
  critical: "T1.S1's deliverable note: 'Do NOT add end-to-end consumer tests (that is P1.M3.T2.S1).'
             That is THIS task. Read it to draw the unit-vs-e2e boundary cleanly."

# PATTERN files to follow (verified verbatim against current HEAD)
- file: tests/stream-proxy-pending-stop.test.ts
  why: "THE coordinator-wiring reference (the contract names it). Copy: (1) makeCaptureDiag/makeModel/ev/
        waitFor/DONE_MESSAGE test doubles; (2) makeReplacementUpstream() — the two-phase mock with separate
        primary+replacement queues that throws on signal.abort and records replacement calls in `calls[]`;
        (3) the 11-arg StreamProxy construction with coordinator + `coordinator.setActiveProxy(proxy)`;
        (4) the concurrent `const consumer = (async () => { for await ... })()` drain idiom into `seen[]`;
        (5) the 'EC-005/EC-006 proxy-level lock-in' test (bottom of the file) — the positive-control shape."
  pattern: "requestStop() returns boolean; mock.calls.length === replacement count; pushPrimary/pushReplacement;
            waitFor(()=>mock.calls.length===1) to prove a replacement launched; push replacement events + done
            then `await consumer;`."
  gotcha: "makeReplacementUpstream does NOT expose the primary AbortSignal — see the Mock gap below; you MUST
           add `isPrimaryAborted: () => !!primarySignal?.aborted` to the copied mock (primarySignal is already
           captured in the closure on the 1st call). Do NOT import the mock — copy it (it is file-local)."

- file: tests/stream-proxy-reasoning-ended.test.ts   # READ-ONLY — T1.S1's UNIT tests (do NOT duplicate)
  why: "T1.S1's existing coverage. It uses makeAbortableUpstream (single-call, isAborted only, NO coordinator,
        10-arg constructor) and asserts ONLY proxy.canInterrupt()/triggerStop()/mock.isAborted(). This PRP's
        new file must EXERCISE A DIFFERENT LAYER (coordinator.requestStop) + assert replacement count —
        otherwise it is a pointless duplicate. Mirror its `ev()` field shapes and `waitFor(seen.includes(...))`
        timing discipline (trackEvent runs BEFORE the forward, so a forwarded event proves the flag is set)."
  pattern: "ev({ type:'thinking_end', contentIndex:0, content:'thinking...' }); ev({ type:'text_start',
            contentIndex:1 }); ev({ type:'done', reason:'stop', message: DONE_MESSAGE })."
  gotcha: "Do NOT re-test toolcall_start as a primary scenario (T1.S1 already has a toolcall_start variant).
           If you want a toolcall arm, add it as a 4th optional case mirroring EC-006 — but the contract's
           mandatory set is EC-005 (thinking_end) + EC-006 (text_start) + positive control."

- file: src/state/coordinator.ts
  why: "requestStop() semantics (the entry point under test). Returns false when !activeProxy (EC-001) OR
        when !proxy.canInterrupt(). In the latter case it records a pending stop ONLY if proxy.isDelegating()
        — after reasoning ends we are in Reasoning (not Delegating) so NO pending stop is recorded and the
        return is `false` with trace reason 'not-reasoning'. This is exactly why requestStop()===false AND
        no replacement launches later (no pending stop to auto-trigger)."
  pattern: "Structural ActiveProxy seam: { isReasoning, canInterrupt, triggerStop, isInterrupting, isDelegating }.
            StreamProxy satisfies it; coordinator.setActiveProxy(proxy) registers it."
  gotcha: "requestStop() never throws (Appendix K). You can assert it returns false WITHOUT try/catch. The
           'not-reasoning' trace reason is a nice optional extra assertion but is NOT required by the contract."

- file: src/provider/proxy.ts   # READ-ONLY — confirm the fix is live (do NOT edit)
  why: "Confirm the T1.S1 fix is present so the tests are a regression guard, not a forward-TDD task.
        Line 179: private _reasoningEnded = false. Lines 345-346: canInterrupt() returns
        getState()==='Reasoning' && !_reasoningEnded. Lines 372-373: triggerStop() guard is
        if (!this.canInterrupt()) return false. Constructor (line 253): 11 params, coordinator is the LAST."
  pattern: "No edits. isReasoning() is UNCHANGED (telemetry-only) — our positive control uses isReasoning()
            purely to await the Reasoning state before firing the shortcut."
  gotcha: "The controller FSM is UNCHANGED: getState() stays 'Reasoning' through the answer phase. So in
           EC-005/EC-006, proxy.isReasoning() is STILL TRUE even though canInterrupt() is false — that is the
           whole point of the flag (do NOT assert isReasoning()===false after reasoning ends; assert
           canInterrupt()===false)."

- file: tests/helpers/invariant-harness.ts   # import the shared test doubles (do NOT re-declare)
  why: "Exports makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE — import these. Also exports buildProxy()
        and makeScriptedTwoPhaseUpstream() as ALTERNATIVES, but the contract prefers the pending-stop
        makeReplacementUpstream idiom (it is the named reference and its shape is simpler for this test)."
  pattern: "import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from './helpers/invariant-harness';"
  gotcha: "makeScriptedTwoPhaseUpstream does NOT expose isAborted either — so if you go the buildProxy route
           you STILL must add an isPrimaryAborted accessor. The pending-stop makeReplacementUpstream copy is
           the lower-friction choice. Do NOT import DONE_MESSAGE from anywhere else."
```

### Current Codebase tree (relevant slice)

```bash
src/provider/proxy.ts            # READ-ONLY (T1.M3.T1.S1 fix LIVE; canInterrupt/triggerStop gated)
src/state/coordinator.ts         # READ-ONLY (requestStop() — the entry point under test)
tests/
├── helpers/invariant-harness.ts # import makeCaptureDiag/makeModel/ev/waitFor/DONE_MESSAGE
├── stream-proxy-pending-stop.test.ts      # READ-ONLY PATTERN (coordinator wiring + makeReplacementUpstream)
├── stream-proxy-reasoning-ended.test.ts   # READ-ONLY (T1.S1 UNIT tests — do NOT duplicate)
└── shortcut-lifecycle.test.ts             # ← NEW (this subtask)
```

### Desired Codebase tree with file responsibility

```bash
tests/shortcut-lifecycle.test.ts   # NEW — 3 end-to-end tests via TransitionCoordinator:
                                   #   EC-005 (thinking_end → shortcut false, no abort, 0 replacements),
                                   #   EC-006 (text_start → same),
                                   #   POSITIVE control (still reasoning → shortcut true → 1 replacement).
                                   #   Coordinator-wired 11-arg StreamProxy + setActiveProxy; two-phase mock
                                   #   (makeReplacementUpstream copy + isPrimaryAborted accessor).
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (this is TEST-ONLY — the #1 trap): do NOT modify ANY file under src/. The P1.M3.T1.S1 fix is
// LIVE and complete. `git diff --stat -- src/` MUST be empty. If a test "fails" and you are tempted to
// edit proxy.ts/coordinator.ts, STOP — the fix is correct; your test driver or assertions are wrong. The
// only legitimate edits are inside tests/shortcut-lifecycle.test.ts.

// CRITICAL (the mock gap — the #2 trap): the contract requires asserting BOTH "upstream NOT aborted" AND
// "replacement call count is 0". No existing mock exposes both. makeReplacementUpstream (pending-stop)
// captures `primarySignal` in its closure but does NOT expose it, and makeAbortableUpstream (T1.S1) is
// single-call (no replacement queue). SOLUTION: copy makeReplacementUpstream verbatim from
// tests/stream-proxy-pending-stop.test.ts into the new file and add ONE accessor to its returned object:
//   isPrimaryAborted: () => !!primarySignal?.aborted,
// `primarySignal` is the closure var assigned on the 1st (primary) call from opts?.signal — it already
// exists, you are only exposing it. Do NOT rename it.

// CRITICAL (timing — the #3 trap): trackEvent() runs in run()'s for-await BEFORE _emit()/this._output.push().
// So an event in the drained `seen[]` array is PROOF trackEvent already ran on it → the _reasoningEnded flag
// is already set. You MUST `await waitFor(() => seen.includes("thinking_end"))` (or "text_start") BEFORE
// asserting canInterrupt()===false. Asserting synchronously right after pushPrimary(...) will read stale
// state (run() has not processed the event yet). ALSO `await waitFor(() => proxy.isReasoning())` first, to
// guarantee the thinking_start/thinking_delta events were processed and the FSM reached Reasoning.

// CRITICAL (isReasoning vs canInterrupt after reasoning ends — the #4 trap): the controller FSM is UNCHANGED
// by the flag approach (that is WHY T1.S1 used a flag, not a Reasoning→Answering transition). So after
// thinking_end/text_start, proxy.isReasoning() is STILL TRUE (state==Reasoning) while proxy.canInterrupt()
// is FALSE (flag set). Assert canInterrupt()===false — do NOT assert isReasoning()===false (it would wrongly
// fail and is not the contract). This divergence is the entire design of the fix.

// CRITICAL (finish the stream cleanly — the #5 trap): makeReplacementUpstream's iterators BLOCK forever
// when their queue empties (they never end on their own). For EC-005/EC-006 (shortcut NOT taken) you MUST
// push the remaining answer events + a `done` terminal into the PRIMARY queue and `await consumer;` so run()
// exits and the for-await completes — otherwise the test leaves a dangling promise/timer. For the POSITIVE
// control (shortcut taken) the abort resolves the primary iterator (it throws "aborted"); you then push the
// replacement events + done into the REPLACEMENT queue and `await consumer;`.

// CRITICAL (requestStop() return value — the #6 trap): after reasoning ends, canInterrupt()===false AND
// isDelegating()===false (we are in Reasoning, not Delegating). So coordinator.requestStop() takes the
// `if (!proxy.canInterrupt()) { ... return false; }` branch with reason "not-reasoning" — it does NOT record
// a pending stop (that only happens when isDelegating()). Therefore NO replacement auto-triggers later.
// `coordinator.requestStop()===false` + `mock.calls.length===0` together prove this end-to-end.

// GOTCHA (do NOT register the coordinator twice / do NOT forget setActiveProxy): requestStop() reads
// this.activeProxy — if you construct the proxy with the coordinator but forget coordinator.setActiveProxy(proxy),
// requestStop() returns false for the WRONG reason (no-active-proxy, EC-001) and your positive control's
// requestStop would also be false. Always call coordinator.setActiveProxy(proxy) immediately after construction.

// GOTCHA (pre-existing Issue-1 flakes — do NOT chase them): at HEAD, `npm test` shows 393 pass / 2 fail. The
// 2 failures are stream-proxy-rewrite.test.ts ("offset-0 (placeholder partials)...UNCHANGED (guard)") and
// stream-proxy-terminal-rewrite.test.ts ("done.message is merged...") — both P1.M2.T2 (Issue 1, reasoning-
// content rewrite) timing flakes. They PASS in isolation (`npm test <file>`) and flake under full-suite load.
// They are UNRELATED to Issue 2. Your gate is "the 3 new tests pass + NO NEW failures", NOT "0 fail". If your
// run shows exactly those 2 as the only failures, re-run `npm test` to confirm the flakes; do not try to fix them.

// GOTCHA (tsc compiles src/ only): `npm run build` runs `tsc` whose `include` is `["src"]` (see tsconfig.json).
// The new test file is therefore type-checked by `bun test`'s transpiler, not by tsc. The real type gate for
// test code is a clean `bun test` run. `npm run build` should still pass (it is unaffected) but is not the
// primary signal for test-file correctness.

// SCOPE: do NOT add toolcall_start as a mandatory scenario (T1.S1 already has a toolcall_start variant — it
// would be a duplicate concern). Do NOT add consumer-message-assembly assertions (P1.M2.T3.S1). Do NOT add
// coordinator overlap-guard tests (P1.M4.T1.S1 / Issue 3). 3 tests: EC-005, EC-006, positive control.
```

---

## Implementation Blueprint

### Data models and structure

No new types, no production types. One new test file with: the 5 shared test doubles (imported from the
harness), one file-local mock function (copied + 1 accessor), and 3 `bun:test` cases. The "data model"
is the `makeReplacementUpstream` return shape plus the one added field:

```typescript
// The mock (copied from tests/stream-proxy-pending-stop.test.ts + ONE added accessor `isPrimaryAborted`):
interface TwoPhaseMockWithAbort {
  fn: ApiStreamSimpleFunction;
  calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[]; // calls[1..] = replacement calls
  pushPrimary: (e: AssistantMessageEvent) => void;
  pushReplacement: (e: AssistantMessageEvent) => void;
  isPrimaryAborted: () => boolean; // NEW — exposes the closure-captured primarySignal.aborted
}
// `mock.calls.length` === number of replacement provider calls (0 = no second request).
// `mock.isPrimaryAborted()` === whether the primary upstream AbortSignal was aborted.
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE tests/shortcut-lifecycle.test.ts — header, imports, shared doubles, the mock
  - CREATE the file with the bun:test imports + the StreamProxy/TransitionController/TransitionCoordinator/
    ReasoningBuffer/DEFAULT_CONFIG imports + the @earendil-works/pi-ai + Diagnostics type imports.
  - IMPORT the shared doubles from the harness (do NOT re-declare):
      import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from "./helpers/invariant-harness";
  - COPY makeReplacementUpstream() VERBATIM from tests/stream-proxy-pending-stop.test.ts into this file
    (it is file-local there; it is NOT exported from the harness). Keep its two queues, its two closure
    signals (primarySignal/replacementSignal), its `calls[]` recording on the 2nd call, and its pushPrimary/
    pushReplacement accessors EXACTLY as-is.
  - ADD exactly ONE accessor to the returned object literal: `isPrimaryAborted: () => !!primarySignal?.aborted,`
    (primarySignal is already captured in the closure from the 1st call's opts?.signal — you are only exposing it).
  - FOLLOW pattern: tests/stream-proxy-pending-stop.test.ts (the makeReplacementUpstream definition + the
    import block). Copy its `import type { AssistantMessage, AssistantMessageEvent, ApiStreamSimpleFunction }`
    and `import type { Diagnostics }` lines verbatim.
  - NAMING: the mock function stays `makeReplacementUpstream` (matches its source). The accessor is
    `isPrimaryAborted` (not `isAborted` — there are two signals; name which one).
  - PLACEMENT: top of the file, after imports, before the describe block.

Task 2: ADD the EC-005 test (shortcut after thinking_end → false, no abort, 0 replacements)
  - UNDER describe("StreamProxy — shortcut lifecycle / EC-005 / EC-006 (P1.M3.T2.S1, coordinator end-to-end)"):
  - SETUP (copy the pending-stop idiom verbatim):
      const { diag, events } = makeCaptureDiag();
      const controller = new TransitionController(diag);
      const buffer = new ReasoningBuffer(diag, 1_000_000);
      const coordinator = new TransitionCoordinator(diag);
      const mock = makeReplacementUpstream();
      const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
        DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000, coordinator);   // 11 args; coordinator LAST
      coordinator.setActiveProxy(proxy);                                       // REQUIRED for requestStop()
  - CONCURRENT CONSUMER:
      const seen: string[] = [];
      const consumer = (async () => { for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type); })();
  - DRIVE TO REASONING:
      mock.pushPrimary(ev({ type: "start" }));
      mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
      mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
      await waitFor(() => proxy.isReasoning());
  - PUSH THE §22.4 LEAVE-CONDITION (EC-005 = thinking_end):
      mock.pushPrimary(ev({ type: "thinking_end", contentIndex: 0, content: "thinking..." }));
      await waitFor(() => seen.includes("thinking_end"));   // PROOF trackEvent ran → _reasoningEnded set
  - THE FOUR ASSERTIONS (the contract, verbatim):
      expect(proxy.triggerStop()).toBe(false);              // (1) no abort dispatched at the proxy
      expect(coordinator.requestStop()).toBe(false);        // (2) the real ShortcutManager entry point → false
      expect(mock.isPrimaryAborted()).toBe(false);          // (3) upstream AbortSignal NOT aborted
      expect(mock.calls.length).toBe(0);                    // (4) NO replacement provider call (no 2nd request)
      // optional extra: expect(events.some(c => c.event === "proxy.abort.completed")).toBe(false);
  - FINISH THE STREAM CLEANLY (shortcut NOT taken → primary still streaming):
      mock.pushPrimary(ev({ type: "text_start", contentIndex: 1 }));
      mock.pushPrimary(ev({ type: "text_delta", contentIndex: 1, delta: "answer" }));
      mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
      await consumer;   // done completes output.result() → for-await exits; no dangling handle
  - NAMING: test("EC-005: triggerStop()/requestStop() return false after thinking_end (no abort, 0 replacements)".
  - COVERAGE: §22.4 leave-condition thinking_end; both triggerStop + requestStop layers; no-abort + 0-replacement.

Task 3: ADD the EC-006 test (shortcut on first answer token text_start, NO thinking_end → same 4 assertions)
  - SAME setup + consumer as Task 2 (coordinator-wired 11-arg proxy + setActiveProxy).
  - DRIVE TO REASONING: pushPrimary start / thinking_start[0] / thinking_delta[0]; await waitFor(isReasoning).
  - PUSH THE §22.4 LEAVE-CONDITION (EC-006 = first answer token, NO thinking_end):
      mock.pushPrimary(ev({ type: "text_start", contentIndex: 1 }));
      await waitFor(() => seen.includes("text_start"));   // trackEvent ran on the answer token → flag set
  - THE FOUR ASSERTIONS: identical to Task 2 (triggerStop===false, requestStop===false, isPrimaryAborted===false,
    calls.length===0).
  - FINISH CLEANLY: pushPrimary text_delta[1] + done; await consumer.
  - NAMING: test("EC-006: triggerStop()/requestStop() return false on first answer token text_start (no abort, 0 replacements)".
  - GOTCHA: do NOT push thinking_end before text_start — EC-006 is specifically the "model answers without
    finishing reasoning" path (§22.4 leave-condition "first answer token"). Pushing thinking_end first would
    turn it into an EC-005 re-test.

Task 4: ADD the POSITIVE control (still reasoning, NO leave-condition → triggerStop()===true → 1 replacement)
  - SAME setup + consumer as Task 2.
  - DRIVE TO REASONING: pushPrimary start / thinking_start[0] / thinking_delta[0]; await waitFor(isReasoning).
  - SANITY (shortcut still armed): expect(proxy.canInterrupt()).toBe(true);
  - FIRE THE SHORTCUT (no leave-condition yet → flag still false → canInterrupt()===true):
      expect(proxy.triggerStop()).toBe(true);              // shortcut ACTIVE while genuinely mid-reasoning
      await waitFor(() => mock.calls.length === 1);        // replacement provider call WAS made
      expect(mock.isPrimaryAborted()).toBe(true);          // upstream AbortSignal WAS aborted
  - COMPLETE THE LAUNCHED REPLACEMENT (so run() exits cleanly):
      mock.pushReplacement(ev({ type: "start" }));
      mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
      mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
      await consumer;
  - NAMING: test("positive control: triggerStop()===true DURING reasoning (before any leave-condition) launches 1 replacement".
  - COVERAGE: proves the _reasoningEnded flag disables the shortcut ONLY after reasoning ends, not earlier;
    preserves the happy-path interrupt (regression guard against over-disabling).
  - PATTERN: mirrors the bottom test of tests/stream-proxy-pending-stop.test.ts ("EC-005/EC-006 proxy-level
    lock-in") which drives to Reasoning, requestStop()→true, waitFor(calls.length===1), completes replacement.
```

### Implementation Patterns & Key Details

```typescript
// tests/shortcut-lifecycle.test.ts — full skeleton (fill from the task list).

import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionCoordinator } from "../src/state/coordinator";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";
import { makeCaptureDiag, makeModel, ev, waitFor, DONE_MESSAGE } from "./helpers/invariant-harness";

// makeReplacementUpstream — copied VERBATIM from tests/stream-proxy-pending-stop.test.ts, with ONE added
// accessor `isPrimaryAborted` (primarySignal is already captured in the closure; we only expose it).
function makeReplacementUpstream() {
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = [];
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];
  let callCount = 0;
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    callCount++;
    if (callCount === 1) {
      primarySignal = opts?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (primarySignal?.aborted) throw new Error("aborted");
            if (primaryQueue.length) { yield primaryQueue.shift()!; continue; }
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 0);
              primarySignal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
            });
          }
        },
      };
    }
    calls.push({ options: opts });
    replacementSignal = opts?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (replacementSignal?.aborted) throw new Error("aborted");
          if (replacementQueue.length) { yield replacementQueue.shift()!; continue; }
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 0);
            replacementSignal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
          });
        }
      },
    };
  }) as unknown as ApiStreamSimpleFunction;
  return {
    fn,
    calls,
    pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e),
    pushReplacement: (e: AssistantMessageEvent) => replacementQueue.push(e),
    isPrimaryAborted: () => !!primarySignal?.aborted, // ← THE ONE ADDITION (exposes the closure signal)
  };
}

describe("StreamProxy — shortcut lifecycle / EC-005 / EC-006 (P1.M3.T2.S1, coordinator end-to-end)", () => {

  test("EC-005: triggerStop()/requestStop() return false after thinking_end (no abort, 0 replacements)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const coordinator = new TransitionCoordinator(diag);
    const mock = makeReplacementUpstream();
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000, coordinator);
    coordinator.setActiveProxy(proxy);

    const seen: string[] = [];
    const consumer = (async () => { for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type); })();

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking..." }));
    await waitFor(() => proxy.isReasoning());

    mock.pushPrimary(ev({ type: "thinking_end", contentIndex: 0, content: "thinking..." }));
    await waitFor(() => seen.includes("thinking_end")); // trackEvent ran → _reasoningEnded set

    expect(proxy.triggerStop()).toBe(false);       // (1) proxy: no abort dispatched
    expect(coordinator.requestStop()).toBe(false); // (2) coordinator (the real entry point): false
    expect(mock.isPrimaryAborted()).toBe(false);   // (3) upstream NOT aborted
    expect(mock.calls.length).toBe(0);             // (4) NO replacement provider call

    // Finish the primary stream cleanly (shortcut not taken → primary still streaming)
    mock.pushPrimary(ev({ type: "text_start", contentIndex: 1 }));
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 1, delta: "answer" }));
    mock.pushPrimary(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    await consumer;
  });

  test("EC-006: triggerStop()/requestStop() return false on first answer token text_start (no abort, 0 replacements)", async () => {
    // identical setup; push text_start (NOT thinking_end) as the leave-condition
    // … drive to Reasoning, push text_start, waitFor(seen includes "text_start"), assert the 4,
    //   then push text_delta + done and await consumer.
  });

  test("positive control: triggerStop()===true DURING reasoning (before any leave-condition) launches 1 replacement", async () => {
    // identical setup; drive to Reasoning; assert canInterrupt()===true; triggerStop()===true;
    //   waitFor(calls.length===1); assert isPrimaryAborted()===true; push replacement start/text_delta/done; await consumer.
  });
});
```

### Integration Points

```yaml
PRODUCTION CODE: NONE. git diff --stat -- src/ is empty. The T1.M3.T1.S1 fix (_reasoningEnded flag +
  canInterrupt()/triggerStop() gates) is LIVE and complete. This subtask is purely a test regression guard.

TEST CODE:
  - add file: tests/shortcut-lifecycle.test.ts (3 tests: EC-005 after thinking_end; EC-006 on text_start;
    positive control still-reasoning). Coordinator-wired 11-arg StreamProxy + setActiveProxy; two-phase mock
    (makeReplacementUpstream copy + isPrimaryAborted accessor). Shared doubles imported from the harness.

BUILD/CONFIG: NONE. tsconfig.json, package.json, no new deps. No new test runner config (bun auto-discovers
  *.test.ts). `npm test` picks up the new file automatically.

DOWNSTREAM (do NOT do these now):
  - P1.M4.T1.S1 (Issue 3): coordinator overlap-guard test (clearActiveProxy) — separate file/concern.
  - P1.M5.T1.S1: README/overview doc sync — documents the fix, not the tests.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# Test-file type correctness is enforced by bun's transpiler at run time (tsc compiles src/ only — see
# tsconfig.json `include`). So a clean `bun test` of the new file IS the type gate. Run it in isolation first:
npm test tests/shortcut-lifecycle.test.ts
# Expected: 3 passing (EC-005, EC-006, positive control). If a type error appears, READ it — it is usually a
#   wrong import path or a missing `as never`/type cast on the makeModel/StreamProxy construction (copy the
#   pending-stop idiom verbatim to avoid this).

# Confirm tsc is still green (it must be — no src/ change):
npm run build
# Expected: 0 diagnostics.

# Confirm NO production code changed:
git diff --stat -- src/            # Expected: EMPTY
git status --short                 # Expected: ?? tests/shortcut-lifecycle.test.ts (and nothing else)
```

### Level 2: Unit / Component Tests (the new file + neighbors)

```bash
# The new end-to-end tests in isolation:
npm test tests/shortcut-lifecycle.test.ts
# Expected: 3 pass. EC-005 + EC-006: triggerStop()===false, requestStop()===false, isPrimaryAborted()===false,
#   calls.length===0. Positive control: triggerStop()===true, calls.length===1, isPrimaryAborted()===true.

# The T1.S1 unit suite (must STILL pass — we did not touch it or its mock):
npm test tests/stream-proxy-reasoning-ended.test.ts
# Expected: 4 pass (EC-005, EC-006, sanity, toolcall_start variant). Confirms the fix is intact.

# The coordinator + pending-stop suites (the wiring pattern we copied from):
npm test tests/transition-coordinator.test.ts tests/stream-proxy-pending-stop.test.ts
# Expected: all pass. Confirms we did not alter coordinator behavior or the shared mock semantics.
```

### Level 3: Full Suite (regression — the real gate)

```bash
npm test
# Expected: the 3 new tests pass. Total = 398 pass / ≤2 fail.
#   The ONLY acceptable failures are the 2 KNOWN pre-existing Issue-1 timing flakes:
#     - tests/stream-proxy-rewrite.test.ts > "offset-0 (placeholder partials) forwards replacement events UNCHANGED (guard)"
#     - tests/stream-proxy-terminal-rewrite.test.ts > "done.message is merged so result() persists [thinking, text]"
#   These are P1.M2.T2 (Issue 1, reasoning-content rewrite) flakes — PASS in isolation, flake under full-suite
#   load. They are UNRELATED to Issue 2. If your run shows exactly those 2 (and the 3 new tests pass),
#   re-run `npm test` once to confirm the flakes; the gate is "NO NEW failures beyond those 2".
#   If ANY OTHER test fails, that is a regression from this change — debug and fix the test driver.

# Regression check: the full Issue-2 cluster stays green (controller FSM untouched, flag intact):
npm test tests/stream-proxy-abort.test.ts tests/stream-proxy-lifecycle.test.ts tests/stream-proxy-reasoning-ended.test.ts tests/transition-controller.test.ts
# Expected: all pass. (lifecycle.test.ts line ~441 getState()==='Reasoning' holds; abort.test.ts canInterrupt()
#   delegation during Reasoning holds; reasoning-ended.test.ts holds.)
```

### Level 4: Domain-Specific Validation (regression-guard audit — prove the tests would fail pre-fix)

```bash
# Audit the new test asserts the contract end-to-end via the coordinator:
grep -n "coordinator.requestStop()"           tests/shortcut-lifecycle.test.ts  # → ≥2 (EC-005 + EC-006), === false
grep -n "proxy.triggerStop()"                 tests/shortcut-lifecycle.test.ts  # → ≥3 (EC-005/EC-006 ===false, positive ===true)
grep -n "mock.isPrimaryAborted()"             tests/shortcut-lifecycle.test.ts  # → ≥3 (EC-005/EC-006 ===false, positive ===true)
grep -n "mock.calls.length"                   tests/shortcut-lifecycle.test.ts  # → ≥3 (EC-005/EC-006 ===0, positive ===1)
grep -n "setActiveProxy"                      tests/shortcut-lifecycle.test.ts  # → 1 (coordinator registered)
grep -n "isPrimaryAborted: () =>"             tests/shortcut-lifecycle.test.ts  # → 1 (the one mock accessor addition)

# OPTIONAL regression-guard proof (do this mentally or on a throwaway branch — do NOT commit it):
#   Temporarily revert the canInterrupt() body to `return this._controller.getState() === "Reasoning";`
#   (drop `&& !this._reasoningEnded`). Run the new file: EC-005 + EC-006 MUST now FAIL (triggerStop()===true,
#   isPrimaryAborted()===true, calls.length===1) and the positive control still PASSES. This proves the tests
#   are genuine regression guards. Then `git checkout src/provider/proxy.ts` to restore the fix.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npm test tests/shortcut-lifecycle.test.ts` → 3 pass (EC-005, EC-006, positive control).
- [ ] `npm run build` (tsc) → 0 diagnostics.
- [ ] `npm test` full suite → 3 new tests pass; the ONLY failures are the 2 known Issue-1 flakes (re-runnable).
- [ ] `git diff --stat -- src/` is EMPTY; `git status` shows ONLY `?? tests/shortcut-lifecycle.test.ts`.

### Feature Validation
- [ ] **EC-005**: after `thinking_end`, `proxy.triggerStop()===false`, `coordinator.requestStop()===false`,
      `mock.isPrimaryAborted()===false`, `mock.calls.length===0`.
- [ ] **EC-006**: after `text_start` (no `thinking_end`), the same four assertions.
- [ ] **Positive control**: while still reasoning (no leave-condition), `proxy.triggerStop()===true`,
      then `mock.calls.length===1`, `mock.isPrimaryAborted()===true`.
- [ ] Every test pushes a `done` terminal and `await consumer;` so no dangling promise/timer is left.
- [ ] The 3 tests would FAIL against the pre-T1.S1 `canInterrupt()` body (regression-guard verified).

### Code Quality & Scope Discipline
- [ ] The new file follows the pending-stop coordinator-wiring idiom (11-arg constructor + setActiveProxy).
- [ ] The mock is `makeReplacementUpstream` copied verbatim + exactly ONE `isPrimaryAborted` accessor.
- [ ] Shared doubles (makeCaptureDiag/makeModel/ev/waitFor/DONE_MESSAGE) imported from the harness, NOT re-declared.
- [ ] Does NOT duplicate T1.S1's unit tests (different layer: coordinator.requestStop; different mock: two-phase).
- [ ] Does NOT touch any production file, the controller FSM, the coordinator, or any other test file.
- [ ] Does NOT add toolcall_start as a mandatory scenario (T1.S1 already covers that arm), consumer-message
      assembly (P1.M2.T3.S1), or coordinator overlap-guard tests (P1.M4.T1.S1).

### Documentation
- [ ] No source docs required (contract item 6: "DOCS: none — test only"). The `describe`/`test` names + the
      mock's JSDoc block are self-documenting (cite P1.M3.T2.S1, Issue 2, EC-005/EC-006, §22.4).

---

## Anti-Patterns to Avoid

- ❌ Don't edit ANY file under `src/` — this is TEST-ONLY. The P1.M3.T1.S1 fix is live; if a test fails, your
  driver/assertions are wrong, not the production code.
- ❌ Don't reuse `makeAbortableUpstream` (the T1.S1 mock) — it is single-call and CANNOT assert replacement
  count. Use the two-phase `makeReplacementUpstream` (copied from pending-stop) so `mock.calls.length` exists.
- ❌ Don't forget to ADD `isPrimaryAborted: () => !!primarySignal?.aborted` to the copied mock — without it you
  cannot prove the upstream was not aborted (the closure signal exists but is unexposed).
- ❌ Don't construct the proxy without passing `coordinator` as the 11th arg AND calling
  `coordinator.setActiveProxy(proxy)` afterward — `requestStop()` reads `this.activeProxy`; without
  registration it returns `false` for the wrong reason (EC-001 no-active-proxy) and the positive control breaks.
- ❌ Don't assert `proxy.isReasoning()===false` after reasoning ends — the controller FSM is UNCHANGED by the
  flag approach, so state stays `Reasoning` and `isReasoning()` stays `true`. Assert `canInterrupt()===false`.
- ❌ Don't assert `canInterrupt()`/`triggerStop()` synchronously after `pushPrimary(thinking_end)` — `run()`
  processes events asynchronously. `await waitFor(() => seen.includes("thinking_end"))` first (a forwarded
  event proves `trackEvent` already ran → the flag is set).
- ❌ Don't leave the stream hanging — always push a `done` terminal and `await consumer;` so `run()` exits and
  no timer/promise dangles (the mock iterators block forever when their queue empties).
- ❌ Don't conflate EC-005 and EC-006 — EC-006 pushes `text_start` with NO prior `thinking_end` (the "model
  answers without finishing reasoning" path). Pushing `thinking_end` first would silently re-test EC-005.
- ❌ Don't treat the 2 pre-existing Issue-1 flakes as regressions — they are unrelated timing flakes in
  `stream-proxy-rewrite.test.ts` / `stream-proxy-terminal-rewrite.test.ts`. The gate is "no NEW failures".

---

## Success Metrics

**Confidence Score: 9/10** — The implementation is a single new test file that copies two well-understood,
verbatim patterns from existing tests (the pending-stop coordinator-wiring idiom + the makeReplacementUpstream
mock, + T1.S1's `ev()` field shapes and `waitFor(seen.includes(...))` timing discipline). The fix it guards is
already live and confirmed in `src/provider/proxy.ts`. The only non-trivial step is the one-line
`isPrimaryAborted` accessor addition to the mock. Risk is limited to test-driver timing (mitigated by the
`waitFor` discipline spelled out verbatim) and the pre-existing-flake caveat (clearly documented). Withholding
the final point only because end-to-end timing tests can occasionally need a timeout tweak on slow machines;
the patterns shown use robust `waitFor` polling, so this is low-probability.
