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
  /** Keyboard shortcut (Pi `KeyId`, lowercase) that raises the stop signal. Default: `"ctrl+q"`.
   *
   * NOTE: pi-tui can only MATCH certain key combos against real terminal input — reliably
   * `ctrl+<letter a-z>` (plus `ctrl+[ \\ ] _ -` and special keys). Symbol combos such as
   * `ctrl+.` are NOT matchable in legacy terminals and will register but never fire. The
   * default `ctrl+q` is matchable and unbound by Pi. See README → Configuration. */
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
  /**
   * Whether the Ephemeral Execution Directive is enabled (PRD §47 / ADR-006 / §53): the captured
   * reasoning snapshot is injected into the replacement request as ephemeral, clearly-fenced
   * reference context (INPUT injection for the model to reuse), NOT output stitching. When `false`
   * (or the snapshot is empty) the replacement behaves as a from-scratch thinking-disabled answer.
   * Default: `true`. Env: `PI_STOP_THINKING_REASONING_INJECTION`.
   *
   * [Appendix H privacy] Enabling this does NOT cause reasoning text to be logged, telemetered, or
   * persisted beyond the single ephemeral replacement request; diagnostics never log reasoning text.
   */
  reasoningInjection: boolean;
  /**
   * The open/close fence text wrapping the injected reasoning block (PRD §47 / §53 h3.71 /
   * Appendix K h1.117). Defaults to a deterministic, clearly-labeled fence so the model can
   * unambiguously distinguish prior reasoning from the live prompt. Both parts must be non-empty
   * strings; an invalid value on EITHER part falls back to the ENTIRE default delimiter object.
   * Changing this does not affect the shortcut or the env-var config mechanism.
   * Default: `{ open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
   *            close: "[End of prior reasoning]\n---" }`.
   * Env: `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` /
   *      `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE` (parsing is P2.M1.T1.S2).
   */
  reasoningInjectionDelimiter: { open: string; close: string };
}

/**
 * Frozen, immutable default configuration (PRD §47 + Appendix K; immutability required by Appendix G).
 * Deep-frozen: the object AND its `supportedProviders` array are both `Object.isFrozen`.
 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enabled: true,
  shortcut: "ctrl+q",
  supportedProviders: Object.freeze(["zai"]),
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
  reasoningInjection: true,
  reasoningInjectionDelimiter: Object.freeze({
    open: "---\n[Prior reasoning captured before you were asked to stop thinking]",
    close: "[End of prior reasoning]\n---",
  }),
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
const isOpenCloseShape = (v: unknown): v is { open: string; close: string } =>
  typeof v === "object" && v !== null &&
  "open" in v && "close" in v &&
  typeof (v as { open: unknown }).open === "string" && (v as { open: string }).open.length > 0 &&
  typeof (v as { close: unknown }).close === "string" && (v as { close: string }).close.length > 0;

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
    reasoningInjection: pick(src.reasoningInjection, isBool, DEFAULT_CONFIG.reasoningInjection),
    reasoningInjectionDelimiter: isOpenCloseShape(src.reasoningInjectionDelimiter)
      ? { open: src.reasoningInjectionDelimiter.open, close: src.reasoningInjectionDelimiter.close }
      : { ...DEFAULT_CONFIG.reasoningInjectionDelimiter },
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

/**
 * Environment-variable namespace for runtime configuration (PRD §47). Pi's ExtensionAPI
 * exposes no settings object to extensions, so user configuration is supplied via
 * `PI_STOP_THINKING_*` environment variables (set in the shell or a launcher). Every field
 * is OPTIONAL: an unset or unparseable value is omitted and {@link validateConfig} falls
 * back to that field's default, so a bad value can never prevent normal provider delegation
 * (PRD Appendix K).
 */
export const ENV_PREFIX = "PI_STOP_THINKING_";

/** @internal Parse a boolean env value; `undefined` when missing or unrecognized. */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  switch (raw.trim().toLowerCase()) {
    case "true": case "1": case "yes": case "on": return true;
    case "false": case "0": case "no": case "off": return false;
    default: return undefined;
  }
}

/** @internal Parse a finite number; `undefined` when missing or non-finite. */
function envNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** @internal Parse a comma-separated non-empty string list; `undefined` when missing/empty. */
function envStringArray(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const arr = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return arr.length > 0 ? arr : undefined;
}

/**
 * Load configuration from `PI_STOP_THINKING_*` environment variables, validating and filling
 * defaults via {@link validateConfig}. This is the production entry point the extension
 * factory calls; {@link loadConfig} remains a pure merge for tests.
 *
 * Accepts an optional `env` (defaults to `process.env`) so tests can inject a deterministic
 * environment without mutating the global one. Parsed values are re-validated by
 * {@link validateConfig}, so a loose parse can never yield an invalid {@link Config}.
 *
 * **Limitations** (see README → Configuration):
 *  - Config is env-var only — Pi passes no extension settings, so `settings.json` cannot
 *    configure this extension.
 *  - `shortcut` is accepted as any non-empty string, but pi-tui can only MATCH certain
 *    combos at runtime (reliably `ctrl+<letter a-z>`; symbol combos like `ctrl+.` register
 *    but never fire in legacy terminals). The default `ctrl+q` is matchable.
 *  - The shortcut must not collide with Pi's reserved keybindings or Pi will skip it.
 *  - Invalid/unparseable values silently fall back to defaults (PRD Appendix K).
 */
export function loadConfigFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const partial: Record<string, unknown> = {};

  const enabled = envBool(env[ENV_PREFIX + "ENABLED"]);
  if (enabled !== undefined) partial.enabled = enabled;

  const shortcut = env[ENV_PREFIX + "SHORTCUT"];
  if (shortcut !== undefined && shortcut.length > 0) partial.shortcut = shortcut;

  const providers = envStringArray(env[ENV_PREFIX + "PROVIDERS"]);
  if (providers !== undefined) partial.supportedProviders = providers;

  const transition = envNumber(env[ENV_PREFIX + "TRANSITION_TIMEOUT_MS"]);
  if (transition !== undefined) partial.transitionTimeoutMs = transition;

  const replacement = envNumber(env[ENV_PREFIX + "REPLACEMENT_TIMEOUT_MS"]);
  if (replacement !== undefined) partial.replacementStartupTimeoutMs = replacement;

  const maxBuf = envNumber(env[ENV_PREFIX + "MAX_REASONING_BUFFER_BYTES"]);
  if (maxBuf !== undefined && Number.isInteger(maxBuf)) partial.maximumReasoningBufferBytes = maxBuf;

  const telemetry = envBool(env[ENV_PREFIX + "TELEMETRY"]);
  if (telemetry !== undefined) partial.telemetryEnabled = telemetry;

  const diag = env[ENV_PREFIX + "DIAGNOSTICS"];
  if (diag !== undefined && diag.length > 0) partial.diagnosticsLevel = diag;

  return validateConfig({ ...DEFAULT_CONFIG, ...partial });
}
