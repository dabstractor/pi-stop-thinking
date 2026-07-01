# Research Notes — P1.M1.T1.S1 (consumeLikeAgentLoop consumer-simulation harness)

## Source of truth for the consumer logic
`plan/001_b0c6691bb424/bugfix/001_05591a24a0d0/architecture/pi-agent-core-consumer.md` §1 is
AUTHORITATIVE (mirrors `agent-loop.js` lines ~194–249):

```js
let partialMessage = null;
for await (const event of response) {
  switch (event.type) {
    case "start": partialMessage = event.partial; break;
    case "text_start": case "text_delta": /* …non-terminals… */ case "toolcall_start":
      if (partialMessage) { partialMessage = event.partial; }   // EVERY non-terminal REPLACES
      break;
    case "done": case "error": {
      const finalMessage = await response.result();   // resolves to terminal.message / .error
      return finalMessage;                            // ← persisted message
    }
  }
}
```
Takeaways: (1) `partialMessage = event.partial` on `start` + every non-terminal; (2)
`finalMessage = await response.result()` → the terminal event's `message` (done) / `error` (error);
(3) done/error do NOT carry `partial` (they carry `message`/`error`).

## Verified pi-ai types (LOCAL node_modules — not the global install)
`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts`:
```ts
class EventStream<T, R = T> implements AsyncIterable<T> {
  push(event: T): void;
  end(result?: R): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
  result(): Promise<R>;
}
class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {}
declare function createAssistantMessageEventStream(): AssistantMessageEventStream;
```
- All three (`AssistantMessageEventStream`, `AssistantMessage`, `AssistantMessageEvent`) + the
  factory are re-exported from `@earendil-works/pi-ai` ROOT (verified: `src/provider/proxy.ts`
  imports `createAssistantMessageEventStream` from the root; `proxy.ts:56` imports the
  `AssistantMessageEventStream` type from the root).
- `AssistantMessageEvent` is a discriminated union; non-terminal variants carry
  `contentIndex: number` + `partial: AssistantMessage`; `done` carries `reason`+`message`,
  `error` carries `reason`+`error` (NO `partial`). (Source: bugfix `pi-ai-event-types.md` §1.)

## Existing helper convention to follow
`tests/helpers/invariant-harness.ts` is the template:
- Filename has NO `.test.ts` suffix → bun's test discovery does NOT run it as a test; it is a pure
  helper imported by the *.test.ts files. **My `consumer-harness.ts` must follow this.**
- Exports functions + an interface for the return shape.
- The existing `collectOutput(proxy)` already does the `for await` + `Promise.race(result(), timeout)`
  pattern (3000 ms timeout) — but it drains `proxy.output` and only returns events. My harness is
  STREAM-generic (takes any `AssistantMessageEventStream`) and additionally captures
  `finalMessage` + `partialHistory`.

## Bun test-discovery gotcha (drives file split)
`bun test` default matches `*.test.{ts,tsx,js,...}` / `*.spec.*`. A file named `consumer-harness.ts`
will NOT be discovered. Therefore the unit test required by the contract MUST live in a companion
`consumer-harness.test.ts` (importing `consumeLikeAgentLoop`). Putting `test(...)` inside the
helper `.ts` would silently never run.

## CRITICAL: `partial` is a LIVE reference → must shallow-copy into partialHistory
From bugfix `pi-ai-event-types.md` §1: "partial is the provider's OWN accumulating output object
(same reference mutated in place across all events in a single stream). It is a LIVE reference, not
a snapshot." The real consumer keeps only the LAST `partialMessage`, so it never notices. But the
harness keeps HISTORY, so it must shallow-copy (`{ ...event.partial }`) — otherwise every entry is
the same final reference. Shallow copy is what the contract specifies; it correctly distinguishes
the primary vs replacement `output` objects (different references per provider call — this is exactly
the signal that surfaces Issue 1).

## tsconfig excludes tests → validation is `bun test`, not `tsc`
`tsconfig.json` has `"exclude": ["node_modules", "dist", "tests"]` and the `typecheck` script is
`tsc --noEmit`. So the harness is NOT type-checked by the project's typecheck/build (only by bun's
type-stripping at runtime). Primary gate = `bun test` (executes + asserts). For real type-assurance
of the helper, use a self-contained one-off: `bunx tsc --noEmit --strict --module ES2022
--moduleResolution bundler --target ES2022 --skipLibCheck --lib ES2022 --types bun
tests/helpers/consumer-harness.ts tests/helpers/consumer-harness.test.ts`.

## How to hand-build a stream for the unit test (existing pattern)
`tests/golden/replay.ts` builds a pre-filled real stream:
```ts
const stream = createAssistantMessageEventStream();
for (const e of events) stream.push(e);   // terminal push completes the stream in-place
```
`tests/golden/fixtures.ts` shows realistic event shapes: start (partial only), thinking_*[0]
(contentIndex 0, delta/content, partial), text_*[1] (contentIndex 1, …), done (reason+message).
The unit test builds start+thinking[0]+text[1]+done where the `done.message.content` carries BOTH a
thinking and a text block → asserts `finalMessage.content` types === `["thinking","text"]`, proving
the harness assembly path (`result()` → done.message) works.

## Scope boundaries (NOT this subtask)
- Two-call mock PROVIDER with accumulating partials → P1.M1.T1.S2 (this harness consumes any stream;
  does not build providers).
- contentIndex indexing logic → the proxy.js `processProxyEvent` path (Issue 1 fix in P1.M2). The
  harness deliberately does NOT index by contentIndex (it relies purely on `event.partial` following,
  exactly like agent-loop.js).
- Driving the real StreamProxy through the harness → P1.M2.T3.S1 (the Issue 1 integration test).
- EC-005/EC-006 reuse → P1.M3.T2.S1.
- No production code touched (tests/helpers only).
