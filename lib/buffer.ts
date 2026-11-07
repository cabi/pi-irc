/**
 * Buffer: per-conversation ring buffers with read cursors. Every inbound
 * PRIVMSG/NOTICE lands here; `read` drains unread messages and advances
 * the cursor. Pure data structure — the session layer feeds it.
 *
 * Conversations are keyed by lowercased channel or peer nick; the original
 * casing is kept on each message for display.
 */

export type MessageKind = "chan" | "dm" | "notice" | "action" | "system" | "ask" | "reply";

/** Per-conversation pending message counts, keyed by display name. */
export type UnreadCounts = Record<string, number>;

export interface BufferedMessage {
	/** Monotonic sequence number across the whole buffer. */
	seq: number;
	/** Conversation key (lowercased channel or nick). */
	conv: string;
	/** Display form: "#Project" or "Peer". */
	channel: string;
	from: string;
	text: string;
	ts: number;
	kind: MessageKind;
	/** True if our nick was mentioned in the text. */
	mentioned: boolean;
}

export interface ReadOptions {
	/** Restrict to one conversation (channel or nick, case-insensitive). */
	conv?: string;
	/** Only messages from this nick (case-insensitive). */
	from?: string;
	/** Only messages at/after this timestamp. */
	since?: number;
	/** Max messages to return (default 200). */
	limit?: number;
}

interface Conversation {
	display: string;
	messages: BufferedMessage[];
	cursorSeq: number; // contiguous prefix read
	/** Delivered-but-not-yet-contiguous seqs (filtered reads above the cursor). */
	delivered: Set<number>;
	/** Incremental unread count: seq > cursorSeq && !delivered.has(seq). */
	pending: number;
}

/** Characters that can legally continue an IRC nick — mention boundaries. */
const NICK_CHARS = "[\\w_-]"; // pi-irc nicks are [a-z0-9_-]; brackets etc. are separators

/** Case-insensitive word-boundary mention check. */
export function mentionsNick(text: string, nick: string): boolean {
	if (!nick) return false;
	const re = new RegExp(`(?<!${NICK_CHARS})${escapeRe(nick)}(?!${NICK_CHARS})`, "i");

	return re.test(text);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MessageBuffer {
	private convs = new Map<string, Conversation>();
	private nextSeq = 1;

	constructor(
		private readonly maxPerConv = 500,
		private readonly selfNick = "",
	) {}

	/** Record an inbound message; returns it with seq/mention stamped. */
	push(msg: {
		conv: string;
		display?: string;
		from: string;
		text: string;
		ts?: number;
		kind?: MessageKind;
	}): BufferedMessage {
		const key = msg.conv.toLowerCase();
		let conv = this.convs.get(key);

		if (!conv) {
			conv = { display: msg.display ?? msg.conv, messages: [], cursorSeq: 0, delivered: new Set(), pending: 0 };
			this.convs.set(key, conv);
		}

		const entry: BufferedMessage = {
			seq: this.nextSeq++,
			conv: key,
			channel: conv.display,
			from: msg.from,
			text: msg.text,
			ts: msg.ts ?? Date.now(),
			kind: msg.kind ?? (key.startsWith("#") || key.startsWith("&") ? "chan" : "dm"),
			mentioned: mentionsNick(msg.text, this.selfNick) && msg.from.toLowerCase() !== this.selfNick.toLowerCase(),
		};

		conv.messages.push(entry);
		conv.pending += 1; // every fresh message starts unread

		if (conv.messages.length > this.maxPerConv) {
			const dropped = conv.messages.splice(0, conv.messages.length - this.maxPerConv);

			for (const m of dropped) {
				const wasPending = m.seq > conv.cursorSeq && !conv.delivered.has(m.seq);
				conv.delivered.delete(m.seq); // no dead marks

				if (wasPending) conv.pending -= 1;
			}
		}

		return entry;
	}

	/** Unread counts per conversation, keyed by display name. */

	unreadAll() {
		const out: Record<string, number> = {};

		for (const conv of this.convs.values()) {
			if (conv.pending > 0) out[conv.display] = conv.pending;
		}

		return out;
	}

	unread(conv: string): number {
		return this.convs.get(conv.toLowerCase())?.pending ?? 0;
	}

	/**
	 * Drain unread messages (oldest first) applying filters. The cursor
	 * advances only contiguously past delivered messages; filtered-out or
	 * limit-cut unread messages stay unread. An explicit `conv` drains
	 */
	read(opts: ReadOptions = {}): BufferedMessage[] {
		const limit = opts.limit ?? 200;
		const targets = opts.conv ? [this.convs.get(opts.conv.toLowerCase())] : [...this.convs.values()];
		const out: BufferedMessage[] = [];

		for (const conv of targets) {
			if (!conv) continue;

			const unread = conv.messages.filter(
				(m) =>
					m.seq > conv.cursorSeq &&
					!conv.delivered.has(m.seq) &&
					(!opts.from || m.from.toLowerCase() === opts.from.toLowerCase()) &&
					(!opts.since || m.ts >= opts.since),
			);

			out.push(...unread);
		}

		out.sort((a, b) => a.seq - b.seq);
		const result = out.slice(0, limit);

		// Mark exactly the delivered messages read; the contiguous prefix
		// advances the cursor, the rest wait as delivery marks so nothing
		// skipped can ever be lost and nothing delivered repeats.
		for (const m of result) {
			const conv = this.convs.get(m.conv);

			if (!conv) continue;

			if (!conv.delivered.has(m.seq)) conv.pending -= 1;
			conv.delivered.add(m.seq);
		}

		for (const conv of targets) {
			if (!conv) continue;

			for (const m of conv.messages) {
				if (m.seq <= conv.cursorSeq) continue;

				if (!conv.delivered.has(m.seq)) break; // first undelivered unread blocks
				conv.cursorSeq = m.seq;
				conv.delivered.delete(m.seq);
			}
		}

		return result;
	}
	/**
	 * Advance the read cursor to the newest buffered message WITHOUT returning
	 * anything — "I know, clear it". Returns flushed counts per display name.
	 */
	mark(conv?: string) {
		const targets = conv ? [this.convs.get(conv.toLowerCase())] : [...this.convs.values()];
		const out: Record<string, number> = {};

		for (const c of targets) {
			if (!c) continue;
			const last = c.messages.at(-1);

			if (last && last.seq > c.cursorSeq) {
				out[c.display] = c.pending;
				c.cursorSeq = last.seq;
				c.delivered.clear();
				c.pending = 0;
			}
		}

		return out;
	}

	/** Everything still buffered for a conversation, read or not. */
	history(conv: string, limit = this.maxPerConv): BufferedMessage[] {
		const c = this.convs.get(conv.toLowerCase());

		if (!c) return [];

		return c.messages.slice(-limit);
	}

	conversations(): string[] {
		return [...this.convs.values()].map((c) => c.display);
	}
}
