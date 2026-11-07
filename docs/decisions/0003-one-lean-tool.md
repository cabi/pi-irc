---
status: accepted
---

# One lean tool; ops are parameters

The agent-facing surface could be a family of tools (`irc_connect`,
`irc_send`, `irc_read`, …) or one tool whose first parameter selects the
operation. pi-intercom-lean wrapped upstream's eight registrations into a
single `intercom` tool for exactly this reason: every tool in the list is
attention the model spends on every call, and a chatty tool list distracts
from the project's real tools. pi-irc has no upstream to wrap, but the
economics are identical — and the ops share state (connection, cursors,
roster) that already lives in the extension, not in the tools.

Decision: register exactly one agent tool, `irc`, with `op` as the leading
parameter (`connect`, `status`, `roster`, `send`, `read`, `join`, `part`,
`help`). Per-op parameter validation happens inside; the registered
description stays short, and `op: "help"` carries the detail, personalized
with live context (nick, channels, unread counts).

Consequences: one line of tool-list cost regardless of how many ops grow;
adding an op never churns the model's tool context; discoverability shifts
from the tool list to `help` plus ambient guidance. The cost is internal
complexity — one execute dispatcher and per-op argument checking — which is
exactly the machinery this extension exists to own.
