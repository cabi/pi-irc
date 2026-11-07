// Delivery: flood control, chunking, queue behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { DeliveryQueue, chunkText } = await loadViaPi(repoFile("lib", "delivery.ts"));

function mkqueue(sends, opts = {}) {
	return new DeliveryQueue(
		(target, text) => sends.push({ target, text }),
		{ burst: 3, intervalMs: 1000, maxChunk: 20, chunkLong: true, ...opts },
	);
}

test("chunkText splits at word boundaries and stamps nothing itself", () => {
	assert.deepEqual(chunkText("short", 20), ["short"]);
	const pieces = chunkText("aaaa bbbb cccc dddd eeee", 10);
	assert.ok(pieces.every((p) => p.length <= 10), JSON.stringify(pieces));
	assert.equal(pieces.join(" "), "aaaa bbbb cccc dddd eeee");
	// Hard split when no space helps.
	assert.deepEqual(chunkText("abcdefghijklmnop", 8), ["abcdefgh", "ijklmnop"]);
});

test("sender throwing WireError drops the chunk instead of blocking the queue", async () => {
	const { WireError } = await loadViaPi(repoFile("lib", "wire.ts"));
	const sends = [];
	const drops = [];
	const q = new DeliveryQueue(
		(target, text) => {
			if (text === "POISON") throw new WireError("line too long");
			sends.push(text);
		},
		{ burst: 10, intervalMs: 1000, maxChunk: 400, chunkLong: false },
	);
	q.onDrop = (t, text, err) => drops.push({ t, text, err: err.message });
	q.enqueue("#c", "POISON");
	q.enqueue("#c", "after-poison");
	q.drain(0);
	assert.deepEqual(sends, ["after-poison"], "queue keeps flowing past the poisoned head");
	assert.equal(drops.length, 1);
	assert.equal(drops[0].err, "line too long");
});

test("chunkText refuses absurd maxChunk", () => {
	assert.throws(() => chunkText("x", 4));
});

test("chunkText is byte-aware: CJK and emoji fit the byte budget", () => {
	// 200 CJK chars = 600 UTF-8 bytes; budget 60 bytes → each part must fit.
	const cjk = "日本語".repeat(80);
	const parts = chunkText(cjk, 60);
	assert.ok(parts.length > 1, "should split");
	assert.ok(parts.every((p) => Buffer.byteLength(p, "utf8") <= 60), JSON.stringify(parts));
	assert.equal(parts.join(""), cjk, "lossless reassembly (no spaces to drop)");

	// Emoji are surrogate pairs (4 bytes) — never split mid-pair.
	const emoji = "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀";
	const ep = chunkText(emoji, 24); // 6 emoji per chunk
	assert.ok(ep.every((p) => Buffer.byteLength(p) <= 24));
	assert.ok(ep.every((p) => !/[\ud800-\udbff]$/.test(p)), "no dangling high surrogate");
	assert.equal(ep.join(""), emoji);

	// Mixed content still prefers word boundaries when bytes allow.
	const mixed = "hello world 你好世界 hello world";
	const mp = chunkText(mixed, 20);
	assert.ok(mp.every((p) => Buffer.byteLength(p) <= 20));
});

test("burst allows N immediate sends, then throttles", () => {
	const sends = [];
	const q = mkqueue(sends);
	for (let i = 0; i < 5; i++) q.enqueue("#chan", `m${i}`);
	assert.equal(q.pending(), 5);

	let out = q.drain(0);
	assert.equal(out.length, 3, "burst of 3");
	out = q.drain(1); // 1ms later: no tokens yet
	assert.equal(out.length, 0);
	out = q.drain(1000); // one interval: one token
	assert.equal(out.length, 1);
	assert.equal(out.at(-1).text, "m3");
	out = q.drain(3500); // 2.5 intervals since 1000: two tokens
	assert.equal(out.length, 1);
	assert.equal(q.pending(), 0);
	assert.equal(sends.length, 5);
});

test("long messages chunk and drain in order with part markers", () => {
	const sends = [];
	const q = mkqueue(sends, { burst: 10 });
	q.enqueue("#chan", "one two three four five six"); // 27 chars → 2+ chunks @20
	const out = q.drain(0);
	assert.ok(out.length >= 2);
	assert.deepEqual(out.map((c) => c.part?.i), [1, 2]);
	assert.equal(out[0].part.n, out.length);
	// Reassembly equals the original (modulo split-space normalization).
	assert.equal(
		out.map((c) => c.text).join(" ").replace(/\s+/g, " "),
		"one two three four five six",
	);
});

test("chunking can be disabled", () => {
	const sends = [];
	const q = mkqueue(sends, { burst: 5, chunkLong: false });
	q.enqueue("#chan", "x".repeat(50));
	const out = q.drain(0);
	assert.equal(out.length, 1);
	assert.equal(out[0].text.length, 50);
	assert.equal(out[0].part, undefined);
});

test("clear drops pending work; start/stop manage the timer", () => {
	const sends = [];
	const q = mkqueue(sends);
	q.enqueue("#chan", "never sent");
	q.clear();
	assert.equal(q.pending(), 0);
	assert.equal(q.drain(0).length, 0);
	q.start();
	q.stop(); // no throw, no dangling timer
});

test("pause holds the queue; resume flushes it; a dead sender keeps chunks queued", () => {
	const sends = [];
	let dead = false;
	const q = new DeliveryQueue((t, x) => {
		if (dead) throw new Error("send on closed socket");
		sends.push(`${t}:${x}`);
	});
	q.pause();
	q.enqueue("#chan", "while down 1");
	q.enqueue("#chan", "while down 2");
	assert.equal(q.drain(0).length, 0); // paused: nothing leaves
	assert.equal(q.pending(), 2);

	q.resume(); // unpause + immediate flush
	assert.deepEqual(sends, ["#chan:while down 1", "#chan:while down 2"]);
	assert.equal(q.pending(), 0);

	dead = true;
	q.enqueue("#chan", "mid-drain death");
	assert.equal(q.drain(0).length, 0); // sender threw...
	assert.equal(q.pending(), 1); // ...but the chunk survives for reconnect
	dead = false;
	assert.equal(q.drain(0).length, 1); // and goes out once the link is back
});

test("enqueue: queue bound throws instead of growing without limit", () => {
	const out = [];
	const q = new DeliveryQueue((t, x) => out.push(`${t}:${x}`), {
		burst: 1,
		intervalMs: 1000,
		maxChunk: 20,
		chunkLong: true,
		maxQueue: 3,
	});
	q.enqueue("a", "one"); // 1 chunk
	q.enqueue("a", "two"); // 1
	q.enqueue("a", "three"); // 1 — at the bound now
	assert.throws(() => q.enqueue("a", "four"), /delivery queue full/);
	assert.equal(q.pending(), 3, "the three queued chunks are intact");
});

test("partial options fall back to defaults — no NaN pacer timer", async () => {
	// Regression (P17 live drill): a raw config (tests, smokes) can omit the
	// whole flood section; undefined must not reach setInterval as NaN
	// (NaN coerces to a 1 ms busy timer — surfaced as TimeoutNaNWarning).
	const warnings = [];
	const onWarn = (w) => warnings.push(w.name);
	process.on("warning", onWarn);
	try {
		const sent = [];
		const q = new DeliveryQueue((t, x) => sent.push(x));
		q.start();
		assert.equal(q.enqueue("a", "one"), 1);
		assert.equal(q.enqueue("a", "two"), 1);
		q.drain(); // defaults pace the timer at 500 ms — drain due sends now
		q.stop();
		assert.deepEqual(sent, ["one", "two"], "burst defaults (4) send immediately");
		assert.equal(q.pending(), 0);
	} finally {
		process.off("warning", onWarn);
	}
	assert.deepEqual(warnings, [], `no timer warnings, got: ${warnings.join(", ")}`);
});
