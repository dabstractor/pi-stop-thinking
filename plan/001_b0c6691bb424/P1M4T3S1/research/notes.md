# Research Notes — P1.M4.T3.S1 (ShortcutManager)

> Supporting research for `PRP.md`. Captures verified API facts, scope boundaries, and the design
> rationale for the ShortcutManager unit. All facts below were verified against the live codebase +
> installed pi SDK (`@earendil-works/pi-coding-agent@0.80.3`, `@earendil-works/pi-ai@0.74.2`).

---

## 1. The pi `registerShortcut` API (VERIFIED — the core integration surface)

**Source:** `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (~line 859),
inside `interface ExtensionAPI`.

```typescript
/** Register a keyboard shortcut. */
registerShortcut(shortcut: KeyId, options: {
    description?: string;
    handler: (ctx: ExtensionContext) => Promise<void> | void;
}): void;
```

**Verified facts:**
- **Returns `void`.** There is NO unsubscribe/dispose handle returned by `registerShortcut`.
- **There is NO `unregisterShortcut` / `removeShortcut` / `deregisterShortcut` anywhere in the pi
  SDK** (verified by `grep -rni` across the whole `@earendil-works/pi-coding-agent/dist/`). ⇒ A true
  deregistration is impossible via the pi public API; the shortcut binding is scoped to the
  extension/session lifetime and dies when Pi tears the extension down.
- `description` is **optional** (`description?: string`).
- The `handler` receives an `ExtensionContext` (`(ctx: ExtensionContext) => ...`). **But a handler with
  FEWER parameters is assignable** in TypeScript, so `() => { ... }` satisfies the signature (verified —
  this is how the work item phrases it: `handler: () => coordinator.requestStop()`). We pass `() => {...}`.
- `handler` may be `async` / return a `Promise`. Ours is synchronous (forwarding is sync). Returning
  `void` is fine.

### KeyId assignability (VERIFIED via scratch typecheck)

`KeyId` is imported by pi-coding-agent from `@earendil-works/pi-tui` (the tui keybinding vocabulary).
**`@earendil-works/pi-tui` is NOT a direct dependency of this project** (only `pi-ai` + `pi-coding-agent`
are; `pi-tui` is nested under
`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`). Therefore our source
**cannot `import { KeyId } from "@earendil-works/pi-tui"`** — module resolution would fail at typecheck.

**Verified via scratch typecheck inside the project (using the real `tsconfig`):**
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
declare const pi: ExtensionAPI;
const shortcut: string = "ctrl+.";
pi.registerShortcut(shortcut, { description: "x", handler: () => {} });   // ✅ COMPILES
```
⇒ **A plain `string` is directly assignable to the `KeyId` parameter.** No cast and no `pi-tui` import
are required. `config.shortcut: string` flows straight into `pi.registerShortcut(shortcut, ...)`. (KeyId
is a `string`-based type; passing a `string` is accepted.) This is the simplest, dependency-free path and
is what the PRP prescribes. (If a future pi version tightens KeyId to a branded/template-literal type, a
`shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0]` cast also typechecks today — but it is
unnecessary now.)

### ExtensionContext (for completeness — the handler ignores it)

The `ctx: ExtensionContext` the handler receives exposes `signal`, `abort()`, `isIdle()`, `model`,
`cwd`, etc. (types.d.ts ~line 208). **ShortcutManager does NOT use `ctx`** — it only forwards to the
coordinator (PRD §13.5 "Nothing more" than register/determine-valid/signal-interruption). We accept it
positionally as `()` (fewer-params assignability) and ignore it.

---

## 2. The coordinator dependency (P1.M4.T4 — NOT yet built)

`src/state/coordinator.ts` today is a single-line stub: `// TransitionCoordinator — P1.M4.T4.S1`. There is
NO exported class yet. **P1.M4.T4 is `Planned` (2 pts) and runs AFTER this subtask** (T3 runs in parallel
with T2; T4 is next). ⇒ ShortcutManager **cannot import a concrete `TransitionCoordinator` class** (it
would not compile), and the factory cannot construct one.

**The coordinator's stop-request contract** (from `plan/001_b0c6691bb424/architecture/module_contracts.md`
→ "TransitionCoordinator"):
```
setActiveProxy(proxy: StreamProxy | undefined): void
requestStop(): boolean        // delegates to active proxy if reasoning active
isReasoning(): boolean        // delegates to active proxy
alreadyInterrupting(): boolean
```

**Resolution (dependency inversion):** ShortcutManager depends on a **minimal structural interface**
(`StopRequestCoordinator { requestStop(): boolean; alreadyInterrupting(): boolean }`) declared in
`src/shortcut/index.ts`. When P1.M4.T4 lands its `TransitionCoordinator` class, TypeScript's structural
typing makes it **automatically assignable** to `StopRequestCoordinator` (it has both methods). This
compiles TODAY (no dependency on the unbuilt class) and integrates with ZERO glue code in T4. This is the
same "consume the contract, not the concrete" pattern used throughout this milestone.

### Idempotency authority — who owns what (the work item's "no local state" rule)

The work item is explicit: *"No local state needed — the coordinator is the authority."* Two distinct
idempotency mechanisms, BOTH on the coordinator/controller side, NOT in ShortcutManager:

1. **`coordinator.alreadyInterrupting()` → EC-010 guard.** OSes auto-repeat key events while held. The
   handler checks this FIRST and discards the event ("does nothing") once a transition is in flight.
   (PRD §24.3, EC-010 "Shortcut Held Down".)
2. **`coordinator.requestStop()` → the authoritative idempotent check.** Delegates to
   `TransitionController.requestStop()` (verified in `src/state/controller.ts`), which returns `false`
   and changes NOTHING when the FSM is not in `Reasoning` — so duplicate presses outside the valid window
   are no-ops, and the first legal press wins (PRD §24.3 "first press wins"; EC-009 "Duplicate
   Shortcut"). INV-004 guarantees "at most one interruption transition per response".

⇒ ShortcutManager's handler is therefore:
```typescript
() => {
  if (coordinator.alreadyInterrupting()) return;   // EC-010: discard auto-repeat during transition
  coordinator.requestStop();                        // idempotent: no-ops if not Reasoning (PRD §24.3)
}
```
**No boolean, no counter, no "last press time" in ShortcutManager.** This is by design and must be
preserved — any local dedup state would duplicate the coordinator's authority and race with it.

### Where does "shortcut active only during reasoning" live? (PRD §22.5 / §33)

NOT in register/unregister toggling. The shortcut is **registered ONCE at init and stays bound for the
session**. Its *effect* is dynamically gated by the coordinator:
- outside `Reasoning` → `requestStop()` returns `false` (FM-001/FM-002: shortcut ignored outside
  reasoning) — no transition, no side effect;
- once a transition starts → `alreadyInterrupting()` returns `true` → the handler discards (PRD §33
  "disabled after transition begins").

So PRD §33's "active only during reasoning / disabled after transition begins / idempotent" is enforced
**by the coordinator gate**, not by ShortcutManager mutating its own registration. ShortcutManager is the
dumb forwarder (PRD §13.5: "Register shortcut / Determine if shortcut is valid / Signal interruption /
Nothing more" — and even "determine if valid" is delegated to the coordinator here).

---

## 3. Scope boundary: factory wiring is DEFERRED to P1.M4.T4 (critical)

The work item's OUTPUT says "ShortcutManager wired into the extension factory" + "Consumed by P1.M1.T5
(factory wires it)". **Wiring the factory (`src/index.ts`) REQUIRES a `TransitionCoordinator` instance** to
pass into `shortcutManager.register(pi, config.shortcut, coordinator)` — and the coordinator is P1.M4.T4's
deliverable, which does not exist when T3 implements (T3 ∥ T2, both before T4).

Three options were evaluated:
- **(A) T3 wires index.ts and constructs a coordinator inline** → CONFLICTS with P1.M4.T4 (duplicate
  ownership of the coordinator) and would be torn out. ❌
- **(B) T3 wires index.ts referencing an undefined `coordinator`** → does not compile (no coordinator to
  pass). ❌
- **(C) T3 delivers the ShortcutManager UNIT + tests; the factory wiring (construct coordinator +
  ShortcutManager + `register(...)` + connect coordinator↔decorator via `setActiveProxy`) is owned by
  P1.M4.T4** → the ONLY conflict-free, compilable scope. ✅

`module_contracts.md` confirms (C) is architecturally correct: the **factory owns the coordinator** and
wires it to **both** the decorator (via `setActiveProxy`) **and** the ShortcutManager (via `register`).
The coordinator is the hub; T4 is its owner; T4 is therefore the natural wiring point. The PRP prescribes
the EXACT wiring code for T4 (see PRP "Integration Points → ROUTES") so the integration is mechanical.

⇒ **T3 touches ONLY `src/shortcut/index.ts` (NEW) + `tests/shortcut-manager.test.ts` (NEW).** It does
NOT modify `src/index.ts`, `src/state/coordinator.ts`, or any other file. This guarantees T3 compiles
standalone and cannot conflict with T2 (proxy) or T4 (coordinator).

---

## 4. `unregister()` — interface completeness vs. pi reality

`module_contracts.md` lists `unregister(): void` on ShortcutManager. But pi's `registerShortcut` returns
`void` with no deregistration handle, and there is no `unregisterShortcut` API (§1). Therefore a TRUE
deregistration is impossible. The PRP implements `unregister()` as a **documented no-op** (it traces and
returns) — kept for interface completeness / forward compatibility / lifecycle symmetry, and honestly
annotated that pi provides no deregistration surface so the binding is session-scoped. The shortcut's
dynamic *disable* during/after a transition is handled by the coordinator gate (§2), NOT by unregister.

---

## 5. Test conventions (VERIFIED — patterns to mirror)

- **`bun:test`** (`import { describe, test, expect, mock } from "bun:test"`). `mock(fn)` creates a spy
  with `.mock.calls` / `.toHaveBeenCalledTimes(n)`.
- **Capturing Diagnostics stub** — `makeCaptureDiag()` (see `tests/reasoning-buffer.test.ts`,
  `tests/transition-controller.test.ts`): builds a `Diagnostics` recording `{level,event,fields}` per
  call. Reuse to assert which trace events fire (e.g. `shortcut.forwarded` vs `shortcut.ignored`).
- **Fake `ExtensionAPI`** — `makeFakePi()` (see `tests/factory.test.ts`): builds `{ on: mock(...) } as
  unknown as ExtensionAPI`. For ShortcutManager we EXTEND this: add a capturing `registerShortcut: mock()`
  that stores `{ shortcut, description, handler }` so tests can (a) assert registration args and (b)
  **invoke the captured `handler`** to exercise the forwarding/idempotency/EC-010 logic.
- **Fake coordinator** — a tiny object `{ alreadyInterrupting(): boolean; requestStop(): boolean }` (a
  stateful version that flips `alreadyInterrupting()` to `true` after the first `requestStop()` models
  EC-009/EC-010 realistically). It is structurally assignable to `StopRequestCoordinator`.

`tests/` is excluded from the tsc build (`tsconfig` `exclude:["tests"]`); tests are validated by
`npx bun test` (Bun transpiles TS natively). `npx bun run typecheck` validates `src/` only.

---

## 6. Commands (VERIFIED working in this repo)

```
npx bun run typecheck   # = tsc --noEmit   (validates src/ only; 0 errors baseline)
npx bun run build       # = tsc            (emits dist/; exit 0)
npx bun test            # runs all tests/*.test.ts via Bun
npx bun test tests/shortcut-manager.test.ts   # the new suite only
```
(`bun`/`tsc` are local devDeps, NOT on PATH → always invoke via `npx bun ...`.)

Baseline state at research time: `npx bun run typecheck` → 0 errors; the existing 10 suites are green.

---

## 7. Privacy / logging (Appendix H) — what the handler may log

The handler touches no user content. Appendix H allows logging event counts / timing / state
transitions. The ShortcutManager traces ONLY: `shortcut.registered` (on register), `shortcut.forwarded`
(with `{ accepted: boolean }` — the coordinator's `requestStop()` result), `shortcut.ignored` (with
`{ reason: "already-interrupting" }`), `shortcut.unregister`, and a defensive `shortcut.handler-error`
(on any swallowed coordinator fault). NEVER logs key events' content (there is none) — fine.
