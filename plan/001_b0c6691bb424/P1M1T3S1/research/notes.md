# Research Notes — P1.M1.T3.S1: Structured logger with privacy controls

## Dependency contract (P1.M1.T2.S1 Config — IMPLEMENTED in parallel, treat as contract)
- File: `src/config/index.ts`. Import shape from a sibling src module: `import type { DiagnosticsLevel } from "../config";`
- `export type DiagnosticsLevel = "error" | "warn" | "info" | "debug" | "trace";`
- `Config.diagnosticsLevel: DiagnosticsLevel` (default `"error"`, validated case-sensitive, frozen).
- Config is PURE (no Pi imports); importing its *type* into diagnostics keeps diagnostics pure too.

## Diagnostics contract (architecture/module_contracts.md)
```
trace/debug/info/warn/error(event: string, fields?: Record<string, unknown>): void
Privacy (PRD §58, Appendix H):
  MAY LOG: provider name, model id, transition id, timing, event counts, state transitions
  NEVER LOG: prompt text, reasoning text, assistant output, API keys, tool arguments
```

## Item contract specifics
- Factory: `createDiagnostics(level: DiagnosticsLevel)` → object w/ trace/debug/info/warn/error.
- Each method `(event: string, fields?: Record<string, unknown>)`, structured JSON line.
- Messages below configured level silently dropped.
- console.error for warn/error; console.log for debug/info/trace — OR configurable sink.
- Level ordering: error < warn < info < debug < trace.
- Created once in extension factory, passed by reference (wiring = P1.M1.T5.S1, NOT here).
- DOCS Mode A: JSDoc privacy rules, reference PRD Appendix H.

## PRD authority
- §36 Diagnostics Module: Disabled by default; modes Disabled/Errors/Verbose/Trace;
  "Verbose logging shall never modify runtime behavior." (4 display modes ≈ our 5 typed levels;
  reconciliation note needed so implementer isn't confused — logger operates on the 5-level union.)
- §57 Logging Specification: Trace=state transitions; Debug=lifecycle milestones; Info=successful
  transitions; Warning=recoverable failures; Error=fatal failures. "Logs shall be structured.
  No free-form parsing shall be required." → JSON.
- Appendix H §Logging Rules:
  MAY LOG: provider name, model identifier, transition ID, timing metrics, event counts,
           state transitions, error categories.
  NEVER LOG: prompt text, assistant output, reasoning output, API keys, authorization headers,
             tool arguments, tool outputs.
- Appendix M Trace Levels (Error/Warning/Info/Debug/Trace) + Trace Correlation: every transition
  log includes transitionId, streamId, provider, model, currentState, timestamp. → Logger auto-
  injects `ts`; caller supplies correlation fields. Document this split.

## Level-ordering semantics (resolved)
Weights: error=0, warn=1, info=2, debug=3, trace=4. Emit iff `weight(msg) <= weight(threshold)`.
- "Messages below the configured level are silently dropped" = messages of LOWER importance
  (further right in `error<warn<info<debug<trace`) than the threshold are dropped.
- default "error" → only error emits (matches §36 "Disabled by default": only fatal).
- "trace" → all emit.

## Tooling verified in THIS environment
- `bun` is a local devDep, NOT on PATH. Use `npx bun ...` / `npx bunx tsc`.
- `npx bun run typecheck` (= tsc --noEmit) → exit 0. `npx bun test` → 32 pass. `npx bun run build` → emits dist.
- Tests use `import { describe, test, expect } from "bun:test"`.
- tsconfig: strict, ES2022, bundler, isolatedModules, exclude tests, outDir dist, rootDir src.

## Design decisions
1. Placement: `src/diagnostics/index.ts` (replace `.gitkeep`); `tests/diagnostics.test.ts`.
2. JSON line order: `{ ...fields, ts, level, event }` — reserved keys (ts/level/event) set LAST so
   they are authoritative (a caller cannot accidentally clobber level). Single line, JSON.stringify.
3. Sink = `{ log(line), error(line) }`; default wraps console.log/console.error. Inject for tests.
4. Returned Diagnostics object is `Object.freeze`d (shared by reference across all modules).
5. Privacy enforced via JSDoc (Mode A = docs), NOT runtime filtering (would risk false positives on
   legitimate fields). NO @earendil-works imports (keeps module unit-testable / pure-ish).
6. Do NOT wire createDiagnostics into src/index.ts — that's P1.M1.T5.S1 (factory init).
