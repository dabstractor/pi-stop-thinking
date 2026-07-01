# PRP — P1.M1.T4.S1: Provider Capture and Wrapper Registration

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer)
> **Subtask**: P1.M1.T4.S1 (Phase 0 Foundation, 2 pts) — ProviderDecorator: capture Pi's built-in
> provider and register a **transparent, observationally-equivalent** wrapper around it.
> **Builds on**: P1.M1.T1.S1 (scaffold) + **P1.M1.T2.S1 (Configuration)** + **P1.M1.T3.S1 (Diagnostics)**.
> Assumes `src/config/index.ts` exports `Config` (with `enabled: boolean`, `supportedProviders: string[]`)
> and `src/diagnostics/index.ts` exports the `Diagnostics` interface exactly as those PRPs specify.
> **This subtask replaces the `src/provider/decorator.ts` stub (a one-line comment) with the real module.**
>
> **Parallel context**: P1.M1.T3.S1 (Diagnostics) is being implemented in parallel. Its PRP is treated as
> a CONTRACT — `createDiagnostics(level, sink?)` returns a frozen `Diagnostics` with
> `trace/debug/info/warn/error(event: string, fields?: Record<string, unknown>): void` and a privacy
> allow/deny list. This PRP consumes that interface (type-only import).

---

## Goal

**Feature Goal**: Implement a `ProviderDecorator` that captures Pi's built-in `openai-completions`
provider **before** overwriting it in pi-ai's registry, then registers a wrapper under sourceId
`"stop-thinking-extension"` whose `stream`/`streamSimple` are **purely transparent**: every request —
z.ai or not, reasoning or not — is delegated byte-identically to the captured built-in. The wrapper
evaluates the Phase-0 activation conditions (PRD §19.5/§19.6) and logs eligibility, but in this phase
ALL paths delegate (the StreamProxy that would intercept is built in M2 / P1.M2.T3.S1). This is the
"observational-equivalence milestone" of Phase 0 (PRD §19.7, ADR-005): zero visible behavior change.

**Deliverable**:
- `src/provider/decorator.ts` exporting: the `ProviderDecorator` class (with `initialize(): void` and
  `shutdown(): void`), the `ProviderRegistry` interface (for dependency-injected test doubles), and the
  `STOP_THINKING_SOURCE_ID` / `OPENAI_COMPLETIONS_API` constants.
- Full **JSDoc (Mode A)** on the class, `initialize` (documenting the **capture-before-register**
  ordering requirement + the `"stop-thinking-extension"` sourceId), `shutdown`, the `ProviderRegistry`
  interface, and the constructor.
- `tests/provider-decorator.test.ts` — comprehensive Bun unit tests using an **injected fake registry**
  (no global mutation): capture+register, capture-before-register ordering, idempotency, not-found throw,
  transparent delegation (same args + same returned stream reference) across all activation branches,
  no-self-recursion, shutdown unregister + reset, and re-initialize after shutdown.

**Success Definition**: From a clean checkout (after T1 scaffold + T2 config + T3 diagnostics land),
`npx bun run typecheck && npx bun run build && npx bun test` all exit 0; `dist/provider/decorator.js` +
`dist/provider/decorator.d.ts` are emitted; every test in `tests/provider-decorator.test.ts` passes;
after `initialize()`, a call through the registered wrapper returns **exactly** what the captured
provider returns (`===`) with **identical forwarded arguments** (proving pass-through); `shutdown()`
calls `unregisterApiProviders("stop-thinking-extension")`; `src/index.ts` (factory) is **untouched**
(wiring is P1.M1.T5.S1).

---

## Why

- **The seam for the entire feature.** Per ADR-003 (Decorate the Built-in Provider) and the module
  dependency graph (`architecture/module_contracts.md`), `ProviderDecorator` is the only place the
  extension touches Pi's provider resolution. Every later phase (M2 StreamProxy, M3 FSM, … ) plugs into
  the wrapper this subtask installs. Getting the capture/registration lifecycle right now is
  non-negotiable; getting it wrong (e.g. registering before capturing) causes infinite recursion the
  moment M2 adds real interception.
- **Phase 0 mandate: observational equivalence (PRD §19.7, ADR-005).** The wrapper MUST be
  observationally equivalent to Pi's built-in — preserve ordering, metadata, timing, completion
  semantics, usage, errors, cancellation, and stream identity. By shipping a wrapper that always
  delegates transparently now, we prove the decoration seam is safe before adding any logic.
- **Reversibility (PRD §28 Invariants + EC-012).** Decoration must be reversible. Registering under a
  fixed `sourceId` lets `shutdown()` / `session_shutdown` cleanly restore the built-in via
  `unregisterApiProviders(sourceId)`, which only removes our entry (the builtin was registered with no
  sourceId and is untouched).

## What

A TypeScript module in `src/provider/decorator.ts` that value-imports pi-ai's registry functions and
type-imports the config/diagnostics sibling contracts:

1. `ProviderDecorator` class — `constructor(config: Config, diagnostics: Diagnostics, registry?: ProviderRegistry)`.
   The optional `registry` defaults to the real pi-ai functions (dependency injection lets tests pass
   capturing doubles without touching the global registry).
2. `initialize(): void` — **(a)** capture `getApiProvider("openai-completions")`; throw if missing.
   **(b)** close over `original.stream` / `original.streamSimple`. **(c)** build `wrapperStream` (always
   delegates) and `wrapperStreamSimple` (evaluates activation conditions per §19.5/§19.6, then ALSO
   delegates in this phase). **(d)** `registerApiProvider({ api, stream: wrapperStream, streamSimple:
   wrapperStreamSimple }, "stop-thinking-extension")`. Idempotent (Invariant: registration occurs exactly once).
3. `shutdown(): void` — `unregisterApiProviders("stop-thinking-extension")`, clear the captured
   reference, reset registration state. Idempotent.
4. `ProviderRegistry` interface — the three pi-ai functions, typed via `typeof`, for DI.
5. JSDoc (Mode A) throughout; the `initialize` JSDoc prominently documents the capture-before-register
   ordering requirement and the sourceId.
6. `tests/provider-decorator.test.ts` covering all of the above.

**Out of scope** (owned by other subtasks — do NOT implement here):
- Constructing/invoking a `StreamProxy` when activation conditions are met → **P1.M2.T3.S1**. In this
  subtask the "eligible" branch ALSO delegates transparently (with a debug log).
- Wiring `new ProviderDecorator(...)` / `.initialize()` / `.shutdown()` into `src/index.ts` and the
  `session_shutdown` handler → **P1.M1.T5.S1**. The factory stub stays empty.
- Reasoning detection, buffering, abort, replacement requests, splicing → Phase 2–6.
- Condition E ("not already servicing another interruption") → **P1.M4.T4.S1** (TransitionCoordinator).
  In this phase there is no interruption, so E is trivially satisfied; do not model it.

### Success Criteria

- [ ] `src/provider/decorator.ts` exports `ProviderDecorator`, `ProviderRegistry`, `STOP_THINKING_SOURCE_ID`,
      `OPENAI_COMPLETIONS_API` (nothing else required; keep minimal).
- [ ] `npx bun run typecheck` reports **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/provider/decorator.js` + `dist/provider/decorator.d.ts`.
- [ ] `npx bun test` passes (decorator tests green; existing smoke/config/diagnostics tests still green).
- [ ] After `initialize()`, `wrapper.streamSimple(m, c, o)` returns the **same** object (`===`) as
      `original.streamSimple(m, c, o)` and the captured function was called with **exactly** `(m, c, o)`,
      for EVERY activation branch (z.ai+reasoning+enabled, non-z.ai, non-reasoning, disabled).
- [ ] `getApiProvider("openai-completions")` is invoked **before** `registerApiProvider(...)` (ordering
      verified by recorded call order).
- [ ] `initialize()` is idempotent (second call registers nothing new); `initialize()` throws when the
      provider is absent and leaves state unchanged.
- [ ] `shutdown()` calls `unregisterApiProviders("stop-thinking-extension")` exactly once; a second
      `shutdown()` is a no-op; `initialize()` works again after `shutdown()`.
- [ ] No global-registry mutation during tests (DI of a fake registry; the real pi-ai registry is never
      written by the test path).
- [ ] `src/index.ts` is **untouched** (no `new ProviderDecorator` / `.initialize()` added).

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the exact pi-ai registry semantics (verified against installed v0.74.2), the
exact TypeScript signatures (type-check-proven in a throwaway scratch file — see research note), the
complete reference implementation, the full test suite with the fake-registry harness, and the exact
build/test commands. The only external assumptions — that T2's `Config` and T3's `Diagnostics` exist with
the stated shapes — are stated with exact import paths and field names.

### Documentation & References

```yaml
# MUST READ — authoritative contracts for THIS module
- file: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "The 'ProviderDecorator' block defines the public interface (initialize/shutdown), private state
        (Captured Provider Reference, Registration State, Supported Provider Cache, Configuration
        Reference), and the Invariants (captured provider immutable; registration exactly once;
        decoration reversible; wrapper never delegates to itself). Also lists the wrapped-streamSimple
        decision tree (§19.5)."
  critical: "Invariants are testable acceptance criteria: 'Wrapper never delegates to itself' = capture
        before register; 'Registration occurs exactly once' = idempotent initialize; 'Decoration is
        reversible' = shutdown unregisters via sourceId."

- file: plan/001_b0c6691bb424/architecture/system_context.md
  why: "'Provider Decoration Architecture (CRITICAL)' section gives the capture-and-replace pattern with
        code, the streamSimple call path, and the CRITICAL ORDERING note."
  critical: "Capture MUST happen before registration or the wrapper captures itself → infinite recursion
        (PRD §19.2). sourceId = 'stop-thinking-extension'. Cleanup via unregisterApiProviders(sourceId)."

- file: plan/001_b0c6691bb424/P1M1T4S1/research/api-registry-internals.md
  why: "VERIFIED pi-ai internals: registerApiProvider WRAPS each fn with an api-guard (so our wrapper is
        only ever called for model.api==='openai-completions'); getApiProvider returns the ALREADY-WRAPPED
        provider; ApiProviderInternal is NOT exported (use NonNullable<ReturnType<typeof getApiProvider>>);
        type-check proof that both wrapper-typing variants compile."
  critical: "Do NOT re-implement the api-guard in the wrapper (registerApiProvider already does it — it
        would be dead code). Captured original.stream* are themselves wrapped; delegating through them is
        byte-identical and never recurses (captured before overwrite)."

# PRD authority (PRD.md in repo root)
- url: PRD.md §19.2 "Initialization Sequence"
  why: "Mandatory sequence: Capture → Validate Exists → Register Wrapper. 'The provider must be captured
        before registration. Failure to do so will result in the wrapper capturing itself, producing
        infinite recursion. This ordering requirement is absolute.'"
  critical: "This sentence is the #1 acceptance gate and MUST appear in the initialize() JSDoc (Mode A)."

- url: PRD.md §19.5 "Wrapper Decision Tree" + §19.6 "Activation Conditions" (Conditions A–E)
  why: "Defines WHEN interception would activate: A=provider is z.ai (in supportedProviders), B=OpenAI-
        compatible api, C=model.reasoning, D=feature enabled, E=not already interrupting."
  critical: "In THIS subtask Conditions A–D are EVALUATED (for logging) but the outcome is ALWAYS delegate
        (StreamProxy lands in M2). Condition B is guaranteed by the registry's api-guard (do not check).
        Condition E is trivially true in Phase 0 (no interruption exists)."

- url: PRD.md §19.7 "Pass-through Guarantee" + ADR-005 "The Wrapper Must Be Observationally Equivalent"
  why: "When inactive the wrapper must behave identically to Pi's implementation: preserve ordering,
        metadata, event timing, completion semantics, usage, errors, cancellation, stream identity.
        'No observable behavior shall change.'"
  critical: "Pass-through = forward the EXACT (model, context, options) triple and return the EXACT stream
        object the captured provider returns. No cloning, no re-wrapping, no copy. Test asserts ===."

- url: PRD.md §28 "ProviderDecorator Module" (Public Interface / Private State / Invariants)
  why: "Re-states the module contract: Initialize/Shutdown/Decorate/Restore/Delegate + invariants."

# INPUT contracts (implemented in parallel / already shipped — consume, do not modify)
- file: src/config/index.ts   # (P1.M1.T2.S1)
  why: "Source of the Config type. The decorator reads config.enabled (Condition D) and
        config.supportedProviders (Condition A). DEFAULT_CONFIG: enabled=true, supportedProviders=['zai']."
  pattern: "import type { Config } from '../config';   // type-only keeps the contract decoupled"
  gotcha: "config.supportedProviders is string[]; model.provider is a Provider (=string). Compare with
           config.supportedProviders.includes(String(model.provider)). Do NOT mutate config."

- file: src/diagnostics/index.ts   # (P1.M1.T3.S1, parallel)
  why: "Source of the Diagnostics interface (5 methods; frozen instance passed by reference). The
        decorator logs delegation/eligibility decisions at debug and lifecycle at info."
  pattern: "import type { Diagnostics } from '../diagnostics';"
  gotcha: "PRIVACY (Appendix H): fields may include provider/model/api — NEVER log options, context,
           messages, reasoning, or any prompt/output text. The decorator only ever passes allow-listed
           scalar metadata (api, provider, model id) as fields."

# REFERENCE — established repo conventions to mirror (set the quality bar)
- file: plan/001_b0c6691bb424/P1M1T3S1/PRP.md
  why: "The immediately-preceding sibling PRP (Diagnostics). Mirror its structure, gotcha density,
        Mode-A JSDoc expectation, fake/dependency-injection test style, npx-bun invocation, and
        validation-command style."
- file: tests/config.test.ts   # (P1.M1.T2.S1)
  why: "The proven Bun test style in THIS repo: import { describe, test, expect } from 'bun:test';
        flat tests/ dir; ../src/* imports."
```

### Current Codebase tree (after T1 scaffold + T2 config + T3 diagnostics land)

```bash
.
├── package.json          # T1: scripts build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); bun devDep
├── tsconfig.json         # T1: ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         #     include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── README.md             # T1 (skeleton)
├── src/
│   ├── index.ts          # T1/T5: factory STUB (empty body) — DO NOT modify here
│   ├── types.ts          # T1: placeholder — DO NOT modify here
│   ├── provider/
│   │   ├── decorator.ts  # ← T1 STUB (one-line comment) — THIS becomes the real module
│   │   └── proxy.ts      # T1 stub — DO NOT modify (owned by P1.M2.T2.S1)
│   ├── state/{controller,coordinator}.ts   # T1 stubs — DO NOT modify
│   ├── config/index.ts   # T2: Config/DEFAULT_CONFIG/loadConfig/validateConfig (DONE)
│   ├── diagnostics/index.ts # T3: createDiagnostics/Diagnostics/DiagnosticsSink (DONE/parallel)
│   ├── buffer/.gitkeep   # later
│   ├── shortcut/.gitkeep # later
│   └── request/.gitkeep  # later
├── tests/
│   ├── smoke.test.ts     # T1 (must stay green)
│   ├── config.test.ts    # T2 (must stay green)
│   └── diagnostics.test.ts # T3 (must stay green)
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── package.json          # UNCHANGED (owned by T1) — reuse existing test/build/typecheck scripts
├── tsconfig.json         # UNCHANGED (owned by T1)
├── src/
│   ├── provider/
│   │   └── decorator.ts  # REAL (replaces stub) — ProviderDecorator class + ProviderRegistry + consts
│   └── ...               # all other files UNCHANGED (incl. src/index.ts, src/config, src/diagnostics, proxy.ts)
├── tests/
│   ├── smoke.test.ts     # UNCHANGED
│   ├── config.test.ts    # UNCHANGED
│   ├── diagnostics.test.ts # UNCHANGED
│   └── provider-decorator.test.ts  # NEW — Bun unit tests (fake-registry DI)
└── dist/provider/{decorator.js,decorator.d.ts}  # GENERATED by `npx bun run build`
```
**File responsibilities**: `src/provider/decorator.ts` = sole runtime surface — capture + transparent
wrapper registration + lifecycle. `tests/provider-decorator.test.ts` = exhaustive lifecycle + pass-through
coverage via an injected fake registry. No other file is touched (NOT `src/index.ts`, NOT `proxy.ts`).

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (ordering — infinite recursion): getApiProvider MUST be called BEFORE registerApiProvider.
// registerApiProvider overwrites the registry entry; if you capture AFTER registering, the wrapper
// captures itself → stack overflow the moment it delegates. This is PRD §19.2's "absolute" rule and the
// top acceptance gate. Enforce + test the call ORDER (record an ordered trace; assert get precedes register).

// CRITICAL (capture returns ALREADY-WRAPPED functions): getApiProvider("openai-completions").streamSimple
// is wrapStreamSimple("openai-completions", <builtin>) — i.e. the registry wrapped it on registration.
// So delegating through original.streamSimple re-runs the api-guard (harmless, model.api is guaranteed
// "openai-completions") then calls the real builtin. It is byte-identical AND never recurses, because the
// captured closure predates our overwrite. (See research/api-registry-internals.md.)

// CRITICAL (do NOT re-implement the api-guard): registerApiProvider WRAPS our stream/streamSimple with an
// api==="'openai-completions" guard (api-registry.js wrapStreamSimple). Our wrapper is therefore only ever
// invoked for model.api==="openai-completions" — Condition B (PRD §19.6) is guaranteed by the registry,
// not by us. Adding our own throw would be dead code. The contract line "wrapper must be wrapped to match
// the api check" is satisfied automatically by passing through registerApiProvider.

// CRITICAL (both stream AND streamSimple required): ApiProvider requires both fields; registerApiProvider
// will not accept an object with only streamSimple. Wrap BOTH. Interception is streamSimple-only (the
// agent loop uses streamSimple per system_context.md); `stream` delegates unconditionally and stays that
// way (even after M2). This keeps the registered shape valid without widening scope.

// GOTCHA (ApiProviderInternal is NOT exported): getApiProvider returns ApiProviderInternal | undefined but
// that interface is not in the public types. Type the captured reference as:
//   type CapturedProvider = NonNullable<ReturnType<typeof getApiProvider>>;
// (verified to compile under --strict in the research note.)

// GOTCHA (Provider comparison): model.provider is typed Provider = KnownProvider | string; config.
// supportedProviders is string[]. Compare with config.supportedProviders.includes(String(model.provider)).
// Do NOT use `model.provider === config.supportedProviders` (array) or `model.provider in <array>`.

// GOTCHA (pass-through = identity, not copy): "observational equivalence" (PRD §19.7) means forward the
// exact (model, context, options) triple and RETURN the exact stream object the captured provider returns.
// No cloning of options, no copying of context, no re-emission. Test asserts wrapper(...) === original(...)
// (same reference) and that original was called with the identical argument triple.

// GOTCHA (tests must not mutate the GLOBAL registry): pi-ai's apiProviderRegistry is module-global and
// importing the decorator value-imports pi-ai (which eagerly registers builtins via register-builtins.js).
// Do NOT call the real registerApiProvider/unregisterApiProviders in tests. INJECT a fake ProviderRegistry
// via the constructor (DI). The real pi-ai functions remain the production default.

// GOTCHA (frozen Diagnostics instance): the Diagnostics object is Object.isFrozen (T3 contract); methods
// are stable references. Do not try to reassign them. Only call .debug/.info with allow-listed fields.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → `npx bun run typecheck` checks src ONLY.
// tests/provider-decorator.test.ts is validated by `npx bun test` (Bun runs TS natively). Do not add tests
// to the build include (owned by T1).

// GOTCHA (bun is a local devDep, NOT on PATH): invoke as `npx bun ...` / `npx bunx tsc ...`, NOT bare
// `bun`/`bunx` (those fail with "command not found" outside an npm-script context). The package.json
// scripts resolve via `npx bun run <script>`.

// GOTCHA (placement): provider/ is a MULTI-file dir (decorator.ts + proxy.ts stubs). Put the module in
// src/provider/decorator.ts (replacing the stub), NOT a new src/provider/index.ts. Import from tests via
// "../src/provider/decorator". This matches the T1 scaffold intent (stub comment: "ProviderDecorator — P1.M1.T4.S1").

// GOTCHA (value import of pi-ai is expected here, unlike config/diagnostics): config & diagnostics are
// pure (no Pi imports). The decorator is the FIRST module to value-import @earendil-works/pi-ai — that is
// correct and required (it calls the registry at runtime). Type-import Config/Diagnostics from siblings.
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// src/provider/decorator.ts — public type surface

import type {
  ApiStreamFunction,
  ApiStreamSimpleFunction,
  // Model, Context, SimpleStreamOptions, StreamOptions, AssistantMessageEventStream are referenced
  // transitively through ApiStream*Function; import them only if referenced directly.
} from "@earendil-works/pi-ai";

/** The api type we decorate (z.ai models use "openai-completions"). */
export const OPENAI_COMPLETIONS_API = "openai-completions" as const;

/** sourceId under which our wrapper is registered (enables clean unregister on shutdown). */
export const STOP_THINKING_SOURCE_ID = "stop-thinking-extension" as const;

/**
 * The three pi-ai registry functions the decorator depends on, as an injectable bundle. Production
 * defaults to the real functions from "@earendil-works/pi-ai"; tests inject capturing doubles to avoid
 * mutating the module-global registry.
 */
export interface ProviderRegistry {
  getApiProvider: typeof getApiProvider;
  registerApiProvider: typeof registerApiProvider;
  unregisterApiProviders: typeof unregisterApiProviders;
}

/** The captured built-in provider (ApiProviderInternal is not exported → infer its type). */
type CapturedProvider = NonNullable<ReturnType<typeof getApiProvider>>;

export class ProviderDecorator {
  constructor(
    config: Config,
    diagnostics: Diagnostics,
    registry?: ProviderRegistry,
  );
  initialize(): void;
  shutdown(): void;
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REPLACE src/provider/decorator.ts (stub → real module)
  - OVERWRITE the one-line stub with the reference implementation in "Implementation Patterns" below.
  - IMPORT (value): { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai"
  - IMPORT (type): { ApiStreamFunction, ApiStreamSimpleFunction } from "@earendil-works/pi-ai"
  - IMPORT (type-only, siblings): import type { Config } from "../config"; import type { Diagnostics } from "../diagnostics";
  - IMPLEMENT: OPENAI_COMPLETIONS_API + STOP_THINKING_SOURCE_ID consts; ProviderRegistry interface;
    ProviderDecorator class with constructor(config, diagnostics, registry?) + initialize() + shutdown().
  - NAMING: PascalCase class (ProviderDecorator) + interface (ProviderRegistry); UPPER_SNAKE consts;
    camelCase methods (initialize, shutdown).
  - JSDOC (Mode A): module banner (responsibility + "transparent in Phase 0"); class (lifecycle + sourceId);
    initialize() MUST document the capture-before-register ordering requirement (quote PRD §19.2) and the
    "stop-thinking-extension" sourceId; shutdown(); ProviderRegistry (DI rationale); constructor params.
  - PLACEMENT: src/provider/decorator.ts.
  - GOTCHA: registry defaults to the real pi-ai fns; initialize is idempotent; capture before register;
    both stream+streamSimple wrapped; no api-guard re-implementation; privacy-safe diagnostics fields only.

Task 2: CREATE tests/provider-decorator.test.ts
  - IMPLEMENT: the suite specified in "Test Specification" below using `bun:test`.
  - IMPORT: `import { ProviderDecorator, ProviderRegistry, STOP_THINKING_SOURCE_ID, OPENAI_COMPLETIONS_API } from "../src/provider/decorator";`
    `import type { Config } from "../src/config";`
    `import type { Diagnostics } from "../src/diagnostics";`
    plus the pi-ai TYPE imports used to type the fake provider/stream (ApiStreamSimpleFunction, etc.).
  - FOLLOW pattern: tests/config.test.ts / tests/diagnostics.test.ts (Bun describe/test/expect; flat tests/ dir).
  - HARNESS: a `makeFakeRegistry()` helper that returns a capturing double + an ordered `calls` trace +
    a sentinel stream; tests construct `new ProviderDecorator(config, diagnostics, fakeRegistry)`.
  - DIAGNOSTICS double: a no-op Diagnostics stub (the decorator only calls .debug/.info; capture optional).
  - NAMING: describe("ProviderDecorator — initialize" / "wrapper delegation" / "shutdown" / "lifecycle").
  - COVERAGE: capture+register with correct api+sourceId; capture-before-register ORDER; idempotent
    initialize; not-found throws + leaves state clean; transparent delegation for ALL 4 activation
    branches (same args + === return); no-self-recursion (delegation hits the captured builtin, not the
    registry); stream path delegates unconditionally; shutdown unregisters once + idempotent + resets
    (re-initialize works).
  - PLACEMENT: tests/provider-decorator.test.ts (flat tests/ dir; excluded from build).

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics.
  - RUN: npx bun run build      → dist/provider/decorator.js + dist/provider/decorator.d.ts created.
  - RUN: npx bun test           → all green (decorator + diagnostics + config + smoke).
  - RUN: Level 4 gates (scope, placement, no-global-mutation, factory-untouched) below.
```

### Implementation Patterns & Key Details

```typescript
// src/provider/decorator.ts — COMPLETE reference implementation. Author this verbatim (JSDoc included).

/**
 * # ProviderDecorator — capture Pi's built-in provider and register a transparent wrapper.
 *
 * This module is the single place the Stop Thinking & Do extension touches Pi's provider resolution
 * (ADR-003: Decorate the Built-in Provider). It captures the built-in `openai-completions` provider and
 * registers a wrapper under sourceId {@link STOP_THINKING_SOURCE_ID}.
 *
 * **Phase 0 scope (this subtask):** the wrapper is purely transparent. It evaluates the activation
 * conditions (PRD §19.5 / §19.6) and logs eligibility, but EVERY request — z.ai or not, reasoning or not
 * — is delegated byte-identically to the captured built-in (PRD §19.7 Pass-through Guarantee, ADR-005).
 * The StreamProxy that would actually intercept eligible z.ai reasoning streams is built in P1.M2.T3.S1.
 *
 * The decoration is reversible: {@link ProviderDecorator.shutdown} unregisters via the sourceId,
 * restoring the built-in (PRD §28 Invariants; EC-012).
 */

import {
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai";
import type {
  ApiStreamFunction,
  ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai";
import type { Config } from "../config";
import type { Diagnostics } from "../diagnostics";

/** The OpenAI-compatible api type that z.ai models use (PRD §19.6 Condition B). */
export const OPENAI_COMPLETIONS_API = "openai-completions" as const;

/** sourceId under which the wrapper is registered; enables clean unregister on shutdown (PRD §28). */
export const STOP_THINKING_SOURCE_ID = "stop-thinking-extension" as const;

/**
 * The three pi-ai registry functions the decorator depends on, bundled for dependency injection.
 *
 * Production passes no argument (the constructor defaults to the real functions from
 * `@earendil-works/pi-ai`). Tests inject capturing doubles so they never mutate pi-ai's module-global
 * `apiProviderRegistry` (importing the decorator value-imports pi-ai, which eagerly registers builtins).
 */
export interface ProviderRegistry {
  /** @see getApiProvider */
  getApiProvider: typeof getApiProvider;
  /** @see registerApiProvider */
  registerApiProvider: typeof registerApiProvider;
  /** @see unregisterApiProviders */
  unregisterApiProviders: typeof unregisterApiProviders;
}

/** The real pi-ai registry, used as the production default for {@link ProviderRegistry}. */
const DEFAULT_REGISTRY: ProviderRegistry = {
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
};

/** The captured built-in provider (`ApiProviderInternal` is not exported → infer it). */
type CapturedProvider = NonNullable<ReturnType<typeof getApiProvider>>;

/**
 * Owns capture of Pi's built-in provider, registration of the transparent wrapper, and the reversible
 * lifecycle (PRD §13.1, §28).
 *
 * Invariants (PRD §28): the captured provider is immutable for the decorator's lifetime; registration
 * occurs exactly once; decoration is reversible; **the wrapper never delegates to itself** (enforced by
 * capturing BEFORE registering — see {@link initialize}).
 */
export class ProviderDecorator {
  private readonly config: Config;
  private readonly diagnostics: Diagnostics;
  private readonly registry: ProviderRegistry;
  private original: CapturedProvider | undefined;
  private registered = false;

  /**
   * @param config      Configuration (reads `enabled` = Condition D, `supportedProviders` = Condition A).
   * @param diagnostics Structured logger (frozen instance, passed by reference per the Diagnostics contract).
   * @param registry    Optional pi-ai registry bundle for DI. Defaults to the real functions; tests pass
   *                    capturing doubles. **Privacy (Appendix H):** only `provider`/`model`/`api` metadata
   *                    are ever passed to diagnostics — never options, context, or stream content.
   */
  constructor(config: Config, diagnostics: Diagnostics, registry: ProviderRegistry = DEFAULT_REGISTRY) {
    this.config = config;
    this.diagnostics = diagnostics;
    this.registry = registry;
  }

  /**
   * Capture the built-in `openai-completions` provider and register the transparent wrapper under
   * sourceId `"stop-thinking-extension"`.
   *
   * **CRITICAL ORDERING (PRD §19.2 — absolute):** the built-in provider **MUST be captured BEFORE the
   * wrapper is registered**. `registerApiProvider` overwrites the registry entry for this api; if capture
   * happened afterward, the wrapper would capture itself and every delegation would recurse infinitely.
   * Capturing first means the wrapper's delegated reference points at the real built-in (captured before
   * the overwrite), so delegation is byte-identical and never recursive (PRD §28: "Wrapper never
   * delegates to itself").
   *
   * The wrapper is registered with sourceId `"stop-thinking-extension"` so {@link shutdown} can remove
   * exactly this entry via `unregisterApiProviders("stop-thinking-extension")`, restoring the built-in.
   *
   * Idempotent: a second call when already registered is a no-op (PRD §28: "Registration occurs exactly
   * once"). Throws if the built-in provider is not present (leaves state unchanged).
   */
  initialize(): void {
    if (this.registered) return;

    // STEP 1 — Capture BEFORE registering (PRD §19.2 absolute ordering; prevents infinite recursion).
    const original = this.registry.getApiProvider(OPENAI_COMPLETIONS_API);
    if (!original) {
      this.diagnostics.error("provider.decorator.capture-missing", { api: OPENAI_COMPLETIONS_API });
      throw new Error(
        `ProviderDecorator.initialize: built-in provider not found for api "${OPENAI_COMPLETIONS_API}"`,
      );
    }
    this.original = original;

    // The captured stream/streamSimple are pi-ai's already-wrapped builtins (api-guarded). Delegating
    // through them is byte-identical and never recurses into our wrapper.
    const originalStream: ApiStreamFunction = original.stream;
    const originalStreamSimple: ApiStreamSimpleFunction = original.streamSimple;

    // STEP 2 — Build the wrappers. registerApiProvider will api-guard these (wrapStreamSimple), so our
    // functions are only ever invoked for model.api === "openai-completions" — we do NOT re-check api.
    const wrapperStream: ApiStreamFunction = (model, context, options) => {
      // The `stream` path is unconditionally transparent (interception is streamSimple-only; M2).
      this.diagnostics.debug("provider.stream.delegate", {
        api: model.api,
        provider: String(model.provider),
        model: model.id,
      });
      return originalStream(model, context, options);
    };

    const wrapperStreamSimple: ApiStreamSimpleFunction = (model, context, options) => {
      // Activation conditions per PRD §19.5 / §19.6 (B is guaranteed by the registry's api-guard):
      //   A: provider in config.supportedProviders
      //   C: model.reasoning
      //   D: config.enabled
      //   (E: not already interrupting — trivially true in Phase 0; modeled in P1.M4.T4.S1.)
      const eligible =
        this.config.enabled &&
        model.reasoning &&
        this.config.supportedProviders.includes(String(model.provider));

      if (eligible) {
        // Phase 0: even eligible requests delegate transparently (StreamProxy is built in P1.M2.T3.S1).
        this.diagnostics.debug("provider.streamSimple.eligible-delegate", {
          api: model.api,
          provider: String(model.provider),
          model: model.id,
        });
      } else {
        this.diagnostics.debug("provider.streamSimple.delegate", {
          api: model.api,
          provider: String(model.provider),
          model: model.id,
        });
      }
      return originalStreamSimple(model, context, options);
    };

    // STEP 3 — Register the wrapper under our sourceId (capture already happened → no self-recursion).
    this.registry.registerApiProvider(
      {
        api: OPENAI_COMPLETIONS_API,
        stream: wrapperStream,
        streamSimple: wrapperStreamSimple,
      },
      STOP_THINKING_SOURCE_ID,
    );
    this.registered = true;
    this.diagnostics.info("provider.decorator.initialized", {});
  }

  /**
   * Unregister the wrapper (restoring the built-in provider) and reset state. Idempotent.
   *
   * Calls `unregisterApiProviders("stop-thinking-extension")`, which removes only the entry registered
   * under our sourceId (the built-in was registered with no sourceId and is untouched). After shutdown,
   * {@link initialize} may be called again to re-capture + re-register.
   */
  shutdown(): void {
    if (!this.registered) return;
    this.registry.unregisterApiProviders(STOP_THINKING_SOURCE_ID);
    this.original = undefined;
    this.registered = false;
    this.diagnostics.info("provider.decorator.shutdown", {});
  }
}
```

### Integration Points

```yaml
CONSUMERS (downstream PRPs construct/call this — DO NOT implement them here):
  P1.M1.T5.S1 (extension factory):
      const config = loadConfig(...);                       // from T2
      const diagnostics = createDiagnostics(config.diagnosticsLevel);  // from T3
      const decorator = new ProviderDecorator(config, diagnostics);    // real registry (default)
      decorator.initialize();
      pi.on("session_shutdown", () => decorator.shutdown());           // EC-012 cleanup
  P1.M2.T3.S1 (activate StreamProxy): edits ONLY the "eligible" branch of wrapperStreamSimple to
      construct a StreamProxy instead of delegating; capture/register/shutdown lifecycle is unchanged.

  Import shape consumers will use:
    import { ProviderDecorator } from "./provider/decorator";
    import type { ProviderRegistry } from "./provider/decorator";   // tests only

BUILD:
  - entry: src/provider/decorator.ts
  - emit: dist/provider/decorator.js + dist/provider/decorator.d.ts (tsc, rootDir src / outDir dist)
  - resolution: bare "@earendil-works/pi-ai" via package "exports" (bundler moduleResolution).
  - side effect: value-importing pi-ai eagerly registers builtins (normal production behavior).

NO CHANGES TO: package.json, tsconfig.json, .gitignore, src/index.ts, src/config/*, src/diagnostics/*,
  src/provider/proxy.ts, src/state/*, src/types.ts (owned by T1/T2/T3/forbidden). The factory stub stays
  empty (wiring = P1.M1.T5.S1).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — intentional, owned by T1):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. Common failure: "ApiProviderInternal" not found → you tried to name the
#   captured type instead of using NonNullable<ReturnType<typeof getApiProvider>>. Or a "../config" /
#   "../diagnostics" resolution error → confirm those index.ts files exist (T2/T3).

# Build (emit dist):
npx bun run build            # = tsc
# Expected: dist/provider/decorator.js and dist/provider/decorator.d.ts created; exit 0.
ls dist/provider/            # must show decorator.js + decorator.d.ts (+ maps)
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bunx tsc ...`
> (verified working in this repo). Bare names only resolve inside `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the decorator suite alone:
npx bun test tests/provider-decorator.test.ts
# Expected: all green (capture/register ordering, idempotency, not-found, all 4 transparent-delegation
#   branches, no-self-recursion, stream path, shutdown lifecycle + re-init).

# Full suite (decorator + diagnostics + config + smoke):
npx bun test
# Expected: every test passes; nothing regressed.
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.

### Level 3: Integration (Package Integrity)

```bash
# Verify the emitted module is importable as built JS and exports the class + consts:
node -e "import('./dist/provider/decorator.js').then(m => console.log('exports:', Object.keys(m).sort().join(',')))"
# Expected: includes ProviderDecorator, ProviderRegistry (interface→type only, may not list as runtime key),
#   STOP_THINKING_SOURCE_ID, OPENAI_COMPLETIONS_API.

# Functional pass-through proof against the REAL pi-ai registry (this DOES mutate the global registry,
# so it restores it afterward — run in an isolated node process, not in the unit tests):
node -e "import('@earendil-works/pi-ai').then(async ({ getApiProvider, registerApiProvider, unregisterApiProviders, createAssistantMessageEventStream }) => {
  const { ProviderDecorator } = await import('./dist/provider/decorator.js');
  const origBefore = getApiProvider('openai-completions');
  const cfg = { enabled: true, supportedProviders: ['zai'], diagnosticsLevel: 'error' };
  const diag = { trace(){}, debug(){}, info(){}, warn(){}, error(){} };
  const d = new ProviderDecorator(cfg, diag);
  d.initialize();
  const afterReg = getApiProvider('openai-completions');
  console.log('registry entry changed after init:', afterReg !== origBefore);   // true (wrapper installed)
  console.log('still has streamSimple fn:', typeof afterReg.streamSimple === 'function'); // true
  d.shutdown();
  console.log('restored after shutdown:', getApiProvider('openai-completions') === origBefore); // true
});"
# Expected: registry entry changed after init: true | still has streamSimple fn: true | restored after shutdown: true
# (This is the end-to-end observational-equivalence check: install changes the entry, shutdown restores it.)
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Scope gate — do NOT wire ProviderDecorator into the factory (owned by P1.M1.T5.S1). The factory stub
# may mention "ProviderDecorator" (T1 comment) — that's allowed; only a NEW instantiation is a violation:
grep -n "new ProviderDecorator\|\.initialize()\|\.shutdown()" src/index.ts
# Expected: no matches (the factory must remain untouched in this subtask).

# Placement gate — the real module replaces the stub; proxy.ts is untouched:
test -f src/provider/decorator.ts && test -f src/provider/proxy.ts && echo "provider/ layout OK"
grep -c "ProviderDecorator — P1.M1.T4.S1" src/provider/decorator.ts   # the old stub comment
# Expected: 0  (the stub was overwritten). If >0 you kept the stub.

# Ordering-doc gate — the capture-before-register requirement MUST be in the initialize() JSDoc (Mode A):
grep -c "before" src/provider/decorator.ts
# Expected: >= 1 (the §19.2 ordering note). Also verify the sourceId appears:
grep -c "stop-thinking-extension" src/provider/decorator.ts
# Expected: >= 2 (const + usage/register + JSDoc).

# No-global-mutation gate — tests inject a fake registry; they must NOT call the real register/unregister:
grep -n "registerApiProvider\|unregisterApiProviders" tests/provider-decorator.test.ts
# Expected: matches only inside the fake-registry helper (capturing doubles), never as a direct real call.
#   (If a test imports & calls the REAL pi-ai registerApiProvider, that is a scope/test bug.)

# Privacy-doc gate — diagnostics fields are allow-listed (no options/context/reasoning logged):
grep -nE "context|options|reasoning" src/provider/decorator.ts | grep -i "diagnostics\|debug\|info"
# Expected: no matches (only api/provider/model metadata are passed to diagnostics).

# Confirm git sees only the intended changes (no edits to T1/T2/T3-owned files):
git add -A && git status --short
# Expected NEW/MODIFIED files only: src/provider/decorator.ts (modified), tests/provider-decorator.test.ts (new).
#   package.json/tsconfig.json/src/index.ts/src/config/src/diagnostics/src/provider/proxy.ts unchanged.
```

---

## Test Specification (reference suite — implement with `bun:test`)

```typescript
// tests/provider-decorator.test.ts

import { describe, test, expect } from "bun:test";
import {
  ProviderDecorator,
  STOP_THINKING_SOURCE_ID,
  OPENAI_COMPLETIONS_API,
} from "../src/provider/decorator";
import type { ProviderRegistry } from "../src/provider/decorator";
import type { Config } from "../src/config";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles ---------------------------------------------------------

/** A sentinel standing in for an AssistantMessageEventStream. Pass-through preserves identity (===). */
const STREAM_SENTINEL = { __sentinel: "stream" } as unknown;

/** Minimal Diagnostics stub (decorator only calls .debug/.info/.error in this phase). */
const noopDiagnostics: Diagnostics = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
} as Diagnostics;

const baseConfig: Config = {
  enabled: true,
  shortcut: "ctrl+.",
  supportedProviders: ["zai"],
  transitionTimeoutMs: 5000,
  replacementStartupTimeoutMs: 10000,
  maximumReasoningBufferBytes: 8388608,
  telemetryEnabled: false,
  diagnosticsLevel: "error",
};

/**
 * Build a fake registry that records an ordered `calls` trace and captures the registered provider.
 * `present` controls whether getApiProvider returns a provider or undefined.
 */
function makeFakeRegistry(opts: { present?: boolean } = {}) {
  const present = opts.present ?? true;
  const calls: string[] = [];
  // The captured "built-in" delegates: record their args + return the SAME sentinel each call.
  const builtinArgs: Array<readonly unknown[]> = [];
  const streamArgs: Array<readonly unknown[]> = [];
  let callCountSimple = 0;
  let callCountStream = 0;
  const fakeProvider = {
    api: OPENAI_COMPLETIONS_API,
    stream: (...args: unknown[]) => {
      calls.push("builtin.stream");
      streamArgs.push(args);
      callCountStream++;
      return STREAM_SENTINEL;
    },
    streamSimple: (...args: unknown[]) => {
      calls.push("builtin.streamSimple");
      builtinArgs.push(args);
      callCountSimple++;
      return STREAM_SENTINEL;
    },
  };
  let registeredProvider: { api: string; stream: unknown; streamSimple: unknown } | null = null;
  const registry: ProviderRegistry = {
    getApiProvider: (api: string) => {
      calls.push(`getApiProvider:${api}`);
      return present ? fakeProvider : undefined;
    },
    registerApiProvider: (provider, sourceId) => {
      calls.push(`registerApiProvider:${sourceId}`);
      registeredProvider = provider as { api: string; stream: unknown; streamSimple: unknown };
    },
    unregisterApiProviders: (sourceId: string) => {
      calls.push(`unregisterApiProviders:${sourceId}`);
      registeredProvider = null;
    },
  };
  return {
    registry,
    calls,
    fakeProvider,
    get registered() {
      return registeredProvider;
    },
    stats: {
      get simpleCalls() {
        return callCountSimple;
      },
      get streamCalls() {
        return callCountStream;
      },
      lastSimpleArgs: () => builtinArgs[builtinArgs.length - 1],
      lastStreamArgs: () => streamArgs[streamArgs.length - 1],
    },
  };
}

// Three model shapes exercising the activation branches.
const mkModel = (over: Partial<{ provider: string; reasoning: boolean; api: string }> = {}) => ({
  id: "m", name: "M", api: OPENAI_COMPLETIONS_API, provider: "zai", reasoning: true, ...over,
}) as never;
const ctx = { messages: [] } as never;
const opts = { temperature: 0.7 } as never;

describe("ProviderDecorator — initialize", () => {
  test("captures then registers the wrapper with the correct api + sourceId", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    expect(f.registered).not.toBeNull();
    expect(f.registered?.api).toBe(OPENAI_COMPLETIONS_API);
    expect(f.calls).toContain(`getApiProvider:${OPENAI_COMPLETIONS_API}`);
    expect(f.calls).toContain(`registerApiProvider:${STOP_THINKING_SOURCE_ID}`);
  });

  test("getApiProvider is invoked BEFORE registerApiProvider (capture-before-register, PRD §19.2)", () => {
    const f = makeFakeRegistry();
    new ProviderDecorator(baseConfig, noopDiagnostics, f.registry).initialize();
    const getIdx = f.calls.indexOf(`getApiProvider:${OPENAI_COMPLETIONS_API}`);
    const regIdx = f.calls.indexOf(`registerApiProvider:${STOP_THINKING_SOURCE_ID}`);
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeGreaterThan(getIdx); // capture strictly precedes register
  });

  test("initialize is idempotent — a second call registers nothing new", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    const after1 = f.calls.filter((c) => c.startsWith("registerApiProvider")).length;
    d.initialize(); // no-op
    const after2 = f.calls.filter((c) => c.startsWith("registerApiProvider")).length;
    expect(after2).toBe(after1);
    expect(after1).toBe(1);
  });

  test("throws when the built-in provider is absent, and leaves state unchanged", () => {
    const f = makeFakeRegistry({ present: false });
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    expect(() => d.initialize()).toThrow(/not found/);
    expect(f.calls.some((c) => c.startsWith("registerApiProvider"))).toBe(false);
    expect(f.registered).toBeNull();
    // shutdown on a never-initialized decorator is a safe no-op:
    expect(() => d.shutdown()).not.toThrow();
  });
});

describe("ProviderDecorator — wrapper delegation (transparent, all branches)", () => {
  function setup() {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    const wrapper = f.registered as {
      stream: (m: unknown, c: unknown, o: unknown) => unknown;
      streamSimple: (m: unknown, c: unknown, o: unknown) => unknown;
    };
    return { f, d, wrapper };
  }

  test("z.ai + reasoning + enabled (eligible) — STILL delegates transparently in Phase 0", () => {
    const { f, wrapper } = setup();
    const out = wrapper.streamSimple(mkModel(), ctx, opts);
    expect(out).toBe(STREAM_SENTINEL); // identical stream reference (PRD §19.7)
    expect(f.stats.simpleCalls).toBe(1);
    expect(f.stats.lastSimpleArgs()).toEqual([mkModel(), ctx, opts]); // exact triple forwarded
  });

  test("non-z.ai provider — delegates transparently", () => {
    const { f, wrapper } = setup();
    const m = mkModel({ provider: "openai" });
    const out = wrapper.streamSimple(m, ctx, opts);
    expect(out).toBe(STREAM_SENTINEL);
    expect(f.stats.simpleCalls).toBe(1);
    expect(f.stats.lastSimpleArgs()).toEqual([m, ctx, opts]);
  });

  test("non-reasoning model — delegates transparently", () => {
    const { f, wrapper } = setup();
    const m = mkModel({ reasoning: false });
    expect(wrapper.streamSimple(m, ctx, opts)).toBe(STREAM_SENTINEL);
    expect(f.stats.simpleCalls).toBe(1);
  });

  test("feature disabled (config.enabled=false) — delegates transparently", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator({ ...baseConfig, enabled: false }, noopDiagnostics, f.registry);
    d.initialize();
    const wrapper = f.registered as { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown };
    expect(wrapper.streamSimple(mkModel(), ctx, opts)).toBe(STREAM_SENTINEL);
    expect(f.stats.simpleCalls).toBe(1);
  });

  test("delegation never recurses into the wrapper (goes to the captured builtin, not the registry)", () => {
    const { f, wrapper } = setup();
    wrapper.streamSimple(mkModel(), ctx, opts);
    // The only registry calls are the single capture (init) + single register; delegation did NOT
    // re-enter getApiProvider/registerApiProvider:
    const getCount = f.calls.filter((c) => c.startsWith("getApiProvider")).length;
    const regCount = f.calls.filter((c) => c.startsWith("registerApiProvider")).length;
    expect(getCount).toBe(1);
    expect(regCount).toBe(1);
    // And it invoked the captured builtin exactly once:
    expect(f.stats.simpleCalls).toBe(1);
  });

  test("stream path delegates unconditionally (interception is streamSimple-only)", () => {
    const { f, wrapper } = setup();
    const m = mkModel({ provider: "openai", reasoning: false });
    expect(wrapper.stream(m, ctx, opts)).toBe(STREAM_SENTINEL);
    expect(f.stats.streamCalls).toBe(1);
    expect(f.stats.lastStreamArgs()).toEqual([m, ctx, opts]);
  });
});

describe("ProviderDecorator — shutdown", () => {
  test("unregisters under the sourceId exactly once and resets state", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    d.shutdown();
    expect(f.calls).toContain(`unregisterApiProviders:${STOP_THINKING_SOURCE_ID}`);
    expect(f.registered).toBeNull();
  });

  test("shutdown is idempotent — a second call does not unregister again", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    d.shutdown();
    const after1 = f.calls.filter((c) => c.startsWith("unregisterApiProviders")).length;
    d.shutdown();
    const after2 = f.calls.filter((c) => c.startsWith("unregisterApiProviders")).length;
    expect(after1).toBe(1);
    expect(after2).toBe(1);
  });

  test("shutdown on an uninitialized decorator is a safe no-op", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    expect(() => d.shutdown()).not.toThrow();
    expect(f.calls.some((c) => c.startsWith("unregisterApiProviders"))).toBe(false);
  });

  test("initialize works again after shutdown (capture fresh, re-register)", () => {
    const f = makeFakeRegistry();
    const d = new ProviderDecorator(baseConfig, noopDiagnostics, f.registry);
    d.initialize();
    d.shutdown();
    d.initialize();
    expect(f.registered).not.toBeNull();
    expect(f.registered?.api).toBe(OPENAI_COMPLETIONS_API);
    // two captures + two registers across the full lifecycle:
    expect(f.calls.filter((c) => c.startsWith("getApiProvider")).length).toBe(2);
    expect(f.calls.filter((c) => c.startsWith("registerApiProvider")).length).toBe(2);
  });
});

describe("ProviderDecorator — constants", () => {
  test("exports the expected sourceId and api constants", () => {
    expect(STOP_THINKING_SOURCE_ID).toBe("stop-thinking-extension");
    expect(OPENAI_COMPLETIONS_API).toBe("openai-completions");
  });
});
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/provider/decorator.js` + `dist/provider/decorator.d.ts`.
- [ ] `npx bun test tests/provider-decorator.test.ts` → all green.
- [ ] `npx bun test` → all green (diagnostics + config + smoke still passing).
- [ ] Level 3 node smoke: install changes the registry entry; shutdown restores the original (`===`).

### Feature Validation
- [ ] Exports: `ProviderDecorator`, `ProviderRegistry`, `STOP_THINKING_SOURCE_ID`, `OPENAI_COMPLETIONS_API`.
- [ ] `initialize()` captures via `getApiProvider("openai-completions")` and registers via
      `registerApiProvider(..., "stop-thinking-extension")`, capture STRICTLY before register.
- [ ] `initialize()` throws when the provider is absent; no registration occurs.
- [ ] `initialize()` is idempotent.
- [ ] Wrapper `streamSimple` delegates transparently for ALL branches (z.ai+reasoning+enabled, non-z.ai,
      non-reasoning, disabled): returns the **same** stream object (`===`) with the **exact** forwarded triple.
- [ ] Wrapper `stream` delegates unconditionally.
- [ ] Delegation never recurses into the wrapper / never re-enters the registry.
- [ ] `shutdown()` calls `unregisterApiProviders("stop-thinking-extension")` once and resets state;
      idempotent; `initialize()` works again afterward.

### Code Quality Validation
- [ ] Both `stream` AND `streamSimple` are wrapped (ApiProvider requires both).
- [ ] No api-guard re-implementation inside the wrapper (registry already guards it).
- [ ] Captured-provider typed as `NonNullable<ReturnType<typeof getApiProvider>>` (ApiProviderInternal not exported).
- [ ] Diagnostics receive only allow-listed metadata (api/provider/model) — never options/context/reasoning.
- [ ] Registry is injectable (DI) for tests; tests never mutate the real global registry.
- [ ] Mirrors sibling-module conventions (Mode A JSDoc, index/barrel consistency where applicable, frozen-input handling).
- [ ] `src/index.ts` (factory) untouched; no edits to `package.json`/`tsconfig.json`/`.gitignore`/`src/config`/`src/diagnostics`/`proxy.ts`.

### Documentation & Deployment
- [ ] `initialize()` JSDoc documents the **capture-before-register** ordering requirement (PRD §19.2) and
      the `"stop-thinking-extension"` sourceId (Mode A deliverable).
- [ ] JSDoc on the class + `shutdown` + `ProviderRegistry` + constructor (DI rationale, privacy note).
- [ ] Module banner documents Phase-0 transparency (interception arrives in P1.M2.T3.S1).
- [ ] `dist/provider/decorator.d.ts` carries the JSDoc for downstream consumers (P1.M1.T5.S1, P1.M2.T3.S1).

---

## Anti-Patterns to Avoid

- ❌ Don't call `registerApiProvider` BEFORE `getApiProvider` — the wrapper would capture itself → infinite
  recursion the moment M2 adds real interception. Capture is strictly first (PRD §19.2, absolute).
- ❌ Don't re-implement the `model.api !== "openai-completions"` guard in the wrapper — `registerApiProvider`
  already wraps with it (`wrapStreamSimple`); your copy is dead code and the contract's "wrapped to match
  the api check" is satisfied by going through `registerApiProvider`.
- ❌ Don't register only `streamSimple` — `ApiProvider` requires BOTH `stream` and `streamSimple`. Wrap both.
- ❌ Don't clone `options`/`context` or copy the returned stream. Pass-through = forward the exact triple and
  return the exact object (`===`). Observational equivalence (PRD §19.7) forbids any transformation.
- ❌ Don't let tests call the REAL `registerApiProvider`/`unregisterApiProviders` (mutates pi-ai's global
  registry and leaks across tests). Inject a fake `ProviderRegistry` via the constructor.
- ❌ Don't log `options`, `context`, `messages`, reasoning, or any prompt/output text (Appendix H). Only
  `api`/`provider`/`model` metadata may reach `diagnostics`.
- ❌ Don't compare `model.provider` against the `supportedProviders` array with `===` or `in`. Use
  `config.supportedProviders.includes(String(model.provider))`.
- ❌ Don't model Condition E ("already interrupting") or build a StreamProxy here — both are out of scope
  (P1.M4.T4.S1 / P1.M2.T3.S1). The "eligible" branch delegates transparently in Phase 0.
- ❌ Don't instantiate `new ProviderDecorator(...)` or call `.initialize()`/`.shutdown()` in `src/index.ts` —
  factory wiring is P1.M1.T5.S1.
- ❌ Don't modify `package.json`, `tsconfig.json`, `.gitignore`, `src/config/*`, `src/diagnostics/*`,
  `src/provider/proxy.ts`, `src/state/*`, `src/types.ts`, or `src/index.ts`.

---

## Confidence Score: **9/10**

This is a small, well-bounded lifecycle module whose trickiest aspect — the wrapper typing against pi-ai's
generics — has been **type-check-proven** against the installed `@earendil-works/pi-ai@0.74.2` (both the
annotated-`ApiStream*Function` and inline-literal variants compile under `--strict`). The pi-ai registry
semantics (api-guard wrapping, capture-returns-wrapped-builtins, sourceId-based unregister) are verified
from source in `research/api-registry-internals.md`. The complete reference implementation, the full
fake-registry test harness, the exact pass-through assertions (`===` + exact-triple), and all build/test/
scope gates are inlined and verified against the live repo conventions (`npx bun` invocation, flat tests/
dir, Mode-A JSDoc, DI-for-testability). Residual risk is minimal: (a) the "eligible-branch-also-delegates"
decision is an explicit Phase-0 scoping choice grounded in the contract ("StreamProxy is built in M2");
(b) observational equivalence is asserted structurally (identity + exact args) rather than by replaying a
real provider stream (real-stream replay is P1.M2.T4.S1 golden tests, correctly out of scope here). No
behavioral coupling to unbuilt modules: consumers construct/call the decorator later (P1.M1.T5.S1) and edit
only the eligible branch later (P1.M2.T3.S1).
