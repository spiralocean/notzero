#!/usr/bin/env node
// sign-sums.cjs — sign a release's SHA256SUMS, and check one the way the app will.
//
//   node scripts/sign-sums.cjs sign   SHA256SUMS SHA256SUMS.sig     key: $SUMS_SIGNING_KEY (ed25519 PKCS8 PEM)
//   node scripts/sign-sums.cjs verify SHA256SUMS SHA256SUMS.sig     against the keys PINNED IN THE APP
//   node scripts/sign-sums.cjs listed SHA256SUMS <file name>...     every name must be in the list
//
// `verify` and `listed` go through desktop/sums-signature.js — the module the app itself uses — so a release
// that passes here is one the app accepts, and one that wouldn't be never goes live (promote-release.sh).
// `sign` verifies its own output before writing it: a secret holding the wrong key fails the release job,
// loudly, instead of shipping a signature every install would refuse.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { verifySums, listedHash } = require(path.join(__dirname, "..", "desktop", "sums-signature.js"));

const die = (msg) => { console.error("x " + msg); process.exit(1); };
const [cmd, sumsPath, ...rest] = process.argv.slice(2);
if (!cmd || !sumsPath) die("usage: sign-sums.cjs sign|verify <SHA256SUMS> <sig>   |   listed <SHA256SUMS> <name>...");
const sums = fs.readFileSync(sumsPath);

if (cmd === "sign") {
  const out = rest[0] || die("sign: missing output path");
  const pem = process.env.SUMS_SIGNING_KEY || die("sign: SUMS_SIGNING_KEY is not set");
  const sig = crypto.sign(null, sums, crypto.createPrivateKey(pem)).toString("base64");
  if (!verifySums(sums, sig)) die("signed, but the signature does not verify against the key pinned in desktop/sums-signature.js — SUMS_SIGNING_KEY is not the pinned key");
  fs.writeFileSync(out, sig + "\n");
  console.log("ok: signed " + sumsPath + " → " + out);
} else if (cmd === "verify") {
  const sigPath = rest[0] || die("verify: missing signature path");
  if (!verifySums(sums, fs.readFileSync(sigPath, "utf8"))) die(sigPath + " is NOT a valid signature of " + sumsPath + " by a pinned release key");
  console.log("ok: " + sumsPath + " is signed by a pinned release key");
} else if (cmd === "listed") {
  if (!rest.length) die("listed: no names given");
  const missing = rest.filter((n) => !listedHash(sums, n));
  if (missing.length) die("not listed in " + sumsPath + ": " + missing.join(", ") + " — the app looks an update up by its file name and would refuse it");
  console.log("ok: listed — " + rest.join(", "));
} else die("unknown command: " + cmd);
