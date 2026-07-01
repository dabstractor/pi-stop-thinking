# Research: pi-ai api-registry internals (verified against installed v0.74.2)

Source of truth: `node_modules/@earendil-works/pi-ai/dist/api-registry.js` + `.d.ts`.

## The registry stores WRAPPED functions (CRITICAL for this subtask)

`registerApiProvider(provider, sourceId)` does NOT store `provider.stream`/`provider.streamSimple`
verbatim. It wraps each one with an api-guard:

```js
function wrapStreamSimple(api, streamSimple) {
    return (model, context, options) => {
        if (model.api !== api) {
            throw new Error(`Mismatched api: ${model.api} expected ${api}`);
        }
        return streamSimple(model, context, options);
    };
}

export function registerApiProvider(provider, sourceId) {
    apiProviderRegistry.set(provider.api, {
        provider: {
            api: provider.api,
            stream: wrapStream(provider.api, provider.stream),
            streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
        },
        sourceId,
    });
}
```

### Consequences for the wrapper

1. When we `registerApiProvider({ api: "openai-completions", stream, streamSimple }, "stop-thinking-extension")`,
   the registry stores WRAPPED versions that throw if `model.api !== "openai-completions"`. So our
   wrapper functions are **only ever invoked for `model.api === "openai-completions"`** — the registry
   enforces it. Our wrapper must NOT re-implement this check (it would be dead code; the contract's
   "wrapper must be wrapped to match the api check" is satisfied automatically by `registerApiProvider`).

2. `getApiProvider(api)` returns `apiProviderRegistry.get(api)?.provider` — i.e. the ALREADY-WRAPPED
   `{ api, stream, streamSimple }`. So when we capture:
   ```ts
   const original = getApiProvider("openai-completions");   // wrapped builtins
   ```
   `original.streamSimple` is `wrapStreamSimple("openai-completions", <builtin>)`. Calling it
   re-runs the api guard (harmless, `model.api` is guaranteed `"openai-completions"`) then invokes
   the real builtin. This is why delegation through `original` is byte-identical and **never
   recurses into our wrapper**: `original` is the captured closure pointing at the builtin, captured
   BEFORE we overwrote the registry entry.

## stream.js call path (what Pi's agent loop invokes)

```js
export function streamSimple(model, context, options) {
    const provider = resolveApiProvider(model.api);   // getApiProvider, throws if missing
    return provider.streamSimple(model, context, options);
}
export function stream(model, context, options) {
    const provider = resolveApiProvider(model.api);
    return provider.stream(model, context, options);
}
```

- The agent loop uses `streamSimple` (per system_context.md). `stream` is the lower-level variant.
- BOTH must be present on a registered `ApiProvider` (interface requires both). We wrap both; both
  delegate transparently. Interception (StreamProxy, M2) is **streamSimple-only**.

## Exact exported type surface (all confirmed at package root via `export *`)

From `api-registry.d.ts` (re-exported by `@earendil-works/pi-ai`):
```ts
export type ApiStreamFunction =
  (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream;
export type ApiStreamSimpleFunction =
  (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
    api: TApi;
    stream: StreamFunction<TApi, StreamOptions>;
    streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
export declare function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>, sourceId?: string): void;
export declare function getApiProvider(api: Api): ApiProviderInternal | undefined;  // internal type NOT exported
export declare function unregisterApiProviders(sourceId: string): void;
```

From `types.d.ts`:
- `Api = KnownApi | (string & {})` — `"openai-completions"` is a valid `Api` literal.
- `Provider = KnownProvider | string` — `"zai"` ∈ KnownProvider; `model.provider` is string-comparable.
- `Model<TApi>`: has `api: TApi`, `provider: Provider`, `reasoning: boolean`, `id: string` — all the
  fields the decision tree reads.
- `SimpleStreamOptions extends StreamOptions` (adds `reasoning?`, `thinkingBudgets?`).

## Captured-provider typing (ApiProviderInternal is NOT exported)

`getApiProvider` returns `ApiProviderInternal | undefined`, but `ApiProviderInternal` is not exported.
Cleanest capture type:
```ts
type CapturedProvider = NonNullable<ReturnType<typeof getApiProvider>>;
```
VERIFIED to compile with `npx tsc --strict ... scratch.ts` → exit 0.

## TYPE-CHECK PROOF (scratch file, deleted after)

Both of these compile against pi-ai@0.74.2 under `--strict --module ES2022 --moduleResolution bundler`:

(a) Annotated wrappers passed to registerApiProvider:
```ts
const wrapperStream: ApiStreamFunction = (model, context, options) => originalStream(model, context, options);
const wrapperStreamSimple: ApiStreamSimpleFunction = (model, context, options) => originalStreamSimple(model, context, options);
registerApiProvider({ api: "openai-completions", stream: wrapperStream, streamSimple: wrapperStreamSimple }, SOURCE_ID);
```

(b) Inline object-literal inference (model narrowed to `Model<"openai-completions">`):
```ts
registerApiProvider({
  api: "openai-completions",
  stream: (model, context, options) => os(model, context, options),
  streamSimple: (model, context, options) => oss(model, context, options),
}, SOURCE_ID);
```
Both delegate `original.stream*(model, context, options)` with the narrow `Model<"openai-completions">`
accepted by the broad `Model<Api>` params (parameter contravariance). No casts needed. Prefer variant (a)
for clarity + reuse of the `ApiStream*Function` type aliases that match `getApiProvider`'s return shape.

## Runtime side effect of importing pi-ai (relevant to tests)

`@earendil-works/pi-ai`'s `stream.js` imports `./providers/register-builtins.js`, which eagerly
registers all built-in providers (incl. `openai-completions`) into the module-global
`apiProviderRegistry` at first import. So:
- In production: `getApiProvider("openai-completions")` returns the real builtin (capture works).
- In tests: importing `src/provider/decorator.ts` (which value-imports pi-ai) loads the real registry,
  but because we INJECT a fake registry into the decorator, tests NEVER mutate the real global
  registry. (The real builtins being registered as an import side effect is harmless and matches
  production.) This is why DI of the registry is the right mocking strategy (vs. module mocking).
