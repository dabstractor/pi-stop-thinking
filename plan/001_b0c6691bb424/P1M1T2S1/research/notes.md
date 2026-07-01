# Research Notes — P1.M1.T2.S1 (Config type, defaults, validation)

## Source contracts consulted
- `plan/001_b0c6691bb424/architecture/module_contracts.md` → "Configuration" block (authoritative
  Config shape, field defaults, `load()`/`validate()` interface, DiagnosticsLevel union).
- `plan/001_b0c6691bb424/architecture/system_context.md` → consumer integration (registerShortcut
  uses `config.shortcut` as a `KeyId`; decorator decision tree uses `config.enabled` +
  `config.supportedProviders`).
- `plan/001_b0c6691bb424/architecture/external_deps.md` → build/test conventions (tsc→dist,
  `bun test`, bundler moduleResolution). `ExtensionAPI.registerFlag/getFlag` = source of partial
  config at runtime (owned by T5, NOT this subtask).
- `PRD.md` §47 Configuration Specification (option list, "deterministic defaults", "future requests
  only"); Appendix K (schema + validation rules: validate-on-init, produce-diagnostics,
  fall-back-to-defaults, never-block-delegation); Appendix G ("Configuration defaults shall be
  immutable"); §36 Diagnostics (modes); §55 Testing (Configuration is a unit-test target).

## Key decisions
1. **Pure module, zero Pi imports.** `loadConfig`/`validateConfig` receive a plain object; reading
   `pi.getFlag`/env + emitting diagnostics is the **init flow (P1.M1.T5.S1)** responsibility. This
   keeps the config module dependency-free and trivially unit-testable. Appendix K's "produce
   diagnostics" is satisfied downstream by comparing input vs `validateConfig` output.
2. **`loadConfig` composes `validateConfig`.** `loadConfig(p) = validateConfig({ ...DEFAULT_CONFIG,
   ...(p ?? {}) })`. Guarantees the core invariant — no invalid value ever escapes the module — even
   though `Partial<Config>` is only a *compile-time* guarantee (runtime values can still be bad).
3. **`shortcut` default = `"ctrl+."` (lowercase KeyId).** Resolves PRD Appendix K (`"Ctrl+."`,
   display notation) vs the runtime `KeyId` format consumed by `pi.registerShortcut` (confirmed
   lowercase `"ctrl+."`/`"escape"`/`"shift+tab"` in system_context.md KEYBINDINGS). The item contract
   also states `'ctrl+.'`.
4. **`diagnosticsLevel` default = `"error"`.** PRD §36 "Diagnostics disabled by default" is a
   **Diagnostics-module (P1.M1.T3.S1)** concern (verbose/trace off). This subtask only stores the
   level per its explicit contract.
5. **`DEFAULT_CONFIG` deep-frozen** — `Object.freeze` on the object AND the nested
   `supportedProviders` array, so a consumer cannot mutate the shared default (Appendix G).
6. **`validateConfig` returns fresh objects** (copies arrays), never exposing `DEFAULT_CONFIG`
   references for mutation.
7. **Strict type validation, no coercion.** `enabled: "true"` / `enabled: 1` → invalid → default.
   Ranges: timeouts `Number.isFinite && > 0`; `maximumReasoningBufferBytes` `Number.isInteger && > 0`;
   `supportedProviders` array where every element is a non-empty string; `shortcut` non-empty string.
   Unknown keys ignored. Per-field fallback (one bad field does NOT poison the whole config).

## Module placement
- File: `src/config/index.ts` (replaces `src/config/.gitkeep` from P1.M1.T1.S1).
  `moduleResolution: "bundler"` + Bun both resolve `./config` → `./config/index.ts`.
- Tests: `tests/config.test.ts` (flat `tests/` dir from the scaffold; excluded from the build tsc
  `exclude: ["tests"]`, validated via `bun test`).
- No changes to `package.json`/`tsconfig.json` (owned by T1). Uses existing scripts: `bun test`,
  `bun run build` / `bunx tsc --noEmit`.

## Consumer API contract (for downstream PRPs)
```ts
import type { Config, DiagnosticsLevel } from "./config";      // or "../src/config"
import { DEFAULT_CONFIG, loadConfig, validateConfig } from "./config";
const config: Config = loadConfig(maybePartial);               // never throws, always valid
```
