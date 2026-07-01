# Research — P1.M3.T1.S1: TransitionController FSM Core

## 1. PRD §16 State Transition Table → method mapping (verified against item contract + PRD)

The PRD §16 table + the "Any → Failed" row encode the complete adjacency. The item contract lists the
**named convenience methods**; the two entry transitions (Idle→Delegating, Delegating→Reasoning) are
driven via the generic `transition(next)` by the consumer (StreamProxy, P1.M4) — they are deliberately
NOT given dedicated convenience methods (the item's method list is closed).

```
Current        Event                  Next          Method (this subtask)            Kind
─────────────  ─────────────────────  ───────────   ───────────────────────────────  ──────────────
Idle           Stream begins          Delegating    transition("Delegating")         generic (entry)
Delegating     First thinking event   Reasoning     transition("Reasoning")          generic (entry)
Reasoning      Shortcut               StopRequested requestStop() → true             convenience (bool)
StopRequested  Abort dispatched       Aborting      beginAbort()                     convenience
Aborting       Upstream closed        Capturing     completeAbort()                  convenience
Capturing      Replacement issued     Restarting    beginReplacement()               convenience
Restarting     First replacement tok  Splicing      beginSplice()                    convenience
Splicing       First answer token     Answering     beginAnswering()                 convenience
Answering      message_end            Completed     complete()                       convenience
Completed      Cleanup                Idle          reset()                          convenience
Failed         Cleanup                Idle          reset()                          convenience
Any            Fatal error            Failed        fail(reason)                     convenience
```

### ALLOWED_TRANSITIONS adjacency (builds the Map; "Any→Failed" = Failed in every state's set)

```
Idle        → { Delegating, Failed }
Delegating  → { Reasoning,  Failed }
Reasoning   → { StopRequested, Failed }
StopRequested → { Aborting,  Failed }
Aborting    → { Capturing,  Failed }
Capturing   → { Restarting, Failed }
Restarting  → { Splicing,   Failed }
Splicing    → { Answering,  Failed }
Answering   → { Completed,  Failed }
Completed   → { Idle,       Failed }
Failed      → { Idle }                          # only exit from Failed is Idle
```
Note: "Any→Failed" means Failed is reachable from every state EXCEPT Failed itself (Failed→Idle is the
only Failed exit). `fail(reason)` therefore ALWAYS succeeds (no throw), unlike the other methods.

## 2. Method semantics (resolved ambiguities)

- **requestStop()** is the ONLY method returning `boolean` (false when `state !== "Reasoning"`); all
  other convenience methods `void` and THROW on illegal state (they delegate to `transition()`).
- **canInterrupt()** is a pure read (`state === "Reasoning"`); never throws, never logs.
- **fail(reason)** always succeeds (Any→Failed). It should log the reason at `error` level. The
  `reason` string MUST be an error CATEGORY (e.g. "timeout", "abort-failed"), never user/prompt/reasoning
  content — enforced by caller discipline (controller never sees user content). Privacy allow-list
  (Appendix H) explicitly permits "State transitions" + "Error categories".
- **reset()** = transition("Idle"); legal ONLY from Completed or Failed (per table). From any other
  state it THROWS (illegal). In practice reset() is always called post-Completed/post-Failed.
- **transition(next)**: generic escape hatch. Validates `next ∈ ALLOWED_TRANSITIONS[state]`; on miss,
  logs `warn` (consistent with proxy.ts "upstream-threw" defensive level) and throws Error citing PRD §16.
  On success sets state + logs `trace("transition.state-change", { from, to })`.

## 3. SCOPE BOUNDARY (critical — do NOT over-build)

This subtask is a **PURE FSM**: state + ALLOWED_TRANSITIONS + transition() + getState() +
convenience methods + diagnostics trace. It does NOT (per module_contracts.md, the TransitionController
"Owns: Current state, abort controller, transition token" — but those LATER pieces belong to P1.M5):
- ❌ NO AbortController instance / NO actual upstream abort — that is P1.M5.T1.S1.
- ❌ NO transition token generation — that is P1.M5.
- ❌ NO actual replacement-request invocation — that is P1.M6.
- ❌ NO actual stream splicing — that is P1.M7.
- The convenience methods (beginAbort, completeAbort, beginReplacement, beginSplice, beginAnswering)
  ONLY CHANGE STATE (validate + transition + log). They are state-machine steps, not side-effecting ops.
- `fail(reason)` records the failure-category reason + moves to Failed; it does NOT perform recovery.

## 4. Codebase conventions (verified from landed modules — MUST follow)

### Source-file conventions (src/diagnostics/index.ts, src/provider/proxy.ts, src/config/index.ts)
- **Mode-A JSDoc**: every module has a top banner (Responsibility / Ownership / Lifecycle / Invariants /
  Failure modes / "Consumed by:"). Every exported symbol has a JSDoc block with Preconditions /
  Postconditions / Side effects. The item DOCS spec: "Add JSDoc referencing PRD §16 transition table for
  each transition method."
- **Immutability**: config uses `Object.freeze`; diagnostics returns `Object.freeze`. ALLOWED_TRANSITIONS
  must be typed `ReadonlyMap<TransitionState, ReadonlySet<TransitionState>>` (immutable surface).
- **Privacy**: never log user content. State transitions + error categories are allow-listed (Appendix H).
- **PRD citations inline**: JSDoc references "PRD §16", "PRD §17", "PRD Appendix F" etc. verbatim.
- **Discriminated union, NOT enum/booleans** (PRD Appendix F): TransitionState is already a string-literal
  union in src/types.ts (P1.M2.T1.S1) — switch on it; do NOT introduce an enum.

### Type-only imports (isolatedModules + strict — proxy.ts, types.ts pattern)
```typescript
import type { TransitionState } from "../types";          // TYPE from P1.M2.T1.S1
import type { Diagnostics } from "../diagnostics";         // TYPE from P1.M1.T3.S1
// No VALUE imports needed (no runtime deps) → all imports are `import type`.
```

### Test conventions (tests/diagnostics.test.ts, tests/stream-proxy.test.ts, tests/types.test.ts)
- `import { describe, test, expect } from "bun:test";`
- Flat `tests/` layout; test file named after the CLASS when the class name differs from the file
  (`src/provider/proxy.ts` → `tests/stream-proxy.test.ts`). So `src/state/controller.ts`
  (TransitionController) → **`tests/transition-controller.test.ts`**.
- Table-driven tests (types.test.ts), capture-sink for diagnostics (diagnostics.test.ts).
- `tests/` is EXCLUDED from tsc build (tsconfig exclude) → validated ONLY by `npx bun test`.
- Diagnostics capture pattern (from diagnostics.test.ts) — adapt for trace recording:
```typescript
function captureDiagnostics() {
  const traces: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  return {
    traces,
    diag: { trace: (e, f) => traces.push({ event: e, fields: f }),
            debug(){}, info(){}, warn(){}, error(){} } as Diagnostics,
  };
}
```

### Build/test commands (verified — bun/tsc are local devDeps NOT on PATH)
- `npx bun run typecheck` → `tsc --noEmit` (checks src/ only; tests/ excluded). Baseline: exit 0.
- `npx bun run build` → `tsc` (emits dist/; src/state/controller.d.ts|js will appear).
- `npx bun test` → runs every `*.test.ts` recursively.

## 5. Input contracts (assume DONE — these are the INPUTS, do not modify)

- **TransitionState** (`src/types.ts`, P1.M2.T1.S1): string-literal union of 11 states
  ("Idle"|"Delegating"|"Reasoning"|"StopRequested"|"Aborting"|"Capturing"|"Restarting"|"Splicing"|
  "Answering"|"Completed"|"Failed"). Import via `import type { TransitionState } from "../types"`.
- **Diagnostics** (`src/diagnostics/index.ts`, P1.M1.T3.S1): frozen interface with
  `trace/debug/info/warn/error(event: string, fields?: Record<string, unknown>): void`.
  Import via `import type { Diagnostics } from "../diagnostics"`.

## 6. Future consumers (design the interface so these compose — do NOT implement them)

- **StreamProxy** (P1.M4 reasoning detection): calls `transition("Delegating")` on stream begin,
  `transition("Reasoning")` on first thinking event, `requestStop()` on shortcut, then the abort/splice
  chain. It owns ONE TransitionController per request.
- **TransitionCoordinator** (P1.M4.T4): bridges ShortcutManager → active proxy's controller; calls
  `canInterrupt()` + `requestStop()`.
- The generic `transition()` is the contract's escape hatch for the entry transitions + any future state
  the named methods don't cover.
