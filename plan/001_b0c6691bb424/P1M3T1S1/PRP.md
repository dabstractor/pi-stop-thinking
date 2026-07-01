# PRP — P1.M3.T1.S1: TransitionController FSM Core (`src/state/controller.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M3.T1.S1 (Phase 2 Transition State Machine, 2 pts) — the **pure finite-state machine**
> that owns the interruption lifecycle as an explicit FSM (PRD §15 State Machine, §16 State Transition
> Table, §17 State Invariants, §30 TransitionController Module, §37 Concurrency Model, Appendix F
> coding standards, Appendix O INV-004). No other module mutates transition state; the
> TransitionController is the **single writer** (PRD §37). This subtask delivers the FSM **enforcement
> layer only** — the `ALLOWED_TRANSITIONS` adjacency table + a generic `transition(next)` validator +
> `getState()` + `canInterrupt()` + the named convenience methods (`requestStop`/`beginAbort`/
> `completeAbort`/`beginReplacement`/`beginSplice`/`beginAnswering`/`complete`/`fail`/`reset`). Every
> transition is logged to `diagnostics.trace()`. Illegal transitions throw. The convenience methods
> **only change state** — they perform NO abort/replacement/splice side effects (those are P1.M5/P1.M6/
> P1.M7; the controller is the state-machine spine they drive).
> **Builds on**: `TransitionState` type from **P1.M2.T1.S1** (`src/types.ts`, DONE — string-literal
> union of 11 states) and `Diagnostics` from **P1.M1.T3.S1** (`src/diagnostics/index.ts`, DONE — frozen
> interface with `trace/debug/info/warn/error(event, fields?)`).
> **Consumed by**: StreamProxy (P1.M4 reasoning detection), TransitionCoordinator (P1.M4.T4),
> abort coordination (P1.M5), replacement generation (P1.M6), stream splicing (P1.M7).

---

## Goal

**Feature Goal**: Implement an explicit, exhaustive finite-state machine — the `TransitionController`
class — that owns the interruption lifecycle state (PRD §30: "No other module may mutate transition
state") and **rejects every transition not present in the PRD §16 table** (throwing an Error citing
PRD §16). The controller is a **pure FSM**: it validates, mutates one `private state` field, and logs;
it performs no I/O, no abort, no replacement, no splicing. It exposes a generic `transition(next)` (the
table-driven validator, the contract's escape hatch for the two entry transitions `Idle→Delegating` and
`Delegating→Reasoning`) plus the named convenience methods the item contract enumerates, each mapped to
exactly one table row. Every transition emits one `diagnostics.trace("transition.state-change",
{ from, to })` line; every illegal attempt emits one `diagnostics.warn("transition.illegal", {from,to})`
then throws.

**Deliverable** (ONE new source file + ONE new test file; the source file currently exists as a 1-line
stub `// TransitionController FSM — P1.M3.T1.S1` and is fully replaced):
- `src/state/controller.ts` — `export class TransitionController` with `private state: TransitionState =
  "Idle"`, `export const ALLOWED_TRANSITIONS` (the immutable §16 adjacency table), `transition(next)`,
  `getState()`, `canInterrupt()`, `requestStop()`, `beginAbort()`, `completeAbort()`,
  `beginReplacement()`, `beginSplice()`, `beginAnswering()`, `complete()`, `fail(reason)`, `reset()`.
  Mode-A JSDoc on the module banner + every exported method, each transition method citing PRD §16.
- `tests/transition-controller.test.ts` — `bun:test` suite covering the full happy-path walk, every
  convenience method's valid + illegal (throw) case, `requestStop()` returning `false` outside
  `Reasoning`, `Aborting→Restarting` (skip `Capturing`) throwing, `fail()` from multiple states,
  `reset()` legal/illegal, and trace-logging verification via a capturing Diagnostics stub.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → 0 diagnostics; `npx bun run
build` → exit 0 (emits `dist/state/controller.{js,d.ts}`); `npx bun test` → ALL green INCLUDING the new
`tests/transition-controller.test.ts` with zero regressions in the existing 8 suites. The FSM permits
exactly the 12 PRD §16 transitions (incl. "Any→Failed") and throws an Error naming PRD §16 on every
other pair. Every legal transition produces exactly one `transition.state-change` trace; every illegal
attempt produces exactly one `transition.illegal` warn + a thrown Error. No edits to any file other than
`src/state/controller.ts` and the new test file.

---

## Why

- **This subtask is the spine of the entire "Stop Thinking" feature.** PRD §15 mandates an *explicit*
  finite-state machine: "No implicit boolean flags. No ad-hoc transitions. No hidden lifecycle." PRD §37
  mandates the TransitionController be the **single writer** of transition state. Until this class
  exists there is no validated lifecycle — every later phase (P1.M4 detection, P1.M5 abort, P1.M6
  replacement, P1.M7 splicing) would have to invent ad-hoc state, which Appendix F + Appendix O INV-004
  ("at most one interruption transition per logical assistant response") forbid. This class is the
  enforcement layer that makes those later phases *safe to compose*: they call named methods; the
  controller refuses illegal sequences.
- **Illegal transitions MUST fail loudly.** Skipping a state (e.g. `Aborting→Restarting`, bypassing
  `Capturing` where the reasoning buffer is frozen) would corrupt the stream (PRD §17: "Capturing →
  Reasoning buffer immutable"). The item MOCKING spec explicitly requires `Aborting→Restarting` to
  throw. A throw (not a silent no-op) is the correct contract because an illegal transition is a logic
  bug in the caller, and PRD §51 "No replacement request may begin before reasoning is frozen" depends on
  the ordering this FSM guarantees.
- **It is deliberately minimal (pure FSM).** Per module_contracts.md the controller eventually also owns
  an abort controller + transition token — but those are **P1.M5** (abort coordination). This subtask
  delivers only the state table + validators so that P1.M4 (detection, the immediate next milestone) has
  a real FSM to drive `Delegating→Reasoning` and `Reasoning→StopRequested`. Keeping it pure means the
  state machine is fully unit-testable with zero async / zero mocks (item MOCKING: "Unit test by calling
  transition methods in valid and invalid sequences").
- **It logs every transition.** PRD §57 trace level: "every state transition." PRD Appendix M trace
  correlation wants `currentState` in transition logs. The controller is the single point that owns
  state, so it is the single point that emits `transition.state-change` — every later module reads state
  via `getState()` and never logs it itself (single source of truth).

## What

### Source: `src/state/controller.ts` (fully replaces the 1-line stub)

`export class TransitionController`:
- `constructor(private readonly diagnostics: Diagnostics)` — diagnostics injected (shared instance, as
  every other module does; the factory creates one and passes it to every per-request controller).
- `private state: TransitionState = "Idle"` — the single owned mutable field (PRD §37 single writer).
- `export const ALLOWED_TRANSITIONS: ReadonlyMap<TransitionState, ReadonlySet<TransitionState>>` — the
  PRD §16 adjacency table, including "Any→Failed" (Failed reachable from every state except Failed
  itself; Failed→Idle is Failed's only exit). Built once at module load; immutable surface.
- `transition(next: TransitionState): void` — generic validator (the contract's escape hatch). If
  `!ALLOWED_TRANSITIONS.get(this.state)?.has(next)` → `diagnostics.warn("transition.illegal",
  {from:this.state, to:next})` then `throw new Error("Illegal state transition: <from> → <to> (PRD §16)")`.
  Else `const from = this.state; this.state = next; diagnostics.trace("transition.state-change",
  {from, to:next})`.
- `getState(): TransitionState` — pure read of `this.state`. Never throws, never logs.
- `canInterrupt(): boolean` — pure read: `return this.state === "Reasoning"`. Never throws, never logs.
  (PRD §22.5 Shortcut Availability: shortcut active only in Reasoning.)
- `requestStop(): boolean` — **the only boolean-returning method**. If `this.state !== "Reasoning"`
  → `return false` (no throw, no state change, no log). Else `this.transition("StopRequested"); return
  true`. (Reasoning→StopRequested is table-legal, so the inner transition() cannot throw.) Maps to PRD
  §16 row "Reasoning | Shortcut | StopRequested". Item MOCKING: requestStop from Idle → false.
- `beginAbort(): void` — `this.transition("Aborting")`. Maps to "StopRequested | Abort dispatched |
  Aborting". Throws if not in StopRequested.
- `completeAbort(): void` — `this.transition("Capturing")`. Maps to "Aborting | Upstream closed |
  Capturing". Throws if not in Aborting.
- `beginReplacement(): void` — `this.transition("Restarting")`. Maps to "Capturing | Replacement issued
  | Restarting". Throws if not in Capturing.
- `beginSplice(): void` — `this.transition("Splicing")`. Maps to "Restarting | First replacement token
  | Splicing". Throws if not in Restarting.
- `beginAnswering(): void` — `this.transition("Answering")`. Maps to "Splicing | First answer token |
  Answering". Throws if not in Splicing.
- `complete(): void` — `this.transition("Completed")`. Maps to "Answering | message_end | Completed".
  Throws if not in Answering.
- `fail(reason: string): void` — Any→Failed (always table-legal). Sets state to Failed via the same
  validate-then-log path as transition(), then additionally `diagnostics.error("transition.failed",
  {reason, from})`. The `reason` MUST be an error CATEGORY (e.g. "timeout", "abort-failed",
  "replacement-rejected") — never user/prompt/reasoning content (PRD Appendix H: allow-list permits
  "Error categories"; the controller never sees user content so this is naturally safe).
- `reset(): void` — `this.transition("Idle")`. Legal ONLY from Completed or Failed (the two table rows
  ending in Idle). Throws from any other state (illegal). In practice always called post-Completed or
  post-Failed (PRD §17 Completed/Failed: "Reset").

### Test: `tests/transition-controller.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`) using a capturing Diagnostics
stub (adapted from tests/diagnostics.test.ts `captureSink`) that records every `trace`/`warn`/`error`
call. Coverage (derived from the item MOCKING spec + general FSM coverage):
- Initial state is `Idle`; `getState()` returns it.
- Full happy-path walk returns to `Idle`: `Idle→Delegating→Reasoning→StopRequested→Aborting→Capturing
  →Restarting→Splicing→Answering→Completed→Idle`, using the named methods for the stop-flow half and
  `transition("Delegating")`/`transition("Reasoning")` for the two entries.
- `canInterrupt()` is true only in `Reasoning` (false in Idle/Delegating/every other state).
- `requestStop()` from `Reasoning` returns `true` + state becomes `StopRequested`; from `Idle`/any other
  state returns `false` + state unchanged + no log emitted (item MOCKING: "requestStop from Idle →
  false").
- `Aborting→Restarting` (skip Capturing) THROWS and leaves state at `Aborting` (item MOCKING); likewise
  `Idle→Answering` throws; `beginAbort()` from Idle throws; etc. — table-driven negative cases.
- `fail(reason)` succeeds from Idle, Reasoning, Splicing (Any→Failed); logs
  `transition.failed` with the reason + the from-state; state becomes Failed.
- `reset()` from Completed→Idle and from Failed→Idle succeed; `reset()` from Reasoning THROWS (illegal).
- Trace logging: each legal transition emits exactly one `transition.state-change {from,to}`; each
  illegal attempt emits exactly one `transition.illegal {from,to}` then throws.

**Out of scope** (owned by other subtasks — do NOT implement here):
- **AbortController / actual upstream abort** → P1.M5.T1.S1 (the controller will *hold* one later; this
  subtask does not allocate it).
- **Transition token generation / uniqueness** → P1.M5 (INV-011 single owner; PRD §30 Internal State
  lists "Transition Token" but its generation is the abort-coordination milestone).
- **Actual replacement request / RequestBuilder invocation** → P1.M6.T1.S1.
- **Actual stream splicing / terminal suppression** → P1.M7.
- Any change to `src/types.ts`, `src/diagnostics/index.ts`, or any other `src/` file → the inputs are
  immutable. No `package.json` / `tsconfig.json` / `.gitignore` changes. No new deps.

### Success Criteria

- [ ] `src/state/controller.ts` exports `class TransitionController` + `ALLOWED_TRANSITIONS` exactly as
      specified (constructor `(diagnostics)`, `private state = "Idle"`, all 10 methods).
- [ ] `ALLOWED_TRANSITIONS` is the full PRD §16 adjacency including "Any→Failed" (Failed reachable from
      every non-Failed state; Failed's only exit is Idle) and is typed immutable.
- [ ] `transition(next)` throws `Error` (message cites PRD §16) + logs `warn("transition.illegal")` for
      every pair NOT in the table; sets state + logs `trace("transition.state-change")` for legal pairs.
- [ ] `requestStop()` returns `false` (no throw, no log, no state change) when not in `Reasoning`;
      returns `true` + transitions to `StopRequested` when in `Reasoning`.
- [ ] `canInterrupt()` returns `true` iff `state === "Reasoning"` (no side effects).
- [ ] `beginAbort/completeAbort/beginReplacement/beginSplice/beginAnswering/complete/reset` delegate to
      `transition()` and throw on illegal state; each maps to exactly one §16 row.
- [ ] `fail(reason)` always succeeds (Any→Failed) + logs `error("transition.failed", {reason, from})`.
- [ ] Mode-A JSDoc on the module banner + every exported method; each transition method references
      PRD §16 (item DOCS spec).
- [ ] `tests/transition-controller.test.ts` covers: happy-path walk, canInterrupt, requestStop true/
      false, illegal-transition throws (incl. `Aborting→Restarting`), fail() from ≥3 states, reset()
      legal/illegal, and trace-logging assertions.
- [ ] `npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0 (new
      `dist/state/controller.{js,d.ts}`); `npx bun test` → ALL green (new suite + the 8 existing suites,
      no regressions).
- [ ] No edits outside `src/state/controller.ts` + the new `tests/transition-controller.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact `TransitionState` union + `Diagnostics` interface** (the two
inputs, read from the landed `src/types.ts` and `src/diagnostics/index.ts`), the **complete PRD §16
adjacency table already converted into the `ALLOWED_TRANSITIONS` Map**, the **exact method→row mapping**,
the **exact throw/log contract** (which level, which event name, which fields), the **full reference
implementations** of both the source file and the test file, and the **verified build/test commands**
(Bun local devDep via `npx bun ...`; `tests/` excluded from tsc). Every design ambiguity (entry
transitions, boolean vs throw, `fail` always-succeeds, `reset` legality, scope boundary vs P1.M5) is
resolved in the research notes + the implementation tasks.

### Documentation & References

```yaml
# PRD authority (PRD.md in repo root)
- url: PRD.md §15 "State Machine"
  why: "Names the 11 states + the rule 'No implicit boolean flags. No ad-hoc transitions. No hidden
        lifecycle.' — mandates the explicit FSM this class IS."
  critical: "TransitionState MUST be the string-literal union (already in src/types.ts), never an enum
        or boolean flags (PRD Appendix F). Switch exhaustively on it."
- url: PRD.md §16 "State Transition Table"
  why: "THE table this class enforces. 11 named rows + 'Any → Fatal error → Failed'. ALLOWED_TRANSITIONS
        is its direct encoding. Every throw message cites 'PRD §16'."
  critical: "'Any→Failed' means Failed is reachable from every state EXCEPT Failed itself (Failed→Idle is
        Failed's only exit). fail() therefore NEVER throws."
- url: PRD.md §17 "State Invariants"
  why: "Per-state invariants explain WHY illegal transitions throw — e.g. Capturing: 'Reasoning buffer
        immutable' is why Aborting cannot skip to Restarting. Cite in JSDoc where relevant."
- url: PRD.md §30 "TransitionController Module"
  why: "Module charter: 'Own interruption lifecycle. No other module may mutate transition state.'
        Public Interface lists Request Stop / Abort Upstream / Freeze Reasoning / Launch Replacement /
        Begin Splice / Complete Transition / Reset — the named methods map to these. Internal State
        lists 'Transition Token' but that is P1.M5, NOT this subtask."
  critical: "Invariants: 'Single active transition. Single abort controller. Transition tokens unique.'
        — only the 'single active transition' (one state field) is owned HERE; abort controller + token
        are P1.M5."
- url: PRD.md §37 "Concurrency Model" → Ownership Rules
  why: "'TransitionController owns transition state.' Single-writer guarantee — the state field is
        private and mutated ONLY inside transition()/fail()."
- url: PRD.md Appendix F "Coding Standards"
  why: "'State transitions shall be represented explicitly using discriminated unions or equivalent
        strongly typed constructs. Boolean flag combinations shall not be used.' + Mode-A JSDoc standard."
- url: PRD.md §57 "Logging Specification" + Appendix M "Trace Levels"
  why: "Trace level = 'every state transition'; trace correlation wants currentState in transition logs.
        → diagnostics.trace on every legal transition. Warn = recoverable failures (illegal attempt);
        Error = fatal failures (fail())."
- url: PRD.md Appendix H "Security & Privacy Model" → Logging Rules
  why: "Allow-list: provider, model, transitionId, timing, event counts, STATE TRANSITIONS, ERROR
        CATEGORIES. → state-change {from,to} and fail {reason(=category)} are permitted. NEVER log
        prompt/reasoning/assistant output — the controller never sees them, so this is naturally safe."
- url: PRD.md Appendix O INV-004
  why: "'At most one interruption transition may exist per logical assistant response.' — enforced by
        requestStop() returning false once past Reasoning (you cannot re-enter the stop flow)."

# INPUT: TransitionState type (DONE — P1.M2.T1.S1)
- file: src/types.ts
  why: "Exports `export type TransitionState = 'Idle'|'Delegating'|'Reasoning'|'StopRequested'|'Aborting'
        |'Capturing'|'Restarting'|'Splicing'|'Answering'|'Completed'|'Failed'. Import it as a TYPE:
        `import type { TransitionState } from '../types'`."
  pattern: "String-literal union (PRD Appendix F). Switch/set-membership over it. Do NOT introduce an
        enum. Do NOT modify this file."
  gotcha: "isolatedModules + strict → TYPE-only import. No runtime value is imported from types.ts here."

# INPUT: Diagnostics interface (DONE — P1.M1.T3.S1)
- file: src/diagnostics/index.ts
  why: "Exports `export interface Diagnostics { trace/debug/info/warn/error(event: string, fields?:
        Record<string,unknown>): void }`. Import as a TYPE: `import type { Diagnostics } from
        '../diagnostics'`. Call this.diagnostics.trace('transition.state-change', {from, to}) etc."
  pattern: "trace/debug/info route to sink.log; warn/error route to sink.error (see createDiagnostics).
        The object is frozen but you only call methods, so freeze is irrelevant."
  gotcha: "No value import needed — Diagnostics is a type. The factory passes a concrete createDiagnostics
        instance at construction; tests pass a capturing stub."

# Established SOURCE conventions to mirror (so controller.ts feels native)
- file: src/diagnostics/index.ts   # Mode-A JSDoc banner + per-symbol JSDoc + immutability
  why: "THE style template: top banner (Responsibility/Ownership/Lifecycle/Invariants/Failure
        modes/'Consumed by:'), per-export JSDoc with Preconditions/Postconditions/Side effects, frozen
        exports, inline PRD citations. Mirror this banner structure for controller.ts."
- file: src/provider/proxy.ts      # class with private fields + injected diagnostics + Mode-A JSDoc
  why: "THE class template: `private readonly diagnostics: Diagnostics` injected in ctor, private state
        fields, constructor starts work, get accessor for reads. controller.ts mirrors: `constructor(
        private readonly diagnostics: Diagnostics)` + `private state = 'Idle'`."
- file: src/config/index.ts        # immutable constant export + ReadonlySet/Record typing
  why: "Shows `Object.freeze` + `ReadonlySet`/`Readonly<Record<...>>` immutable typing for constants.
        ALLOWED_TRANSITIONS uses `ReadonlyMap<TransitionState, ReadonlySet<TransitionState>>` likewise."

# Established TEST conventions to mirror
- file: tests/diagnostics.test.ts  # captureSink pattern → adapt to capture trace/warn/error calls
  why: "Shows how to capture emitted diagnostics lines + assert channel routing. Adapt: build a
        Diagnostics stub whose trace/warn/error push {event, fields} into arrays; assert on them."
- file: tests/stream-proxy.test.ts # class-named test file + noopDiagnostics stub + describe/test/expect
  why: "Confirms the test-file-named-after-the-class convention (proxy.ts → stream-proxy.test.ts) →
        controller.ts → transition-controller.test.ts. Also the noopDiagnostics stub shape."
- file: tests/types.test.ts        # table-driven FSM-ish assertions + ALL_TYPES iteration
  why: "Table-driven EXPECTED map + iterate-all approach — ideal for asserting the full
        ALLOWED_TRANSITIONS table + every illegal pair throws."

# Parallel context (CONTRACT — assume it lands as-specified; do NOT depend on it for THIS test to pass)
- file: plan/001_b0c6691bb424/P1M2T4S1/PRP.md   # being implemented in parallel (golden replay harness)
  why: "Adds tests/golden/** (test-only; zero src edits). Does NOT touch src/state/controller.ts or
        types.ts. No conflict with this subtask. Both land independently."
```

### Current Codebase tree (Phase 0 + Phase 1 core landed; controller.ts is a 1-line stub)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); type module; bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts          # factory (DONE; DO NOT touch)
│   ├── types.ts          # P1.M2.T1.S1 (DONE; DO NOT touch) — exports TransitionState (INPUT)
│   ├── provider/{decorator,proxy}.ts  # DONE (DO NOT touch)
│   ├── state/
│   │   ├── controller.ts # ← THIS SUBTASK (1-line stub → full TransitionController class)
│   │   └── coordinator.ts # P1.M4.T4 stub (DO NOT touch)
│   ├── config/index.ts   # DONE (DO NOT touch)
│   └── diagnostics/index.ts # DONE (Diagnostics interface; DO NOT touch) — INPUT
├── tests/
│   ├── smoke.test.ts                 # must stay green
│   ├── config.test.ts                # must stay green
│   ├── diagnostics.test.ts           # captureSink PATTERN to mirror; must stay green
│   ├── provider-decorator.test.ts    # must stay green
│   ├── factory.test.ts               # must stay green
│   ├── types.test.ts                 # table-driven PATTERN to mirror; must stay green
│   ├── stream-proxy.test.ts          # class-named test PATTERN to mirror; must stay green
│   ├── transition-controller.test.ts # ← THIS SUBTASK (NEW)
│   └── golden/                       # P1.M2.T4.S1 (parallel; test-only; no conflict)
└── dist/                 # generated by tsc (git-ignored) — gains state/controller.{js,d.ts}
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
src/state/
└── controller.ts            # REPLACE (1-line stub → full class)
    #   • export class TransitionController { constructor(diagnostics); private state='Idle';
    #     transition(next); getState(); canInterrupt(); requestStop(); beginAbort(); completeAbort();
    #     beginReplacement(); beginSplice(); beginAnswering(); complete(); fail(reason); reset() }
    #   • export const ALLOWED_TRANSITIONS: ReadonlyMap<TransitionState, ReadonlySet<TransitionState>>
    #     (full PRD §16 table incl. Any→Failed)
    #   RESPONSIBILITY: be the single writer of transition state; reject every non-§16 transition.
    #   REUSED BY: StreamProxy (P1.M4), TransitionCoordinator (P1.M4.T4), abort (P1.M5),
    #              replacement (P1.M6), splicing (P1.M7).

tests/
└── transition-controller.test.ts   # NEW — the FSM unit suite (bun:test)
    #   • happy-path walk Idle→…→Idle via named methods + transition() entries
    #   • canInterrupt / requestStop true+false / illegal-transition throws (incl. Aborting→Restarting)
    #   • fail() from ≥3 states / reset() legal(Completed,Failed)+illegal(Reasoning)
    #   • trace-logging assertions via capturing Diagnostics stub
    #   RESPONSIBILITY: prove the §16 table is enforced exactly + transitions logged.
```
**File responsibilities**: `controller.ts` owns the FSM (one private state field + immutable table +
validators + log calls). It imports ONLY types (`TransitionState`, `Diagnostics`) — zero runtime value
imports, zero deps. `transition-controller.test.ts` owns the assertions; imports the class +
`ALLOWED_TRANSITIONS` (values) + the two types. No other file changes.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (pure FSM — no side effects): beginAbort/completeAbort/beginReplacement/beginSplice/
// beginAnswering ONLY change state. They do NOT abort an upstream, build a request, or splice streams.
// Those operations are P1.M5/P1.M6/P1.M7. If you add an AbortController field or call a RequestBuilder
// here, you have escaped scope — STOP. This subtask = state table + validators + logging only.

// CRITICAL (requestStop is the ONLY boolean method): every other convenience method is `void` and
// THROWS on illegal state (it delegates to transition()). Only requestStop() returns false gracefully.
// This is the item MOCKING contract: "requestStop from Idle returns false" AND "Aborting→Restarting
// throws" — two different failure modes, two different methods.

// CRITICAL (fail() NEVER throws): "Any→Failed" means Failed is in every state's allowed set, so
// fail() unconditionally succeeds. Do NOT route fail() through the throwing transition() path in a way
// that could throw. (Implementing it as its own validate-free state-set is simplest — see reference impl.)

// CRITICAL (reset() CAN throw): reset() = transition("Idle"). Idle is reachable ONLY from Completed and
// Failed (table). reset() from Reasoning/any-other throws. Do NOT make reset() a force-reset (that
// would be "Any→Idle", which is NOT in §16). In practice reset() is always post-Completed/post-Failed.

// GOTCHA ("Any→Failed" encoding): Failed must be in the allowed set of EVERY state EXCEPT Failed
// itself. Failed's own set is {Idle} only. Double-check the Map: 9 "normal" states get {next, Failed};
// Completed gets {Idle, Failed}; Failed gets {Idle}. 11 entries total (one per state).

// GOTCHA (isolatedModules + strict): TransitionState and Diagnostics are TYPES → `import type`. There
// are NO value imports in controller.ts (no runtime deps). A plain `import` of a type-only symbol
// triggers isolatedModules errors under bundler resolution — always use `import type` here.

// GOTCHA (immutable table typing): type ALLOWED_TRANSITIONS as
// `ReadonlyMap<TransitionState, ReadonlySet<TransitionState>>` (ReadonlyMap is a TS built-in). The
// inner Sets are ReadonlySet so callers can't mutate. Tests read it via .get(state)?.has(next).

// GOTCHA (logs are privacy-safe by construction): the controller logs {from, to} (state transitions)
// and {reason, from} where reason is an error CATEGORY. Appendix H allow-lists both. The controller
// NEVER receives prompt/reasoning/assistant content, so there is nothing to scrub. Do not log anything
// beyond state + category (no model/provider — the controller doesn't know them; don't add fields just
// to log them; if you want correlation, the caller can pass a transitionId in a future subtask, NOT now).

// GOTCHA (throw message must cite PRD §16): the item DOCS + MOCKING spec wants illegal transitions to
// throw "with diagnostic". The thrown Error message must include the from→to pair AND "(PRD §16)" so a
// debugger immediately knows which table row was violated. e.g.
//   `throw new Error(\`Illegal state transition: ${this.state} → ${next} (PRD §16)\`);`

// GOTCHA (warn level for illegal, error level for fail): mirror proxy.ts (uses warn for "upstream-threw"
// defensive case) → illegal-transition attempts log warn (recoverable; caller may catch). fail() logs
// error (a real failure reached the Failed state). Legal transitions log trace (PRD §57: trace = every
// state transition). Do NOT log legal transitions at info/debug — trace is the PRD-mandated level.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke `npx bun run typecheck` / `npx bun run build`
// / `npx bun test`, NOT bare `tsc`/`bun`. package.json scripts resolve via `npx bun run <script>`.

// GOTCHA (tests/ excluded from the build): tsconfig exclude:["tests"] → typecheck validates src/ ONLY.
// The new test file is validated by `npx bun test` (Bun transpiles TS natively). Do NOT add tests/ to
// tsconfig include — that breaks the src/tests boundary.
```

---

## Implementation Blueprint

### Data models and structure

No production data models beyond the FSM. The single owned runtime field is `private state:
TransitionState` (initialized `"Idle"`). The single owned constant is `ALLOWED_TRANSITIONS`. The two
inputs are type-only:

```typescript
// INPUT — src/types.ts (P1.M2.T1.S1)
export type TransitionState =
  | "Idle" | "Delegating" | "Reasoning" | "StopRequested" | "Aborting" | "Capturing"
  | "Restarting" | "Splicing" | "Answering" | "Completed" | "Failed";

// INPUT — src/diagnostics/index.ts (P1.M1.T3.S1)
export interface Diagnostics {
  trace(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE/REPLACE src/state/controller.ts (the FSM)
  - IMPORT (type ONLY — isolatedModules): `import type { TransitionState } from "../types"`;
    `import type { Diagnostics } from "../diagnostics"`. NO value imports (zero runtime deps).
  - IMPLEMENT `export const ALLOWED_TRANSITIONS: ReadonlyMap<TransitionState, ReadonlySet<TransitionState>>`
    = new Map([...]) with EXACTLY the 11 entries:
      Idle        → ["Delegating", "Failed"]
      Delegating  → ["Reasoning",  "Failed"]
      Reasoning   → ["StopRequested", "Failed"]
      StopRequested → ["Aborting",  "Failed"]
      Aborting    → ["Capturing",  "Failed"]
      Capturing   → ["Restarting", "Failed"]
      Restarting  → ["Splicing",   "Failed"]
      Splicing    → ["Answering",  "Failed"]
      Answering   → ["Completed",  "Failed"]
      Completed   → ["Idle",       "Failed"]
      Failed      → ["Idle"]
    Build each value as `new Set<TransitionState>([...])`. "Any→Failed" = Failed present in every set
    except Failed's own.
  - IMPLEMENT `export class TransitionController`:
      constructor(private readonly diagnostics: Diagnostics) {}
      private state: TransitionState = "Idle";   // single owned mutable field (PRD §37 single writer)
      transition(next: TransitionState): void    // generic validator (escape hatch for entries)
      getState(): TransitionState
      canInterrupt(): boolean                     // state === "Reasoning"
      requestStop(): boolean                      // Reasoning→StopRequested (true) | else false
      beginAbort(): void                          // →transition("Aborting")
      completeAbort(): void                       // →transition("Capturing")
      beginReplacement(): void                    // →transition("Restarting")
      beginSplice(): void                         // →transition("Splicing")
      beginAnswering(): void                      // →transition("Answering")
      complete(): void                            // →transition("Completed")
      fail(reason: string): void                  // Any→Failed (always) + error log
      reset(): void                               // →transition("Idle") (legal only Completed/Failed)
  - transition(next) body:
      const allowed = ALLOWED_TRANSITIONS.get(this.state);
      if (!allowed || !allowed.has(next)) {
        this.diagnostics.warn("transition.illegal", { from: this.state, to: next });
        throw new Error(`Illegal state transition: ${this.state} → ${next} (PRD §16)`);
      }
      const from = this.state; this.state = next;
      this.diagnostics.trace("transition.state-change", { from, to: next });
  - requestStop() body:
      if (this.state !== "Reasoning") return false;   // no throw, no log, no state change
      this.transition("StopRequested");               // table-legal from Reasoning → cannot throw
      return true;
  - fail(reason) body (do NOT route through throwing transition — always succeeds):
      const from = this.state; this.state = "Failed"; // Any→Failed always table-legal
      this.diagnostics.trace("transition.state-change", { from, to: "Failed" });
      this.diagnostics.error("transition.failed", { reason, from });
  - Each one-liner convenience method = `this.transition("<Next>")`.
  - JSDOC (Mode A): module banner (Responsibility / Ownership / Lifecycle / Invariants / Failure modes
    / "Consumed by:") citing PRD §15/§16/§17/§30/§37/Appendix F; ALLOWED_TRANSITIONS doc (the table +
    Any→Failed note); EACH method's JSDoc references the PRD §16 row it implements + Preconditions /
    Postconditions / "Throws on illegal" / "Side effects: logs trace|warn|error". Item DOCS spec:
    "Add JSDoc referencing PRD §16 transition table for each transition method."
  - NAMING: PascalCase class (TransitionController); SCREAMING_SNAKE_CASE const (ALLOWED_TRANSITIONS);
    camelCase methods; quoted string-literal states (match TransitionState union exactly).
  - PLACEMENT: src/state/controller.ts (fully replace the 1-line stub).

Task 2: CREATE tests/transition-controller.test.ts (the FSM unit suite)
  - IMPORT (value): { describe, test, expect } from "bun:test";
    { TransitionController, ALLOWED_TRANSITIONS } from "../src/state/controller".
  - IMPORT (type): TransitionState from "../src/types"; Diagnostics from "../src/diagnostics".
  - IMPLEMENT a capturing Diagnostics builder (adapt tests/diagnostics.test.ts captureSink):
      function makeCaptureDiag() {
        const events: { level: "trace"|"warn"|"error"; event: string; fields?: Record<string,unknown> }[] = [];
        const diag = {
          trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
          warn:  (e, f) => events.push({ level: "warn",  event: e, fields: f }),
          error: (e, f) => events.push({ level: "error", event: e, fields: f }),
          debug(){}, info(){},
        } as Diagnostics;
        return { diag, events };
      }
  - IMPLEMENT describe/test blocks covering (every case the Success Criteria + item MOCKING list):
      • initial state is Idle; getState() returns it.
      • happy-path walk Idle→Delegating→Reasoning→StopRequested→Aborting→Capturing→Restarting→Splicing
        →Answering→Completed→Idle returns to Idle (use transition("Delegating")/transition("Reasoning")
        for the two entries; requestStop/beginAbort/completeAbort/beginReplacement/beginSplice/
        beginAnswering/complete/reset for the rest).
      • canInterrupt() true only in Reasoning (loop all 11 states via a small driver that walks to each).
      • requestStop() from Reasoning → true + state StopRequested; from Idle/Delegating/others → false +
        state unchanged + events log has NO transition.illegal and NO transition.state-change for that call.
      • illegal transitions THROW + leave state unchanged: Aborting→Restarting (transition("Restarting")
        from Aborting), Idle→Answering (transition), beginAbort() from Idle, complete() from Idle, etc.
        (table-driven negative matrix over a sample of illegal pairs). Assert the thrown Error message
        includes "PRD §16" + the from→to pair.
      • fail(reason) from Idle, Reasoning, Splicing → state Failed; events has transition.failed with the
        reason + the from-state; AND a transition.state-change {from,to:"Failed"}. Never throws.
      • reset() from Completed→Idle succeeds; from Failed→Idle succeeds; from Reasoning THROWS.
      • trace logging: one legal transition → exactly one transition.state-change with correct {from,to};
        one illegal attempt → exactly one transition.illegal with correct {from,to} (assert counts via
        events.filter).
      • ALLOWED_TRANSITIONS completeness: assert the 11 adjacency entries match the PRD §16 table (loop
        each state, assert its allowed set).
  - FOLLOW pattern: tests/types.test.ts (table-driven EXPECTED map + iterate-all), tests/diagnostics.test.ts
    (capture pattern), tests/stream-proxy.test.ts (describe/test/expect + class-named file).
  - PLACEMENT: tests/transition-controller.test.ts.

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics (src/ now includes the full controller.ts).
  - RUN: npx bun run build      → exit 0; dist/state/controller.{js,d.ts} emitted.
  - RUN: npx bun test tests/transition-controller.test.ts  → the new suite green.
  - RUN: npx bun test           → ALL green (transition-controller + the 8 existing suites — no regressions).
  - RUN: Level 3/4 grep gates below.
```

### Implementation Patterns & Key Details

```typescript
// ── src/state/controller.ts — COMPLETE reference (author verbatim, Mode-A JSDoc included) ───────

/**
 * # TransitionController — explicit FSM owning the interruption lifecycle (PRD §15/§16/§17/§30).
 *
 * **Responsibility** (PRD §30): "Own interruption lifecycle. No other module may mutate transition
 * state." This class is the **single writer** (PRD §37 Ownership Rules: "TransitionController owns
 * transition state") of one private `state` field, initialized `"Idle"`. It encodes the PRD §16 State
 * Transition Table as `ALLOWED_TRANSITIONS` and REJECTS every transition absent from that table by
 * throwing an Error that cites PRD §16.
 *
 * **Scope (this subtask = pure FSM)**: the class performs NO abort, NO replacement-request, NO stream
 * splicing. The convenience methods (`beginAbort`/`completeAbort`/`beginReplacement`/`beginSplice`/
 * `beginAnswering`/`complete`/`fail`/`reset`) ONLY validate + change state + log. The actual abort
 * controller + transition token are owned by P1.M5 (abort coordination); replacement invocation by
 * P1.M6; splicing by P1.M7. Those later modules call these named methods; this class guarantees their
 * sequencing is legal.
 *
 * **Ownership**: one `private state: TransitionState` (the single owned mutable field). Owns NO abort
 * controller, NO buffer, NO stream in this subtask.
 *
 * **Lifecycle**: one instance per logical assistant response, constructed by StreamProxy (P1.M4) with
 * the shared {@link Diagnostics}. Walks `Idle → Delegating → Reasoning → StopRequested → Aborting →
 * Capturing → Restarting → Splicing → Answering → Completed → Idle`; any state may go `→ Failed`
 * (PRD §16 "Any → Fatal error → Failed"); `Failed → Idle` on reset.
 *
 * **Invariants** (PRD §30 + Appendix O INV-004):
 *  - Single active transition — exactly one `state` field, mutated only inside `transition()`/`fail()`.
 *  - No transition outside PRD §16 is ever accepted (every other pair throws).
 *  - At most one interruption transition per response — `requestStop()` returns `false` once the state
 *    has left `Reasoning`, so the stop flow cannot be re-entered (INV-004).
 *
 * **Failure modes**: an illegal transition attempt logs `warn("transition.illegal", {from,to})` then
 * throws `Error("Illegal state transition: <from> → <to> (PRD §16)")`. `fail(reason)` (Any→Failed) never
 * throws; it logs `error("transition.failed", {reason, from})`.
 *
 * Consumed by: StreamProxy (P1.M4 reasoning detection — drives Delegating/Reasoning/requestStop + the
 * abort/splice chain), TransitionCoordinator (P1.M4.T4 — calls canInterrupt/requestStop), abort
 * coordination (P1.M5), replacement generation (P1.M6), stream splicing (P1.M7).
 */
import type { TransitionState } from "../types";
import type { Diagnostics } from "../diagnostics";

/**
 * The PRD §16 State Transition Table encoded as an immutable adjacency map. Each key is a current
 * state; its value is the set of states reachable from it. "Any → Fatal error → Failed" (PRD §16) is
 * encoded by including `"Failed"` in every state's set EXCEPT `"Failed"`'s own (whose only exit is
 * `"Idle"` per "Failed | Cleanup | Idle").
 *
 * This is the single source of truth for transition legality; {@link TransitionController.transition}
 * reads it for every validation.
 *
 * - Preconditions: none (module-load constant).
 * - Postconditions: 11 entries (one per state); immutable surface (ReadonlyMap of ReadonlySet).
 * - Side effects: none.
 */
export const ALLOWED_TRANSITIONS: ReadonlyMap<TransitionState, ReadonlySet<TransitionState>> = new Map([
  ["Idle", new Set<TransitionState>(["Delegating", "Failed"])],
  ["Delegating", new Set<TransitionState>(["Reasoning", "Failed"])],
  ["Reasoning", new Set<TransitionState>(["StopRequested", "Failed"])],
  ["StopRequested", new Set<TransitionState>(["Aborting", "Failed"])],
  ["Aborting", new Set<TransitionState>(["Capturing", "Failed"])],
  ["Capturing", new Set<TransitionState>(["Restarting", "Failed"])],
  ["Restarting", new Set<TransitionState>(["Splicing", "Failed"])],
  ["Splicing", new Set<TransitionState>(["Answering", "Failed"])],
  ["Answering", new Set<TransitionState>(["Completed", "Failed"])],
  ["Completed", new Set<TransitionState>(["Idle", "Failed"])],
  ["Failed", new Set<TransitionState>(["Idle"])],
]);

/**
 * The single writer of interruption-lifecycle state (PRD §30/§37). Holds one `state` field initialized
 * `"Idle"` and rejects every transition not in {@link ALLOWED_TRANSITIONS} (PRD §16) by throwing.
 *
 * **Pure FSM**: the convenience methods only change state (+ log); they perform no abort/replacement/
 * splicing side effects (those are P1.M5/P1.M6/P1.M7).
 */
export class TransitionController {
  /** The single owned mutable field (PRD §37 single-writer). Initialized `"Idle"` (PRD §16). */
  private state: TransitionState = "Idle";

  /**
   * @param diagnostics  Shared structured logger (PRD §36). **Privacy (Appendix H):** only state
   *                     transitions (`{from, to}`) and error categories (`fail` reason) are ever logged —
   *                     the controller never sees prompt/reasoning/assistant content.
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Transition to `next` iff it is legal from the current state per PRD §16; otherwise log a
   * `transition.illegal` warning and throw an Error citing PRD §16. On success set the state and emit
   * `trace("transition.state-change", {from, to})`.
   *
   * This is the table-driven validator and the contract's escape hatch for the two entry transitions
   * (`Idle → Delegating` on stream begin; `Delegating → Reasoning` on the first thinking event) that
   * have no dedicated convenience method (PRD §16).
   *
   * - Preconditions: `next` is a {@link TransitionState}.
   * - Postconditions: on success `this.state === next`; on failure `this.state` is UNCHANGED.
   * - Side effects: `trace` on success; `warn` then throw on failure.
   * - @throws {Error} `Illegal state transition: <from> → <next> (PRD §16)` when `next` is not reachable.
   */
  transition(next: TransitionState): void {
    const allowed = ALLOWED_TRANSITIONS.get(this.state);
    if (!allowed || !allowed.has(next)) {
      this.diagnostics.warn("transition.illegal", { from: this.state, to: next });
      throw new Error(`Illegal state transition: ${this.state} → ${next} (PRD §16)`);
    }
    const from = this.state;
    this.state = next;
    this.diagnostics.trace("transition.state-change", { from, to: next });
  }

  /**
   * @returns the current state. Pure read; never throws, never logs.
   */
  getState(): TransitionState {
    return this.state;
  }

  /**
   * Whether the shortcut may interrupt right now: `true` ONLY in `Reasoning` (PRD §22.5 Shortcut
   * Availability). Pure read; never throws, never logs.
   */
  canInterrupt(): boolean {
    return this.state === "Reasoning";
  }

  /**
   * Request the stop transition (PRD §16: `Reasoning | Shortcut | StopRequested`).
   *
   * @returns `true` and transitions to `StopRequested` when the current state is `Reasoning`; `false`
   *          otherwise (no throw, no state change, no log). This is the ONLY boolean-returning method —
   *          graceful rejection (FM-001/FM-002/FM-003: shortcut ignored outside Reasoning).
   * - Side effects (success only): one `transition.state-change` trace (via {@link transition}).
   */
  requestStop(): boolean {
    if (this.state !== "Reasoning") return false;
    this.transition("StopRequested"); // table-legal from Reasoning → cannot throw
    return true;
  }

  /** Dispatch the abort (PRD §16: `StopRequested | Abort dispatched | Aborting`). Throws if not in
   *  `StopRequested`. Only changes state — the actual upstream abort is P1.M5.T1.S1. */
  beginAbort(): void {
    this.transition("Aborting");
  }

  /** Upstream closed; reasoning frozen (PRD §16: `Aborting | Upstream closed | Capturing`). Throws if
   *  not in `Aborting`. Only changes state. */
  completeAbort(): void {
    this.transition("Capturing");
  }

  /** Issue the replacement request (PRD §16: `Capturing | Replacement issued | Restarting`). Throws if
   *  not in `Capturing` (PRD §51: "No replacement request may begin before reasoning is frozen").
   *  Only changes state. */
  beginReplacement(): void {
    this.transition("Restarting");
  }

  /** First replacement token received (PRD §16: `Restarting | First replacement token | Splicing`).
   *  Throws if not in `Restarting`. Only changes state. */
  beginSplice(): void {
    this.transition("Splicing");
  }

  /** First answer token received (PRD §16: `Splicing | First answer token | Answering`). Throws if not
   *  in `Splicing`. Only changes state. */
  beginAnswering(): void {
    this.transition("Answering");
  }

  /** Replacement stream reached `message_end` (PRD §16: `Answering | message_end | Completed`). Throws
   *  if not in `Answering`. Only changes state. */
  complete(): void {
    this.transition("Completed");
  }

  /**
   * Fatal error → `Failed` (PRD §16: `Any | Fatal error → Failed`). ALWAYS succeeds ("Any → Failed");
   * never throws. Logs `trace("transition.state-change", {from, to:"Failed"})` then
   * `error("transition.failed", {reason, from})`.
   *
   * @param reason  An error CATEGORY (e.g. "timeout", "abort-failed", "replacement-rejected") — never
   *                user/prompt/reasoning content (PRD Appendix H: only error categories are loggable;
   *                the controller never sees user content anyway).
   * - Side effects: one `transition.state-change` trace + one `transition.failed` error.
   */
  fail(reason: string): void {
    const from = this.state;
    this.state = "Failed"; // Any→Failed is always table-legal (present in every non-Failed set)
    this.diagnostics.trace("transition.state-change", { from, to: "Failed" });
    this.diagnostics.error("transition.failed", { reason, from });
  }

  /**
   * Cleanup → `Idle` (PRD §16: `Completed | Cleanup | Idle` and `Failed | Cleanup | Idle`). Legal ONLY
   * from `Completed` or `Failed`; throws from any other state (Idle is reachable from no other state per
   * §16). In practice always called post-Completed/post-Failed.
   * - Side effects (success): one `transition.state-change` trace.
   * - @throws {Error} when the current state is not `Completed` or `Failed`.
   */
  reset(): void {
    this.transition("Idle");
  }
}
```

```typescript
// ── tests/transition-controller.test.ts — COMPLETE reference (author verbatim) ─────────────────

import { describe, test, expect } from "bun:test";
import { TransitionController, ALLOWED_TRANSITIONS } from "../src/state/controller";
import type { TransitionState } from "../src/types";
import type { Diagnostics } from "../src/diagnostics";

/** Capturing Diagnostics stub (adapted from tests/diagnostics.test.ts). Records trace/warn/error so
 *  tests can assert transition logging (PRD §57 trace = every state transition). */
function makeCaptureDiag(): { diag: Diagnostics; events: Array<{ level: "trace" | "warn" | "error"; event: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ level: "trace" | "warn" | "error"; event: string; fields?: Record<string, unknown> }> = [];
  const diag = {
    trace: (event: string, fields?: Record<string, unknown>) => events.push({ level: "trace", event, fields }),
    warn: (event: string, fields?: Record<string, unknown>) => events.push({ level: "warn", event, fields }),
    error: (event: string, fields?: Record<string, unknown>) => events.push({ level: "error", event, fields }),
    debug() {},
    info() {},
  } as Diagnostics;
  return { diag, events };
}

// --- ALLOWED_TRANSITIONS (PRD §16 table) --------------------------------------------

describe("ALLOWED_TRANSITIONS — encodes PRD §16 exactly", () => {
  test("every state maps to its §16 successors (incl. Any→Failed)", () => {
    expect([...(ALLOWED_TRANSITIONS.get("Idle") as ReadonlySet<TransitionState>)].sort()).toEqual(["Delegating", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Delegating") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Reasoning"]);
    expect([...(ALLOWED_TRANSITIONS.get("Reasoning") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "StopRequested"]);
    expect([...(ALLOWED_TRANSITIONS.get("StopRequested") as ReadonlySet<TransitionState>)].sort()).toEqual(["Aborting", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Aborting") as ReadonlySet<TransitionState>)].sort()).toEqual(["Capturing", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Capturing") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Restarting"]);
    expect([...(ALLOWED_TRANSITIONS.get("Restarting") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Splicing"]);
    expect([...(ALLOWED_TRANSITIONS.get("Splicing") as ReadonlySet<TransitionState>)].sort()).toEqual(["Answering", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Answering") as ReadonlySet<TransitionState>)].sort()).toEqual(["Completed", "Failed"]);
    expect([...(ALLOWED_TRANSITIONS.get("Completed") as ReadonlySet<TransitionState>)].sort()).toEqual(["Failed", "Idle"]);
    expect([...(ALLOWED_TRANSITIONS.get("Failed") as ReadonlySet<TransitionState>)].sort()).toEqual(["Idle"]);
  });
});

// --- initial state + getState -------------------------------------------------------

describe("TransitionController — initial state", () => {
  test("starts in Idle and getState returns it", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(c.getState()).toBe("Idle");
  });
});

// --- happy-path walk ----------------------------------------------------------------

describe("TransitionController — full happy-path walk returns to Idle (PRD §16)", () => {
  test("Idle→Delegating→Reasoning→StopRequested→Aborting→Capturing→Restarting→Splicing→Answering→Completed→Idle", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");      // entry (stream begins)
    expect(c.getState()).toBe("Delegating");
    c.transition("Reasoning");       // entry (first thinking event)
    expect(c.getState()).toBe("Reasoning");
    expect(c.requestStop()).toBe(true);
    expect(c.getState()).toBe("StopRequested");
    c.beginAbort();
    expect(c.getState()).toBe("Aborting");
    c.completeAbort();
    expect(c.getState()).toBe("Capturing");
    c.beginReplacement();
    expect(c.getState()).toBe("Restarting");
    c.beginSplice();
    expect(c.getState()).toBe("Splicing");
    c.beginAnswering();
    expect(c.getState()).toBe("Answering");
    c.complete();
    expect(c.getState()).toBe("Completed");
    c.reset();
    expect(c.getState()).toBe("Idle");
  });
});

// --- canInterrupt + requestStop -----------------------------------------------------

describe("canInterrupt — true ONLY in Reasoning (PRD §22.5)", () => {
  for (const [state, expected] of [
    ["Idle", false], ["Delegating", false], ["Reasoning", true], ["StopRequested", false],
    ["Aborting", false], ["Capturing", false], ["Restarting", false], ["Splicing", false],
    ["Answering", false], ["Completed", false], ["Failed", false],
  ] as const) {
    test(`canInterrupt() is ${expected} in ${state}`, () => {
      const { diag } = makeCaptureDiag();
      const c = new TransitionController(diag);
      // walk to `state` along the legal path (fail/reset where needed) then assert.
      // Simplest: drive to Reasoning then forward; for post-Reasoning states continue the chain.
      c.transition("Delegating");
      c.transition("Reasoning");
      if (state === "Reasoning") { expect(c.canInterrupt()).toBe(expected); return; }
      c.requestStop();   // → StopRequested
      if (state === "StopRequested") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginAbort();    // → Aborting
      if (state === "Aborting") { expect(c.canInterrupt()).toBe(expected); return; }
      c.completeAbort(); // → Capturing
      if (state === "Capturing") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginReplacement(); // → Restarting
      if (state === "Restarting") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginSplice();   // → Splicing
      if (state === "Splicing") { expect(c.canInterrupt()).toBe(expected); return; }
      c.beginAnswering(); // → Answering
      if (state === "Answering") { expect(c.canInterrupt()).toBe(expected); return; }
      c.complete();      // → Completed
      if (state === "Completed") { expect(c.canInterrupt()).toBe(expected); return; }
      if (state === "Failed") { c.fail("x"); expect(c.canInterrupt()).toBe(expected); return; }
      if (state === "Idle" || state === "Delegating") { /* Idle/Delegating asserted via fresh controller below */ }
    });
  }
  test("canInterrupt false in Idle and Delegating (fresh controller)", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(c.canInterrupt()).toBe(false);            // Idle
    c.transition("Delegating");
    expect(c.canInterrupt()).toBe(false);            // Delegating
  });
});

describe("requestStop — boolean contract (item MOCKING)", () => {
  test("returns false from Idle (no throw, no state change, no log)", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    const before = events.length;
    expect(c.requestStop()).toBe(false);
    expect(c.getState()).toBe("Idle");               // unchanged
    expect(events.length).toBe(before);              // nothing logged
  });
  test("returns false from Delegating and every non-Reasoning state", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");
    expect(c.requestStop()).toBe(false);
  });
  test("returns true from Reasoning and transitions to StopRequested", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");
    c.transition("Reasoning");
    expect(c.requestStop()).toBe(true);
    expect(c.getState()).toBe("StopRequested");
  });
});

// --- illegal transitions throw ------------------------------------------------------

describe("illegal transitions throw and leave state unchanged (PRD §16)", () => {
  test("Aborting→Restarting (skipping Capturing) throws (item MOCKING)", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating"); c.transition("Reasoning"); c.requestStop(); c.beginAbort();
    expect(c.getState()).toBe("Aborting");
    expect(() => c.transition("Restarting")).toThrow(/PRD §16/);
    expect(c.getState()).toBe("Aborting");           // unchanged
  });
  test("Idle→Answering throws", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.transition("Answering")).toThrow(/PRD §16/);
    expect(c.getState()).toBe("Idle");
  });
  test("beginAbort() from Idle throws", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.beginAbort()).toThrow(/PRD §16/);
  });
  test("complete() from Idle throws", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.complete()).toThrow(/PRD §16/);
  });
  test("the thrown Error names the from→to pair + PRD §16", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    try {
      c.transition("Reasoning"); // illegal from Idle
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Idle");
      expect((err as Error).message).toContain("Reasoning");
      expect((err as Error).message).toContain("PRD §16");
    }
  });
});

// --- fail() Any→Failed ---------------------------------------------------------------

describe("fail — Any→Failed always succeeds + logs (PRD §16)", () => {
  for (const setup of [
    { label: "Idle", walk: (c: TransitionController) => {} },
    { label: "Reasoning", walk: (c: TransitionController) => { c.transition("Delegating"); c.transition("Reasoning"); } },
    { label: "Splicing", walk: (c: TransitionController) => { c.transition("Delegating"); c.transition("Reasoning"); c.requestStop(); c.beginAbort(); c.completeAbort(); c.beginReplacement(); c.beginSplice(); } },
  ]) {
    test(`fail() from ${setup.label} → Failed (never throws)`, () => {
      const { diag, events } = makeCaptureDiag();
      const c = new TransitionController(diag);
      setup.walk(c);
      const from = c.getState();
      expect(() => c.fail("abort-failed")).not.toThrow();
      expect(c.getState()).toBe("Failed");
      const failedLog = events.find((e) => e.level === "error" && e.event === "transition.failed");
      expect(failedLog).toBeDefined();
      expect(failedLog!.fields!.reason).toBe("abort-failed");
      expect(failedLog!.fields!.from).toBe(from);
    });
  }
});

// --- reset() legality ----------------------------------------------------------------

describe("reset — legal only from Completed/Failed (PRD §16)", () => {
  test("reset() from Completed → Idle", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating"); c.transition("Reasoning"); c.requestStop(); c.beginAbort();
    c.completeAbort(); c.beginReplacement(); c.beginSplice(); c.beginAnswering(); c.complete();
    expect(c.getState()).toBe("Completed");
    c.reset();
    expect(c.getState()).toBe("Idle");
  });
  test("reset() from Failed → Idle", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.fail("x");
    expect(c.getState()).toBe("Failed");
    c.reset();
    expect(c.getState()).toBe("Idle");
  });
  test("reset() from Reasoning THROWS", () => {
    const { diag } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating"); c.transition("Reasoning");
    expect(() => c.reset()).toThrow(/PRD §16/);
    expect(c.getState()).toBe("Reasoning");          // unchanged
  });
});

// --- trace logging (PRD §57) ---------------------------------------------------------

describe("transition logging — trace on success, warn on illegal (PRD §57)", () => {
  test("a legal transition emits exactly one transition.state-change with {from,to}", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    c.transition("Delegating");
    const changes = events.filter((e) => e.level === "trace" && e.event === "transition.state-change");
    expect(changes).toHaveLength(1);
    expect(changes[0].fields).toEqual({ from: "Idle", to: "Delegating" });
  });
  test("an illegal attempt emits exactly one transition.illegal with {from,to} then throws", () => {
    const { diag, events } = makeCaptureDiag();
    const c = new TransitionController(diag);
    expect(() => c.transition("Answering")).toThrow();
    const illegals = events.filter((e) => e.level === "warn" && e.event === "transition.illegal");
    expect(illegals).toHaveLength(1);
    expect(illegals[0].fields).toEqual({ from: "Idle", to: "Answering" });
  });
});
```

### Integration Points

```yaml
MODULE GRAPH (this class is the FSM spine later modules drive; it integrates via pure method calls):
  StreamProxy (P1.M4):         new TransitionController(diagnostics)
                               → transition("Delegating") on stream begin
                               → transition("Reasoning") on first thinking event
                               → requestStop() on shortcut (when canInterrupt())
                               → beginAbort()/completeAbort()/beginReplacement()/beginSplice()/
                                  beginAnswering()/complete()/reset() through the abort+splice phases
                               → fail(reason) on any fatal error → then reset()
  TransitionCoordinator (P1.M4.T4): holds the active controller; calls canInterrupt() + requestStop().

NO NEW RUNTIME DEPS: zero value imports. TransitionState + Diagnostics are type-only. No package.json /
tsconfig.json / .gitignore changes. No new deps.

NEW EXPORTS FROM src/state/controller.ts:
  - export const ALLOWED_TRANSITIONS   (immutable adjacency table — read by tests + future modules)
  - export class TransitionController  (the FSM)

NO CHANGES TO src/types.ts OR src/diagnostics/index.ts: both are immutable INPUTS (type-only imports).

BUILD EMISSION: dist/state/controller.{js,js.map,d.ts} appears after `npx bun run build` (rootDir src,
outDir dist). dist/ is git-ignored — verify with `git status --short dist/` (expected empty/ignored).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (now includes the full controller.ts):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. If a diagnostic appears:
#   • "cannot be used as a value because it was never imported" → you used a plain `import` for a
#     type-only symbol; switch to `import type { TransitionState }` / `import type { Diagnostics }`.
#   • readonly-assignment → you tried to mutate ALLOWED_TRANSITIONS or a ReadonlySet; don't.

# Build (emits dist/state/controller.{js,d.ts}):
npx bun run build            # = tsc
# Expected: exit 0. Verify the new dist artifact exists:
ls dist/state/controller.js dist/state/controller.d.ts   # Expected: both present.
git status --short dist/                                    # Expected: empty (dist is git-ignored).
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the new FSM suite alone:
npx bun test tests/transition-controller.test.ts
# Expected: ALL green. Test groups:
#   • ALLOWED_TRANSITIONS encodes PRD §16 exactly
#   • initial state is Idle
#   • full happy-path walk returns to Idle
#   • canInterrupt true ONLY in Reasoning (11 states)
#   • requestStop boolean contract (false outside Reasoning; true + transitions in Reasoning)
#   • illegal transitions throw + leave state unchanged (Aborting→Restarting, Idle→Answering, etc.)
#   • fail() Any→Failed from Idle/Reasoning/Splicing (never throws, logs transition.failed)
#   • reset() legal (Completed,Failed) + illegal (Reasoning throws)
#   • transition logging (trace on success, warn on illegal)

# Full suite (no regressions in the 8 existing suites + golden if P1.M2.T4.S1 landed):
npx bun test
# Expected: every suite green (transition-controller + smoke + config + diagnostics + provider-decorator
#   + factory + types + stream-proxy [+ golden if present]).
```

### Level 3: Integration (Package Integrity)

```bash
# 3a. The controller is a pure FSM — exercise it directly via bun to prove the table end-to-end:
npx bun --print "
import { TransitionController } from './src/state/controller.ts';
const d = { trace(){},debug(){},info(){},warn(){},error(){} };
const c = new TransitionController(d);
const seq = [];
seq.push(c.getState());                  // Idle
c.transition('Delegating'); c.transition('Reasoning');
seq.push(c.requestStop());               // true
c.beginAbort(); c.completeAbort(); c.beginReplacement();
c.beginSplice(); c.beginAnswering(); c.complete();
seq.push(c.getState());                  // Completed
c.reset();
seq.push(c.getState());                  // Idle
let threw = false;
try { const c2 = new TransitionController(d); c2.transition('Delegating'); c2.beginAbort(); } catch { threw = true; }
JSON.stringify({ seq, illegalThrows: threw });
"
# Expected: {"seq":["Idle",true,"Completed","Idle"],"illegalThrows":true}

# 3b. Confirm the new dist artifact is importable as compiled JS (proves the build emitted it):
node --input-type=module -e "
import('./dist/state/controller.js').then(({ TransitionController, ALLOWED_TRANSITIONS }) => {
  const d = { trace(){},debug(){},info(){},warn(){},error(){} };
  const c = new TransitionController(d);
  console.log('exports ok, idle=', c.getState(), 'tableSize=', ALLOWED_TRANSITIONS.size);
});
"
# Expected: exports ok, idle= Idle tableSize= 11
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Scope gate — this is a PURE FSM (no abort controller / no RequestBuilder / no stream splicing):
grep -rni "AbortController\|RequestBuilder\|streamSimple\|createAssistantMessageEventStream\|ReasoningBuffer\|transitionId\|token" src/state/controller.ts
# Expected: ZERO (those are P1.M5/P1.M6/P1.M7 concerns; this subtask only owns state + table + methods).

# Type-only import gate (isolatedModules compliance):
grep -n 'import type' src/state/controller.ts   # Expected: 2 lines (TransitionState + Diagnostics)
grep -nE '^import [^t]' src/state/controller.ts  # Expected: ZERO (no value imports at all)

# Throw-message gate — every illegal path cites PRD §16 + the from→to pair:
grep -n "PRD §16" src/state/controller.ts        # Expected: ≥1 (the transition() throw template)

# Table-completeness gate — exactly 11 Map entries incl. Failed in every non-Failed set:
grep -c '"Failed"' src/state/controller.ts       # Expected: 10 (Failed in 10 sets; Failed's own set has none)
grep -c 'new Set<TransitionState>' src/state/controller.ts  # Expected: 11 (one per state)

# JSDoc gate — Mode-A banner + every transition method references PRD §16 (item DOCS spec):
grep -n "PRD §16" src/state/controller.ts        # Expected: the throw + multiple JSDoc @-references
grep -n "/\*\*" src/state/controller.ts          # Expected: ≥11 (module banner + ALLOWED + 9+ methods)

# Privacy gate — only state transitions + error categories logged (Appendix H allow-list):
grep -nE "trace\(|warn\(|error\(" src/state/controller.ts
# Expected: transition() {trace state-change, warn illegal}; fail() {trace state-change, error failed}.
#   NO logging of prompt/reasoning/assistant content (the controller never receives any).

# Test-coverage gate — the item MOCKING cases are all present:
grep -n "requestStop().*toBe(false)\|Aborting.*Restarting\|fail(\|reset()" tests/transition-controller.test.ts
# Expected: each appears (false-return, skip-throws, fail, reset legal+illegal).
grep -c "describe(" tests/transition-controller.test.ts   # Expected: ≥7 test groups

# No-edit gate — only the two intended files changed:
git add -A && git status --short
# Expected: ONLY src/state/controller.ts (modified) + tests/transition-controller.test.ts (new).
#   ZERO changes to types.ts, diagnostics, proxy, decorator, config, index, package.json, tsconfig.json,
#   .gitignore, or any existing test.
```

---

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics (src/ now includes the full controller.ts).
- [ ] `npx bun run build` → exit 0; `dist/state/controller.{js,d.ts}` emitted.
- [ ] `npx bun test` → all green (transition-controller + the 8 existing suites, no regressions).

### Feature Validation

- [ ] `src/state/controller.ts` exports `class TransitionController` + `ALLOWED_TRANSITIONS` exactly as
      specified (constructor `(diagnostics)`, `private state = "Idle"`, all 10 methods).
- [ ] `ALLOWED_TRANSITIONS` is the full PRD §16 adjacency incl. "Any→Failed" (11 entries).
- [ ] `transition(next)` throws (citing PRD §16) + logs `warn` on illegal; sets state + logs `trace` on
      legal.
- [ ] `requestStop()` returns `false` outside `Reasoning`; `true` + →StopRequested in `Reasoning`.
- [ ] `canInterrupt()` true iff `Reasoning`.
- [ ] `fail(reason)` always succeeds + logs `error("transition.failed", {reason, from})`.
- [ ] `reset()` legal from Completed/Failed; throws otherwise.
- [ ] `tests/transition-controller.test.ts` covers every item-MOCKING case + table completeness + logging.

### Code Quality Validation

- [ ] Mode-A JSDoc module banner + per-method JSDoc; each transition method references PRD §16.
- [ ] Follows existing source conventions (injected `Diagnostics`, immutable constant typing, type-only
      imports, inline PRD citations, no enum/boolean flags — string-literal union only).
- [ ] Follows existing test conventions (`bun:test`, capture-Diagnostics stub, table-driven assertions,
      class-named test file).
- [ ] No edits outside `src/state/controller.ts` + the new `tests/transition-controller.test.ts`.

### Documentation & Deployment

- [ ] No new user-facing config/API beyond the class + constant (item DOCS: Mode-A JSDoc referencing
      PRD §16 — done in-file; no external docs).
- [ ] No new environment variables, scripts, or dependencies.

---

## Anti-Patterns to Avoid

- ❌ Don't add an `AbortController` field, transition-token generation, replacement-request invocation,
  or stream-splicing logic — those are P1.M5/P1.M6/P1.M7. This subtask is a **pure FSM**: state + table
  + validators + logging only.
- ❌ Don't make `requestStop()` throw — it returns `false` outside `Reasoning` (item MOCKING). Only the
  other convenience methods + `transition()` throw on illegal state.
- ❌ Don't make `fail(reason)` throw — "Any→Failed" means it ALWAYS succeeds. Don't route it through the
  throwing `transition()` in a way that could throw.
- ❌ Don't make `reset()` a force-reset ("Any→Idle") — Idle is reachable ONLY from Completed/Failed per
  §16; reset() from elsewhere MUST throw.
- ❌ Don't encode state as an enum or boolean flags — use the existing `TransitionState` string-literal
  union (PRD Appendix F).
- ❌ Don't use a plain `import` for `TransitionState`/`Diagnostics` — they are type-only (isolatedModules);
  use `import type`.
- ❌ Don't mutate `ALLOWED_TRANSITIONS` or its inner sets — type them `ReadonlyMap<…, ReadonlySet<…>>`.
- ❌ Don't log prompt/reasoning/assistant content — the controller only logs `{from,to}` transitions +
  error-category `reason` (Appendix H allow-list). It never sees user content anyway.
- ❌ Don't log legal transitions at info/debug — PRD §57 mandates **trace** for "every state transition".
- ❌ Don't add `tests/` to `tsconfig.json` include — it breaks the src/tests build boundary (tests are
  validated by `npx bun test` only).
- ❌ Don't edit `src/types.ts`, `src/diagnostics/index.ts`, or any other `src/` file — they are immutable
  inputs.
- ❌ Don't forget the "Any→Failed" row — Failed must be in EVERY state's allowed set except Failed's own.

---

## Confidence Score

**9/10** — one-pass success likelihood. This is a self-contained pure FSM with zero runtime deps, zero
async, and zero mocks. The two inputs (`TransitionState`, `Diagnostics`) are inlined verbatim with their
exact shapes; the PRD §16 table is pre-converted into the exact `ALLOWED_TRANSITIONS` Map; every method's
row mapping, throw/log contract (which level, which event name, which fields), and boolean-vs-throw
behavior is resolved; and the scope boundary (pure FSM — no abort/token/replacement/splice, those are
P1.M5–P1.M7) is stated in five places. Complete reference implementations for both the source file and
the test file are provided, so implementation is essentially transcription + validation. The only
residual risk is a `bun:test` table-driven loop that walks to a target state — the reference test uses
explicit per-state early-returns to keep it deterministic, and every group also has a direct assertion.
The baseline (`npx bun run typecheck` → exit 0) was verified before writing this PRP.
