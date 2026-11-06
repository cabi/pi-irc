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
import type { IrcClient } from "./irc-client.ts";
import { IrcClient } from "./irc-client.ts";
import type { Transport } from "./irc-client.ts";
import { IrcSocket } from "./irc-socket.ts";
import { NUMERICS } from "./numerics.ts";
import type { BufferedMessage, ReadOptions } from "./buffer.ts";
import { MessageBuffer } from "./buffer.ts";
import type { Peer } from "./roster.ts";
import { Roster } from "./roster.ts";
import { Channels } from "./channels.ts";
import type { DeliveryQueue } from "./delivery.ts";
import { DeliveryQueue } from "./delivery.ts";
import { wire } from "./wire.ts";

export interface SessionDeps {
	/** Injectable for tests: an already-registered client (skips PASS/001). */
	client?: IrcClient;
	transport?: Transport;
	now?: () => number;
}

export interface SendResult {
	target: string;
	chunks: number;
	/** Chunks still waiting in the flood-limited queue. */
	pending: number;
}

const BOOT_TIMEOUT_MS = 15_000;
const WAKE_QUIET_MS = 60_000;

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
	private lastWakeAt = 0;
	private stopped = false;
	private topicStampPending = false;

	private constructor(config: PiIrcConfig, identity: IdentityContext, client: IrcClient, now: () => number) {
		super();
		this.config = config;
		this.identity = identity;
		this.projectChannel = renderChannelName(config.channels.projectTemplate, config.projectSlug);
		this.client = client;
		this.now = now;
		this.buffer = new MessageBuffer(config.delivery.bufferMax, client.realNick ?? client.nick);
		this.delivery = new DeliveryQueue(
			(target, text) => this.client.privmsg(target, text),
			{ burst: 4, intervalMs: 2000, maxChunk: 400, chunkLong: config.delivery.chunkLongSends },
		);
		this.#wireEvents();
		this.delivery.start();
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
				},
				transport,
			);
			const password = config.server.passwordEnv ? process.env[config.server.passwordEnv] : undefined;
			await transport.connect({
				host: config.server.host,
				port: config.server.port,
				tls: config.server.tls,
				timeoutMs: BOOT_TIMEOUT_MS,
			});
			if (password) client.sendRaw(wire.pass(password));
			client.startRegistration();
			await onceOrThrow(client, "registered", "error", BOOT_TIMEOUT_MS, "registration");
		}
		await onceOrThrow(client, "motdEnd", "error", BOOT_TIMEOUT_MS, "registration (MOTD)");

		const session = new IrcSession(config, identity, client, now);

		// Join the project channel (+ any extra defaults). The channel is
		// created by the server on first JOIN — nothing else to bootstrap.
		// Waiters attach before the command so the (synchronous in tests,
		// async on a socket) join echoes cannot slip past them.
		const chan = session.projectChannel;
		const extra = config.channels.defaults.filter((c) => c.toLowerCase() !== chan.toLowerCase());
		const projectJoined = onceOrThrow(
			client, "join", "error", BOOT_TIMEOUT_MS, `joining ${chan}`,
			(e) => e.self && e.channel.toLowerCase() === chan.toLowerCase(),
		);
		const extrasJoined = extra.map((c) => onceOrThrow(
			client, "join", "error", BOOT_TIMEOUT_MS, `joining ${c}`,
			(e) => e.self && e.channel.toLowerCase() === c.toLowerCase(),
		));
		client.join([chan, ...extra]);
		await projectJoined;
		await Promise.all(extrasJoined);

		// Seed the roster: WHO returns realnames → agent/human mapping.
		client.who(chan);
		await onceOrThrow(client, "message", "error", BOOT_TIMEOUT_MS, `WHO ${chan}`, (m) =>
			m.command === String(NUMERICS.RPL_ENDOFWHO) && m.params[1]?.toLowerCase() === chan.toLowerCase(),
		);

		// Topic stamp on a fresh channel (server told us 331 = no topic).
		if (config.channels.autoCreate && session.topicStampPending) {
			client.topic(chan, renderStamp(config.channels.topicTemplate, config.projectSlug, now()));
			session.topicStampPending = false;
		}
		return session;
	}

	#wireEvents(): void {
		const c = this.client;
		c.on("privmsg", (e) => {
			if (/^[#&+!]/.test(e.target)) {
				// Channel chatter: buffer under the channel, never wake.
				this.buffer.push({ conv: e.target, from: e.from, text: e.text });
				this.roster.touch(e.from);
			} else if (!e.toSelf) {
				// DM to us: buffer under the sender's nick, consider a wake.
				this.buffer.push({ conv: e.from, from: e.from, text: e.text, kind: "dm" });
				this.roster.touch(e.from);
				this.#maybeWake(e.from, e.text);
			}
			// Our own echoes (toSelf) are already accounted for by send().
		});
		c.on("notice", (e) => {
			// Notices carry no reliable channel routing; file under sender.
			this.buffer.push({ conv: e.from || "server", from: e.from || "server", text: e.text, kind: "notice" });
		});
		c.on("join", (e) => {
			this.channels.addMember(e.channel, e.nick);
			this.roster.touch(e.nick, e.self ? { self: true } : {});
			if (!e.self) this.client.who(e.nick); // learn realname of the newcomer
		});
		c.on("part", (e) => {
			if (e.self) this.channels.part(e.channel);
			else this.channels.removeMember(e.channel, e.nick);
		});
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
			case String(NUMERICS.RPL_WHOREPLY): {
				// <me> <chan> <user> <host> <server> <nick> <flags> :<hop> <gecos>
				const nick = p[5];
				const gecos = p[7] ?? "";
				if (nick) this.roster.applyRealname(nick, gecos.split(" ").slice(1).join(" ") || gecos);
				break;
			}
			default:
				break;
		}
	}

	#maybeWake(from: string, text: string): void {
		if (!this.config.delivery.wakeOnDirectMessage) return;
		const now = this.now();
		if (now - this.lastWakeAt < WAKE_QUIET_MS) return;
		this.lastWakeAt = now;
		this.emit("wake", { from, text });
	}

	// ---- Tool surface ----------------------------------------------------

	status(): Record<string, unknown> {
		return {
			nick: this.client.realNick ?? this.client.nick,
			role: this.identity.role,
			project: this.config.projectSlug,
			projectChannel: this.projectChannel,
			connection: this.client.state,
			channels: this.channels.list().map((ch) => ch.name),
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
			lastSeen: new Date(p.lastSeen).toISOString(),
			self: p.self,
		});
		return this.roster.all().map(view).sort((a, b) => String(a.nick).localeCompare(String(b.nick)));
	}

	send(target: string | undefined, text: string): SendResult {
		const to = target ?? this.projectChannel;
		const chunks = this.delivery.enqueue(to, text);
		this.delivery.drain();
		return { target: to, chunks, pending: this.delivery.pending() };
	}

	read(opts: ReadOptions = {}): BufferedMessage[] {
		return this.buffer.read(opts);
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
	emitter: { on(name: string, cb: (e: T) => void): unknown; off(name: string, cb: (e: T) => void): unknown },
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
