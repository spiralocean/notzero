#!/usr/bin/env node
// check-assumeutxo.cjs — is the assumeutxo snapshot we host still valid, and is a better one available?
//
// Two questions, and the first one matters far more than the second:
//
//  1. IS OUR HOSTED HEIGHT STILL BAKED INTO THE CORE WE PIN?  loadtxoutset only accepts a snapshot whose base
//     block matches an entry in that release's m_assumeutxo_data. If a Core bump drops the height we host (or
//     our blockhash stops matching), first-run setup breaks for NEW USERS ONLY — existing installs have a
//     chainstate already and never call loadtxoutset again, so nothing in normal use would surface it. That is
//     the easiest possible regression to ship blind, which is why this is checked rather than remembered.
//
//  2. IS A HIGHER HEIGHT AVAILABLE THAN THE ONE WE HOST?  Every block between the snapshot height and the tip
//     is one a first-time user must download and validate before they can mine. Measured on an M1 at ~52
//     blocks/min, hosting 880000 against a ~959k tip costs a new user ~25 hours and ~134 GB; a height 55k
//     closer would cut that roughly threefold. Core adds heights over time, so a hosted snapshot silently
//     decays — it never breaks, it just gets slower, which is exactly the kind of drift nobody notices.
//
// Reads the pinned CORE_VERSION + ASSUMEUTXO from desktop/node-provision.js and compares against the mainnet
// m_assumeutxo_data in THAT tag's chainparams.cpp (not the latest Core — a height is only usable if the
// release we actually ship knows about it).
//
// Run: node scripts/check-assumeutxo.cjs   ·   npm run check:assumeutxo
// Exit: 0 = checked (see `valid`), 1 = could not determine (fetch/parse failure).
// Writes valid/higher/hosted/best/coreVersion to $GITHUB_OUTPUT when run in Actions.
"use strict";
const https = require("https");
const fs = require("fs");
const { CORE_VERSION, ASSUMEUTXO } = require("../desktop/node-provision.js");

const url = `https://raw.githubusercontent.com/bitcoin/bitcoin/v${CORE_VERSION}/src/kernel/chainparams.cpp`;

function get(u, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https.get(u, { headers: { "user-agent": "notzero-assumeutxo-check" } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(get(new URL(r.headers.location, u).toString(), redirects + 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} for ${u}`)); }
      const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
    }).on("error", reject);
  });
}

// Pull the MAINNET assumeutxo table out of chainparams.cpp. Scoped to CMainParams deliberately — the file also
// defines testnet/signet/regtest tables, and matching one of those would be worse than not checking at all.
function parseMainnetAssumeutxo(src) {
  const mainIdx = src.indexOf("class CMainParams");
  if (mainIdx < 0) throw new Error("couldn't find class CMainParams (chainparams.cpp layout changed?)");
  const auIdx = src.indexOf("m_assumeutxo_data", mainIdx);
  if (auIdx < 0) throw new Error("couldn't find mainnet m_assumeutxo_data");
  const end = src.indexOf("};", auIdx); // entries end in "}," — only the initializer list itself ends in "};"
  if (end < 0) throw new Error("couldn't find the end of m_assumeutxo_data");
  const block = src.slice(auIdx, end);
  const out = [];
  // heights use C++ digit separators (840'000) and each entry lists .height before its .blockhash
  const re = /\.height\s*=\s*([\d']+)[\s\S]*?\.blockhash\s*=\s*uint256\{"([0-9a-fA-F]{64})"\}/g;
  let m;
  while ((m = re.exec(block))) out.push({ height: Number(m[1].replace(/'/g, "")), blockhash: m[2].toLowerCase() });
  if (!out.length) throw new Error("parsed zero assumeutxo entries — the format likely changed");
  return out.sort((a, b) => a.height - b.height);
}

(async () => {
  const entries = parseMainnetAssumeutxo(await get(url));
  const hosted = { height: ASSUMEUTXO.height, blockhash: (ASSUMEUTXO.blockhash || "").toLowerCase() };
  const match = entries.find((e) => e.height === hosted.height);
  // valid means loadtxoutset will accept our file: the height is present AND commits to the same block
  const valid = !!match && match.blockhash === hosted.blockhash;
  const reason = !match ? `height ${hosted.height} is not in Core ${CORE_VERSION}'s mainnet m_assumeutxo_data`
    : !valid ? `height ${hosted.height} is present but commits to ${match.blockhash}, we pin ${hosted.blockhash}`
    : "";
  const best = entries[entries.length - 1];
  const higher = best.height > hosted.height ? best : null;

  console.log(JSON.stringify({
    coreVersion: CORE_VERSION, hosted, valid, reason,
    available: entries.map((e) => e.height),
    higher: higher && { height: higher.height, blockhash: higher.blockhash, blocksCloser: higher.height - hosted.height },
  }, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
      `valid=${valid}`, `reason=${reason}`, `coreVersion=${CORE_VERSION}`,
      `hosted=${hosted.height}`, `best=${higher ? higher.height : hosted.height}`,
      `bestHash=${higher ? higher.blockhash : ""}`, `higher=${!!higher}`,
      `blocksCloser=${higher ? higher.height - hosted.height : 0}`,
    ].join("\n") + "\n");
  }

  console.log(valid ? `\n✓ hosted snapshot ${hosted.height} is valid for Core ${CORE_VERSION}` : `\n✗ HOSTED SNAPSHOT INVALID — ${reason}`);
  if (higher) console.log(`→ a higher height is baked in: ${higher.height} (${higher.height - hosted.height} blocks closer to the tip)`);
})().catch((e) => { console.error(`\n✗ Could not check the assumeutxo pin: ${e.message}`); process.exit(1); });
