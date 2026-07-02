# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Reasoning reuse via ephemeral text injection (ADR-006 / §53): when you stop thinking, the captured reasoning is injected as ephemeral, delimited reference context into the thinking-disabled replacement request so the model conditions its answer on its own prior reasoning. Quality is proportional to how much material reasoning was captured before the shortcut. Configurable via `reasoningInjection` (default: on) and `reasoningInjectionDelimiter`. — P2

### Fixed

- Reasoning is now preserved in the persisted assistant message on interruption (content assembles as `[thinking, text]`, matching a normal response) — P1.M2.
- The shortcut is now disabled once reasoning ends (`thinking_end` or first answer token); pressing it during the answer no longer aborts the in-progress response — P1.M3.
- Coordinator no longer loses shortcut coverage for overlapping streams (guarded active-proxy clear) — P1.M4.

## [1.0.0]

### Added

- **Foundation (P1.M1)** — Config schema with validated defaults, structured Diagnostics logger (error-only by default), transparent ProviderDecorator (captures built-in `openai-completions`, registers wrapper under `stop-thinking-extension`), extension factory with never-crash guarantee, and the `--no-stop-thinking` CLI flag.
- **Event Proxy (P1.M2)** — transparent StreamProxy forwarding pipeline with golden-replay test harness for observational equivalence verification.
- **Transition State Machine (P1.M3)** — validated TransitionController FSM modeling the full interruption lifecycle (Idle → Delegating → Reasoning → StopRequested → Aborting → Capturing → Restarting → Splicing → Answering → Completed → Idle).
- **Reasoning Detection (P1.M4)** — ReasoningBuffer (append-only capture, 8 MiB ceiling), reasoning detection (thinking_start / thinking_delta events), ShortcutManager (configurable keyboard shortcut, first-press-wins idempotency), and TransitionCoordinator (state bridge between shortcut and proxy).
- **Abort Coordination (P1.M5)** — internal AbortController with abort-vs-natural-completion race handling (RC-001 natural-completion-wins), configurable abort timeout (FM-006).
- **Replacement Generation (P1.M6)** — RequestBuilder constructs the thinking-disabled replacement request (reasoning forced to undefined via z.ai API options).
- **Stream Splicing (P1.M7)** — replacement stream invocation, replacement-startup timeout, terminal-event suppression (INV-002/INV-003 single-start/single-terminal), authority transfer (forwarding → splicing), full transition lifecycle with cleanup, and session-scoped coordinator re-registration.
- **Hardening (P1.M8)** — opt-in privacy-safe Telemetry (aggregate counters/timings only), comprehensive failure-mode handling (FM-001 through FM-015), session-shutdown and re-registration lifecycle, property/stress/chaos/regression test suites, and production documentation.
