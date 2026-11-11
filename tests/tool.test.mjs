// The `irc` tool dispatcher: every op against a fake session, plus the
// guard rails (project channel cannot be parted, send requires text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { executeIrcOp } = await loadViaPi(repoFile("lib", "tool.ts"));

function fakeSession(over = {}) {
	const state = {
		client: { nick: "pi-main-abcd1234", realNick: "pi-main-abcd1234" },
		projectChannel: "#pi-proj",
		channels: { list: () => ["#pi-proj"] },
		rosterView: () => [
			{ nick: "pi-main-abcd1234", kind: "agent", role: "main", project: "proj", session: "abcd1234", self: true },
			{ nick: "carol", kind: "human" },
		],
		status: () => ({
			nick: "pi-main-abcd1234",
			role: "main",
			projectChannel: "#pi-proj",
			channels: ["#pi-proj"],
			unread: { "#pi-proj": 2, carol: 1 },
		}),
		send: (target, text) => {
			state.sent.push([target ?? "#pi-proj", text]);

			return { target: target ?? "#pi-proj", text, messages: 1, lines: 1, truncated: 0, pending: 0 };
		},
		read: (o) => {
			state.readCalls.push(o);

			return [
				{ ts: 1_700_000_060_000, channel: "#pi-proj", from: "alice", text: "hi", kind: "channel" },
				{ ts: 1_700_000_120_000, channel: "carol", from: "carol", text: "dm!", kind: "dm" },
			].filter(
				(m) => (!o.conv || m.channel === o.conv) && (!o.from || m.from === o.from) && (!o.since || m.ts >= o.since),
			);
		},
		join: (names) => state.joined.push(...names),
		part: (names) => state.parted.push(...names),
		...over,
	};

	state.sent = [];
	state.readCalls = [];
	state.joined = [];
	state.parted = [];

	return state;
}

const ensureOf = (s) => async () => s;

test("unknown op throws with the legal ops listed", async () => {
	await assert.rejects(
		() => executeIrcOp(ensureOf(fakeSession()), "dance", {}),
		/unknown op "dance" — use one of: connect/,
	);
});

test("help names the session and every op", async () => {
	const r = await executeIrcOp(ensureOf(fakeSession()), "help", {});
	assert.match(r.content[0].text, /irc — you are pi-main-abcd1234 on #pi-proj/);

	for (const op of ["connect", "status", "roster", "send", "read", "join", "part"]) {
		assert.ok(r.content[0].text.includes(op), `help mentions ${op}`);
	}
});

test("status flattens the status object to key: value lines", async () => {
	const r = await executeIrcOp(ensureOf(fakeSession()), "status", {});
	assert.match(r.content[0].text, /nick: pi-main-abcd1234/);
	assert.match(r.content[0].text, /projectChannel: #pi-proj/);
});

test("roster marks agents and humans", async () => {
	const r = await executeIrcOp(ensureOf(fakeSession()), "roster", {});
	const t = r.content[0].text;
	assert.match(t, /pi-main-abcd1234 agent main project=proj session=abcd1234 \(me\)/);
	assert.match(t, /carol human/);
});

test("send defaults to the project channel", async () => {
	const s = fakeSession();
	const r = await executeIrcOp(ensureOf(s), "send", { text: "hello team" });
	assert.deepEqual(s.sent, [["#pi-proj", "hello team"]]);
	assert.match(r.content[0].text, /sent to #pi-proj \(project channel\)/);
});

test("send without text fails fast", async () => {
	await assert.rejects(() => executeIrcOp(ensureOf(fakeSession()), "send", { text: "   " }), /send requires text/);
});

test("send: reports channel-cap truncation loudly to the agent", async () => {
	const s = fakeSession({
		send: (target, text) => ({
			target: target ?? "#pi-proj",
			text,
			messages: 11,
			lines: 35,
			truncated: 25,
			pending: 0,
		}),
	});

	const r = await executeIrcOp(ensureOf(s), "send", { text: "long paste" });
	assert.match(r.content[0].text, /sent to #pi-proj/);
	assert.match(r.content[0].text, /25 of 35 lines truncated \(channel cap\)/);
});

test("read formats channel lines and DM lines differently", async () => {
	const s = fakeSession();
	const r = await executeIrcOp(ensureOf(s), "read", {});
	const [a, b] = r.content[0].text.split("\n");
	assert.match(a, /#pi-proj <alice> hi$/);
	assert.match(b, /^\d\d:\d\d \(dm\) carol <carol> dm!$/);
	assert.deepEqual(s.readCalls, [{ conv: undefined, from: undefined, since: undefined, limit: undefined }]);
});

test("read passes filters through", async () => {
	const s = fakeSession();
	await executeIrcOp(ensureOf(s), "read", { conversation: "carol", from: "carol", since: 1, limit: 5 });
	assert.deepEqual(s.readCalls, [{ conv: "carol", from: "carol", since: 1, limit: 5 }]);
});

test("read reports nothing unread", async () => {
	const s = fakeSession({ read: () => [] });
	const r = await executeIrcOp(ensureOf(s), "read", {});
	assert.equal(r.content[0].text, "nothing unread");
});

test("join forwards channel names", async () => {
	const s = fakeSession();
	const r = await executeIrcOp(ensureOf(s), "join", { channels: [" #pi-ops ", "#pi-dev"] });
	assert.deepEqual(s.joined, ["#pi-ops", "#pi-dev"]);
	assert.match(r.content[0].text, /joining #pi-ops, #pi-dev/);
});

test("join without channels fails", async () => {
	await assert.rejects(() => executeIrcOp(ensureOf(fakeSession()), "join", {}), /join requires channels/);
});

test("part refuses to drop the project channel but parts the rest", async () => {
	const s = fakeSession();
	const r = await executeIrcOp(ensureOf(s), "part", { channels: ["#pi-ops", "#pi-PROJ"] });
	assert.deepEqual(s.parted, ["#pi-ops"]);
	assert.match(r.content[0].text, /kept #pi-PROJ/);
});

test("part of only the project channel fails", async () => {
	await assert.rejects(
		() => executeIrcOp(ensureOf(fakeSession()), "part", { channels: ["#pi-proj"] }),
		/project channel cannot be parted/,
	);
});

test("connect reports nick, project channel, and channel count", async () => {
	const r = await executeIrcOp(ensureOf(fakeSession()), "connect", {});
	assert.match(r.content[0].text, /connected as pi-main-abcd1234 in #pi-proj \(1 channels\)/);

	test("ask requires peer and text", async () => {
		await assert.rejects(
			() => executeIrcOp(ensureOf(fakeSession()), "ask", { text: "hi?" }),
			/ask requires peer and text/,
		);
	});

	test("ask renders a replied resolution", async () => {
		const s = fakeSession({
			ask: async (_peer, question) => ({
				status: "replied",
				id: "x1",
				peer: "pi-sub-b2",
				reply: `re: ${question}`,
				elapsedMs: 5,
			}),
		});

		const r = await executeIrcOp(ensureOf(s), "ask", { peer: "pi-sub-b2", text: "which branch?" });
		assert.match(r.content[0].text, /pi-sub-b2 replied: re: which branch\?/);
	});

	test("ask renders a timeout with guidance", async () => {
		const s = fakeSession({
			ask: async () => ({ status: "timeout", id: "x2", peer: "carol", question: "there?", timeoutMs: 5_000 }),
		});

		const r = await executeIrcOp(ensureOf(s), "ask", { peer: "carol", text: "there?", timeout: 5 });
		assert.match(r.content[0].text, /no answer from carol within 5s/);
		assert.match(r.content[0].text, /still visible/);
	});

	test("reply without id lists open asks", async () => {
		const s = fakeSession({
			rpc: {
				pendingInbound: () => [{ id: "a1", peer: "carol", question: "deploy?", receivedAt: 1 }],
				pendingOutbound: () => [],
			},
		});

		await assert.rejects(
			() => executeIrcOp(ensureOf(s), "reply", { text: "yes" }),
			/reply requires id and text[\s\S]*id=a1 from carol: deploy\?/,
		);
	});

	test("reply forwards id and text to the session", async () => {
		const s = fakeSession({
			reply: (id, text) => ({ id, to: "carol", parts: 1, text }),
		});

		const r = await executeIrcOp(ensureOf(s), "reply", { id: "a1", text: "ship it" });
		assert.match(r.content[0].text, /replied to carol \(ask id=a1\)/);
	});

	test("pending lists both directions", async () => {
		const s = fakeSession({
			rpc: {
				pendingInbound: () => [{ id: "a1", peer: "carol", question: "deploy?", receivedAt: 1 }],
				pendingOutbound: () => [
					{ id: "x9", peer: "pi-sub-b2", question: "branch?", sentAt: 1, timeoutMs: 1000, state: "waiting" },
				],
			},
		});

		const r = await executeIrcOp(ensureOf(s), "pending", {});
		assert.match(r.content[0].text, /asks to answer \(1\):[\s\S]*id=a1 from carol: deploy\?/);
		assert.match(r.content[0].text, /asks you sent \(1\):[\s\S]*id=x9 to pi-sub-b2: branch\?/);
	});
});

test("mark flushes cursors and reports counts; empty stays quiet", async () => {
	const s = fakeSession({ mark: (conv) => (conv ? { "#pi-proj": 3 } : { "#pi-proj": 3, carol: 1 }) });
	const one = await executeIrcOp(ensureOf(s), "mark", { conversation: "#pi-proj" });
	assert.match(one.content[0].text, /^marked #pi-proj read \(3 messages: #pi-proj\)$/);
	const all = await executeIrcOp(ensureOf(s), "mark", {});
	assert.match(all.content[0].text, /^marked all conversations read \(4 messages: #pi-proj, carol\)$/);
	const empty = await executeIrcOp(ensureOf(fakeSession({ mark: () => ({}) })), "mark", {});
	assert.equal(empty.content[0].text, "nothing unread to mark");
});
