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
			return { target: target ?? "#pi-proj", text, chunks: 1, pending: 0 };
		},
		read: (o) => {
			state.readCalls.push(o);
			return [
				{ ts: 1_700_000_060_000, channel: "#pi-proj", from: "alice", text: "hi", kind: "channel" },
				{ ts: 1_700_000_120_000, channel: "carol", from: "carol", text: "dm!", kind: "dm" },
			].filter(
				(m) =>
					(!o.conv || m.channel === o.conv) &&
					(!o.from || m.from === o.from) &&
					(!o.since || m.ts >= o.since),
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
	await assert.rejects(
		() => executeIrcOp(ensureOf(fakeSession()), "send", { text: "   " }),
		/send requires text/,
	);
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
	await assert.rejects(
		() => executeIrcOp(ensureOf(fakeSession()), "join", {}),
		/join requires channels/,
	);
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
});
