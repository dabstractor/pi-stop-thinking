/**
 * # Lifecycle tests — EC-011 / EC-012 / EC-013 end-to-end flows
 *
 * Uses the REAL ProviderDecorator against injected fake registry + fake ExtensionAPI.
 * No global-registry mutation. Tests the three error-code contracts:
 *
 * - EC-011: runtime disable flag bypasses the proxy for NEW requests; active transitions continue.
 * - EC-012: session_shutdown → shutdown → no orphaned registration.
 * - EC-013: shutdown → initialize re-captures + re-registers cleanly (reload cycle).
 */

import { describe, test, expect } from "bun:test";
import {
  ProviderDecorator,
  OPENAI_COMPLETIONS_API,
} from "../src/provider/decorator";
import type { ProviderRegistry } from "../src/provider/decorator";
import type { Config } from "../src/config";
import type { Diagnostics } from "../src/diagnostics";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// --- test doubles ---------------------------------------------------------

const noopDiag: Diagnostics = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as Diagnostics;

const baseConfig: Config = {
  enabled: true,
  shortcut: "ctrl+.",
  supportedProviders: ["zai"],
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
};

/**
 * A sentinel that the fake builtin returns, allowing us to distinguish
 * "delegated directly to builtin" from "routed through a StreamProxy".
 */
const STREAM_SENTINEL = { __sentinel: "stream" } as unknown;

/**
 * Build a fake registry that records calls and captures the registered provider.
 * The fake builtin's streamSimple returns STREAM_SENTINEL (not a real stream), so
 * any delegation bypass is trivially detectable by identity comparison.
 */
function makeFakeRegistry() {
  let simpleCallCount = 0;
  let registeredProvider:
    | { api: string; stream: unknown; streamSimple: unknown }
    | null = null;

  const fakeProvider = {
    api: OPENAI_COMPLETIONS_API,
    stream: (..._args: unknown[]) => STREAM_SENTINEL,
    streamSimple: (..._args: unknown[]) => {
      simpleCallCount++;
      return STREAM_SENTINEL;
    },
  };

  const registry: ProviderRegistry = {
    getApiProvider: () => fakeProvider,
    registerApiProvider: (provider, _sourceId) => {
      registeredProvider = provider as {
        api: string;
        stream: unknown;
        streamSimple: unknown;
      };
    },
    unregisterApiProviders: (_sourceId) => {
      registeredProvider = null;
    },
  };

  return {
    registry,
    get registered() {
      return registeredProvider;
    },
    get simpleCalls() {
      return simpleCallCount;
    },
  };
}

/** Fake ExtensionAPI with registerFlag/getFlag/on (for EC-011 flag-driven flows). */
function makeFakePi() {
  const flags = new Map<string, boolean | string>([["stop-thinking", true]]);
  let shutdownHandler:
    | ((e: unknown, ctx: unknown) => void)
    | null = null;
  return {
    pi: {
      registerFlag: (
        name: string,
        opts: { type: string; default?: unknown; description?: string },
      ) => {
        flags.set(name, opts.default ?? true);
      },
      getFlag: (name: string) => flags.get(name),
      on: (ev: string, h: (e: unknown, ctx: unknown) => void) => {
        if (ev === "session_shutdown") shutdownHandler = h;
      },
    } as never,
    setFlag: (v: boolean) => flags.set("stop-thinking", v),
    fireShutdown: () =>
      shutdownHandler?.(
        { type: "session_shutdown", reason: "reload" },
        {},
      ),
  };
}

const mkModel = () =>
  ({
    id: "m",
    name: "M",
    api: OPENAI_COMPLETIONS_API,
    provider: "zai",
    reasoning: true,
  }) as never;
const ctx = { messages: [] } as never;
const opts = {} as never;

// --- tests ----------------------------------------------------------------

describe("lifecycle — EC-011/012/013", () => {
  test("EC-011: flag=false bypasses the proxy; flag=true builds it (live, per-request)", () => {
    const pi = makeFakePi();
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(
      baseConfig,
      noopDiag,
      f.registry,
      () => pi.pi.getFlag("stop-thinking") === false,
    );
    d.initialize();
    const wrapper = f.registered as {
      streamSimple: (m: unknown, c: unknown, o: unknown) => unknown;
    };

    // Flag set to false → disabled → delegate to builtin (sentinel), no proxy
    pi.setFlag(false);
    const outDisabled = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(outDisabled).toBe(STREAM_SENTINEL); // builtin's sentinel, not a proxy output
    expect(f.simpleCalls).toBe(1);

    // Flag set to true → enabled → builds a proxy (NOT the sentinel)
    pi.setFlag(true);
    const outEnabled = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(outEnabled).not.toBe(STREAM_SENTINEL); // proxy.output (a fresh AssistantMessageEventStream)
  });

  test("EC-012: session_shutdown → shutdown → no orphaned registration", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);
    d.initialize();
    expect(f.registered).not.toBeNull();
    d.shutdown();
    expect(f.registered).toBeNull(); // restored (no orphan)
  });

  test("EC-013: shutdown → initialize re-registers cleanly (reload cycle)", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);
    d.initialize();
    d.shutdown();
    d.initialize(); // reload = restore then re-capture/re-register
    expect(f.registered).not.toBeNull();
    // The re-registered wrapper still works:
    const wrapper = f.registered as {
      streamSimple: (m: unknown, c: unknown, o: unknown) => unknown;
    };
    const out = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(out).not.toBe(STREAM_SENTINEL); // proxy built (enabled, eligible)
  });
});
