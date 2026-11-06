/**
 * IRC numeric replies (RFC 2812 §5 + the 1459 leftovers we tolerate), plus the
 * handful of modern non-RFC codes every real server sends (005 ISUPPORT, 354
 * WHOX). The client consults this table to decide behavior; unknown codes are
 * logged, never fatal.
 */

export const NUMERICS = {
	RPL_WELCOME: 1,
	RPL_YOURHOST: 2,
	RPL_CREATED: 3,
	RPL_MYINFO: 4,
	RPL_ISUPPORT: 5, // modern ISUPPORT; RFC 2812 called 005 RPL_BOUNCE
	RPL_MOTDSTART: 375,
	RPL_MOTD: 372,
	RPL_ENDOFMOTD: 376,
	RPL_NOTOPIC: 331,
	RPL_TOPIC: 332,
	RPL_NAMREPLY: 353,
	RPL_ENDOFNAMES: 366,
	RPL_WHOREPLY: 352,
	RPL_ENDOFWHO: 315,
	RPL_WHOSPCRPL: 354, // WHOX extension; not in RFC 2812
	ERR_NOSUCHNICK: 401,
	ERR_NOSUCHCHANNEL: 403,
	ERR_CANNOTSENDTOCHAN: 404,
	ERR_TOOMANYCHANNELS: 405,
	ERR_UNKNOWNCOMMAND: 421,
	ERR_NOMOTD: 422,
	ERR_NONICKNAMEGIVEN: 431,
	ERR_ERRONEUSNICKNAME: 432,
	ERR_NICKNAMEINUSE: 433,
	ERR_INVALIDCAPCMD: 410,
	ERR_NICKCOLLISION: 436,
	ERR_UNAVAILRESOURCE: 437,
	ERR_USERNOTINCHANNEL: 441,
	ERR_NOTONCHANNEL: 442,
	ERR_USERONCHANNEL: 443,
	ERR_NOTREGISTERED: 451,
	ERR_NEEDMOREPARAMS: 461,
	ERR_ALREADYREGISTERED: 462,
	ERR_PASSWDMISMATCH: 464,
	ERR_CHANNELISFULL: 471,
	ERR_UNKNOWNMODE: 472,
	ERR_INVITEONLYCHAN: 473,
	ERR_BANNEDFROMCHAN: 474,
	ERR_BADCHANNELKEY: 475,
	ERR_BADCHANMASK: 476,
	ERR_CHANOPRIVSNEEDED: 482,
} as const;

export type NumericName = keyof typeof NUMERICS;

const NAMES: Map<number, string> = new Map(
	Object.entries(NUMERICS).map(([name, code]) => [code as number, name]),
);

/** Canonical name for a numeric code, or `NNN` when not in the table. */
export function numericName(code: number): string {
	return NAMES.get(code) ?? String(code);
}

/** Every IRC error numeric lives in 400–599. */
export function isErrorNumeric(code: number): boolean {
	return code >= 400 && code < 600;
}

/** The numeric family that rejects a JOIN (channel full/invite-only/banned/keyed/mask/op). */
export const JOIN_FAILURE_CODES: readonly number[] = [
	NUMERICS.ERR_CHANNELISFULL,
	NUMERICS.ERR_INVITEONLYCHAN,
	NUMERICS.ERR_BANNEDFROMCHAN,
	NUMERICS.ERR_BADCHANNELKEY,
	NUMERICS.ERR_BADCHANMASK,
	NUMERICS.ERR_CHANOPRIVSNEEDED,
];

export function isJoinFailure(code: number): boolean {
	return JOIN_FAILURE_CODES.includes(code);
}
