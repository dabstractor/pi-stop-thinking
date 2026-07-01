# PRP — P1.M1.T1.S1.S2: Create realistic two-call mock provider with accumulating partial objects and contentIndex

> **Bugfix**: Stream Integrity & Shortcut Lifecycle. This subtask builds the **second** piece of test
> infrastructure (after P1.M1.T1.S1's `consumeLikeAgentLoop`) that exposes **Issue 1** (reasoning lost
> from the persisted assistant message on every interruption). **No production code touched** — a pure
> test helper + companion test in `tests/helpers/`.
>
> **Why this matters**: the existing 380-test suite mocks the upstream with placeholder events
> (`ev({type:'text_start', contentIndex:0})`) that carry **no real `partial` object and no accumulation**.
> That is the exact blind spot the PRD names (§Testing Summary "Areas needing more attention": *"Mocks
> should carry realistic `partial` objects and be consumed by a faithful assembler"*). This mock is the
> faithful mini-provider that reproduces the real `openai-completions` accumulation — the carrier of the
> contentIndex collision (primary `thinking` at index 0 vs replacement `text` at index 0) that causes
> Issue 1.

---

## Goal

**Feature Goal**: Create a **faithful two-call mock provider** that reproduces the real
`@earendil-works/pi-ai` `openai-completions` provider's **per-call output accumulation** behavior — one
live `output` object per call (`output.content` mutated in place, `contentIndex` derived via
`indexOf`, every event stamped `partial: output`, terminal `done` carrying `message: output`). The mock
drives a primary call (reasoning ON → `thinking` block at `content[0]`) and a replacement call (reasoning
OFF → fresh `output`, `text` block at `content[0]`) — both at `contentIndex: 0`, i.e. the exact collision
the consumer observes. Exposes the two live `output` references for assertions.

**Deliverable**:
- `tests/helpers/realistic-mock.ts` — exports
  `function makeRealisticTwoPhaseMock(opts?): RealisticTwoPhaseMock` returning
  `{ fn, calls, pushPrimary, pushReplacement, closePrimary, primaryOutput, replacementOutput }`.
- `tests/helpers/realistic-mock.test.ts` — companion unit test that scripts a primary
  `start → thinking_*[0] → …` stream (with a real accumulating partial) and a replacement
  `start → text_*[0] → done` stream (fresh text-only partial), and asserts the accumulation mechanics
  (live `partial` refs, `contentIndex === 0` for both phases, `done.message === replacementOutput`,
  replacement `calls` recorded with `reasoning === undefined`).

**Success Definition**:
- `bun test tests/helpers/realistic-mock.test.ts` passes (the mock faithfully accumulates real
  `output` objects: every non-terminal event carries a live `partial` whose `.content` grows in place;
  `done.message` is the live `replacementOutput`; both phases use `contentIndex: 0`).
- `bun test` full suite still green (pure addition — no existing mock/helper is modified).
- `bun run build` unaffected (tests excluded from the build).
- A quick proof that the mock reproduces the collision: hand-wire it so the replacement's text lands at
  `contentIndex: 0` while the primary's thinking also landed at `contentIndex: 0` (different live
  `output` objects) — the precondition for Issue 1.
- Ready to be consumed by P1.M2.T1.S1 (capture test) and P1.M2.T3.S1 (Issue 1 integration test).

---

## Why

- **Issue 1 is invisible without realistic partials**: The PRD's Steps to Reproduce (§h3.0) and the
  architecture doc (`pi-agent-core-consumer.md` §1) show the bug is only observable when replacement
  events carry a **fresh `partial` that contains only the text** — so the consumer's
  `partialMessage = event.partial` replaces the primary's reasoning. The existing placeholder mocks put
  no `partial` on their events at all, so the consumer (and Issue 1) is never exercised.
- **Faithfulness is mandatory**: This mock is the **oracle** the Issue 1 fix tests against. It must
  accumulate exactly like the provider (`output.content` mutated in place; `contentIndex =
  output.content.indexOf(block)`; `partial: output` live ref; `done.message: output`) or it will not
  reproduce — and therefore cannot guard against — the regression.
- **Reusable**: Consumed by P1.M2.T1.S1 (capture primary frozen content blocks) and P1.M2.T3.S1
  (end-to-end consumer-harness integration test asserting `[thinking, text]` preservation).

## What

A factory `makeRealisticTwoPhaseMock(opts?)` returning an object with:
1. `fn` — an `ApiStreamSimpleFunction` stand-in: the 1st call returns a primary async iterator (records
   the primary `signal`; **throws `new Error("aborted")` on signal abort**, exactly like the existing
   `makeScriptedTwoPhaseUpstream`); the 2nd call returns a replacement async iterator (records its
   `options` incl. `reasoning`; fresh `output`).
2. `pushPrimary` / `pushReplacement` — accept a minimal event spec; the mock **owns** the live `output`
   accumulation (mutates `output.content` in place per the provider's `ensure*Block` + delta-append
   mechanics) and is the **sole source of truth** for `contentIndex` (derived via `indexOf`) and
   `partial` (the live `output` ref). The caller passes neither.
3. `closePrimary` — ends the primary iterator cleanly (no-abort path).
4. `primaryOutput` / `replacementOutput` — the two live `AssistantMessage` objects, exposed for assertions.
5. `calls` — recorded per-call options (the replacement's `reasoning` must be `undefined`, asserted by the
   integration test to prove the proxy disabled thinking).

**Deliberately out of scope**: driving the real `StreamProxy` (P1.M2.T3.S1), the proxy rewrite/fix
(P1.M2.T2), and the consumer harness itself (P1.M1.T1.S1, already done). This mock only simulates the
**upstream provider**.

### Success Criteria

- [ ] `tests/helpers/realistic-mock.ts` exports `makeRealisticTwoPhaseMock` + `RealisticTwoPhaseMock`.
- [ ] The mock builds ONE accumulating `output` per call, with `output.content` mutated IN PLACE (a live
      reference); every non-terminal event carries `partial: <that live output>`; `done` carries
      `message: <that live output>`.
- [ ] `contentIndex` is derived from `output.content.indexOf(block)`; primary `thinking` → index 0;
      replacement `text` → index 0 (the collision), each in its OWN `output` object.
- [ ] The 1st `fn` call records the primary `signal` and **throws `new Error("aborted")`** on abort
      (mirrors `makeScriptedTwoPhaseUpstream`); the 2nd call records `options.reasoning === undefined`.
- [ ] `primaryOutput` / `replacementOutput` are distinct live objects; `replacementOutput.content` never
      contains the primary's thinking.
- [ ] `bun test tests/helpers/realistic-mock.test.ts` passes; `bun test` full suite green;
      `bun run build` unaffected; no `src/` files modified.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact provider accumulation mechanics are inlined below (verbatim from the provider
source), the existing mock's iterator control-flow is reproduced, the pi-ai type signatures are verified
against local `node_modules`, and the validation commands are project-verified. No proxy/FSM knowledge is
required (this subtask touches none of it).

### Documentation & References

```yaml
# MUST READ — the authoritative provider mechanics this mock reproduces line-for-line
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-ai-event-types.md
  why: "§1 AssistantMessageEvent field table (which events carry partial vs message); §2 AssistantMessage
        + ContentBlock shapes; §3 EventStream.push/result() semantics."
  critical: "partial is the provider's LIVE mutating output reference (SAME object across all events of
             one stream). done.message === that same output reference. The mock MUST mutate output.content
             in place and stamp the SAME object as partial on every event."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-agent-core-consumer.md
  why: "§3 reproduces the openai-completions provider's accumulation: ONE output per call,
        blocks = output.content, getContentIndex = blocks.indexOf(block), ensureThinkingBlock /
        ensureTextBlock, partial: output on every event, terminal done.message = output. §1-2 show WHY
        the mock must reproduce this (the collision + partial-switching the consumer observes)."
  critical: "With reasoning ON the thinking block is at content[0]; with reasoning OFF the text block is
             at content[0]. Both use contentIndex 0 — the collision. The replacement's output is FRESH and
             does NOT include the primary's thinking."

# PATTERN files to follow (existing test conventions) — the mock EXTENDS makeScriptedTwoPhaseUpstream
- file: tests/helpers/invariant-harness.ts
  why: "makeScriptedTwoPhaseUpstream() is the exact structure to extend: returns { fn, calls, pushPrimary,
        pushReplacement, closePrimary }; fn is (_m,_c,streamOpts?) => async-iterable cast
        as unknown as ApiStreamSimpleFunction; call 1 records primarySignal and THROWS new Error('aborted')
        on abort (drain-queue → check-aborted → await-0ms-with-abort-listener); call 2 pushes to calls and
        records replacementSignal. ITS ONLY GAP: events come from ev({type:'text_start',contentIndex:0})
        with NO real partial. THIS mock keeps that iterator control-flow but builds a REAL accumulating
        output per call."
  pattern: "Two-phase factory; per-call async generator that drains a queue then blocks (await 0ms) with an
            abort listener that rejects with new Error('aborted'); closePrimary() sets a stop flag so the
            generator returns cleanly; fn cast as unknown as ApiStreamSimpleFunction."
  gotcha: "Do NOT add error-injection to the new mock (the Issue 1 scenario does not need it; keep the
           surface minimal). The PRIMARY iterator must throw on abort (NOT push an error event) — that is
           what makes the proxy take its abort→freeze→replacement path (proxy.ts run() catch, state
           'Aborting'). The real provider catches+pushes an error terminal, but the proxy's abort path is
           gated on the upstream THROWING — so the mock throws, exactly like the existing mock."

- file: tests/helpers/consumer-harness.ts
  why: "The consumer this mock must be consumable by: partialMessage = event.partial on every non-terminal;
        finalMessage = await stream.result(). Confirms the mock's partial refs must be LIVE (the harness
        shallow-copies { ...event.partial })."
  pattern: "Already implemented (P1.M1.T1.S1). Do NOT modify it. The companion test here can optionally
            pipe the mock's hand-built stream through consumeLikeAgentLoop to prove faithfulness end-to-end."

- file: node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js
  why: "The authoritative source for the accumulation mechanics (see Implementation Patterns). Lines of
        interest: the `output = {...}` literal; `const blocks = output.content`;
        `const getContentIndex = (block) => blocks.indexOf(block)`; ensureThinkingBlock/ensureTextBlock
        (push block, emit *_start with contentIndex + partial:output); delta handling
        (block.text/thinking += delta; emit *_delta); finishBlock (emit *_end); terminal
        `stream.push({type:'done', reason: output.stopReason, message: output})`."
  critical: "blocks IS output.content (same array, mutated in place via blocks.push). contentIndex is
             derived, never invented."

# VERIFIED type signatures (local node_modules, not global)
- note: "node_modules/@earendil-works/pi-ai/dist/api-registry.d.ts:
          export type ApiStreamSimpleFunction =
            (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;"
- note: "node_modules/@earendil-works/pi-ai/dist/types.d.ts:
          SimpleStreamOptions extends StreamOptions { reasoning?: ThinkingLevel; thinkingBudgets?... }
          StreamOptions { ... signal?: AbortSignal; ... }  (line 31)
          ThinkingLevel = 'minimal'|'low'|'medium'|'high'|'xhigh'  (line 12)
          Usage { input; output; cacheRead; cacheWrite; totalTokens; cost:{input;output;cacheRead;cacheWrite;total} }
          StopReason = 'stop'|'length'|'toolUse'|'error'|'aborted'
          AssistantMessageEvent: start{partial}; text_start/thinking_start{contentIndex,partial};
            text_delta/thinking_delta{contentIndex,delta,partial}; text_end/thinking_end{contentIndex,content,partial};
            done{reason,message}; error{reason,error}. (All NON-terminal carry `partial`; done/error do NOT.)
          AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, ApiStreamSimpleFunction are
          ALL re-exported from the @earendil-works/pi-ai ROOT package (confirmed: src/provider/proxy.ts and
          tests/helpers/invariant-harness.ts import these from the root)."
```

### Current Codebase tree (relevant slice)

```bash
tests/
├── helpers/
│   ├── invariant-harness.ts       # ← PATTERN: makeScriptedTwoPhaseUpstream (extend its structure)
│   ├── consumer-harness.ts        # ← P1.M1.T1.S1 consumer (consumeLikeAgentLoop) — read-only ref
│   ├── consumer-harness.test.ts   # ← P1.M1.T1.S1 companion test — cast idiom for synthetic events
│   └── (realistic-mock.ts)        # ← NEW (this subtask)
│   └── (realistic-mock.test.ts)   # ← NEW (companion unit test)
└── *.test.ts                      # 380+1 existing tests
src/                               # UNCHANGED — do not modify
```

### Desired Codebase tree with file responsibilities

```bash
tests/helpers/
├── realistic-mock.ts              # NEW — exports makeRealisticTwoPhaseMock + RealisticTwoPhaseMock.
│                                    # Pure helper (no test() calls). Faithful mini-provider: one live
│                                    # output per call, in-place content mutation, derived contentIndex,
│                                    # partial: output on every event, done.message: output. Primary
│                                    # throws on abort (mirrors makeScriptedTwoPhaseUpstream).
└── realistic-mock.test.ts         # NEW — companion bun:test. Scripts primary thinking_*[0] + replacement
                                   # text_*[0]/done, asserts live accumulation, contentIndex 0 collision,
                                   # done.message === replacementOutput, calls[1].reasoning === undefined.
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (faithfulness — live reference): `output.content` MUST be mutated IN PLACE. The provider does
// `const blocks = output.content; blocks.push(block)` — it NEVER reassigns output.content. The mock must
// do the same (pushPrimary/pushReplacement mutate the existing array), so `partial: output` stays a live
// reference and the consumer's `{ ...event.partial }` shallow-copy shares the same growing `.content`.
// Reassigning `output.content = [...]` would break the "live ref" contract and mask Issue 1.

// CRITICAL (contentIndex is DERIVED, not invented): mirror the provider's
// `getContentIndex = (block) => output.content.indexOf(block)`. For the primary, the thinking block is
// content[0] → index 0. For the replacement, the text block is content[0] → index 0. BOTH index 0 in
// their OWN outputs = the collision. Do NOT let the caller pass contentIndex; the mock derives it.

// CRITICAL (primary must THROW on abort, not push an error event): the proxy's run() abort path is gated
// on the upstream THROWING while state==='Aborting' (proxy.ts run() catch). The existing
// makeScriptedTwoPhaseUpstream throws `new Error("aborted")` from the primary iterator on
// primarySignal.aborted. The new mock MUST do the same — do NOT replicate the real provider's catch+push-
// error-event (that would make the proxy take "natural completion won" instead of abort→freeze→replace).
// The replacement iterator is NOT aborted in the Issue 1 scenario (it completes via done).

// GOTCHA (partial is omitted on done/error): done carries `message`, error carries `error`. Neither has a
// `partial` field. applySpec must stamp `message: output` (done) / `error: output` (error), not `partial`.

// GOTCHA (bun test discovery): `bun test` only runs *.test.{ts,...}. realistic-mock.ts (no .test) is NOT
// run. So the unit test MUST be a companion *.test.ts. Do NOT put test() inside realistic-mock.ts.

// GOTCHA (tsconfig excludes tests): the project build (`tsc`) EXCLUDES tests/ — so type errors in the mock
// won't fail `bun run build`, only `bun test` (which strips types). For real type-assurance use the
// self-contained one-off `bunx tsc --noEmit …` in Validation Level 1.

// GOTCHA (replacement output is FRESH): replacementOutput must be a DISTINCT object whose content NEVER
// includes the primary's thinking block. The whole point: when the proxy forwards replacement events
// verbatim, `event.partial` (replacementOutput, text-only) replaces the primary's reasoning in the
// consumer's partialMessage — Issue 1. Create both outputs at factory time as stable exposed refs.

// GOTCHA (fn is invoked with (model, context, options)): the proxy calls
// `upstreamStreamFn(model, context, { ...options, signal })` (primary) and
// `originalStreamFn(triple.model, triple.context, { ...triple.options, signal })` (replacement, with
// triple.options.reasoning === undefined). The mock's fn must read streamOpts.signal (primary abort) and
// record streamOpts (esp. reasoning) into `calls`. It distinguishes primary vs replacement by CALL COUNT,
// not by the reasoning value (the test decides thinking vs text by calling pushPrimary vs pushReplacement).

// SCOPE: do NOT add error-injection, do NOT drive the real StreamProxy, do NOT modify the proxy, and do
// NOT modify consumeLikeAgentLoop. This is the upstream mock only.
```

---

## Implementation Blueprint

### Data models and structure

The mock owns two live `AssistantMessage` accumulation objects (factory-created, stable exposed refs) and
two small per-output "current block" trackers (mirroring the provider's `let thinkingBlock = null` /
`let textBlock = null`):

```typescript
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai";

export interface RealisticTwoPhaseMock {
  /** The mock provider fn — drop-in for an ApiStreamSimpleFunction (cast). */
  fn: ApiStreamSimpleFunction;
  /** Per-call recorded options (calls[1] = replacement; assert .options.reasoning === undefined). */
  calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[];
  /** Push a primary event spec (mock owns contentIndex + partial). */
  pushPrimary: (spec: MockEventSpec) => void;
  /** Push a replacement event spec (mock owns contentIndex + partial). */
  pushReplacement: (spec: MockEventSpec) => void;
  /** End the primary iterator cleanly (no-abort path). */
  closePrimary: () => void;
  /** The live primary accumulating output (driven by pushPrimary). */
  primaryOutput: AssistantMessage;
  /** The live replacement accumulating output — FRESH (never includes primary thinking). */
  replacementOutput: AssistantMessage;
}

/** Minimal event spec the caller pushes; the mock derives contentIndex + partial from the live output. */
export type MockEventSpec =
  | { type: "start" }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "text_start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end" }
  | { type: "done" }
  | { type: "error"; reason?: AssistantMessageEvent extends { reason: infer R } ? R : string };
```

> The `MockEventSpec` is intentionally a **caller-friendly subset** (no `contentIndex`, no `partial`): the
> mock is the single source of truth for those, mirroring the provider. `error.reason` can be typed simply
> as `StopReason` (import it) or kept as a loose string cast — the Issue 1 scenario only uses `done`.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE tests/helpers/realistic-mock.ts  (pure helper — NO *.test.ts suffix)
  - IMPLEMENT: `export function makeRealisticTwoPhaseMock(opts?): RealisticTwoPhaseMock` matching the
      provider's accumulation EXACTLY (see Implementation Patterns below).
  - FOLLOW pattern: tests/helpers/invariant-harness.ts makeScriptedTwoPhaseUpstream (factory shape, fn
      cast idiom, primary-throw-on-abort iterator control-flow, calls recording, closePrimary). EXTEND it
      with: real accumulating output objects, contentIndex derivation, partial/message stamping.
  - IMPORTS: `import type { AssistantMessage, AssistantMessageEvent, ApiStreamSimpleFunction }
      from "@earendil-works/pi-ai";` (type-only).
  - STRUCTURE:
      1. Create primaryOutput + replacementOutput at factory time (live refs, content:[]). Use the
         provider's exact shape (role, content[], api, provider, model, usage{...full...}, stopReason:"stop",
         timestamp: Date.now()).
      2. Per-output trackers: `let primaryThinking: ... | null = null`, `primaryText`, `replacementThinking`,
         `replacementText` (mirror provider's let thinkingBlock/textBlock = null).
      3. primaryQueue: AssistantMessageEvent[]; replacementQueue: AssistantMessageEvent[].
      4. A shared `applySpec(output, spec, blockRefs)` that mutates output.content IN PLACE and returns a
         fully-formed AssistantMessageEvent (see Implementation Patterns). It is the ONLY place contentIndex
         is derived (`output.content.indexOf(block)`) and `partial`/`message` is stamped.
      5. pushPrimary = (spec) => primaryQueue.push(applySpec(primaryOutput, spec, primaryBlockRefs));
         pushReplacement = (spec) => replacementQueue.push(applySpec(replacementOutput, spec, replBlockRefs));
      6. fn(model, context, streamOpts): callCount++.
           - call 1 (primary): record primarySignal = streamOpts?.signal; push {options: streamOpts} to calls
             (so calls[0] = primary). Return an async generator that drains primaryQueue, then on empty:
             if primaryClosed → return; if primarySignal?.aborted → throw new Error("aborted"); else await a
             0ms timer with an abort listener that rejects with new Error("aborted") (EXACT mirror of
             makeScriptedTwoPhaseUpstream).
           - call 2 (replacement): record replacementSignal = streamOpts?.signal; push {options: streamOpts}
             to calls (calls[1] = replacement; its .options.reasoning === undefined). Return an async
             generator that drains replacementQueue with the same await-0ms/abort pattern (no closePrimary
             needed — the test drives a `done`).
  - NAMING: makeRealisticTwoPhaseMock (export), RealisticTwoPhaseMock (interface), MockEventSpec (type),
      applySpec (internal helper).
  - CRITICAL: mutate output.content IN PLACE (push to the existing array, never reassign); derive
      contentIndex via indexOf; stamp partial on non-terminals and message on `done`; PRIMARY iterator
      throws new Error("aborted") on abort (do NOT push an error event). No error-injection.
  - PLACEMENT: tests/helpers/realistic-mock.ts.

Task 2: CREATE tests/helpers/realistic-mock.test.ts  (companion unit test — bun discovers this)
  - IMPLEMENT: a bun:test that scripts a realistic two-phase stream WITHOUT the proxy (directly invoking
      the mock fn) and asserts the faithful accumulation.
  - FOLLOW pattern:
      - tests/helpers/consumer-harness.test.ts (the `as unknown as AssistantMessage` / event cast idiom;
        `import { test, expect } from "bun:test"`).
      - tests/helpers/invariant-harness.ts (how a TwoPhaseMock is consumed: call fn once for primary,
        iterate, push events, then call fn again for replacement, iterate).
  - IMPORTS: `import { test, expect } from "bun:test";`
      `import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";`
      `import { makeRealisticTwoPhaseMock } from "./realistic-mock";`
      (optional) `import { consumeLikeAgentLoop } from "./consumer-harness";` to prove end-to-end assembly.
  - SCENARIO + ASSERTIONS (proves faithful accumulation + the collision):
      a. const mock = makeRealisticTwoPhaseMock();
      b. Drive the PRIMARY (call 1): const upstream1 = mock.fn(modelStub, ctxStub, { signal: primaryAc.signal,
         reasoning: "high" }); push events via mock.pushPrimary: start; thinking_start; thinking_delta("Let");
         thinking_delta(" me"); thinking_end. (Do NOT abort here; iterate to drain, or closePrimary.)
      c. ASSERT accumulation: every yielded primary event has `partial === mock.primaryOutput` (the SAME
         live object); primaryOutput.content.length === 1; content[0].type === "thinking"; content[0].thinking
         === "Let me"; each thinking_* event has contentIndex === 0.
      d. Drive the REPLACEMENT (call 2): const upstream2 = mock.fn(modelStub, ctxStub,
         { signal: replacementAc.signal }); mock.calls[1].options.reasoning === undefined (recorded). push
         events via mock.pushReplacement: start; text_start; text_delta("Here"); text_delta(" is the answer.");
         done. Iterate to drain.
      e. ASSERT: replacementOutput is a DISTINCT object (expect(mock.replacementOutput).not.toBe(
         mock.primaryOutput)); replacementOutput.content.length === 1; content[0].type === "text"; text_*[0]
         events carry contentIndex === 0 (collision) and `partial === mock.replacementOutput`; the `done`
         event carries `message === mock.replacementOutput` (same live ref) and `reason === "stop".
      f. (Proves the consumer would lose reasoning pre-fix, optional but recommended) pipe the
         hand-concatenated [primary-thinking events, replacement events] through consumeLikeAgentLoop and
         assert the finalMessage.content is [{type:"text"}] ONLY — i.e. the bug is reproducible. (Build the
         combined stream with createAssistantMessageEventStream + push each collected event.)
      g. (Negative/abort path) Separately: pushPrimary(start, thinking_start, thinking_delta("x")), abort
         primaryAc, iterate → expect the iterator to THROW ("aborted") (mirrors makeScriptedTwoPhaseUpstream).
  - NAMING: test("makeRealisticTwoPhaseMock accumulates a live output per call and stamps partial/contentIndex
      like the provider", …); test("makeRealisticTwoPhaseMock primary throws on AbortSignal abort", …).
  - COVERAGE: live accumulation, contentIndex-0 collision across the two outputs, done.message ===
      replacementOutput, calls[1].reasoning === undefined, primary-throw-on-abort. (Integration with the
      real proxy is P1.M2.T3.S1.)
  - PLACEMENT: tests/helpers/realistic-mock.test.ts.
```

### Implementation Patterns & Key Details

```typescript
// tests/helpers/realistic-mock.ts — faithful mini-provider (one live output per call).
// Mirrors node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js accumulation.
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai";

export type MockEventSpec =
  | { type: "start" }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "text_start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end" }
  | { type: "done" }
  | { type: "error"; reason?: string };

export interface RealisticTwoPhaseMock {
  fn: ApiStreamSimpleFunction;
  calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[];
  pushPrimary: (spec: MockEventSpec) => void;
  pushReplacement: (spec: MockEventSpec) => void;
  closePrimary: () => void;
  primaryOutput: AssistantMessage;
  replacementOutput: AssistantMessage;
}

/** Provider-shaped AssistantMessage factory (content:[] live array; full Usage). */
const makeOutput = (): AssistantMessage =>
  ({
    role: "assistant",
    content: [], // ← mutated IN PLACE (never reassigned) — this IS the live `blocks` array
    api: "openai-completions",
    provider: "zai",
    model: "glm-4.7",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }) as AssistantMessage;

interface BlockRefs {
  thinking: { type: "thinking"; thinking: string } | null;
  text: { type: "text"; text: string } | null;
}

/**
 * Mutate the LIVE `output.content` in place per the provider's ensure*Block + delta-append mechanics,
 * and return a fully-formed AssistantMessageEvent. This is the ONLY place contentIndex is derived
 * (output.content.indexOf(block)) and partial/message is stamped — mirroring openai-completions.js.
 */
function applySpec(
  output: AssistantMessage,
  spec: MockEventSpec,
  refs: BlockRefs,
): AssistantMessageEvent {
  const blocks = output.content; // same array reference, mutated in place
  const idx = (b: { type: string }) => blocks.indexOf(b as never);

  switch (spec.type) {
    case "start":
      return { type: "start", partial: output };
    case "thinking_start": {
      const block = { type: "thinking", thinking: "" };
      blocks.push(block as never);
      refs.thinking = block;
      return { type: "thinking_start", contentIndex: idx(block), partial: output };
    }
    case "thinking_delta": {
      const block = refs.thinking!;
      block.thinking += spec.delta; // accumulate (live mutation)
      return { type: "thinking_delta", contentIndex: idx(block), delta: spec.delta, partial: output };
    }
    case "thinking_end": {
      const block = refs.thinking!;
      return { type: "thinking_end", contentIndex: idx(block), content: block.thinking, partial: output };
    }
    case "text_start": {
      const block = { type: "text", text: "" };
      blocks.push(block as never);
      refs.text = block;
      return { type: "text_start", contentIndex: idx(block), partial: output };
    }
    case "text_delta": {
      const block = refs.text!;
      block.text += spec.delta; // accumulate (live mutation)
      return { type: "text_delta", contentIndex: idx(block), delta: spec.delta, partial: output };
    }
    case "text_end": {
      const block = refs.text!;
      return { type: "text_end", contentIndex: idx(block), content: block.text, partial: output };
    }
    case "done":
      return { type: "done", reason: output.stopReason, message: output }; // live ref, NOT partial
    case "error":
      output.stopReason = "error";
      return { type: "error", reason: spec.reason ?? "error", error: output }; // live ref, NOT partial
  }
}

export function makeRealisticTwoPhaseMock(_opts?: Record<string, unknown>): RealisticTwoPhaseMock {
  const primaryOutput = makeOutput();      // live; driven by pushPrimary
  const replacementOutput = makeOutput();  // FRESH live; driven by pushReplacement (never has primary thinking)

  const primaryRefs: BlockRefs = { thinking: null, text: null };
  const replacementRefs: BlockRefs = { thinking: null, text: null };

  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];

  const calls: RealisticTwoPhaseMock["calls"] = [];
  let callCount = 0;
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  let primaryClosed = false;

  // iterator control-flow mirrors makeScriptedTwoPhaseUpstream (drain → check-aborted → await-0ms)
  const makeIterator = (queue: AssistantMessageEvent[], signal: AbortSignal | undefined, closed: () => boolean) => ({
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (closed()) return;
        if (signal?.aborted) throw new Error("aborted"); // primary throws on abort → proxy abort path
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 0);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
        });
      }
    },
  });

  const fn = ((_m: unknown, _c: unknown, streamOpts?: { signal?: AbortSignal; reasoning?: unknown }) => {
    callCount++;
    calls.push({ options: streamOpts }); // record per-call options (calls[1].options.reasoning === undefined)
    if (callCount === 1) {
      primarySignal = streamOpts?.signal;
      return makeIterator(primaryQueue, primarySignal, () => primaryClosed);
    }
    // call 2 = REPLACEMENT (fresh output already created at factory time)
    replacementSignal = streamOpts?.signal;
    return makeIterator(replacementQueue, replacementSignal, () => false);
  }) as unknown as ApiStreamSimpleFunction;

  return {
    fn,
    calls,
    pushPrimary: (spec) => primaryQueue.push(applySpec(primaryOutput, spec, primaryRefs)),
    pushReplacement: (spec) => replacementQueue.push(applySpec(replacementOutput, spec, replacementRefs)),
    closePrimary: () => { primaryClosed = true; },
    primaryOutput,
    replacementOutput,
  };
}
```

```typescript
// tests/helpers/realistic-mock.test.ts — companion unit test (sketch; fill assertions from the task list)
import { test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { makeRealisticTwoPhaseMock } from "./realistic-mock";
import { consumeLikeAgentLoop } from "./consumer-harness"; // optional end-to-end proof

const modelStub = { id: "glm-4.7", api: "openai-completions", provider: "zai" } as never;
const ctxStub = { messages: [] } as never;
const drain = async (it: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> => {
  const out: AssistantMessageEvent[] = []; for await (const e of it) out.push(e); return out;
};

test("makeRealisticTwoPhaseMock accumulates a live output per call and stamps partial/contentIndex like the provider", async () => {
  const mock = makeRealisticTwoPhaseMock();
  const primaryAc = new AbortController();

  // PRIMARY (reasoning ON): start → thinking_start → 2× thinking_delta → thinking_end
  const upstream1 = mock.fn(modelStub, ctxStub, { signal: primaryAc.signal, reasoning: "high" });
  mock.pushPrimary({ type: "start" });
  mock.pushPrimary({ type: "thinking_start" });
  mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
  mock.pushPrimary({ type: "thinking_delta", delta: " me" });
  mock.pushPrimary({ type: "thinking_end" });
  mock.closePrimary(); // no-abort path → iterator returns cleanly
  const primaryEvents = await drain(upstream1);

  // live accumulation: every non-terminal partial === the SAME primaryOutput object (live ref)
  for (const e of primaryEvents) if (e.type !== "done" && e.type !== "error") expect(e.partial).toBe(mock.primaryOutput);
  expect(mock.primaryOutput.content).toHaveLength(1);
  expect(mock.primaryOutput.content[0]).toMatchObject({ type: "thinking", thinking: "Let me" });
  // contentIndex derived via indexOf → 0 for the single thinking block
  const thinkings = primaryEvents.filter((e) => e.type.startsWith("thinking"));
  for (const e of thinkings) expect((e as { contentIndex: number }).contentIndex).toBe(0);

  // REPLACEMENT (reasoning OFF): start → text_start → 2× text_delta → done
  const replAc = new AbortController();
  const upstream2 = mock.fn(modelStub, ctxStub, { signal: replAc.signal });
  expect(mock.calls[1].options?.reasoning).toBeUndefined(); // proxy forced reasoning === undefined
  mock.pushReplacement({ type: "start" });
  mock.pushReplacement({ type: "text_start" });
  mock.pushReplacement({ type: "text_delta", delta: "Here" });
  mock.pushReplacement({ type: "text_delta", delta: " is the answer." });
  mock.pushReplacement({ type: "done" });
  const replEvents = await drain(upstream2);

  // FRESH output — distinct object, text-only, NEVER contains the primary's thinking (the collision carrier)
  expect(mock.replacementOutput).not.toBe(mock.primaryOutput);
  expect(mock.replacementOutput.content).toHaveLength(1);
  expect(mock.replacementOutput.content[0]).toMatchObject({ type: "text", text: "Here is the answer." });
  for (const e of replEvents) {
    if (e.type === "done") { expect(e.message).toBe(mock.replacementOutput); expect(e.reason).toBe("stop"); }
    else { expect((e as { contentIndex: number }).contentIndex).toBe(0); expect((e as { partial: unknown }).partial).toBe(mock.replacementOutput); }
  }
});

test("makeRealisticTwoPhaseMock reproduces the contentIndex-0 collision a real consumer observes (Issue 1)", async () => {
  const mock = makeRealisticTwoPhaseMock();
  const ac = new AbortController();
  const u1 = mock.fn(modelStub, ctxStub, { signal: ac.signal, reasoning: "high" });
  mock.pushPrimary({ type: "start" });
  mock.pushPrimary({ type: "thinking_start" });
  mock.pushPrimary({ type: "thinking_delta", delta: "reasoning" });
  mock.pushPrimary({ type: "thinking_end" });
  const primaryEvents = await drain(u1);
  const u2 = mock.fn(modelStub, ctxStub, { signal: new AbortController().signal });
  mock.pushReplacement({ type: "start" });
  mock.pushReplacement({ type: "text_start" });
  mock.pushReplacement({ type: "text_delta", delta: "answer" });
  mock.pushReplacement({ type: "done" });
  const replEvents = await drain(u2);

  // Concatenate the two phases exactly as a verbatim-forwarding proxy would emit, then run the REAL
  // consumer. Pre-fix: the replacement's fresh partial replaces the primary's reasoning → text-only.
  const stream = createAssistantMessageEventStream();
  for (const e of [...primaryEvents, ...replEvents]) (stream as unknown as { push: (e: unknown) => void }).push(e);
  const { finalMessage } = await consumeLikeAgentLoop(stream);
  expect(finalMessage.content.map((b) => b.type)).toEqual(["text"]); // ← Issue 1 reproduced
});

test("makeRealisticTwoPhaseMock primary throws on AbortSignal abort (mirrors the existing mock)", async () => {
  const mock = makeRealisticTwoPhaseMock();
  const ac = new AbortController();
  const u1 = mock.fn(modelStub, ctxStub, { signal: ac.signal, reasoning: "high" });
  mock.pushPrimary({ type: "start" });
  mock.pushPrimary({ type: "thinking_start" });
  mock.pushPrimary({ type: "thinking_delta", delta: "x" });
  await drain((async function* () { for await (const e of u1) yield e; })()); // drain queued events first
  ac.abort();
  await expect(async () => { for await (const _e of u1) { /* drain then abort */ } })
    .rejects.toThrow("aborted");
});
```
> Casts (`as never` for content blocks, `as unknown as ApiStreamSimpleFunction`) match the existing
> invariant-harness/`consumer-harness.test.ts` idiom for synthetic test objects. The `drain-then-abort`
> assertion mirrors how `makeScriptedTwoPhaseUpstream` is exercised in the existing stress/chaos suites.

### Integration Points

```yaml
TEST INFRASTRUCTURE (no production changes):
  - add file: tests/helpers/realistic-mock.ts        # export makeRealisticTwoPhaseMock + RealisticTwoPhaseMock
  - add file: tests/helpers/realistic-mock.test.ts   # companion unit test
  - consumers (later subtasks, do NOT wire now):
      P1.M2.T1.S1: import { makeRealisticTwoPhaseMock } from "../helpers/realistic-mock";
                   build the proxy with mock.fn; push primary events; triggerStop; assert _frozenPrimaryContent
                   captures mock.primaryOutput.content (the thinking block) and _contentIndexOffset === 1.
      P1.M2.T3.S1: build the proxy with mock.fn; drive primary+replacement; consume proxy.output via
                   consumeLikeAgentLoop; assert finalMessage.content === [thinking, text] AFTER the fix.

BUILD/CONFIG: NONE. tsconfig.json already excludes tests/ (mock not compiled into dist). `bun test`
  discovers *.test.ts automatically under tests/. No package.json changes.

PRODUCTION CODE: NONE touched. `git diff --stat src/` must be empty after this subtask.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# Run the new companion test in isolation (primary gate — proves faithful accumulation):
bun test tests/helpers/realistic-mock.test.ts
# Expected: 3 passing. primaryOutput accumulates "Let me" at content[0]; replacementOutput is a distinct
#   text-only object at content[0]; every non-terminal partial === its live output; done.message ===
#   replacementOutput; calls[1].options.reasoning === undefined; primary throws "aborted" on abort.

# Type-assurance of the helper (tsconfig excludes tests, so do a self-contained one-off — S1's pattern):
bunx tsc --noEmit --strict --module ES2022 --moduleResolution bundler --target ES2022 \
  --skipLibCheck --lib ES2022 --types bun \
  tests/helpers/realistic-mock.ts tests/helpers/realistic-mock.test.ts
# Expected: zero diagnostics. (If "Cannot find module @earendil-works/pi-ai" → not at project root, or
#   node_modules missing; run `npm install` first.)

# Sanity: the production build is unaffected (tests excluded from tsconfig):
bun run build && echo "build OK"
# Expected: "build OK"; no new files under dist/.
```

### Level 2: Unit / Component Validation

```bash
# Full test suite — confirms pure additions, no regressions, and that the new tests are discovered:
bun test
# Expected: previous total (381 after P1.M1.T1.S1) + 3 new = 384 passing, 0 failing. No existing test
#   imports changed. (Adjust the expected count if P1.M1.T1.S1 added a different number.)
```

### Level 3: Integration (Faithfulness Contract)

```bash
# Prove the mock reproduces Issue 1 when a verbatim-forwarding path feeds the real consumer (the companion
# test "reproduces the contentIndex-0 collision" IS this contract proof). Additionally, confirm the mock's
# events are directly consumable by the already-shipped consumer harness:
bun test tests/helpers/realistic-mock.test.ts -t "contentIndex-0 collision"
# Expected: passing — finalMessage.content types === ["text"] (reasoning lost), proving the mock is the
#   faithful carrier of the bug.

# Confirm NO production code and NO existing helper was modified:
git diff --stat -- src/ tests/helpers/consumer-harness.ts tests/helpers/invariant-harness.ts | tail -1
# Expected: empty (no output)
git status --short -- tests/helpers/  # Expected: two NEW untracked files (realistic-mock.{ts,test.ts}) only
```

### Level 4: Domain-Specific Validation (Faithfulness Audit)

```bash
# Audit the mock against the authoritative provider (openai-completions.js) + the consumer doc.
# Each provider mechanic must be present; the placeholder-mock gap must be CLOSED:
grep -n "indexOf"        tests/helpers/realistic-mock.ts   # → contentIndex derived from position (not invented)
grep -n "partial: output\|partial:output\|, partial: output" tests/helpers/realistic-mock.ts  # → live ref on every non-terminal
grep -n "message: output\|message:output\|message: this" tests/helpers/realistic-mock.ts   # → done carries the live ref
grep -n "new Error(\"aborted\")" tests/helpers/realistic-mock.ts  # → primary throws on abort (≥2: throw + reject)
grep -n "content = \[\]\|content:\s*\[\]" tests/helpers/realistic-mock.ts  # → live array (never reassigned)
grep -n "reasoning"     tests/helpers/realistic-mock.ts   # → calls record the per-call reasoning option
grep -n "primaryOutput\|replacementOutput" tests/helpers/realistic-mock.ts # → both live outputs exposed
# The companion test MUST consume a real accumulating output (no placeholder ev()):
grep -n "makeRealisticTwoPhaseMock" tests/helpers/realistic-mock.test.ts  # Expected: ≥1 match
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `bun test tests/helpers/realistic-mock.test.ts` passes (3 tests).
- [ ] `bunx tsc --noEmit …` (self-contained, Level 1) → zero diagnostics.
- [ ] `bun test` full suite green (all previous pass + 3 new; 0 fail).
- [ ] `bun run build` unaffected (no new dist files; production untouched).

### Feature Validation
- [ ] `makeRealisticTwoPhaseMock` exported from `tests/helpers/realistic-mock.ts` with the full return
      shape `{ fn, calls, pushPrimary, pushReplacement, closePrimary, primaryOutput, replacementOutput }`.
- [ ] Each call builds ONE live `output`; `output.content` is mutated IN PLACE; every non-terminal event
      carries `partial: <live output>`; `done` carries `message: <live output>`.
- [ ] `contentIndex` is derived (`output.content.indexOf(block)`); primary `thinking` → 0, replacement
      `text` → 0 (the collision, in distinct outputs).
- [ ] The primary iterator **throws `new Error("aborted")`** on its `AbortSignal` abort (mirrors
      `makeScriptedTwoPhaseUpstream`); the replacement completes via `done`.
- [ ] `calls[1].options.reasoning === undefined` (the replacement's recorded options).
- [ ] `primaryOutput` and `replacementOutput` are distinct; `replacementOutput.content` never includes the
      primary's thinking.
- [ ] Companion test reproduces Issue 1 through `consumeLikeAgentLoop` (text-only final message) — the
      regression guard the mock exists to enable.

### Code Quality & Documentation
- [ ] Helper is a non-`*.test.ts` file (not auto-run); unit test is a `*.test.ts` companion (discovered).
- [ ] Header JSDoc explains it reproduces `openai-completions` accumulation and names downstream consumers
      (P1.M2.T1.S1, P1.M2.T3.S1).
- [ ] Follows existing `tests/helpers/invariant-harness.ts` conventions (factory shape, `as unknown as
      ApiStreamSimpleFunction` cast, primary-throw-on-abort iterator control-flow).
- [ ] No `src/` files, no `consumer-harness.ts`, no `invariant-harness.ts` modified
      (`git diff --stat -- src/ tests/helpers/consumer-harness.ts tests/helpers/invariant-harness.ts` empty).

---

## Anti-Patterns to Avoid

- ❌ Don't emit placeholder events (`{type:'text_start', contentIndex:0}` with NO `partial`) — that is the
  exact gap this mock closes. Every non-terminal MUST carry the live `output` as `partial`.
- ❌ Don't **reassign** `output.content` (`output.content = [...]`). Mutate it in place (`content.push`,
  `block.thinking += …`) so `partial` stays a live reference (mirrors the provider's `blocks = output.content`).
- ❌ Don't let the caller supply `contentIndex` or `partial` — the mock derives contentIndex via `indexOf`
  and stamps the live `output` itself. The collision (both phases at index 0) must emerge naturally.
- ❌ Don't make the primary **push an error event** on abort — it must **throw** `new Error("aborted")`, so
  the proxy's `run()` catch takes the abort→freeze→replacement path. (The real provider catches + pushes
  an error terminal, but the proxy's abort logic is gated on the upstream THROWING.)
- ❌ Don't reuse one `output` for both calls — the replacement's `output` must be FRESH (distinct object,
  text-only) or Issue 1 cannot be reproduced.
- ❌ Don't add error-injection plumbing (the Issue 1 scenario needs none; keep the surface minimal).
- ❌ Don't put the unit test inside `realistic-mock.ts` — bun only discovers `*.test.ts`. Use a companion.
- ❌ Don't drive the real `StreamProxy` here (that's P1.M2.T3.S1) or modify the proxy / consumer harness /
  invariant harness. This is the upstream mock only.

---

## Confidence Score: **9/10**

The deliverable is small and fully specified: the authoritative provider accumulation mechanics are
inlined verbatim from the local provider source, the existing `makeScriptedTwoPhaseUpstream` iterator
control-flow (including primary-throw-on-abort) is reproduced, the pi-ai type signatures are verified
against local `node_modules`, and the validation commands (`bun test`, self-contained `tsc`) are
project-verified. The reference implementation compiles against the verified types. Residual risk is only
in exact ContentBlock generic typing under TS strict (handled with the established `as never`/`as unknown`
cast idiom from `invariant-harness.ts`/`consumer-harness.test.ts`), which does not affect the runtime
accumulation logic. The mock directly reproduces Issue 1 through `consumeLikeAgentLoop`, so its
faithfulness is falsifiable in the companion test.
