/**
 * # Diagnostics — structured logger with privacy controls
 *
 * Developer-facing structured logging for the Stop Thinking & Do extension (PRD §36). Produces one
 * JSON object per line so that "No free-form parsing shall be required" (PRD §57). Disabled-by-default
 * verbosity: at the default level `"error"` only fatal errors are emitted, so the module is silent
 * unless a developer raises the level.
 *
 * **This logger never modifies runtime behavior** (PRD §36: "Verbose logging shall never modify
 * runtime behavior."). Every method is fire-and-forget; a dropped message is a silent no-op.
 *
 * ---
 * ## PRIVACY CONTRACT (PRD §58 + Appendix H — Logging Rules) — READ BEFORE LOGGING
 *
 * Only the following fields MAY be passed in `fields`:
 *  - Provider name
 *  - Model identifier
 *  - Transition ID
 *  - Timing metrics
 *  - Event counts
 *  - State transitions
 *  - Error categories
 *
 * The following MUST NEVER be logged (directly or nested) — doing so leaks user secrets to logs:
 *  - Prompt text
 *  - Assistant output
 *  - Reasoning output
 *  - API keys
 *  - Authorization headers
 *  - Tool arguments
 *  - Tool outputs
 *
 * Privacy here is enforced by this contract + caller discipline; the logger does not scrub fields
 * at runtime (scrubbing risks false positives on legitimate values). It is the CALLER's responsibility
 * to pass only allow-listed fields. See PRD Appendix H — Security & Privacy Model.
 *
 * ## Level semantics
 *
 * Ordering: `error < warn < info < debug < trace`. A message is emitted iff its severity weight is
 * `<=` the configured level's weight; otherwise it is silently dropped ("messages below the configured
 * level are dropped"). Per-level intent (PRD §57): Error=fatal failures; Warning=recoverable failures;
 * Info=successful transitions; Debug=lifecycle milestones; Trace=every state transition.
 *
 * ## Trace correlation (PRD Appendix M)
 *
 * The logger auto-injects `ts`. Callers logging during a transition SHOULD also include `transitionId`,
 * `streamId`, `provider`, `model`, `currentState` as `fields` (these are caller-owned, not logger-owned).
 */

import type { DiagnosticsLevel } from "../config";

/** Numeric severity implementing `error < warn < info < debug < trace` (PRD §57). Lower = more severe. */
export const LEVEL_WEIGHT: Readonly<Record<DiagnosticsLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * Destination for structured log lines. `log` receives trace/debug/info lines; `error` receives
 * warn/error lines (mirroring `console.log` vs `console.error`). Inject a custom sink (e.g. a
 * capturing array) for tests or to route into a future telemetry sink.
 */
export interface DiagnosticsSink {
  /** Receives trace/debug/info lines. */
  log(line: string): void;
  /** Receives warn/error lines. */
  error(line: string): void;
}

/** Default sink: writes to `console.log` / `console.error`. */
const DEFAULT_SINK: DiagnosticsSink = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Structured logger with five ordered severity levels and a privacy contract (PRD §36, §57,
 * Appendix H). See the module-level JSDoc for the allow/deny field lists.
 *
 * One instance is created in the extension factory and passed BY REFERENCE to every module. The
 * returned object is frozen so no consumer can reassign its methods.
 */
export interface Diagnostics {
  /** Most verbose — every state transition (PRD §57). */
  trace(event: string, fields?: Record<string, unknown>): void;
  /** Lifecycle milestones (PRD §57). */
  debug(event: string, fields?: Record<string, unknown>): void;
  /** Successful transitions (PRD §57). */
  info(event: string, fields?: Record<string, unknown>): void;
  /** Recoverable failures (PRD §57). Routed to the sink's `error` channel. */
  warn(event: string, fields?: Record<string, unknown>): void;
  /** Fatal failures (PRD §57). Routed to the sink's `error` channel. */
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Create a {@link Diagnostics} logger that filters by `level` and writes structured JSON lines to
 * `sink` (default: `console.log`/`console.error`).
 *
 * @param level  Minimum severity to emit. A method emits iff `LEVEL_WEIGHT[methodLevel] <=
 *               LEVEL_WEIGHT[level]`; lower-severity messages are silently dropped. e.g. `"error"`
 *               emits only `.error()`; `"trace"` emits all five.
 * @param sink   Optional destination. Defaults to the console. Inject a capturing sink for tests.
 * @returns A **frozen** {@link Diagnostics} instance.
 *
 * Each emitted line is `JSON.stringify({ ...fields, ts: ISO8601, level, event })` — caller `fields`
 * are spread first, then reserved keys (`ts`/`level`/`event`) are set authoritatively, so a caller
 * cannot accidentally clobber the level. Never throws on the logging path (a dropped message is a
 * no-op; emitted messages rely on the sink, which defaults to console).
 *
 * **Privacy (PRD Appendix H):** the CALLER must pass only allow-listed fields (provider, model,
 * transitionId, timing, event counts, state transitions, error categories). NEVER pass prompt text,
 * reasoning, assistant output, API keys, authorization headers, or tool arguments/outputs.
 */
export function createDiagnostics(
  level: DiagnosticsLevel,
  sink: DiagnosticsSink = DEFAULT_SINK,
): Diagnostics {
  // Unknown level falls back to the most restrictive (only errors). Config guarantees a valid level,
  // but this keeps the logger safe if invoked with a bad value at runtime.
  const threshold: number = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.error;

  const emit = (
    methodLevel: DiagnosticsLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[methodLevel] > threshold) return; // below configured severity → drop silently
    const line = JSON.stringify({
      ...fields,                       // caller fields first
      ts: new Date().toISOString(),    // reserved (logger-owned)
      level: methodLevel,              // reserved (logger-owned, authoritative)
      event,                           // reserved (logger-owned, authoritative)
    });
    if (methodLevel === "warn" || methodLevel === "error") {
      sink.error(line);
    } else {
      sink.log(line);
    }
  };

  return Object.freeze<Diagnostics>({
    trace: (event, fields) => emit("trace", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  });
}
