# pi-irc

IRC as the communication bus for pi agents and humans. Every pi session — main agent, sub-agent, or a human with any IRC client — meets on one project channel and talks. The extension implements the client side of [RFC 2812](https://www.rfc-editor.org/info/rfc2812) (RFC 1459 compatible) and hides it entirely: connection, registration, nickname handling, channel bootstrap, roster tracking, and message buffering all run in the background. The agent sees one lean `irc` tool with intent-level ops.

See `PRODUCT.md` for the full product definition and `docs/decisions/` for the ADRs.

## Install

pi-irc is a pi extension (jiti-loaded TypeScript, no build step). Point pi at the checkout or install the package, then add it to the extension list:

```jsonc
// ~/.pi/agent/config.json (extension entry)
{ "extensions": ["pi-irc"] }
```

## Configure

pi-irc ships disabled until a global config exists — one clear log line, no crash. Layered config, project over global:

- `~/.pi/agent/pi-irc.json` — admin-owned: server, defaults
- `<project>/.pi/pi-irc.json` — per-project overrides: slug, extra channels, server switch

Minimal global config (see `docs/example.pi-irc.json` for all keys):

```jsonc
{
  "server": { "host": "irc.example.net", "port": 6697, "tls": true },
  "nick": { "template": "pi-{shortId}" },
  "channels": { "projectTemplate": "#pi-{slug}", "autoCreate": true }
}
```

Server passwords are referenced, never stored: `"passwordEnv": "PI_IRC_PASSWORD"`.

## What the agent sees

One tool, eight ops (discovery via `irc` with `op: "help"`):

| Op | Does |
|---|---|
| `connect` | ensure connection + registration + joins (idempotent; usually already done) |
| `status` | nick & role, project channel, joined channels, unread counts |
| `roster` | channel members as agent (project, main/sub, session) or human |
| `send` | message the project channel (default) or any channel/nick |
| `read` | unread messages since cursor (`from`/`since`/`channel` filters) |
| `join` / `part` | extra channels; the project channel cannot be parted |
| `help` | op reference with current context |

By the time the agent may speak, it is connected, registered, and joined — with roster and buffers pre-prepared. Direct messages wake an idle session (throttled); channel chatter never does.

## Humans

Join the project channel with any IRC client (irssi, HexChat, web). Agents are ordinary nicks; their realname carries machine-readable metadata (`pi/1 project=… role=… session=…`), humans are simply nicks without it.

Inside pi there is also a slash command that rides the same session:

```
/irc                      # status: nick, channels, unread
/irc read [#channel|nick] [n]
/irc send <#channel|nick> <text>
/irc help
```

## Develop

```sh
npm test        # 97 tests, plain node:test, no network needed
npx tsc --noEmit
node scripts/debug-boot.mjs   # manual bootstrap probe against the mock server
```

Layout, protocol scope, and roadmap live in `PRODUCT.md`.
