# PRP — P1.M1.T1.S1: Create `consumeLikeAgentLoop` consumer-simulation harness

> **Bugfix**: Stream Integrity & Shortcut Lifecycle. This subtask builds the test infrastructure
> that exposes **Issue 1** (reasoning lost from persisted message). **No production code touched** —
> pure test helper + companion test, in `tests/helpers/`.

---

## Goal

**Feature Goal**: Create a stream-generic consumer-simulation harness that is a **faithful copy of
`@earendil-works/pi-agent-core`'s `agent-loop.js` consumer** — the exact code path that assembles and
persists the assistant message from an `AssistantMessageEventStream`. This harness is the missing
test double that lets Issue 1 (and later Issue 2 / EC tests) assert on the **final assembled message**
instead of raw forwarded events, closing the blind spot that hid the reasoning-loss bug.

**Deliverable**:
- `tests/helpers/consumer-harness.ts` — exports
  `async function consumeLikeAgentLoop(stream): Promise<{ finalMessage; events; partialHistory }>`.
- `tests/helpers/consumer-harness.test.ts` — companion unit test that feeds a hand-built event
  stream (start → thinking → text → done, realistic partials) through the harness and asserts the
  assembled `finalMessage.content` contains **both** a `thinking` and a `text` block.

**Success Definition**: `bun test tests/helpers/consumer-harness.test.ts` passes (harness assembles a
two-block message correctly); `bun test` full suite still green (no regressions — pure addition);
`bun run build` unaffected (tests excluded from build). The harness is then ready for P1.M2.T3.S1.

---

## Why

- **Issue 1 is invisible without this**: The 380-test suite asserts on raw forwarded events but never
  runs `partialMessage = event.partial` → `finalMessage = await response.result()`. Issue 1's bug
  (replacement's fresh `partial` replaces the primary's reasoning → persisted message loses the
  thinking block) is only observable through this exact consumer path. (See selected PRD §Testing
  Summary "Areas needing more attention".)
- **Faithfulness is mandatory**: The harness must mirror `agent-loop.js` **exactly** — it is the
  oracle the fix tests against. Any deviation (e.g. adding contentIndex indexing, deep-cloning,
  skipping `partial` capture) would mask or distort the very bug it exists to catch.
- **Reusable**: Consumed by P1.M2.T3.S1 (Issue 1 e2e integration test) and P1.M3.T2.S1 (EC-005/EC-006
  shortcut-disable tests). Building it first unblocks both.

## What

A single exported async function plus a return interface. It:
1. Iterates the passed `AssistantMessageEventStream` with `for await (const event of stream)`.
2. Records every event into `events`.
3. On every event that carries `event.partial` (i.e. `start` + every non-terminal; **not** `done`/`error`),
   pushes a **shallow copy** into `partialHistory` — mirroring `partialMessage = event.partial`.
4. After the loop, resolves `finalMessage = await stream.result()` (raced with a timeout to fail fast).
5. Returns `{ finalMessage, events, partialHistory }`.

**Deliberately out of scope** (do NOT implement here): contentIndex-indexing (that is the
`proxy.js` `processProxyEvent` path), building mock providers (P1.M1.T1.S2), driving the real
StreamProxy (P1.M2.T3.S1). This harness relies **entirely on `event.partial` following**, exactly
like agent-loop.js.

### Success Criteria

- [ ] `tests/helpers/consumer-harness.ts` exports `consumeLikeAgentLoop` + a typed return interface.
- [ ] The function uses `for await` over the stream (no manual `next()` calls).
- [ ] `partialHistory` captures a **shallow copy** of `event.partial` for `start` + every non-terminal;
      excludes `done`/`error`.
- [ ] `finalMessage` comes from `await stream.result()`, raced with a timeout.
- [ ] Companion `consumer-harness.test.ts` exists and a hand-built two-block stream yields
      `finalMessage.content` with types `["thinking","text"]`.
- [ ] `bun test tests/helpers/consumer-harness.test.ts` passes.
- [ ] `bun test` (full suite) still passes; `bun run build` unaffected.
- [ ] No `src/` (production) files modified.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — the consumer logic is fully inlined below (verbatim from the architecture doc), the exact
pi-ai type signatures are given, the helper/file-naming convention is specified, and the validation
commands are project-verified. No prior knowledge of the proxy/FSM internals is needed (this subtask
touches none of them).

### Documentation & References

```yaml
# MUST READ — the authoritative consumer logic this harness mirrors line-for-line
- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-agent-core-consumer.md
  why: "§1 (lines ~194–249) is the EXACT agent-loop.js consumer: partialMessage = event.partial on
        start + every non-terminal; finalMessage = await response.result()."
  critical: "done/error carry message/error, NOT partial. finalMessage === the terminal event's
             message field. Mirror this EXACTLY — do not add contentIndex indexing (that is the
             proxy.js path, a DIFFERENT consumer)."

- file: plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-ai-event-types.md
  why: "§1 gives the AssistantMessageEvent discriminated-union field table (which events carry
        partial vs message/error). §3 gives EventStream.push/result() semantics."
  critical: "partial is the provider's LIVE mutating output reference (same object across all events
             of one stream). The real consumer keeps only the LAST partialMessage; the harness keeps
             HISTORY → MUST shallow-copy each entry."

# PATTERN files to follow (existing test conventions)
- file: tests/helpers/invariant-harness.ts
  why: "Template for a tests/helpers/ pure helper (non-*.test.ts so bun discovery skips it).
        Shows: export interface for return shape; the collectOutput() helper already does the
        for-await + Promise.race(result(), timeout) pattern (3000ms) — adapt it to be stream-generic
        and to additionally capture finalMessage + partialHistory."
  pattern: "Header JSDoc block describing responsibility + invariant mapping; exported function +
            exported interface; helper imported by *.test.ts files."
  gotcha: "Do NOT name this file *.test.ts (it must NOT be auto-run as a standalone test) — but the
           unit test MUST be a *.test.ts companion or bun won't discover it."

- file: tests/golden/replay.ts
  why: "Shows how to hand-build a real stream: createAssistantMessageEventStream() then stream.push(e)
        for each event; the terminal push completes the stream in-place. (replay.ts lines ~106–123)"
  pattern: "const stream = createAssistantMessageEventStream(); for (const e of events) stream.push(e);"

- file: tests/golden/fixtures.ts
  why: "Realistic event shapes for the unit test: start (partial only), thinking_*[0] (contentIndex 0,
        delta/content, partial), text_*[1] (contentIndex 1, …), done (reason + message)."
  pattern: "Each non-terminal event carries a `partial: AssistantMessage`; done carries `message`."

# VERIFIED type signatures (local node_modules, not global)
- note: "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts:
          AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage>;
          methods: [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>, result(): Promise<AssistantMessage>,
          push(event), end(result?). Factory: createAssistantMessageEventStream(): AssistantMessageEventStream.
          All re-exported from @earendil-works/pi-ai ROOT (confirmed: src/provider/proxy.ts imports them from root)."
```

### Current Codebase tree (relevant slice)

```bash
tests/
├── helpers/
│   ├── invariant-harness.ts     # ← PATTERN: pure helper (non-*.test.ts), exports + interface
│   └── (consumer-harness.ts)    # ← NEW (this subtask)
│   └── (consumer-harness.test.ts)# ← NEW (companion unit test)
├── golden/
│   ├── fixtures.ts              # ← realistic event shapes (reference for unit-test partials)
│   └── replay.ts                # ← PATTERN: hand-build a stream via createAssistantMessageEventStream + push
└── *.test.ts                    # 380 existing tests (raw-event assertions; the blind spot)
src/                             # UNCHANGED — do not modify
```

### Desired Codebase tree with file responsibilities

```bash
tests/helpers/
├── consumer-harness.ts          # NEW — exports consumeLikeAgentLoop + ConsumeResult interface.
│                                  # Pure helper (no test() calls). Mirrors agent-loop.js exactly.
└── consumer-harness.test.ts     # NEW — companion bun:test. Hand-builds a start+thinking+text+done
                                   # stream and asserts finalMessage.content has both blocks.
```

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (faithfulness): `partial` is the provider's LIVE mutating `output` reference, mutated
// in place across all events of ONE stream (bugfix pi-ai-event-types.md §1). The real consumer
// keeps only the LAST partialMessage, so it never copies. The harness keeps HISTORY → it MUST
// shallow-copy (`{ ...event.partial }`) or every entry collapses to the final reference.
// NOTE: shallow copy shares the `.content` array reference (fine — primary vs replacement are
// DIFFERENT output objects per provider call, which is exactly the signal that surfaces Issue 1).

// CRITICAL (done/error have NO `partial`): AssistantMessageEvent's `done` carries `message`,
// `error` carries `error`. Both carry NO `partial`. So partialHistory capture must EXCLUDE them.
// Guard: `if (event.type !== "done" && event.type !== "error")` (also gives TS the narrowing needed
// to access `event.partial` without a cast).

// GOTCHA (bun test discovery): `bun test` only runs files matching *.test.{ts,...} / *.spec.*.
// A helper named consumer-harness.ts is NOT run. So the unit test MUST be a companion *.test.ts.
// Do NOT put `test()` inside consumer-harness.ts — it would silently never execute.

// GOTCHA (tsconfig excludes tests): the project's `tsc --noEmit` / `bun run build` EXCLUDE tests/
// (`"exclude": [..., "tests"]`). So type errors in the helper won't fail the build — only `bun test`
// (which strips types) runs it. For real type-assurance, run the self-contained one-off tsc command
// in Validation Level 1.

// GOTCHA (result() after the loop): once `for await` exits, the terminal has already been pushed,
// so `stream.result()` is already resolved — the await is effectively instant. The timeout race is
// belt-and-suspenders (fail fast if the stream is malformed and never produced a terminal).

// SCOPE: do NOT add contentIndex indexing, deep cloning, or mock-provider building here. Those are
// the proxy.js path (Issue 1 fix, P1.M2) and P1.M1.T1.S2 respectively.
```

---

## Implementation Blueprint

### Data models and structure

No runtime data models — the harness only **reads** the stream. Define one exported interface for the
return shape (mirrors the agent-loop consumer's observable state: streaming partial + final message):

```typescript
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export interface ConsumeResult {
  /** The persisted message — `await stream.result()`, i.e. the terminal event's message/error field. */
  finalMessage: AssistantMessage;
  /** Every event observed, in order (raw forwarded stream). */
  events: AssistantMessageEvent[];
  /** Shallow-copied `event.partial` at each start/non-terminal step — the streaming `partialMessage`
   *  history (mirrors `partialMessage = event.partial`). */
  partialHistory: AssistantMessage[];
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE tests/helpers/consumer-harness.ts  (pure helper — NO *.test.ts suffix)
  - IMPLEMENT: `export async function consumeLikeAgentLoop(stream): Promise<ConsumeResult>`
      matching agent-loop.js EXACTLY (see Implementation Patterns below).
  - FOLLOW pattern: tests/helpers/invariant-harness.ts (header JSDoc, exported fn + interface,
    non-test filename). Adapt the collectOutput() Promise.race(result(), timeout) idiom (3000ms→5000ms).
  - IMPORTS: `import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream }
      from "@earendil-works/pi-ai";` (type-only — the helper never constructs a stream).
  - LOGIC (verbatim mirror):
      1. const events: AssistantMessageEvent[] = [];
      2. const partialHistory: AssistantMessage[] = [];
      3. for await (const event of stream) {
           events.push(event);
           if (event.type !== "done" && event.type !== "error") {
             partialHistory.push({ ...event.partial }); // shallow copy — see gotcha
           }
         }
      4. let timer; try {
           const finalMessage = await Promise.race([
             stream.result(),
             new Promise<never>((_, reject) => { timer = setTimeout(
               () => reject(new Error("consumeLikeAgentLoop: stream.result() timed out")), 5000); }),
           ]);
           return { finalMessage, events, partialHistory };
         } finally { if (timer) clearTimeout(timer); }
  - NAMING: consumeLikeAgentLoop (export), ConsumeResult (interface).
  - CRITICAL: NO contentIndex logic, NO deep clone, NO mock provider, NO test() calls in this file.
  - PLACEMENT: tests/helpers/consumer-harness.ts.

Task 2: CREATE tests/helpers/consumer-harness.test.ts  (companion unit test — bun discovers this)
  - IMPLEMENT: a bun:test that hand-builds a real AssistantMessageEventStream of
      start → thinking_start[0] → thinking_delta[0] → thinking_end[0] →
      text_start[1] → text_delta[1] → text_end[1] → done(reason:"stop")
      where each non-terminal `partial` is a realistic accumulating AssistantMessage and the
      `done.message.content` contains BOTH a thinking block and a text block.
  - FOLLOW pattern:
      - tests/golden/replay.ts (build a stream: createAssistantMessageEventStream() + push each event).
      - tests/golden/fixtures.ts (event field shapes; partials).
  - IMPORTS: `import { test, expect } from "bun:test";`
      `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";`
      `import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";`
      `import { consumeLikeAgentLoop } from "./consumer-harness";`
  - ASSERTIONS (proves the harness assembles correctly):
      - const { finalMessage, events, partialHistory } = await consumeLikeAgentLoop(stream);
      - expect(events).toHaveLength(8);                       // all events recorded
      - expect(partialHistory).toHaveLength(7);               // 8 events minus the `done` terminal
      - expect(finalMessage.content.map(b => b.type)).toEqual(["thinking", "text"]);  // ← BOTH blocks
      - expect(finalMessage.content[0]).toMatchObject({ type:"thinking", thinking:"Let me reason." });
      - expect(finalMessage.content[1]).toMatchObject({ type:"text", text:"Here is the answer." });
  - HELPER (in-file): a small `msg(content)` builder casting to AssistantMessage
      (reuse the invariant-harness `as unknown as AssistantMessage` idiom for ContentBlock/usage fields).
  - COVERAGE: happy two-block assembly. (Edge cases — error terminal, empty content — are exercised
      by downstream tests P1.M2.T3.S1 / P1.M3.T2.S1 that consume this harness.)
  - NAMING: test("consumeLikeAgentLoop assembles finalMessage with both thinking and text blocks", ...).
  - PLACEMENT: tests/helpers/consumer-harness.test.ts.
```

### Implementation Patterns & Key Details

```typescript
// tests/helpers/consumer-harness.ts — faithful copy of agent-loop.js (bugfix pi-agent-core-consumer.md §1)
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export interface ConsumeResult {
  finalMessage: AssistantMessage;
  events: AssistantMessageEvent[];
  partialHistory: AssistantMessage[];
}

const RESULT_TIMEOUT_MS = 5000;

/**
 * Consume an AssistantMessageEventStream EXACTLY like @earendil-works/pi-agent-core's agent-loop.js:
 *   - `partialMessage = event.partial` on `start` and EVERY non-terminal event (recorded as a
 *     shallow copy into `partialHistory` because we keep history, unlike the consumer's single slot);
 *   - `finalMessage = await response.result()` (resolves to the terminal's `message`/`error`).
 *
 * Does NOT index by `contentIndex` (that is the proxy.js processProxyEvent path — a different
 * consumer). This harness relies purely on `event.partial` following, exactly like agent-loop.js.
 *
 * Consumed by P1.M2.T3.S1 (Issue 1 integration test) and P1.M3.T2.S1 (EC-005/EC-006).
 */
export async function consumeLikeAgentLoop(
  stream: AssistantMessageEventStream,
): Promise<ConsumeResult> {
  const events: AssistantMessageEvent[] = [];
  const partialHistory: AssistantMessage[] = [];

  for await (const event of stream) {
    events.push(event);
    // done/error carry `message`/`error` (NOT `partial`); the narrowing also satisfies TS.
    if (event.type !== "done" && event.type !== "error") {
      partialHistory.push({ ...event.partial }); // shallow copy — `partial` is a LIVE ref
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finalMessage = await Promise.race([
      stream.result(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("consumeLikeAgentLoop: stream.result() timed out")),
          RESULT_TIMEOUT_MS,
        );
      }),
    ]);
    return { finalMessage, events, partialHistory };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

```typescript
// tests/helpers/consumer-harness.test.ts — companion unit test proving the harness assembles correctly
import { test, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { consumeLikeAgentLoop } from "./consumer-harness";

const msg = (content: AssistantMessage["content"]): AssistantMessage =>
  ({
    role: "assistant", content,
    model: "glm-4.7", api: "openai-completions", provider: "zai",
    usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop", timestamp: 0,
  }) as AssistantMessage;

test("consumeLikeAgentLoop assembles finalMessage with both thinking and text blocks", async () => {
  const thinking = { type: "thinking", thinking: "Let me reason." };
  const text = { type: "text", text: "Here is the answer." };
  const stream = createAssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [
    { type: "start",                  partial: msg([{ ...thinking }]) },
    { type: "thinking_start", contentIndex: 0, partial: msg([{ ...thinking }]) },
    { type: "thinking_delta", contentIndex: 0, delta: "Let me reason.", partial: msg([{ ...thinking }]) },
    { type: "thinking_end",   contentIndex: 0, content: "Let me reason.", partial: msg([{ ...thinking }]) },
    { type: "text_start", contentIndex: 1, partial: msg([{ ...thinking }, { type: "text", text: "" }]) },
    { type: "text_delta", contentIndex: 1, delta: "Here is the answer.", partial: msg([{ ...thinking }, { ...text }]) },
    { type: "text_end",   contentIndex: 1, content: "Here is the answer.", partial: msg([{ ...thinking }, { ...text }]) },
    { type: "done", reason: "stop", message: msg([{ ...thinking }, { ...text }]) },
  ] as unknown as AssistantMessageEvent[];
  for (const e of events) (stream as { push: (e: unknown) => void }).push(e);

  const { finalMessage, events: out, partialHistory } = await consumeLikeAgentLoop(stream);

  expect(out).toHaveLength(8);
  expect(partialHistory).toHaveLength(7); // 8 events minus the `done` terminal
  expect(finalMessage.content.map((b) => b.type)).toEqual(["thinking", "text"]); // ← BOTH blocks preserved
  expect(finalMessage.content[0]).toMatchObject({ type: "thinking", thinking: "Let me reason." });
  expect(finalMessage.content[1]).toMatchObject({ type: "text", text: "Here is the answer." });
});
```
> The casts (`as unknown as AssistantMessageEvent[]`) match the existing invariant-harness/`ev`
> helper idiom for synthetic events; `stream.push` is typed via the `EventStream` class so a direct
> `stream.push(e)` also works if you type the array as `AssistantMessageEvent[]` cleanly.

### Integration Points

```yaml
TEST INFRASTRUCTURE (no production changes):
  - add file: tests/helpers/consumer-harness.ts        # export consumeLikeAgentLoop + ConsumeResult
  - add file: tests/helpers/consumer-harness.test.ts   # companion unit test
  - consumers (later subtasks, do NOT wire now):
      P1.M2.T3.S1: import { consumeLikeAgentLoop } from "../helpers/consumer-harness";
                   drive a real StreamProxy.output through it; assert finalMessage.content === [thinking,text].
      P1.M3.T2.S1: reuse for EC-005/EC-006 shortcut-disabled assertions.

BUILD/CONFIG: NONE. tsconfig.json already excludes tests/ (helper not compiled into dist). The
  `bun test` runner discovers *.test.ts automatically under tests/. No package.json changes.

PRODUCTION CODE: NONE touched. `git diff --stat src/` must be empty after this subtask.
```

---

## Validation Loop

### Level 1: Syntax & Type (Immediate Feedback)

```bash
# Run the new companion test in isolation (primary gate — proves harness assembles correctly):
bun test tests/helpers/consumer-harness.test.ts
# Expected: 1 passing. finalMessage.content types === ["thinking","text"]; events=8; partialHistory=7.

# Type-assurance of the helper (tsconfig excludes tests, so do a self-contained one-off):
bunx tsc --noEmit --strict --module ES2022 --moduleResolution bundler --target ES2022 \
  --skipLibCheck --lib ES2022 --types bun \
  tests/helpers/consumer-harness.ts tests/helpers/consumer-harness.test.ts
# Expected: zero diagnostics. (If "Cannot find module @earendil-works/pi-ai" → you're not at project
#   root, or node_modules is missing; run `npm install` first.)

# Sanity: the production build is unaffected (tests excluded from tsconfig):
bun run build && echo "build OK"
# Expected: "build OK"; no new files under dist/.
```

### Level 2: Unit / Component Validation

```bash
# Full test suite — confirms pure addition, no regressions, and that the new test is discovered:
bun test
# Expected: previous total (380) + 1 new = 381 passing, 0 failing. No existing test imports changed.
```

### Level 3: Integration (Consumer Contract)

```bash
# Prove the harness is stream-generic by consuming a freshly built pi-ai stream directly (this is
# what the unit test already does; here we assert it is reusable for any AssistantMessageEventStream).
# The unit test above IS the Level 3 contract proof: a hand-built stream assembles to [thinking,text].

# Confirm NO production code was modified:
git diff --stat -- src/ | tail -1   # Expected: empty (no output)
git status --short -- tests/helpers/ # Expected: two new untracked files only
```

### Level 4: Domain-Specific Validation (Faithfulness Audit)

```bash
# Audit the harness against the authoritative consumer (bugfix pi-agent-core-consumer.md §1).
# Each agent-loop.js behavior must be present:
grep -n "for await"   tests/helpers/consumer-harness.ts   # → the consumer loop exists
grep -n "stream.result()" tests/helpers/consumer-harness.ts  # → finalMessage = await response.result()
grep -n "\.\.\.event.partial" tests/helpers/consumer-harness.ts  # → shallow-copy partial capture
grep -n "contentIndex" tests/helpers/consumer-harness.ts    # Expected: ZERO matches (no indexing — scope guard)
grep -n "createAssistantMessageEventStream" tests/helpers/consumer-harness.ts  # Expected: ZERO (helper doesn't build streams)
# The companion test, conversely, MUST build a stream:
grep -n "createAssistantMessageEventStream" tests/helpers/consumer-harness.test.ts  # Expected: ≥1 match
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `bun test tests/helpers/consumer-harness.test.ts` passes (1 test).
- [ ] `bunx tsc --noEmit …` (self-contained, Level 1) → zero diagnostics.
- [ ] `bun test` full suite green (381 pass / 0 fail).
- [ ] `bun run build` unaffected (no new dist files; production untouched).

### Feature Validation
- [ ] `consumeLikeAgentLoop` exported from `tests/helpers/consumer-harness.ts`.
- [ ] Returns `{ finalMessage, events, partialHistory }` matching `ConsumeResult`.
- [ ] `partialHistory` = shallow-copied `event.partial` for start + every non-terminal (excludes done/error).
- [ ] `finalMessage` = `await stream.result()` (with timeout race).
- [ ] Unit test asserts `finalMessage.content` types === `["thinking","text"]` (both blocks preserved).
- [ ] Harness contains NO contentIndex indexing (scope guard).

### Code Quality & Documentation
- [ ] Helper is a non-`*.test.ts` file (not auto-run); unit test is a `*.test.ts` companion (discovered).
- [ ] Header JSDoc explains it mirrors agent-loop.js and names downstream consumers (P1.M2.T3.S1, P1.M3.T2.S1).
- [ ] Follows existing `tests/helpers/invariant-harness.ts` conventions (exported interface, casts idiom).
- [ ] No `src/` files modified (`git diff --stat -- src/` empty).

---

## Anti-Patterns to Avoid

- ❌ Don't add **contentIndex indexing** — that's the `proxy.js` `processProxyEvent` path, a *different*
  consumer. This harness relies purely on `event.partial` following, exactly like agent-loop.js.
- ❌ Don't store the **raw `event.partial` reference** — it's a live mutating object; shallow-copy it
  (`{ ...event.partial }`) or partialHistory collapses to the final state.
- ❌ Don't put the unit test **inside `consumer-harness.ts`** — bun only discovers `*.test.ts` files;
  it would silently never run. Use a companion `.test.ts`.
- ❌ Don't capture `partial` for `done`/`error` — they carry `message`/`error`, not `partial`.
- ❌ Don't build a mock provider here (that's P1.M1.T1.S2) or drive the real StreamProxy here
  (that's P1.M2.T3.S1). The harness takes *any* `AssistantMessageEventStream`.
- ❌ Don't skip the `stream.result()` **timeout race** — malformed streams must fail fast, not hang CI.
- ❌ Don't modify any `src/` (production) file — this is test infrastructure only.

---

## Confidence Score: **9/10**

The deliverable is small and fully specified: the authoritative consumer logic is inlined verbatim,
the pi-ai type signatures are verified against the local `node_modules`, the helper/test file-naming
convention is pinned to the existing `invariant-harness.ts`/`*.test.ts` pattern, and the validation
commands (`bun test`, self-contained `tsc`) are project-verified. Residual risk is only in exact
ContentBlock field typing in the synthetic unit-test events (handled with the established `as` cast
idiom), which does not affect the harness logic itself.
