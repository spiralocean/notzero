#!/usr/bin/env node
// Verify that the Bitcoin Core hashes pinned in desktop/node-provision.js (CORE_ARTIFACTS) match Bitcoin
// Core's official, PGP-signed SHA256SUMS — signed by the project's guix builder keys.
//
// Why: the managed node runs whatever binary matches a pinned SHA-256. Those pins are only as trustworthy as
// the moment they were copied into the source. This closes that gap: it fetches SHA256SUMS + its detached
// signature, verifies the signature against the canonical builder keys (from bitcoin-core/guix.sigs), and
// asserts every pinned hash matches. A typo, or a copy grabbed over a MITM'd connection, fails the build.
//
// Run: node scripts/verify-core-pins.js   (needs `gpg` + `git`; wired into release.yml). Fail-closed: any
// download error, bad signature, too-few signers, or hash mismatch exits non-zero.
"use strict";
const https = require("https");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CORE_VERSION, CORE_ARTIFACTS } = require("../desktop/node-provision.js");

const BASE = `https://bitcoincore.org/bin/bitcoin-core-${CORE_VERSION}`;
const MIN_SIGNERS = 3; // require at least this many independent builder signatures on SHA256SUMS

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https.get(url, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(get(new URL(r.headers.location, url).toString(), redirects + 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} for ${url}`)); }
      const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}
function sh(cmd, args, env) {
  const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}
function die(msg, extra) { console.error(`\n✗ ${msg}${extra ? "\n" + extra : ""}`); process.exit(1); }

(async () => {
  for (const bin of ["gpg", "git"]) if (sh(bin, ["--version"]).code !== 0) die(`\`${bin}\` is required but not installed.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-verify-"));
  const gnupg = path.join(dir, "gnupg"); fs.mkdirSync(gnupg, { mode: 0o700 });
  const env = { GNUPGHOME: gnupg };
  try {
    console.log(`→ Fetching SHA256SUMS + signature for Bitcoin Core ${CORE_VERSION}…`);
    const sums = (await get(`${BASE}/SHA256SUMS`)).toString("utf8");
    const asc = await get(`${BASE}/SHA256SUMS.asc`);
    const sumsPath = path.join(dir, "SHA256SUMS"), ascPath = path.join(dir, "SHA256SUMS.asc");
    fs.writeFileSync(sumsPath, sums); fs.writeFileSync(ascPath, asc);

    console.log("→ Importing Bitcoin Core builder keys (bitcoin-core/guix.sigs)…");
    const gx = path.join(dir, "guix.sigs");
    if (sh("git", ["clone", "--depth", "1", "--quiet", "https://github.com/bitcoin-core/guix.sigs", gx]).code !== 0) die("could not clone bitcoin-core/guix.sigs (network?).");
    const imp = sh("sh", ["-c", `gpg --batch --import "${gx}/builder-keys"/* 2>&1`], env);
    if (imp.code !== 0) die("failed to import builder keys.", imp.out);

    console.log("→ Verifying the SHA256SUMS signature…");
    const v = sh("gpg", ["--batch", "--status-fd", "1", "--verify", ascPath, sumsPath], env);
    const validFprs = [...new Set((v.stdout.match(/^\[GNUPG:\] VALIDSIG ([0-9A-F]+)/gm) || []).map((l) => l.split(" ")[2]))];
    if (validFprs.length < MIN_SIGNERS) die(`SHA256SUMS carried only ${validFprs.length} valid builder signature(s); need ≥ ${MIN_SIGNERS}.`, v.out);
    console.log(`✓ SHA256SUMS verified — signed by ${validFprs.length} Bitcoin Core builder keys.`);

    const official = {};
    for (const line of sums.split("\n")) { const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/); if (m) official[m[2]] = m[1].toLowerCase(); }

    let fail = 0;
    for (const [key, a] of Object.entries(CORE_ARTIFACTS)) {
      const off = official[a.file];
      if (!off) { console.error(`✗ ${key}: ${a.file} is not listed in the signed SHA256SUMS`); fail++; }
      else if (off !== String(a.sha256).toLowerCase()) { console.error(`✗ ${key}: pinned ${a.sha256}\n            official ${off}`); fail++; }
      else console.log(`✓ ${key.padEnd(12)} ${a.file}`);
    }
    if (fail) die(`${fail} pinned Bitcoin Core hash(es) do NOT match the signed SHA256SUMS.`);
    console.log(`\n✓ All ${Object.keys(CORE_ARTIFACTS).length} pinned Bitcoin Core ${CORE_VERSION} hashes match the PGP-signed SHA256SUMS.`);
    console.log("  (The assumeutxo snapshot isn't in SHA256SUMS — Bitcoin Core verifies it against its own baked-in assumeutxo commitment at load time.)");
  } finally {
    try { sh("gpgconf", ["--kill", "all"], env); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => die(e.message));
