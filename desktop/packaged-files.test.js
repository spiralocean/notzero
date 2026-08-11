// Tests for the packaging whitelist — run: node --test desktop/packaged-files.test.js
//
// build.files in desktop/package.json is an explicit allowlist, so ADDING A MODULE IS NOT ENOUGH: a new
// require("./x.js") that nobody adds there gets silently left out of app.asar and the app dies at launch with
// "Cannot find module". That shipped once as 0.1.30 (ots-verify.js), which is why
// scripts/check-asar-requires.cjs exists.
//
// That gate is authoritative but it needs a completed electron-builder build, so it only ever fails in CI —
// as it just did for window-bounds.js and ambient-wake.js, two dry runs and ~10 minutes of build after the
// mistake was made. This is the same question asked of the SOURCE alone: every local module reachable from
// the entry point must appear in build.files. Runs in milliseconds with `node --test`, catches it before push.
// It does NOT replace the packaging gate — only that one proves what actually ended up inside the asar.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
const entry = pkg.main || "main.js";

function resolveLocal(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const cand of [base, base + ".js", base + ".cjs", path.join(base, "index.js")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

// Every local module reachable via require("./…") from the entry point, as repo-relative paths.
function reachableModules() {
  const seen = new Set();
  const unresolved = [];
  (function walk(absFile) {
    const rel = path.relative(DESKTOP, absFile).split(path.sep).join("/");
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = fs.readFileSync(absFile, "utf8");
    const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const dep = resolveLocal(path.dirname(absFile), m[2]);
      if (!dep) { unresolved.push(`${rel} → require("${m[2]}")`); continue; }
      walk(dep);
    }
  })(path.join(DESKTOP, entry));
  return { seen, unresolved };
}

test("every module the app requires is in build.files", () => {
  const files = new Set(pkg.build.files);
  const { seen } = reachableModules();
  const missing = [...seen].filter((rel) => !files.has(rel));
  assert.deepEqual(missing, [],
    `these are require()d from ${entry} but absent from desktop/package.json > build.files, so they would be ` +
    `left out of app.asar and the app would fail to launch:\n  - ${missing.join("\n  - ")}`);
});

test("every require() in the app's own modules resolves to a real file", () => {
  const { unresolved } = reachableModules();
  assert.deepEqual(unresolved, [], `unresolvable local require(s):\n  - ${unresolved.join("\n  - ")}`);
});

test("build.files does not list modules that no longer exist", () => {
  // A stale entry is harmless to the build but it's a lie about what the app needs, and it makes the list
  // useless as documentation of the app's real surface.
  const gone = pkg.build.files.filter((f) => !fs.existsSync(path.join(DESKTOP, f)));
  assert.deepEqual(gone, [], `listed in build.files but not on disk:\n  - ${gone.join("\n  - ")}`);
});

test("the HTML and icon the app loads by path are packaged too", () => {
  // Not reachable through require(), so the walk above cannot see them. load-error.html is the sharp one: it
  // only appears when something has ALREADY gone wrong, which is the worst place to discover a packaging miss.
  const files = new Set(pkg.build.files);
  for (const asset of ["wizard.html", "error.html", "load-error.html", "assets/icon.png"]) {
    assert.ok(fs.existsSync(path.join(DESKTOP, asset)), `${asset} is missing from the repo`);
    assert.ok(files.has(asset), `${asset} is loaded by path at runtime but is not in build.files`);
  }
});
