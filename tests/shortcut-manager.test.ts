import { describe, test, expect, mock } from "bun:test";
import { ShortcutManager, type StopRequestCoordinator } from "../src/shortcut";
import { Telemetry } from "../src/telemetry";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Diagnostics } from "../src/diagnostics";

type Level = "trace" | "debug" | "info" | "warn" | "error";

interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub (adapted from tests/reasoning-buffer.test.ts). */
function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info: (e, f) => events.push({ level: "info", event: e, fields: f }),
    warn: (e, f) => events.push({ level: "warn", event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}

interface CapturedRegistration {
  shortcut: string;
  description?: string;
  handler: (ctx: unknown) => unknown;
}

/** Fake ExtensionAPI that captures registerShortcut (adapted from tests/factory.test.ts makeFakePi). */
function makeFakePi() {
  let captured: CapturedRegistration | undefined;
  const registerShortcut = mock((shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) => {
    captured = { shortcut, description: options.description, handler: options.handler };
  });
  const pi = { registerShortcut } as unknown as ExtensionAPI;
  return { pi, registerShortcut, captured: () => captured };
}

/** Stateful fake coordinator: first requestStop flips to interrupting → models EC-009/EC-010. */
function makeStatefulFakeCoordinator(): { coordinator: StopRequestCoordinator; getCalls: () => number } {
  let interrupting = false;
  let calls = 0;
  const coordinator: StopRequestCoordinator = {
    alreadyInterrupting: () => interrupting,
    requestStop: () => {
      calls++;
      interrupting = true; // first press wins
      return true;
    },
  };
  return { coordinator, getCalls: () => calls };
}

/** Rejecting fake coordinator: never interrupting, requestStop always false (model not reasoning — FM-001). */
function makeRejectingFakeCoordinator(): StopRequestCoordinator {
  return {
    alreadyInterrupting: () => false,
    requestStop: () => false,
  };
}

describe("ShortcutManager — register contract", () => {
  test("register calls pi.registerShortcut once with the shortcut + 'Stop Thinking & Do' + a handler", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const manager = new ShortcutManager(diag);
    const { coordinator } = makeStatefulFakeCoordinator();

    manager.register(pi.pi, "ctrl+.", coordinator);

    expect(pi.registerShortcut).toHaveBeenCalledTimes(1);
    const reg = pi.captured();
    expect(reg?.shortcut).toBe("ctrl+.");
    expect(reg?.description).toBe("Stop Thinking & Do");
    expect(typeof reg?.handler).toBe("function");
    expect(events.some((e) => e.event === "shortcut.registered" && e.fields?.shortcut === "ctrl+.")).toBe(true);
  });

  test("a custom shortcut flows through unchanged", () => {
    const { diag } = makeCaptureDiag();
    const pi = makeFakePi();
    new ShortcutManager(diag).register(pi.pi, "ctrl+k", makeStatefulFakeCoordinator().coordinator);
    expect(pi.captured()?.shortcut).toBe("ctrl+k");
  });
});

describe("ShortcutManager — forwarding & idempotency (PRD §24.3, EC-009, EC-010)", () => {
  test("a single press forwards exactly one requestStop", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const fake = makeStatefulFakeCoordinator();
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", fake.coordinator);

    pi.captured()!.handler(undefined);

    expect(fake.getCalls()).toBe(1);
    expect(events.some((e) => e.event === "shortcut.forwarded" && e.fields?.accepted === true)).toBe(true);
  });

  test("EC-009/EC-010: rapid/held presses → requestStop called EXACTLY once (first press wins)", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const fake = makeStatefulFakeCoordinator();
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", fake.coordinator);
    const handler = pi.captured()!.handler;

    handler(undefined); // first: accepted, flips to interrupting
    handler(undefined); // EC-010 discard
    handler(undefined); // EC-010 discard

    expect(fake.getCalls()).toBe(1); // exactly one requestStop
    const ignored = events.filter((e) => e.event === "shortcut.ignored");
    expect(ignored.length).toBe(2);
    expect(ignored.every((e) => e.fields?.reason === "already-interrupting")).toBe(true);
  });

  test("FM-001: the handler does NOT pre-gate on reasoning — it forwards; the coordinator rejects", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const rejecting = makeRejectingFakeCoordinator();
    const spy = mock(rejecting.requestStop); // ensure it IS called
    const coordinator: StopRequestCoordinator = { alreadyInterrupting: rejecting.alreadyInterrupting, requestStop: spy };
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", coordinator);

    expect(() => pi.captured()!.handler(undefined)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1); // forwarded (handler does not second-guess reasoning)
    expect(events.some((e) => e.event === "shortcut.forwarded" && e.fields?.accepted === false)).toBe(true);
  });

  test("never-throws: a coordinator fault is swallowed + logged (PRD Appendix E/K)", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const coordinator: StopRequestCoordinator = {
      alreadyInterrupting: () => false,
      requestStop: () => {
        throw new Error("coordinator boom");
      },
    };
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", coordinator);

    expect(() => pi.captured()!.handler(undefined)).not.toThrow();
    expect(events.some((e) => e.event === "shortcut.handler-error")).toBe(true);
  });
});

describe("ShortcutManager — telemetry IgnoredShortcutPresses wiring (P1.M8.T1.S1)", () => {
  test("IgnoredShortcutPresses increments on alreadyInterrupting path (EC-009/EC-010)", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const telemetry = new Telemetry(true, diag);
    const manager = new ShortcutManager(diag, telemetry);
    const fake = makeStatefulFakeCoordinator();
    manager.register(pi.pi, "ctrl+.", fake.coordinator);
    const handler = pi.captured()!.handler;

    handler(undefined); // first: accepted
    handler(undefined); // EC-010 discard
    handler(undefined); // EC-010 discard

    expect(telemetry.getCounter("IgnoredShortcutPresses")).toBe(2);
    // Existing traces must still be emitted
    const ignored = events.filter((e) => e.event === "shortcut.ignored");
    expect(ignored.length).toBe(2);
  });

  test("IgnoredShortcutPresses increments on !accepted path (FM-001)", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const telemetry = new Telemetry(true, diag);
    const manager = new ShortcutManager(diag, telemetry);
    manager.register(pi.pi, "ctrl+.", makeRejectingFakeCoordinator());
    const handler = pi.captured()!.handler;

    handler(undefined);

    expect(telemetry.getCounter("IgnoredShortcutPresses")).toBe(1);
    // Existing trace still emitted
    expect(events.some((e) => e.event === "shortcut.forwarded" && e.fields?.accepted === false)).toBe(true);
  });

  test("accepted press does NOT increment IgnoredShortcutPresses", () => {
    const { diag } = makeCaptureDiag();
    const pi = makeFakePi();
    const telemetry = new Telemetry(true, diag);
    const manager = new ShortcutManager(diag, telemetry);
    manager.register(pi.pi, "ctrl+.", makeStatefulFakeCoordinator().coordinator);
    pi.captured()!.handler(undefined); // single accepted press

    expect(telemetry.getCounter("IgnoredShortcutPresses")).toBeUndefined();
  });

  test("backward compat: ShortcutManager without telemetry arg is a safe no-op", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const manager = new ShortcutManager(diag);
    const fake = makeStatefulFakeCoordinator();
    manager.register(pi.pi, "ctrl+.", fake.coordinator);
    const handler = pi.captured()!.handler;

    handler(undefined); // accepted
    handler(undefined); // EC-010 discard

    // Existing traces must still hold
    expect(events.some((e) => e.event === "shortcut.forwarded" && e.fields?.accepted === true)).toBe(true);
    expect(events.some((e) => e.event === "shortcut.ignored" && e.fields?.reason === "already-interrupting")).toBe(true);
  });
});

describe("ShortcutManager — unregister", () => {
  test("unregister is a safe no-op (pi has no deregistration API)", () => {
    const { diag, events } = makeCaptureDiag();
    const manager = new ShortcutManager(diag);
    expect(() => manager.unregister()).not.toThrow();
    expect(events.some((e) => e.event === "shortcut.unregister")).toBe(true);
  });
});
