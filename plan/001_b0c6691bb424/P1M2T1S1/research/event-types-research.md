# Research — P1.M2.T1.S1: Event Classification & Transition State Types

## 1. `AssistantMessageEvent` discriminated union — VERIFIED from installed package

Source: `node_modules/@earendil-works/pi-ai/dist/types.d.ts` (pi-ai `0.74.2`, the pinned devDep).
It is a discriminated union on a `type` field. EXACT members:

| `event.type`  | Payload fields (besides `type`)                          | Family       |
|---------------|----------------------------------------------------------|--------------|
| `start`       | `partial: AssistantMessage`                              | lifecycle    |
| `text_start`  | `contentIndex: number`, `partial`                        | text         |
| `text_delta`  | `contentIndex`, `delta: string`, `partial`               | text         |
| `text_end`    | `contentIndex`, `content: string`, `partial`             | text         |
| `thinking_start` | `contentIndex`, `partial`                             | thinking     |
| `thinking_delta` | `contentIndex`, `delta: string`, `partial`            | thinking     |
| `thinking_end`   | `contentIndex`, `content: string`, `partial`          | thinking     |
| `toolcall_start` | `contentIndex`, `partial`                             | toolcall     |
| `toolcall_delta` | `contentIndex`, `delta: string`, `partial`            | toolcall     |
| `toolcall_end`   | `contentIndex`, `toolCall: ToolCall`, `partial`       | toolcall     |
| `done`        | `reason: "stop"\|"length"\|"toolUse"`, `message: AssistantMessage` | terminal |
| `error`       | `reason: "aborted"\|"error"`, `error: AssistantMessage`| terminal     |

JSDoc on the union: *"Streams should emit `start` before partial updates, then terminate with
either `done` … or `error` …"*. Confirms `start` = lifecycle begin; `done`/`error` = the ONE
terminal event.

## 2. CRITICAL gotcha — PRD §18 conceptual names vs REAL discriminators

PRD §18 "Event Forwarding Rules" table uses **conceptual** names (`message_start`, `message_end`).
These do NOT exist as `event.type` values. The mapping to REAL `AssistantMessageEvent.type`:

| PRD §18 conceptual | REAL `event.type`            | Notes |
|--------------------|------------------------------|-------|
| `message_start`    | `start`                      | lifecycle begin (emitted once) |
| `message_end`      | `done` **or** `error`        | the SINGLE terminal event |
| `thinking_*`       | `thinking_start/delta/end`   | exact match |
| `text_*`           | `text_start/delta/end`       | exact match |
| `tool_call`        | `toolcall_start/delta/end`   | NOTE underscore→no-underscore |

Type guards MUST test the REAL discriminator strings (`start`, `done`, `error`, `toolcall_*`),
never the PRD conceptual names. The `isTerminalEvent` guard captures the "exactly one message_end"
invariant (PRD §18: *"only one `message_end` event may ever reach the Pi agent runtime"*).

## 3. PRD §15 TransitionState — 11 states (exact literals, capitalization)

`Idle | Delegating | Reasoning | StopRequested | Aborting | Capturing | Restarting | Splicing |
Answering | Completed | Failed` (§15 State Machine / §16 Transition Table / §17 Invariants).

## 4. ProxyPhase — maps to PRD §18 columns + §21/§39 splicing

`"forwarding" | "transitioning" | "splicing"`:
- `forwarding` = §18 "Before Stop" column (forward all, unmodified)
- `transitioning` = §18 "During Transition" column (suppress obsolete thinking + upstream terminal)
- `splicing` = §21 Stream Splicing / §39 Transition Event Rules (replacement authoritative)

## 5. Appendix F coding standard (verbatim, the authority)

> "State transitions shall be represented explicitly using discriminated unions or equivalent
> strongly typed constructs. Boolean flag combinations shall not be used to encode lifecycle state."

→ `TransitionState` is a **string-literal union** (NOT an enum, NOT boolean flags). The item spec
explicitly requests a string literal union.

## 6. TypeScript narrowing strategy (type guards)

Define narrowing union aliases via `Extract<AssistantMessageEvent, { type: … }>` and predicates
`(e): e is XxxEvent`. Implementation uses a `ReadonlySet<string>` of the discriminator literals for
the `has()` check — O(1), no magic inline strings ("Magic numbers are prohibited"; "Provider-specific
constants shall be centralized" — the `*_TYPES` Sets centralize the families).

## 7. isolatedModules compatibility

- `export type { AssistantMessageEvent } from "@earendil-works/pi-ai";` re-exports the type-only
  symbol. We ALSO `import type { AssistantMessageEvent } from "..."` for internal use (guards' param
  type). Two statements are required under `isolatedModules` (re-export + local import).
- All narrowing aliases + `ProxyPhase`/`TransitionState` are `type`-only → erased at emit. The guards
  and the `*_TYPES` Sets are the only runtime values → emitted into `dist/types.js`.

## 8. No current importers

`grep` confirms NOTHING imports `../types` / `./types` today (`proxy.ts`, `controller.ts`,
`decorator.ts` are stubs or don't import it). Replacing the placeholder `src/types.ts` comment is
safe; future consumers are P1.M2.T2.S1 (StreamProxy) + P1.M3.T1.S1 (TransitionController).
