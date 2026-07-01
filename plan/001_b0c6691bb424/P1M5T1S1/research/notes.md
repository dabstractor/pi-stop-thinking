# Research Notes — P1.M5.T1.S1: AbortController wrapper & upstream stream abort handling

Scope: add the internal `AbortController` + `triggerStop()` abort path to `StreamProxy` so a stop request
gracefully aborts the UPSTREAM reasoning stream (without aborting Pi's overall request), freezes the
reasoning buffer, and transitions the FSM `Reasoning → StopRequested → Aborting → Capturing`.

---

## 1. Codebase facts (all verified by reading source)

### 1.1 StreamProxy today — `src/provider/proxy.ts` (the file to MODIFY)

- Constructor signature: `constructor(model, context, options, upstreamStreamFn, diagnostics, controller?, buffer?)`.
  Adding an **8th optional param** `abortTimeoutMs?` (default `DEFAULT_CONFIG.transitionTimeoutMs`) is
  backward-compatible — the decorator calls it with **5 args** (`new StreamProxy(model, context, options ?? {},
  originalStreamSimple, this.diagnostics)` in `src/provider/decorator.ts`).
- Fields today: `_output`, `diagnostics`, `_controller`, `_buffer`. **NO** internal abort controller, **NO**
  abort timer. `run()` does `const upstream = upstreamStreamFn(model, context, options)` then
  `for await (const event of upstream) { this.trackEvent(event); this._output.push(event); }`.
- `run()`'s catch synthesizes ONE terminal `error` event on any throw (single-terminal invariant).
- `isReasoning()` EXISTS (returns `controller.getState() === "Reasoning"`).
- `canInterrupt()` / `isInterrupting()` / `triggerStop()` do **NOT** exist — this subtask adds them.
- The proxy already `import { DEFAULT_CONFIG } from "../config"` (used for the buffer ceiling) — reuse it
  for `transitionTimeoutMs`. **No new imports** (AbortController/setTimeout are globals in bun/node).

### 1.2 TransitionController — `src/state/controller.ts` (DONE / IMMUTABLE — do NOT modify)

All the FSM moves this subtask needs ALREADY EXIST as public methods:
- `canInterrupt(): boolean` — true ONLY in `Reasoning` (PRD §22.5).
- `requestStop(): boolean` — `Reasoning → StopRequested` (returns false outside Reasoning; PRD §16).
- `beginAbort(): void` — `StopRequested → Aborting` (throws if not StopRequested; PRD §16).
- `completeAbort(): void` — `Aborting → Capturing` (throws if not Aborting; PRD §16).
- `fail(reason: string): void` — `Any → Failed`, NEVER throws (PRD §16).
- `getState(): TransitionState`.
Because `triggerStop()` calls `canInterrupt()` (true ⇒ Reasoning) BEFORE `requestStop()`/`beginAbort()`,
both transitions are table-legal and **cannot throw** in the happy path.

### 1.3 ReasoningBuffer — `src/buffer/index.ts` (DONE / IMMUTABLE)

- `freeze()` EXISTS, is **idempotent** (never throws), makes `append()` throw (PRD §41). Call it exactly once
  at the Aborting→Capturing boundary. Privacy: `buffer.frozen` debug logs counts/bytes only.

### 1.4 TransitionCoordinator — `src/state/coordinator.ts` (parallel P1.M4.T4.S1 — treat as DONE contract)

Defines the `ActiveProxy` structural interface (the dependency-inversion seam the coordinator delegates to):
```ts
export interface ActiveProxy {
  isReasoning(): boolean;   // PRESENT on StreamProxy today
  canInterrupt(): boolean;  // THIS subtask adds to StreamProxy
  triggerStop(): boolean;   // THIS subtask adds to StreamProxy
  isInterrupting(): boolean;// THIS subtask adds to StreamProxy
}
```
The coordinator's `requestStop()` flow: `if (!proxy.canInterrupt()) return false; ... proxy.triggerStop()`.
So **StreamProxy must satisfy `ActiveProxy` structurally** — add `canInterrupt()`/`isInterrupting()`/
`triggerStop()`. The coordinator already wraps `triggerStop()` in try/catch (never-crash), so a defensive
return is secondary. **Do NOT modify coordinator.ts.**

### 1.5 Config — `src/config/index.ts` (DONE / IMMUTABLE)

- `transitionTimeoutMs: number` default `5000` (PRD §43 "Transition timeout: configurable"). This is the
  FM-006 abort-timeout ceiling. Read via `DEFAULT_CONFIG.transitionTimeoutMs`.

### 1.6 pi-ai types — `node_modules/@earendil-works/pi-ai/dist/types.d.ts`

- `SimpleStreamOptions extends StreamOptions`; `StreamOptions` has `signal?: AbortSignal` (line 92).
- `ApiStreamSimpleFunction = (model, context, options?) => AssistantMessageEventStream`.
- ⇒ The proxy can inject its OWN signal: `upstreamStreamFn(model, context, { ...options, signal: internal.signal })`.
  The real provider's stream observes `signal` and aborts its async iterator when it fires (standard fetch/
  AbortController semantics). In tests the mock must replicate this (§3).

---

## 2. The abort error-propagation mechanism (the core contract point)

Pi passes its OWN abort signal on `options.signal` (user escape / ctrl+c). The proxy must **NOT** pass that
signal straight to the upstream — aborting it would also be abortable only via Pi's signal. Instead the proxy
creates its **OWN** internal `AbortController` so `triggerStop()` can abort the reasoning stream **WITHOUT**
aborting Pi's overall request. Pi's escape is preserved by **propagating** `options.signal.aborted` into the
internal controller (one-way fan-in):

```ts
// constructor
this._internalAbort = new AbortController();
const external = options?.signal;
if (external) {
  if (external.aborted) this._internalAbort.abort();
  else external.addEventListener("abort", () => this._internalAbort.abort(), { once: true });
}
// run()
const upstream = upstreamStreamFn(model, context, { ...options, signal: this._internalAbort.signal });
```

When `triggerStop()` calls `this._internalAbort.abort()`, the upstream's async iterator **throws an abort
error** (real provider: `AbortError`; mock: any Error). That throw is caught by `run()`'s existing try/catch.
The NEW logic in that catch: **if `controller.getState() === "Aborting"`** this is the *expected* abort exit
(PRD §51 Abort Phase: "Dispatch Abort → Await Upstream Exit → Capture Final Reasoning → Freeze Buffer"):
clear the timeout, `controller.completeAbort()` (→ Capturing), `buffer.freeze()`, and **return without
synthesizing a terminal** — the replacement stream (P1.M6/P1.M7) owns the downstream terminal; output stays
OPEN while the transition is in flight.

### T1 / T2 boundary (CRITICAL — do NOT cross it here)

- **FM-005 (abort races completion)** = **P1.M5.T2** ("Race detection: completion wins over abort"). If the
  upstream completes **naturally** (for-await exits with NO throw) after `triggerStop()` set `Aborting` +
  started the timeout, `run()`'s catch never runs, so `completeAbort`/`freeze` never run and the timeout will
  eventually fire → `Failed`. That race is resolved in **T2** (detect natural completion, let it win). **T1
  implements the clean-abort path + the timeout only.** Do NOT add completion-wins logic here.
- Note also: P1.M4 left the controller in `Reasoning` after a normal `done` (§16 has no Reasoning→Completed
  exit). So `canInterrupt()` is still `true` after a natural completion. T2 owns detecting "stream already
  drained". T1 follows the contract literally (gate on `canInterrupt()` only).

---

## 3. Mock patterns (reference implementations for the test suite)

The existing suites (`tests/stream-proxy-detection.test.ts`) use a **real** `createAssistantMessageEventStream`
as the upstream and push events to it. That does NOT work for abort tests — a real stream does not observe any
`AbortSignal`, so aborting the internal controller would not make its iterator throw. We need a custom
async-iterable mock that listens to the injected signal. Copy `makeCaptureDiag()`/`makeModel()`/`ev()` from
`tests/stream-proxy-detection.test.ts` verbatim.

### 3.1 Abortable upstream (clean-abort happy path) — yields queued events, THROWS on abort

```ts
/** Async-iterable mock: yields queued events; when the injected signal aborts, the iterator throws
 *  (replicating a real provider aborting on signal.abort). */
function makeAbortableUpstream() {
  let signal: AbortSignal | undefined;
  const queue: AssistantMessageEvent[] = [];
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (signal?.aborted) throw new Error("aborted"); // AbortError-like
        if (queue.length > 0) { yield queue.shift()!; continue; }
        // Block until a new event arrives OR the signal aborts.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 0);
          signal?.addEventListener(
            "abort",
            () => { clearTimeout(t); reject(new Error("aborted")); },
            { once: true },
          );
        });
      }
    },
  };
  const fn = ((_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    signal = opts?.signal;          // proxy passes { ...options, signal: internal.signal }
    return iterable;
  }) as unknown as ApiStreamSimpleFunction;
  return {
    fn,
    push: (e: AssistantMessageEvent) => queue.push(e),
    isAborted: () => !!signal?.aborted,
  };
}
```

### 3.2 Unresponsive upstream (FM-006 timeout) — ignores abort, blocks until released

```ts
/** Mock that IGNORES the abort signal and blocks forever until released (simulates FM-006:
 *  provider ignores abort). The test releases it AFTER asserting the timeout → Failed. */
function makeUnresponsiveUpstream() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const queue: AssistantMessageEvent[] = [];
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (queue.length > 0) yield queue.shift()!;
      await gate; // never observes the signal; test calls release() to let run() exit
    },
  };
  const fn = ((_m: unknown, _c: unknown, _opts?: unknown) => iterable) as unknown as ApiStreamSimpleFunction;
  return { fn, push: (e: AssistantMessageEvent) => queue.push(e), release };
}
```

### 3.3 Polling helper (deterministic wait for the async catch/timeout)

Because `run()` is fire-and-forget and the abort throw / timeout fire asynchronously, assert via polling:

```ts
async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}
```

---

## 4. Required test cases (mapping to the work-item MOCKING + PRD failure modes)

1. **Clean abort (happy path, §51 Abort Phase):** push `start`,`thinking_start`,`thinking_delta`; wait until
   `proxy.isReasoning()`; `triggerStop()` → `true`; wait until `controller.getState()==="Capturing"`; assert
   `buffer` frozen (append throws / or `proxy.abort.completed` traced), `mock.isAborted()===true`, and that
   **no terminal was synthesized** (output left open — do NOT fully drain a consumer).
2. **triggerStop outside Reasoning → false:** before any event (Idle) `triggerStop()` returns `false`, no
   abort dispatched (`mock.isAborted()===false`), state unchanged.
3. **First-press-wins / isInterrupting:** after `triggerStop()` (→ Aborting/Capturing), a second
   `triggerStop()` returns `false` (canInterrupt now false); `isInterrupting()` true.
4. **canInterrupt()/isInterrupting() delegation:** canInterrupt true only in Reasoning; isInterrupting true
   in StopRequested/Aborting/Capturing/.../Answering.
5. **FM-006 timeout:** unresponsive mock + injected `abortTimeoutMs: 20`; `triggerStop()` → `true`; wait
   until `controller.getState()==="Failed"`; assert `proxy.abort.timeout` warned; then `release()` to let
   `run()` exit (no dangling handle). Buffer NOT frozen on this path.
6. **Pi's escape still works (signal propagation):** construct proxy with `options.signal` from an external
   `AbortController`; `external.abort()`; wait; assert the upstream mock's injected signal is aborted
   (`mock.isAborted()===true`) — Pi's escape reaches the upstream without any `triggerStop()`.
7. **Normal forwarding unchanged (regression):** a complete non-aborted stream (incl. `done`) forwards every
   event unchanged with exactly one terminal — proves the abort machinery does not alter the transparent path.
   (Existing suites already cover this; add one focused assertion in the new file.)

---

## 5. Things explicitly OUT OF SCOPE (owned by other subtasks — do NOT implement)

- Factory/decorator wiring of `coordinator.setActiveProxy(proxy)` + shortcut registration → **P1.M5**
  (needs `triggerStop` to exist so `StreamProxy` is assignable to `ActiveProxy` — which this subtask delivers).
- FM-005 completion-wins race detection → **P1.M5.T2**.
- Replacement request (RequestBuilder) + stream splicing + downstream terminal after Capturing → **P1.M6/P1.M7**.
- Full FM-006 "normal stream preserved" recovery + all FM-001..FM-015 → **P1.M8.T2**.
- Any change to `coordinator.ts`, `controller.ts`, `buffer/`, `decorator.ts`, `config/`, `shortcut/`,
  `index.ts`, `types.ts`, or any existing test. No new dependencies.
