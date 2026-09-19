// Tests for update-hold.js — run: node --test desktop/update-hold.test.js  (no Electron, no clock)
//
// The properties that matter: a bad fingerprint is never installable by any route; only a genuinely pending
// proof holds an update (a node that can't answer must never stand between a user and a fix); and a hold
// always ends — by confirmation, by the user, or by the ceiling.

const test = require("node:test");
const assert = require("node:assert");
const { decideInstall, HOLD_LIMIT_MS } = require("./update-hold.js");

const V = "0.1.94", T0 = 1_800_000_000_000;
const decide = (level, extra) => decideInstall({ verdict: level ? { level, version: V } : null, verifyOn: true, now: T0, ...extra });

test("a confirmed proof installs", () => {
  assert.equal(decide("onchain"), "install");
});

test("a pending proof is held", () => {
  assert.equal(decide("pending"), "hold");
  assert.equal(decide("pending", { heldSince: T0 - 60_000 }), "hold");
});

test("couldn't-check is not pending: no node, a node that's behind, or nothing published all install as before", () => {
  for (const level of ["checksums", "unverified", "unchecked"]) assert.equal(decide(level), "install", level);
  assert.equal(decide(null), "install", "verification threw / never ran");
});

test("a mismatch is refused", () => {
  assert.equal(decide("mismatch"), "block");
});

test("'install now' releases a held update — for that version only", () => {
  assert.equal(decide("pending", { installNowVer: V }), "install");
  assert.equal(decide("pending", { installNowVer: "0.1.93" }), "hold", "a choice made about an older update says nothing about this one");
});

test("'install now' cannot install a mismatch: it skips the timestamp, never the fingerprint", () => {
  assert.equal(decide("mismatch", { installNowVer: V }), "block");
  assert.equal(decide("mismatch", { installNowVer: V, heldSince: T0 - 2 * HOLD_LIMIT_MS }), "block");
});

test("the hold has a ceiling, so a proof that never confirms can't strand an unattended install", () => {
  assert.equal(decide("pending", { heldSince: T0 - HOLD_LIMIT_MS + 1 }), "hold");
  assert.equal(decide("pending", { heldSince: T0 - HOLD_LIMIT_MS }), "install");
});

test("a clock that jumped backwards keeps holding rather than installing early", () => {
  assert.equal(decide("pending", { heldSince: T0 + 3_600_000 }), "hold");
});

test("verify_updates off: never blocks, never holds", () => {
  for (const level of ["pending", "mismatch", "onchain"])
    assert.equal(decideInstall({ verdict: { level, version: V }, verifyOn: false, now: T0 }), "install", level);
});
