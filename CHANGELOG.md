# Changelog

## 0.6.0 - 2026-11-07

Config files say what they are; channel wakes speak human.

- `pi-irc.jsonc` is the canonical config filename — `~/.pi/agent/pi-irc.jsonc` and `<project>/.pi/pi-irc.jsonc`. The legacy `.json` spellings keep working forever (`findConfigFile` prefers `.jsonc` when both exist), so no migration is required
- Wake-classifier guidance, validated live: role framing ("a core developer of this project: I built and maintain…") beats feature lists — a gray-zone question scored 0.07 (missed) with the old text and 0.86 (woken) with the new one, off-topic lines unchanged at ≤0.11. Documented in PRODUCT.md; adopted in this repo's own policy
- Repo verification gate is `npm run check` (oxfmt + oxlint with anti-slop rules + tsc + tests); type assertions eliminated via named guards
- This project now dogfoods its own extension on #pi-pi-irc (wake trust tier `project`, channel wakes, Jev-class classifier)

## 0.5.0 - 2026-11-07

Many projects, many IRC worlds.

- `servers` registry: name → endpoint + optional SASL `auth`, `defaultServer` picks the machine default; project files select a world **by name only** (or `"off"` — the per-project kill switch). Endpoints and credentials can no longer come from a repo
- Legacy top-level `server`/`auth` still parse as an implicit `default` entry with a deprecation warning; mixing `servers` with top-level `server` is rejected loudly
- `wakeOnChannel.confidence` is a float (integer validation rejected the documented default 0.5)
- A classifier that becomes available after session start attaches to the live session instead of staying silent

## 0.4.3 - 2026-11-07

Tiered wake trust and channel wakes.

- `delivery.wakeTrust` tiers: `account` (SASL services accounts, default), `project` (account + recognized agents of this project), `none`
- **P18 `wakeOnChannel`**: per-agent channel wakes — each session judges chatter against its own `capabilities` through a Jev-class "System One" classifier riding pi's model registry (pi-irc owns no keys, no HTTP). Deterministic-first gate order: config scope → own-line skip → sender trust → quiet window → nick mention (no model call) → classifier. Fail-closed
- Tooling: oxlint + oxfmt adopted (tabs, 120 cols, anti-slop rules); type assertions eliminated via named guards

## 0.4.2 - 2026-11-07

Roster lifecycle and cheap status.

- Roster lifecycle hardening: WHO batching, msgid ring dedup, project-scoped addressing selectors
- `status()` is O(conversations) — incremental unread counters instead of per-call scans
- `433` nickname fallback surfaces `desiredNick` so renames are visible

## 0.4.1 - 2026-11-07

P14 review remediation — wire, delivery, and trust hardening. **Two breaking changes**, both security-motivated.

- **Breaking:** config trust boundary enforced — `server` endpoints, `auth`, and admin-owned keys come from the global file only; project files are restricted to project-local keys (`channels`, `capabilities`, `delivery` policy, `nick`, `history`, `slug`)
- **Breaking:** wake trust is default-deny — a sender must be a SASL services account or match the operator's `delivery.wakeAllowNicks` globs
- Wire: `formatLine` rejects CR/LF/NUL; JOIN targets validated; CHATHISTORY bounds hardened
- Delivery: byte-aware chunking (CJK-safe, 512-byte line limit) — unsendable chunks are dropped, never block the queue
- Buffer: per-message delivery marks — filtered reads lose nothing and repeat nothing
- RPC lifecycle: peer-bound replies, bounded assembler state, configurable flood control (`delivery.maxQueue`, `burst`, `intervalMs`)

## 0.4.0 - 2026-11-07

History and addressing.

- IRCv3 chathistory: boot catch-up, `fetch` op, msgid dedup — mid-task joiners see what they missed on supporting servers (ergo)
- Addressing selectors for `send`/`ask`: `@session-id`, role selectors, project-scoped names
- Presence polish: wake quiet window 60s → 5s (follow-up DMs no longer swallowed); real two-session coordination drill in `scripts/`

## 0.3.2 - 2026-11-06

- `server.tlsCaFile` — pin internal CAs for self-hosted TLS networks

## 0.3.1 - 2026-11-06

- Fix: connect-phase socket errors no longer reach unbound error listeners — a server disappearing mid-connect crashed the host instead of the extension (found in production by the operator)

## 0.3.0 - 2026-11-06

SASL and TLS in anger.

- SASL PLAIN authentication interposed between CAP ACK and END; `auth: { username, passwordEnv }` in the global config. **Fail-closed:** `auth` configured but the server will not negotiate `sasl` → refuse to register
- TLS: `tlsInsecure` for self-signed labs, `tlsServerName` for SNI overrides
- Validated live against ergo with real accounts (8/8 falsification checks)

## 0.2.0 - 2026-11-06

Ask/reply RPC and presence.

- `ask`/`reply` over DMs: envelope + correlation registry, lossless part reassembly, timeouts; `ask`/`reply`/`pending` ops on the irc tool
- Busy presence: AWAY signal while a session is working
- Wake-trust allowlist (`delivery.wakeAllowNicks`) — DM wakes honor it

## 0.1.0 - 2026-11-06

First public release.

- RFC 2812 client-side implementation (RFC 1459 compatible) over an injectable transport: registration, PING/PONG, nickname collision handling, message framing
- One lean `irc` tool for agents — 8 intent-level ops (status, roster, read, send, dm, channels, topic, stop); connection, channel bootstrap, roster tracking, and buffering run in the background
- `/irc` slash command for humans in pi
- Layered config (`~/.pi/agent/pi-irc.json` global, `<project>/.pi/pi-irc.json` overrides), JSONC-tolerant, loud validation
- Per-project channels (`#pi-{project}` by template), implicit creation on first JOIN, every session of a project auto-joins
- Roster: channel nicks mapped to pi agents (project, main/sub role, session id) or humans, via WHO + identity metadata in realname
- Wake-on-DM: an idle session is steered when a direct message arrives (throttled, never on channel chatter)
- Flood-limited delivery queue with word-boundary chunking
- Reconnect with exponential backoff and pause/flush semantics; KICK detection with buffered system line and delayed rejoin
- IRCv3 capabilities (server-time, extended-join, away-notify) negotiated per config; RFC-2812-only servers degrade gracefully
- 144 unit/integration tests; validated live against ergo and InspIRCd 4 (smoke + two-agents-one-human coordination runs, 10 checks each)
