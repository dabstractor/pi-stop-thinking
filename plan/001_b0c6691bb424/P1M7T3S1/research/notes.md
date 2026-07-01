# Research Notes — P1.M7.T3.S1: End-to-end transition lifecycle and cleanup

## §0. Work-item contract (verbatim, distilled)

After the replacement stream's terminal event is forwarded (produced by P1.M7.T2.S1):
- (a) `controller.complete()` → `Completed` → `Idle`.
- (b) `cleanup()`: destroy reasoningBuffer (`reset()`), null out abort controllers,
  `coordinator.setActiveProxy(undefined)`.
- (c) If any error during transition: `controller.fail(reason)` → `Failed` → cleanup →
  forward error event to output.
- INV-010: cleanup runs EXACTLY ONCE regardless of success/failure/timeout/cancellation.
- PRD §44: no allocations survive beyond stream completion.
- PRD §17 "Completed": cleanup must succeed even if telemetry fails. "Failed": internal
  state always reset before exit.
- PRD §48 Acceptance Criteria (the 15-item production-ready checklist) must hold.
- OUTPUT: complete working transition (keypress → final answer). MVP functional.
- MOCKING: integration test, mock provider emits reasoning then replacement text
  (PRD §7 Story 1).

## §1. The producer (P1.M7.T2.S1) — what exists when T3 begins

P1.M7.T2.S1 (in flight, treat as CONTRACT) ADDS to `src/provider/proxy.ts`:
- `import { isTerminalEvent, isThinkingEvent } from "../types";` (isThinkingEvent added).
- `private _messageStartEmitted = false;` (INV-002).
- `private _messageEndEmitted = false;` (INV-003) — **T3 reuses this for the EC-018 guard**.
- `private _emit(event: AssistantMessageEvent): void` — the unified forward filter keyed on
  `_authority`. PRIMARY ("forwarding"): forward all + set start/terminal flags. REPLACEMENT
  ("splicing"): suppress `start` (trace `proxy.splice.start-suppressed`), skip `thinking_*`
  (silent), forward `text_*`/`toolcall_*`, forward first terminal (set `_messageEndEmitted`),
  discard subsequent terminals (trace `proxy.splice.duplicate-terminal`).
- 3 one-line wiring swaps: `run()` primary loop `push`→`_emit`; `_launchReplacement` loop
  `push`→`_emit`; `_launchReplacement` catch synthesized terminal `push`→`_emit`.

CRITICAL ORDERING T2 pins: in the replacement loop the authority flip
(`this._authority = "splicing"`) + `proxy.replacement.first-event` trace run INSIDE the
`if (!firstSeen)` block BEFORE `this._emit(event)`. T3 ADDS lifecycle logic AFTER `_emit`
in that loop and must NOT reorder the flip.

## §2. The replacement loop today (P1.M7.T1.S1 + T2) — the line T3 edits

```ts
let firstSeen = false;
for await (const event of replacementStream) {
  if (!firstSeen) {
    firstSeen = true;
    this._clearReplacementTimeout();
    this._controller.beginSplice();           // Restarting → Splicing
    this._authority = "splicing";             // MUST stay before _emit
    this.diagnostics.trace("proxy.replacement.first-event", {});
  }
  this._emit(event);                          // T2: filter-forward (start/thinking/terminal rules)
}
// line ~654: "Replacement stream ended naturally … T3 owns the Splicing→Answering→Completed lifecycle."
```

T3 inserts (a) `beginAnswering()` on the first forwarded answer token, and (b) the terminal
completion drive, AFTER `this._emit(event)` — keeping T2's flip-before-`_emit` ordering intact.

## §3. The FSM transitions T3 needs (all legal per ALLOWED_TRANSITIONS in controller.ts)

| from → to        | trigger                      | method              |
|------------------|------------------------------|---------------------|
| Splicing→Answering | first answer token          | `beginAnswering()`  |
| Answering→Completed | replacement `done`          | `complete()`        |
| Completed→Idle   | cleanup                      | `reset()`           |
| Any→Failed       | any error/timeout           | `fail(reason)`      |
| Failed→Idle      | cleanup                      | `reset()`           |

`reset()` (controller.ts) throws unless state ∈ {Completed, Failed}. The proxy's PRIVATE
`transitionIfLegal(target)` (lines ~288) is the safe no-throw variant — it checks
`ALLOWED_TRANSITIONS` and only transitions if legal, returning boolean, NEVER throwing and
NEVER logging `transition.illegal`. **T3 uses `transitionIfLegal` exclusively** so a
no-op-from-wrong-state (e.g. normal path leaves FSM in `Reasoning`) cannot throw.

## §4. The single-terminal-exit idiom — ONE idempotent `_terminate(success, reason?)`

There are MANY places the transition can end (success / replacement error / abort timeout /
startup timeout / unexpected upstream throw / normal non-interrupted completion / race-won).
INV-010 demands cleanup EXACTLY ONCE. The cleanest design is ONE idempotent method guarded
by a single boolean, driven by `transitionIfLegal` (no-throw) + resource release:

```ts
private _terminated = false; // INV-010

private _terminate(success: boolean, reason?: string): void {
  if (this._terminated) return;
  this._terminated = true;
  if (success) {
    this.transitionIfLegal("Answering"); // Splicing→Answering (no-op if already; no-op from Reasoning on the normal path)
    this.transitionIfLegal("Completed"); // Answering→Completed
    this.transitionIfLegal("Idle");      // Completed→Idle
  } else {
    if (this._controller.getState() !== "Failed") this._controller.fail(reason ?? "transition-failed");
    this.transitionIfLegal("Idle");      // Failed→Idle
  }
  this._clearAbortTimeout();
  this._clearReplacementTimeout();
  try { this._buffer.reset(); } catch { /* §17: cleanup must succeed even if telemetry fails */ }
  this._replacementAbort = undefined;                 // release replacement abort reference (§44)
  this._coordinator?.setActiveProxy(undefined);       // release transition token (§44)
  this.diagnostics.trace("proxy.lifecycle.cleanup", {});
}
```

ELEGANT PROPERTY: on the NORMAL path (primary `done`, no interruption) the FSM sits in
`Reasoning` (§16 has no normal Reasoning→Completed exit). `_terminate(true)`'s three
`transitionIfLegal` calls are ALL no-ops from `Reasoning` → FSM stays `Reasoning` (correct,
no misleading `transition.failed`), yet resources are still released + coordinator cleared.
So `_terminate(true)` is safe for BOTH interrupted-success and normal-completion exits.

## §5. Every terminal exit → its `_terminate` call (the call-site map)

`run()` primary loop:
- natural loop exit (loop ends, `_upstreamCompleted`): `_terminate(true)`.
  - sub-case state==="Aborting" (race won): the existing `_cancelInFlightAbort()` already
    does fail("natural-completion-won")+reset → Idle; then `_terminate(true)` just releases
    resources (FSM no-ops from Idle). Keep `_cancelInFlightAbort` call, then `_terminate(true)`.

`run()` catch:
- `_upstreamCompleted` (race won, terminal already forwarded): `_cancelInFlightAbort()` +
  `_terminate(true)`; `return`.
- `state === "Aborting"` (clean abort): completeAbort + freeze + `_launchReplacement`; `return`.
  (NO `_terminate` — the replacement owns termination.)
- else (unexpected throw): synthesize `error` terminal via `_emit` + `_terminate(false, "upstream-error")`.

`_launchReplacement()` replacement loop:
- on each event after `_emit`: if state==="Splicing" && (isTextEvent||isToolCallEvent) →
  `beginAnswering()` (streaming FSM accuracy; PRD §16 first answer token).
- after `_emit`: if `isTerminalEvent(event)`: `event.type==="done"` → `_terminate(true)`;
  else (`error`) → `_terminate(false, "replacement-error")`.
- post-loop EC-018 guard: `if (!this._messageEndEmitted)` (no terminal forwarded) → synthesize
  one `error` terminal via `_emit` + `_terminate(false, "replacement-empty")`.

`_launchReplacement()` catch:
- synthesize `error` terminal via `_emit` (T2 already swapped this) + `_terminate(false, reason)`.
  reason: if state already `Failed` (startup-timeout ran first) the reason is moot — `_terminate`
  skips `fail()` because state is already Failed; otherwise `"replacement-failed"`.

The single `_terminated` guard makes ANY accidental double-call a no-op (duplicate terminal,
stray terminal after transfer, a catch-after-loop, etc.) → INV-010 holds structurally.

## §6. The coordinator handle — new optional constructor param

The proxy today has NO coordinator reference. The item REQUIRES
`coordinator.setActiveProxy(undefined)` on cleanup. Resolution: add an OPTIONAL trailing
constructor param (consistent with the existing `controller?/buffer?/requestBuilder?` DI
convention):

```ts
import type { TransitionCoordinator } from "../state/coordinator"; // type-only (no runtime cycle: coordinator.ts does not import proxy.ts)
// …field: private readonly _coordinator?: TransitionCoordinator;
// ctor 11th param (after replacementStartupTimeoutMs): coordinator?: TransitionCoordinator
```

- `import type` → no runtime import cycle (coordinator.ts imports only `../diagnostics` type).
- The proxy ONLY calls `coordinator?.setActiveProxy(undefined)` on cleanup (T3's contract).
  It does NOT call `setActiveProxy(this)` on construct — that is the DECORATOR's job
  (coordinator.ts JSDoc: "the ProviderDecorator … calls setActiveProxy on proxy construct").
- OUT OF T3 SCOPE: the decorator/factory wiring that creates a session coordinator, registers
  the shortcut, passes the coordinator into each proxy, and calls `setActiveProxy(proxy)` on
  construct. That is the Pi-extension integration layer (appropriately P1.M8 / a wiring task).
  T3 adds the HOOK + tests it via a real TransitionCoordinator passed directly. Production
  omits the param (undefined → cleanup's coordinator call is a safe no-op) until that wiring.

No existing caller breaks: the decorator's 5-arg `new StreamProxy(model, context, options,
originalStreamSimple, diagnostics)` and every test's positional ctor are unchanged
(coordinator is the 11th, optional, defaults undefined).

## §7. "Null out abort controllers" — what is actually possible (§44 honesty note)

- `_internalAbort` is declared `private readonly _internalAbort: AbortController` (constructed
  inline in the field initializer). It CANNOT be reassigned without changing the field's
  mutability. By cleanup time it is ALREADY `abort()`ed (consumed by `triggerStop`); a readonly
  aborted controller is a tiny object released when the per-request proxy is GC'd. T3 does NOT
  make it mutable (no benefit; it's aborted). Document this.
- `_replacementAbort` is mutable (`private _replacementAbort: AbortController | undefined`).
  T3 sets it to `undefined` in `_terminate` → reference released (GC-eligible).
- The REAL leak sources are the setTimeout HANDLES (`_abortTimer`, `_replacementStartupTimer`).
  `_terminate` calls `_clearAbortTimeout()` + `_clearReplacementTimeout()` — these are the
  allocations §44 most cares about. (A leaked timer keeps the proxy + closure alive.)
- `output` (proxy queue) completes naturally when the terminal is pushed (`push(done/error)`
  sets `done=true`); nothing to release beyond what T2 already guarantees. Per-request → GC'd.

## §8. Test assertion leverage — `coordinator.clear-active` trace

`coordinator.ts setActiveProxy(undefined)` emits `diagnostics.trace("coordinator.clear-active", {})`
(and `setActiveProxy(proxy)` emits `coordinator.set-active`). So the integration test passes a
REAL `TransitionCoordinator` sharing the capturing diag, calls `coordinator.setActiveProxy(proxy)`
upfront (simulating the decorator), drives the lifecycle, then asserts:
- `events.some(c => c.event === "coordinator.clear-active")` → proves `setActiveProxy(undefined)`
  ran on cleanup.
- `events.filter(c => c.event === "proxy.lifecycle.cleanup").length === 1` → INV-010 (once).
- `buffer.snapshot()` is empty after cleanup (reset worked) — assert via an injected buffer.
- FSM ends in `Idle` (success path) / `Idle` (failure path).

## §9. Validation commands (verified against package.json)

- `npx bun run typecheck` → `tsc --noEmit` (tsconfig `strict`+`isolatedModules`+`target ES2022`).
- `npx bun run build` → `tsc` (emits `dist/`).
- `npx bun test` → runs every `tests/**/*.test.ts`.

## §10. Scope boundary — what T3 does NOT touch

- `src/types.ts`, `src/state/controller.ts`, `src/state/coordinator.ts`, `src/buffer/index.ts`,
  `src/request/builder.ts`, `src/config/index.ts`, `src/diagnostics/index.ts`,
  `src/shortcut/index.ts`, `src/index.ts`, `src/provider/decorator.ts` → UNCHANGED.
- T2's `_emit` method body (filtering rules) → UNCHANGED (T3 calls it, doesn't redefine it).
- The authority flip ordering in the replacement loop → PRESERVED (T3 adds AFTER `_emit`).
- Decorator/factory coordinator+shortcut wiring → out of scope (§6).
- Full FM-001..FM-015 failure-mode hardening → P1.M8.T2.
- Telemetry module → P1.M8.T1.
- Stress/chaos/property tests → P1.M8.T4.
