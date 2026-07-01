# Research: `AssistantMessageEventStream` internals (forward-only proxy)

> Source of truth: `node_modules/@earendil-works/pi-ai@0.74.2/dist/utils/event-stream.js`
> (and `.d.ts`). This file is the single most important reference for P1.M2.T2.S1 because the
> `StreamProxy` forwards events into a stream of this exact class.

## 1. Class hierarchy & factory

```typescript
// dist/utils/event-stream.d.ts
export class EventStream<T, R = T> implements AsyncIterable<T> {
  push(event: T): void;
  end(result?: R): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
  result(): Promise<R>;
}
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {}
export function createAssistantMessageEventStream(): AssistantMessageEventStream;
```

**Export path:** the package root re-exports it — `node_modules/@earendil-works/pi-ai/dist/index.d.ts`
line 26 `export * from "./utils/event-stream.js"`. So in app code:

```typescript
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";          // value
import type { AssistantMessageEventStream, AssistantMessageEvent } from "@earendil-works/pi-ai"; // type
```

## 2. `EventStream` runtime behaviour (from the compiled `.js`)

```js
push(event) {
  if (this.done) return;                 // (a) no-op once a complete event was seen
  if (this.isComplete(event)) {          // (b) AssistantMessageEventStream: type==="done"||"error"
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));  // resolves result() with .message / .error
  }
  const waiter = this.waiting.shift();   // (c) deliver to a waiting consumer
  if (waiter) waiter({ value: event, done: false });
  else this.queue.push(event);           // (d) …or enqueue
}

end(result) {
  this.done = true;
  if (result !== undefined) this.resolveFinalResult(result);
  while (this.waiting.length) this.waiting.shift()({ value: undefined, done: true });
}

async *[Symbol.asyncIterator]() {
  while (true) {
    if (this.queue.length) yield this.queue.shift();   // drain buffered events
    else if (this.done) return;                        // nothing left + complete → STOP
    else { const r = await new Promise(res => this.waiting.push(res)); if (r.done) return; yield r.value; }
  }
}
```

### What this means for the forward-only proxy

The proxy loops `for await (const event of upstream) output.push(event)`. When the upstream emits
its terminal `done`/`error` event:

1. The proxy's `for await` **yields** that terminal event (it is delivered to the iterator, NOT
   swallowed).
2. The proxy calls `output.push(terminalEvent)` → `output.isComplete` is true → **`output.done` is
   set to `true` AND `output.result()` resolves** with the carried `AssistantMessage` — in the same
   `push` call.
3. The upstream iterator's **next** `next()` sees `done===true` → returns `{done:true}` → the
   proxy's `for await` loop **exits naturally**.

**Consequence (contract-critical): the proxy MUST NOT call `output.end()` after forwarding the
terminal event.** A terminal `push` already completes the stream. Calling `end()` is unnecessary and
harmless (it re-sets `done=true`, resolves nothing new because the result promise is already
settled), but the contract's intent ("the terminal event has already been pushed; the loop exits
naturally") is satisfied purely by `push`. **Pure forwarding + natural exit = byte-identical output.**

## 3. `push` after completion is a silent no-op

`if (this.done) return;` at the top of `push`. So a defensive double-push of a terminal event
(e.g. forwarding the upstream `done` AND then trying to push a synthesized `error` in a catch) is
safe: the second `push` is dropped. This is what lets the proxy's safety net push a synthesized
`error` in a catch handler without risk of emitting a duplicate terminal in the normal path — the
normal path's real terminal has already flipped `done=true`.

## 4. The "hung downstream" risk (why a try/catch safety net exists)

`output.result()` (which Pi's agent loop awaits) resolves ONLY when:
- a `done`/`error` event is `push`-ed, OR
- `end(result)` is called with a non-undefined result.

If `run()` ever throws WITHOUT having pushed a terminal (e.g. `upstreamStreamFn(...)` throws
synchronously, or the upstream iterator throws), and nothing catches it, `result()` **never
resolves** → Pi hangs. The forward-only proxy wraps the loop in `try/catch`; on throw it pushes a
synthesized `{ type:"error", reason:"error", error: <minimal AssistantMessage> }` so the
downstream still terminates with exactly one terminal + one result (PRD §13.2 single-output
invariant). Because `push` is a no-op once `done`, this catch is **transparent in the normal path**
(it never fires when the upstream emits its own terminal).

## 5. Required type imports & shapes

```typescript
// types.d.ts
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: Provider; model: string;
  responseModel?: string; responseId?: string; diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage; stopReason: StopReason; errorMessage?: string; timestamp: number;
}
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; };
}
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export interface Model<TApi extends Api> { id: string; name: string; api: TApi; provider: Provider; ... }

// api-registry.d.ts
export type ApiStreamSimpleFunction =
  (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
```

`ApiStreamSimpleFunction` is the exact type of `original.streamSimple` captured in
`src/provider/decorator.ts` — the real upstream the proxy wraps in production (P1.M2.T3.S1).

## 6. Mocking strategy (from the item MOCKING spec)

> "create a mock `upstreamStreamFn` that returns a manually-controlled `AssistantMessageEventStream`.
> Push events to the mock and verify they appear on the proxy output in the same order."

Because `createAssistantMessageEventStream()` is a real, self-contained async-iterable, the test
uses IT as the mock upstream:

```typescript
const mockUpstream = createAssistantMessageEventStream();
const proxy = new StreamProxy(model, ctx, opts, () => mockUpstream, diag);
const seen: AssistantMessageEvent[] = [];
(async () => { for await (const e of proxy.output) seen.push(e); })();
mockUpstream.push(ev1); mockUpstream.push(ev2); mockUpstream.push(doneEv); // doneEv completes it
// await a tick; assert seen === [ev1, ev2, doneEv] and await proxy.output.result() resolves.
```

This is an integration-style unit test against the REAL `AssistantMessageEventStream` — strongest
possible guarantee that forwarding is byte-identical.
