// IRCv3 capability negotiation: CapNegotiator state machine, client CAP
// flow (LS 302 → REQ → ACK → END, 410 abort), and session-level benefits
// (server-time stamps, extended-join roster learning, away-notify).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { CapNegotiator, parseCapList, pickCaps } = await loadViaPi(repoFile("lib", "caps.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));
const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

// ---------------------------------------------------------------- unit

test("parseCapList: splits, drops =values, ignores empties", () => {
	assert.deepEqual(parseCapList("server-time extended-join=1 away-notify"), [
		"server-time",
		"extended-join",
		"away-notify",
	]);
	assert.deepEqual(parseCapList(""), []);
});

test("pickCaps: wanted ∩ offered, case-insensitive, wanted order kept", () => {
	assert.deepEqual(
		pickCaps(["EXTENDED-JOIN", "server-time", "x"], ["server-time", "extended-join", "bogus"]),
		["server-time", "extended-join"],
	);
});

test("negotiator: happy path LS → REQ → ACK → END", () => {
	const n = new CapNegotiator(["server-time", "extended-join"]);
	assert.deepEqual(n.start(), ["CAP LS 302"]);
	assert.equal(n.phase, "ls");
	const a1 = n.handleCap(["*", "LS", ":server-time", "extended-join", "chghost"]);
	assert.deepEqual(a1.send, ["CAP REQ :server-time extended-join"]);
	assert.equal(a1.done, undefined);
	const a2 = n.handleCap(["*", "ACK", ":server-time", "extended-join"]);
	assert.deepEqual(a2.send, ["CAP END"]);
	assert.equal(a2.done, true);
	assert.deepEqual(a2.enabled, ["server-time", "extended-join"]);
	assert.equal(n.phase, "done");
	assert.deepEqual(n.enabled, ["server-time", "extended-join"]);
});

test("negotiator: multiline LS is accumulated before REQ", () => {
	const n = new CapNegotiator(["server-time"]);
	n.start();
	const c1 = n.handleCap(["*", "LS", "*", ":chghost"]);
	assert.deepEqual(c1, {}); // continuation: wait for the final part
	const c2 = n.handleCap(["*", "LS", ":server-time"]);
	assert.deepEqual(c2.send, ["CAP REQ :server-time"]);
});

test("negotiator: nothing offered that we want → straight to END", () => {
	const n = new CapNegotiator(["server-time"]);
	n.start();
	const a = n.handleCap(["*", "LS", ":multi-prefix"]);
	assert.deepEqual(a.send, ["CAP END"]);
	assert.equal(a.done, true);
	assert.deepEqual(a.enabled, []);
});

test("negotiator: batch NAK falls back to per-cap REQs (InspIRCd drill)", () => {
	const n = new CapNegotiator(["server-time", "extended-join", "multi-prefix"]);
	n.start();
	n.handleCap(["*", "LS", ":server-time", "extended-join", "multi-prefix"]);
	// Server hates one of the three — the whole batch bounces.
	const a = n.handleCap(["*", "NAK", ":server-time", "extended-join", "multi-prefix"]);
	assert.deepEqual(a.send, ["CAP REQ :server-time", "CAP REQ :extended-join", "CAP REQ :multi-prefix"]);
	assert.ok(!a.done);
	// Individual verdicts arrive; negotiation ends only after the last.
	const b = n.handleCap(["*", "ACK", ":server-time"]);
	assert.deepEqual(b.enabled, ["server-time"]);
	assert.ok(!b.done);
	const c = n.handleCap(["*", "NAK", ":multi-prefix"]);
	assert.deepEqual(c.send, undefined);
	assert.ok(!c.done);
	const d = n.handleCap(["*", "ACK", ":extended-join"]);
	assert.deepEqual(d.send, ["CAP END"]);
	assert.equal(d.done, true);
	assert.deepEqual(d.enabled, ["server-time", "extended-join"]);
});

test("negotiator: single-cap batch NAK ends empty (no fallback loop)", () => {
	const n = new CapNegotiator(["server-time"]);
	n.start();
	n.handleCap(["*", "LS", ":server-time"]);
	const a = n.handleCap(["*", "NAK", ":server-time"]);
	assert.deepEqual(a.send, ["CAP END"]);
	assert.equal(a.done, true);
	assert.deepEqual(a.enabled, []);
});

test("negotiator: ACK listing caps we never requested is filtered out", () => {
	const n = new CapNegotiator(["server-time"]);
	n.start();
	n.handleCap(["*", "LS", ":server-time"]);
	const a = n.handleCap(["*", "ACK", ":server-time", "extended-join"]);
	assert.deepEqual(a.enabled, ["server-time"]); // extended-join was not in our REQ
});

test("negotiator: empty wanted list never opens negotiation", () => {
	const n = new CapNegotiator([]);
	assert.deepEqual(n.start(), []);
	// Even a stray LS answer must not produce traffic.
	assert.deepEqual(n.handleCap(["*", "LS", ":server-time"]), {});
});

test("negotiator: abort() closes the door (410 drill)", () => {
	const n = new CapNegotiator(["server-time"]);
	n.start();
	n.handleCap(["*", "LS", ":server-time"]);
	const a = n.abort();
	assert.equal(a.done, true);
	assert.equal(n.phase, "done");
	// Late lines after abort are ignored.
	assert.deepEqual(n.handleCap(["*", "ACK", ":server-time"]), {});
});

// ------------------------------------------------------- client (fake wire)

class FakeTransport extends EventEmitter {
	sent = [];
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
}

test("client: registration interleaves CAP LS 302 before NICK/USER", () => {
	const ft = new FakeTransport();
	const c = new IrcClient({ nick: "pi", username: "u", realname: "r", caps: ["server-time"] }, ft);
	c.startRegistration();
	assert.deepEqual(ft.sent[0], "CAP LS 302");
	assert.match(ft.sent[1], /^NICK pi\r?$/);
	assert.match(ft.sent[2], /^USER /);
});

test("client: full CAP flow emits capsEnabled, then registers on 001", () => {
	const ft = new FakeTransport();
	const events = [];
	const c = new IrcClient({ nick: "pi", username: "u", realname: "r", caps: ["server-time"] }, ft);
	c.on("capsEnabled", (e) => events.push(["caps", ...e.caps]));
	c.on("registered", (e) => events.push(["registered", e.nick]));
	c.startRegistration();
	ft.emit("line", ":srv CAP * LS :server-time chghost");
	ft.emit("line", ":srv CAP * ACK :server-time");
	ft.emit("line", ":srv 001 pi :Welcome");
	assert.ok(ft.sent.includes("CAP REQ :server-time"));
	assert.ok(ft.sent.includes("CAP END"));
	assert.deepEqual(events, [["caps", "server-time"], ["registered", "pi"]]);
	assert.deepEqual(c.enabledCaps, ["server-time"]);
});

test("client: 410 (RFC-2812-only server) aborts negotiation silently", () => {
	const ft = new FakeTransport();
	const events = [];
	const c = new IrcClient({ nick: "pi", username: "u", realname: "r", caps: ["server-time"] }, ft);
	c.on("capsEnabled", (e) => events.push(e.caps));
	c.on("registered", () => events.push("registered"));
	c.startRegistration();
	ft.emit("line", ":srv 410 pi CAP :Unknown CAP command");
	ft.emit("line", ":srv 001 pi :Welcome");
	assert.ok(!ft.sent.includes("CAP END"), "no CAP END after 410");
	assert.deepEqual(events, [[], "registered"]); // capsEnabled with empty list
	assert.deepEqual(c.enabledCaps, []);
});

test("client: no caps wanted → plain RFC 2812 registration", () => {
	const ft = new FakeTransport();
	const c = new IrcClient({ nick: "pi", username: "u", realname: "r", caps: [] }, ft);
	c.startRegistration();
	assert.ok(!ft.sent.some((l) => l.startsWith("CAP")), "no CAP traffic");
});

// ------------------------------------------------- session (fake IRC server)

/** FakeServer with CAP auto-answers; JOIN bursts like session.test.mjs. */
class CapServer extends EventEmitter {
	lines = [];
	#client = null;

	constructor() {
		super();
		this.send = (line) => {
			this.lines.push(line);
			queueMicrotask(() => this.#autoAnswer(line));
		};
	}

	say(line) {
		this.emit("line", line);
	}

	#autoAnswer(line) {
		if (!this.#client) return;
		const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
		if (!m) return;
		const [, cmd, rest = ""] = m;
		const me = this.#client.nick;
		switch (cmd) {
			case "CAP": {
				const sub = rest.split(" ")[0].toUpperCase();
				if (sub === "LS") {
					this.say(":srv CAP * LS :extended-join server-time away-notify chghost");
				} else if (sub === "REQ") {
					this.say(`:srv CAP * ACK ${rest.slice(4)}`); // "REQ :a b" → "ACK :a b"
				}
				break;
			}
			case "JOIN": {
				for (const chan of rest.split(",")) {
					this.say(`:${me}!pi@h JOIN ${chan}`);
					this.say(`:srv 331 ${me} ${chan} :No topic is set`);
					this.say(`:srv 353 ${me} = ${chan} :${me}`);
					this.say(`:srv 366 ${me} ${chan} :End of /NAMES list.`);
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

const config = {
	server: { host: "irc.example", port: 6667, tls: false },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}" },
	capabilities: { request: ["extended-join", "server-time", "away-notify"] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
	projectSlug: "proj",
};
const ident = { project: "proj", role: "main", shortId: "s1" };

async function bootCaps() {
	const srv = new CapServer();
	const client = new IrcClient(
		{ nick: "pi-main-s1", username: "pi", realname: "pi-agent:main:proj:s1", caps: config.capabilities.request },
		srv,
	);
	srv.bind(client);
	client.startRegistration();
	srv.say(":srv 001 pi-main-s1 :Welcome");
	const pending = IrcSession.connect(config, ident, { client });
	srv.say(":srv 376 pi-main-s1 :End of MOTD");
	const session = await pending;
	return { srv, client, session };
}

test("session: negotiated caps flow through registration", async () => {
	const { srv, client, session } = await bootCaps();
	const seq = srv.lines.filter((l) => l.startsWith("CAP")).map((l) => l.replace(/^CAP (LS|REQ|END).*/, "CAP $1"));
	assert.deepEqual(seq, ["CAP LS", "CAP REQ", "CAP END"]);
	assert.deepEqual([...client.enabledCaps].sort(), ["away-notify", "extended-join", "server-time"]);
	session.stop();
});

test("session: server-time tag becomes the buffer timestamp", async () => {
	const { srv, session } = await bootCaps();
	srv.say("@time=2024-01-01T00:00:00.500Z :alice!u@h PRIVMSG #pi-proj :standup");
	const m = session.read({ limit: 10 }).find((x) => x.from === "alice");
	assert.ok(m, "message buffered");
	assert.equal(m.ts, Date.parse("2024-01-01T00:00:00.500Z"));
	session.stop();
});

test("session: message without time tag stamps receipt time", async () => {
	const { srv, session } = await bootCaps();
	const before = Date.now();
	srv.say(":alice!u@h PRIVMSG #pi-proj :plain");
	const m = session.read({ limit: 10 }).find((x) => x.from === "alice");
	assert.ok(m.ts >= before, `ts ${m.ts} >= ${before}`);
	session.stop();
});

test("session: extended-join fills the roster without WHO", async () => {
	const { srv, session } = await bootCaps();
	srv.say(":pi-sub-s9!pi@h JOIN #pi-proj pi-sub-s9 :pi-agent project=proj role=sub session=s9 parent=abcd1234");
	await new Promise((r) => setTimeout(r, 5)); // let handlers settle
	const peer = session.rosterView().find((p) => p.nick === "pi-sub-s9");
	assert.ok(peer, "peer in roster");
	assert.equal(peer.kind, "agent");
	assert.equal(peer.role, "sub");
	assert.ok(!srv.lines.some((l) => l.startsWith("WHO pi-sub-s9")), "no WHO fallback for the joiner");
	session.stop();
});

test("session: plain JOIN (no extended-join params) still falls back to WHO", async () => {
	const { srv, session } = await bootCaps();
	srv.say(":pi-worker-s9!pi@h JOIN #pi-proj");
	await new Promise((r) => setTimeout(r, 5));
	assert.ok(srv.lines.some((l) => l.startsWith("WHO ")), "WHO sent");
	session.stop();
});

test("session: away-notify touches the roster without crashing", async () => {
	const { srv, session } = await bootCaps();
	srv.say(":alice!u@h AWAY :gone fishing");
	srv.say(":alice!u@h AWAY"); // back
	const peer = session.rosterView().find((p) => p.nick === "alice");
	assert.ok(peer, "away updates kept alice in the roster");
	session.stop();
});
