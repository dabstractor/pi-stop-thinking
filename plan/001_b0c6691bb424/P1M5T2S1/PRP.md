# PRP — P1.M5.T2.S1: Race detection — natural completion wins over abort (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M5.T2.S1 (Phase 4 Abort Coordination, 1 pt) — close the **FM-005 / EC-007 / RC-001** race that
> **T1** (`P1.M5.T1.S1`, DONE) deliberately left open. When a stop is dispatched (`triggerStop()`) but the upstream
> **finishes naturally** (emits its terminal `done`/`error` event) concurrently, **natural completion MUST win**: the
> original terminal is forwarded unchanged, **no replacement request is started**, the in-flight abort is cancelled, and
> the per-request `TransitionController` is reset to `Idle`. **Work-item contract (verbatim logic)**: add a flag
> `upstreamCompleted` set when a `done`/`error` event is forwarded; in `StreamProxy.run()`, when catching an error OR
> when the loop completes naturally, check whether the upstream already emitted its terminal before the abort took
> effect — if so, cancel the transition (reset controller `Completed`→`Idle` per the contract's intent — see §3 FSM
> reality), forward the terminal normally, do NOT start a replacement; if the abort error was thrown with NO preceding
> terminal, proceed with the transition (`Capturing`→…, i.e. T1's clean-abort path, unchanged). **Consumed by**:
> **P1.M6** (RequestBuilder reads `buffer.snapshot()` ONLY after a real `Capturing` — this subtask guarantees
> `Capturing`/`freeze` are never wrongly reached on a natural completion) and **P1.M7** (splicing — relies on output
> being OPEN only after a genuine clean abort; this subtask guarantees output is completed by the original terminal on
> a natural-completion win).

---

## Goal

**Feature Goal**: Make `StreamProxy.run()` **race-safe** for the abort-vs-completion window: if the upstream emits its
own terminal `done`/`error` event at any point during (or instead of) an in-flight abort, the **upstream's natural
completion wins** (FM-005/EC-007/RC-001) and the abort transition is cancelled — the original terminal is forwarded
unchanged, the buffer is **not** frozen, **no** replacement request is initiated, the FM-006 timeout net is cleared, and
the `TransitionController` is returned to a clean `Idle`. A genuine clean abort (upstream throws on abort with **no**
terminal forwarded) behaves exactly as T1 implemented it (`Aborting`→`Capturing`, freeze, leave output open).

**Deliverable** (ONE source file MODIFIED + ONE test file CREATED; NO other files change — see Scope Boundary):
- `src/provider/proxy.ts` — **MODIFY**: add a `private _upstreamCompleted = false` field; add `isTerminalEvent` to the
  existing `import … from "../types"`; in `run()`, set `_upstreamCompleted = true` right after forwarding a terminal
  event; add a **natural-completion-wins** branch as the **FIRST** check inside `run()`'s `catch` (before the T1
  `Aborting` clean-abort branch); add a natural-completion cancellation block after the `for await` natural loop exit.
- `tests/stream-proxy-race.test.ts` — **NEW** `bun:test` suite: a **deterministic** natural-completion race mock
  (yields the terminal *before* resolving the abort — `afterDone: "throw" | "close"`) covering both race sub-cases
  (catch-path + natural-exit-path) for `done`, plus an `error`-terminal race case, plus a normal-forwarding regression.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0;
`npx bun test` → **ALL green** — the new `stream-proxy-race.test.ts` PLUS every pre-existing suite (incl. the 8 T1 abort
tests in `stream-proxy-abort.test.ts`) with **ZERO changes and ZERO regressions**. In the race: a concurrently-aborted
stream that emits its `done` forwards the **original `done`** to the consumer (verified by draining `output`), the
controller ends in `Idle`, the buffer is **not** frozen (`append` does not throw), `proxy.abort.completed` (T1's
clean-abort marker) is **not** traced, and `proxy.abort.natural-completion-won` **is** traced. A genuine clean abort
(no terminal forwarded) still reaches `Capturing` + freezes the buffer (T1 unchanged). No edits to any file other than
`src/provider/proxy.ts` + the new test file.

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing (work-item DOCS: "none — internal correctness logic"). The end user
triggers the race indirectly: they press `ctrl+.` while the provider happens to finish naturally at the same moment.

**Use Case**: The user presses `ctrl+.` mid-reasoning; `triggerStop()` synchronously sets `Aborting` and aborts the
internal controller. But the z.ai provider was already emitting its terminal `done` (it "finished naturally"). The
upstream iterator yields that `done` (forwarding it to the consumer), then either throws the abort error or closes.
`run()` detects that the upstream **already emitted its terminal** (`_upstreamCompleted`) and lets natural completion
win: the original `done` stands as the single terminal, the abort is cancelled, no replacement is launched.

**Pain Points Addressed**: Without this fix (the T1 gap), a natural completion racing an abort is either **misclassified
as a transition failure** (FM-006 timeout → `Failed`, because `run()`'s catch never runs and the timeout fires) or
**wrongly captured** (`done` arrives, then the abort throws → T1 freezes the buffer and parks the FSM in `Capturing`,
expecting a replacement that can never splice because `output` is already `done`). Both violate FM-005/EC-007/RC-001.

---

## Why

- **It is the explicit contract for this exact race (FM-005/EC-007/RC-001).** PRD FM-005: "If provider already
  completed, transition cancelled. Normal completion continues." EC-007: "Natural completion wins. Replacement request
  cancelled. No interruption performed." RC-001: "Winner: First terminal state observed."
- **It protects the single-terminal / single-result invariants (PRD §13.2/§18).** On a natural-completion win, the
  upstream's own terminal is the **one** terminal that reaches Pi. Taking T1's clean-abort path instead would leave
  `output` open (no terminal) or, worse, let a replacement splice attempt double-fire a terminal.
- **It is the correctness gate for P1.M6/P1.M7.** RequestBuilder (P1.M6) reads `buffer.snapshot()` only after a
  **genuine** `Capturing`; this subtask guarantees `Capturing`/`freeze` are reached **only** on a real clean abort, so
  P1.M6 never builds a replacement request for a stream that already completed. P1.M7's splicing relies on `output`
  being open **only** after a genuine abort; this subtask guarantees `output` is completed by the original terminal on a
  natural-completion win.
- **It is minimal and purely additive.** The new branch runs **only** when `_upstreamCompleted` is true; every T1 path
  (clean abort, FM-006 timeout, normal forwarding) forwards no terminal during the abort window, so `_upstreamCompleted`
  stays false and T1 behavior is byte-for-byte unchanged.

---

## What

### Source: MODIFY `src/provider/proxy.ts`

#### A. New private field (add near `_internalAbort`/`_abortTimer`)

```typescript
/**
 * FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): set `true` the moment the upstream emits its OWN terminal
 * (`done`/`error`) event AND it is forwarded into `output`. Lets `run()` distinguish a CLEAN abort
 * (upstream threw on abort, no terminal yet → proceed to Capturing) from a race the UPSTREAM WON
 * (it completed naturally despite/with an in-flight abort → natural completion wins; cancel the abort).
 * Checked FIRST in the catch and in the natural-exit path. Set in `run()`'s loop right after `push`.
 */
private _upstreamCompleted = false;
```

#### B. Import — add `isTerminalEvent` to the existing `"../types"` import

```typescript
// BEFORE:  import type { AssistantMessageEvent, TransitionState } from "../types";
// AFTER:
import type { AssistantMessageEvent, TransitionState } from "../types";
import { isTerminalEvent } from "../types";
```
> `isTerminalEvent` is a value (a type guard), so it must be a **non-`type`** import. Keep it as a separate import line
> beside the existing `import type { … }` to preserve `isolatedModules` compliance (tsconfig.json).

#### C. `run()` — set the flag in the loop + add the natural-completion-wins branch

```typescript
private async run(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  upstreamStreamFn: ApiStreamSimpleFunction,
): Promise<void> {
  try {
    const upstream = upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal });
    for await (const event of upstream) {
      this.trackEvent(event);   // side-effect reasoning detection; never throws; never mutates event
      this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
      // FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): the upstream emitted its OWN terminal. If an abort is in
      // flight but the upstream completed naturally, this flag lets natural completion win (see below).
      if (isTerminalEvent(event)) {
        this._upstreamCompleted = true;
      }
    }
    // Natural loop exit. FM-005/EC-007: if the upstream completed naturally WHILE an abort was in flight
    // (triggerStop set Aborting, but the upstream emitted its terminal instead of throwing), natural
    // completion wins — cancel the in-flight abort: clear the FM-006 net + reset the FSM to Idle. Gated on
    // getState()==="Aborting" so a NORMAL completion (state is Reasoning/Idle) is untouched and does NOT emit
    // the race trace. (For an `error` terminal that already reset the FSM to Idle via trackEvent, this gate is
    // false → harmless; its FM-006 net, if any, no-ops on fire since the timeout also checks Aborting.)
    if (this._upstreamCompleted && this._controller.getState() === "Aborting") {
      this._clearAbortTimeout();
      this._cancelInFlightAbort();
      this.diagnostics.trace("proxy.abort.natural-completion-won", {});
    }
  } catch (err) {
    // FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): if the upstream already emitted its terminal BEFORE the abort
    // error was thrown, NATURAL COMPLETION WINS. The terminal was already forwarded above; do NOT take the
    // abort path (no Capturing/freeze) and do NOT synthesize a second terminal (push is idempotent anyway).
    if (this._upstreamCompleted) {
      this._clearAbortTimeout();
      if (this._controller.getState() === "Aborting") {
        this._cancelInFlightAbort();
      }
      this.diagnostics.trace("proxy.abort.natural-completion-won", {});
      return; // the original terminal was already forwarded; output is complete
    }
    // EXPECTED ABORT (PRD §51 Abort Phase) — CLEAN abort, no terminal forwarded (T1, UNCHANGED):
    if (this._controller.getState() === "Aborting") {
      this._clearAbortTimeout();
      try {
        this._controller.completeAbort(); // Aborting → Capturing (PRD §16)
      } catch (e) {
        this.diagnostics.warn("proxy.abort.complete-abort-failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this._buffer.freeze(); // (PRD §41: reasoning immutable once frozen; §40: replacement needs this)
      this.diagnostics.trace("proxy.abort.completed", {});
      return; // leave output OPEN — replacement stream (P1.M6/P1.M7) owns the terminal
    }
    // UNEXPECTED throw → synthesize ONE terminal (T1, UNCHANGED):
    const message = err instanceof Error ? err.message : String(err);
    this._clearAbortTimeout();
    this.diagnostics.warn("proxy.forward.upstream-threw", {
      provider: String(model.provider),
      model: model.id,
      error: message,
    });
    this._output.push({
      type: "error",
      reason: "error",
      error: this.makeErrorAssistantMessage(model, message),
    });
  }
}
```

#### D. New private helper — cancel the in-flight abort back to a clean `Idle`

```typescript
/**
 * FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): cancel an in-flight abort because the upstream completed
 * naturally. PRD §16 has NO `Aborting → {Completed, Idle}` edge, so the only legal path back to a clean
 * `Idle` is `fail()` (Any→Failed, the FSM's escape hatch already used by FM-006 / upstream-error) then
 * `reset()` (Failed→Idle). Reason `"natural-completion-won"` classifies this as a BENIGN cancellation
 * (RC-001 winner resolution) for P1.M8 telemetry — NOT a true transition failure. Never throws.
 *
 * PRECONDITION: caller has verified `getState() === "Aborting"` and already cleared the FM-006 net.
 */
private _cancelInFlightAbort(): void {
  this._controller.fail("natural-completion-won"); // Aborting → Failed (Any→Failed; always legal)
  this._controller.reset();                         // Failed → Idle
}
```

> **JSDoc convention (Mode-A):** every new member carries a JSDoc citing the PRD anchor (FM-005/EC-007/RC-001/§16/§41),
> matching `src/state/controller.ts` and the existing `proxy.ts` members. **Privacy (Appendix H):** the one new
> diagnostics call logs `{}` only — never content, state payload, or reasoning text.

### Test: CREATE `tests/stream-proxy-race.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`). Reuse the project's existing test doubles
VERBATIM from `tests/stream-proxy-abort.test.ts`: `makeCaptureDiag()`, `makeModel()`, `ev()`, `DONE_MESSAGE`,
`ERROR_MESSAGE`, and the `waitFor()` polling helper. Add ONE new deterministic mock —
`makeNaturalCompletionRaceMock(afterDone: "throw" | "close")` — per `research/notes.md` §5:

```typescript
/**
 * DETERMINISTIC natural-completion race mock (EC-007). Phase 1: drain pending events as they arrive
 * (blocks when empty) and DOES NOT throw on abort — so a queued terminal is ALWAYS forwarded before the
 * abort resolves. Phase 2: once a terminal (done/error) is yielded, either THROW the abort error
 * (`afterDone === "throw"`) or RETURN naturally (`afterDone === "close"`). Models "the done was already
 * in flight and gets delivered despite the abort" — the exact EC-007 timeline.
 */
function makeNaturalCompletionRaceMock(afterDone: "throw" | "close") {
  let signal: AbortSignal | undefined;
  const queue: AssistantMessageEvent[] = [];
  const iterable = {
    async *[Symbol.asyncIterator]() {
      // Phase 1 — forward everything queued; never throw on abort here (so the terminal is delivered).
      while (true) {
        if (queue.length > 0) {
          const e = queue.shift()!;
          yield e;
          if (e.type === "done" || e.type === "error") {
            // Phase 2 — terminal just forwarded; now resolve the race.
            if (afterDone === "throw" && signal?.aborted) throw new Error("aborted");
            return; // close naturally
          }
          continue;
        }
        await new Promise<void>((r) => setTimeout(r, 0)); // block until more events are queued
      }
    },
  };
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    signal = opts?.signal;
    return iterable;
  }) as unknown as ApiStreamSimpleFunction;
  return { fn, push: (e: AssistantMessageEvent) => queue.push(e) };
}
```

Coverage (every Success Criterion):

- **`done` race — catch path (`afterDone: "throw"`):** drive to Reasoning; `triggerStop()` → `true`; push `done`; the
  mock forwards `done` then throws. Drain a concurrent consumer of `output`; assert `seen` contains the **original
  `done`** (and exactly one terminal). `waitFor`/assert `controller.getState() === "Idle"`; `buffer` **not** frozen
  (`buffer.append("x")` does not throw); `proxy.abort.completed` (T1 marker) NOT traced;
  `proxy.abort.natural-completion-won` traced.
- **`done` race — natural-exit path (`afterDone: "close"`):** same setup; the mock forwards `done` then returns. Same
  assertions (consumer sees original `done`; `Idle`; buffer not frozen; natural-completion-won traced; T1 marker not).
- **`error` race (`afterDone: "throw"`):** push an `error` terminal instead of `done`. `trackEvent` already resets the
  FSM to Idle on `error`; assert output has the original `error`, controller `Idle`, buffer not frozen,
  `proxy.abort.natural-completion-won` traced. (Confirms the `error` sub-case is handled, not just `done`.)
- **genuine clean-abort regression:** `afterDone` irrelevant — push NO terminal; `triggerStop()`; the mock throws on the
  abort. Assert T1 behavior preserved: `Capturing`, buffer frozen, `proxy.abort.completed` traced, output left open
  (no terminal). (Mirrors T1's "clean abort happy path" — proves the new branch did not perturb it.)
- **normal-forwarding regression:** a full non-aborted stream (`start`…`done`, NO `triggerStop`) forwards every event
  unchanged with exactly one terminal; `_upstreamCompleted` is set but the natural-exit block does nothing harmful
  (state is `Reasoning`, not `Aborting`, so no reset). Proves the fix does not perturb the transparent path.
- **privacy guard:** the new `proxy.abort.natural-completion-won` event logs `{}` only (no content keys) — assertable
  via the same allow-list scan used in `stream-proxy-abort.test.ts`.

**Out of scope** (owned by other subtasks — do NOT implement/modify here):
- **Replacement request + splicing + the downstream terminal after a genuine `Capturing`** → **P1.M6/P1.M7** (a clean
  abort still leaves `output` open — unchanged from T1).
- **Full FM-001..FM-015 recovery + telemetry classification of `"natural-completion-won"`** → **P1.M8.T2 / P1.M8.T1**.
- **Factory/decorator/coordinator wiring** → **P1.M5** wiring step.
- Any change to `src/state/controller.ts`, `src/state/coordinator.ts`, `src/buffer/*`, `src/provider/decorator.ts`,
  `src/config/*`, `src/diagnostics/*`, `src/shortcut/*`, `src/index.ts`, `src/types.ts`, or any existing test. No new
  dependencies (`isTerminalEvent` already exists in `src/types.ts`; `setTimeout` is a bun/node global).

### Success Criteria

- [ ] `StreamProxy` gains `private _upstreamCompleted = false`; the `"../types"` import adds `isTerminalEvent`
      (non-`type` import line, `isolatedModules`-safe).
- [ ] `run()`'s loop sets `_upstreamCompleted = true` immediately after forwarding a terminal (`isTerminalEvent`).
- [ ] `run()`'s `catch` checks `_upstreamCompleted` **FIRST**: if true → clear timeout, `_cancelInFlightAbort()` iff
      `Aborting`, trace `proxy.abort.natural-completion-won`, `return` (no Capturing, no freeze, no synthesized
      terminal). The T1 clean-abort branch (`Aborting`→Capturing+freeze) and the unexpected-throw synthesis follow,
      **unchanged**.
- [ ] After `run()`'s natural loop exit: if `_upstreamCompleted && getState()==="Aborting"` → clear timeout +
      `_cancelInFlightAbort()` + trace `proxy.abort.natural-completion-won`. (Gated so a normal completion is
      untouched/untraced.)
- [ ] `_cancelInFlightAbort()` does `fail("natural-completion-won")` (Aborting→Failed) + `reset()` (Failed→Idle); never
      throws; called only when `getState() === "Aborting"`.
- [ ] Race (`done`/`error`, throw/close): consumer drains the **original** terminal; controller ends `Idle`; buffer
      **not** frozen; `proxy.abort.natural-completion-won` traced; `proxy.abort.completed` **not** traced.
- [ ] Genuine clean-abort + normal-forwarding regressions pass unchanged.
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green (every
      pre-existing suite incl. the 8 T1 abort tests + the new race file), zero regressions.

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have everything needed to
implement this successfully?"_ → YES. The exact field, import change, `run()` loop/catch/natural-exit logic, the
`_cancelInFlightAbort()` helper, and the deterministic test mock are reproduced verbatim above. The non-obvious facts —
(1) **why** `fail()+reset()` is the only legal `Aborting→Idle` path (§16 has no such edge), (2) **why** the `error`
sub-case is already `Idle` by the time `run()` checks (trackEvent resets on `error`), (3) the EventStream `push`
semantics (forwarding the original terminal completes the stream; a second push is an idempotent no-op), and (4) **why**
the mock must yield the terminal before resolving the abort (T1's mock checks abort-first → non-deterministic) — are all
explained in "Why" + `research/notes.md` §1–§5.

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask (the race contract)
- url: PRD.md "# FM-005"  (under "# 42. Failure Mode Specification")
  why: "Abort races provider completion. Expected: 'If provider already completed, transition cancelled. Normal
        completion continues.'"
  critical: "If the upstream's terminal was forwarded, the transition MUST be cancelled — no Capturing, no freeze."

- url: PRD.md "# EC-007 — Provider Finishes While Abort Is Dispatching"  (Appendix B)
  why: "Timeline: thinking_delta → Ctrl+. → Abort() → Provider finishes naturally. Expected: 'Natural completion wins.
        Replacement request cancelled. No interruption performed.'"
  critical: "This is the EXACT scenario. The original terminal stands; NO replacement. The abort is a no-op effect."

- url: PRD.md "# RC-001"  (Appendix C — Race Conditions)
  why: "Abort vs Completion → Winner: First terminal state observed."
  critical: "Whoever's terminal is observed first wins. If the upstream's terminal is forwarded, it wins."

- url: PRD.md "# 51. Complete Transition Algorithm / Abort Phase"
  why: "Abort Controller → Dispatch Abort → Await Upstream Exit → Capture Final Reasoning → Freeze Buffer. 'No
        replacement request may begin before reasoning is frozen.'"
  critical: "Freeze/Capturing happen ONLY on a real upstream-exit-via-abort-throw. If the upstream exited via its OWN
             terminal, there is no freeze/Capturing — natural completion wins instead."

- url: PRD.md "# 16. State Transition Table"  (and "# 17. State Invariants")
  why: "Aborting → {Capturing, Failed}; Failed → {Idle}. There is NO Aborting → {Completed, Idle} edge."
  critical: "This is WHY _cancelInFlightAbort() uses fail() (Any→Failed) + reset() (Failed→Idle): it is the ONLY legal
             path back to Idle from Aborting. Do NOT try Aborting→Completed (illegal → transitionIfLegal would skip)."

# Codebase patterns to FOLLOW (all DONE/immutable — do NOT modify)
- file: src/provider/proxy.ts
  why: "The file under modification. Contains run()'s try/catch (the insertion points), trackEvent()'s terminal branch
        (already resets on `error` via fail+reset — that is why the `error` race is already Idle), _clearAbortTimeout(),
        _internalAbort, _controller, _buffer, and makeErrorAssistantMessage()."
  pattern: "fire-and-forget run() that never rethrows; transparent forwarding `for await … trackEvent(); push(event)`."
  gotcha: "The new natural-completion branch MUST short-circuit BEFORE the T1 clean-abort branch (which freezes + leaves
           output open). Ordering in the catch: (1) _upstreamCompleted → cancel+return; (2) Aborting → clean abort;
           (3) else → synthesize terminal."

- file: src/state/controller.ts
  why: "The FSM. fail(reason) (Any→Failed, never throws) and reset() (Failed/Completed→Idle) BOTH EXIST and are the
        legal cancel path. getState()/canInterrupt() are the reads."
  pattern: "boolean/throwing transition methods; fail() is the never-throwing Any→terminal escape hatch."
  gotcha: "reset() THROWS unless the state is Completed or Failed — so always fail() FIRST (→Failed), THEN reset(). And
           reset() is a no-op-to-call only from Failed/Completed; from Aborting it throws — hence the
           getState()==='Aborting' guard around _cancelInFlightAbort()."

- file: src/types.ts
  why: "Exports isTerminalEvent(event): event is TerminalEvent — matches type 'done' | 'error'. The single source of
        truth for 'is this a terminal'."
  pattern: "centralized family type guards (isThinkingEvent/isTextEvent/isToolCallEvent/isTerminalEvent)."
  gotcha: "isTerminalEvent is a VALUE (type guard fn), NOT a type — import it on a non-`type` import line (isolatedModules)."

- file: node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js  (read-only library source)
  why: "EventStream.push: if (this.done) return; if (isComplete(event)) { done=true; resolveFinalResult(...); }. So
        forwarding the original terminal completes output + resolves result() exactly once; any later push is a no-op."
  pattern: "single-terminal-completes-the-stream; push is idempotent after done."
  critical: "Confirms that `return`-ing without synthesizing a terminal on a natural-completion win is CORRECT — the
             upstream's own terminal already completed the stream. Do NOT push a second terminal."

- file: tests/stream-proxy-abort.test.ts
  why: "Pattern source: makeCaptureDiag()/makeModel()/ev()/DONE_MESSAGE/ERROR_MESSAGE/waitFor(), and the concurrent
        consumer drain pattern (`for await (const e of proxy.output) seen.push(e.type)`)."
  pattern: "inject controller+buffer; drive to Reasoning; triggerStop; waitFor state; assert via injected refs."
  gotcha: "makeAbortableUpstream() checks signal.aborted BEFORE yielding → non-deterministic for the race. Use the NEW
           makeNaturalCompletionRaceMock() which forwards the terminal BEFORE resolving the abort (research §5)."

- file: src/buffer/index.ts
  why: "freeze() is the clean-Capturing marker (idempotent). append() throws iff frozen. The race test asserts
        append() does NOT throw (buffer NOT frozen) to prove no replacement was started."
  pattern: "append() after freeze() throws; that is the assertion lever."
  gotcha: "Do NOT call freeze() on the natural-completion path — freeze is the genuine-clean-abort marker only."

- docfile: plan/001_b0c6691bb424/P1M5T1S1/research/notes.md
  why: "T1's mechanism + the T1/T2 boundary: 'if triggerStop() ran first but the upstream completed naturally instead of
        throwing, the catch below does NOT run — that FM-005 race is P1.M5.T2's job.' (verbatim from T1's run() comment)."
  section: "the run() catch comment + the FM-005 deferral"

- docfile: plan/001_b0c6691bb424/P1M5T2S1/research/notes.md
  why: "Evidence base for THIS PRP: the exact race mechanism, the FSM constraint, EventStream semantics, the fix, and
        the deterministic mock (all 6 sections)."
  section: "§1 (race), §2 (EventStream), §3 (FSM), §4 (fix), §5 (mock)"
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO race wiring here (→ P1.M5 wiring)
├── types.ts                 # isTerminalEvent / TransitionState / family guards (P1.M2.T1) — IMPORT from here
├── config/index.ts          # DEFAULT_CONFIG.transitionTimeoutMs (P1.M1.T2)
├── diagnostics/index.ts     # Diagnostics interface (P1.M1.T3)
├── buffer/index.ts          # ReasoningBuffer — freeze()/append() (P1.M4.T1)
├── provider/
│   ├── decorator.ts         # ProviderDecorator — constructs StreamProxy w/ 5 args (P1.M1/M2)
│   └── proxy.ts             # StreamProxy — T1 abort done; ← THIS SUBTASK adds FM-005 race detection
├── shortcut/index.ts        # ShortcutManager + StopRequestCoordinator seam (P1.M4.T3)
└── state/
    ├── controller.ts        # TransitionController — fail()/reset()/getState() EXIST (P1.M3/T1) — call, don't modify
    └── coordinator.ts       # TransitionCoordinator + ActiveProxy seam (P1.M4.T4)
tests/
├── stream-proxy-abort.test.ts     # T1 pattern source (8 tests) — must stay green, unchanged
├── stream-proxy-detection.test.ts # pattern source (makeCaptureDiag/makeModel/ev/drive)
└── … (existing suites — all must stay green)
```

### Desired Codebase tree with files to be added/changed

```bash
src/provider/proxy.ts                  # MODIFY: _upstreamCompleted flag + run() race detection (loop/catch/exit) + _cancelInFlightAbort
tests/stream-proxy-race.test.ts        # CREATE : deterministic race mock + done/error × throw/close + regressions
# (no other files change)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: catch ordering. The new `_upstreamCompleted` branch MUST be the FIRST check in run()'s catch — BEFORE the
// T1 `getState()==="Aborting"` clean-abort branch. If a `done` was forwarded, the FSM is STILL Aborting (trackEvent's
// done-branch can't move Aborting→Completed), so the T1 branch would WRONGLY fire (freeze+Capturing) if checked first.

// CRITICAL: §16 has NO Aborting→{Completed,Idle} edge. The ONLY legal Aborting→Idle path is fail() (Any→Failed) +
// reset() (Failed→Idle). reset() THROWS from any state other than Completed/Failed — so ALWAYS fail() first, and ONLY
// call _cancelInFlightAbort() when getState()==="Aborting" (the `error` race sub-case is already Idle — guard it).

// CRITICAL: the work-item contract says "reset to Completed then Idle", but §16 makes Aborting→Completed illegal.
// fail("natural-completion-won")+reset() reaches Idle and classifies the event benignly for P1.M8 telemetry. Do NOT
// attempt controller.complete() / a real Completed move (Answering→Completed only; unreachable from Aborting).

// CRITICAL: do NOT synthesize a terminal on a natural-completion win. The upstream's OWN terminal was already pushed
// in the loop, which completed output + resolved result() (EventStream.push sets done=true on a terminal). A second
// push is an idempotent no-op but the natural-completion branch `return`s BEFORE the synthesis code anyway.

// GOTCHA: the `error`-terminal race sub-case needs no controller reset — trackEvent ALREADY runs
// fail("upstream-error")+reset()→Idle on any `error`. So in the catch, getState() is Idle (not Aborting); the
// getState()==="Aborting" guard around _cancelInFlightAbort() correctly skips it. Still clear the timeout + trace.

// GOTCHA: isTerminalEvent is a VALUE (type guard), not a type. Import it on a separate NON-`type` line beside the
// existing `import type { AssistantMessageEvent, TransitionState }` — required by isolatedModules (tsconfig.json).

// GOTCHA: T1's makeAbortableUpstream() checks signal.aborted BEFORE yielding queued events → the race outcome is
// timing-dependent (flaky). The race test MUST use the NEW makeNaturalCompletionRaceMock() which forwards the
// terminal FIRST (phase 1 never throws on abort) and resolves the abort only in phase 2.

// PRIVACY (Appendix H): the one new diagnostics call (proxy.abort.natural-completion-won) logs {} only — no content,
// no state payload, no reasoning text. The buffer's freeze()/append() already log counts only.

// INV: when _upstreamCompleted is false, the new branch is a pure no-op — every T1 path forwards NO terminal during
// the abort window, so T1 behavior (clean abort / FM-006 / forwarding) is byte-for-byte unchanged.
```

---

## Implementation Blueprint

### Data models and structure

No new persistent data models. The proxy adds ONE ephemeral per-request boolean:

```typescript
private _upstreamCompleted = false; // set true when the upstream's own done/error is forwarded
```

No FSM change — `_cancelInFlightAbort()` reuses the existing `fail()`/`reset()` (the only legal `Aborting→Idle` path).
Type safety is enforced by `strict: true` + `isolatedModules: true` (`tsconfig.json`) and the `tsc --noEmit` gate.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — _upstreamCompleted field + isTerminalEvent import
  - ADD field: `private _upstreamCompleted = false;` (near _internalAbort/_abortTimer).
  - ADD import: `import { isTerminalEvent } from "../types";` (non-`type` line, beside the existing import type).
  - FOLLOW pattern: existing underscore-prefixed private fields + the existing "../types" import block.
  - NAMING: _upstreamCompleted (underscore-prefixed private boolean).
  - PLACEMENT: src/provider/proxy.ts (field block; import at top).
  - DEPENDENCIES: isTerminalEvent already exported from src/types.ts.

Task 2: MODIFY src/provider/proxy.ts — run() race detection (loop flag + catch branch + natural-exit block)
  - ADD in the loop body, after `this._output.push(event);`: `if (isTerminalEvent(event)) this._upstreamCompleted = true;`.
  - ADD as the FIRST check in run()'s catch: `if (this._upstreamCompleted) { _clearAbortTimeout(); if
    (getState()==="Aborting") _cancelInFlightAbort(); trace("proxy.abort.natural-completion-won", {}); return; }`.
  - ADD after the `for await` natural exit: `if (this._upstreamCompleted && getState()==="Aborting") {
    _clearAbortTimeout(); _cancelInFlightAbort(); trace("proxy.abort.natural-completion-won", {}); }`. (Gated on
    Aborting so a normal completion — state Reasoning/Idle — is untouched and untraced.)
  - KEEP the T1 clean-abort branch (Aborting→Capturing+freeze+return) and the unexpected-throw synthesis UNCHANGED,
    directly after the new _upstreamCompleted branch.
  - GOTCHA: catch ordering is load-bearing — _upstreamCompleted FIRST, then Aborting, then synthesize.
  - PLACEMENT: inside run() only.
  - DEPENDENCIES: Task 1 (_upstreamCompleted, isTerminalEvent) + Task 3 (_cancelInFlightAbort, _clearAbortTimeout).

Task 3: MODIFY src/provider/proxy.ts — _cancelInFlightAbort() helper
  - ADD private `_cancelInFlightAbort(): void { this._controller.fail("natural-completion-won");
    this._controller.reset(); }` with the Mode-A JSDoc from "What / D".
  - FOLLOW pattern: controller.ts fail()/reset() chaining; never-throwing helper.
  - GOTCHA: caller MUST guard getState()==="Aborting" (reset() throws from non-Completed/Failed); caller MUST clear the
    timeout first.
  - PLACEMENT: alongside _clearAbortTimeout()/_startAbortTimeout().
  - DEPENDENCIES: existing controller.fail()/reset() (no controller change).

Task 4: CREATE tests/stream-proxy-race.test.ts
  - COPY makeCaptureDiag/makeModel/ev/DONE_MESSAGE/ERROR_MESSAGE/waitFor from tests/stream-proxy-abort.test.ts.
  - IMPLEMENT makeNaturalCompletionRaceMock(afterDone: "throw" | "close") per research/notes.md §5 (forward terminal
    FIRST in phase 1; resolve abort in phase 2).
  - IMPLEMENT the 6 coverage cases in "What / Test" (done×throw; done×close; error×throw; genuine-clean-abort
    regression; normal-forwarding regression; privacy guard).
  - FOLLOW pattern: tests/stream-proxy-abort.test.ts (inject controller+buffer; concurrent consumer drain; waitFor
    state; assert via injected refs; allow-list scan for diagnostic fields).
  - COVERAGE: both race sub-cases (catch + natural-exit) × both terminals (done/error); T1 clean-abort preserved;
    normal forwarding preserved; privacy.
  - PLACEMENT: tests/stream-proxy-race.test.ts (tests/ excluded from tsc; run by `bun test`).
  - DEPENDENCIES: imports StreamProxy + TransitionController + ReasoningBuffer + pi-ai types + isTerminalEvent(unneeded
    in test; the mock checks e.type directly).
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — the race-resolving branch is FIRST in the catch and AFTER the natural loop exit. It runs ONLY when the
// upstream's own terminal was forwarded; otherwise T1 behavior is untouched.
// in run()'s loop:
for await (const event of upstream) {
  this.trackEvent(event);
  this._output.push(event);
  if (isTerminalEvent(event)) this._upstreamCompleted = true; // FM-005/EC-007/RC-001
}
// after the natural exit (gated on Aborting so a NORMAL completion is untouched + untraced):
if (this._upstreamCompleted && this._controller.getState() === "Aborting") {
  this._clearAbortTimeout();
  this._cancelInFlightAbort();
  this.diagnostics.trace("proxy.abort.natural-completion-won", {});
}
// in the catch, FIRST:
if (this._upstreamCompleted) {
  this._clearAbortTimeout();
  if (this._controller.getState() === "Aborting") this._cancelInFlightAbort();
  this.diagnostics.trace("proxy.abort.natural-completion-won", {});
  return; // original terminal already forwarded — output is complete
}

// PATTERN — the only legal Aborting→Idle path (§16 has no Aborting→{Completed,Idle} edge):
private _cancelInFlightAbort(): void {
  this._controller.fail("natural-completion-won"); // Aborting → Failed (Any→Failed; never throws)
  this._controller.reset();                         // Failed → Idle
}

// GOTCHA — `error` race sub-case needs no reset: trackEvent already did fail("upstream-error")+reset()→Idle, so
// getState() is Idle in the catch → the getState()==="Aborting" guard skips _cancelInFlightAbort(). Only `done`
// (trackEvent can't move Aborting→Completed) still sits in Aborting and needs the reset.
// GOTCHA — never push a terminal on the natural-completion win; the upstream's terminal already completed output.
// GOTCHA — clear the FM-006 net in EVERY path (natural-completion win ×2, clean abort, unexpected throw) so a
// spurious timeout never fires after a natural completion.
```

### Integration Points

```yaml
# NOTE: this subtask changes ONLY src/provider/proxy.ts + tests/stream-proxy-race.test.ts. Wiring is unchanged.

CONTROLLER (src/state/controller.ts): NO CHANGE — fail()/reset()/getState() all EXIST. _cancelInFlightAbort() reuses
  them. fail("natural-completion-won") is consistent with T1's fail("abort-timeout") and trackEvent's
  fail("upstream-error") (all use the Any→Failed escape hatch; P1.M8 classifies by reason).

BUFFER (src/buffer/index.ts): NO CHANGE — freeze() is NEVER called on the natural-completion path (it is the
  genuine-clean-abort marker only). The race test asserts append() does NOT throw → no replacement started.

COORDINATOR / DECORATOR / FACTORY: NO CHANGE — none observe _upstreamCompleted (internal to the proxy). The proxy's
  public surface (output/controller/buffer/isReasoning/canInterrupt/isInterrupting/triggerStop) is unchanged.

P1.M6 (RequestBuilder): reads buffer.snapshot() ONLY after a genuine Capturing — this subtask guarantees Capturing is
  reached ONLY on a real clean abort, so P1.M6 never builds a replacement for an already-completed stream.

P1.M7 (Splicing): relies on output being OPEN only after a genuine clean abort — this subtask guarantees output is
  completed by the original terminal on a natural-completion win (no dangling-open output).

CONFIG / DATABASE / ROUTES: none.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after editing src/provider/proxy.ts — must be clean before writing the test.
npx bun run typecheck     # tsc --noEmit over src/** — proxy.ts MUST compile standalone (0 diagnostics)
npx bun run build         # tsc → exit 0

# (No ruff/mypy — TS project. Match the existing 2-space style + Mode-A JSDoc.)
# Expected: Zero errors. If typecheck flags isTerminalEvent as an unimportable value, you imported it on a `type`
# line — move it to a NON-`type` import (isolatedModules). If it flags reset() throwing, you called
# _cancelInFlightAbort() without the getState()==="Aborting" guard — add the guard.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the race suite in isolation.
npx bun test tests/stream-proxy-race.test.ts -v

# Full suite for regressions (proxy + state + buffer + shortcut + coordinator + golden + factory + decorator + T1 abort).
npx bun test

# Expected: All tests pass. Common failures to READ for:
#  - "Expected Idle, received Aborting/Capturing" → the natural-completion branch didn't run: check _upstreamCompleted
#    is set in the loop AFTER push (not before), and that the catch checks it FIRST.
#  - "buffer.append did not throw" (race test) → T1's clean-abort branch fired instead of the natural-completion
#    branch: catch ordering is wrong (_upstreamCompleted must be checked BEFORE getState()==="Aborting").
#  - "consumer did not see done" → you synthesized/withdrew the terminal on the natural-completion win: the branch must
#    `return` WITHOUT pushing; the loop already pushed the original terminal.
#  - A T1 abort test regresses (e.g. "clean abort happy path" now hits Capturing but buffer not frozen) → the new branch
#    fired when it shouldn't: ensure _upstreamCompleted is false on the clean-abort path (no terminal forwarded).
```

### Level 3: Integration Testing (System Validation)

```bash
# There is no live runtime integration yet (factory/decorator/coordinator wiring is P1.M5). The integration contract
# is BEHAVIORAL + STRUCTURAL. Verify directly:

# (a) T1 abort suite is byte-for-byte unchanged (the new branch is a no-op when no terminal is forwarded):
npx bun test tests/stream-proxy-abort.test.ts -v

# (b) Transparent-forwarding + golden replay are unchanged (a normal stream with a terminal must not be perturbed):
npx bun test tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts tests/golden/golden-replay.test.ts -v

# (c) Full suite (the real integration bar — 160 pre-existing tests + the new race file):
npx bun test

# Expected: (a) 8/8 T1 tests pass unchanged; (b) all forwarding/golden tests pass; (c) all green, zero regressions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Race determinism: the mock forwards the terminal in phase 1 (NEVER throws on abort there) and resolves the abort only
# in phase 2 — so the `done` is ALWAYS delivered before the catch/natural-exit runs. Re-run the race file a few times
# to confirm no flake:
for i in 1 2 3 4 5; do npx bun test tests/stream-proxy-race.test.ts >/dev/null 2>&1 && echo "run $i: OK" || echo "run $i: FLAKE"; done

# Privacy guard (Appendix H): proxy.abort.natural-completion-won logs {} only. Enforced by an allow-list assertion
# scanning every captured fields object in the race suite for content keys (none permitted beyond the existing
# allow-list; {} is fine).

# Concurrency note (PRD §37): _upstreamCompleted is owned solely by this StreamProxy instance; run() is the only
# writer; triggerStop() never touches it. No lock required (cooperative single-writer async). Documented in JSDoc.

# Expected: 5/5 OK (deterministic); privacy assertion green; no concurrency primitive introduced.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0.
- [ ] Level 2: `npx bun test` → **all green** (every pre-existing suite incl. the 8 T1 abort tests + the new
      `stream-proxy-race` tests).
- [ ] No regressions: all pre-existing test files are unchanged and still pass (T1 abort suite byte-for-byte).
- [ ] proxy.ts imports NO new modules beyond `isTerminalEvent` from "../types" (already exported); `setTimeout` is a
      global (T1).

### Feature Validation
- [ ] `_upstreamCompleted` set after forwarding a terminal; checked FIRST in the catch and after the natural loop exit.
- [ ] Natural-completion win: original terminal forwarded; controller → Idle; buffer NOT frozen; no replacement;
      `proxy.abort.natural-completion-won` traced; `proxy.abort.completed` NOT traced; FM-006 net cleared.
- [ ] `_cancelInFlightAbort()` = `fail("natural-completion-won")` + `reset()`; guarded on `getState()==="Aborting"`.
- [ ] Genuine clean abort (no terminal forwarded) → `Capturing` + frozen + output open (T1 unchanged).
- [ ] Normal forwarding (`start`…`done`, no triggerStop) → unchanged transparent path.

### Code Quality Validation
- [ ] Catch ordering load-bearing and correct (`_upstreamCompleted` → `Aborting` → synthesize).
- [ ] `error` sub-case handled via the `getState()==="Aborting"` guard (trackEvent already reset it; skip cancel).
- [ ] Mode-A JSDoc with PRD cites (FM-005/EC-007/RC-001/§16/§41) — matches controller.ts / proxy.ts style.
- [ ] Single-writer FSM honored (no new state owners; only calls to existing controller methods).

### Documentation & Deployment
- [ ] JSDoc explains WHY `fail()+reset()` is the only legal `Aborting→Idle` path (§16 constraint).
- [ ] JSDoc explains the `done` vs `error` sub-case difference (trackEvent resets `error` only).
- [ ] No new env vars / config.

---

## Anti-Patterns to Avoid
- ❌ Don't check `getState()==="Aborting"` BEFORE `_upstreamCompleted` in the catch — a forwarded `done` leaves the FSM
  in `Aborting`, so the T1 clean-abort branch would WRONGLY fire (freeze + leave output open) on a natural completion.
- ❌ Don't synthesize / push a terminal on a natural-completion win — the upstream's own terminal already completed
  `output` + resolved `result()` (EventStream.push sets `done=true`). The branch must `return` before the synthesis.
- ❌ Don't try `Aborting → Completed` (illegal under §16; `transitionIfLegal` would no-op) or call `reset()` directly
  from `Aborting` (it throws). Use `fail("natural-completion-won")` + `reset()` — the only legal path to `Idle`.
- ❌ Don't call `_cancelInFlightAbort()` without the `getState()==="Aborting"` guard — the `error` race sub-case is
  already `Idle` (trackEvent reset it); `reset()` from `Idle` would throw.
- ❌ Don't freeze the buffer on the natural-completion path — `freeze()` is the genuine-clean-abort marker only; the
  race test asserts `append()` does NOT throw.
- ❌ Don't leave the FM-006 net armed on a natural-completion win — clear it in BOTH the catch branch and the
  natural-exit block, or a spurious timeout → `Failed` will fire later.
- ❌ Don't reuse T1's `makeAbortableUpstream()` for the race test — it checks `signal.aborted` before yielding → the
  terminal may never be delivered (non-deterministic). Use the new `makeNaturalCompletionRaceMock()` that forwards the
  terminal first.
- ❌ Don't import `isTerminalEvent` on a `type` import line (it's a value/type-guard; `isolatedModules` rejects it).
- ❌ Don't touch `controller.ts`, `coordinator.ts`, `buffer/`, `decorator.ts`, `config/`, `shortcut/`, `index.ts`,
  `types.ts`, or any existing test — this subtask is `proxy.ts` + the new race test only.
- ❌ Don't log prompt/reasoning/assistant content (Appendix H) — `proxy.abort.natural-completion-won` logs `{}` only.
