# pi-ai Provider API Types — Context Injection Reference

> Source: `node_modules/@earendil-works/pi-ai@0.74.2` (compiled `dist/`)
> Purpose: exactly how to inject content into a replacement provider request.

## Context Type

```ts
export interface Context {
    systemPrompt?: string;
    messages: Message[];
    tools?: Tool[];
}
```

- A **plain, mutable JS object** — no `readonly`, not frozen.
- `systemPrompt` is the single system-prompt field. No `systemMessages` array.
- `messages` is the conversation history as `Message[]`. Order is significant.

## Message Types

```ts
export interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}
export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    // ... api, provider, model, usage, stopReason, timestamp
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

A minimal ephemeral user message: `{ role: "user", content: "<directive>", timestamp: Date.now() }`.
`content` accepts a bare `string`.

## SimpleStreamOptions

```ts
export interface SimpleStreamOptions extends StreamOptions {
    reasoning?: ThinkingLevel;  // "minimal"|"low"|"medium"|"high"|"xhigh"; undefined = OFF
    thinkingBudgets?: ThinkingBudgets;
}
export interface StreamOptions {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
    // ... headers, timeoutMs, maxRetries, etc.
}
```

- **`reasoning`**: `undefined` disables thinking. There is NO `reasoningEffort` user-facing field.
- **System-prompt fields**: NONE on options. System prompt lives exclusively on `Context.systemPrompt`.

## How streamSimple consumes context

`streamSimple(model, context, options)` resolves the provider and passes (model, context, options)
straight through. Zero processing of context. The provider reads `context.systemPrompt` and
`context.messages` directly.

## openai-completions provider flow

1. `streamSimpleOpenAICompletions` → `buildBaseOptions` (spreads options, DROPS reasoning).
2. `reasoningEffort = options.reasoning ? clampThinkingLevel(...) : undefined`.
3. `streamOpenAICompletions` → `buildParams` → `convertMessages`:
   - `context.systemPrompt` → leading `{ role: "system"|"developer", content }` message.
   - `context.messages` → remaining messages in order.
4. `onPayload` hook fires after buildParams (last chance to alter payload).

## Injection mechanism

**Chosen: Append ephemeral UserMessage to a COPY of context.messages.**
```ts
const augmented: Context = { ...context, messages: [...context.messages, directiveMsg] };
```
- Original context untouched. Directive rides as last message. No system prompt change.
- Alternative `onPayload` hook is less type-safe (operates on `unknown` payload).
