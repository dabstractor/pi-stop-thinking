# PRP — P1.M8.T5.S1: README.md with full feature documentation

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer).
> **Subtask**: P1.M8.T5.S1 (Phase 7 Hardening, 1 pt). A **DOCUMENTATION-ONLY** work item (Mode B —
> changeset-level docs per SOW §5). It rewrites the Phase-0 skeleton `README.md` into complete
> production-grade documentation reflecting the finished extension, and creates a `CHANGELOG.md`
> with a v1.0.0 entry. **ZERO source files modified** — `README.md` is rewritten and `CHANGELOG.md`
> is created; nothing in `src/`, `package.json`, `PRD.md`, or `tasks.json` is touched.
> **INPUT**: all completed subtasks P1.M1–M7 + P1.M8.T1–T4 (consumed as contracts), the `Config`
> schema in `src/config/index.ts` (NOT PRD Appendix K — see Gotcha #1), the architecture notes in
> `plan/001_b0c6691bb424/architecture/`, and the PRD sections listed below.
> **OUTPUT**: complete `README.md` (rewrite) + new `CHANGELOG.md` (v1.0.0 entry).
> **PARALLEL CONTEXT**: runs alongside P1.M8.T4.S1 (test suite) — therefore the README MUST NOT
> hardcode any test count or file list (see Gotcha #3).

---

## Goal

**Feature Goal**: A single source of truth for users and contributors that accurately, honestly, and
completely documents what the **Stop Thinking & Do** Pi extension is, how to install it, how to use it,
how it is configured, which models it supports, how it works internally, its privacy posture, and its
limits — matching the *actually-implemented* v1.0.0 feature exactly (not the PRD's aspirational shape).

**Deliverable** (2 files; README is a **full rewrite** of the existing skeleton, CHANGELOG is **new**):
- `README.md` — **REWRITE** (replace the Phase-0 "Under Development" skeleton in full) with the nine
  sections mandated by the contract (a–i): (a) Title + one-line description; (b) Features list;
  (c) Installation; (d) Configuration; (e) Usage; (f) Supported models; (g) Architecture overview;
  (h) Privacy; (i) Limitations.
- `CHANGELOG.md` — **CREATE** with a `## [1.0.0]` entry summarizing the eight completed phases
  (P1.M1 → P1.M8) as the initial production release.

**Success Definition**: From a clean checkout, a reader who knows nothing about this project can,
using *only* the README: install the extension, trigger Stop Thinking, understand the only user-facing
config knob, see the list of supported models, and understand the privacy guarantees and the limits —
and nothing in the README contradicts the actual source. `npx bun run build` still exits 0 (README ships
in the npm tarball). A diff-check confirms every documented config field matches `src/config/index.ts`
`Config` interface / `DEFAULT_CONFIG` exactly.

---

## User Persona (if applicable)

**Target User**: Two audiences in one document.
1. **End user (Pi + z.ai user)** — wants to install the extension and press one key to stop a reasoning
   loop. Needs Installation + Usage + Supported models + Privacy above all else; config knobs second.
2. **Contributor / reviewer** — wants to understand the provider-decoration + stream-splicing
   architecture, the module boundaries, and the testing strategy so they can trust the extension or
   extend it. Needs Architecture overview + Limitations.

**Use Case**: A z.ai (GLM-4.6) user watches the model reason for too long. They read the README's
Usage section, install the package, press `Ctrl+.`, and the model transitions to answering within one
uninterrupted assistant turn.

**User Journey**: Open README → (a) one-line "what is this" → (c) copy the install snippet → (e) press
`Ctrl+.` during reasoning → (i) understand why it only works once / z.ai-only → (h) trust that nothing
is logged.

**Pain Points Addressed**: (1) the Phase-0 README still says "Under Development … not yet functional",
which is now FALSE and actively misleading; (2) there is no place a user can discover the
`--no-stop-thinking` override; (3) contributors have no plain-language architecture summary (it lives
only in dense PRD/ADR prose and code headers).

---

## Why

- **Contract obligation**: P1.M8.T5 is the "Sync Changeset-Level Documentation" task; T5.S1 is literally
  "README.md with full feature documentation". The skeleton (P1.M1.T1.S1) was a placeholder.
- **PRD §49 Future Compatibility + §60 Production Readiness ("Maintainability")**: production-readiness
  requires that the shipped feature be documented for users and maintainers.
- **Truth-in-docs**: the v1.0.0 extension is feature-complete (P1.M1–M8 all shipped or finalizing in
  parallel); the README must stop saying "Phase 0 only" and accurately describe the real capability,
  the real config surface, and the real limits (z.ai-only, one interruption, no recursion).
- **Downstream**: this is the **final** work item of the MVP. The README/CHANGELOG are the public face
  of the v1.0.0 release.

---

## What

A complete, accurate, well-structured `README.md` (Markdown) and a `CHANGELOG.md` (Keep-a-Changelog
style). The README's nine required sections (contract a–i) plus standard OSS sections (License, a
Development/contributing stub). Prose is plain English; code blocks are used for install snippets, the
config reference table, and the usage flow.

### Success Criteria

- [ ] `README.md` opens with `# Stop Thinking & Do` (the H1 title) immediately followed by the
      contract's verbatim one-line description: **"Stop Thinking & Do — interrupt reasoning loops in
      z.ai models with one keystroke."**
- [ ] `README.md` contains a **Features** list (section b) that includes at minimum these four bullets,
      worded in user terms: single keyboard shortcut (`Ctrl+.`); transparent provider decoration
      (zero observable change when inactive / for unsupported providers); zero-config defaults; and
      z.ai-specific (targets z.ai reasoning models).
- [ ] `README.md` **Installation** section (c) shows BOTH mechanisms and uses the correct package id
      `npm:pi-stop-thinking`: (1) `pi install npm:pi-stop-thinking`; (2) manual edit of
      `~/.pi/agent/settings.json` adding `"npm:pi-stop-thinking"` to the `"packages"` array, with a
      note that Pi downloads to `~/.pi/agent/npm/` and loads it on next startup.
- [ ] `README.md` **Configuration** section (d) contains a reference table listing ALL EIGHT config
      fields with their types and defaults, copied EXACTLY from `src/config/index.ts` (`Config` +
      `DEFAULT_CONFIG`): `enabled` (`true`), `shortcut` (`"ctrl+."`), `supportedProviders` (`["zai"]`),
      `transitionTimeoutMs` (`5000`), `replacementStartupTimeoutMs` (`10000`),
      `maximumReasoningBufferBytes` (`8388608` / 8 MiB), `telemetryEnabled` (`false`),
      `diagnosticsLevel` (`"error"`). The section explains the override mechanism honestly: the ONLY
      user-facing runtime override in v1.0.0 is the `--no-stop-thinking` CLI flag (which sets the
      `enabled` master switch to `false`); other fields are validated internal defaults. (See Gotcha
      #1 + #2 — do NOT copy PRD Appendix K's nested shape or its `experimental.allowRecursiveInterrupt`.)
- [ ] `README.md` **Usage** section (e) states: press **`Ctrl+.`** while the model is reasoning; the
      reasoning stops and the model begins answering within the SAME assistant turn (no restart, no new
      prompt). Optionally include the PRD §8 Stop Thinking Flow text diagram.
- [ ] `README.md` **Supported models** section (f) lists z.ai GLM reasoning models — **GLM-4.5,
      GLM-4.6, GLM-4.5-Air, GLM-4.5-Flash** — and states the activation rule in plain language:
      "Stop Thinking activates only for z.ai models that are reasoning-enabled (`model.reasoning`)."
      Add a one-line note that non-reasoning z.ai models and all other providers (OpenAI, Anthropic,
      OpenRouter, Groq, DeepSeek) are passed through unchanged (transparent delegation).
- [ ] `README.md` **Architecture overview** section (g) is a BRIEF (a few short paragraphs + optional
      bullet list or small ASCII diagram) plain-language explanation of two mechanisms: (1) **provider
      decoration** — the extension captures Pi's built-in `openai-completions` provider and registers a
      transparent wrapper under the `stop-thinking-extension` source id, delegating everything except
      eligible z.ai reasoning streams; (2) **stream splicing** — when interrupted, the wrapper aborts
      the reasoning stream, issues a thinking-disabled replacement request, and merges it into the same
      downstream stream so Pi sees one continuous assistant turn. Do NOT paste full ADRs; link is fine.
- [ ] `README.md` **Privacy** section (h) states plainly: no prompts, reasoning content, or model
      output is logged or persisted by this extension; diagnostics default to error-only and never
      include message/reasoning/output content; telemetry is opt-in (`telemetryEnabled: false` by
      default) and emits only privacy-safe aggregate metrics.
- [ ] `README.md` **Limitations** section (i) lists: z.ai reasoning models only; exactly **one**
      interruption per response (cannot interrupt a second time); **no recursive interruption**; and
      the transition is best-effort (on failure the extension falls back transparently to Pi's normal
      behavior). Reference PRD §5 Non-Goals.
- [ ] `README.md` also includes a **License** note (`MIT`, per `package.json`) and a short
      **Development** section (`bun install` / `bun run build` / `bun test`) — kept from or updated from
      the existing skeleton.
- [ ] `README.md` does NOT contain the strings `"Under Development"`, `"not yet functional"`, or
      `"Phase 0"` as current-state descriptions, and does NOT contain the old phase-by-phase checklist
      (those phases are all done).
- [ ] `README.md` does NOT hardcode any test count (e.g. "255 tests"), test-file list, or feature that
      isn't shipped yet. The testing strategy, if mentioned, is described generically
      (unit / golden-replay / property / stress / chaos) with no numbers.
- [ ] `CHANGELOG.md` exists with a top-level `# Changelog` heading and a `## [1.0.0]` entry whose body
      summarizes the eight phases (P1.M1 Foundation → P1.M8 Hardening) in a grouped bullet list, and
      references that this is the initial production release. Follow the "Keep a Changelog" format.

## All Needed Context

### Context Completeness Check

_Pass_: the implementer needs (a) the contract's nine required sections (inlined in Success Criteria
above), (b) the exact config field list (inlined + verified against `src/config/index.ts`), (c) the
model list (inlined), (d) the privacy/limits wording (inlined), and (e) the three gotchas below. No
further code reading is strictly required, but the listed files are the authoritative cross-check.

### Documentation & References

```yaml
# MUST READ — authoritative sources to cross-check every factual claim in the README
- file: src/config/index.ts
  why: The Config interface + DEFAULT_CONFIG are the SOURCE OF TRUTH for the Configuration table.
  pattern: copy field names, types, and default values verbatim; the validation rules (per-field
           fallback, no coercion) are also worth a one-line mention.
  gotcha: PRD Appendix K shows a DIFFERENT (nested) shape and an `experimental.allowRecursiveInterrupt`
          field that DO NOT EXIST in code — never copy Appendix K into the README.

- file: package.json
  why: name ("pi-stop-thinking"), license ("MIT"), "files" field (["dist","README.md"]), scripts
        (build/test), description string.
  pattern: the README install section MUST use the package id `npm:pi-stop-thinking`.

- file: src/index.ts
  why: shows the runtime config reality — loadConfig() takes NO args, so most fields are NOT user
        overridable; the ONLY override is the `pi.registerFlag("stop-thinking", {type:"boolean",default:true})`
        flag read via `pi.getFlag("stop-thinking") === false` (i.e. `--no-stop-thinking`).
  pattern: document this flag honestly as the single user-facing config knob.
  gotcha: do NOT imply users can override shortcut/timeouts via settings.json — they cannot in v1.0.0.

- file: src/shortcut/index.ts
  why: confirms the shortcut is configurable via config.shortcut (default "ctrl+.") and is gated by
        the coordinator (idempotent, first-press-wins) — supports the Usage + Limitations wording.

- file: src/provider/decorator.ts
  why: the activation gate (provider ∈ supportedProviders AND model.reasoning AND enabled AND
        not-already-interrupting) and the source id "stop-thinking-extension" — supports Architecture
        + Supported models + Limitations.

- file: src/provider/proxy.ts
  why: stream splicing / authority transfer into one downstream stream — supports Architecture wording.

- file: architecture/module_contracts.md
  why: the module dependency graph + per-module "Responsibility / Owns / Does NOT own" contracts —
        the cleanest basis for the Architecture overview section.
  pattern: condense the dep graph into the plain-language description; do not reproduce it verbatim.

- file: architecture/zai-api-research.md
  why: the authoritative list of z.ai GLM reasoning models (GLM-4.5, GLM-4.6, GLM-4.5-Air,
        GLM-4.5-Flash) and how reasoning is disabled (enable_thinking=false via options.reasoning=undefined).
        Supports the Supported models section.

- file: README.md   # the EXISTING skeleton being replaced
  why: preserves the already-correct install snippet + Development section to reuse (install path,
        ~/.pi/agent/npm/, bun commands) rather than rewriting from scratch.
  pattern: keep the good parts; delete the "Under Development"/Phase-0/phase-checklist content.

# PRD sections (already selected; cite/paraphrase, do not paste wholesale)
- url: PRD.md §8 (User Experience Specification) — the Stop Thinking Flow text diagram for Usage.
- url: PRD.md §11–§12 (Major Components / System Architecture) — basis for Architecture overview.
- url: PRD.md §19 (Provider Decoration Architecture) — basis for "transparent delegation".
- url: PRD.md §47 + Appendix K (Configuration) — cross-reference ONLY; code wins where they differ.
- url: PRD.md §5 (Non-Goals) + §48 (Acceptance Criteria) — basis for Limitations.
- url: PRD.md Appendix H (Security & Privacy Model) — basis for Privacy section.
- url: PRD.md Appendix L (Compatibility Matrix) — provider/model pass-through table for Supported models.

# External references (style/formatting conventions to follow)
- url: https://keepachangelog.com/en/1.1.0/
  why: canonical CHANGELOG.md format ("## [1.0.0]" grouping, Added/Changed/Fixed optional).
  critical: use `## [1.0.0]` heading; this is the FIRST release so a single grouped entry suffices.
- url: https://www.markdownguide.org/basic-syntax/
  why: GitHub-flavored Markdown conventions for headings, code fences, and tables.
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
# Relevant subset (the rest is dist/ node_modules/ which are gitignored)
.
├── README.md            # ← REWRITE (Phase-0 skeleton; currently says "Under Development")
├── CHANGELOG.md         # ← CREATE (does not exist)
├── package.json         # name=pi-stop-thinking, license=MIT, files=["dist","README.md"], v0.1.0
├── tsconfig.json
├── src/
│   ├── index.ts                 # factory + --no-stop-thinking flag
│   ├── config/index.ts          # Config + DEFAULT_CONFIG + validateConfig  ← config source of truth
│   ├── diagnostics/index.ts     # structured logger, default level "error"
│   ├── provider/{decorator,proxy}.ts   # decoration + splicing
│   ├── state/{controller,coordinator}.ts  # FSM + shortcut bridge
│   ├── buffer/index.ts          # reasoning capture
│   ├── shortcut/index.ts        # Ctrl+. registration
│   ├── request/builder.ts       # thinking-disabled replacement request
│   └── telemetry/index.ts       # opt-in privacy-safe metrics
├── tests/               # unit + golden + (parallel) property/stress/chaos/regression
└── plan/001_b0c6691bb424/architecture/{module_contracts,zai-api-research,system_context,external_deps}.md
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
.
├── README.md            # REWRITE — complete v1.0.0 user + contributor docs (9 contract sections + License/Dev)
└── CHANGELOG.md         # CREATE  — "## [1.0.0]" initial-release entry summarizing P1.M1–M8
# (no other files are created or modified)
```

### Known Gotchas of our codebase & Library Quirks

```text
# GOTCHA #1 (CRITICAL): Config field names — code ≠ PRD Appendix K.
#   src/config/index.ts uses FLAT fields: telemetryEnabled, diagnosticsLevel, shortcut:"ctrl+."
#   PRD Appendix K uses NESTED: telemetry:{enabled}, diagnostics:{level}, shortcut:"Ctrl+.",
#   and adds experimental.allowRecursiveInterrupt — which DOES NOT EXIST in code.
#   RULE: document the CODE (src/config/index.ts). The recursive-interrupt capability is a
#   documented LIMITATION ("no recursive interruption"), not a config field. Do not invent it.

# GOTCHA #2 (CRITICAL): Config is NOT user-overridable beyond the --no-stop-thinking flag.
#   src/index.ts calls loadConfig() with NO args → in production every field is its DEFAULT.
#   The only runtime override is the boolean CLI flag "stop-thinking" (--no-stop-thinking),
#   which sets enabled=false. Be honest about this; do not document a settings.json config
#   override that does not exist.

# GOTCHA #3 (CRITICAL): This task runs in PARALLEL with P1.M8.T4.S1 (the test suite).
#   Test counts/files are in flux (currently 255 pass; will grow). NEVER cite a test count or
#   enumerate test files in the README. Describe the testing STRATEGY generically.

# GOTCHA #4: package.json version is 0.1.0 and we do NOT bump it here (out of scope — docs only,
#   per FORBIDDEN OPERATIONS). README/CHANGELOG describe the feature as the v1.0.0 production MVP;
#   the actual package.json version is a separate release-engineering decision. Do not reference
#   a package.json version number that isn't there.

# GOTCHA #5: package.json "files" = ["dist","README.md"] — CHANGELOG.md is NOT currently shipped
#   in the tarball. Creating CHANGELOG.md in the repo is still correct (it lives at repo root for
#   GitHub/clone consumers). Adding it to "files" is a packaging decision and is OUT OF SCOPE
#   (would require editing package.json). Leave package.json untouched.

# GOTCHA #6: The shortcut default is lowercase "ctrl+." (a Pi KeyId), not "Ctrl+.". Document the
#   user-facing form as "Ctrl+." (pretty) but if you show the config value, show "ctrl+.".
```

## Implementation Blueprint

### Data models and structure

Not applicable — this is a documentation task. No data models, schemas, or code are produced.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REWRITE README.md (full document)
  - DELETE the entire current "Under Development" / Phase-0 / phase-checklist content.
  - WRITE a new top-to-bottom README with these sections IN THIS ORDER:
      1. H1 title "# Stop Thinking & Do"
      2. One-line description (contract a, verbatim):
         "Stop Thinking & Do — interrupt reasoning loops in z.ai models with one keystroke."
      3. Optional 1–2 sentence intro paragraph (what + why, in plain English).
      4. "## Features" (contract b): bullets for single keyboard shortcut (Ctrl+.),
         transparent provider decoration (no change when inactive / unsupported),
         zero-config defaults, z.ai-specific.
      5. "## Installation" (contract c): BOTH `pi install npm:pi-stop-thinking` AND the manual
         settings.json snippet with `"packages": ["npm:pi-stop-thinking"]`; note Pi downloads to
         ~/.pi/agent/npm/ and loads on next startup. (Reuse the existing skeleton's good wording.)
      6. "## Usage" (contract e): press Ctrl+. while reasoning; model answers in the same turn,
         no restart, no new prompt. Optionally include the PRD §8 Stop Thinking Flow diagram.
      7. "## Configuration" (contract d): a Markdown TABLE of all 8 fields (name | type | default |
         description) copied EXACTLY from src/config/index.ts (see Success Criteria for the exact
         values). Then a short "Overriding" paragraph stating the ONLY runtime knob is
         `--no-stop-thinking` (disables the extension); other fields are validated internal defaults.
         Reference: "Invalid config never blocks normal provider delegation (falls back to defaults)."
      8. "## Supported models" (contract f): list GLM-4.5, GLM-4.6, GLM-4.5-Air, GLM-4.5-Flash;
         state activation = z.ai + reasoning-enabled; note pass-through for everything else.
      9. "## How it works" (contract g — Architecture overview): brief plain-language explanation
         of provider decoration (capture built-in openai-completions, register transparent wrapper
         under "stop-thinking-extension", delegate except eligible z.ai reasoning streams) + stream
         splicing (abort reasoning, issue thinking-disabled replacement, merge into one downstream
         stream → single uninterrupted assistant turn). A small ASCII diagram is optional.
     10. "## Privacy" (contract h): no prompts/reasoning/output logged or persisted; diagnostics
         default error-only and carry no content; telemetry opt-in (default off), privacy-safe metrics.
     11. "## Limitations" (contract i): z.ai reasoning only; one interruption per response; no
         recursive interruption; best-effort (transparent fallback on failure).
     12. "## Development": `bun install` / `bun run build` / `bun test` (kept/updated from skeleton).
     13. "## License": MIT (from package.json).
  - FOLLOW pattern: the existing README.md install + Development wording (reuse, don't reinvent).
  - NAMING: section headings use GitHub-flavored Markdown `##`/`###`; code fences for commands/JSON.
  - PLACEMENT: repo root `README.md` (overwrites the skeleton).
  - VERIFY before finishing: every claim cross-checked against src/config/index.ts (config),
        src/index.ts (flag), src/provider/decorator.ts (gate + source id), package.json (id/license).

Task 2: CREATE CHANGELOG.md
  - WRITE `# Changelog` H1 + a one-line note "All notable changes to this project are documented here.
    Format based on [Keep a Changelog](https://keepachangelog.com/)."
  - WRITE a `## [1.0.0]` entry (this is the FIRST release) with a grouped bullet summary of the
    eight completed phases, each as one concise bullet:
      - P1.M1 (Foundation): Config + Diagnostics + transparent ProviderDecorator + factory + the
        `--no-stop-thinking` flag; observational equivalence when inactive.
      - P1.M2 (Event Proxy): transparent StreamProxy forwarding + golden-replay harness.
      - P1.M3 (Transition State Machine): validated TransitionController FSM.
      - P1.M4 (Reasoning Detection): ReasoningBuffer, reasoning detection, ShortcutManager,
        TransitionCoordinator bridge.
      - P1.M5 (Abort Coordination): internal AbortController + abort-vs-completion race handling.
      - P1.M6 (Replacement Generation): RequestBuilder (thinking-disabled replacement request).
      - P1.M7 (Stream Splicing): replacement invocation, terminal-event suppression, authority
        transfer, full transition lifecycle + cleanup.
      - P1.M8 (Hardening): opt-in privacy-safe Telemetry, all failure modes (FM-001..015),
        session-shutdown/re-registration lifecycle, property/stress/chaos/regression test suites,
        and this documentation.
  - Optional sub-grouping under `### Added` is acceptable (Keep-a-Changelog convention) but a single
    flat grouped bullet list is also fine for an initial release.
  - FOLLOW pattern: https://keepachangelog.com/en/1.1.0/ (`## [version]` heading, ISO date optional
        but may be omitted/“unreleased”-style if the release date is not yet set — use a descriptive
        entry, do not invent a date; if you include one, mark it clearly).
  - PLACEMENT: repo root `CHANGELOG.md` (new file).
  - GOTCHA: do NOT cite test counts; do NOT reference package.json version numbers beyond "1.0.0"
        for the changelog heading itself.
```

### Implementation Patterns & Key Details

```markdown
<!-- Pattern: the ONE-LINE description is a verbatim contract string — do not paraphrase. -->
# Stop Thinking & Do

> Stop Thinking & Do — interrupt reasoning loops in z.ai models with one keystroke.

<!-- Pattern: Configuration TABLE — values MUST match src/config/index.ts DEFAULT_CONFIG exactly. -->
| Field                          | Type                                                  | Default        |
| ------------------------------ | ----------------------------------------------------- | -------------- |
| `enabled`                      | boolean                                               | `true`         |
| `shortcut`                     | string (Pi KeyId)                                     | `"ctrl+."`     |
| `supportedProviders`           | string[]                                              | `["zai"]`      |
| `transitionTimeoutMs`          | number (ms, > 0)                                      | `5000`         |
| `replacementStartupTimeoutMs`  | number (ms, > 0)                                      | `10000`        |
| `maximumReasoningBufferBytes`  | integer (bytes, > 0)                                  | `8388608` (8 MiB) |
| `telemetryEnabled`             | boolean                                               | `false`        |
| `diagnosticsLevel`             | `"error"`\|`"warn"`\|`"info"`\|`"debug"`\|`"trace"`    | `"error"`      |

> Override: in v1.0.0 the only user-facing runtime knob is the `--no-stop-thinking` flag
> (sets `enabled=false`; the extension then delegates transparently). All other fields are
> validated internal defaults; an invalid value falls back to its default and never blocks
> normal provider delegation.

<!-- Pattern: Usage — plain language, optional §8 text diagram. -->
## Usage
While the model is reasoning, press **Ctrl+.**. The reasoning stops and the model begins
answering in the same assistant turn — no restart, no second prompt.

<!-- Pattern: Architecture — BRIEF; do not paste ADRs or full module contracts. -->
## How it works
The extension captures Pi's built-in `openai-completions` provider and registers a transparent
wrapper (source id `stop-thinking-extension`) ... When you press Ctrl+., the wrapper aborts the
reasoning stream, issues a thinking-disabled replacement request, and splices it into the same
downstream stream so Pi sees one uninterrupted assistant turn.
```

### Integration Points

```yaml
PACKAGE TARBALL:
  - README.md is listed in package.json "files" (["dist","README.md"]) → it SHIPS to npm users,
    so a broken README is a user-visible defect. CHANGELOG.md is NOT in "files" (repo-root only)
    → creating it is safe and correct; do NOT edit package.json to add it (out of scope).
BUILD:
  - README.md is consumed by humans only; `bun run build` (tsc) ignores it. Still, verify the build
    still passes after edits (sanity that no stray file was touched).
NO CODE INTEGRATION:
  - This task edits ONLY README.md and CHANGELOG.md. There are zero import/registration points.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Markdown well-formedness — run after writing both files.
# (If a markdown linter is available, e.g. `npx markdownlint-cli2 README.md CHANGELOG.md`; if not,
#  do a manual structure pass: every section heading present, every code fence closed.)

# Confirm only the two intended files changed (no stray edits to src/ or package.json):
git status --porcelain
# Expected: M README.md  and  ?? CHANGELOG.md  ONLY. Anything else is a violation.

# Confirm the build is untouched/unbroken (README ships in the tarball):
npx bun run build
# Expected: exit 0, tsc emits dist/ as before.
```

### Level 2: Structural & Factual Validation (Component Validation)

```bash
# (1) All nine required README sections present (contract a–i) + License + Development.
for s in "Stop Thinking & Do" "Features" "Installation" "Usage" "Configuration" \
         "Supported models" "How it works" "Privacy" "Limitations" "Development" "License"; do
  grep -q "$s" README.md || echo "MISSING SECTION: $s"
done
# Expected: no "MISSING SECTION" lines.

# (2) The verbatim one-line description is present (contract a, exact string).
grep -q "interrupt reasoning loops in z.ai models with one keystroke" README.md && echo "OK tagline" || echo "MISSING tagline"

# (3) Correct package id in install instructions.
grep -q "npm:pi-stop-thinking" README.md && echo "OK pkg id" || echo "MISSING pkg id"

# (4) All 8 config fields present with correct defaults (GOTCHA #1 — matches src/config/index.ts).
grep -q "ctrl\+\." README.md && echo "OK shortcut" || echo "CHECK shortcut"
grep -qi "GLM-4.6" README.md && echo "OK models" || echo "CHECK models"

# (5) The override flag is documented (GOTCHA #2).
grep -qi -- "--no-stop-thinking" README.md && echo "OK flag" || echo "MISSING --no-stop-thinking"

# (6) No stale "Under Development"/Phase-0/current-state-Phase content remains.
! grep -qi "Under Development" README.md && echo "OK no stale" || echo "STALE: Under Development still present"

# (7) No hardcoded test count (GOTCHA #3 — parallel test suite in flux).
! grep -Eq "[0-9]{2,} tests|255 (pass|tests)" README.md && echo "OK no test counts" || echo "REMOVE hardcoded test count"

# (8) CHANGELOG.md has the v1.0.0 entry.
grep -q "## \[1.0.0\]" CHANGELOG.md && echo "OK changelog 1.0.0" || echo "MISSING changelog 1.0.0"

# (9) Factual cross-check: every documented config field exists in the source of truth.
for f in enabled shortcut supportedProviders transitionTimeoutMs replacementStartupTimeoutMs \
         maximumReasoningBufferBytes telemetryEnabled diagnosticsLevel; do
  grep -q "$f" src/config/index.ts || echo "FIELD NOT IN SRC: $f (check README accuracy)"
done
# Expected: no "FIELD NOT IN SRC" lines.
```

### Level 3: Packaging & Render Validation (System Validation)

```bash
# Render preview (optional) — render to check links/tables if a renderer is available:
#   npx --yes markdown-to-html README.md > /tmp/readme.html && echo "renders OK"
# (Skip if unavailable; the Level 2 grep checks are the primary gate.)

# Confirm README.md is included in the published tarball (it is in package.json "files"):
npm pack --dry-run 2>&1 | grep -q "README.md" && echo "README ships in tarball" || echo "README NOT in tarball"

# Confirm CHANGELOG.md exists at repo root (NOT required in tarball — repo-root only):
test -f CHANGELOG.md && echo "CHANGELOG present" || echo "CHANGELOG missing"
```

### Level 4: Creative & Domain-Specific Validation

```bash
# "No Prior Knowledge" reader test (manual):
#   Read README.md top-to-bottom as someone who has never seen this project and verify you can:
#     - install it (Installation),  - use it (Usage),  - know the config knob (Configuration),
#     - know which models work (Supported models),  - trust the privacy story (Privacy),
#     - know the limits (Limitations).
#   If any step is unclear or contradicts the source, revise.

# Truth-in-docs cross-check (manual):
#   Open README "Configuration" side-by-side with `src/config/index.ts` → every field name, type,
#   and default must match character-for-character. Open README "How it works" side-by-side with
#   `src/provider/decorator.ts` (gate + source id "stop-thinking-extension") and
#   `src/provider/proxy.ts` (splicing) → the description must not contradict the code.

# Expected: README is both complete AND accurate; no claim disagrees with the implementation.
```

## Final Validation Checklist

### Technical Validation

- [ ] Level 1 passed: `git status` shows only `README.md` (M) + `CHANGELOG.md` (??); `npx bun run build` exits 0.
- [ ] Level 2 passed: all section/field/tagline/flag/model grep checks return OK; no stale or
      count-harding issues.
- [ ] Level 3 passed: README.md appears in `npm pack --dry-run`; CHANGELOG.md present at repo root.
- [ ] Level 4 passed: "No Prior Knowledge" reader test + truth-in-docs cross-check both clean.

### Feature Validation

- [ ] All nine contract sections (a–i) present and accurate.
- [ ] One-line description is the verbatim contract string.
- [ ] Install instructions use the correct package id `npm:pi-stop-thinking` (both mechanisms).
- [ ] Configuration table matches `src/config/index.ts` `Config`/`DEFAULT_CONFIG` exactly (8 fields).
- [ ] The `--no-stop-thinking` override is documented; settings.json config-override is NOT implied.
- [ ] Supported models lists GLM-4.5/4.6/4.5-Air/4.5-Flash + pass-through note.
- [ ] Privacy states nothing is logged/persisted; telemetry opt-in by default.
- [ ] Limitations: z.ai-only, one interruption per response, no recursive interruption, best-effort.
- [ ] CHANGELOG.md has a `## [1.0.0]` entry summarizing P1.M1–M8.

### Code Quality Validation

- [ ] README follows GitHub-flavored Markdown conventions (headings, fences, tables).
- [ ] CHANGELOG.md follows Keep-a-Changelog format.
- [ ] No content copied wholesale from PRD/ADR prose (paraphrased + linked instead).
- [ ] No invented features/fields (everything maps to shipped code or a documented limit).
- [ ] Stale "Under Development"/Phase-0 content fully removed.
- [ ] No hardcoded test counts or test-file lists.

### Documentation & Deployment

- [ ] README ships in the npm tarball (verified via `npm pack --dry-run`).
- [ ] License (MIT) stated.
- [ ] No new env vars / no code changes to document.
- [ ] `package.json`, `PRD.md`, `tasks.json`, `tsconfig.json`, and everything under `src/`/`tests/`
      are UNCHANGED (docs-only task — per FORBIDDEN OPERATIONS).

---

## Anti-Patterns to Avoid

- ❌ Don't copy PRD Appendix K's nested config shape or its `experimental.allowRecursiveInterrupt`
     field — the code (`src/config/index.ts`) is the source of truth and uses flat fields with no
     experimental field.
- ❌ Don't document a settings.json / env / partial-config override that doesn't exist — the only
     runtime knob is the `--no-stop-thinking` flag.
- ❌ Don't hardcode a test count or enumerate test files (the suite is being added in parallel).
- ❌ Don't paste whole ADRs or full module-contract blocks — paraphrase + link.
- ❌ Don't leave any "Under Development" / "Phase 0 only" / phase-checklist content — the feature is done.
- ❌ Don't invent a release date or bump `package.json` — out of scope (docs only).
- ❌ Don't edit any file other than `README.md` (rewrite) and `CHANGELOG.md` (create).
- ❌ Don't skip validation "because it's just docs" — the README ships in the npm tarball to users.
