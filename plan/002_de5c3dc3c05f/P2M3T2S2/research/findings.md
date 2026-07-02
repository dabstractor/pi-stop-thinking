# Research Findings — P2.M3.T2.S2: Add CHANGELOG.md entry for reasoning reuse directive

> Documentation-only task. This file records the verified facts used to author `PRP.md`.

## 1. Current CHANGELOG.md state (verified)

File: `CHANGELOG.md` (repo root — **NOT** in `package.json` `files` array, which only ships
`dist` + `README.md`; CHANGELOG is repo-only, still tracked).

Structure (line numbers confirmed via `grep -n`):

```
1: # Changelog
3: All notable changes to this project are documented here.
4: Format based on [Keep a Changelog](https://keepachangelog.com/).
5: (blank)
6: ## [Unreleased]
7: (blank)
8: ### Fixed
9-11: three Fixed bullets (each tagged — P1.M2 / — P1.M3 / — P1.M4)
13: ## [1.0.0]
15: ### Added
16-...: eight Added bullets (P1.M1–P1.M8, **bold** milestone lead-ins)
```

**Key observation:** `[Unreleased]` currently has **NO `### Added` section** — only `### Fixed`.
The item contract says add under `[Unreleased] → Added` "or a new section header if appropriate"
→ we must **insert a new `### Added` header** between `## [Unreleased]` and `### Fixed`.

## 2. Keep a Changelog ordering rule (normative)

Per https://keepachangelog.com/en/1.1.0/#how , the canonical order of change-type subsections is:

**Added, Changed, Deprecated, Removed, Fixed, Security.**

Therefore `### Added` MUST be placed **above** `### Fixed` under `[Unreleased]`. Placing it
below Fixed would violate the format the file itself declares (`Format based on [Keep a Changelog]`).

## 3. Existing entry conventions (to match style)

- Fixed bullets: `- <Sentence>. — P1.M2.` (milestone tag appended after an em-dash).
- Added bullets in [1.0.0]: `- **<Name> (P1.Mx)** — prose.` (bold milestone lead-in).
- Backticks for code identifiers (e.g. `[thinking, text]`, `thinking_end`).
- One bullet per logical change; concise, defers detail to PRD/sections.

→ For the new `[Unreleased] → Added` bullet: follow the **Fixed-section style** (it is the same
release section family — `[Unreleased]`) → plain `- <Sentence>.` with a trailing `— P2` milestone
tag for consistency with the P1.Mx tags already in `[Unreleased]`. (The item contract gives the
exact prose; the milestone tag is the only addition for convention alignment.)

## 4. Exact contract text (verbatim from item description)

> Reasoning reuse via ephemeral text injection (ADR-006 / §53): when you stop thinking, the
> captured reasoning is injected as ephemeral, delimited reference context into the
> thinking-disabled replacement request so the model conditions its answer on its own prior
> reasoning. Quality is proportional to how much material reasoning was captured before the
> shortcut. Configurable via `reasoningInjection` (default: on) and `reasoningInjectionDelimiter`.

## 5. Verified config facts (against `src/config/index.ts`)

- `reasoningInjection: true` (DEFAULT_CONFIG line 76) → "default: on" ✓ accurate.
- `reasoningInjectionDelimiter: { open: "---\n[...]", close: "[End...]\n---" }` (lines 77–80) ✓ exists.
- Contract wording is accurate; no correction needed.

## 6. Sibling task boundary (P2.M3.T2.S1 owns README.md)

P2.M3.T2.S1 modifies **README.md only**. This task modifies **CHANGELOG.md only**. No overlap.
The "Files Changed" matrix in `architecture/system_context.md` §6 lists BOTH as separate Modified
rows — confirming they are distinct, non-overlapping doc-sync edits.

## 7. Validation approach

- No code/test build is relevant (markdown-only; CHANGELOG not type-checked, not in `files`).
- Validation = structural grep (section header present, correct ordering) + git-status (only one
  file changed) + markdown well-formedness.
- Build/typecheck/test gates are no-ops for THIS file but should still pass to prove no accidental
  side-effects (the implementer touches ONLY CHANGELOG.md).
