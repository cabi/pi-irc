// Debug: boot a session against the mock server and dump both directions.
import { loadViaPi, repoFile } from "../tests/helpers.mjs";
import { MockIrcServer } from "../tests/mock-irc-server.mjs";

const srv = new MockIrcServer();
const port = await srv.start();
console.log("mock server on", port);

const { loadConfig } = await loadViaPi(repoFile("lib", "config.ts"));
const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const cfgPath = repoFile("tests", "fixtures", "debug-config.json");
await import("node:fs").then((fs) =>
	fs.writeFileSync(
		cfgPath,
		JSON.stringify({ server: { host: "127.0.0.1", port, tls: false }, slug: "proj" }),
	),
);
const config = loadConfig({ globalPath: cfgPath });

let session;
try {
	session = await IrcSession.connect(config, {
		project: "demo",
		role: "main",
		shortId: "abcd1234",
	});
session.on("wake", (e) => console.log("EVT wake", JSON.stringify(e)));
	console.log("STARTED", session.status().nick, session.status().projectChannel);
} catch (e) {
	console.log("FAILED:", e.message);
}
const c = srv.lastClient();
console.log("--- client sent ---");
for (const l of c.sent) console.log(">", l);
console.log("--- server pushed ---");
for (const l of c.lines) console.log("<", l);
await session.stop();
await srv.stop();
process.exit(0);
