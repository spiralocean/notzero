// Phase 2b (step 1) — first-run setup wizard.
//
// On first launch (no config yet) the window shows wizard.html: enter a payout address and connect to a
// node (your running bitcoind via RPC, or "just practice"). On submit, we write config.json into the
// app's data dir and start the engine (miner + bridge), then the window goes to the dashboard. On later
// launches config already exists, so we start the engine and go straight to the dashboard.
//
// The engine runs as standalone PyInstaller binaries when packaged (no Python on the user's machine),
// or via python3 in dev. The dashboard (../web) is reused unchanged, served over a loopback HTTP server.

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, Notification, dialog, powerMonitor, screen, globalShortcut, powerSaveBlocker } = require("electron");
const https = require("https");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Last line of defense against a bad build: if startup itself throws (a packaging bug the CI asar-gate + smoke
// test somehow missed), don't die silently — Electron is a browser, so show a local page telling the user to
// reinstall the latest version. Scoped to STARTUP: once the app is up, a later runtime hiccup just gets logged
// (it must NOT pop a "reinstall" window). In CI smoke mode, exit non-zero so the launch test flags the crash.
let startupComplete = false;
function showStartupError(err) {
  try { console.error("[notzero] STARTUP ERROR:", (err && err.stack) || err); } catch (_) {}
  if (startupComplete) return;
  if (process.env.NOTZERO_SMOKE === "1") { try { app.exit(1); } catch (_) { process.exit(1); } return; }
  const open = () => { try {
    const w = new BrowserWindow({ width: 560, height: 480, resizable: false, title: "notzero needs reinstalling", webPreferences: { contextIsolation: true } });
    if (w.removeMenu) w.removeMenu();
    w.loadFile(path.join(__dirname, "error.html")).catch(() => {});
    w.webContents.setWindowOpenHandler(({ url }) => { try { shell.openExternal(url); } catch (_) {} return { action: "deny" }; }); // download link opens in the real browser
  } catch (_) {} };
  try { if (app.isReady()) open(); else app.whenReady().then(open); } catch (_) {}
}
process.on("uncaughtException", showStartupError);
process.on("unhandledRejection", showStartupError);

const NodeLifecycle = require("./node-lifecycle"); // managed-node provisioning (Phases 1–2)
const NodeProvision = require("./node-provision");
const { autoUpdater } = require("electron-updater"); // background auto-update from dl.getnotzero.com
const crypto = require("node:crypto");
// on-chain (OpenTimestamps) update verification against the local node — OPTIONAL. Guard the require so a
// missing/broken module can never crash startup (0.1.30 shipped without ots-verify.js and died on launch). If it
// can't load, fall back to benign no-op stubs ("unchecked" / no proof) so verification just degrades to
// "unverified" and the app keeps running — and can therefore still auto-update itself out of a bad build.
let verifyAgainstNode = async () => ({ status: "unchecked", reason: "ots-verify unavailable" });
let parseProof = () => ({ bitcoin: [] });
try { const m = require("./ots-verify.js"); verifyAgainstNode = m.verifyAgainstNode; parseProof = m.parseProof; }
catch (e) { console.error("[notzero] ots-verify unavailable — on-chain update verification disabled:", e && e.message); }

const REQUIRED_FREE_BYTES = 25 * 1024 ** 3; // ~25 GB headroom for snapshot + pruned chain + load-time peak
// Free bytes on the volume holding `dir` (null if it can't be determined → don't block).
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (_) { return null; }
}
const gb = (b) => Math.round(b / 1024 ** 3);

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web");
const ICON = path.join(__dirname, "assets", "icon.png");
const WIZARD = path.join(__dirname, "wizard.html");

// DEV-ONLY dashboard preview: `NOTZERO_PREVIEW=<state> npm start` renders the real desktop shell against the
// working-tree web/, with a fixture node.json for a chosen node state — so the dashboard's startup/syncing/
// no-peers/at-tip UX can be seen and verified without a live bitcoind or the python engines. Never active in a
// packaged build. States: "downloading"/"snapshot"/"starting"/"error" (managed setup phases, node not up yet —
// narrated from the /node-status feed), "syncing" (IBD, few peers), "no-peers" (reachable, zero peers), "at-tip"
// (synced — the bundled sample). Any other value falls back to "at-tip".
const PREVIEW = !app.isPackaged && process.env.NOTZERO_PREVIEW ? process.env.NOTZERO_PREVIEW.trim() : null;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon",
};

let DATA_DIR, NODE_JSON, ENGINE_ENV, serverPort = null, mainWindow = null;
let tray = null, isQuitting = false; // Windows + Linux: window close hides to tray (keeps mining); only Quit sets isQuitting
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
      { label: "Ambient View", accelerator: isMac ? "Cmd+Shift+A" : "Ctrl+Shift+A", click: () => openAmbient(true) },
      { label: "Ambient View (Debug Numbers)", click: () => openAmbient(true, true) }, // opens with the on-screen size readout + canvas markers — no config edit needed

      { type: "separator" }, isMac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Check for Updates…", click: () => checkForUpdatesNow() },
      { label: "Release Notes", click: () => shell.openExternal("https://getnotzero.com/changelog") },
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

// ---- Ambient view ("The Deep" / Rain) + optional lock-on-wake -------------------
// Idle-triggered full-screen canvas (web/ambient.html, served from WEB_DIR). No
// .saver bundle: reuses the app's own window, so it behaves the same on
// mac/win/linux and can reach the node over the local server origin. All opt-in.
let ambientWindow = null, ambientPoll = null, ambientShownAt = 0, ambientManual = false, ambientBlockerId = null;

// config.json: { ambient: { enabled, idleSeconds, lockOnWake } }
function ambientCfg() {
  let c = {}; try { c = (JSON.parse(fs.readFileSync(configPath(), "utf8")).ambient) || {}; } catch (_) {}
  return {
    enabled: c.enabled === true,                                            // default OFF
    idleSeconds: Number(c.idleSeconds) > 0 ? Number(c.idleSeconds) : 300,   // 5 min
    lockOnWake: c.lockOnWake === true,                                      // default OFF — never lock by surprise
    macHardLock: c.macHardLock === true,                                   // macOS only: force the lock screen via ⌃⌘Q (asks a one-time permission). default OFF → quiet display-sleep, no prompt
    style: c.style === "rain" ? "rain" : "breath",                         // which ambient view
    debug: c.debug === true,                                                // default OFF — on-screen canvas/dpr/screen readout for diagnosing scaled-display sizing
  };
}

// App-triggered lock: a real lock, but only as reliable as the app running — "tidy up when I step
// away", not a secure lock. On macOS the DEFAULT is a quiet display-sleep (no permission prompt);
// the ⌃⌘Q force-lock is opt-in (macHardLock) because it triggers a scary "control System Events" prompt.
function lockScreen() {
  try {
    if (process.platform === "darwin") {
      if (ambientCfg().macHardLock)
        // Force the lock screen via ⌃⌘Q — needs a one-time Automation/Accessibility grant; fall back to display sleep.
        spawn("sh", ["-c", "osascript -e 'tell application \"System Events\" to keystroke \"q\" using {control down, command down}' || pmset displaysleepnow"], { stdio: "ignore" }).unref();
      else
        // Default: sleep the display — NO permission prompt; locks when "Require password after… the display is turned off" is set.
        spawn("pmset", ["displaysleepnow"], { stdio: "ignore" }).unref();
    } else if (process.platform === "win32")
      spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { stdio: "ignore" }).unref();
    else
      spawn("sh", ["-c", "loginctl lock-session || xdg-screensaver lock || gnome-screensaver-command -l"], { stdio: "ignore" }).unref();
  } catch (_) {}
}

function openAmbient(manual, forceDebug) {
  if (ambientWindow) return;
  ambientManual = !!manual; // manual (menu ⌘⇧A) preview: dismiss on input, but never auto-close or lock
  // Size to the display's LOGICAL bounds (main-process screen.* is reliably DIP) and DO NOT call the fullscreen
  // methods. On scaled/HiDPI displays setSimpleFullScreen/setFullScreen were ballooning the page's canvas to larger
  // than the visible screen (content anchors top-left → the sphere fell off the bottom-right; two prior fixes that
  // tried to *detect* this from the renderer failed because Electron's window.screen mis-reports there). A plain
  // window sized to the logical bounds simply cannot exceed the screen, so the renderer's innerWidth is the true
  // visible width and the sphere centres correctly — on every display. Trade-off on macOS: the menu bar (and Dock,
  // if not auto-hidden) stay visible as a thin strip rather than full-screen immersion.
  const b = screen.getPrimaryDisplay().bounds; // cover the primary display (DIP)
  ambientWindow = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, useContentSize: true, // content area == the logical display, exactly
    frame: false, backgroundColor: "#05070d", skipTaskbar: true,
    alwaysOnTop: true, // FLOATING level only (default) — deliberately NOT "screen-saver", so Force Quit / the app switcher / system UI can always appear above it
    webPreferences: { contextIsolation: true }, // self-contained page; no node integration
  });
  ambientWindow.setAlwaysOnTop(true, "floating");
  // Tell the OS the display is in use, so its OWN screensaver / display-sleep doesn't fire on top of ours (that
  // stacking is what let the system screensaver take over the view). Released in dismissAmbient.
  try { if (ambientBlockerId === null) ambientBlockerId = powerSaveBlocker.start("prevent-display-sleep"); } catch (_) {}
  // Full-screen presentation — covers the menu bar / Dock (macOS) and the taskbar (Windows) for a true screensaver.
  // The earlier off-screen sphere was NOT the window size: it was a retina canvas bug (a <canvas> with only inset:0
  // renders at its dpr× bitmap size — 2× too big). That's fixed in the renderer now, so the sphere centres in
  // fullscreen. Escape hatches below (any key / blur / idle poller) still guarantee you can never get stuck.
  if (process.platform === "darwin") ambientWindow.setSimpleFullScreen(true);
  else ambientWindow.setFullScreen(true);
  // A GLOBAL Escape while the view is open — so Esc dismisses even if the window lost keyboard focus (e.g. after an
  // OS screensaver/lock cycle). Tied to the window lifecycle (unregistered on close) so it can never leak.
  try { globalShortcut.register("Escape", () => dismissAmbient()); } catch (_) {}
  ambientWindow.on("closed", () => { ambientWindow = null; try { globalShortcut.unregister("Escape"); } catch (_) {} });
  // Escape hatches so the view can NEVER trap you: any key, losing focus (Cmd+Tab / click-away / Mission Control), and the idle poller.
  ambientWindow.webContents.on("before-input-event", (_e, input) => { if (input.type === "keyDown") dismissAmbient(); });      // any key = a wake → may lock
  ambientWindow.on("blur", () => { if (Date.now() - ambientShownAt > 800) dismissAmbient(true); });                          // focus loss (Cmd+Tab) → dismiss but never lock (longer grace so the fullscreen transition doesn't self-dismiss)
  ambientWindow.webContents.on("did-fail-load", (_e, code, desc, url) => { console.error(`[notzero] ambient view failed to load: ${code} ${desc} ${url}`); });
  ambientShownAt = Date.now();
  const cfg = ambientCfg();
  const page = cfg.style === "rain" ? "ambient-rain.html" : "ambient.html"; // The Deep (swarm→coin) or Matrix rain
  const q = (cfg.debug || forceDebug) ? "?debug=1" : ""; // config `ambient.debug:true` or the debug menu item → on-screen size readout + canvas markers
  const url = serverPort ? `http://127.0.0.1:${serverPort}/${page}${q}` : null;
  console.log(`[notzero] ambient view opening (${manual ? "manual" : "idle"}, ${page}${q}) → ${url || path.join(WEB_DIR, page)}`);
  if (url) ambientWindow.loadURL(url); // same origin → reads the node feed
  else ambientWindow.loadFile(path.join(WEB_DIR, page), q ? { search: "debug=1" } : undefined).catch((err) => console.error("[notzero] ambient loadFile failed:", err));
}

function dismissAmbient(forceNoLock) {
  if (!ambientWindow) return;
  const shouldLock = !forceNoLock && !ambientManual && ambientCfg().lockOnWake; // lock an idle-triggered wake (any input), never a manual preview
  const w = ambientWindow; ambientWindow = null;
  try { if (ambientBlockerId !== null && powerSaveBlocker.isStarted(ambientBlockerId)) powerSaveBlocker.stop(ambientBlockerId); } catch (_) {} // let the OS screensaver/display-sleep resume normally
  ambientBlockerId = null;
  try { w.setAlwaysOnTop(false); } catch (_) {} // drop the always-on-top level FIRST so it can never keep blocking Cmd+Tab / other apps
  try { if (process.platform === "darwin" && w.isSimpleFullScreen && w.isSimpleFullScreen()) w.setSimpleFullScreen(false); } catch (_) {} // exit the fullscreen presentation so the menu bar/Dock return
  try { w.close(); } catch (_) {}
  try { if (!w.isDestroyed()) w.destroy(); } catch (_) {} // force it gone even if close() was swallowed mid screensaver/lock — never leave a stuck window
  if (shouldLock) { lockScreen(); return; }
  // restore the menu bar/Dock: focus a normal window, or (background app with none) yield focus to the previous app
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.focus();
    else if (process.platform === "darwin") app.hide();
  } catch (_) {}
}

// One poller drives everything: opens the ambient view after N idle seconds, and
// dismisses it (optionally locking) the instant the user touches anything.
// getSystemIdleTime() is system-wide, so showing the window doesn't reset it.
function startAmbientWatch() {
  if (ambientPoll) return;
  // The OS's OWN screensaver / password lock / sleep can engage on top of the ambient view (especially a manual one,
  // which never auto-dismisses). blur doesn't fire reliably for those, so the always-on-top window could be left
  // stuck after unlock — keyboard-unreachable, blocking Cmd+Tab. These power events DO fire reliably: dismiss on any
  // of them so unlock/wake is always clean. forceNoLock — the OS already handled locking; we just get out of the way.
  ["lock-screen", "unlock-screen", "suspend", "resume"].forEach((ev) => {
    try { powerMonitor.on(ev, () => dismissAmbient(true)); } catch (_) {}
  });
  ambientPoll = setInterval(() => {
    const cfg = ambientCfg();
    const idle = powerMonitor.getSystemIdleTime();
    if (ambientWindow) {
      // idle-opened: dismiss on any real input (screensaver behavior). manual preview stays until Esc/⌘W — never
      // auto-dismisses on mouse move, so you can actually look at it.
      if (!ambientManual && idle < 2 && Date.now() - ambientShownAt > 1200) dismissAmbient(); // wake → dismissAmbient decides on the lock
    } else if (cfg.enabled && idle >= cfg.idleSeconds) {
      openAmbient(false); // idle-triggered
    }
  }, 1000);
}

// Full-window overlay injected into the dashboard while an update installs, so the restart reads as an
// intentional update regardless of OS notification permission. Built via DOM (no HTML-attribute quoting).
function updatingOverlayJs(version) {
  const vtxt = version ? `updating to v${version}` : "installing the update";
  return `(function(){
    if(document.getElementById('nz-update-overlay'))return;
    var mk=function(css){var e=document.createElement('div');e.style.cssText=css;return e;};
    var o=mk('position:fixed;inset:0;z-index:2147483647;background:rgba(8,6,12,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff');
    o.id='nz-update-overlay';
    var sp=mk('width:46px;height:46px;border:3px solid rgba(255,160,40,0.25);border-top-color:#FF9E22;border-radius:50%;animation:nzspin .8s linear infinite');
    var t1=mk('margin-top:22px;font-size:18px;font-weight:700');t1.textContent='Installing update';
    var t2=mk('margin-top:8px;font-size:13px;opacity:.7;text-align:center;max-width:340px;line-height:1.5');t2.innerHTML='notzero is restarting to finish ${vtxt}.<br>Mining resumes automatically.';
    var st=document.createElement('style');st.textContent='@keyframes nzspin{to{transform:rotate(360deg)}}';document.head.appendChild(st);
    o.appendChild(sp);o.appendChild(t1);o.appendChild(t2);document.body.appendChild(o);
  })();`;
}

// ---- auto-update: check the dl.getnotzero.com feed on launch + every few hours.
// DEFAULT (auto_update on): download in the background and install on quit, so a published fix reaches every
// install fast. If the user turns auto-update OFF in Settings, we switch to NOTIFY-ONLY: we tell them a
// version is available but never download or install on our own — they trigger it from Menu → Check for
// Updates. This gives the security-conscious the wheel without punishing everyone else. No-op in dev. ----
function autoUpdateOn() { try { return JSON.parse(fs.readFileSync(configPath(), "utf8")).auto_update !== false; } catch (_) { return true; } } // default ON
function verifyUpdatesOn() { try { return JSON.parse(fs.readFileSync(configPath(), "utf8")).verify_updates !== false; } catch (_) { return true; } } // default ON — only ever BLOCKS on a definitive mismatch
let updateAvailableVer = null, updateManual = false, notifiedVer = null, pendingUpdateVer = null;
let updateDownloading = false, updateDownloadPct = 0; // live download state → the dashboard turns the pill into a "Downloading… X%" status
let lastUpdateVerification = null, currentVersionAnchor = null, updateHistory = null; // surfaced on the dashboard's VERIFIED UPDATES section

// Build a JSON-RPC caller bound to the saved node credentials (null if we can't). Used to verify update proofs.
function nodeRpcFromConfig() {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) { return null; }
  const rpcUrl = (cfg.rpc_url || "http://127.0.0.1:8332").trim();
  const cookiePath = cfg.rpc_cookie ? resolveCookiePath(cfg.rpc_datadir || "") : "";
  const authHeader = rpcAuthHeader({ user: cfg.rpc_user || "", pass: cfg.rpc_pass || "", cookiePath });
  if (!authHeader) return null;
  return (m, p) => rpcCall(rpcUrl, authHeader, m, p);
}

// Is the node answering RPC right now? A cheap liveness probe — not a sync check. Returns false while bitcoind is
// still starting (no creds/cookie yet, connection refused, or the -28 "warming up" error), true once it responds.
async function nodeReachable() {
  const rpc = nodeRpcFromConfig();
  if (!rpc) return false;
  try { const r = await rpc("uptime", []); return !!(r && r.ok); } catch (_) { return false; }
}

// After a reboot bitcoind can take a while to accept RPC. Poll (bounded, with backoff) until it answers, so the
// first on-chain update check doesn't stamp "unchecked — node offline?" on a node that's merely still starting.
// Resolves true once reachable, or false when the budget elapses — callers proceed either way (the 30-min
// interval retries regardless, and a truly-offline node then reports offline honestly).
async function waitForNodeReachable(budgetMs = 300000) {
  const deadline = Date.now() + budgetMs;
  for (let wait = 2000; ; wait = Math.min(wait * 1.5, 15000)) {
    if (await nodeReachable()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(wait, left)));
  }
}

// Fetch a small file from the download CDN — utf8 string, or a Buffer when binary. null on any failure.
function fetchDl(name, binary) {
  return new Promise((resolve) => {
    const req = https.get("https://dl.getnotzero.com/" + name, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", () => resolve(null)); req.setTimeout(9000, () => { req.destroy(); resolve(null); });
  });
}

// Verify a downloaded update against the anchored SHA256SUMS + the local node. Never throws. Returns { level, ... }:
//   onchain    hash matches AND the checksum file is confirmed in a block the node validated  → { height, blockTime }
//   pending    hash matches; the on-chain proof isn't block-confirmed yet (recent release)
//   checksums  hash matches; couldn't confirm on-chain (no node / node behind)
//   unverified couldn't check (checksums not published, or artifact not in the anchored set — e.g. the mac .zip)
//   mismatch   DANGER — the download's hash isn't the published one, or the proof commits to the wrong block
async function verifyUpdateArtifact(version, filePath) {
  try {
    const sums = (await fetchDl("SHA256SUMS-" + version)) || (await fetchDl("SHA256SUMS"));
    const ots = (await fetchDl("SHA256SUMS-" + version + ".ots", true)) || (await fetchDl("SHA256SUMS.ots", true));
    if (!sums || !ots) return { level: "unverified", version, detail: "checksums not published" };
    const artHash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    const base = path.basename(filePath);
    const line = sums.split("\n").map((l) => l.trim()).find((l) => l && l.split(/\s+/).pop() === base);
    if (!line) return { level: "unverified", version, detail: base + " isn't in the anchored set" }; // don't block — e.g. mac .zip before it's covered
    if (line.split(/\s+/)[0] !== artHash) return { level: "mismatch", version, detail: "download hash does not match the published checksum" };
    const rpc = nodeRpcFromConfig();
    if (!rpc) return { level: "checksums", version, detail: "hash verified; no node to confirm on-chain" };
    const v = await verifyAgainstNode(ots, crypto.createHash("sha256").update(sums).digest("hex"), rpc);
    if (v.status === "verified") return { level: "onchain", version, height: v.height, blockTime: v.blockTime, detail: "confirmed in Bitcoin block " + v.height };
    if (v.status === "mismatch") return { level: "mismatch", version, detail: v.reason };
    if (v.status === "pending") return { level: "pending", version, detail: "hash verified; on-chain confirmation pending" };
    return { level: "checksums", version, detail: "hash verified; on-chain check inconclusive" };
  } catch (_) { return { level: "unverified", version, detail: "verification error" }; }
}

// Badge for the RUNNING version: is its published checksum file confirmed on-chain yet? (verifies the proof
// against the node; doesn't re-hash the installed binary). Refreshed on startup + periodically.
async function refreshCurrentVersionAnchor() {
  const version = app.getVersion();
  try {
    const sums = await fetchDl("SHA256SUMS-" + version), ots = await fetchDl("SHA256SUMS-" + version + ".ots", true);
    if (!sums || !ots) { currentVersionAnchor = { version, level: "unverified" }; return; }
    const rpc = nodeRpcFromConfig();
    if (!rpc) { currentVersionAnchor = { version, level: "unchecked" }; return; }
    const v = await verifyAgainstNode(ots, crypto.createHash("sha256").update(sums).digest("hex"), rpc);
    const level = v.status === "verified" ? "onchain" : v.status === "pending" ? "pending" : v.status === "mismatch" ? "mismatch" : "unchecked";
    currentVersionAnchor = { version, level, height: v.height, blockTime: v.blockTime };
  } catch (_) { currentVersionAnchor = { version, level: "unchecked" }; }
}

// Build the "verified releases" history for the dashboard: take the recent versions from the changelog, and for
// each that has a published proof, confirm it against your node (newest first). Refreshed alongside the anchor.
async function refreshUpdateHistory() {
  try {
    const md = await fetchDl("CHANGELOG.md");
    if (!md) return;
    const seen = new Set(), versions = [];
    for (const m of md.matchAll(/^##\s+v?(\d+\.\d+\.\d+)\b/gm)) { if (!seen.has(m[1])) { seen.add(m[1]); versions.push(m[1]); } if (versions.length >= 6) break; }
    const rpc = nodeRpcFromConfig(), cur = app.getVersion(), hist = [];
    for (const v of versions) {
      const ots = await fetchDl("SHA256SUMS-" + v + ".ots", true);
      if (!ots) { hist.push({ version: v, level: "none", current: v === cur }); continue; } // released before on-chain anchoring
      let level = "unchecked", height, blockTime, r = null;
      if (rpc) { try { r = await verifyAgainstNode(ots, null, rpc); } catch (_) {} }
      if (r && (r.status === "verified" || r.status === "pending" || r.status === "mismatch")) {
        level = r.status === "verified" ? "onchain" : r.status === "pending" ? "pending" : "mismatch"; height = r.height; blockTime = r.blockTime;
      } else { // no node yet / inconclusive → show the proof's OWN anchored block now; upgrades to node-confirmed on the next refresh
        try { const p = parseProof(ots); if (p.bitcoin.length) { level = "anchored"; height = p.bitcoin[0].height; } else level = "pending"; } catch (_) {}
      }
      hist.push({ version: v, level, height, blockTime, current: v === cur });
    }
    updateHistory = hist;
  } catch (_) {}
}
const SITE_CHANGELOG_URL = "https://getnotzero.com/changelog";
const CHANGELOG_URLS = ["https://dl.getnotzero.com/CHANGELOG.md", "https://raw.githubusercontent.com/spiralocean/notzero/main/CHANGELOG.md"];

// Fetch a URL as UTF-8 text (follows one redirect); tries each URL in turn, cb(text|null). Best-effort — a
// failed changelog fetch just means the dialog shows a generic line, never an error.
function fetchTextAny(urls, cb, i) {
  i = i || 0;
  if (i >= urls.length) return cb(null);
  try {
    const req = https.get(urls[i], (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return fetchTextAny([new URL(res.headers.location, urls[i]).toString()], cb); }
      if (res.statusCode !== 200) { res.resume(); return fetchTextAny(urls, cb, i + 1); }
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => { d += c; if (d.length > 300000) res.destroy(); }); res.on("end", () => cb(d));
    });
    req.on("error", () => fetchTextAny(urls, cb, i + 1));
    req.setTimeout(6000, () => req.destroy());
  } catch (_) { fetchTextAny(urls, cb, i + 1); }
}
function cmpVer(a, b) { const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; }
// Pull the changelog sections for every version in (fromVer, toVer] — so a user who skipped releases sees ALL
// the changes they got, not just the newest. Returns readable plain text for a dialog.
function changelogSince(md, fromVer, toVer) {
  const out = []; let capture = false;
  for (const ln of String(md).split(/\r?\n/)) {
    const m = ln.match(/^##\s+v?(\d+\.\d+\.\d+)\b/);
    if (m) { capture = cmpVer(m[1], fromVer) > 0 && cmpVer(m[1], toVer) <= 0; if (capture) out.push(`◆ v${m[1]}`); continue; }
    if (/^##\s+/.test(ln)) { capture = false; continue; } // "Unreleased" / any other header ends a section
    if (capture) out.push(ln.replace(/\*\*/g, "").replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^###\s+/, "").replace(/^-\s+/, "  • ").replace(/^\s\s-\s+/, "     • ")); // also strip backticks + flatten [text](url) → text so notes read cleanly in a native dialog
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// A "what's new" dialog: fetch the changelog for (fromVer, toVer], show it with the given buttons, resolve the
// chosen index. Shared by the pre-install choice and the post-update recap.
function whatsNewDialog({ fromVer, toVer, title, buttons, extraDetail }) {
  return new Promise((resolve) => {
    fetchTextAny(CHANGELOG_URLS, (md) => {
      let notes = md ? changelogSince(md, fromVer, toVer) : "";
      // macOS AND Linux (GTK) showMessageBox do NOT scroll a long `detail` — the dialog grows past the screen and
      // the Update/Cancel buttons fall off the bottom out of reach. Only Windows scrolls. So cap by LINE COUNT on
      // mac + Linux so the dialog always fits; "See Full Notes" opens the complete changelog. Windows stays looser.
      const compact = process.platform !== "win32", maxLines = compact ? 13 : 44, maxChars = compact ? 1000 : 1800;
      let lines = notes.split("\n"), clipped = false;
      if (lines.length > maxLines) { lines = lines.slice(0, maxLines); clipped = true; }
      notes = lines.join("\n");
      if (notes.length > maxChars) { notes = notes.slice(0, maxChars).replace(/\n[^\n]*$/, ""); clipped = true; }
      if (clipped) notes = notes.replace(/\s+$/, "") + "\n  … — tap “See Full Notes” for everything since your version";
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const opts = { type: "info", noLink: true, title, message: title, detail: (notes ? notes + "\n\n" : "") + (extraDetail || ""), buttons, defaultId: 0, cancelId: buttons.length - 1 };
      try { (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => resolve(r.response)).catch(() => resolve(-1)); }
      catch (_) { resolve(-1); }
    });
  });
}
// Record that the user has already seen a version's release notes, so the post-update recap doesn't repeat them.
function markVersionSeen(v) { if (!v) return; try { const c = JSON.parse(fs.readFileSync(configPath(), "utf8")); c.last_seen_version = v; fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), { mode: 0o600 }); } catch (_) {} }
// Pre-install "what's new" + explicit Update/Later choice. Shown ONLY on an explicit action (Check for Updates, or
// clicking the in-app "update available" pill) — never unsolicited; the pill is the passive notice.
// Push a signal straight into the dashboard so update feedback is INSTANT instead of waiting for its next
// /config poll (which can be up to 90s away before it observes any update state). Safe no-op if the window
// is gone or the hook isn't defined yet.
function pokeUpdateUI(fn) { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.executeJavaScript(`window.${fn} && window.${fn}()`).catch(() => {}); } catch (_) {} }

function promptUpdateDialog(info) {
  const target = (info && info.version) || updateAvailableVer || "", cur = app.getVersion();
  whatsNewDialog({ fromVer: cur, toVer: target, title: `notzero ${target} is available` + (cur ? `  (you're on ${cur})` : ""), buttons: ["Update Now", "See Full Notes", "Later"], extraDetail: "Update now? notzero downloads it, restarts, and resumes mining automatically." })
    .then((r) => { if (r === 0) { markVersionSeen(target); updateDownloading = true; updateDownloadPct = 0; pokeUpdateUI("__notzeroUpdateStarting"); autoUpdater.downloadUpdate().catch(() => { updateDownloading = false; }); } else if (r === 1) shell.openExternal(SITE_CHANGELOG_URL); }); // Update Now → flip the pill to a "Preparing/Downloading…" status IMMEDIATELY, then start the download
}
function initAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = autoUpdateOn();
  autoUpdater.on("error", () => { updateDownloading = false; }); // a failed update check must never bother the user (but clear the "downloading" status)
  autoUpdater.on("download-progress", (p) => { updateDownloading = true; updateDownloadPct = Math.max(0, Math.min(100, Math.floor((p && p.percent) || 0))); }); // drives the in-app "Downloading… X%" status
  autoUpdater.on("update-available", (info) => {
    updateAvailableVer = info && info.version ? info.version : "";
    pendingUpdateVer = updateAvailableVer;                      // drives the persistent in-app "update available" pill
    const wasManual = updateManual; updateManual = false;
    if (wasManual) { pokeUpdateUI("__notzeroPokeConfig"); promptUpdateDialog(info); return; } // explicit "Check for Updates" / pill click → what's new + Update/Later choice (poke so the dashboard fast-polls right away)
    if (autoUpdateOn()) return;                                 // auto mode background: autoDownload installs on quit
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return; // app OPEN → the in-app "update available" pill IS the notice; never pop an unsolicited dialog
    // app closed / in the tray → one OS notification per version (persisted, so no every-2-hours nag), pointing at the pill
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    if (updateAvailableVer && (updateAvailableVer === notifiedVer || cfg.last_notified_version === updateAvailableVer)) return;
    notifiedVer = updateAvailableVer;
    try { cfg.last_notified_version = updateAvailableVer; fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) {}
    try { if (Notification.isSupported()) new Notification({ title: "notzero update available", body: `Version ${updateAvailableVer} is ready. Open notzero → the “Update available” banner (or Help → Check for Updates).` }).show(); } catch (_) {}
  });
  autoUpdater.on("update-not-available", () => { pendingUpdateVer = null; if (updateManual) { updateManual = false; try { if (Notification.isSupported()) new Notification({ title: "notzero is up to date", body: "You're already on the latest version." }).show(); } catch (_) {} } });
  autoUpdater.on("update-downloaded", async (info) => {
    updateDownloading = false; updateDownloadPct = 100; // download done — the "installing/restarting" overlay takes over from here
    const ver = info && info.version ? info.version : "";
    // Verify the download against the anchored SHA256SUMS + your node before installing. This does NOT wait for the
    // on-chain proof to confirm (that can take hours) — it installs on a checksum match and shows on-chain status
    // when available; it only BLOCKS on a definitive mismatch. electron-updater's signed feed is the baseline gate.
    let verdict = null;
    if (info && info.downloadedFile) { try { verdict = await verifyUpdateArtifact(ver, info.downloadedFile); } catch (_) {} }
    lastUpdateVerification = verdict || { level: "unverified", version: ver };
    if (verdict && verdict.level === "mismatch" && verifyUpdatesOn()) {
      try { if (Notification.isSupported()) new Notification({ title: "notzero — update blocked", body: `The downloaded ${ver ? "v" + ver : "update"} failed verification and was NOT installed.` }).show(); } catch (_) {}
      try { dialog.showMessageBox({ type: "warning", title: "Update not installed", message: `notzero ${ver} failed verification`, detail: "The download's fingerprint didn't match the checksum published for this release, so it was not installed. Please re-download from getnotzero.com.", buttons: ["OK"] }); } catch (_) {}
      return; // do not install a download we can't vouch for
    }
    try { if (Notification.isSupported()) new Notification({ title: "Updating notzero", body: `Installing ${ver ? "v" + ver : "the latest version"} — restarting in a moment.` }).show(); } catch (_) {}
    try { if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.webContents.executeJavaScript(updatingOverlayJs(ver)).catch(() => {}); } catch (_) {}
    // isQuitting FIRST: quitAndInstall() closes the window BEFORE firing before-quit, and win.on("close") hides
    // (doesn't quit) the window on macOS unless isQuitting is set — so without this the app never terminates and
    // Squirrel's ShipIt hangs forever waiting to swap the bundle (the 0.1.33→0.1.34 mac auto-update stall).
    setTimeout(() => { try { isQuitting = true; autoUpdater.quitAndInstall(); } catch (_) {} }, 6000); // a beat longer so the message is readable before the relaunch
  });
  const check = () => { autoUpdater.autoDownload = autoUpdateOn(); autoUpdater.checkForUpdates().catch(() => {}); }; // re-read the pref each check so a toggle takes effect
  check();
  setInterval(check, 2 * 60 * 60 * 1000); // every 2 hours
}
// Menu → "Check for Updates…": always show WHAT'S NEW with an Update/Later choice (autoDownload off so nothing
// installs until the user picks Update Now). update-not-available → a quiet "up to date" toast.
function checkForUpdatesNow() { if (!app.isPackaged) return; updateManual = true; autoUpdater.autoDownload = false; autoUpdater.checkForUpdates().catch(() => { updateManual = false; }); }
// After an auto-update, on the next visible launch, recap what changed since the version the user last saw —
// once per version, and only if they haven't turned it off. Never creates a config file (that would skip the
// first-run wizard), and stays quiet in dev / boot-to-tray.
function maybeShowWhatsNew() {
  if (!app.isPackaged) return;
  if (!fs.existsSync(configPath())) return; // not configured yet → nothing to recap, and don't create config
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) { return; }
  const cur = app.getVersion(), seen = cfg.last_seen_version || null;
  const writeSeen = () => { try { cfg.last_seen_version = cur; fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) {} };
  if (!seen) { writeSeen(); return; }                       // baseline the first time — no recap for the update that added this
  if (cmpVer(cur, seen) <= 0) return;                       // no update since last launch
  if (cfg.show_whats_new === false) { writeSeen(); return; } // user opted out
  writeSeen();
  whatsNewDialog({ fromVer: seen, toVer: cur, title: `Updated to notzero ${cur} — what's new`, buttons: ["Got it", "See Full Notes"], extraDetail: "You can turn these off in Settings → “Show what's new after updates.”" })
    .then((r) => { if (r === 1) shell.openExternal(SITE_CHANGELOG_URL); });
}

// ---- OS notifications for mining events ----
// Fired from the MAIN process (not the renderer) so they reach the user even when the dashboard window is
// closed/in the tray — which is exactly when notifications matter. Watches the bridge's node.json and
// notifies on transitions, each event gated by its own setting (master switch: notifications_enabled).
let notifyState = null;  // {winHeight, bestBits} baseline for one-shot events — null until first read
let syncNotified = null; // the synced state we last notified about (null = baseline not set yet)
let syncCand = null;     // {synced, since} — a candidate sync state still waiting out the debounce
let warnNotified = null; // last node warning text we notified about (null = baseline not set yet) — one-shot on change
// A node can briefly drop and regain sync; a blip that recovers within a block doesn't threaten "one hash
// per block", so sync notifications only fire once the new state has HELD for this long (flaps are ignored).
const SYNC_NOTIFY_DELAY_MS = 5 * 60 * 1000;
// Miner liveness watchdog: the engine's exit-handler only respawns a CRASHED miner; a HUNG one (alive but no longer
// logging tickets) would sit stalled forever. Restart it if it's been silent too long while the node is synced.
let lastMinerKick = 0;
const MINER_KICK_COOLDOWN_MS = 5 * 60 * 1000; // after a restart, give it time to spin up + log a ticket before considering another
function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) {}
}
function startNotifier() {
  const tick = () => {
    let node; try { node = JSON.parse(fs.readFileSync(NODE_JSON, "utf8")); } catch (_) { return; } // no node.json yet → nothing to watch
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    const m = node.miner; // null when the node was unreachable past the bridge's grace window — see below
    const tipTime = node.tip_time || 0;
    const stale = tipTime ? (Date.now() / 1000 - tipTime) > 90 * 60 : false; // tip too old (e.g. just woke) → not really caught up yet
    const synced = node.reachable !== false && !node.initialblockdownload && (node.headers || 0) <= (node.blocks || 0) && !stale;
    const on = cfg.notifications_enabled !== false; // master switch

    // --- one-shot events (win / new best): fire immediately on transition ---
    // Only advance/compare when we actually have miner data. A node.json with no `miner` key (node down past
    // grace, e.g. sleep/wake) would otherwise read bestBits=0, poison the baseline, and re-fire "new best" the
    // moment the real value reappears. `best` is monotonic upstream, so carrying the baseline forward is safe.
    if (m) {
      const ws = m.win_status || {};
      const winHeight = ws.status === "confirmed" ? (ws.height || 0) : 0; // a win only counts once confirmed
      const bestBits = (m.best && m.best.zero_bits) || 0;
      const prev = notifyState;
      notifyState = { winHeight, bestBits }; // advance the baseline (only on real data) so master-off never backlogs
      if (prev !== null && on) {
        if (cfg.notify_block_won !== false && winHeight > prev.winHeight) {
          notify("🎯 You found a block!", `Block #${winHeight.toLocaleString()} is yours — confirmed on the chain.`);
        }
        // Fire on every zero-BIT gained (matching the dashboard's nibble gauge), not just whole leading-"0"
        // jumps. The miner takes one attempt per block, so best improves every few days — per-bit is a rare,
        // meaningful milestone, never spam, and a whole-hex-char threshold would skip weeks between alerts.
        // Stay quiet below the first whole "0" (bits 1–3) so the very first attempts don't notify.
        if (cfg.notify_closeness_above_zero !== false && bestBits > prev.bestBits && bestBits >= 4) {
          const hz = Math.floor(bestBits / 4), rem = bestBits % 4, tail = rem ? ` (+${rem}/4 toward the next)` : "";
          notify("📈 New best", `Your closest hash yet: ${hz} leading “0”${hz === 1 ? "" : "s"}${tail}.`);
        }
      }
    }

    // --- sync state: DEBOUNCED so brief flaps don't notify ---
    if (syncNotified === null) { syncNotified = synced; syncCand = null; }       // baseline, no notify
    else if (synced === syncNotified) { syncCand = null; }                       // reverted to the known state → cancel pending flip
    else {
      if (!syncCand || syncCand.synced !== synced) syncCand = { synced, since: Date.now() }; // start/refresh the candidate
      else if (Date.now() - syncCand.since >= SYNC_NOTIFY_DELAY_MS) {            // held long enough → it's real
        if (on) {
          if (synced && cfg.notify_node_synced !== false) notify("✅ Node synced", "Caught up — mining the current block.");
          else if (!synced && cfg.notify_node_out_of_sync !== false) notify("⚠️ Node out of sync", "Your node has been behind for a while. Mining resumes once it's caught up.");
        }
        syncNotified = synced; syncCand = null;                                  // advance even if master-off (no backlog)
      }
    }

    // --- consensus canary: the bridge sets `consensus_alert` only when an unknown rule has LOCKED IN / ACTIVATED
    // (Core's "unknown new rules activated"; signalling-only noise is already filtered out) → the network adopted
    // rules this node doesn't understand, so an app update is likely needed. One-shot on change (a persistent
    // alert must not re-fire every 5s). ---
    const warn = (node.consensus_alert || "").trim();
    if (warnNotified === null) { warnNotified = warn; }        // baseline on first read — don't notify for a pre-existing warning at launch
    else if (warn !== warnNotified) {
      warnNotified = warn;
      if (warn && on && cfg.notify_consensus_change !== false) {
        notify("⚠️ Your node flagged a network change", "Bitcoin Core reports rules it doesn't recognize — an app update may be needed. Open notzero to check.");
      }
    }

    // --- miner liveness watchdog: restart a HUNG miner (same staleness test the dashboard's pill uses) ---
    // Only when synced and we have a real ticket timestamp; a missing timestamp is "first moments", not a stall.
    const at = m && m.attempt ? Date.parse(m.attempt.attempted_at || "") : NaN;
    if (synced && isFinite(at)) {
      const ageSec = (Date.now() - at) / 1000;
      const tipAge = tipTime ? Date.now() / 1000 - tipTime : Infinity;
      const stalled = ageSec > 1200 && ageSec > tipAge + 600; // >20 min old AND >10 min older than the tip → blocks moved on but the miner didn't
      if (stalled && Date.now() - lastMinerKick > MINER_KICK_COOLDOWN_MS) {
        lastMinerKick = Date.now();
        console.warn(`[notzero] miner stalled (last ticket ${Math.round(ageSec / 60)}m ago, node synced) — restarting the miner engine`);
        try { if (procs.miner) procs.miner.kill(); } catch (_) {} // exit handler respawns it (~2s) with current config; no-op if it already crashed/respawned
      }
    }
  };
  setInterval(tick, 5000);
  tick();
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
function reapStaleEngines() {
  // Kill engine processes left over from a PRIOR app instance (orphaned by an in-place update or crash) BEFORE
  // we spawn fresh ones. An old-version orphan predates the bridge's lockfile, so it would keep writing
  // node.json and flicker the dashboard. Belt-and-suspenders alongside that lockfile.
  if (!app.isPackaged) return; // dev runs python3 directly — never pkill the developer's own processes
  try {
    const { execFileSync } = require("node:child_process");
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='miner.exe' OR Name='bridge.exe'\" | Where-Object { $_.ExecutablePath -like '*\\engine\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: "ignore", timeout: 5000 });
    } else {
      for (const n of ["miner", "bridge"]) { try { execFileSync("pkill", ["-f", `engine/${n}`], { stdio: "ignore", timeout: 5000 }); } catch (_) {} } // pkill exits 1 when nothing matches — ignore
    }
  } catch (_) {}
}
function startEngines() { if (enginesStarted) return; enginesStarted = true; reapStaleEngines(); startEngine("miner"); startEngine("bridge"); }
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
      auto_update: existing.auto_update != null ? existing.auto_update : true,
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
// Toggle auto-update from the settings UI. The updater re-reads this on every check, so it takes effect on the
// next check with no restart. OFF → notify-only: we tell the user about updates but never install on our own.
function handleAutoUpdatePref(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    cfg.auto_update = !!p.enabled;
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) { return json(200, { ok: false }); }
    json(200, { ok: true });
  });
}

// Toggle the post-update "what's new" recap from the settings UI (read on the next launch after an update).
function handleWhatsNewPref(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    cfg.show_whats_new = !!p.enabled;
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) { return json(200, { ok: false }); }
    json(200, { ok: true });
  });
}

// Persist the ambient-view preferences. The idle poller reads config each tick, so changes take effect
// within a second — enabling/disabling, retiming, or toggling lock-on-wake needs no restart.
function handleAmbientConfig(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    const a = cfg.ambient || {};
    if ("enabled" in p) a.enabled = !!p.enabled;
    if ("idleSeconds" in p) a.idleSeconds = Math.max(10, Math.min(3600, Number(p.idleSeconds) || 300)); // clamp 10s–1h
    if ("lockOnWake" in p) a.lockOnWake = !!p.lockOnWake;
    if ("macHardLock" in p) a.macHardLock = !!p.macHardLock;
    if ("style" in p) a.style = p.style === "rain" ? "rain" : "breath";
    cfg.ambient = a;
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) { return json(200, { ok: false }); }
    json(200, { ok: true });
  });
}

// Toggle the master notifications switch from the settings UI. The notifier reads config each tick, so
// the change takes effect within seconds — no restart, nothing else to do here.
function handleNotifications(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on("end", () => {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p; try { p = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: "bad request" }); }
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    cfg.notifications_enabled = !!p.enabled;
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch (_) { return json(200, { ok: false }); }
    json(200, { ok: true });
  });
}
// Fire a real notification so the user can confirm OS-level delivery (and trigger the macOS permission prompt).
// `isSupported()` is true even when macOS permission is denied, so seeing the toast is the real test — if it's
// supported but nothing appears, the OS is blocking it (Settings → Notifications / Focus).
function handleNotificationTest(req, res) {
  const supported = (() => { try { return Notification.isSupported(); } catch (_) { return false; } })();
  if (supported) { try { new Notification({ title: "🔔 Test notification", body: "Notifications are working. You'll get these for node synced, a new best hash, and a block won — even with the window closed." }).show(); } catch (_) {} }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, supported }));
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

// ---- DEV preview fixtures (only reached when PREVIEW is set) ----
// The /config response that makes the dashboard render in desktop mode (gear, update pill, scale) without a real
// config file. node_mode "managed" is the case the startup messaging matters most for (the app runs the node).
function previewConfig() {
  return {
    exists: true, node_mode: "managed", platform: process.platform, app_version: app.getVersion(),
    payout_address: "bc1qpreviewpreviewpreviewpreviewpreviewpv0", rpc_url: "http://127.0.0.1:8332",
    has_rpc_pass: true, uses_cookie: false, auto_start: true, notifications_enabled: true, auto_update: true,
    show_whats_new: true, update_available: "", update_verification: null, version_anchor: null, update_history: null,
  };
}
// A node.json for the chosen state, built by mutating the bundled sample (web/node.json) so every panel still has
// realistic mempool/best/history data — only reachability, heights and peers change per state.
function previewNodeJson() {
  let base = {}; try { base = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "node.json"), "utf8")); } catch (_) {}
  const tip = base.headers || 957800, nowS = Math.floor(Date.now() / 1000);
  const peers = Array.isArray(base.peers) ? base.peers : [];
  // pre-reachable managed-setup phases → node not answering RPC yet; the /node-status feed drives the narration
  if (["starting", "downloading", "snapshot", "error"].includes(PREVIEW)) return { ts: nowS, reachable: false };
  if (PREVIEW === "no-peers") return { ...base, reachable: true, headers: tip, blocks: tip - 6, initialblockdownload: true, verificationprogress: 0.9998, tip_time: nowS - 3600, peers: [] };
  if (PREVIEW === "syncing") return { ...base, reachable: true, headers: tip, blocks: tip - 6, initialblockdownload: true, verificationprogress: 0.9998, tip_time: nowS - 3600, peers: peers.slice(0, 3).map((p, i) => ({ ...p, rate: i < 2 ? 3_000_000 : 0, downloading: i < 2 })) };
  return base; // "at-tip" / default: the synced sample as-is
}
// The managed-node provisioning feed (/node-status) for a preview state, so the dashboard narrates a real setup
// phase (download → snapshot % → syncing → error). "ready" for states where the live node.json already drives it.
function previewNodeStatus() {
  if (PREVIEW === "downloading") return { state: "downloading-core", progress: 0.6, detail: null };
  if (PREVIEW === "snapshot") return { state: "loading-snapshot", progress: 0.42, detail: "Loading the snapshot into your node — the heavy step, a few minutes. Please leave the app open." };
  if (PREVIEW === "starting") return { state: "starting", progress: null, detail: null };
  if (PREVIEW === "error") return { state: "error", progress: null, detail: "Couldn't reach the download server — check your internet and reopen the app to retry." };
  return { state: "ready", progress: 1, detail: null };
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
      if (req.method === "POST" && urlPath === "/auto-update") { handleAutoUpdatePref(req, res); return; }
      if (req.method === "POST" && urlPath === "/whats-new") { handleWhatsNewPref(req, res); return; }
      if (req.method === "POST" && urlPath === "/ambient-config") { handleAmbientConfig(req, res); return; }
      if (req.method === "POST" && urlPath === "/ambient-open") { openAmbient(true); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return; } // the dashboard's ambient-view button
      if (req.method === "POST" && urlPath === "/update/check") { checkForUpdatesNow(); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return; } // the in-app "update available" pill → show the what's-new / install choice
      if (req.method === "POST" && urlPath === "/notifications") { handleNotifications(req, res); return; }
      if (req.method === "POST" && urlPath === "/notifications/test") { handleNotificationTest(req, res); return; }
      if (req.method === "POST" && urlPath === "/node-retry") { retryManagedNode().finally(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); }); return; }
      if (urlPath === "/disk") { const free = freeBytes(DATA_DIR); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ freeGB: free == null ? null : gb(free), requiredGB: gb(REQUIRED_FREE_BYTES), ok: free == null || free >= REQUIRED_FREE_BYTES })); return; }
      if (urlPath === "/detect-node") { detectExistingNode().then((r) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(r)); }).catch(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"found":false}'); }); return; }
      if (urlPath === "/node-status") { if (PREVIEW) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(previewNodeStatus())); return; } res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ ...managedState, log: managedLog.slice(-60) })); return; }
      if (urlPath === "/setup") { fs.readFile(WIZARD, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(d); } }); return; }
      if (urlPath === "/config") { // current settings for the wizard to pre-fill (NEVER the password — only whether one is set)
        if (PREVIEW) { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(previewConfig())); return; }
        let cfg = null; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
        const out = cfg ? { exists: true, payout_address: cfg.payout_address || "", rpc_url: cfg.rpc_url || "http://127.0.0.1:8332", rpc_user: cfg.rpc_user || "", rpc_datadir: cfg.rpc_datadir || "", coinbase_tag: cfg.coinbase_tag || "", node_mode: cfg.node_mode || "external", has_rpc_pass: !!cfg.rpc_pass, uses_cookie: !!cfg.rpc_cookie, auto_start: cfg.auto_start !== false, notifications_enabled: cfg.notifications_enabled !== false, auto_update: cfg.auto_update !== false, show_whats_new: cfg.show_whats_new !== false, ambient: cfg.ambient || {}, update_available: pendingUpdateVer || "" } : { exists: false };
        out.app_version = app.getVersion(); // surfaced on the dashboard + wizard so support can identify the build
        out.update_download = updateDownloading ? { percent: updateDownloadPct } : null; // live download progress → the pill shows "Downloading… X%" instead of a clickable "Update available"
        out.update_verification = lastUpdateVerification; // a downloaded update's verdict (or null) — VERIFIED UPDATES section
        out.version_anchor = currentVersionAnchor; // the running version's on-chain status (or null)
        out.update_history = updateHistory; // recent releases + their on-chain verification (newest first) — VERIFIED UPDATES list
        out.platform = process.platform; // lets the dashboard word the close/quit note per-OS (tray on Windows, ⌘Q on macOS)
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(out)); return;
      }
      if (urlPath === "/node.json") { // live data from the bridge's writable output, not the read-only bundle
        if (PREVIEW) { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(previewNodeJson())); return; }
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

// ---- Windows + Linux system tray: lets the app keep the node + miner running after the window is closed,
// matching macOS's "closing keeps it running" behavior. Mac keeps its dock; Windows/Linux get a tray. ----
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  else createWindow();
}
function createTray() {
  if (process.platform === "darwin" || tray) return; // Windows + Linux get a tray; macOS keeps its dock
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 }); // ICON is 1024² → shrink for the tray
  try { tray = new Tray(img.isEmpty() ? ICON : img); } catch (_) { tray = null; return; } // headless / no-tray env: leave tray null so window-all-closed can fall back to quitting
  tray.setToolTip("Bitcoin Lottery — mining in the background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showMainWindow },
    { type: "separator" },
    { label: "Quit Bitcoin Lottery", click: () => { isQuitting = true; app.quit(); } }, // the only way to really stop mining
  ]));
  tray.on("double-click", showMainWindow);
  tray.on("click", showMainWindow); // single click reopens too (some Linux DEs don't fire double-click)
}
// On Linux the desktop's tray may be hidden (e.g. GNOME without the AppIndicator extension), so on the first
// window close tell the user it's still running — otherwise it looks like the app vanished.
let bgNotified = false;
function notifyBackgroundOnce() {
  if (bgNotified || process.platform !== "linux") return;
  bgNotified = true;
  try { new Notification({ title: "Bitcoin Lottery is still mining", body: "It's running in the background. Reopen it from the tray, or just launch the app again. To stop mining, choose Quit from the tray." }).show(); } catch (_) {}
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
  // Closing the window HIDES it (never destroys) and keeps the node + miner running in the background — Windows +
  // Linux to the tray, macOS in the dock. Hiding (vs destroying) is what lets a reopen restore the exact window
  // size + position (and scroll/state). Only tray Quit / menu Exit / ⌘Q (isQuitting) actually closes it.
  win.on("close", (e) => { if (!isQuitting && (tray || process.platform === "darwin")) { e.preventDefault(); win.hide(); notifyBackgroundOnce(); } });
  // open http(s)/mailto links (terms, support email) in the user's browser/mail client, not a new app window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // first run → wizard. Managed mode → setup screen too, so the install progress is visible
  // (the wizard redirects to the dashboard once the node is ready).
  let startPath = "/setup";
  if (PREVIEW) startPath = "/"; // dev preview always lands on the dashboard
  else if (fs.existsSync(configPath())) { let c = {}; try { c = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {} startPath = c.node_mode === "managed" ? "/setup" : "/"; }
  win.loadURL(`http://127.0.0.1:${port}${startPath}`);
}

// Auto-start on login so mining resumes after a reboot (the "set it and forget it" promise). Registers a
// per-user login item — HKCU \Run on Windows, a LaunchAgent on macOS, ~/.config/autostart on Linux. Default
// on; a user can disable it via the `auto_start` setting. We launch with --hidden so a reboot opens it into
// the tray (mining starts headless; the window is one tray click away) instead of popping a window each boot.
const bootHidden = process.argv.includes("--hidden");
function applyAutoStart(cfg) {
  const enabled = !cfg || cfg.auto_start !== false; // default ON
  if (process.platform === "linux") { applyAutoStartLinux(enabled); return; } // Electron's setLoginItemSettings is a no-op on Linux — do it ourselves
  try { app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ["--hidden"] }); }
  catch (_) { /* best effort — unsupported platform just won't autostart */ }
}
// Linux has no login-item API in Electron, so write/remove a freedesktop autostart entry directly. Use $APPIMAGE
// (the stable AppImage path) — process.execPath inside an AppImage points at a temp FUSE mount that changes each run.
function applyAutoStartLinux(enabled) {
  try {
    const file = path.join(os.homedir(), ".config", "autostart", "notzero.desktop");
    if (!enabled) { try { fs.unlinkSync(file); } catch (_) {} return; }
    const exec = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Bitcoin Lottery",
      "Comment=Resume mining on login",
      `Exec="${exec}" --hidden`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"));
  } catch (_) { /* best effort */ }
}

// Single-instance lock: the app survives window-close in the tray (Windows + Linux), so a second launch must
// just reveal the running instance — never spin up a second miner + managed node (which would clash on
// the RPC port). The secondary process exits immediately; the primary focuses its window.
if (!app.requestSingleInstanceLock()) {
  // Hard exit, NOT app.quit(): before whenReady on Linux/AppImage a graceful quit can leave the outer AppImage
  // runtime process hung (holding its FUSE mount), so relaunching the tray-resident app piles up orphaned
  // launcher shims — which later trip needrestart's "obsolete binaries / relogin required" notice. exit(0) is
  // immediate and lets the runtime tear down cleanly.
  app.exit(0);
} else {
  app.on("second-instance", showMainWindow);
  app.whenReady().then(() => {
    if (process.env.NOTZERO_SMOKE === "1") { console.log("NOTZERO_SMOKE_OK"); app.exit(0); return; } // CI launch smoke test: reaching here means every top-level require + init succeeded; exit cleanly BEFORE any side effects (engine/node/window). A startup crash never prints this and exits non-zero.
    DATA_DIR = app.getPath("userData"); // the app's own isolated config/state/node.json
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
    NODE_JSON = path.join(DATA_DIR, "node.json");
    ENGINE_ENV = { ...process.env, LOTTERY_DATA_DIR: DATA_DIR, NODE_BRIDGE_OUT: NODE_JSON };
    if (process.platform === "win32") ENGINE_ENV.PYTHONUTF8 = "1"; // belt-and-suspenders for DEV (real python3): engines print ₿/→ and a Windows pipe defaults to cp1252 → UnicodeEncodeError. NOTE: PyInstaller-frozen exes IGNORE this env var, so the packaged engines force UTF-8 in their own source (sys.std*.reconfigure).
    if (PREVIEW) { console.log(`[notzero] PREVIEW mode: "${PREVIEW}" — dashboard only, no engines/node`); buildMenu(); createWindow(); startupComplete = true; return; } // dev preview: skip engines, node provisioning, update checks — just render the dashboard against the fixture
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch (_) {}
    applyAutoStart(cfg); // keep the login item in sync with the setting on every launch
    if (fs.existsSync(configPath())) { // configured already → mine; otherwise the wizard sets it up
      if (cfg.node_mode === "managed") startManagedNode(); // provision/resume our own node, then start engines when it's mineable
      else startEngines();
    }
    buildMenu();
    createTray(); // tray icon: reachable after a hidden/boot launch, and closing the window keeps mining
    startAmbientWatch(); // idle-triggered ambient view — a no-op unless enabled in Settings
    if (!bootHidden) { createWindow(); setTimeout(maybeShowWhatsNew, 2000); } // normal launch: show window, then recap what changed after an auto-update
    initAutoUpdate();
    refreshUpdateHistory(); // populate the dashboard list ASAP from the published proofs (seconds) — don't make users stare at an empty section while the node boots
    (async () => { await waitForNodeReachable(); refreshCurrentVersionAnchor(); refreshUpdateHistory(); })(); // then re-confirm each release against your just-booted node (upgrades "anchored" → node-verified)
    setInterval(refreshCurrentVersionAnchor, 30 * 60 * 1000); // running version's on-chain badge; re-check so a pending proof flips to confirmed
    setInterval(refreshUpdateHistory, 30 * 60 * 1000); // verified-releases list for the dashboard
    startNotifier(); // OS notifications for block won / new best / node sync changes
    startupComplete = true; // past here, an uncaught error is a runtime hiccup (just log it) — not a reason to show the reinstall page
  });
}
app.on("activate", () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } else createWindow(); }); // dock click → show the existing (hidden) window, preserving its size/position; only build a new one if none exists
app.on("before-quit", () => { isQuitting = true; stopEngines(); if (managed) managed.stop().catch(() => {}); }); // ⌘Q / tray Quit / real quit → stop mining (+ our node)
// macOS keeps the app in the dock; Windows + Linux hide to the tray — in all three the miner keeps running and
// only the tray Quit / menu Exit / ⌘Q stops it. We only quit here as a fallback: no tray could be created
// (headless / unsupported desktop), so there'd be nothing to reopen from.
app.on("window-all-closed", () => { if (process.platform !== "darwin" && !tray) { stopEngines(); app.quit(); } });
