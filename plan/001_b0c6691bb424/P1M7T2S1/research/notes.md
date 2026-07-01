# Research Notes — P1.M7.T2.S1: Event filtering (suppress primary terminal, forward replacement events)

## 1. The contract (verbatim, from the work item)

After the replacement stream is launched and authority transfers to it (produced by **P1.M7.T1.S1**),
the `StreamProxy`'s forwarding must apply the **PRD §18 Event Forwarding Rules** so the downstream
consumer sees exactly ONE `start` and ONE terminal from the **combined** primary+replacement streams.

```
Track:  messageStartEmitted (boolean), messageEndEmitted (boolean)

If authority === 'primary'   (before interruption):     forward ALL events normally;
                                                          set messageStartEmitted on 'start'.

If authority === 'replacement' (after splice):
    SKIP   'start'                  (already emitted — PRD §18 "Already emitted")
    SKIP   thinking_start/delta/end (never emit after restart — PRD §18 "Never emit")
    FORWARD text_start/delta/end
    FORWARD toolcall_*
    On 'done'/'error' → forward it, set messageEndEmitted, then output.end(result)

Any terminal from the PRIMARY stream AFTER authority transfer → discard silently (FM-015: discard + log trace).
A duplicate terminal → suppress (FM-014).
```

**INPUT**: `StreamProxy` from P1.M7.T1.S1 (has `_launchReplacement` baseline-forwarding + `_authority: ProxyPhase`
+ `_replacementAbort` + `_startReplacementTimeout`). **OUTPUT**: the proxy produces exactly one `start` and
one terminal from the combined streams. Consumed by **P1.M7.T3** (end-to-end completion lifecycle).
**MOCKING**: full interruption cycle — primary emits start+thinking; stop; replacement emits start (suppressed)
+ text + done (forwarded); verify exactly one start + one done.

## 2. Vocabulary reconciliation (contract ↔ P1.M7.T1.S1 implementation)

The contract speaks of `authority === 'primary'/'replacement'`; P1.M7.T1.S1 implemented authority as
`ProxyPhase` (`src/types.ts` = `"forwarding" | "transitioning" | "splicing"`):

| Contract term        | Implemented `_authority` value |
|----------------------|--------------------------------|
| `'primary'`          | `"forwarding"`                 |
| `'replacement'`      | `"splicing"`                   |
| (not used in code)   | `"transitioning"` (forward-compat; never set in P1.M7.T1.S1) |

So the filter keys on `this._authority === "forwarding"` (primary) vs everything-else (== `"splicing"` =
replacement). **Do NOT introduce a new `'authority'` union** — reuse the existing `ProxyPhase` field.

## 3. EventStream completion semantics (CONFIRMED by reading compiled source)

`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`:

```js
push(event) {
  if (this.done) return;                 // ◄◄◄ dedup for FREE: a second terminal is a no-op
  if (this.isComplete(event)) {          // isComplete = type === "done" || type === "error"
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));   // resolves result() with event.message / event.error
  }
  // deliver to waiting consumer or queue
}
end(result) { this.done = true; if (result !== undefined) this.resolveFinalResult(result); /* notify waiters */ }
```

**Conclusion (resolves the contract's "output.end(result)")**:
- Pushing the replacement's `done`/`error` via `push(event)` ALREADY (a) sets `done=true`,
  (b) resolves `output.result()` with `event.message` (done) / `event.error` (error). So the terminal
  forward via `push` IS the completion — INV-003 (exactly one `message_end`) + INV (single `result()`) hold.
- The contract's "`output.end(result)`" is the conceptual guarantee that `push(terminal)` **already fulfills**.
- The PRIMARY forwarding path (`run()`) NEVER calls `end()` and the existing JSDoc explicitly says
  *"No `output.end()` call is made — it is unnecessary and contrary to the 'exits naturally' contract."*
  → **Keep the replacement path consistent: forward terminals via `push`, do NOT call `end()`.**
- **Dedup is free**: once `push(terminal)` runs, `done=true`; any subsequent `push` is a silent no-op. The
  explicit `messageEndEmitted` flag + trace is ADDED ON TOP only to emit the FM-014/FM-015 diagnostic trace
  (the no-op itself gives correctness; the flag gives observability).

## 4. The architecture is SEQUENTIAL, not concurrent (key for FM-015)

In P1.M7.T1.S1's design the primary loop (`run()`'s `for await`) and the replacement loop
(`_launchReplacement`'s `for await`) are **sequential**:
- The primary loop runs while `_authority === "forwarding"`.
- On a clean abort the primary iterator THROWS → `run()`'s catch → `_launchReplacement` → the replacement
  loop runs with `_authority === "splicing"` (flipped on the first replacement event, BEFORE that event is forwarded).

Therefore a "primary terminal after authority transfer" (FM-015) **cannot originate from the primary loop**
(it is already dead). In this architecture FM-014 (duplicate completion) and FM-015 (terminal after transfer)
have **identical handling**: once `messageEndEmitted === true`, any further terminal — from whichever stream —
is discarded + logged. The single filter method keyed on `_authority` + the `messageEndEmitted` guard covers
both: the FIRST terminal through the filter is "the" terminal; every subsequent terminal is discarded with
`proxy.splice.duplicate-terminal`. (FM-015's "discard silently, log trace" == FM-014's "suppress duplicate".)

## 5. CRITICAL ordering: the authority flip MUST precede `_emit` for the first replacement event

P1.M7.T1.S1's replacement loop flips authority INSIDE the `if (!firstSeen)` block, BEFORE forwarding:

```ts
let firstSeen = false;
for await (const event of replacementStream) {
  if (!firstSeen) {
    firstSeen = true;
    this._clearReplacementTimeout();
    this._controller.beginSplice();    // Restarting → Splicing
    this._authority = "splicing";      // ◄◄◄ flip happens HERE (before the event is forwarded)
    this.diagnostics.trace("proxy.replacement.first-event", {});
  }
  this._output.push(event);            // ◄◄◄ T2 REPLACES THIS WITH this._emit(event)
}
```

So if T2 swaps `push` → `_emit`, the FIRST replacement event is seen by `_emit` AFTER the flip (authority is
already `"splicing"`). If that first event is a `start`, `_emit` correctly SUPPRESSES it. **T2 must keep the
flip in the `if (!firstSeen)` block and place `this._emit(event)` where `push` was.** Do not reorder.

## 6. The unified filter method — `_emit(event)` (the "forwarding logic")

One private method, branched on `this._authority`, becomes the single downstream chokepoint (owns INV-002
single-`start` + INV-003 single-terminal). Both `run()`'s primary loop and `_launchReplacement`'s replacement
loop (and the synthesized terminal in the catch) call it.

```ts
private _emit(event: AssistantMessageEvent): void {
  if (this._authority === "forwarding") {                 // PRIMARY phase — forward all, track flags
    if (event.type === "start") this._messageStartEmitted = true;
    if (isTerminalEvent(event)) {
      if (this._messageEndEmitted) {                      // defensive dedup (INV-003)
        this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
        return;
      }
      this._messageEndEmitted = true;
    }
    this._output.push(event);                             // push(terminal) completes output + resolves result()
    return;
  }
  // REPLACEMENT phase (_authority === "splicing") — PRD §18 "After Restart"
  if (event.type === "start") {                           // Already emitted → skip (PRD §18)
    this.diagnostics.trace("proxy.splice.start-suppressed", {});
    return;
  }
  if (isThinkingEvent(event)) return;                     // Never emit after restart → silent skip (PRD §18)
  if (isTerminalEvent(event)) {                           // done/error → forward once (INV-003), dedup the rest
    if (this._messageEndEmitted) {                        // FM-014 / FM-015 — discard + trace
      this.diagnostics.trace("proxy.splice.duplicate-terminal", {});
      return;
    }
    this._messageEndEmitted = true;                       // forward + set; push() completes output
  }
  // text_* + toolcall_* (and the first terminal) → forward
  this._output.push(event);
}
```

Notes:
- `_emit` is a PURE routing decision on top of `push`; it never mutates/reorders/duplicates. Track detection
  (`trackEvent`) stays in the PRIMARY loop only (buffer is frozen; replacement events never run `trackEvent`).
- `isThinkingEvent` must be IMPORTED from `"../types"` (P1.M2.T1.S1 already exports it; `isTerminalEvent` is
  already imported in proxy.ts). `start` is checked by `event.type === "start"` (no guard for it — §18: start
  matches no family). `text_*`/`toolcall_*` are forwarded implicitly (everything-not-start-not-thinking-not-terminal).
- Trace names are NEW (`proxy.splice.*`) and DISTINCT from `proxy.replacement.*` (P1.M7.T1.S1) and
  `proxy.abort.*` / `proxy.forward.*` (P1.M5) → the existing privacy/trace assertions stay accurate.
  All `proxy.splice.*` logs `{}` only (Appendix H).

## 7. Wiring into the two loops (the 3 edits in proxy.ts)

**Edit A — `run()` primary loop** (keep `trackEvent` before + `_upstreamCompleted` after):
```ts
for await (const event of upstream) {
  this.trackEvent(event);            // unchanged
  this._emit(event);                 // ◄◄ WAS: this._output.push(event)
  if (isTerminalEvent(event)) {      // unchanged — FM-005/RC-001 race flag (independent of _emit)
    this._upstreamCompleted = true;
  }
}
```
The natural-completion-won race (`_upstreamCompleted` in the catch) is UNCHANGED — `_emit` forwarding the
primary terminal sets `messageEndEmitted` AND the loop sets `_upstreamCompleted`; the catch sees
`_upstreamCompleted` → returns WITHOUT launching a replacement (no authority transfer). Consistent.

**Edit B — `_launchReplacement` replacement loop** (keep the flip before `_emit`):
```ts
  this.diagnostics.trace("proxy.replacement.first-event", {});
}
this._emit(event);                   // ◄◄ WAS: this._output.push(event)
```

**Edit C — `_launchReplacement` catch synthesized terminal** (route through `_emit` for dedup + completion):
```ts
this._emit({ type: "error", reason: "error", error: this.makeErrorAssistantMessage(model, msg) });
//   ◄◄ WAS: this._output.push({ type: "error", ... })
```
At catch time `_authority` is `"splicing"` (first event seen) or `"forwarding"` (timeout before any event);
either way `_emit` forwards the single error terminal (messageEndEmitted still false) and completes output.

## 8. New state (two booleans)

```ts
/** INV-002 (Appendix O): exactly one downstream `start` forwarded. Set by _emit on the primary 'start'. */
private _messageStartEmitted = false;
/** INV-003 (Appendix O): exactly one downstream terminal forwarded. Set by _emit on the first done/error. */
private _messageEndEmitted = false;
```
No new getters needed (tests assert on the output stream's observed events + traces). These are PRIVATE
routing flags, not lifecycle state (PRD Appendix F's "no boolean flags for lifecycle" rule applies to the
FSM `TransitionState`, NOT to internal routing counters — the existing proxy already uses
`_upstreamCompleted: boolean`).

## 9. Impact on existing tests (verify, do NOT expect breaks)

- **`stream-proxy-replacement.test.ts` (P1.M7.T1.S1)**: test #5 pushes replacement `text_delta` + `done` (NO
  `start`) → still forwarded by `_emit`. Tests #1–#4/#6 are about invocation/FSM/authority/timeout/privacy —
  unaffected by filtering. The catch-synthesized terminal (test #4 timeout) routes through `_emit` → still
  forwarded. → **No reconcile expected.** (If P1.M7.T1.S1 happened to push a replacement `start`, that event
  would now be suppressed — VERIFY; the PRP pins test #5 to text+done so it should be safe.)
- **`stream-proxy-abort.test.ts` / `stream-proxy-race.test.ts` (reconciled by P1.M7.T1.S1)**: these reach the
  replacement phase via orphaned-replacement + small timeout; `_emit` forwards the synthesized error terminal
  → unchanged assertions. → **No new reconcile.**
- **`stream-proxy.test.ts` / `stream-proxy-detection.test.ts` / `golden-replay.test.ts`**: forward NORMAL
  (non-interrupted) streams entirely in the `"forwarding"` phase → `_emit` forwards everything unchanged
  (only side effect: sets `_messageStartEmitted`/`_messageEndEmitted`). The exact event sequences these assert
  are preserved. → **No reconcile.**
- **`stream-proxy-race.test.ts` "done race"**: primary `done` forwarded (`_emit` forwarding phase →
  messageEndEmitted=true) + `_upstreamCompleted` → natural-completion-won. Exactly one terminal seen. → **Unchanged.**

## 10. Key gotchas

- `_emit` keys on `this._authority` ("forwarding" = primary; else = replacement). The authority flip in
  `_launchReplacement` MUST run before the first `_emit` (it already does in P1.M7.T1.S1 — do not reorder).
- `push(done/error)` completes output + resolves `result()` (EventStream source). Do NOT call `output.end()`
  — it is redundant and the primary path / existing JSDoc forbid it. The contract's "output.end(result)" is
  the guarantee `push(terminal)` fulfills.
- Dedup is ALSO free (push no-ops once `done=true`); the explicit `messageEndEmitted` flag exists ONLY to emit
  the FM-014/FM-015 trace. Keep it.
- `start` has NO type guard (§18: start matches no family) → check `event.type === "start"` directly.
- `isThinkingEvent` is imported from `"../types"` (exists since P1.M2.T1.S1); `isTerminalEvent` already imported.
- `trackEvent` runs ONLY in the primary loop (buffer frozen; replacement events must NOT append). `_emit`
  never calls `trackEvent`.
- "Replacement ends without emitting a terminal" (EC-018 edge) → output would hang. The throw-catch
  synthesizes a terminal; a clean return-without-terminal does NOT. That completion-lifecycle guard is
  **P1.M7.T3's** job (Splicing→Answering→Completed). T2's tests always push a replacement terminal, so no
  hang in T2's suite. (Noted as a forward-compat item; do NOT implement here.)
- Privacy (Appendix H): `proxy.splice.*` traces log `{}` only — never content/options/reasoning/prompt.
