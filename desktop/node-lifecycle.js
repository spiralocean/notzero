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

  async function waitForRpc(timeoutMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!child && !stopping) throw new Error("bitcoind exited before it became reachable");
      try { await rpc("getblockchaininfo", [], 4000); return; } catch (_) {}
      await sleep(1500);
    }
    throw new Error("the node did not become reachable in time");
  }

  // Load the assumeutxo snapshot if the node is still in IBD and we host one.
  async function maybeLoadSnapshot() {
    let info; try { info = await rpc("getblockchaininfo"); } catch { return; }
    if (info.initialblockdownload === false) return;     // already usable
    if (info.blocks >= P.ASSUMEUTXO.height) return;      // already past the snapshot height
    if (!P.ASSUMEUTXO.snapshotUrl) return;               // Phase 2 stub: no hosted snapshot yet → normal IBD
    const snap = path.join(paths.node, `utxo-${P.ASSUMEUTXO.height}.dat`);
    try {
      const DL_MSG = "Downloading the verified snapshot (about 9 GB) — the longest part of setup.";
      if (!fs.existsSync(snap)) {
        emit(STATES.LOADING_SNAPSHOT, 0, DL_MSG);
        await P.downloadFile(P.ASSUMEUTXO.snapshotUrl, snap, (p) => emit(STATES.LOADING_SNAPSHOT, p, DL_MSG));
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
      try { await rpc("loadtxoutset", [snap], 0); }      // Core verifies vs its baked-in hash; long-running
      finally { loadingSnap = false; }
    } catch (e) {
      // assumeutxo fast-start failed — don't dead-end in an error. bitcoind is already doing IBD, so fall
      // back to a normal full sync from genesis and let sync() carry on: slower, but the node still works.
      emit(STATES.SYNCING, null, `Couldn't fast-start from the snapshot (${(e && e.message) || "unknown error"}). Syncing the full chain from scratch instead — this works, but takes much longer.`);
    }
  }

  // Bring the node up to "started + snapshot attempted". Caller then polls sync().
  async function start() {
    stopping = false;
    await ensureCore();
    writeConf();
    emit(STATES.STARTING);
    launch();
    await waitForRpc();
    await maybeLoadSnapshot();
    return sync();
  }

  // One sync sample → {state, progress, blocks, headers, mineable}.
  async function sync() {
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
