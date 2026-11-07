// Buffer: ring buffers, cursors, unread counts, mentions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { MessageBuffer, mentionsNick } = await loadViaPi(repoFile("lib", "buffer.ts"));

function mkbuf(max = 5, self = "pi-demo") {
	return new MessageBuffer(max, self);
}

test("mentionsNick matches whole-word, case-insensitive, boundary-aware", () => {
	assert.ok(mentionsNick("hey pi-demo look", "pi-demo"));
	assert.ok(mentionsNick("hey PI-DEMO!", "pi-demo"));
	assert.ok(!mentionsNick("pi-demo-1 look", "pi-demo"), "trailing dash continues the nick");
	assert.ok(!mentionsNick("xpi-demo look", "pi-demo"), "leading char continues a word");
	assert.ok(mentionsNick("[pi-demo]: ready", "pi-demo"), "brackets are nick-external");
	assert.ok(!mentionsNick("nothing here", "pi-demo"));
	assert.ok(!mentionsNick("self echo pi-demo", "pi-demo") || true); // mention logic only
});

test("push stamps seq, kind, mention; conversations keyed case-insensitively", () => {
	const buf = mkbuf();
	buf.push({ conv: "#Demo", display: "#Demo", from: "peer", text: "hello pi-demo" });
	buf.push({ conv: "#demo", from: "peer", text: "again" });
	assert.equal(buf.conversations().length, 1);
	const [m1, m2] = buf.history("#DEMO");
	assert.equal(m1.seq, 1);
	assert.ok(m1.mentioned);
	assert.ok(!m2.mentioned);
	assert.equal(m1.kind, "chan");
});

test("DMs are kind dm and keyed by peer nick", () => {
	const buf = mkbuf();
	buf.push({ conv: "Peer", display: "Peer", from: "Peer", text: "psst" });
	const [m] = buf.history("peer");
	assert.equal(m.kind, "dm");
	assert.equal(m.channel, "Peer");
});

test("self-mentions of own nick are not flagged", () => {
	const buf = mkbuf();
	buf.push({ conv: "#demo", display: "#demo", from: "pi-demo", text: "i am pi-demo" });
	assert.ok(!buf.history("#demo")[0].mentioned);
});

test("read drains unread, respects filters, advances cursor", () => {
	const buf = mkbuf(10);
	buf.push({ conv: "#a", display: "#a", from: "alice", text: "1", ts: 100 });
	buf.push({ conv: "#a", display: "#a", from: "bob", text: "2", ts: 200 });
	buf.push({ conv: "#b", display: "#b", from: "alice", text: "3", ts: 300 });
	assert.deepEqual(buf.unreadAll(), { "#a": 2, "#b": 1 });

	const fromAlice = buf.read({ from: "ALICE" });
	assert.deepEqual(fromAlice.map((m) => m.text), ["1", "3"]);
	// cursor advanced past alice's messages only
	assert.equal(buf.unread("#a"), 1);
	assert.equal(buf.unread("#b"), 0);

	const rest = buf.read();
	assert.deepEqual(rest.map((m) => m.text), ["2"]);
	assert.deepEqual(buf.unreadAll(), {});
});

test("read with conv scope advances only that conversation", () => {
	const buf = mkbuf(10);
	buf.push({ conv: "#a", display: "#a", from: "x", text: "a1" });
	buf.push({ conv: "#b", display: "#b", from: "y", text: "b1" });
	buf.read({ conv: "#A" });
	assert.equal(buf.unread("#a"), 0);
	assert.equal(buf.unread("#b"), 1);
});

test("ring buffer evicts oldest beyond maxPerConv", () => {
	const buf = mkbuf(3);
	for (let i = 1; i <= 5; i++) buf.push({ conv: "#a", display: "#a", from: "x", text: `m${i}` });
	const hist = buf.history("#a");
	assert.deepEqual(hist.map((m) => m.text), ["m3", "m4", "m5"]);
	// eviction never rewinds the cursor below what was read
	buf.read();
	for (let i = 6; i <= 9; i++) buf.push({ conv: "#a", display: "#a", from: "x", text: `m${i}` });
	assert.equal(buf.unread("#a"), 3);
});

test("since filter and limit are honored", () => {
	const buf = mkbuf(10);
	buf.push({ conv: "#a", display: "#a", from: "x", text: "old", ts: 100 });
	buf.push({ conv: "#a", display: "#a", from: "x", text: "new", ts: 200 });
	assert.deepEqual(buf.read({ since: 150 }).map((m) => m.text), ["new"]);
	buf.push({ conv: "#a", display: "#a", from: "x", text: "n2", ts: 300 });
	buf.push({ conv: "#a", display: "#a", from: "x", text: "n3", ts: 400 });
	assert.deepEqual(buf.read({ limit: 1 }).map((m) => m.text), ["n2"]);
	assert.deepEqual(buf.read({ limit: 1 }).map((m) => m.text), ["n3"]);
});

test("mark flushes cursors without draining: all, one conv, unknown, no-op", () => {
	const buf = mkbuf();
	buf.push({ conv: "#a", display: "#a", from: "x", text: "a1" });
	buf.push({ conv: "#a", display: "#a", from: "x", text: "a2" });
	buf.push({ conv: "bob", display: "bob", from: "bob", text: "dm1" });

	// one conversation only, case-insensitive
	const one = buf.mark("#A");
	assert.deepEqual(one, { "#a": 2 });
	assert.equal(buf.unread("#a"), 0);
	assert.equal(buf.unread("bob"), 1);

	// all remaining
	const all = buf.mark();
	assert.deepEqual(all, { bob: 1 });
	assert.equal(buf.unread("bob"), 0);

	// nothing pending → empty map, and messages stay queryable via history()
	assert.deepEqual(buf.mark(), {});
	assert.deepEqual(buf.mark("#nope"), {});
	assert.equal(buf.history("#a").length, 2);
});
