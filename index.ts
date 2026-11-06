/**
 * pi-irc extension entry (see PRODUCT.md).
 *
 * Owns the lifecycle wiring only: config load (disabled when absent),
 * identity derivation, background session bootstrap on session_start,
 * the single `irc` tool, DM-wake → steer, and a clean session_shutdown.
 * All IRC mechanics live in lib/.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./lib/config.ts";
import type { IdentityContext } from "./lib/identity.ts";
import { IrcSession } from "./lib/session.ts";
import { IRC_SUBCOMMANDS, runIrcCommand } from "./lib/commands.ts";
import { executeIrcOp, IRC_OPS, type IrcToolParams } from "./lib/tool.ts";
/** Where the admin keeps the global config (PRODUCT.md "Configuration"). */
function globalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-irc.json");
}

/**
 * Role + parent for the nick/realname. pi runs sub-agents in their own
 * sessions; PI_IRC_ROLE marks them so the roster can show the hierarchy.
 * Defaults to the session that owns the project channel.
 */
function identityFrom(cwd: string, sessionId: string): IdentityContext {
	const role = process.env.PI_IRC_ROLE === "sub" ? "sub" : "main";
	return {
		project: path.basename(path.resolve(cwd)),
		role,
		shortId: sessionId.slice(0, 8),
		parentId: role === "sub" ? process.env.PI_IRC_PARENT?.slice(0, 8) : undefined,
	};
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig({
		globalPath: globalConfigPath(),
		// Project overrides live next to the codebase they configure.
		projectPath: path.join(process.cwd(), ".pi", "pi-irc.json"),
		projectDir: process.cwd(),
	});
	if (!config) {
		// Absent config = deliberately disabled; stay silent but visible.
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("pi-irc: no ~/.pi/agent/pi-irc.json — extension disabled", "info");
		});
		return;
	}

	let booting: Promise<IrcSession> | null = null;
	let session: IrcSession | null = null;
	let lastSessionId = "";
	let notify: (message: string, type?: "info" | "warning" | "error") => void = () => {};

	/** Lazily (re)bootstrap the IRC session; rejects loudly on hard failure. */
	const ensureSession = (ctx: { cwd: string; sessionManager: { getSessionId(): string } }): Promise<IrcSession> => {
		const sid = ctx.sessionManager.getSessionId();
		if (session && sid === lastSessionId) return Promise.resolve(session);
		if (booting && sid === lastSessionId) return booting;
		lastSessionId = sid;
		booting = IrcSession.connect(config, identityFrom(ctx.cwd, sid))
			.then((s) => {
				session = s;
				// DM-wake: steer this session with the buffered DM so the
				// agent answers humans without polling.
				s.on("wake", (w) => {
					pi.sendUserMessage(
						`[irc] direct message from ${w.from}: ${w.text}\n(unread: ${w.unread} total — reply via the irc tool: op=send, target=${w.from}, or op=read)`,
						{ deliverAs: "steer" },
					);
				});
				return s;
			})
			.catch((err: unknown) => {
				booting = null; // next tool call retries
				throw err;
			});
		return booting;
	};

	pi.on("session_start", (event, ctx) => {
		notify = ctx.ui.notify.bind(ctx.ui);
		const sid = ctx.sessionManager.getSessionId();
		// `reload` re-fires session_start for the same session: keep the
		// live connection instead of reconnecting.
		if (event.reason === "reload" && session && sid === lastSessionId) return;
		// Background bootstrap: never block startup on the network. A hard
		// failure surfaces on the first `irc` tool call (ensureSession).
		void ensureSession(ctx).catch((err: unknown) => {
			notify(`pi-irc: connect failed — ${(err as Error).message}`, "warning");
		});
	});

	pi.registerCommand("irc", {
		description: "IRC at a glance: /irc [status|read|send|help]",
		getArgumentCompletions: (prefix: string) => {
			const items = IRC_SUBCOMMANDS.map((s) => ({ value: s, label: s }));
			const hits = items.filter((i) => i.value.startsWith(prefix));
			return hits.length > 0 ? hits : null;
		},
		handler: async (
			args: string,
			ctx: {
				cwd: string;
				sessionManager: { getSessionId(): string };
				ui: { notify: (m: string, t?: "info" | "warning" | "error") => void };
			},
		) => {
			try {
				const r = await runIrcCommand(() => ensureSession(ctx), args);
				ctx.ui.notify(r.message, r.level);
			} catch (err) {
				ctx.ui.notify(`pi-irc: ${(err as Error).message}`, "warning");
			}
		},
	});

	pi.on("session_shutdown", () => {
		session?.stop();
		session = null;
		booting = null;
	});

	pi.registerTool(
		defineTool({
			name: "irc",
			label: "IRC",
			description:
				"Communicate over IRC with humans and other agents on this project's channel. " +
				"The connection, project channel (#" +
				config.projectSlug +
				"-derived), and roster are maintained in the background. " +
				"Pull before push: prefer op=read before sending. Direct messages to you are buffered until read; a DM steers you automatically.",
			parameters: Type.Object({
				op: StringEnum(IRC_OPS, {
					description:
					"connect: ensure the link (rarely needed). status: nick/channels/unread. roster: who is here. " +
					"send: post text (default: project channel). read: fetch unread messages. " +
					"ask: peer+text correlated question (blocks for reply). reply: id+text answers an ask. " +
					"pending: open asks both ways. join/part: extra channels. help: usage.",
				}),
				target: Type.Optional(
					Type.String({ description: "send: channel or nick; default = project channel" }),
				),
				text: Type.Optional(Type.String({ description: "send: message text" })),
				conversation: Type.Optional(
					Type.String({ description: "read: only this channel or nick" }),
				),
				from: Type.Optional(Type.String({ description: "read: only messages from this nick" })),
				since: Type.Optional(
					Type.Number({ description: "read: only messages at/after this unix timestamp" }),
				),
				limit: Type.Optional(Type.Number({ description: "read: max messages (default 200)" })),
				channels: Type.Optional(
					Type.Array(Type.String(), { description: "join/part: channel names" }),
				),
				peer: Type.Optional(Type.String({ description: "ask: peer nick to ask (question in `text`)" })),
				timeout: Type.Optional(
					Type.Number({ description: "ask: seconds to wait for the reply (default 600, max 3600)" }),
				),
				id: Type.Optional(Type.String({ description: "reply: the ask id to answer (answer in `text`)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const r = await executeIrcOp(
					() => ensureSession(ctx),
					String(params.op ?? ""),
					params as IrcToolParams,
				);
				return { content: r.content, details: r.details };
			},
		}),
	);
}
