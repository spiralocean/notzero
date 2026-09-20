// Tests for node-rpc-config.js — run: node --test desktop/node-rpc-config.test.js  (no Electron, no disk)
//
// The property that matters: a config that says where the cookie is gets believed. The shipped bug was a
// managed node's cookie path being ignored in favour of Bitcoin Core's default folder, which left the update
// checks with no node at all.

const test = require("node:test");
const assert = require("node:assert");
const { cookiePathFromConfig } = require("./node-rpc-config.js");

const MANAGED = "/Users/x/Library/Application Support/bitcoin-lottery-desktop/node/datadir/.cookie";
const fs = (...present) => ({ exists: (p) => present.includes(p), fromDatadir: (d) => (d ? d + "/.cookie" : "DEFAULT") });

test("an app-managed node: the saved cookie path is used, not Bitcoin Core's default folder", () => {
  assert.equal(cookiePathFromConfig({ node_mode: "managed", rpc_cookie: MANAGED }, fs(MANAGED)), MANAGED);
});

test("a typed datadir still works when the saved path is gone", () => {
  assert.equal(cookiePathFromConfig({ rpc_cookie: "/old/.cookie", rpc_datadir: "/vol/btc" }, fs()), "/vol/btc/.cookie");
});

test("an older config that stored only a flag falls back to the datadir / default lookup", () => {
  assert.equal(cookiePathFromConfig({ rpc_cookie: true, rpc_datadir: "/vol/btc" }, fs()), "/vol/btc/.cookie");
  assert.equal(cookiePathFromConfig({ rpc_cookie: true }, fs()), "DEFAULT");
});

test("user/password auth, or no config at all: no cookie", () => {
  assert.equal(cookiePathFromConfig({ rpc_cookie: "", rpc_user: "u", rpc_pass: "p" }, fs(MANAGED)), "");
  assert.equal(cookiePathFromConfig(null, fs(MANAGED)), "");
});
