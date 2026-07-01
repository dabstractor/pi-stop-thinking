# PRP — P1.M6.T1.S1: RequestBuilder with thinking-disabled transformation (`src/request/builder.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M6.T1.S1 (Phase 5 Replacement Generation, 2 pts) — the **pure** request constructor that, after a
> genuine clean abort (`Capturing`, buffer frozen — produced by P1.M5), builds the **replacement provider request** with
> **reasoning disabled** while preserving the conversation, the user prompt, the model, and every sampling option.
> **Work-item contract (verbatim logic)**: `RequestBuilder.buildReplacement(model, context, options, reasoningSnapshot)`
> returns `{ model, context, options }` where the new options object is `{ ...options, reasoning: undefined }`. The model
> and context are returned as the **same references** (PRD §25.3 context reuse, §25.4 prompt reuse, §25.7 model preserved).
> The ephemeral execution directive (PRD §53 / §25.5) is optional and **omitted by default in MVP**. **The method is pure
> (no side effects, no network).** **Consumed by**: **P1.M7.T1** (StreamProxy invokes the replacement via
> `original.streamSimple(triple.model, triple.context, triple.options)`; P1.M7 owns the replacement's abort signal —
> see §Integration Points / signal boundary).

---

## Goal

**Feature Goal**: Provide a single, deterministic, **pure** constructor — `RequestBuilder.buildReplacement(...)` — that
transforms the original (interrupted) z.ai request into a **thinking-disabled replacement request triple** by overriding
exactly one field (`options.reasoning → undefined`) and preserving everything else verbatim. This is the PRD §31
RequestBuilder Module and the sole producer of the PRD §53 Replacement Request for the splicing pipeline.

**Deliverable** (ONE source file CREATED + ONE test file CREATED; NO other files change — see Scope Boundary):
- `src/request/builder.ts` — **CREATE**: the `RequestBuilder` class (DI of `Diagnostics`), the
  `ReplacementRequest` return-type interface, and the `buildReplacement(model, context, options, reasoningSnapshot)`
  instance method whose body is exactly the pure transform `{ ...options, reasoning: undefined }` + a single
  privacy-safe `debug("request.replacement-built", {})` milestone. Comprehensive Mode-A JSDoc citing PRD
  §25.3/§25.4/§25.5/§25.6/§25.7/§31/§53 and the z.ai `enable_thinking` mechanism.
- `tests/request-builder.test.ts` — **NEW** `bun:test` suite: thinking-disabled transform; full option
  preservation (apiKey/temperature/maxTokens/sessionId/headers/signal/…); same-ref model & context pass-through;
  input NON-mutation (purity); idempotent-on-already-undefined; frozen-snapshot accepted; exact triple shape;
  privacy (debug fields `{}` only).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0;
`npx bun test` → **ALL green** — the new `request-builder.test.ts` PLUS every pre-existing suite (incl. P1.M5 abort +
race tests) with **ZERO changes and ZERO regressions**. The transform sets `replacement.options.reasoning === undefined`
regardless of the original level; every other option field is byte-identical; the returned `model`/`context` are `===`
the inputs; the original `options` object is **not mutated**. No edits to any file other than the new
`src/request/builder.ts` + `tests/request-builder.test.ts` (and removing the now-redundant `src/request/.gitkeep`).

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing (the RequestBuilder is a pure transform consumed by the splicing pipeline).
The end user triggers it indirectly: they press `ctrl+.`, the reasoning stream is cleanly aborted (`Capturing`, buffer
frozen), and P1.M7 uses this builder to construct the thinking-disabled continuation so the model stops reasoning and
answers immediately.

**Use Case**: After a clean abort, P1.M7 calls
`const triple = builder.buildReplacement(model, context, options, buffer.snapshot())`, then invokes the replacement
provider stream from that triple. The model receives the SAME conversation + SAME prompt + SAME model + SAME sampling,
but with reasoning OFF — so it emits an answer instead of resuming an extended reasoning phase.

**Pain Points Addressed**: Without a single, pure, well-tested transform, the disable-thinking knob is scattered and
easy to get subtly wrong (e.g. `reasoning: "off"` routes through `clampThinkingLevel` which may misbehave for z.ai;
omitting the field silently; accidentally mutating the caller's `options`). Centralizing it as one pure, JSDoc'd method
removes that entire class of bugs and gives P1.M7 a contract it can trust.

---

## Why

- **It is the explicit PRD §31 / §53 contract.** PRD §31: "Construct replacement provider request … Original user
  prompt preserved, Conversation preserved, Thinking disabled, Sampling preserved by default, Model preserved."
  PRD §53 Transformation Rules: Preserve {conversation, user prompt, assistant history, model, sampling, provider};
  Modify {thinking configuration}; Do not modify {user intent, conversation ordering, session identity, visible history}.
- **The disable-thinking mechanism is non-obvious and z.ai-specific (PRD §25.6).** For z.ai, disabling reasoning means
  setting `enable_thinking=false` in the provider payload, which (per `openai-completions.js`) happens iff
  `options.reasoning` is `undefined`/absent. Encoding this as ONE pure method with Mode-A JSDoc prevents every future
  caller from re-deriving (and mis-deriving) the knob.
- **It is the producer gate for P1.M7 (splicing).** P1.M7.T1 needs a ready-to-invoke triple. This subtask delivers
  exactly that — a `{ model, context, options }` triple that can be passed straight to `original.streamSimple(...)`.
- **It is minimal and side-effect-free.** The body is one spread + one field override. It touches NO network, NO
  streams, NO state, and mutates none of its inputs (PRD §31 Non-responsibilities: Network, Streaming, Retries).

---

## What

### Source: CREATE `src/request/builder.ts`

#### A. Imports

```typescript
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingEntry } from "../buffer"; // == ReasoningBuffer.snapshot()'s element type (PRD §13.4)
import type { Diagnostics } from "../diagnostics";
```

> All imports are `import type` (values are never needed — the transform is pure object construction). This is
> `isolatedModules`-safe and matches `src/buffer/index.ts` / `src/state/coordinator.ts`.

#### B. Return-type interface

```typescript
/**
 * The output of {@link RequestBuilder.buildReplacement}: the thinking-disabled replacement provider request triple
 * (PRD §53 Outputs / §31 Outputs "Replacement request"). A ready-to-invoke bundle passed straight to
 * `original.streamSimple(model, context, options)` by the splicing pipeline (P1.M7.T1).
 *
 * - `model`    The SAME `Model<Api>` reference as the input (PRD §25.7 model preserved — no copy, no switching).
 * - `context`  The SAME `Context` reference as the input (PRD §25.3 context reuse / §25.4 prompt reuse — never rewritten).
 * - `options`  A FRESH `SimpleStreamOptions` object = `{ ...originalOptions, reasoning: undefined }`: every original
 *              field preserved verbatim (apiKey, temperature, maxTokens, sessionId, headers, signal, …) with the single
 *              exception that `reasoning` is forced to `undefined` to disable thinking (PRD §25.6). Plain (unfrozen) so
 *              the consumer (P1.M7) may spread/override it (e.g. inject a fresh abort signal) before invoking the stream.
 */
export interface ReplacementRequest {
  /** Same reference as the input model (PRD §25.7). */
  readonly model: Model<Api>;
  /** Same reference as the input context (PRD §25.3/§25.4). */
  readonly context: Context;
  /** Fresh options object: all original fields preserved, `reasoning` forced to `undefined` (PRD §25.6). */
  readonly options: SimpleStreamOptions;
}
```

#### C. The class + method (the entire logic)

```typescript
/**
 * # RequestBuilder — construct the thinking-disabled replacement provider request (PRD §31 / §53 / §25).
 *
 * **Responsibility** (PRD §31): "Construct replacement provider request." This module is the single producer of the
 * PRD §53 Replacement Request: a pure transform of the interrupted request's `(model, context, options)` into a triple
 * that continues the SAME logical interaction with reasoning turned OFF.
 *
 * **Ownership**: NONE beyond its inputs/outputs. Owns NO stream, NO abort controller, NO buffer, NO network. The method
 * constructs one fresh options object and returns the triple; it holds no state across calls.
 *
 * **Purity** (PRD §31 + work-item contract "pure, no side effects, no network"): the transformation is deterministic and
 * side-effect-free — it performs NO network call, mutates NONE of its arguments, and is referentially transparent (same
 * inputs ⇒ structurally equal output). The only observable "effect" is a single fire-and-forget `debug` diagnostics
 * milestone, which by the {@link Diagnostics} contract "never modifies runtime behavior" — so behaviorally the method
 * remains pure. (Mirrors `ReasoningBuffer`, an otherwise-pure collection that still emits lifecycle diagnostics.)
 *
 * **Transformation** (PRD §25.6 / §53 "Modify: thinking configuration"):
 *  - Preserve: conversation/context, user prompt, assistant history, model, sampling parameters, provider, session
 *    identity (PRD §25.3/§25.4/§25.7/§53 "Preserve").
 *  - Modify: `options.reasoning → undefined` (the ONE field touched).
 *  - Omit (MVP): the optional ephemeral execution directive (PRD §53 "Ephemeral Execution Directive" / §25.5). The
 *    `reasoningSnapshot` parameter is accepted for API completeness and forward-compat but is NOT read in MVP.
 *  - Do NOT modify: user intent, conversation ordering, visible history (PRD §53 "Do not modify").
 *
 * **How reasoning is disabled for z.ai** (PRD §25.6; confirmed in
 * `@earendil-works/pi-ai/dist/providers/openai-completions.js`): the provider derives
 * `reasoningEffort = options?.reasoning ? clampThinkingLevel(...) : undefined`, then sets
 * `params.enable_thinking = !!reasoningEffort`. With `options.reasoning === undefined`, `reasoningEffort` is `undefined`,
 * so `enable_thinking = !!undefined === false` → reasoning DISABLED. Setting `reasoning: undefined` (NOT `"off"`) is the
 * minimal, unconditionally-safe knob: `undefined` short-circuits BEFORE `clampThinkingLevel` runs.
 *
 * **Non-responsibilities** (PRD §31): Network, Streaming, Retries.
 *
 * Consumed by: P1.M7.T1 (StreamProxy invokes the replacement via `original.streamSimple(triple.model,
 * triple.context, triple.options)`; P1.M7 owns the replacement's abort signal — it overrides `options.signal` at
 * invocation time, NOT here).
 */
export class RequestBuilder {
  /**
   * @param diagnostics Shared structured logger (PRD §36). **Privacy (Appendix H):** only the lifecycle event name is
   *                    ever logged — never prompt/context/options/reasoning content. The single milestone emits `{}`.
   */
  constructor(private readonly diagnostics: Diagnostics) {}

  /**
   * Build the thinking-disabled replacement request triple (PRD §25 / §31 / §53).
   *
   * Pure transform: returns `{ model, context, options }` where
   *   - `model` and `context` are the **same references** as the inputs (PRD §25.3/§25.4/§25.7 — no rewrite, no copy);
   *   - `options` is a fresh object = `{ ...options, reasoning: undefined }` — every original field preserved verbatim
   *     with `reasoning` forced to `undefined` (disables thinking per PRD §25.6 / the z.ai `enable_thinking` mechanism).
   *
   * The `reasoningSnapshot` (the frozen `ReasoningBuffer.snapshot()` from the aborted reasoning phase) is accepted for
   * the optional ephemeral execution directive (PRD §53 "Ephemeral Execution Directive" / §25.5) and forward-compat;
   * it is **NOT read in MVP** (the directive is omitted by default).
   *
   * - Preconditions: `model`, `context`, `options` are the values from the interrupted request; `reasoningSnapshot` is
   *   the frozen snapshot (`ReasoningBuffer.snapshot()`, post-`freeze()`). `options` may or may not carry `reasoning`.
   * - Postconditions: returns a {@link ReplacementRequest} with same-ref `model`/`context` and a fresh `options` whose
   *   `reasoning === undefined`; the input `options` object is NOT mutated; NO network/stream is touched.
   * - Side effects: one `debug("request.replacement-built", {})` lifecycle milestone (privacy-safe — `{}` only).
   * - @throws never (object construction + a fire-and-forget log; total function).
   *
   * @param model             The interrupted request's model (PRD §25.7 — preserved).
   * @param context           The interrupted request's conversation context (PRD §25.3/§25.4 — preserved).
   * @param options           The interrupted request's stream options (all fields preserved; `reasoning` → `undefined`).
   * @param reasoningSnapshot Frozen reasoning snapshot (PRD §53). Reserved for the optional ephemeral directive; unused
   *                          in MVP.
   * @returns The thinking-disabled replacement request triple (PRD §53 Outputs).
   */
  buildReplacement(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    // Reserved for the optional ephemeral execution directive (PRD §53/§25.5); NOT read in MVP.
    // tsconfig has no `noUnusedParameters`, so the documented-but-unused param compiles cleanly.
    reasoningSnapshot: readonly ThinkingEntry[],
  ): ReplacementRequest {
    // PURE TRANSFORM (PRD §25.6 / §53 "Modify: thinking configuration"): preserve every original field, force
    // reasoning OFF. `{ ...options, reasoning: undefined }` overrides any original level ("high"/"medium"/…) with
    // undefined, which makes the z.ai provider set enable_thinking=false (see module JSDoc). model + context are the
    // SAME references (PRD §25.3/§25.4/§25.7). options is left UNFROZEN so P1.M7 may override its signal before invoking.
    const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
    this.diagnostics.debug("request.replacement-built", {}); // lifecycle milestone; privacy-safe — {} only
    return { model, context, options: replacementOptions };
  }
}
```

> **JSDoc convention (Mode-A):** every member carries a JSDoc citing the PRD anchor (§25.3/§25.4/§25.5/§25.6/§25.7/
> §31/§53) + the z.ai `enable_thinking` mechanism, matching `src/buffer/index.ts`, `src/state/controller.ts`, and
> `src/provider/proxy.ts`. **Privacy (Appendix H):** the one diagnostics call logs `{}` only — never context, options,
> reasoning, or prompt content.

### Test: CREATE `tests/request-builder.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`). Reuse the project's canonical capturing
diagnostics stub `makeCaptureDiag()` VERBATIM from `tests/reasoning-buffer.test.ts`. Build minimal `Model<Api>`,
`Context`, and `SimpleStreamOptions` mocks inline (typed; only the fields each case needs). Coverage:

- **Thinking disabled — overrides an active level**: `options = { reasoning: "high", temperature: 0.7, apiKey: "k" }`
  → `triple.options.reasoning === undefined`. (The headline assertion: an explicit `"high"` is forcibly cleared.)
- **Thinking disabled — already undefined / absent**: pass `options` with `reasoning: undefined` and a separate case
  with no `reasoning` key at all → both yield `triple.options.reasoning === undefined` (idempotent; no throw).
- **Everything else preserved**: pass a rich `options` (`temperature`, `maxTokens`, `apiKey`, `sessionId`, `headers`,
  `signal`, `timeoutMs`, `maxRetries`, `thinkingBudgets`, `metadata`) → assert each field on `triple.options` is `===`
  the input value. (Spot-check a few by value; assert `headers === input.headers` by reference too — shallow share is
  expected/correct.)
- **Model pass-through (PRD §25.7)**: `triple.model === inputModel` (strict identity — same reference, NOT a copy).
- **Context pass-through (PRD §25.3/§25.4)**: `triple.context === inputContext` (strict identity — never rewritten).
- **Input NOT mutated (purity)**: after the call, the ORIGINAL `options.reasoning` is unchanged (still `"high"`); the
  original `options` object has no new keys added. Proves no side effect on the caller's object.
- **Frozen snapshot accepted**: build a real `ReasoningBuffer`, `append`/`freeze`, pass `buffer.snapshot()`
  (`readonly ThinkingEntry[]`, frozen) as `reasoningSnapshot` → no throw (the param is accepted; MVP does not read it).
- **Exact triple shape**: `Object.keys(triple).sort() === ["context", "model", "options"]` — exactly the three keys.
- **Replacement options is a fresh object**: `triple.options !== inputOptions` (a new object, not the same reference)
  AND `triple.options` is NOT frozen (so P1.M7 may spread/override — e.g. inject a signal). Assert
  `Object.isFrozen(triple.options) === false`.
- **No network / no streaming**: the builder is constructed with ONLY a diagnostics stub (no stream function is passed
  anywhere); constructing + calling it performs no I/O. (Implicit — there is no `streamSimple` parameter to spy; the
  test asserts the call returns synchronously with the triple.)
- **Privacy guard (Appendix H)**: the `debug("request.replacement-built", …)` call's `fields` is exactly `{}` — assert
  via the captured diagnostics that the event fired once with no content/prompt/options keys.

**Out of scope** (owned by other subtasks — do NOT implement/modify here):
- **Invoking the replacement stream + splicing + abort coordination of the replacement** → **P1.M7.T1/T2/T3**. This
  builder returns the triple; P1.M7 calls `original.streamSimple(...)` from it and owns the replacement's signal.
- **The ephemeral execution directive** (PRD §53/§25.5) → a future enhancement; explicitly **omitted in MVP** (the
  `reasoningSnapshot` param is reserved/unused).
- **System-prompt augmentation** (PRD §25.5) → optional; omitted in MVP (context is passed through unchanged).
- Any change to `src/provider/proxy.ts`, `src/state/*`, `src/buffer/*`, `src/provider/decorator.ts`, `src/config/*`,
  `src/diagnostics/*`, `src/shortcut/*`, `src/index.ts`, `src/types.ts`, or any existing test. No new dependencies.

### Success Criteria

- [ ] `src/request/builder.ts` exports `class RequestBuilder` (DI of `Diagnostics`) and `interface ReplacementRequest`.
- [ ] `buildReplacement(model, context, options, reasoningSnapshot)` returns a `ReplacementRequest` whose `options` is a
      fresh object = `{ ...options, reasoning: undefined }`; `model`/`context` are the SAME input references.
- [ ] The transform sets `reasoning === undefined` whether the input carried `"high"`/`undefined`/no key (idempotent).
- [ ] Every other `SimpleStreamOptions` field is preserved verbatim; the input `options` object is NOT mutated.
- [ ] Exactly ONE `debug("request.replacement-built", {})` milestone is emitted per call; no content is ever logged.
      `reasoningSnapshot` is accepted (typed `readonly ThinkingEntry[]`) and unused in MVP (no `noUnusedParameters`).
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green (every
      pre-existing suite + the new `request-builder` tests), zero regressions.

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have everything needed to
implement this successfully?"_ → YES. The exact imports, return-type interface, class body, the verbatim transform, and
the test coverage are reproduced above. The non-obvious facts — (1) **why** `reasoning: undefined` and NOT `"off"`
(`undefined` short-circuits before `clampThinkingLevel`; confirmed in compiled `openai-completions.js`), (2) **why** the
method may emit a `debug` trace yet still be "pure" (diagnostics never modify runtime behavior; mirrors
`ReasoningBuffer`), (3) **why** `model`/`context` are same-ref and `options` is a fresh unfrozen object (PRD
§25.3/§25.4/§25.7 + the P1.M7 signal-override boundary), and (4) **why** `reasoningSnapshot` is accepted-but-unused
(MVP omits the ephemeral directive; `tsconfig` has no `noUnusedParameters`) — are all explained in "Why" +
`research/notes.md` §1–§5.

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask
- url: PRD.md "# 31. RequestBuilder Module"
  why: "The module spec: Responsibility 'Construct replacement provider request'; Inputs {Original request,
        Configuration, Reasoning snapshot, Transition metadata}; Outputs 'Replacement request'; Rules {prompt preserved,
        conversation preserved, thinking disabled, system augmentation optional, sampling preserved by default, model
        preserved}; Non-responsibilities {Network, Streaming, Retries}."
  critical: "Thinking disabled + sampling/model/conversation/prompt preserved are the binding rules; Network/Streaming/
             Retries are explicitly OUT — confirms the method must be pure."

- url: PRD.md "# 53. Replacement Request Specification"
  why: "Inputs {Original request context, Conversation history, Original model, Original sampling parameters, Frozen
        reasoning snapshot, Configuration}; Transformation Rules — Preserve {Conversation, User prompt, Assistant
        history, Model, Sampling parameters, Provider}; Modify {Thinking configuration, Ephemeral execution directive,
        Internal transition metadata}; Do not modify {User intent, Conversation ordering, Session identity, Visible
        history}."
  critical: "The EXACT preserve/modify/do-not-modify matrix this transform implements. The frozen reasoning snapshot is a
             listed INPUT (hence the param) and the ephemeral directive is the MVP-omitted modification."

- url: PRD.md "# 25. Replacement Request Construction"  (§25.3 Context Reuse, §25.4 Prompt Reuse, §25.5 System Prompt,
        §25.6 Thinking Configuration, §25.7 Model Selection, §25.8 Temperature)
  why: "§25.6 'The replacement request shall disable reasoning. The exact mechanism is implementation-specific and
        depends upon the provider payload. For z.ai this includes disabling the provider's reasoning mode and omitting
        any reasoning effort configuration that would reactivate thinking.' §25.3/§25.4/§25.7 = reuse unchanged."
  critical: "§25.6 authorizes the z.ai-specific enable_thinking=false mechanism; §25.3/§25.4/§25.7 mandate same-ref
             pass-through of context/prompt/model."

- url: PRD.md "# 26. Prompt Morphing Philosophy"
  why: "'The extension is NOT performing prompt engineering … preserving conversational intent while altering execution
        strategy … an execution directive rather than an attempt to redefine the user's request.'"
  critical: "Reinforces that MVP MUST NOT rewrite the prompt/context — only flip the thinking config. The optional
             directive is an execution directive, not a prompt rewrite; omitting it in MVP is compliant."

# Library contract — the z.ai disable-thinking mechanism (CONFIRMED by reading compiled source)
- file: node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js  (read-only library source)
  why: "streamSimpleOpenAICompletions: `clampedReasoning = options?.reasoning ? clampThinkingLevel(model,
        options.reasoning) : undefined; reasoningEffort = clampedReasoning === 'off' ? undefined : clampedReasoning;`
        then the payload builder sets `params.enable_thinking = !!options?.reasoningEffort` when
        `compat.thinkingFormat === 'zai' && model.reasoning`."
  pattern: "reasoningEffort is derived from options.reasoning; enable_thinking = !!reasoningEffort."
  critical: "With options.reasoning === undefined → clampedReasoning undefined → reasoningEffort undefined →
             enable_thinking = !!undefined = false → reasoning DISABLED. Confirms the contract. DO NOT use 'off'
             (routes through clampThinkingLevel, which may be unsafe for z.ai)."

# Codebase patterns to FOLLOW (all DONE/immutable — do NOT modify)
- file: src/buffer/index.ts
  why: "Exports ThinkingEntry (the snapshot element type) and ReasoningBuffer.snapshot(): readonly ThinkingEntry[]
        (frozen). The RequestBuilder accepts that exact type as reasoningSnapshot. Also the cleanest sibling model: an
        otherwise-pure append-only collection that STILL injects Diagnostics + emits privacy-safe milestones — the
        precedent for RequestBuilder emitting one debug({}) while remaining behaviorally pure."
  pattern: "Mode-A module JSDoc + constructor(diagnostics) + privacy-safe lifecycle diagnostics + total (never-throws)
            methods."
  gotcha: "ThinkingEntry is named to AVOID collision with the streaming-event union ThinkingEvent in src/types.ts —
           import ThinkingEntry from '../buffer', NOT from '../types'."

- file: src/state/coordinator.ts
  why: "Structural-typing + pure-delegate sibling: constructor(private readonly diagnostics) + methods that never throw /
        never mutate inputs. Mirror its constructor style and the 'privacy: only event names + categories logged' note."
  pattern: "constructor(private readonly diagnostics: Diagnostics); stateless delegator; never-crash."

- file: src/provider/proxy.ts
  why: "The CONSUMER-to-be (P1.M7) and the home of the signal-override pattern. run() does `upstreamStreamFn(model,
        context, { ...options, signal: this._internalAbort.signal })` — proof that overriding options.signal at
        invocation time is the established pattern, which is exactly how P1.M7 will inject the replacement's abort
        signal AFTER buildReplacement returns the triple with the original signal preserved."
  pattern: "spread options + override one field at the call site."
  gotcha: "RequestBuilder MUST preserve options.signal verbatim (the contract is { ...options, reasoning: undefined }).
           Do NOT touch the signal here — P1.M7 owns it."

- file: tests/reasoning-buffer.test.ts
  why: "Pattern source: makeCaptureDiag() (the canonical capturing Diagnostics stub — copy VERBATIM), the
        allow-list privacy assertion scan, and the bun:test describe/test/expect structure."
  pattern: "makeCaptureDiag() → { diag, events }; construct the unit under test with diag; assert via captured events."

- file: tests/stream-proxy-abort.test.ts
  why: "Pattern source: makeModel() (minimal Model<Api> stand-in: { id, api, provider, reasoning, baseUrl, compat }) and
        the inline typed-mock construction convention."
  pattern: "cast a minimal object literal `as unknown as Model<Api>` for a mock that only needs a few fields."

- docfile: plan/001_b0c6691bb424/architecture/external_deps.md
  why: "§3 z.ai API — 'Disabling Reasoning' documents the exact `{ ...options, reasoning: undefined }` recipe and the
        enable_thinking chain (the authoritative secondary source for the contract)."
  section: "§3 z.ai API → 'Disabling Reasoning' + 'z.ai Model Detection'."

- docfile: plan/001_b0c6691bb424/P1M5T2S1/PRP.md  (the preceding, in-flight sibling)
  why: "Defines what exists when this item runs: after a clean abort, StreamProxy reaches `Capturing` + freezes the
        buffer and leaves `output` OPEN. buildReplacement is called ONLY in that state. Confirms RequestBuilder must NOT
        synthesize a terminal, touch output, or start a stream — it only returns the triple."
  section: "Goal + 'Out of scope' (P1.M6 builds the triple; P1.M7 invokes the stream)."

- docfile: plan/001_b0c6691bb424/P1M6T1S1/research/notes.md
  why: "Evidence base for THIS PRP: the verbatim contract, the confirmed z.ai mechanism (compiled-source quotes), the
        type-safety of { ...options, reasoning: undefined }, the purity+diagnostics decision, the reasoningSnapshot
        rationale, and the P1.M7 signal boundary."
  section: "§1 (mechanism), §2 (type safety), §3 (purity), §4 (snapshot param), §5 (signal boundary)"
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO request wiring here (→ P1.M7)
├── types.ts                 # TransitionState / event type guards (P1.M2.T1) — IMPORT ThinkingEntry from ../buffer, NOT here
├── config/index.ts          # DEFAULT_CONFIG (P1.M1.T2)
├── diagnostics/index.ts     # Diagnostics interface (P1.M1.T3) — INJECT into RequestBuilder
├── buffer/index.ts          # ReasoningBuffer + ThinkingEntry + snapshot(): readonly ThinkingEntry[] (P1.M4.T1) — IMPORT ThinkingEntry
├── request/
│   └── .gitkeep             # placeholder for THIS subtask → replace with builder.ts (then delete .gitkeep)
├── provider/
│   ├── decorator.ts         # ProviderDecorator (P1.M1/M2) — NO change
│   └── proxy.ts             # StreamProxy — the FUTURE consumer (P1.M7); references the signal-override pattern
├── shortcut/index.ts        # ShortcutManager (P1.M4.T3) — NO change
└── state/
    ├── controller.ts        # TransitionController (P1.M3) — NO change
    └── coordinator.ts       # TransitionCoordinator (P1.M4.T4) — constructor(diagnostics) pattern to MIRROR
tests/
├── reasoning-buffer.test.ts     # makeCaptureDiag() + privacy-allow-list pattern source
├── stream-proxy-abort.test.ts   # makeModel() + inline typed-mock pattern source
└── … (existing suites — all must stay green)
```

### Desired Codebase tree with files to be added/changed

```bash
src/request/builder.ts              # CREATE: RequestBuilder class + ReplacementRequest interface + buildReplacement()
src/request/.gitkeep                # DELETE (the placeholder; redundant once builder.ts exists)
tests/request-builder.test.ts       # CREATE: bun:test suite (transform + preservation + purity + privacy)
# (no other files change)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: use `reasoning: undefined`, NOT `reasoning: "off"`. The z.ai provider does
//   `clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined`
// so `undefined` short-circuits BEFORE clampThinkingLevel runs (unconditionally safe). `"off"` would route through
// clampThinkingLevel, which may misbehave for z.ai (no "off" level in zai's thinkingLevelMap) — avoid it.

// CRITICAL: the transform is EXACTLY `{ ...options, reasoning: undefined }`. It touches ONE field. Do not also clear
// `thinkingBudgets` — z.ai ignores it (it is for token-based providers), and the contract modifies only `reasoning`.
// Do not freeze the result — P1.M7 spreads/overrides options (e.g. injects a fresh abort signal) at invocation time.

// CRITICAL: model + context are returned as the SAME references (PRD §25.3/§25.4/§25.7). Do NOT clone/rewrite them.
// The whole point is maximal reuse with zero prompt morphing (PRD §26). `triple.model === inputModel` must hold.

// CRITICAL: do NOT mutate the input `options`. `{ ...options, reasoning: undefined }` builds a FRESH object — that is
// the purity guarantee. A test asserts the original options.reasoning is unchanged after the call.

// CRITICAL: do NOT touch options.signal. The contract is `{ ...options, reasoning: undefined }` only. The replacement
// stream's abort signal is owned by P1.M7.T1, which overrides options.signal when it invokes original.streamSimple()
// (mirroring StreamProxy.run()'s `{ ...options, signal: this._internalAbort.signal }` pattern). Preserving the original
// signal here is correct and intended.

// GOTCHA: ThinkingEntry is exported from "../buffer" (src/buffer/index.ts), NOT from "../types" (which exports the
// streaming-event union ThinkingEvent — a DIFFERENT thing, deliberately named to avoid collision). Import the snapshot
// element type from ../buffer.

// GOTCHA: the method is "pure (no side effects, no network)" per the contract. The single debug("...", {}) trace does
// NOT violate this — Diagnostics "never modifies runtime behavior" (fire-and-forget), exactly like ReasoningBuffer
// (an otherwise-pure collection) emitting lifecycle milestones. Do NOT add network/streaming/state to the method.

// GOTCHA: reasoningSnapshot is accepted (PRD §53 lists it as an INPUT) but UNUSED in MVP (the ephemeral execution
// directive is omitted by default). tsconfig.json has `strict: true` but NO `noUnusedParameters`/`noUnusedLocals`, so
// the documented-but-unused param compiles cleanly. Do NOT add hacky `void reasoningSnapshot;` — keep the clean
// documented contract (reserved for the optional directive / forward-compat).

// PRIVACY (Appendix H): the one diagnostics call logs {} only — no context, no options, no reasoning, no prompt.
```

---

## Implementation Blueprint

### Data models and structure

No persistent data models. One pure output shape:

```typescript
/** The thinking-disabled replacement request triple (PRD §53 Outputs / §31 Outputs). */
export interface ReplacementRequest {
  readonly model: Model<Api>;        // same ref as input (PRD §25.7)
  readonly context: Context;         // same ref as input (PRD §25.3/§25.4)
  readonly options: SimpleStreamOptions; // fresh object = { ...options, reasoning: undefined } (PRD §25.6)
}
```

`RequestBuilder` holds ONE field (`private readonly diagnostics`). No FSM, no buffer, no stream, no state across calls.
Type safety is enforced by `strict: true` + `isolatedModules: true` (`tsconfig.json`) and the `tsc --noEmit` gate. The
`reasoning: undefined` override is type-legal because `SimpleStreamOptions.reasoning?: ThinkingLevel` is optional.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE src/request/builder.ts — imports + ReplacementRequest interface
  - ADD imports (all `import type`): Api, Context, Model, SimpleStreamOptions from "@earendil-works/pi-ai";
    ThinkingEntry from "../buffer"; Diagnostics from "../diagnostics".
  - ADD `export interface ReplacementRequest { readonly model: Model<Api>; readonly context: Context;
    readonly options: SimpleStreamOptions; }` with the Mode-A JSDoc from "What / B".
  - FOLLOW pattern: src/buffer/index.ts / src/state/coordinator.ts (type-only imports; isolatedModules-safe).
  - NAMING: ReplacementRequest (PascalCase interface); readonly triple fields.
  - GOTCHA: import ThinkingEntry from "../buffer", NOT "../types".
  - PLACEMENT: src/request/builder.ts (the .gitkeep dir already exists).
  - DEPENDENCIES: pi-ai types (peer dep) + ThinkingEntry (already exported from src/buffer).

Task 2: CREATE src/request/builder.ts — RequestBuilder class + buildReplacement()
  - ADD `export class RequestBuilder { constructor(private readonly diagnostics: Diagnostics) {}
    buildReplacement(model, context, options, reasoningSnapshot): ReplacementRequest { … } }`.
  - IMPLEMENT the body EXACTLY: `const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
    this.diagnostics.debug("request.replacement-built", {}); return { model, context, options: replacementOptions };`.
  - ADD the Mode-A module + method JSDoc from "What / C" (cite §25.3/§25.4/§25.5/§25.6/§25.7/§31/§53 + the z.ai
    enable_thinking mechanism; document reasoningSnapshot as reserved/unused-in-MVP).
  - FOLLOW pattern: src/buffer/index.ts (constructor(diagnostics) + total never-throws methods + privacy-safe milestones).
  - GOTCHA: use `reasoning: undefined` (NOT "off"); do NOT freeze replacementOptions; do NOT touch options.signal;
    do NOT mutate the input options; model/context are same-ref.
  - PLACEMENT: src/request/builder.ts (below the interface).
  - DEPENDENCIES: Task 1.

Task 3: DELETE src/request/.gitkeep
  - The placeholder is redundant once builder.ts exists; remove it so src/request/ contains only builder.ts.
  - GOTCHA: verify `npx bun run build` still emits dist/request/builder.js (tsc picks up the new file automatically).

Task 4: CREATE tests/request-builder.test.ts
  - COPY makeCaptureDiag() from tests/reasoning-buffer.test.ts VERBATIM. Build a minimal Model<Api> mock (mirror
    makeModel() from tests/stream-proxy-abort.test.ts: { id, api, provider, reasoning, baseUrl, compat }), a Context
    mock ({ systemPrompt, messages }), and a rich SimpleStreamOptions mock (reasoning + temperature + maxTokens +
    apiKey + sessionId + headers + signal + timeoutMs + maxRetries + thinkingBudgets + metadata).
  - IMPLEMENT the coverage cases in "What / Test" (thinking-disabled override; already-undefined/absent; full
    preservation; same-ref model; same-ref context; input NOT mutated; frozen-snapshot accepted; exact triple shape;
    fresh unfrozen options; no-network; privacy guard).
  - FOLLOW pattern: tests/reasoning-buffer.test.ts (bun:test describe/test/expect; capture diag; allow-list privacy scan).
  - COVERAGE: the headline transform + preservation + purity + privacy + idempotence + shape.
  - PLACEMENT: tests/request-builder.test.ts (tests/ excluded from tsc; run by `bun test`).
  - DEPENDENCIES: imports RequestBuilder + ReplacementRequest from "../src/request/builder"; ThinkingEntry /
    ReasoningBuffer from "../src/buffer" (for the frozen-snapshot case); pi-ai types.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — one pure transform; model/context same-ref; options is a fresh UNFROZEN object with reasoning forced off.
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ThinkingEntry } from "../buffer";
import type { Diagnostics } from "../diagnostics";

export interface ReplacementRequest {
  readonly model: Model<Api>;
  readonly context: Context;
  readonly options: SimpleStreamOptions;
}

export class RequestBuilder {
  constructor(private readonly diagnostics: Diagnostics) {}

  buildReplacement(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    reasoningSnapshot: readonly ThinkingEntry[], // reserved (PRD §53); unused in MVP (no noUnusedParameters)
  ): ReplacementRequest {
    // The entire logic (PRD §25.6 / §53 Modify: thinking configuration):
    const replacementOptions: SimpleStreamOptions = { ...options, reasoning: undefined };
    this.diagnostics.debug("request.replacement-built", {}); // privacy-safe lifecycle milestone (Appendix H)
    return { model, context, options: replacementOptions };
  }
}

// GOTCHA — `reasoning: undefined`, NOT `"off"`: undefined short-circuits before clampThinkingLevel in
// openai-completions.js, making enable_thinking = !!undefined = false. `"off"` would run through the clamp (unsafe for z.ai).
// GOTCHA — model & context are the SAME references (triple.model === inputModel). No clone, no rewrite (PRD §25.3/§25.4/§25.7).
// GOTCHA — the input options is NOT mutated; the test asserts original options.reasoning is unchanged.
// GOTCHA — do NOT touch options.signal (P1.M7 overrides it at invocation, mirroring StreamProxy.run()'s spread+override).
// GOTCHA — replacementOptions is left UNFROZEN so P1.M7 can spread/override (e.g. inject the replacement abort signal).
// PRIVACY — the single debug call logs {} only; never context/options/reasoning/prompt content (Appendix H).
```

### Integration Points

```yaml
# NOTE: this subtask creates ONLY src/request/builder.ts + tests/request-builder.test.ts (and deletes .gitkeep).
# No wiring change in this subtask.

DIAGNOSTICS (src/diagnostics/index.ts): NO CHANGE — the injected Diagnostics interface already exists. RequestBuilder
  emits one debug("request.replacement-built", {}) milestone, consistent with buffer.frozen / proxy.abort.completed.

BUFFER (src/buffer/index.ts): NO CHANGE — RequestBuilder only READS the snapshot's TYPE (readonly ThinkingEntry[]) for
  the parameter; it never calls ReasoningBuffer methods and never reads entry.content (privacy-safe).

PROXY / DECORATOR / COORDINATOR / FACTORY: NO CHANGE — none reference RequestBuilder yet. Wiring is P1.M7.T1, which will:
  `const triple = builder.buildReplacement(model, context, options, buffer.snapshot());` then
  `original.streamSimple(triple.model, triple.context, { ...triple.options, signal: <fresh internal abort>.signal });`.

SIGNAL BOUNDARY (P1.M7.T1 owns it): RequestBuilder preserves options.signal VERBATIM (the contract is { ...options,
  reasoning: undefined }). The replacement stream's abort signal is injected by P1.M7 at invocation time, mirroring
  StreamProxy.run()'s `{ ...options, signal: this._internalAbort.signal }` override pattern. Do NOT change this here.

CONFIG / DATABASE / ROUTES: none.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after creating src/request/builder.ts — must be clean before writing the test.
npx bun run typecheck     # tsc --noEmit over src/** — builder.ts MUST compile standalone (0 diagnostics)
npx bun run build         # tsc → exit 0 (verify dist/request/builder.js + .d.ts are emitted)

# (No ruff/mypy — TS project. Match the existing 2-space style + Mode-A JSDoc.)
# Expected: Zero errors. Common READ-for failures:
#  - "Cannot find name 'ThinkingEntry'" → you imported it from "../types" instead of "../buffer". Fix the import path.
#  - "Type 'undefined' is not assignable to type 'ThinkingLevel'" → should not happen (reasoning?: is optional), but if
#    it does, you typed the field non-optionally; SimpleStreamOptions.reasoning is optional so undefined is legal.
#  - an unused-parameter error → should NOT happen (tsconfig has no noUnusedParameters); if a future config adds it,
#    reference the param in a documented way (it is reserved for the optional ephemeral directive).
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the new suite in isolation.
npx bun test tests/request-builder.test.ts -v

# Full suite for regressions (proxy + state + buffer + shortcut + coordinator + golden + factory + decorator + abort + race).
npx bun test

# Expected: All tests pass. Common failures to READ for:
#  - "Expected undefined, received 'high'" (thinking-disabled case) → the spread did not override reasoning: ensure the
#    object literal is { ...options, reasoning: undefined } (reasoning AFTER the spread, so it wins).
#  - "triple.model !== inputModel" → you returned a clone/new object instead of the same reference; return the inputs.
#  - "original options.reasoning was mutated" (purity case) → you assigned to options.reasoning instead of spreading a
#    fresh object; the transform MUST be { ...options, reasoning: undefined } (non-mutating).
#  - "triple.options is frozen" → you froze replacementOptions; it must stay UNFROZEN for P1.M7 to override the signal.
```

### Level 3: Integration Testing (System Validation)

```bash
# There is no live runtime integration yet (RequestBuilder is wired by P1.M7). The integration contract is BEHAVIORAL +
# STRUCTURAL. Verify directly:

# (a) The full pre-existing suite is byte-for-byte unchanged (RequestBuilder adds no coupling to existing modules):
npx bun test tests/reasoning-buffer.test.ts tests/stream-proxy-abort.test.ts tests/stream-proxy.test.ts -v

# (b) The build emits the new module (consumable by P1.M7 via `import { RequestBuilder } from "./request/builder"`):
npx bun run build && ls dist/request/   # expect: builder.js + builder.d.ts (+ maps)

# (c) Full suite (the real integration bar — all pre-existing tests + the new request-builder file):
npx bun test

# Expected: (a) all green unchanged; (b) dist/request/builder.{js,d.ts} present; (c) all green, zero regressions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Determinism / purity: buildReplacement is a pure function — call it N times with the same inputs and assert
# structurally-equal outputs every time, AND that the original options object is never mutated across calls.
# (Covered by the test suite's purity + idempotence cases; no extra flake risk since there is no async/I/O.)

# Privacy guard (Appendix H): assert the single debug event fired with fields === {} (no content keys). Enforced by an
# allow-list assertion in the test suite (mirror reasoning-buffer.test.ts's overflow privacy scan).

# Consumer-readiness (the P1.M7 contract): the returned triple can be passed straight to original.streamSimple — verify
# by a smoke assertion that triple.options is a valid SimpleStreamOptions (has the spread fields) with reasoning undefined.
# (No actual network call — the test constructs the triple and inspects it; the real invocation is P1.M7.)

# Expected: pure/deterministic; privacy assertion green; triple is consumer-ready (shape + reasoning === undefined).
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0; `dist/request/builder.{js,d.ts}` emitted.
- [ ] Level 2: `npx bun test` → **all green** (every pre-existing suite + the new `request-builder` tests).
- [ ] No regressions: all pre-existing test files are unchanged and still pass (proxy/state/buffer/abort/race/golden/…).
- [ ] `builder.ts` imports only type-only symbols from `@earendil-works/pi-ai` + `ThinkingEntry` from `../buffer` +
      `Diagnostics` from `../diagnostics`; no new runtime dependencies.

### Feature Validation
- [ ] `buildReplacement` returns `options.reasoning === undefined` for inputs carrying `"high"`/`undefined`/no key.
- [ ] Every other `SimpleStreamOptions` field (apiKey, temperature, maxTokens, sessionId, headers, signal, …) is
      preserved verbatim on the fresh `options` object.
- [ ] `triple.model === inputModel` and `triple.context === inputContext` (same references — PRD §25.3/§25.4/§25.7).
- [ ] The input `options` object is NOT mutated (original `reasoning` unchanged; no new keys added) — purity proven.
- [ ] `triple.options` is a fresh UNFROZEN object (`!== inputOptions`, `Object.isFrozen(...) === false`).
- [ ] Exactly one `debug("request.replacement-built", {})` per call; `reasoningSnapshot` accepted (frozen snapshot) w/o throw.

### Code Quality Validation
- [ ] Mode-A JSDoc (module + interface + class + method) citing PRD §25.3/§25.4/§25.5/§25.6/§25.7/§31/§53 + the z.ai
      `enable_thinking` mechanism — matches `src/buffer/index.ts` / `src/state/coordinator.ts` / `src/provider/proxy.ts`.
- [ ] `reasoning: undefined` (NOT `"off"`); model/context same-ref; options fresh + unfrozen; signal untouched.
- [ ] Pure transform (no network/stream/state); the single debug trace is privacy-safe (`{}`) per Appendix H.
- [ ] File placement matches the desired tree (`src/request/builder.ts` + `tests/request-builder.test.ts`; `.gitkeep` removed).

### Documentation & Deployment
- [ ] JSDoc explains WHY `reasoning: undefined` disables z.ai thinking (enable_thinking = !!reasoningEffort = false).
- [ ] JSDoc explains the P1.M7 signal-override boundary (RequestBuilder preserves options.signal; P1.M7 injects the
      replacement abort signal at invocation).
- [ ] JSDoc marks `reasoningSnapshot` reserved for the optional ephemeral directive (PRD §53/§25.5), unused in MVP.
- [ ] No new env vars / config.

---

## Anti-Patterns to Avoid
- ❌ Don't use `reasoning: "off"` — it routes through `clampThinkingLevel` (unsafe for z.ai). Use `reasoning: undefined`,
  which short-circuits before the clamp and makes `enable_thinking = !!undefined = false`.
- ❌ Don't clone or rewrite `model`/`context` — return the SAME references (PRD §25.3/§25.4/§25.7). The whole point is
  maximal reuse with zero prompt morphing (PRD §26).
- ❌ Don't mutate the input `options` — `{ ...options, reasoning: undefined }` builds a FRESH object; that is the purity
  guarantee. A test asserts the original `options.reasoning` is unchanged.
- ❌ Don't touch `options.signal` — the contract is exactly `{ ...options, reasoning: undefined }`. The replacement
  stream's abort signal is owned by P1.M7.T1 (it overrides `options.signal` at invocation, mirroring
  `StreamProxy.run()`'s spread+override).
- ❌ Don't freeze the returned `options` — P1.M7 needs to spread/override it (e.g. inject the replacement signal). Leave
  it a plain object.
- ❌ Don't add network, streaming, retries, or cross-call state to `RequestBuilder` (PRD §31 Non-responsibilities; the
  contract says "pure, no side effects, no network"). The single `debug` trace is the only allowed "effect" and it never
  modifies runtime behavior.
- ❌ Don't also clear `thinkingBudgets` — z.ai ignores it (token-based providers only); the contract modifies only
  `reasoning`.
- ❌ Don't import `ThinkingEntry` from `../types` — that module exports the streaming-event union `ThinkingEvent`
  (a different thing, deliberately named to avoid collision). Import `ThinkingEntry` from `../buffer`.
- ❌ Don't synthesize a terminal event, touch `output`, or call `original.streamSimple` — that is P1.M7's job. The
  builder only returns the triple.
- ❌ Don't touch `proxy.ts`, `controller.ts`, `coordinator.ts`, `buffer/`, `decorator.ts`, `config/`, `shortcut/`,
  `index.ts`, `types.ts`, or any existing test — this subtask is `src/request/builder.ts` + the new test only.
- ❌ Don't log context/options/reasoning/prompt content (Appendix H) — `request.replacement-built` logs `{}` only.

---

**Confidence Score: 9/10** for one-pass implementation success. The transform is a single, verbatim, contract-specified
line (`{ ...options, reasoning: undefined }`); the z.ai mechanism is confirmed in compiled library source; the test
coverage and the existing `makeCaptureDiag()`/`makeModel()` patterns are reproduced; the P1.M7 boundary (signal override)
and the MVP omissions (ephemeral directive) are explicitly scoped out. The one residual uncertainty is whether the
implementer honors the "preserve `options.signal` verbatim / P1.M7 owns the replacement signal" boundary rather than
trying to inject a signal here — the Anti-Patterns + Integration Points call this out to close that gap.
