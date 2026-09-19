// Every way into Settings opens the same URL — run: node --test desktop/settings-entry.test.js
//
// There are two doors: the gear on the dashboard (web/app.js) and the Settings… menu item / Cmd+, (main.js).
// They are in different files, in different processes, and they drifted: the gear was fixed to pass
// ?settings=1 and the menu went on loading a bare /setup for three months. For an app-managed node that is
// the install-progress view, which bounces straight back to the dashboard once the node is ready — the
// window blinks and Settings never opens. Nothing failed, because nothing compared the two.
//
// main.js cannot be required outside Electron, so this reads the source, like packaged-files.test.js does.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), "utf8");
const SETTINGS_PATH = "/setup?settings=1";

test("the menu's Settings… item opens the settings view, not the first-run view", () => {
  const m = /function openSettings\(\)\s*\{[^}]*loadURL\(`([^`]+)`\)/.exec(read("main.js"));
  assert.ok(m, "openSettings() no longer loads a URL this test can read — update the test with it");
  assert.ok(m[1].endsWith(SETTINGS_PATH), `menu loads ${m[1]}`);
});

test("the dashboard's gear opens the same place", () => {
  const m = /inHit\(gearHit,[^)]*\)\)\s*\{\s*window\.location\s*=\s*"([^"]+)"/.exec(read("..", "web", "app.js"));
  assert.ok(m, "the gear's click handler no longer sets window.location this way — update the test with it");
  assert.equal(m[1], SETTINGS_PATH);
});

test("and the setup page still branches on that flag", () => {
  assert.match(read("wizard.html"), /URLSearchParams\(location\.search\)\.has\("settings"\)/);
});
