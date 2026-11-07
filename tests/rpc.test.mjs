import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const { parseEnvelope, formatAsk, formatReply, envelopeParts, ReplyAssembler, AskRegistry } =
	await jiti.import("../lib/rpc.ts");

test("parseEnvelope: ask with timeout", () => {
	const env = parseEnvelope("[pi-ask a1b2c3d4 timeout=600] Which API?");
	assert.deepEqual(
		{ kind: env.kind, id: env.id, timeoutSec: env.timeoutSec, body: env.body },
		{
			kind: "ask",
			id: "a1b2c3d4",
			timeoutSec: 600,
			body: "Which API?",
		},
	);
});

test("parseEnvelope: ask without timeout", () => {
	const env = parseEnvelope("[pi-ask deadbeef] question");
	assert.equal(env.kind, "ask");
	assert.equal(env.timeoutSec, undefined);
	assert.equal(env.body, "question");
});

test("parseEnvelope: reply with part markers", () => {
	const env = parseEnvelope("[pi-reply a1b2c3d4 part=2/3] chunk two");
	assert.equal(env.kind, "reply");
	assert.deepEqual(env.part, { i: 2, n: 3 });
	assert.equal(env.body, "chunk two");
});

test("parseEnvelope: rejects malformed and plain text", () => {
	assert.equal(parseEnvelope("plain text"), null);
	assert.equal(parseEnvelope("[pi-ask A1B2C3D4] upper-case id"), null); // not lowercase hex
	assert.equal(parseEnvelope("[pi-ask abc] short id"), null); // < 4 chars
	assert.equal(parseEnvelope("[pi-reply a1b2c3d4 part=3/2] i>n"), null);
	assert.equal(parseEnvelope("prefix [pi-ask a1b2c3d4] not at start"), null);
	assert.equal(parseEnvelope("[pi-ask a1b2c3d4 timeout=600]"), null, "empty body is plain text");
});

test("formatAsk/formatReply round-trip through parseEnvelope", () => {
	const ask = parseEnvelope(formatAsk("a1b2c3d4", 30, "Ship it?"));
	assert.equal(ask.kind, "ask");
	assert.equal(ask.timeoutSec, 30);
	assert.equal(ask.body, "Ship it?");
	const reply = parseEnvelope(formatReply("a1b2c3d4", "Yes.", { i: 1, n: 2 }));
	assert.deepEqual(reply.part, { i: 1, n: 2 });
	assert.equal(reply.body, "Yes.");
});

test("envelopeParts: short body is one message without part marker", () => {
	const parts = envelopeParts("reply", "a1b2c3d4", "short answer", 400);
	assert.equal(parts.length, 1);
	assert.equal(parseEnvelope(parts[0]).part, undefined);
});

test("envelopeParts: long reply chunks with markers, all under maxChunk, reassembles", () => {
	const body = "word ".repeat(400).trim(); // ~2000 chars
	const parts = envelopeParts("reply", "a1b2c3d4", body, 400);
	assert.ok(parts.length >= 5, `expected >=5 parts, got ${parts.length}`);
	const assembler = new ReplyAssembler();
	let joined = null;

	for (const p of parts) {
		const env = parseEnvelope(p);
		assert.ok(env, "every part must parse");
		assert.ok(p.length <= 400, `part too long: ${p.length}`);
		assert.equal(env.part.n, parts.length);
		joined = assembler.add("peer", env.id, env.part, env.body) ?? joined;
	}

	assert.equal(joined, body);
});

test("envelopeParts: ask carries timeout on every part", () => {
	const parts = envelopeParts("ask", "a1b2c3d4", "x".repeat(900), 400, 30);

	for (const p of parts) {
		const env = parseEnvelope(p);
		assert.equal(env.kind, "ask");
		assert.equal(env.timeoutSec, 30);
	}
});

test("ReplyAssembler: out-of-order parts complete exactly once", () => {
	const a = new ReplyAssembler();
	assert.equal(a.add("peer", "id1", { i: 2, n: 2 }, "two"), null);
	assert.equal(a.add("peer", "id1", { i: 2, n: 2 }, "two-dup"), null); // duplicate ignored (still missing 1)
	assert.equal(a.add("peer", "id1", { i: 1, n: 2 }, "one-"), "one-two");
	assert.equal(a.add("peer", "id1", { i: 1, n: 2 }, "one-"), null); // already consumed
});

test("ReplyAssembler: single-part reply passes through", () => {
	const a = new ReplyAssembler();
	assert.equal(a.add("peer", "id1", undefined, "just text"), "just text");
});

function fakeTimers() {
	const timers = [];

	return {
		timers,
		setTimer: (ms, fn) => {
			const handle = { ms, fn, fired: false };
			timers.push(handle);

			return handle;
		},
		clearTimer: (h) => {
			h.fired = true;
			const i = timers.indexOf(h);

			if (i >= 0) timers.splice(i, 1);
		},
		fire: (h) => h.fn(),
	};
}

function fakeClock() {
	let t = 1000;

	return { now: () => t, advance: (ms) => (t += ms) };
}

test("AskRegistry: reply resolves the waiting promise", async () => {
	const clock = fakeClock();
	const reg = new AskRegistry({ now: clock.now });
	const { id, done } = reg.trackOutbound("pi-worker-1", "Which port?", 60_000);
	assert.ok(/^[0-9a-f]{8}$/.test(id), "default id gen is 8 hex");
	clock.advance(150);
	assert.equal(reg.resolveReply(id, "16667"), true);
	const res = await done;
	assert.deepEqual(res, { status: "replied", id, peer: "pi-worker-1", reply: "16667", elapsedMs: 150 });
	assert.equal(reg.pendingOutbound().length, 0);
});

test("AskRegistry: timeout fires and late reply is rejected", async () => {
	const clock = fakeClock();
	const ft = fakeTimers();
	const reg = new AskRegistry({ now: clock.now, ...ft });
	const { id, done } = reg.trackOutbound("peer", "Q", 5_000);
	assert.equal(ft.timers.length, 1);
	clock.advance(5_000);
	ft.fire(ft.timers[0]);
	const res = await done;
	assert.equal(res.status, "timeout");
	assert.equal(reg.resolveReply(id, "too late"), false);
});

test("AskRegistry: dispose clears pending timers", () => {
	const ft = fakeTimers();
	const reg = new AskRegistry({ ...ft });
	reg.trackOutbound("peer", "Q", 5_000);
	assert.equal(ft.timers.length, 1);
	reg.dispose();
	assert.equal(ft.timers.length, 0);
});

test("AskRegistry: inbound lifecycle", () => {
	const reg = new AskRegistry();
	reg.trackInbound("abcd1234", "peer", "Which branch?");
	assert.equal(reg.pendingInbound().length, 1);
	assert.equal(reg.resolveInbound("abcd1234", "main"), true);
	assert.equal(reg.pendingInbound().length, 0);
	assert.equal(reg.resolveInbound("abcd1234", "again"), false, "double resolve rejected");
	assert.equal(reg.resolveInbound("ffff0000", "x"), false, "unknown id rejected");
});

test("AskRegistry: list returns newest first in both directions", () => {
	const clock = fakeClock();

	const reg = new AskRegistry({
		now: clock.now,
		idGen: (() => {
			let n = 0;

			return () => `id${++n}`;
		})(),
	});

	reg.trackOutbound("a", "q1", 1000);
	clock.advance(10);
	reg.trackOutbound("b", "q2", 1000);
	reg.trackInbound("x1", "c", "in1");
	const { outbound } = reg.list(10);
	assert.deepEqual(
		outbound.map((o) => o.id),
		["id2", "id1"],
	);
});

test("resolveReply: a reply from anyone but the asked peer is foreign text", () => {
	const reg = new AskRegistry();
	const { id } = reg.trackOutbound("pi-sub-9", "ready?", 60_000);
	assert.equal(reg.resolveReply(id, "yes", "mallory"), false, "wrong sender never answers");
	assert.equal(reg.resolveReply(id, "yes", "PI-SUB-9"), true, "casefolded match answers");
});

test("dispose(): waiting asks settle as disposed, not hang", async () => {
	const reg = new AskRegistry();
	const { id, done } = reg.trackOutbound("peer", "q", 60_000);
	reg.dispose();
	const res = await done;
	assert.equal(res.status, "disposed");
	assert.equal(res.id, id);
	reg.dispose(); // idempotent
});

test("registry caps: finished records evict at 256, waiting asks never", () => {
	const reg = new AskRegistry({ idGen: () => Math.random().toString(16).slice(2, 10) });

	for (let k = 0; k < 300; k++) {
		reg.trackInbound(`i${k}`, "p", `q${k}`);
		reg.resolveInbound(`i${k}`, "a");
	}

	assert.ok(reg.list(1000).inbound.length <= 256, `capped: ${reg.list(1000).inbound.length}`);
	const { id } = reg.trackOutbound("p", "q", 60_000);

	for (let k = 300; k < 400; k++) {
		reg.trackInbound(`i${k}`, "p", `q${k}`);
		reg.resolveInbound(`i${k}`, "a");
	}

	assert.equal(reg.resolveReply(id, "late-but-live", "p"), true, "waiting ask survived eviction pressure");
	reg.dispose();
});

test("ReplyAssembler: same id from two senders never interleaves", () => {
	const a = new ReplyAssembler();
	assert.equal(a.add("alice", "id7", { i: 1, n: 2 }, "A1-"), null);
	assert.equal(a.add("bob", "id7", { i: 2, n: 2 }, "B2"), null, "bob's tail does not complete alice's head");
	assert.equal(a.add("alice", "id7", { i: 2, n: 2 }, "A2"), "A1-A2");
	assert.equal(a.pendingCount(), 1, "bob's fragment still held");
});

test("ReplyAssembler: stale fragments expire (TTL) and floods evict (maxPending)", () => {
	let now = 1_000_000;
	const a = new ReplyAssembler({ now: () => now, ttlMs: 1000, maxPending: 4 });

	for (let k = 0; k < 3; k++) a.add("f", `id${k}`, { i: 1, n: 99 }, "x");
	assert.equal(a.pendingCount(), 3);
	now += 5000; // past TTL
	a.add("f", "fresh", { i: 1, n: 99 }, "x");
	assert.equal(a.pendingCount(), 1, `swept stale: ${a.pendingCount()}`);

	for (let k = 0; k < 6; k++) a.add("f", `fl${k}`, { i: 1, n: 99 }, "x");
	assert.equal(a.pendingCount(), 4, `bounded: ${a.pendingCount()}`);
});
