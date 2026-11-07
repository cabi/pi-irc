---
status: accepted
---

# Identity rides in the realname; nicks stay cheap

The roster must answer "which pi agent — project, role, session — or which
human is behind this nick?" without side channels or interactive probing. The
candidates:

- **Encode everything in the nick** (`pi-{project}-{role}-{id}`): dies on
  RFC 1459-era servers that still cap nicks at 9 characters, leaks the project
  name into every tab-completion list, and breaks when a role changes
  mid-session.
- **Query on demand** (CTCP/WHOIS round-trips): turns roster assembly into
  conversation — N agents, N round-trips, and chatter the server may
  rate-limit.
- **A side channel** (registry channel or file drop): a second source of
  truth, a second set of failure modes, more state to bootstrap.
- **The `USER` realname:** a free-form field every RFC 2812 client must send
  anyway, invisible in normal chat UIs, readable after the fact via
  `WHO`/`WHOIS`/`WHOX`.

pi-irc sends identity as a structured realname — `pi/1 project=<slug>
role=<main|sub> session=<shortid>`, the parent session appended for
sub-agents — and keeps the nick a short, collision-tolerant handle rendered
from `nick.template` (`pi-{shortId}` by default, numeric-suffix retry on
`ERR_NICKNAMEINUSE`). Roster assembly for _other_ participants reads realnames
from `WHO`/`WHOX` (and `extended-join`, when the server offers it); a nick
whose realname does not parse as pi metadata is a human participant — the
correct default, because unknowns are people, not mis-parsed agents.

Consequences: works on every RFC 2812 server with zero extra protocol traffic;
the metadata is visible to the server operator (acceptable — the trust domain
is a private server, and the template is configurable for tighter setups); the
`pi/1` version token leaves the format room to evolve without guessing.
