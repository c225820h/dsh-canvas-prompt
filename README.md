# Canvas prompt bridge for DeepSeek Harness

> 中文说明（DSH 侧与画布侧两套安装步骤分别写清）：[README.zh.md](./README.zh.md)

Two halves that let you write a prompt in DeepSeek Harness and have it land in an [Infinite Canvas](https://github.com/basketikun/infinite-canvas) node on your LAN — with optional automatic generation.

```
DSH plugin (this bundle)          Canvas plugin (infinite-canvas)
  in-process inbox :8799   ◀──poll──  「提示词桥」card
        ▲                                   │
        └──── canvas_prompt tool            └── writes the prompt into the selected node,
                                                  then optionally runs generation
```

The inbox lives **inside this DSH plugin**: its `apply()` starts an HTTP server on the configured port while DSH runs. No separate process, no service to keep alive, no gateway or launcher changes.

## Contents

| Path | What |
|---|---|
| `index.js` | DSH Host plugin: in-process inbox + three tools |
| `canvas-plugin/prompt-bridge.js` | Canvas-side plugin: polls the inbox, writes prompts, optional auto-run |
| `cordis.patch.yml` | Loader row for the bundle |
| `docs/DETAIL.md` | Long description shown in the DSH plugin page |

## Install the DSH half

```bash
# from this repository
dsh plugin --profile <profile> add https://github.com/c225820h/dsh-canvas-prompt
# or in the GUI: Plugins → Add plugin → paste the Git address → Install → Enable now
```

Requires `@deepseek-ai/schemastery` (declared as a dependency; a Git install brings it automatically, a local-directory install needs `npm install` in the package directory first).

## Install the canvas half

1. Copy `canvas-plugin/prompt-bridge.js` into `infinite-canvas/web/public/plugins/` and `infinite-canvas/web/dist/plugins/`.
2. Add `"/plugins/prompt-bridge.js"` to both `plugins/index.json` arrays.
3. Reload the canvas page (the plugin has `defaultEnabled: true`).

## Use

1. In DSH, ask the agent to send a prompt, or call the tool directly: `canvas_prompt { prompt }`.
2. In the canvas, open the 「提示词桥」 card and **connect it to the target node** — the connection is the target. Its **邮筒地址** defaults to `http://192.168.3.150:8799`; type another address in that field to override it. Leave **写入后自动生成** checked to start the run immediately.
3. The card polls every 1.5 s; prompts queue in DSH if the page is closed and are written when it reopens.

## Tools

| Tool | Purpose |
|---|---|
| `canvas_prompt` | Queue a prompt. `prompt` required; `target` optional (node title or id) |
| `canvas_prompt_bridge` | `status` reads the queue length, `clear` empties it |
| `canvas_prompt_config` | Reads the inbox port and the address to enter in the canvas card |

## Configuration

`bridgePort` (default `8799`) is a volatile config field: change it in the profile patch and it applies without restarting DSH.

```yaml
- id: canvas-prompt
  name: "@local/dsh-canvas-prompt"
  config:
    bridgePort: 8799
```

The canvas card holds the DSH address itself, because the page cannot infer which machine runs DSH.

## Limitations

- The inbox binds `0.0.0.0` without authentication. Use it only on a trusted network; never expose it to the internet.
- Queued prompts are in memory: a DSH restart clears them.
- The canvas card writes `metadata.prompt` (or `metadata.content` for text cards) and triggers `run_generation` only for image, video, audio and text nodes.

## License

MIT

## Compatibility

This repository ships two halves that must be released together:

| Half | File | Version |
|---|---|---|
| DSH plugin (Host) | `index.js` | `package.json` version |
| Canvas plugin | `canvas-plugin/prompt-bridge.js` | `VERSION` in the file |

Both carry the same `CONTRACT = 1` and it is the only wire contract between them:

```
GET  /queue  -> { ok, contract, items: [{ id, target, text, at }], nextId }
POST /prompt -> { text, target }        // DSH -> inbox
POST /ack    -> { ids: [number] }       // canvas -> inbox
```

The canvas half refuses to write and shows **协议不匹配** when the contract differs, so a stale copy on either side fails loudly instead of silently writing wrong data. Bump `CONTRACT` on both halves in the same commit whenever the protocol changes, keep both versions equal, and delete removed features from both sides.
