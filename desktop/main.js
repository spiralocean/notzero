// Phase 2b (step 1) — first-run setup wizard.
//
// On first launch (no config yet) the window shows wizard.html: enter a payout address and connect to a
// node (your running bitcoind via RPC, or "just practice"). On submit, we write config.json into the
// app's data dir and start the engine (miner + bridge), then the window goes to the dashboard. On later
// launches config already exists, so we start the engine and go straight to the dashboard.
//
// The engine runs as standalone PyInstaller binaries when packaged (no Python on the user's machine),
// or via python3 in dev. The dashboard (../web) is reused unchanged, served over a loopback HTTP server.

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, Notification } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const NodeLifecycle = require("./node-lifecycle"); // managed-node provisioning (Phases 1–2)
const NodeProvision = require("./node-provision");
const { autoUpdater } = require("electron-updater"); // background auto-update from dl.getnotzero.com

const REQUIRED_FREE_BYTES = 25 * 1024 ** 3; // ~25 GB headroom for snapshot + pruned chain + load-time peak
// Free bytes on the volume holding `dir` (null if it can't be determined → don't block).
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (_) { return null; }
}
const gb = (b) => Math.round(b / 1024 ** 3);

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web");
const ICON = path.join(__dirname, "assets", "icon.png");
const WIZARD = path.join(__dirname, "wizard.html");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon",
};

let DATA_DIR, NODE_JSON, ENGINE_ENV, serverPort = null, mainWindow = null;
let tray = null, isQuitting = false; // Windows: window close hides to tray (keeps mining); only Quit sets isQuitting
let managed = null, managedState = { state: "idle", progress: null, detail: null }; // managed-node provisioning state
let managedLog = []; // human-readable step log, shown in the wizard + written to install.log
let lastLogKey = "";
const STEP_LABEL = {
  "downloading-core": "Downloading Bitcoin Core", "extracting": "Verifying & installing Bitcoin Core",
  "starting": "Starting your private node", "loading-snapshot": "Loading the verified chain snapshot",
  "syncing": "Syncing the blockchain", "ready": "Ready", "error": "Something went wrong",
};
function logManaged(s) {
  const key = `${s.state}|${s.detail || ""}`; // log on step/detail change — not on every progress tick
  if (key === lastLogKey) return;
  lastLogKey = key;
  const t = new Date().toTimeString().slice(0, 8);
  const line = `${t}  ${STEP_LABEL[s.state] || s.state}${s.detail ? `: ${s.detail}` : ""}`;
  managedLog.push(line);
  try { fs.appendFileSync(path.join(DATA_DIR, "install.log"), line + "\n"); } catch (_) {}
}
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
    { role: "help", submenu: [
      { label: "Check for Updates…", click: () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); } },
      { type: "separator" },
      { label: "Email Support", click: () => shell.openExternal("mailto:support@getnotzero.com") },
      { label: "Terms & Privacy", click: () => shell.openExternal("https://getnotzero.com/#terms") },
      { type: "separator" },
      { label: "Tip the Developer ⚡", click: () => shell.openExternal("https://getnotzero.com/#tip") },
      { label: "getnotzero.com", click: () => shell.openExternal("https://getnotzero.com") },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- auto-update: quietly check the dl.getnotzero.com feed on launch + every few hours.
// Downloads in the background and installs on quit. Errors are swallowed (a failed update
// check must never bother a non-technical user). No-op in dev (no app-update.yml). ----
function initAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("error", () => {}); // a failed update check must never bother the user
  autoUpdater.on("update-downloaded", () => {
    // auto-apply: a quick relaunch onto the new version (mining resumes on restart), so a published
    // fix reaches every running install within the check interval — no manual download needed.
    try { if (Notification.isSupported()) new Notification({ title: "Updating notzero", body: "Installing the latest version — back in a moment." }).show(); } catch (_) {}
    setTimeout(() => { try { autoUpdater.quitAndInstall(); } catch (_) {} }, 4000);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 2 * 60 * 60 * 1000); // every 2 hours
}

// ---- engine: our own miner + bridge, in an isolated data dir ----
const procs = {};
let stopping = false, enginesStarted = false;

function engineCmd(name) {
  const minerArgs = name === "miner" ? ["--daemon"] : [];
  if (app.isPackaged) return { cmd: path.join(process.resourcesPath, "engine", name + (process.platform === "win32" ? ".exe" : "")), args: minerArgs }; // bundled binary (.exe on Windows), no Python
  const script = name === "bridge" ? path.join(__dirname, "..", "scripts", "node_bridge.py") : path.join(__dirname, "..", "lottery_miner.py");
  return { cmd: "python3", args: [script, ...minerArgs] };
}
function startEngine(name) {
  if (stopping) return;
  if (procs[name]) return; // already running — don't spawn a duplicate (an orphaned proc would keep its own respawn chain alive, multiplying engines)
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
// Resolve the cookie file from an optional user-supplied location: a custom -datadir (we append .cookie),
// the .cookie file itself, or — when blank — the platform default. "" if nothing usable exists.
function resolveCookiePath(userPath) {
  const p = (userPath || "").trim();
  if (!p) return defaultCookiePath();
  const candidate = p.endsWith(".cookie") ? p : path.join(p, ".cookie");
  return fs.existsSync(candidate) ? candidate : "";
}
// Generic JSON-RPC call (any method/params, optional /wallet/<name> path). Mirrors testRpc's error mapping.
function rpcCall(rpcUrl, authHeader, method, params) {
  return new Promise((resolve) => {
    let u; try { u = new URL(rpcUrl); } catch (_) { return resolve({ ok: false, error: "That RPC URL doesn't look right." }); }
    const payload = JSON.stringify({ jsonrpc: "1.0", id: "app", method, params: params || [] });
    const req = http.request({
      hostname: u.hostname, port: u.port || 8332, path: (u.pathname || "/") + (u.search || ""), method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader, "Content-Length": Buffer.byteLength(payload) }, timeout: 8000,
    }, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 401) return resolve({ ok: false, error: "Your node rejected those credentials (401)." });
        try { const j = JSON.parse(data); if (j.error) return resolve({ ok: false, error: j.error.message || String(j.error) }); return resolve({ ok: true, result: j.result }); }
        catch (_) { return resolve({ ok: false, error: res.statusCode !== 200 ? `Your node returned HTTP ${res.statusCode}.` : "Got an unreadable response from the node." }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Your node didn't respond in time." }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code === "ECONNREFUSED" ? `Couldn't connect to ${u.host}. Is bitcoind running with server=1?` : `Couldn't reach your node (${e.code || e.message}).` }));
    req.write(payload); req.end();
  });
}
// Ask the node's wallet for a fresh receive address of the requested type.
async function nodeGetNewAddress(rpcUrl, authHeader, addrType) {
  const wl = await rpcCall(rpcUrl, authHeader, "listwallets", []);
  if (!wl.ok) return wl.error && /method not found/i.test(wl.error) ? { ok: false, error: "Wallet is disabled on your node (disablewallet=1). Paste a receive address instead." } : wl;
  const wallets = wl.result || [];
  if (!wallets.length) return { ok: false, error: "Your node has no wallet loaded. Load or create one (bitcoin-cli loadwallet …), or paste an address manually." };
  const base = rpcUrl.replace(/\/+$/, ""); // target the first loaded wallet explicitly so it works with multi-wallet nodes
  const r = await rpcCall(`${base}/wallet/${encodeURIComponent(wallets[0])}`, authHeader, "getnewaddress", addrType ? ["", addrType] : [""]);
  return r.ok ? { ok: true, address: r.result, wallet: wallets[0] } : r;
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
    const datadir = (p.rpc_datadir || "").trim(); // optional: custom -datadir or direct .cookie path
    const coinbaseTag = (p.coinbase_tag || "").trim().slice(0, 90); // operator's vanity coinbase message (miner byte-caps to consensus)
    const usingCookie = !(user && pass); // blank creds → fall back to the node's auto-generated cookie
    const cookiePath = usingCookie ? resolveCookiePath(datadir) : "";
    if (usingCookie && !cookiePath) return json(200, { ok: false, error: datadir
      ? "Couldn't find a .cookie there. Point to your node's data directory (or its .cookie file directly), or enter rpcuser/rpcpassword."
      : "Enter your node's RPC username and password (from bitcoin.conf). We couldn't find a cookie file to log in automatically." });
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
      rpc_datadir: usingCookie ? datadir : "", // remembered so the settings screen can pre-fill it
      coinbase_tag: coinbaseTag,
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

// ---- fetch a fresh receive address from the node's own wallet (so node operators needn't paste one) ----
function handleNodeAddress(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on("end", async () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    const rpcUrl = (p.rpc_url || "http://127.0.0.1:8332").trim();
    const user = (p.rpc_user || "").trim();
    let pass = p.rpc_pass || "";
    let existing = {}; try { existing = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    if (user && !pass && existing.rpc_pass && (existing.rpc_user || "") === user) pass = existing.rpc_pass; // reuse saved pass when blank
    const usingCookie = !(user && pass);
    const cookiePath = usingCookie ? resolveCookiePath((p.rpc_datadir || "").trim()) : "";
    if (usingCookie && !cookiePath) return json(200, { ok: false, error: "Connect to your node first (RPC credentials, or a reachable cookie) to pull an address." });
    const authHeader = rpcAuthHeader({ user, pass, cookiePath });
    if (!authHeader) return json(200, { ok: false, error: "Enter your node's RPC username and password." });
    const at = ["legacy", "p2sh-segwit", "bech32", "bech32m"].includes(p.address_type) ? p.address_type : "bech32";
    const r = await nodeGetNewAddress(rpcUrl, authHeader, at);
    json(200, r.ok ? { ok: true, address: r.address } : { ok: false, error: r.error });
  });
}

// ---- detect an existing node (so node-runners are auto-recognized instead of typing RPC details) ----
// Best-effort: probe a default-cookie node on localhost. A node with explicit rpcuser/rpcpassword and no
// cookie can't be auto-authed, so it falls back to manual entry — we never guess credentials.
async function detectExistingNode() {
  const cookie = resolveCookiePath("");
  if (!cookie) return { found: false };
  const authHeader = rpcAuthHeader({ cookiePath: cookie });
  if (!authHeader) return { found: false };
  const r = await testRpc("http://127.0.0.1:8332", authHeader);
  return r.ok ? { found: true, rpc_url: "http://127.0.0.1:8332", chain: r.info && r.info.chain, syncing: !!(r.info && r.info.initialblockdownload) } : { found: false };
}

// ---- managed node: provision + run a private Bitcoin Core, then point the miner at it ----
async function startManagedNode() {
  if (managed) return;
  managedLog = []; lastLogKey = "";
  managed = NodeLifecycle.createManagedNode({ dataRoot: DATA_DIR, onState: (s) => { managedState = s; logManaged(s); } });
  try {
    await managed.start(); // download → verify → launch → snapshot → first sync sample
    // The node is reachable now (still syncing). Wire its RPC into config and start the BRIDGE so
    // the dashboard shows the live blockchain-sync animation while we wait — the bridge's RPCs all
    // work during IBD. The miner waits for `mineable` (getblocktemplate fails during IBD anyway).
    wireManagedRpcConfig();
    if (!procs.bridge) startEngine("bridge");
    const tick = async () => {
      if (!managed) return;
      let s = null;
      try { s = await managed.sync(); } catch (_) { /* node still warming up */ }
      if (s && s.mineable) return onManagedReady();
      setTimeout(tick, 5000);
    };
    tick();
  } catch (e) {
    managedState = { state: "error", detail: (e && e.message) || String(e) };
    logManaged(managedState);
  }
}
// Write the managed node's RPC connection (localhost cookie auth) into config.json so the engines reach it.
function wireManagedRpcConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    Object.assign(cfg, managed.rpcConfig(), { mode: "live" });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (_) {}
}
// Node is synced enough to mine → make sure config is current and start the miner. The bridge is
// already running from the sync phase, so only the miner is added here.
function onManagedReady() {
  wireManagedRpcConfig();
  enginesStarted = true;
  if (!procs.miner) startEngine("miner");
}
// The wizard's "Set one up for me" choice: save intent + payout, then kick off provisioning (progress via /node-status).
function handleNodeSetup(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    const free = freeBytes(DATA_DIR); // disk preflight — don't start a download we can't finish
    if (free != null && free < REQUIRED_FREE_BYTES) return json(200, { ok: false, error: `Not enough free disk space — a node needs about ${gb(REQUIRED_FREE_BYTES)} GB and you have ${gb(free)} GB free. Free up some space and try again.` });
    let existing = {}; try { existing = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    const cfg = {
      ...existing, version: 1, mode: "live", node_mode: "managed",
      payout_address: (p.payout_address || "").trim(),
      coinbase_tag: (p.coinbase_tag || existing.coinbase_tag || "").trim().slice(0, 90),
    };
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); }
    catch (_) { return json(200, { ok: false, error: "Couldn't save settings." }); }
    startManagedNode();
    json(200, { ok: true });
  });
}

// Toggle launch-on-login from the settings UI — persists the choice and applies it immediately.
function handleAutoStart(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    cfg.auto_start = !!p.enabled;
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) { return json(200, { ok: false }); }
    applyAutoStart(cfg); // register/unregister the login item now, not just on next launch
    json(200, { ok: true });
  });
}

// Remove the managed node entirely (stop it, delete Core + datadir + snapshot, reset to first-run).
async function removeManagedNode() {
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
  if (cfg.node_mode !== "managed" && !managed) return; // never wipe a user's external config
  try { if (managed) await managed.stop(); } catch (_) {}
  managed = null; managedState = { state: "idle", progress: null, detail: null };
  stopEngines(); enginesStarted = false; stopping = false; // allow a fresh start after reconfigure
  try { fs.rmSync(NodeProvision.managedPaths(DATA_DIR).node, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(configPath(), { force: true }); } catch (_) {} // back to the first-run wizard
}
function handleNodeRemove(req, res) {
  removeManagedNode().finally(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); });
}
// Retry: tear down the (failed) attempt and start provisioning fresh.
async function retryManagedNode() {
  try { if (managed) await managed.stop(); } catch (_) {}
  managed = null; managedState = { state: "idle", progress: null, detail: null };
  startManagedNode();
}

// ---- static server: the dashboard, the wizard, the bridge's live node.json, and the setup POST ----
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (req.method === "POST" && urlPath === "/setup") { handleSetup(req, res); return; }
      if (req.method === "POST" && urlPath === "/node-address") { handleNodeAddress(req, res); return; }
      if (req.method === "POST" && urlPath === "/node-setup") { handleNodeSetup(req, res); return; }
      if (req.method === "POST" && urlPath === "/node-remove") { handleNodeRemove(req, res); return; }
      if (req.method === "POST" && urlPath === "/auto-start") { handleAutoStart(req, res); return; }
      if (req.method === "POST" && urlPath === "/node-retry") { retryManagedNode().finally(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); }); return; }
      if (urlPath === "/disk") { const free = freeBytes(DATA_DIR); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ freeGB: free == null ? null : gb(free), requiredGB: gb(REQUIRED_FREE_BYTES), ok: free == null || free >= REQUIRED_FREE_BYTES })); return; }
      if (urlPath === "/detect-node") { detectExistingNode().then((r) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(r)); }).catch(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"found":false}'); }); return; }
      if (urlPath === "/node-status") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ ...managedState, log: managedLog.slice(-60) })); return; }
      if (urlPath === "/setup") { fs.readFile(WIZARD, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(d); } }); return; }
      if (urlPath === "/config") { // current settings for the wizard to pre-fill (NEVER the password — only whether one is set)
        let cfg = null; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
        const out = cfg ? { exists: true, payout_address: cfg.payout_address || "", rpc_url: cfg.rpc_url || "http://127.0.0.1:8332", rpc_user: cfg.rpc_user || "", rpc_datadir: cfg.rpc_datadir || "", coinbase_tag: cfg.coinbase_tag || "", node_mode: cfg.node_mode || "external", has_rpc_pass: !!cfg.rpc_pass, uses_cookie: !!cfg.rpc_cookie, auto_start: cfg.auto_start !== false } : { exists: false };
        out.app_version = app.getVersion(); // surfaced on the dashboard + wizard so support can identify the build
        out.platform = process.platform; // lets the dashboard word the close/quit note per-OS (tray on Windows, ⌘Q on macOS)
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

// ---- Windows system tray: lets the app keep the node + miner running after the window is closed,
// matching macOS's "closing keeps it running" behavior. Mac keeps its dock; Windows gets a tray. ----
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  else createWindow();
}
function createTray() {
  if (process.platform !== "win32" || tray) return;
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 }); // ICON is 1024² → shrink for the tray
  tray = new Tray(img.isEmpty() ? ICON : img);
  tray.setToolTip("Bitcoin Lottery — mining in the background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showMainWindow },
    { type: "separator" },
    { label: "Quit Bitcoin Lottery", click: () => { isQuitting = true; app.quit(); } }, // the only way to really stop mining on Windows
  ]));
  tray.on("double-click", showMainWindow);
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
  // Windows: the X button hides to the tray and keeps the node + miner running in the background
  // (like macOS keeping the app in the dock). Only the tray's Quit / menu Exit really stops it.
  win.on("close", (e) => { if (process.platform === "win32" && !isQuitting) { e.preventDefault(); win.hide(); } });
  // open http(s)/mailto links (terms, support email) in the user's browser/mail client, not a new app window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // first run → wizard. Managed mode → setup screen too, so the install progress is visible
  // (the wizard redirects to the dashboard once the node is ready).
  let startPath = "/setup";
  if (fs.existsSync(configPath())) { let c = {}; try { c = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {} startPath = c.node_mode === "managed" ? "/setup" : "/"; }
  win.loadURL(`http://127.0.0.1:${port}${startPath}`);
}

// Auto-start on login so mining resumes after a reboot (the "set it and forget it" promise). Registers a
// per-user login item — HKCU \Run on Windows, a LaunchAgent on macOS, ~/.config/autostart on Linux. Default
// on; a user can disable it via the `auto_start` setting. We launch with --hidden so a reboot opens it into
// the tray (mining starts headless; the window is one tray click away) instead of popping a window each boot.
const bootHidden = process.argv.includes("--hidden");
function applyAutoStart(cfg) {
  const enabled = !cfg || cfg.auto_start !== false; // default ON
  try { app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ["--hidden"] }); }
  catch (_) { /* best effort — unsupported platform just won't autostart */ }
}

// Single-instance lock: the app survives window-close in the tray (Windows), so a second launch must
// just reveal the running instance — never spin up a second miner + managed node (which would clash on
// the RPC port). The secondary process exits immediately; the primary focuses its window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.whenReady().then(() => {
    DATA_DIR = app.getPath("userData"); // the app's own isolated config/state/node.json
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
    NODE_JSON = path.join(DATA_DIR, "node.json");
    ENGINE_ENV = { ...process.env, LOTTERY_DATA_DIR: DATA_DIR, NODE_BRIDGE_OUT: NODE_JSON };
    if (process.platform === "win32") ENGINE_ENV.PYTHONUTF8 = "1"; // belt-and-suspenders for DEV (real python3): engines print ₿/→ and a Windows pipe defaults to cp1252 → UnicodeEncodeError. NOTE: PyInstaller-frozen exes IGNORE this env var, so the packaged engines force UTF-8 in their own source (sys.std*.reconfigure).
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    applyAutoStart(cfg); // keep the login item in sync with the setting on every launch
    if (fs.existsSync(configPath())) { // configured already → mine; otherwise the wizard sets it up
      if (cfg.node_mode === "managed") startManagedNode(); // provision/resume our own node, then start engines when it's mineable
      else startEngines();
    }
    buildMenu();
    createTray(); // tray icon: reachable after a hidden/boot launch, and closing the window keeps mining
    if (!bootHidden) createWindow(); // boot autostart opens into the tray; a normal launch shows the window
    initAutoUpdate();
  });
}
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); // dock click → reopen window
app.on("before-quit", () => { isQuitting = true; stopEngines(); if (managed) managed.stop().catch(() => {}); }); // ⌘Q / tray Quit / real quit → stop mining (+ our node)
// On macOS, closing the window keeps the miner running in the background (app stays in the dock; reopen
// from the dock). On Windows, the window hides to the tray (same effect). Only Linux quits on last close.
app.on("window-all-closed", () => { if (process.platform !== "darwin" && process.platform !== "win32") { stopEngines(); app.quit(); } });
