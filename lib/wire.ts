/**
 * IRC wire protocol: parse one protocol line into a message object and
 * format command objects back into a line (no CRLF — the socket layer
 * appends framing).
 *
 * Grammar (RFC 2812 §2.3.1), simplified to what a client needs:
 *   ['@' tags SPACE] [':' prefix SPACE] command [params] [' :' trailing]
 * We do not negotiate IRCv3 caps, but tolerate and skip a tags prefix so
 * a misconfigured server cannot corrupt every frame.
 */

export interface IrcMessage {
	/** Raw prefix after the colon, e.g. "nick!user@host" or "server.name". */
	prefix?: string;
	/** Nick part of a nick!user@host prefix, if separable. */
	sourceNick?: string;
	command: string;
	/** Uppercased command or numeric as string ("001", "PRIVMSG"). */
	params: string[];
	/** IRCv3 message tags, parsed and unescaped ("@time=...;account=x"). */
	tags?: Record<string, string>;
}

const MAX_LINE = 512;

export class WireError extends Error {}

/** Parse and unescape an IRCv3 tags block ("time=..;msg-things=a\\sb"). */
export function parseTags(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of raw.split(";")) {
		if (entry === "") continue;
		const eq = entry.indexOf("=");
		const key = eq === -1 ? entry : entry.slice(0, eq);
		if (eq === -1) {
			out[key] = "";
			continue;
		}
		out[key] = entry
			.slice(eq + 1)
			.replace(/\\(.)/g, (_, ch: string) => {
				// IRCv3 tag escaping: \: = ";", \s = space, \\, \r, \n literal.
				if (ch === ":") return ";";
				if (ch === "s") return " ";
				if (ch === "r") return "\r";
				if (ch === "n") return "\n";
				return ch; // unknown escape: drop the backslash
			});
	}
	return out;
}
export function parseLine(line: string): IrcMessage {
	let rest = line;
	if (rest.length > MAX_LINE) rest = rest.slice(0, MAX_LINE);

	let tags: Record<string, string> | undefined;
	if (rest.startsWith("@")) {
		const sp = rest.indexOf(" ");
		if (sp === -1) throw new WireError("line is only a tags block");
		tags = parseTags(rest.slice(1, sp));
		rest = rest.slice(sp + 1);
	}
	let prefix: string | undefined;
	if (rest.startsWith(":")) {
		const sp = rest.indexOf(" ");
		if (sp === -1) throw new WireError("line is only a prefix");
		prefix = rest.slice(1, sp);
		rest = rest.slice(sp + 1);
	}

	const params: string[] = [];
	let trailing: string | undefined;
	let command: string | undefined;
	while (rest.length > 0) {
		if (rest.startsWith(":")) {
			trailing = rest.slice(1);
			break;
		}
		const sp = rest.indexOf(" ");
		const token = sp === -1 ? rest : rest.slice(0, sp);
		if (command === undefined) command = token;
		else params.push(token);
		rest = sp === -1 ? "" : rest.slice(sp + 1);
	}
	if (command === undefined || command.length === 0) {
		throw new WireError("no command in line");
	}

	const sourceNick = prefix?.includes("!") ? prefix.slice(0, prefix.indexOf("!")) : undefined;
	return {
		...(tags ? { tags } : {}),
		prefix,
		sourceNick,
		command: /^\d{3}$/.test(command) ? command : command.toUpperCase(),
		params: trailing !== undefined ? [...params, trailing] : params,
	};
}

export interface OutgoingMessage {
	command: string;
	params?: string[];
	/** Last parameter sent after " :" regardless of spaces. */
	trailing?: string;
}

/** Format a command object into a protocol line (no CRLF). */
export function formatLine({ command, params = [], trailing }: OutgoingMessage): string {
	const parts = [command.toUpperCase(), ...params.map(String)];
	let line = parts.join(" ");
	if (trailing !== undefined) line += ` :${trailing}`;
	if (line.length > MAX_LINE - 2) {
		throw new WireError(
			`formatted line exceeds ${MAX_LINE} bytes (${line.length}); the caller must chunk (PRIVMSG) or shorten`,
		);
	}
	return line;
}

// ---- convenience builders for the commands the client actually sends ----

export const wire = {
	nick: (nickname: string) => formatLine({ command: "NICK", params: [nickname] }),
	user: (username: string, realname: string) =>
		formatLine({ command: "USER", params: [username, "0", "*"], trailing: realname }),
	join: (channels: string[]) => formatLine({ command: "JOIN", params: [channels.join(",")] }),
	part: (channel: string, reason?: string) =>
		reason === undefined
			? formatLine({ command: "PART", params: [channel] })
			: formatLine({ command: "PART", params: [channel], trailing: reason }),
	pass: (password: string) => formatLine({ command: "PASS", params: [password] }),
	privmsg: (target: string, text: string) =>
		formatLine({ command: "PRIVMSG", params: [target], trailing: text }),
	notice: (target: string, text: string) =>
		formatLine({ command: "NOTICE", params: [target], trailing: text }),
	ping: (token: string) => formatLine({ command: "PING", params: [token] }),
	pong: (token: string) => formatLine({ command: "PONG", params: [token] }),
	quit: (reason: string) => formatLine({ command: "QUIT", trailing: reason }),
	who: (mask: string) => formatLine({ command: "WHO", params: [mask] }),
	topic: (channel: string, topic?: string) =>
		topic === undefined
			? formatLine({ command: "TOPIC", params: [channel] })
			: formatLine({ command: "TOPIC", params: [channel], trailing: topic }),
};

/** Max bytes of PRIVMSG text guaranteed to fit: 512 - overhead, conservative. */
export function maxPrivmsgBytes(target: string, prefixNick: string): number {
	const overhead = `:${prefixNick}!~u@h PRIVMSG ${target} :\r\n`.length;
	return 512 - overhead;
}
