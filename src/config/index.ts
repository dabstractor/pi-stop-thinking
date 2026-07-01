/**
 * Diagnostics verbosity level (PRD §36 + Appendix M trace levels).
 * The DEFAULT is `"error"` (PRD Appendix K). PRD §36 "Diagnostics disabled by default" concerns the
 * Diagnostics MODULE (no verbose/trace logging) — this field merely stores the requested level.
 */
export type DiagnosticsLevel = "error" | "warn" | "info" | "debug" | "trace";

/**
 * Configuration for the Stop Thinking & Do extension.
 *
 * Every field has a deterministic default (see {@link DEFAULT_CONFIG}). Configuration is validated
 * during extension initialization; any invalid field deterministically falls back to its default and
 * NEVER prevents normal provider delegation (PRD Appendix K — Configuration Validation Rules).
 * Configuration changes apply only to future requests (PRD §47).
 */
export interface Config {
  /** Master switch. When `false`, the provider decorator delegates transparently (EC-016). Default: `true`. */
  enabled: boolean;
  /** Keyboard shortcut (Pi `KeyId`, lowercase) that raises the stop signal. Default: `"ctrl+."`. */
  shortcut: string;
  /** Provider ids whose reasoning streams may be interrupted (decorator activation check A). Default: `["zai"]`. */
  supportedProviders: string[];
  /** Hard ceiling (ms) for the full reasoning→answer transition before it fails (PRD §43). Default: `5000`. */
  transitionTimeoutMs: number;
  /** Timeout (ms) waiting for the replacement stream's first event (PRD §43). Default: `10000`. */
  replacementStartupTimeoutMs: number;
  /** Max bytes captured by the reasoning buffer before overflow handling (PRD §23.4). Default: `8388608` (8 MiB). */
  maximumReasoningBufferBytes: number;
  /** Whether anonymous telemetry metrics are emitted (PRD Appendix I). Default: `false`. */
  telemetryEnabled: boolean;
  /** Diagnostics verbosity level. Default: `"error"`. */
  diagnosticsLevel: DiagnosticsLevel;
}

/**
 * Frozen, immutable default configuration (PRD §47 + Appendix K; immutability required by Appendix G).
 * Deep-frozen: the object AND its `supportedProviders` array are both `Object.isFrozen`.
 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enabled: true,
  shortcut: "ctrl+.",
  supportedProviders: Object.freeze(["zai"]),
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
}) as Config;

// --- per-field type guards (strict; NO coercion) ---
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPositiveFinite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const isPositiveInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmptyStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((el) => typeof el === "string" && el.length > 0);
const DIAGNOSTICS_LEVELS: readonly DiagnosticsLevel[] = ["error", "warn", "info", "debug", "trace"];
const isDiagnosticsLevel = (v: unknown): v is DiagnosticsLevel =>
  typeof v === "string" && (DIAGNOSTICS_LEVELS as readonly string[]).includes(v);

/** Return `value` when it satisfies `guard`, otherwise `fallback`. */
function pick<T>(value: unknown, guard: (v: unknown) => v is T, fallback: T): T {
  return guard(value) ? value : fallback;
}

/**
 * Validate an unknown configuration object and return a fully-valid {@link Config}.
 *
 * Behavior (PRD Appendix K — Configuration Validation Rules):
 *  - Missing or invalid field → that field's default (per-field fallback; one bad field does NOT
 *    invalidate the rest). Unknown keys are ignored.
 *  - Strict type checks — no coercion (`enabled: "true"` is invalid → default `true`).
 *  - Ranges: timeouts finite & > 0; `maximumReasoningBufferBytes` integer & > 0;
 *    `supportedProviders` an array of non-empty strings; `shortcut` a non-empty string;
 *    `diagnosticsLevel` one of the allowed literals (case-sensitive).
 *
 * Pure: never throws, never emits diagnostics (diagnostics-on-invalid is the init flow's job,
 * P1.M1.T5.S1). Returns a fresh object with copied arrays — never exposes {@link DEFAULT_CONFIG}
 * references for mutation.
 */
export function validateConfig(config: unknown): Config {
  const src =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  return {
    enabled: pick(src.enabled, isBool, DEFAULT_CONFIG.enabled),
    shortcut: pick(src.shortcut, isNonEmptyString, DEFAULT_CONFIG.shortcut),
    supportedProviders: isNonEmptyStringArray(src.supportedProviders)
      ? [...src.supportedProviders]
      : [...DEFAULT_CONFIG.supportedProviders],
    transitionTimeoutMs: pick(src.transitionTimeoutMs, isPositiveFinite, DEFAULT_CONFIG.transitionTimeoutMs),
    replacementStartupTimeoutMs: pick(
      src.replacementStartupTimeoutMs,
      isPositiveFinite,
      DEFAULT_CONFIG.replacementStartupTimeoutMs,
    ),
    maximumReasoningBufferBytes: pick(
      src.maximumReasoningBufferBytes,
      isPositiveInteger,
      DEFAULT_CONFIG.maximumReasoningBufferBytes,
    ),
    telemetryEnabled: pick(src.telemetryEnabled, isBool, DEFAULT_CONFIG.telemetryEnabled),
    diagnosticsLevel: pick(src.diagnosticsLevel, isDiagnosticsLevel, DEFAULT_CONFIG.diagnosticsLevel),
  };
}

/**
 * Merge a (typed) partial configuration over {@link DEFAULT_CONFIG} and validate.
 *
 * Equivalent to `validateConfig({ ...DEFAULT_CONFIG, ...(partial ?? {}) })`. Because `Partial<Config>`
 * is only a compile-time guarantee, runtime-invalid values in `partial` still fall back to their
 * defaults — so no invalid value can ever escape.
 */
export function loadConfig(partial?: Partial<Config>): Config {
  return validateConfig({ ...DEFAULT_CONFIG, ...(partial ?? {}) });
}
