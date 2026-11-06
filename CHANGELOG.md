# Changelog

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
