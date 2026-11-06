/**
 * pi-irc configuration: `~/.pi/agent/pi-irc.json` (admin-owned) merged with
 * `<project>/.pi/pi-irc.json` (project overrides), validated loudly with the
 * offending key. A missing global file disables the extension (one log line);
 * a missing project file is normal.
 *
 * Merge: defaults ← global ← project, shallow per section; arrays replace
 * (never concatenate — a project's `channels.defaults` is its answer, not an
 * amendment to the global lobby list).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ServerConfig {
	host: string;
	port: number;
	tls: boolean;
	/** Env var name the server password is resolved from at connect time. */
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
}


export interface CapabilitiesConfig {
	/** IRCv3 capabilities to request during registration. */
	request: string[];
}

export interface DeliveryConfig {
	bufferMax: number;
	wakeOnDirectMessage: boolean;
	chunkLongSends: boolean;
}

export interface PiIrcConfig {
	server: ServerConfig;
	nick: NickConfig;
	channels: ChannelsConfig;
	capabilities: CapabilitiesConfig;
	delivery: DeliveryConfig;
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

const DEFAULTS = {
	server: { port: 6697, tls: true },
	nick: { template: "pi-{shortId}", maxLen: 30 },
	channels: {
		projectTemplate: "#pi-{slug}",
		defaults: [] as string[],
		autoCreate: true,
		topicTemplate: "pi project {slug} — created {date}",
	},
	// IRCv3 caps to request; unknown ones are answered with CAP NAK and skipped.
	capabilities: { request: ["extended-join", "server-time", "away-notify"] as string[] },
	delivery: { bufferMax: 500, wakeOnDirectMessage: true, chunkLongSends: true },
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
	} catch (e) {
		throw new ConfigError(label, `invalid JSON (${(e as Error).message})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError(label, "expected a JSON object");
	}
	return parsed as Json;
}

function str(obj: Json, key: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ConfigError(key, "expected a non-empty string");
	}
	return value;
}

function int(obj: Json, key: string, value: unknown, min: number, max: number): number {
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new ConfigError(key, `expected an integer ${min}–${max}`);
	}
	return value as number;
}

function bool(obj: Json, key: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw new ConfigError(key, "expected a boolean");
	return value;
}

function channelList(key: string, value: unknown): string[] {
	if (!Array.isArray(value)) throw new ConfigError(key, "expected an array of channel names");
	return value.map((v, i) => {
		const name = str({} as Json, `${key}[${i}]`, v);
		if (!CHANNEL_NAME.test(name) || name.length > 200) {
			throw new ConfigError(`${key}[${i}]`, `not a valid channel name: ${JSON.stringify(name)}`);
		}
		return name;
	});
}

/** List of plain non-empty strings, no channel-name syntax imposed. */
function strList(key: string, value: unknown): string[] {
	if (!Array.isArray(value)) throw new ConfigError(key, "expected an array of strings");
	return value.map((v, i) => str({} as Json, `${key}[${i}]`, v));
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
	const merged: Json = {};
	for (const section of ["server", "nick", "channels", "capabilities", "delivery"] as const) {
		const g = global[section];
		const p = project[section];
		if (g !== undefined && (typeof g !== "object" || g === null || Array.isArray(g))) {
			throw new ConfigError(section, "expected an object");
		}
		if (p !== undefined && (typeof p !== "object" || p === null || Array.isArray(p))) {
			throw new ConfigError(section, "expected an object");
		}
		merged[section] = { ...(g as Json | undefined), ...(p as Json | undefined) };
	}

	const server = merged.server as Json;
	const nick = merged.nick as Json;
	const channels = merged.channels as Json;
	const capabilities = merged.capabilities as Json;
	const delivery = merged.delivery as Json;
	const host = server.host !== undefined ? str(server, "server.host", server.host) : undefined;
	if (host === undefined) {
		throw new ConfigError("server.host", "required (set it in the global or project config)");
	}

	const passwordEnv =
		server.passwordEnv !== undefined ? str(server, "server.passwordEnv", server.passwordEnv) : undefined;

	const config: PiIrcConfig = {
		server: {
			host,
			port: int(server, "server.port", server.port ?? DEFAULTS.server.port, 1, 65535),
			tls: bool(server, "server.tls", server.tls ?? DEFAULTS.server.tls),
			passwordEnv,
		},
		nick: {
			template: str(nick, "nick.template", nick.template ?? DEFAULTS.nick.template),
			maxLen: int(nick, "nick.maxLen", nick.maxLen ?? DEFAULTS.nick.maxLen, 1, 50),
		},
		channels: {
			projectTemplate: str(
				channels,
				"channels.projectTemplate",
				channels.projectTemplate ?? DEFAULTS.channels.projectTemplate,
			),
			defaults: channelList("channels.defaults", channels.defaults ?? DEFAULTS.channels.defaults),
			autoCreate: bool(
				channels,
				"channels.autoCreate",
				channels.autoCreate ?? DEFAULTS.channels.autoCreate,
			),
			topicTemplate: str(
				channels,
				"channels.topicTemplate",
				channels.topicTemplate ?? DEFAULTS.channels.topicTemplate,
			),
		},
		capabilities: {
			request: capabilities.request !== undefined
				? strList("capabilities.request", capabilities.request)
				: DEFAULTS.capabilities.request,
		},
		delivery: {
			bufferMax: int(
				delivery,
				"delivery.bufferMax",
				delivery.bufferMax ?? DEFAULTS.delivery.bufferMax,
				1,
				100_000,
			),
			wakeOnDirectMessage: bool(
				delivery,
				"delivery.wakeOnDirectMessage",
				delivery.wakeOnDirectMessage ?? DEFAULTS.delivery.wakeOnDirectMessage,
			),
			chunkLongSends: bool(
				delivery,
				"delivery.chunkLongSends",
				delivery.chunkLongSends ?? DEFAULTS.delivery.chunkLongSends,
			),
		},
		projectSlug:
			typeof slugOverride === "string" && slugOverride.length > 0
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
