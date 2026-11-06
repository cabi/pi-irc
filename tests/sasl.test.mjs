// SASL PLAIN: payload/chunk unit tests, then the full client flow against
// a fake transport — AUTHENTICATE interposed between the sasl ACK and
// CAP END, 903/907 releasing registration, 904/905/906 failing it, and
// the fail-closed guarantee when a configured server won't negotiate sasl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { saslPlainPayload, authChunks, SASL_MAX_CHUNK } = await loadViaPi(repoFile("lib", "sasl.ts"));
const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

// ---------------------------------------------------------------- unit

test("saslPlainPayload: empty authzid, NUL-separated, base64", () => {
	const expected = Buffer.from("\u0000josh\u0000PassW0rd", "utf8").toString("base64");
	assert.equal(saslPlainPayload("josh", "PassW0rd"), expected);
	// Multibyte passwords survive the round trip.
	const pw = "pä§w0rd✓";
	assert.equal(
		Buffer.from(saslPlainPayload("u", pw), "base64").toString("utf8"),
		`\u0000u\u0000${pw}`,
	);
});

test("authChunks: ≤400 chars per line, exact multiples end with a bare +", () => {
	const short = authChunks("abc");
	assert.deepEqual(short, ["abc"]);

	const b400 = "x".repeat(SASL_MAX_CHUNK);
	assert.deepEqual(authChunks(b400), [b400, "+"]); // exact multiple → "+"

	const b801 = "y".repeat(SASL_MAX_CHUNK * 2 + 1);
	const chunks = authChunks(b801);
	assert.equal(chunks.length, 3);
	assert.deepEqual(chunks.map((c) => c.length), [SASL_MAX_CHUNK, SASL_MAX_CHUNK, 1]);
	assert.equal(chunks.join(""), b801); // lossless
});

// ------------------------------------------------------------ client flow

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
	server(line) {
		this.emit("line", line);
	}
	sentLines(cmd) {
		return this.sent.filter((l) => l.startsWith(cmd));
	}
}

function makeClient(sasl = { username: "agent", password: "secret" }) {
	const t = new FakeTransport();
	const c = new IrcClient(
		{
			nick: "pi-demo-s1",
			username: "pi",
			realname: "pi-agent project=demo role=main",
			pingTimeoutMs: 60000,
			caps: ["server-time"],
			...(sasl ? { sasl } : {}),
		},
		t,
	);
	return { c, t };
}

/** Drive the negotiation up to (and including) the sasl ACK. */
function negotiateSasl(t, { offered = "server-time sasl" } = {}) {
	t.sent.length = 0;
	t.server(`:srv CAP * LS :${offered}`);
	t.server(":srv CAP * ACK :server-time sasl");
}

test("sasl in spec adds the cap and runs AUTHENTICATE before CAP END", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	// sasl was added to the wanted set automatically.
	assert.ok(t.sent.includes("CAP LS 302"));
	negotiateSasl(t);
	assert.deepEqual(t.sent, ["CAP REQ :server-time sasl", "AUTHENTICATE PLAIN"]);
	// Server invites the payload; client answers with the chunked base64.
	t.server("AUTHENTICATE +");
	const expected = saslPlainPayload("agent", "secret");
	assert.deepEqual(t.sent.slice(-1), [`AUTHENTICATE ${expected}`]);
	// 903 releases registration; 001 follows.
	t.server(":srv 900 pi-demo-s1 pi-demo-s1!pi@h agent :You are now logged in as agent");
	t.server(":srv 903 pi-demo-s1 :SASL authentication successful");
	assert.ok(t.sent.includes("CAP END"));
	t.server(":srv 001 pi-demo-s1 :Welcome");
	assert.equal(c.state, "registered");
});

test("long payloads are chunked to ≤400-char AUTHENTICATE lines", () => {
	const { c, t } = makeClient({ username: "agent", password: "p".repeat(500) });
	c.startRegistration();
	negotiateSasl(t);
	t.server("AUTHENTICATE +");
	const authLines = t.sentLines("AUTHENTICATE").filter((l) => l !== "AUTHENTICATE PLAIN" && l !== "AUTHENTICATE +");
	assert.equal(authLines.length, 2);
	assert.ok(authLines.every((l) => l.length <= "AUTHENTICATE ".length + 400));
	assert.equal(authLines.map((l) => l.slice("AUTHENTICATE ".length)).join(""), saslPlainPayload("agent", "p".repeat(500))); // lossless
});

test("904 SASL failure surfaces an error and destroys the transport", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	c.startRegistration();
	negotiateSasl(t);
	t.server("AUTHENTICATE +");
	t.server(":srv 904 pi-demo-s1 :SASL authentication failed");
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /SASL failed/);
	assert.equal(t.destroyed, true);
	assert.equal(c.state !== "registered", true);
	assert.ok(!t.sent.includes("CAP END"));
});

test("907 already-authenticated counts as success (CAP END still sent)", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	negotiateSasl(t);
	t.server("AUTHENTICATE +");
	t.server(":srv 907 pi-demo-s1 :You have already authenticated");
	assert.ok(t.sent.includes("CAP END"));
	t.server(":srv 001 pi-demo-s1 :Welcome");
	assert.equal(c.state, "registered");
});

test("server abort (AUTHENTICATE *) fails the registration", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	c.startRegistration();
	negotiateSasl(t);
	t.server("AUTHENTICATE *");
	assert.equal(t.destroyed, true);
	assert.match(errors[0].message, /aborted SASL/);
});

test("fail closed: server without sasl in CAP LS never registers anonymously", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	c.startRegistration();
	t.sent.length = 0;
	t.server(":srv CAP * LS :server-time extended-join");
	t.server(":srv CAP * ACK :server-time extended-join");
	assert.equal(t.destroyed, true);
	assert.match(errors[0].message, /will not negotiate sasl/);
	assert.ok(!t.sent.includes("CAP END"));
});

test("fail closed: RFC 2812-only server (410) with auth configured", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	c.startRegistration();
	t.server(":srv 410 pi-demo-s1 CAP :Unknown command");
	assert.equal(t.destroyed, true);
	assert.match(errors[0].message, /will not negotiate sasl/);
});

test("fail closed: sasl NAKed in per-cap fallback", () => {
	const { c, t } = makeClient();
	const errors = [];
	c.on("error", (e) => errors.push(e));
	c.startRegistration();
	t.sent.length = 0;
	// Batch REQ bounced → per-cap fallback; sasl alone is refused.
	t.server(":srv CAP * LS :server-time sasl");
	t.server(":srv CAP * NAK :server-time sasl");
	t.server(":srv CAP * ACK :server-time");
	t.server(":srv CAP * NAK :sasl");
	assert.equal(t.destroyed, true);
	assert.match(errors[0].message, /will not negotiate sasl/);
});

test("no auth configured: a sasl-less world keeps working (no AUTHENTICATE)", () => {
	const { c, t } = makeClient(null);
	c.startRegistration();
	t.sent.length = 0;
	t.server(":srv CAP * LS :server-time");
	t.server(":srv CAP * ACK :server-time");
	assert.ok(t.sent.includes("CAP END"));
	assert.ok(t.sentLines("AUTHENTICATE").length === 0);
	t.server(":srv 001 pi-demo-s1 :Welcome");
	assert.equal(c.state, "registered");
});

test("reconnect (attach) re-runs the full SASL exchange", () => {
	const { c, t } = makeClient();
	c.startRegistration();
	negotiateSasl(t);
	t.server("AUTHENTICATE +");
	t.server(":srv 903 pi-demo-s1 :SASL authentication successful");
	t.server(":srv 001 pi-demo-s1 :Welcome");
	assert.equal(c.state, "registered");

	// Transport dies; a fresh one attaches.
	const t2 = new FakeTransport();
	c.attach(t2);
	c.startRegistration();
	t2.server(":srv CAP * LS :server-time sasl");
	t2.server(":srv CAP * ACK :server-time sasl");
	assert.ok(t2.sent.includes("AUTHENTICATE PLAIN"));
	t2.server("AUTHENTICATE +");
	t2.server(":srv 903 pi-demo-s1 :SASL authentication successful");
	t2.server(":srv 001 pi-demo-s1 :Welcome");
	assert.equal(c.state, "registered");
	assert.equal(t2.sentLines("AUTHENTICATE").length, 2); // PLAIN + payload
});
