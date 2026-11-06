// roster: realname identity protocol, peer registry, self handling, expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { Roster, formatRealname, parseRealname } = await loadViaPi(repoFile("lib", "roster.ts"));

test("realname round-trips identity", () => {
	const real = formatRealname("demo", "sub");
	assert.equal(real, "pi-agent project=demo role=sub");
	const info = parseRealname(real);
	assert.deepEqual(info, { kind: "agent", role: "sub", project: "demo" });
});

test("foreign realnames are humans", () => {
	assert.deepEqual(parseRealname("Carsten"), { kind: "human" });
	assert.deepEqual(parseRealname(""), { kind: "human" });
	assert.deepEqual(parseRealname("pi-agentish trickster"), { kind: "human" });
});

test("realname parser tolerates junk fields", () => {
	const info = parseRealname("pi-agent project=x role=bogus extra=1");
	assert.equal(info.kind, "agent");
	assert.equal(info.project, "x");
	assert.equal(info.role, undefined);
});

test("touch applies patches and keeps prior fields", () => {
	const r = new Roster();
	const p = r.applyRealname("PiDemo-M01A", formatRealname("demo", "main"));
	assert.equal(p.kind, "agent");
	assert.equal(p.role, "main");
	r.touch("PIDEMO-m01a"); // case-insensitive same peer
	assert.equal(r.get("pidemo-M01A").role, "main");
	assert.equal(r.get("pidemo-M01A").lastSeen >= p.lastSeen, true);
});

test("rename moves the entry and preserves fields", () => {
	const r = new Roster();
	r.applyRealname("old", formatRealname("demo", "sub"));
	r.rename("old", "New");
	assert.equal(r.get("old"), undefined);
	assert.equal(r.get("new").project, "demo");
});

test("self is excluded from projectAgents and leadAgent", () => {
	const r = new Roster();
	r.setSelf("me");
	r.applyRealname("me", formatRealname("demo", "main"));
	r.applyRealname("peer", formatRealname("demo", "main"));
	r.applyRealname("other", formatRealname("demo", "sub"));
	assert.deepEqual(
		r.projectAgents("demo").map((p) => p.nick),
		["peer", "other"],
	);
	assert.equal(r.leadAgent("demo").nick, "peer");
});

test("agents of other projects don't leak in", () => {
	const r = new Roster();
	r.applyRealname("x", formatRealname("elsewhere", "main"));
	assert.equal(r.projectAgents("demo").length, 0);
});

test("expire drops stale non-self peers only", () => {
	const r = new Roster();
	const t0 = 1000;
	r.touch("ghost", { lastSeen: t0 });
	r.setSelf("me");
	r.touch("me", { lastSeen: t0, self: true });
	r.applyRealname("fresh", formatRealname("demo", "sub")); // lastSeen = now
	assert.equal(r.expire(5000, t0 + 6000), 1);
	assert.equal(r.get("ghost"), undefined);
	assert.equal(r.get("me").self, true);
	assert.equal(r.get("fresh").kind, "agent");
});
