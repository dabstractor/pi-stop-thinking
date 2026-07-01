# Research Notes — P1.M3.T1.S1: `_reasoningEnded` flag + gate `canInterrupt()`/`triggerStop()`

> Issue 2 (MAJOR): the shortcut stays armed during the answer phase. Pressing Ctrl+. AFTER reasoning
> ends aborts the in-progress answer and launches a fresh replacement. This subtask is the minimal
> flag fix (NOT the FSM-extension fix).

## 1. Root cause (confirmed by reading src/)

- `src/state/controller.ts` `ALLOWED_TRANSITIONS` (lines 41–53): `Reasoning`'s only exits are
  `StopRequested` and `Failed`. There is **NO normal `Reasoning → Answering` (or `→ Completed`)
  exit**. So a non-interrupted stream leaves the controller stuck in `Reasoning` for the ENTIRE
  answer phase.
- `src/provider/proxy.ts` `trackEvent()` (lines ~543–600): the detection steps do nothing on
  `thinking_end` / `text_start` / `toolcall_start`. The existing NOTE block (lines ~590–595) even
  admits this: *"§16 defines no normal Reasoning exit, so thinking_end / text_start /
  toolcall_start perform NO transition here."*
- `src/provider/proxy.ts` `canInterrupt()` (lines 327–329): `return this._controller.canInterrupt();`
  → pure delegate to the FSM → returns `true` whenever `state === "Reasoning"` → stays `true`
  throughout the answer.
- `src/provider/proxy.ts` `triggerStop()` (line 356): guard is
  `if (!this._controller.canInterrupt()) return false;` → uses the CONTROLLER check, not the proxy
  gate → so even if `canInterrupt()` were fixed, the abort entry point would still bypass it.

## 2. The fix (exact, from the work-item contract)

A proxy-level boolean flag, set in `trackEvent()` on the PRD §22.4 leave-conditions. Leaves the FSM
**completely untouched**.

- **(a)** New field: `private _reasoningEnded = false;` (place among the other private `_` flags).
- **(b)** New detection step in `trackEvent()`, **AFTER step 3** (the `thinking_delta` accumulation
  block) and **BEFORE step 4** (the terminal handling `if (event.type === "error")`):
  ```ts
  if (
    this._controller.getState() === "Reasoning" &&
    (event.type === "thinking_end" || isTextEvent(event) || isToolCallEvent(event))
  ) {
    this._reasoningEnded = true;
  }
  ```
  - Covers all three §22.4 leave-conditions: `thinking_end` (EC-005), first answer token `text_start`
    (EC-006), and `toolcall_start` (tool-call-first models). Setting a boolean multiple times is
    idempotent, so catching all three in one block is harmless.
  - `trackEvent()` runs **ONLY in the primary loop** (run()'s for-await, BEFORE `_emit`).
    Replacement events NEVER run `trackEvent` (the buffer is frozen during splicing) — so the flag
    correctly applies solely to the primary reasoning phase. No risk of the replacement re-arming it.
- **(c)** `canInterrupt()` (lines 328–329):
  `return this._controller.getState() === "Reasoning" && !this._reasoningEnded;`
- **(d)** `triggerStop()` guard (line 356): `if (!this.canInterrupt()) return false;`
  (switch from `this._controller.canInterrupt()` to `this.canInterrupt()` so the proxy-level flag
  gate is enforced at the abort entry point).
- **(e)** JSDoc updates on `canInterrupt()` and `trackEvent()`.

## 3. CRITICAL "do not break" constraints

- **`tests/stream-proxy-lifecycle.test.ts` line 441**:
  `expect(controller.getState()).toBe("Reasoning");` — asserts the FSM stays in `Reasoning` on a
  normal (non-interrupted) completion. The flag fix does NOT touch controller state, so this passes.
  **The FSM-extension alternative WOULD break this** — that is why the flag approach is mandated.
- **`tests/stream-proxy-abort.test.ts` "canInterrupt()/isInterrupting() delegation" (lines 244–260)**:
  asserts `proxy.canInterrupt() === true` while in Reasoning BEFORE any leave-condition event, and
  `=== false` when Idle / Aborting. The fix preserves this: during Reasoning with no
  `thinking_end`/`text_start`/`toolcall_start` pushed, `_reasoningEnded` is `false` → `canInterrupt()`
  is still `true`. (Verified: NO existing test asserts `canInterrupt()===true` AFTER a leave-condition.)
- **`isReasoning()` is NOT changed** (line ~394: pure FSM delegate). system_context.md: *"`isReasoning()`
  continues to reflect FSM state (acceptable — it's for telemetry, not shortcut gating)."* Do NOT add
  `&& !_reasoningEnded` to `isReasoning()` — that is out of scope and would change telemetry semantics.
- **The controller FSM is UNCHANGED.** `src/state/controller.ts` is read-only for this subtask.
  `canInterrupt()` on the CONTROLLER keeps its `state === "Reasoning"` body (used by
  `transition-controller.test.ts` + the coordinator). Only the PROXY's `canInterrupt()` changes.

## 4. Type guards already imported (no import change needed)

`src/provider/proxy.ts` line 64 already imports:
`isTerminalEvent, isThinkingEvent, isTextEvent, isToolCallEvent, isMalformedEvent`.
So `isTextEvent` and `isToolCallEvent` are available for the flag condition with NO new imports.
`event.type === "thinking_end"` is a direct string compare (narrower than `isThinkingEvent`, which
would also catch `thinking_start`/`thinking_delta` — wrong; we want ONLY `thinking_end`).

## 5. Test design — uses the `makeAbortableUpstream` mock pattern from stream-proxy-abort.test.ts

The contract mandates: *"Use the existing mock patterns from `tests/stream-proxy-abort.test.ts`
(scripted events)."* That file defines `makeAbortableUpstream()` locally (NOT exported from the
harness). It exposes `push(e)` + `isAborted()` — the `isAborted()` accessor is the cleanest way to
prove "no abort happened". The harness (`tests/helpers/invariant-harness.ts`) exports
`makeCaptureDiag`, `makeModel`, `ev`, `waitFor`, `DONE_MESSAGE` — import those; copy
`makeAbortableUpstream` into the new test file (matches how stream-proxy-abort.test.ts self-contains
its own doubles).

**Timing discipline (the make-or-break detail):** `trackEvent()` runs INSIDE run()'s async for-await,
which processes events on the microtask queue. After pushing `thinking_end`, the test CANNOT assert
immediately — it must wait until run() has processed that event. The reliable signal is the FORWARDED
event: `trackEvent(event)` runs BEFORE `_emit(event)` (line ~702), so once `thinking_end` appears in
the drained `proxy.output`, `trackEvent` has already run on it → the flag is set. Pattern:
- start a consumer draining `proxy.output` into `seen[]`;
- push `start → thinking_start → thinking_delta`;
- `await waitFor(() => proxy.isReasoning())`;
- assert `proxy.canInterrupt() === true` (sanity: armed during reasoning);
- push `thinking_end`;
- `await waitFor(() => seen.includes("thinking_end"))` ← proves the flag is set;
- assert `proxy.canInterrupt() === false` ← THE FIX;
- assert `proxy.triggerStop() === false` ← THE FIX;
- assert `mock.isAborted() === false` + no `proxy.abort.completed` trace + no replacement call.

EC-006 case (first answer token): same flow but push `text_start` instead of `thinking_end`, wait for
`seen.includes("text_start")`, assert the same three.

## 6. Baseline

`npm test` (bun): **391 pass / 0 fail** at HEAD. (Note: `stream-proxy-rewrite.test.ts` main case is
timing-sensitive against the realistic mock and has been observed to flake to 1 fail on rare runs;
re-run if a single timing flake appears — it is NOT related to this subtask.) This subtask adds the
new test file; expected after: 391 + N new, 0 fail.

## 7. Scope cohesion (sibling work items)

- **P1.M3.T2.S1** (next): end-to-end EC-005/EC-006 tests via the consumer harness. This S1 provides
  the unit-level flag test + the gating behavior; T2.S1 layers the consumer assembly on top.
- **P1.M4.T1.S1** (Issue 3): coordinator guarded-clear. Independent; no overlap with the flag.
- This S1 touches ONLY `src/provider/proxy.ts` + one new test file. `src/state/*`, `src/types.ts`,
  `src/buffer/*`, all helpers, and every other src/ file are read-only.
