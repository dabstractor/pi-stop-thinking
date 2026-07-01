# System Context — Bugfix 001

> **Scope:** Three defects found by validating the extension's output stream against the real
> `pi-agent-core` consumer. All three are in `src/provider/proxy.ts` and `src/state/coordinator.ts`.
> The existing 380 tests pass but have a blind spot: they never run the real consumer assembly logic.

---

## Root Cause Map

### Issue 1 (CRITICAL): Reasoning lost from persisted message on every interruption

**Files:** `src/provider/proxy.ts` — `_emit()` (splicing/replacement branch), `run()`, `_launchReplacement()`.

**Root cause:** The proxy forwards replacement events **verbatim**. A replacement is a FRESH z.ai
request whose `output.content` starts empty and accumulates ONLY answer text at `contentIndex: 0`
(the primary's reasoning was also at `contentIndex: 0`). Two effects:

1. **`contentIndex` collision** — primary thinking at `[0]`, replacement text at `[0]`. The remote
   consumer (`proxy.js processProxyEvent`) indexes `partial.content[contentIndex]` → text overwrites
   thinking.
2. **`partial` switching** — the local consumer (`agent-loop.js`) does `partialMessage = event.partial`
   on every event. The replacement's `partial` is a fresh text-only output → the streaming view and
   `result()` / `done.message` lose the reasoning.

See `pi-agent-core-consumer.md` for the exact consumer logic and `pi-ai-event-types.md` for field shapes.

**Fix strategy (proxy-owned content merge):**
1. **Capture** the primary's frozen content blocks. In `run()`'s primary loop (or `_emit`'s forwarding
   branch), store a reference to the last primary `event.partial`; at the abort/freeze boundary,
   deep-clone `event.partial.content` into `this._frozenPrimaryContent`. The offset = its length.
2. **Offset** every replacement event's `contentIndex` by the offset, so answer blocks land AFTER
   the primary's frozen blocks (index `N` instead of 0).
3. **Rewrite** every replacement event's `partial` to a merged message:
   `{ ...event.partial, content: [...this._frozenPrimaryContent, ...event.partial.content] }`.
4. **Rewrite** the replacement `done` event's `message` to the same merged message (so `result()`
   resolves to `[thinking, text]`).
5. **Edge cases:** replacement returning reasoning (EC-017) — prepend still works; tool-call blocks —
   offset still works; error terminal — merge content but keep the error's stopReason.

**Existing code touchpoints:**
- `run()` primary loop (line ~`for await (const event of upstream)`) — add primary-partial capture.
- `run()` catch / abort branch (`_buffer.freeze()`) — snapshot `_frozenPrimaryContent`.
- `_emit()` splicing branch (`this._authority === "splicing"`) — this is where replacement events
  are forwarded (`this._output.push(event)`). The rewrite goes HERE, before the push.

**Existing fields/objects available:**
- `this._buffer` (ReasoningBuffer) — has `snapshot()` (raw delta strings) + `freeze()`. Useful for
  the snapshot but the structured content blocks come from `event.partial`.
- `this._authority` (`ProxyPhase`) — `"splicing"` during replacement.
- The replacement stream is iterated in `_launchReplacement()` which calls `this._emit(event)`.

### Issue 2 (MAJOR): Shortcut aborts in-progress answer

**Files:** `src/provider/proxy.ts` — `trackEvent()`, `canInterrupt()`, `triggerStop()`;
`src/state/controller.ts` — `canInterrupt()`.

**Root cause:** The FSM (`ALLOWED_TRANSITIONS`) has NO normal exit from `Reasoning` (only
`Reasoning → StopRequested` / `Reasoning → Failed`). So `trackEvent` does nothing on `thinking_end` /
`text_start` / `toolcall_start`, and the controller stays in `Reasoning` for the entire answer phase.
`canInterrupt()` returns `state === "Reasoning"` → true during the answer → pressing the shortcut
aborts the in-progress answer and launches a new replacement.

**Fix strategy (reasoningEnded flag — minimal, low-risk):**
1. Add `private _reasoningEnded = false` to `StreamProxy`.
2. In `trackEvent()`, set `this._reasoningEnded = true` when in `Reasoning` AND the event is a
   PRD §22.4 leave-condition: `thinking_end`, `text_start`, `toolcall_start` (first answer token).
3. Change `StreamProxy.canInterrupt()` to `return this._controller.getState() === "Reasoning" && !this._reasoningEnded`.
4. Change `triggerStop()`'s guard from `this._controller.canInterrupt()` to `this.canInterrupt()`
   (so the proxy-level gate is enforced at the abort entry point).

**Why the flag approach (not FSM extension):** The FSM extension (add `Reasoning → Answering`) is
riskier — it changes §16 semantics and breaks existing tests that assert the controller stays in
`Reasoning` on normal completion (`stream-proxy-lifecycle.test.ts` line ~441:
`expect(controller.getState()).toBe("Reasoning")`). The flag approach leaves the FSM untouched and
only gates shortcut availability — functionally correct, minimal blast radius. `isReasoning()`
continues to reflect FSM state (acceptable — it's for telemetry, not shortcut gating).

**Side benefit:** This also prevents the Issue-1 compounding (re-aborting the answer, dropping
reasoning again).

### Issue 3 (MINOR): Coordinator single-slot loses coverage for overlapping streams

**Files:** `src/provider/proxy.ts` — `_terminate()`; `src/state/coordinator.ts` — `setActiveProxy()`.

**Root cause:** `StreamProxy._terminate()` calls `this._coordinator?.setActiveProxy(undefined)`
UNCONDITIONALLY. If two eligible streams overlap (B overwrites A as active), when A terminates it
clears the coordinator even though B is still active.

**Fix strategy (guarded clear):**
1. Add a method `clearActiveProxy(proxy: ActiveProxy)` to `TransitionCoordinator` that clears
   `activeProxy` ONLY IF `this.activeProxy === proxy` (and resets `pendingStop`).
2. In `_terminate()`, replace `this._coordinator?.setActiveProxy(undefined)` with
   `this._coordinator?.clearActiveProxy(this)`.
3. `StreamProxy` is structurally assignable to `ActiveProxy`, so passing `this` type-checks.

---

## Test Infrastructure Needed

### Consumer-Simulation Harness (NEW — `tests/helpers/`)

A faithful copy of `agent-loop.js`'s assembly logic, parameterized to consume any
`AssistantMessageEventStream`:

```ts
async function consumeLikeAgentLoop(stream): Promise<{ finalMessage: AssistantMessage; events: AssistantMessageEvent[] }>
```

Logic: `partialMessage = event.partial` on each event; `finalMessage = await stream.result()`.
Return both for assertion. This is the tool that would have caught Issue 1.

### Realistic two-call mock provider (enhance existing mocks)

The existing mocks (`makeReplacementUpstream`, `makeScriptedTwoPhaseUpstream`) put primary thinking
AND replacement text at `contentIndex: 0` with empty/placeholder `partial` objects. They must carry
realistic `partial` objects (a real accumulating `output` with structured `content` blocks) to expose
the collision when consumed. See `pi-ai-event-types.md` for the exact shape.

---

## Files Modified by This Bugfix

| File | Issue(s) | Changes |
|------|----------|---------|
| `src/provider/proxy.ts` | 1, 2, 3 | Primary-partial capture; replacement event rewrite; `_reasoningEnded` flag + `canInterrupt`/`triggerStop` gate; `_terminate` guarded clear |
| `src/state/coordinator.ts` | 3 | Add `clearActiveProxy(proxy)` method |
| `tests/helpers/` (new harness) | 1 (test infra) | `consumeLikeAgentLoop` + realistic mock |
| `tests/stream-proxy-replacement.test.ts` | 1 | Add consumer-assertion integration test |
| `tests/stream-proxy-abort.test.ts` / new test file | 2 | EC-005/EC-006 end-to-end tests |
| `tests/transition-coordinator.test.ts` | 3 | Overlapping-proxy test |

**NOT modified:** `src/state/controller.ts` (FSM stays as-is per the flag approach),
`src/types.ts`, `src/buffer/index.ts`, `src/request/builder.ts`, `src/index.ts`, `src/provider/decorator.ts`.

---

## Constraints & Conventions (from codebase audit)

- **Privacy (Appendix H):** diagnostics NEVER log content/reasoning/partial — only event names,
  counts, categories. Any new diagnostics must follow `proxy.*` naming with `{}` or allow-listed fields.
- **Observational equivalence (§19.7/ADR-005):** the proxy's detection/rewrite is a side effect; it
  must not break the single-start / single-terminal / single-result invariants (INV-002/003).
- **TDD:** every subtask implies write-failing-test → implement → pass. Tests ride with the work.
- **The `_emit()` method is the single forwarding chokepoint** — both primary and replacement events
  pass through it. The Issue 1 rewrite belongs in `_emit()`'s splicing branch.
- **`trackEvent()` runs ONLY in the primary loop** (before `_emit`). Replacement events do NOT run
  `trackEvent` (the buffer is frozen). The `_reasoningEnded` flag (Issue 2) is set in `trackEvent`
  and only applies to the primary stream — correct, since the shortcut is disabled once reasoning ends.
