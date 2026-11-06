# pi-irc — IRC as the communication bus for pi agents and humans

**Status:** v0.3.0 — P1–P7 shipped: RFC 2812 client (reconnect, IRCv3 caps, SASL PLAIN, TLS), session bootstrap, `irc` tool with ask/reply RPC and presence; validated live against ergo and InspIRCd · **Repo:** `~/Projects/pi-extensions/pi-irc` · **Related:** `pi-intercom` (same-machine session messaging — pi-irc is the same need on an open protocol, with humans and remote machines in the loop)

## Vision

Every pi session — main agent, sub-agent, or a human with any IRC client — meets on one IRC channel and talks. IRC is the transport because it is a mature, minimal, human-native protocol: a self-hostable server (e.g. ergo) gives projects a private bus; a laptop with irssi gives a human a seat at the table; channels scale from one project to an entire agent fleet. pi-irc implements the client side of RFC 2812 (RFC 1459 compatible) and hides it entirely: connection, registration, nickname handling, channel bootstrap, roster tracking, and message buffering all run in the background. The agent sees one lean tool with intent-level operations.

The extension owns the machinery; the agent owns the conversation.

## Product principles

1. **Background machinery, foreground intents.** Sockets, registration, keepalive, nick collisions, flood limits, numeric replies — never agent concerns. The agent expresses intents (`send`, `read`, `roster`); the extension translates them into protocol.
2. **One lean tool.** A single `irc` tool with a handful of ops (the sibling pattern of pi-intercom-lean's merged tool; ADR-0003). The tool list stays clean; discovery happens via `op: "help"`.
3. **Zero-call orientation.** By the time the agent may speak, it is connected, registered, and joined — and the essential state (identity, channels, unread counts, roster summary) is pre-prepared so the common path needs no probe calls.
4. **Pull before push.** Channel chatter is buffered and read on demand; only direct messages wake an idle agent (ADR-0002). A busy channel must never thrash agent turns.
5. **Inbound is data, not instructions.** IRC content entering agent context is untrusted input (see Security & trust).

## Scope of v1

| Surface | Name | Kind | Trigger |
|---|---|---|---|
| Agent messaging | `irc` (ops: connect, status, roster, send, read, join, part, help) | tool | anytime; `connect` is idempotent (no-op once up) |
| Auto-registration | connect → identify → join project channel | background | `session_start` (or first tool use, lazy) |
| Channel bootstrap | create-on-first-join + topic stamp | background | first agent of a project |
| Roster tracking | NAMES/WHO(X)/JOIN/PART/QUIT/NICK → who's who | background | continuous |
| Message buffering | per-conversation ring buffer + read cursors | background | continuous |
| Wake-on-DM | direct message steers an idle agent | background | inbound PRIVMSG to our nick |
| Human seat | any RFC-compliant IRC client joins the channel | external | none — that's the point |

Not in v1: multi-server federation, message history beyond the buffer, push notifications for channel traffic.

## Configuration

pi-irc owns its configuration file(s), layered and merged (project over global):

- `~/.pi/agent/pi-irc.json` — admin-owned global config: server, defaults
- `<project>/.pi/pi-irc.json` — per-project overrides: slug, extra channels, server switch

```jsonc
{
  "server": {
    "host": "irc.example.net",
    "port": 6697,
    "tls": true,                    // default on; false only for local test servers
    "passwordEnv": "PI_IRC_PASSWORD" // server password resolved from env, never stored
  },
  "auth": {                         // SASL PLAIN — omit for anonymous local servers
    "username": "pi-agent",
    "passwordEnv": "PI_IRC_SASL_PASSWORD" // resolved from env at connect; inline password allowed for tests
  },
  "nick": {
    "template": "pi-{shortId}",     // {shortId} = session short id; config-driven alternatives allowed
    "maxLen": 30                    // lowered automatically for RFC 1459-era 9-char servers
  },
  "channels": {
    "projectTemplate": "#pi-{slug}", // slug = sanitized project dir name
    "defaults": [],                  // extra channels every agent joins (e.g. "#pi-lobby")
    "autoCreate": true,              // implicit via first JOIN; stamps topic on creation
    "topicTemplate": "pi project {slug} — created {date}"
  "capabilities": {
    "request": ["extended-join", "server-time", "away-notify"]  // IRCv3; unknown caps are NAK'd and skipped
  },
  "delivery": {
    "bufferMax": 500,               // ring buffer size per conversation
    "wakeOnDirectMessage": true,    // steer idle agent on DM; channel chatter never wakes
    "wakeAllowNicks": [],           // wake trust: nick globs (e.g. ["carsten", "ops-*"]); empty = anyone (private-server default)
    "chunkLongSends": true          // split >512-byte sends into protocol-legal PRIVMSGs
  }
}
```

Missing global config = extension disabled with one clear log line; wrong config fails loudly with the offending key.

## Identity & presence

- **Nick:** rendered from `nick.template`; unique per session by construction (`{shortId}`). On `ERR_NICKNAMEINUSE` (collision, case-insensitive per RFC 2812 §2.3.1) retry with a numeric suffix. Nick case-folding is handled by the extension, never the agent.
- **Structured metadata:** the `USER` realname carries machine-readable identity — `pi/1 project=<slug> role=<main|sub> session=<shortid>` (parent session id appended for sub-agents). This is what the roster reads back via `WHO`/`WHOIS`/`WHOX` (ADR-0001).
- **Main vs sub-agent:** the session knows its own role from the pi runtime; other agents' roles are learned from their realname metadata. Humans are simply nicks without pi metadata.
- **Presence:** JOIN is the announcement; QUIT/PART/NICK updates flow into the roster continuously.

## Project-channel bootstrap (first agent wins)

1. `session_start` (or first `irc` call): load merged config → establish connection (TLS, `PASS`?, `NICK` + `USER` with metadata).
2. Join `channels.projectTemplate` channels — per RFC 2812 §4.2.1 the first JOIN *creates* the channel implicitly; no explicit creation protocol exists.
3. If the channel was fresh (empty NAMES reply): stamp the topic from `topicTemplate` — the visible marker of ownership and creation time.
4. Join any `channels.defaults`.
5. Prepare roster + buffers; the session is now reachable.

All later agents of the project run the same flow and simply land in the existing channel. Bootstrap is idempotent and race-safe: simultaneous first-agents both JOIN; the server serializes creation; the topic stamp is set-once (skip if a topic exists).

## The `irc` tool (agent surface)

| Op | Returns / does | Prepared by |
|---|---|---|
| `connect` | Ensures connection + registration + joins; idempotent no-op when up | usually already done at session start |
| `status` | My nick & role, project channel, joined channels, connection state, unread counts | background state, zero round-trips |
| `roster` | Project-channel members: agent (project, main/sub, session, model) or human; online vs last-seen | NAMES + WHO(X) + join/part/quit stream |
| `send` | Message a channel (default: project channel) or a nick (DM); chunked, flood-limited | send queue with rate limiting |
| `read` | Unread messages since cursor (from/since/channel filters), advances cursor | ring buffer |
| `join` / `part` | Extra channels on demand; the project channel cannot be parted | channel state |
| `help` | Op reference with current context (nick, channels) | — |

## Background machinery

- **Connection lifecycle:** lazy-or-eager connect, `PING`/`PONG` keepalive on the server's cadence, exponential-backoff reconnect (with re-join of all channels and roster rebuild), clean `QUIT` on session shutdown.
- **Roster maintenance:** NAMES on join, WHO/WHOX for metadata, incremental updates from JOIN/PART/QUIT/NICK; the "who is a main agent, who is a sub-agent, who is human" mapping is maintained continuously and served pre-digested.
- **Buffering:** every inbound PRIVMSG/NOTICE lands in a per-conversation ring buffer with a per-session read cursor; unread counts surface through `status`.
- **Wake-on-DM:** a direct message to our nick steers the idle session once per quiet period (throttled); channel messages never wake.
- **Flood safety:** outbound token bucket so a chatty agent isn't kicked; protocol-legal chunking of long sends.

## Protocol scope (client side)

Implemented per RFC 2812, tolerating RFC 1459-era servers:

- **Registration & session:** `PASS` (opt), `NICK`, `USER`, `PING`/`PONG`, `QUIT`, `ISON` (reconnect checks).
- **Channels:** `JOIN`, `PART`, `TOPIC`, `NAMES`, `WHO` (+ `WHOX` when offered), `LIST` (status only).
- **Messaging:** `PRIVMSG`, `NOTICE`.
- **Numerics handled:** `RPL_WELCOME` (001), `RPL_NAMREPLY` (353/366), `RPL_WHOREPLY`/`WHOX` (352/315, 354), `RPL_TOPIC` (332), `ERR_NICKNAMEINUSE` (433), `ERR_NOSUCHCHANNEL` (403), `ERR_ERRONEUSNICKNAME` (432), `ERR_JOINFAILURE` family, plus fallback behavior on unrecognized codes (log, never crash).
- **Optional IRCv3 caps when the server offers them:** `server-time` (accurate buffer timestamps), `extended-join` (realname on JOIN → instant roster), `multi-prefix`, `away-notify`. No hard dependency — plain RFC 2812 servers are fully supported.
- **Not implemented (non-goals):** server-side commands (oper/kline), DCC, IRC services automation beyond optional P3 SASL.

## Human surface

Humans need nothing installed beyond any IRC client (irssi, HexChat, a web client): join the project channel, see the roster of agents, DM or address them by nick. Agent messages are ordinary IRC traffic. The `/irc` slash command (`/irc`, `/irc read [conv] [n]`, `/irc send <target> <text>`, `/irc help`) lets a human inside pi inspect and post without a round-trip through the model.

## Non-goals

1. **Client only.** No IRC server implementation, no services/oper tooling. Deploying the server (ergo et al.) is the admin's job, documented but not owned.
2. **No persistence beyond the buffer.** Missed messages live in the ring buffer; IRC history services (e.g. ergo's history) are the server's concern.
3. **No bridging.** Matrix/Slack/SMTP gateways are out of scope.
4. **No end-to-end encryption.** Transport security is TLS; content confidentiality is the server's trust domain.
5. **No bot framework.** pi-irc carries conversations; it does not host plugins, commands, or games on the IRC side.
6. **No channel policing.** Agent ops cover join/part/send/read; operator duties (modes, bans) stay with humans and the server config.

## Architecture

```
pi-irc/
  index.ts            # factory: config load, lifecycle wiring, tool registration
  lib/
    config.ts         # load/merge/validate pi-irc.json (global ← project), fail loudly
    wire.ts           # RFC 2812 line codec: parse, format, 512-byte guards, builders
    irc-socket.ts     # TLS/plain TCP transport (node:tls, node:net)
    irc-client.ts     # registration, numeric dispatch, PING/PONG, typed client events
    session.ts        # bootstrap orchestration: joins, topic stamp, WHO roster seed
    identity.ts       # nick rendering, collision retry, realname metadata encode/decode
    channels.ts       # project-channel bootstrap, topic stamp, defaults, join/part state
    roster.ts         # NAMES/WHO(X)/event stream → agent(main|sub)/human mapping
    buffer.ts         # ring buffer, read cursors, unread counts
    delivery.ts       # wake-on-DM steering, send queue, flood limiter, chunking
    tool.ts           # the `irc` tool: op dispatch over prepared session state
  tests/
    mock-irc-server.mjs  # scripted RFC 2812 server: deterministic numerics, collisions
    *.test.mjs           # unit + integration suites (97 tests, plain node:test)
  scripts/
    debug-boot.mjs       # manual bootstrap probe against the mock server

## Security & trust

- TLS on by default; server password only ever resolved from an env var reference; credentials never logged.
- **Inbound IRC content is untrusted data.** Any human or foreign agent can write into the channel; the extension injects it as message data, and the shipped agent guidance states that channel content must not be treated as instructions. Admins scope trust by running a private server and channel modes.
- Nickname metadata discloses project slug and role on the wire — acceptable inside a private server; template is configurable for tighter setups.

## Compatibility & verification

- **Runtime:** pi extension API (jiti, no build step); fully headless-capable (`pi --print`, JSON, RPC, codemode) — lifecycle never depends on UI.
- **Smoke suite:** deterministic mock server covering registration, nick collision retry, first-join channel creation + topic stamp, roster mapping (main/sub/human), buffer cursors, DM wake throttling, reconnect-and-rejoin; plus a live ergo container test.
- **Validation run (P3):** two pi sessions in one project coordinate a small task exclusively through IRC while a human with a stock IRC client joins mid-task and redirects the work. Findings engrave back as pinning checks.

## Roadmap

- **P0 (done)** product definition, glossary, ADRs (docs/decisions/)
- **P1 (done)** core: config, wire/transport/client, session bootstrap, identity, channel bootstrap, roster, buffer, delivery — `irc` tool with all 8 ops; wake-on-DM and the flood limiter shipped here, ahead of plan; 97 tests
- **P2 (done)** robustness: reconnect with backoff + rejoin (107 tests), IRCv3 capabilities — server-time, extended-join, away-notify negotiated via `capabilities.request`; RFC-2812-only servers degrade silently (410 abort); 126 tests
- **P3 (done)** real-server validation against ergo in Docker: `scripts/ergo-smoke.mjs` (10 checks — registration, CAP negotiation, channel auto-create, topic stamp, cross-client delivery, roster, wake, QUIT) and `scripts/ergo-agents.mjs` (10 checks — the two-agents + one-human coordination run). Surfaced and fixed: topic stamping must query TOPIC explicitly (ergo doesn't volunteer 331 on JOIN); topic stamp is best-effort when a human created the channel (creator-only op under mode +t)
- **P4 (done)** hardening + packaging: KICK detection with buffered system line and delayed rejoin (`channels.kickRejoinDelayMs`, default 3 s, 0 stays out; `stop()` cancels); MIT license, npm metadata, `files` allowlist, `npm pack` verified at 33 kB / 20 files; 140 unit+integration tests, typecheck clean, both live ergo runs green (smoke 10 checks, coordination 10 checks). Accidental cross-server validation: against a local InspIRCd (port collision) the stack registered, joined, and delivered with caps silently empty — RFC 2812 degradation works outside ergo. No npm publish yet — the design gets falsified in real projects first.
- **P5 (done)** real-project falsification against InspIRCd 4 (`irc.local`, stock modules plus `cap` + `ircv3_ctctags` + `ircv3_servertime`): both live runs green on the foreign daemon (smoke 10/10, coordination 10/10). Found and fixed in the field: (a) multi-cap `CAP REQ` is all-or-nothing — one unsupported cap bounced the whole set, so a NAK now falls back to per-cap REQs (8d24058); (b) config files are hand-edited — JSONC (comments, trailing commas) is now tolerated with a string-aware stripper (eb8633a); (c) a probe artifact taught the deeper lesson that session-dir attribution follows the startup dir — identity stays on `ctx.cwd` (06251fa). Live headless pi session in a scratch project (`pi --print`, global shim): correct nick/project/channel, roster with both humans, DM wake observed by the model mid-turn. 144 tests green.
- **P6 (done)** coordination parity with local buses (pi-intercom) over IRC DMs. Ask/reply RPC envelopes (`[pi-ask <id> timeout=600]` / `[pi-reply <id>]`, DM-only, lossless multi-part reassembly, late replies degrade to plain DMs) with `irc ask` / `irc reply` / `irc pending` ops — ask blocks up to the timeout, answers surface as system lines. Busy presence: `agent_start` → `AWAY :busy since hh:mm`, `agent_settled` → back; 305/306 confirmations land in the buffer; peers with away-notify see the roster busy flag live. Wake trust: `delivery.wakeAllowNicks` globs gate the DM wake (roster-verified agents always pass; blocked DMs buffer with one system note). Spec kept below. 175 tests green.
- **P7 (done)** SASL PLAIN identity + TLS in anger: `auth {username, passwordEnv|password}` (exactly one secret source enforced at load) auto-adds `sasl` to the capability request; the client holds CAP END, runs `AUTHENTICATE PLAIN` (payload base64, ≤400-char chunks, bare `+` terminator on exact multiples), and releases registration on 903/907 — 904/905/906 and server aborts destroy the transport, and a configured server that won't negotiate sasl (not offered, NAKed in per-cap fallback, or 410) **fails closed** rather than registering anonymously. TLS: `server.tlsInsecure` (self-signed CAs) and `server.tlsServerName` (SNI override). Found in the field (commit 9190942): (a) the first test design leaked CAP END before AUTHENTICATE — the negotiated-finish line must be suppressed while SASL holds it; (b) ergo drops services commands sent mid-MOTD-burst and forbids mixing secure and insecure sessions on one account — the SASL smoke provisions accounts from a TLS probe; (c) the raw-probe waiter pattern in the smoke scripts dropped waiters on the first non-matching line (MOTD bursts starved them) — waiters now stay installed until they match; (d) ergo's login-throttling kicks in across successive smoke runs — disabled in the test fixture. Live: sasl-smoke 8/8 (NickServ-provisioned account, WHOIS 330 identity proof, cross-client delivery, second-session multi-login, wrong-password fail-closed), plus ergo-smoke 10/10 and ergo-agents 10/10 re-run on the new fixture; 187 unit tests, typecheck clean.

### P6 — Ask/Reply RPC, busy presence, wake trust

**Problem.** pi-irc replaces the broadcast/notify half of pi-intercom but not its coordination half: blocking `ask` with threaded `reply`, a `pending` registry, and session presence. Also, wake-on-DM currently trusts anyone on the server.

**RPC envelope** (application text inside normal DMs; channels never interpret it):

```
[pi-ask <id> timeout=600] question text…
[pi-reply <id>] answer text…
```

- `id`: 8-hex random, unique per outbound ask; `timeout` seconds, default 600
- Rules: only DMs are parsed; a `[pi-reply]` with unknown `id` renders as a normal DM (late/foreign reply); replies are never longer than one DM chunk — the sender chunks, the receiver reassembles by `id`
- Malformed envelopes are plain text (never an error on the wire)

**Ask registry** (lib/rpc.ts): outbound asks (`id → {peer, question, sentAt, state: waiting|replied|timeout, reply, promise, timer}`), inbound asks (`id → {peer, question, receivedAt, resolvedAt}`). `ask` tool op blocks on the promise up to the timeout; on timeout the asker gets a timeout result and a system line. The askee sees the ask in `read` as `ASK from <nick> (id=…)` with the reply instruction `irc reply id=<id>`; `irc reply` wraps `[pi-reply <id>]`. `irc pending` lists both directions.

**Busy presence**: `agent_start` → AWAY `busy since <hh:mm>`, `agent_settled` → UNAWAY (away-notify keeps peers' rosters fresh; WHO fallback H/G). Roster output gains a busy column. A busy session still receives asks — they buffer and surface next turn; the asker's timeout absorbs the delay.

**Wake trust** (`wake.allowNicks`, globs, default empty = everyone — private-server default): when set, only matching nicks and roster-verified agents (realname metadata) wake a session; others' DMs buffer silently with one system line. Documented loudly: on shared servers, set the allowlist.

**Non-goals kept**: no attachments payload (paste content in the message), no `handover` (session summarization is a host feature, not a bus feature), no supersedes/cancel (DMs are immutable once sent).


### P7 — SASL PLAIN identity, TLS in anger

**Problem.** Real IRC networks require an authenticated identity: SASL over TLS. pi-irc has so far only proven itself against anonymous local daemons, and a config that promises authentication would today silently fail open.

**Mechanics** (lib/sasl.ts, pure helpers + client orchestration in lib/irc-client.ts):

- `auth: {username, passwordEnv|password}` in config → `sasl` is added to the CAP request automatically; `passwordEnv` resolves at connect time (secrets never stored in the config file; inline `password` allowed for local test servers)
- When capability negotiation would finish and `sasl` is enabled, the client **holds CAP END** and runs `AUTHENTICATE PLAIN`; on the server's `AUTHENTICATE +` it sends `base64(authzid="" \0 username \0 password)` chunked to ≤400 bytes per line (an exact multiple of 400 terminates with a bare `+`)
- Numerics: 900 informational (logged-in-as), **903 success** → CAP END releases registration; 907 (already authenticated) counts as success; **904/905/906 fail registration** with a surfaced error — the agent never appears online half-registered
- **Fail closed**: auth configured but the server won't negotiate `sasl` (not offered, NAKed in fallback, or 410 abort) → registration error, not an anonymous session
- SASL re-runs on every reconnect (negotiation is per-connection); PASS stays available for legacy passworded servers via `server.passwordEnv`

**TLS options**: `server.tlsInsecure` (accept self-signed/internal CAs; default false, loud in docs), `server.tlsServerName` (SNI override behind proxies/port-forwards).

**Validation**: the ergo fixture grows real accounts (`authentication-enabled: true`, open registration for the probe) and a TLS listener on 6697 with a generated self-signed cert. `scripts/sasl-smoke.mjs`: register a probe account via NickServ, connect the agent session with SASL over TLS, assert the 900/WHOIS account identity, project-channel join, cross-client delivery, and that a forced reconnect re-runs the SASL exchange.
## Terms

| Term | Meaning |
|---|---|
| project-channel | The channel rendered from `channels.projectTemplate`; every session of a project auto-joins it; created implicitly by the first JOIN |
| default channels | Extra admin-configured channels joined at startup (e.g. a cross-project lobby) |
| roster | Live mapping of channel nicks to pi agents (with project, main/sub role, session id) or humans |
| buffer cursor | Per-session read position in a conversation's ring buffer; `read` advances it |
| wake-on-DM | Steering an idle session when a direct message arrives; throttled, never triggered by channel chatter |
| identity metadata | Machine-readable realname (`pi/1 project=… role=… session=…`) announcing an agent over `USER` |
