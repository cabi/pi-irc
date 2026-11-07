// Presence + wake trust: AWAY as busy signal (RFC 2812 §4.1, 305/306
// confirmations), and the DM-wake allowlist gate (roster agents always wake,
// humans only when their nick matches a delivery.wakeAllowNicks glob).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

/** Fake IRC transport: same auto-answer contract as session.test.mjs. */
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
				for (const chan of rest.split(",").map((c) => c.trim()).filter(Boolean)) {
					this.say(`:${me}!pi@h JOIN ${chan}`);
					this.say(`:srv 331 ${me} ${chan} :No topic is set`);
					this.say(`:srv 353 ${me} = ${chan} :${me}`);
					this.say(`:srv 366 ${me} ${chan} :End of /NAMES list.`);
					this.say(`:srv 352 ${me} ${chan} pi h srv ${me} H :0 pi-agent project=proj role=main session=s1`);
					this.say(`:srv 315 ${me} ${chan} :End of WHO list`);
				}
				break;
			}
			case "TOPIC": {
				this.say(`:srv 331 ${me} ${rest} :No topic is set`);
				break;
			}
			case "WHO": {
				this.say(`:srv 315 ${me} ${rest.split(" ")[0]} :End of WHO list`);
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

const ident = { project: "proj", role: "main", shortId: "s1" };

function makeConfig(over = {}) {
	return {
		server: { host: "irc.example", port: 6667, tls: false },
		nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
		channels: {
			projectTemplate: "#pi-{slug}",
			defaults: [],
			autoCreate: true,
			topicTemplate: "pi {slug} — {date}",
			...over.channels,
		},
		capabilities: { request: [] },
		delivery: {
			bufferMax: 50,
			wakeOnDirectMessage: true,
			chunkLongSends: true,
			wakeAllowNicks: over.wakeAllowNicks ?? [],
		},
		projectSlug: "proj",
	};
}

async function boot(over = {}) {
	const srv = new FakeServer();
	const client = new IrcClient(
		{ nick: "pi-main-s1", username: "pi", realname: "pi-agent:main:proj:s1" },
		srv,
	);
	srv.bind(client);
	client.startRegistration();
	srv.say(":srv 001 pi-main-s1 :Welcome");
	const pending = IrcSession.connect(makeConfig(over), ident, { client });
	srv.say(":srv 376 pi-main-s1 :End of MOTD");
	const session = await pending;
	return { srv, client, session };
}

test("busy presence: setBusy(true) sends AWAY, setBusy(false) clears", async () => {
	const { srv, session } = await boot();
	srv.lines = [];
	session.setBusy(true);
	assert.ok(
		srv.lines.some((l) => /^AWAY :busy since /.test(l)),
		`AWAY with reason sent: ${srv.lines}`,
	);

	srv.lines = [];
	session.setBusy(false);
	assert.ok(srv.lines.includes("AWAY"), `bare AWAY clears: ${srv.lines}`);
});

test("busy presence: 306/305 confirmations land in the buffer as system notes", async () => {
	const { srv, session } = await boot();
	srv.say(":srv 306 pi-main-s1 :You have been marked as being away");
	let msgs = session.read("*").map((m) => m.text);
	assert.ok(msgs.some((t) => /marked away/.test(t)), `306 buffered: ${msgs}`);

	srv.say(":srv 305 pi-main-s1 :You are no longer marked as being away");
	msgs = session.read("*").map((m) => m.text);
	assert.ok(msgs.some((t) => /back \(no longer away\)/.test(t)), `305 buffered: ${msgs}`);
});

test("wake trust: empty allowlist is default-deny — strangers never wake", async () => {
	const { srv, session } = await boot({ wakeAllowNicks: [] });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":stranger!u@h PRIVMSG pi-main-s1 :hello?");
	assert.equal(wakes.length, 0, "no account, no allowlist entry → no wake");
	const msgs = session.read("stranger").map((m) => m.text);
	assert.ok(msgs.some((t) => /not wake-trusted/.test(t)), `marked untrusted: ${msgs}`);
	// A services-account holder (extended-join) wakes even with an empty list.
	srv.say(":pi-sub-7!pi@h JOIN #pi-proj pi-sub-7-acct :pi-agent project=proj role=sub");
	srv.say(":pi-sub-7!pi@h PRIVMSG pi-main-s1 :ready?");
	assert.equal(wakes.length, 1, "account-verified peer wakes");
	assert.equal(wakes[0].from, "pi-sub-7");
});

test("wake trust: human must match a glob, strangers are only buffered", async () => {
	const { srv, session } = await boot({ wakeAllowNicks: ["carsten", "ops-*"] });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));

	srv.say(":stranger!u@h PRIVMSG pi-main-s1 :psst");
	assert.equal(wakes.length, 0, "unlisted nick does not wake");
	let msgs = session.read("stranger").map((m) => m.text);
	assert.ok(
		msgs.some((t) => /not on the wake allowlist/.test(t)),
		`buffered with a note: ${msgs}`,
	);

	srv.say(":carsten!u@h PRIVMSG pi-main-s1 :ping");
	assert.equal(wakes.length, 1, "exact glob match wakes");
	// A second DM inside the quiet window is throttled (still buffered).
	srv.say(":carsten!u@h PRIVMSG pi-main-s1 :again");
	assert.equal(wakes.length, 1, "wake throttle holds within the quiet window");
	assert.ok(session.read("carsten").length >= 2, "throttled DM still buffered");
});

test("wake trust: wildcard globs match case-insensitively", async () => {
	const { srv, session } = await boot({ wakeAllowNicks: ["OPS-*"] });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":ops-lead!u@h PRIVMSG pi-main-s1 :yo");
	assert.equal(wakes.length, 1, "lowercase nick matches uppercase glob");
});

test("wake trust: self-declared agent metadata alone never wakes; an account does", async () => {
	const { srv, session } = await boot({ wakeAllowNicks: ["carsten"] });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));

	// Forged realname, no services account: buffered, never wakes.
	srv.say(":mallory!pi@h JOIN #pi-proj * :pi-agent project=proj role=main session=666");
	srv.say(":mallory!pi@h PRIVMSG pi-main-s1 :trust me");
	assert.equal(wakes.length, 0, "self-declared realname is not identity");

	// Same join shape, but holding a real account: wakes.
	srv.say(":pi-sub-9!pi@h JOIN #pi-proj pi-sub-9-acct :pi-agent project=proj role=sub");
	srv.say(":pi-sub-9!pi@h PRIVMSG pi-main-s1 :ask: ready?");
	assert.equal(wakes.length, 1, "services account bypasses the allowlist");
	assert.equal(wakes[0].from, "pi-sub-9");
});
