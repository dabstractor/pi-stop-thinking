# Research Notes — P1.M8.T2.S1: Shortcut timing failure modes and edge cases

## 1. Scope triage (what is ALREADY done vs NEW work)

The work-item contract lists 5 logic points (a)–(e). Codebase audit against the current sources
(`src/state/coordinator.ts`, `src/provider/proxy.ts`, `src/shortcut/index.ts`, `src/provider/decorator.ts`,
`src/state/controller.ts`) shows:

| # | Edge cases | Status | Action |
|---|-----------|--------|--------|
| (a) | FM-001/002/003, EC-001/005/006 — `requestStop()` false outside `Reasoning` | **DONE** | add lock-in tests only |
| (b) | EC-002 — pending stop during `Delegating` | **MISSING** | IMPLEMENT (main work) |
| (c) | FM-004/EC-009/EC-010 — first-press-wins | **DONE** | add lock-in tests only |
| (d) | EC-016 — feature disabled | **DONE** | add lock-in test only |
| (e) | EC-017 — replacement returns reasoning | **WRONG (suppresses, should forward)** | CHANGE |

### Why (a) is already done
`TransitionCoordinator.requestStop()` → `if (!proxy.canInterrupt()) return false;` and
`TransitionController.canInterrupt()` returns `true` ONLY in `Reasoning` (PRD §22.5). No-proxy → false
(EC-001). `requestStop()` returns `false` in every non-Reasoning case. Covered by `transition-coordinator.test.ts`.

### Why (c) is already done
`ShortcutManager.handlePress` checks `coordinator.alreadyInterrupting()` FIRST → discards repeats.
`TransitionCoordinator.alreadyInterrupting()` → `proxy.isInterrupting()` → `INTERRUPTING_STATES` set
(StopRequested…Answering). After `triggerStop()` the FSM leaves `Reasoning`, so `canInterrupt()==false` →
second `requestStop()` is rejected. First-press-wins via the FSM, NO coordinator-local counter. Covered by
`shortcut-manager.test.ts` + `transition-coordinator.test.ts`.

### Why (d) is already done
`ProviderDecorator.wrapperStreamSimple`: `const eligible = this.config.enabled && model.reasoning &&
config.supportedProviders.includes(provider)`. If `!config.enabled` → delegates directly, NO proxy
constructed (zero allocation — EC-016). `config.enabled` defaults `true` (`src/config/index.ts:40`).

## 2. EC-017 resolution: FORWARD, not suppress (PRD ground truth)

The current `StreamProxy._emit` REPLACEMENT branch SILENTLY SKIPS thinking events:
```ts
if (isThinkingEvent(event)) { return; /* silent skip */ }   // ← WRONG per PRD EC-017
```
and `tests/stream-proxy-filtering.test.ts` codifies this ("replacement thinking_* suppressed (EC-017)"),
asserting only the PRIMARY's 2 thinking events appear. **This contradicts the PRD.**

PRD EC-017 (verbatim, read from `PRD.md`):
> "The wrapper shall detect renewed reasoning events and, by default, **forward them** rather than
> recursively attempting another interruption. Only one Stop Thinking transition is permitted per logical
> assistant response in the MVP. Recursive interruption is explicitly out of scope."

Work-item contract (e): "forward reasoning events from replacement without recursive interruption."

**Decision: change `_emit` to FORWARD replacement thinking events** (remove the silent skip). Recursive
interruption is structurally impossible because replacement events go through `_emit` ONLY — they NEVER
reach `trackEvent` (the FSM is not driven on the replacement stream), and `triggerStop()` is gated on
`canInterrupt()` which is false once the first transition has left `Reasoning`. §18 "After Restart" rules
describe the NORMAL case (replacement has no reasoning because thinking is disabled); EC-017 is the EDGE
case where reasoning unexpectedly returns — forward it. The existing filtering test must be UPDATED to
expect the replacement reasoning events forwarded.

## 3. EC-002 pending-stop design (the main new work)

### State model
- `Idle` → `Delegating` (on `start`) → `Reasoning` (on first `thinking_*`).
- EC-001 window = `Idle` (proxy active, no `start` yet) → **ignore** (RESEARCH NOTE).
- EC-002 window = `Delegating` (`start` seen, awaiting reasoning, "network stall") → **record pending stop**.

### Coordinator changes (`src/state/coordinator.ts`)
- New field `private pendingStop = false`.
- `requestStop()`: in the existing `!proxy.canInterrupt()` branch, BEFORE returning false, if
  `proxy.isDelegating()` set `this.pendingStop = true` (trace `reason:"pending-stop-recorded"`). Return
  value stays `false` (honors contract (a)). Delegating is detected via a NEW `ActiveProxy.isDelegating()`.
- New `consumePendingStop(): boolean` — atomically reads + clears (proxy calls on first reasoning).
- New `clearPendingStop(): void` — discards (proxy calls when first event is text, EC-003/004).
- `setActiveProxy()` resets `pendingStop = false` on EVERY call (fresh request / teardown) → prevents a
  stale pending stop from a prior request leaking into the next reasoning event.

### Proxy changes (`src/provider/proxy.ts`)
- New `isDelegating(): boolean { return this._controller.getState() === "Delegating"; }` (satisfies the
  expanded `ActiveProxy` interface).
- In `trackEvent`, after the existing `Delegating→Reasoning` transition on the first thinking event:
  `if (this._coordinator?.consumePendingStop()) { this.triggerStop(); }` (state is now Reasoning → legal;
  logs `proxy.pending-stop.triggered`).
- New block in `trackEvent`: `if (isTextEvent(event) && getState()==="Delegating")
  this._coordinator?.clearPendingStop();` (EC-003/004 — provider answers without reasoning).
- `_emit`: forward (don't skip) replacement thinking events (EC-017) + trace `proxy.splice.reasoning-forwarded`.

### Pending-stop end-to-end flow
1. `start` → Delegating. 2. user presses during Delegating → `requestStop()` → `pendingStop=true`, returns false.
3. first `thinking_*` → Delegating→Reasoning → `consumePendingStop()`→true → `triggerStop()` (aborts
   upstream) → next iteration throws → `run()` Aborting path → completeAbort/freeze/`_launchReplacement`.
4. Normal transition proceeds; output stays continuous; no crash.

### Clear-on-text flow (EC-003/004)
1. `start` → Delegating. 2. user presses → `pendingStop=true`. 3. first `text_*` while Delegating →
   `clearPendingStop()` → `pendingStop=false`. No reasoning ever starts → no transition. Correct.

## 4. Production-wiring boundary (NOT this task)

The proxy's `_coordinator?: TransitionCoordinator` is OPTIONAL and is **NOT** passed by the decorator today
(`new StreamProxy(model, context, options ?? {}, originalStreamSimple, this.diagnostics)` — no coordinator
arg). The session coordinator + `setActiveProxy` calls + shortcut registration are owned by the **factory
integration task** (deferred; P1.M8.T1.S1 PRP Scope Boundary confirms `src/index.ts` does not yet build the
coordinator/proxy/shortcut pipeline). **This task implements + tests the LOGIC via DI** (tests inject the
coordinator, exactly like `stream-proxy-*.test.ts` already inject controllers/buffers/coordinators). Do NOT
wire the factory here — that is a separate task and would conflict.

## 5. Parallel-task conflict analysis (P1.M8.T1.S1 telemetry — in flight)

Parallel task touches: `src/telemetry/index.ts` (new), `src/shortcut/index.ts` (telemetry param),
`tests/telemetry.test.ts` (new), `tests/shortcut-manager.test.ts` (extend). **This task touches NONE of
those files** — only `coordinator.ts`, `proxy.ts`, `transition-coordinator.test.ts`,
`stream-proxy-filtering.test.ts`, `stream-proxy-pending-stop.test.ts` (new), `provider-decorator.test.ts`.
Zero file overlap → safe to merge in either order. Telemetry is NOT required by this contract (OUTPUT =
"edge cases handled gracefully, no crashes/broken streams").

## 6. Validation commands (verified in package.json)
- `npx bun run typecheck` → `tsc --noEmit` (zero diagnostics)
- `npx bun run build` → `tsc` (exit 0)
- `npx bun test` → `bun test` (all suites green)

No ruff/mypy — this is TypeScript + Bun. No formatter configured.
