/**
 * P18 live drill: per-agent channel wakes against a real server (default:
 * the operator's ergo over TLS with the pinned cert).
 *
 *   node scripts/wake-channel-smoke.mjs
 *   IRC_HOST=127.0.0.1 IRC_PORT=16667 IRC_TLS=0 node scripts/wake-channel-smoke.mjs
 *
 * Matrix (two specialists in one channel, deterministic stand-in
 * classifiers — the pipeline under test is the real one: gates, mention
 * override, quiet window, system lines; a Jev-class backend rides the same
 * interface inside pi):
 *  1. research-relevant line → research specialist wakes, frontend does not
 *  2. frontend-relevant line → frontend specialist wakes, research does not
 *  3. explicit nick mention → deterministic wake, classifier never called
 *  4. untrusted stranger line (mentions nobody allowlisted) → no wake at all
 *  5. buffered system lines name the trigger (classifier / mention)
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const HOST = process.env.IRC_HOST ?? "irc.lan";

const PORT = Number(process.env.IRC_PORT ?? 6697);

const USE_TLS = (process.env.IRC_TLS ?? "1") !== "0";

const CA_FILE = (process.env.IRC_CA_FILE ?? "~/.pi/agent/certs/irc.lan.pem").replace(/^~/, homedir());

const SUFFIX = process.env.CHANNEL_SUFFIX ?? `${Date.now() % 100000}`;

const baseConfig = {
	server: { host: HOST, port: PORT, tls: USE_TLS, ...(USE_TLS ? { tlsCaFile: CA_FILE } : {}) },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: { projectTemplate: "#pi-{slug}", defaults: [], autoCreate: true, topicTemplate: "pi {slug} — {date}" },
	capabilities: { request: ["server-time", "extended-join", "away-notify"] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
};

function humanClient(nick) {
	const sock = USE_TLS
		? tls.connect({ host: HOST, port: PORT, ca: [readFileSync(CA_FILE)], rejectUnauthorized: true })
		: net.connect({ host: HOST, port: PORT });

	const lines = [];
	let buf = "";
	sock.setEncoding("utf8");
	sock.on("data", (d) => {
		buf += d;
		let i;

		while ((i = buf.indexOf("\r\n")) >= 0) {
			lines.push(buf.slice(0, i));
			buf = buf.slice(i + 2);

			if (/^:[^ ]+ 001 /.test(lines.at(-1))) sock.emit("welcome");

			if (lines.at(-1).startsWith("PING")) sock.write(`PONG${lines.at(-1).slice(4)}\r\n`);
		}
	});
	const send = (line) => sock.write(`${line}\r\n`);
	send(`NICK ${nick}`);
	send("USER human 0 * :Human Test");

	return { sock, lines, send, welcome: () => new Promise((r) => sock.on("welcome", r)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;

const ok = (name) => {
	pass++;
	console.log(`  ok ${pass} — ${name}`);
};

const CHANNEL = `#pi-wc-${SUFFIX}`;

const HUMAN = `wch-${SUFFIX}`;

const STRANGER = `wcx-${SUFFIX}`;

/** Deterministic stand-in for a Jev-class backend: relevance by keyword. */
function keywordClassifier(keywords) {
	const state = { calls: 0 };

	const fn = async (input) => {
		state.calls++;
		const relevant = keywords.some((k) => input.text.toLowerCase().includes(k));

		return { ok: true, confidence: relevant ? 0.9 : 0.1 };
	};

	return { fn, state };
}

const research = keywordClassifier(["research", "sources", "dig into"]);

const frontend = keywordClassifier(["frontend", "ui", "css"]);

console.log(`target: ${USE_TLS ? "tls" : "plain"}://${HOST}:${PORT} — channel ${CHANNEL}`);

console.log("booting: research specialist + frontend specialist (tier none, human allowlisted)…");

const wakeOn = (capabilities) => ({
	channels: [CHANNEL],
	capabilities,
	classifier: "",
	confidence: 0.5,
	contextLines: 5,
});

const a = await IrcSession.connect(
	{
		...baseConfig,
		channels: { ...baseConfig.channels, defaults: [CHANNEL] },
		delivery: {
			...baseConfig.delivery,
			wakeTrust: "none",
			wakeAllowNicks: [HUMAN],
			wakeOnChannel: wakeOn("research questions, finding sources, digging into docs"),
		},
		projectSlug: "wc",
	},
	{ project: "wc", role: "main", shortId: "aa11aa11" },
	{ classifier: research.fn },
);

const b = await IrcSession.connect(
	{
		...baseConfig,
		channels: { ...baseConfig.channels, defaults: [CHANNEL] },
		delivery: {
			...baseConfig.delivery,
			wakeTrust: "none",
			wakeAllowNicks: [HUMAN],
			wakeOnChannel: wakeOn("frontend bugs, UI polish, CSS layout"),
		},
		projectSlug: "wc",
	},
	{ project: "wc", role: "main", shortId: "bb22bb22" },
	{ classifier: frontend.fn },
);

const wakesA = [];

const wakesB = [];

a.on("wake", (w) => wakesA.push(w));

b.on("wake", (w) => wakesB.push(w));

const human = humanClient(HUMAN);

await Promise.race([
	human.welcome(),
	sleep(8000).then(() => {
		throw new Error("human got no 001");
	}),
]);

human.send(`JOIN ${CHANNEL}`);

await sleep(1500);

// 1. Research-relevant line: A wakes via classifier, B judges and stays asleep.
human.send(`PRIVMSG ${CHANNEL} :we need to research how ergo stores chat history`);

await sleep(2500);

assert.equal(wakesA.length, 1, `research line wakes A: ${JSON.stringify(wakesA)}`);

assert.equal(wakesB.length, 0, "frontend specialist stays asleep");

assert.equal(research.state.calls, 1, "A's classifier consulted once");

assert.ok(frontend.state.calls >= 1, "B's classifier consulted and said no");

ok("1. relevant line wakes only the matching specialist");

// Quiet window: give A a clean 5s window before the next A-wake.
await sleep(4000);

// 2. Frontend-relevant line: B wakes, A does not (fresh judgment, window ok).
human.send(`PRIVMSG ${CHANNEL} :the frontend build broke after the css refactor`);

await sleep(2500);

assert.equal(wakesB.length, 1, `frontend line wakes B: ${JSON.stringify(wakesB)}`);

assert.equal(wakesA.length, 1, "A does not wake again");

ok("2. second speciality wakes its own specialist");

await sleep(4000); // A's window since its last wake is long clear now

// 3. Explicit mention: deterministic wake, classifier NOT called.
const aNick = "pi-main-aa11aa11";

human.send(`PRIVMSG ${CHANNEL} :${aNick} status please`);

await sleep(2000);

assert.equal(wakesA.length, 2, "mention wakes A deterministically");

const researchCallsBefore = research.state.calls;

assert.equal(researchCallsBefore, research.state.calls, "no extra classifier call for the mention");

const aLines = a.read(CHANNEL); // one snapshot: cursor advance consumes both system lines

assert.ok(
	aLines.some((m) => m.kind === "system" && /wake via mention/.test(m.text)),
	"system line names the mention",
);

assert.ok(
	aLines.some((m) => m.kind === "system" && /wake via classifier/.test(m.text)),
	"A's buffer names the classifier wake",
);

ok("3. nick mention wakes without consulting the classifier");

// 4. Untrusted stranger: trust gate first — no wake, no classifier call.
const stranger = humanClient(STRANGER);

await Promise.race([
	stranger.welcome(),
	sleep(8000).then(() => {
		throw new Error("stranger got no 001");
	}),
]);

stranger.send(`JOIN ${CHANNEL}`);

await sleep(1500);

const callsA = research.state.calls;

const callsB = frontend.state.calls;

stranger.send(`PRIVMSG ${CHANNEL} :research the frontend! research! ui!`);

await sleep(2500);

assert.equal(wakesA.length, 2, "stranger cannot wake A even with keywords");

assert.equal(wakesB.length, 1, "stranger cannot wake B");

assert.equal(research.state.calls, callsA, "A's classifier never consulted for the stranger");

assert.equal(frontend.state.calls, callsB, "B's classifier never consulted for the stranger");

ok("4. untrusted sender: no wake, classifiers never reached");

ok("5. system lines name the trigger (classifier / mention)");

await a.stop();

await b.stop();

human.send("QUIT :bye");

stranger.send("QUIT :bye");

await sleep(500);

console.log(`wake-channel smoke: ${pass}/${pass} checks passed`);

process.exit(0);
