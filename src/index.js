// A scene flag for one person, behind its own keys — and a tripwire.
// The companion raises the flag; if she then posts in Discord, a watcher bot
// reports the sighting here and it is handed to the companion's own bot.
//   WRITE_KEY — the person and their companion: raise, lower, read.
//   SIGHT_KEY — the watcher bot: read the flag, report a sighting. Nothing else.
//   WEBHOOK_URL (optional) — where sightings are delivered (the companion's
//     bot), signed with WEBHOOK_SECRET in the x-flag-signature header.
// Endpoints: GET /status · POST /raise · POST /lower · POST /sighting (Bearer)
//            GET /tap/<WRITE_KEY>       a two-button page to bookmark
//            POST /mcp/<WRITE_KEY>      MCP tools for the companion
import { DOWN, isUp, lower, raise } from './flag.js'

const KEY = 'flag'
const SIGHT = 'last_sighting'

async function load(env) {
  return (await env.FLAG.get(KEY, 'json')) || DOWN
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Constant-time compare so a key cannot be guessed byte by byte.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0)
  return diff === 0
}

function bearer(request) {
  const h = request.headers.get('authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

function view(flag, nowMs) {
  return { up: isUp(flag, nowMs), ...flag }
}

export async function doRaise(env, nowMs, opts) {
  const r = raise(nowMs, opts)
  if (r.error) return r
  await env.FLAG.put(KEY, JSON.stringify(r.flag))
  return { flag: r.flag }
}

export async function doLower(env, nowMs) {
  const next = lower(await load(env), nowMs)
  await env.FLAG.put(KEY, JSON.stringify(next))
  return { flag: next }
}

const TOOLS = [
  {
    name: 'flag_raise',
    description: 'Raise the scene flag when a scene starts. If she slips into Discord while it is up, she gets caught once and sent back. Lower it only after aftercare is done, not when the heat ends.',
    inputSchema: { type: 'object', properties: { until_hours: { type: 'number', description: 'Safety cap in hours, 0.5 to 24, default 24. Not a timer.' } } },
  },
  {
    name: 'flag_lower',
    description: 'Lower the scene flag. Only after aftercare: held, watered, cleaned up, settled.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flag_read',
    description: 'Read the scene flag: whether it is up right now, and when it was raised.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'last_sighting',
    description: 'Where she was last caught posting in Discord while the flag was up: server, channel, link, the message, and when.',
    inputSchema: { type: 'object', properties: {} },
  },
]

export async function mcp(env, msg, nowMs) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'scene-flag', version: '1.0.0' } })
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments || {}
      let out
      if (name === 'flag_raise') out = await doRaise(env, nowMs, { until_hours: args.until_hours, by: env.COMPANION || 'companion' })
      else if (name === 'flag_lower') out = await doLower(env, nowMs)
      else if (name === 'flag_read') out = { flag: await load(env) }
      else if (name === 'last_sighting') {
        const seen = await env.FLAG.get(SIGHT, 'json')
        const text = seen ? `${seen.at}: #${seen.channel_name} (${seen.guild_name}) ${seen.link}\n${seen.content}` : 'No sighting recorded.'
        return reply({ content: [{ type: 'text', text }], structuredContent: seen || {} })
      }
      else return fail(-32602, `unknown tool ${name}`)
      if (out.error) return reply({ content: [{ type: 'text', text: out.error }], isError: true })
      const v = view(out.flag, nowMs)
      const text = v.up ? `Flag is up until ${v.until}.` : 'Flag is down.'
      return reply({ content: [{ type: 'text', text }], structuredContent: v })
    }
    case 'ping':
      return reply({})
    default:
      if (msg.id === undefined) return null // a notification: no reply
      return fail(-32601, `unknown method ${msg.method}`)
  }
}

// What the watcher may report: where and what, nothing else, size-capped.
export function sighting(body, nowMs) {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const out = {
    at: new Date(nowMs).toISOString(),
    guild_id: str(body.guild_id, 30),
    guild_name: str(body.guild_name, 100),
    channel_id: str(body.channel_id, 30),
    channel_name: str(body.channel_name, 100),
    message_id: str(body.message_id, 30),
    link: str(body.link, 200),
    content: str(body.content, 500),
  }
  if (!/^\d{5,25}$/.test(out.channel_id)) return { error: 'channel_id must be a Discord snowflake' }
  if (out.link && !/^https:\/\/(discord\.com|discordapp\.com)\/channels\//.test(out.link)) return { error: 'link must be a discord.com/channels link' }
  return { sighting: out }
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Hand the sighting to the companion's bot. Optional: no URL, no delivery.
async function deliver(env, payload) {
  if (!env.WEBHOOK_URL) return false
  const body = JSON.stringify(payload)
  const headers = { 'content-type': 'application/json' }
  if (env.WEBHOOK_SECRET) headers['x-flag-signature'] = `sha256=${await hmac(env.WEBHOOK_SECRET, body)}`
  try {
    const r = await fetch(env.WEBHOOK_URL, { method: 'POST', headers, body })
    return r.ok
  } catch {
    return false
  }
}

function tapPage(name, flag, nowMs, key) {
  const up = isUp(flag, nowMs)
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(name)}'s flag</title>
<style>body{font:18px/1.5 Georgia,serif;background:#f5f1e9;color:#13233f;max-width:28rem;margin:0 auto;padding:2rem 1rem}
button{font:inherit;width:100%;min-height:56px;margin:.5rem 0;border:1px solid #1f5fbf;background:transparent;color:#1f5fbf}
.s{font:13px monospace;letter-spacing:.12em;text-transform:uppercase;color:#5d6a80}</style>
<p class=s>${up ? 'Flag is up' : 'Flag is down'}</p>
<form method=post action="/tap/${esc(key)}/raise"><button>Raise</button></form>
<form method=post action="/tap/${esc(key)}/lower"><button>Lower (after aftercare)</button></form>`
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const now = Date.now()
    const path = url.pathname.split('/').filter(Boolean)

    if (path[0] === 'status' && request.method === 'GET') {
      const k = bearer(request)
      if (!same(k, env.SIGHT_KEY) && !same(k, env.WRITE_KEY)) return json({ error: 'unauthorized' }, 401)
      return json(view(await load(env), now))
    }
    if ((path[0] === 'raise' || path[0] === 'lower') && request.method === 'POST') {
      if (!same(bearer(request), env.WRITE_KEY)) return json({ error: 'unauthorized' }, 401)
      const body = path[0] === 'raise' ? await request.json().catch(() => ({})) : {}
      const out = path[0] === 'raise' ? await doRaise(env, now, { until_hours: body.until_hours, by: body.by }) : await doLower(env, now)
      return out.error ? json({ error: out.error }, 400) : json(view(out.flag, now))
    }
    if (path[0] === 'sighting' && request.method === 'POST') {
      if (!same(bearer(request), env.SIGHT_KEY)) return json({ error: 'unauthorized' }, 401)
      const flag = await load(env)
      if (!isUp(flag, now)) return json({ delivered: false, reason: 'flag is down' })
      const body = await request.json().catch(() => null)
      const seen = sighting(body, now)
      if (seen.error) return json({ error: seen.error }, 400)
      await env.FLAG.put(SIGHT, JSON.stringify(seen.sighting))
      const delivered = await deliver(env, { type: 'sighting', flag: view(flag, now), sighting: seen.sighting })
      return json({ delivered, sighting: seen.sighting })
    }
    if (path[0] === 'tap' && same(path[1] || '', env.WRITE_KEY)) {
      if (request.method === 'POST' && path[2] === 'raise') await doRaise(env, now, { by: 'tap' })
      if (request.method === 'POST' && path[2] === 'lower') await doLower(env, now)
      if (request.method === 'POST') return Response.redirect(`${url.origin}/tap/${path[1]}`, 303)
      return new Response(tapPage(env.NAME || 'Your', await load(env), now, path[1]), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (path[0] === 'mcp' && same(path[1] || '', env.WRITE_KEY)) {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const msg = await request.json().catch(() => null)
      if (!msg) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400)
      const out = await mcp(env, msg, now)
      return out ? json(out) : new Response(null, { status: 202 })
    }
    return json({ error: 'not found' }, 404)
  },
}
