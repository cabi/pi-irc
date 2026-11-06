/**
 * P3 smoke test: the extension's full client stack against a REAL ergo
 * server in Docker (PRODUCT.md "Server" assumption: a friendly internal
 * IRC server). Not part of `npm test` — run manually when Docker is up:
 *
 *   docker run -d --rm --name pi-irc-ergo \
 *     -v "$PWD/tests/ergo/ergo.yaml:/ergo/ergo.yaml:ro" \
     -v "$PWD/tests/ergo/certs:/ergo/certs:ro" \
 *     -v pi-irc-ergo-data:/ergo/data \
 *     -p 127.0.0.1:16667:6667 -p 127.0.0.1:16697:6697 ergochat/ergo:latest
 *   node scripts/ergo-smoke.mjs
 *   docker rm -f pi-irc-ergo   # and: docker volume rm pi-irc-ergo-data
 *
 * Checks: registration + caps against ergo's real CAP LS 302 burst,
 * channel auto-create + topic stamp, roster (agent + human), buffered
 * read, cross-client delivery both ways, DM wake, clean QUIT.
 */
import net from "node:net";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { SUPPORTED_CAPS } = await loadViaPi(repoFile("lib", "caps.ts"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.IRC_PORT ?? 16667);
const CHANNEL = "#pi-smoke";

const config = {
	server: { host: HOST, port: PORT, tls: false },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: {
		projectTemplate: "#pi-{slug}",
		defaults: [],
		autoCreate: true,
		topicTemplate: "pi {slug} — {date}",
	},
	capabilities: { request: [...SUPPORTED_CAPS] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
	projectSlug: "smoke",
};
const identity = { project: "smoke", role: "main", shortId: "ab12cd34" };

// --- a raw human client (exactly what PRODUCT.md promises humans can be)
function humanClient(nick) {
	const sock = net.connect({ host: HOST, port: PORT });
	const lines = [];
	let buf = "";
	sock.on("data", (d) => {
		buf += d.toString("utf8");
		let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			lines.push(buf.slice(0, i));
			buf = buf.slice(i + 2);
			if (/^:[^ ]+ 001 /.test(lines.at(-1))) sock.emit("welcome");
		}
	});
	const send = (line) => sock.write(`${line}\r\n`);
	send(`NICK ${nick}`);
	send(`USER human 0 * :Carsten Test`);
	return { sock, lines, send, welcome: () => new Promise((r) => sock.on("welcome", r)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const ok = (name) => {
	pass++;
	console.log(`  ok ${pass} — ${name}`);
};

// The agent joins FIRST: on ergo the channel creator gets op ("t" mode),
// so only the first joiner can stamp the topic. A human-created channel
// leaves the agent without op — stamping stays best-effort by design.
console.log("booting agent session against ergo…");
const session = await IrcSession.connect(config, identity);
const wakes = [];
session.on("wake", (w) => wakes.push(w));

const carol = humanClient("carol");
await carol.welcome();
carol.send(`JOIN ${CHANNEL}`);
await sleep(300);

const st = session.status();
ok(`registered as ${st.nick}, project channel ${st.projectChannel}`);
assert.equal(st.projectChannel, CHANNEL);
assert.ok(st.channels.includes(CHANNEL), `channels: ${JSON.stringify(st.channels)}`);
ok("joined (and thereby auto-created) the project channel");

const caps = session.client.enabledCaps;
for (const c of ["server-time", "extended-join", "multi-prefix", "away-notify"]) {
	assert.ok(caps.includes(c), `cap ${c} enabled, got ${JSON.stringify(caps)}`);
}
ok(`IRCv3 caps negotiated: ${caps.join(", ")}`);

// topic stamp visible to the human: 332 arrives with the join burst
assert.ok(
	carol.lines.some((l) => new RegExp(`332 carol ${CHANNEL} :pi smoke`).test(l)),
	`topic stamped: ${carol.lines.filter((l) => l.includes("332") || l.includes("TOPIC")).join(" | ")}`,
);
ok("topic stamp set by first agent, shown to the human on join");

await session.send(undefined, "agent online — smoke test");
await sleep(300);
assert.ok(carol.lines.some((l) => l.includes(`PRIVMSG ${CHANNEL} :agent online`)), "human saw channel message");
ok("channel send delivered to human client");

carol.send(`PRIVMSG ${CHANNEL} :hello agent, from a plain IRC client`);
await sleep(300);
const read = session.read({ channel: CHANNEL, limit: 5 });
const joined = read.map((m) => `${m.from}: ${m.text}`).join("\n");
assert.match(joined, /carol/);
assert.match(joined, /hello agent, from a plain IRC client/);
ok("read op returns buffered channel message from human");

const rosterText = session.rosterView().map((p) => `${p.nick} ${p.kind}${p.role ? `/${p.role}` : ""}`).join("\n");
assert.match(rosterText, /pi-main-ab12cd34.*agent/sm);
assert.match(rosterText, /carol.*human/sm);
ok(`roster classifies members (${rosterText.replace(/\n/g, " / ")})`);

// WHO seeding happened at boot; force a roster refresh to exercise ergo's WHO
carol.send(`PRIVMSG pi-main-ab12cd34 :psst, direct`);
await sleep(300);
assert.equal(wakes.length, 1, `one wake, got ${JSON.stringify(wakes)}`);
ok(`DM raises exactly one wake: ${JSON.stringify(wakes[0])}`);
const dm = session.read({ conversation: "carol" }).map((m) => `${m.from}: ${m.text}`).join("\n");
assert.match(dm, /psst, direct/);
ok("DM buffered and readable");

session.stop();
await sleep(300);
assert.ok(carol.lines.some((l) => l.includes("QUIT")), "server saw QUIT");
ok("clean QUIT on session stop");

carol.sock.destroy();
console.log(`\nERGO SMOKE PASSED — ${pass} checks`);
process.exit(0);
