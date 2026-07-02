# Research Notes — P2.M3.T2.S1: Update README.md for reasoning reuse + new config fields

> Documentation-only task. No source, no tests, no mocking (contract §5: "MOCKING: N/A —
> documentation only"). This IS the changeset-level doc-sync (contract §6: "[Mode B] … depends on
> every implementing subtask and runs last").

## 1. Deliverable & Scope

- **Single file modified: `README.md`** (at repo root; shipped in `package.json` `files` array).
- **NOT touched:** `CHANGELOG.md` (that is sibling task P2.M3.T2.S2), any `src/`, any `tests/`,
  `PRD.md`, `tasks.json`.
- The implementing subtasks (P2.M1.T1, P2.M2.T1–T3) are all **Complete**, so the behavior being
  documented is frozen and verified. The directive behavior is exactly as in
  `src/request/builder.ts` `buildReplacement`.

## 2. README.md current structure (sections relevant to this task)

1. Title + tagline
2. **Features** — 5 bullets. The relevant one (OUTPUT stitching only):
   - `**Reasoning is preserved** — when you stop the reasoning, it stays in the saved assistant message, followed by the answer.`
3. Installation
4. Usage (diagram + prose)
5. **Configuration**
   - Intro line
   - **Config table** — columns `| Field | Type | Default |`, 8 rows:
     `enabled, shortcut, supportedProviders, transitionTimeoutMs, replacementStartupTimeoutMs, maximumReasoningBufferBytes, telemetryEnabled, diagnosticsLevel`
   - "Configuring via environment variables" subsection
   - **Env-var table** — columns `| Env var | Field | Example |`, 8 rows
   - Booleans paragraph; `--no-stop-thinking` note
   - "Configuration limitations" subsection (3 bullets)
6. Supported models
7. **How it works** — 2 numbered mechanisms:
   1. Provider decoration
   2. **Stream splicing** — describes OUTPUT stitching only (`[thinking, text]` sequence).
8. Privacy, Limitations, Development, License

## 3. Exact facts to document (verified against `src/config/index.ts`)

### Config fields (DEFAULT_CONFIG declaration order)
- `reasoningInjection: boolean` — default `true`.
- `reasoningInjectionDelimiter: { open: string; close: string }` — default:
  `{ open: "---\n[Prior reasoning captured before you were asked to stop thinking]", close: "[End of prior reasoning]\n---" }`
  (the `\n` are literal newline escapes in the source string).
- Both insert in DEFAULT_CONFIG order **after `maximumReasoningBufferBytes` and before `telemetryEnabled`**.
  README tables should follow that same source order for consistency.

### Env vars (loadConfigFromEnv, prefix `PI_STOP_THINKING_`)
- `PI_STOP_THINKING_REASONING_INJECTION` → `envBool` (accepts true/1/yes/on | false/0/no/off).
- `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` → non-empty string (default fence if unset/empty).
- `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE` → non-empty string (default fence if unset/empty).
- Note: if EITHER open or close is set, the unset half falls back to its default (not empty) — both
  must be non-empty to count; `validateConfig` falls the WHOLE object back to default if either is
  empty/non-string. Worth a one-line caveat in README.

### Behavior to disambiguate (the core of this task)
Two DISTINCT uses of one captured reasoning snapshot — must not be conflated:
- **INPUT injection (reasoning reuse / §53 Ephemeral Execution Directive / ADR-006 / INV-013):**
  the frozen snapshot is rendered to text, wrapped in the configured delimiter fence, and appended
  to a FRESH copy of the replacement request's messages as a single `user` message framed "reference
  context only — do not continue or extend reasoning." The model reads its own prior reasoning and
  answers conditioned on it. Best-effort, proportional to how far reasoning got. Ephemeral: never
  persisted into conversation history as a new/modified message. Default ON; skippable via
  `reasoningInjection: false` (or empty snapshot → from-scratch answer).
- **OUTPUT stitching (display preservation):** captured reasoning is preserved in the saved assistant
  message and the answer text follows it → `[thinking, text]` sequence, same shape as a normal
  reasoning response. (Already in README; keep + relabel as the display mechanism.)

## 4. Exact current anchor texts (for precise edits)

### Features bullet to update (verbatim from README.md)
```
- **Reasoning is preserved** — when you stop the reasoning, it stays in the saved assistant message, followed by the answer.
```

### Config table last two rows (verbatim) — insert NEW rows BETWEEN these two
```
| `maximumReasoningBufferBytes` | `integer` (bytes, > 0) | `8388608` (8 MiB) |
| `telemetryEnabled` | `boolean` | `false` |
```

### Env-var table relevant rows (verbatim) — insert NEW rows BETWEEN these two
```
| `PI_STOP_THINKING_MAX_REASONING_BUFFER_BYTES` | `maximumReasoningBufferBytes` | `4194304` |
| `PI_STOP_THINKING_TELEMETRY` | `telemetryEnabled` | `true` |
```

### How it works §2 (verbatim) — the text to update
```
2. **Stream splicing** — When you press `Ctrl+Q`, the wrapper aborts the reasoning stream (via an internal `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement request to the same provider. The replacement stream's events are rewritten and merged into the same downstream `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn. The reasoning captured before the interruption is preserved, and the answer text follows it — the resulting message is a normal `[thinking, text]` sequence, the same shape as a non-interrupted reasoning response, with no restart artifact.
```

## 5. Validation tooling available

- No markdown linter (no `.markdownlint*`, no `.prettierrc*`). Validation is therefore:
  - **Grep-based structural checks** (row counts, field-name presence, table well-formedness).
  - **Cross-check** every documented value against `src/config/index.ts` (DEFAULT_CONFIG +
    loadConfigFromEnv ENV_PREFIX keys) — the source of truth.
  - `bun run build` + `bun test` must remain green (sanity: no source accidentally touched).
- `package.json` scripts: `build=tsc`, `test=bun test`, `typecheck=tsc --noEmit`. tsconfig excludes
  `tests/` and `rootDir=./src` — README is not type-checked, so typecheck/build only prove "no src
  edits," not README correctness. The authoritative README check is human + grep.

## 6. Row-count expectations (for validation)

- Config table: 8 → **10** rows (+ `reasoningInjection`, + `reasoningInjectionDelimiter`).
- Env-var table: 8 → **11** rows (+ REASONING_INJECTION, + DELIMITER_OPEN, + DELIMITER_CLOSE).
- Features bullets: 5 → **6** (update "Reasoning is preserved" + add "Reasoning reuse").
- New content uses the existing markdown conventions (GitHub-flavored tables, backtick-fenced code).
