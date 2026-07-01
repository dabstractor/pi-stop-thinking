# System Context: Stop Thinking & Do Extension

## Overview

The Stop Thinking & Do extension is a Pi coding agent extension that intercepts
the provider event stream at the `streamSimple` boundary to allow users to
interrupt reasoning loops in z.ai models and immediately transition to answer
generation — while preserving the illusion of a single uninterrupted assistant
response.

## Pi Extension Runtime

The extension runs inside Pi's extension system. Key integration points
discovered by inspecting `@earendil-works/pi-coding-agent` v0.80.x:

### Extension Factory Pattern

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function stopThinkingExtension(pi: ExtensionAPI): void {
  // ... register provider decoration, shortcuts, event handlers
}
```

The default export of the extension entry point is a factory function that
receives the `ExtensionAPI`. This is the same pattern used by `pi-bar` and
`pi-zai-usage`.

### Package Structure

```json
{
  "name": "pi-stop-thinking",
  "type": "module",
  "main": "./dist/index.js",
  "keywords": ["pi-package", "pi-extension", "zai", "reasoning"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

## Provider Decoration Architecture (CRITICAL)

### The Two-Layer Provider System

Pi resolves provider streaming through two layers:

1. **`@earendil-works/pi-ai`** (the AI library) — maintains a global
   `Map<Api, ApiProviderInternal>` called `apiProviderRegistry`. Each entry
   contains `{ stream, streamSimple }` functions keyed by API type (e.g.,
   `"openai-completions"`).

2. **`ModelRegistry`** (in pi-coding-agent) — manages model definitions and
   can register custom `streamSimple` handlers per provider via
   `pi.registerProvider()`.

### How `streamSimple` Is Called

When Pi's agent loop needs a completion:

```
Pi Agent Loop
  → calls `streamSimple(model, context, options)` from pi-ai
  → pi-ai's `streamSimple()` calls `resolveApiProvider(model.api)`
  → looks up `apiProviderRegistry.get(model.api)` → returns `{ streamSimple }`
  → calls `provider.streamSimple(model, context, options)`
  → returns `AssistantMessageEventStream`
```

### The Capture-and-Replace Pattern (ADR-003)

The extension captures the built-in `streamSimple` and replaces it with a
wrapper that delegates by default:

```typescript
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai";

// STEP 1: Capture BEFORE replacing (prevents infinite recursion)
const original = getApiProvider("openai-completions");
if (!original) throw new Error("Built-in openai-completions provider not found");

// STEP 2: Create wrapper
const wrappedStreamSimple: ApiStreamSimpleFunction = (model, context, options) => {
  // Activation conditions (PRD §19.6)
  if (model.provider !== "zai" || !model.reasoning || !config.enabled) {
    return original.streamSimple(model, context, options); // transparent delegation
  }
  // z.ai reasoning model → construct interception proxy
  return streamProxy.createProxy(model, context, options, original.streamSimple);
};

// STEP 3: Replace the registration
registerApiProvider({
  api: "openai-completions",
  stream: (model, context, options) => wrappedStreamSimple(model, context, options),
  streamSimple: wrappedStreamSimple,
}, "stop-thinking-extension");
```

**CRITICAL ORDERING**: Capture must happen before registration. The
`registerApiProvider` call overwrites the registry entry. If capture happens
after, the wrapper captures itself → infinite recursion.

### Why `registerApiProvider` (not `pi.registerProvider`)

The extension API's `pi.registerProvider("zai", { streamSimple })` internally
calls `registerApiProvider` but:
- It requires `api` to be specified
- It replaces the provider for the entire API type, not just z.ai models
- It doesn't give direct access to capture the original

Using `getApiProvider`/`registerApiProvider` directly from `@earendil-works/pi-ai`
gives cleaner control. The wrapper checks `model.provider === "zai"` internally
and delegates all non-z.ai requests transparently.

**Cleanup**: `unregisterApiProviders("stop-thinking-extension")` restores the
original. This should be called on `session_shutdown` (EC-012).

## AssistantMessageEventStream

The core data structure. From `@earendil-works/pi-ai/dist/utils/event-stream.js`:

```typescript
class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  push(event: AssistantMessageEvent): void;   // enqueue an event for the consumer
  end(result?: AssistantMessage): void;        // mark stream complete
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  result(): Promise<AssistantMessage>;         // resolves with final message
}

function createAssistantMessageEventStream(): AssistantMessageEventStream;
```

The wrapper creates its own `AssistantMessageEventStream` via
`createAssistantMessageEventStream()` and:
1. Iterates the upstream stream (from `original.streamSimple()`)
2. Pushes events to its own downstream stream
3. When Stop Thinking fires, aborts upstream and starts replacement
4. Splices replacement events into the same downstream stream
5. Pi consumes the downstream stream — unaware of the splice

### AssistantMessageEvent Types

```typescript
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

## z.ai Model Properties

From `models.generated.js`, z.ai models have:

```javascript
{
  id: "glm-4.7",
  name: "GLM-4.7",
  api: "openai-completions",       // ← intercept point
  provider: "zai",                  // ← activation check
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  compat: { supportsDeveloperRole: false, thinkingFormat: "zai", zaiToolStream: true },
  reasoning: true,                   // ← activation check
}
```

Available z.ai reasoning models: glm-4.5-air, glm-4.5, glm-4.6, glm-4.7,
glm-5-turbo, glm-5.1, glm-5.2.

## Keyboard Shortcut Registration

From `ExtensionAPI`:

```typescript
pi.registerShortcut(shortcut: KeyId, options: {
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}): void;
```

`KeyId` is a string like `"ctrl+."`, `"escape"`, `"shift+tab"`, etc. Confirmed
from `KEYBINDINGS` in `keybindings.ts`.

The shortcut handler receives `ExtensionContext` with:
- `ctx.signal?: AbortSignal` — the agent's abort signal
- `ctx.isIdle(): boolean` — whether agent is streaming
- `ctx.model?: Model<any>` — current model

## Coordination Between Shortcut and Stream Proxy

The shortcut handler and the `streamSimple` wrapper run in different execution
contexts but share the same module. A `TransitionCoordinator` singleton (created
in the factory closure) bridges them:

```
┌──────────────────────────────────────────────┐
│ Extension Factory Closure                    │
│                                              │
│  coordinator = new TransitionCoordinator()   │
│                                              │
│  pi.registerShortcut("ctrl+.", {             │
│    handler: () => coordinator.requestStop()  │
│  })                                          │
│                                              │
│  registerApiProvider({                       │
│    streamSimple: (model, ctx, opts) => {     │
│      proxy = new StreamProxy(...)            │
│      coordinator.setActiveProxy(proxy)       │
│      return proxy.output                     │
│    }                                         │
│  })                                          │
└──────────────────────────────────────────────┘
```

## SimpleStreamOptions

```typescript
interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;        // "minimal"|"low"|"medium"|"high"|"xhigh"
  thinkingBudgets?: ThinkingBudgets;
}

interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;             // ← used for abort coordination
  apiKey?: string;
  sessionId?: string;
  // ... more fields
}
```

The `signal` field is key: the upstream `streamSimple` call receives Pi's abort
signal. The wrapper intercepts this and creates its own internal AbortController
for the upstream stream, so it can abort the reasoning stream independently of
Pi's abort.
