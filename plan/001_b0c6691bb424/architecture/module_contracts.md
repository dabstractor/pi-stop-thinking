# Module Contracts & Interface Specifications

Each module has exactly one primary responsibility (PRD §37: Concurrency Model).
No mutable state has multiple owners.

## Module Dependency Graph

```
index.ts (factory)
  ├── Configuration        (config schema + defaults + validation)
  ├── TransitionCoordinator (shared state bridge between shortcut and proxy)
  ├── ProviderDecorator     (capture + replace streamSimple)
  │     └── StreamProxy     (one-output, multi-input event merging)
  │           ├── TransitionController (state machine)
  │           ├── ReasoningBuffer      (append-only capture)
  │           └── RequestBuilder       (replacement request construction)
  ├── ShortcutManager       (keyboard shortcut → coordinator.requestStop)
  └── Diagnostics           (structured logging)
```

## Module Contracts

### Configuration

```
Responsibility: Define, validate, and provide access to configuration values.
Owns: Configuration values, defaults, validation.
Does NOT own: Runtime behavior, side effects.

Interface:
  load(): Config
  validate(config: unknown): Config  // falls back to defaults on invalid

Types:
  Config {
    enabled: boolean                 // default: true
    shortcut: string                 // default: "ctrl+."
    supportedProviders: string[]     // default: ["zai"]
    transitionTimeoutMs: number      // default: 5000
    replacementStartupTimeoutMs: number  // default: 10000
    maximumReasoningBufferBytes: number  // default: 8388608
    telemetryEnabled: boolean        // default: false
    diagnosticsLevel: "error" | "warn" | "info" | "debug" | "trace"  // default: "error"
  }
```

### ProviderDecorator

```
Responsibility: Capture built-in provider, register wrapper, manage lifecycle.
Owns: Captured provider reference, registration state.
Does NOT own: Stream logic, transition state, buffering.

Interface:
  initialize(): void    // capture + register
  shutdown(): void      // unregister, restore original

Key State:
  - original: { stream, streamSimple } | undefined  // captured provider
  - sourceId: string  // "stop-thinking-extension" for unregisterApiProviders

Wrapped streamSimple behavior (PRD §19.5 Decision Tree):
  1. if model.provider NOT in config.supportedProviders → delegate
  2. if !model.reasoning → delegate
  3. if !config.enabled → delegate
  4. if coordinator.alreadyInterrupting() → delegate
  5. otherwise → construct StreamProxy, return proxy.output
```

### StreamProxy

```
Responsibility: Merge primary + replacement streams into one downstream stream.
Owns: Output AssistantMessageEventStream, event queue, authority state.
Does NOT own: Transition decisions, prompt construction, shortcut handling.

Interface:
  constructor(model, context, options, upstreamStreamFn, coordinator)
  get output(): AssistantMessageEventStream  // Pi consumes this

Internal flow:
  1. Create output = createAssistantMessageEventStream()
  2. Start iterating upstream = upstreamStreamFn(model, context, opts)
  3. For each upstream event:
     a. forward(event) → output.push(event)
     b. track reasoning state via event types
     c. if done/error → output.end(result)
  4. When coordinator.requestStop() is called AND reasoning is active:
     a. abort upstream (internal AbortController)
     b. freeze ReasoningBuffer
     c. call RequestBuilder to create replacement request
     d. iterate replacement stream
     e. splice: suppress upstream terminal events, forward replacement events
  5. Forward exactly one done/error event to output
```

### TransitionController (State Machine)

```
Responsibility: Own interruption lifecycle as explicit FSM.
Owns: Current state, abort controller, transition token.
Single writer. Multiple readers.

States (PRD §15):
  Idle → Delegating → Reasoning → StopRequested → Aborting → Capturing
    → Restarting → Splicing → Answering → Completed → (back to Idle)
  Any → Failed → (back to Idle)

Interface:
  getState(): TransitionState
  requestStop(): boolean      // returns false if not in Reasoning state
  canInterrupt(): boolean     // true only in Reasoning state
  beginAbort(): void
  completeAbort(): void
  beginReplacement(): void
  complete(): void
  fail(reason: string): void
  reset(): void
```

### ReasoningBuffer

```
Responsibility: Capture reasoning emitted before interruption.
Owns: Append-only ordered collection of reasoning events.
Immutable after freeze().

Interface:
  append(event: ThinkingEvent): void
  freeze(): void           // make immutable
  snapshot(): readonly ThinkingEvent[]  // returns immutable copy
  reset(): void            // clear and unfreeze
  getByteSize(): number   // current size in bytes

Types:
  ThinkingEvent {
    offset: number        // monotonically increasing
    timestamp: number
    content: string       // the delta text
  }
```

### RequestBuilder

```
Responsibility: Construct replacement provider request with thinking disabled.
Owns: Nothing (pure function).
Does NOT own: Network, streaming, retries.

Interface:
  buildReplacement(model, context, options, reasoningSnapshot): {
    model: Model<Api>
    context: Context
    options: SimpleStreamOptions
  }

Transformation rules (PRD §53):
  PRESERVE: conversation, user prompt, assistant history, model, sampling params, provider
  MODIFY: reasoning → undefined (disables enable_thinking for z.ai)
  MAY ADD: ephemeral execution directive to system prompt (optional, minimal)
  DO NOT MODIFY: user intent, conversation ordering, session identity
```

### TransitionCoordinator

```
Responsibility: Bridge between ShortcutManager and StreamProxy.
Owns: Reference to active StreamProxy (if any).

Interface:
  setActiveProxy(proxy: StreamProxy | undefined): void
  requestStop(): boolean  // delegates to active proxy if reasoning active
  isReasoning(): boolean  // delegates to active proxy
  alreadyInterrupting(): boolean
```

### ShortcutManager

```
Responsibility: Register keyboard shortcut, forward stop request.
Owns: Shortcut registration state.
Does NOT own: Abort, provider modification, request construction.

Interface:
  register(pi: ExtensionAPI, shortcut: string, coordinator: TransitionCoordinator): void
  unregister(): void

Behavior:
  - On keypress: call coordinator.requestStop()
  - Idempotent: duplicate presses ignored (PRD §24.3)
```

### Diagnostics

```
Responsibility: Structured logging. Disabled by default. Never modifies behavior.
Owns: Log level, log sinks.

Interface:
  trace(event: string, fields?: Record<string, unknown>): void
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void

Privacy (PRD §58, Appendix H):
  MAY LOG: provider name, model id, transition id, timing, event counts, state transitions
  NEVER LOG: prompt text, reasoning text, assistant output, API keys, tool arguments
```

## Event Forwarding Rules (PRD §18)

| Event          | Before Stop    | During Transition      | After Restart    |
|----------------|----------------|------------------------|------------------|
| start          | Forward        | Already emitted        | Already emitted  |
| thinking_start | Forward        | Ignore                 | Never emit       |
| thinking_delta | Forward        | Ignore                 | Never emit       |
| thinking_end   | Forward        | Ignore                 | Never emit       |
| text_start     | Forward        | Replacement only       | Already emitted  |
| text_delta     | Forward        | Replacement only       | Forward          |
| text_end       | Forward        | Forward replacement    | Forward          |
| toolcall_*     | Forward        | Suspend → forward later| Forward          |
| done           | Forward        | SUPPRESS upstream      | Forward repl.    |
| error          | Forward        | SUPPRESS upstream      | Forward repl.    |

**INVARIANT**: Exactly one `start` and one terminal event (`done` or `error`)
reach Pi's downstream consumer, regardless of how many upstream streams exist.
