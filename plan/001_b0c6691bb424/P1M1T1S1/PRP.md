# PRP — P1.M1.T1.S1: Project Scaffold (package.json, tsconfig.json, project structure)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning, transition to answer)
> **Subtask**: P1.M1.T1.S1 (Foundation, 1 pt) — greenfield scaffold. **No behavioral logic.**

---

## Goal

**Feature Goal**: Establish a compilable, runnable TypeScript scaffold for the
`pi-stop-thinking` Pi extension that (a) follows the **compiled/dist** package convention used
by `pi-zai-usage`, (b) declares the two peer dependencies correctly so both `tsc` type-checking
and Pi runtime loading succeed, and (c) lays down the full `src/` directory tree that all
downstream Foundation subtasks (P1.M1.T2–T5) will fill.

**Deliverable**:
- `package.json` — name `pi-stop-thinking`, `"type": "module"`, `"main": "./dist/index.js"`,
  correct keywords, peer+dev dependencies, `build`/`test` scripts.
- `tsconfig.json` — ES2022, strict, bundler resolution, emits declarations to `./dist`.
- `src/index.ts` — default-export factory stub that **compiles** and **runs**.
- `src/` directory tree (provider/, state/, buffer/, shortcut/, request/, config/, diagnostics/,
  types.ts) — present and git-tracked.
- `tests/smoke.test.ts` — a passing Bun smoke test.
- `README.md` — skeleton with name, description, "Under Development" notice.

**Success Definition**: From a clean checkout, `bun install && bun run build && bun test` all
exit 0; `tsc` emits `dist/index.js` + `dist/index.d.ts` with zero errors; the peer-dependency
type imports (`ExtensionAPI` from `pi-coding-agent`) resolve; the smoke test passes.

---

## Why

- **Foundation for all of Phase 0+**: This is the dependency root for P1.M1.T2.S1 through
  P1.M1.T5.S1 (config, diagnostics, provider decorator, factory wiring). Without a compiling
  project, none of those subtasks can be validated.
- **Convention conformance**: Pi discovers/loads extensions as npm packages with
  `keywords: ["pi-package","pi-extension"]`. The `pi-zai-usage` pattern (compiled dist entry)
  is the mandated convention here — NOT pi-bar's raw-`.ts` pattern.
- **Zero behavioral change milestone**: Phase 0's overriding requirement is observational
  equivalence. The scaffold must compile and load without doing anything.

## What

A greenfield npm/TypeScript project with:
1. A publishable `package.json` (peer deps for runtime, dev deps for local type resolution).
2. A `tsconfig.json` that type-checks strictly and emits ESM declarations.
3. The complete `src/` layout from the module dependency graph, populated only with a compiling
   factory stub + empty/placeholder modules (real logic is out of scope).
4. A Bun smoke test proving the factory is importable and is a function.
5. A README skeleton.

### Success Criteria

- [ ] `bun install` completes (peer deps resolvable, `typescript` + `@types/bun` installed).
- [ ] `bun run build` (=`tsc`) exits 0 and writes `dist/index.js`, `dist/index.d.ts`.
- [ ] `bunx tsc --noEmit` (or `bun run build`) reports **zero** diagnostics.
- [ ] `bun test` exits 0 with the smoke test passing.
- [ ] `package.json` contains `keywords` incl. `pi-package` and `pi-extension`.
- [ ] `package.json` declares both peer deps AND both as devDependencies.
- [ ] `src/index.ts` default export is a factory function `(pi: ExtensionAPI) => void`.
- [ ] All `src/` subdirectories from the task contract exist and are git-tracked.
- [ ] `README.md` exists with extension name + description + "Under Development" notice.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes** — this PRP is self-contained: it gives exact file contents to author, exact verified
versions, exact import paths, and exact validation commands. No prior Pi-extension knowledge is
required beyond what is inlined below.

### Documentation & References

```yaml
# MUST READ — architecture contracts that define the scaffold shape
- file: plan/001_b0c6691bb424/architecture/external_deps.md
  why: "§4 Build Tooling gives the authoritative recommended tsconfig.json; §1/§2 give the
        peer-dependency import APIs (registerApiProvider, ExtensionAPI, etc.)"
  critical: "Confirms compiled pattern: type:module, main:./dist/index.js, tsc→./dist, bun test."

- file: plan/001_b0c6691bb424/architecture/system_context.md
  why: "Section 'Package Structure' shows the exact package.json shape (name/type/main/keywords/
        peerDependencies); 'Extension Factory Pattern' shows the default-export factory signature."
  critical: "Factory signature: export default function stopThinkingExtension(pi: ExtensionAPI): void"

- file: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "'Module Dependency Graph' defines the exact src/ directory tree each later subtask owns."
  critical: "Use this to create the subdirectory layout (provider/, state/, buffer/, shortcut/,
             request/, config/, diagnostics/, types.ts) — but DO NOT implement their logic now."

# REFERENCE extension packages (read-only, do NOT copy raw-.ts pattern)
- file: /home/dustin/.pi/agent/npm/node_modules/pi-bar/package.json
  why: "Shows peerDependencies + peerDependenciesMeta.optional pattern and pi-package keywords."
  pattern: "keywords array incl. 'pi-package','pi-extension'; peerDependencies with '*' versions."
  gotcha: "pi-bar uses RAW .ts via 'pi.extensions' field — we do NOT. We use compiled dist 'main'."

- url: https://github.com/shaftoe/pi-zai-usage
  why: "The NAMED reference (external_deps.md §4). Confirms Bun + TypeScript(strict) + dist build."
  critical: "Validates the compiled/main→dist convention this scaffold must follow."

# VERIFIED type exports (proof the import paths compile) — checked against installed versions
- note: "@earendil-works/pi-coding-agent@0.80.3 dist/index.d.ts line 7 re-exports ExtensionAPI,
          ExtensionFactory, ExtensionContext, ProviderConfig as types."
- note: "@earendil-works/pi-ai@0.74.2 dist/index.d.ts uses 'export *' from api-registry.js and
          utils/event-stream.js, re-exporting registerApiProvider/getApiProvider/
          unregisterApiProviders/createAssistantMessageEventStream at the package root."
```

### Current Codebase tree

```bash
$ tree -a -I 'node_modules' --dirsfirst
.
├── .gitignore            # dist/, node_modules/, .env, .DS_Store (already present)
├── PRD.md                # product requirements (READ-ONLY)
└── plan/
    └── 001_b0c6691bb424/
        ├── architecture/   # external_deps.md, system_context.md, module_contracts.md, ...
        ├── prd_snapshot.md
        ├── prd_index.txt
        └── tasks.json
```
> Greenfield: no `package.json`, no `src/`, no `tsconfig.json` yet. `bun`/`node` are available
> (Pi runs on Bun). No `node_modules`.

### Desired Codebase tree (after this subtask)

```bash
.
├── .gitignore            # UNCHANGED — dist/ already ignored ✓
├── README.md             # NEW — skeleton (name, description, "Under Development")
├── package.json          # NEW
├── tsconfig.json         # NEW
├── src/
│   ├── index.ts          # NEW — default-export factory STUB (compiles + runs)
│   ├── types.ts          # NEW — placeholder barrel (re-export nothing yet / TODO comment)
│   ├── provider/
│   │   ├── decorator.ts  # stub — owned by P1.M1.T4.S1
│   │   └── proxy.ts      # stub — owned by P1.M2.T2.S1
│   ├── state/
│   │   ├── controller.ts # stub — owned by P1.M3.T1.S1
│   │   └── coordinator.ts# stub — owned by P1.M4.T4.S1
│   ├── buffer/           # .gitkeep — owned by P1.M4.T1.S1 (ReasoningBuffer)
│   ├── shortcut/         # .gitkeep — owned by P1.M4.T3.S1 (ShortcutManager)
│   ├── request/          # .gitkeep — owned by P1.M6.T1.S1 (RequestBuilder)
│   ├── config/           # .gitkeep — owned by P1.M1.T2.S1 (Configuration)
│   └── diagnostics/      # .gitkeep — owned by P1.M1.T3.S1 (Diagnostics)
├── tests/
│   └── smoke.test.ts     # NEW — Bun smoke test (asserts factory is a function)
└── dist/                 # GENERATED by tsc (git-ignored)
    ├── index.js
    └── index.d.ts
```
**File responsibilities**: `package.json` = manifest + peer/dev deps + scripts; `tsconfig.json` =
strict ESM compiler config; `src/index.ts` = sole runtime entry (factory stub);
`tests/smoke.test.ts` = importability proof. Every other `src/` file is an **empty stub** whose
only job is to make the directory git-trackable and document its future owner.

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (compilation): Peer deps declared with "*" are NOT installed by bun/npm — they only
// warn. With `moduleResolution: "bundler"`, tsc cannot resolve `@earendil-works/pi-ai` types
// unless the package is physically in node_modules.
// FIX: list both peer deps as devDependencies (pinned) AS WELL AS peerDependencies ("*").
//   This is legal & standard for publishable libs. Confirmed installed versions:
//     @earendil-works/pi-coding-agent  -> 0.80.3
//     @earendil-works/pi-ai            -> 0.74.2

// CRITICAL (bun test runtime): A value import of `ExtensionAPI` would load the full
// pi-coding-agent runtime graph into the test process. Use a TYPE-ONLY import so tsc validates
// the symbol while bun never executes the import:
//   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";   // ✓ erased

// GOTCHA: `module: "ES2022"` + `moduleResolution: "bundler"` requires Node ≥16 / modern bundlers.
// Pi runs on Bun, which supports this. Do NOT downgrade to "node16"/"nodenext" (would force .js
// extensions on every internal import and break the bundler-resolution ergonomics).

// GOTCHA: Empty directories are not tracked by git. Each empty src/ subdir needs a `.gitkeep`
// (or a stub .ts file). Prefer stub .ts files where a future module is known (provider/, state/)
// so the tree documents intent; use .gitkeep for the single-module dirs.

// GOTCHA: dist/ is already in .gitignore — good. Do NOT add node_modules/ handling changes
// (already ignored). Do NOT modify .gitignore for plan/ or PRD.md (forbidden).
```

---

## Implementation Blueprint

### Data models and structure

No data models in this subtask (no runtime logic). The only "type" surface is the
**type-only import** of `ExtensionAPI` in `src/index.ts`. Shared event/state types land in
`src/types.ts` under P1.M2.T1.S1.

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE package.json  (project root)
  - IMPLEMENT: full manifest per spec below.
  - FIELDS (exact):
      name: "pi-stop-thinking"
      version: "0.1.0"
      description: "Pi extension to interrupt z.ai reasoning streams and transition to answer
                    generation while preserving a single uninterrupted assistant response.
                    (Under Development)"
      type: "module"
      main: "./dist/index.js"
      types: "./dist/index.d.ts"
      keywords: ["pi-package","pi-extension","zai","reasoning","stop-thinking"]
      scripts:
        build: "tsc"
        test: "bun test"
        typecheck: "tsc --noEmit"
        clean: "rm -rf dist"
      files: ["dist","README.md"]
      peerDependencies:
        "@earendil-works/pi-ai": "*"
        "@earendil-works/pi-coding-agent": "*"
      devDependencies:
        typescript: "^5.6.0"
        "@types/bun": "latest"
        "@earendil-works/pi-ai": "0.74.2"
        "@earendil-works/pi-coding-agent": "0.80.3"
      license: "MIT"
  - WHY devDeps duplicate peers: see "CRITICAL (compilation)" gotcha — tsc needs them local.
  - NAMING: pin devDep peer versions to the confirmed-installed versions (0.74.2 / 0.80.3).
  - GOTCHA: do NOT set "private": true (this is intended to be publishable, unlike the pi
    built-in examples which are private).

Task 2: CREATE tsconfig.json  (project root)
  - IMPLEMENT: the config from external_deps.md §4 verbatim, plus include/exclude.
  - CONTENT (exact compilerOptions):
      target: "ES2022"
      module: "ES2022"
      moduleResolution: "bundler"
      strict: true
      declaration: true
      sourceMap: true
      outDir: "./dist"
      rootDir: "./src"
      skipLibCheck: true
      esModuleInterop: true
      forceConsistentCasingInFileNames: true
      isolatedModules: true
      lib: ["ES2022"]
      types: ["bun"]            # pulls in Bun globals/types for bun test
    "include": ["src/**/*.ts"]
    "exclude": ["node_modules","dist","tests"]
  - FOLLOW pattern: plan/001_b0c6691bb424/architecture/external_deps.md §4 (authoritative).
  - GOTCHA: `rootDir: "./src"` ensures dist/ mirrors src/ (dist/index.js). Adding `types:["bun"]`
    gives Bun test globals. `isolatedModules` guards per-file transpile safety.
  - WHY exclude tests from build: tests run via bun directly (no emit needed); keeps dist clean.

Task 3: CREATE src/index.ts  (factory entry stub — compiles + runs)
  - IMPLEMENT: default-export factory function with a type-only import + a TODO no-op body.
  - CONTENT (approximate):
      import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

      /**
       * Stop Thinking & Do — extension factory.
       *
       * Phase 0 scaffold stub. Wiring (provider capture, shortcut registration,
       * configuration load, shutdown) is added in P1.M1.T2–T5.
       */
      export default function stopThinkingExtension(_pi: ExtensionAPI): void {
        // P1.M1.T5.S1: initialize Configuration, Diagnostics, ProviderDecorator,
        // ShortcutManager, and register session_shutdown cleanup.
      }
  - PATTERN: matches system_context.md "Extension Factory Pattern" default-export signature.
  - CRITICAL: `import type` (not value import) — keeps bun test lightweight (see gotcha).
  - SCOPE: body stays EMPTY. Do not register anything yet (Phase 0 = zero behavior).

Task 4: CREATE src/ directory tree (stubs + .gitkeep)
  - CREATE these stub files (each: a JSDoc comment naming the future owner + nothing else):
      src/types.ts            -> "// Shared event & state types — P1.M2.T1.S1"
      src/provider/decorator.ts   -> "// ProviderDecorator — P1.M1.T4.S1"
      src/provider/proxy.ts       -> "// StreamProxy — P1.M2.T2.S1"
      src/state/controller.ts     -> "// TransitionController FSM — P1.M3.T1.S1"
      src/state/coordinator.ts    -> "// TransitionCoordinator — P1.M4.T4.S1"
  - CREATE these .gitkeep files (empty):
      src/config/.gitkeep
      src/diagnostics/.gitkeep
      src/buffer/.gitkeep
      src/shortcut/.gitkeep
      src/request/.gitkeep
  - WHY: empty dirs aren't git-tracked; stubs/.gitkeep make the tree durable and document owners.
  - GOTCHA: stub .ts files MUST be valid TS (a leading // comment compiles fine). Do not add
    exports that later subtasks would have to reconcile.

Task 5: CREATE tests/smoke.test.ts
  - IMPLEMENT: a Bun test that imports the default factory and asserts it is a function.
  - CONTENT (approximate):
      import { test, expect } from "bun:test";
      import stopThinkingExtension from "../src/index";

      test("exports a factory function", () => {
        expect(typeof stopThinkingExtension).toBe("function");
      });

      test("factory accepts an ExtensionAPI-like object without throwing (no-op)", () => {
        expect(() => stopThinkingExtension({} as never)).not.toThrow();
      });
  - PATTERN: Bun's built-in `bun:test` runner (no external test framework). See
    https://bun.sh/docs/test/writers for API.
  - GOTCHA: import from "../src/index" (TS source) — Bun runs TS natively, no pre-build needed.
    Because index.ts uses `import type`, no peer-dep runtime load occurs during the test.

Task 6: CREATE README.md  (Mode A skeleton)
  - IMPLEMENT: title, one-paragraph description, "Under Development" notice, install placeholder.
  - CONTENT sections:
      # pi-stop-thinking
      > **⚠️ Under Development** — not yet functional. Tracking Phase 0 foundation work.
      (one paragraph: what the extension will do once complete, per PRD §1 Executive Summary)
      ## Status
      - [x] Project scaffold
      - [ ] Configuration / Diagnostics / Provider decorator / Factory wiring (Phase 0)
      - ... (high-level phase checklist from PRD §50 roadmap, unchecked)
      ## Development
      ```bash
      bun install
      bun run build
      bun test
      ```
  - SCOPE: skeleton only. Full docs land in P1.M8.T5.S1.
```

### Implementation Patterns & Key Details

```typescript
// The ONLY runtime surface for this subtask — a compiling, runnable, no-op factory.
// Key: TYPE-ONLY import so bun test never loads the peer runtime.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function stopThinkingExtension(_pi: ExtensionAPI): void {
  // intentionally empty — Phase 0 = observational equivalence (zero behavior)
  // wiring arrives in P1.M1.T5.S1
}
```

```jsonc
// tsconfig.json — bundler resolution so bare imports resolve via package.json "exports"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",   // resolves @earendil-works/* via their exports field
    "strict": true,
    "declaration": true,             // emit dist/*.d.ts
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,            // pi-* .d.ts are large; skip their internal checks
    "esModuleInterop": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "lib": ["ES2022"],
    "types": ["bun"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### Integration Points

```yaml
BUILD:
  - entry: src/index.ts (default export)
  - emit: dist/index.js + dist/index.d.ts (consumed by Pi as package "main"/"types")
  - command: "bun run build" -> tsc

DEPENDENCIES (package.json):
  peerDependencies (runtime, provided by Pi):
    "@earendil-works/pi-ai": "*"
    "@earendil-works/pi-coding-agent": "*"
  devDependencies (local type-check/build/test):
    typescript, @types/bun, + BOTH peer deps pinned to installed versions
  # No "dependencies" block — extension must not bundle runtime deps that Pi already provides.

GIT:
  - dist/ already ignored by .gitignore (no change needed)
  - node_modules/ already ignored
  - DO NOT add plan/, PRD.md, or any task/PRP files to .gitignore (forbidden by PRP rules)
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# After creating package.json + tsconfig.json:
bun install                       # installs devDeps (incl. pinned peer deps + typescript + @types/bun)
# Expected: completes; may warn about peer deps (that's fine — they're provided by Pi at runtime).

# Type-check the whole project (the core acceptance gate for THIS subtask):
bunx tsc --noEmit                 # or: bun run typecheck
# Expected: ZERO diagnostics. If "Cannot find module '@earendil-works/pi-...'" ->
#   you forgot to also list the peer deps as devDependencies (see CRITICAL gotcha).

# Build (emit dist):
bun run build                     # = tsc
# Expected: dist/index.js and dist/index.d.ts created; exit 0.
ls dist/                          # must show index.js + index.d.ts (+ maps)
```

### Level 2: Unit / Smoke Tests (Component Validation)

```bash
# Run the Bun smoke test:
bun test
# Expected: 2 passing (factory is a function; no-op invocation doesn't throw).
```
> Reference for Bun test API: https://bun.sh/docs/test/writers

### Level 3: Integration (Package Integrity)

```bash
# Verify the emitted entry is importable as built JS (simulates Pi loading dist/index.js):
node -e "import('./dist/index.js').then(m => console.log('default typeof:', typeof m.default))"
# Expected: "default typeof: function"

# Verify package.json manifest fields are correct:
node -e "const p=require('./package.json'); console.log(
  p.name, p.type, p.main, p.keywords.includes('pi-package'),
  !!p.peerDependencies['@earendil-works/pi-ai'],
  !!p.devDependencies['@earendil-works/pi-coding-agent']);"
# Expected: pi-stop-thinking module ./dist/index.js true true true

# Verify tsconfig produced declarations (Pi reads "types"):
test -f dist/index.d.ts && echo "declarations OK" || echo "MISSING declarations"
```

### Level 4: Domain-Specific Validation (Scope Boundaries)

```bash
# Confirm NO behavioral logic leaked in (Phase 0 = zero behavior).
# The factory body must be empty/no-op:
grep -c "registerShortcut\|registerApiProvider\|registerProvider" src/index.ts
# Expected: 0  (any of these would mean we implemented T4/T5 out of scope).

# Confirm the full src/ tree exists and is git-tracked:
git add -A && git status --short
# Expected: package.json, tsconfig.json, README.md, src/**, tests/smoke.test.ts staged.
git ls-files src/ | sort
# Expected: index.ts, types.ts, provider/{decorator,proxy}.ts, state/{controller,coordinator}.ts,
#           and .gitkeep under config/diagnostics/buffer/shortcut/request.
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `bun install` succeeds.
- [ ] `bunx tsc --noEmit` → **zero** diagnostics (the primary gate).
- [ ] `bun run build` emits `dist/index.js` + `dist/index.d.ts`.
- [ ] `bun test` passes (2 tests).
- [ ] `node -e "...import('./dist/index.js')..."` prints `default typeof: function`.

### Feature Validation
- [ ] `package.json`: name `pi-stop-thinking`, `type: module`, `main: ./dist/index.js`,
      `keywords` incl. `pi-package`+`pi-extension`, peer deps present, dev deps present.
- [ ] `tsconfig.json`: ES2022, strict, bundler resolution, declaration:true, outDir ./dist.
- [ ] `src/index.ts`: default-export factory, `import type { ExtensionAPI }`, empty body.
- [ ] All `src/` subdirs from the contract exist & are git-tracked (stubs/.gitkeep).
- [ ] `README.md` skeleton with "Under Development" notice.
- [ ] Phase 0 zero-behavior preserved (no provider/shortcut registration in the stub).

### Code Quality & Documentation
- [ ] Stub files carry a comment naming their future owning subtask (documents intent).
- [ ] `dist/` ignored by git (already true); no forbidden files added to `.gitignore`.
- [ ] No `dependencies` block (only peers + devDeps).

---

## Anti-Patterns to Avoid

- ❌ Don't use the **raw-`.ts` + `"pi.extensions"`** pattern (that's pi-bar / built-in examples).
  This project is the **compiled/dist** pattern with `"main": "./dist/index.js"`.
- ❌ Don't declare peer deps with `"*"` **only** — `tsc` will fail to resolve types. Also add them
  as pinned `devDependencies`.
- ❌ Don't use a value import of `ExtensionAPI` in `src/index.ts` — use `import type` so the Bun
  smoke test doesn't drag in the heavy pi-coding-agent runtime.
- ❌ Don't implement any provider/shortcut/config/diagnostics logic now (owned by T2–T5). The
  factory body stays empty — Phase 0 requires observational equivalence.
- ❌ Don't set `"private": true` (this is a publishable package, unlike the local examples).
- ❌ Don't add `plan/`, `PRD.md`, `tasks.json`, or PRP files to `.gitignore`.
- ❌ Don't downgrade `moduleResolution` to `node`/`node16` — use `bundler` per external_deps.md §4.

---

## Confidence Score: **9/10**

This is a deterministic, greenfield scaffold with exact file contents specified, verified peer-dep
versions, confirmed import/export paths, and a validated compilation strategy (peer+dev dual
listing). The only residual risk is the exact Bun/TypeScript version `@types/bun` resolves to, but
`bun test` + `tsc` are standard and the smoke test is intentionally minimal.
