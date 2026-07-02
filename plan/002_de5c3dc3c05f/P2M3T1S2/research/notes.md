# Research Notes — P2.M3.T1.S2 (RequestBuilder directive + INV-013/INV-014 tests)

> Empirically verified against the LIVE `src/request/builder.ts` (post P2.M2.T2.S1, which is
> **Complete**) via `bun -e` (see `/tmp/verify-builder.ts` script in the agent transcript).
> Every assertion below is backed by a confirmed `true` result. The implementation already
> satisfies the entire contract — this task is **test-only**: add directive coverage to
> `tests/request-builder.test.ts`.

## 0. Baseline

- `bun test tests/request-builder.test.ts` → **20 pass / 0 fail / 47 expect() calls** (pre-change).
- The 20 existing tests all use `new RequestBuilder(diag)` (defaults). Defaults preserve prior
  behavior → **NO existing test needs editing** (item i confirmed). Empty-snapshot context-identity
  test still passes (injection omitted for `[]`).

## 1. Imports & helpers ALREADY present in tests/request-builder.test.ts

- `makeCaptureDiag()` — capturing Diagnostics stub (records every `debug`/`info`/... call to `events`).
- `makeModel()` — minimal `Model<Api>` (id `glm-4.7`, api `openai-completions`, provider `zai`, reasoning `true`).
- `makeContext()` — minimal `Context` (`systemPrompt: "You are helpful."`, `messages: [{role:"user",content:"Hello"}]`).
- `ReasoningBuffer`, `ThinkingEntry` (type), `Diagnostics` (type) — already imported.
- **MISSING import needed by new tests:** `DEFAULT_CONFIG` from `"../src/config"` (for delimiter-fence
  assertions without coupling to the literal fence string — mirrors the config-test idiom). Must be a
  VALUE import (`import { DEFAULT_CONFIG }`), not a type import.

## 2. Constructor signature (P2.M2.T2.S1 — verified live)

```ts
new RequestBuilder(diagnostics, _reasoningInjection = DEFAULT_CONFIG.reasoningInjection /* true */,
                   _delimiter = DEFAULT_CONFIG.reasoningInjectionDelimiter /* fence */)
```
- `new RequestBuilder(diag)` ⇒ injection `true`, default delimiter. **INV-013 default.**
- `new RequestBuilder(diag, false)` ⇒ injection disabled (gated fallback b).
- `new RequestBuilder(diag, true, { open, close })` ⇒ custom delimiter.

## 3. Verified input→result mapping (the 9 contract items a–i)

### a) DIRECTIVE CONTENT (non-empty snapshot + injection enabled — DEFAULT)
Builder call with snapshot `["Step 1: analyze. ", "Step 2: conclude."]`:
- `triple.context !== context` → **NEW reference** (not `toBe` original). ✓
- `triple.context.messages.length === context.messages.length + 1` (exactly +1). ✓
- Last message `role === "user"` (UserMessage). ✓
- Last message `content` (verbatim, default delimiter):
  ```
  ---
  [Prior reasoning captured before you were asked to stop thinking]
  Step 1: analyze. Step 2: conclude.
  [End of prior reasoning]
  ---

  Using the prior reasoning above as reference context only, produce your best available answer to the user's request now. Do not continue or extend reasoning.
  ```
- `content.includes("Step 1: analyze. Step 2: conclude.")` ✓ (rendered, offset-ordered, unmodified).
- `content.startsWith(DEFAULT_CONFIG.reasoningInjectionDelimiter.open)` ✓ (open fence at start).
- `content.includes(DEFAULT_CONFIG.reasoningInjectionDelimiter.close)` ✓.
- `content.includes("reference context only")` ✓ (§53 h3.72 positioning).
- `content.includes("Do not continue or extend reasoning.")` ✓ (non-continuation).
- Directive message own keys: exactly `["role","content","timestamp"]` → **NO `reasoning` field**.

### b) GATED FALLBACK — DISABLED (`reasoningInjection: false` + non-empty snapshot)
- `triple.context === context` (SAME reference). ✓
- `triple.context.messages.length === context.messages.length` (unchanged). ✓
- `triple.options.reasoning === undefined` (INV-014 still holds). ✓

### c) GATED FALLBACK — EMPTY (`reasoningInjection: true` (default) + `[]`)
- `triple.context === context` (SAME reference). ✓
- `triple.context.messages.length === context.messages.length` (unchanged). ✓

### d) NON-MUTATION (§53 h3.73) — after `buildReplacement` with injection active
- `context.messages === originalMessagesRef` (same array ref). ✓
- `context.messages.length === 1` (unchanged). ✓
- `context.systemPrompt === "You are helpful."` (untouched). ✓
- `options.reasoning === "high"` (original reasoning level intact). ✓
- `options.temperature === 0.7` (original sampling intact). ✓
- `"maxTokens" in options === false` (no new keys added to original options). ✓

### e) PRIVACY (Appendix H h2.203) — with injection ACTIVE (reasoning text present)
- Exactly one `request.replacement-built` debug event. ✓
- `fields === {}` (no reasoning text, no directive text, no prompt/options content leak). ✓
  NOTE: the existing privacy test only checks the EMPTY-snapshot case; the new test must check the
  ACTIVE-injection case (reasoning text actually flowing through) — the materially stronger assertion.

### f) INV-013 (default reuses reasoning)
- `new RequestBuilder(diag)` (no injection arg) + non-empty snapshot → `triple.context !== makeContext()`,
  `triple.context.messages.length > 1`, directive content contains the captured text. ✓

### g) INV-014 (reasoning scope)
- `triple.options !== options` (fresh object). ✓
- `triple.options.reasoning === undefined`. ✓
- `options.reasoning === "high"` (original UNMUTATED). ✓
- Directive message has NO `reasoning` key (`"reasoning" in directive === false`). ✓

### h) maxTokens (§25.6 h2.97 + Appendix P.3 h2.236)
- No `maxTokens` in original options → `triple.options.maxTokens === 16384` (`DEFAULT_REPLACEMENT_MAX_TOKENS`). ✓
- `maxTokens: 4096` in original → preserved verbatim (`=== 4096`). ✓
- Empty snapshot + no maxTokens → `16384` (maxTokens bound is independent of the injection gate). ✓

### i) EXISTING TESTS still pass
- All 20 existing tests pass unchanged (defaults preserve behavior; empty `[]` ⇒ same-ref context
  identity holds). Confirmed via the 20-pass baseline run. **No edit to existing tests required.**

## 4. Test plan (9 new tests → 20→29 pass)

- **ADD import** `import { DEFAULT_CONFIG } from "../src/config";` (top of file, value import).
- **ADD helper** `makeSnapshot(diagnostics, ...deltas)` after `makeContext()` (DRY snapshot builder).
- **ADD describe** `"RequestBuilder — Ephemeral Execution Directive (§53 / ADR-006)"` (5 tests:
  directive content, gated-disabled, gated-empty, INV-013, custom-delimiter) at end of file.
- **ADD describe** `"RequestBuilder — directive non-mutation & INV-014 (§53 h3.73)"` (2 tests).
- **ADD describe** `"RequestBuilder — maxTokens bound (§25.6 h2.97)"` (1 test).
- **ADD test** inside the existing `"RequestBuilder — privacy guard (Appendix H)"` describe (1 test:
  privacy with injection active).

## 5. Gotchas

- `tsconfig.json` EXCLUDES `tests/` → `bun run typecheck` does NOT type-check the test file. The
  authoritative gate is `bun test tests/request-builder.test.ts`. (Run typecheck only to confirm
  `src/` untouched.)
- No ruff/mypy/eslint/biome — Bun+TS project.
- `makeContext()` is a NEW object each call; comparing `triple.context !== makeContext()` is meaningless
  unless you capture the ref first. The non-mutation test captures `originalMessagesRef = context.messages`
  BEFORE the call.
- Directive message keys are `["role","content","timestamp"]` (built via object literal in builder.ts);
  asserting `Object.keys(directive).sort()` pins the exact shape and proves no stray `reasoning` field.
- Sibling P2.M3.T1.S1 owns `tests/config.test.ts`; parallel P2.M2.T3.S1 owns `src/provider/proxy.ts` +
  `decorator.ts`. This task touches ONLY `tests/request-builder.test.ts` — no overlap.
