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
import { parseLine, wire, type IrcMessage } from "./wire.ts";
import { NUMERICS } from "./numerics.ts";

export type ClientState = "idle" | "connecting" | "registering" | "registered" | "closed";

export interface Transport extends EventEmitter {
	send(line: string): void;
	close(): void;
	destroy(): void;
}

export interface RegisterSpec {
	nick: string;
	username: string;
	realname: string;
	/** Suffix pool for 433 collisions, e.g. ["-a", "-b", ...]. */
	nickFallbacks?: string[];
	/** Ping timeout watchdog in ms (default 120000). */
	pingTimeoutMs?: number;
}

export interface ClientEvents {
	registered: { nick: string };
	motdEnd: void;
	message: IrcMessage;
	notice: { from: string; text: string; toSelf: boolean };
	privmsg: { from: string; target: string; text: string; toSelf: boolean };
	join: { nick: string; channel: string; self: boolean };
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
	private readonly transport: Transport;
	private registeredAt: number | null = null;
	private lastServerLineAt = Date.now();
	private watchdog: ReturnType<typeof setInterval> | null = null;
	private fallbackIdx = 0;
	private currentNickBase: string;

	constructor(spec: RegisterSpec, transport: Transport) {
		super();
		this.spec = spec;
		this.nick = spec.nick;
		this.currentNickBase = spec.nick;
		this.transport = transport;

		this.transport.on("line", (line: string) => this.#onLine(line));
		this.transport.on("close", () => {
			this.#stopWatchdog();
			this.state = "closed";
			this.emit("socketClosed");
		});
		this.transport.on("error", (err: Error) => {
			this.emit("error", { message: `socket: ${err.message}` });
		});
	}

	/** Begin registration on an already-connected transport. */
	startRegistration(): void {
		this.state = "registering";
		this.transport.send(wire.nick(this.nick));
		this.transport.send(wire.user(this.spec.username, this.spec.realname));
		this.#startWatchdog();
	}

	get realNick(): string {
		return this.nick;
	}

	isSelf(nick: string): boolean {
		return nick.toLowerCase() === this.nick.toLowerCase();
	}

	sendRaw(line: string): void {
		this.transport.send(line);
	}

	privmsg(target: string, text: string): void {
		this.transport.send(wire.privmsg(target, text));
	}

	notice(target: string, text: string): void {
		this.transport.send(wire.notice(target, text));
	}

	join(channels: string[]): void {
		this.transport.send(wire.join(channels));
	}

	part(channel: string, reason?: string): void {
		this.transport.send(wire.part(channel, reason));
	}

	who(mask: string): void {
		this.transport.send(wire.who(mask));
	}

	setTopic(channel: string, topic: string): void {
		this.transport.send(wire.topic(channel, topic));
	}

	quit(reason: string): void {
		if (this.state !== "closed") this.transport.send(wire.quit(reason));
		this.transport.close();
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
			this.transport.send(wire.pong(msg.params[0] ?? "1"));
			return;
		}
		if (msg.command === "PONG") return;
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
			const channel = msg.params[0];
			this.emit("join", { nick: msg.sourceNick ?? "?", channel, self: this.isSelf(msg.sourceNick ?? "") });
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
			case NUMERICS.ERR_NICKNAMEINUSE:
			case NUMERICS.ERR_ERRONEUSNICKNAME: {
				const pool = this.spec.nickFallbacks ?? NICK_FALLBACKS;
				if (this.fallbackIdx >= pool.length) {
					this.emit("error", { code, message: `all nick variants taken: ${this.currentNickBase}` });
					this.transport.destroy();
					return;
				}
				this.nick = `${this.currentNickBase}${pool[this.fallbackIdx++]}`;
				this.transport.send(wire.nick(this.nick));
				break;
			}
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

	#startWatchdog(): void {
		const intervalMs = Math.min(this.spec.pingTimeoutMs ?? 120000, 30000);
		this.watchdog = setInterval(() => {
			if (Date.now() - this.lastServerLineAt > (this.spec.pingTimeoutMs ?? 120000)) {
				this.emit("error", { message: "server silent beyond ping timeout" });
				this.transport.destroy();
			} else if (Date.now() - this.lastServerLineAt > intervalMs) {
				// Quiet link: probe liveness without waiting for a full timeout.
				this.transport.send(wire.ping(`pi-${Date.now()}`));
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
