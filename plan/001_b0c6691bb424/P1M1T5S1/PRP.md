# PRP — P1.M1.T5.S1: index.ts Factory Wiring (Initialization & Shutdown)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer)
> **Subtask**: P1.M1.T5.S1 (Phase 0 Foundation, 1 pt) — the **extension entry point / factory** that wires
> Configuration + Diagnostics + ProviderDecorator together, registers `session_shutdown` cleanup, and
> guarantees no initialization failure can ever crash Pi.
> **Builds on**: P1.M1.T1.S1 (scaffold) + **P1.M1.T2.S1 (Configuration)** + **P1.M1.T3.S1 (Diagnostics)**
> + **P1.M1.T4.S1 (ProviderDecorator)**. It replaces the `src/index.ts` stub with the real factory and
> completes **Phase 0** (observational-equivalence milestone).
>
> **Parallel context**: P1.M1.T4.S1 (ProviderDecorator) is being implemented in parallel. Its PRP is
> treated as a CONTRACT — it exports `ProviderDecorator` (class with `initialize(): void` /
> `shutdown(): void`, constructor `(config: Config, diagnostics: Diagnostics, registry?)`), plus the
> `STOP_THINKING_SOURCE_ID` / `OPENAI_COMPLETIONS_API` constants, from `src/provider/decorator.ts`. This
> factory consumes that class (default-registry path) and its lifecycle methods.

---

## Goal

**Feature Goal**: Implement the Pi extension factory `export default function stopThinkingExtension(pi: ExtensionAPI): void`
that (a) loads `Config` via `loadConfig()`, (b) creates a `Diagnostics` logger via
`createDiagnostics(config.diagnosticsLevel)`, (c) constructs a `ProviderDecorator` and calls
`.initialize()` (which captures Pi's built-in provider and registers the transparent wrapper), and
(d) registers `pi.on("session_shutdown", () => decorator.shutdown())` for cleanup (EC-012). The ENTIRE
sequence is wrapped in `try/catch` so that **any** initialization failure logs an error and skips
decoration rather than crashing Pi — preserving the PRD invariant that *"invalid config never prevents
normal provider delegation"* (PRD Appendix K) and ADR-005 observational equivalence (if we never decorate,
Pi runs its unmodified built-in). This completes Phase 0: with the extension installed, all provider
requests are delegated transparently with zero observable behavioral change.

**Deliverable**:
- `src/index.ts` exporting the default factory `stopThinkingExtension(pi, createDecorator?)` plus the
  internal **DI seam** types `DecoratorLifecycle` and `DecoratorFactory` (used only for tests). Full
  **JSDoc (Mode A)**: module banner (Phase-0 responsibility), the factory (the 5-step init sequence +
  the never-crash-Pi guarantee + the session_shutdown cleanup rationale), the `DecoratorFactory` seam.
- `README.md` updated with **installation instructions** (`npm:pi-stop-thinking` in
  `~/.pi/agent/settings.json` `packages` array; `pi install npm:pi-stop-thinking`), plus a short
  "What it does (Phase 0)" note (Mode A docs deliverable).
- `tests/factory.test.ts` — Bun unit tests using an injected fake decorator factory (no global-registry
  mutation) + a fake `ExtensionAPI` double that captures the `session_shutdown` handler: happy path
  (initialize + handler registered + shutdown-on-event), init-failure (caught, no rethrow, handler NOT
  registered, diagnostics error emitted), and shutdown-failure isolation (shutdown throw swallowed).

**Success Definition**: From a clean checkout (after T1 scaffold + T2 config + T3 diagnostics + T4
decorator land), `npx bun run typecheck && npx bun run build && npx bun test` all exit 0;
`dist/index.js` + `dist/index.d.ts` are emitted and the factory is the default export; every test in
`tests/factory.test.ts` passes; the installed extension delegates all provider requests transparently
(Phase 0 milestone). An isolated node smoke (Level 3) proves the real wiring changes the pi-ai
registry entry on init and restores it on the simulated `session_shutdown` handler.

---

## Why

- **The seam between the extension and Pi's runtime.** `src/index.ts` is `package.json` `"main"` — the
  single entry point Pi invokes via the `ExtensionFactory` contract. Every later phase (M2 StreamProxy
  activation, M4 shortcut wiring, …) grows from THIS closure. Getting the init/shutdown lifecycle right
  now is what makes the decorator reversible and the extension safe to ship.
- **Never crash the host (PRD Appendix K + ADR-005 + EC-016).** The extension is *optional decoration*.
  If config is malformed, a dependency throws, or the built-in provider is unexpectedly absent, Pi must
  continue working with its **unmodified** built-in provider. The factory's top-level `try/catch` is the
  load-bearing guard that enforces this: on failure we log and skip, leaving the registry untouched
  (decoration simply never happens). This is the operational expression of "observational equivalence
  when inactive."
- **Reversibility / cleanup (EC-012 — Extension Unloaded Mid-Transition).** Decoration must be
  reversible. Registering `pi.on("session_shutdown", () => decorator.shutdown())` ensures that on quit,
  reload, or session switch, `unregisterApiProviders("stop-thinking-extension")` runs and restores the
  built-in provider. (EC-013 provider-reload is also covered: a reload fires `session_shutdown` then a
  fresh factory call re-captures the restored built-in — see research/extension-api-contract.md.)
- **Phase 0 closure.** This subtask is the last piece of Phase 0 (PRD §50 Phase 0 Deliverables:
  "Extension skeleton, Provider capture, Provider registration, Delegation validation, Diagnostics,
  Feature flag"). Wiring the factory makes the decorator live and the milestone shippable.

## What

A TypeScript module `src/index.ts` (the default-export factory) that:

1. Wraps the whole body in a single `try { … } catch { … }` so **no** init error escapes to Pi.
2. `const config = loadConfig();` — pure, always returns a valid `Config` (falls back to defaults).
3. `const diagnostics = createDiagnostics(config.diagnosticsLevel);` — frozen structured logger.
4. `const decorator = createDecorator(config, diagnostics);` — defaults to
   `new ProviderDecorator(config, diagnostics)` (real pi-ai registry); tests inject a fake.
5. `decorator.initialize();` — captures + registers the transparent wrapper under
   `"stop-thinking-extension"`. (MUST be after `createDecorator`; throws if the built-in provider is
   absent — caught by the outer try/catch.)
6. `pi.on("session_shutdown", () => { try { decorator.shutdown(); } catch (e) { diagnostics.error(...); } });`
   — register cleanup ONLY after `initialize()` succeeded (nothing to clean up otherwise).
7. In the `catch`: if `diagnostics` exists, `diagnostics.error("extension.init-failed", { error })`;
   otherwise `console.error(...)` (covers the impossible-but-defensive case where config/diagnostics
   itself failed). **Do not rethrow.** Pi keeps its built-in provider unmodified.

Plus README.md install docs, and `tests/factory.test.ts`.

**Out of scope** (owned by other subtasks — do NOT implement here):
- The StreamProxy activation (intercepting eligible z.ai reasoning streams) → **P1.M2.T3.S1**. In this
  phase the decorator's wrapper always delegates transparently; the factory just installs it.
- Shortcut registration (`pi.registerShortcut`) + TransitionCoordinator → **P1.M4.T3/T4**. The factory
  does NOT call `registerShortcut` in this subtask (the Phase-0 contract is decoration-only).
- Telemetry module → **P1.M8.T1**. No `pi.on("message_update", …)` or metrics here.
- Anything inside `src/provider/decorator.ts`, `src/config/*`, `src/diagnostics/*`, `src/state/*`,
  `src/provider/proxy.ts`, `src/types.ts`, `package.json`, `tsconfig.json` → owned by T1–T4 / forbidden.

### Success Criteria

- [ ] `src/index.ts` default-exports `stopThinkingExtension(pi, createDecorator?)` and also exports the
      `DecoratorLifecycle` + `DecoratorFactory` types (the test seam).
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/index.js` + `dist/index.d.ts`; the factory is the default export.
- [ ] `npx bun test` passes (factory tests green; decorator/diagnostics/config/smoke still green).
- [ ] Factory happy path: `decorator.initialize()` is called exactly once and a `session_shutdown`
      handler is registered on `pi`; firing that handler calls `decorator.shutdown()` exactly once.
- [ ] Factory init-failure path: when `decorator.initialize()` throws, the factory does NOT rethrow,
      does NOT register a `session_shutdown` handler, and emits a `diagnostics.error(...)` line.
- [ ] Factory shutdown-failure isolation: if `decorator.shutdown()` throws inside the handler, the
      thrown error is swallowed (logged) and does **not** propagate out of the `session_shutdown` handler.
- [ ] No global-registry mutation in unit tests (the injected fake decorator never touches pi-ai).
- [ ] `README.md` documents installation (`npm:pi-stop-thinking` in the `packages` array; or
      `pi install npm:pi-stop-thinking`).
- [ ] No edits to `package.json`, `tsconfig.json`, `.gitignore`, `src/config/*`, `src/diagnostics/*`,
      `src/provider/*`, `src/state/*`, `src/types.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the exact `ExtensionFactory` / `ExtensionAPI.on("session_shutdown", …)`
signatures (verified against the installed `pi-coding-agent@0.80.3` `.d.ts`), the exact input contracts
from T2/T3/T4 (function names, signatures, "never throws" guarantees), the complete reference
implementation, the full fake-decorator + fake-`ExtensionAPI` test harness, the README diff, and the
exact build/test commands. The one design decision (a `createDecorator` DI seam) is justified in
`research/factory-testability.md` and mirrors the established repo convention (T4's optional `registry`
param).

### Documentation & References

```yaml
# MUST READ — authoritative contracts for THIS module
- file: plan/001_b0c6691bb424/P1M1T5S1/research/extension-api-contract.md
  why: "VERIFIED ExtensionFactory type = (pi: ExtensionAPI) => void | Promise<void> (sync `void` is correct),
        the exact on('session_shutdown', handler) signature, SessionShutdownEvent.reason values, the
        observation that pi-ai builtins are registered BEFORE factories run (so initialize() won't throw in
        prod), and the exact settings.json `packages` format for the README."
  critical: "Factory must be SYNC (`void`), register session_shutdown AFTER initialize() succeeds, and the
        README install entry is `npm:pi-stop-thinking` in `~/.pi/agent/settings.json` packages array."

- file: plan/001_b0c6691bb424/P1M1T5S1/research/factory-testability.md
  why: "Justifies the createDecorator DI seam (why NOT module-mocking; why NOT inject loadConfig/
        createDiagnostics), and lists exactly what the fake ExtensionAPI double needs (only `on`)."
  critical: "Inject ONLY the decorator factory (the single global-state-mutating step). The default export's
        second optional param is invisible to Pi (Pi calls it with one arg) — this is the repo's established
        DI-by-optional-param convention (see T4's optional `registry` param)."

# INPUT contracts (already shipped / being implemented — consume, do not modify)
- file: src/config/index.ts   # (P1.M1.T2.S1 — DONE)
  why: "Exports loadConfig(partial?: Partial<Config>): Config (PURE — 'never throws', falls back to defaults)
        and the Config type. config.diagnosticsLevel is typed DiagnosticsLevel ('error'|'warn'|'info'|'debug'|'trace')."
  pattern: "import { loadConfig } from './config';   // value import (we call it)"
  gotcha: "loadConfig is pure and side-effect-free — safe to call the REAL one in tests (no seam needed)."

- file: src/diagnostics/index.ts   # (P1.M1.T3.S1 — DONE)
  why: "Exports createDiagnostics(level: DiagnosticsLevel, sink?: DiagnosticsSink): Diagnostics (returns a
        FROZEN logger; never throws on the logging path) and the Diagnostics / DiagnosticsSink types."
  pattern: "import { createDiagnostics } from './diagnostics'; import type { Diagnostics, DiagnosticsSink } from './diagnostics';"
  gotcha: "Pass a capturing DiagnosticsSink ({ log, error }) in tests to assert the error line emitted on
        init failure. DiagnosticsLevel is imported from '../config' inside diagnostics — but you do NOT need
        it in the factory (config.diagnosticsLevel is already typed DiagnosticsLevel)."

- file: src/provider/decorator.ts   # (P1.M1.T4.S1 — parallel; treated as CONTRACT)
  why: "Exports `class ProviderDecorator { constructor(config, diagnostics, registry?); initialize(): void;
        shutdown(): void; }`. initialize() captures the built-in openai-completions provider and registers a
        transparent wrapper under sourceId 'stop-thinking-extension' (throws if provider absent; idempotent).
        shutdown() calls unregisterApiProviders(sourceId) (idempotent; safe no-op if never initialized)."
  pattern: "import { ProviderDecorator } from './provider/decorator';"
  critical: "ProviderDecorator STRUCTURALLY satisfies DecoratorLifecycle { initialize(): void; shutdown(): void }
        — so the default DecoratorFactory `() => new ProviderDecorator(config, diagnostics)` type-checks with
        no adapter. initialize() is the only step that can throw in practice — the outer try/catch MUST catch it."

# PRD authority (PRD.md in repo root)
- url: PRD.md §50 "Phase 0 — Foundation" (Deliverables + Success Criteria)
  why: "Phase 0 objective: 'Create an observationally-equivalent provider decorator that performs zero
        behavioral changes.' Success: 'All requests behave identically with the extension installed. No
        measurable regression.' The factory is what makes the decorator LIVE — this subtask closes Phase 0."
  critical: "Phase 0 deliverables include 'Extension skeleton' + 'Feature flag' (config.enabled) — wiring the
        factory + config load delivers both. No behavioral change is the acceptance bar."

- url: PRD.md Appendix B "EC-012 — Extension Unloaded Mid-Transition"
  why: "Expected Behavior: 'Wrapper completes active request. Provider registration restored. Cleanup performed.'
        The session_shutdown handler → decorator.shutdown() is the cleanup hook that restores registration."
  critical: "Cleanup MUST be registered; the handler itself must be wrapped so a shutdown failure can't crash
        Pi's session teardown."

- url: PRD.md Appendix K — Configuration Validation Rules
  why: "'invalid config never prevents normal provider delegation' — the factory's try/catch is the runtime
        enforcement: a bad config/failed init logs and skips, leaving the built-in provider untouched."
  critical: "loadConfig already falls back to defaults (so config is always valid) — but the try/catch is the
        defense-in-depth belt AND the guard for decorator.initialize() failures."

- url: PRD.md ADR-005 "The Wrapper Must Be Observationally Equivalent" + §19.7 Pass-through Guarantee
  why: "When inactive (init failed → no decoration), the wrapper is absent and Pi uses its built-in verbatim:
        observational equivalence holds trivially. When active (Phase 0), the wrapper delegates transparently."

# Pi host docs (for the README install section)
- url: pi-coding-agent docs/settings.md §packages + docs/packages.md
  why: "packages key (string array) in ~/.pi/agent/settings.json; npm source type = `npm:<name>`; install
        command `pi install npm:<name>` writes settings automatically; npm pkgs install under ~/.pi/agent/npm/."
  critical: "Our entry is exactly `npm:pi-stop-thinking` (matches package.json `name`). Show BOTH the `pi
        install` command (preferred) and the manual settings.json edit."

# REFERENCE — established repo conventions to mirror
- file: plan/001_b0c6691bb424/P1M1T4S1/PRP.md
  why: "The immediately-preceding sibling PRP (ProviderDecorator). Mirror its structure, Mode-A JSDoc
        expectation, DI-for-testability convention (optional constructor/param seam defaulting to real),
        fake-double test style, npx-bun invocation, and validation-command style."
- file: tests/config.test.ts   # (P1.M1.T2.S1)
  why: "The proven Bun test style in THIS repo: import { describe, test, expect } from 'bun:test'; flat tests/
        dir; ../src/* imports; mock() for spies."
```

### Current Codebase tree (after T1–T4 land)

```bash
.
├── package.json          # T1: scripts build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); main "./dist/index.js"
├── tsconfig.json         # T1: ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         #     include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── README.md             # T1 skeleton (Status + Development) — needs an Installation section
├── src/
│   ├── index.ts          # ← T1 STUB (empty factory body, already imports type ExtensionAPI) — THIS becomes real
│   ├── types.ts          # T1 placeholder — DO NOT modify
│   ├── provider/
│   │   ├── decorator.ts  # T4: ProviderDecorator class + initialize/shutdown (CONTRACT)
│   │   └── proxy.ts      # T1 stub — DO NOT modify (owned by P1.M2.T2.S1)
│   ├── state/{controller,coordinator}.ts   # T1 stubs — DO NOT modify
│   ├── config/index.ts   # T2: loadConfig/Config/DEFAULT_CONFIG/validateConfig (DONE)
│   ├── diagnostics/index.ts # T3: createDiagnostics/Diagnostics/DiagnosticsSink (DONE)
│   ├── buffer/.gitkeep   # later
│   ├── shortcut/.gitkeep # later
│   └── request/.gitkeep  # later
├── tests/
│   ├── smoke.test.ts     # T1 (must stay green)
│   ├── config.test.ts    # T2 (must stay green)
│   ├── diagnostics.test.ts # T3 (must stay green)
│   └── provider-decorator.test.ts # T4 (must stay green)
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── package.json          # UNCHANGED
├── tsconfig.json         # UNCHANGED
├── README.md             # MODIFIED — add Installation (+ short Phase-0 "what it does" note)
├── src/
│   └── index.ts          # REAL (replaces stub) — default export stopThinkingExtension + DecoratorLifecycle/Factory types
│   └── ...               # all other src/ files UNCHANGED
├── tests/
│   ├── smoke.test.ts     # UNCHANGED
│   ├── config.test.ts    # UNCHANGED
│   ├── diagnostics.test.ts # UNCHANGED
│   ├── provider-decorator.test.ts # UNCHANGED
│   └── factory.test.ts   # NEW — Bun unit tests (fake decorator factory + fake ExtensionAPI double)
└── dist/{index.js,index.d.ts}  # GENERATED by `npx bun run build`
```
**File responsibilities**: `src/index.ts` = the sole entry point Pi loads — config load → diagnostics →
decorator construct+initialize → session_shutdown cleanup registration, all in a never-crash try/catch.
`tests/factory.test.ts` = lifecycle + error-isolation coverage via injected fakes. `README.md` = install
docs. No other file is touched (NOT the decorator, NOT config/diagnostics, NOT proxy/state).

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (never crash the host): the ENTIRE factory body is one try/catch. Any throw — from loadConfig
// (won't, it's pure), createDiagnostics (won't with valid level), `new ProviderDecorator`, or initialize()
// (CAN throw if the built-in provider is absent) — MUST be swallowed. On catch: log via diagnostics if
// available, else console.error; do NOT rethrow. Pi then runs its unmodified built-in provider. This is the
// runtime enforcement of PRD Appendix K ("invalid config never prevents normal provider delegation") and the
// safety guarantee that an optional extension can never brick the agent.

// CRITICAL (register cleanup AFTER initialize succeeds): call `pi.on("session_shutdown", …)` only AFTER
// `decorator.initialize()` returns. If initialize() throws, there is no wrapper registered → nothing to
// clean up → the handler is correctly NOT registered (the throw jumps to catch before the `on` call).
// decorator.shutdown() is idempotent and a safe no-op when never initialized, so this is a cleanliness choice.

// CRITICAL (wrap the shutdown handler too): the session_shutdown handler must itself be try/catch-guarded.
// If decorator.shutdown() throws during Pi's session teardown, swallowing + logging prevents the cleanup
// error from propagating into Pi's shutdown path. (defense-in-depth; matches EC-012 "cleanup performed".)

// GOTCHA (factory is SYNC): ExtensionFactory = (pi) => void | Promise<void>. Use `void` (sync) — every step
// is synchronous. Do NOT add async/await; it adds a rejection path Pi would have to await and is unnecessary.

// GOTCHA (DI seam = optional second param, invisible to Pi): Pi invokes the default export with ONE argument.
// Adding `createDecorator?: DecoratorFactory = createDefaultDecorator` as a second optional param does NOT
// change the external contract — Pi still calls `stopThinkingExtension(pi)`. This mirrors T4's optional
// `registry?` constructor param (the repo's established DI convention). Tests pass a fake; production uses
// the default (real ProviderDecorator, real pi-ai registry).

// GOTCHA (loadConfig/createDiagnostics are safe to call for real in tests): both are pure/side-effect-free
// (T2: "Pure: never throws"; T3: "never throws on the logging path"). Only the DECORATOR mutates global state
// (the pi-ai registry via initialize()) → only IT needs a seam. Do NOT inject loadConfig/createDiagnostics.

// GOTCHA (ProviderDecorator structurally satisfies DecoratorLifecycle): the class has initialize(): void +
// shutdown(): void, so `() => new ProviderDecorator(config, diagnostics)` is assignable to
// DecoratorFactory = (config, diagnostics) => DecoratorLifecycle with no adapter. Do NOT add a wrapper layer.

// GOTCHA (frozen Diagnostics): createDiagnostics returns Object.isFrozen(logger). Pass it BY REFERENCE to the
// decorator (the decorator's constructor takes `diagnostics: Diagnostics`). Do not reassign its methods.

// GOTCHA (the shutdown handler captures `decorator` by closure): declare `decorator` with `const` inside the
// try block BEFORE registering the handler, so the closure binds the initialized instance. Because the handler
// is registered after initialize() succeeds, `decorator` is always the live instance when the handler fires.

// GOTCHA (bun is a local devDep, NOT on PATH): invoke as `npx bun ...` / `npx bun run <script>`, NOT bare
// `bun`/`bunx` (those fail outside an npm-script context). package.json scripts resolve via `npx bun run`.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → `npx bun run typecheck` checks src ONLY.
// tests/factory.test.ts is validated by `npx bun test` (Bun runs TS natively). Do not add tests to build include.

// GOTCHA (privacy — Appendix H): the only fields ever passed to diagnostics from the factory are
// { error: <String(err)> } on failure and (optionally) {} on success. NEVER log config, options, context,
// messages, or any prompt/output text. String(err) is safe (it is an error message category, not user data).
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// src/index.ts — public type surface (the test seam + the factory)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { createDiagnostics } from "./diagnostics";
import type { Diagnostics } from "./diagnostics";
import { ProviderDecorator } from "./provider/decorator";

/**
 * The lifecycle surface the factory needs from the decorator. `ProviderDecorator` satisfies this
 * structurally (it has initialize(): void + shutdown(): void), so no adapter is required.
 */
export interface DecoratorLifecycle {
  initialize(): void;
  shutdown(): void;
}

/**
 * Constructs a decorator from (config, diagnostics). Production uses the default (which builds the real
 * `ProviderDecorator` against pi-ai's live registry); tests inject a fake returning a spy so the global
 * registry is never mutated. This is the ONLY dependency-injection seam the factory exposes.
 */
export type DecoratorFactory = (config: Config, diagnostics: Diagnostics) => DecoratorLifecycle;

/** Default decorator factory: builds the real ProviderDecorator (real pi-ai registry). */
const createDefaultDecorator: DecoratorFactory = (config, diagnostics) =>
  new ProviderDecorator(config, diagnostics);

export default function stopThinkingExtension(
  pi: ExtensionAPI,
  createDecorator: DecoratorFactory = createDefaultDecorator,
): void {
  // ... see "Implementation Patterns" for the body
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REPLACE src/index.ts (stub → real factory)
  - OVERWRITE the empty factory body with the reference implementation in "Implementation Patterns".
  - KEEP the existing `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` (already present in the stub).
  - IMPORT (value): { loadConfig } from "./config"; { createDiagnostics } from "./diagnostics";
                     { ProviderDecorator } from "./provider/decorator";
  - IMPORT (type): { Config } from "./config"; { Diagnostics } from "./diagnostics";
  - IMPLEMENT: DecoratorLifecycle interface; DecoratorFactory type; createDefaultDecorator const;
    the default-export stopThinkingExtension(pi, createDecorator?) factory with the full try/catch body.
  - NAMING: camelCase function (stopThinkingExtension) + const (createDefaultDecorator);
    PascalCase interfaces/types (DecoratorLifecycle, DecoratorFactory).
  - JSDOC (Mode A): module banner (Phase-0 responsibility: install the transparent decorator + cleanup);
    factory (the 5-step init sequence + the NEVER-CRASH-PI guarantee + EC-012 cleanup rationale + the
    optional createDecorator seam); DecoratorLifecycle; DecoratorFactory (DI rationale).
  - PLACEMENT: src/index.ts (it is package.json "main").
  - GOTCHA: sync `void` return; register session_shutdown AFTER initialize(); wrap the handler body in
    try/catch; never rethrow; only diagnostics fields are { error } / {}.

Task 2: MODIFY README.md — add Installation (+ short "what it does")
  - ADD an "## Installation" section showing BOTH:
      (preferred) `pi install npm:pi-stop-thinking`
      (manual) edit ~/.pi/agent/settings.json → `"packages": ["npm:pi-stop-thinking"]`
  - ADD a one-line "## What it does (Phase 0)" note: transparently delegates all provider requests with
    zero observable behavioral change (interruption arrives in later phases).
  - PRESERVE the existing "Status" + "Development" sections.
  - GOTCHA: the packages entry is EXACTLY `npm:pi-stop-thinking` (matches package.json `name`). Do not invent
    a scope or version pin.

Task 3: CREATE tests/factory.test.ts
  - IMPLEMENT: the suite specified in "Test Specification" using `bun:test`.
  - IMPORT: `import stopThinkingExtension, { type DecoratorFactory, type DecoratorLifecycle } from "../src/index";`
    `import { createDiagnostics } from "../src/diagnostics"; import type { Diagnostics, DiagnosticsSink } from "../src/diagnostics";`
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
    `import { describe, test, expect, mock } from "bun:test";`
  - FOLLOW pattern: tests/config.test.ts / tests/provider-decorator.test.ts (Bun describe/test/expect/mock; flat tests/ dir).
  - HARNESS: a `makeFakePi()` helper returning `{ pi: ExtensionAPI, fireShutdown(): void, shutdownHandlerRegistered: boolean }`;
    a `makeFakeDecorator(opts?)` returning a spy `{ initialize: mock(() => {}), shutdown: mock(() => {}) }` and a
    matching `DecoratorFactory` that returns it; a capturing `DiagnosticsSink` (`{ log: [], error: [] }`).
  - DIAGNOSTICS: use the REAL createDiagnostics with a capturing sink so we assert the actual error line on init failure.
  - NAMING: describe("stopThinkingExtension — happy path" / "init failure isolation" / "shutdown isolation").
  - COVERAGE: initialize called once + shutdown handler registered + firing it calls shutdown once; init-failure
    (initialize throws → no rethrow, handler NOT registered, diagnostics.error emitted); shutdown-failure
    (shutdown throws inside handler → swallowed, no propagation); createDecorator receives (config, diagnostics).
  - PLACEMENT: tests/factory.test.ts (flat tests/ dir; excluded from build).

Task 4: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics.
  - RUN: npx bun run build      → dist/index.js + dist/index.d.ts created; default export present.
  - RUN: npx bun test           → all green (factory + decorator + diagnostics + config + smoke).
  - RUN: Level 3 (isolated node smoke against the REAL ProviderDecorator) + Level 4 scope gates below.
```

### Implementation Patterns & Key Details

```typescript
// src/index.ts — COMPLETE reference implementation. Author this verbatim (JSDoc included).

/**
 * # Stop Thinking & Do — Pi extension entry point.
 *
 * This module is the package `"main"` (`dist/index.js`) and the single function Pi invokes when the
 * extension loads. Phase 0 responsibility (PRD §50): wire {@link Config} + {@link Diagnostics} +
 * {@link ProviderDecorator} together, install the **transparent** provider decorator (which delegates
 * every request byte-identically to Pi's built-in — ADR-005, PRD §19.7), and register `session_shutdown`
 * cleanup so the decoration is reversible (EC-012). Interruption logic arrives in later phases.
 *
 * **Never-crash guarantee (PRD Appendix K):** the entire body is a single `try/catch`. Any initialization
 * failure is logged and decoration is skipped — Pi continues with its **unmodified** built-in provider, so
 * an optional extension can never prevent normal provider delegation. This is the runtime enforcement of
 * "invalid config never prevents normal provider delegation".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { createDiagnostics } from "./diagnostics";
import type { Diagnostics } from "./diagnostics";
import { ProviderDecorator } from "./provider/decorator";

/**
 * The lifecycle surface the factory consumes. `ProviderDecorator` satisfies this structurally
 * (`initialize(): void` + `shutdown(): void`), so the default factory needs no adapter.
 */
export interface DecoratorLifecycle {
  /** Capture the built-in provider and register the transparent wrapper (PRD §19.2). */
  initialize(): void;
  /** Unregister the wrapper, restoring the built-in provider (PRD §28, EC-012). */
  shutdown(): void;
}

/**
 * Builds a decorator from `(config, diagnostics)`. Production uses {@link createDefaultDecorator} (the real
 * `ProviderDecorator` against pi-ai's live registry). Tests inject a fake returning a spy so the module-global
 * pi-ai registry is never mutated by the unit suite. This optional second factory parameter is the only
 * dependency-injection seam the entry point exposes; Pi calls the default export with a single argument, so
 * the seam is invisible in production. (Mirrors the decorator's own optional `registry?` DI convention.)
 */
export type DecoratorFactory = (config: Config, diagnostics: Diagnostics) => DecoratorLifecycle;

/** Default decorator factory: constructs the real {@link ProviderDecorator} (real pi-ai registry). */
const createDefaultDecorator: DecoratorFactory = (config, diagnostics) =>
  new ProviderDecorator(config, diagnostics);

/**
 * Pi extension factory. Wires the Phase-0 foundation and registers cleanup.
 *
 * Sequence (inside one never-crash `try/catch`):
 *  1. `loadConfig()` — pure; always returns a valid {@link Config} (falls back to defaults).
 *  2. `createDiagnostics(config.diagnosticsLevel)` — frozen structured logger (PRD §36).
 *  3. `createDecorator(config, diagnostics)` — the transparent decorator (default = real
 *     `ProviderDecorator`; injectable for tests).
 *  4. `decorator.initialize()` — captures Pi's built-in provider and registers the transparent wrapper under
 *     `"stop-thinking-extension"` (PRD §19.2). The ONLY step that can throw in practice (built-in provider
 *     absent); caught below.
 *  5. `pi.on("session_shutdown", () => decorator.shutdown())` — register cleanup (EC-012). Registered ONLY
 *     after `initialize()` succeeds (nothing to clean up if it threw). The handler body is itself guarded so
 *     a shutdown failure cannot propagate into Pi's teardown.
 *
 * On any failure: if `diagnostics` is available, `diagnostics.error("extension.init-failed", { error })`;
 * otherwise `console.error(...)`. The factory **never rethrows** — Pi keeps its built-in provider unmodified,
 * so observational equivalence (ADR-005) holds trivially when decoration is skipped.
 *
 * @param pi              The Pi extension API (events + registrations).
 * @param createDecorator Optional decorator factory for tests (defaults to the real ProviderDecorator).
 */
export default function stopThinkingExtension(
  pi: ExtensionAPI,
  createDecorator: DecoratorFactory = createDefaultDecorator,
): void {
  let diagnostics: Diagnostics | undefined;

  try {
    // (1) Configuration — pure; always valid.
    const config = loadConfig();

    // (2) Structured logger (PRD §36).
    diagnostics = createDiagnostics(config.diagnosticsLevel);

    // (3) Construct the decorator (real registry by default; fake under test).
    const decorator = createDecorator(config, diagnostics);

    // (4) Capture + register the transparent wrapper. May throw (built-in provider absent) — caught below.
    decorator.initialize();

    // (5) Register cleanup AFTER initialize() succeeds (nothing to clean up otherwise). EC-012.
    pi.on("session_shutdown", () => {
      try {
        decorator.shutdown();
      } catch (err) {
        // A cleanup failure must not propagate into Pi's session teardown.
        diagnostics?.error("extension.shutdown-failed", { error: err instanceof Error ? err.message : String(err) });
      }
    });

    diagnostics.info("extension.started", {});
  } catch (err) {
    // NEVER crash Pi: log and skip decoration. The built-in provider stays unmodified (PRD Appendix K).
    const message = err instanceof Error ? err.message : String(err);
    if (diagnostics) {
      diagnostics.error("extension.init-failed", { error: message });
    } else {
      // Defensive fallback: config or diagnostics itself failed before we had a logger.
      console.error(`[pi-stop-thinking] initialization failed: ${message}`);
    }
  }
}
```

```markdown
<!-- README.md — the section to ADD (keep existing Status + Development sections). Insert after the intro
     paragraph, before "## Status". -->

## Installation

Install via Pi (writes to `~/.pi/agent/settings.json` automatically):

```bash
pi install npm:pi-stop-thinking
```

…or add it manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-stop-thinking"]
}
```

Pi will download the package to `~/.pi/agent/npm/` on next startup and load the extension automatically.

## What it does (Phase 0)

This release is the **Phase 0 foundation**: once installed, the extension transparently delegates every
provider request to Pi's built-in provider with **zero observable behavioral change** (ADR-005). The
"stop thinking" interruption for z.ai reasoning models arrives in later phases. Diagnostics default to
silent (`"error"` level only).
```

### Integration Points

```yaml
CONSUMERS (the only consumer is Pi itself):
  Pi extension loader:
      import stopThinkingExtension from "pi-stop-thinking";   // (dist/index.js, the package "main")
      stopThinkingExtension(pi);                              // Pi calls with ONE arg
  This factory is the FINAL wiring step for Phase 0. Later phases (M2/M4/...) will EXTEND this factory body
  (e.g. add pi.registerShortcut + a TransitionCoordinator) but do NOT change the init/shutdown skeleton here.

BUILD:
  - entry: src/index.ts  (package.json "main": "./dist/index.js", "types": "./dist/index.d.ts")
  - emit: dist/index.js + dist/index.d.ts (tsc, rootDir src / outDir dist)
  - resolution: bare "@earendil-works/pi-coding-agent" / "./config" / "./diagnostics" / "./provider/decorator"
    via package "exports" + bundler moduleResolution.

NO CHANGES TO: package.json, tsconfig.json, .gitignore, src/config/*, src/diagnostics/*, src/provider/*,
  src/state/*, src/types.ts (owned by T1/T2/T3/T4/forbidden). Only src/index.ts + README.md are edited.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — intentional, owned by T1):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. Common failures: a missing/default import resolution for "./config",
#   "./diagnostics", "./provider/decorator" → confirm those index.ts/decorator.ts files exist (T2/T3/T4).
#   Or a DecoratorFactory assignability error → confirm ProviderDecorator has initialize()/shutdown().

# Build (emit dist):
npx bun run build            # = tsc
# Expected: dist/index.js and dist/index.d.ts created; exit 0.
ls dist/                     # must show index.js + index.d.ts
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`
> (verified working in this repo). Bare names only resolve inside `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the factory suite alone:
npx bun test tests/factory.test.ts
# Expected: all green (happy path: initialize + shutdown-handler-registered + shutdown-on-event;
#   init-failure: caught, no rethrow, handler NOT registered, diagnostics.error emitted;
#   shutdown-failure isolation: swallowed; createDecorator receives (config, diagnostics)).

# Full suite (factory + decorator + diagnostics + config + smoke):
npx bun test
# Expected: every test passes; nothing regressed.
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect, mock } from "bun:test"`.

### Level 3: Integration (Package Integrity + real wiring)

```bash
# Verify the emitted module is importable as built JS and the factory is the default export:
node -e "import('./dist/index.js').then(m => console.log('default is function:', typeof m.default === 'function', '| seam types present:', 'DecoratorFactory' in m, 'DecoratorLifecycle' in m))"
# Expected: default is function: true | seam types present: true true   (interfaces are type-only but their
#   names appear in the emitted module's type info; the runtime check confirms `default` is a function).

# End-to-end wiring proof against the REAL ProviderDecorator + real global pi-ai registry (this DOES mutate
# the global registry, so it restores afterward — run in an isolated node process, NOT in the unit tests):
node -e "import('@earendil-works/pi-ai').then(async ({ getApiProvider }) => {
  const { default: stopThinkingExtension } = await import('./dist/index.js');
  const origBefore = getApiProvider('openai-completions');
  // Minimal fake ExtensionAPI that captures the session_shutdown handler:
  let shutdownHandler = null;
  const pi = { on(ev, h){ if (ev === 'session_shutdown') shutdownHandler = h; } };
  stopThinkingExtension(pi);                       // real default decorator path
  const afterInit = getApiProvider('openai-completions');
  console.log('registry entry changed after init:', afterInit !== origBefore);  // true
  if (shutdownHandler) shutdownHandler({ type: 'session_shutdown', reason: 'quit' }, {});
  const afterShutdown = getApiProvider('openai-completions');
  console.log('restored after session_shutdown:', afterShutdown === origBefore); // true
});"
# Expected: registry entry changed after init: true | restored after session_shutdown: true
# (This is the end-to-end Phase-0 check: the factory installs the wrapper, and the session_shutdown handler
#  restores the built-in. It exercises the REAL config + diagnostics + ProviderDecorator path.)
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Scope gate — the factory must NOT register a shortcut or touch other event types (Phase 0 = decoration only):
grep -n "registerShortcut\|registerProvider\|registerTool\|message_update\|pi.on(" src/index.ts
# Expected: exactly ONE `pi.on(` match and it is for "session_shutdown". No registerShortcut/registerProvider/etc.

# Never-crash gate — the body is wrapped in try/catch and never rethrows:
grep -n "catch (err)\|throw" src/index.ts
# Expected: at least one `catch (err)` and ZERO unconditional `throw` statements inside the function.

# Ordering gate — session_shutdown is registered AFTER initialize():
grep -n "initialize()\|session_shutdown" src/index.ts
# Expected: the `initialize()` line number is LESS than the `session_shutdown` line number.

# DI-seam gate — the optional second param defaults to the real decorator:
grep -n "createDecorator: DecoratorFactory = createDefaultDecorator\|new ProviderDecorator" src/index.ts
# Expected: both present; createDefaultDecorator builds `new ProviderDecorator(config, diagnostics)`.

# Sync gate — the factory is NOT async:
grep -n "export default function stopThinkingExtension" src/index.ts
# Expected: the signature returns `void` (no `async`, no `Promise`).

# README install gate:
grep -n "npm:pi-stop-thinking" README.md
# Expected: >= 1 match (the packages entry). Also verify the pi install command + settings.json snippet:
grep -n "pi install npm:pi-stop-thinking\|\"packages\"" README.md

# Confirm git sees only the intended changes (no edits to T1–T4-owned files):
git add -A && git status --short
# Expected MODIFIED files only: src/index.ts (modified), README.md (modified), tests/factory.test.ts (new).
#   package.json/tsconfig.json/src/config/src/diagnostics/src/provider/src/state/src/types.ts unchanged.
```

---

## Test Specification (reference suite — implement with `bun:test`)

```typescript
// tests/factory.test.ts

import { describe, test, expect, mock } from "bun:test";
import stopThinkingExtension, {
  type DecoratorFactory,
  type DecoratorLifecycle,
} from "../src/index";
import { createDiagnostics } from "../src/diagnostics";
import type { Diagnostics, DiagnosticsSink } from "../src/diagnostics";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- test doubles ---------------------------------------------------------

/** A fake decorator: spy on initialize/shutdown. opts lets you make either throw. */
function makeFakeDecorator(opts: { initThrows?: boolean; shutdownThrows?: boolean } = {}) {
  const initialize = mock(() => {
    if (opts.initThrows) throw new Error("init boom");
  });
  const shutdown = mock(() => {
    if (opts.shutdownThrows) throw new Error("shutdown boom");
  });
  const decorator: DecoratorLifecycle = { initialize, shutdown };
  return { decorator, initialize, shutdown };
}

/**
 * Build a fake decorator FACTORY that returns `decorator` and records whether it was called.
 * Returned `createDecorator` is the second argument to stopThinkingExtension.
 */
function makeFakeFactory(opts: { initThrows?: boolean; shutdownThrows?: boolean } = {}) {
  const built = makeFakeDecorator(opts);
  let calls = 0;
  let lastArgs: { config: unknown; diagnostics: unknown } | undefined;
  const createDecorator: DecoratorFactory = (config, diagnostics) => {
    calls++;
    lastArgs = { config, diagnostics };
    return built.decorator;
  };
  return { createDecorator, ...built, getCalls: () => calls, lastArgs: () => lastArgs };
}

/** Minimal fake ExtensionAPI: captures the session_shutdown handler; no-ops everything else. */
function makeFakePi() {
  let shutdownHandler: ((e: unknown, ctx: unknown) => void) | null = null;
  const on = mock((event: string, handler: (e: unknown, ctx: unknown) => void) => {
    if (event === "session_shutdown") shutdownHandler = handler;
  });
  const pi = { on } as unknown as ExtensionAPI;
  return {
    pi,
    on,
    get shutdownRegistered() {
      return shutdownHandler !== null;
    },
    fireShutdown() {
      if (shutdownHandler) shutdownHandler({ type: "session_shutdown", reason: "quit" }, {});
    },
  };
}

/** A capturing DiagnosticsSink + the real Diagnostics built from it. */
function makeCapturingDiagnostics(level: "error" | "debug" = "error"): { diagnostics: Diagnostics; sink: DiagnosticsSink } {
  const sink: DiagnosticsSink & { log: string[]; error: string[] } = {
    log: [],
    error: [],
  };
  return { diagnostics: createDiagnostics(level, sink), sink };
}

describe("stopThinkingExtension — happy path", () => {
  test("initializes the decorator and registers a session_shutdown handler", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    const { diagnostics } = makeCapturingDiagnostics();

    expect(() => stopThinkingExtension(pi.pi, (config, diag) => {
      // Prove the factory receives the REAL config + the diagnostics the entry point built.
      expect(config).toBeDefined();
      expect(diag).toBe(diagnostics); // same instance the factory created via createDiagnostics
      return f.createDecorator(config, diag);
    })).not.toThrow();

    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(pi.shutdownRegistered).toBe(true);
  });

  test("firing session_shutdown calls decorator.shutdown() exactly once", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);

    pi.fireShutdown();
    expect(f.shutdown).toHaveBeenCalledTimes(1);

    // A second fire also calls shutdown (the handler is not auto-removed; decorator.shutdown is idempotent):
    pi.fireShutdown();
    expect(f.shutdown).toHaveBeenCalledTimes(2);
  });

  test("createDecorator receives a valid Config and the factory-built Diagnostics", () => {
    const f = makeFakeFactory();
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);

    expect(f.getCalls()).toBe(1);
    expect(f.lastArgs()?.config).toMatchObject({ enabled: true, supportedProviders: ["zai"] });
    expect(f.lastArgs()?.diagnostics).toBeDefined();
  });
});

describe("stopThinkingExtension — init failure isolation (never crash Pi)", () => {
  test("initialize() throwing does NOT rethrow and does NOT register session_shutdown", () => {
    const f = makeFakeFactory({ initThrows: true });
    const pi = makeFakePi();

    expect(() => stopThinkingExtension(pi.pi, f.createDecorator)).not.toThrow();
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(pi.shutdownRegistered).toBe(false); // nothing to clean up
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  test("emits a diagnostics.error line on init failure", () => {
    const f = makeFakeFactory({ initThrows: true });
    const pi = makeFakePi();
    const { diagnostics, sink } = makeCapturingDiagnostics();

    stopThinkingExtension(pi.pi, (config, diag) => {
      // hand the entry point's own diagnostics into the fake so it can observe the error line
      void diag;
      return f.createDecorator(config, diagnostics);
    });

    expect(sink.error.length).toBe(1);
    const line = JSON.parse(sink.error[0]);
    expect(line.event).toBe("extension.init-failed");
    expect(line.level).toBe("error");
    expect(String(line.error)).toContain("init boom");
  });
});

describe("stopThinkingExtension — shutdown failure isolation", () => {
  test("a shutdown() throw inside the handler is swallowed (does not propagate)", () => {
    const f = makeFakeFactory({ shutdownThrows: true });
    const pi = makeFakePi();
    stopThinkingExtension(pi.pi, f.createDecorator);

    expect(() => pi.fireShutdown()).not.toThrow(); // swallowed + logged, not rethrown
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });
});
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/index.js` + `dist/index.d.ts`; default export is the factory.
- [ ] `npx bun test tests/factory.test.ts` → all green.
- [ ] `npx bun test` → all green (decorator + diagnostics + config + smoke still passing).
- [ ] Level 3 node smoke: factory (real default path) installs the wrapper; simulated `session_shutdown`
      handler restores the original pi-ai registry entry (`===`).

### Feature Validation
- [ ] Default export `stopThinkingExtension(pi, createDecorator?)` exists and is a function.
- [ ] Happy path: `initialize()` called once; `session_shutdown` handler registered; firing it calls
      `shutdown()`; `createDecorator` receives `(config, diagnostics)`.
- [ ] Init-failure path: `initialize()` throw is caught → no rethrow → handler NOT registered →
      `diagnostics.error("extension.init-failed", { error })` emitted.
- [ ] Shutdown-failure isolation: a `shutdown()` throw inside the handler does not propagate.
- [ ] Factory is **sync** (`void`); no `async`/`Promise`/unconditional `throw` in the body.
- [ ] README documents installation (`npm:pi-stop-thinking` in `packages`; `pi install npm:pi-stop-thinking`).

### Code Quality Validation
- [ ] `DecoratorLifecycle` is structurally satisfied by `ProviderDecorator` (no adapter).
- [ ] The optional `createDecorator` seam defaults to the real `ProviderDecorator` (real pi-ai registry);
      Pi calls the factory with one arg so the seam is invisible in production.
- [ ] Diagnostics receive only `{ error }` / `{}` fields (Appendix H privacy: no config/options/context).
- [ ] No global-registry mutation in unit tests (the injected fake decorator never touches pi-ai).
- [ ] Mirrors sibling-module conventions (Mode A JSDoc, DI-by-optional-param, flat tests/ dir, npx-bun).
- [ ] Only `src/index.ts` + `README.md` edited; no edits to `package.json`/`tsconfig.json`/`.gitignore`/
      `src/config`/`src/diagnostics`/`src/provider`/`src/state`/`src/types.ts`.

### Documentation & Deployment
- [ ] Module banner documents Phase-0 responsibility + the never-crash guarantee.
- [ ] Factory JSDoc documents the 5-step sequence, the EC-012 cleanup rationale, and the `createDecorator` seam.
- [ ] README "Installation" + "What it does (Phase 0)" sections added; existing sections preserved.
- [ ] `dist/index.d.ts` carries the JSDoc for the loaded entry point.

---

## Anti-Patterns to Avoid

- ❌ Don't let any initialization error escape the factory — the whole body is ONE `try/catch` and never
  rethrows. A thrown error would crash Pi's extension load and brick the agent (PRD Appendix K violation).
- ❌ Don't register `pi.on("session_shutdown", …)` BEFORE `decorator.initialize()`. If initialize() throws
  you'd leave a handler pointing at a decorator that was never initialized (harmless but wrong; clean = skip
  registration on failure). Register after, inside the try.
- ❌ Don't leave the `session_shutdown` handler unguarded — wrap its body in try/catch so a `shutdown()`
  failure can't propagate into Pi's teardown.
- ❌ Don't make the factory `async`. Every step is synchronous; `async` adds a rejected-promise path Pi must
  await and buys nothing. Return `void`.
- ❌ Don't inject `loadConfig` / `createDiagnostics` — they're pure/side-effect-free and safe to call for real
  in tests. Only the decorator mutates global state, so only IT gets a seam (the `createDecorator` param).
- ❌ Don't add an adapter layer around `ProviderDecorator` — it already satisfies `DecoratorLifecycle`
  (`initialize(): void` + `shutdown(): void`) structurally.
- ❌ Don't register shortcuts, providers, tools, or other event handlers here — Phase 0 is decoration-only.
  Shortcut wiring is P1.M4.T3/T4; StreamProxy activation is P1.M2.T3.S1.
- ❌ Don't log config, options, context, messages, or any prompt/output text (Appendix H). Only `{ error }` /
  `{}` fields reach diagnostics from the factory.
- ❌ Don't mutate the global pi-ai registry in unit tests — inject a fake decorator via the `createDecorator`
  seam. Real-registry assertions live in the isolated Level 3 node smoke, never in `bun:test`.
- ❌ Don't modify `package.json`, `tsconfig.json`, `.gitignore`, `src/config/*`, `src/diagnostics/*`,
  `src/provider/*`, `src/state/*`, `src/types.ts`, or the existing README "Status"/"Development" sections.

---

## Confidence Score: **9/10**

This is a small, well-bounded entry-point module whose entire behavior is "wire three already-built modules,
register one cleanup hook, and never throw." The trickiest aspect — testability without mutating pi-ai's
module-global registry — is solved by a `createDecorator` DI seam that mirrors the repo's established
convention (T4's optional `registry?` param) and is invisible to Pi (one-arg call). The exact
`ExtensionFactory` / `on("session_shutdown", …)` signatures are verified against the installed
`pi-coding-agent@0.80.3` types, and the `ExtensionHandler` shape (`(event, ctx) => …`) is matched by the
fake-`pi` harness. The complete reference implementation (with the never-crash try/catch, the
post-initialize handler registration, and the guarded shutdown body), the full fake-factory + fake-`pi` +
capturing-sink test suite, the README diff, the real-wiring Level 3 node smoke, and all scope gates are
inlined and verified against the live repo conventions (`npx bun` invocation, flat tests/ dir, Mode-A JSDoc).
Residual risk is minimal: (a) the `DecoratorLifecycle` structural-satisfaction assumption is type-checked by
`npx bun run typecheck` (ProviderDecorator's initialize/shutdown are `void` per the T4 contract); (b) the
"init failure skips decoration" guarantee is asserted directly (no rethrow + handler-not-registered +
diagnostics.error). No behavioral coupling to unbuilt modules: later phases EXTEND this factory body (add
shortcut/coordinator) without changing the init/shutdown skeleton established here.
