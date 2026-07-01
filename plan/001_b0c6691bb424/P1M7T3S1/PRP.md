# PRP — P1.M7.T3.S1: End-to-end transition lifecycle and cleanup (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M7.T3.S1 (Phase 6 Stream Splicing, 2 pts) — the **integration capstone**. After
> P1.M7.T1.S1 launches the replacement + flips authority, and P1.M7.T2.S1 filters the spliced event
> stream (exactly one `start` + one terminal), THIS subtask drives the **completion FSM** through
> `Splicing → Answering → Completed → Idle`, releases **every allocated resource exactly once**
> (PRD §44 + INV-010/INV-011), clears the active-proxy reference (`coordinator.setActiveProxy(undefined)`),
> and routes **every** terminal exit (success / failure / timeout / normal completion / race-won) through
> ONE idempotent `_terminate(success, reason?)` so cleanup is structurally guaranteed to run exactly once.
> **OUTPUT**: a complete working Stop Thinking transition (key press → final answer) with no leaked
> resources and no duplicate completion. Consumed by **P1.M8** (hardening, telemetry, stress tests, docs).
> **MOCKING**: integration test with a mock provider that emits reasoning then replacement text
> (PRD §7 Story 1) + a failure path + the normal non-interrupted path + the once-only cleanup guarantee.
> **Vocabulary**: reuses the existing `_authority: ProxyPhase` (P1.M7.T1.S1), T2's `_emit`/
> `_messageEndEmitted`, and the controller's named transitions (`beginAnswering`/`complete`/`fail`/`reset`).

---

## Goal

**Feature Goal**: Complete the `StreamProxy`'s end-to-end transition lifecycle so that once the
replacement stream's terminal event is forwarded (P1.M7.T2.S1), the per-request `TransitionController`
walks `Splicing → Answering → Completed → Idle` (PRD §16/§51 Completion), and **every** terminal exit
(success, failure, timeout, normal completion, race-won cancellation) funnels through one idempotent
`_terminate(success, reason?)` that releases **all** allocated resources exactly once (PRD §44 +
Appendix O INV-010/INV-011): the reasoning buffer is reset, the pending timers are cleared, the
replacement abort-controller reference is released, and the session `TransitionCoordinator`'s active-proxy
reference is cleared (`setActiveProxy(undefined)`). After this subtask the Stop Thinking feature is
functionally complete end-to-end at the proxy layer.

**Deliverable** (ONE source file MODIFIED + ONE test file CREATED):
- `src/provider/proxy.ts` — **MODIFY**: add `import type { TransitionCoordinator }` + `import
  { isTextEvent, isToolCallEvent }` (extend the existing types import); add a `private readonly
  _coordinator?: TransitionCoordinator` field + an 11th optional constructor param
  `coordinator?: TransitionCoordinator` (defaults undefined — every existing caller unchanged); add a
  `private _terminated = false` INV-010 guard; add the idempotent `_terminate(success, reason?)` method
  (FSM→Idle via the no-throw `transitionIfLegal` + resource release + `proxy.lifecycle.cleanup` trace);
  wire `_terminate` into ALL terminal exits (run primary natural-exit; run catch `_upstreamCompleted` /
  unexpected-throw; replacement-loop done/error; replacement post-loop EC-018 guard; replacement catch);
  add `beginAnswering()` on the first forwarded answer token in the replacement loop (after `_emit`).
- `tests/stream-proxy-lifecycle.test.ts` — **NEW** `bun:test` integration suite (two-phase mock +
  injected buffer + a REAL `TransitionCoordinator` sharing the capturing diag) asserting the full
  success lifecycle, the failure lifecycle, the normal non-interrupted path, and the once-only cleanup
  guarantee (FSM→Idle, buffer reset, `coordinator.clear-active` traced, `proxy.lifecycle.cleanup`
  traced exactly once, exactly one `start` + one terminal, `output.result()` resolves).

**Success Definition**: From a clean checkout (after P1.M7.T1.S1 + P1.M7.T2.S1 are merged),
`npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0; `npx bun test` → **ALL green**
(the new `stream-proxy-lifecycle` suite PLUS every pre-existing suite, including P1.M7.T1/T2, the P1.M5
abort/race suites, and the detection/golden/forwarding regressions). PRD §48 Acceptance Criteria that are
proxy-verifiable hold: exactly one logical assistant interaction (one `start` + one terminal),
`controller` reaches `Idle` after every transition (success and failure), no leaked timers/buffers/
abort-controllers (cleanup runs once — INV-010), and no duplicate completion event (INV-003, from T2).

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing directly (lifecycle/cleanup is internal proxy plumbing).
The end user experiences it indirectly: they press `ctrl+.`, the reasoning stream is aborted, a
thinking-disabled replacement is launched and spliced in (T1/T2), and THIS subtask guarantees that once
the replacement's final answer token is delivered, the whole per-request machinery is torn down cleanly
— the FSM returns to `Idle`, the reasoning buffer is cleared, and the coordinator is ready for the next
turn — with no leaked resources and no duplicate "turn complete" signal.

**Use Case**: Without the completion lifecycle, the FSM is left stuck in `Splicing` after the
replacement's terminal is forwarded (the existing `_launchReplacement` loop comment at line ~654 literally
says "T3 owns the Splicing→Answering→Completed lifecycle"), the reasoning buffer is never reset, the
abort/startup timers may linger, and the coordinator keeps a stale reference to a dead proxy. This
subtask closes all of those.

**Pain Points Addressed**: Scattering teardown across the success path, the failure path, the timeout
paths, and the normal-completion path makes "cleanup exactly once" (INV-010) extremely fragile (a double
reset, a missed clear, a leaked timer). Centralizing it in one idempotent `_terminate` removes that class
of bug and makes the resource-release guarantee testable.

---

## Why

- **It is the explicit PRD §51 "Completion" algorithm.** "Replacement Completes → Emit message_end →
  Cleanup → Idle." And PRD §44: "Every completion shall release: Reasoning buffer. Abort controller.
  Proxy queue. Transition token. … No allocations shall survive beyond stream completion."
- **INV-010 / INV-011 are formal invariants.** "Cleanup shall execute exactly once regardless of success,
  failure, timeout, or cancellation." / "Every allocated transition resource shall have exactly one owning
  component and exactly one destruction point." A single guarded `_terminate` is the structural enforcement.
- **PRD §17 invariants.** "Completed: Cleanup must succeed even if telemetry fails." "Failed: Internal
  state always reset before exit." `_terminate` wraps `buffer.reset()` in try/catch and always drives the
  FSM to `Idle` on the failure path.
- **The previous phases left explicit TODO seams for T3.** The `_launchReplacement` loop ends with
  "T3 owns the Splicing→Answering→Completed lifecycle"; T2's PRP explicitly deferred the EC-018
  "replacement ended without a terminal" guard to T3 ("T2's tests always push a replacement terminal … do
  NOT add a post-loop synthesized terminal here — it would steal T3's scope").
- **It is the producer gate for P1.M8.** Hardening (FM-001..FM-015), telemetry, stress tests, and docs all
  assume a complete, self-cleaning transition. This subtask hands them a lifecycle that always returns to
  `Idle` and never leaks.

---

## What

### Source: MODIFY `src/provider/proxy.ts`

#### A. Imports — extend the existing `../types` import + add a type-only coordinator import

The file already has `import { isTerminalEvent } from "../types";` (T2 extends it to
`import { isTerminalEvent, isThinkingEvent } from "../types";`). T3 ADDS `isTextEvent`, `isToolCallEvent`
(to the SAME import line) and adds a type-only coordinator import:

```typescript
import type { AssistantMessageEvent, TransitionState, ProxyPhase } from "../types";
import { isTerminalEvent, isThinkingEvent, isTextEvent, isToolCallEvent } from "../types"; // ◄◄ ADD isTextEvent, isToolCallEvent (isThinkingEvent added by T2)
import type { TransitionCoordinator } from "../state/coordinator"; // ◄◄ ADD — type-only (no runtime cycle; coordinator.ts imports only ../diagnostics)
```

> `isTextEvent`/`isToolCallEvent` already exist in `src/types.ts` (P1.M2.T1.S1). They narrow
> `text_*`/`toolcall_*` — used to detect the "first answer token" → `beginAnswering()`.
> `TransitionCoordinator` is used ONLY as the optional param/field type; the proxy never `new`s it and
> only calls `setActiveProxy(undefined)` on it. `import type` → erased at compile, zero runtime cycle.

#### B. New instance state — the coordinator handle + the INV-010 guard

Append near the existing `_upstreamCompleted` / `_messageStartEmitted` booleans:

```typescript
/**
 * Optional session-scoped {@link TransitionCoordinator} whose active-proxy reference this proxy clears on
 * cleanup (PRD §44 "Transition token"; item contract: "coordinator.setActiveProxy(undefined) must be called
 * on cleanup"). `undefined` in production until the decorator wiring (a later integration task) passes the
 * session coordinator in; T3's cleanup path calls `this._coordinator?.setActiveProxy(undefined)` so the
 * no-coordinator case is a safe no-op. The proxy does NOT call `setActiveProxy(this)` on construct — that
 * is the decorator's responsibility (coordinator.ts JSDoc).
 */
private readonly _coordinator?: TransitionCoordinator;

/**
 * INV-010 (Appendix O): terminal handling (FSM→Idle + resource release) runs EXACTLY ONCE regardless of
 * success, failure, timeout, or cancellation. Guarded by {@link _terminate}. A routing/lifecycle flag, NOT
 * FSM state (mirrors the existing `_upstreamCompleted`/`_messageStartEmitted` routing flags; PRD Appendix F
 * "no boolean lifecycle flags" applies to the TransitionState union, not internal routing counters).
 */
private _terminated = false;
```

#### C. NEW private method — `_terminate(success, reason?)` (the single idempotent teardown)

Append near `transitionIfLegal`. This is the ONE chokepoint for every terminal exit:

```typescript
/**
 * The SINGLE terminal handler (PRD §51 Completion + §44 Resource Management + Appendix O INV-010/INV-011).
 * Drives the FSM to `Idle` and releases every allocated per-request resource, EXACTLY ONCE (the
 * {@link _terminated} guard makes every duplicate call — a stray terminal after transfer, a catch-after-loop,
 * a double event — a structural no-op).
 *
 * FSM drive (PRD §16), via the no-throw {@link transitionIfLegal} (never throws / never logs `transition.illegal`):
 *   - success: `Splicing → Answering → Completed → Idle` (each step a no-op if already past it; on the
 *     NORMAL non-interrupted path the FSM sits in `Reasoning`, which has no §16 exit to Answering/Completed/
 *     Idle, so ALL THREE are no-ops → the FSM is correctly left in `Reasoning` with NO misleading
 *     `transition.failed`, yet resources are still released).
 *   - failure: `fail(reason)` (Any→Failed, skipped if already `Failed` from a timeout handler) then
 *     `Failed → Idle` (PRD §17 "internal state always reset before exit").
 *
 * Resource release (PRD §44): clear both timers, reset the reasoning buffer (wrapped in try/catch so a
 * buffer fault can never break cleanup — §17 "cleanup must succeed even if telemetry fails"), release the
 * replacement abort-controller reference, and clear the coordinator's active-proxy reference.
 *
 * PRIVACY (Appendix H): the `proxy.lifecycle.cleanup` trace logs `{}` only — never content/reasoning.
 *
 * @param success `true` for a forwarded `done` terminal or a natural/race-won completion; `false` for any
 *                error/throw/timeout (the synthesized `error` terminal is forwarded by the caller).
 * @param reason  an error CATEGORY (e.g. "replacement-error", "replacement-empty", "upstream-error",
 *                "replacement-failed") — never user/reasoning content (Appendix H). Ignored when the FSM is
 *                already `Failed` (a timeout handler classified it first).
 */
private _terminate(success: boolean, reason?: string): void {
  if (this._terminated) return; // INV-010 — exactly once
  this._terminated = true;

  if (success) {
    this.transitionIfLegal("Answering"); // Splicing→Answering (no-op if beginAnswering ran / no-op from Reasoning)
    this.transitionIfLegal("Completed"); // Answering→Completed
    this.transitionIfLegal("Idle");      // Completed→Idle
  } else {
    if (this._controller.getState() !== "Failed") {
      this._controller.fail(reason ?? "transition-failed"); // Any→Failed (never throws)
    }
    this.transitionIfLegal("Idle"); // Failed→Idle
  }

  // Resource release (PRD §44) — order-independent; each is total.
  this._clearAbortTimeout();   // release the FM-006 abort-timeout timer handle
  this._clearReplacementTimeout(); // release the replacement-startup-timeout timer handle
  try {
    this._buffer.reset();      // destroy captured reasoning (PRD §44 "Reasoning buffer")
  } catch (err) {
    // §17 "Completed: cleanup must succeed even if telemetry fails" — never let a buffer fault escape.
    this.diagnostics.warn("proxy.cleanup.buffer-reset-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  this._replacementAbort = undefined;          // release the replacement abort-controller reference (§44 "Abort controller")
  this._coordinator?.setActiveProxy(undefined); // release the transition token / coordinator handle (§44; item contract)
  this.diagnostics.trace("proxy.lifecycle.cleanup", {}); // privacy-safe — {} only
}
```

> The primary `_internalAbort` is `private readonly` (constructed inline) and ALREADY aborted by cleanup
> time (consumed by `triggerStop`); it is a tiny object released when the per-request proxy is GC'd. T3
> does NOT make it mutable (no benefit; it's aborted) — this is documented rather than nulled. The mutable
> `_replacementAbort` IS nulled. The setTimeout HANDLES (`_abortTimer`/`_replacementStartupTimer`) are the
> real leak sources and ARE cleared.

#### D. EDIT the constructor — add the 11th optional `coordinator` param + assign the field

The constructor's current signature ends with the 10th param `replacementStartupTimeoutMs`. APPEND an
11th optional param (every existing positional caller is unaffected — it defaults to `undefined`). In the
constructor body, assign `this._coordinator = coordinator;` near the other field assignments:

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
    requestBuilder?: RequestBuilder,
    replacementStartupTimeoutMs: number = DEFAULT_CONFIG.replacementStartupTimeoutMs,
    coordinator?: TransitionCoordinator, // ◄◄ NEW (P1.M7.T3.S1) — appended; production omits → undefined (safe no-op on cleanup)
  ) {
    // …existing assignments…
    this._replacementStartupTimeoutMs = replacementStartupTimeoutMs;
    this._coordinator = coordinator; // ◄◄ NEW
    // …rest unchanged…
  }
```

> Do NOT add a public getter for `_coordinator` (the field stays private; only `_terminate` reads it).

#### E. EDIT `run()` — wire `_terminate` into the primary natural-exit + the catch paths

**E1. Primary loop natural exit.** After the existing `for await` loop and the existing
`if (this._upstreamCompleted && this._controller.getState() === "Aborting") { … _cancelInFlightAbort() … }`
race-won block, ADD a final `_terminate(true)` so a normal (non-interrupted) completion still releases
resources + clears the coordinator:

```typescript
      if (this._upstreamCompleted && this._controller.getState() === "Aborting") {
        this._clearAbortTimeout();
        this._cancelInFlightAbort(); // existing — fail("natural-completion-won")+reset → Idle
        this.diagnostics.trace("proxy.abort.natural-completion-won", {});
      }
      this._terminate(true); // ◄◄ NEW — release resources on every natural completion (normal OR race-won)
```

> On the race-won sub-case `_cancelInFlightAbort` already moved the FSM to `Idle`; `_terminate(true)` then
> no-ops the FSM (Idle has no path to Answering/Completed) and just releases resources. On the normal
> sub-case (state `Reasoning`) `_terminate(true)` no-ops the FSM (no §16 Reasoning exit) and releases
> resources. Both correct.

**E2. Catch `_upstreamCompleted` (race won — terminal already forwarded).** The existing block returns
early. ADD `_terminate(true)` before the `return`:

```typescript
      if (this._upstreamCompleted) {
        this._clearAbortTimeout();
        if (this._controller.getState() === "Aborting") {
          this._cancelInFlightAbort();
        }
        this.diagnostics.trace("proxy.abort.natural-completion-won", {});
        this._terminate(true); // ◄◄ NEW — release resources
        return;
      }
```

**E3. Catch clean-abort branch.** UNCHANGED — it delegates to `_launchReplacement` which owns termination.
Do NOT add `_terminate` here (the replacement owns it).

**E4. Catch unexpected-throw (the `else` synthesizing an `error` terminal).** After the existing
`this._output.push({ type: "error", … })` (which T2 swaps to `this._emit({ type: "error", … })`), ADD
`_terminate(false, "upstream-error")`:

```typescript
      this._emit({ // ◄◄ T2 swapped push→_emit here; keep it
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, message),
      });
      this._terminate(false, "upstream-error"); // ◄◄ NEW — fail→Idle + release resources (§17 reset before exit)
```

#### F. EDIT `_launchReplacement` — completion FSM in the replacement loop + post-loop EC-018 guard + catch

**F1. Replacement loop — `beginAnswering` on first answer token + completion on the forwarded terminal.**
The loop currently ends each iteration with `this._emit(event);` (T2). After that line, ADD the lifecycle
logic (do NOT reorder the `if (!firstSeen)` flip block — T2's contract):

```typescript
        this._emit(event); // ◄◄ T2 — unchanged filter-forward

        // P1.M7.T3.S1 — completion FSM (PRD §16/§51), AFTER the forward (T2's flip-before-_emit ordering preserved).
        // (1) First answer token → Splicing→Answering (streaming FSM accuracy; a no-op once past Splicing).
        if (
          this._controller.getState() === "Splicing" &&
          (isTextEvent(event) || isToolCallEvent(event))
        ) {
          this._controller.beginAnswering(); // Splicing → Answering (PRD §16; legal here)
        }
        // (2) The forwarded terminal completes the transition. _emit forwards the FIRST terminal and dedups
        //     the rest; _terminate is idempotent, so a duplicate/stray terminal is a safe no-op (INV-010).
        if (isTerminalEvent(event)) {
          if (event.type === "done") {
            this._terminate(true); // Splicing/Answering → Completed → Idle + cleanup
          } else {
            // error terminal from the replacement → fail→Idle + cleanup (the terminal was already forwarded).
            this._terminate(false, "replacement-error");
          }
        }
```

> Why AFTER `_emit` (not before)? `_emit` decides whether the event is actually forwarded vs suppressed
> (duplicate terminal discarded, thinking skipped). Driving the FSM only on a terminal that `_emit` accepted
> is correct; and because `_terminate` is idempotent, even a discarded duplicate is harmless. The
> `beginAnswering` guard keys on event TYPE (not on whether forwarded) which is fine — a suppressed
> `thinking_*` is not an answer token, so it never trips the guard.

**F2. Post-loop EC-018 guard.** The current comment after the loop says "Replacement stream ended naturally
… T3 owns the … lifecycle." REPLACE that comment with the guard: if the loop ended WITHOUT forwarding a
terminal (`!this._messageEndEmitted` — T2's flag), synthesize ONE `error` terminal via `_emit` so
`output.result()` never hangs, then `_terminate(false, "replacement-empty")`:

```typescript
      }
      // P1.M7.T3.S1 — EC-018 (empty/clean-return-without-terminal): the replacement ended without emitting a
      // terminal. output would hang; synthesize ONE error terminal so output.result() resolves (single-terminal
      // invariant), then tear down. If a terminal WAS forwarded, _terminate already ran inside the loop and the
      // _terminated guard makes this a no-op.
      if (!this._messageEndEmitted) {
        this._emit({
          type: "error",
          reason: "error",
          error: this.makeErrorAssistantMessage(model, "replacement stream ended without a terminal"),
        });
        this._terminate(false, "replacement-empty");
      }
```

> `_messageEndEmitted` (T2) is `false` entering `_launchReplacement` (the primary left output OPEN on the
> abort path), `true` once `_emit` forwarded a terminal. So this guard fires ONLY on the genuinely-empty
> case. If the loop forwarded a terminal and then ended, `_messageEndEmitted` is `true` → skip. Safe.

**F3. Replacement catch.** The existing catch synthesizes an `error` terminal via `_emit` (T2 swap) and
classifies/logs. ADD `_terminate(false, reason)` AFTER the synthesized terminal. The reason: if the
startup-timeout handler already moved us to `Failed` (state is `Failed` by the time the blocked iterator
throws), `_terminate` skips `fail()`; otherwise classify `"replacement-failed"`. Keep the existing
classify-warn guard (`getState() !== "Failed"`) unchanged:

```typescript
    } catch (err) {
      this._clearReplacementTimeout();
      const message = err instanceof Error ? err.message : String(err);
      if (this._controller.getState() !== "Failed") {
        this.diagnostics.warn("proxy.replacement.failed", { error: message }); // unchanged classify guard
      }
      this._emit({ // ◄◄ T2 swapped push→_emit here; keep it
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, message),
      });
      this._terminate(false, "replacement-failed"); // ◄◄ NEW — fail→Idle (skipped if startup-timeout already Failed) + cleanup
    }
```

#### G. NO change to `_emit`, `trackEvent`, `triggerStop`, the abort/replacement timeout handlers' `fail()` calls, or `_cancelInFlightAbort`

- `_emit` is T2's contract — T3 only CALLS it (the synthesized terminals in E4/F2/F3 already go through
  `_emit` per T2). Do not redefine it.
- The timeout handlers (`_startAbortTimeout`, `_startReplacementTimeout`) already call `controller.fail(...)`
  — leave them. They move the FSM to `Failed`; the downstream throw → the relevant catch → `_terminate(false,
  …)` sees `Failed` and skips the redundant `fail()`, then resets to `Idle` + releases resources. (FM-006
  abort-timeout: upstream eventually throws → run() catch `else` → E4. Replacement startup-timeout:
  replacement throws → F3.)
- `_cancelInFlightAbort` is unchanged (still `fail("natural-completion-won")` + `reset()`).

### Test: CREATE `tests/stream-proxy-lifecycle.test.ts`

A `bun:test` integration suite. Reuse `makeCaptureDiag()` / `makeModel()` / `ev()` / `waitFor()` and the
two-phase `makeReplacementUpstream()` mock VERBATIM from `tests/stream-proxy-replacement.test.ts`
(P1.M7.T1.S1) — primary on call 1 (yields thinking, throws on its signal abort) / replacement on call 2
(separate queue + fresh signal). Construct the proxy with an INJECTED `ReasoningBuffer` (to assert reset)
and a REAL `TransitionCoordinator` sharing the capturing diag as the 11th positional arg, then call
`coordinator.setActiveProxy(proxy)` upfront (simulating what the decorator will do). Drain `proxy.output`
concurrently in every test that asserts observed events. Use a small `replacementStartupTimeoutMs` (e.g.
`2000`) so an un-driven replacement still bounds orphaned work.

Coverage (each its own `test`):

1. **Full success lifecycle (the headline MOCKING contract — PRD §7 Story 1 + §48):** push primary `start`
   + `thinking_start` + `thinking_delta`; wait for `isReasoning()`; `proxy.triggerStop()`; wait for
   `mock.calls.length === 1` (replacement invoked with `reasoning === undefined`); push replacement
   `start` + `text_start` + `text_delta` + `text_end` + `done(reason:"stop", message: DONE_MESSAGE)`; drain
   the consumer. ASSERT: observed types contain exactly ONE `start` and ONE terminal; `output.result()`
   resolves to `DONE_MESSAGE`; `controller.getState() === "Idle"` (went Splicing→Answering→Completed→Idle);
   `events` contains `proxy.replacement.first-event` + `proxy.lifecycle.cleanup`; the coordinator was
   cleared (`events.some(c => c.event === "coordinator.clear-active")`); the injected buffer is empty after
   completion (`buffer.snapshot().length === 0`).
2. **`beginAnswering` fires on the first answer token:** same setup but assert the FSM passes through
   `Answering` — drive the replacement to `text_start`, then (before the `done`) assert
   `controller.getState() === "Answering"` via `waitFor`; then push `done` → assert `Idle`.
3. **Failure lifecycle (replacement error event):** push replacement `text_delta` then an `error` terminal;
   assert `controller.getState() === "Idle"` (fail→Idle), `events` contains `transition.failed` (reason
   `"replacement-error"`) + `proxy.lifecycle.cleanup` + `coordinator.clear-active`, exactly ONE terminal
   (`error`) reached the consumer, and `output.result()` resolves to the error message.
4. **EC-018 empty replacement (clean return without a terminal):** push NO replacement terminal; let the
   replacement queue drain to nothing (the mock's iterator yields the queued events then blocks). Drive a
   replacement `text_delta` but NO terminal, then after a short wait abort the replacement signal from the
   test to end the iterator — OR simpler: push only non-terminal events then call the mock's release.
   ASSERT: exactly ONE synthesized `error` terminal reached the consumer (the EC-018 guard), `output.result()`
   resolves, FSM is `Idle`, `proxy.lifecycle.cleanup` traced. (Pick the mechanism that matches
   `makeReplacementUpstream`'s abortable iterator — the cleanest is to push only non-terminal events then
   abort the replacement signal so the iterator throws → F3 path; if you instead want the clean-return path,
   extend the mock with a "then ends" mode. Either is acceptable as long as the synthesized terminal is
   asserted.)
5. **Normal non-interrupted path still cleans up:** do NOT `triggerStop`; push primary `start` +
   `thinking_start` + `thinking_delta` + `done`; drain. ASSERT: FSM is left in `Reasoning` (no §16 normal
   exit — `getState() === "Reasoning"`), BUT resources are released: `proxy.lifecycle.cleanup` traced,
   `coordinator.clear-active` traced, buffer reset (`buffer.snapshot().length === 0`), exactly one `start`
   + one `done`. (Proves `_terminate(true)` releases resources without a misleading `transition.failed`.)
6. **Cleanup runs EXACTLY ONCE (INV-010):** run the full success cycle (case 1) but push a SECOND `done`
   after the first (a duplicate terminal). ASSERT `events.filter(c => c.event === "proxy.lifecycle.cleanup").length === 1`
   AND `events.filter(c => c.event === "coordinator.clear-active").length === 1` (the duplicate terminal did
   not re-trigger teardown) AND still exactly ONE terminal reached the consumer.
7. **Abort-timeout → failure → cleanup (FM-006):** use `makeUnresponsiveUpstream()` (from the abort test) +
   a tiny `abortTimeoutMs` (e.g. `20`); drive to Reasoning; `triggerStop()`; wait for `Failed`. ASSERT the
   eventual `proxy.lifecycle.cleanup` trace + `coordinator.clear-active` + FSM `Idle` (after the throw path
   runs `_terminate(false, "upstream-error")`). Release the unresponsive upstream so `run()` exits.
8. **Privacy guard:** run case 1 with `options` carrying `apiKey`/`prompt`/`reasoning`; filter
   `proxy.lifecycle.*` + `proxy.cleanup.*` captured events; assert each `fields` is `{}` only (never
   content/options/reasoning/prompt) — Appendix H.

> The two-phase mock MUST use SEPARATE queues + signals for primary vs replacement (the replacement gets a
> FRESH signal from the proxy — P1.M7.T1.S1). To terminate the replacement cleanly in the success cases,
> push a `done` (forwarded → output completes → consumer's `for await` exits). Pass the coordinator as the
> 11th positional ctor arg; pass the buffer as the 7th (injected) so `buffer.snapshot()` is assertable.

### Scope Boundary — DO NOT implement (owned by P1.M8 + later wiring)

- **The Pi-extension wiring** (factory creating a session `TransitionCoordinator` + `ShortcutManager`,
  registering the shortcut, passing the coordinator into each proxy via the decorator, calling
  `setActiveProxy(proxy)` on construct) → out of scope. T3 adds the cleanup HOOK (the optional param +
  `setActiveProxy(undefined)` call); the construct-side wiring is a later integration task (the coordinator
  is tested here by passing it directly).
- **Telemetry metrics** (TransitionStarted/Completed/Failed counters) → P1.M8.T1.
- **Full FM-001..FM-015 failure-mode hardening** → P1.M8.T2. T3 handles the structural teardown on the
  failure/timeout paths (so resources never leak), but does NOT add per-mode recovery policies.
- **Any change to `types.ts`, `controller.ts`, `coordinator.ts`, `buffer/`, `config/`, `diagnostics/`,
  `shortcut/`, `request/builder.ts`, `decorator.ts`, `index.ts`** → none.
- **Redefining T2's `_emit`** → none. T3 calls `_emit`; it does not modify it.

### Success Criteria

- [ ] `_terminate(success, reason?)` exists, is guarded by `_terminated` (INV-010), drives the FSM to `Idle`
      via `transitionIfLegal` (success: Answering→Completed→Idle; failure: fail→Idle), and releases all
      resources (clear both timers, `buffer.reset()` in try/catch, `_replacementAbort = undefined`,
      `_coordinator?.setActiveProxy(undefined)`, `proxy.lifecycle.cleanup` trace).
- [ ] `run()` calls `_terminate(true)` on the primary natural-exit (after the race-won block), `_terminate(true)`
      in the catch `_upstreamCompleted` branch, and `_terminate(false, "upstream-error")` in the catch
      unexpected-throw branch (after the synthesized `_emit` error terminal).
- [ ] `_launchReplacement`'s replacement loop calls `beginAnswering()` on the first `text_*`/`toolcall_*`
      while `Splicing`, and `_terminate(true)`/`_terminate(false,"replacement-error")` on the forwarded
      terminal — all AFTER `_emit` (T2's flip-before-`_emit` ordering preserved).
- [ ] `_launchReplacement` has the post-loop EC-018 guard (`if (!this._messageEndEmitted)` → synthesize
      `error` via `_emit` + `_terminate(false,"replacement-empty")`).
- [ ] `_launchReplacement`'s catch calls `_terminate(false, "replacement-failed")` after the synthesized
      `_emit` error terminal.
- [ ] The constructor's 11th optional `coordinator?: TransitionCoordinator` param + `_coordinator` field are
      added; every existing caller (decorator 5-arg + all positional test ctors) is unchanged.
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green
      (new `stream-proxy-lifecycle` + every pre-existing suite unchanged).

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have
everything needed to implement this successfully?"_ → YES. The exact imports, the `_coordinator` field +
11th ctor param, the full `_terminate` body (with the FSM-drive logic + the resource-release list + the
§17 try/catch), the precise call-site edits in `run()` (E1–E4) and `_launchReplacement` (F1–F3) each with
the "keep T2's ordering" constraint, the EC-018 post-loop guard, the why-`transitionIfLegal` (no-throw)
rationale, the why-`_terminate(true)`-is-safe-on-the-normal-path rationale, the coordinator-clearing test
leverage (`coordinator.clear-active` trace), and the 8 coverage cases are all reproduced above and in
`research/notes.md` §1–§10.

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask
- url: PRD.md "# 51. Complete Transition Algorithm" (## Completion)
  why: "Replacement Completes → Emit message_end → Cleanup → Idle. This subtask IS the Completion phase."
  critical: "Cleanup is mandatory and terminal. The FSM MUST reach Idle. (Authority transfer is irreversible —
             already done by P1.M7.T1.S1.)"

- url: PRD.md "# 44. Resource Management"
  why: "Every completion shall release: Reasoning buffer. Abort controller. Proxy queue. Transition token.
        Temporary request state. No allocations shall survive beyond stream completion."
  critical: "This is the checklist _terminate implements: buffer.reset() + clear timers + release _replacementAbort
             + coordinator.setActiveProxy(undefined). output (proxy queue) completes via push(terminal)."

- url: PRD.md "# 17. State Invariants" (## Completed / ## Failed)
  why: "Completed: 'Cleanup must succeed even if telemetry fails.' Failed: 'Internal state always reset before exit.'"
  critical: "_terminate wraps buffer.reset() in try/catch (Completed invariant) and ALWAYS drives the FSM to Idle
             on the failure path (Failed invariant)."

- url: PRD.md "# 48. Acceptance Criteria"
  why: "The 15-item production-ready checklist: one logical interaction, no duplicate turn, proper cleanup after
        success AND failure, no leaked abort controllers, no leaked buffers, no duplicate completion, all state
        machine transitions validated."
  critical: "_terminate is the structural enforcement of 'proper cleanup after success/failure' + 'no leaked
             resources' + 'cleanup exactly once'. The §48 'all state machine transitions validated' is served by
             using the table-driven transitionIfLegal (never an illegal transition)."

- url: PRD.md "Appendix O — Formal Invariants" (INV-010, INV-011)
  why: "INV-010 'Cleanup shall execute exactly once regardless of success, failure, timeout, or cancellation.'
        INV-011 'Every allocated transition resource shall have exactly one owning component and exactly one
        destruction point.'"
  critical: "The single _terminated guard + the single _terminate chokepoint ARE INV-010/INV-011 made structural."

- url: PRD.md "# 16. State Transition Table" + src/state/controller.ts ALLOWED_TRANSITIONS
  why: "Confirms the legal transitions T3 uses: Splicing→Answering (beginAnswering), Answering→Completed (complete),
        Completed→Idle + Failed→Idle (reset), Any→Failed (fail)."
  critical: "reset() THROWS unless state ∈ {Completed, Failed}; transitionIfLegal (the proxy's private no-throw
             helper) is the ONLY safe way to call these from every terminal exit. fail() never throws."

- url: PRD.md "Appendix B — Edge Case Matrix" (## EC-018 Provider Returns Empty Response)
  why: "EC-018: a replacement that ends without a terminal would leave output hanging."
  critical: "T3's post-loop `if (!this._messageEndEmitted)` guard synthesizes ONE error terminal so output.result()
             resolves — the fix T2 explicitly deferred to T3."

# Codebase patterns to FOLLOW / MODIFY
- file: src/provider/proxy.ts
  why: "THE file this subtask modifies. (1) _launchReplacement's replacement loop — append beginAnswering + the
        terminal _terminate drive AFTER _emit (F1). (2) the post-loop EC-018 guard (F2). (3) the catch _terminate
        (F3). (4) run()'s natural-exit + catch _terminate wiring (E1/E2/E4). (5) the 11th ctor param + _coordinator
        field (D). (6) the _terminate method (C). transitionIfLegal / _clearAbortTimeout / _clearReplacementTimeout /
        _buffer / _replacementAbort / makeErrorAssistantMessage are all reused unchanged."
  pattern: "transitionIfLegal is the existing no-throw FSM helper (mirrors trackEvent's safe-transition style);
            _terminate layers teardown onto it the way trackEvent layers detection onto push."
  gotcha: "Do NOT reorder the replacement loop — T2's _authority flip + proxy.replacement.first-event trace MUST
           stay in the if(!firstSeen) block BEFORE _emit. T3 adds lifecycle AFTER _emit. Do NOT redefine _emit."

- file: src/state/controller.ts  (P1.M3 — consumed unchanged)
  why: "beginAnswering() (Splicing→Answering), complete() (Answering→Completed), fail(reason) (Any→Failed, never
        throws), reset() (Completed|Failed→Idle, throws otherwise). ALLOWED_TRANSITIONS is the legality table."
  pattern: "named convenience methods that ONLY validate+change state+log; never any side effect."
  gotcha: "reset() throws from any state except Completed/Failed — so call it ONLY via transitionIfLegal (no-throw).
           fail() is the one method that always succeeds."

- file: src/state/coordinator.ts  (P1.M4.T4 — consumed unchanged; the cleanup TARGET)
  why: "setActiveProxy(undefined) emits trace('coordinator.clear-active', {}) — the test assertion that proves the
        cleanup hook fired. The proxy's 11th ctor param is typed TransitionCoordinator (import type — no cycle)."
  pattern: "setActiveProxy(proxy|undefined) is the single active-proxy mutator."
  gotcha: "The proxy only CALLS setActiveProxy(undefined) on cleanup. setActiveProxy(this) on construct is the
           decorator's job (out of T3 scope). import type keeps it compile-time-only."

- file: src/buffer/index.ts  (P1.M4.T1 — consumed unchanged; reset() is the cleanup call)
  why: "reset() clears entries+frozen+totalBytes and traces 'buffer.reset' — total, never throws in practice;
        _terminate wraps it in try/catch anyway (§17)."
  pattern: "reset() is the 'destroy reasoning buffer' PRD §44 operation."
  gotcha: "The injected buffer (test) is reused to assert snapshot().length === 0 after cleanup."

- file: src/types.ts  (P1.M2.T1 — isTextEvent/isToolCallEvent imported)
  why: "isTextEvent (text_*) / isToolCallEvent (toolcall_*) — used to detect the first answer token for beginAnswering."
  pattern: "centralized ReadonlySet membership guards (Appendix F)."
  gotcha: "They already exist — just IMPORT them (extend the existing ../types import line). Do NOT add new unions."

- file: tests/stream-proxy-replacement.test.ts  (P1.M7.T1.S1 — the mock + helper source)
  why: "makeCaptureDiag()/makeModel()/ev()/waitFor() + the two-phase makeReplacementUpstream() mock are copied
        VERBATIM. The positional ctor args (incl. the injected buffer at #7 and a small replacementStartupTimeoutMs
        at #10) are the template; T3 adds the 11th arg (a real TransitionCoordinator)."
  pattern: "capturing diag → construct unit → drive events → waitFor(predicate) → assert via captured events."
  gotcha: "Pass a REAL TransitionCoordinator (sharing the capturing diag) as the 11th arg, then call
           coordinator.setActiveProxy(proxy) to simulate the decorator; assert 'coordinator.clear-active' after."

- file: tests/stream-proxy-abort.test.ts  (P1.M5 — makeUnresponsiveUpstream for the FM-006 case)
  why: "makeUnresponsiveUpstream() (ignores the signal, blocks until release) is the template for case #7
        (abort-timeout → failure → cleanup)."
  pattern: "push events BEFORE constructing the proxy (the generator exhausts the queue then blocks on the gate)."
  gotcha: "Release the unresponsive upstream at the end so run() exits (no dangling handle)."

- docfile: plan/001_b0c6691bb424/P1M7T2S1/PRP.md  (the in-flight producer; CONTRACT)
  why: "Defines _emit + _messageStartEmitted/_messageEndEmitted (which T3 reuses for the EC-018 guard) and pins the
        flip-before-_emit ordering T3 must preserve. T2's 'do NOT add a post-loop synthesized terminal' defers EC-018
        to T3."
  section: "What / C–F (_emit + the 3 wiring swaps) and 'Scope Boundary' (EC-018 deferred to T3)."

- docfile: plan/001_b0c6691bb424/P1M7T1S1/PRP.md  (the replacement-launch producer)
  why: "Defines _launchReplacement's loop + _authority + _replacementAbort + the startup timeout that T3 EDITS."
  section: "the _launchReplacement loop + _authority field."

- docfile: plan/001_b0c6691bb424/P1M7T3S1/research/notes.md  (THIS item's evidence base)
  why: "The call-site map (§5), the _terminate body + the why-_terminate(true)-is-safe-on-the-normal-path
        rationale (§4), the coordinator-handle decision (§6), the §44 'null abort controllers' honesty note (§7),
        and the test leverage (§8)."
  section: "§1–§10."
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO change
├── types.ts                 # isTextEvent/isToolCallEvent/isThinkingEvent/isTerminalEvent (P1.M2.T1) — IMPORT from here
├── config/index.ts          # DEFAULT_CONFIG (P1.M1.T2) — NO change
├── diagnostics/index.ts     # Diagnostics interface (P1.M1.T3) — INJECTED (already)
├── buffer/index.ts          # ReasoningBuffer.reset() (P1.M4.T1) — CALLED by _terminate; NO change
├── request/builder.ts       # RequestBuilder (P1.M6.T1.S1) — NO change
├── provider/
│   ├── decorator.ts         # ProviderDecorator (P1.M1/M2) — NO change (coordinator wiring is a LATER task)
│   └── proxy.ts             # StreamProxy — MODIFY (+_terminate, +_coordinator field+ctor param, +_terminated,
│                            #   +beginAnswering/_terminate wiring in run()+_launchReplacement, +EC-018 guard,
│                            #   +isTextEvent/isToolCallEvent/TransitionCoordinator imports)
├── shortcut/index.ts        # ShortcutManager (P1.M4.T3) — NO change
└── state/
    ├── controller.ts        # TransitionController (P1.M3) — NO change (consumed: beginAnswering/complete/fail/reset)
    └── coordinator.ts       # TransitionCoordinator (P1.M4.T4) — NO change (consumed: setActiveProxy(undefined))
tests/
├── stream-proxy-abort.test.ts        # makeUnresponsiveUpstream source (case #7); NO change
├── stream-proxy-race.test.ts         # NO change (race paths preserved)
├── stream-proxy-replacement.test.ts  # two-phase mock + helper source; NO change (verify it still passes)
├── stream-proxy-filtering.test.ts    # P1.M7.T2.S1 (in flight); NO change (verify it still passes)
├── stream-proxy-lifecycle.test.ts    # CREATE (new integration suite, 8 cases)
├── stream-proxy.test.ts              # NO change (normal forwarding preserved)
├── stream-proxy-detection.test.ts    # NO change (trackEvent unchanged)
└── … (golden/factory/provider-decorator/transition-*/reasoning-buffer/shortcut/… all unchanged)
```

### Desired Codebase tree with files to be added/changed

```bash
src/provider/proxy.ts                   # MODIFY: +TransitionCoordinator(type)/isTextEvent/isToolCallEvent imports,
                                        #         +_coordinator field + 11th ctor param, +_terminated guard, +_terminate,
                                        #         run() natural-exit/catch _terminate wiring (E1/E2/E4),
                                        #         _launchReplacement beginAnswering+terminal drive (F1), EC-018 guard (F2),
                                        #         replacement catch _terminate (F3)
tests/stream-proxy-lifecycle.test.ts    # CREATE: two-phase-mock integration suite (8 cases)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: T2's replacement-loop ordering MUST be preserved — the _authority = "splicing" flip +
//   proxy.replacement.first-event trace run INSIDE the if(!firstSeen) block BEFORE this._emit(event). T3 ADDS
//   beginAnswering + the _terminate terminal drive AFTER this._emit(event). Do NOT reorder.

// CRITICAL: reset() (controller.ts) THROWS unless state ∈ {Completed, Failed}. NEVER call it directly from a
//   terminal exit — use transitionIfLegal(target) (the proxy's private no-throw helper that checks
//   ALLOWED_TRANSITIONS first). _terminate uses transitionIfLegal exclusively → never throws.

// CRITICAL: fail(reason) (controller.ts) is Any→Failed and NEVER throws, but it logs error("transition.failed").
//   On the timeout paths the FM-006/_startReplacementTimeout handlers ALREADY call fail() — so by the time the
//   downstream throw reaches _terminate(false,…), state is already Failed and _terminate MUST skip the redundant
//   fail() (gate on getState() !== "Failed"). Otherwise you double-log transition.failed.

// CRITICAL: _terminate(true) is SAFE on the normal non-interrupted path. The FSM sits in Reasoning (§16 has no
//   Reasoning→Completed exit). transitionIfLegal("Answering"/"Completed"/"Idle") are ALL no-ops from Reasoning →
//   FSM stays Reasoning with NO misleading transition.failed, yet resources are still released + coordinator
//   cleared. This is the ELEGANT property that lets ONE method serve every terminal exit.

// CRITICAL: the primary _internalAbort is `private readonly` (constructed inline) and ALREADY aborted by cleanup
//   time. It CANNOT be nulled without changing field mutability, and there's no benefit (it's aborted + GC'd with
//   the per-request proxy). T3 documents this rather than nulling it. The mutable _replacementAbort IS nulled.
//   The setTimeout HANDLES (_abortTimer/_replacementStartupTimer) are the real leak sources and ARE cleared.

// GOTCHA: _messageEndEmitted (T2) is the EC-018 guard signal. It is false entering _launchReplacement (the primary
//   left output OPEN on the abort path) and true once _emit forwarded a terminal. So the post-loop guard fires
//   ONLY on the genuinely-empty case. Do NOT re-derive emptiness another way.

// GOTCHA: the replacement-loop terminal drive must key on event.type === "done" vs "error" AFTER _emit forwarded
//   it. _emit forwards the FIRST terminal and dedups the rest; _terminate is idempotent, so a discarded duplicate
//   terminal reaching the drive is a safe no-op. Do NOT try to ask _emit whether it forwarded (no return value).

// GOTCHA: the coordinator param is `import type` only (the proxy never `new`s TransitionCoordinator, only calls
//   setActiveProxy(undefined)). coordinator.ts imports only ../diagnostics (type) → no runtime cycle.

// PRIVACY (Appendix H): proxy.lifecycle.cleanup + proxy.cleanup.buffer-reset-failed log {} / {error} only — never
//   content/options/reasoning/prompt. The reason passed to fail() is an error CATEGORY string, not content.
```

---

## Implementation Blueprint

### Data models and structure

No new persistent models. Three new private members on `StreamProxy`:

```typescript
private readonly _coordinator?: TransitionCoordinator; // optional session coordinator (cleared on cleanup)
private _terminated = false;                           // INV-010 — terminal handling runs exactly once
```

Plus the idempotent method `_terminate(success: boolean, reason?: string): void` (the single teardown
chokepoint) and the 11th optional constructor param `coordinator?: TransitionCoordinator`. Type safety is
enforced by `strict: true` + `isolatedModules: true` (`tsconfig.json`) and the `tsc --noEmit` gate;
`isTextEvent`/`isToolCallEvent`/`isTerminalEvent` narrow the `AssistantMessageEvent` union.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — imports + coordinator field/ctor param + _terminated guard
  - EXTEND the existing `import { … } from "../types";` line with isTextEvent, isToolCallEvent (isThinkingEvent
    added by T2; isTerminalEvent already there).
  - ADD `import type { TransitionCoordinator } from "../state/coordinator";` (type-only; no cycle).
  - ADD the _coordinator field + _terminated guard (Mode-A JSDoc from "What / B").
  - ADD the 11th optional ctor param `coordinator?: TransitionCoordinator` + `this._coordinator = coordinator;`
    (after replacementStartupTimeoutMs assignment).
  - GOTCHA: type-only import; do NOT add a public getter for _coordinator.
  - DEPENDENCIES: TransitionCoordinator (src/state/coordinator exists); isTextEvent/isToolCallEvent (src/types).

Task 2: MODIFY src/provider/proxy.ts — add the _terminate(success, reason?) method
  - ADD the private _terminate method (Mode-A JSDoc + body from "What / C") near transitionIfLegal.
  - IMPLEMENT: _terminated guard; success → transitionIfLegal Answering→Completed→Idle; failure →
    (fail if !Failed) → transitionIfLegal Idle; then _clearAbortTimeout + _clearReplacementTimeout +
    buffer.reset() in try/catch + _replacementAbort = undefined + _coordinator?.setActiveProxy(undefined) +
    trace proxy.lifecycle.cleanup.
  - FOLLOW pattern: transitionIfLegal is the no-throw FSM helper; _terminate layers teardown onto it.
  - GOTCHA: gate fail() on getState()!=="Failed"; wrap buffer.reset() in try/catch (§17); trace {} only.
  - DEPENDENCIES: Task 1.

Task 3: MODIFY src/provider/proxy.ts — wire _terminate into run() (E1/E2/E4)
  - E1: after the primary-loop race-won block, ADD this._terminate(true).
  - E2: in the catch _upstreamCompleted branch, ADD this._terminate(true) before return.
  - E4: in the catch unexpected-throw else, after the _emit error terminal, ADD this._terminate(false,"upstream-error").
  - GOTCHA: do NOT add _terminate to the clean-abort branch (E3) — _launchReplacement owns termination.
  - DEPENDENCIES: Task 2.

Task 4: MODIFY src/provider/proxy.ts — completion FSM in _launchReplacement (F1) + EC-018 guard (F2) + catch (F3)
  - F1: in the replacement loop AFTER this._emit(event): beginAnswering() if state==="Splicing" &&
    (isTextEvent||isToolCallEvent); then if isTerminalEvent(event): done → _terminate(true), error →
    _terminate(false,"replacement-error").
  - F2: after the replacement loop, ADD `if (!this._messageEndEmitted) { this._emit(error…); this._terminate(false,"replacement-empty"); }`.
  - F3: in the replacement catch, after the _emit error terminal, ADD this._terminate(false,"replacement-failed").
  - GOTCHA: keep T2's flip-before-_emit ordering (lifecycle AFTER _emit); _terminate is idempotent so the
    post-loop guard + a forwarded-terminal are mutually safe.
  - DEPENDENCIES: Task 2; P1.M7.T2.S1 (_emit + _messageEndEmitted).

Task 5: CREATE tests/stream-proxy-lifecycle.test.ts
  - COPY makeCaptureDiag/makeModel/ev/waitFor + makeReplacementUpstream VERBATIM from stream-proxy-replacement.test.ts;
    copy makeUnresponsiveUpstream from stream-proxy-abort.test.ts for case #7.
  - CONSTRUCT the proxy with an injected ReasoningBuffer (7th arg) + a REAL TransitionCoordinator (11th arg,
    sharing the capturing diag); call coordinator.setActiveProxy(proxy) upfront; drain proxy.output concurrently.
  - IMPLEMENT the 8 coverage cases (full success lifecycle + §48; beginAnswering on first answer token;
    failure via replacement error; EC-018 empty; normal path still cleans up; cleanup exactly once INV-010;
    FM-006 abort-timeout→failure→cleanup; privacy guard).
  - FOLLOW pattern: stream-proxy-replacement.test.ts (bun:test; waitFor; capture diag; positional ctor args).
  - COVERAGE: the headline MOCKING contract (FSM→Idle + resources released + coordinator cleared + one start +
    one terminal + result() resolves) + INV-010 (cleanup once) + the failure/EC-018/normal/FM-006 paths.
  - PLACEMENT: tests/stream-proxy-lifecycle.test.ts.
  - DEPENDENCIES: imports StreamProxy; TransitionController; ReasoningBuffer; TransitionCoordinator;
    DEFAULT_CONFIG (for the 9th positional abortTimeoutMs).

Task 6: VERIFY (do not edit unless broken) the pre-existing suites
  - RUN the full suite; the P1.M7.T1.S1 replacement suite, the P1.M7.T2.S1 filtering suite, the P1.M5
    abort/race suites, and the detection/golden/forwarding regressions must all still pass.
  - The race test (natural-completion-won) now additionally calls _terminate(true) (a resource-release no-op
    on the FSM); verify it still asserts its race-won trace + exactly-one-terminal. If a test asserts the
    FSM state is left somewhere _terminate changes, reconcile minimally — but expect none (the race path's
    _cancelInFlightAbort already moved to Idle; _terminate(true) no-ops the FSM there).
  - DEPENDENCIES: Tasks 1–5.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — _terminate is the single idempotent teardown chokepoint (INV-010/INV-011), layered onto the
// no-throw transitionIfLegal (mirrors trackEvent being a detection layered onto push).
private _terminate(success: boolean, reason?: string): void {
  if (this._terminated) return;                // INV-010 — exactly once
  this._terminated = true;
  if (success) {
    this.transitionIfLegal("Answering");       // Splicing→Answering (no-op if past; no-op from Reasoning)
    this.transitionIfLegal("Completed");       // Answering→Completed
    this.transitionIfLegal("Idle");            // Completed→Idle
  } else {
    if (this._controller.getState() !== "Failed") this._controller.fail(reason ?? "transition-failed");
    this.transitionIfLegal("Idle");            // Failed→Idle
  }
  this._clearAbortTimeout();                   // release FM-006 timer handle
  this._clearReplacementTimeout();             // release startup-timeout timer handle
  try { this._buffer.reset(); } catch (err) {  // §17 — cleanup must succeed even if telemetry fails
    this.diagnostics.warn("proxy.cleanup.buffer-reset-failed", { error: err instanceof Error ? err.message : String(err) });
  }
  this._replacementAbort = undefined;          // release replacement abort reference (§44)
  this._coordinator?.setActiveProxy(undefined); // release transition token (§44)
  this.diagnostics.trace("proxy.lifecycle.cleanup", {}); // privacy-safe
}

// PATTERN — the replacement-loop drive (F1), AFTER T2's _emit (do NOT reorder the flip):
//   this._emit(event);
//   if (this._controller.getState() === "Splicing" && (isTextEvent(event) || isToolCallEvent(event)))
//     this._controller.beginAnswering();
//   if (isTerminalEvent(event))
//     event.type === "done" ? this._terminate(true) : this._terminate(false, "replacement-error");

// GOTCHA — _terminate(true) is SAFE on the normal path: from Reasoning all three transitionIfLegal are no-ops,
//   so the FSM stays Reasoning (correct — no misleading transition.failed) yet resources are released.
// GOTCHA — gate fail() on getState()!=="Failed" (the timeout handlers already fail()'d → avoid double-log).
// GOTCHA — reset() throws unless Completed|Failed; transitionIfLegal is the ONLY safe caller → never throws.
// GOTCHA — _messageEndEmitted (T2) is the EC-018 guard signal (false → synthesize; true → skip).
// PRIVACY — proxy.lifecycle.cleanup logs {} only (Appendix H); fail() reason is a category string.
```

### Integration Points

```yaml
# This subtask MODIFIES src/provider/proxy.ts (+ adds 1 test file). No other module changes.

PROXY INTERNALS (src/provider/proxy.ts): the only change. _terminate is the new single teardown chokepoint;
  run()'s natural-exit + catch + _launchReplacement's loop/post-loop/catch all funnel through it.
  transitionIfLegal / _clearAbortTimeout / _clearReplacementTimeout / _buffer / _replacementAbort /
  makeErrorAssistantMessage / _emit / _messageEndEmitted (all from earlier phases) reused UNCHANGED.

CONTROLLER (src/state/controller.ts): NO CHANGE. T3 CONSUMES beginAnswering/complete/fail/reset (via
  transitionIfLegal). ALLOWED_TRANSITIONS is the legality source.

COORDINATOR (src/state/coordinator.ts): NO CHANGE. T3 CONSUMES setActiveProxy(undefined) on cleanup (the
  cleanup hook). setActiveProxy(this) on construct is the DECORATOR's job (a LATER wiring task — out of scope).

BUFFER (src/buffer/index.ts): NO CHANGE. T3 CONSUMES reset() (the §44 "destroy reasoning buffer").

TYPES (src/types.ts): NO CHANGE. isTextEvent/isToolCallEvent imported (exist since P1.M2.T1.S1).

REQUESTBUILDER / CONFIG / DIAGNOSTICS / DECORATOR / SHORTCUT / FACTORY: NO CHANGE.

EVENTSTREAM (pi-ai library): NO CHANGE (read-only). Relied upon for: push(terminal) completes output +
  resolves result() (T2's contract); _terminate adds nothing to the stream — output is already complete when
  _terminate runs (the terminal was forwarded first).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after modifying src/provider/proxy.ts — must be clean before writing tests.
npx bun run typecheck     # tsc --noEmit over src/** — proxy.ts MUST compile (0 diagnostics)
npx bun run build         # tsc → exit 0 (verify dist/provider/proxy.js still emits)

# (No ruff/mypy — TS project. Match the existing 2-space style + Mode-A JSDoc.)
# Expected: Zero errors. Common READ-for failures:
#  - "Cannot find name 'isTextEvent'/'isToolCallEvent'" → the import addition (Task 1) is missing/typo'd:
#    `import { isTerminalEvent, isThinkingEvent, isTextEvent, isToolCallEvent } from "../types";`
#  - "Cannot find name 'TransitionCoordinator'" → the type-only import (Task 1) is missing:
#    `import type { TransitionCoordinator } from "../state/coordinator";`
#  - "Property '_terminate' does not exist" → the method (Task 2) was not added.
#  - a circular-dependency warning → should NOT happen (coordinator import is type-only; coordinator.ts does
#    not import proxy.ts).
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the new suite in isolation.
npx bun test tests/stream-proxy-lifecycle.test.ts -v

# The producer suites (P1.M7.T1/T2) must still pass — verify the two-phase mock + filtering are unaffected.
npx bun test tests/stream-proxy-replacement.test.ts tests/stream-proxy-filtering.test.ts -v

# The forwarding/detection/abort/race regressions must still pass.
npx bun test tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts \
             tests/stream-proxy-abort.test.ts tests/stream-proxy-race.test.ts -v

# Full suite for regressions (every other suite unchanged).
npx bun test

# Expected: All green. Common failures to READ for:
#  - "expected coordinator.clear-active, not found" (new lifecycle test) → _terminate did not run, OR the
#    coordinator was not passed/registered. Confirm: (1) the 11th ctor arg is a real TransitionCoordinator
#    sharing the capturing diag; (2) coordinator.setActiveProxy(proxy) was called upfront; (3) the cycle drove
#    a terminal so _terminate ran.
#  - "expected getState() === Idle, received Splicing/Answering" → _terminate did not fire on the terminal,
#    OR transitionIfLegal was bypassed for reset(). Confirm F1 calls _terminate after the done/error _emit.
#  - "buffer.snapshot().length !== 0 after completion" → buffer.reset() did not run; confirm _terminate calls it.
#  - "proxy.lifecycle.cleanup traced twice" → _terminate's _terminated guard is missing/ineffective, OR a path
#    bypasses it. Confirm the guard is the FIRST line of _terminate.
#  - the race test now fails on an exact FSM state → _terminate(true) ran on the race-won path and changed the
#    FSM; but transitionIfLegal from Idle is a no-op, so this should NOT happen — re-check; the race path's
#    _cancelInFlightAbort already moved to Idle.
#  - a test hangs → the replacement emitted no terminal AND the EC-018 guard did not fire; confirm F2's
#    `if (!this._messageEndEmitted)` post-loop guard synthesizes a terminal.
```

### Level 3: Integration Testing (System Validation)

```bash
# (a) The full pre-existing suite is byte-for-byte unchanged EXCEPT proxy.ts; every suite must still pass:
npx bun test tests/reasoning-buffer.test.ts tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts \
             tests/stream-proxy-race.test.ts tests/stream-proxy-replacement.test.ts \
             tests/stream-proxy-filtering.test.ts tests/stream-proxy-abort.test.ts \
             tests/transition-controller.test.ts tests/transition-coordinator.test.ts tests/shortcut-manager.test.ts \
             tests/golden/golden-replay.test.ts tests/factory.test.ts tests/provider-decorator.test.ts -v

# (b) The build still emits the modified module:
npx bun run build && ls dist/provider/   # expect: proxy.js + proxy.d.ts (+ maps)

# (c) Full suite (the real integration bar — every suite + the new lifecycle file):
npx bun test

# Expected: (a) all green unchanged; (b) dist/provider/proxy.{js,d.ts} present; (c) all green, zero regressions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# The headline MOCKING contract (PRD §7 Story 1 + §48): drive a full primary→replacement cycle in the new
# lifecycle test and assert: exactly ONE start + ONE terminal; output.result() resolves to done.message;
# controller.getState() === "Idle"; coordinator.clear-active traced; buffer.snapshot().length === 0.
# (Covered by case #1.)

# INV-010 (cleanup exactly once): case #6 — push a duplicate terminal after the first; assert
# proxy.lifecycle.cleanup + coordinator.clear-active each traced EXACTLY once.

# EC-018 (empty replacement): case #4 — replacement ends without a terminal; assert exactly ONE synthesized
# error terminal reached the consumer + output.result() resolves + cleanup ran.

# Normal path resource release: case #5 — NO triggerStop; primary done; assert proxy.lifecycle.cleanup +
# coordinator.clear-active traced + buffer reset, while FSM is correctly left in Reasoning (no transition.failed).

# FM-006 (abort timeout → failure → cleanup): case #7 — unresponsive upstream + tiny abortTimeoutMs; assert
# the eventual proxy.lifecycle.cleanup + coordinator.clear-active + FSM Idle after the throw path's _terminate.

# §48 "no leaked abort controllers / no leaked buffers": structurally enforced by _terminate clearing both
# timers + _replacementAbort + buffer.reset on EVERY terminal exit (INV-010). The once-only + the cleared
# timer handles are the proof; a leaked timer would keep the proxy closure alive (a stress/gc test is P1.M8.T4).

# Privacy (Appendix H): case #8 — filter proxy.lifecycle.* + proxy.cleanup.* captured events; assert each
# fields === {} / {error} only — never content/options/reasoning/prompt.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0; `dist/provider/proxy.{js,d.ts}` emitted.
- [ ] Level 2: `npx bun test` → **all green** (new `stream-proxy-lifecycle` + every pre-existing suite).
- [ ] No regressions: the P1.M7.T1.S1 replacement suite, the P1.M7.T2.S1 filtering suite, the P1.M5 abort/race
      suites, and the detection/golden/forwarding/provider-decorator/factory suites are unchanged and still pass.
- [ ] `proxy.ts` adds only the imports + the `_coordinator` field/ctor param + the `_terminated` guard + the
      `_terminate` method + the call-site wiring in `run()`/`_launchReplacement`; no new runtime dependencies,
      no change to `_emit`/`trackEvent`/the timeout handlers/`_cancelInFlightAbort`.

### Feature Validation
- [ ] `_terminate(success, reason?)` is the single idempotent teardown (INV-010): drives the FSM to `Idle`
      (success: Answering→Completed→Idle; failure: fail→Idle), releases all resources (clear timers,
      `buffer.reset()` in try/catch, `_replacementAbort = undefined`, `coordinator?.setActiveProxy(undefined)`),
      traces `proxy.lifecycle.cleanup` once.
- [ ] The replacement loop calls `beginAnswering()` on the first `text_*`/`toolcall_*` while `Splicing`, and
      `_terminate(true)`/`_terminate(false,"replacement-error")` on the forwarded terminal — AFTER `_emit`
      (T2's flip-before-`_emit` ordering preserved).
- [ ] The EC-018 post-loop guard (`if (!this._messageEndEmitted)`) synthesizes ONE `error` terminal via `_emit`
      + `_terminate(false,"replacement-empty")` so `output.result()` never hangs.
- [ ] `run()` releases resources on EVERY natural/catch terminal exit (normal completion, race-won, unexpected
      throw) via `_terminate`; the clean-abort branch delegates to `_launchReplacement` (no double teardown).
- [ ] The full success lifecycle (PRD §7 Story 1 + §48) emits exactly ONE `start` + ONE terminal, resolves
      `output.result()`, reaches `Idle`, clears the coordinator, and resets the buffer.
- [ ] The normal non-interrupted path releases resources WITHOUT a misleading `transition.failed` (FSM left
      in `Reasoning`).

### Code Quality Validation
- [ ] Mode-A JSDoc on `_terminate` + `_coordinator` + `_terminated` citing PRD §16/§17/§44/§51 + Appendix O
      INV-010/INV-011 + Appendix H — matches the existing proxy.ts style.
- [ ] `_terminate` uses `transitionIfLegal` exclusively (never throws); `fail()` is gated on `!Failed`.
- [ ] The call-site edits are minimal, each with its "keep T2's ordering / keep the abort branch unchanged"
      constraint honored.
- [ ] File placement matches the desired tree.

### Documentation & Deployment
- [ ] JSDoc explains WHY `_terminate(true)` is safe on the normal path (Reasoning no-ops), WHY `fail()` is
      gated on `!Failed` (timeout handlers already failed), WHY `_internalAbort` is not nulled (readonly +
      already aborted), and WHY the EC-018 guard keys on `_messageEndEmitted`.
- [ ] JSDoc marks the decorator coordinator-wiring as out of scope (the construct-side `setActiveProxy(this)`
      is a later integration task).
- [ ] No new env vars / config / dependencies.

---

## Anti-Patterns to Avoid
- ❌ Don't call `reset()` / `complete()` / `beginAnswering()` directly from a terminal exit — `reset()` THROWS
  unless Completed|Failed. Route ALL FSM moves through `transitionIfLegal` (the no-throw helper). The ONLY
  exception is `fail()` (Any→Failed, never throws) — and even that must be gated on `getState() !== "Failed"`
  to avoid double-logging on the timeout paths.
- ❌ Don't reorder the replacement loop — T2's `_authority = "splicing"` flip +
  `proxy.replacement.first-event` trace MUST run in the `if (!firstSeen)` block BEFORE `this._emit(event)`.
  T3 adds `beginAnswering` + the `_terminate` drive AFTER `_emit`. Reordering would break T2's authority model.
- ❌ Don't redefine `_emit` or change its return — T3 only CALLS it. T2 owns the filter; T3 owns the lifecycle.
- ❌ Don't add `_terminate` to the clean-abort branch (`state === "Aborting"` in `run()`'s catch) — that branch
  delegates to `_launchReplacement`, which owns termination. Adding `_terminate` there would tear down before
  the replacement runs.
- ❌ Don't unconditionally call `fail()` in `_terminate`'s failure branch — the FM-006 / startup-timeout
  handlers ALREADY called `fail()`. Gate on `getState() !== "Failed"` or you double-log `transition.failed`.
- ❌ Don't null the `_internalAbort` — it's `private readonly` (can't reassign) and already aborted by cleanup
  time; it's GC'd with the per-request proxy. Nulling it would require changing field mutability for no
  benefit. The mutable `_replacementAbort` IS nulled; the setTimeout HANDLES are cleared.
- ❌ Don't skip the EC-018 post-loop guard — T2 explicitly deferred it to T3 ("do NOT add a post-loop
  synthesized terminal here — it would steal T3's scope"). Without it, a replacement that ends without a
  terminal hangs `output.result()` forever.
- ❌ Don't worry that `_terminate(true)` "fails" the normal path — from `Reasoning` all three
  `transitionIfLegal` calls are no-ops, so the FSM stays `Reasoning` (correct, no misleading log) and
  resources are still released. ONE method serves every exit; do not special-case the normal path.
- ❌ Don't touch `types.ts`, `controller.ts`, `coordinator.ts`, `buffer/`, `config/`, `diagnostics/`,
  `shortcut/`, `request/builder.ts`, `decorator.ts`, `index.ts`, or any pre-existing test — this subtask is
  `proxy.ts` + the new lifecycle test only.
- ❌ Don't wire the coordinator/shortcut into the decorator/factory here — that Pi-extension integration is a
  LATER task (P1.M8). T3 adds only the cleanup HOOK (the optional param + `setActiveProxy(undefined)` call).
- ❌ Don't use a trace name that collides with the splice/replacement/abort paths — use `proxy.lifecycle.*`
  (and `proxy.cleanup.*`) so the existing privacy/trace assertions stay accurate. All lifecycle/cleanup logs
  are `{}` / `{error}` only (Appendix H).

---

**Confidence Score: 9/10** for one-pass implementation success. The change is a well-bounded addition to
P1.M7.T1/T2's `run()`/`_launchReplacement`: one idempotent `_terminate(success, reason?)` method (whose body,
FSM-drive logic, resource-release list, and §17 try/catch are reproduced verbatim), one optional coordinator
param (type-only, no cycle), and precise AFTER-`_emit` call-site wiring (each with its "keep T2's ordering /
keep the abort branch unchanged" constraint) plus the EC-018 post-loop guard T2 explicitly deferred. The
elegant property that makes this low-risk — `_terminate(true)` is safe on the normal path because
`transitionIfLegal` no-ops from `Reasoning` — is documented in Context + Anti-Patterns (it is grounded in the
ALLOWED_TRANSITIONS table, not a guess). The residual uncertainty (why 9 not 10) is the **breadth of terminal
exits that now flow through `_terminate`** (success / replacement-error / EC-018 / replacement catch /
upstream-throw / normal / race-won): each must reach exactly-once teardown, and while the single `_terminated`
guard makes double-calls structurally safe, the implementer must verify every path actually CALLS `_terminate`
once (the call-site map in `research/notes.md` §5 + Tasks 3–4 enumerate them). The other judgment call —
keeping the coordinator wiring out of scope (decorator construct-side `setActiveProxy(this)` is a later task)
— is documented as the boundary; T3 delivers the cleanup hook + tests it via a directly-passed coordinator.
