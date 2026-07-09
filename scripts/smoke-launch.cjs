#!/usr/bin/env node
// smoke-launch.cjs — launch the freshly-BUILT packaged app with NOTZERO_SMOKE=1 and assert it starts without
// crashing. Reaching app.whenReady (past every top-level require + init) makes main.js print NOTZERO_SMOKE_OK and
// exit 0; a startup crash (like 0.1.30's missing ots-verify.js) exits non-zero or never prints the marker. This
// catches ANY launch failure — the thing the static asar check can't see. Run after build, before publish.
// Exit 1 on failure. Usage: node scripts/smoke-launch.cjs [explicit-binary-path]

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const DESKTOP = path.join(__dirname, "..", "desktop");
const DIST = path.join(DESKTOP, "dist");
const TIMEOUT_MS = 60000;

function firstDir(names) { for (const n of names) { const p = path.join(DIST, n); if (fs.existsSync(p)) return p; } return null; }

// locate the unpacked executable electron-builder produced for this platform (explicit arg wins, for local tests)
function findApp() {
  if (process.argv[2]) return { cmd: process.argv[2], args: [], xvfb: false };
  if (process.platform === "darwin") {
    const macDir = firstDir(["mac-universal", "mac-arm64", "mac", "mac-x64"]);
    if (macDir) {
      const appName = fs.readdirSync(macDir).find((f) => f.endsWith(".app"));
      if (appName) return { cmd: path.join(macDir, appName, "Contents", "MacOS", appName.replace(/\.app$/, "")), args: [], xvfb: false };
    }
  } else if (process.platform === "win32") {
    const d = path.join(DIST, "win-unpacked");
    if (fs.existsSync(d)) { const exe = fs.readdirSync(d).find((f) => f.toLowerCase().endsWith(".exe")); if (exe) return { cmd: path.join(d, exe), args: [], xvfb: false }; }
  } else {
    const d = path.join(DIST, "linux-unpacked");
    if (fs.existsSync(d)) {
      const bin = fs.readdirSync(d).find((f) => { try { const s = fs.statSync(path.join(d, f)); return s.isFile() && !f.includes(".") && (s.mode & 0o111); } catch { return false; } });
      if (bin) return { cmd: path.join(d, bin), args: ["--no-sandbox"], xvfb: true }; // CI has no display + runs as root
    }
  }
  return null;
}

const target = findApp();
if (!target) { console.error("smoke-launch: no built app found under desktop/dist — build first"); process.exit(2); }

let cmd = target.cmd, args = target.args.slice();
if (target.xvfb) { args = ["-a", cmd, ...args]; cmd = "xvfb-run"; } // linux: run under a virtual X display

console.log("-> smoke launch: " + cmd + " " + args.join(" "));
const child = cp.spawn(cmd, args, { env: { ...process.env, NOTZERO_SMOKE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let out = "", done = false;
const finish = (code, msg) => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch (_) {} if (code === 0) console.log("\n✓ " + msg); else console.error("\n❌ " + msg); process.exit(code); };

child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
child.on("error", (e) => finish(1, "smoke test could not launch the app: " + e.message));
child.on("exit", (code, signal) => {
  const seen = /NOTZERO_SMOKE_OK/.test(out);
  if (code === 0 && seen) finish(0, "smoke test: the packaged app launched and reached ready without crashing");
  else finish(1, "smoke test FAILED — exit code=" + code + " signal=" + signal + ", NOTZERO_SMOKE_OK " + (seen ? "seen" : "MISSING"));
});
const timer = setTimeout(() => finish(1, "smoke test TIMED OUT (" + TIMEOUT_MS / 1000 + "s) — the app didn't start + exit cleanly"), TIMEOUT_MS);
