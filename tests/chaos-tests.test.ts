/**
 * # Chaos Tests — random upstream error injection.
 *
 * Injects random errors (throw OR error event) at random points in the primary or replacement
 * stream. Each case asserts single terminal, output.result() resolves, FSM ends Idle,
 * exactly-once cleanup, and privacy-safe diagnostics.
 *
 * ≥30 per-seed cases + ≥5 targeted edge injections.
 */

import { describe, test, expect } from "bun:test";
import { isTerminalEvent } from "../src/types";
import {
  mulberry32,
  ri,
  pick,
  makeScriptedTwoPhaseUpstream,
  buildProxy,
  collectOutput,
  assertPrivacy,
  ev,
  waitFor,
  DONE_MESSAGE,
  countInvariants,
  makeCaptureDiag,
} from "./helpers/invariant-harness";

// ─── Randomized chaos cases (30 seeds) ─────────────────────────────────

describe("Chaos — random upstream errors never produce a broken stream", () => {
  for (let seed = 0; seed < 30; seed++) {
    test(`seed=${seed} recovers to a single clean terminal`, async () => {
      const rng = mulberry32(1000 + seed);
      const errorPhase = pick(rng, ["primary", "replacement"] as const);
      const errorAs = pick(rng, ["throw", "event"] as const);
      const atIndex = ri(rng, 0, 4);

      const mock = makeScriptedTwoPhaseUpstream({
        errorInject: { phase: errorPhase, atIndex, as: errorAs },
      });
      const { proxy, events: diagEvents } = buildProxy(mock);

      const consumer = collectOutput(proxy);

      if (errorPhase === "primary") {
        // Primary-side error: push events up to the error index
        mock.pushPrimary(ev({ type: "start" }));
        mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
        for (let i = 0; i < atIndex; i++) {
          mock.pushPrimary(
            ev({ type: "thinking_delta", contentIndex: 0, delta: "t" }),
          );
        }
        // The mock injects the error at the next iteration (index = atIndex)

        const collected = await consumer;

        // Core invariant: exactly one terminal
        expect(collected.filter(isTerminalEvent)).toHaveLength(1);

        // Exactly one cleanup
        expect(
          diagEvents.filter((c) => c.event === "proxy.lifecycle.cleanup")
            .length,
        ).toBe(1);

        // result() resolves
        const report = countInvariants(collected, diagEvents, proxy, {
          acceptedCount: 0,
        });
        expect(report.resultResolved).toBe(true);
        expect(report.downstreamDrained).toBe(true);

        // FSM ends Idle (error path)
        expect(proxy.controller.getState()).toBe("Idle");

        assertPrivacy(diagEvents, "proxy.");
      } else {
        // Replacement-side error: drive to reasoning, triggerStop
        mock.pushPrimary(ev({ type: "start" }));
        mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
        for (let i = 0; i < Math.max(atIndex, 1); i++) {
          mock.pushPrimary(
            ev({ type: "thinking_delta", contentIndex: 0, delta: "t" }),
          );
        }
        await waitFor(() => proxy.isReasoning());
        const accepted = proxy.triggerStop();
        await waitFor(() => mock.calls.length === 1, 500);

        // Push replacement events up to the error index
        for (let i = 0; i < atIndex; i++) {
          mock.pushReplacement(
            ev({ type: "text_delta", contentIndex: 0, delta: "a" }),
          );
        }

        const collected = await consumer;

        // Core invariant: exactly one terminal
        expect(collected.filter(isTerminalEvent)).toHaveLength(1);

        // Exactly one cleanup
        expect(
          diagEvents.filter((c) => c.event === "proxy.lifecycle.cleanup")
            .length,
        ).toBe(1);

        const report = countInvariants(collected, diagEvents, proxy, {
          acceptedCount: accepted ? 1 : 0,
        });
        expect(report.resultResolved).toBe(true);
        expect(report.downstreamDrained).toBe(true);

        // FSM ends Idle (error path via replacement failure)
        expect(proxy.controller.getState()).toBe("Idle");

        assertPrivacy(diagEvents, "proxy.");
      }
    });
  }
});

// ─── Targeted edge injections ──────────────────────────────────────────

describe("Chaos — targeted edge injections", () => {
  test("primary throws synchronously before yielding any event → single synthesized error terminal + Idle", async () => {
    let callCount = 0;
    const { StreamProxy } = require("../src/provider/proxy");
    const fn = ((_m: unknown, _c: unknown, _opts?: unknown) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("sync-primary-throw");
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield ev({ type: "done", reason: "stop", message: DONE_MESSAGE });
        },
      };
    }) as unknown as Parameters<typeof StreamProxy>[3];

    const mock = {
      fn,
      calls: [],
      pushPrimary: () => {},
      pushReplacement: () => {},
      closePrimary: () => {},
    };
    const { proxy, events } = buildProxy(mock);

    const collected = await collectOutput(proxy);

    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
    expect(collected[0]?.type).toBe("error");

    expect(
      events.filter((c) => c.event === "proxy.lifecycle.cleanup").length,
    ).toBe(1);

    await waitFor(() => proxy.controller.getState() === "Idle", 200);
  });

  test("primary throws mid-reasoning → single error terminal + Idle + one cleanup", async () => {
    const mock = makeScriptedTwoPhaseUpstream({
      errorInject: { phase: "primary", atIndex: 2, as: "throw" },
    });
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: "thinking" }),
    );

    const collected = await consumer;

    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
    expect(
      events.filter((c) => c.event === "proxy.lifecycle.cleanup").length,
    ).toBe(1);
    await waitFor(() => proxy.controller.getState() === "Idle", 200);
  });

  test("replacement throws synchronously (FM-007 shape) → single error terminal", async () => {
    const mock = makeScriptedTwoPhaseUpstream({
      errorInject: { phase: "replacement", atIndex: 0, as: "throw" },
    });
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
    );
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await waitFor(() => mock.calls.length === 1, 500);

    const collected = await consumer;

    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
    expect(
      events.filter((c) => c.event === "proxy.lifecycle.cleanup").length,
    ).toBe(1);
    await waitFor(() => proxy.controller.getState() === "Idle", 200);
  });

  test("replacement yields one event then throws (FM-010 shape) → text + single synthesized error", async () => {
    const mock = makeScriptedTwoPhaseUpstream({
      errorInject: { phase: "replacement", atIndex: 1, as: "throw" },
    });
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(
      ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
    );
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await waitFor(() => mock.calls.length === 1, 500);

    // Push one replacement event (at index 0 — passes the check)
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));

    const collected = await consumer;

    expect(collected.some((e) => e.type === "text_start")).toBe(true);
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
    expect(
      events.filter((c) => c.event === "proxy.lifecycle.cleanup").length,
    ).toBe(1);
    await waitFor(() => proxy.controller.getState() === "Idle", 200);
  });

  test("error EVENT (not throw) injected mid-primary → forwarded as the single terminal", async () => {
    const mock = makeScriptedTwoPhaseUpstream({
      errorInject: { phase: "primary", atIndex: 2, as: "event" },
    });
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    // At index 2 the mock injects an error event

    const collected = await consumer;

    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
    expect(collected.some((e) => e.type === "start")).toBe(true);
    expect(collected.some((e) => e.type === "thinking_start")).toBe(true);

    expect(
      events.filter((c) => c.event === "proxy.lifecycle.cleanup").length,
    ).toBe(1);
    await waitFor(() => proxy.controller.getState() === "Idle", 200);
    assertPrivacy(events, "proxy.");
  });
});
