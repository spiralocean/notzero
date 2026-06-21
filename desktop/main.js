// Phase 2b (step 1) — first-run setup wizard.
//
// On first launch (no config yet) the window shows wizard.html: enter a payout address and connect to a
// node (your running bitcoind via RPC, or "just practice"). On submit, we write config.json into the
// app's data dir and start the engine (miner + bridge), then the window goes to the dashboard. On later
// launches config already exists, so we start the engine and go straight to the dashboard.
//
// The engine runs as standalone PyInstaller binaries when packaged (no Python on the user's machine),
// or via python3 in dev. The dashboard (../web) is reused unchanged, served over a loopback HTTP server.

const { app, BrowserWindow, Menu } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web");
const ICON = path.join(__dirname, "assets", "icon.png");
const WIZARD = path.join(__dirname, "wizard.html");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon",
};

let DATA_DIR, NODE_JSON, ENGINE_ENV, serverPort = null, mainWindow = null;
const configPath = () => path.join(DATA_DIR, "config.json");
async function ensureServer() { if (serverPort == null) serverPort = await startServer(); return serverPort; } // one server for the app's life

// ---- application menu: gives a way back to Settings after first-run setup ----
function openSettings() { if (mainWindow && serverPort) mainWindow.loadURL(`http://127.0.0.1:${serverPort}/setup`); }
function openDashboard() { if (mainWindow && serverPort) mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`); }
function buildMenu() {
  const isMac = process.platform === "darwin";
  const settingsItem = { label: "Settings…", accelerator: isMac ? "Cmd+," : "Ctrl+,", click: openSettings };
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: "about" }, { type: "separator" }, settingsItem, { type: "separator" },
      { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit" },
    ] }] : []),
    { label: "File", submenu: [
      ...(!isMac ? [settingsItem, { type: "separator" }] : []),
      { label: "Dashboard", accelerator: isMac ? "Cmd+D" : "Ctrl+D", click: openDashboard },
      { type: "separator" }, isMac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

// ---- RPC auth + a real connection test, so setup fails loudly here instead of silently later ----
// bitcoind's default cookie location per platform; "" if there's no cookie (explicit rpcuser is set).
function defaultCookiePath() {
  const home = os.homedir();
  const p = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Bitcoin", ".cookie")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Bitcoin", ".cookie")
    : path.join(home, ".bitcoin", ".cookie");
  return fs.existsSync(p) ? p : "";
}
function rpcAuthHeader({ user, pass, cookiePath }) {
  let creds;
  if (user && pass) creds = `${user}:${pass}`;
  else if (cookiePath) { try { creds = fs.readFileSync(cookiePath, "utf8").trim(); } catch (_) { return null; } } // "__cookie__:<random>"
  else return null;
  return "Basic " + Buffer.from(creds).toString("base64");
}
// Try getblockchaininfo and translate the failure into something a human can act on.
function testRpc(rpcUrl, authHeader) {
  return new Promise((resolve) => {
    let u; try { u = new URL(rpcUrl); } catch (_) { return resolve({ ok: false, error: "That RPC URL doesn't look right (expected something like http://127.0.0.1:8332)." }); }
    const payload = JSON.stringify({ jsonrpc: "1.0", id: "setup", method: "getblockchaininfo", params: [] });
    const req = http.request({
      hostname: u.hostname, port: u.port || 8332, path: u.pathname || "/", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader, "Content-Length": Buffer.byteLength(payload) }, timeout: 8000,
    }, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 401) return resolve({ ok: false, error: "Your node rejected those credentials (401). Check the RPC username and password — they must match rpcuser/rpcpassword in your bitcoin.conf exactly." });
        if (res.statusCode !== 200) return resolve({ ok: false, error: `Your node returned HTTP ${res.statusCode}.` });
        try { const j = JSON.parse(data); if (j.error) return resolve({ ok: false, error: "Node error: " + (j.error.message || String(j.error)) }); return resolve({ ok: true, info: j.result }); }
        catch (_) { return resolve({ ok: false, error: "Got an unreadable response from the node." }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Your node didn't respond in time. Is it running, and is the RPC URL/port right?" }); });
    req.on("error", (e) => {
      if (e.code === "ECONNREFUSED") return resolve({ ok: false, error: `Couldn't connect to ${u.host}. Is bitcoind running with server=1?` });
      resolve({ ok: false, error: `Couldn't reach your node (${e.code || e.message}).` });
    });
    req.write(payload); req.end();
  });
}

// ---- write config from the wizard, then (re)start the engine ----
function handleSetup(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on("end", async () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p;
    try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    let existing = {}; try { existing = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {} // settings edit: merge onto current
    const rpcUrl = (p.rpc_url || "http://127.0.0.1:8332").trim();
    const user = (p.rpc_user || "").trim();
    let pass = p.rpc_pass || "";
    // editing settings with the password left blank but the same username → keep the saved password
    if (user && !pass && existing.rpc_pass && (existing.rpc_user || "") === user) pass = existing.rpc_pass;
    const usingCookie = !(user && pass); // blank creds → fall back to the node's auto-generated cookie
    const cookiePath = usingCookie ? defaultCookiePath() : "";
    if (usingCookie && !cookiePath) return json(200, { ok: false, error: "Enter your node's RPC username and password (from bitcoin.conf). We couldn't find a cookie file to log in automatically." });
    const authHeader = rpcAuthHeader({ user, pass, cookiePath });
    if (!authHeader) return json(200, { ok: false, error: "Enter your node's RPC username and password." });

    const test = await testRpc(rpcUrl, authHeader); // verify BEFORE saving — no more silent "unreachable" later
    if (!test.ok) return json(200, { ok: false, error: test.error });

    const cfg = {
      ...existing, // preserve machine_seed, notification prefs, etc. across a settings save
      version: 1,
      mode: "live", // the desktop app is live-only — practice/demo lives on the web
      payout_address: (p.payout_address || "").trim(),
      rpc_url: rpcUrl,
      rpc_user: usingCookie ? "" : user,
      rpc_pass: usingCookie ? "" : pass,
      rpc_cookie: usingCookie ? cookiePath : "",
      machine_seed: existing.machine_seed || "",
      price_poll_interval_min: existing.price_poll_interval_min || 15,
      notifications_enabled: existing.notifications_enabled != null ? existing.notifications_enabled : true,
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch (_) { return json(200, { ok: false, error: "Couldn't save settings." }); }
    if (enginesStarted) restartEngines(); else startEngines();
    json(200, { ok: true, synced: test.info ? !test.info.initialblockdownload : undefined });
  });
}

// ---- static server: the dashboard, the wizard, the bridge's live node.json, and the setup POST ----
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (req.method === "POST" && urlPath === "/setup") { handleSetup(req, res); return; }
      if (urlPath === "/setup") { fs.readFile(WIZARD, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(d); } }); return; }
      if (urlPath === "/config") { // current settings for the wizard to pre-fill (NEVER the password — only whether one is set)
        let cfg = null; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
        const out = cfg ? { exists: true, payout_address: cfg.payout_address || "", rpc_url: cfg.rpc_url || "http://127.0.0.1:8332", rpc_user: cfg.rpc_user || "", has_rpc_pass: !!cfg.rpc_pass, uses_cookie: !!cfg.rpc_cookie } : { exists: false };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(out)); return;
      }
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
  const port = await ensureServer();
  const win = new BrowserWindow({
    width: 1280, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: "#05040a", title: "Bitcoin Lottery", icon: ICON, autoHideMenuBar: false, // keep the menu visible so Settings is reachable (Win/Linux)
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow = win;
  win.loadURL(`http://127.0.0.1:${port}${fs.existsSync(configPath()) ? "/" : "/setup"}`); // first run → wizard
}

app.whenReady().then(() => {
  DATA_DIR = app.getPath("userData"); // the app's own isolated config/state/node.json
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  NODE_JSON = path.join(DATA_DIR, "node.json");
  ENGINE_ENV = { ...process.env, LOTTERY_DATA_DIR: DATA_DIR, NODE_BRIDGE_OUT: NODE_JSON };
  if (fs.existsSync(configPath())) startEngines(); // configured already → mine; otherwise the wizard sets it up
  buildMenu();
  createWindow();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); // dock click → reopen window
app.on("before-quit", stopEngines); // ⌘Q / real quit → stop mining
// On macOS, closing the window keeps the miner running in the background (app stays in the dock; reopen
// from the dock). Only ⌘Q stops it. On Windows/Linux, closing the last window quits the app.
app.on("window-all-closed", () => { if (process.platform !== "darwin") { stopEngines(); app.quit(); } });
