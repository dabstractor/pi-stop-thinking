# pi-agent-core Consumer Assembly Logic

> **Purpose:** This is the authoritative reference for HOW the real downstream consumer
> (`@earendil-works/pi-agent-core`) assembles and persists the final `AssistantMessage` from
> a stream of `AssistantMessageEvent`s. Issue 1's bug is invisible unless you understand this
> logic — the existing test suite asserts on raw forwarded events but never runs this consumer.
>
> **Source files (read-only):**
> - `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`
> - `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/proxy.js`

---

## 1. The LOCAL consumer: `agent-loop.js` (lines ~194–249)

This is the PRIMARY consumer for a local Pi extension. The extension's `StreamProxy.output`
is the `response` iterable below.

```js
let partialMessage = null;
let addedPartial = false;
for await (const event of response) {
  switch (event.type) {
    case "start":
      partialMessage = event.partial;           // ← the START event's partial seeds the message
      context.messages.push(partialMessage);
      addedPartial = true;
      break;
    case "text_start": case "text_delta": /* ... */
    case "thinking_start": case "thinking_delta": /* ... */
    case "toolcall_start": /* ... */
      if (partialMessage) {
        partialMessage = event.partial;         // ← EVERY non-terminal event REPLACES partialMessage
        context.messages[last] = partialMessage;
      }
      break;
    case "done":
    case "error": {
      const finalMessage = await response.result();  // ← the terminal's message field
      context.messages[last] = finalMessage;
      return finalMessage;                      // ← THIS is what gets persisted
    }
  }
}
```

### Critical takeaways

1. **`partialMessage = event.partial` on EVERY event.** The LAST event's `partial` wins for the
   streaming/in-memory view. If a replacement event carries a `partial` that omits the primary's
   reasoning, the reasoning vanishes from the streaming view the instant the replacement events arrive.

2. **`finalMessage = response.result()`.** `result()` resolves to the `message` field of the `done`
   event (or `error` field of the `error` event). So the PERSISTED message = the `done` event's
   `message`. If the proxy forwards the replacement's `done` verbatim, `message` = the replacement's
   fresh `output` (content: `[text]` only) → reasoning lost from history.

3. **The proxy currently forwards replacement events VERBATIM.** The replacement is a fresh z.ai
   request whose `output.content` starts at `[]` and accumulates only answer text. Its `done.message`
   is that text-only output. The proxy passes it through unchanged → both the streaming partial and
   the persisted final message lose the reasoning.

---

## 2. The REMOTE consumer: `proxy.js` `processProxyEvent` (lines ~55–260)

Used when the extension's output is consumed via a remote/streaming proxy server. The server
**strips the `partial` field** from delta events to reduce bandwidth; the client **reconstructs**
the partial message from `contentIndex`.

```js
function processProxyEvent(proxyEvent, partial) {
  switch (proxyEvent.type) {
    case "text_start":
      partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
      return { ... contentIndex: proxyEvent.contentIndex, partial };
    case "text_delta": {
      const content = partial.content[proxyEvent.contentIndex];   // ← indexes by contentIndex
      content.text += proxyEvent.delta;
      ...
    }
    case "thinking_start":
      partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      ...
    // ... etc
  }
}
```

### Critical takeaway

`partial.content[contentIndex]` — the consumer indexes content blocks **by `contentIndex`**. If the
replacement's `text_start` lands at `contentIndex: 0` (same as the primary's `thinking` block), it
**OVERWRITES** the thinking block at index 0. The fix must OFFSET the replacement's `contentIndex`
by the primary's content-block count so the answer lands in a fresh slot.

---

## 3. Provider behavior that creates the collision (`openai-completions.js`)

The z.ai provider (`streamOpenAICompletions`) builds ONE accumulating `output` object per request:

```js
const output = { role: "assistant", content: [], ... };
const blocks = output.content;
const getContentIndex = (block) => blocks.indexOf(block);
```

- **With reasoning ON** (primary call, `reasoning: "high"`): pushes a `thinking` block first → it lives
  at `content[0]`. All thinking events carry `contentIndex: 0` and `partial: output`.
- **With reasoning OFF** (replacement call, `reasoning: undefined`): NO thinking block; the text block
  is the first/only block → it lives at `content[0]`. All text events carry `contentIndex: 0` and
  `partial: output`.

Both primary and replacement use `contentIndex: 0` for their respective (different) first block.
When the proxy forwards both verbatim, the consumer sees `thinking_*[0]` then `text_*[0]` — a collision.

The terminal: `stream.push({ type: "done", reason: output.stopReason, message: output })`.

---

## 4. Why the existing 380-test suite misses this

Every existing test asserts on the **raw forwarded events** (e.g. "the proxy emitted a `text_start`
at contentIndex 0"). None of them run `partialMessage = event.partial` or `response.result()` →
`done.message` through a faithful consumer. So the collision (two blocks at index 0) and the
partial-switching (fresh partial replaces reasoning) are never observed. **The fix MUST add a
consumer-simulation harness** (mirroring agent-loop.js) and drive the proxy output through it.
