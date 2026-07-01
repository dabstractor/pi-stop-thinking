# PRP — P1.M8.T2.S1: Shortcut timing failure modes and edge cases

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M8.T2.S1 (Phase 7 Hardening, 2 pts). Handles the **shortcut-timing** failure modes
> (FM-001…FM-004) and edge cases (EC-001, EC-002, EC-005, EC-006, EC-009, EC-010) plus the two config/
> stream edge cases named in the contract (EC-016 feature-disabled, EC-017 replacement-returns-reasoning).
> **INPUT**: `StreamProxy` (`src/provider/proxy.ts`) + `TransitionCoordinator` (`src/state/coordinator.ts`)
> from P1.M7.T3.S1. **OUTPUT**: every shortcut-timing edge case is handled gracefully — no crash, no broken
> stream, no double interruption. **Consumed by**: P1.M8.T4 (stress/property tests exercise these paths).
>
> **SCOPE TRIAGE (from codebase audit — see `research/notes.md` §1)**: of the 5 contract logic points,
> three are **ALREADY IMPLEMENTED** and need only lock-in tests (a, c, d); one is **NEW** (b — EC-002
> pending stop, the main work); one is a **BEHAVIOR FIX** (e — EC-017: the current code SUPPRESSES
> replacement reasoning but the PRD says FORWARD it).
>   - (a) `requestStop()` returns `false` outside `Reasoning` (FM-001/002/003, EC-001/005/006) → DONE.
>   - (b) EC-002 pending stop → **IMPLEMENT**.
>   - (c) `alreadyInterrupting()` first-press-wins (FM-004/EC-009/EC-010) → DONE.
>   - (d) EC-016 feature disabled → DONE (decorator gates on `config.enabled`).
>   - (e) EC-017 replacement returns reasoning → **FIX** (forward, not suppress).
>
> **PARALLEL-TASK BOUNDARY**: P1.M8.T1.S1 (telemetry) is in flight and modifies `src/telemetry/index.ts`,
> `src/shortcut/index.ts`, `tests/telemetry.test.ts`, `tests/shortcut-manager.test.ts`. This task touches
> **none** of those files (zero merge conflict). Telemetry is NOT required by this contract.

---

## Goal

**Feature Goal**: Make every shortcut-timing failure mode and edge case behave gracefully: presses outside
`Reasoning` are ignored (no crash, no broken stream); a press during the pre-reasoning "network stall"
window (`Delegating`) is **recorded as a pending stop** that auto-triggers the transition the instant
reasoning begins (or is discarded if the provider answers without reasoning); repeat/held presses are
collapsed to a single transition; a disabled feature never allocates a proxy; and any reasoning a
thinking-disabled replacement unexpectedly returns is **forwarded** (not silently dropped) without ever
recursively interrupting. Net result: the shortcut path is robust under every documented timing edge case.

**Deliverable** (TWO source files MODIFIED + THREE test files MODIFIED + ONE test file CREATED):
- `src/state/coordinator.ts` — **MODIFY**: add `pendingStop` field, `consumePendingStop()` /
  `clearPendingStop()`, the `isDelegating()` member on the `ActiveProxy` interface, the pending-stop
  record inside `requestStop()`, and `pendingStop` reset in `setActiveProxy()`.
- `src/provider/proxy.ts` — **MODIFY**: add `isDelegating()`; in `trackEvent` consume-and-trigger the
  pending stop on the first reasoning event + clear it when the first event is text; in `_emit` **forward**
  (not skip) replacement reasoning events (EC-017).
- `tests/transition-coordinator.test.ts` — **MODIFY**: add `isDelegating()` to the fake proxy + add
  pending-stop record/consume/clear/reset coverage.
- `tests/stream-proxy-filtering.test.ts` — **MODIFY**: update the EC-017 case to assert replacement
  reasoning is **forwarded** (was: suppressed).
- `tests/stream-proxy-pending-stop.test.ts` — **CREATE**: end-to-end pending-stop trigger + clear-on-text
  + already-handled (c)/(d) lock-ins at the proxy level.
- `tests/provider-decorator.test.ts` — **MODIFY**: add the EC-016 lock-in (`config.enabled===false` → no
  proxy constructed; direct delegation).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics;
`npx bun run build` → exit 0; `npx bun test` → **ALL green** (new + modified suites + every pre-existing
suite unchanged). PRD invariants hold: no double transition, no recursive interruption, no broken/dropped
stream, single `start` + single terminal preserved across every edge case.

---

## User Persona (if applicable)

**Target User**: The end user pressing `Ctrl+.` (the Stop Thinking shortcut) under adversarial timing —
pressing before reasoning starts, during a network stall, during `thinking_end`, after the answer begins,
or mashing/holding the key. The feature must "just work": at most one transition, never a crash, never a
broken half-stream.

**Use Case**: A z.ai reasoning stream stalls (network), the user presses Stop while NO reasoning has
arrived yet; the moment reasoning begins the wrapper auto-stops it — the user does not have to re-press or
guess when reasoning started.

**Pain Points Addressed**: (1) today a press during the `Delegating` window is silently lost (must press
again after reasoning starts); (2) replacement reasoning that slips through is currently DROPPED (data
loss), contradicting EC-017; (3) no explicit tests pin the "ignore outside Reasoning" / "first-press-wins"
invariants against regression.

---

## Why

- **EC-002 (PRD Appendix B)**: "Shortcut During Network Stall" — record the stop request, trigger on the
  first reasoning event, discard if the first event is answer text. Today the wrapper drops the press
  entirely (`canInterrupt()==false` during `Delegating`), so a stall-bound user must re-press. This is the
  one genuinely missing behavior.
- **EC-017 (PRD Appendix B)**: "Replacement Request Returns Reasoning Anyway" — PRD mandates **forward**
  the renewed reasoning (single transition per response; recursive interruption out of scope). The current
  `_emit` silently SKIPS replacement thinking events, losing them — a direct PRD violation. This subtask
  fixes it.
- **FM-001…FM-004 + EC-001/005/006/009/010**: already correct, but currently asserted only indirectly.
  This subtask adds focused lock-in tests so a future change cannot regress the "ignore outside Reasoning"
  and "first-press-wins" guarantees.
- **EC-016**: feature-disabled delegation (zero proxy allocation) is already implemented but untested at
  the decorator level; this adds the guard test.
- **Downstream**: P1.M8.T4 (stress/property tests) will fuzz these exact timing paths — they must be
  deterministic and crash-free first.

---

## What

### Source: MODIFY `src/state/coordinator.ts` — the pending-stop authority (EC-002)

The coordinator already holds the single `activeProxy` reference and forwards `requestStop`/queries. Add a
**`pendingStop` boolean** (the *only* new mutable field — still no dedup/counter state; first-press-wins
remains FSM-driven). The coordinator RECORDS a pending stop, and the proxy CONSUMES/CLEARS it.

**1. Extend the `ActiveProxy` interface** with one pure read (the coordinator needs to recognize the
pre-reasoning `Delegating` window to distinguish EC-001/Idle-ignore from EC-002/Delegating-record):

```typescript
export interface ActiveProxy {
  isReasoning(): boolean;
  canInterrupt(): boolean;
  triggerStop(): boolean;
  isInterrupting(): boolean;
  /** NEW (P1.M8.T2.S1): true while the stream has started but reasoning has not begun (PRD §16 `Delegating`).
   *  Used by the coordinator to record an EC-002 pending stop pressed during the network-stall window. */
  isDelegating(): boolean;
}
```

**2. Add the field + reset + record + consume/clear methods:**

```typescript
export class TransitionCoordinator {
  private activeProxy: ActiveProxy | undefined = undefined;
  /** NEW (P1.M8.T2.S1, EC-002): a stop pressed during `Delegating` (no reasoning yet) is recorded here and
   *  honored the instant reasoning begins (consumed by the proxy's trackEvent). Cleared on proxy change,
   *  on consume, or when the provider answers without reasoning (clearPendingStop). */
  private pendingStop = false;

  /** Reset pendingStop on EVERY proxy change: a fresh request must not inherit a stale pending stop, and a
   *  teardown clears it. (PRD: pending stop is scoped to one logical assistant response.) */
  setActiveProxy(proxy: ActiveProxy | undefined): void {
    this.activeProxy = proxy;
    this.pendingStop = false;                                  // NEW — fresh per request / cleared on teardown
    this.diagnostics.trace(proxy ? "coordinator.set-active" : "coordinator.clear-active", {});
  }

  requestStop(): boolean {
    const proxy = this.activeProxy;
    if (!proxy) {
      this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "no-active-proxy" });
      return false;                                            // EC-001 (before first event) — ignore
    }
    if (!proxy.canInterrupt()) {
      // Not in Reasoning. Contract (a): return false (covers FM-001/002/003, EC-001/005/006).
      // Contract (b) / EC-002: if pressed during the Delegating window, RECORD a pending stop so it can be
      // honored the instant reasoning begins. Idle (EC-001, pre-start) and terminal states do NOT record.
      if (proxy.isDelegating()) {
        this.pendingStop = true;
        this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "pending-stop-recorded" });
      } else {
        this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "not-reasoning" });
      }
      return false;
    }
    try {
      proxy.triggerStop();
    } catch (err) {
      this.diagnostics.error("coordinator.request-stop-error", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "proxy-fault" });
      return false;                                            // never-crash (Appendix K)
    }
    this.diagnostics.trace("coordinator.request-stop", { accepted: true });
    return true;
  }

  /** EC-002: read + clear the pending-stop flag. Called by the proxy when the first reasoning event
   *  arrives (Delegating→Reasoning). Returns whether a pending stop was recorded for this response. */
  consumePendingStop(): boolean {
    const was = this.pendingStop;
    this.pendingStop = false;
    return was;
  }

  /** EC-003/EC-004: discard the pending stop because the provider answered WITHOUT reasoning. Called by
   *  the proxy when the first event is text while still in Delegating. No-op when nothing was recorded. */
  clearPendingStop(): void {
    this.pendingStop = false;
  }

  // isReasoning() / alreadyInterrupting() — UNCHANGED (pure delegates).
}
```

> **Why key on `isDelegating()` (not "active && !canInterrupt && !interrupting")?** The contract literally
> says "during 'Delegating'". `Delegating` = `start` seen, reasoning not yet begun (the realistic
> network-stall window). The `Idle` sub-window (proxy active, no `start` yet) maps to EC-001 "before first
> event → ignore", so it does NOT record. This is the cleanest faithful mapping and makes assertions crisp.

### Source: MODIFY `src/provider/proxy.ts` — consume/clear the pending stop + forward replacement reasoning

**1. Add `isDelegating()`** (satisfies the expanded `ActiveProxy`; placed beside `isReasoning()`/`canInterrupt()`):

```typescript
/** NEW (P1.M8.T2.S1): stream started, reasoning not yet begun (PRD §16 `Delegating`). EC-002 pending-stop
 *  window. Pure delegate to the FSM. */
isDelegating(): boolean {
  return this._controller.getState() === "Delegating";
}
```

**2. In `trackEvent`, honor the pending stop on the first reasoning event** (insert inside the existing
step-2 `Delegating→Reasoning` block, right after the transition — state is now `Reasoning` so `triggerStop`
is legal):

```typescript
// 2. Enter Reasoning on the FIRST thinking event (PRD §22.3; §16 Delegating→Reasoning).
if (
  (event.type === "thinking_start" || event.type === "thinking_delta") &&
  this._controller.getState() === "Delegating"
) {
  this.transitionIfLegal("Reasoning");
  // EC-002 (P1.M8.T2.S1): a stop pressed during the Delegating network-stall window is honored now.
  // consumePendingStop() is true at most once (it clears itself); triggerStop() is legal (state==Reasoning).
  if (this._coordinator?.consumePendingStop()) {
    this.diagnostics.trace("proxy.pending-stop.triggered", {}); // privacy-safe — {} only (Appendix H)
    this.triggerStop(); // Reasoning→StopRequested→Aborting + abort upstream; run()'s catch completes it
  }
}
// 2b. EC-003/EC-004 (P1.M8.T2.S1): provider answers WITHOUT reasoning → discard any pending stop.
if (isTextEvent(event) && this._controller.getState() === "Delegating") {
  this._coordinator?.clearPendingStop();
}
```

> **Ordering**: both blocks are guarded on distinct event types (thinking vs text) so they never collide.
> The pending-stop consume fires exactly once (only on the entering thinking event, when state was
> `Delegating`). The clear fires on the first text event while `Delegating`. `isTextEvent` is already
> imported from `../types`.

**3. In `_emit`, FORWARD replacement reasoning (EC-017)** — replace the silent-skip branch. In the
`"splicing"` (replacement) phase, REMOVE the `if (isThinkingEvent(event)) { return; }` early-return so
thinking events fall through to the `this._output.push(event)` forward. Add a trace so EC-017 forwarding is
observable:

```typescript
// REPLACEMENT phase (_authority === "splicing") — PRD §18 "After Restart" / §39 / EC-017.
if (event.type === "start") {
  this.diagnostics.trace("proxy.splice.start-suppressed", {});   // already emitted (INV-002)
  return;
}
if (isThinkingEvent(event)) {
  // EC-017 (P1.M8.T2.S1): the thinking-disabled replacement returned reasoning anyway. PRD mandates FORWARD
  // it (single transition per response; recursive interruption out of scope). No recursion is possible:
  // replacement events reach _emit only — they NEVER run trackEvent, so the FSM is not driven; triggerStop()
  // is additionally gated on canInterrupt() which is false once the first transition left Reasoning.
  this.diagnostics.trace("proxy.splice.reasoning-forwarded", {}); // privacy-safe — {} only (Appendix H)
  // fall through to push(event) below
}
if (isTerminalEvent(event)) {
  if (this._messageEndEmitted) {
    this.diagnostics.trace("proxy.splice.duplicate-terminal", {}); // FM-014/FM-015 — unchanged
    return;
  }
  this._messageEndEmitted = true;
}
this._output.push(event); // text_*/toolcall_* AND thinking_* (EC-017) AND the first terminal → forward
```

> The existing per-method JSDoc on `_emit` currently says "thinking_* → SKIP silently". UPDATE that line to
> "thinking_* → FORWARD (EC-017: replacement returned reasoning anyway; no recursive interruption)". Also
> update the class-level `_emit` note that references "EC-017 stray reasoning".

### Source: NO change to `src/shortcut/index.ts`, `src/provider/decorator.ts`, `src/index.ts`

- (c) `alreadyInterrupting()` + first-press-wins is ALREADY in `shortcut/index.ts` (do not touch — the
  parallel telemetry task is editing that file; re-touching risks a merge conflict for no behavioral gain).
- (d) EC-016 is ALREADY in `decorator.ts` (`const eligible = this.config.enabled && ...`). Verify with a
  test only.
- The session coordinator + `setActiveProxy` wiring + shortcut registration are the **factory integration
  task** (deferred — see Scope Boundary). This task implements + tests the LOGIC via DI.

### Test: MODIFY `tests/transition-coordinator.test.ts`

**Add `isDelegating()` to `makeFakeProxy`** (an `isDelegating?: boolean` override defaulting `false`; the
struct must satisfy the expanded `ActiveProxy`). Then ADD `describe` blocks:

- **EC-002 record**: fake with `canInterrupt:false, isDelegating:true` → `requestStop()` returns `false` AND
  a `coordinator.request-stop` trace with `{accepted:false, reason:"pending-stop-recorded"}` is emitted AND
  `consumePendingStop()` returns `true` (and returns `false` on a second call — it self-clears).
- **EC-001/Idle ignore**: fake with `canInterrupt:false, isDelegating:false` (Idle/terminal) → `requestStop`
  returns false, reason `"not-reasoning"`, and `consumePendingStop()` returns `false` (nothing recorded).
- **clearPendingStop discards**: set a pending stop (Delegating record), then `clearPendingStop()` →
  `consumePendingStop()` returns `false`.
- **setActiveProxy resets**: record a pending stop, then `setActiveProxy(undefined)` → `consumePendingStop()`
  returns `false`; also record, then `setActiveProxy(proxy2)` → `consumePendingStop()` returns `false`.
- **Privacy**: extend the existing allow-list assertion to also accept the new trace fields (still
  `accepted`/`reason`/`error` only — no new keys leak).

### Test: MODIFY `tests/stream-proxy-filtering.test.ts` — EC-017 = FORWARD

UPDATE the case "replacement thinking_* suppressed (EC-017...)" → rename to
"replacement thinking_* forwarded (EC-017: reasoning returned anyway)". With the same scenario (replacement
emits `thinking_start` + `thinking_delta` "stray reasoning" before its text), assert:
- BOTH the primary's thinking events AND the replacement's thinking events appear downstream
  (`thinkingEvents.toHaveLength(4)` → `["thinking_start","thinking_delta","thinking_start","thinking_delta"]`).
- A `proxy.splice.reasoning-forwarded` trace is emitted (≥1).
- Exactly one `start` and one terminal still hold (INV-002/INV-003) and the stream completes with no error.
- NO recursive interruption: `mock.calls.length === 1` (the replacement is launched exactly once; a second
  `streamSimple` call would mean re-interruption — assert it stays 1).

Leave every OTHER case in this file (single start/terminal, start-suppressed, FM-014 duplicate-terminal,
text/toolcall forwarded, `output.result()` resolution, privacy `{}` guard) UNCHANGED.

### Test: CREATE `tests/stream-proxy-pending-stop.test.ts`

End-to-end pending-stop behavior through the real `StreamProxy` + real `TransitionCoordinator` + real
`TransitionController` (reuse the `makeReplacementUpstream()` two-phase mock + `makeCaptureDiag()` +
`waitFor` helper VERBATIM from `stream-proxy-filtering.test.ts`/`stream-proxy-replacement.test.ts`; inject
the coordinator as the proxy's last constructor arg). Cases:

1. **EC-002 auto-trigger on first reasoning**: inject coordinator; `coordinator.setActiveProxy(proxy)`.
   Push `start` → wait `proxy.isDelegating()` true. `coordinator.requestStop()` → assert returns `false`
   (still Delegating) AND a `pending-stop-recorded` trace. Push `thinking_start` + `thinking_delta` → the
   proxy MUST auto-trigger: assert `mock.calls.length === 1` (replacement launched) WITHOUT any manual
   `proxy.triggerStop()`, assert a `proxy.pending-stop.triggered` trace, and assert the stream still
   completes with exactly one `start` + one terminal (feed replacement text + done; `await consumer`).
2. **EC-002 then EC-003/004 clear-on-text**: inject coordinator + setActiveProxy. Push `start`. Press
   (`requestStop()`→false, pending recorded). Push `text_start` + `text_delta` (provider answers without
   reasoning) → assert NO replacement is launched (`mock.calls.length === 0`), the pending stop is cleared
   (`coordinator.consumePendingStop()` → false), `proxy.isReasoning()` stays false, and the stream
   completes normally (done). One start + one terminal.
3. **EC-002 no-op without a coordinator**: construct the proxy WITHOUT the coordinator arg (production
   shape). Press during Delegating is impossible to record (no coordinator) → push reasoning → assert it
   just reasons normally (`proxy.isReasoning()` true) and NO auto-trigger / no replacement
   (`mock.calls.length === 0`). Proves the feature is a safe no-op when the coordinator is absent.
4. **EC-005/EC-006 ignore (lock-in, proxy-level)**: drive into `Reasoning` then push `thinking_end`
   followed by `text_start`; press via `coordinator.requestStop()` AFTER `thinking_end`/during answer —
   since `canInterrupt()` is false outside Reasoning, assert `requestStop()` returns `false`, no abort, no
   replacement (`mock.calls.length === 0`). (Confirms (a) at the proxy level.)

> **Why a separate file?** The pending-stop path is end-to-end (coordinator ↔ proxy ↔ upstream mock) and
> needs the full two-phase replacement mock; isolating it keeps `transition-coordinator.test.ts` focused on
> the coordinator's unit behavior and avoids re-running the heavy async harness in the coordinator suite.

### Test: MODIFY `tests/provider-decorator.test.ts` — EC-016 lock-in

Add a case constructing `ProviderDecorator` with a `Config` where `enabled:false` (keep `supportedProviders:
["zai"]`), a capturing registry, and a reasoning z.ai model; call `initialize()`; invoke the registered
`streamSimple` wrapper; assert the captured built-in `originalStreamSimple` is called DIRECTLY (the spy
records one delegation call) and that **NO `StreamProxy` was constructed** (assert via the absence of any
`provider.streamSimple.proxy` debug trace — only `provider.streamSimple.delegate` is emitted). Also assert
the stream-level `stream` path still delegates. (Reuses the existing fake-registry pattern in that file.)

### Scope Boundary — DO NOT implement (owned by other tasks)

- **Factory wiring** of the session `TransitionCoordinator` (construct it, pass it to the proxy ctor, call
  `setActiveProxy(proxy)` on construct + `setActiveProxy(undefined)` on drain, register the
  `ShortcutManager`) → **factory integration task** (deferred; `src/index.ts` does not yet build this
  pipeline — confirmed by the P1.M8.T1.S1 Scope Boundary). This task implements + tests the LOGIC via DI;
  the `_coordinator?` optional param + `_terminate`'s `setActiveProxy(undefined)` already exist (P1.M7.T3.S1).
- **`src/shortcut/index.ts`** → DO NOT EDIT (parallel telemetry task owns it; (c) is already correct there).
- **FM-005…FM-015 provider/network failure modes** → P1.M8.T2.S2 (this task is shortcut-TIMING only).
- **Telemetry for pending-stop** (e.g. a `PendingStopsRecorded` counter) → not required by the contract;
  the telemetry module lands in P1.M8.T1.S1. Diagnostics traces (`pending-stop-recorded`,
  `proxy.pending-stop.triggered`, `proxy.splice.reasoning-forwarded`) provide observability instead.
- **Any change to `types.ts`, `config/`, `diagnostics/`, `buffer/`, `request/`, `controller.ts`** → none.

### Success Criteria

- [ ] (a) `requestStop()` returns `false` for no-proxy and every non-Reasoning active state; no throw.
- [ ] (b) A press during `Delegating` records a pending stop (`requestStop()` still returns `false`); the
      first reasoning event auto-triggers the transition; the first text event discards it; `setActiveProxy`
      resets it; auto-trigger is a safe no-op when no coordinator is wired.
- [ ] (c) Repeat/held presses after the transition begins are discarded (first-press-wins); exactly one
      `triggerStop` / one replacement per response.
- [ ] (d) `config.enabled===false` → direct delegation, zero `StreamProxy` allocation.
- [ ] (e) Replacement reasoning events are FORWARDED downstream (EC-017); exactly one transition; no
      recursive interruption; single `start` + single terminal preserved.
- [ ] `npx bun run typecheck` → 0; `npx bun run build` → exit 0; `npx bun test` → all green.

---

## All Needed Context

### Context Completeness Check

_Validated: "If someone knew nothing about this codebase, would they have everything needed?"_ → YES. The
exact coordinator method bodies (record/consume/clear/reset + the `isDelegating()` interface member), the
exact `trackEvent` insertion points (after the `Delegating→Reasoning` transition; the new text-clear block),
the exact `_emit` EC-017 fix (delete the silent-skip return, add the forward trace), the verbatim test
helpers to reuse (`makeReplacementUpstream`, `makeCaptureDiag`, `waitFor`, `makeFakeProxy`), the precise
assertions per case, and the verified build/test commands are all reproduced above and in `research/notes.md`.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- url: (in-repo) PRD.md "EC-002 — Shortcut During Network Stall" (Appendix B)
  why: The exact EC-002 contract — record the stop; first reasoning event triggers; discard if first event is text.
  critical: trigger happens on the FIRST reasoning event; discard on first answer text (EC-003/004).

- url: (in-repo) PRD.md "EC-017 — Replacement Request Returns Reasoning Anyway" (Appendix B)
  why: Ground truth for (e): "forward them rather than recursively attempting another interruption."
  critical: FORWARD (the current silent-skip is WRONG). One transition per response; recursion out of scope.

- url: (in-repo) PRD.md "EC-001/EC-005/EC-006/EC-009/EC-010" (Appendix B) + "FM-001..FM-004" (§42)
  why: The ignore / first-wins contracts this task locks in.
  critical: EC-001 ignore; EC-005/006 ignore (outside Reasoning); EC-009/010 first-press-wins.

- url: (in-repo) PRD.md §22.5 "Shortcut Availability" + §24.3 (Stop Signal idempotency)
  why: canInterrupt()==true ONLY in Reasoning; first-press-wins is FSM-driven (no coordinator counter).
  critical: do NOT add dedup state to the coordinator — the FSM already enforces first-wins.

- file: src/state/coordinator.ts
  why: The MODIFY target for (b). Holds activeProxy + requestStop/isReasoning/alreadyInterrupting.
  pattern: pure delegate; never-throws requestStop (try/catch around triggerStop); structural ActiveProxy.
  gotcha: requestStop's !canInterrupt branch is where pending-stop recording goes; keep the existing traces
          (no-active-proxy / not-reasoning / proxy-fault / accepted) and ADD the pending-stop-recorded reason.

- file: src/provider/proxy.ts
  why: MODIFY target for (b) consume/clear + (e) forward. trackEvent drives Delegating→Reasoning; _emit
        filters the replacement stream.
  pattern: trackEvent is wrapped in try/catch (never breaks forwarding — ADR-005/§19.7); _emit branches on
           _authority ("forwarding"|"splicing"); pending stop is read via this._coordinator?. (optional).
  gotcha: replacement events go through _emit ONLY (never trackEvent) → forwarding them cannot drive the FSM
          → no recursive interruption (this is the structural safety for EC-017). The proxy's _coordinator is
          UNDEFINED in production until the factory wires it — test via DI (last ctor arg).

- file: src/state/controller.ts
  why: The FSM (ALLOWED_TRANSITIONS). canInterrupt()===(state==="Reasoning"); getState() exposed.
  pattern: fail()/transition() never leave state inconsistent; Delegating is reachable only via Idle→Delegating.
  gotcha: §16 has NO normal Reasoning→Completed exit — normal completion leaves the FSM in Reasoning
          (accepted; reconciled once the interruption flow is the active path).

- file: src/provider/decorator.ts
  why: (d) EC-016 source. wrapperStreamSimple: eligible = config.enabled && model.reasoning && supportedProviders.
  pattern: !eligible → originalStreamSimple(...) direct (no proxy). eligible → new StreamProxy(...).
  gotcha: the decorator does NOT pass a coordinator today (factory wiring deferred) — do not add one here.

- file: tests/transition-coordinator.test.ts
  why: MODIFY target + the test CONVENTION (makeCaptureDiag, makeFakeProxy satisfying ActiveProxy).
  pattern: fake ActiveProxy with mutable flags emulating the FSM (triggerStop flips canInterrupt→false).
  gotcha: makeFakeProxy MUST gain an isDelegating() member (default false) or it no longer satisfies ActiveProxy.

- file: tests/stream-proxy-filtering.test.ts
  why: MODIFY target (EC-017) + the source of makeReplacementUpstream/makeCaptureDiag/waitFor/ev/makeModel.
  pattern: two-phase upstream mock (primary then replacement queues); concurrent consumer drains proxy.output.
  gotcha: the EC-017 case currently asserts SUPPRESSION — it MUST be rewritten to assert FORWARDING.

- file: tests/stream-proxy-replacement.test.ts
  why: Reference for the end-to-end replacement harness used by the new pending-stop test.
  pattern: inject controller + buffer + coordinator into the StreamProxy ctor; waitFor state predicates.
```

### Current Codebase tree

```bash
src/
  config/index.ts          # Config (enabled, supportedProviders, telemetryEnabled) — READ for (d)
  diagnostics/index.ts     # Diagnostics interface (info/warn/trace/...) — the trace sink
  index.ts                 # factory — NOT wiring coordinator/shortcut yet (DO NOT EDIT)
  provider/
    decorator.ts           # ProviderDecorator — (d) EC-016 gate already here (test only)
    proxy.ts               # StreamProxy — MODIFY (b) consume/clear + (e) forward; ADD isDelegating()
  request/builder.ts       # RequestBuilder (P1.M6) — unchanged
  shortcut/index.ts        # ShortcutManager — DO NOT EDIT (parallel task; (c) already correct)
  state/
    controller.ts          # TransitionController FSM — READ (canInterrupt/getState); unchanged
    coordinator.ts         # TransitionCoordinator — MODIFY (b) pending stop + isDelegating() interface
  buffer/index.ts          # ReasoningBuffer — unchanged
  types.ts                 # event/state type guards (isTextEvent/isThinkingEvent/isTerminalEvent) — unchanged
tests/
  transition-coordinator.test.ts   # MODIFY — pending-stop unit cases + isDelegating() on fake
  stream-proxy-filtering.test.ts   # MODIFY — EC-017 forward (was suppress)
  stream-proxy-pending-stop.test.ts # CREATE — end-to-end pending stop + (a)/(c) lock-ins
  provider-decorator.test.ts       # MODIFY — EC-016 lock-in
  (every other *.test.ts)          # unchanged
```

### Desired Codebase tree with files to be added/modified

```bash
src/state/coordinator.ts              # MODIFY — pendingStop + consumePendingStop/clearPendingStop +
                                      #   isDelegating() on ActiveProxy + record in requestStop + reset in setActiveProxy
src/provider/proxy.ts                 # MODIFY — isDelegating(); trackEvent consume+trigger / clear-on-text;
                                      #   _emit forward replacement reasoning (EC-017)
tests/transition-coordinator.test.ts  # MODIFY — isDelegating() on fake + EC-002 record/consume/clear/reset cases
tests/stream-proxy-filtering.test.ts  # MODIFY — EC-017 case → assert FORWARD (was suppress)
tests/stream-proxy-pending-stop.test.ts # CREATE — end-to-end EC-002 trigger + clear-on-text + no-coordinator no-op + EC-005/006
tests/provider-decorator.test.ts      # MODIFY — EC-016 (enabled:false → delegate, no proxy)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: the proxy's `_coordinator?` is OPTIONAL and UNDEFINED in production (the decorator does not pass
// one; factory wiring is deferred). EVERY pending-stop access MUST be `this._coordinator?.…` (optional chain)
// so the no-coordinator case is a structural no-op. Test the feature via DI (inject a real coordinator as
// the proxy's LAST ctor arg), NOT by editing the decorator/factory.

// CRITICAL: replacement-stream events reach `_emit` ONLY — they NEVER run `trackEvent`. This is the
// structural guarantee that forwarding replacement reasoning (EC-017) CANNOT recursively interrupt: the FSM
// is never driven on the replacement stream, and triggerStop() is gated on canInterrupt() (false once the
// first transition left Reasoning). Do NOT route replacement events through trackEvent.

// CRITICAL: pending-stop consume MUST be inside the step-2 block that is guarded on state==="Delegating",
// AFTER transitionIfLegal("Reasoning") (state is then Reasoning → triggerStop() is legal). Putting it
// unconditionally per-event still works (consume is self-clearing/idempotent) but is less precise; gate it.

// GOTCHA: §16 has NO normal Reasoning→Completed exit. A non-interrupted stream leaves the FSM in Reasoning.
// The pending-stop clear-on-text (EC-003/004) handles the "answered without reasoning" case; do NOT try to
// add a Reasoning→Completed edge.

// GOTCHA: the EC-017 fix REMOVES a silent-skip that an existing test codifies
// (stream-proxy-filtering.test.ts "replacement thinking_* suppressed"). That test MUST be rewritten to
// assert FORWARD or the suite will fail. Do not leave the old assertion in place.

// GOTCHA: ShortcutManager.handlePress checks alreadyInterrupting() BEFORE requestStop() — so by the time
// requestStop() runs, interrupting states are already excluded. The pending-stop record branch therefore
// only sees Idle/Delegating/terminal among non-Reasoning states; isDelegating() cleanly selects Delegating.

// GOTCHA: do NOT add dedup/counter state to the coordinator for (c). First-press-wins is FSM-driven
// (canInterrupt()==false after the first triggerStop). Adding a local latch would duplicate that and risk
// drift. (c) needs TESTS only.
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// No new data models. The only new mutable state is one boolean on TransitionCoordinator:
//   private pendingStop = false;
// The ActiveProxy structural interface gains one pure-read method:
//   isDelegating(): boolean;   // proxy impl: this._controller.getState() === "Delegating"
// New coordinator public methods: consumePendingStop(): boolean; clearPendingStop(): void.
// No changes to types.ts / config / event shapes.
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/state/coordinator.ts — the pending-stop authority (EC-002)
  - ADD: `private pendingStop = false;` (the only new field).
  - ADD: `isDelegating(): boolean;` to the `ActiveProxy` interface (pure-read contract member).
  - MODIFY: `requestStop()` — in the existing `!proxy.canInterrupt()` branch, BEFORE `return false`, add
    `if (proxy.isDelegating()) { this.pendingStop = true; trace(...{reason:"pending-stop-recorded"}) }`
    else `trace(...{reason:"not-reasoning"})`. Keep `return false` (contract (a)).
  - MODIFY: `setActiveProxy()` — set `this.pendingStop = false;` on EVERY call (fresh request + teardown).
  - ADD: `consumePendingStop(): boolean` (read+clear) and `clearPendingStop(): void` (clear).
  - PRESERVE: isReasoning()/alreadyInterrupting() (pure delegates); the never-crash try/catch in requestStop;
    all existing traces (no-active-proxy/not-reasoning/proxy-fault/accepted/set-active/clear-active).
  - NAMING: `pendingStop` field, `consumePendingStop`/`clearPendingStop`/`isDelegating` methods (camelCase).

Task 2: MODIFY src/provider/proxy.ts — consume/clear pending stop (b) + forward replacement reasoning (e)
  - ADD: `isDelegating(): boolean { return this._controller.getState() === "Delegating"; }` (beside isReasoning).
  - MODIFY: `trackEvent()` — inside the step-2 `Delegating→Reasoning` block, after `transitionIfLegal("Reasoning")`,
    add `if (this._coordinator?.consumePendingStop()) { this.diagnostics.trace("proxy.pending-stop.triggered", {}); this.triggerStop(); }`.
  - MODIFY: `trackEvent()` — add `if (isTextEvent(event) && this._controller.getState() === "Delegating") this._coordinator?.clearPendingStop();`.
    (`isTextEvent` is already imported from ../types.)
  - MODIFY: `_emit()` splicing branch — DELETE the `if (isThinkingEvent(event)) { return; }` silent-skip;
    REPLACE with a forward-fallthrough that emits `this.diagnostics.trace("proxy.splice.reasoning-forwarded", {})`
    and continues to `this._output.push(event)`.
  - UPDATE: the `_emit` JSDoc lines that say "thinking_* → SKIP silently" → "thinking_* → FORWARD (EC-017)".
  - PRESERVE: forwarding-phase behavior; start-suppression; FM-014/FM-015 duplicate-terminal dedup; the
    try/catch in trackEvent (never breaks forwarding); INV-002/INV-003.

Task 3: MODIFY tests/transition-coordinator.test.ts
  - ADD `isDelegating()` to makeFakeProxy (override `delegating?: boolean`, default false; method `() => delegating`).
  - ADD cases: EC-002 record (Delegating → requestStop false + pending-stop-recorded trace + consume true once);
    Idle/terminal ignore (not-reasoning, consume false); clearPendingStop discards; setActiveProxy resets
    (both undefined and proxy2); extend the privacy allow-list assertion (keys still accepted/reason/error only).
  - PRESERVE: every existing describe/test (EC-001, delegate traces, happy path, first-press-wins, never-crash).

Task 4: MODIFY tests/stream-proxy-filtering.test.ts — EC-017 = FORWARD
  - REWRITE the "replacement thinking_* suppressed (EC-017)" case → "replacement thinking_* forwarded (EC-017)".
    Assert BOTH primary AND replacement thinking events appear (length 4), a `proxy.splice.reasoning-forwarded`
    trace is emitted, `mock.calls.length === 1` (no recursive interruption), one start + one terminal.
  - PRESERVE: every other case in this file unchanged.

Task 5: CREATE tests/stream-proxy-pending-stop.test.ts
  - REUSE makeReplacementUpstream/makeCaptureDiag/waitFor/ev/makeModel (copy from stream-proxy-filtering.test.ts).
  - Cases: (1) EC-002 auto-trigger on first reasoning (inject coordinator, setActiveProxy, press during
    Delegating returns false + records, push thinking → replacement launched with NO manual triggerStop,
    pending-stop.triggered trace, completes with one start+terminal); (2) EC-002 then clear-on-text (press,
    push text → no replacement, consume false, completes); (3) no-coordinator no-op (omit coordinator arg →
    push reasoning → reasons normally, mock.calls.length===0); (4) EC-005/006 proxy-level ignore lock-in.

Task 6: MODIFY tests/provider-decorator.test.ts — EC-016 lock-in
  - ADD case: Config enabled:false → after initialize(), invoke registered streamSimple wrapper for a
    reasoning z.ai model → assert originalStreamSimple called directly (spy) AND no `provider.streamSimple.proxy`
    trace (only `provider.streamSimple.delegate`) → zero StreamProxy allocation. Reuse the existing fake registry.
  - PRESERVE: every existing case in this file.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: pending-stop record inside requestStop (coordinator) — keeps return value false (contract a).
if (!proxy.canInterrupt()) {
  if (proxy.isDelegating()) {
    this.pendingStop = true;
    this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "pending-stop-recorded" });
  } else {
    this.diagnostics.trace("coordinator.request-stop", { accepted: false, reason: "not-reasoning" });
  }
  return false;
}

// PATTERN: consume-and-trigger on first reasoning (proxy trackEvent) — guarded on the entering event.
if ((event.type === "thinking_start" || event.type === "thinking_delta") &&
    this._controller.getState() === "Delegating") {
  this.transitionIfLegal("Reasoning");
  if (this._coordinator?.consumePendingStop()) {   // true at most once (self-clearing)
    this.diagnostics.trace("proxy.pending-stop.triggered", {});
    this.triggerStop();                              // legal: state is now Reasoning
  }
}

// PATTERN: EC-017 forward (proxy _emit, splicing phase) — delete the silent skip; fall through to push.
if (isThinkingEvent(event)) {
  this.diagnostics.trace("proxy.splice.reasoning-forwarded", {});
  // fall through → this._output.push(event)
}

// PATTERN: fake ActiveProxy must grow isDelegating() (transition-coordinator.test.ts makeFakeProxy).
const proxy: ActiveProxy = {
  isReasoning: () => reasoning,
  canInterrupt: () => canInterruptFlag,
  isInterrupting: () => interrupting,
  isDelegating: () => delegating,   // NEW
  triggerStop: () => { /* …unchanged… */ },
};
```

### Integration Points

```yaml
COORDINATOR (session singleton — wired by the DEFERRED factory task):
  - NEW public methods consumed by the proxy: consumePendingStop(), clearPendingStop().
  - NEW ActiveProxy member the coordinator reads: proxy.isDelegating().
  - setActiveProxy() now ALSO resets pendingStop (idempotent with the existing activeProxy set).
PROXY (per-request):
  - trackEvent: consumes pending stop on first reasoning; clears on first text (Delegating).
  - _emit: forwards replacement reasoning (EC-017).
  - isDelegating(): new public read satisfying ActiveProxy.
SHORTCUT (UNCHANGED — parallel task owns the file):
  - alreadyInterrupting() first-wins + requestStop() gate already correct (c).
DECORATOR (UNCHANGED — (d) already implemented):
  - config.enabled gate verified by a new test.
FACTORY (DEFERRED):
  - LATER: src/index.ts constructs the coordinator, passes it to the proxy, calls setActiveProxy on
    construct/drain, registers the shortcut. Until then the feature is exercised via DI in tests.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# After editing coordinator.ts + proxy.ts — fix before proceeding.
npx bun run typecheck          # tsc --noEmit — zero diagnostics
# (Most likely first-run error: makeFakeProxy in transition-coordinator.test.ts missing isDelegating()
#  after ActiveProxy grew the member — Task 3 adds it. Fix and re-run.)
npx bun run build              # tsc — emits dist/ with exit 0
# Expected: Zero errors. TypeScript + Bun (no ruff/mypy/formatter).
```

### Level 2: Unit Tests (Component Validation)

```bash
# Coordinator pending-stop unit behavior.
npx bun test tests/transition-coordinator.test.ts

# EC-017 forwarding (rewritten case) + every other filtering invariant unchanged.
npx bun test tests/stream-proxy-filtering.test.ts

# New end-to-end pending-stop + lock-ins.
npx bun test tests/stream-proxy-pending-stop.test.ts

# EC-016 decorator gate.
npx bun test tests/provider-decorator.test.ts

# Full suite — confirm NO regression (the proxy/coordinator changes must not break any other suite,
# incl. stream-proxy-lifecycle / -replacement / -abort / -race / -detection / shortcut-manager / etc.).
npx bun test
# Expected: ALL green. If failing, debug root cause — common: a stale EC-017 suppress assertion left in the
# filtering test; a fake ActiveProxy missing isDelegating(); a pending-stop consume placed outside the
# Delegating guard so it never fires.
```

### Level 3: Integration Testing (System Validation)

```bash
# Build + whole-suite smoke (this is a Pi extension loaded by the host — no running server).
npx bun run build && npx bun test

# Confirm no import cycle was introduced (coordinator ↔ proxy are type-only on the ActiveProxy seam):
npx bun -e "import('./src/state/coordinator.js').then(m=>console.log(Object.keys(m)))" \
  && npx bun -e "import('./src/provider/proxy.js').then(m=>console.log(Object.keys(m)))"
# Expected: both resolve; coordinator still exports TransitionCoordinator + ActiveProxy; proxy exports StreamProxy.

# Expected: build exit 0; all tests green; both modules import cleanly.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# EC-017 recursion-safety manual confirm (run the rewritten filtering case in isolation + eyeball):
npx bun test tests/stream-proxy-filtering.test.ts -t "EC-017"
# Expected: replacement thinking forwarded; exactly ONE streamSimple replacement call (mock.calls.length===1)
# → proves no recursive interruption.

# Pending-stop timing confirm:
npx bun test tests/stream-proxy-pending-stop.test.ts -t "EC-002"
# Expected: pressing during Delegating returns false (no immediate abort) yet the first reasoning event
# auto-launches the replacement — no manual triggerStop in the test body.

# Edge-case matrix lock-in (run all four modified/new suites together):
npx bun test tests/transition-coordinator.test.ts tests/stream-proxy-filtering.test.ts \
           tests/stream-proxy-pending-stop.test.ts tests/provider-decorator.test.ts
# Expected: all green — (a)/(b)/(c)/(d)/(e) all covered.
```

---

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully.
- [ ] `npx bun run typecheck` → 0 diagnostics.
- [ ] `npx bun run build` → exit 0.
- [ ] `npx bun test` → ALL suites green (modified + new + every pre-existing unchanged).

### Feature Validation

- [ ] (a) `requestStop()` returns `false` for no-proxy + every non-Reasoning state; never throws.
- [ ] (b) Press during `Delegating` records a pending stop (returns false); first reasoning event
      auto-triggers the transition (replacement launched with no manual triggerStop); first text event
      discards it; `setActiveProxy` resets it; safe no-op when no coordinator is wired.
- [ ] (c) Repeat/held presses after the transition begins are discarded — exactly one triggerStop / one
      replacement per response.
- [ ] (d) `config.enabled===false` → direct delegation, zero `StreamProxy` allocation.
- [ ] (e) Replacement reasoning events are FORWARDED (EC-017); exactly one transition; no recursive
      interruption; single `start` + single terminal preserved.
- [ ] Error/timing cases handled gracefully — no crash, no broken/half stream, no double terminal.

### Code Quality Validation

- [ ] Follows existing patterns (DI, `private readonly`, structural `ActiveProxy`, never-throws, Mode-A JSDoc,
      privacy `{}`-only traces).
- [ ] File placement matches the desired tree; no edits to `shortcut/index.ts`, `index.ts`, `decorator.ts`,
      `types.ts`, `config/`, `controller.ts`.
- [ ] Anti-patterns avoided (see below): no coordinator dedup state; no recursive-interruption path; no
      dropped replacement reasoning; no decorator/factory wiring in this task.
- [ ] No new import cycle (coordinator↔proxy remain type-only on `ActiveProxy`).

### Documentation & Deployment

- [ ] JSDoc updated: `ActiveProxy.isDelegating()`, the pending-stop field/methods, the `_emit` EC-017 line.
- [ ] The deferred factory-wiring boundary is documented (Scope Boundary) so the next task is unblocked.
- [ ] New traces (`pending-stop-recorded`, `proxy.pending-stop.triggered`, `proxy.splice.reasoning-forwarded`)
      are privacy-safe (`{}` only) and named consistently with existing `coordinator.*`/`proxy.*` events.

---

## Anti-Patterns to Avoid

- ❌ Don't add dedup/counter state to the coordinator for (c) — first-press-wins is FSM-driven
  (`canInterrupt()==false` after the first `triggerStop`). (c) needs TESTS only.
- ❌ Don't route replacement events through `trackEvent` — they go through `_emit` only; that separation is
  the structural guarantee that EC-017 forwarding cannot recursively interrupt.
- ❌ Don't leave the old "replacement thinking_* suppressed (EC-017)" assertion in place — it tests the WRONG
  (PRD-violating) behavior; rewrite it to assert FORWARD.
- ❌ Don't record a pending stop during the Idle window — `isDelegating()` selects the Delegating network-stall
  window; Idle maps to EC-001 ignore.
- ❌ Don't wire the coordinator into the decorator/factory here — that is the deferred factory-integration
  task; this task ships + tests the LOGIC via DI.
- ❌ Don't edit `src/shortcut/index.ts` — the parallel telemetry task owns it and (c) is already correct.
- ❌ Don't drop/skip the consume-on-first-reasoning guard (state must be `Delegating` then `Reasoning` for
  `triggerStop()` to be legal) — an ungated consume could fire after the transition already began.
- ❌ Don't let a telemetry/pending-stop fault escape — coordinator methods stay never-throwing; traces are
  best-effort observability, never on the critical correctness path.

---

## Confidence Score

**9/10** — one-pass implementation success likelihood. The deliverable is small and precisely scoped: one
new boolean + three small methods on the coordinator, two surgical insertions + one branch deletion in the
proxy, and six well-specified test cases reusing the existing async harness. The only non-obvious decision
(EC-017 forward vs suppress) is resolved by the PRD ground truth (forward) and explicitly flags the existing
test that must change. The parallel-task boundary is clean (zero file overlap). Residual 1-point risk: the
pending-stop consume ordering relative to the `Delegating→Reasoning` transition must be exact (documented
with the precise insertion point and a guard), and the end-to-end async test must drain `proxy.output`
concurrently (documented via the verbatim harness reuse).
