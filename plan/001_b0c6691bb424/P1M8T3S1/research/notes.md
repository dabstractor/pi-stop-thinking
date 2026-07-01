# Research Notes — P1.M8.T3.S1: Session shutdown cleanup & provider restoration

Scope: EC-011 (extension disabled mid-request), EC-012 (extension unloaded mid-transition),
EC-013 (provider reload), EC-016 (feature disabled via config). Deliverable = graceful lifecycle
handling + **no orphaned registrations after shutdown** + a runtime `disabled` gate (EC-011) wired via
`pi.registerFlag`. Sources: installed `@earendil-works/pi-coding-agent@0.80.3` `.d.ts`, the shipped
`src/`, the PRD snapshot, `architecture/module_contracts.md`, and the sibling PRPs.

---

## 1. What already exists (codebase audit) — most of EC-012/EC-013 is DONE

| Concern | Status | Where |
|---|---|---|
| `pi.on("session_shutdown", () => decorator.shutdown())` registered AFTER `initialize()` | DONE | `src/index.ts` (factory) |
| `shutdown()` calls `unregisterApiProviders("stop-thinking-extension")` | DONE | `src/provider/decorator.ts` |
| `shutdown()` resets `original=undefined`, `registered=false`, is idempotent, re-`initialize()` works | DONE | `src/provider/decorator.ts` |
| Shutdown handler wrapped in try/catch (a cleanup fault can't crash Pi teardown) | DONE | `src/index.ts` |
| Active request "completes" on unload — proxy holds its OWN `originalStreamSimple` closure | DONE (architectural) | `src/provider/proxy.ts` constructor |
| Per-request resource cleanup on terminal (timers, buffer, coordinator ref) via idempotent `_terminate` | DONE | `src/provider/proxy.ts` `_terminate` |
| Factory `never-crash` outer try/catch (PRD Appendix K) | DONE | `src/index.ts` |

**NET:** EC-012 ("wrapper completes active request; provider registration restored; cleanup performed")
and EC-013 ("decorator re-registers; captured provider refreshed") are already satisfied by the P1.M1
foundation. This task's job for those two is **verification + lock-in tests** (so a future refactor of
`shutdown()`/the factory can't silently regress them), NOT new logic.

**The ONE genuinely missing behavior is EC-011** — a runtime `disabled` flag the wrapper honors so NEW
requests bypass the proxy while ACTIVE transitions keep running.

---

## 2. EC-011 vs EC-016 — two distinct disable gates (do not conflate)

- **EC-016 (Feature Disabled)** = a **CONFIG** gate, already implemented: `config.enabled === false` →
  `eligible` is false → the wrapper delegates transparently (no proxy). Owned by `src/config` + the
  decorator's eligibility expression (`this.config.enabled && model.reasoning && supported`).
- **EC-011 (Extension Disabled Mid-Request)** = a **RUNTIME/CLI** gate. The contract names `pi.registerFlag`
  as the mechanism. When set, NEW requests delegate without constructing a proxy; ALREADY-running
  transitions (constructed StreamProxies) are untouched.

Both must be true (plus provider/reasoning) for a proxy to be constructed. The new EC-011 gate is an
ADDITIONAL short-circuit at the TOP of `wrapperStreamSimple`, evaluated per-request. EC-016 stays as-is.

## 3. The `pi.registerFlag` / `pi.getFlag` API (verified against installed types)

```typescript
// node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
registerFlag(name: string, options: {
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
}): void;                                    // line 864
getFlag(name: string): boolean | string | undefined;   // line 870 — LIVE read of current value
```

- `ExtensionFlag` = `{ name, description?, type, default?, extensionPath }`.
- The runner owns `flagValues: Map<string, boolean|string>` (defaults at registration, CLI values applied
  after) AND a `setFlagValue(name, value)` mutator (runner.d.ts line 114) → flags are NOT frozen at
  startup; they can change at runtime.
- `getFlag` is a **live** read on the `ExtensionAPI` surface, so reading it per-request always reflects
  the current value regardless of when CLI/runner mutations land.

**Decision: read `getFlag` PER-REQUEST via a callback injected into the decorator** (not once at init).
Rationale: (a) robust to the "CLI values applied after registration" timing ambiguity; (b) honors a
runtime `setFlagValue` change for "future requests bypass wrapper"; (c) clean DI seam mirroring the
decorator's existing `registry?` optional-param convention.

**Flag name:** `"stop-thinking"` (boolean, default `true`). `pi --no-stop-thinking` (or
`--stop-thinking=false`) → `getFlag("stop-thinking") === false` → disabled. Description:
"Enable Stop Thinking & Do — interrupt z.ai reasoning and answer directly."

## 4. EC-011 "active transitions continue" — why it's free (architectural)

The StreamProxy is constructed in `wrapperStreamSimple` and immediately captures `originalStreamSimple`
(the built-in `streamSimple`, captured in `initialize()` BEFORE the wrapper overwrote the registry). The
decorator holds NO reference to running proxies and the disabled flag is checked ONLY at the top of
`wrapperStreamSimple` (request START). Therefore flipping `disabled` to true mid-request cannot reach an
already-constructed proxy — its event loop, timers, and replacement stream run to completion on their own
closures. This is the same reason EC-012 "completes active request" holds. **No proxy-bookkeeping in the
decorator is required** (and adding a proxy registry would violate the proxy's "fire-and-forget,
GC-when-drained" lifecycle contract documented in `proxy.ts`).

## 5. Parallel-task boundary with P1.M8.T2.S2 (non-conflict proof)

P1.M8.T2.S2 (provider failure modes, in-flight) edits:
- `src/types.ts` (add `isMalformedEvent`)
- `src/provider/proxy.ts` (constructor `_model` field + guards at the TOP of `_emit`)
- `tests/types.test.ts`, NEW `tests/stream-proxy-failure-modes.test.ts`

This task (P1.M8.T3.S1) edits:
- `src/provider/decorator.ts` (4th optional `disabledProvider?: () => boolean` ctor param + a
  short-circuit at the top of `wrapperStreamSimple`)
- `src/index.ts` (register the flag; widen `DecoratorFactory` to forward `disabledProvider`)
- `tests/provider-decorator.test.ts`, `tests/factory.test.ts` (+ optional NEW `tests/lifecycle.test.ts`)

**File-level: zero overlap** (S2 = proxy.ts/types.ts; S1 = decorator.ts/index.ts). Within decorator.ts
the edit is a NEW ctor param + a NEW guard line — no collision with anything S2 touches. 3-way merge is
trivial. Confirmed against the S2 PRP's "Deliverable" + "Parallel boundary" sections.

## 6. EC-013 (provider reload) — handled by the existing re-init cycle

`SessionShutdownEvent.reason` includes `"reload"` (verified: `research/P1M1T5S1/extension-api-contract.md`).
On reload Pi fires `session_shutdown` (our handler → `decorator.shutdown()` →
`unregisterApiProviders(sourceId)` → built-in restored) and THEN invokes a FRESH factory call, whose
`decorator.initialize()` RE-CAPTURES the now-restored built-in and re-registers the wrapper. Existing
streams "continue unaffected" because each proxy holds its own captured closure (§4). So EC-013 needs NO
new code — only a documented + tested guarantee that `shutdown()` → `initialize()` is a clean cycle
(idempotent shutdown, re-init re-captures). The existing decorator already supports re-init (the
`registered` flag resets in `shutdown()`), and `provider-decorator.test.ts` already has a
"re-initialize after shutdown" test — this task re-affirms it in a lifecycle test.

## 7. "No orphaned registrations after shutdown" (the OUTPUT guarantee)

`unregisterApiProviders("stop-thinking-extension")` removes ONLY entries registered under our sourceId;
the builtin (registered with no sourceId) is untouched. After `shutdown()`,
`getApiProvider("openai-completions")` returns the ORIGINAL builtin (identity `===`), so no orphaned
wrapper lingers. Repeated init/shutdown cycles leave the registry in the original state. Verified by the
existing Level-3 node smoke in the P1.M1.T4/T5 PRPs; this task adds an explicit assertion.

---

## 8. Implementation surface (final, scoped)

**`src/provider/decorator.ts`** — MODIFY (no behavior change when `disabledProvider` is omitted):
- ctor gains `disabledProvider?: () => boolean` as a 4th optional param (after `registry?`); stored as
  `private readonly _disabledProvider: () => boolean = disabledProvider ?? (() => false);`
- top of `wrapperStreamSimple`: `if (this._disabledProvider()) { debug-log; return originalStreamSimple(...); }`
  BEFORE the eligibility check. This is the EC-011 bypass for NEW requests.
- JSDoc update (EC-011 rationale + the "active transitions continue" architectural note + §1 of the
  module_contracts decision tree gains a "0. if disabledProvider() → delegate" step).

**`src/index.ts`** — MODIFY:
- After `createDiagnostics`, register the flag (wrapped in its own try/catch — a flag-registration fault
  must NOT prevent decoration; if it fails, the callback still safely yields "not disabled" because
  `getFlag` returns `undefined`): `pi.registerFlag("stop-thinking", { type:"boolean", default:true, description })`.
- Widen `DecoratorFactory` to `(config, diagnostics, disabledProvider?: () => boolean) => DecoratorLifecycle`;
- `createDefaultDecorator` forwards `disabledProvider` into `new ProviderDecorator(config, diagnostics, undefined, disabledProvider)`.
- Call `createDecorator(config, diagnostics, () => pi.getFlag("stop-thinking") === false)`.

**Tests** — MODIFY `tests/provider-decorator.test.ts` (disabled bypass + default-never-disabled +
active-unaffected) and `tests/factory.test.ts` (flag registered; `disabledProvider` reflects `getFlag`;
session_shutdown restores registry / no orphan). Optional NEW `tests/lifecycle.test.ts` for the
EC-012/013/011 flows against fakes. Real-registry proof stays in Level 3 (isolated node — must NOT run
inside the bun unit suite to avoid mutating the module-global pi-ai registry).

## 9. Out of scope (owned elsewhere — do NOT implement here)

- Wiring the `TransitionCoordinator` + `ShortcutManager` into the factory (`pi.registerShortcut` + a
  session coordinator + `decorator` calling `setActiveProxy`). The coordinator/shortcut modules exist
  (P1.M4.T3/T4) but are NOT yet factory-wired; that is a separate wiring concern, not lifecycle cleanup.
  The proxy's `_coordinator?.setActiveProxy(undefined)` cleanup is already a safe no-op when undefined.
- Any change to `src/provider/proxy.ts`, `src/types.ts` (P1.M8.T2.S2 owns those).
- Provider failure modes (FM-*) — P1.M8.T2. Stress/property tests — P1.M8.T4. README/docs — P1.M8.T5.
