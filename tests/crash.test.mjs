import test from "node:test";
import assert from "node:assert/strict";
import { IrcClient } from "../lib/irc-client.ts";
import { IrcSocket } from "../lib/irc-socket.ts";
import { EventEmitter } from "node:events";

/**
 * Regression: connecting to a dead server must reject cleanly — never crash
 * the process. Field report (v0.3.0): switching the local IRC server while
 * pi ran crashed the host with `Unhandled error. ({ message: 'socket: ' })`.
 *
 * Root cause chain: IrcSocket.connect() attached a persistent on("error")
 * re-emitter during the connect phase; the error reached IrcClient's
 * forwarding handler, which emitted 'error' as a plain object; the session
 * (the only 'error' listener) was not bound yet, so Node threw the emitted
 * value from inside the socket's error callback — uncaught exception.
 *
 * This test drives the REAL socket stack against a refused port with the
 * session absent on purpose: with the old code the test runner itself dies.
 */
test("connect to a dead server rejects cleanly instead of crashing", async () => {
	const transport = new IrcSocket();
	const client = new IrcClient(
		{ nick: "crashtest", username: "crashtest", realname: "crashtest" },
		transport,
	);
	// No 'error' listener is attached on purpose: none exists in the real
	// startup window either (session binds its listener only after connect).
	await assert.rejects(
		transport.connect({ host: "127.0.0.1", port: 1, tls: false, timeoutMs: 3000 }),
		/connect ECONNREFUSED/,
	);
	// And the client must not have entered a half-registered state.
	assert.equal(client.state, "idle");
	transport.destroy();
});

test("transport errors surface as real Error instances, not plain objects", async () => {
	class FakeTransport extends EventEmitter {
		send() {}
		close() {}
		destroy() {}
		connect() {
			return Promise.resolve();
		}
	}
	const transport = new FakeTransport();
	const client = new IrcClient({ nick: "errtest", username: "errtest", realname: "errtest" }, transport);
	const seen = new Promise((resolve) => client.once("error", resolve));
	transport.emit("error", new Error("boom"));
	const emitted = await seen;
	assert.ok(emitted instanceof Error, `expected Error, got ${JSON.stringify(emitted)}`);
	assert.match(emitted.message, /^socket: /);
});
