/**
 * Identity: turning "who is this session" into wire-ready IRC identity —
 * a legal nickname rendered from the admin's template, a numeric fallback
 * pool for 433 collisions, and the structured realname (GECOS) that other
 * pi-irc agents read back via WHO. Pure functions; no sockets here.
 *
 * Realname format (roster.ts parses the same shape):
 *   "pi-agent project=<slug> role=<main|sub> session=<shortid>[ parent=<id>]"
 */
import type { AgentRole } from "./roster.ts";

export interface IdentityContext {
	/** Project slug (from config `project.slug`). */
	project: string;
	role: AgentRole;
	/** This session's short id. */
	shortId: string;
	/** Parent session short id, only for sub-agents. */
	parentId?: string;
}

/** Characters RFC 2812 allows inside a nickname (letter/digit/special). */
const NICK_LEGAL = /[A-Za-z0-9\-\[\]\\`^{}|_]/g;

export function sanitizeNickPart(raw: string): string {
	const kept = (raw.match(NICK_LEGAL) ?? []).join("");
	return kept.toLowerCase();
}

/**
 * Render a nickname from a template with {project}, {role}, {shortId},
 * {parent} placeholders. Guaranteed legal (letter first, ≤ maxLen) and
 * never empty — "pi" is the floor.
 */
export function renderNick(template: string, ctx: IdentityContext, maxLen = 30): string {
	let out = template
		.replaceAll("{project}", sanitizeNickPart(ctx.project))
		.replaceAll("{role}", ctx.role)
		.replaceAll("{shortId}", sanitizeNickPart(ctx.shortId))
		.replaceAll("{parent}", sanitizeNickPart(ctx.parentId ?? ""));
	out = out.replace(/\{[^}]*\}/g, ""); // drop unknown placeholders
	out = out.replace(/[^A-Za-z0-9\-\[\]\\`^{}|_]/g, "");
	out = out.replace(/^[^A-Za-z]+/, ""); // nick must start with a letter
	if (out.length > maxLen) out = out.slice(0, maxLen).replace(/[^A-Za-z0-9\-\[\]\\`^{}|_]+$/, "");
	if (out.length === 0) out = "pi";
	return out;
}

export function nickFallbacks(maxLen = 30, count = 8): string[] {
	return Array.from({ length: count }, (_, i) => {
		const suffix = `-${i + 1}`;
		// The client appends the suffix to the base nick; clamp so the
		// result can never exceed maxLen.
		return suffix.slice(0, Math.max(1, maxLen - 1));
	});
}

/** Encode the structured realname other pi-irc agents discover us by. */
export function encodeRealname(ctx: IdentityContext): string {
	const parts = [
		"pi-agent",
		`project=${ctx.project}`,
		`role=${ctx.role}`,
		`session=${ctx.shortId}`,
	];
	if (ctx.parentId) parts.push(`parent=${ctx.parentId}`);
	return parts.join(" ");
}

export interface RegisterIdentity {
	nick: string;
	username: string;
	realname: string;
	/** Numeric -1..-N suffix pool handed to the IRC client. */
	nickFallbacks: string[];
}

export interface IdentityConfig {
	template: string;
	maxLen: number;
}

/** Compose the full registration identity from merged config + session context. */
export function buildRegisterIdentity(
	cfg: Pick<IdentityConfig, "template" | "maxLen">,
	ctx: IdentityContext,
): RegisterIdentity {
	return {
		nick: renderNick(cfg.template, ctx, cfg.maxLen),
		username: "pi",
		realname: encodeRealname(ctx),
		nickFallbacks: nickFallbacks(cfg.maxLen),
	};
}
