/**
 * IRCv3 capability negotiation (a pure state machine — the client feeds
 * CAP lines in and executes the lines it emits; no transport knowledge).
 *
 * Flow per the IRCv3 capability negotiation spec:
 *   CAP LS 302            (before NICK/USER; "302" = we speak v3.2)
 *   CAP * LS :a b c       (possibly split: "CAP * LS * :a b" continuation)
 *   CAP REQ :a b          (intersection of wanted ∩ offered)
 *   CAP * ACK :a b        (all-or-nothing per REQ)
 *   CAP END               (release the server to send 001)
 *
 * Degradation: a REQ that gets NAK'd is dropped entirely (IRCv3 REQ
 * semantics are all-or-nothing); with nothing left to want we still send
 * CAP END. A server that answers 410 (unknown CAP command) gets no
 * further CAP traffic — RFC 2812-only servers stay fully supported.
 */

export const SUPPORTED_CAPS = ["server-time", "extended-join", "multi-prefix", "away-notify"] as const;

export type CapAction = { send?: string[]; done?: boolean; enabled?: string[] };

/** Split a CAP LS/ACK/NAK list into names, dropping "=value" suffixes. */
export function parseCapList(raw: string): string[] {
	return raw
		.split(" ")
		.map((c) => c.split("=")[0].trim())
		.filter(Boolean);
}

/** Caps we will actually request: wanted ∩ offered. */
export function pickCaps(offered: string[], wanted: string[]): string[] {
	const fold = new Set(offered.map((c) => c.toLowerCase()));
	return wanted.filter((c) => fold.has(c.toLowerCase()));
}

export class CapNegotiator {
	readonly #wanted: string[];
	#phase: "idle" | "ls" | "req" | "done" = "idle";
	#offered: string[] = [];
	#enabled: string[] = [];
	#continuation = false;
	#pending: string[] = []; // caps awaiting a per-cap fallback verdict

	constructor(wanted: readonly string[] = SUPPORTED_CAPS) {
		this.#wanted = [...wanted];
	}

	/** Lines to send when registration begins ([] when nothing is wanted). */
	start(): string[] {
		if (this.#wanted.length === 0 || this.#phase !== "idle") return [];
		this.#phase = "ls";
		return [`CAP LS 302`];
	}

	/**
	 * Feed one incoming CAP message in. `params` is the raw param list of
	 * the server line ("CAP <nick|*> <subcmd> [args...]").
	 */
	handleCap(params: string[]): CapAction {
		const sub = (params[1] ?? "").toUpperCase();
		const rest = params.slice(2).join(" ").replace(/^:/, "");

		if (sub === "LS") {
			if (this.#phase === "done" || this.#phase === "req") return {};
			if (this.#phase === "idle") return {}; // unsolicited: we never sent CAP LS
			this.#phase = "ls";
			this.#continuation = params[2] === "*"; // "CAP * LS * :..." → more coming
			this.#offered.push(...parseCapList(rest));
			if (this.#continuation) return {};
			const req = pickCaps(this.#offered, this.#wanted);
			if (req.length === 0) {
				this.#phase = "done";
				return { send: ["CAP END"], done: true, enabled: [] };
			}
			this.#phase = "req";
			return { send: [`CAP REQ :${req.join(" ")}`] };
		}

		if (sub === "ACK") {
			if (this.#phase !== "req") return {};
			const acked = parseCapList(rest).filter((c) =>
				pickCaps(this.#offered, this.#wanted).some((w) => w.toLowerCase() === c.toLowerCase()),
			);
			this.#enabled.push(...acked);
			if (this.#pending.length > 0) {
				this.#retire(acked);
				return this.#pending.length === 0 ? this.#finish() : { enabled: this.#enabled };
			}
			this.#phase = "done";
			return { send: ["CAP END"], done: true, enabled: this.#enabled };
		}

		if (sub === "NAK") {
			if (this.#phase !== "req") return {};
			const caps = parseCapList(rest);
			// Per-cap fallback verdict: just retire that one cap.
			if (this.#pending.length > 0) {
				this.#retire(caps);
				return this.#pending.length === 0 ? this.#finish() : {};
			}
			// All-or-nothing batch bounce. A single-cap REQ that NAKs
			// has nothing left to try — end empty. A multi-cap REQ gets
			// split into one-cap REQs so one unsupported cap (seen in
			// the wild: InspIRCd builds without some caps) no longer
			// costs us server-time.
			if (caps.length <= 1) return this.#finish();
			this.#pending = caps;
			return { send: caps.map((c) => `CAP REQ :${c}`) };
		}

		if (sub === "NEW" || sub === "DEL") return {}; // mid-session changes: not our problem
		return {};
	}

	/** Abort on 410 / pre-registration failure: stop all CAP traffic. */
	abort(): CapAction {
		this.#phase = "done";
		return { done: true, enabled: [] };
	}

	get phase(): "idle" | "ls" | "req" | "done" {
		return this.#phase;
	}

	get enabled(): string[] {
		return [...this.#enabled];
	}

	/** Remove caps from the per-cap fallback wait list. */
	#retire(caps: string[]): void {
		const drop = new Set(caps.map((c) => c.toLowerCase()));
		this.#pending = this.#pending.filter((c) => !drop.has(c.toLowerCase()));
	}

	/** Negotiation is over — emit CAP END and whatever we kept. */
	#finish(): CapAction {
		this.#phase = "done";
		return { send: ["CAP END"], done: true, enabled: [...this.#enabled] };
	}

	/** Abort on 410 / pre-registration failure: stop all CAP traffic. */
	reset(): void {
		this.#phase = "idle";
		this.#offered = [];
		this.#enabled = [];
		this.#continuation = false;
		this.#pending = [];
	}
}
