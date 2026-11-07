// Identity: nick rendering, numeric collision pool, realname encode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const id = await loadViaPi(repoFile("lib", "identity.ts"));

const { parseRealname } = await loadViaPi(repoFile("lib", "roster.ts"));

test("renderNick substitutes and sanitizes placeholders", () => {
	const ctx = { project: "Demo App!", role: "main" /**/, shortId: "Ab12-Cd" };
	// slash, space, and bang are illegal in nicks
	assert.equal(id.renderNick("pi-{project}-{shortId}", ctx), "pi-demoapp-ab12-cd");
	assert.equal(id.renderNick("{project}-{role}", { ...ctx, role: "sub" }), "demoapp-sub");
});

test("renderNick guarantees a letter start and non-empty result", () => {
	assert.equal(id.renderNick("123 {project}", { project: "x", role: "main", shortId: "s" }), "x");
	assert.equal(id.renderNick("!!!", { project: "x", role: "main", shortId: "s" }), "pi");
});

test("renderNick clamps to maxLen without trailing garbage", () => {
	const ctx = { project: "verylongprojectname", role: "main", shortId: "0123456789" };
	const nick = id.renderNick("pi-{project}-{shortId}", ctx, 10);
	assert.ok(nick.length <= 10, `nick too long: ${nick}`);
	assert.match(nick, /^[A-Za-z][A-Za-z0-9_-]*$/);
});

test("nickFallbacks are numeric and bounded by maxLen", () => {
	assert.deepEqual(id.nickFallbacks(30, 3), ["-1", "-2", "-3"]);
	const tight = id.nickFallbacks(2, 3);
	assert.ok(tight.every((s) => s.length <= 1));
});

test("encodeRealname carries project, role, session; parent only for subs", () => {
	const main = id.encodeRealname({ project: "demo", role: "main", shortId: "ab12cd34" });
	assert.equal(main, "pi-agent project=demo role=main session=ab12cd34");
	const sub = id.encodeRealname({ project: "demo", role: "sub", shortId: "ff001122", parentId: "ab12cd34" });
	assert.equal(sub, "pi-agent project=demo role=sub session=ff001122 parent=ab12cd34");
});

test("roster parses the identity realname back, session and parent included", () => {
	const info = parseRealname("pi-agent project=demo role=sub session=ff001122 parent=ab12cd34");
	assert.equal(info.kind, "agent");
	assert.equal(info.project, "demo");
	assert.equal(info.role, "sub");
});

test("buildRegisterIdentity composes the RegisterSpec pieces", () => {
	const reg = id.buildRegisterIdentity(
		{ template: "pi-{project}-{shortId}", maxLen: 30 },
		{ project: "demo", role: "main", shortId: "ab12cd34" },
	);

	assert.equal(reg.nick, "pi-demo-ab12cd34");
	assert.equal(reg.username, "pi");
	assert.match(reg.realname, /^pi-agent project=demo role=main session=ab12cd34$/);
	assert.deepEqual(reg.nickFallbacks, ["-1", "-2", "-3", "-4", "-5", "-6", "-7", "-8"]);
});
