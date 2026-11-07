# pi-irc — agent guidance

IRC as the communication bus for pi agents and humans. **PRODUCT.md is the source of truth** — product definition, protocol decisions, phase roadmap (P1–P19, all shipped), and ADRs in `docs/decisions/`. Read it before designing anything.

## Verify before you claim done

```bash
npm run check             # the full gate: fmt + lint + typecheck + test
npm run fmt               # oxfmt (auto-fixes formatting)
npm run lint              # oxlint --fix (auto-fixes lint; anti-slop rules on)
npx tsc --noEmit          # strict, must be silent
node --test tests/        # full suite (needs the ergo fixture for live tests)
```

- Ergo fixture: `docker run -d --rm --name pi-irc-ergo -v "$PWD/tests/ergo/ergo.yaml:/ergo/ergo.yaml:ro" -v "$PWD/tests/ergo/certs:/ergo/certs:ro" -v pi-irc-ergo-data:/ergo/data -p 127.0.0.1:16667:6667 -p 127.0.0.1:16697:6697 ergochat/ergo:latest`
- Live smokes (operator server): `scripts/*-smoke.mjs` — each prints PASS/FAIL per check; run the matching one for the subsystem you touch.
- Conventional commits only. Implementation and its tests land in the same commit; never commit red.

## Dogfooding IRC (this repo eats its own cooking)

This project's agents live in **#pi-pi-irc** on the `lan` world. Policy: `.pi/pi-irc.jsonc` (project-owned — wake trust tier `project`, channel wakes for #pi-pi-irc). Endpoints/credentials live ONLY in `~/.pi/agent/pi-irc.jsonc` (admin registry) — never add server/auth data to a project file.

When working here with multiple sessions: announce starts in the project channel, `irc read`/`irc mark` to stay current, `irc ask` blocking questions, and report results. Humans reach you by DM; channel chatter only wakes you when it matches this project's capabilities (P18 classifier).

## Layout

- `lib/` — wire (RFC 2812 parsing/format), transport (socket+TLS), caps (IRCv3 negotiation), irc-client (registration, WHOX, CHATHISTORY), config (P19 registry), identity, session (bootstrap, presence, wakes), roster, channels, buffer, delivery (chunking), rpc (ask/reply), reconnect, tool (`irc` op surface), commands (`/irc` slash)
- `tests/` — unit + fake-server integration per module; ergo fixture config
- `scripts/` — live smoke/drill scripts (env: `IRC_HOST/IRC_PORT/IRC_TLS…`)

## Hard-won lessons (do not relearn these)

- IRC lines are byte-limited (512): never concatenate sends without `formatLine`/delivery chunking; CJK doubles/triples bytes.
- Mocks must answer `PING`, `TOPIC`, and `WHO` or boot stalls on waiters.
- `wakeTrust` is default-deny; every new wake path needs a test proving both directions.
- Config is a trust boundary: project files pick worlds by name, never define them.
