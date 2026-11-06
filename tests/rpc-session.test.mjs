// P6: ask/reply envelope round-trip between two real sessions over a mock
// IRC server. The router wires client→client PRIVMSG routing the mock lacks.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { MockIrcServer } from "./mock-irc-server.mjs";

const jiti = createJiti(import.meta.url);
const { IrcSession } = await jiti.import("../lib/session.ts");

function cfg(port, nick) {
	return {
		server: { host: "127.0.0.1", port, tls: false },
		nick: { template: nick, maxLen: 30 },
		channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}" },
		capabilities: { request: [] },
		delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
		projectSlug: "proj",
	};
}

async function boot(srv, nick, shortId) {
	const s = await IrcSession.connect(cfg(srv.address?.().port ?? port, nick), { project: "proj", role: "main", shortId });
	return s;
}

let port; // set in suite; the helper above uses the closure

// Route inter-agent PRIVMSGs through the mock so sessions really talk.
function route(srv) {
	srv.on("privmsg", ({ client, target, text }) => {
		if (target.startsWith("#")) return;
		const idx = srv.clients.findIndex((c) => c.nick === target);
		if (idx >= 0 && idx !== srv.clients.indexOf(client))
			srv.push(`:${client.nick}!pi@mock PRIVMSG ${target} :${text}`, idx);
	});
}

test("ask/reply: full round-trip between two sessions", async () => {
	const srv = new MockIrcServer();
	port = await srv.start();
	route(srv);
	const alice = await boot(srv, "pi-alice", "a1");
	const bob = await boot(srv, "pi-bob", "b2");
	try {
		const wakes = [];
		bob.on("wake", (w) => wakes.push(w));
		const aliceWakes = [];
		alice.on("wake", (w) => aliceWakes.push(w));

		const answer = alice.ask("pi-bob", "Which port?", 20);
		await new Promise((r) => setTimeout(r, 80));

		// Bob buffered the ask with the reply instruction and was woken.
		const ask = bob.read({ limit: 5 }).find((m) => m.kind === "ask");
		assert.ok(ask, "ask buffered");
		assert.match(ask.text, /Which port\? \[ask id=([0-9a-z]+) — reply with: irc reply id=\1\]/);
		assert.equal(wakes.length, 1, "ask wakes the target");
		const id = ask.text.match(/id=([0-9a-z]+)/)[1];

		// Bob answers; Alice's promise resolves with the text.
		const sent = bob.reply(id, "port 6667");
		assert.equal(sent.to, "pi-alice");
		assert.equal(sent.parts, 1);
		const res = await answer;
		assert.equal(res.status, "replied");
		assert.equal(res.reply, "port 6667");
		assert.equal(res.peer, "pi-bob");
		assert.equal(res.id, id);

		// Alice buffers the reply under Bob's nick, kind reply, no wake.
		const replyMsg = alice.read({ limit: 5 }).find((m) => m.kind === "reply");
		assert.equal(replyMsg?.text, "port 6667");
		assert.equal(replyMsg?.from, "pi-bob");
		assert.equal(aliceWakes.length, 0, "resolved reply does not wake the asker");

		// Second reply to the same id is rejected.
		assert.throws(() => bob.reply(id, "again"), /already-answered|unknown/);
	} finally {
		alice.stop();
		bob.stop();
		await srv.stop();
	}
});

test("ask/reply: timeout on silent peer, late reply surfaces as DM", async () => {
	const srv = new MockIrcServer();
	port = await srv.start();
	route(srv);
	const alice = await boot(srv, "pi-alice", "a1");
	const bob = await boot(srv, "pi-bob", "b2");
	try {
		const t0 = Date.now();
		const res = await alice.ask("pi-bob", "anyone?", 1);
		assert.equal(res.status, "timeout");
		assert.ok(Date.now() - t0 >= 900, "waited ~1s");

		// The ask is still buffered on Bob; he answers late.
		const ask = bob.read({ limit: 5 }).find((m) => m.kind === "ask");
		assert.ok(ask, "late-answered ask still buffered");
		const id = ask.text.match(/id=([0-9a-z]+)/)[1];
		bob.reply(id, "sorry, was busy");

		await new Promise((r) => setTimeout(r, 60));
		// Alice: no resolution object (ask already timed out), but the text
		// arrives as a wakeable DM so nothing is lost.
		const dm = alice.read({ limit: 5 }).find((m) => m.kind === "dm" && m.text.includes("sorry"));
		assert.ok(dm, "late reply visible as DM");
	} finally {
		alice.stop();
		bob.stop();
		await srv.stop();
	}
});

test("ask/reply: multi-part reply reassembles exactly", async () => {
	const srv = new MockIrcServer();
	port = await srv.start();
	route(srv);
	const alice = await boot(srv, "pi-alice", "a1");
	const bob = await boot(srv, "pi-bob", "b2");
	try {
		const body = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
		const answer = alice.ask("pi-bob", "list 120 words", 20);
		await new Promise((r) => setTimeout(r, 80));
		const id = bob.read({ limit: 5 }).find((m) => m.kind === "ask").text.match(/id=([0-9a-z]+)/)[1];
		const sent = bob.reply(id, body);
		assert.ok(sent.parts > 1, "split into parts");
		const res = await answer;
		assert.equal(res.status, "replied");
		assert.equal(res.reply, body);
	} finally {
		alice.stop();
		bob.stop();
		await srv.stop();
	}
});
