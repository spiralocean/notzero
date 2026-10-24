// Tests for lan-peers.js — run: node --test desktop/lan-peers.test.js

const test = require("node:test");
const assert = require("node:assert");
const { LAN_P2P_PORT, MAX_LAN_PEERS, normalizeLanPeers, lanPeerArgs, thisComputerName } = require("./lan-peers.js");

test("names and addresses get our port; duplicates and blanks drop out", () => {
  const { peers, rejected } = normalizeLanPeers(["mac-m1.local", " Mac-M1.local ", "", "192.168.10.30", "nas:9000", "mac-m1.local."]);
  assert.deepEqual(peers, [`mac-m1.local:${LAN_P2P_PORT}`, `192.168.10.30:${LAN_P2P_PORT}`, "nas:9000"]);
  assert.deepEqual(rejected, []);
});

test("a typed list splits on commas, spaces and newlines", () => {
  assert.deepEqual(normalizeLanPeers("mac-m1.local, macmini.local\nmacbookpro").peers,
    ["mac-m1.local:8433", "macmini.local:8433", "macbookpro:8433"]);
});

test("things bitcoind would retry forever are refused, and named", () => {
  const { peers, rejected } = normalizeLanPeers(["http://mac-m1.local", "my mac", "-host", "a:99999", "[::1]", "mac-m1.local"]);
  assert.deepEqual(peers, ["mac-m1.local:8433"]);
  assert.deepEqual(rejected, ["http://mac-m1.local", "my mac", "-host", "a:99999", "[::1]"]);
});

test(`at most ${MAX_LAN_PEERS} computers`, () => {
  const { peers, rejected } = normalizeLanPeers(Array.from({ length: 10 }, (_, i) => `pc${i}`));
  assert.equal(peers.length, MAX_LAN_PEERS);
  assert.deepEqual(rejected, ["pc8:8433", "pc9:8433"]);
});

test("no computers → no flags: the node stays outbound-only", () => {
  assert.deepEqual(lanPeerArgs([]), []);
  assert.deepEqual(lanPeerArgs(undefined), []);
  assert.deepEqual(lanPeerArgs(["not a host"]), []);
});

test("computers → listen on the app's port, never advertise it, and keep each one connected", () => {
  assert.deepEqual(lanPeerArgs(["mac-m1.local", "macbookpro.local"]), [
    "-listen=1", "-port=8433", "-bind=0.0.0.0:8433", "-bind=[::]:8433", "-discover=0", "-listenonion=0",
    "-addnode=mac-m1.local:8433", "-addnode=macbookpro.local:8433",
  ]);
});

test("this computer's name: the Bonjour name on a Mac, the short hostname elsewhere", () => {
  assert.equal(thisComputerName({ platform: "darwin", execFileSync: () => "mac-m4\n", hostname: () => "x" }), "mac-m4.local");
  assert.equal(thisComputerName({ platform: "darwin", execFileSync: () => { throw new Error("no scutil"); }, hostname: () => "macbookpro.localdomain" }), "macbookpro");
  assert.equal(thisComputerName({ platform: "linux", hostname: () => "ubuntu-8gb-ash-1" }), "ubuntu-8gb-ash-1");
});
