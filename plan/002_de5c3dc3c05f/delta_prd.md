# Delta PRD — Reasoning Reuse via Ephemeral Text Injection (§53 / ADR-006)

**Base:** `PRD.md` (current) vs `plan/001_b0c6691bb424/prd_snapshot.md` (previous MVP, fully implemented)
**Delta size:** ~3,300 added words / ~34% PRD growth, all threads of **one theme** → a focused **medium** feature addition.
**Scope:** A single new capability (input injection) layered onto already-built infrastructure.

---

## 1. Executive Summary

The previous session shipped the MVP: a `Stop Thinking & Do` extension that aborts a z.ai reasoning stream on `Ctrl+Q` and splices a thinking-disabled replacement into the same assistant turn. In that MVP the reasoning captured before the shortcut was **discarded** — the replacement was sent thinking-disabled with the original context only, so the model answered **from scratch**. The reasoning survived only for *display* (output stitching via event forwarding — already working).

The current PRD changes that. The captured reasoning must now be **reused**: the frozen `ReasoningBuffer` snapshot is injected as **ephemeral, delimited plain-text reference context** into the thinking-disabled replacement request, so the model conditions its answer on its own prior reasoning. This is the **§53 Ephemeral Execution Directive**, the load-bearing decision of **ADR-006**.

This is an **input-injection** concern, explicitly distinct from the **output stitching** that already places reasoning into the persisted/displayed assistant message. Both occur; the previous session implemented output stitching; **this delta implements input injection**.

---

## 2. Diff Analysis (what actually changed)

All additions are threads of one theme — *reasoning reuse*. New top-level constructs:

| Added | Where | Purpose |
| --- | --- | --- |
| **§53 Ephemeral Execution Directive** | new section | Mechanism: render snapshot → delimited fence → inject into replacement request input as ephemeral reference context |
| **ADR-006** | new ADR | Decision rationale (discard rejected empirically; native round-trip / server-continuation unavailable; plain-text injection chosen) |
| **§17 Reasoning-Disabled Scope + INV-014** | new section + Appendix O | Reasoning disabled for **exactly one** request (the replacement); nothing else mutated |
| **INV-013** | Appendix O | Reasoning shall be reused, not discarded |
| **Appendix P — Empirical Basis** | new appendix | GLM-5.2 probes: complete-capture injection matched full-thinking quality; prefix cache survives the thinking toggle (~15–29% TTFT reduction); `options.reasoning` key + `maxTokens` enforcement hazards |
| **Config: `reasoningInjection`, `reasoningInjectionDelimiter`** | §47 + defaults YAML | Enable/disable the directive; configure the delimiter fence |
| **Acceptance criteria** | §48 + checklists | Reuse proportional to capture; reasoning-disabled scope holds; directive is ephemeral |

Modified context (clarifications, not new mechanisms): §1 Executive Summary, §2 / NG2 (server-side resumption non-goal restated; client-side reuse framed), §6 Stream Proxy, §23 / §41 ReasoningBuffer (snapshot feeds two uses), §25.6 (option-key + `maxTokens` notes), Part 9 latency budget (cache analysis), glossary (Ephemeral Execution Directive / Input Injection / Output Stitching).

---

## 3. What Is Already Built (reference — DO NOT re-implement)

The reuse infrastructure already exists; the gap is narrow:

- **`ReasoningBuffer`** (`src/buffer/index.ts`) — append-only capture, `freeze()`, immutable `snapshot()` returning frozen `readonly ThinkingEntry[]`. **Done.**
- **StreamProxy threads the snapshot into the builder** — `src/provider/proxy.ts:890` calls `this._requestBuilder.buildReplacement(model, context, options, this._buffer.snapshot())`. **Done.**
- **`RequestBuilder.buildReplacement` accepts `reasoningSnapshot`** (`src/request/builder.ts`) — plumbed through. **Done, but explicitly NOT READ** ("NOT read in MVP"). **← core gap.**
- **`reasoning: undefined` override** — applied to a fresh `{ ...options, reasoning: undefined }` (original options unmutated). §25.6 option-key finding (`options.reasoning`, NOT `reasoningEffort`) already honored. **Done.**
- **Output stitching** — StreamProxy forwards primary `thinking_*` events to Pi's output, so the persisted assistant message already contains reasoning followed by the answer. **Done** (README already advertises it).

---

## 4. Scope Delta — Requirements to Implement

### R1 — `RequestBuilder` must read the snapshot and build the §53 directive (NEW)

`buildReplacement` currently ignores `reasoningSnapshot`. It must now:

1. **Render the snapshot to plain text** — offset-ordered join of each `ThinkingEntry.content`, unmodified. No summarization/compression/deltas/offsets/timestamps/event envelopes — only rendered reasoning text (buffer is opaque, PRD §13.4).
2. **Gated injection** — when `config.reasoningInjection === true` (default) **AND** rendered text is non-empty: wrap it in the configured delimiter fence and inject it as ephemeral, delimited reference context into the replacement request's **input context** (a **copy** of `Context` with the directive appended as a new message; see R3). When disabled **or** snapshot empty: **omit** the directive → from-scratch thinking-disabled answer (graceful fallback, no error).
3. **Position as read-only reference context, NOT a continuation prompt** — framing must not invite resuming/extending reasoning (PRD §53 Positioning / §26). The default fence (PRD §53) opens/closes the reasoning and ends with a "produce your best available answer now; do not continue reasoning" line.
4. **Bounded `maxTokens`** on the replacement — z.ai does **not** reliably enforce `maxTokens` (Appendix P.3: ~733 tokens emitted under a 220 limit), so the bound is best-effort and completion must rely on the stream's terminal event, not the cap. Preserve any caller-supplied `maxTokens`; set one only when absent (pick a sane answer budget; document it).

   - **Docs (Mode A — rides with this requirement):** Rewrite `src/request/builder.ts` JSDoc. Remove all "NOT read in MVP" / "reserved for forward-compat" language. Document: (a) directive construction from the snapshot; (b) the **two distinct uses** of one snapshot — *input injection* (here) vs *output stitching* (already done); (c) gated fallback (disabled/empty → omitted); (d) INV-014 options-level scoping (fresh options, original unmutated); (e) the `maxTokens` best-effort caveat.

### R2 — `Config` gains directive fields (MODIFIED)

Add to `Config` (`src/config/index.ts`), `DEFAULT_CONFIG`, `validateConfig`, and `loadConfigFromEnv`:

- **`reasoningInjection: boolean`** — default `true`. Enables/disables the §53 directive.
- **`reasoningInjectionDelimiter: { open: string; close: string }`** — default deterministic fence (PRD §53 / defaults YAML):
  ```
  open:  "---\n[Prior reasoning captured before you were asked to stop thinking]"
  close: "[End of prior reasoning]\n---"
  ```
  Validation: per-field strict fallback to defaults (invalid/missing → default), consistent with Appendix K. Env loading (`loadConfigFromEnv`): `PI_STOP_THINKING_REASONING_INJECTION` (bool) and `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` / `..._CLOSE` (non-empty strings). Mirror the existing `envBool` / `isNonEmptyString` helpers.

  `Config` (or the two fields) must be threaded into `RequestBuilder` — its constructor currently takes only `Diagnostics`. Update the constructor signature and the single call site in `StreamProxy`.

   - **Docs (Mode A):** JSDoc the two new fields (purpose + default + env var). Keep the Appendix H privacy note (never log reasoning text) current.

### R3 — Context augmentation is ephemeral and non-mutating (NEW constraint on R1)

The directive is injected into a **copy** of the replacement `Context`, never the original:

- Construct `{ ...context, messages: [...context.messages, directiveMessage] }` (or equivalent) — do **NOT** mutate the original `context` or any existing message.
- The augmentation is **ephemeral**: it exists only within the single replacement request and must **not** be persisted into conversation history as a new/modified message (persisted reasoning reaches history only via output stitching).
- This **diverges from the previous MVP rule** "context is the same reference as input" (PRD §25.3/§25.4). That rule now holds only when injection is **off or the snapshot is empty**; when injection is active, `context` is a fresh augmented copy. Update `tests/request-builder.test.ts` cases asserting `context` identity-by-reference (they currently pass `[]`, so they still pass — add cases for the non-empty path asserting augmentation).

### R4 — Verify/attest INV-014 Reasoning-Disabled Scope (VERIFY — largely already satisfied)

PRD §17 + INV-014 require reasoning disabled for **exactly one** request (the replacement) and nothing else. Mostly already true from the MVP:

- Replacement options: fresh object, `reasoning === undefined`. ✅ (existing)
- Original request options: **never mutated**. ✅ (existing — confirm via test)
- **NEW assertion to cover:** the extension must **not** modify Pi's session-level / default thinking level, and the next turn's request still carries the user's configured reasoning level. Since `Context`/`options` augmentation touches no thinking-level setting, this holds structurally — add an explicit test/attestation to defend against future regressions.

### R5 — INV-013 (NEW invariant, satisfied by R1)

Reasoning shall be reused, not discarded. Mechanically satisfied once R1 lands; capture as an acceptance criterion (R1-gated injection on by default).

---

## 5. Key Constraints & Invariants (for the implementer)

- **§25.6 option key:** toggle thinking via `options.reasoning` (`undefined` = off). Do **NOT** use `options.reasoningEffort` — z.ai derives it from `reasoning` and a direct `reasoningEffort` is silently dropped. (Already honored; keep it.)
- **§25.6 `maxTokens`:** z.ai does not reliably honor it (Appendix P.3). Set a bound but rely on the terminal event for completion.
- **Privacy (Appendix H):** diagnostics may log counts / byte totals / event names only. **Never** log rendered reasoning text, directive content, prompts, or outputs.
- **§53 delimiter:** deterministic, clearly-labeled, configurable via `reasoningInjectionDelimiter`. Changing it must not change the shortcut or config mechanism.
- **§53 positioning:** reference context only — never a continuation prompt.

---

## 6. Documentation Impact

**Mode A (rides with the implementing work):** covered as sub-bullets under R1 (`src/request/builder.ts` JSDoc rewrite) and R2 (`src/config/index.ts` JSDoc). No standalone tasks.

**Mode B (changeset-level — final task):** `README.md` needs cross-cutting updates that only make sense once R1–R5 land:
- **Features** — add a "Reasoning reuse" blurb: when you stop thinking, the captured reasoning is fed back to the model as context so the answer is informed by it (best-effort, proportional to how far reasoning got), not answered from scratch.
- **Configuration table + env-var table** — add rows for `reasoningInjection` (default `true`) and `reasoningInjectionDelimiter` (with its `OPEN`/`CLOSE` env vars).
- **Usage / "How it works"** — reflect that the replacement answer now conditions on the injected reasoning; keep the existing "reasoning preserved in the saved message" text (output stitching) and disambiguate it from reuse.

---

## 7. Implementation Plan (proportional: 1 phase, 1 milestone)

### Phase P2 — Reasoning Reuse via Ephemeral Text Injection

**Milestone P2.M1 — Implement the §53 Ephemeral Execution Directive**

> **Suggested tasks (breakdown agent to refine):**
> 1. **Config additions** (R2) — add `reasoningInjection` + `reasoningInjectionDelimiter` to `Config`, `DEFAULT_CONFIG`, `validateConfig`, `loadConfigFromEnv`; thread the fields into `RequestBuilder` (constructor + `StreamProxy` call site).
> 2. **Directive construction** (R1 + R3) — render snapshot to plain text; gated (enabled & non-empty) fence wrapping; ephemeral `Context` copy augmentation (non-mutating); bounded `maxTokens`; rewrite `builder.ts` JSDoc. Add a small pure render helper if it clarifies ownership.
> 3. **Tests & invariant coverage** (R4 + R5) — directive content/format, gated fallback (disabled/empty → omitted, from-scratch), delimiter config, non-mutation of original `context`/options, session-level thinking level untouched (INV-014), reasoning reused by default (INV-013). Update existing `context`-identity assertions for the non-empty path.
> 4. **Mode B docs** — `README.md` updates per §6.

---

## 8. Acceptance Criteria (from PRD §48 additions)

- ☐ Captured reasoning is reused via ephemeral input injection (§53): when adequate material reasoning was captured, the replacement answer conditions on the injected snapshot (best-effort, proportional to capture); an early interruption capturing little degrades gracefully to from-scratch quality.
- ☐ Reasoning-disabled scope holds (INV-014): only the replacement is thinking-off; the next turn retains the user's configured reasoning level; original request options are unmutated; other providers/models unaffected.
- ☐ The injected directive is ephemeral: not persisted as a new/modified message; persisted reasoning reaches history only via output stitching.
- ☐ When `reasoningInjection` is disabled or the snapshot is empty, the directive is omitted and the replacement is a from-scratch thinking-disabled answer (no error).
- ☐ Diagnostics never log reasoning/directive/prompt/output text (Appendix H).
- ☐ `README.md` reflects reasoning reuse + the two new config fields.

---

## 9. Research Pointers (leverage prior session — do NOT re-research)

- `plan/001_b0c6691bb424/architecture/module_contracts.md` — `RequestBuilder` contract already lists the directive as "MAY ADD: ephemeral execution directive to system prompt (optional, minimal)" and the `Config` shape.
- `plan/001_b0c6691bb424/architecture/external_deps.md` — `Context { systemPrompt?, messages: Message[], tools? }` and `Message = UserMessage | AssistantMessage | ToolResultMessage` (`UserMessage.role: "user"`, `content: string | (TextContent|ImageContent)[]`). This is how the directive message is constructed.
- `plan/001_b0c6691bb424/architecture/zai-api-research.md` — `reasoning_content` field semantics; abort/restart mechanics; §3 notes "optionally send them back as context in the restart request (e.g. as an assistant message prefix)" — the conceptual basis ADR-006 formalizes.
- **Empirical re-validation (Appendix P.4):** the quality/cache/option-key findings are point measurements against GLM-5.2 and may shift. If a breakdown task depends on a specific number (e.g. `maxTokens` enforcement, cache benefit), re-probe against the current endpoint.
- **No web search needed.** The provider API and pi-ai internals were fully characterized in session 001.
