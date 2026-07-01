# Research Note — P1.M8.T5.S1 Documentation

## CRITICAL GOTCHA #1 — Config field names differ from PRD Appendix K

The PRD **Appendix K** shows a *nested* config shape with fields the implementation does NOT use:

```yaml
# PRD Appendix K (DO NOT copy verbatim into README)
telemetry: { enabled: false }
diagnostics: { level: error }
experimental: { allowRecursiveInterrupt: false }
shortcut: "Ctrl+."
```

The **ACTUAL implemented** config is the flat `Config` interface in `src/config/index.ts`
(the single source of truth — verified by reading the file):

| Field                          | Type / Values                                   | Default          |
| ------------------------------ | ----------------------------------------------- | ---------------- |
| `enabled`                      | boolean                                         | `true`           |
| `shortcut`                     | string (lowercase Pi KeyId)                     | `"ctrl+."`       |
| `supportedProviders`           | string[]                                        | `["zai"]`        |
| `transitionTimeoutMs`          | positive finite number                          | `5000`           |
| `replacementStartupTimeoutMs`  | positive finite number                          | `10000`          |
| `maximumReasoningBufferBytes`  | positive integer                                | `8388608` (8 MiB)|
| `telemetryEnabled`             | boolean                                         | `false`          |
| `diagnosticsLevel`             | `"error"|"warn"|"info"|"debug"|"trace"`         | `"error"`        |

**Decision for README**: Document the ACTUAL `Config` interface (`src/config/index.ts` +
`DEFAULT_CONFIG`). The `experimental.allowRecursiveInterrupt` field from Appendix K does
NOT exist in code — it is a documented **Limitation** ("no recursive interruption"), not a
config field. Note the `shortcut` default is lowercase `"ctrl+."` (the KeyId), even though
Appendix K shows `"Ctrl+."`.

## CRITICAL GOTCHA #2 — Most config is NOT user-overridable in v1.0.0

The factory (`src/index.ts`) calls `loadConfig()` with **NO arguments**. In production there is
no settings.json / env / partial-config injection path. The ONLY runtime override is the CLI
flag registered in `src/index.ts`:

```ts
pi.registerFlag("stop-thinking", { type: "boolean", default: true, ... });
// gate: () => pi.getFlag("stop-thinking") === false   // → disabledProvider → delegate
```

So `--no-stop-thinking` (or any Pi boolean-flag false form) is the documented override for the
`enabled` master switch. README "Configuration" section must be HONEST: list all fields +
defaults as a reference, but state plainly that the only user-facing knob in v1.0.0 is the
`--no-stop-thinking` flag; other fields are internal defaults validated at init.

## CRITICAL GOTCHA #3 — Running in parallel with P1.M8.T4.S1 (test suite)

This docs task is parallel with the property/stress/chaos/regression test suite. Test counts are
IN FLUX (currently 255 pass, will grow to ~355+). **README must NOT hardcode any test count or
file list** — describe the testing *strategy* (unit + golden-replay + property + stress + chaos)
generically and reference `tests/` without citing numbers.

## Source of truth for each README section

| Section (contract a–i)             | Source of truth                                                 |
| ---------------------------------- | --------------------------------------------------------------- |
| (a) Title + one-liner              | Contract verbatim: "Stop Thinking & Do — interrupt reasoning loops in z.ai models with one keystroke" |
| (b) Features                       | ADR-005 (transparent decoration), `shortcut:"ctrl+"`, zero-config `DEFAULT_CONFIG`, `supportedProviders:["zai"]` |
| (c) Installation                   | `package.json` name `pi-stop-thinking`, `files:["dist","README.md"]`, pi `settings.json` `"packages":["npm:pi-stop-thinking"]` |
| (d) Configuration                  | `src/config/index.ts` (GOTCHA #1, #2 above)                     |
| (e) Usage                          | PRD §8 Stop Thinking Flow; `src/shortcut/index.ts`              |
| (f) Supported models               | `architecture/zai-api-research.md` (GLM-4.5/4.6/4.5-Air/4.5-Flash, `enable_thinking`); `decorator.ts` gate `model.reasoning` |
| (g) Architecture                   | `architecture/module_contracts.md` dep graph; PRD §11/§12/§19; `decorator.ts` (capture + sourceId `stop-thinking-extension`), `proxy.ts` (splicing) |
| (h) Privacy                        | PRD Appendix H (Security & Privacy Model); `src/telemetry/index.ts` (opt-in, privacy-safe) |
| (i) Limitations                    | PRD §5 Non-Goals + §48 acceptance ("z.ai only / one interruption per response / no recursive interruption"); GOTCHA #1 (no recursive field) |

## CHANGELOG v1.0.0 entry — scope source

Summarize the completed phases from `plan_status`:
- P1.M1 Phase 0: Config, Diagnostics, transparent ProviderDecorator, factory + `--no-stop-thinking` flag.
- P1.M2 Phase 1: StreamProxy transparent forwarding + golden-replay harness.
- P1.M3 Phase 2: TransitionController FSM.
- P1.M4 Phase 3: ReasoningBuffer, reasoning detection, ShortcutManager, TransitionCoordinator.
- P1.M5 Phase 4: AbortController + abort/completion race handling.
- P1.M6 Phase 5: RequestBuilder (thinking-disabled replacement).
- P1.M7 Phase 6: Stream splicing + authority transfer + full transition lifecycle.
- P1.M8 Phase 7: Telemetry, failure modes (FM-001..015), lifecycle/re-registration, property/stress/chaos/regression tests, docs.

## Version note

`package.json` is `0.1.0`. A version bump to `1.0.0` is a release-engineering concern and is
OUT OF SCOPE for this docs-only task (per FORBIDDEN OPERATIONS — no source/package edits beyond
README.md + CHANGELOG.md). The README/CHANGELOG **describe** the feature as the v1.0.0
production MVP; the actual `package.json` version is left untouched here.
