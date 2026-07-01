/**
 * # TransitionCoordinator — stateless delegator bridging shortcut scope to active proxy (PRD §13.3/§37/§24/§22.5/INV-004/§51).
 *
 * **Responsibility** (PRD §37): hold an optional reference to the **active proxy** and forward three
 * queries (`isReasoning`/`alreadyInterrupting`/`canInterrupt`) + one action (`triggerStop`) to it. The
 * coordinator **owns NO transition state** (PRD §13.3 single-writer; §37 "No mutable state has multiple
 * owners") — it queries the proxy which queries its `TransitionController`. The proxy/controller remain the
 * single writers of all transition state.
 *
 * **Scope**: a session-scoped singleton created by the factory (P1.M5) and shared between the
 * `ShortcutManager` (ExtensionContext scope) and the `ProviderDecorator` (which calls `setActiveProxy`
 * on proxy construct/stream-end). At most one active proxy per logical assistant response (INV-004);
 * the most recent `setActiveProxy` call wins.
 *
 * **Ownership**: one `private activeProxy: ActiveProxy | undefined` (a reference, never a copy of state).
 * Owns NO dedup/idempotency state, NO buffers, NO streams. First-press-wins (§24.3) is enforced by the
 * proxy's FSM: `canInterrupt()` is true only in `Reasoning`; after `triggerStop()` the FSM leaves
 * `Reasoning` so the next `requestStop()` sees `canInterrupt()==false`. No coordinator-local counter
 * or latch is needed.
 *
 * **Never-crash (Appendix K)**: `requestStop()` cannot throw — a `triggerStop` fault is swallowed + logged
 * and `requestStop()` returns `false`. This is defense-in-depth alongside `ShortcutManager`'s handler guard.
 *
 * **Structural assignability**: `TransitionCoordinator` is structurally assignable to
 * `StopRequestCoordinator` (`{ requestStop(): boolean; alreadyInterrupting(): boolean }` from
 * `src/shortcut/index.ts`) — `ShortcutManager` wires it with zero adapter.
 *
 * Consumed by: `ShortcutManager` (P1.M4.T3.S1 — via `StopRequestCoordinator` seam); decorator + factory
 * wiring (P1.M5 — calls `setActiveProxy`).
 */
import type { Diagnostics } from "../diagnostics";

/**
 * The proxy-facing surface the `TransitionCoordinator` delegates to. This is the coordinator's
 * dependency-inversion seam: the coordinator depends on this **structural** interface, NOT the concrete
 * `StreamProxy` (`src/provider/proxy.ts`). The concrete `StreamProxy` becomes structurally assignable
 * once it exposes these four methods:
 * - `isReasoning()` — PRESENT today (P1.M4.T2).
 * - `canInterrupt()` + `isInterrupting()` — pure read delegates (addable any time).
 * - `triggerStop()` — the upstream abort + FSM move (P1.M5.T1).
 *
 * The coordinator never imports the concrete `StreamProxy` — importing it and calling `.triggerStop()`
 * would NOT compile today (`triggerStop` does not exist yet) and would couple a session-scoped singleton
 * to a per-request object's concrete type.
 */
export interface ActiveProxy {
  /** True only while the active stream is mid-reasoning (PRD §22.5). */
  isReasoning(): boolean;
  /** Shortcut availability: interruption is legal RIGHT NOW (state == Reasoning, PRD §22.5). */
  canInterrupt(): boolean;
  /** Kick off the stop transition (upstream abort + Reasoning→StopRequested). P1.M5 owns the body. */
  triggerStop(): boolean;
  /** A transition is already in flight (state past Reasoning; PRD §24.3 / INV-004). */
  isInterrupting(): boolean;
  /** True while the stream has started but reasoning has not begun (PRD §16 `Delegating`).
   *  Used by the coordinator to record an EC-002 pending stop pressed during the network-stall window. */
  isDelegating(): boolean;
}

/**
 * Stateless delegator bridging the shortcut handler's scope to the live proxy's FSM (PRD §13.3/§37).
 * Holds a single optional reference to the active proxy and forwards queries + actions to it.
 * Owns NO transition state; the proxy/controller is the single writer (PRD §13.3/§30/§37).
 *
 * **Structural assignability**: this class satisfies `StopRequestCoordinator` (`requestStop()` +
 * `alreadyInterrupting()`) with zero adapter.
 */
export class TransitionCoordinator {
  /** The single owned field: an optional reference to the active proxy (PRD §37). NEVER a copy of
   *  state — only a reference. `undefined` outside an active eligible stream. */
  private activeProxy: ActiveProxy | undefined = undefined;
  /** EC-002: a stop pressed during `Delegating` (no reasoning yet) is recorded here and honored the
   *  instant reasoning begins (consumed by the proxy's trackEvent). Cleared on proxy change, on consume,
   *  or when the provider answers without reasoning. */
  private pendingStop = false;

  /**
   * @param diagnostics  Shared structured logger (PRD §36). **Privacy (Appendix H):** only event
   *                     names + accept/reject reasons + error categories are ever logged — never
   *                     prompt/reasoning/assistant content (the coordinator never sees any).
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Point the coordinator at the proxy for the stream that is starting, or clear it (`undefined`) when
   * that stream ends. Called by the `ProviderDecorator` wrapper (P1.M5) on proxy construct and on
   * stream drain/terminal. At most one active proxy at a time (INV-004); the most recent call wins.
   */
  setActiveProxy(proxy: ActiveProxy | undefined): void {
    this.activeProxy = proxy;
    this.pendingStop = false;
    this.diagnostics.trace(proxy ? "coordinator.set-active" : "coordinator.clear-active", {});
  }

  /**
   * EC-002: read + clear the pending-stop flag. Called by the proxy when the first reasoning event
   * arrives (Delegating→Reasoning). Returns whether a pending stop was recorded for this response.
   */
  consumePendingStop(): boolean {
    const was = this.pendingStop;
    this.pendingStop = false;
    return was;
  }

  /** Discard the pending stop because the provider answered WITHOUT reasoning. Called by
   *  the proxy when the first event is text while still in Delegating. No-op when nothing was recorded. */
  clearPendingStop(): void {
    this.pendingStop = false;
  }

  /**
   * Whether the active stream is mid-reasoning (PRD §22.5). Pure delegate; `false` when no proxy.
   */
  isReasoning(): boolean {
    return this.activeProxy?.isReasoning() ?? false;
  }

  /**
   * Whether a transition is already in flight (PRD §24.3 / INV-004) — used by `ShortcutManager` to
   * discard repeats (EC-009/EC-010). Pure delegate; `false` when no proxy.
   */
  alreadyInterrupting(): boolean {
    return this.activeProxy?.isInterrupting() ?? false;
  }

  /**
   * Raise the stop REQUEST (PRD §24.2 — a request, not a command). The coordinator is NOT the
   * authority: it asks the active proxy.
   *   1. No active proxy → `false` (EC-001: shortcut before first provider event / after stream end).
   *   2. `!activeProxy.canInterrupt()` → `false` (PRD §22.5: not in Reasoning; FM-001).
   *      `triggerStop` is NOT called — the request is simply inadmissible right now.
   *   3. Otherwise → call `activeProxy.triggerStop()` and return `true`. The proxy's FSM then moves
   *      Reasoning→StopRequested so a second `requestStop()` sees `canInterrupt()==false` (§24.3
   *      first-press-wins; INV-004) — the coordinator holds NO dedup state of its own.
   *
   * NEVER throws: a `triggerStop` fault is swallowed + logged and `requestStop()` returns `false`
   * (never-crash; PRD Appendix K). This is defense-in-depth alongside `ShortcutManager`'s handler guard.
   *
   * @returns whether the request was accepted (a transition was started).
   */
  requestStop(): boolean {
    const proxy = this.activeProxy;
    if (!proxy) {
      this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "no-active-proxy" });
      return false; // EC-001
    }
    if (!proxy.canInterrupt()) {
      // Contract (a): return false (covers FM-001/002/003, EC-001/005/006).
      // Contract (b) / EC-002: if pressed during the Delegating window, RECORD a pending stop so it can be
      // honored the instant reasoning begins. Idle (EC-001, pre-start) and terminal states do NOT record.
      if (proxy.isDelegating()) {
        this.pendingStop = true;
        this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "pending-stop-recorded" });
      } else {
        this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "not-reasoning" });
      }
      return false;
    }
    try {
      proxy.triggerStop();
    } catch (err) {
      this.diagnostics.error("coordinator.request-stop-error", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "proxy-fault" });
      return false; // never-crash
    }
    this.diagnostics.trace("coordinator.request-stop", { accepted: true });
    return true;
  }
}
