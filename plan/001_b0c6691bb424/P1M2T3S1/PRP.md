# PRP — P1.M2.T3.S1: Wire StreamProxy into ProviderDecorator for z.ai Models

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M2.T3.S1 (Phase 1 Event Proxy, 1 pt) — **activate the `StreamProxy` on the z.ai
> reasoning path inside the `ProviderDecorator` wrapper.** Phase 0's wrapper (P1.M1.T4.S1) evaluates
> the activation conditions (PRD §19.5 / §19.6) but then **delegates every request — eligible or not
> — byte-identically** to the captured built-in. This subtask flips the one branch: when Conditions
> A–E are met, construct `new StreamProxy(model, context, options, originalStreamSimple, diagnostics)`
> and `return proxy.output` instead of the direct delegation. All other requests continue to delegate
> directly. Because the proxy (P1.M2.T2.S1) is a **pure forward-only** pipeline, the wrapper remains
> **observationally equivalent** to the built-in (ADR-005 / PRD §19.7) — every event is forwarded
> unchanged, in order, through a fresh `AssistantMessageEventStream`.
> **Builds on**: P1.M1.T4.S1 (`src/provider/decorator.ts` — DONE) + P1.M2.T2.S1
> (`src/provider/proxy.ts` — DONE) + P1.M2.T1.S1 (`src/types.ts` — DONE, transitively via the proxy).
> **Consumed by**: P1.M3 onwards (adds the interception/transition logic *inside* the proxy's `run`).

---

## Goal

**Feature Goal**: Modify exactly **one** function in `src/provider/decorator.ts` — the
`wrapperStreamSimple` closure — so that the already-computed `eligible` branch (Conditions A/C/D from
PRD §19.6; B is guaranteed by pi-ai's registry api-guard; E is trivially `true` until P1.M4.T4.S1)
now constructs a `StreamProxy` and returns `proxy.output` instead of delegating. Add the single import
`import { StreamProxy } from "./proxy";`. Update the module banner JSDoc so it no longer claims "every
request is delegated byte-identically" — it now claims "eligible z.ai reasoning requests route through
the transparent StreamProxy; all others delegate directly." The `wrapperStream` closure (the non-simple
`stream` path) is **untouched** — interception is `streamSimple`-only.

**Deliverable**:
- `src/provider/decorator.ts` — MODIFIED: add the `StreamProxy` import; rewrite the `if (eligible) { … }`
  body of `wrapperStreamSimple` to `const proxy = new StreamProxy(model, context, options,
  originalStreamSimple, this.diagnostics); return proxy.output;`; update the diagnostics event name
  from `"provider.streamSimple.eligible-delegate"` → `"provider.streamSimple.proxy"`; refresh the
  module-banner + inline JSDoc (Phase 0 → Phase 1 wording). **No** other logic changes.
- `tests/provider-decorator.test.ts` — MODIFIED: the existing Phase-0 test double returns a sentinel
  (`STREAM_SENTINEL`) for both `stream` and `streamSimple`. Because the eligible path now constructs a
  `StreamProxy` that **iterates** `originalStreamSimple`'s return value, the double's `streamSimple`
  must return a **real, drivable `AssistantMessageEventStream`** (created via
  `createAssistantMessageEventStream()`). Update the shared `makeFakeRegistry` helper accordingly
  (track the last returned stream in `stats`), then update the **four** streamSimple identity
  assertions and **rewrite** the one eligible-path test into a full proxy-routing + observational-
  equivalence test. The `stream`-path test keeps using `STREAM_SENTINEL` (the `stream` closure still
  delegates unconditionally).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → 0 diagnostics;
`npx bun run build` → `dist/provider/decorator.js` + `.d.ts` re-emitted (no new files);
`npx bun test` → all green (the **updated** decorator suite + stream-proxy + types + factory +
diagnostics + config + smoke). The eligible path now returns a stream that is **not** the upstream
identity but forwards an identical event sequence + resolves `result()` to the same terminal
`AssistantMessage`. No edits anywhere except `src/provider/decorator.ts` + `tests/provider-decorator.test.ts`.

---

## Why

- **This closes the Phase-1 "Event Proxy" milestone.** P1.M2.T2.S1 built the transparent pipeline;
  this subtask is the **one wiring point** that actually puts a z.ai reasoning request *through* it.
  Until now the proxy existed but was never instantiated in production. After this, a z.ai reasoning
  request flows `Pi → wrapper.streamSimple → StreamProxy.output → (proxy forwards) → upstream
  built-in` — the seam every later phase (P1.M3 FSM, P1.M4 reasoning detection, P1.M5 abort, P1.M7
  splicing) layers onto *inside* the proxy.
- **It proves observational equivalence end-to-end at the wrapper boundary.** Phase 0 proved the
  *non*-eligible path is byte-identical; this subtask proves the *eligible* path is too — because the
  proxy re-emits every event through a fresh stream without touching content, ordering, timing, or
  completion. That is the runtime instantiation of ADR-005 / PRD §19.7 ("When active, the wrapper is
  still observationally equivalent … the proxy only forwards events").
- **The change is surgical and low-risk.** It reuses the already-correct `eligible` computation
  (Conditions A/C/D), reuses the already-built `StreamProxy` constructor surface, and changes exactly
  one `return`. The work is mostly in the **test** — making the fake `streamSimple` return a real
  async-iterable stream so the proxy's forwarding loop can be driven and asserted.

## What

Modify `src/provider/decorator.ts`:

1. **Add import** (value import — `StreamProxy` is a class): `import { StreamProxy } from "./proxy";`
   (sibling file; relative path matches the existing `../config` / `../diagnostics` relative style —
   the proxy is a peer in `src/provider/`).
2. **Rewrite the `eligible` branch** of `wrapperStreamSimple`. The current Phase-0 body logs
   `"provider.streamSimple.eligible-delegate"` and falls through to a shared `return
   originalStreamSimple(model, context, options)`. The Phase-1 body logs
   `"provider.streamSimple.proxy"`, constructs the proxy, and `return proxy.output`. The **non-eligible
   branch** keeps logging `"provider.streamSimple.delegate"` and `return originalStreamSimple(...)`.
3. **Refresh JSDoc**: module banner (Phase 0 → Phase 1; "eligible z.ai reasoning requests now route
   through the transparent StreamProxy (PRD §19.5/§19.7); all others delegate directly"); the
   `wrapperStreamSimple` inline comment (Conditions A–E still hold; note E is trivially true until
   P1.M4.T4.S1). **No** change to the `eligible` boolean computation, the `wrapperStream` closure,
   `initialize`, `shutdown`, the constructor, or any other member.

Modify `tests/provider-decorator.test.ts`:

4. **Refactor the test double** `makeFakeRegistry`: the fake provider's `streamSimple` now returns a
   **real** `AssistantMessageEventStream` (via `createAssistantMessageEventStream()`), tracked in
   `stats.lastSimpleStream()`. The `stream` path still returns the constant `STREAM_SENTINEL` (it is
   never proxied; identity-only checks suffice). Add the needed pi-ai imports.
5. **Update the four streamSimple identity assertions** (`expect(out).toBe(STREAM_SENTINEL)` →
   `expect(out).toBe(f.stats.lastSimpleStream())`) in the non-z.ai / non-reasoning / disabled /
   non-recursion tests.
6. **Rewrite** the `"z.ai + reasoning + enabled (eligible)"` test into a proxy-routing +
   observational-equivalence test: assert the returned stream is **not** the upstream identity (it is
   `proxy.output`), assert `stats.simpleCalls === 1` (the proxy invoked the captured built-in once),
   then **drive** the upstream stream (push a `[start, text_delta, done]` sequence with a microtask
   flush between pushes) and assert the **identical** sequence appears on `out`, in order, and that
   `await out.result()` resolves to the `done` event's carried `AssistantMessage`.

**Out of scope** (owned by other subtasks — do NOT implement here):
- Any change *inside* `src/provider/proxy.ts` → owned by P1.M2.T2.S1 (DONE) / P1.M4 / P1.M5 / P1.M7.
- Reasoning detection / state tracking / abort / splicing / a second upstream → P1.M4 / P1.M5 / P1.M7.
- The `TransitionController` FSM / Condition E (the "not already interrupting" guard) → P1.M3 / P1.M4.T4.
- Any edit to `src/index.ts` (factory), `src/types.ts`, `src/state/*`, `src/config/*`,
  `src/diagnostics/*`, `package.json`, `tsconfig.json`, `.gitignore`, or any test other than
  `tests/provider-decorator.test.ts` → forbidden.

### Success Criteria

- [ ] `src/provider/decorator.ts` imports `StreamProxy` from `"./proxy"` (value import).
- [ ] `wrapperStreamSimple`, when `eligible` is `true`, constructs
      `const proxy = new StreamProxy(model, context, options, originalStreamSimple, this.diagnostics)`
      and `return proxy.output`; logs `"provider.streamSimple.proxy"`.
- [ ] `wrapperStreamSimple`, when `eligible` is `false`, still `return originalStreamSimple(model,
      context, options)` and logs `"provider.streamSimple.delegate"` — unchanged behaviour.
- [ ] `wrapperStream` (the non-simple `stream` closure) is **byte-for-byte unchanged**.
- [ ] The `eligible` computation is unchanged (Conditions A/C/D: `config.enabled && model.reasoning &&
      config.supportedProviders.includes(String(model.provider))`).
- [ ] **Observational equivalence on the eligible path**: driving the upstream with `[start,
      text_delta, done]` produces the identical sequence on `proxy.output` in order, and
      `await proxy.output.result()` resolves to the `AssistantMessage` carried by the `done` event.
- [ ] **Identity divergence on the eligible path**: `wrapper.streamSimple(eligibleModel, …)` returns a
      stream that is `!==` the stream the captured built-in returned (it is `proxy.output`).
- [ ] The non-eligible paths still return the captured built-in's stream **by identity** (`===`).
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` → `dist/provider/decorator.{js,d.ts}` re-emitted; exit 0.
- [ ] `npx bun test tests/provider-decorator.test.ts` → all green; `npx bun test` → all green
      (no regressions in stream-proxy / types / factory / diagnostics / config / smoke).
- [ ] Module-banner + inline JSDoc updated to Phase-1 wording and cite PRD §19.5/§19.6/§19.7.
- [ ] No edits outside `src/provider/decorator.ts` and `tests/provider-decorator.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact current source** of the `wrapperStreamSimple` closure to be
edited (read directly from the landed P1.M1.T4.S1), the **exact `StreamProxy` constructor signature**
already exported by the landed P1.M2.T2.S1 (`new StreamProxy(model, context, options,
upstreamStreamFn, diagnostics)` → `proxy.output`), the **exact reason the test double must change**
(the proxy **iterates** `originalStreamSimple`'s return value, so a non-iterable sentinel throws
inside `run()`'s forwarding loop), the **complete reference diff** for both files, and the exact
build/test commands proven in this repo (all 82 tests currently green).

### Documentation & References

```yaml
# PRD authority (PRD.md in repo root)
- url: PRD.md §19.5 "Wrapper Decision Tree"
  why: "Deterministic flow: Supported API → Supported Provider → Reasoning-Capable Model → Construct
        Proxy → Delegate Initial Request → Monitor Stream. This subtask implements the 'Construct
        Proxy' + 'Delegate Initial Request' nodes for the eligible branch."
  critical: "'The overwhelming majority of requests should take the direct delegation path' — so the
        non-eligible branch MUST stay a plain `return originalStreamSimple(...)` (no proxy)."
- url: PRD.md §19.6 "Activation Conditions" (A–E)
  why: "A: provider is z.ai (config.supportedProviders); B: openai-completions api (guaranteed by
        pi-ai's registry api-guard — NOT re-checked in the wrapper); C: model.reasoning; D:
        config.enabled; E: not already interrupting (trivially true until P1.M4.T4.S1)."
  critical: "The `eligible` boolean already encodes A∧C∧D exactly (see decorator.ts). DO NOT change
        the computation; only change what the `if (eligible)` branch DOES. Condition E is intentionally
        not modelled yet (Phase 1)."
- url: PRD.md §19.7 "Pass-through Guarantee" + ADR-005
  why: "'No observable behavior shall change.' Justifies routing through the proxy: a pure-forward
        proxy preserves ordering/metadata/timing/completion/usage/errors/cancellation/stream-identity
        *except* stream identity — the consumer gets `proxy.output` (a fresh stream), not the upstream
        object. This identity divergence is the ONE allowed, intentional observable difference and it
        is itself required by PRD §20.5 ('the downstream consumer never interacts with an upstream
        stream directly')."
- url: PRD.md §13.1 "Provider Decorator" + §28 "ProviderDecorator Module"
  why: "Responsibility 'Construct stream proxy' is now realised. Invariant 'the wrapper never delegates
        to itself' still holds — the proxy receives the CAPTURED `originalStreamSimple`, captured
        before registration (P1.M1.T4.S1), so the proxy's upstream delegation never re-enters the
        wrapper."

# The two modules this subtask connects (BOTH DONE — read to author against their real surfaces)
- file: src/provider/decorator.ts   # P1.M1.T4.S1 — the file being EDITED
  why: "Contains the `wrapperStreamSimple` closure to modify, the `originalStreamSimple` local the
        proxy consumes, the `this.diagnostics`/`this.config` references, and the Mode-A JSDoc style."
  pattern: "value import `./proxy`; the eligible branch is the ONLY edit point; mirror the existing
        diagnostics.debug call shape ({ api, provider, model } allow-listed fields only — Appendix H)."
  gotcha: "`originalStreamSimple` is a local `const` assigned `original.streamSimple` in `initialize()`.
        Pass THIS local (not `this.original!.streamSimple`) — it is the exact same reference and matches
        the work-item contract; using the local keeps the change a 1-liner inside the closure."
- file: src/provider/proxy.ts   # P1.M2.T2.S1 — the class being IMPORTED
  why: "Exports `class StreamProxy`. Constructor: `(model: Model<Api>, context: Context, options:
        SimpleStreamOptions, upstreamStreamFn: ApiStreamSimpleFunction, diagnostics: Diagnostics)`.
        Read-only getter `get output(): AssistantMessageEventStream`. Constructor starts the forward-
        only pipeline fire-and-forget (`void this.run(...)`); `run` never rethrows."
  critical: "The proxy is constructed SYNCHRONOUSLY and `proxy.output` is returned synchronously — the
        wrapper's return type (`AssistantMessageEventStream`) is unchanged. The proxy invokes
        `upstreamStreamFn(model, context, options)` inside `run()` (asynchronously, but before the first
        `await`), so in production the real built-in `streamSimple` is called once per eligible request."

# Established test conventions to mirror
- file: tests/provider-decorator.test.ts   # the file being EDITED
  why: "THE Bun test style: `import { describe, test, expect } from 'bun:test'`; flat tests/ dir;
        ../src/* imports; a `makeFakeRegistry(opts)` helper returning { registry, calls, fakeProvider,
        registered, stats }; a `noopDiagnostics` stub; `mkModel`/`ctx`/`opts` fixtures."
  pattern: "Reuse `noopDiagnostics` verbatim. Extend `stats` with `lastSimpleStream()`. For the eligible
        test, reuse the SAME drive/pump idiom as tests/stream-proxy.test.ts (`upstream.push(e); await
        new Promise(r => setTimeout(r, 0))`) so the async iterators interleave deterministically."
  gotcha: "The current double's `streamSimple` returns `STREAM_SENTINEL` (a plain object, NOT async-
        iterable). After this change the eligible path's proxy does `for await (const event of
        STREAM_SENTINEL)` → throws synchronously inside `run()` → the proxy's catch synthesizes an error
        terminal. That BREAKS the eligible test's intent (it can no longer assert clean forwarding) and
        makes the double unfit for purpose. FIX: return a real `createAssistantMessageEventStream()`."
- file: tests/stream-proxy.test.ts   # P1.M2.T2.S1 — the drive/pump idiom to reuse
  why: "`drive(mockUpstream, events)` pushes one event per macrotask then flushes, while a consumer
        iterates `proxy.output`. Copy this pump pattern into the rewritten eligible-path decorator test."

# pi-ai type surface (verified against installed @earendil-works/pi-ai@0.74.2)
- file: node_modules/@earendil-works/pi-ai/dist/api-registry.d.ts
  why: "ApiStreamSimpleFunction = (model, context, options?) => AssistantMessageEventStream. Confirms
        `originalStreamSimple`'s type matches the StreamProxy's `upstreamStreamFn` param EXACTLY — no
        adapter needed."
- file: node_modules/@earendil-works/pi-ai/dist/types.d.ts   # lines 458–482
  why: "Model<TApi>: `reasoning: boolean` (Condition C), `provider: Provider` (Condition A), `api: TApi`.
        Confirms the `eligible` computation's field reads are correct and unchanged."
- file: node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js   # runtime semantics
  why: "EventStream: push() of a terminal (type 'done'|'error') sets done=true AND resolves result() in
        the SAME call; [Symbol.asyncIterator] yields buffered events then returns when done. This is why
        driving the upstream with a `done` event completes `proxy.output` WITHOUT calling `output.end()`."
```

### Current Codebase tree (Phase 0 + Phase 1 core landed; this is the wiring subtask)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts          # factory (DONE; DO NOT touch)
│   ├── types.ts          # P1.M2.T1.S1 (DONE; transitively via proxy — DO NOT touch)
│   ├── provider/
│   │   ├── decorator.ts  # ← THIS SUBTASK EDIT #1 (wrapperStreamSimple eligible branch + import + JSDoc)
│   │   └── proxy.ts      # DONE (P1.M2.T2.S1) — IMPORTED, not edited
│   ├── state/{controller,coordinator}.ts   # P1.M3 stubs (DO NOT touch)
│   ├── config/index.ts   # DONE
│   └── diagnostics/index.ts # DONE
├── tests/
│   ├── provider-decorator.test.ts  # ← THIS SUBTASK EDIT #2 (double refactor + 4 identity asserts + eligible rewrite)
│   ├── stream-proxy.test.ts        # DONE — reuse its drive/pump idiom; must stay green
│   ├── types.test.ts               # DONE; must stay green
│   ├── factory.test.ts             # must stay green (uses a fake decorator — unaffected)
│   ├── diagnostics.test.ts         # must stay green
│   ├── config.test.ts              # must stay green
│   └── smoke.test.ts               # must stay green
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── src/
│   └── provider/
│       └── decorator.ts          # MODIFIED — eligible branch constructs StreamProxy + returns proxy.output
│   └── ...                       # all other src/ files UNCHANGED
├── tests/
│   └── provider-decorator.test.ts # MODIFIED — real-stream double; updated asserts; rewritten eligible test
└── dist/provider/{decorator.js,decorator.d.ts}  # RE-EMITTED by `npx bun run build` (no new files)
```
**File responsibilities**: `src/provider/decorator.ts` keeps its single responsibility (capture built-in
+ register reversible wrapper) but the eligible branch now delegates through the transparent proxy.
`tests/provider-decorator.test.ts` keeps its coverage (init lifecycle, shutdown, all four non-eligible
branches, recursion-safety, constants) and gains a real proxy-routing + equivalence assertion. No other
file is touched.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (the test double MUST return a real async-iterable stream for streamSimple): the proxy's
// `run()` does `for await (const event of upstreamStreamFn(...))`. If the fake's `streamSimple` returns
// the plain `STREAM_SENTINEL` object (no [Symbol.asyncIterator]), that loop throws synchronously and the
// proxy synthesizes an error terminal — so you cannot assert clean forwarding on the eligible path and
// the rewritten test will not demonstrate observational equivalence. FIX: return
// createAssistantMessageEventStream() from the fake's streamSimple (fresh per call, tracked in stats).

// CRITICAL (the eligible path returns proxy.output, NOT the upstream identity): Phase 0 asserted the
// eligible path returns `STREAM_SENTINEL` (identity). That assertion is now WRONG — the eligible path
// returns `proxy.output`, a FRESH AssistantMessageEventStream. The rewritten test asserts `out !==
// upstream` (the proxy owns the downstream queue, PRD §20.5) and proves equivalence behaviourally
// (identical forwarded sequence + result()). The NON-eligible paths keep the `===` identity assertion
// (they still return the captured built-in's stream directly).

// CRITICAL (deterministic interleaving when driving the proxy): the proxy's `run()` and the test's
// consumer both suspend on async iterators. Pushing all events then awaiting is racy. Pump one event per
// macrotask: `upstream.push(e); await new Promise(r => setTimeout(r, 0));` then `await` the consumer
// (exactly the idiom in tests/stream-proxy.test.ts `drive()`). The terminal `done` push completes
// proxy.output (sets done + resolves result() in the same push) so the consumer loop exits naturally.

// GOTCHA (value import, not type import): `StreamProxy` is a class (a value). Use a plain
// `import { StreamProxy } from "./proxy";`, NOT `import type`. (decorator.ts already splits value/type
// imports this way — add the StreamProxy value import alongside the existing pi-ai value import.)

// GOTCHA (pass the captured local `originalStreamSimple`, not `this.original!.streamSimple`): both are
// the same reference (the local is assigned `original.streamSimple` during capture-before-register).
// Use the local to keep the change inside the existing closure with no new field access.

// GOTCHA (the proxy is fire-and-forget; do NOT await it in the wrapper): the wrapper's contract is
// synchronous `return proxy.output` (return type AssistantMessageEventStream, unchanged). The proxy's
// constructor starts `run()` internally. Do NOT `await proxy` or `await proxy.output.result()` in the
// wrapper — Pi awaits result() later, downstream.

// GOTCHA (privacy — Appendix H): the new diagnostics.debug call passes ONLY allow-listed fields
// ({ api, provider, model }) — exactly the existing shape. NEVER log context, options, or stream content.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke as `npx bun ...` / `npx bun run <script>`,
// NOT bare `bun`/`tsc`. package.json scripts resolve via `npx bun run`.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → `npx bun run typecheck` checks src ONLY.
// tests/provider-decorator.test.ts is validated by `npx bun test` (Bun runs TS natively).
```

---

## Implementation Blueprint

### The exact current source to edit (read directly from the landed P1.M1.T4.S1)

```typescript
// src/provider/decorator.ts — current wrapperStreamSimple (Phase 0). The eligible branch is the edit point.

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
```

### The exact replacement (Phase 1)

```typescript
    const wrapperStreamSimple: ApiStreamSimpleFunction = (model, context, options) => {
      // Activation conditions per PRD §19.5 / §19.6 (B is guaranteed by the registry's api-guard):
      //   A: provider in config.supportedProviders
      //   C: model.reasoning
      //   D: config.enabled
      //   (E: not already interrupting — trivially true in Phase 1; modelled in P1.M4.T4.S1.)
      const eligible =
        this.config.enabled &&
        model.reasoning &&
        this.config.supportedProviders.includes(String(model.provider));

      if (eligible) {
        // z.ai reasoning model + feature enabled → route through the transparent StreamProxy
        // (PRD §19.5 "Construct Proxy → Delegate Initial Request → Monitor Stream"; §19.6 A–E).
        // Observational equivalence holds because the proxy only forwards events, unchanged, through a
        // fresh AssistantMessageEventStream (PRD §19.7; §20.5 — downstream never touches the upstream).
        this.diagnostics.debug("provider.streamSimple.proxy", {
          api: model.api,
          provider: String(model.provider),
          model: model.id,
        });
        const proxy = new StreamProxy(model, context, options, originalStreamSimple, this.diagnostics);
        return proxy.output;
      }

      this.diagnostics.debug("provider.streamSimple.delegate", {
        api: model.api,
        provider: String(model.provider),
        model: model.id,
      });
      return originalStreamSimple(model, context, options);
    };
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: EDIT src/provider/decorator.ts — add the StreamProxy import
  - ADD (value import, near the existing pi-ai value import): `import { StreamProxy } from "./proxy";`
  - PLACEMENT: top import block. Keep the existing value/type import split (StreamProxy is a value).
  - GOTCHA: "./proxy" (sibling in src/provider/), NOT "../proxy". NOT `import type`.

Task 2: EDIT src/provider/decorator.ts — rewrite the eligible branch of wrapperStreamSimple
  - REPLACE the `if (eligible) { … } else { … } return originalStreamSimple(...)` block (shown above)
    with the Phase-1 version: eligible → log "provider.streamSimple.proxy" + construct StreamProxy +
    return proxy.output; non-eligible → log "provider.streamSimple.delegate" + return
    originalStreamSimple(...).
  - PRESERVE: the `eligible` boolean computation (Conditions A/C/D) byte-for-byte; the wrapperStream
    closure (the non-simple `stream` path); initialize/shutdown/constructor; every other line.
  - VERIFY mentally: `originalStreamSimple` (the captured local) is the proxy's upstream; the return
    type is still AssistantMessageEventStream; the proxy is constructed synchronously and not awaited.

Task 3: EDIT src/provider/decorator.ts — refresh JSDoc (Phase 0 → Phase 1)
  - MODULE BANNER: change the Phase-0 claim ("EVERY request … is delegated byte-identically … The
    StreamProxy that would actually intercept eligible z.ai reasoning streams is built in P1.M2.T3.S1.")
    to Phase-1: eligible z.ai reasoning requests route through the transparent StreamProxy (PRD §19.5/
    §19.7); all other requests delegate directly. Keep the ADR-003/§28/EC-012 citations.
  - INLINE: update the `(E: … trivially true in Phase 0 …)` note to "Phase 1" (cosmetic).
  - GOTCHA: do NOT touch the wrapperStream JSDoc or the initialize/shutdown JSDoc.

Task 4: EDIT tests/provider-decorator.test.ts — refactor the test double to return a real stream
  - ADD imports: `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";` (value)
    and `import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";`
  - IN makeFakeRegistry: change the fake provider's `streamSimple` to create + return a REAL
    `createAssistantMessageEventStream()` per call, pushing each into a new `simpleStreams` array.
    KEEP the `stream` path returning the constant `STREAM_SENTINEL` (it is never proxied).
  - EXTEND `stats` with `lastSimpleStream: () => simpleStreams[simpleStreams.length - 1]`.
  - GOTCHA: a fresh stream per call is REQUIRED — the proxy iterates the stream the captured built-in
    returned for THIS request, and the test must push events into exactly that instance.

Task 5: EDIT tests/provider-decorator.test.ts — update the 4 non-eligible identity assertions
  - CHANGE every `expect(out).toBe(STREAM_SENTINEL)` / `expect(wrapper.streamSimple(...)).toBe(STREAM_SENTINEL)`
    on a streamSimple call to `.toBe(f.stats.lastSimpleStream())` (identity preserved against the real
    stream the fake returned). Affected tests: "non-z.ai provider", "non-reasoning model",
    "feature disabled (config.enabled=false)". The "delegation never recurses" test asserts call counts
    only (getCount/regCount/simpleCalls) — it needs NO assertion change (simpleCalls===1 still holds
    because the proxy invokes originalStreamSimple exactly once), but verify it stays green.
  - KEEP the `stream`-path test asserting `.toBe(STREAM_SENTINEL)` (the stream closure is unchanged).

Task 6: REWRITE tests/provider-decorator.test.ts — the eligible-path test → proxy routing + equivalence
  - REPLACE the old "z.ai + reasoning + enabled (eligible) — STILL delegates transparently in Phase 0"
    test with an async test that:
      1. Calls `const out = wrapper.streamSimple(mkModel(), ctx, opts)` and reads
         `const upstream = f.stats.lastSimpleStream()`.
      2. Asserts `expect(out).not.toBe(upstream)` (it is proxy.output — PRD §20.5 identity divergence).
      3. Asserts `expect(f.stats.simpleCalls).toBe(1)` (the proxy invoked the captured built-in once).
      4. Drives the upstream with `[start, text_delta, done]` using the per-macrotask pump
         (`upstream.push(e); await new Promise(r => setTimeout(r, 0))`) while a consumer iterates `out`
         into `seen: string[]` and then `await`s the consumer.
      5. Asserts `expect(seen).toEqual(["start", "text_delta", "done"])` (identical, in order — PRD §19.7).
      6. Asserts `expect(await out.result()).toBe(DONE_MESSAGE)` (the done event's carried AssistantMessage).
  - ADD a `DONE_MESSAGE` sentinel (mirrors tests/stream-proxy.test.ts). Use `as never` casts for the
    synthetic events (the suite's existing style).

Task 7: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics.
  - RUN: npx bun run build      → dist/provider/decorator.{js,d.ts} re-emitted.
  - RUN: npx bun test           → all green (decorator + stream-proxy + types + factory + diagnostics
    + config + smoke).
  - RUN: Level 3/4 gates below (node import smoke + grep assertions on decorator.ts + the test).
```

### Implementation Patterns & Key Details

```typescript
// COMPLETE reference for the test double change in tests/provider-decorator.test.ts.

// (a) New imports at the top of the test file:
//   import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
//   import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";

// (b) Inside makeFakeRegistry — replace the fakeProvider.streamSimple body + add tracking:
//
//   const simpleStreams: AssistantMessageEventStream[] = [];
//   ...
//   const fakeProvider = {
//     api: OPENAI_COMPLETIONS_API,
//     stream: (...args: unknown[]) => {
//       calls.push("builtin.stream");
//       streamArgs.push(args);
//       callCountStream++;
//       return STREAM_SENTINEL;            // unchanged — the `stream` path is never proxied
//     },
//     streamSimple: (...args: unknown[]) => {
//       calls.push("builtin.streamSimple");
//       builtinArgs.push(args);
//       callCountSimple++;
//       const s = createAssistantMessageEventStream();   // REAL drivable stream
//       simpleStreams.push(s);
//       return s;
//     },
//   };
//   ...
//   stats: {
//     get simpleCalls() { return callCountSimple; },
//     get streamCalls() { return callCountStream; },
//     lastSimpleArgs: () => builtinArgs[builtinArgs.length - 1],
//     lastStreamArgs: () => streamArgs[streamArgs.length - 1],
//     lastSimpleStream: () => simpleStreams[simpleStreams.length - 1],   // NEW
//   },

// (c) Non-eligible identity assertions — STREAM_SENTINEL → f.stats.lastSimpleStream():
//   expect(out).toBe(f.stats.lastSimpleStream());   // identity preserved on the delegate path

// (d) The rewritten eligible test (full body):
//
//   const DONE_MESSAGE = { role: "assistant", content: [], model: "m" } as never;
//
//   test("z.ai + reasoning + enabled (eligible) — routes through StreamProxy: returns proxy.output and forwards events identically (PRD §19.7)", async () => {
//     const { f, wrapper } = setup();
//     const out = wrapper.streamSimple(mkModel(), ctx, opts);
//     const upstream = f.stats.lastSimpleStream();
//     expect(out).not.toBe(upstream);              // proxy.output, a fresh stream (PRD §20.5)
//     expect(f.stats.simpleCalls).toBe(1);          // proxy invoked the captured built-in exactly once
//
//     const seen: string[] = [];
//     const consumer = (async () => {
//       for await (const e of out) seen.push((e as AssistantMessageEvent).type);
//     })();
//     for (const e of [
//       { type: "start" },
//       { type: "text_delta", delta: "Hi", contentIndex: 0 },
//       { type: "done", reason: "stop", message: DONE_MESSAGE },
//     ] as never[]) {
//       upstream.push(e);
//       await new Promise((r) => setTimeout(r, 0));   // deterministic interleave
//     }
//     await consumer;
//     expect(seen).toEqual(["start", "text_delta", "done"]);   // byte-identical, in order
//     expect(await out.result()).toBe(DONE_MESSAGE);            // result() resolves to the done message
//   });
```

### Integration Points

```yaml
PRODUCTION CALL CHAIN (after this subtask):
  Pi → wrapper.streamSimple(model, context, options)
       └─ eligible? → new StreamProxy(model, context, options, originalStreamSimple, diagnostics)
                       └─ return proxy.output   (AssistantMessageEventStream — UNCHANGED return type)
                         └─ [async, fire-and-forget] proxy.run() iterates originalStreamSimple(...)
       └─ not eligible? → return originalStreamSimple(model, context, options)   (unchanged)

NO NEW MODULES / NO NEW EXPORTS:
  - decorator.ts gains one import (StreamProxy) and one branch rewrite. Its PUBLIC surface
    (ProviderDecorator class, OPENAI_COMPLETIONS_API, STOP_THINKING_SOURCE_ID, ProviderRegistry) is
    UNCHANGED. index.ts (factory) is UNCHANGED — it already `new ProviderDecorator(config, diagnostics)`.

NO CHANGES TO: src/index.ts, src/types.ts, src/provider/proxy.ts, src/state/*, src/config/*,
  src/diagnostics/*, package.json, tsconfig.json, .gitignore, or any test other than
  tests/provider-decorator.test.ts. Only src/provider/decorator.ts is edited + the decorator test.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. Common failures:
#   - "Cannot find name 'StreamProxy'" → confirm the VALUE import `import { StreamProxy } from "./proxy";`
#     (not `import type`; not a wrong path like "../proxy").
#   - Type mismatch on `new StreamProxy(...)` → confirm arg order matches the landed proxy.ts ctor:
#     (model, context, options, upstreamStreamFn, diagnostics). originalStreamSimple is
#     ApiStreamSimpleFunction = the upstreamStreamFn param type exactly.
#   - "Property 'output' does not exist" → confirm proxy.ts exports `get output()` (it does).

# Build (re-emit dist):
npx bun run build            # = tsc
# Expected: dist/provider/decorator.js + dist/provider/decorator.d.ts updated; exit 0; no NEW files.
ls dist/provider/decorator.*
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the decorator suite alone:
npx bun test tests/provider-decorator.test.ts
# Expected: all green — incl. the REWRITTEN eligible test (proxy.output identity divergence + identical
#   forwarded sequence + result() resolution) and the updated non-eligible identity assertions.

# Full suite (no regressions):
npx bun test
# Expected: every suite green (decorator + stream-proxy + types + factory + diagnostics + config + smoke).
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.

### Level 3: Integration (Package Integrity)

```bash
# Confirm the built decorator still imports + the eligible path returns a forwardable stream. Because
# initialize() needs pi-ai's live registry, drive the wrapperStreamSimple LOGIC against built JS with a
# hand-rolled fake provider + a real AssistantMessageEventStream upstream:
node -e "
(async () => {
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const { ProviderDecorator } = await import('./dist/provider/decorator.js');
  const upstream = createAssistantMessageEventStream();
  const registry = {
    getApiProvider: () => ({ api:'openai-completions', stream:()=>({}), streamSimple:()=>upstream }),
    registerApiProvider: (p,sid)=>{ reg = p; },
    unregisterApiProviders: ()=>{},
  };
  let reg;
  const cfg = { enabled:true, supportedProviders:['zai'] };
  const noop = {trace(){},debug(){},info(){},warn(){},error(){}};
  const d = new ProviderDecorator(cfg, noop, registry);
  d.initialize();
  const model = { id:'glm-4.7', api:'openai-completions', provider:'zai', reasoning:true };
  const out = reg.streamSimple(model, {}, {});
  console.log('output is fresh stream (not upstream identity):', out !== upstream);
  const seen = [];
  (async () => { for await (const e of out) seen.push(e.type); })();
  upstream.push({ type:'start' });
  upstream.push({ type:'text_delta', delta:'hi', contentIndex:0 });
  upstream.push({ type:'done', reason:'stop', message:{ role:'assistant' } });
  await new Promise(r => setTimeout(r, 20));
  console.log('forwarded sequence:', seen.join(','));
})().catch(e => { console.error(e); process.exit(1); });
"
# Expected:
#   output is fresh stream (not upstream identity): true
#   forwarded sequence: start,text_delta,done
#   (proves the eligible path constructs the proxy, returns proxy.output, and forwards identically.)

# Also confirm the NON-eligible path still delegates by identity (returns the upstream object directly):
node -e "
(async () => {
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const { ProviderDecorator } = await import('./dist/provider/decorator.js');
  let upNonReasoning;
  const registry = {
    getApiProvider: () => ({ api:'openai-completions', stream:()=>({}), streamSimple:()=>{ const s=createAssistantMessageEventStream(); upNonReasoning=s; return s; } }),
    registerApiProvider: (p)=>{ reg=p; },
    unregisterApiProviders: ()=>{},
  };
  let reg;
  const cfg = { enabled:true, supportedProviders:['zai'] };
  const noop = {trace(){},debug(){},info(){},warn(){},error(){}};
  new ProviderDecorator(cfg, noop, registry).initialize();
  const out = reg.streamSimple({ id:'m', api:'openai-completions', provider:'zai', reasoning:false }, {}, {});
  console.log('non-reasoning delegates by identity:', out === upNonReasoning);
})().catch(e => { console.error(e); process.exit(1); });
"
# Expected: non-reasoning delegates by identity: true
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Eligible-branch gate — exactly one StreamProxy construction + return proxy.output in streamSimple:
grep -n "new StreamProxy\|proxy.output\|return originalStreamSimple" src/provider/decorator.ts
# Expected: exactly one "new StreamProxy(" (in the eligible branch); exactly one "proxy.output"
#   (its return); exactly one "return originalStreamSimple(...)" (the non-eligible branch). The
#   `stream` path delegates via originalStream(...) — NOT streamSimple.

# Import gate — value import of StreamProxy from the sibling proxy module:
grep -n 'import { StreamProxy } from "./proxy"' src/provider/decorator.ts   # Expected: exactly 1
grep -n 'import type { StreamProxy }' src/provider/decorator.ts             # Expected: ZERO

# Activation-computation unchanged gate — the eligible boolean is still A∧C∧D:
grep -n "config.enabled &&\|model.reasoning &&\|supportedProviders.includes" src/provider/decorator.ts
# Expected: the three-line `eligible` computation is intact; no Condition-E logic added (Phase 1).

# Diagnostics event-name gate — eligible logs "proxy", non-eligible logs "delegate":
grep -n 'provider.streamSimple.proxy"\|provider.streamSimple.delegate"' src/provider/decorator.ts
# Expected: exactly one of each. ZERO remaining "eligible-delegate" (the old Phase-0 name).

# wrapperStream UNCHANGED gate — the non-simple stream path still delegates unconditionally:
grep -n "provider.stream.delegate" src/provider/decorator.ts   # Expected: still present, unchanged.

# Privacy gate — diagnostics calls pass ONLY allow-listed fields:
grep -n "diagnostics.debug" src/provider/decorator.ts
# Expected: every call's object literal has only { api, provider, model } (never context/options/content).

# Test-double gate — streamSimple returns a real stream; stream keeps the sentinel:
grep -n "createAssistantMessageEventStream()\|STREAM_SENTINEL" tests/provider-decorator.test.ts
# Expected: createAssistantMessageEventStream() used in the fake's streamSimple; STREAM_SENTINEL still
#   used by the fake's `stream` and the stream-path test.

# Confirm git sees only the intended changes:
git add -A && git status --short
# Expected: MODIFIED src/provider/decorator.ts, MODIFIED tests/provider-decorator.test.ts
#   (+ regenerated dist/provider/decorator.* if dist is not git-ignored). NOTHING else changed.
```

---

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun run build` → `dist/provider/decorator.{js,d.ts}` re-emitted, exit 0.
- [ ] `npx bun test` → all green (decorator + stream-proxy + types + factory + diagnostics + config + smoke).

### Feature Validation

- [ ] Eligible path constructs `new StreamProxy(model, context, options, originalStreamSimple, this.diagnostics)` and `return proxy.output`.
- [ ] Non-eligible path still `return originalStreamSimple(model, context, options)` by identity.
- [ ] The `stream` (non-simple) closure is unchanged.
- [ ] The `eligible` computation (Conditions A/C/D) is unchanged.
- [ ] Observational equivalence proven: eligible-path forwarded sequence === upstream sequence, in order; `result()` resolves to the `done` message.
- [ ] Identity divergence proven: eligible `out !== upstream`; non-eligible `out === f.stats.lastSimpleStream()`.
- [ ] Error/diagnostics paths use only allow-listed fields (privacy, Appendix H).

### Code Quality Validation

- [ ] Module-banner + inline JSDoc updated to Phase-1 wording; cites PRD §19.5/§19.6/§19.7.
- [ ] Follows existing decorator.ts conventions (Mode-A JSDoc, value/type import split, diagnostics shape).
- [ ] Test follows existing suite conventions (noopDiagnostics, makeFakeRegistry, mkModel/ctx/opts, drive/pump idiom from stream-proxy.test.ts).
- [ ] No edits outside `src/provider/decorator.ts` and `tests/provider-decorator.test.ts`.

### Documentation & Deployment

- [ ] No new user-facing/config/API surface (internal wiring only — item DOCS spec: "none").
- [ ] No new environment variables or package.json changes.

---

## Anti-Patterns to Avoid

- ❌ Don't change the `eligible` computation — Conditions A/C/D are already correct; only the branch *body* changes.
- ❌ Don't add Condition-E (not-already-interrupting) logic — that is P1.M4.T4.S1 (Phase 2). It is trivially `true` here.
- ❌ Don't touch `wrapperStream` (the non-simple `stream` path) — interception is `streamSimple`-only.
- ❌ Don't `import type { StreamProxy }` — it's a class (value). Don't import from `"../proxy"` — it's a sibling (`"./proxy"`).
- ❌ Don't leave the test double returning `STREAM_SENTINEL` for `streamSimple` — the proxy iterates it and would throw; the eligible test could not prove equivalence.
- ❌ Don't assert the eligible path returns the upstream **by identity** (`toBe`) — it returns `proxy.output`, a fresh stream. Assert `not.toBe` + behavioural equivalence.
- ❌ Don't `await proxy` or `await proxy.output.result()` inside the wrapper — the wrapper returns `proxy.output` synchronously; Pi awaits `result()` downstream.
- ❌ Don't log context/options/event content in the new diagnostics call — only `{ api, provider, model }` (Appendix H).

---

## Confidence Score

**9/10** — one-pass success likelihood. The change is a single-branch rewrite of a well-understood
closure plus a focused test-double refactor; both modules it touches are DONE and their surfaces are
verified in this PRP; the only non-obvious risk (the sentinel-vs-real-stream test-double gotcha) is
called out explicitly with a complete reference for the fix and a deterministic drive/pump idiom
copied from the already-passing `stream-proxy.test.ts`.
