# PRP — P1.M8.T4.S1: Property tests and stress test suite

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M8.T4.S1 (Phase 7 Hardening, 2 pt). A **TEST-ONLY** work item: PRD §55 "Property Tests"
> + "Stress Tests" + the contract's Chaos + Regression suites. Asserts Appendix-O invariants INV-001/002/
> 003/004/005/010 under randomized event sequences; runs 1000 interruption cycles checking memory; 1MB+
> reasoning buffers; 100 rapid shortcut presses; random upstream-error injection; and byte-identical
> golden-fixture replay. **ZERO source files modified** — consumes the stable modules from P1.M1–M7.
> **INPUT**: `StreamProxy` (`src/provider/proxy.ts`), `TransitionController` (`src/state/controller.ts`),
> `TransitionCoordinator` (`src/state/coordinator.ts`), `ReasoningBuffer` (`src/buffer/index.ts`),
> `ProviderDecorator` (`src/provider/decorator.ts`), golden-replay infra (`tests/golden/{replay,fixtures}.ts`).
> **OUTPUT**: 4 new `*.test.ts` files + 1 shared helper, **>100 new test cases**, all green in `npx bun test`.
> **Consumed by**: P1.M8.T5 (docs) + the PRD §60 "Production Readiness Checklist" (all invariants verified).

---

## Goal

**Feature Goal**: A deterministic, reproducible test suite proving that the stop-thinking wrapper
preserves every Appendix-O invariant under randomized workloads and adversarial failure injection, and
that the inactive path remains byte-identical to the built-in provider. Concretely:
- **Property Tests** (INV-001/002/003/004/005/010): generate **random event sequences with random
  interruption points** via a seeded PRNG; assert exactly one `message_start`, exactly one terminal, at
  most one interruption, irreversible authority transfer, and exactly-once cleanup — for every seed.
- **Stress Tests**: (a) **1000 interruption cycles** in sequence with a forced-GC memory check proving no
  unbounded heap growth; (b) **1MB+ reasoning buffers** flowing through `ReasoningBuffer` + a full
  interruption→replacement transition; (c) **100 rapid shortcut presses in ≤100ms** proving idempotency
  (exactly one accepted); (d) **repeated provider initialization** (decorator initialize/shutdown cycle)
  leaving no orphaned registration.
- **Chaos Tests**: inject **random errors into a mock upstream at random points** (throw or `error`-event,
  primary or replacement); verify recovery always yields a single downstream terminal, a resolvable
  `output.result()`, a clean `Idle` FSM, exactly-once cleanup, and privacy-safe diagnostics.
- **Regression Tests**: replay **all golden fixtures through the full wrapper** (the StreamProxy WITH its
  transition logic present) with no interruption; assert **byte-identical** downstream output; add new
  append-only fixtures (tool calls, multi-block) to widen the guard.

**Deliverable** (ONE shared helper CREATED + FOUR test files CREATED, **no `src/` edits**):
- `tests/helpers/invariant-harness.ts` — **CREATE**: seeded `mulberry32` PRNG, a generalized
  `makeScriptedTwoPhaseUpstream` (primary+replacement event scripts + chaos injection hook), `genScenario`,
  `runScenario`, `collectOutput`, and the invariant counter/asserter helpers (`assertInvariants`).
- `tests/property-tests.test.ts` — **CREATE**: per-seed randomized cases (≥50 seeds) asserting INV-001/002/
  003/004/005/010 + dedicated idempotency/irreversibility tests.
- `tests/stress-tests.test.ts` — **CREATE**: 1000-cycle memory test, 1MB+ buffer tests, 100-press rapid-fire
  tests, repeated-init test.
- `tests/chaos-tests.test.ts` — **CREATE**: per-seed random-error-injection cases (≥30 seeds) + targeted
  edge injections.
- `tests/regression-tests.test.ts` — **CREATE**: byte-identical replay of every golden fixture through the
  full proxy + new append-only fixtures.

**Success Definition**: From a clean checkout, `npx bun run build` → exit 0; `npx bun test` → **ALL green**
(223 pre-existing + the new suite), with the new suite alone contributing **>100 passing cases**. Every
generated failure is **reproducible from its printed seed**. The 1000-cycle stress shows **bounded heap
growth** (no monotonic leak) across batches with `Bun.gc(true)`.

---

## User Persona (if applicable)

**Target User**: The maintainer shipping the extension to production. They need proof — not hope — that
the streaming/state-machine invariants hold under random timing, huge reasoning, rapid keypresses, and
flaky providers, because a leaked terminal or a broken downstream stream would corrupt Pi's conversation
model (one prompt → one response).

**Use Case**: Before tagging a release, the maintainer runs `npx bun test`. The property suite has already
fuzzed thousands of event orderings; the stress suite has confirmed no memory leak across 1000 cycles; the
chaos suite has confirmed recovery from injected faults; the regression suite has confirmed the inactive
path is still byte-identical. A failure prints a deterministic seed so the exact scenario is replayable.

**Pain Points Addressed**: (1) the interruption path has many async races that hand-written unit tests
miss; (2) a leaked `setTimeout`/`AbortController` would silently grow heap under sustained use; (3) a
double-terminal would corrupt Pi's assistant turn — only a property/chaos sweep can credibly rule it out.

---

## Why

- **PRD §55 Property Tests** mandates "Exactly one completion / Exactly one authority / No duplicate start
  / No duplicate end / No leaked buffers" — these are *properties*, not scenarios; they need a generator.
- **PRD §55 Stress Tests** mandates "Thousands of interruptions / Large reasoning buffers / High latency
  providers / Rapid shortcut presses / Repeated provider initialization" — these validate INV-010 cleanup
  (no leaked timers/buffers) and INV-004 idempotency at scale.
- **Appendix O** makes INV-001..INV-012 *normative*; the contract scopes the property suite to
  INV-001/002/003/004/005/010 (the runtime-observable ones on the streaming surface).
- **PRD §60 Production Readiness** ("All resources cleaned / No memory leaks / Abort races tested /
  Duplicate event suppression verified / All ownership invariants preserved") is uncheckable without this
  suite. It is the gate between "draft" and "production".
- **Downstream**: P1.M8.T5 documents the feature; this suite is the evidence base it can cite.

---

## What

### Success Criteria

- [ ] `tests/helpers/invariant-harness.ts` exports `mulberry32`, `makeScriptedTwoPhaseUpstream`, `genScenario`,
      `runScenario`, `collectOutput`, `countInvariants`, `assertInvariants`, and the shared doubles
      (`makeCaptureDiag`, `makeModel`, `waitFor`, `ev`). **No production imports are mutated.**
- [ ] `tests/property-tests.test.ts` has **≥50 per-seed cases** (each seed a discrete `test()`), each
      asserting INV-001 (one downstream stream — drains to completion), INV-002 (one `start`), INV-003
      (one terminal + `output.result()` resolves), INV-004 (≤1 interruption), INV-005 (authority never
      reverts to `"forwarding"` once `"splicing"`), INV-010 (one `proxy.lifecycle.cleanup`), plus ≥3
      dedicated tests (second `triggerStop()` → `false`; authority irreversibility; no-interruption seed
      still satisfies the invariants).
- [ ] `tests/stress-tests.test.ts` has: a **1000-cycle** interruption test asserting bounded heap growth
      with `Bun.gc(true)`; a **1MB+ reasoning buffer** test (single-delta and many-delta shapes, + the
      `buffer.overflow` warn path under a low ceiling); a **100 rapid shortcut presses** test proving
      exactly one accepted + single terminal; a **repeated provider init** test (decorator
      initialize↔shutdown ×N, no orphan). (≥10 cases.)
- [ ] `tests/chaos-tests.test.ts` has **≥30 per-seed cases** injecting a random error (throw OR `error`
      event) at a random index in the primary or replacement stream; each asserts single terminal,
      `output.result()` resolves, FSM ends `Idle`, exactly-once cleanup, and privacy-safe diagnostics.
      Plus ≥4 targeted edge injections (sync throw pre-start, error mid-reasoning, error mid-abort,
      replacement throws after one event).
- [ ] `tests/regression-tests.test.ts` replays **every** golden fixture (`NORMAL_REPLAY`,
      `NO_REASONING_REPLAY`, `ERROR_REPLAY` + ≥3 NEW append-only fixtures: a tool-call replay, a
      multi-block reasoning replay, a no-reasoning-with-toolcall replay) through the **full `StreamProxy`**
      with no interruption → `toEqual` byte-identical; plus one case constructing the proxy exactly as the
      decorator does (`new StreamProxy(model, ctx, opts, fn, diag)`) confirming the full wiring preserves
      byte-identity. (≥8 cases.)
- [ ] New suite total **>100 passing cases**; `npx bun test` → ALL green (no regression in the 223 existing).
- [ ] **Zero** edits to any file under `src/`, `package.json`, `tsconfig.json`, `.gitignore`, or any
      existing test file.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines: the exact `StreamProxy` ctor arity + public assertion surface; the verbatim
two-phase upstream mock pattern to generalize; the `AssistantMessageEventStream` semantics (`push` no-ops
once done; `result()` resolves once; no public `done` getter); the full INV→assertion table; the seeded-PRNG
design (no new deps); the `Bun.gc(true)` memory pattern; the exact validation commands; and the parallel
non-conflict proof (zero file overlap with P1.M8.T3.S1). The only assumption — that the P1.M1–M7 modules
are shipped & stable — is already true.

### Documentation & References

```yaml
# MUST READ — authoritative contracts for THIS work item
- file: plan/001_b0c6691bb424/P1M8T4S1/research/notes.md
  why: "The codebase audit: the testable surface, the INV→assertion table, the seeded-PRNG decision,
        the Bun.gc memory pattern, the file-naming reconciliation, the parallel-boundary proof."
  critical: "TEST-ONLY — no src/ edits. Use a seeded PRNG (mulberry32), NOT fast-check. INV-003 is
        asserted by counting terminals in drained collected[] (the EventStream has no public done getter).
        Property/chaos/stress must not depend on P1.M8.T3.S1 — use the 3-arg decorator ctor."

# PRD authority (PRD.md)
- url: PRD.md §55 "Property Tests" + §55 "Stress Tests"
  why: "Property = exactly one completion / one authority / no duplicate start / no duplicate end / no
        leaked buffers. Stress = thousands of interruptions / large buffers / high latency / rapid presses
        / repeated provider init."
  critical: "These are the SPEC the suite encodes. Every test maps to one of these bullets."

- url: PRD.md Appendix O "INV-001…INV-012"
  why: "Normative invariant definitions. This suite targets INV-001/002/003/004/005/010 (runtime-observable
        on the streaming surface)."
  critical: "INV-005 = 'Authority transfer is irreversible'. INV-010 = 'Cleanup shall execute exactly once
        regardless of success, failure, timeout, or cancellation'. INV-004 = 'At most one interruption'."

- url: PRD.md §60 "Production Readiness Checklist"
  why: "Reliability rows: All resources cleaned / No memory leaks / Abort races tested / Duplicate event
        suppression verified / All ownership invariants preserved. This suite is how those rows get checked."
  critical: "The memory test must show bounded growth, not zero growth (GC isn't deterministic)."

# INPUT contracts (already shipped — CONSUME, do not modify)
- file: src/provider/proxy.ts   # (P1.M2–M7 — DONE)
  why: "The primary subject. ctor(model, context, options, upstreamStreamFn, diagnostics, controller?,
        buffer?, abortTimeoutMs?, requestBuilder?, replacementStartupTimeoutMs?, coordinator?).
        Assert via proxy.output / proxy.controller.getState() / proxy.authority / proxy.triggerStop() /
        proxy.isReasoning() / proxy.buffer."
  pattern: "triggerStop() returns true only in Reasoning (≤1 true per response = INV-004). authority flips
        forwarding→splicing on the first replacement event and NEVER reverts (INV-005). _terminate() runs
        exactly once → one 'proxy.lifecycle.cleanup' trace (INV-010)."
  gotcha: "output stays OPEN during the abort→replacement transition (the replacement owns the terminal).
        So the consumer's for-await only exits once the replacement's done/error is forwarded. A property
        case that interrupts MUST queue replacement events + a terminal or the drain hangs (waitFor timeout
        surfaces it). push() no-ops once a terminal set done=true → duplicate terminals are structurally dropped."

- file: src/state/coordinator.ts   # (P1.M4.T4 — DONE)
  why: "For the rapid-press stress. requestStop(): boolean is idempotent — only the first press (while
        canInterrupt()) returns true; subsequent presses see state≠Reasoning → false (or record pending
        only during Delegating). setActiveProxy(proxy) points it at the live proxy."
  pattern: "100× coordinator.requestStop() in a tight loop → exactly ONE returns true. alreadyInterrupting()
        is true after the first accepted press."

- file: src/state/controller.ts   # (P1.M3.T1 — DONE)
  why: "FSM getState() ends 'Idle' on every clean terminal (INV-010 side-effect). ALLOWED_TRANSITIONS is
        the §16 table — never assert illegal transitions; the proxy already guards them."

- file: src/buffer/index.ts   # (P1.M4.T1 — DONE)
  why: "For the large-buffer stress. append(delta) accumulates; getByteSize() = Σ delta.length; a projected
        total > maximumBytes still appends but emits one 'buffer.overflow' warn (§23.5 no truncation).
        freeze() idempotent; snapshot() returns a frozen immutable copy."
  pattern: "Push N thinking_delta events whose deltas total ≥1MB through the proxy's trackEvent (which
        appends to proxy.buffer). Assert proxy.buffer.getByteSize() ≥ 1MB and an interruption completes
        cleanly. Set a low maximumBytes to exercise the overflow warn."

- file: src/provider/decorator.ts   # (P1.M1.T4 — DONE; P1.M8.T3.S1 adds an OPTIONAL 4th param in parallel)
  why: "For the repeated-init stress. new ProviderDecorator(config, diagnostics, registry?) + initialize()/
        shutdown(). shutdown() calls unregisterApiProviders(sourceId); initialize() re-captures+re-registers."
  pattern: "Inject a FAKE registry (DI) — NEVER mutate the global pi-ai registry in a unit test. Loop
        initialize()↔shutdown() ×N; assert the fake registry's registered flips true/false each cycle (no
        orphan). Use the 3-arg ctor (omit T3's 4th disabledProvider param) → stable regardless of T3."
  gotcha: "DO NOT couple this stress to P1.M8.T3.S1's disable flag. The 3-arg ctor is behavior-preserving."

# GOLDEN infra (REUSE — do not duplicate)
- file: tests/golden/replay.ts   # (P1.M2.T4.S1 — DONE)
  why: "replayEvents(events) builds a mock upstream + a real StreamProxy + drains proxy.output. Reuse it
        in regression_tests for the byte-identical assertion. Also exports GOLDEN_MODEL/CONTEXT/OPTIONS,
        NOOP_DIAGNOSTICS, partialAssistantMessage."
  pattern: "replayEvents returns the drained events; toEqual(fixture) proves byte-identity. NOTE: it uses
        the 5-arg ctor (forward-only) — for the 'full wrapper' regression case, ALSO construct the proxy
        with the decorator's exact 5-arg shape and re-assert."

- file: tests/golden/fixtures.ts   # (P1.M2.T4.S1 — DONE)
  why: "NORMAL_REPLAY / NO_REASONING_REPLAY / ERROR_REPLAY. APPEND-ONLY — add NEW fixtures for the
        regression suite (tool-call, multi-block) WITHOUT mutating the existing three."
  critical: "EVERY fixture MUST end with a terminal (done/error) or replayEvents hangs. New fixtures follow
        the same partialAssistantMessage() shape."

# REFERENCE — the interruption-test patterns to generalize (VERBATIM source)
- file: tests/stream-proxy-replacement.test.ts
  why: "The canonical two-phase upstream mock (makeReplacementUpstream) + the drive loop
        (pushPrimary → waitFor(isReasoning) → triggerStop → waitFor(calls) → pushReplacement → drain).
        Generalize makeReplacementUpstream into makeScriptedTwoPhaseUpstream in the harness."
  pattern: "makeReplacementUpstream: primary queue + replacement queue + separate signals; 1st call =
        primary (throws on signal abort), 2nd call = replacement (records options.reasoning). calls[0] is
        the REPLACEMENT invocation."

- file: tests/stream-proxy-failure-modes.test.ts
  why: "makeTwoPhaseUpstream (with a configurable replacementFactory) + makeIgnoreAbortUpstream +
        asyncIterableFrom + the privacy ALLOWED_KEYS asserter. The chaos suite reuses makeTwoPhaseUpstream's
        replacementFactory hook to inject mid-stream throws."
  pattern: "replacementFactory?: (signal?) => AsyncIterable<event> — pass a factory that yields N events
        then throws (FM-010 shape). assertPrivacy(events, prefix) checks only allow-listed diagnostic keys."

- file: tests/stream-proxy.test.ts + tests/stream-proxy-lifecycle.test.ts
  why: "The base capturing-diag double + the consumer-drain pattern (for-await into seen[])."

# PARALLEL boundary (CONTRACT)
- file: plan/001_b0c6691bb424/P1M8T3S1/PRP.md
  why: "P1.M8.T3.S1 (in flight) edits decorator.ts/index.ts + decorator/factory tests + lifecycle.test.ts.
        This task creates ONLY new files → ZERO file overlap. The repeated-init stress uses the 3-arg
        decorator ctor (T3's 4th param is optional → omitted → stable)."
  critical: "Do NOT add a disable-flag stress that depends on T3. Keep the suite T3-independent."
```

### Current Codebase tree (after P1.M1–M7 + P1.M8.T1/T2; before this task)

```bash
.
├── package.json          # scripts: build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); main ./dist/index.js
├── tsconfig.json         # ES2022, strict, outDir dist, rootDir src, exclude [node_modules,dist,tests]
├── src/                  # ALL DONE & STABLE — DO NOT TOUCH
│   ├── index.ts  provider/{decorator,proxy}.ts  state/{controller,coordinator}.ts
│   ├── config/index.ts  diagnostics/index.ts  buffer/index.ts  shortcut/index.ts
│   ├── request/builder.ts  telemetry/index.ts  types.ts
├── tests/                # 21 existing *.test.ts (223 cases) + golden/
│   ├── golden/{replay.ts, fixtures.ts, golden-replay.test.ts}
│   ├── stream-proxy*.test.ts (abort, detection, filtering, lifecycle, pending-stop, race, replacement, failure-modes)
│   ├── transition-{controller,coordinator}.test.ts  reasoning-buffer.test.ts  shortcut-manager.test.ts
│   ├── provider-decorator.test.ts  factory.test.ts  request-builder.test.ts  telemetry.test.ts
│   ├── config.test.ts  diagnostics.test.ts  types.test.ts  smoke.test.ts
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask) — **only NEW files**

```bash
tests/
├── helpers/
│   └── invariant-harness.ts   # NEW — shared seeded-PRNG + two-phase mock + scenario gen + invariant asserters
├── property-tests.test.ts     # NEW — randomized INV-001/002/003/004/005/010 (≥50 seeds + dedicated tests)
├── stress-tests.test.ts       # NEW — 1000-cycle memory / 1MB+ buffers / 100 rapid presses / repeated init
├── chaos-tests.test.ts        # NEW — random upstream-error injection (≥30 seeds + targeted edges)
└── regression-tests.test.ts   # NEW — byte-identical golden replay through the full proxy (+ new fixtures)
```

**File responsibilities**: `invariant-harness.ts` = the reproducible generator + doubles shared by all four
suites (NOT a `*.test.ts` → bun won't run it; tsconfig excludes `tests` → never hits the build). The four
`*.test.ts` files import from it. No production file is touched.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (TEST-ONLY): this task creates ONLY new files under tests/. Do NOT edit any src/ file,
// package.json, tsconfig.json, .gitignore, or any existing test. tsconfig exclude:["tests"] means the new
// files are NOT type-checked by `npx bun run typecheck` (that checks src ONLY) — type errors surface only
// at `npx bun test` time, so type the harness/tests carefully.

// CRITICAL (output stays OPEN during transition): when interrupted, the proxy's run() does NOT push a
// terminal — the replacement stream owns it. So a property/chaos case that calls triggerStop() MUST then
// queue replacement events ending in a terminal (done/error), or the consumer's for-await hangs. waitFor's
// timeout surfaces a hang as a clear failure (with the seed). NEVER assert "no terminal" on an interrupted
// case — assert EXACTLY ONE terminal from the spliced stream.

// CRITICAL (INV-003 — no public done getter): AssistantMessageEventStream.push() no-ops once a terminal set
// done=true (EventStream internals: private `done`). There is NO public done flag. Assert INV-003 by
// counting terminals in the drained collected[] array === 1, AND by `await proxy.output.result()` resolving
// (race it against a timeout to prove it doesn't hang). Do NOT look for a `.done` property.

// CRITICAL (INV-004 — triggerStop idempotency): triggerStop() returns true ONLY when canInterrupt()
// (state === Reasoning). The first accepted press synchronously moves Reasoning→StopRequested→Aborting, so
// every subsequent triggerStop()/requestStop() returns false. Assert: across the run, ≤1 true return.
// Also assert: a second triggerStop() DURING a transition returns false (no double-abort).

// CRITICAL (INV-005 — authority irreversible): proxy.authority starts "forwarding", flips to "splicing" on
// the first replacement event, and NEVER reverts. Assert: if final authority === "splicing", it must have
// been reached via exactly one flip; re-reading it later still yields "splicing". There is no path back.

// CRITICAL (INV-010 — cleanup once): _terminate() is guarded by a `_terminated` flag → exactly one
// "proxy.lifecycle.cleanup" trace per proxy. Count it in the captured diagnostics === 1. (On the normal
// non-interrupted path the FSM may sit in Reasoning — §16 has no normal exit — but cleanup STILL runs once.)

// GOTCHA (memory check is BOUNDED, not zero): Bun.gc(true) forces GC but isn't perfectly deterministic.
// Assert heap growth is < a tolerant bound (e.g. a few MB) AND that a 2nd 1000-cycle batch does NOT grow
// proportionally (i.e. growth per batch trends toward zero). NEVER assert before === after exactly.

// GOTCHA (seeded PRNG, no fast-check): use mulberry32(seed) for deterministic, reproducible scenarios.
// Print the seed in every per-seed test name so a failure is 100% replayable. Do NOT add fast-check
// (new dependency; the repo is hand-rolled; determinism is better for CI).

// GOTCHA (fake registry for decorator tests): the pi-ai apiProviderRegistry is module-global and importing
// the decorator eagerly registers builtins. The repeated-init stress MUST inject a fake registry (3rd ctor
// arg) and NEVER call the real registerApiProvider/unregisterApiProviders. (Real-registry proof is out of
// scope for this suite — it lives in P1.M8.T3.S1's Level-3 smoke.)

// GOTCHA (bun timeout): bun's default test timeout is 5000ms. The 1000-cycle loops may exceed it — pass an
// explicit timeout: test("name", async () => {...}, 30000). Keep each cycle minimal (1–3 events) + force
// Bun.gc(true) between batches.

// GOTCHA (parallel with P1.M8.T3.S1): T3 edits decorator.ts/index.ts. This task's repeated-init stress
// uses the 3-arg ProviderDecorator ctor (omits T3's optional 4th disabledProvider param) → stable whether
// or not T3 has merged. Do NOT add a T3-dependent disable-flag test.

// GOTCHA (rapid-press timing): fire coordinator.requestStop() 100× in a SYNCHRONOUS tight loop (or 100
// within 100ms via setTimeout(0)). The FSM moves to Aborting synchronously on the first accepted press, so
// presses 2–100 all see state≠Reasoning → false. Assert exactly one true + single terminal downstream.
```

---

## Implementation Blueprint

### Data models and structure

No production data models. The harness defines its OWN scenario/inventory types (local to tests):

```typescript
// tests/helpers/invariant-harness.ts — local types (NOT exported to production)
export interface Scenario {
  seed: number;                       // for the test name + reproducibility
  interrupt: boolean;                 // false → no-interruption (invariants still hold)
  thinkingDeltasBeforeStop: number;   // 1..8 (≥1 so the proxy reaches Reasoning before triggerStop)
  replacementTextDeltas: number;      // 1..5 (replacement answer length)
  injectError: boolean;               // chaos: inject an error instead of a clean terminal
  errorPhase: "primary" | "replacement"; // chaos: where to inject
  errorAs: "throw" | "event";         // chaos: how to inject
}

export interface InvariantReport {
  downstreamDrained: boolean;         // INV-001 (the single output stream completed)
  startCount: number;                 // INV-002
  terminalCount: number;              // INV-003 (done|error)
  resultResolved: boolean;            // INV-003 (output.result() resolved)
  interruptionCount: number;          // INV-004 (triggerStop true count + first-event traces)
  finalAuthority: "forwarding" | "splicing"; // INV-005
  cleanupCount: number;               // INV-010
  finalState: TransitionState;        // must be "Idle"
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE tests/helpers/invariant-harness.ts (the shared engine)
  - IMPLEMENT mulberry32(seed): (max=2^32) => () => number [0,1)  — the deterministic PRNG.
  - IMPLEMENT makeCaptureDiag() / makeModel() / ev(partial) / waitFor(pred, timeoutMs) — copy VERBATIM
    from tests/stream-proxy-failure-modes.test.ts (the canonical doubles). Export them.
  - IMPLEMENT makeScriptedTwoPhaseUpstream({ primary, replacement, errorInject? }) — GENERALIZE
    makeTwoPhaseUpstream (tests/stream-proxy-failure-modes.test.ts): primary async-iterator over a queue
    that throws on its signal abort (as the proxy's _internalAbort fires); replacement async-iterator over
    a queue with its own fresh signal. Accept an optional errorInject { phase, atIndex, as } that, when set,
    throws (as:"throw") or pushes an `error` event (as:"event") at the given index. Return { fn, calls,
    pushPrimary, pushReplacement, closePrimary }.
  - IMPLEMENT genScenario(rng, { interrupt, chaos }) → Scenario (randomized but deterministic from rng).
  - IMPLEMENT collectOutput(proxy): Promise<AssistantMessageEvent[]> — drains proxy.output via for-await.
  - IMPLEMENT countInvariants(collected, diag, proxy, { acceptedCount }) → InvariantReport (the table in
    research notes §5: startCount, terminalCount via isTerminalEvent, cleanupCount = "proxy.lifecycle.cleanup"
    traces, interruptionCount = acceptedCount + count of "proxy.replacement.first-event", finalAuthority =
    proxy.authority, finalState = proxy.controller.getState(), resultResolved via a raced output.result()).
  - IMPLEMENT assertInvariants(report, { allowInterruption }) — the single assertion entry: drains-completed
    (INV-001), startCount===1 (INV-002), terminalCount===1 && resultResolved (INV-003), interruptionCount<=1
    (INV-004), finalAuthority never reverts (INV-005 — if "splicing" it stays "splicing"), cleanupCount===1
    (INV-010), finalState==="Idle".
  - IMPLEMENT buildProxy(harnessOpts) — constructs `new StreamProxy(model, ctx, opts, fn, diag, controller,
    buffer, abortTimeoutMs, requestBuilder?, replacementStartupTimeoutMs, coordinator)` with injectable
    small timeouts so injected failures resolve quickly. (Mirror the failure-modes tests' ctor shape.)
  - FOLLOW pattern: tests/stream-proxy-failure-modes.test.ts (the most recent + most complete harness).
  - NAMING: camelCase helpers; the file is NOT *.test.ts so bun won't execute it.
  - PLACEMENT: tests/helpers/invariant-harness.ts.
  - GOTCHA: import isTerminalEvent/isThinkingEvent/isTextEvent from ../types (the shared guards) so terminal
    counting matches production exactly. Import createAssistantMessageEventStream? No — the mock builds the
    stream via the upstream fn like replay.ts does; use the two-phase iterator pattern.

Task 2: CREATE tests/property-tests.test.ts (randomized INV coverage — ≥50 seeds + dedicated)
  - IMPORT { mulberry32, genScenario, runScenario, collectOutput, countInvariants, assertInvariants,
    makeCaptureDiag, makeModel, ev } from ./helpers/invariant-harness.
  - IMPORT { StreamProxy } from ../src/provider/proxy; { TransitionController } ../src/state/controller;
    { ReasoningBuffer } ../src/buffer; { DEFAULT_CONFIG } ../src/config; isTerminalEvent from ../src/types.
  - IMPLEMENT describe("Property Tests — randomized invariants (INV-001/002/003/004/005/010)"):
      * for (let seed = 0; seed < 50; seed++) { test(`seed=${seed} holds the streaming invariants`,
        async () => { const rng = mulberry32(seed); const sc = genScenario(rng, {interrupt:true});
        ...build proxy with the two-phase mock pre-seeded per sc...; drive: pushPrimary(start, thinking_start,
        ×thinkingDeltasBeforeStop thinking_delta); waitFor(isReasoning); const accepted = proxy.triggerStop();
        waitFor(replacement invoked); pushReplacement(text_start, ×replacementTextDeltas text_delta, done);
        const collected = await collectOutput(proxy); const report = countInvariants(collected, diag, proxy,
        {acceptedCount: accepted?1:0}); assertInvariants(report, {allowInterruption:true}); }); }
      * PLUS a second loop (seed 0..15) with interrupt:false (no-interruption seeds) asserting the same
        invariants hold on a normal stream (interruptionCount===0, finalAuthority==="forwarding").
  - ADD dedicated tests:
      * "INV-004: a second triggerStop() during the transition returns false (no double-abort)".
      * "INV-005: authority, once 'splicing', never reverts to 'forwarding'" (sample at multiple points).
      * "INV-010: cleanup runs exactly once even when the replacement fails (error terminal)".
      * "no-interruption seed: downstream is byte-identical to the input (regression-style)".
  - NAMING: test(`seed=${seed} ...`); helpers test_*.
  - GOTCHA: every interrupted case MUST queue a replacement terminal or collectOutput hangs (waitFor surfaces
    it). Print the seed in the name for reproducibility.

Task 3: CREATE tests/stress-tests.test.ts (scale + resource bounds — ≥10 cases)
  - IMPORT the harness + StreamProxy/TransitionController/TransitionCoordinator/ReasoningBuffer/ProviderDecorator/DEFAULT_CONFIG.
  - IMPLEMENT describe("Stress — 1000 interruption cycles, no memory growth"):
      * test("1000 interrupted cycles: bounded heap growth across batches", async () => {
        const batch = (n) => { for (let i=0;i<n;i++){ build a minimal proxy; drive start→thinking→triggerStop
        →replacement done; await collectOutput(proxy); } };  // each proxy fully drained → GC-eligible
        Bun.gc(true); const h0 = process.memoryUsage().heapUsed; batch(1000); Bun.gc(true);
        const h1 = process.memoryUsage().heapUsed; batch(1000); Bun.gc(true); const h2 = ...heapUsed;
        expect(h1 - h0).toBeLessThan(BOUND);  // tolerant, e.g. 8MB
        expect(h2 - h1).toBeLessThan(h1 - h0 + EPSILON);  // 2nd batch does NOT grow more than the 1st
        }, 30000);
      * ALSO a normal-cycle 1000-iteration variant (no interruption) asserting the same bound.
  - IMPLEMENT describe("Stress — large reasoning buffers (1MB+)"):
      * test("1MB single thinking_delta: buffer accumulates, transition completes"): push one 1MB thinking_delta,
        assert proxy.buffer.getByteSize() >= 1_000_000, then triggerStop + replacement done; assert invariants.
      * test("1MB across many deltas: same"): 1000 × ~1KB deltas.
      * test("overflow warn under a low maximumBytes"): construct ReasoningBuffer(diag, 64*1024); push >64KB;
        assert the "buffer.overflow" warn fired AND the delta was still appended (§23.5 no truncation).
      * test("8MB ceiling (DEFAULT_CONFIG.maximumReasoningBufferBytes): no crash, snapshot works").
  - IMPLEMENT describe("Stress — rapid shortcut presses (100 in ≤100ms)"):
      * test("100× coordinator.requestStop() in a tight loop → exactly ONE accepted + single terminal"):
        build proxy + coordinator.setActiveProxy(proxy); drive to Reasoning; const t0=Date.now(); let
        accepted=0; for (let i=0;i<100;i++){ if (coordinator.requestStop()) accepted++; } const elapsed =
        Date.now()-t0; expect(accepted).toBe(1); expect(elapsed).toBeLessThan(100); ...then queue replacement
        done; assert single terminal. (Fire SYNCHRONOUSLY to model 100 presses within 100ms.)
      * test("100 presses during Delegating (pre-reasoning): none accepted now, ≤1 honored later (EC-002)"):
        fire 100× before reasoning; assert accepted===0; then push reasoning; assert at most one pending-stop
        honored (the coordinator records at most one pending).
      * test("100 presses after the transition began: all ignored (alreadyInterrupting)").
  - IMPLEMENT describe("Stress — repeated provider initialization"):
      * test("decorator initialize↔shutdown ×100: no orphaned registration"): const f = makeFakeRegistry();
        const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);  // 3-arg ctor — T3-independent
        for (let i=0;i<100;i++){ d.initialize(); expect(f.registered).not.toBeNull(); d.shutdown();
        expect(f.registered).toBeNull(); }  // restore each cycle → no orphan
      * test("shutdown is idempotent + re-initializable after shutdown"): initialize; shutdown; shutdown();
        initialize(); expect(f.registered).not.toBeNull();  // reload cycle (EC-013)
  - NAMING: descriptive test names; the 1000-cycle tests use explicit timeouts (30000ms).
  - GOTCHA: keep each 1000-cycle iteration minimal (start + 1 thinking + stop + 1 replacement + done).
    Force Bun.gc(true) before measuring. The decorator fake-registry double is copied from
    tests/provider-decorator.test.ts (makeFakeRegistry, baseConfig, STREAM_SENTINEL) — copy, don't import
    from a *.test.ts (those aren't importable modules). Use the 3-arg ctor.

Task 4: CREATE tests/chaos-tests.test.ts (random error injection — ≥30 seeds + targeted edges)
  - IMPORT the harness + production modules. Use makeScriptedTwoPhaseUpstream's errorInject hook.
  - IMPLEMENT describe("Chaos — random upstream errors never produce a broken stream"):
      * for (let seed=0; seed<30; seed++) { test(`seed=${seed} recovers to a single clean terminal`,
        async () => { const rng=mulberry32(1000+seed); pick errorPhase ∈ {primary,replacement},
        errorAs ∈ {throw,event}, atIndex ∈ [0..N]; build the two-phase mock with errorInject; if primary
        injection, NO triggerStop (the error IS the terminal); if replacement injection, triggerStop first;
        const collected = await collectOutput(proxy); const report = countInvariants(...);
        assertInvariants(report, {allowInterruption: errorPhase==="replacement"});
        // recovery guarantee: exactly one terminal, result resolves, Idle, one cleanup
        assertPrivacy(diag.events, "proxy."); }); }
  - ADD targeted edge tests (not seeded):
      * "primary throws synchronously before yielding any event → single synthesized error terminal + Idle".
      * "primary throws mid-reasoning → single error terminal + Idle + one cleanup".
      * "replacement throws synchronously (FM-007 shape) → single error terminal".
      * "replacement yields one event then throws (FM-010 shape) → text + single synthesized error".
      * "error EVENT (not throw) injected mid-primary → forwarded as the single terminal".
  - NAMING: test(`seed=${seed} ...`); descriptive edge names.
  - GOTCHA: a primary-side error case must NOT call triggerStop (the error is the terminal); a replacement-
    side error case MUST triggerStop first (so the replacement is launched) then inject in the replacement.
    Every case asserts privacy (ALLOWED_KEYS only). Print the seed.

Task 5: CREATE tests/regression-tests.test.ts (byte-identical golden replay — ≥8 cases)
  - IMPORT { replayEvents, partialAssistantMessage } from ./golden/replay; the existing fixtures; StreamProxy.
  - ADD NEW append-only fixtures in tests/golden/fixtures.ts? NO — to avoid editing an existing file, define
    the NEW fixtures LOCALLY in regression-tests.test.ts (or a new tests/golden/regression-fixtures.ts). Use
    the SAME partialAssistantMessage() shape. Each MUST end with a terminal. (decision: define them inline
    in regression-tests.test.ts to keep the diff to NEW files only.)
  - IMPLEMENT describe("Regression — byte-identical replay through the FULL proxy (no interruption)"):
      * test("NORMAL_REPLAY byte-identical"): expect(await replayEvents(NORMAL_REPLAY)).toEqual(NORMAL_REPLAY).
      * test("NO_REASONING_REPLAY byte-identical"): same.
      * test("ERROR_REPLAY byte-identical"): same.
      * test("NEW tool-call replay byte-identical"): a fixture with toolcall_start/delta/end.
      * test("NEW multi-block reasoning replay byte-identical"): two thinking blocks then text.
      * test("NEW no-reasoning-with-toolcall byte-identical").
      * test("full-proxy ctor (decorator shape) preserves byte-identity"): construct `new StreamProxy(GOLDEN_MODEL,
        GOLDEN_CONTEXT, GOLDEN_OPTIONS, mockFn, NOOP_DIAGNOSTICS)` (5-arg, exactly as the decorator does) and
        assert the drained output toEqual the fixture.
      * test("every replay satisfies INV-001/002/003/010 (invariants hold when inactive)"): for each fixture,
        countInvariants over the drained output === {start:1, terminal:1, cleanup:1}.
  - GOTCHA: replayEvents uses the forward-only path — that IS the no-interruption path, so byte-identity is
    the correct expectation. The "full-proxy ctor" case confirms the full wiring (detection present but
    inactive) still forwards unchanged. NEVER mutate NORMAL_REPLAY/NO_REASONING_REPLAY/ERROR_REPLAY (append-only).

Task 6: VERIFY (validation only — no code changes)
  - RUN: npx bun run build → exit 0 (unaffected by test-only additions).
  - RUN: npx bun test → ALL green (223 pre-existing + >100 new). Run the new files in isolation first:
        npx bun test tests/property-tests.test.ts tests/stress-tests.test.ts tests/chaos-tests.test.ts
                                          tests/regression-tests.test.ts
  - RUN the Level 4 scope gate below: confirm ONLY new files under tests/ were added (no src/ diff).
```

### Implementation Patterns & Key Details

```typescript
// ── The seeded PRNG (deterministic; reproducible failures). From tests/helpers/invariant-harness.ts.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const ri = (rng: () => number, min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1));
export const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

// ── The generalized two-phase upstream (GENERALIZE makeTwoPhaseUpstream from failure-modes tests).
export interface ErrorInject { phase: "primary" | "replacement"; atIndex: number; as: "throw" | "event"; }
export function makeScriptedTwoPhaseUpstream(opts: { errorInject?: ErrorInject } = {}) {
  // primaryQueue / replacementQueue + separate signals; 1st call = primary (throws on its signal abort),
  // 2nd call = replacement (records options, own fresh signal). errorInject, when set, throws at atIndex
  // (as:"throw") or pushes an `error` event at atIndex (as:"event"). Mirrors makeTwoPhaseUpstream exactly,
  // but with the injection seam for chaos. Returns { fn, calls, pushPrimary, pushReplacement, closePrimary }.
  // …(see tests/stream-proxy-failure-modes.test.ts makeTwoPhaseUpstream for the iterator body to copy)…
}

// ── INV counting (the heart of the property/chaos suites). isTerminalEvent matches done|error.
export function countInvariants(
  collected: AssistantMessageEvent[],
  diag: { events: { event: string }[] },
  proxy: StreamProxy,
  accepted: { acceptedCount: number },
): InvariantReport {
  return {
    downstreamDrained: true,                              // collectOutput returned ⇒ drained (INV-001)
    startCount: collected.filter((e) => e.type === "start").length,                 // INV-002
    terminalCount: collected.filter(isTerminalEvent).length,                        // INV-003
    resultResolved: true,                                  // set by collectOutput racing output.result()
    interruptionCount:
      accepted.acceptedCount +
      diag.events.filter((c) => c.event === "proxy.replacement.first-event").length, // INV-004
    finalAuthority: proxy.authority,                                                // INV-005
    cleanupCount: diag.events.filter((c) => c.event === "proxy.lifecycle.cleanup").length, // INV-010
    finalState: proxy.controller.getState(),
  };
}
export function assertInvariants(r: InvariantReport, o: { allowInterruption: boolean }) {
  expect(r.downstreamDrained).toBe(true);                 // INV-001
  expect(r.startCount).toBe(1);                           // INV-002
  expect(r.terminalCount).toBe(1);                        // INV-003 (one message_end)
  expect(r.resultResolved).toBe(true);                    // INV-003 (result resolves once)
  if (o.allowInterruption) expect(r.interruptionCount).toBeLessThanOrEqual(1);       // INV-004
  else expect(r.interruptionCount).toBe(0);
  expect(r.finalAuthority === "forwarding" || r.finalAuthority === "splicing").toBe(true); // INV-005
  expect(r.cleanupCount).toBe(1);                         // INV-010
  expect(r.finalState).toBe("Idle");                      // post-terminal FSM
}
```

```typescript
// ── A representative property case (Task 2). The drive loop is the canonical interruption pattern.
test(`seed=${seed} holds the streaming invariants`, async () => {
  const rng = mulberry32(seed);
  const thinkingN = ri(rng, 1, 8), replN = ri(rng, 1, 5);
  const { diag } = makeCaptureDiag();
  const controller = new TransitionController(diag);
  const buffer = new ReasoningBuffer(diag, DEFAULT_CONFIG.maximumReasoningBufferBytes);
  const mock = makeScriptedTwoPhaseUpstream();
  const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag,
    controller, buffer, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000);
  const consumer = collectOutput(proxy);                 // drain concurrently (fire-and-forget start)
  mock.pushPrimary(ev({ type: "start" }));
  mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
  for (let i = 0; i < thinkingN; i++) mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "t" }));
  await waitFor(() => proxy.isReasoning());
  const accepted = proxy.triggerStop();                  // ≤1 true per response (INV-004)
  await waitFor(() => mock.calls.length === 1, 500);     // replacement launched
  mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
  for (let i = 0; i < replN; i++) mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "a" }));
  mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
  const collected = await consumer;
  const report = countInvariants(collected, diag, proxy, { acceptedCount: accepted ? 1 : 0 });
  assertInvariants(report, { allowInterruption: true });
});
```

```typescript
// ── The memory check (Task 3). BOUNDED, not zero; force GC between batches.
test("1000 interrupted cycles: bounded heap growth, no monotonic leak", async () => {
  const runBatch = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const { diag } = makeCaptureDiag();
      const mock = makeScriptedTwoPhaseUpstream();
      const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag,
        new TransitionController(diag), new ReasoningBuffer(diag, 1_000_000),
        DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000);
      const consumer = collectOutput(proxy);
      mock.pushPrimary(ev({ type: "start" }));
      mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));   // Delegating→Reasoning
      mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
      await waitFor(() => proxy.isReasoning(), 200);
      proxy.triggerStop();
      await waitFor(() => mock.calls.length === 1, 200);
      mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
      await consumer;                                     // fully drained → GC-eligible (INV-010 cleanup ran)
    }
  };
  await runBatch(100); Bun.gc(true);                      // warm-up (JIT + allocator)
  Bun.gc(true); const h0 = process.memoryUsage().heapUsed;
  await runBatch(1000); Bun.gc(true); const h1 = process.memoryUsage().heapUsed;
  await runBatch(1000); Bun.gc(true); const h2 = process.memoryUsage().heapUsed;
  expect(h1 - h0).toBeLessThan(8_000_000);                // tolerant bound (GC isn't deterministic)
  expect(h2 - h1).toBeLessThanOrEqual((h1 - h0) + 2_000_000); // 2nd batch does NOT outgrow the 1st ⇒ no leak
}, 30000);
```

```typescript
// ── The rapid-press idempotency (Task 3). 100 presses, exactly one accepted (INV-004 + EC-009/010).
test("100× coordinator.requestStop() in ≤100ms → exactly ONE accepted + single terminal", async () => {
  const { diag } = makeCaptureDiag();
  const coordinator = new TransitionCoordinator(diag);
  const mock = makeScriptedTwoPhaseUpstream();
  const proxy = new StreamProxy(makeModel(), {} as never, {} as never, mock.fn, diag,
    new TransitionController(diag), new ReasoningBuffer(diag, 1_000_000),
    DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000, coordinator);
  coordinator.setActiveProxy(proxy);
  const consumer = collectOutput(proxy);
  mock.pushPrimary(ev({ type: "start" }));
  mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
  mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
  await waitFor(() => proxy.isReasoning());
  const t0 = Date.now(); let accepted = 0;
  for (let i = 0; i < 100; i++) if (coordinator.requestStop()) accepted++;   // 100 presses, tight loop
  const elapsed = Date.now() - t0;
  expect(accepted).toBe(1);                               // INV-004: at most one interruption
  expect(elapsed).toBeLessThan(100);                      // 100 presses within 100ms
  await waitFor(() => mock.calls.length === 1, 500);
  mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
  const collected = await consumer;
  expect(collected.filter(isTerminalEvent)).toHaveLength(1);  // single terminal despite 100 presses
});
```

### Integration Points

```yaml
BUILD:
  - entries touched: NONE. tsconfig exclude:["tests"] → the new files NEVER hit `npx bun run build`.
    `npx bun run build` (tsc) is unaffected → exit 0 regardless of the new tests.
TYPECHECK:
  - `npx bun run typecheck` (tsc --noEmit) checks src ONLY → the new test files are NOT type-checked by it.
    Type errors in the new files surface only at `npx bun test` time. Type carefully.

TEST DISCOVERY:
  - `npx bun test` globs every *.test.ts → the 4 new files run automatically (no config change). The helper
    tests/helpers/invariant-harness.ts is NOT *.test.ts → not executed directly (imported by the 4 suites).

NO CHANGES TO: package.json, tsconfig.json, .gitignore, any src/* file, any existing tests/* file.
  (Parallel-safe: P1.M8.T3.S1 edits decorator.ts/index.ts + decorator/factory tests + lifecycle.test.ts;
   this task adds only NEW files → ZERO file overlap. The repeated-init stress uses the 3-arg decorator ctor.)
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Build is UNAFFECTED by test-only additions, but confirm it still compiles src cleanly:
npx bun run build            # = tsc → exit 0 (dist/ refreshed; new tests excluded by tsconfig)
# Expected: exit 0. (If it fails, a pre-existing src issue — NOT this task — investigate separately.)

# NOTE: `npx bun run typecheck` (tsc --noEmit) checks src ONLY — it will NOT catch type errors in the new
# test files. Catch those via Level 2 instead.
```
> `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`.

### Level 2: Unit Tests (the new suites, run in isolation first)

```bash
# Run the 4 new files first to localize any harness/type/timing issue:
npx bun test tests/property-tests.test.ts tests/stress-tests.test.ts \
               tests/chaos-tests.test.ts tests/regression-tests.test.ts
# Expected: ALL green. Property ≥50 seeds + dedicated; stress (1000-cycle, 1MB, 100-press, repeated-init);
#   chaos ≥30 seeds + targeted edges; regression (existing + new fixtures, byte-identical).

# Then the FULL suite (must not regress any of the 223 pre-existing cases):
npx bun test
# Expected: every test passes; total > 100 new cases added on top of the 223 baseline.
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.
> If a per-seed case fails, the test name prints `seed=N` → re-run `mulberry32(N)` to reproduce exactly.

### Level 3: Integration (sanity — the suites ARE the integration)

```bash
# The property/stress/chaos suites already exercise the full StreamProxy transition pipeline end-to-end
# (detection → abort → freeze → replacement launch → splice → completion). No separate integration step.

# Optional: confirm a failing seed is reproducible (pick a seed, run it in isolation):
npx bun test tests/property-tests.test.ts -t "seed=7 "
# Expected: that one case runs in isolation (bun's -t filters by name substring).
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Scope gate — this task adds ONLY new files under tests/ (NO src/ diff, NO edits to existing files):
git status --short
# Expected: 5 NEW files — tests/helpers/invariant-harness.ts, tests/{property,stress,chaos,regression}-tests.test.ts.
#   ZERO modified files (no src/, no package.json, no existing test).

git diff --stat HEAD -- src/
# Expected: (empty) — no source changes.

# Count gate — the new suite exceeds 100 cases:
npx bun test tests/property-tests.test.ts tests/stress-tests.test.ts tests/chaos-tests.test.ts \
               tests/regression-tests.test.ts 2>&1 | grep -E "tests pass|passed|fail" | tail -3
# Expected: >100 new passing cases.

# Reproducibility gate — a property/chaos case is fully determined by its seed (no Math.random in the
# harness; mulberry32 only):
grep -rn "Math.random()" tests/helpers/invariant-harness.ts tests/property-tests.test.ts \
                        tests/chaos-tests.test.ts
# Expected: no matches (all randomness flows through mulberry32(rng)). (Math.random in stress is fine ONLY
#   if it doesn't affect invariant assertions — prefer mulberry32 everywhere for determinism.)

# Privacy gate — chaos/property cases assert only allow-listed diagnostic fields (no content/options/keys):
grep -n "ALLOWED_KEYS\|assertPrivacy" tests/chaos-tests.test.ts tests/property-tests.test.ts
# Expected: the privacy asserter is imported + applied in the suites.

# No-T3-coupling gate — the repeated-init stress uses the 3-arg decorator ctor (omits T3's 4th param):
grep -n "new ProviderDecorator" tests/stress-tests.test.ts
# Expected: the call passes exactly 3 args (config, diag, registry) — NOT the 4th disabledProvider callback.

# No-edit gate — existing golden fixtures untouched (append-only contract):
git diff --stat HEAD -- tests/golden/fixtures.ts tests/golden/replay.ts
# Expected: (empty) — new regression fixtures are defined INLINE in regression-tests.test.ts, not appended
#   to fixtures.ts. (Keeps the diff to NEW files only.)
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run build` → exit 0 (src unaffected by test-only additions).
- [ ] `npx bun test tests/{property,stress,chaos,regression}-tests.test.ts` → ALL green.
- [ ] `npx bun test` → ALL green (223 pre-existing + >100 new; no regression).
- [ ] A per-seed failure is reproducible from its printed seed (`-t "seed=N"`).

### Feature Validation
- [ ] Property: ≥50 randomized seeds each hold INV-001/002/003/004/005/010 + ≥3 dedicated invariant tests.
- [ ] Stress: 1000-cycle bounded-heap (no monotonic leak via `Bun.gc(true)`); 1MB+ buffers (+ overflow warn);
      100 rapid presses → exactly one accepted + single terminal; repeated-init ×100 → no orphan.
- [ ] Chaos: ≥30 seeds of random error injection → single terminal + resolved result + Idle + one cleanup +
      privacy-safe diagnostics; + ≥4 targeted edge injections.
- [ ] Regression: every golden fixture (existing 3 + ≥3 new) replays byte-identical through the full proxy
      + the decorator-shape full-ctor case + invariants-hold-when-inactive.

### Code Quality Validation
- [ ] Shared harness (`tests/helpers/invariant-harness.ts`) — no duplication of the two-phase mock across
      the 4 suites; the doubles are copied VERBATIM from the failure-modes tests (consistency).
- [ ] File naming is kebab-case (matches all 21 sibling test files); the helper is NOT `*.test.ts`.
- [ ] All randomness flows through `mulberry32` (deterministic); `Math.random()` absent from the harness.
- [ ] Privacy asserter applied in property + chaos suites (Appendix H — no content/options/keys logged).
- [ ] ZERO edits to src/, package.json, tsconfig.json, .gitignore, or any existing file (parallel-safe).

### Documentation & Deployment
- [ ] Each per-seed test name includes the seed (reproducibility for future maintainers).
- [ ] The harness file has a module banner documenting its role + the INV→assertion table reference.
- [ ] (README/docs are P1.M8.T5 — NOT edited here.)

---

## Anti-Patterns to Avoid

- ❌ Don't edit ANY `src/` file or existing test — this is a TEST-ONLY work item. The 4 suites + 1 helper are
  all NEW files. The repeated-init stress uses the decorator's 3-arg ctor so it's stable regardless of T3.
- ❌ Don't add `fast-check` (or any new dependency). Use the seeded `mulberry32` PRNG — deterministic failures
  are strictly better for CI, and the repo is hand-rolled. Print the seed in every generated test name.
- ❌ Don't assert memory `before === after`. GC isn't deterministic. Assert BOUNDED growth + that a 2nd batch
  doesn't outgrow the 1st (no monotonic leak). Force `Bun.gc(true)` between measurements.
- ❌ Don't forget to queue a replacement terminal on interrupted cases — the proxy leaves `output` OPEN during
  the transition (the replacement owns the terminal). A missing terminal hangs `collectOutput`; the `waitFor`
  timeout surfaces it, but design every interrupted case to push a replacement `done`/`error`.
- ❌ Don't look for a public `.done` flag on `AssistantMessageEventStream` (it's private). Assert INV-003 by
  counting terminals in the drained `collected[]` + `await output.result()` resolving (race a timeout).
- ❌ Don't mutate the existing golden fixtures (`NORMAL_REPLAY`/`NO_REASONING_REPLAY`/`ERROR_REPLAY`) — they're
  append-only. Define NEW regression fixtures INLINE in `regression-tests.test.ts`.
- ❌ Don't couple any test to P1.M8.T3.S1's disable flag — keep the suite T3-independent (3-arg decorator ctor).
- ❌ Don't use the global pi-ai registry in the repeated-init test — inject a fake registry (DI), exactly as
  `tests/provider-decorator.test.ts` does. Real-registry proof is T3's Level-3 concern.
- ❌ Don't skip the privacy assertions in chaos/property — Appendix H forbids logging content/options/keys;
  every injected-fault case must assert only allow-listed diagnostic fields.
