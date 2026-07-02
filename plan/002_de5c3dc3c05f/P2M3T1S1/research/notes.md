# Research Notes — P2.M3.T1.S1: Config tests for reasoningInjection + reasoningInjectionDelimiter

## Task scope (from contract)

TEST-ONLY subtask. No source files touched. The gap analysis below is the authoritative basis
for the PRP.

## State of `tests/config.test.ts` (committed as of HEAD `02c0e0c`)

`git status` shows `tests/config.test.ts` is **clean** (committed during P2.M1.T1.S1/S2).
Inspecting the committed file reveals the directive test coverage is **PARTIALLY present**:

| Contract item (a–e)                                      | Present? | Detail |
|----------------------------------------------------------|----------|--------|
| (a) FULL_DEFAULTS includes the 2 new fields             | ✅ YES   | lines 13–18 |
| (b) validateConfig per-field test for `reasoningInjection`        | ❌ NO    | MISSING — **core gap** |
| (c) validateConfig per-field test for `reasoningInjectionDelimiter` | ❌ NO    | MISSING — **core gap** |
| (d) env tests for the 2 new fields                       | ✅ YES   | lines 153–184 (REASONING_INJECTION + DELIMITER_OPEN/CLOSE) |
| (e) composition: one invalid directive field doesn't poison others | ⚠️ PARTIAL | generic composition test exists; no **directive-specific** one |

**Conclusion**: This subtask must ADD exactly **3 new test cases** (b, c, e). It must NOT
re-add (a) or (d) — they already exist and duplicating them would create dead/duplicate tests.

## Empirically verified behavior (run via `bun -e` against src/config/index.ts)

### reasoningInjection — `validateConfig` guard: `isBool = typeof v === "boolean"`

| input        | result | why |
|--------------|--------|-----|
| `true`       | `true`  | valid boolean |
| `false`      | `false` | valid boolean |
| `"true"`     | `true`  | string → invalid → default `true` |
| `1`          | `true`  | number → invalid → default `true` |
| `0`          | `true`  | number → invalid → default `true` |
| `null`       | `true`  | invalid → default `true` |
| `undefined`  | `true`  | invalid → default `true` |

### reasoningInjectionDelimiter — `validateConfig` guard: `isOpenCloseShape`
(`object && !=null && open&close both non-empty strings`)

| input                              | result | why |
|------------------------------------|--------|-----|
| `{ open: 'a', close: 'b' }`        | `{open:'a',close:'b'}` | valid — returned as a COPY |
| `{ open: 'a' }` (missing close)    | default | fails shape |
| `{ close: 'b' }` (missing open)    | default | fails shape |
| `{ open: '', close: 'b' }`         | default | empty string fails `length>0` |
| `"x"` (string)                     | default | non-object |
| `42`                               | default | non-object |
| `[]`                               | default | array, no open/close |
| `null`                             | default | null fails `!= null` |
| `undefined`                        | default | undefined fails object check |

**Freshness (verified)**: a valid delimiter is returned as a NEW object (not the input ref);
an invalid delimiter returns `{ ...DEFAULT_CONFIG.reasoningInjectionDelimiter }` (a fresh copy,
`.toEqual` matches DEFAULT but `.not.toBe(DEFAULT_CONFIG.reasoningInjectionDelimiter)`).

### Composition (verified)
- `{ reasoningInjection: "bad", reasoningInjectionDelimiter: {open:'a',close:'b'} }`
  → `reasoningInjection === true` (default), delimiter kept `{open:'a',close:'b'}`.
- `{ reasoningInjection: false, reasoningInjectionDelimiter: "bad" }`
  → `reasoningInjection === false` (kept), delimiter → default.

## Test insertion points (exact)

1. **Per-field block** `"validateConfig — per-field fallback (strict types, no coercion)"`:
   insert after the `diagnosticsLevel` test, before the describe block's closing `});`.
2. **Composition block** `"validateConfig — composition rules"`: insert after the existing
   `"one invalid field does not poison valid fields"` test.

## Validation commands (verified)

- `bun test tests/config.test.ts` — **primary gate**. Currently 45 pass / 0 fail. Target after: 48 pass.
- `bun test` — full suite regression (the parallel P2.M2.T3.S1 modifies proxy.ts/decorator.ts;
  config tests are independent of those, so they stay green).
- `bun run typecheck` (`tsc --noEmit`) — **excludes `tests/`** (tsconfig.json `"exclude": [..., "tests"]`),
  so it is NOT a gate for test code. It should remain a no-op/zero-error (src/ untouched).

## Conventions to follow (from existing file)

- Imports already present: `DEFAULT_CONFIG, loadConfig, loadConfigFromEnv, validateConfig` — no new imports.
- `for (const bad of [...])` table style for invalid-value sweeps (see `enabled`, `shortcut`, etc.).
- `.toBe` for scalars (booleans/strings); `.toEqual` for the delimiter object.
- `expect(...).toEqual({ ...DEFAULT_CONFIG.reasoningInjectionDelimiter })` — the existing file's
  idiom for "default delimiter object" (avoids coupling to the literal fence string).
- Test names are short, field-led: `"reasoningInjection"`, `"reasoningInjectionDelimiter (…)"`.
