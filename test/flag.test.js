import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { sighting } from '../src/index.js'
import { isUp, raise } from '../src/flag.js'

const T0 = Date.parse('2026-10-06T10:00:00Z')

function env(extra = {}) {
  const store = new Map()
  return {
    FLAG: { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => void store.set(k, v) },
    WRITE_KEY: 'w-key', SIGHT_KEY: 's-key', NAME: 'Aya', COMPANION: 'cygnus', ...extra,
  }
}
const req = (method, path, { key, body } = {}) =>
  new Request('https://flag.test' + path, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
const call = async (e, ...a) => { const r = await worker.fetch(req(...a), e); return { status: r.status, body: r.status === 202 ? null : await r.json().catch(() => null) } }

test('raise sets a safety cap, default 24h; out-of-range is refused', () => {
  const r = raise(T0, {})
  assert.equal(r.flag.until, '2026-10-07T10:00:00.000Z') // default 24h: she can leave him waiting a whole day
  assert.ok(raise(T0, { until_hours: 30 }).error)
  assert.ok(raise(T0, { until_hours: 0.1 }).error)
})

test('isUp: true while active and before the cap only', () => {
  const { flag } = raise(T0, { until_hours: 1 })
  assert.equal(isUp(flag, T0 + 1000), true)
  assert.equal(isUp(flag, T0 + 3600000), false)
  assert.equal(isUp({ ...flag, active: false }, T0 + 1000), false)
})

test('keys: write key raises; sight key cannot; no key cannot read', async () => {
  const e = env()
  assert.equal((await call(e, 'POST', '/raise', { key: 's-key', body: {} })).status, 401)
  assert.equal((await call(e, 'GET', '/status')).status, 401)
  const up = await call(e, 'POST', '/raise', { key: 'w-key', body: { until_hours: 2 } })
  assert.equal(up.body.up, true)
  assert.equal((await call(e, 'GET', '/status', { key: 's-key' })).body.up, true)
  assert.equal((await call(e, 'POST', '/lower', { key: 'w-key' })).body.up, false)
})

test('a sighting is ignored while the flag is down, recorded while up', async () => {
  const e = env()
  const s = { channel_id: '1234567890123', channel_name: 'general', guild_name: 'HoS', link: 'https://discord.com/channels/1/2/3', content: 'hi' }
  const down = await call(e, 'POST', '/sighting', { key: 's-key', body: s })
  assert.equal(down.body.delivered, false)
  assert.equal(down.body.reason, 'flag is down')
  await call(e, 'POST', '/raise', { key: 'w-key', body: {} })
  const up = await call(e, 'POST', '/sighting', { key: 's-key', body: s })
  assert.equal(up.status, 200)
  assert.equal(up.body.sighting.channel_name, 'general')
  assert.equal((await call(e, 'POST', '/sighting', { key: 'w-key', body: s })).status, 401) // only the watcher reports
})

test('sighting input is validated and size-capped', () => {
  assert.ok(sighting({ channel_id: 'nope' }, T0).error)
  assert.ok(sighting({ channel_id: '1234567890123', link: 'https://evil.example/x' }, T0).error)
  assert.equal(sighting({ channel_id: '1234567890123', content: 'x'.repeat(2000) }, T0).sighting.content.length, 500)
})

test('MCP: tools list, raise via tool, last_sighting, unknown key path 404', async () => {
  const e = env()
  const rpc = (body) => call(e, 'POST', '/mcp/w-key', { body })
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['flag_raise', 'flag_lower', 'flag_read', 'last_sighting'])
  const raised = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flag_raise', arguments: {} } })
  assert.equal(raised.body.result.structuredContent.up, true)
  assert.equal(raised.body.result.structuredContent.raised_by, 'cygnus')
  const none = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'last_sighting', arguments: {} } })
  assert.match(none.body.result.content[0].text, /No sighting/)
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.equal((await call(e, 'POST', '/mcp/wrong', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 404)
})

test('webhook: delivered with an HMAC signature when configured', async () => {
  let seen
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response('ok') }
  try {
    const e = env({ WEBHOOK_URL: 'https://cyg.example/hook', WEBHOOK_SECRET: 'sh' })
    await call(e, 'POST', '/raise', { key: 'w-key', body: {} })
    const r = await call(e, 'POST', '/sighting', { key: 's-key', body: { channel_id: '1234567890123', content: 'hi' } })
    assert.equal(r.body.delivered, true)
    assert.equal(seen.url, 'https://cyg.example/hook')
    assert.match(seen.init.headers['x-flag-signature'], /^sha256=[0-9a-f]{64}$/)
    assert.equal(JSON.parse(seen.init.body).type, 'sighting')
  } finally { globalThis.fetch = realFetch }
})
