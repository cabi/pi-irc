// Reconnect: policy math, transport re-attach, and the full session-level
// re-establish cycle (re-register, rejoin, reseed, flush) against the real
// loopback mock server, plus the guardrails (stop cancels, injected
// clients without a factory never reconnect).
import assert from "node:assert/strict";
import test from "node:test";
import { once, sleep } from "./helpers.mjs";
import { MockIrcServer } from "./mock-irc-server.mjs";
import { repoFile, loadViaPi } from "./helpers.mjs";

const { Backoff } = await loadViaPi(repoFile("lib", "reconnect.ts"));
const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { IrcSocket } = await loadViaPi(repoFile("lib", "irc-socket.ts"));

const ident = { project: "proj", role: "main", shortId: "s1" };

function makeConfig(port, over = {}) {
	return {
		server: { host: "127.0.0.1", port, tls: false },
		nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
		channels: {
			projectTemplate: "#pi-{slug}",
			defaults: [],
			autoCreate: true,
			topicTemplate: "pi {slug} — {date}",
			...over,
		},
		delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
		projectSlug: "proj",
	};
}

const fastReconnect = (over = {}) => ({
	transportFactory: () => new IrcSocket(),
	backoff: { baseMs: 10, factor: 2, maxMs: 40, jitter: 0 },
	...over,
});

test("backoff grows exponentially, caps, and resets", () => {
	const b = new Backoff({ baseMs: 1000, factor: 2, maxMs: 5000, jitter: 0 });
	assert.equal(b.next(), 1000);
	assert.equal(b.next(), 2000);
	assert.equal(b.next(), 4000);
	assert.equal(b.next(), 5000); // capped
	assert.equal(b.next(), 5000);
	assert.equal(b.attempts, 5);
	b.reset();
	assert.equal(b.attempts, 0);
	assert.equal(b.peek(), 1000); // peek does not consume
	assert.equal(b.next(), 1000);
});

test("backoff jitter stays within ±spread", () => {
	const b = new Backoff({ baseMs: 1000, factor: 2, maxMs: 60_000, jitter: 0.5, rand: () => 0 });
	assert.equal(b.next(), 500); // rand=0 -> delay - spread
	const hi = new Backoff({ baseMs: 1000, factor: 2, maxMs: 60_000, jitter: 0.5, rand: () => 1 });
	assert.equal(hi.next(), 1500); // rand=1 -> delay + spread
});

test("backoff rejects nonsensical options", () => {
	assert.throws(() => new Backoff({ baseMs: 0 }), /baseMs/);
	assert.throws(() => new Backoff({ factor: 1 }), /factor/);
	assert.throws(() => new Backoff({ maxMs: 100, baseMs: 1000 }), /maxMs/);
	assert.throws(() => new Backoff({ jitter: 1.5 }), /jitter/);
});

test("session re-establishes after the server kills the link", async (t) => {
	const server = new MockIrcServer();
	t.after(() => server.stop());
	const port = await server.start();

	const session = await IrcSession.connect(makeConfig(port), ident, {
		reconnect: fastReconnect(),
	});
	t.after(() => session.stop());
	const events = [];
	session.on("reconnecting", (e) => events.push(["reconnecting", e]));
	session.on("reconnected", (e) => events.push(["reconnected", e]));

	assert.equal(session.status().connection, "registered");
	assert.equal(server.clients.length, 1);

	// The server hangs up on us — the reconnect path must do the rest.
	server.clients[0].socket.destroy();

	await once(session, "reconnected", 2000);
	const [, re] = events.at(-1);
	assert.equal(re.attempt, 1);

	// A fresh connection exists, registered under the original nick.
	assert.equal(server.clients.length, 2);
	assert.equal(session.status().connection, "registered");
	assert.equal(session.client.nick, "pi-main-s1");

	// Rejoined the project channel on the new connection.
	const rejoined = server.lastClient().lines.some((l) => /^JOIN #pi-proj/.test(l));
	assert.ok(rejoined, `expected JOIN on second connection, got ${server.lastClient().lines}`);
	assert.equal(session.status().reconnect, undefined);
});

test("messages queued while down flush after reconnect", async (t) => {
	const server = new MockIrcServer();
	t.after(() => server.stop());
	const port = await server.start();

	const session = await IrcSession.connect(makeConfig(port), ident, {
		reconnect: fastReconnect(),
	});
	t.after(() => session.stop());

	server.clients[0].socket.destroy();
	await once(session, "reconnecting", 1000); // link death observed, queue paused
	// The agent doesn't know the link is dead: enqueue intent now.
	session.send("#pi-proj", "queued while down");
	assert.equal(session.send("#pi-proj", "second while down").pending, 2);

	const got = new Promise((resolve) => {
		const seen = [];
		server.on("privmsg", ({ client, text }) => {
			seen.push({ client, text });
			if (seen.length === 2) resolve(seen);
		});
	});
	await once(session, "reconnected", 2000);
	const seen = await got; // flush happens right after re-register
	assert.deepEqual(
		seen.map((s) => s.text).sort(),
		["queued while down", "second while down"],
	);
	for (const { client, text } of seen) {
		assert.ok(client.lines.some((l) => l === `PRIVMSG #pi-proj :${text}`));
	}
});

test("nick fallbacks re-arm on reconnect (ghost holds the original nick)", async (t) => {
	const server = new MockIrcServer();
	server.rejectFirstNick = true; // every connection's first NICK gets 433
	t.after(() => server.stop());
	const port = await server.start();

	const session = await IrcSession.connect(makeConfig(port), ident, {
		reconnect: fastReconnect(),
	});
	t.after(() => session.stop());
	assert.equal(session.client.nick, "pi-main-s1-1"); // boot already fell back

	server.clients[0].socket.destroy();
	await once(session, "reconnected", 2000);
	// attach() reset to the original nick, 433 again, fallback again.
	assert.equal(session.client.nick, "pi-main-s1-1");
	assert.equal(server.lastClient().lines.filter((l) => l.startsWith("NICK ")).length, 2);
});

test("failed attempts back off and eventually succeed", async (t) => {
	const server = new MockIrcServer();
	t.after(() => server.stop());
	const port = await server.start();

	let factoryFailures = 0;
	const session = await IrcSession.connect(makeConfig(port), ident, {
		reconnect: fastReconnect({
			transportFactory: () => {
				// First two reconnect attempts can't even reach the server.
				factoryFailures += 1;
				if (factoryFailures <= 2) {
					const dead = new IrcSocket();
					dead.connect = () => Promise.reject(new Error("connection refused"));
					return dead;
				}
				return new IrcSocket();
			},
		}),
	});
	t.after(() => session.stop());

	const errors = [];
	session.on("sessionError", (m) => errors.push(m));
	server.clients[0].socket.destroy();

	await once(session, "reconnected", 3000);
	assert.equal(errors.length, 2);
	assert.match(errors[0], /reconnect attempt 1 failed: connection refused/);
	assert.equal(session.status().connection, "registered");
});

test("stop() cancels a pending reconnect", async (t) => {
	const server = new MockIrcServer();
	t.after(() => server.stop());
	const port = await server.start();

	const session = await IrcSession.connect(makeConfig(port), ident, {
		reconnect: fastReconnect({ backoff: { baseMs: 5000, factor: 2, maxMs: 5000, jitter: 0 } }),
	});
	server.clients[0].socket.destroy();
	await once(session, "reconnecting", 1000);

	session.stop();
	assert.equal(session.status().reconnect, undefined); // cancelled, not pending

	await sleep(100);
	assert.equal(server.clients.length, 1); // nobody came back
});

test("injected clients without a reconnect factory never reconnect", async (t) => {
	const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));
	const { EventEmitter } = await import("node:events");
	class FakeTransport extends EventEmitter {
		connect() {
			return Promise.resolve();
		}
		send(line) {
			(this.sent ??= []).push(line);
		}
		close() {}
		destroy() {}
	}
	const fake = new FakeTransport();
	const client = new IrcClient({ nick: "pi-main-s1", username: "pi", realname: "r" }, fake);
	client.state = "registered";
	const booting = IrcSession.connect(makeConfig(0), ident, { client });
	// Choreograph the bootstrap numerics the real server would send. The
	// session attaches its waits asynchronously — give each listener a tick.
	client.emit("motdEnd");
	await sleep(5);
	client.emit("join", { nick: "pi-main-s1", channel: "#pi-proj", self: true });
	await sleep(5);
	client.emit("message", { command: "315", params: ["pi-main-s1", "#pi-proj", "End of WHO"] });
	const session = await booting;
	t.after(() => session.stop());

	const saw = [];
	session.on("reconnecting", () => saw.push(1));
	fake.emit("close"); // the link dies
	await sleep(50);
	assert.equal(saw.length, 0); // no policy: no reconnect scheduled
	assert.equal(session.status().reconnect, undefined);
	assert.equal(session.status().connection, "closed");
});
