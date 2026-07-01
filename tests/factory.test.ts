import { describe, test, expect, mock } from "bun:test";
import stopThinkingExtension, {
  type DecoratorFactory,
  type DecoratorLifecycle,
} from "../src/index";
import { createDiagnostics } from "../src/diagnostics";
import type { Diagnostics, DiagnosticsSink } from "../src/diagnostics";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- test doubles ---------------------------------------------------------

/** A fake decorator: spy on initialize/shutdown. opts lets you make either throw. */
function makeFakeDecorator(opts: { initThrows?: boolean; shutdownThrows?: boolean } = {}) {
  const initialize = mock(() => {
    if (opts.initThrows) throw new Error("init boom");
  });
  const shutdown = mock(() => {
    if (opts.shutdownThrows) throw new Error("shutdown boom");
  });
  const decorator: DecoratorLifecycle = { initialize, shutdown };
  return { decorator, initialize, shutdown };
}

/**
 * Build a fake decorator FACTORY that returns `decorator` and records whether it was called.
 * Returned `createDecorator` is the second argument to stopThinkingExtension.
 */
function makeFakeFactory(opts: { initThrows?: boolean; shutdownThrows?: boolean } = {}) {
  const built = makeFakeDecorator(opts);
  let calls = 0;
  let lastArgs: { config: unknown; diagnostics: unknown } | undefined;
  const createDecorator: DecoratorFactory = (config, diagnostics) => {
    calls++;
    lastArgs = { config, diagnostics };
    return built.decorator;
  };
  return { createDecorator, ...built, getCalls: () => calls, lastArgs: () => lastArgs };
}

/** Minimal fake ExtensionAPI: captures the session_shutdown handler; records registerFlag calls;
 * supports controllable getFlag. No-ops everything else. */
function makeFakePi(opts: { registerFlagThrows?: boolean } = {}) {
  let shutdownHandler: ((e: unknown, ctx: unknown) => void) | null = null;
  const registeredFlags: Array<{ name: string; options: { type: string; default?: unknown; description?: string } }> = [];
  const flags = new Map<string, boolean | string>([["stop-thinking", true]]);
  const on = mock((event: string, handler: (e: unknown, ctx: unknown) => void) => {
    if (event === "session_shutdown") shutdownHandler = handler;
  });
  const registerFlag = mock((name: string, options: { type: string; default?: unknown; description?: string }) => {
    if (opts.registerFlagThrows) throw new Error("registerFlag boom");
    flags.set(name, options.default ?? true);
    registeredFlags.push({ name, options });
  });
  const getFlag = mock((name: string) => flags.get(name));
  const pi = { on, registerFlag, getFlag } as unknown as ExtensionAPI;
  return {
    pi,
    on,
    registerFlag,
    getFlag,
    registeredFlags,
    setFlagValue(name: string, value: boolean | string) {
      flags.set(name, value);
    },
    get shutdownRegistered() {
      return shutdownHandler !== null;
    },
    fireShutdown() {
      if (shutdownHandler) shutdownHandler({ type: "session_shutdown", reason: "quit" }, {});
    },
  };
}

/** A capturing DiagnosticsSink + the real Diagnostics built from it. */
function makeCapturingDiagnostics(level: "error" | "debug" = "error"): { diagnostics: Diagnostics; sink: DiagnosticsSink & { log: string[]; error: string[] } } {
  const sink: DiagnosticsSink & { log: string[]; error: string[] } = {
    log: [],
    error: [],
  };
  return { diagnostics: createDiagnostics(level, sink), sink };
}

// --- tests ----------------------------------------------------------------

describe("stopThinkingExtension — happy path", () => {
  test("initializes the decorator and registers a session_shutdown handler", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();

    expect(() => stopThinkingExtension(pi.pi, f.createDecorator)).not.toThrow();

    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(pi.shutdownRegistered).toBe(true);
  });

  test("firing session_shutdown calls decorator.shutdown() exactly once", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);

    pi.fireShutdown();
    expect(f.shutdown).toHaveBeenCalledTimes(1);

    // A second fire also calls shutdown (the handler is not auto-removed; decorator.shutdown is idempotent):
    pi.fireShutdown();
    expect(f.shutdown).toHaveBeenCalledTimes(2);
  });

  test("createDecorator receives a valid Config and the factory-built Diagnostics", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);

    expect(f.getCalls()).toBe(1);
    expect(f.lastArgs()?.config).toMatchObject({ enabled: true, supportedProviders: ["zai"] });
    // Diagnostics is a frozen object with the five level methods.
    const diag = f.lastArgs()?.diagnostics;
    expect(diag).toBeDefined();
    expect(Object.isFrozen(diag!)).toBe(true);
    expect(typeof (diag as Diagnostics).error).toBe("function");
  });
});

describe("stopThinkingExtension — init failure isolation (never crash Pi)", () => {
  test("initialize() throwing does NOT rethrow and does NOT register session_shutdown", () => {
    const f = makeFakeFactory({ initThrows: true });
    const pi = makeFakePi();

    expect(() => stopThinkingExtension(pi.pi, f.createDecorator)).not.toThrow();
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(pi.shutdownRegistered).toBe(false); // nothing to clean up
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  test("emits a diagnostics.error line on init failure via console.error", () => {
    const f = makeFakeFactory({ initThrows: true });
    const pi = makeFakePi();

    // The factory creates its own Diagnostics with the default console sink, so we
    // capture console.error to verify the error line was emitted.
    const errors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      stopThinkingExtension(pi.pi, f.createDecorator);
    } finally {
      console.error = origConsoleError;
    }

    // At least one console.error line was emitted containing the init-failed event.
    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("extension.init-failed");
    expect(errorOutput).toContain("init boom");
  });
});

describe("stopThinkingExtension — EC-011 flag registration + disable callback", () => {
  test("registers the stop-thinking boolean flag (default true) exactly once", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);
    const reg = pi.registeredFlags.find((x) => x.name === "stop-thinking");
    expect(reg).toBeDefined();
    expect(reg.options.type).toBe("boolean");
    expect(reg.options.default).toBe(true);
  });

  test("the disable callback reflects the LIVE getFlag value (per-request read)", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    let captured: (() => boolean) | undefined;
    stopThinkingExtension(
      pi.pi,
      (config, diag, disabledProvider) => {
        captured = disabledProvider;
        return f.createDecorator(config, diag); // underlying fake ignores it
      },
    );
    expect(captured).toBeTypeOf("function");
    pi.setFlagValue("stop-thinking", true); expect(captured!()).toBe(false); // enabled → not disabled
    pi.setFlagValue("stop-thinking", false); expect(captured!()).toBe(true); // disabled
  });

  test("a registerFlag fault is swallowed (warned) and decoration STILL proceeds", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi({ registerFlagThrows: true });
    expect(() => stopThinkingExtension(pi.pi, f.createDecorator)).not.toThrow();
    expect(f.initialize).toHaveBeenCalledTimes(1); // decoration proceeded despite the flag fault
    expect(pi.shutdownRegistered).toBe(true); // session_shutdown still registered
  });
});

describe("stopThinkingExtension — EC-012 session_shutdown restores registration", () => {
  test("firing session_shutdown calls decorator.shutdown() exactly once (no orphan)", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);
    pi.fireShutdown();
    expect(f.shutdown).toHaveBeenCalledTimes(1); // → unregisterApiProviders(sourceId) in the real decorator
  });
});

describe("stopThinkingExtension — shutdown failure isolation", () => {
  test("a shutdown() throw inside the handler is swallowed (does not propagate)", () => {
    const f = makeFakeFactory({ shutdownThrows: true });
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);

    expect(() => pi.fireShutdown()).not.toThrow(); // swallowed + logged, not rethrown
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });
});
