# Research Note — P2.M2.T3.S1 Wiring Findings

Scope: thread `reasoningInjection` + `reasoningInjectionDelimiter` from the decorator through the
StreamProxy constructor into the self-created RequestBuilder. Internal constructor parameter
threading only — no external libraries, no new patterns, no online research required.

## 1. StreamProxy constructor (src/provider/proxy.ts)

- **Constructor signature**: line 256. Current params (11 total, positional):
  `model, context, options, upstreamStreamFn, diagnostics, controller?, buffer?,
  abortTimeoutMs = DEFAULT_CONFIG.transitionTimeoutMs, requestBuilder?,
  replacementStartupTimeoutMs = DEFAULT_CONFIG.replacementStartupTimeoutMs, coordinator?`
- **Last param**: line 268 — `coordinator?: TransitionCoordinator, // P1.M7.T3.S1 — optional session coordinator`
- **Field declaration**: line 120 — `private readonly _requestBuilder: RequestBuilder;`
  (JSDoc above it says "the proxy self-creates `new RequestBuilder(diagnostics)`" — MUST be updated.)
- **Forward call**: line 276 — `this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics);`
- **`this._coordinator = coordinator;`**: line 278 (last body assignment — new assignments go nearby).

**Imports already present** (no new imports needed in proxy.ts):
- `import { RequestBuilder } from "../request/builder";` (~line 44)
- `import { DEFAULT_CONFIG } from "../config";` (~line 50)

## 2. RequestBuilder constructor (CONSUMED — defined by P2.M2.T2.S1 PRP)

Per the T2 PRP contract (logic step a), after T2 lands the constructor is:
```ts
constructor(
  private readonly diagnostics: Diagnostics,
  private readonly _reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
  private readonly _delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
) {}
```
=> The forward call `new RequestBuilder(diagnostics, reasoningInjection, delimiter)` is positionally
correct: (Diagnostics, boolean, {open,close}).

## 3. Decorator call site (src/provider/decorator.ts) — the ONLY production construction

- Line 201: `const proxy = new StreamProxy(`
- Line 204: `this.config.transitionTimeoutMs, undefined, this.config.replacementStartupTimeoutMs,`
- Line 205: `this._coordinator,`  ← last arg; append the two new config args AFTER this.
- `this.config` is already a `Config` field; `Config.reasoningInjection` / `reasoningInjectionDelimiter`
  exist (P2.M1.T1.* Complete). No new import in decorator.ts.

Confirmed via grep: `grep -rn "new StreamProxy(" src/` → ONLY `src/provider/decorator.ts:201`.

## 4. Backward-compatibility of existing tests (load-bearing)

`grep -c "new StreamProxy(" tests/*.test.ts` shows ~60 constructions across ~14 files. ALL pass
≤11 positional args. Appending params 12-13 with `DEFAULT_CONFIG` defaults preserves EVERY existing
call unchanged (TypeScript default params). Tests that inject a `requestBuilder` (param 9) rely on
the DI seam: `requestBuilder ?? new RequestBuilder(...)` → the injected builder wins; the two new
params are unused for that request (item logic step d). No test file is modified by this subtask.

## 5. tsconfig finding (load-bearing for the "store fields" decision)

`tsconfig.json`: `strict: true` but **`noUnusedLocals` and `noUnusedParameters` are NOT set**.
Therefore storing `_reasoningInjection` / `_delimiter` as private readonly fields (even though the
proxy never reads them post-construction) does NOT produce a TS6133 unused-error → typecheck stays
green. This makes the item description's "Store as private readonly fields and forward" literal and
safe. (If noUnusedLocals were on, the fields would have to be read or dropped — not the case here.)

## 6. Validation commands (verified from package.json via prior PRPs)

- `bun run typecheck` → `tsc --noEmit` (covers `src/` only; tsconfig EXCLUDES `tests`).
- `bun test` → full suite.
- No ruff/mypy/eslint/biome (TypeScript+Bun project — those are template artifacts).

## 7. Directive contract reference

`plan/002_de5c3dc3c05f/architecture/directive_design.md §7 "Proxy Wiring"` is the authoritative
wiring spec:
- params 12-13: `reasoningInjection` + `delimiter` with `DEFAULT_CONFIG` defaults.
- forward: `this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics, reasoningInjection, delimiter);`
- decorator passes: `this.config.reasoningInjection`, `this.config.reasoningInjectionDelimiter`.
