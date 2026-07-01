/**
 * # Stop Thinking & Do — Pi extension entry point.
 *
 * This module is the package `"main"` (`dist/index.js`) and the single function Pi invokes when the
 * extension loads. Phase 0 responsibility (PRD §50): wire {@link Config} + {@link Diagnostics} +
 * {@link ProviderDecorator} together, install the **transparent** provider decorator (which delegates
 * every request byte-identically to Pi's built-in — ADR-005, PRD §19.7), and register `session_shutdown`
 * cleanup so the decoration is reversible (EC-012). Interruption logic arrives in later phases.
 *
 * **Never-crash guarantee (PRD Appendix K):** the entire body is a single `try/catch`. Any initialization
 * failure is logged and decoration is skipped — Pi continues with its **unmodified** built-in provider, so
 * an optional extension can never prevent normal provider delegation. This is the runtime enforcement of
 * "invalid config never prevents normal provider delegation".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { createDiagnostics } from "./diagnostics";
import type { Diagnostics } from "./diagnostics";
import { ProviderDecorator } from "./provider/decorator";
import { TransitionCoordinator } from "./state/coordinator";
import { Telemetry } from "./telemetry";
import { ShortcutManager } from "./shortcut";

/**
 * The lifecycle surface the factory consumes. `ProviderDecorator` satisfies this structurally
 * (`initialize(): void` + `shutdown(): void`), so the default factory needs no adapter.
 */
export interface DecoratorLifecycle {
  /** Capture the built-in provider and register the transparent wrapper (PRD §19.2). */
  initialize(): void;
  /** Unregister the wrapper, restoring the built-in provider (PRD §28, EC-012). */
  shutdown(): void;
}

/**
 * Additional services wired by the factory into the decorator and shortcut manager.
 * Collected in an interface so tests can inject doubles via the optional `createDecorator`
 * seam without needing to construct real coordinator/telemetry instances.
 */
export interface ExtensionServices {
  /** Session-scoped coordinator bridging shortcut presses to the active proxy (PRD §13.3/§37). */
  coordinator: TransitionCoordinator;
  /** Privacy-safe telemetry recorder (PRD §35). */
  telemetry: Telemetry;
}

/**
 * Builds a decorator from `(config, diagnostics, services, disabledProvider)`. Production uses
 * {@link createDefaultDecorator} (the real `ProviderDecorator` against pi-ai's live registry). Tests
 * inject a fake returning a spy so the module-global pi-ai registry is never mutated by the unit suite.
 * This optional second factory parameter is the only dependency-injection seam the entry point exposes;
 * Pi calls the default export with a single argument, so the seam is invisible in production.
 */
export type DecoratorFactory = (
  config: Config,
  diagnostics: Diagnostics,
  services: ExtensionServices,
  disabledProvider?: () => boolean,
) => DecoratorLifecycle;

/** Default decorator factory: constructs the real {@link ProviderDecorator} (real pi-ai registry). */
const createDefaultDecorator: DecoratorFactory = (config, diagnostics, services, disabledProvider) =>
  new ProviderDecorator(config, diagnostics, undefined, disabledProvider, services.coordinator, services.telemetry);

/**
 * Pi extension factory. Wires the Phase-0 foundation and registers cleanup.
 *
 * Sequence (inside one never-crash `try/catch`):
 *  1. `loadConfig()` — pure; always returns a valid {@link Config} (falls back to defaults).
 *  2. `createDiagnostics(config.diagnosticsLevel)` — frozen structured logger (PRD §36).
 *  3. `createDecorator(config, diagnostics)` — the transparent decorator (default = real
 *     `ProviderDecorator`; injectable for tests).
 *  4. `decorator.initialize()` — captures Pi's built-in provider and registers the transparent wrapper under
 *     `"stop-thinking-extension"` (PRD §19.2). The ONLY step that can throw in practice (built-in provider
 *     absent); caught below.
 *  5. `pi.on("session_shutdown", () => decorator.shutdown())` — register cleanup (EC-012). Registered ONLY
 *     after `initialize()` succeeds (nothing to clean up if it threw). The handler body is itself guarded so
 *     a shutdown failure cannot propagate into Pi's teardown.
 *
 * On any failure: if `diagnostics` is available, `diagnostics.error("extension.init-failed", { error })`;
 * otherwise `console.error(...)`. The factory **never rethrows** — Pi keeps its built-in provider unmodified,
 * so observational equivalence (ADR-005) holds trivially when decoration is skipped.
 *
 * @param pi              The Pi extension API (events + registrations).
 * @param createDecorator Optional decorator factory for tests (defaults to the real ProviderDecorator).
 */
export default function stopThinkingExtension(
  pi: ExtensionAPI,
  createDecorator: DecoratorFactory = createDefaultDecorator,
): void {
  let diagnostics: Diagnostics | undefined;

  try {
    // (1) Configuration — pure; always valid.
    const config = loadConfig();

    // (2) Structured logger (PRD §36).
    diagnostics = createDiagnostics(config.diagnosticsLevel);

    // (2a) Session-scoped coordinator (PRD §13.3/§37) — bridges shortcut presses to active proxy.
    const coordinator = new TransitionCoordinator(diagnostics);

    // (2b) Privacy-safe telemetry (PRD §35). No-op when `config.telemetryEnabled === false` (default).
    const telemetry = new Telemetry(config.telemetryEnabled, diagnostics);

    const services: ExtensionServices = { coordinator, telemetry };

    // EC-011: register the CLI disable flag. Non-fatal (own try/catch) — a fault is warned + decoration
    // proceeds; getFlag then yields undefined → the callback returns "not disabled".
    try {
      pi.registerFlag("stop-thinking", {
        type: "boolean",
        default: true,
        description: "Enable Stop Thinking & Do — interrupt z.ai reasoning and answer directly.",
      });
    } catch (err) {
      diagnostics.warn("extension.flag-register-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // (3) Construct the decorator (real registry by default; fake under test).
    // Thread the LIVE disable check (per-request getFlag read) and the coordinator+telemetry into it.
    const decorator = createDecorator(
      config,
      diagnostics,
      services,
      () => pi.getFlag("stop-thinking") === false,
    );

    // (4) Capture + register the transparent wrapper. May throw (built-in provider absent) — caught below.
    decorator.initialize();

    // (4a) Register the Ctrl+. shortcut (PRD §33 / §13.5 / §24.1). Non-fatal — a fault is warned + the
    // rest of the extension remains functional (the shortcut simply won't fire, but pass-through works).
    try {
      new ShortcutManager(diagnostics, telemetry).register(pi, config.shortcut, coordinator);
    } catch (err) {
      diagnostics.warn("extension.shortcut-register-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // (5) Register cleanup AFTER initialize() succeeds (nothing to clean up otherwise). EC-012.
    pi.on("session_shutdown", () => {
      try {
        decorator.shutdown();
      } catch (err) {
        // A cleanup failure must not propagate into Pi's session teardown.
        diagnostics?.error("extension.shutdown-failed", { error: err instanceof Error ? err.message : String(err) });
      }
    });

    diagnostics.info("extension.started", {});
  } catch (err) {
    // NEVER crash Pi: log and skip decoration. The built-in provider stays unmodified (PRD Appendix K).
    const message = err instanceof Error ? err.message : String(err);
    if (diagnostics) {
      diagnostics.error("extension.init-failed", { error: message });
    } else {
      // Defensive fallback: config or diagnostics itself failed before we had a logger.
      console.error(`[pi-stop-thinking] initialization failed: ${message}`);
    }
  }
}
