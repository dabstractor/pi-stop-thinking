# Research Notes — P1.M4.T2.S1 (StreamProxy reasoning event tracking)

> Working notes for the PRP author. The load-bearing findings are folded into `../PRP.md`; this file
> records the reasoning behind the non-obvious design decisions so a reviewer (or re-planner) can audit
> them.

## 1. Inputs are DONE & immutable (verified by reading the landed source)

| Dependency | File | Status | What the proxy needs from it |
|---|---|---|---|
| StreamProxy (forward-only) | `src/provider/proxy.ts` | DONE (P1.M2.T2.S1) | The `run()` loop + ctor to extend |
| TransitionController (FSM) | `src/state/controller.ts` | DONE (P1.M3.T1.S1) | `transition/getState/fail/reset` + exported `ALLOWED_TRANSITIONS` |
| ReasoningBuffer | `src/buffer/index.ts` | DONE (P1.M4.T1.S1) | `append(delta)` (throws when frozen; never frozen in this phase) |
| Event vocabulary | `src/types.ts` | DONE (P1.M2.T1.S1) | `TransitionState`, type-narrowed `AssistantMessageEvent` |
| Config | `src/config/index.ts` | DONE (P1.M1.T2.S1) | `DEFAULT_CONFIG.maximumReasoningBufferBytes` (8 MiB) |
| Diagnostics | `src/diagnostics/index.ts` | DONE (P1.M1.T3.S1) | `warn/debug/trace(event, fields?)` |

`thinking_delta` carries the reasoning text on its **`delta`** field (the work item's "delta.text" is
loose phrasing — the actual field is `delta`). Verified against `tests/golden/fixtures.ts`:
`{ type: "thinking_delta", contentIndex: 0, delta: "Let me think", partial }`.

## 2. CRITICAL FINDING — the FSM (PRD §16) has NO normal-completion exit from `Reasoning`

The transition table (`src/state/controller.ts` `ALLOWED_TRANSITIONS`, verified identical to PRD §16):

```
Reasoning → { StopRequested, Failed }   // ONLY exits are the shortcut (interruption) or fatal error
```

There is **no `Reasoning → Completed`, `Reasoning → Answering`, or `Reasoning → Idle`**. The entire FSM
models the **interruption lifecycle** (`Idle→Delegating→Reasoning→StopRequested→Aborting→Capturing→
Restarting→Splicing→Answering→Completed→Idle`). In a NORMAL (non-interrupted) stream, reasoning ends
(thinking_end / first answer token / done) but the FSM has nowhere legal to go.

This directly conflicts with PRD §22.4 ("Leave Reasoning: thinking_end OR first answer token OR provider
completion") + §22.5 ("Shortcut active only while State == Reasoning"). **§16 and §22 are inconsistent for
the normal flow.** Since P1.M3.T1.S1 is DONE and marked DO NOT MODIFY, the proxy CANNOT:
- call `controller.transition("Completed")` on a normal `done` (would THROW — illegal from Reasoning), nor
- call `controller.reset()` from Reasoning (reset is legal only from Completed/Failed — would THROW).

**Resolution chosen (the only one that (a) doesn't throw, (b) doesn't modify the FSM, (c) doesn't abuse
`fail()` for normal completion, (d) doesn't emit spurious `transition.illegal` warns):**

- Drive transitions with a **`transitionIfLegal(target)` helper** that consults the exported
  `ALLOWED_TRANSITIONS` and SKIPS (returns false) when the target is unreachable from the current state.
  This never throws and never triggers the controller's `transition.illegal` warn path.
- `error` terminal → `controller.fail("upstream-error")` (Any→Failed, always legal, never throws) →
  `transitionIfLegal("Idle")` (Failed→Idle). Clean reset. ✓
- `done` terminal → `transitionIfLegal("Completed")` (legal ONLY from Answering, i.e. the interrupted flow
  of P1.M5–P1.M7) → then `transitionIfLegal("Idle")`. In the NORMAL flow (controller in Reasoning/
  Delegating) the Completed attempt is a guarded no-op; the per-request controller is left in its legal
  state and discarded (it is per-request — no leak).
- `thinking_end` / first `text_start` / `toolcall_start` (the §22.4 "leave reasoning" events) perform **NO
  transition** in this phase (no legal target exists). Documented as a known gap; acceptable in P1.M4
  because no shortcut/coordinator is wired yet (shortcut availability is moot).

The work item's literal "On done → Completed then Idle" is therefore implemented as a **guarded** attempt:
it fully applies in the interrupted flow (P1.M5+) and is a safe no-op in the normal flow. The item's
MOCKING verification goals ("controller REACHES Reasoning" + "buffer accumulates deltas") are both
satisfied without needing the normal-flow Completed transition.

## 3. DESIGN DECISION — optional DI with internal defaults (zero churn to existing tests)

StreamProxy construction sites (6 total, `grep`-verified):
- `src/provider/decorator.ts:158` (production)
- `tests/stream-proxy.test.ts:45,142,168,187` (forwarding tests)
- `tests/golden/replay.ts:112` (golden replay harness — a critical regression guard)

If controller+buffer were REQUIRED ctor params, ALL 6 sites (+ the replay.ts doc comment) must change,
risking the golden baseline. Instead: **optional ctor params with internal defaults**, so:

- `decorator.ts`: **UNCHANGED** (proxy self-creates controller + buffer — matches the existing JSDocs:
  controller.ts says "constructed by StreamProxy (P1.M4)"; buffer/index.ts says "StreamProxy (P1.M4.T2 —
  owns the per-request instance)").
- Existing forwarding tests + golden replay: **UNCHANGED**. They use defaults → detection is ACTIVE on
  them too → they now ALSO prove **detection is observationally transparent** (golden replay still
  byte-for-byte identical; forwarding tests still pass). FREE extra coverage, zero regression risk.
- New detection tests: **inject** their own controller + buffer, replay thinking sequences, then assert
  `controller.getState() === "Reasoning"` and `buffer.snapshot()` directly.

Default buffer uses `DEFAULT_CONFIG.maximumReasoningBufferBytes` (8 MiB) — the frozen config constant (no
magic number, no proxy→config behavior coupling; config is a leaf module → no import cycle). This default
is ALSO exactly what production wants, so the decorator needs no change.

## 4. WHY `transitionIfLegal` (not try/catch on `controller.transition`)

`controller.transition()` logs `warn("transition.illegal", {from,to})` THEN throws on an illegal attempt.
On EVERY normal stream's `done`, `Reasoning→Completed` is illegal → a try/catch would emit a spurious
`transition.illegal` warn per normal completion (wrong: normal completion is not an error). Pre-checking
`ALLOWED_TRANSITIONS` avoids both the throw and the spurious warn. (`ALLOWED_TRANSITIONS` is already
`export const` from `src/state/controller.ts`.)

## 5. Forwarding integrity guarantee (ADR-005 / §19.7 observational equivalence)

The detection logic is wrapped in `trackEvent(event)` called BEFORE `this._output.push(event)` in `run()`.
`trackEvent`:
- only reads `event` (never mutates it),
- drives guarded transitions + buffer appends (side-effects only),
- is itself wrapped in a try/catch that logs `proxy.tracking-error` (event.type only — never content,
  Appendix H) and swallows — so a tracking bug can NEVER break forwarding or reach `run()`'s
  terminal-synthesizing catch (which WOULD alter output).

Result: `run()`'s forwarding path is structurally unchanged (`trackEvent(e); push(e)`); the existing
forwarding + golden tests stay green and now double as transparency proofs.

## 6. Public surface added to StreamProxy (minimal + forward-compatible)

- `isReasoning(): boolean` → `controller.getState() === "Reasoning"` (PRD §22.5; the query P1.M4.T4's
  TransitionCoordinator will delegate to).
- `get controller()` / `get buffer()` (forward-compat accessors so P1.M4.T4 / P1.M5 abort / P1.M6
  RequestBuilder can reach the per-request collaborators through the proxy).
- ctor gains optional `controller?` + `buffer?` (defaults create real instances).

## 7. Test plan (new `tests/stream-proxy-detection.test.ts`)

- reaches Reasoning on `thinking_start`; reaches Reasoning on first `thinking_delta` (no thinking_start).
- buffer accumulates `thinking_delta.delta` in order; getByteSize === Σ lengths; empty for no-reasoning.
- forwarding byte-for-byte unchanged WITH detection active (transparency proof).
- no-reasoning stream: Idle→Delegating only, buffer empty.
- `error` → controller Failed→Idle (clean reset), no throw.
- normal `done`: NO throw, NO `transition.illegal` warn, controller left in Reasoning (documented §16 gap).
- reasoning enter is idempotent (guarded on Delegating; many thinking events enter once).
- injected controller+buffer are the ones used (`proxy.controller === injected`, buffer accumulates).
