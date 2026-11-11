---
status: accepted
---

# Outbound sends are normalized to wire-legal lines at enqueue

Agent-authored text is prose, not protocol: models hand `irc send` text with
embedded CR/LF line breaks, stray NULs from encoding accidents, and trailing
whitespace. On the wire each PRIVMSG is one line — CR and LF are the frame
delimiters of the protocol itself (RFC 2812 §2.3.1), and `formatLine`
correctly rejects any text containing them. Before P21 the raw string went
straight into chunking, so a multi-line send produced one chunk whose first
`formatLine` call threw a WireError at drain time — after `send` had already
reported success to the agent. The agent saw "sent"; nothing ever left.

Decision: `DeliveryQueue.enqueue` owns outbound normalization for every
target (channels and DMs alike):

- **Line splitting** — CR/LF/CRLF break one send into one PRIVMSG per
  content line; leading whitespace (indentation) survives, trailing
  whitespace dies, blank lines are dropped, NULs are stripped (always an
  encoding accident, never content). Input that normalizes to nothing
  throws at enqueue — loud, before any success is reported.
- **Channel line cap** — channel sends cap at 10 content lines
  (`DEFAULT_CHANNEL_LINE_CAP`, overridable via `channelLineCap`, 0
  disables); the channel receives a final `(… N more lines truncated)`
  marker and the sender's tool result reports `N of M lines truncated`.
  A product cap against pasted-log noise in shared rooms, not a server
  rule. DM targets are uncapped — one receiver, no shared noise.
- **Envelope flattening** — `[pi-ask]`/`[pi-reply]` bodies are line-framed
  protocol (one DM = one envelope), so multi-line bodies flatten to
  single-spaced prose before chunking; chunk boundaries never end on a
  space (delivery's per-line trailing trim would eat it and corrupt
  lossless reassembly — boundary spaces move to the next chunk's head).
- **Drop visibility** — a chunk rejected as permanently unsendable at
  drain (WireError) buffers a `system` entry in the target conversation
  besides the log: the sender's only honest chance to notice and retry,
  since `send` answered before the queue drained.

Consequences: `send` never reports success for text the wire cannot carry;
failure is either at enqueue (empty after normalization, queue full) or
visible in the buffer. Truncation is never silent on either end. Chunked
replies remain byte-exact. The cost: trailing tabs and blank lines an agent
considered meaningful are gone — accepted, because IRC has no way to carry
them, and honesty about what was sent beats pretending the noise arrived.
