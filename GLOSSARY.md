# Language

One canonical term per concept for pi-irc. The _Avoid_ list marks the graves of
the synonyms we rejected — use the term, not its ghosts. Terms here are language
only, never implementation detail: if a definition starts describing code, it
belongs in an ADR or the module docs instead.

IRC brings its own vocabulary; where pi-irc borrows a wire word (channel, DM,
numerics) it keeps the IRC meaning unchanged, and the graves hold the looser
everyday synonyms (chat-room, room, push).

**channel** — an IRC conversation room addressed as `#name`; the only grouping
unit on the wire. _Avoid_: chat-room, room, chat.

**project-channel** — the channel rendered from `channels.projectTemplate`,
one per project; every session of the project auto-joins it, and the first
JOIN implicitly creates it. A session's home ground. _Avoid_: project room,
default room.

**default channels** — extra admin-configured channels joined at bootstrap
besides the project-channel (e.g. a cross-project lobby). _Avoid_: preset
rooms, default rooms.

**bootstrap** — the background flow every session runs once: connect,
connection registration, project-channel join (creating it if first), join
defaults, prepare roster and buffers. The agent never performs it nor sees it
as steps. _Avoid_: setup, onboarding, registration (reserved for connection
registration).

**connection registration** — the RFC 2812 `NICK`/`USER` handshake (plus
optional `PASS`) that opens a server session. Protocol term; never used for
joining channels. _Avoid_: sign-in, login.

**agent nick** — the IRC nickname a session renders from `nick.template`
(`pi-{shortId}` by default); unique per session by construction,
collision-retried with a numeric suffix. _Avoid_: username (a different wire
field).

**identity metadata** — the machine-readable realname sent with `USER` —
`pi/1 project=<slug> role=<main|sub> session=<shortid>` — announcing an agent
on the wire (ADR-0001). _Avoid_: presence payload, agent card.

**main agent** — a pi session driving a project directly. **sub-agent** — a
session spawned by another pi session; names its parent in identity metadata.
Own role comes from the runtime; everyone else's from their metadata.
_Avoid_: bot, worker, child.

**human participant** — a nick on the channel without parseable identity
metadata: anyone with an IRC client. A first-class conversation member, never
a second-class one. _Avoid_: user (that's the wire field), operator (that's
channel modes).

**roster** — the live answer to "who is here": channel nicks mapped to agents
(project, role, session) or human participants, kept current from `NAMES`,
`WHO`(`X`), and the join/part/quit/nick stream. _Avoid_: member list,
presence list.

**DM** — a direct message: `PRIVMSG` addressed to one nick, not a channel.
The only inbound that may wake an idle session (ADR-0002). _Avoid_: query
(IRC's own word — pi-irc says DM everywhere), private message, whisper.

**buffer** — the per-conversation ring buffer holding every inbound message
until read; sized by `delivery.bufferMax`. **buffer cursor** — the
per-session read position in one conversation; `read` returns everything past
it and advances it. _Avoid_: inbox, backlog (history beyond the buffer is the
server's concern, not ours).

**wake-on-DM** — steering an idle session with its unread DMs, throttled to
once per quiet period; channel chatter never wakes anyone (ADR-0002).
_Avoid_: push, notification.

**steer** — pi's runtime word for a message injected into an idle session to
start a new turn; the mechanism behind wake-on-DM. Borrowed unchanged.

**topic stamp** — the topic written once by the creating agent, marking the
project-channel with its project slug and creation date; set-once, never
overwritten. _Avoid_: channel description.

**numerics** — the three-digit server replies (`RPL_*`, `ERR_*`) defined by
RFC 2812; handled in the background and surfaced to the agent only when they
change an answer.

**extension** — a TypeScript module running inside the pi process that
registers commands, tools, and event handlers; pi-irc is one. _Avoid_:
plugin, add-on.

**agent tool** — a model-callable operation with typed parameters; pi-irc
registers exactly one, `irc`, whose ops are parameters (ADR-0003). _Avoid_:
API, endpoint.
