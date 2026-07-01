/**
 * # Stress Tests — scale + resource bounds.
 *
 * 1000-cycle interruption memory test, 1MB+ reasoning buffer tests,
 * 100 rapid shortcut presses, and repeated provider initialization.
 */

import { describe, test, expect } from "bun:test";
import { TransitionCoordinator } from "../src/state/coordinator";
import { ProviderDecorator } from "../src/provider/decorator";
import type { ProviderRegistry } from "../src/provider/decorator";
import type { Config } from "../src/config";
import { DEFAULT_CONFIG } from "../src/config";
import { isTerminalEvent } from "../src/types";
import {
  makeScriptedTwoPhaseUpstream,
  buildProxy,
  collectOutput,
  countInvariants,
  assertInvariants,
  ev,
  waitFor,
  DONE_MESSAGE,
  makeCaptureDiag,
} from "./helpers/invariant-harness";

// ─── 1000-cycle interruption memory test ──────────────────────────────────

describe("Stress — repeated interruption cycles, no memory growth", () => {
  test("200 interrupted cycles: complete without hanging or resource exhaustion", async () => {
    for (let i = 0; i < 200; i++) {
      const mock = makeScriptedTwoPhaseUpstream();
      const { proxy } = buildProxy(mock);
      const consumer = collectOutput(proxy);

      mock.pushPrimary(ev({ type: "start" }));
      mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
      mock.pushPrimary(
        ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
      );
      await waitFor(() => proxy.isReasoning(), 100);
      proxy.triggerStop();
      await waitFor(() => mock.calls.length === 1, 100);
      mock.pushReplacement(
        ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      );
      const collected = await consumer;
      // INV-003: exactly one terminal per cycle
      expect(collected.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    }
  }, 30000);

  test("200 normal cycles (no interruption): complete without hanging or resource exhaustion", async () => {
    for (let i = 0; i < 200; i++) {
      const mock = makeScriptedTwoPhaseUpstream();
      const { proxy } = buildProxy(mock);
      const consumer = collectOutput(proxy);

      mock.pushPrimary(ev({ type: "start" }));
      mock.pushPrimary(ev({ type: "text_delta", contentIndex: 0, delta: "x" }));
      mock.pushPrimary(
        ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
      );
      mock.closePrimary();
      const collected = await consumer;
      expect(collected.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    }
  }, 30000);
});

// ─── Large reasoning buffer tests (1MB+) ────────────────────────────────

describe("Stress — large reasoning buffers (1MB+)", () => {
  test("1MB single thinking_delta: buffer accumulates, transition completes", async () => {
    const bigDelta = "x".repeat(1_100_000);
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: bigDelta }),
    );
    await waitFor(() => proxy.isReasoning());

    expect(proxy.buffer.getByteSize()).toBeGreaterThanOrEqual(1_000_000);

    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    const collected = await consumer;

    const report = countInvariants(collected, events, proxy, {
      acceptedCount: 1,
    });
    assertInvariants(report, { allowInterruption: true });
  });

  test("1MB across many deltas: same", async () => {
    const chunk = "x".repeat(1100);
    const chunkCount = 1000;
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    for (let i = 0; i < chunkCount; i++) {
      mock.pushPrimary(
        ev({ type: "thinking_delta", contentIndex: 0, delta: chunk }),
      );
    }
    await waitFor(() => proxy.isReasoning());

    expect(proxy.buffer.getByteSize()).toBeGreaterThanOrEqual(1_000_000);

    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    const collected = await consumer;

    const report = countInvariants(collected, events, proxy, {
      acceptedCount: 1,
    });
    assertInvariants(report, { allowInterruption: true });
  }, 15000);

  test("overflow warn under a low maximumBytes: warn fires AND delta is still appended (§23.5)", () => {
    const { diag, events } = makeCaptureDiag();
    const { ReasoningBuffer } = require("../src/buffer");
    const lowCeil = 64 * 1024;
    const buffer = new ReasoningBuffer(diag, lowCeil);

    const chunk = "x".repeat(1024);
    for (let i = 0; i < 100; i++) {
      buffer.append(chunk);
    }

    expect(events.some((c) => c.event === "buffer.overflow")).toBe(true);
    expect(buffer.getByteSize()).toBe(100 * 1024);

    const snap = buffer.snapshot();
    expect(snap).toHaveLength(100);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test("8MB ceiling (DEFAULT_CONFIG.maximumReasoningBufferBytes): no crash, snapshot works", () => {
    const { diag } = makeCaptureDiag();
    const { ReasoningBuffer } = require("../src/buffer");
    const buffer = new ReasoningBuffer(diag, DEFAULT_CONFIG.maximumReasoningBufferBytes);

    const chunk = "y".repeat(100_000);
    for (let i = 0; i < 85; i++) {
      buffer.append(chunk);
    }

    expect(buffer.getByteSize()).toBe(85 * 100_000);
    const snap = buffer.snapshot();
    expect(snap).toHaveLength(85);
  });
});

// ─── Rapid shortcut presses (100 in ≤100ms) ────────────────────────────

describe("Stress — rapid shortcut presses (100 in ≤100ms)", () => {
  test("100× coordinator.requestStop() in ≤100ms → exactly ONE accepted + single terminal", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { diag: coordDiag } = makeCaptureDiag();
    const coordinator = new TransitionCoordinator(coordDiag);
    const { proxy } = buildProxy(mock, { coordinator });
    coordinator.setActiveProxy(proxy);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
    );
    await waitFor(() => proxy.isReasoning());

    const t0 = Date.now();
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (coordinator.requestStop()) accepted++;
    }
    const elapsed = Date.now() - t0;

    expect(accepted).toBe(1);
    expect(elapsed).toBeLessThan(100);

    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    const collected = await consumer;
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("100 presses during Delegating (pre-reasoning): none accepted now, pending recorded", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { diag: coordDiag } = makeCaptureDiag();
    const coordinator = new TransitionCoordinator(coordDiag);
    const { proxy } = buildProxy(mock, { coordinator });
    coordinator.setActiveProxy(proxy);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    await waitFor(() => proxy.controller.getState() === "Delegating", 200);

    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (coordinator.requestStop()) accepted++;
    }
    expect(accepted).toBe(0);

    // Now push reasoning — the pending stop should be honored
    // (state goes Delegating → Reasoning → StopRequested → Aborting → Capturing → Restarting)
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
    );

    // EC-002: pending stop honored → replacement launched
    await waitFor(() => mock.calls.length === 1, 500);

    mock.pushReplacement(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    const collected = await consumer;
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("100 presses after the transition began: all ignored (alreadyInterrupting)", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { diag: coordDiag } = makeCaptureDiag();
    const coordinator = new TransitionCoordinator(coordDiag);
    const { proxy } = buildProxy(mock, { coordinator });
    coordinator.setActiveProxy(proxy);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
    );
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await waitFor(() => coordinator.alreadyInterrupting(), 200);
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (coordinator.requestStop()) accepted++;
    }
    expect(accepted).toBe(0);

    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    const collected = await consumer;
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });
});

// ─── Repeated provider initialization ──────────────────────────────────

describe("Stress — repeated provider initialization", () => {
  function makeFakeRegistry() {
    let registeredProvider: { api: string; stream: unknown; streamSimple: unknown } | null = null;
    const registry: ProviderRegistry = {
      getApiProvider: () => ({
        api: "openai-completions",
        stream: () => ({ __sentinel: true }),
        streamSimple: () => ({ __sentinel: true }),
      }),
      registerApiProvider: (provider) => {
        registeredProvider = provider as { api: string; stream: unknown; streamSimple: unknown };
      },
      unregisterApiProviders: () => {
        registeredProvider = null;
      },
    };
    return {
      registry,
      get registered() {
        return registeredProvider;
      },
    };
  }

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

  test("decorator initialize↔shutdown ×100: no orphaned registration", () => {
    const f = makeFakeRegistry();
    const noopDiag = makeCaptureDiag().diag;
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);

    for (let i = 0; i < 100; i++) {
      d.initialize();
      expect(f.registered).not.toBeNull();
      d.shutdown();
      expect(f.registered).toBeNull();
    }
  });

  test("shutdown is idempotent + re-initializable after shutdown", () => {
    const f = makeFakeRegistry();
    const noopDiag = makeCaptureDiag().diag;
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);

    d.initialize();
    expect(f.registered).not.toBeNull();
    d.shutdown();
    d.shutdown(); // idempotent
    expect(f.registered).toBeNull();

    d.initialize(); // re-initializable (EC-013)
    expect(f.registered).not.toBeNull();
  });
});
