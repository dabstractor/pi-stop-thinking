# Testability decision: inject a decorator factory (DI seam)

## Problem

The factory's core job is to **construct** the `ProviderDecorator` and call `.initialize()`, which
registers a wrapper in pi-ai's **module-global** `apiProviderRegistry`. The decorator PRP (T4)
explicitly forbids unit tests from mutating the global registry (leaks across tests) and solves it via
an **optional constructor param** (`registry?: ProviderRegistry`) that defaults to the real pi-ai
functions while tests pass a fake.

The factory, however, constructs the decorator itself: `new ProviderDecorator(config, diagnostics)`
with NO registry arg → real registry → global mutation if a test invokes the real factory path.

## Considered options

1. **Module mocking** (`bun:test` `mock.module` to stub `../provider/decorator`). Rejected: the API
   surface for module mocking is version-sensitive and more fragile than an explicit seam; also harder
   to assert call order.
2. **No seam — test against the real decorator + global registry, restore after.** Rejected: violates
   the T4 "no global-registry mutation in unit tests" rule and is brittle.
3. **Optional second parameter: a decorator factory function.** ✅ Chosen — mirrors the T4 DI-by-optional-
   param convention exactly, is fully type-safe, and does not change the external contract (Pi calls the
   default export with ONE argument; the optional seam is invisible to Pi).

## Chosen seam (final)

```typescript
export interface DecoratorLifecycle {
  initialize(): void;
  shutdown(): void;
}

export type DecoratorFactory =
  (config: Config, diagnostics: Diagnostics) => DecoratorLifecycle;

const createDefaultDecorator: DecoratorFactory =
  (config, diagnostics) => new ProviderDecorator(config, diagnostics);

export default function stopThinkingExtension(
  pi: ExtensionAPI,
  createDecorator: DecoratorFactory = createDefaultDecorator,
): void { /* ... */ }
```

- `ProviderDecorator` satisfies `DecoratorLifecycle` structurally (it has `initialize(): void` +
  `shutdown(): void`), so the default factory type-checks with no extra glue.
- Tests pass a `createDecorator` that returns a **spy** object (initialize/shutdown jest-style via
  `bun:test`'s `mock()`), so the global registry is never touched.

## Why NOT also inject loadConfig / createDiagnostics

`loadConfig()` and `createDiagnostics()` are **pure / side-effect-free** (T2/T3 contracts: loadConfig
never throws; createDiagnostics never throws on the logging path). Calling the real ones in tests is
completely safe and exercises the real config→diagnostics wiring. Injecting them would be
over-engineering. The ONLY seam needed is the decorator factory (the only global-state-mutating step).

## What the fake ExtensionAPI needs

Only `on(event, handler)`. A minimal `Pick<ExtensionAPI, "on">` double that, for `"session_shutdown"`,
records the handler so the test can fire it. For all other events it can no-op. TypeScript: cast a plain
object `{ on(...) {} }` to `ExtensionAPI` (or `as unknown as ExtensionAPI`) — only `on` is invoked.

## Tests to write (happy + failure paths)

1. Happy: injected fake decorator → assert `initialize` called once; `on("session_shutdown", …)` handler
   captured; firing it calls `shutdown` once; factory returns without throwing.
2. Init failure: fake decorator whose `initialize()` throws → factory does NOT rethrow; the
   `session_shutdown` handler is NOT registered (assert the fake pi's `on` was never called with
   `"session_shutdown"`); a diagnostics error line is captured (array sink).
3. Shutdown failure isolation: fake decorator whose `shutdown()` throws → firing the captured
   `session_shutdown` handler does NOT throw (swallowed + logged).
4. (Level 3, isolated node process, NOT a bun unit) end-to-end against the REAL ProviderDecorator +
   real global registry: install changes the entry, shutdown restores it (mirrors T4's Level 3).
