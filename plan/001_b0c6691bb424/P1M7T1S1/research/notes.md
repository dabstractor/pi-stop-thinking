# Research Notes — P1.M7.T1.S1: Replacement stream launch & initial event handling

## 1. The contract (verbatim, from the work item)

After the primary stream is cleanly aborted (`Capturing`, reasoning buffer frozen — produced by
P1.M5.T1/T2), `StreamProxy.run()` must, **in the `Aborting` catch branch right after `completeAbort()` +
`buffer.freeze()`**, execute (replacing the current `return;`):

```
(a) const triple = RequestBuilder.buildReplacement(model, context, originalOptions, buffer.snapshot())
(b) controller.beginReplacement()            // Capturing → Restarting   (PRD §16)
(c) const replacementAbort = new AbortController()   // NEW internal controller (Pi's signal still controls it)
    + fan-in options.signal (external) so Pi escape (ctrl+c) also aborts the replacement
(d) const replacementStream = originalStreamFn(triple.model, triple.context,
        { ...triple.options, signal: replacementAbort.signal })   // SAME captured provider fn
(e) begin iterating replacementStream
(f) on FIRST replacement event → controller.beginSplice()         // Restarting → Splicing  (PRD §16)
(g) authority = "splicing"  (== "replacement authoritative"; ProxyPhase from src/types.ts)
(h) replacement startup timeout (config.replacementStartupTimeoutMs): no first event within timeout → Failed
```

**INPUT**: `StreamProxy` (P1.M5.T1.S1, with `_internalAbort` + abort catch) + `RequestBuilder`
(P1.M6.T1.S1, pure transform `{ ...options, reasoning: undefined }`).
**OUTPUT**: StreamProxy can launch + begin consuming the replacement after aborting the primary.
Consumed by **P1.M7.T2** (terminal suppression + replacement forwarding/filtering) and **P1.M7.T3**
(end-to-end completion lifecycle). **MOCKING**: mock primary emits thinking → triggerStop → mock
replacement emits text; assert the replacement is invoked with `reasoning === undefined`.

PRD authority: §16 (Capturing|Replacement issued|Restarting; Restarting|First replacement token|Splicing),
§21.3 (splice boundary ends at first accepted replacement event), §40 (replacement authoritative only
after primary aborted + reasoning frozen + replacement accepted), §39 (forward replacement text;
authority transfer irreversible), §51 Replacement Phase + Authority Transfer, §43
(replacement startup timeout configurable), §41 (buffer read-only after replacement).

## 2. Where the change lives (src/provider/proxy.ts)

`run()`'s `catch` already has the clean-abort branch (P1.M5.T1.S1):

```ts
if (this._controller.getState() === "Aborting") {
  this._clearAbortTimeout();
  try { this._controller.completeAbort(); } catch (e) { /* warn */ } // Aborting → Capturing
  this._buffer.freeze();                                             // PRD §41 frozen
  this.diagnostics.trace("proxy.abort.completed", {});
  return;   // ◄◄◄ REPLACE THIS `return;` WITH: await this._launchReplacement(model, context, options, upstreamStreamFn); return;
}
```

Everything before `return;` (the `proxy.abort.completed` trace + frozen buffer) STAYS — it is the
"primary aborted + reasoning frozen" precondition (PRD §40). The replacement launch is a NEW private
async method `_launchReplacement(model, context, options, originalStreamFn)` awaited in place of the
`return;`. After it resolves (replacement stream ended) the catch returns and `run()` ends.

## 3. Constructor signature (backward-compatible append)

Current signature (8th param `abortTimeoutMs` is defaulted, used positionally by the FM-006 test):
```ts
constructor(model, context, options, upstreamStreamFn, diagnostics,
            controller?, buffer?, abortTimeoutMs = DEFAULT_CONFIG.transitionTimeoutMs)
```
Append TWO new optional params AFTER it (preserves every existing positional call):
```ts
            ..., abortTimeoutMs = DEFAULT_CONFIG.transitionTimeoutMs,
            requestBuilder?: RequestBuilder,                                   // NEW (DI; default new RequestBuilder(diagnostics))
            replacementStartupTimeoutMs: number = DEFAULT_CONFIG.replacementStartupTimeoutMs,  // NEW
```
`requestBuilder` is optional DI (mirrors controller/buffer); production omits → proxy self-creates
`new RequestBuilder(diagnostics)`. `replacementStartupTimeoutMs` is a defaulted number (tests inject a
small value to exercise the timeout fast + to bound orphaned replacement work).

## 4. New instance state

```ts
private readonly _requestBuilder: RequestBuilder;
private readonly _replacementStartupTimeoutMs: number;
private _replacementAbort: AbortController | undefined;          // created per-replacement in _launchReplacement
private _replacementStartupTimer: ReturnType<typeof setTimeout> | undefined;
private _authority: ProxyPhase = "forwarding";                   // src/types.ts ProxyPhase; set "splicing" on first repl event
get authority(): ProxyPhase { return this._authority; }
```
`_internalAbort` is ALREADY aborted (used to stop the primary) → MUST use a FRESH `_replacementAbort`
(distinct controller). Fan-in the external signal again so Pi's escape still aborts the replacement.

## 5. The `_launchReplacement` body (core logic + boundary decisions)

```ts
private async _launchReplacement(model, context, options, originalStreamFn): Promise<void> {
  try {
    const triple = this._requestBuilder.buildReplacement(model, context, options, this._buffer.snapshot()); // (a)
    this._controller.beginReplacement();      // (b) Capturing → Restarting
    this._replacementAbort = new AbortController();                                          // (c)
    const external = options?.signal;            // fan-in Pi's signal so ctrl+c aborts the replacement too
    if (external) {
      if (external.aborted) this._replacementAbort.abort();
      else external.addEventListener("abort", () => this._replacementAbort!.abort(), { once: true });
    }
    const replacementStream = originalStreamFn(                                              // (d)
      triple.model, triple.context, { ...triple.options, signal: this._replacementAbort.signal });
    this._startReplacementTimeout();                                                         // (h) arm
    let firstSeen = false;
    for await (const event of replacementStream) {                                           // (e)
      if (!firstSeen) {
        firstSeen = true;
        this._clearReplacementTimeout();        // first event accepted → cancel startup timeout
        this._controller.beginSplice();         // (f) Restarting → Splicing
        this._authority = "splicing";           // (g) authority transfer (irreversible — PRD §39/§51)
        this.diagnostics.trace("proxy.replacement.first-event", {});
      }
      this._output.push(event);                 // BASELINE forward (T2 adds filtering; see §6)
    }
    // replacement stream ended naturally (its terminal was forwarded → output completes). T3 owns
    // the full Splicing→Answering→Completed lifecycle; this subtask leaves the FSM in Splicing.
  } catch (err) {
    this._clearReplacementTimeout();
    const msg = err instanceof Error ? err.message : String(err);
    // CLASSIFY GOTCHA: the startup-timeout handler ALREADY moved us to Failed (fail()) + aborted
    // _replacementAbort (→ this throw) and ALREADY logged `proxy.replacement.startup-timeout`. So by the
    // time the blocked iterator throws, getState() === "Failed" — a `getState() === "Restarting"` check
    // here would be a DEAD branch and DOUBLE-WARN. Skip the warn on the timeout path (state Failed); a
    // throw while NOT yet Failed is a GENUINE failure → log `proxy.replacement.failed`.
    if (this._controller.getState() !== "Failed") {
      this.diagnostics.warn("proxy.replacement.failed", { error: msg });
    }
    // synthesize ONE error terminal so output.result() never hangs (single-terminal invariant),
    // unless a terminal was already forwarded (push is idempotent once complete).
    this._output.push({ type: "error", reason: "error", error: this.makeErrorAssistantMessage(model, msg) });
  }
}
```

Timeout handler (mirrors the FM-006 `_startAbortTimeout` pattern):
```ts
private _startReplacementTimeout(): void {
  this._clearReplacementTimeout();
  this._replacementStartupTimer = setTimeout(() => {
    if (this._controller.getState() === "Restarting") {   // only if we never saw a first event
      this._controller.fail("replacement-startup-timeout"); // Restarting → Failed (Any→Failed; never throws)
      this._replacementAbort?.abort();                      // unblock the blocked iterator → throws → catch
    }
  }, this._replacementStartupTimeoutMs);
}
```

## 6. The forwarding boundary (critical scope decision)

The work-item OUTPUT defers "Replacement Forwarding" to T2 and "Event filtering" to T3, but the
LOGIC steps (e)–(g) say "begin iterating" + handle the first event. A loop that consumes replacement
events but forwards NOTHING would leave `output` OPEN FOREVER (the answer never reaches Pi → the
downstream consumer hangs → untestable end-to-end). Therefore:

- **THIS subtask forwards replacement events into `output` as the MINIMAL baseline** (`this._output.push(event)`).
  This is observably required (the answer must reach Pi) and is correct: the primary pushed NO terminal
  (output left open by P1.M5), so the replacement's events are the single forward path; its `done` becomes
  the single terminal. The single-`start`/single-terminal/single-`result()` invariants still hold.
- **THIS subtask does NOT call `trackEvent` on replacement events.** `trackEvent` appends to the buffer
  when state is `Reasoning` — but the buffer is FROZEN (would throw) and the state is Splicing, so it is
  a no-op anyway; more importantly, replacement-event processing (which events to forward, EC-017
  "replacement returns reasoning anyway → suppress", primary-terminal suppression during the splice
  boundary) is T2/T3's job. The first-event splice transition is driven inline in `_launchReplacement`.
- **T2 will refine** this loop: add the filtering/suppression RULES on top of the baseline forward.
- **T3 will add** the completion lifecycle (Splicing→Answering→Completed→Idle, PRD §51 Completion).

This is a defensible vertical slice: launch + state machine + authority + timeout + baseline forward.

## 7. z.ai disable-thinking mechanism (recap from P1.M6 — still binding)

The replacement is invoked with `reasoning === undefined` because `buildReplacement` produces
`{ ...options, reasoning: undefined }`. In `openai-completions.js`: `clampedReasoning =
options?.reasoning ? clampThinkingLevel(...) : undefined` → `enable_thinking = !!reasoningEffort =
!!undefined = false` → reasoning DISABLED. We must NOT also clear `thinkingBudgets` (z.ai ignores it)
and must NOT touch the signal here (we override it at invocation). CONFIRMED by reading compiled source.

## 8. CRITICAL — impact on existing P1.M5 tests (lifecycle extension)

Extending `run()` past `Capturing` is **intentional and required by the contract**. It changes the
post-abort behavior that P1.M5 tests asserted. Concretely:

- After `completeAbort()` (Capturing), `_launchReplacement` runs `buildReplacement` then
  `beginReplacement()` **synchronously** (no `await` between them — the first await is the `for await`).
  So the FSM moves `Aborting → Capturing → Restarting` in ONE microtask burst. A `setTimeout`-based
  `waitFor(() => getState() === "Capturing")` can NEVER observe `Capturing` in isolation → **those
  assertions now fail.** This is NOT a regression of the clean-abort guarantees (buffer still frozen,
  `proxy.abort.completed` still traced, no synthesized terminal on the abort path) — it is the
  lifecycle continuing exactly as the contract demands.

Affected tests (hard assertion failure — `waitFor(Capturing)`):
- `tests/stream-proxy-abort.test.ts`: "clean abort happy path", "first-press-wins / isInterrupting",
  "privacy guard".
- `tests/stream-proxy-race.test.ts`: "genuine clean-abort regression (no terminal forwarded)".

Affected tests (no assertion failure, but orphaned replacement iterator + 10s timer leaks across
tests → flake risk): `tests/stream-proxy-abort.test.ts` "canInterrupt()/isInterrupting() delegation"
and "Pi escape propagates".

**Uniform update recipe** (specified precisely in the PRP):
1. Inject a SMALL `replacementStartupTimeoutMs` (e.g. `15`) at construction so any orphaned
   replacement fails-and-cleans-up fast (the timeout aborts `_replacementAbort` → the blocked iterator
   throws → catch synthesizes a terminal → no dangling promise/timer). Since these tests pass ≤8
   positional args today, the new params are appended; the recipe is
   `new StreamProxy(..., controller, buffer, DEFAULT_CONFIG.transitionTimeoutMs, undefined, 15)`.
2. Replace `waitFor(() => getState() === "Capturing")` with the STABLE clean-abort signal
   `waitFor(() => events.some(c => c.event === "proxy.abort.completed"))` (deterministic; holds across
   phases). The buffer-frozen + no-synthesized-terminal assertions are UNCHANGED (still hold).

These are necessary lifecycle-extension integration edits — the PRP lists the exact lines.

## 9. New test file — tests/stream-proxy-replacement.test.ts

A two-phase mock: `fn` returns the PRIMARY iterable on the 1st call (yields thinking, throws on abort)
and the REPLACEMENT iterable on the 2nd call (records its `options`, yields replacement events, throws
on the replacement abort signal). Coverage:
- replacement invoked with `options.reasoning === undefined` AND a fresh `signal` injected (the headline
  MOCKING assertion).
- FSM `Capturing → Restarting → Splicing` on the first replacement event.
- `proxy.authority === "splicing"` after the first replacement event; `=== "forwarding"` before.
- replacement startup timeout → `Failed` when no first event within the injected timeout.
- replacement text events are forwarded into `output` (baseline).
- privacy guard: replacement diagnostics (`proxy.replacement.*`) log only `{}`/`{timeoutMs}`/`{error}`.

Reuse `makeCaptureDiag()` / `makeModel()` / `ev()` / `waitFor()` VERBATIM from
`tests/stream-proxy-abort.test.ts`.

## 10. Key gotchas

- `_internalAbort` is ALREADY aborted (used for the primary) → the replacement MUST use a fresh
  `_replacementAbort`; do NOT reuse `_internalAbort`.
- `beginReplacement()` throws if not in `Capturing` — but we just `completeAbort()`'d into Capturing,
  so it is legal. `beginSplice()` throws if not in `Restarting` — but we just `beginReplacement()`'d,
  so it is legal. Wrap neither in try/catch that hides bugs (the P1.M5 pattern wrapped completeAbort
  defensively; for the replacement we KNOW the state, but a defensive try/catch around beginReplacement
  matching the existing style is acceptable).
- DO NOT call `trackEvent` on replacement events (frozen-buffer + T2/T3 ownership — see §6).
- The replacement `done` forwarded via `push` IS the single terminal (primary pushed none) — invariant
  preserved. Do NOT also synthesize a terminal on the natural replacement exit.
- Privacy (Appendix H): replacement diagnostics log `{}` / `{timeoutMs}` / `{error}` only — never
  context/options/reasoning/prompt content.
- `RequestBuilder` is a VALUE import (`import { RequestBuilder } from "../request/builder"`), not
  type-only — the proxy constructs an instance. `ProxyPhase` is a type import from `"../types"`.
- The `originalStreamFn` for the replacement is the SAME captured provider `streamSimple` used for the
  primary (contract: "invoked via the SAME captured provider's streamSimple function"). In `run()` it is
  the `upstreamStreamFn` parameter — pass it straight through to `_launchReplacement`.

## 11. Catch-classification subtlety (DO NOT use `getState() === "Restarting"` in the catch)

The `_launchReplacement` catch must NOT classify the timeout via `getState() === "Restarting"`. The
startup-timeout handler is the ONLY thing that moves the FSM to `Failed` inside `_launchReplacement`,
and it does so BEFORE aborting `_replacementAbort` (which makes the blocked iterator throw → the catch
runs). So when the catch runs on the timeout path, `getState()` is ALREADY `"Failed"`, never
`"Restarting"`. A `getState() === "Restarting"` check is a DEAD branch that falls through to the else
and DOUBLE-WARNS (`proxy.replacement.startup-timeout` from the handler + `proxy.replacement.failed`
from the catch). Correct classification: skip the warn when `getState() === "Failed"` (timeout already
logged); otherwise (genuine throw while Restarting/Splicing) log `proxy.replacement.failed`. Synthesize
the error terminal in BOTH cases. This is reflected in the PRP's `_launchReplacement` body.
