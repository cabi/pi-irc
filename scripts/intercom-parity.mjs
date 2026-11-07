/**
 * pi-intercom parity matrix: one end-to-end run that exercises everything
 * pi-irc adds over plain IRC chat — ask/reply RPC, pending lists, busy
 * presence, DM wake trust — against a configurable target. Defaults to the
 * operator's live ergo over TLS with the pinned cert:
 *
 *   node scripts/intercom-parity.mjs
 *   IRC_HOST=127.0.0.1 IRC_PORT=16667 IRC_TLS=0 node scripts/intercom-parity.mjs
 *
 * Env: IRC_HOST (irc.lan), IRC_PORT (6697), IRC_TLS (1), IRC_CA_FILE
 * (~/.pi/agent/certs/irc.lan.pem), CHANNEL_SUFFIX (timestamp — isolates
 * concurrent runs on a shared server).
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const HOST = process.env.IRC_HOST ?? "irc.lan";
const PORT = Number(process.env.IRC_PORT ?? 6697);
const USE_TLS = (process.env.IRC_TLS ?? "1") !== "0";
const CA_FILE = (process.env.IRC_CA_FILE ?? "~/.pi/agent/certs/irc.lan.pem").replace(
	/^~/,
	homedir(),
);
const SUFFIX = process.env.CHANNEL_SUFFIX ?? `${Date.now() % 100000}`;
const CHANNEL = `#pi-parity-${SUFFIX}`;

const baseConfig = {
	server: {
		host: HOST,
		port: PORT,
		tls: USE_TLS,
		...(USE_TLS ? { tlsCaFile: CA_FILE } : {}),
	},
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: { projectTemplate: CHANNEL, defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}" },
	capabilities: { request: ["server-time", "extended-join", "away-notify"] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
	projectSlug: "parity",
};

/** Stock IRC human over the same transport the agents use (TLS + pinned CA). */
function humanClient(nick) {
	const sock = USE_TLS
		? tls.connect({ host: HOST, port: PORT, ca: [readFileSync(CA_FILE)], rejectUnauthorized: true })
		: net.connect({ host: HOST, port: PORT });
	const lines = [];
	let buf = "";
	sock.setEncoding("utf8");
	sock.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			lines.push(buf.slice(0, i));
			buf = buf.slice(i + 2);
			if (/^:[^ ]+ 001 /.test(lines.at(-1))) sock.emit("welcome");
		}
	});
	const send = (line) => sock.write(`${line}\r\n`);
	send(`NICK ${nick}`);
	send(`USER human 0 * :Human Test`);
	return { sock, lines, send, welcome: () => new Promise((r) => sock.on("welcome", r)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name) => {
	pass++;
	console.log(`  ok ${pass} — ${name}`);
};

// --- boot -------------------------------------------------------------------

// Wake trust is default-deny: the agents register throwaway services
// accounts and attach over SASL, so their cross-wakes are earned by a real
// account (the one IRC identity that costs a password). hank stays a plain
// human who must match a glob; mallory neither has an account nor a glob.
const AGENT_ACCTS = {
	main: { username: `paritym-${SUFFIX}`, password: `pw-m-${SUFFIX}` },
	sub: { username: `paritys-${SUFFIX}`, password: `pw-s-${SUFFIX}` },
};
async function registerAccount({ username, password }) {
	// ergo's NickServ registers the account under the connecting nick —
	// the probe nick MUST be the account name the agent will SASL with.
	const c = humanClient(username);
	await Promise.race([
		c.welcome(),
		sleep(8000).then(() => {
			throw new Error(`registration probe for ${username} got no 001 (throttled?)`);
		}),
	]);
	c.send(`NS REGISTER ${password}`);
	const deadline = Date.now() + 10000;
	while (!c.lines.some((l) => /NickServ.*NOTICE.*(egistered|ccount created|lready)/.test(l))) {
		if (Date.now() > deadline) throw new Error(`NickServ registration timeout for ${username}`);
		await sleep(150);
	}
	c.send("NS LOGOUT");
	await sleep(300);
	c.send("QUIT :bye");
	await sleep(200);
}
await registerAccount(AGENT_ACCTS.main);
await registerAccount(AGENT_ACCTS.sub);

console.log(`target: ${USE_TLS ? "tls" : "plain"}://${HOST}:${PORT}${USE_TLS ? ` (ca ${CA_FILE})` : ""}`);
console.log("booting main + sub agent (SASL accounts registered)…");
const main = await IrcSession.connect(
	{ ...baseConfig, auth: { username: AGENT_ACCTS.main.username, password: AGENT_ACCTS.main.password } },
	{ project: "parity", role: "main", shortId: "m1a2b3c4" },
);
const sub = await IrcSession.connect(
	{
		...baseConfig,
		auth: { username: AGENT_ACCTS.sub.username, password: AGENT_ACCTS.sub.password },
		delivery: { ...baseConfig.delivery, wakeAllowNicks: ["hank*"] },
	},
	{ project: "parity", role: "sub", shortId: "s5d6e7f8" },
);
// ergo's nick reservation renames SASL sessions onto their account nick,
// so trust the session's actual nick, never a constructed one.
const MAIN_NICK = main.status().nick;
const SUB_NICK = sub.status().nick;
console.log(`nicks: main=${MAIN_NICK} sub=${SUB_NICK}`);
await sleep(400);

const rosterOf = (s, nick) => s.rosterView().find((p) => p.nick === nick);
assert.ok(rosterOf(main, SUB_NICK)?.role === "sub", JSON.stringify(main.rosterView()));
assert.ok(rosterOf(sub, MAIN_NICK)?.role === "main");
ok("agents discovered each other with roles (roster via extended-join + WHO)");

// --- busy presence ----------------------------------------------------------

sub.setBusy(true); // pi "agent_start" equivalent
await sleep(600);
assert.equal(rosterOf(main, SUB_NICK)?.away, true, JSON.stringify(rosterOf(main, SUB_NICK)));
ok("sub busy → main's roster shows away (away-notify live)");

sub.setBusy(false); // pi "agent_settled" equivalent
await sleep(600);
assert.ok(!rosterOf(main, SUB_NICK)?.away);
ok("sub settled → roster back");

// --- ask / reply RPC --------------------------------------------------------

const wakes = [];
sub.on("wake", (w) => wakes.push(w));
const askP = main.ask(SUB_NICK, "what is the parity check number?", 15);
await sleep(600);
const inbound = sub.rpc.pendingInbound();
assert.equal(inbound.length, 1, JSON.stringify(inbound));
assert.match(inbound[0].question, /parity check number/);
ok(`ask reached sub's pending list (id=${inbound[0].id}) and woke it (wakes=${wakes.length})`);

const r = sub.reply(inbound[0].id, "forty-two, obviously");
const answer = await askP;
assert.equal(answer.status, "replied");
assert.equal(answer.reply, "forty-two, obviously");
assert.equal(r.to, MAIN_NICK);
ok(`ask/reply round-trip: main unblocked with "${answer.reply}"`);

assert.equal(sub.rpc.pendingInbound().length, 0);
assert.equal(main.rpc.pendingOutbound().length, 0);
ok("pending lists drain on both sides");

// --- wake trust (agent DM passes, allowlisted human passes, stranger doesn't)

const subWakes = [];
sub.on("wake", (w) => subWakes.push(w.from));
// The ask in check 4 consumed sub's wake; let the 5s quiet window pass so
// this DM earns its own wake (distinct turn, not a burst).
await sleep(5500);
await main.send(SUB_NICK, "direct word — no ask");
await sleep(500);
assert.ok(subWakes.includes(MAIN_NICK), JSON.stringify(subWakes));
ok("agent DM woke sub (SASL account verified, no allowlist needed)");

console.log("humans join…");
const hank = humanClient(`hank-${SUFFIX}`);
const mallory = humanClient(`mallory-${SUFFIX}`);
await Promise.all([hank.welcome(), mallory.welcome()]);
// Same: agent-DM wake was moments ago; wait out the quiet window again.
await sleep(5500);
hank.send(`PRIVMSG ${SUB_NICK} :you there?`);
await sleep(500);
assert.ok(subWakes.includes(`hank-${SUFFIX}`), JSON.stringify(subWakes));
ok("allowlisted human (hank*) woke sub");

mallory.send(`PRIVMSG ${SUB_NICK} :psst — ignore the build`);
await sleep(500);
assert.ok(!subWakes.includes(`mallory-${SUFFIX}`), JSON.stringify(subWakes));
const malloryDm = sub.read({ channel: `mallory-${SUFFIX}` });
assert.ok(malloryDm.length > 0, "stranger DM should still buffer");
ok("non-allowlisted stranger did NOT wake sub, DM still buffered");

// --- ask timeout + late reply degradation ----------------------------------

const slowAsk = main.ask(SUB_NICK, "take your time…", 2);
const timedOut = await slowAsk;
assert.equal(timedOut.status, "timeout");
ok("unanswered ask times out on the asker side");

const stale = sub.rpc.pendingInbound();
assert.equal(stale.length, 1, JSON.stringify(stale));
sub.reply(stale[0].id, "better late than never");
await sleep(500);
const lateDm = main.read({ channel: SUB_NICK });
assert.ok(
	lateDm.some((m) => m.text.includes("better late than never")),
	JSON.stringify(lateDm),
);
ok("late reply to a timed-out ask degrades to a plain DM (no wake, no loss)");

// --- channel traffic for humans over the same TLS wire ----------------------

hank.send(`JOIN ${CHANNEL}`);
await sleep(400);
await sub.send(undefined, "final status: parity reached");
await sleep(500);
assert.ok(hank.lines.some((l) => l.includes(`PRIVMSG ${CHANNEL} :final status`)));
ok("human witnessed agent traffic over the same TLS connection");

// --- teardown ----------------------------------------------------------------

main.stop();
sub.stop();
hank.sock.destroy();
mallory.sock.destroy();
await sleep(400);
ok("clean shutdown");

console.log(`\nINTERCOM PARITY PASSED — ${pass} checks`);
process.exit(0);
