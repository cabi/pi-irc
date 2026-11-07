/**
 * pi-irc configuration: `~/.pi/agent/pi-irc.json` (admin-owned) merged with
 * `<project>/.pi/pi-irc.json` (project overrides), validated loudly with the
 * offending key. A missing global file disables the extension (one log line);
 * a missing project file is normal.
 *
 * Trust boundary: the project file is only as trustworthy as its repo.
 * `server`, `auth`, `nick`, and `delivery` (identity, transport, wake trust)
 * are GLOBAL-ONLY — project settings there are ignored with a warning.
 * Project files shape participation: `channels`, `capabilities`, `history`,
 * `slug`. Merge order: defaults ← global ← project (allowed sections only),
 * shallow per section; arrays replace (never concatenate — a project's
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./errors.ts";

export interface ServerConfig {
	host: string;
	port: number;
	tls: boolean;
	/** Env var name the server password is resolved from at connect time. */
	passwordEnv?: string;
	/** TLS only: accept self-signed / internal-CA certificates (default false). */
	tlsInsecure?: boolean;
	/** TLS only: SNI server name override (behind proxies / port-forwards). */
	/** TLS only: PEM file with the trusted internal CA / self-signed leaf ("~" allowed). */
	tlsCaFile?: string;
	tlsServerName?: string;
}

export interface AuthConfig {
	username: string;
	/** Inline password — local test servers only; prefer passwordEnv. */
	password?: string;
	/** Env var name the SASL password is resolved from at connect time. */
	passwordEnv?: string;
}

export interface NickConfig {
	template: string;
	maxLen: number;
}

export interface ChannelsConfig {
	projectTemplate: string;
	defaults: string[];
	autoCreate: boolean;
	topicTemplate: string;
	/** Delay before rejoining after a self-kick. 0 disables rejoining. */
	kickRejoinDelayMs: number;
}

export interface CapabilitiesConfig {
	/** IRCv3 capabilities to request during registration. */
	request: string[];
}

export interface HistoryConfig {
	/**
	 * Lines fetched per channel on join (CHATHISTORY LATEST, needs the
	 * draft/chathistory cap). 0 disables automatic catch-up; the irc tool's
	 * `history` op still works when the server supports it.
	 */
	catchupLimit: number;
}

export interface DeliveryConfig {
	/**
	 * Wake trust: nick globs (case-insensitive, `*` wildcard) allowed to wake
	 * this session via DM. Default-deny: a peer wakes only when it matches a
	 * glob or holds a services account (extended-join; SASL-authenticated —
	 * the one IRC identity that costs a password). Self-declared agent
	 * realname metadata never wakes. On a server without services, list the
	 * trusted nicks/globs here explicitly.
	 */
	wakeAllowNicks: string[];
	/**
	 * Wake-trust tier (P17). `account` (default, the P15-b behavior): any
	 * services-account holder wakes; `project`: additionally requires agent
	 * metadata, our project slug, and project-channel membership; `none`:
	 * allowlist globs only. The allowlist applies in every tier.
	 */
	wakeTrust: "none" | "account" | "project";
	/**
	 * P18: per-agent channel wake. Each session classifies channel chatter
	 * against its own `capabilities` and wakes itself — no central router.
	 * Omit entirely to keep channel traffic as passive buffer content.
	 */
	wakeOnChannel?: WakeOnChannelConfig;
	bufferMax: number;
	wakeOnDirectMessage: boolean;
	chunkLongSends: boolean;
	/** Flood-control token bucket: free messages before throttling (1–100). */
	burst: number;
	/** Milliseconds between messages once the burst is spent (100–60 000). */
	intervalMs: number;
	/** Upper bound on queued chunks; sends beyond it fail loudly (1–100 000). */
	maxQueue: number;
}

export interface PiIrcConfig {
	server: ServerConfig;
	/** SASL PLAIN identity — omit for anonymous local servers. */
	auth?: AuthConfig;
	nick: NickConfig;
	channels: ChannelsConfig;
	capabilities: CapabilitiesConfig;
	delivery: DeliveryConfig;
	history: HistoryConfig;
	/** Sanitized project directory name (or explicit `slug` override). */
	projectSlug: string;
}

/** Thrown with the offending key when a config file is wrong. */
export class ConfigError extends Error {
	constructor(
		public readonly key: string,
		message: string,
	) {
		super(`${key}: ${message}`);
		this.name = "ConfigError";
	}
}

/** Fallbacks for every optional config field (see the *Config interfaces). */
type Defaults = {
	server: Pick<ServerConfig, "port" | "tls">;
	nick: NickConfig;
	channels: ChannelsConfig;
	capabilities: CapabilitiesConfig;
	delivery: DeliveryConfig;
	history: HistoryConfig;
};

const DEFAULTS: Defaults = {
	server: { port: 6697, tls: true },
	nick: { template: "pi-{role}-{shortId}", maxLen: 30 },
	channels: {
		projectTemplate: "#pi-{slug}",
		defaults: [],
		autoCreate: true,
		topicTemplate: "pi project {slug} — created {date}",
		kickRejoinDelayMs: 3_000,
	},
	// IRCv3 caps to request; unknown ones are answered with CAP NAK and skipped.
	capabilities: {
		request: ["extended-join", "server-time", "away-notify", "batch", "draft/chathistory"],
	},
	delivery: {
		bufferMax: 500,
		wakeOnDirectMessage: true,
		chunkLongSends: true,
		wakeAllowNicks: [],
		wakeTrust: "account",
		burst: 8,
		intervalMs: 1000,
		maxQueue: 512,
	},
	history: { catchupLimit: 50 },
};

export const GLOBAL_CONFIG_FILE = "pi-irc.json";

const CHANNEL_NAME = /^[#&][^\s,]+$/;

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Directory name → config slug: lowercase, `[a-z0-9-]`, collapsed, ≤20 chars. */
export function projectSlug(dirName: string): string {
	const slug = dirName
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20)
		.replace(/-+$/, "");

	return slug || "project";
}

type Json = Record<string, unknown>;

/**
 * Strip JSONC conveniences outside string literals: line comments,
 * block comments, and trailing commas before a closing brace or
 * bracket (or end of input). Character-scanning (not regex) so a
 * `//` inside a string value survives untouched.
 */
function stripJsonc(text: string): string {
	const noComments = stripComments(text);

	return stripTrailingCommas(noComments);
}

function stripComments(text: string): string {
	let out = "";
	let inString = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			out += ch;

			if (ch === "\\") i++; // escaped char (e.g. \" or \\)
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}

		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue; // keep the newline itself
		}

		if (ch === "/" && text[i + 1] === "*") {
			i += 2;

			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++; // consume the trailing slash
			continue;
		}

		out += ch;
	}

	return out;
}

function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			out += ch;

			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;

			while (j < text.length && /\s/.test(text[j])) j++;

			if (j >= text.length || text[j] === "}" || text[j] === "]") continue;
		}

		out += ch;
	}

	return out;
}

function readJson(file: string, label: string): Json {
	let raw: string;

	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		throw new ConfigError(label, "file is not readable");
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		// Humans write JSONC: trailing commas, // line and /* block */
		// comments. Try once more with those stripped (string-aware —
		// never touches comment markers inside string values).
		try {
			parsed = JSON.parse(stripJsonc(raw));
		} catch (e) {
			throw new ConfigError(label, `invalid JSON (${errorMessage(e)})`);
		}
	}

	if (!isJsonObject(parsed)) {
		throw new ConfigError(label, "expected a JSON object");
	}

	return parsed;
}

/** Plain JSON object (arrays and null rejected) — the shape every section must have. */
function isJsonObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

const WAKE_TRUST_TIERS = ["none", "account", "project"] as const;

const WAKE_TRUST_SET: ReadonlySet<string> = new Set<string>(WAKE_TRUST_TIERS);

function isWakeTrust(value: unknown): value is (typeof WAKE_TRUST_TIERS)[number] {
	return typeof value === "string" && WAKE_TRUST_SET.has(value);
}

/** Validated `delivery.wakeOnChannel` (P18). All fields defaulted; the
 * object's presence alone enables channel wakes for the listed channels. */
export interface WakeOnChannelConfig {
	/** Participating channels; each must be a channel this session joins. */
	channels: string[];
	/** This agent's speciality in plain words — the classifier's only prompt. */
	capabilities: string;
	/** Classifier model id (`provider/model`); empty = first available classifier. */
	classifier: string;
	/** Calibrated-confidence floor for waking (0–1). */
	confidence: number;
	/** Preceding channel lines passed as context (0–20). */
	contextLines: number;
}

function parseWakeOnChannel(key: string, value: unknown): WakeOnChannelConfig | undefined {
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) throw new ConfigError(key, "expected an object");
	if (!isNonEmptyString(value.capabilities)) {
		throw new ConfigError(`${key}.capabilities`, "expected a non-empty string describing this agent's speciality");
	}
	const channels = channelList(`${key}.channels`, value.channels);
	if (channels.length === 0) throw new ConfigError(`${key}.channels`, "expected at least one channel");
	return {
		channels,
		capabilities: str(`${key}.capabilities`, value.capabilities),
		classifier: isNonEmptyString(value.classifier) ? value.classifier : "",
		confidence: value.confidence === undefined ? 0.5 : int(`${key}.confidence`, value.confidence, 0, 1),
		contextLines: value.contextLines === undefined ? 5 : int(`${key}.contextLines`, value.contextLines, 0, 20),
	};
}

function str(key: string, value: unknown): string {
	if (!isNonEmptyString(value)) throw new ConfigError(key, "expected a non-empty string");

	return value;
}

function int(key: string, value: unknown, min: number, max: number): number {
	if (!isIntInRange(value, min, max)) throw new ConfigError(key, `expected an integer ${min}–${max}`);

	return value;
}

function bool(key: string, value: unknown): boolean {
	if (!isBoolean(value)) throw new ConfigError(key, "expected a boolean");

	return value;
}

function channelList(key: string, value: unknown): string[] {
	if (!Array.isArray(value)) throw new ConfigError(key, "expected an array of channel names");

	return value.map((v, i) => {
		const name = str(`${key}[${i}]`, v);

		if (!CHANNEL_NAME.test(name) || name.length > 200) {
			throw new ConfigError(`${key}[${i}]`, `not a valid channel name: ${JSON.stringify(name)}`);
		}

		return name;
	});
}

/** List of plain non-empty strings, no channel-name syntax imposed. */
function strList(key: string, value: unknown): string[] {
	if (!Array.isArray(value)) throw new ConfigError(key, "expected an array of strings");

	return value.map((v, i) => str(`${key}[${i}]`, v));
}

/** One merged section: object shape re-checked, absent → empty object. */
function section(merged: Json, name: string): Json {
	const value = merged[name];

	if (value === undefined) return {};

	if (!isJsonObject(value)) throw new ConfigError(name, "expected an object");

	return value;
}

/**
 * Loads and validates the merged configuration.
 * Returns `null` when the global config file does not exist (extension disabled).
 * @param globalPath path to the admin-owned global file
 * @param projectPath path to the project override file (optional)
 * @param projectDir the project directory (slug source); omit for headless config tests
 */
export function loadConfig(opts: {
	globalPath: string;
	projectPath?: string;
	projectDir?: string;
}): PiIrcConfig | null {
	const globalFile = opts.globalPath;

	if (!fs.existsSync(globalFile)) return null;

	const global = readJson(globalFile, "global config");
	let project: Json = {};

	if (opts.projectPath && fs.existsSync(opts.projectPath)) {
		project = readJson(opts.projectPath, "project config");
	}

	const slugOverride = [project.slug, global.slug].find((s) => s !== undefined);
	// Trust boundary: a project file lives in the repo and is only as
	// trustworthy as the repo. Identity, transport, and trust settings
	// (server, nick,  auth) come from the admin's global file
	// alone; project files may only shape channel participation and
	// catch-up ( capabilities, history, slug).
	const PROJECT_ALLOWED = new Set(["channels", "capabilities", "history"]);
	const merged: Json = {};

	for (const section of ["server", "nick", "channels", "capabilities", "delivery", "history"] as const) {
		const g = global[section];
		const p = project[section];

		if (g !== undefined && !isJsonObject(g)) {
			throw new ConfigError(section, "expected an object");
		}

		if (p !== undefined && !isJsonObject(p)) {
			throw new ConfigError(section, "expected an object");
		}

		if (p !== undefined && !PROJECT_ALLOWED.has(section)) {
			console.warn(`pi-irc: ignoring "${section}" in project config — admin-owned, set it in the global config`);
			merged[section] = { ...g };
			continue;
		}

		merged[section] = { ...g, ...p };
	}

	// auth was never part of the merge (a P14 finding): it is global-only.
	if (global.auth !== undefined) {
		if (!isJsonObject(global.auth)) {
			throw new ConfigError("auth", "expected an object");
		}

		merged.auth = global.auth;
	}

	if (project.auth !== undefined) {
		console.warn('pi-irc: ignoring "auth" in project config — admin-owned, set it in the global config');
	}

	const server = section(merged, "server");
	const nick = section(merged, "nick");
	const channels = section(merged, "channels");
	const capabilities = section(merged, "capabilities");
	const delivery = section(merged, "delivery");
	const wakeOnChannel = parseWakeOnChannel("delivery.wakeOnChannel", delivery.wakeOnChannel);
	const history = section(merged, "history");

	const historyCatchup =
		history.catchupLimit !== undefined
			? int("history.catchupLimit", history.catchupLimit, 0, 1000)
			: DEFAULTS.history.catchupLimit;

	const host = server.host !== undefined ? str("server.host", server.host) : undefined;

	if (host === undefined) {
		throw new ConfigError("server.host", "required and admin-owned (set it in the global config)");
	}

	const passwordEnv = server.passwordEnv !== undefined ? str("server.passwordEnv", server.passwordEnv) : undefined;

	const tlsInsecure = server.tlsInsecure !== undefined ? bool("server.tlsInsecure", server.tlsInsecure) : undefined;

	const tlsServerName =
		server.tlsServerName !== undefined ? str("server.tlsServerName", server.tlsServerName) : undefined;

	const tlsCaFile = server.tlsCaFile !== undefined ? str("server.tlsCaFile", server.tlsCaFile) : undefined;

	if (tlsCaFile !== undefined && tlsInsecure) {
		throw new ConfigError("server.tlsCaFile", "set either tlsCaFile (verify) or tlsInsecure (skip) — not both");
	}

	let auth: AuthConfig | undefined;
	const authRaw = isJsonObject(merged.auth) ? merged.auth : undefined;

	if (authRaw !== undefined) {
		const password = authRaw.password !== undefined ? str("auth.password", authRaw.password) : undefined;

		const authPasswordEnv =
			authRaw.passwordEnv !== undefined ? str("auth.passwordEnv", authRaw.passwordEnv) : undefined;

		if ((password !== undefined) === (authPasswordEnv !== undefined)) {
			throw new ConfigError("auth", "set exactly one of auth.password or auth.passwordEnv");
		}

		auth = {
			username: str("auth.username", authRaw.username),
			...(password !== undefined ? { password } : { passwordEnv: authPasswordEnv }),
		};
	}

	const config: PiIrcConfig = {
		server: {
			host,
			port: int("server.port", server.port ?? DEFAULTS.server.port, 1, 65535),
			tls: bool("server.tls", server.tls ?? DEFAULTS.server.tls),
			passwordEnv,
			...(tlsInsecure !== undefined ? { tlsInsecure } : {}),
			...(tlsServerName !== undefined ? { tlsServerName } : {}),
			...(tlsCaFile !== undefined ? { tlsCaFile } : {}),
		},
		...(auth ? { auth } : {}),
		nick: {
			template: str("nick.template", nick.template ?? DEFAULTS.nick.template),
			maxLen: int("nick.maxLen", nick.maxLen ?? DEFAULTS.nick.maxLen, 1, 50),
		},
		channels: {
			projectTemplate: str("channels.projectTemplate", channels.projectTemplate ?? DEFAULTS.channels.projectTemplate),
			defaults: channelList("channels.defaults", channels.defaults ?? DEFAULTS.channels.defaults),
			autoCreate: bool("channels.autoCreate", channels.autoCreate ?? DEFAULTS.channels.autoCreate),
			topicTemplate: str("channels.topicTemplate", channels.topicTemplate ?? DEFAULTS.channels.topicTemplate),
			kickRejoinDelayMs: int(
				"channels.kickRejoinDelayMs",
				channels.kickRejoinDelayMs ?? DEFAULTS.channels.kickRejoinDelayMs,
				0,
				600_000,
			),
		},
		capabilities: {
			request:
				capabilities.request !== undefined
					? strList("capabilities.request", capabilities.request)
					: DEFAULTS.capabilities.request,
		},
		delivery: {
			bufferMax: int("delivery.bufferMax", delivery.bufferMax ?? DEFAULTS.delivery.bufferMax, 1, 100_000),
			burst: int("delivery.burst", delivery.burst ?? DEFAULTS.delivery.burst, 1, 100),
			intervalMs: int("delivery.intervalMs", delivery.intervalMs ?? DEFAULTS.delivery.intervalMs, 100, 60_000),
			maxQueue: int("delivery.maxQueue", delivery.maxQueue ?? DEFAULTS.delivery.maxQueue, 1, 100_000),
			wakeOnDirectMessage: bool(
				"delivery.wakeOnDirectMessage",
				delivery.wakeOnDirectMessage ?? DEFAULTS.delivery.wakeOnDirectMessage,
			),
			chunkLongSends: bool("delivery.chunkLongSends", delivery.chunkLongSends ?? DEFAULTS.delivery.chunkLongSends),
			wakeAllowNicks:
				delivery.wakeAllowNicks !== undefined
					? strList("delivery.wakeAllowNicks", delivery.wakeAllowNicks)
					: DEFAULTS.delivery.wakeAllowNicks,
			wakeTrust: isWakeTrust(delivery.wakeTrust) ? delivery.wakeTrust : DEFAULTS.delivery.wakeTrust,
			...(wakeOnChannel !== undefined ? { wakeOnChannel } : {}),
		},
		history: { catchupLimit: historyCatchup },
		projectSlug: isNonEmptyString(slugOverride)
			? slugOverride.toLowerCase()
			: projectSlug(path.basename(opts.projectDir ?? path.dirname(opts.globalPath))),
	};

	if (!CHANNEL_NAME.test(renderChannelName(config.channels.projectTemplate, config.projectSlug))) {
		throw new ConfigError(
			"channels.projectTemplate",
			`does not render to a channel name for slug "${config.projectSlug}"`,
		);
	}

	return config;
}

/**
 * Renders `{placeholder}` templates. Unknown placeholders pass through untouched
 * so custom nick/channel schemes stay possible without code changes.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export function renderChannelName(projectTemplate: string, slug: string): string {
	return renderTemplate(projectTemplate, { slug });
}

export { SLUG as SLUG_PATTERN };
