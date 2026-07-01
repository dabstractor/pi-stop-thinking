# Research Notes — P1.M1.T1.S1 (Project Scaffold)

## Verified Environment (2026-07-01)

### Installed peer dependency versions
- `@earendil-works/pi-coding-agent` → **0.80.3** (global: `/home/dustin/.local/lib/node_modules/@earendil-works/pi-coding-agent`)
- `@earendil-works/pi-ai` → **0.74.2** (Pi agent: `/home/dustin/.pi/agent/npm/node_modules/@earendil-works/pi-ai`)
- Both are `"type": "module"`, `"main": "./dist/index.js"`

### Confirmed export paths (for compilability gate)
**`@earendil-works/pi-coding-agent`** (`dist/index.d.ts`, line 7): re-exports types from
`./core/extensions/index.ts` including:
`ExtensionAPI`, `ExtensionFactory`, `ExtensionContext`, `ExtensionUIContext`,
`ProviderConfig`, `SessionShutdownEvent`, `ExtensionShortcut`.
- `package.json` `exports["."]` → `types: ./dist/index.d.ts`, `import: ./dist/index.js`

**`@earendil-works/pi-ai`** (`dist/index.d.ts`): `export * from "./api-registry.js"` and
`export * from "./utils/event-stream.js"`, so the root package re-exports:
`registerApiProvider`, `getApiProvider`, `getApiProviders`, `unregisterApiProviders`
(from `api-registry.d.ts`) and `createAssistantMessageEventStream` /
`AssistantMessageEventStream` (from `utils/event-stream.d.ts`).
- `package.json` `exports["."]` → `types: ./dist/index.d.ts`, `import: ./dist/index.js`

### Reference extension conventions
- **pi-bar** (`/home/dustin/.pi/agent/npm/node_modules/pi-bar`): uses RAW `.ts` files loaded
  via `package.json` `"pi": { "extensions": ["./extensions/status-footer.ts"] }` field. NO
  build step, NO tsconfig, NO `main`. Peer deps declared with `peerDependenciesMeta.optional: true`.
  → This is NOT our pattern.
- **pi-zai-usage** (GitHub `shaftoe/pi-zai-usage`): the NAMED reference per
  external_deps.md §4. Uses Bun + TypeScript (strict) + GitHub Actions → NPM publish.
  Compiled pattern: `"type": "module"`, `"main": "./dist/index.js"`, `tsc` → `./dist/`,
  `bun test`. (Raw files not fetchable; conventions confirmed via architecture docs + search.)
- **pi-coding-agent built-in examples** (`examples/extensions/with-deps`,
  `custom-provider-anthropic`): also raw `.ts` + `"pi": { "extensions": ["./index.ts"] }`,
  `"private": true`. Again NOT our pattern.
- → Our project uses the **compiled/dist** pattern (main → dist, tsc build) per explicit
  task mandate and external_deps.md §4.

### Recommended tsconfig.json (from external_deps.md §4)
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

## CRITICAL Compilation Gotcha (drives the devDependencies decision)
`moduleResolution: "bundler"` resolves bare imports `@earendil-works/pi-ai` via the package's
`exports` field — but ONLY if the package is physically present in `node_modules`.
Peer deps declared with `"*"` are NOT auto-installed by `bun install`/`npm install` (they only
emit a warning). Result: `tsc` fails with "Cannot find module" unless the peer deps are ALSO
listed as `devDependencies` (installed locally for type resolution).
→ Fix: list `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` as BOTH
`peerDependencies` (runtime, `"*"`) AND `devDependencies` (local type-check, pinned versions).
This is legal and standard for publishable libs that must compile standalone.

## Runtime-load gotcha for bun test
A default `import { ExtensionAPI } ...` would pull the heavy `pi-coding-agent` runtime graph
into `bun test`. To keep the S1 smoke test lightweight AND satisfy "imports from peer deps",
`src/index.ts` MUST use **`import type { ExtensionAPI }`** (type-only, erased at compile/runtime).
Type-only imports are dropped by tsc and do not trigger runtime module loading → smoke test
can assert `typeof defaultExport === "function"` without loading peer deps.

## Scope boundaries (what S1 does NOT do — owned by later subtasks)
- `src/config/*` → P1.M1.T2.S1 (Configuration)
- `src/diagnostics/*` → P1.M1.T3.S1 (Diagnostics)
- `src/provider/decorator.ts` → P1.M1.T4.S1 (Provider capture/wrapper)
- `src/index.ts` full wiring → P1.M1.T5.S1 (factory init/shutdown)
- `src/provider/proxy.ts` → P1.M2.T2.S1 (StreamProxy)
- `src/state/controller.ts` → P1.M3.T1.S1 (TransitionController FSM)
- `src/state/coordinator.ts` → P1.M4.T4.S1 (TransitionCoordinator)
- `src/buffer/*` → P1.M4.T1.S1 (ReasoningBuffer)
- `src/shortcut/*` → P1.M4.T3.S1 (ShortcutManager)
- `src/request/*` → P1.M6.T1.S1 (RequestBuilder)
- `src/types.ts` real content → P1.M2.T1.S1 (event/state types)
→ S1 only creates the directories (git-tracked via stubs), a COMPILING index.ts factory stub,
  package.json, tsconfig.json, README skeleton, and a smoke test.
