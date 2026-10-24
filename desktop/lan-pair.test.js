// Tests for lan-pair.js — run: node --test desktop/lan-pair.test.js
// The two-copies-find-each-other test uses real multicast, which CI runners don't reliably carry, so it runs
// only with LAN_PAIR_LIVE=1 (on a computer with a network up).

const test = require("node:test");
const assert = require("node:assert");
const { encodeAnnounce, parseAnnounce, chooseEntry, createPairing } = require("./lan-pair.js");

test("an announce round-trips, and the name is cleaned the way Settings cleans it", () => {
  assert.deepEqual(parseAnnounce(encodeAnnounce({ nonce: "abc", name: "Mac-M4.local" })), { nonce: "abc", name: "mac-m4.local" });
});

test("packets that aren't ours, or carry a name Settings would refuse, are ignored", () => {
  assert.equal(parseAnnounce(Buffer.from("hello")), null);
  assert.equal(parseAnnounce(Buffer.from(JSON.stringify({ m: "other/1", n: "a", name: "mac.local" }))), null);
  assert.equal(parseAnnounce(encodeAnnounce({ nonce: "a", name: "http://evil" })), null);
  assert.equal(parseAnnounce(encodeAnnounce({ nonce: "a", name: "my mac" })), null);
  assert.equal(parseAnnounce(Buffer.alloc(600, 32)), null);
});

test("the name is kept only when it leads back to the sender; otherwise the address", async () => {
  const lookup = async () => [{ address: "192.168.10.121", family: 4 }];
  assert.equal(await chooseEntry("intel.local", "192.168.10.121", lookup), "intel.local");
  assert.equal(await chooseEntry("intel.local", "192.168.10.50", lookup), "192.168.10.50");
  assert.equal(await chooseEntry("pc", "192.168.10.60", async () => { throw new Error("ENOTFOUND"); }), "192.168.10.60");
});

test("a window that can't get a packet onto the network says it's stuck, instead of quietly counting down", async () => {
  const p = createPairing({ name: "lonely.local", interfaces: () => [], stuckAfterMs: 50 });
  p.start();
  try {
    assert.equal(p.status().stuck, false, "not before it's had a chance");
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual([p.status().active, p.status().stuck, p.status().sent], [true, true, 0]);
  } finally { p.stop(); }
  assert.equal(p.status().stuck, false);
});

test("two copies in a pairing window find each other", { skip: process.env.LAN_PAIR_LIVE !== "1" }, async () => {
  const a = createPairing({ name: "copy-a.local" }), b = createPairing({ name: "copy-b.local" });
  a.start(); b.start();
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(a.status().found.length && b.status().found.length)) await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(a.status().found.map((f) => f.name), ["copy-b.local"]);
    assert.deepEqual(b.status().found.map((f) => f.name), ["copy-a.local"]);
    assert.equal(a.status().active, true);
    assert.ok(a.status().sent > 0 && a.status().heardSelf > 0, "each copy hears its own announcement");
    assert.equal(a.status().stuck, false);
  } finally { a.stop(); b.stop(); }
  assert.equal(a.status().active, false);
});
