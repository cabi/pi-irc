// KICK handling: the client parses the command, the session treats a
// self-kick as "dropped from the channel" — local part, one buffered
// system line, one event, then a delayed rejoin (opt-out via
// channels.kickRejoinDelayMs = 0). Foreign kicks only update membership.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same scriptable fake as session.test.mjs (JOIN burst auto-answered). */
class FakeServer extends EventEmitter {
	lines = [];
	#client = null;
	#answers = [];

	constructor() {
		super();
		this.send = (line) => {
			this.lines.push(line);
			this.#answers.push(() => this.#autoAnswer(line));
			this.#flush();
		};
	}

	say(line) {
		this.emit("line", line);
	}

	#flush() {
		const pending = this.#answers;
		this.#answers = [];
		for (const a of pending) queueMicrotask(a);
	}

	#autoAnswer(line) {
		if (!this.#client) return;
		const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
		if (!m) return;
		const [, cmd, rest = ""] = m;
		const me = this.#client.nick;
		switch (cmd) {
			case "JOIN": {
				const chans = rest.split(",").map((c) => c.trim()).filter(Boolean);
				for (const chan of chans) {
					this.say(`:${me}!pi@h JOIN ${chan}`);
					this.say(`:srv 331 ${me} ${chan} :No topic is set`);
					this.say(`:srv 353 ${me} = ${chan} :${me} @chanop`);
					this.say(`:srv 366 ${me} ${chan} :End of /NAMES list.`);
					this.say(`:srv 352 ${me} ${chan} pi h srv ${me} H :0 pi-agent project=proj role=main session=s1`);
					this.say(`:srv 352 ${me} ${chan} u h srv chanop H :0 Carsten`);
					this.say(`:srv 315 ${me} ${chan} :End of WHO list`);
				}
				break;
			}
			case "TOPIC": {
				this.say(`:srv 331 ${me} ${rest} :No topic is set`);
				break;
			}
			case "WHO": {
				const mask = rest.split(" ")[0];
				this.say(`:srv 315 ${me} ${mask} :End of WHO list`);
				break;
			}
			default:
				break;
		}
	}

	bind(client) {
		this.#client = client;
	}

	connect() {
		return Promise.resolve();
	}

	close() {}
	destroy() {}
}

function makeConfig(channelsOver = {}) {
	return {
		server: { host: "irc.example", port: 6667, tls: false },
		nick: { template: "pi-{role}-{short}", maxLen: 30 },
		channels: {
			projectTemplate: "#pi-{slug}",
			defaults: [],
			autoCreate: true,
			topicTemplate: "pi {slug} — {date}",
			...channelsOver,
		},
		capabilities: { request: [] },
		delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
		projectSlug: "proj",
	};
}

const ident = { project: "proj", role: "main", shortId: "s1" };

async function boot(channelsOver = {}, srv = new FakeServer()) {
	const client = new IrcClient({ nick: "pi-main-s1", username: "pi", realname: "pi-agent:main:proj:s1" }, srv);
	srv.bind(client);
	client.startRegistration();
	srv.say(":srv 001 pi-main-s1 :Welcome");
	const pending = IrcSession.connect(makeConfig(channelsOver), ident, { client });
	srv.say(":srv 376 pi-main-s1 :End of MOTD");
	const session = await pending;
	return { srv, client, session };
}

test("client: KICK parses into a kick event (self + reason)", async () => {
	const srv = new FakeServer();
	const client = new IrcClient({ nick: "pi-main-s1", username: "pi", realname: "r" }, srv);
	srv.bind(client);
	const kicks = [];
	client.on("kick", (e) => kicks.push(e));
	srv.say(":chanop!u@h KICK #pi-proj pi-main-s1 :flooding");
	assert.equal(kicks.length, 1, "kick event emitted");
	assert.deepEqual(
		{ ...kicks[0] },
		{ nick: "pi-main-s1", by: "chanop", channel: "#pi-proj", reason: "flooding", self: true },
	);
	srv.say(":chanop!u@h KICK #pi-proj bob :noise");
	assert.equal(kicks.length, 2);
	assert.equal(kicks[1].self, false);
	assert.equal(kicks[1].nick, "bob");
});

test("self-kick: parts locally, buffers one system line, rejoins after delay", async () => {
	const { srv, session } = await boot({ kickRejoinDelayMs: 15 });
	const kicked = [];
	session.on("kicked", (e) => kicked.push(e));
	const joinsBefore = srv.lines.filter((l) => l === "JOIN #pi-proj").length;
	srv.say(":chanop!u@h KICK #pi-proj pi-main-s1 :flooding");
	assert.equal(kicked.length, 1, "kicked event");
	assert.deepEqual(kicked[0], { channel: "#pi-proj", by: "chanop", reason: "flooding" });
	assert.ok(!session.channels.joined("#pi-proj"), "parted locally right away");
	const sys = session.read({ channel: "#pi-proj" }).find((m) => m.kind === "system");
	assert.ok(sys, "system line buffered");
	assert.match(sys.text, /kicked by chanop/);
	assert.match(sys.text, /flooding/);
	await sleep(80); // rejoin delay 15ms + burst
	const joinsAfter = srv.lines.filter((l) => l === "JOIN #pi-proj").length;
	assert.equal(joinsAfter, joinsBefore + 1, "exactly one rejoin JOIN");
	assert.ok(session.channels.joined("#pi-proj"), "membership restored by the join echo");
	session.stop();
});

test("self-kick: kickRejoinDelayMs 0 disables the rejoin", async () => {
	const { srv, session } = await boot({ kickRejoinDelayMs: 0 });
	const joinsBefore = srv.lines.filter((l) => l === "JOIN #pi-proj").length;
	srv.say(":chanop!u@h KICK #pi-proj pi-main-s1 :begone");
	await sleep(80);
	assert.equal(srv.lines.filter((l) => l === "JOIN #pi-proj").length, joinsBefore, "no rejoin JOIN");
	assert.ok(!session.channels.joined("#pi-proj"), "still parted");
	session.stop();
});

test("foreign kick: membership removal only — no event, no rejoin", async () => {
	const { srv, session } = await boot({ kickRejoinDelayMs: 15 });
	const kicked = [];
	session.on("kicked", (e) => kicked.push(e));
	const joinsBefore = srv.lines.filter((l) => l === "JOIN #pi-proj").length;
	srv.say(":chanop!u@h KICK #pi-proj bob :noise");
	await sleep(60);
	assert.equal(kicked.length, 0, "no self-kick event");
	assert.ok(!session.channels.get("#pi-proj").members.has("bob"), "bob removed from members");
	assert.equal(srv.lines.filter((l) => l === "JOIN #pi-proj").length, joinsBefore, "no rejoin");
	assert.ok(session.channels.joined("#pi-proj"), "we are still in");
	session.stop();
});

test("stop() cancels a pending rejoin", async () => {
	const { srv, session } = await boot({ kickRejoinDelayMs: 50 });
	srv.say(":chanop!u@h KICK #pi-proj pi-main-s1 :flooding");
	const joinsBefore = srv.lines.filter((l) => l === "JOIN #pi-proj").length;
	session.stop();
	await sleep(120);
	assert.equal(srv.lines.filter((l) => l === "JOIN #pi-proj").length, joinsBefore, "rejoin never sent");
});
