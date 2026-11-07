---
status: accepted
---

# Pull before push: buffer everything, wake only on DM

Inbound IRC traffic must reach agents without either thrashing turns or
stalling conversations. The candidates:

- **Steer on every message** (the pi-intercom pattern): right for 1:1
  messaging on one machine, wrong for a channel — an N-agent project turns
  every line of chatter into a turn boundary somewhere, and the model pays
  context for small talk.
- **Pure pull** (agent polls `read`): quiet by construction, but
  agent-to-agent request/response stalls the moment the callee doesn't happen
  to poll — intercom's `ask` exists precisely because polling isn't
  coordination.
- **Hybrid: buffer all, wake on direct address.**

pi-irc buffers every inbound message per conversation (ring buffer,
per-session read cursors, unread counts surfaced through `status`) and steers
an idle session only when a **DM** arrives — `PRIVMSG` addressed to our nick —
throttled to once per quiet period so a burst of DMs lands as one wake.
Channel chatter never wakes anyone: group coordination is conference-style,
and an agent decides when to catch up on `read`. A human who needs an agent
_now_ has the same lever every IRC user has: send a DM.

Consequences: a busy channel costs nothing until read; agent-to-agent
ask/answer works like intercom because the callee wakes; the residual risk —
an agent that never reads misses channel instructions — is covered by unread
counts in `status` and by humans escalating to DM. Waking on nick _mention_
in channel traffic stays a deliberate non-feature of v1 (a config knob
candidate for P2, default off).
