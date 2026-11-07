/**
 * P6 validation run: two agent sessions on a live IRC server (InspIRCd on
 * 6667, or ergo via IRC_PORT) exercise the ask/reply correlated-DM protocol
 * end to end — envelope on the wire, wake on the target, reassembly, and
 * the late-reply fallback after a timeout.
 *
 *   IRC_PORT=6667 node scripts/ask-reply-smoke.mjs
 */
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.IRC_PORT ?? 6667);

const baseConfig = {
	server: { host: HOST, port: PORT, tls: false },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: {
		projectTemplate: "#pi-{slug}",
		defaults: [],
		autoCreate: true,
		topicTemplate: "pi {slug} — {date}",
	},
	capabilities: { request: ["server-time", "extended-join", "multi-prefix"] },
	// Wake trust is default-deny; this smoke exercises ask/reply mechanics,
	// so the agents trust each other by nick glob (the SASL-account path is
	// proven by scripts/intercom-parity.mjs against the live server).
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, wakeAllowNicks: ["pi-*"], chunkLongSends: true },
	projectSlug: "askdemo",
};

const stamp = Date.now().toString(36).slice(-4);
const NICKS = { main: `pi-main-a${stamp}`, sub: `pi-sub-b${stamp}` };

function cfg(role) {
	return { ...baseConfig, nick: { ...baseConfig.nick, template: NICKS[role] } };
}

async function boot(role, shortId) {
	const wakes = [];
	const s = await IrcSession.connect(cfg(role), { project: "askdemo", role, shortId });
	s.on("wake", (w) => wakes.push(w));
	return { s, wakes };
}

// Collect raw wire lines both directions via a sniffer session? Simpler:
// assert on observable session state; wire fidelity is covered by mock tests.
const results = [];
const check = (name, ok, extra = "") => {
	results.push([name, ok]);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

let exit = 0;
try {
	console.log(`# ask/reply smoke against ${HOST}:${PORT}`);
	const main = await boot("main", `a${stamp}`);
	const sub = await boot("sub", `b${stamp}`);
	const who = main.s.rosterView().map((p) => p.nick);
	check("both agents see each other in the roster", who.includes(NICKS.sub), who.join(","));

	// 1a. P11 addressing: @session-id and role selectors resolve via roster
	const atSub = main.s.resolveTarget(`@b${stamp}`);
	check("main resolves @session-id to the sub nick", atSub === NICKS.sub, `${atSub} (sub=${NICKS.sub})`);
	check("main resolves the 'sub' role selector", main.s.resolveTarget("sub") === NICKS.sub);
	check("sub resolves the 'main' role selector", sub.s.resolveTarget("main") === NICKS.main);
	const noMain = (() => { try { main.s.resolveTarget("main"); return "resolved"; } catch (e) { return e.message; } })();
	check("main cannot address itself via role (self-excluded)", /no main agent/.test(noMain), noMain.slice(0, 60));

	// 1. main asks sub a long question (forces multi-part envelope)
	const words = Array.from({ length: 90 }, (_, i) => `q${i}`).join(" ");
	const answer = main.s.ask(NICKS.sub, words, 15);

	await new Promise((r) => setTimeout(r, 1_500));
	const askMsg = sub.s.read({ limit: 10 }).find((m) => m.kind === "ask");
	check("sub buffered the ask with reply hint", !!askMsg && /reply with: irc reply id=/.test(askMsg.text));
	check("ask woke the sub session", sub.wakes.length >= 1, `${sub.wakes.length} wake(s)`);
	const id = askMsg?.text.match(/id=([0-9a-z]+)/)?.[1];

	// 2. sub answers with a long reply (multi-part reassembly over the wire)
	const body = Array.from({ length: 110 }, (_, i) => `a${i}`).join(" ");
	sub.s.reply(id, body);
	const res = await answer;
	check(
		"main resolved the full reply exactly",
		res.status === "replied" && res.reply === body,
		res.status === "replied" ? `${res.reply.length} chars` : "timeout",
	);

	// 3. timeout path against a peer that ignores the ask
	const ignored = main.s.ask(NICKS.sub, "will be ignored", 1);
	const tres = await ignored;
	check("silent peer times out cleanly", tres.status === "timeout", `${tres.timeoutMs}ms`);

	// 4. late reply to the timed-out ask surfaces as a DM (nothing lost)
	const lateAsk = sub.s.rpc.pendingInbound().at(-1);
	sub.s.reply(lateAsk.id, "late answer");
	await new Promise((r) => setTimeout(r, 1_000));
	const dm = main.s.read({ limit: 10 }).find((m) => m.kind === "dm" && m.text.includes("late answer"));
	check("late reply visible as plain DM", !!dm);

	// 5. pending view is consistent on both sides
	const pend = main.s.rpc.pendingOutbound();
	check("no dangling outbound waits", pend.length === 0, `${pend.length}`);

	main.s.stop();
	sub.s.stop();
} catch (err) {
	exit = 1;
	console.error("SMOKE ERROR:", err);
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || exit ? 1 : 0);
