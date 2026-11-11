/**
 * Delivery: outbound send queue with IRC flood control and long-message
 * chunking. The session layer enqueues intent ("say this to that target");
 * the queue shapes each intent into wire-legal messages (NUL-stripped, one
 * per content line — see normalizeLines) and paces them onto the wire.
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

/** Defaults merged in the constructor — every field optional (a raw config
 * may omit the whole flood section; `undefined` values fall back too). */
export interface DeliveryOptions {
	/** Free messages before throttling kicks in. */
	burst?: number;
	/** Wait between messages once the burst is spent. */
	intervalMs?: number;
	/** Max length per chunk when chunking is on. */
	maxChunk?: number;
	/** Chunk messages longer than maxChunk (delivery.chunkLongSends). */
	chunkLong?: boolean;
	/** Max content lines per send to a channel target (product cap against
	 * pasted-log noise, not a server rule); 0 disables. DMs are uncapped. */
	channelLineCap?: number;
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

	for (let i = 0; i < s.length;) {
		const size = charBytes(s, i) || 1; // orphan low surrogate: degenerate, count as 1
		bytes += size;
		i += size === 4 ? 2 : 1;
	}

	return bytes;
}

/** What enqueue queued. `messages` counts PRIVMSGs (every line's chunks
 * plus a truncation marker if the channel cap cut anything); `lines` is
 * content lines after normalization, before the cap; `truncated` is the
 * lines the cap cut. */
export interface EnqueueResult {
	messages: number;
	lines: number;
	truncated: number;
}

/** Default per-send line cap for channel targets — a product cap against
 * pasted-log noise (a 100-line paste paced at 1 msg/s fills a shared
 * channel for minutes), not a server rule. DM targets are uncapped. */
export const DEFAULT_CHANNEL_LINE_CAP = 10;

/**
 * Split outbound text into wire-legal content lines. NULs are stripped
 * (always an encoding accident, invisible everywhere); CR, LF, and CRLF
 * break lines; trailing whitespace is trimmed per line while leading
 * whitespace — code indentation — survives; blank lines are dropped.
 * Throws when nothing survives, so a whitespace-only send fails loudly
 * at enqueue instead of draining an empty queue.
 */
export function normalizeLines(text: string): string[] {
	const lines = text
		.replaceAll("\0", "")
		.split(/\r\n|\r|\n/)
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);

	if (lines.length === 0) {
		throw new Error("message is empty after line normalization (only blank lines or NULs)");
	}

	return lines;
}

/** Channel target per RFC 2812 §1.3 (the same # + & set wire.join validates). */
function isChannelTarget(target: string): boolean {
	return /^[#&+]/.test(target);
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

	private readonly opts: Required<DeliveryOptions>;
	constructor(
		private readonly sender: (target: string, text: string) => void,
		opts: DeliveryOptions = {},
	) {
		this.opts = {
			burst: opts.burst ?? 4,
			intervalMs: opts.intervalMs ?? 2000,
			maxChunk: opts.maxChunk ?? 400,
			chunkLong: opts.chunkLong ?? true,
			channelLineCap: opts.channelLineCap ?? DEFAULT_CHANNEL_LINE_CAP,
			maxQueue: opts.maxQueue ?? 512,
		};
		this.tokens = this.opts.burst;
	}
	/** Queue one send as wire-legal messages (see normalizeLines; channel
	 * targets cap at channelLineCap content lines with an in-channel
	 * truncation marker). Throws on input that normalizes to nothing and
	 * when the queue is at maxQueue chunks — backpressure surfaces to the
	 * caller instead of unbounded memory growth. */
	enqueue(target: string, text: string): EnqueueResult {
		const lines = normalizeLines(text);
		let send = lines;
		let truncated = 0;

		if (this.opts.channelLineCap > 0 && isChannelTarget(target) && lines.length > this.opts.channelLineCap) {
			truncated = lines.length - this.opts.channelLineCap;
			send = [
				...lines.slice(0, this.opts.channelLineCap),
				`(… ${truncated} more line${truncated === 1 ? "" : "s"} truncated)`,
			];
		}

		const chunked = this.opts.chunkLong
			? send.map((line) => chunkText(line, this.opts.maxChunk))
			: send.map((line) => [line]);

		const messages = chunked.reduce((n, chunks) => n + chunks.length, 0);

		if (this.pending() + messages > this.opts.maxQueue) {
			throw new Error(`delivery queue full (${this.pending()} chunks queued, max ${this.opts.maxQueue})`);
		}

		for (const chunks of chunked) {
			const n = chunks.length;
			this.queue.push({ target, chunks, part: n > 1 ? { i: 0, n } : null, nextIndex: 0 });
		}

		return { messages, lines: lines.length, truncated };
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
