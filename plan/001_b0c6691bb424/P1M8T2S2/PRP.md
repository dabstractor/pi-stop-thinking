# PRP — P1.M8.T2.S2: Provider failure modes and recovery hierarchy

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M8.T2.S2 (Phase 7 Hardening, 2 pts). Defines detection + recovery for the
> **provider/network failure modes** FM-006…FM-015 against the PRD §54 Recovery Hierarchy
> (L1 ignore, L2 disable transition, L3 terminate replacement, L4 terminate proxy).
> **INPUT**: `StreamProxy` (`src/provider/proxy.ts`) + `TransitionCoordinator`
> (`src/state/coordinator.ts`) from P1.M7.T3.S1. **OUTPUT**: all 10 provider failure modes have defined
> detection + recovery; no failure leaves orphaned resources (PRD §54). **Consumed by**: P1.M8.T4
> (stress/property tests exercise these paths).
>
> **SCOPE TRIAGE (codebase audit — see `research/notes.md` §1)**: P1.M7.T3.S1 + P1.M5.T2 already built
> the full recovery MACHINERY (timeouts, catches, idempotent `_terminate`). Of the 10 provider FMs:
> - **8 are ALREADY IMPLEMENTED and need only lock-in tests** (FM-006/007/008/009/010/011/012/014).
> - **1 is NEW** — FM-013 (malformed-event validation): the only genuinely missing behavior.
> - **1 is a MINOR addition** — FM-015 (trace for non-terminal stray events after authority transfer).
> - **NO behavior FIXES** are required (unlike the parallel S1 task's EC-017 suppress→forward fix).
>
> **PARALLEL-TASK BOUNDARY**: S1 (P1.M8.T2.S1) is being implemented in parallel and edits
> `src/provider/proxy.ts` (`trackEvent` + the `_emit` **splicing branch**) + `coordinator.ts` + 4 test
> files. This task edits `_emit` at its **TOP** (before authority branching) + the **constructor**
> (`_model`) + `types.ts` + a NEW test file + `types.test.ts`. The two `_emit` edit regions are
> disjoint (S2 = top guard; S1 = inside splicing branch) → clean 3-way auto-merge; no file-level
> overlap otherwise. See §"All Needed Context → Parallel boundary" for the exact non-conflict proof.

---

## Goal

**Feature Goal**: Every provider/network failure mode (FM-006…FM-015) is **detected** and **recovered**
per the PRD §54 Recovery Hierarchy, with **zero orphaned resources**. Concretely: an abort the provider
ignores times out and the original stream is preserved (L2); a replacement that is rejected, fails
auth, or is dropped mid-stream forwards the provider error and cleans up (L3); a replacement that never
starts, terminates empty, or terminates immediately is handled (timeout→error / forward completion); a
malformed event is logged, forwarded best-effort, or — if it is a terminal that would corrupt Pi —
replaced with a synthesized error and the transition failed (L4); duplicate completions are suppressed;
stray events after authority transfer are discarded with a trace. Net result: no adversarial provider
behavior can hang the downstream consumer, corrupt the single-terminal invariant, or leak a transition
token / buffer / abort-controller / timer.

**Deliverable** (TWO source files MODIFIED + TWO test files MODIFIED + ONE test file CREATED):
- `src/types.ts` — **MODIFY**: add the pure `isMalformedEvent(event): boolean` validator (FM-013).
- `src/provider/proxy.ts` — **MODIFY**: store `private readonly _model` from the constructor; at the
  **TOP of `_emit`** add the FM-013 malformed-event guard (warn + best-effort forward for non-terminals;
  synthesize error + `_terminate(false,"malformed-terminal")` for malformed terminals) and the FM-015
  non-terminal-stray-after-completion guard (`_messageEndEmitted && !isTerminal` → trace + return).
- `tests/types.test.ts` — **MODIFY**: add a table-driven `isMalformedEvent` suite.
- `tests/stream-proxy-failure-modes.test.ts` — **CREATE**: dedicated lock-in tests for every provider
  FM (FM-006/007/008/009/010/011/012/013/014/015) using controlled mock streams.
- *(FM-012 already has a test in `stream-proxy-replacement.test.ts`; this task adds the
  error-forwarded + cleanup assertions inside the new file to keep all provider FMs in one place.)*

**Success Definition**: From a clean checkout (after merging S1), `npx bun run typecheck` → **0**
diagnostics; `npx bun run build` → exit 0; `npx bun test` → **ALL green** (new + modified suites +
every pre-existing suite unchanged). Every provider FM has a passing test that exhibits the failure
condition and asserts the contract recovery + cleanup. PRD §54 holds: no recovery path leaves
allocated resources orphaned; every path funnels through `_terminate` → `coordinator.setActiveProxy
(undefined)`.

---

## User Persona (if applicable)

**Target User**: The end user whose Stop-Thinking transition hits an adversarial or degraded provider —
a provider that ignores the abort signal, rejects the replacement (4xx), fails authentication (401),
drops the network mid-transition, returns a malformed/garbage event, emits a duplicate completion, or
leaks stray events after authority transfer. The feature must degrade gracefully: the user never sees a
hung response, a half-spliced broken stream, a crash, or a leaked resource that corrupts the next turn.

**Use Case**: The user presses Stop; the provider's replacement request 401s (auth expired). The user
sees the provider's auth error surfaced cleanly, the proxy tears down, and the next request starts from
a clean coordinator state (no stale active-proxy reference).

**Pain Points Addressed**: (1) a malformed `done` event (no message) could crash Pi's runtime — it must
be replaced with a synthesized error; (2) stray events after completion are currently silently no-op'd
with no trace — observability gap; (3) the recovery paths exist but are not pinned against regression,
so a future refactor of `_emit`/`_launchReplacement`/`_startAbortTimeout` could silently break L2/L3/L4.

---

## Why

- **FM-013 (NEW, PRD §42 + §52 + EC-020)**: today NO validation exists — a `done` without `message`
  reaches `this._output.push(event)` directly, which would make Pi's runtime dereference an undefined
  `AssistantMessage` (downstream-integrity violation). This is the one real correctness gap.
- **FM-006/007/008/009/010/011/012/014 (PRD §42)**: already recovered by the P1.M7 machinery, but
  asserted only indirectly or not at all. These lock-in tests make the §54 Recovery Hierarchy
  regression-proof before P1.M8.T4 fuzzes these exact paths.
- **FM-015 (PRD §42 + §39 "Forbidden: emit upstream completion after replacement begins")**: terminals
  after transfer are already deduped+traced; non-terminal strays are silently dropped. Adding the trace
  closes the observability hole so chaos tests (P1.M8.T4) can assert the discard.
- **Downstream**: P1.M8.T4 (stress/chaos/property) will inject every one of these failures at random —
  they must each be deterministic and crash-free first, and P1.M8.T3 (session shutdown) depends on
  `coordinator.setActiveProxy(undefined)` being called on every recovery path.

---

## What

### Source: MODIFY `src/types.ts` — add `isMalformedEvent` (FM-013)

Add ONE pure function beside the existing four type guards. It classifies **recognized-type** events
whose critical payload is missing/ill-typed. **Unknown-type events are NOT malformed** (PRD §52 "Unknown
events: pass through unchanged" — they already fall through `_emit`'s else-branch `push`).

```typescript
/**
 * FM-013 / PRD §52 Validation Rules: is a RECOGNIZED-type event missing its critical payload?
 *
 * Recognized type but structurally broken (vs. an UNKNOWN type, which §52 passes through unchanged):
 *   - `done`  without a `message` (the AssistantMessage Pi dereferences at completion) — FATAL downstream.
 *   - `error` without an `error`  (the AssistantMessage carrying the failure)                — FATAL downstream.
 *   - `*_delta` (`thinking`/`text`/`toolcall`) whose `delta` is not a string                  — recoverable.
 * `start` / `*_start` / `*_end` and every unknown type return `false` (recoverable / pass-through).
 *
 * The caller (`StreamProxy._emit`) decides severity: a malformed TERMINAL (`isTerminalEvent` true)
 * cannot carry a valid completion → synthesize a clean error + fail (PRD §54 L4); a malformed
 * NON-terminal is logged + forwarded best-effort (recoverable).
 *
 * - Side effects: none. Pure. - @returns true iff the event is a recognized type missing critical payload.
 */
export function isMalformedEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "done":
      return !(event as Extract<AssistantMessageEvent, { type: "done" }>).message;
    case "error":
      return !(event as Extract<AssistantMessageEvent, { type: "error" }>).error;
    case "thinking_delta":
    case "text_delta":
    case "toolcall_delta":
      return typeof (event as Extract<AssistantMessageEvent, { type: "thinking_delta" }>).delta !== "string";
    default:
      return false; // start / *_start / *_end / unknown → not malformed (pass through / recoverable)
  }
}
```

> **NOTE on payload access:** the `Extract<...>` casts narrow to the discriminated member so `message`
> / `error` / `delta` are statically present (their *runtime* presence is exactly what we test). If the
> pi-ai `AssistantMessageEvent` shape ever renames these fields, this function is the single place to
> update. Keep the `switch` exhaustive over the malformed-critical types only (do NOT add cases for
> `*_start`/`*_end`/`start` — they are recoverable by default).

### Source: MODIFY `src/provider/proxy.ts` — store `_model` + FM-013/FM-015 guards at the TOP of `_emit`

**1. Store the model** so `_emit` (which does NOT receive `model` as a param) can synthesize a clean
error terminal via `makeErrorAssistantMessage`. Add the field + assignment (S1 does NOT touch the
constructor, so no conflict):

```typescript
// new field (place beside the other private readonlys, e.g. after _controller/_buffer):
/** The streamed model — retained so _emit can synthesize a clean error terminal on a malformed
 *  terminal event (FM-013). Only .id/.api/.provider are read (makeErrorAssistantMessage). */
private readonly _model: Model<Api>;

// in the constructor body (model is already the 1st param; add ONE line near the top of the body):
this._model = model;
```

**2. At the very TOP of `_emit`, BEFORE the existing `if (this._authority === "forwarding")` branch**,
add the FM-013 validation + FM-015 stray-discard guards (these run for BOTH primary and replacement
events; they are ABOVE the authority branching so they never overlap S1's edits inside the splicing
branch):

```typescript
private _emit(event: AssistantMessageEvent): void {
  // FM-013 / PRD §52 Validation Rules — detect malformed recognized-type events. Unknown-type events
  // are NOT malformed (isMalformedEvent returns false) and pass through unchanged (§52 "Unknown events").
  if (isMalformedEvent(event)) {
    this.diagnostics.warn("proxy.event.malformed", { type: event.type }); // privacy — type ONLY (Appendix H)
    if (isTerminalEvent(event)) {
      // A malformed TERMINAL (done w/o message / error w/o error) cannot carry a valid completion →
      // downstream integrity at risk. Synthesize ONE clean error terminal (preserves single-terminal /
      // single-result invariants) and fail the transition (PRD §54 L4 / §52 "terminate only if downstream
      // integrity cannot be preserved"). _terminate is idempotent → safe if a terminal was already pushed.
      if (!this._messageEndEmitted) {
        this._messageEndEmitted = true;
        this._output.push({
          type: "error",
          reason: "error",
          error: this.makeErrorAssistantMessage(this._model, "malformed terminal event"),
        });
      }
      this._terminate(false, "malformed-terminal");
      return;
    }
    // Malformed NON-terminal (e.g. *_delta missing delta) → forward best-effort (fall through).
  }

  // FM-015 / PRD §39 "Forbidden: emit upstream completion after replacement begins": after the single
  // terminal was forwarded, any further NON-terminal event is a stray from the post-transfer stream.
  // Discard with a trace. (Terminal strays are deduped per-phase below with proxy.splice.duplicate-terminal;
  // this guard is gated on !isTerminalEvent so it never shadows that trace.)
  if (this._messageEndEmitted && !isTerminalEvent(event)) {
    this.diagnostics.trace("proxy.splice.discard-after-completion", {}); // privacy — {} only (Appendix H)
    return;
  }

  // ── existing authority branching BELOW (UNCHANGED — S1 edits live inside the splicing branch) ──
  if (this._authority === "forwarding") {
    ... // forwarding phase — UNCHANGED
    return;
  }
  ... // splicing phase — S1 edits the thinking_* handling here; S2 does NOT touch this region
}
```

> **Ordering rationale:** FM-013's malformed-terminal synthesis sets `_messageEndEmitted = true` and
> terminates; the FM-015 guard then catches any later non-terminal stray. Both guards sit ABOVE the
> authority branching so they apply uniformly to primary + replacement events and never collide with
> S1's splicing-branch EC-017 change (which is textually below this insertion point). The import line
> gains `isMalformedEvent` alongside the existing `isTerminalEvent/isThinkingEvent/...` from `"../types"`.

> **JSDoc update:** prepend one line to the existing `_emit` JSDoc: "Performs FM-013 malformed-event
> validation and FM-015 stray-discard at the top (before authority branching); then the §18 filtering."
> Do NOT otherwise alter the `_emit` JSDoc (S1 is editing the splicing-phase bullet).

### Source: NO change to recovery machinery — verify-only

The recovery MACHINERY already satisfies the contract (confirmed by audit — see `research/notes.md`):
- FM-006: `_startAbortTimeout` (proxy.ts:322) → on fire if `Aborting`, `warn("proxy.abort.timeout")` +
  `fail("abort-timeout")` (Aborting→Failed). `run()` keeps iterating the original upstream (it didn't
  throw — the provider ignored the abort) → events keep flowing via `_emit` forwarding phase → "normal
  stream preserved" (L2). Replacement is NEVER launched (the replacement launches only in `run()`'s
  catch when state is `Aborting`; after timeout state is `Failed`). Cleanup runs at the preserved
  stream's natural completion (`_terminate(true)` → Failed→Idle + timers/buffer/coordinator released).
- FM-007/008/010: `_launchReplacement` catch (proxy.ts:796) → `clearReplacementTimeout` + (warn
  `proxy.replacement.failed` unless already Failed) + `_emit(synthesized error)` +
  `_terminate(false, "replacement-failed")`. The synthesized error uses `err.message` → forwards the
  provider's error. (L3.)
- FM-009: `run()` catch (proxy.ts:655) for a thrown primary; `trackEvent` (proxy.ts:478) for an `error`
  EVENT primary. Both forward + `_terminate(false, "upstream-error")`. (L1/L3 delegate.)
- FM-011: `_launchReplacement` loop (proxy.ts:763) forwards the replacement `done` +
  `_terminate(true)` (Splicing→Answering→Completed→Idle); EC-018 guard (proxy.ts:774) synthesizes an
  error only for the degenerate "ended without ANY terminal" case (NOT a valid immediate-completion).
- FM-012: `_startReplacementTimeout` (proxy.ts:813) → on fire if `Restarting`, `warn` +
  `fail("replacement-startup-timeout")` + `_replacementAbort?.abort()` (unblocks the iterator → the
  catch synthesizes the error + `_terminate(false, "replacement-failed")`).
- FM-014: `_emit` `_messageEndEmitted` dedup (both phases; trace `proxy.splice.duplicate-terminal`).

### Test: MODIFY `tests/types.test.ts` — `isMalformedEvent` unit suite

Add `isMalformedEvent` to the import and a table-driven `describe` (reuse the existing `makeEvent`
sentinel + a payload-bearing builder). Cases:
- `done` with a `message` → `false`; `done` WITHOUT `message` → `true`.
- `error` with an `error` → `false`; `error` WITHOUT `error` → `true`.
- `text_delta`/`thinking_delta`/`toolcall_delta` with a string `delta` → `false`; with `delta`
  missing / non-string → `true`.
- `start` / `text_start`/`thinking_end` / unknown type → `false` (recoverable / pass-through).
- PRIVACY/contract: `isMalformedEvent` reads ONLY `type` + the one critical payload field; it never
  inspects content beyond presence/typeof (assert via a payload that has unrelated junk fields).

### Test: CREATE `tests/stream-proxy-failure-modes.test.ts` — provider FM lock-ins

REUSE `makeCaptureDiag`/`makeModel`/`ev`/`waitFor`/`DONE_MESSAGE`/`ERROR_MESSAGE` VERBATIM from
`stream-proxy-replacement.test.ts` (copy them). Inject real `TransitionController` + `ReasoningBuffer`
+ (for cleanup assertions) a real `TransitionCoordinator` as the proxy's LAST ctor arg. Each case:
- drive the proxy to the relevant state, inject the failure via a controlled mock, await the outcome,
  assert the recovery + the cleanup trace/FSM + privacy `{}`/allow-listed fields.

Required mock helpers (defined in the file):
- `makeIgnoreAbortUpstream()` — yields from a queue and **NEVER throws on signal abort** (FM-006). The
  test pushes events including a final `done` AFTER asserting the timeout fired.
- A two-phase mock whose REPLACEMENT phase can be configured to: (a) throw synchronously before first
  event (FM-007/008); (b) throw after yielding one event (FM-010); (c) yield only `{type:"done",
  message}` (FM-011); (d) yield `done` then a stray `text_delta` (FM-015); (e) yield a malformed event
  (FM-013). (Adapt `makeReplacementUpstream` from `stream-proxy-replacement.test.ts` with a configurable
  replacement iterable.)

Cases (one `test` per FM, named `FM-006: …`, `FM-007: …`, etc.):
1. **FM-006** — drive to Reasoning → `triggerStop()`; the ignore-abort mock keeps streaming. Inject a
   small `abortTimeoutMs`. Await `proxy.abort.timeout` warn + `controller.getState()==="Failed"`. Then
   push `thinking_delta` + `done` → assert the consumer drains them (the original stream is PRESERVED:
   `seen` includes the post-timeout delta + the single `done`; exactly one terminal). Assert final FSM
   state `Idle` + a `proxy.lifecycle.cleanup` trace + (with a coordinator wired) a
   `coordinator.clear-active` trace. Replacement NOT launched (`mock.calls.length === 0`).
2. **FM-007** — replacement throws synchronously before first event → consumer sees exactly one `error`
   terminal (synthesized, carrying the thrown message); `proxy.replacement.failed` warn; FSM ends `Idle`;
   `_terminate` cleanup trace; replacement timer cleared (no `startup-timeout`).
3. **FM-008** — replacement throws an auth-style error (message contains "401"/"auth") → same as FM-007
   (the recovery is identical: forward the error + cleanup); assert the synthesized error's
   `errorMessage` carries the thrown message.
4. **FM-009 (error-event path)** — primary yields `{type:"error", error}` (not a throw) → consumer sees
   the error terminal forwarded; FSM `Idle`; cleanup. (The throw path is already covered in
   `stream-proxy.test.ts` — do not duplicate; reference it in a comment.)
5. **FM-010** — replacement yields one `text_delta` then throws → consumer sees the text + exactly one
   synthesized `error` terminal; `proxy.replacement.failed` warn; cleanup.
6. **FM-011** — replacement yields ONLY `{type:"done", message}` (immediate/empty completion) → consumer
   sees the `done` forwarded (single terminal); FSM ends `Idle` (Splicing→Answering→Completed→Idle);
   cleanup; NO `proxy.replacement.failed` (it is a success). (EC-018.)
7. **FM-012** — replacement yields nothing; small `replacementStartupTimeoutMs` → `proxy.replacement.
   startup-timeout` warn + the replacement aborted + consumer sees exactly one synthesized `error`
   terminal; FSM `Idle`; cleanup. (Enhances the existing replacement-test assertion that the error is
   forwarded + cleanup runs.)
8. **FM-013 (terminal)** — primary (or replacement) yields `{type:"done"}` (no `message`) →
   `proxy.event.malformed` warn with `{type:"done"}`; consumer sees exactly one SYNTHESIZED `error`
   terminal (NOT the malformed done); `_terminate(false,"malformed-terminal")` → FSM `Failed`→`Idle`;
   cleanup. Repeat for `{type:"error"}` (no `error`).
9. **FM-013 (non-terminal)** — primary yields `{type:"text_delta"}` (no `delta`) → `proxy.event.malformed`
   warn with `{type:"text_delta"}`; the event is FORWARDED best-effort (consumer `seen` includes it);
   stream continues normally to a `done` (no termination). (Recoverable per EC-020.)
10. **FM-014** — replacement yields `done` then a second `done` → consumer sees EXACTLY ONE `done`;
    `proxy.splice.duplicate-terminal` trace; cleanup once.
11. **FM-015** — replacement yields `done` then a stray `text_delta` → consumer sees exactly one terminal;
    `proxy.splice.discard-after-completion` trace for the stray; cleanup once.
12. **PRIVACY guard** — across all cases, every `proxy.*` / `coordinator.*` / `transition.*` diagnostic
    logs only allow-listed fields (`{}`, `type`, `timeoutMs`, `error`, `reason`, `from`, `accepted`).
    Assert via the same ALLOWED_KEYS loop used in `stream-proxy-replacement.test.ts`.

> **Cleanup assertion helper:** wire a real `TransitionCoordinator` (constructed with the capturing
> diag) as the proxy's last ctor arg and call `coordinator.setActiveProxy(proxy)` after construction;
> then every recovery case can assert `events.some(c => c.event === "coordinator.clear-active")` (the
> `setActiveProxy(undefined)` call from `_terminate`) — this is the PRD §54 "no orphaned resources" /
> contract "all recovery paths call coordinator.setActiveProxy(undefined)" lock-in.

### Scope Boundary — DO NOT implement (owned by other tasks)

- **Shortcut-timing FMs (FM-001…FM-005) + EC-001/002/005/006/009/010/016/017** → S1
  (P1.M8.T2.S1). Do not touch `coordinator.ts`, `trackEvent`, or the `_emit` splicing branch.
- **Telemetry** (TransitionFailed categories, failure counters) → P1.M8.T1.S1 (complete). Diagnostics
  traces/warns provide observability; do NOT add telemetry calls here.
- **Factory wiring** (`src/index.ts` constructing the coordinator, passing it to the proxy,
  `setActiveProxy` on construct/drain, shortcut registration) → deferred factory-integration task. This
  task exercises cleanup via DI (inject the coordinator as the proxy's last ctor arg).
- **EC-018 "ended without terminal"** degenerate synthesis (proxy.ts:774) is already correct — do not
  change it; FM-011 covers the valid immediate-`done` case.
- **`config/`, `diagnostics/`, `buffer/`, `request/`, `controller.ts`, `decorator.ts`, `shortcut/`** →
  none. Only `types.ts` + `proxy.ts` + the two test files.

### Success Criteria

- [ ] FM-006: abort-ignored → timeout→Failed; original stream events + terminal still forwarded; cleanup
      at natural completion; replacement never launched.
- [ ] FM-007/008: replacement rejected/auth-fail before first event → provider error forwarded (one
      terminal); cleanup; FSM Idle.
- [ ] FM-009: primary error-event → delegated (forwarded + cleanup).
- [ ] FM-010: replacement throws mid-stream → one synthesized error terminal; cleanup.
- [ ] FM-011: replacement immediate/empty `done` → completion forwarded; FSM Idle; cleanup; no failure.
- [ ] FM-012: replacement never starts → timeout→abort→one error terminal; cleanup.
- [ ] FM-013: malformed terminal → synthesized error + `_terminate(false,"malformed-terminal")`;
      malformed non-terminal → warn + best-effort forward.
- [ ] FM-014: duplicate completion suppressed (one terminal).
- [ ] FM-015: stray non-terminal after completion → discarded with `proxy.splice.discard-after-
      completion` trace.
- [ ] Every recovery path emits `coordinator.clear-active` (no orphaned transition token) +
      `proxy.lifecycle.cleanup`.
- [ ] `npx bun run typecheck` → 0; `npx bun run build` → exit 0; `npx bun test` → all green.

---

## All Needed Context

### Context Completeness Check

_Validated: "If someone knew nothing about this codebase, would they have everything needed?"_ → YES.
The exact `isMalformedEvent` body, the exact `_emit` top-of-method insertion (with the non-conflict
proof against S1), the `_model` field/assignment, the verbatim test helpers to reuse, the per-FM
assertions, the confirmed-already-implemented recovery line numbers, and the verified build/test
commands are all reproduced above and in `research/notes.md`.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- url: (in-repo) PRD.md §42 "Failure Mode Specification" — FM-006…FM-015 (lines 3236–3360)
  why: The exact expected-behavior for each provider failure mode (the recovery contract).
  critical: FM-006=preserve stream; FM-007/008=forward error+cleanup; FM-009/010=delegate; FM-011=forward
            completion; FM-012=timeout+abort+error; FM-013=forward-if-possible else terminate; FM-014=suppress;
            FM-015=discard silently+trace.

- url: (in-repo) PRD.md §52 "Detailed Event Processing Rules" → "Validation Rules" (line 3937)
  why: FM-013 ground truth — "Unknown events: pass through unchanged. Malformed events: log diagnostics,
       attempt recovery, terminate only if downstream integrity cannot be preserved."
  critical: UNKNOWN type → pass through (isMalformedEvent=false); MALFORMED terminal → terminate (fatal);
            malformed non-terminal → recoverable (forward best-effort).

- url: (in-repo) PRD.md §54 "Error Recovery" + §39 "Transition Event Rules"
  why: §54 Recovery Hierarchy (L1 ignore / L2 disable transition / L3 terminate replacement / L4 terminate
       proxy) + "No recovery path may leave allocated resources orphaned"; §39 "Forbidden: emit upstream
       completion after replacement begins" (FM-015) + "Emit duplicate message_end" (FM-014).
  critical: every recovery path MUST funnel through cleanup (_terminate → coordinator.setActiveProxy(undefined)).

- url: (in-repo) PRD.md EC-018/EC-019/EC-020 (lines ~3920+)
  why: EC-018 empty completion → forward; EC-019 error-immediately → forward+cleanup; EC-020 malformed
       thinking → log+continue-if-recoverable-else-terminate.
  critical: distinguishes FM-011 (valid immediate done) from the degenerate "ended without terminal" synthesis.

- file: src/provider/proxy.ts
  why: MODIFY target. `_emit` (forward chokepoint) gets the FM-013/FM-015 top guards; constructor stores _model.
  pattern: every recovery funnels through the idempotent `_terminate(success, reason)` (FSM fail→Idle +
           clear timers + buffer reset + coordinator.setActiveProxy(undefined)); `makeErrorAssistantMessage
           (model, message)` builds the synthesized terminal.
  gotcha: `_emit` does NOT receive `model` — store `this._model` in the constructor (S1 does not touch it).
          S1 edits `_emit` INSIDE the splicing branch; insert S2's guards at the TOP (before authority `if`)
          so the two never textually overlap → clean 3-way merge.

- file: src/types.ts
  why: MODIFY target — add `isMalformedEvent` beside the four existing type guards (same pure-function
        convention; same `THINKING_TYPES`-style centralization).
  pattern: discriminators are centralized sets; guards are `(event) => boolean` over AssistantMessageEvent.
  gotcha: return `false` for start/*_start/*_end/unknown (recoverable/pass-through); only done/error/*_delta
          are checked. Access payload via `Extract<AssistantMessageEvent,{type:"done"}>` narrowing.

- file: src/state/controller.ts
  why: READ — the FSM. `fail(reason)` (Any→Failed, never throws) is the recovery escape hatch; ALLOWED
        TRANSITIONS encodes Failed→Idle (the cleanup reset). `getState()` reads current state.
  gotcha: from Reasoning there is NO normal Completed exit (§16); recovery relies on `fail()`+`reset`.

- file: src/state/coordinator.ts
  why: READ — `setActiveProxy(undefined)` (traced `coordinator.clear-active`) is the §44 "transition token"
        release called by `_terminate`. Wire a real coordinator (last ctor arg) to assert cleanup.
  gotcha: S1 ADDS pending-stop + isDelegating() to this file — do NOT edit it; just consume setActiveProxy.

- file: tests/stream-proxy-replacement.test.ts
  why: SOURCE of the verbatim test helpers to copy (makeCaptureDiag/makeModel/ev/waitFor/DONE_MESSAGE/
        ERROR_MESSAGE/makeReplacementUpstream) + the privacy ALLOWED_KEYS assertion loop.
  pattern: two-phase upstream mock (primary then replacement queues); concurrent consumer drains proxy.output.
  gotcha: makeReplacementUpstream's REPLACEMENT phase must be made configurable to throw / immediate-done /
          stray-after-done / malformed for the FM cases.

- file: tests/stream-proxy-abort.test.ts
  why: SOURCE of makeUnresponsiveUpstream (FM-006 pattern — provider ignores abort) + the FM-006 test shape.
  gotcha: makeUnresponsiveUpstream blocks then releases; for "normal stream preserved" you need a mock that
          keeps YIELDING (incl. a final done) after the timeout — build makeIgnoreAbortUpstream.

- file: tests/types.test.ts
  why: MODIFY target — add the isMalformedEvent table-driven suite; reuse makeEvent + a payload builder.
```

### Current Codebase tree (relevant subset)

```bash
src/
  types.ts                 # MODIFY — add isMalformedEvent (FM-013)
  provider/proxy.ts        # MODIFY — _model field; FM-013 + FM-015 guards at TOP of _emit
  state/controller.ts      # READ — fail()/reset() recovery escape hatch
  state/coordinator.ts     # READ — setActiveProxy(undefined) cleanup (S1 edits it; do NOT)
  config/index.ts          # READ — transitionTimeoutMs / replacementStartupTimeoutMs (inject small in tests)
  diagnostics/index.ts     # READ — the trace/warn sink
tests/
  types.test.ts                       # MODIFY — isMalformedEvent suite
  stream-proxy-failure-modes.test.ts  # CREATE — FM-006..FM-015 lock-ins
  stream-proxy-replacement.test.ts    # READ — copy test helpers + FM-012 reference
  stream-proxy-abort.test.ts          # READ — FM-006 mock pattern
  stream-proxy-filtering.test.ts      # READ — FM-014 reference (S1 edits it; do NOT)
```

### Desired Codebase tree with files to be added/modified

```bash
src/types.ts                          # MODIFY — export isMalformedEvent(event): boolean
src/provider/proxy.ts                 # MODIFY — _model field+assign; FM-013/FM-015 guards at TOP of _emit
tests/types.test.ts                   # MODIFY — isMalformedEvent table-driven suite
tests/stream-proxy-failure-modes.test.ts # CREATE — one test per provider FM + privacy guard
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: `_emit` does NOT receive `model` as a parameter — it is a run()/_launchReplacement param.
// Store `private readonly _model = model` in the constructor so the FM-013 malformed-terminal synthesis
// can call this.makeErrorAssistantMessage(this._model, "..."). S1 does NOT touch the constructor.

// CRITICAL (parallel merge): S1 edits `_emit` INSIDE the splicing branch (EC-017 thinking forward). Insert
// S2's FM-013 + FM-015 guards at the very TOP of `_emit`, BEFORE the `if (this._authority === "forwarding")`
// line. Disjoint text regions → clean 3-way auto-merge. Do NOT edit the splicing branch (S1 owns it).

// CRITICAL: `_terminate(success, reason?)` is IDEMPOTENT (the `_terminated` guard). It is safe to call from
// `_emit` (FM-013) even though run()/_launchReplacement also call it on their exit paths. Never call
// _terminate more than once expecting side effects — the second is a structural no-op.

// GOTCHA: the FM-015 stray-discard guard MUST be gated on `!isTerminalEvent(event)`. An UNGATED check on
// `_messageEndEmitted` would shadow the per-phase terminal dedup (proxy.splice.duplicate-terminal) that
// S1 and the existing FM-014 test rely on. Terminal strays keep their own trace; non-terminal strays get
// proxy.splice.discard-after-completion.

// GOTCHA: a malformed `done`/`error` reaches `trackEvent` BEFORE `_emit` on the PRIMARY path. trackEvent's
// step-4 `transitionIfLegal("Completed")` is a no-op from Reasoning (§16 has no Reasoning→Completed edge),
// so the malformed terminal does NOT corrupt the FSM before _emit synthesizes the clean error. trackEvent
// is try/catch-guarded regardless (never breaks forwarding — ADR-005). Do NOT move FM-013 into trackEvent.

// GOTCHA: for FM-006 the original stream is "preserved" because run()'s `for await` loop KEEPS ITERATING
// (the provider ignored the abort → the iterator did NOT throw → run() never enters its catch → the
// replacement is NEVER launched). Do NOT add any "launch replacement after timeout" path — that would
// violate FM-006 "Replacement not launched".

// GOTCHA: `buffer.append(event.delta)` on a malformed `*_delta` (delta undefined) on the primary path may
// throw or store undefined — but trackEvent is try/catch-guarded (warn proxy.tracking-error, swallowed), so
// forwarding still proceeds. Not a correctness issue; do not special-case it.

// GOTCHA: the synthesized error terminal for a malformed event MUST set `_messageEndEmitted = true` BEFORE
// `this._output.push(...)` (mirrors the existing terminal-forward pattern) so the single-terminal invariant
// holds and the FM-015 guard discards any later stray. Guard the push on `!this._messageEndEmitted` in case
// a terminal was already forwarded (idempotent safety).
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// No new data MODELS. The additions are:
//   1. types.ts: one pure function — `isMalformedEvent(event: AssistantMessageEvent): boolean`.
//   2. proxy.ts: one private field — `private readonly _model: Model<Api>` (assigned in the constructor).
// No changes to event shapes, Config, TransitionState, or ProxyPhase.
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/types.ts — add isMalformedEvent (FM-013)
  - ADD: `export function isMalformedEvent(event): boolean` with the discriminated switch (done→!message,
    error→!error, *_delta→typeof delta!=="string", default false). Narrow payload via Extract<AssistantMessageEvent,{type:"…"}>.
  - FOLLOW pattern: the four existing type guards (isThinkingEvent/…/isTerminalEvent) — pure, centralized,
    JSDoc citing PRD §52.
  - NAMING: `isMalformedEvent` (camelCase; `is…` predicate convention matching the other guards).
  - PRESERVE: every existing export (THINKING_TYPES etc. + the four guards) — APPEND only.

Task 2: MODIFY src/provider/proxy.ts — _model + FM-013/FM-015 guards at TOP of _emit
  - ADD: `private readonly _model: Model<Api>;` field; `this._model = model;` in the constructor body.
  - ADD import: `isMalformedEvent` to the existing `import { … } from "../types";`.
  - MODIFY `_emit`: at the VERY TOP (before `if (this._authority === "forwarding")`) insert the FM-013
    malformed-event block (warn `proxy.event.malformed` {type}; if isTerminalEvent → synthesize error +
    `_terminate(false,"malformed-terminal")` + return; else fall through) and the FM-015 block
    (`if (this._messageEndEmitted && !isTerminalEvent(event)) { trace proxy.splice.discard-after-completion; return; }`).
  - UPDATE `_emit` JSDoc: prepend one line noting FM-013/FM-015 run at the top. Do NOT edit the splicing-phase
    JSDoc bullets (S1 owns them).
  - PRESERVE: the forwarding + splicing authority branching BELOW the insertion (S1 edits the splicing
    branch); `_terminate`/`makeErrorAssistantMessage`/all recovery machinery UNCHANGED.

Task 3: MODIFY tests/types.test.ts — isMalformedEvent suite
  - ADD isMalformedEvent to the import; add a table-driven describe with a payload-bearing builder.
  - CASES: done±message; error±error; *_delta string/missing/non-string; start/*_start/*_end/unknown → false.
  - PRESERVE: every existing describe/test unchanged.

Task 4: CREATE tests/stream-proxy-failure-modes.test.ts — provider FM lock-ins
  - COPY makeCaptureDiag/makeModel/ev/waitFor/DONE_MESSAGE/ERROR_MESSAGE from stream-proxy-replacement.test.ts.
  - ADD mock helpers: makeIgnoreAbortUpstream (FM-006) + a configurable two-phase mock whose replacement
    phase can throw/immediate-done/stray-after-done/malformed.
  - CASES: FM-006, FM-007, FM-008, FM-009(error-event), FM-010, FM-011, FM-012, FM-013(terminal),
    FM-013(non-terminal), FM-014, FM-015, + a PRIVACY guard (ALLOWED_KEYS loop over proxy.*/coordinator.*/transition.*).
  - CLEANUP ASSERTION: wire a real TransitionCoordinator (last ctor arg) + setActiveProxy(proxy); every
    recovery case asserts a `coordinator.clear-active` trace + `proxy.lifecycle.cleanup` (PRD §54).

Task 5: VERIFY (no edit) recovery machinery — re-run the new suite + full suite
  - The 8 already-implemented FMs (006/007/008/009/010/011/012/014) must pass their lock-in tests with
    ZERO source changes to their recovery code. If a lock-in FAILS, that signals a real recovery gap —
    fix the recovery path (funnel through _terminate) per §"Source: NO change…" notes, do NOT weaken the test.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: FM-013 malformed-terminal → synthesize + terminate (preserves single-terminal invariant).
if (isMalformedEvent(event)) {
  this.diagnostics.warn("proxy.event.malformed", { type: event.type });
  if (isTerminalEvent(event)) {
    if (!this._messageEndEmitted) {
      this._messageEndEmitted = true;
      this._output.push({ type: "error", reason: "error",
        error: this.makeErrorAssistantMessage(this._model, "malformed terminal event") });
    }
    this._terminate(false, "malformed-terminal"); // idempotent → FSM fail→Idle + cleanup
    return;
  }
  // malformed non-terminal → fall through (forward best-effort)
}

// PATTERN: FM-015 stray non-terminal after completion → discard + trace (gated on !isTerminalEvent).
if (this._messageEndEmitted && !isTerminalEvent(event)) {
  this.diagnostics.trace("proxy.splice.discard-after-completion", {});
  return;
}

// PATTERN: every recovery path funnels through _terminate (already true for FM-006/007/008/009/010/011/012;
// FM-013 adds one more _terminate call site). Assert it via the coordinator.clear-active trace in tests.
```

### Integration Points

```yaml
TYPES (src/types.ts):
  - NEW export: isMalformedEvent — imported by proxy.ts + tested in types.test.ts.
PROXY (src/provider/proxy.ts):
  - NEW field: _model (constructor-assigned).
  - _emit: NEW top-of-method FM-013 + FM-015 guards (before authority branching). Recovery machinery UNCHANGED.
COORDINATOR (UNCHANGED — S1 owns the file; this task only CONSUMES setActiveProxy for cleanup assertions).
CONFIG/DIAGNOSTICS/BUFFER/REQUEST/CONTROLLER/DECORATOR/SHORTCUT/INDEX: UNCHANGED.
FACTORY (DEFERRED): the session coordinator is wired by the later factory task; this task exercises
  cleanup via DI (inject a real coordinator as the proxy's last ctor arg + setActiveProxy(proxy)).
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# After editing types.ts + proxy.ts — fix before proceeding.
npx bun run typecheck          # tsc --noEmit — zero diagnostics
npx bun run build              # tsc — emits dist/ with exit 0
# Expected: Zero errors. (Most likely first-run issue: forgetting to import isMalformedEvent in proxy.ts,
# or `_model` not assigned in the constructor. Fix and re-run.) TypeScript + Bun (no ruff/mypy/formatter).
```

### Level 2: Unit Tests (Component Validation)

```bash
# isMalformedEvent unit behavior.
npx bun test tests/types.test.ts

# Provider failure-mode lock-ins (the headline deliverable).
npx bun test tests/stream-proxy-failure-modes.test.ts

# Full suite — confirm NO regression (the _emit top-guards must not break forwarding/replacement/filtering/
# abort/race/detection/lifecycle; S1's suites, once merged, must also stay green).
npx bun test
# Expected: ALL green. Common failures to debug: a malformed-terminal push not setting _messageEndEmitted
# (double-terminal); the FM-015 guard not gated on !isTerminalEvent (shadows duplicate-terminal trace); a
# lock-in test that expects recovery code that does not yet funnel through _terminate (fix the code, not the test).
```

### Level 3: Integration Testing (System Validation)

```bash
# Build + whole-suite smoke (this is a Pi extension loaded by the host — no running server).
npx bun run build && npx bun test

# Confirm no import cycle was introduced (types ← proxy is one-directional; coordinator stays type-only):
npx bun -e "import('./src/types.js').then(m=>console.log(Object.keys(m).filter(k=>k.startsWith('is')))"
# Expected: includes isMalformedEvent alongside the four existing guards.

# Confirm every recovery path releases the transition token (PRD §54) — run the new suite's cleanup cases:
npx bun test tests/stream-proxy-failure-modes.test.ts -t "FM-"
# Expected: each FM case's `coordinator.clear-active` + `proxy.lifecycle.cleanup` assertions pass.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# FM-013 downstream-integrity confirm (the one NEW behavior) — run in isolation + eyeball the synthesized error:
npx bun test tests/stream-proxy-failure-modes.test.ts -t "FM-013"
# Expected: a malformed `done`/`error` yields a SINGLE synthesized `error` terminal (NOT the malformed event)
# and the FSM ends Idle → Pi's runtime never dereferences an undefined AssistantMessage.

# FM-006 "normal stream preserved" confirm:
npx bun test tests/stream-proxy-failure-modes.test.ts -t "FM-006"
# Expected: after the abort-timeout→Failed, post-timeout thinking deltas + the final `done` still reach the
# consumer; replacement NEVER launched; FSM returns to Idle at natural completion.

# Full failure-mode matrix lock-in (all provider FMs in one run):
npx bun test tests/stream-proxy-failure-modes.test.ts
# Expected: FM-006..FM-015 all green — the §54 Recovery Hierarchy is fully pinned.
```

---

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun run build` → exit 0.
- [ ] `npx bun test` → ALL suites green (new + modified + every pre-existing, incl. S1's once merged).

### Feature Validation

- [ ] FM-006: abort ignored → timeout→Failed; original stream (post-timeout events + terminal) preserved;
      replacement never launched; cleanup at natural completion.
- [ ] FM-007/008: replacement rejected/auth-fail before first event → provider error forwarded (one
      terminal) + cleanup; FSM Idle.
- [ ] FM-009: primary error-event delegated (forwarded + cleanup).
- [ ] FM-010: replacement throws mid-stream → one synthesized error terminal + cleanup.
- [ ] FM-011: replacement immediate/empty `done` → completion forwarded; FSM Idle; cleanup; no failure.
- [ ] FM-012: replacement never starts → timeout→abort→one error terminal + cleanup.
- [ ] FM-013: malformed terminal → synthesized error + `_terminate(false,"malformed-terminal")`;
      malformed non-terminal → warn + best-effort forward (no termination).
- [ ] FM-014: duplicate completion suppressed (exactly one terminal).
- [ ] FM-015: stray non-terminal after completion → discarded with `proxy.splice.discard-after-completion`.
- [ ] Every recovery path emits `coordinator.clear-active` + `proxy.lifecycle.cleanup` (no orphaned resources).

### Code Quality Validation

- [ ] Follows existing patterns (pure guards in types.ts; idempotent `_terminate`; privacy `{}`/allow-listed
      traces; `private readonly` fields; Mode-A JSDoc).
- [ ] File placement matches the desired tree; NO edits to coordinator.ts / controller.ts / config / buffer /
      request / decorator / shortcut / index / the `_emit` splicing branch (S1 owns those).
- [ ] Anti-patterns avoided (see below): no shadowing of the terminal dedup; no replacement-after-timeout;
      no FM-013 in trackEvent; no orphaned recovery path.
- [ ] No new import cycle (types ← proxy stays one-directional).

### Documentation & Deployment

- [ ] JSDoc added: `isMalformedEvent`, `_model`, the `_emit` top-guard note.
- [ ] New traces/warns (`proxy.event.malformed` {type}, `proxy.splice.discard-after-completion` {}) are
      privacy-safe and named consistently with existing `proxy.*` events.
- [ ] The deferred factory-wiring boundary + the S1 merge boundary are documented (Scope Boundary) so the
      next tasks are unblocked.

---

## Anti-Patterns to Avoid

- ❌ Don't gate the FM-015 stray-discard on `_messageEndEmitted` ALONE (ungated) — it would shadow the
  per-phase terminal dedup (`proxy.splice.duplicate-terminal`) that S1 + the FM-014 test rely on. Gate on
  `!isTerminalEvent(event)`.
- ❌ Don't launch a replacement after the FM-006 timeout — FM-006 mandates "Replacement not launched"; the
  provider ignored the abort so `run()` keeps iterating the original stream and never enters its catch.
- ❌ Don't put FM-013 validation in `trackEvent` — it is the forward chokepoint `_emit` (covers BOTH primary
  and replacement) that must decide fatal-vs-recoverable; `trackEvent` runs first but is side-effect-only +
  try/catch-guarded and must stay observational (ADR-005).
- ❌ Don't weaken a lock-in test to make it pass — if an FM recovery path does not yet funnel through
  `_terminate` (no `coordinator.clear-active`), that is a real §54 violation; fix the recovery code.
- ❌ Don't edit the `_emit` splicing branch, `coordinator.ts`, `trackEvent`, or `config/`/`buffer/`/`request/`
  — S1 or earlier tasks own them; this task's `_emit` edits live ONLY at the top (before authority branching).
- ❌ Don't add telemetry calls — P1.M8.T1.S1 owns telemetry; diagnostics warn/trace is the observability here.
- ❌ Don't forget to set `_messageEndEmitted = true` before the FM-013 synthesized-terminal `push` (and guard
  it on `!this._messageEndEmitted`) — else the single-terminal invariant can be violated by a duplicate.
- ❌ Don't let the malformed-terminal synthesis push without `this._model` — store it in the constructor;
  `_emit` has no `model` parameter.

---

## Confidence Score

**9/10** — one-pass implementation success likelihood. The deliverable is small and precisely scoped: one
pure function in `types.ts`, one private field + two top-of-`_emit` guards in `proxy.ts`, two test-file
edits, and one new test file reusing the existing async harness. The genuinely new logic (FM-013) is a
~12-line guard with a clear fatal-vs-recoverable split grounded in PRD §52; FM-015 is a 3-line trace guard.
The 8 already-implemented FMs are verified-by-audit to funnel through the idempotent `_terminate`, so their
lock-in tests should pass with zero recovery-code changes (and a failure there is a real, localized fix).
The parallel-S1 merge is clean (disjoint `_emit` regions; no shared files). Residual 1-point risk: the
two-phase replacement mock must be made configurable to exhibit each FM precisely (documented per-case),
and the malformed-terminal push ordering (`_messageEndEmitted` before `push`, guarded) must be exact
(documented with the precise pattern + gotcha).
