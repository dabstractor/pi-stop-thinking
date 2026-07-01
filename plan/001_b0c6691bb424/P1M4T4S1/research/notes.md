# Research Notes — P1.M4.T4.S1: TransitionCoordinator with active proxy delegation

## 1. What exists today (verified by reading source)

### `src/state/coordinator.ts`
- **Stub only**: `// TransitionCoordinator — P1.M4.T4.S1`. This subtask REPLACES the stub with the real
  class. No existing test references it (no `tests/transition-coordinator.test.ts`).

### `src/provider/proxy.ts` — `StreamProxy` (DONE in P1.M4.T2.S1)
- Constructor: `(model, context, options, upstreamStreamFn, diagnostics, controller?, buffer?)`.
  **Does NOT take a coordinator.** The decorator (`src/provider/decorator.ts`) constructs it as
  `new StreamProxy(model, context, options ?? {}, originalStreamSimple, this.diagnostics)`.
- Public surface TODAY:
  - `get output()` — the outbound stream Pi consumes.
  - `get controller()` — the per-request `TransitionController`.
  - `get buffer()` — the per-request `ReasoningBuffer`.
  - `isReasoning(): boolean` — returns `this._controller.getState() === "Reasoning"`. **EXISTS.**
- **MISSING** (the coordinator's contract references these): `canInterrupt()`, `triggerStop()`,
  `isInterrupting()`. Of these, `triggerStop()` is the **upstream ABORT = P1.M5.T1** (not built).
  `canInterrupt()` / `isInterrupting()` are pure read delegates not yet present.

### `src/state/controller.ts` — `TransitionController` (DONE in P1.M3.T1.S1)
- `getState()`, `canInterrupt()` (true ONLY in `Reasoning` — PRD §22.5), `requestStop(): boolean`
  (Reasoning→StopRequested, returns false outside Reasoning — first-press-wins), `fail()`, `reset()`,
  `transition()`, + the named convenience methods. `ALLOWED_TRANSITIONS` exported.
- This is the **single writer** of transition state (PRD §30 / §37).

### `src/index.ts` — factory (DONE in P1.M1.T5.S1)
- Wires `loadConfig()` → `createDiagnostics()` → `createDecorator(config, diagnostics)` →
  `decorator.initialize()` → `session_shutdown` cleanup. **Never-crash** try/catch wrapper.
- Currently constructs **no coordinator**, registers **no ShortcutManager**. The coordinator +
  ShortcutManager wiring is deferred (see §3).

### `src/diagnostics/index.ts`, `src/config/index.ts`
- `Diagnostics` interface: `trace/debug/info/warn/error(event, fields?)`. Privacy allow-list
  (provider/model/transitionId/timing/counts/state-transitions/error-categories) — NO content.
- Every module takes `Diagnostics` in its constructor (controller, proxy, buffer, decorator).
  → **Coordinator constructor must take `Diagnostics`** (codebase convention).
- `DEFAULT_CONFIG.shortcut === "ctrl+."`.

### `src/shortcut/index.ts` — ShortcutManager (PRP P1.M4.T3.S1, parallel sibling)
- Exports `StopRequestCoordinator` interface: `{ requestStop(): boolean; alreadyInterrupting(): boolean }`.
- `class ShortcutManager(diagnostics)` with `register(pi, shortcut, coordinator: StopRequestCoordinator)`.
  Handler: `if (coordinator.alreadyInterrupting()) return; coordinator.requestStop()`; wrapped in
  try/catch (never-crash).
- **Key precedent**: ShortcutManager depends on a *structural interface* (`StopRequestCoordinator`),
  NOT the concrete coordinator, so it compiles BEFORE the real coordinator lands. **This subtask
  MUST mirror that pattern** for the coordinator→proxy direction (see §2).

### Test conventions (verified: `tests/reasoning-buffer.test.ts`, `tests/stream-proxy-detection.test.ts`)
- `import { describe, test, expect } from "bun:test"`.
- `makeCaptureDiag(): { diag: Diagnostics; events: Captured[] }` — the shared capturing-logger stub.
- Fakes built as plain objects cast to the structural interface (`as ActiveProxy`).
- `tsconfig.json` excludes `tests` (`rootDir: ./src`) → **tests are NOT typechecked by `tsc --noEmit`**;
  only `src/**` is. Implication: the coordinator module in `src/state/coordinator.ts` MUST compile
  standalone (0 diagnostics) — it cannot import a concrete StreamProxy and call a not-yet-existing
  `triggerStop()`.

## 2. The core design decision (dependency inversion — ShortcutManager precedent)

The work-item contract is explicit:
- `requestStop()`: if `activeProxy` exists **and** `activeProxy.canInterrupt()` → call
  `activeProxy.triggerStop()` and return `true`; else `false`.
- `isReasoning()`: `activeProxy?.isReasoning() ?? false`.
- `alreadyInterrupting()`: `activeProxy?.isInterrupting() ?? false`.
- "The coordinator does NOT own transition state — it queries the proxy which queries its
  TransitionController."

**Problem**: `StreamProxy` has `isReasoning()` but NOT `canInterrupt()` / `triggerStop()` /
`isInterrupting()`. `triggerStop()` is the upstream abort → **P1.M5** (not built). If the coordinator
held the concrete `StreamProxy` type and called `.triggerStop()`, `src/state/coordinator.ts` would NOT
compile → the `tsc --noEmit` gate (which includes `src/**`) fails.

**Resolution** (identical seam to ShortcutManager's `StopRequestCoordinator`): the coordinator module
defines a **structural interface `ActiveProxy`** with the four proxy-facing methods it delegates to. The
coordinator holds `private activeProxy: ActiveProxy | undefined` — it does NOT import the concrete
`StreamProxy`. The coordinator compiles standalone today. The concrete `StreamProxy` becomes
structurally assignable to `ActiveProxy` once:
1. `canInterrupt()` + `isInterrupting()` are added to the proxy as thin read-only delegates
   (`canInterrupt → this._controller.canInterrupt()`; `isInterrupting → state ∈
   {StopRequested,Aborting,Capturing,Restarting,Splicing,Answering}`), AND
2. `triggerStop()` is added by **P1.M5** (the real upstream abort).

→ **`TransitionCoordinator` is structurally assignable to ShortcutManager's `StopRequestCoordinator`**
(both expose `requestStop(): boolean` + `alreadyInterrupting(): boolean`). No adapter needed.

## 3. Scope boundary — factory wiring is OUT OF SCOPE (deferred to P1.M5)

Full coordinator wiring (construct it in the factory, pass it to the decorator, have the decorator call
`coordinator.setActiveProxy(proxy)` on each eligible stream + clear on stream end, and
`shortcutManager.register(pi, shortcut, coordinator)`) requires the concrete `StreamProxy` to satisfy
`ActiveProxy` — i.e. it needs `triggerStop()` (P1.M5). Any wiring line that passes a `StreamProxy` where
`ActiveProxy` is expected would NOT compile today and would break the `src/` typecheck gate.

Therefore (mirroring the ShortcutManager PRP, which deferred its own factory wiring to T4): **this
subtask implements ONLY `src/state/coordinator.ts` + `tests/transition-coordinator.test.ts`.** The
factory wiring lands in **P1.M5** (when `triggerStop()` exists), using the exact snippet documented in
the PRP's "Integration Points". This keeps the typecheck/build gate green and avoids touching
`src/index.ts` / `src/provider/decorator.ts` / `src/provider/proxy.ts`.

## 4. Method semantics (for tests)

| Method | Behavior | PRD anchor |
|---|---|---|
| `setActiveProxy(proxy \| undefined)` | set/clear the held ref; trace `coordinator.set-active` / `coordinator.clear-active` | §13.3 single-writer; coordinator holds only a *reference* |
| `isReasoning()` | `activeProxy?.isReasoning() ?? false` | §22.5 |
| `alreadyInterrupting()` | `activeProxy?.isInterrupting() ?? false` | §24.3 / INV-004 |
| `requestStop()` | no proxy → false (EC-001); `!canInterrupt()` → false (§22.5/FM-001); else `triggerStop()`→true. `triggerStop` fault swallowed + logged → false (never-crash) | §24.2/§24.3, §51 Stop Request |

First-press-wins (§24.3) emerges naturally: `canInterrupt()` is true only in `Reasoning`; once
`triggerStop()` fires the FSM leaves `Reasoning`, so a second `requestStop()` sees `canInterrupt()==false`
→ false. The coordinator holds **zero** dedup state (the proxy/controller is the authority).

## 5. Validation baseline (captured this run)
- `npx bun run typecheck` → clean (0 diagnostics).
- `npx bun run build` → exit 0.
- `npx bun test` → **143 pass / 0 fail / 12 files**. The new `tests/transition-coordinator.test.ts`
  is the 13th file; target = 143 + new tests, all green, existing 143 unchanged.
