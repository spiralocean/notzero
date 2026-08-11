// ---------------------------------------------------------------------------
// Node provisioning core (Phase 1) — download + VERIFY + configure a private,
// pruned Bitcoin Core for users who don't already run a node. Pure-ish logic:
// no Electron, no UI. The wizard flow (Phase 3) and bitcoind lifecycle +
// assumeutxo snapshot (Phase 2) build on top of this.
//
// SECURITY MODEL
//  - We NEVER run a binary we haven't verified. The expected SHA-256 of each
//    official Bitcoin Core artifact is PINNED below, inside this signed/notarized
//    app, so the trust root is our auditable source — not the network. A
//    mismatch throws and the download is discarded.
//  - The managed node is configured localhost-only with cookie auth (random per
//    run), pruned to bound disk, and never exposes RPC off the machine.
//  - The pins themselves are guarded at build time: scripts/verify-core-pins.cjs fetches Core's PGP-signed
//    SHA256SUMS, verifies it against the guix builder keys, and asserts every hash below matches. It's a
//    required gate in release.yml, so a mistyped or MITM'd pin can never ship.
//
// UPDATING CORE: bump CORE_VERSION + the CORE_ARTIFACTS hashes from
// https://bitcoincore.org/bin/bitcoin-core-<v>/SHA256SUMS, and ASSUMEUTXO from
// src/kernel/chainparams.cpp (m_assumeutxo_data) for that release. Then run
// `node scripts/verify-core-pins.cjs` to confirm the new hashes match Core's signed sums.
// You don't have to remember to look: .github/workflows/core-watch.yml checks weekly and opens an issue
// when a newer Core ships (or when these pins stop verifying). It only ever reports — the bump is by hand,
// because nothing in CI proves a new Core still works with scripts/node_bridge.py.
// That watcher also runs scripts/check-assumeutxo.cjs, which is the safety net for the ASSUMEUTXO block
// below: it asserts the height we host is still in the pinned release's m_assumeutxo_data (if a Core bump
// drops it, loadtxoutset refuses our file and first-run breaks for NEW USERS ONLY — invisible in normal use
// and in the smoke test), and tells you when Core bakes in a height closer to the tip.
// ---------------------------------------------------------------------------
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CORE_VERSION = "31.1";
const CORE_BASE_URL = `https://bitcoincore.org/bin/bitcoin-core-${CORE_VERSION}`;

// SHA-256 of each official artifact (from the release SHA256SUMS). Verified-or-refuse.
const CORE_ARTIFACTS = {
  "darwin-arm64": { file: `bitcoin-${CORE_VERSION}-arm64-apple-darwin.tar.gz`, sha256: "16a097c09fbd7eb78b240ce1dae123663ea2e5e377cfd6a951e71e227e23cf2f", kind: "targz" },
  "darwin-x64": { file: `bitcoin-${CORE_VERSION}-x86_64-apple-darwin.tar.gz`, sha256: "bc506958d0f387c1ea770bdc7c7192a505fa645ff62cabcc7761fa7eb89e867e", kind: "targz" },
  "linux-x64": { file: `bitcoin-${CORE_VERSION}-x86_64-linux-gnu.tar.gz`, sha256: "b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e", kind: "targz" },
  "linux-arm64": { file: `bitcoin-${CORE_VERSION}-aarch64-linux-gnu.tar.gz`, sha256: "dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004", kind: "targz" },
  "win32-x64": { file: `bitcoin-${CORE_VERSION}-win64.zip`, sha256: "c99ef173471c58e6766d9eebd12e6c35349082eeed3939bc99eed58ef57db587", kind: "zip" },
};

// assumeutxo snapshot we self-host. Core verifies the snapshot file against this
// height/hash baked into the release, so the CDN host need not be trusted.
// Core 31.x bakes in FOUR mainnet heights: 840000, 880000, 910000 and 935000. We host 935000 — the highest,
// so a first-time user syncs the fewest blocks from the snapshot to the tip. (We moved up from 880000: at a
// ~959k tip that cut the first run from ~134 GB / ~25 h of blocks to ~41 GB / ~8 h.) The file is the one
// published at bitcoin-snapshots.jaonoctus.dev, verified locally with scripts/verify-snapshot.sh — Core
// accepted it against its baked-in hash_serialized commitment, which is why the download source need not be
// trusted. Whichever height we host MUST stay in the running release's m_assumeutxo_data or loadtxoutset
// rejects it, which breaks first-run setup for NEW users only — the assumeutxo watcher (check-assumeutxo.cjs)
// guards exactly that. Keep the previous file (utxo-880000.dat) hosted: installs on older versions have its
// URL baked in and fetch it on first run.
const ASSUMEUTXO = {
  height: 935000,
  blockhash: "0000000000000000000147034958af1652b2b91bba607beacc5e72a56f0fb5ee", // block 935000
  // our CDN URL for the loadtxoutset snapshot file (utxo-<height>.dat); null → full IBD fallback.
  snapshotUrl: "https://dl.getnotzero.com/utxo-935000.dat",
  // exact byte size of that file — a fail-fast check for a truncated/incomplete download before we hand ~9 GB
  // to loadtxoutset (Core still crypto-verifies the contents; this just makes a dropped download obvious).
  bytes: 9387990306,
};

const PRUNE_MIB = 10000; // ~10 GB of recent blocks; min allowed is 550. Chainstate (~snapshot) is on top.
const MANAGED_RPC_PORT = 8332; // the managed node's RPC port (overridable; kept distinct so it can't clash)
// Memory limits for a node that's ALREADY caught up (see node-lifecycle's launch()). Core sizes both of these
// for initial sync — dbcache auto-scales with system RAM and takes ~1 GB on a 16 GB machine — but a synced node
// connects one block per ~10 minutes and touches almost none of it, so that gigabyte is just resident memory in
// an app designed to sit in the background for months. 150 MiB still absorbs a block's worth of churn many times
// over; the cost is more frequent flushes and a few more LevelDB reads per block, both unnoticeable at one
// block/10min.
const SYNCED_DBCACHE_MIB = 150;
// These two have to move together. Core lends UNUSED mempool space to the UTXO cache ("plus up to N MiB of
// unused mempool space" in its startup log), so dbcache alone doesn't bound memory — at the 300 MB default
// maxmempool, a 150 MiB dbcache can still grow to ~430 MiB. Capping the mempool costs us nothing that matters:
// a block template needs one block's worth of transactions, 100 MB still holds ~25 blocks of them, and Core
// evicts lowest-feerate first — so the transactions a template actually wants are the last to be dropped. The
// only visible effect is a shallower mempool in the dashboard's stats.
const SYNCED_MAXMEMPOOL_MIB = 100;

// Resolve the artifact for a platform/arch (defaults to the host).
function coreArtifact(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const a = CORE_ARTIFACTS[key];
  if (!a) throw new Error(`No pinned Bitcoin Core build for ${key}. Supported: ${Object.keys(CORE_ARTIFACTS).join(", ")}`);
  return { ...a, version: CORE_VERSION, url: `${CORE_BASE_URL}/${a.file}` };
}

// SHA-256 of a file on disk (streamed, so large downloads don't load into memory).
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

// Verify a downloaded file against its pinned hash. Throws (and the caller must
// delete the file) on any mismatch — we never proceed with an unverified binary.
async function verifyFile(file, expectedSha256) {
  const actual = await sha256File(file);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`Integrity check FAILED for ${path.basename(file)}: expected ${expectedSha256}, got ${actual}`);
  }
  return true;
}

// Download a URL to a file, following redirects, reporting progress (0..1).
function downloadFile(url, dest, onProgress, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error("Too many redirects"));
    const out = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); out.close();
        const next = new URL(res.headers.location, url).toString();
        return resolve(downloadFile(next, dest, onProgress, _redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); out.close(); return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`)); }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      res.on("data", (d) => { got += d.length; if (onProgress && total) onProgress(got / total, got, total); });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(dest)));
    });
    req.on("error", (e) => { out.close(); fs.rm(dest, { force: true }, () => reject(e)); });
    req.setTimeout(45000, () => req.destroy(new Error("download timed out — couldn't reach the server"))); // don't hang forever on a stalled connection
  });
}

// Download Core for this platform and verify it; deletes a bad download and throws.
async function downloadAndVerifyCore(destDir, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });
  const a = coreArtifact();
  const dest = path.join(destDir, a.file);
  await downloadFile(a.url, dest, onProgress);
  try {
    await verifyFile(dest, a.sha256);
  } catch (e) {
    fs.rm(dest, { force: true }, () => {}); // never leave an unverified binary on disk
    throw e;
  }
  return { file: dest, version: a.version, kind: a.kind };
}

// Extract the Core archive; returns the dir containing bin/bitcoind + bin/bitcoin-cli.
function extractCore(archive, destDir, kind = "targz") {
  fs.mkdirSync(destDir, { recursive: true });
  const r = kind === "zip"
    ? (process.platform === "win32"
        ? spawnSync("tar", ["-xf", archive, "-C", destDir], { stdio: "ignore" }) // Windows has no `unzip`; its bundled bsdtar (system32\tar.exe) auto-detects + extracts zip
        : spawnSync("unzip", ["-oq", archive, "-d", destDir], { stdio: "ignore" }))
    : spawnSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`Failed to extract ${path.basename(archive)}`);
  const top = fs.readdirSync(destDir).find((n) => n.startsWith(`bitcoin-${CORE_VERSION}`));
  if (!top) throw new Error("Extracted archive missing expected bitcoin-<version> directory");
  return path.join(destDir, top);
}

// Bitcoin Core rpcauth credential (HMAC-SHA256 scheme). We default to cookie auth
// for the managed node, but this is here for callers that want a stable credential.
function genRpcAuth(user = "lottery") {
  const salt = crypto.randomBytes(16).toString("hex");
  const password = crypto.randomBytes(24).toString("base64url");
  const hmac = crypto.createHmac("sha256", salt).update(password).digest("hex");
  return { user, password, line: `rpcauth=${user}:${salt}$${hmac}` };
}

// A hardened bitcoin.conf for the managed node: localhost-only RPC (cookie auth),
// no inbound listener, pruned. The datadir is passed via -datadir at launch.
function buildBitcoinConf({ prune = PRUNE_MIB, rpcport = MANAGED_RPC_PORT } = {}) {
  const lines = [
    "# Managed by Bitcoin Lottery — a private, pruned node. Safe to delete with the app.",
    "server=1",
    `prune=${prune}`,
    "listen=0", // no inbound connections; outbound peers for sync still work
    "rpcbind=127.0.0.1",
    "rpcallowip=127.0.0.1",
    `rpcport=${rpcport}`,
  ];
  // Intel Macs have no efficiency cores and run their fans hard during the one-time assumeutxo background
  // validation (Core re-verifies the chain behind the snapshot across all cores). Cap script-verification
  // threads so it stays cool and quiet — slightly slower, but it's background work.
  if (process.platform === "darwin" && process.arch === "x64") lines.push("par=2");
  // Low-RAM / shared boxes: Core auto-sizes dbcache from system RAM, and during assumeutxo background
  // validation two chainstates share it — enough to starve a small box → RPC stalls → the dashboard flaps
  // "not connected". Cap it on constrained machines (≥8 GB keeps Core's own sizing for a fast first sync).
  // This is the SYNC-time cap and applies for the life of the conf; once the node is caught up, launch()
  // overrides it on the command line with the much smaller SYNCED_DBCACHE_MIB.
  const totalGB = os.totalmem() / 1e9;
  if (totalGB < 8) lines.push(`dbcache=${totalGB < 4 ? 150 : 300}`);
  lines.push(""); // cookie auth (auto-generated in datadir) — no rpcuser/rpcpassword on disk
  return lines.join("\n");
}

// Filesystem layout for a managed node under a data root (e.g. app userData).
function managedPaths(dataRoot, platform = process.platform) {
  const node = path.join(dataRoot, "node");
  const coreDir = path.join(node, "core");
  const datadir = path.join(node, "datadir");
  const binDir = path.join(coreDir, `bitcoin-${CORE_VERSION}`, "bin");
  const exe = platform === "win32" ? ".exe" : "";
  return {
    node, coreDir, datadir,
    bitcoind: path.join(binDir, `bitcoind${exe}`),
    cli: path.join(binDir, `bitcoin-cli${exe}`),
    cookie: path.join(datadir, ".cookie"),
    conf: path.join(datadir, "bitcoin.conf"),
    // Written once the chain is fully caught up (including assumeutxo background validation). Its only job is
    // to tell the NEXT launch it can start with a small UTXO cache — deleting it just costs one run at Core's
    // default sizing, so it's safe for a user to remove along with the rest of the node dir.
    syncedFlag: path.join(node, "chain-synced"),
  };
}

module.exports = {
  CORE_VERSION, CORE_ARTIFACTS, ASSUMEUTXO, PRUNE_MIB, MANAGED_RPC_PORT, SYNCED_DBCACHE_MIB, SYNCED_MAXMEMPOOL_MIB,
  coreArtifact, sha256File, verifyFile, downloadFile,
  downloadAndVerifyCore, extractCore, genRpcAuth, buildBitcoinConf, managedPaths,
};
