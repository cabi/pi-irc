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

test("chunkText refuses absurd maxChunk", () => {
	assert.throws(() => chunkText("x", 4));
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
