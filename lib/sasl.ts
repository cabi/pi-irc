/**
 * SASL PLAIN (RFC 4616 payload framed per the IRCv3 sasl-3.1 spec).
 * Pure helpers — lib/irc-client.ts owns the orchestration:
 *
 *   CAP REQ :…sasl…        (added automatically when auth is configured)
 *   CAP * ACK :…sasl…
 *   AUTHENTICATE PLAIN     ← client
 *   AUTHENTICATE +         ← server invites the payload
 *   AUTHENTICATE <b64…>    ← client, chunked ≤400 chars per line
 *   :server 900 <nick> …   (informational: logged in as …)
 *   :server 903 <nick> :…  ← success → CAP END releases registration
 *   904/905/906            ← failure: registration must not complete
 *   907                    ← already authenticated: counts as success
 */

/** Max AUTHENTICATE payload per line (sasl-3.1: clients send ≤400 bytes). */
export const SASL_MAX_CHUNK = 400;

/** base64(authzid="" \0 authcid \0 password) — empty authzid is standard. */
export function saslPlainPayload(username: string, password: string): string {
	return Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
}

/**
 * Split a base64 payload into AUTHENTICATE parameters: chunks of ≤400
 * chars; when the payload is an exact multiple of 400 the spec requires a
 * final empty chunk, which is sent as a bare "+".
 */
export function authChunks(payload: string): string[] {
	if (payload.length === 0) return ["+"];
	const out: string[] = [];
	for (let i = 0; i < payload.length; i += SASL_MAX_CHUNK) {
		out.push(payload.slice(i, i + SASL_MAX_CHUNK));
	}
	if (out[out.length - 1].length === SASL_MAX_CHUNK) out.push("+");
	return out;
}
