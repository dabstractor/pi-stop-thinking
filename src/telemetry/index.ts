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

import type { Diagnostics } from "../diagnostics";

// ---------------------------------------------------------------------------
// A. Exported types — PRD Appendix I schema encoded verbatim
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// B. The Telemetry class
// ---------------------------------------------------------------------------

/**
 * Privacy-safe operational-metrics recorder (PRD §35 + §56 + Appendix I + Appendix H).
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
 * transitionId, timing, event counts, state transitions, error categories).
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

  /** PRD Appendix I — emit `TransitionCompleted` AND update the three Average* running means. */
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

  /** PRD Appendix I — emit `TransitionFailed`. */
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

  /** Generic `+1` on a simple counter (Appendix I). Emits a `telemetry.counter` info event. */
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

  /** Read one counter (simple OR average). `undefined` if never recorded. Pure read; never throws. */
  getCounter(name: CounterName): number | undefined {
    return this._counters.get(name);
  }

  /** Read-only shallow copy of ALL counters (for tests / future debug dump). Pure; never throws. */
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this._counters);
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
}
