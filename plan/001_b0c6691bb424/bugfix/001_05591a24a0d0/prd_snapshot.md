# Bug Fix Requirements

## Overview

Creative end-to-end validation of the **Stop Thinking & Do** extension against `PRD.md`. All 380
existing unit/integration/stress/chaos tests pass and the project builds cleanly (`tsc`). The
extension's provider-decoration, FSM, abort coordination, and failure-mode handling are well-built.

However, by validating the extension's *output stream* against the **real downstream consumer**
(`@earendil-works/pi-agent-core`'s `agent-loop.js`, which assembles the assistant message and
persists it to conversation history), I found two defects that the existing test suite does not
catch. The existing tests assert on raw forwarded events but never simulate the real agent-loop
consumer, so they have a blind spot for how the consumer builds the final message.

**Bottom line:** The primary happy-path (press the shortcut *during* reasoning → get an answer)
delivers an answer, but (1) every interruption **silently discards the reasoning content** from the
persisted assistant message and visually flickers, and (2) pressing the shortcut *after* reasoning
ends (during answer generation) wrongly **aborts the in-progress answer** and starts a fresh
request. Both contradict explicit PRD requirements.

Testing performed:
- Build (`npm run build`) — passes.
- Full suite (`bun test`) — 380 pass / 0 fail.
- Source audit of all 10 modules (`src/**`) + the captured `openai-completions` provider and the
  `pi-agent-core` agent-loop/proxy consumers.
- Wrote faithful reproductions of the real consumer (`agent-loop.js` `for await` loop +
  `processProxyEvent` contentIndex assembly) and drove the extension's actual `StreamProxy` output
  through them — both bugs reproduced deterministically.

---

## Critical Issues (Must Fix)

### Issue 1: Reasoning content is lost from the persisted assistant message on every interruption (contentIndex collision + partial switching)

**Severity**: Critical
**PRD Reference**: Story 3 ("appear identical to a normal assistant response"); G4 ("single
continuous assistant response … no restart artifacts"); §13.4 / §23.1 (ReasoningBuffer exists to
preserve/maximize-continuity of reasoning); §14.2 ("the downstream consumer never observes the
boundary"); §19.7 / ADR-005 (observational equivalence).
**Confirmed against**: the real `pi-agent-core` consumer (`agent-loop.js` lines ~196–235 and
`proxy.js` `processProxyEvent`).

**Expected Behavior**: After a Stop-Thinking interruption, the assistant message seen by Pi (and
persisted to conversation history) should look like a **normal** z.ai reasoning response: content
blocks `[thinking, text]` — the reasoning that streamed before the interrupt is preserved, and the
answer text follows it. The user should observe reasoning streaming in, then the answer appearing
*after* it, with no visible restart.

**Actual Behavior**: The replacement stream (reasoning disabled) is a **fresh** z.ai request whose
text content is emitted at `contentIndex: 0` (the provider's `getContentIndex` returns
`blocks.indexOf` and, with reasoning off, the first/only block is the text block). The primary's
reasoning was also at `contentIndex: 0`. The `StreamProxy` forwards the replacement's events
**unchanged**, so the downstream consumer sees `thinking_*[0]` immediately followed by
`text_*[0]`.

The real consumer assembles the message from `event.partial` (each event's `partial` field is the
*provider's own* accumulating `output`). The replacement's events carry a **fresh partial that
contains only the text** — it does **not** include the primary's reasoning. The agent-loop does
`partialMessage = event.partial` on every event and finally `response.result()`, so the moment the
replacement's events arrive the accumulated reasoning is replaced, and the final persisted message
is **`content: [{ type: "text", text: "…" }]` only — the reasoning is gone.**

Equivalently, `pi-agent-core`'s `processProxyEvent` indexes `partial.content[contentIndex]`; the
replacement's `text_start` at index 0 **overwrites** the thinking block that lived at index 0.

Net effect, on **100% of interruptions** (the core use case):
- The reasoning the user watched stream in **disappears** from the final/persisted message.
- The UI shows reasoning streaming in, then **vanishing** and being replaced by the answer — a
  visible restart artifact (exactly what G4 forbids).
- Conversation history diverges from a normal response (normal = `[thinking, text]`; interrupted =
  `[text]`).

**Steps to Reproduce**: Drive a realistic two-call mock provider (primary emits
`start → thinking_start[0] → thinking_delta[0]…` with a `partial` carrying an accumulating
`thinking` block; replacement, invoked with `reasoning: undefined`, emits
`start → text_start[0] → text_delta[0] → done` with a **fresh** partial carrying only a `text`
block) through a `StreamProxy`, trigger `stop` mid-reasoning, then run the exact agent-loop
consumer logic (`partialMessage = event.partial`; `finalMessage = response.result()`) over the
proxy output. The resulting `finalMessage.content` is `[{type:"text",…}]` with no thinking block.

(Console-verified reproduction: provider is invoked twice with `reasoning: "high"` then
`reasoning: undefined`; final persisted `content` = `[ {type:"text", text:"Here is the answer."} ]`;
`content block types = [ "text" ]`; `Reasoning preserved in final message? = false`.)

**Suggested Fix**: The `StreamProxy` must not forward replacement events verbatim. It must
**rewrite** them so the consumer assembles a single unified message:
1. Track the primary's max emitted `contentIndex` (e.g. reasoning at index 0 ⇒ next free index is
   `N`).
2. For every forwarded replacement event, **offset its `contentIndex`** by `N` so the answer text
   lands in a fresh block (index 1 after a single thinking block), never colliding with the
   primary's reasoning.
3. **Rewrite each replacement event's `partial`** to a single proxy-owned accumulating
   `AssistantMessage` that merges the primary's frozen reasoning blocks with the replacement's
   answer blocks — i.e. the proxy builds one canonical `output.content = [...primaryThinking,
   ...replacementAnswer]` and stamps that object as `partial` on every forwarded event and as
   `message` on the synthesized terminal. (The `ReasoningBuffer` snapshot + the frozen primary
   partial already contain what is needed to seed this.)
4. Add an integration test that feeds the proxy output through a faithful copy of the
   `pi-agent-core` agent-loop consumer and asserts the final message content equals
   `[{type:"thinking",…}, {type:"text",…}]`.

---

## Major Issues (Should Fix)

### Issue 2: Shortcut remains active during answer generation — pressing Ctrl+. after reasoning ends aborts the in-progress answer

**Severity**: Major
**PRD Reference**: EC-005 ("Shortcut During thinking_end → Ignore. Reasoning has already
completed."); EC-006 ("Shortcut During First Answer Token → Ignore. The model is already
answering."); RC-002 ("Shortcut vs Answer Start — Winner: Answer start. Reasoning already
complete."); §22.4 ("Reasoning ends upon: thinking_end OR first answer token OR provider
completion"); §22.5 ("The shortcut is active only while: Current State == Reasoning").
**Root cause file**: `src/provider/proxy.ts` (`trackEvent`) and the §16 transition table in
`src/state/controller.ts`.

**Expected Behavior**: Once reasoning has ended (on `thinking_end`, or the first `text_start`/
`toolcall_start` answer token), the shortcut must be **disabled** — pressing Ctrl+. must do
nothing (no abort, no second request). The model is already answering.

**Actual Behavior**: The `TransitionController` has **no transition out of `Reasoning` for normal
completion** (the §16 table only allows `Reasoning → StopRequested` and `Reasoning → Failed`).
`trackEvent` performs no state change on `thinking_end`, `text_start`, or `toolcall_start`. As a
result the FSM stays in `Reasoning` for the **entire answer phase** (confirmed: after
`thinking_end` and `text_start`, `controller.getState()` is still `"Reasoning"`).

Because `canInterrupt()` returns `state === "Reasoning"`, the shortcut stays armed while the
answer is streaming. If the user presses Ctrl+. during the answer:
- `coordinator.requestStop()` → `activeProxy.canInterrupt()` returns **`true`**;
- `triggerStop()` returns **`true`**, aborts the in-progress answer stream, and launches a **new**
  replacement request;
- the partial answer the user was reading is discarded.

The code comments acknowledge the controller is "left in Reasoning" and claim it is "reconciled
when the interruption flow … is the active path" — but no such reconciliation exists, so the
shortcut never disables after reasoning ends. (Console-verified reproduction: after
`start → thinking_* → thinking_end → text_start`, `triggerStop()` returns `true`, upstream is
aborted, and replacement call count becomes 1.)

This also compounds with Issue 1: the re-aborted answer is replaced by another fresh request, and
the reasoning is again dropped.

**Steps to Reproduce**: Construct a `StreamProxy`, drive `start → thinking_start[0] →
thinking_delta[0] → thinking_end → text_start` (answer begins), then call `triggerStop()`. It
returns `true` (should be `false`), the upstream `AbortSignal` is aborted, and a second provider
call is made.

**Suggested Fix**: Disable the shortcut once reasoning has ended. Since §16 defines no normal
`Reasoning → *` exit, the minimal correct fix is to gate `canInterrupt()` on an explicit
"reasoning ended" signal rather than (only) on FSM state:
- In `trackEvent`, set a private `reasoningEnded = true` flag on `thinking_end` **and** on the
  first `text_start` / `toolcall_start` received while in `Reasoning` (PRD §22.4 leave-conditions).
- Make `canInterrupt()` return `state === "Reasoning" && !reasoningEnded`.
- (Cleaner, larger option: extend the FSM to model a normal `Reasoning → Answering` transition on
  the leave-conditions, so §22.5's "Current State == Reasoning" is genuinely true only while
  reasoning is active. Either approach must be reflected in `ALLOWED_TRANSITIONS`/tests.)
- Add tests covering EC-005 and EC-006 end-to-end (press after `thinking_end`; press on first
  answer token) asserting `triggerStop()`/`requestStop()` return `false` and no abort/replacement
  occurs.

---

## Minor Issues (Nice to Fix)

### Issue 3: A single coordinator active-proxy slot can lose shortcut coverage for overlapping streams

**Severity**: Minor
**PRD Reference**: INV-004 (at most one interruption per response); §37 (ownership); EC-013.

**Expected Behavior**: Each active eligible stream is interruptible; terminating one stream must
not disable the shortcut for a still-active concurrent stream.

**Actual Behavior**: `TransitionCoordinator` holds a single `activeProxy` reference. Every proxy's
`_terminate()` calls `this._coordinator?.setActiveProxy(undefined)` unconditionally. If two
eligible z.ai streams ever overlap (e.g. an auto-compaction/summarization `streamSimple` call
running concurrently with the main response), the second `setActiveProxy(B)` overwrites the first,
and when `A` finishes it clears the coordinator (`undefined`) even though `B` is still reasoning —
leaving `B` without shortcut coverage. This is latent because the main agent loop streams
sequentially, but the coordinator has no guard tying the clear to *which* proxy is active.

**Suggested Fix**: Only clear the active proxy if the terminating proxy *is* the currently-active
one (e.g. `if (this._coordinator?.activeProxy === this) setActiveProxy(undefined)`), or key the
coordinator by a per-stream id rather than a single slot. Add a test with two overlapping proxies.

---

## Testing Summary

- **Total tests performed**: ~15 targeted end-to-end reproductions (driving the real `StreamProxy`
  through faithful copies of the `pi-agent-core` agent-loop and `processProxyEvent` consumers) plus
  full re-run of the existing 380-test suite and a source audit of all modules and the captured
  `openai-completions` provider.
- **Passing**: existing suite 380/380; build clean; provider-decoration, FSM legality, abort/race
  handling, failure modes, golden replay, and telemetry all behave as designed.
- **Failing (newly found)**: 2 confirmed defects (1 Critical, 1 Major) + 1 Minor.
  - Issue 1 (Critical): reasoning lost from persisted message on every interruption — reproduced
    deterministically.
  - Issue 2 (Major): shortcut aborts the in-progress answer — reproduced deterministically.
  - Issue 3 (Minor): coordinator single-slot overlap — design analysis.
- **Areas with good coverage**: provider capture/delegation, transition-table legality,
  abort-vs-completion race (FM-005/EC-007), abort/replacement timeouts, idempotency of stop,
  resource cleanup (INV-010), observational equivalence when inactive (golden replay), privacy of
  logging.
- **Areas needing more attention**:
  - **Integration with the real `pi-agent-core` message assembler.** The suite asserts on raw
    forwarded events but never validates the *final assembled/persisted assistant message* through
    the real consumer (`event.partial` following + contentIndex indexing). This is exactly the gap
    that hid Issue 1. Recommend adding a consumer-simulation harness (mirroring `agent-loop.js`)
    used by the replacement/lifecycle/integration tests.
  - **Shortcut-availability after reasoning ends (EC-005/EC-006/RC-002).** No test asserts the
    shortcut is disabled once the answer phase begins; add end-to-end coverage.
  - **Realistic `partial`/`contentIndex` fields in mocks.** The replacement/lifecycle mocks put
    both primary thinking and replacement text at `contentIndex: 0`, which mirrors the real provider
    behavior but masks the collision because no consumer assembles them. Mocks should carry
    realistic `partial` objects and be consumed by a faithful assembler.
