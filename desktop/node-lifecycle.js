// ---------------------------------------------------------------------------
// Managed node lifecycle (Phase 2) — bring a provisioned Bitcoin Core up to a
// mineable state and keep it healthy. Builds on node-provision.js (Phase 1).
//
// State machine (emitted via onState):
//   downloading-core → extracting → starting → loading-snapshot → syncing → ready
//   (any step can go to `error`; stop() → `stopped`)
//
// assumeutxo: once the node is up we loadtxoutset the self-hosted snapshot —
// Core verifies it against the height/blockhash baked into the release, so the
// node reaches the snapshot height instantly, then syncs that → tip. "ready"
// (= mineable, getblocktemplate works) means out of initial block download.
// Until ASSUMEUTXO.snapshotUrl is set, we gracefully fall back to normal IBD.
// ---------------------------------------------------------------------------
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const P = require("./node-provision");

const STATES = {
  IDLE: "idle", DOWNLOADING: "downloading-core", EXTRACTING: "extracting",
  STARTING: "starting", LOADING_SNAPSHOT: "loading-snapshot", SYNCING: "syncing",
  READY: "ready", ERROR: "error", STOPPED: "stopped",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the last `bytes` of a file as text — for tailing Core's debug.log without loading it all.
function tailFile(p, bytes = 16384) {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(bytes, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - bytes));
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch (_) { return ""; }
}

// JSON-RPC to the managed node using its auto-generated cookie (localhost only).
function rpcOverCookie(rpcUrl, cookiePath, method, params = [], timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let auth;
    try { auth = "Basic " + Buffer.from(fs.readFileSync(cookiePath, "utf8").trim()).toString("base64"); }
    catch { return reject(new Error("cookie not ready")); }
    const u = new URL(rpcUrl);
    const payload = JSON.stringify({ jsonrpc: "1.0", id: "mn", method, params });
    const req = http.request({
      hostname: u.hostname, port: u.port, path: "/", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth, "Content-Length": Buffer.byteLength(payload) }, timeout: timeoutMs,
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message || String(j.error))); resolve(j.result); } catch (_) { reject(new Error(`bad RPC response (HTTP ${res.statusCode})`)); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("RPC timeout")); });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

// Map a getblockchaininfo result to our state + a 0..1 progress for the UI.
function syncStateFrom(info) {
  const ibd = info.initialblockdownload !== false;
  return {
    state: ibd ? STATES.SYNCING : STATES.READY,
    progress: Math.max(0, Math.min(1, info.verificationprogress || 0)),
    blocks: info.blocks, headers: info.headers, mineable: !ibd,
  };
}

function createManagedNode({ dataRoot, rpcport = P.MANAGED_RPC_PORT, onState = () => {} } = {}) {
  const paths = P.managedPaths(dataRoot);
  const rpcUrl = `http://127.0.0.1:${rpcport}`;
  let child = null, stopping = false, lastState = STATES.IDLE;
  const emit = (state, progress = null, detail = null) => { lastState = state; onState({ state, progress, detail }); };
  const rpc = (method, params = [], timeoutMs) => rpcOverCookie(rpcUrl, paths.cookie, method, params, timeoutMs);

  // Download + verify + extract Core if it isn't already present.
  async function ensureCore() {
    if (fs.existsSync(paths.bitcoind)) return;
    fs.mkdirSync(paths.coreDir, { recursive: true });
    emit(STATES.DOWNLOADING, 0);
    const { file, kind } = await P.downloadAndVerifyCore(paths.coreDir, (p) => emit(STATES.DOWNLOADING, p));
    emit(STATES.EXTRACTING);
    P.extractCore(file, paths.coreDir, kind);
    fs.rm(file, { force: true }, () => {});
    if (!fs.existsSync(paths.bitcoind)) throw new Error("bitcoind missing after extract");
  }

  function writeConf() {
    fs.mkdirSync(paths.datadir, { recursive: true });
    if (!fs.existsSync(paths.conf)) fs.writeFileSync(paths.conf, P.buildBitcoinConf({ rpcport }), { mode: 0o600 });
  }

  function launch() {
    child = spawn(paths.bitcoind, [`-datadir=${paths.datadir}`], { stdio: ["ignore", "ignore", "pipe"] });
    let errTail = "";
    if (child.stderr) child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-800); }); // keep bitcoind's own error output
    child.on("error", (e) => { const was = child; child = null; if (!stopping && was) emit(STATES.ERROR, null, `couldn't start the node: ${e.message}`); });
    child.on("exit", (code) => {
      const was = child; child = null;
      if (!stopping && was) {
        const why = errTail.trim().split("\n").filter(Boolean).pop();
        emit(STATES.ERROR, null, `the node stopped unexpectedly (code ${code})${why ? `: ${why}` : ""}`);
      }
    });
  }

  async function waitForRpc(timeoutMs = 300000) {
    // A restart (e.g. right after an update) reloads the block index + mempool and resumes assumeutxo
    // background validation before RPC opens — on a busy/slow disk that can take minutes, so wait generously
    // and show elapsed time instead of freezing on "Starting…" then failing at a too-short deadline.
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!child && !stopping) throw new Error("bitcoind exited before it became reachable");
      try { await rpc("getblockchaininfo", [], 5000); return; } catch (_) {}
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs >= 12) emit(STATES.STARTING, null, `Your node is starting — loading the chain (${secs}s). This can take a few minutes, especially right after an update.`);
      await sleep(1500);
    }
    throw new Error("the node did not become reachable in time");
  }

  // Free bytes on the datadir's filesystem (null if the platform/Node build can't report it).
  function freeBytes() {
    try { const s = fs.statfsSync(paths.datadir); return s.bavail * s.bsize; } catch (_) { return null; }
  }
  // Delete any assumeutxo snapshot files (utxo-<height>.dat). They're read exactly once by loadtxoutset and
  // then dead weight — a 9.8 GB leftover here once filled a user's disk to 100% and crashed the node.
  function sweepSnapshotFiles() {
    try { for (const f of fs.readdirSync(paths.node)) if (/^utxo-\d+\.dat$/.test(f)) { try { fs.unlinkSync(path.join(paths.node, f)); } catch (_) {} } } catch (_) {}
  }

  // Load the assumeutxo snapshot if the node is still in IBD and we host one.
  async function maybeLoadSnapshot() {
    let info; try { info = await rpc("getblockchaininfo"); } catch { return; }
    // Already usable / past the snapshot height → any downloaded utxo-*.dat is dead weight; reclaim it now
    // (also cleans up a leftover from an older build that never deleted it after loading).
    if (info.initialblockdownload === false || info.blocks >= P.ASSUMEUTXO.height) { sweepSnapshotFiles(); return; }
    if (!P.ASSUMEUTXO.snapshotUrl) return;               // Phase 2 stub: no hosted snapshot yet → normal IBD
    const snap = path.join(paths.node, `utxo-${P.ASSUMEUTXO.height}.dat`);
    try {
      // Don't start a ~10 GB download onto a disk that can't also hold the chainstate it expands into — that's
      // how the disk hits 100%. Bail to normal IBD instead (slower, but safe on small disks).
      const free = freeBytes();
      if (free != null && !fs.existsSync(snap) && free < 14 * 1024 ** 3)
        throw new Error(`not enough free disk for the fast-start snapshot (need ~14 GB, have ${(free / 1024 ** 3).toFixed(1)} GB) — syncing normally instead`);
      const DL_MSG = "Downloading the verified snapshot (about 9 GB) — the longest part of setup.";
      if (!fs.existsSync(snap)) {
        emit(STATES.LOADING_SNAPSHOT, 0, DL_MSG);
        await P.downloadFile(P.ASSUMEUTXO.snapshotUrl, snap, (p) => emit(STATES.LOADING_SNAPSHOT, p, DL_MSG));
      }
      // Fail fast on a truncated/incomplete download (a dropped connection is the common case, and a leftover
      // partial file from a prior run would otherwise be fed straight to loadtxoutset). Wrong size → discard it
      // so the next attempt re-downloads cleanly, and fall back to normal IBD for now. (Core still validates the
      // contents cryptographically on load; this just turns a cryptic mid-load failure into a clear, retryable one.)
      if (P.ASSUMEUTXO.bytes && fs.existsSync(snap)) {
        const got = fs.statSync(snap).size;
        if (got !== P.ASSUMEUTXO.bytes) {
          try { fs.unlinkSync(snap); } catch (_) {}
          throw new Error(`snapshot download was incomplete (${got.toLocaleString()} of ${P.ASSUMEUTXO.bytes.toLocaleString()} bytes) — syncing normally instead; reopen the app to retry the fast start`);
        }
      }
      // loadtxoutset needs the snapshot's base block header (at ASSUMEUTXO.height) to ALREADY be in the
      // node's headers chain — otherwise it errors "base block header must appear in the headers chain".
      // Headers sync quickly from peers; wait for them to pass the snapshot height before loading.
      let headersOk = false;
      for (let i = 0; i < 600 && !headersOk; i++) {      // up to ~10 min
        let ci; try { ci = await rpc("getblockchaininfo"); } catch { ci = null; }
        const h = (ci && ci.headers) || 0;
        if (h >= P.ASSUMEUTXO.height) { headersOk = true; break; }
        emit(STATES.LOADING_SNAPSHOT, null, `Catching up block headers — ${h.toLocaleString()} / ${P.ASSUMEUTXO.height.toLocaleString()}…`);
        await sleep(1000);
      }
      if (!headersOk) throw new Error("block headers didn't reach the snapshot height — check your internet/firewall");
      // loadtxoutset has no RPC progress callback, but Core logs "[snapshot] N coins loaded (X%…)" to
      // debug.log. Tail it so this heavy step shows a REAL progress bar instead of a frozen one.
      const LOAD_MSG = "Loading the snapshot into your node — the heavy step, a few minutes. Please leave the app open.";
      emit(STATES.LOADING_SNAPSHOT, 0, LOAD_MSG);
      const debugLog = path.join(paths.datadir, "debug.log");
      let loadingSnap = true;
      (async () => {
        while (loadingSnap) {
          const m = [...tailFile(debugLog).matchAll(/\[snapshot\]\s+\d+\s+coins loaded\s+\(([\d.]+)%/g)].pop();
          if (m) emit(STATES.LOADING_SNAPSHOT, Math.min(0.999, parseFloat(m[1]) / 100), LOAD_MSG);
          await sleep(2000);
        }
      })();
      try { await rpc("loadtxoutset", [snap], 0); sweepSnapshotFiles(); } // loaded (read once) → reclaim the ~9.8 GB .dat
      finally { loadingSnap = false; }
    } catch (e) {
      // assumeutxo fast-start failed — don't dead-end in an error. bitcoind is already doing IBD, so fall
      // back to a normal full sync from genesis and let sync() carry on: slower, but the node still works.
      emit(STATES.SYNCING, null, `Couldn't fast-start from the snapshot (${(e && e.message) || "unknown error"}). Syncing the full chain from scratch instead — this works, but takes much longer.`);
    }
  }

  // Kill any bitcoind still holding THIS node's datadir before launching — an orphan from a prior app instance,
  // or a slow one from a previous retry — so a restart never fails with "Cannot obtain a lock … already
  // running". Unix matches by datadir (precise); Windows kills bitcoind.exe (managed users run one node).
  async function reapStaleBitcoind() {
    const cp = require("child_process");
    const alive = () => {
      try {
        if (process.platform === "win32") return /bitcoind\.exe/i.test(cp.execFileSync("tasklist", ["/FI", "IMAGENAME eq bitcoind.exe", "/NH"], { encoding: "utf8", timeout: 8000 }));
        cp.execFileSync("pgrep", ["-f", paths.datadir], { stdio: "ignore" }); return true;
      } catch (_) { return false; }
    };
    if (!alive()) return;
    try {
      if (process.platform === "win32") cp.execFileSync("taskkill", ["/F", "/IM", "bitcoind.exe"], { stdio: "ignore", timeout: 8000 });
      else cp.execFileSync("pkill", ["-TERM", "-f", paths.datadir], { stdio: "ignore", timeout: 8000 });
    } catch (_) {}
    for (let i = 0; i < 40 && alive(); i++) await sleep(500); // wait up to ~20s for a clean shutdown + lock release
  }

  // Bring the node up to "started + snapshot attempted". Caller then polls sync().
  async function start() {
    stopping = false;
    await ensureCore();
    writeConf();
    await reapStaleBitcoind(); // free the datadir lock first, so a restart/retry never collides with an old bitcoind
    emit(STATES.STARTING);
    launch();
    await waitForRpc();
    await maybeLoadSnapshot();
    return sync();
  }

  // One sync sample → {state, progress, blocks, headers, mineable}.
  async function sync() {
    // Disk guard: if free space is critically low, pause the node cleanly rather than letting bitcoind fill the
    // disk to 100% — a full disk crashes the node (risking chainstate damage) and can take down everything else
    // sharing the machine. A paused node is trivially recoverable; a full disk is not.
    const free = freeBytes();
    if (!stopping && free != null && free < 2 * 1024 ** 3) {
      emit(STATES.ERROR, null, `Your disk is almost full (only ${(free / 1024 ** 3).toFixed(1)} GB free). Pausing the node to protect it and the rest of your system — free up space, then restart the app.`);
      await stop();
      return { state: STATES.ERROR, progress: null, blocks: 0, headers: 0, mineable: false };
    }
    const info = await rpc("getblockchaininfo");
    const s = syncStateFrom(info);
    emit(s.state, s.progress, `${s.blocks}/${s.headers}`);
    return s;
  }

  // The managed RPC config the miner/bridge use once the node is mineable.
  function rpcConfig() {
    return { rpc_url: rpcUrl, rpc_user: "", rpc_pass: "", rpc_cookie: paths.cookie };
  }

  async function stop() {
    stopping = true;
    try { await rpc("stop", [], 4000); } catch (_) {}
    for (let i = 0; i < 20 && child; i++) await sleep(500); // give bitcoind time to flush + exit cleanly
    if (child) { try { child.kill(); } catch (_) {} child = null; }
    emit(STATES.STOPPED);
  }

  return { paths, rpcUrl, start, sync, stop, rpc, rpcConfig, ensureCore, writeConf, get state() { return lastState; }, get pid() { return child && child.pid; } };
}

module.exports = { STATES, createManagedNode, syncStateFrom, rpcOverCookie };
