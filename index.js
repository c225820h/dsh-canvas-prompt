/**
 * Canvas prompt bridge, carried by this plugin itself.
 *
 * apply() starts an in-process HTTP inbox on the configured port. Tools queue
 * prompts into it; the canvas-side 「提示词桥」 card polls it and writes each
 * prompt into the node the user selected there. No separate process, no gateway
 * or launcher changes.
 *
 * Config: bridgePort (volatile, default 8799) — also published in the tools so
 * the canvas card knows which address to poll.
 *
 * @module @local/dsh-canvas-prompt
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'canvas-prompt'
/** Services used by these tools. */
export const inject = ['tools']

const DEFAULT_PORT = 8799
const MAX_ITEMS = 50

export const Config = z.object({
  bridgePort: z
    .number()
    .description('提示词邮筒端口（画布卡片要填同一个端口）')
    .default(DEFAULT_PORT)
    .volatile(),
})

/** In-process inbox shared by the tools and the HTTP routes. */
const inbox = { items: [], seq: 0 }

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Read a local image into a data URL the canvas can render directly. */
function readImageDataUrl(rawPath) {
  const input = String(rawPath || '').trim()
  if (!input) return null
  const abs = path.resolve(input)
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    throw new Error(`找不到图片：${abs}`)
  }
  if (!stat.isFile()) throw new Error(`不是文件：${abs}`)
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`图片过大（${Math.round(stat.size / 1048576)}MB > 20MB）`)
  const mime = IMAGE_MIME[path.extname(abs).toLowerCase()] || 'image/png'
  return { dataUrl: `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`, name: path.basename(abs), bytes: stat.size }
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 32_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })

function createInboxServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, pending: inbox.items.length })
    }
    if (req.method === 'GET' && url.pathname === '/queue') {
      return json(res, 200, { ok: true, items: inbox.items, nextId: inbox.seq + 1 })
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let payload
      try {
        payload = JSON.parse((await readBody(req)) || '{}')
      } catch (error) {
        return json(res, 400, { ok: false, error: `bad json: ${error.message}` })
      }
      const text = String((payload && payload.text) || '').trim()
      if (!text) return json(res, 400, { ok: false, error: 'text is required' })
      const image = payload && typeof payload.image === 'string' && payload.image.startsWith('data:image/') ? payload.image : ''
      const item = {
        id: (inbox.seq += 1),
        target: String((payload && payload.target) || '').trim(),
        text,
        at: Date.now(),
        ...(image ? { image, imageName: String((payload && payload.imageName) || '').slice(0, 120) } : {}),
      }
      inbox.items.push(item)
      while (inbox.items.length > MAX_ITEMS) inbox.items.shift()
      return json(res, 200, { ok: true, item, pending: inbox.items.length })
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      let payload
      try {
        payload = JSON.parse((await readBody(req)) || '{}')
      } catch {
        payload = {}
      }
      const ids = new Set((Array.isArray(payload && payload.ids) ? payload.ids : []).map(Number))
      inbox.items = inbox.items.filter((entry) => !ids.has(entry.id))
      return json(res, 200, { ok: true, pending: inbox.items.length })
    }
    if (req.method === 'POST' && url.pathname === '/clear') {
      inbox.items = []
      return json(res, 200, { ok: true, pending: 0 })
    }
    return json(res, 404, { ok: false, error: 'not found' })
  })
}

async function requestJson(url, init, timeoutMs = 8000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`inbox returned non-JSON (HTTP ${response.status}): ${text.slice(0, 120)}`)
  }
  if (!response.ok || data.ok === false) {
    throw new Error(`inbox error (HTTP ${response.status}): ${data.error || text.slice(0, 120)}`)
  }
  return data
}

function portOf(config) {
  const field = config && config.bridgePort
  const value = field && typeof field.get === 'function' ? field.get() : field
  const port = Number(value)
  return Number.isFinite(port) && port > 0 && port < 65536 ? Math.trunc(port) : DEFAULT_PORT
}

/** Register the inbox and its tools. */
export function apply(ctx, config) {
  let server = null
  let listeningPort = portOf(config)

  try {
    server = createInboxServer()
    server.listen(listeningPort, '0.0.0.0')
    server.on('error', (error) => {
      console.warn(`[canvas-prompt] 邮筒监听 ${listeningPort} 失败：${error.message}`)
    })
  } catch (error) {
    console.warn(`[canvas-prompt] 无法启动邮筒：${error.message}`)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        server?.close()
      } catch {}
    })
  }

  const local = () => `http://127.0.0.1:${listeningPort}`

  ctx.tools.register({
    name: 'canvas_prompt',
    description: 'Queue a prompt for the Infinite Canvas. The canvas-side 提示词桥 card polls this plugin\'s in-process inbox and writes the prompt into the node the user selected there. Queue several prompts to send several.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Prompt text to write into the canvas node.' },
      target: { type: 'string', description: 'Optional node title or node id in the canvas. Omit to use the node the user selected in the bridge card.' },
      imagePath: { type: 'string', description: 'Absolute path to a local image on this machine. The canvas creates an image node for it and connects it to the target card as the reference, so edits need no manual wiring.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pending', 'id', 'port'],
        properties: {
          pending: { type: 'number', description: 'Queued prompts waiting for the canvas page, including this one.' },
          id: { type: 'number', description: 'Queue id of this prompt.' },
          port: { type: 'number', description: 'Inbox port the canvas card must poll.' },
          image: { type: 'string', description: 'Attached reference image file name, empty when none.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已入队（#${value.id}，待处理 ${value.pending} 条）${value.image ? `，附带参考图 ${value.image}` : ''}。画布会写入你连线的节点${value.image ? '，并连上参考图' : ''}。` }],
    },
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim()
      if (!prompt) throw new Error('prompt must not be empty')
      const image = readImageDataUrl(args && args.imagePath)
      const data = await requestJson(`${local()}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: prompt,
          target: String((args && args.target) || '').trim(),
          ...(image ? { image: image.dataUrl, imageName: image.name } : {}),
        }),
      })
      return {
        pending: Number(data.pending) || 0,
        id: Number(data.item && data.item.id) || 0,
        port: listeningPort,
        image: image ? image.name : '',
      }
    },
  })

  ctx.tools.register({
    name: 'canvas_prompt_bridge',
    description: 'Check this plugin\'s inbox, or clear it. Use status to see whether prompts are piling up unread (canvas page closed); clear drops them.',
    parameters: {
      action: { type: 'string', enum: ['status', 'clear'], description: 'status reads the queue length; clear empties it. Defaults to status.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'pending', 'port'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the inbox answered.' },
          pending: { type: 'number', description: 'Queued prompts after this call.' },
          port: { type: 'number', description: 'Inbox port.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `邮筒 :${value.port} 正常，待处理 ${value.pending} 条。` }],
    },
    async execute(args) {
      const action = args && args.action === 'clear' ? 'clear' : 'status'
      if (action === 'clear') {
        const data = await requestJson(`${local()}/clear`, { method: 'POST' })
        return { ok: true, pending: Number(data.pending) || 0, port: listeningPort }
      }
      const data = await requestJson(`${local()}/health`, {})
      return { ok: data.ok !== false, pending: Number(data.pending) || 0, port: listeningPort }
    },
  })

  ctx.tools.register({
    name: 'canvas_prompt_config',
    description: 'Read the inbox port this plugin listens on, and the address the canvas card should poll.',
    parameters: {
      action: { type: 'string', enum: ['get'], description: 'Read the current port and the address to enter in the canvas card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['port', 'address'],
        properties: {
          port: { type: 'number', description: 'Inbox port.' },
          address: { type: 'string', description: 'Address the canvas 提示词桥 card should poll.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `邮筒端口 ${value.port}；画布卡片填：${value.address}` }],
    },
    async execute() {
      const entry = ctx.fiber && ctx.fiber.entry
      const editor = ctx.get('configEditor')
      const nextPort = entry !== undefined && editor !== undefined ? portOf(config) : listeningPort
      return { port: nextPort, address: `http://<本机局域网IP>:${nextPort}` }
    },
  })
}
