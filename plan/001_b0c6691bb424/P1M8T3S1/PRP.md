# PRP — P1.M8.T3.S1: Session shutdown cleanup & provider restoration

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M8.T3.S1 (Phase 7 Hardening, 1 pt). Locks in EC-012 (extension unloaded
> mid-transition) + EC-013 (provider reload) — which are ALREADY implemented by the P1.M1 foundation —
> and adds the ONE genuinely missing behavior: EC-011's runtime `disabled` flag (wired via
> `pi.registerFlag`) so NEW requests bypass the wrapper while ACTIVE transitions keep running.
> **INPUT**: `ProviderDecorator` (`src/provider/decorator.ts`) from P1.M1.T4.S1 + the extension factory
> (`src/index.ts`) from P1.M1.T5.S1 + the `ExtensionAPI` flag/lifecycle surface.
> **OUTPUT**: graceful lifecycle handling; a CLI disable flag; **no orphaned registrations after
> shutdown**. **Consumed by**: P1.M8.T4 (stress/chaos tests will toggle the flag + simulate reload).
>
> **SCOPE TRIAGE (codebase audit — see `research/notes.md` §1)**: EC-012 + EC-013 are already satisfied
> (`session_shutdown` → `shutdown()` → `unregisterApiProviders(sourceId)`; re-init re-captures; active
> proxies hold their own closure). Of the deliverables:
> - **EC-012 / EC-013** = **VERIFICATION + lock-in tests only** (no new logic).
> - **EC-011** = **NEW** — a runtime `disabled` gate the wrapper honors (the only missing behavior).
> - **"No orphaned registrations after shutdown"** = an explicit assertion (mechanism already exists).
>
> **PARALLEL-TASK BOUNDARY**: P1.M8.T2.S2 (provider failure modes, in flight) edits `src/provider/proxy.ts`
> (constructor `_model` + guards at the TOP of `_emit`) + `src/types.ts` + `tests/types.test.ts` + a NEW
> `tests/stream-proxy-failure-modes.test.ts`. This task edits `src/provider/decorator.ts` (a NEW 4th
> optional ctor param + a NEW guard at the top of `wrapperStreamSimple`) + `src/index.ts` (flag
> registration + a widened `DecoratorFactory`) + decorator/factory tests. **File-level: ZERO overlap**
> (S2 = proxy.ts/types.ts; S1 = decorator.ts/index.ts). Within `decorator.ts` the edits are additive (new
> param, new guard line) and touch none of the existing capture/register/shutdown logic → trivial 3-way
> merge. See §"All Needed Context → Parallel boundary" for the proof.

---

## Goal

**Feature Goal**: The extension handles every lifecycle event gracefully and deterministically. Concretely:
(a) **EC-011** — a registered CLI flag `stop-thinking` (boolean, default `true`) is honored at request
start; when `false`, the wrapper delegates **without constructing a `StreamProxy`** for NEW requests,
while an already-running transition keeps streaming to completion (the proxy holds its own captured
closure and is unreachable from the decorator after construction). (b) **EC-012** — on `session_shutdown`
the registered handler calls `decorator.shutdown()`, which calls
`unregisterApiProviders("stop-thinking-extension")`, restoring Pi's built-in `openai-completions` provider
so **no orphaned wrapper registration lingers** after teardown; an active request completes/aborts via its
own signal handling, not via the decorator. (c) **EC-013** — a reload (`reason: "reload"`) fires
`session_shutdown` (restore) then a fresh factory call whose `initialize()` re-captures the now-restored
built-in and re-registers the wrapper (the existing idempotent shutdown + re-init cycle handles this
naturally). The flag registration itself is non-fatal: a `registerFlag` fault is logged and decoration
proceeds without the runtime gate (the read callback then safely yields "not disabled").

**Deliverable** (TWO source files MODIFIED + TWO test files MODIFIED + ONE test file CREATED):
- `src/provider/decorator.ts` — **MODIFY**: add a 4th optional constructor param
  `disabledProvider?: () => boolean` (stored as a readonly field defaulting to `() => false`), and a
  short-circuit at the TOP of `wrapperStreamSimple` that delegates directly when `disabledProvider()`
  returns `true` (EC-011). No change to capture/register/shutdown logic or to callers that omit the param.
- `src/index.ts` — **MODIFY**: register `pi.registerFlag("stop-thinking", { type: "boolean", default:
  true, description })` (wrapped in its own try/catch so a flag fault can't prevent decoration); widen
  `DecoratorFactory` to `(config, diagnostics, disabledProvider?) => DecoratorLifecycle`; pass
  `() => pi.getFlag("stop-thinking") === false` into `createDecorator`. Keep the existing
  `session_shutdown` → `shutdown()` wiring unchanged (verify only).
- `tests/provider-decorator.test.ts` — **MODIFY**: add the EC-011 disabled-bypass suite (disabled →
  delegates without constructing a proxy; default `disabledProvider` → never disabled; an
  already-constructed proxy is unaffected by a later flip to disabled) + a "no orphaned registration
  after shutdown" assertion.
- `tests/factory.test.ts` — **MODIFY**: add tests that the flag is registered (name/type/default), that
  the `disabledProvider` callback reflects `getFlag`, and that `session_shutdown` drives `shutdown()`
  (registry restored — re-affirmed via the fake decorator).
- `tests/lifecycle.test.ts` — **CREATE**: a focused EC-011/EC-012/EC-013 flow suite using the REAL
  `ProviderDecorator` against an injected fake registry (no global-registry mutation) + a fake `ExtensionAPI`.

**Success Definition**: From a clean checkout (after merging P1.M8.T2.S2), `npx bun run typecheck` → **0**
diagnostics; `npx bun run build` → exit 0; `npx bun test` → **ALL green** (new + modified suites + every
pre-existing suite unchanged). With `getFlag("stop-thinking") === false`, an eligible z.ai reasoning
request returns the built-in's stream verbatim (no `StreamProxy` constructed); with it `true`, the proxy
is constructed as before. After `session_shutdown`, `getApiProvider("openai-completions")` is the original
builtin (identity `===`, no orphan), and `initialize()` after `shutdown()` re-registers cleanly (EC-013).

---

## User Persona (if applicable)

**Target User**: The end user who (a) wants to disable the extension for a session via a CLI flag
(`pi --no-stop-thinking`) without uninstalling it, (b) quits / reloads / switches sessions mid-response,
or (c) reloads providers. In every case the agent must keep working: the in-flight response finishes (or
aborts cleanly via Pi's own signal), the registry is left tidy, and the next request behaves correctly.

**Use Case**: The user starts `pi --no-stop-thinking` to reason through a hard problem uninterrupted; the
wrapper sees the flag and delegates every request transparently (no proxy, no transition state). Later,
without the flag, the user presses Stop mid-reasoning and then immediately quits (`session_shutdown`);
the active transition streams to completion, then the registry is restored so a restart loads the clean
built-in.

**Pain Points Addressed**: (1) no way to disable at runtime without editing config + reloading;
(2) a stale wrapper could linger in the pi-ai registry after unload, silently double-wrapping on the next
load; (3) a `registerFlag` failure could (naively) brick decoration — it must not.

---

## Why

- **EC-011 (NEW — PRD Appendix B)**: today the only disable gate is `config.enabled` (EC-016, a config
  value). The contract requires a RUNTIME flag (`pi.registerFlag`) so the wrapper can be bypassed for new
  requests while active transitions run on. This is the one real behavior gap in this work item.
- **EC-012 / EC-013 (lock-in)**: the restore-on-shutdown + re-init-on-reload machinery already exists
  (P1.M1.T4/T5), but it is asserted only indirectly. P1.M8.T4 (stress/chaos) will simulate reload +
  unload at random — these paths must be deterministic and regression-proof BEFORE that fuzzing lands.
- **"No orphaned registrations" (OUTPUT guarantee)**: `unregisterApiProviders(sourceId)` removes only our
  entry; the builtin is untouched. An explicit `===` assertion pins this so a future `shutdown()` rewrite
  can't leave a double-wrapped registry.
- **Downstream**: P1.M8.T4 toggles the flag and replays reload/unload under load; P1.M8.T5 documents the
  `--no-stop-thinking` flag in the README.

---

## What

### Source: MODIFY `src/provider/decorator.ts` — add the EC-011 runtime disable gate

Add a 4th optional constructor param `disabledProvider?: () => boolean` (DI seam, mirrors the existing
`registry?` convention) and a short-circuit at the TOP of `wrapperStreamSimple`. The guard is evaluated
**per request** (the factory supplies `() => pi.getFlag("stop-thinking") === false`), so it always reflects
the current flag value. When disabled, the wrapper delegates directly to the captured built-in
`streamSimple` — byte-identical, no `StreamProxy`, no transition state — exactly EC-011's "future requests
bypass wrapper". Callers that omit `disabledProvider` get `() => false` (never disabled) → behavior is
UNCHANGED for every existing call site and test.

```typescript
// NEW field (place beside the other private readonlys, e.g. after `registry`):
/**
 * EC-011 (PRD Appendix B): runtime disable check, evaluated PER REQUEST. The factory supplies
 * `() => pi.getFlag("stop-thinking") === false` so a CLI flag (--no-stop-thinking) or a runtime
 * setFlagValue change takes effect for the NEXT request. When true, wrapperStreamSimple delegates
 * directly to the captured built-in WITHOUT constructing a StreamProxy. ACTIVE transitions are
 * unaffected: each already-constructed proxy holds its own captured originalStreamSimple closure and
 * is unreachable from the decorator after construction (the flag is checked only at request start).
 * Defaults to `() => false` (never disabled) so omitting the param is behavior-preserving.
 */
private readonly _disabledProvider: () => boolean;

// constructor gains a 4th optional param (after registry?):
constructor(
  config: Config,
  diagnostics: Diagnostics,
  registry: ProviderRegistry = DEFAULT_REGISTRY,
  disabledProvider?: () => boolean,
) {
  this.config = config;
  this.diagnostics = diagnostics;
  this.registry = registry;
  this._disabledProvider = disabledProvider ?? (() => false); // default: never disabled
}

// TOP of wrapperStreamSimple — BEFORE the eligibility expression:
const wrapperStreamSimple: ApiStreamSimpleFunction = (model, context, options) => {
  // EC-011 (PRD Appendix B): runtime disable flag (e.g. --no-stop-thinking). When disabled, delegate to
  // the captured built-in WITHOUT constructing a StreamProxy for NEW requests. An ACTIVE transition
  // (already-constructed proxy) is unreachable here — it runs on its own closure to completion. This is
  // distinct from EC-016 (config.enabled), which is checked in `eligible` below.
  if (this._disabledProvider()) {
    this.diagnostics.debug("provider.streamSimple.disabled-delegate", {
      api: model.api,
      provider: String(model.provider),
      model: model.id,
    });
    return originalStreamSimple(model, context, options);
  }

  // (existing) Activation conditions per PRD §19.5 / §19.6 (B is guaranteed by the registry's api-guard):
  const eligible =
    this.config.enabled &&
    model.reasoning &&
    this.config.supportedProviders.includes(String(model.provider));
  // … unchanged: eligible → new StreamProxy(…); else delegate …
};
```

> **GOTCHA — placement of the guard:** it MUST precede the `eligible` expression. A disabled flag must
> bypass even eligible z.ai reasoning requests (proxy must NOT be constructed). `originalStreamSimple` is
> already in scope (captured in `initialize()` step 1, before registration) — delegating through it is
> byte-identical and never recurses (research §4 / api-registry-internals.md).
>
> **GOTCHA — do NOT add a proxy registry / active-transition bookkeeping to the decorator.** The "active
> transitions continue" guarantee is architectural: the proxy is fire-and-forget and GC-when-drained
> (`proxy.ts` module banner). Tracking live proxies would violate that contract and is unnecessary.

### Source: MODIFY `src/index.ts` — register the flag + thread the disable callback

```typescript
// 1) Widen DecoratorFactory to forward the disable callback (optional; existing fakes still assign):
export type DecoratorFactory = (
  config: Config,
  diagnostics: Diagnostics,
  disabledProvider?: () => boolean,
) => DecoratorLifecycle;

// 2) Default factory forwards disabledProvider into the real decorator (registry = undefined → DEFAULT_REGISTRY):
const createDefaultDecorator: DecoratorFactory = (config, diagnostics, disabledProvider) =>
  new ProviderDecorator(config, diagnostics, undefined, disabledProvider);

// 3) Inside the factory try-block, AFTER createDiagnostics and BEFORE createDecorator:
//    EC-011: register the CLI disable flag. Non-fatal: a registerFlag fault is logged and decoration
//    proceeds (getFlag then returns undefined → the callback yields "not disabled").
try {
  pi.registerFlag("stop-thinking", {
    type: "boolean",
    default: true,
    description: "Enable Stop Thinking & Do — interrupt z.ai reasoning and answer directly.",
  });
} catch (err) {
  diagnostics.warn("extension.flag-register-failed", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// 4) createDecorator call gains the disable callback (reads the LIVE flag value per request):
const decorator = createDecorator(
  config,
  diagnostics,
  () => pi.getFlag("stop-thinking") === false,
);

// 5) session_shutdown wiring is UNCHANGED (verify only) — already calls decorator.shutdown().
```

> **GOTCHA — `getFlag` is a LIVE read** (verified: `types.d.ts:870` + runner `setFlagValue` mutator). Reading
> it per-request via the callback is robust to both the "CLI values applied after registration" timing and
> to a runtime `setFlagValue`. Do NOT read it once at init.
>
> **GOTCHA — flag-registration failure isolation.** Wrap ONLY `registerFlag` in its own try/catch (not the
> whole init). A flag fault must not skip decoration: the extension should still work, just without the
> runtime disable gate. `diagnostics` exists by this point (created in step 2 of init), so `.warn` is safe.

### Out of scope (owned elsewhere — do NOT implement here)

- Wiring `TransitionCoordinator` + `ShortcutManager` into the factory (`pi.registerShortcut` + a session
  coordinator + `decorator`/`proxy` calling `setActiveProxy`). Those modules exist (P1.M4.T3/T4) but are
  not yet factory-wired; that is a separate wiring concern, NOT lifecycle cleanup. The proxy's
  `_coordinator?.setActiveProxy(undefined)` cleanup is already a safe no-op when `undefined`.
- Any change to `src/provider/proxy.ts` or `src/types.ts` — **P1.M8.T2.S2** owns those (parallel).
- Provider failure modes (FM-*) — P1.M8.T2. Stress/property tests — P1.M8.T4. README docs (`--no-stop-thinking`)
  — P1.M8.T5. EC-014/015 (unsupported model/provider) — already handled by the eligibility expression.

### Success Criteria

- [ ] `src/provider/decorator.ts` ctor accepts an optional 4th `disabledProvider?: () => boolean`; omitters
      get `() => false` (no behavior change). `wrapperStreamSimple` short-circuits to direct delegation
      when `disabledProvider()` is `true` (no `StreamProxy` constructed).
- [ ] `src/index.ts` registers `pi.registerFlag("stop-thinking", { type:"boolean", default:true })` inside
      its own try/catch; passes `() => pi.getFlag("stop-thinking") === false` to `createDecorator`.
- [ ] `DecoratorFactory` widens to `(config, diagnostics, disabledProvider?) => DecoratorLifecycle`;
      existing fake factories still type-check (fewer params is assignable).
- [ ] EC-011: with the disable callback returning `true`, an eligible z.ai reasoning request returns the
      built-in's stream verbatim (`===` sentinel in tests; no proxy). With `false`, the proxy is built.
- [ ] EC-011 "active continues": flipping the flag AFTER a proxy is constructed does not reach that proxy.
- [ ] EC-012: `session_shutdown` → `shutdown()` → `unregisterApiProviders("stop-thinking-extension")`;
      after it, the registry holds the original builtin (no orphan). Shutdown is idempotent + guarded.
- [ ] EC-013: `shutdown()` → `initialize()` re-captures the (restored) builtin and re-registers cleanly.
- [ ] `npx bun run typecheck` → 0; `npx bun run build` → exit 0; `npx bun test` → ALL green.
- [ ] No edits to `src/provider/proxy.ts`, `src/types.ts`, `package.json`, `tsconfig.json`, `.gitignore`,
      `src/config/*`, `src/diagnostics/*`, `src/state/*`, `src/shortcut/*`, `src/request/*`, `src/buffer/*`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the exact `registerFlag`/`getFlag` signatures (verified against the installed
`pi-coding-agent@0.80.3` `.d.ts`), the exact current decorator wrapper + factory bodies (copied from
`src/`), the complete EC-011 diff (ctor param + guard), the complete factory diff, the full test suites
with fakes, and the exact build/test commands. The only external assumption — that P1.M8.T2.S2 lands its
`proxy.ts`/`types.ts` edits — is bounded by the non-overlap proof below.

### Documentation & References

```yaml
# MUST READ — authoritative contracts for THIS module
- file: plan/001_b0c6691bb424/P1M8T3S1/research/notes.md
  why: "Codebase audit (what's DONE vs NEW), the EC-011-vs-EC-016 distinction, the registerFlag/getFlag
        timing analysis, the 'active transitions continue' architectural proof, and the parallel-boundary
        non-conflict proof."
  critical: "Only EC-011 is NEW logic; EC-012/EC-013 are verification+tests. Read getFlag PER-REQUEST (live).
        Do NOT add proxy bookkeeping to the decorator."

- file: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
  why: "The VERIFIED flag + lifecycle surface: registerFlag(name,{description?,type,default?}):void (l.864);
        getFlag(name):boolean|string|undefined (l.870, LIVE read); on('session_shutdown', handler) (l.~840);
        SessionShutdownEvent.reason includes 'reload'|'quit'|'new'|'resume'|'fork'. ExtensionFactory=(pi)=>void|Promise<void>."
  critical: "getFlag is live (runner has setFlagValue). registerFlag is sync, void, safe at init. The
        session_shutdown handler signature is (event, ctx) => void|Promise<void>."

- file: plan/001_b0c6691bb424/P1M1T5S1/research/extension-api-contract.md
  why: "VERIFIED ExtensionFactory type (sync `void` is correct), the on('session_shutdown') signature,
        SessionShutdownEvent.reason values (incl. 'reload' → EC-013), and the observation that pi-ai
        builtins register BEFORE factories run (so initialize() won't throw in prod)."
  critical: "session_shutdown reason='reload' fires before a fresh factory call → EC-013 is the re-init cycle."

# INPUT contracts (already shipped — consume, do not modify)
- file: src/provider/decorator.ts   # (P1.M1.T4.S1 — DONE; P1.M2.T3.S1 activated the proxy in the eligible branch)
  why: "Exports ProviderDecorator(config, diagnostics, registry?) with initialize()/shutdown(). initialize()
        captures getApiProvider('openai-completions') BEFORE registering (PRD §19.2), builds wrapperStream +
        wrapperStreamSimple (the eligible branch constructs `new StreamProxy(...)`), registers under
        STOP_THINKING_SOURCE_ID. shutdown() calls unregisterApiProviders(sourceId) + resets state (idempotent,
        re-initializable). This task adds the disabledProvider param + the wrapper guard."
  pattern: "the eligible branch currently: `const eligible = this.config.enabled && model.reasoning &&
        this.config.supportedProviders.includes(String(model.provider)); if (eligible) { const proxy = new
        StreamProxy(model, context, options ?? {}, originalStreamSimple, this.diagnostics); return proxy.output; }
        return originalStreamSimple(model, context, options);`"
  gotcha: "originalStreamSimple is captured in initialize() step 1 and is in scope inside wrapperStreamSimple's
        closure — delegating through it is byte-identical and never recurses. Put the disabled guard ABOVE
        the eligible expression."

- file: src/index.ts   # (P1.M1.T5.S1 — DONE)
  why: "The factory. Already: try/catch wrap; loadConfig; createDiagnostics; createDecorator(config,diagnostics);
        decorator.initialize(); pi.on('session_shutdown', () => { try{decorator.shutdown()}catch{...} }). Exports
        DecoratorLifecycle + DecoratorFactory types (the test seam). This task: register the flag; widen
        DecoratorFactory; pass the disable callback."
  pattern: "DecoratorFactory = (config, diagnostics) => DecoratorLifecycle; createDefaultDecorator =
        (config, diagnostics) => new ProviderDecorator(config, diagnostics);"
  gotcha: "Pi calls the default export with ONE arg — the optional createDecorator 2nd param is invisible in
        production. Adding a 3rd optional param to DecoratorFactory is likewise invisible to Pi and
        backward-compatible with existing fake factories (TS allows fewer params). Keep the factory SYNC (void)."

- file: src/provider/proxy.ts   # (P1.M2–M7 — DONE; P1.M8.T2.S2 edits it in parallel)
  why: "READ ONLY for this task. Confirms the StreamProxy is constructed fire-and-forget in wrapperStreamSimple
        and holds its OWN captured originalStreamSimple closure — the architectural basis for 'active transitions
        continue' (EC-011/EC-012). _terminate() (idempotent) already clears timers/buffer/coordinator-ref on
        every terminal, so 'cleanup performed' (EC-012) needs no decorator change."
  critical: "DO NOT edit proxy.ts (P1.M8.T2.S2 owns it). The proxy does NOT need a disable signal — it is
        unreachable from the decorator after construction; flipping the flag only affects FUTURE requests."

- file: src/config/index.ts   # (P1.M1.T2.S1 — DONE)
  why: "Config type + DEFAULT_CONFIG. config.enabled is the EC-016 gate (distinct from the EC-011 flag).
        baseConfig in tests includes enabled:true, supportedProviders:['zai'], etc."

# PRD authority (PRD.md / prd_snapshot.md)
- url: PRD.md Appendix B "EC-011 — Extension Disabled Mid-Request"
  why: "Expected: 'User disables extension. Current transition continues. Future requests bypass wrapper.'"
  critical: "The disable affects NEW requests only; active transitions are not interrupted. Check the flag at
        request START (top of wrapperStreamSimple)."

- url: PRD.md Appendix B "EC-012 — Extension Unloaded Mid-Transition"
  why: "Expected: 'Wrapper completes active request. Provider registration restored. Cleanup performed.'"
  critical: "Restore = unregisterApiProviders(sourceId). 'Completes active request' = do NOT abort running
        proxies (Pi's own signal handles termination). Cleanup = the proxy's idempotent _terminate + the
        registry restore."

- url: PRD.md Appendix B "EC-013 — Provider Reload"
  why: "Expected: 'Decorator re-registers. Captured provider refreshed. Existing streams continue unaffected.'"
  critical: "Handled by the shutdown→(reload)→fresh-factory→initialize() cycle. No new code — verify re-init."

- url: PRD.md Appendix B "EC-016 — Feature Disabled"
  why: "'Configuration disables Stop Thinking. Wrapper delegates without allocating transition state.' This is
        config.enabled (already implemented) — NOT the EC-011 flag. Do not conflate the two."

- url: PRD.md §19.2 Initialization Sequence + §28 ProviderDecorator Invariants
  why: "Capture-before-register is absolute; decoration is reversible via the sourceId; registration occurs
        exactly once. The disabled flag changes NONE of these — it is a per-request short-circuit."

# REFERENCE — established repo conventions to mirror
- file: plan/001_b0c6691bb424/P1M1T4S1/PRP.md
  why: "The decorator PRP. Mirror its DI-by-optional-param convention (registry? → disabledProvider?), Mode-A
        JSDoc, fake-registry test style, and validation commands."
- file: plan/001_b0c6691bb424/P1M1T5S1/PRP.md
  why: "The factory PRP. Mirror its DecoratorFactory seam, fake-ExtensionAPI double (only `on` + now
        registerFlag/getFlag), capturing DiagnosticsSink, and the Level-3 real-registry node smoke."
- file: tests/provider-decorator.test.ts + tests/factory.test.ts
  why: "The proven Bun test style + the existing harnesses (makeFakeRegistry, makeFakePi, makeFakeFactory,
        STREAM_SENTINEL, baseConfig). EXTEND them; do not rewrite."
```

### Current Codebase tree (after P1.M1–M7 + P1.M8.T1/T2 land)

```bash
.
├── package.json          # scripts: build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); main ./dist/index.js
├── tsconfig.json         # ES2022, strict, bundler, outDir dist, rootDir src, exclude [node_modules,dist,tests]
├── src/
│   ├── index.ts          # ← factory (MODIFY): +registerFlag, +widened DecoratorFactory, +disable callback
│   ├── provider/
│   │   ├── decorator.ts  # ← MODIFY: +disabledProvider param, +EC-011 guard in wrapperStreamSimple
│   │   └── proxy.ts      # P1.M2–M7 (+P1.M8.T2.S2 parallel) — DO NOT TOUCH
│   ├── config/index.ts   # DONE — DO NOT TOUCH
│   ├── diagnostics/index.ts # DONE — DO NOT TOUCH
│   ├── state/{controller,coordinator}.ts # DONE — DO NOT TOUCH
│   ├── buffer/index.ts   # DONE — DO NOT TOUCH
│   ├── shortcut/index.ts # DONE — DO NOT TOUCH
│   ├── request/builder.ts # DONE — DO NOT TOUCH
│   ├── telemetry/index.ts # DONE — DO NOT TOUCH
│   └── types.ts          # P1.M8.T2.S2 parallel — DO NOT TOUCH
├── tests/
│   ├── provider-decorator.test.ts # ← MODIFY: +EC-011 disabled suite + no-orphan assertion
│   ├── factory.test.ts            # ← MODIFY: +flag registration + disable callback + shutdown restore
│   ├── lifecycle.test.ts          # ← CREATE: EC-011/012/013 flow (real decorator, fake registry/pi)
│   └── (all other *.test.ts)      # UNCHANGED
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── src/
│   ├── index.ts          # MODIFIED — registers the flag; threads the disable callback (EC-011)
│   └── provider/decorator.ts # MODIFIED — disabledProvider param + EC-011 wrapper guard
├── tests/
│   ├── provider-decorator.test.ts # MODIFIED — EC-011 + no-orphan
│   ├── factory.test.ts            # MODIFIED — flag + callback + shutdown-restore
│   └── lifecycle.test.ts          # NEW — EC-011/012/013 flows
└── (everything else UNCHANGED — incl. proxy.ts, types.ts owned by P1.M8.T2.S2)
```
**File responsibilities**: `decorator.ts` = per-request disable gate (EC-011) on top of the existing
capture/register/shutdown. `index.ts` = register the CLI flag + wire the live `getFlag` callback + keep
the `session_shutdown` cleanup. `lifecycle.test.ts` = the end-to-end EC-011/012/013 contract. No other
file is touched.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (do NOT edit proxy.ts/types.ts): P1.M8.T2.S2 edits those in parallel. This task's edits are
// confined to decorator.ts + index.ts + their tests + the new lifecycle test. Zero file-level overlap.

// CRITICAL (read getFlag PER-REQUEST, not once): getFlag is a LIVE read (runner has setFlagValue). The
// factory passes `() => pi.getFlag("stop-thinking") === false` as a CALLBACK; the decorator evaluates it
// at the top of every wrapperStreamSimple call. Reading once at init would miss a runtime flag change and
// would also race the "CLI values applied after registration" window. A callback is the only correct shape.

// CRITICAL (default disabledProvider = never disabled): omitting the 4th param MUST preserve every existing
// call site + test. `this._disabledProvider = disabledProvider ?? (() => false);` is behavior-preserving.
// The existing decorator tests (3-arg) and the existing factory fake (2-arg DecoratorFactory) are unchanged.

// CRITICAL (registerFlag failure must NOT prevent decoration): wrap ONLY pi.registerFlag in its own
// try/catch (not the whole init). On failure: diagnostics.warn("extension.flag-register-failed",{error});
// decoration proceeds. The disable callback then reads getFlag → undefined → undefined===false → false →
// "not disabled", so the extension works normally (just without the runtime gate). Never crash Pi (App. K).

// CRITICAL (EC-011 ≠ EC-016): the disabled guard is a NEW short-circuit ABOVE the eligible expression.
// config.enabled (EC-016) stays where it is, inside `eligible`. Both must be satisfied to build a proxy.

// GOTCHA (active transitions are unreachable): the decorator holds NO reference to running proxies. The
// flag is checked only at request START. Flipping it mid-request cannot reach an already-constructed proxy
// (it runs on its own originalStreamSimple closure). Do NOT add a proxy registry / abort-active logic to
// the decorator — that violates the proxy's fire-and-forget/GC-when-drained contract and is unneeded.

// GOTCHA (DecoratorFactory widening is backward-compatible): adding a 3rd optional param to the type makes
// existing 2-arg fake factories still assignable (TS permits fewer params). The real createDefaultDecorator
// forwards the callback; fakes that ignore it still type-check + pass.

// GOTCHA (flag name is exactly "stop-thinking"): registerFlag("stop-thinking", {type:"boolean",default:true}).
// The disable predicate is getFlag("stop-thinking") === false. Do not invent a scope/prefix. (README will
// document `pi --no-stop-thinking` in P1.M8.T5; do NOT edit README here.)

// GOTCHA (bun is a local devDep, NOT on PATH): invoke as `npx bun ...` / `npx bun run <script>`, NOT bare
// `bun`/`bunx`. package.json scripts resolve via `npx bun run`.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → typecheck checks src ONLY. Tests run via
// `npx bun test` (Bun runs TS natively). Do not add tests to the build include.

// GOTCHA (real-registry proof is Level 3, NOT a bun unit test): pi-ai's apiProviderRegistry is module-global
// and value-importing the decorator eagerly registers builtins. Unit tests MUST inject a fake registry (DI)
// and a fake ExtensionAPI — never call the real registerApiProvider/unregisterApiProviders. The real-registry
// EC-012/013 `===` proof lives in the Level 3 isolated `node -e` smoke (restores the global afterward).

// GOTCHA (privacy — Appendix H): diagnostics fields from the new paths are {error} (flag-register-failed)
// and {api,provider,model} (disabled-delegate debug). NEVER log options/context/messages/flag-CLI-args.
```

---

## Implementation Blueprint

### Data models and structure

No new types are strictly required. The only signature changes:

```typescript
// src/provider/decorator.ts — ctor gains a 4th optional param; new private readonly field.
export class ProviderDecorator {
  private readonly _disabledProvider: () => boolean; // NEW (EC-011)
  constructor(
    config: Config,
    diagnostics: Diagnostics,
    registry: ProviderRegistry = DEFAULT_REGISTRY,
    disabledProvider?: () => boolean, // NEW (EC-011) — defaults to () => false
  );
  initialize(): void; // unchanged body + the new guard inside wrapperStreamSimple
  shutdown(): void;   // unchanged
}

// src/index.ts — DecoratorFactory widens; factory body registers the flag + passes the callback.
export type DecoratorFactory = (
  config: Config,
  diagnostics: Diagnostics,
  disabledProvider?: () => boolean, // NEW
) => DecoratorLifecycle;
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/decorator.ts (EC-011 disable gate)
  - ADD a 4th optional ctor param `disabledProvider?: () => boolean` after `registry?`.
  - ADD field `private readonly _disabledProvider: () => boolean;` and assign
    `this._disabledProvider = disabledProvider ?? (() => false);` in the ctor body.
  - ADD the guard at the TOP of wrapperStreamSimple (before `eligible`): if this._disabledProvider() →
    debug-log "provider.streamSimple.disabled-delegate" {api,provider,model} + return originalStreamSimple(...).
  - UPDATE JSDoc (Mode A): module banner gains an EC-011 note; the ctor param doc; the wrapperStreamSimple
    decision tree gains "0. if disabledProvider() → delegate" before the §19.5/§19.6 conditions.
  - DO NOT touch initialize()'s capture/register steps, shutdown(), wrapperStream, or any other method.
  - GOTCHA: guard MUST precede `eligible`; originalStreamSimple is in closure scope; default = never disabled.

Task 2: MODIFY src/index.ts (register flag + thread callback)
  - WIDEN `DecoratorFactory` to accept a 3rd optional `disabledProvider?: () => boolean`.
  - UPDATE `createDefaultDecorator` to forward it: `new ProviderDecorator(config, diagnostics, undefined, disabledProvider)`.
  - INSIDE the factory try-block, AFTER `diagnostics = createDiagnostics(...)` and BEFORE `createDecorator`:
    wrap `pi.registerFlag("stop-thinking", {type:"boolean", default:true, description:"Enable Stop Thinking & Do — interrupt z.ai reasoning and answer directly."})`
    in its OWN try/catch → on catch `diagnostics.warn("extension.flag-register-failed", {error})` (continue).
  - CHANGE the createDecorator call to `createDecorator(config, diagnostics, () => pi.getFlag("stop-thinking") === false)`.
  - LEAVE the `pi.on("session_shutdown", …)` block UNCHANGED (verify only).
  - UPDATE JSDoc (Mode A): factory sequence gains the flag-registration step + the EC-011 rationale + the
    non-fatal-flag note; DecoratorFactory doc notes the new optional param (invisible to Pi, EC-011 seam).

Task 3: MODIFY tests/provider-decorator.test.ts (EC-011 + no-orphan)
  - EXTEND the fake-registry harness if needed (it already exposes `registered`, `stats`, STREAM_SENTINEL).
  - ADD describe("ProviderDecorator — EC-011 runtime disable"):
      * disabledProvider=() => true + eligible model → wrapper.streamSimple returns STREAM_SENTINEL (the
        builtin's value, NOT a proxy.output) AND builtin called once with (m,c,o) → no proxy constructed.
      * disabledProvider=() => false (or omitted) + eligible model → returns proxy.output (!== sentinel) as
        before (regression guard: existing behavior preserved).
      * omitted 4th param (3-arg ctor) → never disabled (eligible still builds a proxy).
      * "active continues": construct a proxy while enabled, capture proxy.output; flip a shared flag to
        disabled; assert the SAME proxy.output is still the live stream the decorator returned (the decorator
        cannot reach it) — model this with a mutable `let flag=false` closure the callback reads.
  - ADD/RE-INFORCE: after shutdown(), `f.registered` is null AND a re-initialize() re-registers (no orphan).
  - FOLLOW the existing import + harness style; NAMING test_*.

Task 4: MODIFY tests/factory.test.ts (flag + callback + shutdown restore)
  - EXTEND makeFakePi to capture registerFlag calls + return a controllable getFlag value:
      `registerFlag(name, opts)` records `{name,opts}`; `getFlag(name)` returns a mutable map value.
  - ADD tests:
      * factory calls pi.registerFlag("stop-thinking", {type:"boolean", default:true}) exactly once.
      * the createDecorator spy receives a `disabledProvider` callback; flipping the fake pi's flag value to
        false makes `disabledProvider()` return true (and true/false otherwise) — proves LIVE getFlag read.
      * (re-affirm) firing session_shutdown calls decorator.shutdown() exactly once (registry restored);
        a registerFlag throw (fake pi.registerFlag throws) is swallowed (warned) and decoration STILL
        proceeds (initialize still called, handler still registered).
  - GOTCHA: existing fake factories ignore the 3rd param — that's fine; for the callback test, capture it.

Task 5: CREATE tests/lifecycle.test.ts (EC-011/012/013 end-to-end with fakes)
  - IMPLEMENT a focused suite: REAL ProviderDecorator + injected fake registry + fake ExtensionAPI (with
    registerFlag/getFlag/on). NO global-registry mutation.
  - CASES:
      * EC-011: register flag; set getFlag("stop-thinking")=false; initialize; an eligible request delegates
        without a proxy (sentinel). Set it back to true; the NEXT request builds a proxy (proxy.output).
      * EC-012: initialize (registered!=null); fire session_shutdown; assert shutdown() ran → registered==null
        (no orphan) → the fake "builtin" is what a future getApiProvider would return.
      * EC-013: initialize → shutdown → initialize again; assert re-capture + re-register (registered!=null
        again, a fresh capture call recorded). Existing streams "continue" is architectural (assert at proxy
        level in Task 3; here assert the cycle is clean).
  - PLACEMENT: tests/lifecycle.test.ts (flat tests/ dir; excluded from build).

Task 6: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck → 0; npx bun run build → exit 0; npx bun test → ALL green.
  - RUN: Level 3 real-registry node smoke + Level 4 scope gates below.
```

### Implementation Patterns & Key Details

```typescript
// decorator.ts — the exact diff (context shown for placement). Existing lines UNCHANGED except the additions.

// … existing fields …
export class ProviderDecorator {
  private readonly config: Config;
  private readonly diagnostics: Diagnostics;
  private readonly registry: ProviderRegistry;
  private original: CapturedProvider | undefined;
  private registered = false;
  /** EC-011: runtime disable check, evaluated PER REQUEST. See ctor + wrapperStreamSimple. */
  private readonly _disabledProvider: () => boolean; // ← ADD

  constructor(
    config: Config,
    diagnostics: Diagnostics,
    registry: ProviderRegistry = DEFAULT_REGISTRY,
    disabledProvider?: () => boolean, // ← ADD (4th optional; default never-disabled below)
  ) {
    this.config = config;
    this.diagnostics = diagnostics;
    this.registry = registry;
    this._disabledProvider = disabledProvider ?? (() => false); // ← ADD (behavior-preserving default)
  }

  initialize(): void {
    // … STEP 1 capture (UNCHANGED) …
    // … const wrapperStream (UNCHANGED) …

    const wrapperStreamSimple: ApiStreamSimpleFunction = (model, context, options) => {
      // EC-011 (PRD Appendix B): runtime disable flag (e.g. --no-stop-thinking). Delegate WITHOUT a proxy for
      // NEW requests. Active transitions are unreachable (own closure) and run to completion. Distinct from
      // EC-016 (config.enabled), checked in `eligible` below.
      if (this._disabledProvider()) {                                    // ← ADD (top guard)
        this.diagnostics.debug("provider.streamSimple.disabled-delegate", {
          api: model.api,
          provider: String(model.provider),
          model: model.id,
        });
        return originalStreamSimple(model, context, options);
      }
      // Activation conditions per PRD §19.5 / §19.6 … (UNCHANGED)
      const eligible =
        this.config.enabled &&
        model.reasoning &&
        this.config.supportedProviders.includes(String(model.provider));
      if (eligible) {
        // … new StreamProxy(...) ; return proxy.output ; (UNCHANGED) …
      }
      // … delegate ; (UNCHANGED) …
    };
    // … STEP 3 register (UNCHANGED) …
  }
  // shutdown() UNCHANGED.
}
```

```typescript
// index.ts — the exact diff. Existing lines UNCHANGED except the additions.

export type DecoratorFactory = (
  config: Config,
  diagnostics: Diagnostics,
  disabledProvider?: () => boolean, // ← ADD
) => DecoratorLifecycle;

const createDefaultDecorator: DecoratorFactory = (config, diagnostics, disabledProvider) => // ← ADD param
  new ProviderDecorator(config, diagnostics, undefined, disabledProvider);                    // ← forward

export default function stopThinkingExtension(pi, createDecorator = createDefaultDecorator) {
  let diagnostics;
  try {
    const config = loadConfig();
    diagnostics = createDiagnostics(config.diagnosticsLevel);

    // EC-011: register the CLI disable flag. Non-fatal (own try/catch) — a fault is warned + decoration
    // proceeds; getFlag then yields undefined → the callback returns "not disabled".
    try {                                                                   // ← ADD block
      pi.registerFlag("stop-thinking", {
        type: "boolean",
        default: true,
        description: "Enable Stop Thinking & Do — interrupt z.ai reasoning and answer directly.",
      });
    } catch (err) {
      diagnostics.warn("extension.flag-register-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Thread the LIVE disable check (per-request getFlag read) into the decorator.
    const decorator = createDecorator(                                       // ← ADD 3rd arg
      config,
      diagnostics,
      () => pi.getFlag("stop-thinking") === false,
    );
    decorator.initialize();

    // session_shutdown → shutdown → unregisterApiProviders (EC-012). UNCHANGED.
    pi.on("session_shutdown", () => {
      try { decorator.shutdown(); }
      catch (err) { diagnostics?.error("extension.shutdown-failed", { error: err instanceof Error ? err.message : String(err) }); }
    });

    diagnostics.info("extension.started", {});
  } catch (err) {
    // … UNCHANGED never-crash catch …
  }
}
```

### Integration Points

```yaml
CONSUMERS:
  Pi extension loader:
      import stopThinkingExtension from "pi-stop-thinking";   // dist/index.js (package "main")
      stopThinkingExtension(pi);                              // Pi calls with ONE arg
  Pi CLI flag: `pi --no-stop-thinking` (or `--stop-thinking=false`) → getFlag("stop-thinking")===false →
      all NEW z.ai reasoning requests delegate transparently (no proxy). (README docs land in P1.M8.T5.)
  P1.M8.T4 (stress/chaos): will toggle the flag + simulate reload/unload — these paths must stay deterministic.

BUILD:
  - entries touched: src/provider/decorator.ts + src/index.ts (tsc rootDir src / outDir dist).
  - emit: dist/provider/decorator.{js,d.ts} + dist/index.{js,d.ts} (no new files in dist).

NO CHANGES TO: package.json, tsconfig.json, .gitignore, src/provider/proxy.ts, src/types.ts,
  src/config/*, src/diagnostics/*, src/state/*, src/shortcut/*, src/request/*, src/buffer/*,
  src/telemetry/*. (proxy.ts + types.ts are owned by the parallel P1.M8.T2.S2.)
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. Common failures: DecoratorFactory widen not applied everywhere → re-check
#   createDefaultDecorator + the createDecorator call; or ProviderDecorator ctor arity mismatch.

# Build (emit dist):
npx bun run build            # = tsc
# Expected: exit 0; dist/provider/decorator.{js,d.ts} + dist/index.{js,d.ts} refreshed.
```
> `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# The modified + new suites:
npx bun test tests/provider-decorator.test.ts tests/factory.test.ts tests/lifecycle.test.ts
# Expected: all green (EC-011 disabled-bypass + default-never-disabled + active-continues; flag registered;
#   live getFlag callback; session_shutdown → shutdown → no-orphan; registerFlag-fault isolation; EC-013 re-init).

# Full suite (must not regress anything, incl. P1.M8.T2.S2's suites once merged):
npx bun test
# Expected: every test passes.
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect, mock } from "bun:test"`.

### Level 3: Integration (real wiring — isolated node, restores the global registry)

```bash
# EC-012 + EC-013 real-registry proof (the only test that mutates the global pi-ai registry — restore after):
node -e "import('@earendil-works/pi-ai').then(async ({ getApiProvider }) => {
  const { ProviderDecorator } = await import('./dist/provider/decorator.js');
  const cfg = { enabled:true, shortcut:'ctrl+.', supportedProviders:['zai'], transitionTimeoutMs:5000,
    replacementStartupTimeoutMs:10000, maximumReasoningBufferBytes:8388608, telemetryEnabled:false, diagnosticsLevel:'error' };
  const diag = { trace(){}, debug(){}, info(){}, warn(){}, error(){} };
  const orig = getApiProvider('openai-completions');
  const d = new ProviderDecorator(cfg, diag);
  d.initialize();
  console.log('registered (changed):', getApiProvider('openai-completions') !== orig);   // true (EC-012 setup)
  d.shutdown();
  console.log('EC-012 no orphan (restored):', getApiProvider('openai-completions') === orig); // true
  d.initialize();                                                                         // EC-013 re-init
  console.log('EC-013 re-registered:', getApiProvider('openai-completions') !== orig);   // true
  d.shutdown();                                                                           // restore for cleanliness
  console.log('final restored:', getApiProvider('openai-completions') === orig);         // true
});"
# Expected: registered (changed): true | EC-012 no orphan (restored): true | EC-013 re-registered: true | final restored: true

# EC-011 flag-driven bypass (real decorator + fake flag map; no proxy constructed when disabled):
node -e "(async () => {
  const { ProviderDecorator } = await import('./dist/provider/decorator.js');
  const flags = new Map([['stop-thinking', true]]);
  const cfg = { enabled:true, shortcut:'ctrl+.', supportedProviders:['zai'], transitionTimeoutMs:5000,
    replacementStartupTimeoutMs:10000, maximumReasoningBufferBytes:8388608, telemetryEnabled:false, diagnosticsLevel:'error' };
  const diag = { trace(){}, debug(){}, info(){}, warn(){}, error(){} };
  // fake registry: the 'builtin' returns a sentinel; capture what the wrapper returns
  const sentinel = { __s:1 };
  let builtinCalls = 0;
  const fakeProvider = { api:'openai-completions',
    stream:(...a)=>{ builtinCalls++; return sentinel; },
    streamSimple:(...a)=>{ builtinCalls++; return sentinel; } };
  const reg = {
    getApiProvider: () => fakeProvider,
    registerApiProvider: () => {},
    unregisterApiProviders: () => {},
  };
  const d = new ProviderDecorator(cfg, diag, reg, () => flags.get('stop-thinking') === false);
  d.initialize();
  const eligibleModel = { id:'m', name:'M', api:'openai-completions', provider:'zai', reasoning:true };
  flags.set('stop-thinking', false);                       // disabled
  const outDisabled = reg /*placeholder*/; void outDisabled;
  const r1 = fakeProvider.streamSimple; // call via the registered wrapper instead:
  // Re-fetch the registered wrapper through the fake registry to exercise the real guard:
  let captured; reg.registerApiProvider = (p)=>{ captured = p; };
  d.initialize(); // re-register to capture the wrapper (idempotent guard: shutdown first)
  d.shutdown(); d.initialize();
  const disabledOut = captured.streamSimple(eligibleModel, {messages:[]}, {});
  console.log('disabled delegates to builtin (no proxy):', disabledOut === sentinel, '| builtin calls:', builtinCalls);
})();"
# Expected: disabled delegates to builtin (no proxy): true | builtin calls: >=1
# (This is illustrative — the authoritative assertion is the bun unit test in Task 3/5 with the clean harness.
#  Keep the Level-3 command simple; prefer the unit test for the proxy-vs-sentinel distinction.)
```
> NOTE: The EC-011 proxy-vs-sentinel assertion is best expressed in the bun unit tests (Task 3/5) using the
> `STREAM_SENTINEL`/`proxy.output` distinction. The Level-3 node smoke above is a sanity check that the
> built dist wires the callback; the unit test is the source of truth.

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Scope gate — this task touches ONLY decorator.ts + index.ts in src/ (NOT proxy.ts/types.ts):
git diff --name-only HEAD -- src/ | sort
# Expected (after merge with P1.M8.T2.S2): this task's src diff = src/index.ts + src/provider/decorator.ts.
#   proxy.ts/types.ts changes belong to S2. Run this gate on this task's own commit in isolation.

# EC-011 guard gate — the disabled short-circuit precedes the eligible expression in wrapperStreamSimple:
grep -n "_disabledProvider\|const eligible" src/provider/decorator.ts
# Expected: the `_disabledProvider()` guard line number is LESS than the `const eligible` line number.

# Flag-registration gate — exactly one registerFlag call, name "stop-thinking", type boolean, default true:
grep -n 'registerFlag("stop-thinking"' src/index.ts
# Expected: 1 match with type:"boolean" and default:true in the same call.

# Non-fatal-flag gate — registerFlag is wrapped in its own try/catch (NOT the outer init try/catch only):
grep -n 'registerFlag\|flag-register-failed' src/index.ts
# Expected: registerFlag and the "extension.flag-register-failed" warn both present inside a nested try/catch.

# Live-callback gate — the disable callback reads getFlag (per-request), not a captured-once boolean:
grep -n 'pi.getFlag("stop-thinking") === false' src/index.ts
# Expected: 1 match (the 3rd arg to createDecorator).

# No-proxy-bookkeeping gate — the decorator does NOT track live proxies (architectural purity):
grep -nE "Set<.*[Pp]roxy|activeProxies|proxies\b|liveProxy" src/provider/decorator.ts
# Expected: no matches (active-continues is architectural; no registry of running proxies).

# session_shutdown wiring UNCHANGED gate — still registered after initialize, still guarded:
grep -n 'session_shutdown\|decorator.shutdown()' src/index.ts
# Expected: the `session_shutdown` `pi.on` block present; `decorator.shutdown()` inside a try/catch.

# Confirm git sees only intended changes:
git add -A && git status --short
# Expected MODIFIED: src/provider/decorator.ts, src/index.ts, tests/provider-decorator.test.ts,
#   tests/factory.test.ts; NEW: tests/lifecycle.test.ts. NO proxy.ts/types.ts/package.json/tsconfig.json.
```

---

## Test Specification (reference additions — implement with `bun:test`)

```typescript
// tests/provider-decorator.test.ts — ADD to the existing suite (reuse makeFakeRegistry, baseConfig,
// STREAM_SENTINEL, mkModel, ctx, opts, noopDiagnostics).

describe("ProviderDecorator — EC-011 runtime disable", () => {
  function setup(disabledProvider?: () => boolean) {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry, disabledProvider);
    d.initialize();
    const wrapper = f.registered as {
      streamSimple: (m: unknown, c: unknown, o: unknown) => unknown;
    };
    return { f, d, wrapper };
  }

  test("disabled → an eligible z.ai reasoning request delegates WITHOUT constructing a proxy", () => {
    const { f, wrapper } = setup(() => true);
    const out = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(out).toBe(STREAM_SENTINEL);           // the builtin's value, NOT a proxy.output
    expect(f.stats.simpleCalls).toBe(1);         // delegated straight through
    expect(f.stats.lastSimpleArgs()).toEqual([mkModel(), ctx, opts]);
  });

  test("disabledProvider = () => false (default when omitted) → eligible STILL builds a proxy", () => {
    // 3-arg ctor → never disabled → existing behavior preserved (regression guard)
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    const wrapper = f.registered as { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown };
    const out = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(out).not.toBe(STREAM_SENTINEL);       // a proxy.output (a fresh AssistantMessageEventStream)
  });

  test("an ACTIVE transition is unaffected when the flag flips to disabled after construction", () => {
    let flag = false;                            // enabled at construction
    const { wrapper } = setup(() => flag);
    const proxyOutput = wrapper.streamSimple(mkModel(), ctx, opts); // builds a proxy (flag=false)
    expect(proxyOutput).not.toBe(STREAM_SENTINEL);
    flag = true;                                 // disable AFTER the proxy exists
    // The already-returned proxyOutput is the SAME live stream; the decorator cannot reach/tear it down.
    expect(wrapper.streamSimple(mkModel(), ctx, opts)).toBe(STREAM_SENTINEL); // NEW request now bypasses
    // (the first proxy is unaffected — it holds its own closure; we assert the decorator merely routes the
    //  next request past it, which is the observable EC-011 contract.)
  });
});

describe("ProviderDecorator — EC-012 no orphaned registration after shutdown", () => {
  test("shutdown removes our registration; the builtin is what a future lookup returns; re-init works", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    expect(f.registered).not.toBeNull();
    d.shutdown();
    expect(f.registered).toBeNull();             // no orphan (EC-012 "registration restored")
    d.initialize();                              // EC-013 re-init re-captures + re-registers
    expect(f.registered).not.toBeNull();
  });
});
```

```typescript
// tests/factory.test.ts — EXTEND makeFakePi to capture registerFlag + a controllable getFlag map, then ADD:

describe("stopThinkingExtension — EC-011 flag registration + disable callback", () => {
  test("registers the stop-thinking boolean flag (default true) exactly once", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);
    const reg = pi.registeredFlags.find((x) => x.name === "stop-thinking");
    expect(reg).toBeDefined();
    expect(reg.options.type).toBe("boolean");
    expect(reg.options.default).toBe(true);
  });

  test("the disable callback reflects the LIVE getFlag value (per-request read)", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    let captured: (() => boolean) | undefined;
    stopThinkingExtension(pi.pi, (config, diag, disabledProvider) => {
      captured = disabledProvider;
      return f.createDecorator(config, diag); // underlying fake ignores it
    });
    expect(captured).toBeTypeOf("function");
    pi.setFlagValue("stop-thinking", true);  expect(captured!()).toBe(false); // enabled → not disabled
    pi.setFlagValue("stop-thinking", false); expect(captured!()).toBe(true);  // disabled
  });

  test("a registerFlag fault is swallowed (warned) and decoration STILL proceeds", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi({ registerFlagThrows: true });
    const { sink } = makeCapturingDiagnostics();
    // hand the entry point's diagnostics into the path so we can see the warn:
    expect(() => stopThinkingExtension(pi.pi, f.createDecorator)).not.toThrow();
    expect(f.initialize).toHaveBeenCalledTimes(1); // decoration proceeded despite the flag fault
    expect(pi.shutdownRegistered).toBe(true);       // session_shutdown still registered
  });
});

describe("stopThinkingExtension — EC-012 session_shutdown restores registration", () => {
  test("firing session_shutdown calls decorator.shutdown() exactly once (no orphan)", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);
    pi.fireShutdown();
    expect(f.shutdown).toHaveBeenCalledTimes(1); // → unregisterApiProviders(sourceId) in the real decorator
  });
});
```

```typescript
// tests/lifecycle.test.ts — NEW. REAL ProviderDecorator + fake registry + fake ExtensionAPI.
import { describe, test, expect, mock } from "bun:test";
import { ProviderDecorator, STOP_THINKING_SOURCE_ID, OPENAI_COMPLETIONS_API } from "../src/provider/decorator";
import type { ProviderRegistry } from "../src/provider/decorator";
import type { Config, Diagnostics } from "../src"; // adjust to actual re-exports; else import from siblings

const STREAM_SENTINEL = { __s: 1 } as unknown;
const noopDiag: Diagnostics = { trace(){}, debug(){}, info(){}, warn(){}, error(){} } as Diagnostics;
const baseConfig: Config = { /* … same fields as provider-decorator.test.ts … */ } as Config;

function makeFakeRegistry() { /* … identical to provider-decorator.test.ts (returns registry, registered, stats) … */ }
function makeFakePi() {
  const flags = new Map<string, boolean | string>([["stop-thinking", true]]);
  let shutdownHandler: ((e: unknown, ctx: unknown) => void) | null = null;
  return {
    pi: {
      registerFlag: (name: string, opts: { type: string; default?: unknown }) => { flags.set(name, opts.default ?? true); },
      getFlag: (name: string) => flags.get(name),
      on: (ev: string, h: (e: unknown, ctx: unknown) => void) => { if (ev === "session_shutdown") shutdownHandler = h; },
    } as never,
    setFlag: (v: boolean) => flags.set("stop-thinking", v),
    fireShutdown: () => shutdownHandler?.({ type: "session_shutdown", reason: "reload" }, {}),
  };
}
const mkModel = () => ({ id:"m", name:"M", api:OPENAI_COMPLETIONS_API, provider:"zai", reasoning:true }) as never;
const ctx = { messages: [] } as never; const opts = {} as never;

describe("lifecycle — EC-011/012/013", () => {
  test("EC-011: flag=false bypasses the proxy; flag=true builds it (live, per-request)", () => {
    const pi = makeFakePi();
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry, () => pi.pi.getFlag("stop-thinking") === false);
    d.initialize();
    const wrapper = f.registered as { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown };
    pi.setFlag(false); expect(wrapper.streamSimple(mkModel(), ctx, opts)).toBe(STREAM_SENTINEL); // no proxy
    pi.setFlag(true);  expect(wrapper.streamSimple(mkModel(), ctx, opts)).not.toBe(STREAM_SENTINEL); // proxy
  });
  test("EC-012: session_shutdown → shutdown → no orphaned registration", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);
    d.initialize(); expect(f.registered).not.toBeNull();
    d.shutdown();   expect(f.registered).toBeNull();      // restored (no orphan)
  });
  test("EC-013: shutdown → initialize re-registers cleanly (reload cycle)", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiag, f.registry);
    d.initialize(); d.shutdown(); d.initialize();          // reload = restore then re-capture/re-register
    expect(f.registered).not.toBeNull();
  });
});
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` → exit 0; `dist/provider/decorator.{js,d.ts}` + `dist/index.{js,d.ts}` refreshed.
- [ ] `npx bun test tests/provider-decorator.test.ts tests/factory.test.ts tests/lifecycle.test.ts` → green.
- [ ] `npx bun test` → ALL green (no regression in any pre-existing suite, incl. P1.M8.T2.S2's once merged).
- [ ] Level 3 real-registry node smoke: EC-012 restore (`===`) + EC-013 re-register both hold.

### Feature Validation
- [ ] EC-011: `disabledProvider()` true → eligible z.ai reasoning request delegates WITHOUT a proxy (sentinel);
      false/omitted → proxy built as before; an active proxy is unaffected by a later flip.
- [ ] EC-012: `session_shutdown` → `shutdown()` → `unregisterApiProviders(sourceId)`; no orphaned registration.
- [ ] EC-013: `shutdown()` → `initialize()` re-captures + re-registers cleanly.
- [ ] Flag `stop-thinking` registered (boolean, default true); the disable callback reads `getFlag` LIVE.
- [ ] A `registerFlag` fault is swallowed + warned; decoration still proceeds (never crash Pi, App. K).

### Code Quality Validation
- [ ] `disabledProvider` defaults to `() => false` (omitting it preserves every existing call site + test).
- [ ] EC-011 guard precedes the `eligible` expression; no proxy bookkeeping added to the decorator.
- [ ] Mirrors sibling conventions (Mode-A JSDoc, DI-by-optional-param, fake-double tests, flat tests/, npx-bun).
- [ ] Only `src/provider/decorator.ts` + `src/index.ts` edited in src/; `proxy.ts`/`types.ts` untouched.

### Documentation & Deployment
- [ ] Decorator module banner + ctor/wrapper JSDoc document EC-011 (per-request gate; active-continues; ≠ EC-016).
- [ ] Factory JSDoc documents the flag-registration step, the non-fatal-flag note, and the live `getFlag` callback.
- [ ] (README `--no-stop-thinking` docs are deferred to P1.M8.T5 — NOT edited here.)

---

## Anti-Patterns to Avoid

- ❌ Don't read `getFlag` once at init — read it PER-REQUEST via a callback (it's a LIVE value; runner can
  `setFlagValue`; CLI values land after registration). A once-captured boolean misses dynamic changes.
- ❌ Don't let a `registerFlag` failure skip decoration — wrap ONLY the flag call in its own try/catch so the
  extension still works (just without the runtime gate). The outer init try/catch is the never-crash backstop,
  not the primary guard for the flag.
- ❌ Don't conflate EC-011 (runtime flag) with EC-016 (config.enabled). The flag is a NEW guard ABOVE `eligible`;
  config.enabled stays where it is. Both must hold to build a proxy.
- ❌ Don't add a registry of live proxies / "abort active transitions on disable" to the decorator. Active
  transitions continue by architectural design (the proxy owns its closure; the flag is checked only at request
  start). Tracking proxies would violate the fire-and-forget/GC-when-drained contract and is unnecessary.
- ❌ Don't edit `src/provider/proxy.ts` or `src/types.ts` — P1.M8.T2.S2 owns those in parallel.
- ❌ Don't run the real pi-ai registry inside bun unit tests — inject a fake registry (DI). Real-registry proof
  is Level 3 (isolated node, restored afterward).
- ❌ Don't widen scope into wiring the `TransitionCoordinator`/`ShortcutManager` into the factory — that is a
  separate wiring concern, not lifecycle cleanup.
