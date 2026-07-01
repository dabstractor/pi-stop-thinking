# PRP — P1.M2.T1.S1: Capture primary partial content blocks and compute contentIndex offset at freeze

> **Bugfix**: Stream Integrity & Shortcut Lifecycle — Issue 1 (CRITICAL): reasoning content is lost from
> the persisted assistant message on every interruption. This is **Task 1** of the Issue-1 fix
> (Module P1.M2). It is the **seed-data capture** step: it gathers the primary stream's structured content
> blocks (the `thinking` blocks) at the abort boundary and computes the `contentIndex` offset, so the
> **next** subtask (P1.M2.T2.S1) can rewrite replacement events to merge the reasoning into the answer.
>
> **What this subtask is NOT**: it does NOT yet rewrite replacement events, does NOT fix Issue 1 by
> itself, and does NOT change any downstream output. It only captures two values
> (`_frozenPrimaryContent`, `_contentIndexOffset`) that are **inert** until T2 wires them in. The
> placeholder-mock guard (see Context) guarantees existing tests are untouched.

---

## Goal

**Feature Goal**: In `src/provider/proxy.ts`, capture the primary stream's structured content blocks at
the abort/freeze boundary and compute the contentIndex offset, so the replacement-event rewrite
(P1.M2.T2.S1) has the seed data it needs to merge primary reasoning with the replacement answer (Issue 1
fix). Concretely: (1) track the last primary `event.partial` (the provider's live accumulating `output`);
(2) right after `_buffer.freeze()` in `run()`'s abort branch, shallow-per-block clone
`partial.content` into `_frozenPrimaryContent` and set `_contentIndexOffset = _frozenPrimaryContent.length`;
(3) expose both via read-only getters; (4) a TDD test using the realistic mock that drives a primary
reasoning stream, triggers abort mid-reasoning, and asserts the captured frozen content is one
`{type:"thinking"}` block with the accumulated thinking text and the offset is `1`.

**Deliverable**:
- `src/provider/proxy.ts` — MODIFIED: 3 new private fields (`_primaryPartial`, `_frozenPrimaryContent`,
  `_contentIndexOffset`), 1 new capture line in `run()`'s primary loop, 2 new snapshot lines in `run()`'s
  abort catch branch (after `_buffer.freeze()`), and 2 new read-only getters (`frozenPrimaryContent`,
  `contentIndexOffset`).
- `tests/stream-proxy-capture.test.ts` — NEW: a `bun:test` that builds the `StreamProxy` with the
  realistic two-call mock (`makeRealisticTwoPhaseMock`), drives a primary `start → thinking_start →
  thinking_delta("Let") → thinking_delta(" me")` stream, calls `triggerStop()` mid-reasoning, and asserts
  `proxy.frozenPrimaryContent` is `[{type:"thinking", thinking:"Let me"}]` and `proxy.contentIndexOffset`
  is `1`.

**Success Definition**:
- `npm run build` (`tsc`) passes with **zero diagnostics** — this is a real gate now (src/ change), and the
  bare `event.partial` from the work-item contract MUST be type-narrowed with `!isTerminalEvent(event)`
  (see Context §Known Gotchas) or the build fails.
- `npm test` (=`bun test`) is green: **385 pass / 0 fail** (baseline 384 + the 1 new capture test). All
  existing tests behave identically — the placeholder-mock guard yields frozen `[]` + offset `0`.
- The new capture test passes: after a mid-reasoning abort, `proxy.frozenPrimaryContent` has exactly one
  block `{type:"thinking", thinking:"Let me"}` and `proxy.contentIndexOffset === 1`.
- `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts` changed; `git status` shows only that file
  modified + the new test added.

---

## Why

- **Issue 1 root cause (architecture/system_context.md §Issue 1)**: the proxy forwards replacement events
  verbatim; the replacement is a FRESH z.ai request whose `partial` carries ONLY text → the downstream
  consumer (`partialMessage = event.partial`) loses the primary's reasoning. The fix is a proxy-owned
  content merge: prepend the primary's frozen reasoning blocks to the replacement's answer, and offset the
  replacement's `contentIndex` so the text lands after the reasoning. **T1 is the data-gathering half**:
  without the captured `_frozenPrimaryContent` + `_contentIndexOffset`, T2 has nothing to merge/offset.
- **Structured blocks, not raw deltas**: the `ReasoningBuffer` (frozen at the same boundary) only has raw
  delta strings; it lacks block structure (`{type:'thinking', thinking:'…'}`). The consumer indexes
  `partial.content[contentIndex]` on structured `ContentBlock`s, so T1 must capture the structured blocks
  from `event.partial.content` — exactly as the work-item contract states ("NOT just the raw delta strings
  in ReasoningBuffer").
- **Inert + guarded = zero blast radius**: T1 only writes two new fields and reads nothing it doesn't own.
  The placeholder-mock guard (events with no `partial` → frozen `[]`, offset `0`) means the T2 rewrite will
  be a no-op for the entire existing suite until T2 is wired — so T1 cannot break anything.

## What

A minimal, additive change to `src/provider/proxy.ts` plus one focused test. The proxy, during its primary
forwarding loop, stashes a reference to the most-recent primary `event.partial` (the provider's live
accumulating `output` object — same reference across all events of one stream). When an abort happens
(triggerStop → upstream throws → `run()` catch, state `Aborting`), right after `_buffer.freeze()` it
shallow-clones each content block out of that live reference into `_frozenPrimaryContent` and records the
count as `_contentIndexOffset`. Both are exposed read-only for T2 + the test.

### Success Criteria

- [ ] `src/provider/proxy.ts` adds `_primaryPartial`, `_frozenPrimaryContent`, `_contentIndexOffset` (private)
      and `frozenPrimaryContent`, `contentIndexOffset` (public read-only getters).
- [ ] The primary `for await` loop captures `event.partial` on every non-terminal primary event (narrowed
      with `!isTerminalEvent(event)`), last one winning.
- [ ] The abort catch branch clones `_primaryPartial.content` (shallow-per-block `{...b}`) into
      `_frozenPrimaryContent` and sets `_contentIndexOffset = _frozenPrimaryContent.length`, immediately
      after `_buffer.freeze()`.
- [ ] GUARD verified: when no primary partial was captured (placeholder mocks), frozen content is `[]` and
      offset is `0` → all 384 existing tests stay green.
- [ ] New test `tests/stream-proxy-capture.test.ts` passes: mid-reasoning abort → one `{type:"thinking"}`
      block with accumulated text + offset `1`.
- [ ] `npm run build` (tsc) and `npm test` (bun test → 385 pass) both green; only `proxy.ts` changed in src/.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact insertion points (verbatim code blocks), the exact type-narrowing required to pass
`tsc`, the realistic-mock surface, and the test-driving idiom are all inlined below and verified against
local source. The implementer needs no prior proxy/FSM knowledge beyond what is quoted.

### Documentation & References

```yaml
# MUST READ — the bug + the exact capture strategy (why T1 captures partial.content, not the buffer)
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/system_context.md
  why: "§Issue 1 (root cause: verbatim forwarding + fresh replacement partial) + 'Fix strategy' step 1
        (Capture: snapshot event.partial.content into _frozenPrimaryContent at the abort/freeze boundary;
        offset = its length). 'Existing code touchpoints' names the exact two insertion points in run()."
  critical: "The capture must come from event.partial.content (STRUCTURED blocks), NOT the ReasoningBuffer
             snapshot (raw delta strings, no block structure). The buffer.freeze() at the same boundary is
             the TIMING anchor — clone AFTER it."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-ai-event-types.md
  why: "§1: every NON-terminal event carries `partial: AssistantMessage`; done/error carry message/error
        (NO partial). §2: AssistantMessage.content is ContentBlock[]; thinking block = {type:'thinking',
        thinking:string}. §3: push semantics."
  critical: "§1 is WHY the bare `event.partial` is a tsc ERROR (done/error members lack it) → must narrow
             with !isTerminalEvent(event). §2 is why a shallow-per-block clone {...b} is sufficient —
             content blocks are plain data objects."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/P1M2T1S1/research/notes.md
  why: "Verbatim insertion-point code blocks; the type-narrowing fix; the placeholder-mock guard proof;
        the realistic-mock surface; the test-driving idiom copied from stream-proxy-abort.test.ts;
        replacement-cleanup gotcha; validated commands."
  critical: "Section 2 (the tsc trap) and Section 3 (the guard that keeps the suite green) are the two
             things most likely to break one-pass success. Read both before editing."

# PATTERN files to follow (verified verbatim)
- file: src/provider/proxy.ts
  why: "THE file being modified. run() primary loop (capture line) + run() abort catch branch (snapshot
        lines). The private-field + public-getter convention (_output/output, _controller/controller,
        _buffer/buffer, _authority/authority) is the exact pattern to copy for the new fields/getters."
  pattern: "Private mutable field + public read-only getter; JSDoc with PRD/forward-compat cross-refs.
            Constructor does NOT touch the new fields (defaults are fine). AssistantMessage is already
            imported from @earendil-works/pi-ai."
  gotcha: "isTerminalEvent is already imported from ../types (used throughout). The capture line goes
           AFTER `this.trackEvent(event); this._emit(event);` and BEFORE the FM-005 _upstreamCompleted
           block. The snapshot lines go AFTER `this._buffer.freeze();` and BEFORE the
           `proxy.abort.completed` trace. Re-read the file's run() + the class field block before editing."

- file: tests/helpers/realistic-mock.ts   # SHIPPED in P1.M1.T1.S2 — consume, do NOT modify
  why: "makeRealisticTwoPhaseMock() → { fn, pushPrimary, pushReplacement, closePrimary, primaryOutput,
        replacementOutput, calls }. pushPrimary mutates primaryOutput.content IN PLACE and stamps
        partial:primaryOutput on each event. Primary iterator throws new Error('aborted') on AbortSignal
        abort (the trigger for run()'s abort branch). mock.fn is the upstreamStreamFn arg."
  pattern: "Drop mock.fn straight into `new StreamProxy(..., mock.fn, ...)`. Push specs like
            {type:'thinking_delta', delta:'Let'}; the mock derives contentIndex + partial itself."
  gotcha: "After 2 thinking deltas, primaryOutput.content === [{type:'thinking', thinking:'Let me'}]
           (length 1). That is exactly what _frozenPrimaryContent must clone. Do NOT push a replacement
           terminal unless cleaning up (the assertions run at freeze time, before the replacement is
           iterated)."

- file: tests/helpers/invariant-harness.ts   # SHIPPED — import the test doubles from here
  why: "makeCaptureDiag() (the capturing Diagnostics stub the contract's MOCKING requirement names),
        makeModel() (minimal Model stand-in), waitFor(pred, timeoutMs) (polling helper). buildProxy()
        shows the exact StreamProxy constructor arg order — but it is hardwired to the placeholder
        TwoPhaseMock, so the new test constructs StreamProxy directly with mock.fn instead."
  pattern: "import { makeCaptureDiag, makeModel, waitFor } from './helpers/invariant-harness';
            const { diag, events } = makeCaptureDiag(); ... new StreamProxy(makeModel(), {} as never,
            {} as never, mock.fn, diag, controller, buffer, DEFAULT_CONFIG.transitionTimeoutMs, undefined,
            15,);"
  gotcha: "waitFor(() => proxy.isReasoning()) BEFORE triggerStop (run() must have processed the thinking
           events so _primaryPartial is set). Then waitFor(() => events.some(c => c.event ===
           'proxy.abort.completed')) AFTER triggerStop (freeze + snapshot done). The abort test file
           re-declares a local makeCaptureDiag/makeModel/waitFor — importing from the harness avoids
           duplication."

- file: tests/stream-proxy-abort.test.ts   # the test-driving template (drive → reason → stop → assert)
  why: "The 'clean abort happy path' test is the exact control flow: build proxy, push start +
        thinking_start + thinking_delta, waitFor(isReasoning), triggerStop, waitFor(proxy.abort.completed),
        assert. Copy its construction + timing; swap makeAbortableUpstream→makeRealisticTwoPhaseMock and
        ev({...})→mock.pushPrimary({...})."
  pattern: "replacementStartupTimeoutMs: 15 (the 10th ctor arg) keeps an orphaned replacement from hanging
            the test; the existing abort tests assert mid-flight without draining. (Optional cleanup:
            push a replacement done + drain output — see research notes §6.)"
  gotcha: "The placeholder mock there uses ev({type:'thinking_delta', contentIndex:0, delta:'x'}) with NO
           partial — that is the case the guard handles. The realistic mock's events DO carry partial, so
           _primaryPartial IS set → the snapshot captures the real thinking block."
```

### Current Codebase tree (relevant slice)

```bash
src/provider/
└── proxy.ts                     # ← MODIFY: add 3 private fields + 2 getters; 1 capture line + 2 snapshot lines
tests/
├── helpers/
│   ├── realistic-mock.ts        # consume makeRealisticTwoPhaseMock (shipped P1.M1.T1.S2 — do NOT modify)
│   ├── invariant-harness.ts     # import makeCaptureDiag / makeModel / waitFor (do NOT modify)
│   └── consumer-harness.ts      # NOT used by T1 (that's P1.M2.T3.S1) — do not import
├── stream-proxy-abort.test.ts   # read-only PATTERN (the drive→reason→stop→assert control flow)
└── (stream-proxy-capture.test.ts)  # ← NEW (this subtask)
```

### Desired Codebase tree with file responsibilities

```bash
src/provider/proxy.ts            # MODIFIED — capture primary partial + snapshot at freeze + 2 getters.
                                 #   Responsibilities: gather Issue-1 seed data; inert until T2 wires it.
tests/stream-proxy-capture.test.ts  # NEW — drives the proxy with the realistic mock through a mid-
                                 #   reasoning abort; asserts frozenPrimaryContent + contentIndexOffset.
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (tsc gate — the #1 trap): AssistantMessageEvent is a discriminated union where `partial`
// exists on EVERY non-terminal member but NOT on done/error (they carry message/error). The work-item
// contract's bare `if (event.partial)` is a `tsc` ERROR under strict mode: "Property 'partial' does not
// exist on type 'TerminalEvent'". And `npm run build` (=`tsc`) IS a real gate (src/ is compiled). FIX:
// narrow out terminals first with the already-imported `isTerminalEvent` type guard, then access .partial:
//     if (!isTerminalEvent(event) && event.partial) { this._primaryPartial = event.partial; }
// After `!isTerminalEvent(event)`, the union excludes done/error, so event.partial is type-safe.
// (This also matches intent: terminals carry no partial anyway.) Verified: NO existing `.partial` access
// anywhere in src/ — this narrowing idiom is new but idiomatic (file uses isTerminalEvent everywhere).

// CRITICAL (guard that keeps the 384-test suite green — the #2 trap): the existing placeholder mocks
// (makeScriptedTwoPhaseUpstream in invariant-harness.ts; makeAbortableUpstream in stream-proxy-abort.test.ts)
// build events via ev({type:'thinking_delta', contentIndex:0, delta:'x'}) with NO `partial` field. With the
// new capture line, those events → event.partial is undefined → falsy → _primaryPartial stays undefined →
// at freeze: _frozenPrimaryContent = (undefined?.content ?? []).map(...) === [] and _contentIndexOffset = 0.
// → T2's future rewrite is a no-op for the entire existing suite. Do NOT make _primaryPartial default to a
// sentinel object — `undefined` is REQUIRED for the guard. Verify with `npm test` (must stay 384 + 1 new).

// CRITICAL (timing — capture AFTER freeze, at the abort branch): the snapshot must run in run()'s catch,
// the `if (this._controller.getState() === "Aborting")` branch, immediately AFTER `this._buffer.freeze();`
// and BEFORE the `proxy.abort.completed` trace. It must NOT run in the natural-completion path
// (_upstreamCompleted) or the unexpected-throw path (synthesized error) — those are not aborts and must
// not capture. The freeze() at the same boundary is the timing anchor.

// CRITICAL (shallow-per-block clone, not a deep clone lib): the contract specifies `{ ...b }` per block.
// Content blocks are plain data objects ({type:'thinking', thinking:string}); a shallow clone captures the
// frozen TEXT value before any post-abort mutation of the live primaryOutput. Do NOT use structuredClone
// (the blocks may carry non-cloneable fields in other providers; {...b} is the spec'd, minimal, sufficient
// clone). Type _frozenPrimaryContent as ReadonlyArray<Record<string, unknown>> exactly as the contract.

// GOTCHA (the capture line runs on EVERY primary event, last wins): _primaryPartial is overwritten on each
// non-terminal primary event. The LAST one (most-complete content) is what gets cloned. Because the mock
// mutates primaryOutput.content in place, by the time of the mid-reasoning abort, primaryOutput.content is
// [{type:'thinking', thinking:'<all deltas so far>'}] — so the clone captures the full accumulated text.

// GOTCHA (the replacement is launched after the snapshot): after freeze() + snapshot, run() calls
// _launchReplacement (mock call 2). The test asserts AT FREEZE TIME (waitFor proxy.abort.completed), so the
// replacement state does not affect the assertion. For clean test hygiene, optionally push a replacement
// `done` and drain proxy.output so the proxy terminates (no hanging 15ms startup-timeout net). Either way
// the snapshot is already populated — see research notes §6.

// GOTCHA (bun is not on PATH): run tests via `./node_modules/.bin/bun test ...` or `npm test`. `npm run
// build` runs `tsc` (the src/ type gate).

// SCOPE: do NOT implement the T2 rewrite (contentIndex offsetting / partial+message merging) — T1 only
// captures. Do NOT modify _emit, _launchReplacement, trackEvent, the controller, the buffer, types.ts, or
// any helper. Do NOT import consumeLikeAgentLoop (that is P1.M2.T3.S1). T1 changes NO downstream output.
```

---

## Implementation Blueprint

### Data models and structure

No new public types. Three private fields + two public read-only getters on `StreamProxy`. `AssistantMessage`
is already imported in proxy.ts. Place the fields near the other private fields (e.g. after `_authority`),
and the getters near the other getters (after `get authority()`).

```typescript
// (private fields — added to the StreamProxy class)
private _primaryPartial: AssistantMessage | undefined;
private _frozenPrimaryContent: ReadonlyArray<Record<string, unknown>> = [];
private _contentIndexOffset = 0;

// (public read-only getters — follow the _output/output, _controller/controller convention)
get frozenPrimaryContent(): ReadonlyArray<Record<string, unknown>> { return this._frozenPrimaryContent; }
get contentIndexOffset(): number { return this._contentIndexOffset; }
```
> The contract specifies the fields as private. The codebase convention is private-field + public-getter
> for every internal the outside world/tests need (`output`, `controller`, `buffer`, `authority`). The two
> getters satisfy the contract's OUTPUT ("available for P1.M2.T2.S1") AND let the test assert without
> `as any` casts. Do NOT add setters.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — add the private fields + getters
  - ADD three private fields (above) near `_authority`. ADD two read-only getters near `get authority()`.
  - IMPORT: none new — AssistantMessage is already imported; isTerminalEvent already imported from ../types.
  - FOLLOW pattern: the existing `_authority: ProxyPhase = "forwarding"` field + `get authority()` getter
      (verbatim copy of the private-field + JSDoc + read-only-getter shape). Add forward-compat JSDoc on each
      new field/getter referencing P1.M2.T2.S1 (the consumer) and P1.M2.T1.S1 (this subtask).
  - NAMING: _primaryPartial, _frozenPrimaryContent, _contentIndexOffset (private); frozenPrimaryContent,
      contentIndexOffset (public getters) — exactly the contract's names.
  - PLACEMENT: fields grouped with the other per-request state fields; getters grouped with the other
      read-only accessors. Constructor UNCHANGED (defaults suffice).

Task 2: MODIFY src/provider/proxy.ts — capture the primary partial in run()'s primary loop
  - EDIT run()'s `for await (const event of upstream)` loop: right after `this.trackEvent(event);
      this._emit(event);` and BEFORE the FM-005 `if (isTerminalEvent(event)) { this._upstreamCompleted = true; }`
      block, add:
        if (!isTerminalEvent(event) && event.partial) {
          this._primaryPartial = event.partial;
        }
  - CRITICAL: the `!isTerminalEvent(event)` guard is REQUIRED for tsc (terminal members lack .partial) AND
      matches intent (only non-terminal events carry a partial). Verify with `npm run build` (tsc) — the
      bare contract form `if (event.partial)` FAILS the build.
  - PRESERVE: the existing trackEvent/emit/_upstreamCompleted ordering; do not touch trackEvent/_emit.

Task 3: MODIFY src/provider/proxy.ts — snapshot at the abort boundary in run()'s catch
  - EDIT run()'s catch, the `if (this._controller.getState() === "Aborting")` branch: immediately AFTER
      `this._buffer.freeze();` and BEFORE `this.diagnostics.trace("proxy.abort.completed", {});`, add:
        this._frozenPrimaryContent = (this._primaryPartial?.content ?? []).map((b) => ({ ...b }));
        this._contentIndexOffset = this._frozenPrimaryContent.length;
  - CRITICAL: this branch ONLY (the expected-abort path). Do NOT add the snapshot to the natural-completion
      branch (`if (this._upstreamCompleted)`) or the unexpected-throw branch (synthesized error) — those are
      not aborts. The `_buffer.freeze()` call at the same boundary is the timing anchor.
  - CRITICAL: shallow-per-block clone `{ ...b }` (not structuredClone). The `?? []` is the GUARD: when
      _primaryPartial is undefined (placeholder mocks), frozen content is [] and offset is 0 → T2 no-op.
  - PRESERVE: completeAbort(), the freeze() call, the trace, and the subsequent _launchReplacement() call.

Task 4: CREATE tests/stream-proxy-capture.test.ts — the capture test (TDD; drives the real proxy)
  - IMPLEMENT: a bun:test that builds StreamProxy with makeRealisticTwoPhaseMock's fn, drives a primary
      reasoning stream, triggers abort mid-reasoning, and asserts the captured frozen content + offset.
  - FOLLOW pattern: tests/stream-proxy-abort.test.ts "clean abort happy path" (construction + the
      drive→waitFor(isReasoning)→triggerStop→waitFor(proxy.abort.completed) timing). Import the test
      doubles from tests/helpers/invariant-harness.ts (makeCaptureDiag, makeModel, waitFor) per the
      contract's MOCKING requirement.
  - IMPORTS:
      import { describe, test, expect } from "bun:test";
      import { StreamProxy } from "../src/provider/proxy";
      import { TransitionController } from "../src/state/controller";
      import { ReasoningBuffer } from "../src/buffer";
      import { DEFAULT_CONFIG } from "../src/config";
      import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
      import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";
  - SCENARIO + ASSERTIONS (proves the capture):
      a. const { diag, events } = makeCaptureDiag();
         const controller = new TransitionController(diag);
         const buffer = new ReasoningBuffer(diag, 1_000_000);
         const mock = makeRealisticTwoPhaseMock();
      b. const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller,
         buffer, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15 /* replacementStartupTimeoutMs */);
      c. Drive PRIMARY (reasoning ON, realistic partials):
         mock.pushPrimary({ type: "start" });
         mock.pushPrimary({ type: "thinking_start" });
         mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
         mock.pushPrimary({ type: "thinking_delta", delta: " me" });
         await waitFor(() => proxy.isReasoning());   // run() processed the thinking events → _primaryPartial set
      d. Abort mid-reasoning: expect(proxy.triggerStop()).toBe(true);   // Aborting + _internalAbort.abort()
         await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot done
      e. ASSERT (the contract OUTPUT):
         expect(proxy.frozenPrimaryContent).toHaveLength(1);
         expect(proxy.frozenPrimaryContent[0]).toMatchObject({ type: "thinking", thinking: "Let me" });
         expect(proxy.contentIndexOffset).toBe(1);
      f. (Clean up — optional but recommended, research notes §6): push a replacement done and drain output
         so the proxy terminates (no hanging 15ms net):
           mock.pushReplacement({ type: "done" });
           for await (const _e of proxy.output) { /* drain to completion */ }
      g. (Guard test — proves the placeholder-mock no-op so the suite stays green): a SECOND test that builds
         the proxy with a placeholder upstream whose events carry NO partial (e.g. reuse
         makeScriptedTwoPhaseUpstream from invariant-harness + ev({...}), or push primary events with no
         partial via the realistic mock is NOT possible since it always stamps partial — so use the
         placeholder mock path like stream-proxy-abort.test.ts), drives start→thinking_start→thinking_delta,
         triggerStop, waitFor(proxy.abort.completed), and asserts proxy.frozenPrimaryContent is [] and
         proxy.contentIndexOffset === 0. (This documents the GUARD and protects against regressions that
         would break the existing 384 tests.)
  - NAMING: test("P1.M2.T1.S1: captures the primary frozen thinking block + contentIndex offset at the abort
      boundary", …) and test("P1.M2.T1.S1: placeholder partials (no partial) yield empty frozen content and
      zero offset (guard)", …). Group under `describe("StreamProxy — primary content capture (P1.M2.T1.S1)")`.
  - COVERAGE: realistic-partial capture (1 thinking block, accumulated text, offset 1); placeholder guard
      ([], 0). Do NOT assert on replacement output or consumer assembly (P1.M2.T2/T3).
  - PLACEMENT: tests/stream-proxy-capture.test.ts.
```

### Implementation Patterns & Key Details

```typescript
// src/provider/proxy.ts — the three edits (verbatim; see research notes §1 for the surrounding context).

// EDIT 1 — new private fields (place near `_authority`):
//   (JSDoc each: "P1.M2.T1.S1 — …; seed data for the replacement rewrite (P1.M2.T2.S1).")
private _primaryPartial: AssistantMessage | undefined;
private _frozenPrimaryContent: ReadonlyArray<Record<string, unknown>> = [];
private _contentIndexOffset = 0;
// EDIT 1b — new getters (place near `get authority()`):
get frozenPrimaryContent(): ReadonlyArray<Record<string, unknown>> { return this._frozenPrimaryContent; }
get contentIndexOffset(): number { return this._contentIndexOffset; }

// EDIT 2 — run() primary loop, after `this.trackEvent(event); this._emit(event);`:
//   The `!isTerminalEvent(event)` guard is the tsc-safe form of the contract's `if (event.partial)`.
if (!isTerminalEvent(event) && event.partial) {
  this._primaryPartial = event.partial; // last non-terminal primary event wins (most-complete content)
}

// EDIT 3 — run() catch, the `getState() === "Aborting"` branch, right after `this._buffer.freeze();`:
this._buffer.freeze();
this._frozenPrimaryContent = (this._primaryPartial?.content ?? []).map((b) => ({ ...b })); // shallow-per-block
this._contentIndexOffset = this._frozenPrimaryContent.length;                              // = block count
this.diagnostics.trace("proxy.abort.completed", {});
```

```typescript
// tests/stream-proxy-capture.test.ts — the capture test (sketch; fill from the task list).
import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";
// For the guard test only:
import { makeScriptedTwoPhaseUpstream } from "./helpers/invariant-harness";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

describe("StreamProxy — primary content capture (P1.M2.T1.S1)", () => {
  test("captures the primary frozen thinking block + contentIndex offset at the abort boundary", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeRealisticTwoPhaseMock();

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15, // orphan-safe replacement startup timeout
    );

    // Drive PRIMARY (reasoning ON) with realistic partials → primaryOutput.content grows to [{thinking}].
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
    mock.pushPrimary({ type: "thinking_delta", delta: " me" });
    await waitFor(() => proxy.isReasoning()); // run() has processed the thinking events

    expect(proxy.triggerStop()).toBe(true); // Aborting + _internalAbort.abort() → primary throws
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot

    // THE CAPTURE: one structured thinking block (NOT a raw delta string) + offset = block count.
    expect(proxy.frozenPrimaryContent).toHaveLength(1);
    expect(proxy.frozenPrimaryContent[0]).toMatchObject({ type: "thinking", thinking: "Let me" });
    expect(proxy.contentIndexOffset).toBe(1);

    // Clean up: let the replacement complete so no timer/rejection leaks.
    mock.pushReplacement({ type: "done" });
    for await (const _e of proxy.output) { /* drain to completion */ }
  });

  test("placeholder partials (no partial) yield empty frozen content and zero offset (guard)", async () => {
    // The existing suite uses ev({...}) events with NO partial — this MUST stay a no-op (→ 384 tests green).
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const mock = makeScriptedTwoPhaseUpstream(); // placeholder mock; events have no `partial`

    const proxy = new StreamProxy(
      makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
      DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15,
    );
    const ev = (p: { type: string } & Partial<AssistantMessageEvent>): AssistantMessageEvent =>
      ({ ...p } as unknown as AssistantMessageEvent);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    expect(proxy.triggerStop()).toBe(true);
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed"));

    expect(proxy.frozenPrimaryContent).toEqual([]); // guard: undefined partial → []
    expect(proxy.contentIndexOffset).toBe(0);       // guard: → T2 rewrite is a no-op

    mock.pushReplacement(ev({ type: "error", reason: "error", error: { role: "assistant", content: [] } as never }));
    for await (const _e of proxy.output) { /* drain */ }
  });
});
```

### Integration Points

```yaml
PRODUCTION CODE:
  - modify file: src/provider/proxy.ts
      - add fields: _primaryPartial (AssistantMessage | undefined), _frozenPrimaryContent
        (ReadonlyArray<Record<string, unknown>> = []), _contentIndexOffset (= 0).
      - add getters: frozenPrimaryContent, contentIndexOffset (read-only).
      - run() primary loop: capture line after trackEvent+_emit, before the FM-005 block.
      - run() abort catch branch: 2 snapshot lines after _buffer.freeze(), before the abort.completed trace.
  - NOT modified: src/types.ts, src/state/*, src/buffer/*, src/request/*, src/provider/decorator.ts,
    src/index.ts. git diff --stat -- src/ shows ONLY proxy.ts.

TEST CODE:
  - add file: tests/stream-proxy-capture.test.ts (2 tests).

BUILD/CONFIG: NONE. tsconfig.json already compiles src/ (the tsc gate). No package.json changes. No new deps.

DOWNSTREAM (do NOT wire now — T1's data is inert until these consume it):
  - P1.M2.T2.S1: reads this.frozenPrimaryContent + this.contentIndexOffset inside _emit()'s splicing branch
    to offset replacement contentIndex and merge partial/message content.
  - P1.M2.T3.S1: end-to-end consumer-harness test proving [thinking, text] preservation AFTER T2 wires T1.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# THE PRIMARY GATE — this is a src/ change, so tsc MUST pass. The bare `event.partial` from the contract
# FAILS this unless narrowed with !isTerminalEvent(event) (see Context §Known Gotchas).
npm run build
# Expected: 0 diagnostics. (If "Property 'partial' does not exist on type 'TerminalEvent'" → you wrote the
#   bare `if (event.partial)`; replace with `if (!isTerminalEvent(event) && event.partial)`.)

npm run typecheck   # = tsc --noEmit — equivalent gate; 0 diagnostics.

# Confirm ONLY proxy.ts changed in src/ and the new test was added:
git diff --stat -- src/            # Expected: src/provider/proxy.ts only
git status --short -- tests/       # Expected: ?? tests/stream-proxy-capture.test.ts (and no other changes)
```

### Level 2: Unit Tests (Component Validation)

```bash
# Run the new capture test in isolation:
npm test tests/stream-proxy-capture.test.ts
# Expected: 2 passing. Realistic-mock case: frozenPrimaryContent = [{type:'thinking', thinking:'Let me'}],
#   contentIndexOffset === 1. Guard case: frozenPrimaryContent = [], contentIndexOffset === 0.

# Full suite — confirms the placeholder-mock guard preserved every existing test:
npm test
# Expected: 385 pass / 0 fail (baseline 384 + the 2 new tests = 386? see note). 
#   NOTE on count: baseline is 384. This subtask ADDS 2 tests (the capture test + the guard test), so the
#   expected total is 386. If you implement only 1 test, expect 385. Either way: 0 FAIL is the hard gate.
```

### Level 3: Integration (the capture fires at the real abort boundary)

```bash
# Prove the snapshot runs in run()'s abort branch (not the natural-completion or error path) by confirming
# the capture test's waitFor(proxy.abort.completed) precedes the assertions (it does — see Task 4 step d→e).
# Re-run the full abort suite to confirm the new capture line did not disturb abort coordination:
npm test tests/stream-proxy-abort.test.ts
# Expected: all existing abort tests still pass (the capture line is a pure read on event.partial; the
#   snapshot is additive after freeze()).

# Confirm the guard really no-ops for placeholder mocks (the full regression/stress/chaos suites use them):
npm test tests/regression-tests.test.ts tests/stress-tests.test.ts tests/chaos-tests.test.ts tests/property-tests.test.ts
# Expected: all pass — proof that frozenPrimaryContent stays [] for every placeholder-mock scenario.
```

### Level 4: Domain-Specific Validation (Capture Contract Audit)

```bash
# Audit the exact capture mechanics are present and correct in proxy.ts:
grep -n "_primaryPartial"               src/provider/proxy.ts   # → field decl + capture line (≥2) + snapshot read
grep -n "_frozenPrimaryContent"         src/provider/proxy.ts   # → field decl + snapshot write + getter (≥3)
grep -n "_contentIndexOffset"           src/provider/proxy.ts   # → field decl + snapshot write + getter (≥3)
grep -n "frozenPrimaryContent\|contentIndexOffset" src/provider/proxy.ts  # → the two public getters
grep -n "!isTerminalEvent(event) && event.partial" src/provider/proxy.ts  # → the tsc-safe capture guard (≥1)
grep -n "\.map((b) => ({ ...b }))"      src/provider/proxy.ts   # → shallow-per-block clone (NOT structuredClone)
grep -n "this._buffer.freeze()"         src/provider/proxy.ts   # → the snapshot sits immediately AFTER this
# Confirm the snapshot is in the Aborting branch only (not the _upstreamCompleted / synthesized-error paths):
grep -n "getState() === \"Aborting\""   src/provider/proxy.ts   # → the snapshot's enclosing branch

# Confirm the new test drives the REAL proxy with the realistic mock and asserts via the getters:
grep -n "makeRealisticTwoPhaseMock"     tests/stream-proxy-capture.test.ts  # → realistic case (≥1)
grep -n "frozenPrimaryContent\|contentIndexOffset" tests/stream-proxy-capture.test.ts  # → assertions (≥3)
grep -n "proxy.triggerStop()"           tests/stream-proxy-capture.test.ts  # → mid-reasoning abort (≥1)
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npm run build` (tsc) → 0 diagnostics (the `!isTerminalEvent` narrowing is what makes this pass).
- [ ] `npm run typecheck` → 0 diagnostics.
- [ ] `npm test` full suite green (0 fail). Baseline 384 preserved; +2 new tests (capture + guard).
- [ ] `git diff --stat -- src/` shows ONLY `src/provider/proxy.ts`; no other src/ or helper file modified.

### Feature Validation
- [ ] `proxy.ts` adds `_primaryPartial`, `_frozenPrimaryContent`, `_contentIndexOffset` (private) +
      `frozenPrimaryContent`, `contentIndexOffset` (read-only getters), named exactly per the contract.
- [ ] The primary loop captures `event.partial` (last non-terminal wins), narrowed with `!isTerminalEvent(event)`.
- [ ] The abort catch branch clones `_primaryPartial.content` (shallow-per-block `{...b}`) into
      `_frozenPrimaryContent` and sets `_contentIndexOffset = length`, immediately after `_buffer.freeze()`.
- [ ] GUARD verified: no primary partial → frozen `[]`, offset `0` (the guard test asserts this).
- [ ] Capture test passes: mid-reasoning abort → one `{type:"thinking", thinking:"Let me"}` block + offset 1.
- [ ] Snapshot is in the `Aborting` branch ONLY (not natural-completion, not synthesized-error paths).

### Code Quality & Documentation
- [ ] New fields/getters follow the existing private-field + read-only-getter convention (`_authority`/`authority`).
- [ ] Each new field/getter has JSDoc cross-referencing P1.M2.T1.S1 (this subtask) and P1.M2.T2.S1 (consumer).
- [ ] Constructor is unchanged; defaults suffice (`_primaryPartial` undefined, `_frozenPrimaryContent = []`,
      `_contentIndexOffset = 0`).
- [ ] Privacy (Appendix H) preserved — no new diagnostics touch content; the capture is internal state only.
- [ ] No `_emit` / `_launchReplacement` / `trackEvent` / controller / buffer / types.ts changes.

### Scope Discipline (cohesion — do not harm sibling work items)
- [ ] T1 only CAPTURES; the T2 rewrite (contentIndex offset + partial/message merge) is NOT implemented here.
- [ ] T1 changes NO downstream output (inert until T2 wires the getters into `_emit()`'s splicing branch).
- [ ] `consumeLikeAgentLoop` is NOT imported (that integration is P1.M2.T3.S1, after T2).

---

## Anti-Patterns to Avoid

- ❌ Don't write the bare `if (event.partial)` from the contract verbatim — it is a `tsc` error (done/error
  lack `.partial`) and FAILS `npm run build`. Narrow with `!isTerminalEvent(event)` first.
- ❌ Don't put the snapshot in the natural-completion branch (`if (this._upstreamCompleted)`) or the
  unexpected-throw branch (synthesized error) — only the `Aborting` branch is an abort and only it freezes.
- ❌ Don't use `structuredClone` for the content blocks — the contract specifies the shallow-per-block
  `{ ...b }` clone (minimal, sufficient, avoids non-cloneable-field edge cases in other providers).
- ❌ Don't default `_primaryPartial` to a sentinel object — it MUST be `undefined` so the `?? []` guard
  yields frozen `[]` + offset `0` for placeholder mocks (keeps the 384-test suite green).
- ❌ Don't implement the T2 rewrite here (offsetting contentIndex / merging partial+message) — T1 is
  capture-only. Adding the rewrite now expands blast radius and steps on P1.M2.T2's scope.
- ❌ Don't capture from the `ReasoningBuffer` snapshot — it has raw delta strings, NOT structured content
  blocks. The consumer indexes `partial.content[contentIndex]` on structured blocks; capture from
  `event.partial.content`.
- ❌ Don't assert on replacement output or consumer assembly in T1's test — that is P1.M2.T2/T3. Assert only
  `frozenPrimaryContent` + `contentIndexOffset`.
- ❌ Don't re-declare `makeCaptureDiag`/`makeModel`/`waitFor` locally — import them from
  `tests/helpers/invariant-harness.ts` (the contract's MOCKING requirement points there).
- ❌ Don't leave the test's replacement stream hanging without cleanup (push a replacement `done`/`error`
  and drain `proxy.output`, or rely on the 15ms orphan timeout) — avoids timer/rejection leaks.

---

## Confidence Score: **9/10**

The change is small, additive, and fully specified: the three exact insertion points are quoted verbatim
from `src/provider/proxy.ts` (primary loop + abort catch branch + field/getter block), the type-narrowing
required to pass `tsc` is spelled out (`!isTerminalEvent(event)` — verified against the pi-ai union at
`node_modules/@earendil-works/pi-ai/dist/types.d.ts:251–293`), the placeholder-mock guard that keeps the
384-test suite green is proven, the realistic mock surface is shipped and its accumulation mechanics are
verified, and the test-driving idiom is copied from the existing `stream-proxy-abort.test.ts`. Validation
commands are project-verified (`bun` is at `node_modules/.bin/bun`; baseline = 384 pass). Residual risk is
only in the exact expected test COUNT (1 vs 2 new tests) — addressed by stating "0 fail is the hard gate."
T1 changes no downstream output (inert until T2), so it cannot regress Issue-1-adjacent behavior.
