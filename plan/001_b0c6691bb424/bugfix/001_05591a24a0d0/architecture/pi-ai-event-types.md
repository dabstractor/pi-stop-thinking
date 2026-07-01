# pi-ai Event & Message Type Reference

> **Purpose:** Exact field shapes for `AssistantMessageEvent` and `AssistantMessage`, and the
> `EventStream` semantics that the Issue 1 rewrite must respect.

---

## 1. `AssistantMessageEvent` (discriminated union)

Source: `node_modules/@earendil-works/pi-ai/dist/types.d.ts` lines ~244–294.

Every non-terminal event carries **`contentIndex: number`** and **`partial: AssistantMessage`**:

| type             | extra fields                        | has `partial`? | has `contentIndex`? |
|------------------|-------------------------------------|----------------|---------------------|
| `start`          | —                                   | YES            | NO                  |
| `text_start`     | —                                   | YES            | YES                 |
| `text_delta`     | `delta: string`                     | YES            | YES                 |
| `text_end`       | `content: string`                   | YES            | YES                 |
| `thinking_start` | —                                   | YES            | YES                 |
| `thinking_delta` | `delta: string`                     | YES            | YES                 |
| `thinking_end`   | `content: string`                   | YES            | YES                 |
| `toolcall_start` | —                                   | YES            | YES                 |
| `toolcall_delta` | `delta: string`                     | YES            | YES                 |
| `toolcall_end`   | `toolCall: ToolCall`                | YES            | YES                 |
| `done`           | `reason`, `message: AssistantMessage` | message (NOT partial) | NO |
| `error`          | `reason`, `error: AssistantMessage`   | error  (NOT partial) | NO |

### Key points for the rewrite
- **`partial` is the provider's OWN accumulating `output` object** (same reference mutated in place
  across all events in a single stream). It is a LIVE reference, not a snapshot.
- **`done.message`** is the same `output` reference at terminal time (full content).
- The proxy must rewrite BOTH `partial` (on every non-terminal replacement event) AND `message`
  (on the replacement `done`) to merge the primary's frozen content.

---

## 2. `AssistantMessage`

Source: `node_modules/@earendil-works/pi-ai/dist/types.d.ts`.

```ts
interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];        // ← the array the consumer indexes
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;         // "stop" | "length" | "toolUse" | "aborted" | "error"
  errorMessage?: string;
  timestamp: number;
}
```

### Content block types (the elements of `content`)

| type       | key fields                                            |
|------------|-------------------------------------------------------|
| `text`     | `text: string`, optional `textSignature`              |
| `thinking` | `thinking: string`, optional `thinkingSignature`      |
| `toolCall` | `id`, `name`, `arguments`, optional `partialJson`     |

**For the merge:** the primary's frozen content blocks (the `thinking` blocks) are plain objects.
A deep clone at freeze time captures them safely. The merged message is:
```js
{ ...replacementPartial, content: [...frozenPrimaryBlocks, ...replacementPartial.content] }
```
This preserves the replacement's `usage`/`stopReason`/`model` while splicing in the primary's content.

---

## 3. `EventStream` semantics (`createAssistantMessageEventStream`)

- `push(event)` appends to an internal queue.
- Pushing a **terminal** (`done`/`error`) sets `done = true`, **resolves `result()`** with
  `event.message` (done) or `event.error` (error), and the iterator completes.
- `push()` is a **no-op** once `done === true` (idempotent terminal).
- `result()` returns a Promise that resolves to the terminal's message — called by the consumer
  at `done`/`error` time (`finalMessage = await response.result()`).

### Implication for the rewrite
The proxy must rewrite the replacement `done` event's `message` BEFORE pushing it, because
`push({type:"done", message: X})` immediately resolves `result()` with `X`. If we forward the
replacement's `done` verbatim, `result()` resolves to the text-only output.
