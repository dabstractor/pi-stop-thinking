# Extension API Contract — verified against installed types

Source: `node_modules/@earendil-works/pi-coding-agent@0.80.3/dist/core/extensions/types.d.ts`

## Extension factory type

```typescript
/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

- Pi calls the **default export** of `dist/index.js` with a single `ExtensionAPI` argument.
- The factory MAY be sync (`void`) or async (`Promise<void>`). The work item contract specifies
  `void` (sync), which is correct: every init step (loadConfig, createDiagnostics, `new
  ProviderDecorator`, `.initialize()`, `pi.on(...)`) is synchronous. **Do NOT make it async.**

## session_shutdown event (EC-012 cleanup hook)

```typescript
on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;

export interface SessionShutdownEvent {
    type: "session_shutdown";
    reason: "quit" | "reload" | "new" | "resume" | "fork";
    targetSessionFile?: string;
}

export type ExtensionHandler<E, R = undefined> =
    (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

- The handler receives `(event, ctx)`. Our cleanup ignores both — it only calls `decorator.shutdown()`.
- `reason` includes `"reload"` → EC-013 (provider reload) also fires session_shutdown before re-init,
  so registering cleanup here ALSO satisfies "Decorator re-registers / captured provider refreshed"
  for the reload path (a fresh factory call on reload re-captures the (restored) built-in).

## Ordering observation: factory is called AFTER pi-ai builtins are registered

Pi loads `@earendil-works/pi-ai` (which eagerly registers the `openai-completions` builtin via
`register-builtins.js`) BEFORE invoking extension factories. Therefore by the time our factory runs,
`getApiProvider("openai-completions")` is already present and `ProviderDecorator.initialize()` will
NOT throw in production. The "provider not found" throw is a defensive guard (e.g. tests / exotic
runtimes); the factory's try/catch must still tolerate it gracefully (PRD: init failure never crashes Pi).

## Implication for the shutdown handler registration

Register `pi.on("session_shutdown", ...)` AFTER `decorator.initialize()` succeeds. Rationale: if
`initialize()` throws, there is nothing registered to clean up (the wrapper was never installed), so we
skip the handler entirely (it falls into the catch). `decorator.shutdown()` is idempotent and a safe
no-op when never initialized, so this ordering is a cleanliness choice, not a correctness requirement.

## settings.json packages format (README install docs)

Source: pi-coding-agent `docs/settings.md` §packages + `docs/packages.md`.

- User-scoped settings: `~/.pi/agent/settings.json`  (project-scoped: `.pi/settings.json`)
- Key: `"packages"` (string array)
- Our entry: `"npm:pi-stop-thinking"` (npm source type = `npm:<name>`)
- Preferred install method (writes settings automatically):
  `pi install npm:pi-stop-thinking`
- Manual edit equivalent:
  ```json
  {
    "packages": ["npm:pi-stop-thinking"]
  }
  ```
- npm packages install under `~/.pi/agent/npm/`.
