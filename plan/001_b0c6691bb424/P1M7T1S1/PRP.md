# PRP — P1.M7.T1.S1: Replacement stream launch & initial event handling (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M7.T1.S1 (Phase 6 Stream Splicing, 2 pts) — after a clean abort leaves the FSM in
> `Capturing` with the reasoning buffer **frozen** (produced by P1.M5), the `StreamProxy` **launches the
> thinking-disabled replacement stream** via the SAME captured provider's `streamSimple`, drives the FSM
> `Capturing → Restarting → Splicing`, transfers event authority to the replacement, and guards the launch
> with the configurable replacement-startup timeout. The replacement request triple itself is produced by
> the **pure** `RequestBuilder` from P1.M6.T1.S1 (`{ ...options, reasoning: undefined }`).
> **Work-item contract (verbatim logic)**: in `StreamProxy.run()`, after `completeAbort()` + `freeze()`
> (state `Capturing`): (a) `builder.buildReplacement(model, context, options, buffer.snapshot())`;
> (b) `controller.beginReplacement()` → `Restarting`; (c) create a NEW internal `AbortController` for the
> replacement (Pi's signal still controls it); (d) `originalStreamFn(triple.model, triple.context,
> { ...triple.options, signal: replacementAbort.signal })`; (e) begin iterating; (f) on first replacement
> event → `controller.beginSplice()` → `Splicing`; (g) `authority = 'replacement'`; (h) replacement
> startup timeout (`config.replacementStartupTimeoutMs`) → `Failed` if no first event.
> **OUTPUT**: StreamProxy can launch + begin consuming a replacement stream after aborting the primary.
> Consumed by **P1.M7.T2** (terminal suppression + replacement forwarding/filtering) and **P1.M7.T3**
> (end-to-end completion lifecycle). **MOCKING**: mock primary emits thinking → triggerStop → mock
> replacement emits text; assert the replacement is invoked with `reasoning === undefined`.

---

## Goal

**Feature Goal**: Extend the `StreamProxy` pipeline so that, immediately after a clean primary abort
(`Capturing` + frozen reasoning buffer), it constructs the thinking-disabled replacement request, drives
the FSM through `Restarting` and (on the first replacement event) `Splicing`, transfers downstream event
authority to the replacement stream, and protects the launch with the PRD §43 replacement-startup
timeout. The replacement invocation must pass `reasoning === undefined` (disabling z.ai thinking) and a
fresh, Pi-controllable abort signal.

**Deliverable** (ONE source file MODIFIED + ONE test file CREATED + up to 2 existing test files surgically
reconciled — see Scope Boundary):
- `src/provider/proxy.ts` — **MODIFY**: append `requestBuilder?` + `replacementStartupTimeoutMs` to the
  constructor (backward-compatible); add the per-replacement `_replacementAbort` / `_replacementStartupTimer`
  / `_authority` state + `authority` getter; add `_launchReplacement(...)` + `_startReplacementTimeout()` +
  `_clearReplacementTimeout()`; in `run()`'s clean-abort catch branch, replace the trailing `return;` with
  `await this._launchReplacement(model, context, options, upstreamStreamFn); return;`. Forward replacement
  events into `output` as the minimal baseline (T2/T3 refine the filtering/completion).
- `tests/stream-proxy-replacement.test.ts` — **NEW** `bun:test` suite with a two-phase mock (primary
  thinking + abortable / replacement text + records args): replacement invoked with `reasoning ===
  undefined` + a fresh signal; FSM `Capturing → Restarting → Splicing`; `authority` flip; startup timeout →
  `Failed`; replacement text forwarded; privacy guard.
- `tests/stream-proxy-abort.test.ts` + `tests/stream-proxy-race.test.ts` — **SURGICAL RECONCILE** of the
  ≤6 assertions that observed the now-transient `Capturing` state and/or leak an orphaned replacement
  iterator (the lifecycle intentionally extends past `Capturing`). Minimal, enumerated edits only.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics;
`npx bun run build` → exit 0; `npx bun test` → **ALL green** — the new `stream-proxy-replacement` suite
PLUS every pre-existing suite (incl. the reconciled abort/race tests). The clean-abort guarantees
(buffer frozen at `Capturing`, `proxy.abort.completed` traced, no synthesized terminal on the abort path)
still hold; the FSM now continues `Capturing → Restarting → Splicing`; the replacement is invoked with
`reasoning === undefined` and a fresh `signal`; the startup timeout fails the transition to `Failed` when
no first replacement event arrives.

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing (the replacement launch is orchestration inside the
`StreamProxy`). The end user triggers it indirectly: they press `ctrl+.`, the reasoning stream is cleanly
aborted, and this subtask launches the thinking-disabled continuation so the model answers immediately.

**Use Case**: After a clean abort, `run()`'s clean-abort branch reaches `Capturing` + freezes the buffer.
This subtask then builds the replacement triple, transitions to `Restarting`, invokes the SAME captured
provider `streamSimple` with `reasoning: undefined`, and on the first replacement token transitions to
`Splicing` (authority transfer). The replacement's answer events flow into `output`; T2/T3 refine the
filtering and completion.

**Pain Points Addressed**: Without a single, well-tested launch path, the replacement invocation is
scattered and easy to get subtly wrong (forgetting to disable reasoning → the model resumes thinking;
reusing the already-aborted `_internalAbort` → the replacement dies instantly; no startup timeout → a
stalled replacement hangs the response forever; missing the Pi-signal fan-in → ctrl+c no longer stops the
replacement). Centralizing it as one tested method removes that class of bugs.

---

## Why

- **It is the explicit PRD §16 / §40 / §51 contract.** §16: `Capturing | Replacement issued | Restarting`
  and `Restarting | First replacement token | Splicing`. §40: the replacement becomes authoritative only
  after primary aborted + reasoning frozen + replacement accepted. §51 Replacement Phase + Authority
  Transfer spell out the exact sequence. §43 mandates a configurable replacement-startup timeout.
- **The disable-thinking mechanism is z.ai-specific and must be applied at the invocation.** P1.M6's pure
  `RequestBuilder` produces `{ ...options, reasoning: undefined }`; this subtask is the single place that
  triple is fed to `original.streamSimple(...)`, so `enable_thinking=false` actually takes effect (confirmed
  in `@earendil-works/pi-ai/dist/providers/openai-completions.js`).
- **The abort-signal boundary is non-obvious.** The primary's `_internalAbort` is ALREADY aborted
  (`triggerStop` aborted it). The replacement MUST use a FRESH `AbortController`, while still fanning-in
  Pi's external signal so `ctrl+c` aborts the replacement. Encoding this once prevents the "replacement
  dies instantly" bug.
- **It is the producer gate for P1.M7.T2/T3 (splicing/completion).** T2 adds the filtering/suppression
  rules on top of this baseline forward loop; T3 adds the `Splicing → Answering → Completed` completion.
  This subtask hands them a working launch + state machine + authority + timeout.

---

## What

### Source: MODIFY `src/provider/proxy.ts`

#### A. New imports (append to the existing import block)

```typescript
import { RequestBuilder } from "../request/builder"; // VALUE import — the proxy constructs an instance
import type { ProxyPhase } from "../types";           // "forwarding" | "transitioning" | "splicing"
```

> `RequestBuilder` is a value import (the proxy does `new RequestBuilder(diagnostics)`); it is NOT
> type-only. `ProxyPhase` (already exported from `src/types.ts` by P1.M2.T1.S1) models event authority
> (`"splicing"` == "replacement authoritative" per PRD §20.6 / §21). Do NOT add a new "authority" union —
> reuse `ProxyPhase`.

#### B. New instance state (append near the existing `_internalAbort` / `_abortTimer` fields)

```typescript
/**
 * Per-request RequestBuilder (PRD §31) — produces the thinking-disabled replacement triple (PRD §53).
 * Optional DI; production omits and the proxy self-creates `new RequestBuilder(diagnostics)`.
 */
private readonly _requestBuilder: RequestBuilder;

/**
 * Hard ceiling (ms) waiting for the replacement stream's FIRST event before the transition fails
 * (PRD §43 "Replacement startup timeout — Configurable"). Defaults to
 * `DEFAULT_CONFIG.replacementStartupTimeoutMs` (10000); tests inject a small value to fail fast.
 */
private readonly _replacementStartupTimeoutMs: number;

/**
 * Internal abort controller for the REPLACEMENT stream ONLY (PRD §51 Replacement Phase). FRESH per
 * replacement — the primary's `_internalAbort` is ALREADY aborted (used by `triggerStop`), so it CANNOT
 * be reused. Pi's external signal (`options.signal`) is fan-in'd into this so `ctrl+c` still aborts the
 * replacement. `undefined` until `_launchReplacement` creates it.
 */
private _replacementAbort: AbortController | undefined;

/** Pending replacement-startup-timeout timer (PRD §43). Armed by `_launchReplacement` before iterating;
 *  cleared on the first replacement event (clean) or when it fires (→ `Failed`). `undefined` when idle. */
private _replacementStartupTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The StreamProxy's event-authority phase (PRD §18 / §20.6 / §21). `"forwarding"` while the primary is
 * authoritative; flips to `"splicing"` when the first replacement event is accepted (authority transfer —
 * irreversible per PRD §39/§51). Read by P1.M7.T2/T3. (This is the contract's `authority = 'replacement'`,
 * modeled as the existing `ProxyPhase` "splicing" value.)
 */
private _authority: ProxyPhase = "forwarding";
```

#### C. Constructor — append two backward-compatible params + wire them

The 8th param `abortTimeoutMs` is positional (the FM-006 test passes it). Append the new params AFTER it
so every existing positional call is unchanged:

```typescript
constructor(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  upstreamStreamFn: ApiStreamSimpleFunction,
  diagnostics: Diagnostics,
  controller?: TransitionController,
  buffer?: ReasoningBuffer,
  abortTimeoutMs: number = DEFAULT_CONFIG.transitionTimeoutMs,
  // NEW (P1.M7.T1.S1) — appended; production omits both:
  requestBuilder?: RequestBuilder,
  replacementStartupTimeoutMs: number = DEFAULT_CONFIG.replacementStartupTimeoutMs,
) {
  this.diagnostics = diagnostics;
  this._output = createAssistantMessageEventStream();
  this._controller = controller ?? new TransitionController(diagnostics);
  this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);
  this._abortTimeoutMs = abortTimeoutMs;
  this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics);              // NEW
  this._replacementStartupTimeoutMs = replacementStartupTimeoutMs;                        // NEW

  // (existing external-signal fan-in into _internalAbort — UNCHANGED)
  const external = options?.signal;
  if (external) {
    if (external.aborted) this._internalAbort.abort();
    else external.addEventListener("abort", () => this._internalAbort.abort(), { once: true });
  }

  void this.run(model, context, options, upstreamStreamFn);
}
```

#### D. New public getter (append near the existing `controller` / `buffer` getters)

```typescript
/**
 * The StreamProxy's event-authority phase (PRD §18 / §20.6 / §21). `"forwarding"` until the first
 * replacement event is accepted; `"splicing"` thereafter (replacement authoritative). Read by P1.M7.T2/T3
 * to decide which stream's events to forward.
 */
get authority(): ProxyPhase {
  return this._authority;
}
```

#### E. MODIFY `run()` — replace the clean-abort branch's trailing `return;`

Find the existing clean-abort branch inside `run()`'s `catch` (P1.M5.T1.S1):

```typescript
if (this._controller.getState() === "Aborting") {
  this._clearAbortTimeout();
  try {
    this._controller.completeAbort(); // Aborting → Capturing (PRD §16)
  } catch (e) {
    this.diagnostics.warn("proxy.abort.complete-abort-failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  this._buffer.freeze(); // (PRD §41: reasoning immutable once frozen; §40: replacement needs this)
  this.diagnostics.trace("proxy.abort.completed", {});
  return; // ◄◄◄ MODIFY THIS LINE (see below)
}
```

Replace ONLY the final `return;` with the replacement launch:

```typescript
  this.diagnostics.trace("proxy.abort.completed", {});
  // PRD §40: primary aborted + reasoning frozen → launch the thinking-disabled replacement and drive the
  // FSM through Restarting → Splicing (PRD §16/§51). output stays OPEN; the replacement owns the terminal.
  await this._launchReplacement(model, context, options, upstreamStreamFn);
  return;
```

Everything above (the `proxy.abort.completed` trace + frozen buffer) is the PRD §40 precondition and is
UNTOUCHED. The `model`/`context`/`options`/`upstreamStreamFn` are `run()`'s params (the original request
triple + the SAME captured provider `streamSimple`); pass them straight through.

#### F. NEW private methods — `_launchReplacement` + the two timeout helpers

```typescript
/**
 * Launch the thinking-disabled replacement stream and drive the FSM through Restarting → Splicing
 * (PRD §16 / §40 / §51 Replacement Phase + Authority Transfer). Invoked from `run()`'s clean-abort branch
 * AFTER `completeAbort()` + `freeze()` (state is `Capturing`).
 *
 * Steps (work-item contract): (a) build the replacement triple via RequestBuilder; (b) `beginReplacement()`
 * → `Restarting`; (c) create a FRESH `_replacementAbort` + fan-in Pi's external signal; (d) invoke the SAME
 * captured provider `streamSimple` with `{ ...triple.options, signal }` (reasoning === undefined disables
 * z.ai thinking); arm the startup timeout; (e) iterate; (f) on the FIRST event → `beginSplice()` →
 * `Splicing` + clear the timeout; (g) flip authority to `"splicing"` (irreversible — PRD §39/§51).
 *
 * BASELINE FORWARDING: replacement events are pushed into `output` unchanged. The primary pushed NO
 * terminal (output left open by the abort path), so the replacement's events are the single forward path
 * and its `done` becomes the single terminal (single-start/single-terminal/single-result invariants hold).
 * P1.M7.T2 adds the filtering/suppression RULES (EC-017 stray reasoning, primary-terminal suppression);
 * P1.M7.T3 adds the full Splicing→Answering→Completed lifecycle. Replacement events do NOT run
 * `trackEvent` (the buffer is FROZEN and replacement processing is T2/T3's job).
 *
 * SAFETY NET: if the replacement throws (startup-timeout abort, provider error) and no terminal was
 * forwarded, exactly ONE synthesized `error` terminal is pushed so `output.result()` never hangs (push is
 * idempotent once complete → transparent in the normal path).
 *
 * @returns never rejects (the catch converts any error into a terminal event or logs + swallows).
 */
private async _launchReplacement(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  originalStreamFn: ApiStreamSimpleFunction,
): Promise<void> {
  try {
    // (a) Build the thinking-disabled replacement triple (PRD §25/§31/§53). `options` is the ORIGINAL
    //     request options (reasoning level intact); buildReplacement spreads + forces reasoning: undefined.
    const triple = this._requestBuilder.buildReplacement(model, context, options, this._buffer.snapshot());

    // (b) Capturing → Restarting (PRD §16). Legal: we are in Capturing (just completeAbort()'d).
    this._controller.beginReplacement();

    // (c) FRESH abort controller for the replacement (the primary's _internalAbort is ALREADY aborted).
    this._replacementAbort = new AbortController();
    // Fan-in Pi's external signal so ctrl+c still aborts the replacement (mirrors the ctor fan-in).
    const external = options?.signal;
    if (external) {
      if (external.aborted) this._replacementAbort.abort();
      else external.addEventListener("abort", () => this._replacementAbort!.abort(), { once: true });
    }

    // (d) Invoke the SAME captured provider streamSimple (PRD §51). triple.options.reasoning === undefined
    //     disables z.ai thinking; we inject the replacement signal (preserving every other option field).
    const replacementStream = originalStreamFn(triple.model, triple.context, {
      ...triple.options,
      signal: this._replacementAbort.signal,
    });

    // (h) Arm the replacement-startup timeout (PRD §43). Cleared on the first accepted event.
    this._startReplacementTimeout();

    let firstSeen = false;
    // (e) Begin iterating the replacement stream.
    for await (const event of replacementStream) {
      if (!firstSeen) {
        firstSeen = true;
        this._clearReplacementTimeout(); // first replacement event accepted → cancel the startup timeout
        // (f) Restarting → Splicing (PRD §16). Legal: we are in Restarting (just beginReplacement()'d).
        this._controller.beginSplice();
        // (g) Authority transfer — irreversible (PRD §39/§51). "splicing" == replacement authoritative.
        this._authority = "splicing";
        this.diagnostics.trace("proxy.replacement.first-event", {}); // privacy-safe — {} only (Appendix H)
      }
      // BASELINE forward (T2 refines filtering; T3 owns completion). The primary pushed no terminal, so the
      // replacement's done is the single terminal (push completes output). `push` is idempotent if complete.
      this._output.push(event);
    }
    // Replacement stream ended naturally (its terminal was forwarded → output completes). T3 owns the
    // Splicing→Answering→Completed lifecycle; this subtask leaves the FSM in Splicing.
  } catch (err) {
    // Replacement threw (startup-timeout abort, provider error, or an upstream throw). Synthesize ONE
    // error terminal so output.result() never hangs (single-terminal invariant), unless one was already
    // forwarded (push is idempotent once complete).
    this._clearReplacementTimeout();
    const message = err instanceof Error ? err.message : String(err);
    // CLASSIFY (gotcha): the startup-timeout handler ALREADY moved us to Failed + aborted _replacementAbort
    // (→ this throw) and logged `proxy.replacement.startup-timeout`. By the time the blocked iterator throws,
    // getState() is "Failed" — so a `getState() === "Restarting"` check would be a DEAD branch and would
    // DOUBLE-WARN. Therefore: SKIP the classify-warn on the timeout path (state already Failed); a throw
    // while NOT yet Failed is a GENUINE replacement failure → classify + log it. Synthesize the terminal in
    // BOTH cases so output.result() never hangs (single-terminal invariant).
    if (this._controller.getState() !== "Failed") {
      this.diagnostics.warn("proxy.replacement.failed", { error: message });
    }
    this._output.push({
      type: "error",
      reason: "error",
      error: this.makeErrorAssistantMessage(model, message),
    });
  }
}

/**
 * Arm the replacement-startup timeout (PRD §43). If the replacement emits NO first event within
 * `_replacementStartupTimeoutMs`, fail the transition and abort the replacement (which unblocks the
 * blocked iterator → `_launchReplacement`'s catch synthesizes a terminal). Mirrors `_startAbortTimeout`.
 */
private _startReplacementTimeout(): void {
  this._clearReplacementTimeout();
  this._replacementStartupTimer = setTimeout(() => {
    // Only act if we are STILL Restarting (a first event cleared this timer and moved us to Splicing).
    if (this._controller.getState() === "Restarting") {
      this.diagnostics.warn("proxy.replacement.startup-timeout", { timeoutMs: this._replacementStartupTimeoutMs });
      this._controller.fail("replacement-startup-timeout"); // Restarting → Failed (Any→Failed; never throws)
      this._replacementAbort?.abort(); // unblock the blocked iterator so the loop exits
    }
  }, this._replacementStartupTimeoutMs);
}

/** Cancel any pending replacement-startup timeout (first event accepted / throw / disposal). */
private _clearReplacementTimeout(): void {
  if (this._replacementStartupTimer !== undefined) {
    clearTimeout(this._replacementStartupTimer);
    this._replacementStartupTimer = undefined;
  }
}
```

> The existing `makeErrorAssistantMessage(model, message)` private method is reused as-is for the
> synthesized terminal (no change). The `_launchReplacement` trace names (`proxy.replacement.first-event`,
> `proxy.replacement.startup-timeout`, `proxy.replacement.failed`) are DISTINCT from the abort names so
> they do not pollute the P1.M5 `proxy.abort.*` / `proxy.forward.upstream-threw` assertions.

### Test: CREATE `tests/stream-proxy-replacement.test.ts`

A `bun:test` suite. Reuse `makeCaptureDiag()` / `makeModel()` / `ev()` / `waitFor()` VERBATIM from
`tests/stream-proxy-abort.test.ts`. The key new double is a **two-phase** upstream mock:

```typescript
/**
 * Two-phase upstream mock: 1st call → PRIMARY iterable (yields thinking, throws on its signal abort);
 * 2nd call → REPLACEMENT iterable (records its options, yields replacement events, throws on its signal
 * abort). The two phases use SEPARATE queues + signals (the replacement gets a fresh signal from the proxy).
 */
function makeReplacementUpstream() {
  const calls: { options?: { reasoning?: unknown; signal?: AbortSignal } }[] = []; // recorded REPLACEMENT invocations
  let primarySignal: AbortSignal | undefined;
  let replacementSignal: AbortSignal | undefined;
  const primaryQueue: AssistantMessageEvent[] = [];
  const replacementQueue: AssistantMessageEvent[] = [];
  let callCount = 0;
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    callCount++;
    if (callCount === 1) {
      primarySignal = opts?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (primarySignal?.aborted) throw new Error("aborted");
            if (primaryQueue.length) { yield primaryQueue.shift()!; continue; }
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 0);
              primarySignal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
            });
          }
        },
      };
    }
    // 2nd call = REPLACEMENT. Record the invocation args (the headline MOCKING assertion target).
    calls.push({ options: opts as { reasoning?: unknown; signal?: AbortSignal } | undefined });
    replacementSignal = opts?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (replacementSignal?.aborted) throw new Error("aborted");
          if (replacementQueue.length) { yield replacementQueue.shift()!; continue; }
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 0);
            replacementSignal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
          });
        }
      },
    };
  }) as unknown as ApiStreamSimpleFunction;
  return {
    fn,
    calls, // calls[0] is the REPLACEMENT invocation (primary call is not recorded)
    pushPrimary: (e: AssistantMessageEvent) => primaryQueue.push(e),
    pushReplacement: (e: AssistantMessageEvent) => replacementQueue.push(e),
  };
}
```

Coverage (each its own `test`):

1. **Replacement invoked with `reasoning === undefined` + a fresh signal** (the headline MOCKING contract).
   Construct the proxy with `options = { reasoning: "high" } as never`; push thinking events → drive to
   Reasoning; `triggerStop()`; `await waitFor(() => mock.calls.length === 1)`; assert
   `mock.calls[0].options.reasoning === undefined` and `mock.calls[0].options.signal instanceof AbortSignal`
   and `mock.calls[0].options.signal.aborted === false` (the replacement signal is live, not pre-aborted).
2. **FSM `Capturing → Restarting → Splicing`** : after `triggerStop`, push one replacement `text_start`;
   `await waitFor(() => controller.getState() === "Splicing")`. (The intermediate `Restarting` is set
   synchronously inside `_launchReplacement` before the first event; `Splicing` is reached on the first
   event — assert both via the stable `proxy.replacement.first-event` trace for Splicing.)
3. **Authority flip**: `proxy.authority === "forwarding"` before any replacement event; after the first
   replacement event `proxy.authority === "splicing"`.
4. **Replacement startup timeout → `Failed`** : construct with `replacementStartupTimeoutMs = 15`
   (10th positional param, `requestBuilder` passed `undefined`); trigger stop; push NO replacement events;
   `await waitFor(() => controller.getState() === "Failed", 200)`; assert
   `events.some(c => c.event === "proxy.replacement.startup-timeout")`.
5. **Replacement text forwarded into `output`** : drain a consumer concurrently; after Splicing, push
   `text_delta`/`done`; assert the consumer sees the replacement text events + a single terminal (`done`).
   (Baseline forward — T2 refines.)
6. **Privacy guard**: filter `proxy.replacement.*` events; assert each `fields` is `{}` / `{timeoutMs}` /
   `{error}` only (never context/options/reasoning/prompt). Mirror the abort test's allow-list scan.

### SURGICAL RECONCILE of existing P1.M5 tests (lifecycle extension)

Extending `run()` past `Capturing` is **required by the contract** and **intentional**. It changes the
post-abbot behavior that P1.M5 tests asserted. Concretely: after `completeAbort()` (Capturing),
`_launchReplacement` runs `buildReplacement` then `beginReplacement()` **synchronously** (the first await
is the `for await`), so the FSM moves `Aborting → Capturing → Restarting` in one microtask burst — a
`setTimeout`-polling `waitFor(() => getState() === "Capturing")` can NEVER observe `Capturing` in
isolation, and any test that reaches `Capturing` now also launches a replacement (orphaned iterator +
10s timer → cross-test flake). These are NOT regressions of the clean-abort guarantees (buffer still
frozen, `proxy.abort.completed` still traced, no synthesized terminal on the abort path) — the lifecycle
simply continues. Apply this **uniform recipe** to each affected test:

- **Inject a small `replacementStartupTimeoutMs`** at construction so any orphaned replacement
  fails-and-cleans-up fast (the timeout aborts `_replacementAbort` → the blocked iterator throws →
  `_launchReplacement`'s catch synthesizes a terminal → no dangling promise/timer leaks). Because these
  tests pass ≤8 positional args today and the new params are APPENDED, change each `new StreamProxy(...)`
  to add `, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15` (import `DEFAULT_CONFIG` from
  `"../src/config"`). *(For the FM-006 test that already passes `abortTimeoutMs` positionally, keep its
  value and add `, undefined, 15`.)*
- **Replace `waitFor(() => controller.getState() === "Capturing")`** with the STABLE clean-abort signal
  `waitFor(() => events.some((c) => c.event === "proxy.abort.completed"))` (deterministic; holds across
  phases). The buffer-frozen + no-`proxy.forward.upstream-threw` assertions are UNCHANGED (they still hold).

Affected tests (apply the recipe to each):
- `tests/stream-proxy-abort.test.ts`: "clean abort happy path", "first-press-wins / isInterrupting",
  "privacy guard" (hard `waitFor(Capturing)` failure); "canInterrupt()/isInterrupting() delegation" and
  "Pi escape propagates" (no assertion failure but orphaned-replacement leak → inject the timeout).
- `tests/stream-proxy-race.test.ts`: "genuine clean-abort regression (no terminal forwarded)" (hard
  `waitFor(Capturing)` failure).

**Do NOT touch** any test that never reaches `Capturing` (the natural-completion-won race tests, the
FM-006 timeout test, the normal-forwarding regressions, "triggerStop outside Reasoning") — they are
unaffected and must stay byte-identical.

**Out of scope** (owned by T2/T3 + later — do NOT implement here):
- **Replacement event filtering / suppression** (EC-017 "replacement returns reasoning anyway → suppress";
  primary-terminal suppression during the splice boundary) → **P1.M7.T2**. This subtask forwards
  replacement events as a baseline.
- **The full completion lifecycle** (`Splicing → Answering → Completed → Idle`, PRD §51 Completion) →
  **P1.M7.T3**. This subtask leaves the FSM in `Splicing`.
- **Any change to `RequestBuilder`** (P1.M6 owns the pure triple) — only CONSUMED here.
- **Any change to `TransitionController`** — `beginReplacement()`/`beginSplice()`/`fail()` already exist.
- Any change to `decorator.ts`, `coordinator.ts`, `buffer/`, `config/`, `shortcut/`, `index.ts`,
  `types.ts`, or the unaffected tests. No new dependencies.

### Success Criteria

- [ ] `run()`'s clean-abort branch awaits `_launchReplacement(...)` instead of bare-`return;`ing; the
      `proxy.abort.completed` trace + frozen buffer (PRD §40 precondition) are unchanged.
- [ ] `_launchReplacement` builds the triple via `RequestBuilder`, calls `beginReplacement()` (→ Restarting),
      creates a FRESH `_replacementAbort` + fan-in's Pi's external signal, invokes the SAME
      `originalStreamFn` with `{ ...triple.options, signal: replacementAbort.signal }`, arms the startup
      timeout, iterates, and on the first event calls `beginSplice()` (→ Splicing) + flips `authority` to
      `"splicing"` + clears the timeout.
- [ ] The replacement is invoked with `options.reasoning === undefined` and a live (non-aborted) `signal`.
- [ ] No first replacement event within `replacementStartupTimeoutMs` → `controller.fail(...)` → `Failed`
      + `_replacementAbort.abort()` (unblocks the iterator) + a synthesized terminal.
- [ ] Replacement events are forwarded into `output` (baseline); the single-start/single-terminal invariants
      hold. `trackEvent` is NOT called on replacement events.
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green
      (new `stream-proxy-replacement` + reconciled abort/race + every other suite).

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have everything
needed to implement this successfully?"_ → YES. The exact imports, new fields, constructor change, the
`_launchReplacement` body (with the splice-transition + authority + timeout + safety net), the two-phase
test mock, the precise reconcile recipe for the affected P1.M5 tests, and the non-obvious facts — (1) WHY
the replacement needs a FRESH abort controller (`_internalAbort` is already aborted), (2) WHY the FSM moves
Capturing→Restarting synchronously (breaking `waitFor(Capturing)`), (3) WHY replacement events are
forwarded as a baseline but NOT run through `trackEvent` (frozen buffer + T2/T3 ownership), (4) WHY
`reasoning === undefined` disables z.ai thinking (confirmed in compiled `openai-completions.js`) — are all
reproduced above and in `research/notes.md` §1–§10.

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask
- url: PRD.md "# 16. State Transition Table"
  why: "Capturing | Replacement issued | Restarting ; Restarting | First replacement token | Splicing ;
        Any | Fatal error | Failed. The exact transitions this subtask drives."
  critical: "beginReplacement() is legal ONLY from Capturing; beginSplice() ONLY from Restarting. fail()
             is Any→Failed (the escape hatch for the startup timeout)."

- url: PRD.md "# 40. Replacement Stream Requirements"
  why: "Replacement stream becomes authoritative only AFTER: primary successfully aborted; reasoning
        frozen; replacement request accepted. Until then the primary remains authoritative."
  critical: "This subtask runs AFTER completeAbort()+freeze() (primary aborted + frozen) — the exact
             precondition. Authority flips only on the first accepted replacement event (step g)."

- url: PRD.md "# 21. Stream Splicing Algorithm" (§21.3 Splice Boundary, §21.5 Secondary Stream Rules,
        §21.6 Completion Ownership)
  why: "§21.3: splice boundary ENDS when the first replacement event is accepted (== beginSplice). §21.5:
        after interruption the replacement owns all future events. §21.6: exactly one stream owns
        completion — always the replacement after interruption."
  critical: "The primary pushed NO terminal (output left open by P1.M5), so forwarding the replacement's
             done is the single terminal — invariant preserved. No downstream completion may be emitted
             during the splice boundary (before the first accepted event) — satisfied: we forward only
             after beginSplice."

- url: PRD.md "# 39. Transition Event Rules"
  why: "Allowed: Suppress terminal completion; Suppress obsolete thinking; Forward replacement text.
        Forbidden: Emit duplicate message_start/message_end; Emit replacement before ownership changes;
        Emit upstream completion after replacement begins."
  critical: "Authority transfer is irreversible. This subtask's baseline forward (after Splicing) complies;
             the FILTERING rules (suppress stray replacement reasoning per EC-017) are T2."

- url: PRD.md "# 51. Complete Transition Algorithm" (## Replacement Phase, ## Authority Transfer)
  why: "Replacement Phase: Snapshot Context → Build Request → Disable Thinking → Invoke Captured Provider
        → Receive Replacement Stream. Authority Transfer: Primary suppressed → Secondary → Authoritative
        (irreversible)."
  critical: "This subtask implements exactly that phase sequence. Disable Thinking is achieved by
             buildReplacement's reasoning: undefined (consumed from P1.M6); Invoke Captured Provider is the
             SAME originalStreamFn call."

- url: PRD.md "# 43. Timeout Requirements"
  why: "Replacement startup timeout — Configurable. (Also: Transition timeout configurable; Cleanup timeout
        best-effort, never block user-visible completion.)"
  critical: "The startup timeout is config.replacementStartupTimeoutMs (default 10000). On fire with no
             first event → Failed + abort the replacement so the iterator unblocks. A synthesized terminal
             keeps output from hanging."

- url: PRD.md "# 41. Buffer Ownership During Transition"
  why: "After interruption → frozen; After replacement → read-only. The snapshot passed to buildReplacement
        is the frozen read."
  critical: "The buffer is FROZEN before _launchReplacement runs (P1.M5 froze it). Replacement events must
             NOT call trackEvent (which would append to the frozen buffer / throw)."

# Library contract — the z.ai disable-thinking mechanism (CONFIRMED by reading compiled source)
- file: node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js  (read-only library source)
  why: "streamSimpleOpenAICompletions derives `reasoningEffort` from `options.reasoning`, then sets
        `params.enable_thinking = !!reasoningEffort` for z.ai. With options.reasoning === undefined →
        reasoningEffort undefined → enable_thinking = false → reasoning DISABLED."
  pattern: "reasoningEffort = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined."
  critical: "buildReplacement produces { ...options, reasoning: undefined } (P1.M6). This subtask feeds that
             triple to originalStreamFn, so enable_thinking=false takes effect. Do NOT set reasoning:'off'
             (routes through clampThinkingLevel) and do NOT clear thinkingBudgets (z.ai ignores it)."

# Codebase patterns to FOLLOW / MODIFY
- file: src/provider/proxy.ts
  why: "THE file this subtask modifies. run()'s clean-abort catch branch (after completeAbort()+freeze())
        is the insertion point; replace its trailing return; with await _launchReplacement(...). triggerStop()
        + _startAbortTimeout()/_clearAbortTimeout() + _internalAbort are the EXACT patterns to mirror for the
        replacement (_startReplacementTimeout/_clearReplacementTimeout/_replacementAbort). makeErrorAssistantMessage
        is reused for the synthesized terminal."
  pattern: "per-stream AbortController + fan-in of options.signal + setTimeout timeout that fail()s on fire."
  gotcha: "_internalAbort is ALREADY aborted (triggerStop used it for the primary) — the replacement MUST use
           a FRESH _replacementAbort; do NOT reuse _internalAbort."

- file: src/request/builder.ts  (P1.M6.T1.S1 — the producer; treat its PRP as a CONTRACT)
  why: "RequestBuilder.buildReplacement(model, context, options, reasoningSnapshot) → { model, context, options }
        with options = { ...options, reasoning: undefined } (fresh, unfrozen; model/context same-ref). This
        subtask CONSUMES that triple: `originalStreamFn(triple.model, triple.context, { ...triple.options,
        signal: replacementAbort.signal })`."
  pattern: "pure transform; the proxy overrides options.signal at invocation (mirrors run()'s
        { ...options, signal: this._internalAbort.signal })."
  gotcha: "buildReplacement preserves the ORIGINAL options.signal verbatim; we override it HERE with the
           replacement signal. Do NOT touch the signal inside RequestBuilder."

- file: src/state/controller.ts
  why: "TransitionController already exposes beginReplacement() (Capturing→Restarting), beginSplice()
        (Restarting→Splicing), and fail() (Any→Failed, never throws). This subtask CALLS them — no change."
  pattern: "each begin*() throws if the precondition state is wrong; fail() never throws."
  gotcha: "beginReplacement() is legal from Capturing (we just completeAbort()'d); beginSplice() from
           Restarting (we just beginReplacement()'d). Both are guaranteed legal in _launchReplacement's flow."

- file: src/types.ts
  why: "Exports ProxyPhase = 'forwarding' | 'transitioning' | 'splicing' (the event-authority phase, PRD
        §18/§20.6/§21) and isTerminalEvent. This subtask imports ProxyPhase for the _authority field."
  pattern: "string-literal union (not enum/booleans — PRD Appendix F)."
  gotcha: "Do NOT introduce a new 'authority' union — reuse ProxyPhase; 'splicing' == replacement authoritative."

- file: src/config/index.ts
  why: "Config.replacementStartupTimeoutMs (default 10000) + DEFAULT_CONFIG. This subtask reads it for the
        startup timeout default; tests inject a small value."
  pattern: "DEFAULT_CONFIG is frozen; the field is positive-finite-validated."

- file: tests/stream-proxy-abort.test.ts
  why: "Pattern source: makeCaptureDiag() / makeModel() / ev() / waitFor() (copy VERBATIM into the new test),
        the abortable upstream mock (the template for the two-phase replacement mock), and the privacy
        allow-list scan. ALSO one of the two files to SURGICALLY RECONCILE (waitFor(Capturing) + timeout injection)."
  pattern: "capturing diag → construct unit → drive events → waitFor(predicate) → assert via captured events."

- file: tests/stream-proxy-race.test.ts
  why: "The other file to SURGICALLY RECONCILE (the 'genuine clean-abort regression' test's waitFor(Capturing))."

- docfile: plan/001_b0c6691bb424/P1M6T1S1/PRP.md  (the in-flight producer; CONTRACT)
  why: "Defines RequestBuilder + ReplacementRequest exactly as this subtask consumes them. Confirms the
        triple is { ...options, reasoning: undefined } (fresh, unfrozen) and that P1.M7 owns the replacement
        abort signal (overrides options.signal at invocation — NOT inside buildReplacement)."
  section: "Goal + Integration Points (signal boundary)."

- docfile: plan/001_b0c6691bb424/P1M5T1S1/research/notes.md + P1M5T2S1/PRP.md  (the clean-abort producer)
  why: "Defines the clean-abort branch this subtask extends: triggerStop → Aborting → (catch) completeAbort
        → Capturing + freeze + proxy.abort.completed trace, leaving output OPEN. EC-007/RC-001 natural-
        completion-wins already handled (those tests are UNAFFECTED — they never reach Capturing)."
  section: "run() catch branch + the natural-completion-won path."

- docfile: plan/001_b0c6691bb424/P1M7T1S1/research/notes.md  (THIS item's evidence base)
  why: "The verbatim contract, the exact insertion point, the constructor-append decision, the _launchReplacement
        body, the forwarding-boundary decision, the z.ai mechanism recap, and the FULL impact analysis of
        extending run() past Capturing on the P1.M5 tests."
  section: "§1–§10."
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO change
├── types.ts                 # TransitionState/ProxyPhase/event guards (P1.M2.T1) — IMPORT ProxyPhase from here
├── config/index.ts          # DEFAULT_CONFIG.replacementStartupTimeoutMs (P1.M1.T2) — NO change
├── diagnostics/index.ts     # Diagnostics interface (P1.M1.T3) — INJECTED (already)
├── buffer/index.ts          # ReasoningBuffer + snapshot() (P1.M4.T1) — CONSUMED (snapshot())
├── request/
│   ├── builder.ts           # RequestBuilder + ReplacementRequest (P1.M6.T1.S1) — CONSUMED (import value)
│   └── .gitkeep             # (remove if still present — P1.M6 already replaces it)
├── provider/
│   ├── decorator.ts         # ProviderDecorator (P1.M1/M2) — NO change
│   └── proxy.ts             # StreamProxy — MODIFY (the core change of this subtask)
├── shortcut/index.ts        # ShortcutManager (P1.M4.T3) — NO change
└── state/
    ├── controller.ts        # TransitionController (P1.M3) — CONSUMED (beginReplacement/beginSplice/fail); NO change
    └── coordinator.ts       # TransitionCoordinator (P1.M4.T4) — NO change
tests/
├── stream-proxy-abort.test.ts       # RECONCILE (5 tests: timeout-inject + waitFor→trace)
├── stream-proxy-race.test.ts        # RECONCILE (1 test: timeout-inject + waitFor→trace)
├── stream-proxy-replacement.test.ts # CREATE (new two-phase-mock suite)
└── … (all other suites unchanged)
```

### Desired Codebase tree with files to be added/changed

```bash
src/provider/proxy.ts                  # MODIFY: +imports, +fields, +2 ctor params, +authority getter,
                                      #         +_launchReplacement/_startReplacementTimeout/_clearReplacementTimeout,
                                      #         run() clean-abort branch: return; → await _launchReplacement(...)
tests/stream-proxy-replacement.test.ts # CREATE: two-phase-mock suite (6 tests)
tests/stream-proxy-abort.test.ts       # RECONCILE: 5 tests (inject small replacementStartupTimeoutMs + waitFor→trace)
tests/stream-proxy-race.test.ts        # RECONCILE: 1 test  (inject small replacementStartupTimeoutMs + waitFor→trace)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: the replacement MUST use a FRESH AbortController (_replacementAbort). The primary's
//   _internalAbort is ALREADY aborted (triggerStop aborted it to stop the reasoning stream). Reusing it
//   would make the replacement die instantly. Create _replacementAbort in _launchReplacement.

// CRITICAL: fan-in Pi's external signal (options.signal) into _replacementAbort so ctrl+c still aborts the
//   replacement. Mirror the constructor's fan-in (if already aborted → abort now; else addEventListener once).

// CRITICAL: extending run() past Capturing moves the FSM Aborting→Capturing→Restarting in ONE microtask
//   burst (buildReplacement + beginReplacement are synchronous; the first await is the `for await`). So a
//   setTimeout-polling `waitFor(() => getState() === "Capturing")` can NEVER observe Capturing — the P1.M5
//   tests that do this MUST be reconciled (wait for the `proxy.abort.completed` trace instead + inject a
//   small replacementStartupTimeoutMs to bound orphaned replacement work).

// CRITICAL: do NOT call trackEvent on replacement events. The buffer is FROZEN (P1.M5) and trackEvent's
//   append branch (guarded on Reasoning) is a no-op anyway; replacement-event processing (filtering, EC-017
//   stray-reasoning suppression, completion) is T2/T3's job. Forward inline in _launchReplacement.

// CRITICAL: the replacement is invoked with `{ ...triple.options, signal: replacementAbort.signal }`.
//   triple.options.reasoning === undefined (from buildReplacement) → z.ai enable_thinking=false. Do NOT set
//   reasoning:'off'; do NOT clear thinkingBudgets; inject the signal by spreading (preserve every other field).

// GOTCHA: beginReplacement() throws if not in Capturing, beginSplice() if not in Restarting — but in
//   _launchReplacement's flow the preconditions are guaranteed (we just completeAbort()'d / beginReplacement()'d).
//   fail("replacement-startup-timeout") is Any→Failed and never throws.

// GOTCHA: the primary pushed NO terminal (output left OPEN by the abort path). The replacement's `done`
//   forwarded via push IS the single terminal — do NOT also synthesize one on the natural exit. Synthesize
//   ONLY in the catch (timeout/provider error) and only because push is idempotent once complete.

// GOTCHA: RequestBuilder is a VALUE import (the proxy constructs `new RequestBuilder(diagnostics)`); ProxyPhase
//   is a TYPE import from "../types". Do not type-import RequestBuilder (you need the class).

// PRIVACY (Appendix H): replacement diagnostics (proxy.replacement.first-event / .startup-timeout / .failed)
//   log {} / {timeoutMs} / {error} ONLY — never context, options, reasoning, or prompt content.
```

---

## Implementation Blueprint

### Data models and structure

No new persistent models. One new private state shape on `StreamProxy`:

```typescript
private readonly _requestBuilder: RequestBuilder;           // DI; default new RequestBuilder(diagnostics)
private readonly _replacementStartupTimeoutMs: number;      // from config (default 10000)
private _replacementAbort: AbortController | undefined;     // FRESH per replacement
private _replacementStartupTimer: ReturnType<typeof setTimeout> | undefined;
private _authority: ProxyPhase = "forwarding";              // → "splicing" on first replacement event
get authority(): ProxyPhase { return this._authority; }
```

The replacement triple is `RequestBuilder.buildReplacement(...)`'s `ReplacementRequest` (consumed by
inference — no explicit import needed; TS infers `triple.model/context/options`). Type safety is enforced
by `strict: true` + `isolatedModules: true` (`tsconfig.json`) and the `tsc --noEmit` gate.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — imports + state + ctor params + authority getter
  - ADD value import `import { RequestBuilder } from "../request/builder";` and type import
    `import type { ProxyPhase } from "../types";` to the existing import block.
  - ADD the 5 new private fields (_requestBuilder, _replacementStartupTimeoutMs, _replacementAbort,
    _replacementStartupTimer, _authority) near the existing _internalAbort/_abortTimer fields (with the
    Mode-A JSDoc from "What / B").
  - APPEND 2 ctor params: `requestBuilder?: RequestBuilder` and
    `replacementStartupTimeoutMs: number = DEFAULT_CONFIG.replacementStartupTimeoutMs` AFTER the existing
    `abortTimeoutMs` param (preserves every positional call). Wire them in the body:
    `this._requestBuilder = requestBuilder ?? new RequestBuilder(diagnostics);`
    `this._replacementStartupTimeoutMs = replacementStartupTimeoutMs;`
  - ADD the `get authority(): ProxyPhase` getter near the controller/buffer getters.
  - FOLLOW pattern: the existing _internalAbort + options.signal fan-in (ctor) + _abortTimeoutMs.
  - GOTCHA: append params (do NOT reorder — the FM-006 test passes abortTimeoutMs positionally).
  - DEPENDENCIES: RequestBuilder from src/request/builder (P1.M6); ProxyPhase from src/types (exists).

Task 2: MODIFY src/provider/proxy.ts — _launchReplacement + _startReplacementTimeout + _clearReplacementTimeout
  - ADD the three private methods with the Mode-A JSDoc + bodies from "What / F" verbatim.
  - IMPLEMENT: buildReplacement → beginReplacement → fresh _replacementAbort + external fan-in →
    originalStreamFn({ ...triple.options, signal }) → _startReplacementTimeout → for-await (first event →
    _clearReplacementTimeout + beginSplice + authority="splicing" + trace; push event) → catch
    (classify timeout vs failure; synthesize error terminal via makeErrorAssistantMessage).
  - FOLLOW pattern: _startAbortTimeout/_clearAbortTimeout (mirrored), makeErrorAssistantMessage (reused),
    run()'s synthesized-terminal safety net.
  - GOTCHA: fresh _replacementAbort (NOT _internalAbort); do NOT call trackEvent on replacement events;
    synthesize a terminal ONLY in the catch; trace names are proxy.replacement.* (distinct from proxy.abort.*).
  - DEPENDENCIES: Task 1 (fields/ctor).

Task 3: MODIFY src/provider/proxy.ts — run() clean-abort branch wiring
  - FIND the existing `if (this._controller.getState() === "Aborting") { … this.diagnostics.trace("proxy.abort.completed", {}); return; }`
    branch in run()'s catch.
  - REPLACE ONLY the final `return;` with `await this._launchReplacement(model, context, options, upstreamStreamFn); return;`
    (everything above — completeAbort/freeze/trace — is the PRD §40 precondition, UNCHANGED).
  - GOTCHA: pass model/context/options/upstreamStreamFn (run()'s params) straight through.
  - DEPENDENCIES: Task 2.

Task 4: CREATE tests/stream-proxy-replacement.test.ts
  - COPY makeCaptureDiag/makeModel/ev/waitFor VERBATIM from tests/stream-proxy-abort.test.ts.
  - IMPLEMENT makeReplacementUpstream() (two-phase mock from "What / Test") — primary on call 1 (records
    nothing; throws on its signal abort), replacement on call 2 (records options; throws on its signal abort).
  - IMPLEMENT the 6 coverage cases (reasoning===undefined + fresh signal; Capturing→Restarting→Splicing;
    authority flip; startup timeout → Failed; replacement text forwarded; privacy guard).
  - FOLLOW pattern: tests/stream-proxy-abort.test.ts (bun:test describe/test/expect; waitFor; capture diag).
  - COVERAGE: the headline MOCKING contract + FSM + authority + timeout + baseline forward + privacy.
  - PLACEMENT: tests/stream-proxy-replacement.test.ts.
  - DEPENDENCIES: imports StreamProxy from "../src/provider/proxy"; TransitionController/ReasoningBuffer;
    DEFAULT_CONFIG from "../src/config" (for the 9th positional abortTimeoutMs when injecting the 10th).

Task 5: RECONCILE tests/stream-proxy-abort.test.ts (5 tests)
  - FOR each affected test ("clean abort happy path", "first-press-wins / isInterrupting", "privacy guard"
    [hard waitFor(Capturing)]; "canInterrupt()/isInterrupting() delegation", "Pi escape propagates"
    [orphaned-replacement leak]): (a) import DEFAULT_CONFIG from "../src/config"; (b) change the
    `new StreamProxy(...)` call to append `, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15` (a small
    replacementStartupTimeoutMs so orphaned replacement work fails fast); (c) replace any
    `waitFor(() => controller.getState() === "Capturing")` with
    `waitFor(() => events.some((c) => c.event === "proxy.abort.completed"))`.
  - PRESERVE every other assertion (buffer-frozen, no proxy.forward.upstream-threw, etc.) — they still hold.
  - DO NOT touch the unaffected tests ("triggerStop outside Reasoning", "FM-006 timeout",
    "normal forwarding regression").
  - DEPENDENCIES: Task 3 (the behavior change being reconciled).

Task 6: RECONCILE tests/stream-proxy-race.test.ts (1 test)
  - FOR "genuine clean-abort regression (no terminal forwarded)": same recipe as Task 5 (import DEFAULT_CONFIG;
    append `, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15`; replace waitFor(Capturing) → waitFor trace).
  - DO NOT touch the natural-completion-won race tests or the normal-forwarding regression (they never reach
    Capturing → unaffected).
  - DEPENDENCIES: Task 3.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — the clean-abort branch now launches the replacement (PRD §40/§51).
// In run()'s catch, AFTER completeAbort()+freeze()+trace("proxy.abort.completed"):
await this._launchReplacement(model, context, options, upstreamStreamFn);
return;

// PATTERN — _launchReplacement: fresh abort controller + Pi fan-in + SAME provider fn + first-event splice.
const triple = this._requestBuilder.buildReplacement(model, context, options, this._buffer.snapshot());
this._controller.beginReplacement();                      // Capturing → Restarting
this._replacementAbort = new AbortController();           // FRESH (NOT _internalAbort — already aborted)
const external = options?.signal;                         // fan-in so ctrl+c aborts the replacement
if (external) {
  if (external.aborted) this._replacementAbort.abort();
  else external.addEventListener("abort", () => this._replacementAbort!.abort(), { once: true });
}
const replacementStream = originalStreamFn(triple.model, triple.context, {
  ...triple.options,                                       // reasoning === undefined (P1.M6) → z.ai thinking OFF
  signal: this._replacementAbort.signal,
});
this._startReplacementTimeout();                          // PRD §43 — cleared on first event
let firstSeen = false;
for await (const event of replacementStream) {
  if (!firstSeen) {
    firstSeen = true;
    this._clearReplacementTimeout();
    this._controller.beginSplice();                        // Restarting → Splicing
    this._authority = "splicing";                          // authority transfer (irreversible)
    this.diagnostics.trace("proxy.replacement.first-event", {});
  }
  this._output.push(event);                               // BASELINE forward (T2 refines filtering)
}

// PATTERN — startup timeout mirrors _startAbortTimeout: fail + abort to unblock the iterator.
private _startReplacementTimeout(): void {
  this._clearReplacementTimeout();
  this._replacementStartupTimer = setTimeout(() => {
    if (this._controller.getState() === "Restarting") {   // only if no first event yet
      this._controller.fail("replacement-startup-timeout"); // Restarting → Failed (never throws)
      this._replacementAbort?.abort();                      // unblock → iterator throws → catch synthesizes terminal
    }
  }, this._replacementStartupTimeoutMs);
}

// GOTCHA — _internalAbort is ALREADY aborted; the replacement MUST use a fresh _replacementAbort.
// GOTCHA — do NOT call trackEvent on replacement events (buffer frozen; T2/T3 own replacement processing).
// GOTCHA — the primary pushed no terminal; the replacement's done IS the single terminal (no double synthesize).
// GOTCHA — extending run() past Capturing breaks waitFor(Capturing) in P1.M5 tests → reconcile (Task 5/6).
// PRIVACY — proxy.replacement.* logs {} / {timeoutMs} / {error} only (Appendix H).
```

### Integration Points

```yaml
# This subtask MODIFIES src/provider/proxy.ts (+ reconciles 2 test files + adds 1 test file). No other module changes.

REQUESTBUILDER (src/request/builder.ts — P1.M6, consumed): NO CHANGE. _launchReplacement calls
  builder.buildReplacement(model, context, options, buffer.snapshot()) and spreads {...triple.options, signal}.

CONTROLLER (src/state/controller.ts — P1.M3, consumed): NO CHANGE. beginReplacement()/beginSplice()/fail()
  already exist; this subtask calls them.

BUFFER (src/buffer/index.ts — P1.M4, consumed read-only): NO CHANGE. _launchReplacement passes
  buffer.snapshot() (already frozen) to buildReplacement. Replacement events do NOT touch the buffer.

CONFIG (src/config/index.ts): NO CHANGE. replacementStartupTimeoutMs already exists (default 10000).

PROVIDER INVOCATION: the replacement uses the SAME captured provider streamSimple (originalStreamFn —
  run()'s upstreamStreamFn param), invoked with { ...triple.options, signal: replacementAbort.signal }.
  No new provider integration; ADR-003 decoration is unchanged.

DECORATOR / COORDINATOR / FACTORY / SHORTCUT / TYPES: NO CHANGE. types.ts already exports ProxyPhase.
  (ProxyPhase import is type-only — no runtime coupling.)
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after modifying src/provider/proxy.ts — must be clean before writing/reconciling tests.
npx bun run typecheck     # tsc --noEmit over src/** — proxy.ts MUST compile (0 diagnostics)
npx bun run build         # tsc → exit 0 (verify dist/provider/proxy.js still emits)

# (No ruff/mypy — TS project. Match the existing 2-space style + Mode-A JSDoc.)
# Expected: Zero errors. Common READ-for failures:
#  - "Cannot find name 'RequestBuilder'" → value-import is missing/typo'd: `import { RequestBuilder } from "../request/builder";`
#  - "Cannot find name 'ProxyPhase'" → type-import missing: `import type { ProxyPhase } from "../types";`
#  - "Property 'authority' does not exist" → the getter was not added (Task 1).
#  - an unused-import error → should NOT happen (isolatedModules, no noUnusedLocals); if a future config adds
#    it, ensure every new import is used.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the new suite in isolation.
npx bun test tests/stream-proxy-replacement.test.ts -v

# Reconciled suites must still pass.
npx bun test tests/stream-proxy-abort.test.ts tests/stream-proxy-race.test.ts -v

# Full suite for regressions (every other suite unchanged).
npx bun test

# Expected: All green. Common failures to READ for:
#  - "waitFor timed out" on getState()==="Capturing" in an abort/race test → you skipped the Task 5/6 reconcile
#    (the FSM now continues to Restarting). Apply the recipe: waitFor the proxy.abort.completed trace instead.
#  - "expected reasoning to be undefined, received 'high'" (new replacement test) → the invocation did not
#    spread triple.options with reasoning cleared; ensure buildReplacement ran and you spread {...triple.options, signal}.
#  - a test hangs → an orphaned replacement iterator leaked (you forgot to inject the small
#    replacementStartupTimeoutMs in a reconciled test, OR the replacement mock never completes). Bound it.
#  - "proxy.forward.upstream-threw" assertion fails in an abort test → _launchReplacement's catch is reusing
#    the wrong trace name; ensure it logs proxy.replacement.* (distinct from proxy.forward.upstream-threw).
```

### Level 3: Integration Testing (System Validation)

```bash
# (a) The full pre-existing suite is byte-for-byte unchanged EXCEPT the enumerated reconcile edits:
npx bun test tests/reasoning-buffer.test.ts tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts \
             tests/transition-controller.test.ts tests/transition-coordinator.test.ts tests/shortcut-manager.test.ts \
             tests/golden/golden-replay.test.ts tests/factory.test.ts tests/provider-decorator.test.ts -v

# (b) The build still emits the modified module:
npx bun run build && ls dist/provider/   # expect: proxy.js + proxy.d.ts (+ maps)

# (c) Full suite (the real integration bar — every suite + the new replacement file + the reconciled files):
npx bun test

# Expected: (a) all green unchanged; (b) dist/provider/proxy.{js,d.ts} present; (c) all green, zero regressions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Lifecycle determinism: drive the full Reasoning → StopRequested → Aborting → Capturing → Restarting →
# Splicing path in the new replacement test and assert the exact state sequence + the authority flip + the
# reasoning:undefined invocation. (Covered by the new suite's FSM + authority + invocation cases.)

# Timeout robustness (PRD §43): with a tiny replacementStartupTimeoutMs and NO replacement events, assert
# the FSM reaches Failed, proxy.replacement.startup-timeout is warned, and output still completes (the
# synthesized error terminal) so no consumer hangs. (Covered by the new suite's timeout case.)

# Authority irreversibility (PRD §39): after the first replacement event flips authority to "splicing",
# it must stay "splicing" regardless of subsequent events. (Assert proxy.authority across the replacement loop.)

# Privacy guard (Appendix H): assert every proxy.replacement.* event's fields ∈ {{}, {timeoutMs}, {error}}.
# (Covered by the new suite's privacy case, mirroring the abort test's allow-list scan.)

# Expected: lifecycle deterministic; timeout fails cleanly; authority irreversible; privacy green.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0; `dist/provider/proxy.{js,d.ts}` emitted.
- [ ] Level 2: `npx bun test` → **all green** (new `stream-proxy-replacement` + reconciled abort/race + every other suite).
- [ ] No regressions: every test that does NOT reach `Capturing` is byte-identical and still passes
      (race/natural-completion, FM-006, normal-forwarding, buffer/state/shortcut/coordinator/golden/factory/decorator).
- [ ] `proxy.ts` adds only the value import `RequestBuilder` + type import `ProxyPhase` + the enumerated
      fields/methods; no new runtime dependencies.

### Feature Validation
- [ ] `run()`'s clean-abort branch awaits `_launchReplacement(...)` (the `proxy.abort.completed` trace +
      frozen buffer precondition are unchanged).
- [ ] The replacement is invoked via the SAME `originalStreamFn` with `{ ...triple.options, signal:
      replacementAbort.signal }`, where `triple.options.reasoning === undefined` (z.ai thinking disabled) and
      `signal` is a FRESH, non-pre-aborted `AbortController`.
- [ ] FSM flows `Capturing → Restarting` (on `beginReplacement`) → `Splicing` (on the first replacement event,
      via `beginSplice`); `authority` flips `"forwarding" → "splicing"` (irreversible).
- [ ] No first replacement event within `replacementStartupTimeoutMs` → `Failed` + `_replacementAbort.abort()`
      + `proxy.replacement.startup-timeout` warn + a synthesized error terminal (output never hangs).
- [ ] Replacement events are forwarded into `output` as a baseline (single-start/single-terminal invariants
      hold); `trackEvent` is NOT called on replacement events.
- [ ] Pi's external signal (`options.signal`) is fan-in'd into `_replacementAbort` so `ctrl+c` aborts the
      replacement too.

### Code Quality Validation
- [ ] Mode-A JSDoc (new fields/methods + the modified branch) citing PRD §16/§18/§21/§39/§40/§43/§51 + the
      z.ai `enable_thinking` mechanism — matches the existing proxy.ts style.
- [ ] Fresh `_replacementAbort` (NOT `_internalAbort`); `beginReplacement`/`beginSplice`/`fail` reused as-is.
- [ ] Reconcile edits are minimal + enumerated (timeout injection + `waitFor`→trace); no other test lines changed.
- [ ] File placement matches the desired tree.

### Documentation & Deployment
- [ ] JSDoc explains WHY the replacement needs a fresh abort controller, WHY `reasoning === undefined`
      disables z.ai thinking, and WHY the FSM continues past Capturing (the P1.M5 reconcile rationale).
- [ ] JSDoc marks the baseline-forward boundary (T2 refines filtering; T3 owns completion).
- [ ] No new env vars / config (reads existing `replacementStartupTimeoutMs`).

---

## Anti-Patterns to Avoid
- ❌ Don't reuse `_internalAbort` for the replacement — it is ALREADY aborted (triggerStop used it to stop the
  primary). Create a FRESH `_replacementAbort` in `_launchReplacement`.
- ❌ Don't skip the Pi external-signal fan-in — without it, `ctrl+c` no longer aborts the replacement.
  Mirror the constructor's fan-in (`if (external.aborted) abort(); else addEventListener(…, { once: true })`).
- ❌ Don't invoke the replacement with `reasoning: "high"`/`"off"` — spread `triple.options` (whose `reasoning`
  is `undefined` from `buildReplacement`) and override ONLY `signal`. `undefined` short-circuits before
  `clampThinkingLevel` in `openai-completions.js` → `enable_thinking=false`. Do NOT clear `thinkingBudgets`.
- ❌ Don't call `trackEvent` on replacement events — the buffer is FROZEN and replacement processing is
  T2/T3's job. Drive the first-event splice transition inline in `_launchReplacement`.
- ❌ Don't synthesize a terminal on the natural replacement exit — the primary pushed none and the
  replacement's `done` IS the single terminal. Synthesize ONLY in the catch (push is idempotent once complete).
- ❌ Don't reorder/rename the existing constructor params — APPEND `requestBuilder?` +
  `replacementStartupTimeoutMs` after `abortTimeoutMs` so every existing positional call (incl. the FM-006
  test's 8th arg) is unchanged.
- ❌ Don't ignore the P1.M5 test impact — extending `run()` past `Capturing` makes `waitFor(Capturing)`
  unobservable (synchronous Capturing→Restarting) and launches a replacement in every test that reaches
  Capturing. Apply the Task 5/6 reconcile recipe (inject a small `replacementStartupTimeoutMs` + wait for the
  `proxy.abort.completed` trace). These are necessary lifecycle-extension edits, NOT regressions.
- ❌ Don't touch `RequestBuilder`, `TransitionController`, `coordinator.ts`, `buffer/`, `config/`,
  `decorator.ts`, `shortcut/`, `index.ts`, `types.ts`, or any unaffected test — this subtask is `proxy.ts`
  + the new test + the 2 enumerated reconciles only.
- ❌ Don't use trace names that collide with the abort path (`proxy.abort.*` / `proxy.forward.upstream-threw`)
  for replacement events — use `proxy.replacement.*` so the P1.M5 privacy/trace assertions stay accurate.
- ❌ Don't log context/options/reasoning/prompt content (Appendix H) — `proxy.replacement.*` logs
  `{}` / `{timeoutMs}` / `{error}` only.

---

**Confidence Score: 9/10** for one-pass implementation success. The change is a well-bounded extension of the
existing `run()` clean-abort branch, reusing the established abort-controller/timeout/synthesized-terminal
patterns; the z.ai disable-thinking mechanism is confirmed (compiled `openai-completions.js`); the
`_launchReplacement` body, the two-phase test mock, and the reconcile recipe are reproduced verbatim. The
residual uncertainty (the reason this is 9 and not 10) is the **breadth of the P1.M5 test reconcile**
(≤6 tests across 2 files): the PRP enumerates the exact edits and the WHY, but the implementer must apply
them carefully and ensure no orphaned-replacement iterator leaks (hence the mandatory
small-`replacementStartupTimeoutMs` injection). The forwarding-boundary decision (baseline forward here;
filtering/completion deferred to T2/T3) is the other judgment call — it is documented as the only way to
keep the subtask testable end-to-end without stealing T2/T3's scope. (A catch-classification bug in the
prior draft — a dead `getState() === "Restarting"` branch that double-warned on the timeout path — has
been corrected to skip the warn when state is already `Failed`; the timeout handler still logs
`proxy.replacement.startup-timeout` itself, so test case #4's assertion holds.)
