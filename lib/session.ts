/**
 * Session: the composition root that hides IRC behind the product's three
 * promises — zero-call orientation, pull-before-push, background machinery.
 *
 * `IrcSession.connect()` performs the whole bootstrap (config → identity →
 * TCP/TLS + PASS → registration → project-channel join (created implicitly
 * on first JOIN) → optional topic stamp → NAMES/WHO roster seeding) and
 * only then resolves. From that point every inbound line feeds roster,
 * channel state, and message buffers in the background; outbound messages
 * go through the flood-limited delivery queue.
 *
 * Direct messages (and only DMs) raise a throttled "wake" event the
 * extension entry turns into a steer; channel chatter never wakes anyone.
 */
import { EventEmitter } from "node:events";
import type { PiIrcConfig } from "./config.ts";
import { renderChannelName } from "./config.ts";
import type { IdentityContext } from "./identity.ts";
import { buildRegisterIdentity } from "./identity.ts";
import { IrcClient, type Transport } from "./irc-client.ts";
import { IrcSocket } from "./irc-socket.ts";
import { NUMERICS } from "./numerics.ts";
import type { BufferedMessage, ReadOptions } from "./buffer.ts";
import { MessageBuffer } from "./buffer.ts";
import type { Peer } from "./roster.ts";
import { Roster } from "./roster.ts";
import { Channels } from "./channels.ts";
import { DeliveryQueue } from "./delivery.ts";
import { Backoff, type BackoffOptions } from "./reconnect.ts";
import { wire, type IrcMessage } from "./wire.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	AskRegistry,
	ReplyAssembler,
	envelopeParts,
	parseEnvelope,
	type AskResolution,
} from "./rpc.ts";
export interface SessionDeps {
	/** Injectable for tests: an already-registered client (skips PASS/001). */
	client?: IrcClient;
	transport?: Transport;
	now?: () => number;
	/**
	 * Reconnect policy. Default for socket-backed sessions: fresh IrcSocket
	 * per attempt + the server password captured at first connect. Injected
	 * clients only reconnect when a spec is provided explicitly.
	 */
	reconnect?: Partial<ReconnectSpec>;
}

export interface ReconnectSpec {
	transportFactory: () => Transport;
	/** Server password captured at bootstrap (PASS before NICK/USER). */
	password?: string;
	backoff?: BackoffOptions;
	/** Injectable scheduler; returns a cancel function. Default setTimeout. */
	schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
	const t = setTimeout(fn, ms);
	t.unref?.();
	return () => clearTimeout(t);
};

export interface SendResult {
	target: string;
	chunks: number;
	/** Chunks still waiting in the flood-limited queue. */
	pending: number;
}

const BOOT_TIMEOUT_MS = 15_000;

/** Connect arguments shared by the initial connect and every reconnect. */
function connectOptsFor(config: PiIrcConfig): {
	host: string;
	port: number;
	tls: boolean;
	timeoutMs: number;
	rejectUnauthorized?: boolean;
	serverName?: string;
	ca?: Buffer;
} {
	const s = config.server;
	let ca: Buffer | undefined;
	if (s.tls && s.tlsCaFile) {
		const path = s.tlsCaFile.startsWith("~/") ? join(homedir(), s.tlsCaFile.slice(2)) : s.tlsCaFile;
		try {
			ca = readFileSync(path);
		} catch (err) {
			// Fail closed: a configured CA that cannot be read must stop the
			// connect, not silently fall back to the default trust store.
			throw new Error(`server.tlsCaFile unreadable (${path}): ${(err as Error).message}`);
		}
	}
	return {
		host: s.host,
		port: s.port,
		tls: s.tls,
		timeoutMs: BOOT_TIMEOUT_MS,
		...(s.tlsInsecure ? { rejectUnauthorized: false } : {}),
		...(s.tlsServerName ? { serverName: s.tlsServerName } : {}),
		...(ca ? { ca } : {}),
	};
}
// Wake throttle: damp DM bursts, don't suppress distinct turns. Intercom
// parity means a follow-up DM after a settled turn still wakes the peer.
const WAKE_QUIET_MS = 5_000;
const DEFAULT_ASK_TIMEOUT_SEC = 600;
/** Roster ghosts (peers whose departure we never learned) expire after a day. */
const ROSTER_TTL_MS = 24 * 60 * 60 * 1000;
const ROSTER_SWEEP_MS = 60 * 60 * 1000;
/** Batch foreign-join WHO lookups on RFC 2812 servers into one flush. */
const WHO_FLUSH_MS = 500;

export class IrcSession extends EventEmitter {
	readonly config: PiIrcConfig;
	readonly identity: IdentityContext;
	readonly projectChannel: string;
	readonly client: IrcClient;
	readonly roster = new Roster();
	readonly channels = new Channels();
	readonly buffer: MessageBuffer;
	readonly delivery: DeliveryQueue;
	private readonly now: () => number;
	readonly #reconnect: ReconnectSpec | null;
	readonly #backoff: Backoff;
	#cancelScheduled: (() => void) | null = null;
	#reconnectAttempt = 0;
	#cancelKickRejoin: (() => void) | null = null;

/** msgids already buffered — kills replay/live double delivery. */
	#seenMsgIds = new Set<string>();
	/** Pending WHO lookups on servers without extended-join — deduped, flushed in one batch. */
	#whoPending = new Set<string>();
	#whoTimer: ReturnType<typeof setTimeout> | null = null;
	/** Safety-net sweep for roster ghosts QUIT/PART never reported. */
	#rosterSweep: ReturnType<typeof setInterval> | null = null;
	/** Serialized CHATHISTORY fetches (one in flight; later targets queue). */
	#catchupTail: Promise<unknown> = Promise.resolve();
	/** history.catchupLimit resolved once (fixtures may omit the section). */
	#historyLimit = 0;
	#nextAttemptAt: number | null = null;
	private lastWakeAt = 0;
	private stopped = false;
	private topicStampPending = false;
	/** ask/reply correlation (P6); public read for the tool layer. */
	readonly rpc = new AskRegistry();
	readonly #replies = new ReplyAssembler();

	private constructor(
		config: PiIrcConfig,
		identity: IdentityContext,
		client: IrcClient,
		now: () => number,
		reconnect: ReconnectSpec | null,
	) {
		super();
		this.config = config;
		this.identity = identity;
		this.projectChannel = renderChannelName(config.channels.projectTemplate, config.projectSlug);
		this.client = client;
		this.now = now;
		this.#reconnect = reconnect;
		this.#historyLimit = config.history?.catchupLimit ?? 0;
		this.#backoff = new Backoff(reconnect?.backoff);
		this.buffer = new MessageBuffer(config.delivery.bufferMax, client.realNick ?? client.nick);
		this.delivery = new DeliveryQueue(
			(target, text) => this.client.privmsg(target, text),
			{
				burst: config.delivery.burst,
				intervalMs: config.delivery.intervalMs,
				maxChunk: 400,
				maxQueue: config.delivery.maxQueue,
				chunkLong: config.delivery.chunkLongSends,
			},
		);
		this.delivery.onDrop = (target, text, err) =>
			console.warn(`pi-irc: dropped unsendable chunk to ${target} (${err.message}): ${text.slice(0, 60)}…`);
		this.#wireEvents();
		this.delivery.start();
		this.#rosterSweep = setInterval(() => this.roster.expire(ROSTER_TTL_MS), ROSTER_SWEEP_MS);
		this.#rosterSweep.unref?.();
	}

	/**
	 * Full bootstrap. Resolves once the project channel is joined and the
	 * roster seeded; rejects on any hard failure (connect refused,
	 * registration rejected, join failed, WHO timeout).
	 */
	static async connect(
		config: PiIrcConfig,
		identity: IdentityContext,
		deps: SessionDeps = {},
	): Promise<IrcSession> {
		const now = deps.now ?? Date.now;
		const password = config.server.passwordEnv ? process.env[config.server.passwordEnv] : undefined;
		let sasl: { username: string; password: string } | undefined;
		if (config.auth) {
			const saslPassword = config.auth.password ?? process.env[config.auth.passwordEnv ?? ""];
			if (!saslPassword) throw new Error(`SASL password missing (env ${config.auth.passwordEnv ?? "?"} unset)`);
			sasl = { username: config.auth.username, password: saslPassword };
		}
		let client = deps.client;
		if (client) {
			// Injected client: registration is the fixture's business.
			if (client.state !== "registered") {
				throw new Error(`injected client not registered (state: ${client.state})`);
			}
		} else {
			const transport = deps.transport ?? new IrcSocket();
			const reg = buildRegisterIdentity(config.nick, identity);
			client = new IrcClient(
				{
					nick: reg.nick,
					username: reg.username,
					realname: reg.realname,
					nickFallbacks: reg.nickFallbacks,
					pingTimeoutMs: 60_000,
					caps: config.capabilities.request,
					...(sasl ? { sasl } : {}),
				},
				transport,
			);
			await transport.connect(connectOptsFor(config));
			// Waiters attach before registration starts: 001..376 can arrive
			// in a single chunk, and a listener attached after `await` would
			// miss motdEnd entirely.
			const registeredP = onceOrThrow(client, "registered", "error", BOOT_TIMEOUT_MS, "registration");
			const motdP = onceOrThrow(client, "motdEnd", "error", BOOT_TIMEOUT_MS, "registration (MOTD)");
			if (password) client.sendRaw(wire.pass(password));
			client.startRegistration();
			await registeredP;
			await motdP;
		}
		if (deps.client) await onceOrThrow(client, "motdEnd", "error", BOOT_TIMEOUT_MS, "registration (MOTD)");

		// Reconnect policy: real (socket-backed) sessions always get one;
		// injected test clients only when the fixture provides a factory.
		const reconnect: ReconnectSpec | null = deps.client
			? (deps.reconnect?.transportFactory ? ({ ...deps.reconnect } as ReconnectSpec) : null)
			: { transportFactory: () => new IrcSocket(), password, ...deps.reconnect };

		const session = new IrcSession(config, identity, client, now, reconnect);

		// Join the project channel (+ any extra defaults). The channel is
		// created by the server on first JOIN — nothing else to bootstrap.
		// Waiters attach before the command so the (synchronous in tests,
		// async on a socket) join echoes cannot slip past them.
		const chan = session.projectChannel;
		const extra = config.channels.defaults.filter((c) => c.toLowerCase() !== chan.toLowerCase());
		const projectJoined = onceOrThrow<{ self: boolean; channel: string }>(
			client, "join", "error", BOOT_TIMEOUT_MS, `joining ${chan}`,
			(e) => e.self && e.channel.toLowerCase() === chan.toLowerCase(),
		);
		const extrasJoined = extra.map((c) => onceOrThrow<{ self: boolean; channel: string }>(
			client, "join", "error", BOOT_TIMEOUT_MS, `joining ${c}`,
			(e) => e.self && e.channel.toLowerCase() === c.toLowerCase(),
		));
		client.join([chan, ...extra]);
		await projectJoined;
		await Promise.all(extrasJoined);

		// Seed the roster: WHO returns realnames → agent/human mapping.
		client.who(chan);
		await onceOrThrow<IrcMessage>(client, "message", "error", BOOT_TIMEOUT_MS, `WHO ${chan}`, (m) =>
			m.command === String(NUMERICS.RPL_ENDOFWHO) && m.params[1]?.toLowerCase() === chan.toLowerCase(),
		);

		// Topic stamp on a fresh channel. Ergo (and others) only answer a
		// topic QUERY with 331 — they don't volunteer it on JOIN — so ask.
		if (config.channels.autoCreate) {
			client.topic(chan);
			await onceOrThrow<IrcMessage>(client, "message", "error", BOOT_TIMEOUT_MS, `TOPIC ${chan}`, (m) =>
				(m.command === String(NUMERICS.RPL_TOPIC) || m.command === String(NUMERICS.RPL_NOTOPIC)) &&
				m.params[1]?.toLowerCase() === chan.toLowerCase(),
			);
			if (session.topicStampPending) {
				client.topic(chan, renderStamp(config.channels.topicTemplate, config.projectSlug, now()));
				session.topicStampPending = false;
			}
		}
		return session;
	}

	#wireEvents(): void {
		const c = this.client;
		c.on("privmsg", (e) => {
			// msgid dedup: replay overlap and double delivery stop here.
			if (e.msgid) {
				if (this.#seenMsgIds.has(e.msgid)) return;
				this.#seenMsgIds.add(e.msgid);
				if (this.#seenMsgIds.size > 8_000) {
					// Ring eviction, not clear(): a full wipe would reopen the
					// replay/live overlap window for every buffered msgid.
					for (const oldest of this.#seenMsgIds) {
						this.#seenMsgIds.delete(oldest);
						if (this.#seenMsgIds.size <= 8_000) break;
					}
				}
			}
			// Lines inside a batch are server-replayed history: buffered like
			// live ones (so `read` shows them) but never wake anyone.
			const replay = e.batch !== undefined;
			// server-time: trust the server's ISO 8601 stamp when present.
			const ts = e.time !== undefined ? Date.parse(e.time) : undefined;
			const at = ts !== undefined && Number.isFinite(ts) ? ts : undefined;
			if (/^[#&+!]/.test(e.target)) {
				// Channel chatter: buffer under the channel, never wake.
				this.buffer.push({ conv: e.target, from: e.from, text: e.text, ...(at ? { ts: at } : {}) });
				this.roster.touch(e.from);
			} else if (!e.toSelf) {
				// DM to us: envelopes first, plain text second.
				const env = parseEnvelope(e.text);
				if (env?.kind === "ask") {
					const inbound = this.rpc.trackInbound(env.id, e.from, env.body);
					this.buffer.push({
						conv: e.from,
						from: e.from,
						text: `${env.body} [ask id=${env.id}${inbound.resolvedAt === undefined ? ` — reply with: irc reply id=${env.id}` : ""}]`,
						kind: "ask",
						...(at ? { ts: at } : {}),
					});
					this.roster.touch(e.from);
					if (!replay) this.#maybeWake(e.from, env.body);
				} else if (env?.kind === "reply") {
					const joined = this.#replies.add(e.from, env.id, env.part, env.body);
					if (joined !== null && this.rpc.resolveReply(env.id, joined, e.from)) {
						// Answer to one of our waiting asks — no wake: the asker
						// is blocked inside the ask() tool call of a live turn.
						this.buffer.push({
							conv: e.from,
							from: e.from,
							text: joined,
							kind: "reply",
							...(at ? { ts: at } : {}),
						});
						this.roster.touch(e.from);
					} else {
						// Late or foreign reply: surface as a normal DM (wakeable).
						this.buffer.push({
							conv: e.from,
							from: e.from,
							text: e.text,
							kind: "dm",
							...(at ? { ts: at } : {}),
						});
					this.roster.touch(e.from);
					if (!replay) this.#maybeWake(e.from, e.text);
					}
				} else {
					// DM to us: buffer under the sender's nick, consider a wake.
					this.buffer.push({
						conv: e.from,
						from: e.from,
						text: e.text,
						kind: "dm",
						...(at ? { ts: at } : {}),
					});
					this.roster.touch(e.from);
					if (!replay) this.#maybeWake(e.from, e.text);
				}
			}
			// Our own echoes (toSelf) are already accounted for by send().
		});
		c.on("notice", (e) => {
			// Notices carry no reliable channel routing; file under sender.
			this.buffer.push({ conv: e.from || "server", from: e.from || "server", text: e.text, kind: "notice" });
		});
		c.on("join", (e) => {
			this.channels.addMember(e.channel, e.nick);
		this.roster.touch(e.nick, e.self
			? { self: true }
			// extended-join account: "*" means logged out; store only real
			// accounts — they authenticate against services and gate wake.
			: e.account !== undefined && e.account !== "*"
				? { account: e.account }
				: {});
		// Self-join = fresh channel view: pull recent history in the
		// background (no-op without draft/chathistory or with limit 0).
		if (e.self && this.#historyLimit > 0) {
			void this.#catchup(e.channel, this.#historyLimit);
		}
			// extended-join hands us the realname with the JOIN itself;
			// only fall back to WHO when the server didn't.
			if (!e.self && e.realname !== undefined) {
				this.roster.applyRealname(e.nick, e.realname);
		} else if (!e.self) {
				this.#queueWho(e.nick); // learn the newcomer's realname (batched)
			}
		});
		c.on("part", (e) => {
			if (e.self) this.channels.part(e.channel);
			else {
				this.channels.removeMember(e.channel, e.nick);
				// Gone from every shared channel → not a peer anymore. (Still
				// sharing one → keep the entry; QUIT remains the hard signal.)
				if (!this.channels.memberAnywhere(e.nick)) this.roster.forget(e.nick);
			}
	});
		c.on("away", (e) => this.roster.touch(e.nick, { away: e.away }));
		c.on("kick", (e) => this.#handleKick(e));
		c.on("quit", (e) => {
			this.channels.removeMemberEverywhere(e.nick);
			this.roster.forget(e.nick);
		});
		c.on("nickChange", (e) => {
			this.channels.renameMember(e.oldNick, e.newNick);
			this.roster.rename(e.oldNick, e.newNick);
		});
		c.on("message", (m) => this.#applyNumeric(m));
		c.on("error", (e) => this.emit("sessionError", e.message));
		c.on("socketClosed", () => this.#onDrop());
	}

	/**
	 * Batch WHO lookups for foreign joins on servers without extended-join:
	 * a busy channel joining dozens of users must not fire WHO per JOIN.
	 * Deduped; one flush per WHO_FLUSH_MS window sends them all.
	 */
	#queueWho(nick: string): void {
		if (this.#whoPending.has(nick)) return;
		this.#whoPending.add(nick);
		if (this.#whoTimer) return;
		this.#whoTimer = setTimeout(() => {
			this.#whoTimer = null;
			const nicks = [...this.#whoPending];
			this.#whoPending.clear();
			for (const n of nicks) this.client.who(n);
		}, WHO_FLUSH_MS);
		this.#whoTimer.unref?.();
	}
	/**
	 * The link died (server restart, network flap, ping timeout). Pause
	 * pacing — queued intent survives — and schedule the first reconnect.
	 */
	#onDrop(): void {
		if (this.stopped || !this.#reconnect) return;
		this.delivery.pause();
		this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		const attempt = (this.#reconnectAttempt += 1);
		const delayMs = this.#backoff.next();
		this.#nextAttemptAt = this.now() + delayMs;
		this.emit("reconnecting", { attempt, delayMs });
		this.#cancelScheduled?.();
		const schedule = this.#reconnect?.schedule ?? defaultSchedule;
		this.#cancelScheduled = schedule(() => {
			void this.#tryReconnect();
		}, delayMs);
	}

	async #tryReconnect(): Promise<void> {
		if (this.stopped || !this.#reconnect) return;
		const attempt = this.#reconnectAttempt;
		try {
			await this.#reestablish();
			this.#backoff.reset();
			this.#cancelScheduled = null;
			this.#nextAttemptAt = null;
			const nick = this.client.realNick;
			this.#reconnectAttempt = 0;
			this.emit("reconnected", { nick, attempt });
		} catch (err) {
			this.emit("sessionError", `reconnect attempt ${attempt} failed: ${(err as Error).message}`);
			this.#scheduleReconnect();
		}
	}

	/** Fresh transport → re-register → rejoin everything → reseed roster → flush queue. */
	async #reestablish(): Promise<void> {
		const spec = this.#reconnect;
		if (!spec) throw new Error("no reconnect policy");
		const transport = spec.transportFactory();
		await transport.connect(connectOptsFor(this.config));
		this.client.attach(transport);
		if (spec.password) this.client.sendRaw(wire.pass(spec.password));
		const registeredP = onceOrThrow(this.client, "registered", "error", BOOT_TIMEOUT_MS, "re-registration");
		const motdP = onceOrThrow(this.client, "motdEnd", "error", BOOT_TIMEOUT_MS, "re-registration (MOTD)");
		this.client.startRegistration();
		await registeredP;
		await motdP;

		// Rejoin every channel we still hold locally — the server forgot us.
		// JOIN even where channels.joined() says yes: local state survived,
		// server-side membership did not.
		const chans = this.channels.list().map((ch) => ch.name);
		if (chans.length > 0) {
			const echoes = chans.map((ch) =>
				onceOrThrow<{ self: boolean; channel: string }>(
					this.client, "join", "error", BOOT_TIMEOUT_MS, `rejoining ${ch}`,
					(e) => e.self && e.channel.toLowerCase() === ch.toLowerCase(),
				),
			);
			this.client.join(chans);
			await Promise.all(echoes);
			for (const ch of chans) {
				this.client.who(ch);
				await onceOrThrow<IrcMessage>(this.client, "message", "error", BOOT_TIMEOUT_MS, `WHO ${ch}`, (m) =>
					m.command === String(NUMERICS.RPL_ENDOFWHO) && m.params[1]?.toLowerCase() === ch.toLowerCase(),
				);
			}
		}

		this.delivery.resume(); // unpause and flush whatever queued while down
	}

	/**
	 * A self-kick is an involuntary PART: drop membership now, leave one
	 * system line in the channel buffer (the agent sees why on next read),
	 * and rejoin after `channels.kickRejoinDelayMs` — 0 stays out. Someone
	 * else getting kicked only updates our membership view.
	 */
	#handleKick(e: { nick: string; by: string; channel: string; reason: string; self: boolean }): void {
		if (!e.self) {
			this.channels.removeMember(e.channel, e.nick);
			return;
		}
		this.channels.part(e.channel);
		this.buffer.push({
			conv: e.channel,
			from: e.by,
			text: `kicked by ${e.by}${e.reason ? `: ${e.reason}` : ""} — rejoining`,
			kind: "system",
		});
		this.emit("kicked", { channel: e.channel, by: e.by, reason: e.reason });
		this.#cancelKickRejoin?.();
		this.#cancelKickRejoin = null;
		const delay = this.config.channels.kickRejoinDelayMs;
		if (delay <= 0 || this.stopped) return;
		this.#cancelKickRejoin = defaultSchedule(() => {
			this.#cancelKickRejoin = null;
			if (this.stopped) return;
			this.client.join([e.channel]);
		}, delay);
	}
	#applyNumeric(m: { command: string; params: string[] }): void {
		const p = m.params;
		switch (m.command) {
			case String(NUMERICS.RPL_NAMREPLY): {
				// <me> <symbol> <channel> :nick nick nick
				const chan = p[2] ?? "";
				const names = (p[3] ?? "").split(" ").filter(Boolean);
				this.channels.names(chan, names);
				for (const n of names) this.roster.touch(n.replace(/^[~&@%+]+/, ""));
				break;
			}
			case String(NUMERICS.RPL_TOPIC): {
				this.channels.setTopic(p[1] ?? "", p[2] ?? "");
				this.topicStampPending = false;
				break;
			}
			case String(NUMERICS.RPL_NOTOPIC): {
				if (p[1]?.toLowerCase() === this.projectChannel.toLowerCase()) this.topicStampPending = true;
				break;
			}
		case String(NUMERICS.RPL_UNAWAY): {
			// 305: our own AWAY cleared (or never set).
			this.roster.touch(this.client.realNick ?? this.client.nick, { away: false, self: true });
			this.buffer.push({
				conv: "*",
				from: "*",
				text: "presence: back (no longer away)",
				kind: "system",
			});
			break;
		}
		case String(NUMERICS.RPL_NOWAWAY): {
			// 306: server confirmed our AWAY.
			this.roster.touch(this.client.realNick ?? this.client.nick, { away: true, self: true });
			this.buffer.push({
				conv: "*",
				from: "*",
				text: "presence: marked away (busy)",
				kind: "system",
			});
			break;
		}
		case String(NUMERICS.RPL_WHOREPLY): {
				// <me> <chan> <user> <host> <server> <nick> <flags> :<hop> <gecos>
				const nick = p[5];
				const gecos = p[7] ?? "";
				if (nick) {
					this.roster.applyRealname(nick, gecos.split(" ").slice(1).join(" ") || gecos);
					// WHO flags: H = here, G = gone (away). Only meaningful when
					// the server has no away-notify; touch() keeps the flag fresh.
					const flags = p[6] ?? "";
					this.roster.touch(nick, { away: flags.includes("G") ? true : flags.includes("H") ? false : undefined });
				}
				break;
			}
		case String(NUMERICS.RPL_WHOSPCRPL): {
				// WHOX %uhnafr: <me> <user> <host> <nick> <flags> <account> :<realname>
				const [, , , nick, flags, account, gecos = ""] = p;
				if (nick) {
					this.roster.applyRealname(nick, gecos);
					// "0" (WHOX) and "*" (extended-join) both mean logged out.
					const acct = account && account !== "0" && account !== "*" ? account : undefined;
					this.roster.touch(nick, {
						away: flags?.includes("G") ? true : flags?.includes("H") ? false : undefined,
						...(acct ? { account: acct } : {}),
					});
				}
				break;
			}
			default:
				break;
		}
	}

	#pendingReconnect(): { attempt: number; nextInMs: number } | null {
		if (this.#cancelScheduled === null || this.#nextAttemptAt === null) return null;
		return { attempt: this.#reconnectAttempt, nextInMs: Math.max(0, this.#nextAttemptAt - this.now()) };
	}

	/**
	 * Busy presence: mark AWAY while the host agent is mid-run, clear it when
	 * settled. RFC 2812 AWAY with no parameter un-aways. The server confirms
	 * via 305/306, which flips our own roster flag; no local guessing.
	 */
	setBusy(busy: boolean): void {
		if (busy) {
			const since = new Date(this.now()).toISOString().slice(11, 16);
			this.client.away(`busy since ${since}`);
		} else {
			this.client.away();
		}
	}

#maybeWake(from: string, text: string): void {
		if (!this.config.delivery.wakeOnDirectMessage) return;
		if (!this.#wakeTrusted(from)) {
			this.buffer.push({
				conv: from,
				from,
				text: `(DM buffered — ${from} is not wake-trusted: no verified services account and not on the wake allowlist)`,
				kind: "system",
			});
			return;
		}
		const now = this.now();
		if (now - this.lastWakeAt < WAKE_QUIET_MS) return;
		this.lastWakeAt = now;
		this.emit("wake", { from, text });
	}

	/**
	 * Wake trust is default-deny: a nick wakes us only when it holds a
	 * services account (extended-join `account` — the one identity on IRC
	 * that costs a password to obtain) or matches an operator-configured
	 * glob. Self-declared realname metadata alone never wakes; it is free
	 * text anyone can send.
	 */
	#wakeTrusted(nick: string): boolean {
		const peer = this.roster.get(nick);
		if (peer?.account) return true;
		return (this.config.delivery.wakeAllowNicks ?? []).some((g) =>
			new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i").test(nick),
		);
	}

	// ---- Tool surface ----------------------------------------------------

	status(): Record<string, unknown> {
		return {
			nick: this.client.realNick ?? this.client.nick,
			...(this.client.desiredNick !== (this.client.realNick ?? this.client.nick)
				? { desiredNick: this.client.desiredNick }
				: {}),
			role: this.identity.role,
			project: this.config.projectSlug,
			projectChannel: this.projectChannel,
			connection: this.client.state,
			channels: this.channels.list().map((ch) => ch.name),
			...(this.#pendingReconnect()
				? { reconnect: this.#pendingReconnect() }
				: {}),
			unread: this.buffer.unreadAll(),
		};
	}

	rosterView(): Array<Record<string, unknown>> {
		const view = (p: Peer) => ({
			nick: p.nick,
			kind: p.kind,
			...(p.role ? { role: p.role } : {}),
			...(p.project ? { project: p.project } : {}),
			...(p.session ? { session: p.session } : {}),
			...(p.parent ? { parent: p.parent } : {}),
			...(p.away ? { away: true } : {}),
			lastSeen: new Date(p.lastSeen).toISOString(),
			self: p.self,
		});
		return this.roster.all().map(view).sort((a, b) => String(a.nick).localeCompare(String(b.nick)));
	}
	/**
	 * Resolve an addressing spec to a nick or channel:
	 *   "@abc123" → the agent whose session id starts with abc123
	 *   "main"/"sub" → the sole agent with that role (ambiguous → error)
	 * Channels and raw nicks pass through untouched. Throws with the
	 * candidate list when a selector matches nobody or several peers —
	 * agents should then address by @session instead.
	 */
	resolveTarget(spec: string): string {
		if (/^[#&+]/.test(spec)) return spec;
		// Selectors are project-scoped: role words and @session ids only ever
		// resolve inside OUR project — foreign agents on a shared server are
		// addressed by their raw nick (visible via `irc roster`).
		const agents = this.roster
			.all()
			.filter((p) => !p.self && p.session && p.project === this.config.projectSlug);
		const fail = (why: string, known: Peer[]) =>
			new Error(`${why} (known agents: ${known.map((p) => `${p.nick} @${p.session}`).join(", ") || "none"})`);
		if (spec.startsWith("@")) {
			const frag = spec.slice(1).toLowerCase();
			if (!frag) throw fail("empty @session selector", agents);
			const hits = agents.filter((p) => p.session?.toLowerCase().startsWith(frag));
			if (hits.length === 1) return hits[0].nick;
			throw fail(
				hits.length === 0 ? `no agent session starts with "${frag}"` : `session prefix "${frag}" is ambiguous (${hits.length} agents)`,
				hits.length > 0 ? hits : agents,
			);
		}
		if (spec === "main" || spec === "sub") {
			const hits = agents.filter((p) => p.role === spec);
			if (hits.length === 1) return hits[0].nick;
			throw fail(
				hits.length === 0 ? `no ${spec} agent in the roster` : `${hits.length} ${spec} agents — address by @session instead`,
				hits.length > 0 ? hits : agents,
			);
		}
		return spec;
	}

	send(target: string | undefined, text: string): SendResult {
		const to = this.resolveTarget(target ?? this.projectChannel);
		const chunks = this.delivery.enqueue(to, text);
		this.delivery.drain();
		return { target: to, chunks, pending: this.delivery.pending() };
	}

	/**
	 * Ask a peer over a correlated DM envelope and wait for the reply.
	 * Resolves with the peer's answer, or a timeout result. The session keeps
	 * serving while we wait: inbound traffic flows, asks from others buffer.
	 */
	async ask(
		rawPeer: string,
		question: string,
		timeoutSec = DEFAULT_ASK_TIMEOUT_SEC,
	): Promise<AskResolution> {
		const peer = this.resolveTarget(rawPeer);
		const timeoutMs = Math.min(3_600, Math.max(1, timeoutSec)) * 1_000;
		const { id, done } = this.rpc.trackOutbound(peer, question, timeoutMs);
		for (const part of envelopeParts("ask", id, question, this.delivery.maxChunk, timeoutSec)) {
			this.delivery.enqueue(peer, part);
		}
		this.delivery.drain();
		this.buffer.push({
			conv: peer,
			from: this.client.realNick ?? this.client.nick,
			text: `asked ${peer} (id=${id}): ${question}`,
			kind: "system",
		});
		return done;
	}

	/**
	 * Answer an ask another session sent us. One reply per ask id; unknown or
	 * already-answered ids throw with the pending list spelled out.
	 */
	reply(id: string, text: string): { id: string; to: string; parts: number } {
		const pending = this.rpc.pendingInbound().find((a) => a.id === id);
		if (!pending) {
			const open = this.rpc
				.pendingInbound()
				.map((a) => `${a.id} from ${a.peer}`)
				.join(", ");
			throw new Error(`unknown or already-answered ask id=${id}. Pending: ${open || "(none)"}`);
		}
		this.rpc.resolveInbound(id, text);
		const parts = envelopeParts("reply", id, text, this.delivery.maxChunk);
		for (const part of parts) this.delivery.enqueue(pending.peer, part);
		this.delivery.drain();
		this.buffer.push({
			conv: pending.peer,
			from: this.client.realNick ?? this.client.nick,
			text: `replied to ${pending.peer} (ask id=${id}): ${text}`,
			kind: "system",
		});
		return { id, to: pending.peer, parts: parts.length };
	}

	read(opts: ReadOptions = {}): BufferedMessage[] {
		return this.buffer.read(opts);
	}

	/** Flush read cursors without returning content ("I know, clear it"). */
	mark(conv?: string): Record<string, number> {
		return this.buffer.mark(conv);
	}

	/** Serialized CHATHISTORY fetch; never throws, no-op without the cap. */
	#catchup(target: string, limit: number): Promise<IrcMessage[]> {
		const run = async (): Promise<IrcMessage[]> => {
			const hasCap = this.client.enabledCaps.some((c) => c.toLowerCase().includes("chathistory"));
			if (limit <= 0 || !hasCap) return [];
			try {
				return await this.client.chathistory(target, limit);
			} catch {
				return []; // history is best-effort by design
			}
		};
		const p = this.#catchupTail.then(run, run);
		this.#catchupTail = p.then(
			() => undefined,
			() => undefined,
		);
		return p;
	}

	/**
	 * Explicit history fetch for the `history` tool op: CHATHISTORY for the
	 * target (channel or DM peer), then drain that conversation's buffer so
	 * the agent sees each line exactly once.
	 */
	async fetchHistory(target: string, limit?: number): Promise<BufferedMessage[]> {
		const n = limit ?? (this.#historyLimit || 50);
		await this.#catchup(target, n);
		return this.read({ conv: target, limit: Math.max(n, 1) });
	}

	join(names: string[]): void {
		const fresh = names.filter((n) => !this.channels.joined(n));
		if (fresh.length === 0) return;
		this.client.join(fresh);
	}

	part(names: string[], reason?: string): void {
		for (const n of names) {
			if (!this.channels.joined(n)) continue;
			this.client.part(n, reason);
			this.channels.part(n);
		}
	}

	stop(reason = "session shutdown"): void {
		if (this.stopped) return;
		this.stopped = true;
		this.#cancelScheduled?.();
		this.#cancelScheduled = null;
		this.#cancelKickRejoin?.();
		this.#cancelKickRejoin = null;
		if (this.#whoTimer) {
			clearTimeout(this.#whoTimer);
			this.#whoTimer = null;
		}
		this.#whoPending.clear();
		if (this.#rosterSweep) {
			clearInterval(this.#rosterSweep);
			this.#rosterSweep = null;
		}
		this.rpc.dispose();
		this.delivery.stop();
		try {
			this.client.quit(reason);
		} catch {
			// already gone
		}
		this.emit("stopped");
	}
}

// ---- helpers -------------------------------------------------------------

function renderStamp(template: string, slug: string, now: number): string {
	return template
		.replaceAll("{slug}", slug)
		.replaceAll("{date}", new Date(now).toISOString().slice(0, 10));
}

/**
 * Wait for a satisfying event, rejecting on `error` or timeout.
 * `satisfy` filters multi-fire events (e.g. our JOIN among others').
 */
function onceOrThrow<T>(
	emitter: EventEmitter,
	event: string,
	errorEvent: string,
	timeoutMs: number,
	what: string,
	satisfy?: (e: T) => boolean,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`${what}: timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onWanted = (e: T) => {
			if (satisfy && !satisfy(e)) return;
			cleanup();
			resolve(e);
		};
		const onError = (e: { message?: string }) => {
			cleanup();
			reject(new Error(`${what}: ${e.message ?? "failed"}`));
		};
		function cleanup() {
			clearTimeout(timer);
			emitter.off(event, onWanted);
			emitter.off(errorEvent, onError);
		}
		emitter.on(event, onWanted);
		emitter.on(errorEvent, onError);
	});
}
