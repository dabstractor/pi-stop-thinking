/**
 * # ProviderDecorator — capture Pi's built-in provider and register a transparent wrapper.
 *
 * This module is the single place the Stop Thinking & Do extension touches Pi's provider resolution
 * (ADR-003: Decorate the Built-in Provider). It captures the built-in `openai-completions` provider and
 * registers a wrapper under sourceId {@link STOP_THINKING_SOURCE_ID}.
 *
 * **Phase 1 scope:** the wrapper evaluates the activation conditions (PRD §19.5 / §19.6) and routes
 * eligible z.ai reasoning requests through the transparent StreamProxy (PRD §19.5 "Construct Proxy →
 * Delegate Initial Request → Monitor Stream"; PRD §19.7 Pass-through Guarantee, ADR-005). All other
 * requests delegate directly to the captured built-in, byte-identically.
 *
 * The decoration is reversible: {@link ProviderDecorator.shutdown} unregisters via the sourceId,
 * restoring the built-in (PRD §28 Invariants; EC-012).
 */

import {
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { StreamProxy } from "./proxy";
import type {
  ApiStreamFunction,
  ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai";
import type { Config } from "../config";
import type { Diagnostics } from "../diagnostics";
import type { TransitionCoordinator } from "../state/coordinator";
import type { Telemetry } from "../telemetry";

/** The OpenAI-compatible api type that z.ai models use (PRD §19.6 Condition B). */
export const OPENAI_COMPLETIONS_API = "openai-completions" as const;

/** sourceId under which the wrapper is registered; enables clean unregister on shutdown (PRD §28). */
export const STOP_THINKING_SOURCE_ID = "stop-thinking-extension" as const;

/**
 * The three pi-ai registry functions the decorator depends on, bundled for dependency injection.
 *
 * Production passes no argument (the constructor defaults to the real functions from
 * `@earendil-works/pi-ai`). Tests inject capturing doubles so they never mutate pi-ai's module-global
 * `apiProviderRegistry` (importing the decorator value-imports pi-ai, which eagerly registers builtins).
 */
export interface ProviderRegistry {
  /** @see getApiProvider */
  getApiProvider: typeof getApiProvider;
  /** @see registerApiProvider */
  registerApiProvider: typeof registerApiProvider;
  /** @see unregisterApiProviders */
  unregisterApiProviders: typeof unregisterApiProviders;
}

/** The real pi-ai registry, used as the production default for {@link ProviderRegistry}. */
const DEFAULT_REGISTRY: ProviderRegistry = {
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
};

/** The captured built-in provider (`ApiProviderInternal` is not exported → infer it). */
type CapturedProvider = NonNullable<ReturnType<typeof getApiProvider>>;

/**
 * Owns capture of Pi's built-in provider, registration of the transparent wrapper, and the reversible
 * lifecycle (PRD §13.1, §28).
 *
 * Invariants (PRD §28): the captured provider is immutable for the decorator's lifetime; registration
 * occurs exactly once; decoration is reversible; **the wrapper never delegates to itself** (enforced by
 * capturing BEFORE registering — see {@link initialize}).
 */
export class ProviderDecorator {
  private readonly config: Config;
  private readonly diagnostics: Diagnostics;
  private readonly registry: ProviderRegistry;
  private original: CapturedProvider | undefined;
  private registered = false;
  /**
   * EC-011 (PRD Appendix B): runtime disable check, evaluated PER REQUEST. The factory supplies
   * `() => pi.getFlag("stop-thinking") === false` so a CLI flag (--no-stop-thinking) or a runtime
   * setFlagValue change takes effect for the NEXT request. When true, wrapperStreamSimple delegates
   * directly to the captured built-in WITHOUT constructing a StreamProxy. ACTIVE transitions are
   * unaffected: each already-constructed proxy holds its own captured originalStreamSimple closure and
   * is unreachable from the decorator after construction (the flag is checked only at request start).
   * Defaults to `() => false` (never disabled) so omitting the param is behavior-preserving.
   */
  private readonly _disabledProvider: () => boolean;
  /** Session-scoped coordinator for active-proxy tracking (PRD §13.3/§37). Optional so
   *  existing call sites (tests) remain unchanged. */
  private readonly _coordinator?: TransitionCoordinator;
  /** Privacy-safe telemetry recorder (PRD §35). Optional — omitted when telemetry is disabled. */
  private readonly _telemetry?: Telemetry;

  /**
   * @param config      Configuration (reads `enabled` = Condition D, `supportedProviders` = Condition A).
   * @param diagnostics Structured logger (frozen instance, passed by reference per the Diagnostics contract).
   * @param registry    Optional pi-ai registry bundle for DI. Defaults to the real functions; tests pass
   *                    capturing doubles. **Privacy (Appendix H):** only `provider`/`model`/`api` metadata
   *                    are ever passed to diagnostics — never options, context, or stream content.
   * @param disabledProvider Optional per-request disable callback (EC-011). When it returns `true`,
   *                    the wrapper delegates directly without constructing a StreamProxy. Defaults to
   *                    `() => false` (never disabled) so omitting it preserves every existing call site.
   */
  constructor(
    config: Config,
    diagnostics: Diagnostics,
    registry: ProviderRegistry = DEFAULT_REGISTRY,
    disabledProvider?: () => boolean,
    coordinator?: TransitionCoordinator,
    telemetry?: Telemetry,
  ) {
    this.config = config;
    this.diagnostics = diagnostics;
    this.registry = registry;
    this._disabledProvider = disabledProvider ?? (() => false);
    this._coordinator = coordinator;
    this._telemetry = telemetry;
  }

  /**
   * Capture the built-in `openai-completions` provider and register the transparent wrapper under
   * sourceId `"stop-thinking-extension"`.
   *
   * **CRITICAL ORDERING (PRD §19.2 — absolute):** the built-in provider **MUST be captured BEFORE the
   * wrapper is registered**. `registerApiProvider` overwrites the registry entry for this api; if capture
   * happened afterward, the wrapper would capture itself and every delegation would recurse infinitely.
   * Capturing first means the wrapper's delegated reference points at the real built-in (captured before
   * the overwrite), so delegation is byte-identical and never recursive (PRD §28: "Wrapper never
   * delegates to itself").
   *
   * The wrapper is registered with sourceId `"stop-thinking-extension"` so {@link shutdown} can remove
   * exactly this entry via `unregisterApiProviders("stop-thinking-extension")`, restoring the built-in.
   *
   * Idempotent: a second call when already registered is a no-op (PRD §28: "Registration occurs exactly
   * once"). Throws if the built-in provider is not present (leaves state unchanged).
   */
  initialize(): void {
    if (this.registered) return;

    // STEP 1 — Capture BEFORE registering (PRD §19.2 absolute ordering; prevents infinite recursion).
    const original = this.registry.getApiProvider(OPENAI_COMPLETIONS_API);
    if (!original) {
      this.diagnostics.error("provider.decorator.capture-missing", { api: OPENAI_COMPLETIONS_API });
      throw new Error(
        `ProviderDecorator.initialize: built-in provider not found for api "${OPENAI_COMPLETIONS_API}"`,
      );
    }
    this.original = original;

    // The captured stream/streamSimple are pi-ai's already-wrapped builtins (api-guarded). Delegating
    // through them is byte-identical and never recurses into our wrapper.
    const originalStream: ApiStreamFunction = original.stream;
    const originalStreamSimple: ApiStreamSimpleFunction = original.streamSimple;

    // STEP 2 — Build the wrappers. registerApiProvider will api-guard these (wrapStreamSimple), so our
    // functions are only ever invoked for model.api === "openai-completions" — we do NOT re-check api.
    const wrapperStream: ApiStreamFunction = (model, context, options) => {
      // The `stream` path is unconditionally transparent (interception is streamSimple-only; M2).
      this.diagnostics.debug("provider.stream.delegate", {
        api: model.api,
        provider: String(model.provider),
        model: model.id,
      });
      return originalStream(model, context, options);
    };

    const wrapperStreamSimple: ApiStreamSimpleFunction = (model, context, options) => {
      // EC-011 (PRD Appendix B): runtime disable flag (e.g. --no-stop-thinking). When disabled, delegate to
      // the captured built-in WITHOUT constructing a StreamProxy for NEW requests. An ACTIVE transition
      // (already-constructed proxy) is unreachable here — it runs on its own closure to completion. This is
      // distinct from EC-016 (config.enabled), which is checked in `eligible` below.
      if (this._disabledProvider()) {
        this.diagnostics.debug("provider.streamSimple.disabled-delegate", {
          api: model.api,
          provider: String(model.provider),
          model: model.id,
        });
        return originalStreamSimple(model, context, options);
      }

      // Activation conditions per PRD §19.5 / §19.6 (B is guaranteed by the registry's api-guard):
      //   A: provider in config.supportedProviders
      //   C: model.reasoning
      //   D: config.enabled
      //   (E: not already interrupting — trivially true in Phase 1; modelled in P1.M4.T4.S1.)
      const eligible =
        this.config.enabled &&
        model.reasoning &&
        this.config.supportedProviders.includes(String(model.provider));

      if (eligible) {
        // z.ai reasoning model + feature enabled → route through the transparent StreamProxy
        // (PRD §19.5 "Construct Proxy → Delegate Initial Request → Monitor Stream"; §19.6 A–E).
        // Observational equivalence holds because the proxy only forwards events, unchanged, through a
        // fresh AssistantMessageEventStream (PRD §19.7; §20.5 — downstream never touches the upstream).
        this.diagnostics.debug("provider.streamSimple.proxy", {
          api: model.api,
          provider: String(model.provider),
          model: model.id,
        });
        const proxy = new StreamProxy(
          model, context, options ?? {}, originalStreamSimple, this.diagnostics,
          undefined, undefined,
          this.config.transitionTimeoutMs, undefined, this.config.replacementStartupTimeoutMs,
          this._coordinator,
        );
        // INV-004: register this proxy as the active target for shortcut-driven stop requests.
        this._coordinator?.setActiveProxy(proxy);
        this._telemetry?.incrementCounter("RequestsDelegated");
        return proxy.output;
      }

      this.diagnostics.debug("provider.streamSimple.delegate", {
        api: model.api,
        provider: String(model.provider),
        model: model.id,
      });
      return originalStreamSimple(model, context, options);
    };

    // STEP 3 — Register the wrapper under our sourceId (capture already happened → no self-recursion).
    this.registry.registerApiProvider(
      {
        api: OPENAI_COMPLETIONS_API,
        stream: wrapperStream,
        streamSimple: wrapperStreamSimple,
      },
      STOP_THINKING_SOURCE_ID,
    );
    this.registered = true;
    this.diagnostics.info("provider.decorator.initialized", {});
  }

  /**
   * Unregister the wrapper (restoring the built-in provider) and reset state. Idempotent.
   *
   * Calls `unregisterApiProviders("stop-thinking-extension")`, which removes only the entry registered
   * under our sourceId (the built-in was registered with no sourceId and is untouched). After shutdown,
   * {@link initialize} may be called again to re-capture + re-register.
   */
  shutdown(): void {
    if (!this.registered) return;
    this.registry.unregisterApiProviders(STOP_THINKING_SOURCE_ID);
    this.original = undefined;
    this.registered = false;
    this.diagnostics.info("provider.decorator.shutdown", {});
  }
}
