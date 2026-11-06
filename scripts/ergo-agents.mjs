/**
 * P3 validation run (PRODUCT.md "Validation run"): two agent sessions
 * (main + sub) and one stock-IRC human coordinate a small task
 * exclusively through IRC. Same ergo container as ergo-smoke:
 *
 *   docker run -d --rm --name pi-irc-ergo \
 *     -v "$PWD/tests/ergo/ergo.yaml:/ergo/ergo.yaml:ro" \
     -v "$PWD/tests/ergo/certs:/ergo/certs:ro" \
 *     -v pi-irc-ergo-data:/ergo/data \
 *     -p 127.0.0.1:16667:6667 -p 127.0.0.1:16697:6697 ergochat/ergo:latest
 *   IRC_PORT=16667 node scripts/ergo-agents.mjs
 *
 * Scenario: main boots and creates the channel; sub joins; they discover
 * each other's role via WHO/extended-join realnames; main assigns a task,
 * sub answers from its own buffer; the human joins mid-task, redirects the
 * work, and DMs the sub agent (wake). Everything crosses the wire once.
 */
import net from "node:net";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.IRC_PORT ?? 16667);
const CHANNEL = "#pi-demo";

const baseConfig = {
	server: { host: HOST, port: PORT, tls: false },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: {
		projectTemplate: "#pi-{slug}",
		defaults: [],
		autoCreate: true,
		topicTemplate: "pi {slug} — {date}",
	},
	capabilities: { request: ["server-time", "extended-join", "multi-prefix", "away-notify"] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
	projectSlug: "demo",
};

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

console.log("booting main agent…");
const main = await IrcSession.connect(baseConfig, { project: "demo", role: "main", shortId: "aa11bb22" });
ok(`main joined ${main.status().projectChannel} (channel created + topic stamped)`);

console.log("booting sub agent…");
const sub = await IrcSession.connect({ ...baseConfig, channels: { ...baseConfig.channels, autoCreate: true } }, { project: "demo", role: "sub", shortId: "cc33dd44" });
ok("sub joined the existing project channel");

await sleep(400);
const mainRoster = main.rosterView();
const subEntry = mainRoster.find((p) => p.nick === "pi-sub-cc33dd44");
assert.ok(subEntry, `main sees sub: ${JSON.stringify(mainRoster)}`);
assert.equal(subEntry.kind, "agent");
assert.equal(subEntry.role, "sub");
assert.equal(subEntry.project, "demo");
const selfEntry = sub.rosterView().find((p) => p.nick === "pi-main-aa11bb22");
assert.ok(selfEntry && selfEntry.role === "main", `sub sees main: ${JSON.stringify(selfEntry)}`);
ok("agents discovered each other with roles (WHO/extended-join realnames)");

await main.send(undefined, "@pi-sub-cc33dd44 task: check the build and report back");
await sleep(400);
const inbox = sub.read({ channel: CHANNEL });
const task = inbox.find((m) => m.text.includes("task: check the build"));
assert.ok(task, `sub received task: ${JSON.stringify(inbox)}`);
ok(`sub received its task via own buffer (from ${task.from})`);

await sub.send(undefined, "build green — no failures");
await sleep(400);
const mainInbox = main.read({ channel: CHANNEL });
assert.ok(mainInbox.some((m) => m.text === "build green — no failures"), JSON.stringify(mainInbox));
ok("main read the report");

console.log("human joins mid-task…");
const carol = humanClient("carol");
await carol.welcome();
carol.send(`JOIN ${CHANNEL}`);
await sleep(400);
// Stock IRC gives a mid-task joiner no replay (ergo history is off) —
// the human relies on live traffic, which the redirect/ack steps prove.
const names = carol.lines.filter((l) => l.includes(" 353 ")).at(-1) ?? "";
assert.match(names, /pi-main-aa11bb22/);
assert.match(names, /pi-sub-cc33dd44/);
ok(`human sees both agents in NAMES (${names.split(" ").pop()?.trim()})`);

carol.send(`PRIVMSG ${CHANNEL} :redirect — run the tests too, please`);
await sleep(400);
for (const [name, agent] of [["main", main], ["sub", sub]]) {
	const got = agent.read({ channel: CHANNEL }).some((m) => m.text.includes("redirect — run the tests too"));
	assert.ok(got, `${name} saw the redirect`);
}
ok("both agents saw the human's redirect");

const wakes = [];
sub.on("wake", (w) => wakes.push(w));
carol.send("PRIVMSG pi-sub-cc33dd44 :and you specifically — watch the flaky one");
await sleep(400);
assert.equal(wakes.length, 1);
assert.equal(wakes[0].from, "carol");
ok("human DM woke the idle sub agent exactly once");

await sub.send(undefined, "tests running, flaky one watched");
await sleep(400);
assert.ok(carol.lines.some((l) => l.includes("PRIVMSG #pi-demo :tests running")));
ok("sub's ack reached the human");

main.stop();
sub.stop();
await sleep(400);
ok("both agents quit cleanly");

carol.sock.destroy();
console.log(`\nCOORDINATION RUN PASSED — ${pass} checks`);
process.exit(0);
