// P18 wakeOnChannel: per-agent channel wakes. Deterministic gates first
// (config scope, own-line skip, sender trust, quiet window), a nick mention
// wakes without a classifier call, everything else asks the injected
// classifier (fail-closed: errors and low confidence never wake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadViaPi, repoFile, sleep } from "./helpers.mjs";

const { IrcSession } = await loadViaPi(repoFile("lib", "session.ts"));

const { IrcClient } = await loadViaPi(repoFile("lib", "irc-client.ts"));

/** Same auto-answer contract as presence.test.mjs. */
class FakeServer extends EventEmitter {
	lines = [];
	#client = null;
	#answers = [];

	constructor() {
		super();
		this.send = (line) => {
			this.lines.push(line);
			this.#answers.push(() => this.#autoAnswer(line));
			this.#flush();
		};
	}

	say(line) {
		this.emit("line", line);
	}

	#flush() {
		const pending = this.#answers;
		this.#answers = [];

		for (const a of pending) queueMicrotask(a);
	}

	#autoAnswer(line) {
		if (!this.#client) return;
		const m = /^(\S+)(?:\s+(.*))?$/.exec(line);

		if (!m) return;
		const [, cmd, rest = ""] = m;
		const me = this.#client.nick;

		switch (cmd) {
			case "JOIN": {
				for (const chan of rest
					.split(",")
					.map((c) => c.trim())
					.filter(Boolean)) {
					this.say(`:${me}!pi@h JOIN ${chan}`);
					this.say(`:srv 331 ${me} ${chan} :No topic is set`);
					this.say(`:srv 353 ${me} = ${chan} :${me} carol`);
					this.say(`:srv 366 ${me} ${chan} :End of /NAMES list.`);
					this.say(`:srv 352 ${me} ${chan} pi h srv ${me} H :0 pi-agent project=proj role=main session=s1`);
					this.say(`:srv 315 ${me} ${chan} :End of WHO list`);
				}

				break;
			}

			case "TOPIC": {
				this.say(`:srv 331 ${me} ${rest} :No topic is set`);
				break;
			}

			case "WHO": {
				this.say(`:srv 315 ${me} ${rest.split(" ")[0]} :End of WHO list`);
				break;
			}

			default:
				break;
		}
	}

	bind(client) {
		this.#client = client;
	}

	connect() {
		return Promise.resolve();
	}

	close() {}

	destroy() {}
}

const ident = { project: "proj", role: "main", shortId: "s1" };

function makeConfig(over = {}) {
	return {
		server: { host: "irc.example", port: 6667, tls: false },
		nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
		channels: {
			projectTemplate: "#pi-{slug}",
			defaults: ["#lounge"],
			autoCreate: true,
			topicTemplate: "pi {slug} — {date}",
		},
		capabilities: { request: [] },
		delivery: {
			bufferMax: 50,
			wakeOnDirectMessage: true,
			chunkLongSends: true,
			wakeAllowNicks: ["carol"],
			wakeTrust: "none",
			wakeOnChannel: {
				channels: ["#lounge"],
				capabilities: "research questions and source finding",
				classifier: "",
				confidence: 0.5,
				contextLines: 5,
				...over.wakeOnChannel,
			},
		},
		projectSlug: "proj",
	};
}

async function boot({ classifier } = {}) {
	const srv = new FakeServer();
	const client = new IrcClient({ nick: "pi-main-s1", username: "pi", realname: "pi-agent:main:proj:s1" }, srv);
	srv.bind(client);
	client.startRegistration();
	srv.say(":srv 001 pi-main-s1 :Welcome");
	const pending = IrcSession.connect(makeConfig(), ident, { client, classifier });
	srv.say(":srv 376 pi-main-s1 :End of MOTD");
	const session = await pending;

	return { srv, client, session };
}

/** Fixed-verdict classifier that records every call. */
function spyClassifier(verdict) {
	const calls = [];

	const fn = async (input) => {
		calls.push(input);

		return isFunction(verdict) ? verdict(input) : verdict;
	};

	/** @param {unknown} value @returns {value is Function} */
	function isFunction(value) {
		return value instanceof Function;
	}

	return { fn, calls };
}

test("classifier path: trusted sender + confidence ≥ threshold wakes", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.8 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :we should research how ergo stores history");
	await sleep(50);
	assert.equal(clf.calls.length, 1, "classifier consulted exactly once");
	assert.equal(wakes.length, 1, "high confidence wakes");
	assert.match(wakes[0].text, /carol in #lounge:/, "wake text carries channel context");
	assert.match(wakes[0].text, /research how ergo/);
	const sys = session.read("#lounge").map((m) => m.text);
	assert.ok(
		sys.some((t) => /wake via classifier/.test(t)),
		`system line names the trigger: ${sys}`,
	);
});

test("classifier path: confidence below threshold never wakes", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.3 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :lunch anyone?");
	await sleep(50);
	assert.equal(clf.calls.length, 1);
	assert.equal(wakes.length, 0, "0.3 < 0.5 threshold");
});

test("classifier path: exact threshold wakes (>=)", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.5 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :please find sources on sasl");
	await sleep(50);
	assert.equal(wakes.length, 1, "confidence == threshold wakes");
});

test("classifier fail-closed: backend error means no wake, no throw", async () => {
	const clf = spyClassifier({ ok: false, confidence: 0, error: "boom" });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :research something");
	await sleep(50);
	assert.equal(wakes.length, 0, "ok:false → no wake");
});

test("classifier throwing is caught: no wake, no crash", async () => {
	const clf = spyClassifier(() => {
		throw new Error("network down");
	});

	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :research something");
	await sleep(50);
	assert.equal(wakes.length, 0, "thrown error → no wake");
});

test("mention of own nick wakes deterministically — classifier never called", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.99 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :pi-main-s1 status please");
	await sleep(50);
	assert.equal(wakes.length, 1, "mention wakes");
	assert.equal(clf.calls.length, 0, "no classifier call for mentions");
	const sys = session.read("#lounge").map((m) => m.text);
	assert.ok(
		sys.some((t) => /wake via mention/.test(t)),
		`system line names mention: ${sys}`,
	);
});

test("untrusted sender: no wake, classifier never consulted", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.99 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":stranger!u@h PRIVMSG #lounge :pi-main-s1 hey wake up and research this");
	await sleep(50);
	// Mention of the nick, but sender is not wake-trusted → still no wake.
	assert.equal(wakes.length, 0, "trust gate runs before anything else");
	assert.equal(clf.calls.length, 0, "classifier is never reached");
});

test("channels outside wakeOnChannel.channels never classify", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.99 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	// #pi-proj is joined but not listed in wakeOnChannel.channels.
	srv.say(":carol!u@h PRIVMSG #pi-proj :research this please");
	await sleep(50);
	assert.equal(clf.calls.length, 0, "out-of-scope channel skipped");
	assert.equal(wakes.length, 0);
});

test("own lines never wake, even with a mention", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.99 });
	const { srv, session } = await boot({ classifier: clf.fn });
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":pi-main-s1!pi@h PRIVMSG #lounge :I said pi-main-s1 myself");
	await sleep(50);
	assert.equal(wakes.length, 0, "self-line skipped");
	assert.equal(clf.calls.length, 0);
});

test("no classifier wired: mentions still wake, plain lines do not", async () => {
	const { srv, session } = await boot({});
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :anyone fancy lunch?");
	await sleep(50);
	assert.equal(wakes.length, 0, "plain line, no classifier → no wake");
	srv.say(":carol!u@h PRIVMSG #lounge :pi-main-s1 ping");
	await sleep(50);
	assert.equal(wakes.length, 1, "mention works without classifier");
});

test("classifier receives channel context, not just the line", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.9 });
	const { srv, session } = await boot({ classifier: clf.fn });
	session.on("wake", () => {});
	srv.say(":carol!u@h PRIVMSG #lounge :we are debugging the roster");
	srv.say(":dave!u@h PRIVMSG #lounge :roster TTL seems short");
	await sleep(50);
	assert.ok(clf.calls.length > 0);
	const call = clf.calls.at(-1);
	assert.equal(call.channel, "#lounge");
	assert.equal(call.capabilities, "research questions and source finding");
	assert.ok(
		call.context.some((l) => l.startsWith("carol: ")),
		`context includes preceding lines: ${JSON.stringify(call.context)}`,
	);
});

test("quiet window: a second qualifying line within 5s does not double-wake", async () => {
	const { srv, session } = await boot({});
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :pi-main-s1 first");
	await sleep(50);
	srv.say(":carol!u@h PRIVMSG #lounge :pi-main-s1 second");
	await sleep(50);
	assert.equal(wakes.length, 1, "quiet window suppresses the immediate follow-up");
});

test("attachClassifier upgrades a live session built without one", async () => {
	const clf = spyClassifier({ ok: true, confidence: 0.9 });
	const { srv, session } = await boot({}); // no classifier wired at boot
	const wakes = [];
	session.on("wake", (w) => wakes.push(w));
	srv.say(":carol!u@h PRIVMSG #lounge :research ergo history retention");
	await sleep(50);
	assert.equal(wakes.length, 0, "before attach: plain line cannot wake");
	session.attachClassifier(clf.fn);
	srv.say(":carol!u@h PRIVMSG #lounge :please research ergo history retention");
	await sleep(50);
	assert.equal(clf.calls.length, 1, "attached classifier consulted");
	assert.equal(wakes.length, 1, "after attach: relevant line wakes");
});
