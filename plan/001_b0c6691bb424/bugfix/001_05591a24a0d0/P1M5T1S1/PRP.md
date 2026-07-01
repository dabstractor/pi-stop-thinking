# PRP — P1.M5.T1.S1: Update README.md and overview docs to reflect reasoning-preservation and shortcut-scope fixes

> **Bugfix**: Stream Integrity & Shortcut Lifecycle — the **final changeset-level documentation sync** (SOW §5,
> Mode B). The three code fixes are **already complete** (P1.M2 reasoning preservation ✓, P1.M3 shortcut
> disablement ✓, P1.M4 overlap guard ✓ — see `plan_status`). This subtask brings the **user-facing docs** in
> line with the corrected runtime behavior. **It is documentation-only** (contract MOCKING: *"None —
> documentation only"*): NO source edits, NO new tests, NO config changes.
>
> **The single defect this fixes**: `README.md` line 78 ("How it works", step 2) says the interruption leaves
> *"the reasoning … gone and the answer flows in its place."* After the P1.M2 fix that is now **wrong** — the
> reasoning is **preserved**, and the answer **follows** it (the persisted message is `[thinking, text]`).
> Several other lines are accurate *now* (they describe intent the code only recently achieved) and should be
> sharpened to state the two corrected guarantees precisely.
>
> **What this subtask is NOT**: it does NOT change any `.ts` file, `package.json`, `tsconfig.json`, the PRD,
> or any test. It does NOT document Fix #3 (coordinator overlap guard) in the README — that is an internal
> correctness fix with **no** previously-inaccurate user-facing claim, so inventing a sentence about it would
> violate "Do NOT invent features." It is NOT a CHANGELOG entry task (CHANGELOG is optional secondary — see
> Task 5; the hard deliverable is `README.md`).

---

## Goal

**Feature Goal**: Make `README.md` (the project's only user-facing overview/behavior doc) accurately describe
the **corrected** Stop-Thinking runtime behavior across the two areas the fixes changed: **(a)** on
interruption, the persisted assistant message **preserves the streamed reasoning** as a `[thinking, text]`
content sequence — a single continuous response with no restart artifact (Fix #1); and **(b)** the shortcut is
**active only during active reasoning**, disabled the moment reasoning ends on `thinking_end` or the first
answer token (Fix #2). Remove the one sentence that now contradicts the code, and sharpen the two usage
sentences that were under-specified.

**Deliverable**:
- `README.md` — MODIFIED (prose edits in 2 sections, ≤4 lines changed):
  - **How it works**, step 2 — replace the inaccurate *"the reasoning is gone and the answer flows in its
    place"* with an accurate statement that the reasoning is **preserved** and the answer **follows** it,
    yielding a normal `[thinking, text]` message (claim a).
  - **Usage**, ¶1 — keep the "no restart, no second prompt" sentence; append the reasoning-preservation fact
    (claim a).
  - **Usage**, ¶2 — keep *"silently ignored"*, but make the reasoning-scope explicit: reasoning ends on
    `thinking_end` or the first answer token, after which the shortcut is disabled (claim b).
  - (Optional) **Features** — one bullet stating reasoning is preserved (claim a).
- NO other files modified. `git diff --stat` shows **only** `README.md` (and, optionally, `CHANGELOG.md`).

**Success Definition**:
- `README.md` contains **none** of the now-inaccurate phrases (`grep` for "reasoning is gone", "flows in its
  place" → **0 matches**).
- `README.md` **does** state, in plain language, both corrected guarantees (claim a: reasoning preserved /
  `[thinking, text]`; claim b: shortcut active only during reasoning / disabled on `thinking_end` or first
  answer token).
- Every README claim is **backed by a currently-passing test** (see Validation Level 3): claim a ↔
  `tests/consumer-integration.test.ts`; claim b ↔ `tests/stream-proxy-reasoning-ended.test.ts`.
- `npm run build` and `npm test` are green (0 fail) — proof the doc edit did not touch any code.
- `git diff --stat -- src/` is **empty** (no source files changed).

---

## Why

- **Line 78 is a live contradiction.** The README shipped in `268c74c` ("Ship production README and v1.0.0
  changelog") *before* the bug report (`adc99a7`) and the fixes. Its "the reasoning is gone and the answer
  flows in its place" described the *buggy* behavior, not the *intended* behavior. The P1.M2 fix (`caeface`,
  `4bb4758`, `064e321`) made the proxy **rewrite** replacement events so the persisted message is
  `[thinking, text]` — the README must now say that, or users/`docs/` consumers read a falsehood.
- **The other two lines were aspirational; the fixes made them true.** "if the model is not currently
  reasoning, the press is silently ignored" (line 40) was *false* before P1.M3 (`3e614dc`, `dedce67`) — the
  shortcut wrongly stayed armed during the answer. It is now *true*. Sharpening it to name the §22.4
  leave-conditions removes ambiguity about exactly when the shortcut stops working (the whole point of
  EC-005/EC-006).
- **Why fix #3 is NOT documented here:** the coordinator overlap guard (`b6857c3`) is internal correctness —
  it prevents a latent edge case where overlapping streams lose shortcut coverage. No README sentence was ever
  wrong about it (the "One interruption per response" / INV-004 guarantee still holds). Adding prose would be
  documenting an internal invariant the user never interacts with → "inventing features." Per the contract, the
  correct action for Fix #3 is **no README change**.
- **This is the agreed final sweep.** SOW §5 / Mode B: this *is* the changeset-level doc-sync task. Doing it
  last (after the code lands and is test-backed) means every README claim can be verified against a green test
  rather than against intent.

## What

A small, surgical prose edit to `README.md` (the only overview doc — there is no `docs/` directory; see
Context). Three to four sentences change. The existing terse, developer-facing voice is preserved (no new
sections are required — the relevant sections, **Usage** and **How it works**, already exist). The implementer
has prose latitude in *how* to phrase each edit, but the **factual claims are fixed** (the MUST / FORBIDDEN
lists below). Optionally, a one-block bugfix entry is added to `CHANGELOG.md`.

### Success Criteria

- [ ] `README.md` line-78 sentence is corrected: reasoning is **preserved** (not "gone"), answer **follows**
      the reasoning, message is a normal `[thinking, text]` sequence.
- [ ] `README.md` **Usage** ¶1 states the reasoning-preservation fact (claim a).
- [ ] `README.md` **Usage** ¶2 states the shortcut-scope fact (claim b): active only during active reasoning;
      disabled on `thinking_end` or the first answer token.
- [ ] `grep -n "reasoning is gone\|flows in its place" README.md` → **no output** (the contradiction is gone).
- [ ] `grep -ni "preserv\|thinking.*text\|\[thinking" README.md` → **matches** in the corrected sections.
- [ ] `grep -ni "active only while\|thinking_end\|first answer token\|disabled" README.md` → **matches**.
- [ ] `npm run build` and `npm test` are green; `git diff --stat -- src/` is **empty**.
- [ ] (Optional CHANGELOG) a factual `### Fixed`/`[Unreleased]` block; no invented features.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the exact current README sentences are quoted verbatim (with their line numbers), the exact corrected
behavior is stated (cross-referenced to the PRD §22.4/§22.5 and to the passing tests that prove it), the
MUST/FORBIDDEN claim lists pin the facts, and the validated commands are listed. The implementer needs no
prior proxy/FSM knowledge — only the ability to edit prose and run grep/build/test.

### Documentation & References

```yaml
# MUST READ — the bug report (intended behavior) + the exact leave-conditions
- file: PRD.md
  why: "§22.4 Leave Reasoning: 'Reasoning ends upon: thinking_end OR first answer token OR provider completion.'
        §22.5 Shortcut Availability: 'The shortcut is active only while: Current State == Reasoning.' These are
        the authoritative definitions the README's claim (b) must paraphrase."
  section: "§22.4 (lines ~2027–2041) and §22.5 (lines ~2043–2049)"
  critical: "The README's claim (b) MUST mention BOTH §22.4 leave-triggers the fix gates on — thinking_end AND
             the first answer token. 'Provider completion' is also a leave-condition but need not be named in
             prose (the shortcut is moot once the turn ends)."

# MUST READ — the bug report's expected-behavior wording (the canonical phrasing of claim a)
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/prd_snapshot.md   # = PRD h2.0–h2.4 snapshot
  why: "h2.1 'Expected Behavior': the assistant message 'should look like a NORMAL z.ai reasoning response:
        content blocks [thinking, text] — the reasoning that streamed before the interrupt is PRESERVED, and
        the answer text FOLLOWS it … no visible restart.' h2.2 Expected Behavior: shortcut 'must be DISABLED'
        once reasoning ends; pressing Ctrl+. 'must do nothing.' This is the wording the README should echo."
  critical: "Use 'preserved' (the bug-report's word) over synonyms — it ties the README to the test/assertion
             vocabulary. 'no restart artifact' / 'single continuous response' is the G4 phrasing."

# MUST READ — THE file being edited (read it fully before editing; quotes below are line-anchored)
- file: README.md
  why: "The 3 edit sites: Usage ¶1 (line 34), Usage ¶2 (line 40), How it works #2 (line 78). Optional:
        Features list (~line 16). Read the whole file first so the edits stay in-voice."
  pattern: "Terse, developer-facing prose; each Features/Usage/Limitations bullet is one sentence; the ASCII
            flow diagram on the Usage line (~36) and the 'How it works' numbered list are the structural
            anchors. Preserve them; edit only the sentences named in the Tasks."
  gotcha: "Line 78 is inside the numbered 'How it works' list (item 2). Keep the item as ONE bullet; do not
           split into sub-bullets. Keep the existing 'merged into the same downstream AssistantMessageEventStream'
           clause (still true) — only the trailing clause after the em dash is wrong."

# PATTERN — optional secondary touch (only if the implementer chooses Task 5)
- file: CHANGELOG.md
  why: "Keep-a-Changelog format. The [1.0.0] block is keyed to milestones (P1.M1–P1.M8). A bugfix sweep adds an
        [Unreleased] (or [1.0.1]) block with an ### Added/### Fixed subsection listing the three fixes
        factually. OPTIONAL — the hard deliverable is README.md only."
  gotcha: "Do NOT add a CHANGELOG entry if it would imply a version bump the release process doesn't intend.
           When in doubt, SKIP Task 5 entirely — it is not required for success."

# PROOF — the two tests that back the README's claims (read-only references, NOT edit targets)
- file: tests/consumer-integration.test.ts
  why: "Line 51 + 86: the interrupted stream's finalMessage.content types === ['thinking','text'] (reasoning
        PRESERVED). Line 115/133: an UNINTERRUPTED stream has the SAME structure (observational equivalence).
        These two tests ARE the proof for claim (a) — the README's '[thinking, text]' sentence is true because
        these pass."
- file: tests/stream-proxy-reasoning-ended.test.ts
  why: "Line 63 (EC-005): after thinking_end → canInterrupt()===false, triggerStop()===false, no abort.
        Line 104 (EC-006): after first text_start → same. These ARE the proof for claim (b) — the README's
        'disabled once reasoning ends' sentence is true because these pass."
```

### Current Codebase tree (relevant slice)

```bash
# User-facing docs (the whole "overview docs" surface — there is no docs/ dir):
README.md          # ← EDIT: Usage ¶1 (l.34), Usage ¶2 (l.40), How it works #2 (l.78); optional Features bullet
CHANGELOG.md       # (optional) add an [Unreleased]/[1.0.1] ### Fixed block
# Proof references (READ-ONLY — do NOT edit):
tests/consumer-integration.test.ts          # backs claim (a): [thinking, text] preserved end-to-end
tests/stream-proxy-reasoning-ended.test.ts  # backs claim (b): shortcut disabled after reasoning
PRD.md                                       # §22.4 / §22.5 — authoritative leave-conditions + availability
plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/prd_snapshot.md   # h2.0–h2.4 (canonical expected-behavior wording)
# src/ is READ-ONLY for this task (the fixes are already shipped):
src/provider/proxy.ts        # _frozenPrimaryContent/_contentIndexOffset (l.157/164), _reasoningEnded (l.179),
                             #   canInterrupt gate (l.347), triggerStop guard (l.374)
src/state/coordinator.ts     # clearActiveProxy guard (l.109) — Fix #3, NOT documented in README
```

### Desired Codebase tree with file responsibilities

```bash
README.md          # MODIFIED — corrected & sharpened stop-thinking behavior (claims a + b). ~4 sentences change.
CHANGELOG.md       # (OPTIONAL) MODIFIED — +1 factual bugfix block. May be left untouched (not required).
# All other files unchanged. git diff --stat -- src/ tests/ PRD.md = EMPTY.
```

### Known Gotchas of our codebase & Library Quirks

```text
# CRITICAL (the one live falsehood — the headline fix): README l.78 ends with "the reasoning is gone and the
# answer flows in its place." After P1.M2 this is BACKWARDS. The reasoning is PRESERVED; the answer FOLLOWS it.
# This single clause is why this subtask exists. Fix it (Task 1). Everything else is sharpening.

# CRITICAL (line 40 was aspirational, now true — don't delete it, sharpen it): "if the model is not currently
# reasoning, the press is silently ignored" was FALSE before P1.M3 (the shortcut stayed armed during the
# answer). It is now TRUE. Keep the sentence; ADD the §22.4 leave-conditions (thinking_end OR first answer
# token) so "currently reasoning" is unambiguous (Task 2). Do NOT rewrite it to something weaker.

# CRITICAL (claim b needs BOTH leave-triggers the code gates on): the code sets _reasoningEnded on
# `thinking_end` OR `isTextEvent` OR `isToolCallEvent` (proxy.ts step 3b). The README's claim (b) must mention
# thinking_end AND the first answer token. Missing either understates the fix.

# CRITICAL (do NOT invent content for Fix #3): the coordinator overlap guard (coordinator.ts:109) is internal.
# No README sentence was ever wrong about it; INV-004 ("one interruption per response") still holds. Adding a
# sentence about "overlapping streams" would document an internal invariant the user never sees = inventing a
# feature. The correct action for Fix #3 is NO README change. (This is explicitly called out so the
# implementer doesn't "balance" the three fixes with three doc edits.)

# GOTCHA (README is not compiled): `npm run build` (tsc) does NOT lint README. There is NO markdown linter in
# the project (package.json has none). So README validation is by CONCORDANCE grep (claim present / falsehood
# absent) + cross-checking claims against passing tests — NOT a type/lint gate. Run `npm run build` and
# `npm test` only to PROVE no code was accidentally touched.

# GOTCHA (preserve the existing structural anchors): do not touch the ASCII flow diagram (Usage, ~l.36) or the
# numbered "How it works" list structure. Edit sentences in place. Keep the `AssistantMessageEventStream` and
# `AbortController` references in l.78 — only the trailing em-dash clause is wrong.

# GOTCHA (voice): README is terse and developer-facing. Keep edits to ~1 sentence each (the existing bullets
# are single sentences). Do not add a new top-level section — Usage + How it works already cover it. If you do
# add the optional Features bullet, keep it one line.

# SCOPE: edit ONLY README.md (+ optional CHANGELOG.md). Do NOT edit PRD.md, any tasks.json, prd_snapshot.md,
# any .ts file, package.json, or tsconfig.json. `git diff --stat -- src/` must be EMPTY after the task.
```

---

## Implementation Blueprint

### Data models and structure

None — this is prose. There are no types, schemas, or data structures. The "structure" is the README's section
layout, which is **unchanged**: edits happen in-place within the existing **Features**, **Usage**, and
**How it works** sections.

### Fixed factual claims (prose has latitude; these facts do not)

```yaml
# These MUST be true of the README after editing (phrasing is free; the facts are fixed):
CLAIM_A_preservation:            # from Fix #1, PRD h2.1 "Expected Behavior", G4
  - "On interruption the streamed reasoning is PRESERVED in the assistant message."
  - "The resulting/persisted message is a normal [thinking, text] sequence (reasoning, then the answer)."
  - "It is a single continuous response — no restart artifact."
  FORBIDDEN:
  - "the reasoning is gone"            # the l.78 falsehood — must be removed
  - "flows in its place"               # ditto
  - anything implying the reasoning is discarded/replaced/vanishes

CLAIM_B_shortcut_scope:          # from Fix #2, PRD §22.4/§22.5, EC-005/EC-006, RC-002
  - "The shortcut is active ONLY while the model is actively reasoning."
  - "Reasoning ends on thinking_end OR the first answer token (text/tool-call)."
  - "After reasoning ends, pressing Ctrl+. is ignored (no abort, no new request)."
  FORBIDDEN:
  - anything implying the shortcut can interrupt the answer phase
  - "while the model is reasoning" used WITHOUT pinning the leave-conditions is acceptable but INSUFFICIENT
    (must be sharpened to name thinking_end / first answer token somewhere in Usage ¶2 or How it works)

CLAIM_C_fix3:                    # Fix #3 — coordinator overlap guard
  ACTION: "NO README CHANGE. Internal correctness; no previously-wrong user-facing claim. Do not document."
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY README.md — correct the headline falsehood in "How it works", step 2 (line 78)   [Fix #1]
  - FIND (line 78, the trailing em-dash clause — the ONLY part that is wrong):
      "…so Pi sees one continuous, uninterrupted assistant turn — the reasoning is gone and the answer flows in its place."
  - REPLACE the clause AFTER the em dash with an accurate one. RECOMMENDED wording (prose may vary; facts fixed):
      "…so Pi sees one continuous, uninterrupted assistant turn. The reasoning captured before the
       interruption is preserved, and the answer text follows it — the resulting message is a normal
       `[thinking, text]` sequence, the same shape as a non-interrupted reasoning response, with no restart
       artifact."
  - KEEP: the clause "The replacement stream's events are merged into the same downstream
    `AssistantMessageEventStream`" (still true — events are merged, then rewritten to preserve reasoning).
  - KEEP: item 2 as ONE bullet in the numbered list; keep the `AbortController` / "freezes the captured
    reasoning buffer" / "thinking-disabled replacement request" clauses. Sharpen "merged" → "rewritten and
    merged" only if you like (the proxy rewrites contentIndex + partial before merging).
  - DEPENDENCIES: none (read PRD h2.1 + tests/consumer-integration.test.ts for the canonical wording).
  - VALIDATION after edit: `grep -n "reasoning is gone\|flows in its place" README.md` → no output.

Task 2: MODIFY README.md — sharpen "Usage" ¶2 to state the shortcut-scope (claim b)   [Fix #2]
  - FIND (line 40):
      "The shortcut is evaluated per-press: if the model is not currently reasoning, the press is silently
       ignored. Only one interruption is accepted per response; additional presses during the transition are
       discarded."
  - KEEP the "per-press / silently ignored / one interruption per response / transition discarded" facts (all
    still true). INSERT one sentence (or extend the first) naming the §22.4 leave-conditions. RECOMMENDED:
      "The shortcut is active only while the model is actively reasoning. Reasoning ends the moment the model
       emits `thinking_end` or its first answer token — after that, pressing **Ctrl+.** is silently ignored
       (the model is already answering). Only one interruption is accepted per response; additional presses
       during the transition are discarded."
  - VALIDATION after edit: `grep -ni "thinking_end\|first answer token\|active only" README.md` → ≥1 match.

Task 3: MODIFY README.md — extend "Usage" ¶1 with the reasoning-preservation fact (claim a)   [Fix #1]
  - FIND (line 34):
      "While the model is reasoning, press **Ctrl+.**. The reasoning stops and the model begins answering in
       the same assistant turn — no restart, no second prompt."
  - KEEP it (all still true). APPEND one short sentence stating the reasoning is preserved in the saved turn.
    RECOMMENDED:
      "While the model is reasoning, press **Ctrl+.**. The reasoning stops and the model begins answering in
       the same assistant turn — no restart, no second prompt. The reasoning that streamed before you pressed
       is kept in the message, so the saved turn reads like a normal response: reasoning, then the answer."
  - VALIDATION after edit: `grep -ni "preserv\|kept in the message\|reasoning, then" README.md` → ≥1 match.

Task 4 (OPTIONAL): MODIFY README.md — add a Features bullet for reasoning preservation (claim a)
  - FIND the Features list (first bullets, ~lines 16–19). APPEND one bullet. RECOMMENDED:
      "- **Reasoning is preserved** — when you stop the reasoning, it stays in the saved assistant message,
         followed by the answer."
  - NAMING/PLACEMENT: as the last Features bullet (after the z.ai-specific bullet). One sentence.
  - SKIP if it makes the Features list feel redundant with Usage — Usage ¶1 already states it. This is polish.
  - DEPENDENCIES: Task 3 (same claim; keep wording consistent across the two mentions).

Task 5 (OPTIONAL): MODIFY CHANGELOG.md — add a factual bugfix block
  - FIND the top of CHANGELOG.md (above the `## [1.0.0]` line). INSERT a `[Unreleased]` (or `[1.0.1]`) block
    with an `### Fixed` subsection listing the three fixes factually (one line each, keyed to the milestone
    IDs). Keep-a-Changelog format; match the existing terse milestone style.
  - RECOMMENDED entries:
      "### Fixed",
      "- Reasoning is now preserved in the persisted assistant message on interruption (content assembles as
         `[thinking, text]`, matching a normal response) — P1.M2.",
      "- The shortcut is now disabled once reasoning ends (`thinking_end` or first answer token); pressing it
         during the answer no longer aborts the in-progress response — P1.M3.",
      "- Coordinator no longer loses shortcut coverage for overlapping streams (guarded active-proxy clear) — P1.M4."
  - GOTCHA: only do this if a doc-sync changelog entry is wanted. Do NOT imply a version bump. If unsure,
    SKIP — README.md is the only required deliverable.
  - VALIDATION after edit: the block is under a NEW heading that does NOT alter the existing [1.0.0] entries.
```

### Implementation Patterns & Key Details

```markdown
<!-- README.md — the verbatim current sentences + the recommended replacements (prose latitude on wording). -->

<!-- Task 1: "How it works" step 2 (line 78). CURRENT (the falsehood): -->
2. **Stream splicing** — When you press `Ctrl+.`, the wrapper aborts the reasoning stream (via an internal
   `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement
   request to the same provider. The replacement stream's events are merged into the same downstream
   `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn — the reasoning is
   gone and the answer flows in its place.

<!-- RECOMMENDED replacement (only the post–em-dash clause changes; facts fixed): -->
2. **Stream splicing** — When you press `Ctrl+.`, the wrapper aborts the reasoning stream (via an internal
   `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement
   request to the same provider. The replacement stream's events are rewritten and merged into the same
   downstream `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn. The
   reasoning captured before the interruption is preserved, and the answer text follows it — the resulting
   message is a normal `[thinking, text]` sequence, the same shape as a non-interrupted reasoning response,
   with no restart artifact.

<!-- Task 2: "Usage" ¶2 (line 40). CURRENT: -->
The shortcut is evaluated per-press: if the model is not currently reasoning, the press is silently ignored.
Only one interruption is accepted per response; additional presses during the transition are discarded.

<!-- RECOMMENDED replacement (adds the §22.4 leave-conditions): -->
The shortcut is active only while the model is actively reasoning. Reasoning ends the moment the model emits
`thinking_end` or its first answer token — after that, pressing **Ctrl+.** is silently ignored (the model is
already answering). Only one interruption is accepted per response; additional presses during the transition
are discarded.

<!-- Task 3: "Usage" ¶1 (line 34). CURRENT: -->
While the model is reasoning, press **Ctrl+.**. The reasoning stops and the model begins answering in the
same assistant turn — no restart, no second prompt.

<!-- RECOMMENDED replacement (appends the preservation fact): -->
While the model is reasoning, press **Ctrl+.**. The reasoning stops and the model begins answering in the
same assistant turn — no restart, no second prompt. The reasoning that streamed before you pressed is kept in
the message, so the saved turn reads like a normal response: reasoning, then the answer.
```

### Integration Points

```yaml
DOCUMENTATION:
  - modify file: README.md (Usage ¶1, Usage ¶2, How it works #2; optional Features bullet)
  - optional modify file: CHANGELOG.md (one [Unreleased]/[1.0.1] ### Fixed block)
  - NOT modified: PRD.md, any tasks.json, any prd_snapshot.md, any .ts/.json file, tsconfig.json.

SOURCE/TESTS: NONE. The fixes are already shipped and tested. This task touches NO code and NO tests.
  `git diff --stat -- src/` and `git diff --stat -- tests/` must both be EMPTY after the task.

BUILD/CONFIG: NONE. No package.json/tsconfig.json changes. No markdown linter to satisfy.
```

---

## Validation Loop

### Level 1: Prose concordance (the docs gate — run after editing README.md)

```bash
# (a) The headline falsehood is GONE (0 matches required):
grep -n "reasoning is gone\|flows in its place" README.md
# Expected: NO output. If anything matches, Task 1 is incomplete.

# (b) Claim (a) — reasoning preservation — is PRESENT (≥1 match each):
grep -ni "preserv" README.md            # "preserved" / "preserve"
grep -ni "thinking.*text\|\[thinking" README.md   # the [thinking, text] sequence

# (c) Claim (b) — shortcut scope / leave-conditions — is PRESENT:
grep -ni "active only\|thinking_end\|first answer token\|disabled" README.md

# Expected: (a) empty; (b) and (c) each have ≥1 match. If (b)/(c) missing, finish Tasks 1–3.
```

### Level 2: Build & test sanity (proof no code was touched)

```bash
# README is not compiled, so this is a "did I accidentally edit src?" guard, not a docs gate.
npm run build
# Expected: clean (0 diagnostics). If tsc errors, you accidentally edited a .ts file — revert it.

npm test
# Expected: 0 fail (~390 tests; baseline is whatever P1.M1–M4 left it at). A README edit cannot change this;
#   a failure means a source file was touched. `git diff --stat -- src/ tests/` must be EMPTY.

# Confirm scope: ONLY README.md changed (+ optional CHANGELOG.md); no source/test/config changes.
git diff --stat -- src/ tests/ package.json tsconfig.json PRD.md
# Expected: EMPTY.  (README.md — and optionally CHANGELOG.md — are the only diffs.)
git status --short
# Expected: M README.md  [and optionally M CHANGELOG.md]  — nothing else.
```

### Level 3: Test-backed claim verification (the README ↔ green-tests concordance)

```bash
# Claim (a) — "[thinking, text] preserved" — is TRUE because this test asserts exactly that and passes:
grep -n 'content.map((b) => b.type)).toEqual(\["thinking", "text"\])' tests/consumer-integration.test.ts
# Expected: ≥2 matches (the interrupted case ~l.86 AND the uninterrupted negative-control ~l.133).
npm test tests/consumer-integration.test.ts
# Expected: PASS. If green, README claim (a) is backed by a passing test.

# Claim (b) — "shortcut disabled after thinking_end / first answer token" — is TRUE because these pass:
grep -n "EC-005\|EC-006\|canInterrupt()).toBe(false)\|triggerStop()).toBe(false)" tests/stream-proxy-reasoning-ended.test.ts
# Expected: EC-005 (l.63) + EC-006 (l.104) describe blocks + the toBe(false) assertions (l.93–96, 133–136).
npm test tests/stream-proxy-reasoning-ended.test.ts
# Expected: PASS. If green, README claim (b) is backed by a passing test.

# Expected: both targeted suites pass → every factual README claim is verified against green behavior.
```

### Level 4: Proofread & cross-reference (creative / domain validation)

```bash
# Read the edited README end-to-end and confirm internal consistency:
sed -n '30,80p' README.md | less   # (or `read README.md` — review Usage + How it works in context)

# Checks a human proofreader applies:
#  - No sentence now contradicts another (e.g. Usage ¶1 "preserved" must agree with How it works #2 "preserved").
#  - The ASCII flow diagram (Usage) still reads correctly: reasoning ──► [Ctrl+. during reasoning] ──► answer.
#  - "One interruption per response" (Limitations) still holds and isn't contradicted by the scope edit.
#  - No invented features: Fix #3 (overlap guard) is NOT mentioned anywhere (correct — internal invariant).
#  - Voice matches: terse, developer-facing, one-sentence bullets; no marketing fluff added.
# Optional: if Task 5 was done, confirm the CHANGELOG block is under a NEW heading and the [1.0.0] block is intact:
grep -n "## \[" CHANGELOG.md
# Expected: the new [Unreleased]/[1.0.1] heading ABOVE [1.0.0]; the [1.0.0] block unchanged.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] Level 1 concordance: `grep "reasoning is gone\|flows in its place" README.md` → empty; preservation +
      scope phrases present.
- [ ] `npm run build` clean (proof no `.ts` file was touched).
- [ ] `npm test` green / 0 fail (proof no test/behavior was touched).
- [ ] `git diff --stat -- src/ tests/ package.json tsconfig.json PRD.md` → **EMPTY** (only README.md, and
      optionally CHANGELOG.md, changed).

### Feature (Documentation) Validation
- [ ] README "How it works" #2: reasoning is **preserved**, answer **follows** it, message = `[thinking, text]`,
      no restart artifact (the l.78 falsehood removed).
- [ ] README "Usage" ¶1: states reasoning-preservation fact (claim a).
- [ ] README "Usage" ¶2: states shortcut-scope fact (claim b) — active only during active reasoning; disabled
      on `thinking_end` or first answer token.
- [ ] Both claims are **backed by a passing test** (Level 3: consumer-integration + reasoning-ended suites green).
- [ ] Fix #3 (coordinator overlap guard) is **deliberately not documented** (internal invariant; no invented feature).
- [ ] No contradiction between Usage, How it works, Features, and Limitations after editing.

### Code Quality / Docs-Hygiene Validation
- [ ] README voice preserved (terse, developer-facing, one-sentence bullets; existing section structure intact).
- [ ] ASCII flow diagram and "How it works" numbered list structure untouched.
- [ ] No new top-level section added unless the optional Features bullet was used (still no new section).
- [ ] (If Task 5 done) CHANGELOG block is factual, under a new heading, [1.0.0] entries intact; no version-bump
      implication beyond what's intended.

---

## Anti-Patterns to Avoid

- ❌ Don't leave "the reasoning is gone and the answer flows in its place" anywhere — it is the one sentence
  that now contradicts the shipped code. This is the whole reason the task exists.
- ❌ Don't document Fix #3 (the coordinator overlap guard) in the README — it is an internal correctness fix
  with no previously-wrong user-facing claim; describing it invents a feature the user never interacts with.
- ❌ Don't drop or weaken "if the model is not currently reasoning, the press is silently ignored" (line 40) —
  it is now TRUE; sharpen it (name `thinking_end` / first answer token), don't soften it.
- ❌ Don't state only one of the two §22.4 leave-triggers the code gates on — mention BOTH `thinking_end` AND
  the first answer token, or the scope is understated.
- ❌ Don't invent features, future plans, or configuration knobs — only document what the three fixes guarantee.
- ❌ Don't edit any `.ts` file, `package.json`, `tsconfig.json`, `PRD.md`, `tasks.json`, or `prd_snapshot.md`.
- ❌ Don't add a CHANGELOG version bump the release process doesn't intend — Task 5 is optional and factual only.
- ❌ Don't add a new README top-level section for a "Behavior" block when Usage + How it works already cover it —
  edit those sections in place (the contract's "add a concise Behavior section" applies only if NO relevant
  section exists; here two do).

---

## Confidence Score: **9/10**

The task is a small, surgical prose edit with no code risk. The single falsehood (README l.78) is identified
verbatim, the two factual claims (a) reasoning preservation and (b) shortcut scope are pinned with MUST/FORBIDDEN
lists, the canonical wording is quoted from the PRD h2.1 expected-behavior block + PRD §22.4/§22.5, and every
claim is verifiable against a named, currently-passing test (`consumer-integration.test.ts` for claim a;
`stream-proxy-reasoning-ended.test.ts` for claim b). Validation is a deterministic concordance grep
(falsehood absent + claims present) plus a build/test sanity check that proves no source was touched. The only
residual risk is prose judgment (matching the terse voice, avoiding over-claiming) — mitigated by the
recommended-wording blocks and the anti-patterns list. Fix #3 is explicitly scoped OUT (no invented features),
removing the temptation to "balance" the three fixes with three doc edits.
