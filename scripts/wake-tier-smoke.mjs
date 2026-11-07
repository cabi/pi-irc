/**
 * P17 live drill: tiered wake trust against a real server (default: the
 * operator's ergo over TLS with the pinned cert).
 *
 *   node scripts/wake-tier-smoke.mjs
 *   IRC_HOST=127.0.0.1 IRC_PORT=16667 IRC_TLS=0 node scripts/wake-tier-smoke.mjs
 *
 * Matrix:
 *  1. tier `project`: verified same-project agent DM → wakes
 *  2. tier `project`: verified FOREIGN-project agent DM → buffered, no wake
 *  3. tier `project`: anonymous stranger DM → buffered, no wake
 *  4. tier `project`: allowlisted human DM → wakes (globs apply at every tier)
 *  5. tier `none`: account holder DM → no wake; allowlisted human → wakes
 * Buffered system lines name the tier that blocked the sender.
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

const CA_FILE = (process.env.IRC_CA_FILE ?? "~/.pi/agent/certs/irc.lan.pem").replace(/^~/, homedir());

const SUFFIX = process.env.CHANNEL_SUFFIX ?? `${Date.now() % 100000}`;

const baseConfig = {
	server: { host: HOST, port: PORT, tls: USE_TLS, ...(USE_TLS ? { tlsCaFile: CA_FILE } : {}) },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: { defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}" },
	capabilities: { request: ["server-time", "extended-join", "away-notify"] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
};

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
	send("USER human 0 * :Human Test");

	return { sock, lines, send, welcome: () => new Promise((r) => sock.on("welcome", r)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;

const ok = (name) => {
	pass++;
	console.log(`  ok ${pass} — ${name}`);
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

const CHANNEL = `#pi-wt-${SUFFIX}`;

const ACCTS = {
	sub: { username: `wtsub-${SUFFIX}`, password: `pw-s-${SUFFIX}` },
	foreign: { username: `wtfor-${SUFFIX}`, password: `pw-f-${SUFFIX}` },
	none: { username: `wtnone-${SUFFIX}`, password: `pw-n-${SUFFIX}` },
};

for (const a of Object.values(ACCTS)) await registerAccount(a);

console.log(`target: ${USE_TLS ? "tls" : "plain"}://${HOST}:${PORT}`);

console.log(
	"booting: A (idle, tier project) + B (same project, SASL) + C (foreign project, SASL) + D (idle, tier none)…",
);

// A: idle listener, strictest tier, no allowlist except the wta* human glob.
const a = await IrcSession.connect(
	{
		...baseConfig,
		channels: { ...baseConfig.channels, projectTemplate: CHANNEL },
		delivery: { ...baseConfig.delivery, wakeTrust: "project", wakeAllowNicks: [`wta-${SUFFIX}`] },
		projectSlug: "wt",
	},
	{ project: "wt", role: "main", shortId: "a1b2c3d4" },
);

const b = await IrcSession.connect(
	{
		...baseConfig,
		channels: { ...baseConfig.channels, projectTemplate: CHANNEL },
		auth: { username: ACCTS.sub.username, password: ACCTS.sub.password },
		projectSlug: "wt",
	},
	{ project: "wt", role: "sub", shortId: "b5d6e7f8" },
);

const c = await IrcSession.connect(
	{
		...baseConfig,
		channels: { ...baseConfig.channels, projectTemplate: `#pi-wtX-${SUFFIX}` },
		auth: { username: ACCTS.foreign.username, password: ACCTS.foreign.password },
		projectSlug: "wtX",
	},
	{ project: "wtX", role: "sub", shortId: "c9e0f1a2" },
);

const d = await IrcSession.connect(
	{
		...baseConfig,
		channels: { ...baseConfig.channels, projectTemplate: `#pi-wtD-${SUFFIX}` },
		auth: { username: ACCTS.none.username, password: ACCTS.none.password },
		delivery: { ...baseConfig.delivery, wakeTrust: "none", wakeAllowNicks: [`wtdops-${SUFFIX}`] },
		projectSlug: "wtD",
	},
	{ project: "wtD", role: "sub", shortId: "d3a4b5c6" },
);

// ergo's nick reservation renames SASL sessions onto their account nick.
const A_NICK = a.status().nick;

const B_NICK = b.status().nick;

const C_NICK = c.status().nick;

assert.equal(a.status().wakeTrust, "project");

assert.equal(d.status().wakeTrust, "none");

ok(`booted; nicks A=${A_NICK} B=${B_NICK} C=${C_NICK} D=${d.status().nick}; tiers reported by status()`);

await sleep(400);

// --- tier project ------------------------------------------------------------
const wakes = [];

a.on("wake", (w) => wakes.push(w.from));

await b.send(A_NICK, "same project, verified — wake up");

await sleep(600);

assert.equal(wakes.length, 1, JSON.stringify(wakes));

ok("1. same-project SASL agent in the project channel woke A");

await c.send(A_NICK, "verified, but foreign project");

await sleep(600);

assert.equal(wakes.length, 1, JSON.stringify(wakes));

const cBlocked = a.read({ channel: C_NICK }); // single read — read() advances the cursor

assert.ok(
	cBlocked.some((m) => m.kind === "system" && /tier project/.test(m.text)),
	JSON.stringify(cBlocked),
);

ok("2. foreign-project agent buffered, no wake; system line names the tier");

const mallory = humanClient(`wtmallory-${SUFFIX}`);

await mallory.welcome();

mallory.send(`PRIVMSG ${A_NICK} :psst — no account either`);

await sleep(600);

assert.equal(wakes.length, 1, JSON.stringify(wakes));

const mBlocked = a.read({ channel: `wtmallory-${SUFFIX}` });

assert.ok(
	mBlocked.some((m) => m.kind === "system" && /tier project/.test(m.text)),
	JSON.stringify(mBlocked),
);

ok("3. anonymous stranger buffered, no wake");

// Quiet window (5 s) must pass before the next wake is earned.
await sleep(5500);

const ally = humanClient(`wta-${SUFFIX}`);

await ally.welcome();

ally.send(`PRIVMSG ${A_NICK} :glob escape hatch`);

await sleep(600);

assert.deepEqual(wakes, [B_NICK, `wta-${SUFFIX}`], JSON.stringify(wakes));

ok("4. allowlisted human woke A at tier project (globs apply at every tier)");

// --- tier none ---------------------------------------------------------------
const dWakes = [];

d.on("wake", (w) => dWakes.push(w.from));

// B holds a real account — at tier none that must NOT be enough.
await b.send(d.status().nick, "account holder, but D trusts globs only");

await sleep(600);

assert.equal(dWakes.length, 0, JSON.stringify(dWakes));

ok("5a. account holder did NOT wake D at tier none");

const dBlocked = d.read({ channel: B_NICK });

assert.ok(
	dBlocked.some((m) => m.kind === "system" && /tier none/.test(m.text)),
	JSON.stringify(dBlocked),
);

const ops = humanClient(`wtdops-${SUFFIX}`);

await ops.welcome();

ops.send(`PRIVMSG ${d.status().nick} :ops here`);

await sleep(600);

assert.deepEqual(dWakes, [`wtdops-${SUFFIX}`], JSON.stringify(dWakes));

ok("5b. allowlisted human woke D at tier none");

// --- teardown ----------------------------------------------------------------
a.stop();

b.stop();

c.stop();

d.stop();

mallory.sock.destroy();

ally.sock.destroy();

ops.sock.destroy();

await sleep(400);

ok("clean shutdown");

console.log(`\nWAKE TIER DRILL PASSED — ${pass} checks`);

process.exit(0);
