# pi-irc — IRC as the communication bus for pi agents and humans

**Status:** v0.4.2 — P1–P16 shipped: RFC 2812 client (reconnect, IRCv3 caps, SASL PLAIN, TLS), session bootstrap, `irc` tool with ask/reply RPC, presence, CHATHISTORY catch-up; three-way reviewed (P14) and every register finding remediated; validated live against ergo and InspIRCd · **Repo:** `~/Projects/pi-extensions/pi-irc` · **Related:** `pi-intercom` (same-machine session messaging — pi-irc is the same need on an open protocol, with humans and remote machines in the loop)

## Division of labor with pi-intercom

Two buses, two planes — pick by participant, not by preference:

- **pi-intercom is the control plane** for same-machine orchestration: supervisor↔worker asks and reports between pi sessions on one host. Faster (host-injected steers), richer presence (model, context, pane), and its wakes always fire. When both sides are pi sessions on this machine, intercom is the default — field-verified: channel-neutral workers pick it 2/2.
- **pi-irc is the gateway** for everyone else: humans with stock IRC clients, agents on other machines, non-pi participants, and the durable, server-side record of the conversation. When a human or a remote machine is in the loop, IRC is the only bus that reaches them.
- Spawn prompts should say which is which: "report to your supervisor via intercom; watch `#pi-<project>` on IRC for human input." The ask/reply envelopes are deliberately congruent across both, so switching planes costs nothing but the tool name.

### v0.3.2 — `server.tlsCaFile`: pin internal CAs, keep verification

Operators running self-signed ergo/InspIRCd instances faced a false choice: `--use-system-ca` launch flags (fragile — depends on how pi is started) or `tlsInsecure: true` (skips verification entirely). `server.tlsCaFile` points at a PEM file (the internal CA or the self-signed leaf itself; `~` expands) that replaces — not supplements — the trust store, keeping full chain **and** hostname verification. Read at connect time; unreadable file fails closed with the path in the error. Mutually exclusive with `tlsInsecure` at config load. Connect-argument assembly is deduplicated (`connectOptsFor` in session.ts:76) — initial connect and every reconnect pass identical TLS options. Validated: unit tests spin a real TLS listener with the fixture self-signed cert (rejected without the CA, verified with it via `serverName` since the fixture cert is a bare CN); live probe against the operator's ergo (`irc.lan:6697`, cert pinned to `~/.pi/agent/certs/irc.lan.pem`, SAN `DNS:irc.lan`) — registered, negotiated caps, joined, clean quit.

### v0.3.1 — field fix: crash on server loss

First real-world bug report: switching the local IRC server under a running pi crashed the host with `Unhandled error. ({ message: 'socket: ' })`. Root cause chain: `IrcSocket.connect()` attached its persistent `on("error")` re-emitter during the connect phase, so a refused connect surfaced both as the connect-promise rejection *and* as a transport `error` event; the client forwarded it (as a plain object, not an `Error`) before `IrcSession` had bound its listener — an unhandled `error` emit, which Node turns into an uncaught exception. Fix (a883017): data/error/close socket wiring moves into `onConnect` — until the connect promise settles, it is the sole error channel; TLS resolves on `secureConnect` only; the client forwards real `Error` instances. Regression test drives the real socket stack against a refused port with no listener bound (the old code kills the test runner). Validated against the operator's own ergo (v2.19.1, plaintext 6667 + TLS 6697): ergo-smoke 10/10, ergo-agents 10/10, presence 8/8, ask-reply 7/7, sasl-smoke 8/8 — 189 unit tests, typecheck clean.

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
    "wakeAllowNicks": [],           // wake trust: nick globs; default-deny — only services-account peers or glob matches wake
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
- **P8 (done)** intercom parity matrix: `scripts/intercom-parity.mjs` — 10 falsifiable checks (send/read parity, ask/reply blocking, late-reply degradation, busy presence via AWAY, wake trust, roster identity, kick/rejoin, chunked sends, reconnect). Failed first (mallory-case wake leak), fixed wake-trust semantics; run 10/10 green. Also: unhandled-socket-error crash fix (a883017) after the operator's server switch crashed pi, WAKE_QUIET_MS 60 s → 5 s (60 s suppressed follow-up DM wakes — an ask+its reply arrived in one turn), connection-reset error normalization.
- **P9 (done)** real-session drill: `scripts/drill-agents.mjs` — scratch project, `pi install -l`, two real `pi -p` agents through the real extension host against the operator's ergo over TLS; blocking cross-process ask, roster polling without hardcoded nicks, stock-client witness. 9/9 green. Found: identical session ids for same-cwd `pi -p` processes → default nick `pi-{role}-{shortId}` (was `pi-{shortId}`). ergo history subsystem mapped: caps offered, `autoreplay-on-join: 0` → nothing replayed on join (P10's opening).
- **P10 (done)** CHATHISTORY catch-up: `draft/chathistory` + `batch` negotiated by default; boot catch-up on project-channel self-join (`history.catchupLimit`, default 50, 0 disables), `history` tool op for any channel/DM peer, replay never wakes, msgid dedup (8 000-entry set). Live two-session validation on the operator's ergo; recorded: unregistered ergo channels drop history when the last member leaves (ChanServ REGISTER once for durability), this ergo build stamps no msgid on replayed lines (dedup best-effort), HistServ notices ride the replay. 198 tests, typecheck clean.
- **P11 (done)** addressing selectors: `send`/`ask` targets resolve via `IrcSession.resolveTarget()` before anything leaves the session — `@<session-id-prefix>` (roster `session` metadata, unique or fail), bare role words `main`/`sub` (sole holder or fail with candidates), raw nicks/channels pass through; self is never a resolution candidate. Found and fixed: `Roster.touch()` silently dropped `session`/`parent` from every patch — session ids were parsed but never stored since P3 (WHO/extended-join realnames parsed fine; nothing read the field until now). 203 unit tests, typecheck clean; live 11/11 ask/reply smoke on the operator's ergo including @-resolution, role selectors, self-exclusion.
- **P12 (done)** release v0.4.0, git-only: full battery on the operator's ergo (unit 203/203, ergo-smoke 10/10, ergo-agents 10/10, presence 8/8, ask/reply 11/11 — the two legacy fixture scripts need `IRC_PORT=6667` against the operator's server). Operator decision: npm publish stays deferred; the tag is the release. Install: `pi install git:github.com/cabi/pi-irc@v0.4.0`.
- **P15 (done)** review remediation — every P0/P1 finding from the P14 register fixed, each falsified against a live server before landing:
  - **a config trust boundary (a2cafa3):** `server`/`auth`/`nick`/`delivery` are global-file-only; a project `.pi/pi-irc.json` setting them is ignored with a warning. Verified live: project-file redirect to an attacker host never connects.
  - **b wake trust (f311cdd):** default-deny — a DM wakes only from a services account (extended-join `account`, SASL-backed; WHOX `%uhnafr` refresh, `0`/`*` = logged out) or a `delivery.wakeAllowNicks` glob. Forged `pi-agent` realnames buffer with one untrusted system line, never wake. Old semantics tests rewritten as contract docs.
  - **c wire hardening (7a26e82):** `formatLine` rejects CR/LF/NUL in every outbound parameter; `join` validates channel names; `CHATHISTORY` routes through `formatLine` with a 1–1000 clamp.
  - **d rpc lifecycle + e flood control (4c03b3b):** replies peer-bound (a foreign `[pi-reply]` with a known id is plain text, never the answer); `dispose()` settles waiting asks as `disposed` (no more hangs past session stop); registries capped (256/24 h, waiting asks exempt) and the reply assembler keyed sender+id with TTL+maxPending — the measured 1.16 GiB/day fragment flood is gone. Flood limiter configurable (`delivery.burst` 8, `intervalMs` 1000, `maxQueue` 512 chunks; global-only) and the queue throws instead of growing unbounded.
  - **f byte-aware chunking (750ce42):** chunks and the wire limit count UTF-8 bytes — CJK/emoji long sends no longer truncate or drop.
  - **g read-cursor skip (67cc1ca):** filtered `read(from|since)` advances the cursor only past messages actually delivered.
  Battery at close: unit 221/221 + tsc clean; live on the operator's ergo: presence 8/8, ask-reply 11/11, ergo-smoke 10/10, ergo-agents 10/10; sasl-smoke 8/8 on the ergo fixture. Released as v0.4.1 (git-only).
- **P14 (done)** three-way independent review at bf6525b — clean (hy4, 14 findings), performance (hy4, 9 findings, all benchmark-measured), security (grok-4.7 after 2× hy4 upstream 502s, 9 findings, 8 exploit-confirmed by reproduction). Parent verified 9 load-bearing claims by direct code read — 9/9 held. Register (ranked):
  - **P0-a config trust boundary (sec-CRIT, exploit-confirmed):** `lib/config.ts:288` merge loop covers only `server|nick|channels|capabilities|delivery|history` — `auth` is NEVER merged, so every file-based config silently loses SASL (functional break; only direct-injection smokes ever tested it). Worse, a project `.pi/pi-irc.json` shallow-overrides `server` (host/port/tls/tlsInsecure/passwordEnv) and session_start auto-connects — an untrusted repo redirects `PASS process.env[attacker_var]` to an attacker host. Fix: server identity + auth from the GLOBAL file only; project file restricted to project-local keys.
  - **P0-b wake trust (sec-CRIT, exploit-confirmed):** `wakeAllowNicks: []` default + `#maybeWake` consulting the allowlist only when non-empty = ANY client DMs → `sendUserMessage(deliverAs:"steer")` remote prompt injection; `#wakeTrusted` accepts self-declared `pi-agent` realname (forgeable; extended-join `account` is parsed then discarded). Fix: default-deny (allowlist + SASL-account-verified agents), deliver untrusted text quoted.
  - **P0-c wire hardening (clean/sec, confirmed):** `formatLine` rejects neither CR/LF/NUL; `join` skips `validChannelName`; CHATHISTORY interpolates target+limit raw → outbound command injection from tool params. Fix in formatLine + route CHATHISTORY through it.
  - **P1-d rpc lifecycle (all 3 reviewers):** replies not bound to asked peer (`resolveReply` has no sender), waiters never settle on `dispose()` (ask hangs after stop), `#outbound/#inbound/#parts` unbounded (measured 1.16 GiB/day under fragment flood). Fix: peer-bound replies, settle-on-dispose, caps+TTL, assembler keyed sender+id.
  - **P1-e flood limiter (perf, measured):** hardcoded burst 4/intervalMs 2000 with lastSendAt-reset = sustained 1 msg/2s (30/min); 20-msg reply takes 32s, 50 msgs 92s, no config keys. Fix: true token bucket + config `delivery.burst`/`intervalMs`, queue bound.
  - **P1-f UTF-16 chunking (clean):** `maxChunk: 400` counts UTF-16 units, `formatLine` checks `.length` not bytes, `maxPrivmsgBytes` unused in production → CJK/emoji messages truncated/dropped by the 512-byte wire limit. Fix: byte-aware chunking via maxPrivmsgBytes + multibyte test.
  - **P1-g read-cursor skip (sec, confirmed):** filtered `read(from|since)` advances the cursor to the highest returned seq, permanently skipping non-matching unread messages below it. Fix: advance only past messages actually delivered.
  - **P2 queue:** identity anchoring on SASL account + 433 reclaim + project filter on role/session selectors (sec-HIGH); roster `expire()` never called in production + PART no forget + msgid `.clear()` at 8k → FIFO (perf); O(total-buffer) unread scans (perf); WHO-per-JOIN unthrottled (perf-HIGH/sec-LOW — cold when extended-join negotiated); docs/test drift (clean: PRODUCT/README vs v0.4.0 reality, nested tool.test.mjs subtests, `{short}` vs `{shortId}`, help boots a session); hot-path polish mostly NOT the bottleneck (measured 214k msgs/s inbound end-to-end).
- **P16 (done)** P14 register P2 queue, closed out:
  - **roster lifecycle (4c2e439):** PART forgets a peer only when they left every shared channel (`channels.memberAnywhere`); QUIT stays the hard signal; `roster.expire()` finally wired (hourly sweep, 24 h TTL, unref'd) as the ghost safety net; role/`@session` selectors are project-scoped — foreign agents on a shared server are addressed by raw nick only; foreign-join WHO lookups batch into one 500 ms flush (deduped per nick) so RFC 2812 servers no longer eat WHO-per-JOIN floods; msgid dedup ring-evicts the oldest entry at 8 000 instead of wiping the set.
  - **unread counters (fbe24fc):** `status()` is O(conversations) — per-conversation pending counts maintained on push/read/mark instead of scanning every buffered message; a 4 000-step fuzz asserts the counter never drifts from brute force.
  - **desiredNick (56c1c13):** a 433-fallback rename is now visible — `status()` carries `desiredNick` whenever the active nick carries a fallback suffix; identity stays anchored on realname `session=` metadata and the SASL account (the 433 retry pool itself existed since P1).
  - Docs drift: README verified current for v0.4.1 keys (flood control, wake default-deny, `tlsCaFile`); misleading `{short}` templates in tests renamed to `{shortId}`; the tool.test.mjs nesting/help complaints were stale — the file is flat and fake-backed.
  - Battery at close: unit 227/227 + tsc clean.
- **P17 (done)** tiered wake trust, spec in the P17 section below: `delivery.wakeTrust` = `account` (default; P15-b semantics) | `project` (account + agent metadata + our project + project-channel membership) | `none` (allowlist only); allowlist globs apply at every tier; `status()` reports the tier; buffered-DM system lines name the tier that blocked them. Live drill on the operator's ergo: `scripts/wake-tier-smoke.mjs` 8/8 (same-project wake, foreign-project/anonymous/stranger buffered with tier-named system lines, allowlist escape hatch at both strict tiers). The drill surfaced a pre-existing NaN pacer: `DeliveryQueue` typed `Required<DeliveryOptions>` but accepted partial opts — raw configs (smokes, embedders) produced a 1 ms busy timer; the constructor now merges defaults per field (231/231 + tsc clean).
- **Field note (2026-11-07, worker comms-preference experiment):** two channel-neutral worker subagents (same cwd, both auto-connected to `#pi-pi-irc` with busy presence and a live 433 suffix on the second) were told to ask their supervisor one question and report back, mechanism unspecified. Both picked `intercom` for ask *and* report, first try; neither sent a single IRC message despite being registered. Takeaways: on one machine the purpose-built bus wins on friction and wake reliability (8 ms delivery vs IRC's default-deny wake trust); pi-irc's agent⇄agent lane is the cross-machine / human-inclusive case. If in-project IRC should compete: project-peer wake trust (account-verified agents in the project channel auto-allowlisted) and supervisor-nick hints in spawn prompts. Also surfaced: subagent sessions register as role `main` (role detection can't distinguish child sessions), and a stale v0.4.1 status line — fixed in this commit.
- **Two-plane drill (2026-11-07, follow-up):** with the division stated up front, a worker ran both planes correctly in one task — supervisor coordination entirely on intercom (ask for parameters, send final report), a simulated stock-client human (`hank`, raw RFC 2812, anonymous, no agent metadata → classified human) delivering a mid-task redirection over IRC in a rendezvous channel, and the deliverable posted back to the channel for human/remote readers. Verified end-to-end in 1 m 59 s. Side finding: the ephemeral rendezvous channel vanished with its history when the last member left (unregistered ergo channel) — durable gateways need the one-time ChanServ REGISTER.

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
**Shipped** as v0.3.0; `server.tlsCaFile` (v0.3.2) pins internal CAs.

### P8 — Intercom parity: validated matrix, saner wake throttle

**Problem.** The P6 features (ask/reply, busy presence, wake trust) shipped with mock/live smokes, but never as one coherent run against the operator's production server over TLS — and the wake throttle made the product worse than pi-intercom for follow-up DMs: a 60s quiet window meant a second message after a settled turn never woke an idle peer (buffered forever, read by nobody).

**Mechanics**:
- `scripts/intercom-parity.mjs`: 13-check end-to-end matrix against a configurable target (defaults to the operator's ergo at `irc.lan:6697`, TLS + pinned CA; `IRC_HOST/IRC_PORT/IRC_TLS/IRC_CA_FILE/CHANNEL_SUFFIX` re-target it). Covers roster discovery with roles, busy presence round-trip (AWAY/away-notify), ask → pending list + wake → reply → unblock, pending drains on both sides, wake trust three ways (roster-verified agent DM, allowlisted human via `hank*` glob, stranger buffered without wake), ask timeout on the asker, late-reply degradation to a plain DM, and a stock IRC human witnessing agent traffic on the same TLS wire.
- `lib/session.ts`: `WAKE_QUIET_MS` 60_000 → 5_000. Bursts still dampen; distinct turns wake.

**Validation**: 13/13 against the operator's live ergo; 191/191 unit tests.

### P9 — Real-session drill: extension host in the loop, ergo history

**Problem.** Every validation so far drove `lib/session.ts` directly (smokes) or the entry against a mock (`tests/entry.test.mjs`). Nothing proved the *whole* product: a real pi process, real extension host, real tool surface, real config merge — against the operator's ergo over TLS. And ergo's history subsystem was never reconciled with pi-irc's delivery model.

**Mechanics** (`scripts/drill-agents.mjs`):
- Scratch project `/tmp/pi-irc-drill-<ts>` + project-local `pi install -l` (user's global settings untouched) + `.pi/pi-irc.json` channel override. Global config (`irc.lan:6697`, TLS, pinned CA) still applies — the real merge path.
- Two `pi -p` agents choreographed without hardcoded nicks (shortId is pi's session id): main roster-polls until a `pi-sub-*` appears, then a **blocking ask across processes**; sub pending-polls, replies, announces. A PONG-aware stock TLS observer witnesses the channel transcript. 9 checks, all green.

**Findings fixed**:
- pi hands **identical session ids** to same-cwd `pi -p` processes (ergo log: `session=01a1b313` for both). Default nick `pi-{shortId}` collided → ergo rename `pi-01a1b313-1`, no role in the addressing surface. Default template is now `pi-{role}-{shortId}` (config.ts DEFAULTS), matching what PRODUCT.md and the sample global config always claimed.

**ergo history status** (operator's `ergo-data/ircd.yaml`): storage on (`channel-length: 2048`, `client-length: 256`), `chathistory-maxmessages: 1000`, caps offered: `draft/chathistory`, `draft/event-playback`, `draft/read-marker`. **But `autoreplay-on-join: 0`** — joiners get nothing replayed automatically. pi-irc today buffers only what arrives while connected; explicit `CHATHISTORY` catch-up (channels *and* DMs) is the open P10 candidate.

**Validation**: drill 9/9 against the operator's ergo; 191/191 unit tests.

**Remaining gaps to pi-intercom**: addressing is by nick (rendered from `{role}/{shortId}`), not by session name/UUID; no `pending`-equivalent cross-session ask registry persisted across restarts (asks time out, late replies degrade gracefully); message history beyond `bufferMax` is lost on the client side (server-side CHATHISTORY catch-up would close this).
### P10 — CHATHISTORY: catch-up on join, fetch on demand, dedup

**Problem.** ergo has `autoreplay-on-join: 0` (P9): a joining agent sees nothing of what happened before, and pi-irc's buffer dies with the process. Restarted or late agents were blind; the P9 gap list named server-side catch-up as the closer.

**Mechanics**:
- Client: `draft/chathistory` + `batch` negotiated by default; `IrcClient.chathistory()` sends `CHATHISTORY LATEST <target> * <limit>` and collects the server's `BATCH`-wrapped replay (batch-scoped, 10 s cap — servers without proper batching can never hang a boot).
- Session: project-channel self-join fires a best-effort catch-up (serialized, fire-and-forget); `irc op:"history" target:…` fetches any channel or DM peer and drains it as a read; replayed lines buffer like live ones but **never wake**; msgid dedup (8 000-entry set) kills replay/live overlap.
- Config: `history.catchupLimit` (default 50, `0` disables).

**Live validation** (operator's ergo, plaintext 6667): B joins before A parts → channel never empties → A₂ boot catch-up replayed 6 lines including A's message. Raw probes confirmed the negotiation trap: a CAP REQ containing a cap the server doesn't offer (`msgid` — a tag, not a cap) earns a **whole-list NAK**; the caps negotiator's per-cap split (P5) already survives this.

**Findings recorded, not engineered around**:
- ergo deletes an **unregistered** channel (with its history) when the last member leaves — durable project history needs a one-time `/msg ChanServ REGISTER #pi-<project>` (first joiner is founder). Documented in README.
- This ergo build stamps **no msgid on replayed lines** → an explicit `history` fetch right after boot catch-up can repeat lines; dedup is best-effort by design.
- HistServ synthetic join/quit/topic notices ride the replay — informative, not filtered (server-specific).

**Validation**: 198/198 unit tests; live two-session catch-up green; `tsc --noEmit` clean.

### P17 — Tiered wake trust (done)

**Problem.** P15-b made DM wakes default-deny (`delivery.wakeAllowNicks`, empty by default) — the right call against impersonation, but it broke the symmetric case: a *verified peer agent in the same project channel* cannot wake an idle supervisor over IRC. The worker experiments showed the consequence: same-machine traffic migrates entirely to intercom (correct!), but the cross-machine agent⇄agent ask — pi-irc's own lane — dies quietly unless the operator hand-allowlists every child nick, which is unworkable (nicks churn via 433 suffixes, subagents spawn dynamically).

**Trust tier: `delivery.wakeTrust`** (new config key, additive with `wakeAllowNicks`):

- `"account"` (default, P15-b behavior unchanged): any services-account holder wakes.
- `"none"`: nobody wakes the session but explicit `wakeAllowNicks` entries.
- `"project"`: a DM sender qualifies for wake when ALL hold:
  1. **SASL-verified account** — extended-join (`JOIN` with account parameter, not `*`) proves the peer authenticated to the server; the server admin's registration policy becomes the root of trust;
  2. **agent metadata** — realname carries the `pi/1 …` fields and `role` is an agent role (humans never wake);
  3. **same project** — realname `project=` equals the local session's project (project-scoped selectors' P16 rule);
  4. the peer is currently a member of our project channel (roster-backed, not just claimed metadata).
- Account knowledge alone is insufficient at `project`; metadata alone is insufficient at every tier (P15-b: realname is self-declared). `project` is the AND of server-verified identity and project co-membership — for operators who do not trust the server's registration policy to vet every account holder.

**Mechanics**:
- Roster keeps the extended-join account per peer (already parsed); `#maybeWake` consults the tier before the quiet-window throttle (WAKE_QUIET_MS still applies — a flood from a trusted peer still cannot spin the session).
- Waking messages stay DM-only; channel traffic never wakes regardless of trust (unchanged).
- `status()` reports `wakeTrust` so an agent can tell which plane will actually reach an idle peer.
- Docs: README gets the operator guidance — `wakeTrust: "project"` presumes you trust the IRC server's registration policy (open-registration servers: don't).

**Also in P17 (small)**:
- Spawn-prompt convention (docs): supervisors tell children the supervisor nick and project channel up front — kills the discovery step the workers had to burn.
- Open question, parked: subagent sessions register as role `main` (no host env var distinguishes child sessions today). If the host grows one, `nick` templates gain `{role:"sub"}` for free; no workaround to build.

**Validation plan**: unit tests against the fake server for each tier condition failing independently (anonymous account, human realname, foreign project, non-member, wakeTrust none); live drill on the operator's ergo — session A idle, session B (SASL-registered, same project) sends an ask over IRC DM, A wakes and replies, all inside the RPC timeout; negative control: anonymous nick's DM does not wake.

## Terms

| Term | Meaning |
|---|---|
| project-channel | The channel rendered from `channels.projectTemplate`; every session of a project auto-joins it; created implicitly by the first JOIN |
| default channels | Extra admin-configured channels joined at startup (e.g. a cross-project lobby) |
| roster | Live mapping of channel nicks to pi agents (with project, main/sub role, session id) or humans |
| buffer cursor | Per-session read position in a conversation's ring buffer; `read` advances it |
| wake-on-DM | Steering an idle session when a direct message arrives; throttled, never triggered by channel chatter |
| identity metadata | Machine-readable realname (`pi/1 project=… role=… session=…`) announcing an agent over `USER` |
