# Research Notes — P1.M5.T2.S1: Race detection: completion wins over abort

> **Extension**: `pi-stop-thinking`. **Subtask**: P1.M5.T2.S1 (Phase 4 Abort Coordination, 1 pt).
> This note captures the precise mechanism, the FSM constraint that drives the design, the EventStream
> semantics that make the fix safe, and the deterministic test mock. The PRP (`../PRP.md`) is the
> authoritative deliverable; this is its evidence base.

---

## 1. The race, exactly (FM-005 / EC-007 / RC-001)

**Scenario (EC-007)**: the user presses `ctrl+.` while the z.ai provider is mid-reasoning, but the
provider **finishes naturally** (emits its terminal `done`/`error` event) at ~the same instant the
abort is dispatched. Two things are in flight concurrently:

- `triggerStop()` runs **synchronously**: `requestStop()` (Reasoning→StopRequested) →
  `beginAbort()` (StopRequested→Aborting) → `_internalAbort.abort()` → arms the FM-006 timeout.
- The upstream async iterator is mid-`yield`; it may (a) **throw** the abort error on its next pull
  (clean abort — T1's path), OR (b) **yield its terminal event first** and then throw/close.

**The bug T1 leaves (verbatim from `proxy.ts` run() + the §16 table):**

- If the upstream yields `done` and *then* the iterator throws (catch path): `trackEvent(done)` tries
  `Aborting→Completed`, which is **illegal** under §16 (`Aborting` only reaches `Capturing`/`Failed`),
  so the state stays `Aborting`. The catch then sees `getState()==="Aborting"` → runs T1's **clean-abort
  branch** (`completeAbort()`→Capturing, `buffer.freeze()`, `return`) — even though the stream **already
  completed naturally** with `done`. The buffer is wrongly frozen and the FSM is parked in `Capturing`
  awaiting a replacement that will never splice (output is already `done`).
- If the upstream yields `done` and the iterator **ends naturally** (no throw): the catch never runs,
  `completeAbort`/`freeze` never run, the state stays `Aborting`, and the **FM-006 timeout fires** →
  `fail("abort-timeout")` → `Failed`. A **natural completion is misclassified as a timeout failure.**

Both contradict PRD **FM-005** ("If provider already completed, transition cancelled. Normal completion
continues."), **EC-007** ("Natural completion wins. Replacement request cancelled. No interruption
performed."), and **RC-001** ("Winner: First terminal state observed.").

**The `error`-terminal sub-case is accidentally near-OK** because `trackEvent` already runs
`fail("upstream-error")` (Any→Failed) + `transitionIfLegal("Idle")` (Failed→Idle) on any `error`
event — so the FSM is already reset to `Idle` by the time `run()` checks. But it is untidy (the FM-006
net is not explicitly cleared; a spurious `proxy.forward.upstream-threw` warn can fire on the idempotent
re-push). The `done` sub-case is the genuinely broken one.

## 2. EventStream semantics that make the fix safe (pi-ai `event-stream.js`)

Read directly from `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`:

```js
push(event) {
  if (this.done) return;                 // (a) push is a NO-OP once a terminal was pushed
  if (this.isComplete(event)) {          // (b) AssistantMessageEventStream.isComplete = type==="done"||"error"
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));  // result() resolves
  }
  // deliver to a waiting consumer or queue
}
```

Consequences for the fix:
- The **original** terminal forwarded in the loop (`this._output.push(event)`) completes `output` and
  resolves `result()` exactly once. **We must NOT push a second terminal** — and we must NOT take the
  T1 clean-abort path (which leaves output open for a replacement that will never come). The fix's
  natural-completion branch `return`s **without** synthesizing anything: the original terminal already
  did the job.
- Any defensive re-push (idempotent no-op) is harmless, but we avoid it by `return`-ing early.
- The async iterator ends naturally once `done` is set (next `next()` sees `done`→returns), so the
  natural-exit path is reached reliably when the upstream closes after forwarding its terminal.

## 3. The FSM constraint that fixes the design

`ALLOWED_TRANSITIONS` (from `src/state/controller.ts`, PRD §16) — the abort-chain column:

```
Aborting   → {Capturing, Failed}
Failed     → {Idle}
```

There is **NO** `Aborting → {Completed, Idle}` edge. Therefore the **only legal path** from `Aborting`
back to a clean `Idle` (what the work-item contract calls "reset to Completed then Idle") is:

```
fail("natural-completion-won")   // Any → Failed   (always legal; never throws)
reset()                          // Failed → Idle   (legal from Failed)
```

`fail()` is the FSM's existing **"Any → terminal" escape hatch** — already used by T1's FM-006
(`fail("abort-timeout")`) and by `trackEvent` (`fail("upstream-error")`). We reuse it with reason
`"natural-completion-won"` so that (a) the move is legal, and (b) P1.M8 telemetry can classify it as a
**benign cancellation** (RC-001 winner resolution), NOT a true transition failure. `fail()` emits a
`transition.failed` error log; this is acceptable and consistent (P1.M8 keys off the `reason` field).

> Note: `trackEvent` already does exactly this `fail()+reset()` on `error` terminals, which is why the
> `error` race sub-case needs no controller reset (it's already `Idle`). Only the `done` sub-case still
> sits in `Aborting` and needs the explicit `fail()+reset()`.

## 4. The fix (additive — T1 preserved when no terminal was forwarded)

A single new boolean field + a branch that runs **only** when the upstream already emitted its terminal:

```typescript
private _upstreamCompleted = false;   // true once the upstream's OWN done/error is forwarded
```

In `run()`'s loop, set it when a terminal is forwarded (`isTerminalEvent(event)`). Then:

- **In the catch**, check `_upstreamCompleted` **FIRST** (before the clean-abort `Aborting` branch):
  - `true` → natural completion won → clear the FM-006 net, `fail("natural-completion-won")`+
    `reset()` if still `Aborting` (the `done` sub-case; the `error` sub-case is already `Idle`),
    trace `proxy.abort.natural-completion-won`, **`return`** (the original terminal was already
    forwarded). NO Capturing, NO freeze, NO synthesized terminal.
  - `false` → fall through to T1's clean-abort branch (`Aborting`→Capturing+freeze) and the
    unexpected-throw synthesis — **byte-for-byte unchanged from T1**.
- **After the natural loop exit**, if `_upstreamCompleted && getState()==="Aborting"`: clear the FM-006 net,
  `fail("natural-completion-won")`+`reset()`, trace. Gating on `Aborting` is load-bearing: a NORMAL
  completion leaves the FSM in `Reasoning`/`Idle` (not `Aborting`), so the block is skipped — no spurious
  "natural-completion-won" trace on an ordinary stream. Covers the "upstream closed naturally instead of
  throwing" sub-case of the `done` race.

**Why this preserves T1 exactly:** every T1 test forwards NO terminal before the abort (`_upstreamCompleted`
stays `false`), so the new branch is skipped and T1's clean-abort / FM-006 / forwarding behavior is
identical. The fix is **purely additive**: a new flag + a new early branch. Confirmed against all 8 T1
tests in `tests/stream-proxy-abort.test.ts` (none of them forward a terminal during the abort window).

## 5. Deterministic test mock (the contract's "done then close, abort concurrent")

T1's `makeAbortableUpstream()` checks `signal.aborted` **before** yielding queued events, so the race
outcome is timing-dependent (non-deterministic). The race test needs a mock that **guarantees** the
terminal is yielded before the abort resolves — modeling EC-007's "the `done` was already in flight":

```typescript
// Phase 1: drain pending events as they arrive (blocks when empty) — does NOT throw on abort here,
//          so a queued `done` is always forwarded before the abort resolves.
// Phase 2: once a terminal is yielded, either THROW the abort error ("throw") or RETURN ("close").
function makeNaturalCompletionRaceMock(afterDone: "throw" | "close") { … }
```

Test flow (both variants):
1. Construct proxy with the race mock.
2. Push `start`/`thinking_start`/`thinking_delta`; `waitFor` Reasoning.
3. `triggerStop()` → Aborting + abort dispatched (the mock is blocking in phase 1; it does not throw yet).
4. Push `done` → phase 1 yields + forwards it; phase 2 then throws (`"throw"`) or returns (`"close"`).
5. Assert: a concurrent consumer drains `output` and the **original `done`** is present; controller ends
   `Idle`; buffer **NOT** frozen (`append` does not throw — no replacement started); `proxy.abort.completed`
   (T1's clean-abort marker) was NOT traced; `proxy.abort.natural-completion-won` WAS traced.

Plus a regression case: a normal full stream (`start`…`done`, **no** `triggerStop`) still forwards
unchanged (the new field/branch must not perturb the transparent path).

## 6. Privacy (Appendix H) & scope

- New diagnostics call `proxy.abort.natural-completion-won` logs `{}` only (no content). The allow-list
  privacy test in `stream-proxy-abort.test.ts` already permits empty `{}`.
- **Scope**: MODIFY `src/provider/proxy.ts` (add `_upstreamCompleted`; edit `run()`'s loop + catch +
  natural-exit; add `isTerminalEvent` to the `"../types"` import). CREATE `tests/stream-proxy-race.test.ts`.
  **Do NOT touch** `controller.ts` (reuse existing `fail`/`reset`), `buffer`, `coordinator`, `decorator`,
  `config`, `types.ts`, or any existing test.
