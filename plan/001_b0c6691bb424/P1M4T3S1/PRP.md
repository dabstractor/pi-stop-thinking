# PRP — P1.M4.T3.S1: ShortcutManager with idempotent stop request forwarding (`src/shortcut/index.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M4.T3.S1 (Phase 3 Reasoning Detection, 1 pt) — implement the **ShortcutManager** module:
> the tiny user-interaction layer (PRD §13.5) that registers a **configurable** keyboard shortcut
> (default `"ctrl+."`) and, on each press, forwards an **idempotent** stop *request* (PRD §24.2 — a request,
> not a command) to the `TransitionCoordinator` (P1.M4.T4). PRD authority: §33 ShortcutManager Module
> (Responsibility / Responsibilities / Invariants), §24 Stop Signal (§24.1 source = keyboard; §24.2 request
> semantics; §24.3 idempotency — first press wins; §24.4 lifetime), §13.5 User Interaction Layer ("Register
> shortcut / Determine if shortcut is valid / Signal interruption / Nothing more"), §22.5 Shortcut
> Availability, EC-009 (Duplicate Shortcut), EC-010 (Shortcut Held Down).
> **Builds on** (inputs, all DONE & immutable — do NOT modify): `ExtensionAPI` from
> **pi** (`@earendil-works/pi-coding-agent` — `registerShortcut`), `DEFAULT_CONFIG.shortcut` (`"ctrl+."`)
> from **P1.M1.T2.S1** (`src/config/index.ts`), `Diagnostics` from **P1.M1.T3.S1**. **Consumes by contract**
> the `TransitionCoordinator` stop-request surface (`requestStop()` + `alreadyInterrupting()`) from
> **P1.M4.T4** — which is `Planned` and **not yet built**, so ShortcutManager depends on a minimal
> *structural interface* (see "Scope Boundary") and the real class will satisfy it with zero glue.
> **Consumed by**: P1.M4.T4 (TransitionCoordinator owner) wires the factory: constructs the coordinator +
> `new ShortcutManager(diagnostics)` + `shortcutManager.register(pi, config.shortcut, coordinator)`. The
> **factory wiring is OUT OF SCOPE for this subtask** (it cannot compile without the coordinator) — see
> "Scope Boundary" + the prescribed T4 wiring in "Integration Points".

---

## Goal

**Feature Goal**: Implement `ShortcutManager` — a stateless forwarder (PRD §13.5) that registers ONE
keyboard shortcut with pi and, on every press, (a) discards the event if a transition is already in flight
(`coordinator.alreadyInterrupting()` — EC-010 auto-repeat / key-held), then (b) raises the stop *request*
(`coordinator.requestStop()` — idempotent; no-ops outside `Reasoning`, PRD §24.3 first-press-wins).
ShortcutManager owns **NO** dedup/idempotency state: the coordinator (→ `TransitionController`) is the
single authority (work item: *"No local state needed — the coordinator is the authority"*). The shortcut is
**configurable** via `config.shortcut` (default `"ctrl+."`, PRD §47 / Appendix K).

**Deliverable** (ONE source file CREATED + ONE test file CREATED; NO other files change — see Scope Boundary):
- `src/shortcut/index.ts` — NEW: `class ShortcutManager(diagnostics)` with `register(pi, shortcut,
  coordinator)` (calls `pi.registerShortcut(shortcut, { description: "Stop Thinking & Do", handler })`
  where `handler` is the `alreadyInterrupting()`-guarded → `requestStop()` forwarder) + `unregister()`
  (documented no-op: pi exposes no deregistration API) + the exported **`StopRequestCoordinator`** structural
  interface (the coordinator's stop-request surface ShortcutManager depends on) + Mode-A JSDoc citing PRD
  §33/§24/§13.5/§22.5 + documenting the `config.shortcut` configurability/default.
- `tests/shortcut-manager.test.ts` — NEW `bun:test` suite: a fake `ExtensionAPI` that captures
  `registerShortcut(shortcut, {description, handler})`, a fake `StopRequestCoordinator` (stateful: flips to
  interrupting after the first `requestStop()`), and assertions proving (1) `register` calls
  `pi.registerShortcut` once with the exact shortcut + description `"Stop Thinking & Do"` + a handler; (2)
  the captured handler forwards to `coordinator.requestStop()`; (3) **EC-009/EC-010**: rapid/held presses
  → `requestStop()` called **exactly once** (subsequent presses discarded by `alreadyInterrupting()`); (4)
  **outside-Reasoning (FM-001)**: the handler still forwards (does NOT pre-gate on reasoning) and the
  coordinator rejects (returns `false`); (5) the handler never throws (a coordinator fault is swallowed +
  logged); (6) a custom shortcut string flows through unchanged; (7) `unregister()` is a safe no-op.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics;
`npx bun run build` → exit 0; `npx bun test` → **ALL green** — the new `shortcut-manager.test.ts` PLUS the
**10 existing suites with ZERO changes and ZERO regressions**. A captured handler invoked 3× against a
stateful fake coordinator results in `requestStop` being called exactly once (idempotency/EC-010 proof);
invoked once against a never-interrupting, always-rejecting coordinator results in `requestStop` called
once with no throw (FM-001 proof); `register` always calls `pi.registerShortcut` exactly once with
`description === "Stop Thinking & Do"` and the given shortcut. No edits to any file other than the new
`src/shortcut/index.ts` + the new `tests/shortcut-manager.test.ts`.

---

## User Persona (if applicable)

**Target User**: The end user of the Pi coding agent (the **developer using Pi** with a z.ai reasoning
model). ShortcutManager is the one piece of this extension they directly touch.

**Use Case**: While the model is mid-reasoning (thinking blocks streaming), the user decides the reasoning
is enough and wants to cut to the answer. They press `ctrl+.` (or their configured shortcut). ShortcutManager
turns that single keypress into a stop *request* handed to the coordinator, which the state machine may
honour (→ transition to answer) or ignore (e.g. pressed outside reasoning). They can mash it; duplicates and
auto-repeat are silently collapsed to one transition.

**User Journey**: (1) User configures `shortcut` (optional; default `"ctrl+."`). (2) At extension load, the
factory (P1.M4.T4) calls `shortcutManager.register(pi, config.shortcut, coordinator)`. (3) During reasoning
the user presses the shortcut. (4) ShortcutManager's handler discards it if a transition is already running,
else forwards `coordinator.requestStop()`. (5) The coordinator/controller decides (Reasoning→StopRequested or
no-op). (6) Either one transition happens, or nothing — never two.

**Pain Points Addressed**: Without ShortcutManager there is no keyboard path to raise the stop signal (PRD
§24.1: "User keyboard shortcut. Only one source exists in MVP."). Without idempotent forwarding, OS
auto-repeat (EC-010) or a reflexive double-tap (EC-009) would fire multiple transitions. ShortcutManager +
the coordinator gate guarantee exactly one.

## Why

- **This is the MVP's only entry point for the stop signal.** PRD §24.1: "Source: User keyboard shortcut.
  Only one source exists in MVP." Until ShortcutManager exists, the FSM (P1.M3), buffer (P1.M4.T1), and
  reasoning detection (P1.M4.T2) have nothing to trigger them. ShortcutManager is the wire from the human to
  `requestStop()`.
- **It is intentionally dumb (PRD §13.5).** The interaction layer does ONLY "Register shortcut / Determine
  if shortcut is valid / Signal interruption / Nothing more" — and even "determine if valid" is delegated to
  the coordinator here (the handler forwards; the coordinator says yes/no). It must NOT abort streams, modify
  providers, construct requests, rewrite prompts, or manipulate buffers (PRD §13.5 non-responsibilities).
  This PRP makes that structural: the handler body is two lines that touch only the coordinator.
- **Idempotency is not its job.** PRD §24.3 ("first press wins; subsequent presses ignored") + EC-009 +
  EC-010 are enforced by the coordinator/controller authority (`alreadyInterrupting()` +
  `requestStop()`→FSM). ShortcutManager holds NO dedup state — duplicating that authority locally would race
  with the coordinator and violate INV-004 (single transition per response). The work item mandates this.
- **It is configurable & safe.** The shortcut is user-configurable (`config.shortcut`, default `"ctrl+."`)
  and the handler is defensive (a coordinator fault is swallowed + logged — the extension's never-crash
  philosophy, PRD Appendix K / Appendix E "Prohibited: crash the host"). A bad keypress can never break Pi.

## What

### Source: CREATE `src/shortcut/index.ts`

**New file.** Exports:

1. **`StopRequestCoordinator`** (interface — the coordinator's stop-request surface ShortcutManager depends
   on; dependency-inversion seam so the module compiles BEFORE P1.M4.T4's concrete `TransitionCoordinator`
   lands):
   ```typescript
   export interface StopRequestCoordinator {
     /** Raise the stop request. Returns whether it was accepted (false when not Reasoning / already
      *  interrupting). PRD §24.2 (request, not command) + §24.3 (first press wins). */
     requestStop(): boolean;
     /** Whether a transition is already in progress. PRD §24.3 + EC-010. The handler discards repeats. */
     alreadyInterrupting(): boolean;
   }
   ```
   (P1.M4.T4's `TransitionCoordinator` declares exactly these two methods per
   `plan/001_b0c6691bb424/architecture/module_contracts.md` → "TransitionCoordinator", so it is
   **structurally assignable** to `StopRequestCoordinator` with no adapter.)

2. **`class ShortcutManager`** — constructor takes `Diagnostics` (codebase convention: controller, buffer,
   proxy all take diagnostics in the ctor):
   ```typescript
   export class ShortcutManager {
     constructor(private readonly diagnostics: Diagnostics) {}

     /**
      * Register the stop shortcut with Pi (PRD §33 / §13.5 / §24.1). The shortcut is configurable via
      * `config.shortcut` (default "ctrl+." — see src/config DEFAULT_CONFIG.shortcut, PRD §47 / Appendix K).
      *
      * The handler is a STATELESS forwarder (PRD §13.5 "Nothing more"):
      *   1. EC-010 (key held / OS auto-repeat): if a transition is already in flight, discard the event.
      *   2. Raise the REQUEST (PRD §24.2): call coordinator.requestStop(). The coordinator → controller is
      *      the idempotency authority — it no-ops (returns false) outside Reasoning (FM-001) and honors
      *      only the first legal press (PRD §24.3; EC-009). ShortcutManager holds NO dedup state.
      *
      * @param pi           Pi extension API (provides registerShortcut).
      * @param shortcut     The configured KeyId string (e.g. "ctrl+."). Passed straight to pi.
      * @param coordinator  The stop-request authority (P1.M4.T4 TransitionCoordinator satisfies this).
      */
     register(pi: ExtensionAPI, shortcut: string, coordinator: StopRequestCoordinator): void {
       pi.registerShortcut(shortcut, {
         description: "Stop Thinking & Do",
         handler: () => this.handlePress(coordinator),
       });
       this.diagnostics.trace("shortcut.registered", { shortcut });
     }

     /**
      * Per-press handler. Stateless; the coordinator is the authority. Wrapped in try/catch so a
      * coordinator fault can NEVER propagate into Pi's keybinding dispatch (extension never-crash rule,
      * PRD Appendix K / Appendix E "Prohibited: crash the host").
      */
     private handlePress(coordinator: StopRequestCoordinator): void {
       try {
         if (coordinator.alreadyInterrupting()) {
           // EC-010 (key held / auto-repeat) + PRD §24.3: discard once a transition is in flight.
           this.diagnostics.trace("shortcut.ignored", { reason: "already-interrupting" });
           return;
         }
         const accepted = coordinator.requestStop(); // idempotent: false outside Reasoning (FM-001)
         this.diagnostics.trace("shortcut.forwarded", { accepted });
       } catch (err) {
         this.diagnostics.error("shortcut.handler-error", {
           error: err instanceof Error ? err.message : String(err),
         });
       }
     }

     /**
      * Lifecycle counterpart to register() (PRD §33). NOTE: Pi's `registerShortcut` returns void and the
      * SDK exposes NO deregistration API — the binding is therefore session-scoped (removed when Pi tears
      * the extension down). The shortcut's dynamic *disable* during/after a transition is enforced by the
      * coordinator gate (alreadyInterrupting + requestStop no-op), NOT by (un)registering. This method is
      * a documented no-op kept for interface completeness / forward compatibility.
      */
     unregister(): void {
       this.diagnostics.trace("shortcut.unregister", { note: "no-pi-deregister-api" });
     }
   }
   ```

   **Imports** (verified — see research/notes.md §1):
   - `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` (TYPE only — registerShortcut is
     a method on it; we never instantiate it).
   - `import type { Diagnostics } from "../diagnostics";` (TYPE — same as every other module).
   - **NO `KeyId` import** — `@earendil-works/pi-tui` is not a direct dependency; a plain `string` is
     directly assignable to the `KeyId` parameter (verified via scratch typecheck). Pass `shortcut` straight
     through.

### Test: CREATE `tests/shortcut-manager.test.ts`

A `bun:test` suite (`import { describe, test, expect, mock } from "bun:test"`) with:
- A **capturing fake `ExtensionAPI`** (adapt `makeFakePi()` from `tests/factory.test.ts`): adds
  `registerShortcut: mock((shortcut, options) => { captured = { shortcut, ...options } })` so the test can
  assert the registration args AND invoke the captured `handler` to drive the forwarding logic. Built as
  `unknown as ExtensionAPI` (only `registerShortcut` is exercised).
- A **stateful fake `StopRequestCoordinator`** modeling the real coordinator/controller semantics: starts
  `interrupting=false`; `requestStop()` increments a call counter, flips `interrupting=true`, returns `true`
  (first press wins). This makes a rapid multi-press reduce to one `requestStop` call (EC-009/EC-010 proof).
- A **capturing `Diagnostics`** stub (adapt `makeCaptureDiag()` from `tests/reasoning-buffer.test.ts`) to
  assert which trace events fire (`shortcut.registered` / `shortcut.forwarded {accepted}` /
  `shortcut.ignored {reason}`).

Coverage (every Success Criterion):
- **register contract**: after `register(pi, "ctrl+.", coord)`, `pi.registerShortcut` called exactly once;
  captured `shortcut === "ctrl+."`; captured `description === "Stop Thinking & Do"`; captured `handler` is a
  function; a `shortcut.registered` trace fired.
- **custom shortcut flows through**: `register(pi, "ctrl+k", coord)` → captured `shortcut === "ctrl+k"`.
- **forwards on press**: invoke the captured handler once against a fresh (not-interrupting) coordinator →
  `coordinator.requestStop` called once; `shortcut.forwarded { accepted: true }` traced.
- **EC-009 + EC-010 (rapid/held → ONE request)**: against the stateful fake (flips to interrupting after
  the first `requestStop`), invoke the handler 3× rapidly → `requestStop` called **exactly once**; the 2nd &
  3rd invocations trace `shortcut.ignored { reason: "already-interrupting" }` and do NOT call `requestStop`.
  (First press wins — PRD §24.3; held-down auto-repeat discarded — EC-010.)
- **outside-Reasoning (FM-001 — handler does NOT pre-gate on reasoning)**: against a fake whose
  `alreadyInterrupting()` is always `false` and `requestStop()` always returns `false` (rejected, model not
  reasoning), invoke the handler once → `requestStop` IS called (the handler forwards; it does not second-
  guess reasoning) and `shortcut.forwarded { accepted: false }` is traced; no throw.
- **handler never throws (never-crash)**: a fake whose `requestStop()` throws → invoking the handler does
  NOT throw (the fault is swallowed) and `shortcut.handler-error` is traced.
- **unregister is a safe no-op**: `manager.unregister()` returns without throwing and traces
  `shortcut.unregister`; calling register again still works.

**Out of scope** (owned by other subtasks — do NOT implement here):
- **Factory wiring** (`src/index.ts`): constructing the coordinator + ShortcutManager + calling `register`
  + wiring the coordinator to the decorator. → **P1.M4.T4** (see Scope Boundary + Integration Points). This
  subtask does NOT touch `src/index.ts`.
- **`TransitionCoordinator` class** (`src/state/coordinator.ts`): → P1.M4.T4. ShortcutManager depends only
  on the `StopRequestCoordinator` interface, NOT the concrete class.
- **Reasoning detection / `isReasoning()` / `requestStop()` FSM** (controller): → P1.M3.T1.S1 (DONE) /
  P1.M4.T2 (DONE) / P1.M4.T4. ShortcutManager consumes the RESULT via the coordinator; it does not query the
  proxy/controller directly.
- Any change to `src/index.ts`, `src/state/*`, `src/config/*`, `src/diagnostics/*`, `src/types.ts`,
  `src/provider/*`, `src/buffer/*`, any existing test, `package.json`, `tsconfig.json`, `.gitignore`. No new
  deps. Do NOT remove `src/shortcut/.gitkeep` (harmless; or replace its role by creating `index.ts` beside
  it — the `.gitkeep` can be left or deleted; leaving it is safe).

### Success Criteria

- [ ] `src/shortcut/index.ts` exports `StopRequestCoordinator` (interface with `requestStop(): boolean` +
      `alreadyInterrupting(): boolean`) and `class ShortcutManager(diagnostics)` with `register(pi, shortcut,
      coordinator)` + `unregister()` + a private `handlePress(coordinator)` + Mode-A JSDoc documenting
      `config.shortcut` configurability + default `"ctrl+."`.
- [ ] `register` calls `pi.registerShortcut(shortcut, { description: "Stop Thinking & Do", handler: ... })`
      EXACTLY once; `shortcut` (`string`) is passed straight through (no cast, no `pi-tui` import); traces
      `shortcut.registered { shortcut }`.
- [ ] `handlePress` (a) returns early with `shortcut.ignored { reason: "already-interrupting" }` when
      `coordinator.alreadyInterrupting()` is true (EC-010); (b) otherwise calls `coordinator.requestStop()`
      and traces `shortcut.forwarded { accepted }`; (c) is wrapped in try/catch that traces
      `shortcut.handler-error` and swallows (never throws into Pi's keybinding dispatch).
- [ ] ShortcutManager holds NO mutable idempotency state (no counter / last-press / "registered" flag used
      for dedup). Idempotency is the coordinator's authority.
- [ ] `unregister()` is a documented no-op (traces `shortcut.unregister`; does not throw; cannot truly
      deregister because pi has no deregistration API — annotated in JSDoc).
- [ ] `tests/shortcut-manager.test.ts` covers every bullet above (register contract, custom shortcut,
      forward, EC-009/EC-010 one-call, FM-001 forward-then-reject, never-throw, unregister no-op).
- [ ] `npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0; `npx bun test` → ALL green
      (new suite + the 10 existing suites, NO regressions).
- [ ] No edits outside the new `src/shortcut/index.ts` + the new `tests/shortcut-manager.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **verified** pi `registerShortcut` signature (returns `void`; no unregister
API; `string` assignable to `KeyId` with no cast/import), the **exact** coordinator stop-request contract
(from `module_contracts.md`), the **complete** ShortcutManager source (interface + class + handler +
unregister, author verbatim), the **verified** test patterns (`makeFakePi` + `makeCaptureDiag` + a stateful
fake coordinator), the **verified** build/test commands, and the **critical** scope boundary (no factory
wiring — coordinator unbuilt). Every design ambiguity (why no `KeyId` import, why a structural interface,
why no local dedup state, why unregister is a no-op, why the handler ignores `ctx`, why it must not throw) is
resolved in "Known Gotchas" + `research/notes.md`.

### Documentation & References

```yaml
# PRD authority (PRD.md in repo root)
- url: PRD.md §33 "ShortcutManager Module"
  why: "THE charter. Responsibility = 'Own keyboard interaction.' Responsibilities = Register/Enable/
        Disable/Forward stop request. Invariants = 'Shortcut active only during reasoning / disabled after
        transition begins / idempotent.' NOTE: 'active only during reasoning' is enforced by the coordinator
        gate (requestStop no-ops outside Reasoning; alreadyInterrupting discards during transition), NOT by
        toggling registration."
  critical: "§33's enable/disable/idempotent invariants are the COORDINATOR's job, not ShortcutManager's
        local state. ShortcutManager forwards; the coordinator decides. (Work item: 'No local state needed.')"
- url: PRD.md §24 "Stop Signal"
  why: "§24.1 source = keyboard (only MVP source). §24.2 'request, not command — the state machine
        determines whether it may proceed.' §24.3 'multiple presses → one request; first press wins.'
        §24.4 lifetime (expires on transition complete/fail)."
  critical: "§24.2 is why the handler calls requestStop() (a request) and never aborts/decides itself.
        §24.3 idempotency = coordinator authority (alreadyInterrupting + requestStop returning false)."
- url: PRD.md §13.5 "User Interaction Layer"
  why: "The interaction layer is 'intentionally tiny': Register shortcut / Determine if shortcut is valid /
        Signal interruption / Nothing more. It does NOT abort streams, modify providers, construct requests,
        rewrite prompts, or manipulate buffers. Its job: tell the state machine 'User requested transition.'"
  critical: "This is the design constraint that makes the handler two lines. Do NOT add buffering, dedup,
        timers, or provider logic here."
- url: PRD.md §22.5 "Shortcut Availability" (under §22 Reasoning Detection)
  why: "'Shortcut becomes active' in Reasoning; inactive otherwise. Implemented via requestStop() returning
        false outside Reasoning (controller, DONE) — ShortcutManager need not query reasoning state itself."
- url: PRD.md EC-009 "Duplicate Shortcut" + EC-010 "Shortcut Held Down"
  why: "EC-009: Ctrl+. ×3 → one transition, rest ignored. EC-010: OS auto-repeat → first event accepted,
        rest discarded, no extra allocations. Both are the handler's alreadyInterrupting() guard + the
        coordinator's requestStop() idempotency."
- url: PRD.md Appendix H "Security & Privacy Model" → Logging Rules
  why: "MAY log event counts/timing/state; MUST NEVER log reasoning/prompt/output. ShortcutManager traces
        only {shortcut, accepted, reason, error} — no content (it sees none)."
- url: PRD.md Appendix E "Implementation Constraints" (Prohibited / Strongly Discouraged) + Appendix K
  why: "Prohibited: crash the host. The handler MUST swallow faults (try/catch). Appendix K: invalid config
        never prevents normal operation — a keypress must never break Pi."

# The pi integration surface (VERIFIED in node_modules — read research/notes.md §1)
- file: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts  (~line 859)
  why: "interface ExtensionAPI → registerShortcut(shortcut: KeyId, { description?: string; handler:
        (ctx: ExtensionContext) => Promise<void>|void }): void. Returns VOID. NO unregisterShortcut exists."
  pattern: "Other ExtensionAPI registrations (registerTool/registerCommand/registerFlag) follow the same
        register-only, void-return shape. pi.on('session_shutdown', ...) is the established teardown hook."
  critical: "registerShortcut returns void ⇒ no deregister handle ⇒ unregister() must be a documented no-op.
        KeyId: a plain `string` is assignable to it (verified); DO NOT import KeyId from pi-tui (not a direct
        dep — resolution fails). Pass config.shortcut straight through."

# INPUT — config default (DONE — P1.M1.T2.S1; consume, do NOT modify)
- file: src/config/index.ts
  why: "Exports frozen DEFAULT_CONFIG.shortcut === 'ctrl+.' and the validated Config.shortcut: string. The
        factory (T4) passes config.shortcut into ShortcutManager.register(); the JSDoc must reference this
        default + configurability. ShortcutManager itself does NOT import config (the shortcut is an arg)."
  gotcha: "Do NOT import config into src/shortcut — the shortcut arrives as a `register()` argument (DI).
        Importing config would couple the leaf to config and is unnecessary."

# INPUT — Diagnostics (DONE — P1.M1.T3.S1; consume the TYPE)
- file: src/diagnostics/index.ts
  why: "Exports the Diagnostics interface (trace/debug/info/warn/error). Injected via the ctor (codebase
        convention: controller.ts, buffer/index.ts, provider/proxy.ts all take Diagnostics in the ctor)."

# INPUT — the coordinator contract (P1.M4.T4 — Planned; consume the CONTRACT, not the class)
- file: plan/001_b0c6691bb424/architecture/module_contracts.md  # → "TransitionCoordinator"
  why: "TransitionCoordinator interface: setActiveProxy(proxy|undefined) / requestStop(): boolean /
        isReasoning(): boolean / alreadyInterrupting(): boolean. ShortcutManager uses requestStop() +
        alreadyInterrupting() ONLY. Define StopRequestCoordinator {requestStop, alreadyInterrupting} locally;
        T4's class satisfies it structurally."
  critical: "coordinator.ts is currently a one-line stub with NO exports. Do NOT `import { TransitionCoordinator
        }` from ../state/coordinator — it would not compile and is not needed. Depend on the local interface."

# INPUT — controller idempotency (DONE — P1.M3.T1.S1; for UNDERSTANDING, not import)
- file: src/state/controller.ts  # requestStop(): boolean — returns false unless state === "Reasoning"
  why: "Explains WHY the handler need not pre-gate on reasoning: TransitionController.requestStop() (which the
        coordinator delegates to) returns false and changes nothing outside Reasoning (FM-001/FM-002/FM-003).
        So ShortcutManager forwards unconditionally (modulo alreadyInterrupting) and the coordinator rejects."

# Established SOURCE conventions to mirror
- file: src/state/controller.ts        # Mode-A JSDoc banner + ctor-injected Diagnostics + class export
  why: "Mirror the banner structure (Responsibility/Ownership/Lifecycle/Invariants/Failure modes/'Consumed
        by:') and the `constructor(private readonly diagnostics: Diagnostics)` DI pattern."
- file: src/buffer/index.ts            # Mode-A JSDoc + frozen/snapshot-style public surface
  why: "Another small leaf module with ctor-injected diagnostics + clear invariants — match its doc tone."

# Established TEST conventions to mirror
- file: tests/factory.test.ts          # makeFakePi() + mock() spies + `unknown as ExtensionAPI`
  why: "THE template for faking ExtensionAPI. Extend makeFakePi with a capturing registerShortcut mock. Shows
        mock((event, handler)=>...) + .toHaveBeenCalledTimes(n) + toHaveBeenCalledWith(...)."
- file: tests/reasoning-buffer.test.ts # makeCaptureDiag() capturing Diagnostics stub
  why: "THE capturing-diagnostics builder (records {level,event,fields}). Reuse to assert shortcut.* traces."
- file: tests/transition-controller.test.ts  # makeCaptureDiag + count/contents assertions
  why: "Shows how to assert exact trace contents (events.find(e=>e.event===...)) — reuse for shortcut.forwarded
        {accepted} / shortcut.ignored {reason} assertions."

# Consumer contract (lands in T4; this subtask only provides the surface it needs)
- file: plan/001_b0c6691bb424/architecture/module_contracts.md  # → "ShortcutManager"
  why: "ShortcutManager contract: register(pi, shortcut, coordinator) + unregister(). Behavior: on keypress →
        coordinator.requestStop(); idempotent (PRD §24.3). This PRP implements exactly that surface."
```

### Current Codebase tree (Phase 0–3 core landed; `src/shortcut/` is the NEW target)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); type module; bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts                       # factory (DONE; DO NOT touch — T4 wires the shortcut later)
│   ├── types.ts                       # P1.M2.T1.S1 (DONE; DO NOT touch)
│   ├── provider/{decorator,proxy}.ts  # DONE (proxy gained detection in P1.M4.T2; DO NOT touch)
│   ├── state/{controller,coordinator}.ts # controller DONE; coordinator STUB (T4) — DO NOT touch
│   ├── config/index.ts                # DONE (DEFAULT_CONFIG.shortcut INPUT; DO NOT touch)
│   ├── diagnostics/index.ts           # DONE (Diagnostics TYPE INPUT; DO NOT touch)
│   ├── buffer/index.ts                # P1.M4.T1.S1 (DONE; DO NOT touch)
│   └── shortcut/
│       ├── .gitkeep                   # placeholder (leave or delete — harmless)
│       └── index.ts                   # ← THIS SUBTASK (NEW)
├── tests/
│   ├── smoke.test.ts … reasoning-buffer.test.ts   # 10 existing suites — must stay green
│   └── shortcut-manager.test.ts                   # ← THIS SUBTASK (NEW)
└── dist/                 # generated by tsc (git-ignored) — shortcut/index.{js,d.ts} emitted
```

### Desired Codebase tree with files to be added and responsibility

```bash
src/shortcut/
└── index.ts            # NEW — the ShortcutManager unit (PRD §33 / §13.5)
    #   • export interface StopRequestCoordinator { requestStop(): boolean; alreadyInterrupting(): boolean }
    #   • export class ShortcutManager(diagnostics)
    #       - register(pi, shortcut, coordinator): pi.registerShortcut(shortcut, { description:
    #         "Stop Thinking & Do", handler: () => handlePress(coordinator) })
    #       - private handlePress(coordinator): if alreadyInterrupting() → trace ignored + return; else
    #         requestStop() → trace forwarded {accepted}; wrapped in try/catch → trace handler-error.
    #       - unregister(): documented no-op (pi has no deregistration API) → trace unregister.
    #   • Mode-A JSDoc: configurable via config.shortcut, default "ctrl+."; cites PRD §33/§24/§13.5/§22.5.
    #   RESPONSIBILITY: register the shortcut + forward each press as an idempotent stop REQUEST (PRD §13.5
    #     "Nothing more"). NO local dedup state — the coordinator is the authority.
    #   REUSED BY: P1.M4.T4 factory wiring (constructs coordinator + this class + calls register()).

tests/
└── shortcut-manager.test.ts   # NEW — the ShortcutManager unit suite (bun:test)
    #   • fake ExtensionAPI capturing registerShortcut(shortcut,{description,handler})
    #   • stateful fake StopRequestCoordinator (flips to interrupting after first requestStop)
    #   • capturing Diagnostics (assert shortcut.registered/forwarded/ignored/handler-error traces)
    #   • asserts: register contract; custom-shortcut pass-through; forward on press; EC-009/EC-010 ONE
    #     requestStop across rapid presses; FM-001 forward-then-reject; never-throw; unregister no-op.
    #   RESPONSIBILITY: prove forwarding is correct AND idempotency/never-crash hold.
```
**File responsibilities**: `src/shortcut/index.ts` owns keyboard interaction ONLY (register + forward), with
no mutable dedup state and no dependency on the unbuilt coordinator class (depends on the local
`StopRequestCoordinator` interface). `tests/shortcut-manager.test.ts` owns the behavioral assertions via
fakes. No other file changes.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (factory wiring is OUT OF SCOPE — coordinator unbuilt): P1.M4.T4's TransitionCoordinator does NOT
// exist yet (src/state/coordinator.ts is a one-line stub). Wiring the factory (src/index.ts) REQUIRES a
// coordinator instance to pass into register(). THEREFORE this subtask does NOT touch src/index.ts and does
// NOT construct a coordinator. ShortcutManager depends on the LOCAL StopRequestCoordinator interface; T4's
// class will satisfy it structurally. T4 owns the factory wiring (construct coordinator + ShortcutManager +
// register + setActiveProxy↔decorator) — see Integration Points. If you "wire the factory" here you will
// either (a) not compile (no coordinator) or (b) conflict with T4. DO NOT.

// CRITICAL (do NOT import the concrete TransitionCoordinator): `import { TransitionCoordinator } from
// "../state/coordinator"` would fail to compile (the stub exports nothing). Depend on the local
// StopRequestCoordinator interface. T4's TransitionCoordinator is structurally assignable (it has
// requestStop() & alreadyInterrupting() per module_contracts.md) — zero glue.

// CRITICAL (do NOT import KeyId from pi-tui): @earendil-works/pi-tui is NOT a direct dependency (only pi-ai +
// pi-coding-agent are; pi-tui is nested under pi-coding-agent/node_modules). `import { KeyId } from
// "@earendil-works/pi-tui"` fails module resolution at typecheck. VERIFIED: a plain `string` is directly
// assignable to the registerShortcut KeyId parameter (scratch typecheck passed). Pass config.shortcut
// straight through — no cast, no import. (A future hardened pi could brand KeyId; today it is not needed.)

// CRITICAL (NO local dedup state — the coordinator is the authority): the work item mandates "No local state
// needed." Do NOT add a counter, last-press timestamp, or "pressed" flag to dedup. EC-009/EC-010 idempotency
// is `coordinator.alreadyInterrupting()` + `coordinator.requestStop()` (→ controller returns false outside
// Reasoning). Local state would duplicate the authority and RACE with it (INV-004 single-transition). The
// handler is two lines: guard on alreadyInterrupting, then requestStop.

// CRITICAL (the handler MUST NOT throw into Pi's keybinding dispatch): the extension's never-crash rule
// (Appendix E "Prohibited: crash the host"; Appendix K). Wrap handlePress's body in try/catch that traces
// `shortcut.handler-error {error}` (message only — never content) and swallows. A coordinator fault must
// never propagate out of the handler.

// GOTCHA (handler ignores ctx — fewer-params assignability): pi's handler type is
// (ctx: ExtensionContext) => Promise<void>|void. A handler with FEWER params is assignable, so `() => {...}`
// compiles (verified). ShortcutManager does not use ctx (PRD §13.5 "Nothing more"). Do not be tempted to read
// ctx.signal / ctx.abort() — that is NOT this layer's job (abort is the proxy/coordinator's, P1.M5).

// GOTCHA (registerShortcut returns void — no deregister): there is NO unregisterShortcut/removeShortcut in
// the pi SDK (verified by grep). So unregister() CANNOT truly remove the binding; it is session-scoped
// (dies when Pi tears the extension down). Implement unregister() as a documented no-op (trace + return).
// The shortcut's dynamic DISABLE during/after a transition is the coordinator gate's job, not (un)register.

// GOTCHA (the shortcut stays registered for the whole session — do NOT toggle registration per state):
// PRD §33 "active only during reasoning / disabled after transition begins" is enforced by the coordinator
// (requestStop no-ops outside Reasoning; alreadyInterrupting discards during transition), NOT by
// register/unregister on every state change. Register ONCE at init (T4 factory). Never re-register per event.

// GOTCHA (description is optional but we always set it): pi's options.description is optional; the work item
// specifies description: "Stop Thinking & Do". Set it verbatim (it surfaces in pi's keybinding help UI).

// GOTCHA (isolatedModules + strict): ExtensionAPI and Diagnostics are TYPES → `import type`. ShortcutManager
// and StopRequestCoordinator are VALUES/types you declare locally → `export class` / `export interface`. Do
// not value-import a type-only symbol from pi-coding-agent.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke `npx bun run typecheck` / `npx bun run build` /
// `npx bun test`, NOT bare `tsc`/`bun`.

// GOTCHA (tests/ excluded from the build): tsconfig exclude:["tests"] → typecheck validates src/ ONLY. The
// new test file is validated by `npx bun test` (Bun transpiles TS natively). The new test imports from
// "../src/shortcut" + "../src/diagnostics" + "@earendil-works/pi-coding-agent".

// GOTCHA (config.shortcut is NOT imported into src/shortcut): the shortcut arrives as a register() argument
// (dependency injection from the factory). Importing config would couple this leaf to config unnecessarily
// and is wrong. The DEFAULT ("ctrl+.") is referenced ONLY in JSDoc (for human readers), not in code.
```

---

## Implementation Blueprint

### Data models and structure

No data models beyond one tiny structural interface (dependency-inversion seam) + the class. The class owns
NO mutable fields other than the injected `diagnostics`:

```typescript
// INPUTS (DONE/contract — consumed, not modified)
//   ExtensionAPI.registerShortcut(shortcut: KeyId, { description?, handler }): void   (pi SDK)
//   Diagnostics                                        (../diagnostics — ctor-injected)
//   config.shortcut: string                            (arrives as a register() arg — NOT imported)
//   StopRequestCoordinator (LOCAL interface — satisfied structurally by P1.M4.T4 TransitionCoordinator):
//     requestStop(): boolean
//     alreadyInterrupting(): boolean

// OWNED — this subtask
//   export interface StopRequestCoordinator { requestStop(): boolean; alreadyInterrupting(): boolean }
//   export class ShortcutManager {
//     constructor(private readonly diagnostics: Diagnostics) {}
//     register(pi: ExtensionAPI, shortcut: string, coordinator: StopRequestCoordinator): void
//     unregister(): void
//     private handlePress(coordinator: StopRequestCoordinator): void
//   }
//   // NO other fields. NO mutable dedup state.
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE src/shortcut/index.ts — the ShortcutManager unit
  - IMPORT (type): `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
    `import type { Diagnostics } from "../diagnostics";`
  - DO NOT import KeyId (not a direct dep; string is assignable — verified). DO NOT import config (shortcut
    is a register() arg). DO NOT import TransitionCoordinator (stub, unbuilt).
  - DECLARE `export interface StopRequestCoordinator { requestStop(): boolean; alreadyInterrupting(): boolean }`
    with Mode-A JSDoc citing PRD §24.2/§24.3.
  - DECLARE `export class ShortcutManager` with `constructor(private readonly diagnostics: Diagnostics)`.
  - IMPLEMENT `register(pi, shortcut: string, coordinator: StopRequestCoordinator): void` — calls
    `pi.registerShortcut(shortcut, { description: "Stop Thinking & Do", handler: () =>
    this.handlePress(coordinator) })` then `this.diagnostics.trace("shortcut.registered", { shortcut })`.
  - IMPLEMENT `private handlePress(coordinator): void` — try { if (coordinator.alreadyInterrupting()) {
    trace("shortcut.ignored",{reason:"already-interrupting"}); return; } const accepted =
    coordinator.requestStop(); trace("shortcut.forwarded",{accepted}); } catch(err) {
    error("shortcut.handler-error",{error: msg}); }  (see reference code verbatim).
  - IMPLEMENT `unregister(): void` — `this.diagnostics.trace("shortcut.unregister", { note:
    "no-pi-deregister-api" });` (documented no-op).
  - WRITE Mode-A JSDoc banner (Responsibility / Ownership / Lifecycle / Invariants / Failure modes / Consumed
    by:) citing PRD §33/§24/§13.5/§22.5, EC-009/EC-010, and documenting that the shortcut is configurable via
    `config.shortcut` with default `"ctrl+."` (reference src/config DEFAULT_CONFIG.shortcut). Document that
    ShortcutManager holds no local dedup state (coordinator is authority) and that unregister is a no-op (pi
    has no deregistration API).
  - NAMING: `ShortcutManager` (class), `StopRequestCoordinator` (interface), `register`/`unregister`/
    `handlePress` (methods), `shortcut.registered`/`shortcut.forwarded`/`shortcut.ignored`/
    `shortcut.handler-error`/`shortcut.unregister` (diagnostic events). camelCase methods; kebab/snake-free
    event names matching existing `transition.*` / `proxy.*` convention.
  - PLACEMENT: src/shortcut/index.ts (NEW). Leave src/shortcut/.gitkeep (harmless) or delete it.
  - DO NOT touch: index.ts, coordinator.ts, controller.ts, config, diagnostics, types, provider/*, buffer/*.

Task 2: CREATE tests/shortcut-manager.test.ts (the ShortcutManager unit suite)
  - IMPORT (value): { describe, test, expect, mock } from "bun:test";
    { ShortcutManager } from "../src/shortcut";
    type { StopRequestCoordinator } from "../src/shortcut";
    type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
    type { Diagnostics } from "../src/diagnostics".
  - IMPLEMENT makeCaptureDiag() (adapt tests/reasoning-buffer.test.ts): returns { diag: Diagnostics, events:
    Captured[] } recording {level,event,fields}.
  - IMPLEMENT makeFakePi() (adapt tests/factory.test.ts): an object with `registerShortcut: mock((shortcut,
    options) => { captured = { shortcut, description: options.description, handler: options.handler } })`,
    returned as `unknown as ExtensionAPI`. Expose `captured` + the mock for call assertions.
  - IMPLEMENT makeStatefulFakeCoordinator() (EC-009/EC-010 model): `{ coordinator: { alreadyInterrupting:
    () => interrupting, requestStop: () => { calls++; interrupting = true; return true } }, getCalls: () =>
    calls }` — first requestStop flips to interrupting so subsequent presses are discarded.
  - IMPLEMENT makeRejectingFakeCoordinator() (FM-001 model): alwaysInterrupting=false, requestStop=()=>false
    (rejected — model not reasoning).
  - IMPLEMENT describe/test blocks (every Success Criterion + MOCKING intent):
      • REGISTER CONTRACT: register(pi,"ctrl+.",coord) → pi.registerShortcut called exactly once; captured
        shortcut==="ctrl+."; description==="Stop Thinking & Do"; handler is a function;
        events contain shortcut.registered {shortcut:"ctrl+."}.
      • CUSTOM SHORTCUT: register(pi,"ctrl+k",coord) → captured shortcut==="ctrl+k".
      • FORWARDS ON PRESS: fresh stateful fake (not interrupting); invoke captured handler once →
        requestStop called once; events contain shortcut.forwarded {accepted:true}.
      • EC-009 + EC-010 (rapid/held → ONE request): stateful fake; invoke handler 3× → getCalls()===1
        (requestStop called exactly once); events show ONE shortcut.forwarded + TWO shortcut.ignored
        {reason:"already-interrupting"} (2nd & 3rd discarded). First-press-wins.
      • FM-001 (handler does NOT pre-gate on reasoning): rejecting fake (alreadyInterrupting=false,
        requestStop=false); invoke handler once → requestStop IS called (handler forwards; coordinator
        rejects) and events contain shortcut.forwarded {accepted:false}; no throw.
      • NEVER-THROW: fake whose requestStop throws → expect(() => handler()).not.toThrow(); events contain
        shortcut.handler-error.
      • UNREGISTER NO-OP: expect(() => manager.unregister()).not.toThrow(); events contain
        shortcut.unregister; register still callable afterward.
  - FOLLOW pattern: tests/factory.test.ts (makeFakePi + mock spies + unknown as ExtensionAPI),
    tests/reasoning-buffer.test.ts (makeCaptureDiag), tests/transition-controller.test.ts (event assertions).
  - PLACEMENT: tests/shortcut-manager.test.ts.

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics (shortcut/index.ts imports only Diagnostics type + pi API type).
  - RUN: npx bun run build      → exit 0; dist/shortcut/index.{js,d.ts} emitted.
  - RUN: npx bun test tests/shortcut-manager.test.ts  → the new suite green.
  - RUN: npx bun test           → ALL green (new suite + the 10 existing suites — ZERO regressions).
  - RUN: Level 1–3 gates below.
```

### Implementation Patterns & Key Details

```typescript
// ── src/shortcut/index.ts — author verbatim ────────────────────────────────────────────────────────

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Diagnostics } from "../diagnostics";

/**
 * The stop-request surface {@link ShortcutManager} depends on (PRD §13.5 / §24). This is a
 * dependency-inversion seam: it lets ShortcutManager compile BEFORE P1.M4.T4's concrete
 * `TransitionCoordinator` exists. P1.M4.T4's `TransitionCoordinator` declares `requestStop()` and
 * `alreadyInterrupting()` (see plan/.../architecture/module_contracts.md → "TransitionCoordinator"), so it
 * is STRUCTURALLY ASSIGNABLE to this interface — no adapter needed.
 */
export interface StopRequestCoordinator {
  /** Raise the stop request (PRD §24.2 — a request, not a command). Returns whether it was accepted: `false`
   *  when the FSM is not in `Reasoning` (FM-001) or a transition is already in flight (PRD §24.3). */
  requestStop(): boolean;
  /** Whether a transition is already in progress (PRD §24.3 + EC-010). The handler discards repeats while
   *  this is `true`. */
  alreadyInterrupting(): boolean;
}

/**
 * # ShortcutManager — the user-interaction layer (PRD §33 / §13.5).
 *
 * **Responsibility** (PRD §33): "Own keyboard interaction." **Responsibilities**: Register shortcut /
 * Enable shortcut / Disable shortcut / Forward stop request. **Invariants** (PRD §33): "Shortcut active only
 * during reasoning / disabled after transition begins / idempotent." NOTE: the enable/disable/idempotent
 * invariants are enforced by the {@link StopRequestCoordinator} gate (`requestStop()` no-ops outside
 * `Reasoning`; `alreadyInterrupting()` discards during a transition) — NOT by ShortcutManager toggling its
 * registration or holding dedup state. PRD §13.5: the layer does ONLY register / determine-valid / signal —
 * "Nothing more."
 *
 * **Configurability**: the shortcut is user-configurable via `config.shortcut` (default `"ctrl+."` — see
 * `src/config` `DEFAULT_CONFIG.shortcut`, PRD §47 / Appendix K). The factory (P1.M4.T4) reads the validated
 * config and passes `config.shortcut` into {@link register}; ShortcutManager itself does not import config.
 *
 * **Idempotency (PRD §24.3 — "first press wins")**: ShortcutManager holds NO local dedup state. The
 * coordinator is the authority: {@link StopRequestCoordinator.alreadyInterrupting} discards auto-repeat /
 * duplicate presses once a transition is in flight (EC-009 Duplicate Shortcut; EC-010 Shortcut Held Down),
 * and {@link StopRequestCoordinator.requestStop} no-ops (returns `false`) outside `Reasoning` (FM-001). This
 * matches the work item's "No local state needed — the coordinator is the authority."
 *
 * **Lifecycle**: register ONCE at extension init (the factory, P1.M4.T4). The shortcut stays bound for the
 * session; its effect is gated by the coordinator. {@link unregister} is a documented no-op (pi's
 * `registerShortcut` returns void and the SDK exposes no deregistration API — the binding is session-scoped).
 *
 * **Failure modes**: the per-press handler is wrapped in try/catch that traces `shortcut.handler-error` and
 * swallows — a coordinator fault can never propagate into Pi's keybinding dispatch (extension never-crash
 * rule, PRD Appendix E/K).
 *
 * Consumed by: the factory (P1.M4.T4) constructs it and calls `register(pi, config.shortcut, coordinator)`.
 */
export class ShortcutManager {
  /**
   * @param diagnostics  Shared structured logger (PRD §36). Privacy (Appendix H): only shortcut lifecycle
   *                     events + the requestStop() boolean result are logged — never content (there is none).
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Register the stop shortcut with Pi (PRD §33 / §13.5 / §24.1).
   *
   * @param pi           Pi extension API (`registerShortcut`).
   * @param shortcut     The configured shortcut string (e.g. `"ctrl+."`; configurable via `config.shortcut`,
   *                     default `"ctrl+."`). Passed straight to `pi.registerShortcut`.
   * @param coordinator  The stop-request authority (P1.M4.T4 `TransitionCoordinator` satisfies
   *                     {@link StopRequestCoordinator}).
   */
  register(pi: ExtensionAPI, shortcut: string, coordinator: StopRequestCoordinator): void {
    pi.registerShortcut(shortcut, {
      description: "Stop Thinking & Do",
      handler: () => this.handlePress(coordinator),
    });
    this.diagnostics.trace("shortcut.registered", { shortcut });
  }

  /**
   * Per-press handler (PRD §13.5 "Signal interruption — Nothing more"). Stateless; the coordinator is the
   * authority. Wrapped in try/catch so a coordinator fault never reaches Pi's keybinding dispatch.
   */
  private handlePress(coordinator: StopRequestCoordinator): void {
    try {
      // EC-010 (key held / OS auto-repeat) + PRD §24.3: discard once a transition is in flight.
      if (coordinator.alreadyInterrupting()) {
        this.diagnostics.trace("shortcut.ignored", { reason: "already-interrupting" });
        return;
      }
      // Raise the REQUEST (PRD §24.2). The coordinator → controller is idempotent: returns false and changes
      // nothing outside Reasoning (FM-001). ShortcutManager holds no dedup state of its own.
      const accepted = coordinator.requestStop();
      this.diagnostics.trace("shortcut.forwarded", { accepted });
    } catch (err) {
      // Never crash the host (PRD Appendix E/K).
      this.diagnostics.error("shortcut.handler-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Lifecycle counterpart to {@link register} (PRD §33 "Disable shortcut"). NOTE: Pi's `registerShortcut`
   * returns `void` and the SDK exposes NO deregistration API, so the binding cannot be removed here — it is
   * session-scoped (Pi tears it down with the extension). The shortcut's dynamic *disable* during/after a
   * transition is enforced by the coordinator gate, not by (un)registering. This method is a documented
   * no-op kept for interface completeness / forward compatibility; it does not throw.
   */
  unregister(): void {
    this.diagnostics.trace("shortcut.unregister", { note: "no-pi-deregister-api" });
  }
}
```

```typescript
// ── tests/shortcut-manager.test.ts — author verbatim (adapt helpers from existing suites) ───────────

import { describe, test, expect, mock } from "bun:test";
import { ShortcutManager, type StopRequestCoordinator } from "../src/shortcut";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Diagnostics } from "../src/diagnostics";

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub (adapted from tests/reasoning-buffer.test.ts). */
function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info: (e, f) => events.push({ level: "info", event: e, fields: f }),
    warn: (e, f) => events.push({ level: "warn", event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}

interface CapturedRegistration {
  shortcut: string;
  description?: string;
  handler: (ctx: unknown) => unknown;
}

/** Fake ExtensionAPI that captures registerShortcut (adapted from tests/factory.test.ts makeFakePi). */
function makeFakePi() {
  let captured: CapturedRegistration | undefined;
  const registerShortcut = mock((shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) => {
    captured = { shortcut, description: options.description, handler: options.handler };
  });
  const pi = { registerShortcut } as unknown as ExtensionAPI;
  return { pi, registerShortcut, captured: () => captured };
}

/** Stateful fake coordinator: first requestStop flips to interrupting → models EC-009/EC-010. */
function makeStatefulFakeCoordinator(): { coordinator: StopRequestCoordinator; getCalls: () => number } {
  let interrupting = false;
  let calls = 0;
  const coordinator: StopRequestCoordinator = {
    alreadyInterrupting: () => interrupting,
    requestStop: () => {
      calls++;
      interrupting = true; // first press wins
      return true;
    },
  };
  return { coordinator, getCalls: () => calls };
}

/** Rejecting fake coordinator: never interrupting, requestStop always false (model not reasoning — FM-001). */
function makeRejectingFakeCoordinator(): StopRequestCoordinator {
  return {
    alreadyInterrupting: () => false,
    requestStop: () => false,
  };
}

describe("ShortcutManager — register contract", () => {
  test("register calls pi.registerShortcut once with the shortcut + 'Stop Thinking & Do' + a handler", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const manager = new ShortcutManager(diag);
    const { coordinator } = makeStatefulFakeCoordinator();

    manager.register(pi.pi, "ctrl+.", coordinator);

    expect(pi.registerShortcut).toHaveBeenCalledTimes(1);
    const reg = pi.captured();
    expect(reg?.shortcut).toBe("ctrl+.");
    expect(reg?.description).toBe("Stop Thinking & Do");
    expect(typeof reg?.handler).toBe("function");
    expect(events.some((e) => e.event === "shortcut.registered" && e.fields?.shortcut === "ctrl+.")).toBe(true);
  });

  test("a custom shortcut flows through unchanged", () => {
    const { diag } = makeCaptureDiag();
    const pi = makeFakePi();
    new ShortcutManager(diag).register(pi.pi, "ctrl+k", makeStatefulFakeCoordinator().coordinator);
    expect(pi.captured()?.shortcut).toBe("ctrl+k");
  });
});

describe("ShortcutManager — forwarding & idempotency (PRD §24.3, EC-009, EC-010)", () => {
  test("a single press forwards exactly one requestStop", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const fake = makeStatefulFakeCoordinator();
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", fake.coordinator);

    pi.captured()!.handler(undefined);

    expect(fake.getCalls()).toBe(1);
    expect(events.some((e) => e.event === "shortcut.forwarded" && e.fields?.accepted === true)).toBe(true);
  });

  test("EC-009/EC-010: rapid/held presses → requestStop called EXACTLY once (first press wins)", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const fake = makeStatefulFakeCoordinator();
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", fake.coordinator);
    const handler = pi.captured()!.handler;

    handler(undefined); // first: accepted, flips to interrupting
    handler(undefined); // EC-010 discard
    handler(undefined); // EC-010 discard

    expect(fake.getCalls()).toBe(1); // exactly one requestStop
    const ignored = events.filter((e) => e.event === "shortcut.ignored");
    expect(ignored.length).toBe(2);
    expect(ignored.every((e) => e.fields?.reason === "already-interrupting")).toBe(true);
  });

  test("FM-001: the handler does NOT pre-gate on reasoning — it forwards; the coordinator rejects", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const rejecting = makeRejectingFakeCoordinator();
    const spy = mock(rejecting.requestStop); // ensure it IS called
    const coordinator: StopRequestCoordinator = { alreadyInterrupting: rejecting.alreadyInterrupting, requestStop: spy };
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", coordinator);

    expect(() => pi.captured()!.handler(undefined)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1); // forwarded (handler does not second-guess reasoning)
    expect(events.some((e) => e.event === "shortcut.forwarded" && e.fields?.accepted === false)).toBe(true);
  });

  test("never-throws: a coordinator fault is swallowed + logged (PRD Appendix E/K)", () => {
    const { diag, events } = makeCaptureDiag();
    const pi = makeFakePi();
    const coordinator: StopRequestCoordinator = {
      alreadyInterrupting: () => false,
      requestStop: () => {
        throw new Error("coordinator boom");
      },
    };
    new ShortcutManager(diag).register(pi.pi, "ctrl+.", coordinator);

    expect(() => pi.captured()!.handler(undefined)).not.toThrow();
    expect(events.some((e) => e.event === "shortcut.handler-error")).toBe(true);
  });
});

describe("ShortcutManager — unregister", () => {
  test("unregister is a safe no-op (pi has no deregistration API)", () => {
    const { diag, events } = makeCaptureDiag();
    const manager = new ShortcutManager(diag);
    expect(() => manager.unregister()).not.toThrow();
    expect(events.some((e) => e.event === "shortcut.unregister")).toBe(true);
  });
});
```

### Integration Points

```yaml
# THIS SUBTASK provides the unit; the WIRING is owned by P1.M4.T4 (the coordinator owner). The exact wiring
# T4 will add to src/index.ts (NOT to be done here — documented so T4 is mechanical):
ROUTES:   # src/index.ts (P1.M4.T4 — DO NOT TOUCH in this subtask)
  - construct: "const coordinator = new TransitionCoordinator(diagnostics);"  # P1.M4.T4 deliverable
  - construct: "const shortcut = new ShortcutManager(diagnostics);"
  - wire:      "shortcut.register(pi, config.shortcut, coordinator);"
  - wire-decorator: "decorator.setCoordinator(coordinator)"  # or pass into ProviderDecorator ctor so its
               # wrapped streamSimple consults coordinator.alreadyInterrupting() (decision tree step D)
  - teardown:  "pi.on('session_shutdown', () => { shortcut.unregister(); coordinator.setActiveProxy(undefined);
               decorator.shutdown(); })"  # order: optional; all are guarded
  - GUARD:     "only register the shortcut when config.enabled === true (EC-016); else skip (the coordinator
               # gates everything anyway, but skipping registration avoids a dead binding)."
  NOTE: |
    T4 must also satisfy the decorator's `coordinator.alreadyInterrupting()` consultation point (PRD §19.5
    decision tree step D) so an in-flight transition's requests pass-through-delegate rather than re-proxy.
    That is T4's concern, not ShortcutManager's.

CONFIG:   # src/config/index.ts (DONE — no change)
  - field: "shortcut: string  # default 'ctrl+.'  (Config.shortcut, validated non-empty string)"
  - usage: "factory (T4) passes config.shortcut into ShortcutManager.register(pi, config.shortcut, coordinator)"

DIAGNOSTICS:  # src/diagnostics (DONE — no change)
  - events-added: "shortcut.registered / shortcut.forwarded {accepted} / shortcut.ignored {reason} /
                   shortcut.handler-error {error} / shortcut.unregister"
  - privacy: "all fields are non-content (shortcut id, boolean, reason enum, error message) — Appendix H OK"
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after creating src/shortcut/index.ts — fix before proceeding.
npx bun run typecheck     # = tsc --noEmit; validates src/ (incl. new src/shortcut/index.ts). Expect 0 errors.
npx bun run build         # = tsc; expect exit 0; dist/shortcut/index.{js,d.ts} emitted.
# (No ruff/mypy — this is TypeScript. tsc IS the lint+type gate; the project has no separate ESLint config.)

# Expected: Zero errors. If errors exist, READ the output and fix before proceeding.
# Common fix: if tsc complains KeyId is not assignable to string-param usage — re-read the "do NOT import
# KeyId" gotcha (a plain string IS assignable; verified). Do not add a cast or a pi-tui import.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the new unit in isolation.
npx bun test tests/shortcut-manager.test.ts -v   # the new suite — ALL green.

# Full suite for regression confirmation.
npx bun test                                      # new suite + the 10 existing suites — ZERO regressions.

# Expected: All tests pass. If failing, debug root cause and fix the implementation (not the test contract).
# Key cases that MUST pass: EC-009/EC-010 (getCalls()===1 across 3 presses), FM-001 (requestStop called once
# even when rejected), never-throw (handler swallows coordinator fault), register contract (description
# === "Stop Thinking & Do", exactly one registerShortcut call).
```

### Level 3: Integration Testing (System Validation)

```bash
# Build smoke: the extension still compiles + loads shape-intact.
npx bun run build && node -e "import('./dist/index.js').then(m => console.log('default export:', typeof m.default))"
# Expected: prints "default export: function" (the factory). ShortcutManager is NOT wired here (T4 wires it),
# so loading must NOT register a shortcut yet — confirming this subtask did not alter the factory.

# Confirm NO regressions in the factory's existing behaviour (it must be byte-identical to pre-change):
npx bun test tests/factory.test.ts -v
# Expected: all green (this subtask did not touch src/index.ts).

# (End-to-end "press ctrl+. → transition" cannot be exercised until P1.M4.T4 wires the coordinator +
# P1.M5/P1.M6/P1.M7 land the abort+replacement+splice flow. That integration test belongs to a later phase,
# not this unit subtask. The unit suite fully covers ShortcutManager's contract with fakes.)

# Expected: build clean, factory suite green, no shortcut registered at load (wiring deferred to T4).
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Contract inspection: confirm the exported surface matches what P1.M4.T4 will consume.
node -e "import('./dist/shortcut/index.js').then(m => {
  console.log('ShortcutManager:', typeof m.ShortcutManager);
  console.log('StopRequestCoordinator export present:', 'StopRequestCoordinator' in m || true); // type-only, erased at runtime
})"
# Expected: "ShortcutManager: function". (StopRequestCoordinator is an interface → erased at runtime; that's
# fine — T4 consumes it as a type.)

# Manual idempotency reasoning check (the PRD §24.3 invariant): re-read the EC-009/EC-010 test — it MUST
# assert getCalls()===1 after 3 presses against the stateful fake. If it asserts >1, the implementation
# wrongly added local state or mis-guarded. Re-read the "NO local dedup state" gotcha.

# Expected: contract surface present; idempotency invariant proven by the unit test.
```

## Final Validation Checklist

### Technical Validation

- [ ] All validation levels completed: `npx bun run typecheck` → 0; `npx bun run build` → exit 0;
      `npx bun test` → ALL green (new suite + 10 existing, no regressions).
- [ ] No type errors (`typecheck` clean); no build errors.
- [ ] No formatting/structural drift from codebase conventions (ctor-injected Diagnostics; Mode-A JSDoc;
      kebab/snake-free `shortcut.*` event names matching `transition.*`/`proxy.*`).

### Feature Validation

- [ ] All success criteria from "What" section met.
- [ ] `register` calls `pi.registerShortcut` exactly once with `description: "Stop Thinking & Do"` + the given
      shortcut (default path `"ctrl+."`).
- [ ] Manual/idempotency test (Level 4) confirms EC-009/EC-010: 3 rapid presses → exactly one `requestStop`.
- [ ] Error cases handled gracefully (EC-010 discard; FM-001 forward-then-reject; coordinator fault swallowed
      + logged — never thrown into Pi).
- [ ] Integration point (factory wiring) clearly documented for P1.M4.T4 (this subtask does NOT wire it).

### Code Quality Validation

- [ ] Follows existing codebase patterns (ctor-injected `Diagnostics`; Mode-A JSDoc banner mirroring
      `controller.ts`/`buffer/index.ts`; structural interface for the unbuilt dependency).
- [ ] File placement matches the desired tree (`src/shortcut/index.ts` + `tests/shortcut-manager.test.ts`).
- [ ] Anti-patterns avoided (no local dedup state; no pi-tui import; no concrete coordinator import; no
      factory modification; handler never throws).
- [ ] No new dependencies added (only `import type` from existing pi-coding-agent + ../diagnostics).
- [ ] JSDoc documents `config.shortcut` configurability + default `"ctrl+."`.

### Documentation & Deployment

- [ ] Mode-A JSDoc is self-documenting (Responsibility/Ownership/Lifecycle/Invariants/Failure modes/Consumed
      by:) and cites PRD §33/§24/§13.5/§22.5, EC-009/EC-010.
- [ ] Diagnostic events are informative but non-verbose (5 events, all non-content).
- [ ] No new environment variables (the shortcut is a config field, already defined in P1.M1.T2.S1).

---

## Anti-Patterns to Avoid

- ❌ Don't add local dedup state (counter / last-press / "pressed" flag) — the coordinator is the authority
  (PRD §24.3; work item "No local state needed"). Local state races with the coordinator and breaks INV-004.
- ❌ Don't wire the factory (`src/index.ts`) in this subtask — the coordinator (P1.M4.T4) doesn't exist; it
  won't compile / will conflict. ShortcutManager is the unit; T4 owns wiring.
- ❌ Don't `import { KeyId } from "@earendil-works/pi-tui"` — not a direct dependency; resolution fails. A
  plain `string` is assignable to the `KeyId` param (verified).
- ❌ Don't `import { TransitionCoordinator } from "../state/coordinator"` — the file is a stub; it won't
  compile and isn't needed. Depend on the local `StopRequestCoordinator` interface.
- ❌ Don't let the handler throw — wrap it in try/catch (extension never-crash rule, PRD Appendix E/K).
- ❌ Don't pre-gate the handler on reasoning (`isReasoning()`) — the work item only specifies
  `alreadyInterrupting()` + `requestStop()`. `requestStop()` already no-ops outside Reasoning (controller).
  Adding an `isReasoning()` check duplicates the coordinator's authority and couples ShortcutManager to
  reasoning detection it should not know about (PRD §13.5 "Nothing more").
- ❌ Don't toggle registration per state (register/unregister on every transition) — register ONCE; the
  coordinator gate handles dynamic enable/disable (PRD §33).
- ❌ Don't use the handler's `ctx` for abort/signal — that is NOT this layer's job (PRD §13.5
  non-responsibilities; abort is P1.M5). The handler ignores `ctx`.
- ❌ Don't skip validation because "it should work" — run the gates; the EC-009/EC-010 one-call assertion is
  the load-bearing correctness proof.
- ❌ Don't hardcode `"ctrl+."` in code — it arrives via `config.shortcut` (the register() arg). The default is
  referenced only in JSDoc (for humans); code uses the parameter.

---

## Confidence Score

**9 / 10** for one-pass implementation success.

Rationale: the deliverable is small and fully specified (one class + one interface + one test file, all
authored verbatim above). Every external fact is verified against the installed SDK (the `registerShortcut`
signature; `string`→`KeyId` assignability; no unregister API; the coordinator contract). The one structural
risk — the unbuilt `TransitionCoordinator` — is resolved cleanly by the local `StopRequestCoordinator`
structural interface (compiles now; T4's class satisfies it with zero glue). The only residual uncertainty
(the −1) is whether the orchestrator expects factory wiring in this subtask vs. T4; the PRP resolves this
explicitly by deferring wiring to T4 with prescribed code, which is the only compilable, conflict-free
option. The unit suite fully covers the contract with fakes, so correctness is provable without the
coordinator existing.
