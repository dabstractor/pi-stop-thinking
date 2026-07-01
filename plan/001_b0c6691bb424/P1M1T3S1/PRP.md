# PRP — P1.M1.T3.S1: Structured Logger with Privacy Controls

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer)
> **Subtask**: P1.M1.T3.S1 (Phase 0 Foundation, 1 pt) — Diagnostics module (structured logger).
> **Builds on**: P1.M1.T1.S1 (scaffold) + **P1.M1.T2.S1 (Configuration)**. Assumes `src/config/index.ts`
> already exports `DiagnosticsLevel` and `Config` exactly as that PRP specifies (it is the input
> contract — see "INPUT" below). **This subtask replaces `src/diagnostics/.gitkeep` with a real module.**

---

## Goal

**Feature Goal**: Implement a **structured JSON logger** with five ordered severity levels and a
privacy contract, exposed as `createDiagnostics(level, sink?)`, that every other extension module
will receive by reference. Messages whose severity is below the configured level are silently dropped;
the logger never modifies runtime behavior (PRD §36). A documented, configurable sink enables
zero-pollution unit testing.

**Deliverable**:
- `src/diagnostics/index.ts` exporting: `createDiagnostics`, the `Diagnostics` interface, and the
  `DiagnosticsSink` interface. Imports only `DiagnosticsLevel` (type-only) from `../config`.
- Full JSDoc (Mode A) on the module, `Diagnostics` interface, `createDiagnostics`, and `DiagnosticsSink`,
  prominently documenting the **privacy rules** from PRD Appendix H ("NEVER log prompt text, reasoning,
  assistant output, API keys, tool arguments"), and the level-ordering/drop semantics.
- `tests/diagnostics.test.ts` — comprehensive Bun unit tests (level filtering for all 5 levels,
  sink routing, JSON structure, reserved-key authority, optional fields, frozen object, no-throw).

**Success Definition**: From a clean checkout (after T1 scaffold + T2 config land), `npx bun run
typecheck && npx bun run build && npx bun test` all exit 0; `dist/diagnostics/index.js` +
`dist/diagnostics/index.d.ts` are emitted; every test in `tests/diagnostics.test.ts` passes; no
`@earendil-works/*` import exists in `src/diagnostics/` (module is Pi-independent / unit-testable);
`src/index.ts` is **not** modified (factory wiring is P1.M1.T5.S1).

---

## Why

- **Single shared observability surface for every module.** Per the module dependency graph
  (`architecture/module_contracts.md`), `Diagnostics` is created once in the factory and passed by
  reference to ProviderDecorator, StreamProxy, TransitionController, ReasoningBuffer, ShortcutManager,
  RequestBuilder, and Telemetry. It must exist before any of them can emit structured logs.
- **Privacy by construction (PRD §58 + Appendix H).** The extension streams through provider event
  streams containing prompts, reasoning, and assistant output. A logger with an explicit, JSDoc-enforced
  allow/deny list prevents sensitive data from ever reaching stdout/stderr. This is a security
  objective (Appendix H — Security Objectives: do not expand the attack surface).
- **Deterministic, structured output (PRD §57).** "Logs shall be structured. No free-form parsing shall
  be required." Emitting one JSON object per line enables downstream `jq`/log tooling without regex.

## What

A Pi-independent TypeScript module (no `@earendil-works/*` runtime imports):
1. `createDiagnostics(level: DiagnosticsLevel, sink?: DiagnosticsSink): Diagnostics` — factory that
   returns a frozen `Diagnostics` object with `trace/debug/info/warn/error` methods.
2. Each method: `(event: string, fields?: Record<string, unknown>) => void`. Emits a single-line JSON
   object `{ ...fields, ts, level, event }` **only** when the method's severity is at/above the
   configured threshold; otherwise a silent no-op.
3. **Level ordering**: `error < warn < info < debug < trace`. Default config level `"error"` means only
   `error` emits (matches PRD §36 "Disabled by default" = no verbose/trace logging).
4. **Sink routing**: `warn`/`error` → `sink.error`; `trace`/`debug`/`info` → `sink.log`. Default sink
   wraps `console.error`/`console.log`. Caller may inject a sink (used by tests + future telemetry sink).
5. **Privacy (Mode A docs)**: JSDoc on the module and `Diagnostics` interface states the Appendix H
   allow-list (provider, model, transitionId, timing, event counts, state transitions, error categories)
   and deny-list (prompt text, reasoning, assistant output, API keys, auth headers, tool args/outputs).
6. `tests/diagnostics.test.ts` covering all of the above.

**Out of scope** (owned by other subtasks — do NOT implement here):
- Calling `createDiagnostics(config.diagnosticsLevel)` and passing it to other modules → **P1.M1.T5.S1**
  (extension factory init/shutdown wiring).
- Runtime privacy filtering / secret-scrubbing of `fields` → **not required** (would risk false
  positives on legitimate fields); privacy is enforced by JSDoc contract + caller discipline.
- Telemetry metrics recording → **P1.M8.T1.S1** (Telemetry module). This logger only writes log lines.
- Wiring a custom sink from the factory → **P1.M1.T5.S1**.

### Success Criteria

- [ ] `src/diagnostics/index.ts` exports `createDiagnostics`, `Diagnostics` (interface),
      `DiagnosticsSink` (interface). Nothing else is required.
- [ ] `npx bun run typecheck` reports **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/diagnostics/index.js` + `dist/diagnostics/index.d.ts`.
- [ ] `npx bun test` passes (diagnostics tests green; existing `tests/smoke.test.ts` +
      `tests/config.test.ts` still green).
- [ ] At configured level `"error"`, only `.error(...)` writes a line; `.warn/.info/.debug/.trace`
      are silent no-ops. At `"trace"`, all five write.
- [ ] `warn`/`error` lines go to `sink.error`; `trace`/`debug`/`info` lines go to `sink.log`.
- [ ] Every emitted line is valid JSON containing `ts`, `level`, `event`, and the spread `fields`.
- [ ] The returned `Diagnostics` object is frozen (`Object.isFrozen === true`).
- [ ] No `import ... from "@earendil-works/..."` in `src/diagnostics/index.ts`.
- [ ] `src/index.ts` is **untouched** (no `createDiagnostics` call added).

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the exact interfaces, the full reference implementation, the complete test
suite, the resolved level-semantics (the one genuinely ambiguous part of the contract), the exact
build/test commands (verified to work in this repo), and the privacy allow/deny lists verbatim from
the PRD. The only external assumption — that P1.M1.T2.S1's `src/config/index.ts` exports `DiagnosticsLevel`
— is stated with its exact import path.

### Documentation & References

```yaml
# MUST READ — authoritative contracts for THIS module
- file: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "The 'Diagnostics' block defines the 5-method interface signature and the privacy allow/deny
        list. This is the single source of truth for the public surface."
  critical: "Exact method shape: trace/debug/info/warn/error(event: string, fields?: Record<string,
        unknown>): void. Privacy: MAY LOG provider/model/transitionId/timing/eventCounts/state
        transitions/error categories; NEVER LOG prompt/reasoning/assistant output/API keys/tool args."

# PRD authority (PRD.md in repo root)
- url: PRD.md §36 "Diagnostics Module"
  why: "Responsibility = developer debugging; Disabled by default; modes Disabled/Errors/Verbose/Trace;
        'Verbose logging shall never modify runtime behavior.'"
  critical: "4 display modes in §36 map onto the 5-level DiagnosticsLevel union from Config. The logger
        operates on the 5 typed levels; 'Disabled' ≡ default 'error' (only fatal). Do NOT invent a 6th
        'disabled' level — DiagnosticsLevel has no such member (P1.M1.T2.S1 contract)."

- url: PRD.md §57 "Logging Specification"
  why: "Per-level intent: Trace=every state transition; Debug=lifecycle milestones; Info=successful
        transitions; Warning=recoverable failures; Error=fatal failures. 'Logs shall be structured.
        No free-form parsing shall be required.'"
  critical: "Structured = JSON, one object per line. These intents are guidance for CALLERS (what to
        log at each level); the logger just implements filtering + formatting."

- url: PRD.md Appendix H §"Logging Rules"
  why: "Verbatim allow-list and deny-list that MUST appear in the JSDoc (Mode A)."
  critical: "MAY LOG: provider name, model identifier, transition ID, timing metrics, event counts,
        state transitions, error categories. NEVER LOG: prompt text, assistant output, reasoning
        output, API keys, authorization headers, tool arguments, tool outputs."

- url: PRD.md Appendix H §"Security Objectives" + §"Sensitive Data"
  why: "Frames WHY the privacy contract exists (do not expand Pi's attack surface)."
  critical: "Sensitive data list (API keys, OAuth tokens, prompts, conversation history, assistant
        output, reasoning, tool args/results, file contents, binaries) is the superset the deny-list
        is drawn from."

- url: PRD.md Appendix M "Developer Debugging Guide" → "Trace Levels" + "Trace Correlation"
  why: "Trace Correlation says every transition log includes transitionId, streamId, provider, model,
        currentState, timestamp. The LOGGER auto-injects `ts`; the caller supplies the rest as fields."
  critical: "Document the split in JSDoc: logger owns `ts`/`level`/`event`; caller owns correlation
        fields. Do NOT have the logger invent transitionId/streamId."

# REFERENCE — the input contract (already implemented in parallel by P1.M1.T2.S1)
- file: src/config/index.ts
  why: "Source of the DiagnosticsLevel type we import (type-only). Confirms the 5-level union and
        that the default level is 'error' (validated, frozen)."
  pattern: "import type { DiagnosticsLevel } from '../config';  // type-only keeps this module pure"
  gotcha: "Importing a *type* from a sibling internal module is allowed and does NOT violate the
           'no Pi imports' purity gate. The gate is specifically: no '@earendil-works/*' imports."

# REFERENCE — established repo conventions to mirror
- file: src/config/index.ts (the sibling module shipped by P1.M1.T2.S1)
  why: "MIRROR its conventions exactly: file at <dir>/index.ts replacing .gitkeep; JSDoc (Mode A) on
        every exported symbol; strict per-field typing; no Pi imports; deep concern for immutability."
  pattern: "Object.freeze on the exported shared object; minimal public surface; reference impl inline."

- file: plan/001_b0c6691bb424/P1M1T2S1/PRP.md
  why: "Proven PRP template/quality bar in this repo (it shipped and its tests pass: 32 tests green).
        Match its structure, gotcha density, and validation-command style."
```

### Current Codebase tree (after T1 scaffold + T2 config land)

```bash
.
├── package.json          # T1: scripts build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); bun devDep
├── tsconfig.json         # T1: ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         #     include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── README.md             # T1 (skeleton)
├── src/
│   ├── index.ts          # T1/T5: factory STUB (empty body) — DO NOT modify here
│   ├── types.ts          # T1: placeholder — DO NOT modify here
│   ├── provider/{decorator,proxy}.ts   # T1 stubs
│   ├── state/{controller,coordinator}.ts
│   ├── config/index.ts   # T2: Config/DiagnosticsLevel/DEFAULT_CONFIG/loadConfig/validateConfig (DONE)
│   ├── diagnostics/.gitkeep   # ← THIS becomes src/diagnostics/index.ts (remove the .gitkeep)
│   ├── buffer/.gitkeep
│   ├── shortcut/.gitkeep
│   └── request/.gitkeep
├── tests/
│   ├── smoke.test.ts     # T1 (must stay green)
│   └── config.test.ts    # T2 (must stay green)
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── package.json          # UNCHANGED (owned by T1) — reuse existing test/build/typecheck scripts
├── tsconfig.json         # UNCHANGED (owned by T1)
├── src/
│   ├── diagnostics/
│   │   └── index.ts      # NEW (replaces .gitkeep) — createDiagnostics / Diagnostics / DiagnosticsSink
│   └── ...               # all other files UNCHANGED (incl. src/config/index.ts and src/index.ts)
├── tests/
│   ├── smoke.test.ts     # UNCHANGED
│   ├── config.test.ts    # UNCHANGED
│   └── diagnostics.test.ts  # NEW — Bun unit tests
└── dist/diagnostics/{index.js,index.d.ts}  # GENERATED by `npx bun run build`
```
**File responsibilities**: `src/diagnostics/index.ts` = sole runtime surface — `createDiagnostics`
factory + the `Diagnostics`/`DiagnosticsSink` interfaces + JSDoc privacy contract. `tests/diagnostics
.test.ts` = exhaustive filtering/routing/structure/freeze coverage. No other file is touched.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (purity): This module MUST NOT import "@earendil-works/*". Reading config FLAGS / wiring
// the logger into the factory is P1.M1.T5.S1's job. Importing the DiagnosticsLevel *type* from
// "../config" is allowed (type-only; config is a pure internal sibling, not a Pi API). Keeping this
// module Pi-free keeps it unit-testable with zero Pi runtime and matches the config-module precedent.

// CRITICAL (level semantics — the one ambiguous part of the contract): "Messages below the configured
// level are silently dropped" + "error < warn < info < debug < trace". Resolve as: numeric weights
// error=0,warn=1,info=2,debug=3,trace=4; EMIT iff weight(methodLevel) <= weight(configuredLevel).
//   configured "error" → only .error() emits.   configured "trace" → all five emit.
// This matches PRD §36 "Disabled by default" (default level is "error" = only fatal errors logged).

// GOTCHA (PRD §36 has 4 display MODES but Config's DiagnosticsLevel has 5 LEVELS): the modes
// (Disabled/Errors/Verbose/Trace) are a higher-level UX label layer; the logger operates strictly on
// the 5-level union. Do NOT add a 6th "disabled" member — DiagnosticsLevel has none. "Disabled" ≡ the
// default "error" level. Document this reconciliation so reviewers aren't confused.

// GOTCHA (reserved JSON keys): build the line as { ...fields, ts, level, event } — caller fields
// SPREAD FIRST, reserved keys set LAST so they are authoritative. A caller passing {level:"x"} cannot
// clobber the real level. Document ts/level/event as logger-owned keys.

// GOTCHA (sink must be injectable for tests): do NOT hardcode console.log/console.error inside emit().
// Default the sink to a wrapper object { log, error } and let tests inject a capturing sink; otherwise
// tests would pollute the test runner's stdout/stderr and couldn't assert on emitted lines.

// GOTCHA (frozen shared object): the Diagnostics instance is passed BY REFERENCE to every module
// (module_contracts.md). Object.freeze() the returned object so no consumer can reassign its methods
// and silently break logging for everyone.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → `npx bun run typecheck` checks src ONLY.
// tests/diagnostics.test.ts is validated by `npx bun test` (Bun runs TS natively). Do not add tests to
// the build include (owned by T1).

// GOTCHA (bun is a local devDep, NOT on PATH): invoke as `npx bun ...` / `npx bunx tsc ...`, NOT bare
// `bun`/`bunx` (those fail with "command not found" outside an npm-script context). The package.json
// scripts (build/test/typecheck) use bare names and DO resolve via `npx bun run <script>`.

// GOTCHA (placement): put the module at src/diagnostics/index.ts and import via "./diagnostics"
// (from src) / "../src/diagnostics" (from tests). moduleResolution:"bundler" + Bun both resolve a bare
// directory to its index.ts. Do NOT name it diagnostics.ts (would shadow the dir).

// GOTCHA (privacy is Mode A = DOCS, not runtime filtering): do NOT scrub/redact fields at runtime.
// Runtime scrubbing risks false positives (e.g. a legit "provider" value that happens to look like a
// key). Privacy is enforced by JSDoc contract + caller discipline per PRD Appendix H.
```

---

## Implementation Blueprint

### Data models and structure

```typescript
import type { DiagnosticsLevel } from "../config";   // type-only import (P1.M1.T2.S1 contract)

/** Severity weight table implementing `error < warn < info < debug < trace` (PRD §57). */
export const LEVEL_WEIGHT: Readonly<Record<DiagnosticsLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** Where structured lines are written. Default wraps console.log/console.error. */
export interface DiagnosticsSink {
  log(line: string): void;
  error(line: string): void;
}

/** Structured logger shared by reference across all extension modules (PRD §36, §57). */
export interface Diagnostics {
  trace(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createDiagnostics(level: DiagnosticsLevel, sink?: DiagnosticsSink): Diagnostics;
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REMOVE src/diagnostics/.gitkeep; CREATE src/diagnostics/index.ts
  - DELETE: src/diagnostics/.gitkeep (dir now tracked by index.ts).
  - IMPORT (type-only): `import type { DiagnosticsLevel } from "../config";`
  - IMPLEMENT: LEVEL_WEIGHT const, DiagnosticsSink interface, Diagnostics interface, createDiagnostics
    factory EXACTLY per the reference implementation in "Implementation Patterns" below.
  - NAMING: camelCase function (createDiagnostics); PascalCase interfaces (Diagnostics, DiagnosticsSink);
    UPPER_SNAKE const (LEVEL_WEIGHT).
  - JSDOC (Mode A): module-level banner stating purpose + privacy contract; JSDoc on Diagnostics
    (with the FULL Appendix H allow/deny list verbatim), DiagnosticsSink, createDiagnostics (level
    semantics, sink default, frozen return, "never modifies behavior"), and LEVEL_WEIGHT.
  - PLACEMENT: src/diagnostics/index.ts.
  - GOTCHA: no @earendil-works imports; reserved JSON keys authoritative; sink injectable; frozen return.

Task 2: CREATE tests/diagnostics.test.ts
  - IMPLEMENT: the suite specified in "Test Specification" below using `bun:test`.
  - IMPORT: `import { createDiagnostics } from "../src/diagnostics";`
    `import type { Diagnostics, DiagnosticsSink } from "../src/diagnostics";`
    `import type { DiagnosticsLevel } from "../src/config";`
  - FOLLOW pattern: tests/config.test.ts (Bun `describe`/`test`/`expect`; inject a capturing sink).
  - NAMING: describe("createDiagnostics — level filtering" / "sink routing" / "JSON structure" / ...).
  - COVERAGE: level filtering for ALL 5 configured levels; sink routing (warn/error→error sink,
    trace/debug/info→log sink); JSON validity + keys (ts/level/event/fields); reserved-key authority;
    optional fields omitted; frozen return; no-sink default does not throw.
  - PLACEMENT: tests/diagnostics.test.ts (flat tests/ dir; excluded from build).

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics.
  - RUN: npx bun run build      → dist/diagnostics/index.js + dist/diagnostics/index.d.ts created.
  - RUN: npx bun test           → all green (diagnostics + config + smoke).
  - RUN: Level 4 gates (purity, scope, placement) below.
```

### Implementation Patterns & Key Details

```typescript
// src/diagnostics/index.ts — COMPLETE reference implementation. Author this verbatim (JSDoc included).

/**
 * # Diagnostics — structured logger with privacy controls
 *
 * Developer-facing structured logging for the Stop Thinking & Do extension (PRD §36). Produces one
 * JSON object per line so that "No free-form parsing shall be required" (PRD §57). Disabled-by-default
 * verbosity: at the default level `"error"` only fatal errors are emitted, so the module is silent
 * unless a developer raises the level.
 *
 * **This logger never modifies runtime behavior** (PRD §36: "Verbose logging shall never modify
 * runtime behavior."). Every method is fire-and-forget; a dropped message is a silent no-op.
 *
 * ---
 * ## PRIVACY CONTRACT (PRD §58 + Appendix H — Logging Rules) — READ BEFORE LOGGING
 *
 * Only the following fields MAY be passed in `fields`:
 *  - Provider name
 *  - Model identifier
 *  - Transition ID
 *  - Timing metrics
 *  - Event counts
 *  - State transitions
 *  - Error categories
 *
 * The following MUST NEVER be logged (directly or nested) — doing so leaks user secrets to logs:
 *  - Prompt text
 *  - Assistant output
 *  - Reasoning output
 *  - API keys
 *  - Authorization headers
 *  - Tool arguments
 *  - Tool outputs
 *
 * Privacy here is enforced by this contract + caller discipline; the logger does not scrub fields
 * at runtime (scrubbing risks false positives on legitimate values). It is the CALLER's responsibility
 * to pass only allow-listed fields. See PRD Appendix H — Security & Privacy Model.
 *
 * ## Level semantics
 *
 * Ordering: `error < warn < info < debug < trace`. A message is emitted iff its severity weight is
 * `<=` the configured level's weight; otherwise it is silently dropped ("messages below the configured
 * level are dropped"). Per-level intent (PRD §57): Error=fatal failures; Warning=recoverable failures;
 * Info=successful transitions; Debug=lifecycle milestones; Trace=every state transition.
 *
 * ## Trace correlation (PRD Appendix M)
 *
 * The logger auto-injects `ts`. Callers logging during a transition SHOULD also include `transitionId`,
 * `streamId`, `provider`, `model`, `currentState` as `fields` (these are caller-owned, not logger-owned).
 */

import type { DiagnosticsLevel } from "../config";

/** Numeric severity implementing `error < warn < info < debug < trace` (PRD §57). Lower = more severe. */
export const LEVEL_WEIGHT: Readonly<Record<DiagnosticsLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * Destination for structured log lines. `log` receives trace/debug/info lines; `error` receives
 * warn/error lines (mirroring `console.log` vs `console.error`). Inject a custom sink (e.g. a
 * capturing array) for tests or to route into a future telemetry sink.
 */
export interface DiagnosticsSink {
  /** Receives trace/debug/info lines. */
  log(line: string): void;
  /** Receives warn/error lines. */
  error(line: string): void;
}

/** Default sink: writes to `console.log` / `console.error`. */
const DEFAULT_SINK: DiagnosticsSink = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Structured logger with five ordered severity levels and a privacy contract (PRD §36, §57,
 * Appendix H). See the module-level JSDoc for the allow/deny field lists.
 *
 * One instance is created in the extension factory and passed BY REFERENCE to every module. The
 * returned object is frozen so no consumer can reassign its methods.
 */
export interface Diagnostics {
  /** Most verbose — every state transition (PRD §57). */
  trace(event: string, fields?: Record<string, unknown>): void;
  /** Lifecycle milestones (PRD §57). */
  debug(event: string, fields?: Record<string, unknown>): void;
  /** Successful transitions (PRD §57). */
  info(event: string, fields?: Record<string, unknown>): void;
  /** Recoverable failures (PRD §57). Routed to the sink's `error` channel. */
  warn(event: string, fields?: Record<string, unknown>): void;
  /** Fatal failures (PRD §57). Routed to the sink's `error` channel. */
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Create a {@link Diagnostics} logger that filters by `level` and writes structured JSON lines to
 * `sink` (default: `console.log`/`console.error`).
 *
 * @param level  Minimum severity to emit. A method emits iff `LEVEL_WEIGHT[methodLevel] <=
 *               LEVEL_WEIGHT[level]`; lower-severity messages are silently dropped. e.g. `"error"`
 *               emits only `.error()`; `"trace"` emits all five.
 * @param sink   Optional destination. Defaults to the console. Inject a capturing sink for tests.
 * @returns A **frozen** {@link Diagnostics} instance.
 *
 * Each emitted line is `JSON.stringify({ ...fields, ts: ISO8601, level, event })` — caller `fields`
 * are spread first, then reserved keys (`ts`/`level`/`event`) are set authoritatively, so a caller
 * cannot accidentally clobber the level. Never throws on the logging path (a dropped message is a
 * no-op; emitted messages rely on the sink, which defaults to console).
 *
 * **Privacy (PRD Appendix H):** the CALLER must pass only allow-listed fields (provider, model,
 * transitionId, timing, event counts, state transitions, error categories). NEVER pass prompt text,
 * reasoning, assistant output, API keys, authorization headers, or tool arguments/outputs.
 */
export function createDiagnostics(
  level: DiagnosticsLevel,
  sink: DiagnosticsSink = DEFAULT_SINK,
): Diagnostics {
  // Unknown level falls back to the most restrictive (only errors). Config guarantees a valid level,
  // but this keeps the logger safe if invoked with a bad value at runtime.
  const threshold: number = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.error;

  const emit = (
    methodLevel: DiagnosticsLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[methodLevel] > threshold) return; // below configured severity → drop silently
    const line = JSON.stringify({
      ...fields,                       // caller fields first
      ts: new Date().toISOString(),    // reserved (logger-owned)
      level: methodLevel,              // reserved (logger-owned, authoritative)
      event,                           // reserved (logger-owned, authoritative)
    });
    if (methodLevel === "warn" || methodLevel === "error") {
      sink.error(line);
    } else {
      sink.log(line);
    }
  };

  return Object.freeze<Diagnostics>({
    trace: (event, fields) => emit("trace", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  });
}
```

### Integration Points

```yaml
CONSUMERS (downstream PRPs receive a Diagnostics instance by reference — DO NOT implement them here):
  P1.M1.T4.S1 (ProviderDecorator): logs activation/delegation decisions (debug), capture errors (error).
  P1.M4.T2.S1 (StreamProxy): logs every state transition (trace), lifecycle milestones (debug).
  P1.M3.T1.S1 (TransitionController): logs state transitions (trace) + successful transitions (info).
  P1.M8.T1.S1 (Telemetry): MAY consume the same Diagnostics instance or its own recorder (separate).
  Factory wiring (P1.M1.T5.S1): creates ONE instance and passes it to all modules:
      const diagnostics = createDiagnostics(config.diagnosticsLevel);
      // ...passed to decorator, coordinator, proxy construction, etc.

  Import shape consumers will use:
    import type { Diagnostics } from "./diagnostics";
    // (the instance is injected via constructor/args; modules do not call createDiagnostics themselves)

BUILD:
  - entry: src/diagnostics/index.ts
  - emit: dist/diagnostics/index.js + dist/diagnostics/index.d.ts (tsc, rootDir src / outDir dist)
  - resolution: dir import "./diagnostics" → "./diagnostics/index.ts" (bundler + Bun index resolution)

NO CHANGES TO: package.json, tsconfig.json, src/index.ts, src/config/index.ts, .gitignore
  (all owned by T1/T2 or forbidden). The factory stub stays empty (wiring = P1.M1.T5.S1).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — intentional, owned by T1):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. An error about "../config" resolution → confirm file is
#   src/diagnostics/index.ts and that src/config/index.ts exists (P1.M1.T2.S1).

# Build (emit dist):
npx bun run build            # = tsc
# Expected: dist/diagnostics/index.js and dist/diagnostics/index.d.ts created; exit 0.
ls dist/diagnostics/         # must show index.js + index.d.ts (+ maps)
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bunx tsc ...`
> (verified working in this repo). The bare names only resolve inside `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the diagnostics suite alone:
npx bun test tests/diagnostics.test.ts
# Expected: all green (level filtering, sink routing, JSON structure, reserved keys, freeze).

# Full suite (diagnostics + config + smoke):
npx bun test
# Expected: every test passes; nothing regressed (was 32 pass before this subtask).
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.

### Level 3: Integration (Package Integrity)

```bash
# Verify the emitted module is importable as built JS and exports the public API:
node -e "import('./dist/diagnostics/index.js').then(m => console.log('exports:', Object.keys(m).sort().join(',')))"
# Expected: includes createDiagnostics (+ Diagnostics/DiagnosticsSink are interfaces → types only,
#   so they won't appear as runtime keys; that's correct).

# Functional smoke test via the built artifact — level filtering + JSON structure:
node -e "import('./dist/diagnostics/index.js').then(({ createDiagnostics }) => {
  const sink = { log: l => console.log('LOG:', l), error: l => console.log('ERR:', l) };
  const d = createDiagnostics('warn', sink);   // error+warn emit
  d.trace('t'); d.debug('db'); d.info('i');    // dropped (below 'warn')
  d.warn('w', { provider: 'zai' });            // ERR: {...level:warn...}
  d.error('e', { transitionId: 't1' });        // ERR: {...level:error...}
});"
# Expected: exactly two ERR lines, both valid JSON, both with ts/level/event + the passed fields;
#   NO LOG lines (trace/debug/info dropped).

# Verify the returned object is frozen at the built boundary:
node -e "import('./dist/diagnostics/index.js').then(({ createDiagnostics }) => {
  const d = createDiagnostics('error');
  console.log('frozen:', Object.isFrozen(d));
});"
# Expected: frozen: true
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Purity gate — the diagnostics module must NOT depend on Pi APIs (stays unit-testable):
grep -c "@earendil-works" src/diagnostics/index.ts
# Expected: 0   (importing the DiagnosticsLevel *type* from "../config" is fine — that's an internal
#          sibling, not a Pi API).

# Scope gate — do NOT wire createDiagnostics into the factory (owned by P1.M1.T5.S1). The existing
# index.ts comment may mention "Diagnostics" (T1 stub) — that's allowed; only a NEW call is a violation:
grep -n "createDiagnostics" src/index.ts
# Expected: no matches (the factory must remain untouched in this subtask).

# Confirm the .gitkeep was replaced (dir now tracked by a real file):
test ! -f src/diagnostics/.gitkeep && test -f src/diagnostics/index.ts && echo "diagnostics module placement OK"

# Privacy-doc gate — the privacy deny-list MUST be present in the JSDoc (Mode A deliverable):
grep -c "NEVER" src/diagnostics/index.ts
# Expected: >= 1 (the Appendix H deny list block). Also verify key terms appear:
grep -iE "prompt text|reasoning|api keys|tool arguments" src/diagnostics/index.ts
# Expected: matches for each deny-listed item.

# Confirm git sees only the intended changes (no edits to T1/T2-owned files):
git add -A && git status --short
# Expected NEW files only: src/diagnostics/index.ts, tests/diagnostics/test.ts; plus the
#   src/diagnostics/.gitkeep deletion. package.json/tsconfig.json/src/index.ts/src/config/index.ts
#   unchanged.
```

---

## Test Specification (reference suite — implement with `bun:test`)

```typescript
// tests/diagnostics.test.ts

import { describe, test, expect } from "bun:test";
import { createDiagnostics, LEVEL_WEIGHT } from "../src/diagnostics";
import type { Diagnostics, DiagnosticsSink } from "../src/diagnostics";
import type { DiagnosticsLevel } from "../src/config";

/** A sink that captures every line + which channel it used. */
function captureSink(): DiagnosticsSink & { log: (l: string) => void; error: (l: string) => void; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (l: string) => void logs.push(l),
    error: (l: string) => void errors.push(l),
  };
}

// Which methods should emit at a given configured level (weight <= threshold).
const EMITS_AT: Record<DiagnosticsLevel, Array<keyof Diagnostics>> = {
  error: ["error"],
  warn: ["error", "warn"],
  info: ["error", "warn", "info"],
  debug: ["error", "warn", "info", "debug"],
  trace: ["error", "warn", "info", "debug", "trace"],
};
const ALL_METHODS: Array<keyof Diagnostics> = ["error", "warn", "info", "debug", "trace"];

describe("createDiagnostics — level filtering", () => {
  for (const level of ["error", "warn", "info", "debug", "trace"] as DiagnosticsLevel[]) {
    test(`at level "${level}" only the expected methods emit`, () => {
      const sink = captureSink();
      const d = createDiagnostics(level, sink);
      const emitted = new Set<string>();
      for (const m of ALL_METHODS) {
        const before = sink.logs.length + sink.errors.length;
        (d[m] as (e: string) => void)(`evt.${m}`);
        const after = sink.logs.length + sink.errors.length;
        if (after > before) emitted.add(m);
      }
      expect([...emitted].sort()).toEqual([...EMITS_AT[level]].sort());
    });
  }

  test("dropped messages are true no-ops (nothing written to either channel)", () => {
    const sink = captureSink();
    const d = createDiagnostics("error", sink); // only error emits
    d.trace("t"); d.debug("db"); d.info("i"); d.warn("w");
    expect(sink.logs).toEqual([]);
    expect(sink.errors).toEqual([]);
  });
});

describe("createDiagnostics — sink routing", () => {
  test("warn/error -> sink.error; trace/debug/info -> sink.log", () => {
    const sink = captureSink();
    const d = createDiagnostics("trace", sink); // everything emits
    d.trace("t"); d.debug("db"); d.info("i"); d.warn("w"); d.error("e");
    expect(sink.logs).toHaveLength(3);   // trace, debug, info
    expect(sink.errors).toHaveLength(2); // warn, error
    for (const line of sink.logs) expect(JSON.parse(line).level).toMatch(/trace|debug|info/);
    for (const line of sink.errors) expect(JSON.parse(line).level).toMatch(/warn|error/);
  });
});

describe("createDiagnostics — JSON structure", () => {
  test("every emitted line is valid JSON with ts/level/event and spread fields", () => {
    const sink = captureSink();
    const d = createDiagnostics("info", sink);
    d.info("transition.started", { provider: "zai", model: "glm-4.7", transitionId: "t1" });
    expect(sink.logs).toHaveLength(1);
    const obj = JSON.parse(sink.logs[0]);
    expect(obj.level).toBe("info");
    expect(obj.event).toBe("transition.started");
    expect(typeof obj.ts).toBe("string");
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(obj.provider).toBe("zai");
    expect(obj.model).toBe("glm-4.7");
    expect(obj.transitionId).toBe("t1");
  });

  test("fields are optional (omitting fields still produces a valid line)", () => {
    const sink = captureSink();
    createDiagnostics("error", sink).error("boom");
    expect(sink.errors).toHaveLength(1);
    const obj = JSON.parse(sink.errors[0]);
    expect(obj).toEqual({ ts: obj.ts, level: "error", event: "boom" });
  });

  test("reserved keys (level/event) are authoritative — caller cannot clobber them", () => {
    const sink = captureSink();
    const d = createDiagnostics("info", sink);
    // Caller tries to forge level/event — must be ignored (logger-owned keys win).
    d.info("real.event", { level: "trace", event: "fake", ts: "EVIL" });
    const obj = JSON.parse(sink.logs[0]);
    expect(obj.level).toBe("info");
    expect(obj.event).toBe("real.event");
    expect(obj.ts).not.toBe("EVIL");
  });
});

describe("createDiagnostics — object safety", () => {
  test("returned Diagnostics object is frozen", () => {
    expect(Object.isFrozen(createDiagnostics("error"))).toBe(true);
  });

  test("default sink (no sink arg) does not throw", () => {
    expect(() => {
      const d = createDiagnostics("trace");
      d.trace("t"); d.error("e");
    }).not.toThrow();
  });
});

describe("LEVEL_WEIGHT", () => {
  test("implements error < warn < info < debug < trace", () => {
    expect(LEVEL_WEIGHT.error).toBeLessThan(LEVEL_WEIGHT.warn);
    expect(LEVEL_WEIGHT.warn).toBeLessThan(LEVEL_WEIGHT.info);
    expect(LEVEL_WEIGHT.info).toBeLessThan(LEVEL_WEIGHT.debug);
    expect(LEVEL_WEIGHT.debug).toBeLessThan(LEVEL_WEIGHT.trace);
  });
});
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/diagnostics/index.js` + `dist/diagnostics/index.d.ts`.
- [ ] `npx bun test tests/diagnostics.test.ts` → all green.
- [ ] `npx bun test` → all green (config + smoke still passing; count grew from 32).
- [ ] Built module `node -e` import works and produces exactly the expected lines (Level 3 smoke).

### Feature Validation
- [ ] Exports: `createDiagnostics`, `Diagnostics` (interface), `DiagnosticsSink` (interface), `LEVEL_WEIGHT`.
- [ ] Level filtering: at `"error"` only `.error()`; at `"trace"` all five; exact EMITS_AT table holds.
- [ ] Sink routing: `warn`/`error` → `sink.error`; `trace`/`debug`/`info` → `sink.log`.
- [ ] Emitted lines are valid JSON with `ts` (ISO-8601), `level`, `event`, and spread `fields`.
- [ ] Reserved keys `ts`/`level`/`event` are authoritative (caller cannot clobber them).
- [ ] Dropped messages write nothing to either sink channel.
- [ ] `fields` parameter is optional.

### Code Quality Validation
- [ ] `Object.isFrozen(createDiagnostics(...))` === `true`.
- [ ] No `@earendil-works/*` import in `src/diagnostics/index.ts` (purity gate).
- [ ] `src/index.ts`, `src/config/index.ts`, `package.json`, `tsconfig.json`, `.gitignore` untouched.
- [ ] Mirrors `src/config/index.ts` conventions (index.ts placement, Mode A JSDoc, frozen shared object).

### Documentation & Deployment
- [ ] Module-level JSDoc includes the **full** Appendix H allow-list AND deny-list (privacy contract).
- [ ] JSDoc on `createDiagnostics` documents level semantics, sink default, frozen return, "never
      modifies behavior", and the caller's privacy responsibility.
- [ ] JSDoc on each `Diagnostics` method references its PRD §57 intent (Error/Warning/Info/Debug/Trace).
- [ ] `dist/diagnostics/index.d.ts` carries the JSDoc for downstream consumers.

---

## Anti-Patterns to Avoid

- ❌ Don't import `@earendil-works/*` (any Pi API). The `DiagnosticsLevel` *type* from `"../config"` is
  allowed (internal pure sibling). Reading config flags / wiring the logger = P1.M1.T5.S1 scope.
- ❌ Don't hardcode `console.log`/`console.error` inside `emit()` — inject a sink so tests can capture
  output and so a future telemetry sink can be wired (P1.M1.T5.S1).
- ❌ Don't implement level filtering backwards. EMIT iff `LEVEL_WEIGHT[method] <= LEVEL_WEIGHT[level]`.
  ("below the configured level are dropped" = lower-importance / higher-weight messages are dropped.)
  At default `"error"` only errors emit; that IS the "disabled by default" behavior (PRD §36).
- ❌ Don't invent a 6th `"disabled"` level — `DiagnosticsLevel` has exactly 5 members (P1.M1.T2.S1).
  "Disabled" ≡ the default `"error"` level.
- ❌ Don't build the JSON line as `{ ts, level, event, ...fields }` (caller fields would clobber
  reserved keys). Spread `fields` FIRST, then set `ts`/`level`/`event` authoritatively.
- ❌ Don't add runtime secret-scrubbing of `fields`. Privacy is a JSDoc contract + caller discipline
  (PRD Appendix H); runtime scrubbing risks false positives on legitimate values.
- ❌ Don't call `createDiagnostics(...)` from `src/index.ts` — the factory wiring is P1.M1.T5.S1.
- ❌ Don't return a non-frozen object — it's shared by reference across all modules; freeze it.
- ❌ Don't modify `package.json`, `tsconfig.json`, `.gitignore`, `src/config/index.ts`, or `src/index.ts`.

---

## Confidence Score: **9/10**

This is a small, deterministic, near-pure module with the complete reference implementation and full
test suite inlined, the one genuinely ambiguous contract point (level semantics) explicitly resolved
with the exact weight table, and all build/test/scope gates verified against the live repo (`npx bun
run typecheck` exits 0; `npx bun test` = 32 pass; `npx bun run build` emits dist). Residual risk is
minimal: (a) the level-ordering interpretation is documented as a grounded decision; (b) the privacy
contract is Mode A (docs) by explicit instruction — no runtime enforcement to get wrong. No behavioral
coupling to unbuilt modules: consumers receive an injected instance later (P1.M1.T4.S1+); this PRP only
ships the factory + interfaces.
