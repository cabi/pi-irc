// P10 CHATHISTORY: client batch framing, session catch-up on join, msgid
// dedup, replay-never-wakes, fetchHistory, tool op, config defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadViaPi, repoFile, sleep } from "./helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));
const { executeIrcOp } = await loadViaPi(repoFile("lib", "tool.ts"));
const { loadConfig } = await loadViaPi(repoFile("lib", "config.ts"));

/**
 * FakeServer (session.test.mjs pattern) + CAP negotiation and scripted
 * CHATHISTORY answers wrapped in IRCv3 batches, exactly like ergo:
 *   @draft/chathistory-end;time=… :srv BATCH +1 chathistory <target>
 *   @msgid=m1;time=…;batch=1 :peer!u@h PRIVMSG <target> :text
 *   :srv BATCH -1
 */
class FakeHistoryServer extends EventEmitter {
	lines = [];
	#client = null;
	#answers = [];
	/** Lines replayed for every CHATHISTORY request. */
	/** Lines replayed for every CHATHISTORY request. */
	replay = [];
	/** Real servers mint unique msgids per delivery; default mirrors that. */
	autoUniqueMsgids = true;
	#msgSeq = 0;

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
			case "CAP": {
				const sub = rest.split(" ")[0];
				if (sub === "LS") this.say(":srv CAP * LS :batch draft/chathistory server-time");
				if (sub === "REQ") this.say(":srv CAP * ACK :batch draft/chathistory");
				break;
			}
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
			case "TOPIC":
				this.say(`:srv 331 ${me} ${rest} :No topic is set`);
				break;
			case "WHO":
				this.say(`:srv 315 ${me} ${rest.split(" ")[0]} :End of WHO list`);
				break;
			case "CHATHISTORY": {
				// CHATHISTORY LATEST <target> * <limit>
				const [, target] = rest.split(" ");
				const iso = new Date().toISOString();
				this.say(`:srv BATCH +7 chathistory ${target}`);
				for (const r of this.replay) {
					const msgid = this.autoUniqueMsgids ? `${r.msgid}-${++this.#msgSeq}` : r.msgid;
					// DM history replays with target = OUR nick (RFC-realistic).
					const to = /^[#&+]/.test(target) ? target : me;
					this.say(
						`@msgid=${msgid};time=${iso};batch=7 :${r.from}!u@h PRIVMSG ${to} :${r.text}`,
					);
				}
				this.say(":srv BATCH -7");
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
		channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug}", ...over },
		capabilities: { request: [] },
		delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
		history: { catchupLimit: 3 },
		projectSlug: "proj",
	};
}

const ident = { project: "proj", role: "main", shortId: "s1" };

async function boot(over = {}, srv = new FakeHistoryServer()) {
	const client = new IrcClient(
		{ nick: "pi-main-s1", username: "pi", realname: "pi-agent", caps: ["batch", "draft/chathistory"] },
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

test("client: chathistory collects a batched page and sends the right request", async () => {
	const { srv, client } = await boot();
	srv.replay = [
		{ from: "alice", text: "earlier", msgid: "m1" },
		{ from: "bob", text: "later", msgid: "m2" },
	];
	srv.autoUniqueMsgids = false; // assert the scripted msgids verbatim
	const page = await client.chathistory("#pi-proj", 10, 2_000);
	assert.ok(srv.lines.some((l) => l === "CHATHISTORY LATEST #pi-proj * 10"));
	assert.equal(page.length, 2);
	assert.equal(page[0].sourceNick, "alice");
	assert.equal(page[0].tags.msgid, "m1");
	assert.equal(page[0].tags.batch, "7");
});

test("session: self-join catch-up buffers replayed channel lines", async () => {
	const srv = new FakeHistoryServer();
	srv.replay = [{ from: "alice", text: "before you joined", msgid: "r1" }];
	const { session } = await boot({}, srv);
	await sleep(50); // catch-up is fire-and-forget
	const msgs = session.read({ conv: "#pi-proj" });
	assert.equal(msgs.length, 1);
	assert.equal(msgs[0].from, "alice");
	assert.equal(msgs[0].text, "before you joined");
	assert.equal(msgs[0].kind, "chan");
});

test("session: msgid dedup — the same message delivered twice is buffered once", async () => {
	const srv = new FakeHistoryServer();
	srv.autoUniqueMsgids = false; // scripted msgid is authoritative for dedup
	srv.replay = [{ from: "alice", text: "once", msgid: "dup1" }];
	const { session, client } = await boot({}, srv);
	await sleep(50);
	// Live re-delivery of the exact same msgid (outside any batch):
	client.sendRaw("");
	srv.say("@msgid=dup1 :alice!u@h PRIVMSG #pi-proj :once");
	await sleep(20);
	assert.equal(session.read({ conv: "#pi-proj" }).length, 1);
});

test("session: replayed history never wakes; live DMs still do", async () => {
	const srv = new FakeHistoryServer();
	srv.replay = [{ from: "pi-sub-s2", text: "[pi-ask abcd12 timeout=600] ready?", msgid: "w1" }];
	const wakes = [];
	const { session } = await boot({}, srv);
	session.on("wake", (w) => wakes.push(w));
	// DM history via explicit fetch (as a restarted agent would):
	const fetched = await session.fetchHistory("pi-sub-s2", 5);
	assert.equal(wakes.length, 0, "replayed ask must not wake");
	assert.ok(fetched.some((m) => m.kind === "ask"), "replayed ask is buffered and trackable");
	srv.say(":pi-sub-s2!u@h JOIN #pi-proj pi-sub-s2-acct :pi-agent project=proj role=sub");
	srv.say(":pi-sub-s2!u@h PRIVMSG pi-main-s1 :live ping");
	await sleep(20);
	assert.equal(wakes.length, 1);
	assert.equal(wakes[0].from, "pi-sub-s2");
});

test("session: fetchHistory drains the conversation once", async () => {
	const srv = new FakeHistoryServer();
	srv.replay = [
		{ from: "pi-sub-s2", text: "h1", msgid: "h1" },
		{ from: "pi-sub-s2", text: "h2", msgid: "h2" },
	];
	const { session } = await boot({}, srv);
	// DM target: boot catch-up fetched #pi-proj only, so this fetch is the
	// first delivery of h1/h2 into the pi-sub-s2 conversation.
	const msgs = await session.fetchHistory("pi-sub-s2", 5);
	assert.equal(msgs.length, 2);
	// Already drained: a follow-up read sees nothing new.
	assert.equal(session.read({ conv: "pi-sub-s2" }).length, 0);
});

test("tool: history op formats the page; missing target fails loudly", async () => {
	const srv = new FakeHistoryServer();
	srv.replay = [{ from: "alice", text: "from the archive", msgid: "t1" }];
	const { session } = await boot({}, srv);
	const r = await executeIrcOp(async () => session, "history", { target: "#pi-proj" });
	assert.match(r.content[0].text, /from the archive/);
	assert.match(r.content[0].text, /<alice>/);
	await assert.rejects(
		() => executeIrcOp(async () => session, "history", {}),
		/history requires target/,
	);
});

test("config: chathistory caps are default-on; catchupLimit validates", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-cfg-"));
	const globalPath = path.join(dir, "pi-irc.json");
	fs.writeFileSync(globalPath, JSON.stringify({ server: { host: "irc.example", tls: false } }));
	const cfg = loadConfig({ globalPath });
	assert.ok(cfg.capabilities.request.includes("batch"));
	assert.ok(cfg.capabilities.request.includes("draft/chathistory"));
	assert.equal(cfg.history.catchupLimit, 50);
	fs.writeFileSync(
		globalPath,
		JSON.stringify({ server: { host: "irc.example", tls: false }, history: { catchupLimit: 0 } }),
	);
	assert.equal(loadConfig({ globalPath }).history.catchupLimit, 0);
	fs.writeFileSync(
		globalPath,
		JSON.stringify({ server: { host: "irc.example", tls: false }, history: { catchupLimit: -1 } }),
	);
	assert.throws(() => loadConfig({ globalPath }), /history.catchupLimit/);
	fs.rmSync(dir, { recursive: true, force: true });
});
