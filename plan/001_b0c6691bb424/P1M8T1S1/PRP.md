# PRP — P1.M8.T1.S1: Telemetry recorder with privacy-safe metrics (`src/telemetry/index.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M8.T1.S1 (Phase 7 Hardening, 2 pts). Creates the **Telemetry** module (PRD §35 +
> §56 + Appendix I) — a privacy-safe operational-metrics recorder that is a **structural no-op** when
> `config.telemetryEnabled === false`, swallows its own failures (PRD §35 "Telemetry failures are
> ignored"), maintains an internal `Map<string, number>` of counters, and emits structured events via
> the shared `Diagnostics` logger at the `info` level.
> **OUTPUT**: the `Telemetry` class (4 public methods + read accessors) consumed by **ShortcutManager**
> (records `IgnoredShortcutPresses` — wired in this subtask) and, downstream, by **StreamProxy**
> (transition-lifecycle events — deferred to the factory-integration task / P1.M8.T2; see Scope
> Boundary) and **P1.M8.T2** (failure-mode telemetry).
> **PRIVACY (PRD §56 / Appendix H)**: telemetry records ONLY operational metadata (ids, provider, model,
> timestamps, durations, success, error categories, event counts). It **NEVER** sees/logs prompts,
> reasoning, assistant output, API keys, or user identifiers — enforced by field-type construction +
> JSDoc + a dedicated test.
> **MOCKING**: inject a capturing `Diagnostics` stub (`makeCaptureDiag()`) + a real `Telemetry` with
> `telemetryEnabled` toggled, assert counter Map + emitted `info` events + no-op-when-disabled +
> try/catch-swallow + privacy-safe field set.

---

## Goal

**Feature Goal**: Deliver a standalone, dependency-injected `Telemetry` module that records the PRD
Appendix I telemetry schema — three transition-lifecycle events (`TransitionStarted` /
`TransitionCompleted` / `TransitionFailed`) and eight performance counters — in a way that is
**privacy-safe by construction** (only allow-listed operational fields), **guaranteed non-fatal** (every
method no-ops when disabled; every method wraps its body in try/catch), and **observable** (events emit
as structured JSON via `Diagnostics.info`). Then wire the one safe, isolated consumer named in the
contract — `ShortcutManager` incrementing `IgnoredShortcutPresses` — so the module is proven against a
real caller.

**Deliverable** (ONE source file CREATED + ONE source file MODIFIED + TWO test files):
- `src/telemetry/index.ts` — **NEW**: the `Telemetry` class + exported field/failure-category/counter
  types (`TransitionStartedFields`, `TransitionCompletedFields`, `TransitionFailedFields`,
  `FailureCategory`, `CounterName`) + comprehensive Mode-A JSDoc.
- `tests/telemetry.test.ts` — **NEW** `bun:test` unit suite.
- `src/shortcut/index.ts` — **MODIFY**: add an optional `telemetry?: Telemetry` constructor param;
  call `this._telemetry?.incrementCounter("IgnoredShortcutPresses")` on both ignored-press paths.
- `tests/shortcut-manager.test.ts` — **MODIFY**: extend with an injected `Telemetry` asserting the
  `IgnoredShortcutPresses` counter increments (both paths) and that omitting telemetry is a safe no-op.

**Success Definition**: From a clean checkout (after P1.M7.T3.S1 is merged), `npx bun run typecheck` →
**0** diagnostics; `npx bun run build` → exit 0; `npx bun test` → **ALL green** (new `telemetry` suite +
the extended `shortcut-manager` suite + every pre-existing suite unchanged). PRD §35 invariants hold
operationally: telemetry never affects functionality (no-op when disabled; failures swallowed); PRD §56 /
Appendix H privacy holds (only operational fields ever emitted); PRD Appendix I field sets are encoded
exactly.

---

## User Persona (if applicable)

**Target User**: Internal — the operator/developer of a Pi deployment using this extension (NOT the end
user whose reasoning is being interrupted). Telemetry surfaces aggregate operational health (transition
success/failure counts, average latencies, ignored-press volume) for debugging/performance tuning. The
end user experiences it only indirectly: it is invisible, never on the hot path, and never records their
content.

**Use Case**: An operator enables `telemetryEnabled` (and lowers `diagnosticsLevel` to `info`) to
observe how often Stop-Thinking transitions succeed, how long they take (abort/restart/splice/
completion/total latencies), which failure categories dominate, and how many shortcut presses are
ignored (mis-pressed outside reasoning, or auto-repeated mid-transition). The data is structured JSON,
one line per event — "No free-form parsing shall be required" (PRD §57).

**User Journey** (operational): set `telemetryEnabled: true` → run Pi → trigger transitions → read the
emitted `telemetry.transition.*` / `telemetry.counter` JSON lines from the diagnostics stream (or query
the in-memory counters via `snapshot()` in a future debug surface). No content ever appears.

**Pain Points Addressed**: (1) zero visibility into transition health today; (2) fear that "telemetry"
might leak sensitive prompts/reasoning — this module makes leakage *structurally impossible* (the field
types contain no content fields, full stop); (3) fear that telemetry might destabilize the extension —
this module is a no-op when disabled and swallows every failure.

---

## Why

- **It is the explicit PRD §35 module.** "Record operational metrics. Must never affect functionality.
  Telemetry failures are ignored." + the exact metrics (reasoning/transition duration, abort/restart/
  completion latencies, failure/success/ignored counts) + privacy ("No prompts. No reasoning. No
  assistant output. No API keys. No user identifiers.").
- **PRD §56 Observability**: "Every transition shall emit structured telemetry." with the enumerated
  field set and the triple "No prompt text. No reasoning text. No assistant output."
- **PRD Appendix I — Telemetry Schema** pins the EXACT event field sets + the failure-category union +
  the performance-counter names. This PRP encodes that schema verbatim as TypeScript types — the module
  is the single source of truth downstream consumers (proxy, P1.M8.T2) import.
- **It is the producer gate for P1.M8.T2 (failure-mode telemetry).** P1.M8.T2 will call
  `recordTransitionFailed({ failureCategory, failurePhase, … })` and `incrementCounter("TransitionsFailed")`
  — both must exist and be privacy-safe before that work begins.
- **It is the producer gate for the proxy-side lifecycle recording** (the factory-integration task will
  call `recordTransitionStarted/Completed` from `StreamProxy` once latency instrumentation is added).

---

## What

### Source: CREATE `src/telemetry/index.ts`

A self-contained module exporting the telemetry types + the `Telemetry` class. It imports ONLY
`../diagnostics` (type-only for the `Diagnostics` interface) — mirroring how `TransitionController`/
`ShortcutManager` depend on diagnostics. It imports NOTHING from config/proxy/state (it receives
`telemetryEnabled: boolean` + `diagnostics: Diagnostics` by constructor injection).

#### A. Exported types — the PRD Appendix I schema encoded verbatim

```typescript
import type { Diagnostics } from "../diagnostics";

/**
 * PRD Appendix I — Failure Categories (TransitionFailed.failureCategory). The closed union the proxy /
 * P1.M8.T2 classify every failure into. Match the PRD spelling/case EXACTLY.
 */
export type FailureCategory =
  | "AbortFailed"
  | "ReplacementRejected"
  | "ProviderTimeout"
  | "NetworkFailure"
  | "MalformedEvent"
  | "OrderingViolation"
  | "UnexpectedTermination"
  | "InternalError";

/**
 * PRD Appendix I — Performance Counter names. The FIVE simple integer counters are bumped via
 * {@link Telemetry.incrementCounter}; the THREE `Average*` counters are DERIVED (running mean) from the
 * latencies carried by {@link Telemetry.recordTransitionCompleted} and appear in {@link Telemetry.snapshot}.
 */
export type CounterName =
  | "RequestsDelegated"
  | "TransitionsRequested"
  | "TransitionsCompleted"
  | "TransitionsFailed"
  | "IgnoredShortcutPresses"
  | "AverageTransitionLatency"
  | "AverageAbortLatency"
  | "AverageRestartLatency";

/** PRD Appendix I — Event: TransitionStarted fields. `timestamp` defaults to `Date.now()` (epoch ms). */
export interface TransitionStartedFields {
  /** Correlates this transition's Started/Completed/Failed events (PRD §56). */
  transitionId: string;
  /** Provider id (allow-listed; Appendix H). e.g. `"zai"`. */
  provider: string;
  /** Model id (allow-listed; Appendix H). e.g. `"glm-4.6"`. */
  model: string;
  /** Milliseconds spent reasoning before the stop was requested (PRD §35 "Reasoning duration"). */
  reasoningElapsedMs: number;
  /** Epoch-ms when the transition started (PRD Appendix I `timestamp`). Defaults to `Date.now()`. */
  timestamp?: number;
}

/** PRD Appendix I — Event: TransitionCompleted fields (all durations in ms; no provider/model per PRD). */
export interface TransitionCompletedFields {
  transitionId: string;
  /** Latency from stop-request to upstream-abort-complete (PRD §35 "Abort latency"). */
  abortLatencyMs: number;
  /** Latency from abort-complete to the replacement stream's first event (PRD §35 "Replacement startup"). */
  restartLatencyMs: number;
  /** Latency of the splice handover (PRD §21). */
  spliceLatencyMs: number;
  /** Latency of the replacement answer stream to its terminal (PRD §35 "Completion duration"). */
  completionLatencyMs: number;
  /** Full reasoning→answer transition duration (PRD §35 "Transition duration"). Feeds AverageTransitionLatency. */
  totalDurationMs: number;
  /** Whether the transition produced a final answer (PRD §56 "Outcome"). */
  success: boolean;
}

/** PRD Appendix I — Event: TransitionFailed fields. `timestamp` defaults to `Date.now()` (epoch ms). */
export interface TransitionFailedFields {
  transitionId: string;
  /** One of {@link FailureCategory}. */
  failureCategory: FailureCategory;
  /** FSM phase at failure (e.g. `"abort"`, `"replacement"`, `"restart"`, `"splice"`, `"completion"`). */
  failurePhase: string;
  provider: string;
  model: string;
  timestamp?: number;
}
```

#### B. The `Telemetry` class

```typescript
/**
 * # Telemetry — privacy-safe operational-metrics recorder (PRD §35 + §56 + Appendix I + Appendix H).
 *
 * Records transition-lifecycle events + performance counters. **Must never affect functionality**
 * (PRD §35): every public method is a no-op when `telemetryEnabled === false`, AND every public method
 * wraps its body in `try/catch` so a telemetry fault can never propagate (PRD §35 "Telemetry failures
 * are ignored"; PRD Appendix E/K never-crash).
 *
 * Emission: each event is logged via the shared {@link Diagnostics} logger at the **`info`** level as
 * structured JSON (`{ ...fields, ts, level:"info", event }`). NOTE: the Diagnostics logger filters by
 * `config.diagnosticsLevel`; at the default `"error"` level `info()` lines are silently dropped — the
 * operator lowers `diagnosticsLevel` to `"info"` (or below) to SEE telemetry. The in-memory counters
 * (this Map) are ALWAYS maintained when enabled, regardless of diagnostics level.
 *
 * ## PRIVACY CONTRACT (PRD §56 + Appendix H — Logging Rules) — READ BEFORE ADDING A FIELD
 *
 * Only operational metadata is EVER recorded. The field types ({@link TransitionStartedFields} et al.)
 * are constructed so they CAN carry only: transition id, provider name, model id, timestamps, durations,
 * success boolean, error category, error phase, and counter name/value. The following MUST NEVER be
 * recorded — and the field types structurally cannot hold them:
 *  - Prompt text
 *  - Reasoning output
 *  - Assistant output
 *  - API keys / authorization headers
 *  - Tool arguments / tool outputs
 *  - User identifiers
 * A future maintainer adding a field MUST keep it on the Appendix H allow-list (provider, model,
 * transitionId, timing, event counts, state transitions, error categories) — see `tests/telemetry.test.ts`
 * "privacy" case which asserts the field set.
 *
 * ## Counters (Appendix I — Performance Counters)
 *
 * `incrementCounter(name)` does a generic `+1` on the five simple integer counters
 * (`RequestsDelegated`, `TransitionsRequested`, `TransitionsCompleted`, `TransitionsFailed`,
 * `IgnoredShortcutPresses`). The three `Average*` counters (`AverageTransitionLatency`,
 * `AverageAbortLatency`, `AverageRestartLatency`) are DERIVED as a running mean from the latencies in
 * {@link recordTransitionCompleted} (`totalDurationMs` / `abortLatencyMs` / `restartLatencyMs`); they are
 * NOT bumped by `incrementCounter`. All eight live in the same internal Map (visible via {@link snapshot}).
 *
 * Consumed by: `ShortcutManager` (P1.M8.T1.S1 — `IgnoredShortcutPresses`); `StreamProxy` (factory-integration
 * task — transition lifecycle events, once latency instrumentation lands); P1.M8.T2 (failure-mode telemetry).
 */
export class Telemetry {
  /** The internal counters store (PRD contract "Maintain internal counters Map<string, number>"). Holds
   *  the five simple counters AND the three running-average values. Populated lazily. */
  private readonly _counters = new Map<string, number>();
  /** Per-average sample count backing the incremental running mean (`avg ← avg + (v−avg)/n`). */
  private readonly _averageSamples = new Map<string, number>();

  /**
   * @param telemetryEnabled  Whether ANY recording occurs (PRD `config.telemetryEnabled`, default `false`).
   *                          When `false`, every public method returns immediately — no Map mutation, no log.
   * @param diagnostics       Shared structured logger (PRD §36). Telemetry calls `diagnostics.info(...)`.
   *                          Passed by reference from the extension factory (same instance every module shares).
   */
  constructor(
    private readonly telemetryEnabled: boolean,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** PRD Appendix I — emit `TransitionStarted`. No-op + never-throws when disabled/faulting. */
  recordTransitionStarted(fields: TransitionStartedFields): void { /* see Implementation Blueprint */ }

  /** PRD Appendix I — emit `TransitionCompleted` AND update the three Average* running means. */
  recordTransitionCompleted(fields: TransitionCompletedFields): void { /* see Blueprint */ }

  /** PRD Appendix I — emit `TransitionFailed`. */
  recordTransitionFailed(fields: TransitionFailedFields): void { /* see Blueprint */ }

  /** Generic `+1` on a simple counter (Appendix I). Emits a `telemetry.counter` info event. */
  incrementCounter(name: CounterName): void { /* see Blueprint */ }

  /** Read one counter (simple OR average). `undefined` if never recorded. Pure read; never throws. */
  getCounter(name: CounterName): number | undefined { return this._counters.get(name); }

  /** Read-only shallow copy of ALL counters (for tests / future debug dump). Pure; never throws. */
  snapshot(): Readonly<Record<string, number>> { return Object.fromEntries(this._counters); }
}
```

#### C. Method bodies (the `/* see Blueprint */` above)

Every public method follows the **identical two-guard shape**: (1) `if (!this.telemetryEnabled) return;`
then (2) the real work inside `try { … } catch { /* swallow — PRD §35 */ }`. The shared `_updateAverage`
helper backs the three derived counters.

```typescript
recordTransitionStarted(fields: TransitionStartedFields): void {
  if (!this.telemetryEnabled) return;
  try {
    this.diagnostics.info("telemetry.transition.started", {
      transitionId: fields.transitionId,
      provider: fields.provider,
      model: fields.model,
      reasoningElapsedMs: fields.reasoningElapsedMs,
      timestamp: fields.timestamp ?? Date.now(), // epoch ms (Appendix I `timestamp`)
    });
  } catch {
    // PRD §35 — telemetry failures are ignored. Never propagate.
  }
}

recordTransitionCompleted(fields: TransitionCompletedFields): void {
  if (!this.telemetryEnabled) return;
  try {
    // Derive the three Average* counters (running mean) from the carried latencies.
    this._updateAverage("AverageTransitionLatency", fields.totalDurationMs);
    this._updateAverage("AverageAbortLatency", fields.abortLatencyMs);
    this._updateAverage("AverageRestartLatency", fields.restartLatencyMs);
    this.diagnostics.info("telemetry.transition.completed", {
      transitionId: fields.transitionId,
      abortLatencyMs: fields.abortLatencyMs,
      restartLatencyMs: fields.restartLatencyMs,
      spliceLatencyMs: fields.spliceLatencyMs,
      completionLatencyMs: fields.completionLatencyMs,
      totalDurationMs: fields.totalDurationMs,
      success: fields.success,
    });
  } catch {
    // PRD §35 — swallow.
  }
}

recordTransitionFailed(fields: TransitionFailedFields): void {
  if (!this.telemetryEnabled) return;
  try {
    this.diagnostics.info("telemetry.transition.failed", {
      transitionId: fields.transitionId,
      failureCategory: fields.failureCategory,
      failurePhase: fields.failurePhase,
      provider: fields.provider,
      model: fields.model,
      timestamp: fields.timestamp ?? Date.now(),
    });
  } catch {
    // PRD §35 — swallow.
  }
}

incrementCounter(name: CounterName): void {
  if (!this.telemetryEnabled) return;
  try {
    const next = (this._counters.get(name) ?? 0) + 1;
    this._counters.set(name, next);
    this.diagnostics.info("telemetry.counter", { name, value: next });
  } catch {
    // PRD §35 — swallow.
  }
}

/**
 * Incremental running mean: `avg ← avg + (value − avg)/n` (n = sample count for THIS average). Backs the
 * three `Average*` counters from {@link recordTransitionCompleted}. Private; never throws (callers wrap).
 */
private _updateAverage(name: CounterName, value: number): void {
  const n = (this._averageSamples.get(name) ?? 0) + 1;
  this._averageSamples.set(name, n);
  const prev = this._counters.get(name) ?? value; // first sample → avg === value
  this._counters.set(name, prev + (value - prev) / n);
}
```

> **Why pass `fields` by spreading named keys (not `...fields`)?** Explicit keys make the privacy-
> allow-list auditable at a glance and let `timestamp` default inline. `...fields` would also be correct
> (the field types hold only allow-listed fields) but less self-documenting; explicit is preferred here.

### Source: MODIFY `src/shortcut/index.ts` — wire `IgnoredShortcutPresses`

Add an optional `telemetry?: Telemetry` constructor param (every existing caller is unchanged — it
defaults to `undefined`). Store it as `private readonly _telemetry?`. Count `IgnoredShortcutPresses` on
**both** ignored-press paths in `handlePress` (the `alreadyInterrupting()` early-return = EC-009/EC-010,
and `requestStop()` returning `false` = FM-001 not-in-Reasoning). `this._telemetry?.incrementCounter(...)`
is a safe no-op when no telemetry is wired.

```typescript
import type { Telemetry } from "../telemetry"; // ◄ type-only (telemetry imports only ../diagnostics → no cycle)

export class ShortcutManager {
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly _telemetry?: Telemetry, // ◄ NEW (P1.M8.T1.S1) — optional; production omits → undefined (no-op)
  ) {}

  private handlePress(coordinator: StopRequestCoordinator): void {
    try {
      if (coordinator.alreadyInterrupting()) {
        this._telemetry?.incrementCounter("IgnoredShortcutPresses"); // ◄ EC-009/EC-010
        this.diagnostics.trace("shortcut.ignored", { reason: "already-interrupting" });
        return;
      }
      const accepted = coordinator.requestStop();
      if (!accepted) {
        this._telemetry?.incrementCounter("IgnoredShortcutPresses"); // ◄ FM-001 (not in Reasoning)
      }
      this.diagnostics.trace("shortcut.forwarded", { accepted });
    } catch (err) {
      this.diagnostics.error("shortcut.handler-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // …register / unregister unchanged…
}
```

> **No cycle:** `shortcut` → (type-only) `telemetry`; `telemetry` → (type-only) `diagnostics`. Both edges
> are type-only, erased at compile. `shortcut` already imports `diagnostics` at runtime — adding a
> type-only `telemetry` import introduces zero runtime coupling.

### Test: CREATE `tests/telemetry.test.ts`

A `bun:test` unit suite. Reuse the capturing-Diagnostics stub pattern from
`tests/shortcut-manager.test.ts::makeCaptureDiag` (a stub `Diagnostics` pushing
`{level, event, fields}` into an array) — NOT the `DiagnosticsSink`-with-strings pattern (the stub gives
direct object assertions without `JSON.parse`). Construct `new Telemetry(true, diag)` (enabled) and
`new Telemetry(false, diag)` (disabled) from the SAME capturing diag.

Coverage (each its own `test`):

1. **No-op when disabled:** `new Telemetry(false, diag)`; call all four record/increment methods with
   valid fields; ASSERT `diag.events.length === 0` (nothing emitted) AND `telemetry.snapshot()` is `{}`
   AND `getCounter("TransitionsRequested")` is `undefined` (no Map mutation).
2. **recordTransitionStarted emits the right event + fields:** enabled; call with `{transitionId:"t1",
   provider:"zai", model:"glm-4.6", reasoningElapsedMs: 250}`; ASSERT one `info` event,
   `event === "telemetry.transition.started"`, fields contain `{transitionId, provider, model,
   reasoningElapsedMs, timestamp}` where `timestamp` is a number (the `Date.now()` default).
3. **recordTransitionStarted honors an explicit timestamp:** pass `timestamp: 1234567890`; ASSERT the
   emitted `timestamp` field === `1234567890` (caller-supplied wins over the default).
4. **recordTransitionCompleted emits all seven fields AND updates the three averages:** call with
   `{transitionId:"t9", abortLatencyMs:100, restartLatencyMs:200, spliceLatencyMs:10,
   completionLatencyMs:500, totalDurationMs:1000, success:true}`; ASSERT the `telemetry.transition.completed`
   info event carries all seven fields verbatim; ASSERT `getCounter("AverageTransitionLatency")===1000`,
   `getCounter("AverageAbortLatency")===100`, `getCounter("AverageRestartLatency")===200` (first sample).
5. **Averages are a running mean (second sample):** call recordTransitionCompleted twice with
   `totalDurationMs: 1000` then `2000`; ASSERT `getCounter("AverageTransitionLatency")===1500` (mean of
   1000 & 2000). (Proves the incremental formula, not a naive overwrite.)
6. **recordTransitionFailed emits the right fields incl. failureCategory + failurePhase:** call with
   `{transitionId:"t7", failureCategory:"ProviderTimeout", failurePhase:"replacement", provider:"zai",
   model:"glm-4.6"}`; ASSERT `telemetry.transition.failed` info event with exactly those fields + a numeric
   `timestamp`.
7. **incrementCounter bumps +1 and emits a counter event:** enabled; `incrementCounter("TransitionsRequested")`
   thrice; ASSERT `getCounter("TransitionsRequested")===3`; ASSERT three `telemetry.counter` info events
   with `{name:"TransitionsRequested", value}` where value is 1,2,3 respectively.
8. **Each simple counter is independent:** bump `IgnoredShortcutPresses` twice and `RequestsDelegated`
   once; ASSERT both counters hold 2 and 1 respectively (no cross-contamination).
9. **Failure swallow (PRD §35 "telemetry failures are ignored"):** inject a `diagnostics.info` that
   THROWS; call `incrementCounter("X")` / `recordTransitionStarted(…)`; ASSERT no exception escapes
   (wrapped in the method). (Construct the throwing diag as a stub whose `info` throws.)
10. **getCounter / snapshot are pure reads:** enabled, bump a counter; ASSERT `getCounter` for an
    untouched name is `undefined`; ASSERT `snapshot()` returns a fresh plain object whose mutation does
    NOT affect the internal Map (defensive copy) — e.g. `const s = t.snapshot(); s.TransitionsRequested =
    999; expect(t.getCounter("TransitionsRequested")).not.toBe(999)`.
11. **PRIVACY (Appendix H) — the field types structurally exclude content:** a compile-time + runtime
    assertion. (a) Runtime: build the three field objects; pass them through record*; collect ALL emitted
    `fields` objects; ASSERT no emitted field key matches `/prompt|reasoning|output|apiKey|auth|token|content|message|tool/i`
    AND none of the field VALUES is a string longer than, say, 64 chars (operational ids/models/phases are
    short). (b) Comment in the test that the TYPE system (the `*Fields` interfaces) is the primary guard —
    a caller literally cannot pass a `prompt` field without a TS error.

### Test: MODIFY `tests/shortcut-manager.test.ts` — assert the IgnoredShortcutPresses wiring

Add a new `describe` (or extend the existing ignored-press cases). Inject a REAL `new Telemetry(true,
diag)` into `new ShortcutManager(diag, telemetry)` and trigger the two ignored paths the suite already
exercises (`alreadyInterrupting()` → `true`, and `requestStop()` → `false`). ASSERT:
- `telemetry.getCounter("IgnoredShortcutPresses")` increments by exactly the number of ignored presses
  on each path.
- A press that is ACCEPTED (`requestStop()` → `true`) does NOT increment `IgnoredShortcutPresses`.
- Constructing `ShortcutManager` WITHOUT the telemetry arg (the existing tests) is unchanged — no
  counter object, no throw, the existing `shortcut.ignored` / `shortcut.forwarded` trace assertions still
  hold. (Proves the optional-param backward compatibility.)

### Scope Boundary — DO NOT implement (owned by later tasks)

- **StreamProxy recording of transition-lifecycle events** (`recordTransitionStarted/Completed/Failed` +
  the latency instrumentation: `performance.now()` at reasoning-start / stop-request / abort-complete /
  replacement-start / splice / completion) → **out of scope.** Reasons: (1) `proxy.ts` is being actively
  rewritten by the parallel P1.M7.T3.S1 (constructor param list, `_terminate`, `_launchReplacement`,
  `run()` lifecycle); (2) the latency capture does not yet exist in the proxy; (3) the Pi-extension
  FACTORY (`src/index.ts`) does NOT yet construct the coordinator/proxy-with-telemetry/shortcut pipeline
  (P1.M7.T3.S1's own Scope Boundary defers factory wiring). The Telemetry module's types + methods are
  the EXACT contract those tasks consume — building it now unblocks them with **zero rework risk**
  (the public surface is fixed by Appendix I). Wire the proxy in the factory-integration task / P1.M8.T2.
- **P1.M8.T2 failure-mode telemetry** (`recordTransitionFailed` calls + `TransitionsFailed` counter from
  the proxy/FM handlers) → P1.M8.T2. This subtask delivers the method; P1.M8.T2 calls it.
- **Any change to `types.ts`, `config/`, `diagnostics/`, `state/`, `buffer/`, `request/`, `provider/`,
  `index.ts`** → none. (Telemetry is additive; the only non-telemetry edit is the optional param in
  `shortcut/index.ts`.)

### Success Criteria

- [ ] `src/telemetry/index.ts` exports `Telemetry` + the 5 types; the 4 public methods are no-ops when
      `telemetryEnabled===false`; every method body is wrapped in `try/catch` (swallows — never throws);
      `incrementCounter` maintains the `Map<string,number>`; `recordTransitionCompleted` updates the three
      `Average*` counters via a running mean; `getCounter` + `snapshot` are pure reads.
- [ ] The field types encode PRD Appendix I EXACTLY (field names + the `FailureCategory` union + the
      `CounterName` union); no content fields exist anywhere.
- [ ] JSDoc (Mode A) documents every metric field AND the privacy constraints (the allow/deny lists +
      "the field types structurally cannot hold content").
- [ ] `src/shortcut/index.ts` has the optional `telemetry?: Telemetry` ctor param and counts
      `IgnoredShortcutPresses` on BOTH ignored paths; omitting the arg is a backward-compatible no-op.
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green
      (new `telemetry` + extended `shortcut-manager` + every pre-existing suite unchanged).

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have
everything needed to implement this successfully?"_ → YES. The exact module location, the exact imports
(type-only `../diagnostics`), the complete type definitions (Appendix I verbatim), the full method bodies
(two-guard shape + `_updateAverage`), the event names, the `Date.now()` timestamp default, the
incremental-mean formula, the ShortcutManager wiring (exact lines), the test sink pattern
(`makeCaptureDiag` from the shortcut test), and all 11 telemetry test cases + the shortcut-extension
assertions are reproduced above and in `research/notes.md` §1–§6.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- url: (in-repo) PRD.md §35 "Telemetry Module"
  why: Responsibility/Metrics/Privacy — the contract ("Record operational metrics. Must never affect
       functionality. Telemetry failures are ignored.") + the metric list + the privacy list.
  critical: "Telemetry failures are ignored" → every method try/catch-wraps + swallows. Privacy list is
            the deny-list the field types must structurally respect.

- url: (in-repo) PRD.md §56 "Observability"
  why: "Every transition shall emit structured telemetry" + the enumerated field set + triple
       "No prompt text. No reasoning text. No assistant output."
  critical: structured (not free-form) emission; content is categorically excluded.

- url: (in-repo) PRD.md "Appendix I — Telemetry Schema" (search "Event: TransitionStarted")
  why: The EXACT field sets for TransitionStarted/Completed/Failed + the Failure Categories union +
       the Performance Counters list. This is the single source of truth for the TS types.
  critical: encode field NAMES and the FailureCategory/CounterName unions VERBATIM (case-sensitive).

- file: src/diagnostics/index.ts
  why: The emission sink. Telemetry calls `diagnostics.info(event, fields)`. Each line =
       `JSON.stringify({...fields, ts, level, event})`; reserved keys are logger-owned (caller cannot
       clobber level/event/ts). Level filter: info() emits only when diagnosticsLevel weight >= info(2);
       default "error" → dropped (documented, not a bug).
  pattern: a frozen Diagnostics object passed BY REFERENCE into every constructor (DI convention).
  gotcha: the logger does NOT scrub fields — privacy is caller discipline; Telemetry enforces it by
          field-type construction. The allow-list (provider/model/transitionId/timing/counts/state/
          error-category) and deny-list (prompt/reasoning/output/keys/headers/tool-args) are in the
          diagnostics module JSDoc — Telemetry fields are all on the allow-list.

- file: src/config/index.ts
  why: `Config.telemetryEnabled: boolean` (default `false`, PRD Appendix K). Telemetry takes ONLY this
       boolean (minimal coupling — mirrors Diagnostics taking just `level`).
  pattern: deep-frozen DEFAULT_CONFIG; loadConfig()/validateConfig() return a fresh valid Config.

- file: src/state/controller.ts
  why: CONVENTION reference — same DI shape (`constructor(diagnostics)`), private mutable state, public
       read accessor (`getState()`), exhaustive Mode-A JSDoc citing PRD sections + a Privacy note.
  pattern: class with `private readonly` deps + a small public read API; never-throws convenience methods.

- file: src/shortcut/index.ts
  why: The consumer being wired. `handlePress` has the two ignored paths to count. Constructor takes
       `diagnostics` → extend with optional `telemetry?`.
  gotcha: keep the existing `shortcut.ignored` / `shortcut.forwarded` traces UNCHANGED (tests assert
          them); only ADD the counter calls.

- file: tests/shortcut-manager.test.ts
  why: Test CONVENTION — `makeCaptureDiag()` stub + `makeFakePi()`; the two ignored paths already
       exercised (lines ~111 already-interrupting, ~131 accepted===false). Extend, don't rewrite.
  pattern: stub Diagnostics capturing {level,event,fields}[]; assert via `.some()`/`.filter()`.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/
  buffer/index.ts          # ReasoningBuffer (P1.M4.T1)
  config/index.ts          # Config + validateConfig + DEFAULT_CONFIG (P1.M1.T2) — has telemetryEnabled
  diagnostics/index.ts     # createDiagnostics + Diagnostics interface (P1.M1.T3) — the emission sink
  index.ts                 # extension factory (P1.M1.T5) — NOT yet wiring coordinator/shortcut/telemetry
  provider/
    decorator.ts           # ProviderDecorator (P1.M1.T4) — constructs StreamProxy
    proxy.ts               # StreamProxy (P1.M2..P1.M7) — REWRITTEN by parallel P1.M7.T3.S1
  request/builder.ts       # RequestBuilder (P1.M6.T1)
  shortcut/index.ts        # ShortcutManager (P1.M4.T3) — MODIFY target (add telemetry param)
  state/
    controller.ts          # TransitionController FSM (P1.M3.T1)
    coordinator.ts         # TransitionCoordinator (P1.M4.T4)
  types.ts                 # shared event/state types (P1.M2.T1)
tests/
  *.test.ts                # flat bun:test suites (one per module) — ADD telemetry.test.ts
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
src/telemetry/index.ts     # NEW — Telemetry class + field/failure-category/counter-name types + JSDoc
                           #   (privacy-safe metrics recorder; no-op when disabled; swallows failures)
src/shortcut/index.ts      # MODIFY — optional telemetry param + IgnoredShortcutPresses on 2 ignored paths
tests/telemetry.test.ts    # NEW — unit suite (disabled-noop, fields, averages, swallow, privacy, reads)
tests/shortcut-manager.test.ts  # MODIFY — assert IgnoredShortcutPresses wiring (+ backward-compat no-arg)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: Diagnostics.info() is SILENTLY DROPPED when config.diagnosticsLevel === "error" (the default).
// Telemetry's in-memory counters Map is ALWAYS maintained when telemetryEnabled — but the info *events*
// only appear if the operator also sets diagnosticsLevel <= "info". This is intentional (best-effort,
// "must never affect functionality") and must be DOCUMENTED in the JSDoc, not "fixed".

// CRITICAL: the Diagnostics logger does NOT scrub fields — privacy is enforced by CALLER discipline.
// Telemetry enforces it by FIELD-TYPE CONSTRUCTION: the *Fields interfaces hold only allow-listed
// operational fields (ids/provider/model/timestamps-ms/durations/success/category/phase). Adding a field
// later MUST keep it on the Appendix H allow-list. The "privacy" test case asserts this.

// CRITICAL: the Diagnostics line is `{...fields, ts, level, event}` — reserved keys (ts/level/event) are
// logger-owned and authoritative. Telemetry's `timestamp` field (epoch ms, telemetry semantics) is a
// DIFFERENT key from the logger's `ts` (ISO8601) — both can coexist in one line with no conflict.

// CRITICAL: every public Telemetry method must (1) early-return when !telemetryEnabled, THEN (2) wrap the
// real work in try/catch that swallows. PRD §35 "Telemetry failures are ignored" + Appendix E/K never-crash.

// GOTCHA: the Average* counters are a running MEAN, not a running SUM and not a naive overwrite. Use
// `avg ← avg + (value − avg)/n` (track n per-average in a helper Map). The simple counters use plain +1.

// GOTCHA: do NOT auto-increment TransitionsCompleted/TransitionsFailed inside recordTransitionCompleted/
// Failed — that risks double-counting if a caller also calls incrementCounter. record* = event + averages
// ONLY; incrementCounter = the five simple counters. Callers bump both explicitly. (Documented.)

// GOTCHA: ShortcutManager's existing traces ("shortcut.ignored"/"shortcut.forwarded") are asserted by the
// existing test — ADD the counter calls, do NOT remove or reorder the traces.
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// PRD Appendix I — encoded verbatim (see "What" §A for the full definitions)
export type FailureCategory = "AbortFailed" | "ReplacementRejected" | "ProviderTimeout" |
  "NetworkFailure" | "MalformedEvent" | "OrderingViolation" | "UnexpectedTermination" | "InternalError";
export type CounterName = "RequestsDelegated" | "TransitionsRequested" | "TransitionsCompleted" |
  "TransitionsFailed" | "IgnoredShortcutPresses" | "AverageTransitionLatency" | "AverageAbortLatency" |
  "AverageRestartLatency";
export interface TransitionStartedFields { transitionId: string; provider: string; model: string;
  reasoningElapsedMs: number; timestamp?: number; }
export interface TransitionCompletedFields { transitionId: string; abortLatencyMs: number;
  restartLatencyMs: number; spliceLatencyMs: number; completionLatencyMs: number; totalDurationMs: number;
  success: boolean; }
export interface TransitionFailedFields { transitionId: string; failureCategory: FailureCategory;
  failurePhase: string; provider: string; model: string; timestamp?: number; }
```

> These are the project's "data models" (TypeScript interfaces + literal-union types). No ORM/pydantic —
> this is a TS+Bun extension. Type-safety comes from the compiler; the `FailureCategory`/`CounterName`
> unions constrain callers at compile time.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE src/telemetry/index.ts
  - IMPLEMENT: the 5 exported types (FailureCategory, CounterName, TransitionStartedFields,
    TransitionCompletedFields, TransitionFailedFields) — PRD Appendix I VERBATIM.
  - IMPLEMENT: class Telemetry with constructor(telemetryEnabled: boolean, diagnostics: Diagnostics),
    private readonly _counters: Map<string, number>, private readonly _averageSamples: Map<string, number>.
  - IMPLEMENT: recordTransitionStarted / recordTransitionCompleted / recordTransitionFailed /
    incrementCounter — each (1) `if (!this.telemetryEnabled) return;` then (2) try { … } catch { /* PRD §35 swallow */ }.
  - IMPLEMENT: private _updateAverage(name, value) using the incremental running mean; call it from
    recordTransitionCompleted for the three Average* counters.
  - IMPLEMENT: getCounter(name): number|undefined + snapshot(): Readonly<Record<string, number>> (pure reads).
  - IMPORT: `import type { Diagnostics } from "../diagnostics";` (type-only; NO other imports).
  - FOLLOW pattern: src/state/controller.ts (DI ctor, private readonly deps, Mode-A JSDoc, never-throws,
    Privacy (Appendix H) note) + src/diagnostics/index.ts (allow/deny field lists in JSDoc).
  - NAMING: interface PascalCase, fields camelCase, union string-literals match PRD case EXACTLY.
  - DOC (Mode A): top-of-file `#`-heading module comment + per-method JSDoc citing PRD §35/§56/Appendix I +
    an explicit PRIVACY CONTRACT block (allow/deny lists + "field types structurally cannot hold content").
  - PLACEMENT: src/telemetry/index.ts (matches src/<module>/index.ts convention).

Task 2: CREATE tests/telemetry.test.ts
  - IMPLEMENT: the 11 coverage cases listed in "What" §C (no-op-when-disabled; three record* field sets;
    explicit-timestamp-honored; averages first-sample + running-mean; failure fields; incrementCounter +1
    + counter event; counter independence; failure-swallow with a throwing diagnostics.info; pure reads;
    PRIVACY field-set assertion).
  - REUSE pattern: makeCaptureDiag() stub from tests/shortcut-manager.test.ts (stub Diagnostics capturing
    {level,event,fields}[] — object assertions, no JSON.parse). Construct new Telemetry(true, diag) / (false, diag).
  - NAMING: test("<scenario>") descriptive; one assertion focus per test.
  - COVERAGE: all 4 public methods (happy + disabled + swallow) + the two read accessors + the privacy guard.
  - PLACEMENT: tests/telemetry.test.ts (flat tests/ convention).

Task 3: MODIFY src/shortcut/index.ts
  - ADD: `import type { Telemetry } from "../telemetry";` (type-only).
  - ADD: optional `private readonly _telemetry?: Telemetry` as the 2nd ctor param (every existing caller
    unchanged — defaults undefined).
  - ADD: `this._telemetry?.incrementCounter("IgnoredShortcutPresses")` on BOTH ignored paths in handlePress
    (the alreadyInterrupting() early-return AND the !accepted branch). Keep existing traces UNCHANGED.
  - FOLLOW pattern: the existing constructor's `private readonly diagnostics: Diagnostics` param style.
  - PRESERVE: register/unregister/handlePress control flow + all existing diagnostics.trace/error calls.

Task 4: MODIFY tests/shortcut-manager.test.ts
  - ADD: a case constructing `new ShortcutManager(diag, new Telemetry(true, diag))` and asserting
    IgnoredShortcutPresses increments on the two ignored paths and does NOT increment on an accepted press.
  - ADD: a backward-compat assertion that `new ShortcutManager(diag)` (no telemetry arg) behaves exactly
    as before (existing ignored/forwarded trace assertions still hold; no throw).
  - PRESERVE: every existing test (makeCaptureDiag/makeFakePi helpers + all current assertions).
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: the two-guard method shape (every public Telemetry method) — PRD §35.
recordTransitionStarted(fields: TransitionStartedFields): void {
  if (!this.telemetryEnabled) return;          // (1) disabled → total no-op (no Map, no log)
  try {
    this.diagnostics.info("telemetry.transition.started", { …explicit allow-listed keys… });
  } catch {
    // (2) PRD §35 — telemetry failures are ignored. NEVER rethrow (Appendix E/K never-crash).
  }
}

// PATTERN: incremental running mean for the three Average* counters.
private _updateAverage(name: CounterName, value: number): void {
  const n = (this._averageSamples.get(name) ?? 0) + 1;
  this._averageSamples.set(name, n);
  const prev = this._counters.get(name) ?? value; // first sample → avg === value (no NaN)
  this._counters.set(name, prev + (value - prev) / n);
}

// PATTERN: capturing-Diagnostics stub for tests (from tests/shortcut-manager.test.ts).
function makeCaptureDiag(): { diag: Diagnostics; events: { level: string; event: string; fields?: Record<string, unknown> }[] } {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info:  (e, f) => events.push({ level: "info",  event: e, fields: f }),
    warn:  (e, f) => events.push({ level: "warn",  event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}
```

### Integration Points

```yaml
CONFIG:
  - reads: config.telemetryEnabled (default false, PRD Appendix K) — passed as the ctor's 1st arg.
  - interaction: telemetry info() events are dropped unless config.diagnosticsLevel <= "info" (documented).
DIAGNOSTICS (the sink):
  - calls: diagnostics.info("telemetry.transition.{started,completed,failed}", fields) and
           diagnostics.info("telemetry.counter", { name, value }) from incrementCounter.
SHORTCUT (consumer, wired here):
  - src/shortcut/index.ts: optional _telemetry param; incrementCounter("IgnoredShortcutPresses") x2 paths.
PROXY (consumer, DEFERRED):
  - LATER (factory-integration / P1.M8.T2): StreamProxy calls recordTransitionStarted/Completed/Failed +
    incrementCounter("TransitionsRequested"/"TransitionsCompleted"/"TransitionsFailed"/"RequestsDelegated")
    once latency instrumentation (performance.now at reasoning-start/stop/abort-complete/replacement-start/
    splice/completion) is added. The Telemetry module's types/methods are the exact contract consumed.
FACTORY (DEFERRED):
  - LATER: src/index.ts constructs `new Telemetry(config.telemetryEnabled, diagnostics)` and threads it
    through the coordinator/proxy/shortcut pipeline (which the factory does not yet build — see P1.M7.T3.S1
    Scope Boundary).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# After creating src/telemetry/index.ts — fix before proceeding.
npx bun run typecheck          # tsc --noEmit — zero diagnostics on the new file
npx bun run build              # tsc — emits dist/ with exit 0

# After modifying src/shortcut/index.ts — confirm the optional param + type-only import compile.
npx bun run typecheck

# Expected: Zero errors. If errors exist, READ the tsc output and fix before proceeding (common: a typo in
# a FailureCategory/CounterName literal, a missing import type, or an unused variable).
```

> No ruff/mypy/ruff-format in this project — it is TypeScript + Bun. The equivalents are `tsc --noEmit`
> (typecheck) + `tsc` (build). Formatting is conventional TS (the repo has no formatter configured).

### Level 2: Unit Tests (Component Validation)

```bash
# The new telemetry module in isolation.
npx bun test tests/telemetry.test.ts        # all 11 cases green

# The modified shortcut consumer.
npx bun test tests/shortcut-manager.test.ts  # extended cases + all pre-existing assertions green

# Full suite — confirm NO regression (the optional shortcut param must not break anything).
npx bun test                                 # ALL suites green (telemetry + shortcut-manager + every other)

# Expected: All tests pass. If failing, debug root cause — most likely a counter off-by-one on an ignored
# path, a missing try/catch swallow, or a snapshot() that leaked the internal Map by reference.
```

### Level 3: Integration Testing (System Validation)

```bash
# Build + whole-suite smoke (the project has no running server — it is a Pi extension loaded by the host).
npx bun run build && npx bun test

# Confirm the type-only import introduces NO runtime cycle:
node -e "import('./dist/telemetry/index.js').then(m => console.log(Object.keys(m)))" 2>/dev/null \
  || npx bun -e "import('./src/telemetry/index.js').then(m => console.log(Object.keys(m)))"
# Expected: prints the exported names (Telemetry + the 5 types) and does NOT error on a circular import.

# Expected: build exit 0; all tests green; the import resolves cleanly (shortcut → telemetry → diagnostics
# is type-only on both edges, erased at compile).
```

### Level 4: Creative & Domain-Specific Validation

```bash
# PRIVACY audit (Appendix H) — run the telemetry suite's privacy case AND eyeball the emitted fields:
npx bun test tests/telemetry.test.ts -t "privacy"   # (name the privacy test so -t matches)

# Manual privacy spot-check: enable telemetry, emit one of each event, dump the captured fields, and
# confirm NONE contain prompt/reasoning/output/keys (the test automates this; this is the human confirm).
# Expected: every emitted field is an id / provider / model / number / boolean / category — never content.

# FORWARD-COMPAT sanity: confirm P1.M8.T2's expected calls would type-check against the exported API:
#   telemetry.recordTransitionFailed({ transitionId:"t", failureCategory:"ProviderTimeout",
#     failurePhase:"replacement", provider:"zai", model:"glm-4.6" })   // ← must compile
#   telemetry.incrementCounter("TransitionsFailed")                    // ← must compile
# (These compile-time-check automatically via `bun run typecheck` once a throwaway caller is added, or
#  simply by inspection against the exported FailureCategory/CounterName unions.)

# Expected: privacy case passes; the P1.M8.T2 call shapes are type-correct against the exported API.
```

---

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun run build` → exit 0.
- [ ] `npx bun test` → ALL suites green (new `telemetry` + extended `shortcut-manager` + every pre-existing).

### Feature Validation

- [ ] `Telemetry` is a no-op when `telemetryEnabled===false` (no Map mutation, no log) — test case 1.
- [ ] Every public method swallows its own failure (a throwing `diagnostics.info` does not escape) — case 9.
- [ ] The three transition events emit their exact PRD Appendix I field sets at `info` level — cases 2/4/6.
- [ ] `incrementCounter` does generic `+1` + emits a `telemetry.counter` event; counters are independent — 7/8.
- [ ] The three `Average*` counters are a correct running mean (first sample = value; second = mean) — 4/5.
- [ ] PRIVACY (Appendix H): no emitted field is content — the field types structurally exclude it — case 11.
- [ ] ShortcutManager counts `IgnoredShortcutPresses` on BOTH ignored paths and not on accepted presses.
- [ ] Omitting the ShortcutManager telemetry arg is a backward-compatible no-op (existing tests unchanged).

### Code Quality Validation

- [ ] Follows existing codebase patterns (DI ctor, `private readonly`, Mode-A JSDoc, never-throws, Privacy note).
- [ ] File placement matches the desired tree (`src/telemetry/index.ts`, flat `tests/`).
- [ ] Anti-patterns avoided (see below): no content fields, no rethrow, no auto-increment double-count, no
      diagnostics-level "fix", no runtime cycle, no shortcut-trace removal.
- [ ] The type-only `../diagnostics` (telemetry) and `../telemetry` (shortcut) imports introduce zero runtime coupling.

### Documentation & Deployment

- [ ] Mode-A JSDoc on the `Telemetry` class documents every metric field AND the privacy constraints.
- [ ] The diagnostics-level interaction (info dropped at default `error`) is documented, not silently surprising.
- [ ] The deferred proxy/factory wiring is documented (Scope Boundary) so the next task is unblocked.

---

## Anti-Patterns to Avoid

- ❌ Don't record prompt/reasoning/output/keys/user-ids — the field types must structurally prevent it; never
  add a content-bearing field to a `*Fields` interface.
- ❌ Don't let a telemetry method throw — PRD §35 "Telemetry failures are ignored"; every method try/catch-wraps + swallows.
- ❌ Don't skip the `!telemetryEnabled` early-return — disabled telemetry must mutate NOTHING (no Map, no log).
- ❌ Don't auto-increment `TransitionsCompleted`/`TransitionsFailed` inside `recordTransition*` — that double-counts
  with an explicit `incrementCounter`; record* = event + averages ONLY.
- ❌ Don't "fix" the diagnostics-level interaction by routing telemetry around the diagnostics filter — it is
  intentional (best-effort); document it.
- ❌ Don't introduce a runtime import cycle — `telemetry`→`diagnostics` and `shortcut`→`telemetry` are BOTH type-only.
- ❌ Don't remove/reorder the existing `shortcut.ignored`/`shortcut.forwarded` traces when adding the counter calls.
- ❌ Don't wire the proxy now — it is being rewritten by the parallel P1.M7.T3.S1 and lacks latency instrumentation;
  defer per the Scope Boundary (the module's API is the fixed contract, zero rework risk).

---

## Confidence Score

**9/10** — one-pass implementation success likelihood. The deliverable is a self-contained, well-scoped
module with its full type definitions and method bodies specified, a clear test sink pattern reused from
an existing suite, and one safe isolated consumer wiring. The only residual risk is the (deferred) proxy
integration being mistaken for in-scope — the Scope Boundary + repeated "DO NOT" notes mitigate that. The
module has no external dependencies beyond the in-repo `Diagnostics` (type-only), so there is no
third-party-API surface to get wrong.
