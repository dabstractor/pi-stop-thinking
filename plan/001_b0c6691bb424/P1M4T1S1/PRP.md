# PRP — P1.M4.T1.S1: ReasoningBuffer append-only collection with freeze/snapshot (`src/buffer/index.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M4.T1.S1 (Phase 3 Reasoning Detection, 2 pts) — the **append-only reasoning capture
> collection**. Implements the `ReasoningBuffer` class whose entire job is to faithfully preserve the
> reasoning deltas emitted *before* interruption so the replacement request can reuse that reasoning
> context (PRD §23 Reasoning Buffer, §13.4 Reasoning Buffer, §41 Buffer Ownership During Transition,
> §45 Memory Requirements, §32 ReasoningBuffer Module, Appendix F coding standards, Appendix O INV-007).
> The buffer is **deliberately opaque** (PRD §13.4: "The extension does not interpret reasoning. It merely
> preserves it.") — it stores ordered deltas, tracks offsets/bytes, freezes on interruption, and exposes
> an immutable snapshot. It performs NO summarization, NO compression, NO interpretation (all explicit
> non-responsibilities, PRD §13.4 Non-responsibilities).
> **Builds on** (inputs, all DONE & immutable — do NOT modify): `Config.maximumReasoningBufferBytes`
> from **P1.M1.T2.S1** (`src/config/index.ts` — default `8388608` / 8 MiB, `isPositiveInteger`-validated)
> and `Diagnostics` from **P1.M1.T3.S1** (`src/diagnostics/index.ts` — frozen interface with
> `trace/debug/info/warn/error(event, fields?)`).
> **Consumed by**: StreamProxy (P1.M4.T2 — appends `thinking_delta` deltas + freezes on abort),
> P1.M5 abort coordination (calls `freeze()` at the Aborting→Capturing boundary — PRD §17 Capturing
> invariant: "Reasoning buffer immutable"), RequestBuilder (P1.M6 — reads `snapshot()` to build the
> thinking-disabled replacement request).

---

## Goal

**Feature Goal**: Implement an append-only, ordered, capture-faithful reasoning collection — the
`ReasoningBuffer` class — that is the **single owner** of pre-interruption reasoning deltas (PRD §32
Responsibility: "Capture reasoning emitted before interruption"; PRD §37 single-owner model). It exposes
exactly the operations the contract enumerates: `append(delta)` (mutable phase only — throws once frozen),
`freeze()` (mutable → frozen transition), `snapshot()` (an `Object.freeze` deep copy — immutable read),
`getByteSize()` (byte accounting for the overflow gate), and `reset()` (frozen → mutable rebirth). The
buffer **never truncates** (PRD §23.5: "The MVP shall not truncate reasoning.") — when an append would
exceed `config.maximumReasoningBufferBytes` it still appends but emits one privacy-safe `warn`. The
buffer **never interprets content** (PRD §13.4) — it stores raw `delta` strings and nothing else.

**Deliverable** (ONE new source file + ONE new test file; the module dir `src/buffer/` currently holds only
`.gitkeep`):
- `src/buffer/index.ts` — `export class ReasoningBuffer` + `export interface ThinkingEntry`. Fields
  `private entries: ThinkingEntry[] = []`, `private frozen = false`, `private totalBytes = 0`. Methods
  `append(delta: string): void`, `freeze(): void`, `snapshot(): readonly ThinkingEntry[]`,
  `getByteSize(): number`, `reset(): void`. Mode-A JSDoc on the module banner + every exported symbol,
  each citing the relevant PRD section (§23 / §13.4 / §32 / §41) and documenting the
  **mutable → frozen → read-only → destroyed** lifecycle states (work-item DOCS spec, PRD §41).
- `tests/reasoning-buffer.test.ts` — `bun:test` suite covering: append-then-snapshot ordering, offset
  monotonicity, byte accounting, append-after-freeze throws, freeze idempotency, snapshot immutability
  (freeze + isolated copy — mutating it / appending more must not affect it), getByteSize, reset clears +
  unfreezes, overflow warn-on-exceed (no truncation), and the privacy-safe log-field assertion (warn
  carries only counts, never content).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → 0 diagnostics; `npx bun run
build` → exit 0 (emits `dist/buffer/index.{js,d.ts}`); `npx bun test` → ALL green INCLUDING the new
`tests/reasoning-buffer.test.ts` with zero regressions in the existing 9 suites. `append` after `freeze`
throws an `Error` citing PRD §41; `append` before `freeze` is O(1) and preserves order/offsets exactly.
`snapshot()` returns an array that is `Object.isFrozen` and is structurally decoupled from the live
internal array (later appends + direct entry mutation do NOT change a previously-taken snapshot). The
overflow path appends the delta AND emits exactly one `warn` with no reasoning content in its fields. No
edits to any file other than `src/buffer/index.ts` + the new test file (plus removing the now-redundant
`src/buffer/.gitkeep`).

---

## User Persona (if applicable)

**Target User**: Downstream modules of this extension (the **developer/maintainer**), not the end user.
The buffer is an internal building block with no direct user surface.

**Use Case**: While z.ai is emitting a reasoning stream, the StreamProxy (P1.M4.T2) accumulates every
`thinking_delta` into the buffer so that, if the user presses the stop shortcut, the already-emitted
reasoning is available verbatim to construct a thinking-disabled replacement request (RequestBuilder,
P1.M6). The buffer is the continuity substrate that makes "stop thinking → answer immediately" seamless.

**User Journey**: (1) StreamProxy creates one `ReasoningBuffer` per request at the start of reasoning
(PRD §23.3 "Allocated: beginning of reasoning"). (2) Each `thinking_delta` → `append(delta)`. (3) On
stop → abort coordination (P1.M5) calls `freeze()` (mutable→frozen). (4) RequestBuilder (P1.M6) calls
`snapshot()` to read the captured reasoning. (5) After completion the buffer is discarded / `reset()`
(PRD §23.3 "Destroyed: completion. Never reused.").

**Pain Points Addressed**: Without faithful capture, a stop-and-restart would lose the model's reasoning
context, yielding a lower-quality or contradictory answer. The buffer guarantees the replacement request
sees exactly the reasoning that was emitted, in order, with no interpretation or loss.

## Why

- **This subtask is the memory substrate of the whole "Stop Thinking" feature.** PRD §23.1 Purpose: "The
  buffer preserves reasoning emitted before interruption. It exists solely to maximize continuity." Until
  this class exists there is nothing for RequestBuilder (P1.M6) to read — the replacement request would
  have to either re-stream reasoning (defeating the feature) or operate blind. This class is the durable
  capture that every downstream stop-flow module composes.
- **It is deliberately dumb — and that is the point.** PRD §13.4 Non-responsibilities lists
  "Summarization, Compression, Prompt engineering, Semantic analysis — explicitly outside MVP scope." A
  tempting over-engineering trap (summarize reasoning to save tokens) is FORBIDDEN here. The buffer is a
  faithful, ordered, append-only log. Keeping it pure means it is fully unit-testable with zero async,
  zero event-fixture machinery, zero mocks beyond a capturing Diagnostics stub.
- **Freeze is the safety gate for the FSM.** PRD §17 Capturing invariant: "Reasoning buffer immutable."
  PRD §51: "No replacement request may begin before reasoning is frozen." The `TransitionController`
  (P1.M3.T1.S1, DONE) refuses `Capturing → Restarting` out of order — and the *semantic* guarantee behind
  that ordering is that `freeze()` has been called so `snapshot()` is stable. `append()` throwing when
  frozen makes a logic bug (appending after the abort boundary) fail LOUDLY instead of silently corrupting
  the snapshot the replacement depends on.
- **It is memory-disciplined.** PRD §45: "memory proportional only to captured reasoning." The buffer
  stores deltas once; it does NOT duplicate answer text (PRD §23.4 — the proxy already forwards answers).
  `getByteSize()` + the overflow warn give observability into that bound without truncating (§23.5), so a
  runaway reasoning stream surfaces a warning rather than silently consuming unbounded memory.

## What

### Source: `src/buffer/index.ts` (new — first file in the module dir)

`export interface ThinkingEntry`:
- `readonly offset: number` — the entry's index in append order (0, 1, 2, …); monotonically increasing
  (PRD §13.4 "Track ordering / Track offsets").
- `readonly timestamp: number` — epoch ms via `Date.now()` at append time.
- `readonly content: string` — the raw reasoning `delta` string. Stored verbatim; never interpreted.

`export class ReasoningBuffer`:
- `constructor(private readonly diagnostics: Diagnostics, private readonly maximumBytes: number)` —
  inject the shared `Diagnostics` and the byte ceiling (the factory / StreamProxy passes
  `config.maximumReasoningBufferBytes`). The buffer does NOT import `Config` — minimal coupling.
- `private entries: ThinkingEntry[] = []` — the append-only internal collection.
- `private frozen = false` — the mutable/frozen gate (PRD §41).
- `private totalBytes = 0` — running byte accounting (sum of `delta.length`).
- `append(delta: string): void` — if `this.frozen` → throw `Error("ReasoningBuffer is frozen: cannot
  append after freeze() (PRD §41)")`. Else compute `const projected = this.totalBytes + delta.length`;
  push `{ offset: this.entries.length, timestamp: Date.now(), content: delta }`; set
  `this.totalBytes = projected`; if `projected > this.maximumBytes` emit
  `diagnostics.warn("buffer.overflow", { entries: this.entries.length, totalBytes: projected,
  maximumBytes: this.maximumBytes })` — **privacy-safe: counts only, NEVER the delta content** (Appendix H
  forbids logging reasoning text). Do NOT truncate (PRD §23.5).
- `freeze(): void` — `this.frozen = true` (idempotent — calling twice is a safe no-op, does NOT throw);
  emit `diagnostics.debug("buffer.frozen", { entries: this.entries.length, totalBytes: this.totalBytes })`
  (lifecycle milestone, privacy-safe counts).
- `snapshot(): readonly ThinkingEntry[]` — return
  `Object.freeze(this.entries.map((e) => Object.freeze({ ...e })))`. A frozen array of frozen entry
  copies, structurally independent of the live internal array (later `append`/`reset` must not mutate a
  previously-taken snapshot). Works whether or not frozen (read-only by result, never throws).
- `getByteSize(): number` — pure read of `this.totalBytes`. Never throws, never logs.
- `reset(): void` — `this.entries = []`; `this.frozen = false`; `this.totalBytes = 0`. Works REGARDLESS of
  frozen state (the mutable-rebirth path after completion/destroy — PRD §23.3/§41). Emit
  `diagnostics.debug("buffer.reset", {})`.

### Test: `tests/reasoning-buffer.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`) using a capturing Diagnostics
stub (adapted from `tests/diagnostics.test.ts` `captureSink` — record every `warn`/`debug` call) and a
small byte-limit (e.g. `10`) to exercise overflow cheaply. Coverage (derived from the work-item MOCKING
intent + general collection-coverage):
- `append` then `snapshot` preserves **order** and **content** verbatim; `offset` is `0,1,2,…`
  (monotonic, equals array index); `timestamp` is a positive finite number.
- `append` after `freeze` **throws** an `Error` whose message cites `PRD §41`; state is unchanged (a
  subsequent `snapshot().length` reflects only the pre-freeze appends); no diagnostic emitted on the
  throw path beyond nothing (the throw IS the signal).
- `freeze` is **idempotent**: calling it twice does not throw; `append` throws after either call.
- `snapshot` is **immutable + decoupled**: `Object.isFrozen(snap)` is `true`; each entry is frozen;
  mutating a snapshotted entry (cast) throws (strict mode) OR is a no-op; appending more deltas after
  taking a snapshot does NOT change the previously-taken snapshot (deep-copy guarantee).
- `getByteSize` returns the running sum of `delta.length` and stays `0` before any append.
- `reset` clears entries (`snapshot().length === 0`), resets bytes (`getByteSize() === 0`), and
  **unfreezes** (an `append` after `reset` succeeds; `getByteSize()` reflects it).
- **Overflow — no truncation**: with `maximumBytes = 10`, append a delta whose length pushes
  `totalBytes > 10`; assert the delta IS still appended (`snapshot().at(-1).content === delta`), the
  byte count reflects it, AND exactly one `buffer.overflow` `warn` fired whose fields contain ONLY
  `{entries, totalBytes, maximumBytes}` (assert the `content`/delta string is ABSENT — privacy).
- **Privacy gate**: assert across the suite that NO captured warn/debug field value is ever one of the
  appended delta strings (defense-in-depth on Appendix H).

**Out of scope** (owned by other subtasks — do NOT implement here):
- **Wiring `append` into the StreamProxy event loop** → P1.M4.T2 (StreamProxy owns the buffer instance;
  this subtask only defines the class).
- **Calling `freeze()` at the Aborting→Capturing boundary** → P1.M5.T1.S1 (abort coordination).
- **Reading `snapshot()` to build the replacement request** → P1.M6.T1.S1 (RequestBuilder).
- **Actual truncation / size-bounded eviction** → explicitly OUT OF MVP (PRD §23.5: "Future versions may
  introduce configurable limits."). The warn is the only overflow action.
- Any change to `src/config/index.ts`, `src/diagnostics/index.ts`, `src/types.ts`, `src/state/*`,
  `src/provider/*`, or `src/index.ts` → the inputs are immutable. No `package.json` / `tsconfig.json` /
  `.gitignore` changes. No new deps.

### Success Criteria

- [ ] `src/buffer/index.ts` exports `interface ThinkingEntry` (`readonly offset/timestamp/content`) +
      `class ReasoningBuffer` exactly as specified (ctor `(diagnostics, maximumBytes)`; private
      `entries`/`frozen`/`totalBytes`; all 5 methods).
- [ ] `append(delta)` pushes `{ offset: entries.length, timestamp: Date.now(), content: delta }`, advances
      `totalBytes += delta.length`, and — when the projected total exceeds `maximumBytes` — still appends
      AND emits one `warn("buffer.overflow", {entries, totalBytes, maximumBytes})` with NO delta content.
- [ ] `append(delta)` after `freeze()` throws `Error` (message cites `PRD §41`); leaves the buffer
      unchanged.
- [ ] `freeze()` is idempotent (never throws); `snapshot()`/`getByteSize()`/`reset()` never throw.
- [ ] `snapshot()` returns an `Object.isFrozen` array of frozen entry copies that is structurally
      independent of later appends (deep-copy guarantee).
- [ ] `reset()` clears entries, zeroes bytes, and clears `frozen` (so a subsequent `append` succeeds).
- [ ] Mode-A JSDoc on the module banner + every exported symbol; documents the lifecycle states
      (mutable → frozen → read-only → destroyed) per PRD §41 (work-item DOCS spec).
- [ ] `tests/reasoning-buffer.test.ts` covers order/offset/bytes, append-after-freeze throw, freeze
      idempotency, snapshot immutability + decoupling, getByteSize, reset-unfreezes, overflow-no-truncate
      + privacy-safe warn fields.
- [ ] `npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0 (new
      `dist/buffer/index.{js,d.ts}`); `npx bun test` → ALL green (new suite + the 9 existing suites, no
      regressions).
- [ ] No edits outside `src/buffer/index.ts` + the new `tests/reasoning-buffer.test.ts` (+ removing
      `src/buffer/.gitkeep`).

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact `Diagnostics` interface + the `maximumReasoningBufferBytes` config
field** (the two inputs, read from the landed `src/diagnostics/index.ts` and `src/config/index.ts`), the
**complete `ThinkingEntry` shape + every method body** (offset semantics, byte accounting, overflow warn,
freeze idempotency, deep-freeze snapshot, reset-unfreezes), the **exact throw/log contract** (which level,
which event name, which privacy-safe fields), the **full reference implementations** of both the source
file and the test file, and the **verified build/test commands** (`npx bun ...`; `tests/` excluded from
tsc). Every design ambiguity (string-vs-event arg, `ThinkingEntry` vs `ThinkingEvent` naming collision,
inject-byte-limit vs whole-Config, warn-once-vs-each, deep vs shallow snapshot freeze, reset-when-frozen)
is resolved in the research notes + implementation tasks.

### Documentation & References

```yaml
# PRD authority (PRD.md in repo root)
- url: PRD.md §23 "Reasoning Buffer"
  why: "THE charter: §23.2 'Append-only. Ordered. Immutable after capture.' §23.3 lifetime 'Allocated:
        beginning of reasoning. Destroyed: completion. Never reused.' §23.4 'grow only with reasoning
        events; answer text shall not be duplicated.' §23.5 'The MVP shall not truncate reasoning.'"
  critical: "Overflow = warn only, NEVER truncate (§23.5). Memory grows ONLY with reasoning events (§23.4
        → store deltas once, never the answer)."
- url: PRD.md §13.4 "Reasoning Buffer"
  why: "Responsibilities: Accumulate reasoning deltas / Track ordering / Track offsets / Track completion /
        Expose immutable snapshot / Reset after completion. Non-responsibilities: Summarization,
        Compression, Prompt engineering, Semantic analysis. 'The extension does not interpret reasoning.
        It merely preserves it.'"
  critical: "Opacity mandate: store the raw delta string; do NOT analyze, transform, or store
        contentIndex/partial. snapshot() MUST be immutable."
- url: PRD.md §32 "ReasoningBuffer Module"
  why: "Module spec: Responsibility 'Capture reasoning emitted before interruption'; Internal Representation
        = ordered entries with offsets; Operations append/freeze/snapshot/reset/getByteSize; Invariants
        (append-only, ordered, frozen-once immutable). Maps 1:1 to this class."
- url: PRD.md §41 "Buffer Ownership During Transition"
  why: "THE lifecycle this class's JSDoc must document (work-item DOCS spec): 'Before interruption →
        ReasoningBuffer mutable. After interruption → frozen. After replacement → read-only. After
        completion → destroyed.' append() throws once frozen (the mutable→frozen boundary)."
  critical: "The throw message MUST cite 'PRD §41' so a debugger instantly knows which ownership state was
        violated."
- url: PRD.md §45 "Memory Requirements"
  why: "'memory proportional only to captured reasoning … No assistant answer text shall be duplicated …
        Peak additional memory consumption linear with captured reasoning size and constant w.r.t. answer
        length.' → the buffer stores ONLY reasoning deltas; getByteSize() is that linear accounting."
- url: PRD.md §17 "State Invariants" → Capturing
  why: "'Capturing: Reasoning buffer immutable.' Explains WHY freeze() is called at the Aborting→Capturing
        boundary (P1.M5) and why append() throwing-when-frozen is the safety gate behind the FSM's
        Capturing→Restarting ordering."
- url: PRD.md §37 "Concurrency Model" → Ownership Rules
  why: "'No mutable state has multiple owners.' The buffer is the single owner of its entries; callers
        receive an immutable snapshot, never a live reference."
- url: PRD.md Appendix F "Coding Standards"
  why: "'State transitions represented explicitly using strongly typed constructs'; 'magic numbers
        centralized'; Mode-A JSDoc standard (Responsibility/Ownership/Lifecycle/Invariants/Failure
        modes/Consumed by). Mirror the existing module banners."
- url: PRD.md Appendix H "Security & Privacy Model" → Logging Rules
  why: "MAY log: event counts, timing. MUST NEVER log: reasoning text. → buffer.overflow/buffer.frozen
        fields are {entries, totalBytes, maximumBytes} ONLY. NEVER pass `delta`/`content` to diagnostics."
- url: PRD.md Appendix O INV-007
  why: "Buffer-capture invariant — drives the 'append-only, ordered, immutable after freeze' contract."

# INPUT: Diagnostics interface (DONE — P1.M1.T3.S1)
- file: src/diagnostics/index.ts
  why: "Exports `export interface Diagnostics { trace/debug/info/warn/error(event: string, fields?:
        Record<string,unknown>): void }`. Import as a TYPE: `import type { Diagnostics } from
        '../diagnostics'`. Call this.diagnostics.warn('buffer.overflow', {entries, totalBytes,
        maximumBytes}) etc."
  pattern: "warn/error route to sink.error; trace/debug/info route to sink.log. Object is frozen but you
        only call methods."
  gotcha: "No value import needed — Diagnostics is a type. The factory/StreamProxy passes a concrete
        createDiagnostics instance; tests pass a capturing stub."

# INPUT: maximumReasoningBufferBytes (DONE — P1.M1.T2.S1)
- file: src/config/index.ts
  why: "Exports `interface Config { maximumReasoningBufferBytes: number }` (default 8388608, validated
        isPositiveInteger). The factory passes `config.maximumReasoningBufferBytes` to the buffer ctor.
        This file is READ for the field name/shape — the buffer does NOT import it (it takes a bare number)."
  gotcha: "Inject the NUMBER, not the Config object (minimal coupling + trivially testable overflow). Do NOT
        import from '../config' in index.ts."

# Established SOURCE conventions to mirror (so buffer/index.ts feels native)
- file: src/diagnostics/index.ts   # Mode-A JSDoc banner + per-symbol JSDoc + frozen/readonly typing
  why: "THE style template: top banner (Responsibility/Ownership/Lifecycle/Invariants/Failure modes/
        'Consumed by:'), per-export JSDoc with Preconditions/Postconditions/Side effects, `readonly`
        fields, inline PRD citations. Mirror this banner structure."
- file: src/state/controller.ts    # class with private fields + injected diagnostics + lifecycle JSDoc
  why: "THE class template: `constructor(private readonly diagnostics: Diagnostics)` + private mutable
        fields + methods that throw-on-illegal-state citing a PRD section. controller.ts is the closest
        analogue (FSM) — buffer.ts is its data twin (capture lifecycle)."
- file: src/config/index.ts        # ReadonlySet/readonly/readonly arrays + Object.freeze discipline
  why: "Shows `readonly` interface fields + immutability typing. ThinkingEntry fields are `readonly`;
        snapshot() result is Object.freeze."

# Established TEST conventions to mirror
- file: tests/diagnostics.test.ts  # captureSink pattern → adapt to capture warn/debug calls
  why: "Shows how to capture emitted diagnostics lines + assert channel routing. Adapt: build a
        Diagnostics stub whose warn/debug push {event, fields} into arrays; assert on them."
- file: tests/stream-proxy.test.ts # class-named test file + noopDiagnostics stub + describe/test/expect
  why: "Confirms the test-file-named-after-the-class convention (proxy.ts → stream-proxy.test.ts) →
        index.ts(class ReasoningBuffer) → reasoning-buffer.test.ts. Also the noopDiagnostics stub shape."
- file: tests/transition-controller.test.ts # capturing Diagnostics builder + privacy/count assertions
  why: "The most recent sibling test (P1.M3.T1.S1). Shows a capturing Diagnostics builder that records
        {level, event, fields} and table-driven assertions over counts — ideal for asserting the overflow
        warn fires exactly once with privacy-safe fields."

# Consumer contracts (assume they land as specified; do NOT implement them here)
- file: plan/001_b0c6691bb424/architecture/module_contracts.md   # ReasoningBuffer interface sketch
  why: "Sketches append/freeze/snapshot/reset/getByteSize. NOTE it names the entry 'ThinkingEvent' and the
        arg append(event) — the WORK ITEM is authoritative and overrides both (append(delta: string),
        entry type 'ThinkingEntry'). See research/notes.md §2."
- file: PRD.md §51   # "No replacement request may begin before reasoning is frozen"
  why: "Explains the downstream consumer (RequestBuilder, P1.M6) depends on snapshot() being stable →
        freeze() must precede beginReplacement(). This subtask only provides the mechanism."
```

### Current Codebase tree (Phase 0–2 core landed; src/buffer/ is empty)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); type module; bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts          # factory (DONE; DO NOT touch)
│   ├── types.ts          # P1.M2.T1.S1 (DONE; DO NOT touch) — ThinkingEvent/ThinkingEventType INPUT (read-only)
│   ├── provider/{decorator,proxy}.ts  # DONE (DO NOT touch)
│   ├── state/{controller,coordinator}.ts # controller DONE (DO NOT touch); coordinator stub (DO NOT touch)
│   ├── config/index.ts   # DONE (DO NOT touch) — maximumReasoningBufferBytes INPUT
│   ├── diagnostics/index.ts # DONE (Diagnostics interface; DO NOT touch) — INPUT
│   └── buffer/
│       └── .gitkeep      # ← THIS SUBTASK: replace dir contents with index.ts (remove .gitkeep)
├── tests/
│   ├── smoke.test.ts                 # must stay green
│   ├── config.test.ts                # must stay green
│   ├── diagnostics.test.ts           # captureSink PATTERN to mirror; must stay green
│   ├── provider-decorator.test.ts    # must stay green
│   ├── factory.test.ts               # must stay green
│   ├── types.test.ts                 # must stay green
│   ├── stream-proxy.test.ts          # class-named test PATTERN to mirror; must stay green
│   ├── transition-controller.test.ts # capturing-Diagnostics PATTERN to mirror; must stay green
│   ├── golden/                       # P1.M2.T4.S1 (must stay green)
│   └── reasoning-buffer.test.ts      # ← THIS SUBTASK (NEW)
└── dist/                 # generated by tsc (git-ignored) — gains buffer/index.{js,d.ts}
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
src/buffer/
└── index.ts            # NEW (first file in the module dir; remove the now-redundant .gitkeep)
    #   • export interface ThinkingEntry { readonly offset: number; readonly timestamp: number;
    #     readonly content: string }
    #   • export class ReasoningBuffer { constructor(diagnostics, maximumBytes); private entries/frozen/
    #     totalBytes; append(delta); freeze(); snapshot(); getByteSize(); reset() }
    #   RESPONSIBILITY: be the single owner of pre-interruption reasoning deltas; append-only, ordered,
    #     opaque (never interprets content); freeze on interruption; expose an immutable snapshot.
    #   REUSED BY: StreamProxy (P1.M4.T2 appends + owns the instance), P1.M5 (calls freeze()),
    #              RequestBuilder (P1.M6 reads snapshot()).

tests/
└── reasoning-buffer.test.ts   # NEW — the capture-collection unit suite (bun:test)
    #   • order/offset/byte accounting; append-after-freeze throws (PRD §41); freeze idempotent;
    #     snapshot frozen + decoupled (deep copy); getByteSize; reset clears + unfreezes;
    #     overflow = warn (no truncation) with privacy-safe fields (no delta content).
    #   RESPONSIBILITY: prove the capture contract + immutability + privacy gate are enforced exactly.
```
**File responsibilities**: `index.ts` owns the reasoning-delta collection (one private `entries` array +
`frozen`/`totalBytes` gates + the 5 methods + diagnostics calls). It imports ONLY the `Diagnostics` **type**
(`import type`) — zero runtime value imports, zero deps. `reasoning-buffer.test.ts` owns the assertions;
imports the class + `ThinkingEntry` (values) + the `Diagnostics` type. No other file changes.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (append() is the ONLY throwing method): freeze()/snapshot()/getByteSize()/reset() NEVER throw.
// Only append() throws — and ONLY when frozen (the mutable→frozen boundary, PRD §41). freeze() is
// idempotent (calling twice is a safe no-op). reset() unfreezes unconditionally. If you make snapshot()
// throw on a frozen buffer, or freeze() throw when already frozen, you have broken the contract.

// CRITICAL (snapshot() MUST be a deep-ish frozen COPY): return
//   Object.freeze(this.entries.map((e) => Object.freeze({ ...e })))
// NOT `this.entries` (exposes live internals → later appends would mutate a "snapshot") and NOT a shallow
// copy without freezing (a caller could mutate entries / the array). The RequestBuilder (P1.M6) relies on
// a snapshot being stable for the lifetime of request construction.

// CRITICAL (overflow does NOT truncate): PRD §23.5 is explicit — "The MVP shall not truncate reasoning."
// When projected totalBytes > maximumBytes you STILL push the delta and STILL add its length; you ONLY
// additionally emit one warn. Truncation/eviction is explicitly a FUTURE feature. If you skip the append
// on overflow, the replacement request will be missing reasoning → silent data loss.

// CRITICAL (privacy — NEVER log delta content): diagnostics fields for buffer.overflow/buffer.frozen are
// {entries, totalBytes, maximumBytes} — COUNTS ONLY. PRD Appendix H forbids logging reasoning text. The
// buffer holds raw reasoning, so this discipline is load-bearing. Do NOT pass `delta`, `content`, or any
// entry into a diagnostics call, ever. (Tests assert this — see privacy gate.)

// GOTCHA (offset = entries.length evaluated BEFORE push): the work-item contract is literal:
//   this.entries.push({ offset: this.entries.length, timestamp: Date.now(), content: delta })
// `this.entries.length` at that point is the index the new entry WILL occupy (0,1,2,…). Evaluate it inline
// in the object literal — do NOT precompute into a variable AFTER a hypothetical length change.

// GOTCHA (delta.length is UTF-16 code units, not UTF-8 bytes): the work-item literally specifies
// `totalBytes += delta.length`. For the 8 MiB soft-warning threshold the difference is immaterial (a few %
// for astral/multibyte chars), and `.length` is O(1). True UTF-8 byte count would be `Buffer.byteLength(
// delta)` (Bun/Node) — do NOT switch unless a future PRD revision requires exact bytes. `.length` is the
// contract.

// GOTCHA (inject the NUMBER, not the Config): ctor is `(diagnostics, maximumBytes: number)`. Do NOT
// `import type { Config } from "../config"` — the buffer needs exactly one field; importing the whole
// Config couples it to fields it never uses and makes overflow testing heavier. The factory passes
// config.maximumReasoningBufferBytes.

// GOTCHA (isolatedModules + strict): Diagnostics is a TYPE → `import type { Diagnostics } from
// "../diagnostics"`. There are NO other value imports in index.ts (zero runtime deps). A plain `import`
// of a type-only symbol triggers isolatedModules errors under bundler resolution — always use `import type`.

// GOTCHA (ThinkingEntry vs ThinkingEvent NAME COLLISION): src/types.ts ALREADY exports `ThinkingEvent`
// (the STREAMING event union thinking_start|thinking_delta|thinking_end). The buffer entry type MUST be
// named `ThinkingEntry` (per the work item) — reusing `ThinkingEvent` would shadow a public type and
// confuse every downstream reader. Do NOT import ThinkingEvent from ../types.

// GOTCHA (warn EACH overflow, not once): the contract says "if totalBytes would exceed … log warning."
// Warn on every append that pushes the projected total over the limit (most literal, most testable).
// A once-only flag is a reasonable FUTURE refinement but adds state + a test surface; keep MVP literal.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke `npx bun run typecheck` / `npx bun run build`
// / `npx bun test`, NOT bare `tsc`/`bun`. package.json scripts resolve via `npx bun run <script>`.

// GOTCHA (tests/ excluded from the build): tsconfig exclude:["tests"] → typecheck validates src/ ONLY.
// The new test file is validated by `npx bun test` (Bun transpiles TS natively). Do NOT add tests/ to
// tsconfig include — that breaks the src/tests boundary.

// GOTCHA (remove the redundant .gitkeep): once src/buffer/index.ts exists, src/buffer/.gitkeep is dead
// weight. Delete it (git rm) for cleanliness — it no longer serves its "keep the empty dir in git" purpose.
```

---

## Implementation Blueprint

### Data models and structure

The single owned runtime collection + two gates. The two inputs are type/number-only:

```typescript
// INPUT — src/diagnostics/index.ts (P1.M1.T3.S1) — TYPE import only
export interface Diagnostics {
  trace(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

// INPUT — src/config/index.ts (P1.M1.T2.S1) — read-only reference; NOT imported by the buffer.
//   Config.maximumReasoningBufferBytes: number  // default 8388608, isPositiveInteger-validated
//   The factory passes this NUMBER into the buffer ctor.

// OWNED — this module
export interface ThinkingEntry {
  readonly offset: number;       // append-order index (0,1,2,…); PRD §13.4 "track offsets"
  readonly timestamp: number;    // epoch ms via Date.now()
  readonly content: string;      // the raw delta string; stored verbatim, never interpreted (PRD §13.4)
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE src/buffer/index.ts (the capture collection) + REMOVE src/buffer/.gitkeep
  - IMPORT (type ONLY — isolatedModules): `import type { Diagnostics } from "../diagnostics"`. NO value
    imports (zero runtime deps). Do NOT import from "../config" or "../types".
  - IMPLEMENT `export interface ThinkingEntry { readonly offset: number; readonly timestamp: number;
    readonly content: string }`.
  - IMPLEMENT `export class ReasoningBuffer`:
      constructor(private readonly diagnostics: Diagnostics, private readonly maximumBytes: number) {}
      private entries: ThinkingEntry[] = [];
      private frozen: boolean = false;
      private totalBytes: number = 0;
      append(delta: string): void
      freeze(): void
      snapshot(): readonly ThinkingEntry[]
      getByteSize(): number
      reset(): void
  - append(delta) body:
      if (this.frozen) {
        throw new Error("ReasoningBuffer is frozen: cannot append after freeze() (PRD §41)");
      }
      this.entries.push({ offset: this.entries.length, timestamp: Date.now(), content: delta });
      this.totalBytes += delta.length;
      if (this.totalBytes > this.maximumBytes) {
        this.diagnostics.warn("buffer.overflow", {
          entries: this.entries.length,
          totalBytes: this.totalBytes,
          maximumBytes: this.maximumBytes,
        }); // privacy-safe: counts ONLY — never `delta`/`content` (Appendix H)
      }
  - freeze() body:
      this.frozen = true; // idempotent — no throw on double-freeze
      this.diagnostics.debug("buffer.frozen", { entries: this.entries.length, totalBytes: this.totalBytes });
  - snapshot() body:
      return Object.freeze(this.entries.map((e) => Object.freeze({ ...e }))) as readonly ThinkingEntry[];
  - getByteSize() body: `return this.totalBytes;`
  - reset() body (NOTE: `entries` is `readonly` so CLEAR contents, do NOT reassign):
      this.entries.length = 0;
      this.frozen = false;
      this.totalBytes = 0;
      this.diagnostics.debug("buffer.reset", {});
  - JSDOC (Mode A): module banner (Responsibility / Ownership / Lifecycle [mutable→frozen→read-only→
    destroyed, PRD §41] / Invariants / Non-responsibilities [§13.4: no summarize/compress/interpret] /
    Failure modes / "Consumed by:") citing PRD §23/§13.4/§32/§41/§45; ThinkingEntry doc (offset/timestamp/
    content + opacity); EACH method's JSDoc with Preconditions/Postconditions/Side effects/"Throws" citing
    the relevant PRD section. Item DOCS spec: "Add JSDoc documenting lifecycle states (mutable → frozen →
    destroyed) per PRD §41."
  - NAMING: PascalCase class (ReasoningBuffer); camelCase methods/fields; the entry interface is
    ThinkingEntry (NOT ThinkingEvent — name collision with src/types.ts).
  - PLACEMENT: src/buffer/index.ts (module barrel; consumers import as "../buffer"). Remove the now-redundant
    src/buffer/.gitkeep.

Task 2: CREATE tests/reasoning-buffer.test.ts (the capture-collection unit suite)
  - IMPORT (value): { describe, test, expect } from "bun:test";
    { ReasoningBuffer } from "../src/buffer";  (and `type { ThinkingEntry }` if referenced).
  - IMPORT (type): Diagnostics from "../src/diagnostics".
  - IMPLEMENT a capturing Diagnostics builder (adapt tests/transition-controller.test.ts /
    tests/diagnostics.test.ts captureSink):
      type Level = "trace" | "debug" | "info" | "warn" | "error";
      interface Captured { level: Level; event: string; fields?: Record<string, unknown> }
      function makeCaptureDiag() {
        const events: Captured[] = [];
        const diag = {
          trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
          debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
          info:  (e, f) => events.push({ level: "info",  event: e, fields: f }),
          warn:  (e, f) => events.push({ level: "warn",  event: e, fields: f }),
          error: (e, f) => events.push({ level: "error", event: e, fields: f }),
        } as Diagnostics;
        return { diag, events };
      }
  - IMPLEMENT describe/test blocks covering (every Success Criterion + the contract):
      • append + snapshot preserve ORDER + CONTENT; offsets are 0,1,2,… (=== array index); timestamp is a
        positive finite number; getByteSize() === sum of delta.length; empty buffer → snapshot().length===0
        && getByteSize()===0.
      • append after freeze THROWS an Error whose message includes "PRD §41"; the buffer is unchanged
        (snapshot().length reflects only pre-freeze appends); no entry lost.
      • freeze is idempotent: freeze(); freeze(); → no throw; append() still throws.
      • snapshot is immutable + decoupled: Object.isFrozen(snap)===true; Object.isFrozen(snap[0])===true;
        appending more deltas after snapshot does NOT change the earlier snapshot (deep-copy); mutating a
        snapshot entry via cast throws in strict mode OR is ignored (assert it does not affect internals:
        a fresh snapshot().length still counts the new appends, the old one does not).
      • reset clears entries (snapshot().length===0), zeroes bytes (getByteSize()===0), and UNFREEZES:
        append() succeeds after reset(); freeze() then reset() then append() succeeds.
      • overflow — NO truncation: new ReasoningBuffer(diag, 10); append("0123456789") (exactly 10, no
        warn); append("x") (→ 11 > 10) → the "x" IS appended (snapshot().at(-1).content === "x"),
        getByteSize()===11, AND exactly one buffer.overflow warn fired with fields {entries, totalBytes,
        maximumBytes} and NO `content`/delta field.
      • privacy gate: across the overflow scenario, assert that NO captured warn/debug field VALUE equals
        any appended delta string (defense-in-depth on Appendix H — e.g. iterate captured events and assert
        none of their field values include "0123456789" / "x").
  - FOLLOW pattern: tests/transition-controller.test.ts (capturing Diagnostics builder + count assertions),
    tests/diagnostics.test.ts (captureSink), tests/stream-proxy.test.ts (describe/test/expect + class-named
    file).
  - PLACEMENT: tests/reasoning-buffer.test.ts.

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics (src/ now includes buffer/index.ts).
  - RUN: npx bun run build      → exit 0; dist/buffer/index.{js,d.ts} emitted.
  - RUN: npx bun test tests/reasoning-buffer.test.ts  → the new suite green.
  - RUN: npx bun test           → ALL green (reasoning-buffer + the 9 existing suites — no regressions).
  - RUN: Level 3/4 grep gates below.
```

### Implementation Patterns & Key Details

```typescript
// ── src/buffer/index.ts — COMPLETE reference (author verbatim, Mode-A JSDoc included) ──────────────

/**
 * # ReasoningBuffer — append-only capture of pre-interruption reasoning (PRD §23 / §13.4 / §32 / §41).
 *
 * **Responsibility** (PRD §32): "Capture reasoning emitted before interruption." This class is the
 * **single owner** (PRD §37 Ownership Rules: "No mutable state has multiple owners") of an ordered,
 * append-only collection of reasoning deltas. It is **deliberately opaque** (PRD §13.4): "The extension
 * does not interpret reasoning. It merely preserves it." It performs NO summarization, NO compression,
 * NO prompt engineering, NO semantic analysis (PRD §13.4 Non-responsibilities — all explicitly out of MVP).
 *
 * **Ownership**: one private `entries: ThinkingEntry[]`, a `frozen` gate, and a `totalBytes` counter.
 * Owns NO stream, NO abort controller, NO request. Callers receive an **immutable snapshot** — never a
 * live reference to the internal array.
 *
 * **Lifecycle states** (PRD §41 — Buffer Ownership During Transition — the work-item DOCS requirement):
 *  - **Mutable** (before interruption): `append()` allowed; `frozen === false`. (PRD §41 "Before
 *    interruption → ReasoningBuffer mutable.")
 *  - **Frozen** (after interruption): `append()` throws; `snapshot()` is the authoritative read. Reached
 *    via `freeze()`, called by abort coordination (P1.M5) at the Aborting→Capturing boundary (PRD §17:
 *    "Capturing → Reasoning buffer immutable"; PRD §41 "After interruption → frozen").
 *  - **Read-only** (after replacement): same frozen state once RequestBuilder (P1.M6) has snapshotted
 *    (PRD §41 "After replacement → read-only").
 *  - **Destroyed** (after completion): `reset()` returns to mutable (rebirth) for reuse, or — per PRD §23.3
 *    "Never reused" — the instance is simply discarded (GC'd) and a fresh buffer is allocated per request
 *    (PRD §41 "After completion → destroyed").
 *
 * **Invariants** (PRD §23.2 + §13.4 + Appendix O INV-007):
 *  - Append-only: entries are never edited, reordered, or removed (except wholesale `reset()`).
 *  - Ordered: offsets are `0,1,2,…` (monotonically increasing; PRD §13.4 "Track ordering / Track offsets").
 *  - Immutable after freeze: once frozen, `append()` throws (no further mutation).
 *  - No truncation (PRD §23.5): an append that would exceed `maximumBytes` still appends; only a `warn`
 *    is emitted. Truncation/eviction is an explicit FUTURE feature.
 *  - Memory proportional only to reasoning (PRD §23.4/§45): answer text is never duplicated here; the
 *    proxy already forwards answers.
 *
 * **Failure modes**: `append()` after `freeze()` throws `Error("… (PRD §41)")`. Every other method
 * (`freeze`/`snapshot`/`getByteSize`/`reset`) is total — it never throws. `freeze()` is idempotent.
 *
 * **Privacy** (PRD Appendix H — Logging Rules): the buffer holds raw reasoning text. Its diagnostics calls
 * (`buffer.overflow`, `buffer.frozen`, `buffer.reset`) pass ONLY event counts / byte totals — NEVER the
 * delta/`content`. Logging reasoning text is forbidden.
 *
 * Consumed by: StreamProxy (P1.M4.T2 — owns the per-request instance, appends `thinking_delta` deltas),
 * P1.M5 abort coordination (calls `freeze()`), RequestBuilder (P1.M6 — reads `snapshot()`).
 */
import type { Diagnostics } from "../diagnostics";

/**
 * One captured reasoning delta. The buffer's unit of storage (PRD §13.4 "Track ordering / Track offsets").
 *
 * Fields are `readonly` so a snapshot entry cannot be mutated by a holder; the internal entries are copied
 * (and frozen) on `snapshot()`.
 *
 * - `offset`    The entry's append-order index (`0,1,2,…`); monotonically increasing. (NOT a byte offset.)
 * - `timestamp` Epoch milliseconds via `Date.now()` at append time.
 * - `content`   The raw reasoning `delta` string, stored verbatim. The buffer NEVER interprets it
 *               (PRD §13.4) — no summarization, no transformation.
 *
 * Named `ThinkingEntry` (NOT `ThinkingEvent`) to avoid colliding with the streaming-event union
 * `ThinkingEvent` already exported from `src/types.ts`.
 */
export interface ThinkingEntry {
  /** Append-order index (`0,1,2,…`); equals the array position at push time. Monotonic (PRD §13.4). */
  readonly offset: number;
  /** Epoch ms at append time (`Date.now()`). */
  readonly timestamp: number;
  /** The raw reasoning delta string. Stored verbatim; never interpreted (PRD §13.4). */
  readonly content: string;
}

/**
 * Append-only, ordered, opaque capture of pre-interruption reasoning (PRD §23 / §13.4 / §32 / §41).
 * Single owner of its `entries`; exposes an immutable snapshot to readers (PRD §37).
 */
export class ReasoningBuffer {
  /** The append-only internal collection (PRD §23.2). Single writer = this instance. */
  private readonly entries: ThinkingEntry[] = [];
  /** The mutable→frozen gate (PRD §41). `false` until `freeze()`; cleared by `reset()`. */
  private frozen = false;
  /** Running byte accounting = sum of appended `delta.length` (PRD §13.4/§45). Drives the overflow gate. */
  private totalBytes = 0;

  /**
   * @param diagnostics  Shared structured logger (PRD §36). **Privacy (Appendix H):** only event counts
   *                     and byte totals are ever logged — NEVER the delta/`content`.
   * @param maximumBytes The soft ceiling (from `Config.maximumReasoningBufferBytes`, P1.M1.T2.S1). An
   *                     append whose projected total exceeds it still appends (PRD §23.5 — no truncation)
   *                     but emits one `buffer.overflow` warn.
   * @post `entries` is empty, `frozen === false`, `totalBytes === 0`.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly maximumBytes: number,
  ) {}

  /**
   * Append one reasoning delta to the end of the collection (PRD §13.4 "Accumulate reasoning deltas";
   * §23.2 "Append-only").
   *
   * - Preconditions: the buffer is mutable (`frozen === false`). `delta` is a string.
   * - Postconditions: a new `ThinkingEntry` is pushed with `offset = entries.length` (evaluated before the
   *   push), `timestamp = Date.now()`, `content = delta`; `totalBytes += delta.length`.
   * - Side effects: if the projected `totalBytes` exceeds `maximumBytes`, emits one
   *   `warn("buffer.overflow", {entries, totalBytes, maximumBytes})` — counts ONLY (Appendix H). The delta
   *   is still appended (PRD §23.5 — no truncation).
   * - @throws {Error} `ReasoningBuffer is frozen: cannot append after freeze() (PRD §41)` when `frozen`.
   */
  append(delta: string): void {
    if (this.frozen) {
      throw new Error("ReasoningBuffer is frozen: cannot append after freeze() (PRD §41)");
    }
    this.entries.push({ offset: this.entries.length, timestamp: Date.now(), content: delta });
    this.totalBytes += delta.length;
    if (this.totalBytes > this.maximumBytes) {
      this.diagnostics.warn("buffer.overflow", {
        entries: this.entries.length,
        totalBytes: this.totalBytes,
        maximumBytes: this.maximumBytes,
      });
    }
  }

  /**
   * Transition the buffer from mutable to frozen (PRD §41 "After interruption → frozen"; §17 "Capturing →
   * Reasoning buffer immutable"). After this, `append()` throws and `snapshot()` is the stable read.
   *
   * Idempotent: calling `freeze()` more than once is a safe no-op (does NOT throw). Called by abort
   * coordination (P1.M5) at the Aborting→Capturing boundary.
   *
   * - Preconditions: none (legal in any state; no-op if already frozen).
   * - Postconditions: `frozen === true`.
   * - Side effects: one `debug("buffer.frozen", {entries, totalBytes})` lifecycle milestone (counts only).
   */
  freeze(): void {
    this.frozen = true;
    this.diagnostics.debug("buffer.frozen", { entries: this.entries.length, totalBytes: this.totalBytes });
  }

  /**
   * Return an **immutable copy** of the captured entries (PRD §13.4 "Expose immutable snapshot"; §23.2
   * "Immutable after capture"). The result is a frozen array of frozen entry copies, structurally
   * independent of the live internal array — later `append()`/`reset()` do NOT mutate a snapshot already
   * taken.
   *
   * Legal whether or not the buffer is frozen (a snapshot is always a read-only projection). RequestBuilder
   * (P1.M6) reads this to construct the thinking-disabled replacement request.
   *
   * - Preconditions: none. Never throws.
   * - Postconditions: returns `readonly ThinkingEntry[]` with `Object.isFrozen(result) === true` and each
   *   `Object.isFrozen(result[i]) === true`.
   * - Side effects: none.
   */
  snapshot(): readonly ThinkingEntry[] {
    return Object.freeze(this.entries.map((entry) => Object.freeze({ ...entry }))) as readonly ThinkingEntry[];
  }

  /**
   * @returns the running byte total (sum of appended `delta.length`). Pure read; never throws, never logs.
   *          (PRD §13.4/§45 — linear accounting of captured reasoning size.)
   */
  getByteSize(): number {
    return this.totalBytes;
  }

  /**
   * Clear the collection and return to the mutable state (PRD §13.4 "Reset after completion"; §23.3
   * "Destroyed: completion"; §41 "After completion → destroyed"). Works regardless of the frozen state —
   * this is the path back to mutable.
   *
   * In practice a fresh `ReasoningBuffer` is allocated per request (PRD §23.3 "Never reused"); `reset()`
   * exists for completeness and for any future pooled/reused buffer.
   *
   * - Preconditions: none. Never throws (clears `frozen`).
   * - Postconditions: `entries` is empty, `frozen === false`, `totalBytes === 0`.
   * - Side effects: one `debug("buffer.reset", {})` lifecycle milestone.
   */
  reset(): void {
    this.entries.length = 0;
    this.frozen = false;
    this.totalBytes = 0;
    this.diagnostics.debug("buffer.reset", {});
  }
}
```

> **Note on `private readonly entries`**: marking the *reference* `readonly` is fine (the array's *contents*
> still mutate via `push`/`length=0`). If your linter dislikes `readonly` on a mutated array, drop the
> `readonly` modifier on `entries` (keep it on `diagnostics`/`maximumBytes`). The other two private fields
> (`frozen`, `totalBytes`) are reassigned, so they must NOT be `readonly`.

```typescript
// ── tests/reasoning-buffer.test.ts — COMPLETE reference (author verbatim) ─────────────────────────

import { describe, test, expect } from "bun:test";
import { ReasoningBuffer } from "../src/buffer";
import type { ThinkingEntry } from "../src/buffer";
import type { Diagnostics } from "../src/diagnostics";

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call (adapted from transition-controller.test.ts). */
function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info: (e, f) => events.push({ level: "info", event: e, fields: f }),
    warn: (e, f) => events.push({ level: "warn", event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}

describe("ReasoningBuffer — append + snapshot (order, offset, content, bytes)", () => {
  test("append preserves order/content; offset is the array index; bytes accumulate", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    expect(buf.snapshot()).toHaveLength(0);
    expect(buf.getByteSize()).toBe(0);

    buf.append("first");
    buf.append("second");
    buf.append("third");

    const snap = buf.snapshot();
    expect(snap.map((e) => e.content)).toEqual(["first", "second", "third"]);
    expect(snap.map((e) => e.offset)).toEqual([0, 1, 2]); // monotonic, === array index
    for (const e of snap) {
      expect(typeof e.timestamp).toBe("number");
      expect(Number.isFinite(e.timestamp)).toBe(true);
      expect(e.timestamp).toBeGreaterThan(0);
    }
    expect(buf.getByteSize()).toBe("first".length + "second".length + "third".length); // 5+6+5 = 16
  });
});

describe("ReasoningBuffer — freeze (mutable → frozen)", () => {
  test("append after freeze throws an Error citing PRD §41 and leaves the buffer unchanged", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("kept");
    buf.freeze();
    expect(() => buf.append("rejected")).toThrow(/PRD §41/);
    expect(buf.snapshot().map((e) => e.content)).toEqual(["kept"]); // unchanged
    expect(buf.getByteSize()).toBe("kept".length); // byte count unchanged
  });

  test("freeze is idempotent (calling twice does not throw)", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("a");
    expect(() => buf.freeze()).not.toThrow();
    expect(() => buf.freeze()).not.toThrow(); // idempotent
    expect(() => buf.append("b")).toThrow(/PRD §41/); // still frozen
  });
});

describe("ReasoningBuffer — snapshot immutability + decoupling", () => {
  test("snapshot is a frozen array of frozen entries", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("x");
    const snap = buf.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap[0])).toBe(true);
  });

  test("a snapshot is decoupled from later appends (deep copy)", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("one");
    const early = buf.snapshot();
    buf.append("two"); // mutate the live buffer AFTER taking the snapshot
    const late = buf.snapshot();
    expect(early.map((e) => e.content)).toEqual(["one"]); // earlier snapshot unaffected
    expect(late.map((e) => e.content)).toEqual(["one", "two"]); // fresh snapshot sees the new entry
  });
});

describe("ReasoningBuffer — reset (clear + unfreeze)", () => {
  test("reset clears entries, zeroes bytes, and unfreezes so append succeeds again", () => {
    const { diag } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 1_000_000);
    buf.append("a");
    buf.append("b");
    buf.freeze();
    buf.reset();
    expect(buf.snapshot()).toHaveLength(0);
    expect(buf.getByteSize()).toBe(0);
    expect(() => buf.append("c")).not.toThrow(); // unfrozen → mutable again
    expect(buf.snapshot().map((e) => e.content)).toEqual(["c"]);
    expect(buf.getByteSize()).toBe(1);
  });
});

describe("ReasoningBuffer — overflow (no truncation + privacy-safe warn)", () => {
  test("an append that would exceed the limit is STILL appended (no truncation, PRD §23.5)", () => {
    const { diag, events } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 10); // tiny ceiling
    buf.append("0123456789"); // exactly 10 → no warn
    expect(events.filter((c) => c.event === "buffer.overflow")).toHaveLength(0);

    buf.append("x"); // → 11 > 10
    // NOT truncated: the delta IS the last entry
    expect(buf.snapshot().at(-1)!.content).toBe("x");
    expect(buf.getByteSize()).toBe(11);
    // exactly one overflow warn
    const overflows = events.filter((c) => c.event === "buffer.overflow");
    expect(overflows).toHaveLength(1);
  });

  test("overflow warn fields are counts only — delta content is never logged (Appendix H)", () => {
    const { diag, events } = makeCaptureDiag();
    const buf = new ReasoningBuffer(diag, 4);
    const secret = "SUPER-SECRET-REASONING-TEXT";
    buf.append(secret); // exceeds 4 → overflow warn fires
    const overflows = events.filter((c) => c.event === "buffer.overflow");
    expect(overflows).toHaveLength(1);
    const fields = overflows[0].fields ?? {};
    // privacy-safe keys only
    expect(Object.keys(fields).sort()).toEqual(["entries", "maximumBytes", "totalBytes"].sort());
    // defense-in-depth: no field VALUE contains the secret delta
    for (const value of Object.values(fields)) {
      expect(String(value)).not.toContain(secret);
    }
  });
});
```

### Integration Points

```yaml
# This subtask ships the class ONLY — no wiring. The integration points are documented so the consuming
# subtasks (P1.M4.T2, P1.M5.T1.S1, P1.M6.T1.S1) know the exact contract to call.

STREAM_PROXY (P1.M4.T2 — owns the per-request instance):
  - construct: const buffer = new ReasoningBuffer(diagnostics, config.maximumReasoningBufferBytes);
  - on thinking_delta: buffer.append(event.delta);   // the .delta string (pi-ai dist/types.d.ts:272)
  - lifecycle: allocate at "start of reasoning" (PRD §23.3); discard at completion.

ABORT_COORDINATION (P1.M5.T1.S1 — calls freeze()):
  - at the Aborting→Capturing boundary: buffer.freeze();   // PRD §17 "Capturing → buffer immutable"

REQUEST_BUILDER (P1.M6.T1.S1 — reads the snapshot):
  - const reasoning = buffer.snapshot();   // readonly ThinkingEntry[], frozen; reuse for continuity

CONFIG (INPUT — read-only, NOT imported by the buffer):
  - source field: Config.maximumReasoningBufferBytes (src/config/index.ts; default 8388608)
  - passed as the `maximumBytes` ctor arg by the factory / StreamProxy.

DIAGNOSTICS (INPUT — injected instance):
  - events emitted by this module: buffer.overflow (warn), buffer.frozen (debug), buffer.reset (debug).
  - all fields are privacy-safe counts (Appendix H) — never reasoning content.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after creating src/buffer/index.ts — fix before proceeding.
npx bun run typecheck        # tsc --noEmit on src/ → 0 diagnostics (incl. buffer/index.ts)
npx bun run build            # tsc → exit 0; emits dist/buffer/index.{js,d.ts}

# Expected: Zero errors. If errors exist, READ the output and fix before proceeding. Common: forgetting
# `import type` for Diagnostics (isolatedModules), naming the entry type ThinkingEvent (collides with
# src/types.ts), or importing Config when you should inject the bare number.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the new component.
npx bun test tests/reasoning-buffer.test.ts -v

# Full suite — confirm zero regressions in the 9 existing suites.
npx bun test

# Expected: ALL green. If failing, debug root cause and fix the implementation (do NOT weaken the test).
# The snapshot-decoupling and overflow-no-truncate assertions are the most likely to catch a bug —
# returning this.entries directly (instead of a frozen deep copy) fails both.
```

### Level 3: Integration Testing (System Validation)

```bash
# This subtask has NO runtime integration of its own (the class is wired in by P1.M4.T2 onward). Verify
# the artifact compiles + the existing factory/decorator still load.
npx bun run build && echo "build OK"

# Smoke-load the compiled module to confirm the export surface (no runtime instantiation of consumers).
npx bun -e 'import("./dist/buffer/index.js").then(m => {
  const b = new m.ReasoningBuffer({trace(){},debug(){},info(){},warn(){},error(){}}, 100);
  b.append("hi"); b.freeze();
  const s = b.snapshot();
  console.log("entries:", s.length, "frozen:", Object.isFrozen(s), "bytes:", b.getByteSize());
  if (s.length !== 1 || !Object.isFrozen(s) || b.getByteSize() !== 2) process.exit(1);
  console.log("smoke OK");
});'

# Expected: "entries: 1 frozen: true bytes: 2" + "smoke OK", exit 0.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Privacy grep (Appendix H enforcement): confirm the source NEVER passes delta/content to diagnostics.
grep -nE "diagnostics\.(trace|debug|info|warn|error)\(" src/buffer/index.ts
# Expected: ONLY buffer.overflow {entries,totalBytes,maximumBytes}, buffer.frozen {entries,totalBytes},
# buffer.reset {}. Manually verify NO line references `delta`, `content`, or an entry object in fields.

# Contract grep: confirm the throw cites PRD §41 and the freeze gate is the ONLY throw.
grep -nE "throw|frozen|maximumBytes" src/buffer/index.ts
# Expected: exactly one `throw` (in append), guarded by `this.frozen`; message contains "PRD §41".

# Anti-over-engineering grep: confirm NO summarization/compression/interpretation crept in (PRD §13.4).
grep -niE "summar|compress|truncat|slice|substring|interpret|analyz|token" src/buffer/index.ts
# Expected: no matches (the buffer is a faithful, dumb log). "truncat" may appear ONLY in a JSDoc comment
# restating PRD §23.5 ("shall not truncate") — that is fine; flag if it appears in CODE.
```

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun run build` → exit 0 (new `dist/buffer/index.{js,d.ts}`).
- [ ] `npx bun test` → ALL green (new suite + 9 existing, no regressions).
- [ ] Privacy grep (Level 4) confirms no delta/content is ever logged.

### Feature Validation

- [ ] `append` + `snapshot` preserve order/content; offsets `0,1,2,…`; bytes accumulate (Level 2).
- [ ] `append` after `freeze` throws citing PRD §41; buffer unchanged (Level 2).
- [ ] `freeze` idempotent (Level 2).
- [ ] `snapshot` frozen + decoupled from later appends (deep copy) (Level 2).
- [ ] `reset` clears entries/bytes AND unfreezes (Level 2).
- [ ] Overflow: delta still appended (no truncation) + exactly one privacy-safe warn (Level 2).
- [ ] Smoke load (Level 3) prints "smoke OK".
- [ ] Error cases handled: append-after-freeze throws a clear, PRD-citing message.

### Code Quality Validation

- [ ] Follows existing codebase patterns (Mode-A JSDoc banner, `import type`, frozen/readonly typing,
      capturing-Diagnostics test stub) — mirrors `src/diagnostics/index.ts` + `src/state/controller.ts`.
- [ ] File placement matches the desired tree (`src/buffer/index.ts`, `tests/reasoning-buffer.test.ts`);
      `.gitkeep` removed.
- [ ] Anti-patterns avoided (check against Anti-Patterns section): no truncation, no content logging, no
      interpretation, no live-reference snapshot, no Config import.
- [ ] Dependencies properly managed: zero runtime value imports; only the `Diagnostics` type imported.

### Documentation & Deployment

- [ ] Module banner + every exported symbol has Mode-A JSDoc citing PRD §23/§13.4/§32/§41/§45.
- [ ] JSDoc documents the lifecycle states (mutable → frozen → read-only → destroyed) per PRD §41
      (work-item DOCS spec).
- [ ] No new environment variables or config keys (uses the existing `maximumReasoningBufferBytes`).

---

## Anti-Patterns to Avoid

- ❌ Don't truncate/evict on overflow — PRD §23.5 explicitly forbids it in MVP (warn only).
- ❌ Don't log reasoning content (delta/`content`) — PRD Appendix H forbids it; log counts only.
- ❌ Don't interpret/summarize/compress reasoning — PRD §13.4 Non-responsibilities; the buffer is opaque.
- ❌ Don't return `this.entries` (or a shallow copy) from `snapshot()` — expose a frozen deep copy so
  readers can't mutate internals or see later appends.
- ❌ Don't name the entry type `ThinkingEvent` — it collides with the streaming-event union in
  `src/types.ts`; use `ThinkingEntry` (the work-item name).
- ❌ Don't make `append` take a `ThinkingEvent`/event object — the contract is `append(delta: string)`
  (opaque; the StreamProxy extracts `.delta`).
- ❌ Don't import the whole `Config` — inject the bare `maximumBytes: number` (minimal coupling).
- ❌ Don't make `freeze`/`snapshot`/`getByteSize`/`reset` throw — only `append` throws (when frozen).
- ❌ Don't skip validation "because it should work" — run all 4 levels; the snapshot-decoupling and
  overflow-no-truncate assertions are the bug-catchers.
- ❌ Don't catch all exceptions — there is only one throw site (append-when-frozen); let it propagate.
- ❌ Don't hardcode the 8 MiB default inside the buffer — it comes from `maximumBytes` (ctor arg).
