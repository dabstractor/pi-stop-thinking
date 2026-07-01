import { describe, test, expect } from "bun:test";
import {
  ProviderDecorator,
  STOP_THINKING_SOURCE_ID,
  OPENAI_COMPLETIONS_API,
} from "../src/provider/decorator";
import type { ProviderRegistry } from "../src/provider/decorator";
import type { Config } from "../src/config";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles ---------------------------------------------------------

/** A sentinel standing in for an AssistantMessageEventStream. Pass-through preserves identity (===). */
const STREAM_SENTINEL = { __sentinel: "stream" } as unknown;

/** Minimal Diagnostics stub (decorator only calls .debug/.info/.error in this phase). */
const noopDiagnostics: Diagnostics = {
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
 * Build a fake registry that records an ordered `calls` trace and captures the registered provider.
 * `present` controls whether getApiProvider returns a provider or undefined.
 */
function makeFakeRegistry(opts: { present?: boolean } = {}) {
  const present = opts.present ?? true;
  const calls: string[] = [];
  // The captured "built-in" delegates: record their args + return the SAME sentinel each call.
  const builtinArgs: Array<readonly unknown[]> = [];
  const streamArgs: Array<readonly unknown[]> = [];
  let callCountSimple = 0;
  let callCountStream = 0;
  const fakeProvider = {
    api: OPENAI_COMPLETIONS_API,
    stream: (...args: unknown[]) => {
      calls.push("builtin.stream");
      streamArgs.push(args);
      callCountStream++;
      return STREAM_SENTINEL;
    },
    streamSimple: (...args: unknown[]) => {
      calls.push("builtin.streamSimple");
      builtinArgs.push(args);
      callCountSimple++;
      return STREAM_SENTINEL;
    },
  };
  let registeredProvider:
    | { api: string; stream: unknown; streamSimple: unknown }
    | null = null;
  const registry: ProviderRegistry = {
    getApiProvider: (api: string) => {
      calls.push(`getApiProvider:${api}`);
      return present ? fakeProvider : undefined;
    },
    registerApiProvider: (provider, sourceId) => {
      calls.push(`registerApiProvider:${sourceId}`);
      registeredProvider = provider as {
        api: string;
        stream: unknown;
        streamSimple: unknown;
      };
    },
    unregisterApiProviders: (sourceId: string) => {
      calls.push(`unregisterApiProviders:${sourceId}`);
      registeredProvider = null;
    },
  };
  return {
    registry,
    calls,
    fakeProvider,
    get registered() {
      return registeredProvider;
    },
    stats: {
      get simpleCalls() {
        return callCountSimple;
      },
      get streamCalls() {
        return callCountStream;
      },
      lastSimpleArgs: () => builtinArgs[builtinArgs.length - 1],
      lastStreamArgs: () => streamArgs[streamArgs.length - 1],
    },
  };
}

// Three model shapes exercising the activation branches.
const mkModel = (
  over: Partial<{ provider: string; reasoning: boolean; api: string }> = {},
) =>
  ({
    id: "m",
    name: "M",
    api: OPENAI_COMPLETIONS_API,
    provider: "zai",
    reasoning: true,
    ...over,
  }) as never;
const ctx = { messages: [] } as never;
const opts = { temperature: 0.7 } as never;

// --- tests ----------------------------------------------------------------

describe("ProviderDecorator — initialize", () => {
  test("captures then registers the wrapper with the correct api + sourceId", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    expect(f.registered).not.toBeNull();
    expect(f.registered?.api).toBe(OPENAI_COMPLETIONS_API);
    expect(f.calls).toContain(`getApiProvider:${OPENAI_COMPLETIONS_API}`);
    expect(f.calls).toContain(
      `registerApiProvider:${STOP_THINKING_SOURCE_ID}`,
    );
  });

  test("getApiProvider is invoked BEFORE registerApiProvider (capture-before-register, PRD §19.2)", () => {
    const f = makeFakeRegistry();
    new ProviderDecorator(baseConfig, noopDiagnostics, f.registry).initialize();
    const getIdx = f.calls.indexOf(
      `getApiProvider:${OPENAI_COMPLETIONS_API}`,
    );
    const regIdx = f.calls.indexOf(
      `registerApiProvider:${STOP_THINKING_SOURCE_ID}`,
    );
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeGreaterThan(getIdx); // capture strictly precedes register
  });

  test("initialize is idempotent — a second call registers nothing new", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    const after1 = f.calls.filter((c) => c.startsWith("registerApiProvider")).length;
    d.initialize(); // no-op
    const after2 = f.calls.filter((c) => c.startsWith("registerApiProvider")).length;
    expect(after2).toBe(after1);
    expect(after1).toBe(1);
  });

  test("throws when the built-in provider is absent, and leaves state unchanged", () => {
    const f = makeFakeRegistry({ present: false });
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    expect(() => d.initialize()).toThrow(/not found/);
    expect(
      f.calls.some((c) => c.startsWith("registerApiProvider")),
    ).toBe(false);
    expect(f.registered).toBeNull();
    // shutdown on a never-initialized decorator is a safe no-op:
    expect(() => d.shutdown()).not.toThrow();
  });
});

describe("ProviderDecorator — wrapper delegation (transparent, all branches)", () => {
  function setup() {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    const wrapper = f.registered as {
      stream: (m: unknown, c: unknown, o: unknown) => unknown;
      streamSimple: (m: unknown, c: unknown, o: unknown) => unknown;
    };
    return { f, d, wrapper };
  }

  test("z.ai + reasoning + enabled (eligible) — STILL delegates transparently in Phase 0", () => {
    const { f, wrapper } = setup();
    const out = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(out).toBe(STREAM_SENTINEL); // identical stream reference (PRD §19.7)
    expect(f.stats.simpleCalls).toBe(1);
    expect(f.stats.lastSimpleArgs()).toEqual([mkModel(), ctx, opts]); // exact triple forwarded
  });

  test("non-z.ai provider — delegates transparently", () => {
    const { f, wrapper } = setup();
    const m = mkModel({ provider: "openai" });
    const out = wrapper.streamSimple(m, ctx, opts);
    expect(out).toBe(STREAM_SENTINEL);
    expect(f.stats.simpleCalls).toBe(1);
    expect(f.stats.lastSimpleArgs()).toEqual([m, ctx, opts]);
  });

  test("non-reasoning model — delegates transparently", () => {
    const { f, wrapper } = setup();
    const m = mkModel({ reasoning: false });
    expect(wrapper.streamSimple(m, ctx, opts)).toBe(STREAM_SENTINEL);
    expect(f.stats.simpleCalls).toBe(1);
  });

  test("feature disabled (config.enabled=false) — delegates transparently", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(
      { ...baseConfig, enabled: false },
      noopDiagnostics,
      f.registry,
    );
    d.initialize();
    const wrapper = f.registered as {
      streamSimple: (m: unknown, c: unknown, o: unknown) => unknown;
    };
    expect(wrapper.streamSimple(mkModel(), ctx, opts)).toBe(STREAM_SENTINEL);
    expect(f.stats.simpleCalls).toBe(1);
  });

  test("delegation never recurses into the wrapper (goes to the captured builtin, not the registry)", () => {
    const { f, wrapper } = setup();
    wrapper.streamSimple(mkModel(), ctx, opts);
    // The only registry calls are the single capture (init) + single register; delegation did NOT
    // re-enter getApiProvider/registerApiProvider:
    const getCount = f.calls.filter((c) =>
      c.startsWith("getApiProvider"),
    ).length;
    const regCount = f.calls.filter((c) =>
      c.startsWith("registerApiProvider"),
    ).length;
    expect(getCount).toBe(1);
    expect(regCount).toBe(1);
    // And it invoked the captured builtin exactly once:
    expect(f.stats.simpleCalls).toBe(1);
  });

  test("stream path delegates unconditionally (interception is streamSimple-only)", () => {
    const { f, wrapper } = setup();
    const m = mkModel({ provider: "openai", reasoning: false });
    expect(wrapper.stream(m, ctx, opts)).toBe(STREAM_SENTINEL);
    expect(f.stats.streamCalls).toBe(1);
    expect(f.stats.lastStreamArgs()).toEqual([m, ctx, opts]);
  });
});

describe("ProviderDecorator — shutdown", () => {
  test("unregisters under the sourceId exactly once and resets state", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    d.shutdown();
    expect(f.calls).toContain(
      `unregisterApiProviders:${STOP_THINKING_SOURCE_ID}`,
    );
    expect(f.registered).toBeNull();
  });

  test("shutdown is idempotent — a second call does not unregister again", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    d.shutdown();
    const after1 = f.calls.filter((c) =>
      c.startsWith("unregisterApiProviders"),
    ).length;
    d.shutdown();
    const after2 = f.calls.filter((c) =>
      c.startsWith("unregisterApiProviders"),
    ).length;
    expect(after1).toBe(1);
    expect(after2).toBe(1);
  });

  test("shutdown on an uninitialized decorator is a safe no-op", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    expect(() => d.shutdown()).not.toThrow();
    expect(
      f.calls.some((c) => c.startsWith("unregisterApiProviders")),
    ).toBe(false);
  });

  test("initialize works again after shutdown (capture fresh, re-register)", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    d.shutdown();
    d.initialize();
    expect(f.registered).not.toBeNull();
    expect(f.registered?.api).toBe(OPENAI_COMPLETIONS_API);
    // two captures + two registers across the full lifecycle:
    expect(
      f.calls.filter((c) => c.startsWith("getApiProvider")).length,
    ).toBe(2);
    expect(
      f.calls.filter((c) => c.startsWith("registerApiProvider")).length,
    ).toBe(2);
  });
});

describe("ProviderDecorator — constants", () => {
  test("exports the expected sourceId and api constants", () => {
    expect(STOP_THINKING_SOURCE_ID).toBe("stop-thinking-extension");
    expect(OPENAI_COMPLETIONS_API).toBe("openai-completions");
  });
});
