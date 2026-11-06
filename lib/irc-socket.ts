/**
 * Socket transport: TCP or TLS, CRLF line framing, tolerant of lone \n.
 * Dumb pipe on purpose — registration, keepalive, and reconnect policy
 * live in IrcClient; this layer only moves bytes and lines.
 */
import * as net from "node:net";
import * as tls from "node:tls";
import { EventEmitter } from "node:events";

export interface ConnectOptions {
	host: string;
	port: number;
	tls: boolean;
	/** TLS only: reject unauthorized certificates (default true). */
	rejectUnauthorized?: boolean;
	/** TLS only: SNI server name override (defaults to `host`). */
	serverName?: string;
	/** Connection timeout in ms (default 15000). */
	timeoutMs?: number;
}

export class IrcSocket extends EventEmitter {
	private socket: net.Socket | tls.TLSSocket | null = null;
	private buffer = "";
	private closing = false;

	connect(opts: ConnectOptions): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeoutMs = opts.timeoutMs ?? 15000;
			const onConnect = () => {
				this.socket!.setTimeout(0);
				resolve();
			};
			const onError = (err: Error) => {
				this.socket?.destroy();
				this.socket = null;
				reject(err);
			};

			const common = {
				host: opts.host,
				port: opts.port,
			};
			if (opts.tls) {
				this.socket = tls.connect({
					...common,
					rejectUnauthorized: opts.rejectUnauthorized ?? true,
					...(opts.serverName ? { servername: opts.serverName } : {}),
				});
			} else {
				this.socket = net.connect(common);
			}
			this.socket.once("connect", onConnect);
			this.socket.once("secureConnect", onConnect);
			this.socket.once("error", onError);
			this.socket.setTimeout(timeoutMs, () => onError(new Error(`connect timeout after ${timeoutMs}ms`)));

			this.socket.setEncoding("utf8");
			this.socket.on("data", (chunk: string) => this.#onData(chunk));
			this.socket.on("error", (err: Error) => {
				// Post-connect errors: surface, then let close fire.
				this.emit("error", err);
			});
			this.socket.on("close", () => {
				const hadSocket = this.socket !== null;
				this.socket = null;
				if (hadSocket && !this.closing) this.emit("unexpected-close");
				this.emit("close");
			});
		});
	}

	#onData(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.search(/\r\n|\n/)) !== -1) {
			// Separator at nl is \r\n or a bare \n (tolerated: some servers/proxies).
			const sepLen = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + sepLen);
			if (line.length > 0) this.emit("line", line);
		}
		if (this.buffer.length > 4096) {
			// Runaway line without terminator: drop it, stay framed.
			this.emit("error", new Error("line exceeds 4096 bytes without terminator"));
			this.buffer = "";
		}
	}

	send(line: string): void {
		if (!this.socket || this.socket.destroyed) {
			throw new Error("send on closed socket");
		}
		this.socket.write(`${line}\r\n`);
	}

	get connected(): boolean {
		return this.socket !== null && !this.socket.destroyed;
	}

	close(): void {
		this.closing = true;
		this.socket?.end();
	}

	destroy(): void {
		this.closing = true;
		this.socket?.destroy();
	}
}
