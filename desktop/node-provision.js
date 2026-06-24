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
//  - PGP signature verification (Bitcoin Core's guix builder keys) is a
//    defense-in-depth follow-up; the pinned hash is the enforced gate today.
//
// UPDATING CORE: bump CORE_VERSION + the CORE_ARTIFACTS hashes from
// https://bitcoincore.org/bin/bitcoin-core-<v>/SHA256SUMS, and ASSUMEUTXO from
// src/kernel/chainparams.cpp (m_assumeutxo_data) for that release.
// ---------------------------------------------------------------------------
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const CORE_VERSION = "31.0";
const CORE_BASE_URL = `https://bitcoincore.org/bin/bitcoin-core-${CORE_VERSION}`;

// SHA-256 of each official artifact (from the release SHA256SUMS). Verified-or-refuse.
const CORE_ARTIFACTS = {
  "darwin-arm64": { file: `bitcoin-${CORE_VERSION}-arm64-apple-darwin.tar.gz`, sha256: "a2d7a13b4da53d4a3e4c517f3a0269e2429813417bb320d3b268993cfdc545d0", kind: "targz" },
  "darwin-x64": { file: `bitcoin-${CORE_VERSION}-x86_64-apple-darwin.tar.gz`, sha256: "56824dd705bc2a3b22d42e8aa02ed53498d491ff7c2c8aa96831333871887ead", kind: "targz" },
  "linux-x64": { file: `bitcoin-${CORE_VERSION}-x86_64-linux-gnu.tar.gz`, sha256: "d3e4c58a35b1d0a97a457462c94f55501ad167c660c245cb1ffa565641c65074", kind: "targz" },
  "linux-arm64": { file: `bitcoin-${CORE_VERSION}-aarch64-linux-gnu.tar.gz`, sha256: "4de1d568dedd48604f75132421bc0abeca432639589b49a3909c81db3a813112", kind: "targz" },
  "win32-x64": { file: `bitcoin-${CORE_VERSION}-win64.zip`, sha256: "82fd2c504a0f20a31d4d13bd407783d6fc7bf17622d0ce85228a9b92694e03f0", kind: "zip" },
};

// assumeutxo snapshot we self-host. Core verifies the snapshot file against this
// height/hash baked into the release, so the CDN host need not be trusted.
// Core 31 has both 840000 and 880000 baked in; we use 840000 because a verified
// snapshot is publicly available to re-host (blog.lopp.net) — no archival node needed.
const ASSUMEUTXO = {
  height: 840000,
  blockhash: "0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5", // block 840000 (the halving block)
  // our CDN URL for the loadtxoutset snapshot file (utxo-<height>.dat); null → full IBD fallback.
  snapshotUrl: null,
};

const PRUNE_MIB = 10000; // ~10 GB of recent blocks; min allowed is 550. Chainstate (~snapshot) is on top.
const MANAGED_RPC_PORT = 8332; // the managed node's RPC port (overridable; kept distinct so it can't clash)

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
    ? spawnSync("unzip", ["-oq", archive, "-d", destDir], { stdio: "ignore" })
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
  return [
    "# Managed by Bitcoin Lottery — a private, pruned node. Safe to delete with the app.",
    "server=1",
    `prune=${prune}`,
    "listen=0", // no inbound connections; outbound peers for sync still work
    "rpcbind=127.0.0.1",
    "rpcallowip=127.0.0.1",
    `rpcport=${rpcport}`,
    "", // cookie auth (auto-generated in datadir) — no rpcuser/rpcpassword on disk
  ].join("\n");
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
  };
}

module.exports = {
  CORE_VERSION, CORE_ARTIFACTS, ASSUMEUTXO, PRUNE_MIB, MANAGED_RPC_PORT,
  coreArtifact, sha256File, verifyFile, downloadFile,
  downloadAndVerifyCore, extractCore, genRpcAuth, buildBitcoinConf, managedPaths,
};
