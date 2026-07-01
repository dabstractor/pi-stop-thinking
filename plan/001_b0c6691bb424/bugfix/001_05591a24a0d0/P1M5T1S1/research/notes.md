# Research Notes — P1.M5.T1.S1 (README/overview docs sync)

**Task**: Update README.md (+ overview docs) to reflect the three completed fixes
(P1.M2 reasoning preservation, P1.M3 shortcut disablement, P1.M4 overlap guard).

## 1. Doc inventory (what exists)

- `README.md` — the **only** user-facing overview/behavior doc (105 lines). HAS an inaccuracy.
- `CHANGELOG.md` — milestone-style changelog (`[1.0.0]` section keyed to P1.M1–P1.M8). Optional secondary touch.
- **No `docs/` directory exists.** No other `.md` files describe behavior (the `plan/**` files are internal
  design artifacts — out of scope). So **README.md is the sole mandatory target.**

## 2. The three fixes now in place (verified in src/ + tests)

| Fix | Module | Source evidence | Runtime guarantee |
|-----|--------|-----------------|-------------------|
| #1 Reasoning preservation (Critical) | P1.M2 | `src/provider/proxy.ts:157,164` (`_frozenPrimaryContent`,`_contentIndexOffset`), replacement-event rewrite in `_emit` | On interruption the **persisted assistant message = `[thinking, text]`** — primary reasoning preserved, answer text follows it. Single continuous response, no restart artifact. |
| #2 Shortcut disablement (Major) | P1.M3 | `src/provider/proxy.ts:179` (`_reasoningEnded`), `:347` (`canInterrupt` gate), `:374` (`triggerStop` guard) | Shortcut is **active only during active reasoning**; disabled on `thinking_end` OR first answer token (§22.4). Pressing Ctrl+. after reasoning ends → ignored (no abort, no replacement). |
| #3 Overlap guard (Minor) | P1.M4 | `src/state/coordinator.ts:109` (`clearActiveProxy(proxy)` guard) | A terminating proxy only clears the coordinator's active slot if it IS the active one → shortcut coverage maintained for overlapping streams. **No previously-inaccurate user-facing claim; internal correctness only.** |

## 3. README accuracy audit (line-by-line)

### INACCURATE — must fix (Fix #1)
- **Line 78 (How it works, #2)**: *"...the reasoning is gone and the answer flows in its place."*
  → **WRONG.** After Fix #1 the reasoning is **preserved**; the answer flows **after** it, not in its place.
  This is the headline correction and the one place the README directly contradicts the corrected behavior.

### ALIGNED-POST-FIX but should be made explicit (Fix #1 + Fix #2)
- **Line 34 (Usage, ¶1)**: *"...the model begins answering in the same assistant turn — no restart, no second prompt."*
  → Accurate (keep), but does NOT state the reasoning is preserved in the saved message. Add the
  `[thinking, text]` preservation fact here (claim a).
- **Line 40 (Usage, ¶2)**: *"if the model is not currently reasoning, the press is silently ignored."*
  → This is now **actually true** (it was a bug pre-fix). Keep, but pin the **§22.4 leave-conditions**
  (`thinking_end` OR first answer token) so the "only during active reasoning" scope (claim b) is explicit.

### ALREADY ACCURATE — no change needed
- Line 16 (Features): "press `Ctrl+.` while the model is reasoning and it stops immediately." — fine.
- Line 91 (Limitations): "One interruption per response" — still true (INV-004); Fix #3 is internal, no
  user-facing claim was wrong. **Do NOT invent new content for Fix #3.**

## 4. Test backing for each claim (validation evidence — cite these)

- **Claim a (`[thinking, text]` preserved)** — `tests/consumer-integration.test.ts:51,86`:
  `expect(result.finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]);`
  (+ negative-control test at `:115,133` proving an *uninterrupted* response has the **same** structure).
- **Claim b (shortcut disabled after reasoning)** — `tests/stream-proxy-reasoning-ended.test.ts:63`
  (EC-005, after `thinking_end`) and `:104` (EC-006, after first `text_start`): both assert
  `canInterrupt()===false`, `triggerStop()===false`, `isAborted()===false`, no `proxy.abort.completed`.

## 5. Constraints / gotchas

- **Docs-only task** (contract MOCKING: "None — documentation only"). NO src/ edits. The `src/` files are
  READ-ONLY references, not edit targets.
- **No markdown linter** configured (package.json has none). Validation = content concordance grep +
  test-backed claim check + `npm run build`/`npm test` sanity (README must not have accidentally touched src).
- **Do NOT invent features.** Only document what the three fixes now guarantee. Fix #3 = no README change.
- **Prose has latitude; facts do not.** The wording can be rephrased, but the phrases "the reasoning is gone"
  and "flows in its place" MUST be removed, and the `[thinking, text]` preservation + "active only during
  reasoning / disabled on thinking_end or first answer token" facts MUST appear.
- KEEP README voice/conciseness (terse, developer-facing; existing sections ≤ ~6 lines).

## 6. Commands (project-verified; bun is at node_modules/.bin/bun)

- `npm run build` (= `tsc`) — the src/ type gate. README edits don't run through it, but run it to confirm no
  accidental source change.
- `npm test` (= `bun test`) — ~390 tests, 0 fail expected. Confirms README change didn't touch behavior.
