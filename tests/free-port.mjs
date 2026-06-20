// Run by the Playwright webServer command BEFORE it starts python's http.server, so the port is free.
// We only ever kill THIS project's stale test server: a `python -m http.server 8799` whose working
// directory is this repo. Anything else on 8799 (another app) is left alone — python will then fail to
// bind and Playwright reports it loudly, which is the right outcome. Never kills other apps' servers.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8799;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let pids = [];
try { pids = sh(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`).split(/\s+/).filter(Boolean); } catch { pids = []; }
for (const pid of pids) {
  let cmd = "";
  try { cmd = sh(`ps -o command= -p ${pid}`).trim(); } catch { continue; }
  let cwd = "";
  try { cwd = sh(`lsof -a -p ${pid} -d cwd -Fn`).split("\n").find((l) => l.startsWith("n"))?.slice(1) || ""; } catch {}
  if (cmd.includes("http.server") && cmd.includes(String(PORT)) && cwd === repoRoot) {
    try { process.kill(Number(pid), "SIGTERM"); console.log(`[free-port] killed our stale test server on :${PORT} (pid ${pid})`); } catch {}
  } else {
    console.warn(`[free-port] :${PORT} held by pid ${pid} — not ours (${cmd.slice(0, 70)}), leaving it. The server will fail to bind.`);
  }
}
