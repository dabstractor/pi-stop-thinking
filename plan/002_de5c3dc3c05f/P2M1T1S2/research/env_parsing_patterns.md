# Research Notes — P2.M1.T1.S2 (env-var parsing for directive fields)

## Source file & exact location

**File:** `src/config/index.ts` — the ONLY file S2 modifies.
**Function:** `loadConfigFromEnv(env: Record<string, string | undefined> = process.env): Config`
  - Currently at **line 215** (pre-S1). **S1 will add ~37 lines ABOVE it** (interface +2 fields/JSDoc,
    DEFAULT_CONFIG +nested freeze, isOpenCloseShape guard, validateConfig return +2 lines), so by the
    time S2 runs `loadConfigFromEnv` will be nearer **~line 252**. ⇒ **Locate by function name /
    the `return validateConfig({ ...DEFAULT_CONFIG, ...partial });` line — NOT by absolute line number.**
- The parsing block lives between `const partial: Record<string, unknown> = {};` (line 216) and the
  final `return validateConfig(...)` (line 242). New parsing goes IMMEDIATELY BEFORE the return.

## Existing parsing patterns to mirror (verbatim style)

The current `loadConfigFromEnv` uses ONE consistent shape per field type:

```ts
// BOOLEAN  (reuse envBool — returns boolean | undefined)
const enabled = envBool(env[ENV_PREFIX + "ENABLED"]);
if (enabled !== undefined) partial.enabled = enabled;

// STRING-non-empty  (raw read; guard `!== undefined && length > 0`)
const shortcut = env[ENV_PREFIX + "SHORTCUT"];
if (shortcut !== undefined && shortcut.length > 0) partial.shortcut = shortcut;

// STRING-literal  (diag — same non-empty guard)
const diag = env[ENV_PREFIX + "DIAGNOSTICS"];
if (diag !== undefined && diag.length > 0) partial.diagnosticsLevel = diag;
```

Helpers available: `envBool` (bool|undefined), `envNumber` (number|undefined), `envStringArray`.
S2 reuses `envBool` for `REASONING_INJECTION`; reads the two delimiter vars as raw strings with the
non-empty guard (same as `shortcut`/`diag`).

## The `??`-coalescing gotcha (CRITICAL — must pre-normalize empties to `undefined`)

Contract §3d says: `partial.reasoningInjectionDelimiter = { open: envOpen ?? DEFAULT, close: envClose ?? DEFAULT }`.
**This ONLY works if `envOpen`/`envClose` locals are `undefined` when the env value is missing OR empty.**

- `undefined ?? "x"` → `"x"`  ✅ (what we want for missing/empty)
- `"" ?? "x"` → `""`  ❌ (empty string is NOT nullish, so `??` does NOT coalesce — produces empty!)

So the naive `env[ENV_PREFIX + "..."] ?? DEFAULT` is WRONG for a present-but-empty env value.
⇒ Normalize first: `const delimOpen = rawOpen !== undefined && rawOpen.length > 0 ? rawOpen : undefined;`
THEN `delimOpen ?? DEFAULT_CONFIG.reasoningInjectionDelimiter.open` is correct.

## Why the env path can NEVER trigger the delimiter whole-object fallback

`DEFAULT_CONFIG.reasoningInjectionDelimiter.open/close` are NON-EMPTY strings (the §53 fence).
A normalized `delimOpen`/`delimClose` is either `undefined` (→ coalesces to non-empty default) or a
non-empty user string. ⇒ the constructed `{ open, close }` ALWAYS has two non-empty strings ⇒
S1's `isOpenCloseShape` guard ALWAYS passes ⇒ the env-parsed delimiter ALWAYS survives validation.
(The whole-object fallback is only reachable via direct `loadConfig({...})` / `validateConfig({...})`
with a malformed object — that edge case is P2.M3.T1.S1's test scope, NOT reachable through env.)

## JSDoc "Configurable surface" — does NOT currently exist in code

Contract §6 says "update the existing 'Configurable surface' list" on `loadConfigFromEnv`. **Verified
by grep: NO such list exists** in `src/config/index.ts` today (the phrase lives only in PRD h1.41).
- The README *does* have a config TABLE (lines 64-71) listing env vars — but it is NOT yet updated
  for the 3 new reasoning vars, and **README updates are P2.M3.T2.S1's scope, NOT S2's**.
- ⇒ S2 DOCS resolution: **ADD** a short "Configurable surface" bullet list to the
  `loadConfigFromEnv` JSDoc (mirroring PRD h1.41) that documents the 3 new env-var names. This
  satisfies the contract's intent (env-var names documented in that JSDoc) without touching README.

## Dependency on S1 (the parallel task) — treated as a CONTRACT

S2 reads `DEFAULT_CONFIG.reasoningInjectionDelimiter.open` and `.close`, which **S1 adds**.
Per S1's PRP (Success Criteria), after S1:
  - `DEFAULT_CONFIG.reasoningInjectionDelimiter` exists, frozen, with the §53 fence strings.
  - `validateConfig` validates both new fields (isOpenCloseShape; whole-object fallback).
  - `tests/config.test.ts` `FULL_DEFAULTS` is extended with both new fields ⇒ existing suite green.
⇒ S2 needs NO change to DEFAULT_CONFIG / validateConfig / FULL_DEFAULTS — only `loadConfigFromEnv`
  (+ its JSDoc) + S2-specific env-parsing tests.

## Test scope (avoid overlap with M3)

- S1 precedent: minimal test change to keep suite green; defer comprehensive edge-case tests to M3.
- S2 owns the **env-PARSING** behavior. Its own tests should cover the 3 new vars through
  `loadConfigFromEnv({ [E + ...]: ... })` (the existing `describe("loadConfigFromEnv")` block, `const E`).
  Because the env path always yields a valid delimiter, S2 tests need NOT exercise the malformed-
  delimiter fallback (that's M3.T1.S1 / validateConfig scope).
- Existing `loadConfigFromEnv({})` ⇒ `toEqual(FULL_DEFAULTS)` stays green automatically (S1 updated
  FULL_DEFAULTS; empty env omits the new partial keys ⇒ validateConfig fills defaults).

## Validation commands (verified against package.json / tsconfig.json)

- `bun run typecheck` → `tsc --noEmit` (covers `src/` only; tsconfig EXCLUDES `tests`).
- `bun test tests/config.test.ts` → runs the config suite (runtime type-stripping).
- `bun test` → full suite.
- No ruff/mypy/eslint exist (TypeScript+Bun project) — do not invoke template artifacts.
