# Research Notes — P1.M4.T1.S1: ReasoningBuffer append-only collection with freeze/snapshot

## 1. What landed (verified by reading src/)

- `src/buffer/.gitkeep` — the buffer module dir exists but is **EMPTY** (only the .gitkeep placeholder). This
  subtask creates the first file there.
- `src/config/index.ts` — exports `interface Config` with `maximumReasoningBufferBytes: number`
  (default `8388608` = 8 MiB, validated as `isPositiveInteger`). This is the **only** config value the
  buffer needs.
- `src/diagnostics/index.ts` — exports `interface Diagnostics { trace/debug/info/warn/error(event, fields?) }`.
  Five ordered levels. Privacy contract: MAY log counts/metrics; MUST NEVER log reasoning CONTENT.
- `src/types.ts` — exports `ThinkingEvent` (= the *streaming event* union `thinking_start|thinking_delta|
  thinking_end`) and `isThinkingEvent`. **`ThinkingEvent` is ALREADY TAKEN** as a type name → the buffer
  entry type MUST use a different name. The `thinking_delta` event (pi-ai `dist/types.d.ts:271-273`)
  carries `{ type:"thinking_delta", contentIndex:number, delta:string, partial:AssistantMessage }`. The
  buffer's `append(delta:string)` consumes the **`.delta` string** — the StreamProxy (P1.M4.T2) extracts it.
- `src/state/controller.ts` (DONE by P1.M3.T1S1) — `TransitionController` FSM. On the stop flow it walks
  `Reasoning → StopRequested → Aborting → Capturing`; `completeAbort()` lands in `Capturing` whose
  invariant (PRD §17) is *"Reasoning buffer immutable"* → **freeze() must be called at/around
  `completeAbort()` (the Aborting→Capturing boundary)** by P1.M5. This subtask only IMPLEMENTS freeze; it
  does NOT wire the call.
- `src/provider/proxy.ts` — StreamProxy (DONE, forward-only). P1.M4.T2 will extend it to own a
  ReasoningBuffer and call `append()` on `thinking_delta`. Not this subtask.

## 2. The contract naming discrepancy — RESOLUTION

Two sources disagree on the buffer's API surface:

| Source | entry type | `append` arg |
|---|---|---|
| `architecture/module_contracts.md` ReasoningBuffer | `ThinkingEvent { offset, timestamp, content }` | `append(event: ThinkingEvent)` |
| **Work item (P1.M4.T1.S1) — AUTHORITATIVE** | `ThinkingEntry { offset, timestamp, content }` | `append(delta: string)` |

**Resolution: follow the WORK ITEM.** It is the binding contract for this task and is strictly better:
1. `append(delta: string)` keeps the buffer **opaque / non-interpreting** (PRD §13.4: "The extension does
   not interpret reasoning") — it never imports the event taxonomy, so it cannot accidentally couple to
   the streaming types.
2. The entry type is named **`ThinkingEntry`** (not `ThinkingEvent`) to AVOID COLLIDING with the existing
   `ThinkingEvent` streaming-event union already exported from `src/types.ts`. Reusing `ThinkingEvent`
   would shadow/alias a public type and confuse every downstream reader.
3. The StreamProxy (consumer, P1.M4.T2) already has the typed event; it extracts `.delta` and passes the
   raw string. Decoupling means the buffer is unit-testable with zero event-fixture machinery.

## 3. File placement decision

- Source: **`src/buffer/index.ts`** (module barrel) — matches how every NEW single-responsibility module
  dir is set up here (`src/config/index.ts`, `src/diagnostics/index.ts`, `src/types.ts`). Consumers import
  as `"../buffer"`. The `.gitkeep` becomes redundant once `index.ts` exists → remove it.
  - (Rejected alternative: `src/buffer/reasoning-buffer.ts` — the named-file pattern used by
    `src/state/controller.ts`. Not used because `state/` holds TWO classes so it needs named files;
    `buffer/` is a single-responsibility barrel like `config/` and `diagnostics/`.)
- Test: **`tests/reasoning-buffer.test.ts`** — named after the class, matching the two most recent tests
  (`stream-proxy.test.ts`, `transition-controller.test.ts`).

## 4. Constructor coupling — inject the byte limit, not the whole Config

The buffer needs exactly ONE config value: `maximumReasoningBufferBytes`. Inject it as a bare `number`
(`new ReasoningBuffer(diagnostics, maximumBytes)`) rather than the whole `Config`. Rationale: minimal
coupling (the buffer doesn't care about `shortcut`/`timeoutMs`/etc.), trivially unit-testable (pass a
tiny limit like `10` to exercise overflow), and matches the "inject what you need" precedent (StreamProxy
takes `diagnostics` injected, not a service locator). The factory / StreamProxy will pass
`config.maximumReasoningBufferBytes`.

## 5. Key semantics pinned from the work item (verbatim contract)

- `ThinkingEntry = { offset: number; timestamp: number; content: string }`.
- Fields: `entries: ThinkingEntry[] = []`, `frozen: boolean = false`, `totalBytes: number = 0`.
- `append(delta)`:
  - THROWS if `frozen` (cite PRD §41).
  - Pushes `{ offset: this.entries.length, timestamp: Date.now(), content: delta }` → offset = current
    array index (0,1,2,…), naturally monotonic (PRD §13.4 "track offsets"). NOTE: evaluated BEFORE push.
  - `totalBytes += delta.length`.
  - Overflow: if `totalBytes` would exceed `maximumBytes` → **do NOT truncate** (PRD §23.5), still append,
    log a `warn` (counting metrics only, never content). Decision: warn EACH time an append pushes it over
    (most literal, most testable; documented as MVP choice).
- `freeze()`: `this.frozen = true`. Idempotent (calling twice is a safe no-op; does NOT throw). Emits one
  `debug("buffer.frozen", { entries, totalBytes })` lifecycle milestone (privacy-safe counts).
- `snapshot()`: returns a **frozen copy** — `Object.freeze(this.entries.map(e => Object.freeze({ ...e })))`.
  Deep-ish immutable so RequestBuilder (P1.M6) cannot mutate internal state; matches PRD §13.4 "Expose
  immutable snapshot" + §23.2 "Immutable after capture".
- `getByteSize()`: returns `this.totalBytes` (pure read).
- `reset()`: clears entries, `frozen = false`, `totalBytes = 0`. Works REGARDLESS of frozen state (this is
  the path back to mutable after completion/destroy — PRD §41/§23.3).

## 6. Lifecycle states for the Mode-A JSDoc (PRD §41 — Buffer Ownership During Transition)

The work item DOCS spec: "Add JSDoc documenting lifecycle states (mutable → frozen → destroyed) per
PRD §41". Mapping:
- **Mutable** (before interruption) — `append()` allowed; `frozen === false`.
- **Frozen** (after interruption) — `append()` throws; `snapshot()` is the authoritative read.
- **Read-only** (after replacement) — same frozen state; RequestBuilder has already snapshotted.
- **Destroyed** (after completion) — `reset()` returns to mutable (rebirth) OR the instance is GC'd.
  PRD §23.3 "Never reused" → in practice a FRESH buffer per request; `reset()` exists for completeness.

## 7. Gotchas captured

- `delta.length` is UTF-16 code units, not UTF-8 bytes. For the 8 MiB soft-warning threshold this is
  immaterial (±small %), and the work item literally specifies `.length`. True byte count would be
  `Buffer.byteLength(delta)` (Bun/Node). Use `.length` per contract; document the nuance.
- `isolatedModules` + `strict` → import `Diagnostics` as `import type`. No runtime value imports from
  config/types (the buffer takes the limit as a number and diagnostics as an injected instance).
- Tests dir is EXCLUDED from `tsconfig` (`exclude:["tests"]`) → validated by `bun test` only, not tsc.
- Bun/tsc are local devDeps NOT on PATH → use `npx bun run <script>` / `npx bun test`.
- `snapshot()` must COPY (not expose the internal array) — returning `this.entries` directly would let a
  caller mutate internals / see later appends. Freeze + map-copy closes the hole.
- Do NOT store `contentIndex` or the `partial AssistantMessage` — the buffer is opaque (PRD §13.4) and the
  work-item `ThinkingEntry` has only `{offset, timestamp, content}`.

## 8. Validation commands (verified against package.json scripts)

- `npx bun run typecheck` (=`tsc --noEmit`, src/ only) → must be 0 diagnostics.
- `npx bun run build` (=`tsc`) → exit 0, emits `dist/buffer/index.{js,d.ts}`.
- `npx bun test tests/reasoning-buffer.test.ts` → new suite green.
- `npx bun test` → ALL green (new suite + the 8 existing, no regressions).
