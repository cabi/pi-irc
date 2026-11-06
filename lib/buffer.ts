/**
 * Buffer: per-conversation ring buffers with read cursors. Every inbound
 * PRIVMSG/NOTICE lands here; `read` drains unread messages and advances
 * the cursor. Pure data structure — the session layer feeds it.
 *
 * Conversations are keyed by lowercased channel or peer nick; the original
 * casing is kept on each message for display.
 */

export type MessageKind = "chan" | "dm" | "notice" | "action" | "system" | "ask" | "reply";

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
	cursorSeq: number; // last seq the session has read
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
			conv = { display: msg.display ?? msg.conv, messages: [], cursorSeq: 0 };
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
		if (conv.messages.length > this.maxPerConv) conv.messages.splice(0, conv.messages.length - this.maxPerConv);
		return entry;
	}

	/** Unread counts per conversation, keyed by display name. */
	unreadAll(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const conv of this.convs.values()) {
			const n = conv.messages.filter((m) => m.seq > conv.cursorSeq).length;
			if (n > 0) out[conv.display] = n;
		}
		return out;
	}

	unread(conv: string): number {
		const c = this.convs.get(conv.toLowerCase());
		if (!c) return 0;
		return c.messages.filter((m) => m.seq > c.cursorSeq).length;
	}

	/**
	 * Drain unread messages (oldest first) applying filters, and advance
	 * the cursor past everything returned. An explicit `conv` advances
	 * only that conversation.
	 */
	read(opts: ReadOptions = {}): BufferedMessage[] {
		const limit = opts.limit ?? 200;
		const targets = opts.conv
			? [this.convs.get(opts.conv.toLowerCase())]
			: [...this.convs.values()];
		const out: BufferedMessage[] = [];
		for (const conv of targets) {
			if (!conv) continue;
			const unread = conv.messages.filter(
				(m) =>
					m.seq > conv.cursorSeq &&
					(!opts.from || m.from.toLowerCase() === opts.from.toLowerCase()) &&
					(!opts.since || m.ts >= opts.since),
			);
			out.push(...unread);
		}
		out.sort((a, b) => a.seq - b.seq);
		const result = out.slice(0, limit);
		// Advance cursors past everything returned.
		for (const m of result) {
			const conv = this.convs.get(m.conv);
			if (conv && m.seq > conv.cursorSeq) conv.cursorSeq = m.seq;
		}
		return result;
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
