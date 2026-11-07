# ADR 0005 — Park the intercom⇄IRC gateway; ship channel wakes instead

- Status: **Accepted (2026-11-07)**
- Context: P17 follow-up discussion about bridging pi-intercom (same-machine
  bus) and pi-irc (open-protocol gateway) so remote peers and humans reach
  local sessions with intercom-grade UX.

## Decision

1. **No gateway daemon is built now.** The design is parked with full notes
   below and three explicit triggers.
2. **`delivery.wakeOnChannel` (P18) ships instead** — the specialist-bench
   scenario the gateway was partly motivated by turned out to need only
   per-agent channel wakes inside pi-irc core.

## Why the gateway's value decomposed under questioning

The operator's questions falsified the daemon's strongest use case:

- **Human ⇄ agent needs no gateway at all.** Humans and agents are peers on
   IRC; direct DMs both ways + P17 sender-trust wakes already serve this
   path today. A relay would add nothing but a new process.
- **Cross-machine agent asks are already solved** by Option C (P17 `project`
   tier: account-verified same-project agents wake each other via `irc ask`).
- What remained for a relay was: (L0) re-skinning that traffic in intercom UX
   (synthetic peers in `intercom list`) — comfort, not capability; (L1)
   broker-injection of remote-initiated traffic — the one genuinely new
   capability, and precisely the riskiest (steer injection behind six locks).
- **Channel wakes needed neither**: the specialist scenario (N local pi
   sessions with different specialities reacting to human chatter in a shared
   channel) is pure pi-irc core — P17 trust semantics extended from
   DM-context to channel-context, judged per-agent by a cheap classifier.

## Feasibility facts recorded for whoever builds it later

- pi-intercom's broker is a unix socket with a full client protocol
  (`broker.sock`; `IntercomClient`: register / send / list / presence events /
  receipts `receiver_received → injected → acknowledged`) — a foreign process
  can be a full broker peer **today**, no upstream changes.
- pi-intercom already ships SSH-based cross-machine delivery
  (`cross-machine-transport.ts`); an IRC transport would be an alternative,
  not a new concept.
- Trust design settled in discussion: machine-level SASL accounts (one per
  machine, one per human — never per session), origin-dedup (gateway
  synthesizes intercom peers only for foreign-machine agents), `deliverTo`
  as an opt-in list (dispatcher role), provenance headers the gateway itself
  constructs, per-account rate limits, DM-only. Channel traffic never
  becomes a broker steer.

## Triggers to revisit

- **T1** a second machine actually joins the project and wants single-tool UX.
- **T2** a real need for sessions *without* pi-irc to be reachable from IRC.
- **T3** pi-intercom grows a transport seam, making the bridge a small
  upstream contribution instead of our daemon.

Until one fires, the portfolio stands: **intercom for same-machine
orchestration, pi-irc for humans/cross-machine/persistence, wakeOnChannel
for specialists in shared channels.**
