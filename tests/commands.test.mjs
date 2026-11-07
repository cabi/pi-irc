// /irc slash command: argument parsing (unit) and end-to-end command runs
// against a live session over the mock IRC server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { parseIrcCommand, IRC_COMMAND_HELP } = await loadViaPi(repoFile("lib", "commands.ts"));

test("parse: empty and bare subcommands", () => {
	assert.deepEqual(parseIrcCommand(""), { op: "status" });
	assert.deepEqual(parseIrcCommand("   "), { op: "status" });
	assert.deepEqual(parseIrcCommand("status"), { op: "status" });
	assert.deepEqual(parseIrcCommand("help"), { op: "help" });
});

test("parse: read forms", () => {
	assert.deepEqual(parseIrcCommand("read"), { op: "read" });
	assert.deepEqual(parseIrcCommand("read #pi-proj"), { op: "read", conversation: "#pi-proj" });
	assert.deepEqual(parseIrcCommand("read carol"), { op: "read", conversation: "carol" });
	assert.deepEqual(parseIrcCommand("read #pi-proj 5"), { op: "read", conversation: "#pi-proj", limit: 5 });
	assert.deepEqual(parseIrcCommand("read 7"), { op: "read", limit: 7 });
});

test("parse: read rejects junk", () => {
	assert.match(parseIrcCommand("read #a #b").error, /usage/);
	assert.match(parseIrcCommand("read 0").error, /1\.\.500/);
	assert.match(parseIrcCommand("read 999").error, /1\.\.500/);
});

test("parse: send forms", () => {
	assert.deepEqual(parseIrcCommand("send #pi-proj hello there"), {
		op: "send",
		target: "#pi-proj",
		text: "hello there",
	});
	assert.deepEqual(parseIrcCommand("send carol status?"), { op: "send", target: "carol", text: "status?" });
	assert.match(parseIrcCommand("send #pi-proj").error, /usage/);
	assert.match(parseIrcCommand("send").error, /usage/);
});

test("parse: unknown subcommand points at help", () => {
	const p = parseIrcCommand("explode");
	assert.equal(p.op, "help");
	assert.match(p.error, /unknown subcommand "explode"/);
});

test("help text lists all subcommands", () => {
	for (const s of ["status", "read", "send", "help"]) assert.ok(IRC_COMMAND_HELP.includes(s));
});

// ------------------------------------------------- live run (mock server)

const { runIrcCommand } = await loadViaPi(repoFile("lib", "commands.ts"));

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

const { EventEmitter } = await import("node:events");

class CaplessServer extends EventEmitter {
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
		const [, cmd, rest = ""] = /^(\S+)(?:\s+(.*))?$/.exec(line) ?? [];
		const me = this.#client?.nick;

		if (cmd === "TOPIC") {
			this.say(`:srv 331 ${me} ${rest} :No topic is set`);
		}

		if (cmd === "WHO") {
			this.say(`:srv 352 ${me} ${rest} u h srv carol H :0 Carsten`);
			this.say(`:srv 315 ${me} ${rest} :End of /WHO list`);
		}

		if (cmd === "JOIN") {
			for (const chan of rest.split(",")) {
				this.say(`:${me}!pi@h JOIN ${chan}`);
				this.say(`:srv 331 ${me} ${chan} :No topic is set`);
				this.say(`:srv 353 ${me} = ${chan} :${me} carol`);
				this.say(`:srv 366 ${me} ${chan} :End of /NAMES list.`);
			}
		}
	}
	bind(c) {
		this.#client = c;
	}
	connect() {
		return Promise.resolve();
	}
	close() {}
	destroy() {}
}

const cfg = {
	server: { host: "irc.example", port: 6667, tls: false },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}" },
	capabilities: { request: [] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
	projectSlug: "proj",
};

const ident = { project: "proj", role: "main", shortId: "s1" };

async function boot() {
	const srv = new CaplessServer();

	const client = new IrcClient(
		{ nick: "pi-main-s1", username: "pi", realname: "pi-agent project=proj role=main session=s1" },
		srv,
	);

	srv.bind(client);
	client.startRegistration();
	srv.say(":srv 001 pi-main-s1 :Welcome");
	const pending = IrcSession.connect(cfg, ident, { client });
	srv.say(":srv 376 pi-main-s1 :End of MOTD");
	const session = await pending;

	return { srv, session, run: (args) => runIrcCommand(async () => session, args) };
}

test("run: /irc status reports nick and project channel", async () => {
	const { session, run } = await boot();
	const r = await run("");
	assert.equal(r.level, "info");
	assert.match(r.message, /pi-main-s1/);
	assert.match(r.message, /#pi-proj/);
	session.stop();
});

test("run: /irc send posts to the channel, /irc read returns it", async () => {
	const { srv, session, run } = await boot();
	const r = await run("send #pi-proj hello from the command line");
	assert.equal(r.level, "info");
	assert.match(r.message, /sent to #pi-proj/);
	srv.say(":carol!u@h PRIVMSG #pi-proj :hi agent");
	const rd = await run("read #pi-proj 5");
	assert.match(rd.message, /carol/);
	assert.match(rd.message, /hi agent/);
	session.stop();
});

test("run: usage problems come back as warnings, not throws", async () => {
	const { session, run } = await boot();
	const r = await run("send nobody");
	assert.equal(r.level, "warning");
	assert.match(r.message, /usage/);
	const h = await run("frobnicate");
	assert.equal(h.level, "warning");
	assert.match(h.message, /unknown subcommand/);
	session.stop();
});
