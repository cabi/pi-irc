// Integration: IrcSocket + IrcClient against a real loopback TCP mock
// server. Exercises framing across packet boundaries, full registration,
// 433 retry over the wire, JOIN/NAMES, PRIVMSG relay, and PING keepalive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";
import { MockIrcServer } from "./mock-irc-server.mjs";

const { IrcSocket } = await loadViaPi(repoFile("lib", "irc-socket.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

async function withServer(t, fn, opts = {}) {
	const server = new MockIrcServer();
	Object.assign(server, opts);
	const port = await server.start();
	t.after(() => server.stop());
	await fn(server, port);
}

function connectClient(port) {
	const socket = new IrcSocket();
	const client = new IrcClient(
		{
			nick: "pi-demo-m01",
			username: "pi",
			realname: "pi-agent project=demo role=main",
			pingTimeoutMs: 5000,
		},
		socket,
	);
	// Keep watchdog/timeouts from crashing the process when a test has no
	// explicit error listener.
	client.on("error", () => {});
	const done = socket.connect({ host: "127.0.0.1", port, tls: false, timeoutMs: 3000 });
	return { socket, client, done };
}

test("full handshake over real TCP: register, join, names, privmsg", async (t) => {
	await withServer(t, async (server, port) => {
		const { socket, client, done } = connectClient(port);
		t.after(() => client.quit("done"));
		await done;

		const registered = new Promise((r) => client.on("registered", r));
		const motdEnd = new Promise((r) => client.on("motdEnd", r));
		client.startRegistration();
		await registered;
		await motdEnd;
		assert.equal(client.state, "registered");

		const joined = new Promise((r) => client.on("join", (e) => e.self && r(e)));
		client.join(["#pi-demo"]);
		const ev = await joined;
		assert.equal(ev.channel, "#pi-demo");

		const gotPrivmsg = new Promise((r) => client.on("privmsg", r));
		server.push(":peer!pi@mock PRIVMSG #pi-demo :hello first agent");
		const pm = await gotPrivmsg;
		assert.deepEqual(pm, { from: "peer", target: "#pi-demo", text: "hello first agent", toSelf: false });

		const relayed = new Promise((r) => server.on("privmsg", r));
		client.privmsg("#pi-demo", "first agent reporting");
		assert.equal((await relayed).text, "first agent reporting");
		void socket;
	});
});

test("433 collision retry works over the wire", async (t) => {
	await withServer(
		t,
		async (server, port) => {
			const { client, done } = connectClient(port);
			t.after(() => client.quit("done"));
			await done;
			const registered = new Promise((r) => client.on("registered", r));
			client.startRegistration();
			await registered;
			assert.equal(client.realNick, "pi-demo-m01-a");
			const nicks = server.lastClient().lines.filter((l) => l.startsWith("NICK"));
			assert.deepEqual(nicks, ["NICK pi-demo-m01", "NICK pi-demo-m01-a"]);
		},
		{ rejectFirstNick: true },
	);
});

test("framing survives split packets, coalesced lines, and bare \\n", async (t) => {
	await withServer(t, async (server, port) => {
		const { socket, client, done } = connectClient(port);
		t.after(() => socket.destroy());
		await done;
		client.startRegistration();
		await new Promise((r) => client.on("registered", r));

		const messages = [];
		client.on("message", (m) => messages.push(m.command));

		// Coalesced two-in-one-packet, CRLF separated.
		server.lastClient().socket.write(":mock 001 x :one\r\n:mock 002 x :two\r\n");
		// One line split across two packets.
		server.lastClient().socket.write(":peer!pi@mock PRIVMSG #");
		server.lastClient().socket.write("pi-demo :split packet\n"); // bare LF
		await new Promise((r) => setTimeout(r, 50));

		assert.deepEqual(messages.slice(-3), ["001", "002", "PRIVMSG"]);
		const privmsg = client.listeners("privmsg").length; // sanity: handler attached below in other tests
		void privmsg;
	});
});

test("WHO round-trip returns the realname we registered with", async (t) => {
	await withServer(t, async (server, port) => {
		const { client, done } = connectClient(port);
		t.after(() => client.quit("done"));
		await done;
		client.startRegistration();
		await new Promise((r) => client.on("registered", r));

		const whoLines = [];
		client.on("message", (m) => {
			if (m.command === "352") whoLines.push(m);
		});
		client.who("#pi-demo");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(whoLines.length, 1);
		// WHO params: <me> <channel> <user> <host> <server> <nick> <flags> :<hop> <realname>
		// WHO trailing: "<hop> <realname>" — gecos is everything after the hop count.
		const [, ...gecos] = whoLines[0].params.at(-1).split(" ");
		assert.equal(gecos.join(" "), "pi-agent project=demo role=main");
		void server;
	});
});
