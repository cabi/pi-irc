// config loading: defaults, layering (global ← project), loud validation with
// the offending key, disable-on-missing-global, slug sanitization.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { loadConfig, projectSlug, renderChannelName, ConfigError } = await loadViaPi(repoFile("lib", "config.ts"));

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-irc-cfg-"));
}

function writeConfig(dir, name, json) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(json));

	return file;
}

function expectConfigError(fn, key) {
	try {
		fn();
	} catch (e) {
		assert.ok(e instanceof ConfigError, `expected ConfigError for ${key}, got: ${e}`);
		assert.equal(e.key, key, `error names the wrong key for ${key}`);

		return;
	}

	assert.fail(`expected ConfigError for ${key}, but loadConfig returned`);
}

test("missing global config disables the extension (null)", () => {
	const dir = tmpDir();
	assert.equal(loadConfig({ globalPath: path.join(dir, "pi-irc.json") }), null);
});

test("project server override is ignored — the global file owns the identity", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", {});
	const projectPath = writeConfig(dir, "project/.pi/pi-irc.json", { server: { host: "irc.test" } });
	// No host from the (only trusted) global file → loud ConfigError, not a
	// silent connection to a repo-chosen server.
	expectConfigError(
		() => loadConfig({ globalPath, projectPath, projectDir: path.join(dir, "project") }),
		"server.host",
	);
});

test("defaults land where files are silent", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", { server: { host: "irc.example.net" } });
	const cfg = loadConfig({ globalPath, projectDir: "/work/My_Project" });
	assert.equal(cfg.nick.template, "pi-{role}-{shortId}");
	assert.equal(cfg.nick.maxLen, 30);
	assert.equal(cfg.channels.projectTemplate, "#pi-{slug}");
	assert.deepEqual(cfg.channels.defaults, []);
	assert.equal(cfg.channels.autoCreate, true);
	assert.equal(cfg.delivery.bufferMax, 500);
	assert.equal(cfg.delivery.wakeOnDirectMessage, true);
	assert.equal(cfg.delivery.chunkLongSends, true);
	assert.equal(cfg.projectSlug, "my-project");
});

test("project section overrides global where allowed; defaults arrays replace, not concat", () => {
	const dir = tmpDir();

	const globalPath = writeConfig(dir, "global.json", {
		server: { host: "irc.example.net", port: 6667 },
		channels: { defaults: ["#pi-lobby"] },
	});

	const projectPath = writeConfig(dir, "project/.pi/pi-irc.json", {
		server: { port: 6697 },
		channels: { defaults: ["#pi-project-ops"] },
	});

	const cfg = loadConfig({ globalPath, projectPath, projectDir: path.join(dir, "project") });
	assert.equal(cfg.server.host, "irc.example.net");
	// server is global-only now: the project's port override is ignored.
	assert.equal(cfg.server.port, 6667);
	assert.deepEqual(cfg.channels.defaults, ["#pi-project-ops"]);
});

test("trust boundary: project file cannot set server, auth, nick, or delivery", () => {
	const dir = tmpDir();

	const globalPath = writeConfig(dir, "global.json", {
		server: { host: "irc.example.net", port: 6667, passwordEnv: "IRC_PASS", tlsInsecure: false },
		auth: { username: "agent", passwordEnv: "IRC_PASS" },
		nick: { template: "pi-{role}-{shortId}" },
		delivery: { bufferMax: 100, wakeAllowNicks: ["admin"] },
	});

	const projectPath = writeConfig(dir, "project/.pi/pi-irc.json", {
		server: { host: "evil.example", passwordEnv: "ATTACKER_VAR", tlsInsecure: true },
		auth: { username: "evil", password: "stolen" },
		nick: { template: "evil-{shortId}" },
		delivery: { bufferMax: 1, wakeAllowNicks: ["*"] },
	});

	const cfg = loadConfig({ globalPath, projectPath, projectDir: path.join(dir, "project") });
	assert.equal(cfg.server.host, "irc.example.net");
	assert.equal(cfg.server.passwordEnv, "IRC_PASS");
	assert.equal(cfg.server.tlsInsecure, false);
	assert.equal(cfg.auth.username, "agent");
	assert.equal(cfg.auth.passwordEnv, "IRC_PASS");
	assert.equal(cfg.nick.template, "pi-{role}-{shortId}");
	assert.equal(cfg.delivery.bufferMax, 100);
	assert.deepEqual(cfg.delivery.wakeAllowNicks, ["admin"]);
});

test("global auth reaches the config (was silently dropped by the merge)", () => {
	const dir = tmpDir();

	const globalPath = writeConfig(dir, "global.json", {
		server: { host: "irc.example.net" },
		auth: { username: "agent", passwordEnv: "IRC_PASS" },
	});

	const cfg = loadConfig({ globalPath, projectDir: dir });
	assert.equal(cfg.auth?.username, "agent");
	assert.equal(cfg.auth?.passwordEnv, "IRC_PASS");
});

test("project-local keys (channels, capabilities, history) still override", () => {
	const dir = tmpDir();

	const globalPath = writeConfig(dir, "global.json", {
		server: { host: "irc.example.net" },
		channels: { defaults: ["#pi-lobby"] },
		capabilities: { request: ["extended-join"] },
		history: { catchupLimit: 50 },
	});

	const projectPath = writeConfig(dir, "project/.pi/pi-irc.json", {
		channels: { defaults: ["#pi-project-ops"] },
		capabilities: { request: ["extended-join", "server-time"] },
		history: { catchupLimit: 5 },
	});

	const cfg = loadConfig({ globalPath, projectPath, projectDir: path.join(dir, "project") });
	assert.deepEqual(cfg.channels.defaults, ["#pi-project-ops"]);
	assert.deepEqual(cfg.capabilities.request, ["extended-join", "server-time"]);
	assert.equal(cfg.history.catchupLimit, 5);
});

test("explicit project slug wins over directory name", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", { server: { host: "h" } });
	const projectPath = writeConfig(dir, "project/.pi/pi-irc.json", { slug: "custom-slug" });
	const cfg = loadConfig({ globalPath, projectPath, projectDir: path.join(dir, "project") });
	assert.equal(cfg.projectSlug, "custom-slug");
});

test("wrong values fail loudly with the offending key", () => {
	const dir = tmpDir();

	const cases = [
		[{ server: { host: 5 } }, "server.host"],
		[{ server: { host: "h", port: 0 } }, "server.port"],
		[{ server: { host: "h", tls: "yes" } }, "server.tls"],
		[{ server: { host: "h" }, nick: { maxLen: 99 } }, "nick.maxLen"],
		[{ server: { host: "h" }, channels: { defaults: ["lobby"] } }, "channels.defaults[0]"],
		[{ server: { host: "h" }, channels: { defaults: [42] } }, "channels.defaults[0]"],
		[{ server: { host: "h" }, delivery: { bufferMax: 0 } }, "delivery.bufferMax"],
	];

	for (const [body, key] of cases) {
		const globalPath = writeConfig(dir, `bad-${key.replace(/\W/g, "_")}.json`, body);
		expectConfigError(() => loadConfig({ globalPath, projectDir: dir }), key);
	}
});

test("missing server.host is named, not generic", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "empty.json", {});
	expectConfigError(() => loadConfig({ globalPath, projectDir: dir }), "server.host");
});

test("invalid JSON names the file", () => {
	const dir = tmpDir();
	const globalPath = path.join(dir, "broken.json");
	fs.writeFileSync(globalPath, "{ nope");
	assert.throws(() => loadConfig({ globalPath, projectDir: dir }), /invalid JSON/);
});

test("projectTemplate must render to a channel name", () => {
	const dir = tmpDir();

	const globalPath = writeConfig(dir, "t.json", {
		server: { host: "h" },
		channels: { projectTemplate: "{slug}" },
	});

	expectConfigError(() => loadConfig({ globalPath, projectDir: dir }), "channels.projectTemplate");
});

test("projectSlug sanitizes directory names", () => {
	assert.equal(projectSlug("My_Project"), "my-project");
	assert.equal(projectSlug("pi.hashline edit pro!"), "pi-hashline-edit-pro");
	assert.equal(projectSlug("---"), "project");
	assert.equal(projectSlug("ÄÖÜ Project"), "project");
	assert.equal(projectSlug("a".repeat(50)).length, 20);
});

test("renderChannelName joins slug into template", () => {
	assert.equal(renderChannelName("#pi-{slug}", "demo"), "#pi-demo");
});

function writeRawConfig(dir, name, text) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);

	return file;
}

test("jsonc tolerated: trailing commas and // comments in configs", () => {
	const dir = tmpDir();

	const globalPath = writeRawConfig(
		dir,
		"global.json",
		`{
			// Carsten's local InspIRCd
			"server": {
				"host": "localhost",
				"port": 6667,
				"tls": false,
			},
			"nick": { "template": "pi-//not-a-comment" },
		}`,
	);

	const cfg = loadConfig({ globalPath, projectDir: dir });
	assert.equal(cfg.server.host, "localhost");
	assert.equal(cfg.server.port, 6667);
	assert.equal(cfg.server.tls, false);
	assert.equal(cfg.nick.template, "pi-//not-a-comment");
});

test("jsonc tolerated: block comments and trailing comma in arrays", () => {
	const dir = tmpDir();

	const globalPath = writeRawConfig(
		dir,
		"global.json",
		`{
			"server": { "host": "h", "port": 6697, "tls": true },
			"channels": {
				"defaults": ["#ops", "#lounge",],
			}, /* block comment */
		}`,
	);

	const cfg = loadConfig({ globalPath, projectDir: dir });
	assert.deepEqual(cfg.channels.defaults, ["#ops", "#lounge"]);
});

test("genuinely broken configs still fail loudly", () => {
	const dir = tmpDir();
	const globalPath = writeRawConfig(dir, "global.json", `{ "server": { "host": `);
	expectConfigError(() => loadConfig({ globalPath, projectDir: dir }), "global config");
});

test("delivery flood keys: defaults, clamping, project merge", () => {
	const dir = tmpDir();

test("wakeOnChannel: parsed with defaults when present", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", { server: { host: "irc.test" }, delivery: { wakeOnChannel: { channels: ["#lounge"], capabilities: "research" } } });
	const config = loadConfig({ globalPath, projectDir: dir });
	assert.deepEqual(config.delivery.wakeOnChannel, {
		channels: ["#lounge"],
		capabilities: "research",
		classifier: "",
		confidence: 0.5,
		contextLines: 5,
	});
});

test("wakeOnChannel: absent by default (channel traffic stays passive)", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", { server: { host: "irc.test" } });
	const config = loadConfig({ globalPath, projectDir: dir });
	assert.equal(config.delivery.wakeOnChannel, undefined);
});

test("wakeOnChannel: capabilities and channels are mandatory", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", {
		server: { host: "irc.test" },
		delivery: { wakeOnChannel: { channels: ["#lounge"] } },
	});
	expectConfigError(() => loadConfig({ globalPath, projectDir: dir }), "delivery.wakeOnChannel.capabilities");
});

test("wakeOnChannel: confidence must stay within 0–1", () => {
	const dir = tmpDir();
	const globalPath = writeConfig(dir, "global.json", {
		server: { host: "irc.test" },
		delivery: { wakeOnChannel: { channels: ["#lounge"], capabilities: "research", confidence: 1.5 } },
	});
	expectConfigError(() => loadConfig({ globalPath, projectDir: dir }), "delivery.wakeOnChannel.confidence");
});
	const globalPath = writeConfig(dir, "global.json", { server: { host: "irc.example.net" } });
	const cfg = loadConfig({ globalPath, projectDir: "/work/My_Project" });
	assert.equal(cfg.delivery.burst, 8);
	assert.equal(cfg.delivery.intervalMs, 1000);
	assert.equal(cfg.delivery.maxQueue, 512);

	// delivery is global-only (P15-a trust boundary): a project file trying
	// to retune it is ignored with a warning, never merged.
	const projectPath = writeConfig(path.join(dir, "p"), ".pi/pi-irc.json", {
		delivery: { burst: 2, intervalMs: 500 },
	});

	const projCfg = loadConfig({ globalPath, projectPath, projectDir: path.join(dir, "p") });
	assert.equal(projCfg.delivery.burst, 8, "project delivery section ignored");
	assert.equal(projCfg.delivery.intervalMs, 1000);

	expectConfigError(
		() =>
			loadConfig({
				globalPath: writeConfig(dir, "bad.json", { server: { host: "irc.example.net" }, delivery: { burst: 0 } }),
			}),
		"delivery.burst",
	);
});
