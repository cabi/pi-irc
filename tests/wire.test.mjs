// wire protocol: parsing real-world server lines, formatting, size guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { parseLine, formatLine, wire, maxPrivmsgBytes, WireError } = await loadViaPi(
	repoFile("lib", "wire.ts"),
);

test("parses a full privmsg with nick!user@host prefix", () => {
	const m = parseLine(":carsten!~c@localhost PRIVMSG #pi-demo :hello agents :)");
	assert.deepEqual(m, {
		prefix: "carsten!~c@localhost",
		sourceNick: "carsten",
		command: "PRIVMSG",
		params: ["#pi-demo", "hello agents :)"],
	});
});

test("parses numeric replies from a server prefix", () => {
	const m = parseLine(":irc.example.net 001 pi-demo-m01 :Welcome to the Net");
	assert.equal(m.sourceNick, undefined);
	assert.equal(m.command, "001");
	assert.equal(m.params[0], "pi-demo-m01");
	assert.equal(m.params[1], "Welcome to the Net");
});

test("parses prefix-less commands and preserves empty params", () => {
	const m = parseLine("MODE #pi-demo +t");
	assert.deepEqual(m, { prefix: undefined, sourceNick: undefined, command: "MODE", params: ["#pi-demo", "+t"] });
});

test("trailing keeps colons and spaces verbatim", () => {
	const m = parseLine(":s 332 me #chan :topic: with : colons  and  spaces ");
	assert.equal(m.params[2], "topic: with : colons  and  spaces ");
});

test("lowercase commands are uppercased; numerics stay strings", () => {
	assert.equal(parseLine("privmsg x :y").command, "PRIVMSG");
	assert.equal(parseLine(":s 005 me PING=1 :are supported").command, "005");
});

test("ircv3 tags: parsed, unescaped, and carried on the message", () => {
	const m = parseLine("@time=2024-01-01T00:00:00Z :nick!u@h PRIVMSG #c :hi");
	assert.equal(m.command, "PRIVMSG");
	assert.equal(m.params[1], "hi");
	assert.equal(m.tags?.time, "2024-01-01T00:00:00Z");
	// IRCv3 tag value escaping: \: = ";", \s = space, unknown drops the backslash.
	const e = parseLine("@msg=a\\:b\\sc\\\\d\\xe :n PRIVMSG #c :t");
	assert.equal(e.tags?.msg, 'a;b c\\dxe');
	// Bare tag (no =) reads as empty string.
	const b = parseLine("@draft :n PRIVMSG #c :t");
	assert.equal(b.tags?.draft, "");
});

test("junk lines throw WireError, not TypeError", () => {
	assert.throws(() => parseLine(":onlyprefix"), WireError);
	assert.throws(() => parseLine("@tagsonly"), WireError);
	assert.throws(() => parseLine("   "), WireError);
});

test("formatLine routes trailing through ' :' and guards 512 bytes", () => {
	assert.equal(formatLine({ command: "privmsg", params: ["#chan"], trailing: "a b" }), "PRIVMSG #chan :a b");
	assert.equal(formatLine({ command: "QUIT" }), "QUIT");
	const long = "x".repeat(600);
	assert.throws(() => formatLine({ command: "PRIVMSG", params: ["#chan"], trailing: long }), WireError);
});

test("wire builders emit exact protocol lines", () => {
	assert.equal(wire.nick("pi-demo-m01"), "NICK pi-demo-m01");
	assert.equal(wire.user("pi", "pi-agent project=demo role=main"), "USER pi 0 * :pi-agent project=demo role=main");
	assert.equal(wire.join(["#a", "#b"]), "JOIN #a,#b");
	assert.equal(wire.part("#a", "bye"), "PART #a :bye");
	assert.equal(wire.privmsg("#a", "hi"), "PRIVMSG #a :hi");
	assert.equal(wire.pong("tok123"), "PONG tok123");
	assert.equal(wire.quit("done"), "QUIT :done");
});

test("maxPrivmsgBytes budget is positive and consistent", () => {
	const budget = maxPrivmsgBytes("#pi-demo", "pi-demo-m01a");
	assert.equal(budget > 400 && budget <= 475, true);
	const fits = formatLine({ command: "PRIVMSG", params: ["#pi-demo"], trailing: "x".repeat(budget) });
	assert.equal(fits.length <= 510, true);
});
