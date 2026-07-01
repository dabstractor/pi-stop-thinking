# Research Notes — P1.M2.T4.S1: Golden Replay Test Harness & Fixtures

## 1. Scope & contract

- **Phase 1 "Event Proxy" success criterion** (PRD §50 Phase 1): *"Golden stream replay matches Pi
  output exactly."* This subtask builds the infrastructure that PROVES that criterion.
- **PRD §55.178 Golden Replay Tests**: *"Capture real provider event streams. Replay through wrapper.
  Assert byte-for-byte equivalent downstream output when inactive."*
- **PRD §55.179 Transition Replay** (NOT this subtask — P1.M7 territory): captures *interrupted*
  reasoning and verifies downstream stream continuity during a transition.
- **Distinction**: "golden replay" = the feature is **inactive** (forward-only / no shortcut), so the
  proxy MUST be byte-identical. The forward-only `StreamProxy` (P1.M2.T2.S1, DONE) is ALWAYS inactive
  in Phase 1 → every replay is byte-identical by construction. This is the baseline regression guard
  that all later phases must NOT break.
- **OUTPUT** (item contract): test helpers + fixture files in `tests/golden/`. **No source changes.**
  Consumed by P1.M7 (full integration) + P1.M8 (stress) → helpers/fixtures MUST be importable modules.

## 2. The `replayEvents` helper — exactly what the contract asks

```
replayEvents(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]>
  (a) create a mock upstreamStreamFn returning a stream that pushes ALL events then ends
  (b) create a StreamProxy with that mock
  (c) iterate proxy.output, collect all emitted events
  (d) return the collected events
```

### Why pre-fill (not the per-macrotask pump) is correct here

- The contract literally says the mock "returns a stream that **pushes all events then ends**" → the
  mock stream is pre-filled with the whole fixture, then the proxy consumes it.
- All three fixtures END WITH A TERMINAL (`done`/`error`). A terminal `push` sets `stream.done=true`
  AND resolves `result()` in the same call (verified in P1.M2.T2.S1 research/event-stream-internals.md
  §2). So "then ends" is achieved by the terminal push itself — no explicit `.end()` needed (and
  `.end()` without a terminal would HANG the downstream; see §4).
- Deterministic interleaving is handled automatically by the microtask queue: `run()` is
  fire-and-forget (started in the ctor); the consumer's `for await (proxy.output)` awaits whenever
  `proxy._output` is empty; `run()` pushes → delivers to the waiting consumer → consumer yields →
  re-awaits. One event per ping-pong, in order. No explicit `setTimeout` pump required.

### The forwarding preserves object identity AND structure

- `proxy.run()` = `for await (const event of upstream) this._output.push(event)` — pushes the SAME
  object reference. So `collected[i] === fixture[i]`. Deep-equal (`toEqual`) passes trivially for the
  forward-only phase — but it is the RIGHT assertion because it catches any FUTURE phase that
  transforms/suppresses/reorders events in the inactive path.

## 3. Mock upstream is a pre-filled `AssistantMessageEventStream`

```ts
const upstreamStreamFn: ApiStreamSimpleFunction = (() => {
  const stream = createAssistantMessageEventStream(); // REAL pi-ai stream
  for (const e of events) stream.push(e);             // pre-fill entire fixture
  return stream;                                       // terminal push already completes it
}) as ApiStreamSimpleFunction;
```
- Uses the REAL `createAssistantMessageEventStream()` (matches item MOCKING spec + the proxy's ctor
  contract that `upstreamStreamFn` is `ApiStreamSimpleFunction`).

## 4. Gotcha — fixtures WITHOUT a terminal would hang (defensive note)

- If a fixture lacked a terminal, the proxy's `run()` would exit on the upstream iterator's natural
  end WITHOUT pushing a terminal to `proxy._output` → `proxy.output` never completes → the consumer's
  `for await` hangs forever.
- All THREE contract fixtures (normal / no_reasoning / error) END WITH a terminal, so this is safe.
- The PRP records this as a guardrail: every golden fixture MUST end with `done` or `error`.

## 5. `AssistantMessageEvent` required fields (verified types.d.ts:249)

| event                | required fields                                          |
|----------------------|----------------------------------------------------------|
| start                | `type:"start"` + `partial: AssistantMessage`             |
| thinking_start       | `type` + `contentIndex` + `partial`                      |
| thinking_delta       | `type` + `contentIndex` + `delta:string` + `partial`     |
| thinking_end         | `type` + `contentIndex` + `content:string` + `partial`   |
| text_start           | `type` + `contentIndex` + `partial`                      |
| text_delta           | `type` + `contentIndex` + `delta:string` + `partial`     |
| text_end             | `type` + `contentIndex` + `content:string` + `partial`   |
| done                 | `type:"done"` + `reason:"stop"\|"length"\|"toolUse"` + `message` |
| error                | `type:"error"` + `reason:"aborted"\|"error"` + `error`   |

→ Fixtures need realistic `AssistantMessage` objects for the `partial`/`message`/`error` fields (role,
content, api, provider, model, usage{...+cost{...}}, stopReason, timestamp). A shared `partialMessage()`
builder keeps fixtures realistic (the contract says "real provider event streams") without repetition.

## 6. Bun test discovery — subdirectory recursion (VERIFIED)

- `bunfig.toml`: none in repo → Bun defaults.
- Verified with Bun 1.3.14: a `*.test.ts` under a `sub/` directory IS discovered by bare `bun test`
  ("Ran 2 tests across 2 files"). → `tests/golden/*.test.ts` will run with `npx bun test`.
- Non-test helper modules (`replay.ts`, `fixtures.ts`) are NOT run as tests (no `.test.` infix) but ARE
  importable by the test + by P1.M7/P1.M8 tests later. ✓

## 7. tsconfig interaction

- `tsconfig.json` `exclude: ["node_modules","dist","tests"]` → `npx bun run typecheck` (tsc --noEmit)
  checks `src/` ONLY. The new `tests/golden/**` files are validated by `npx bun test` (Bun transpiles
  TS natively). Matches the existing convention (all tests live under tests/, excluded from build).
- `npx bun run build` (tsc) emits `dist/` from `src/` — UNCHANGED (no src edits). No new dist files.

## 8. Reuse contract for P1.M7 / P1.M8 (the future consumers)

- `tests/golden/replay.ts` → exports `replayEvents` + shared `GOLDEN_MODEL`/`GOLDEN_CONTEXT`/
  `GOLDEN_OPTIONS`/`NOOP_DIAGNOSTICS` doubles. P1.M8 stress tests can `replayEvents` a fixture
  thousands of times; P1.M7 integration tests can compose the fixtures with a real decorator.
- `tests/golden/fixtures.ts` → exports `NORMAL_REPLAY`, `NO_REASONING_REPLAY`, `ERROR_REPLAY`
  (`AssistantMessageEvent[]`). Stable named exports; additions are append-only.

## 9. Why this is the Phase-1 "golden" baseline

- The forward-only proxy is the inactive baseline. If any later phase (reasoning detection P1.M4,
  abort P1.M5, splicing P1.M7) accidentally alters the inactive forwarding path, these golden replays
  fail (`toEqual` catches transforms/suppresses/reorders/duplicates). That is exactly the regression
  net PRD §55.178 + the Phase-1 success criterion demand.
