/**
 * The `/irc` slash command (PRODUCT.md P2 convenience): a thin human-side
 * wrapper over the same `irc` tool ops. Deliberately tiny — status, read,
 * send — because humans in pi already have the model; the command is for
 * quick inspection without a round-trip.
 */
import { executeIrcOp } from "./tool.ts";
import type { IrcSession } from "./session.ts";

export const IRC_SUBCOMMANDS = ["status", "read", "send", "help"] as const;

export const IRC_COMMAND_HELP = [
	"/irc — project IRC at a glance",
	"usage:",
	"  /irc              status: nick, channels, unread counts",
	"  /irc read [conv] [n]   last messages (conv = #channel or nick; n = limit)",
	"  /irc send <target> <text>   post to a channel or DM a nick",
	"  /irc help         this help",
].join("\n");

export interface ParsedIrcCommand {
	op: "status" | "read" | "send" | "help";
	target?: string;
	conversation?: string;
	text?: string;
	limit?: number;
	/** Human-readable usage problem; the command still reports, never throws. */
	error?: string;
}

/**
 * Parse the raw argument string pi hands a slash command.
 *   ""             → status
 *   "status"       → status
 *   "read"         → read (all unread, like the tool)
 *   "read #chan 5" → read, conversation #chan, limit 5
 *   "read 7"       → read, limit 7 (no conversation filter)
 *   "send #c hi"   → send, target #c, text "hi there too"
 */
export function parseIrcCommand(args: string): ParsedIrcCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	if (parts.length === 0) return { op: "status" };
	const [sub, ...rest] = parts;

	switch (sub) {
		case "status":
			return { op: "status" };
		case "help":
			return { op: "help" };
		case "read": {
			const out: ParsedIrcCommand = { op: "read" };
			const numbers = rest.filter((t) => /^\d+$/.test(t));
			const convs = rest.filter((t) => !/^\d+$/.test(t));

			if (convs.length > 1) {
				return { op: "read", error: "usage: /irc read [#channel|nick] [limit]" };
			}

			if (convs[0] !== undefined) out.conversation = convs[0];

			for (const n of numbers) {
				const limit = Number(n);

				if (limit < 1 || limit > 500) {
					return { op: "read", error: `limit must be 1..500, got ${n}` };
				}

				out.limit = limit;
			}

			return out;
		}

		case "send": {
			if (rest.length < 2) {
				return { op: "send", error: "usage: /irc send <#channel|nick> <text>" };
			}

			return { op: "send", target: rest[0], text: rest.slice(1).join(" ") };
		}

		default:
			return { op: "help", error: `unknown subcommand "${sub}" — try /irc help` };
	}
}

/** Run a parsed command against the live session; flattens to one message. */
export async function runIrcCommand(
	ensureSession: () => Promise<IrcSession>,
	args: string,
): Promise<{ message: string; level: "info" | "warning" }> {
	const parsed = parseIrcCommand(args);

	if (parsed.error) return { message: `pi-irc: ${parsed.error}`, level: "warning" };

	if (parsed.op === "help") return { message: IRC_COMMAND_HELP, level: "info" };

	const r = await executeIrcOp(ensureSession, parsed.op, {
		op: parsed.op,
		target: parsed.target,
		text: parsed.text,
		conversation: parsed.conversation,
		limit: parsed.limit,
	});

	return { message: r.content.map((c) => c.text).join("\n"), level: "info" };
}
