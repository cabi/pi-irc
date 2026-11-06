/**
 * Roster: who is out there. A pure in-memory registry of the agents and
 * humans the extension has seen, fed by the session layer from JOIN/PART/
 * PRIVMSG/NICK events and WHO/WHOX replies.
 *
 * Identity metadata (pi agent vs human, role, project) travels in the IRC
 * realname (GECOS) field of the USER handshake — the one free-form string
 * every client must send and every server echoes back via WHO. Format:
 *   "pi-agent project=<slug> role=<main|sub>"
 * Humans (foreign clients) don't match the prefix and land as kind "human".
 */

export type AgentRole = "main" | "sub";
export type PeerKind = "agent" | "human";

export interface Peer {
	/** Exact nick as seen on the wire (case preserved). */
	nick: string;
	kind: PeerKind;
	/** Only meaningful for agents. */
	role?: AgentRole;
	/** Project slug the agent claims; may differ from ours (shared server). */
	project?: string;
	lastSeen: number;
	/** Owning session short id (agents only). */
	session?: string;
	/** Parent session short id for sub-agents. */
	parent?: string;
	/** True for our own connection's nick. */
	self: boolean;
	/** Away flag as seen via WHO (H/G), away-notify, or our own AWAY (305/306). */
	away?: boolean;
}

export interface RealnameInfo {
	kind: PeerKind;
	role?: AgentRole;
	project?: string;
	session?: string;
	parent?: string;
}

const REALNAME_PREFIX = "pi-agent";

export function formatRealname(project: string, role: AgentRole): string {
	return `${REALNAME_PREFIX} project=${project} role=${role}`;
}

export function parseRealname(realname: string): RealnameInfo {
	if (!/^pi-agent( |$)/.test(realname)) return { kind: "human" };
	const info: RealnameInfo = { kind: "agent" };
	for (const part of realname.slice(REALNAME_PREFIX.length).trim().split(/\s+/)) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const key = part.slice(0, eq);
		const value = part.slice(eq + 1);
		if (key === "role" && (value === "main" || value === "sub")) info.role = value;
		if (key === "project" && value.length > 0) info.project = value;
		if (key === "session" && value.length > 0) info.session = value;
		if (key === "parent" && value.length > 0) info.parent = value;
	}
	return info;
}

export class Roster {
	private peers = new Map<string, Peer>();
	private selfNick: string | null = null;

	/** RFC 2812 casemapping for nick/channel comparisons (ASCII strict). */
	static fold(nick: string): string {
		return nick.toLowerCase();
	}

	/** Register/refresh a peer seen on the wire. Returns the stored peer. */
	touch(nick: string, patch: Partial<Peer> = {}): Peer {
		const key = Roster.fold(nick);
		const existing = this.peers.get(key);
		const peer: Peer = {
			nick,
			kind: patch.kind ?? existing?.kind ?? "human",
			role: patch.role ?? existing?.role,
			project: patch.project ?? existing?.project,
			lastSeen: patch.lastSeen ?? Date.now(),
			self: patch.self ?? existing?.self ?? this.selfNick === key,
			away: patch.away ?? existing?.away,
		};
		this.peers.set(key, peer);
		return peer;
	}

	/** Apply a parsed realname (from WHO/WHOX) to a nick. */
	applyRealname(nick: string, realname: string): Peer {
		const info = parseRealname(realname);
		return this.touch(nick, {
			kind: info.kind,
			role: info.role,
			project: info.project,
			session: info.session,
			parent: info.parent,
		});
	}

	/** A nick changed identity; move the entry under the new nick. */
	rename(oldNick: string, newNick: string): void {
		const old = this.peers.get(Roster.fold(oldNick));
		if (!old) return;
		this.peers.delete(Roster.fold(oldNick));
		this.touch(newNick, old);
	}

	forget(nick: string): boolean {
		return this.peers.delete(Roster.fold(nick));
	}

	get(nick: string): Peer | undefined {
		return this.peers.get(Roster.fold(nick));
	}

	setSelf(nick: string): void {
		this.selfNick = Roster.fold(nick);
		for (const peer of this.peers.values()) peer.self = Roster.fold(peer.nick) === this.selfNick;
	}

	/** Agents of one project, excluding ourselves — the coordination set. */
	projectAgents(project: string): Peer[] {
		return [...this.peers.values()].filter(
			(p) => p.kind === "agent" && p.project === project && !p.self,
		);
	}

	/** The first main agent of a project, excluding ourselves, if any. */
	leadAgent(project: string): Peer | undefined {
		return this.projectAgents(project).find((p) => p.role === "main");
	}

	/** Drop peers not seen within ttlMs (offline/dead entries). */
	expire(ttlMs: number, now = Date.now()): number {
		let dropped = 0;
		for (const [key, peer] of this.peers) {
			if (!peer.self && now - peer.lastSeen > ttlMs) {
				this.peers.delete(key);
				dropped += 1;
			}
		}
		return dropped;
	}

	all(): Peer[] {
		return [...this.peers.values()];
	}
}
