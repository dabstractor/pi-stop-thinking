# pi-stop-thinking

> **⚠️ Under Development** — not yet functional. Tracking Phase 0 foundation work.

Pi extension to interrupt z.ai reasoning streams and transition to answer
generation while preserving a single uninterrupted assistant response.

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

## What it does (Phase 0)

This release is the **Phase 0 foundation**: once installed, the extension transparently delegates every
provider request to Pi's built-in provider with **zero observable behavioral change** (ADR-005). The
"stop thinking" interruption for z.ai reasoning models arrives in later phases. Diagnostics default to
silent (`"error"` level only).

## Status

- [x] Project scaffold
- [ ] Configuration / Diagnostics / Provider decorator / Factory wiring (Phase 0)
- [ ] Transition state machine / Stream proxy / Reasoning buffer (Phase 1)
- [ ] Keyboard shortcut / Request builder / Transition coordinator (Phase 2)
- [ ] Integration testing and polish (Phase 3)

## Development

```bash
bun install
bun run build
bun test
```
