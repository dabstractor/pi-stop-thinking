# Research Notes — P1.M2.T1.S1: Capture primary partial content blocks and compute contentIndex offset at freeze

> Companion research for the PRP. All facts verified against the local source. This subtask is the
> FIRST to modify `src/` in the bugfix (P1.M1 was test-infrastructure-only) and the FIRST to drive the
> real `StreamProxy` with the realistic mock.

---

## 1. The exact code being changed (`src/provider/proxy.ts`)

### 1a. The primary `for await` loop in `run()` — INSERT the capture line

Current (verbatim from `run()`, the `try` block):
```ts
const upstream = upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal });
for await (const event of upstream) {
  this.trackEvent(event);   // side-effect reasoning detection; never throws; never mutates event
  this._emit(event);        // §18 filtering: forwarding phase → forward all; set INV-002/INV-003 flags
  // FM-005 / EC-007 / RC-001 (P1.M5.T2.S1): the upstream emitted its OWN terminal.
  if (isTerminalEvent(event)) {
    this._upstreamCompleted = true;
  }
}
```
Insert, **right after** `this.trackEvent(event); this._emit(event);` and **before** the FM-005 block:
```ts
  // P1.M2.T1.S1 — capture the LAST primary event's live partial (most-complete content). Terminal
  // (done/error) members of the union carry NO `.partial`, so narrow them out first.
  if (!isTerminalEvent(event) && event.partial) {
    this._primaryPartial = event.partial;
  }
```

### 1b. The abort branch of `run()`'s catch — INSERT the snapshot, AFTER `this._buffer.freeze()`

Current (verbatim from `run()`'s `catch`):
```ts
      if (this._controller.getState() === "Aborting") {
        this._clearAbortTimeout(); // clean abort — cancel the FM-006 safety net
        try {
          this._controller.completeAbort(); // Aborting → Capturing (PRD §16)
        } catch (e) {
          this.diagnostics.warn("proxy.abort.complete-abort-failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        this._buffer.freeze(); // (PRD §41: reasoning immutable once frozen; §40: replacement needs this)
        this.diagnostics.trace("proxy.abort.completed", {});
        // PRD §40: primary aborted + reasoning frozen → launch the thinking-disabled replacement...
        await this._launchReplacement(model, context, options, upstreamStreamFn);
        return;
      }
```
Insert, **immediately after** `this._buffer.freeze();` (and before the `proxy.abort.completed` trace):
```ts
        this._buffer.freeze();
        // P1.M2.T1.S1 — snapshot the primary's frozen content blocks (shallow-per-block clone) and the
        // contentIndex offset (= block count). Seed data for the replacement-event rewrite (P1.M2.T2.S1).
        // GUARD: _primaryPartial is undefined for placeholder mocks (no partial) → frozen [] + offset 0
        // → the T2 rewrite becomes a no-op, preserving all existing test behavior.
        this._frozenPrimaryContent = (this._primaryPartial?.content ?? []).map((b) => ({ ...b }));
        this._contentIndexOffset = this._frozenPrimaryContent.length;
        this.diagnostics.trace("proxy.abort.completed", {});
```

### 1c. New private fields + public getters (place near the other private fields, ~`_authority`)

The file's established convention is **private field + public getter** for every externally-needed
internal (`_output`/`output`, `_controller`/`controller`, `_buffer`/`buffer`, `_authority`/`authority`).
Follow it EXACTLY so the test asserts via getters (no `as any` casts) and the values are "available
for P1.M2.T2.S1" per the contract OUTPUT.

```ts
  /**
   * P1.M2.T1.S1: the primary stream's last live `event.partial` reference (the provider's accumulating
   * `output`). Captured on every primary non-terminal event (last one wins — most-complete content).
   * `undefined` for placeholder mocks (no partial). Deep-cloned into _frozenPrimaryContent at the abort
   * boundary. Read-only after freeze.
   */
  private _primaryPartial: AssistantMessage | undefined;

  /**
   * P1.M2.T1.S1: a shallow-per-block clone of the primary's content blocks captured at the abort
   * boundary (right after `_buffer.freeze()`). These are the frozen `thinking` blocks the replacement
   * rewrite (P1.M2.T2.S1) prepends to the merged message. `[]` when no primary partial was captured.
   */
  private _frozenPrimaryContent: ReadonlyArray<Record<string, unknown>> = [];

  /**
   * P1.M2.T1.S1: the contentIndex offset = the count of frozen primary content blocks. Replacement
   * events are offset by this so their answer text lands AFTER the primary's reasoning (no collision).
   * `0` when no primary partial was captured → T2 rewrite is a no-op.
   */
  private _contentIndexOffset = 0;

  /** P1.M2.T1.S1: the frozen primary content blocks (the thinking) for the T2 merge. Read-only getter. */
  get frozenPrimaryContent(): ReadonlyArray<Record<string, unknown>> {
    return this._frozenPrimaryContent;
  }

  /** P1.M2.T1.S1: the contentIndex offset for the T2 replacement-event rewrite. Read-only getter. */
  get contentIndexOffset(): number {
    return this._contentIndexOffset;
  }
```

`AssistantMessage` is already imported in proxy.ts (`import type { ... AssistantMessage ... } from "@earendil-works/pi-ai";`).

## 2. TYPE-SAFETY GOTCHA (the #1 implementation trap — verified against the pi-ai types)

`AssistantMessageEvent` is a discriminated union. **`partial` exists on EVERY non-terminal member**
(`start`, `text_*`, `thinking_*`, `toolcall_*`) but **NOT on `done`/`error`** (they carry
`message`/`error`). Verified at `node_modules/@earendil-works/pi-ai/dist/types.d.ts:251–293`.

→ Writing the contract's bare `if (event.partial)` is a **`tsc` ERROR** under strict mode ("Property
'partial' does not exist on type 'TerminalEvent'"), and **`bun run build` (=`tsc`) IS a real gate here**
(unlike P1.M1 which was test-only). `src/` is compiled.

→ FIX: narrow out terminals FIRST with the already-imported `isTerminalEvent` guard (a type predicate
`event is TerminalEvent`), after which `event.partial` is type-safe on the remaining members:
```ts
if (!isTerminalEvent(event) && event.partial) { this._primaryPartial = event.partial; }
```
This also matches the contract's *intent*: only capture non-terminal partials (terminals carry no
partial anyway). `isTerminalEvent` is already imported in proxy.ts from `"../types"`.

There is NO existing `.partial` access anywhere in `src/` (grep `src/` for `\.partial` → empty), so this
narrowing idiom is new but idiomatic (the file uses `isTerminalEvent`/`isThinkingEvent` everywhere).

## 3. Why the guard preserves the existing 384-test suite (the #2 trap)

The existing placeholder mocks (`makeScriptedTwoPhaseUpstream` in `invariant-harness.ts`,
`makeAbortableUpstream` in `stream-proxy-abort.test.ts`) build events via
`ev({ type: "thinking_delta", contentIndex: 0, delta: "x" })` — these carry **NO `partial` field**.

With the new capture line:
- placeholder event → `event.partial` is `undefined` → falsy → `_primaryPartial` stays `undefined`.
- At freeze: `_frozenPrimaryContent = (undefined?.content ?? []).map(...) = []`; `_contentIndexOffset = 0`.

→ The T2 rewrite (future) becomes a no-op for these. **No existing test changes behavior.** The whole
existing suite (`makeCaptureDiag` + `ev()` placeholder mocks) must stay at 384 pass / 0 fail. This is
the explicit GUARD in the contract — verify it with `bun test`.

## 4. The realistic mock this test consumes (`tests/helpers/realistic-mock.ts` — already shipped in P1.M1.T1.S2)

- `makeRealisticTwoPhaseMock()` → `{ fn, calls, pushPrimary, pushReplacement, closePrimary, primaryOutput, replacementOutput }`.
- `mock.fn` is an `ApiStreamSimpleFunction` (cast). Drop it straight into `new StreamProxy(...)` as the
  `upstreamStreamFn` arg.
- `pushPrimary({type:"thinking_delta", delta:"…"})` mutates `mock.primaryOutput.content` IN PLACE and
  stamps `partial: primaryOutput` on the emitted event. So after 2 thinking deltas, `primaryOutput.content`
  is `[{type:"thinking", thinking:"<accumulated>"}]` (length 1).
- The primary iterator **throws `new Error("aborted")`** on its `AbortSignal` abort → that is the trigger
  for the proxy's `run()` abort branch (state `Aborting`) → `completeAbort()` → `_buffer.freeze()` → our
  new snapshot. (Mirrors `makeScriptedTwoPhaseUpstream`; verified at realistic-mock.ts.)
- The replacement is NOT driven by this subtask's test assertions (T2/T3 own that) — but the proxy WILL
  call `_launchReplacement` (call 2) after freeze. Handle it cleanly (see §6).

## 5. The test-driving pattern (from `tests/stream-proxy-abort.test.ts` + `invariant-harness.ts`)

The capturing-diag stub + proxy construction idiom (copy verbatim, swap the placeholder mock for the
realistic mock):
```ts
const { diag, events } = makeCaptureDiag();           // from invariant-harness.ts (contract MOCKING req)
const controller = new TransitionController(diag);
const buffer = new ReasoningBuffer(diag, 1_000_000);
const mock = makeRealisticTwoPhaseMock();             // realistic partials (contract INPUT)

const proxy = new StreamProxy(
  makeModel(),                                        // from invariant-harness.ts
  {} as never, {} as never,                           // context, options stubs
  mock.fn,                                            // ← realistic mock's fn (the upstream)
  diag,
  controller, buffer,
  DEFAULT_CONFIG.transitionTimeoutMs,
  undefined,                                          // requestBuilder (self-created; T1 doesn't care)
  15,                                                 // replacementStartupTimeoutMs small (orphan-safe)
);
```
Then (the exact drive used by `stream-proxy-abort.test.ts` "clean abort happy path"):
```ts
mock.pushPrimary({ type: "start" });
mock.pushPrimary({ type: "thinking_start" });
mock.pushPrimary({ type: "thinking_delta", delta: "Let" });
mock.pushPrimary({ type: "thinking_delta", delta: " me" });
await waitFor(() => proxy.isReasoning());             // run() has processed the thinking events
expect(proxy.triggerStop()).toBe(true);               // Aborting + _internalAbort.abort()
await waitFor(() => events.some((c) => c.event === "proxy.abort.completed")); // freeze + snapshot done
// ASSERT (the contract OUTPUT):
expect(proxy.frozenPrimaryContent).toHaveLength(1);
expect(proxy.frozenPrimaryContent[0]).toMatchObject({ type: "thinking", thinking: "Let me" });
expect(proxy.contentIndexOffset).toBe(1);
```
- `waitFor` is in `invariant-harness.ts` (import it; the abort test re-declares a local copy — either works).
- `makeModel`, `makeCaptureDiag`, `waitFor` are all exported from `tests/helpers/invariant-harness.ts`.

## 6. Replacement-cleanup gotcha (avoid hanging timers / unhandled rejections)

After `freeze()` + snapshot, `run()` calls `await this._launchReplacement(...)` → call 2 of the mock →
the replacement iterator blocks (queue empty) awaiting its first event. If the test asserts and returns
without resolving it, a 0ms timer + the `replacementStartupTimeoutMs: 15` net stay live. Two clean options
(the contract does not mandate either; pick for hygiene):
- **(A) Feed a replacement `done` and drain output** so the proxy terminates cleanly (`_terminate(true)`):
  ```ts
  mock.pushReplacement({ type: "done" });            // replacement completes → proxy terminates
  for await (const _e of proxy.output) { /* drain */ }
  ```
- **(B) Rely on the small `replacementStartupTimeoutMs`** (15ms) → the orphaned replacement fails fast
  (`Failed` → `_terminate(false)`). Asserts are already valid (snapshot ran at freeze). Existing abort
  tests use this orphan-tolerant pattern (they assert mid-flight and never drain).

Either is correct; **(A)** is cleanest (no timeout noise in diagnostics). The frozen-content snapshot is
populated at freeze time, BEFORE the replacement is iterated, so the assertion is valid regardless.

## 7. Validation commands (project-verified)

- `./node_modules/.bin/bun test tests/stream-proxy-capture.test.ts` — new test in isolation (bun is NOT on
  PATH; use `node_modules/.bin/bun`). `npm test` runs the same.
- `./node_modules/.bin/bun test` — full suite (baseline 384 pass / 0 fail; +1 new = **385**).
- `npm run build` (=`tsc`) — **REAL GATE now** (src/ change). Must be 0 diagnostics. The type-narrowing
  in §2 is what makes this pass.
- `npm run typecheck` (=`tsc --noEmit`) — equivalent gate.
- `git diff --stat -- src/provider/proxy.ts` — should show ONLY proxy.ts modified in src/; new test file
  added under tests/.

## 8. Scope boundaries (cohesion / no harm to sibling work items)

- **DO NOT** implement the T2 rewrite (contentIndex offsetting + partial/message merging). T1 only
  CAPTURES `_frozenPrimaryContent` + `_contentIndexOffset`; T1 reads nothing it doesn't own. T2 (P1.M2.T2)
  will consume these two getters inside `_emit()`'s splicing branch. T1's snapshot is inert until T2 wires
  it in, so a passing T1 changes NO downstream output (the placeholder-mock guard in §3 guarantees this).
- **DO NOT** touch `_emit`, `_launchReplacement`, `trackEvent`, the controller, the buffer, or types.ts.
- The added getters are additive + read-only → zero risk to the 380 existing tests + the 4 new helper tests.
- P1.M2.T3.S1 (end-to-end consumer integration test) builds on top of T1+T2; T1 alone does not fix Issue 1
  (it only gathers the seed data). That is by design.
