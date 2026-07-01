# PRP — P1.M7.T2.S1: Event filtering — suppress primary terminal, forward replacement events (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M7.T2.S1 (Phase 6 Stream Splicing, 2 pts) — after the replacement stream is launched and
> authority transfers to it (produced by **P1.M7.T1.S1**), the `StreamProxy`'s forwarding applies the **PRD §18
> Event Forwarding Rules** so the downstream consumer observes **exactly ONE `start`** and **exactly ONE
> terminal** (`done`/`error`) from the **combined** primary+replacement streams. The replacement's duplicate
> `start` is suppressed (already emitted), all replacement `thinking_*` are skipped (never emit after restart),
> `text_*`/`toolcall_*` are forwarded, the first replacement terminal is forwarded (and completes output), and
> any further terminal is discarded (FM-014 duplicate / FM-015 after-transfer).
> **Work-item contract (verbatim logic)**: Track `messageStartEmitted` + `messageEndEmitted` booleans. In the
> forwarding logic: if authority === 'primary' (== `_authority === "forwarding"`) → forward all + set
> `messageStartEmitted` on `start`; if authority === 'replacement' (== `"splicing"`) → SKIP `start`, SKIP all
> `thinking_*`, FORWARD `text_*`/`toolcall_*`, on `done`/`error` → forward + set `messageEndEmitted` + complete
> output. Any terminal after authority transfer → discard silently + trace (FM-015); duplicate terminal →
> suppress (FM-014). **OUTPUT**: the proxy produces exactly one `start` and one terminal from the combined
> streams. Consumed by **P1.M7.T3** (end-to-end completion lifecycle). **MOCKING**: full interruption cycle —
> primary emits `start` + thinking; `triggerStop`; replacement emits `start` (suppressed) + text + `done`
> (forwarded); verify exactly one `start` and one `done`.
> **Vocabulary reconciliation**: the contract's `authority === 'primary'/'replacement'` maps to the
> P1.M7.T1.S1-implemented `ProxyPhase` field (`src/types.ts`): `'primary' ⟺ "forwarding"`,
> `'replacement' ⟺ "splicing"`. Reuse the existing `_authority` field — do NOT introduce a new union.

---

## Goal

**Feature Goal**: Centralize the `StreamProxy`'s downstream forwarding behind a single filter method
(`_emit`) that enforces the PRD §18 Event Forwarding Rules across BOTH the primary and replacement phases, so
that — regardless of how many upstream provider streams are spliced internally — the downstream consumer (Pi)
sees **exactly one `start`** (INV-002) and **exactly one terminal** (INV-003), with the replacement's duplicate
`start` and all post-restart `thinking_*` suppressed and any duplicate/after-transfer terminal discarded with a
trace (FM-014 / FM-015).

**Deliverable** (ONE source file MODIFIED + ONE test file CREATED):
- `src/provider/proxy.ts` — **MODIFY**: add two private routing booleans (`_messageStartEmitted`,
  `_messageEndEmitted`); add the import of `isThinkingEvent` from `"../types"`; add the `_emit(event)` unified
  filter method; route the **primary** loop (`run()`) and the **replacement** loop (`_launchReplacement`) AND
  the replacement catch's synthesized terminal through `_emit` (each is a one-line swap of `this._output.push`
  → `this._emit`, with the authority flip kept BEFORE `_emit` in the replacement loop).
- `tests/stream-proxy-filtering.test.ts` — **NEW** `bun:test` suite using the two-phase upstream mock (primary
  thinking + abortable / replacement recording + abortable) that asserts: full interruption cycle emits
  exactly one `start` + one `done`; replacement `start` suppressed; replacement `thinking_*` suppressed
  (EC-017); duplicate terminal suppressed with a trace (FM-014); replacement `text_*`/`toolcall_*` forwarded;
  `output.result()` resolves to the forwarded `done.message`; privacy guard on `proxy.splice.*` traces.

**Success Definition**: From a clean checkout (after P1.M7.T1.S1 is merged), `npx bun run typecheck` → **0**
diagnostics; `npx bun run build` → exit 0; `npx bun test` → **ALL green** — the new `stream-proxy-filtering`
suite PLUS every pre-existing suite (incl. the P1.M7.T1.S1 replacement suite, the P1.M5 abort/race suites, the
detection/golden/forwarding regressions). The P1.M7.T1.S1 guarantees (replacement invoked with
`reasoning === undefined`, FSM `Capturing → Restarting → Splicing`, authority flip, startup timeout) are
unchanged; the downstream output now additionally satisfies INV-002/INV-003 across the splice.

---

## User Persona (if applicable)

**Target User**: Internal — none user-facing (event filtering is routing logic inside the `StreamProxy`). The
end user triggers it indirectly: they press `ctrl+.`, the reasoning stream is aborted + a thinking-disabled
replacement is launched, and THIS subtask ensures the spliced answer they see is clean — one start, the answer
text, one end — with no leaked duplicate start, no stray post-restart thinking, and no double terminal.

**Use Case**: After P1.M7.T1.S1 launches the replacement and flips `authority` to `"splicing"`, the replacement
stream re-emits its own `start` (every provider stream begins with one) and — per EC-017 — may even re-emit
`thinking_*`. Without filtering, Pi would observe two `start`s (confusing the agent runtime / violating INV-002)
and possibly reasoning text after the user explicitly stopped it. This subtask suppresses those so the splice is
observationally seamless.

**Pain Points Addressed**: Scattering the "which events to forward" decision across the primary loop, the
replacement loop, and the synthesized terminal makes INV-002/INV-003 easy to violate subtly (a second `start`
sneaks through; a duplicate `done` double-resolves; a stray `thinking_*` leaks). Centralizing it in one
filter method keyed on authority removes that class of bugs and makes the invariants testable.

---

## Why

- **It is the explicit PRD §18 / §39 / §13.2 contract.** §18 "After Restart" column: `message_start` →
  "Already emitted", `thinking_*` → "Never emit", `text_*` → "Forward", `message_end` → "Forward replacement".
  §13.2 Guarantee / INV-002 / INV-003: exactly one `start` and one terminal reach Pi. §39: "Forward replacement
  text; Suppress obsolete thinking; Suppress terminal completion; Forbidden: duplicate message_start/message_end".
- **The dedup invariant is non-trivial across two streams.** Both the primary and the replacement emit a
  `start` and a terminal; only one of each may reach Pi. The filter + the `messageStartEmitted`/
  `messageEndEmitted` flags (and the `EventStream.push` no-op-on-done behavior — see Context) make this
  deterministic regardless of provider quirks.
- **EC-017 ("replacement returns reasoning anyway") must be suppressed at the forward layer.** Even with
  `reasoning === undefined`, a provider may emit `thinking_*`; PRD §18 mandates "Never emit" after restart.
  The filter skips them unconditionally in the replacement phase.
- **FM-014 / FM-015 require a trace, not just a silent drop.** A duplicate or after-transfer terminal must be
  discarded AND logged for diagnostics — the `messageEndEmitted` flag exists precisely to emit that trace.
- **It is the producer gate for P1.M7.T3 (completion lifecycle).** T3 adds `Splicing → Answering → Completed →
  Idle`; it needs a clean single-terminal output to complete against. This subtask hands it a filter-enforced
  INV-002/INV-003 stream.

---

## What

### Source: MODIFY `src/provider/proxy.ts`

#### A. New import (append to the existing `import type { … } from "../types";` / guard import line)

The file already imports `isTerminalEvent` from `"../types"`. Add `isThinkingEvent` to the SAME import:

```typescript
import type { AssistantMessageEvent, TransitionState } from "../types";
import { isTerminalEvent, isThinkingEvent } from "../types";   // ◄◄ ADD isThinkingEvent
```

> `isThinkingEvent` narrows to `thinking_start | thinking_delta | thinking_end` (P1.M2.T1.S1). `start` has NO
> guard (§18: `start` matches no family) → check `event.type === "start"` directly in `_emit`. `text_*`/
> `toolcall_*` are forwarded implicitly (everything-not-start-not-thinking-not-terminal) so NO extra guard
> import is needed.

#### B. New instance state (append near the existing `_upstreamCompleted` boolean)

```typescript
/**
 * INV-002 (Appendix O): exactly one downstream `start` is forwarded, regardless of how many upstream
 * streams are spliced. Set by {@link _emit} the first time it forwards a `start` (always the PRIMARY's
 * start, in the "forwarding" phase). The REPLACEMENT's `start` is suppressed (PRD §18 "Already emitted").
 * Routing flag (NOT lifecycle state — see PRD Appendix F: the "no boolean lifecycle flags" rule applies to
 * the FSM `TransitionState`, not internal routing counters; the proxy already uses `_upstreamCompleted`).
 */
private _messageStartEmitted = false;

/**
 * INV-003 (Appendix O): exactly one downstream terminal (`done`/`error`) is forwarded, regardless of how
 * many upstream streams are spliced. Set by {@link _emit} the first time it forwards a terminal. Any
 * subsequent terminal is discarded with a `proxy.splice.duplicate-terminal` trace (PRD FM-014 duplicate
 * completion / FM-015 terminal after authority transfer — identical handling: discard + log).
 *
 * NOTE: `EventStream.push` ALREADY no-ops once a terminal has set `done=true`, so dedup is correct even
 * without this flag; the flag exists ONLY to emit the FM-014/FM-015 diagnostic trace.
 */
private _messageEndEmitted = false;
```

#### C. NEW private method — `_emit` (the unified forwarding filter)

Append near `trackEvent`. This is the single downstream chokepoint that owns INV-002/INV-003:

```typescript
/**
 * The unified downstream forwarding filter (PRD §18 Event Forwarding Rules / §39 Transition Event Rules).
 * Both {@link run}'s primary loop and {@link _launchReplacement}'s replacement loop (plus its catch's
 * synthesized terminal) forward through HERE, so the single-`start` (INV-002) and single-terminal (INV-003)
 * invariants hold across the spliced primary+replacement streams.
 *
 * Branches on {@link _authority} (the contract's `authority === 'primary'/'replacement'`, modeled as
 * `ProxyPhase`: `"forwarding"` == primary, `"splicing"` == replacement):
 *
 * PRIMARY (`"forwarding"`, PRD §18 "Before Stop"): forward EVERY event unchanged; on `start` set
 *   {@link _messageStartEmitted}; on a terminal set {@link _messageEndEmitted} (a duplicate terminal here is
 *   discarded with a trace — defensive, INV-003).
 *
 * REPLACEMENT (`"splicing"`, PRD §18 "After Restart"):
 *   - `start`            → SUPPRESS (already emitted — PRD §18); trace `proxy.splice.start-suppressed`.
 *   - `thinking_*`       → SKIP silently (never emit after restart — PRD §18; EC-017 stray reasoning).
 *   - `done`/`error`     → forward ONCE (set {@link _messageEndEmitted}); a duplicate/after-transfer terminal
 *                          is discarded with `proxy.splice.duplicate-terminal` (PRD FM-014 / FM-015).
 *   - `text_*`/`toolcall_*` → forward.
 *
 * COMPLETION: forwarding a terminal via `this._output.push(event)` ALREADY completes `output` and resolves
 * `output.result()` with `event.message` (done) / `event.error` (error) — see `EventStream` semantics. So NO
 * explicit `output.end()` is made (consistent with the primary path; the existing JSDoc forbids it as
 * "unnecessary and contrary to the exits-naturally contract"). The contract's "output.end(result)" is the
 * guarantee `push(terminal)` fulfills.
 *
 * This method NEVER calls {@link trackEvent} (trackEvent runs only in the primary loop, before `_emit`; the
 * reasoning buffer is FROZEN during the replacement phase). It never mutates/reorders/duplicates an event.
 *
 * PRIVACY (Appendix H): `proxy.splice.*` traces log `{}` only — never content/options/reasoning/prompt.
 */
private _emit(event: AssistantMessageEvent): void {
  if (this._authority === "forwarding") {
    // PRIMARY phase (PRD §18 "Before Stop") — forward all, track the start/terminal flags.
    if (event.type === "start") {
      this._messageStartEmitted = true; // the primary's start is THE downstream start (INV-002)
    }
    if (isTerminalEvent(event)) {
      if (this._messageEndEmitted) {
        this.diagnostics.trace("proxy.splice.duplicate-terminal", {}); // defensive dedup (INV-003)
        return;
      }
      this._messageEndEmitted = true; // push(terminal) below completes output + resolves result()
    }
    this._output.push(event); // forward unchanged
    return;
  }

  // REPLACEMENT phase (_authority === "splicing") — PRD §18 "After Restart" / §39.
  if (event.type === "start") {
    // Already emitted by the primary (INV-002) — suppress the replacement's duplicate start.
    this.diagnostics.trace("proxy.splice.start-suppressed", {});
    return;
  }
  if (isThinkingEvent(event)) {
    // Never emit after restart (PRD §18); also covers EC-017 (replacement returns reasoning anyway).
    return; // silent skip — high-frequency, no per-event trace to avoid spam
  }
  if (isTerminalEvent(event)) {
    if (this._messageEndEmitted) {
      // FM-014 (duplicate completion) / FM-015 (terminal after authority transfer) — discard + trace.
      this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
      return;
    }
    this._messageEndEmitted = true; // the replacement's terminal is THE downstream terminal (INV-003)
  }
  // text_start/delta/end + toolcall_* (and the first terminal) → forward.
  this._output.push(event);
}
```

#### D. EDIT `run()`'s primary loop — route through `_emit`

Find the existing loop body (P1.M2/P1.M4/P1.M5):

```typescript
for await (const event of upstream) {
  this.trackEvent(event);   // side-effect reasoning detection; never throws; never mutates event
  this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
  // FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): the upstream emitted its OWN terminal. …
  if (isTerminalEvent(event)) {
    this._upstreamCompleted = true;
  }
}
```

Replace ONLY the `this._output.push(event);` line with `this._emit(event);`. Keep `trackEvent` BEFORE `_emit`
and the `_upstreamCompleted` block AFTER (both unchanged):

```typescript
for await (const event of upstream) {
  this.trackEvent(event);   // unchanged — reasoning detection runs only in the primary phase
  this._emit(event);        // ◄◄ WAS: this._output.push(event) — now applies §18 filtering
  if (isTerminalEvent(event)) {
    this._upstreamCompleted = true; // unchanged — FM-005/RC-001 race flag (independent of _emit)
  }
}
```

> The natural-completion-won race is preserved: when the primary forwards its terminal, `_emit` sets
> `_messageEndEmitted` AND the loop sets `_upstreamCompleted`; the catch sees `_upstreamCompleted` → returns
> WITHOUT launching a replacement (no authority transfer). Exactly one terminal reaches Pi.

#### E. EDIT `_launchReplacement`'s replacement loop — route through `_emit` (keep flip BEFORE `_emit`)

P1.M7.T1.S1's loop flips authority inside the `if (!firstSeen)` block, BEFORE forwarding. T2 swaps ONLY the
forward line. Find:

```typescript
        this._authority = "splicing";
        this.diagnostics.trace("proxy.replacement.first-event", {});
      }
      // BASELINE forward (T2 refines filtering; T3 owns completion). …
      this._output.push(event);
```

Replace the trailing `this._output.push(event);` with `this._emit(event);`:

```typescript
        this._authority = "splicing";          // authority flip — MUST stay before _emit (do not reorder)
        this.diagnostics.trace("proxy.replacement.first-event", {});
      }
      // §18 filtering: replacement start suppressed (already emitted); thinking_* skipped; text_*/toolcall_*
      // forwarded; first terminal forwarded (+ completes output), duplicates discarded (FM-014/FM-015).
      this._emit(event);                       // ◄◄ WAS: this._output.push(event)
```

> CRITICAL: because the flip runs in `if (!firstSeen)` BEFORE this line, `_emit` sees `_authority === "splicing"`
> for the FIRST replacement event too — so a replacement `start` as the first event is correctly suppressed.
> Do NOT move `_emit` above the flip.

#### F. EDIT `_launchReplacement`'s catch — route the synthesized terminal through `_emit`

P1.M7.T1.S1's catch synthesizes an error terminal via direct `push`. Route it through `_emit` so it respects
the dedup + completion semantics (and is consistent). Find:

```typescript
    this._output.push({
      type: "error",
      reason: "error",
      error: this.makeErrorAssistantMessage(model, message),
    });
```

Replace `this._output.push(` with `this._emit(`:

```typescript
    this._emit({
      type: "error",
      reason: "error",
      error: this.makeErrorAssistantMessage(model, message),
    });
```

> At catch time `_authority` is `"splicing"` (a first event was seen) or `"forwarding"` (startup timeout before
> any event); either branch of `_emit` forwards this single error terminal (messageEndEmitted still false) and
> completes output. If a terminal was already forwarded (messageEndEmitted true) `_emit` discards it safely.

### Test: CREATE `tests/stream-proxy-filtering.test.ts`

A `bun:test` suite. Reuse `makeCaptureDiag()` / `makeModel()` / `ev()` / `waitFor()` VERBATIM from
`tests/stream-proxy-abort.test.ts`, and the two-phase upstream mock shape from the P1.M7.T1.S1 replacement
suite (`makeReplacementUpstream()`): 1st call → PRIMARY iterable (yields events, throws on its signal abort);
2nd call → REPLACEMENT iterable (yields events, throws on its signal abort). Use a small
`replacementStartupTimeoutMs` (e.g. `2000`) so any test that does NOT drive a clean terminal still bounds
orphaned work; drain `proxy.output` concurrently in each test that asserts observed events.

Coverage (each its own `test`):

1. **Full interruption cycle — exactly one `start` + one `done` (the headline MOCKING contract)**: push
   primary `start` + `thinking_start` + `thinking_delta`; drive to Reasoning; `triggerStop()`; wait for
   `proxy.abort.completed`; push replacement `start` + `text_start` + `text_delta` + `text_end` +
   `done(reason:"stop", message: DONE_MESSAGE)`; drain the consumer; assert the observed types contain exactly
   ONE `start` and ONE `done`, AND the sequence is `[start(primary), thinking_start, thinking_delta,
   text_start, text_delta, text_end, done]` (the replacement `start` is absent — suppressed).
2. **Replacement `start` suppressed**: same setup but assert `observed.filter(t => t === "start").length === 1`
   AND a `proxy.splice.start-suppressed` trace was emitted.
3. **Replacement `thinking_*` suppressed (EC-017)**: replacement emits `thinking_start` + `thinking_delta`
   before its text; assert NO `thinking_*` appears AFTER the splice boundary (the only thinking events in
   `observed` are the primary's). Use the splice boundary: thinking count in output == primary thinking count.
4. **Duplicate terminal suppressed (FM-014)**: replacement emits `text_delta` + `done` + a SECOND `done`;
   assert exactly ONE `done` in output AND a `proxy.splice.duplicate-terminal` trace was emitted.
5. **Replacement `text_*` + `toolcall_*` forwarded**: replacement emits `text_start` + `toolcall_start` +
   `toolcall_delta` + `toolcall_end` + `text_delta` + `done`; assert all the text/toolcall events appear in
   output (in order), plus exactly one terminal.
6. **`output.result()` resolves to the forwarded terminal's message**: after case #1 completes,
   `await proxy.output.result()` resolves to the `DONE_MESSAGE` carried by the replacement's `done`.
7. **Privacy guard**: filter `proxy.splice.*` captured events; assert each `fields` is `{}` only (never
   content/options/reasoning/prompt). Mirror the abort test's allow-list scan but scoped to `proxy.splice.*`.

> The two-phase mock MUST use SEPARATE queues + signals for primary vs replacement (the replacement gets a
> FRESH signal from the proxy — P1.M7.T1.S1). The replacement queue must be drivABLE after the splice (push
   events from the test, let the iterator yield them). To terminate the replacement cleanly, push a `done`
   (forwarded → output completes → consumer's `for await` exits).

### Scope Boundary — DO NOT implement (owned by P1.M7.T3 + P1.M8)

- **The full completion lifecycle** (`Splicing → Answering → Completed → Idle`, PRD §51 Completion) → **P1.M7.T3**.
  This subtask leaves the FSM in `Splicing` after the replacement's terminal is forwarded (the terminal
  completes `output` but does NOT drive `Answering`/`Completed` — that is T3).
- **The "replacement ended without emitting a terminal" guard** (EC-018 empty response — output would hang) →
  T3's completion lifecycle. T2's tests always push a replacement terminal, so no hang in T2's suite. Do NOT
  add a post-loop synthesized terminal here (it would steal T3's scope and double-forward on the throw path).
- **Any change to `RequestBuilder`, `TransitionController`, `coordinator.ts`, `buffer/`, `config/`,
  `decorator.ts`, `shortcut/`, `index.ts`, `types.ts`** → none. `isThinkingEvent` already exists in `types.ts`.
- **Any change to the P1.M7.T1.S1 replacement suite, the P1.M5 abort/race suites, or the
  detection/golden/forwarding suites** → none expected (see "Impact on existing tests" — verify, do not edit).

### Success Criteria

- [ ] `_emit(event)` exists and branches on `this._authority`: `"forwarding"` forwards all + sets
      `_messageStartEmitted` on `start` + dedups terminals; `"splicing"` suppresses `start` (trace), skips
      `thinking_*`, forwards `text_*`/`toolcall_*`, forwards the first terminal (sets `_messageEndEmitted`),
      discards subsequent terminals (trace).
- [ ] `run()`'s primary loop forwards via `_emit` (trackEvent before, `_upstreamCompleted` after — unchanged).
- [ ] `_launchReplacement`'s replacement loop forwards via `_emit` (the authority flip + first-event trace stay
      BEFORE `_emit`); its catch's synthesized terminal routes through `_emit`.
- [ ] The downstream output satisfies INV-002 (one `start`) and INV-003 (one terminal) across a full
      primary→replacement splice (the headline MOCKING assertion).
- [ ] `npx bun run typecheck` → 0 diagnostics; `npx bun run build` → exit 0; `npx bun test` → all green (new
      `stream-proxy-filtering` + every pre-existing suite unchanged).

---

## All Needed Context

### Context Completeness Check

_Before writing this PRP, validated: "If someone knew nothing about this codebase, would they have everything
needed to implement this successfully?"_ → YES. The exact import addition, the two boolean fields, the `_emit`
body (with both phases + the dedup/trace logic), the three precise one-line wiring edits (each with the
"keep X before/after" constraint), the EventStream completion semantics (resolving the contract's
"output.end(result)"), the vocabulary reconciliation (`'primary'/'replacement'` ↔ `"forwarding"/"splicing"`),
the two-phase test mock + 7 coverage cases, and the non-obvious facts — (1) WHY no explicit `end()` (push
completes), (2) WHY the authority flip must precede `_emit`, (3) WHY FM-014 and FM-015 share handling in this
sequential architecture, (4) WHY thinking is silently skipped (no per-event trace), (5) WHY the natural-
completion-won race is preserved — are all reproduced above and in `research/notes.md` §1–§10.

### Documentation & References

```yaml
# MUST READ — PRD authority for this subtask
- url: PRD.md "# 18. Event Forwarding Rules"
  why: "The After Restart column is the spec for _emit's replacement branch: message_start → Already emitted
        (suppress start); thinking_start/delta/end → Never emit (skip); text_start/delta → Forward; message_end
        → Forward replacement. The Before Stop column is the spec for _emit's primary branch (forward all)."
  critical: "The MOST IMPORTANT invariant (§18 footer): only one message_end event may ever reach Pi,
             regardless of how many upstream provider requests occur internally. == INV-003. And exactly one
             message_start. == INV-002."

- url: PRD.md "# 39. Transition Event Rules"
  why: "Allowed: Suppress terminal completion; Suppress obsolete thinking; Forward replacement text. Forbidden:
        Emit duplicate message_start; Emit duplicate message_end; Emit upstream completion after replacement
        begins."
  critical: "Authority transfer is irreversible (INV-005/§51). _emit's 'splicing' branch implements exactly
             these allow/forbid rules. A duplicate message_end (terminal) → FM-014; upstream completion after
             replacement begins → FM-015."

- url: PRD.md "# 42. Failure Mode Specification" (## FM-014, ## FM-015)
  why: "FM-014 'Unexpected duplicate completion' → Suppress duplicate; emit exactly one downstream completion.
        FM-015 'Unexpected upstream events after authority transfer' → Discard silently; Log trace diagnostics."
  critical: "BOTH reduce to: once messageEndEmitted is true, discard any further terminal with a
             proxy.splice.duplicate-terminal trace. FM-015 MANDATES the trace (do not silently no-op without
             logging)."

- url: PRD.md "# 21. Stream Splicing Algorithm" (§21.5 Secondary Stream Rules, §21.6 Completion Ownership)
  why: "§21.5: after interruption the replacement owns all future events. §21.6: exactly one stream owns
        completion — always the replacement after interruption."
  critical: "The replacement's terminal (forwarded by _emit) IS the single downstream terminal; the primary
             pushed none on the clean-abort path (P1.M5 left output OPEN). INV-003 holds."

- url: PRD.md "# 13.2 Stream Proxy" (Guarantees / Invariant)
  why: "Exactly one message_start and one message_end reach the downstream consumer. (== INV-002 / INV-003.)"
  critical: "_emit exists to enforce these two guarantees across the splice."

- url: PRD.md "Appendix O — Formal Invariants" (INV-002, INV-003, INV-005, INV-006)
  why: "INV-002 exactly one message_start; INV-003 exactly one message_end; INV-005/006 authority transfer
        irreversible / primary never regains authority."
  critical: "_emit's _messageStartEmitted / _messageEndEmitted flags + the _authority key implement INV-002/
             INV-003; the irreversibility is structural (the flip never reverts)."

# Library contract — EventStream completion semantics (CONFIRMED by reading compiled source)
- file: node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js  (read-only library source)
  why: "push(event): if done → no-op (FREE dedup); else if isComplete(event) (done/error) → done=true +
        resolveFinalResult(extractResult(event)) (resolves result() with event.message / event.error); then
        deliver to consumer/queue. AssistantMessageEventStream: isComplete = type==='done'||'error';
        extractResult = event.message (done) / event.error (error)."
  pattern: "push(terminal) completes the stream AND resolves result() in the same call."
  critical: "THEREFORE forwarding a terminal via this._output.push(event) ALREADY completes output and resolves
             result() — NO explicit output.end() is needed. Do NOT call output.end() (the primary path never
             does; the existing proxy JSDoc forbids it). The contract's 'output.end(result)' is the guarantee
             push(terminal) fulfills. The dedup is ALSO free: a second push(terminal) is a silent no-op once
             done=true; the messageEndEmitted flag is added ONLY to emit the FM-014/FM-015 trace."

# Codebase patterns to FOLLOW / MODIFY
- file: src/provider/proxy.ts
  why: "THE file this subtask modifies. (1) run()'s primary for-await loop — swap push→_emit (keep trackEvent
        before, _upstreamCompleted after). (2) _launchReplacement's replacement for-await loop — swap push→_emit
        (keep the authority flip + proxy.replacement.first-event trace BEFORE _emit). (3) _launchReplacement's
        catch synthesized terminal — swap push→_emit. (4) Add _emit + the 2 booleans + the isThinkingEvent
        import. trackEvent / makeErrorAssistantMessage / _authority (from P1.M7.T1.S1) are reused unchanged."
  pattern: "side-effect (trackEvent) then forward (push) — now side-effect (trackEvent) then filter-forward
            (_emit). _emit is a pure routing decision layered onto push (mirrors how trackEvent is a pure
            detection layered onto push)."
  gotcha: "_authority ('forwarding'|'splicing') is the branch key. The authority flip in _launchReplacement
           runs BEFORE the first _emit — do NOT reorder (a replacement start as the first event must be seen
           after the flip → suppressed). trackEvent runs ONLY in the primary loop (buffer frozen during splicing)."

- file: src/types.ts  (P1.M2.T1.S1 — the shared vocabulary)
  why: "Exports isThinkingEvent (thinking_start|delta|end), isTerminalEvent (done|error), isTextEvent,
        isToolCallEvent, and ProxyPhase ('forwarding'|'transitioning'|'splicing'). This subtask imports
        isThinkingEvent (isTerminalEvent is already imported in proxy.ts)."
  pattern: "string-literal discriminator unions + centralized ReadonlySet membership (Appendix F)."
  gotcha: "start has NO guard (§18: start matches no family) → check event.type === 'start' directly. text_*/
           toolcall_* are forwarded implicitly in _emit (no explicit guard needed). Do NOT add a new union;
           reuse ProxyPhase for _authority."

- file: src/request/builder.ts  (P1.M6.T1.S1 — consumed unchanged by P1.M7.T1.S1)
  why: "Produces the replacement triple ({ ...options, reasoning: undefined }) that P1.M7.T1.S1 invokes. This
        subtask does NOT touch the request; it only filters the resulting event stream."
  pattern: "pure transform (untouched here)."
  gotcha: "None for T2 — the replacement is already launched by P1.M7.T1.S1; T2 only filters its events."

- file: src/state/controller.ts  (P1.M3 — consumed unchanged)
  why: "beginSplice()/fail() already called by P1.M7.T1.S1. T2 does NOT call the FSM (filtering is routing,
        not lifecycle). T3 owns the Splicing→Answering→Completed moves."
  pattern: "T2 adds no controller calls."

- file: tests/stream-proxy-abort.test.ts
  why: "Pattern source: makeCaptureDiag()/makeModel()/ev()/waitFor() (copy VERBATIM into the new test), the
        abortable upstream mock (template for the two-phase mock), and the privacy allow-list scan (template
        for the proxy.splice.* privacy guard)."
  pattern: "capturing diag → construct unit (with the P1.M7.T1.S1 positional args incl. small
            replacementStartupTimeoutMs) → drive events → waitFor(predicate) → assert via captured events."

- file: tests/stream-proxy-replacement.test.ts  (P1.M7.T1.S1 — the producer of the two-phase mock)
  why: "The two-phase makeReplacementUpstream() mock (primary on call 1 / replacement on call 2, separate
        queues + signals) is the EXACT template for this subtask's mock. Reuse its shape."
  pattern: "pushPrimary/pushReplacement + the constructor positional args (controller, buffer,
            DEFAULT_CONFIG.transitionTimeoutMs, undefined /*requestBuilder*/, small replacementStartupTimeoutMs)."
  gotcha: "P1.M7.T1.S1's test #5 pushes replacement text_delta+done (NO start) → still forwarded by _emit; do
           NOT duplicate its cases. This subtask's NEW cases push a replacement start (to assert suppression)
           and a duplicate terminal (FM-014)."

- docfile: plan/001_b0c6691bb424/P1M7T1S1/PRP.md  (the in-flight producer; CONTRACT)
  why: "Defines the _launchReplacement loop + _authority field + _replacementAbort + startup timeout that this
        subtask EDITS. Confirms the authority flip sits in the if(!firstSeen) block BEFORE the forward line,
        that the baseline forward is this._output.push(event) (the exact line T2 swaps), and that the catch
        synthesizes a terminal via direct push (the other line T2 swaps)."
  section: "What / E + F (the replacement loop + catch), and 'New instance state' (_authority)."

- docfile: plan/001_b0c6691bb424/P1M7T2S1/research/notes.md  (THIS item's evidence base)
  why: "The verbatim contract, the vocabulary reconciliation, the EventStream completion semantics (resolving
        output.end(result)), the sequential-architecture rationale for FM-014/FM-015 sharing, the _emit body,
        the 3 wiring edits, and the existing-test impact analysis."
  section: "§1–§10."
```

### Current Codebase tree

```bash
src/
├── index.ts                 # factory (P1.M1.T5) — NO change
├── types.ts                 # isThinkingEvent/isTerminalEvent/ProxyPhase (P1.M2.T1) — IMPORT isThinkingEvent from here
├── config/index.ts          # DEFAULT_CONFIG (P1.M1.T2) — NO change
├── diagnostics/index.ts     # Diagnostics interface (P1.M1.T3) — INJECTED (already)
├── buffer/index.ts          # ReasoningBuffer (P1.M4.T1) — NO change
├── request/builder.ts       # RequestBuilder (P1.M6.T1.S1) — NO change (consumed by P1.M7.T1.S1)
├── provider/
│   ├── decorator.ts         # ProviderDecorator (P1.M1/M2) — NO change
│   └── proxy.ts             # StreamProxy — MODIFY (+_emit, +2 booleans, +isThinkingEvent import, 3 push→_emit swaps)
├── shortcut/index.ts        # ShortcutManager (P1.M4.T3) — NO change
└── state/
    ├── controller.ts        # TransitionController (P1.M3) — NO change (T2 adds no FSM calls)
    └── coordinator.ts       # TransitionCoordinator (P1.M4.T4) — NO change
tests/
├── stream-proxy-abort.test.ts        # PATTERN SOURCE (helpers + mock + privacy scan); NO change
├── stream-proxy-race.test.ts         # NO change (natural-completion-won path preserved by _emit)
├── stream-proxy-replacement.test.ts  # P1.M7.T1.S1 two-phase mock source; NO change (verify it still passes)
├── stream-proxy-filtering.test.ts    # CREATE (new suite, 7 cases)
├── stream-proxy.test.ts              # NO change (normal forwarding preserved by _emit's 'forwarding' branch)
├── stream-proxy-detection.test.ts    # NO change (trackEvent unchanged; forwarding unchanged)
└── … (golden/factory/provider-decorator/… all unchanged)
```

### Desired Codebase tree with files to be added/changed

```bash
src/provider/proxy.ts                   # MODIFY: +isThinkingEvent import, +_messageStartEmitted/_messageEndEmitted,
                                        #         +_emit(event), run() primary loop push→_emit,
                                        #         _launchReplacement loop push→_emit, _launchReplacement catch push→_emit
tests/stream-proxy-filtering.test.ts    # CREATE: two-phase-mock suite (7 cases)
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: the authority flip in _launchReplacement runs INSIDE the if(!firstSeen) block, BEFORE the forward
//   line. T2 swaps push→_emit on the forward line ONLY — so _emit sees _authority === "splicing" even for the
//   FIRST replacement event (a replacement 'start' as the first event is correctly suppressed). Do NOT move
//   _emit above the flip or a replacement start would leak through the 'forwarding' branch.

// CRITICAL: forwarding a terminal via this._output.push(event) ALREADY completes output + resolves result()
//   (EventStream.push sets done=true + resolveFinalResult on a done/error event). Do NOT call output.end() —
//   it is redundant and the primary path / existing JSDoc forbid it. The contract's "output.end(result)" is
//   the guarantee push(terminal) fulfills.

// CRITICAL: dedup is ALSO free — EventStream.push no-ops once done=true. The _messageEndEmitted flag exists
//   ONLY to emit the proxy.splice.duplicate-terminal trace (FM-014/FM-015 — FM-015 MANDATES a trace). Keep it.

// GOTCHA: 'start' has NO type guard (§18: start matches no family) → check event.type === "start" directly in
//   _emit. text_*/toolcall_* are forwarded implicitly (the else branch) — no guard import needed. Only
//   isThinkingEvent + isTerminalEvent are used; isTerminalEvent is already imported, ADD isThinkingEvent.

// GOTCHA: trackEvent runs ONLY in run()'s primary loop (BEFORE _emit). The reasoning buffer is FROZEN during
//   the replacement phase; replacement events must NEVER run trackEvent. _emit never calls trackEvent.

// GOTCHA: the natural-completion-won race (FM-005/RC-001) is PRESERVED — _emit forwarding the primary's
//   terminal sets _messageEndEmitted, and the loop's `if (isTerminalEvent) _upstreamCompleted = true` (kept
//   AFTER _emit) lets the catch take the natural-completion-won path (no replacement). Do not remove that block.

// GOTCHA: FM-014 and FM-015 share handling in this SEQUENTIAL architecture (primary loop is dead before the
//   replacement loop starts). Both reduce to "once messageEndEmitted, discard any further terminal + trace".
//   Do NOT try to distinguish 'primary' vs 'replacement' terminal source — there is no source tag, and the
//   handling is identical.

// PRIVACY (Appendix H): proxy.splice.* traces (proxy.splice.start-suppressed / proxy.splice.duplicate-terminal)
//   log {} ONLY — never content/options/reasoning/prompt. thinking_* suppression is SILENT (no per-event trace,
//   to avoid per-delta spam; PRD §18 "Never emit" needs no log).
```

---

## Implementation Blueprint

### Data models and structure

No new persistent models. Two new private routing booleans on `StreamProxy`:

```typescript
private _messageStartEmitted = false; // INV-002 — set by _emit on the primary 'start'
private _messageEndEmitted = false;   // INV-003 — set by _emit on the first done/error
```

The filter is a pure method `_emit(event: AssistantMessageEvent): void` keyed on the existing
`_authority: ProxyPhase` field (P1.M7.T1.S1). Type safety is enforced by `strict: true` +
`isolatedModules: true` (`tsconfig.json`) and the `tsc --noEmit` gate; `isThinkingEvent`/`isTerminalEvent`
narrow the `AssistantMessageEvent` union.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — add the isThinkingEvent import + the two routing booleans
  - ADD isThinkingEvent to the existing `import { isTerminalEvent } from "../types";` line (comma-join).
  - ADD the 2 private booleans (_messageStartEmitted, _messageEndEmitted = false) near _upstreamCompleted
    (with the Mode-A JSDoc from "What / B").
  - FOLLOW pattern: the existing _upstreamCompleted boolean (a private routing flag, not lifecycle state).
  - GOTCHA: 'start' has no guard; only isThinkingEvent + isTerminalEvent are imported.
  - DEPENDENCIES: isThinkingEvent from src/types (exists since P1.M2.T1.S1).

Task 2: MODIFY src/provider/proxy.ts — add the _emit(event) unified filter method
  - ADD the private _emit method (Mode-A JSDoc + body from "What / C") near trackEvent.
  - IMPLEMENT: branch on this._authority === "forwarding" (primary: forward all, set start/terminal flags,
    dedup terminals) vs else/"splicing" (replacement: suppress start+trace, skip thinking_*, forward
    text_*/toolcall_*, forward first terminal + set _messageEndEmitted, discard subsequent terminals+trace).
  - FOLLOW pattern: trackEvent is a pure side-effect layered onto push; _emit is a pure routing decision
    layered onto push (mirror that style).
  - GOTCHA: do NOT call output.end() (push(terminal) completes); do NOT call trackEvent inside _emit;
    thinking_* skip is silent; trace names are proxy.splice.* (distinct from proxy.replacement.*/proxy.abort.*).
  - DEPENDENCIES: Task 1 (booleans + isThinkingEvent import).

Task 3: MODIFY src/provider/proxy.ts — wire run()'s primary loop through _emit
  - FIND the primary for-await loop body: `this.trackEvent(event); this._output.push(event); if (isTerminalEvent(event)) { this._upstreamCompleted = true; }`.
  - REPLACE ONLY `this._output.push(event);` with `this._emit(event);` (trackEvent before, _upstreamCompleted
    after — BOTH unchanged).
  - GOTCHA: preserve the natural-completion-won race (the _upstreamCompleted block must stay).
  - DEPENDENCIES: Task 2.

Task 4: MODIFY src/provider/proxy.ts — wire _launchReplacement's replacement loop + catch through _emit
  - In the replacement for-await loop: REPLACE the trailing `this._output.push(event);` with
    `this._emit(event);` (the authority flip + proxy.replacement.first-event trace in the if(!firstSeen) block
    stay BEFORE _emit — do NOT reorder).
  - In the catch: REPLACE `this._output.push({ type: "error", reason: "error", error: ... })` with
    `this._emit({ type: "error", reason: "error", error: ... })`.
  - GOTCHA: the flip must precede _emit so a replacement 'start' as the first event is suppressed.
  - DEPENDENCIES: Task 2.

Task 5: CREATE tests/stream-proxy-filtering.test.ts
  - COPY makeCaptureDiag/makeModel/ev/waitFor VERBATIM from tests/stream-proxy-abort.test.ts.
  - IMPLEMENT makeReplacementUpstream() (two-phase mock — copy the SHAPE from the P1.M7.T1.S1 replacement
    suite: primary on call 1 / replacement on call 2, separate queues + signals; both throw on their signal
    abort).
  - IMPLEMENT the 7 coverage cases (full cycle exactly-one-start+done; replacement start suppressed+trace;
    replacement thinking suppressed (EC-017); duplicate terminal suppressed+trace (FM-014); text+toolcall
    forwarded; output.result() resolves to done.message; privacy guard on proxy.splice.*).
  - FOLLOW pattern: tests/stream-proxy-abort.test.ts (bun:test describe/test/expect; waitFor; capture diag;
    concurrent consumer drain + the positional ctor args incl. a small replacementStartupTimeoutMs).
  - COVERAGE: the headline MOCKING contract (exactly one start + one done) + the suppression rules + FM-014 +
    completion + privacy.
  - PLACEMENT: tests/stream-proxy-filtering.test.ts.
  - DEPENDENCIES: imports StreamProxy from "../src/provider/proxy"; TransitionController/ReasoningBuffer;
    DEFAULT_CONFIG from "../src/config" (for the 9th positional abortTimeoutMs).

Task 6: VERIFY (do not edit unless broken) the pre-existing suites
  - RUN the full suite; the P1.M7.T1.S1 replacement suite, the P1.M5 abort/race suites, and the
    detection/golden/forwarding regressions must all still pass (_emit's 'forwarding' branch forwards
    everything unchanged; _emit's 'splicing' branch only affects the replacement loop).
  - IF (and only if) the P1.M7.T1.S1 replacement test #5 pushed a replacement 'start' (it pushes
    text_delta+done per its PRP — so it should NOT break), reconcile minimally. Otherwise NO edits.
  - DEPENDENCIES: Tasks 1–5.
```

### Implementation Patterns & Key Details

```typescript
// PATTERN — _emit is a pure routing decision layered onto push (mirrors trackEvent being a pure detection
// layered onto push). It owns INV-002 (one start) + INV-003 (one terminal) across the splice.
private _emit(event: AssistantMessageEvent): void {
  if (this._authority === "forwarding") {                 // PRIMARY (PRD §18 "Before Stop")
    if (event.type === "start") this._messageStartEmitted = true;
    if (isTerminalEvent(event)) {
      if (this._messageEndEmitted) { this.diagnostics.trace("proxy.splice.duplicate-terminal", {}); return; }
      this._messageEndEmitted = true;
    }
    this._output.push(event);                             // push(terminal) completes output + resolves result()
    return;
  }
  // REPLACEMENT (PRD §18 "After Restart")
  if (event.type === "start") { this.diagnostics.trace("proxy.splice.start-suppressed", {}); return; } // already emitted
  if (isThinkingEvent(event)) return;                     // never emit after restart (silent; EC-017)
  if (isTerminalEvent(event)) {
    if (this._messageEndEmitted) { this.diagnostics.trace("proxy.splice.duplicate-terminal", {}); return; } // FM-014/FM-015
    this._messageEndEmitted = true;
  }
  this._output.push(event);                               // text_*/toolcall_* + the first terminal
}

// PATTERN — the three wiring edits are each a one-line push→_emit swap:
//   run() primary loop:    trackEvent(event); _emit(event); if (isTerminalEvent) _upstreamCompleted=true;
//   replacement loop:      (flip + trace in if(!firstSeen) FIRST) … _emit(event);
//   replacement catch:     _emit({ type:"error", reason:"error", error: makeErrorAssistantMessage(...) });

// GOTCHA — push(done/error) completes output + resolves result() (EventStream source); NO output.end().
// GOTCHA — the authority flip MUST precede _emit in the replacement loop (do not reorder).
// GOTCHA — trackEvent runs ONLY in the primary loop (buffer frozen); _emit never calls trackEvent.
// GOTCHA — FM-014/FM-015 share handling (discard + trace once messageEndEmitted); no source tagging.
// PRIVACY — proxy.splice.* logs {} only (Appendix H).
```

### Integration Points

```yaml
# This subtask MODIFIES src/provider/proxy.ts (+ adds 1 test file). No other module changes.

PROXY INTERNALS (src/provider/proxy.ts): the only change. _emit is the new single downstream chokepoint;
  run()'s primary loop + _launchReplacement's replacement loop + its catch all forward through it. trackEvent,
  makeErrorAssistantMessage, _authority, _replacementAbort, _startReplacementTimeout (all from P1.M7.T1.S1 /
  earlier) are reused UNCHANGED.

TYPES (src/types.ts): NO CHANGE. isThinkingEvent already exported (P1.M2.T1.S1); only IMPORTED here.

CONTROLLER (src/state/controller.ts): NO CHANGE. T2 adds NO FSM calls (filtering is routing, not lifecycle).
  T3 owns Splicing→Answering→Completed.

REQUESTBUILDER / BUFFER / CONFIG / DECORATOR / COORDINATOR / FACTORY / SHORTCUT: NO CHANGE.

EVENTSTREAM (pi-ai library): NO CHANGE (read-only). Relied upon for: push(terminal) completes output +
  resolves result(); push no-ops once done (free dedup). Confirmed in compiled event-stream.js.
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
#  - "Cannot find name 'isThinkingEvent'" → the import addition (Task 1) is missing/typo'd:
#    `import { isTerminalEvent, isThinkingEvent } from "../types";`
#  - "Property '_emit' does not exist" → the method (Task 2) was not added.
#  - an unused-import error → should NOT happen (isThinkingEvent IS used in _emit).
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test the new suite in isolation.
npx bun test tests/stream-proxy-filtering.test.ts -v

# The producer suite (P1.M7.T1.S1) must still pass — verify the two-phase mock + its cases are unaffected.
npx bun test tests/stream-proxy-replacement.test.ts -v

# The forwarding/detection/abort/race regressions must still pass.
npx bun test tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts \
             tests/stream-proxy-abort.test.ts tests/stream-proxy-race.test.ts -v

# Full suite for regressions (every other suite unchanged).
npx bun test

# Expected: All green. Common failures to READ for:
#  - "expected start count 1, received 2" (new filtering test) → the replacement 'start' was NOT suppressed;
#    confirm _emit's 'splicing' branch returns early on event.type === "start", AND the authority flip runs
#    before _emit in the replacement loop (Task 4 gotcha).
#  - "expected done count 1, received 2" → the duplicate terminal was NOT discarded; confirm _emit's terminal
#    branch checks _messageEndEmitted and returns + traces on the second terminal.
#  - a normal-forwarding / detection / golden test now fails on an exact event sequence → _emit's 'forwarding'
#    branch is dropping/reordering an event; it must push EVERY event unchanged in that branch.
#  - the P1.M7.T1.S1 replacement test #5 fails → it pushed a replacement 'start' that is now suppressed;
#    per its PRP it pushes text_delta+done only, so this should NOT happen — re-check, and if it does, the
#    suppression is correct and that test's fixture needs the 'start' removed (but expect NOT to need this).
#  - a test hangs → the replacement emitted no terminal AND no throw (EC-018 clean-return-without-terminal);
#    T2's tests always push a replacement terminal, so this indicates a fixture bug — ensure each replacement
#    queue ends with a 'done'/'error'.
```

### Level 3: Integration Testing (System Validation)

```bash
# (a) The full pre-existing suite is byte-for-byte unchanged EXCEPT proxy.ts; every suite must still pass:
npx bun test tests/reasoning-buffer.test.ts tests/stream-proxy.test.ts tests/stream-proxy-detection.test.ts \
             tests/stream-proxy-race.test.ts tests/stream-proxy-replacement.test.ts \
             tests/transition-controller.test.ts tests/transition-coordinator.test.ts tests/shortcut-manager.test.ts \
             tests/golden/golden-replay.test.ts tests/factory.test.ts tests/provider-decorator.test.ts -v

# (b) The build still emits the modified module:
npx bun run build && ls dist/provider/   # expect: proxy.js + proxy.d.ts (+ maps)

# (c) Full suite (the real integration bar — every suite + the new filtering file):
npx bun test

# Expected: (a) all green unchanged; (b) dist/provider/proxy.{js,d.ts} present; (c) all green, zero regressions.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# INV-002 / INV-003 across the splice (the headline invariant): drive a full primary→replacement cycle in the
# new filtering test and assert observed.filter(t=>t==="start").length === 1 AND
# observed.filter(t=>t==="done"||t==="error").length === 1. (Covered by case #1.)

# EC-017 (replacement returns reasoning anyway): push replacement thinking_start+thinking_delta before its
# text and assert NO thinking_* appears after the splice boundary (thinking count == primary's). (Case #3.)

# FM-014 (duplicate completion): push replacement done+done and assert exactly one done +
# proxy.splice.duplicate-terminal traced. (Case #4.)

# FM-015 (terminal after authority transfer): structurally identical to FM-014 in this sequential
# architecture — covered by the same _messageEndEmitted guard + trace. (Asserted via case #4's trace.)

# Authority-irreversibility (INV-005/006): once _authority flips to "splicing" it never reverts, so _emit's
# 'forwarding' branch can never run again for this proxy — a stray primary event (impossible in the sequential
# model, but defensive) routes through the 'splicing' branch. (Structural; no extra test needed.)

# Privacy guard (Appendix H): assert every proxy.splice.* event's fields === {} (start-suppressed +
# duplicate-terminal both log {}). (Case #7.)

# Completion: await proxy.output.result() resolves to the replacement done.message after the splice. (Case #6.)

# Expected: all invariants green; EC-017/FM-014/FM-015 handled; privacy green; completion resolves.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1: `npx bun run typecheck` → **0 diagnostics**; `npx bun run build` → exit 0; `dist/provider/proxy.{js,d.ts}` emitted.
- [ ] Level 2: `npx bun test` → **all green** (new `stream-proxy-filtering` + every pre-existing suite).
- [ ] No regressions: the P1.M7.T1.S1 replacement suite, the P1.M5 abort/race suites, and the
      detection/golden/forwarding/provider-decorator/factory suites are unchanged and still pass.
- [ ] `proxy.ts` adds only the `isThinkingEvent` import + the 2 booleans + the `_emit` method + the 3
      one-line `push`→`_emit` swaps; no new runtime dependencies, no FSM calls.

### Feature Validation
- [ ] `_emit`'s `"forwarding"` branch forwards every event unchanged and sets `_messageStartEmitted` on `start`
      + dedups terminals (defensive).
- [ ] `_emit`'s `"splicing"` branch suppresses `start` (trace), skips `thinking_*` (silent), forwards
      `text_*`/`toolcall_*`, forwards the first terminal (sets `_messageEndEmitted`), and discards subsequent
      terminals (trace).
- [ ] A full primary→replacement splice emits exactly ONE `start` (INV-002) and ONE terminal (INV-003) to the
      downstream consumer (the headline MOCKING contract).
- [ ] The replacement's duplicate `start` is suppressed; replacement `thinking_*` are suppressed (EC-017);
      a duplicate terminal is suppressed with `proxy.splice.duplicate-terminal` (FM-014/FM-015).
- [ ] Forwarding the replacement terminal via `push` completes `output` and resolves `result()` to
      `done.message`/`error.error` — NO explicit `output.end()` is called.
- [ ] The natural-completion-won race (FM-005/RC-001) is preserved (the `_upstreamCompleted` block stays after
      `_emit` in the primary loop).

### Code Quality Validation
- [ ] Mode-A JSDoc on `_emit` + the 2 booleans citing PRD §18/§39/§13.2 + Appendix O INV-002/INV-003 + the
      EventStream completion semantics — matches the existing proxy.ts style.
- [ ] `_emit` is a pure routing decision (never mutates/reorders/duplicates); `trackEvent` stays primary-only.
- [ ] The 3 wiring edits are minimal one-line swaps with their "keep X before/after" constraints honored.
- [ ] File placement matches the desired tree.

### Documentation & Deployment
- [ ] JSDoc explains WHY no `output.end()` (push completes), WHY the authority flip precedes `_emit`, WHY
      FM-014/FM-015 share handling, and WHY thinking is silently skipped.
- [ ] JSDoc marks the completion-lifecycle boundary (T3 owns Splicing→Answering→Completed; the no-terminal
      guard is T3's).
- [ ] No new env vars / config / dependencies.

---

## Anti-Patterns to Avoid
- ❌ Don't call `output.end()` to complete the stream — `push(done/error)` ALREADY completes output + resolves
  `result()` (EventStream source). The primary path never calls `end()` and the existing JSDoc forbids it.
  The contract's "output.end(result)" is the guarantee `push(terminal)` fulfills.
- ❌ Don't reorder the replacement loop — the `_authority = "splicing"` flip + `proxy.replacement.first-event`
  trace MUST run in the `if (!firstSeen)` block BEFORE `this._emit(event)`. Reordering would let a replacement
  `start` leak through the `"forwarding"` branch (it would be forwarded, violating INV-002).
- ❌ Don't call `trackEvent` on replacement events (or inside `_emit`) — the reasoning buffer is FROZEN during
  the replacement phase; `trackEvent` runs only in `run()`'s primary loop, before `_emit`.
- ❌ Don't drop the `_upstreamCompleted` block from the primary loop — it drives the natural-completion-won
  race (FM-005/RC-001). Keep `if (isTerminalEvent(event)) this._upstreamCompleted = true;` AFTER `_emit`.
- ❌ Don't try to distinguish a "primary" terminal from a "replacement" terminal in the `"splicing"` branch —
  the architecture is sequential (the primary loop is dead before the replacement loop starts), so FM-014 and
  FM-015 are identical (discard + trace once `_messageEndEmitted`). There is no source tag, and the handling is
  the same.
- ❌ Don't add a per-event trace for `thinking_*` suppression — it would spam (one trace per thinking delta).
  PRD §18 "Never emit" needs no log; skip silently. Trace ONLY `start`-suppressed (low frequency) and the
  terminal discard (FM-014/FM-015 — FM-015 mandates a trace).
- ❌ Don't synthesize a terminal on a clean replacement return-without-terminal — that's EC-018 / the
  completion lifecycle owned by P1.M7.T3. T2's tests always push a replacement terminal; adding a post-loop
  guard here would steal T3's scope and risk double-forwarding on the throw path.
- ❌ Don't introduce a new `'authority'` union or new getters — reuse the existing `ProxyPhase` `_authority`
  field (P1.M7.T1.S1). `'primary' ⟺ "forwarding"`, `'replacement' ⟺ "splicing"`.
- ❌ Don't touch `RequestBuilder`, `TransitionController`, `coordinator.ts`, `buffer/`, `config/`,
  `decorator.ts`, `shortcut/`, `index.ts`, `types.ts`, or any pre-existing test — this subtask is `proxy.ts`
  + the new filtering test only.
- ❌ Don't use trace names that collide with the replacement path (`proxy.replacement.*`) or the abort path
  (`proxy.abort.*` / `proxy.forward.*`) — use `proxy.splice.*` so the existing privacy/trace assertions stay
  accurate. All `proxy.splice.*` logs `{}` only (Appendix H).

---

**Confidence Score: 9/10** for one-pass implementation success. The change is a small, well-bounded addition
to P1.M7.T1.S1's `_launchReplacement`: one pure filter method (`_emit`) keyed on the existing `_authority`
field, plus three one-line `push`→`_emit` swaps. The EventStream completion semantics (resolving the contract's
"output.end(result)") are confirmed from compiled source; the `_emit` body, the wiring edits (each with its
"keep X before/after" constraint), and the 7 test cases are reproduced verbatim. The residual uncertainty (why
this is 9 and not 10) is the **breadth of pre-existing suites that the primary-loop `_emit` swap touches
indirectly**: `_emit`'s `"forwarding"` branch must forward EVERY event unchanged or the detection/golden/
forwarding/race exact-sequence assertions break. The PRP pins that requirement (forward all in the
`"forwarding"` branch) and lists the exact "READ-for" failure modes, but the implementer must verify the full
suite. The other judgment call — routing the catch's synthesized terminal through `_emit` (vs leaving it a
direct push) — is documented as the consistent choice (it respects dedup + completion uniformly); the
alternative (direct push) would also work because `push` no-ops on done, but `_emit` keeps the chokepoint
singular. (The "output.end(result)" interpretation — `push(terminal)` completes output, no explicit `end()` —
is the key decision documented in Context + Anti-Patterns; it is grounded in the EventStream source, not a
guess.)
