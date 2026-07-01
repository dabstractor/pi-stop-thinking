# PRP — P1.M4.T1.S1: Add `clearActiveProxy(proxy)` guard to coordinator, wire into `_terminate`, add overlap test

## Goal

**Feature Goal**: Prevent a superseded (overlapping) stream's cleanup from disabling shortcut coverage for the currently-active stream. Today `StreamProxy._terminate()` clears the coordinator's single `activeProxy` slot **unconditionally**; if proxy B overwrote proxy A as active, then A's `_terminate()` wipes the slot even though B is still reasoning — B loses shortcut coverage (PRD INV-004 / §37 / EC-013).

**Deliverable**: A guarded `clearActiveProxy(proxy: ActiveProxy)` method on `TransitionCoordinator` that only clears when the terminating proxy **is** the active one; `_terminate()` rewired to call it; a regression test proving overlapping proxies no longer lose coverage.

**Success Definition**: With two overlapping proxies (A then B), terminating A leaves B interruptible; terminating B then clears. The `pendingStop` flag resets **only** on an actual clear. The full `bun test` suite (380+ tests) stays green and `tsc --noEmit` passes clean.

---

## Why

- **Business value**: Issue 3 from the PRD bugfix audit (§h2.3 / §h3.2) is a latent correctness defect in the abort-coordination core. The main agent loop streams sequentially so it is dormant today, but the coordinator "has no guard tying the clear to *which* proxy is active" — any future overlapping eligible stream (e.g. a concurrent auto-compaction/summarization `streamSimple`) silently loses the Ctrl+. shortcut.
- **Integration with existing features**: This completes the `_terminate()` resource-release path (PRD §44) that was introduced in P1.M7.T3.S1 and consumed by the full suite. All `_terminate` paths now use the guarded clear.
- **Scope boundary**: This is a **minor, surgical** change — two production lines + one method + one test file. It does **not** touch the FSM (`src/state/controller.ts`), the buffer, RequestBuilder, types, index, or decorator. It rides WITH documentation (Mode A) — JSDoc updates ship in the same changeset (no separate docs task).

---

## What

A guarded clear: the coordinator keeps its single `activeProxy` slot (the structural design is unchanged — we do **not** switch to a per-stream-id map), but cleanup now clears it **conditionally** on identity.

### Success Criteria

- [ ] `TransitionCoordinator.clearActiveProxy(proxy: ActiveProxy): void` exists and clears `activeProxy` + `pendingStop` **only when** `this.activeProxy === proxy`; otherwise it is a pure no-op (no field mutation, no trace).
- [ ] `StreamProxy._terminate()` calls `this._coordinator?.clearActiveProxy(this)` instead of `setActiveProxy(undefined)`.
- [ ] `StreamProxy` passes `this` and type-checks (it is structurally assignable to `ActiveProxy`).
- [ ] New tests in `tests/transition-coordinator.test.ts` prove: (1) `clearActiveProxy(A)` after B overwrote A is a no-op (B keeps coverage); (2) `clearActiveProxy(B)` when B is active clears; (3) no-op when nothing is active; (4) `pendingStop` resets **only** on an actual clear; (5) the `coordinator.clear-active` trace fires **only** on an actual clear.
- [ ] `_terminate()` JSDoc + the `_coordinator` field JSDoc updated to document the conditional-clear behavior.
- [ ] Full suite green: `bun test`; types clean: `npm run typecheck`.

---

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this successfully?_ — **Yes.** This PRP names exact files, exact line numbers, exact current code, the exact replacement code, the existing test helpers to reuse, the exact trace-name reuse gotcha, and the exact behavioral assertions to write.

### Documentation & References

```yaml
- docfile: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/system_context.md
  why: "§'Issue 3 (MINOR): Coordinator single-slot loses coverage for overlapping streams' — the authoritative root-cause + fix-strategy write-up (3 steps). Read BEFORE editing."
  critical: "Fix strategy step 1 mandates the identity guard `this.activeProxy === proxy` AND resetting `pendingStop` inside the guarded block. Step 3 confirms StreamProxy is structurally assignable to ActiveProxy so passing `this` type-checks."

- docfile: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/P1M4T1S1/research/issue3-context.md
  why: "Curated note: verified line numbers, the trace-name reuse gotcha, the observability decision (no field exposure), and the test infra to reuse."

- file: src/state/coordinator.ts
  why: "ADD the clearActiveProxy method here, directly after setActiveProxy(). Read the class's existing setActiveProxy/consumePendingStop/clearPendingStop for the exact trace name + field-reset convention."
  pattern: "setActiveProxy(proxy | undefined) sets activeProxy, resets pendingStop, and traces 'coordinator.set-active' (proxy) or 'coordinator.clear-active' (undefined). Mirror this trace-name + reset pattern INSIDE the guarded block."
  gotcha: "Do NOT expose the private `activeProxy` field. The contract permits a `get activeProxy()` getter for tests, but behavioral assertions (requestStop / consumePendingStop) are preferred to keep the public API minimal. Tests in this file NEVER read activeProxy directly today."

- file: src/provider/proxy.ts
  why: "MODIFY exactly ONE line (487) inside _terminate()'s resource-release section, plus its JSDoc + the _coordinator field JSDoc."
  pattern: "Resource release is order-independent and each release is total (see the _terminate block ~lines 456–488). The coordinator clear is the LAST release line."
  gotcha: "StreamProxy must stay structurally assignable to ActiveProxy (it already exposes isReasoning()/canInterrupt()/triggerStop()/isInterrupting()/isDelegating() — verify these 5 methods all exist with matching signatures before relying on `this`). Do NOT import ActiveProxy into proxy.ts (structural typing — no import needed)."

- file: tests/transition-coordinator.test.ts
  why: "ADD a new describe() block here reusing the file's existing makeCaptureDiag() + makeFakeProxy() helpers. This is the ONLY test file to modify."
  pattern: "makeFakeProxy({ canInterrupt, delegating, interrupting, reasoning, triggerThrows }) returns { proxy, triggerStopCalls }; makeCaptureDiag() returns { diag, events }. Tests assert on requestStop() return values, triggerStopCalls counts, consumePendingStop() booleans, and captured trace events."
  gotcha: "setActiveProxy(undefined) ALSO traces 'coordinator.clear-active'. Any test that COUNTS that trace string must use clearActiveProxy exclusively (or count precisely) to avoid cross-contamination."
```

### Current Codebase tree (relevant slice)

```bash
src/
  state/
    coordinator.ts      # MODIFY — add clearActiveProxy(proxy)
    controller.ts       # NOT MODIFIED (FSM stays as-is)
  provider/
    proxy.ts            # MODIFY — _terminate() line 487 + 2 JSDoc blocks
tests/
  transition-coordinator.test.ts   # MODIFY — add overlap-guard describe() block
  helpers/
    invariant-harness.ts           # REFERENCE — has buildProxy() if a real-proxy variant is wanted
```

### Desired Codebase tree with files to be added/modified

```bash
src/state/coordinator.ts            # +1 public method (clearActiveProxy), no field exposure
src/provider/proxy.ts               # 1 line changed (487) + 2 JSDoc edits
tests/transition-coordinator.test.ts # +1 describe() block (5 tests)
```

No new files.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL: the activeProxy field is PRIVATE — do not add a public setter or expose it broadly.
// The guard MUST be encapsulated inside clearActiveProxy. Test via observable behavior, not field reads.

// CRITICAL (trace-name reuse): setActiveProxy(undefined) traces 'coordinator.clear-active' TODAY.
// The new clearActiveProxy reuses the SAME trace name (intentional — it's the same semantic event).
// So a diagnostic count of 'coordinator.clear-active' is polluted if a test also calls setActiveProxy(undefined).
// Mitigation: in clear-only tests, never call setActiveProxy(undefined); use clearActiveProxy exclusively.

// CRITICAL: clearActiveProxy must be a pure NO-OP (no field mutation, NO trace) when the proxy is NOT active.
// This is the whole point of the guard — a non-active terminator must not perturb the still-active stream's
// pendingStop or coverage. Do NOT trace on the no-op path.

// GOTCHA: pendingStop reset is INSIDE the guarded block (resets ONLY on an actual clear), mirroring
// setActiveProxy(undefined). A no-op clearActiveProxy(A) must leave a pendingStop recorded on B intact.

// GOTCHA: StreamProxy → ActiveProxy is STRUCTURAL (no `implements`, no import). Passing `this` from
// _terminate type-checks only because StreamProxy has all 5 ActiveProxy methods. Do not weaken any signature.
```

---

## Implementation Blueprint

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY src/state/coordinator.ts — add clearActiveProxy(proxy)
  - ADD a new public method IMMEDIATELY AFTER setActiveProxy() (keeps set/clear methods grouped).
  - EXACT implementation:
      clearActiveProxy(proxy: ActiveProxy): void {
        if (this.activeProxy === proxy) {
          this.activeProxy = undefined;
          this.pendingStop = false;
          this.diagnostics.trace("coordinator.clear-active", {});
        }
      }
  - SEMANTICS: identity guard `this.activeProxy === proxy`. On match: clear slot + reset pendingStop
    + trace 'coordinator.clear-active' (same name as setActiveProxy(undefined) — intentional). On
    miss: PURE no-op (no mutation, NO trace).
  - JSDOC: document (a) the guard prevents a superseded stream from clearing an active concurrent
    stream (PRD INV-004 / Issue 3); (b) it clears + resets pendingStop only on match; (c) no-op on
    miss. Reference PRD §37 + the architecture doc §Issue 3.
  - DO NOT: add a public setter, expose activeProxy as a settable field, or import StreamProxy.
    (A `get activeProxy()` getter is permitted by the contract but NOT required — prefer none.)
  - PRESERVE: setActiveProxy, consumePendingStop, clearPendingStop, requestStop unchanged.

Task 2: MODIFY src/provider/proxy.ts — rewire _terminate() (line 487) + JSDoc
  - REPLACE line 487:
      OLD: this._coordinator?.setActiveProxy(undefined); // release the transition token / coordinator handle (§44)
      NEW: this._coordinator?.clearActiveProxy(this);     // conditional clear (Issue 3 overlap guard) — only clears if THIS proxy is the active one
  - VERIFY: `this` (a StreamProxy) is structurally assignable to ActiveProxy. Confirm the 5 methods
    exist on the class: isReasoning(), canInterrupt(), triggerStop(), isInterrupting(), isDelegating().
    (They do — all are present near the getters. No import of ActiveProxy is needed.)
  - UPDATE JSDoc #1 — _terminate()'s class-doc "Resource release (PRD §44)" paragraph: change "clear
    the coordinator's active-proxy reference" to note it is now a CONDITIONAL clear — only fires if
    THIS proxy is the active one (so overlapping concurrent streams keep coverage). Cite Issue 3 / INV-004.
  - UPDATE JSDoc #2 — the `_coordinator` FIELD doc (~line 209-214): it currently says "T3's cleanup
    path calls `this._coordinator?.setActiveProxy(undefined)`". Reword to "calls
    `this._coordinator?.clearActiveProxy(this)` (guarded — Issue 3)".
  - DO NOT: change any other _terminate line, any other coordinator call site, or the constructor.

Task 3: MODIFY tests/transition-coordinator.test.ts — add overlap-guard describe() block
  - ADD one new describe() block at the end of the file (reuses makeCaptureDiag + makeFakeProxy +
    the ActiveProxy type import already at the top).
  - NAMING: "TransitionCoordinator — overlap guard: clearActiveProxy only clears the active one (Issue 3)"
  - COVERAGE — write these 5 tests (behavioral assertions, NO activeProxy field reads):
      test("clearActiveProxy(A) after B overwrote A is a no-op: B keeps coverage"):
        - setActiveProxy(A); setActiveProxy(B); clearActiveProxy(A);
        - assert c.requestStop() === true  AND  B.triggerStopCalls.value === 1   (B still active).
      test("clearActiveProxy(B) when B IS active clears coverage"):
        - setActiveProxy(B); clearActiveProxy(B);
        - assert c.requestStop() === false   (no active proxy; EC-001 reason 'no-active-proxy').
      test("clearActiveProxy is a no-op when there is no active proxy"):
        - (nothing set) clearActiveProxy(A);
        - assert c.requestStop() === false.
      test("clearActiveProxy resets pendingStop ONLY when it actually clears"):
        - setActiveProxy(B{canInterrupt:false, delegating:true}); c.requestStop() → records pendingStop on B;
        - clearActiveProxy(A)  // A not active → no-op → pendingStop survives
        - assert c.consumePendingStop() === true;
        - c.requestStop() // re-record
        - clearActiveProxy(B) // B IS active → clears + resets pendingStop
        - assert c.consumePendingStop() === false.
      test("trace 'coordinator.clear-active' fires ONLY on an actual clear"):
        - setActiveProxy(B);   // traces 'coordinator.set-active', NOT clear-active
        - clearActiveProxy(A); // no-op → assert events.filter(...'coordinator.clear-active').length === 0
        - clearActiveProxy(B); // clears   → assert length === 1.
  - GOTCHA in the last test: do NOT call setActiveProxy(undefined) anywhere (it also traces
    'coordinator.clear-active'); use clearActiveProxy exclusively so the count is unambiguous.
  - PLACEMENT: append after the last existing describe() block in the file.
```

### Implementation Patterns & Key Details

```typescript
// === coordinator.ts — the new method (place directly after setActiveProxy) ===

/**
 * Clear the active-proxy reference ONLY IF the requesting proxy IS the currently-active one
 * (P1.M4.T1.S1 — Issue 3 overlap guard; PRD INV-004 / §37). Prevents a superseded stream's
 * `_terminate()` from disabling shortcut coverage for a still-active concurrent stream that
 * overwrote it via a later `setActiveProxy`.
 *
 * - MATCH (this.activeProxy === proxy): clears the slot to `undefined` AND resets `pendingStop`
 *   (mirroring `setActiveProxy(undefined)`), then traces `coordinator.clear-active`.
 * - MISS: a PURE no-op — no field mutation, no trace — so the still-active stream retains its
 *   coverage and its own pending stop.
 *
 * @param proxy the proxy requesting the clear (the terminating stream). StreamProxy is
 *              structurally assignable to ActiveProxy, so proxy._terminate() passes `this`.
 */
clearActiveProxy(proxy: ActiveProxy): void {
  if (this.activeProxy === proxy) {
    this.activeProxy = undefined;
    this.pendingStop = false;
    this.diagnostics.trace("coordinator.clear-active", {});
  }
}

// === proxy.ts _terminate() — the one changed line ===
//   OLD: this._coordinator?.setActiveProxy(undefined);
//   NEW: this._coordinator?.clearActiveProxy(this);  // guarded (Issue 3)
```

### Integration Points

```yaml
FSM (src/state/controller.ts): NONE — untouched. The flag/FSM approach is unchanged.
BUFFER / REQUESTBUILDER / TYPES / INDEX / DECORATOR: NONE — untouched.
COORDINATOR PUBLIC API: +1 method (clearActiveProxy). setActiveProxy/consumePendingStop/
  clearPendingStop/requestStop/isReasoning/alreadyInterrupting unchanged.
TEST HELPERS: reuse makeCaptureDiag() + makeFakeProxy() already in the test file; no new helpers.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type check after each edit — the structural-assignability of StreamProxy→ActiveProxy is the key check.
npm run typecheck          # == tsc --noEmit  → EXPECT: zero errors.

# Build (also runs tsc with emit) — confirms the whole graph compiles.
npm run build              # == tsc           → EXPECT: zero errors.
```

> NOTE: this project uses **TypeScript + bun:test**. There is no `ruff`/`mypy`/`pytest`. The linting
> surface is `tsc --noEmit`. Run it after Task 1 (structural type of the new method) and again after
> Task 2 (confirm `this` is assignable to `ActiveProxy`).

### Level 2: Unit Tests (Component Validation)

```bash
# The coordinator + the new overlap-guard tests:
bun test tests/transition-coordinator.test.ts -v          # EXPECT: all pass, incl. the new 5 tests.

# The proxy suite — confirms the _terminate() rewire did not regress any cleanup path:
bun test tests/stream-proxy-lifecycle.test.ts -v
bun test tests/stream-proxy-abort.test.ts -v
bun test tests/stream-proxy-race.test.ts -v
```

### Level 3: Integration / Full Suite (System Validation)

```bash
# Full suite — the overlap guard is consumed by EVERY _terminate path, so the whole suite is the
# regression net (was 380 pass / 0 fail per the PRD audit; should stay 0 fail).
bun test                                                    # EXPECT: all pass, 0 fail.

# A targeted behavioral check that the wiring is live: drive a real proxy through _terminate via the
# invariant harness (buildProxy) and confirm a second overlapping proxy keeps coverage. This is
# OPTIONAL — the unit tests in Task 3 already prove the coordinator logic; the harness check proves
# the proxy→coordinator wiring end-to-end:
bun test tests/stream-proxy-lifecycle.test.ts -v
```

### Level 4: Domain-Specific Validation

```bash
# Privacy guard (PRD Appendix H): the new trace 'coordinator.clear-active' logs {} only (no content).
# Verify by inspecting the test in Task 3 — its assertion does not introduce any content-bearing fields,
# and the existing 'TransitionCoordinator — privacy guard' describe() block continues to pass:
bun test tests/transition-coordinator.test.ts -v          # includes the privacy-guard block.
```

---

## Final Validation Checklist

### Technical Validation

- [ ] `npm run typecheck` passes with zero errors (confirms `clearActiveProxy(proxy: ActiveProxy)` signature + `this` assignability).
- [ ] `npm run build` passes with zero errors.
- [ ] `bun test tests/transition-coordinator.test.ts` passes, including the 5 new overlap-guard tests.
- [ ] `bun test` (full suite) — all pass, 0 fail.

### Feature Validation

- [ ] All 5 success-criteria tests from Task 3 pass (no-op on miss, clear on match, no-op when idle, pendingStop resets only on clear, trace fires only on clear).
- [ ] `_terminate()` now calls `clearActiveProxy(this)` (line 487 changed; grep `setActiveProxy(undefined)` in proxy.ts returns ZERO hits in `_terminate`).
- [ ] Error/cleanup paths unaffected (the full proxy suite stays green — the guarded clear is a superset-safe change: when there's only one stream, `this === activeProxy` so it clears exactly as before).
- [ ] Overlapping streams no longer lose shortcut coverage.

### Code Quality Validation

- [ ] `clearActiveProxy` placed directly after `setActiveProxy` (set/clear methods grouped).
- [ ] No new public field exposure (no settable `activeProxy`); guard encapsulated in the method.
- [ ] JSDoc on `clearActiveProxy`, `_terminate()` resource-release paragraph, and the `_coordinator` field all updated to document the conditional clear.
- [ ] Reuses `makeCaptureDiag` + `makeFakeProxy` (no reinvented helpers); test file imports unchanged.

### Documentation & Deployment (Mode A — rides WITH the work)

- [ ] `_terminate()` JSDoc notes the conditional clear (Issue 3 / INV-004).
- [ ] `_coordinator` field JSDoc reworded from "setActiveProxy(undefined)" to "clearActiveProxy(this)".
- [ ] No new environment variables or config (none introduced).

---

## Anti-Patterns to Avoid

- ❌ Don't expose the private `activeProxy` field as a public setter or broad getter — the guard must be encapsulated. (A test-only `get activeProxy()` is permitted by the contract but behavioral assertions are preferred.)
- ❌ Don't trace or mutate on the no-op (miss) path — that is the entire point of the guard.
- ❌ Don't reset `pendingStop` outside the guarded block — it must reset **only** on an actual clear (mirrors `setActiveProxy(undefined)`).
- ❌ Don't switch the coordinator to a per-stream-id map — the PRD fix strategy explicitly keeps the single slot and adds the identity guard.
- ❌ Don't import `ActiveProxy` into `proxy.ts` — the assignability is structural.
- ❌ Don't change the FSM, buffer, RequestBuilder, types, index, or decorator — explicitly out of scope.
- ❌ Don't count the `coordinator.clear-active` trace in a test that also calls `setActiveProxy(undefined)` — they share the trace name.

---

## Confidence Score

**9/10** — This is a minimal, surgical, fully-specified change (1 method + 1 line + 1 test block) with the exact code, exact line numbers, exact test assertions, and verified validation commands provided. The only residual risk is a subtle test-authoring mistake around the shared `coordinator.clear-active` trace name, which is explicitly flagged in the gotchas. No external research is required — this is a pure in-codebase concurrency-correctness fix.
