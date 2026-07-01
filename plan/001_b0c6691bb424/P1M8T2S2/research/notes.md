# Research Notes — P1.M8.T2.S2 (Provider Failure Modes & Recovery Hierarchy)

## 1. Scope Triage (codebase audit of `src/provider/proxy.ts`)

The full recovery MACHINERY already exists from P1.M7.T3.S1 ("Full Transition Algorithm
Integration") + P1.M5.T2 (abort-race). Every recovery path funnels through the idempotent
`_terminate(success, reason)` (→ FSM fail→Idle + `_clearAbortTimeout`/`_clearReplacementTimeout` +
buffer reset + `_coordinator?.setActiveProxy(undefined)`), satisfying PRD §54 "No recovery path may
leave allocated resources orphaned" and the contract's "All recovery paths must call cleanup() and
coordinator.setActiveProxy(undefined)". So this subtask is: **one NEW behavior (FM-013), one MINOR
addition (FM-015 non-terminal trace), and lock-in TESTS for the rest.**

| FM  | Contract recovery                                   | Existing impl (proxy.ts) | This task |
|-----|-----------------------------------------------------|--------------------------|-----------|
| 006 | timeout → Failed, preserve normal stream            | `_startAbortTimeout`→`fail("abort-timeout")` L322-329 | TEST (no test asserts stream preserved) |
| 007 | replacement rejected → forward error, cleanup       | `_launchReplacement` catch L796-804 | TEST (no dedicated test) |
| 008 | auth failure → surface auth error, cleanup          | same catch (`makeErrorAssistantMessage(model, err.message)`) | TEST |
| 009 | network disconnect before interruption → delegate    | `run()` catch L655-671 + `trackEvent` error L478-481 | TEST (throw path tested in stream-proxy.test.ts; error-EVENT path untested) |
| 010 | network disconnect during interruption → propagate   | `_launchReplacement` catch | TEST |
| 011 | replacement terminates immediately → forward done    | `_launchReplacement` loop L763-770 + EC-018 guard L774-782 | TEST (no immediate-done test) |
| 012 | replacement never produces first event → timeout     | `_startReplacementTimeout` L813-822 | TEST EXISTS (enhance: assert error forwarded + cleanup) |
| 013 | malformed event → warn, forward best-effort, else Failed | **NONE** | **NEW IMPL + TEST** |
| 014 | duplicate completion → suppress                      | `_emit` `_messageEndEmitted` dedup L534/561 | covered (filtering test); add lock-in |
| 015 | upstream events after authority transfer → discard   | structurally prevented (primary loop dead post-abort) + terminal dedup trace | MINOR (add non-terminal-stray trace) + TEST |

**Conclusion:** NO behavior FIXES needed (unlike S1's EC-017 suppress→forward). Only FM-013 is new;
FM-015 needs a 3-line trace; the rest are TEST-ONLY lock-ins.

## 2. FM-013 design (the new work)

PRD §52 Validation Rules: "Unknown events: pass through unchanged. Malformed events: Log
diagnostics. Attempt recovery. Terminate only if downstream integrity cannot be preserved."
EC-020: "Malformed Thinking Event → log diagnostics, continue if recoverable, else terminate."

- **Unknown type** (not in any family) → already pass through (`_emit` else-branch `push`). UNCHANGED.
- **Malformed recognized type** (known type, missing critical payload):
  - Non-terminal (`*_delta` whose `delta` is not a string) → RECOVERABLE: `warn` + forward best-effort.
  - Terminal (`done` w/o `message` / `error` w/o `error`) → FATAL: a terminal that can't carry a
    valid completion would corrupt Pi's runtime → synthesize ONE clean error terminal + `_terminate
    (false, "malformed-terminal")` (PRD §54 L4 / §52 "terminate only if downstream integrity cannot
    be preserved").

**Placement:** a pure `isMalformedEvent(event): boolean` in `src/types.ts` (testable in
`types.test.ts`, table-driven like the existing guards) + handling at the **TOP of `_emit`** (the
single forward chokepoint for BOTH primary and replacement paths — `run()` and
`_launchReplacement` both call `_emit`). `trackEvent` runs first on the primary path but is
try/catch-guarded (never breaks forwarding — ADR-005), so validating in `_emit` is sufficient.
`_emit` needs `model` for `makeErrorAssistantMessage` → store `private readonly _model` from the
constructor's existing `model` param (S1 does NOT touch the constructor).

`isMalformedEvent` discriminated switch:
```ts
switch (event.type) {
  case "done": return !(event).message;          // done must carry an AssistantMessage
  case "error": return !(event).error;           // error must carry its AssistantMessage
  case "thinking_delta": case "text_delta": case "toolcall_delta":
    return typeof (event).delta !== "string";    // delta must be a string
  default: return false;                         // start / *_start / *_end / unknown → not malformed
}
```
(Access payload via the already-narrowed union members; `*_start`/`*_end`/`start` are recoverable by
default → false → pass through.)

## 3. FM-015 design (minor addition)

Architecture structurally prevents PRIMARY events after authority transfer: `triggerStop()` aborts
`_internalAbort` → the primary iterator throws → `run()`'s catch → `_launchReplacement`; the primary
`for await` loop is dead before any replacement event. So FM-015's realistic scenario is REPLACEMENT
events arriving after the replacement's own terminal. Terminals after completion are already deduped
with `proxy.splice.duplicate-terminal` (L561). The GAP: non-terminal strays after completion are
`push`ed (no-op, since `output` is complete) WITHOUT a trace. **Fix:** a top-of-`_emit` guard, gated
on `!isTerminalEvent` so it does NOT shadow the per-phase terminal dedup:
```ts
if (this._messageEndEmitted && !isTerminalEvent(event)) {
  this.diagnostics.trace("proxy.splice.discard-after-completion", {});
  return;
}
```

## 4. Parallel-task boundary with S1 (P1.M8.T2.S1) — BOTH edit `proxy.ts`

S1 edits: `trackEvent` (pending-stop consume/clear) + `_emit` **splicing branch** (delete
`thinking_*` skip → EC-017 forward) + `coordinator.ts` + 4 test files.
S2 edits: `_emit` **TOP** (FM-013 + FM-015 guards, before authority `if`) + constructor (`_model`)
+ `types.ts` + new test file + `types.test.ts`.

**Conflict analysis:** the `_emit` edits are in DISTINCT regions (S2 top, S1 inside splicing branch)
→ clean 3-way auto-merge. No shared constructor/types.ts/test-file overlap. Zero file-level conflict.
The orchestrator/implementer should be aware `_emit` is the one merged method.

## 5. Test mocks needed (new `tests/stream-proxy-failure-modes.test.ts`)

Reuse `makeCaptureDiag`/`makeModel`/`ev`/`waitFor`/`DONE_MESSAGE`/`ERROR_MESSAGE` verbatim from
`stream-proxy-replacement.test.ts`. New/variant mocks:
- `makeIgnoreAbortUpstream()` — yields from a queue, NEVER throws on signal (FM-006); test pushes
  events incl. a final `done` AFTER the timeout to prove "normal stream preserved".
- Replacement-throws-before-first-event (FM-007/008): 2nd-call iterable throws synchronously / before
  first yield.
- Replacement-throws-mid-stream (FM-010): yields a text event then throws.
- Replacement-immediate-done (FM-011): yields only `{type:"done", message}`.
- Replacement-stray-after-done (FM-015): yields done then a text_delta.
- Malformed events (FM-013): inject `{type:"done"}` (no message), `{type:"error"}` (no error),
  `{type:"text_delta"}` (no delta) on both primary and replacement paths.

## 6. Build/test commands (verified)
- `npx bun run typecheck` (tsc --noEmit, 0 diag)
- `npx bun run build` (tsc → dist/, exit 0)
- `npx bun test` (all green). Per-file: `npx bun test tests/<file>.test.ts`.
