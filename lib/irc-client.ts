/**
 * IrcClient: the RFC 2812 client side as a state machine over any
 * line-oriented transport. Owns registration (NICK/USER, 001 welcome,
 * 433 nick-collision retry), keepalive (PING→PONG, liveness watchdog),
 * and turns protocol lines into typed events.
 *
 * Deliberately no channels/roster logic here — IrcSession composes those
 * on top. Transport is injected; tests drive a fake or a real loopback
 * socket.
 */
import { EventEmitter } from "node:events";
import { parseLine, formatLine, wire, type IrcMessage } from "./wire.ts";
import { NUMERICS } from "./numerics.ts";
import { CapNegotiator } from "./caps.ts";
import { authChunks, saslPlainPayload } from "./sasl.ts";

export type ClientState = "idle" | "connecting" | "registering" | "registered" | "closed";

export interface Transport extends EventEmitter {
	send(line: string): void;
	close(): void;
	destroy(): void;
	/** Socket transports also own connection; fakes skip it (client injected). */
	connect(opts: { host: string; port: number; tls: boolean; timeoutMs: number }): Promise<void>;
}

export interface RegisterSpec {
	nick: string;
	username: string;
	realname: string;
	/** Suffix pool for 433 collisions, e.g. ["-a", "-b", ...]. */
	nickFallbacks?: string[];
	/** Ping timeout watchdog in ms (default 120000). */
	pingTimeoutMs?: number;
	/** IRCv3 caps to negotiate before registration ([] or omit = skip CAP). */
	caps?: string[];
	/** SASL PLAIN credentials — adds "sasl" to caps and fails closed when the server won't negotiate it. */
	sasl?: { username: string; password: string };
}

export interface ClientEvents {
	registered: { nick: string };
	/** IRCv3 negotiation finished — the caps the server actually enabled. */
	capsEnabled: { caps: string[] };
	batchStart: { ref: string; type: string; target?: string };
	/** A batch closed — `type` empty when the open was never seen. */
	batchEnd: { ref: string; type: string };
	motdEnd: void;
	message: IrcMessage;
	notice: { from: string; text: string; toSelf: boolean };
	privmsg: {
		from: string;
		target: string;
		text: string;
		toSelf: boolean;
		/** server-time tag (ISO 8601) when the server provides one. */
		time?: string;
		/** IRCv3 msgid tag — the wire identity of this exact message. */
		msgid?: string;
		/** BATCH reference when this line arrived inside a batch (replayed history). */
		batch?: string;
	};
	join: {
		nick: string;
		channel: string;
		self: boolean;
		/** extended-join extras: account ("*" when logged out) and realname. */
		account?: string;
		realname?: string;
	};
	away: { nick: string; away: boolean };
	part: { nick: string; channel: string; self: boolean };
	quit: { nick: string; reason: string };
	nickChange: { oldNick: string; newNick: string; self: boolean };
	error: { code?: number; message: string };
	socketClosed: void;
}

const NICK_FALLBACKS = ["-a", "-b", "-c", "_", "__", "-pi"];

export class IrcClient extends EventEmitter {
	state: ClientState = "idle";
	nick: string;
	private readonly spec: RegisterSpec;
	#transport!: Transport;
	private registeredAt: number | null = null;
	#tHandlers: { line: (l: string) => void; close: () => void; error: (e: Error) => void } | null = null;
	private lastServerLineAt = Date.now();
	private fallbackIdx = 0;
	private currentNickBase: string;
	private watchdog: ReturnType<typeof setInterval> | null = null;
	#caps = new CapNegotiator();
	/** SASL chunks staged after "AUTHENTICATE PLAIN" (null = no exchange in flight). */
	#saslChunks: string[] | null = null;
	/** Open BATCH references → batch type ("chathistory", ...). */
	#batches = new Map<string, string>();
	constructor(spec: RegisterSpec, transport: Transport) {
		super();
		this.spec = spec;
		this.nick = spec.nick;
		this.currentNickBase = spec.nick;
		this.#caps = new CapNegotiator(this.#wantedCaps());
		this.#bindTransport(transport);
	}

	#bindTransport(transport: Transport): void {
		const handlers = {
			line: (line: string) => this.#onLine(line),
			close: () => {
				this.#stopWatchdog();
				this.state = "closed";
				this.emit("socketClosed");
			},
			error: (err: Error) => this.emit("error", new Error(`socket: ${err.message}`)),
		};
		transport.on("line", handlers.line);
		transport.on("close", handlers.close);
		transport.on("error", handlers.error);
		this.#transport = transport;
		this.#tHandlers = handlers;
	}

	/**
	 * Swap in a fresh transport for reconnect: unbind the dead one, reset
	 * registration state, and retry the original nick with fallbacks
	 * re-armed (the old nick may still be held by a ghost connection).
	 */
	attach(transport: Transport): void {
		if (this.#tHandlers) {
			this.#transport.off("line", this.#tHandlers.line);
			this.#transport.off("close", this.#tHandlers.close);
			this.#transport.off("error", this.#tHandlers.error);
		}
		this.#stopWatchdog();
		this.#bindTransport(transport);
		this.state = "idle";
		this.nick = this.spec.nick;
		this.currentNickBase = this.spec.nick;
		this.fallbackIdx = 0;
		this.registeredAt = null;
		this.#caps = new CapNegotiator(this.#wantedCaps());
		this.#saslChunks = null;
		this.#batches.clear();
	}

	get enabledCaps(): string[] {
		return this.#caps.enabled;
	}

	/** Begin registration on an already-connected transport. */
	startRegistration(): void {
		this.state = "registering";
		// IRCv3: CAP LS goes out before NICK/USER; CAP END follows the ACK,
		// which releases the server to send 001.
		for (const line of this.#caps.start()) this.#transport.send(line);
		this.#transport.send(wire.nick(this.nick));
		this.#transport.send(wire.user(this.spec.username, this.spec.realname));
		this.#startWatchdog();
	}

	get realNick(): string {
		return this.nick;
	}

	isSelf(nick: string): boolean {
		return nick.toLowerCase() === this.nick.toLowerCase();
	}

	sendRaw(line: string): void {
		this.#transport.send(line);
	}

	privmsg(target: string, text: string): void {
		this.#transport.send(wire.privmsg(target, text));
	}

	notice(target: string, text: string): void {
		this.#transport.send(wire.notice(target, text));
	}

	join(channels: string[]): void {
		this.#transport.send(wire.join(channels));
	}

	part(channel: string, reason?: string): void {
		this.#transport.send(wire.part(channel, reason));
	}

	/**
	 * WHO, defaulting to the WHOX field set %uhnafr → 354 replies carry
	 * user, host, nick, flags (H/G away), services account, realname.
	 * Servers without WHOX still answer with plain 352 (handled too).
	 */
	who(mask: string): void {
		this.#transport.send(wire.who(mask));
	}

	/** AWAY with a reason marks away; without one it clears (RFC 2812 §4.1). */
	away(reason?: string): void {
		this.#transport.send(wire.away(reason));
	}

	topic(channel: string, topic?: string): void {
		this.#transport.send(wire.topic(channel, topic));
	}

	/**
	 * CHATHISTORY LATEST <target> * <limit> (draft/chathistory). Collects the
	 * PRIVMSGs the server wraps in a matching `chathistory` batch and resolves
	 * when the batch closes — or when the timeout hits, so servers without
	 * proper batching can never hang a session boot. The lines also flow
	 * through the normal `privmsg` events (buffering is the session's job).
	 */
	chathistory(target: string, limit: number, timeoutMs = 10_000): Promise<IrcMessage[]> {
		return new Promise((resolve) => {
			const collected: IrcMessage[] = [];
			const open = new Set<string>();
			const lower = target.toLowerCase();
			const mine = (t: string | undefined) =>
				t === undefined || t.toLowerCase() === lower || t.toLowerCase() === this.nick.toLowerCase();
			const cleanup = () => {
				clearTimeout(timer);
				this.off("batchStart", onBatchStart);
				this.off("batchEnd", onBatchEnd);
				this.off("message", onMessage);
			};
			const done = () => {
				cleanup();
				resolve(collected);
			};
			const timer = setTimeout(done, timeoutMs);
			const onBatchStart = (e: { ref: string; type: string; target?: string }) => {
				if (e.type === "chathistory" && mine(e.target)) open.add(e.ref);
			};
			const onBatchEnd = (e: { ref: string }) => {
				if (open.has(e.ref)) done();
			};
			const onMessage = (m: IrcMessage) => {
				if (m.command === "PRIVMSG" && m.tags?.batch && open.has(m.tags.batch)) collected.push(m);
			};
			this.on("batchStart", onBatchStart);
			this.on("batchEnd", onBatchEnd);
			this.on("message", onMessage);
			// Built through formatLine: its CR/LF/NUL guard closes the last
			// raw-interpolation injection path (target comes from tool input).
			const n = Math.max(1, Math.min(1000, Math.floor(limit)));
			this.#transport.send(formatLine({ command: "CHATHISTORY", params: ["LATEST", target, "*", String(n)] }));
		});
	}
	quit(reason: string): void {
		if (this.state !== "closed") this.#transport.send(wire.quit(reason));
		this.#transport.close();
	}

	#onLine(rawLine: string): void {
		this.lastServerLineAt = Date.now();
		let msg: IrcMessage;
		try {
			msg = parseLine(rawLine);
		} catch (err) {
			this.emit("error", { message: `unparseable line: ${rawLine}: ${(err as Error).message}` });
			return;
		}
		this.emit("message", msg);

		if (msg.command === "PING") {
			this.#transport.send(wire.pong(msg.params[0] ?? "1"));
			return;
		}
		if (msg.command === "PONG") return;
		if (msg.command === "BATCH") {
			// IRCv3 batches: "+ref type params" opens, "-ref" closes. Lines
			// inside carry tag batch=ref and flow through as normal events.
			const refArg = msg.params[0] ?? "";
			if (refArg.startsWith("+")) {
				const ref = refArg.slice(1);
				this.#batches.set(ref, msg.params[1] ?? "");
				this.emit("batchStart", { ref, type: msg.params[1] ?? "", target: msg.params[2] });
			} else if (refArg.startsWith("-")) {
				const ref = refArg.slice(1);
				const type = this.#batches.get(ref) ?? "";
				this.#batches.delete(ref);
				this.emit("batchEnd", { ref, type });
			}
			return;
		}
		if (msg.command === "CAP") {
			const action = this.#caps.handleCap(msg.params);
			// With SASL configured the finish line is held back here —
			// 903/907 send CAP END once authentication has actually run.
			const lines = action.done && this.spec.sasl ? (action.send ?? []).filter((l) => l !== "CAP END") : (action.send ?? []);
			for (const line of lines) this.#transport.send(line);
			if (action.done) this.#capsDone();
			return;
		}
		if (msg.command === "AUTHENTICATE") {
			// Server side of the exchange: "+" invites the payload, "*" aborts.
			const param = msg.params[0];
			if (param === "+" && this.#saslChunks) {
				for (const chunk of this.#saslChunks) this.#transport.send(`AUTHENTICATE ${chunk}`);
			} else if (param === "*") {
				this.emit("error", { message: "server aborted SASL exchange" });
				this.#transport.destroy();
			}
			return;
		}
		if (msg.command === "AWAY") {
			// away-notify: params empty → back, [":reason"] → away.
			this.emit("away", { nick: msg.sourceNick ?? "?", away: msg.params.length > 0 });
			return;
		}
		if (msg.command === "ERROR") {
			// "ERROR :Closing Link: ..." — the server is hanging up on us.
			this.emit("error", { message: msg.params.join(" ") });
			return;
		}

		if (msg.command === "PRIVMSG") {
			const [target, ...rest] = msg.params;
			const text = rest.join(" ");
			this.emit("privmsg", {
				from: msg.sourceNick ?? msg.prefix ?? "?",
				target,
				text,
				toSelf: this.isSelf(msg.sourceNick ?? ""),
			...(msg.tags?.time ? { time: msg.tags.time } : {}),
				...(msg.tags?.msgid ? { msgid: msg.tags.msgid } : {}),
				...(msg.tags?.batch ? { batch: msg.tags.batch } : {}),
			});
			return;
		}
		if (msg.command === "NOTICE") {
			const [target, ...rest] = msg.params;
			this.emit("notice", {
				from: msg.sourceNick ?? msg.prefix ?? "?",
				text: rest.join(" "),
				toSelf: this.isSelf(msg.sourceNick ?? ""),
			});
			return;
		}
		if (msg.command === "JOIN") {
			// RFC 2812: JOIN <channel>. extended-join: JOIN <channel> <account> <realname>.
			const [channel, account, realname] = msg.params;
			this.emit("join", {
				nick: msg.sourceNick ?? "?",
				channel,
				self: this.isSelf(msg.sourceNick ?? ""),
				...(account !== undefined ? { account } : {}),
				...(realname !== undefined ? { realname } : {}),
			});
			return;
		}
		if (msg.command === "PART") {
			const channel = msg.params[0];
			this.emit("part", {
				nick: msg.sourceNick ?? "?",
				channel,
				self: this.isSelf(msg.sourceNick ?? ""),
			});
			return;
		}
		if (msg.command === "QUIT") {
			this.emit("quit", { nick: msg.sourceNick ?? "?", reason: msg.params.join(" ") });
			return;
		}
		if (msg.command === "KICK") {
			// <channel> <user> [:comment]
			const channel = msg.params[0];
			const nick = msg.params[1] ?? "?";
			this.emit("kick", {
				nick,
				by: msg.sourceNick ?? "?",
				channel,
				reason: msg.params.slice(2).join(" "),
				self: this.isSelf(nick),
			});
			return;
		}
		if (msg.command === "NICK") {
			const newNick = msg.params[0];
			const self = this.isSelf(msg.sourceNick ?? "");
			if (self) this.nick = newNick;
			this.emit("nickChange", { oldNick: msg.sourceNick ?? "?", newNick, self });
			return;
		}

		const code = /^\d{3}$/.test(msg.command) ? Number(msg.command) : undefined;
		if (code === undefined) return; // MODE, CAP, whatever: session's business

		switch (code) {
			case NUMERICS.RPL_WELCOME:
				this.nick = msg.params[0];
				this.state = "registered";
				this.registeredAt = Date.now();
				this.emit("registered", { nick: this.nick });
				break;
			case NUMERICS.ERR_INVALIDCAPCMD:
				// RFC 2812-only server that doesn't know CAP: drop the
				// negotiation silently and let registration finish.
				if (this.#caps.phase !== "done") {
					this.#caps.abort();
				this.#capsDone();
				}
				break;
			case NUMERICS.ERR_NICKNAMEINUSE:
			case NUMERICS.ERR_ERRONEUSNICKNAME: {
				const pool = this.spec.nickFallbacks ?? NICK_FALLBACKS;
				if (this.fallbackIdx >= pool.length) {
					this.emit("error", { code, message: `all nick variants taken: ${this.currentNickBase}` });
					this.#transport.destroy();
					return;
				}
				this.nick = `${this.currentNickBase}${pool[this.fallbackIdx++]}`;
				this.#transport.send(wire.nick(this.nick));
				break;
			}
			case NUMERICS.RPL_SASLSUCCESS:
			case NUMERICS.ERR_SASLALREADY:
				// 903 = success; 907 = already authenticated from a prior
				// attempt — both release CAP END and let registration finish.
				this.#saslChunks = null;
				this.#transport.send("CAP END");
				this.emit("capsEnabled", { caps: this.#caps.enabled });
				break;
			case NUMERICS.ERR_SASLFAIL:
			case NUMERICS.ERR_SASLTOOLONG:
			case NUMERICS.ERR_SASLABORTED:
				this.emit("error", { code, message: `SASL failed: ${msg.params.slice(1).join(" ") || String(code)}` });
				this.#transport.destroy();
				break;
			case NUMERICS.ERR_NOSUCHCHANNEL:
			case NUMERICS.ERR_PASSWDMISMATCH:
			case NUMERICS.ERR_BANNEDFROMCHAN:
			case NUMERICS.ERR_INVITEONLYCHAN:
			case NUMERICS.ERR_CHANNELISFULL:
			case NUMERICS.ERR_BADCHANNELKEY:
			case NUMERICS.ERR_CHANOPRIVSNEEDED:
				this.emit("error", { code, message: msg.params.slice(1).join(" ") || String(code) });
				break;
			case NUMERICS.RPL_ENDOFMOTD:
			case NUMERICS.ERR_NOMOTD:
				this.emit("motdEnd");
				break;
			default:
				// Numerics the session tracks (353/366/332/352/315/...) flow on
				// via "message"; unknown ones are simply not special here.
				break;
		}
	}

	/** Caps wanted for this registration: config request plus sasl when auth is on. */
	#wantedCaps(): string[] {
		const wanted = this.spec.caps ?? [];
		return this.spec.sasl ? [...new Set([...wanted, "sasl"])] : wanted;
	}

	/**
	 * CAP negotiation ended. With auth configured, hold CAP END and run the
	 * SASL exchange (903/907 release it); fail closed — never register
	 * anonymously — when the server won't negotiate sasl at all.
	 */
	#capsDone(): void {
		if (this.spec.sasl) {
			const negotiated = this.#caps.enabled.some((c) => c.toLowerCase() === "sasl");
			if (!negotiated) {
				this.emit("error", { message: "auth configured but the server will not negotiate sasl (not offered or refused)" });
				this.#transport.destroy();
				return;
			}
			this.#saslChunks = authChunks(saslPlainPayload(this.spec.sasl.username, this.spec.sasl.password));
			this.#transport.send("AUTHENTICATE PLAIN");
			return;
		}
		this.emit("capsEnabled", { caps: this.#caps.enabled });
	}

	#startWatchdog(): void {
		const intervalMs = Math.min(this.spec.pingTimeoutMs ?? 120000, 30000);
		this.watchdog = setInterval(() => {
			if (Date.now() - this.lastServerLineAt > (this.spec.pingTimeoutMs ?? 120000)) {
				this.emit("error", { message: "server silent beyond ping timeout" });
				this.#transport.destroy();
			} else if (Date.now() - this.lastServerLineAt > intervalMs) {
				// Quiet link: probe liveness without waiting for a full timeout.
				this.#transport.send(wire.ping(`pi-${Date.now()}`));
			}
		}, intervalMs);
		this.watchdog.unref?.();
	}

	#stopWatchdog(): void {
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = null;
	}

	get uptimeMs(): number | null {
		return this.registeredAt === null ? null : Date.now() - this.registeredAt;
	}
}
