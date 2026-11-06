/**
 * P6 validation run (presence + wake trust) against a live IRC server
 * (InspIRCd on 6667, or ergo via IRC_PORT):
 *
 *   1. an unlisted human's DM buffers silently (no wake, one system note)
 *   2. an allowlisted human's DM wakes the session
 *   3. setBusy(true) → the away flag is visible to a peer roster (away-notify
 *      or WHO fallback) and the server answers DMs with RPL_AWAY (301)
 *   4. setBusy(false) → back
 *
 *   IRC_PORT=6667 node scripts/presence-smoke.mjs
 */
import assert from "node:assert/strict";
import net from "node:net";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.IRC_PORT ?? 6667);
const stamp = Date.now().toString(36).slice(-4);
const MAIN = `pi-main-p${stamp}`;
const SUB = `pi-sub-q${stamp}`;

const cfg = {
	server: { host: HOST, port: PORT, tls: false },
	nick: { template: MAIN, maxLen: 30 },
	channels: {
		projectTemplate: "#pi-presence",
		defaults: [],
		autoCreate: true,
		topicTemplate: "pi presence smoke {date}",
	},
	capabilities: { request: ["server-time", "extended-join", "away-notify"] },
	delivery: {
		bufferMax: 50,
		wakeOnDirectMessage: true,
		chunkLongSends: true,
		wakeAllowNicks: [`trusted-${stamp}`],
	},
	projectSlug: "presence",
};

/** Minimal raw human client: connect, register, snoop selected lines. */
function rawClient(nick) {
	const lines = [];
	const sock = net.connect(PORT, HOST);
	sock.setEncoding("utf8");
	let buf = "";
	const waiters = [];
	sock.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 2);
			if (!line) continue;
			lines.push(line);
			for (const w of waiters.splice(0)) w(line);
		}
	});
	const send = (l) => sock.write(`${l}\r\n`);
	const next = (pred, ms = 8000) =>
		new Promise((res, rej) => {
			const hit = lines.find(pred);
			if (hit) return res(hit);
			const t = setTimeout(() => rej(new Error(`timeout waiting for line; got:\n${lines.slice(-12).join("\n")}`)), ms);
			waiters.push((l) => {
				if (pred(l)) {
					clearTimeout(t);
					res(l);
				}
			});
		});
	return {
		nick,
		lines,
		send,
		next,
		async register() {
			await new Promise((r) => sock.once("connect", r));
			send(`CAP LS 302`);
			send(`NICK ${nick}`);
			send(`USER pi 0 * :human probe`);
			const ls = await next((l) => / CAP .* LS /.test(l) || / 421 /.test(l));
			if (/ CAP .* LS /.test(ls) && /away-notify/.test(ls)) {
				send(`CAP REQ :away-notify`);
				await next((l) => / CAP .* ACK /.test(l));
			}
			send(`CAP END`);
			await next((l) => / 001 /.test(l));
		},
		close: () => sock.destroy(),
	};
}

const results = [];
const check = (name, ok, extra = "") => {
	results.push([name, ok]);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

let exit = 0;
try {
	console.log(`# presence/wake-trust smoke against ${HOST}:${PORT}`);
	const main = await IrcSession.connect(cfg, { project: "presence", role: "main", shortId: `p${stamp}` });
	const wakes = [];
	main.on("wake", (w) => wakes.push(w));

	const sub = await IrcSession.connect(
		{ ...cfg, nick: { template: SUB, maxLen: 30 } },
		{ project: "presence", role: "sub", shortId: `q${stamp}` },
	);

	const stranger = rawClient(`stranger${stamp}`);
	await stranger.register();

	// 1. Unlisted human DMs → buffered, no wake.
	stranger.send(`PRIVMSG ${MAIN} :are you there?`);
	await new Promise((r) => setTimeout(r, 1500));
	check("unlisted human DM does not wake", wakes.length === 0, `wakes=${wakes.length}`);
	const buffered = main.read(`stranger${stamp}`).map((m) => m.text);
	check(
		"unlisted DM buffered with allowlist note",
		buffered.some((t) => /not on the wake allowlist/.test(t)),
		buffered.at(-1) ?? "",
	);

	// 2. Allowlisted human DMs → wake.
	const trusted = rawClient(`Trusted-${stamp}`);
	await trusted.register();
	trusted.send(`PRIVMSG ${MAIN} :go check the build`);
	await new Promise((r) => setTimeout(r, 1500));
	check("allowlisted human DM wakes", wakes.length === 1, `wakes=${wakes.length} from=${wakes[0]?.from}`);
	check("wake text carried", /go check the build/.test(wakes[0]?.text ?? ""), wakes[0]?.text ?? "");

	// 3. Busy: AWAY goes out, peer roster sees it, server 301s DMs.
	main.setBusy(true);
	const awayLine = await stranger.next((l) => new RegExp(`^:${MAIN}[^ ]* AWAY`).test(l), 5000).catch(() => null);
	check("AWAY broadcast seen by a watcher (away-notify)", Boolean(awayLine), awayLine ?? "no away-notify — falling back to WHO");
	if (!awayLine) {
		// Fallback: WHO the main nick and read the H/G flag.
		stranger.send(`WHO ${MAIN}`);
		const who = await stranger.next((l) => / 352 /.test(l));
		check("WHO shows gone flag while busy", / G[^\n]*$/.test(who), who);
	}
	await new Promise((r) => setTimeout(r, 1000));
	const peer = sub.rosterView().find((p) => p.nick === MAIN);
	check("peer roster marks main busy", peer?.away === true, JSON.stringify(peer ?? {}));

	stranger.send(`PRIVMSG ${MAIN} :still there?`);
	const rplAway = await stranger.next((l) => / 301 /.test(l), 5000).catch(() => null);
	check("server answers DM to busy agent with 301", Boolean(rplAway), rplAway ?? "no 301");

	// 4. Back.
	main.setBusy(false);
	await new Promise((r) => setTimeout(r, 1000));
	const back = sub.rosterView().find((p) => p.nick === MAIN);
	check("peer roster shows main back", back?.away !== true, JSON.stringify(back ?? {}));

	stranger.close();
	trusted.close();
	await main.stop();
	await sub.stop();
} catch (err) {
	exit = 1;
	console.error(err);
} finally {
	const fails = results.filter(([, ok]) => !ok);
	if (fails.length) exit = 1;
	console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
	process.exit(exit);
}
