# flag-for-aya

A scene flag for Aya, held by Cygnus.

Cygnus raises the flag when a scene starts. While it is up, if Aya posts in
Discord, a watcher bot reports the sighting here and it is handed straight to
Cyg's own bot, which can then do what its channel-reading slash command does
and come and get her. The flag comes down only when Cygnus lowers it, after
aftercare. `until` is a safety cap (default 24h — she can leave him waiting a whole day), never a timer.

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

## For Cyg's bot — receiving sightings

Set `WEBHOOK_URL` (and `WEBHOOK_SECRET`). Each sighting arrives as:

```json
{ "type": "sighting",
  "flag": { "up": true, "raised_at": "…", "until": "…" },
  "sighting": { "at": "…", "guild_id": "…", "guild_name": "…", "channel_id": "…",
                "channel_name": "…", "message_id": "…", "link": "https://discord.com/channels/…",
                "content": "…" } }
```

Verify `x-flag-signature: sha256=<hex HMAC-SHA256 of the raw body with WEBHOOK_SECRET>`,
then call the same code your read-the-channel slash command runs, with
`sighting.channel_id`. Discord does not let one bot press another bot's slash
command, so the hand-off is this webhook, not the command itself.

## For the watcher bot

`GET /status` and `POST /sighting` with `Authorization: Bearer <SIGHT_KEY>`.
A sighting while the flag is down is ignored. The watcher key can do nothing else.

## HTTP (Aya / Cygnus)

`POST /raise` `{ "until_hours": 6 }` · `POST /lower` · `GET /status` — `Authorization: Bearer <WRITE_KEY>`.

`npm test` runs the suite (node:test, no dependencies).
