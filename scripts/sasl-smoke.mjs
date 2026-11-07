/**
 * P7 validation run: SASL PLAIN + TLS against a REAL ergo server.
 *
 *   openssl req -x509 -newkey rsa:2048 -keyout tests/ergo/certs/tls.key \
 *     -out tests/ergo/certs/tls.crt -days 3650 -nodes -subj "/CN=ergo.pi.test"
 *   docker run -d --rm --name pi-irc-ergo \
 *     -v "$PWD/tests/ergo/ergo.yaml:/ergo/ergo.yaml:ro" \
 *     -v "$PWD/tests/ergo/certs:/ergo/certs:ro" \
 *     -v pi-irc-ergo-data:/ergo/data \
 *     -p 127.0.0.1:16667:6667 -p 127.0.0.1:16697:6697 ergochat/ergo:latest
 *   node scripts/sasl-smoke.mjs
 *
 * Checks:
 *   1. an account registered via NickServ is used by the agent over TLS+SASL
 *   2. WHOIS proves the on-wire identity is the account (330)
 *   3. channel join + cross-client delivery still work authenticated
 *   4. a wrong password fails closed (connect rejects, never registers)
 */
import * as tls from "node:tls";
import { loadViaPi, repoFile } from "../tests/helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const HOST = "127.0.0.1";

const PORT = Number(process.env.IRC_PORT ?? 16667);

const TLS_PORT = Number(process.env.IRC_TLS_PORT ?? 16697);

const stamp = Date.now().toString(36).slice(-4);

const ACCOUNT = `agentp7-${stamp}`;

const PASSWORD = `pw-${stamp}-secret`;

const baseConfig = {
	server: { host: HOST, port: TLS_PORT, tls: true, tlsInsecure: true },
	auth: { username: ACCOUNT, password: PASSWORD },
	nick: { template: `${ACCOUNT}-m`, maxLen: 30 },
	channels: {
		projectTemplate: "#pi-sasl",
		defaults: [],
		autoCreate: true,
		topicTemplate: "pi sasl smoke {date}",
	},
	capabilities: { request: ["server-time", "extended-join", "away-notify"] },
	delivery: { bufferMax: 50, wakeOnDirectMessage: true, chunkLongSends: true },
	projectSlug: "sasl",
};

/** Minimal raw probe client (plain TCP, no caps). */
function rawClient(nick) {
	const lines = [];
	// TLS probe: the account is created from a secure origin, so the
	// agent's TLS+SASL session can attach without ergo's secure/insecure
	// account conflict.
	const sock = tls.connect({ host: HOST, port: TLS_PORT, rejectUnauthorized: false });
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

			for (const w of [...waiters]) w(line);
		}
	});
	const send = (l) => sock.write(`${l}\r\n`);

	const next = (pred, ms = 8000, tag = "?") =>
		new Promise((res, rej) => {
			const hit = lines.find(pred);

			if (hit) return res(hit);
			const t = setTimeout(() => rej(new Error(`timeout [${tag}]; last lines:\n${lines.slice(-10).join("\n")}`)), ms);

			const waiter = (l) => {
				if (pred(l)) {
					clearTimeout(t);
					waiters.splice(waiters.indexOf(waiter), 1);
					res(l);
				}
			};

			waiters.push(waiter);
		});

	return {
		lines,
		send,
		next,
		async register() {
			await new Promise((r) => sock.once("connect", r));
			send(`NICK ${nick}`);
			send("USER probe 0 * :probe");
			await next((l) => / 001 /.test(l), 8000, "welcome");
			await next((l) => / 376 | 422 /.test(l), 8000, "motd"); // services drop commands mid-burst
			await new Promise((r) => setTimeout(r, 500)); // ergo ignores NS until its post-MOTD burst settles
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

let probe;

try {
	console.log(`# SASL+TLS smoke: ${ACCOUNT} against ${HOST}:${TLS_PORT} (TLS), probe :${PORT}`);

	// Register the account through NickServ with a plain probe connection.
	probe = rawClient(ACCOUNT);
	await probe.register();
	probe.send(`NS REGISTER ${PASSWORD}`);

	const reg = await probe.next(
		(l) => /NickServ.*NOTICE.*([Rr]egistered|already been registered|Account created)/.test(l),
		10000,
		"nickserv-register",
	);

	check(
		"account registered via NickServ",
		/egistered|ccount created/.test(reg),
		reg.replace(/^:\S+\s+/, "").slice(0, 90),
	);
	// The probe's plain connection auto-logged-in on registration; ergo
	// refuses mixing secure and insecure sessions on one account, so the
	// probe detaches before the agent's TLS+SASL session attaches.
	probe.send("NS LOGOUT");
	await probe.next((l) => /NickServ.*NOTICE/.test(l), 8000, "nickserv-logout");

	// Agent session: TLS transport + SASL PLAIN.
	const session = await IrcSession.connect(baseConfig, { project: "sasl", role: "main", shortId: `s${stamp}` });
	const st = session.status();
	check(
		"registered over TLS with SASL",
		st.connection === "registered",
		JSON.stringify({ nick: st.nick, connection: st.connection }),
	);
	check("project channel joined", st.channels.includes("#pi-sasl"), JSON.stringify(st.channels ?? []));

	// WHOIS from an unauthenticated observer proves the account binding.
	probe.send(`WHOIS ${st.nick}`);
	const whoisAccount = await probe.next((l) => / 330 /.test(l), 8000).catch(() => null);
	check(
		"WHOIS 330: on-wire identity is the account",
		Boolean(whoisAccount) && whoisAccount.includes(ACCOUNT),
		whoisAccount ?? "no 330",
	);

	// Cross-client delivery still works authenticated.
	const waitFor = (pred, ms = 6000) => probe.next(pred, ms);
	session.send(undefined, "agent online, authenticated");
	const delivered = await waitFor((l) => l.includes("PRIVMSG #pi-sasl :agent online, authenticated")).catch(() => null);
	check("channel message delivered to plain client", Boolean(delivered), delivered ?? "");

	// Second session with the same account: repeated SASL works (multi-login).
	const second = await IrcSession.connect(
		{ ...baseConfig, nick: { template: `${ACCOUNT}-s`, maxLen: 30 } },
		{ project: "sasl", role: "sub", shortId: `t${stamp}` },
	);

	check("second session authenticates with same account", second.status().nick.length > 0, second.status().nick);
	second.send(undefined, "sub here too");
	const subDelivered = await waitFor((l) => l.includes("PRIVMSG #pi-sasl :sub here too")).catch(() => null);
	check("sub message visible to plain client", Boolean(subDelivered), subDelivered ?? "");

	// Fail closed: wrong password must reject, never register anonymously.
	let rejected = false;

	try {
		await IrcSession.connect(
			{ ...baseConfig, auth: { username: ACCOUNT, password: "wrong-password" } },
			{ project: "sasl", role: "main", shortId: `w${stamp}` },
		);
	} catch (err) {
		rejected = true;
		var rejectMsg = err.message;
	}

	check("wrong password fails closed (rejects)", rejected, rejectMsg ?? "CONNECTED — FAIL OPEN BUG");

	await session.stop();
	await second.stop();
	probe.close();
} catch (err) {
	exit = 1;
	console.error(err);
} finally {
	const fails = results.filter(([, ok]) => !ok);

	if (fails.length) exit = 1;
	console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
	process.exit(exit);
}
