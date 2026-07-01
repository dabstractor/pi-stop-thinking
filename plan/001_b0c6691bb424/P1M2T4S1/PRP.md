# PRP — P1.M2.T4.S1: Golden Replay Test Harness & Fixtures (`tests/golden/`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M2.T4.S1 (Phase 1 Event Proxy, 2 pts) — **build the Golden Replay test
> infrastructure that PROVES the Phase-1 success criterion** (PRD §50 Phase 1: *"Golden stream replay
> matches Pi output exactly"*; PRD §55.178: *"Capture real provider event streams. Replay through
> wrapper. Assert byte-for-byte equivalent downstream output when inactive."*). Concretely: a reusable
> `replayEvents(events)` helper that feeds a captured event stream through the (already-built,
> forward-only, transparent) `StreamProxy` and returns the downstream events, plus three named fixture
> streams (`normal_replay`, `no_reasoning_replay`, `error_replay`), plus the assertion that each replay
> deep-equals its fixture. Because the Phase-1 proxy is **pure forward-only** (no transition logic yet),
> every replay is byte-identical to its input by construction — this is the **inactive baseline
> regression net** that every later phase (P1.M4 detection, P1.M5 abort, P1.M7 splicing) must NOT break.
> **This is test infrastructure only — ZERO source-code edits.**
> **Builds on**: P1.M2.T2.S1 (`src/provider/proxy.ts` — `StreamProxy` DONE) which is the INPUT; the
> fixtures are typed `AssistantMessageEvent[]` from `@earendil-works/pi-ai` (re-exported by P1.M2.T1.S1).
> **Consumed by**: P1.M7 (full integration tests), P1.M8 (stress tests — replays a fixture thousands of
> times). The helper + fixtures are importable modules under `tests/golden/`.

---

## Goal

**Feature Goal**: Create a self-contained, **reusable** Golden Replay test harness under `tests/golden/`
that captures the Phase-1 invariant — *a stream replayed through the transparent `StreamProxy` comes
out byte-for-byte identical* — and locks it in as a regression guard for every later phase. The harness
centres on one async helper `replayEvents(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]>`
which (a) builds a mock `upstreamStreamFn` returning a **pre-filled** real `AssistantMessageEventStream`
that yields the entire `events` array then completes; (b) constructs `new StreamProxy(model, context,
options, mockUpstreamFn, diagnostics)` exactly as the decorator will in production (P1.M2.T3.S1); (c)
fully iterates `proxy.output` collecting every emitted event; (d) returns the collected array. Three
fixtures are defined — `normal_replay` (start → thinking_start → thinking_delta×2 → thinking_end →
text_start → text_delta×2 → text_end → done), `no_reasoning_replay` (start → text_start → text_delta×2 →
done), `error_replay` (start → error) — and the test asserts `expect(await replayEvents(fixture)).toEqual(fixture)`
for each (Bun deep structural equality).

**Deliverable** (three NEW files under `tests/golden/`, all importable; **no edits to `src/`**):
- `tests/golden/replay.ts` — exports the `replayEvents` helper + the shared test doubles it needs
  (`GOLDEN_MODEL`, `GOLDEN_CONTEXT`, `GOLDEN_OPTIONS`, `NOOP_DIAGNOSTICS`) + a `partialAssistantMessage`
  builder used by fixtures. Pure, importable, no top-level side effects.
- `tests/golden/fixtures.ts` — exports the three named fixtures (`NORMAL_REPLAY`, `NO_REASONING_REPLAY`,
  `ERROR_REPLAY`) as fully-typed `AssistantMessageEvent[]` with realistic provider-event shapes
  (carrying real `AssistantMessage` objects on `partial`/`message`/`error`).
- `tests/golden/golden-replay.test.ts` — a `bun:test` suite importing the helper + fixtures and
  asserting each `replayEvents(fixture)` deep-equals its fixture; plus a secondary assertion that the
  replay's terminal event matches the fixture's terminal (guards the single-terminal / `result()`
  contract, PRD §13.2).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → 0 diagnostics (unchanged —
tests/ is excluded from the build); `npx bun run build` → unchanged (no `src/` edits, no new dist);
`npx bun test` → all green, INCLUDING the new `tests/golden/golden-replay.test.ts` (discovered
recursively by Bun). For each of the three fixtures: `await replayEvents(fixture)` produces an array
that deep-equals (`toEqual`) the fixture, event-for-event, in order. No edits to any `src/` file, any
existing test, `package.json`, `tsconfig.json`, or `.gitignore`.

---

## Why

- **This subtask is the empirical proof of the Phase-1 milestone.** PRD §50 lists exactly one Phase-1
  success criterion: *"Golden stream replay matches Pi output exactly."* Until this harness exists that
  criterion is an uncheckable claim; with it, `npx bun test tests/golden/` is the green light. It is
  the closing artifact of the "Event Proxy" milestone (after P1.M2.T2.S1 built the proxy and
  P1.M2.T3.S1 wired it).
- **It is the inactive-baseline regression net for every later phase.** The forward-only proxy
  forwards events unchanged. Later phases ADD branches (reasoning detection, abort, splicing) that only
  activate when a stop is requested. If any of those branches ever leak into the *inactive* path
  (transform/suppress/reorder/duplicate an event when no shortcut was pressed), these golden replays
  fail (`toEqual` is strict). That is precisely the "byte-for-byte equivalent downstream output when
  inactive" guarantee PRD §55.178 mandates. Phase 2's "Transition Replay" (§55.179) tests the *active*
  path; this subtask owns the *inactive* path.
- **The infrastructure is explicitly reused.** The item OUTPUT says the helpers/fixtures are consumed
  by P1.M7 (integration) and P1.M8 (stress). So they must be clean, importable modules (not inline test
  code): P1.M8 stress loops `replayEvents(NORMAL_REPLAY)` thousands of times; P1.M7 composes the
  fixtures with a real decorator. Designing them as `replay.ts` + `fixtures.ts` now avoids rework later.
- **It is zero-risk to production code.** Nothing under `src/` is touched. The harness only exercises
  the already-landed `StreamProxy` the way the decorator will, so it also functions as additional
  characterization coverage for the proxy itself.

## What

Create three NEW files under `tests/golden/` (a new subdirectory; Bun discovers `*.test.ts` files in
subdirectories by default — verified with Bun 1.3.14):

1. **`tests/golden/replay.ts`** — exports:
   - `NOOP_DIAGNOSTICS: Diagnostics` — the no-op diagnostics stub (identical shape to the one in
     `tests/stream-proxy.test.ts` / `tests/provider-decorator.test.ts`).
   - `GOLDEN_MODEL`, `GOLDEN_CONTEXT`, `GOLDEN_OPTIONS` — minimal-but-typed stand-ins for the three
     positional ctor args of `StreamProxy` that are NOT the upstream fn. Only `model.id/.api/.provider`
     are ever read by the forward-only proxy (for diagnostics on the defensive path, which never fires
     in these replays). Cast to the exact ctor param types with `as never` (the suite's established
     style for synthetic doubles).
   - `partialAssistantMessage(over?): AssistantMessage` — a builder for the realistic
     `AssistantMessage` objects carried on every event's `partial`/`message`/`error` field. Returns a
     fully-populated message (role/content/api/provider/model/usage incl. `cost`/stopReason/timestamp)
     so the fixtures are realistic ("real provider event streams", PRD §55.178) and the deep-equal is
     meaningful.
   - **`async replayEvents(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]>`** — the
     harness. Builds a mock `upstreamStreamFn` (`ApiStreamSimpleFunction`) that returns a freshly
     `createAssistantMessageEventStream()` with EVERY event in `events` pre-pushed (the terminal event
     completes the stream in the same push — see research §2/§4), constructs
     `new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT, GOLDEN_OPTIONS, mockUpstreamFn, NOOP_DIAGNOSTICS)`,
     fully iterates `proxy.output` (`for await (const e of proxy.output) collected.push(e)`), and
     returns `collected`. Pure async function; no top-level side effects.
2. **`tests/golden/fixtures.ts`** — exports three named `AssistantMessageEvent[]`:
   - `NORMAL_REPLAY` — `start → thinking_start → thinking_delta ×2 → thinking_end → text_start →
     text_delta ×2 → text_end → done` (the canonical reasoning-then-answer lifecycle; PRD §38 legal
     ordering).
   - `NO_REASONING_REPLAY` — `start → text_start → text_delta ×2 → done` (a model that answers without
     reasoning — exercises the EC-003/EC-004 shape).
   - `ERROR_REPLAY` — `start → error` (PRD §42 FM / EC-019 "provider returns error immediately").
   - All events carry realistic `AssistantMessage` objects via `partialAssistantMessage()`; the `done`
     event uses `reason: "stop"` with a `message`; the `error` event uses `reason: "error"` with an
     `error` message (`stopReason: "error"`).
   - **Invariant (guardrail):** every fixture ENDS with a terminal (`done` or `error`). A fixture
     without a terminal would hang the replay (research §4) — this is enforced by the fixture design
     and documented in a module-banner note.
3. **`tests/golden/golden-replay.test.ts`** — `bun:test` suite (`import { describe, test, expect } from
   "bun:test"`) that imports `replayEvents` + the three fixtures and asserts, for each fixture:
   `expect(await replayEvents(FIXTURE)).toEqual(FIXTURE)` (Bun deep structural equality —
   byte-for-byte, in order). Plus one secondary test asserting the replay preserves the terminal event
   across all three fixtures (the single-terminal / one-`result()` contract, PRD §13.2 Guarantees).

**Out of scope** (owned by other subtasks — do NOT implement here):
- **Transition Replay** (the *active* / interrupted path) → PRD §55.179, P1.M7. This subtask is
  **inactive-only** (forward-only baseline).
- ANY change to `src/` (proxy, decorator, types, state, config, diagnostics, factory, index) → the
  proxy is an immutable INPUT here; do NOT modify it.
- Property tests (§55.180), stress tests (§55.181), chaos/race/fuzz → P1.M8.T4. (This subtask only
  provides the *harness* P1.M8 will drive; it does not implement the stress loop itself.)
- New `package.json` scripts, `tsconfig.json` changes, new deps, `.gitignore` changes → forbidden.
- Capturing streams from a LIVE network provider → out of scope; fixtures are hand-authored
  representative captures (the contract lists their exact event shapes).

### Success Criteria

- [ ] `tests/golden/replay.ts` exports `replayEvents`, `NOOP_DIAGNOSTICS`, `GOLDEN_MODEL`,
      `GOLDEN_CONTEXT`, `GOLDEN_OPTIONS`, `partialAssistantMessage` exactly as specified.
- [ ] `replayEvents` (a) builds a mock `ApiStreamSimpleFunction` returning a pre-filled real
      `AssistantMessageEventStream`, (b) constructs `new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT,
      GOLDEN_OPTIONS, mockUpstreamFn, NOOP_DIAGNOSTICS)`, (c) fully iterates `proxy.output` collecting
      events, (d) returns the collected array. No `setTimeout` pump required (microtask interleaving).
- [ ] `tests/golden/fixtures.ts` exports `NORMAL_REPLAY`, `NO_REASONING_REPLAY`, `ERROR_REPLAY`, each a
      fully-typed `AssistantMessageEvent[]` with the EXACT event sequences specified, each ending in a
      terminal (`done`/`error`), each event carrying a realistic `AssistantMessage`.
- [ ] `NORMAL_REPLAY` === `[start, thinking_start, thinking_delta, thinking_delta, thinking_end,
      text_start, text_delta, text_delta, text_end, done]` (10 events).
- [ ] `NO_REASONING_REPLAY` === `[start, text_start, text_delta, text_delta, done]` (5 events).
- [ ] `ERROR_REPLAY` === `[start, error]` (2 events).
- [ ] `tests/golden/golden-replay.test.ts` asserts `expect(await replayEvents(F)).toEqual(F)` for each
      of the three fixtures (deep-equal — byte-for-byte, in order).
- [ ] A secondary test asserts the replay's terminal event matches each fixture's terminal (single-
      terminal contract, PRD §13.2).
- [ ] `npx bun run typecheck` → **zero** diagnostics (unchanged — `tests/` excluded from build).
- [ ] `npx bun run build` → unchanged (no `src/` edits; no new dist files).
- [ ] `npx bun test tests/golden/` → all green; `npx bun test` → ALL green (no regressions in
      stream-proxy / provider-decorator / types / factory / diagnostics / config / smoke).
- [ ] Mode-A JSDoc on the module banners of `replay.ts` + `fixtures.ts` (responsibility / ownership /
      reuse-consumer / invariant, per Appendix F), citing PRD §50 Phase-1 + §55.178 + §13.2.
- [ ] No edits outside the three new `tests/golden/**` files.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact, verified `StreamProxy` constructor signature + `get output()`
surface** (read from the landed `src/provider/proxy.ts`), the **exact `AssistantMessageEvent` union
shape with per-variant required fields** (read from `@earendil-works/pi-ai/dist/types.d.ts:249`), the
**exact `EventStream` push/iterate semantics** that make pre-fill + natural completion correct (from
P1.M2.T2.S1 research), the **exact test-double idioms** to mirror (`noopDiagnostics`, `makeModel`,
`as never` casts — from the already-passing `tests/stream-proxy.test.ts`), the **complete reference
implementations of all three files**, and the **verified build/test commands** (Bun recurses into
`tests/golden/`; `tsc --noEmit` excludes `tests/`).

### Documentation & References

```yaml
# PRD authority (PRD.md in repo root)
- url: PRD.md §50 "Phase 1 — Event Proxy" → Success Criteria
  why: "THE success criterion this subtask proves: 'Golden stream replay matches Pi output exactly.'
        Single sentence; this harness is its executable form."
  critical: "Phase 1's success is judged by golden replay, so this harness is on the critical path of
        declaring the milestone done."
- url: PRD.md §55.178 "Golden Replay Tests"
  why: "'Capture real provider event streams. Replay through wrapper. Assert byte-for-byte equivalent
        downstream output when inactive.' → defines replayEvents + the deep-equal assertion."
  critical: "The keyword is 'when INACTIVE'. In Phase 1 the proxy is always inactive (no transition
        logic), so replay == input by construction. The active path is §55.179 Transition Replay
        (P1.M7) — NOT this subtask."
- url: PRD.md §55.179 "Transition Replay"
  why: "Boundary clarity: 'Capture interrupted reasoning. Replay interruption. Verify downstream stream
        continuity.' This is the ACTIVE/interrupted path — explicitly out of scope here (P1.M7)."
- url: PRD.md §13.2 "Stream Proxy" → Guarantees + §13.2 Invariant
  why: "The invariant the golden replay locks in: 'Exactly one message_start, one message_end, one
        completed result; no duplicates/missing/reordered.' The deep-equal + terminal test assert it."
- url: PRD.md §38 "Event Ordering Specification" + §39 "Transition Event Rules"
  why: "The LEGAL event ordering the fixtures model: start → thinking_* → text_* → (done|error).
        NORMAL_REPLAY follows it exactly; confirms done|error is the terminal pair."

# The INPUT module (DONE — read to author the helper against its REAL surface)
- file: src/provider/proxy.ts   # P1.M2.T2.S1 — DONE, the class replayEvents drives
  why: "Exports `class StreamProxy`. Constructor:
        (model: Model<Api>, context: Context, options: SimpleStreamOptions,
         upstreamStreamFn: ApiStreamSimpleFunction, diagnostics: Diagnostics).
        Read-only getter `get output(): AssistantMessageEventStream`. Constructor starts the forward-
        only pipeline fire-and-forget (`void this.run(...)`); run() never rethrows."
  pattern: "Construct it EXACTLY as the decorator will (P1.M2.T3.S1): `new StreamProxy(model, context,
        options, upstreamStreamFn, diagnostics)` then iterate `proxy.output`. The mock
        upstreamStreamFn must return a real AssistantMessageEventStream (the proxy does
        `for await (const event of upstreamStreamFn(...)) this._output.push(event)`)."
  critical: "DO NOT modify proxy.ts. It is an immutable input. The helper only CONSUMES it."

# EventStream runtime semantics (why pre-fill + natural completion works)
- file: plan/001_b0c6691bb424/P1M2T2S1/research/event-stream-internals.md
  why: "push() of a terminal (done|error) sets done=true AND resolves result() in the SAME call; the
        async iterator then returns {done:true} on the next next() → the consumer's for-await exits
        naturally. This is why pre-filling the whole fixture (including the terminal) completes both
        the upstream AND proxy.output without any explicit .end() or setTimeout pump."
  critical: "GOTCHA the inverse: if a fixture had NO terminal, the proxy's run() would exit on the
        upstream's natural end WITHOUT pushing a terminal to proxy.output → proxy.output never
        completes → the consumer for-await HANGS. Every fixture MUST end with done|error (enforced in
        fixture design)."

# pi-ai type surface (verified against installed @earendil-works/pi-ai@0.74.2)
- file: node_modules/@earendil-works/pi-ai/dist/types.d.ts   # line 249: AssistantMessageEvent union
  why: "The per-variant required fields the fixtures must satisfy. start/thinking_*/text_* need a
        `partial: AssistantMessage`; done needs `reason` + `message`; error needs `reason` + `error`.
        Use partialAssistantMessage() to build realistic values."
  critical: "reason on `done` is 'stop'|'length'|'toolUse'; reason on `error` is 'aborted'|'error'.
        The fixtures use 'stop' (normal/no_reasoning) and 'error' (error_replay)."
- file: node_modules/@earendil-works/pi-ai/dist/types.d.ts   # AssistantMessage interface + Usage + cost
  why: "Realistic AssistantMessage shape for partialAssistantMessage(): role:'assistant', content[],
        api, provider, model, usage{input,output,cacheRead,cacheWrite,totalTokens,cost{...}},
        stopReason, timestamp. Mirror the proxy's makeErrorAssistantMessage() zeroed-usage shape."
- file: node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts
  why: "AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage>;
        createAssistantMessageEventStream(): AssistantMessageEventStream. Exported from the package
        ROOT (index.d.ts line 26 `export * from './utils/event-stream.js'`)."
  critical: "Import createAssistantMessageEventStream from '@earendil-works/pi-ai' (root), NOT a deep
        './utils/event-stream' path."
- file: node_modules/@earendil-works/pi-ai/dist/api-registry.d.ts
  why: "ApiStreamSimpleFunction = (model, context, options?) => AssistantMessageEventStream. This is
        the EXACT type the mock upstreamStreamFn must satisfy to pass to StreamProxy's ctor."

# Established test conventions to mirror (so the new files feel native)
- file: tests/stream-proxy.test.ts   # P1.M2.T2.S1 — DONE
  why: "THE Bun test style + the noopDiagnostics stub + the makeModel() `as unknown as Parameters<
        typeof StreamProxy>[0]` idiom + the `as unknown as AssistantMessageEvent` synthetic-event cast.
        Mirror these verbatim. Its `drive()` helper is the conceptual sibling of replayEvents (but
        replayEvents pre-fills rather than pumps per-macrotask — see research §2)."
- file: tests/provider-decorator.test.ts   # P1.M1.T4.S1/P1.M2.T3.S1
  why: "Confirms the flat tests/ layout, `import { describe, test, expect } from 'bun:test'`,
        ../src/* imports, sentinel objects + `as never` casts, the noopDiagnostics stub. The new files
        live one level deeper (tests/golden/) but follow the SAME conventions."

# Parallel context (the wiring subtask — CONTRACT, assume it lands as-specified)
- file: plan/001_b0c6691bb424/P1M2T3S1/PRP.md   # being implemented in parallel
  why: "Defines how the decorator constructs the proxy in production:
        `const proxy = new StreamProxy(model, context, options, originalStreamSimple, this.diagnostics);
         return proxy.output;`. replayEvents mirrors this EXACT construction (with a mock upstream) so
        the golden harness characterizes the real production path."
  critical: "Do NOT depend on P1.M2.T3.S1 landing for THIS test to pass — replayEvents constructs the
        proxy DIRECTLY (not through the decorator), so it is independent of the wiring subtask. The
        only INPUT is the already-DONE proxy.ts."
```

### Current Codebase tree (Phase 0 + Phase 1 core landed; this is test-only)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); type module; bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts          # factory (DONE; DO NOT touch)
│   ├── types.ts          # P1.M2.T1.S1 (DONE; DO NOT touch) — re-exports AssistantMessageEvent
│   ├── provider/
│   │   ├── decorator.ts  # P1.M1.T4.S1 / P1.M2.T3.S1 (DO NOT touch)
│   │   └── proxy.ts      # DONE (P1.M2.T2.S1) — the INPUT replayEvents drives; DO NOT touch
│   ├── state/{controller,coordinator}.ts   # P1.M3 stubs (DO NOT touch)
│   ├── config/index.ts   # DONE (DO NOT touch)
│   └── diagnostics/index.ts # DONE (Diagnostics interface; DO NOT touch)
├── tests/
│   ├── smoke.test.ts                 # must stay green
│   ├── config.test.ts                # must stay green
│   ├── diagnostics.test.ts           # must stay green
│   ├── provider-decorator.test.ts    # pattern to mirror; must stay green
│   ├── factory.test.ts               # must stay green
│   ├── types.test.ts                 # must stay green
│   ├── stream-proxy.test.ts          # pattern to mirror (drive/noopDiagnostics/makeModel); stay green
│   └── golden/                       # ← THIS SUBTASK (NEW subdirectory)
│       ├── replay.ts                 # NEW — replayEvents helper + shared doubles + msg builder
│       ├── fixtures.ts               # NEW — NORMAL_REPLAY / NO_REASONING_REPLAY / ERROR_REPLAY
│       └── golden-replay.test.ts     # NEW — deep-equal assertions
└── dist/                 # generated by tsc (git-ignored) — UNCHANGED (no src edits)
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
tests/golden/
├── replay.ts                # NEW — the reusable Golden Replay harness
│   #   • replayEvents(events): Promise<AssistantMessageEvent[]>  (pre-fill mock → StreamProxy → collect)
│   #   • NOOP_DIAGNOSTICS, GOLDEN_MODEL, GOLDEN_CONTEXT, GOLDEN_OPTIONS  (shared test doubles)
│   #   • partialAssistantMessage(over?)  (realistic AssistantMessage builder for fixture events)
│   #   RESPONSIBILITY: prove a forward-only StreamProxy replays a captured stream byte-for-byte.
│   #   REUSED BY: tests/golden/golden-replay.test.ts (now), P1.M7 integration, P1.M8 stress.
├── fixtures.ts              # NEW — the named captured-stream fixtures
│   #   • NORMAL_REPLAY       (start → thinking_* → text_* → done)        [10 events]
│   #   • NO_REASONING_REPLAY (start → text_* → done)                     [ 5 events]
│   #   • ERROR_REPLAY        (start → error)                             [ 2 events]
│   #   RESPONSIBILITY: representative real provider event-stream captures (PRD §55.178).
│   #   REUSED BY: tests/golden/golden-replay.test.ts (now), P1.M7, P1.M8.
└── golden-replay.test.ts    # NEW — the assertion suite (bun:test)
    #   • for each fixture: expect(await replayEvents(F)).toEqual(F)   (byte-for-byte, in order)
    #   • terminal-preservation test across all three fixtures (PRD §13.2 single-terminal invariant)
    #   RESPONSIBILITY: lock the Phase-1 inactive-baseline invariant as a regression guard.
```
**File responsibilities**: `replay.ts` owns the harness (one pure async function + its doubles); it
imports ONLY the proxy + pi-ai. `fixtures.ts` owns the data (three typed arrays; imports the msg
builder from `./replay`). `golden-replay.test.ts` owns the assertions (imports the helper + fixtures).
No file imports anything from `src/` except `proxy.ts` (via `replay.ts`) and the `Diagnostics` type.
**Nothing under `src/` changes.**

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (every fixture MUST end with a terminal — else the replay HANGS): replayEvents iterates
// proxy.output with `for await`. proxy.output completes ONLY when the proxy forwards a terminal
// (done|error). The proxy forwards a terminal only if the UPSTREAM stream emits one. Because the mock
// is pre-filled with the entire fixture, the fixture's LAST event MUST be done|error so the terminal
// push completes proxy.output and the consumer's for-await exits naturally. A fixture ending in a
// non-terminal (e.g. text_end) → proxy.output never completes → the test hangs forever. All three
// fixtures end in a terminal by design; enforce it and document it in the fixtures.ts banner.

// CRITICAL (pre-fill, do NOT call upstream.end()): the contract says the mock "pushes all events then
// ends". In EventStream a terminal push ALREADY ends the stream (sets done + resolves result()).
// Calling stream.end() after the terminal push is a harmless no-op (done already true) — but calling
// it INSTEAD of a terminal (on a fixture lacking one) sets done=true on the upstream WITHOUT pushing a
// terminal to proxy.output, so proxy.output still never completes → hang. So: rely on the terminal
// push to "end" the stream; do not call end() in the mock. (matches proxy.ts: it never calls end().)

// CRITICAL (no setTimeout pump is needed — but the helper MUST be async and the consumer MUST fully
// drain): the proxy's run() is fire-and-forget (started in the ctor). The microtask queue interleaves
// run()'s forwarding with the consumer's iteration automatically: the consumer awaits when
// proxy._output is empty; run() pushes → delivers to the waiting consumer → consumer yields →
// re-awaits. This ping-pong preserves order with no explicit timers. replayEvents is `async` and
// `for await`s proxy.output to completion; it RETURNS (resolves) only after the terminal is collected.

// GOTCHA (the mock upstreamStreamFn must return a FRESH stream per call): construct the stream INSIDE
// the function body (`() => { const s = createAssistantMessageEventStream(); for (...) s.push(e);
// return s; }`), not a shared module-level stream. The proxy calls upstreamStreamFn exactly once per
// replay (inside run()), but freshness guarantees reentrancy if P1.M8 stress calls replayEvents in a
// tight loop (no stale done-state bleed between invocations).

// GOTCHA (import createAssistantMessageEventStream from the PACKAGE ROOT): it is re-exported via
// `export * from "./utils/event-stream.js"` in pi-ai's index. Use `from "@earendil-works/pi-ai"`, NOT
// a deep "./utils/event-stream" path (the package exports map does not expose utils/).

// GOTCHA (isolatedModules + type-only imports): AssistantMessageEvent, AssistantMessageEventStream,
// AssistantMessage, ApiStreamSimpleFunction are TYPES → `import type`. Only
// createAssistantMessageEventStream is a VALUE → plain `import`. Split them (stream-proxy.test.ts +
// proxy.ts do the same).

// GOTCHA (tests/ is excluded from the build): tsconfig exclude:["tests"] → `npx bun run typecheck`
// checks src/ ONLY. The new tests/golden/** files are validated by `npx bun test` (Bun transpiles TS
// natively). Do NOT add tests/golden to tsconfig include — that would put test files into the build
// emit and break the established boundary.

// GOTCHA (Bun discovers *.test.ts in subdirectories by default — VERIFIED): no bunfig.toml; Bun
// 1.3.14 recursively runs *.test.* files. tests/golden/golden-replay.test.ts WILL run under
// `npx bun test`. Non-test modules (replay.ts, fixtures.ts) are importable, not executed directly.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke as `npx bun ...` / `npx bun run <script>`,
// NOT bare `bun`/`tsc`. package.json scripts resolve via `npx bun run`.

// GOTCHA (privacy — Appendix H, inherited from proxy.ts): the harness's NOOP_DIAGNOSTICS stub is a
// no-op, so nothing is logged. Do NOT add any logging that prints context/options/event payloads.

// GOTCHA (deep-equal vs identity): the forward-only proxy forwards the SAME object references
// (`collected[i] === fixture[i]`). So `toEqual` passes trivially NOW — but it is the CORRECT
// assertion because it will FAIL if a later phase transforms/suppresses/reorders events in the
// inactive path. Do not weaken it to identity checks (toBe); use toEqual for byte-for-byte fidelity.
```

---

## Implementation Blueprint

### Data models and structure

There are no production data models. The fixtures are typed `AssistantMessageEvent[]` (the pi-ai
union, re-exported by `src/types.ts`). Each event variant requires the fields below (verified against
`@earendil-works/pi-ai/dist/types.d.ts:249`); use `partialAssistantMessage()` to build the realistic
`AssistantMessage` carried on `partial` / `message` / `error`:

```typescript
// AssistantMessageEvent variant → required fields
{ type: "start" }                                  + partial: AssistantMessage
{ type: "thinking_start", contentIndex }           + partial
{ type: "thinking_delta", contentIndex, delta }    + partial
{ type: "thinking_end",  contentIndex, content }   + partial
{ type: "text_start",    contentIndex }            + partial
{ type: "text_delta",    contentIndex, delta }     + partial
{ type: "text_end",      contentIndex, content }   + partial
{ type: "done",  reason: "stop"|"length"|"toolUse" } + message: AssistantMessage
{ type: "error", reason: "aborted"|"error" }        + error:   AssistantMessage
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE tests/golden/replay.ts (the harness + shared doubles)
  - IMPORT (value): createAssistantMessageEventStream from "@earendil-works/pi-ai"
  - IMPORT (type): AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream,
    ApiStreamSimpleFunction from "@earendil-works/pi-ai"; Diagnostics from "../../src/diagnostics";
    StreamProxy (VALUE, the class) from "../../src/provider/proxy".
  - IMPLEMENT NOOP_DIAGNOSTICS: Diagnostics = { trace(){},debug(){},info(){},warn(){},error(){} }
    (verbatim shape from tests/stream-proxy.test.ts).
  - IMPLEMENT GOLDEN_MODEL / GOLDEN_CONTEXT / GOLDEN_OPTIONS: minimal typed stand-ins for the 3
    positional ctor args (NOT the upstream fn). Only model.id/.api/.provider are read (defensive path
    only). Cast `as never` (suite style) to the ctor param types. e.g.
      GOLDEN_MODEL = { id:"glm-4.7", name:"GLM-4.7", api:"openai-completions", provider:"zai" } as never
      GOLDEN_CONTEXT = { messages: [] } as never
      GOLDEN_OPTIONS = { temperature: 0.7 } as never
  - IMPLEMENT partialAssistantMessage(over: Partial<AssistantMessage> = {}): AssistantMessage → returns
    a fully-populated message (role:'assistant', content:[], api:'openai-completions', provider:'zai',
    model:'glm-4.7', usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:'stop', timestamp:<fixed
    constant e.g. 1_700_000_000_000>, ...over). FIXED timestamp (not Date.now()) so deep-equal is
    deterministic across runs (a live Date.now() on the message would still pass because the SAME
    object is forwarded, but a fixed value is cleaner + safer if a future phase clones events).
  - IMPLEMENT async replayEvents(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]>:
      const mockUpstreamFn: ApiStreamSimpleFunction = (() => {
        const stream = createAssistantMessageEventStream();   // REAL pi-ai stream, fresh per call
        for (const e of events) stream.push(e);                // pre-fill ENTIRE fixture incl. terminal
        return stream;                                          // terminal push already completes it
      }) as ApiStreamSimpleFunction;
      const proxy = new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT, GOLDEN_OPTIONS, mockUpstreamFn,
                                    NOOP_DIAGNOSTICS);
      const collected: AssistantMessageEvent[] = [];
      for await (const event of proxy.output) collected.push(event);   // drain to natural completion
      return collected;
  - JSDOC (Mode A): module banner (responsibility/ownership/reuse-consumers/invariant per Appendix F,
    citing PRD §50 Phase-1 + §55.178 + §13.2); replayEvents doc (the 4 contract steps a–d + why pre-fill
    + natural completion works + the "every fixture must end in a terminal" guardrail).
  - NAMING: camelCase (replayEvents, partialAssistantMessage, GOLDEN_* constants); PascalCase for the
    imported StreamProxy class.
  - PLACEMENT: tests/golden/replay.ts. NO top-level side effects (exports only).

Task 2: CREATE tests/golden/fixtures.ts (the three named fixtures)
  - IMPORT (type): AssistantMessageEvent from "@earendil-works/pi-ai"; AssistantMessage from
    "@earendil-works/pi-ai".
  - IMPORT (value): partialAssistantMessage from "./replay".
  - IMPLEMENT three named exports, each AssistantMessageEvent[] (use `as never` casts on the synthetic
    events exactly as tests/stream-proxy.test.ts does, OR build them via a small typed `ev()` helper):
      NORMAL_REPLAY (10 events):
        start → thinking_start(ci:0) → thinking_delta(ci:0,"Let me think") →
        thinking_delta(ci:0," about this") → thinking_end(ci:0,"Let me think about this") →
        text_start(ci:1) → text_delta(ci:1,"Hello") → text_delta(ci:1," world") →
        text_end(ci:1,"Hello world") → done(reason:"stop", message: partialAssistantMessage())
      NO_REASONING_REPLAY (5 events):
        start → text_start(ci:0) → text_delta(ci:0,"Hi") → text_delta(ci:0,"!") →
        done(reason:"stop", message: partialAssistantMessage())
      ERROR_REPLAY (2 events):
        start → error(reason:"error", error: partialAssistantMessage({ stopReason:"error",
        errorMessage:"provider error" }))
    Every non-terminal event carries partial: partialAssistantMessage(); the contentIndex values follow
    the PRD §38 ordering (thinking at 0, text at 1 in NORMAL; text at 0 in NO_REASONING).
  - JSDOC (Mode A): module banner documenting (a) these are representative captures of real provider
    event streams (PRD §55.178); (b) the GUARDRAIL that every fixture MUST end in a terminal (done|
    error) or replayEvents hangs; (c) reused by P1.M7/P1.M8 (append-only additions only).
  - NAMING: SCREAMING_SNAKE_CASE constant exports (NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY) —
    the established convention for shared fixture constants.
  - PLACEMENT: tests/golden/fixtures.ts.

Task 3: CREATE tests/golden/golden-replay.test.ts (the assertion suite)
  - IMPORT: { describe, test, expect } from "bun:test"; { replayEvents } from "./replay";
    { NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY } from "./fixtures";
    type { AssistantMessageEvent } from "@earendil-works/pi-ai".
  - IMPLEMENT (bun:test):
      describe("Golden Replay — Phase 1 inactive baseline (PRD §55.178 / §50)", () => {
        test("NORMAL_REPLAY replays byte-for-byte through StreamProxy", async () => {
          expect(await replayEvents(NORMAL_REPLAY)).toEqual(NORMAL_REPLAY);
        });
        test("NO_REASONING_REPLAY replays byte-for-byte through StreamProxy", async () => {
          expect(await replayEvents(NO_REASONING_REPLAY)).toEqual(NO_REASONING_REPLAY);
        });
        test("ERROR_REPLAY replays byte-for-byte through StreamProxy", async () => {
          expect(await replayEvents(ERROR_REPLAY)).toEqual(ERROR_REPLAY);
        });
        test("every replay's terminal event matches its fixture's terminal (single-terminal, PRD §13.2)",
          async () => {
            for (const fixture of [NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY]) {
              const out = await replayEvents(fixture);
              expect(out.at(-1)).toEqual(fixture.at(-1));     // last event preserved (done|error)
              expect(["done","error"]).toContain(out.at(-1)!.type);  // it IS a terminal
              expect(out.length).toBe(fixture.length);         // no dup/missing
            }
          });
      });
  - FOLLOW pattern: tests/stream-proxy.test.ts (describe/test/expect, async tests, no extra config).
  - PLACEMENT: tests/golden/golden-replay.test.ts.

Task 4: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics (src/ only; tests/golden/** not in build by design).
  - RUN: npx bun run build      → unchanged (no src edits; no new dist files).
  - RUN: npx bun test tests/golden/  → the 4 golden tests green.
  - RUN: npx bun test           → ALL green (golden + stream-proxy + decorator + types + factory +
    diagnostics + config + smoke).
  - RUN: Level 3/4 gates below (grep assertions + the recursion-discovery smoke).
```

### Implementation Patterns & Key Details

```typescript
// ── tests/golden/replay.ts — COMPLETE reference (author verbatim, JSDoc included) ──────────────

/**
 * # Golden Replay — harness for the Phase-1 inactive-baseline invariant.
 *
 * **Responsibility** (PRD §50 Phase-1 success criterion + §55.178): prove that a captured provider
 * event stream, replayed through the transparent `StreamProxy`, produces byte-for-byte identical
 * downstream output while the feature is INACTIVE (forward-only; no transition logic). In Phase 1 the
 * proxy is always inactive, so every replay is identical to its input by construction — this harness
 * locks that in as a regression guard for every later phase (P1.M4 detection, P1.M5 abort, P1.M7
 * splicing) that adds ACTIVE branches which must NOT leak into the inactive path.
 *
 * **Ownership**: pure test helpers + shared doubles. Owns NO production state. Mutates nothing.
 *
 * **Reuse** (consumed by future milestones): `replayEvents` + the fixtures in `./fixtures` are
 * imported by P1.M7 (full integration) and P1.M8 (stress — replays a fixture thousands of times).
 *
 * **Invariant**: every fixture replayed by `replayEvents` MUST end with a terminal event (`done` or
 * `error`). The proxy forwards the terminal to `proxy.output`, which completes the stream and lets the
 * consumer's `for await` exit naturally. A fixture without a terminal would hang the replay. (PRD §13.2
 * single-terminal/single-result guarantee; enforced by the fixture design in `./fixtures`.)
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StreamProxy } from "../../src/provider/proxy";
import type {
  ApiStreamSimpleFunction,
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../../src/diagnostics";

/** No-op Diagnostics stub (same shape as tests/stream-proxy.test.ts). The forward-only replay path
 *  never logs in the happy case; this stub absorbs the proxy's defensive-path calls if they fire. */
export const NOOP_DIAGNOSTICS: Diagnostics = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as Diagnostics;

/** Minimal typed stand-ins for the 3 positional StreamProxy ctor args that are NOT the upstream fn.
 *  Only model.id/.api/.provider are read (defensive path only, which never fires on these replays). */
export const GOLDEN_MODEL = {
  id: "glm-4.7",
  name: "GLM-4.7",
  api: "openai-completions",
  provider: "zai",
} as never; // <- Parameters<typeof StreamProxy>[0]
export const GOLDEN_CONTEXT = { messages: [] } as never;
export const GOLDEN_OPTIONS = { temperature: 0.7 } as never;

/** Fixed timestamp so fixture messages are deterministic across runs (the forwarded event is the SAME
 *  object, but a fixed value is cleaner + clone-safe for future phases). */
const GOLDEN_TIMESTAMP = 1_700_000_000_000;

/**
 * Build a realistic, fully-populated {@link AssistantMessage} carried on a fixture event's
 * `partial` / `message` / `error` field. Usage/cost are zeroed (mirrors the proxy's own
 * makeErrorAssistantMessage shape); `over` lets callers override fields (e.g. stopReason:'error').
 */
export function partialAssistantMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "zai",
    model: "glm-4.7",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: GOLDEN_TIMESTAMP,
    ...over,
  } as AssistantMessage;
}

/**
 * Replay a captured event stream through the transparent {@link StreamProxy} and return the downstream
 * events. The Phase-1 proxy is forward-only, so the output is byte-for-byte identical to `events`
 * (proven by `toEqual` in golden-replay.test.ts).
 *
 * Steps (item contract):
 *  (a) build a mock {@link ApiStreamSimpleFunction} returning a REAL, PRE-FILLED
 *      `AssistantMessageEventStream` (every event pushed up front; the terminal push completes it);
 *  (b) construct `new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT, GOLDEN_OPTIONS, mockFn, NOOP_DIAGNOSTICS)`
 *      — exactly as the ProviderDecorator does in production (P1.M2.T3.S1);
 *  (c) fully iterate `proxy.output`, collecting every emitted event;
 *  (d) return the collected array.
 *
 * No `setTimeout` pump is needed: the proxy's fire-and-forget `run()` and the consumer's `for await`
 * interleave on the microtask queue (the consumer awaits while `proxy.output` is empty; `run()` pushes
 * → delivers to the waiter → consumer yields → re-awaits). The loop exits naturally once the terminal
 * event is forwarded and `proxy.output` completes.
 *
 * @param events A captured provider event stream. MUST end with a terminal (`done` or `error`).
 * @returns      The events as observed on `proxy.output` (byte-for-byte identical in Phase 1).
 */
export async function replayEvents(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]> {
  // (a) mock upstream: a fresh, fully-pre-filled real stream per call (reentrancy-safe for P1.M8 loops)
  const mockUpstreamFn: ApiStreamSimpleFunction = (() => {
    const stream = createAssistantMessageEventStream();
    for (const e of events) stream.push(e); // terminal push completes the stream in-place
    return stream;
  }) as ApiStreamSimpleFunction;

  // (b) construct the proxy exactly as production does
  const proxy = new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT, GOLDEN_OPTIONS, mockUpstreamFn, NOOP_DIAGNOSTICS);

  // (c)+(d) drain proxy.output to natural completion
  const collected: AssistantMessageEvent[] = [];
  for await (const event of proxy.output) {
    collected.push(event);
  }
  return collected;
}
```

```typescript
// ── tests/golden/fixtures.ts — COMPLETE reference (author verbatim, JSDoc included) ────────────

/**
 * # Golden Replay fixtures — representative captures of real provider event streams.
 *
 * **Responsibility** (PRD §55.178): the captured-stream inputs the harness replays. Three shapes
 * spanning the Phase-1 inactive surface: a full reasoning→answer lifecycle, a no-reasoning answer,
 * and an immediate error. All events carry realistic {@link AssistantMessage} objects (via
 * {@link partialAssistantMessage}) so the byte-for-byte deep-equal is meaningful.
 *
 * **GUARDRAIL (critical)**: EVERY fixture MUST end with a terminal event (`done` or `error`).
 * `replayEvents` iterates `proxy.output`, which completes only when the proxy forwards a terminal.
 * A fixture lacking a terminal would hang the replay forever. Do not add a non-terminal-ending
 * fixture.
 *
 * **Reuse**: consumed by `golden-replay.test.ts` (now), P1.M7 (integration), P1.M8 (stress).
 * Additions are APPEND-ONLY — never mutate an existing fixture (it would silently change the baseline).
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { partialAssistantMessage } from "./replay";

/** start → thinking_start → thinking_delta×2 → thinking_end → text_start → text_delta×2 →
 *  text_end → done. The canonical reasoning-then-answer lifecycle (PRD §38 legal ordering). */
export const NORMAL_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialAssistantMessage() },
  { type: "thinking_start", contentIndex: 0, partial: partialAssistantMessage() },
  { type: "thinking_delta", contentIndex: 0, delta: "Let me think", partial: partialAssistantMessage() },
  { type: "thinking_delta", contentIndex: 0, delta: " about this", partial: partialAssistantMessage() },
  { type: "thinking_end", contentIndex: 0, content: "Let me think about this", partial: partialAssistantMessage() },
  { type: "text_start", contentIndex: 1, partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 1, delta: "Hello", partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 1, delta: " world", partial: partialAssistantMessage() },
  { type: "text_end", contentIndex: 1, content: "Hello world", partial: partialAssistantMessage() },
  { type: "done", reason: "stop", message: partialAssistantMessage() },
] as never;

/** start → text_start → text_delta×2 → done. A model that answers without reasoning
 *  (EC-003/EC-004 shape). */
export const NO_REASONING_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialAssistantMessage() },
  { type: "text_start", contentIndex: 0, partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 0, delta: "Hi", partial: partialAssistantMessage() },
  { type: "text_delta", contentIndex: 0, delta: "!", partial: partialAssistantMessage() },
  { type: "done", reason: "stop", message: partialAssistantMessage() },
] as never;

/** start → error. A provider that fails immediately (EC-019 / FM). */
export const ERROR_REPLAY: AssistantMessageEvent[] = [
  { type: "start", partial: partialAssistantMessage() },
  { type: "error", reason: "error", error: partialAssistantMessage({ stopReason: "error", errorMessage: "provider error" }) },
] as never;
```

```typescript
// ── tests/golden/golden-replay.test.ts — COMPLETE reference (author verbatim) ──────────────────

import { describe, test, expect } from "bun:test";
import { replayEvents } from "./replay";
import { NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY } from "./fixtures";

describe("Golden Replay — Phase 1 inactive baseline (PRD §55.178 / §50)", () => {
  test("NORMAL_REPLAY replays byte-for-byte through StreamProxy", async () => {
    expect(await replayEvents(NORMAL_REPLAY)).toEqual(NORMAL_REPLAY);
  });

  test("NO_REASONING_REPLAY replays byte-for-byte through StreamProxy", async () => {
    expect(await replayEvents(NO_REASONING_REPLAY)).toEqual(NO_REASONING_REPLAY);
  });

  test("ERROR_REPLAY replays byte-for-byte through StreamProxy", async () => {
    expect(await replayEvents(ERROR_REPLAY)).toEqual(ERROR_REPLAY);
  });

  test("every replay's terminal event is preserved (single-terminal, PRD §13.2)", async () => {
    for (const fixture of [NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY]) {
      const out = await replayEvents(fixture);
      expect(out.length).toBe(fixture.length);                 // no duplicates / no drops
      expect(["done", "error"]).toContain(out.at(-1)!.type);   // last event IS a terminal
      expect(out.at(-1)).toEqual(fixture.at(-1));              // terminal preserved byte-for-byte
    }
  });
});
```

### Integration Points

```yaml
PRODUCTION CALL CHAIN (this harness mirrors it; it does NOT touch production):
  Production (P1.M2.T3.S1): wrapper.streamSimple → new StreamProxy(model, context, options,
                                     originalStreamSimple, diagnostics) → return proxy.output
  This harness (tests/golden/replay.ts):      new StreamProxy(GOLDEN_MODEL, GOLDEN_CONTEXT,
                                     GOLDEN_OPTIONS, mockUpstreamFn, NOOP_DIAGNOSTICS)
                                     → for await (proxy.output) collect → return collected

NO NEW MODULES UNDER src/: zero src/ edits. proxy.ts is an immutable INPUT (read, not modified).
NO NEW EXPORTS FROM src/: none.
NO CONFIG / ROUTES / DB / package.json / tsconfig.json / .gitignore CHANGES: none.

IMPORTS (the three new files):
  tests/golden/replay.ts:
    - value: createAssistantMessageEventStream (@earendil-works/pi-ai), StreamProxy (../../src/provider/proxy)
    - types:  ApiStreamSimpleFunction, AssistantMessage, AssistantMessageEvent (@earendil-works/pi-ai);
              Diagnostics (../../src/diagnostics)
  tests/golden/fixtures.ts:
    - types:  AssistantMessageEvent (@earendil-works/pi-ai)
    - value:  partialAssistantMessage (./replay)
  tests/golden/golden-replay.test.ts:
    - value:  describe, test, expect (bun:test); replayEvents (./replay);
              NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY (./fixtures)

REUSE CONTRACT (the future consumers — design the exports to satisfy these):
  P1.M7 (integration): imports { replayEvents } + fixtures, composes them with a real ProviderDecorator.
  P1.M8 (stress):      imports { replayEvents } + a fixture, calls it thousands of times (reentrancy:
                       mockUpstreamFn returns a FRESH stream per call → safe to loop).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — so this validates NO new code, but MUST still be clean):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics, UNCHANGED from before this subtask (tests/golden/** are not in the build).
#   If a diagnostic appears referencing tests/golden/*, someone added tests/ to tsconfig include —
#   REVERT that; the build/test boundary must stay intact.

# Build (must be a no-op — no src edits):
npx bun run build            # = tsc
# Expected: exit 0; dist/ UNCHANGED (no new files, no modified files). Verify:
git status --short dist/     # Expected: empty (no dist changes) — dist is git-ignored anyway.
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`.
> The new test files are validated by `npx bun test` (Bun transpiles TS natively), NOT by tsc.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the golden suite alone (Bun discovers it recursively under tests/golden/):
npx bun test tests/golden/
# Expected: 4 tests green:
#   • NORMAL_REPLAY replays byte-for-byte through StreamProxy
#   • NO_REASONING_REPLAY replays byte-for-byte through StreamProxy
#   • ERROR_REPLAY replays byte-for-byte through StreamProxy
#   • every replay's terminal event is preserved (single-terminal, PRD §13.2)
# If a test HANGS → a fixture lacks a terminal (see GUARDRAIL). Re-check fixtures.ts endings.

# Full suite (golden + every existing suite — no regressions):
npx bun test
# Expected: every suite green (golden + stream-proxy + provider-decorator + types + factory +
#   diagnostics + config + smoke).
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.
> Bun recursively runs `*.test.*` files; verified with Bun 1.3.14 (a subdir test was discovered).

### Level 3: Integration (Package Integrity)

```bash
# 3a. Confirm the helper is importable as authored TS and reproduces byte-for-byte replay directly:
node --input-type=module -e "
import { replayEvents } from './tests/golden/replay.ts';
import { NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY } from './tests/golden/fixtures.ts';
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const results = await Promise.all([
  replayEvents(NORMAL_REPLAY).then(o => deepEq(o, NORMAL_REPLAY)),
  replayEvents(NO_REASONING_REPLAY).then(o => deepEq(o, NO_REASONING_REPLAY)),
  replayEvents(ERROR_REPLAY).then(o => deepEq(o, ERROR_REPLAY)),
]);
console.log('golden replay all byte-for-byte:', results.every(Boolean), results);
" 2>/dev/null || npx bun --print "
import { replayEvents } from './tests/golden/replay.ts';
import { NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY } from './tests/golden/fixtures.ts';
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r = await Promise.all([
  replayEvents(NORMAL_REPLAY).then(o => deepEq(o, NORMAL_REPLAY)),
  replayEvents(NO_REASONING_REPLAY).then(o => deepEq(o, NO_REASONING_REPLAY)),
  replayEvents(ERROR_REPLAY).then(o => deepEq(o, ERROR_REPLAY)),
]);
JSON.stringify({ allByteForByte: r.every(Boolean), perFixture: r });
"
# Expected: allByteForByte: true  (all three replays reproduce their fixtures exactly).

# 3b. Reentrancy smoke (matters for P1.M8 stress reuse) — replay the same fixture many times fast:
npx bun --print "
import { replayEvents } from './tests/golden/replay.ts';
import { NORMAL_REPLAY } from './tests/golden/fixtures.ts';
let ok = 0;
for (let i = 0; i < 500; i++) {
  const out = await replayEvents(NORMAL_REPLAY);
  if (out.length === NORMAL_REPLAY.length) ok++;
}
JSON.stringify({ runs: 500, ok, freshStreamPerCall: ok === 500 });
"
# Expected: { runs: 500, ok: 500, freshStreamPerCall: true }  (mockUpstreamFn returns a fresh stream
# per call → no stale done-state bleed → safe for the P1.M8 stress loop).
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Zero-src-edits gate — the production source tree is untouched:
git add -A && git status --short
# Expected: only NEW files under tests/golden/ (replay.ts, fixtures.ts, golden-replay.test.ts).
#   ZERO changes under src/. ZERO changes to package.json / tsconfig.json / .gitignore / existing tests.

# Fixture-shape gates — exact event counts + terminal endings:
grep -c '"start"\|"done"\|"error"\|"thinking_start"\|"text_start"' tests/golden/fixtures.ts
# Expected: NORMAL_REPLAY has 1 start + 1 done; NO_REASONING has 1 start + 1 done; ERROR has 1 start + 1 error.
node -e "
import('./tests/golden/fixtures.ts').then(({ NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY }) => {
  const t = a => a.map(e => e.type);
  console.log('normal:', NORMAL_REPLAY.length, JSON.stringify(t(NORMAL_REPLAY)));
  console.log('no_reasoning:', NO_REASONING_REPLAY.length, JSON.stringify(t(NO_REASONING_REPLAY)));
  console.log('error:', ERROR_REPLAY.length, JSON.stringify(t(ERROR_REPLAY)));
  console.log('all end in terminal:', [NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY].every(f => ['done','error'].includes(f.at(-1).type)));
});
" 2>/dev/null || npx bun --print "
import { NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY } from './tests/golden/fixtures.ts';
const t = a => a.map(e => e.type);
JSON.stringify({
  normal: { n: NORMAL_REPLAY.length, types: t(NORMAL_REPLAY) },
  no_reasoning: { n: NO_REASONING_REPLAY.length, types: t(NO_REASONING_REPLAY) },
  error: { n: ERROR_REPLAY.length, types: t(ERROR_REPLAY) },
  allEndInTerminal: [NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY].every(f => ['done','error'].includes(f.at(-1).type)),
});
"
# Expected:
#   normal:        10  ["start","thinking_start","thinking_delta","thinking_delta","thinking_end",
#                       "text_start","text_delta","text_delta","text_end","done"]
#   no_reasoning:   5  ["start","text_start","text_delta","text_delta","done"]
#   error:          2  ["start","error"]
#   allEndInTerminal: true

# Helper gate — replayEvents does exactly the 4 contract steps + uses a real stream + the real proxy:
grep -n "createAssistantMessageEventStream()\|new StreamProxy\|for await (const event of proxy.output)\|return collected\|stream.push(e)" tests/golden/replay.ts
# Expected: exactly 1 each of: createAssistantMessageEventStream() (in mock), stream.push(e) (the pre-fill
#   loop), new StreamProxy(...) (construction), the for-await drain, return collected.

# Import-path gate — value vs type split, package-root import:
grep -n 'from "@earendil-works/pi-ai"' tests/golden/replay.ts   # Expected: 2 lines (value + type)
grep -n 'utils/event-stream' tests/golden/replay.ts             # Expected: ZERO (no deep import)
grep -n 'import type' tests/golden/replay.ts                    # Expected: present (types are type-only)
grep -n 'import { StreamProxy }' tests/golden/replay.ts         # Expected: 1 (VALUE import of the class)

# Boundary gate — NO production edits, NO setTimeout pump, NO end() call in the mock:
grep -rn "setTimeout\|\.end()" tests/golden/replay.ts           # Expected: ZERO (pre-fill + microtask)
grep -rn "src/" tests/golden/fixtures.ts tests/golden/golden-replay.test.ts
# Expected: ZERO (fixtures + test import only from ./replay + ./fixtures + pi-ai + bun:test).

# Scope gate — Transition Replay is NOT here (no shortcut/coordinator/abort/splice references):
grep -rni "shortcut\|coordinator\|abort\|splice\|transition replay\|interrupt" tests/golden/
# Expected: ZERO (this subtask is inactive-only; the active path is P1.M7 §55.179).
```

---

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics (unchanged — tests/ excluded from build).
- [ ] `npx bun run build` → unchanged (no src edits; no new/modified dist files).
- [ ] `npx bun test` → all green (golden + stream-proxy + provider-decorator + types + factory +
      diagnostics + config + smoke).

### Feature Validation

- [ ] `tests/golden/replay.ts` exports `replayEvents` performing the 4 contract steps (a–d).
- [ ] `tests/golden/fixtures.ts` exports `NORMAL_REPLAY` (10 events), `NO_REASONING_REPLAY` (5),
      `ERROR_REPLAY` (2), each with the exact specified sequences, each ending in a terminal.
- [ ] `tests/golden/golden-replay.test.ts` asserts `expect(await replayEvents(F)).toEqual(F)` for all
      three fixtures (byte-for-byte deep-equal).
- [ ] Terminal-preservation test passes (single-terminal invariant, PRD §13.2).
- [ ] The replay is byte-for-byte identical to its input (the Phase-1 inactive-baseline invariant).

### Code Quality Validation

- [ ] Mode-A JSDoc on module banners of `replay.ts` + `fixtures.ts` (responsibility / ownership /
      reuse-consumer / invariant, per Appendix F), citing PRD §50 + §55.178 + §13.2.
- [ ] Follows existing test conventions (`bun:test`, `noopDiagnostics`, `as never` casts, package-root
      pi-ai import, value/type import split).
- [ ] Files are importable modules (reusable by P1.M7/P1.M8), not inline-only test code.
- [ ] No edits to any `src/` file, any existing test, `package.json`, `tsconfig.json`, or `.gitignore`.

### Documentation & Deployment

- [ ] No new user-facing/config/API surface (test infrastructure only — item DOCS spec: "none").
- [ ] No new environment variables, scripts, or dependencies.

---

## Anti-Patterns to Avoid

- ❌ Don't edit ANY file under `src/` — `proxy.ts` is an immutable INPUT; the harness only CONSUMES it.
- ❌ Don't add a fixture that lacks a terminal (`done`/`error`) — `replayEvents` iterates `proxy.output`,
  which completes only when a terminal is forwarded; a non-terminal fixture hangs the replay forever.
- ❌ Don't call `upstream.end()` in the mock instead of pushing a terminal — it ends the UPSTREAM without
  forwarding a terminal to `proxy.output`, so `proxy.output` never completes → hang. Rely on the
  terminal `push` to complete the stream (matches proxy.ts, which never calls `end()`).
- ❌ Don't share one module-level upstream stream across `replayEvents` calls — build it FRESH inside the
  mock function body each call (reentrancy for the P1.M8 stress loop; no stale `done`-state bleed).
- ❌ Don't weaken the assertion to identity (`toBe`) — use `toEqual` (deep-equal) so a future phase that
  transforms/suppresses/reorders events in the inactive path FAILS the golden baseline.
- ❌ Don't add a `setTimeout` pump / macrotask flush to `replayEvents` — pre-fill + microtask interleaving
  is deterministic and matches the contract ("pushes all events then ends"). (The per-macrotask `drive()`
  in stream-proxy.test.ts is a DIFFERENT helper for a DIFFERENT purpose; do not copy its pump here.)
- ❌ Don't implement Transition Replay / the active path (shortcut, coordinator, abort, splice) — that is
  §55.179 / P1.M7. This subtask is the INACTIVE baseline only.
- ❌ Don't add `tests/golden` to `tsconfig.json` include — it would pull test files into the build emit
  and break the established src/tests boundary. Tests are validated by `npx bun test` only.
- ❌ Don't capture streams from a live network provider — the fixtures are hand-authored representative
  captures with the exact event shapes the contract specifies.
- ❌ Don't use a live `Date.now()` on fixture messages — use a fixed timestamp so deep-equal is
  deterministic and clone-safe if a future phase copies events.

---

## Confidence Score

**9/10** — one-pass success likelihood. This is pure test infrastructure over an already-DONE, stable
`StreamProxy` whose constructor + `get output()` surface are verified and inlined verbatim. The only
non-obvious risk (a fixture without a terminal hanging the replay) is called out explicitly as a
guardrail with a grep gate; the only design decision (pre-fill vs per-macrotask pump) is justified
against the contract wording and the verified `EventStream` semantics; and Bun's recursive test
discovery under `tests/golden/` was confirmed empirically with the installed Bun 1.3.14. The three
files are fully specified with complete reference implementations, so implementation is essentially
transcription + validation.
