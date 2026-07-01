# PRP — P1.M4.T4.S1: TransitionCoordinator with active proxy delegation (`src/state/coordinator.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M4.T4.S1 (Phase 3 Reasoning Detection, 2 pts) — implement the **TransitionCoordinator**:
> the thin bridge that lets the **`ShortcutManager`** (running in `ExtensionContext` scope) raise a stop
> request against the **`StreamProxy`** that lives inside `streamSimple`. PRD §37 Concurrency / Ownership
> Rules: *each module owns its state*; the coordinator is **NOT** a state owner — it holds a **reference
> to the active proxy** and **delegates** (PRD §13.3: the state machine — here reached *through the proxy*
> — is the single writer). Per **INV-004** at most one interruption exists per logical assistant response.
> **Work-item contract (verbatim logic)**: `requestStop()` → *if `activeProxy` exists and
> `activeProxy.canInterrupt()` → call `activeProxy.triggerStop()` and return `true`; otherwise `false`*;
> `isReasoning()` → `activeProxy?.isReasoning() ?? false`; `alreadyInterrupting()` →
> `activeProxy?.isInterrupting() ?? false`; `setActiveProxy(proxy | undefined)` (called by the decorator
> wrapper when a proxy starts/ends). **"The coordinator does NOT own transition state — it queries the
> proxy which queries its TransitionController."**
> **Builds on** (DONE & immutable — do NOT modify): `TransitionController` from **P1.M3.T1.S1**
> (`src/state/controller.ts`), `StreamProxy` from **P1.M4.T2.S1** (`src/provider/proxy.ts` — exposes
> `isReasoning()` + `controller`), `Diagnostics` from **P1.M1.T3.S1**. **Consumes by contract** the proxy's
> reasoning/abort surface via a structural interface (`ActiveProxy` — see Scope Boundary). **Consumed by**:
> `ShortcutManager` (**P1.M4.T3.S1**, parallel) depends on `StopRequestCoordinator` = `{ requestStop():
> boolean; alreadyInterrupting(): boolean }` — the coordinator satisfies it **structurally** (no adapter);
> the decorator + factory wiring (P1.M2.T3 / P1.M1.T5) consumes it in **P1.M5**.

---

## Goal

**Feature Goal**: Implement `TransitionCoordinator` — a stateless **delegator** (PRD §13.3/§37) that holds a
single optional reference to the **active proxy** and forwards three queries + one action to it. The
coordinator owns **NO** transition state, **NO** dedup/idempotency state, **NO** buffers, **NO** streams —
only the `activeProxy` reference (PRD §37: "No mutable state has multiple owners"; the proxy/controller
remain the single writers). It is the shared bridge between the shortcut handler (ExtensionContext scope)
and the proxy (inside `streamSimple`) — exactly one active proxy per logical assistant response (INV-004).

**Deliverable** (ONE source file REWRITTEN from its current 1-line stub + ONE test file CREATED; NO other
files change — see Scope Boundary):
- `src/state/coordinator.ts` — **REWRITE** (currently `// TransitionCoordinator — P1.M4.T4.S1`): exports
  the **`ActiveProxy`** structural interface (the coordinator's dependency-inversion seam to the proxy —
  `isReasoning()`/`canInterrupt()`/`triggerStop()`/`isInterrupting()`) and **`class
  TransitionCoordinator(diagnostics)`** with `private activeProxy: ActiveProxy | undefined = undefined` +
  `setActiveProxy(proxy | undefined)` + `requestStop(): boolean` + `isReasoning(): boolean` +
  `alreadyInterrupting(): boolean` + Mode-A JSDoc citing PRD §13.3/§37/§24/§22.5/INV-004/§51.
- `tests/transition-coordinator.test.ts` — **NEW** `bun:test` suite: a controllable **fake `ActiveProxy`**
  (settable `reasoning`/`canInterrupt`/`interrupting` flags + a `triggerStop` whose call count is asserted
  and which can be made to throw) + a capturing `Diagnostics` stub, proving (1) **no active proxy**
  (`undefined`) → `requestStop()`/`isReasoning()`/`alreadyInterrupting()` all `false`, `triggerStop` never
  called (EC-001 shortcut-before-stream); (2) `isReasoning`/`alreadyInterrupting` delegate to the proxy
  (true when the flag is set, false when cleared to `undefined`); (3) **happy path**: `canInterrupt()==true`
  → `requestStop()` returns `true` and `triggerStop` is called exactly once; (4) **outside Reasoning
  (§22.5/FM-001)**: `canInterrupt()==false` → `requestStop()` returns `false` and `triggerStop` is **never**
  called; (5) **first-press-wins (§24.3/INV-004)**: after the first `requestStop()` flips `canInterrupt`
  false, a second `requestStop()` returns `false` and `triggerStop` is still called exactly once; (6)
  **never-crash**: a `triggerStop` that throws is swallowed + logged (`coordinator.request-stop-error`),
  `requestStop()` returns `false`, nothing propagates; (7) **privacy**: only allow-listed fields are logged.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics;
`npx bun run build` → exit 0; `npx bun test` → **ALL green** — the new `transition-coordinator.test.ts`
PLUS the **12 existing files / 143 existing tests with ZERO changes and ZERO regressions**. A coordinator
with `canInterrupt()==true` forwards to `triggerStop` exactly once and returns `true`; with no proxy or
`canInterrupt()==false` it returns `false` and never calls `triggerStop`; a throwing `triggerStop` never
escapes `requestStop()`. `TransitionCoordinator` is structurally assignable to `StopRequestCoordinator`
(`requestStop(): boolean` + `alreadyInterrupting(): boolean`) with no adapter. No edits to any file other
than `src/state/coordinator.ts` + the new `tests/transition-coordinator.test.ts`.

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing. The coordinator is a coordination primitive consumed by
`ShortcutManager` (the user's keypress path) and (later) by the decorator (the proxy lifecycle). PRD §13.5
"DOCS: none — internal coordination, no user-facing surface." The end user never sees the coordinator; it
exists so a keypress in one scope can reach the live proxy in another.

**Use Case**: The user presses `ctrl+.` mid-reasoning. `ShortcutManager` (ExtensionContext scope) cannot
see the `StreamProxy` (constructed inside `streamSimple`). It calls
`coordinator.requestStop()`; the coordinator — which the decorator keeps pointed at the currently-active
proxy — delegates to that proxy's `canInterrupt()`/`triggerStop()`. The transition either begins (true) or
is ignored (false). Only one transition can ever begin per response because the proxy's FSM leaves
`Reasoning` after the first `triggerStop()`.

**User Journey**: (1) Decorator (P1.M5) starts an eligible stream → constructs a `StreamProxy` → calls
`coordinator.setActiveProxy(proxy)`. (2) User presses the shortcut → `ShortcutManager` handler checks
`coordinator.alreadyInterrupting()` (false) then `coordinator.requestStop()`. (3) Coordinator:
`activeProxy.canInterrupt()` true (mid-Reasoning) → `activeProxy.triggerStop()` → returns `true`. (4) The
proxy's FSM flips Reasoning→StopRequested; a second press now sees `alreadyInterrupting()` true
(`ShortcutManager` discards) and/or `canInterrupt()` false (`requestStop()` returns false). (5) Stream ends
→ decorator calls `coordinator.setActiveProxy(undefined)`.

**Pain Points Addressed**: Without the coordinator there is no path from the shortcut handler's scope to
the live proxy's FSM (the two live in different scopes). Duplicating transition state in the coordinator to
bridge them would violate PRD §37 (single owner) and race with the controller (INV-004). The coordinator
solves the scope problem by holding a *reference* and *delegating* — zero state of its own.

## Why

- **It is the only bridge across scopes.** The shortcut handler runs in `ExtensionContext` scope; the proxy
  runs inside `streamSimple` (per-request). PRD §37 + the work-item note require a shared bridge. The
  coordinator is that bridge: a session-scoped singleton the factory creates once, passed into both.
- **It owns NOTHING but a reference (PRD §37).** "The coordinator does NOT own transition state — it
  queries the proxy which queries its TransitionController." Every decision (`canInterrupt`,
  `isInterrupting`, `isReasoning`) and every action (`triggerStop`) is the proxy/controller's. This keeps
  the single-writer invariant (PRD §13.3/§30/§37) intact — duplicating the FSM in the coordinator would
  race and break INV-004.
- **It enforces first-press-wins without local dedup (§24.3).** `canInterrupt()` is true **only** in
  `Reasoning` (§22.5); `triggerStop()` moves the FSM out of `Reasoning`. So the second `requestStop()`
  naturally sees `canInterrupt()==false` → `false`. No coordinator-side counter or latch is needed (the
  work item: *"No local state needed — the coordinator is the authority"* via the proxy/controller).
- **It is defensive (never-crash).** A proxy fault inside `triggerStop()` is swallowed + logged and
  `requestStop()` returns `false`, so a keypress can never crash Pi (PRD Appendix K / Appendix E
  "Prohibited: crash the host"). This is defense-in-depth alongside `ShortcutManager`'s own try/catch.

## What

### Source: REWRITE `src/state/coordinator.ts` (replace the 1-line stub)

Exports:

1. **`ActiveProxy`** (interface — the coordinator's dependency-inversion seam to the proxy; the
   coordinator depends on this **structural** surface, NOT the concrete `StreamProxy`, exactly mirroring
   how `ShortcutManager` depends on `StopRequestCoordinator` instead of the concrete coordinator):
   ```typescript
   /**
    * The proxy-facing surface the TransitionCoordinator delegates to. The concrete `StreamProxy`
    * (src/provider/proxy.ts) becomes structurally assignable to this once it exposes these four methods:
    * `isReasoning()` (PRESENT today, P1.M4.T2), `canInterrupt()` + `isInterrupting()` (pure read delegates,
    * addable any time), and `triggerStop()` (the upstream ABORT, P1.M5.T1). The coordinator never imports
    * the concrete StreamProxy — importing it and calling `.triggerStop()` would NOT compile today
    * (`triggerStop` does not exist yet) and would break the `src/` typecheck gate.
    */
   export interface ActiveProxy {
     /** True only while the active stream is mid-reasoning (PRD §22.5). */
     isReasoning(): boolean;
     /** Shortcut availability: interruption is legal RIGHT NOW (state == Reasoning, PRD §22.5). */
     canInterrupt(): boolean;
     /** Kick off the stop transition (upstream abort + Reasoning→StopRequested). P1.M5 owns the body. */
     triggerStop(): boolean;
     /** A transition is already in flight (state past Reasoning; PRD §24.3 / INV-004). */
     isInterrupting(): boolean;
   }
   ```

2. **`class TransitionCoordinator`** — constructor takes `Diagnostics` (every module does: controller,
   proxy, buffer, decorator):
   ```typescript
   export class TransitionCoordinator {
     /** The single owned field: an optional reference to the active proxy (PRD §37). NEVER a copy of
      *  state — only a reference. `undefined` outside an active eligible stream. */
     private activeProxy: ActiveProxy | undefined = undefined;

     /**
      * @param diagnostics  Shared structured logger (PRD §36). **Privacy (Appendix H):** only event
      *                     names + accept/reject reasons + error categories are ever logged — never
      *                     prompt/reasoning/assistant content (the coordinator never sees any).
      */
     constructor(private readonly diagnostics: Diagnostics) {}

     /**
      * Point the coordinator at the proxy for the stream that is starting, or clear it (undefined) when
      * that stream ends. Called by the ProviderDecorator wrapper (P1.M5) on proxy construct + on stream
      * drain/terminal. At most one active proxy at a time (INV-004); the most recent call wins.
      */
     setActiveProxy(proxy: ActiveProxy | undefined): void {
       this.activeProxy = proxy;
       this.diagnostics.trace(proxy ? "coordinator.set-active" : "coordinator.clear-active", {});
     }

     /**
      * Whether the active stream is mid-reasoning (PRD §22.5). Pure delegate; false when no proxy.
      */
     isReasoning(): boolean {
       return this.activeProxy?.isReasoning() ?? false;
     }

     /**
      * Whether a transition is already in flight (PRD §24.3 / INV-004) — used by ShortcutManager to
      * discard repeats (EC-009/EC-010). Pure delegate; false when no proxy.
      */
     alreadyInterrupting(): boolean {
       return this.activeProxy?.isInterrupting() ?? false;
     }

     /**
      * Raise the stop REQUEST (PRD §24.2 — a request, not a command). The coordinator is NOT the
      * authority: it asks the active proxy.
      *   1. No active proxy → `false` (EC-001: shortcut before first provider event / after stream end).
      *   2. `!activeProxy.canInterrupt()` → `false` (PRD §22.5: not in Reasoning; FM-001). `triggerStop`
      *      is NOT called — the request is simply inadmissible right now.
      *   3. Otherwise → call `activeProxy.triggerStop()` and return `true`. The proxy's FSM then moves
      *      Reasoning→StopRequested so a second requestStop() sees canInterrupt()==false (§24.3
      *      first-press-wins; INV-004) — the coordinator holds NO dedup state of its own.
      *
      * NEVER throws: a `triggerStop` fault is swallowed + logged and `requestStop()` returns `false`
      * (never-crash; PRD Appendix K). This is defense-in-depth alongside ShortcutManager's handler guard.
      *
      * @returns whether the request was accepted (a transition was started).
      */
     requestStop(): boolean {
       const proxy = this.activeProxy;
       if (!proxy) {
         this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "no-active-proxy" });
         return false; // EC-001
       }
       if (!proxy.canInterrupt()) {
         this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "not-reasoning" });
         return false; // PRD §22.5 / FM-001
       }
       try {
         proxy.triggerStop();
       } catch (err) {
         this.diagnostics.error("coordinator.request-stop-error", {
           error: err instanceof Error ? err.message : String(err),
         });
         this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "proxy-fault" });
         return false; // never-crash
       }
       this.diagnostics.trace("coordinator.request-stop", { accepted: true });
       return true;
     }
   }
   ```
   (The class is **structurally assignable** to `StopRequestCoordinator` from `src/shortcut/index.ts`
   — both expose `requestStop(): boolean` + `alreadyInterrupting(): boolean` — so `ShortcutManager` wires
   it with zero glue.)

   **Imports** (verified — see research/notes.md §1):
   - `import type { Diagnostics } from "../diagnostics";` (TYPE only — same as controller/proxy/buffer).
   - **NO import of `StreamProxy`** — the coordinator depends on the `ActiveProxy` interface it defines.
     This is the dependency-inversion seam (mirrors `StopRequestCoordinator` in the shortcut module).

### Test: CREATE `tests/transition-coordinator.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`) with:
- A **capturing `Diagnostics`** stub — copy `makeCaptureDiag()` verbatim from
  `tests/reasoning-buffer.test.ts` (records `{level,event,fields?}` for privacy assertions).
- A **controllable fake `ActiveProxy`** builder `makeFakeProxy(overrides?)` returning
  `{ proxy: ActiveProxy; triggerStopCalls: number }` where `triggerStopCalls` is a live getter:
  - Internal mutable flags `reasoning=false`, `canInterrupt=false`, `interrupting=false`,
    `triggerThrows=false`, overridable via `overrides`.
  - `isReasoning/canInterrupt/isInterrupting` return the flags.
  - `triggerStop()`: increments the counter; **throws** if `triggerThrows`; otherwise **emulates the FSM**
    (`canInterrupt=false; interrupting=true; return true`) so a second `requestStop()` is rejected —
    this lets the first-press-wins test (§24.3) run against the coordinator with no real controller.

Coverage (every Success Criterion):
- **no active proxy (EC-001)**: fresh coordinator → `requestStop()===false`, `isReasoning()===false`,
  `alreadyInterrupting()===false`; `triggerStopCalls===0`; `coordinator.request-stop {accepted:false,
  reason:"no-active-proxy"}` traced.
- **isReasoning delegates**: `setActiveProxy(fake{reasoning:true})` → `isReasoning()===true`;
  `setActiveProxy(undefined)` → `isReasoning()===false`; `coordinator.set-active` /
  `coordinator.clear-active` traced.
- **alreadyInterrupting delegates**: `fake{interrupting:true}` → `alreadyInterrupting()===true`;
  `undefined` → `false`.
- **requestStop happy path (§51 Stop Request)**: `fake{canInterrupt:true}` → `requestStop()===true`;
  `triggerStopCalls===1`; `coordinator.request-stop {accepted:true}` traced.
- **outside Reasoning (§22.5 / FM-001)**: `fake{canInterrupt:false}` → `requestStop()===false`;
  `triggerStopCalls===0`; traced `{accepted:false, reason:"not-reasoning"}`.
- **first-press-wins (§24.3 / INV-004)**: `fake{canInterrupt:true}` (its `triggerStop` flips
  `canInterrupt` false) → call `requestStop()` twice: first returns `true`, second returns `false`;
  `triggerStopCalls===1` total.
- **never-crash**: `fake{canInterrupt:true, triggerThrows:true}` → `requestStop()` returns `false`, does
  NOT throw; `coordinator.request-stop-error` traced (error category only, no content);
  `{accepted:false, reason:"proxy-fault"}` traced; `triggerStopCalls===1` (it was called, then threw).
- **privacy guard**: assert every captured `fields` across the suite contains ONLY allow-listed keys
  (`accepted`/`reason`/`error`/`{}`) — never prompt/reasoning/assistant content.

**Out of scope** (owned by other subtasks — do NOT implement/modify here):
- **Factory wiring** (`src/index.ts`): constructing the coordinator, passing it to the decorator, and
  `shortcutManager.register(pi, config.shortcut, coordinator)`. → **P1.M5** (needs `triggerStop` on the
  proxy so `StreamProxy` is assignable to `ActiveProxy`); exact snippet in "Integration Points". This
  subtask does NOT touch `src/index.ts`.
- **Decorator wiring** (`src/provider/decorator.ts`): calling `coordinator.setActiveProxy(proxy)` on each
  eligible stream + clearing on stream end. → **P1.M5** (same reason). This subtask does NOT touch the
  decorator.
- **`StreamProxy` methods** `canInterrupt()` / `isInterrupting()` / `triggerStop()`: → P1.M5 owns
  `triggerStop` (the abort); `canInterrupt`/`isInterrupting` may be added as thin read delegates in P1.M5
  or a wiring step. The coordinator depends only on the `ActiveProxy` interface, so this subtask is
  unblocked regardless.
- **`TransitionController`** (`src/state/controller.ts`): DONE, immutable. The coordinator never touches
  it directly (it goes through the proxy).
- Any change to `src/index.ts`, `src/state/controller.ts`, `src/provider/*`, `src/config/*`,
  `src/diagnostics/*`, `src/buffer/*`, `src/shortcut/*`, `src/types.ts`, any existing test, `package.json`,
  `tsconfig.json`, `.gitignore`. No new deps.

### Success Criteria

- [ ] `src/state/coordinator.ts` exports `ActiveProxy` (interface: `isReasoning()`, `canInterrupt()`,
      `triggerStop()`, `isInterrupting()` — all `: boolean`) and `class TransitionCoordinator(diagnostics)`
      with `private activeProxy: ActiveProxy | undefined = undefined` + `setActiveProxy(proxy | undefined)`
      + `requestStop(): boolean` + `isReasoning(): boolean` + `alreadyInterrupting(): boolean` + Mode-A
      JSDoc citing PRD §13.3/§37/§24/§22.5/INV-004/§51.
- [ ] `requestStop()`: no proxy → `false`; `!canInterrupt()` → `false` (and `triggerStop` NOT called);
      else calls `triggerStop()` and returns `true`; a `triggerStop` throw → `false`, swallowed + logged,
      never rethrown.
- [ ] `isReasoning()`/`alreadyInterrupting()` delegate to the proxy (`?? false` when undefined).
- [ ] `TransitionCoordinator` is structurally assignable to `StopRequestCoordinator` (requestStop +
      alreadyInterrupting) — verifiable by a one-line type assertion test or by the ShortcutManager test.
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green
      (143 existing + new), zero regressions.

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have
everything needed to implement this successfully?"_ → YES. The coordinator is a single self-contained
class delegating to a structural interface it defines; the contract (method-by-method logic) is reproduced
verbatim above; the test-double patterns (`makeCaptureDiag`, fake satisfying a structural interface) are
copied from existing suites; the validation gates are the project's real commands with a captured baseline
(143/12). The only non-obvious decision — why the coordinator depends on `ActiveProxy` instead of the
concrete `StreamProxy` — is fully explained in the "Why" + the Scope Boundary (it cannot compile against a
not-yet-existing `triggerStop`).

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask
- url: PRD.md "# 37. Concurrency Model / Ownership Rules"
  why: "Each module owns its state; the coordinator holds only a REFERENCE to the active proxy and
        delegates — it is NOT a state owner. 'No mutable state shall have multiple owners.'"
  critical: "The coordinator must NOT duplicate transition/dedup state; the proxy/controller is the
             single writer. Duplicating races + breaks INV-004."

- url: PRD.md "# 13.3 Transition State Machine / Principle"
  why: "'Single writer. Multiple readers.' Allowed readers include the shortcut handler + stream proxy;
        the writer is the state machine only. The coordinator is a reader-reacher (via the proxy)."
  critical: "The coordinator reaches the writer THROUGH the proxy (activeProxy.canInterrupt/triggerStop),
             never by mutating state itself."

- url: PRD.md "# 24. Stop Signal (24.1 source / 24.2 request semantics / 24.3 idempotency / 24.4 lifetime)"
  why: "requestStop() is a REQUEST not a command; first press wins; signal expires on completion/failure."
  critical: "First-press-wins is enforced by canInterrupt() going false after triggerStop (FSM leaves
             Reasoning) — NOT by coordinator-local state."

- url: PRD.md "# 22.5 Shortcut Availability"
  why: "'Current State == Reasoning' is the ONLY state where the shortcut is active. = canInterrupt()."
  critical: "requestStop() MUST gate on canInterrupt() (true only in Reasoning); outside Reasoning it
             returns false WITHOUT calling triggerStop (FM-001)."

- url: PRD.md "Appendix O / INV-004"
  why: "'At most one interruption transition may exist per logical assistant response.'"
  critical: "At most one active proxy; the coordinator's delegations + the proxy FSM together guarantee
             a single transition per response."

- url: PRD.md "# 51. Complete Transition Algorithm / Stop Request"
  why: "Shortcut → TransitionController → Validate → Already transitioning? Yes→Ignore, No→Create token
        → Freeze shortcut → Proceed. The coordinator is the 'Shortcut → ... → Validate' hop."
  critical: "The 'Already transitioning? Yes → Ignore' branch is coordinator.alreadyInterrupting()
             (consumed by ShortcutManager) + the canInterrupt() gate inside requestStop()."

# Codebase patterns to FOLLOW (all DONE/immutable)
- file: src/state/controller.ts
  why: "The sibling state-machine module. Copy its JSDoc style (Mode-A, PRD citations), the
        constructor-takes-Diagnostics convention, and the pure-read/boolean-returning method style."
  pattern: "class X(private readonly diagnostics: Diagnostics); boolean-returning query methods never
            throw/log; action methods trace on success."
  gotcha: "controller.requestStop() and coordinator.requestStop() are DIFFERENT: controller's does the
           FSM state change (Reasoning→StopRequested); coordinator's delegates to proxy.triggerStop()
           (which, in P1.M5, will both move the FSM AND abort upstream). Do not conflate them."

- file: src/shortcut/index.ts  (P1.M4.T3.S1 PRP — sibling, parallel)
  why: "The dependency-inversion precedent: ShortcutManager defines StopRequestCoordinator (a structural
        interface) instead of importing the concrete coordinator, so it compiles before the coordinator
        lands. THIS subtask mirrors that for the coordinator→proxy direction (ActiveProxy)."
  pattern: "export interface <Seam> { ... } then depend on the seam, not the concrete class. The concrete
            class becomes structurally assignable later with zero glue."
  gotcha: "TransitionCoordinator must be structurally assignable to StopRequestCoordinator
           (requestStop():boolean + alreadyInterrupting():boolean) — keep those two signatures identical."

- file: src/provider/proxy.ts
  why: "The thing the coordinator delegates to. Confirms isReasoning() EXISTS today (returns
        controller.getState()==='Reasoning') but canInterrupt()/triggerStop()/isInterrupting() do NOT
        (triggerStop = P1.M5 abort). This is WHY the coordinator uses the ActiveProxy seam."
  pattern: "Read-only delegation: the coordinator mirrors how the proxy's isReasoning() delegates to
            this._controller.getState()."
  gotcha: "Do NOT import StreamProxy into coordinator.ts — it would not compile (triggerStop absent) and
           would couple the coordinator to a per-request object's concrete type."

- file: tests/reasoning-buffer.test.ts
  why: "Source for makeCaptureDiag() (the capturing Diagnostics stub used project-wide) and the
        describe/test/expect style."
  pattern: "makeCaptureDiag(): { diag; events: {level,event,fields?}[] } — copy verbatim."
  gotcha: "tsconfig excludes tests/ from tsc — tests are NOT typechecked, only run by bun. So a fake
           ActiveProxy can be a plain object cast `as ActiveProxy`."

- docfile: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "Authoritative module interfaces. TransitionCoordinator: setActiveProxy/requestStop/isReasoning/
        alreadyInterrupting; 'Owns: Reference to active StreamProxy (if any)'."
  section: "### TransitionCoordinator  (and ### ShortcutManager for the consumer contract)"
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO coordinator wiring yet (→ P1.M5)
├── types.ts                 # shared types (P1.M2.T1)
├── config/index.ts          # Config + DEFAULT_CONFIG (P1.M1.T2)
├── diagnostics/index.ts     # Diagnostics interface + createDiagnostics (P1.M1.T3)
├── buffer/index.ts          # ReasoningBuffer (P1.M4.T1)
├── provider/
│   ├── decorator.ts         # ProviderDecorator — constructs StreamProxy (P1.M1.T4 / P1.M2.T3)
│   └── proxy.ts             # StreamProxy — isReasoning() exists; canInterrupt/triggerStop/isInterrupting = P1.M5
├── shortcut/index.ts        # ShortcutManager + StopRequestCoordinator (P1.M4.T3 — parallel)
└── state/
    ├── controller.ts        # TransitionController FSM (P1.M3.T1) — immutable
    └── coordinator.ts       # ← THIS SUBTASK (1-line stub → real class)
tests/
├── transition-controller.test.ts   # pattern source (FSM test style)
├── reasoning-buffer.test.ts        # pattern source (makeCaptureDiag)
├── stream-proxy-detection.test.ts  # pattern source (fake satisfying a structural interface)
└── … (9 more suites; 143 tests total, all must stay green)
```

### Desired Codebase tree with files to be added/changed

```bash
src/state/coordinator.ts                # REWRITE: stub → ActiveProxy interface + TransitionCoordinator class
tests/transition-coordinator.test.ts    # CREATE : bun:test suite (fake ActiveProxy + capturing Diagnostics)
# (no other files change)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: tsconfig.json has rootDir:"./src" + exclude:["tests"]. So `tsc --noEmit` (the typecheck gate)
// typechecks ONLY src/**. coordinator.ts MUST compile standalone. It CANNOT import the concrete StreamProxy
// and call `.triggerStop()` — that method does not exist yet (P1.M5). => depend on the ActiveProxy seam.

// CRITICAL: There are TWO requestStop() methods. TransitionController.requestStop() (controller.ts) does
// the FSM move Reasoning→StopRequested (exists). TransitionCoordinator.requestStop() (this file) delegates
// to proxy.triggerStop() (P1.M5 will both move the FSM AND abort upstream). Do not mix them up.

// CONVENTION: every module's constructor takes Diagnostics (controller/proxy/buffer/decorator). The
// coordinator must too — and it is the ONLY constructor arg.

// PRIVACY (Appendix H): the coordinator never sees prompt/reasoning/assistant content. Only log event
// names + {accepted, reason} + error categories. The fake-proxy test must assert no content leaks.

// INV-004: at most one active proxy. setActiveProxy simply overwrites the reference (last writer wins);
// the decorator (P1.M5) is responsible for clearing it (undefined) when a stream ends.
```

## Implementation Blueprint

### Data models and structure

No persistent data models. The coordinator owns exactly ONE field:

```typescript
private activeProxy: ActiveProxy | undefined = undefined;   // the only owned (reference) state
```

`ActiveProxy` is the structural interface (defined in this file) — the dependency-inversion seam. There are
no Pydantic/ORM equivalents; this is a TS class + interface. Type safety is enforced by `strict: true`
(`tsconfig.json`) and the `tsc --noEmit` gate.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REWRITE src/state/coordinator.ts (replace the 1-line stub)
  - IMPLEMENT: `export interface ActiveProxy { isReasoning(): boolean; canInterrupt(): boolean;
    triggerStop(): boolean; isInterrupting(): boolean; }` with Mode-A JSDoc explaining it is the seam the
    concrete StreamProxy will satisfy once P1.M5 adds triggerStop (+ canInterrupt/isInterrupting delegates).
  - IMPLEMENT: `export class TransitionCoordinator { private activeProxy: ActiveProxy|undefined = undefined;
    constructor(private readonly diagnostics: Diagnostics); setActiveProxy(proxy|undefined); requestStop();
    isReasoning(); alreadyInterrupting(); }` EXACTLY per the verbatim code in the "What" section.
  - FOLLOW pattern: src/state/controller.ts (constructor-takes-Diagnostics; Mode-A JSDoc with PRD cites;
    boolean query methods never throw/log; action method traces on success).
  - FOLLOW pattern: src/shortcut/index.ts (define a structural seam interface + depend on it, never the
    concrete collaborator).
  - NAMING: PascalCase class/interface; camelCase methods; the field `activeProxy`.
  - IMPORTS: ONLY `import type { Diagnostics } from "../diagnostics";`. Do NOT import StreamProxy.
  - PLACEMENT: src/state/coordinator.ts (already exists as a stub — overwrite in place).
  - DEPENDENCIES: none new (Diagnostics is the only type used).

Task 2: CREATE tests/transition-coordinator.test.ts
  - IMPLEMENT: `import { describe, test, expect } from "bun:test";` + the `makeCaptureDiag()` stub (copied
    from tests/reasoning-buffer.test.ts) + `makeFakeProxy(overrides?)` (a plain object cast `as ActiveProxy`
    with mutable reasoning/canInterrupt/interrupting/triggerThrows flags + a counted, FSM-emulating
    triggerStop exposed via a live `triggerStopCalls` getter).
  - IMPLEMENT: the 8 coverage cases enumerated in "What / Test" (no-proxy EC-001; isReasoning delegate;
    alreadyInterrupting delegate; happy-path; outside-Reasoning §22.5/FM-001; first-press-wins §24.3/INV-004;
    never-crash triggerStop throw; privacy allow-list guard).
  - FOLLOW pattern: tests/stream-proxy-detection.test.ts (fake satisfying a structural interface via cast)
    + tests/reasoning-buffer.test.ts (makeCaptureDiag).
  - NAMING: `describe("TransitionCoordinator — …")`; `test("…")` sentences referencing the PRD anchor.
  - COVERAGE: every public method (setActiveProxy, requestStop, isReasoning, alreadyInterrupting) with
    positive + negative + fault paths; assert call counts on the fake's triggerStop.
  - PLACEMENT: tests/transition-coordinator.test.ts (tests/ is excluded from tsc; run by `bun test`).
  - DEPENDENCIES: imports TransitionCoordinator + ActiveProxy from ../src/state/coordinator; Diagnostics type
    from ../src/diagnostics.

Task 3: (NONE — factory/decorator/proxy wiring is OUT OF SCOPE; lands in P1.M5. See Integration Points for
  the exact snippet P1.M5 will use. Do NOT touch src/index.ts, src/provider/*, src/provider/proxy.ts.)
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — dependency inversion (mirror StopRequestCoordinator in src/shortcut/index.ts).
// The coordinator depends on a structural interface it DEFINES, never the concrete StreamProxy.
export interface ActiveProxy { /* isReasoning / canInterrupt / triggerStop / isInterrupting */ }

export class TransitionCoordinator {
  constructor(private readonly diagnostics: Diagnostics) {}
  private activeProxy: ActiveProxy | undefined = undefined;   // the ONLY owned field (a reference)

  // PATTERN — pure delegate with ?? fallback (proxy absent ⇒ false). Never throws, never logs.
  isReasoning(): boolean { return this.activeProxy?.isReasoning() ?? false; }
  alreadyInterrupting(): boolean { return this.activeProxy?.isInterrupting() ?? false; }

  // PATTERN — request as gated action: admissibility check FIRST, then act; fault swallowed.
  requestStop(): boolean {
    const proxy = this.activeProxy;
    if (!proxy) return this.reject("no-active-proxy");        // EC-001
    if (!proxy.canInterrupt()) return this.reject("not-reasoning"); // §22.5 / FM-001 — do NOT triggerStop
    try { proxy.triggerStop(); }                              // P1.M5 abort kickoff
    catch (err) {                                             // never-crash (Appendix K)
      this.diagnostics.error("coordinator.request-stop-error", { error: msg(err) });
      return this.reject("proxy-fault");
    }
    this.diagnostics.trace("coordinator.request-stop", { accepted: true });
    return true;
  }
  // (reject(reason) is a private helper that traces {accepted:false, reason} and returns false; or inline it.)
}

// GOTCHA — first-press-wins needs NO coordinator state: canInterrupt() is true only in Reasoning; after
// triggerStop() the FSM leaves Reasoning so the next requestStop() sees canInterrupt()==false. The
// coordinator holds zero dedup counters/latches (PRD §37 single-owner; the proxy/controller is authority).

// GOTCHA — TransitionCoordinator is structurally assignable to StopRequestCoordinator
// ({requestStop():boolean; alreadyInterrupting():boolean}) from src/shortcut/index.ts. Keep those two
// signatures byte-identical so ShortcutManager wires it with zero adapter.
```

### Integration Points

```yaml
# NOTE: ALL of the following wiring is OUT OF SCOPE for this subtask and lands in P1.M5 (it requires the
# concrete StreamProxy to satisfy ActiveProxy, i.e. triggerStop must exist). Documented here so P1.M5 can
# do it in one pass. This subtask changes ONLY src/state/coordinator.ts + tests/transition-coordinator.test.ts.

FACTORY (src/index.ts — P1.M5):
  - construct: `const coordinator = new TransitionCoordinator(diagnostics);` (after createDiagnostics)
  - pass into decorator: extend ProviderDecorator ctor with `coordinator` (or a setter) so the wrapper can
    call coordinator.setActiveProxy(proxy) / setActiveProxy(undefined).
  - register shortcut: `const shortcutManager = new ShortcutManager(diagnostics);`
    `shortcutManager.register(pi, config.shortcut, coordinator);`  // coordinator ≡ StopRequestCoordinator

DECORATOR (src/provider/decorator.ts — P1.M5, in wrapperStreamSimple eligible branch):
  - on proxy construct: `const proxy = new StreamProxy(model, context, options ?? {}, originalStreamSimple,
    this.diagnostics); this.coordinator.setActiveProxy(proxy);`
  - on stream end (drain/terminal): `this.coordinator.setActiveProxy(undefined);`

PROXY (src/provider/proxy.ts — P1.M5): add the three missing ActiveProxy members so StreamProxy satisfies
  the interface structurally:
  - `canInterrupt(): boolean { return this._controller.canInterrupt(); }`            // true only in Reasoning
  - `isInterrupting(): boolean { return INTERRUPTING_STATES.has(this._controller.getState()); }`
      where INTERRUPTING_STATES = {StopRequested,Aborting,Capturing,Restarting,Splicing,Answering}
  - `triggerStop(): boolean { /* P1.M5.T1: create AbortController, abort upstream, controller.requestStop()
      or equivalent FSM move; return acceptance */ }`
  - (isReasoning() already exists — P1.M4.T2 — no change.)

CONFIG: none (no new config; the coordinator reads nothing from Config).
DATABASE/ROUTES: none.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after writing src/state/coordinator.ts — must be clean before writing the test.
npx bun run typecheck     # tsc --noEmit over src/** — coordinator.ts MUST compile standalone (0 diagnostics)
npx bun run build         # tsc → exit 0

# (No ruff/mypy — this is a TS project. Formatting is conventional; match the existing 2-space style.)
# Expected: Zero errors. If typecheck reports "Property 'triggerStop' does not exist on type 'StreamProxy'",
# you have WRONGLY imported the concrete StreamProxy — revert to the ActiveProxy seam (see Gotchas).
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the coordinator as created.
npx bun test tests/transition-coordinator.test.ts -v   # the new suite in isolation

# Full suite for affected area (all state + shortcut tests, plus the whole project for regressions).
npx bun test                                            # 143 existing + new tests, ALL green

# Expected: All tests pass. If a test fails, READ the assertion (call counts on the fake triggerStop are the
# most common failure — recheck the canInterrupt gate ordering and the FSM-emulation in makeFakeProxy).
```

### Level 3: Integration Testing (System Validation)

```bash
# There is no runtime integration to exercise yet — the coordinator is unwired (factory/decorator/proxy
# wiring is P1.M5). Structural assignability is the integration contract; verify it directly:

# (a) TransitionCoordinator ≡ StopRequestCoordinator (the ShortcutManager seam):
npx bun -e 'import("./src/state/coordinator.ts").then(({TransitionCoordinator}) => {
  import("./src/shortcut/index.ts").then(({StopRequestCoordinator}) => {
    const c = new TransitionCoordinator({trace(){},debug(){},info(){},warn(){},error(){}});
    const _s: StopRequestCoordinator = c;   // structurally assignable ⇒ no adapter
    console.log("assignable: OK");
  });
});' 2>/dev/null || echo "(runtime check skipped — typecheck covers this: see Level 1)"

# (b) Confirm no regressions in the existing factory/provider/shortcut paths (they are untouched):
npx bun test tests/factory.test.ts tests/provider-decorator.test.ts -v

# Expected: "assignable: OK" (or typecheck-clean) and zero regressions. No live stream test is possible
# pre-P1.M5 (triggerStop is a stub-free seam only).
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Privacy guard (PRD Appendix H): assert the coordinator never logs content — only event names + {accepted,
# reason} + error categories. Enforced by a dedicated test case that scans every captured fields object for
# allow-listed keys only (accepted/reason/error/empty). No prompt/reasoning/assistant content can appear
# because the coordinator never receives any (it only booleans + a throwable).

# Concurrency note (PRD §37): the coordinator is a single-field reference holder; setActiveProxy is the only
# writer. Under the extension's cooperative-async model no two streams are active simultaneously (INV-004),
# so there is no race on activeProxy. No lock is required or appropriate (PRD §37 "cooperative asynchronous;
# no thread affinity"). Documented in JSDoc; no executable check.

# Expected: privacy test green; no concurrency primitive introduced.
```

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0.
- [ ] Level 2: `npx bun test` → **all green** (143 existing + new `transition-coordinator` tests).
- [ ] No regressions: the 12 existing test files are byte-unchanged and still pass.
- [ ] coordinator.ts imports ONLY `Diagnostics` (type) — never the concrete `StreamProxy`.

### Feature Validation
- [ ] `ActiveProxy` interface exported with all four `: boolean` methods.
- [ ] `requestStop()`: no-proxy→false; `!canInterrupt()`→false (triggerStop NOT called); else
      `triggerStop()`→true; throw→false (swallowed + logged).
- [ ] `isReasoning()`/`alreadyInterrupting()` delegate with `?? false`.
- [ ] First-press-wins proven (second `requestStop()`→false, `triggerStop` called exactly once).
- [ ] `TransitionCoordinator` assignable to `StopRequestCoordinator` (no adapter).

### Code Quality Validation
- [ ] Constructor takes `Diagnostics` (matches controller/proxy/buffer/decorator convention).
- [ ] Mode-A JSDoc with PRD cites (§13.3/§37/§24/§22.5/INV-004/§51) — matches controller.ts style.
- [ ] Zero owned state besides the `activeProxy` reference (PRD §37 single-owner honored).
- [ ] Never-crash: `requestStop()` cannot throw (Appendix K).

### Documentation & Deployment
- [ ] JSDoc explains the ActiveProxy seam (why not concrete StreamProxy) — the one non-obvious decision.
- [ ] JSDoc documents that factory/decorator/proxy wiring is deferred to P1.M5 (Integration Points).
- [ ] No new env vars / config.

---

## Anti-Patterns to Avoid
- ❌ Don't import the concrete `StreamProxy` into `coordinator.ts` — it won't compile (`triggerStop` is
  P1.M5) and couples a session-scoped singleton to a per-request type. Use the `ActiveProxy` seam.
- ❌ Don't add dedup/idempotency state to the coordinator (no counter, no latch, no "alreadyRequested"
  flag) — the proxy/controller is the authority (PRD §37); `canInterrupt()` going false after
  `triggerStop()` already enforces §24.3.
- ❌ Don't reach the `TransitionController` directly from the coordinator — the work item mandates
  "queries the proxy which queries its TransitionController." Go through `activeProxy`.
- ❌ Don't call `triggerStop()` when `canInterrupt()` is false (FM-001/§22.5) — gate first, act second.
- ❌ Don't let `requestStop()` throw on a proxy fault (never-crash, Appendix K) — swallow + log + false.
- ❌ Don't touch `src/index.ts`, `src/provider/*`, `src/state/controller.ts`, `src/shortcut/*`, or any
  existing test — wiring is P1.M5; this subtask is the coordinator + its test only.
- ❌ Don't log prompt/reasoning/assistant content (Appendix H) — the coordinator never has any, but assert
  it in the test.
