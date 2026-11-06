/**
 * RPC: ask/reply correlation over IRC DMs.
 *
 * Envelopes are application text inside normal PRIVMSG DMs; channels never
 * interpret them. Grammar (case-sensitive, envelope must start the message):
 *
 *   [pi-ask <id> timeout=600] question text…
 *   [pi-reply <id> part=2/3] answer text…
 *
 * - id: 4-16 hex chars, generated per outbound ask
 * - timeout: seconds, ask only, optional (session supplies its default)
 * - part=i/n: 1-based markers when the sender had to chunk; a receiver
 *   reassembles by id and resolves once all parts arrived
 * - malformed envelopes are plain text — never an error on the wire
 */

import { chunkText } from "./delivery.ts";

export interface AskEnvelope {
	kind: "ask" | "reply";
	id: string;
	/** ask only: seconds the asker is willing to wait */
	timeoutSec?: number;
	/** part markers when the sender chunked (1-based i of n) */
	part?: { i: number; n: number };
	body: string;
}

const ENVELOPE_RE =
	/^\[pi-(ask|reply) ([0-9a-f]{4,16})(?: timeout=(\d{1,5}))?(?: part=(\d{1,3})\/(\d{1,3}))?\] ?/;

/** Parse a DM body into an envelope, or null for plain text / malformed. */
export function parseEnvelope(text: string): AskEnvelope | null {
	const m = ENVELOPE_RE.exec(text);
	if (!m) return null;
	const env: AskEnvelope = { kind: m[1] as "ask" | "reply", id: m[2], body: text.slice(m[0].length) };
	if (m[3] !== undefined) env.timeoutSec = Number(m[3]);
	if (m[4] !== undefined && m[5] !== undefined) {
		const i = Number(m[4]);
		const n = Number(m[5]);
		if (i < 1 || n < 1 || i > n) return null; // nonsensical markers → plain text
		env.part = { i, n };
	}
	return env;
}

/** Format a single [pi-ask] envelope (sender side; chunking handled by parts()). */
export function formatAsk(id: string, timeoutSec: number, body: string): string {
	return `[pi-ask ${id} timeout=${timeoutSec}] ${body}`;
}

/** Format a single [pi-reply] envelope, optionally as part i of n. */
export function formatReply(id: string, body: string, part?: { i: number; n: number }): string {
	const marker = part ? ` part=${part.i}/${part.n}` : "";
	return `[pi-reply ${id}${marker}] ${body}`;
}

/** Worst-case envelope prefix length for a given id (all optional fields set). */
function prefixBudget(id: string, kind: "ask" | "reply", maxDigits: number): number {
	// "[pi-reply <id> part=999/999] " is the longest plausible prefix
	return `[pi-reply ${id} part=${"9".repeat(maxDigits)}/${"9".repeat(maxDigits)}] `.length - (kind === "ask" ? 0 : 0);
}

/**
 * Split a body into fully-formed envelope messages that each fit maxChunk
 * UTF-16 units. Single chunk → no part marker. Returns ready-to-send strings.
 */
export function envelopeParts(
	kind: "ask" | "reply",
	id: string,
	body: string,
	maxChunk: number,
	timeoutSec?: number,
): string[] {
	// Budget for the longest prefix any part can carry (i and n have at most
	// maxDigits digits each; ask adds " timeout=99999").
	const digits = Math.max(2, String(Math.ceil(body.length / Math.max(8, maxChunk - 64))).length);
	const budget =
		prefixBudget(id, kind, digits) + (kind === "ask" ? " timeout=99999".length : 0) + 8;
	const room = Math.max(24, maxChunk - budget);
	const raw = chunkText(body, room);
	if (raw.length === 1) {
		return [kind === "ask" ? formatAsk(id, timeoutSec ?? 600, body) : formatReply(id, body)];
	}
	return raw.map((chunk, idx) =>
		kind === "ask"
			? formatAsk(id, timeoutSec ?? 600, chunk) // asks stay single-chunk by contract; chunk defensively
			: formatReply(id, chunk, { i: idx + 1, n: raw.length }),
	);
}

/**
 * Reassembles chunked [pi-reply] bodies by id. Feed every parsed reply
 * envelope; complete bodies pop out exactly once.
 */
export class ReplyAssembler {
	#parts = new Map<string, Map<number, string>>();
	#totals = new Map<string, number>();

	/** Returns the completed body when the last missing part arrived, else null. */
	add(id: string, part: { i: number; n: number } | undefined, body: string): string | null {
		if (!part) return body; // single-part reply
		let have = this.#parts.get(id);
		if (!have) {
			have = new Map();
			this.#parts.set(id, have);
			this.#totals.set(id, part.n);
		}
		if (!have.has(part.i)) have.set(part.i, body); // first write wins on duplicates
		if (this.#totals.get(id) !== part.n || have.size < part.n) return null;
		const joined = Array.from({ length: part.n }, (_, k) => have!.get(k + 1) ?? "").join("");
		this.#parts.delete(id);
		this.#totals.delete(id);
		return joined;
	}
}

// ---------------------------------------------------------------------------
// Registry

export interface OutboundAsk {
	id: string;
	peer: string;
	question: string;
	sentAt: number;
	timeoutMs: number;
	state: "waiting" | "replied" | "timeout";
	reply?: string;
	repliedAt?: number;
}

export interface InboundAsk {
	id: string;
	peer: string;
	question: string;
	receivedAt: number;
	resolvedAt?: number;
	repliedText?: string;
}

export type AskResolution =
	| { status: "replied"; id: string; peer: string; reply: string; elapsedMs: number }
	| { status: "timeout"; id: string; peer: string; question: string; timeoutMs: number };

export interface AskRegistryOptions {
	now?: () => number;
	setTimer?: (ms: number, fn: () => void) => unknown;
	clearTimer?: (handle: unknown) => void;
	idGen?: () => string;
}

const DEFAULT_ID_GEN = (): string => {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Tracks asks in both directions. Outbound asks expose a promise that settles
 * on the peer's reply (or the timeout); inbound asks track whether we still
 * owe an answer. Timers are injectable so tests stay deterministic.
 */
export class AskRegistry {
	#outbound = new Map<string, OutboundAsk>();
	#inbound = new Map<string, InboundAsk>();
	#waiters = new Map<string, (r: AskResolution) => void>();
	#timers = new Map<string, unknown>();
	#now: () => number;
	#setTimer: (ms: number, fn: () => void) => unknown;
	#clearTimer: (handle: unknown) => void;
	#idGen: () => string;

	constructor(opts: AskRegistryOptions = {}) {
		this.#now = opts.now ?? (() => Date.now());
		this.#setTimer = opts.setTimer ?? ((ms, fn) => setTimeout(fn, ms));
		this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.#idGen = opts.idGen ?? DEFAULT_ID_GEN;
	}

	/** Register an ask we sent; returns its id and its resolution promise. */
	trackOutbound(peer: string, question: string, timeoutMs: number): {
		id: string;
		done: Promise<AskResolution>;
	} {
		const id = this.#idGen();
		const entry: OutboundAsk = {
			id,
			peer,
			question,
			sentAt: this.#now(),
			timeoutMs,
			state: "waiting",
		};
		this.#outbound.set(id, entry);
		const done = new Promise<AskResolution>((resolve) => {
			this.#waiters.set(id, resolve);
			const handle = this.#setTimer(timeoutMs, () => {
				const ask = this.#outbound.get(id);
				if (!ask || ask.state !== "waiting") return;
				ask.state = "timeout";
				this.#waiters.delete(id);
				this.#timers.delete(id);
				resolve({ status: "timeout", id, peer, question, timeoutMs });
			});
			this.#timers.set(id, handle);
		});
		return { id, done };
	}

	/** Resolve a waiting outbound ask with a reply body. False if unknown/done. */
	resolveReply(id: string, reply: string): boolean {
		const ask = this.#outbound.get(id);
		if (!ask || ask.state !== "waiting") return false;
		const handle = this.#timers.get(id);
		if (handle !== undefined) this.#clearTimer(handle);
		this.#timers.delete(id);
		ask.state = "replied";
		ask.reply = reply;
		ask.repliedAt = this.#now();
		const waiter = this.#waiters.get(id);
		this.#waiters.delete(id);
		waiter?.({
			status: "replied",
			id,
			peer: ask.peer,
			reply,
			elapsedMs: ask.repliedAt - ask.sentAt,
		});
		return true;
	}

	/** An ask arrived from a peer. */
	trackInbound(id: string, peer: string, question: string): InboundAsk {
		const entry: InboundAsk = { id, peer, question, receivedAt: this.#now() };
		this.#inbound.set(id, entry);
		return entry;
	}

	/** Mark an inbound ask answered by us. False if unknown/already resolved. */
	resolveInbound(id: string, repliedText: string): boolean {
		const ask = this.#inbound.get(id);
		if (!ask || ask.resolvedAt !== undefined) return false;
		ask.resolvedAt = this.#now();
		ask.repliedText = repliedText;
		return true;
	}

	/** Still-unanswered asks others sent us. */
	pendingInbound(): InboundAsk[] {
		return [...this.#inbound.values()].filter((a) => a.resolvedAt === undefined);
	}

	/** Our asks still awaiting a reply. */
	pendingOutbound(): OutboundAsk[] {
		return [...this.#outbound.values()].filter((a) => a.state === "waiting");
	}

	/** Recent entries in both directions for the `pending` op (newest first). */
	list(limit = 10): { outbound: OutboundAsk[]; inbound: InboundAsk[] } {
		const outbound = [...this.#outbound.values()].sort((a, b) => b.sentAt - a.sentAt).slice(0, limit);
		const inbound = [...this.#inbound.values()].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit);
		return { outbound, inbound };
	}

	/** Drop all timers (session stop). Pending promises settle on their timeout only if the timer already fired. */
	dispose(): void {
		for (const handle of this.#timers.values()) this.#clearTimer(handle);
		this.#timers.clear();
	}
}
