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
 * ":nick!user@host PREFIX TARGET :" envelope. We chunk at `maxChunk`
 * (default 400) UTF-16 code units, preferring spaces as split points,
 * and stamp " (i/n)" on every chunk when a message splits.
 */

export interface DeliveryOptions {
	/** Free messages before throttling kicks in. */
	burst?: number;
	/** Wait between messages once the burst is spent. */
	intervalMs?: number;
	/** Max length per chunk when chunking is on. */
	maxChunk?: number;
	/** Chunk messages longer than maxChunk (delivery.chunkLongSends). */
	chunkLong?: boolean;
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

/** Split text into ≤maxChunk pieces at word boundaries where possible. */
export function chunkText(text: string, maxChunk: number): string[] {
	if (maxChunk < 8) throw new Error("maxChunk must be >= 8");
	if (text.length <= maxChunk) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > maxChunk) {
		let cut = rest.lastIndexOf(" ", maxChunk);
		if (cut < Math.ceil(maxChunk / 2)) cut = maxChunk; // no good space: hard split
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut === maxChunk ? cut : cut + 1);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

export class DeliveryQueue {
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
		},
	) {
		this.tokens = this.opts.burst;
	}
	/** Queue a message; returns the number of chunks it was split into. */
	enqueue(target: string, text: string): number {
		if (this.opts.chunkLong) {
			const chunks = chunkText(text, this.opts.maxChunk);
			const n = chunks.length;
			this.queue.push({ target, chunks, part: n > 1 ? { i: 0, n } : null, nextIndex: 0 });
			return n;
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
			} catch {
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
