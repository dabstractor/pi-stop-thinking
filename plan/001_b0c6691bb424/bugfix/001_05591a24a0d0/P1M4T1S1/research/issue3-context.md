# Research Note — P1.M4.T1.S1 (Issue 3 Overlap Guard)

## Root cause (verified in source)
- `src/provider/proxy.ts` line 487 (inside `_terminate()`, the resource-release section):
  `this._coordinator?.setActiveProxy(undefined);` — UNCONDITIONAL clear.
- `src/state/coordinator.ts`: `private activeProxy: ActiveProxy | undefined` (single slot) +
  `private pendingStop = false`. `setActiveProxy()` clears both fields unconditionally.
- Overlap scenario: A active → `setActiveProxy(B)` overwrites → A._terminate() clears the slot → B
  loses shortcut coverage even though B is still reasoning.

## Fix (guarded clear)
1. coordinator.ts: add `clearActiveProxy(proxy: ActiveProxy)` — clears ONLY when
   `this.activeProxy === proxy` (resets pendingStop only on actual clear; trace `coordinator.clear-active`
   only on actual clear).
2. proxy.ts line 487: replace `setActiveProxy(undefined)` → `clearActiveProxy(this)`.
3. `StreamProxy` is structurally assignable to `ActiveProxy` (has isReasoning/canInterrupt/triggerStop/
   isInterrupting/isDelegating) → passing `this` type-checks.

## Observability decision
Do NOT expose the private `activeProxy` field. Test via observable behavior:
- "still active" → `requestStop()` routes to the surviving proxy (returns true, calls its triggerStop).
- "cleared" → `requestStop()` returns false (reason `no-active-proxy`).
- pendingStop survival → `consumePendingStop()`.
(The contract permits a `get activeProxy()` getter as an alternative — behavioral is preferred to keep
the public API minimal and matches the existing test file's philosophy.)

## Trace-name reuse gotcha
`setActiveProxy(undefined)` ALSO traces `coordinator.clear-active`. New tests that COUNT that trace must
NOT also call `setActiveProxy(undefined)` (use `clearActiveProxy` exclusively, or filter precisely).

## Test infra (reuse, do not reinvent)
- `tests/transition-coordinator.test.ts` already has `makeCaptureDiag()` and `makeFakeProxy()` —
  `makeFakeProxy({ canInterrupt, delegating, interrupting, reasoning, triggerThrows })` returns
  `{ proxy, triggerStopCalls }`. Import `ActiveProxy` type from the coordinator module.
- Runner: `bun:test` (`describe`, `test`, `expect`).

## Validation commands (verified from package.json)
- Single file: `bun test tests/transition-coordinator.test.ts`
- Full suite: `bun test`
- Type check: `npm run typecheck` (== `tsc --noEmit`)
- Build: `npm run build` (== `tsc`)
