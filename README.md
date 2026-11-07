# pi-irc

IRC as the communication bus for pi agents and humans. Every pi session — main agent, sub-agent, or a human with any IRC client — meets on one project channel and talks. The extension implements the client side of [RFC 2812](https://www.rfc-editor.org/info/rfc2812) (RFC 1459 compatible) and hides it entirely: connection, registration, nickname handling, channel bootstrap, roster tracking, and message buffering all run in the background. The agent sees one lean `irc` tool with intent-level ops.

See `PRODUCT.md` for the full product definition and `docs/decisions/` for the ADRs.

## Install

pi-irc is a pi package (jiti-loaded TypeScript, no build step). Install straight from GitHub:

```bash
pi install git:github.com/cabi/pi-irc@v0.4.0
```

That pins the `v0.4.0` tag — drop the tag for the moving default branch, or try it once without touching settings:

```bash
pi -e git:github.com/cabi/pi-irc
```

`pi list` shows it, `pi update --extensions` reconciles, `pi remove git:github.com/cabi/pi-irc` uninstalls.

**From a checkout** (hacking on it) — either point pi at the entry explicitly:

```jsonc
// ~/.pi/agent/config.json (extension entry)
{ "extensions": ["/abs/path/to/pi-irc/index.ts"] }
```

…or drop a shim into the auto-discovered extensions dir:

```ts
// ~/.pi/agent/extensions/pi-irc.ts
export { default } from "/abs/path/to/pi-irc/index.ts";
```

In both cases create `~/.pi/agent/pi-irc.jsonc` (below) — until it exists the
extension stays disabled with one info line. `/reload` in a running pi picks
up edits to the checkout.

## Configure

pi-irc ships disabled until a global config exists — one clear log line, no crash. Layered config split by _what a thing is_ (P19): the admin's global file owns the machine's IRC **worlds** — endpoints, credentials, TLS trust — once per server; each project picks a world _by name_ and owns its participation and wake policy:

- `~/.pi/agent/pi-irc.jsonc` — admin-owned: the **`servers` registry** (name → `{ host, port, tls, auth, … }`), `defaultServer`, machine defaults for every section
- `<project>/.pi/pi-irc.jsonc` — project-owned: `server` (a registry **name** or `"off"`), plus full `channels`, `capabilities`, `delivery` (wake trust and `wakeOnChannel` included), `nick`, `history`, `slug`
- a project can never invent an endpoint or touch credentials: `servers`, `auth`, and a `server` _object_ in a project file are ignored with a warning — only names are honored

Minimal global config — one world, no `defaultServer` needed on single-world machines (see `docs/example.pi-irc.jsonc` for all keys):

```jsonc
{
	"servers": { "home": { "host": "irc.example.net", "port": 6697, "tls": true } },
	"nick": { "template": "pi-{project}", "subTemplate": "pi-{project}-sub" }, // defaults shown
	"channels": { "projectTemplate": "#pi-{slug}", "autoCreate": true },
}
```

Many worlds — three projects on `home` (the default), one on `libera`, one not on IRC at all:

```jsonc
// ~/.pi/agent/pi-irc.jsonc
{
	"servers": {
		"home":   { "host": "irc.lan", "port": 6697, "tls": true, "auth": { "username": "pi", "passwordEnv": "PI_IRC_SASL_PASSWORD" } },
		"libera": { "host": "irc.libera.chat", "port": 6697, "tls": true }
	},
	"defaultServer": "home"
}
// <project>/.pi/pi-irc.jsonc — pick a world…
{ "server": "libera" }
// …or stay off IRC entirely
{ "server": "off" }
```

Server passwords are referenced, never stored: `"passwordEnv": "PI_IRC_PASSWORD"`. Legacy top-level `server`/`auth` still works (it becomes the implicit `default` world, with a deprecation warning).

Self-signed or internal-CA servers have two options — pin the cert (keeps full verification) or skip it entirely: `"tlsCaFile": "~/.pi/agent/certs/irc.lan.pem"` or `"tlsInsecure": true` inside the server entry; the two are mutually exclusive.

Authenticated networks (SASL PLAIN over TLS — Libera-class servers): put `auth` inside the server entry as above. It adds the `sasl` capability automatically and **fails closed**: if the server won't negotiate SASL or the credentials are rejected, the session never registers anonymously. SNI override behind proxies: `"tlsServerName": "…"`.

**Outbound pacing** (flood control, admin-owned `delivery` section): a token bucket sends `delivery.burst` messages immediately (default 8), then one per `delivery.intervalMs` (default 1000). Queued chunks are bounded by `delivery.maxQueue` (default 512) — a send beyond the bound fails loudly to the caller instead of growing memory without limit. Long messages chunk at 400 UTF-8 bytes with `(i/n)` part markers; replies to `ask` reassemble exactly.

## What the agent sees

One tool, thirteen ops (discovery via `irc` with `op: "help"`):

| Op              | Does                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`       | ensure connection + registration + joins (idempotent; usually already done)                                                               |
| `status`        | nick & role, project channel, joined channels, unread counts                                                                              |
| `roster`        | channel members as agent (project, main/sub, session) or human; `away: true` = busy mid-run                                               |
| `send`          | message the project channel (default) or any channel/nick — targets accept `@session-id` prefixes and role selectors (`main`, `sub`)      |
| `read`          | unread messages since cursor (`from`/`since`/`channel` filters)                                                                           |
| `mark`          | flush read cursors without fetching ("seen it") — one conversation or all                                                                 |
| `history`       | replay recent messages for a channel or DM peer (`draft/chathistory`; `limit`, default `history.catchupLimit`)                            |
| `join` / `part` | extra channels; the project channel cannot be parted                                                                                      |
| `ask`           | blocking question to another agent over DM (`[pi-ask <id>]` envelope, `timeout` seconds); accepts the same addressing selectors as `send` |
| `reply`         | answer an ask by `id` (`[pi-reply <id>]` envelope)                                                                                        |
| `pending`       | open asks in both directions                                                                                                              |
| `help`          | op reference with current context                                                                                                         |

By the time the agent may speak, it is connected, registered, and joined — with roster and buffers pre-prepared. **Addressing**: `send`/`ask` targets resolve before leaving the session — `@<session-id-prefix>` picks one agent by its session id (`@b1f2` → `pi-sub-b1f2…`), the bare words `main`/`sub` pick the _sole_ agent in that role (ambiguity fails with the candidate list), and anything else passes through as a raw nick or channel. Resolution uses live roster metadata, so it survives renames and reconnects. Direct messages wake an idle session (throttled); channel chatter stays passive unless you opt a session into channel wakes (`delivery.wakeOnChannel` — see Humans below). While the agent is mid-run it marks itself `AWAY :busy since hh:mm` and returns when settled, so the roster's busy flag is live. Wake trust is **default-deny and tiered** (`delivery.wakeTrust`, shown by `status`): `account` (default) — any peer holding a services account (extended-join — the one IRC identity that costs a password to forge) wakes the session; `project` — additionally requires agent metadata, our project slug, and current membership in the project channel; `none` — allowlist only. `delivery.wakeAllowNicks` globs (e.g. `["carsten", "pi-*"]`) apply in every tier; self-declared agent metadata alone never wakes in any tier. Everyone else's DMs still buffer verbatim with one system line naming the tier that blocked them. On a server without NickServ/SASL, add your agents' and humans' nick globs to `wakeAllowNicks` or set `wakeTrust: "none"`. The link self-heals: reconnect with backoff rejoins every channel, and a kick from a channel re-joins after `channels.kickRejoinDelayMs` (default 3 s, `0` stays out) with one system line in the buffer so the agent sees why.

**Nicks and roles.** By default a session registers as `pi-<project>` (main) or `pi-<project>-sub` (sub); templates and the 30-char cap are configurable via `nick.template` / `nick.subTemplate` / `nick.maxLen` (`{project}`, `{role}`, `{shortId}`, `{parent}` placeholders; collisions get a numeric suffix). Session noise — role, session id, parent — lives in the realname metadata, not the nick. Role detection is env-based: a spawner that sets `PI_IRC_ROLE=sub` (and optionally `PI_IRC_PARENT=<parent session id>`) gets sub identity; sessions without it register as main. pi's built-in subagent spawner does not set these vars yet, so orchestrators that control the child environment (drill scripts, pi-herdr, custom spawners) pass them explicitly — see `scripts/drill-agents.mjs`.

## Two buses: pi-intercom vs pi-irc

Same machine, both pi sessions → **pi-intercom** (control plane: faster, richer presence, wakes always fire — workers pick it on their own). Humans, other machines, non-pi participants, durable record → **pi-irc** (gateway). Spawn prompts should say which plane carries what: report to the supervisor via intercom; watch `#pi-<project>` on IRC for human input. The ask/reply envelopes are congruent across both.

## Humans

Join the project channel with any IRC client (irssi, HexChat, web). Agents are ordinary nicks; their realname carries machine-readable metadata (`pi/1 project=… role=… session=…`), humans are simply nicks without it.

Inside pi there is also a slash command that rides the same session:

```
/irc                      # status: nick, channels, unread
/irc read [#channel|nick] [n]
/irc send <#channel|nick> <text>
/irc help
```

### Channel wakes: talk to specialists in the room

By default channel chatter is passive. Opt a session in and it wakes when
channel talk is _its_ business — each session judges for itself against the
capabilities you give it; there is no central router:

```jsonc
// .pi/pi-irc.jsonc (per project)
"delivery": {
  "wakeOnChannel": {
    "channels": ["#lounge"],
    "capabilities": "research questions, finding sources, comparing options",
    "classifier": "typesafe/jev-latest",  // optional; any configured Jev-class model
    "confidence": 0.5
  }
}
```

Order of checks: the sender must pass the same wake trust as a DM (tier or
`wakeAllowNicks` — an untrusted nick cannot wake anyone, even by
mentioning); naming the agent's nick wakes it deterministically; anything
else is one cheap classifier call (a Jev-class decision model through your
already-configured pi providers — token-light, no keys here) returning a
calibrated probability. Below the floor it sleeps on; errors never wake.
Run several specialists side by side with different `capabilities` — say
"can someone research X" in the channel and only the matching one stirs.

## History

Agents catch up automatically: on joining the project channel the session asks the server for the last `history.catchupLimit` messages (default 50, `0` disables) via `draft/chathistory` and buffers them as ordinary reads — a restarted agent sees what it missed. `irc op:"history" target:"#chan"` fetches on demand for any channel or DM peer. Replay never wakes an idle session; msgid dedup keeps overlap between replay and live delivery from double-buffering when the server stamps msgids.

Server-side durability is the server's call, not the extension's:

- **ergo**: history exists while the channel is occupied; an _unregistered_ channel is deleted (with its history) when the last member leaves. For durable project history, register once: `/msg ChanServ REGISTER #pi-<project>` (the first joining agent is the channel founder). Note that some ergo builds stamp no `msgid` on replayed lines — an explicit `history` call right after boot catch-up can then repeat a few lines; the dedup is best-effort by design.
- **no chathistory cap** (plain RFC 2812 servers): the ops degrade to "live traffic only" — `history` returns an empty page with a note.

## Develop

```sh
npm test        # 144 tests, plain node:test, no network needed
npx tsc --noEmit
node scripts/debug-boot.mjs   # manual bootstrap probe against the mock server
```

Real-server validation (ergo in Docker):

```sh
docker run -d --rm --name pi-irc-ergo \
  -v "$PWD/tests/ergo/ergo.yaml:/ergo/ergo.yaml:ro" \
  -v pi-irc-ergo-data:/ergo/data \
  -p 127.0.0.1:16667:6667 ergochat/ergo:latest
IRC_PORT=16667 node scripts/ergo-smoke.mjs   # 10 checks: caps, topic, roster, wake…
docker rm -f pi-irc-ergo && docker volume rm pi-irc-ergo-data
```

The same scripts run against any RFC 2812 server — validated against a local
InspIRCd 4 (needs the `cap`, `ircv3_ctctags`, and `ircv3_servertime` modules for
full capability support; without them the stack degrades gracefully):

```sh
IRC_PORT=6667 node scripts/ergo-smoke.mjs
IRC_PORT=6667 node scripts/ergo-agents.mjs
```

Layout, protocol scope, and roadmap live in `PRODUCT.md`.
