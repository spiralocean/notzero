"use strict";
// Is this SHA256SUMS really ours? — the ed25519 signature over a release's checksum list.
//
// The Bitcoin timestamp (ots-verify.js) proves WHEN a checksum list existed. It cannot prove WHO made it: anyone
// can timestamp anything, so someone able to write to the download server could publish their own installer,
// their own matching SHA256SUMS and a perfectly valid proof for it. On macOS Squirrel's code-signature check
// stands behind that; on Windows and Linux the builds are unsigned and nothing did. This is the missing half:
// CI signs every release's SHA256SUMS with a key that never touches the download server, the public half is
// pinned below, and the app refuses an update whose list isn't signed by it.
//
// Signature: raw ed25519 over the exact bytes of SHA256SUMS, base64, published as SHA256SUMS-<version>.sig.
// The private key is the SUMS_SIGNING_KEY repository secret (and its owner's offline backup) — nowhere else.
//
// scripts/sign-sums.cjs verifies with THIS module before a release may go live, so "CI accepted it" and "the
// app will accept it" are the same statement. Needs nothing but node:crypto.
const crypto = require("crypto");

// Raw 32-byte ed25519 public keys, base64. A LIST so a key can be rotated without stranding anyone: ship a
// release — signed by the old key — that pins the new one as well, move CI over, and drop the old key later.
const RELEASE_KEYS = [
  "mwyhoWlOTyGkVRuW4Ei14fCA102yxYXfd1NE07LxJ6I=", // 2026-09, first key
];

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex"); // the DER header that makes a raw key an SPKI one
function publicKey(rawB64) {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error("not a 32-byte ed25519 key");
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
}

// true only if `sigB64` is a valid signature of `sums` by one of `keys`. Never throws.
function verifySums(sums, sigB64, keys = RELEASE_KEYS) {
  try {
    if (sums == null || !sigB64) return false;
    const sig = Buffer.from(String(sigB64).trim(), "base64");
    if (sig.length !== 64) return false;
    const data = Buffer.isBuffer(sums) ? sums : Buffer.from(String(sums), "utf8");
    return keys.some((k) => { try { return crypto.verify(null, data, publicKey(k), sig); } catch (_) { return false; } });
  } catch (_) { return false; }
}

// The hash SHA256SUMS lists for `name`, or null. Looked up by NAME on purpose: update files carry their version
// in the name, so an old — validly signed — list can't vouch for old bytes served under a new version's name.
// That is what stops a downgrade to a release with a known hole. (A leading "*" is sha256sum's binary marker.)
function listedHash(sums, name) {
  for (const raw of String(sums).split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, "") === name && /^[0-9a-f]{64}$/i.test(parts[0])) return parts[0].toLowerCase();
  }
  return null;
}

module.exports = { verifySums, listedHash, RELEASE_KEYS };
