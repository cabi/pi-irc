/**
 * Channel state: what we have joined and who else is there. Pure data
 * structure; the session layer feeds it from 353/366 (NAMES), JOIN/PART,
 * QUIT/NICK, and topic replies (332/333).
 *
 * Channel names compare case-insensitively under RFC 2812 casemapping
 * (ASCII strict — [#x]~ map to {}|^ only under rfc1459 rules, which modern
 * servers rarely use; we note that limitation instead of implementing it).
 */

export interface ChannelState {
	name: string;
	joinedAt: number;
	topic: string | null;
	/** Case-folded nicks. */
	members: Set<string>;
}

export function validChannelName(name: string): boolean {
	if (!/^[#+&][^\s,\x00\x07:]{1,49}$/.test(name)) return false;
	return true;
}

export class Channels {
	private channels = new Map<string, ChannelState>();

	static fold(name: string): string {
		return name.toLowerCase();
	}

	joined(name: string): boolean {
		return this.channels.has(Channels.fold(name));
	}

	join(name: string, now = Date.now()): ChannelState {
		const key = Channels.fold(name);
		let state = this.channels.get(key);
		if (!state) {
			state = { name, joinedAt: now, topic: null, members: new Set() };
			this.channels.set(key, state);
		}
		return state;
	}

	part(name: string): boolean {
		return this.channels.delete(Channels.fold(name));
	}

	get(name: string): ChannelState | undefined {
		return this.channels.get(Channels.fold(name));
	}

	addMember(channel: string, nick: string): void {
		this.join(channel).members.add(Channels.fold(nick));
	}

	removeMember(channel: string, nick: string): void {
		this.get(channel)?.members.delete(Channels.fold(nick));
	}

	/** True if the nick is still tracked in ANY channel we're in. */
	memberAnywhere(nick: string): boolean {
		const key = Channels.fold(nick);
		for (const state of this.channels.values()) if (state.members.has(key)) return true;
		return false;
}

	/** Someone quit the server: drop them from every channel. */
	removeMemberEverywhere(nick: string): string[] {
		const key = Channels.fold(nick);
		const affected: string[] = [];
		for (const state of this.channels.values()) {
			if (state.members.delete(key)) affected.push(state.name);
		}
		return affected;
	}

	renameMember(oldNick: string, newNick: string): void {
		const oldKey = Channels.fold(oldNick);
		const newKey = Channels.fold(newNick);
		for (const state of this.channels.values()) {
			if (state.members.delete(oldKey)) state.members.add(newKey);
		}
	}

	setTopic(channel: string, topic: string): void {
		const state = this.get(channel);
		if (state) state.topic = topic;
	}

	names(channel: string, nicknames: string[]): void {
		const state = this.join(channel);
		for (const raw of nicknames) {
			// Strip membership prefixes (@ + ~ & %) — presence is what we track.
			state.members.add(Channels.fold(raw.replace(/^[~&@%+\s]+/, "")));
		}
	}

	list(): ChannelState[] {
		return [...this.channels.values()];
	}
}
