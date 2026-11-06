// Extension entry wiring: disabled path (no config), enabled path against
// the mock IRC server (tool registration, background bootstrap, DM-wake →
// steer, session_shutdown → QUIT). Runs with a temp HOME so the global
// config path is test-owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadViaPi, repoFile } from "./helpers.mjs";
import { MockIrcServer } from "./mock-irc-server.mjs";

const { default: extensionFactory } = await loadViaPi(repoFile("index.ts"));

function mockPi() {
	const pi = {
		handlers: {},
		tools: [],
		userMessages: [],
		on(event, handler) {
			pi.handlers[event] ??= [];
			pi.handlers[event].push(handler);
		},
		registerTool(tool) {
			pi.tools.push(tool);
		},
		commands: [],
		registerCommand(name, def) {
			pi.commands.push({ name, ...def });
		},
		sendUserMessage(content, options) {
			pi.userMessages.push({ content, options });
		},
	};
	return pi;
}

function fire(pi, event, evt, ctx) {
	for (const h of pi.handlers[event] ?? []) h(evt, ctx);
}

function makeCtx(cwd) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "abcdef1234567890" },
		ui: { notify: () => {} },
	};
}

function writeGlobalConfig(home, server) {
	const dir = path.join(home, ".pi", "agent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "pi-irc.json"),
		JSON.stringify({ server: { host: "127.0.0.1", port: server, tls: false }, slug: "proj" }),
	);
}

test("no config: registers nothing, notifies once on session_start", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-home-"));
	const prev = process.env.HOME;
	process.env.HOME = home;
	// Identity derives the project slug from process.cwd() (the dir the
	// human started pi in) — so run this test "inside" the fixture project.
	const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-proj-")), "proj");
	fs.mkdirSync(proj);
	const prevCwd = process.cwd();
	process.chdir(proj);
	try {
		const pi = mockPi();
		extensionFactory(pi);
		assert.equal(pi.tools.length, 0, "no tool without config");
		const notes = [];
		fire(pi, "session_start", { type: "session_start", reason: "startup" }, {
			...makeCtx("/tmp/proj"),
			ui: { notify: (m) => notes.push(m) },
		});
		assert.equal(notes.length, 1);
		assert.match(notes[0], /extension disabled/);
	} finally {
		process.env.HOME = prev;
		process.chdir(prevCwd);
	}
});

test("enabled: boots against mock server, serves tool ops, wakes on DM, quits on shutdown", async () => {
	const srv = new MockIrcServer();
	const port = await srv.start();
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-home-"));
	writeGlobalConfig(home, port);
	const prev = process.env.HOME;
	process.env.HOME = home;
	// Identity derives the project slug from process.cwd() (the dir the
	// human started pi in) — so run this test "inside" the fixture project.
	const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-proj-")), "proj");
	fs.mkdirSync(proj);
	const prevCwd = process.cwd();
	process.chdir(proj);
	try {
		const pi = mockPi();
		extensionFactory(pi);
		assert.equal(pi.tools.length, 1, "exactly the irc tool");
		assert.equal(pi.tools[0].name, "irc");

		// Background bootstrap from session_start…
		fire(pi, "session_start", { type: "session_start", reason: "startup" }, makeCtx("/tmp/proj"));
		// …is awaited by the first tool call (pull, not block).
		const res = await pi.tools[0].execute("t1", { op: "status" }, undefined, undefined, makeCtx("/tmp/proj"));
		assert.match(res.content[0].text, /nick: pi-abcdef12/);
		assert.match(res.content[0].text, /projectChannel: #pi-proj/);
		const client = srv.lastClient();
		assert.ok(client.lines.some((l) => l.startsWith("JOIN #pi-proj")), "project channel joined");
		assert.match(client.user, /pi-agent project=proj role=main session=abcdef12/);

		// send flows through the queue to the mock server
		await pi.tools[0].execute("t2", { op: "send", text: "hello team" }, undefined, undefined, makeCtx("/tmp/proj"));
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(client.lines.some((l) => l.includes("PRIVMSG #pi-proj :hello team")));

		// DM wakes the agent as a steer
		srv.push(":carol!u@mock PRIVMSG pi-abcdef12 :status please");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(pi.userMessages.length, 1);
		assert.match(pi.userMessages[0].content, /direct message from carol: status please/);
		assert.equal(pi.userMessages[0].options?.deliverAs, "steer");

		// /irc slash command rides the same session
		assert.equal(pi.commands.length, 1);
		assert.equal(pi.commands[0].name, "irc");
		const notes = [];
		const cmdCtx = { ...makeCtx("/tmp/proj"), ui: { notify: (m, lvl) => notes.push([m, lvl]) } };
		await pi.commands[0].handler("send #pi-proj via slash command", cmdCtx);
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(client.lines.some((l) => l.includes("PRIVMSG #pi-proj :via slash command")));
		await pi.commands[0].handler("frobnicate", cmdCtx);
		assert.match(notes.at(-1)[0], /unknown subcommand/);
		assert.equal(notes.at(-1)[1], "warning");

		// shutdown is clean and single
		fire(pi, "session_shutdown", { type: "session_shutdown" }, makeCtx("/tmp/proj"));
		fire(pi, "session_shutdown", { type: "session_shutdown" }, makeCtx("/tmp/proj"));
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(client.lines.filter((l) => l.startsWith("QUIT")).length, 1);
	} finally {
		process.env.HOME = prev;
		await srv.stop();
	}
});

test("presence: agent_start marks AWAY, agent_settled returns", async () => {
	const srv = new MockIrcServer();
	const port = await srv.start();
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-home-"));
	writeGlobalConfig(home, port);
	const prev = process.env.HOME;
	process.env.HOME = home;
	const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-proj-")), "proj");
	fs.mkdirSync(proj);
	const prevCwd = process.cwd();
	process.chdir(proj);
	try {
		const pi = mockPi();
		extensionFactory(pi);
		fire(pi, "session_start", { type: "session_start", reason: "startup" }, makeCtx("/tmp/proj"));
		await pi.tools[0].execute("t1", { op: "status" }, undefined, undefined, makeCtx("/tmp/proj"));
		const client = srv.lastClient();
		client.lines = [];

		fire(pi, "agent_start", { type: "agent_start" }, makeCtx("/tmp/proj"));
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(
			client.lines.some((l) => /^AWAY :busy since /.test(l)),
			`AWAY sent on agent_start: ${client.lines}`,
		);

		client.lines = [];
		fire(pi, "agent_settled", { type: "agent_settled" }, makeCtx("/tmp/proj"));
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(client.lines.includes("AWAY"), `AWAY cleared on agent_settled: ${client.lines}`);

		fire(pi, "session_shutdown", { type: "session_shutdown" }, makeCtx("/tmp/proj"));
		await new Promise((r) => setTimeout(r, 50));
	} finally {
		process.env.HOME = prev;
		process.chdir(prevCwd);
		await srv.stop();
	}
});
