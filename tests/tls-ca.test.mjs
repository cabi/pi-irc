import test from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IrcSocket } from "../lib/irc-socket.ts";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { loadConfig, ConfigError } = await loadViaPi(repoFile("lib", "config.ts"));

const here = dirname(fileURLToPath(import.meta.url));

const CERT = fs.readFileSync(join(here, "ergo", "certs", "tls.crt"));

const KEY = fs.readFileSync(join(here, "ergo", "certs", "tls.key"));

/** Minimal real TLS listener: accepts, says nothing, closes on input end. */
function tlsServer() {
	const seen = [];

	const server = tls.createServer({ cert: CERT, key: KEY }, (sock) => {
		seen.push(sock.remoteAddress);
		sock.on("data", () => sock.end());
	});

	server.listen(0, "127.0.0.1");

	return { server, port: new Promise((res) => server.once("listening", () => res(server.address().port))) };
}

test("tlsCaFile pinning: self-signed cert verified via ca, rejected without it", async () => {
	const { server, port } = tlsServer();
	const p = await port;

	// Without the CA: handshake must fail (self-signed, unknown issuer).
	const plain = new IrcSocket();
	await assert.rejects(
		plain.connect({ host: "127.0.0.1", port: p, tls: true, timeoutMs: 4000 }),
		/self-signed|UNABLE_TO_VERIFY|CERT/gi,
	);

	// With the CA pinned: full verification (incl. hostname) succeeds.
	// With the CA pinned (and serverName since the fixture cert is a bare
	// CN with no SAN): full verification succeeds.
	const pinned = new IrcSocket();
	await pinned.connect({
		host: "127.0.0.1",
		port: p,
		tls: true,
		timeoutMs: 4000,
		ca: CERT,
		serverName: "ergo.pi.test",
	});
	assert.equal(pinned.connected, true);
	pinned.destroy();

	server.close();
});

test("config: tlsCaFile parsed, mutually exclusive with tlsInsecure", () => {
	const dir = fs.mkdtempSync(join(os.tmpdir(), "pi-irc-ca-"));
	const write = (cfg) => fs.writeFileSync(join(dir, "pi-irc.json"), JSON.stringify(cfg));
	const load = () => loadConfig({ globalPath: join(dir, "pi-irc.json") });

	write({ server: { host: "h", port: 1, tls: true, tlsCaFile: "/tmp/ca.pem" } });
	assert.equal(load().server.tlsCaFile, "/tmp/ca.pem");

	write({ server: { host: "h", port: 1, tls: true, tlsCaFile: "/tmp/ca.pem", tlsInsecure: true } });
	assert.throws(
		() => load(),
		(err) => err instanceof ConfigError && /tlsCaFile/.test(err.message),
		"tlsCaFile + tlsInsecure must be rejected together",
	);

	fs.rmSync(dir, { recursive: true, force: true });
});
