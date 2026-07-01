# PRP — P1.M2.T3.S1: Consumer-Harness Integration Test (Issue 1 End-to-End Regression Guard)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (bugfix 001: stream-integrity & shortcut lifecycle).
> **Subtask**: P1.M2.T3.S1 (Issue 1 — Reasoning Content Preservation, 1 pt, **test-only**).
> **Deliverable**: ONE new test file `tests/consumer-integration.test.ts` that drives the **real**
> `StreamProxy` through the **realistic two-call mock** (`P1.M1.T1.S2`) and consumes `proxy.output`
> with the **faithful agent-loop consumer harness** `consumeLikeAgentLoop` (`P1.M1.T1.S1`). It proves
> the Issue-1 fix (`P1.M2.T2.S1` + `P1.M2.T2.S2`) **end-to-end through the same assembly path Pi uses**,
> and is a **regression guard** that FAILS before the fix.
> **Builds on (all DONE)**: `consumeLikeAgentLoop` (`tests/helpers/consumer-harness.ts`),
> `makeRealisticTwoPhaseMock` (`tests/helpers/realistic-mock.ts`), the fixed `StreamProxy`
> (`src/provider/proxy.ts` — `_rewriteReplacementEvent` / `_rewriteReplacementTerminal` / `_mergePartial`),
> and the shared `invariant-harness` doubles (`makeCaptureDiag` / `makeModel` / `waitFor`).

---

## Goal

**Feature Goal**: Add an integration test that closes the **blind spot** the bug report (§Overview /
§Testing Summary) identified: *"the existing suite asserts on raw forwarded events but never runs the
real `pi-agent-core` consumer (`partialMessage = event.partial` + `response.result()` → `done.message`),
so it could not see Issue 1."* The test assembles the **exact consumer path**: realistic mock →
`StreamProxy` (abort→freeze→snapshot→replacement→**rewrite**) → `consumeLikeAgentLoop` → asserts the
**persisted** `finalMessage.content === [thinking, text]` with the **full** primary reasoning preserved,
asserts the **streaming partial view never flickers** (no text-block-first partial after the splice), and
asserts the **replacement call had `reasoning === undefined`**. It also adds a **negative control**
showing an *uninterrupted* stream through the same mock yields the **same** `[thinking, text]` structure
— proving **observational equivalence** (Story 3 / G4 / ADR-005).

**Deliverable**: `tests/consumer-integration.test.ts` — a Bun test file with exactly **two** tests:
1. **POSITIVE / interrupted** (the regression guard): push primary reasoning → `triggerStop()` mid-reasoning
   → push replacement answer → consume via harness → assert `[thinking, text]` persistence + reasoning
   preserved + partial no-flicker + `mock.calls[1].options.reasoning === undefined`.
2. **NEGATIVE CONTROL / uninterrupted**: push a full normal reasoning→answer stream through the same mock
   (no stop) → consume via harness → assert the **same** `[thinking, text]` structure (observational
   equivalence).

**Success Definition**: From a clean checkout, `npx bun test tests/consumer-integration.test.ts` → both
tests green; `npx bun run typecheck` → 0 diagnostics; `npx bun test` → all green (the new 2 tests +
existing 389 = 391). The positive test is a true regression guard: its assertions are constructed so that
**pre-fix** (verbatim replacement forwarding) `finalMessage.content` would be `[text]` (reasoning lost) and
a post-splice partial would lead with `text` (flicker) — both asserted-against here. **No source changes.**

---

## Why

- **This test is the proof that Issue 1 is actually fixed.** `P1.M2.T2.S1`/`S2` changed the proxy to
  rewrite replacement events (contentIndex offset + merged partial + merged terminal message). Those
  changes have **narrow unit tests** (`tests/stream-proxy-rewrite.test.ts`, `tests/stream-proxy-terminal-
  rewrite.test.ts`) that assert on the *rewritten events* / the *persistence* field in isolation. But the
  bug was invisible precisely because no test ran the **full consumer assembly** (`partialMessage =
  event.partial` on every event + `finalMessage = response.result()`). This test runs that full assembly
  and asserts the **user-visible, persisted** outcome — the thing that was actually broken.
- **It locks in the no-flicker streaming guarantee (G4).** The bug wasn't only about the persisted message;
  the *streaming* view also flickered (reasoning vanished, replaced by text) because each replacement event
  stamped a fresh text-only `partial`. The contract explicitly requires asserting `partialHistory` "ALWAYS
  contains a thinking block at index 0 at every step after the splice (no flicker/restart artifact)". The
  existing terminal-rewrite test does NOT assert `partialHistory` at all — this test does.
- **The negative control makes "fixed" meaningful.** "Reasoning is preserved" is only valuable if the
  interrupted response still *looks like a normal response* (Story 3). The negative control proves the
  interrupted `[thinking, text]` is byte-structurally identical to an uninterrupted `[thinking, text]`
  through the same mock — the operational definition of observational equivalence (ADR-005 / §19.7).

## What

Create `tests/consumer-integration.test.ts` containing **two** `bun:test` tests (full reference code in
"Implementation Patterns"). Both reuse the established helper imports:

- `consumeLikeAgentLoop` from `./helpers/consumer-harness` — returns `{ finalMessage, events, partialHistory }`.
- `makeRealisticTwoPhaseMock` from `./helpers/realistic-mock` — exposes `fn`, `calls`, `pushPrimary`,
  `pushReplacement`, `closePrimary`, `primaryOutput`, `replacementOutput`. The mock **derives**
  `contentIndex` + stamps the **live accumulating** `partial`/`message` exactly like the real
  `openai-completions` provider, so it reproduces the contentIndex-0 collision + partial-switching that
  caused Issue 1.
- `makeCaptureDiag` / `makeModel` / `waitFor` from `./helpers/invariant-harness` (the same doubles the
  existing replacement/terminal-rewrite suites use).
- `StreamProxy`, `TransitionController`, `ReasoningBuffer`, `DEFAULT_CONFIG` from `../src/...`.

### Test 1 — interrupted (regression guard)

1. Build the proxy over a fresh realistic mock (mirror the terminal-rewrite test's constructor call —
   `{ reasoning: "high" }` options, generous timeouts).
2. Push the **primary** reasoning stream: `start → thinking_start → thinking_delta ×3 → thinking_end`.
   (The mock owns `contentIndex`=0 and the live `partial`.)
3. `await waitFor(() => proxy.isReasoning())` — `run()` has processed the thinking events.
4. `expect(proxy.triggerStop()).toBe(true)` — abort dispatched → upstream throws → `run()` catch →
   `completeAbort()` + `buffer.freeze()` + snapshot (`_frozenPrimaryContent`/`_contentIndexOffset`).
5. `await waitFor(() => events.some(c => c.event === "proxy.abort.completed"))` — freeze+snapshot done,
   which guarantees the replacement was launched.
6. **Assert `mock.calls.length === 2`** (calls[0]=primary, calls[1]=replacement) and
   **`mock.calls[1].options?.reasoning === undefined`** (the proxy forced thinking off — PRD §25.6).
7. Push the **replacement** stream: `start → text_start → text_delta → done`. (The proxy **suppresses**
   the replacement `start` (INV-002) and **rewrites** `text_*` (offset contentIndex + merged partial) and
   the `done` (merged `message`).)
8. `const result = await consumeLikeAgentLoop(proxy.output)`.
9. **Assert persistence**: `finalMessage.content.map(b=>b.type) === ["thinking","text"]`; `.length === 2`;
   `content[0]` is `thinking` with the **full** concatenated reasoning text; `content[1]` is `text` with
   the replacement answer.
10. **Assert no flicker (G4)**: every `partial` in `result.partialHistory` has `content[0]?.type !== "text"`
    (no partial ever leads with text); and every **post-splice** partial (one that contains a text block)
    has `content[0]?.type === "thinking"`.

### Test 2 — negative control (uninterrupted; observational equivalence)

1. Build a fresh proxy over a fresh realistic mock.
2. Push a **normal** reasoning→answer stream into the **primary** only (NO `triggerStop`):
   `start → thinking_start → thinking_delta ×3 → thinking_end → text_start → text_delta → text_end → done`.
3. `const result = await consumeLikeAgentLoop(proxy.output)`.
4. Assert the **same** `[thinking, text]` structure as Test 1 (same reasoning text, same answer text).

**Out of scope** (do NOT do here): any change to `src/**`, `tests/helpers/**`, or any existing test file;
Issue 2 / Issue 3 coverage (P1.M3 / P1.M4); adding scenarios beyond these two tests. This is **test-only**.

### Success Criteria

- [ ] `tests/consumer-integration.test.ts` exists with exactly two tests (POSITIVE interrupted + NEGATIVE
      control uninterrupted) using `consumeLikeAgentLoop` + `makeRealisticTwoPhaseMock`.
- [ ] POSITIVE asserts `finalMessage.content` types `["thinking","text"]`, `.length === 2`, `content[0]`
      thinking with the FULL concatenated primary reasoning, `content[1]` text with the replacement answer.
- [ ] POSITIVE asserts the no-flicker guarantee on `partialHistory` (no text-block-first partial; every
      text-bearing partial leads with thinking).
- [ ] POSITIVE asserts `mock.calls.length === 2` and `mock.calls[1].options.reasoning === undefined`.
- [ ] POSITIVE asserts `proxy.triggerStop() === true` (it was in `Reasoning` when stopped).
- [ ] NEGATIVE asserts the same `[thinking, text]` structure through an uninterrupted primary stream.
- [ ] The POSITIVE test is a **regression guard** — its assertions fail against a verbatim-forwarding proxy
      (reasoning lost + flicker), as explained in "Known Gotchas".
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun test tests/consumer-integration.test.ts` → 2/2 green; `npx bun test` → all green (391 total).
- [ ] No edits to any file under `src/`, `tests/helpers/`, or any existing `tests/*.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact** runtime contract of every collaborator the test wires together:
the `consumeLikeAgentLoop` return shape + the `partialMessage = event.partial` / `finalMessage =
result()` semantics it models; the realistic mock's `MockEventSpec` push API (no `contentIndex` — the mock
derives it) + its `calls[]` recording (calls[0]=primary, calls[1]=replacement); the `StreamProxy`
constructor signature (verified) + the abort→freeze→snapshot→replacement→rewrite control flow + the exact
diagnostics trace (`proxy.abort.completed`) that signals "snapshot done"; the established constructor-call
shape copied verbatim from the passing `tests/stream-proxy-terminal-rewrite.test.ts`; and the **complete
reference test file** to author against. Baseline confirmed: 389 tests pass.

### Documentation & References

```yaml
# The bug being guarded against (the "why")
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-agent-core-consumer.md
  why: "§1 = the LOCAL consumer (agent-loop.js): `partialMessage = event.partial` on EVERY non-terminal
        event, then `finalMessage = await response.result()` = the `done` event's `message` field. THIS is
        the assembly the test must run. §2 = the REMOTE consumer (proxy.js processProxyEvent) indexes
        `partial.content[contentIndex]` — the contentIndex-0 collision. §3 = provider output accumulation
        (one live `output` per call, `getContentIndex = blocks.indexOf`). §4 = why the 380-test suite
        missed it (no consumer harness)."
  critical: "The test's WHOLE POINT is to exercise §1's exact logic. consumeLikeAgentLoop already encodes
        it (it sets partialHistory from event.partial and resolves finalMessage from result()). Do NOT
        re-implement the consumer — call the harness."

# The collaborators (all DONE — read to author against their real surfaces)
- file: tests/helpers/consumer-harness.ts   # P1.M1.T1.S1
  why: "Exports `consumeLikeAgentLoop(stream): Promise<{finalMessage, events, partialHistory}>`. It
        for-awaits the stream, pushes a shallow copy of `event.partial` into partialHistory for every
        NON-terminal event (done/error excluded), and resolves finalMessage from `stream.result()` (5s
        timeout guard). This is the faithful agent-loop.js consumer."
  pattern: "Call it ONCE, after pushing the replacement events; `await` its result. Its internal 5s
        result()-timeout means the test can never hang on a broken proxy."
  gotcha: "partialHistory excludes the terminal event (done carries `message`, not `partial`). So the
        LAST entry in partialHistory is the final replacement text_delta's merged partial — assert on it
        for the no-flicker check."
- file: tests/helpers/realistic-mock.ts   # P1.M1.T1.S2
  why: "Exports `makeRealisticTwoPhaseMock(): { fn, calls, pushPrimary, pushReplacement, closePrimary,
        primaryOutput, replacementOutput }`. pushPrimary/pushReplacement take a `MockEventSpec` union
        ({type:'start'} | {type:'thinking_start'} | {type:'thinking_delta',delta} | {type:'thinking_end'}
        | {type:'text_start'} | {type:'text_delta',delta} | {type:'text_end'} | {type:'done'} |
        {type:'error',reason?}) — the MOCK derives contentIndex + stamps the live partial/message."
  critical: "Do NOT pass contentIndex/partial in the specs (the mock owns them — passing extra fields is
        harmless but pointless). The mock's `fn` is called by the PROXY (primary in run(), replacement in
        _launchReplacement); the test only pushes events. `calls[0]`=primary invocation, `calls[1]`=
        replacement invocation — assert `calls[1].options.reasoning === undefined`."
  gotcha: "The replacement iterator's `closed` is `() => false` and it returns after yielding a terminal
        (done/error) — so pushing `done` ends it cleanly; closePrimary() is NOT needed for the replacement.
        The PRIMARY throws `new Error('aborted')` when its AbortSignal aborts — that is the trigger for the
        proxy's abort→freeze path (do NOT call closePrimary in Test 1; triggerStop aborts it)."
- file: src/provider/proxy.ts   # the fixed StreamProxy (P1.M2.T2.S1+S2)
  why: "Constructor (line 240): `(model, context, options, upstreamStreamFn, diagnostics, controller?,
        buffer?, abortTimeoutMs=5000, requestBuilder?, replacementStartupTimeoutMs=10000, coordinator?)`.
        `triggerStop(): boolean` aborts the upstream (true only in Reasoning). `isReasoning(): boolean`.
        On abort: run() catch → completeAbort()+freeze()+snapshot (`_frozenPrimaryContent`,
        `_contentIndexOffset = frozenContent.length`) → _launchReplacement → rewrites replacement events
        via `_emit` → `_rewriteReplacementEvent` (offset contentIndex + `_mergePartial`) and
        `_rewriteReplacementTerminal` (merged done.message/error.error)."
  critical: "The rewrite is gated on `_contentIndexOffset > 0`, i.e. the primary had ≥1 captured content
        block. Test 1 MUST push at least one thinking event before triggerStop so the offset is 1 (else the
        rewrite is a no-op and the assertions would still pass trivially — NOT a valid guard). Pushing
        thinking_start+delta×3+thinking_end makes primaryOutput.content = [thinking], offset = 1."
  gotcha: "`proxy.abort.completed` trace is logged AFTER freeze+snapshot, immediately before
        _launchReplacement — so waitFor-ing it guarantees the replacement was launched (mock.calls[1] set)
        AND the frozen content is captured. The replacement's `start` is SUPPRESSED by _emit (INV-002) —
        the consumer never sees a second `start`."
- file: tests/stream-proxy-terminal-rewrite.test.ts   # the CLOSEST existing test — copy its shape
  why: "Already constructs the proxy over the realistic mock + consumes via consumeLikeAgentLoop. BUT it
        only asserts `finalMessage.content` (persistence) — it does NOT assert partialHistory (no-flicker),
        does NOT add a negative control, and does NOT assert mock.calls[1].reasoning. THIS subtask adds the
        missing coverage. Reuse its constructor-call shape verbatim."
  pattern: "`new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
        DEFAULT_CONFIG.transitionTimeoutMs, undefined, <startupMs>)` + `makeCaptureDiag()`/`makeModel()`/
        `waitFor()` from ./helpers/invariant-harness."
- file: tests/helpers/invariant-harness.ts   # shared doubles
  why: "Exports `makeCaptureDiag(): {diag, events}`, `makeModel()`, `waitFor(pred, timeoutMs=500)`. Use
        these (NOT local re-implementations) for consistency with the rest of the suite."

# PRD authority (bugfix PRD — read-only)
- url: bugfix PRD §Overview / §h3.0 (Issue 1) / §Testing Summary
  why: "Issue 1 = reasoning lost from persisted message on every interruption (contentIndex collision +
        partial switching). Expected = [thinking, text] like a normal response (Story 3 / G4). The
        'Steps to Reproduce' is EXACTLY what Test 1 automates."
- url: bugfix PRD §h3.0 "Suggested Fix" item 4
  why: "'Add an integration test that feeds the proxy output through a faithful copy of the pi-agent-core
        agent-loop consumer and asserts the final message content equals [thinking, text].' — THIS IS
        THAT TEST."
```

### Current Codebase tree (relevant slice — bugfix 001)

```bash
.
├── src/provider/proxy.ts          # FIXED StreamProxy (DONE) — imported, NOT edited
├── src/state/controller.ts        # TransitionController (DONE) — imported for DI
├── src/buffer/index.ts            # ReasoningBuffer (DONE) — imported for DI
├── src/config/index.ts            # DEFAULT_CONFIG (DONE) — imported for timeout defaults
├── tests/
│   ├── helpers/
│   │   ├── consumer-harness.ts        # consumeLikeAgentLoop (DONE) — IMPORTED
│   │   ├── realistic-mock.ts          # makeRealisticTwoPhaseMock (DONE) — IMPORTED
│   │   └── invariant-harness.ts       # makeCaptureDiag/makeModel/waitFor (DONE) — IMPORTED
│   ├── stream-proxy-terminal-rewrite.test.ts  # the narrow sibling test — copy its shape, do NOT edit
│   └── consumer-integration.test.ts   # ← THIS SUBTASK (NEW file, 2 tests)
└── (tsconfig excludes tests/ from build; `bun test` runs them natively)
```

### Desired Codebase tree (after this subtask)

```bash
.
└── tests/
    └── consumer-integration.test.ts   # NEW — Issue 1 end-to-end regression guard (2 tests)
```
**File responsibility**: `tests/consumer-integration.test.ts` proves Issue 1 is fixed end-to-end through
the real consumer assembly and guards against regression. No source files touched; no helpers touched; no
existing tests touched.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (the offset must be > 0 or the rewrite is a no-op → invalid guard): the proxy's replacement
// rewrite is gated on `this._contentIndexOffset > 0`. The offset = frozen primary content blocks. So Test 1
// MUST push thinking_start + ≥1 thinking_delta BEFORE triggerStop, so primaryOutput.content = [thinking]
// and offset = 1. (Pushing thinking_end too is fine and matches the contract's "thinking_end[0]".) If you
// triggerStop before any thinking event, offset = 0 → rewrite no-op → assertions still pass trivially and
// the test does NOT guard the bug.

// CRITICAL (Test 1 timing — do NOT push replacement events before the freeze): triggerStop() only
// DISPATCHES the abort; the freeze+snapshot happen asynchronously in run()'s catch. Push replacement
// events only AFTER `await waitFor(() => events.some(c => c.event === "proxy.abort.completed"))`. That
// trace is logged after freeze+snapshot, right before _launchReplacement — so by then mock.calls[1] exists
// AND the frozen content is captured.

// CRITICAL (the no-flicker assertion must tolerate the empty-content `start` partial): the PRIMARY `start`
// event's partial is primaryOutput with content: [] (no thinking yet). So partialHistory[0].content is [].
// Assert `content[0]?.type !== "text"` (optional chaining → undefined for []) — do NOT assert
// `content[0].type === "thinking"` unconditionally on EVERY partial, or the start partial fails. The
// robust form: (a) no partial leads with text; (b) every text-BEARING partial leads with thinking.

// GOTCHA (the realistic mock derives contentIndex — do NOT pass it): pushPrimary/pushReplacement take a
// MockEventSpec WITHOUT contentIndex/partial. The mock computes contentIndex via output.content.indexOf
// and stamps partial = the live output (exactly like openai-completions.js). Passing contentIndex is
// ignored/pointless.

// GOTCHA (the replacement `start` is suppressed — the consumer sees ONE start): _emit suppresses the
// replacement's `start` (INV-002). So consumeLikeAgentLoop's events/partialHistory contain exactly one
// `start` (the primary's). Do not assert a second start. The replacement text events (rewritten) ARE
// forwarded and DO appear in partialHistory.

// GOTCHA (negative control needs NO triggerStop and uses the PRIMARY phase end-to-end): the realistic mock
// is "two-phase" but a single uninterrupted response lives entirely in the PRIMARY phase — push
// start→thinking_*→text_*→done via pushPrimary only. The proxy forwards all (FSM stays in Reasoning; no
// normal-exit edge — harmless), output completes on `done`, finalMessage = done.message = primaryOutput
// (content: [thinking, text]). Do NOT call triggerStop in Test 2.

// GOTCHA (no concurrent consumer needed — output.push is non-blocking): EventStream.push buffers without
// backpressure, so the proxy drains the mock and forwards into output regardless of whether a consumer is
// attached. You may push all events then `await consumeLikeAgentLoop(proxy.output)` (the harness's internal
// 5s result()-timeout prevents hangs). The passing stream-proxy-terminal-rewrite.test.ts uses exactly this
// push-then-await ordering.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke `npx bun test ...` / `npx bun run typecheck`,
// NOT bare `bun`/`tsc`.

// GOTCHA (build excludes tests; typecheck checks src ONLY): `npx bun run typecheck` will NOT catch type
// errors in the new test. Validate the test with `npx bun test tests/consumer-integration.test.ts`
// (Bun type-checks TS natively as it runs).
```

---

## Implementation Blueprint

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE tests/consumer-integration.test.ts
  - IMPLEMENT: the two tests in "Implementation Patterns" (POSITIVE interrupted + NEGATIVE control).
  - IMPORT (value): StreamProxy (../src/provider/proxy); TransitionController (../src/state/controller);
    ReasoningBuffer (../src/buffer); DEFAULT_CONFIG (../src/config); makeRealisticTwoPhaseMock
    (./helpers/realistic-mock); consumeLikeAgentLoop (./helpers/consumer-harness); makeCaptureDiag,
    makeModel, waitFor (./helpers/invariant-harness); describe/test/expect (bun:test).
  - FACTOR: a local `buildRealisticProxy()` helper returning { proxy, diag, events, controller, buffer,
    mock } (mirrors the terminal-rewrite test's constructor call). Use { reasoning: "high" } options,
    DEFAULT_CONFIG.transitionTimeoutMs for abort timeout, 2000 for replacementStartupTimeoutMs.
  - FOLLOW pattern: tests/stream-proxy-terminal-rewrite.test.ts (the closest sibling — same imports, same
    constructor shape, same pushPrimary→waitFor(isReasoning)→triggerStop→waitFor(abort.completed)→
    pushReplacement→await consumeLikeAgentLoop flow).
  - NAMING: describe("Consumer integration — Issue 1 end-to-end (P1.M2.T3.S1)"); test names in "Patterns".
  - COVERAGE: persistence ([thinking,text] + full reasoning + answer); no-flicker (partialHistory);
    replacement reasoning===undefined; triggerStop===true; negative-control structural equivalence.
  - PLACEMENT: tests/consumer-integration.test.ts (flat tests/ dir; new file; excluded from build).

Task 2: VERIFY (validation only — no code changes)
  - RUN: npx bun test tests/consumer-integration.test.ts  → 2/2 green.
  - RUN: npx bun run typecheck                            → 0 diagnostics (src only; test validated by bun).
  - RUN: npx bun test                                     → all green (391 total: 389 existing + 2 new).
  - RUN: Level 3/4 gates below (grep scope-boundary + regression-guard reasoning).
```

### Implementation Patterns & Key Details

```typescript
// tests/consumer-integration.test.ts — COMPLETE reference. Author this verbatim.

/**
 * # Consumer Integration Test — Issue 1 end-to-end regression guard (P1.M2.T3.S1).
 *
 * Drives the REAL StreamProxy through the realistic two-call mock provider and consumes proxy.output with
 * consumeLikeAgentLoop — a faithful copy of pi-agent-core's agent-loop.js consumer
 * (`partialMessage = event.partial` on every non-terminal event; `finalMessage = response.result()` =
 * the done event's `message`). Asserts the Issue-1 fix end-to-end: an interrupted reasoning stream
 * PERSISTS as [thinking, text] (full reasoning preserved) with NO streaming flicker, and is
 * observationally equivalent to a normal (uninterrupted) response (Story 3 / G4 / ADR-005).
 *
 * REGRESSION GUARD: this test FAILS before the P1.M2.T2.S1+S2 fix. Pre-fix the proxy forwarded
 * replacement events verbatim → the replacement's fresh text-only `partial` replaced the primary reasoning
 * on every event (finalMessage.content = [text] only) and the streaming view led with a text block
 * (flicker). Both are asserted-against here.
 */

import { describe, test, expect } from "bun:test";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import { DEFAULT_CONFIG } from "../src/config";
import { makeRealisticTwoPhaseMock } from "./helpers/realistic-mock";
import { consumeLikeAgentLoop } from "./helpers/consumer-harness";
import { makeCaptureDiag, makeModel, waitFor } from "./helpers/invariant-harness";

/** Build the proxy over a fresh realistic mock (close to the production assembly path). */
function buildRealisticProxy() {
  const { diag, events } = makeCaptureDiag();
  const controller = new TransitionController(diag);
  const buffer = new ReasoningBuffer(diag, 1_000_000);
  const mock = makeRealisticTwoPhaseMock();
  const proxy = new StreamProxy(
    makeModel(),
    {} as never,
    { reasoning: "high" } as never, // original request has reasoning enabled
    mock.fn,
    diag,
    controller,
    buffer,
    DEFAULT_CONFIG.transitionTimeoutMs, // abort timeout — generous
    undefined,                           // requestBuilder — default
    2000,                                // replacementStartupTimeoutMs — generous
  );
  return { proxy, diag, events, controller, buffer, mock };
}

const PRIMARY_REASONING = ["Let", " me", " think"]; // 3 deltas → "Let me think"
const REPLACEMENT_ANSWER = "Here is the answer.";

describe("Consumer integration — Issue 1 end-to-end (P1.M2.T3.S1)", () => {
  test("interrupted reasoning PERSISTS as [thinking, text] through the real consumer (regression guard)", async () => {
    const { proxy, events, mock } = buildRealisticProxy();

    // (b) PRIMARY reasoning stream: start → thinking_start[0] → 3× thinking_delta[0] → thinking_end[0].
    //     (Mock derives contentIndex=0 + stamps the live accumulating partial — exactly like the provider.)
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    for (const d of PRIMARY_REASONING) mock.pushPrimary({ type: "thinking_delta", delta: d });
    mock.pushPrimary({ type: "thinking_end" });

    // (c) wait until the proxy has entered Reasoning (run() processed the thinking events → offset will be 1).
    await waitFor(() => proxy.isReasoning());

    // (d) trigger the stop mid-reasoning → abort → freeze → snapshot → launch replacement.
    expect(proxy.triggerStop()).toBe(true);
    await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot done

    // (3) the replacement call was invoked with reasoning === undefined (mock records every call).
    //     calls[0] = primary (reasoning: "high"); calls[1] = replacement (reasoning forced undefined).
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].options?.reasoning).toBeUndefined(); // PRD §25.6 — thinking disabled

    // (e) REPLACEMENT (reasoning OFF): start (proxy-SUPPRESSED, INV-002) → text_start → text_delta → done.
    mock.pushReplacement({ type: "start" });
    mock.pushReplacement({ type: "text_start" });
    mock.pushReplacement({ type: "text_delta", delta: REPLACEMENT_ANSWER });
    mock.pushReplacement({ type: "done" });

    // (f) consume proxy.output through the FAITHFUL agent-loop consumer.
    const result = await consumeLikeAgentLoop(proxy.output);

    // (g) PERSISTENCE (the persisted message = response.result() = the rewritten done.message):
    //     [thinking, text] with the FULL primary reasoning preserved (was [text] only, pre-fix).
    expect(result.finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(result.finalMessage.content).toHaveLength(2);
    expect(result.finalMessage.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Let me think", // ← FULL primary reasoning preserved (lost pre-fix)
    });
    expect(result.finalMessage.content[1]).toMatchObject({
      type: "text",
      text: REPLACEMENT_ANSWER,
    });

    // (h) NO FLICKER / RESTART ARTIFACT (G4). The streaming partial view (partialMessage = event.partial)
    //     must NEVER lead with a text block — pre-fix the replacement's fresh [text] partial replaced the
    //     reasoning on every event (content[0] === 'text'). Two-part assertion (robust to the empty
    //     content:[] of the primary `start` partial):
    //       (1) NO partial ever leads with text;
    //       (2) every post-splice partial (one carrying a text block) leads with the frozen reasoning.
    for (const partial of result.partialHistory) {
      expect(partial.content[0]?.type).not.toBe("text");
    }
    const postSplice = result.partialHistory.filter((p) =>
      p.content.some((b) => b.type === "text"),
    );
    expect(postSplice.length).toBeGreaterThan(0); // the rewritten text_start/text_delta partials
    for (const partial of postSplice) {
      expect(partial.content[0]?.type).toBe("thinking");
    }
  });

  test("NEGATIVE CONTROL: an uninterrupted stream through the same mock yields the SAME [thinking, text] structure (observational equivalence — Story 3 / G4)", async () => {
    const { proxy, mock } = buildRealisticProxy();

    // A NORMAL z.ai reasoning→answer response (NO stop): start → thinking_* → text_* → done, all in PRIMARY.
    mock.pushPrimary({ type: "start" });
    mock.pushPrimary({ type: "thinking_start" });
    for (const d of PRIMARY_REASONING) mock.pushPrimary({ type: "thinking_delta", delta: d });
    mock.pushPrimary({ type: "thinking_end" });
    mock.pushPrimary({ type: "text_start" });
    mock.pushPrimary({ type: "text_delta", delta: REPLACEMENT_ANSWER });
    mock.pushPrimary({ type: "text_end" });
    mock.pushPrimary({ type: "done" });

    // Consume through the SAME faithful consumer.
    const result = await consumeLikeAgentLoop(proxy.output);

    // The uninterrupted response has the SAME [thinking, text] structure as the interrupted one
    // (Story 3 "appear identical to a normal assistant response"; G4 "single continuous assistant response").
    expect(result.finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(result.finalMessage.content).toHaveLength(2);
    expect(result.finalMessage.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Let me think",
    });
    expect(result.finalMessage.content[1]).toMatchObject({
      type: "text",
      text: REPLACEMENT_ANSWER,
    });
  });
});
```

### Integration Points

```yaml
NO SOURCE CHANGES:
  - This is a TEST-ONLY deliverable. src/provider/proxy.ts (and every other src/ file) is imported, NOT
    edited. tests/helpers/* are imported, NOT edited. No existing *.test.ts is edited.

NEW FILE ONLY:
  - tests/consumer-integration.test.ts (2 tests). tsconfig excludes tests/ from `tsc`, so `npx bun run
    build` is unaffected; the new test is discovered + run by `npx bun test`.

DEPENDS ON (all DONE — verify present before authoring):
  - consumeLikeAgentLoop        → tests/helpers/consumer-harness.ts
  - makeRealisticTwoPhaseMock   → tests/helpers/realistic-mock.ts
  - makeCaptureDiag/makeModel/waitFor → tests/helpers/invariant-harness.ts
  - StreamProxy (fixed)         → src/provider/proxy.ts
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# NOTE: tsconfig excludes tests/ → `npx bun run typecheck` checks src ONLY and will NOT catch test errors.
# Validate the test by RUNNING it (Bun type-checks TS natively as it executes):
npx bun test tests/consumer-integration.test.ts
# Expected: 2/2 pass. Common failures:
#   - "mock.calls[1] is undefined" → you pushed replacement events before waitFor(abort.completed), OR
#     triggerStop returned false (proxy not in Reasoning — did you waitFor(isReasoning) first?).
#   - "expected [ 'text' ] to equal [ 'thinking', 'text' ]" → the offset was 0 (no thinking event before
#     triggerStop → rewrite no-op). Ensure thinking_start+delta are pushed BEFORE triggerStop.
#   - "waitFor timed out" → the abort path didn't complete; confirm triggerStop()===true and the
#     `proxy.abort.completed` trace fires (check the proxy is wired to mock.fn, not a stale mock).
#   - type errors on MockEventSpec (e.g. passing contentIndex) → the spec union has NO contentIndex/partial;
#     remove them (the mock derives them).
```
> `bun` is a local devDep NOT on PATH — invoke via `npx bun ...`. Bun test API:
> https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.

### Level 2: Unit/Integration Tests (Component Validation)

```bash
# The new suite alone:
npx bun test tests/consumer-integration.test.ts
# Expected: 2 pass — POSITIVE (persistence + no-flicker + reasoning===undefined) and NEGATIVE control.

# Full suite (no regressions):
npx bun test
# Expected: 391 pass / 0 fail (389 existing baseline + 2 new). If a count other than 391 appears, a test
# was accidentally skipped or an existing test regressed — investigate.
```

### Level 3: Integration (Package Integrity)

```bash
# Confirm src still builds cleanly (the new test must not have touched any source):
npx bun run build   # = tsc  → exit 0; no new/changed dist artifacts beyond a normal rebuild.
npx bun run typecheck  # = tsc --noEmit  → 0 diagnostics.

# Confirm only ONE new test file was added (scope boundary):
git add -A && git status --short
# Expected: ONLY `?? tests/consumer-integration.test.ts` (and possibly regenerated dist/* if not git-ignored).
#   NO changes under src/, tests/helpers/, or any existing tests/*.test.ts.
```

### Level 4: Creative & Domain-Specific Validation (Regression-Guard + Scope)

```bash
# SCOPE gate — exactly one new test file, zero source/helper edits:
git diff --name-only HEAD -- src/ tests/helpers/   # Expected: EMPTY (nothing changed)
ls tests/consumer-integration.test.ts              # Expected: the file exists

# REGRESSION-Guard gate — the POSITIVE test exercises BOTH halves of the fix (contentIndex offset > 0 AND
# the terminal message merge), so it would fail pre-fix. Confirm the test references the fix's observable
# outcomes (NOT internal fields):
grep -n "thinking.*text\|content\[0\]\|content\[1\]\|reasoning).toBeUndefined\|partialHistory" tests/consumer-integration.test.ts
# Expected: hits for the [thinking,text] assertion, content[0]/content[1] structure, the
# calls[1].reasoning===undefined assertion, and the partialHistory no-flicker loop.

# Consumer-fidelity gate — the test MUST consume via the harness (not a hand-rolled loop):
grep -n "consumeLikeAgentLoop" tests/consumer-integration.test.ts   # Expected: ≥2 (both tests call it)

# Negative-control gate — Test 2 must NOT call triggerStop (it is the uninterrupted baseline):
grep -n "triggerStop" tests/consumer-integration.test.ts            # Expected: exactly 1 (Test 1 only)
```

---

## Final Validation Checklist

### Technical Validation

- [ ] `npx bun test tests/consumer-integration.test.ts` → 2/2 pass.
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun run build` → exit 0 (no source touched).
- [ ] `npx bun test` → 391 pass / 0 fail (389 baseline + 2 new).

### Feature Validation

- [ ] POSITIVE: `finalMessage.content` types `["thinking","text"]`, length 2, full reasoning + answer preserved.
- [ ] POSITIVE: `partialHistory` no-flicker (no text-block-first partial; text-bearing partials lead with thinking).
- [ ] POSITIVE: `mock.calls.length === 2` and `mock.calls[1].options.reasoning === undefined`.
- [ ] POSITIVE: `proxy.triggerStop() === true` (stopped during Reasoning).
- [ ] NEGATIVE: uninterrupted stream yields the same `[thinking, text]` structure (observational equivalence).
- [ ] The POSITIVE test is a genuine regression guard (fails pre-fix — see "Known Gotchas").

### Code Quality Validation

- [ ] Reuses `consumeLikeAgentLoop` + `makeRealisticTwoPhaseMock` + `invariant-harness` doubles (no re-implementation).
- [ ] Constructor-call shape mirrors the passing `stream-proxy-terminal-rewrite.test.ts`.
- [ ] Test names + module JSDoc cite PRD Story 3 / G4 / ADR-005 and the Issue-1 fix subtasks.
- [ ] No edits to `src/`, `tests/helpers/`, or any existing `tests/*.test.ts`.

### Documentation & Deployment

- [ ] Test-only deliverable — no user-facing/config/API surface (item DOCS spec: "none").
- [ ] No README / package.json / tsconfig changes.

---

## Anti-Patterns to Avoid

- ❌ Don't re-implement the consumer logic — call `consumeLikeAgentLoop` (the whole point is to run the
  faithful agent-loop assembly, not a hand-rolled `for await ... push`).
- ❌ Don't pass `contentIndex`/`partial` in the realistic mock's `MockEventSpec` — the mock derives them;
  passing them is pointless and signals a misunderstanding of the mock.
- ❌ Don't push replacement events before `waitFor(() => events.some(c => c.event === "proxy.abort.completed"))`
  — the freeze/snapshot (and the replacement launch) are async; racing them makes the offset 0 or the
  `calls[1]` assertion flaky.
- ❌ Don't triggerStop before any thinking event — `_contentIndexOffset` would be 0 and the rewrite becomes
  a no-op, so the assertions pass trivially and the test does NOT guard the bug.
- ❌ Don't assert `partialHistory[i].content[0].type === "thinking"` unconditionally on every partial — the
  primary `start` partial has `content: []`. Use the two-part no-flicker assertion (no text-first partial;
  text-bearing partials lead with thinking).
- ❌ Don't edit any source file, helper, or existing test — this is test-only. If a source change seems
  necessary, STOP: the fix (P1.M2.T2.S1/S2) is already landed; the test must pass against it as-is.
- ❌ Don't add Issue 2 / Issue 3 coverage here — those are P1.M3 / P1.M4 (out of scope).

---

## Confidence Score

**9.5/10** — one-pass success likelihood. The deliverable is a single test file that wires together four
already-built, already-tested collaborators whose exact surfaces (constructor signature, harness return
shape, mock push API + `calls[]` recording, the `proxy.abort.completed` trace) are all verified in this
PRP. The reference test is derived directly from the **passing** `stream-proxy-terminal-rewrite.test.ts`
(extended with the three missing assertions the contract requires), and every non-obvious gotcha (offset
must be >0, push-after-freeze ordering, empty-content start partial, replacement-start suppression,
no-concurrent-consumer-needed) is called out explicitly. The only residual risk is event-loop timing in
the positive test, which the harness's 5s `result()` timeout + the `waitFor` guards fully absorb.
