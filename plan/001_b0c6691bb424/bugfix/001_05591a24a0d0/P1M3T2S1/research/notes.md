# Research Notes — P1.M3.T2.S1: EC-005 / EC-006 end-to-end tests (coordinator path)

## Task scope (the contract, distilled)

Add **end-to-end** tests proving the shortcut is disabled once reasoning ends, driven through the
**`TransitionCoordinator.requestStop()` path** (NOT just the proxy-local `triggerStop()`), asserting:
- `proxy.triggerStop() === false`
- `coordinator.requestStop() === false`
- the upstream `AbortSignal` is NOT aborted
- the mock provider's **replacement call count is 0** (no second request)

Three scenarios: **EC-005** (press after `thinking_end`), **EC-006** (press on first `text_start`),
and a **POSITIVE control** (still reasoning, no leave-condition → `triggerStop() === true`).

## What already exists (DO NOT duplicate — that is T1.S1, COMPLETE)

`tests/stream-proxy-reasoning-ended.test.ts` (P1.M3.T1.S1) already covers the SAME leave-conditions
but at the **UNIT** level:
- Mock = `makeAbortableUpstream()` — a **single-call** iterable (NO replacement queue). Exposes
  `isAborted()` but has NO notion of a replacement call → CANNOT assert "replacement call count is 0".
- Proxy constructed with the **10-arg** form — `coordinator: undefined` (the last arg is omitted).
  So the coordinator's `requestStop()` path is **never exercised**.
- Asserts only `proxy.canInterrupt()` / `proxy.triggerStop()` / `mock.isAborted()`.

**T2.S1 is strictly the end-to-end layer on top of T1.S1**: it MUST (1) wire a coordinator and assert
`coordinator.requestStop()===false`, and (2) use a **two-phase** mock so it can assert the replacement
call count. This is the regression-guard the PRD §2.4 "Areas needing more attention" calls for and that
T1.S1 deliberately deferred ("Do NOT add end-to-end consumer assertions (P1.M3.T2.S1)").

## The fix is LIVE (confirmed against HEAD `src/provider/proxy.ts`)

- Line 179: `private _reasoningEnded = false;`
- Lines 345–346: `canInterrupt()` → `return this._controller.getState() === "Reasoning" && !this._reasoningEnded;`
- Lines 372–373: `triggerStop()` guard → `if (!this.canInterrupt()) return false;`
- Lines 529–539: trackEvent step 3b sets the flag on `thinking_end || isTextEvent || isToolCallEvent`.
- `src/state/controller.ts` is UNCHANGED (flag approach, not FSM extension). ⇒ **T2.S1 is a TEST-ONLY
  change.** No production code may be touched.

## Coordinator wiring pattern (source: tests/stream-proxy-pending-stop.test.ts — the contract's reference)

```ts
const coordinator = new TransitionCoordinator(diag);
const proxy = new StreamProxy(
  makeModel(), {} as never, {} as never, mock.fn, diag, controller, buffer,
  DEFAULT_CONFIG.transitionTimeoutMs, undefined, 2000,   // ← 10th arg
  coordinator,                                            // ← 11th arg (last)
);
coordinator.setActiveProxy(proxy);   // ← REQUIRED: requestStop() reads this.activeProxy
```

Constructor signature (src/provider/proxy.ts:253):
`model, context, options, upstreamStreamFn, diagnostics, controller?, buffer?, abortTimeoutMs,
requestBuilder?, replacementStartupTimeoutMs, coordinator?` (11 params; coordinator is the LAST).

`coordinator.requestStop()` (src/state/coordinator.ts) returns:
- `false` if no active proxy (EC-001).
- `false` if `!proxy.canInterrupt()` — AND records a pending stop only if `proxy.isDelegating()`.
  After reasoning ends we are in `Reasoning` (not `Delegating`) with `_reasoningEnded===true`, so
  `canInterrupt()===false` and `isDelegating()===false` → returns `false` with trace reason
  `"not-reasoning"` (no pending stop recorded, no replacement later). ✓
- `true` only when `proxy.canInterrupt()===true` (still reasoning, flag not set) → calls
  `proxy.triggerStop()`. This is the POSITIVE control path.

## Mock gap analysis — need BOTH `isPrimaryAborted()` AND `calls.length`

| Mock | source | `isAborted`? | replacement count? |
|------|--------|--------------|--------------------|
| `makeAbortableUpstream` | stream-proxy-abort.test.ts (copied by T1.S1) | ✅ `isAborted()` | ❌ single-call |
| `makeReplacementUpstream` | stream-proxy-pending-stop.test.ts | ❌ (closure only) | ✅ `calls.length` |
| `makeScriptedTwoPhaseUpstream` | helpers/invariant-harness.ts | ❌ | ✅ `calls.length` |
| `makeRealisticTwoPhaseMock` | helpers/realistic-mock.ts | ❌ | ✅ `calls` |

**None** exposes both. Resolution: copy `makeReplacementUpstream` from
`tests/stream-proxy-pending-stop.test.ts` verbatim and ADD one accessor:
`isPrimaryAborted: () => !!primarySignal?.aborted`. The closure already captures `primarySignal`
(opts?.signal on the 1st call) — it just isn't exposed. This single addition yields both
`calls.length` (replacement count) and `isPrimaryAborted()` (upstream-abort proof). This mirrors how
T1.S1 copied `makeAbortableUpstream` (not exported) into its own file.

## Baseline test state (npm test, HEAD)

```
393 pass
  2 fail   ← BOTH in Issue-1 (P1.M2.T2) rewrite tests; PASS in isolation; timing flake under full-suite load
395 total
```
The 2 failures (`stream-proxy-rewrite.test.ts` "offset-0 (placeholder partials)...UNCHANGED (guard)"
and `stream-proxy-terminal-rewrite.test.ts` "done.message is merged...") are **Issue-1**, unrelated to
Issue 2. ⇒ T2.S1's gate is "new tests pass + NO NEW failures", NOT "0 fail". Re-run isolates them.

## Test file placement

T1.S1 occupies `tests/stream-proxy-reasoning-ended.test.ts`. T2.S1 must use a **separate** file to
avoid collision and to signal "end-to-end via coordinator". The contract names
`tests/shortcut-lifecycle.test.ts` as the primary candidate. ✓
