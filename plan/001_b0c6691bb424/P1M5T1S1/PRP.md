# PRP — P1.M5.T1.S1: AbortController wrapper & upstream stream abort handling (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M5.T1.S1 (Phase 4 Abort Coordination, 2 pts) — give **`StreamProxy`** an **internal
> `AbortController`** + a **`triggerStop()`** method so a stop request **gracefully aborts the UPSTREAM
> reasoning stream WITHOUT aborting Pi's overall request**, freezes the reasoning buffer, and walks the FSM
> `Reasoning → StopRequested → Aborting → Capturing` (PRD §16/§51 Abort Phase). **Work-item contract
> (verbatim logic)**: in the constructor create `internalAbort = new AbortController()`; propagate Pi's
> `options.signal` into it (so Pi's escape still reaches the upstream); pass `{ ...options, signal:
> internalAbort.signal }` to `upstreamStreamFn`; `triggerStop()`: (a) `!controller.canInterrupt()` →
> `false`; (b) `controller.requestStop()`; (c) `controller.beginAbort()`; (d) `internalAbort.abort()`;
> (e) `run()`'s `for await` catch — when state is `'Aborting'` the abort throw is EXPECTED →
> `controller.completeAbort()` (→ Capturing); (f) `buffer.freeze()`; (g) return `true`. Add an abort timeout
> (`config.transitionTimeoutMs`): if the upstream doesn't close within it, `fail()` → `'Failed'` (FM-006).
> **Builds on** (DONE/immutable — do NOT modify): `TransitionController` (**P1.M3.T1.S1**,
> `src/state/controller.ts` — `canInterrupt`/`requestStop`/`beginAbort`/`completeAbort`/`fail` all EXIST),
> `ReasoningBuffer` (**P1.M4.T1.S1**, `src/buffer/index.ts` — `freeze()` exists, idempotent), `StreamProxy`
> (**P1.M4.T2.S1**, `src/provider/proxy.ts` — `isReasoning()` exists; this subtask ADDS
> `canInterrupt`/`isInterrupting`/`triggerStop`). **Consumes by contract** the **`ActiveProxy`** seam from
> the parallel **`TransitionCoordinator`** (**P1.M4.T4.S1**, `src/state/coordinator.ts`): adding the three
> missing methods makes the concrete `StreamProxy` structurally assignable to `ActiveProxy` so the
> coordinator can delegate. **Consumed by**: **P1.M5.T2** (FM-005 completion-wins race — layered on this),
> **P1.M6** (RequestBuilder reads `buffer.snapshot()` AFTER `Capturing`), **P1.M7** (splicing — owns the
> downstream terminal that this subtask deliberately leaves OPEN).

---

## Goal

**Feature Goal**: Extend `StreamProxy` so it can **abort the upstream reasoning stream on demand** via an
**internal** `AbortController` (separate from Pi's `options.signal`), while preserving Pi's user-escape
abort and the single-writer FSM. A successful abort is graceful: the FSM reaches `'Capturing'`, the reasoning
buffer is frozen, the upstream iterator's abort error is caught and treated as the expected "upstream exit",
and the downstream `output` is left **open** for the replacement stream (P1.M6/P1.M7) to splice into. A
provider that **ignores** the abort (FM-006) is bounded by a configurable timeout → `'Failed'`.

**Deliverable** (ONE source file MODIFIED + ONE test file CREATED; NO other files change — see Scope Boundary):
- `src/provider/proxy.ts` — **MODIFY**: add fields `_internalAbort` (`AbortController`), `_abortTimer`,
  `_abortTimeoutMs`, `INTERRUPTING_STATES`; propagate `options.signal` → `_internalAbort` in the constructor;
  pass `{ ...options, signal: this._internalAbort.signal }` to `upstreamStreamFn` in `run()`; add an
  expected-abort branch to `run()`'s catch (clear timeout → `completeAbort()` → `buffer.freeze()` → return,
  no synthesized terminal); add public `canInterrupt()`, `isInterrupting()`, `triggerStop()` (so `StreamProxy`
  satisfies `ActiveProxy`); add `_startAbortTimeout()`/`_clearAbortTimeout()`; add an 8th optional ctor param
  `abortTimeoutMs = DEFAULT_CONFIG.transitionTimeoutMs`.
- `tests/stream-proxy-abort.test.ts` — **NEW** `bun:test` suite: a signal-aware **abortable upstream** mock +
  an **unresponsive upstream** mock (ignores abort) + a `waitFor` polling helper; covers clean-abort happy
  path (§51), triggerStop-outside-Reasoning, first-press-wins/isInterrupting, canInterrupt delegation,
  FM-006 timeout, Pi-signal propagation, and a normal-forwarding regression.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics; `npx bun run build`
→ exit 0; `npx bun test` → **ALL green** — the new `stream-proxy-abort.test.ts` PLUS every pre-existing suite
(including the parallel P1.M4.T4 coordinator suite) with **ZERO changes and ZERO regressions**. A clean abort:
`triggerStop()` returns `true`, the FSM ends in `'Capturing'`, `buffer` is frozen, the upstream mock's
injected signal is aborted, and NO terminal is synthesized on `output` (it stays open). `triggerStop()`
outside `Reasoning` returns `false` and dispatches no abort. FM-006: an abort-ignoring upstream + tiny
`abortTimeoutMs` ⇒ `'Failed'` with a `proxy.abort.timeout` warn. `StreamProxy` is structurally assignable to
`ActiveProxy`. No edits to any file other than `src/provider/proxy.ts` + the new test file.

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing. The abort machinery is an internal mechanism (work-item DOCS:
"none — internal mechanism"). The end user triggers it indirectly via the shortcut (through the coordinator,
P1.M4.T4), which calls `proxy.triggerStop()`.

**Use Case**: The user presses `ctrl+.` mid-reasoning. `TransitionCoordinator.requestStop()` (P1.M4.T4)
checks `proxy.canInterrupt()` (true, mid-Reasoning) and calls `proxy.triggerStop()`. `triggerStop()` moves
the FSM `Reasoning→StopRequested→Aborting` and aborts the **internal** controller, which makes the upstream
provider's iterator throw. `run()` catches that throw, sees state `'Aborting'`, completes to `'Capturing'`,
and freezes the reasoning buffer. Pi's own request (and its `options.signal`) are untouched — only the
upstream reasoning stream was stopped. (The replacement stream that actually produces the answer is P1.M6/P1.M7.)

**Pain Points Addressed**: There is no server-side way to interrupt z.ai reasoning (ADR-001). The only lever
is to **abort the client-side stream** mid-flight. Naively aborting Pi's `options.signal` would cancel the
whole request (including the eventual answer). An **internal** `AbortController` lets the proxy stop just the
reasoning stream while keeping Pi's request alive for the spliced replacement (P1.M7).

---

## Why

- **It is the only way to stop reasoning (ADR-001).** z.ai cannot be interrupted server-side; the client must
  abort the stream. An internal controller does this **without** aborting Pi's overall request.
- **It preserves Pi's escape (ctrl+c).** Pi's `options.signal` is **propagated** into the internal controller
  (one-way fan-in), so a user escape still stops the upstream; the internal controller adds the
  *extension-initiated* stop on top without coupling to Pi's signal object.
- **It keeps the FSM the single writer (PRD §13.3/§37).** All state moves go through the existing
  `TransitionController` methods (`requestStop`/`beginAbort`/`completeAbort`/`fail`); this subtask adds NO new
  state owners — it only *calls* them from `triggerStop()` and `run()`'s catch.
- **It is the gate before replacement (PRD §40/§51).** "No replacement request may begin before reasoning is
  frozen." Freezing happens exactly at the `Aborting→Capturing` boundary this subtask creates, so P1.M6 can
  safely `buffer.snapshot()`.
- **It is bounded (FM-006/§43).** A provider that ignores the abort cannot hang the transition forever; the
  configurable `transitionTimeoutMs` ceiling forces `'Failed'`.

---

## What

### Source: MODIFY `src/provider/proxy.ts`

#### A. New private fields (add near the existing `_output`/`_controller`/`_buffer`)

```typescript
/**
 * Internal abort controller for the UPSTREAM stream ONLY (PRD §51 Abort Phase). Per-request, so the proxy
 * can abort the reasoning stream WITHOUT aborting Pi's overall request (whose signal is `options.signal`).
 * `triggerStop()` aborts this; `run()` passes `this._internalAbort.signal` to `upstreamStreamFn`. The
 * upstream's async iterator throws when aborted — `run()`'s catch treats that throw as the expected exit.
 */
private readonly _internalAbort: AbortController = new AbortController();

/**
 * Pending abort-timeout timer (FM-006/§43). Armed by `triggerStop()` when abort is dispatched; cleared when
 * `run()` observes the upstream exit (clean abort) or when it fires (→ `Failed`). `undefined` when idle.
 */
private _abortTimer: ReturnType<typeof setTimeout> | undefined;

/** Hard ceiling (ms) for the upstream to close after abort before the transition fails (PRD §43). Defaults
 *  to `DEFAULT_CONFIG.transitionTimeoutMs`; tests inject a small value to exercise FM-006 quickly. */
private readonly _abortTimeoutMs: number;

/**
 * States in which a transition is IN FLIGHT (past `Reasoning`, not yet terminal). `isInterrupting()` is
 * `true` here (PRD §24.3 / INV-004) — used by the coordinator/ShortcutManager to discard repeat presses.
 */
private static readonly INTERRUPTING_STATES: ReadonlySet<TransitionState> = new Set<TransitionState>([
  "StopRequested", "Aborting", "Capturing", "Restarting", "Splicing", "Answering",
]);
```

#### B. Constructor — add the 8th optional param + propagate Pi's signal

Append `abortTimeoutMs: number = DEFAULT_CONFIG.transitionTimeoutMs` as the last constructor parameter
(after `buffer?`), then in the body (before `void this.run(...)`):

```typescript
this._abortTimeoutMs = abortTimeoutMs;

// Propagate Pi's abort (user escape / ctrl+c) into the INTERNAL controller so the upstream still stops on
// escape, while keeping a SEPARATE controller the extension can abort via triggerStop() without touching
// Pi's request. (One-way fan-in: external.aborted → internal.abort(); never the reverse.)
const external = options?.signal;
if (external) {
  if (external.aborted) this._internalAbort.abort();
  else external.addEventListener("abort", () => this._internalAbort.abort(), { once: true });
}
```
> The existing 5-arg decorator caller (`new StreamProxy(model, context, options ?? {}, originalStreamSimple,
> this.diagnostics)`) is unchanged — `controller`/`buffer`/`abortTimeoutMs` all default.

#### C. `run()` — pass the internal signal + handle the expected-abort throw

Change the upstream call to inject the internal signal, and add the expected-abort branch to the catch:

```typescript
private async run(model, context, options, upstreamStreamFn): Promise<void> {
  try {
    // Inject the INTERNAL signal (NOT options.signal) so triggerStop() can abort reasoning without
    // aborting Pi's overall request. options.signal was already fan-in'd into _internalAbort in the ctor.
    const upstream = upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal });
    for await (const event of upstream) {
      this.trackEvent(event);   // side-effect reasoning detection; never throws; never mutates event
      this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
    }
    // Natural exit (terminal already pushed). NOTE: if triggerStop() ran first but the upstream completed
    // naturally instead of throwing, the catch below does NOT run — that FM-005 race is P1.M5.T2's job.
  } catch (err) {
    // EXPECTED ABORT (PRD §51 Abort Phase): triggerStop() set Aborting + aborted _internalAbort; the
    // upstream iterator threw an abort error. This is the graceful "upstream exit" — complete the transition
    // and freeze reasoning. Do NOT synthesize a terminal: the replacement stream (P1.M6/P1.M7) owns the
    // downstream terminal, so output must stay OPEN while the transition is in flight.
    if (this._controller.getState() === "Aborting") {
      this._clearAbortTimeout(); // clean abort — cancel the FM-006 safety net
      try {
        this._controller.completeAbort(); // Aborting → Capturing (PRD §16)
      } catch (e) {
        // Should not happen (state is Aborting), but never let completion break the catch.
        this.diagnostics.warn("proxy.abort.complete-abort-failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this._buffer.freeze(); // (PRD §41: reasoning immutable once frozen; §40: replacement needs this)
      this.diagnostics.trace("proxy.abort.completed", {});
      return; // leave output OPEN — replacement stream (P1.M6/P1.M7) owns the terminal
    }
    // UNEXPECTED throw (network/provider error, or an abort-timeout-then-throw) → synthesize ONE terminal
    // so output.result() never hangs (single-terminal/single-result invariant). (Existing behavior.)
    const message = err instanceof Error ? err.message : String(err);
    this._clearAbortTimeout();
    this.diagnostics.warn("proxy.forward.upstream-threw", {
      provider: String(model.provider),
      model: model.id,
      error: message,
    });
    this._output.push({
      type: "error",
      reason: "error",
      error: this.makeErrorAssistantMessage(model, message),
    });
  }
}
```

#### D. New public methods (satisfy `ActiveProxy` structurally)

```typescript
/** Shortcut availability: `true` ONLY in `Reasoning` (PRD §22.5). Pure delegate to the FSM. */
canInterrupt(): boolean {
  return this._controller.canInterrupt();
}

/** A transition is in flight (PRD §24.3 / INV-004): state has left `Reasoning` but not reached terminal.
 *  Used by the coordinator/ShortcutManager to discard repeat presses (EC-009/EC-010). */
isInterrupting(): boolean {
  return StreamProxy.INTERRUPTING_STATES.has(this._controller.getState());
}

/**
 * Dispatch the stop transition (PRD §51 Stop Request → Abort Phase). This method only DISPATCHES the abort;
 * it does NOT await the upstream exit. The Aborting→Capturing move + `buffer.freeze()` happen in `run()`'s
 * catch when the upstream iterator throws (asynchronously). See T1/T2 boundary in JSDoc/PRP.
 *
 * Steps: (a) gate on `canInterrupt()` (PRD §22.5); (b) `requestStop()` Reasoning→StopRequested; (c)
 * `beginAbort()` StopRequested→Aborting; (d) `_internalAbort.abort()` (upstream throws); arm the FM-006
 * timeout; (g) return `true`.
 *
 * @returns `true` if the abort was dispatched; `false` if not in `Reasoning` (no abort, no state change).
 */
triggerStop(): boolean {
  if (!this._controller.canInterrupt()) return false; // (a) PRD §22.5 — not in Reasoning
  this._controller.requestStop();  // (b) Reasoning → StopRequested (PRD §16; legal after the gate)
  this._controller.beginAbort();   // (c) StopRequested → Aborting (PRD §16)
  this._internalAbort.abort();     // (d) upstream iterator throws an abort error (PRD §51 "Await Upstream Exit")
  this._startAbortTimeout();       // FM-006 safety net
  return true;                     // (g)
}
```

#### E. Timeout helpers (private)

```typescript
/** Arm the FM-006/§43 abort timeout. If the upstream ignores the abort and never closes within
 *  `_abortTimeoutMs`, fail the transition. */
private _startAbortTimeout(): void {
  this._clearAbortTimeout();
  this._abortTimer = setTimeout(() => {
    // Only act if we are STILL aborting (a clean abort cleared this timer; a natural completion is T2).
    if (this._controller.getState() === "Aborting") {
      this.diagnostics.warn("proxy.abort.timeout", { timeoutMs: this._abortTimeoutMs });
      this._controller.fail("abort-timeout"); // Aborting → Failed (PRD §16 Any→Failed; never throws)
    }
  }, this._abortTimeoutMs);
}

/** Cancel any pending abort timeout (clean-abort completion / unexpected throw / disposal). */
private _clearAbortTimeout(): void {
  if (this._abortTimer !== undefined) {
    clearTimeout(this._abortTimer);
    this._abortTimer = undefined;
  }
}
```

> **JSDoc convention (Mode-A):** every new method/field carries a JSDoc citing the PRD anchor (§16/§22.5/
> §24.3/§40/§41/§43/§51/INV-004/FM-006), matching the style of `src/state/controller.ts` and the existing
> `proxy.ts` members. **Privacy (Appendix H):** only state names, error categories, byte/event counts, and
> `timeoutMs` are ever logged — never context/options/event payloads or reasoning text.

### Test: CREATE `tests/stream-proxy-abort.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`). Reuse the project's existing test
doubles VERBATIM from `tests/stream-proxy-detection.test.ts`: `makeCaptureDiag()`, `makeModel()`, `ev()`,
`DONE_MESSAGE`/`ERROR_MESSAGE`. Add the three new helpers from `research/notes.md` §3:
`makeAbortableUpstream()` (signal-aware, throws on abort), `makeUnresponsiveUpstream()` (ignores abort,
blocks until `release()`), and `waitFor(pred)`. Coverage (every Success Criterion):

- **clean abort (§51 Abort Phase):** push `start`/`thinking_start`/`thinking_delta`; `waitFor` Reasoning;
  `triggerStop()` → `true`; `waitFor` `getState()==="Capturing"`; assert `buffer` frozen (a further
  `append` throws, or `proxy.abort.completed` traced), `mock.isAborted()===true`, and that NO terminal was
  synthesized (do NOT drain a consumer to completion — output is intentionally left open).
- **triggerStop outside Reasoning → false:** before any event (Idle) `triggerStop()` → `false`;
  `mock.isAborted()===false`; state unchanged (`Idle`).
- **first-press-wins / isInterrupting:** after `triggerStop()`, a second `triggerStop()` → `false`;
  `isInterrupting()` is `true` once in `Aborting`/`Capturing`.
- **canInterrupt()/isInterrupting() delegation:** `canInterrupt()` true only in `Reasoning`; in `Aborting`/
  `Capturing` it is `false` while `isInterrupting()` is `true`.
- **FM-006 timeout:** unresponsive mock + injected `abortTimeoutMs: 20`; `triggerStop()` → `true`;
  `waitFor` `getState()==="Failed"`; assert `proxy.abort.timeout` warned; then `release()` so `run()` exits
  (no dangling handle); buffer NOT frozen on this path.
- **Pi escape propagates:** construct with `options = { signal: externalCtrl.signal }`; `externalCtrl.abort()`;
  `waitFor` `mock.isAborted()===true` — Pi's escape reaches the upstream with NO `triggerStop()` call.
- **normal forwarding regression:** a complete non-aborted stream (`start`…`done`) forwards every event
  unchanged with exactly one terminal; proves the abort machinery does not perturb the transparent path.

**Out of scope** (owned by other subtasks — do NOT implement/modify here):
- **FM-005 completion-wins race detection** → **P1.M5.T2**. (If the upstream completes naturally after
  `triggerStop()`, `run()`'s catch does not run, so `completeAbort`/`freeze` do not run and the timeout will
  eventually fire → `Failed`. T2 detects natural completion and lets it win. Do NOT add that logic here.)
- **Replacement request + splicing + downstream terminal after `Capturing`** → **P1.M6/P1.M7** (output is
  deliberately left OPEN after a clean abort).
- **Full FM-006 "normal stream preserved" recovery + FM-001..FM-015** → **P1.M8.T2**.
- **Factory/decorator/coordinator wiring** (`coordinator.setActiveProxy(proxy)`, shortcut registration) →
  **P1.M5** wiring step (this subtask makes `StreamProxy` assignable to `ActiveProxy`; it does not wire it).
- Any change to `src/state/coordinator.ts`, `src/state/controller.ts`, `src/buffer/*`, `src/provider/decorator.ts`,
  `src/config/*`, `src/diagnostics/*`, `src/shortcut/*`, `src/index.ts`, `src/types.ts`, or any existing test.
  No new dependencies (AbortController/setTimeout are bun/node globals).

### Success Criteria

- [ ] `StreamProxy` gains fields `_internalAbort`/`_abortTimer`/`_abortTimeoutMs`/`INTERRUPTING_STATES`; the
      constructor propagates `options.signal` → `_internalAbort` and accepts an optional `abortTimeoutMs`
      (default `DEFAULT_CONFIG.transitionTimeoutMs`); `run()` passes `{ ...options, signal:
      this._internalAbort.signal }` to `upstreamStreamFn`.
- [ ] `run()`'s catch: when `getState()==="Aborting"`, clear the timeout, `completeAbort()` (→ Capturing),
      `buffer.freeze()`, trace `proxy.abort.completed`, and **return without a terminal**. Other throws still
      synthesize ONE terminal (unchanged).
- [ ] `triggerStop()`: `!canInterrupt()` → `false` (no abort); else `requestStop()`→`beginAbort()`→
      `_internalAbort.abort()`→`_startAbortTimeout()`→return `true`.
- [ ] `canInterrupt()`/`isInterrupting()` delegate to the controller; `isInterrupting()` true for
      StopRequested/Aborting/Capturing/Restarting/Splicing/Answering.
- [ ] FM-006: abort-ignoring upstream + small `abortTimeoutMs` ⇒ `getState()==="Failed"` +
      `proxy.abort.timeout` warn.
- [ ] `StreamProxy` is structurally assignable to `ActiveProxy` (the 4 boolean methods all present).
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green
      (every pre-existing suite, incl. the P1.M4.T4 coordinator suite, + the new file), zero regressions.

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have everything
needed to implement this successfully?"_ → YES. The exact field additions, constructor changes, `run()`
catch logic, and the three new public methods are reproduced verbatim above; the `TransitionController`/buffer
methods called all already exist (cited); the `ActiveProxy` seam is quoted from `coordinator.ts`; the test
mocks (`makeAbortableUpstream`/`makeUnresponsiveUpstream`/`waitFor`) are fully implemented in
`research/notes.md` §3 and copied from existing suite patterns; the validation gates are the project's real
commands. The one non-obvious fact — *why* an internal controller is needed and *why* `run()`'s catch, not
`triggerStop()`, does the `completeAbort`+`freeze` — is fully explained in "Why" + the T1/T2 boundary.

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask
- url: PRD.md "# 51. Complete Transition Algorithm / Abort Phase"
  why: "Abort Controller → Dispatch Abort → Await Upstream Exit → Capture Final Reasoning → Freeze Buffer.
        'No replacement request may begin before reasoning is frozen.'"
  critical: "The freeze happens AFTER the upstream exits (in run()'s catch), NOT synchronously in
             triggerStop(). triggerStop() only DISPATCHES; run() observes the exit."

- url: PRD.md "# 40. Replacement Stream Requirements"
  why: "'Replacement stream becomes authoritative only after: Primary successfully aborted / Reasoning
        frozen / Replacement request accepted.' The Capturing+freeze this subtask produces is the gate."
  critical: "P1.M6 reads buffer.snapshot() only after Capturing. output MUST stay open (no terminal) so the
             replacement stream (P1.M7) can splice in."

- url: PRD.md "# 42. Failure Mode Specification / FM-005 and FM-006"
  why: "FM-005 abort races completion (→ P1.M5.T2); FM-006 provider ignores abort → transition timeout."
  critical: "FM-006 is the timeout this subtask implements (fail after transitionTimeoutMs). FM-005
             completion-wins detection is T2 — do NOT implement it here."

- url: PRD.md "# 43. Timeout Requirements"
  why: "'Transition timeout: configurable.' = config.transitionTimeoutMs (default 5000)."
  critical: "The abort timeout reads config.transitionTimeoutMs (via DEFAULT_CONFIG). Tests inject a tiny
             value via the new ctor param to exercise FM-006 quickly."

- url: PRD.md "# 16. State Transition Table"  (and "# 17. State Invariants")
  why: "Reasoning→StopRequested→Aborting→Capturing is the abort chain. Aborting→Capturing only from Aborting."
  critical: "triggerStop() must call requestStop() THEN beginAbort() in that order (both gated legal by the
             canInterrupt() check). completeAbort() is legal only from Aborting — run() checks state first."

- url: PRD.md "# 22.5 Shortcut Availability"  (and "# 24. Stop Signal")
  why: "canInterrupt() is true ONLY in Reasoning; first-press-wins via the FSM leaving Reasoning."
  critical: "triggerStop() gates on canInterrupt(); after it the FSM is past Reasoning so a second call
             returns false (INV-004) — no local dedup state needed."

# Codebase patterns to FOLLOW (all DONE/immutable)
- file: src/provider/proxy.ts
  why: "The file under modification. Contains run()'s try/catch (the insertion point), isReasoning(),
        trackEvent(), makeErrorAssistantMessage(), and the constructor-takes-Diagnostics convention."
  pattern: "fire-and-forget run() that never rethrows; transparent forwarding `for await ... push(event)`."
  gotcha: "run()'s catch currently synthesizes a terminal on EVERY throw. The new expected-abort branch MUST
           short-circuit BEFORE that synthesis (return without a terminal) so output stays open for splicing."

- file: src/state/controller.ts
  why: "The FSM. canInterrupt/requestStop/beginAbort/completeAbort/fail ALL EXIST — call them, do NOT modify."
  pattern: "boolean gate methods (canInterrupt) + throwing transition methods + never-throwing fail()."
  gotcha: "controller.requestStop() (FSM move) ≠ coordinator.requestStop() (delegates to triggerStop). And
           triggerStop() is the proxy method — do not conflate the three."

- file: src/state/coordinator.ts   (parallel P1.M4.T4.S1 — treat as DONE contract)
  why: "Defines ActiveProxy { isReasoning/canInterrupt/triggerStop/isInterrupting }. Adding the three missing
        methods makes StreamProxy structurally assignable — zero adapter."
  pattern: "structural seam: the coordinator depends on the interface, never the concrete StreamProxy."
  gotcha: "Keep the three new method signatures byte-identical to ActiveProxy (all `: boolean`). Do NOT
           import the coordinator into proxy.ts (no cycle; not needed)."

- file: src/buffer/index.ts
  why: "freeze() exists and is idempotent. Call it once in run()'s expected-abort branch."
  pattern: "idempotent lifecycle method that never throws."
  gotcha: "Do NOT freeze on the timeout/Failed path — freeze is the clean-Capturing marker only."

- file: tests/stream-proxy-detection.test.ts
  why: "Source for makeCaptureDiag()/makeModel()/ev()/DONE_MESSAGE/ERROR_MESSAGE and the drive() pattern."
  pattern: "inject controller+buffer into the proxy so the test can inspect state/buffer directly."
  gotcha: "A real createAssistantMessageEventStream does NOT observe any AbortSignal — abort tests need a
           custom async-iterable mock (see research/notes.md §3), not the real stream."

- file: src/config/index.ts
  why: "DEFAULT_CONFIG.transitionTimeoutMs (5000) — the abort-timeout default. Already imported by proxy.ts."
  pattern: "module-level frozen default constants."
  gotcha: "Do NOT hardcode 5000 in proxy.ts — use DEFAULT_CONFIG.transitionTimeoutMs so config stays the
           single source of truth."

- docfile: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "StreamProxy contract: 'Owns: Output stream, event queue, authority state.' ActiveProxy surface."
  section: "### StreamProxy  (and ### TransitionController for the method list)"

- docfile: plan/001_b0c6691bb424/P1M5T1S1/research/notes.md
  why: "Reference mock implementations (makeAbortableUpstream/makeUnresponsiveUpstream/waitFor) + the full
        abort-mechanism walkthrough + T1/T2 boundary."
  section: "§2 (mechanism), §3 (mocks), §4 (test cases)"
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO coordinator/proxy-abort wiring yet (→ P1.M5 wiring)
├── types.ts                 # shared types incl. TransitionState (P1.M2.T1)
├── config/index.ts          # Config + DEFAULT_CONFIG.transitionTimeoutMs=5000 (P1.M1.T2)
├── diagnostics/index.ts     # Diagnostics interface + createDiagnostics (P1.M1.T3)
├── buffer/index.ts          # ReasoningBuffer — freeze() EXISTS (P1.M4.T1)
├── provider/
│   ├── decorator.ts         # ProviderDecorator — constructs StreamProxy w/ 5 args; passes options.signal (P1.M1/M2)
│   └── proxy.ts             # StreamProxy — isReasoning() exists; ← THIS SUBTASK adds abort (P1.M4.T2 → P1.M5.T1)
├── shortcut/index.ts        # ShortcutManager + StopRequestCoordinator seam (P1.M4.T3)
└── state/
    ├── controller.ts        # TransitionController FSM — canInterrupt/requestStop/beginAbort/completeAbort/fail EXIST (P1.M3.T1)
    └── coordinator.ts       # TransitionCoordinator + ActiveProxy seam (P1.M4.T4 — parallel/DONE)
tests/
├── stream-proxy-detection.test.ts  # pattern source (makeCaptureDiag/makeModel/ev/drive) (P1.M4.T2)
├── stream-proxy.test.ts            # pattern source (forwarding invariants)
└── … (existing suites — all must stay green)
```

### Desired Codebase tree with files to be added/changed

```bash
src/provider/proxy.ts                  # MODIFY: internal AbortController + triggerStop/canInterrupt/isInterrupting + abort timeout
tests/stream-proxy-abort.test.ts       # CREATE : signal-aware mock upstreams + clean-abort / FM-006 / propagation / regression
# (no other files change)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: tsconfig.json has rootDir:"./src" + exclude:["tests"]. `tsc --noEmit` (the typecheck gate)
// typechecks ONLY src/**. proxy.ts MUST compile standalone. AbortController/AbortSignal/setTimeout are bun/node
// globals — do NOT import them. DEFAULT_CONFIG is already imported from "../config".

// CRITICAL: there are THREE "stop" surfaces. controller.requestStop() = FSM Reasoning→StopRequested.
// coordinator.requestStop() = delegates to proxy.triggerStop(). proxy.triggerStop() = THIS subtask: FSM moves
// + abort the internal controller. Do not conflate them.

// CRITICAL: the expected-abort branch in run()'s catch MUST `return` BEFORE the terminal-synthesis code.
// Synthesizing a terminal on a clean abort would close output and break the P1.M7 splice (single-terminal
// invariant would fire twice). output must stay OPEN after Capturing.

// GOTCHA: run()'s catch ordering — check `getState()==="Aborting"` FIRST (expected abort); only if NOT
// Aborting fall through to the existing synthesize-terminal path. Clear the abort timer in BOTH branches.

// GOTCHA: triggerStop() is synchronous and contains NO await — so requestStop()/beginAbort() are atomic and
// both table-legal after the canInterrupt() gate (cannot throw). The async part (completeAbort/freeze) is in
// run()'s catch, which fires when the upstream iterator throws on the NEXT tick after _internalAbort.abort().

// GOTCHA: do NOT pass options.signal straight to upstreamStreamFn. Pass { ...options, signal:
// this._internalAbort.signal }. options.signal is fan-in'd into _internalAbort in the ctor (one-way).

// PRIVACY (Appendix H): log only state names / error categories / counts / timeoutMs. Never context, options,
// event payloads, or reasoning text. The buffer's freeze() already logs counts only.

// INV-004: at most one abort per response. Enforced by canInterrupt() going false after triggerStop() (FSM
// leaves Reasoning). No proxy-local dedup counter is needed.
```

---

## Implementation Blueprint

### Data models and structure

No new persistent data models. The proxy adds only ephemeral per-request fields:

```typescript
private readonly _internalAbort: AbortController = new AbortController(); // the upstream-abort lever
private _abortTimer: ReturnType<typeof setTimeout> | undefined;            // FM-006 timer (undefined when idle)
private readonly _abortTimeoutMs: number;                                  // = config.transitionTimeoutMs (DI-able)
private static readonly INTERRUPTING_STATES: ReadonlySet<TransitionState>; // drives isInterrupting()
```

`StreamProxy` becomes structurally assignable to `ActiveProxy` (4 boolean methods). Type safety is enforced
by `strict: true` (`tsconfig.json`) and the `tsc --noEmit` gate.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — internal AbortController + signal propagation
  - ADD fields: _internalAbort (new AbortController()), _abortTimer (undefined), _abortTimeoutMs,
    INTERRUPTING_STATES (Set of the 6 in-flight states).
  - ADD ctor param: `abortTimeoutMs: number = DEFAULT_CONFIG.transitionTimeoutMs` (8th, after buffer?).
  - ADD ctor body: assign _abortTimeoutMs; fan-in options.signal → _internalAbort (handle already-aborted).
  - FOLLOW pattern: existing ctor field init style + the existing `import { DEFAULT_CONFIG } from "../config"`.
  - NAMING: underscore-prefixed private fields; camelCase methods; INTERRUPTING_STATES = SCREAMING_SNAKE static.
  - PLACEMENT: src/provider/proxy.ts (fields near _output/_controller/_buffer; signal logic right before
    `void this.run(...)`).
  - DEPENDENCIES: none new (AbortController/setTimeout are globals; DEFAULT_CONFIG already imported).

Task 2: MODIFY src/provider/proxy.ts — run() signal injection + expected-abort catch branch
  - CHANGE the upstream call to `upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal })`.
  - ADD to run()'s catch: `if (getState()==="Aborting") { _clearAbortTimeout(); try{completeAbort()}catch{warn};
    buffer.freeze(); trace("proxy.abort.completed"); return; }` BEFORE the existing synthesize-terminal code.
  - ADD `_clearAbortTimeout()` at the start of the (existing) unexpected-throw branch too.
  - FOLLOW pattern: existing run() try/catch + makeErrorAssistantMessage synthesis (unchanged).
  - GOTCHA: the expected-abort branch MUST `return` (no terminal). Keep the single-terminal invariant intact
    for the unexpected path only.
  - PLACEMENT: inside run() only.
  - DEPENDENCIES: Task 1 fields (_internalAbort, _clearAbortTimeout).

Task 3: MODIFY src/provider/proxy.ts — triggerStop / canInterrupt / isInterrupting + timeout helpers
  - ADD public `canInterrupt()` (delegate), `isInterrupting()` (INTERRUPTING_STATES check), `triggerStop()`
    (gate → requestStop → beginAbort → abort → _startAbortTimeout → return true).
  - ADD private `_startAbortTimeout()` / `_clearAbortTimeout()`.
  - FOLLOW pattern: controller.ts boolean-query style + proxy.ts Mode-A JSDoc with PRD cites.
  - NAMING: triggerStop/canInterrupt/isInterrupting EXACTLY match ActiveProxy (all `: boolean`).
  - GOTCHA: triggerStop is fully synchronous (no await) → requestStop/beginAbort are atomic & legal after the
    canInterrupt gate. Keep signatures byte-identical to ActiveProxy for structural assignability.
  - PLACEMENT: alongside isReasoning().
  - DEPENDENCIES: Task 1 (_internalAbort, _abortTimeoutMs) + Task 2 (run() consumes the abort).

Task 4: CREATE tests/stream-proxy-abort.test.ts
  - COPY makeCaptureDiag/makeModel/ev/DONE_MESSAGE/ERROR_MESSAGE from tests/stream-proxy-detection.test.ts.
  - IMPLEMENT makeAbortableUpstream() / makeUnresponsiveUpstream() / waitFor() per research/notes.md §3.
  - IMPLEMENT the 7 coverage cases in "What / Test" (clean abort; triggerStop-outside-Reasoning; first-press-
    wins/isInterrupting; canInterrupt delegation; FM-006 timeout; Pi-signal propagation; normal regression).
  - FOLLOW pattern: tests/stream-proxy-detection.test.ts (inject controller+buffer; describe/test sentences w/
    PRD cites; assert state/buffer via the injected refs; assert no content in captured diagnostics fields).
  - COVERAGE: every new public method (canInterrupt/isInterrupting/triggerStop) + the run() catch branch +
    the timeout + signal propagation; positive + negative + timeout paths.
  - PLACEMENT: tests/stream-proxy-abort.test.ts (tests/ excluded from tsc; run by `bun test`).
  - DEPENDENCIES: imports StreamProxy + TransitionController + ReasoningBuffer + pi-ai types.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — internal controller, external fan-in (the core design). Separate from Pi's signal so the
// extension can abort reasoning WITHOUT aborting Pi's request; Pi's escape still reaches the upstream.
constructor(..., abortTimeoutMs: number = DEFAULT_CONFIG.transitionTimeoutMs) {
  ...
  this._abortTimeoutMs = abortTimeoutMs;
  const external = options?.signal;
  if (external) {
    if (external.aborted) this._internalAbort.abort();
    else external.addEventListener("abort", () => this._internalAbort.abort(), { once: true });
  }
  void this.run(model, context, options, upstreamStreamFn);
}

// PATTERN — dispatch in triggerStop(), observe in run()'s catch. The abort is ASYNC (the iterator throws on a
// later tick), so completeAbort()+freeze() belong in the catch, NOT in triggerStop().
triggerStop(): boolean {
  if (!this._controller.canInterrupt()) return false;      // (a) §22.5
  this._controller.requestStop();                           // (b) Reasoning→StopRequested
  this._controller.beginAbort();                            // (c) StopRequested→Aborting
  this._internalAbort.abort();                              // (d) upstream throws on next tick
  this._startAbortTimeout();                                // FM-006 safety net
  return true;                                              // (g)
}
// in run()'s catch:
if (this._controller.getState() === "Aborting") {           // (e) expected abort exit (§51)
  this._clearAbortTimeout();
  this._controller.completeAbort();                         // Aborting→Capturing
  this._buffer.freeze();                                    // (f) §41
  return;                                                   // output stays OPEN for P1.M7 splicing
}

// GOTCHA — return BEFORE terminal synthesis on a clean abort; synthesize ONLY on the unexpected path.
// GOTCHA — clear the abort timer in BOTH catch branches (and _startAbortTimeout clears any prior timer first).
// GOTCHA — do NOT freeze on the FM-006 timeout path; freeze is the clean-Capturing marker only.
```

### Integration Points

```yaml
# NOTE: ALL wiring below is OUT OF SCOPE for this subtask and lands in P1.M5 (wiring step) / P1.M5.T2 /
# P1.M6 / P1.M7. Documented so those subtasks can do it in one pass. This subtask changes ONLY
# src/provider/proxy.ts + tests/stream-proxy-abort.test.ts.

DECORATOR (src/provider/decorator.ts — P1.M5 wiring): NO CHANGE needed here — it already constructs
  `new StreamProxy(model, context, options ?? {}, originalStreamSimple, this.diagnostics)` and `options`
  carries Pi's `signal`. The proxy now handles it internally. (A later wiring step adds
  coordinator.setActiveProxy(proxy) on construct + setActiveProxy(undefined) on stream end.)

COORDINATOR (src/state/coordinator.ts — P1.M4.T4 DONE): NO CHANGE — it already defines ActiveProxy and
  delegates. After this subtask, StreamProxy satisfies ActiveProxy structurally.

FACTORY (src/index.ts — P1.M5 wiring): constructs coordinator + wires decorator + shortcut — not this subtask.

P1.M5.T2 (FM-005): layers completion-wins detection on top — likely a guard in triggerStop() ("stream already
  drained?") and/or a hook in run()'s natural-exit path. This subtask leaves both points untouched/compatible.

P1.M6 (RequestBuilder): reads buffer.snapshot() AFTER getState()==="Capturing" — produced by this subtask.

P1.M7 (Splicing): owns the downstream terminal on output after Capturing — this subtask leaves output OPEN.

CONFIG: none new (transitionTimeoutMs already exists; read via DEFAULT_CONFIG).
DATABASE/ROUTES: none.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after editing src/provider/proxy.ts — must be clean before writing the test.
npx bun run typecheck     # tsc --noEmit over src/** — proxy.ts MUST compile standalone (0 diagnostics)
npx bun run build         # tsc → exit 0

# (No ruff/mypy — TS project. Match the existing 2-space style + Mode-A JSDoc.)
# Expected: Zero errors. If typecheck reports an unknown AbortController/setTimeout, you have WRONGLY imported
# them — they are globals (remove the import). If it reports a type mismatch on triggerStop/canInterrupt/
# isInterrupting, re-check the signatures match ActiveProxy exactly (all `: boolean`).
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the abort suite in isolation.
npx bun test tests/stream-proxy-abort.test.ts -v

# Full suite for regressions (proxy + state + buffer + shortcut + coordinator + golden + factory + decorator).
npx bun test

# Expected: All tests pass. Common failures to READ for:
#  - "Expected Capturing, received Aborting" → the abort throw never reached run()'s catch: check the mock's
#    signal listener rejects the pending Promise (research/notes.md §3.1) and that you `waitFor` after triggerStop.
#  - "Expected Failed, received Aborting" (FM-006) → the timeout didn't fire: check you injected a small
#    abortTimeoutMs AND the mock ignores the signal (research/notes.md §3.2) and you `waitFor` long enough.
#  - A pre-existing suite regresses → the run() catch change broke normal forwarding: ensure the expected-abort
#    branch only triggers when getState()==="Aborting" and returns without pushing a terminal.
```

### Level 3: Integration Testing (System Validation)

```bash
# There is no live runtime integration yet (factory/decorator/coordinator wiring is P1.M5). The integration
# contract is STRUCTURAL: StreamProxy must satisfy ActiveProxy. Verify directly:

# (a) StreamProxy ≡ ActiveProxy (the coordinator seam):
npx bun -e 'import("./src/provider/proxy.ts").then(({StreamProxy}) => {
  import("./src/state/coordinator.ts").then(({ActiveProxy}) => {
    const _a: ActiveProxy = new StreamProxy({id:"x",api:"openai-completions",provider:"zai"} as any, {} as never, {} as never, (()=>({[Symbol.asyncIterator](){return{next(){return Promise.resolve({value:undefined,done:true})}}}})) as any, {trace(){},debug(){},info(){},warn(){},error(){}});
    console.log("assignable: OK", typeof _a.triggerStop);
  });
});' 2>/dev/null || echo "(runtime check skipped — typecheck covers assignability: see Level 1)"

# (b) Confirm no regressions in the existing proxy/provider paths (they are unchanged):
npx bun test tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts tests/provider-decorator.test.ts -v

# Expected: "assignable: OK function" (or typecheck-clean) and zero regressions. No live stream test is
# possible pre-P1.M5 wiring.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Privacy guard (Appendix H): the new diagnostics calls log ONLY state names / error categories / counts /
# timeoutMs — never content. Enforced by a test assertion scanning every captured fields object in the abort
# suite for allow-listed keys (state/from/to/timeoutMs/error/provider/model/{}). proxy.ts never holds user
# content in these calls.

# Concurrency note (PRD §37): _internalAbort is owned solely by this StreamProxy instance; triggerStop() is
# synchronous (no await) so its FSM moves are atomic; run()'s catch runs on a later tick but reads state via
# the single-writer controller. No lock is required (cooperative async). Documented in JSDoc; no check.

# FM-006 determinism: the timeout test injects abortTimeoutMs:20 (<< 5000 default) so it runs in milliseconds,
# not seconds. Use the injected ctor param — never the real default in tests.

# Expected: privacy assertion green; no concurrency primitive introduced; FM-006 test runs fast.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0.
- [ ] Level 2: `npx bun test` → **all green** (every pre-existing suite incl. P1.M4.T4 coordinator suite +
      the new `stream-proxy-abort` tests).
- [ ] No regressions: all pre-existing test files are unchanged and still pass.
- [ ] proxy.ts imports NO new modules (AbortController/setTimeout are globals); reuses `DEFAULT_CONFIG`.

### Feature Validation
- [ ] Constructor propagates `options.signal` → `_internalAbort`; `run()` passes the INTERNAL signal upstream.
- [ ] `triggerStop()`: `!canInterrupt()`→false (no abort); else requestStop→beginAbort→abort→timeout→true.
- [ ] `run()` catch: `Aborting`→clear timeout→completeAbort→freeze→return (no terminal); else synthesize terminal.
- [ ] `canInterrupt()`/`isInterrupting()` delegate; isInterrupting true for the 6 in-flight states.
- [ ] FM-006: unresponsive upstream + small timeout ⇒ `Failed` + `proxy.abort.timeout` warn.
- [ ] `StreamProxy` assignable to `ActiveProxy` (4 boolean methods present).

### Code Quality Validation
- [ ] Constructor-takes-Diagnostics convention preserved; 8th param `abortTimeoutMs` optional w/ default.
- [ ] Mode-A JSDoc with PRD cites (§16/§22.5/§24.3/§40/§41/§43/§51/INV-004/FM-006) — matches controller.ts style.
- [ ] Single-writer FSM honored (no new state owners; only calls to existing controller methods).
- [ ] Never-synthesize-terminal-on-clean-abort (output stays open for P1.M7 splicing).

### Documentation & Deployment
- [ ] JSDoc explains the internal-controller design + the triggerStop-dispatches/run-catches split.
- [ ] JSDoc documents the T1/T2 boundary (FM-005 completion-wins is P1.M5.T2; replacement/splicing P1.M6/P1.M7).
- [ ] No new env vars / config (transitionTimeoutMs already exists).

---

## Anti-Patterns to Avoid
- ❌ Don't pass `options.signal` straight to `upstreamStreamFn` — it would let only Pi abort, not the
  extension, and aborting it could abort Pi's whole request. Inject the INTERNAL signal; fan Pi's signal in.
- ❌ Don't do `completeAbort()`/`freeze()` synchronously inside `triggerStop()` — the upstream throw is async;
  those belong in `run()`'s catch (PRD §51: exit BEFORE freeze). Doing them in triggerStop would freeze before
  the final reasoning is captured and race the FSM.
- ❌ Don't synthesize a terminal on a clean abort — it closes `output` and breaks the P1.M7 splice (and would
  double-fire the single-terminal invariant). The expected-abort branch must `return` early.
- ❌ Don't implement FM-005 completion-wins (that's P1.M5.T2) — stay within the clean-abort + timeout scope.
- ❌ Don't freeze the buffer on the FM-006 timeout/`Failed` path — freeze is the clean-`Capturing` marker only.
- ❌ Don't import AbortController/AbortSignal/setTimeout (globals) or the concrete coordinator (no cycle needed).
- ❌ Don't add proxy-local dedup state (counter/latch) for first-press-wins — `canInterrupt()` going false after
  `triggerStop()` already enforces it (PRD §24.3/INV-004).
- ❌ Don't touch `coordinator.ts`, `controller.ts`, `buffer/`, `decorator.ts`, `config/`, `shortcut/`,
  `index.ts`, `types.ts`, or any existing test — this subtask is `proxy.ts` + the new abort test only.
- ❌ Don't log prompt/reasoning/assistant content (Appendix H) — only state names/error categories/counts/timeoutMs.
