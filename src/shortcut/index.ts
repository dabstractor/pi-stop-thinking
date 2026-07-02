import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Diagnostics } from "../diagnostics";
import type { Telemetry } from "../telemetry";

/** The key-identifier type accepted by {@link ExtensionAPI.registerShortcut}. Extracted so we can
 *  pass a `string` shortcut (from `config.shortcut`) without importing `KeyId` from pi-tui.
 *  pi-tui is a nested dependency of pi-coding-agent, not a direct project dependency. */
type ShortcutParam = NonNullable<Parameters<ExtensionAPI['registerShortcut']>[0]>;

/**
 * The stop-request surface {@link ShortcutManager} depends on (PRD §13.5 / §24). This is a
 * dependency-inversion seam: it lets ShortcutManager compile BEFORE P1.M4.T4's concrete
 * `TransitionCoordinator` exists. P1.M4.T4's `TransitionCoordinator` declares `requestStop()` and
 * `alreadyInterrupting()` (see plan/.../architecture/module_contracts.md → "TransitionCoordinator"), so it
 * is STRUCTURALLY ASSIGNABLE to this interface — no adapter needed.
 */
export interface StopRequestCoordinator {
  /** Raise the stop request (PRD §24.2 — a request, not a command). Returns whether it was accepted: `false`
   *  when the FSM is not in `Reasoning` (FM-001) or a transition is already in flight (PRD §24.3). */
  requestStop(): boolean;
  /** Whether a transition is already in progress (PRD §24.3 + EC-010). The handler discards repeats while
   *  this is `true`. */
  alreadyInterrupting(): boolean;
}

/**
 * # ShortcutManager — the user-interaction layer (PRD §33 / §13.5).
 *
 * **Responsibility** (PRD §33): "Own keyboard interaction." **Responsibilities**: Register shortcut /
 * Enable shortcut / Disable shortcut / Forward stop request. **Invariants** (PRD §33): "Shortcut active only
 * during reasoning / disabled after transition begins / idempotent." NOTE: the enable/disable/idempotent
 * invariants are enforced by the {@link StopRequestCoordinator} gate (`requestStop()` no-ops outside
 * `Reasoning`; `alreadyInterrupting()` discards during a transition) — NOT by ShortcutManager toggling its
 * registration or holding dedup state. PRD §13.5: the layer does ONLY register / determine-valid / signal —
 * "Nothing more."
 *
 * **Configurability**: the shortcut is user-configurable via `config.shortcut` (default `"ctrl+q"` — see
 * `src/config` `DEFAULT_CONFIG.shortcut`, PRD §47 / Appendix K). The factory (P1.M4.T4) reads the validated
 * config and passes `config.shortcut` into {@link register}; ShortcutManager itself does not import config.
 *
 * **Idempotency (PRD §24.3 — "first press wins")**: ShortcutManager holds NO local dedup state. The
 * coordinator is the authority: {@link StopRequestCoordinator.alreadyInterrupting} discards auto-repeat /
 * duplicate presses once a transition is in flight (EC-009 Duplicate Shortcut; EC-010 Shortcut Held Down),
 * and {@link StopRequestCoordinator.requestStop} no-ops (returns `false`) outside `Reasoning` (FM-001). This
 * matches the work item's "No local state needed — the coordinator is the authority."
 *
 * **Lifecycle**: register ONCE at extension init (the factory, P1.M4.T4). The shortcut stays bound for the
 * session; its effect is gated by the coordinator. {@link unregister} is a documented no-op (pi's
 * `registerShortcut` returns void and the SDK exposes no deregistration API — the binding is session-scoped).
 *
 * **Failure modes**: the per-press handler is wrapped in try/catch that traces `shortcut.handler-error` and
 * swallows — a coordinator fault can never propagate into Pi's keybinding dispatch (extension never-crash
 * rule, PRD Appendix E/K).
 *
 * Consumed by: the factory (P1.M4.T4) constructs it and calls `register(pi, config.shortcut, coordinator)`.
 */
export class ShortcutManager {
  /**
   * @param diagnostics  Shared structured logger (PRD §36). Privacy (Appendix H): only shortcut lifecycle
   *                     events + the requestStop() boolean result are logged — never content (there is none).
   * @param _telemetry   Optional telemetry recorder (PRD §35). When provided, counts `IgnoredShortcutPresses`
   *                     on both ignored-press paths. Omitting → undefined (safe no-op, backward-compatible).
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly _telemetry?: Telemetry,
  ) {}

  /**
   * Register the stop shortcut with Pi (PRD §33 / §13.5 / §24.1).
   *
   * @param pi           Pi extension API (`registerShortcut`).
   * @param shortcut     The configured shortcut string (e.g. `"ctrl+q"`; configurable via `config.shortcut`,
   *                     default `"ctrl+q"`). Passed straight to `pi.registerShortcut`.
   * @param coordinator  The stop-request authority (P1.M4.T4 `TransitionCoordinator` satisfies
   *                     {@link StopRequestCoordinator}).
   */
  register(pi: ExtensionAPI, shortcut: string, coordinator: StopRequestCoordinator): void {
    pi.registerShortcut(shortcut as ShortcutParam, {
      description: "Stop Thinking & Do",
      handler: () => this.handlePress(coordinator),
    });
    this.diagnostics.trace("shortcut.registered", { shortcut });
  }

  /**
   * Per-press handler (PRD §13.5 "Signal interruption — Nothing more"). Stateless; the coordinator is the
   * authority. Wrapped in try/catch so a coordinator fault never reaches Pi's keybinding dispatch.
   */
  private handlePress(coordinator: StopRequestCoordinator): void {
    try {
      // EC-010 (key held / OS auto-repeat) + PRD §24.3: discard once a transition is in flight.
      if (coordinator.alreadyInterrupting()) {
        this._telemetry?.incrementCounter("IgnoredShortcutPresses");
        this.diagnostics.trace("shortcut.ignored", { reason: "already-interrupting" });
        return;
      }
      // Raise the REQUEST (PRD §24.2). The coordinator → controller is idempotent: returns false and changes
      // nothing outside Reasoning (FM-001). ShortcutManager holds no dedup state of its own.
      const accepted = coordinator.requestStop();
      if (!accepted) {
        this._telemetry?.incrementCounter("IgnoredShortcutPresses");
      }
      this.diagnostics.trace("shortcut.forwarded", { accepted });
    } catch (err) {
      // Never crash the host (PRD Appendix E/K).
      this.diagnostics.error("shortcut.handler-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Lifecycle counterpart to {@link register} (PRD §33 "Disable shortcut"). NOTE: Pi's `registerShortcut`
   * returns `void` and the SDK exposes NO deregistration API, so the binding cannot be removed here — it is
   * session-scoped (Pi tears it down with the extension). The shortcut's dynamic *disable* during/after a
   * transition is enforced by the coordinator gate, not by (un)registering. This method is a documented
   * no-op kept for interface completeness / forward compatibility; it does not throw.
   */
  unregister(): void {
    this.diagnostics.trace("shortcut.unregister", { note: "no-pi-deregister-api" });
  }
}
