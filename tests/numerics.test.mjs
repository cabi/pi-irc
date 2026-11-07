// numerics table sanity: the codes the client branches on must resolve to
// their RFC 2812 names, errors must classify as errors, and the JOIN failure
// family must contain exactly the channel-rejection codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadViaPi, repoFile } from "./helpers.mjs";

const { NUMERICS, numericName, isErrorNumeric, isJoinFailure } = await loadViaPi(repoFile("lib", "numerics.ts"));

test("numeric table holds the RFC 2812 values the client branches on", () => {
	assert.equal(NUMERICS.RPL_WELCOME, 1);
	assert.equal(NUMERICS.RPL_NAMREPLY, 353);
	assert.equal(NUMERICS.RPL_ENDOFNAMES, 366);
	assert.equal(NUMERICS.RPL_WHOREPLY, 352);
	assert.equal(NUMERICS.RPL_ENDOFWHO, 315);
	assert.equal(NUMERICS.RPL_WHOSPCRPL, 354);
	assert.equal(NUMERICS.ERR_NICKNAMEINUSE, 433);
	assert.equal(NUMERICS.ERR_ERRONEUSNICKNAME, 432);
	assert.equal(NUMERICS.ERR_NOSUCHCHANNEL, 403);
	assert.equal(NUMERICS.ERR_INVITEONLYCHAN, 473);
	assert.equal(NUMERICS.ERR_BADCHANNELKEY, 475);
	assert.equal(NUMERICS.ERR_CHANOPRIVSNEEDED, 482);
});

test("numericName resolves known codes and passes unknown through", () => {
	assert.equal(numericName(433), "ERR_NICKNAMEINUSE");
	assert.equal(numericName(999), "999");
});

test("error numerics are 400-599", () => {
	assert.equal(isErrorNumeric(433), true);
	assert.equal(isErrorNumeric(482), true);
	assert.equal(isErrorNumeric(353), false);
	assert.equal(isErrorNumeric(1), false);
});

test("JOIN failure family covers full/invite/ban/key/mask/op", () => {
	assert.equal(isJoinFailure(471), true);
	assert.equal(isJoinFailure(473), true);
	assert.equal(isJoinFailure(474), true);
	assert.equal(isJoinFailure(475), true);
	assert.equal(isJoinFailure(476), true);
	assert.equal(isJoinFailure(482), true);
	assert.equal(isJoinFailure(403), false);
	assert.equal(isJoinFailure(433), false);
});
