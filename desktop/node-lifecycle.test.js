// Tests for node-lifecycle.js — run: node --test desktop/node-lifecycle.test.js  (no Electron, no live node)
//
// Covers the synced-node UTXO cache marker. Core sizes -dbcache for initial sync (~1 GB of resident memory on
// a 16 GB machine); once the chain is caught up that's pure overhead in an app built to sit in the background
// for months, so launch() hands a marked node a small cache instead. Getting the marker WRONG in the optimistic
// direction is the expensive mistake — it would run a genuine sync on a starved cache — so the tests lean on
// the cases that must NOT mark: still in IBD, and assumeutxo background validation still running.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { updateSyncedMarker } = require("./node-lifecycle.js");
const P = require("./node-provision.js");

const tmpFlag = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nz-lifecycle-")), "chain-synced");
const one = { chainstates: [{ blocks: 900000, validated: true }] };
const two = { chainstates: [{ blocks: 900000, validated: true }, { blocks: 300000, validated: false }] };
const never = () => { throw new Error("getchainstates should not have been called"); };

test("marks a caught-up node with a single validated chainstate", async () => {
  const flagPath = tmpFlag();
  assert.equal(await updateSyncedMarker({ flagPath, mineable: true, getChainstates: async () => one }), true);
  assert.ok(fs.existsSync(flagPath));
});

test("does not mark while the node is still in IBD — and never asks the node", async () => {
  const flagPath = tmpFlag();
  assert.equal(await updateSyncedMarker({ flagPath, mineable: false, getChainstates: never }), false);
  assert.ok(!fs.existsSync(flagPath));
});

test("does not mark while assumeutxo background validation is still running", async () => {
  // Mineable, but a second chainstate is replaying the chain behind the snapshot and shares the cache.
  // This is the case a naive "out of IBD?" check gets wrong, and it's the one that costs hours.
  const flagPath = tmpFlag();
  assert.equal(await updateSyncedMarker({ flagPath, mineable: true, getChainstates: async () => two }), false);
  assert.ok(!fs.existsSync(flagPath));
});

test("does not mark when the only chainstate reports validated:false", async () => {
  const flagPath = tmpFlag();
  const unvalidated = { chainstates: [{ blocks: 900000, validated: false }] };
  assert.equal(await updateSyncedMarker({ flagPath, mineable: true, getChainstates: async () => unvalidated }), false);
  assert.ok(!fs.existsSync(flagPath));
});

test("a failed or nonsense getchainstates leaves the node unmarked", async () => {
  // Guessing wrong here costs a slow sync, so every unreadable answer has to fall back to the big cache.
  for (const answer of [() => Promise.reject(new Error("RPC timeout")), async () => null, async () => ({}), async () => ({ chainstates: "nope" })]) {
    const flagPath = tmpFlag();
    assert.equal(await updateSyncedMarker({ flagPath, mineable: true, getChainstates: answer }), false);
    assert.ok(!fs.existsSync(flagPath));
  }
});

test("dropping back into IBD clears an existing marker", async () => {
  // Months offline or a reindex: the node is syncing again, so the next launch must get the full cache back.
  const flagPath = tmpFlag();
  fs.writeFileSync(flagPath, "2026-01-01T00:00:00.000Z\n");
  assert.equal(await updateSyncedMarker({ flagPath, mineable: false, getChainstates: never }), false);
  assert.ok(!fs.existsSync(flagPath));
});

test("an already-marked node is not re-confirmed over RPC on every poll", async () => {
  const flagPath = tmpFlag();
  fs.writeFileSync(flagPath, "2026-01-01T00:00:00.000Z\n");
  assert.equal(await updateSyncedMarker({ flagPath, mineable: true, getChainstates: never }), true);
  assert.ok(fs.existsSync(flagPath));
});

test("the marker lives in the node dir and is well under Core's own sizing", async () => {
  const paths = P.managedPaths("/tmp/whatever");
  assert.equal(paths.syncedFlag, path.join(paths.node, "chain-synced"));
  assert.ok(P.SYNCED_DBCACHE_MIB >= 4, "Core rejects a dbcache below its 4 MiB floor");
  assert.ok(P.SYNCED_DBCACHE_MIB <= 450, "a cap at or above Core's old default would save nothing");
});

test("the synced-node memory ceiling stays bounded — dbcache AND the mempool it borrows from", async () => {
  // Core lends unused mempool space to the UTXO cache, so capping dbcache alone doesn't bound memory: at the
  // 300 MB default maxmempool a 150 MiB dbcache still reaches ~430 MiB. Anyone raising one of these without
  // the other silently gives that headroom back, which is the whole reason the cap exists.
  assert.ok(P.SYNCED_MAXMEMPOOL_MIB >= 5, "Core rejects a maxmempool below ~5 MB");
  assert.ok(P.SYNCED_MAXMEMPOOL_MIB * 1024 * 1024 >= 4_000_000 * 4, "a template needs a block's worth of transactions to choose from");
  assert.ok(P.SYNCED_DBCACHE_MIB + P.SYNCED_MAXMEMPOOL_MIB <= 300, "a synced node should stay well under Core's ~1.3 GB sync-time ceiling");
});
