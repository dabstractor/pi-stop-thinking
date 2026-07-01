# PRP — P1.M2.T1.S1: Event Classification & Transition State Types (`src/types.ts`)

> **Extension**: `pi-stop-thinking` — Stop Thinking & Do (interrupt z.ai reasoning → answer)
> **Subtask**: P1.M2.T1.S1 (Phase 1 Event Proxy, 1 pt) — a **types-only** module. Define the
> `TransitionState` string-literal union (PRD §15), the `ProxyPhase` phase union, four event-class
> **type guards** (`isThinkingEvent`, `isTextEvent`, `isToolCallEvent`, `isTerminalEvent`), the
> narrowing event-family aliases, and **re-export `AssistantMessageEvent`** from `@earendil-works/pi-ai`.
> No runtime side effects, no state, no dependencies on any other module.
> **Consumed by**: P1.M2.T2.S1 (StreamProxy), P1.M3.T1.S1 (TransitionController).
> **Builds on**: Phase 0 (P1.M1.*) is landed (config / diagnostics / ProviderDecorator / factory). This
> is the **first Phase-1 module** and the shared vocabulary every later streaming/state module imports.
>
> **Parallel context**: P1.M1.T5.S1 (factory `src/index.ts`) is being implemented in parallel. Its PRP is
> treated as a CONTRACT and is **untouched** by this subtask — the factory does not import `src/types.ts`
> (verified: nothing imports it yet). No overlap, no conflict.

---

## Goal

**Feature Goal**: Replace the placeholder `src/types.ts` (currently a single comment) with the
authoritative shared type vocabulary for the extension: the `TransitionState` FSM union (PRD §15,
§16, §17), the `ProxyPhase` phase union (PRD §18 columns + §21/§39 splicing), four runtime
**type-guard** functions that classify a stream `AssistantMessageEvent` into its family
(thinking / text / toolcall / terminal), and the `Extract`-based narrowing aliases those guards
return. Re-export `AssistantMessageEvent` from `@earendil-works/pi-ai` so downstream modules
import a single local entry point. Conform to PRD Appendix F ("State transitions shall be
represented explicitly using discriminated unions … Boolean flag combinations shall not be used to
encode lifecycle state") — i.e. **string-literal unions, not enums, not booleans**. Full **JSDoc
(Mode A)** on every export, with each type guard referencing the PRD §18 event-classification row(s)
it implements.

**Deliverable**:
- `src/types.ts` exporting: `TransitionState`, `ProxyPhase`, the four `is*Event` type-guard
  functions, the `*Event` / `*EventType` narrowing aliases (`ThinkingEvent`/`ThinkingEventType`,
  `TextEvent`/`TextEventType`, `ToolCallEvent`/`ToolCallEventType`, `TerminalEvent`/
  `TerminalEventType`), and the re-exported `AssistantMessageEvent`. Mode-A JSDoc throughout
  (module banner + per-export preconditions/postconditions/side-effects per Appendix F).
- `tests/types.test.ts` — Bun unit tests that, for **each** of the 12 `AssistantMessageEvent.type`
  values, assert exactly the right type-guard(s) return `true` and all others `false`, plus
  exhaustiveness (no event is unclassified / double-classified) and the type-narrowing contract
  (a guarded event exposes the family-specific payload, e.g. `thinking_delta` → `.delta: string`).

**Success Definition**: From a clean checkout, `npx bun run typecheck` → 0 diagnostics;
`npx bun run build` → `dist/types.js` + `dist/types.d.ts` emitted with all symbols;
`npx bun test` → all green (new `types.test.ts` + every existing suite). The four guards are real
TypeScript type predicates (`event is XxxEvent`) so downstream `if (isThinkingEvent(e)) { e.delta }`
type-checks without casts. No edits anywhere except `src/types.ts` (+ new `tests/types.test.ts`).

---

## Why

- **Shared vocabulary for the whole streaming/state stack.** Every Phase-1+ module reasons about
  *which kind of stream event* it is looking at and *which FSM state* the transition is in. This
  module is the single source of truth for both, imported by StreamProxy (P1.M2.T2.S1), the FSM
  (P1.M3.T1.S1), reasoning detection (P1.M4.T2), and splicing (P1.M7). Getting the classification
  right here — once, with verified discriminator strings — means later modules get narrowing + the
  §18 rules for free instead of re-deriving them (and re-introducing the `message_start`/`start`
  naming traps).
- **Type-safe event handling = the §18/§39 invariants, enforced at compile time.** PRD §18's
  *"only one `message_end` event may ever reach the Pi agent runtime"* is operationally a
  "identify the terminal event" question; `isTerminalEvent` is the predicate StreamProxy will use to
  single-flush during splicing (§39: "Suppress terminal completion"). Type guards let the proxy
  branch on event family with the family's real payload available — no casts, no `any`.
- **Appendix F compliance.** The PRD mandates discriminated unions / strongly-typed state
  representation and forbids boolean-flag lifecycle encoding. `TransitionState` as a string-literal
  union is the literal fulfilment; it is what the TransitionController (P1.M3.T1.S1) switches on.
- **Phase-1 kickoff.** This is task T1 of Phase 1 ("Event Proxy") — the types land before the proxy
  that consumes them, so P1.M2.T2.S1 can be pure logic with no type-definition side quest.

## What

A TypeScript module `src/types.ts` that:

1. `import type { AssistantMessageEvent } from "@earendil-works/pi-ai";` (internal use) **and**
   `export type { AssistantMessageEvent } from "@earendil-works/pi-ai";` (re-export) — both required
   under `isolatedModules`.
2. Exports `TransitionState` — a string-literal union of the **11** PRD §15 states with EXACT
   capitalization: `Idle | Delegating | Reasoning | StopRequested | Aborting | Capturing |
   Restarting | Splicing | Answering | Completed | Failed`.
3. Exports `ProxyPhase = "forwarding" | "transitioning" | "splicing"`.
4. Exports the four event-family aliases (`*EventType` union of discriminators + `*Event` =
   `Extract<AssistantMessageEvent, { type: *EventType }>`) and the four **type-guard functions**:
   - `isThinkingEvent(e): e is ThinkingEvent` → `thinking_start | thinking_delta | thinking_end`
   - `isTextEvent(e): e is TextEvent` → `text_start | text_delta | text_end`
   - `isToolCallEvent(e): e is ToolCallEvent` → `toolcall_start | toolcall_delta | toolcall_end`
   - `isTerminalEvent(e): e is TerminalEvent` → `done | error`
5. Each guard checks `event.type` membership against a centralized `ReadonlySet<string>` of the
   family's discriminator literals (no magic inline strings — Appendix F "magic numbers are
   prohibited" / "provider-specific constants shall be centralized").
6. Mode-A JSDoc on the module banner (responsibility / ownership / lifecycle / invariants / failure
   modes per Appendix F) and on every export (preconditions / postconditions / side effects), with
   each guard citing the PRD §18 row(s) it implements and `isTerminalEvent` citing the §18
   single-`message_end` invariant.

**Out of scope** (owned by other subtasks — do NOT implement here):
- The `StreamProxy` class and its forwarding/splicing logic → **P1.M2.T2.S1**.
- The `TransitionController` FSM (transitions, validation, state table) → **P1.M3.T1.S1**. This
  module only *defines* `TransitionState`; it does NOT implement transitions.
- `ReasoningBuffer`, `*Event` payload handling beyond the guard's narrowing type, proxy phases'
  runtime transitions → later subtasks.
- Any edit to `src/index.ts`, `src/provider/*`, `src/state/*`, `src/config/*`, `src/diagnostics/*`,
  `package.json`, `tsconfig.json`, `.gitignore` → forbidden (owned by T1/T2/T3/T4/factory or T2+).

### Success Criteria

- [ ] `src/types.ts` exports `TransitionState`, `ProxyPhase`, the four `is*Event` guards, the
      `*Event`/`*EventType` aliases, and re-exports `AssistantMessageEvent`.
- [ ] `TransitionState` is a string-literal union with exactly the 11 PRD §15 literals (capitalized).
- [ ] `ProxyPhase` is exactly `"forwarding" | "transitioning" | "splicing"`.
- [ ] Each `is*Event` is a TypeScript **type predicate** (`e is XxxEvent`) — verifiable by a
      downstream narrowing test that compiles (`tsc` passes when accessing `.delta` after guard).
- [ ] Guards use the REAL `AssistantMessageEvent.type` discriminators (`start`, `text_*`,
      `thinking_*`, `toolcall_*`, `done`, `error`) — NEVER the PRD §18 conceptual names
      (`message_start`/`message_end`).
- [ ] `npx bun run typecheck` → **zero** diagnostics.
- [ ] `npx bun run build` emits `dist/types.js` + `dist/types.d.ts` with every symbol.
- [ ] `npx bun test tests/types.test.ts` → all green; `npx bun test` → all green (no regressions).
- [ ] Every export has Mode-A JSDoc; each guard references PRD §18; `isTerminalEvent` references the
      §18 single-`message_end` invariant.
- [ ] No edits outside `src/types.ts` and the new `tests/types.test.ts`.

---

## All Needed Context

### Context Completeness Check

> "If someone knew nothing about this codebase, would they have everything needed to implement this successfully?"

**Yes.** This PRP inlines the **exact, verified** `AssistantMessageEvent` discriminated-union shape
(read directly from the installed `@earendil-works/pi-ai@0.74.2` `.d.ts` — all 12 members + their
payload fields), the exact PRD §15 state literals (capitalization verified), the PRD §18
conceptual-name → real-discriminator mapping (the critical trap), the full reference implementation
of `src/types.ts`, the complete Bun test suite (with a synthetic-event factory), and the exact
build/test commands proven in this repo.

### Documentation & References

```yaml
# MUST READ — the single source of truth for the event union (verified against installed pkg)
- file: node_modules/@earendil-works/pi-ai/dist/types.d.ts
  why: "The authoritative AssistantMessageEvent discriminated union. type field = 'start' |
        'text_start'|'text_delta'|'text_end' | 'thinking_start'|'thinking_delta'|'thinking_end' |
        'toolcall_start'|'toolcall_delta'|'toolcall_end' | 'done' | 'error'. Payload shapes:
        thinking/text/toolcall *_delta carry delta:string; *_end carry content:string (text_end/
        thinking_end) or toolCall:ToolCall (toolcall_end); all partial-update members carry
        contentIndex:number + partial:AssistantMessage; done carries {reason, message};
        error carries {reason, error}. This module's guards narrow THIS union."
  critical: "The discriminators are 'start' (NOT 'message_start'), 'done'/'error' (NOT 'message_end'),
        and 'toolcall_*' (NOT 'tool_call'). PRD §18 uses conceptual names — guards MUST use the REAL
        type strings or they will silently never match."

- file: plan/001_b0c6691bb424/P1M2T1S1/research/event-types-research.md
  why: "The verified discriminator table, the §18 conceptual-name→real-discriminator mapping, the
        Appendix F citation, the isolatedModules re-export rationale, and the ReadonlySet strategy."
  critical: "Do NOT confuse PRD §18 'message_start'/'message_end' with real types 'start'/'done'/'error'.
        isTerminalEvent covers BOTH done and error (the single message_end invariant)."

# PRD authority (PRD.md in repo root)
- url: PRD.md §15 "State Machine" (States + State Descriptions)
  why: "Defines the 11 FSM states (Idle|Delegating|Reasoning|StopRequested|Aborting|Capturing|
        Restarting|Splicing|Answering|Completed|Failed) and the no-implicit-flags mandate."
  critical: "EXACT literal set + capitalization for TransitionState. Reasoning: 'Shortcut becomes
        active.' Completed/Failed: 'Reset.' — these states drive P1.M3.T1.S1's transition table."

- url: PRD.md §16 "State Transition Table" + §17 "State Invariants"
  why: "Shows how TransitionState values flow (Idle→Delegating→Reasoning→…→Completed/Failed→Idle; Any→Failed).
        Confirms the union is the closed set consumed by the FSM."
  critical: "This module DEFINES the union only — it does NOT implement transitions (that is P1.M3.T1.S1)."

- url: PRD.md §18 "Event Forwarding Rules"
  why: "The event-classification table the guards implement: thinking_* (Forward/Ignore/Never-emit),
        text_* (Forward/Replacement-only/Forward), tool_call (Forward/Suspend/Forward),
        message_end (Forward/Suppress-upstream/Forward-replacement)."
  critical: "§18 says 'only one message_end event may ever reach the Pi agent runtime' → isTerminalEvent
        (done|error) is the predicate that enforces single-flush during splicing. Map §18's 'message_start'
        to real type 'start' and §18's 'message_end' to real types 'done'|'error'."

- url: PRD.md §38 "Event Ordering Specification" (Legal/Illegal Event Sequence) + §39 "Transition Event Rules"
  why: "Legal sequence: start → thinking_start → thinking_delta* → thinking_end? → text_start →
        text_delta* → tool_call* → tool_result* → (done|error). §39: during transition, suppress
        terminal completion + obsolete thinking; forbidden: duplicate start, duplicate terminal,
        replacement before ownership changes."
  critical: "Confirms the four families partition ALL non-'start' events and that 'start' is lifecycle
        (emitted once), NOT a thinking/text/toolcall/terminal event — so none of the four guards match 'start'."

- url: PRD.md Appendix F — "Coding Standards"
  why: "Verbatim authority: 'State transitions shall be represented explicitly using discriminated
        unions or equivalent strongly typed constructs.' / 'Boolean flag combinations shall not be used
        to encode lifecycle state.' / 'Magic numbers are prohibited.' / 'Provider-specific constants
        shall be centralized.'"
  critical: "TransitionState MUST be a string-literal union (this task explicitly requests it) — not an
        enum, not booleans. The *_TYPES Sets centralize the families (no inline magic strings). Every
        export gets the Appendix-F doc (responsibility/ownership/lifecycle/invariants/failure-modes)."

- url: plan/001_b0c6691bb424/architecture/module_contracts.md
  why: "TransitionController contract lists getState(): TransitionState + canInterrupt(); StreamProxy
        'track reasoning state via event types' + 'suppress upstream terminal events' — both consume
        THIS module's types/guards."
  critical: "Confirms TransitionState + the guards are the shared surface downstream modules import from
        src/types.ts. Keep exports stable (P1.M2.T2 / P1.M3.T1 depend on these names)."

- url: plan/001_b0c6691bb424/architecture/external_deps.md §1 "pi-ai"
  why: "AssistantMessageEvent is imported from @earendil-works/pi-ai (peerDependency). Confirms the
        import path + that it is a type-only import (use `import type` / `export type`)."
  critical: "Re-export path is '@earendil-works/pi-ai' (bare specifier). It is type-only → erased at emit."

# REFERENCE — established repo conventions to mirror
- file: tests/diagnostics.test.ts   # (P1.M1.T3.S1)
  why: "The proven Bun test style in THIS repo: import { describe, test, expect } from 'bun:test';
        flat tests/ dir; ../src/* imports; helper-factory pattern; descriptive describe() blocks."
  pattern: "Mirror its flat helper functions, table-driven per-level loop, and JSON-shape assertions
        for the types.test.ts suite (table-driven per-event-type)."
- file: tests/provider-decorator.test.ts   # (P1.M1.T4.S1)
  why: "Shows the `noop`/stub style + sentinel objects + `as unknown` casts for synthetic doubles —
        reuse for synthetic AssistantMessageEvent fixtures."
```

### Current Codebase tree (Phase 0 landed; Phase 1 starting here)

```bash
.
├── package.json          # T1: scripts build(=tsc)/test(=bun test)/typecheck(=tsc --noEmit); main ./dist/index.js; type module
├── tsconfig.json         # T1: ES2022, strict, bundler, isolatedModules:true, outDir dist, rootDir src,
│                         #     include src/**/*.ts, exclude [node_modules, dist, tests], types:["bun"]
├── README.md             # T1/factory
├── src/
│   ├── index.ts          # factory (P1.M1.T5.S1 — parallel; DO NOT touch)
│   ├── types.ts          # ← T1 PLACEHOLDER (one comment line) — THIS becomes real
│   ├── provider/{decorator,proxy}.ts   # decorator=factory-era DONE; proxy=T1 stub (DO NOT touch)
│   ├── state/{controller,coordinator}.ts   # T1 stubs (DO NOT touch — owned by P1.M3)
│   ├── config/index.ts   # DONE (loadConfig/Config)
│   ├── diagnostics/index.ts # DONE (createDiagnostics)
│   ├── buffer/.gitkeep   # later
│   ├── shortcut/.gitkeep # later
│   └── request/.gitkeep  # later
├── tests/
│   ├── smoke.test.ts        # T1 (must stay green)
│   ├── config.test.ts       # T2 (must stay green)
│   ├── diagnostics.test.ts  # T3 (must stay green)
│   ├── provider-decorator.test.ts # T4 (must stay green)
│   └── factory.test.ts      # factory (parallel; DO NOT touch)
└── dist/                 # generated by tsc (git-ignored)
```

### Desired Codebase tree (after this subtask)

```bash
.
├── src/
│   └── types.ts          # REAL (replaces placeholder) — TransitionState, ProxyPhase, 4 guards, aliases, re-export
│   └── ...               # all other src/ files UNCHANGED
├── tests/
│   └── types.test.ts     # NEW — Bun unit tests (synthetic-event factory + table-driven assertions)
└── dist/{types.js,types.d.ts}  # GENERATED by `npx bun run build`
```
**File responsibilities**: `src/types.ts` = the sole shared type vocabulary (FSM state union +
proxy-phase union + event-family guards/aliases + re-export). Pure types + 4 pure functions, zero
state, zero side effects, zero imports of other project modules (only the pi-ai type re-export).
`tests/types.test.ts` = exhaustive per-event-type classification + narrowing contract. No other file
is touched (NOT the factory, NOT proxy/state stubs, NOT config/diagnostics, NOT package.json).

### Known Gotchas of our codebase & Library Quirks

```typescript
// CRITICAL (PRD §18 names are CONCEPTUAL, not real types): §18 says "message_start"/"message_end",
// but AssistantMessageEvent.type is 'start' / 'done' / 'error'. The guards MUST test the REAL
// discriminators. isTerminalEvent covers BOTH 'done' and 'error' (the §18 "one message_end" invariant).
// §18 says "tool_call" but the real discriminator family is 'toolcall_*' (no underscore).

// CRITICAL (no enum, no booleans — Appendix F): TransitionState is a string-LITERAL union
// ("Idle" | "Delegating" | …). Do NOT use a TS enum (it would emit an object + break tree-shaking) and
// do NOT encode states as boolean flags. The FSM in P1.M3.T1.S1 switches on this union exhaustively.

// CRITICAL (capitalization): the PRD §15 states are TitleCase single words EXCEPT StopRequested,
// StopRequested etc. Use EXACTLY: Idle, Delegating, Reasoning, StopRequested, Aborting, Capturing,
// Restarting, Splicing, Answering, Completed, Failed. Case-sensitive — a wrong case breaks the FSM.

// GOTCHA (isolatedModules requires split import + re-export): `export type { AssistantMessageEvent }`
// re-exports the symbol, but you ALSO need `import type { AssistantMessageEvent }` for the local
// guard parameter type. Two `type`-only statements; both erased at emit (no runtime import of pi-ai).

// GOTCHA (guards must be type predicates, not plain booleans): signature is
//   (event: AssistantMessageEvent): event is ThinkingEvent
// so `if (isThinkingEvent(e)) e.delta` type-checks. Returning a bare `boolean` loses narrowing and
// forces downstream casts — fails the "type-safe event handling" goal.

// GOTCHA (Extract narrowing needs the type literal): ThinkingEvent = Extract<AssistantMessageEvent,
// { type: ThinkingEventType }> where ThinkingEventType is the union of the 3 discriminator strings.
// Use the SAME *EventType union for both the Extract and the ReadonlySet (single source of truth).

// GOTCHA (no partial events outside their family): 'start' matches NONE of the four guards (it is a
// lifecycle event, not thinking/text/toolcall/terminal). The test suite MUST assert isThinkingEvent/
// isTextEvent/isToolCallEvent/isTerminalEvent all return FALSE for { type: 'start' }.

// GOTCHA (bun is a local devDep, NOT on PATH): invoke as `npx bun ...` / `npx bun run <script>`,
// NOT bare `bun`/`bunx`. package.json scripts resolve via `npx bun run`.

// GOTCHA (build excludes tests): tsconfig exclude:["tests"] → `npx bun run typecheck` checks src ONLY.
// tests/types.test.ts is validated by `npx bun test` (Bun runs TS natively). The narrowing contract
// test in tests/types.test.ts proves the type predicate works at COMPILE time only if tsc is run on a
// file that exercises it — keep that assertion as a value-level (runtime) guard-result check so it
// runs under `bun test`, and separately rely on `npx bun run typecheck` for the compile-time narrowing.
```

---

## Implementation Blueprint

### Data models and structure

```typescript
// src/types.ts — pure type vocabulary + 4 pure type-guard functions. No state, no side effects.

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
// Re-export so downstream modules import a single local entry point (StreamProxy, TransitionController).
export type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * # Shared Event & State Types
 * (responsibility / ownership / lifecycle / invariants / failure modes — Appendix F)
 * …see full JSDoc in "Implementation Patterns"…
 */

/** PRD §15 — the 11 FSM states. String-literal union (Appendix F: no enums, no boolean flags). */
export type TransitionState =
  | "Idle"
  | "Delegating"
  | "Reasoning"
  | "StopRequested"
  | "Aborting"
  | "Capturing"
  | "Restarting"
  | "Splicing"
  | "Answering"
  | "Completed"
  | "Failed";

/** StreamProxy event-authority phase (PRD §18 columns + §21 splicing). */
export type ProxyPhase = "forwarding" | "transitioning" | "splicing";

// Event families (PRD §18). Each family = a discriminator union + an Extract-narrowed alias + a guard.
export type ThinkingEventType = "thinking_start" | "thinking_delta" | "thinking_end";
export type TextEventType = "text_start" | "text_delta" | "text_end";
export type ToolCallEventType = "toolcall_start" | "toolcall_delta" | "toolcall_end";
export type TerminalEventType = "done" | "error";

export type ThinkingEvent = Extract<AssistantMessageEvent, { type: ThinkingEventType }>;
export type TextEvent = Extract<AssistantMessageEvent, { type: TextEventType }>;
export type ToolCallEvent = Extract<AssistantMessageEvent, { type: ToolCallEventType }>;
export type TerminalEvent = Extract<AssistantMessageEvent, { type: TerminalEventType }>;

// Centralized family membership Sets (Appendix F: no magic inline strings).
const THINKING_TYPES: ReadonlySet<string> = new Set<ThinkingEventType>([
  "thinking_start", "thinking_delta", "thinking_end",
]);
const TEXT_TYPES: ReadonlySet<string> = new Set<TextEventType>(["text_start", "text_delta", "text_end"]);
const TOOLCALL_TYPES: ReadonlySet<string> = new Set<ToolCallEventType>([
  "toolcall_start", "toolcall_delta", "toolcall_end",
]);
const TERMINAL_TYPES: ReadonlySet<string> = new Set<TerminalEventType>(["done", "error"]);

export function isThinkingEvent(event: AssistantMessageEvent): event is ThinkingEvent {
  return THINKING_TYPES.has(event.type);
}
export function isTextEvent(event: AssistantMessageEvent): event is TextEvent {
  return TEXT_TYPES.has(event.type);
}
export function isToolCallEvent(event: AssistantMessageEvent): event is ToolCallEvent {
  return TOOLCALL_TYPES.has(event.type);
}
export function isTerminalEvent(event: AssistantMessageEvent): event is TerminalEvent {
  return TERMINAL_TYPES.has(event.type);
}
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: REPLACE src/types.ts (placeholder comment → full module)
  - OVERWRITE the single comment line with the reference implementation in "Implementation Patterns".
  - IMPORT (type-only): `import type { AssistantMessageEvent } from "@earendil-works/pi-ai";`
  - RE-EXPORT (type-only): `export type { AssistantMessageEvent } from "@earendil-works/pi-ai";`
  - IMPLEMENT: TransitionState (11-literal union, EXACT capitalization); ProxyPhase (3 literals);
    ThinkingEventType/TextEventType/ToolCallEventType/TerminalEventType discriminator unions;
    ThinkingEvent/TextEvent/ToolCallEvent/TerminalEvent = Extract<…, { type: … }> aliases;
    THINKING_TYPES/TEXT_TYPES/TOOLCALL_TYPES/TERMINAL_TYPES ReadonlySet consts;
    isThinkingEvent/isTextEvent/isToolCallEvent/isTerminalEvent type-predicate functions.
  - NAMING: PascalCase type aliases (TransitionState, ProxyPhase, ThinkingEvent); camelCase type guards
    (isThinkingEvent); UPPER_SNAKE private Sets (THINKING_TYPES).
  - JSDOC (Mode A): module banner (responsibility/ownership/lifecycle/invariants/failure-modes per
    Appendix F); TransitionState (cite PRD §15/§16/§17 + Appendix F union mandate); ProxyPhase (cite
    PRD §18 columns + §21/§39); each *EventType/*Event alias (cite its discriminators); each guard
    (cite PRD §18 row + preconditions/postconditions/side-effects; isTerminalEvent cites the §18
    single-message_end invariant).
  - PLACEMENT: src/types.ts (already the placeholder; nothing imports it yet so rewrite is safe).
  - GOTCHA: real discriminators only ('start','done','error','toolcall_*' — NOT message_start/
    message_end/tool_call); type predicates not plain booleans; isolatedModules split import+re-export.

Task 2: CREATE tests/types.test.ts
  - IMPLEMENT: the suite in "Test Specification" using `bun:test`.
  - IMPORT: `import { describe, test, expect } from "bun:test";`
    `import { isThinkingEvent, isTextEvent, isToolCallEvent, isTerminalEvent } from "../src/types";`
    `import type { AssistantMessageEvent } from "@earendil-works/pi-ai";`
  - FOLLOW pattern: tests/diagnostics.test.ts (flat helpers, table-driven loops, describe groups).
  - HARNESS: a `makeEvent(type)` factory returning a minimal synthetic AssistantMessageEvent
    (`{ type } as unknown as AssistantMessageEvent` — only `.type` is read by the guards, so the rest
    can be omitted safely; see tests/provider-decorator.test.ts sentinel style).
  - COVERAGE: for EACH of the 12 types (start, text_start/delta/end, thinking_start/delta/end,
    toolcall_start/delta/end, done, error) assert which guards return true (exactly one for the 4
    families; ZERO for 'start'); exhaustiveness/double-classification check (sum of true guards ==
    expected per row); the terminal-pair check (done AND error both terminal; 'start' not terminal);
    proxy-phase/transition-state are compile-time-only (assert they exist via `satisfies`-style value
    samples if desired — optional).
  - NAMING: describe("isThinkingEvent" / "isTextEvent" / "isToolCallEvent" / "isTerminalEvent" /
    "event classification — exhaustiveness").
  - PLACEMENT: tests/types.test.ts (flat tests/ dir; excluded from build).

Task 3: VERIFY (validation only — no code changes)
  - RUN: npx bun run typecheck  → 0 diagnostics (confirms type predicates + Extract aliases compile,
    re-export resolves, isolatedModules happy).
  - RUN: npx bun run build      → dist/types.js + dist/types.d.ts created with all symbols.
  - RUN: npx bun test           → all green (types + decorator + diagnostics + config + smoke + factory).
  - RUN: Level 4 scope gates below (grep assertions on src/types.ts).
```

### Implementation Patterns & Key Details

```typescript
// src/types.ts — COMPLETE reference implementation. Author this verbatim (JSDoc included).

/**
 * # Shared Event & State Types
 *
 * **Responsibility** (PRD §27 Module Overview / Appendix F): define the shared vocabulary every
 * streaming and transition module imports — the {@link TransitionState} FSM union, the
 * {@link ProxyPhase} proxy-authority phase, and the four event-classification **type guards**
 * ({@link isThinkingEvent}/{@link isTextEvent}/{@link isToolCallEvent}/{@link isTerminalEvent}) over
 * {@link AssistantMessageEvent}.
 *
 * **Ownership**: type definitions + four pure functions. Owns NO runtime state.
 *
 * **Lifecycle**: stateless — imported for its exports; no init/dispose.
 *
 * **Invariants**: (1) The four guards partition every `AssistantMessageEvent` *except* `start` into
 * exactly one family; `start` matches none. (2) `isTerminalEvent` matches BOTH `done` and `error`
 * (PRD §18: "only one `message_end` event may ever reach the Pi agent runtime"). (3) State is a
 * string-literal union — never an enum, never boolean flags (PRD Appendix F).
 *
 * **Failure modes**: pure functions; the only failure is a malformed event with an unknown `type`,
 * for which every guard returns `false` (the event is treated as unclassified — safe default).
 *
 * Consumed by: StreamProxy (P1.M2.T2.S1), TransitionController (P1.M3.T1.S1), reasoning detection
 * (P1.M4.T2), stream splicing (P1.M7).
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
/** Re-export so downstream modules import from a single local entry point. */
export type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * The explicit finite-state-machine states for the stop-thinking transition (PRD §15 State Machine,
 * §16 State Transition Table, §17 State Invariants).
 *
 * Per PRD Appendix F: *"State transitions shall be represented explicitly using discriminated unions
 * or equivalent strongly typed constructs. Boolean flag combinations shall not be used to encode
 * lifecycle state."* — hence a string-literal union (not an enum, not booleans). The
 * TransitionController (P1.M3.T1.S1) switches on this union exhaustively.
 *
 * Flow: `Idle → Delegating → Reasoning → StopRequested → Aborting → Capturing → Restarting →
 * Splicing → Answering → Completed → Idle`; `Any → Failed → Idle`.
 */
export type TransitionState =
  | "Idle"
  | "Delegating"
  | "Reasoning"
  | "StopRequested"
  | "Aborting"
  | "Capturing"
  | "Restarting"
  | "Splicing"
  | "Answering"
  | "Completed"
  | "Failed";

/**
 * The StreamProxy's event-authority phase (PRD §18 Event Forwarding Rules columns + §21 Stream
 * Splicing / §39 Transition Event Rules).
 * - `"forwarding"` — §18 "Before Stop": forward all upstream events unmodified.
 * - `"transitioning"` — §18 "During Transition": suppress obsolete thinking + the upstream terminal
 *   completion; suspend tool calls.
 * - `"splicing"` — §21/§39: primary (upstream) suppressed, replacement stream authoritative.
 */
export type ProxyPhase = "forwarding" | "transitioning" | "splicing";

// ─────────────────────────────────────────────────────────────────────────────
// Event classification (PRD §18 Event Forwarding Rules)
// Each family: a discriminator union → an Extract-narrowed alias → a type guard.
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminators of the reasoning/thinking event family (PRD §18 `thinking_*` rows). */
export type ThinkingEventType = "thinking_start" | "thinking_delta" | "thinking_end";
/** Discriminators of the answer/text event family (PRD §18 `text_*` rows). */
export type TextEventType = "text_start" | "text_delta" | "text_end";
/** Discriminators of the tool-call event family (PRD §18 `tool_call` row; real discriminators are `toolcall_*`). */
export type ToolCallEventType = "toolcall_start" | "toolcall_delta" | "toolcall_end";
/** Discriminators of the terminal event family (PRD §18 `message_end` row → real `done` | `error`). */
export type TerminalEventType = "done" | "error";

/** A reasoning/thinking event (thinking_start | thinking_delta | thinking_end). */
export type ThinkingEvent = Extract<AssistantMessageEvent, { type: ThinkingEventType }>;
/** An answer/text event (text_start | text_delta | text_end). */
export type TextEvent = Extract<AssistantMessageEvent, { type: TextEventType }>;
/** A tool-call event (toolcall_start | toolcall_delta | toolcall_end). */
export type ToolCallEvent = Extract<AssistantMessageEvent, { type: ToolCallEventType }>;
/** A terminal event (done | error). */
export type TerminalEvent = Extract<AssistantMessageEvent, { type: TerminalEventType }>;

// Centralized family-membership sets (PRD Appendix F: "magic numbers are prohibited";
// "Provider-specific constants shall be centralized" — no inline discriminator strings in guards).
const THINKING_TYPES: ReadonlySet<string> = new Set<ThinkingEventType>([
  "thinking_start",
  "thinking_delta",
  "thinking_end",
]);
const TEXT_TYPES: ReadonlySet<string> = new Set<TextEventType>([
  "text_start",
  "text_delta",
  "text_end",
]);
const TOOLCALL_TYPES: ReadonlySet<string> = new Set<ToolCallEventType>([
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);
const TERMINAL_TYPES: ReadonlySet<string> = new Set<TerminalEventType>(["done", "error"]);

/**
 * Type guard: is `event` a reasoning/thinking event (`thinking_start` | `thinking_delta` |
 * `thinking_end`)?
 *
 * PRD §18 (thinking rows): Forward before stop / Ignore during transition / Never emit after restart.
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {thinking_start, thinking_delta, thinking_end}`;
 *   narrows to {@link ThinkingEvent} (exposes `contentIndex`, and `delta`/`content` for *_delta/*_end).
 * - Side effects: none. Ownership changes: none.
 */
export function isThinkingEvent(event: AssistantMessageEvent): event is ThinkingEvent {
  return THINKING_TYPES.has(event.type);
}

/**
 * Type guard: is `event` an answer/text event (`text_start` | `text_delta` | `text_end`)?
 *
 * PRD §18 (text rows): Forward before stop / Replacement-only during transition / Forward after restart.
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {text_start, text_delta, text_end}`; narrows to
 *   {@link TextEvent} (exposes `contentIndex`, and `delta`/`content` for *_delta/*_end).
 * - Side effects: none. Ownership changes: none.
 */
export function isTextEvent(event: AssistantMessageEvent): event is TextEvent {
  return TEXT_TYPES.has(event.type);
}

/**
 * Type guard: is `event` a tool-call event (`toolcall_start` | `toolcall_delta` | `toolcall_end`)?
 *
 * PRD §18 (tool_call row): Forward before stop / Suspend until replacement during transition /
 * Forward after restart. (Note: §18 names this `tool_call`; the real `AssistantMessageEvent.type`
 * discriminators are `toolcall_*`.)
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {toolcall_start, toolcall_delta, toolcall_end}`;
 *   narrows to {@link ToolCallEvent} (exposes `contentIndex`, and `delta`/`toolCall` for *_delta/*_end).
 * - Side effects: none. Ownership changes: none.
 */
export function isToolCallEvent(event: AssistantMessageEvent): event is ToolCallEvent {
  return TOOLCALL_TYPES.has(event.type);
}

/**
 * Type guard: is `event` a terminal event (`done` | `error`)?
 *
 * PRD §18 invariant: *"only one `message_end` event may ever reach the Pi agent runtime, regardless
 * of how many upstream provider requests occur internally."* §18 names this `message_end`; the real
 * terminal `AssistantMessageEvent.type` values are `done` (success) and `error` (failure/abort) —
 * this guard matches BOTH. During splicing the StreamProxy uses it to single-flush exactly one
 * terminal event downstream while suppressing upstream completion (PRD §39).
 *
 * - Preconditions: `event` is an `AssistantMessageEvent`.
 * - Postconditions: returns `true` iff `event.type ∈ {done, error}`; narrows to {@link TerminalEvent}
 *   (exposes `reason`, and `message` for `done` / `error` for `error`).
 * - Side effects: none. Ownership changes: none.
 */
export function isTerminalEvent(event: AssistantMessageEvent): event is TerminalEvent {
  return TERMINAL_TYPES.has(event.type);
}
```

### Integration Points

```yaml
EXPORTS (consumed by later subtasks — keep names STABLE):
  P1.M2.T2.S1 (StreamProxy):
      import type { AssistantMessageEvent, ProxyPhase } from "../types";
      import { isThinkingEvent, isTextEvent, isToolCallEvent, isTerminalEvent } from "../types";
      // → track reasoning state via isThinkingEvent; suppress upstream terminal via isTerminalEvent.
  P1.M3.T1.S1 (TransitionController):
      import type { TransitionState } from "../types";
      // → switches on TransitionState exhaustively; getState(): TransitionState.
  P1.M4.T2 (reasoning detection): isThinkingEvent to detect enter/leave reasoning (PRD §22).
  P1.M7 (splicing): isTerminalEvent for the single-flush invariant (PRD §39).

BUILD:
  - module: src/types.ts (included by tsconfig include:"src/**/*.ts").
  - emit: dist/types.js (the 4 guard fns + 4 Sets — the only runtime values) + dist/types.d.ts
    (all types + re-export + JSDoc). All `type` aliases erased at emit.
  - resolution: bare "@earendil-works/pi-ai" (peerDependency) via bundler moduleResolution.

NO CHANGES TO: src/index.ts (factory — parallel), src/provider/*, src/state/*, src/config/*,
  src/diagnostics/*, package.json, tsconfig.json, .gitignore, or any existing test. Only src/types.ts
  is edited + tests/types.test.ts is added.
```

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Type-check src (tsconfig excludes tests/ — intentional):
npx bun run typecheck        # = tsc --noEmit
# Expected: ZERO diagnostics. Common failures:
#   - "Cannot find name 'AssistantMessageEvent'" → confirm `import type` from "@earendil-works/pi-ai".
#   - Extract-alias error → confirm *EventType union strings EXACTLY match the union member `type` values.
#   - isolatedModules error on re-export → confirm `export type { … }` (type-only), not `export { … }`.
#   - guard return type error → confirm signature is `event is ThinkingEvent` (a type predicate).

# Build (emit dist):
npx bun run build            # = tsc
# Expected: dist/types.js + dist/types.d.ts created; exit 0.
ls dist/types.*              # must show types.js + types.d.ts (+ .map)
```
> NOTE: `bun`/`tsc` are local devDeps NOT on PATH — invoke via `npx bun ...` / `npx bun run <script>`
> (verified working in this repo). Bare names only resolve inside `npx bun run <script>`.

### Level 2: Unit Tests (Component Validation)

```bash
# Run the types suite alone:
npx bun test tests/types.test.ts
# Expected: all green — for each of the 12 event types exactly the expected guard(s) return true;
#   'start' matches ZERO guards; 'done' AND 'error' both match isTerminalEvent; no double-classification.

# Full suite (types + factory + decorator + diagnostics + config + smoke):
npx bun test
# Expected: every test passes; nothing regressed.
```
> Bun test API: https://bun.sh/docs/test/writers — `import { describe, test, expect } from "bun:test"`.

### Level 3: Integration (Package Integrity)

```bash
# Verify the emitted module is importable as built JS and exposes the 4 guards as functions:
node -e "import('./dist/types.js').then(m => console.log({
  thinking: typeof m.isThinkingEvent,
  text: typeof m.isTextEvent,
  toolcall: typeof m.isToolCallEvent,
  terminal: typeof m.isTerminalEvent
}))"
# Expected: { thinking: 'function', text: 'function', toolcall: 'function', terminal: 'function' }
# (AssistantMessageEvent/TransitionState/ProxyPhase are type-only → erased; not present at runtime — correct.)

# Spot-check a guard against real built JS (synthetic event via a minimal object — only .type is read):
node -e "import('./dist/types.js').then(({ isTerminalEvent }) => {
  console.log('done is terminal:', isTerminalEvent({ type: 'done' }));       // true
  console.log('error is terminal:', isTerminalEvent({ type: 'error' }));     // true
  console.log('start is terminal:', isTerminalEvent({ type: 'start' }));     // false
  console.log('thinking_delta is terminal:', isTerminalEvent({ type: 'thinking_delta' })); // false
});"
# Expected: done/error true; start/thinking_delta false. (Guards read ONLY event.type, so a bare
#   { type } object is sufficient — matches the runtime contract; full payload is irrelevant here.)
```

### Level 4: Creative & Domain-Specific Validation (Scope Boundaries)

```bash
# Real-discriminator gate — guards use REAL types, never PRD §18 conceptual names:
grep -n "message_start\|message_end\|tool_call" src/types.ts
# Expected: ZERO matches in the Set/discriminator literals (only allowed inside JSDoc prose explaining
#   the mapping). The actual discriminator strings must be 'start','done','error','toolcall_*'.

# Type-predicate gate — all four guards are type predicates (not plain booleans):
grep -n "event is ThinkingEvent\|event is TextEvent\|event is ToolCallEvent\|event is TerminalEvent" src/types.ts
# Expected: exactly 4 matches (one per guard signature).

# No-enum/no-boolean gate — TransitionState is a string-literal union:
grep -n "enum \|: boolean" src/types.ts
# Expected: ZERO `enum` declarations and ZERO state-encoding booleans. (ProxyPhase/TransitionState are
#   `= "…" | "…"` unions.)

# Re-export gate — AssistantMessageEvent is re-exported (type-only):
grep -n "export type { AssistantMessageEvent }" src/types.ts
# Expected: exactly 1 match.

# State-count gate — exactly the 11 PRD §15 literals present:
for s in Idle Delegating Reasoning StopRequested Aborting Capturing Restarting Splicing Answering Completed Failed; do
  grep -q "\"$s\"" src/types.ts && echo "OK $s" || echo "MISSING $s"
done
# Expected: OK for all 11; no extras.

# Confirm git sees only the intended changes (no edits to other modules):
git add -A && git status --short
# Expected: MODIFIED src/types.ts, NEW tests/types.test.ts (+ regenerated dist/* if not git-ignored).
#   src/index.ts, src/provider/*, src/state/*, src/config/*, src/diagnostics/* unchanged.
```

---

## Test Specification (reference suite — implement with `bun:test`)

```typescript
// tests/types.test.ts

import { describe, test, expect } from "bun:test";
import {
  isThinkingEvent,
  isTextEvent,
  isToolCallEvent,
  isTerminalEvent,
} from "../src/types";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

// --- test doubles ---------------------------------------------------------

/**
 * Build a synthetic AssistantMessageEvent carrying only a `type`. The guards read ONLY `event.type`,
 * so the rest of the payload is irrelevant to classification (same sentinel style as
 * provider-decorator.test.ts). `as unknown as` is safe because no guard touches other fields.
 */
function makeEvent(type: string): AssistantMessageEvent {
  return { type } as unknown as AssistantMessageEvent;
}

const ALL_TYPES = [
  "start",
  "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
  "done", "error",
] as const;

// Expected guard results per event type: [thinking, text, toolcall, terminal].
const EXPECTED: Record<string, [boolean, boolean, boolean, boolean]> = {
  start:          [false, false, false, false],
  text_start:     [false, true,  false, false],
  text_delta:     [false, true,  false, false],
  text_end:       [false, true,  false, false],
  thinking_start: [true,  false, false, false],
  thinking_delta: [true,  false, false, false],
  thinking_end:   [true,  false, false, false],
  toolcall_start: [false, false, true,  false],
  toolcall_delta: [false, false, true,  false],
  toolcall_end:   [false, false, true,  false],
  done:           [false, false, false, true],
  error:          [false, false, false, true],
};

function classify(type: string): [boolean, boolean, boolean, boolean] {
  const e = makeEvent(type);
  return [isThinkingEvent(e), isTextEvent(e), isToolCallEvent(e), isTerminalEvent(e)];
}

// --- per-guard groups (table-driven) --------------------------------------

describe("isThinkingEvent", () => {
  test("true only for the thinking_* family", () => {
    for (const t of ["thinking_start", "thinking_delta", "thinking_end"]) {
      expect(isThinkingEvent(makeEvent(t))).toBe(true);
    }
    for (const t of ALL_TYPES) {
      if (!t.startsWith("thinking")) expect(isThinkingEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("isTextEvent", () => {
  test("true only for the text_* family", () => {
    for (const t of ["text_start", "text_delta", "text_end"]) {
      expect(isTextEvent(makeEvent(t))).toBe(true);
    }
    for (const t of ALL_TYPES) {
      if (!t.startsWith("text_")) expect(isTextEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("isToolCallEvent", () => {
  test("true only for the toolcall_* family (NOT 'tool_call')", () => {
    for (const t of ["toolcall_start", "toolcall_delta", "toolcall_end"]) {
      expect(isToolCallEvent(makeEvent(t))).toBe(true);
    }
    for (const t of ALL_TYPES) {
      if (!t.startsWith("toolcall")) expect(isToolCallEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("isTerminalEvent", () => {
  test("true for BOTH done and error (the single message_end invariant, PRD §18)", () => {
    expect(isTerminalEvent(makeEvent("done"))).toBe(true);
    expect(isTerminalEvent(makeEvent("error"))).toBe(true);
  });

  test("false for start (lifecycle) and every partial-update family", () => {
    expect(isTerminalEvent(makeEvent("start"))).toBe(false);
    for (const t of ALL_TYPES) {
      if (t !== "done" && t !== "error") expect(isTerminalEvent(makeEvent(t))).toBe(false);
    }
  });
});

describe("event classification — exhaustiveness & partition", () => {
  test("'start' matches NO guard (it is a lifecycle event)", () => {
    expect(classify("start")).toEqual([false, false, false, false]);
  });

  test("every non-start event matches EXACTLY ONE guard (no double-classification, none unclassified)", () => {
    for (const t of ALL_TYPES) {
      const results = classify(t);
      const trueCount = results.filter(Boolean).length;
      if (t === "start") {
        expect(trueCount).toBe(0); // lifecycle: unclassified by design
      } else {
        expect(trueCount).toBe(1); // every other event → exactly one family
      }
    }
  });

  test("classification matches the EXPECTED table for ALL 12 types", () => {
    for (const t of ALL_TYPES) {
      expect(classify(t)).toEqual(EXPECTED[t]);
    }
  });

  test("an unknown type matches NO guard (safe default for malformed events)", () => {
    const e = makeEvent("totally_bogus_type");
    expect(isThinkingEvent(e)).toBe(false);
    expect(isTextEvent(e)).toBe(false);
    expect(isToolCallEvent(e)).toBe(false);
    expect(isTerminalEvent(e)).toBe(false);
  });
});
```

---

## Final Validation Checklist

### Technical Validation
- [ ] `npx bun run typecheck` → **zero** diagnostics (type predicates + Extract aliases compile; the
      `import type`/`export type` re-export satisfies `isolatedModules`).
- [ ] `npx bun run build` emits `dist/types.js` (4 guards + 4 Sets) + `dist/types.d.ts` (all types +
      re-export + JSDoc).
- [ ] `npx bun test tests/types.test.ts` → all green.
- [ ] `npx bun test` → all green (factory + decorator + diagnostics + config + smoke still passing).
- [ ] Level 3 node smoke: built `dist/types.js` exposes the 4 guards as functions; `isTerminalEvent`
      returns true for `done`+`error` and false for `start`+`thinking_delta`.

### Feature Validation
- [ ] Exports present: `TransitionState`, `ProxyPhase`, `isThinkingEvent`, `isTextEvent`,
      `isToolCallEvent`, `isTerminalEvent`, the `*Event`/`*EventType` aliases, re-exported
      `AssistantMessageEvent`.
- [ ] `TransitionState` has exactly the 11 PRD §15 literals with correct capitalization.
- [ ] Each `is*Event` is a **type predicate** (`event is XxxEvent`) so `if (isThinkingEvent(e)) e.delta`
      compiles downstream.
- [ ] Guards use REAL discriminators (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`, `error`)
      — never PRD §18 conceptual names in the Set literals.
- [ ] `isTerminalEvent` matches BOTH `done` and `error`; `start` matches NO guard; every non-start
      event matches exactly one guard.

### Code Quality Validation
- [ ] String-literal unions only (no `enum`, no boolean-flag state encoding) — Appendix F.
- [ ] Family membership centralized in `ReadonlySet<string>` consts (no magic inline strings).
- [ ] Mode-A JSDoc on the module banner + every export; each guard cites PRD §18; `isTerminalEvent`
      cites the §18 single-`message_end` invariant.
- [ ] Mirrors sibling-module conventions (Mode-A JSDoc, flat `tests/` dir, `npx bun` invocations,
      sentinel/`as unknown as` synthetic-event style from `provider-decorator.test.ts`).
- [ ] Zero runtime state / side effects; only project import is the pi-ai type re-export.
- [ ] Only `src/types.ts` edited + `tests/types.test.ts` added; no edits to `src/index.ts` (factory),
      `src/provider/*`, `src/state/*`, `src/config/*`, `src/diagnostics/*`, `package.json`,
      `tsconfig.json`, `.gitignore`.

### Documentation & Deployment
- [ ] Module banner documents responsibility/ownership/lifecycle/invariants/failure-modes (Appendix F).
- [ ] `TransitionState` JSDoc cites PRD §15/§16/§17 + the Appendix-F union mandate.
- [ ] `ProxyPhase` JSDoc cites PRD §18 columns + §21/§39.
- [ ] `dist/types.d.ts` carries the JSDoc for downstream consumers.

---

## Anti-Patterns to Avoid

- ❌ Don't test for PRD §18 conceptual names (`message_start`/`message_end`/`tool_call`) in the guards —
  they are NOT real `AssistantMessageEvent.type` values. Use `start`, `done`/`error`, `toolcall_*`.
- ❌ Don't make the guards return a plain `boolean` — they MUST be type predicates (`event is XxxEvent`)
  or downstream narrowing breaks and casts proliferate.
- ❌ Don't use a TS `enum` for `TransitionState`/`ProxyPhase` — Appendix F mandates discriminated-union /
  string-literal representation; an enum also emits a runtime object and harms tree-shaking.
- ❌ Don't inline the discriminator strings in each guard (`event.type === "thinking_start" || …`) —
  centralize them in the `*_TYPES` Sets (Appendix F: "Provider-specific constants shall be centralized";
  "magic numbers are prohibited").
- ❌ Don't re-export `AssistantMessageEvent` with `export { … }` (runtime) or forget the separate
  `import type` — under `isolatedModules` a type-only symbol needs `export type` + `import type`.
- ❌ Don't classify `start` into any family — it is the lifecycle-begin event; it must match NO guard.
- ❌ Don't touch `src/index.ts` (the factory, being implemented in parallel) or any other module — this
  subtask owns ONLY `src/types.ts` + `tests/types.test.ts`.

---

## Confidence Score: **9/10**

**Why 9, not 10**: The task is small, self-contained, and fully specified (verified discriminator
strings, exact PRD §15 literals, full reference implementation + test suite). The only residual risk
is a capitalization typo in a `TransitionState` literal — fully mitigated by the Level 4 state-count
gate. One-pass success is highly likely.
