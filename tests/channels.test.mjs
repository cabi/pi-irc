// channels: join/part state, case folding, NAMES prefixes, QUIT/NICK propagation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { Channels, validChannelName } = await loadViaPi(repoFile("lib", "channels.ts"));

test("validChannelName accepts real channels, rejects junk", () => {
	assert.equal(validChannelName("#pi-demo"), true);
	assert.equal(validChannelName("&local"), true);
	assert.equal(validChannelName("#" + "x".repeat(49)), true);
	assert.equal(validChannelName("#" + "x".repeat(50)), false);
	assert.equal(validChannelName("nochan"), false);
	assert.equal(validChannelName("#with space"), false);
	assert.equal(validChannelName("#a,b"), false);
});

test("join is idempotent and case-insensitive", () => {
	const c = new Channels();
	c.join("#Pi-Demo");
	c.join("#pi-demo");
	assert.equal(c.list().length, 1);
	assert.equal(c.joined("#PI-DEMO"), true);
	assert.equal(c.part("#pi_DEMO".replace("_", "-")), true);
	assert.equal(c.joined("#pi-demo"), false);
});

test("NAMES entries strip membership prefixes", () => {
	const c = new Channels();
	c.names("#demo", ["@ Founder", "+voiced", "~owner&admin", "plain"]);
	assert.deepEqual([...c.get("#demo").members].sort(), ["founder", "owner&admin", "plain", "voiced"]);
});

test("quit removes a member from every channel", () => {
	const c = new Channels();
	c.addMember("#a", "peer");
	c.addMember("#b", "peer");
	c.addMember("#b", "keep");
	assert.deepEqual(c.removeMemberEverywhere("peer").sort(), ["#a", "#b"]);
	assert.equal(c.get("#b").members.has("peer"), false);
	assert.equal(c.get("#b").members.has("keep"), true);
});

test("nick rename moves membership everywhere", () => {
	const c = new Channels();
	c.addMember("#a", "old");
	c.renameMember("old", "new");
	assert.equal(c.get("#a").members.has("old"), false);
	assert.equal(c.get("#a").members.has("new"), true);
});

test("topic lands only on joined channels", () => {
	const c = new Channels();
	c.join("#demo");
	c.setTopic("#demo", "pi project channel");
	c.setTopic("#notjoined", "nope");
	assert.equal(c.get("#demo").topic, "pi project channel");
	assert.equal(c.get("#notjoined"), undefined);
});
