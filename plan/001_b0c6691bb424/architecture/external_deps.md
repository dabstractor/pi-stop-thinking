# External Dependencies & Library Contracts

## 1. `@earendil-works/pi-ai` (peerDependency)

The core AI provider library. The extension imports from it directly.

### Provider Registry API

```typescript
// From @earendil-works/pi-ai/dist/api-registry.d.ts
type ApiStreamSimpleFunction = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream;

interface ApiProvider<TApi extends Api = Api> {
  api: TApi;
  stream: StreamFunction<TApi, StreamOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

function registerApiProvider<TApi, TOptions>(provider: ApiProvider, sourceId?: string): void;
function getApiProvider(api: Api): { stream, streamSimple } | undefined;
function unregisterApiProviders(sourceId: string): void;
```

### Event Stream API

```typescript
// From @earendil-works/pi-ai/dist/utils/event-stream.d.ts
class AssistantMessageEventStream {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  result(): Promise<AssistantMessage>;
}

function createAssistantMessageEventStream(): AssistantMessageEventStream;
```

### Key Type Definitions

```typescript
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
type ModelThinkingLevel = "off" | ThinkingLevel;

interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model) => unknown | undefined;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat : never;
  // ... cost, contextWindow, maxTokens, etc.
}

interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

## 2. `@earendil-works/pi-coding-agent` (peerDependency)

The Pi agent runtime. Provides the extension API.

### ExtensionAPI

```typescript
interface ExtensionAPI {
  // Event subscription
  on(event: "message_update", handler: (e: MessageUpdateEvent, ctx: ExtensionContext) => void): void;
  on(event: "session_shutdown", handler: (e: SessionShutdownEvent, ctx: ExtensionContext) => void): void;
  // ... 30+ other events

  // Shortcut registration
  registerShortcut(shortcut: KeyId, options: {
    description?: string;
    handler: (ctx: ExtensionContext) => Promise<void> | void;
  }): void;

  // Provider registration (higher-level wrapper)
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;

  // Flags (CLI configuration)
  registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void;
  getFlag(name: string): boolean | string | undefined;

  // Shared event bus
  events: EventBus;
}

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

### ExtensionContext (for shortcut/event handlers)

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  cwd: string;
  model: Model<any> | undefined;
  isIdle(): boolean;
  signal: AbortSignal | undefined;
  abort(): void;
}
```

## 3. z.ai API (external service)

### Provider Properties

- **Provider ID**: `"zai"`
- **API type**: `"openai-completions"` (OpenAI-compatible)
- **Base URL**: `https://api.z.ai/api/coding/paas/v4`
- **Thinking format**: `thinkingFormat: "zai"` → uses `enable_thinking: boolean` parameter
- **Reasoning field in response**: `delta.reasoning_content` (string)

### Disabling Reasoning

In the built-in provider (`openai-completions.js`):

```javascript
if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
}
```

`reasoningEffort` is derived from `SimpleStreamOptions.reasoning`:
- If `options.reasoning` is a valid ThinkingLevel → `reasoningEffort` = that level
- If `options.reasoning` is `"off"` or undefined → `reasoningEffort` = undefined
- `enable_thinking = !!undefined = false` → reasoning disabled

**To create a replacement request with thinking disabled:**

```typescript
original.streamSimple(model, context, {
  ...options,        // preserve apiKey, signal, temperature, etc.
  reasoning: undefined,  // ← disable thinking
});
```

### z.ai Model Detection

```typescript
// From openai-completions.js detectCompat()
const isZai = model.provider === "zai" || model.baseUrl.includes("api.z.ai");
// thinkingFormat is set to "zai" for isZai models
// supportsReasoningEffort is FALSE for z.ai (uses enable_thinking instead)
```

### Stream Abort Behavior

z.ai stops generating when the client closes the connection (AbortController.abort()).
Tokens already received are retained. The stream's async iterator throws an abort
error that must be caught gracefully.

## 4. Build Tooling

Based on the `pi-zai-usage` and `pi-bar` extension patterns:

- **Language**: TypeScript (ES2022 modules, strict mode)
- **Build**: `tsc` to `./dist/`
- **Runtime**: Bun (Pi uses Bun to load extensions)
- **Test**: `bun test` with bun's built-in test runner
- **Package**: npm package with `"keywords": ["pi-package", "pi-extension"]`

### tsconfig.json (recommended)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "./dist",
    "skipLibCheck": true
  }
}
```
