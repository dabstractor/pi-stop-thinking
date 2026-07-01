# Research Notes — P1.M8.T1.S1: Telemetry recorder (privacy-safe metrics)

## 0. Contract recap (work-item description)

- **CREATE** `Telemetry` class with: `recordTransitionStarted(fields)`,
  `recordTransitionCompleted(fields)`, `recordTransitionFailed(fields)`, `incrementCounter(name)`.
- All methods are **no-ops if `!config.telemetryEnabled`**.
- All methods **wrap in try/catch** (PRD §35: "Telemetry failures are ignored").
- Maintain an internal **`Map<string, number>`** of counters.
- Methods record **timestamps and durations**.
- Telemetry data is **logged via `diagnostics` at `'info'` level** (structured JSON).
- **DOCS (Mode A):** JSDoc on `Telemetry` documenting all metric fields + the privacy constraints
  (no prompt/reasoning/output logging).
- INPUT: `Config.telemetryEnabled` (P1.M1.T2.S1). Timing data from `TransitionController`/proxy.
- OUTPUT: consumed by **StreamProxy** (transition lifecycle events) + **ShortcutManager**
  (ignored presses). Downstream consumer **P1.M8.T2** (failure-mode telemetry).

## 1. Diagnostics module — the emission sink (`src/diagnostics/index.ts`)

- `interface Diagnostics { trace/debug/info/warn/error(event: string, fields?: Record<string, unknown>): void }`
- `createDiagnostics(level: DiagnosticsLevel, sink?: DiagnosticsSink): Diagnostics` → returns a
  **frozen** object.
- Each emitted line = `JSON.stringify({ ...fields, ts: ISO8601, level, event })`. Caller `fields`
  spread FIRST, then reserved keys (`ts`/`level`/`event`) set authoritatively → caller cannot clobber
  `level`/`event`/`ts`. **Telemetry uses `diagnostics.info(event, fields)`.**
- Level filtering: `error < warn < info < debug < trace`. `info()` emits iff configured level weight
  is `>= info` (2). **Default `diagnosticsLevel === "error"`** → `info()` lines are SILENTLY DROPPED
  unless the user also lowers diagnostics level. Telemetry's in-memory counters Map is still
  maintained regardless (the Map is Telemetry-internal, not diagnostics-gated). This interaction is a
  DOCUMENTATION NOTE, not a bug (telemetry is best-effort; "must never affect functionality").
- **Privacy allow-list (fields that MAY be passed):** provider name, model identifier, transition id,
  timing metrics, event counts, state transitions, error categories. **Deny-list (NEVER, even
  nested):** prompt text, assistant output, reasoning output, API keys, authorization headers, tool
  arguments, tool outputs. → ALL Telemetry fields (ids/provider/model/timestamps-ms/durations/
  success/category/phase/counter name+value) fall under the ALLOW-list. Telemetry is privacy-safe by
  construction. Enforced by caller discipline (the logger does not scrub).
- Test sink pattern (`tests/diagnostics.test.ts`): inject a capturing `DiagnosticsSink` with
  `logs: string[]` + `errors: string[]`; assert `JSON.parse(line)`. Also common: a stub `Diagnostics`
  capturing `{level,event,fields}` into an array (see `tests/shortcut-manager.test.ts::makeCaptureDiag`).

## 2. Config — the enable flag (`src/config/index.ts`)

- `Config.telemetryEnabled: boolean` — **default `false`** (PRD Appendix K).
- `DEFAULT_CONFIG` is deep-frozen; `loadConfig()`/`validateConfig()` return a fresh valid `Config`.
- Telemetry needs ONLY the `telemetryEnabled` boolean (minimal coupling — mirrors how Diagnostics
  takes just `level`, not the whole `Config`). Constructor: `new Telemetry(telemetryEnabled, diagnostics)`.

## 3. PRD source — Telemetry schema (§35 + §56 + Appendix I)

### §35 Telemetry Module
- Responsibility: "Record operational metrics. Must never affect functionality. Telemetry failures are ignored."
- Metrics: reasoning duration, transition duration, abort latency, restart latency, completion latency,
  failure counts, success counts, ignored shortcut count.
- Privacy: "No prompts. No reasoning. No assistant output. No API keys. No user identifiers."

### §56 Observability — every transition emits structured telemetry; fields: Transition ID, Provider,
Model, Reasoning Duration, Transition Duration, Abort Latency, Replacement Startup, Completion Duration,
Outcome. "No prompt text. No reasoning text. No assistant output."

### Appendix I — Telemetry Schema (EXACT field sets)
- **TransitionStarted**: `transitionId, provider, model, timestamp, reasoningElapsedMs`
- **TransitionCompleted**: `transitionId, abortLatencyMs, restartLatencyMs, spliceLatencyMs,
  completionLatencyMs, totalDurationMs, success`
- **TransitionFailed**: `transitionId, failureCategory, failurePhase, provider, model, timestamp`
- **Failure Categories**: `AbortFailed | ReplacementRejected | ProviderTimeout | NetworkFailure |
  MalformedEvent | OrderingViolation | UnexpectedTermination | InternalError`
- **Performance Counters**: `RequestsDelegated | TransitionsRequested | TransitionsCompleted |
  TransitionsFailed | IgnoredShortcutPresses | AverageTransitionLatency | AverageAbortLatency |
  AverageRestartLatency`

## 4. Codebase conventions (MUST follow)

- **Module layout:** each module lives at `src/<module>/index.ts` (buffer, config, diagnostics,
  shortcut, state) → **Telemetry → `src/telemetry/index.ts`**. Tests are flat: `tests/<name>.test.ts`
  → **`tests/telemetry.test.ts`**.
- **DI pattern:** `Diagnostics` (and other shared deps) passed BY REFERENCE into every constructor
  (`new TransitionController(diagnostics)`, `new ShortcutManager(diagnostics)`). Telemetry follows:
  `new Telemetry(telemetryEnabled, diagnostics)`.
- **Class style:** classes own private state with `private readonly`; public read accessors where
  useful (`controller.getState()`, `proxy.authority`). Telemetry exposes `getCounter(name)` +
  `snapshot()` (read-only) for tests/future debug-dump.
- **JSDoc:** every module has a top-of-file `#`-heading module comment + per-member JSDoc citing PRD
  sections + an explicit "Privacy (Appendix H)" note where relevant (see diagnostics/controller/shortcut).
- **Never-crash / try-catch:** `incrementCounter` etc. must not throw (PRD §35 + Appendix E/K).
- **Bun test:** `bun:test` (`describe`/`test`/`expect`/`mock`). Capturing-diag stub pattern:
  `makeCaptureDiag()` returns `{ diag, events: {level,event,fields}[] }`.
- **Type naming:** interfaces `PascalCase`, fields `camelCase`, union string-literal types for enums.
- **Frozen surfaces:** where a factory returns an object it freezes it (`createDiagnostics`); a class
  with mutable internal state (controller, buffer) is NOT frozen. Telemetry has mutable counters → a
  (non-frozen) class.
- Build/test commands (verified in `package.json`): `npx bun run typecheck` (`tsc --noEmit`),
  `npx bun run build` (`tsc`), `npx bun test`. NO ruff/mypy/pytest — this is TS+Bun.

## 5. Consumer-wiring analysis (scope decision)

- **ShortcutManager wiring — SAFE (in-scope):** `src/shortcut/index.ts` is NOT touched by the
  parallel P1.M7.T3.S1. Add an optional `telemetry?: Telemetry` ctor param; count
  `IgnoredShortcutPresses` on the two "ignored" paths in `handlePress` — (a) the
  `coordinator.alreadyInterrupting()` early-return (EC-009/EC-010), (b) `coordinator.requestStop()`
  returning `false` (FM-001: not in Reasoning). Both are "a press that did not start a transition."
  Existing test (`tests/shortcut-manager.test.ts`) already exercises both paths (lines ~111 "already-
  interrupting" + ~131 `accepted===false`) → extend it to assert the counter via an injected Telemetry.
  `this._telemetry?.incrementCounter(...)` is a no-op when no telemetry wired (undefined).
- **StreamProxy wiring — DEFERRED (out-of-scope, documented, unblocked):** `recordTransitionStarted/
  Completed/Failed` require **latency instrumentation** (capture `performance.now()` at reasoning-
  start, stop-request, abort-complete, replacement-start, splice, completion → compute
  reasoningElapsedMs + abort/restart/splice/completion/total latencies) that does NOT yet exist in
  `proxy.ts`, AND `proxy.ts` is being actively rewritten by the parallel P1.M7.T3.S1 (constructor
  param list, `_terminate`, `_launchReplacement`, `run()` lifecycle). The Pi-extension FACTORY
  (`src/index.ts`) does NOT yet create the coordinator/proxy-with-telemetry/shortcut pipeline (per
  P1.M7.T3.S1's "Scope Boundary — factory wiring → out of scope"). Therefore: build the standalone
  Telemetry MODULE + its tests + the safe ShortcutManager integration NOW; defer the proxy-side
  timing instrumentation + factory wiring to the factory-integration task / P1.M8.T2 (which owns
  transition-failure telemetry anyway). The Telemetry module's types/methods are the exact contract
  those tasks consume. **No rework risk** — the module's public surface is fixed by Appendix I.

## 6. Average-counter math (design note)

`AverageTransitionLatency / AverageAbortLatency / AverageRestartLatency` are DERIVED from the latencies
carried by `recordTransitionCompleted` (`totalDurationMs / abortLatencyMs / restartLatencyMs`). They
are updated as a SIDE EFFECT of `recordTransitionCompleted` via an incremental running mean:
`avg ← avg + (value − avg)/n` (track `n` in a small helper Map). `incrementCounter(name)` is generic
`+1` for the FIVE simple integer counters and is NOT used for the averages (the contract lists
`incrementCounter(name)` as a single method; callers bump the simple counters, the class maintains
averages itself). The averages live in the SAME `_counters` Map so they appear in `snapshot()`.
