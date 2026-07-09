#!/usr/bin/env node
// check-asar-requires.cjs — GATE run after the electron-builder build, before publishing.
//
// Every local module reachable via require("./x") from the app entry (package.json "main") MUST be present in
// the built app.asar. If a new module is added to the code but NOT to package.json > build.files, electron-builder
// silently ships an app without it and the app crashes at launch — e.g. 0.1.30 died on
//   Error: Cannot find module './ots-verify.js'
// because ots-verify.js wasn't in build.files. CI never launches the app, so nothing caught it. This static check
// walks the require graph from the SOURCE and asserts each module is actually inside the packaged asar. Exit 1 on
// any miss so a broken package can never reach R2. Usage: node scripts/check-asar-requires.cjs [path/to/app.asar]

const fs = require("fs");
const path = require("path");
const DESKTOP = path.join(__dirname, "..", "desktop");

// 1) locate app.asar (explicit arg wins; otherwise search desktop/dist — any built copy is representative,
//    since all platforms pack from the same build.files)
function findAsar() {
  if (process.argv[2]) return process.argv[2];
  const stack = [path.join(DESKTOP, "dist")];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === "app.asar") return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}
const asarPath = findAsar();
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error("check-asar-requires: no app.asar found under desktop/dist — run the build first");
  process.exit(2);
}

// 2) list what's actually inside the asar
let inAsar;
try {
  const asar = require(require.resolve("@electron/asar", { paths: [path.join(DESKTOP, "node_modules")] }));
  inAsar = new Set(asar.listPackage(asarPath).map((f) => f.replace(/^[\\/]+/, "").split(path.sep).join("/")));
} catch (e) {
  console.error("check-asar-requires: could not read the asar via @electron/asar:", e && e.message);
  process.exit(2);
}

// 3) walk the local require() graph from the entry (parsing source on disk), assert every module is packaged
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
const entry = pkg.main || "main.js";
const seen = new Set();
const missing = [];
function resolveLocal(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const cand of [base, base + ".js", base + ".cjs", path.join(base, "index.js")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}
function walk(absFile) {
  const rel = path.relative(DESKTOP, absFile).split(path.sep).join("/");
  if (seen.has(rel)) return;
  seen.add(rel);
  if (!inAsar.has(rel)) { missing.push(rel + " (not in app.asar)"); return; }
  const src = fs.readFileSync(absFile, "utf8");
  const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const dep = resolveLocal(path.dirname(absFile), m[2]);
    if (!dep) { missing.push(rel + ' → require("' + m[2] + '") — source file not found'); continue; }
    walk(dep);
  }
}
walk(path.join(DESKTOP, entry));

const rel = path.relative(process.cwd(), asarPath);
if (missing.length) {
  console.error("\n❌ app.asar is missing required local module(s) — add them to desktop/package.json > build.files:");
  for (const x of missing) console.error("   - " + x);
  console.error("\n   checked: " + rel + "\n");
  process.exit(1);
}
console.log("✓ asar require check: all " + seen.size + " local modules reachable from " + entry + " are packaged (" + rel + ")");
