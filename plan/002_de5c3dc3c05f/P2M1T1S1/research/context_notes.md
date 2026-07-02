# Research Notes — P2.M1.T1.S1 (Add Config fields)

## Key files inspected
- `src/config/index.ts` — the ONLY source file to modify in S1.
- `tests/config.test.ts` — existing test file; `FULL_DEFAULTS` constant MUST be updated minimally (see gotcha).
- `plan/002_de5c3dc3c05f/architecture/directive_design.md` §6 — exact config type additions & validation contract.

## Precise line anchors (src/config/index.ts)
- `Config` interface: line 16
- `DEFAULT_CONFIG: Config = Object.freeze({...}) as Config;`: line 44
- Guard helpers (`isBool` … `isDiagnosticsLevel`): lines 56–66
- `pick<T>(value, guard, fallback)`: line 69
- `validateConfig(config)`: line 88
- `loadConfig`/`loadConfigFromEnv`: lines 122 / 178 — NOT TOUCHED in S1 (S2 owns env parsing)

## CRITICAL gotcha verified empirically
`bun:test`'s `toEqual` does deep equality requiring exact own-key match (extra defined keys on
received => FAIL). Verified with /tmp/eq_check.test.ts:
- `expect({a:1,b:2}).toEqual({a:1})` THROWS.

Therefore adding `reasoningInjection` + `reasoningInjectionDelimiter` to the `validateConfig({})`
return object WILL break the existing `tests/config.test.ts` suite, which compares
`validateConfig(input)` against a `FULL_DEFAULTS` constant that lacks the two new fields
(~8 usages across "defaults on invalid container input", "composition rules", "loadConfig",
"loadConfigFromEnv empty env" tests).

=> S1 MUST minimally extend `FULL_DEFAULTS` with the two new default fields to keep `bun test`
green. This is required by the validation gate, NOT the fuller edge-case test work (that's
P2.M3.T1.S1).

## Delimiter validation gotcha (from contract §3c)
`isOpenCloseShape` must check BOTH open AND close are non-empty strings. On ANY failure fall
back to the ENTIRE default object (not partial). Do NOT do per-field `pick` on open/close —
a valid `open` but empty `close` must yield the whole default delimiter, not a hybrid.

## Delimiter default values (PRD §53 h3.71 + Appendix K h1.117)
- open: `"---\n[Prior reasoning captured before you were asked to stop thinking]"`
- close: `"[End of prior reasoning]\n---"`
(\n is a literal newline escape in the TS string source.)

## Validation commands (verified present in package.json)
- `bun test` (test runner; `bun:test`)
- `bun run typecheck` → `tsc --noEmit` (tsconfig.json EXCLUDES `tests`, so this only typechecks `src/`. Run `bun test` for runtime validation of tests.)
- No ruff/mypy/eslint — this is a TypeScript+Bun project (the PRP template's Python tooling does NOT apply).

## Scope boundary (respecting sibling tasks)
- DO NOT add env-var parsing for the new fields → that is P2.M1.T1.S2.
- DO NOT write the comprehensive edge-case test suite for the new fields → that is P2.M3.T1.S1.
  (Only the minimal `FULL_DEFAULTS` update to keep existing tests green.)
- DO NOT modify RequestBuilder / StreamProxy / decorator → those are P2.M2.*.
- `loadConfig` and `loadConfigFromEnv` need NO change: they spread `DEFAULT_CONFIG` (which now
  contains the frozen new fields) into `validateConfig`, which already validates them. Pass-through
  is automatic.

## Privacy note (Appendix H)
Existing JSDoc already carries the Appendix H privacy note (never log reasoning text). Keep it
current. The two new fields describe injection gating/fencing only — their JSDoc must not imply
that reasoning text is logged/telemetered (it is not).
