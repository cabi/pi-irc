// P11 addressing: @session-id prefix and role selectors resolve via roster
// metadata; channels and raw nicks pass through; ambiguity fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile, sleep } from "./helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

/** Minimal fake: JOIN burst seeds the roster via NAMES + WHO (352). */
class FakeRosterServer extends EventEmitter {
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
		if (cmd === "JOIN") {
			this.say(`:${me}!pi@h JOIN ${rest}`);
			this.say(`:srv 353 ${me} = ${rest} :${me} pi-main-aaa111 pi-sub-bbb222 pi-sub-ccc333 carsten`);
			this.say(`:srv 366 ${me} ${rest} :End of /NAMES list.`);
			for (const w of [
				"pi h srv pi-main-aaa111 H :0 pi-agent project=proj role=main session=aaa111",
				"pi h srv pi-sub-bbb222 H :0 pi-agent project=proj role=sub session=bbb222",
				"pi h srv pi-sub-ccc333 H :0 pi-agent project=proj role=sub session=ccc333",
				"u h srv carsten H :0 Carsten",
			]) {
				this.say(`:srv 352 ${me} ${rest} ${w}`);
			}
			this.say(`:srv 315 ${me} ${rest} :End of WHO list`);
		}
		if (cmd === "TOPIC") this.say(`:srv 331 ${me} ${rest.split(" ")[0]} :No topic is set`);
		if (cmd === "WHO") this.say(`:srv 315 ${me} ${rest.split(" ")[0]} :End of WHO list`);
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

async function boot() {
	const srv = new FakeRosterServer();
	const client = new IrcClient({ nick: "pi-main-me1", username: "pi", realname: "pi-agent" }, srv);
	srv.bind(client);
	client.startRegistration();
	srv.say(":srv 001 pi-main-me1 :Welcome");
	const cfg = {
		server: { host: "irc.example", port: 6667, tls: false },
		nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
		channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug}" },
		capabilities: { request: [] },
		delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
		history: { catchupLimit: 0 },
		projectSlug: "proj",
	};
	const pending = IrcSession.connect(cfg, { project: "proj", role: "main", shortId: "me1" }, { client });
	srv.say(":srv 376 pi-main-me1 :End of MOTD");
	const session = await pending;
	await sleep(20); // let the WHO burst land
	return { srv, session };
}

test("resolveTarget: @session prefix and exact id", async () => {
	const { session } = await boot();
	assert.equal(session.resolveTarget("@aaa111"), "pi-main-aaa111");
	assert.equal(session.resolveTarget("@bbb222"), "pi-sub-bbb222");
});

test("resolveTarget: unknown or ambiguous selectors fail with candidates", async () => {
	const { session } = await boot();
	assert.throws(() => session.resolveTarget("@zzz999"), /no agent session starts with "zzz999".*pi-main-aaa111 @aaa111/s);
	assert.throws(() => session.resolveTarget("sub"), /2 sub agents — address by @session instead/s);
	assert.equal(session.resolveTarget("main2"), "main2"); // unknown word = raw nick passthrough
});

test("resolveTarget: sole role, channels, humans, self-exclusion", async () => {
	const { session } = await boot();
	assert.equal(session.resolveTarget("main"), "pi-main-aaa111");
	assert.equal(session.resolveTarget("#pi-proj"), "#pi-proj");
	assert.equal(session.resolveTarget("carsten"), "carsten");
	// Our own session id is never a resolution target:
	assert.throws(() => session.resolveTarget("@me1"), /no agent session starts with/);
});

test("send routes through the resolver", async () => {
	const { srv, session } = await boot();
	session.send("@bbb222", "hello sub");
	await sleep(20);
	assert.ok(srv.lines.some((l) => /^PRIVMSG pi-sub-bbb222 :hello sub/.test(l)));
	// Role selector also works for send:
	session.send("main", "hello main");
	await sleep(20);
	assert.ok(srv.lines.some((l) => /^PRIVMSG pi-main-aaa111 :hello main/.test(l)));
});

test("ask envelopes ride the resolved nick", async () => {
	const { srv, session } = await boot();
	const p = session.ask("@aaa111", "ready?", 1);
	await sleep(30);
	assert.ok(
		srv.lines.some((l) => /^PRIVMSG pi-main-aaa111 :\[pi-ask .*\] ready\?/.test(l)),
		srv.lines.join(" | "),
	);
	const res = await p;
	assert.equal(res.status, "timeout");
});
