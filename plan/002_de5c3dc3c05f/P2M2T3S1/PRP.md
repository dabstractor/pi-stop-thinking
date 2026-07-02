# PRP — P2.M2.T3.S1: Thread config fields through StreamProxy ctor + update decorator call site

---

## Goal

**Feature Goal**: Complete the §53 Ephemeral Execution Directive's config plumbing (ADR-006 / PRD §53)
by threading the two directive config fields — `reasoningInjection` (bool) and
`reasoningInjectionDelimiter` (`{ open; close }`) — from the **ProviderDecorator**, through the
**StreamProxy** constructor (two new appended positional params), into the **self-created
RequestBuilder**. After this, a *production* replacement request (where no `RequestBuilder` is
dependency-injected) constructs its builder with the *live* config values, so the §53 directive is
actually governed by user/env configuration. The existing DI seam (the optional `requestBuilder`
constructor param) is preserved unchanged: when a test injects a builder, it wins directly and the
two new params are inert for that request.

**Deliverable**: Two MODIFIED source files. No new files. No test files modified.

1. **`src/provider/proxy.ts`** — the `StreamProxy` class:
   - constructor gains **2 appended params** (positions 12 & 13), each with a `DEFAULT_CONFIG` default;
   - **2 new private readonly fields** (`_reasoningInjection`, `_delimiter`) declared + assigned;
   - the self-creation line forwards the new params: `new RequestBuilder(diagnostics, reasoningInjection, delimiter)`;
   - the `_requestBuilder` field JSDoc is updated (it currently claims the self-creation is `new RequestBuilder(diagnostics)`).
2. **`src/provider/decorator.ts`** — `wrapperStreamSimple`'s eligible branch: the single `new StreamProxy(...)`
   construction gains **2 trailing positional args** reading `this.config.reasoningInjection` and
   `this.config.reasoningInjectionDelimiter`.

**No new imports** are required in either file — `proxy.ts` already imports `RequestBuilder` and
`DEFAULT_CONFIG`; `decorator.ts` already holds a `Config`-typed `this.config` whose two new fields
exist (P2.M1.T1.* Complete).

**Success Definition**:
- `bun run typecheck` (`tsc --noEmit`, covers `src/` only) passes with zero errors.
- `bun test` (full suite) passes — every existing proxy/decorator test stays green unchanged
  (appended optional params + the `requestBuilder ?? ...` DI seam preserve all ~60 existing
  `new StreamProxy(...)` call sites).
- Production path: `ProviderDecorator.wrapperStreamSimple` (eligible branch) passes
  `this.config.reasoningInjection` + `this.config.reasoningInjectionDelimiter` positionally into
  `StreamProxy`, which (when no `requestBuilder` is injected) seeds `new RequestBuilder(diagnostics,
  reasoningInjection, delimiter)` with those exact values.
- DI-seam path preserved: when a `requestBuilder` IS injected, `requestBuilder ?? new RequestBuilder(...)`
  selects the injected builder; the two new params are never consumed for that request (backward compat).
- Constructor param count goes 11 → 13; the two new params are **trailing** (after `coordinator?`) so
  every existing positional call (≤11 args) compiles and behaves identically.

## User Persona (if applicable)

**Target User**: Downstream developers (the P2.M3.T1.S2 test author; future maintainers). Internal
wiring — no end-user, config, or API surface change in this subtask.
**Use Case**: The config fields added in P2.M1.T1.S1 must *reach* the `RequestBuilder.buildReplacement`
gate implemented in P2.M2.T2.S1. Without this subtask the proxy self-creates `new RequestBuilder(diagnostics)`
and the gate always sees the `DEFAULT_CONFIG` value, so a user setting
`PI_STOP_THINKING_REASONING_INJECTION=false` would have NO effect on the replacement request.
**User Journey**: env-var / partial config → `loadConfigFromEnv` (P2.M1.T1.S2) → `Config` object →
`ProviderDecorator.config` → `StreamProxy` ctor (THIS subtask) → `RequestBuilder` ctor (P2.M2.T2.S1) →
`buildReplacement` gate (P2.M2.T2.S1) → directive injected or omitted.
**Pain Points Addressed**: Closes the "config defined but never read by the production replacement
path" gap — the last mechanical hop before the directive is genuinely config-driven end-to-end.

## Why

- **Business value**: This is the wiring hop that makes ADR-006 / §53 *actually configurable*. Together
  with P2.M2.T2.S1 (the gate) it satisfies INV-013 (reasoning reused, not discarded) in a way the user
  can toggle. It is intentionally tiny and mechanical to keep the blast radius minimal.
- **Integration** (P2.M2 chain position):
  - **Consumes P2.M1.T1.S1/S2** (Complete): the `Config.reasoningInjection` + `reasoningInjectionDelimiter`
    fields and `DEFAULT_CONFIG` values that become the new params' defaults and the decorator's source.
  - **Consumes P2.M2.T2.S1** (being implemented in parallel): the `RequestBuilder` constructor that now
    accepts `(diagnostics, _reasoningInjection, _delimiter)`. The forward call
    `new RequestBuilder(diagnostics, reasoningInjection, delimiter)` is positionally correct against
    that signature. T2 is independently shippable WITHOUT T3 (proxy.ts:276 keeps calling
    `new RequestBuilder(diagnostics)` and the builder falls back to its own `DEFAULT_CONFIG` defaults) —
    T3 makes the *live* config reach it.
  - **Consumed by P2.M3.T1.S2** (planned): the directive/invariant tests will construct a
    `RequestBuilder` directly with explicit args (not via the proxy), so they are unaffected by this
    wiring; this subtask is what makes the *integration* (decorator→proxy→builder) testable end-to-end.
- **Problems solved**: Removes the final "config defined but not plumbed to the production replacement
  request" gap (architecture/current-impl-state.md §4: "Config threading: add params 12-13 ...").

## What

User-visible behavior: none (internal constructor threading, no config/API/doc surface change — see
item DOCS note: "none — this is internal wiring"). The observable wiring contract:

1. **StreamProxy constructor** (src/provider/proxy.ts, line 256) gains two trailing params with
   `DEFAULT_CONFIG` defaults, mirroring the existing scalar-default pattern of `abortTimeoutMs` /
   `replacementStartupTimeoutMs`:
   ```ts
   constructor(
     model: Model<Api>,
     context: Context,
     options: SimpleStreamOptions,
     upstreamStreamFn: ApiStreamSimpleFunction,
     diagnostics: Diagnostics,
     controller?: TransitionController,
     buffer?: ReasoningBuffer,
     abortTimeoutMs: number = DEFAULT_CONFIG.transitionTimeoutMs,
     requestBuilder?: RequestBuilder,
     replacementStartupTimeoutMs: number = DEFAULT_CONFIG.replacementStartupTimeoutMs,
     coordinator?: TransitionCoordinator,
     // NEW (P2.M2.T3.S1) — directive config forwarded to the self-created RequestBuilder:
     reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
     delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
   )
   ```
2. **Two private readonly fields** `_reasoningInjection` + `_delimiter` are declared (near `_requestBuilder`)
   and assigned in the body, following the StreamProxy's existing `param foo → field _foo` convention.
3. **Forward** (src/provider/proxy.ts, line 276): the self-creation now passes the two params:
   ```ts
   this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics, reasoningInjection, delimiter);
   ```
4. **Decorator call site** (src/provider/decorator.ts, line 201–206, `wrapperStreamSimple` eligible
   branch) appends two trailing positional args reading the live config:
   ```ts
   const proxy = new StreamProxy(
     model, context, options ?? {}, originalStreamSimple, this.diagnostics,
     undefined, undefined,
     this.config.transitionTimeoutMs, undefined, this.config.replacementStartupTimeoutMs,
     this._coordinator,
     this.config.reasoningInjection,          // NEW (P2.M2.T3.S1)
     this.config.reasoningInjectionDelimiter, // NEW (P2.M2.T3.S1)
   );
   ```
5. **DI seam preserved (CRITICAL)**: the `requestBuilder ?? new RequestBuilder(...)` nullish-coalescing
   is untouched. An injected `requestBuilder` still wins; the two new params then seed nothing for that
   request. This is exactly the backward-compat guarantee the item's logic step (d) demands.

### Success Criteria

- [ ] StreamProxy constructor has exactly 13 params; params 12-13 are `reasoningInjection` + `delimiter`
      with `DEFAULT_CONFIG.reasoningInjection` / `DEFAULT_CONFIG.reasoningInjectionDelimiter` defaults.
- [ ] Two private readonly fields `_reasoningInjection` + `_delimiter` declared and assigned.
- [ ] Self-creation forwards both: `new RequestBuilder(diagnostics, reasoningInjection, delimiter)`.
- [ ] `_requestBuilder` field JSDoc updated (no longer claims `new RequestBuilder(diagnostics)`).
- [ ] Decorator's eligible-branch `new StreamProxy(...)` passes `this.config.reasoningInjection` and
      `this.config.reasoningInjectionDelimiter` as the final two positional args.
- [ ] `requestBuilder ?? new RequestBuilder(...)` DI seam unchanged (injected builder still wins).
- [ ] No new imports added to either file (both already have what they need).
- [ ] No test file is modified.
- [ ] `bun run typecheck` passes; `bun test` (full suite) passes.

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes** — this PRP names the two exact files, quotes the exact current constructor
signature + body assignment + field JSDoc + decorator call site verbatim WITH line numbers, gives the
exact target code for each of the four edits, confirms which imports already exist (so none are
added), proves every existing test stays green (appended optional params + DI seam), cites the
authoritative wiring contract (`directive_design.md §7`) and the consumed RequestBuilder signature
(`P2M2T2S1/PRP.md`), and states the verified validation commands. Scope boundaries (config = P2.M1
done, builder gate = P2.M2.T2.S1, directive tests = P2.M3.T1.S2) are explicit to prevent over-reaching.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: src/provider/proxy.ts
  why: THE FIRST file to modify. Contains the StreamProxy class. Constructor at line 256; last param
        `coordinator?` at line 268; `_requestBuilder` field at line 120 (JSDoc above MUST be updated);
        self-creation forward call at line 276; `this._coordinator = coordinator;` at line 278.
  pattern: Existing scalar-default params: `abortTimeoutMs = DEFAULT_CONFIG.transitionTimeoutMs` and
        `replacementStartupTimeoutMs = DEFAULT_CONFIG.replacementStartupTimeoutMs` — MIRROR this
        pattern (DEFAULT_CONFIG default, plain param, `this._foo = foo` body assignment, `private
        readonly _foo` field).
  gotcha: `RequestBuilder` AND `DEFAULT_CONFIG` are ALREADY imported (lines ~44 and ~50). Do NOT add
        imports. Do NOT touch the constructor body's other assignments, `_internalAbort`, or `run()`.

- file: src/provider/decorator.ts
  why: THE SECOND file to modify. The ONLY production `new StreamProxy(...)` call is at line 201, in
        `wrapperStreamSimple`'s eligible branch; `this._coordinator,` is the last arg (line 205).
  pattern: The existing construction already reads scalar config positionally
        (`this.config.transitionTimeoutMs`, `this.config.replacementStartupTimeoutMs`) — APPEND the two
        new config reads in the same style after `this._coordinator,`.
  gotcha: `this.config` is already a `Config`-typed field; both new fields exist on it (P2.M1.T1.*).
        Do NOT add imports. Do NOT touch the non-eligible branches, `wrapperStream`, `initialize`, or
        `shutdown`.

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: THE authoritative wiring contract for this exact delta.
  section: "§7 Proxy Wiring" — specifies params 12-13 (`reasoningInjection` + `delimiter` with
        DEFAULT_CONFIG defaults), the forward line, and the decorator args. Implement verbatim.

- docfile: plan/002_de5c3dc3c05f/P2M2T2S1/PRP.md
  why: Defines the RequestBuilder constructor this task forwards INTO (the consumed contract).
  section: "Implementation Tasks > Task 3 (constructor)" + "Implementation Patterns & Key Details" —
        confirms the builder ctor is `(diagnostics, _reasoningInjection = DEFAULT_CONFIG.*,
        _delimiter = DEFAULT_CONFIG.*)`, so `new RequestBuilder(diagnostics, reasoningInjection,
        delimiter)` is positionally correct (Diagnostics, boolean, {open,close}).

- docfile: plan/002_de5c3dc3c05f/architecture/current-impl-state.md
  why: Confirms the current 11-param ctor + line-276 forward + the decorator call site to change.
  section: "§4 src/provider/proxy.ts — builder call site" + "§1" (builder ctor reference).

- file: src/config/index.ts
  why: READ-ONLY. Confirms DEFAULT_CONFIG.reasoningInjection === true and DEFAULT_CONFIG
        .reasoningInjectionDelimiter === { open: "---\n[Prior reasoning captured before you were asked
        to stop thinking]", close: "[End of prior reasoning]\n---" }. Already Complete (P2.M1.T1.*).
  gotcha: DEFAULT_CONFIG is exported as a frozen runtime VALUE (`export const DEFAULT_CONFIG: Config = …`).
        proxy.ts ALREADY value-imports it — no change needed.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
src/
  provider/proxy.ts       # <-- MODIFY: ctor +2 params, +2 fields, forward call, _requestBuilder JSDoc.
  provider/decorator.ts   # <-- MODIFY: eligible-branch new StreamProxy(...) +2 trailing args.
  request/builder.ts      # CONSUMED (P2.M2.T2.S1): ctor accepts (diag, _reasoningInjection, _delimiter). NOT touched here.
  config/index.ts         # READ-ONLY: DEFAULT_CONFIG.reasoningInjection / reasoningInjectionDelimiter (P2.M1.T1.* Complete)
tests/
  stream-proxy-*.test.ts  # NOT modified (~60 constructions, all ≤11 args → preserved by appended defaults)
  provider-decorator.test.ts  # NOT modified
package.json              # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit
tsconfig.json             # strict:true; noUnusedLocals/noUnusedParameters OFF; EXCLUDES "tests"
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. Two MODIFIED files:
src/provider/proxy.ts     # ctor: +2 trailing params (reasoningInjection, delimiter) w/ DEFAULT_CONFIG defaults;
                          # +2 private readonly fields (_reasoningInjection, _delimiter) declared+assigned;
                          # forward: new RequestBuilder(diagnostics, reasoningInjection, delimiter);
                          # _requestBuilder field JSDoc updated to mention the forwarded directive config.
src/provider/decorator.ts # wrapperStreamSimple eligible branch: new StreamProxy(...) +2 trailing args
                          # (this.config.reasoningInjection, this.config.reasoningInjectionDelimiter).
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (param placement — APPEND, do not insert): the two new params MUST be positions 12 & 13,
// i.e. AFTER `coordinator?` (param 11). Inserting them anywhere earlier would silently shift the
// meaning of every existing positional arg (including the decorator's `this._coordinator` and every
// test that passes `requestBuilder`/`replacementStartupTimeoutMs` positionally). Appending preserves
// all ~60 existing `new StreamProxy(...)` call sites unchanged. (directive_design.md §7 is explicit:
// params 12-13.)

// CRITICAL (DEFAULT_CONFIG defaults are RUNTIME values, but NO new import): proxy.ts already value-
// imports DEFAULT_CONFIG (`import { DEFAULT_CONFIG } from "../config";`). Use it directly in the new
// default param expressions (`= DEFAULT_CONFIG.reasoningInjection`). Do NOT `import type` it (would
// erase the runtime default). No import edit is needed — it is already a value import.

// CRITICAL (DI seam untouched): the forward is `requestBuilder ?? new RequestBuilder(diagnostics,
// reasoningInjection, delimiter)`. The `??` MUST stay — when a test injects `requestBuilder` (param 9),
// it wins and the two new params are inert for that request. This is the item's logic step (d)
// backward-compat guarantee. Do NOT restructure into `new RequestBuilder(...)` unconditionally.

// CRITICAL (no new imports in decorator.ts): `this.config` is already `Config`-typed and the two
// fields already exist on it (P2.M1.T1.*). Reference `this.config.reasoningInjection` and
// `this.config.reasoningInjectionDelimiter` directly. Do NOT add an import.

// CRITICAL (delimiter param type): the param type is `{ open: string; close: string }` (matches
// Config.reasoningInjectionDelimiter and RequestBuilder's `_delimiter`). Do NOT widen to `any` or a
// generic record — keep the exact structural type so tsc verifies the shape end-to-end.

// CRITICAL (field naming convention): StreamProxy uses `param foo` → `field _foo` (e.g.
// abortTimeoutMs→_abortTimeoutMs, coordinator→_coordinator). Name the new fields `_reasoningInjection`
// and `_delimiter` and assign `this._reasoningInjection = reasoningInjection;` /
// `this._delimiter = delimiter;` in the body. (noUnusedLocals is OFF in tsconfig, so storing fields the
// proxy doesn't read post-construction does NOT trip TS6133 — typecheck stays green.)

// CRITICAL (JSDoc accuracy): the `_requestBuilder` field JSDoc (line ~116-120) currently states the
// proxy "self-creates `new RequestBuilder(diagnostics)`". After the forward change it self-creates
// `new RequestBuilder(diagnostics, reasoningInjection, delimiter)`. Update that JSDoc so it does not
// become false documentation. Do NOT touch other field JSDocs.

// CRITICAL (scope): do NOT touch src/request/builder.ts (gate = P2.M2.T2.S1), src/config (P2.M1 done),
// the buffer, run(), _launchReplacement, or ANY test file (directive tests = P2.M3.T1.S2). This
// subtask is wiring only — two files, four logical edits.
```

## Implementation Blueprint

### Data models and structure

No new data models. The two values threaded are existing types already defined/importable:

```typescript
// From ../config (DEFAULT_CONFIG — already value-imported in proxy.ts):
export const DEFAULT_CONFIG: Config;  // .reasoningInjection: boolean === true
                                       // .reasoningInjectionDelimiter: { open: string; close: string }

// Config field shapes (already on decorator's this.config — P2.M1.T1.* Complete):
reasoningInjection: boolean;
reasoningInjectionDelimiter: { open: string; close: string };

// Consumed RequestBuilder constructor (P2.M2.T2.S1 — NOT modified here, only called):
new RequestBuilder(diagnostics: Diagnostics, reasoningInjection: boolean, delimiter: { open: string; close: string });
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — constructor params (APPEND, do not insert)
  - FIND: the constructor signature (line 256). Its current last param (line 268) is:
        coordinator?: TransitionCoordinator, // P1.M7.T3.S1 — optional session coordinator
  - APPEND two new params IMMEDIATELY AFTER that line (positions 12 & 13), before the closing `)`:
        // NEW (P2.M2.T3.S1) — directive config forwarded to the self-created RequestBuilder (PRD §53):
        reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
        delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
  - MIRROR pattern: the existing `abortTimeoutMs = DEFAULT_CONFIG.transitionTimeoutMs` and
        `replacementStartupTimeoutMs = DEFAULT_CONFIG.replacementStartupTimeoutMs` scalar-default params.
  - GOTCHA: APPEND after `coordinator?` — NEVER insert before it (would break all positional callers).

Task 2: MODIFY src/provider/proxy.ts — declare the two private readonly fields
  - FIND: the `_requestBuilder` field declaration (line 120):
        private readonly _requestBuilder: RequestBuilder;
  - ADD two field declarations adjacent to it (after it is natural — they are directive-config siblings):
        /** Directive-injection toggle forwarded to the self-created RequestBuilder (PRD §53 / P2.M2.T3.S1).
         *  Inert when a `requestBuilder` is dependency-injected (DI seam wins). */
        private readonly _reasoningInjection: boolean;
        /** Directive open/close fence forwarded to the self-created RequestBuilder (PRD §53 h3.71 / P2.M2.T3.S1).
         *  Inert when a `requestBuilder` is dependency-injected. */
        private readonly _delimiter: { open: string; close: string };
  - NAMING: `_reasoningInjection` / `_delimiter` (StreamProxy `param foo → field _foo` convention).

Task 3: MODIFY src/provider/proxy.ts — body assignments + forward call
  - FIND: line 276:
        this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics);
    and line 278:
        this._coordinator = coordinator;
  - REPLACE the forward line (276) WITH (forwards the two new params into the self-created builder):
        this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics, reasoningInjection, delimiter);
  - ADD two assignments near the other field assignments (e.g. right after the forward line or after
        `this._coordinator = coordinator;`):
        this._reasoningInjection = reasoningInjection;
        this._delimiter = delimiter;
  - GOTCHA: keep the `??` nullish-coalescing — the injected `requestBuilder` MUST still win (DI seam).

Task 4: MODIFY src/provider/proxy.ts — update the _requestBuilder field JSDoc
  - FIND: the JSDoc above line 120, which currently reads (paraphrased) "Optional DI; production omits
        and the proxy self-creates `new RequestBuilder(diagnostics)`."
  - UPDATE it to reflect the new forward, e.g.:
        "Optional DI; production omits and the proxy self-creates
         `new RequestBuilder(diagnostics, reasoningInjection, delimiter)` (P2.M2.T3.S1), seeding the
         §53 directive gate with the live config. When a builder is injected, the config params are inert."
  - GOTCHA: this is the ONLY JSDoc that must change. Do NOT touch the class-level JSDoc or other fields.

Task 5: MODIFY src/provider/decorator.ts — append the two config args to the StreamProxy construction
  - FIND: `wrapperStreamSimple`'s eligible branch, line 201:
        const proxy = new StreamProxy(
          model, context, options ?? {}, originalStreamSimple, this.diagnostics,
          undefined, undefined,
          this.config.transitionTimeoutMs, undefined, this.config.replacementStartupTimeoutMs,
          this._coordinator,
        );
  - REPLACE the trailing `this._coordinator,` + closing `)` WITH:
        this._coordinator,
        this.config.reasoningInjection,            // NEW (P2.M2.T3.S1) — directive config → RequestBuilder
        this.config.reasoningInjectionDelimiter,
        );
  - FOLLOW pattern: the SAME construction already reads scalar config positionally
        (transitionTimeoutMs / replacementStartupTimeoutMs) — mirror that style.
  - GOTCHA: append AFTER `this._coordinator` (param 11) so the args land in positions 12 & 13, matching
        the new ctor param order. `this.config` is already `Config`-typed; no import edit.

Task 6 (NO-OP for this subtask): tests belong to P2.M3.T1.S2
  - Do NOT add/modify tests here. Only RUN the existing suite to confirm it stays green (Validation
        Loop). The directive/invariant integration tests are P2.M3.T1.S2; existing proxy/decorator
        tests are preserved by appended defaults + the DI seam.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: scalar-default constructor param mirroring abortTimeoutMs / replacementStartupTimeoutMs.
constructor(
  /* …existing 11 params unchanged… */
  coordinator?: TransitionCoordinator,
  // NEW (P2.M2.T3.S1):
  reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection,
  delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter,
) {
  /* …existing assignments… */
  // DI seam PRESERVED: injected builder wins; new params only seed the default creation.
  this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics, reasoningInjection, delimiter);
  this._reasoningInjection = reasoningInjection;   // stored per item contract (inert when builder injected)
  this._delimiter = delimiter;
  /* …existing fan-in of options.signal + void this.run(…)… */
}

// PATTERN: decorator reads live config positionally (same as transitionTimeoutMs).
const proxy = new StreamProxy(
  model, context, options ?? {}, originalStreamSimple, this.diagnostics,
  undefined, undefined,
  this.config.transitionTimeoutMs, undefined, this.config.replacementStartupTimeoutMs,
  this._coordinator,
  this.config.reasoningInjection,          // NEW — position 12
  this.config.reasoningInjectionDelimiter, // NEW — position 13
);

// CRITICAL: the THREE preservation guarantees (all hold after this change):
//   (1) appended params 12-13 with DEFAULT_CONFIG defaults → every existing `new StreamProxy(…)` call
//       (≤11 args, incl. all ~60 test constructions) compiles + behaves identically;
//   (2) `requestBuilder ?? new RequestBuilder(…)` → an injected builder still wins (DI seam);
//   (3) no new imports → no module-resolution / isolatedModules surprises.
```

### Integration Points

```yaml
DATABASE: none.

CONFIG: READ via the decorator's existing `this.config` (Config-typed). The two fields
  (reasoningInjection, reasoningInjectionDelimiter) are surfaced by P2.M1.T1.S1/S2 (Complete). This
  subtask only PLUMBS them; it does NOT define, validate, or env-parse them. No config edit.

ROUTES/SERVICES: none. The only production construction (decorator.ts:201) and the proxy self-creation
  (proxy.ts:276) are the two integration points modified. The builder's buildReplacement() call site
  (proxy.ts:890 inside _launchReplacement) is UNCHANGED — its 4-arg signature and behavior are owned by
  P2.M2.T2.S1; the builder the proxy HOLDS now simply carries the live config.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# TypeScript + Bun project. There is NO ruff/mypy/eslint/biome — do NOT run them (template artifacts).
bun run typecheck          # = tsc --noEmit  (covers src/ only; tsconfig EXCLUDES tests)
# Expected: zero errors. Watch for:
#   - new params are APPENDED after `coordinator?` (else every positional caller's args shift → many errors);
#   - `delimiter` param type is `{ open: string; close: string }` (matches Config + RequestBuilder);
#   - `new RequestBuilder(diagnostics, reasoningInjection, delimiter)` arg order matches the builder ctor
#     (Diagnostics, boolean, {open,close}) defined by P2.M2.T2.S1 — if T2 has not landed yet, this call will
#     error "Expected 1 arguments, but got 3" until T2 merges. (T2 is the consumed contract; this is expected
#     ordering — T3 is merged after T2.)
#   - noUnusedLocals is OFF, so the stored `_reasoningInjection` / `_delimiter` fields do NOT error even
#     though the proxy never reads them post-construction.
```

> **Merge-order note**: P2.M2.T2.S1 (the RequestBuilder ctor change) is the consumed dependency. If you
> typecheck T3 in isolation BEFORE T2 lands, `new RequestBuilder(diagnostics, reasoningInjection,
> delimiter)` will fail ("Expected 1 arguments, but got 3"). That is expected and resolves when T2
> merges. The decorator/proxy edits themselves are independently correct.

### Level 2: Unit Tests (Component Validation)

```bash
# This subtask adds NO tests and modifies NONE. Run the EXISTING suites to confirm they stay green.
bun test tests/stream-proxy.test.ts tests/stream-proxy-replacement.test.ts tests/stream-proxy-lifecycle.test.ts
bun test tests/provider-decorator.test.ts
# Expected: all pass unchanged. Appended optional params (12-13) + the `requestBuilder ?? …` DI seam
# preserve every existing construction and every injected-builder test.

bun test
# Expected: full suite passes (only proxy.ts + decorator.ts changed; no behavioral change to existing paths).
```

### Level 3: Integration Testing (System Validation)

```bash
# No network/streaming. Smoke-check the config plumbing end-to-end with a hand-built decorator + proxy
# (uses the REAL Config/DEFAULT_CONFIG; no provider). This verifies config → proxy → builder wiring:
bun -e '
import { ProviderDecorator } from "./src/provider/decorator.ts";
import { StreamProxy } from "./src/provider/proxy.ts";
import { RequestBuilder } from "./src/request/builder.ts";
import { DEFAULT_CONFIG, loadConfig } from "./src/config/index.ts";
const diag = { trace(){}, debug(){}, info(){}, warn(){}, error(){} };

// (1) Production path: decorator passes LIVE config (overridden to false + custom fence) → proxy → builder.
//     Inject a capturing RequestBuilder subclass to read what the proxy would have created by default.
let captured = null;
class CapturingBuilder extends RequestBuilder {
  constructor(d, ri, dl) { super(d, ri, dl); captured = { ri, dl }; }
}
// Build a proxy with NO injected builder but with the live config values positionally, then assert the
// proxy would forward them: emulate the decorator's positional call.
const cfg = loadConfig({ reasoningInjection: false, reasoningInjectionDelimiter: { open: "<<<", close: ">>>" } });
const model = { id:"m", api:"openai-completions", provider:"zai", reasoning:true };
const mockUpstream = async function*(){ yield { type:"done", message:{ id:"x", role:"assistant", content:[], model:{ id:"m", api:"openai-completions" } } }; };
const p = new StreamProxy(model, {messages:[]}, {}, mockUpstream, diag,
  undefined, undefined, cfg.transitionTimeoutMs,
  new CapturingBuilder(diag, cfg.reasoningInjection, cfg.reasoningInjectionDelimiter), // injected (DI seam)
  cfg.replacementStartupTimeoutMs, undefined,
  cfg.reasoningInjection, cfg.reasoningInjectionDelimiter);
console.log(captured && captured.ri===false && captured.dl.open==="<<<" && captured.dl.close===">>>" ? "ok:builder-seeded-from-config" : "FAIL:"+JSON.stringify(captured));

// (2) DI seam: when a builder is injected, it wins regardless of the trailing config params.
let diWins = false;
class MarkerBuilder extends RequestBuilder { constructor(d){ super(d); diWins = true; } }
const p2 = new StreamProxy(model, {messages:[]}, {}, mockUpstream, diag,
  undefined, undefined, DEFAULT_CONFIG.transitionTimeoutMs,
  new MarkerBuilder(diag),  // injected → must be the one used
  DEFAULT_CONFIG.replacementStartupTimeoutMs, undefined,
  false, { open:"x", close:"y" });
console.log(diWins ? "ok:di-seam-builder-wins" : "FAIL:di-seam-broken");

// (3) Appended defaults: a ≤11-arg construction still compiles + behaves (DEFAULT_CONFIG directive).
const p3 = new StreamProxy(model, {messages:[]}, {}, mockUpstream, diag);  // 5 args only
console.log(p3 && p3.output ? "ok:minimal-ctor-still-works" : "FAIL:minimal-ctor");
'
# Expected: ok:builder-seeded-from-config / ok:di-seam-builder-wins / ok:minimal-ctor-still-works
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Confirm the param order + arg alignment by grepping the exact wiring lines (informational, fast):
grep -n "reasoningInjection: boolean = DEFAULT_CONFIG.reasoningInjection" src/provider/proxy.ts          # 1 match
grep -n "delimiter: { open: string; close: string } = DEFAULT_CONFIG.reasoningInjectionDelimiter" src/provider/proxy.ts  # 1 match
grep -n "new RequestBuilder(diagnostics, reasoningInjection, delimiter)" src/provider/proxy.ts          # 1 match
grep -n "this.config.reasoningInjection," src/provider/decorator.ts                                     # 1 match
grep -n "this.config.reasoningInjectionDelimiter," src/provider/decorator.ts                            # 1 match

# Confirm NO new imports were added (both files already had what they need):
grep -n "import { DEFAULT_CONFIG }" src/provider/proxy.ts          # exactly the pre-existing 1 match
grep -n "import { RequestBuilder }" src/provider/proxy.ts          # exactly the pre-existing 1 match
# decorator.ts should have NO new import lines referencing reasoningInjection/DirectiveConfig.
grep -n "reasoningInjection\|Delimiter" src/provider/decorator.ts | grep "import"   # expected: NO matches

# Confirm no test file was touched (git status — only proxy.ts + decorator.ts modified):
git status --porcelain | grep -E "tests/"   # expected: NO matches
```

## Final Validation Checklist

### Technical Validation

- [ ] `bun run typecheck` passes (zero errors on `src/`). *(Resolves once P2.M2.T2.S1 is merged — see
      Level 1 merge-order note.)*
- [ ] `bun test` (full suite) passes.
- [ ] Level 3 smoke script prints all `ok:` lines.

### Feature Validation

- [ ] StreamProxy ctor has 13 params; params 12-13 are `reasoningInjection` + `delimiter` with
      `DEFAULT_CONFIG.*` defaults (APPENDED after `coordinator?`).
- [ ] `_reasoningInjection` + `_delimiter` fields declared + assigned.
- [ ] Forward: `new RequestBuilder(diagnostics, reasoningInjection, delimiter)`.
- [ ] `_requestBuilder` field JSDoc updated (no false `new RequestBuilder(diagnostics)` claim).
- [ ] Decorator passes `this.config.reasoningInjection` + `this.config.reasoningInjectionDelimiter`
      as the final two positional args.
- [ ] DI seam preserved: `requestBuilder ?? new RequestBuilder(...)` (injected builder still wins).
- [ ] All ~60 existing `new StreamProxy(...)` test constructions unchanged and green.

### Code Quality Validation

- [ ] No new imports in either file (both already import what they need).
- [ ] No test file modified (directive tests are P2.M3.T1.S2).
- [ ] No source file beyond proxy.ts / decorator.ts modified.
- [ ] Appended-param placement matches directive_design.md §7 (positions 12-13, after coordinator).
- [ ] Field naming follows the StreamProxy `param foo → field _foo` convention.

### Documentation & Deployment

- [ ] `_requestBuilder` field JSDoc accurate (mentions forwarded directive config + DI-seam inertness).
- [ ] No standalone docs file, no README/CHANGELOG change (item DOCS note: "none — internal wiring";
      those are P2.M3.T2.* — out of scope).

---

## Anti-Patterns to Avoid

- ❌ Do NOT insert the new params before `coordinator?` — APPEND them (positions 12-13) so existing
  positional callers are not shifted.
- ❌ Do NOT remove or restructure the `requestBuilder ?? new RequestBuilder(...)` nullish-coalescing —
  the injected builder must still win (DI seam, item logic step d).
- ❌ Do NOT add a new `import` for `DEFAULT_CONFIG` or `RequestBuilder` in proxy.ts, or any import in
  decorator.ts — both files already have what they need.
- ❌ Do NOT widen the `delimiter` param type — keep `{ open: string; close: string }` so tsc verifies
  the shape against Config and RequestBuilder end-to-end.
- ❌ Do NOT touch the builder's `buildReplacement` body, the `_launchReplacement` call site
  (proxy.ts:890), `run()`, config, the buffer, or any test file — wiring only (scope: P2.M2.T2.S1 gate,
  P2.M1 config, P2.M3.T1.S2 tests).
- ❌ Do NOT skip updating the `_requestBuilder` field JSDoc — leaving the stale
  `new RequestBuilder(diagnostics)` claim creates false documentation.
- ❌ Do NOT run ruff/mypy/eslint/biome — TypeScript+Bun project; those tools do not exist here.
- ❌ Do NOT add directive/integration tests here — those are P2.M3.T1.S2. Only keep the existing suite green.

---

**Confidence Score: 10/10** for one-pass implementation success.
Rationale: A two-file, four-edit mechanical change with the exact current code quoted verbatim (with
line numbers), the exact target code given for each edit, and the consumed RequestBuilder ctor
contract pinned (P2.M2.T2S1/PRP.md). Both required imports already exist in proxy.ts; `this.config`
already carries the two fields in decorator.ts. Backward compatibility is structurally guaranteed:
appending optional params 12-13 with `DEFAULT_CONFIG` defaults preserves all ~60 existing test
constructions, and the untouched `requestBuilder ?? …` DI seam keeps every injected-builder test green.
The one temporal caveat (T3 typechecks cleanly only after T2 merges) is called out explicitly so the
implementer does not chase a phantom error. The authoritative wiring contract
(`directive_design.md §7`) is cited and matched line-for-line. Scope boundaries (config = P2.M1 done,
gate = P2.M2.T2.S1, tests = P2.M3.T1.S2) are explicit to prevent over-reaching.
