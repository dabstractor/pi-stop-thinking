# PRP — P2.M3.T2.S2: Add CHANGELOG.md entry for reasoning reuse directive

---

## Goal

**Feature Goal**: Record the **reasoning-reuse** capability (ADR-006 / §53 Ephemeral Execution
Directive — INPUT injection of the captured reasoning into the thinking-disabled replacement
request) in `CHANGELOG.md` under the `[Unreleased]` release, in the project's established
**Keep a Changelog** format and house style. This is the final, **changeset-level documentation
sync** for the Phase-2 reasoning-reuse deliverable (contract §6 "[Mode B] … runs last" — depends
on every implementing subtask being complete; all of P2.M1/P2.M2 and P2.M3.T1 are Complete).

**Deliverable**: ONE modified file — `CHANGELOG.md` (repo root). Insert a **new `### Added`
subsection** under `## [Unreleased]` (which currently has only `### Fixed`), placed **above**
`### Fixed` per Keep a Changelog ordering, containing exactly one bullet that documents the
reasoning-reuse feature in concise prose referencing ADR-006 / §53 and the two new config fields.
**No source, no tests, no README** touched (README is sibling task P2.M3.T2.S1).

**Success Definition**:
- `CHANGELOG.md` contains a new `### Added` header directly under `## [Unreleased]`, appearing
  **before** the existing `### Fixed` header.
- That section contains one bullet whose prose matches the contract wording (§4 below) and names
  ADR-006 / §53, `reasoningInjection` (default: on), and `reasoningInjectionDelimiter`.
- The prose is **accurate** vs. the shipped config (`src/config/index.ts`: `reasoningInjection: true`,
  `reasoningInjectionDelimiter: { open, close }`).
- The entry follows the existing `[Unreleased]` house style (trailing `— P2` milestone tag, matching
  the `— P1.Mx` tags on the Fixed bullets).
- Markdown remains well-formed (matched fences, balanced sections).
- Only `CHANGELOG.md` is changed (`git status --porcelain` shows exactly one file).

## User Persona (if applicable)

**Target User**: Maintainers / release-readers of the `pi-stop-thinking` extension who track
notable changes between releases (CHANGELOG is the canonical release log). Also downstream users
scanning `[Unreleased]` to see what's shipping in the next version.
**Use Case**: "What's new in the next release since 1.0.0?" → reader scans `[Unreleased] → Added`.
**User Journey**: Open CHANGELOG → read `[Unreleased]` → `Added` subsection surfaces the
reasoning-reuse capability and its config knobs in one bullet.
**Pain Points Addressed**: Without this entry, the headline Phase-2 capability (reasoning is
**reused**, not discarded — ADR-006) is invisible in the release log, so a reader of the changelog
would wrongly infer the captured reasoning is still thrown away on interruption.

## Why

- **Business value**: Reasoning reuse is the Phase-2 flagship (ADR-006 / §53 / INV-013). The
  CHANGELOG is the durable record of "what changed"; omitting it leaves the delta undocumented at
  the release-log layer even though the feature is shipped and tested.
- **Integration** (P2.M3 doc-sync chain position — runs LAST per contract §6 "[Mode B]"):
  - **Consumes P2.M1.T1** (Complete): `reasoningInjection` + `reasoningInjectionDelimiter` in
    Config / DEFAULT_CONFIG / validateConfig / loadConfigFromEnv.
  - **Consumes P2.M2.T1–T3** (Complete): `renderReasoningText` + directive injection in
    `RequestBuilder.buildReplacement`; config threaded through StreamProxy / ProviderDecorator.
  - **Consumes P2.M3.T1** (Complete): directive + invariant test coverage (INV-013, INV-014).
  - **Sibling P2.M3.T2.S1** (in flight): owns `README.md` — **do NOT touch README**. No overlap.
- **Problems solved**: Closes the release-log gap created by the ADR-006 delta; surfaces the two
  new config knobs at the changelog layer; keeps the changelog the single source of truth for
  "what changed since 1.0.0".

## What

User-visible behavior: none (documentation). The documented contract (already shipped & verified):

1. **NEW SUBSECTION** — insert a new `### Added` header directly under `## [Unreleased]`, BEFORE
   the existing `### Fixed` header (Keep a Changelog orders: Added → Changed → Deprecated →
   Removed → Fixed → Security — so Added must precede Fixed).
2. **ONE BULLET** under that header — concise prose (contract §4 below verbatim), referencing
   ADR-006 / §53 and the two config fields, with a trailing `— P2` milestone tag for house-style
   consistency with the `— P1.Mx` tags on the existing Fixed bullets.
3. **PRESERVE** the existing `### Fixed` bullets (P1.M2 / P1.M3 / P1.M4) and the entire
   `## [1.0.0]` section verbatim. Do not reorder, reword, or remove anything that already exists.
4. **DO NOT TOUCH** any other file (README = sibling task; no source/tests).

### Success Criteria

- [ ] A new `### Added` header exists under `## [Unreleased]` and appears BEFORE `### Fixed`.
- [ ] The `### Added` section has exactly one bullet documenting reasoning reuse (ADR-006 / §53).
- [ ] The bullet names `reasoningInjection` (default: on) and `reasoningInjectionDelimiter`.
- [ ] Bullet prose matches the contract wording in §4 below (concise; defers detail to PRD).
- [ ] All pre-existing content (the 3 Fixed bullets, the entire `[1.0.0]` section) is unchanged.
- [ ] Markdown is well-formed (matched code fences; balanced section headers).
- [ ] Only `CHANGELOG.md` changed (`git status --porcelain` → exactly one file).

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes.** This PRP names the single file, quotes the exact current anchor text
verbatim (the `## [Unreleased]` header line, the `### Fixed` header line, and the first Fixed
bullet — enough to locate the unique insertion point), gives the exact replacement markdown for the
insert, pins the verified default values (copied from `src/config/index.ts`), cites the Keep a
Changelog ordering rule with a URL, and provides grep-based validation with exact expected counts.
No codebase knowledge required beyond Markdown editing.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: CHANGELOG.md
  why: THE ONLY file to modify. Contains `## [Unreleased]` (line 6) → `### Fixed` (line 8) → 3
        Fixed bullets → `## [1.0.0]` (line 13). The new `### Added` + bullet is INSERTED between
        the `## [Unreleased]` header and the `### Fixed` header.
  pattern: Keep a Changelog; version sections `## [<version>]`; change-type subsections `### Added`
        / `### Fixed`; bullets `- <Sentence>.` with milestone tags `— P1.Mx`; code identifiers in
        backticks.
  gotcha: `[Unreleased]` currently has NO `### Added` subsection — you are ADDING one, not editing
        an existing one. Per Keep a Changelog, `### Added` MUST sit ABOVE `### Fixed` (order:
        Added, Changed, Deprecated, Removed, Fixed, Security).

- url: https://keepachangelog.com/en/1.1.0/#how
  why: The file's declared format. Defines the canonical subsection ordering (Added before Fixed)
        and that "[Unreleased]" gathers pending changes.
  critical: Inserting `### Added` BELOW `### Fixed` would violate the declared format. This is the
        single most likely reviewer-rejection cause — get the ordering right.

- file: src/config/index.ts
  why: READ-ONLY source of truth for the documented defaults. Confirms `reasoningInjection: true`
        (DEFAULT_CONFIG, "default: on") and `reasoningInjectionDelimiter: { open, close }` exist
        exactly as the contract text claims — so the prose needs NO correction.
  section: DEFAULT_CONFIG (frozen object, lines ~67-81).

- docfile: plan/002_de5c3dc3c05f/architecture/system_context.md
  why: §6 "Files Changed" confirms this task's scope = a single CHANGELOG.md Modified row
        (separate from README.md). §2/§3 give the input-injection-vs-output-stitching framing that
        the bullet summarizes ("injected as ephemeral, delimited reference context").
  section: §6 (files-changed matrix), §2 (the delta), §3 (the gap, now closed).

- prd: ADR-006 (h1.12), §53 Replacement Request Spec / Ephemeral Execution Directive
       (h1.73 / h2.176), §47 Configuration (h1.67), §48 Acceptance Criteria (h1.68 — the
       "Captured reasoning is reused" bullet), §60 Production Readiness Checklist (h1.80).
       These define the exact wording norms to paraphrase concisely ("ephemeral reference context",
       "best-effort, proportional to capture", "thinking-disabled replacement request").
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
CHANGELOG.md          # <-- MODIFY: insert `### Added` + one bullet under `## [Unreleased]` (before `### Fixed`).
package.json          # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit; NOTE: `files` ships only dist + README (CHANGELOG is repo-only, not packaged).
README.md             # NOT THIS TASK (sibling P2.M3.T2.S1 owns it).
src/config/index.ts   # READ-ONLY — verifies `reasoningInjection` (true) + `reasoningInjectionDelimiter` defaults.
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. ONE MODIFIED file:
CHANGELOG.md   # +1 subsection header (`### Added`) +1 bullet under `## [Unreleased]`, documenting
               #   reasoning reuse (ADR-006 / §53) + the two new config fields. All existing
               #   content (Fixed bullets, [1.0.0] section) unchanged.
```

### Known Gotchas of our codebase & Library Quirks

```markdown
<!-- CRITICAL (Keep a Changelog ordering): `### Added` MUST be placed ABOVE `### Fixed` under
     `## [Unreleased]`. Canonical order: Added, Changed, Deprecated, Removed, Fixed, Security.
     The file declares `Format based on [Keep a Changelog]`, so this ordering is normative.
     Placing Added below Fixed is the most likely review rejection. -->

<!-- CRITICAL (new subsection, not an edit): `[Unreleased]` currently has ONLY `### Fixed`. You are
     ADDING the `### Added` header (it does not exist yet), immediately below `## [Unreleased]`
     and above `### Fixed`. Do not try to "find" an existing Added block under [Unreleased]. -->

<!-- CRITICAL (single-file scope): touch ONLY CHANGELOG.md. README.md is the sibling task
     (P2.M3.T2.S1). `git status --porcelain` after your edit must list exactly CHANGELOG.md. -->

<!-- CONVENTION (milestone tag): existing [Unreleased] Fixed bullets end with `— P1.M2` / `— P1.M3`
     / `— P1.M4`. Append `— P2` to the new Added bullet to match this house style. -->

<!-- ACCURACY: the contract prose says `reasoningInjection` "default: on" — verified TRUE in
     src/config/index.ts DEFAULT_CONFIG (`reasoningInjection: true`). `reasoningInjectionDelimiter`
     also exists (the §53 fence). No wording correction is needed; use the prose verbatim. -->
```

## Implementation Blueprint

### Data models and structure

_N/A — documentation only. No data models, schemas, or code artifacts._

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: EDIT CHANGELOG.md — insert `### Added` subsection + one bullet under `## [Unreleased]`
  - LOCATE the unique anchor (verbatim, lines 6-9 of current file):

        ## [Unreleased]

        ### Fixed

        - Reasoning is now preserved in the persisted assistant message on interruption ...
  - INSERT (between the `## [Unreleased]` header and the `### Fixed` header) the new `### Added`
    header + one bullet, yielding this exact block:

        ## [Unreleased]

        ### Added

        - Reasoning reuse via ephemeral text injection (ADR-006 / §53): when you stop thinking, the captured reasoning is injected as ephemeral, delimited reference context into the thinking-disabled replacement request so the model conditions its answer on its own prior reasoning. Quality is proportional to how much material reasoning was captured before the shortcut. Configurable via `reasoningInjection` (default: on) and `reasoningInjectionDelimiter`. — P2

        ### Fixed

        - Reasoning is now preserved in the persisted assistant message on interruption ...

  - FOLLOW pattern: the existing `### Fixed` bullets in `[Unreleased]` (plain `- <Sentence>.` with a
    trailing `— P1.Mx` milestone tag) — the new bullet mirrors that style with a `— P2` tag.
  - NAMING: header is exactly `### Added`; bullet lead-in is the feature name; code identifiers in
    backticks (`reasoningInjection`, `reasoningInjectionDelimiter`).
  - PLACEMENT: new header is the FIRST subsection under `## [Unreleased]` (above `### Fixed`).
  - PRESERVE: the 3 existing Fixed bullets and the ENTIRE `## [1.0.0]` section — verbatim, no edits.
  - SCOPE: modify ONLY CHANGELOG.md (README.md is sibling P2.M3.T2.S1).

Task 2: VERIFY the edit (no further file changes)
  - Confirm `### Added` appears exactly once under `[Unreleased]` and precedes `### Fixed`.
  - Confirm prose matches contract §4 and config defaults (§Accuracy gotcha).
  - Confirm `git status --porcelain` lists ONLY `CHANGELOG.md`.
```

### Implementation Patterns & Key Details

```markdown
<!-- The entire change is one markdown insertion. The anchor text to match is unique in the file
     (the `## [Unreleased]` / `### Fixed` / first-Fixed-bullet sequence). Use an exact-text edit
     (edit tool) that replaces:

        ## [Unreleased]\n\n### Fixed\n\n- Reasoning is now preserved in the persisted assistant message on interruption

     ...with the same text but with the `### Added` + bullet block spliced between
     `## [Unreleased]` and `### Fixed`. Keep the first Fixed bullet intact at the tail of the
     replacement so nothing else shifts. -->

<!-- Prose must remain ONE logical sentence/bullet (do not split into multiple bullets — the
     feature is one cohesive change). It is deliberately concise and defers detail to ADR-006 /
     §53, per the item contract ("Keep it concise — reference the PRD sections for detail"). -->
```

### Integration Points

```yaml
DOCUMENTATION:
  - file: "CHANGELOG.md (repo root)"
  - pattern: "## [<version>] release sections; ### Added/### Fixed subsections; `- <prose>. — <milestone>` bullets"
  - ordering: "Added MUST precede Fixed under each release section (Keep a Changelog)"

CONFIG (referenced, NOT modified here):
  - documented-in-changelog: "reasoningInjection (default: on), reasoningInjectionDelimiter"
  - source-of-truth: "src/config/index.ts DEFAULT_CONFIG (added by P2.M1.T1, complete)"

N/A:
  - DATABASE: none
  - ROUTES: none
  - source code: none (documentation only)
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Markdown is the only "syntax" here. Verify well-formedness of the edited file.
# (No ruff/mypy — this is a TS repo; CHANGELOG is not type-checked. These checks prove you did NOT
#  accidentally touch any source file.)

# 1. Confirm exactly one file changed and it is CHANGELOG.md.
git status --porcelain
# Expected: exactly one line: " M CHANGELOG.md"

# 2. Confirm the new subsection + ordering (Added appears, before Fixed, under [Unreleased]).
grep -n "## \[Unreleased\]\|### Added\|### Fixed\|## \[1.0.0\]" CHANGELOG.md
# Expected line order: [Unreleased] -> ### Added -> ### Fixed -> [1.0.0] -> (1.0.0's ### Added)

# 3. Confirm the bullet content is present and accurate.
grep -n "Reasoning reuse via ephemeral text injection" CHANGELOG.md
# Expected: one match under the new ### Added.
grep -n "reasoningInjection\|reasoningInjectionDelimiter" CHANGELOG.md
# Expected: one match (the new bullet) naming both config fields.

# Expected: all greps return the expected matches; no extra spurious `### Added` under [Unreleased].
```

### Level 2: Unit Tests (Component Validation)

```bash
# N/A — documentation-only task. CHANGELOG.md is not imported by any test, not in package.json
# `files`, and not type-checked. There is nothing to unit-test. Run the suite only to PROVE the
# doc edit introduced no accidental source side-effect (it should be a no-op vs. the test suite).

bun test --silent 2>&1 | tail -5
# Expected: same pass count as before the edit (all tests pass; this file does not affect tests).
```

### Level 3: Integration Testing (System Validation)

```bash
# Confirm the build/typecheck are unaffected (proves no source file was touched by mistake).
bun run typecheck 2>&1 | tail -3
# Expected: clean (no errors) — CHANGELOG is not compiled.

bun run build 2>&1 | tail -3
# Expected: clean build; dist/ unchanged for docs (CHANGELOG is not emitted to dist).

# Markdown render sanity (optional, if a renderer is available): preview CHANGELOG.md to confirm
# the new ### Added section and its bullet render correctly and the code-spans (backticks) are
# intact. A GitHub-flavored Markdown preview is sufficient.
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Domain-specific (changelog hygiene) checks:

# A. Keep a Changelog ordering invariant under [Unreleased]: Added before Fixed.
awk '/^## \[Unreleased\]/{f=1} f&&/^### /{print NR": "$0} /^## \[1\.0\.0\]/{exit}' CHANGELOG.md
# Expected: the FIRST "### " line under [Unreleased] is "### Added", the SECOND is "### Fixed".

# B. No accidental duplication: exactly one "Reasoning reuse" bullet.
grep -c "Reasoning reuse via ephemeral text injection" CHANGELOG.md
# Expected: 1

# C. Config-field naming accuracy (matches src/config/index.ts identifiers exactly).
grep -o "reasoningInjectionDelimiter" CHANGELOG.md | sort -u
grep -o "reasoningInjection\b" CHANGELOG.md | sort -u
# Expected: both identifiers present, spelled exactly as in src/config/index.ts.

# D. (Optional) markdown linter, if configured:
# npx markdownlint-cli2 CHANGELOG.md   # only if a markdownlint config exists in the repo.
```

## Final Validation Checklist

### Technical Validation

- [ ] Level 1 passed: `git status --porcelain` shows ONLY `CHANGELOG.md`.
- [ ] Level 1 passed: `grep -n` confirms `[Unreleased] → ### Added → ### Fixed → [1.0.0]` order.
- [ ] Level 1 passed: the new bullet names ADR-006 / §53 and both config fields.
- [ ] Level 3 passed: `bun run typecheck` and `bun run build` are clean (no source touched).
- [ ] Level 2 passed: `bun test` still passes (no behavioral regression from an accidental edit).

### Feature Validation

- [ ] A new `### Added` header exists under `## [Unreleased]` and precedes `### Fixed`.
- [ ] The bullet prose matches the contract wording (§4) and is accurate vs. config defaults.
- [ ] All pre-existing content (3 Fixed bullets; entire `[1.0.0]` section) is unchanged.
- [ ] Keep a Changelog ordering invariant holds (Added before Fixed).
- [ ] Markdown is well-formed (matched code fences; balanced headers).

### Code Quality Validation

- [ ] Follows existing house style (bullet format, backticks for identifiers, milestone tag `— P2`).
- [ ] Bullet is concise and defers detail to ADR-006 / §53 (per the item contract).
- [ ] File placement is correct (CHANGELOG.md at repo root — the only changelog file).
- [ ] No duplication; no rewording of existing entries.

### Documentation & Deployment

- [ ] CHANGELOG accurately reflects the shipped Phase-2 capability (reasoning reused, not discarded).
- [ ] The two new config knobs are surfaced at the changelog layer.
- [ ] No environment variables or new config introduced by THIS task (it only documents existing ones).

---

## Anti-Patterns to Avoid

- ❌ Don't place `### Added` below `### Fixed` — Keep a Changelog ordering is normative (Added first).
- ❌ Don't create a second `[Unreleased]` block or a new version header — append to the EXISTING `[Unreleased]`.
- ❌ Don't edit the `[1.0.0]` section or the existing `### Fixed` bullets — they are frozen history.
- ❌ Don't touch `README.md` (sibling task P2.M3.T2.S1 owns it) or any source/test file.
- ❌ Don't split the feature into multiple bullets — it is one cohesive change; keep one bullet.
- ❌ Don't invent config defaults — the contract says "default: on" and `src/config/index.ts` confirms `true`.
- ❌ Don't expand the bullet into full ADR-006 prose — the contract says "Keep it concise — reference the PRD sections for detail."
