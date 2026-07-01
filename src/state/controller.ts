/**
 * # TransitionController — explicit FSM owning the interruption lifecycle (PRD §15/§16/§17/§30).
 *
 * **Responsibility** (PRD §30): "Own interruption lifecycle. No other module may mutate transition
 * state." This class is the **single writer** (PRD §37 Ownership Rules: "TransitionController owns
 * transition state") of one private `state` field, initialized `"Idle"`. It encodes the PRD §16 State
 * Transition Table as `ALLOWED_TRANSITIONS` and REJECTS every transition absent from that table by
 * throwing an Error that cites PRD §16.
 *
 * **Scope (this subtask = pure FSM)**: the class performs NO abort, NO replacement-request, NO stream
 * splicing. The convenience methods (`beginAbort`/`completeAbort`/`beginReplacement`/`beginSplice`/
 * `beginAnswering`/`complete`/`fail`/`reset`) ONLY validate + change state + log. The actual abort
 * controller + transition token are owned by P1.M5 (abort coordination); replacement invocation by
 * P1.M6; splicing by P1.M7. Those later modules call these named methods; this class guarantees their
 * sequencing is legal.
 *
 * **Ownership**: one `private state: TransitionState` (the single owned mutable field). Owns NO abort
 * controller, NO buffer, NO stream in this subtask.
 *
 * **Lifecycle**: one instance per logical assistant response, constructed by StreamProxy (P1.M4) with
 * the shared {@link Diagnostics}. Walks `Idle → Delegating → Reasoning → StopRequested → Aborting →
 * Capturing → Restarting → Splicing → Answering → Completed → Idle`; any state may go `→ Failed`
 * (PRD §16 "Any → Fatal error → Failed"); `Failed → Idle` on reset.
 *
 * **Invariants** (PRD §30 + Appendix O INV-004):
 *  - Single active transition — exactly one `state` field, mutated only inside `transition()`/`fail()`.
 *  - No transition outside PRD §16 is ever accepted (every other pair throws).
 *  - At most one interruption transition per response — `requestStop()` returns `false` once the state
 *    has left `Reasoning`, so the stop flow cannot be re-entered (INV-004).
 *
 * **Failure modes**: an illegal transition attempt logs `warn("transition.illegal", {from,to})` then
 * throws `Error("Illegal state transition: <from> → <to> (PRD §16)")`. `fail(reason)` (Any→Failed) never
 * throws; it logs `error("transition.failed", {reason, from})`.
 *
 * Consumed by: StreamProxy (P1.M4 reasoning detection — drives Delegating/Reasoning/requestStop + the
 * abort/splice chain), TransitionCoordinator (P1.M4.T4 — calls canInterrupt/requestStop), abort
 * coordination (P1.M5), replacement generation (P1.M6), stream splicing (P1.M7).
 */
import type { TransitionState } from "../types";
import type { Diagnostics } from "../diagnostics";

/**
 * The PRD §16 State Transition Table encoded as an immutable adjacency map. Each key is a current
 * state; its value is the set of states reachable from it. "Any → Fatal error → Failed" (PRD §16) is
 * encoded by including `"Failed"` in every state's set EXCEPT `"Failed"`'s own (whose only exit is
 * `"Idle"` per "Failed | Cleanup | Idle").
 *
 * This is the single source of truth for transition legality; {@link TransitionController.transition}
 * reads it for every validation.
 *
 * - Preconditions: none (module-load constant).
 * - Postconditions: 11 entries (one per state); immutable surface (ReadonlyMap of ReadonlySet).
 * - Side effects: none.
 */
export const ALLOWED_TRANSITIONS: ReadonlyMap<TransitionState, ReadonlySet<TransitionState>> = new Map([
  ["Idle", new Set<TransitionState>(["Delegating", "Failed"])],
  ["Delegating", new Set<TransitionState>(["Reasoning", "Failed"])],
  ["Reasoning", new Set<TransitionState>(["StopRequested", "Failed"])],
  ["StopRequested", new Set<TransitionState>(["Aborting", "Failed"])],
  ["Aborting", new Set<TransitionState>(["Capturing", "Failed"])],
  ["Capturing", new Set<TransitionState>(["Restarting", "Failed"])],
  ["Restarting", new Set<TransitionState>(["Splicing", "Failed"])],
  ["Splicing", new Set<TransitionState>(["Answering", "Failed"])],
  ["Answering", new Set<TransitionState>(["Completed", "Failed"])],
  ["Completed", new Set<TransitionState>(["Idle", "Failed"])],
  ["Failed", new Set<TransitionState>(["Idle"])],
]);

/**
 * The single writer of interruption-lifecycle state (PRD §30/§37). Holds one `state` field initialized
 * `"Idle"` and rejects every transition not in {@link ALLOWED_TRANSITIONS} (PRD §16) by throwing.
 *
 * **Pure FSM**: the convenience methods only change state (+ log); they perform no abort/replacement/
 * splicing side effects (those are P1.M5/P1.M6/P1.M7).
 */
export class TransitionController {
  /** The single owned mutable field (PRD §37 single-writer). Initialized `"Idle"` (PRD §16). */
  private state: TransitionState = "Idle";

  /**
   * @param diagnostics  Shared structured logger (PRD §36). **Privacy (Appendix H):** only state
   *                     transitions (`{from, to}`) and error categories (`fail` reason) are ever logged —
   *                     the controller never sees prompt/reasoning/assistant content.
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Transition to `next` iff it is legal from the current state per PRD §16; otherwise log a
   * `transition.illegal` warning and throw an Error citing PRD §16. On success set the state and emit
   * `trace("transition.state-change", {from, to})`.
   *
   * This is the table-driven validator and the contract's escape hatch for the two entry transitions
   * (`Idle → Delegating` on stream begin; `Delegating → Reasoning` on the first thinking event) that
   * have no dedicated convenience method (PRD §16).
   *
   * - Preconditions: `next` is a {@link TransitionState}.
   * - Postconditions: on success `this.state === next`; on failure `this.state` is UNCHANGED.
   * - Side effects: `trace` on success; `warn` then throw on failure.
   * - @throws {Error} `Illegal state transition: <from> → <next> (PRD §16)` when `next` is not reachable.
   */
  transition(next: TransitionState): void {
    const allowed = ALLOWED_TRANSITIONS.get(this.state);
    if (!allowed || !allowed.has(next)) {
      this.diagnostics.warn("transition.illegal", { from: this.state, to: next });
      throw new Error(`Illegal state transition: ${this.state} → ${next} (PRD §16)`);
    }
    const from = this.state;
    this.state = next;
    this.diagnostics.trace("transition.state-change", { from, to: next });
  }

  /**
   * @returns the current state. Pure read; never throws, never logs.
   */
  getState(): TransitionState {
    return this.state;
  }

  /**
   * Whether the shortcut may interrupt right now: `true` ONLY in `Reasoning` (PRD §22.5 Shortcut
   * Availability). Pure read; never throws, never logs.
   */
  canInterrupt(): boolean {
    return this.state === "Reasoning";
  }

  /**
   * Request the stop transition (PRD §16: `Reasoning | Shortcut | StopRequested`).
   *
   * @returns `true` and transitions to `StopRequested` when the current state is `Reasoning`; `false`
   *          otherwise (no throw, no state change, no log). This is the ONLY boolean-returning method —
   *          graceful rejection (FM-001/FM-002/FM-003: shortcut ignored outside Reasoning).
   * - Side effects (success only): one `transition.state-change` trace (via {@link transition}).
   */
  requestStop(): boolean {
    if (this.state !== "Reasoning") return false;
    this.transition("StopRequested"); // table-legal from Reasoning → cannot throw
    return true;
  }

  /** Dispatch the abort (PRD §16: `StopRequested | Abort dispatched | Aborting`). Throws if not in
   *  `StopRequested`. Only changes state — the actual upstream abort is P1.M5.T1.S1. */
  beginAbort(): void {
    this.transition("Aborting");
  }

  /** Upstream closed; reasoning frozen (PRD §16: `Aborting | Upstream closed | Capturing`). Throws if
   *  not in `Aborting`. Only changes state. */
  completeAbort(): void {
    this.transition("Capturing");
  }

  /** Issue the replacement request (PRD §16: `Capturing | Replacement issued | Restarting`). Throws if
   *  not in `Capturing` (PRD §51: "No replacement request may begin before reasoning is frozen").
   *  Only changes state. */
  beginReplacement(): void {
    this.transition("Restarting");
  }

  /** First replacement token received (PRD §16: `Restarting | First replacement token | Splicing`).
   *  Throws if not in `Restarting`. Only changes state. */
  beginSplice(): void {
    this.transition("Splicing");
  }

  /** First answer token received (PRD §16: `Splicing | First answer token | Answering`). Throws if not
   *  in `Splicing`. Only changes state. */
  beginAnswering(): void {
    this.transition("Answering");
  }

  /** Replacement stream reached `message_end` (PRD §16: `Answering | message_end | Completed`). Throws
   *  if not in `Answering`. Only changes state. */
  complete(): void {
    this.transition("Completed");
  }

  /**
   * Fatal error → `Failed` (PRD §16: `Any | Fatal error → Failed`). ALWAYS succeeds ("Any → Failed");
   * never throws. Logs `trace("transition.state-change", {from, to:"Failed"})` then
   * `error("transition.failed", {reason, from})`.
   *
   * @param reason  An error CATEGORY (e.g. "timeout", "abort-failed", "replacement-rejected") — never
   *                user/prompt/reasoning content (PRD Appendix H: only error categories are loggable;
   *                the controller never sees user content anyway).
   * - Side effects: one `transition.state-change` trace + one `transition.failed` error.
   */
  fail(reason: string): void {
    const from = this.state;
    this.state = "Failed"; // Any→Failed is always table-legal (present in every non-Failed set)
    this.diagnostics.trace("transition.state-change", { from, to: "Failed" });
    this.diagnostics.error("transition.failed", { reason, from });
  }

  /**
   * Cleanup → `Idle` (PRD §16: `Completed | Cleanup | Idle` and `Failed | Cleanup | Idle`). Legal ONLY
   * from `Completed` or `Failed`; throws from any other state (Idle is reachable from no other state per
   * §16). In practice always called post-Completed/post-Failed.
   * - Side effects (success): one `transition.state-change` trace.
   * - @throws {Error} when the current state is not `Completed` or `Failed`.
   */
  reset(): void {
    this.transition("Idle");
  }
}
