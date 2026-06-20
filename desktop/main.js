// Phase 0 — render the existing web dashboard in a native window.
//
// The dashboard (../web) is reused UNCHANGED. We serve it over a tiny localhost HTTP server (not file://)
// so app.js's `fetch('./node.json')` and the mempool.space calls run from a normal http origin, exactly
// like the dev server. Later phases will have this same app spawn bitcoind + the bridge + the miner and
// write the node.json the dashboard reads.

const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// dev: the dashboard lives at ../web. packaged: it's copied into the app's Resources (see extraResources).
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

// minimal, dependency-free static server for ../web on a random loopback port
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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
  // dev: give the dock/taskbar a real icon (packaged apps get theirs from the bundle automatically)
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

app.whenReady().then(createWindow);
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
