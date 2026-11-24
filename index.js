/**
 * Canvas prompt bridge tools: send a prompt to the Infinite Canvas on the LAN,
 * where a canvas-side plugin writes it into the node the user selected.
 *
 * The bridge address is a volatile Config field: it is editable while the plugin
 * runs (settings form or the canvas_prompt_config tool) and read through its
 * reference. Resolution order: per-call `bridge` argument → Config bridgeUrl →
 * CANVAS_BRIDGE_URL → built-in default.
 *
 * @module @local/dsh-canvas-prompt
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'canvas-prompt'
/** Services used by these tools. */
export const inject = ['tools']

const BUILTIN_BRIDGE = 'http://192.168.3.200:8799'

export const Config = z.object({
  bridgeUrl: z
    .string()
    .description('画布提示词桥地址，例如 http://192.168.3.200:8799；留空使用内置默认。')
    .default('')
    .volatile(),
})

export function normalizeBridge(input) {
  const base = String(input || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new Error(`bridge must look like http://host:port, got: ${input}`)
  return base
}

function envBridge() {
  return String(process.env.CANVAS_BRIDGE_URL || '').trim()
}

async function requestJson(url, init, timeoutMs = 8000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`bridge returned non-JSON (HTTP ${response.status}): ${text.slice(0, 120)}`)
  }
  if (!response.ok || data.ok === false) {
    throw new Error(`bridge error (HTTP ${response.status}): ${data.error || text.slice(0, 120)}`)
  }
  return data
}

/** Register the canvas prompt tools. */
export function apply(ctx, config) {
  function savedBridge() {
    const field = config && config.bridgeUrl
    const value = field && typeof field.get === 'function' ? field.get() : field
    return String(value || '').trim()
  }

  function resolveBridge(callArg) {
    const raw = String(callArg || '').trim()
    return normalizeBridge(raw || savedBridge() || envBridge() || BUILTIN_BRIDGE)
  }

  function bridgeSource() {
    if (savedBridge()) return 'config'
    if (envBridge()) return 'env'
    return 'default'
  }

  ctx.tools.register({
    name: 'canvas_prompt',
    description: "Queue a prompt for the Infinite Canvas. A canvas-side plugin writes it into the node the user selected there; the user then runs the generation. The bridge address comes from this plugin's settings, so neither the user nor you need to know the host.",
    parameters: {
      prompt: { type: 'string', required: true, description: 'Prompt text to write into the canvas node.' },
      target: { type: 'string', description: 'Optional node title or node id in the canvas. Omit to use the node the user selected in the bridge card.' },
      bridge: { type: 'string', description: 'Optional one-off bridge base URL, overriding the saved setting.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pending', 'id', 'bridge'],
        properties: {
          pending: { type: 'number', description: 'Items waiting for the canvas page to pick up, including this one.' },
          id: { type: 'number', description: 'Queue id of this prompt.' },
          bridge: { type: 'string', description: 'Bridge base URL that accepted the prompt.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已发送到画布队列（#${value.id}，待处理 ${value.pending} 条）。画布页面会写入你选中的节点。` }],
    },
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim()
      if (!prompt) throw new Error('prompt must not be empty')
      const bridge = resolveBridge(args && args.bridge)
      const data = await requestJson(`${bridge}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: prompt, target: String((args && args.target) || '').trim() }),
      })
      return { pending: Number(data.pending) || 0, id: Number(data.item && data.item.id) || 0, bridge }
    },
  })

  ctx.tools.register({
    name: 'canvas_prompt_bridge',
    description: 'Check the prompt bridge queue, or clear it. Use status to confirm the canvas host is reachable before sending; use clear to drop prompts the canvas page never picked up.',
    parameters: {
      action: { type: 'string', enum: ['status', 'clear'], description: 'status reads the queue length; clear empties it. Defaults to status.' },
      bridge: { type: 'string', description: 'Optional one-off bridge base URL, overriding the saved setting.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'pending', 'bridge'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the bridge answered.' },
          pending: { type: 'number', description: 'Queued prompts after this call.' },
          bridge: { type: 'string', description: 'Bridge base URL that answered.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `桥 ${value.bridge} 正常，待处理 ${value.pending} 条。` }],
    },
    async execute(args) {
      const bridge = resolveBridge(args && args.bridge)
      const action = args && args.action === 'clear' ? 'clear' : 'status'
      if (action === 'clear') {
        const data = await requestJson(`${bridge}/clear`, { method: 'POST' })
        return { ok: true, pending: Number(data.pending) || 0, bridge }
      }
      const data = await requestJson(`${bridge}/health`, {})
      return { ok: data.ok !== false, pending: Number(data.pending) || 0, bridge }
    },
  })

  ctx.tools.register({
    name: 'canvas_prompt_config',
    description: "Read the canvas bridge address, or save a new one into this plugin's settings so it survives restarts. The same value is editable in the DSH plugin settings form.",
    parameters: {
      action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'get shows the address and its source; set stores a new one; clear removes the saved value.' },
      bridge: { type: 'string', description: 'Required for set: the address to use, such as http://192.168.3.201:8799.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['bridge', 'source'],
        properties: {
          bridge: { type: 'string', description: 'The address that will be used.' },
          source: { type: 'string', description: 'Where the address comes from: config, env, or default.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `当前画布地址：${value.bridge}（来源：${value.source}）` }],
    },
    async execute(args) {
      const action = args && args.action ? args.action : 'get'
      const entry = ctx.fiber && ctx.fiber.entry
      const editor = ctx.get('configEditor')

      if (action === 'set') {
        const next = normalizeBridge(args && args.bridge)
        if (entry === undefined || editor === undefined) {
          throw new Error('这个 profile 里不能保存配置；请在 DSH 设置页的插件配置里修改画布地址。')
        }
        await editor.edit(entry, (current) => ({ ...current, bridgeUrl: next }))
        return { bridge: next, source: 'config' }
      }

      if (action === 'clear') {
        if (entry === undefined || editor === undefined) throw new Error('这个 profile 里不能保存配置。')
        await editor.edit(entry, (current) => ({ ...current, bridgeUrl: '' }))
        return { bridge: normalizeBridge(envBridge() || BUILTIN_BRIDGE), source: envBridge() ? 'env' : 'default' }
      }

      return { bridge: resolveBridge(''), source: bridgeSource() }
    },
  })
}
