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
	readonly #reconnect: ReconnectSpec | null;
	readonly #backoff: Backoff;
	#cancelScheduled: (() => void) | null = null;
	#reconnectAttempt = 0;
	#nextAttemptAt: number | null = null;
	private lastWakeAt = 0;
	private stopped = false;
	private topicStampPending = false;

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
		this.#backoff = new Backoff(reconnect?.backoff);
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
		const password = config.server.passwordEnv ? process.env[config.server.passwordEnv] : undefined;
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
			await transport.connect({
				host: config.server.host,
				port: config.server.port,
				tls: config.server.tls,
				timeoutMs: BOOT_TIMEOUT_MS,
			});
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
		c.on("socketClosed", () => this.#onDrop());
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
		await transport.connect({
			host: this.config.server.host,
			port: this.config.server.port,
			tls: this.config.server.tls,
			timeoutMs: BOOT_TIMEOUT_MS,
		});
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

	#pendingReconnect(): { attempt: number; nextInMs: number } | null {
		if (this.#cancelScheduled === null || this.#nextAttemptAt === null) return null;
		return { attempt: this.#reconnectAttempt, nextInMs: Math.max(0, this.#nextAttemptAt - this.now()) };
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
		this.#cancelScheduled?.();
		this.#cancelScheduled = null;
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
