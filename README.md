# Canvas prompt bridge for DeepSeek Harness

A DeepSeek Harness bundle that sends prompts to an [Infinite Canvas](https://github.com/basketikun/infinite-canvas) running on your LAN. A canvas-side plugin writes each prompt into the node you selected there, so you only run the generation.

```
DSH tool canvas_prompt
  → POST http://<canvas-host>:8799/prompt
    → canvas plugin polls the bridge
      → writes the text into the selected node
        → you click generate
```

## Why a bridge

Canvas node data lives in the browser page; DSH runs in Node. Neither can reach the other directly, and the canvas exposes no "write node by id" API. The bridge is a small local HTTP queue that both sides can reach.

## Install

Requires DeepSeek Harness. From the DSH checkout or workspace:

```
plugin_manager install_bundle <absolute path to this directory>
```

Or copy this directory to the target machine and use **Plugins → Add plugin** in the DSH GUI.

The bundle declares `@deepseek-ai/schemastery` as its only dependency; `npm install` (or `pnpm install`) inside the package directory provides it.

## Configure the canvas address

The address is a plugin config value, not a constant in code:

- **Chat** — ask the agent: "把画布地址改成 http://192.168.3.201:8799" (tool `canvas_prompt_config`, `action: set`).
- **Profile patch** — `~/.dsh/profiles/<profile>/cordis.patch.yml`:

  ```yaml
  - id: canvas-prompt
    name: "@local/dsh-canvas-prompt"
    config:
      bridgeUrl: http://192.168.3.200:8799
  ```

The field is declared `.volatile()`, so a write applies without restarting the plugin. This bundle ships no browser-side settings page: DSH only renders a plugin page that the plugin itself registers, and a linked workspace bundle cannot reliably ship one, so the value is edited through the tool or the profile patch.

Resolution order: per-call `bridge` argument → `bridgeUrl` config → `CANVAS_BRIDGE_URL` environment variable → built-in default.

## Tools

| Tool | Purpose |
|---|---|
| `canvas_prompt` | Queue a prompt. `prompt` required; `target` optional (node title or id); `bridge` optional one-off override |
| `canvas_prompt_bridge` | `status` reads the queue length, `clear` empties it |
| `canvas_prompt_config` | `get` / `set` / `clear` the saved address |

## Canvas-side setup

1. Run the bridge on the canvas host (`prompt-bridge.mjs`, listening on 8799).
2. In the canvas, create a **提示词桥** (`prompt-bridge`) node and pick the target node in its panel.
3. Keep the canvas page open; prompts queue while it is closed and are written when it reopens.

## Limitations

- The bridge listens on the LAN without authentication. Use it only on a trusted network and never expose it to the internet.
- The plugin only writes prompts; it does not start generations.
- DSH does not resolve `@deepseek-ai/*` packages from a workspace-linked bundle, so the bundle must not import `@deepseek-ai/dsh-tools`; tool definitions are registered as plain objects.

## License

MIT
