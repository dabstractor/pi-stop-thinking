# PRP — P2.M3.T2.S1: Update README.md for reasoning reuse + new config fields

---

## Goal

**Feature Goal**: Sync `README.md` (the user-facing docs, shipped in `package.json`'s `files`
array) with the **reasoning-reuse** capability shipped by the now-complete implementing subtasks
(P2.M1.T1, P2.M2.T1–T3). The README currently documents only **OUTPUT stitching** (reasoning
preserved for display); it must now also document **INPUT injection** (the §53 Ephemeral Execution
Directive / ADR-006 / INV-013) and the two new config fields, with the two mechanisms **explicitly
disambiguated** so a reader understands the extension both *preserves* reasoning for display AND
*reuses* it to inform the answer.

**Deliverable**: ONE modified file — `README.md` (repo root). **No source, no tests, no
CHANGELOG** touched (CHANGELOG is sibling task P2.M3.T2.S2; contract §5 "MOCKING: N/A —
documentation only"; §6 "[Mode B] … runs last"). Four scoped edits: (1) update + add Features
bullets, (2) add 2 config-table rows, (3) add 3 env-var-table rows, (4) expand the "Stream splicing"
How-it-works paragraph with the input-injection mechanism and the two-mechanism disambiguation. All
existing still-accurate content is preserved.

**Success Definition**:
- `README.md` renders as valid GitHub-flavored Markdown (well-formed tables, matched fences).
- Config table grows **8 → 10 rows**; env-var table grows **8 → 11 rows**; every documented value
  matches `src/config/index.ts` (`DEFAULT_CONFIG` + `loadConfigFromEnv` env keys) exactly.
- A reader can state the difference between INPUT injection (reasoning reused by the model) and
  OUTPUT stitching (reasoning preserved for display) after reading the Features + How-it-works
  sections.
- No still-accurate content removed; no source/test/CHANGELOG file modified
  (`git status --porcelain` shows only `README.md`).

## User Persona (if applicable)

**Target User**: End users of the `pi-stop-thinking` Pi extension (and prospective installers
reading the npm/GitHub README). Also maintainers who use the README as the config reference.
**Use Case**: A user wants to know (a) what happens when they press `Ctrl+Q` (does the model
"forget" the reasoning?), and (b) how to tune/disable reasoning injection via env vars.
**User Journey**: Skim Features → decide it does what they want → jump to Configuration to see
available knobs → read "How it works" for the mental model.
**Pain Points Addressed**: Today the README implies the captured reasoning is only stitched into
the *display* ("it stays in the saved assistant message") with no mention that the model actually
*reuses* it as input — so a user may assume the answer is produced from scratch (lower quality).
This task makes the reuse explicit and surfaces the two new config knobs.

## Why

- **Business value**: Reasoning reuse is the headline capability of Phase 2 (ADR-006 / §53 / INV-013)
  — it is the difference between a from-scratch (weaker) replacement answer and one conditioned on
  the captured reasoning. The README is the contract users read; an outdated README undersells the
  shipped feature and omits the two new config fields entirely.
- **Integration** (P2.M3 chain position):
  - **Consumes P2.M1.T1** (Complete): `reasoningInjection` + `reasoningInjectionDelimiter` in
    `Config` / `DEFAULT_CONFIG` / `validateConfig` / `loadConfigFromEnv`.
  - **Consumes P2.M2.T1–T3** (Complete): `renderReasoningText` + directive injection in
    `RequestBuilder.buildReplacement`; config threaded through `StreamProxy`/`ProviderDecorator`.
  - **Sibling P2.M3.T1.S2** (in flight): test-only, `tests/request-builder.test.ts` — **no overlap**
    (it touches no doc). Read its PRP only to confirm the directive-message shape being documented.
  - **Sibling P2.M3.T2.S2** (Planned): owns `CHANGELOG.md` — **do NOT touch CHANGELOG**.
- **Problems solved**: Closes the doc/code drift created by the ADR-006 delta; documents the
  two-mechanism split the PRD §53 Ephemeral Execution Directive makes normative ("must not be
  conflated"); exposes the new config surface so users can disable injection if desired.

## What

User-visible behavior: none (documentation). The documented contract (already shipped & verified):

1. **FEATURES** — the existing `**Reasoning is preserved**` bullet is **relabeled to "preserved for
   display"** (OUTPUT stitching), and a NEW `**Reasoning is reused, not discarded**` bullet is added
   (INPUT injection: captured reasoning fed back as ephemeral reference context so the answer is
   informed by it; best-effort, proportional; independent of display preservation). The two are
   clearly distinguished.
2. **CONFIG TABLE** — add two rows in DEFAULT_CONFIG source order (after
   `maximumReasoningBufferBytes`, before `telemetryEnabled`): `reasoningInjection` (boolean, `true`)
   and `reasoningInjectionDelimiter` (`{ open, close }`, the §53 fence default).
3. **ENV-VAR TABLE** — add three rows in field order (after
   `PI_STOP_THINKING_MAX_REASONING_BUFFER_BYTES`, before `PI_STOP_THINKING_TELEMETRY`):
   `PI_STOP_THINKING_REASONING_INJECTION`, `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN`,
   `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE`. Include the one-line caveat that an
   unset/empty half of the delimiter falls back to its default.
4. **HOW IT WORKS → Stream splicing** — expand the existing paragraph: after describing the abort
   + thinking-disabled replacement, state the replacement request **carries the frozen reasoning
   snapshot as ephemeral input context (§53)** so the model conditions its answer on it, then list
   the **two distinct purposes** (input injection vs output stitching) and the gated fallback
   (disabled / empty → from-scratch; stitching still applies). Keep the existing `[thinking, text]`
   output-stitching text.
5. **KEEP EXISTING** — Installation, Usage, Supported models, Privacy, Limitations, Development,
   License, `--no-stop-thinking`, config-limitations subsection, etc. remain verbatim where accurate.

### Success Criteria

- [ ] README.md Features section has a clearly disambiguated "Reasoning is reused" (input injection)
      bullet AND an updated "Reasoning is preserved for display" (output stitching) bullet.
- [ ] Config table contains `reasoningInjection` and `reasoningInjectionDelimiter` with defaults
      matching `src/config/index.ts` `DEFAULT_CONFIG`.
- [ ] Env-var table contains all three `*_REASONING_INJECTION*` vars matching `loadConfigFromEnv`.
- [ ] "Stream splicing" mentions the replacement carries the injected reasoning as ephemeral INPUT
      context (§53) and explicitly distinguishes input injection from output stitching.
- [ ] Config table = 10 rows; env-var table = 11 rows (grep-verifiable).
- [ ] All previously-accurate content still present (no regressions to shortcut/transparency/
      privacy/limitations sections).
- [ ] Only `README.md` changed (`git status --porcelain` → exactly one file).

## All Needed Context

### Context Completeness Check

_If someone knew nothing about this codebase, would they have everything needed to implement this
successfully?_ **Yes.** This PRP names the single file, quotes every current anchor text verbatim
(the Features bullet, the two config-table rows bracketing the insertion, the two env-var rows
bracketing the insertion, and the full Stream-splicing paragraph), gives the exact replacement
markdown, pins the verified default values (copied from `src/config/index.ts`), and provides
grep-based validation with exact expected counts. No codebase knowledge required beyond Markdown.

### Documentation & References

```yaml
# MUST READ - Include these in your context window
- file: README.md
  why: THE ONLY file to modify. Contains the Features bullets, the config table (8 rows), the
        env-var table (8 rows), and the "How it works → Stream splicing" paragraph to expand.
  pattern: GitHub-flavored Markdown; tables are `| Field | Type | Default |` and `| Env var |
        Field | Example |`; bullets use `- **Bold lead-in** — prose.`; code spans in backticks.
  gotcha: Tables must keep consistent column counts (3 pipes per row) and the new rows must sit in
        DEFAULT_CONFIG source order (after `maximumReasoningBufferBytes` / before `telemetryEnabled`)
        so the table mirrors the schema declaration. Markdown table cells cannot contain literal
        newlines — render the delimiter default with escaped `\n` (as the source string does).

- file: src/config/index.ts
  why: READ-ONLY. The single source of truth for the documented values. `DEFAULT_CONFIG` gives the
        exact defaults for `reasoningInjection` (`true`) and `reasoningInjectionDelimiter` (the
        fence); `loadConfigFromEnv` + `ENV_PREFIX` ("PI_STOP_THINKING_") give the exact env-var
        names (`REASONING_INJECTION`, `REASONING_INJECTION_DELIMITER_OPEN`,
        `REASONING_INJECTION_DELIMITER_CLOSE`) and parsing semantics (bool / non-empty string).
  section: DEFAULT_CONFIG (frozen object), loadConfigFromEnv (env parsing), ENV_PREFIX const.
  gotcha: The delimiter default strings contain literal newlines shown as `\n` in source; reproduce
        them as `\n` (backslash-n) in the table cell so it stays one line AND matches the source.
        The env caveat "unset half → its default (not empty)" reflects loadConfigFromEnv's
        `delimOpen ?? DEFAULT_CONFIG...open` coalescing — state it accurately.

- docfile: plan/002_de5c3dc3c05f/architecture/system_context.md
  why: §6 "Files Changed" confirms the README change scope = "Features, config/env tables,
        how-it-works disambiguation" — i.e. exactly this task's four edits. §3/§4 give the
        input-injection-vs-output-stitching framing to disambiguate.
  section: §4 (architecture decisions: two uses of one snapshot), §6 (files-changed matrix).

- docfile: plan/002_de5c3dc3c05f/architecture/directive_design.md
  why: Authoritative directive contract. §2 = exact directive message + delimiter defaults (the
        values to document); §3 = ephemeral/non-mutating + identity rule; §4 = gating (injection
        ON by default; disabled/empty → same-ref fallback / from-scratch answer).
  section: §2 (delimiter defaults), §3 (ephemeral), §4 (gating).

- prd: §53 (Replacement Request — h1.73/h2.176 Ephemeral Execution Directive), §47 (Configuration
       h1.67), Appendix K (h1.117 schema + h2.211 source/limitations), §8 (h1.14 Stop Thinking
       Flow), §48 (h1.68 acceptance), ADR-006 (h1.12), §1 Executive Summary (h1.1, the "not
       discarded … injected as ephemeral" paragraph). These define the exact wording norms
       ("reference context", "best-effort, proportional", "ephemeral", "not persisted").
```

### Current Codebase tree (run `tree` in the root of the project)

```bash
README.md            # <-- MODIFY: Features bullets, config table, env-var table, Stream-splicing paragraph.
package.json         # scripts: build=tsc, test=bun test, typecheck=tsc --noEmit; README is in `files` (shipped).
tsconfig.json        # rootDir=./src, excludes tests/ — README is NOT type-checked (build only proves "no src edits").
src/config/index.ts  # READ-ONLY — source of truth for documented field names, defaults, env-var names.
CHANGELOG.md         # NOT THIS TASK (sibling P2.M3.T2.S2 owns it).
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
# No NEW files. ONE MODIFIED file:
README.md   # +1 Features bullet ("Reasoning is reused") + relabel existing bullet ("preserved for display");
            #   +2 config-table rows (reasoningInjection, reasoningInjectionDelimiter);
            #   +3 env-var-table rows (REASONING_INJECTION, _DELIMITER_OPEN, _DELIMITER_CLOSE);
            #   expanded "Stream splicing" paragraph (input injection + two-mechanism disambiguation).
```

### Known Gotchas of our codebase & Library Quirks

```markdown
<!-- CRITICAL (Markdown table cells cannot contain literal newlines): the delimiter default strings
     contain real newlines (---\n[...]). In the config table cell, render them with the escaped
     sequence `\n` (backslash-n) exactly as they appear in src/config/index.ts source, so the cell
     stays on one line and the table stays well-formed. -->

<!-- CRITICAL (source-order placement): insert the two config-table rows BETWEEN
     `maximumReasoningBufferBytes` and `telemetryEnabled`, and the three env-var rows BETWEEN
     `..._MAX_REASONING_BUFFER_BYTES` and `..._TELEMETRY`. This mirrors DEFAULT_CONFIG / loadConfigFromEnv
     declaration order and keeps the reader's mental model aligned with the schema. -->

<!-- CRITICAL (do NOT conflate the two mechanisms): INPUT injection = the model REUSES the reasoning
     (request input, ephemeral, never persisted). OUTPUT stitching = reasoning is preserved in the
     SAVED MESSAGE for display ([thinking, text]). Use the PRD's exact terms: "ephemeral reference
     context", "best-effort, proportional", "not persisted into conversation history". Both happen by
     default; disabling injection (reasoningInjection: false) removes ONLY input injection — output
     stitching still applies. -->

<!-- CRITICAL (delimiter fallback caveat): if a user sets only ONE of _DELIMITER_OPEN / _DELIMITER_CLOSE,
     the unset half falls back to ITS default (never empty); and if either value is empty/non-string,
     validateConfig falls the WHOLE delimiter object back to the default. State the first fact in the
     env-var table; do not over-claim. -->

<!-- CRITICAL (no CHANGELOG / no source / no tests): this task edits README.md ONLY. CHANGELOG.md is
     owned by P2.M3.T2.S2; src/** and tests/** are frozen for this doc task. -->

<!-- CRITICAL (no markdown linter exists): there is NO .markdownlint* / .prettierrc*. Validation is
     grep-based structural checks + value cross-check against src/config/index.ts + human review.
     Do NOT invent a `markdownlint` / `prettier` / `vale` command — they are not configured. -->
```

## Implementation Blueprint

### Data models and structure

None — documentation only. The "data" is the markdown table rows and bullet text, whose values are
copied verbatim from `src/config/index.ts` (`DEFAULT_CONFIG` + `loadConfigFromEnv`).

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: MODIFY README.md — Features section: update + add the reasoning bullets
  - FIND the Features bullet (verbatim):
        - **Reasoning is preserved** — when you stop the reasoning, it stays in the saved assistant message, followed by the answer.
  - REPLACE it with these TWO bullets (relabeled output-stitching bullet + new input-injection bullet):
        - **Reasoning is reused, not discarded** — by default, the reasoning captured before you pressed `Ctrl+Q` is fed back to the model as ephemeral, fenced reference context, so the answer is informed by it rather than produced from scratch (best-effort, proportional to how far reasoning got). This is independent of the display preservation below.
        - **Reasoning is preserved for display** — the captured reasoning stays in the saved assistant message, and the answer follows it. The saved turn reads like a normal response: reasoning, then the answer.
  - NAMING/PLACEMENT: keep the bullets in the Features list; lead with the reuse bullet (the headline
        capability) then the preservation bullet. Keep the other 4 bullets unchanged.
  - GOTCHA: keep "Ctrl+Q" in backticks; reuse the PRD's terms ("ephemeral reference context",
        "best-effort, proportional").

Task 2: MODIFY README.md — Config table: add 2 rows in source order
  - FIND the config-table rows (verbatim) and INSERT the two new rows BETWEEN them:
        | `maximumReasoningBufferBytes` | `integer` (bytes, > 0) | `8388608` (8 MiB) |
        >>> NEW ROW 1
        >>> NEW ROW 2
        | `telemetryEnabled` | `boolean` | `false` |
  - NEW ROW 1 (verbatim):
        | `reasoningInjection` | `boolean` | `true` |
  - NEW ROW 2 (verbatim — `\n` are literal escape sequences to keep the cell one line):
        | `reasoningInjectionDelimiter` | `{ open: string; close: string }` | `{ open: "---\n[Prior reasoning captured before you were asked to stop thinking]", close: "[End of prior reasoning]\n---" }` |
  - FOLLOW pattern: the existing rows use `| \`fieldName\` | \`type\` | \`default\` |` with backticked
        identifiers. Match that exactly.
  - GOTCHA: do NOT split the delimiter default across lines (breaks the table). Use `\n` escapes.

Task 3: MODIFY README.md — Env-var table: add 3 rows in source order
  - FIND the env-var-table rows (verbatim) and INSERT the three new rows BETWEEN them:
        | `PI_STOP_THINKING_MAX_REASONING_BUFFER_BYTES` | `maximumReasoningBufferBytes` | `4194304` |
        >>> NEW ROW 1
        >>> NEW ROW 2
        >>> NEW ROW 3
        | `PI_STOP_THINKING_TELEMETRY` | `telemetryEnabled` | `true` |
  - NEW ROW 1: | `PI_STOP_THINKING_REASONING_INJECTION` | `reasoningInjection` | `false` |
  - NEW ROW 2: | `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` | `reasoningInjectionDelimiter.open` | `"[Start of prior reasoning]"` |
  - NEW ROW 3: | `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE` | `reasoningInjectionDelimiter.close` | `"[End of prior reasoning]"` |
  - FOLLOW pattern: columns are `| \`ENV_VAR\` | \`field\` | \`example\` |`. Examples are realistic
        override values (the OPEN/CLOSE examples must be NON-empty strings to be valid).
  - GOTCHA: after the table, append ONE short caveat sentence to the existing "Booleans accept …"
        paragraph (or as a new line right after the env table): "For
        `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_*`, if you set only one of `_OPEN` / `_CLOSE`,
        the other half falls back to its default (an empty value is treated as unset)." This mirrors
        loadConfigFromEnv's coalescing.

Task 4: MODIFY README.md — "How it works → Stream splicing": expand the paragraph
  - FIND the paragraph (verbatim):
        2. **Stream splicing** — When you press `Ctrl+Q`, the wrapper aborts the reasoning stream (via an internal `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement request to the same provider. The replacement stream's events are rewritten and merged into the same downstream `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn. The reasoning captured before the interruption is preserved, and the answer text follows it — the resulting message is a normal `[thinking, text]` sequence, the same shape as a non-interrupted reasoning response, with no restart artifact.
  - REPLACE it with (keep the first two sentences; split the last sentence into the two-mechanism
        disambiguation):
        2. **Stream splicing** — When you press `Ctrl+Q`, the wrapper aborts the reasoning stream (via an internal `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement request to the same provider. The replacement stream's events are rewritten and merged into the same downstream `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn. The replacement request also carries the frozen reasoning snapshot as **ephemeral input context** (the §53 Ephemeral Execution Directive), so the model conditions its answer on its own prior reasoning rather than starting from scratch.

           The captured reasoning serves **two distinct purposes**, which must not be confused:

           - **Input injection (reasoning reuse)** — the snapshot is rendered to text, wrapped in a clearly-labeled delimiter fence, and appended to the replacement request's messages as a single `user` message marked *"reference context only"*. The model reads its own prior reasoning and produces an answer informed by it (best-effort, proportional to how far reasoning got). This context is ephemeral: it lives only within that one replacement request and is never persisted into conversation history as a new or modified message.
           - **Output stitching (display preservation)** — the captured reasoning is preserved in the saved assistant message, and the answer text follows it, producing a normal `[thinking, text]` sequence — the same shape as a non-interrupted reasoning response, with no restart artifact.

           If reasoning injection is disabled (`reasoningInjection: false`) or nothing was captured, the input-injection step is skipped and the answer is generated from scratch; output stitching still applies.
  - GOTCHA: preserve the `[thinking, text]` and "no restart artifact" phrasing (output stitching,
        unchanged). Use the PRD's exact normative terms for injection ("ephemeral input context",
        "reference context only", "never persisted"). Keep the numbered-list indentation so item 2
        stays under the "two mechanisms" header; the nested bullets are indented under item 2.

Task 5: PRESERVE all still-accurate content
  - Do NOT touch: Installation, Usage, the rest of Configuration (intro line, "Configuration
        limitations" subsection, `--no-stop-thinking` note), Supported models, Provider-decoration
        mechanism (item 1 of How it works), Privacy, Limitations, Development, License.
  - Verify after edits: `grep` for a handful of unchanged anchors (e.g. `Ctrl+Q`, `--no-stop-thinking`,
        `stop-thinking-extension`, `GLM-5`) to confirm nothing was accidentally removed.
```

### Implementation Patterns & Key Details

```markdown
<!-- PATTERN: a config-table row (backticked field, backticked type, backticked default). -->
| `reasoningInjection` | `boolean` | `true` |

<!-- PATTERN: an env-var-table row (backticked var, backticked field, example). -->
| `PI_STOP_THINKING_REASONING_INJECTION` | `reasoningInjection` | `false` |

<!-- PATTERN: a Features bullet (bold lead-in + em-dash + prose), matching the existing style. -->
- **Reasoning is reused, not discarded** — by default, the reasoning captured before you pressed `Ctrl+Q` ...

<!-- CRITICAL: the disambiguation is the heart of this task. State BOTH mechanisms, label which is
     INPUT vs OUTPUT, and note injection is default-on but skippable while stitching always applies.
     Source of the exact terms: PRD §53 h2.176 ("INPUT injection … distinct from OUTPUT stitching …
     must not be conflated"), §1 h1.1 ("not discarded … injected as ephemeral … best-effort, proportional"). -->
```

### Integration Points

```yaml
DATABASE: none.
CONFIG: none — READ-ONLY consumer of src/config/index.ts values for documentation. No config edit.
ROUTES/SERVICES: none — documentation only. No code, no network, no build artifact changed (the
  README is already in package.json `files`; no manifest change needed).
CHANGELOG: DO NOT TOUCH — owned by sibling P2.M3.T2.S2.
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Markdown-only edit. There is NO markdown linter configured (no .markdownlint*/.prettierrc*).
# Validate table well-formedness directly with grep (3 columns = 3 leading "|"):
awk '/^\| *Field *\| *Type *\| *Default *\|/{flag=1} flag&&/^\|/{} /^\n*$/{flag=0} flag' README.md | grep -c '^|'
# (Simpler) just count config-table and env-var-table rows:
grep -c '^| `' README.md          # sanity: total backtick-led table rows
# Expected: higher than before; the authoritative row counts are in Level 4.
```

### Level 2: Unit Tests (Component Validation)

```bash
# N/A — documentation only. There are no README unit tests. Skip.
```

### Level 3: Integration Testing (System Validation)

```bash
# Sanity: the edit touched ONLY README.md (no source/test/CHANGELOG regressions).
git status --porcelain           # Expected: exactly one line: " M README.md"
# Confirm src/ and CHANGELOG.md are untouched:
git status --porcelain src/ CHANGELOG.md tests/   # Expected: empty.

# Confirm the project still builds & the full test suite is green (README changes do not affect
# tsc or tests, but this proves no source was accidentally edited).
bun run build                    # = tsc. Expected: zero errors.
bun test                         # Expected: 0 fail (unchanged by README edits).
```

### Level 4: Creative & Domain-Specific Validation

```bash
# (a) Config table has exactly 10 rows (was 8): the 8 originals + reasoningInjection + reasoningInjectionDelimiter.
grep -E '^\| `(enabled|shortcut|supportedProviders|transitionTimeoutMs|replacementStartupTimeoutMs|maximumReasoningBufferBytes|reasoningInjection|reasoningInjectionDelimiter|telemetryEnabled|diagnosticsLevel)` \|' README.md | wc -l
# Expected: 10

# (b) Env-var table has exactly 11 rows (was 8): the 8 originals + the 3 reasoning-injection vars.
grep -E '^\| `PI_STOP_THINKING_(SHORTCUT|ENABLED|PROVIDERS|TRANSITION_TIMEOUT_MS|REPLACEMENT_TIMEOUT_MS|MAX_REASONING_BUFFER_BYTES|REASONING_INJECTION|REASONING_INJECTION_DELIMITER_OPEN|REASONING_INJECTION_DELIMITER_CLOSE|TELEMETRY|DIAGNOSTICS)` \|' README.md | wc -l
# Expected: 11

# (c) Both new config fields + their defaults are present and match src/config/index.ts.
grep -F '`reasoningInjection` | `boolean` | `true`' README.md                          # Expected: 1 match
grep -F '`reasoningInjectionDelimiter` | `{ open: string; close: string }`' README.md   # Expected: 1 match

# (d) The two-mechanism disambiguation exists in Features AND How it works.
grep -c 'Reasoning is reused' README.md           # Expected: >= 1 (Features bullet)
grep -c 'ephemeral input context' README.md       # Expected: >= 1 (How it works)
grep -c 'Output stitching' README.md              # Expected: >= 1 (How it works label)

# (e) Cross-check the documented default values EXACTLY match the source of truth.
grep -F 'true' src/config/index.ts | grep 'reasoningInjection: true'                 # source: default true
grep -F 'PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN' src/config/index.ts    # source: env name

# (f) No accidental removal of still-accurate content (anchors that must remain).
for a in 'Ctrl+Q' '--no-stop-thinking' 'stop-thinking-extension' 'GLM-5' '8388608' 'telemetryEnabled' 'pi install npm:pi-stop-thinking'; do
  grep -q "$a" README.md && echo "OK: $a" || echo "MISSING: $a"
done
# Expected: all OK.

# (g) Render sanity (optional): if `mdformat`/`markdownlint`/a previewer is available locally, run it;
# they are NOT in the project, so this is optional human review only.
```

## Final Validation Checklist

### Technical Validation

- [ ] `git status --porcelain` shows **only** `README.md` modified (no src/test/CHANGELOG).
- [ ] `bun run build` → zero errors (no source touched).
- [ ] `bun test` → 0 fail (README edits do not affect the suite).
- [ ] Level 4 greps pass: config table = 10 rows; env-var table = 11 rows; both new fields + 3 new
      env vars present; disambiguation anchors present; no still-accurate content removed.

### Feature Validation

- [ ] **Item a** — Features: a "Reasoning is reused" bullet (input injection) AND the updated
      "preserved for display" bullet (output stitching); the two are disambiguated.
- [ ] **Item b** — Config table: `reasoningInjection` (boolean, `true`) +
      `reasoningInjectionDelimiter` (`{open,close}`, §53 fence default), in source order.
- [ ] **Item c** — Env-var table: all three `PI_STOP_THINKING_REASONING_INJECTION*` vars present,
      with the "unset half → default" caveat.
- [ ] **Item d** — How it works: "Stream splicing" states the replacement carries the reasoning
      snapshot as ephemeral INPUT context (§53) and lists input-injection vs output-stitching.
- [ ] **Item e** — All still-accurate content preserved (shortcut, transparency, privacy,
      limitations, supported models, install, `--no-stop-thinking`, etc.).

### Code Quality Validation

- [ ] Markdown tables are well-formed (consistent pipe/column counts).
- [ ] New rows follow the existing `| \`field\` | \`type\` | \`default\` |` / `| \`var\` | \`field\` |
      \`example\` |` conventions.
- [ ] Documented values match `src/config/index.ts` exactly (no invented defaults/names).
- [ ] Disambiguation uses the PRD's normative terms ("ephemeral", "reference context only",
      "best-effort, proportional", "not persisted into conversation history").

### Documentation & Deployment

- [ ] README renders correctly on GitHub (tables, fences, nested bullets under "Stream splicing").
- [ ] No CHANGELOG.md edit (owned by P2.M3.T2.S2).
- [ ] No new env vars/config fields invented beyond those already in `src/config/index.ts`.

---

## Anti-Patterns to Avoid

- ❌ Do NOT edit any file other than `README.md` — CHANGELOG.md (P2.M3.T2.S2), `src/**`, `tests/**`,
  `PRD.md`, `tasks.json` are all off-limits.
- ❌ Do NOT conflate INPUT injection with OUTPUT stitching — they are two distinct mechanisms (PRD §53
  "must not be conflated"). Always label which is which; note injection is skippable but stitching
  always applies.
- ❌ Do NOT put literal newlines inside a Markdown table cell (the delimiter default) — use the
  escaped `\n` sequence as in the source, or the table breaks.
- ❌ Do NOT insert the new table rows at the bottom — place them in DEFAULT_CONFIG source order
  (after `maximumReasoningBufferBytes` / before `telemetryEnabled` for config; after
  `..._MAX_REASONING_BUFFER_BYTES` / before `..._TELEMETRY` for env vars).
- ❌ Do NOT invent values — copy every default and env-var name verbatim from `src/config/index.ts`
  (`DEFAULT_CONFIG` + `loadConfigFromEnv`/`ENV_PREFIX`).
- ❌ Do NOT remove or rewrite still-accurate content (Installation, Usage, Supported models,
  Privacy, Limitations, config-limitations subsection, `--no-stop-thinking`, provider-decoration
  mechanism). This is an additive + targeted-edit task.
- ❌ Do NOT run/require `markdownlint`, `prettier`, `vale`, or `mdformat` — none are configured; use
  the grep-based checks in Level 4 instead.
- ❌ Do NOT over-claim injection quality — it is "best-effort, proportional to capture," NOT
  guaranteed (PRD §53 h3.70, ADR-006 consequences). Do not promise "matches full-thinking."

---

**Confidence Score: 10/10** for one-pass implementation success.
Rationale: A single-file, documentation-only change with every current anchor text quoted verbatim
(the Features bullet, the two config-table bracket rows, the two env-var bracket rows, and the full
Stream-splicing paragraph), the exact replacement markdown written out in full, and every documented
default/env-var name copied from — and cross-checked against — `src/config/index.ts` (the frozen
source of truth, all implementing subtasks Complete). The validation is grep-based with exact
expected counts (config table 8→10; env table 8→11) plus a source-value cross-check and a "no other
file touched" git check, compensating for the absence of a markdown linter. The principal risks —
conflating the two mechanisms, mis-placing rows, splitting the delimiter default across lines, or
editing CHANGELOG/source — are called out explicitly in the gotchas and anti-patterns. Scope is
cleanly separated from sibling P2.M3.T2.S2 (CHANGELOG) and the in-flight P2.M3.T1.S2 (tests), so
there is no overlap. No code runs as a result of this change, so there is no runtime risk.
