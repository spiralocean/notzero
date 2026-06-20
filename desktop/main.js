// Phase 2b (step 1) — first-run setup wizard.
//
// On first launch (no config yet) the window shows wizard.html: enter a payout address and connect to a
// node (your running bitcoind via RPC, or "just practice"). On submit, we write config.json into the
// app's data dir and start the engine (miner + bridge), then the window goes to the dashboard. On later
// launches config already exists, so we start the engine and go straight to the dashboard.
//
// The engine runs as standalone PyInstaller binaries when packaged (no Python on the user's machine),
// or via python3 in dev. The dashboard (../web) is reused unchanged, served over a loopback HTTP server.

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web");
const ICON = path.join(__dirname, "assets", "icon.png");
const WIZARD = path.join(__dirname, "wizard.html");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon",
};

let DATA_DIR, NODE_JSON, ENGINE_ENV;
const configPath = () => path.join(DATA_DIR, "config.json");

// ---- engine: our own miner + bridge, in an isolated data dir ----
const procs = {};
let stopping = false, enginesStarted = false;

function engineCmd(name) {
  const minerArgs = name === "miner" ? ["--daemon"] : [];
  if (app.isPackaged) return { cmd: path.join(process.resourcesPath, "engine", name), args: minerArgs }; // bundled binary, no Python
  const script = name === "bridge" ? path.join(__dirname, "..", "scripts", "node_bridge.py") : path.join(__dirname, "..", "lottery_miner.py");
  return { cmd: "python3", args: [script, ...minerArgs] };
}
function startEngine(name) {
  if (stopping) return;
  const { cmd, args } = engineCmd(name);
  const p = spawn(cmd, args, { env: ENGINE_ENV, stdio: "ignore" });
  procs[name] = p;
  p.on("error", () => { delete procs[name]; });
  p.on("exit", () => { delete procs[name]; if (!stopping) setTimeout(() => startEngine(name), 2000); }); // restart on crash
}
function startEngines() { if (enginesStarted) return; enginesStarted = true; startEngine("miner"); startEngine("bridge"); }
function restartEngines() { for (const n of Object.keys(procs)) { try { procs[n].kill(); } catch (_) {} } } // exit handlers respawn with new config
function stopEngines() { stopping = true; for (const p of Object.values(procs)) { try { p.kill(); } catch (_) {} } }

// ---- write config from the wizard, then (re)start the engine ----
function handleSetup(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p;
    try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    const live = p.mode === "live";
    if (live && (!p.rpc_user || !p.rpc_pass)) return json(200, { ok: false, error: "Enter your node's RPC username and password (from bitcoin.conf)." });
    const cfg = {
      version: 1,
      mode: live ? "live" : "symbolic",
      payout_address: (p.payout_address || "").trim(),
      rpc_url: (p.rpc_url || "http://127.0.0.1:8332").trim(),
      rpc_user: (p.rpc_user || "").trim(),
      rpc_pass: p.rpc_pass || "",
      machine_seed: "",
      price_poll_interval_min: 15,
      notifications_enabled: true,
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch (_) { return json(200, { ok: false, error: "Couldn't save settings." }); }
    if (enginesStarted) restartEngines(); else startEngines();
    json(200, { ok: true });
  });
}

// ---- static server: the dashboard, the wizard, the bridge's live node.json, and the setup POST ----
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (req.method === "POST" && urlPath === "/setup") { handleSetup(req, res); return; }
      if (urlPath === "/setup") { fs.readFile(WIZARD, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(d); } }); return; }
      if (urlPath === "/node.json") { // live data from the bridge's writable output, not the read-only bundle
        fs.readFile(NODE_JSON, (e, d) => { if (e) { res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}"); } else { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(d); } });
        return;
      }
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.resolve(WEB_DIR, rel);
      if (!filePath.startsWith(path.resolve(WEB_DIR))) { res.writeHead(403); res.end("forbidden"); return; }
      fs.readFile(filePath, (e, d) => {
        if (e) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(d);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function createWindow() {
  if (!app.isPackaged && process.platform === "darwin" && app.dock) app.dock.setIcon(ICON);
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1280, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: "#05040a", title: "Bitcoin Lottery", icon: ICON, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}${fs.existsSync(configPath()) ? "/" : "/setup"}`); // first run → wizard
}

app.whenReady().then(() => {
  DATA_DIR = app.getPath("userData"); // the app's own isolated config/state/node.json
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  NODE_JSON = path.join(DATA_DIR, "node.json");
  ENGINE_ENV = { ...process.env, LOTTERY_DATA_DIR: DATA_DIR, NODE_BRIDGE_OUT: NODE_JSON };
  if (fs.existsSync(configPath())) startEngines(); // configured already → mine; otherwise the wizard sets it up
  createWindow();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("before-quit", stopEngines);
app.on("window-all-closed", () => { stopEngines(); if (process.platform !== "darwin") app.quit(); });
