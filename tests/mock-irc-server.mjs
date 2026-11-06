// A tiny scriptable IRC server for integration tests. Speaks enough RFC
// 2812 to register a client, echo JOINs with NAMES replies, answer PING,
// and let tests push arbitrary lines. Runs on 127.0.0.1 with an ephemeral
// port; never touches the network.
import * as net from "node:net";

export class MockIrcServer extends net.Server {
	constructor() {
		super();
		this.clients = []; // {socket, nick, sent: [], lines: []}
		this.on("connection", (socket) => this.#onConnection(socket));
		/** Test hook: called with (client, line) for every client line. */
		this.onLine = null;
		/** Test hook: reject the first NICK with 433 (nick collision drill). */
		this.rejectFirstNick = false;
		this.rejectedOnce = new Set();
	}

	#onConnection(socket) {
		const client = { socket, nick: null, user: null, sent: [], lines: [] };
		this.clients.push(client);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (line.length === 0) continue;
				client.lines.push(line);
				this.#handle(client, line);
			}
		});
	}

	#send(client, line) {
		client.sent.push(line);
		client.socket.write(`${line}\r\n`);
	}

	#handle(client, line) {
		const [cmd, ...params] = line.split(" ");
		const ti = line.indexOf(" :");
		const trailing = ti === -1 ? null : line.slice(ti + 2);
		switch (cmd.toUpperCase()) {
			case "NICK": {
				const nick = params[0];
				if (this.rejectFirstNick && !this.rejectedOnce.has(client)) {
					this.rejectedOnce.add(client);
					this.#send(client, `:mock 433 * ${nick} :Nickname is already in use`);
					return;
				}
				client.nick = nick;
				if (client.user) this.#welcome(client); // registration completes
				break;
			}
			case "USER":
				client.user = trailing?.slice(1) ?? "user";
				if (client.nick) this.#welcome(client);
				break;
			case "JOIN": {
				for (const chan of params[0].split(",")) {
					this.#send(client, `:${client.nick}!pi@mock JOIN ${chan.startsWith(":") ? chan.slice(1) : chan}`);
					this.#send(client, `:mock 353 ${client.nick} = ${chan} :${client.nick} peer`);
					this.#send(client, `:mock 366 ${client.nick} ${chan} :End of /NAMES list`);
				}
				break;
			}
			case "PING":
				this.#send(client, `:mock PONG mock ${params[0] ?? ""}`.trimEnd());
				break;
			case "PRIVMSG":
				this.emit("privmsg", { client, target: params[0], text: params.slice(1).join(" ").replace(/^:/, "") });
				break;
			case "WHO": {
				const mask = params[0];
				this.#send(client, `:mock 352 ${client.nick} ${mask} pi mock ${client.nick} H :0 ${client.user ?? "user"}`);
				this.#send(client, `:mock 315 ${client.nick} ${mask} :End of /WHO list`);
				break;
			}
			default:
				break;
		}
		this.onLine?.(client, line);
	}

	#welcome(client) {
		if (client.welcomed) return;
		client.welcomed = true;
		this.#send(client, `:mock 001 ${client.nick} :Welcome to the mock server`);
		this.#send(client, `:mock 002 ${client.nick} :Your host is mock`);
		this.#send(client, `:mock 375 ${client.nick} :- MOTD -`);
		this.#send(client, `:mock 376 ${client.nick} :End of MOTD`);
	}

	/** Push a raw server line to every (or one specific) client. */
	push(line, clientIdx = 0) {
		this.#send(this.clients[clientIdx], line);
	}

	async start() {
		return new Promise((resolve) => this.listen(0, "127.0.0.1", () => resolve(this.address().port)));
	}

	async stop() {
		for (const c of this.clients) c.socket.destroy();
		return new Promise((resolve) => this.close(() => resolve()));
	}

	lastClient() {
		return this.clients.at(-1);
	}
}
