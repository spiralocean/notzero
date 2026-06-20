// Phase 1 — a self-contained desktop app: it runs its OWN node bridge and renders the dashboard.
//
// The dashboard (../web) is reused unchanged, served over a tiny loopback HTTP server so app.js's
// fetches run from a normal http origin. The app spawns the bridge (a standalone PyInstaller binary
// when packaged — no Python needed; the script via python3 in dev) which publishes node.json to a
// writable location the server serves at /node.json. (Phase 2 adds bitcoind + the miner + setup wizard.)

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web");
const ICON = path.join(__dirname, "assets", "icon.png");
const NODE_JSON = path.join(app.getPath("userData"), "node.json"); // writable; the bridge publishes here
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---- the bridge: publishes node.json the dashboard reads ----
let bridgeProc = null;
let stopping = false;

function bridgeCommand() {
  // packaged: the bundled standalone binary (no Python on the user's machine). dev: the script via python3.
  return app.isPackaged
    ? { cmd: path.join(process.resourcesPath, "engine", "bridge"), args: [] }
    : { cmd: "python3", args: [path.join(__dirname, "..", "scripts", "node_bridge.py")] };
}

function startBridge() {
  if (stopping) return;
  const { cmd, args } = bridgeCommand();
  bridgeProc = spawn(cmd, args, { env: { ...process.env, NODE_BRIDGE_OUT: NODE_JSON }, stdio: "ignore" });
  bridgeProc.on("error", () => { bridgeProc = null; });                         // e.g. binary missing
  bridgeProc.on("exit", () => { bridgeProc = null; if (!stopping) setTimeout(startBridge, 2000); }); // restart on crash
}

function stopBridge() {
  stopping = true;
  if (bridgeProc) { try { bridgeProc.kill(); } catch (_) {} bridgeProc = null; }
}

// ---- static server for the dashboard (+ the live node.json from the bridge's writable output) ----
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/node.json") { // live data from the bridge, not the read-only bundle
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

app.whenReady().then(() => { startBridge(); createWindow(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("before-quit", stopBridge);
app.on("window-all-closed", () => { stopBridge(); if (process.platform !== "darwin") app.quit(); });
