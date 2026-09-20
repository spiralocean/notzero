// Tests for sums-signature.js — run: node --test desktop/sums-signature.test.js  (no Electron, no network)
//
// The properties that matter: only the exact bytes that were signed verify, only under a pinned key, and nothing
// malformed can throw its way past the check. And a checksum is found by file NAME, so an old signed list
// cannot vouch for old bytes served under a new version's name.

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { verifySums, listedHash, RELEASE_KEYS } = require("./sums-signature.js");

const keypair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"), privateKey };
};
const sign = (data, privateKey) => crypto.sign(null, Buffer.from(data), privateKey).toString("base64");

const H = "a".repeat(64), H2 = "b".repeat(64);
const SUMS = `${H}  notzero-win.exe\n${H}  notzero-0.1.95-win.exe\n${H2}  notzero-0.1.95-mac-universal.zip\n`;

test("a list signed by a pinned key verifies — as a string or as bytes, with or without a trailing newline on the signature", () => {
  const k = keypair(), sig = sign(SUMS, k.privateKey);
  assert.equal(verifySums(SUMS, sig, [k.pub]), true);
  assert.equal(verifySums(Buffer.from(SUMS), sig + "\n", [k.pub]), true);
});

test("one changed byte does not verify", () => {
  const k = keypair(), sig = sign(SUMS, k.privateKey);
  assert.equal(verifySums(SUMS.replace("a", "c"), sig, [k.pub]), false);
  assert.equal(verifySums(SUMS + "\n", sig, [k.pub]), false);
});

test("a valid signature by a key that isn't pinned does not verify", () => {
  const ours = keypair(), theirs = keypair();
  assert.equal(verifySums(SUMS, sign(SUMS, theirs.privateKey), [ours.pub]), false);
  assert.equal(verifySums(SUMS, sign(SUMS, theirs.privateKey)), false, "nor against the real pinned keys");
});

test("rotation: any one pinned key is enough", () => {
  const old = keypair(), next = keypair();
  assert.equal(verifySums(SUMS, sign(SUMS, next.privateKey), [old.pub, next.pub]), true);
});

test("garbage never throws and never verifies", () => {
  const k = keypair();
  for (const sig of [null, undefined, "", "not base64 !!!", "AAAA", sign(SUMS, k.privateKey).slice(0, 40), "<html>404</html>"])
    assert.equal(verifySums(SUMS, sig, [k.pub]), false, String(sig));
  assert.equal(verifySums(null, sign(SUMS, k.privateKey), [k.pub]), false);
  assert.equal(verifySums(SUMS, sign(SUMS, k.privateKey), ["too-short", ""]), false, "a malformed pinned key is skipped, not fatal");
});

test("every pinned release key is a well-formed ed25519 key", () => {
  assert.ok(RELEASE_KEYS.length >= 1);
  for (const k of RELEASE_KEYS) assert.equal(Buffer.from(k, "base64").length, 32, k);
});

test("a checksum is looked up by exact file name", () => {
  assert.equal(listedHash(SUMS, "notzero-0.1.95-win.exe"), H);
  assert.equal(listedHash(SUMS, "notzero-0.1.95-mac-universal.zip"), H2);
  assert.equal(listedHash(SUMS, "notzero-0.1.96-win.exe"), null, "an old list cannot vouch for a newer version's file name");
  assert.equal(listedHash(SUMS, "win.exe"), null, "no suffix matching");
  assert.equal(listedHash(`${H} *notzero-win.exe\r\n`, "notzero-win.exe"), H, "sha256sum's binary marker and CRLF are tolerated");
  assert.equal(listedHash("nothash  notzero-win.exe\n", "notzero-win.exe"), null);
});
