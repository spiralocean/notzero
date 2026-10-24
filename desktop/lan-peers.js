// Your other computers as Bitcoin peers — so nodes in the same house hear new blocks from each other.
//
// The managed node is normally outbound-only (listen=0 in its bitcoin.conf): it reaches out to strangers on
// the internet and accepts nobody. That's right for a single machine. With two or three machines on one
// network, each one fetches every block and transaction from the internet separately, and a machine whose
// peers go quiet has nothing to fall back on. Listing your other computers here makes each node:
//
//   - accept connections on LAN_P2P_PORT, so your other computers can reach it, and
//   - keep a connection to each listed computer (addnode), IN ADDITION to its usual internet peers.
//
// A mesh, not a hub: no machine depends on another, and a computer that's off just isn't connected. The
// saving is modest (each node still has its internet peers); the point is that a block one of your machines
// has heard about reaches the others over the local network.
//
// Deliberately typed in rather than discovered: automatic discovery (Bonjour) would announce "a Bitcoin
// Lottery node is here" to every device on the network, and the app's promise is that it doesn't broadcast
// anything about you. Nothing changes for anyone who leaves the list empty — the node stays outbound-only.
//
// Passed as command-line flags, not written to bitcoin.conf: writeConf() never rewrites an existing conf, and
// command-line flags override the conf's listen=0 — the same reason the synced-node cache sizes go that way.

// Not 8333: someone running their own Bitcoin Core on the same machine already has that port, and a second
// bitcoind failing to bind would take the managed node down with it. Every copy of the app uses this one, so
// a bare computer name is enough to reach another copy.
const LAN_P2P_PORT = 8433;
const MAX_LAN_PEERS = 8;

// A computer name ("mac-m1", "mac-m1.local", "office-pc.lan"), an IPv4 address, or either with :port.
// Anything else — spaces, URLs, IPv6 (rare on a home LAN, and its brackets complicate everything) — is
// rejected rather than handed to bitcoind, where a bad -addnode is silently retried forever.
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// Clean up what the user typed: trim, drop blanks and duplicates, add our port where none was given, and
// separate out entries we won't use so the settings page can say which ones and why.
function normalizeLanPeers(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
  const peers = [], rejected = [];
  for (const raw of list) {
    const s = String(raw || "").trim().replace(/\.$/, "");
    if (!s) continue;
    const m = /^(.+?)(?::(\d{1,5}))?$/.exec(s);
    const host = m && m[1], port = m && m[2] ? Number(m[2]) : LAN_P2P_PORT;
    if (!m || !HOST_RE.test(host) || port < 1 || port > 65535) { rejected.push(s); continue; }
    const entry = `${host.toLowerCase()}:${port}`;
    if (!peers.includes(entry)) peers.push(entry);
  }
  if (peers.length > MAX_LAN_PEERS) rejected.push(...peers.splice(MAX_LAN_PEERS));
  return { peers, rejected };
}

// The bitcoind flags for a peer list. Empty list → no flags at all: the conf's listen=0 stands.
function lanPeerArgs(peers) {
  const { peers: clean } = normalizeLanPeers(peers);
  if (!clean.length) return [];
  return [
    "-listen=1", `-port=${LAN_P2P_PORT}`,
    // Explicit binds: with none, Core also binds 127.0.0.1:<port+1> for Tor inbound — a second port nobody
    // asked for (seen in testing: it collided with a second node on 8434). Both families, because a ".local"
    // name can resolve to IPv6 first.
    `-bind=0.0.0.0:${LAN_P2P_PORT}`, `-bind=[::]:${LAN_P2P_PORT}`,
    "-discover=0",    // don't tell internet peers our address — the listener is for the house, not the world
    "-listenonion=0", // listening would otherwise also try to set up a Tor hidden service
    ...clean.map((p) => `-addnode=${p}`),
  ];
}

// The name other computers should type to reach this one. macOS's Bonjour name (System Settings → General →
// Sharing → Local hostname) is what resolves on a home network; os.hostname() there is often the DHCP name
// ("macbookpro.localdomain"), which only the router knows. Elsewhere the plain hostname is the best guess.
function thisComputerName({ platform = process.platform, execFileSync = require("child_process").execFileSync, hostname = require("os").hostname } = {}) {
  if (platform === "darwin") {
    try { const n = String(execFileSync("scutil", ["--get", "LocalHostName"], { timeout: 2000 })).trim(); if (n) return `${n}.local`; } catch (_) {}
  }
  return String(hostname() || "").split(".")[0];
}

module.exports = { LAN_P2P_PORT, MAX_LAN_PEERS, normalizeLanPeers, lanPeerArgs, thisComputerName };
