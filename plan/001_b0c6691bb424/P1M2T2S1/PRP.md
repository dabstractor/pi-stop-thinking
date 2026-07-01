# PRP — P1.M2.T2.S1: StreamProxy — Transparent Forward-Only Pipeline (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M2.T2.S1 (Phase 1 Event Proxy, 2 pts) — implement the **`StreamProxy` class** as a
> **forward-only, observationally-transparent** pipeline: it owns exactly one outbound
> `AssistantMessageEventStream`, iterates a single upstream async iterable, and pushes every event
> through unchanged. No event modification, no suppression, no buffering, no splicing — **pure
> forwarding** (PRD §20.1–§20.6, §13.2). When wired behind the `ProviderDecorator` for z.ai models it
> must produce **byte-identical** output to direct delegation (ADR-005 / PRD §19.7).
> **Consumed by**: P1.M2.T3.S1 (wires the proxy into the decorator's z.ai path), P1.M4 (adds reasoning
> detection), P1.M5 (adds abort), P1.M7 (adds splicing).
> **Builds on**: Phase 0 (P1.M1.*) is landed (config / diagnostics / ProviderDecorator / factory).
>
> **Parallel context**: P1.M2.T1.S1 (`src/types.ts` — `AssistantMessageEvent` re-export + the four
> `is*Event` guards + `TransitionState`/`ProxyPhase`) is being implemented in parallel. That PRP is a
> **CONTRACT**: assume `src/types.ts` exports `AssistantMessageEvent` (re-exported from
> `@earendil-works/pi-ai`) plus the guards. This proxy imports `AssistantMessageEvent` from `../types`
> for typing/JSDoc; it does **NOT** call any guard in the forward-only phase (guards are consumed by
> P1.M4 reasoning detection / P1.M7 suppression). No overlap, no conflict.

---

## Goal

**Feature Goal**: Replace the 2-line placeholder `src/provider/proxy.ts` with a real `StreamProxy`
class that hides the existence of upstream provider requests behind exactly one outbound
`AssistantMessageEventStream` (PRD §20.1 Purpose, §20.3 Output). The constructor creates
`output = createAssistantMessageEventStream()` and starts an async `run()` method that obtains the
upstream via the injected `upstreamStreamFn`, then `for await (const event of upstream)
output.push(event)` until the upstream iterator completes naturally (its terminal `done`/`error`
event having already been pushed — see research/event-stream-internals.md §2). A read-only getter
`get output()` exposes the single downstream stream. Output is **byte-identical** to the upstream:
same events, same order, same final `result()`. Pure forwarding only — no guard logic, no state
machine, no buffering, no suppression (all deferred).

**Deliverable**:
- `src/provider/proxy.ts` exporting the `StreamProxy` class with: a constructor
  `(model, context, options, upstreamStreamFn, diagnostics)`, a private async `run(...)`, a
  `get output(): AssistantMessageEventStream` getter, and a small private `makeErrorAssistantMessage`
  helper for the defensive terminal-synthesis path. **Mode-A JSDoc** (module banner +
  responsibility/ownership/lifecycle/invariants/failure-modes per Appendix F) documenting the
  **single-output invariant** (PRD §13.2 Guarantees: exactly one `message_start`, one
  `message_end`, one completed result).
- `tests/stream-proxy.test.ts` — Bun unit/integration tests that drive a **manually-controlled
  `AssistantMessageEventStream`** as the mock upstream (the real `createAssistantMessageEventStream()`
  per the item MOCKING spec), push events to it, and assert they appear on `proxy.output` **in the
  same order**, including: full legal event sequence forwarding, the terminal `done`/`error` event
  reaches the consumer and completes `result()`, the synthesized-error safety net on a throwing
  upstream, and observational equivalence (output order === upstream order).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → 0 diagnostics;
`npx bun run build` → `dist/provider/proxy.js` + `dist/provider/proxy.d.ts` emitted with the
`StreamProxy` class; `npx bun test` → all green (new `stream-proxy.test.ts` + every existing suite).
The proxy, when fed a mock upstream, emits a byte-identical event sequence and resolves
`output.result()` to the same `AssistantMessage` the upstream's terminal event carried. No edits
anywhere except `src/provider/proxy.ts` (+ new `tests/stream-proxy.test.ts`).

---

## Why

- **The heart of the extension.** PRD §13.2: "The Stream Proxy is the heart of the extension.
  Everything else exists to support it." This subtask builds the **skeleton** of that heart — the
  one-outbound-queue, single-authority forwarding pipeline (PRD §20.5 Queue Ownership, §20.6 Event
  Authority) that every later phase layers behaviour onto (reasoning detection P1.M4, abort P1.M5,
  splicing P1.M7). Getting the transparent foundation right first means later phases only *add*
  branches, never re-architect the pipeline.
- **Observational equivalence is the contract.** ADR-005 / PRD §19.7 mandate the wrapper be
  observationally equivalent to direct delegation. A pure-forward proxy that re-emits every event
  unchanged through a fresh `AssistantMessageEventStream` is *by construction* byte-identical to the
  upstream in the happy path — so this subtask also *proves* the decoration can be invisible, which
  de-risks P1.M2.T3.S1 (activation wiring) and the whole Phase-1 "Event Proxy" milestone.
- **Establishes the constructor surface future phases extend.** The constructor signature
  `(model, context, options, upstreamStreamFn, diagnostics)` and the `get output()` getter are the
  stable interface P1.M2.T3.S1 instantiates. P1.M4 adds reasoning tracking *inside* `run()`; P1.M5
  adds an internal `AbortController`; P1.M7 adds a second upstream + suppression. None of those
  change the *external* surface this subtask defines.

## What

A TypeScript module `src/provider/proxy.ts` that:

1. Imports `createAssistantMessageEventStream` (value) and
   `AssistantMessageEventStream`/`AssistantMessageEvent`/`ApiStreamSimpleFunction`/`Model`/`Context`/
   `SimpleStreamOptions` (types) from `@earendil-works/pi-ai`; imports `Diagnostics` type from
   `../diagnostics`; imports `AssistantMessageEvent` type from `../types` (P1.M2.T1.S1 re-export —
   single local entry point, consistent with the types-module design).
2. Exports `class StreamProxy` with:
   - Constructor `(model: Model<Api>, context: Context, options: SimpleStreamOptions,
     upstreamStreamFn: ApiStreamSimpleFunction, diagnostics: Diagnostics)`. It creates
     `this.output = createAssistantMessageEventStream()` and starts the pipeline with
     `void this.run(model, context, options, upstreamStreamFn)` (fire-and-forget; `run` never
     rethrows — it converts any thrown error into a single terminal `error` event, see below).
   - `private async run(model, context, options, upstreamStreamFn): Promise<void>` — obtains
     `const upstream = upstreamStreamFn(model, context, options)`, then
     `for await (const event of upstream) { this.output.push(event); }`. **Natural exit** when the
     upstream iterator returns (its terminal `done`/`error` event was already pushed and already
     completed `this.output` in the same `push` call — research §2). Wrapped in `try/catch`: on a
     thrown error it pushes a synthesized `{ type:"error", reason:"error", error }` terminal so the
     downstream never hangs (research §4; `push` is a no-op once already complete, so this is
     transparent in the normal path).
   - `get output(): AssistantMessageEventStream` — read-only accessor returning the single owned
     outbound stream (PRD §20.3/§20.5). No setter.
   - `private makeErrorAssistantMessage(model, message): AssistantMessage` — builds the minimal
     valid `AssistantMessage` carried by the synthesized terminal `error` event.
3. **Mode-A JSDoc** on the module banner (responsibility / ownership / lifecycle / invariants /
   failure modes per Appendix F), on the class, the constructor, `run`, and `get output`. The class
   JSDoc documents the **single-output invariant** (PRD §13.2 Guarantees) — exactly one `start`, one
   `message_end` (`done`|`error`), one completed `result()` — and cites PRD §20.1–§20.6.

**Out of scope** (owned by other subtasks — do NOT implement here):
- Reasoning detection / state tracking inside the loop → **P1.M4.T2.S1** (uses `isThinkingEvent`).
- Abort coordination / internal `AbortController` / abort-vs-completion race → **P1.M5**.
- Stream splicing / a second upstream / terminal suppression / `isTerminalEvent` usage → **P1.M7**.
- Wiring the proxy into `ProviderDecorator` (constructing it on the z.ai path) → **P1.M2.T3.S1**.
- The `TransitionController` FSM, `ReasoningBuffer`, `RequestBuilder`, `TransitionCoordinator` → later.
- Any edit to `src/index.ts`, `src/types.ts`, `src/provider/decorator.ts`, `src/state/*`,
  `src/config/*`, `src/diagnostics/*`, `package.json`, `tsconfig.json`, `.gitignore`, or any existing
  test → forbidden.

### Success Criteria

- [ ] `src/provider/proxy.ts` exports `class StreamProxy` with the constructor, `run`, `get output()`,
      and the private error-message helper exactly as specified.
- [ ] The constructor creates `output` via `createAssistantMessageEventStream()` and starts `run`
      fire-and-forget; `run` never rethrows (converts a throw into a single terminal `error` event).
- [ ] The forwarding loop is `for await (const event of upstream) this.output.push(event)` — **no**
      `output.end()` call, no filtering, no transformation, no buffering (pure forwarding).
- [ ] `get output()` returns the single owned `AssistantMessageEventStream` (read-only; no setter).
- [ ] **Byte-identical forwarding**: a mock upstream emitting `[start, text_delta…, done]` produces
      the identical sequence on `proxy.output`, and `await proxy.output.result()` resolves to the
      `AssistantMessage` the upstream's `done` event carried.
- [ ] **Defensive invariant**: a mock upstream whose `upstreamStreamFn` (or iterator) throws still
      terminates `proxy.output` with exactly one `error` event (no hung stream) — PRD §13.2 single
      terminal / single result guarantee holds even in the degenerate case.
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/provider/proxy.js` + `dist/provider/proxy.d.ts` with `StreamProxy`.
- [ ] `npx bun test tests/stream-proxy.test.ts` → all green; `npx bun test` → all green (no regressions).
- [ ] Mode-A JSDoc present (module + class + ctor + run + getter); class JSDoc cites PRD §13.2 + §20.*.
- [ ] No edits outside `src/provider/proxy.ts` and the new `tests/stream-proxy.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact, verified** `AssistantMessageEventStream` runtime semantics
(read directly from the compiled `event-stream.js` — why a terminal `push` completes the stream and
why `output.end()` must NOT be called), the exact import path for `createAssistantMessageEventStream`
(package-root re-export, verified), the exact constructor type surface (`Model<Api>`, `Context`,
`SimpleStreamOptions`, `ApiStreamSimpleFunction`, `AssistantMessage`/`Usage`/`StopReason` shapes — all
verified against the installed `.d.ts`), the full reference implementation of `src/provider/proxy.ts`,
the complete Bun test suite (driving a real `AssistantMessageEventStream` mock upstream), and the exact
build/test commands proven in this repo.

### Documentation & References

```yaml
# MUST READ — the single source of truth for the stream the proxy forwards into
- file: node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js
  why: "The EventStream runtime: push() sets done=true AND resolves result() when isComplete(event)
        (type==='done'||'error'); [Symbol.asyncIterator]() yields buffered events then returns when
        done; push() is a silent no-op once done. THIS is why the forwarding loop exits naturally and
        why output.end() must NOT be called after the terminal push."
  critical: "A terminal push COMPLETES the stream in the same call (sets done + resolves result()).
        Therefore: (1) the proxy's for-await yields the terminal event and pushes it, then the loop
        exits naturally on the upstream iterator's next next(); (2) DO NOT call output.end() — it is
        unnecessary and the contract says the loop 'exits naturally'. (3) push-after-done is a no-op,
        so a catch-handler terminal push is safe (transparent in the normal path)."
- file: plan/001_b0c6691bb424/P1M2T2S1/research/event-stream-internals.md
  why: "Condensed, PRP-specific walkthrough of the above with the exact mocking recipe and the
        hung-stream rationale for the try/catch safety net."

# pi-ai type surface (verified against installed @earendil-works/pi-ai@0.74.2)
- file: node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts
  why: "Type signatures: AssistantMessageEventStream extends EventStream<AssistantMessageEvent,
        AssistantMessage>; createAssistantMessageEventStream(): AssistantMessageEventStream."
- file: node_modules/@earendil-works/pi-ai/dist/index.d.ts   # line 26: `export * from "./utils/event-stream.js"`
  why: "Confirms createAssistantMessageEventStream + AssistantMessageEventStream are exported from
        the PACKAGE ROOT (bare '@earendil-works/pi-ai')."
  critical: "Import from '@earendil-works/pi-ai' (root), NOT a deep './utils/...' path."
- file: node_modules/@earendil-works/pi-ai/dist/api-registry.d.ts
  why: "ApiStreamSimpleFunction = (model: Model<Api>, context: Context, options?: SimpleStreamOptions)
        => AssistantMessageEventStream. This is the EXACT type of original.streamSimple captured in
        src/provider/decorator.ts — the real upstream wrapped in production (P1.M2.T3.S1)."
- file: node_modules/@earendil-works/pi-ai/dist/types.d.ts
  why: "AssistantMessage / Usage / StopReason / Model<TApi> / Context / SimpleStreamOptions shapes —
        needed for the synthesized-error AssistantMessage helper + constructor param types."

# PRD authority (PRD.md in repo root)
- url: PRD.md §13.2 "Stream Proxy"
  why: "Responsibility / Inputs / Outputs / Guarantees / Invariant. Guarantees = 'Exactly one
        message_start, one message_end, one completed result; no duplicates/missing/reordered'."
  critical: "The class JSDoc MUST document this single-output invariant (item DOCS spec, Mode A)."
- url: PRD.md §20.1–§20.6 "Stream Proxy Design"
  why: "§20.1 Purpose (hide multiple upstreams behind one stream); §20.3 Output (exactly one stream);
        §20.5 Queue Ownership (proxy owns ONE outbound queue; no upstream writes directly to
        downstream); §20.6 Event Authority (exactly one upstream authoritative at any instant)."
  critical: "§20.5/§20.6 justify the get output() single-stream surface and the forward-only design:
        in this phase there is exactly one upstream and it is authoritative for the whole stream."
- url: PRD.md §19.7 "Pass-through Guarantee" + ADR-005
  why: "The wrapper must be observationally equivalent — drives the 'byte-identical' success criterion."
- url: PRD.md §38 "Event Ordering Specification" + §39 "Transition Event Rules"
  why: "The legal event sequence (start → thinking_* → text_* → toolcall_* → (done|error)) the mock
        upstream emits in tests; confirms the terminal pair is done|error."

# Architecture (already-researched context under plan/)
- file: plan/001_b0c6691bb424/architecture/system_context.md   # §AssistantMessageEventStream
  why: "Documents createAssistantMessageEventStream() push/end/[Symbol.asyncIterator]/result + the
        wrapper 'iterate upstream, push to own downstream' pattern + the AssistantMessageEvent union."
- file: plan/001_b0c6691bb424/architecture/module_contracts.md   # §StreamProxy
  why: "StreamProxy contract: constructor(model, context, options, upstreamStreamFn, coordinator),
        get output(), internal flow (create output → iterate upstream → push each → natural exit).
        NOTE: the coordinator param is P1.M4.T4 — OMITTED in this forward-only phase (item INPUT list
        has no coordinator)."
  critical: "Forward-only phase omits the coordinator. Do NOT add a coordinator param."

# Established repo conventions to mirror
- file: src/provider/decorator.ts   # (P1.M1.T4.S1 — DONE)
  why: "THE Mode-A JSDoc pattern + privacy discipline for THIS directory: module banner with
        responsibility/ownership/lifecycle/invariants/failure-modes (Appendix F), @param docs, the
        'only provider/model/api metadata ever logged' privacy note. Mirror it for proxy.ts."
  pattern: "class with readonly private fields; constructor DI; diagnostics.info/debug calls with
        allow-listed fields only; Mode-A JSDoc on every member."
- file: tests/provider-decorator.test.ts   # (P1.M1.T4.S1)
  why: "THE Bun test style in THIS repo: import { describe, test, expect } from 'bun:test'; flat
        tests/ dir; ../src/* imports; sentinel objects + `as unknown as` synthetic doubles; a
        `noopDiagnostics` stub. Reuse the noopDiagnostics stub verbatim for proxy tests."
- file: plan/001_b0c6691bb424/P1M2T1S1/PRP.md   # (parallel — CONTRACT)
  why: "Defines src/types.ts which re-exports AssistantMessageEvent from @earendil-works/pi-ai and
        exports the is*Event guards + TransitionState + ProxyPhase. This proxy imports
        AssistantMessageEvent from '../types' (single local entry point) but does NOT call any guard
        in the forward-only phase."
```

### Current Codebase tree (Phase 0 landed; Phase 1 in progress)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); type module; bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules:true, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts          # factory (P1.M1.T5.S1 — DONE; DO NOT touch)
│   ├── types.ts          # P1.M2.T1.S1 (parallel — CONTRACT: re-exports AssistantMessageEvent + guards)
│   ├── provider/
│   │   ├── decorator.ts  # DONE (P1.M1.T4.S1) — Mode-A JSDoc pattern to mirror; will consume proxy in T3
│   │   └── proxy.ts      # ← THIS SUBTASK (currently a 2-line placeholder comment)
│   ├── state/{controller,coordinator}.ts   # P1.M3 stubs (DO NOT touch)
│   ├── config/index.ts   # DONE
│   ├── diagnostics/index.ts # DONE (Diagnostics interface: trace/debug/info/warn/error)
│   ├── buffer/.gitkeep   # later
│   ├── shortcut/.gitkeep # later
│   └── request/.gitkeep  # later
├── tests/
│   ├── smoke.test.ts        # must stay green
│   ├── config.test.ts       # must stay green
│   ├── diagnostics.test.ts  # must stay green
│   ├── provider-decorator.test.ts # pattern to mirror; must stay green
│   ├── factory.test.ts      # must stay green
│   └── (types.test.ts)      # P1.M2.T1.S1 (parallel) — DO NOT touch
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── src/
│   └── provider/
│       └── proxy.ts          # REAL (replaces placeholder) — StreamProxy class (forward-only pipeline)
│   └── ...                   # all other src/ files UNCHANGED
├── tests/
│   └── stream-proxy.test.ts  # NEW — Bun tests (real AssistantMessageEventStream mock upstream)
└── dist/provider/{proxy.js,proxy.d.ts}  # GENERATED by `npx bun run build`
```
**File responsibilities**: `src/provider/proxy.ts` = the `StreamProxy` class — owns one outbound
`AssistantMessageEventStream`, forwards a single upstream into it unchanged, exposes `get output()`.
Pure forwarding; no guard logic, no state machine, no buffering/suppression (deferred). Zero imports
of other project modules except the `AssistantMessageEvent` type from `../types` (P1.M2.T1.S1) and the
`Diagnostics` type from `../diagnostics`. `tests/stream-proxy.test.ts` = order/equivalence/result +
defensive-safety-net coverage. No other file is touched (NOT the factory, NOT decorator, NOT
types/state/config, NOT package.json/tsconfig).

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (a terminal push COMPLETES the stream — do NOT call output.end()): AssistantMessageEventStream
// is an EventStream whose isComplete = (e)=>e.type==='done'||'error'. When the proxy pushes the upstream's
// terminal done/error event, output.push() sets output.done=true AND resolves output.result() in the SAME
// call. The upstream iterator's NEXT next() then returns {done:true} → the for-await exits naturally.
// Calling output.end() afterward is unnecessary; the contract explicitly says the loop "exits naturally".
// Author the loop as: for await (const event of upstream) { this.output.push(event); }  // nothing else.

// CRITICAL (no hung downstream — guard the single-terminal/single-result invariant): output.result()
// (which Pi awaits) resolves ONLY on a done/error push OR end(result). If run() throws without pushing a
// terminal, result() never resolves → Pi hangs. Wrap the loop in try/catch; on throw push a synthesized
// { type:'error', reason:'error', error: makeErrorAssistantMessage(model, String(err)) }. Because push()
// no-ops once done, this catch is TRANSPARENT in the normal path (it only fires when the upstream itself
// misbehaves by throwing instead of emitting an error event — research §4).

// CRITICAL (fire-and-forget run must not produce an unhandled rejection): the constructor starts run()
// with `void this.run(...)` and run() MUST NOT rethrow — its catch converts any error into a terminal
// error event (and if even that fails, swallow + diagnostics.error so the process never sees an
// unhandledRejection from the proxy).

// GOTCHA (import createAssistantMessageEventStream from the PACKAGE ROOT): it is re-exported via
// `export * from "./utils/event-stream.js"` in pi-ai's index. Use `from "@earendil-works/pi-ai"`, NOT a
// deep "./utils/event-stream" path (the package exports map does not expose utils/).

// GOTCHA (isolatedModules + type-only imports): AssistantMessageEventStream, AssistantMessageEvent,
// Model, Context, SimpleStreamOptions, ApiStreamSimpleFunction are TYPES → `import type`. Only
// createAssistantMessageEventStream is a VALUE → plain `import`. Split them (decorator.ts does the same).

// GOTCHA (the error event needs a REAL AssistantMessage — not a partial): the synthesized terminal
// { type:'error', reason:'error', error } must satisfy the full AssistantMessage interface (role,
// content, api, provider, model, usage, stopReason, timestamp). Use makeErrorAssistantMessage() with
// content:[], usage zeroed, stopReason:'error', errorMessage:String(err), timestamp:Date.now(), and
// api/provider/model copied from the `model` ctor param.

// GOTCHA (privacy — Appendix H): diagnostics calls pass ONLY allow-listed fields (provider/model/api
// metadata, event counts, timing). NEVER log context, options, event payloads, or AssistantMessage
// content. The synthesized-error log line logs the error CATEGORY/message string, not the AssistantMessage.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke as `npx bun ...` / `npx bun run <script>`,
// NOT bare `bun`/`tsc`. package.json scripts resolve via `npx bun run`.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → `npx bun run typecheck` checks src ONLY.
// tests/stream-proxy.test.ts is validated by `npx bun test` (Bun runs TS natively).
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// src/provider/proxy.ts — the StreamProxy class. One owned outbound stream; pure forwarding.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  ApiStreamSimpleFunction,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Api,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../diagnostics";
import type { AssistantMessageEvent as _LocalAssistantMessageEvent } from "../types"; // P1.M2.T1.S1
// NOTE: importing the re-exported AssistantMessageEvent from "../types" is the local-entry-point
// convention; but the pi-ai symbol and the re-export are the SAME type, so either source is fine.
// Prefer the re-export from "../types" to keep a single local vocabulary (matches types-module design).

/**
 * # StreamProxy — transparent forward-only event pipeline (PRD §13.2 / §20.*)
 * (responsibility / ownership / lifecycle / invariants / failure modes — Appendix F)
 * …see full JSDoc in "Implementation Patterns"…
 */
export class StreamProxy {
  private readonly output: AssistantMessageEventStream;
  private readonly diagnostics: Diagnostics;
  // (No state machine, no coordinator, no buffer, no abort controller in the forward-only phase.)

  constructor(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
    diagnostics: Diagnostics,
  ) {
    this.diagnostics = diagnostics;
    this.output = createAssistantMessageEventStream();
    void this.run(model, context, options, upstreamStreamFn); // start the pipeline; never awaited
  }

  /** The single owned outbound stream Pi consumes (PRD §20.3 Output, §20.5 Queue Ownership). */
  get output(): AssistantMessageEventStream {
    return this.output_;
  } // (renamed backing field below to avoid ctor/output clash — see Patterns)

  private async run(
    model: Model<Api>,
    _context: Context,
    _options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
  ): Promise<void> {
    try {
      const upstream = upstreamStreamFn(model, _context, _options);
      for await (const event of upstream) {
        this.output.push(event); // pure forwarding — no filter, no transform, no buffer
      }
      // Natural exit: the upstream's terminal done/error event was already pushed and already
      // completed this.output (push() sets done + resolves result() when type is done/error).
      // DO NOT call this.output.end() here — it is unnecessary and contrary to the contract.
    } catch (err) {
      // Defensive single-terminal guard (research §4): if run threw without pushing a terminal,
      // synthesize exactly one error event so the downstream result() never hangs. push() is a
      // no-op once already complete, so this is transparent in the normal path.
      this.diagnostics.warn("proxy.forward.upstream-threw", {
        provider: String(model.provider), model: model.id, error: String(err),
      });
      this.output.push({
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, err instanceof Error ? err.message : String(err)),
      });
    }
  }

  private makeErrorAssistantMessage(model: Model<Api>, message: string): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    };
  }
}
```

> **Note on the getter/backing-field naming:** a class cannot have both a `private output` field and a
> `get output()` accessor with the same name. Name the backing field `_output` (or `#output`) and the
> getter `output`. The reference in "Implementation Patterns" uses `_output`. This is a TypeScript
> requirement, not a design choice.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REPLACE src/provider/proxy.ts (2-line placeholder → full StreamProxy class)
  - OVERWRITE the placeholder comment with the reference implementation in "Implementation Patterns".
  - IMPORT (value): `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";`
  - IMPORT (type-only): ApiStreamSimpleFunction, AssistantMessage, AssistantMessageEvent,
    AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Api from "@earendil-works/pi-ai";
    Diagnostics from "../diagnostics"; AssistantMessageEvent (re-export) from "../types".
  - IMPLEMENT: `export class StreamProxy` with:
      * private readonly _output: AssistantMessageEventStream  (backing field)
      * private readonly diagnostics: Diagnostics
      * constructor(model, context, options, upstreamStreamFn, diagnostics) → sets fields, creates
        _output = createAssistantMessageEventStream(), starts `void this.run(...)`.
      * get output(): AssistantMessageEventStream { return this._output; }
      * private async run(model, _context, _options, upstreamStreamFn): Promise<void> → try {
          const upstream = upstreamStreamFn(model, _context, _options);
          for await (const event of upstream) this._output.push(event);
        } catch (err) { diagnostics.warn(...); this._output.push({ type:'error', reason:'error',
          error: this.makeErrorAssistantMessage(model, ...) }); }
      * private makeErrorAssistantMessage(model, message): AssistantMessage → minimal valid message.
  - NAMING: PascalCase class (StreamProxy); camelCase methods/fields (run, makeErrorAssistantMessage,
    _output); the public getter is `output`.
  - JSDOC (Mode A): module banner (responsibility/ownership/lifecycle/invariants/failure-modes per
    Appendix F, citing PRD §13.2 + §20.1–§20.6); class banner documenting the single-output invariant
    (exactly one message_start, one message_end [done|error], one completed result — PRD §13.2
    Guarantees); constructor @param docs; run() doc (pure forwarding + natural-exit rationale + the
    defensive try/catch); get output() doc (single owned stream, PRD §20.5).
  - PLACEMENT: src/provider/proxy.ts (the existing placeholder).
  - GOTCHA: terminal push completes the stream → NO output.end(); backing field named _output (not
    output) so the getter compiles; isolatedModules split value/type imports; fire-and-forget run must
    not rethrow (catch converts error → terminal); privacy — log only provider/model/error-string.

Task 2: CREATE tests/stream-proxy.test.ts
  - IMPLEMENT: the suite in "Test Specification" using `bun:test`.
  - IMPORT: `import { describe, test, expect } from "bun:test";`
    `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";`
    `import { StreamProxy } from "../src/provider/proxy";`
    `import type { AssistantMessageEvent, AssistantMessage } from "@earendil-works/pi-ai";`
    `import type { Diagnostics } from "../src/diagnostics";`
  - FOLLOW pattern: tests/provider-decorator.test.ts (noopDiagnostics stub verbatim; flat tests/ dir).
  - HARNESS: a `drive(proxy, mockUpstream, events)` helper that concurrently (a) iterates proxy.output
    into a `seen[]` array, (b) pushes `events` into the mockUpstream then awaits a microtask flush, so
    forwarding order/result can be asserted deterministically. Use Bun's `setTimeout`-based flush or
    a `await new Promise(r => setTimeout(r, 0))` pump between pushes.
  - COVERAGE: (1) full legal sequence [start, text_start, text_delta×2, text_end, done] → seen ===
    input AND await proxy.output.result() resolves to the done.message sentinel; (2) terminal `error`
    forwarded + result() resolves to error.error sentinel; (3) order preserved across interleaved
    thinking/text/toolcall events; (4) DEFENSIVE: an upstreamStreamFn that throws (or an iterator that
    throws) → proxy.output emits exactly one `error` event and result() resolves (no hang); (5) the
    proxy never calls output.end() in the normal path (assert via a spy on a wrapped stream OR via the
    observable fact that result() resolves from the pushed done event — prefer the latter, behavioural).
  - NAMING: describe("StreamProxy — forward-only pipeline" / "terminal forwarding" /
    "defensive error synthesis" / "observational equivalence").
  - PLACEMENT: tests/stream-proxy.test.ts (flat tests/ dir; excluded from build).

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics.
  - RUN: npx bun run build      → dist/provider/proxy.js + dist/provider/proxy.d.ts created.
  - RUN: npx bun test           → all green (stream-proxy + decorator + diagnostics + config + smoke
    + factory + types [if present]).
  - RUN: Level 3/4 gates below (node import smoke + grep assertions on proxy.ts).
```

### Implementation Patterns & Key Details

```typescript
// src/provider/proxy.ts — COMPLETE reference implementation. Author this verbatim (JSDoc included).

/**
 * # StreamProxy — transparent forward-only event pipeline.
 *
 * **Responsibility** (PRD §13.2 Stream Proxy / §20 Stream Proxy Design): present exactly one
 * continuous {@link AssistantMessageEventStream} to Pi regardless of upstream activity. In this
 * forward-only phase there is a single upstream stream that is authoritative for the whole response;
 * later phases add reasoning detection (P1.M4), abort (P1.M5), and a second spliced upstream
 * (P1.M7). This class owns the **one outbound queue** (PRD §20.5) and forwards every upstream event
 * into it unchanged.
 *
 * **Ownership**: one outbound `AssistantMessageEventStream` (created in the constructor). Owns NO
 * transition state, NO reasoning buffer, NO abort controller in this phase.
 *
 * **Lifecycle**: constructed per request on the z.ai reasoning path (P1.M2.T3.S1). The constructor
 * starts the pipeline (`run`) fire-and-forget; the pipeline completes when the upstream's terminal
 * event is forwarded. No explicit dispose — the streams garbage-collect once drained.
 *
 * **Invariants** (PRD §13.2 Guarantees):
 *  - Exactly **one** `message_start` (`start`) reaches the downstream consumer (the upstream emits
 *    exactly one; it is forwarded unchanged).
 *  - Exactly **one** terminal `message_end` (`done` OR `error`) reaches the consumer.
 *  - Exactly **one** completed result — `output.result()` resolves exactly once, to the
 *    `AssistantMessage` carried by the (single) terminal event.
 *  - No duplicate, missing, or reordered events (pure forwarding preserves order).
 *  - The downstream consumer never interacts with an upstream stream directly (PRD §20.5).
 *
 * **Failure modes**: in the normal path the upstream emits its own terminal `done`/`error` event,
 * which is forwarded and completes the stream. If `run` throws *before* a terminal is pushed (e.g.
 * `upstreamStreamFn` throws synchronously, or the upstream iterator throws), a single synthesized
 * `error` terminal is pushed so the downstream never hangs and the single-terminal/single-result
 * invariants still hold. (Network/provider failures surface as `error` *events* from the upstream and
 * are forwarded normally — the synthesis path is a defensive guard for the degenerate throw case;
 * formal failure-mode handling is P1.M8.T2.)
 *
 * Consumed by: P1.M2.T3.S1 (decorator wiring), P1.M4 (reasoning detection), P1.M5 (abort),
 * P1.M7 (splicing).
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  ApiStreamSimpleFunction,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../diagnostics";
// Re-exported by P1.M2.T1.S1 (single local vocabulary); same type as the pi-ai symbol.
import type { AssistantMessageEvent } from "../types";

export class StreamProxy {
  /** The single owned outbound stream Pi consumes (PRD §20.3/§20.5). */
  private readonly _output: AssistantMessageEventStream;
  private readonly diagnostics: Diagnostics;

  /**
   * Construct the proxy and immediately start forwarding.
   *
   * @param model            The model being streamed (api/provider/id used for diagnostics + the
   *                         synthesized-error AssistantMessage).
   * @param context          Conversation context (forwarded to upstreamStreamFn; never inspected/logged).
   * @param options          Stream options incl. reasoning level (forwarded to upstreamStreamFn).
   * @param upstreamStreamFn The captured built-in `streamSimple` (P1.M1.T4.S1) that yields the real
   *                         provider event stream. Typed {@link ApiStreamSimpleFunction}.
   * @param diagnostics      Structured logger. **Privacy (Appendix H):** only provider/model/api
   *                         metadata + error categories are ever logged — never context, options, or
   *                         event payloads.
   * @post `this.output` is a live `AssistantMessageEventStream`; the forwarding pipeline is running.
   */
  constructor(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
    diagnostics: Diagnostics,
  ) {
    this.diagnostics = diagnostics;
    this._output = createAssistantMessageEventStream();
    // Fire-and-forget: run() never rethrows (it converts any error into a single terminal event).
    void this.run(model, context, options, upstreamStreamFn);
  }

  /**
   * The single outbound stream downstream consumers (Pi) iterate. Read-only: there is no setter —
   * the queue is owned solely by this proxy (PRD §20.5 Queue Ownership). No upstream ever writes to
   * the downstream consumer directly.
   */
  get output(): AssistantMessageEventStream {
    return this._output;
  }

  /**
   * Forward every event from the single authoritative upstream into {@link output}, unchanged.
   *
   * PATTERN (pure forwarding): `for await (const event of upstream) this._output.push(event)`.
   * When the upstream emits its terminal `done`/`error` event, that `push` completes `output`
   * (sets `done` + resolves `result()` in the same call — see EventStream semantics), and the loop
   * exits naturally on the upstream iterator's next `next()`. **No `output.end()` call is made** —
   * it is unnecessary and contrary to the "exits naturally" contract.
   *
   * SAFETY NET: if this method throws before a terminal is pushed, exactly one synthesized `error`
   * terminal is pushed so `output.result()` never hangs (single-terminal/single-result invariant).
   * `push` is a no-op once the stream is complete, so this catch is transparent in the normal path.
   *
   * @returns never rejects (the catch converts any error into a terminal event or, failing that,
   *          logs + swallows so the constructor's fire-and-forget never surfaces an unhandled rejection).
   */
  private async run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
  ): Promise<void> {
    try {
      const upstream = upstreamStreamFn(model, context, options);
      for await (const event of upstream) {
        this._output.push(event);
      }
      // Natural exit — terminal already pushed; nothing more to do.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.diagnostics.warn("proxy.forward.upstream-threw", {
        provider: String(model.provider),
        model: model.id,
        error: message,
      });
      // push() no-ops if already complete → safe whether or not a terminal was already forwarded.
      this._output.push({
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, message),
      });
    }
  }

  /**
   * Build the minimal valid {@link AssistantMessage} carried by the synthesized terminal `error`
   * event when `run` catches a thrown upstream. Content/usage are zeroed; stopReason is `"error"`;
   * `errorMessage` carries the thrown message. Only used on the defensive path (never in normal flow).
   */
  private makeErrorAssistantMessage(model: Model<Api>, message: string): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    };
  }
}
```

### Integration Points

```yaml
PUBLIC SURFACE (consumed by later subtasks — keep STABLE):
  P1.M2.T3.S1 (decorator wiring):
      import { StreamProxy } from "../provider/proxy";
      const proxy = new StreamProxy(model, context, options, original.streamSimple, diagnostics);
      return proxy.output;   // the AssistantMessageEventStream Pi consumes
  P1.M4.T2 (reasoning detection): adds isThinkingEvent tracking INSIDE run(); no surface change.
  P1.M5 (abort): adds an internal AbortController + a second upstream param; surface grows then.
  P1.M7 (splicing): adds replacement-stream iteration + isTerminalEvent suppression; surface grows.

IMPORTS (this module):
  - value: createAssistantMessageEventStream  (from "@earendil-works/pi-ai" — package root)
  - types:  Api, ApiStreamSimpleFunction, AssistantMessage, AssistantMessageEventStream, Context,
            Model, SimpleStreamOptions (from "@earendil-works/pi-ai")
  - types:  Diagnostics (from "../diagnostics"); AssistantMessageEvent (from "../types" — P1.M2.T1.S1)

BUILD:
  - module: src/provider/proxy.ts (included by tsconfig include:"src/**/*.ts").
  - emit: dist/provider/proxy.js (the StreamProxy class — runtime) + dist/provider/proxy.d.ts
    (class + JSDoc). All `type` imports erased at emit; only createAssistantMessageEventStream + the
    class remain.

NO CHANGES TO: src/index.ts (factory), src/types.ts (parallel T1), src/provider/decorator.ts,
  src/state/*, src/config/*, src/diagnostics/*, package.json, tsconfig.json, .gitignore, or any
  existing test. Only src/provider/proxy.ts is edited + tests/stream-proxy.test.ts is added.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — intentional):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. Common failures:
#   - "Cannot find name 'createAssistantMessageEventStream'" → confirm value import from
#     "@earendil-works/pi-ai" (package root), NOT a deep "./utils/event-stream" path.
#   - "Duplicate identifier 'output'" → the backing field MUST be named _output (#output), not
#     `output` (a class cannot have both a field and a getter of the same name).
#   - AssistantMessage missing fields in makeErrorAssistantMessage → ensure role/content/api/provider/
#     model/usage/stopReason/timestamp all present; usage.cost + the 5 numeric fields all present.
#   - isolatedModules error → confirm type-only symbols use `import type`.

# Build (emit dist):
npx bun run build            # = tsc
# Expected: dist/provider/proxy.js + dist/provider/proxy.d.ts created; exit 0.
ls dist/provider/proxy.*
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`
> (verified working in this repo).

### Level 2: Unit Tests (Component Validation)

```bash
# Run the proxy suite alone:
npx bun test tests/stream-proxy.test.ts
# Expected: all green — legal-sequence forwarding, terminal forwarding (done AND error), order
#   preservation, result() resolution to the carried AssistantMessage sentinel, and the defensive
#   error-synthesis path on a throwing upstream (exactly one error event, result() resolves).

# Full suite (proxy + types[if present] + factory + decorator + diagnostics + config + smoke):
npx bun test
# Expected: every test passes; nothing regressed.
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.

### Level 3: Integration (Package Integrity)

```bash
# Verify the emitted module is importable as built JS and exposes StreamProxy as a class:
node -e "import('./dist/provider/proxy.js').then(m => console.log({
  StreamProxy: typeof m.StreamProxy,
  hasOutput: !!m.StreamProxy.prototype && !!Object.getOwnPropertyDescriptor(m.StreamProxy.prototype, 'output')
}))"
# Expected: { StreamProxy: 'function', hasOutput: true }  (a getter exists on the prototype).

# Behavioural smoke against built JS: feed a real AssistantMessageEventStream mock upstream and assert
# the proxy forwards + completes result().
node -e "
import('./dist/provider/proxy.js').then(async ({ StreamProxy }) => {
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const upstream = createAssistantMessageEventStream();
  const model = { id:'glm-4.7', api:'openai-completions', provider:'zai' };
  const proxy = new StreamProxy(model, {}, {}, () => upstream, {trace(){},debug(){},info(){},warn(){},error(){}});
  const seen = [];
  (async () => { for await (const e of proxy.output) seen.push(e.type); })();
  upstream.push({ type:'start' });
  upstream.push({ type:'text_delta', delta:'hi', contentIndex:0 });
  upstream.push({ type:'done', reason:'stop', message:{ role:'assistant' } });
  await new Promise(r => setTimeout(r, 10));
  console.log('forwarded:', seen.join(','));
  console.log('result role:', (await proxy.output.result()).role);
}).catch(e => { console.error(e); process.exit(1); });
"
# Expected: forwarded: start,text_delta,done  AND  result role: assistant
#   (proves pure forwarding + that the pushed `done` completed result() WITHOUT output.end()).
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Pure-forwarding gate — the loop body is ONLY a push (no end(), no filter, no transform):
grep -n "this._output.push(event)\|output.end()\|\.filter(\|\.map(\|continue;\|break;" src/provider/proxy.ts
# Expected: exactly one "this._output.push(event)" in run(); ZERO output.end() calls; ZERO filter/map/
#   continue/break in the forwarding loop. (The synthesized-error push in the catch is allowed.)

# Single-output gate — exactly one createAssistantMessageEventStream + a read-only getter:
grep -n "createAssistantMessageEventStream()" src/provider/proxy.ts     # Expected: exactly 1 (in ctor)
grep -n "get output(" src/provider/proxy.ts                            # Expected: exactly 1
grep -n "set output" src/provider/proxy.ts                             # Expected: ZERO (no setter)

# Defensive-terminal gate — run() is wrapped in try/catch that pushes an error event:
grep -n "catch (err)" src/provider/proxy.ts                            # Expected: exactly 1 (in run)
grep -n 'type: "error"' src/provider/proxy.ts                          # Expected: exactly 1 (synthesized)

# Privacy gate — diagnostics never receives context/options/payloads:
grep -n "diagnostics\." src/provider/proxy.ts
# Expected: ONLY warn("proxy.forward.upstream-threw", { provider, model, error }) — allow-listed fields.

# Import-path gate — createAssistantMessageEventStream from the package ROOT, not a deep path:
grep -n 'from "@earendil-works/pi-ai"' src/provider/proxy.ts           # Expected: 2 lines (value + type)
grep -n 'utils/event-stream' src/provider/proxy.ts                     # Expected: ZERO (no deep import)

# Confirm git sees only the intended changes (no edits to other modules):
git add -A && git status --short
# Expected: MODIFIED src/provider/proxy.ts, NEW tests/stream-proxy.test.ts (+ regenerated dist/* if not
#   git-ignored). src/index.ts, src/types.ts, src/provider/decorator.ts, src/state/*, src/config/*,
#   src/diagnostics/* unchanged.
```

---

## Test Specification (reference suite — implement with `bun:test`)

```typescript
// tests/stream-proxy.test.ts

import { describe, test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StreamProxy } from "../src/provider/proxy";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles ---------------------------------------------------------

/** Reuse the exact noop Diagnostics stub style from provider-decorator.test.ts. */
const noopDiagnostics: Diagnostics = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as Diagnostics;

/** A minimal Model<Model["api"]> stand-in. Only .id/.api/.provider are read by the proxy. */
function makeModel() {
  return { id: "glm-4.7", api: "openai-completions", provider: "zai" } as unknown as Parameters<
    typeof StreamProxy
  >[0]; // model ctor param type
}

/** Build a synthetic AssistantMessageEvent carrying only what each case needs. */
function ev(partial: { type: string } & Partial<AssistantMessageEvent>): AssistantMessageEvent {
  return { ...partial } as unknown as AssistantMessageEvent;
}

const DONE_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;
const ERROR_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;

/**
 * Drive the proxy: concurrently iterate proxy.output into `seen`, push `events` into `mockUpstream`
 * (one per tick), then flush. Returns the drained events + the resolved result (if any).
 */
async function drive(
  mockUpstream: AssistantMessageEventStream,
  events: AssistantMessageEvent[],
): Promise<{ seen: string[]; result?: AssistantMessage }> {
  const proxy = new StreamProxy(makeModel(), {} as never, {} as never, () => mockUpstream, noopDiagnostics);
  const seen: string[] = [];
  let result: AssistantMessage | undefined;
  const consumer = (async () => {
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    result = await proxy.output.result();
  })();
  // Push one event per macrotask so the async iterators interleave deterministically.
  for (const e of events) {
    mockUpstream.push(e);
    await new Promise((r) => setTimeout(r, 0));
  }
  await consumer;
  return { seen, result };
}

// --- forwarding + order ---------------------------------------------------

describe("StreamProxy — forward-only pipeline", () => {
  test("forwards a full legal event sequence unchanged and in order", async () => {
    const upstream = createAssistantMessageEventStream();
    const { seen } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
      ev({ type: "thinking_end", contentIndex: 0, content: "hm" }),
      ev({ type: "text_start", contentIndex: 1 }),
      ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
      ev({ type: "text_delta", contentIndex: 1, delta: "!" }),
      ev({ type: "text_end", contentIndex: 1, content: "Hi!" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]);
    expect(seen).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  test("preserves order across many deltas (no reordering, no drops)", async () => {
    const upstream = createAssistantMessageEventStream();
    const deltas = Array.from({ length: 50 }, (_, i) =>
      ev({ type: "text_delta", contentIndex: 0, delta: String(i) }),
    );
    const { seen } = await drive(upstream, [
      ev({ type: "start" }),
      ...deltas,
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]);
    expect(seen.length).toBe(52); // start + 50 deltas + done
    expect(seen[0]).toBe("start");
    expect(seen.at(-1)).toBe("done");
  });
});

// --- terminal forwarding + result() --------------------------------------

describe("StreamProxy — terminal forwarding", () => {
  test("forwards `done` and result() resolves to its carried message (no output.end needed)", async () => {
    const upstream = createAssistantMessageEventStream();
    const { result } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ]);
    expect(result).toBe(DONE_MESSAGE); // identity preserved — same object the upstream carried
  });

  test("forwards `error` and result() resolves to its carried message", async () => {
    const upstream = createAssistantMessageEventStream();
    const { seen, result } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "error", reason: "error", error: ERROR_MESSAGE }),
    ]);
    expect(seen).toEqual(["start", "error"]);
    expect(result).toBe(ERROR_MESSAGE);
  });
});

// --- defensive error synthesis (single-terminal / no-hang invariant) ------

describe("StreamProxy — defensive error synthesis", () => {
  test("a throwing upstreamStreamFn still terminates output with exactly one error (no hang)", async () => {
    const boom = () => {
      throw new Error("upstream blew up");
    };
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, boom, noopDiagnostics);
    const seen: string[] = [];
    let result: AssistantMessage | undefined;
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    result = await proxy.output.result();
    expect(seen).toEqual(["error"]);            // exactly one terminal
    expect(result).toBeDefined();               // result() resolved → no hang
    expect(result!.stopReason).toBe("error");
    expect(result!.errorMessage).toBe("upstream blew up");
  });

  test("an upstream iterator that throws mid-stream terminates output with one error", async () => {
    async function* throwingIterator(): AsyncIterable<AssistantMessageEvent> {
      yield ev({ type: "start" });
      yield ev({ type: "thinking_delta", contentIndex: 0, delta: "x" });
      throw new Error("iterator exploded");
    }
    const throwingStream = {
      [Symbol.asyncIterator]: () => throwingIterator()[Symbol.asyncIterator](),
    } as unknown as AssistantMessageEventStream;
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => throwingStream,
      noopDiagnostics,
    );
    const seen: string[] = [];
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
    expect(seen).toEqual(["start", "thinking_delta", "error"]); // forwarded-then-synthesized
    expect(await proxy.output.result()).toBeDefined();
  });
});

// --- observational equivalence -------------------------------------------

describe("StreamProxy — observational equivalence", () => {
  test("output stream IS a fresh AssistantMessageEventStream (not the upstream identity)", () => {
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(
      makeModel(),
      {} as never,
      {} as never,
      () => upstream,
      noopDiagnostics,
    );
    expect(proxy.output).not.toBe(upstream); // downstream never touches the upstream directly (§20.5)
  });
});
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run typecheck` → **zero** diagnostics (value/type imports split; `_output` backing
      field so the getter compiles; `makeErrorAssistantMessage` produces a complete `AssistantMessage`).
- [ ] `npx bun run build` emits `dist/provider/proxy.js` + `dist/provider/proxy.d.ts` with `StreamProxy`.
- [ ] `npx bun test tests/stream-proxy.test.ts` → all green.
- [ ] `npx bun test` → all green (decorator + diagnostics + config + smoke + factory still passing).
- [ ] Level 3 node smoke: built `dist/provider/proxy.js` exposes `StreamProxy` (function) + an
      `output` getter; feeding a real mock upstream forwards `start,text_delta,done` and `result()`
      resolves with the carried message — WITHOUT any `output.end()` call.

### Feature Validation
- [ ] `StreamProxy` exports the constructor `(model, context, options, upstreamStreamFn, diagnostics)`,
      the `get output()` getter, the private `run`, and the private `makeErrorAssistantMessage`.
- [ ] Forwarding loop is **pure** — `for await (const event of upstream) this._output.push(event)` with
      NO `output.end()`, NO filtering, NO transformation, NO buffering.
- [ ] **Byte-identical**: a mock upstream's full legal sequence appears unchanged and in order on
      `proxy.output`; `result()` resolves to the carried `AssistantMessage`.
- [ ] **Defensive invariant**: a throwing `upstreamStreamFn`/iterator yields exactly one synthesized
      `error` terminal and a resolved `result()` (no hung stream) — single-terminal/single-result holds.
- [ ] `proxy.output` is a fresh stream distinct from the upstream (downstream never touches upstream
      directly — PRD §20.5).

### Code Quality Validation
- [ ] Mirrors `src/provider/decorator.ts` Mode-A JSDoc + privacy discipline (only provider/model/api
      metadata + error categories ever logged).
- [ ] Single source of the outbound stream (exactly one `createAssistantMessageEventStream()`); read-only
      `output` getter (no setter).
- [ ] Fire-and-forget `run()` never rethrows (catch → terminal event, or swallow + log) — no unhandled
      rejection from the constructor's `void this.run(...)`.
- [ ] Type-only imports use `import type`; `createAssistantMessageEventStream` imported from the package
      root (`@earendil-works/pi-ai`), not a deep path.
- [ ] Only `src/provider/proxy.ts` edited + `tests/stream-proxy.test.ts` added; no edits to the factory,
      `src/types.ts` (parallel), decorator, state, config, diagnostics, package.json, tsconfig, .gitignore.

### Documentation & Deployment
- [ ] Module banner documents responsibility/ownership/lifecycle/invariants/failure-modes (Appendix F).
- [ ] Class JSDoc documents the **single-output invariant** (PRD §13.2: exactly one `message_start`, one
      `message_end` [`done`|`error`], one completed result) — item DOCS spec (Mode A).
- [ ] `run()` JSDoc explains the natural-exit rationale (terminal `push` completes the stream) and the
      defensive try/catch; `get output()` JSDoc cites PRD §20.5 Queue Ownership.
- [ ] `dist/provider/proxy.d.ts` carries the JSDoc for downstream consumers (P1.M2.T3.S1+).

---

## Anti-Patterns to Avoid

- ❌ Don't call `this._output.end()` after forwarding the terminal event — a terminal `push` already
  completes the stream (sets `done` + resolves `result()`). The contract says the loop "exits
  naturally"; `end()` is unnecessary and signals a misunderstanding of `EventStream` semantics.
- ❌ Don't name the backing field `output` — a class cannot have a field and a getter of the same name
  (`Duplicate identifier 'output'`). Use `_output` (or `#output`) and a `get output()` accessor.
- ❌ Don't filter/transform/buffer events, switch on `event.type`, or call any `is*Event` guard in this
  phase — that is reasoning detection (P1.M4) / suppression (P1.M7). This is **pure forwarding**.
- ❌ Don't add a `coordinator` constructor param — the forward-only phase has no coordinator (item INPUT
  list omits it; coordinator is P1.M4.T4). Keep the constructor exactly the 5 specified params.
- ❌ Don't let `run()` reject (or rethrow) — the constructor starts it fire-and-forget (`void
  this.run(...)`); an unhandled rejection would crash/warn. Convert any error into a single terminal
  `error` event (or, failing that, log + swallow).
- ❌ Don't leave the downstream able to hang — if `run` throws before a terminal is pushed, `result()`
  would never resolve. The try/catch that pushes a synthesized `error` is what guards the single-
  terminal/single-result invariant; do not remove it as "out of scope" (it is the minimal safety net).
- ❌ Don't import `createAssistantMessageEventStream` from a deep `"@earendil-works/pi-ai/utils/..."`
  path — the package `exports` map does not expose `utils/`; use the package root.
- ❌ Don't log context, options, event payloads, or `AssistantMessage` content to diagnostics — Appendix
  H forbids it. Only provider/model/api metadata + error category strings are allow-listed.
- ❌ Don't touch `src/types.ts` (parallel T1), `src/provider/decorator.ts`, the factory, state, config,
  diagnostics, package.json, tsconfig, or any existing test — this subtask owns ONLY
  `src/provider/proxy.ts` + `tests/stream-proxy.test.ts`.
