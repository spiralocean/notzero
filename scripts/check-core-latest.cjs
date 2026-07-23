#!/usr/bin/env node
// check-core-latest.cjs — is there a newer Bitcoin Core release than the one we pin?
//
// Why: desktop/node-provision.js pins ONE Core version, and users run whatever we pin — so our bump cadence
// IS their update cadence. Falling behind means shipping an EOL Core with no security fixes. Nothing in the
// app checks for this (bitcoind is headless; the app's banners are about notzero's own updates and consensus
// rule changes), so without a watcher the only signal is remembering to look.
//
// This DETECTS, it never bumps. Adopting a release means re-pinning the hashes AND re-checking ASSUMEUTXO
// against the new release's chainparams.cpp, then testing a real sync — a human call, especially for a major.
//
// Reads the pinned version from desktop/node-provision.js, scrapes the bitcoincore.org release index, and
// reports the highest FINAL release (one that publishes a top-level SHA256SUMS — release candidates live in
// test.rcN/ subdirectories and are correctly ignored).
//
// Run: node scripts/check-core-latest.cjs
// Exit: 0 = up to date (or newer found — this is a report, not a gate), 1 = could not determine.
// Writes newer/latest/pinned/kind to $GITHUB_OUTPUT when run in Actions.
"use strict";
const https = require("https");
const fs = require("fs");
const { CORE_VERSION } = require("../desktop/node-provision.js");

const INDEX = "https://bitcoincore.org/bin/";

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https.get(url, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(get(new URL(r.headers.location, url).toString(), redirects + 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} for ${url}`)); }
      const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}
// numeric, component-wise — so 31.10 > 31.9 (a plain string compare gets that backwards) and legacy 0.21.0 sorts below 22.0
function cmpVer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

(async () => {
  const index = await get(INDEX);
  const found = [...index.matchAll(/bitcoin-core-(\d+(?:\.\d+)+)\//g)].map((m) => m[1]);
  const versions = [...new Set(found)].sort((a, b) => cmpVer(b, a));
  if (!versions.length) throw new Error(`no bitcoin-core-<version>/ entries found at ${INDEX} (did the index format change?)`);

  // walk down from the highest until one has a top-level SHA256SUMS — that's a final release, not an rc staging dir
  let latest = null;
  for (const v of versions.slice(0, 4)) {
    try { await get(`${INDEX}bitcoin-core-${v}/SHA256SUMS`); latest = v; break; } catch (_) { /* not a final release; keep looking */ }
  }
  if (!latest) throw new Error(`none of the newest entries (${versions.slice(0, 4).join(", ")}) publish a SHA256SUMS`);

  const newer = cmpVer(latest, CORE_VERSION) > 0;
  // a new MAJOR can change RPC shapes that scripts/node_bridge.py parses and can move the assumeutxo height —
  // wait for its .1. a maintenance release is a drop-in fix and should ship promptly.
  const kind = !newer ? "none" : Number(latest.split(".")[0]) > Number(CORE_VERSION.split(".")[0]) ? "major" : "maintenance";

  console.log(JSON.stringify({ pinned: CORE_VERSION, latest, newer, kind }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `newer=${newer}\nlatest=${latest}\npinned=${CORE_VERSION}\nkind=${kind}\n`);
  }
  console.log(newer ? `\n→ Bitcoin Core ${latest} is available (${kind}); we pin ${CORE_VERSION}.` : `\n✓ Pinned Bitcoin Core ${CORE_VERSION} is the latest release.`);
})().catch((e) => { console.error(`\n✗ Could not determine the latest Bitcoin Core release: ${e.message}`); process.exit(1); });
