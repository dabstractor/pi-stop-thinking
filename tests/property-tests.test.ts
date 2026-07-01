/**
 * # Property Tests — randomized invariant coverage (INV-001/002/003/004/005/010).
 *
 * Generates random event sequences with random interruption points via a seeded PRNG.
 * Each seed is a discrete `test()` — fully reproducible from its printed seed.
 * ≥50 per-seed interrupted cases + ≥15 no-interruption cases + ≥5 dedicated invariant tests.
 */

import { describe, test, expect } from "bun:test";
import { isTerminalEvent } from "../src/types";
import {
  mulberry32,
  ri,
  makeScriptedTwoPhaseUpstream,
  buildProxy,
  collectOutput,
  countInvariants,
  assertInvariants,
  assertPrivacy,
  ev,
  waitFor,
  DONE_MESSAGE,
  ERROR_MESSAGE,
} from "./helpers/invariant-harness";

// ─── Randomized interrupted cases (50 seeds) ────────────────────────────

describe("Property Tests — randomized invariants (INV-001/002/003/004/005/010)", () => {
  describe("interrupted sequences (seed 0–49)", () => {
    for (let seed = 0; seed < 50; seed++) {
      test(`seed=${seed} interrupted holds the streaming invariants`, async () => {
        const rng = mulberry32(seed);
        const thinkingN = ri(rng, 1, 8);
        const replN = ri(rng, 1, 5);

        const mock = makeScriptedTwoPhaseUpstream();
        const { proxy, events } = buildProxy(mock);

        // Start draining concurrently (fire-and-forget start)
        const consumer = collectOutput(proxy);

        // Drive primary to Reasoning
        mock.pushPrimary(ev({ type: "start" }));
        mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
        for (let i = 0; i < thinkingN; i++) {
          mock.pushPrimary(
            ev({ type: "thinking_delta", contentIndex: 0, delta: "t" }),
          );
        }
        await waitFor(() => proxy.isReasoning());

        // Dispatch the interruption (≤1 true per response — INV-004)
        const accepted = proxy.triggerStop();
        await waitFor(() => mock.calls.length === 1, 500);

        // Queue replacement events + terminal
        mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
        for (let i = 0; i < replN; i++) {
          mock.pushReplacement(
            ev({ type: "text_delta", contentIndex: 0, delta: "a" }),
          );
        }
        mock.pushReplacement(
          ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
        );

        const collected = await consumer;
        const report = countInvariants(collected, events, proxy, {
          acceptedCount: accepted ? 1 : 0,
        });
        assertInvariants(report, { allowInterruption: true });

        // Privacy guard (Appendix H)
        assertPrivacy(events, "proxy.");
      });
    }
  });

  // ─── Randomized no-interruption cases (15 seeds) ────────────────────

  describe("no-interruption sequences (seed 0–14)", () => {
    for (let seed = 0; seed < 15; seed++) {
      test(`seed=${seed} no-interruption holds the streaming invariants`, async () => {
        const rng = mulberry32(seed + 100);
        const textN = ri(rng, 1, 5);

        const mock = makeScriptedTwoPhaseUpstream();
        const { proxy, events } = buildProxy(mock);

        const consumer = collectOutput(proxy);

        // Drive primary to completion (no interruption)
        mock.pushPrimary(ev({ type: "start" }));
        mock.pushPrimary(ev({ type: "text_start", contentIndex: 0 }));
        for (let i = 0; i < textN; i++) {
          mock.pushPrimary(
            ev({ type: "text_delta", contentIndex: 0, delta: "x" }),
          );
        }
        mock.pushPrimary(
          ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
        );
        mock.closePrimary();

        const collected = await consumer;
        const report = countInvariants(collected, events, proxy, {
          acceptedCount: 0,
        });
        // No-interruption: FSM may stay in Reasoning/Delegating (§16 has no normal exit),
        // so don't assert Idle. All other invariants hold.
        assertInvariants(report, { allowInterruption: false, requireIdle: false });

        // No-interruption: authority stays forwarding
        expect(report.finalAuthority).toBe("forwarding");
      });
    }
  });
});

// ─── Dedicated invariant tests ──────────────────────────────────────────

describe("Property Tests — dedicated invariant spot-checks", () => {
  test("INV-004: a second triggerStop() during the transition returns false (no double-abort)", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    // Drive to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    // First triggerStop → true (INV-004: exactly one accepted)
    expect(proxy.triggerStop()).toBe(true);
    // Second triggerStop → false (already past Reasoning)
    expect(proxy.triggerStop()).toBe(false);
    // Third also false
    expect(proxy.triggerStop()).toBe(false);

    // Complete the replacement so collectOutput doesn't hang
    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    const collected = await consumer;

    // Exactly one terminal despite double triggerStop attempt
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("INV-005: authority, once 'splicing', never reverts to 'forwarding'", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    // Drive to Reasoning
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());

    // Before interruption: forwarding
    expect(proxy.authority).toBe("forwarding");

    proxy.triggerStop();
    await waitFor(() => mock.calls.length === 1, 500);

    // Still forwarding until first replacement event
    expect(proxy.authority).toBe("forwarding");

    // Push first replacement event → authority flips to splicing (irreversible)
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "answer" }));
    await waitFor(() => proxy.authority === "splicing", 500);

    // Sample authority at multiple points — always splicing
    expect(proxy.authority).toBe("splicing");
    expect(proxy.authority).toBe("splicing");
    expect(proxy.authority).toBe("splicing");

    // Complete replacement
    mock.pushReplacement(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    const collected = await consumer;

    // Final authority still splicing
    expect(proxy.authority).toBe("splicing");

    // Single terminal
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("INV-010: cleanup runs exactly once even when the replacement fails (error terminal)", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy, events } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    // Drive to Reasoning → interrupt
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    // Replacement yields an error terminal (simulating provider failure)
    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushReplacement(
      ev({ type: "error", reason: "error", error: ERROR_MESSAGE }),
    );

    const collected = await consumer;

    // Exactly one cleanup trace
    const cleanupCount = events.filter(
      (c) => c.event === "proxy.lifecycle.cleanup",
    ).length;
    expect(cleanupCount).toBe(1);

    // Single terminal
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("no-interruption seed: downstream preserves all event types in order", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    // Push a specific sequence
    const inputTypes = ["start", "text_start", "text_delta", "text_delta", "done"];
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "text_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 0, delta: "A" }));
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 0, delta: "B" }));
    mock.pushPrimary(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    mock.closePrimary();

    const collected = await consumer;
    const outputTypes = collected.map((e) => e.type);
    expect(outputTypes).toEqual(inputTypes);

    // Invariants hold on inactive path
    expect(collected.filter((e) => e.type === "start")).toHaveLength(1);
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("INV-004: triggerStop returns false before reasoning state", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy } = buildProxy(mock);

    // Before any events — state is Idle
    expect(proxy.triggerStop()).toBe(false);

    const consumer = collectOutput(proxy);

    // Push start (state moves to Delegating)
    mock.pushPrimary(ev({ type: "start" }));
    await waitFor(() => proxy.controller.getState() === "Delegating", 200);
    // Still not reasoning
    expect(proxy.triggerStop()).toBe(false);

    // Push text (no reasoning → stays Delegating for text)
    mock.pushPrimary(ev({ type: "text_delta", contentIndex: 0, delta: "x" }));
    // Push done
    mock.pushPrimary(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );
    mock.closePrimary();

    const collected = await consumer;
    expect(collected.filter(isTerminalEvent)).toHaveLength(1);
  });

  test("INV-004: at most one proxy.replacement.first-event trace across the full run", async () => {
    const mock = makeScriptedTwoPhaseUpstream();
    const { proxy, events: diagEvents } = buildProxy(mock);

    const consumer = collectOutput(proxy);

    // Drive to reasoning → interrupt
    mock.pushPrimary(ev({ type: "start" }));
    mock.pushPrimary(ev({ type: "thinking_start", contentIndex: 0 }));
    mock.pushPrimary(ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
    await waitFor(() => proxy.isReasoning());
    proxy.triggerStop();

    await waitFor(() => mock.calls.length === 1, 500);
    mock.pushReplacement(ev({ type: "text_delta", contentIndex: 0, delta: "a" }));
    mock.pushReplacement(
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    );

    await consumer;

    // Exactly zero or one first-event trace
    const firstEventCount = diagEvents.filter(
      (c) => c.event === "proxy.replacement.first-event",
    ).length;
    expect(firstEventCount).toBeLessThanOrEqual(1);
  });
});
