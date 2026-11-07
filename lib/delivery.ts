/**
 * Delivery: outbound send queue with IRC flood control and long-message
 * chunking. The session layer enqueues intent ("say this to that target");
 * the queue paces the wire.
 *
 * Flood model — the classic client-side penalty bucket: up to `burst`
 * messages go out immediately, then one message per `intervalMs`. This
 * keeps us under typical server limits (most daemons allow a small burst
 * then 1-2 msgs/sec) without knowing the server's exact configuration.
 *
 * Chunking — a PRIVMSG line must fit in 512 bytes including the
 * ":nick!user@host PRIVMSG TARGET :" envelope. We chunk at `maxChunk`
 * (default 400) UTF-8 bytes — the same unit as the 512-byte line cap —
 * preferring spaces as split points, and stamp " (i/n)" on every chunk
 */

import { WireError } from "./wire.ts";

export interface DeliveryOptions {
	/** Free messages before throttling kicks in. */
	burst?: number;
	/** Wait between messages once the burst is spent. */
	intervalMs?: number;
	/** Max length per chunk when chunking is on. */
	maxChunk?: number;
	/** Chunk messages longer than maxChunk (delivery.chunkLongSends). */
	/** Chunk messages longer than maxChunk (delivery.chunkLongSends). */
	chunkLong?: boolean;
	/** Upper bound on queued chunks; enqueue beyond it throws (backpressure). */
	maxQueue?: number;
}

export interface OutboundChunk {
	target: string;
	text: string;
	/** Index (1-based) and total when the original message was chunked. */
	part?: { i: number; n: number };
}

interface QueueItem {
	target: string;
	chunks: string[];
	part: { i: number; n: number } | null;
	nextIndex: number;
}

/**
 * Split text into pieces of at most `maxChunk` UTF-8 BYTES, preferring
 * spaces as split points. Byte-aware, not code-unit-aware: IRC lines are
 * capped at 512 bytes, and CJK text (3 bytes/char) would blow that budget
 * long before 400 characters. Surrogate pairs never split mid-pair.
 */
export function chunkText(text: string, maxChunk: number): string[] {
	if (maxChunk < 8) throw new Error("maxChunk must be >= 8");
	if (byteLength(text) <= maxChunk) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let bytes = 0;
		let end = start;
		let lastSpace = -1;
		let bytesAtSpace = 0;
		while (end < text.length) {
			const size = charBytes(text, end);
			if (bytes + size > maxChunk) break;
			if (text.charCodeAt(end) === 0x20) {
				lastSpace = end;
				bytesAtSpace = bytes;
			}
			bytes += size;
			end += size === 4 ? 2 : 1; // surrogate pair advances two units
		}
		// Prefer a word boundary unless it would shrink the chunk below half budget.
		let cut = end;
		if (end < text.length && lastSpace > start && bytesAtSpace >= Math.ceil(maxChunk / 2)) cut = lastSpace;
		chunks.push(text.slice(start, cut));
		// A space split consumes the space; a hard split consumes exactly what fit.
		start = cut === lastSpace ? cut + 1 : cut;
	}
	return chunks;
}

/** UTF-8 byte length of one code point at index i (surrogate pair = 4). */
function charBytes(s: string, i: number): number {
	const code = s.charCodeAt(i);
	if (code < 0x80) return 1;
	if (code < 0x800) return 2;
	if (code >= 0xd800 && code <= 0xdbff) return 4;
	if (code >= 0xdc00 && code <= 0xdfff) return 0; // low half of a pair
	return 3;
}

function byteLength(s: string): number {
	let bytes = 0;
	for (let i = 0; i < s.length; ) {
		const size = charBytes(s, i) || 1; // orphan low surrogate: degenerate, count as 1
		bytes += size;
		i += size === 4 ? 2 : 1;
	}
	return bytes;
}

export class DeliveryQueue {
	/** Optional sink notified when a chunk is dropped as unsendable. */
	onDrop?: (target: string, text: string, err: Error) => void;
	private queue: QueueItem[] = [];
	private tokens: number;
	private lastSendAt: number | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	/** Paused while the link is down: items queue up, drain sends nothing. */
	private paused = false;
	/** Chunk budget the queue was built with (envelope writers respect it). */
	get maxChunk(): number {
		return this.opts.maxChunk;
	}

	constructor(
		private readonly sender: (target: string, text: string) => void,
		private readonly opts: Required<DeliveryOptions> = {
			burst: 4,
			intervalMs: 2000,
			maxChunk: 400,
			chunkLong: true,
			maxQueue: 512,
		},
	) {
		this.tokens = this.opts.burst;
	}
	/** Queue a message; returns the number of chunks it was split into.
	 * Throws when the queue is at maxQueue chunks — backpressure surfaces to
	 * the caller instead of unbounded memory growth. */
	enqueue(target: string, text: string): number {
		const queued = this.pending() + 1; // ≥1 chunk for this item after split
		if (this.opts.chunkLong) {
			const chunks = chunkText(text, this.opts.maxChunk);
			if (this.pending() + chunks.length > this.opts.maxQueue) {
				throw new Error(`delivery queue full (${this.pending()} chunks queued, max ${this.opts.maxQueue})`);
			}
			const n = chunks.length;
			this.queue.push({ target, chunks, part: n > 1 ? { i: 0, n } : null, nextIndex: 0 });
			return n;
		}
		if (queued > this.opts.maxQueue) {
			throw new Error(`delivery queue full (${this.pending()} chunks queued, max ${this.opts.maxQueue})`);
		}
		this.queue.push({ target, chunks: [text], part: null, nextIndex: 0 });
		return 1;
	}

	/**
	 * Send everything currently due (burst tokens available or interval
	 * elapsed). Returns the chunks sent. `now` is injectable for tests.
	 */
	drain(now = Date.now()): OutboundChunk[] {
		const sent: OutboundChunk[] = [];
		if (this.paused) return sent;
		while (this.queue.length > 0) {
			// Refill one token per interval since the last send.
			if (this.tokens < this.opts.burst && this.lastSendAt !== null) {
				const earned = Math.floor((now - this.lastSendAt) / this.opts.intervalMs);
				if (earned > 0) {
					this.tokens = Math.min(this.opts.burst, this.tokens + earned);
					this.lastSendAt = now - ((now - this.lastSendAt) % this.opts.intervalMs);
				}
			}
			if (this.tokens <= 0) break;
			const item = this.queue[0];
			const text = item.chunks[item.nextIndex];
			let part: OutboundChunk["part"];
			if (item.part) part = { i: item.nextIndex + 1, n: item.part.n };
			try {
				this.sender(item.target, text);
			} catch (err) {
				if (err instanceof WireError) {
					// Permanent rejection (e.g. exceeds the 512-byte line cap):
					// retrying can never help — drop this chunk so the queue
					// keeps flowing instead of blocking on it forever.
					this.onDrop?.(item.target, text, err);
					item.nextIndex += 1;
					this.tokens -= 1;
					this.lastSendAt = now;
					if (item.nextIndex >= item.chunks.length) this.queue.shift();
					continue;
				}
				// Transport died mid-drain: leave the chunk queued (indices
				// untouched) — pause()/socketClosed owns the state from here.
				break;
			}
			sent.push({ target: item.target, text, part });
			item.nextIndex += 1;
			this.tokens -= 1;
			this.lastSendAt = now;
			if (item.nextIndex >= item.chunks.length) this.queue.shift();
		}
		return sent;
	}

	/** Start background pacing. Drain runs on the interval tick. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.drain(), Math.max(100, Math.floor(this.opts.intervalMs / 4)));
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Pause while the link is down: enqueue keeps working, drain holds. */
	pause(): void {
		this.paused = true;
	}

	/** Resume after the link is back — flushes immediately. */
	resume(): void {
		this.paused = false;
		this.drain();
	}

	/** Drop everything queued (e.g. on reconnect). */
	clear(): void {
		this.queue = [];
	}

	pending(): number {
		return this.queue.reduce((n, item) => n + (item.chunks.length - item.nextIndex), 0);
	}
}
