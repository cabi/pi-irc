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

export interface AskEnvelope {
	kind: "ask" | "reply";
	id: string;
	/** ask only: seconds the asker is willing to wait */
	timeoutSec?: number;
	/** part markers when the sender chunked (1-based i of n) */
	part?: { i: number; n: number };
	body: string;
}

const ENVELOPE_RE = /^\[pi-(ask|reply) ([0-9a-f]{4,16})(?: timeout=(\d{1,5}))?(?: part=(\d{1,3})\/(\d{1,3}))?\] ?/;

/** Parse a DM body into an envelope, or null for plain text / malformed. */
export function parseEnvelope(text: string): AskEnvelope | null {
	const m = ENVELOPE_RE.exec(text);

	if (!m) return null;
	const body = text.slice(m[0].length);

	if (!body.trim()) return null; // empty body: not a real envelope, just text
	const env: AskEnvelope = { kind: m[1] as "ask" | "reply", id: m[2], body };

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

/**
 * Split text into ≤maxLen pieces WITHOUT losing the separator: a split at a
 * space keeps that space at the end of the chunk, so joining chunks with ""
 * reconstructs the input exactly. (delivery.chunkText drops the space — fine
 * for human-readable plain sends, wrong for protocol payloads.)
 */
function splitLossless(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let rest = text;

	while (rest.length > maxLen) {
		let cut = rest.lastIndexOf(" ", maxLen);

		if (cut < Math.ceil(maxLen / 2)) cut = maxLen; // no good space: hard split
		const keep = cut === maxLen ? cut : cut + 1; // space split keeps the space
		chunks.push(rest.slice(0, keep));
		rest = rest.slice(keep);
	}

	if (rest.length > 0) chunks.push(rest);

	return chunks;
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
	const budget = prefixBudget(id, kind, digits) + (kind === "ask" ? " timeout=99999".length : 0) + 8;
	const room = Math.max(24, maxChunk - budget);
	const raw = splitLossless(body, room);

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
	#seenAt = new Map<string, number>();
	#now: () => number;
	#ttlMs: number;
	#maxPending: number;

	constructor(opts: { now?: () => number; ttlMs?: number; maxPending?: number } = {}) {
		this.#now = opts.now ?? (() => Date.now());
		this.#ttlMs = opts.ttlMs ?? 10 * 60_000;
		this.#maxPending = opts.maxPending ?? 64;
	}

	/** Key by sender+id: two peers using the same id must never interleave. */
	static key(sender: string, id: string): string {
		return `${sender}\0${id}`;
	}

	/** Returns the completed body when the last missing part arrived, else null. */
	add(sender: string, id: string, part: { i: number; n: number } | undefined, body: string): string | null {
		if (!part) return body; // single-part reply
		const key = ReplyAssembler.key(sender, id);
		this.#sweep();
		let have = this.#parts.get(key);

		if (!have) {
			// Bound the assembler: evict the stalest incomplete id first.
			while (this.#parts.size >= this.#maxPending) this.#evictOldest();
			have = new Map();
			this.#parts.set(key, have);
			this.#totals.set(key, part.n);
		}

		this.#seenAt.set(key, this.#now());

		if (!have.has(part.i)) have.set(part.i, body); // first write wins on duplicates

		if (this.#totals.get(key) !== part.n || have.size < part.n) return null;
		const joined = Array.from({ length: part.n }, (_, k) => have!.get(k + 1) ?? "").join("");
		this.#forget(key);

		return joined;
	}

	#forget(key: string): void {
		this.#parts.delete(key);
		this.#totals.delete(key);
		this.#seenAt.delete(key);
	}

	#evictOldest(): void {
		let oldest: string | null = null;
		let oldestAt = Infinity;

		for (const [key, at] of this.#seenAt) {
			if (at < oldestAt) {
				oldestAt = at;
				oldest = key;
			}
		}

		if (oldest !== null) this.#forget(oldest);
	}

	/** Drop incomplete assemblies older than the TTL (fragment floods never accumulate). */
	#sweep(): void {
		const cutoff = this.#now() - this.#ttlMs;

		for (const [key, at] of this.#seenAt) {
			if (at < cutoff) this.#forget(key);
		}
	}

	/** Incomplete ids currently held (diagnostics). */
	pendingCount(): number {
		return this.#parts.size;
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
	| { status: "timeout"; id: string; peer: string; question: string; timeoutMs: number }
	| { status: "disposed"; id: string; peer: string; question: string };

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
	trackOutbound(
		peer: string,
		question: string,
		timeoutMs: number,
	): {
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
		this.#purge();

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
	/** Resolve a waiting outbound ask with a reply body. False if unknown/done.
	 * `from` (when given) must casefold-match the asked peer: a reply from
	 * anyone else is foreign text, never the answer. */
	resolveReply(id: string, reply: string, from?: string): boolean {
		const ask = this.#outbound.get(id);

		if (!ask || ask.state !== "waiting") return false;

		if (from !== undefined && from.toLowerCase() !== ask.peer.toLowerCase()) return false;
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
		this.#purge();

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

	/** Bound the registries: cap at 256 entries each, expire finished/stale
	 * records after 24 h. Called on every track — Maps iterate in insertion
	 * order, so eviction drops the oldest first. */
	#purge(): void {
		const cutoff = this.#now() - 24 * 3600_000;

		for (const [id, a] of this.#outbound) {
			if (a.state !== "waiting" && a.sentAt < cutoff) this.#outbound.delete(id);
		}

		for (const [id, a] of this.#inbound) {
			if (a.resolvedAt !== undefined && a.receivedAt < cutoff) this.#inbound.delete(id);
		}

		while (this.#outbound.size > 256) {
			const oldest = this.#outbound.keys().next().value as string;

			if (this.#outbound.get(oldest)?.state === "waiting") break; // never evict live asks
			this.#outbound.delete(oldest);
		}

		while (this.#inbound.size > 256) {
			const oldest = this.#inbound.keys().next().value as string;

			if (this.#inbound.get(oldest)?.resolvedAt === undefined) break;
			this.#inbound.delete(oldest);
		}
	}

	/** Drop all timers and settle every waiter: pending asks must not hang
	 * past session stop. Settled as `disposed` — the ask op surfaces that. */
	dispose(): void {
		for (const handle of this.#timers.values()) this.#clearTimer(handle);
		this.#timers.clear();

		for (const [id, waiter] of this.#waiters) {
			const ask = this.#outbound.get(id);
			waiter({
				status: "disposed",
				id,
				peer: ask?.peer ?? "?",
				question: ask?.question ?? "",
			});
		}

		this.#waiters.clear();
	}
}
