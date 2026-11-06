/**
 * The `irc` tool: one lean tool, intent-level ops (ADR-0003). The session
 * machinery runs in the background (lib/session.ts); this module only
 * translates op + params into a short, low-noise text answer for the model.
 *
 * `ensureSession` is injected by the extension entry: it lazily boots the
 * IrcSession and rejects on hard failures (no config → disabled, server
 * unreachable). All ops are read-mostly; none of them block on the network
 * except `connect`.
 */
import type { IrcSession } from "./session.ts";

export const IRC_OPS = [
	"connect",
	"status",
	"roster",
	"send",
	"read",
	"ask",
	"reply",
	"pending",
	"join",
	"part",
	"help",
] as const;
export type IrcOp = (typeof IRC_OPS)[number];

export interface IrcToolParams {
	/** Validated at runtime — the pi tool schema can't be trusted blindly. */
	op: string;
	/** send: channel or nick; default = project channel. */
	target?: string;
	/** send: message text. */
	text?: string;
	/** read: restrict to one conversation (channel or nick). */
	conversation?: string;
	/** read: only messages from this nick. */
	from?: string;
	/** read: only messages at/after this unix timestamp. */
	since?: number;
	/** read: max messages (default 200). */
	limit?: number;
	/** join/part: channel names. */
	channels?: string[];
	/** ask: peer nick to ask (question goes in `text`). */
	peer?: string;
	/** ask: timeout in seconds (default 600, max 3600). */
	timeout?: number;
	/** reply: the ask id to answer (answer goes in `text`). */
	id?: string;
}

export interface IrcToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function text(body: string, details: Record<string, unknown> = {}): IrcToolResult {
	return { content: [{ type: "text", text: body }], details };
}

function fmtTime(ts: number): string {
	return new Date(ts).toISOString().slice(11, 16);
}

/** Execute one `irc` op against a live (or to-be-booted) session. */
export async function executeIrcOp(
	ensureSession: () => Promise<IrcSession>,
	op: string,
	params: IrcToolParams,
): Promise<IrcToolResult> {
	if (!(IRC_OPS as readonly string[]).includes(op)) {
		throw new Error(`unknown op "${op}" — use one of: ${IRC_OPS.join(", ")}`);
	}

	// `connect` is the only op that must reach the network on its own; all
	// others work purely on background state once the session is up.
	const session = await ensureSession();

	switch (op) {
		case "connect":
			return text(
				`connected as ${session.client.realNick ?? session.client.nick} in ${session.projectChannel} (${session.channels.list().length} channels)`,
				session.status(),
			);

		case "status": {
			const st = session.status() as Record<string, unknown>;
			const lines = Object.entries(st).map(([k, v]) => {
				const value = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
				return `${k}: ${value}`;
			});
			return text(lines.join("\n") || "no state", st);
		}

		case "roster": {
			const peers = session.rosterView();
			if (peers.length === 0) return text("nobody here yet");
			const lines = peers.map((p) => {
				const bits: string[] = [String(p.nick), p.kind === "agent" ? "agent" : "human"];
				if (p.role) bits.push(String(p.role));
			if (p.away) bits.push("busy");
				if (p.project) bits.push(`project=${p.project}`);
				if (p.session) bits.push(`session=${p.session}`);
				if (p.self) bits.push("(me)");
				return bits.join(" ");
			});
			return text(lines.join("\n"), { peers: peers.length });
		}

		case "send": {
			if (!params.text || params.text.trim().length === 0) {
				throw new Error("send requires text");
			}
			const r = session.send(params.target, params.text);
			const where = r.target === session.projectChannel ? `${r.target} (project channel)` : r.target;
			const tail = r.chunks > 1 ? ` (split into ${r.chunks} chunks)` : "";
			const queued = r.pending > 0 ? ` [${r.pending} queued behind flood limit]` : "";
			return text(`sent to ${where}${tail}${queued}`, r as unknown as Record<string, unknown>);
		}

		case "read": {
			const msgs = session.read({
				conv: params.conversation,
				from: params.from,
				since: params.since,
				limit: params.limit,
			});
			if (msgs.length === 0) return text("nothing unread", { count: 0 });
			const lines = msgs.map((m) => {
				const chan = m.channel.startsWith("#") || m.channel.startsWith("&");
				const tag = chan ? "" : m.kind === "ask" ? " (ask) " : m.kind === "reply" ? " (reply) " : " (dm) ";
				return `${fmtTime(m.ts)}${tag}${m.channel} <${m.from}> ${m.text}`;
			});
			return text(lines.join("\n"), { count: msgs.length });
		}
		case "ask": {
			if (!params.peer || !params.text?.trim()) {
				throw new Error("ask requires peer and text (the question)");
			}
			const res = await session.ask(params.peer, params.text, params.timeout);
			if (res.status === "replied") {
				return text(`${params.peer} replied: ${res.reply}`, res as unknown as Record<string, unknown>);
			}
			return text(
				`no answer from ${params.peer} within ${Math.round(res.timeoutMs / 1000)}s — the ask is still visible to them; retry or send directly`,
				res as unknown as Record<string, unknown>,
			);
		}

		case "reply": {
			if (!params.id || !params.text?.trim()) {
				const open = session.rpc.pendingInbound();
				const listed = open.length
					? `open asks:\n${open.map((a) => `  id=${a.id} from ${a.peer}: ${a.question}`).join("\n")}`
					: "no open asks";
				throw new Error(`reply requires id and text. ${listed}`);
			}
			const r = session.reply(params.id, params.text);
			return text(`replied to ${r.to} (ask id=${r.id})`, r as unknown as Record<string, unknown>);
		}

		case "pending": {
			const inb = session.rpc.pendingInbound();
			const out = session.rpc.pendingOutbound();
			const lines: string[] = [];
			lines.push(
				inb.length
					? `asks to answer (${inb.length}):\n${inb.map((a) => `  id=${a.id} from ${a.peer}: ${a.question}`).join("\n")}`
					: "no asks waiting for you",
			);
			lines.push(
				out.length
					? `asks you sent (${out.length}):\n${out.map((a) => `  id=${a.id} to ${a.peer}: ${a.question}`).join("\n")}`
					: "no asks you are waiting on",
			);
			return text(lines.join("\n"), { inbound: inb.length, outbound: out.length });
		}


		case "join": {
			const names = (params.channels ?? []).map((c) => c.trim()).filter(Boolean);
			if (names.length === 0) throw new Error("join requires channels: string[]");
			session.join(names);
			return text(`joining ${names.join(", ")} (members arrive in the background)`, { requested: names });
		}

		case "part": {
			const names = (params.channels ?? []).map((c) => c.trim()).filter(Boolean);
			if (names.length === 0) throw new Error("part requires channels: string[]");
			const project = session.projectChannel.toLowerCase();
			const allowed = names.filter((c) => c.toLowerCase() !== project);
			if (allowed.length === 0) {
				throw new Error("the project channel cannot be parted");
			}
			session.part(allowed);
			const skipped = names.filter((c) => c.toLowerCase() === project);
			return text(`parting ${allowed.join(", ")}${skipped.length ? ` (kept ${skipped.join(", ")})` : ""}`, { parted: allowed });
		}

		case "help": {
			const st = session.status() as { nick?: string; projectChannel?: string };
			return text(
				[
					`irc — you are ${st.nick} on ${st.projectChannel}`,
					"",
					"ops:",
					"  connect — ensure connection (usually already done; idempotent)",
					"  status — nick, role, channels, unread counts",
					"  roster — who is on the project channel (agents and humans)",
					"  send — text [+ optional target channel/nick]; default: project channel",
					"  read — unread messages [conversation=..., from=..., since=..., limit=N]",
				"  ask — peer + text: correlated question; blocks until their reply or timeout",
				"  reply — id + text: answer an ask (ids shown in read/pending output)",
				"  pending — asks waiting on you and asks you are waiting on",
					"  join / part — channels: string[] (project channel cannot be parted)",
					"",
					"humans and other agents see your messages as normal IRC traffic;",
					"check `read` after tool work — DMs to you are buffered until read.",
				].join("\n"),
			);
		}
	}
	throw new Error(`unhandled op "${op}"`);
}
