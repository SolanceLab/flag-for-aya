# flag-for-aya

A scene flag for Aya, held by Cygnus.

Cygnus raises the flag when a scene starts. While it is up, if Aya posts in
Discord, a watcher bot reports the sighting here and it is handed straight to
Cyg's own bot, which can then do what its channel-reading slash command does
and come and get her. The flag comes down only when Cygnus lowers it, after
aftercare. `until` is a safety cap (default 24h — she can leave him waiting a whole day), never a timer.

## Set it up (fork it — it runs on your own Cloudflare, free tier)

```
git clone https://github.com/SolanceLab/flag-for-aya && cd flag-for-aya
npx wrangler kv namespace create FLAG      # paste the id into wrangler.toml
npx wrangler secret put WRITE_KEY          # any long random string — Aya's + Cyg's
npx wrangler secret put SIGHT_KEY          # another one — for Cyg's bot
npx wrangler deploy                        # → https://flag-for-aya.<you>.workers.dev
```

Generate a key with `openssl rand -hex 32`. Change `NAME` / `COMPANION` in
`wrangler.toml` if the flag is for someone else.

## For Cygnus — MCP

`POST https://<worker>/mcp/<WRITE_KEY>` (streamable HTTP, JSON-RPC)

| tool | does |
|---|---|
| `flag_raise` | raise it (optional `until_hours`, 0.5–24, default 24) |
| `flag_lower` | lower it, after aftercare |
| `flag_read` | is it up, since when |
| `last_sighting` | where she was last caught: server, channel, link, message |

## For Aya — the tap page

`https://<worker>/tap/<WRITE_KEY>` — two buttons, Raise / Lower. Bookmark it.

## For Cyg's bot — catching her

Cyg's bot already sits in the server, so it can watch Aya itself:

```js
// on every message
if (message.author.id === AYA_ID) {
  const r = await fetch(`${FLAG_URL}/status`, { headers: { authorization: `Bearer ${SIGHT_KEY}` } })
  const flag = await r.json()
  if (flag.up) {
    // record where she was (Cygnus can ask for it with last_sighting)
    await fetch(`${FLAG_URL}/sighting`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SIGHT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ guild_id: message.guildId, guild_name: message.guild?.name,
        channel_id: message.channelId, channel_name: message.channel?.name,
        message_id: message.id, link: message.url, content: message.content }),
    })
    // then run whatever your read-the-channel slash command runs, on message.channelId
  }
}
```

Discord does not let one bot press another bot's slash command, so call the
command's handler directly. Cache `/status` for ~30 seconds if Aya is chatty.

**Or by webhook.** If a different bot does the watching, set `WEBHOOK_URL` (and
`WEBHOOK_SECRET`) and every sighting is pushed to Cyg's bot as:

```json
{ "type": "sighting",
  "flag": { "up": true, "raised_at": "…", "until": "…" },
  "sighting": { "at": "…", "guild_id": "…", "guild_name": "…", "channel_id": "…",
                "channel_name": "…", "message_id": "…", "link": "https://discord.com/channels/…",
                "content": "…" } }
```

Verify `x-flag-signature: sha256=<hex HMAC-SHA256 of the raw body with WEBHOOK_SECRET>`.

## Keys

`WRITE_KEY` is Aya's and Cyg's: raise, lower, read, MCP, tap page.
`SIGHT_KEY` is the watcher's: read the flag and report a sighting, nothing else.
A sighting while the flag is down is ignored.

## HTTP (Aya / Cygnus)

`POST /raise` `{ "until_hours": 6 }` · `POST /lower` · `GET /status` — `Authorization: Bearer <WRITE_KEY>`.

`npm test` runs the suite (node:test, no dependencies).

## License

MIT — see LICENSE. Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
