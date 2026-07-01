/**
 * # ReasoningBuffer — append-only capture of pre-interruption reasoning (PRD §23 / §13.4 / §32 / §41).
 *
 * **Responsibility** (PRD §32): "Capture reasoning emitted before interruption." This class is the
 * **single owner** (PRD §37 Ownership Rules: "No mutable state has multiple owners") of an ordered,
 * append-only collection of reasoning deltas. It is **deliberately opaque** (PRD §13.4): "The extension
 * does not interpret reasoning. It merely preserves it." It performs NO summarization, NO compression,
 * NO prompt engineering, NO semantic analysis (PRD §13.4 Non-responsibilities — all explicitly out of MVP).
 *
 * **Ownership**: one private `entries: ThinkingEntry[]`, a `frozen` gate, and a `totalBytes` counter.
 * Owns NO stream, NO abort controller, NO request. Callers receive an **immutable snapshot** — never a
 * live reference to the internal array.
 *
 * **Lifecycle states** (PRD §41 — Buffer Ownership During Transition — the work-item DOCS requirement):
 *  - **Mutable** (before interruption): `append()` allowed; `frozen === false`. (PRD §41 "Before
 *    interruption → ReasoningBuffer mutable.")
 *  - **Frozen** (after interruption): `append()` throws; `snapshot()` is the authoritative read. Reached
 *    via `freeze()`, called by abort coordination (P1.M5) at the Aborting→Capturing boundary (PRD §17:
 *    "Capturing → Reasoning buffer immutable"; PRD §41 "After interruption → frozen").
 *  - **Read-only** (after replacement): same frozen state once RequestBuilder (P1.M6) has snapshotted
 *    (PRD §41 "After replacement → read-only").
 *  - **Destroyed** (after completion): `reset()` returns to mutable (rebirth) for reuse, or — per PRD §23.3
 *    "Never reused" — the instance is simply discarded (GC'd) and a fresh buffer is allocated per request
 *    (PRD §41 "After completion → destroyed").
 *
 * **Invariants** (PRD §23.2 + §13.4 + Appendix O INV-007):
 *  - Append-only: entries are never edited, reordered, or removed (except wholesale `reset()`).
 *  - Ordered: offsets are `0,1,2,…` (monotonically increasing; PRD §13.4 "Track ordering / Track offsets").
 *  - Immutable after freeze: once frozen, `append()` throws (no further mutation).
 *  - No truncation (PRD §23.5): an append that would exceed `maximumBytes` still appends; only a `warn`
 *    is emitted. Truncation/eviction is an explicit FUTURE feature.
 *  - Memory proportional only to reasoning (PRD §23.4/§45): answer text is never duplicated here; the
 *    proxy already forwards answers.
 *
 * **Failure modes**: `append()` after `freeze()` throws `Error("… (PRD §41)")`. Every other method
 * (`freeze`/`snapshot`/`getByteSize`/`reset`) is total — it never throws. `freeze()` is idempotent.
 *
 * **Privacy** (PRD Appendix H — Logging Rules): the buffer holds raw reasoning text. Its diagnostics calls
 * (`buffer.overflow`, `buffer.frozen`, `buffer.reset`) pass ONLY event counts / byte totals — NEVER the
 * delta/`content`. Logging reasoning text is forbidden.
 *
 * Consumed by: StreamProxy (P1.M4.T2 — owns the per-request instance, appends `thinking_delta` deltas),
 * P1.M5 abort coordination (calls `freeze()`), RequestBuilder (P1.M6 — reads `snapshot()`).
 */
import type { Diagnostics } from "../diagnostics";

/**
 * One captured reasoning delta. The buffer's unit of storage (PRD §13.4 "Track ordering / Track offsets").
 *
 * Fields are `readonly` so a snapshot entry cannot be mutated by a holder; the internal entries are copied
 * (and frozen) on `snapshot()`.
 *
 * - `offset`    The entry's append-order index (`0,1,2,…`); monotonically increasing. (NOT a byte offset.)
 * - `timestamp` Epoch milliseconds via `Date.now()` at append time.
 * - `content`   The raw reasoning `delta` string, stored verbatim. The buffer NEVER interprets it
 *               (PRD §13.4) — no summarization, no transformation.
 *
 * Named `ThinkingEntry` (NOT `ThinkingEvent`) to avoid colliding with the streaming-event union
 * `ThinkingEvent` already exported from `src/types.ts`.
 */
export interface ThinkingEntry {
  /** Append-order index (`0,1,2,…`); equals the array position at push time. Monotonic (PRD §13.4). */
  readonly offset: number;
  /** Epoch ms at append time (`Date.now()`). */
  readonly timestamp: number;
  /** The raw reasoning delta string. Stored verbatim; never interpreted (PRD §13.4). */
  readonly content: string;
}

/**
 * Append-only, ordered, opaque capture of pre-interruption reasoning (PRD §23 / §13.4 / §32 / §41).
 * Single owner of its `entries`; exposes an immutable snapshot to readers (PRD §37).
 */
export class ReasoningBuffer {
  /** The append-only internal collection (PRD §23.2). Single writer = this instance. */
  private readonly entries: ThinkingEntry[] = [];
  /** The mutable→frozen gate (PRD §41). `false` until `freeze()`; cleared by `reset()`. */
  private frozen = false;
  /** Running byte accounting = sum of appended `delta.length` (PRD §13.4/§45). Drives the overflow gate. */
  private totalBytes = 0;

  /**
   * @param diagnostics  Shared structured logger (PRD §36). **Privacy (Appendix H):** only event counts
   *                     and byte totals are ever logged — NEVER the delta/`content`.
   * @param maximumBytes The soft ceiling (from `Config.maximumReasoningBufferBytes`, P1.M1.T2.S1). An
   *                     append whose projected total exceeds it still appends (PRD §23.5 — no truncation)
   *                     but emits one `buffer.overflow` warn.
   * @post `entries` is empty, `frozen === false`, `totalBytes === 0`.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly maximumBytes: number,
  ) {}

  /**
   * Append one reasoning delta to the end of the collection (PRD §13.4 "Accumulate reasoning deltas";
   * §23.2 "Append-only").
   *
   * - Preconditions: the buffer is mutable (`frozen === false`). `delta` is a string.
   * - Postconditions: a new `ThinkingEntry` is pushed with `offset = entries.length` (evaluated before the
   *   push), `timestamp = Date.now()`, `content = delta`; `totalBytes += delta.length`.
   * - Side effects: if the projected `totalBytes` exceeds `maximumBytes`, emits one
   *   `warn("buffer.overflow", {entries, totalBytes, maximumBytes})` — counts ONLY (Appendix H). The delta
   *   is still appended (PRD §23.5 — no truncation).
   * - @throws {Error} `ReasoningBuffer is frozen: cannot append after freeze() (PRD §41)` when `frozen`.
   */
  append(delta: string): void {
    if (this.frozen) {
      throw new Error("ReasoningBuffer is frozen: cannot append after freeze() (PRD §41)");
    }
    this.entries.push({ offset: this.entries.length, timestamp: Date.now(), content: delta });
    this.totalBytes += delta.length;
    if (this.totalBytes > this.maximumBytes) {
      this.diagnostics.warn("buffer.overflow", {
        entries: this.entries.length,
        totalBytes: this.totalBytes,
        maximumBytes: this.maximumBytes,
      });
    }
  }

  /**
   * Transition the buffer from mutable to frozen (PRD §41 "After interruption → frozen"; §17 "Capturing →
   * Reasoning buffer immutable"). After this, `append()` throws and `snapshot()` is the stable read.
   *
   * Idempotent: calling `freeze()` more than once is a safe no-op (does NOT throw). Called by abort
   * coordination (P1.M5) at the Aborting→Capturing boundary.
   *
   * - Preconditions: none (legal in any state; no-op if already frozen).
   * - Postconditions: `frozen === true`.
   * - Side effects: one `debug("buffer.frozen", {entries, totalBytes})` lifecycle milestone (counts only).
   */
  freeze(): void {
    this.frozen = true;
    this.diagnostics.debug("buffer.frozen", { entries: this.entries.length, totalBytes: this.totalBytes });
  }

  /**
   * Return an **immutable copy** of the captured entries (PRD §13.4 "Expose immutable snapshot"; §23.2
   * "Immutable after capture"). The result is a frozen array of frozen entry copies, structurally
   * independent of the live internal array — later `append()`/`reset()` do NOT mutate a snapshot already
   * taken.
   *
   * Legal whether or not the buffer is frozen (a snapshot is always a read-only projection). RequestBuilder
   * (P1.M6) reads this to construct the thinking-disabled replacement request.
   *
   * - Preconditions: none. Never throws.
   * - Postconditions: returns `readonly ThinkingEntry[]` with `Object.isFrozen(result) === true` and each
   *   `Object.isFrozen(result[i]) === true`.
   * - Side effects: none.
   */
  snapshot(): readonly ThinkingEntry[] {
    return Object.freeze(this.entries.map((entry) => Object.freeze({ ...entry }))) as readonly ThinkingEntry[];
  }

  /**
   * @returns the running byte total (sum of appended `delta.length`). Pure read; never throws, never logs.
   *          (PRD §13.4/§45 — linear accounting of captured reasoning size.)
   */
  getByteSize(): number {
    return this.totalBytes;
  }

  /**
   * Clear the collection and return to the mutable state (PRD §13.4 "Reset after completion"; §23.3
   * "Destroyed: completion"; §41 "After completion → destroyed"). Works regardless of the frozen state —
   * this is the path back to mutable.
   *
   * In practice a fresh `ReasoningBuffer` is allocated per request (PRD §23.3 "Never reused"); `reset()`
   * exists for completeness and for any future pooled/reused buffer.
   *
   * - Preconditions: none. Never throws (clears `frozen`).
   * - Postconditions: `entries` is empty, `frozen === false`, `totalBytes === 0`.
   * - Side effects: one `debug("buffer.reset", {})` lifecycle milestone.
   */
  reset(): void {
    this.entries.length = 0;
    this.frozen = false;
    this.totalBytes = 0;
    this.diagnostics.debug("buffer.reset", {});
  }
}
