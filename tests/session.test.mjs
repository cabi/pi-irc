// IrcSession composition: bootstrap, privmsg routing/wake, roster lifecycle,
// send defaults, status. Uses a scriptable fake transport (same shape as
// tests/mock-irc-server.mjs but synchronous, with auto-answered JOIN bursts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));
const { wire } = await loadViaPi(repoFile("lib", "wire.ts"));

/**
 * Fake IRC server: a scriptable Transport with a real IrcClient on top.
 * Tests push server→client lines with `srv.say(...)` and inspect
 * `srv.lines` (client→server). Outbound commands are auto-answered
 * (JOIN → join echo + 331/353/366/352/315 burst) on a microtask so the
 * session's await handlers attach first — exactly the async gap a real
 * socket has.
 */
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

	/** Server → client raw line (synchronous, like a socket data event). */
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

function makeConfig(over = {}) {
	return {
		server: { host: "irc.example", port: 6667, tls: false },
		nick: { template: "pi-{role}-{short}", maxLen: 30 },
		channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}", ...over },
		delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
		projectSlug: "proj",
	};
}

const ident = {
	project: "proj",
	role: "main",
	shortId: "s1",
};

/**
 * Bootstrap an injected client: registration lines are replayed such that
 * connect() attaches its MOTD waiter before 376 arrives (the same ordering
 * guarantee a live socket gives).
 */
async function boot(over = {}, srv = new FakeServer()) {
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

test("connect: joins project channel, stamps topic, seeds roster", async () => {
	const { srv, session } = await boot();
	assert.equal(session.projectChannel, "#pi-proj");
	assert.ok(srv.lines.some((l) => l === "JOIN #pi-proj"), "JOIN sent");
	// 331 (no topic) + autoCreate → topic stamp sent with slug and date.
	const stamp = srv.lines.find((l) => l.startsWith("TOPIC #pi-proj"));
	assert.ok(stamp, "TOPIC sent");
	assert.match(stamp, /pi proj — \d{4}-\d{2}-\d{2}$/);
	// Roster seeded from NAMES + WHO.
	const nicks = session.rosterView().map((p) => p.nick);
	assert.ok(nicks.includes("pi-main-s1"));
	assert.ok(nicks.includes("chanop"));
	const self = session.rosterView().find((p) => p.nick === "pi-main-s1");
	assert.equal(self.kind, "agent");
	assert.equal(self.role, "main");
	const human = session.rosterView().find((p) => p.nick === "chanop");
	assert.equal(human.kind, "human");
	assert.ok(session.channels.joined("#pi-proj"));
	session.stop();
});

test("connect: no topic stamp when a topic exists", async () => {
	const srv = new FakeServer();
	// After the auto-answer's 331, a real server with an existing topic
	// would have sent 332 instead — replay that correction.
	const origSay = srv.say.bind(srv);
	srv.say = (line) => {
		origSay(line);
		if (line.includes(" 331 ")) {
			origSay(":srv 332 pi-main-s1 #pi-proj :pre-existing topic");
		}
	};
	const { session } = await boot({}, srv);
	assert.ok(!srv.lines.some((l) => l.startsWith("TOPIC")), "no TOPIC when one exists");
	assert.equal(session.channels.get("#pi-proj").topic, "pre-existing topic");
	session.stop();
});

test("connect: extra default channels joined alongside project channel", async () => {
	const { srv, session } = await boot({ defaults: ["#pi-ops", "#pi-proj"] });
	assert.ok(srv.lines.includes("JOIN #pi-proj,#pi-ops"), "single JOIN with both channels");
	assert.ok(session.channels.joined("#pi-ops"));
	session.stop();
});

test("connect: join failure rejects", async () => {
	const srv = new FakeServer();
	const client = new IrcClient({ nick: "pi-main-s1", username: "pi", realname: "pi-agent:main:proj:s1" }, srv);
	srv.bind(client);
	// Sabotage the auto-answer: JOIN → 403 NoSuchChannel.
	srv.send = (line) => {
		srv.lines.push(line);
		if (line.startsWith("JOIN")) {
			const chan = line.slice(5);
			queueMicrotask(() => srv.emit("line", `:srv 403 pi-main-s1 ${chan} :No such channel`));
		}
	};
	client.startRegistration();
	srv.say(":srv 001 pi-main-s1 :Welcome");
	const pending = IrcSession.connect(makeConfig(), ident, { client });
	srv.say(":srv 376 pi-main-s1 :End of MOTD");
	await assert.rejects(
		() => pending,
		/No such channel/,
	);
});

test("privmsg routing: channel vs DM, wake only on DM", async () => {
	const { srv, session } = await boot();
	let wakes = 0;
	session.on("wake", () => wakes++);
	// Channel chatter: buffered, no wake.
	srv.say(":alice!u@h PRIVMSG #pi-proj :standup in 5");
	// DM: buffered under sender + wake.
	srv.say(":carol!u@h PRIVMSG pi-main-s1 :status report please");
	const msgs = session.read({ limit: 100 });
	assert.ok(msgs.some((m) => m.conv === "#pi-proj" && m.from === "alice" && m.text === "standup in 5"));
	const dm = msgs.find((m) => m.kind === "dm");
	assert.ok(dm, "DM buffered");
	assert.equal(dm.conv, "carol");
	assert.equal(dm.from, "carol");
	assert.equal(wakes, 1);
	// Second DM inside the quiet window: no second wake.
	srv.say(":carol!u@h PRIVMSG pi-main-s1 :another nudge");
	assert.equal(wakes, 1);
	// First read() above already consumed the first DM; only the new one left.
	assert.equal(session.read({ conversation: "carol", limit: 10 }).length, 1);
	session.stop();
});

test("membership events update channels and roster", async () => {
	const { srv, session } = await boot();
	srv.say(":dave!u@h JOIN :#pi-proj"); // note: trailing form
	assert.ok(session.channels.get("#pi-proj").members.has("dave"));
	srv.say(":dave!u@h PART #pi-proj :bye");
	assert.ok(!session.channels.get("#pi-proj").members.has("dave"));
	srv.say(":chanop!u@h NICK chanop2");
	assert.ok(session.roster.all().some((p) => p.nick === "chanop2"));
	srv.say(":chanop2!u@h QUIT :gone");
	assert.ok(!session.roster.all().some((p) => p.nick === "chanop2"));
	session.stop();
});

test("send: defaults to project channel, drains immediately within burst", async () => {
	const { srv, session } = await boot();
	const r = session.send(undefined, "hello team");
	assert.equal(r.target, "#pi-proj");
	assert.equal(r.pending, 0, "burst covers one message");
	await new Promise((res) => setImmediate(res));
	assert.ok(srv.lines.some((l) => l === wire.privmsg("#pi-proj", "hello team")));
	session.stop();
});

test("status summarizes session for the agent", async () => {
	const { session } = await boot();
	const st = session.status();
	assert.equal(st.nick, "pi-main-s1");
	assert.equal(st.role, "main");
	assert.equal(st.projectChannel, "#pi-proj");
	assert.deepEqual(st.channels, ["#pi-proj"]);
	session.stop();
});

test("stop sends QUIT once and stops the queue", async () => {
	const { srv, session } = await boot();
	session.stop();
	session.stop();
	const quits = srv.lines.filter((l) => l.startsWith("QUIT"));
	assert.equal(quits.length, 1);
});
