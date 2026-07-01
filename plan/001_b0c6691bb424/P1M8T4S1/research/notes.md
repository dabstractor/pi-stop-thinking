# P1.M8.T4.S1 — Research Notes (Property / Stress / Chaos / Regression test suite)

> Subtask: a TEST-ONLY work item. **Zero source files are modified.** Output = 4 new `*.test.ts` files +
> 1 shared test helper. All assertions exercise the already-shipped, stable modules (StreamProxy,
> TransitionController, TransitionCoordinator, ReasoningBuffer, ProviderDecorator) and the golden-replay
> infra from P1.M2.T4.S1.

---

## 1. What this task IS and IS NOT

- **IS**: PRD §55 "Property Tests" + "Stress Tests" + the contract's Chaos + Regression suites.
  Generates **random event sequences with random interruption points** and asserts the Appendix-O
  invariants; runs **1000 interruption cycles** checking memory; **1MB+ reasoning buffers**; **100 rapid
  shortcut presses**; **random error injection**; **golden-fixture byte-identical replay**.
- **IS NOT**: not a feature. No new production code. No `src/` edits. No package.json/tsconfig edits.
- **OUTPUT target (contract)**: "Test suite exceeding 100 test cases covering all PRD invariants and
  failure modes." Existing suite = 223 tests across 21 files. This adds ~110+ more.

## 2. The testable surface (all DONE & STABLE — do NOT modify)

### `StreamProxy` (`src/provider/proxy.ts`) — the primary subject
Constructor (12 positional args, last 7 optional via DI/defaults):
```ts
new StreamProxy(model, context, options, upstreamStreamFn, diagnostics,
                controller?, buffer?, abortTimeoutMs?, requestBuilder?,
                replacementStartupTimeoutMs?, coordinator?)
```
Public surface for assertions:
- `proxy.output` → the single owned `AssistantMessageEventStream` (drain via `for await`; `.result(): Promise<AssistantMessage>`).
- `proxy.controller.getState()` → FSM `TransitionState` (ends `"Idle"` on clean terminal).
- `proxy.authority` → `"forwarding" | "splicing"` (flips to `"splicing"` on first replacement event — **irreversible**, INV-005).
- `proxy.isReasoning()` / `proxy.canInterrupt()` / `proxy.isInterrupting()` / `proxy.isDelegating()`.
- `proxy.triggerStop(): boolean` — dispatches Reasoning→StopRequested→Aborting + aborts internal signal.
  Returns `true` only when `canInterrupt()` (state === Reasoning). **At most one `true` per response (INV-004).**
- `proxy.buffer` → the `ReasoningBuffer` (`getByteSize()`, `snapshot()`, `freeze()`).

### `TransitionController` (`src/state/controller.ts`)
- `getState()`, `canInterrupt()`, `requestStop(): boolean`, `fail(reason)`, `reset()`. `ALLOWED_TRANSITIONS` map (§16 table).

### `TransitionCoordinator` (`src/state/coordinator.ts`) — for rapid-press stress
- `setActiveProxy(proxy)`, `requestStop(): boolean` (idempotent — only one accepted), `alreadyInterrupting()`.
- Structurally assignable to `StopRequestCoordinator` (the ShortcutManager seam).

### `ReasoningBuffer` (`src/buffer/index.ts`) — for large-buffer stress
- `append(delta)` (throws if frozen), `freeze()` (idempotent), `snapshot()` (returns frozen immutable copy),
  `getByteSize()`, `reset()`. Soft ceiling `maximumBytes` → `buffer.overflow` warn (still appends; §23.5 no truncation).

### `ProviderDecorator` (`src/provider/decorator.ts`) — for repeated-init stress
- `new ProviderDecorator(config, diagnostics, registry?)` + `initialize()` / `shutdown()` (idempotent, re-initializable).
- Tests inject a **fake registry** (DI) — never mutate the global pi-ai registry in unit tests.

## 3. The canonical interruption-test harness (VERBATIM pattern to generalize)

`tests/stream-proxy-replacement.test.ts` + `tests/stream-proxy-failure-modes.test.ts` define the
**two-phase upstream mock** this suite MUST reuse/generalize. Shape:
- **Primary phase**: async iterator over a queue; throws `"aborted"` when its signal aborts (the proxy's
  `_internalAbort` — passed via `{ ...options, signal }`).
- **Replacement phase**: 2nd invocation of the same `streamSimple` fn; records `{options}` (asserts
  `reasoning === undefined`); yields replacement events from its own queue + own fresh signal.
- **Drive loop**: `mock.pushPrimary(start) → pushPrimary(thinking_*) → waitFor(proxy.isReasoning) →
  proxy.triggerStop() → waitFor(mock.calls.length===1) → pushReplacement(text_* + done) → drain`.
- `waitFor(pred, timeoutMs=500)` polls every 5ms (helper duplicated in both files).

**The property/chaos generators generalize this**: random #thinking deltas before stop, random
#replacement text deltas after, optional random error injection at a random index.

## 4. `AssistantMessageEventStream` / `EventStream` API (pi-ai `utils/event-stream.ts`) — for INV assertions

- `push(event)`: **no-ops once `done`**. A `done`/`error` event sets `done=true` and resolves `result()`.
- `result(): Promise<AssistantMessage>`: resolves **exactly once** with the terminal's message (done) / error.
- `[Symbol.asyncIterator]`: yields events; exits naturally once done.
- **No public `done` getter** (private). So INV-003 is asserted by **counting terminals in the drained
  `collected[]` array** + `await proxy.output.result()` resolving (race with a timeout to prove no hang).

## 5. Invariant → assertion mapping (Appendix O)

| INV | Meaning | How to assert (from drained `collected[]` + diagnostics + proxy state) |
|-----|---------|------------------------------------------------------------------------|
| INV-001 | Exactly one downstream stream | By construction (`proxy.output` is single); the consumer's single `for await` draining to completion proves it. |
| INV-002 | Exactly one `message_start` | `collected.filter(e => e.type === "start").length === 1`. |
| INV-003 | Exactly one `message_end` | `collected.filter(isTerminalEvent).length === 1` AND `await output.result()` resolves. |
| INV-004 | At most one interruption | `triggerStop()` returned `true` ≤ 1 time across the run; AND count of `proxy.replacement.first-event` traces ∈ {0,1}; AND second `triggerStop()` (while interrupting) returns `false`. |
| INV-005 | Authority transfer irreversible | Read `proxy.authority` at end: if it ever flipped to `"splicing"`, it must STILL be `"splicing"` (never reverts to `"forwarding"`). |
| INV-010 | Cleanup exactly once | `diagnostics.filter(e => e.event === "proxy.lifecycle.cleanup").length === 1`. |

(Contract lists INV-001/002/003/004/005/010 as the property-test targets. INV-006/007/008/009/011/012
are structural/observational and already locked by prior suites; they're covered implicitly. The suite
adds explicit spot-checks for INV-004 (idempotency) and INV-005 (irreversibility) as dedicated tests.)

## 6. Memory check mechanics (Bun)

- `process.memoryUsage().heapUsed` — standard, supported in Bun.
- **`Bun.gc(true)`** — forces a full GC (Bun 1.3.14; verified `node_modules/bun/package.json` version).
  Call before/after the cycle loop. Pattern: run N cycles (each fully drained → proxy eligible for GC),
  `Bun.gc(true)`, measure. Assert heap growth is **bounded** (e.g. < a few MB) AND that a 2nd batch does
  not grow proportionally (no monotonic leak). GC isn't perfectly deterministic → use a **tolerant**
  bound, not "exactly equal".

## 7. File-naming reconciliation (DECISION)

- Contract names them snake_case (`property_tests.test.ts`). **The repo convention is kebab-case** — all
  21 existing files (`stream-proxy-replacement.test.ts`, `transition-controller.test.ts`, …). **Use
  kebab-case** for consistency: `property-tests.test.ts`, `stress-tests.test.ts`, `chaos-tests.test.ts`,
  `regression-tests.test.ts`. (Justified: matches `bun test`'s flat discovery + every sibling file.)
- Shared helper → **`tests/helpers/invariant-harness.ts`** (new dir; NOT `*.test.ts` so bun won't run it;
  tsconfig excludes `tests` so it won't hit the build).

## 8. Property-test approach: SEEDED PRNG (no new dependency)

- The repo has **no property-test library** and a strong hand-rolled ethos. **Do NOT add `fast-check`**.
- Use a **seeded PRNG** (`mulberry32`) so every generated case is **100% reproducible** (a failure prints
  its seed → re-run that exact case). Each seed → one `test()` case → counts toward "100+" naturally.
- Generator: `genScenario(rng)` → `{ preStop: thinkingDeltaCount, postStop: replacementTextDeltaCount,
  interrupt: boolean, interruptAfterDelta: number }`. `runScenario(...)` drives the proxy. Deterministic.

## 9. Parallel boundary with P1.M8.T3.S1 (CONTRACT — zero overlap)

- T3 modifies `src/provider/decorator.ts` + `src/index.ts` + `tests/provider-decorator.test.ts` +
  `tests/factory.test.ts` + creates `tests/lifecycle.test.ts`.
- **This task creates ONLY new files** (`tests/{property,stress,chaos,regression}-tests.test.ts` +
  `tests/helpers/invariant-harness.ts`). **Zero file-level overlap.**
- The "repeated provider init" stress consumes `ProviderDecorator` with the **3-arg ctor** (omits T3's new
  optional `disabledProvider` param) → **behavior-preserving regardless of whether T3 has landed**. Safe.
- (Optional, T3-aware: a decorator disable-flag toggle stress may be added IF T3's param exists, guarded by
  feature-detection — but the core suite must NOT depend on T3.)

## 10. Validation commands (verified working)

- `npx bun run typecheck` → `tsc --noEmit` (checks `src` only; tsconfig excludes `tests`). **Tests are NOT
  type-checked by `typecheck`** — bun runs TS natively via `npx bun test`. (So a type error in a test only
  surfaces at test-run time, not typecheck. Be careful with types in the new files.)
- `npx bun run build` → `tsc` (emits `dist/`; unaffected by test-only changes).
- `npx bun test` → runs every `*.test.ts`. The new files run here. Use `test(name, fn, timeoutMs)` for the
  heavy 1000-cycle loops (bun default timeout = 5000ms; bump to 30000 for stress).
- `npx bun test tests/property-tests.test.ts` → run one file in isolation.

## 11. Risk: flakiness in async mock loops

- The two-phase mock uses `setTimeout(0)` microtask pumps + `waitFor` polling. 1000 cycles × several
  awaits each could take a few seconds. **Mitigate**: keep each cycle minimal (1–3 events), use generous
  per-test timeouts, force `Bun.gc(true)` between batches. If a generated case hangs, the `waitFor`
  500ms timeout surfaces it as a clear failure (with the seed) rather than a CI hang.
