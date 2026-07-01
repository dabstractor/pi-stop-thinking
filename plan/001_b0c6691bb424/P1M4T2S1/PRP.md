# PRP — P1.M4.T2.S1: StreamProxy reasoning event tracking and state transitions (`src/provider/proxy.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M4.T2.S1 (Phase 3 Reasoning Detection, 2 pts) — wire **reasoning detection** into the
> `StreamProxy`'s `run()` event loop. The proxy already forwards every upstream event transparently
> (P1.M2.T2.S1); now it must ALSO drive `TransitionController` state transitions (PRD §15/§16 FSM) and
> populate the `ReasoningBuffer` (PRD §13.4/§23) as a **pure side effect** — *forwarding is UNCHANGED*
> (PRD §19.7 / ADR-005 observational equivalence). PRD authority: §22 Reasoning Detection (§22.3 enter on
> `thinking_start` OR first `thinking_delta`; §22.4 leave on `thinking_end` / first answer token /
> completion; §22.5 shortcut active only in `Reasoning`), §16 State Transition Table, §38 Event Ordering,
> §39 Transition Event Rules, §51 Stream Processing Loop, §13.2 Stream Proxy guarantees.
> **Builds on** (inputs, all DONE & immutable — do NOT modify): `StreamProxy` from **P1.M2.T2.S1**
> (`src/provider/proxy.ts`), `TransitionController` from **P1.M3.T1.S1** (`src/state/controller.ts` — incl.
> the exported `ALLOWED_TRANSITIONS` map), `ReasoningBuffer` from **P1.M4.T1.S1** (`src/buffer/index.ts`),
> `DEFAULT_CONFIG.maximumReasoningBufferBytes` from **P1.M1.T2.S1**, `Diagnostics` from **P1.M1.T3.S1**,
> and the event vocabulary / `TransitionState` from **P1.M2.T1.S1** (`src/types.ts`).
> **Consumed by**: P1.M4.T4 (TransitionCoordinator queries reasoning state via `proxy.isReasoning()`),
> P1.M5 (abort coordination reaches `proxy.controller` / `proxy.buffer`), P1.M6 (RequestBuilder reads
> `proxy.buffer.snapshot()`).

---

## Goal

**Feature Goal**: Extend `StreamProxy.run()` so that, **before** forwarding each upstream event
unchanged, it classifies the event and drives the `TransitionController` FSM + appends reasoning deltas to
the `ReasoningBuffer` as a side effect — implementing PRD §22 reasoning detection inside the proxy. The
proxy must (a) enter `Reasoning` on the first `thinking_start` OR first `thinking_delta` (PRD §22.3),
(b) append every `thinking_delta.delta` to the buffer while in `Reasoning` (PRD §13.4/§23.2), (c) drive the
terminal transitions (`error`→`Failed`→`Idle`; `done`→`Completed`→`Idle`) **guarded** so a normal
non-interrupted stream never throws, and (d) **preserve byte-for-byte forwarding** (PRD §19.7 / ADR-005 —
detection adds side effects only; it never drops, reorders, duplicates, or alters an event).

**Deliverable** (ONE source file MODIFIED + ONE test file CREATED; NO other files change):
- `src/provider/proxy.ts` — MODIFY `StreamProxy`: ctor gains optional `controller?: TransitionController`
  + `buffer?: ReasoningBuffer` (default-created so existing callers are untouched); new private
  `trackEvent(event)` invoked before each `push` in `run()`; new private `transitionIfLegal(target)`
  helper; new public `isReasoning(): boolean` + `get controller()` / `get buffer()` accessors. New value
  imports: `TransitionController` + `ALLOWED_TRANSITIONS` (from `../state/controller`), `ReasoningBuffer`
  (from `../buffer`), `DEFAULT_CONFIG` (from `../config`); new type import `TransitionState` (from
  `../types`). Mode-A JSDoc updates citing PRD §22/§16/§13.2.
- `tests/stream-proxy-detection.test.ts` — NEW `bun:test` suite: inject a `TransitionController` +
  `ReasoningBuffer` (test owns the refs), replay thinking event sequences through the proxy, and assert
  (1) the controller REACHES `Reasoning`, (2) the buffer ACCUMULATES deltas in order, (3) forwarding is
  byte-for-byte unchanged with detection active, (4) a no-reasoning stream never enters `Reasoning` /
  leaves the buffer empty, (5) `error` cleanly resets to `Idle`, (6) a normal `done` throws nothing and
  emits no spurious `transition.illegal` warn, (7) reasoning-enter is idempotent.

**Success Definition**: From a clean checkout, `npx bun run typecheck` → **0** diagnostics;
`npx bun run build` → exit 0; `npx bun test` → **ALL green** — the new `stream-proxy-detection.test.ts`
PLUS the **9 existing suites with ZERO changes and ZERO regressions** (critically `stream-proxy.test.ts`
and `golden/golden-replay.test.ts` stay byte-identical and green, proving detection did not alter
forwarding). A replay of `start→thinking_start→thinking_delta×N→…→done` leaves the controller in
`Reasoning` (reached on the first thinking event) and the buffer holding exactly the N deltas in order; a
replay with no thinking events leaves the controller in `Delegating` and the buffer empty; an `error`
replay leaves the controller reset to `Idle`. No edits to any file other than `src/provider/proxy.ts` +
the new `tests/stream-proxy-detection.test.ts`.

---

## User Persona (if applicable)

**Target User**: Downstream modules of this extension (the **developer/maintainer**) — this is an internal
detection layer with no direct end-user surface.

**Use Case**: While the proxy forwards z.ai's reasoning stream to Pi, it simultaneously tracks "is the
model reasoning right now?" (FSM `Reasoning` state) and captures the reasoning text (buffer) so that, when
the user later presses the stop shortcut, the TransitionCoordinator (P1.M4.T4) can decide whether the
shortcut is valid and the abort/replacement flow (P1.M5/P1.M6) has the captured reasoning to reuse.

**User Journey**: (1) ProviderDecorator routes an eligible z.ai reasoning request through `StreamProxy`.
(2) The proxy forwards every event to Pi unchanged AND, as a side effect, walks `Idle→Delegating→Reasoning`
and appends `thinking_delta` text to the buffer. (3) When reasoning ends / the stream completes, the proxy
handles the terminal defensively (no throw). (4) P1.M4.T4's coordinator queries `proxy.isReasoning()` to
gate the shortcut; P1.M5 reaches `proxy.controller`/`proxy.buffer` to abort + freeze.

**Pain Points Addressed**: Without in-proxy detection there is no signal for "reasoning is active" and no
captured reasoning to reuse — the stop shortcut could fire at the wrong time and the replacement request
would lose the model's reasoning context. Detection inside the single forwarding loop is the only place
that observes every provider event in order (ADR-002: the agent loop is the wrong layer).

## Why

- **This is the sensing layer of the whole feature.** PRD §22.2: "Reasoning state shall be inferred
  exclusively from provider events. No timers. No heuristics. No polling." The proxy's `run()` loop is the
  sole consumer of the ordered provider event stream (PRD §20.6 single authoritative upstream), so it is
  the only correct place to detect reasoning. Until this subtask lands, the FSM (P1.M3.T1.S1) and buffer
  (P1.M4.T1.S1) are inert — nothing drives them.
- **Forwarding must stay observationally equivalent.** PRD §19.7 / ADR-005: the wrapper must be
  observationally equivalent. Detection is a PURE SIDE EFFECT — it never touches what reaches Pi. The
  implementation makes this structural: `trackEvent(event); this._output.push(event);` where `trackEvent`
  only reads `event`, drives guarded transitions + buffer appends, and swallows its own errors so a
  tracking fault can never alter output.
- **It must not throw on normal streams.** The FSM (PRD §16) models the *interruption* lifecycle and has
  no normal-completion exit from `Reasoning` (see "Known Gotchas"). A naive `transition("Completed")` on a
  normal `done` would throw `Illegal state transition`. The proxy drives transitions **guarded** via the
  exported `ALLOWED_TRANSITIONS` map so every normal stream completes cleanly.
- **It composes the two existing building blocks without modifying them.** Controller + buffer are DONE
  and immutable. The proxy OWNS one instance of each per request (matching their JSDocs:
  `controller.ts` → "constructed by StreamProxy (P1.M4)"; `buffer/index.ts` → "StreamProxy (P1.M4.T2 —
  owns the per-request instance)"), wired in as optional constructor params with internal defaults.

## What

### Source: MODIFY `src/provider/proxy.ts`

**New imports** (add to the existing import block):
- `import { TransitionController, ALLOWED_TRANSITIONS } from "../state/controller";` (values — the class
  + the exported §16 adjacency map).
- `import { ReasoningBuffer } from "../buffer";` (value — the class).
- `import { DEFAULT_CONFIG } from "../config";` (value — frozen constant; only `maximumReasoningBufferBytes`
  is read, for the default buffer ceiling).
- Extend the existing `import type { AssistantMessageEvent } from "../types";` to also import
  `TransitionState`: `import type { AssistantMessageEvent, TransitionState } from "../types";`.

**New private fields** (alongside the existing `private readonly _output`):
- `private readonly _controller: TransitionController;`
- `private readonly _buffer: ReasoningBuffer;`

**Constructor** — add two OPTIONAL trailing params (after `diagnostics`) so every existing 5-arg caller
(`decorator.ts`, the forwarding tests, the golden replay harness) is **unchanged**:
```ts
constructor(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  upstreamStreamFn: ApiStreamSimpleFunction,
  diagnostics: Diagnostics,
  controller?: TransitionController,        // default: new TransitionController(diagnostics)
  buffer?: ReasoningBuffer,                  // default: new ReasoningBuffer(diagnostics, 8 MiB)
) {
  this.diagnostics = diagnostics;
  this._output = createAssistantMessageEventStream();
  this._controller = controller ?? new TransitionController(diagnostics);
  this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);
  void this.run(model, context, options, upstreamStreamFn);
}
```
(Default buffer ceiling = `DEFAULT_CONFIG.maximumReasoningBufferBytes` = 8 MiB — the config default; this
is exactly what production wants, so `decorator.ts` needs NO change.)

**New public accessors** (forward-compatible for P1.M4.T4/P1.M5/P1.M6):
- `get controller(): TransitionController` → `return this._controller;`
- `get buffer(): ReasoningBuffer` → `return this._buffer;`
- `isReasoning(): boolean` → `return this._controller.getState() === "Reasoning";` (PRD §22.5 — the query
  P1.M4.T4's TransitionCoordinator delegates to).

**New private `transitionIfLegal(target: TransitionState): boolean`** — the guarded driver. Consults the
exported §16 map; transitions only when legal; never throws; never triggers the controller's
`transition.illegal` warn path:
```ts
private transitionIfLegal(target: TransitionState): boolean {
  const allowed = ALLOWED_TRANSITIONS.get(this._controller.getState());
  if (allowed && allowed.has(target)) {
    this._controller.transition(target); // pre-validated legal → cannot throw / cannot warn
    return true;
  }
  return false; // unreachable from current state (e.g. normal-flow Reasoning→Completed) → skip
}
```

**New private `trackEvent(event: AssistantMessageEvent): void`** — the per-event side-effect driver,
invoked once per event in `run()` BEFORE the unchanged `push`. Body (every transition is guarded; the whole
body is wrapped in try/catch so a tracking fault can NEVER break forwarding):
```ts
private trackEvent(event: AssistantMessageEvent): void {
  try {
    // 1. Stream begins → Delegating (PRD §16 Idle→Delegating; guarded on Idle → enters once).
    if (event.type === "start" && this._controller.getState() === "Idle") {
      this.transitionIfLegal("Delegating");
    }
    // 2. Enter Reasoning on the FIRST thinking event (PRD §22.3: thinking_start OR first thinking_delta;
    //    PRD §16 Delegating→Reasoning; guarded on Delegating → enters exactly once).
    if (
      (event.type === "thinking_start" || event.type === "thinking_delta") &&
      this._controller.getState() === "Delegating"
    ) {
      this.transitionIfLegal("Reasoning");
    }
    // 3. Accumulate reasoning deltas while Reasoning (PRD §13.4/§23.2; gated on Reasoning state).
    //    event.type === "thinking_delta" narrows the union → event.delta: string.
    if (event.type === "thinking_delta" && this._controller.getState() === "Reasoning") {
      this._buffer.append(event.delta);
    }
    // 4. Terminals (PRD §16). error → Any→Failed (fail never throws) → Failed→Idle. done → Completed→Idle
    //    ONLY when legal (the interrupted flow reaches Answering→Completed in P1.M5–P1.M7). In the NORMAL
    //    flow the FSM has no Reasoning→Completed exit (§16 models the interruption lifecycle), so done is
    //    a guarded no-op and the per-request controller is left in its legal state (then discarded).
    if (event.type === "error") {
      this._controller.fail("upstream-error"); // Any→Failed, always legal, never throws
      this.transitionIfLegal("Idle");           // Failed→Idle (reset)
    } else if (event.type === "done") {
      if (this.transitionIfLegal("Completed")) { // legal only from Answering (interrupted flow)
        this.transitionIfLegal("Idle");           // Completed→Idle (reset)
      }
    }
    // NOTE (PRD §22.4 "leave reasoning on thinking_end / first answer token"): the FSM (§16) defines no
    // normal Reasoning exit, so thinking_end / text_start / toolcall_start perform NO transition here.
    // Reasoning detection therefore remains Reasoning-true until the stream terminates. Acceptable in
    // P1.M4 (no shortcut/coordinator wired); reconciled when the interruption flow (Reasoning→
    // StopRequested, P1.M5) is the active path. See PRP "Known Gotchas".
  } catch (err) {
    // Tracking MUST NEVER break forwarding (observational equivalence — ADR-005/§19.7). Log the fault
    // (event.type ONLY — never content, Appendix H) and swallow; run()'s push still executes.
    this.diagnostics.warn("proxy.tracking-error", {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

**MODIFY `run()`'s loop** — insert one `trackEvent(event)` call before the unchanged `push`. Nothing else
in `run()` changes (the try/catch + synthesized-error safety net stay exactly as P1.M2.T2.S1 wrote them):
```ts
const upstream = upstreamStreamFn(model, context, options);
for await (const event of upstream) {
  this.trackEvent(event);   // side-effect tracking only; never throws; never mutates `event`
  this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
}
```

### Test: CREATE `tests/stream-proxy-detection.test.ts`

A `bun:test` suite (`import { describe, test, expect } from "bun:test"`) that injects a
`TransitionController` + `ReasoningBuffer` the test owns (so it can inspect state + buffer directly),
replays event sequences via a small async `drive()` helper (adapted from `tests/stream-proxy.test.ts`),
and asserts the detection contract. A capturing `Diagnostics` stub (adapted from
`tests/transition-controller.test.ts` / `tests/reasoning-buffer.test.ts`) records warns so the suite can
prove no spurious `transition.illegal` fires. Coverage:
- **Reaches `Reasoning`** on `thinking_start` (replay start→thinking_start→…; assert
  `controller.getState()==="Reasoning"` after the thinking event; also `proxy.isReasoning()===true`).
- **Reaches `Reasoning` on first `thinking_delta`** when there is no `thinking_start` (PRD §22.3 second
  trigger).
- **Buffer accumulates** `thinking_delta.delta` in order with correct content; `getByteSize()` === Σ
  lengths; `snapshot().map(e=>e.content)` equals the deltas in order.
- **Forwarding byte-for-byte unchanged WITH detection active** — drain `proxy.output` and assert the
  observed event types equal the replayed sequence exactly (the transparency proof; mirrors the golden
  replay assertion but with injected detection deps).
- **No-reasoning stream** (start→text_start→text_delta→done) → controller goes `Idle→Delegating` only
  (never `Reasoning`); buffer stays empty (`snapshot().length===0`, `getByteSize()===0`).
- **`error` terminal** (start→error) → controller ends at `Idle` (`fail("upstream-error")`→`Failed`→
  `reset`→`Idle`); no throw.
- **Normal `done`** (start→thinking_start→thinking_delta→thinking_end→text_start→text_delta→done) → NO
  throw, NO `transition.illegal` warn captured, controller left in `Reasoning` (the documented §16
  normal-flow gap), buffer holds the delta.
- **Reasoning-enter is idempotent** — many `thinking_start`/`thinking_delta` events transition into
  `Reasoning` exactly once (guarded on `Delegating`); `transition.state-change` traces show exactly one
  `Delegating→Reasoning`.
- **Injected collaborators are used** — `proxy.controller === injectedController`,
  `proxy.buffer === injectedBuffer`, and the injected buffer is the one that accumulates.

**Out of scope** (owned by other subtasks — do NOT implement here):
- **ShortcutManager / TransitionCoordinator** (the `requestStop()` consumer of `isReasoning()`) → P1.M4.T3
  / P1.M4.T4.
- **Abort / `buffer.freeze()`** (Reasoning→StopRequested→Aborting→Capturing; freeze at the
  Aborting→Capturing boundary) → P1.M5.T1.S1. The proxy's `done→Completed` guarded branch is a forward-
  compat hook for that flow; it is a no-op in this phase.
- **Replacement request / `buffer.snapshot()` consumption** → P1.M6.T1.S1.
- **Modifying the FSM** (`ALLOWED_TRANSITIONS`, `controller.ts`) → FORBIDDEN (P1.M3.T1.S1 is DONE).
- **Modifying `decorator.ts`** → NOT NEEDED (the proxy self-creates controller+buffer via the optional
  defaults; the existing `new StreamProxy(model, context, options ?? {}, originalStreamSimple, this.
  diagnostics)` call keeps working unchanged).
- Any change to `src/buffer/*`, `src/config/*`, `src/state/*`, `src/types.ts`, `src/diagnostics/*`,
  `src/index.ts`, `tests/stream-proxy.test.ts`, `tests/golden/*`, `package.json`, `tsconfig.json`,
  `.gitignore`. No new deps.

### Success Criteria

- [ ] `src/provider/proxy.ts` ctor accepts optional `controller?` + `buffer?` (defaults create real
      `TransitionController(diagnostics)` + `ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoning
      BufferBytes)`); existing 5-arg call sites compile & behave unchanged.
- [ ] `run()` calls `trackEvent(event)` immediately before the unchanged `this._output.push(event)`.
- [ ] `trackEvent` enters `Reasoning` on the first `thinking_start` OR first `thinking_delta` (guarded on
      `Delegating` → exactly once); appends `event.delta` to the buffer for every `thinking_delta` while in
      `Reasoning`; handles `error`→`Failed`→`Idle` and `done`→`Completed`→`Idle` (guarded) — and NEVER
      throws on a normal stream.
- [ ] `transitionIfLegal` pre-checks `ALLOWED_TRANSITIONS` and skips illegal targets (no throw, no
      `transition.illegal` warn).
- [ ] New public `isReasoning()` + `get controller()` + `get buffer()` accessors present + Mode-A JSDoc.
- [ ] `tests/stream-proxy-detection.test.ts` covers every bullet above (reaches Reasoning both ways,
      buffer accumulates, forwarding unchanged, no-reasoning, error reset, normal-done no-throw/no-warn,
      idempotent enter, injected-identity).
- [ ] `npx bun run typecheck` → **0** diagnostics; `npx bun run build` → exit 0; `npx bun test` → ALL green
      (new suite + the 9 existing suites, NO regressions; `stream-proxy.test.ts` + `golden-replay.test.ts`
      byte-identical & green).
- [ ] No edits outside `src/provider/proxy.ts` + the new `tests/stream-proxy-detection.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact** current `StreamProxy` ctor + `run()` (the file being modified),
the **exact** `TransitionController` API (`transition`/`getState`/`fail`/`reset` + the exported
`ALLOWED_TRANSITIONS`), the **exact** `ReasoningBuffer.append(delta)` contract, the **verified**
`thinking_delta` → `delta` field name (from `tests/golden/fixtures.ts`), the **complete** new code
(`trackEvent` / `transitionIfLegal` / accessors / modified loop / new imports), the **critical** §16-vs-§22
design constraint + its resolution, and the **verified** build/test commands. Every design ambiguity
(optional vs required DI, getter vs private, guarded vs try/catch, normal-flow `done` handling, the
thinking_end no-transition gap) is resolved in "Known Gotchas" + `research/notes.md`.

### Documentation & References

```yaml
# PRD authority (PRD.md in repo root)
- url: PRD.md §22 "Reasoning Detection"
  why: "THE charter for this subtask. §22.2 'inferred exclusively from provider events. No timers. No
        heuristics. No polling.' §22.3 enter on thinking_start OR first thinking_delta. §22.4 leave on
        thinking_end / first answer token / provider completion. §22.5 shortcut active only while
        State == Reasoning."
  critical: "§22.3 is the ENTER rule the proxy implements (first thinking_start OR first thinking_delta).
        §22.4's 'leave' events have NO FSM transition in §16 for the normal flow — see Known Gotchas
        (this is a real §16↔§22 tension; resolved defensively, not by editing the FSM)."
- url: PRD.md §16 "State Transition Table"
  why: "THE legality table. Idle→Delegating (stream begins); Delegating→Reasoning (first thinking event);
        Reasoning→StopRequested (shortcut only); Answering→Completed (message_end); Any→Failed; Completed/
        Failed→Idle. The proxy drives ONLY these, guarded via ALLOWED_TRANSITIONS."
  critical: "Reasoning has NO normal exit (only StopRequested/Failed). So transition('Completed') on a
        normal done is ILLEGAL and would throw — the proxy MUST guard it (transitionIfLegal). This is the
        single most important gotcha."
- url: PRD.md §15 "State Machine" (states + descriptions)
  why: "Defines Reasoning = 'Reasoning events currently flowing. Shortcut becomes active.' and Delegating =
        'forwarding events without modification.' These are the two states the normal flow visits."
- url: PRD.md §13.2 "Stream Proxy" (Guarantees) + §20 "Stream Proxy Design"
  why: "The single-output / single-terminal / single-result invariants the detection logic MUST NOT
        disturb. Detection is a pure side effect layered onto the existing forwarding loop."
  critical: "Forwarding invariants are preserved by construction: trackEvent(e) runs, then push(e) runs
        unchanged. trackEvent never mutates `event` and never throws out to run()'s catch."
- url: PRD.md §19.7 "Pass-through Guarantee" + ADR-005
  why: "Observational equivalence mandate — the wrapper must be indistinguishable from the built-in. The
        golden replay test encodes this as a byte-for-byte assertion; it MUST stay green."
- url: PRD.md §38 "Event Ordering Specification" + §39 "Transition Event Rules"
  why: "Legal event sequence (message_start→thinking_start→thinking_delta*→thinking_end?→text_start→…
        →message_end) and the rule that during transition the proxy may suppress — NOT in this phase
        (forwarding is unconditional). Confirms thinking events precede text events."
- url: PRD.md §51 "Complete Transition Algorithm" → Stream Processing Loop
  why: "Receive Event → Normalize → Validate → Forward → Continue (until interruption). This subtask adds
        the 'detect reasoning + track state' step into that loop, before Forward."
- url: PRD.md §13.4 / §23 "Reasoning Buffer"
  why: "append-only, ordered, opaque — append(delta) while mutable. The proxy appends thinking_delta text
        here. (The buffer class itself is P1.M4.T1.S1 / DONE.)"
- url: PRD.md Appendix H "Security & Privacy Model" → Logging Rules
  why: "MAY log event counts/timing/state transitions; MUST NEVER log reasoning text. trackEvent's only
        diagnostic (proxy.tracking-error) passes {type, error} — NEVER delta/content."

# INPUT — the file being MODIFIED (read it first, in full)
- file: src/provider/proxy.ts
  why: "THE file to modify. Contains the current ctor (5 params), run() loop (for-await → push), and the
        defensive try/catch + makeErrorAssistantMessage safety net. Mirror its Mode-A JSDoc banner."
  pattern: "private readonly _output + get output(); fire-and-forget void this.run(...) in the ctor; for
        await (const event of upstream) this._output.push(event)."
  gotcha: "Do NOT remove/alter the existing try/catch or makeErrorAssistantMessage — they are the
        single-terminal/no-hang safety net (P1.M2.T2.S1). Insert trackEvent() INSIDE the try, before push."

# INPUT — TransitionController (DONE — P1.M3.T1.S1; consume, do NOT modify)
- file: src/state/controller.ts
  why: "Exports `class TransitionController(diagnostics)` with transition(next) [throws+warns if illegal],
        getState(), canInterrupt(), requestStop(), fail(reason) [Any→Failed, never throws], reset()
        [Completed/Failed→Idle, else throws], AND `export const ALLOWED_TRANSITIONS: ReadonlyMap<
        TransitionState, ReadonlySet<TransitionState>>` (the §16 table)."
  pattern: "transition() logs trace('transition.state-change',{from,to}) on success; logs warn(
        'transition.illegal',{from,to}) then throws on failure. fail() logs trace + error(
        'transition.failed',{reason,from})."
  critical: "IMPORT BOTH the class AND ALLOWED_TRANSITIONS (value imports). transitionIfLegal MUST
        pre-check ALLOWED_TRANSITIONS to avoid the spurious transition.illegal warn on every normal done."

# INPUT — ReasoningBuffer (DONE — P1.M4.T1.S1; consume, do NOT modify)
- file: src/buffer/index.ts
  why: "Exports `class ReasoningBuffer(diagnostics, maximumBytes)` with append(delta:string) [throws if
        frozen — never frozen in this phase], snapshot(), getByteSize(), freeze() [P1.M5's job], reset()."
  pattern: "append(delta) pushes {offset:entries.length, timestamp:Date.now(), content:delta}; increments
        totalBytes; warns buffer.overflow past maximumBytes (no truncation)."
  gotcha: "append throws if frozen. In this phase nothing calls freeze(), so append never throws — but
        trackEvent's try/catch guards it defensively anyway."

# INPUT — Config default (DONE — P1.M1.T2.S1)
- file: src/config/index.ts
  why: "Exports frozen `DEFAULT_CONFIG.maximumReasoningBufferBytes` (8388608). Used ONLY for the default
        buffer ceiling. config is a leaf module (no src imports) → importing this constant creates NO
        cycle and NO behavior coupling."
  gotcha: "Import the constant `DEFAULT_CONFIG` (value) from '../config'. Do NOT import the whole Config
        type or couple proxy behavior to other config fields."

# INPUT — event vocabulary (DONE — P1.M2.T1.S1)
- file: src/types.ts
  why: "Exports `TransitionState` (the 11-state union) + the event type guards. Import TransitionState as a
        TYPE for transitionIfLegal's param. AssistantMessageEvent is a discriminated union on `type`."
  gotcha: "thinking_delta narrows to expose `.delta: string` only after `event.type === 'thinking_delta'`.
        The work item's 'delta.text' phrasing means `event.delta`."

# Established SOURCE conventions to mirror
- file: src/provider/proxy.ts        # the file itself — Mode-A JSDoc, private readonly _output + get output()
  why: "Mirror its banner structure (Responsibility/Ownership/Lifecycle/Invariants/Failure modes/'Consumed
        by:') and the _field + get field() accessor convention."
- file: src/state/controller.ts      # class with injected diagnostics + ALLOWED_TRANSITIONS consumer
  why: "Shows how a consumer reasons about ALLOWED_TRANSITIONS and the throw-on-illegal contract. The
        proxy's transitionIfLegal is the defensive counterpart to the controller's strict transition()."

# Established TEST conventions to mirror
- file: tests/stream-proxy.test.ts   # drive() helper + ev() builder + noopDiagnostics + class-named file
  why: "THE test template for the proxy. Adapt its async drive(mockUpstream, events) helper (push one event
        per macrotask; iterate proxy.output) and its ev({type,...partial}) builder. The new suite adds
        injected controller+buffer + a capturing diagnostics stub."
- file: tests/transition-controller.test.ts  # capturing Diagnostics builder + count assertions
  why: "Shows the makeCaptureDiag() builder that records {level,event,fields}. Reuse it to assert NO
        transition.illegal warn fires on a normal done."
- file: tests/reasoning-buffer.test.ts       # makeCaptureDiag + buffer.snapshot()/getByteSize assertions
  why: "Shows how to assert buffer accumulation (snapshot().map(e=>e.content), getByteSize())."
- file: tests/golden/fixtures.ts     # the realistic event shapes (thinking_delta.delta, etc.)
  why: "Authoritative event field names + a realistic start→thinking→text→done sequence. Reuse the shapes
        for the new suite's replays."

# Consumer contracts (land later; this subtask only provides the surface they need)
- file: plan/001_b0c6691bb424/architecture/module_contracts.md  # TransitionCoordinator delegates to proxy
  why: "TransitionCoordinator: setActiveProxy(proxy) / isReasoning()→delegates to proxy / requestStop()→
        delegates. So the proxy MUST expose isReasoning() (done) — the coordinator is P1.M4.T4."
```

### Current Codebase tree (Phase 0–3 core landed; `src/provider/proxy.ts` is the MODIFICATION target)

```bash
.
├── package.json          # build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); type module; bun devDep
├── tsconfig.json         # ES2022, strict, bundler, isolatedModules, outDir dist, rootDir src,
│                         # include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── src/
│   ├── index.ts                       # factory (DONE; DO NOT touch)
│   ├── types.ts                       # P1.M2.T1.S1 (DONE; DO NOT touch) — TransitionState INPUT
│   ├── provider/{decorator,proxy}.ts  # DONE; decorator DO NOT touch; proxy ← THIS SUBTASK (MODIFY)
│   ├── state/{controller,coordinator}.ts # controller DONE (INPUT, do NOT touch); coordinator stub
│   ├── config/index.ts                # DONE (DO NOT touch) — DEFAULT_CONFIG INPUT
│   ├── diagnostics/index.ts           # DONE (Diagnostics interface; DO NOT touch) — INPUT
│   └── buffer/index.ts                # P1.M4.T1.S1 (DONE; DO NOT touch) — ReasoningBuffer INPUT
├── tests/
│   ├── smoke.test.ts                 # must stay green
│   ├── config.test.ts                # must stay green
│   ├── diagnostics.test.ts           # captureSink PATTERN; must stay green
│   ├── provider-decorator.test.ts    # must stay green
│   ├── factory.test.ts               # must stay green
│   ├── types.test.ts                 # must stay green
│   ├── stream-proxy.test.ts          # drive()/ev() PATTERN; must stay green & BYTE-IDENTICAL
│   ├── transition-controller.test.ts # makeCaptureDiag PATTERN; must stay green
│   ├── reasoning-buffer.test.ts      # must stay green
│   ├── golden/{replay,fixtures,golden-replay.test}.ts  # must stay green & BYTE-IDENTICAL
│   └── stream-proxy-detection.test.ts # ← THIS SUBTASK (NEW)
└── dist/                 # generated by tsc (git-ignored) — proxy.{js,d.ts} re-emitted
```

### Desired Codebase tree with files to be added/modified and responsibility

```bash
src/provider/
└── proxy.ts            # MODIFY — add reasoning detection (side effects) to the forward-only run() loop
    #   • ctor += optional controller?/buffer? (defaults create real instances)
    #   • new private trackEvent(event) [guarded transitions + buffer append; never throws]
    #   • new private transitionIfLegal(target) [pre-checks ALLOWED_TRANSITIONS]
    #   • new public isReasoning() + get controller()/get buffer()
    #   • run() loop: trackEvent(event); push(event);  (forwarding UNCHANGED)
    #   RESPONSIBILITY: detect reasoning (PRD §22) + drive FSM (§16) + populate buffer (§13.4/§23) while
    #     forwarding transparently (§19.7).
    #   REUSED BY: decorator.ts (unchanged 5-arg construction), P1.M4.T4 (isReasoning), P1.M5
    #     (controller/buffer for abort+freeze), P1.M6 (buffer.snapshot()).

tests/
└── stream-proxy-detection.test.ts   # NEW — the reasoning-detection unit suite (bun:test)
    #   • inject controller+buffer; replay thinking sequences; assert reaches Reasoning + buffer accumulates
    #   • assert forwarding byte-for-byte unchanged (transparency proof)
    #   • no-reasoning stream; error→Idle reset; normal-done no-throw/no-warn; idempotent enter; injected
    #     identity.
    #   RESPONSIBILITY: prove detection is correct AND observationally transparent.
```
**File responsibilities**: `proxy.ts` keeps its single responsibility (one outbound stream, transparent
forwarding) and GAINS detection as a pure side effect layered onto the same loop. New value imports only
(controller, buffer, config-default); no new deps. `stream-proxy-detection.test.ts` owns the detection
assertions; imports `StreamProxy` + `TransitionController` + `ReasoningBuffer` (values) + `Diagnostics`
(type). No other file changes.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (§16 has NO normal Reasoning exit): Reasoning → {StopRequested, Failed} ONLY. A normal
// (non-interrupted) stream reaches Reasoning on the first thinking event and then completes with done —
// but transition("Completed") from Reasoning is ILLEGAL and would throw "Illegal state transition
// (PRD §16)", and reset() from Reasoning ALSO throws. THEREFORE the proxy MUST drive transitions via
// transitionIfLegal() (pre-check ALLOWED_TRANSITIONS; skip when illegal). On a normal done the Completed
// attempt is a no-op and the per-request controller is left in Reasoning (then discarded — it is
// per-request, no leak). On error, fail("upstream-error") (Any→Failed, always legal) then
// transitionIfLegal("Idle") (Failed→Idle) cleanly resets. DO NOT call controller.transition() or
// controller.reset() unguarded on terminals. DO NOT modify ALLOWED_TRANSITIONS (P1.M3.T1.S1 is DONE).

// CRITICAL (do NOT use try/catch around controller.transition for control flow): transition() emits a
// warn("transition.illegal",{from,to}) BEFORE throwing. On every normal done, Reasoning→Completed is
// illegal → a try/catch would spam a spurious transition.illegal warn per normal completion (wrong:
// normal completion is not an error). Pre-check ALLOWED_TRANSITIONS in transitionIfLegal to avoid BOTH
// the throw and the warn. (ALLOWED_TRANSITIONS is already `export const`.)

// CRITICAL (forwarding is UNCHANGED — ADR-005/§19.7): trackEvent(event) runs, THEN this._output.push(event)
// runs, unchanged. trackEvent must (a) only READ event (never mutate it), (b) never throw out to run()'s
// catch (which synthesizes a terminal error and WOULD alter output). So wrap trackEvent's body in its own
// try/catch that logs proxy.tracking-error ({type, error} ONLY — never content) and swallows. This makes
// observational equivalence structural, not aspirational.

// CRITICAL (optional DI with defaults — do NOT make controller/buffer required): there are 6 existing
// `new StreamProxy(...)` call sites (decorator.ts + 4 in stream-proxy.test.ts + 1 in golden/replay.ts). If
// the params were required, ALL would need editing — risking the golden baseline. Make them OPTIONAL with
// internal defaults (new TransitionController(diagnostics) + new ReasoningBuffer(diagnostics,
// DEFAULT_CONFIG.maximumReasoningBufferBytes)). Then decorator.ts + the existing tests stay byte-identical
// AND now ALSO prove detection is transparent (golden replay still byte-for-byte; forwarding tests green).
// Production gets the correct 8 MiB buffer ceiling from DEFAULT_CONFIG — decorator.ts needs NO change.

// CRITICAL (reasoning ENTER is idempotent — guard on Delegating): PRD §22.3 enters on the FIRST
// thinking_start OR first thinking_delta. Guard the Delegating→Reasoning transition on
// getState()==="Delegating" so a stream with many thinking events enters Reasoning EXACTLY once. If you
// guard on "not already Reasoning" you risk re-entering; guard on the SOURCE state (Delegating) per §16.

// GOTCHA (first thinking_delta BOTH enters AND appends): order the checks so the enter-check (step 2)
// runs BEFORE the append-check (step 3) within trackEvent. Then on the first thinking_delta: step 2 fires
// (Delegating→Reasoning), and step 3 — re-reading getState(), now "Reasoning" — appends that same delta.
// This is correct: PRD §22.3 says reasoning begins on the first thinking_delta and that delta IS reasoning
// content. (If you appended in a separate pass you'd miss the entering delta or double-handle it.)

// GOTCHA (thinking_delta field is `.delta`, not `.text`/`.content`): the work item says "append delta.text"
// loosely. The real AssistantMessageEvent field on a thinking_delta is `delta: string` (verified in
// tests/golden/fixtures.ts). Access it only after `event.type === "thinking_delta"` narrows the union.
// thinking_start / thinking_end have NO delta (do not append on them).

// GOTCHA (thinking_end / text_start / toolcall_start do NOT transition in this phase): PRD §22.4 says
// reasoning LEAVES on thinking_end / first answer token — but §16 defines no normal Reasoning exit. This is
// a genuine §16↔§22 tension. Resolution: perform NO transition on those events here; reasoning detection
// remains Reasoning-true until the stream terminates. Acceptable in P1.M4 (no shortcut wired). The real
// Reasoning exit is the interruption path Reasoning→StopRequested (P1.M5). See research/notes.md §2.

// GOTCHA (the default buffer needs a byte ceiling — use DEFAULT_CONFIG, not a magic number): the optional
// default is `new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes)`. Import the
// frozen DEFAULT_CONFIG constant from "../config" (config is a leaf → no cycle). Do NOT hardcode 8388608
// (Appendix F forbids magic numbers). The default equals the production config default, so decorator.ts is
// correct without changes.

// GOTCHA (do NOT import Config as a type or couple to other fields): import DEFAULT_CONFIG (value) for the
// single number. The proxy must not branch on config.enabled / supportedProviders etc. (those are the
// decorator's activation conditions, already applied before the proxy is constructed).

// GOTCHA (isolatedModules + strict): TransitionController, ALLOWED_TRANSITIONS, ReasoningBuffer,
// DEFAULT_CONFIG are VALUES → plain `import`. TransitionState is a TYPE → `import type`. Keep AssistantMessage
// Event as a type import (it already is). Do not value-import a type-only symbol.

// GOTCHA (bun/tsc are local devDeps NOT on PATH): invoke `npx bun run typecheck` / `npx bun run build` /
// `npx bun test`, NOT bare `tsc`/`bun`.

// GOTCHA (tests/ excluded from the build): tsconfig exclude:["tests"] → typecheck validates src/ ONLY. The
// new test file is validated by `npx bun test` (Bun transpiles TS natively). Do NOT add tests/ to tsconfig
// include. The new test imports from "../src/provider/proxy", "../src/state/controller", "../src/buffer".

// GOTCHA (golden replay must stay byte-for-byte): tests/golden/golden-replay.test.ts asserts
// `await replayEvents(FIXTURE)).toEqual(FIXTURE)`. Because detection is a pure side effect (trackEvent then
// unchanged push), this stays green. If your change makes it fail, you have altered forwarding — re-read
// the "forwarding UNCHANGED" gotcha.
```

---

## Implementation Blueprint

### Data models and structure

No new data models. The proxy GAINS two held collaborators (injected or default-created) + one private
helper. The event field it reads (`thinking_delta.delta`) already exists on `AssistantMessageEvent`:

```typescript
// INPUTS (DONE, immutable) — consumed, not modified
//   TransitionController (../state/controller): transition/getState/fail/reset + ALLOWED_TRANSITIONS
//   ReasoningBuffer       (../buffer):          append(delta: string)
//   DEFAULT_CONFIG.maximumReasoningBufferBytes  (../config, frozen): 8388608
//   AssistantMessageEvent.type discriminant "start"|"thinking_start"|"thinking_delta"|"thinking_end"|
//     "text_start"|"text_delta"|"text_end"|"toolcall_start"|...|"done"|"error"
//   thinking_delta variant field: `delta: string`  (the reasoning text to append)

// OWNED — this subtask adds to StreamProxy
//   private readonly _controller: TransitionController  // injected or new TransitionController(diagnostics)
//   private readonly _buffer: ReasoningBuffer           // injected or new ReasoningBuffer(diagnostics, 8MiB)
//   private transitionIfLegal(target: TransitionState): boolean
//   private trackEvent(event: AssistantMessageEvent): void
//   public  isReasoning(): boolean
//   public  get controller(): TransitionController
//   public  get buffer(): ReasoningBuffer
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/provider/proxy.ts — add reasoning detection to the forwarding loop
  - ADD imports (values): { TransitionController, ALLOWED_TRANSITIONS } from "../state/controller";
    { ReasoningBuffer } from "../buffer"; { DEFAULT_CONFIG } from "../config".
  - ADD import (type): extend the existing `import type { AssistantMessageEvent } from "../types"` to
    `import type { AssistantMessageEvent, TransitionState } from "../types"`.
  - ADD private fields: `private readonly _controller: TransitionController;` and
    `private readonly _buffer: ReasoningBuffer;` (alongside the existing `private readonly _output`).
  - MODIFY the constructor: add two OPTIONAL trailing params `controller?: TransitionController` and
    `buffer?: ReasoningBuffer` AFTER diagnostics. In the body assign
    `this._controller = controller ?? new TransitionController(diagnostics);` and
    `this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);`.
    Keep the existing `this.diagnostics = diagnostics;` / `this._output = createAssistantMessageEvent
    Stream();` / `void this.run(...)` lines EXACTLY as-is.
  - ADD `get controller()` / `get buffer()` / `isReasoning()` public accessors (see reference code).
  - ADD `private transitionIfLegal(target: TransitionState): boolean` (pre-check ALLOWED_TRANSITIONS;
    call controller.transition(target) only when legal; never throws).
  - ADD `private trackEvent(event: AssistantMessageEvent): void` (the 4-step guarded driver wrapped in a
    swallowing try/catch — see reference code verbatim).
  - MODIFY run(): in the `for await (const event of upstream)` loop insert `this.trackEvent(event);` as
    the FIRST statement, immediately before the existing `this._output.push(event);`. Change NOTHING else
    in run() (the try/catch + makeErrorAssistantMessage safety net stay).
  - UPDATE JSDoc (Mode A): extend the class/module banner to note it now ALSO drives the FSM (§16) +
    populates the buffer (§13.4/§23) as a side effect of forwarding (§22 detection; §19.7 unchanged
    forwarding). Document ctor params, the optional-default DI, the accessors, and the §16 normal-flow
    limitation (thinking_end/answer do not transition). Cite PRD §22/§16/§13.2.
  - NAMING: `_controller`/`_buffer` private + `controller`/`buffer` getters (mirror the existing
    `_output`/`get output()` convention). trackEvent/transitionIfLegal/isReasoning camelCase.
  - PLACEMENT: src/provider/proxy.ts (modify in place).
  - DO NOT touch: decorator.ts, controller.ts, buffer/index.ts, config, types, diagnostics, index.ts.

Task 2: CREATE tests/stream-proxy-detection.test.ts (the reasoning-detection unit suite)
  - IMPORT (value): { describe, test, expect } from "bun:test";
    { StreamProxy } from "../src/provider/proxy";
    { TransitionController } from "../src/state/controller";
    { ReasoningBuffer } from "../src/buffer";
    { createAssistantMessageEventStream } from "@earendil-works/pi-ai".
  - IMPORT (type): { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from
    "@earendil-works/pi-ai"; { Diagnostics } from "../src/diagnostics".
  - IMPLEMENT a capturing Diagnostics builder (adapt tests/transition-controller.test.ts makeCaptureDiag)
    that records {level,event,fields} so the suite can assert NO transition.illegal warn fires.
  - IMPLEMENT an async drive() helper (adapt tests/stream-proxy.test.ts drive): construct
    `new StreamProxy(makeModel(), {} as never, {} as never, () => mockUpstream, diag, controller, buffer)`
    (passing the INJECTED controller+buffer), concurrently iterate proxy.output into `seen`, push events
    one-per-macrotask, flush, return {seen, controller, buffer}. Also an ev({type,...partial}) builder and
    a makeModel() (mirror stream-proxy.test.ts).
  - IMPLEMENT describe/test blocks (every Success Criterion + MOCKING intent):
      • REACHES Reasoning on thinking_start: drive [start, thinking_start, thinking_delta, done] → after
        the stream, controller.getState()==="Reasoning" AND proxy.isReasoning()===true.
      • REACHES Reasoning on first thinking_delta (no thinking_start): drive [start, thinking_delta(0,"a"),
        done] → getState()==="Reasoning".
      • BUFFER ACCUMULATES: drive [start, thinking_start, thinking_delta(0,"Let me "), thinking_delta(0,
        "think"), thinking_end, text_start, text_delta, done] → buffer.snapshot().map(e=>e.content)
        ====["Let me ","think"]; getByteSize()=== "Let me ".length+"think".length; offsets 0,1.
      • FORWARDING UNCHANGED: drain proxy.output; assert seen (event types) equals the replayed sequence
        exactly — detection did not alter output.
      • NO-REASONING: drive [start, text_start, text_delta, done] → getState()==="Delegating" (never
        Reasoning); buffer.snapshot().length===0; getByteSize()===0; proxy.isReasoning()===false.
      • ERROR → Idle: drive [start, error] → getState()==="Idle" (fail→Failed→reset); no throw.
      • NORMAL done NO-THROW/NO-WARN: drive a full reasoning→text→done; assert no throw, the captured
        diagnostics contain ZERO transition.illegal warns, and getState()==="Reasoning" (documented §16
        normal-flow gap — assert it explicitly so the behavior is locked).
      • IDEMPOTENT ENTER: drive many thinking events; assert exactly ONE transition.state-change trace
        with {from:"Delegating",to:"Reasoning"} (enters once).
      • INJECTED IDENTITY: proxy.controller===injectedController; proxy.buffer===injectedBuffer; the
        injected buffer is the one that accumulated (snapshot matches).
  - FOLLOW pattern: tests/stream-proxy.test.ts (drive/ev/makeModel/noop-or-capture diag), tests/
    transition-controller.test.ts (makeCaptureDiag + count assertions), tests/reasoning-buffer.test.ts
    (snapshot/getByteSize assertions).
  - PLACEMENT: tests/stream-proxy-detection.test.ts.

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics (proxy.ts now imports controller/buffer/config).
  - RUN: npx bun run build      → exit 0; dist/provider/proxy.{js,d.ts} re-emitted.
  - RUN: npx bun test tests/stream-proxy-detection.test.ts  → the new suite green.
  - RUN: npx bun test           → ALL green (new suite + the 9 existing suites — ZERO regressions).
  - RUN: Level 1–3 gates below (incl. the golden-replay + stream-proxy byte-identical checks).
```

### Implementation Patterns & Key Details

```typescript
// ── src/provider/proxy.ts — the ADDITIONS (author verbatim; integrate into the existing file) ──────

// ... existing imports ...
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api, ApiStreamSimpleFunction, AssistantMessage, AssistantMessageEventStream, Context, Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../diagnostics";
import type { AssistantMessageEvent, TransitionState } from "../types";
// NEW value imports for reasoning detection (P1.M4.T2.S1):
import { TransitionController, ALLOWED_TRANSITIONS } from "../state/controller";
import { ReasoningBuffer } from "../buffer";
import { DEFAULT_CONFIG } from "../config";

export class StreamProxy {
  private readonly _output: AssistantMessageEventStream;
  private readonly diagnostics: Diagnostics;
  // NEW — per-request reasoning-detection collaborators (PRD §16 FSM + §13.4/§23 buffer).
  private readonly _controller: TransitionController;
  private readonly _buffer: ReasoningBuffer;

  constructor(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
    diagnostics: Diagnostics,
    // Optional DI: tests inject these to inspect state/buffer; production + existing callers omit them
    // and the proxy self-creates real instances (matches controller.ts/buffer JSDoc: "constructed by
    // StreamProxy (P1.M4)" / "owns the per-request instance"). decorator.ts therefore stays unchanged.
    controller?: TransitionController,
    buffer?: ReasoningBuffer,
  ) {
    this.diagnostics = diagnostics;
    this._output = createAssistantMessageEventStream();
    this._controller = controller ?? new TransitionController(diagnostics);
    this._buffer = buffer ?? new ReasoningBuffer(diagnostics, DEFAULT_CONFIG.maximumReasoningBufferBytes);
    void this.run(model, context, options, upstreamStreamFn);
  }

  get output(): AssistantMessageEventStream {
    return this._output;
  }

  /** The per-request FSM (PRD §16). Forward-compat: P1.M4.T4/P1.M5 reach it via the proxy. */
  get controller(): TransitionController {
    return this._controller;
  }

  /** The per-request reasoning capture (PRD §13.4/§23). Forward-compat: P1.M5 (freeze) / P1.M6 (snapshot). */
  get buffer(): ReasoningBuffer {
    return this._buffer;
  }

  /** Whether reasoning is currently flowing (PRD §22.5). P1.M4.T4's coordinator delegates to this. */
  isReasoning(): boolean {
    return this._controller.getState() === "Reasoning";
  }

  /**
   * Transition to `target` ONLY if it is legal from the current state per PRD §16 (the exported
   * ALLOWED_TRANSITIONS map); otherwise a no-op. NEVER throws and NEVER triggers the controller's
   * `transition.illegal` warn — essential because the FSM has NO normal-completion exit from `Reasoning`
   * (§16 models the interruption lifecycle), so `done` on a normal stream would otherwise be illegal.
   * Returns whether the transition was taken.
   */
  private transitionIfLegal(target: TransitionState): boolean {
    const allowed = ALLOWED_TRANSITIONS.get(this._controller.getState());
    if (allowed && allowed.has(target)) {
      this._controller.transition(target); // pre-validated legal → cannot throw / cannot warn
      return true;
    }
    return false;
  }

  /**
   * Per-event reasoning-detection side effect (PRD §22), invoked once per event in run() BEFORE the
   * unchanged forward. Drives the FSM (§16) and the buffer (§13.4/§23). NEVER throws out to run()'s
   * catch (which would synthesize a terminal and alter output — violating §19.7): any fault is logged
   * (event.type ONLY — Appendix H) and swallowed. The `event` is only READ, never mutated.
   */
  private trackEvent(event: AssistantMessageEvent): void {
    try {
      // 1. Stream begins → Delegating (PRD §16 Idle→Delegating; guarded on Idle → enters once).
      if (event.type === "start" && this._controller.getState() === "Idle") {
        this.transitionIfLegal("Delegating");
      }
      // 2. Enter Reasoning on the FIRST thinking event (PRD §22.3: thinking_start OR first thinking_delta;
      //    §16 Delegating→Reasoning; guarded on Delegating → enters exactly once).
      if (
        (event.type === "thinking_start" || event.type === "thinking_delta") &&
        this._controller.getState() === "Delegating"
      ) {
        this.transitionIfLegal("Reasoning");
      }
      // 3. Accumulate reasoning deltas while Reasoning (PRD §13.4/§23.2). `event.type==="thinking_delta"`
      //    narrows the union → event.delta: string. (Order matters: step 2 may run first on the entering
      //    delta, flipping state to Reasoning, so step 3 then appends that same delta — correct.)
      if (event.type === "thinking_delta" && this._controller.getState() === "Reasoning") {
        this._buffer.append(event.delta);
      }
      // 4. Terminals (PRD §16). error → Any→Failed (fail never throws) → Failed→Idle. done → Completed→Idle
      //    ONLY when legal (the interrupted flow reaches Answering→Completed in P1.M5–P1.M7). In the
      //    NORMAL flow §16 defines no Reasoning→Completed exit, so done is a guarded no-op and the
      //    per-request controller is left in its legal state (then discarded).
      if (event.type === "error") {
        this._controller.fail("upstream-error");
        this.transitionIfLegal("Idle");
      } else if (event.type === "done") {
        if (this.transitionIfLegal("Completed")) {
          this.transitionIfLegal("Idle");
        }
      }
      // NOTE (PRD §22.4 "leave reasoning on thinking_end / first answer token"): §16 defines no normal
      // Reasoning exit, so thinking_end / text_start / toolcall_start perform NO transition here.
    } catch (err) {
      this.diagnostics.warn("proxy.tracking-error", {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    upstreamStreamFn: ApiStreamSimpleFunction,
  ): Promise<void> {
    try {
      const upstream = upstreamStreamFn(model, context, options);
      for await (const event of upstream) {
        this.trackEvent(event);   // NEW — side-effect reasoning detection; never throws; never mutates event
        this._output.push(event); // UNCHANGED transparent forwarding (PRD §19.7)
      }
    } catch (err) {
      // ... EXACTLY as P1.M2.T2.S1 wrote it: warn + synthesized single error terminal ...
      const message = err instanceof Error ? err.message : String(err);
      this.diagnostics.warn("proxy.forward.upstream-threw", {
        provider: String(model.provider),
        model: model.id,
        error: message,
      });
      this._output.push({
        type: "error",
        reason: "error",
        error: this.makeErrorAssistantMessage(model, message),
      });
    }
  }

  // makeErrorAssistantMessage(...) — UNCHANGED from P1.M2.T2.S1.
}
```

> **Note on the `done` guard**: `transitionIfLegal("Completed")` returns `true` only from `Answering`
> (the interrupted flow). In this phase the controller never reaches `Answering`, so the branch is a
> forward-compat no-op and the normal `done` leaves the controller in `Reasoning`. That is intentional and
> locked by a test — do not "fix" it by forcing an illegal transition or by abusing `fail()`.
```typescript
// ── tests/stream-proxy-detection.test.ts — COMPLETE reference (author verbatim) ────────────────────

import { describe, test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StreamProxy } from "../src/provider/proxy";
import { TransitionController } from "../src/state/controller";
import { ReasoningBuffer } from "../src/buffer";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Diagnostics } from "../src/diagnostics";

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call (adapted from transition-controller.test.ts). */
function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info: (e, f) => events.push({ level: "info", event: e, fields: f }),
    warn: (e, f) => events.push({ level: "warn", event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}

/** Minimal Model stand-in — only .id/.api/.provider are read (defensive path only). */
function makeModel() {
  return { id: "glm-4.7", api: "openai-completions", provider: "zai" } as unknown as Parameters<
    typeof StreamProxy
  >[0];
}

/** Build a synthetic AssistantMessageEvent carrying only what each case needs. */
function ev(partial: { type: string } & Partial<AssistantMessageEvent>): AssistantMessageEvent {
  return { ...partial } as unknown as AssistantMessageEvent;
}

const DONE_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;
const ERROR_MESSAGE = { role: "assistant", content: [], model: "glm-4.7" } as unknown as AssistantMessage;

/**
 * Drive the proxy with INJECTED controller + buffer (test owns the refs so it can inspect state/buffer).
 * Returns the observed downstream event types + the injected collaborators.
 */
async function drive(
  mockUpstream: AssistantMessageEventStream,
  events: AssistantMessageEvent[],
  controller: TransitionController,
  buffer: ReasoningBuffer,
  diag: Diagnostics,
): Promise<{ seen: string[] }> {
  const proxy = new StreamProxy(
    makeModel(),
    {} as never,
    {} as never,
    () => mockUpstream,
    diag,
    controller,
    buffer,
  );
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const e of proxy.output) seen.push((e as AssistantMessageEvent).type);
  })();
  for (const e of events) {
    mockUpstream.push(e);
    await new Promise((r) => setTimeout(r, 0));
  }
  await consumer;
  return { seen };
}

describe("StreamProxy — reasoning detection (P1.M4.T2.S1)", () => {
  test("reaches Reasoning on thinking_start and isReasoning() is true", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, () => upstream, diag, controller, buffer);
    upstream.push(ev({ type: "start" }));
    upstream.push(ev({ type: "thinking_start", contentIndex: 0 }));
    expect(controller.getState()).toBe("Reasoning"); // entered on first thinking event
    expect(proxy.isReasoning()).toBe(true);
    upstream.push(ev({ type: "done", reason: "stop", message: DONE_MESSAGE }));
    // drain to let the loop finish (avoid unhandled stream)
    for await (const _e of proxy.output) { /* drain */ void _e; }
  });

  test("reaches Reasoning on first thinking_delta when there is no thinking_start (PRD §22.3)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag);
    expect(controller.getState()).toBe("Reasoning");
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["hm"]); // entering delta IS captured
  });

  test("buffer accumulates thinking deltas in order; bytes accumulate", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "Let me " }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "think" }),
      ev({ type: "thinking_end", contentIndex: 0, content: "Let me think" }),
      ev({ type: "text_start", contentIndex: 1 }),
      ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag);
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["Let me ", "think"]);
    expect(buffer.snapshot().map((e) => e.offset)).toEqual([0, 1]);
    expect(buffer.getByteSize()).toBe("Let me ".length + "think".length);
  });

  test("forwarding is byte-for-byte unchanged WITH detection active (transparency proof)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const { seen } = await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "a" }),
      ev({ type: "thinking_end", contentIndex: 0, content: "a" }),
      ev({ type: "text_start", contentIndex: 1 }),
      ev({ type: "text_delta", contentIndex: 1, delta: "Hi" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag);
    expect(seen).toEqual(["start", "thinking_start", "thinking_delta", "thinking_end",
      "text_start", "text_delta", "done"]); // detection did not alter output
  });

  test("a no-reasoning stream never enters Reasoning and leaves the buffer empty", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, () => upstream, diag, controller, buffer);
    upstream.push(ev({ type: "start" }));
    expect(controller.getState()).toBe("Delegating");
    expect(proxy.isReasoning()).toBe(false);
    await drive(upstream, [
      ev({ type: "text_start", contentIndex: 0 }),
      ev({ type: "text_delta", contentIndex: 0, delta: "Hi" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag);
    expect(buffer.snapshot()).toHaveLength(0);
    expect(buffer.getByteSize()).toBe(0);
  });

  test("an error terminal cleanly resets the controller to Idle (fail → Failed → reset)", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "error", reason: "error", error: ERROR_MESSAGE }),
    ], controller, buffer, diag);
    expect(controller.getState()).toBe("Idle");
  });

  test("a normal done throws nothing and emits NO transition.illegal warn (controller left Reasoning)", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await expect(drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "x" }),
      ev({ type: "thinking_end", contentIndex: 0, content: "x" }),
      ev({ type: "text_start", contentIndex: 1 }),
      ev({ type: "text_delta", contentIndex: 1, delta: "y" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag)).resolves.toBeDefined(); // no throw
    expect(events.filter((c) => c.event === "transition.illegal")).toHaveLength(0); // no spurious warn
    expect(controller.getState()).toBe("Reasoning"); // documented §16 normal-flow gap (no Reasoning→Completed)
  });

  test("reasoning enter is idempotent — many thinking events enter Reasoning exactly once", async () => {
    const { diag, events } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "a" }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "b" }),
      ev({ type: "thinking_end", contentIndex: 0, content: "ab" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag);
    const enters = events.filter(
      (c) => c.level === "trace" && c.event === "transition.state-change" &&
        c.fields?.from === "Delegating" && c.fields?.to === "Reasoning",
    );
    expect(enters).toHaveLength(1); // entered exactly once despite many thinking events
  });

  test("injected controller + buffer are the ones the proxy uses", async () => {
    const { diag } = makeCaptureDiag();
    const controller = new TransitionController(diag);
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    const upstream = createAssistantMessageEventStream();
    const proxy = new StreamProxy(makeModel(), {} as never, {} as never, () => upstream, diag, controller, buffer);
    expect(proxy.controller).toBe(controller);
    expect(proxy.buffer).toBe(buffer);
    await drive(upstream, [
      ev({ type: "start" }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "captured" }),
      ev({ type: "done", reason: "stop", message: DONE_MESSAGE }),
    ], controller, buffer, diag);
    expect(buffer.snapshot().map((e) => e.content)).toEqual(["captured"]); // the injected buffer accumulated
  });
});
```

> **Test note**: every `drive()` replay ends with a terminal (`done`/`error`) so `proxy.output` completes
> and the consumer's `for await` exits naturally (same invariant as the golden fixtures). The
> "reaches Reasoning on thinking_start" test reads state mid-stream before pushing the terminal, then
> drains to avoid a dangling promise.

### Integration Points

```yaml
NO BUILD/BUILD-CONFIG CHANGES:
  - tsconfig.json: UNCHANGED (src/**/*.ts already includes proxy.ts; tests/ still excluded).
  - package.json: UNCHANGED (no new deps; bun + tsc already present).
  - .gitignore: UNCHANGED.

PRODUCTION WIRING (decorator.ts): UNCHANGED.
  - The existing `new StreamProxy(model, context, options ?? {}, originalStreamSimple, this.diagnostics)`
    (src/provider/decorator.ts:158) keeps working: the proxy self-creates controller + buffer via the
    optional defaults. Do NOT edit decorator.ts. (If a future phase needs the decorator to SHARE the
    controller with the coordinator, that is P1.M4.T4's wiring — not this subtask.)

FORWARD-COMPAT SURFACE (consumed by later subtasks, not implemented here):
  - proxy.isReasoning()                 → P1.M4.T4 TransitionCoordinator.isReasoning()
  - proxy.controller                    → P1.M5 abort coordination (beginAbort/completeAbort)
  - proxy.buffer (freeze/snapshot)      → P1.M5 (freeze at Aborting→Capturing) / P1.M6 (snapshot)
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check the modified source (tests/ excluded from tsc).
npx bun run typecheck
# Expected: 0 diagnostics. proxy.ts must compile with the new imports + optional params + getters.

# Build (emits dist/provider/proxy.{js,d.ts}).
npx bun run build
# Expected: exit 0.

# Grep gates (information density / convention compliance):
grep -nE "trackEvent|transitionIfLegal|isReasoning" src/provider/proxy.ts   # all three present
grep -n "ALLOWED_TRANSITIONS" src/provider/proxy.ts                         # imported + used
grep -nE "controller\?|buffer\?" src/provider/proxy.ts                      # optional ctor params
! grep -nE "transition\(\"Completed\"\)|\.reset\(\)" src/provider/proxy.ts | grep -v transitionIfLegal
# Expected: the last (negated) grep finds NO unguarded transition("Completed")/reset() — only via transitionIfLegal.
```

### Level 2: Unit Tests (Component Validation)

```bash
# The new detection suite.
npx bun test tests/stream-proxy-detection.test.ts
# Expected: ALL green.

# The existing forwarding suite MUST stay green & byte-identical (proves forwarding unchanged).
npx bun test tests/stream-proxy.test.ts
# Expected: ALL green (unchanged file).

# The golden replay MUST stay byte-for-byte (proves observational equivalence with detection active).
npx bun test tests/golden/golden-replay.test.ts
# Expected: ALL green (unchanged file).

# The FSM + buffer suites MUST stay green (proves the consumed APIs are used correctly).
npx bun test tests/transition-controller.test.ts tests/reasoning-buffer.test.ts
# Expected: ALL green.

# Full suite (new + the 9 existing — zero regressions).
npx bun test
# Expected: ALL green.
```

### Level 3: Integration Testing (System Validation)

```bash
# Factory smoke (the decorator constructs the proxy via the unchanged 5-arg call → must still init/shutdown).
npx bun test tests/factory.test.ts tests/provider-decorator.test.ts tests/smoke.test.ts
# Expected: ALL green (the proxy's self-created controller/buffer do not break decorator wiring).

# No source file other than proxy.ts was touched (forbidden-operations guard).
git diff --name-only | grep -vE '^(src/provider/proxy\.ts|tests/stream-proxy-detection\.test\.ts)$'
# Expected: EMPTY (no other tracked file changed).
git status --porcelain | grep -E '\.gitignore|tasks\.json|prd_snapshot\.md|PRD\.md'
# Expected: EMPTY (forbidden files untouched).
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Reasoning-detection contract spot-check (manual reasoning over the behavior):
#  1. start        → Idle→Delegating          (legal, taken)
#  2. thinking_*   → Delegating→Reasoning     (legal, taken, ONCE)
#  3. thinking_delta → buffer.append(delta)   (captured, in order)
#  4. done (normal)→ Reasoning→Completed?     (ILLEGAL → transitionIfLegal no-op; no throw, no warn)
#  5. error        → Any→Failed→Idle          (legal, clean reset)
# The new suite encodes exactly these; if all green + golden green, the contract holds.

# Observational-equivalence proof:
#  golden-replay.test.ts replays NORMAL/NO_REASONING/ERROR fixtures through the (now detection-active)
#  proxy and asserts byte-for-byte equality. Green == detection is transparent. (No extra command needed;
#  it is part of Level 2.)
```

## Final Validation Checklist

### Technical Validation

- [ ] `npx bun run typecheck` → **0** diagnostics.
- [ ] `npx bun run build` → exit 0 (`dist/provider/proxy.{js,d.ts}` re-emitted).
- [ ] `npx bun test` → ALL green (new `stream-proxy-detection.test.ts` + 9 existing suites).
- [ ] `tests/stream-proxy.test.ts` and `tests/golden/*` are **byte-identical** and green (forwarding
      unchanged; golden byte-for-byte preserved).

### Feature Validation

- [ ] A `start→thinking_start→…` replay leaves `controller.getState()==="Reasoning"` and
      `proxy.isReasoning()===true`.
- [ ] A `start→thinking_delta(…)` replay (no `thinking_start`) ALSO reaches `Reasoning` (PRD §22.3) and
      captures the entering delta.
- [ ] `thinking_delta` deltas accumulate in the buffer in order; `getByteSize()` === Σ lengths; a
      no-reasoning stream leaves the buffer empty.
- [ ] `error` → controller reset to `Idle`; normal `done` → NO throw and ZERO `transition.illegal` warns
      (controller left in `Reasoning` per the documented §16 gap).
- [ ] Forwarding is byte-for-byte unchanged with detection active (the transparency test + golden replay).
- [ ] Reasoning enter is idempotent (exactly one `Delegating→Reasoning` transition).

### Code Quality Validation

- [ ] Follows the existing `_field` + `get field()` accessor convention (`_output`/`_controller`/`_buffer`).
- [ ] Optional DI with internal defaults (existing 5-arg callers untouched; decorator.ts unchanged).
- [ ] `transitionIfLegal` pre-checks `ALLOWED_TRANSITIONS` (no spurious `transition.illegal` warns; no throw).
- [ ] `trackEvent` is wrapped in a swallowing try/catch — a tracking fault can never break forwarding.
- [ ] Mode-A JSDoc updated (Responsibility/Ownership/Lifecycle/Invariants/Failure modes/"Consumed by:")
      citing PRD §22/§16/§13.2 and documenting the §16 normal-flow limitation.
- [ ] No edits outside `src/provider/proxy.ts` + the new `tests/stream-proxy-detection.test.ts`.

### Documentation & Deployment

- [ ] No new environment variables; no config changes; no manifest changes.
- [ ] Privacy respected: `proxy.tracking-error` logs `{type, error}` only — never reasoning `delta`/content.

---

## Anti-Patterns to Avoid

- ❌ Don't make `controller`/`buffer` REQUIRED ctor params — that forces editing 6 call sites and risks the
  golden baseline. Use optional DI with internal defaults (existing callers stay byte-identical).
- ❌ Don't call `controller.transition("Completed")` or `controller.reset()` UNGUARDED on a terminal —
  `Reasoning→Completed` is illegal in §16 and would throw (and reset() throws from Reasoning). Always go via
  `transitionIfLegal`, and use `fail()` for the `error` path.
- ❌ Don't use `try/catch` around `controller.transition()` for control flow — it emits a spurious
  `transition.illegal` warn on every normal `done`. Pre-check `ALLOWED_TRANSITIONS`.
- ❌ Don't let `trackEvent` throw out to `run()`'s catch — that synthesizes a terminal and ALTERS output,
  breaking observational equivalence. Wrap `trackEvent` in its own swallowing try/catch.
- ❌ Don't mutate or replace the forwarded `event`, and don't skip `this._output.push(event)` — forwarding
  is UNCHANGED (PRD §19.7 / ADR-005). Detection is a pure side effect layered onto the same loop.
- ❌ Don't modify `ALLOWED_TRANSITIONS` / `controller.ts` / `buffer/index.ts` to "fix" the §16 normal-flow
  gap — P1.M3.T1.S1 / P1.M4.T1.S1 are DONE and immutable. The gap is resolved defensively in the proxy.
- ❌ Don't branch the proxy on `config.enabled`/`supportedProviders` — those activation conditions are the
  decorator's job (already applied before the proxy is constructed). The proxy imports only
  `DEFAULT_CONFIG.maximumReasoningBufferBytes`.
- ❌ Don't log reasoning `delta`/content in `proxy.tracking-error` (Appendix H) — log `{type, error}` only.

---

## Confidence Score

**9/10** for one-pass implementation success. The PRP provides the complete modified `proxy.ts` (ctor,
imports, accessors, `trackEvent`, `transitionIfLegal`, modified `run()`), the complete new test file, the
verified build/test commands, and — critically — resolves the one non-obvious landmine (the §16 FSM has no
normal `Reasoning` exit, so terminals MUST be driven via a guarded `transitionIfLegal` rather than a
throwing `transition`). The optional-default DI keeps all 6 existing call sites byte-identical, so the
existing forwarding + golden tests double as regression guards and transparency proofs. The only residual
uncertainty (−1) is whether the reviewer prefers the `controller`/`buffer` getters exposed now vs. added in
P1.M4.T4 — but exposing them is zero-cost and forward-compatible, and dropping them would not break this
subtask's success criteria.
