// IrcClient state machine over a fake transport: registration, 433 retry,
// PING/PONG, typed events, ERROR command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

class FakeTransport extends EventEmitter {
	constructor() {
		super();
		this.sent = [];
		this.destroyed = false;
	}
	send(line) {
		this.sent.push(line);
	}
	close() {
		this.emit("close");
	}
	destroy() {
		this.destroyed = true;
		this.emit("close");
	}
	/** Test helper: server pushes a raw protocol line. */
	server(line) {
		this.emit("line", line);
	}
	sentLines(cmd) {
		return this.sent.filter((l) => l.startsWith(cmd));
	}
}

function makeClient(overrides = {}) {
	const t = new FakeTransport();

	const c = new IrcClient(
		{
			nick: "pi-demo-m01",
			username: "pi",
			realname: "pi-agent project=demo role=main",
			pingTimeoutMs: 60000,
			...overrides,
		},
		t,
	);

	return { c, t };
}

test("registration sends NICK+USER, 001 completes it", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	assert.equal(c.state, "registering");
	assert.deepEqual(t.sent.slice(0, 2), ["NICK pi-demo-m01", "USER pi 0 * :pi-agent project=demo role=main"]);
	t.server(":srv 001 pi-demo-m01 :Welcome");
	assert.equal(c.state, "registered");
	assert.equal(c.realNick, "pi-demo-m01");
});

test("433 nick collision retries through the fallback pool", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	t.server(":srv 433 * pi-demo-m01 :Nickname is already in use");
	t.server(":srv 433 * pi-demo-m01-a :Nickname is already in use");
	assert.deepEqual(t.sentLines("NICK").slice(1), ["NICK pi-demo-m01-a", "NICK pi-demo-m01-b"]);
	t.server(":srv 001 pi-demo-m01-b :Welcome");
	assert.equal(c.realNick, "pi-demo-m01-b");
});

test("exhausted fallbacks error out and destroy the transport", () => {
	const { c, t } = makeClient({ nickFallbacks: ["-x"] });
	const errors = [];
	c.on("error", (e) => errors.push(e));
	c.startRegistration();
	t.server(":srv 433 * pi-demo-m01 :in use");
	t.server(":srv 433 * pi-demo-m01-x :in use");
	assert.equal(t.destroyed, true);
	assert.match(errors.at(-1).message, /all nick variants taken/);
});

test("PING is answered with PONG and the same token", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	t.server("PING :srv-ping-token");
	assert.equal(t.sentLines("PONG").at(-1), "PONG srv-ping-token");
});

test("typed events carry source, target, and self-flag", () => {
	const { c, t } = makeClient();
	const events = { privmsg: [], join: [], part: [], quit: [], nickChange: [] };
	c.on("privmsg", (e) => events.privmsg.push(e));
	c.on("join", (e) => events.join.push(e));
	c.on("part", (e) => events.part.push(e));
	c.on("quit", (e) => events.quit.push(e));
	c.on("nickChange", (e) => events.nickChange.push(e));

	t.server(":pi-demo-m01!pi@h JOIN :#pi-demo");
	t.server(":peer!pi@h JOIN #pi-demo");
	t.server(":peer!pi@h PRIVMSG #pi-demo :status?");
	t.server(":peer!pi@h PRIVMSG pi-demo-m01 :direct");
	t.server(":peer!pi@h PART #pi-demo :done");
	t.server(":peer!pi@h QUIT :bye");
	t.server(":peer!pi@h NICK :peer2");

	assert.deepEqual(events.join[0], { nick: "pi-demo-m01", channel: "#pi-demo", self: true });
	assert.equal(events.join[1].self, false);
	assert.deepEqual(events.privmsg[0], { from: "peer", target: "#pi-demo", text: "status?", toSelf: false });
	assert.deepEqual(events.privmsg[1], { from: "peer", target: "pi-demo-m01", text: "direct", toSelf: false });
	assert.deepEqual(events.part[0], { nick: "peer", channel: "#pi-demo", self: false });
	assert.deepEqual(events.quit[0], { nick: "peer", reason: "bye" });
	assert.deepEqual(events.nickChange[0], { oldNick: "peer", newNick: "peer2", self: false });

	t.server(":pi-demo-m01!pi@h NICK :pi-demo-m01-2");
	assert.equal(c.realNick, "pi-demo-m01-2");
});

test("JOIN rejection numerics surface as errors with the code", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	t.server(":srv 471 pi-demo-m01 #pi-demo :Cannot join channel (+l)");
	assert.equal(errors[0].code, 471);
	assert.match(errors[0].message, /Cannot join channel/);
});

test("ERROR command (closing link) surfaces as error, not a numeric", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	t.server("ERROR :Closing Link: pi-demo-m01 (Quit)");
	assert.match(errors[0].message, /Closing Link/);
});

test("quit sends QUIT and closes the transport", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	t.server(":srv 001 pi-demo-m01 :Welcome");
	c.quit("extension disabled");
	assert.equal(t.sent.at(-1), "QUIT :extension disabled");
	assert.equal(c.state, "closed");
});
