/**
 * REAL two-session coordination drill: two actual `pi -p` processes using
 * the real extension-host `irc` tool (project-local install), talking over
 * the operator's ergo (irc.lan:6697 TLS + pinned CA). Exercises the whole
 * stack end to end: extension entry, config merge (global + project
 * override), identity, roster discovery with dynamic nicks, cross-process
 * blocking ask/reply, and channel traffic witnessed by a stock IRC human.
 *
 *   node scripts/drill-agents.mjs
 *
 * Isolation: scratch project dir /tmp/pi-irc-drill-<ts> with a project-local
 * `pi install -l` and a `.pi/pi-irc.json` channel override. The user's
 * global settings are untouched.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as tls from "node:tls";
import { homedir } from "node:os";
import path from "node:path";

const STAMP = `${Date.now() % 100000}`;
const REPO = path.resolve(import.meta.dirname, "..");
const SCRATCH = `/tmp/pi-irc-drill-${STAMP}`;
const CHANNEL = `#drill-${STAMP}`;
const CA_FILE = `${homedir()}/.pi/agent/certs/irc.lan.pem`;

console.log(`scratch: ${SCRATCH}\nchannel: ${CHANNEL}`);
mkdirSync(path.join(SCRATCH, ".pi"), { recursive: true });
writeFileSync(
	path.join(SCRATCH, ".pi", "pi-irc.json"),
	JSON.stringify(
		{
			// Literal template: unique drill channel, no {slug}.
			channels: { projectTemplate: CHANNEL, autoCreate: true, defaults: [] },
		},
		null,
		2,
	),
);

// Project-local extension install (adds .pi/settings.json + trust entry).
execFileSync("pi", ["install", REPO, "-l", "--approve"], { cwd: SCRATCH, stdio: "pipe" });
console.log("extension installed project-locally");

// --- observer: stock IRC client over the same TLS wire ----------------------

const obs = tls.connect({ host: "irc.lan", port: 6697, ca: [readFileSync(CA_FILE)] });
const seen = [];
let obuf = "";
obs.setEncoding("utf8");
obs.on("data", (d) => {
	obuf += d;
	let i;
	while ((i = obuf.indexOf("\r\n")) >= 0) {
		const line = obuf.slice(0, i);
		if (process.env.DRILL_DEBUG) console.log(`  [obs] ${line.slice(0, 110)}`);
		obuf = obuf.slice(i + 2);
		if (/^:[^ ]+ 001 /.test(line)) {
			obs.write(`JOIN ${CHANNEL}\r\n`);
		}
		const m = line.match(new RegExp(`^:([^!]+)![^ ]* PRIVMSG ${CHANNEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} :(.*)$`));
		if (m) seen.push([m[1], m[2]]);
		if (line.startsWith("PING")) obs.write(`PONG ${line.slice(5)}\r\n`);
	}
});
obs.write("NICK drill-observer\r\nUSER o 0 * :o\r\n");
await new Promise((r) => setTimeout(r, 1000));

// --- the two real pi agents --------------------------------------------------

const MAIN_PROMPT = `In this project you have the "irc" tool for agent communication. Do exactly this, using only the irc tool:
1. op=send text="main online"
2. op=roster — repeat until a nick starting with "pi-sub" appears (up to 20 tries); the other agent takes a few seconds to join.
3. op=ask peer=<that pi-sub nick> text="what is 2+2? answer with just the digit" timeout=90 — this blocks until the peer replies.
4. op=send text="main got answer: <the reply you received>"
Finish your final message with the exact marker DRILL-MAIN-DONE.`;

const SUB_PROMPT = `In this project you have the "irc" tool for agent communication. Do exactly this, using only the irc tool:
1. op=send text="sub online"
2. op=pending — repeat until an ask appears (up to 20 tries); the other agent takes a few seconds.
3. op=reply id=<the ask id> text="4"
4. op=send text="sub replied"
Finish your final message with the exact marker DRILL-SUB-DONE.`;

function runAgent(name, prompt, env) {
	const out = [];
	const p = spawn("pi", ["-p", prompt], {
		cwd: SCRATCH,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const tag = (b) =>
		b.toString().split("\n").forEach((l) => l && out.push(l) && console.log(`  [${name}] ${l.slice(0, 120)}`));
	p.stdout.on("data", tag);
	p.stderr.on("data", tag);
	return { p, out, done: new Promise((res) => p.on("exit", (c) => res(c))) };
}

console.log("launching MAIN (roster-polls for the sub, then blocking ask)…");
const main = runAgent("main", MAIN_PROMPT, {});
await new Promise((r) => setTimeout(r, 3000));
console.log("launching SUB (pending-polls for the ask)…");
const sub = runAgent("sub", SUB_PROMPT, { PI_IRC_ROLE: "sub" });

const guard = setTimeout(() => {
	console.error("DRILL TIMEOUT — killing agents");
	main.p.kill("SIGKILL");
	sub.p.kill("SIGKILL");
}, 300_000);
const [mc, sc] = await Promise.all([main.done, sub.done]);
clearTimeout(guard);
obs.destroy();

// --- verdict ------------------------------------------------------------------

const mainOut = main.out.join("\n");
const subOut = sub.out.join("\n");
const channelText = seen.map(([n, t]) => `${n}: ${t}`).join("\n");
const checks = [
	["main process exited 0", mc === 0],
	["sub process exited 0", sc === 0],
	["main printed DRILL-MAIN-DONE", mainOut.includes("DRILL-MAIN-DONE")],
	["sub printed DRILL-SUB-DONE", subOut.includes("DRILL-SUB-DONE")],
	["observer saw 'main online'", seen.some(([, t]) => t === "main online")],
	["observer saw 'sub online'", seen.some(([, t]) => t === "sub online")],
	["observer saw the answer relay", seen.some(([, t]) => /^main got answer: 4/.test(t))],
	["observer saw 'sub replied'", seen.some(([, t]) => t === "sub replied")],
	[
		"nicks rendered with roles",
		seen.some(([n]) => n.startsWith("pi-main-")) && seen.some(([n]) => n.startsWith("pi-sub-")),
	],
];

console.log(`\nchannel ${CHANNEL}:\n${channelText}\n`);
let fail = 0;
for (const [name, okv] of checks) {
	console.log(`${okv ? "PASS" : "FAIL"}  ${name}`);
	if (!okv) fail++;
}
console.log(fail === 0 ? `\nDRILL PASSED — ${checks.length} checks` : `\nDRILL FAILED — ${fail}/${checks.length}`);
process.exit(fail === 0 ? 0 : 1);
