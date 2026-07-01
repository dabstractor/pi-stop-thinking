# Stop Thinking & Do

> Stop Thinking & Do — interrupt reasoning loops in z.ai models with one keystroke.

A [Pi](https://github.com/earendil-works/pi) extension that lets you press a single key to stop a z.ai model's reasoning loop and jump straight to the answer — within the same uninterrupted assistant turn.

## Features

- **Single keyboard shortcut** — press `Ctrl+.` while the model is reasoning and it stops immediately.
- **Transparent provider decoration** — when the extension is inactive or the provider isn't supported, requests pass through unchanged with zero observable behavioral difference.
- **Zero-config defaults** — works out of the box after installation; no settings to edit.
- **z.ai-specific** — targets z.ai reasoning models (GLM-4.5, GLM-4.6, GLM-4.5-Air, GLM-4.5-Flash).
- **Reasoning is preserved** — when you stop the reasoning, it stays in the saved assistant message, followed by the answer.

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

While the model is reasoning, press **Ctrl+.**. The reasoning stops and the model begins answering in the same assistant turn — no restart, no second prompt. The reasoning that streamed before you pressed is preserved in the message, so the saved turn reads like a normal response: reasoning, then the answer.

```
User message ──► Model starts reasoning ──► [Ctrl+.] ──► Model answers (same turn)
```

The shortcut is active only while the model is actively reasoning. Reasoning ends the moment the model emits `thinking_end` or its first answer token — after that, pressing **Ctrl+.** is silently ignored (the model is already answering). Only one interruption is accepted per response; additional presses during the transition are discarded.

## Configuration

All configuration fields use validated internal defaults. Invalid values fall back to their defaults and never block normal provider delegation.

| Field | Type | Default |
| --- | --- | --- |
| `enabled` | `boolean` | `true` |
| `shortcut` | `string` (Pi KeyId) | `"ctrl+."` |
| `supportedProviders` | `string[]` | `["zai"]` |
| `transitionTimeoutMs` | `number` (ms, > 0) | `5000` |
| `replacementStartupTimeoutMs` | `number` (ms, > 0) | `10000` |
| `maximumReasoningBufferBytes` | `integer` (bytes, > 0) | `8388608` (8 MiB) |
| `telemetryEnabled` | `boolean` | `false` |
| `diagnosticsLevel` | `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `"error"` |

### Overriding

In v1.0.0 the only user-facing runtime override is the `--no-stop-thinking` CLI flag, which sets `enabled` to `false` (the extension then delegates transparently). All other fields are validated internal defaults and cannot be changed via `settings.json` or environment variables.

## Supported models

**Stop Thinking** activates only for z.ai models that are reasoning-enabled (`model.reasoning`):

- GLM-4.5
- GLM-4.6
- GLM-4.5-Air
- GLM-4.5-Flash

Non-reasoning z.ai models and all other providers (OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, etc.) are passed through unchanged — the extension is fully transparent when inactive or unsupported.

## How it works

The extension uses two mechanisms:

1. **Provider decoration** — On startup, the extension captures Pi's built-in `openai-completions` provider and registers a transparent wrapper under the source id `stop-thinking-extension`. Every request is evaluated: if the provider is z.ai, the model is reasoning-enabled, and the extension is enabled, the request is routed through the interruption pipeline; otherwise it is delegated to the captured built-in provider unchanged.

2. **Stream splicing** — When you press `Ctrl+.`, the wrapper aborts the reasoning stream (via an internal `AbortController`), freezes the captured reasoning buffer, and issues a thinking-disabled replacement request to the same provider. The replacement stream's events are rewritten and merged into the same downstream `AssistantMessageEventStream` so Pi sees one continuous, uninterrupted assistant turn. The reasoning captured before the interruption is preserved, and the answer text follows it — the resulting message is a normal `[thinking, text]` sequence, the same shape as a non-interrupted reasoning response, with no restart artifact.

On session shutdown the wrapper is unregistered, restoring Pi's unmodified built-in provider.

## Privacy

- No prompts, reasoning content, or model output is logged or persisted by this extension.
- Diagnostics default to error-only level and never include message, reasoning, or output content — only provider/model metadata and error categories.
- Telemetry is opt-in (`telemetryEnabled: false` by default). When enabled, it emits only privacy-safe aggregate metrics (counters, timings) — never user content.

## Limitations

- **z.ai reasoning models only** — the interruption logic targets z.ai providers with reasoning-capable GLM models. All other providers are transparently passed through.
- **One interruption per response** — you can stop reasoning once per assistant turn. Pressing `Ctrl+.` again during the transition is silently discarded.
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
