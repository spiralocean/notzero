// "Find my other computers" — a short pairing window, so nobody has to type computer names into Settings.
//
// Finding each other means saying "a Bitcoin Lottery node is here" on the home network, and the app's promise
// is that it doesn't broadcast anything about you. So it says it only while the user asks it to: clicking Find
// opens a window of PAIR_WINDOW_MS during which this computer announces itself every ANNOUNCE_EVERY_MS and
// listens for other copies doing the same. Click Find on both computers within that window and each sees the
// other. Then it goes quiet. Outside a window the app sends nothing and doesn't even hold the port open.
//
// Its own tiny protocol on one multicast group, not Bonjour: Bonjour would mean a dependency on every platform
// (Windows doesn't ship it) for what is one JSON packet. The group is administratively scoped (239.255/16) and
// sent with TTL 1, so routers drop it — it never leaves the local network, let alone reaches the internet.
//
// What's found is only offered: the Settings page adds it to the list, and the user still clicks Save. Anyone
// on the network could announce during the window, and a Bitcoin peer is untrusted by design anyway, but the
// list should hold the computers the user recognises.

const dgram = require("dgram");
const os = require("os");
const dns = require("dns");
const crypto = require("crypto");
const { normalizeLanPeers } = require("./lan-peers");

const PAIR_GROUP = "239.255.84.33";
const PAIR_PORT = 8435;          // 8433 is the node; 8434 is where Core would put a Tor listener by default
const PAIR_WINDOW_MS = 5 * 60_000;
const ANNOUNCE_EVERY_MS = 2000;
// Every copy hears its own announcement come back (multicast loops to the sender's own socket). Nothing back
// this long after opening means the packets aren't getting onto the network at all — seen once on a Mac whose
// long-running app sent nothing, with no error, until it was reopened — so the page says so instead of
// counting down to "didn't find any".
const STUCK_AFTER_MS = 6000;
const MAGIC = "notzero-pair/1";

function encodeAnnounce({ nonce, name }) {
  return Buffer.from(JSON.stringify({ m: MAGIC, n: nonce, name }));
}

// A packet from the network, so nothing about it is trusted: the right magic, a nonce, and a name that would
// pass Settings' own check. Anything else is null.
function parseAnnounce(buf) {
  if (!buf || buf.length > 512) return null;
  let p; try { p = JSON.parse(String(buf)); } catch (_) { return null; }
  if (!p || p.m !== MAGIC || typeof p.n !== "string" || p.n.length > 64 || typeof p.name !== "string") return null;
  const { peers } = normalizeLanPeers([p.name]);
  if (peers.length !== 1) return null;
  return { nonce: p.n, name: peers[0].replace(/:\d+$/, "") };
}

// What to put in the list: the computer's name when it really does lead back to the address the packet came
// from (it survives the router handing out a new address), otherwise the address itself — a Windows or Linux
// hostname often doesn't resolve on a home network.
async function chooseEntry(name, fromAddr, lookup = (h) => dns.promises.lookup(h, { all: true })) {
  let t;
  try {
    const addrs = await Promise.race([lookup(name), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), 2000); })]);
    if (addrs.some((a) => a.address === fromAddr)) return name;
  } catch (_) {} finally { clearTimeout(t); }
  return fromAddr;
}

function ipv4Interfaces() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

// One pairing window at a time. status() is what the Settings page polls.
function createPairing({ name, log = () => {}, interfaces = ipv4Interfaces, stuckAfterMs = STUCK_AFTER_MS }) {
  const nonce = crypto.randomBytes(8).toString("hex");
  let sock = null, timer = null, endsAt = 0, error = "";
  let openedAt = 0, sent = 0, heardSelf = 0, sendErrors = 0, lastSendError = ""; // this window's health, for status() and the log
  let found = []; // [{ entry, name }] — kept after the window closes so the page can still show it
  let seen = new Set(); // nonces already handled: one entry per copy, though it announces on each of its networks

  function stop() {
    if (sock) log(`pairing window closed: sent ${sent}, heard itself ${heardSelf}, found ${found.length}` + (sendErrors ? `, ${sendErrors} send errors (last ${lastSendError})` : ""));
    clearInterval(timer); timer = null; endsAt = 0;
    if (sock) { try { sock.close(); } catch (_) {} sock = null; }
  }

  async function announce() {
    if (!sock) return;
    const msg = encodeAnnounce({ nonce, name });
    for (const addr of interfaces()) { // every network this computer is on — Wi-Fi and Ethernet can both be up
      try { sock.setMulticastInterface(addr); await new Promise((r) => sock.send(msg, PAIR_PORT, PAIR_GROUP, (e) => { if (e) { sendErrors++; lastSendError = e.code || e.message; } else sent++; r(); })); } catch (_) {}
    }
  }

  async function onMessage(buf, rinfo) {
    const a = parseAnnounce(buf);
    if (a && a.nonce === nonce) { heardSelf++; return; } // our own packet looped back: proof it reached the network
    if (!a || seen.has(a.nonce)) return; // not ours, or a copy we already have
    seen.add(a.nonce);
    const entry = await chooseEntry(a.name, rinfo.address);
    if (found.some((f) => f.entry === entry)) return;
    found.push({ entry, name: a.name });
    log(`found ${a.name} at ${rinfo.address} → ${entry}`);
  }

  function start() {
    error = "";
    if (sock) { endsAt = Date.now() + PAIR_WINDOW_MS; return; } // clicked again: just extend the window
    found = []; seen = new Set();
    openedAt = Date.now(); sent = 0; heardSelf = 0; sendErrors = 0; lastSendError = "";
    sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (b, r) => { onMessage(b, r).catch(() => {}); });
    sock.on("error", (e) => { error = e.code || e.message; log(`pairing error: ${error}`); stop(); });
    sock.bind(PAIR_PORT, () => {
      if (!sock) return;
      try { sock.setMulticastTTL(1); } catch (_) {}
      for (const addr of interfaces()) { try { sock.addMembership(PAIR_GROUP, addr); } catch (_) {} }
      announce();
    });
    endsAt = Date.now() + PAIR_WINDOW_MS;
    timer = setInterval(() => { if (Date.now() >= endsAt) stop(); else announce(); }, ANNOUNCE_EVERY_MS);
    log("pairing window open");
  }

  function status() {
    const stuck = !!sock && heardSelf === 0 && Date.now() - openedAt >= stuckAfterMs;
    return { active: !!sock, endsAt, found: found.map((f) => ({ ...f })), error, stuck, sent, heardSelf, sendErrors, lastSendError };
  }

  return { start, stop, status };
}

module.exports = { PAIR_GROUP, PAIR_PORT, PAIR_WINDOW_MS, STUCK_AFTER_MS, encodeAnnounce, parseAnnounce, chooseEntry, createPairing };
