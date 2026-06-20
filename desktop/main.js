// Phase 2a — a self-contained miner: the app runs its OWN miner + bridge in an isolated data dir and
// renders the dashboard. Out of the box it mines in symbolic mode (no node required) so it works the
// instant it's installed; the dashboard shows the live attempts. (Phase 2b: bitcoind + live mode + the
// first-run wizard for the payout address.)
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
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---- the engine: our own miner + bridge, in an isolated data dir ----
let DATA_DIR, NODE_JSON, ENGINE_ENV;
const procs = {};
let stopping = false;

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
  p.on("error", () => { delete procs[name]; });                                       // e.g. binary missing
  p.on("exit", () => { delete procs[name]; if (!stopping) setTimeout(() => startEngine(name), 2000); }); // restart on crash
}

function stopEngines() {
  stopping = true;
  for (const p of Object.values(procs)) { try { p.kill(); } catch (_) {} }
}

// ---- static server for the dashboard (+ the live node.json the bridge publishes) ----
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/node.json") { // live data from the bridge's writable output, not the read-only bundle
        fs.readFile(NODE_JSON, (err, data) => {
          if (err) { res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}"); return; }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(data);
        });
        return;
      }
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.resolve(WEB_DIR, rel);
      if (!filePath.startsWith(path.resolve(WEB_DIR))) { res.writeHead(403); res.end("forbidden"); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(data);
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
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#05040a",
    title: "Bitcoin Lottery",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  DATA_DIR = app.getPath("userData"); // the app's own isolated config/state/node.json (no clash with any existing daemon)
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  NODE_JSON = path.join(DATA_DIR, "node.json");
  ENGINE_ENV = { ...process.env, LOTTERY_DATA_DIR: DATA_DIR, NODE_BRIDGE_OUT: NODE_JSON };
  startEngine("miner");   // mines (symbolic until a node is set up)
  startEngine("bridge");  // publishes node.json the dashboard reads
  createWindow();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("before-quit", stopEngines);
app.on("window-all-closed", () => { stopEngines(); if (process.platform !== "darwin") app.quit(); });
