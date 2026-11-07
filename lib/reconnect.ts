/**
 * Backoff: the reconnect delay policy. Exponential growth with optional
 * jitter, capped — pure math, no timers and no clock, so tests pin the
 * sequence exactly and the session owns all scheduling.
 *
 * Jitter exists so a fleet of agents that dropped together (server restart)
 * doesn't stampede it in lockstep; ±20% is the usual choice.
 */

export interface BackoffOptions {
	/** First delay in ms (default 1000). */
	baseMs?: number;
	/** Multiplier per failed attempt (default 2). */
	factor?: number;
	/** Ceiling in ms regardless of attempt count (default 60_000). */
	maxMs?: number;
	/** ± fraction around the computed delay, 0..1 (default 0.2). */
	jitter?: number;
	/** Injectable randomness for deterministic tests (default Math.random). */
	rand?: () => number;
}

export class Backoff {
	private readonly opts: Required<BackoffOptions>;
	private attempt = 0;

	constructor(opts: BackoffOptions = {}) {
		this.opts = {
			baseMs: opts.baseMs ?? 1000,
			factor: opts.factor ?? 2,
			maxMs: opts.maxMs ?? 60_000,
			jitter: opts.jitter ?? 0.2,
			rand: opts.rand ?? Math.random,
		};

		if (this.opts.baseMs <= 0) throw new Error("baseMs must be > 0");

		if (this.opts.factor <= 1) throw new Error("factor must be > 1");

		if (this.opts.maxMs < this.opts.baseMs) throw new Error("maxMs must be >= baseMs");

		if (this.opts.jitter < 0 || this.opts.jitter > 1) throw new Error("jitter must be within [0,1]");
	}

	/** Consume and return the next delay (jittered). */
	next(): number {
		this.attempt += 1;

		return this.#jittered(this.#raw(this.attempt));
	}

	/** The delay the next `next()` would produce, without consuming. */
	peek(): number {
		return this.#jittered(this.#raw(this.attempt + 1));
	}

	#raw(attempt: number): number {
		return Math.min(this.opts.maxMs, this.opts.baseMs * this.opts.factor ** (attempt - 1));
	}

	#jittered(delay: number): number {
		const { jitter, rand } = this.opts;

		if (jitter === 0) return delay;
		const spread = delay * jitter;

		return Math.round(delay - spread + rand() * 2 * spread);
	}

	/** A reconnect succeeded: start over from the base delay. */
	reset(): void {
		this.attempt = 0;
	}

	/** Attempts consumed since the last reset. */
	get attempts(): number {
		return this.attempt;
	}
}
