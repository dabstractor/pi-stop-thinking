# Stop Thinking & Do

> Stop Thinking & Do — interrupt reasoning loops in z.ai models with one keystroke.

A [Pi](https://github.com/earendil-works/pi) extension that lets you press a single key to stop a z.ai model's reasoning loop and jump straight to the answer — within the same uninterrupted assistant turn.

## Features

- **Single keyboard shortcut** — press `Ctrl+Q` while the model is reasoning and it stops immediately.
- **Transparent provider decoration** — when the extension is inactive or the provider isn't supported, requests pass through unchanged with zero observable behavioral difference.
- **Zero-config defaults** — works out of the box after installation; no settings to edit.
- **z.ai-specific** — activates for any reasoning-enabled z.ai model (e.g. GLM-4.5, GLM-4.6, GLM-4.7, GLM-5.x), detected automatically from the model registry.
- **Reasoning is reused, not discarded** — by default, the reasoning captured before you pressed `Ctrl+Q` is fed back to the model as ephemeral, fenced reference context, so the answer is informed by it rather than produced from scratch (best-effort, proportional to how far reasoning got). This is independent of the display preservation below.
- **Reasoning is preserved for display** — the captured reasoning stays in the saved assistant message, and the answer follows it. The saved turn reads like a normal response: reasoning, then the answer.

## Installation

Install via Pi (writes to `~/.pi/agent/settings.json` automatically):

```bash
pi install npm:pi-stop-thinking
```

…or add it manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-stop-thinking"]
}
```

Pi will download the package to `~/.pi/agent/npm/` on next startup and load the extension automatically.

## Usage

While the model is reasoning, press **Ctrl+Q**. The reasoning stops and the model begins answering in the same assistant turn — no restart, no second prompt. The reasoning that streamed before you pressed is preserved in the message, so the saved turn reads like a normal response: reasoning, then the answer.

```
User message ──► Model starts reasoning ──► [Ctrl+Q] ──► Model answers (same turn)
```

The shortcut is active only while the model is actively reasoning. Reasoning ends the moment the model emits `thinking_end` or its first answer token — after that, pressing **Ctrl+Q** is silently ignored (the model is already answering). Only one interruption is accepted per response; additional presses during the transition are discarded.

## Configuration

All configuration fields use validated internal defaults. Invalid values fall back to their defaults and never block normal provider delegation.

| Field | Type | Default |
| --- | --- | --- |
| `enabled` | `boolean` | `true` |
| `shortcut` | `string` (Pi KeyId) | `"ctrl+q"` |
| `supportedProviders` | `string[]` | `["zai"]` |
| `transitionTimeoutMs` | `number` (ms, > 0) | `5000` |
| `replacementStartupTimeoutMs` | `number` (ms, > 0) | `10000` |
| `maximumReasoningBufferBytes` | `integer` (bytes, > 0) | `8388608` (8 MiB) |
| `reasoningInjection` | `boolean` | `true` |
| `reasoningInjectionDelimiter` | `{ open: string; close: string }` | `{ open: "---\n[Prior reasoning captured before you were asked to stop thinking]", close: "[End of prior reasoning]\n---" }` |
| `telemetryEnabled` | `boolean` | `false` |
| `diagnosticsLevel` | `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `"error"` |

### Configuring via environment variables

Pi's extension API does not pass a settings object to extensions, so this extension is configured with `PI_STOP_THINKING_*` environment variables (set them in your shell, `~/.bashrc`, or whatever launches `pi`). Every variable is **optional** — an unset or invalid value falls back to that field's default and never prevents normal provider delegation.

| Env var | Field | Example |
| --- | --- | --- |
| `PI_STOP_THINKING_SHORTCUT` | `shortcut` | `ctrl+b` |
| `PI_STOP_THINKING_ENABLED` | `enabled` | `false` |
| `PI_STOP_THINKING_PROVIDERS` | `supportedProviders` (comma-separated) | `zai,openai` |
| `PI_STOP_THINKING_TRANSITION_TIMEOUT_MS` | `transitionTimeoutMs` | `8000` |
| `PI_STOP_THINKING_REPLACEMENT_TIMEOUT_MS` | `replacementStartupTimeoutMs` | `15000` |
| `PI_STOP_THINKING_MAX_REASONING_BUFFER_BYTES` | `maximumReasoningBufferBytes` | `4194304` |
| `PI_STOP_THINKING_REASONING_INJECTION` | `reasoningInjection` | `false` |
| `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_OPEN` | `reasoningInjectionDelimiter.open` | `"[Start of prior reasoning]"` |
| `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_CLOSE` | `reasoningInjectionDelimiter.close` | `"[End of prior reasoning]"` |
| `PI_STOP_THINKING_TELEMETRY` | `telemetryEnabled` | `true` |
| `PI_STOP_THINKING_DIAGNOSTICS` | `diagnosticsLevel` (`error`\|`warn`\|`info`\|`debug`\|`trace`) | `trace` |

Booleans accept `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off` (case-insensitive). To observe runtime behavior while debugging, set `PI_STOP_THINKING_DIAGNOSTICS=trace` (output goes to the console). For `PI_STOP_THINKING_REASONING_INJECTION_DELIMITER_*`, if you set only one of `_OPEN` / `_CLOSE`, the other half falls back to its default (an empty value is treated as unset).

The `--no-stop-thinking` CLI flag is still available and forces `enabled` to `false` for that run (the extension then delegates transparently).

### Configuration limitations

- **No `settings.json` configuration.** Pi does not expose extension settings, so configuration is environment-variable only.
- **Shortcut choice is constrained by your terminal.** Pi matches shortcuts against raw terminal input and reliably recognizes `Ctrl+<letter>` (a–z), plus `Ctrl+[ \ ] _ -` and special keys. Symbol shortcuts such as `Ctrl+.` **register but never fire** in most terminals (the legacy `Ctrl+.` byte `0x1e` is not recognized) — that is why the default is `Ctrl+Q`. If you override `PI_STOP_THINKING_SHORTCUT`, choose a `Ctrl+<letter>`.
- **Avoid reserved keys.** If your shortcut collides with a built-in Pi keybinding (e.g. `Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+P`, `Ctrl+L`, `Ctrl+O`, `Ctrl+T`, `Ctrl+G`, …), Pi skips it. `Ctrl+Q` is unbound.
- **Invalid values never break anything.** A malformed env value silently falls back to the default for that field.

## Supported models

**Stop Thinking** activates for any `zai`-provider model with `reasoning: true` — it is detected automatically from the model registry, so no model list is maintained. Illustrative eligible models include:

- GLM-4.5 / GLM-4.5-Air
- GLM-4.6
- GLM-4.7 / GLM-4.7-Flash
- GLM-5 / GLM-5-Turbo / GLM-5.1 / GLM-5.2

Non-reasoning z.ai models (e.g. GLM-4.5-Flash) and all other providers (OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, etc.) are passed through unchanged — the extension is fully transparent when inactive or unsupported.

## How it works

The extension uses two mechanisms:

1. **Provider decoration** — On startup, the extension captures Pi's built-in `openai-completions` provider and registers a transparent wrapper under the source id `stop-thinking-extension`. Every request is evaluated: if the provider is z.ai, the model is reasoning-enabled, and the extension is enabled, the request is routed through the interruption pipeline; otherwise it is delegated to the captured built-in provider unchanged.

2. **Stream splicing** — When you press `Ctrl+Q`, the wrapper aborts the reasoning stream (via an internal `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement request to the same provider. The replacement stream's events are rewritten and merged into the same downstream `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn. The replacement request also carries the frozen reasoning snapshot as **ephemeral input context** (the §53 Ephemeral Execution Directive), so the model conditions its answer on its own prior reasoning rather than starting from scratch.

   The captured reasoning serves **two distinct purposes**, which must not be confused:

   - **Input injection (reasoning reuse)** — the snapshot is rendered to text, wrapped in a clearly-labeled delimiter fence, and appended to the replacement request's messages as a single `user` message marked *"reference context only"*. The model reads its own prior reasoning and produces an answer informed by it (best-effort, proportional to how far reasoning got). This context is ephemeral: it lives only within that one replacement request and is never persisted into conversation history as a new or modified message.
   - **Output stitching (display preservation)** — the captured reasoning is preserved in the saved assistant message, and the answer text follows it, producing a normal `[thinking, text]` sequence — the same shape as a non-interrupted reasoning response, with no restart artifact.

   If reasoning injection is disabled (`reasoningInjection: false`) or nothing was captured, the input-injection step is skipped and the answer is generated from scratch; output stitching still applies.

On session shutdown the wrapper is unregistered, restoring Pi's unmodified built-in provider.

## Privacy

- No prompts, reasoning content, or model output is logged or persisted by this extension.
- Diagnostics default to error-only level and never include message, reasoning, or output content — only provider/model metadata and error categories.
- Telemetry is opt-in (`telemetryEnabled: false` by default). When enabled, it emits only privacy-safe aggregate metrics (counters, timings) — never user content.

## Limitations

- **z.ai reasoning models only** — the interruption logic targets z.ai providers with reasoning-capable GLM models. All other providers are transparently passed through.
- **One interruption per response** — you can stop reasoning once per assistant turn. Pressing `Ctrl+Q` again during the transition is silently discarded.
- **No recursive interruption** — if the replacement stream returns reasoning content despite thinking being disabled, it is forwarded as-is; a second interruption is not attempted.
- **Best-effort transition** — if the abort or replacement fails (timeout, provider error), the extension falls back transparently to Pi's normal behavior.

## Development

```bash
bun install
bun run build
bun test
```

## License

[MIT](https://opensource.org/licenses/MIT)
