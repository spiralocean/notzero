// Bitcoin Lottery — browser dashboard (cross-platform port of the macOS viz).
// Self-contained: public chain/price data from mempool.space + a client-side
// SHA-256 hash visualization (Web Crypto). No backend.
import { makeQuoteBag } from "./quote-bag.js";

const API = "https://mempool.space/api";
const ACCENT = "255, 153, 26";          // brand orange
const REFRESH_MS = 30_000;

// ---- machine seed (your lottery identity on this device) ----
function machineSeed() {
  // when a live daemon is connected, use ITS seed so our ticket nonce matches the daemon's actual nonce
  const daemonSeed = model.node && model.node.miner && model.node.miner.seed;
  if (daemonSeed) return daemonSeed;
  let s = localStorage.getItem("bl.seed");
  if (!s) {
    s = "web-" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("bl.seed", s);
  }
  return s;
}

// ---- section expand/collapse (persisted) ----
const SECTIONS = ["win", "nextBlock", "mempool", "closeness", "tickets", "hashBuild", "merkle", "avalanche", "verify", "hashInside", "oneRound", "shift", "churn", "fold", "sigma1", "ch", "maj", "bitOps", "network", "broadcast", "sync", "updates"];
const SECTION_TITLE = { win: "YOUR WIN", nextBlock: "NEXT BLOCK", mempool: "MEMPOOL", closeness: "YOUR CLOSENESS", tickets: "YOUR TICKETS", merkle: "MERKLE TREE", hashBuild: "HASH BUILD", avalanche: "THE AVALANCHE", verify: "VERIFY THIS BLOCK", hashInside: "INSIDE THE HASH", fold: "THE FOLD", bitOps: "BIT OPERATIONS", oneRound: "ONE ROUND", shift: "THE SHIFT", churn: "THE CHURN", sigma1: "ONE STEP · SCRAMBLE (Σ1)", ch: "ONE STEP · CHOOSE (Ch)", maj: "ONE STEP · MAJORITY (Maj)", network: "NETWORK", broadcast: "BROADCAST", sync: "BLOCKCHAIN SYNC", updates: "VERIFIED UPDATES" };
function loadExpanded() {
  try {
    const raw = JSON.parse(localStorage.getItem("bl.expanded"));
    if (Array.isArray(raw)) return new Set(raw);
  } catch {}
  return new Set(["nextBlock", "closeness"]);
}
let expanded = loadExpanded();
function saveExpanded() { localStorage.setItem("bl.expanded", JSON.stringify([...expanded])); }

// ---- crypto / lottery math (mirrors lottery_miner.py) ----
const enc = new TextEncoder();
const hexToBytes = (h) => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const u32le = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0, true); return a; };
const concat = (...arrs) => { const len = arrs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(len); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

// ---- SHA-256 from scratch (crypto.subtle is a black box) — powers the INSIDE THE HASH panel by exposing the
// real message schedule + the 8 working registers through all 64 rounds. Verified against sha256() at load. ----
const _SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const _SHA_H0 = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
const _rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
function sha256Internals(bytes) {
  const ml = bytes.length * 8, padLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(padLen); msg.set(bytes); msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(padLen - 4, ml >>> 0); dv.setUint32(padLen - 8, Math.floor(ml / 4294967296));
  const H = _SHA_H0.slice(); let firstW = null; const rounds = [];
  for (let bi = 0; bi < padLen / 64; bi++) {
    const W = new Array(64);
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(bi * 64 + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = _rotr(W[t - 15], 7) ^ _rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = _rotr(W[t - 2], 17) ^ _rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + _SHA_K[t] + W[t]) >>> 0;
      const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      if (bi === 0) rounds.push([a, b, c, d, e, f, g, h]);
    }
    if (bi === 0) firstW = W;
    const v = [a, b, c, d, e, f, g, h]; for (let i = 0; i < 8; i++) H[i] = (H[i] + v[i]) >>> 0;
  }
  return { bytes, padLen, blocks: padLen / 64, W: firstW, rounds, digest: H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("") };
}
let hashViz = { input: "bitcoin", data: null, focused: false };
function hashVizCompute() { try { hashViz.data = sha256Internals(new TextEncoder().encode(hashViz.input)); } catch (_) { hashViz.data = null; } }
hashVizCompute();
function handleHashKey(e) {
  if (e.metaKey || e.ctrlKey) return false; // leave copy/paste/shortcuts alone
  if (e.key === "Backspace") hashViz.input = hashViz.input.slice(0, -1);
  else if (e.key === "Enter" || e.key === "Escape") hashViz.focused = false;
  else if (e.key.length === 1 && hashViz.input.length < 24) hashViz.input += e.key; // cap: fits the 3-row bit view + one 512-bit block
  else return false;
  e.preventDefault(); hashVizCompute(); requestRender(); return true;
}
const dsha256 = async (b) => sha256(await sha256(b));

async function pickNonce(seed, height) {
  const d = await sha256(enc.encode(`${seed}:${height}`));
  return new DataView(d.buffer).getUint32(0, true);
}

// the 80-byte block header, serialized exactly as it is hashed (little-endian; prev/merkle byte-reversed)
function serializeHeader(blk, nonce) {
  return concat(
    u32le(blk.version),
    hexToBytes(blk.previousblockhash).reverse(),
    hexToBytes(blk.merkle_root).reverse(),
    u32le(blk.timestamp),
    u32le(blk.bits),
    u32le(nonce),
  );
}
async function hashBlockHeader(blk, nonce) {
  return bytesToHex(await dsha256(serializeHeader(blk, nonce)));
}

// ---- VERIFY THIS BLOCK: independently recompute a real block's proof-of-work from its 80-byte header ----
// Rebuild the merkle root from the block's txids. txids/merkle_root are shown byte-reversed, but the tree
// hashes INTERNAL byte order — so flip each txid in, and flip the final root back out to compare.
async function merkleRootOf(txidsDisplay) {
  let level = txidsDisplay.map((h) => hexToBytes(h).reverse());
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = i + 1 < level.length ? level[i + 1] : level[i]; // odd count → duplicate the last
      next.push(await dsha256(concat(a, b)));
    }
    level = next;
  }
  return bytesToHex(level[0].slice().reverse());
}
// Recompute the three checks a node runs — hash matches, hash ≤ target, merkle root commits to the txs — and
// stash the result in model.verify. Best-effort: never throws into the render loop.
async function computeVerify(blk) {
  if (!blk || !blk.id || blk.version == null || !blk.previousblockhash || !blk.merkle_root || blk.bits == null || blk.nonce == null) return;
  if (model.verify && model.verify.id === blk.id && model.verify.merkleMatch != null) return; // already verified this block
  const v = { id: blk.id, height: blk.height, version: blk.version, prevHash: blk.previousblockhash, merkleRoot: blk.merkle_root, timestamp: blk.timestamp, bits: blk.bits, nonce: blk.nonce, txCount: blk.tx_count };
  try {
    v.recomputed = bytesToHex((await dsha256(serializeHeader(blk, blk.nonce))).slice().reverse()); // display order → matches blk.id
    v.hashMatch = v.recomputed === blk.id;
    v.target = bitsToTarget(blk.bits);
    v.targetHex = v.target.toString(16).padStart(64, "0");
    v.belowTarget = bigHex(blk.id) <= v.target;
    v.leadingZeros = leadingZeroHexChars(blk.id);
  } catch (_) { return; }
  model.verify = v; requestRender();
  try {
    const txids = await (await fetch(`${API}/block/${blk.id}/txids`)).json();
    if (Array.isArray(txids) && txids.length) { v.computedMerkle = await merkleRootOf(txids); v.merkleMatch = v.computedMerkle === blk.merkle_root; v.txids = txids.length; }
    else v.merkleMatch = false;
  } catch (_) { v.merkleMatch = null; } // couldn't fetch txids — leave it pending rather than claim a fail
  model.verify = { ...v }; requestRender();
}

// THE AVALANCHE demo — hash the real header at nonce 0, then at each single-bit-flipped nonce; record how many
// of the 256 output bits differ (~half). Recomputed once per block. All real double-SHA-256.
async function computeAvalanche(blk) {
  if (!blk || !blk.merkle_root || blk.version == null || !blk.previousblockhash || blk.bits == null) return;
  if (model.avalanche && model.avalanche.forHeight === blk.height) return;
  try {
    const N0 = 0, base = await dsha256(serializeHeader(blk, N0)), flips = [];
    for (let i = 0; i < 32; i++) {
      const bytes = await dsha256(serializeHeader(blk, (N0 ^ (1 << i)) >>> 0));
      let diff = 0; for (let b = 0; b < 32; b++) { let x = (base[b] ^ bytes[b]) & 0xff; while (x) { diff += x & 1; x >>>= 1; } }
      flips.push({ bit: i, bytes, diff });
    }
    model.avalanche = { forHeight: blk.height, nonce: N0, base, flips };
    requestRender();
  } catch (_) {}
}

function bitsToTarget(bits) {
  const exp = bits >>> 24, mant = BigInt(bits & 0xffffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

// untrusted hex (from mempool.space or node.json) → BigInt without ever throwing (a bad value used to
// freeze the whole render loop). Returns 0n for anything that isn't 1–64 hex chars.
const HEX64 = /^[0-9a-fA-F]{1,64}$/;
const bigHex = (h) => (typeof h === "string" && HEX64.test(h)) ? BigInt("0x" + h) : 0n;
function proximity(hashHex, target) {
  const hashInt = bigHex(hashHex);
  if (hashInt <= target) return { won: true, percent: 100, leadingZeroBits: 256, label: "JACKPOT" };
  const leading = 256 - hashInt.toString(2).length;
  const ratio = Number(target) / Number(hashInt);
  const percent = Math.max(0, Math.min(99.999999, ratio * 100));
  return { won: false, percent, leadingZeroBits: leading, label: percent.toFixed(8) + "%" };
}
function leadingZeroHexChars(hashHex) { let n = 0; for (const c of hashHex) { if (c === "0") n++; else break; } return n; }
// Rarity of a hash with ≥ b leading zero BITS: exactly 1 in 2^b random hashes. Human words while it's small
// enough to feel (up to ~a trillion), then powers of ten — matching the odds-map's "1 in ~10^N" style.
function oddsOneIn(b) {
  if (b <= 0) return "1 in 1";
  if (b <= 40) { const n = Math.pow(2, b); if (n < 1e4) return "1 in " + Math.round(n).toLocaleString();
    for (const [v, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) if (n >= v) return "1 in " + (n / v).toFixed(n / v < 10 ? 1 : 0) + " " + name; }
  return "1 in ~10^" + Math.round(b * 0.30103);
}
// Exact rarity of one SPECIFIC hash: P(random hash ≤ h) = h/2^256, so "this good or better" is 1 in 2^256/h —
// the continuous read of oddsOneIn's zero-bits bucket, which only moves in whole-bit (2×) jumps. Also the
// honest win odds when fed the target. Returns log2(N) of the "1 in N" figure; format with oddsExact().
function rarityBits(hashHex) {
  const h = bigHex(hashHex); if (h <= 0n) return 256;
  const bits = h.toString(2).length, shift = Math.max(0, bits - 53); // top 53 bits fit a double exactly
  return 256 - Math.log2(Number(h >> BigInt(shift))) - shift;
}
function oddsExact(l2) {
  const n = Math.pow(2, l2);
  if (n < 1e4) return "1 in " + Math.round(n).toLocaleString();
  for (const [v, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]])
    if (n >= v && n < v * 1e3) return "1 in " + (n / v).toFixed(n / v < 10 ? 1 : 0) + " " + name;
  const d = l2 * 0.30103; let e = Math.floor(d), m = Math.pow(10, d - e);
  if (m >= 9.95) { m /= 10; e += 1; }
  return `1 in ${m.toFixed(1)}×10^${e}`;
}
// People don't feel "1 in 2^b" — a lottery you can't picture. But this app draws ONE ticket per block (~10 min),
// so rarity converts to TIME people can feel: a 1-in-2^b hash is expected about every 2^b blocks. Round it into a
// relatable interval — "once a month", "once a decade", "longer than history", up to multiples of the universe's age.
function sciWords(x) {
  for (const [v, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]])
    if (x >= v) { const q = x / v; return `${q < 10 ? q.toFixed(1) : Math.round(q)} ${name}`; }
  return Math.round(x).toLocaleString();
}
function expectedEvery(l2) {
  const BLOCK_SEC = 600, YR = 31557600, AGE_UNIVERSE = 1.38e10; // one draw / block; seconds per year; universe age in years
  const log10yr = l2 * 0.30103 + Math.log10(BLOCK_SEC) - Math.log10(YR); // log10 of (2^l2 blocks) expressed in years
  if (log10yr < 0) { const days = Math.pow(10, log10yr) * 365.25;
    if (days < 1.5) return "about once a day";
    if (days < 12) return `about once every ${Math.round(days)} days`;
    if (days < 45) return "about once a month";
    return `about once every ${Math.round(days / 30)} months`; }
  const years = Math.pow(10, log10yr);
  if (years < 1.6) return "about once a year";
  if (years < 12) return `about once every ${Math.round(years)} years`;
  if (years < 45) return `about once every ${Math.round(years / 10) * 10} years`;      // decades
  if (years < 900) return `about once every ${Math.round(years / 100) * 100} years`;   // centuries
  if (years < 12000) return "rarer than all of recorded history";
  if (years < AGE_UNIVERSE) return `about once every ${sciWords(years)} years`;
  return `~${sciWords(years / AGE_UNIVERSE)}× the age of the universe`;
}
// N leading zero BITS = N coin-flips all landing heads — the unit that makes the doubling felt (each zero halves it).
function coinFlips(bits) { const n = Math.round(bits); return `${n} coin-flip${n === 1 ? "" : "s"} landing heads in a row`; }

// ---- model ----
const model = { tipHeight: null, block: null, txCount: null, price: null, hashrateEh: null, difficulty: null, diffAdjust: null, miningSeries: null, ticket: null, error: null, chainOkAt: 0, priceHistory: [], hashrateHistory: [], recentBlocks: [], blockTimes: [], blockHistory: [], node: null, nodeLastOk: 0, mempool: null, bwHistory: [], recentTxs: [], fees: null };
// true right after the node briefly dropped but was up moments ago (e.g. the miner + bridge restarting when
// you save settings) — used to show a calm "reconnecting…" instead of "no node connected" for a grace window.
function nodeReconnecting() { return isDesktop && model.nodeLastOk > 0 && (Date.now() - model.nodeLastOk) < 20000; }
// Pending-tx count from YOUR synced node (getmempoolinfo, in node.json) — but only if it actually relays txs (a
// blocksonly node has an empty mempool, so its 0 would mislead; fall back to mempool.space there). null = no
// usable local count, i.e. the public demo, a still-syncing node, or blocksonly. Lets the collapsed MEMPOOL
// header show a count without a mempool.space call (see refresh()).
function nodeMempoolCount() {
  const n = model.node, mp = n && n.mempool;
  if (!n || n.reachable === false || n.initialblockdownload || !mp) return null;
  if (mp.relay === false || mp.count == null) return null;
  return mp.count;
}
// Turn the managed-node provisioning feed into a human phase for the dashboard to show. Returns null unless we're
// in desktop managed mode AND the node is mid-setup (before it's a reachable, mineable node). {head, detail,
// progress (0-1|null), isError}. `detail` prefers the app's own message so the wording stays in one place.
function nodeSetupView() {
  const s = nodeSetup;
  if (!s || !isDesktop || nodeMode !== "managed") return null;
  if (s.state === "ready" || s.state === "idle" || !s.state) return null; // node up (or nothing happening) → the live node.json drives the panel
  const P = s.progress != null ? Math.max(0, Math.min(1, s.progress)) : null, pct = P != null ? ` ${Math.round(P * 100)}%` : "";
  const M = {
    "downloading-core": { head: "Downloading Bitcoin Core" + pct,      detail: "Fetching the node software — a one-time download." },
    "extracting":       { head: "Unpacking Bitcoin Core",              detail: "Almost ready to start your node." },
    "starting":         { head: "Starting your node",                  detail: "Bringing Bitcoin Core online…" },
    "loading-snapshot": { head: "Loading the verified snapshot" + pct, detail: "The fast-start step — a few minutes. Please leave the app open." },
    "syncing":          { head: "Syncing the blockchain" + pct,        detail: "Downloading and verifying blocks up to the current tip." },
    "error":            { head: "Your node hit a snag",                detail: "Setup couldn't finish — open Settings to retry.", isError: true },
  }[s.state];
  if (!M) return null;
  return { head: M.head, detail: s.detail || M.detail, progress: P, isError: !!M.isError };
}
let bwLast = null; // last getnettotals sample, to derive the rate between polls

async function loadHistory() {
  refreshSlow(); // fire the spot price / hashrate / difficulty aggregates first so they don't wait behind the two history awaits below (matters at boot — the header shows a price immediately)
  try {
    const hr = await (await fetch(`${API}/v1/mining/hashrate/1m`)).json();
    if (hr?.hashrates) {
      model.hashrateHistory = hr.hashrates.map((p) => p.avgHashrate / 1e18);
      // mining power vs difficulty: both as EH/s over time (difficulty → the hashrate it implies = diff·2^32/600)
      model.miningSeries = {
        hr: hr.hashrates.map((p) => ({ t: p.timestamp, v: p.avgHashrate / 1e18 })),
        diff: (hr.difficulty || []).map((p) => ({ t: p.time, v: (p.difficulty * 4294967296 / 600) / 1e18 })),
      };
    }
  } catch {}
  try {
    const pr = await (await fetch(`${API}/v1/historical-price?currency=USD`)).json();
    if (pr?.prices) model.priceHistory = pr.prices.slice().sort((a, b) => a.time - b.time).map((p) => p.USD).slice(-168);
  } catch {}
}
// Slow-moving aggregates — spot price, 3-day average hashrate, next-difficulty estimate. None of these changes
// visibly over 30s, so they ride the 300s history cadence rather than the 30s tip/mempool one. Fire-and-forget
// (each with its own catch, like every optional sub-fetch) so they never touch model.error or gate the loop.
function refreshSlow() {
  fetch(`${API}/v1/prices`).then((r) => r.json()).then((p) => { if (p && p.USD) model.price = p.USD; }).catch(() => {});
  fetch(`${API}/v1/mining/hashrate/3d`).then((r) => r.json()).then((h) => { if (h && h.currentHashrate) model.hashrateEh = h.currentHashrate / 1e18; }).catch(() => {});
  fetch(`${API}/v1/difficulty-adjustment`).then((r) => r.json()).then((d) => { if (d && d.remainingBlocks != null) model.diffAdjust = d; }).catch(() => {}); // next-difficulty estimate + timing
}

// Recent inter-block intervals (minutes) for the NEXT BLOCK distribution. Bitcoin block times are a Poisson
// process — ~exponential, memoryless — so the histogram makes "10 min is an average, not a schedule" visible.
// Turn a list of {height, timestamp} (either source) into the two things NEXT BLOCK draws: the intervals the
// histogram buckets, and the arrivals the timeline places. Only CONSECUTIVE heights are differenced, and
// implausible gaps are dropped — miner timestamps can run slightly backwards or far ahead of the real time.
function applyBlockHistory(list) {
  const h = list.filter((b) => b && b.height != null && b.timestamp != null).sort((a, b) => a.height - b.height);
  if (h.length < 4) return false;
  const iv = [];
  for (let i = 1; i < h.length; i++) {
    if (h[i].height !== h[i - 1].height + 1) continue;
    const d = (h[i].timestamp - h[i - 1].timestamp) / 60;
    if (d >= 0 && d < 180) iv.push(d);
  }
  model.blockHistory = h;
  if (iv.length >= 12) model.blockTimes = iv;
  return true;
}
// The node's own last ~75 headers, when it is current. Same guard as nodeTip(): a node that is behind would
// hand over a stale window and the timeline would draw the wrong ten hours.
function nodeBlockHistory() {
  const n = model.node;
  if (!nodeTip()) return null;
  const rb = n && n.recent_blocks;
  if (!Array.isArray(rb) || rb.length < 12) return null;
  return rb.map((b) => ({ height: b.height, timestamp: b.time }));
}
let nodeProbed = false; // has node.json been fetched even once? (either answered or 404'd)
async function pollBlockTimes() {
  // Your own node first: block timestamps live in the headers, which every node keeps (a pruned node drops
  // block bodies, never headers). When it can answer, these five mempool.space requests don't happen at all.
  const local = nodeBlockHistory();
  if (local && applyBlockHistory(local)) return;
  // At boot this runs before the first node.json has landed, so "no node history" cannot yet be distinguished
  // from "no node". Fetching then would spend the external requests a node was about to make unnecessary —
  // so wait to be told. pollNode kicks this off the moment it knows there is nothing local to use.
  if (!nodeProbed) return;
  try {
    const first = await (await fetch(`${API}/v1/blocks`)).json();
    if (!Array.isArray(first) || !first.length) return;
    const tip = first[0].height;
    const more = await Promise.all([15, 30, 45, 60].map((d) => fetch(`${API}/v1/blocks/${tip - d}`).then((r) => r.json()).catch(() => [])));
    const byH = new Map();
    for (const b of [first, ...more].flat()) if (b && b.height != null && b.timestamp != null) byH.set(b.height, b.timestamp);
    // Same shaping as the node path — one place decides what counts as a usable interval.
    applyBlockHistory([...byH].map(([height, timestamp]) => ({ height, timestamp })));
  } catch (_) {}
}
// Same-origin feed from your local node (written by the bridge from bitcoind:
// getpeerinfo / getblockchaininfo). No external query; 404/error → no node data.
// Polled on its own fast cadence so head + per-peer rates stay fresh and the fill flows.
async function pollNode() {
  if (typeof syncDemo !== "undefined" && syncDemo) return; // demo mode supplies model.node itself
  try {
    const r = await fetch("./node.json", { cache: "no-store" });
    model.node = r.ok ? await r.json() : null;
    // remember the last moment the node was genuinely up + has chain data, so a brief drop (e.g. the engines
    // restarting when you save settings) can show "reconnecting…" instead of a scary "no node connected".
    if (model.node && model.node.reachable !== false && ((model.node.headers || 0) > 0 || (model.node.blocks || 0) > 0)) model.nodeLastOk = Date.now();
    // The node ships its own recent headers, so refresh the block-times history here on the 3s cadence rather
    // than waiting for pollBlockTimes' 300s timer — a new block shows up on the timeline almost immediately.
    { const local = nodeBlockHistory();
      if (local) applyBlockHistory(local);
      // First probe finished. If the node cannot supply the history, release pollBlockTimes to go get it now
      // rather than leaving the histogram empty until its next 120s tick.
      const firstProbe = !nodeProbed; nodeProbed = true;
      if (firstProbe && !local) pollBlockTimes(); }
    // desktop managed mode: poll the app's own provisioning feed so the dashboard can narrate the REAL setup phase
    // (downloading Core, loading snapshot %, syncing…) and surface any error — not just a generic "starting".
    if (isDesktop && nodeMode === "managed") { try { const sr = await fetch("./node-status", { cache: "no-store" }); nodeSetup = sr.ok ? await sr.json() : nodeSetup; } catch { /* keep the last known phase on a blip */ } }
    // the local node sees a new block within ~3s; if it's ahead of our last mempool fetch, refresh now
    // so the elapsed/countdown stays synced with current mining instead of lagging up to REFRESH_MS
    const n = model.node;
    if (n && n.nettotals) { // derive up/down rate (bytes/s) from successive cumulative samples
      const nt = n.nettotals;
      if (bwLast && nt.ms > bwLast.ms) { const dt = (nt.ms - bwLast.ms) / 1000; if (dt > 0) { model.bwHistory.push({ down: Math.max(0, (nt.recv - bwLast.recv) / dt), up: Math.max(0, (nt.sent - bwLast.sent) / dt) }); if (model.bwHistory.length > 120) model.bwHistory.shift(); } }
      bwLast = nt;
    }
    if (n && n.reachable !== false && !n.initialblockdownload && Math.floor(n.blocks || 0) > (model.tipHeight || 0)) refresh();
    // rebuild the EXACT 80-byte header the daemon hashed → the whole HASH BUILD shows the real block,
    // and we verify our double-SHA256 reproduces the daemon's submitted hash byte-for-byte
    const at = n && n.miner && n.miner.attempt;
    if (at && at.hash && at.version != null && at.timestamp != null && at.prev_hash && at.merkle_root && at.bits != null) {
      if (!model.liveBuild || model.liveBuild.hash !== at.hash) {
        const header = serializeHeader({ version: at.version, previousblockhash: at.prev_hash, merkle_root: at.merkle_root, timestamp: at.timestamp, bits: at.bits }, at.nonce);
        const h1 = await sha256(header), h2 = await sha256(h1), disp = bytesToHex([...h2].reverse());
        model.liveBuild = {
          hash: at.hash, height: at.height, version: at.version, prevHash: at.prev_hash, merkleRoot: at.merkle_root,
          timestamp: at.timestamp, bits: at.bits, nonce: at.nonce, txCount: at.tx_count,
          hash1Display: bytesToHex([...h1].reverse()), hash2Display: disp,
          leadingZeroBits: at.leading_zero_bits, target: at.target,
          below: at.target ? bigHex(at.hash) <= bigHex(at.target) : false,
          verified: disp === at.hash,
        };
      }
    } else model.liveBuild = null;
  } catch { model.node = null; }
}

// A failed request is one of two very different things, and treating them the same is how a polite client
// becomes an abusive one:
//   • network failure  — the host is unreachable. Nothing reaches mempool.space, so retrying costs it
//                        nothing and we retry quickly (a wifi blip / lid-open should recover in seconds).
//   • HTTP error       — we DID reach it and it said no (429 rate-limit, 5xx). Retrying hard here is
//                        exactly the wrong response: it adds load precisely when the server is asking for
//                        less. Back off well past the normal cadence, and obey Retry-After if it sends one.
// fetch() only rejects on the first kind — a 429 RESOLVES, so without an explicit res.ok check it slips
// through and gets handled as if the host were down.
class HttpError extends Error {
  constructor(res) { super(`HTTP ${res.status}`); this.status = res.status; this.retryAfter = retryAfterMs(res); }
}
function retryAfterMs(res) {
  const h = res && res.headers && res.headers.get && res.headers.get("Retry-After");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);            // delta-seconds form
  const at = Date.parse(h);                                             // or an HTTP-date
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new HttpError(res);
  return res;
}
// Set only when the server itself pushed back. The 30s setInterval keeps firing regardless, so without this
// guard a backoff would be meaningless — we'd still hit the host every 30s while "backing off".
let backoffUntil = 0;
// Apply a tip block (from EITHER source — the node's tip_block or mempool.space's /block) to the model:
// the NEXT BLOCK / VERIFY / AVALANCHE panels and the machine's ticket. Source-agnostic because the bridge
// publishes the tip in mempool.space's exact field shape (see tip_block_from_core in node_bridge.py).
async function applyTipBlock(blk) {
  model.tipHeight = blk.height;
  model.block = blk;
  model.txCount = blk.tx_count;
  model.difficulty = blk.difficulty;
  computeVerify(blk); // recompute this real block's proof-of-work for the VERIFY THIS BLOCK panel
  computeAvalanche(blk); // precompute the single-bit-flip hashes for THE AVALANCHE panel
  // hash ONCE per (block, seed) — cache it so the 30s refresh doesn't re-hash an unchanged block
  const seed = machineSeed();
  if (!model.ticket || model.ticket.height !== blk.height || model.ticket.seed !== seed) {
    const nonce = await pickNonce(seed, blk.height);
    const h1 = await sha256(serializeHeader(blk, nonce));   // 1st SHA-256 round
    const hashHex = bytesToHex(await sha256(h1));            // 2nd round (the "double") = our submission
    const target = bitsToTarget(blk.bits);
    const avNonce = (nonce + 1) >>> 0;
    const avH1 = await sha256(serializeHeader(blk, avNonce)); // same header, nonce+1 → totally different (avalanche)
    const avalancheHex = bytesToHex(await sha256(avH1));
    model.ticket = { height: blk.height, seed, nonce, hash1Hex: bytesToHex(h1), hashHex, prox: proximity(hashHex, target), avNonce, avHash1Hex: bytesToHex(avH1), avalancheHex };
  }
}
// Your own synced node already knows the tip — use ITS block header (delivered same-origin in node.json every
// ~4s by the bridge) rather than fetching it from mempool.space every 30s. Faster (the 3s node poll beats the
// 30s external one) AND two fewer public-API calls per cycle for the common case of a node-running user. Falls
// back to mempool.space for the public demo and while a node is still syncing (no meaningful local tip yet).
function nodeTip() {
  const n = model.node;
  if (!n || n.reachable === false || n.initialblockdownload) return null;
  // The same guard as the bridge's tip_is_current(). initialblockdownload is NOT enough: a node whose machine
  // slept is not in IBD (Core latches that flag false once caught up) yet can be hundreds of blocks behind,
  // and its tip is then a hours-old block this would render as "now" — the NEXT BLOCK overrun counting DOWN
  // as the node catches up. Checked here as well as in the bridge because node.json on disk can have been
  // written by an older bridge than the dashboard reading it.
  if (typeof n.blocks === "number" && typeof n.headers === "number" && n.headers - n.blocks > 1) return null;
  const tb = n.tip_block;
  if (!tb || tb.id == null || tb.bits == null || tb.height == null) return null;
  return tb;
}
async function refresh(fromRetry = false) {
  if (!fromRetry && backoffUntil && Date.now() < backoffUntil) return;
  try {
    const nt = nodeTip();
    if (nt) {
      await applyTipBlock(nt); // tip from YOUR node — no mempool.space round-trip for the block header
    } else {
      const tipHash = await (await api("/blocks/tip/hash")).text();
      await applyTipBlock(await (await api(`/block/${tipHash}`)).json());
    }

    fetch(`${API}/v1/blocks`).then((r) => r.json()).then((arr) => {
      if (Array.isArray(arr)) model.recentBlocks = arr.slice(0, 8).reverse().map((b) => ({ height: b.height, id: b.id, tx: b.tx_count, size: b.size, pool: b.extras?.pool?.name, lottery: coinbaseHasLotteryTag(b.extras?.coinbaseRaw) }));
    }).catch(() => {});
    // NOTE: price, 3-day hashrate and difficulty-adjustment used to be fetched here every 30s. They barely move
    // — a 5-min cadence is visually identical — so they now ride loadHistory()'s 300s timer instead, cutting 3
    // of every 10 calls this loop made. Only genuinely time-varying data (the tip + the mempool group below,
    // which feeds the live tx-flow viz) stays on the 30s cadence. See refreshSlow().
    // The mempool GROUP — the histogram, the projected-blocks treemap, the live tx feed, the fee weather — is
    // drawn ONLY inside the expanded MEMPOOL panel (and the tx feed also in MERKLE). So fetch it only when that
    // data is on screen. When the MEMPOOL panel is collapsed and your synced node already knows the pending
    // count (getmempoolinfo, in node.json), the header reads that and we make ZERO of these calls. The public
    // demo, and a blocksonly node with no mempool of its own, still fetch — they have no local count to show.
    // This is visibility-gating, NOT node substitution: the projection + pool identification are mempool.space's
    // own analysis, which a bare node can't reproduce, so the expanded panel always draws them from mempool.space.
    const mpOpen = expanded.has("mempool");
    const nodeMpCount = nodeMempoolCount(); // pending-tx count from YOUR node, or null (demo / syncing / blocksonly)
    if (mpOpen || nodeMpCount == null) {
      // the header needs a count even when collapsed, so a node-less client fetches /mempool for it; the
      // projection + fee weather are only meaningful expanded, so they ride along only when the panel is open.
      fetch(`${API}/mempool`).then((r) => r.json()).then((mp) => {
        if (mp && mp.count != null) model.mempool = { ...(model.mempool || {}), count: mp.count, vsize: mp.vsize, hist: mp.fee_histogram || [], blocks: model.mempool?.blocks || [] };
      }).catch(() => {});
      if (mpOpen) {
        fetch(`${API}/v1/fees/mempool-blocks`).then((r) => r.json()).then((blocks) => {
          if (Array.isArray(blocks)) model.mempool = { ...(model.mempool || { count: nodeMpCount || 0 }), blocks };
        }).catch(() => {});
        fetch(`${API}/v1/fees/recommended`).then((r) => r.json()).then((f) => { if (f && f.fastestFee != null) model.fees = f; }).catch(() => {}); // next-block fee → "fee weather"
      }
    }
    // the actual most-recent transactions — real fee/size/value — feed the MEMPOOL particles/whales AND the
    // MERKLE tree's leaf txids, so fetch them only when one of those panels is open.
    if (mpOpen || expanded.has("merkle")) {
      fetch(`${API}/mempool/recent`).then((r) => r.json()).then((txs) => { if (Array.isArray(txs)) model.recentTxs = txs.filter((t) => t && t.vsize); }).catch(() => {});
    }
    model.error = null;
    model.chainOkAt = Date.now();
    retryDelay = 0; backoffUntil = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
  } catch (e) {
    // ONE unreachable host must never take the whole dashboard down: keep the last known chain data on
    // screen (and everything that doesn't come from mempool.space at all — your node, your ticket, the
    // SHA-256 panels) and say so in a small corner notice. See drawOfflineNotice.
    const http = e instanceof HttpError;
    model.error = !http ? "can't reach mempool.space"
      : e.status === 429 ? "mempool.space is rate-limiting us — backing off"
      : `mempool.space returned ${e.status} — backing off`;
    scheduleChainRetry(e);
  }
}
// Unreachable → retry fast (5s → 10s → 20s → 30s): a laptop waking or a wifi blip recovers in seconds, and
// none of those attempts touch the server. Server said no → start ABOVE the normal cadence and double from
// there, so we ask progressively less often rather than more.
const BACKOFF_MAX_MS = 15 * 60_000;
let retryTimer = 0, retryDelay = 0;
function scheduleChainRetry(err) {
  if (retryTimer) return;
  const http = err instanceof HttpError;
  if (http && err.retryAfter != null) retryDelay = Math.min(BACKOFF_MAX_MS, Math.max(err.retryAfter, REFRESH_MS));
  else if (http) retryDelay = Math.min(BACKOFF_MAX_MS, retryDelay ? retryDelay * 2 : REFRESH_MS * 2);
  else retryDelay = Math.min(REFRESH_MS, retryDelay ? retryDelay * 2 : 5_000);
  if (http) backoffUntil = Date.now() + retryDelay; // also suppresses the 30s interval until then
  retryTimer = setTimeout(() => { retryTimer = 0; refresh(true); }, retryDelay);
}
// The machine slept / the network came back → refetch now rather than waiting out the interval. Deliberately
// NOT forced: coming back from sleep doesn't entitle us to ignore a 429 the server already gave us.
function recoverNow() { if (!backoffUntil || Date.now() >= backoffUntil) { retryDelay = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; } } refresh(); pollNode(); }
window.addEventListener("online", recoverNow);

// ---- canvas / painter ----
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, dpr = 1;
// user text-size / zoom: shrinks the LOGICAL coordinate space so the whole UI is drawn (and reflowed) larger while
// the physical bitmap keeps full devicePixelRatio — i.e. bigger AND crisp, never blurry. 1 = default; persisted.
// Pointer events are divided by this before hit-testing (see ptr() below) so clicks stay aligned.
let userScale = Math.min(1.6, Math.max(0.8, parseFloat(localStorage.getItem("uiScale")) || 1));
function resize() {
  const rawDpr = window.devicePixelRatio || 1, cw = canvas.clientWidth, ch = canvas.clientHeight;
  W = cw / userScale; H = ch / userScale;
  dpr = rawDpr * userScale;
  canvas.width = Math.round(cw * rawDpr); canvas.height = Math.round(ch * rawDpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function setUserScale(s) {
  const v = Math.min(1.6, Math.max(0.8, Math.round(s * 10) / 10));
  if (v === userScale) return;
  userScale = v;
  try { localStorage.setItem("uiScale", String(v)); } catch (_) {}
  resize(); requestRender();
}
window.addEventListener("resize", resize);

// accessibility / battery: honour prefers-reduced-motion (calm the ambient rain) and pause the
// animation loop entirely while the tab is hidden (no point burning CPU/battery on an unseen page)
// The matrix rain is the heaviest ambient effect; let users switch it off (remembered) while keeping the
// panel animations, which are informative (hash build, sync conveyor). The OS "reduce motion" accessibility
// setting still freezes panel motion for those who ask for it.
// Motion has three user-selectable levels (cycled via the top-left toggle), for weak machines / preference:
//   full → matrix rain + animated panels (~30fps)
//   calm → no rain, panels still animate (~30fps)
//   off  → nothing animates; the loop idles at a 1fps heartbeat and only repaints on real change
//          (new data / hover / scroll / resize) — near-zero CPU, the right setting for older Intel Macs.
let motionMode = "full";
try { motionMode = localStorage.getItem("bl.motion") || (localStorage.getItem("bl.rainoff") === "1" ? "calm" : "full"); } catch (_) {}
let osReduceMotion = false, reduceMotion = false, showRain = true, motionOff = false, winFocused = true;
let rafId = 0, lastDraw = 0, lastTickMs = 0; // lastTickMs: wall clock at the last frame — a big jump = the machine slept
function applyMotion() {
  motionOff = motionMode === "off";
  reduceMotion = osReduceMotion || motionOff;       // freeze panel animation (OS accessibility OR user "off")
  showRain = !reduceMotion && motionMode === "full"; // matrix rain only in Full (and not under OS reduce-motion)
}
// force a single repaint on the next frame (used when nothing is animating but state changed)
function requestRender() { lastDraw = 0; if (!rafId && !document.hidden) rafId = requestAnimationFrame(render); }
function setMotion(mode) { motionMode = mode; try { localStorage.setItem("bl.motion", mode); } catch (_) {} applyMotion(); requestRender(); }
function cycleMotion() { setMotion(motionMode === "full" ? "calm" : motionMode === "calm" ? "off" : "full"); }
try {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  osReduceMotion = mq.matches;
  mq.addEventListener("change", (e) => { osReduceMotion = e.matches; applyMotion(); requestRender(); });
} catch (_) { /* matchMedia unavailable */ }
applyMotion();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cancelAnimationFrame(rafId); rafId = 0; }
  else if (!rafId) { rafId = requestAnimationFrame(render); } // resume where we left off
});
try { winFocused = document.hasFocus(); } catch (_) {}
// B) throttle hard when the window is open but not focused — Electron keeps painting at full rate in the
// background otherwise. Snap back to a fresh frame the moment focus returns.
window.addEventListener("focus", () => { winFocused = true; requestRender(); });
window.addEventListener("blur", () => { winFocused = false; });

function text(s, x, y, { size = 16, weight = 400, color = "#fff", align = "left", baseline = "alphabetic", mono = false } = {}) {
  ctx.font = `${weight} ${size}px ${mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "-apple-system, system-ui, sans-serif"}`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}
// text with a dark rounded background pill behind it — keeps labels readable over chart lines/fills
function chipText(s, x, y, o = {}) {
  const size = o.size || 16, pad = o.pad ?? 4;
  ctx.font = `${o.weight || 400} ${size}px ${o.mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "-apple-system, system-ui, sans-serif"}`;
  const w = ctx.measureText(s).width, ax = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
  ctx.fillStyle = o.bg || "rgba(5,4,10,0.78)";
  roundRect(ax - pad, y - size / 2 - 3, w + pad * 2, size + 6, 3); ctx.fill();
  text(s, x, y, { size, weight: o.weight, color: o.color, align: o.align, baseline: o.baseline || "middle", mono: o.mono });
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// ---- matrix rain background ----
let columns = [];
function rainPool() {
  const p = [];
  if (model.ticket?.hashHex) p.push(model.ticket.hashHex);
  if (model.block?.merkle_root) p.push(model.block.merkle_root);
  if (model.block?.previousblockhash) p.push(model.block.previousblockhash);
  return p.length ? p : ["0123456789abcdef0123456789abcdef0123456789abcdef"];
}
const RAIN_SP = 18, RAIN_MAX = 30;
function spawnColumn(x, pool, initial = false) {
  return {
    x,
    // each encoder tip enters from the top (age 0) and falls, expanding its hash
    // as it descends — no mid-screen pop-ins. (Only the initial fill is scattered
    // so the field isn't empty at load.)
    y: initial ? Math.random() * H : -RAIN_SP * Math.random() * 3,
    speed: 1.1 + Math.random() * 2.8,
    growth: 0.12 + Math.random() * 0.34, // chars/frame — randomized so some tails grow faster
    hash: pool[Math.floor(Math.random() * pool.length)],
    age: initial ? Math.floor(Math.random() * 180) : 0,
    delay: initial ? 0 : Math.floor(Math.random() * 55), // random pause before the next glyph appears
    genAt: Math.floor(Math.random() * 130), // frames the bare tip falls before it starts generating the hash
  };
}
function ensureRain() {
  const spacing = 26, count = Math.ceil(W / spacing);
  if (columns.length === count) return;
  const pool = rainPool();
  columns = Array.from({ length: count }, (_, i) => spawnColumn(i * spacing + spacing / 2, pool, true));
}
function drawRain() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#06040c"); g.addColorStop(1, "#0a0603");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (!showRain) return; // Calm/Off (or OS reduce-motion): keep the gradient backdrop, skip the falling rain
  ensureRain();
  const pool = rainPool();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const c of columns) {
    if (c.delay > 0) { c.delay--; continue; } // random pause, then a fresh glyph appears
    c.age++; c.y += c.speed;
    // The bare encoder tip falls alone until `genAt`, then the hash starts
    // generating and the tail expands from it (random start time per streak).
    const genAge = c.age - c.genAt;
    const tail = genAge <= 0 ? 0 : Math.min(RAIN_MAX, Math.floor(genAge * c.growth));
    if (c.y - tail * RAIN_SP > H + RAIN_SP) { Object.assign(c, spawnColumn(c.x, pool)); continue; }
    for (let i = 0; i <= tail; i++) {
      const yy = c.y - i * RAIN_SP;
      if (yy < -RAIN_SP || yy > H + RAIN_SP) continue;
      let ch;
      if (i === 0) {
        // encoding tip: scrambling matrix glyphs (the generator)
        ch = CYBER[(frame + Math.floor(c.x)) % CYBER.length];
        ctx.font = "700 19px ui-monospace, monospace"; ctx.fillStyle = "rgba(255, 190, 70, 0.95)";
      } else {
        // the generated hash: newest char sits next to the tip, hash[0] at the
        // far tail end — so the sequence advances as the tip generates.
        ch = c.hash[(tail - i) % c.hash.length];
        ctx.font = "17px ui-monospace, monospace";
        ctx.fillStyle = `rgba(60, 175, 130, ${Math.max(0.04, 0.62 * (1 - i / RAIN_MAX))})`;
      }
      ctx.fillText(ch, c.x, yy);
    }
  }
  const s = ctx.createLinearGradient(0, H * 0.18, 0, H * 0.82);
  s.addColorStop(0, "rgba(5,4,10,0)"); s.addColorStop(0.5, "rgba(5,4,10,0.5)"); s.addColorStop(1, "rgba(5,4,10,0)");
  ctx.fillStyle = s; ctx.fillRect(0, 0, W, H);
}

// ---- quotes ---- (strings are original; {q, src} carries a movie/source attribution)
const QUOTES = [
  { q: "So you're tellin' me there's a chance?", src: "Lloyd Christmas, Dumb and Dumber" },
  { q: "You've got to ask yourself one question: do I feel lucky? Well, do ya, punk?", src: "Dirty Harry" },
  "Someone wins every block. Why not you?",
  "One ticket per block. One shot at glory.",
  "The lottery is hope with a timestamp.",
  "One in 2²⁵⁶ is still one.",
  "Every hash is a roll of the cosmic dice.",
  "Feel the odds: every heads is a bit, every four in a row is one leading zero. A win: ~79 heads (about 20 zeros), no tails.",
  "Statistically improbable ≠ impossible.",
  "The hash doesn't know it's supposed to be impossible.",
  "Ten minutes to the next block. Ten minutes to glory.",
  "Your nonce might be the one.",
  "Difficulty is just the house edge.",
  "Somewhere, a winning hash is waiting.",
  "No jackpot was ever won by sitting out.",
  "Proof of work. Proof of hope.",
  "It only takes one valid hash.",
  "The dice are 256 bits wide.",
  "Every block, the whole world plays. One wins.",
  "Trust the math. Play the dream.",
  { q: "Never tell me the odds.", src: "Han Solo, Star Wars" },
  { q: "May the odds be ever in your favor.", src: "Effie Trinket, The Hunger Games" },
  { q: "So you're telling me there's a chance!", src: "Lloyd Christmas, Dumb and Dumber" },
  { q: "Hope is a good thing, maybe the best of things.", src: "Andy Dufresne, The Shawshank Redemption" },
  { q: "If you build it, it will come.", src: "the Voice, Field of Dreams" },
  { q: "Life is like a box of chocolates.", src: "Forrest Gump" },
  { q: "Carpe diem. Seize the block.", src: "John Keating, Dead Poets Society" },
  { q: "We are the music makers, and we are the dreamers of dreams.", src: "Willy Wonka" },
  { q: "If you want to view paradise, simply look around and view it.", src: "Willy Wonka" },
  { q: "A little nonsense now and then is relished by the wisest men.", src: "Willy Wonka" },
  { q: "So shines a good deed in a weary world.", src: "Willy Wonka" },
  { q: "The suspense is terrible — I hope it'll last.", src: "Willy Wonka" },
  { q: "Come with me, and you'll be in a world of pure imagination.", src: "Willy Wonka" },
  // you really could win a whole block with a single hash — even one done by hand
  "One hash by hand could win a whole block.",
  "A hash is a hash — whether a chip or a pencil found it.",
  "Pen, paper, and one lucky hash: a valid lottery ticket.",
  "Compute one SHA-256 by hand. Below the target? You mined a block.",
  "The network can't tell if a human or a warehouse found the nonce.",
  // more — philosophical
  "Every block resets the odds — the past owes you nothing.",
  "The odds on any one block never improve — but your odds of ever winning do, one ticket at a time.",
  "Vanishingly small is still larger than zero.",
  "The chain rewards luck and work alike.",
  "Hope is the cheapest hash you'll ever compute.",
  // more — funny
  "Statistically, you should've quit 9 quintillion hashes ago.",
  "It's not gambling if you call it proof-of-work.",
  "Somebody has to be absurdly lucky. Probably not you — but somebody.",
  // more — movies
  { q: "Do, or do not. There is no try.", src: "Yoda, The Empire Strikes Back" },
  { q: "Just keep swimming.", src: "Dory, Finding Nemo" },
  { q: "To infinity and beyond!", src: "Buzz Lightyear, Toy Story" },
  { q: "'Inconceivable'? You keep using that word. I do not think it means what you think it means.", src: "Inigo Montoya, The Princess Bride" },
  { q: "Adventure is out there!", src: "Ellie, Up" },
  // from Bitcoin's history
  { q: "Chancellor on brink of second bailout for banks", src: "The Times — Bitcoin's genesis block, 2009" },
  { q: "Running bitcoin", src: "Hal Finney, 2009" },
  { q: "It might make sense just to get some in case it catches on.", src: "Satoshi Nakamoto, 2009" },
  { q: "Lost coins only make everyone else's coins worth slightly more.", src: "Satoshi Nakamoto" },
  { q: "If you don't believe me or don't get it, I don't have time to try to convince you, sorry.", src: "Satoshi Nakamoto" },
  { q: "I'll pay 10,000 bitcoins for a couple of pizzas.", src: "Laszlo Hanyecz, 2010" },
  { q: "Vires in numeris — strength in numbers.", src: "Bitcoin motto" },
  // real-world long shots — all far likelier than solo-mining a block, yet they happen to someone
  "Struck by lightning this year: about 1 in a million. A block is a longer shot — and still gets found.",
  "Powerball jackpot: 1 in 292 million. Someone wins it anyway.",
  "A royal flush off the deal: 1 in 650,000 — practically a sure thing next to a block.",
  "Hole-in-one: about 1 in 12,500. The course never calls it impossible.",
  "Find a four-leaf clover: about 1 in 5,000. Keep looking down.",
  "Lightning finds someone every single day. A winning block, every ten minutes.",
  "Rare is not never. Ten minutes from now, somebody wins.",
  "The unlikeliest thing today already happened to somebody.",
  "Every winner was once 'statistically unlikely.'",
  "Someone buys the winning ticket — hands shaking, almost didn't.",
  "The odds you exist — this exact sperm, this exact egg — are about 1 in 400 trillion. You already won a longer lottery.",
  "Just by being born, you beat odds longer than any block. The unlikeliest thing already happened — it's you.",
];
const quoteText = (i) => (typeof QUOTES[i] === "string" ? QUOTES[i] : QUOTES[i].q);
const quoteSrc = (i) => (typeof QUOTES[i] === "string" ? "" : QUOTES[i].src);

// ---- layout + sections ----
const PAD = 36, HEADER_H = 40, GAP = 12, TOP = 122; // TOP 116 -> 122 with the header block: the subtitle moved off the title
const CONTENT_H = { win: 150, nextBlock: 214, mempool: 256, closeness: 278, tickets: 180, merkle: 300, hashBuild: 366, avalanche: 206, verify: 262, hashInside: 478, fold: 268, oneRound: 454, shift: 282, churn: 424, sigma1: 300, ch: 258, maj: 252, bitOps: 306, network: 215, broadcast: 250, sync: 540, updates: 460 };
// Lab flag — the deep, still-evolving hashing panels (SHIFT / CHURN / ONE STEP · Σ1·Ch·Maj, plus the register
// breakout + shift-format churn inside INSIDE THE HASH) are hidden from the public demo + shipped app so users
// don't see work-in-progress. On by default on a `lab.` host (e.g. lab.notzero-demo.pages.dev — a private
// preview URL, never linked publicly); elsewhere opt in with ?lab=1 (persists), off with ?lab=0.
let LAB = true; // SHIPPED — the INSIDE THE HASH deep dive (THE CHURN, the ONE STEP panels, THE SHIFT, the register breakout) is now public. Opt OUT with ?lab=0 (persists) for the older simplified view.
try {
  const _lp = new URLSearchParams(location.search).get("lab");
  if (_lp === "0") localStorage.setItem("bl.lab", "0");
  else if (_lp === "1") localStorage.removeItem("bl.lab");
  LAB = localStorage.getItem("bl.lab") !== "0";
} catch {}
const LAB_SECTIONS = new Set(["shift", "churn", "sigma1", "ch", "maj"]);
if (!LAB) CONTENT_H.hashInside = 300; // simpler INSIDE THE HASH (no register breakout / shift-format churn)
// Panel height, plus room for rows that only exist in some states. NETWORK lays its charts out with whatever
// vertical space is left after the text rows (ch = r.y + r.h - y - 6), so a row added without a matching
// height increase doesn't push the panel taller — it silently steals from the charts, squashing them and
// running their labels together. Anything conditional drawn above those charts has to be declared here.
const ROW_H = 19;
function contentH(s) {
  let h = CONTENT_H[s];
  if (s === "network" && model.node && model.node.miner_proc && model.node.miner_proc.node) h += ROW_H; // the node's CPU/RAM row
  return h;
}
// INSIDE THE HASH is a parent panel: the deeper hashing dives nest under it (indented), so collapsing it
// hides them all at once — the whole SHA-256 explainer folds into one section.
const HASH_CHILDREN = new Set(["fold", "oneRound", "shift", "churn", "sigma1", "ch", "maj", "bitOps"]);
const BUILD_CHILDREN = new Set(["merkle", "avalanche", "verify", "hashInside"]); // everything hashing nests under HASH BUILD; INSIDE THE HASH is itself a sub-parent (its dives = HASH_CHILDREN, one level deeper)
let headerHits = [];
let hashInputHit = null; // click region for the INSIDE THE HASH typeable input (in scrolled content coords)
let ticketHits = [], youHit = null, bestHit = null, mempoolHits = []; // hover hit-regions (content coords): YOUR TICKETS bars + the odds-map "you" / "best ◆" markers + MEMPOOL blocks
// --- WIN celebration: the payoff of "not zero". Auto-fires when a real win lands; previewable on
// demand via the top-right control (you would otherwise never get to see it). ---
const celebration = { active: false, t: 0, preview: false, mode: "you", verified: true, height: 0, hash: "", reward: 3.125 };
let broadcastBurstUntil = 0; // BROADCAST panel fires an intense "block found" burst for a window after a win
let seenConfirmedWin = -1, winPreviewHit = null, netWinHit = null, winStatusHit = null, gearHit = null, blockPreviewHit = null, motionHit = null, zoomOutHit = null, zoomInHit = null, ambientHit = null;
let mpPreview = false, syncPreview = false; // "preview a block" → replay the mempool harvest + the sync's mined-block commit
// the desktop app serves a /config endpoint; the public web build doesn't — so this both detects "are we in
// the desktop app" and gates the settings gear (which navigates to /setup, a desktop-only route).
let isDesktop = false, appVersion = "", nodeMode = "", desktopPlatform = "", updatePendingVer = "", updateVerification = null, versionAnchor = null, updateHistory = null, updatePillHit = null, updateDownload = null;
// The ambient view is opened through /ambient-open, which only the desktop app's local server answers — so the
// control is drawn on localhost only and never appears on the public demo, where it could not do anything.
const HAS_AMBIENT_BTN = location.hostname === "127.0.0.1" || location.hostname === "localhost";
let consensusHit = null; // hit region for the "network rule change" banner (Core's `warnings` canary) → click checks for an update
let fakeWarn = ""; // ?fakewarn= preview override for the consensus banner (so the UI can be seen without a real fork)
let nodeSetup = null; // desktop managed-node provisioning feed (/node-status): {state, progress, detail} — real setup phase for the dashboard to narrate
let updPaused = false, updStep = 0, updPlayHit = null, updBackHit = null, updFwdHit = null, updStreams = {}; // VERIFIED UPDATES step-through transport + water-pipe stream state
// per-step durations (ms) — step 2 (stamp: stream → hash → orange → store → blink) and step 5 (rebuild) need more room
const UPD_DUR = [3200, 6200, 3200, 3200, 5200, 3800], UPD_CYC = UPD_DUR.reduce((a, b) => a + b, 0);
const updAutoStep = (now) => { let tt = now % UPD_CYC; for (let i = 0; i < UPD_DUR.length; i++) { if (tt < UPD_DUR[i]) return i; tt -= UPD_DUR[i]; } return UPD_DUR.length - 1; };
const updAutoSub = (now) => { let tt = now % UPD_CYC; for (let i = 0; i < UPD_DUR.length; i++) { if (tt < UPD_DUR[i]) return tt / UPD_DUR[i]; tt -= UPD_DUR[i]; } return 1; };
let configTimer = null;
function pollConfig() {
  fetch("./config").then((r) => (r.ok ? r.json() : null)).then((c) => {
    if (c && typeof c.exists === "boolean") { isDesktop = true; if (localStorage.getItem("uiScale") === null) setUserScale(1.1); /* the desktop app ships a touch larger by default (users can dial it back with A−) */ if (c.app_version) appVersion = c.app_version; if (c.node_mode) nodeMode = c.node_mode; if (c.platform) desktopPlatform = c.platform; updatePendingVer = c.update_available || ""; updateVerification = c.update_verification || null; versionAnchor = c.version_anchor || null; updateHistory = c.update_history || null; updateDownload = c.update_download || null; requestRender(); }
  }).catch(() => {}).finally(() => {
    // poll fast while an update is available or downloading (so "Downloading… X%" stays live), otherwise relaxed
    const fast = isDesktop && (updateDownload || updatePendingVer);
    clearTimeout(configTimer); try { configTimer = setTimeout(pollConfig, fast ? 2500 : 90000); } catch (_) {}
  });
}
pollConfig();
// main → renderer push hooks (via webContents.executeJavaScript) so update feedback is INSTANT, not gated on the
// next /config poll. __notzeroPokeConfig: refresh now (engages the fast cadence). __notzeroUpdateStarting: the
// user just pressed "Update Now" — show an active pill this instant, before the first byte downloads.
window.__notzeroPokeConfig = () => { try { pollConfig(); } catch (_) {} };
window.__notzeroUpdateStarting = () => { isDesktop = true; if (!updateDownload) updateDownload = { percent: 0, preparing: true }; requestRender(); try { pollConfig(); } catch (_) {} };
try { const fu = new URLSearchParams(location.search).get("fakeupdate"); if (fu) { isDesktop = true; updatePendingVer = fu; } } catch (_) {} // local pill preview
try { const fd = new URLSearchParams(location.search).get("fakedl"); if (fd) { isDesktop = true; updateDownload = { percent: +fd }; } } catch (_) {} // local "downloading" pill preview
try { const fw = new URLSearchParams(location.search).get("fakewarn"); if (fw) { isDesktop = true; fakeWarn = fw === "1" ? "Unknown new rules activated (versionbit 4)" : fw; } } catch (_) {} // local consensus-banner preview
try { const fv = new URLSearchParams(location.search).get("fakeverify"); if (fv) { const [lvl, ver, h] = fv.split(":"); isDesktop = true; updateVerification = { level: lvl, version: ver || updatePendingVer || "0.1.30", height: h ? +h : undefined }; } } catch (_) {} // VERIFIED UPDATES status preview
try { if (new URLSearchParams(location.search).get("fakehistory")) { isDesktop = true; updateHistory = [ { version: "0.1.30", level: "pending", current: true }, { version: "0.1.29", level: "onchain", height: 957017, current: false }, { version: "0.1.28", level: "onchain", height: 955210, current: false }, { version: "0.1.27", level: "none", current: false } ]; } } catch (_) {} // VERIFIED UPDATES history preview
const dismissedLost = new Set(); // heights whose 'lost the race' notice the user has dismissed
const blockSubsidy = (h) => 50 / Math.pow(2, Math.floor((h || 0) / 210000));
function fireCelebration({ preview = false, mode = "you", verified = true, height = 0, hash = "", reward } = {}) {
  Object.assign(celebration, { active: true, t: 0, preview, mode, verified, height: height || 0, hash: hash || "", reward: reward != null ? reward : blockSubsidy(height) });
  broadcastBurstUntil = Date.now() + 90_000; // the BROADCAST panel shows the "block found" burst for ~90s after
}
// new-best toast: a small, non-intrusive reward when the miner beats its own leading-zero record
// (the mid-tier rung: everyday attempts → new best → a lottery miner wins → you win)
let seenBest = -1, bestToastHit = null;
const bestToast = { t: 0, active: false, bits: 0 };
function fireBestToast(bits, hash) { bestToast.active = true; bestToast.t = 0; bestToast.bits = bits; bestToast.odds = hash ? oddsExact(rarityBits(hash)) : ""; } // persists until clicked
// --- network-win detection: the win announces itself ON-CHAIN via the coinbase tag the miner already
// writes (/BitcoinLottery/…). No server, no phone-home — we just read the public coinbase. ---
const LOTTERY_TAG = "/BitcoinLottery/";
function coinbaseHasLotteryTag(coinbaseRaw) {
  if (!coinbaseRaw || typeof coinbaseRaw !== "string") return false;
  const hex = coinbaseRaw.slice(0, 400); // coinbase scriptSig ≤ 100 bytes (200 hex) — cap untrusted input
  let s = ""; for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s.includes(LOTTERY_TAG);
}
let seenLottery = null; // Set of heights seen this session (null until first observation, so we don't fire on load)
// merge lottery-tagged blocks from the bridge (your local node = trustless/verified) + mempool.space
// (third party = unverified; could be spoofed by anyone's coinbase or a MITM). newest first, deduped.
function lotteryWins() {
  const out = new Map();
  const bridge = (model.node && model.node.lottery_blocks) || [];
  for (const b of bridge) if (b && b.height != null) out.set(b.height, { height: b.height, hash: b.hash || "", verified: true });
  for (const b of (model.recentBlocks || [])) if (b && b.lottery && b.height != null && !out.has(b.height)) out.set(b.height, { height: b.height, hash: b.id || "", verified: false });
  return [...out.values()].sort((a, b) => b.height - a.height);
}
let scrollY = 0, maxScroll = 0, scrollToSection = null; // scrollToSection: bring a panel into view on the next frame (e.g. "preview a block" → the mempool harvest)
const FOOTER_PAD = 44; // bottom clearance under the scrollable content so the fixed footer never sits on a panel
let clock = 0, quoteIdx = (Math.random() * QUOTES.length) | 0, quoteT = 0, frame = 0, quoteNext = 1, quotePhase = "hold"; // random start so refresh doesn't always begin at the first quote
// seconds: hold the quote, then morph to the next. 2.2 rather than the 3.6 the constant-speed crossing needed:
// with Q_PACE the margins are covered at ~1077 px/s and the text at ~359, so the approach costs 0.51s instead of
// 1.12s while each character actually gets LONGER to morph (0.42s, up from 0.34s).
const Q_HOLD = 11, Q_DECODE = 2.2;
// Random order, every quote once before any repeats, and no repeat close to the seam between passes.
// See quote-bag.js for why the seam needed its own guard and what it was doing before.
const nextQuoteIdx = makeQuoteBag(QUOTES.length, 12);
// A quote changing over, as ONE continuous morph. Every column runs old char → churning glyph → new char on
// its own scattered schedule, and nothing ever pops into or out of existence:
//
//   * one interpolated layout, not two. The quotes differ in length and each is centred on its own width, so
//     the earlier two-half version swapped layouts at the midpoint — every column jumped sideways at once, and
//     columns at the ends appeared or vanished outright. The centring is now lerped across the whole transition.
//   * columns cover max(from,to) length, and PRESENCE is a lerped alpha rather than a draw/skip decision. A
//     column that exists in only one of the two quotes — including where one has a space and the other a
//     letter — fades in or out instead of blinking on or off.
//   * the accent tint rises and falls with sin(pi*m), so the glyph phase has no hard colour switch at either
//     end; a settled character is the same white it was while held.
//
// Passing the same string as `from` and `to` with p = 0 renders a settled quote, so the hold state and the
// transition share one code path and cannot drift apart.
// A BAND OF GLYPHS travels left→right and does the work: text ahead of it is still the old quote, text behind it
// is the new one, and inside it everything is churning glyphs. The band starts beyond the left end of the line
// and finishes beyond the right, so it visibly arrives from outside the text and leaves the same way — the
// glyph columns extend into the empty margins for exactly that reason.
//
// Keyed on the head's X POSITION rather than on column index. Index-keyed sweeps make the head's apparent speed
// depend on the quote's length; a 38-character quote and a 61-character one would decode at different rates.
// Position-keyed, the band crosses the screen at one constant speed regardless.
const Q_HEAD_PX = 150;        // width of the churning band; the whole head, not a per-column duration
const Q_JITTER_PX = 26;       // per-column ragged edge, so it decodes rather than wiping like a progress bar
const Q_PACE = 0.5;           // 0 = constant speed; k<1 keeps it monotonic. (1+k)x at the edges, (1-k)x mid-text
function drawQuoteMorph(from, to, p, alpha, seed) {
  ctx.font = "600 16px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const charW = ctx.measureText("0").width, n = Math.max(from.length, to.length);
  // Columns are matched from the CENTRE out, not from index 0, and each character keeps its own exact centred
  // position. Lerping one whole-field origin to the other (the previous approach) dragged every character
  // sideways whenever the lengths differed — a short→long change read as the quote sliding in from the left.
  // Centre-aligning leaves at most a half-character residual between the two grids, and even that is eased, so
  // characters resolve essentially in place.
  const offF = Math.round((n - from.length) / 2), offT = Math.round((n - to.length) / 2);
  const sxF = W / 2 - (from.length * charW) / 2 + charW / 2;
  const sxT = W / 2 - (to.length * charW) / 2 + charW / 2;
  const ease = p * p * (3 - 2 * p);                                  // smoothstep: no hard start or stop
  // The band starts fully OFF-SCREEN left and ends fully off-screen right — it crosses the whole viewport, not
  // just the text. At p=0 the trailing edge is still past x=0 and at p=1 the leading edge is past W, so no
  // column has been touched at the start and every column has been passed at the end: the endpoints are exactly
  // the two held states. Travel therefore scales with the window, so a wider window means a faster band rather
  // than a longer transition.
  const travel0 = -Q_HEAD_PX, travel1 = W + Q_HEAD_PX;
  // Non-linear pacing: quick across the empty margins, slowing over the text. Both the viewport and the quote
  // are centred, so "slow in the middle" IS "slow over the text" — which avoids splitting the travel into
  // segments and the velocity jumps at their joins.
  //
  //   g(p) = p + (k/2pi)·sin(2pi·p)   →   g'(p) = 1 + k·cos(2pi·p)
  //
  // so the band runs at (1+k)× at both ends and (1-k)× in the middle, with speed varying continuously and no
  // stop-start. g(0)=0 and g(1)=1 exactly, so the endpoints are untouched and remain the two held states.
  const g = p + (Q_PACE / (2 * Math.PI)) * Math.sin(2 * Math.PI * p);
  const headX = travel0 + g * (travel1 - travel0);
  // Glyphs in the empty margins either side of the text — the stream arriving and departing. Drawn first so a
  // real character always sits on top of one. Alpha is sin(pi*s), so they fade in and out rather than blinking.
  if (p > 0 && p < 1) {
    // Columns are generated from the BAND's current position, not from a fixed range around the text. Anchoring
    // them to the text left the band travelling through empty space for the first quarter of the transition with
    // nothing to draw, so the stream was invisible until it reached the first character.
    const k0 = Math.ceil((headX - Q_HEAD_PX - sxT) / charW), k1 = Math.floor((headX - sxT) / charW);
    for (let k = k0; k <= k1; k++) {
      if (k >= 0 && k < n) continue;                                  // real columns are handled below
      const x = sxT + k * charW, sBand = (headX - x) / Q_HEAD_PX;
      if (sBand <= 0 || sBand >= 1) continue;
      const ga = Math.sin(Math.PI * sBand) * alpha * 0.5;
      if (ga <= 0.004) continue;
      ctx.fillStyle = `rgba(70,190,140,${ga})`;
      ctx.fillText(CYBER[(frame * 2 + (k + 99) * 9) % CYBER.length], x, 86);
    }
  }
  for (let i = 0; i < n; i++) {
    const fi = i - offF, ti = i - offT;
    const fc = fi >= 0 && fi < from.length ? from[fi] : "";
    const tc = ti >= 0 && ti < to.length ? to[ti] : "";
    // Where this column sits relative to the passing band. Jitter is in PIXELS here, so a long and a short
    // quote get the same ragged edge rather than one proportional to their length.
    const colX = sxT + i * charW;
    const jit = (hrand(seed * 17.3 + i * 3.7) - 0.5) * Q_JITTER_PX;
    const m = Math.max(0, Math.min(1, (headX - colX - jit) / Q_HEAD_PX));
    const aF = fc && fc !== " " ? 1 : 0, aT = tc && tc !== " " ? 1 : 0;
    const a = (aF + (aT - aF) * m) * alpha;
    if (a <= 0.004) continue;                                        // nothing to draw either side — never a pop
    // A column present in only one quote stays exactly where that quote puts it, so it fades without drifting.
    const xF = aF ? sxF + fi * charW : null, xT = aT ? sxT + ti * charW : null;
    const x = xF === null ? xT : xT === null ? xF : xF + (xT - xF) * ease;
    const tint = Math.sin(Math.PI * m);                              // 0 at both ends, 1 mid-morph
    if (m <= 0 || m >= 1) {
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillText(m >= 1 ? tc : fc, x, 86);
    } else {
      // Phosphor green while unresolved, white once settled — the terminal-decrypt cue, and it separates
      // "not known yet" from "this is the text". sin(pi*m) means no colour switch at either end.
      const r = Math.round(255 + (70 - 255) * tint), g = Math.round(255 + (190 - 255) * tint), b = Math.round(255 + (140 - 255) * tint);
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fillText(CYBER[(frame * 2 + i * 9) % CYBER.length], x, 86);
    }
  }
}
const VERSION = "web v0.118.0";
// masked owner wallet shown when there's no daemon/payout at all (e.g. GitHub Pages with no node).
// The daemon (node.json .payout) is authoritative when present; full address lives in node_bridge.py.
const DEFAULT_PAYOUT_MASKED = "bc1qxs…fph2fn";
const SYNC_DEBUG = false; // flip to true to print live fill/phase state at the bottom of the sync panel

// While the node is still syncing, the mining panels (next block / mempool / closeness / hash build)
// only show "come back once synced" placeholders. Collapse the dashboard to just the BLOCKCHAIN SYNC
// visualization + the NETWORK panel so the syncing screen is focused, not a wall of waiting panels.
// live sync figures, shared by the sync panel, its collapsed-header progress bar, and the focus logic
function syncInfo() {
  const n = model.node;
  if (!(n && n.reachable !== false && (n.headers || n.blocks))) return null;
  const tip = n.headers || 0, head = Math.floor(n.blocks || 0), behind = Math.max(0, tip - head);
  const prog = n.verificationprogress != null ? n.verificationprogress : (tip ? Math.min(1, head / tip) : 1);
  // After wake, peers/headers haven't refreshed yet so headers==blocks==stale tip → behind reads 0 ("at the
  // tip") while the node is really hours back. The tip BLOCK TIME catches this: a synced tip is minutes old.
  const stale = n.tip_time ? (Date.now() / 1000 - n.tip_time) > 90 * 60 : false;
  return { tip, head, behind, prog, stale, syncing: behind > 0 || !!n.initialblockdownload || stale };
}
function nodeSyncing() { const si = syncInfo(); return !!(si && si.syncing); }
// The assumeutxo catch-up: your node re-verifying, from genesis, the history it initially took on the
// snapshot's word. Runs for hours AFTER setup says "Ready" and while you're already mining, which is why it
// gets said out loud — a busy machine with no explanation reads as something being wrong. Null when done.
function backgroundVerify() {
  const v = model.node && model.node.verifying;
  // "unknown" (a string) means the bridge couldn't read the node this poll — falsy here, so we show nothing
  // rather than inventing progress or implying it finished.
  return v && v.target > 0 && v.blocks < v.target ? v : null;
}
// "85%" doesn't answer the question people actually have, which is when their computer stops being busy.
// Same rolling-rate approach as the sync ETA: sample every ~3s, keep a ~90s window, ignore it until the rate
// is meaningful. Safe to call more than once per frame — the 3s guard stops double-sampling.
let verifyHist = [];
function backgroundVerifyEta(bv) {
  const now = Date.now();
  if (!verifyHist.length || now - verifyHist[verifyHist.length - 1].ts > 3000) verifyHist.push({ ts: now, h: bv.blocks });
  while (verifyHist.length > 2 && now - verifyHist[0].ts > 90000) verifyHist.shift();
  if (verifyHist.length < 2) return "";
  const first = verifyHist[0], last = verifyHist[verifyHist.length - 1];
  const bps = (last.h - first.h) / Math.max(1, (last.ts - first.ts) / 1000);
  if (bps <= 0.02) return "";                       // stalled or too early to say — better silent than wrong
  const s = (bv.target - bv.blocks) / bps;
  return s > 172800 ? `~${(s / 86400).toFixed(1)} days left`
    : s > 3600 ? `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m left`
    : s > 90 ? `~${Math.round(s / 60)} min left` : "almost done";
}
// `everSynced` (persisted): has this machine ever caught up to the tip? Gates the focused sync view.
let everSynced = false;
try { everSynced = localStorage.getItem("bl.everSynced") === "1"; } catch {}
function visibleSections() {
  // Hide the mining panels ONLY during the initial sync (or a genuine re-IBD), to focus the view while the
  // chain first downloads. Once the node has synced once, a transient desync (sleep / flush) keeps every panel
  // in place so the dashboard never reflows/jumps — the sync panel just shows "catching up" inline.
  const si = syncInfo(), n = model.node;
  const initialSync = !!(si && si.syncing && (!everSynced || (n && n.initialblockdownload)));
  if (initialSync) return ["sync", "network"];
  let list = LAB ? SECTIONS : SECTIONS.filter((s) => !LAB_SECTIONS.has(s));
  if (!winStatus()) list = list.filter((s) => s !== "win"); // YOUR WIN exists only once you've actually found a block
  if (!expanded.has("hashBuild")) list = list.filter((s) => !BUILD_CHILDREN.has(s) && !HASH_CHILDREN.has(s)); // HASH BUILD collapsed → hide the whole hashing subtree
  else if (!expanded.has("hashInside")) list = list.filter((s) => !HASH_CHILDREN.has(s)); // INSIDE THE HASH collapsed → fold just its dives
  return list;
}
// open the sync panel by default when syncing begins — but only ONCE, so a click to collapse it sticks
let syncAutoExpanded = false;
function autoExpandSync() {
  // auto-open the sync panel only during the initial sync (not on later transient desyncs, to avoid jumps)
  if (nodeSyncing() && !everSynced) { if (!syncAutoExpanded) { expanded.add("sync"); syncAutoExpanded = true; } }
  else if (!nodeSyncing()) syncAutoExpanded = false;
}
// syncing → mining transition. The "caught up — now mining" banner + scroll-snap fire only on the FIRST sync
// completion on this machine (when the dashboard un-collapses). Later re-syncs don't reflow, so they do neither.
let wasSyncing = null, syncedAt = 0; // syncedAt = Date.now() when the "caught up" banner fired (0 = inactive)
function checkSyncTransition() {
  const si = syncInfo();
  if (!si) return;                 // no real node data → don't infer a transition (a brief drop isn't "caught up")
  const nowSync = !!si.syncing;
  if (!nowSync && !everSynced) {    // first time we reach the tip on this machine = initial sync complete
    everSynced = true; try { localStorage.setItem("bl.everSynced", "1"); } catch {}
    if (wasSyncing === true) { syncedAt = Date.now(); scrollY = 0; requestRender(); } // payoff only if we watched it finish
  }
  wasSyncing = nowSync;
}
function drawSyncedBanner() {
  if (!syncedAt) return;
  const el = (Date.now() - syncedAt) / 1000; // seconds since "caught up"
  if (el > 5) { syncedAt = 0; return; }
  const slide = Math.min(1, el * 6), fade = el > 4 ? 5 - el : 1; // slide in fast, fade out over the last second
  const label = "✅ Caught up — you're mining the tip now", sub = "your node submits a ticket every block from here";
  ctx.save(); ctx.globalAlpha = fade;
  ctx.font = "700 14px -apple-system, system-ui, sans-serif";
  const tw = ctx.measureText(label).width, pw = Math.max(tw, 260) + 44, ph = 46, px = W / 2 - pw / 2, py = 118 - (1 - slide) * 16;
  ctx.fillStyle = "rgba(14,26,18,0.96)"; roundRect(px, py, pw, ph, 10); ctx.fill();
  ctx.strokeStyle = "rgba(90,235,150,0.8)"; ctx.lineWidth = 1.3; roundRect(px, py, pw, ph, 10); ctx.stroke();
  text(label, W / 2, py + 17, { size: 14, weight: 700, color: "rgb(120,245,170)", align: "center", baseline: "middle" });
  text(sub, W / 2, py + 33, { size: 11, weight: 600, color: "rgba(120,245,170,0.7)", align: "center", baseline: "middle" });
  ctx.restore();
}

// A persistent top-center banner when the bridge's `consensus_alert` is non-empty — set ONLY when an unknown
// consensus rule has LOCKED IN / ACTIVATED on the network (Core's "unknown new rules activated"; mere
// pre-activation signalling is filtered out in node_bridge.py). This is the generic "a fork the node doesn't
// understand actually happened, you likely need to update" signal — no per-BIP logic. Desktop click → check for update.
function drawConsensusBanner() {
  consensusHit = null;
  const warn = fakeWarn || (model.node && (model.node.consensus_alert || "").trim());
  if (!warn) return;
  const col = "245,140,70"; // warm orange-red — distinct from the amber update pill; rarer and more serious
  const label = "⚠ Network rule change detected";
  const sub = warn.length > 70 ? warn.slice(0, 68) + "…" : warn; // Core's own words, truncated
  const hint = isDesktop ? "click to check for an update" : "your node software may need updating";
  ctx.font = "700 13px -apple-system, system-ui, sans-serif";
  const tw = Math.max(ctx.measureText(label).width, ctx.measureText(sub).width * 0.82);
  const pw = Math.min(W - PAD * 2, Math.max(tw + 40, 320)), ph = 44, px = W / 2 - pw / 2, py = 66;
  const pulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(clock * 2.2));
  ctx.fillStyle = "rgba(30,16,8,0.96)"; roundRect(px, py, pw, ph, 10); ctx.fill();
  ctx.strokeStyle = `rgba(${col},${0.55 + 0.4 * pulse})`; ctx.lineWidth = 1.4; roundRect(px, py, pw, ph, 10); ctx.stroke();
  text(label, W / 2, py + 15, { size: 13, weight: 700, color: `rgb(${col})`, align: "center", baseline: "middle" });
  text(sub, W / 2, py + 31, { size: 10.5, weight: 600, color: `rgba(${col},0.72)`, align: "center", baseline: "middle" });
  text(hint, W / 2, py + ph + 9, { size: 8.5, weight: 600, color: `rgba(${col},0.7)`, align: "center", baseline: "middle" });
  if (isDesktop) consensusHit = { x: px, y: py, w: pw, h: ph }; // clickable only where the app can act on it
}

function layoutSections() {
  let y = TOP; const frames = [];
  for (const s of visibleSections()) {
    const ind = HASH_CHILDREN.has(s) ? 40 : (BUILD_CHILDREN.has(s) ? 20 : 0); // nesting depth: HASH BUILD children = 20, INSIDE THE HASH's dives = 40
    const header = { x: PAD + ind, y, w: W - PAD * 2 - ind, h: HEADER_H };
    y += HEADER_H;
    let content = null;
    const open = expanded.has(s);
    if (open) { const h = contentH(s); content = { x: PAD + ind, y: y + 4, w: W - PAD * 2 - ind, h }; y += 4 + h; }
    y += GAP;
    frames.push({ section: s, header, content });
  }
  return { frames, total: y };
}

function summary(s) {
  if (s === "nextBlock") { if (!model.block) return "—"; const e = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp)); return `${Math.floor(e / 60)}:${String(e % 60).padStart(2, "0")} since last`; }
  if (s === "mempool") {
    // count comes from the last /mempool fetch OR straight from your node (so a collapsed panel needs no
    // mempool.space call); "blocks deep" only shows when we actually have the projection (i.e. it's been open).
    const mp = model.mempool, count = (mp && mp.count != null) ? mp.count : nodeMempoolCount();
    if (count == null) return "—";
    const depth = mp && mp.blocks && mp.blocks.length ? ` · ~${mp.blocks.length} blocks deep` : "";
    return `${count.toLocaleString()} pending${depth}`;
  }
  if (s === "closeness") { const p = model.ticket?.prox; return p ? (p.won ? "TARGET HIT" : `${p.label} · ${p.leadingZeroBits} zero bits`) : "—"; }
  if (s === "avalanche") { return "1 bit in → half the hash out · no aiming"; }
  if (s === "verify") { const v = model.verify; return v ? (v.merkleMatch == null ? "recomputing the proof-of-work…" : ((v.hashMatch && v.belowTarget && v.merkleMatch) ? "hash ✓ · below target ✓ · merkle ✓ — valid" : "check failed")) : "recompute a real block's hash yourself"; }
  if (s === "broadcast") { const n = model.node, reachable = !!(n && n.reachable !== false), rdy = reachable && !(n.initialblockdownload || (n.headers || 0) > (n.blocks || 0)); return !reachable ? "P2P armed · node starting" : rdy ? "node ready · P2P armed" : "P2P armed · node syncing"; }
  if (s === "tickets") { const h = model.node?.miner?.history; if (!h || !h.length) return "—"; const span = h[0].h - h[h.length - 1].h + 1; const u = h.filter((e) => e.w && !e.s).length; return `${h.length} tickets · ${Math.max(0, span - h.length)} missed${u ? ` · ⚠ ${u}` : ""}`; }
  if (s === "merkle") { const n = Math.max(model.txCount || 0, 2); return `${n.toLocaleString()} transactions → one root · pair · concatenate · hash`; }
  if (s === "fold") { return "long message → 512-bit blocks · each output replaces the constants"; }
  if (s === "hashBuild") { return (model.ticket ? "your ticket 0x" + model.ticket.hashHex.slice(0, 12) + "…" : "make a hash") + " · +MERKLE · AVALANCHE · VERIFY · INSIDE THE HASH"; }
  if (s === "hashInside") { return "SHA-256 · type to hash · +ONE ROUND, BIT OPS…"; }
  if (s === "oneRound") { return "scramble · choose · majority → new a, e"; }
  if (s === "shift") { return "rounds side by side · the slide"; }
  if (s === "churn") { return "animated · drop → mix → shift"; }
  if (s === "sigma1") { return "scramble e · rotate ×3 → XOR (Σ1)"; }
  if (s === "ch") { return "e picks f or g, per bit"; }
  if (s === "maj") { return "majority vote of a, b, c"; }
  if (s === "bitOps") { return "rotate · XOR · AND · add"; }
  if (s === "win") { const ws = winStatus(); if (!ws) return ""; const m = maturityNote(ws), h = `block #${Number(ws.height).toLocaleString()}`;
    // While it's still settling, THAT is the headline — a maturity count would skip past "not reorg-safe yet".
    return ws.status === "lost" ? `${h} — didn't make it`
      : ws.status === "pending" ? `${h} — settling ${ws.confirmations || 0}/${ws.needs || 6}`
      : m.done ? `${h} — spendable` : `${h} — ${m.have}/${m.need} to spendable`; }
  if (s === "sync") { const bv = backgroundVerify(); return bv ? `verifying history · ${(bv.progress * 100).toFixed(0)}%` : "gather → verify → link → prune"; }
  if (s === "updates") { return "download → hash → Bitcoin block → your node ✓"; }
  if (s === "network") { const parts = []; if (model.price) parts.push("BTC $" + Math.round(model.price).toLocaleString()); if (model.hashrateEh) parts.push(`${model.hashrateEh.toFixed(0)} EH/s`); return parts.join(" · ") || "—"; }
  return "";
}

function drawHeader(s, r, isExpanded, hovered) {
  ctx.fillStyle = `rgba(255,255,255,${hovered ? 0.08 : 0.045})`; roundRect(r.x, r.y, r.w, r.h, 6); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT}, ${hovered ? 0.5 : 0.22})`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 6); ctx.stroke();
  const accent = `rgba(${ACCENT}, ${hovered ? 1 : 0.85})`;
  text(isExpanded ? "▾" : "▸", r.x + 16, r.y + r.h / 2, { size: 18, weight: 700, color: accent, align: "center", baseline: "middle" });
  text(SECTION_TITLE[s], r.x + 34, r.y + r.h / 2, { size: 15, weight: 700, color: accent, baseline: "middle" });
  if (!isExpanded) {
    // collapsed sync panel: show a live progress bar in the header, so progress stays visible even with
    // the (heavier) animation closed — handy on weak machines.
    const si = s === "sync" ? syncInfo() : null;
    const bv = s === "sync" && !(si && si.syncing) ? backgroundVerify() : null;
    if ((si && si.syncing) || bv) {
      // The catch-up bar is deliberately white, not accent: you are already mining, and this must read as
      // secondary background work rather than something blocking you.
      const prog = bv ? bv.progress : si.prog, col = bv ? "255,255,255" : ACCENT, alpha = bv ? 0.45 : 0.85;
      const bw2 = 110, bx = r.x + r.w - 14 - bw2, byc = r.y + r.h / 2;
      text(`${(prog * 100).toFixed(1)}%`, bx - 8, byc, { size: 12, weight: 600, color: "rgba(255,255,255,0.7)", align: "right", baseline: "middle" });
      ctx.fillStyle = "rgba(255,255,255,0.12)"; roundRect(bx, byc - 3, bw2, 6, 3); ctx.fill();
      ctx.fillStyle = `rgba(${col},${alpha})`; roundRect(bx, byc - 3, Math.max(4, bw2 * prog), 6, 3); ctx.fill();
    } else {
      text(summary(s), r.x + r.w - 14, r.y + r.h / 2, { size: 14, color: "rgba(255,255,255,0.62)", align: "right", baseline: "middle" });
    }
  }
}

// YOUR TICKETS — a timeline of every block your node submitted a ticket to. One bar per ticket, oldest→newest;
// bar height/colour = leading-zero bits (your own range), gold ring = your best, ★ = a win. Where consecutive
// block heights are skipped, a dashed break with "⋯N" marks the blocks you MISSED — i.e. node downtime (sleep,
// restart, offline). So it doubles as a downtime visualiser, straight from state.json's per-block history.
// One BAR per ticket = hash strength (height/colour, your own range); one MARKER below the baseline = a ticket
// was entered (same size regardless of strength, so a weak z=0 hash is never mistaken for a gap). Marker colour
// encodes submit state: amber = normal, green = won & accepted (★), red = WON but submitblock failed (⚠ — needs
// manual resubmit). Each block HEIGHT is its own slot, so skipped heights render as empty space = downtime.
function drawTickets(r) {
  const pad = 16, mn = model.node && model.node.miner;
  const hist = mn && Array.isArray(mn.history) ? mn.history.filter((e) => e && e.h != null) : [];
  text("YOUR TICKETS — one bar per block your node entered (tall/green = stronger hash) · empty space = blocks missed", r.x + pad, r.y + 18, { size: 12, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  if (!hist.length) {
    text("no tickets yet — your node enters one per block once it's caught up and mining", r.x + r.w / 2, r.y + r.h / 2 + 4, { size: 12, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
    return;
  }
  const items = hist.slice().reverse(); // oldest → newest, left → right
  const oldest = items[0].h, newest = items[items.length - 1].h, fullSpan = newest - oldest + 1, missed = Math.max(0, fullSpan - items.length);
  let maxZ = 1, unsub = 0; for (const e of items) { if ((e.z || 0) > maxZ) maxZ = e.z || 0; if (e.w && !e.s) unsub++; }
  const x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0;
  // ONE SLOT PER BLOCK HEIGHT — gaps render as REAL empty space, not a compressed "⋯N" marker, so missed blocks
  // (downtime) are visible. Cap the span at 100 blocks for both steady mining and mining-with-gaps: steady shows
  // the last ~100 blocks; a long outage clamps to the most recent 100 (and says so) rather than stretching the
  // strip. Also clamp on narrow windows so bars stay ≥~4px wide rather than compressing the gaps away.
  const MAXSLOTS = Math.min(100, Math.max(40, Math.floor(w / 4)));
  const startH = fullSpan > MAXSLOTS ? newest - MAXSLOTS + 1 : oldest;
  const span = newest - startH + 1, clamped = startH > oldest, cw = w / span;
  const baseY = r.y + r.h - 42, topY = r.y + 44, barMax = baseY - topY, markY = baseY + 9;
  ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, baseY); ctx.lineTo(x1, baseY); ctx.stroke();
  const bw = Math.max(2, Math.min(cw * 0.8, 22)), mw = Math.max(2, Math.min(cw * 0.8, 12)); // fill ~80% of a slot so consecutive blocks read as a band and a gap is an obvious break
  for (const e of items) {
    if (e.h < startH) continue; // clamped off the left edge
    const z = e.z || 0, f = z / maxZ, cx = x0 + cw * (e.h - startH + 0.5);
    const wonUnsub = !!(e.w && !e.s), won = !!(e.w && e.s);
    const bh = Math.max(3, f * barMax); // performance bar — min 3px so a weak hash still shows
    ctx.fillStyle = wonUnsub ? "rgba(255,90,90,0.95)" : won ? "rgba(90,235,150,1)" : `rgba(${Math.round(255 - 150 * f)},${Math.round(180 + 45 * f)},${Math.round(110 + 30 * f)},0.92)`;
    ctx.fillRect(cx - bw / 2, baseY - bh, bw, bh);
    if (z === maxZ && maxZ > 0 && !e.w) { ctx.strokeStyle = "rgba(255,215,90,0.95)"; ctx.lineWidth = 1.2; ctx.strokeRect(cx - bw / 2 - 1.5, baseY - bh - 1.5, bw + 3, bh + 3); } // gold ring = your best (non-win)
    // participation marker (the "ticket") — only at heights with a ticket; colour = submit state
    ctx.fillStyle = wonUnsub ? "rgba(255,90,90,1)" : won ? "rgba(90,235,150,1)" : "rgba(255,200,120,0.85)";
    roundRect(cx - mw / 2, markY - 2, mw, 4, 1.2); ctx.fill();
    if (won) text("★", cx, baseY - bh - 8, { size: 11, weight: 700, color: "rgb(90,235,150)", align: "center", baseline: "middle" });
    if (wonUnsub) text("⚠", cx, baseY - bh - 8, { size: 11, weight: 700, color: "rgb(255,90,90)", align: "center", baseline: "middle" });
    ticketHits.push({ x: cx - cw / 2, y: topY, w: Math.max(cw, 3), h: baseY - topY + 16, lines: [
      `block #${e.h.toLocaleString()}`,
      `${z} leading zero bit${z === 1 ? "" : "s"} — this ticket's hash strength`,
      `bar height is RELATIVE to your best (${maxZ} bit${maxZ === 1 ? "" : "s"}), not closeness to a win`,
      won ? "★ WON & submitted" : wonUnsub ? "⚠ won — NOT submitted (resubmit)" : "entered · not a win",
    ] });
  }
  let base = `${items.length} tickets · #${oldest.toLocaleString()}–#${newest.toLocaleString()} · ${missed.toLocaleString()} missed (downtime) · best ◆ ${maxZ} zero bits`;
  if (clamped) base = `showing last ${span.toLocaleString()} blocks · ` + base;
  text(unsub ? base + ` · ⚠ ${unsub} WON but not submitted — resubmit` : base, r.x + r.w / 2, markY + 16, { size: 10, weight: 600, color: unsub ? "rgba(255,120,120,0.95)" : "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
}

// INSIDE THE HASH — a from-scratch, live SHA-256 shown as a 4-stage pipeline: your typed message → bits →
// padded 512-bit block → 64 rounds churning 8 registers (rotate/XOR/AND/add; changed bits flash gold) → the
// 256-bit hash. Teaches what a computer actually does to hash something.
function drawHashInside(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0, d = hashViz.data;
  const BLUE = "rgba(120,200,255,0.9)", DIM = "rgba(255,255,255,0.06)";
  text("type anything → watch what a computer actually does to turn it into a 256-bit hash", x0, r.y + 15, { size: 12, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  // typeable input box (click to focus; keystrokes handled by handleHashKey)
  const ibY = r.y + 27, ibH = 22, ibW = Math.min(360, w * 0.52);
  ctx.fillStyle = hashViz.focused ? "rgba(255,215,90,0.10)" : "rgba(255,255,255,0.05)"; roundRect(x0, ibY, ibW, ibH, 5); ctx.fill();
  ctx.strokeStyle = hashViz.focused ? "rgba(255,215,90,0.75)" : "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; roundRect(x0, ibY, ibW, ibH, 5); ctx.stroke();
  const cursor = hashViz.focused && Math.floor(Date.now() / 500) % 2 ? "▏" : "";
  const shown = hashViz.input || (hashViz.focused ? "" : "click here and type…");
  text(shown + cursor, x0 + 8, ibY + ibH / 2, { size: 13, weight: 600, color: hashViz.input ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.32)", baseline: "middle", mono: true });
  hashInputHit = { x: x0, y: ibY, w: ibW, h: ibH };
  if (!d) return;
  text(`${d.bytes.length} byte${d.bytes.length === 1 ? "" : "s"} → ${d.blocks} × 512-bit block${d.blocks === 1 ? "" : "s"}`, x1, ibY + ibH / 2, { size: 10, color: "rgba(255,255,255,0.45)", align: "right", baseline: "middle" });

  // 1 · message as bits — wrapped at 64/row (up to 3 rows) so the squares stay visible as the text grows
  let y = r.y + 60;
  text("1 · YOUR MESSAGE, AS BITS — a computer only sees 1s and 0s", x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
  const totalBits = d.bytes.length * 8, perRow = 64, maxRows = 3, cwb = w / perRow, showBits = Math.min(totalBits, perRow * maxRows);
  for (let i = 0; i < showBits; i++) { const on = (d.bytes[i >> 3] >> (7 - (i & 7))) & 1; ctx.fillStyle = on ? BLUE : DIM; ctx.fillRect(x0 + (i % perRow) * cwb + 0.5, y + 10 + Math.floor(i / perRow) * 10, Math.max(1, cwb - 1), 8); }
  if (totalBits > showBits) text(`+${totalBits - showBits} more`, x1, y, { size: 9, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" });
  text(bytesToHex(d.bytes).slice(0, 72) + (d.bytes.length > 36 ? "…" : ""), x0, y + 46, { size: 9, color: "rgba(255,255,255,0.4)", baseline: "middle", mono: true });

  // 2 · padded 512-bit block — a FIXED recipe, no randomness: message, one 1, zeros, the 64-bit length
  y = r.y + 128;
  text("2 · PADDED TO A FIXED 512-BIT BLOCK — a fixed recipe, no randomness", x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
  const msgBits = Math.min(447, d.bytes.length * 8), cwp = w / 512, oneX = x0 + msgBits * cwp;
  for (let i = 0; i < 512; i++) { ctx.fillStyle = i < msgBits ? "rgba(120,205,255,0.95)" : i === msgBits ? "rgba(255,215,90,1)" : i >= 512 - 64 ? "rgba(180,140,255,0.85)" : DIM; ctx.fillRect(x0 + i * cwp, y + 10, Math.max(0.8, cwp - 0.25), 10); }
  text("your message", x0 + (msgBits / 2) * cwp, y + 32, { size: 8, color: "rgba(120,205,255,0.95)", align: "center", baseline: "middle" });
  text("↑ one 1", oneX + 16, y + 32, { size: 8, weight: 700, color: "rgba(255,215,90,0.95)", baseline: "middle" });
  text("just zeros (fill)", x0 + ((msgBits + 448) / 2) * cwp, y + 32, { size: 8, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" });
  text("64-bit length", x0 + (512 - 32) * cwp, y + 32, { size: 8, color: "rgba(180,140,255,0.85)", align: "center", baseline: "middle" });

  if (LAB) {
    // 2½ · the 8 registers broken out — the 256-bit hash-state before any mixing. They START as fixed constants;
    // the message is NOT loaded here — it becomes the W words fed in one-per-round during the churn.
    y = r.y + 176;
    text("THE 8 REGISTERS — the 256-bit hash-state (a–h), starting as fixed constants · your message is separate: it feeds in as W during the churn ↓", x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
    { const rn = "abcdefgh", rgap2 = 10, rbw2 = (w - rgap2 * 7) / 8;
      for (let i = 0; i < 8; i++) {
        const rx = x0 + i * (rbw2 + rgap2), hot = (i === 0 || i === 4), rcw2 = rbw2 / 32;
        ctx.fillStyle = hot ? "rgba(255,215,90,0.07)" : "rgba(120,200,255,0.05)"; roundRect(rx - 3, y + 18, rbw2 + 6, 16, 3); ctx.fill(); // register boundary — each of a–h is one 32-bit box
        ctx.strokeStyle = hot ? "rgba(255,215,90,0.5)" : "rgba(120,200,255,0.34)"; ctx.lineWidth = 1; roundRect(rx - 3, y + 18, rbw2 + 6, 16, 3); ctx.stroke();
        text(rn[i], rx + rbw2 / 2, y + 14, { size: 10, weight: 700, color: hot ? "rgba(255,215,90,0.9)" : "rgba(255,255,255,0.6)", align: "center", baseline: "middle", mono: true });
        for (let b = 0; b < 32; b++) { ctx.fillStyle = ((_SHA_H0[i] >>> (31 - b)) & 1) ? (hot ? "rgba(255,215,90,0.85)" : "rgba(120,200,255,0.8)") : DIM; ctx.fillRect(rx + b * rcw2, y + 22, Math.max(0.8, rcw2 - 0.3), 9); }
      }
    }
    // 3 · the churn, laid out like THE SHIFT — registers as columns, a few rounds stacked; each round only a & e
    // churn (gold), everyone else shifts down a slot. (Full version, with the traced value, in THE SHIFT section.)
    y = r.y + 218;
    text("3 · 64 ROUNDS OF MIXING — each round only a & e churn (gold); the rest shift down · ×64", x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
    text("laid out like THE SHIFT · unpacked in ONE ROUND", x1, y, { size: 10, weight: 600, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" });
    { const names = "abcdefgh", srows = [_SHA_H0, d.rounds[0], d.rounds[1], d.rounds[2], d.rounds[3]], slab = ["start", "r0", "r1", "r2", "r3"];
      const sgx = x0 + 40, cwid3 = (x1 - sgx) / 8, bw3 = cwid3 - 8, bcw3 = bw3 / 32;
      for (let c = 0; c < 8; c++) { const cx = sgx + c * cwid3, hot = (c === 0 || c === 4); // register column lanes so the 8 registers read as distinct
        ctx.fillStyle = hot ? "rgba(255,215,90,0.05)" : "rgba(255,255,255,0.028)"; roundRect(cx - 2, y + 24, bw3 + 4, 80, 3); ctx.fill();
        ctx.strokeStyle = hot ? "rgba(255,215,90,0.24)" : "rgba(255,255,255,0.1)"; ctx.lineWidth = 1; roundRect(cx - 2, y + 24, bw3 + 4, 80, 3); ctx.stroke(); }
      for (let c = 0; c < 8; c++) { const hot = (c === 0 || c === 4); text(names[c], sgx + c * cwid3 + bw3 / 2, y + 15, { size: 9, weight: 700, color: hot ? "rgba(255,215,90,0.9)" : "rgba(255,255,255,0.5)", align: "center", baseline: "middle", mono: true }); }
      for (let ri = 0; ri < srows.length; ri++) {
        const ry = y + 27 + ri * 17;
        text(slab[ri], x0, ry + 3.5, { size: 8, weight: 600, color: ri === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,215,90,0.55)", baseline: "middle" });
        for (let c = 0; c < 8; c++) {
          const cx = sgx + c * cwid3, val = srows[ri][c] >>> 0, isHot = (c === 0 || c === 4) && ri > 0;
          for (let b = 0; b < 32; b++) { ctx.fillStyle = ((val >>> (31 - b)) & 1) ? (isHot ? "rgba(255,215,90,0.95)" : "rgba(90,220,140,0.82)") : DIM; ctx.fillRect(cx + b * bcw3, ry, Math.max(0.7, bcw3 - 0.3), 7); }
          if (isHot) { ctx.strokeStyle = "rgba(255,215,90,0.5)"; ctx.lineWidth = 1; ctx.strokeRect(cx - 1, ry - 1, bw3 + 2, 9); }
        }
      }
    }
    // 3½ · block chaining (Merkle–Damgård) — a longer message is just MORE 512-bit blocks run through this SAME
    // churn, each STARTING from the previous block's output state (not the √-constants). That's the folding.
    y = r.y + 336;
    text(`3½ · LONGER MESSAGES CHAIN BLOCKS — each 512-bit block runs this same churn, but starts from the PREVIOUS block's output (not the constants) · your message = ${d.blocks} block${d.blocks === 1 ? "" : "s"}`, x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
    { const nb = Math.min(3, Math.max(2, d.blocks)), boxes = [{ l: "IV", s: "√-consts", c: "120,200,255" }];
      for (let k = 0; k < nb; k++) boxes.push({ l: `block ${k + 1}`, s: "churn ×64", c: "255,215,90", churn: true });
      boxes.push({ l: "HASH", s: "256 bits", c: "90,235,150" });
      const N = boxes.length, bw = 84, gp = (w - N * bw) / (N - 1), by = y + 22, bh = 28;
      for (let i = 0; i < N; i++) {
        const bx = x0 + i * (bw + gp), b = boxes[i];
        if (i < N - 1) { const ah = by + bh / 2, ex = bx + bw + gp; ctx.strokeStyle = "rgba(90,220,140,0.7)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(bx + bw, ah); ctx.lineTo(ex, ah); ctx.stroke();
          ctx.fillStyle = "rgba(90,220,140,0.9)"; ctx.beginPath(); ctx.moveTo(ex, ah); ctx.lineTo(ex - 5, ah - 3); ctx.lineTo(ex - 5, ah + 3); ctx.fill();
          text("state →", (bx + bw + ex) / 2, ah - 7, { size: 7.5, color: "rgba(90,220,140,0.8)", align: "center", baseline: "middle" }); }
        ctx.fillStyle = `rgba(${b.c},0.1)`; roundRect(bx, by, bw, bh, 4); ctx.fill(); ctx.strokeStyle = `rgba(${b.c},0.8)`; ctx.lineWidth = 1; roundRect(bx, by, bw, bh, 4); ctx.stroke();
        text(b.l, bx + bw / 2, by + 10, { size: 9.5, weight: 700, color: `rgba(${b.c},1)`, align: "center", baseline: "middle" });
        text(b.s, bx + bw / 2, by + 20, { size: 8, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
        if (b.churn) text("↑ 512 bits", bx + bw / 2, by + bh + 8, { size: 7.5, color: "rgba(120,200,255,0.85)", align: "center", baseline: "middle" });
      }
      text("The previous block's output becomes the next block's STARTING registers; the block's 512 bits are the message mixed in. Not concatenated — chained.", x0, by + bh + 22, { size: 9.5, color: `rgba(${ACCENT},0.82)`, baseline: "middle" });
    }
  } else {
    // 3 · the churn — simple: snapshots of the whole 256-bit state at a few rounds, showing it scrambles completely
    y = r.y + 176;
    text("3 · 64 ROUNDS OF MIXING — the 256 bits get scrambled, round after round", x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
    text("×64", x1, y, { size: 10, weight: 600, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" });
    { const snaps = [[0, "round 0"], [21, "round 21"], [42, "round 42"], [63, "round 63"]], sbx = x0 + 74, scw = (x1 - sbx) / 256;
      for (let si = 0; si < snaps.length; si++) {
        const ri = snaps[si][0], regs = d.rounds[ri], sy = y + 16 + si * 16, last = ri === 63;
        text(snaps[si][1], x0, sy + 4, { size: 8, weight: 600, color: last ? "rgba(90,235,150,0.8)" : "rgba(255,215,90,0.55)", baseline: "middle", mono: true });
        for (let b = 0; b < 256; b++) { const bit = (regs[b >> 5] >>> (31 - (b & 31))) & 1; ctx.fillStyle = bit ? (last ? "rgba(90,235,150,0.85)" : "rgba(90,220,140,0.72)") : DIM; ctx.fillRect(sbx + b * scw, sy, Math.max(0.6, scw - 0.2), 9); }
      }
    }
  }

  // 4 · the hash
  y = r.y + r.h - 30;
  text("4 · THE 256-BIT HASH — the 8 registers a–h written out in order (every tx, block & address in Bitcoin is one of these)", x0, y - 15, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
  const lead = leadingZeroHexChars(d.digest), dcw = w / 64;
  for (let i = 0; i < 64; i++) { const z = i < lead; text(d.digest[i], x0 + dcw * (i + 0.5), y, { size: 11, weight: z ? 700 : 600, color: z ? "rgba(255,215,90,1)" : "rgba(90,235,150,0.92)", align: "center", baseline: "middle", mono: true }); }
}

// THE FOLD — the conveyor view of Merkle–Damgård, choreographed so "the previous hash IS the new constants"
// is literal: a state chip slides into the box's LEFT slot (√ IV first, the previous hash after), the segment
// drops in from above, it churns, and the hash that pops out is the SAME chip that slides in next time.
function drawFold(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0, now = Date.now();
  const BLUE = "120,200,255", GRN = "90,225,140", GLD = "255,205,110", DIM = "rgba(255,255,255,0.05)";
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  text("THE FOLD — the 64-round machine eats your message one 512-bit segment at a time", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("The state slides into the box from the left, the segment drops in from above, it churns. The hash that pops out is what slides in next — the previous hash literally becomes the new constants.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });

  const N = 3;
  // non-linear pacing: advance the fold clock (unless paused), hold on keyframes, quick transitions between
  if (reduceMotion) foldT = 0; // static → first keyframe (segment 1, two rows)
  else if (!foldPaused) { const dt = foldLast ? Math.min(140, now - foldLast) : 0; foldT = (foldT + dt) % FOLD_TOTAL; }
  foldLast = now;
  const kfi = Math.floor(foldT / FOLD_UNIT), fLocal = foldT - kfi * FOLD_UNIT;
  const g = (fLocal < FOLD_HOLD || kfi === FOLD_KFS.length - 1) ? FOLD_KFS[kfi] : FOLD_KFS[kfi] + (FOLD_KFS[kfi + 1] - FOLD_KFS[kfi]) * clamp01((fLocal - FOLD_HOLD) / FOLD_TRANS);
  let si = Math.min(N - 1, Math.floor(g)), f = g - si; if (g >= N) { si = N - 1; f = 1; }
  const done = g >= N - 0.02, dropP = clamp01(f / 0.2), churn = f > 0.55 && f < 0.74, slideP = f > 0.78 && si < N - 1 ? clamp01((f - 0.78) / 0.14) : 0;

  // transport buttons — back · play/pause · step-forward (matches THE CHURN); stepping pauses
  { const bh = 19, bwd = 27, gp = 5, byy = r.y + 3, s = 5, b3 = x1 - bwd, b2 = b3 - bwd - gp, b1 = b2 - bwd - gp, cyy = byy + bh / 2, GI = "rgba(255,228,140,0.98)";
    const box = (bx, on) => { ctx.fillStyle = on ? "rgba(255,215,90,0.3)" : "rgba(255,255,255,0.1)"; roundRect(bx, byy, bwd, bh, 5); ctx.fill(); ctx.strokeStyle = "rgba(255,215,90,0.6)"; ctx.lineWidth = 1; roundRect(bx, byy, bwd, bh, 5); ctx.stroke(); };
    box(b1, false); ctx.fillStyle = GI; { const c = b1 + bwd / 2; ctx.beginPath(); ctx.moveTo(c + s, cyy - s); ctx.lineTo(c + s, cyy + s); ctx.lineTo(c - 1, cyy); ctx.closePath(); ctx.fill(); ctx.fillRect(c - s - 1, cyy - s, 2, 2 * s); }
    box(b2, foldPaused); ctx.fillStyle = GI; { const c = b2 + bwd / 2; if (foldPaused) { ctx.beginPath(); ctx.moveTo(c - s + 1, cyy - s); ctx.lineTo(c - s + 1, cyy + s); ctx.lineTo(c + s + 1, cyy); ctx.closePath(); ctx.fill(); } else { ctx.fillRect(c - 3.5, cyy - s, 2.2, 2 * s); ctx.fillRect(c + 1.3, cyy - s, 2.2, 2 * s); } }
    box(b3, false); ctx.fillStyle = GI; { const c = b3 + bwd / 2; ctx.beginPath(); ctx.moveTo(c - s, cyy - s); ctx.lineTo(c - s, cyy + s); ctx.lineTo(c + 1, cyy); ctx.closePath(); ctx.fill(); ctx.fillRect(c + s - 1, cyy - s, 2, 2 * s); }
    foldBackHit = { x: b1, y: byy, w: bwd, h: bh }; foldPlayHit = { x: b2, y: byy, w: bwd, h: bh }; foldFwdHit = { x: b3, y: byy, w: bwd, h: bh };
    if (foldPaused) text(`⏸ step ${kfi + 1}/${FOLD_KFS.length}`, b1 - 8, cyy, { size: 8, weight: 700, color: "rgba(255,215,90,0.85)", align: "right", baseline: "middle" }); }

  const lm = 66, rm = 58, segGap = 16, segW = (w - lm - rm - segGap * (N - 1)) / N, segX = (k) => x0 + lm + k * (segW + segGap);
  const stripY = r.y + 76, stripH = 22, machY = r.y + 132, machH = 46;
  const boxX = segX(si) + slideP * (segX(Math.min(N - 1, si + 1)) - segX(si));
  const chip = (cx, cy, label, rgb, a) => { const cw = Math.max(48, label.length * 6.4 + 16), ch = 17; ctx.globalAlpha = a == null ? 1 : a; ctx.fillStyle = `rgba(${rgb},0.16)`; roundRect(cx - cw / 2, cy - ch / 2, cw, ch, 4); ctx.fill(); ctx.strokeStyle = `rgba(${rgb},0.95)`; ctx.lineWidth = 1.2; roundRect(cx - cw / 2, cy - ch / 2, cw, ch, 4); ctx.stroke(); text(label, cx, cy, { size: 9, weight: 700, color: `rgba(${rgb},1)`, align: "center", baseline: "middle" }); ctx.globalAlpha = 1; };

  // message strip — segments dim once consumed
  text("your message  →  512-bit segments", x0 + lm, r.y + 52, { size: 9.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  for (let k = 0; k < N; k++) { const sx = segX(k), on = k === si, gone = k < si || (k === si && f > 0.2), nb = Math.floor(segW / 6);
    for (let b = 0; b < nb; b++) { ctx.fillStyle = hrand(k * 71 + b * 1.7) > 0.5 ? `rgba(${BLUE},${gone ? 0.12 : on ? 0.85 : 0.4})` : DIM; ctx.fillRect(sx + b * 6 + 1, stripY, 4, stripH); }
    ctx.strokeStyle = on && !gone ? `rgba(${BLUE},0.9)` : "rgba(255,255,255,0.16)"; ctx.lineWidth = on && !gone ? 1.5 : 1; roundRect(sx, stripY, segW, stripH, 3); ctx.stroke();
    text(`segment ${k + 1}`, sx + segW / 2, stripY - 8, { size: 9, weight: on ? 700 : 500, color: `rgba(${BLUE},${on ? 1 : 0.5})`, align: "center", baseline: "middle" });
  }

  // the 64-round box with TWO rows: TOP = the segment (message) · BOTTOM = the state (√ IV, then the prev hash)
  const topRowY = machY + 9, botRowY = machY + 27, rowH = 12, chipY = botRowY + rowH / 2;
  ctx.fillStyle = "rgba(255,255,255,0.04)"; roundRect(boxX, machY, segW, machH, 5); ctx.fill();
  ctx.strokeStyle = churn ? `rgba(${GLD},0.9)` : "rgba(255,255,255,0.3)"; ctx.lineWidth = churn ? 1.7 : 1.2; roundRect(boxX, machY, segW, machH, 5); ctx.stroke();
  text("64 ROUNDS", boxX + segW / 2, machY - 7, { size: 9, weight: 700, color: churn ? `rgba(${GLD},1)` : "rgba(255,255,255,0.6)", align: "center", baseline: "middle", mono: true });
  const nb = Math.min(96, Math.floor((segW - 14) / 5)), cw2 = (segW - 14) / nb, bx = boxX + 7;
  const bitRow = (yy, seed, rgb, scramble, a) => { ctx.globalAlpha = a == null ? 1 : a; for (let b = 0; b < nb; b++) { let on = hrand(seed + b * 1.7) > 0.5; if (scramble && hrand(seed + b * 1.1 + Math.floor(now / 50)) < 0.45) on = !on; ctx.fillStyle = on ? `rgba(${rgb},0.88)` : "rgba(255,255,255,0.06)"; ctx.fillRect(bx + b * cw2, yy, Math.max(1.4, cw2 - 1), rowH); } ctx.globalAlpha = 1; };
  const stateGreen = si > 0;

  // BOTTOM ROW = the state: √ IV / previous hash. Arrives as a chip sliding in from the left, docks (~f0.3),
  // and fills the bottom row — this is the row that gets hashed.
  if (f < 0.3) { const inS = clamp01((f - 0.08) / 0.2), home = si === 0 ? x0 + 44 : segX(si - 1) + segW * 0.5, cx = home + inS * (boxX + segW / 2 - home);
    chip(cx, chipY, stateGreen ? "hash" : "√ IV", stateGreen ? GRN : GLD, 1);
    if (stateGreen && inS > 0.12 && inS < 1) text("previous hash → the bottom row (the new constants)", cx, chipY + 14, { size: 8, weight: 600, color: `rgba(${GRN},0.9)`, align: "center", baseline: "middle" }); }
  else if (f < 0.72) bitRow(botRowY, si * 53 + 7, churn ? "255,215,120" : (stateGreen ? GRN : GLD), churn, 1);

  // TOP ROW = the segment: drops from the strip into the top row (~f0.2), holds distinct, then DROPS INTO the
  // bottom row as it hashes (f>0.58).
  if (f > 0.05 && f < 0.72) { let tY = topRowY, a = 1;
    if (f < 0.2) tY = stripY + dropP * (topRowY - stripY);
    else if (f > 0.58) { const d = clamp01((f - 0.58) / 0.15); tY = topRowY + d * (botRowY - topRowY); a = 1 - 0.6 * d; }
    bitRow(tY, si * 71, churn ? "255,215,120" : BLUE, churn, a); }

  // row labels while both rows are distinct
  if (f > 0.32 && f < 0.62) { text("segment", boxX - 5, topRowY + rowH / 2, { size: 7.5, color: `rgba(${BLUE},0.75)`, align: "right", baseline: "middle" }); text("state", boxX - 5, botRowY + rowH / 2, { size: 7.5, color: `rgba(${stateGreen ? GRN : GLD},0.8)`, align: "right", baseline: "middle" }); }

  // OUTPUT = the hashed bottom row, now a hash. It rests as a chip while the box slides right off it, then
  // slides into the NEXT box as that box's bottom row.
  if (f > 0.72) { const hx = segX(si) + segW * 0.5, isHash = done || si === N - 1;
    // reveal the hash only as the box slides clear of it — never draw the chip text on top of the box
    const a = isHash ? clamp01((f - 0.72) / 0.1) : clamp01((boxX - (hx + 24)) / 26);
    if (a > 0.02) { chip(hx, chipY, isHash ? "= HASH" : "hash", GRN, a);
      if (!isHash && a > 0.5) text("the box slid on — this hash slides into the next box as its bottom row", hx, chipY + 14, { size: 8, weight: 600, color: `rgba(${GRN},0.8)`, align: "center", baseline: "middle" }); } }

  let cap;
  if (done || (si === N - 1 && f > 0.82)) cap = "After the last segment, the state IS the 256-bit hash.";
  else if (f < 0.46) cap = si === 0 ? "Segment 1: the √-prime constants (bottom row) + the message (top row) load into the box." : `Segment ${si + 1}: the PREVIOUS hash loads into the bottom row — it IS the new constants — with the message on top.`;
  else if (f < 0.8) cap = "The top row (segment) drops into the bottom row (state) and churns — 64 rounds → a new hash.";
  else cap = `The box slides right, leaving the hash behind — it slides into segment ${Math.min(N, si + 2)}'s box as the bottom row.`;
  text(cap, x0, r.y + r.h - 30, { size: 11.5, weight: 700, color: `rgba(${GLD},0.95)`, baseline: "middle" });
  text("The box never holds the whole message — it slides right, folding in 512 bits at a time. 1 GB → ~16 million passes, still 256 bits out.", x0, r.y + r.h - 13, { size: 10, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// ONE ROUND, UNPACKED — the exact fixed recipe each of the 64 rounds runs (Σ0/Σ1, Ch, Maj, +K +W → two new
// registers), with live 32-bit bars. Shows HOW the four ops are arranged into a round — the same every round.
function drawOneRound(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0, d = hashViz.data;
  const BL = "rgba(120,200,255,0.85)", GR = "rgba(90,235,150,0.95)", GO = "rgba(255,215,90,0.95)";
  const t = 0; // the FIRST round, held static — its inputs ARE the fixed starting constants, so you see where a–h begin
  text("ONE ROUND, UNPACKED — the exact recipe every round runs (here: round 0, the very first — held so you can study it)", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("a–h are the 8 “working registers” — 32-bit numbers that together ARE the 256-bit hash being built. They start at fixed constants; each round rebuilds a & e and shifts the rest down a slot.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const keyY = r.y + 52, key = (kx, c, lab) => { ctx.fillStyle = c; ctx.fillRect(kx, keyY - 5, 10, 10); text(lab, kx + 14, keyY, { size: 10, color: "rgba(255,255,255,0.5)", baseline: "middle" }); return kx + 14 + ctx.measureText(lab).width + 22; };
  let kx = x0; kx = key(kx, BL, "scramble/choose/majority step (Σ1 scrambles e · Σ0 scrambles a)"); kx = key(kx, GO, "T1, T2 = “temporaries” (scratch sums)"); key(kx, GR, "the new register");
  if (!d) return;
  const inp = t === 0 ? _SHA_H0 : d.rounds[t - 1];
  const a = inp[0], b = inp[1], c = inp[2], dd = inp[3], e = inp[4], f = inp[5], g = inp[6], h = inp[7];
  const S1 = (_rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)) >>> 0, ch = ((e & f) ^ (~e & g)) >>> 0;
  const T1 = (h + S1 + ch + _SHA_K[t] + d.W[t]) >>> 0;
  const S0 = (_rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)) >>> 0, maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0, T2 = (S0 + maj) >>> 0;
  const newA = (T1 + T2) >>> 0, newE = (dd + T1) >>> 0;
  // show the 8 registers going IN, so "e", "a", "f"… below aren't mystery letters (a & e — the two rebuilt — in gold)
  const sy = r.y + 68;
  text("INPUT (round 0) — the 8 fixed starting constants = fractional parts of √2, √3, √5 … √19 (“nothing-up-my-sleeve” numbers; same for every input; a & e are the two rebuilt):", x0, sy, { size: 10, color: "rgba(255,255,255,0.55)", baseline: "middle" });
  { const regs8 = [a, b, c, dd, e, f, g, h], names8 = "abcdefgh", primes8 = [2, 3, 5, 7, 11, 13, 17, 19], rgap = 10, rbW = (w - rgap * 7) / 8;
    for (let i = 0; i < 8; i++) {
      const rx = x0 + i * (rbW + rgap), hot = (i === 0 || i === 4), rcw = rbW / 32;
      text(names8[i], rx + rbW / 2, sy + 15, { size: 11, weight: 700, color: hot ? GO : "rgba(255,255,255,0.75)", align: "center", baseline: "middle", mono: true });
      for (let q = 0; q < 32; q++) { ctx.fillStyle = ((regs8[i] >>> (31 - q)) & 1) ? (hot ? "rgba(255,215,90,0.85)" : "rgba(120,200,255,0.95)") : "rgba(255,255,255,0.06)"; ctx.fillRect(rx + q * rcw, sy + 22, Math.max(0.8, rcw - 0.3), 8); }
      text(`= frac √${primes8[i]}`, rx + rbW / 2, sy + 37, { size: 8.5, color: "rgba(255,255,255,0.44)", align: "center", baseline: "middle" });
    }
  }
  const lx = x0, barX = x0 + 210, cw = (w - 210) / 32;
  const bar = (by, val, on) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? on : "rgba(255,255,255,0.06)"; ctx.fillRect(barX + i * cw + 0.5, by, Math.max(1, cw - 1), 10); } };
  // each row: bold left label (what it computes) + a plain-English sub (what it means) + the 32-bit result bar
  const line = (yy, label, val, on, sub) => { text(label, lx, yy + 5, { size: 12.5, weight: 700, color: "rgba(255,255,255,0.9)", baseline: "middle", mono: true }); if (sub) text(sub, lx, yy + 21, { size: 10.5, color: "rgba(255,255,255,0.42)", baseline: "middle" }); bar(yy, val, on); };
  const rows = [
    ["scramble e (Σ1)", S1, BL, "e⟲6 ⊕ e⟲11 ⊕ e⟲25 — three rotated copies of e, XORed together", 30, false],
    ["Choose (Ch)", ch, BL, "(e∧f) ⊕ (¬e∧g) — for each bit, e picks register f or g", 30, false],
    ["T1 = h + Σ1 + Ch + K + W", T1, GO, "W = your message word — the ONLY per-input value in the whole round (everything else is fixed)", 33, false],
    ["scramble a (Σ0)", S0, BL, "a⟲2 ⊕ a⟲13 ⊕ a⟲22 — three rotated copies of a, XORed together", 30, false],
    ["Majority (Maj)", maj, BL, "(a∧b) ⊕ (a∧c) ⊕ (b∧c) — each bit = the majority of a, b, c", 30, false],
    ["T2 = Σ0 + Maj", T2, GO, "= scramble a + Majority", 30, true],
    ["new a = T1 + T2", newA, GR, "the round's brand-new register a", 30, false],
    ["new e = d + T1", newE, GR, "old register d, plus T1", 30, false],
  ];
  let y = r.y + 118;
  for (let i = 0; i < rows.length; i++) {
    const [label, val, on, sub, gap, divAfter] = rows[i];
    line(y, label, val, on, sub);
    if (label.startsWith("T1")) { // spotlight the + W — the only place your message enters the round
      ctx.font = "600 12.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      const wx = lx + ctx.measureText(label.slice(0, -1)).width, ww = ctx.measureText("W").width;
      ctx.fillStyle = "rgba(255,215,90,0.34)"; roundRect(wx - 3, y - 3, ww + 6, 16, 3); ctx.fill();
      text("W", wx, y + 5, { size: 12.5, weight: 700, color: "rgba(255,232,135,1)", baseline: "middle", mono: true });
    }
    y += gap + 8; // wider gap between rows so each header+explainer reads as its own group
    if (divAfter) { ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y - 12); ctx.lineTo(x1, y - 12); ctx.stroke(); } // divider before the new registers
  }
  text("…then everything shifts down one — b←a · c←b · d←c · f←e · g←f · h←g. That's the whole round; all 64 run this same recipe.", x0, y, { size: 11, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// THE CHURN (animated) — the honest round loop: one message word W drops into a MIX (which reads the whole
// current row) → new a & e flash gold → the row shifts down; newest round on top, older ones pushed down.
// pause/step state for THE CHURN — freeze it and step round-by-round to study a mix
let churnPaused = false, churnNow = 0, churnLiveNow = 0, churnSpeed = 1, churnRotStart = 0, churnLastStep = -99, churnPlayHit = null, churnBackHit = null, churnFwdHit = null, churnSpeedHit = null;
// THE FOLD transport + non-linear pacing: the loop holds on each readable keyframe (FOLD_HOLD ms), then makes
// a quick transition to the next (FOLD_TRANS ms). Keyframes are global progress g = segment + phase-fraction.
let foldT = 0, foldLast = 0, foldPaused = false, foldPlayHit = null, foldBackHit = null, foldFwdHit = null;
const FOLD_KFS = [0.42, 0.66, 0.92, 1.42, 1.66, 1.92, 2.42, 2.66, 2.99], FOLD_HOLD = 3000, FOLD_TRANS = 950, FOLD_UNIT = FOLD_HOLD + FOLD_TRANS, FOLD_TOTAL = FOLD_KFS.length * FOLD_UNIT;
const CHURN_STEPS = 16, CHURN_DUP_MS = 2000, CHURN_SHIFT_MS = 1000; // DUP = blank row scrolls in → blink source → duplicate; SHIFT = rotate registers right
const CHURN_STEP_DURS = [4500, 2000, 2000, 4600, 9600, 9600, 4600, 7100, 4500, 2000, 2000, 4600, 12100, 4600, 7700, 5200]; // per mix step: read + operate + HOLD-to-read + settle (ms @1×) — the producing steps carry a ~1.4s read-pause on the finished output before it scrolls up
const CHURN_STEP_CUM = CHURN_STEP_DURS.reduce((a, d) => (a.push(a[a.length - 1] + d), a), [0]);
const CHURN_MIX_MS = CHURN_STEP_CUM[16]; // = 84000
function drawChurn(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0, d = hashViz.data;
  const BLUE = "rgba(110,205,255,1)", GOLD = "rgba(255,215,90,0.95)", GREEN = "rgba(90,220,140,0.82)", DIM = "rgba(255,255,255,0.06)";
  text("THE CHURN (animated) — each round built: duplicate the row, shift right, mix your message into a & e", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  const CYCLE = CHURN_DUP_MS + CHURN_SHIFT_MS + CHURN_MIX_MS / churnSpeed, dupEnd = CHURN_DUP_MS / CYCLE, shiftEnd = (CHURN_DUP_MS + CHURN_SHIFT_MS) / CYCLE;
  const churnAnimMs = 2500; // a fixed 2.5s per operation-sweep (in speed-scaled ms); the read stages are separate and the step dwell is large enough for both
  churnLiveNow = reduceMotion ? 2100 : Date.now();
  const now = churnPaused ? churnNow : churnLiveNow;
  const t = (Math.floor(now / CYCLE) % 63) - 1, ph = (now % CYCLE) / CYCLE, R = t + 1; // building round R (0..62) from row t
  const dupP = Math.min(1, ph / dupEnd), shiftP = ph < dupEnd ? 0 : Math.min(1, (ph - dupEnd) / (shiftEnd - dupEnd)), mixing = ph >= shiftEnd;
  // the DUP phase now has three beats: a blank row scrolls in (scrollP) → the source row blinks (blinkActive) → it's copied in (fillP). Then SHIFT rotates the registers right.
  const rowScrollP = Math.min(1, dupP / 0.35), fillP = Math.max(0, Math.min(1, (dupP - 0.66) / 0.34)), blinkActive = !mixing && shiftP === 0 && dupP >= 0.35 && dupP < 0.66;
  const stage = mixing ? "④ mix W into a & e" : shiftP > 0 ? "③ rotate the registers right ↦" : fillP > 0 ? "② duplicate the row into the blank" : blinkActive ? "② the row to copy ✦ blinks" : "① a blank row scrolls in";
  text(`${churnPaused ? "⏸ PAUSED · " : ""}building round ${R} · word W #${R} ${R < 16 ? "(your message)" : "(expanded)"} · ${stage}`, x0, r.y + 33, { size: 10, color: churnPaused ? "rgba(255,215,90,0.85)" : "rgba(255,255,255,0.5)", baseline: "middle" });
  { // transport, top-right: [speed] · ⏮ step-back · ▶/❚❚ · ⏭ step-fwd  (shapes render everywhere)
    const bh = 19, bwd = 27, gp = 5, byy = r.y + 4, s = 5, b3 = x1 - bwd, b2 = b3 - bwd - gp, b1 = b2 - bwd - gp, cyy = byy + bh / 2;
    const box = (bx, wd, on) => { ctx.fillStyle = on ? "rgba(255,215,90,0.3)" : "rgba(255,255,255,0.1)"; roundRect(bx, byy, wd, bh, 5); ctx.fill(); ctx.strokeStyle = "rgba(255,215,90,0.6)"; ctx.lineWidth = 1; roundRect(bx, byy, wd, bh, 5); ctx.stroke(); };
    const GI = "rgba(255,228,140,0.98)";
    const spW = 40, sp0 = b1 - spW - gp; // speed pill (click to cycle 2× · 1× · ½× · ¼×)
    box(sp0, spW, churnSpeed !== 1); text((churnSpeed === 4 ? "4×" : churnSpeed === 2 ? "2×" : churnSpeed === 1 ? "1×" : churnSpeed === 0.5 ? "½×" : "¼×") + " speed", sp0 + spW / 2, cyy, { size: 8, weight: 700, color: GI, align: "center", baseline: "middle" }); churnSpeedHit = { x: sp0, y: byy, w: spW, h: bh };
    box(b1, bwd, false); ctx.fillStyle = GI; { const c = b1 + bwd / 2; ctx.beginPath(); ctx.moveTo(c + s, cyy - s); ctx.lineTo(c + s, cyy + s); ctx.lineTo(c - 1, cyy); ctx.closePath(); ctx.fill(); ctx.fillRect(c - s - 1, cyy - s, 2, 2 * s); }
    box(b2, bwd, churnPaused); ctx.fillStyle = GI; { const c = b2 + bwd / 2; if (churnPaused) { ctx.beginPath(); ctx.moveTo(c - s + 1, cyy - s); ctx.lineTo(c - s + 1, cyy + s); ctx.lineTo(c + s + 1, cyy); ctx.closePath(); ctx.fill(); } else { ctx.fillRect(c - 3.5, cyy - s, 2.2, 2 * s); ctx.fillRect(c + 1.3, cyy - s, 2.2, 2 * s); } }
    box(b3, bwd, false); ctx.fillStyle = GI; { const c = b3 + bwd / 2; ctx.beginPath(); ctx.moveTo(c - s, cyy - s); ctx.lineTo(c - s, cyy + s); ctx.lineTo(c + 1, cyy); ctx.closePath(); ctx.fill(); ctx.fillRect(c + s - 1, cyy - s, 2, 2 * s); }
    churnBackHit = { x: b1, y: byy, w: bwd, h: bh }; churnPlayHit = { x: b2, y: byy, w: bwd, h: bh }; churnFwdHit = { x: b3, y: byy, w: bwd, h: bh };
  }
  if (!d) return;
  const rowFor = (ri) => ri < 0 ? _SHA_H0 : d.rounds[ri];
  const names = "abcdefgh", gx = x0 + 26, cwid = (x1 - gx) / 8, bw = cwid - 10, bcw = bw / 32, rowH = 22, NHIST = 5;
  const headerY = r.y + 56, topY = headerY + 14, src = rowFor(t), dst = d.rounds[t + 1];
  // the mix, unpacked into ordered sub-steps — revealed one at a time during the (slow) mix phase
  const a_ = src[0] >>> 0, b_ = src[1] >>> 0, c_ = src[2] >>> 0, e_ = src[4] >>> 0, f_ = src[5] >>> 0, g_ = src[6] >>> 0, h_ = src[7] >>> 0;
  const S1 = (_rotr(e_, 6) ^ _rotr(e_, 11) ^ _rotr(e_, 25)) >>> 0, chm = ((e_ & f_) ^ (~e_ & g_)) >>> 0;
  const S0 = (_rotr(a_, 2) ^ _rotr(a_, 13) ^ _rotr(a_, 22)) >>> 0, maj = ((a_ & b_) ^ (a_ & c_) ^ (b_ & c_)) >>> 0;
  const Km = _SHA_K[R % 64], Wt = (d.W[R % 64] || 0) >>> 0, T1v = (h_ + S1 + chm + Km + Wt) >>> 0, T2v = (S0 + maj) >>> 0;
  const TEAL = "rgba(120,228,218,1)", VIOL = "rgba(205,168,255,1)", GLD = "rgba(255,235,140,1)", GRN = "rgba(90,235,150,0.98)";
  const steps = [
    { g: "Σ1", l: "e ⟲ 6", v: _rotr(e_, 6) >>> 0, rd: [4], c: TEAL, rn: 6 },
    { g: "Σ1", l: "e ⟲ 11", v: _rotr(e_, 11) >>> 0, rd: [4], c: TEAL, rn: 11 },
    { g: "Σ1", l: "e ⟲ 25", v: _rotr(e_, 25) >>> 0, rd: [4], c: TEAL, rn: 25 },
    { g: "Σ1", l: "= ⊕ the three rotations", v: S1, rd: [4], c: TEAL, res: 1, xops: [["e⟲6", _rotr(e_, 6) >>> 0], ["e⟲11", _rotr(e_, 11) >>> 0], ["e⟲25", _rotr(e_, 25) >>> 0]] },
    { g: "Ch", l: "e ∧ f", v: (e_ & f_) >>> 0, rd: [4, 5], c: TEAL, and2: [["e", e_ >>> 0], ["f", f_ >>> 0]] },
    { g: "Ch", l: "¬e ∧ g", v: (~e_ & g_) >>> 0, rd: [4, 6], c: TEAL, and2: [["¬e", (~e_) >>> 0], ["g", g_ >>> 0]] },
    { g: "Ch", l: "= (e∧f) ⊕ (¬e∧g)", v: chm, rd: [], c: TEAL, res: 1, xops: [["e∧f", (e_ & f_) >>> 0, 1], ["¬e∧g", (~e_ & g_) >>> 0, 1]], choose: 1 },
    { g: "T1", l: "= Σ1 + Ch + h + K + W", v: T1v, rd: [7], c: GLD, res: 1, add: 1, ops: [["Σ1", S1, 1], ["Ch", chm, 1], ["h", h_], ["K const", Km], ["W msg-word", Wt]] },
    { g: "Σ0", l: "a ⟲ 2", v: _rotr(a_, 2) >>> 0, rd: [0], c: VIOL, rn: 2 },
    { g: "Σ0", l: "a ⟲ 13", v: _rotr(a_, 13) >>> 0, rd: [0], c: VIOL, rn: 13 },
    { g: "Σ0", l: "a ⟲ 22", v: _rotr(a_, 22) >>> 0, rd: [0], c: VIOL, rn: 22 },
    { g: "Σ0", l: "= ⊕ the three rotations", v: S0, rd: [0], c: VIOL, res: 1, xops: [["a⟲2", _rotr(a_, 2) >>> 0], ["a⟲13", _rotr(a_, 13) >>> 0], ["a⟲22", _rotr(a_, 22) >>> 0]] },
    { g: "Maj", l: "= majority(a, b, c)", v: maj, rd: [0, 1, 2], c: VIOL, res: 1, maj3: [a_, b_, c_] },
    { g: "T2", l: "= Σ0 + Maj", v: T2v, rd: [], c: GLD, res: 1, add: 1, ops: [["Σ0", S0, 1], ["Maj", maj, 1]] },
    { g: "new e", l: "= old d + T1", v: dst[4] >>> 0, rd: [3], c: GRN, res: 1, add: 1, ops: [["d", src[3] >>> 0], ["T1", T1v, 1]] },
    { g: "new a", l: "= T1 + T2", v: dst[0] >>> 0, rd: [], c: GRN, res: 1, add: 1, ops: [["T1", T1v, 1], ["T2", T2v, 1]] },
  ];
  const NS = steps.length, mixProg = mixing ? Math.min(1, (ph - shiftEnd) / (1 - shiftEnd)) : 0, mixTimeMs = mixProg * CHURN_MIX_MS;
  let curStep = -1; if (mixing) { curStep = 0; while (curStep < NS - 1 && CHURN_STEP_CUM[curStep + 1] <= mixTimeMs) curStep++; } // variable-width steps, mapped by cumulative duration
  if (curStep !== churnLastStep) { churnLastStep = curStep; churnRotStart = churnLiveNow; } // restart the one-shot rotate on a new step
  const rdSet = curStep >= 0 ? steps[curStep].rd : [], curCol = curStep >= 0 ? steps[curStep].c : TEAL;
  // read → operate → store timing. Read each source in turn (blink it, then write its row); XOR reuses on-screen rotation rows; sigma reads only on its first rotation step.
  const RDN = rdSet.length;
  const stepReadMs = curStep < 0 ? 0 : (steps[curStep].xops ? 0 : steps[curStep].rn ? (curStep === 0 || curStep === 8 ? 2500 : 0) : RDN * 2500); // each register a step reads gets a 2.5s slot (blink 2s, then write); XOR reuses on-screen rows
  const stepBlinkMs = 2000, stepPerReg = RDN > 0 ? stepReadMs / RDN : stepReadMs, stepWriteMs = Math.max(300, stepPerReg - stepBlinkMs); // each slot: blink the source 2s, THEN write the row
  const stepOpMs = curStep < 0 ? 0 : (steps[curStep].rn ? 2000 : churnAnimMs); // rotates take 2s each
  const animEl = (churnLiveNow - churnRotStart) * churnSpeed; // animation clock scales with speed, so a step's animation always fits its (speed-scaled) dwell — never cut off
  for (let c = 0; c < 8; c++) { const hot = (c === 0 || c === 4), read = rdSet.indexOf(c) >= 0; text(names[c], gx + c * cwid + bw / 2, headerY, { size: 10, weight: 700, color: read ? curCol : (hot ? GOLD : "rgba(255,255,255,0.55)"), align: "center", baseline: "middle", mono: true }); if (read) { ctx.fillStyle = curCol; ctx.fillRect(gx + c * cwid, headerY + 8, bw, 2); } }
  const cell = (cx, ry, val, color) => { for (let b = 0; b < 32; b++) { ctx.fillStyle = ((val >>> (31 - b)) & 1) ? color : DIM; ctx.fillRect(cx + b * bcw, ry, Math.max(0.7, bcw - 0.3), 8); } };
  ctx.save(); ctx.beginPath(); ctx.rect(x0 - 2, topY - 3, w + 4, rowH * NHIST + 14); ctx.clip(); // clip stops above the mix header so the active row sliding in at a round boundary can't overlap "THE MIX" text
  const gOff = mixing ? 0 : (1 - rowScrollP) * rowH; // the grid scrolls UP so a BLANK row appears at the bottom, then it's blinked-source → duplicated → shifted (rather than the row growing in)
  for (let i = -1; i < NHIST; i++) {
    const rIdx = t - (NHIST - 1) + i, regs = rowFor(rIdx), ry = topY + i * rowH + gOff, isStart = rIdx < 0, isSrc = rIdx === t && mixing;
    text(isStart ? "start" : "r" + rIdx, x0 - 3, ry + 4, { size: 7.5, weight: isSrc ? 700 : 400, color: isSrc ? "rgba(255,235,150,0.9)" : "rgba(255,255,255,0.35)", baseline: "middle" });
    for (let c = 0; c < 8; c++) {
      if (isSrc && rdSet.indexOf(c) >= 0) { const kk = rdSet.indexOf(c), w0 = kk * stepPerReg, w1 = w0 + stepBlinkMs; // each source blinks 4× in its 2s slot (eye goes to it), then holds while its row is written
        if (animEl >= w0) { const bOn = animEl > w1 ? true : Math.floor((animEl - w0) / Math.max(50, stepBlinkMs / 16)) % 2 === 0; ctx.globalAlpha = bOn ? 0.55 : 0.08; ctx.fillStyle = curCol; ctx.fillRect(gx + c * cwid - 1.5, ry - 2, bw + 3, 12); ctx.globalAlpha = 1; ctx.strokeStyle = curCol; ctx.lineWidth = bOn ? 2 : 0.8; ctx.strokeRect(gx + c * cwid - 1.5, ry - 2, bw + 3, 12); } }
      const hot = (c === 0 || c === 4) && !isStart; cell(gx + c * cwid, ry, regs[c] >>> 0, hot ? GOLD : (isStart ? BLUE : GREEN)); if (hot) { ctx.strokeStyle = "rgba(255,215,90,0.35)"; ctx.lineWidth = 1; ctx.strokeRect(gx + c * cwid - 1.5, ry - 1.5, bw + 3, 11); }
    }
    if (rIdx === t && blinkActive) { const on = Math.floor(churnLiveNow / 130) % 2 === 0; ctx.strokeStyle = `rgba(255,235,150,${on ? 0.95 : 0.35})`; ctx.lineWidth = on ? 2 : 1; ctx.strokeRect(gx - 3, ry - 2.5, x1 - gx + 5, 13); } // blink the row about to be copied
  }
  const aby = topY + NHIST * rowH;
  text("r" + (t + 1), x0 - 3, aby + 4 + gOff, { size: 7.5, weight: 700, color: "rgba(255,215,90,0.7)", baseline: "middle" });
  if (!mixing) { const ny = aby + gOff, blank = fillP <= 0 && shiftP <= 0;
    if (blank) { ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.strokeRect(gx - 2, ny - 2, x1 - gx + 4, 12); ctx.setLineDash([]); } // the blank slot that scrolled in
    for (let c = 0; c < 8; c++) {
      if (shiftP > 0) cell(gx + (c + shiftP) * cwid, ny, src[c] >>> 0, BLUE); // rotate the duplicated row right
      else if (fillP * 8 - c >= 0.5) cell(gx + c * cwid, ny, src[c] >>> 0, BLUE); // duplicated in, register by register (left → right)
      else for (let b = 0; b < 32; b++) { ctx.fillStyle = DIM; ctx.fillRect(gx + c * cwid + b * bcw, ny, Math.max(0.7, bcw - 0.3), 8); } // still blank
    }
  }
  else { const animDone = animEl >= stepReadMs + churnAnimMs, blinkOn = Math.floor(churnLiveNow / 150) % 2 === 0; // new e/a only land once their read + add finish, then blink
    for (let c = 0; c < 8; c++) { const hot = (c === 0 || c === 4);
      const isRes = (c === 4 && curStep === 14) || (c === 0 && curStep === 15);
      const ready = !hot || (c === 4 ? (curStep >= 15 || (curStep === 14 && animDone)) : (curStep === 15 && animDone));
      const blinking = isRes && ready && animDone && animEl < stepReadMs + churnAnimMs + 1800, fresh = hot && ready;
      const col = !ready ? DIM : !hot ? GREEN : blinking ? (blinkOn ? "rgba(255,255,235,1)" : "rgba(255,210,110,0.7)") : (fresh ? "rgba(255,245,170,1)" : GOLD);
      cell(gx + c * cwid, aby, ready ? (dst[c] >>> 0) : 0, col);
      if (hot) { ctx.strokeStyle = !ready ? "rgba(255,215,90,0.32)" : blinking ? (blinkOn ? "rgba(255,255,240,1)" : "rgba(255,210,110,0.55)") : "rgba(255,215,90,0.5)"; ctx.lineWidth = blinking && blinkOn ? 2.4 : (fresh ? 1.8 : 1); ctx.setLineDash(ready ? [] : [2, 2]); ctx.strokeRect(gx + c * cwid - 1.5, aby - 1.5, bw + 3, 11); ctx.setLineDash([]); } } }
  ctx.restore();
  // THE MIX — walk the sub-steps that build new a & e, revealed one at a time (newest at the bottom)
  const mbarX = x0 + 214, mcw = (x1 - mbarX) / 32;
  const mbar = (yy, val, color) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? color : DIM; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); } };
  // frame a step's OUTPUT row so it stands out — a clean neutral-white outline that hugs the bar (no glow, so it
  // never bleeds onto the row below) and never fights the lane colours
  const frameOut = (yy) => { ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.3; roundRect(mbarX - 4, yy - 1.5, x1 - mbarX + 5, 10, 2.5); ctx.stroke(); };
  let my = aby + 20;
  const RESY = aby + 122; // the output/result row is PINNED here (sized for the longest step, T1) so it lands in the SAME place for every step
  const OP_LABEL = { "Σ1": "Σ1 · scramble e — rotate ×3 & XOR", "Ch": "Ch · choose — e picks f or g per bit", "T1": "T1 · sum  Σ1 + Ch + h + K + W", "Σ0": "Σ0 · scramble a — rotate ×3 & XOR", "Maj": "Maj · majority vote of a, b, c", "T2": "T2 · sum  Σ0 + Maj", "new e": "new e · add  d + T1", "new a": "new a · add  T1 + T2" };
  if (curStep >= 0) text(`THE MIX · step ${curStep + 1}/${NS}   ▸   ${OP_LABEL[steps[curStep].g] || steps[curStep].g}`, x0, my, { size: 9.5, weight: 700, color: steps[curStep].c, baseline: "middle" });
  else text("THE MIX — new a & e  (waiting for the row to settle…)", x0, my, { size: 9, weight: 700, color: "rgba(255,215,90,0.82)", baseline: "middle" });
  my += 13;
  const HELD = [{ l: "Σ1", f: 3, u: [7], c: TEAL, v: S1 }, { l: "e∧f", f: 4, u: [6], c: TEAL, v: (e_ & f_) >>> 0 }, { l: "¬e∧g", f: 5, u: [6], c: TEAL, v: (~e_ & g_) >>> 0 }, { l: "Ch", f: 6, u: [7], c: TEAL, v: chm }, { l: "T1", f: 7, u: [14, 15], c: GLD, v: T1v }, { l: "Σ0", f: 11, u: [13], c: VIOL, v: S0 }, { l: "Maj", f: 12, u: [13], c: VIOL, v: maj }, { l: "T2", f: 13, u: [15], c: GLD, v: T2v }];
  const stepDoneMs = stepReadMs + stepOpMs, animDone = animEl >= stepDoneMs, scrollHold = (curStep === 14 || curStep === 15) ? 2000 : 1400; // hold the finished output long enough to READ the explainer before it scrolls up (new e/a already hold 2s for the register + row blink)
  const slideUp = Math.min(1, Math.max(0, (animEl - stepDoneMs - scrollHold) / 600)); // rises in sync with the detail scrolling up (600ms), AFTER the read-hold
  let storedUseTop = null, freshRow = null, freshSlotY = 0, resultRowY = 0, churnExplain = null; // the per-step explainer is captured here and drawn AFTER the scroll transform, so it stays readable while the rows scroll up
  if (curStep >= 0) { // HELD — a value enters the store once its own animation finishes (rising up), glows while a later step consumes it, then scrolls up when that step is done
    const live = HELD.map(h => ({ h, to: Math.max(...h.u) })).filter(o => {
      if (curStep > o.to) return false; // released and gone
      return curStep >= o.h.f; // reserve the slot from the start of its producing step (the result only travels in once computed) — so the layout below never jumps when the op completes
    }).sort((a, b) => ((a.h.u.includes(curStep) ? 1 : 0) - (b.h.u.includes(curStep) ? 1 : 0)) || (a.h.f - b.h.f)); // values used by THIS step sink to the bottom (next to the operation) so the sweep encloses only them
    live.forEach((o) => { const h = o.h, fresh = curStep === h.f;
      const relProg = (curStep === o.to) ? Math.min(1, Math.max(0, (animEl - (stepDoneMs + scrollHold + 300)) / 450)) : 0; // consumed → scroll up once its last-use operation (and any hold) finishes
      if (relProg >= 1) return; // fully scrolled up — gone
      if (fresh) { freshSlotY = my; if (animDone) freshRow = h; my += 9.5 * Math.min(1, animEl / 260); return; } // the slot GROWS in over the first 260ms so the store makes room smoothly (no jump); result travels up into it once computed (animDone)
      const using = h.u.includes(curStep) && relProg === 0;
      let a = 1, dx = 0, dy = 0; if (relProg > 0) { a = 1 - relProg; dy = -relProg * 22; } // consumed values scroll up out of view
      const lc = h.c; // keep each stored value its own colour; "being used" is shown by the border below, not a colour change
      ctx.globalAlpha = a;
      text(h.l, x0 + dx, my + 3.5 + dy, { size: 8, weight: 700, color: lc, baseline: "middle", mono: true });
      for (let i = 0; i < 32; i++) { ctx.fillStyle = ((h.v >>> (31 - i)) & 1) ? lc : DIM; ctx.fillRect(mbarX + i * mcw + 0.5 + dx, my + dy, Math.max(1, mcw - 1), 7); }
      if (using) { ctx.strokeStyle = "rgba(255,245,170,0.9)"; ctx.lineWidth = 1.2; ctx.strokeRect(mbarX - 2, my - 1.5 + dy, x1 - mbarX + 3, 10); storedUseTop = storedUseTop == null ? my - 1.5 : Math.min(storedUseTop, my - 1.5); }
      ctx.globalAlpha = 1; my += 9.5; });
    if (live.length) { ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 4; text("stored ↑ · current operation ↓", x0, my, { size: 7, color: "rgba(255,255,255,0.32)", baseline: "middle" }); my += 6; }
  }
  const producesStored = curStep >= 0 && HELD.some(h => h.f === curStep);
  const storedBottom = my, scrollP = (curStep >= 0 && (steps[curStep].res || producesStored) && animEl >= stepDoneMs + scrollHold) ? Math.min(1, (animEl - stepDoneMs - scrollHold) / 600) : 0; // once an op finishes, its worked rows scroll up: the result rises into the store, the operand rows scroll up + fade out behind it (incl. the AND sub-steps e∧f / ¬e∧g)
  if (scrollP > 0) { ctx.save(); ctx.beginPath(); ctx.rect(x0 - 8, storedBottom - 1, (x1 - x0) + 20, (aby + 172) - storedBottom + 1); ctx.clip(); ctx.globalAlpha = Math.max(0, 1 - scrollP * 1.2); my -= scrollP * 46; }
  if (curStep < 0) { text("↑ duplicating & shifting the row — the mix begins next. Runs slow; hit ⏸ then ⏭ / ⏮ to step through.", x0, my + 2, { size: 9, color: "rgba(255,255,255,0.5)", baseline: "middle" }); }
  else if (steps[curStep].ops) { // grade-school addition: the stored operands (e.g. Σ1, Ch, h, K, W) stacked, summed column by column with carry
    const st = steps[curStep], vals = st.ops.map(o => o[1] >>> 0), n = vals.length, aColor = st.c;
    const arp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - stepReadMs) / churnAnimMs)), sweepPos = arp * 34; // add starts once the read operand (h / d) is in
    const carry = new Array(34).fill(0); for (let b = 0; b < 32; b++) { let s = carry[b]; for (const v of vals) s += (v >>> b) & 1; carry[b + 1] = s >> 1; }
    const bCur = Math.max(0, Math.min(31, Math.floor(sweepPos))), rh = 9.5;
    const rbar = (yy, val, col) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? col : DIM; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); } };
    const yTop = my - 2;
    text("carry", x0, my + 3.5, { size: 7.5, color: "rgba(255,240,150,0.75)", baseline: "middle", mono: true });
    for (let i = 0; i < 32; i++) { const b = 31 - i; if (sweepPos - b >= 0 && carry[b]) { ctx.fillStyle = "rgba(255,240,150,0.9)"; ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); } } my += rh;
    const storedNames = st.ops.filter(o => o[2]).map(o => o[0]); // operands already pinned in the store above — reference, don't redraw
    if (storedNames.length) { text("  " + storedNames.join(" + ") + "   ↑ using stored", x0, my + 3.5, { size: 7.5, weight: 700, color: "rgba(255,240,150,0.65)", baseline: "middle", mono: true }); my += rh; }
    let drew = storedNames.length;
    for (let k = 0; k < n; k++) { if (st.ops[k][2]) continue; const firstInline = drew === storedNames.length; // the grid-read operand (h / d) — blink it, then write its row
      text((drew === 0 ? "  " : "+ ") + st.ops[k][0], x0, my + 3.5, { size: 8, weight: 600, color: aColor, baseline: "middle", mono: true });
      if (firstInline && stepReadMs > 0 && !reduceMotion) { const fp = Math.min(1, Math.max(0, (animEl - stepBlinkMs) / stepWriteMs)), shown = Math.round(fp * 32);
        for (let i = 0; i < 32; i++) { ctx.fillStyle = i < shown ? (((vals[k] >>> (31 - i)) & 1) ? aColor : DIM) : "rgba(255,255,255,0.03)"; ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
        if (fp > 0 && fp < 1) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mbarX + shown * mcw - 0.5, my - 1, 1.6, 9); }
      } else rbar(my, vals[k], aColor);
      my += rh; drew++; }
    my = Math.max(my, RESY - 3); ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mbarX - 4, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 3;
    resultRowY = my; if (scrollP > 0) ctx.globalAlpha = 0; frameOut(my); text("= " + (st.g + "  ").slice(0, 5), x0, my + 3.5, { size: 8, weight: 700, color: aColor, baseline: "middle", mono: true });
    const resBlink = (curStep === 14 || curStep === 15) && animDone && animEl < stepDoneMs + 1800 && Math.floor(churnLiveNow / 150) % 2 === 0; // blink the mix result row in time with the register cell it just filled
    for (let i = 0; i < 32; i++) { const b = 31 - i, local = sweepPos - b; ctx.fillStyle = local < 0 ? "rgba(255,255,255,0.035)" : (((st.v >>> (31 - i)) & 1) ? (resBlink ? "rgba(255,255,235,1)" : aColor) : DIM); ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
    if (resBlink) { ctx.strokeStyle = "rgba(255,255,240,0.95)"; ctx.lineWidth = 1.4; ctx.strokeRect(mbarX - 2, my - 1.5, x1 - mbarX + 3, 10); }
    if (arp < 1) { const ix = mbarX + (31 - bCur) * mcw, hlTop = (storedNames.length && storedUseTop != null) ? storedUseTop : yTop; ctx.strokeStyle = "rgba(255,245,170,0.95)"; ctx.lineWidth = 1.3; ctx.strokeRect(ix - 1.5, hlTop, mcw + 2, my + 9 - hlTop); } // the column being added — extends up through the stored operands it's using
    const obits = vals.map(v => (v >>> bCur) & 1), cin = carry[bCur], tot = obits.reduce((a, x) => a + x, 0) + cin;
    my += 23; churnExplain = { t: arp < 1 ? `column ${bCur}:   ${obits.join(" + ")}${cin ? "  + " + cin + " carry" : ""}  =  ${tot.toString(2)}₂  →  write ${tot & 1}, carry ${tot >> 1}` : `${st.g} — add every operand's column, write the low bit, carry the rest up`, y: my, o: { size: 8.5, weight: 600, color: "rgba(255,242,165,0.9)", baseline: "middle", mono: true } };
  }
  else if (steps[curStep].xops) { // XOR — stack the inputs, combine column by column (no carry: 1 when an odd number of inputs are 1)
    const st = steps[curStep], xo = st.xops, aColor = st.c, n = xo.length;
    const arp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - stepReadMs) / churnAnimMs)), sweepPos = arp * 34, bCur = Math.max(0, Math.min(31, Math.floor(sweepPos))); // stepReadMs is 0 here — the rotation rows are already on screen, so just combine them
    const rbar = (yy, val, col) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? col : DIM; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); } };
    const storedNames = xo.filter(o => o[2]).map(o => o[0]); // Ch's two halves are already in the store — reference, don't redraw
    text(st.choose ? "XOR the two stored halves →" : "XOR the three rotations →", x0, my + 3.5, { size: 8.5, weight: 700, color: aColor, baseline: "middle", mono: true }); my += 12;
    const yTop = my - 2;
    if (storedNames.length) { text("  " + storedNames.join(" ⊕ ") + "   ↑ using stored", x0, my + 3.5, { size: 7.5, weight: 700, color: "rgba(120,228,218,0.72)", baseline: "middle", mono: true }); my += 12; }
    let drew = storedNames.length;
    for (let k = 0; k < n; k++) { if (xo[k][2]) continue; text((drew === 0 ? "  " : "⊕ ") + xo[k][0], x0, my + 3.5, { size: 8, weight: 600, color: aColor, baseline: "middle", mono: true }); rbar(my, xo[k][1] >>> 0, aColor); my += 12; drew++; }
    my = Math.max(my, RESY - 3); ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mbarX - 4, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 3;
    resultRowY = my; if (scrollP > 0) ctx.globalAlpha = 0; frameOut(my); text("= " + (st.g + "  ").slice(0, 5), x0, my + 3.5, { size: 8, weight: 700, color: aColor, baseline: "middle", mono: true });
    for (let i = 0; i < 32; i++) { const b = 31 - i, local = sweepPos - b; ctx.fillStyle = local < 0 ? "rgba(255,255,255,0.035)" : (((st.v >>> (31 - i)) & 1) ? aColor : DIM); ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
    if (arp < 1) { const ix = mbarX + (31 - bCur) * mcw, hlTop = (storedNames.length && storedUseTop != null) ? storedUseTop : yTop; ctx.strokeStyle = "rgba(255,245,170,0.95)"; ctx.lineWidth = 1.3; ctx.strokeRect(ix - 1.5, hlTop, mcw + 2, my + 9 - hlTop); }
    const xbits = xo.map(o => (o[1] >>> bCur) & 1);
    my += 23; churnExplain = { t: arp < 1 ? `column ${bCur}:   ${xbits.join(" ⊕ ")}  =  ${xbits.reduce((a, x) => a ^ x, 0)}${st.choose ? "   (choose: e=1→f, e=0→g)" : "   (1 if an odd number are 1)"}` : (st.choose ? `Ch = (e∧f) ⊕ (¬e∧g) — the "choose": where e=1 take f, where e=0 take g` : `${st.g} — XOR: each output bit is 1 when an odd number of inputs are 1 (no carry)`), y: my, o: { size: 8.5, weight: 600, color: "rgba(255,242,165,0.9)", baseline: "middle", mono: true } };
  }
  else if (steps[curStep].chsel) { // Choose — e is the selector: where e=1 take f (blue), where e=0 take g (violet)
    const st = steps[curStep], eV = st.chsel[0] >>> 0, fV = st.chsel[1] >>> 0, gV = st.chsel[2] >>> 0, aColor = st.c;
    const FCOL = "rgba(110,205,255,1)", GCOL = "rgba(205,168,255,1)";
    const arp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - stepReadMs) / churnAnimMs)), sweepPos = arp * 34, bCur = Math.max(0, Math.min(31, Math.floor(sweepPos)));
    const fbar = (yy, val, col, startMs) => { const fp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - (startMs + stepBlinkMs)) / stepWriteMs)), shown = Math.round(fp * 32); // fills only after its source register has blinked
      for (let i = 0; i < 32; i++) { ctx.fillStyle = i < shown ? (((val >>> (31 - i)) & 1) ? col : DIM) : "rgba(255,255,255,0.03)"; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); }
      if (fp > 0 && fp < 1) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mbarX + shown * mcw - 0.5, yy - 1, 1.6, 9); } };
    const yTop = my - 2;
    text("  e (selector)", x0, my + 3.5, { size: 8, weight: 700, color: aColor, baseline: "middle", mono: true }); fbar(my, eV, aColor, 0); my += 11;
    const fRowY = my; text("  f", x0, my + 3.5, { size: 8, weight: 600, color: FCOL, baseline: "middle", mono: true }); fbar(my, fV, FCOL, stepPerReg); my += 11;
    const gRowY = my; text("  g", x0, my + 3.5, { size: 8, weight: 600, color: GCOL, baseline: "middle", mono: true }); fbar(my, gV, GCOL, stepPerReg * 2); my += 11;
    my = Math.max(my, RESY - 3); ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mbarX - 4, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 3;
    resultRowY = my; if (scrollP > 0) ctx.globalAlpha = 0; frameOut(my); text("= Ch", x0, my + 3.5, { size: 8, weight: 700, color: aColor, baseline: "middle", mono: true });
    for (let i = 0; i < 32; i++) { const b = 31 - i, eb = (eV >>> b) & 1, bit = (st.v >>> b) & 1, local = sweepPos - b; ctx.fillStyle = local < 0 ? "rgba(255,255,255,0.035)" : bit ? (eb ? FCOL : GCOL) : (eb ? "rgba(110,205,255,0.24)" : "rgba(205,168,255,0.24)"); ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); } // every column tinted by e's pick (dim where the chosen bit is 0)
    if (arp < 1 && animEl >= stepReadMs) { const ix = mbarX + (31 - bCur) * mcw; ctx.strokeStyle = "rgba(255,245,170,0.95)"; ctx.lineWidth = 1.3; ctx.strokeRect(ix - 1.5, yTop, mcw + 2, my + 9 - yTop);
      const srcY = ((eV >>> bCur) & 1) ? fRowY : gRowY; ctx.strokeStyle = "rgba(255,255,255,0.98)"; ctx.lineWidth = 1.8; ctx.strokeRect(ix - 1.5, srcY - 1.5, mcw + 2, 10); } // the register e is pulling this column's bit from
    const eb = (eV >>> bCur) & 1;
    my += 23; churnExplain = { t: arp < 1 ? `column ${bCur}:   e=${eb}  →  take ${eb ? "f" : "g"}'s bit  =  ${((eb ? fV : gV) >>> bCur) & 1}` : `Ch — e is the selector: where e=1 take f (blue), where e=0 take g (violet)`, y: my, o: { size: 8.5, weight: 600, color: "rgba(255,242,165,0.9)", baseline: "middle", mono: true } };
  }
  else if (steps[curStep].maj3) { // Majority — read a, then b, then c in, then vote (1 when ≥2 agree)
    const st = steps[curStep], aV = st.maj3[0] >>> 0, bV = st.maj3[1] >>> 0, cV = st.maj3[2] >>> 0, aColor = st.c;
    const arp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - stepReadMs) / churnAnimMs)), sweepPos = arp * 34, bCur = Math.max(0, Math.min(31, Math.floor(sweepPos)));
    const fbar = (yy, val, startMs) => { const fp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - (startMs + stepBlinkMs)) / stepWriteMs)), shown = Math.round(fp * 32); // each register fills only after it has blinked
      for (let i = 0; i < 32; i++) { const b = 31 - i, on = i < shown && ((val >>> (31 - i)) & 1), hit = on && ((aV >>> b) & 1) + ((bV >>> b) & 1) + ((cV >>> b) & 1) >= 2; ctx.fillStyle = i < shown ? (on ? (hit ? aColor : "rgba(205,168,255,0.5)") : DIM) : "rgba(255,255,255,0.03)"; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); }
      if (fp > 0 && fp < 1) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mbarX + shown * mcw - 0.5, yy - 1, 1.6, 9); } };
    const readRow = (label, val, startMs) => { const entr = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - startMs) / 260)), ey = my - (1 - entr) * 12; // a new blank read row slides down from the row above, then fills
      ctx.globalAlpha = Math.min(1, entr * entr * 1.6); text(label, x0, ey + 3.5, { size: 8, weight: 600, color: aColor, baseline: "middle", mono: true }); fbar(ey, val, startMs); ctx.globalAlpha = 1; my += 11; };
    const yTop = my - 2;
    readRow("  a", aV, 0); readRow("  b", bV, stepPerReg); readRow("  c", cV, stepPerReg * 2);
    my = Math.max(my, RESY - 3); ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mbarX - 4, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 3;
    resultRowY = my; if (scrollP > 0) ctx.globalAlpha = 0; frameOut(my); text("= Maj", x0, my + 3.5, { size: 8, weight: 700, color: aColor, baseline: "middle", mono: true });
    for (let i = 0; i < 32; i++) { const b = 31 - i, local = sweepPos - b; ctx.fillStyle = local < 0 ? "rgba(255,255,255,0.035)" : (((st.v >>> (31 - i)) & 1) ? aColor : DIM); ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
    if (arp < 1 && animEl >= stepReadMs) { const ix = mbarX + (31 - bCur) * mcw; ctx.strokeStyle = "rgba(255,245,170,0.95)"; ctx.lineWidth = 1.3; ctx.strokeRect(ix - 1.5, yTop, mcw + 2, my + 9 - yTop); }
    const av = (aV >>> bCur) & 1, bv = (bV >>> bCur) & 1, cv = (cV >>> bCur) & 1, ones = av + bv + cv;
    my += 23; churnExplain = { t: arp < 1 ? `column ${bCur}:   a=${av} b=${bv} c=${cv}  →  ${ones} of 3 are 1  →  ${ones >= 2 ? 1 : 0}` : `Maj — each output bit is the majority: 1 when at least two of a, b, c agree`, y: my, o: { size: 8.5, weight: 600, color: "rgba(255,242,165,0.9)", baseline: "middle", mono: true } };
  }
  else if (steps[curStep].and2) { // AND — read both operands in (blink each, then write its row), then AND them bit by bit
    const st = steps[curStep], o1 = st.and2[0], o2 = st.and2[1], aColor = st.c;
    const arp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - stepReadMs) / churnAnimMs)), sweepPos = arp * 34, bCur = Math.max(0, Math.min(31, Math.floor(sweepPos)));
    const fbar = (yy, val, startMs) => { const fp = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - (startMs + stepBlinkMs)) / stepWriteMs)), shown = Math.round(fp * 32);
      for (let i = 0; i < 32; i++) { ctx.fillStyle = i < shown ? (((val >>> (31 - i)) & 1) ? aColor : DIM) : "rgba(255,255,255,0.03)"; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); }
      if (fp > 0 && fp < 1) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mbarX + shown * mcw - 0.5, yy - 1, 1.6, 9); } };
    const readRow = (label, val, startMs) => { const entr = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - startMs) / 260)), ey = my - (1 - entr) * 12; // a new blank read row slides down from the row above, then fills
      ctx.globalAlpha = Math.min(1, entr * entr * 1.6); text(label, x0, ey + 3.5, { size: 8, weight: 600, color: aColor, baseline: "middle", mono: true }); fbar(ey, val, startMs); ctx.globalAlpha = 1; my += 11; };
    const yTop = my - 2;
    readRow("  " + o1[0], o1[1] >>> 0, 0); readRow("∧ " + o2[0], o2[1] >>> 0, stepPerReg);
    my = Math.max(my, RESY - 3); ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mbarX - 4, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 3;
    resultRowY = my; if (scrollP > 0) ctx.globalAlpha = 0; frameOut(my); text("= " + st.l, x0, my + 3.5, { size: 8, weight: 700, color: aColor, baseline: "middle", mono: true });
    for (let i = 0; i < 32; i++) { const b = 31 - i, local = sweepPos - b; ctx.fillStyle = local < 0 ? "rgba(255,255,255,0.035)" : (((st.v >>> (31 - i)) & 1) ? aColor : DIM); ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
    if (arp < 1 && animEl >= stepReadMs) { const ix = mbarX + (31 - bCur) * mcw; ctx.strokeStyle = "rgba(255,245,170,0.95)"; ctx.lineWidth = 1.3; ctx.strokeRect(ix - 1.5, yTop, mcw + 2, my + 9 - yTop); }
    const b1 = (o1[1] >>> bCur) & 1, b2 = (o2[1] >>> bCur) & 1;
    my += 23; churnExplain = { t: arp < 1 ? `column ${bCur}:   ${b1} ∧ ${b2}  =  ${b1 & b2}   (1 only if both are 1)` : `${st.l} — AND: 1 only where both inputs are 1`, y: my, o: { size: 8.5, weight: 600, color: "rgba(255,242,165,0.9)", baseline: "middle", mono: true } };
  }
  else if (steps[curStep].rn) { // sigma rotate — read the register into all three rows first, then shift one row per step
    const isS1 = curStep <= 2, gStart = isS1 ? 0 : 8, amounts = isS1 ? [6, 11, 25] : [2, 13, 22], regV = (isS1 ? src[4] : src[0]) >>> 0, opCol = isS1 ? TEAL : VIOL, reg = isS1 ? "e" : "a", rotIdx = curStep - gStart;
    const READ = stepReadMs, rotDur = stepOpMs; // READ is 2500 on the first rotation step, 0 after; each rotate takes 2s
    const fillP = (READ > 0 && !reduceMotion) ? Math.min(1, Math.max(0, (animEl - stepBlinkMs) / stepWriteMs)) : 1; // blink e first, then fill all three rows
    const shiftProg = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - READ) / rotDur));
    text(fillP < 1 ? `reading ${reg} into all three rows…` : `shift row ${rotIdx + 1} · ${reg} rotated right ${amounts[rotIdx]}`, x0, my + 3.5, { size: 8.5, weight: 700, color: opCol, baseline: "middle", mono: true }); my += 12;
    const drawRow = (yy, slide) => { const shown = Math.round(fillP * 32);
      for (let i = 0; i < 32; i++) { ctx.fillStyle = (fillP >= 1 || i < shown) ? DIM : "rgba(255,255,255,0.03)"; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); }
      for (let i = 0; i < 32; i++) { if ((regV >>> (31 - i)) & 1) { if (fillP < 1) { if (i < shown) { ctx.fillStyle = opCol; ctx.fillRect(mbarX + i * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); } } else { const p = (i + slide) % 32; ctx.fillStyle = opCol; ctx.fillRect(mbarX + p * mcw + 0.5, yy, Math.max(1, mcw - 1), 7); } } }
      if (fillP > 0 && fillP < 1) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mbarX + shown * mcw - 0.5, yy - 1, 1.6, 9); } };
    for (let k = 0; k < 3; k++) { const amt = amounts[k], done = k < rotIdx, curRow = k === rotIdx && fillP >= 1, slide = fillP < 1 ? 0 : (done ? amt : (curRow ? shiftProg * amt : 0));
      text(`${reg}⟲${amt}`, x0, my + 3.5, { size: 8, weight: curRow ? 700 : 600, color: (done || curRow) ? opCol : "rgba(255,255,255,0.4)", baseline: "middle", mono: true });
      drawRow(my, slide);
      if (curRow && shiftProg < 1) { ctx.strokeStyle = "rgba(255,245,170,0.9)"; ctx.lineWidth = 1.2; ctx.strokeRect(mbarX - 2, my - 1.5, x1 - mbarX + 3, 10); }
      my += 12; }
    my += 11; churnExplain = { t: fillP < 1 ? "one register feeds all three rotations" : "each row rotates the same bits by a different amount, then they XOR", y: my, o: { size: 8, color: "rgba(255,255,255,0.45)", baseline: "middle" } };
  }
  else {
    // input reference — show the register this operation reads, so the rotations connect back to it
    const eSide = curStep <= 6, showRef = eSide || (curStep >= 8 && curStep <= 12);
    if (showRef) { const inC = eSide ? 4 : 0, inCol = eSide ? TEAL : VIOL, rv = src[inC] >>> 0; text("read " + (eSide ? "e" : "a"), x0, my + 3.5, { size: 8, weight: 700, color: inCol, baseline: "middle", mono: true });
      const fillP = reduceMotion ? 1 : Math.min(1, Math.max(0, (animEl - stepBlinkMs) / stepWriteMs)), shown = Math.round(fillP * 32); // after the register blinks, the read row fills its bits in, left → right
      for (let i = 0; i < 32; i++) { ctx.fillStyle = i < shown ? (((rv >>> (31 - i)) & 1) ? inCol : DIM) : "rgba(255,255,255,0.03)"; ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
      if (fillP > 0 && fillP < 1) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(mbarX + shown * mcw - 0.5, my - 1, 1.6, 9); }
      my += 11; ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, my - 1); ctx.lineTo(x1, my - 1); ctx.stroke(); my += 3; }
    const VIS = 6, first = Math.max(0, curStep - VIS + 1);
    const contrib = { 3: 3, 6: 2, 11: 3 }[curStep]; // Σ1 result ← 3 rotations · Ch ← 2 · Σ0 ← 3 rotations (XOR them)
    for (let si = first; si <= curStep; si++) {
      const st = steps[si], cur = si === curStep, isContrib = contrib && si >= curStep - contrib && si < curStep;
      ctx.globalAlpha = cur ? 1 : (isContrib ? 0.92 : Math.max(0.3, 1 - (curStep - si) * 0.13));
      text((st.res ? "= " : "  ") + (st.g + "    ").slice(0, 5) + " " + st.l, x0, my + 3.5, { size: 8, weight: cur ? 700 : 600, color: st.c, baseline: "middle", mono: true });
      const rotDelay = st.rn ? 1150 : 0; // a rotation waits for the read-in (blink + fill) to finish, then shifts
      const arp = (cur && (st.rn || st.add) && !reduceMotion) ? Math.min(1, Math.max(0, (churnLiveNow - churnRotStart - rotDelay) / (st.rn ? churnAnimMs / 2 : churnAnimMs))) : 1; // rotations run at double speed, after the read
      if (cur && st.rn) { // animated rotate — ONCE per step: duplicate the input register, slide its bits right by rn, then hold
        const inV = src[st.rd[0]] >>> 0;
        for (let i = 0; i < 32; i++) { ctx.fillStyle = DIM; ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
        for (let i = 0; i < 32; i++) if ((inV >>> (31 - i)) & 1) { const p = (i + arp * st.rn) % 32; ctx.fillStyle = st.c; ctx.fillRect(mbarX + p * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
      } else if (cur && st.add) { // 5-way sum: settles LSB→MSB with a cursor at the column being added
        const sp = arp * 34, bc = Math.min(31, Math.floor(sp));
        for (let i = 0; i < 32; i++) { const b = 31 - i, local = sp - b; ctx.fillStyle = local < 0 ? "rgba(255,255,255,0.035)" : (((st.v >>> (31 - i)) & 1) ? st.c : DIM); ctx.fillRect(mbarX + i * mcw + 0.5, my, Math.max(1, mcw - 1), 7); }
        if (arp < 1) { const ix = mbarX + (31 - bc) * mcw; ctx.strokeStyle = "rgba(255,245,170,0.95)"; ctx.lineWidth = 1.2; ctx.strokeRect(ix - 1, my - 2, mcw + 1, 11); text("+ carry ◂", mbarX - 52, my + 3.5, { size: 7, weight: 700, color: "rgba(255,240,150,0.9)", align: "left", baseline: "middle" }); }
      } else mbar(my, st.v, st.c);
      if (isContrib) text("⊕", mbarX - 10, my + 3.5, { size: 10, weight: 700, color: st.c, align: "center", baseline: "middle" });
      if (cur) { ctx.strokeStyle = st.c; ctx.lineWidth = 1.2; ctx.strokeRect(mbarX - 2, my - 2, x1 - mbarX + 3, 11); }
      ctx.globalAlpha = 1; my += 12.5;
    }
  }
  if (scrollP > 0) ctx.restore();
  if (churnExplain) { const keep = Math.ceil((1 - scrollP) * churnExplain.t.length); if (keep > 0) text(churnExplain.t.slice(0, keep), x0, churnExplain.y, churnExplain.o); } // stays put; as the step scrolls out it REVERSE-CLEARS (backspaces) char by char
  if (freshRow && scrollP > 0) { // during scroll-out the ACTUAL output row slides — full opacity, one continuous motion — from its (pinned) result row straight up into its reserved store slot (no fade-out-here / fade-in-there)
    const from = resultRowY > 0 ? resultRowY : storedBottom + 30, ty = from + slideUp * (freshSlotY - from), lc = freshRow.c;
    frameOut(ty); text(freshRow.l, x0, ty + 3.5, { size: 8, weight: 700, color: lc, baseline: "middle", mono: true });
    for (let i = 0; i < 32; i++) { ctx.fillStyle = ((freshRow.v >>> (31 - i)) & 1) ? lc : DIM; ctx.fillRect(mbarX + i * mcw + 0.5, ty, Math.max(1, mcw - 1), 7); }
  }
  const msgY = aby + 172;
  text("MESSAGE WORDS ↦ one consumed per round · W0–W15 = your 512-bit message (blue) · W16+ = expanded (purple)", x0, msgY, { size: 9, weight: 700, color: "rgba(255,255,255,0.55)", baseline: "middle" });
  const msY = msgY + 11, VIS = 7, wordW = (x1 - x0) / VIS, wbw = wordW - 12, wbcw = wbw / 32;
  const base = Math.floor(R / VIS) * VIS; // a fixed page of words — the highlight walks across, then the page flips at the end (no per-round scroll)
  for (let slot = 0; slot < VIS; slot++) {
    const wi = base + slot;
    if (wi > 63) continue;
    const wx = x0 + slot * wordW, val = (d.W[wi] || 0) >>> 0, consumed = wi < R, current = wi === R, expanded = wi >= 16;
    const col = current ? "rgba(255,235,140,1)" : consumed ? "rgba(255,255,255,0.12)" : expanded ? "rgba(180,140,255,0.85)" : "rgba(110,205,255,1)";
    for (let b = 0; b < 32; b++) { ctx.fillStyle = ((val >>> (31 - b)) & 1) ? col : "rgba(255,255,255,0.05)"; ctx.fillRect(wx + b * wbcw, msY, Math.max(0.7, wbcw - 0.3), 9); }
    if (current) { ctx.strokeStyle = "rgba(255,215,90,0.9)"; ctx.lineWidth = 1.4; ctx.strokeRect(wx - 2, msY - 2, wbw + 4, 13); }
    text("W" + wi + (expanded ? "·exp" : ""), wx + wbw / 2, msY + 18, { size: 7.5, weight: current ? 700 : 400, color: current ? "rgba(255,215,90,0.95)" : consumed ? "rgba(255,255,255,0.28)" : expanded ? "rgba(180,140,255,0.85)" : "rgba(120,205,255,0.95)", align: "center", baseline: "middle" });
  }
}

// ONE STEP · Σ1 — the round's first operation fully unpacked (input → change → output), so a single mixing
// step is concrete: take register e, make three rotated copies, XOR them → Σ1. The others (Ch, Σ0, Maj) follow
// the same input→change→output shape on different registers.
function drawSigma1(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0;
  const e = _SHA_H0[4] >>> 0; // round 0's register e = frac √11 (fixed, so this is a stable worked example)
  const r6 = _rotr(e, 6), r11 = _rotr(e, 11), r25 = _rotr(e, 25), S1 = (r6 ^ r11 ^ r25) >>> 0;
  const IN = "rgba(120,200,255,0.92)", DIM = "rgba(140,185,240,0.9)", OUT = "rgba(90,235,150,0.95)";
  text("SCRAMBLE (Σ1) — the round's FIRST operation, unpacked: input → change → output", x0, r.y + 16, { size: 12.5, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("Σ1 (“sigma-one” — a Greek letter, not E1) scrambles ONE register (e): make 3 rotated copies of e, then XOR them together. The result feeds into T1.", x0, r.y + 33, { size: 10.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const lx = x0, barX = x0 + 132, cw = (w - 132) / 32;
  const bar = (by, val, on) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? on : "rgba(255,255,255,0.06)"; ctx.fillRect(barX + i * cw + 0.5, by, Math.max(1, cw - 1), 11); } };
  const rowL = (yy, lbl, sub, c) => { text(lbl, lx, yy + 6, { size: 12, weight: 700, color: c, baseline: "middle", mono: true }); if (sub) text(sub, lx, yy + 20, { size: 9, color: "rgba(255,255,255,0.5)", baseline: "middle" }); };
  const note = (yy, t) => text(t, x0, yy, { size: 9.5, weight: 700, color: "rgba(255,215,90,0.8)", baseline: "middle" });
  let y = r.y + 54;
  note(y, "① INPUT"); y += 13;
  rowL(y, "e", "register e  (= frac √11)", IN); bar(y, e, IN); y += 38;
  note(y, "② CHANGE — three rotated copies of e (rotate-right = slide bits right, wrapping around the end)"); y += 15;
  rowL(y, "e ⟲ 6", "e rotated right 6", DIM); bar(y, r6, DIM); y += 28;
  rowL(y, "e ⟲ 11", "…rotated right 11", DIM); bar(y, r11, DIM); y += 28;
  rowL(y, "e ⟲ 25", "…rotated right 25", DIM); bar(y, r25, DIM); y += 37;
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(barX, y - 1); ctx.lineTo(x1, y - 1); ctx.stroke();
  note(y + 6, "③ OUTPUT — XOR the three copies (each column: 1 if an ODD number of them are 1)"); y += 20;
  rowL(y, "Σ1", "→ feeds into T1", OUT); bar(y, S1, OUT); y += 32;
  text("Why e, and why 6/11/25? By design: e (with a) is the register refreshed each round; the rotate amounts were tuned by the designers for maximum bit-spreading. Ch, Σ0 and Maj are the same input→change→output idea on other registers.", x0, y, { size: 9.5, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// THE SHIFT — a mid-level view: a few rounds side by side (columns) so the register cycling is visible. a & e
// are the freshly-mixed "hot seats" (gold, message W added); the other six slide DOWN one slot each round. The
// teal outline traces one constant riding down the slots into a hot seat, where it finally gets mixed.
function drawShift(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, d = hashViz.data;
  const BLUE = "rgba(110,205,255,1)", GOLD = "rgba(255,215,90,0.95)", TRACE = "rgba(80,225,215,0.95)", DIM = "rgba(255,255,255,0.06)";
  text("THE SHIFT — a few rounds stacked: how the message spreads to all 8 registers", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("Columns = the 8 registers · rows = rounds ↓. a & e are freshly mixed each round (gold, message word W added); the rest shift to the next register. Teal follows one value: it rides a→b→c→d, gets MIXED in the e hot seat, then keeps riding e→f→g→h.", x0, r.y + 33, { size: 10, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  if (!d) return;
  const names = "abcdefgh", rounds = [_SHA_H0, d.rounds[0], d.rounds[1], d.rounds[2], d.rounds[3], d.rounds[4], d.rounds[5], d.rounds[6]];
  const rlab = ["start", "round 0", "round 1", "round 2", "round 3", "round 4", "round 5", "round 6"];
  const gx = x0 + 60, gy = r.y + 62, cwid = (x1 - gx) / 8, bw = cwid - 12, bcw = bw / 32, rh = 24;
  const rowY = (ri) => gy + 14 + ri * rh;
  for (let c = 0; c < 8; c++) { const hot = (c === 0 || c === 4); text(names[c], gx + c * cwid + bw / 2, gy, { size: 11, weight: 700, color: hot ? GOLD : "rgba(255,255,255,0.6)", align: "center", baseline: "middle", mono: true }); }
  for (let ri = 0; ri < rounds.length; ri++) {
    const ry = rowY(ri);
    text(rlab[ri], x0, ry + 4, { size: 9, weight: 600, color: ri === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,215,90,0.6)", baseline: "middle" });
    for (let c = 0; c < 8; c++) {
      const cx = gx + c * cwid, val = rounds[ri][c] >>> 0, isHot = (c === 0 || c === 4) && ri > 0;
      for (let b = 0; b < 32; b++) { ctx.fillStyle = ((val >>> (31 - b)) & 1) ? (isHot ? GOLD : BLUE) : DIM; ctx.fillRect(cx + b * bcw, ry, Math.max(0.7, bcw - 0.3), 9); }
      if (isHot) { ctx.strokeStyle = "rgba(255,215,90,0.6)"; ctx.lineWidth = 1; ctx.strokeRect(cx - 1.5, ry - 1.5, bw + 3, 12); }
    }
  }
  // trace one constant riding the diagonal a→…→e (gets mixed) →…→h — its full journey across the registers
  for (let k = 0; k < 8; k++) { const cx = gx + k * cwid, ry = rowY(k); ctx.strokeStyle = TRACE; ctx.lineWidth = 1.6; ctx.strokeRect(cx - 2.5, ry - 2.5, bw + 5, 14); }
  text("In ~8 rounds every register takes a turn in a gold hot seat — that's how your message (added only at a & e) spreads to all 256 bits.", x0, rowY(rounds.length - 1) + 22, { size: 10, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// ONE STEP · Ch — the "choose" operation unpacked: register e is a per-bit selector between f and g.
function drawCh(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0;
  const e = _SHA_H0[4] >>> 0, f = _SHA_H0[5] >>> 0, g = _SHA_H0[6] >>> 0, ch = ((e & f) ^ (~e & g)) >>> 0;
  const SEL = "rgba(255,215,90,0.92)", F = "rgba(120,200,255,0.92)", G = "rgba(190,130,255,0.92)", OFF = "rgba(255,255,255,0.06)";
  text("CHOOSE (Ch) — for each bit, register e picks between f and g", x0, r.y + 16, { size: 12.5, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("Ch = (e∧f) ⊕ (¬e∧g). Read e as a selector: where e's bit is 1 → take f's bit; where e's bit is 0 → take g's bit.", x0, r.y + 33, { size: 10.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const lx = x0, barX = x0 + 150, cw = (w - 150) / 32;
  const bar = (by, colOf) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = colOf(i); ctx.fillRect(barX + i * cw + 0.5, by, Math.max(1, cw - 1), 11); } };
  const on = (v, col) => (i) => ((v >>> (31 - i)) & 1) ? col : OFF;
  const rowL = (yy, lbl, sub, col) => { text(lbl, lx, yy + 6, { size: 12, weight: 700, color: col, baseline: "middle", mono: true }); if (sub) text(sub, lx, yy + 20, { size: 9, color: "rgba(255,255,255,0.5)", baseline: "middle" }); };
  const note = (yy, t) => text(t, x0, yy, { size: 9.5, weight: 700, color: "rgba(255,215,90,0.8)", baseline: "middle" });
  let y = r.y + 54;
  note(y, "① INPUT — three registers: e is the selector, f & g are the options"); y += 14;
  rowL(y, "e", "the selector (bit 1 → pick f · bit 0 → pick g)", SEL); bar(y, on(e, SEL)); y += 31;
  rowL(y, "f", "taken where e = 1", F); bar(y, on(f, F)); y += 31;
  rowL(y, "g", "taken where e = 0", G); bar(y, on(g, G)); y += 37;
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(barX, y - 1); ctx.lineTo(x1, y - 1); ctx.stroke();
  note(y + 6, "③ OUTPUT — each lit bit copied from f (blue) or g (purple), chosen by e"); y += 20;
  rowL(y, "Ch", "= f and g interleaved, per e", "rgba(90,235,150,0.95)"); bar(y, (i) => { if (!((ch >>> (31 - i)) & 1)) return OFF; return ((e >>> (31 - i)) & 1) ? F : G; }); y += 32;
  text("So Ch is just f and g woven together, bit by bit, with e as the switch. (Maj — the next step — is the same shape but a majority VOTE of a, b, c.)", x0, y, { size: 9.5, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// ONE STEP · Maj — the "majority" operation unpacked: each output bit is the majority of a, b, c.
function drawMaj(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0;
  const a = _SHA_H0[0] >>> 0, b = _SHA_H0[1] >>> 0, c = _SHA_H0[2] >>> 0, maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
  const A = "rgba(120,200,255,0.92)", B = "rgba(120,230,200,0.9)", C = "rgba(190,130,255,0.92)", OUT = "rgba(90,235,150,0.95)", OFF = "rgba(255,255,255,0.06)";
  text("MAJORITY (Maj) — each output bit is the majority vote of a, b, c", x0, r.y + 16, { size: 12.5, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("Maj = (a∧b) ⊕ (a∧c) ⊕ (b∧c). Column by column: if at least 2 of the three bits are 1, the output is 1; otherwise 0.", x0, r.y + 33, { size: 10.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const lx = x0, barX = x0 + 150, cw = (w - 150) / 32;
  const bar = (by, colOf) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = colOf(i); ctx.fillRect(barX + i * cw + 0.5, by, Math.max(1, cw - 1), 11); } };
  const on = (v, col) => (i) => ((v >>> (31 - i)) & 1) ? col : OFF;
  const rowL = (yy, lbl, sub, col) => { text(lbl, lx, yy + 6, { size: 12, weight: 700, color: col, baseline: "middle", mono: true }); if (sub) text(sub, lx, yy + 20, { size: 9, color: "rgba(255,255,255,0.5)", baseline: "middle" }); };
  const note = (yy, t) => text(t, x0, yy, { size: 9.5, weight: 700, color: "rgba(255,215,90,0.8)", baseline: "middle" });
  let y = r.y + 54;
  note(y, "① INPUT — three registers a, b, c"); y += 14;
  rowL(y, "a", "", A); bar(y, on(a, A)); y += 30;
  rowL(y, "b", "", B); bar(y, on(b, B)); y += 30;
  rowL(y, "c", "", C); bar(y, on(c, C)); y += 36;
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(barX, y - 1); ctx.lineTo(x1, y - 1); ctx.stroke();
  note(y + 6, "③ OUTPUT — 1 wherever at least 2 of a, b, c have a 1 (the majority wins)"); y += 20;
  rowL(y, "Maj", "= the per-column majority", OUT); bar(y, on(maj, OUT)); y += 32;
  text("Maj blends a, b, c so no single register dominates. Σ0 + Maj build T2. (Σ0 is exactly Σ1's rotate-XOR, on register a with amounts 2/13/22.)", x0, y, { size: 9.5, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// BIT OPERATIONS — the atomic ops SHA-256 is built from: rotate, XOR, AND, add, on example 32-bit words, so you
// can see what the computer physically does. rotate animates; each binary op shows A over B → result (green).
function drawBitOps(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad;
  const A = 0xC3A5F02D >>> 0, B = 0x9E3779B1 >>> 0;
  const IN = "rgba(120,200,255,0.9)", B2 = "rgba(190,190,190,0.6)", OUT = "rgba(90,235,150,0.95)", G = "rgba(255,215,90,0.95)", OFF = "rgba(255,255,255,0.06)", dim = "rgba(255,255,255,0.45)";
  const EXW = 210, barX = x0 + 34, bx1 = x1 - EXW, cw = (bx1 - barX) / 32, ex0 = bx1 + 24;
  text("THE FOUR OPERATIONS — the only building blocks SHA-256 uses", x0, r.y + 15, { size: 12, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("Four SEPARATE tools in their own boxes — NOT a pipeline. Each runs on its own inputs; they don't feed each other. Within a box: inputs above the line, result (green) below.", x0, r.y + 30, { size: 9.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const row = (by, val, on) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? on : OFF; ctx.fillRect(barX + i * cw + 0.5, by, Math.max(1, cw - 1), 8); } };
  const rlbl = (by, t, c) => text(t, x0, by + 4, { size: 10, weight: 700, color: c, baseline: "middle", mono: true });
  const divline = (ly) => { ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(barX, ly + 0.5); ctx.lineTo(bx1, ly + 0.5); ctx.stroke(); };
  const head = (hy, name, def) => { text(name, x0, hy, { size: 11, weight: 700, color: G, baseline: "middle" }); text(def, x0 + 84, hy, { size: 9.5, color: dim, baseline: "middle" }); };
  const card = (topY, h) => { ctx.fillStyle = "rgba(255,255,255,0.022)"; roundRect(r.x + 8, topY, r.w - 16, h, 6); ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.09)"; ctx.lineWidth = 1; roundRect(r.x + 8, topY, r.w - 16, h, 6); ctx.stroke(); };
  const S = 20;
  const cell = (cx, cy, bit, color) => {
    ctx.fillStyle = bit ? color : "rgba(255,255,255,0.06)"; ctx.fillRect(cx, cy, S, S);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(cx + 0.5, cy + 0.5, S - 1, S - 1);
    text(String(bit), cx + S / 2, cy + S / 2 + 0.5, { size: 12, weight: 700, color: bit ? "#0b0b0b" : color, align: "center", baseline: "middle", mono: true });
  };
  const glyph = (gx, gy, t) => text(t, gx, gy, { size: 13, weight: 700, color: dim, align: "center", baseline: "middle" });
  const ROT_H = 43, BIN_H = 52, GAP = 6;
  let top = r.y + 46;
  // ── rotate — its own box. A FIXED right-by-1 (static); box the bit that falls off the right + reappears left.
  card(top, ROT_H);
  { const hy = top + 11, ri = top + 22, ro = top + 32;
    head(hy, "⟲ rotate", "shift every bit one place right → the bit off the right end wraps back to the left");
    rlbl(ri, "in", IN); row(ri, A, IN);
    divline(ro - 2); rlbl(ro, "=", OUT); row(ro, ((A >>> 1) | (A << 31)) >>> 0, OUT);
    ctx.strokeStyle = G; ctx.lineWidth = 1.5; ctx.strokeRect(barX + 31 * cw - 1, ri - 1.5, cw + 2, 11); ctx.strokeRect(barX - 1, ro - 1.5, cw + 2, 11);
    const my = (ri + ro) / 2; text("the boxed bit fell off", ex0, my - 5, { size: 9, color: dim, baseline: "middle" }); text("the right → wrapped left ↺", ex0, my + 6, { size: 9, color: dim, baseline: "middle" });
  }
  top += ROT_H + GAP;
  // ── XOR / AND — each in its own box: two inputs → result, plus an honest single-column zoom
  const triple = (name, def, op, col, res) => {
    card(top, BIN_H);
    const hy = top + 11, ay = top + 22, byy = top + 31, ry = top + 41;
    head(hy, name, def);
    rlbl(ay, "A", IN); row(ay, A, IN);
    rlbl(byy, op + " B", B2); row(byy, B, B2);
    divline(ry - 2); rlbl(ry, "=", OUT); row(ry, res >>> 0, OUT);
    ctx.strokeStyle = G; ctx.lineWidth = 1.5; ctx.strokeRect(barX + col * cw - 1, ay - 1.5, cw + 2, ry - ay + 11);
    const aBit = (A >>> (31 - col)) & 1, bBit = (B >>> (31 - col)) & 1, rBit = (res >>> (31 - col)) & 1;
    const my = (ay + ry) / 2 + 3, cy = my - S / 2;
    text("this op, one column:", ex0, ay - 3, { size: 8.5, color: dim, baseline: "middle" });
    cell(ex0, cy, aBit, IN); glyph(ex0 + 30, my, op); cell(ex0 + 42, cy, bBit, B2); glyph(ex0 + 72, my, "="); cell(ex0 + 84, cy, rBit, OUT);
    top += BIN_H + GAP;
  };
  triple("⊕ XOR", "1 where the two bits DIFFER, 0 where they match", "⊕", 29, A ^ B);
  triple("∧ AND", "1 only where BOTH bits are 1, else 0", "∧", 31, A & B);
  // ── add — its own box. Carries ACROSS columns, so the zoom shows the carry rule (not one bar column) — a touch taller to give the carry row air
  card(top, BIN_H + 12);
  { const hy = top + 11, aa = top + 22, bb = top + 31, ar = top + 41;
    head(hy, "➕ add", "add as numbers; when a column overflows it carries into the next (top carry wraps, mod 2³²)");
    rlbl(aa, "A", IN); row(aa, A, IN);
    rlbl(bb, "+ B", B2); row(bb, B, B2);
    divline(ar - 2); rlbl(ar, "=", OUT); row(ar, (A + B) >>> 0, OUT);
    const my = (aa + ar) / 2 + 3, cy = my - S / 2;
    text("this op, one column:", ex0, aa - 3, { size: 8.5, color: dim, baseline: "middle" });
    cell(ex0, cy, 1, IN); glyph(ex0 + 30, my, "+"); cell(ex0 + 42, cy, 1, B2); glyph(ex0 + 72, my, "=");
    cell(ex0 + 84, cy, 1, OUT); cell(ex0 + 106, cy, 0, OUT);
    text("↑ carry", ex0 + 84, my + 18, { size: 8, color: G, baseline: "middle" });
  }
  top += BIN_H + 12 + GAP;
  text("these are the TOOLS, not the order — ONE ROUND (above) shows how they're combined into the recipe, run 64× until it looks random", x0, top + 4, { size: 10, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

function drawContent(s, r) {
  if (s === "nextBlock") return drawNextBlock(r);
  if (s === "mempool") return drawMempool(r);
  if (s === "closeness") return drawCloseness(r);
  if (s === "tickets") return drawTickets(r);
  if (s === "merkle") return drawMerkle(r);
  if (s === "fold") return drawFold(r);
  if (s === "hashBuild") return drawHashBuild(r);
  if (s === "avalanche") return drawAvalanche(r);
  if (s === "verify") return drawVerify(r);
  if (s === "hashInside") return drawHashInside(r);
  if (s === "oneRound") return drawOneRound(r);
  if (s === "shift") return drawShift(r);
  if (s === "churn") return drawChurn(r);
  if (s === "sigma1") return drawSigma1(r);
  if (s === "ch") return drawCh(r);
  if (s === "maj") return drawMaj(r);
  if (s === "bitOps") return drawBitOps(r);
  if (s === "network") return drawNetwork(r);
  if (s === "broadcast") return drawBroadcast(r);
  if (s === "win") return drawWin(r);
  if (s === "sync") return drawSync(r);
  if (s === "updates") return drawUpdates(r);
}

function drawNextBlock(r) {
  if (!model.block) { text("waiting…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  // Everything above the timeline is laid out against a FIXED top zone, not against r.h. The panel grew to
  // make room for the strip; measuring from r.h would drift the ring downward and stretch the histogram bars.
  const topH = 170, cx = r.x + 78, cy = r.y + topH / 2, rad = 52;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp));
  const over = elapsed > 600; // past the ~10-min estimate — count UP the overrun (long blocks are normal: Poisson)
  const progress = Math.min(1, elapsed / 600);
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = over ? "rgba(255,180,80,0.95)" : `rgba(${ACCENT}, 0.9)`; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); ctx.stroke(); ctx.lineCap = "butt";
  // past 10 min: nest an inner ring for each further 10-min window; the innermost is the current one, filling.
  const intervals = Math.floor(elapsed / 600); // # of 10-min windows entered beyond the first (0 until over)
  if (over && intervals >= 1) {
    const spacing = Math.min(8, (rad - 16) / intervals); // keep the centre (r<16) clear for the countdown text
    for (let i = 1; i <= intervals; i++) {
      const ir = rad - i * spacing, frac = i < intervals ? 1 : (elapsed % 600) / 600;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,180,80,0.15)"; ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(255,190,90,0.9)"; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(cx, cy, ir, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke(); ctx.lineCap = "butt";
    }
  }
  const disp = over ? elapsed - 600 : 600 - elapsed;
  const ringTxt = `${over ? "+" : ""}${Math.floor(disp / 60)}:${String(disp % 60).padStart(2, "0")}`;
  let ringSize = 22; ctx.font = `700 ${ringSize}px ui-monospace, monospace`; // fit inside the ring for unusually long intervals
  while (ctx.measureText(ringTxt).width > rad * 1.7 && ringSize > 12) { ringSize--; ctx.font = `700 ${ringSize}px ui-monospace, monospace`; }
  if (over) { // soft dark glow lifts the digits off the nested rings — cleaner than a boxy pill
    ctx.save(); ctx.shadowColor = "rgba(6,5,10,0.95)"; ctx.shadowBlur = 7;
    for (let g = 0; g < 3; g++) text(ringTxt, cx, cy, { size: ringSize, weight: 700, color: "rgba(255,190,90,1)", align: "center", baseline: "middle", mono: true });
    ctx.restore();
  } else {
    text(ringTxt, cx, cy, { size: ringSize, weight: 700, color: "#fff", align: "center", baseline: "middle", mono: true });
  }
  text(over ? "over ~10 min est" : "next block (est)", cx, cy + rad + 16, { size: 14, color: over ? "rgba(255,180,80,0.8)" : "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
  const rows = [["Elapsed", `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`], ["Avg block", "~10:00"], ["Last block", "#" + model.tipHeight.toLocaleString()]];
  let sy = cy - 38;
  for (const [l, v] of rows) { text(l, r.x + 200, sy, { size: 15, color: "rgba(255,255,255,0.5)", baseline: "middle" }); text(v, r.x + 340, sy, { size: 15, weight: 600, color: "rgba(255,255,255,0.85)", baseline: "middle" }); sy += 32; }
  // block-time distribution (empty right side): the memoryless/exponential shape — most blocks quick, a long
  // tail of slow ones, mean ~10. Same math as the hash lottery, which is the whole point.
  if (model.blockTimes && model.blockTimes.length >= 12) {
    const bt = model.blockTimes, hx = r.x + 452, hRight = r.x + r.w - 24, hw = hRight - hx;
    if (hw > 200) {
      const BW = 3, NB = 11, SPAN = NB * BW, buckets = new Array(NB).fill(0); // 3-min buckets: 0–3, 3–6, … 27–30, 30+
      for (const v of bt) buckets[Math.min(NB - 1, Math.floor(v / BW))]++;
      const maxC = Math.max(1, ...buckets), bw = hw / NB, hBot = r.y + topH - 50, hTop = r.y + 40, hH = hBot - hTop;
      const mean = bt.reduce((a, b) => a + b, 0) / bt.length;
      text(`block times · last ${bt.length} blocks · avg ${mean.toFixed(1)} min`, hx, r.y + 20, { size: 11, weight: 600, color: "rgba(255,255,255,0.6)", baseline: "middle" });
      for (let i = 0; i < NB; i++) {
        const bh = (buckets[i] / maxC) * hH, bx = hx + i * bw;
        ctx.fillStyle = i === Math.floor(10 / BW) ? "rgba(255,190,90,0.85)" : `rgba(${ACCENT},0.5)`; // gold = the bucket the ~10-min mean falls in; the tall first bar is the mode
        ctx.fillRect(bx + 1, hBot - bh, Math.max(1, bw - 2), bh);
        text(i === NB - 1 ? "30+" : `${i * BW}`, bx, hBot + 12, { size: 8.5, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" }); // the minute each bar starts at
      }
      ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hx, hBot + 0.5); ctx.lineTo(hRight, hBot + 0.5); ctx.stroke();
      text("min", hRight, hBot + 12, { size: 8.5, color: "rgba(255,255,255,0.3)", align: "right", baseline: "middle" });
      // "you are here" — where the current still-mining block's elapsed time lands in the distribution
      const nowM = Math.min(elapsed / 60, SPAN), mx = hx + (nowM / SPAN) * hw, rightSide = nowM > SPAN * 0.76;
      const mkCol = over ? "255,190,90" : ACCENT;
      ctx.strokeStyle = `rgba(${mkCol},0.95)`; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(mx, hTop - 4); ctx.lineTo(mx, hBot); ctx.stroke(); ctx.setLineDash([]);
      { const nowTxt = `▾ now ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
        ctx.font = "700 9.5px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"; const ntw = ctx.measureText(nowTxt).width;
        const bxl = rightSide ? mx - 5 - ntw : mx + 5; ctx.fillStyle = "rgba(8,6,12,0.88)"; roundRect(bxl - 3, hTop - 5, ntw + 6, 16, 4); ctx.fill(); // dark backdrop so the marker reads over the gold bar
        text(nowTxt, mx + (rightSide ? -5 : 5), hTop + 3, { size: 9.5, weight: 700, color: over ? "rgba(255,216,150,1)" : "rgba(150,235,255,1)", align: rightSide ? "right" : "left", baseline: "middle" }); }
    }
  }
  if (over) text(`long blocks are normal — each inner ring = another 10-min window (now in #${intervals + 1}) · ~37% run past 10, ~5% past 30`, r.x + 192, r.y + topH - 16, { size: 11, color: "rgba(255,180,80,0.72)", baseline: "middle" });
  else if (model.blockTimes && model.blockTimes.length >= 12) text("Block times are memoryless — 10 min is an average, not a schedule. Same dice as your hash lottery: each try is independent.", r.x + 192, r.y + topH - 16, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  drawBlockTimeline(r, r.y + topH, elapsed, over);
}

// WHEN the recent blocks arrived — the one thing the histogram above cannot show. A histogram drops order, so
// two blocks a minute apart and two ten hours apart land in the same bucket; here the first reads as a cluster
// and the second as a gap. Right edge is NOW, so the empty space after the last tick is the block currently
// being mined, widening while you watch — the same quantity the countdown ring on the left is counting.
function drawBlockTimeline(r, top, elapsed, over) {
  const h = model.blockHistory;
  if (!Array.isArray(h) || h.length < 4) return;
  const x0 = r.x + 24, x1 = r.x + r.w - 24, w = x1 - x0;
  if (w < 220) return;                                  // too narrow to read; the panel above still stands alone
  const yTop = top + 20, yBot = r.y + r.h - 16, mid = (yTop + yBot) / 2, half = (yBot - yTop) / 2;
  const now = Date.now() / 1000, t0 = h[0].timestamp, span = Math.max(1800, now - t0);
  const at = (ts) => x0 + ((ts - t0) / span) * w;
  const hours = span / 3600;

  text(`when they arrived · last ${h.length} blocks over ~${hours < 2 ? hours.toFixed(1) : Math.round(hours)} h`,
    x0, top + 8, { size: 11, weight: 600, color: "rgba(255,255,255,0.6)", baseline: "middle" });

  // hour gridlines, walked back from now so "now" is always exactly on the right edge
  const step = hours > 8 ? 2 : hours > 4 ? 1 : 0.5;
  for (let k = step; k < hours; k += step) {
    const gx = at(now - k * 3600);
    if (gx < x0 + 8) break;
    ctx.strokeStyle = "rgba(255,255,255,0.055)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gx, yTop); ctx.lineTo(gx, yBot); ctx.stroke();
    text(`${k % 1 ? k.toFixed(1) : k}h`, gx, yBot + 9, { size: 8.5, color: "rgba(255,255,255,0.3)", align: "center", baseline: "middle" });
  }
  ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, mid + 0.5); ctx.lineTo(x1, mid + 0.5); ctx.stroke();

  // the gap that hasn't closed yet — shaded, and it grows in real time
  const lastX = at(h[h.length - 1].timestamp);
  ctx.fillStyle = over ? "rgba(255,180,80,0.10)" : `rgba(${ACCENT},0.10)`;
  ctx.fillRect(lastX, yTop, Math.max(1, x1 - lastX), yBot - yTop);

  // one tick per block. A SHORT preceding gap draws taller and brighter, so a burst is visible at a glance
  // rather than being something you have to measure.
  let hov = null;
  for (let i = 0; i < h.length; i++) {
    const bx = at(h[i].timestamp);
    if (bx < x0 - 1) continue;
    const gapMin = i ? (h[i].timestamp - h[i - 1].timestamp) / 60 : 10;
    const q = Math.max(0, Math.min(1, 1 - gapMin / 20));  // 1 = back-to-back, 0 = 20 min or longer
    const th = half * (0.40 + 0.60 * q);
    ctx.strokeStyle = `rgba(${ACCENT},${(0.34 + 0.52 * q).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(bx, mid - th); ctx.lineTo(bx, mid + th); ctx.stroke();
    if (Math.abs(mouseX - bx) < 4 && mouseY > yTop - 6 && mouseY < yBot + 6) hov = { b: h[i], gapMin, bx };
  }

  // "now" edge
  ctx.strokeStyle = over ? "rgba(255,190,90,0.85)" : `rgba(${ACCENT},0.85)`; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x1, yTop - 3); ctx.lineTo(x1, yBot + 3); ctx.stroke();
  text("now", x1, yBot + 9, { size: 8.5, weight: 700, color: over ? "rgba(255,200,120,0.9)" : `rgba(${ACCENT},0.9)`, align: "right", baseline: "middle" });

  if (hov) {
    const t = new Date(hov.b.timestamp * 1000);
    const lbl = `#${hov.b.height.toLocaleString()} · ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} · ${hov.gapMin.toFixed(1)} min gap`;
    ctx.font = "700 9.5px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
    const tw = ctx.measureText(lbl).width, right = hov.bx + tw + 12 > x1;
    const bxl = right ? hov.bx - 6 - tw : hov.bx + 6;
    ctx.fillStyle = "rgba(8,6,12,0.92)"; roundRect(bxl - 4, yTop - 6, tw + 8, 15, 4); ctx.fill();
    text(lbl, hov.bx + (right ? -6 : 6), yTop + 1, { size: 9.5, weight: 700, color: "rgba(220,240,255,0.95)", align: right ? "right" : "left", baseline: "middle" });
  }
  window.__timeline = { ticks: h.length, spanH: +(span / 3600).toFixed(2), lastGapMin: +((now - h[h.length - 1].timestamp) / 60).toFixed(1) }; // test hook
}

// ---- MEMPOOL: live tx flow — pending transactions stream in, pool, then feed the next block ----
// fee-rate → colour, mempool.space-style: low purple/blue → teal → green → yellow → orange → red
const FEE_STOPS = [[0.5, [125, 95, 185]], [1, [95, 95, 215]], [2, [60, 125, 215]], [5, [40, 170, 205]], [10, [50, 200, 150]], [20, [120, 205, 90]], [40, [215, 205, 70]], [80, [235, 150, 55]], [300, [225, 75, 60]]];
function feeColor(f, a = 1) {
  const S = FEE_STOPS;
  if (f <= S[0][0]) return `rgba(${S[0][1].join(",")},${a})`;
  if (f >= S[S.length - 1][0]) return `rgba(${S[S.length - 1][1].join(",")},${a})`;
  let i = 0; while (i < S.length - 1 && f > S[i + 1][0]) i++;
  const t = (f - S[i][0]) / (S[i + 1][0] - S[i][0]);
  const c = (k) => Math.round(S[i][1][k] + (S[i + 1][1][k] - S[i][1][k]) * t);
  return `rgba(${c(0)},${c(1)},${c(2)},${a})`;
}
let mpSeed = 12345; const mpRand = () => { mpSeed = (mpSeed * 1103515245 + 12345) & 0x7fffffff; return mpSeed / 0x7fffffff; };
function sampleFee(hist) { // a fee rate weighted by the mempool's real vsize distribution
  if (!hist || !hist.length) return 1 + mpRand() * 3;
  let tot = 0; for (const b of hist) tot += b[1];
  let x = mpRand() * tot;
  for (const b of hist) { x -= b[1]; if (x <= 0) return b[0]; }
  return hist[hist.length - 1][0];
}
let mpTip = null, mpShip = 0, mpGhost = null, mpHarvestT = 0, mpHarvestTip = 0, mpHarvestTx = 0, mpHistSnap = null;
let mpFlow = [], mpFlowAcc = 0, mpFlowIdx = 0;
// fee "weather" — congestion mood from the next-block fee rate (sat/vB)
function feeWeather(f) {
  if (f <= 2) return { mood: "calm", note: "cheap to transact", col: "90,210,140" };
  if (f <= 8) return { mood: "steady", note: "normal fees", col: "150,205,110" };
  if (f <= 25) return { mood: "busy", note: "fees rising", col: "230,200,80" };
  if (f <= 70) return { mood: "congested", note: "fees high", col: "240,150,70" };
  return { mood: "jammed", note: "fees very high", col: "230,90,70" };
}
// Plain-English "why" for the mempool: turn the live next-block fee + backlog depth into one teaching sentence
// about the fee market (mechanism, never prediction). Tiers mirror feeWeather. f = sat/vB, depth = blocks
// of backlog, n = pending-tx count.
function mempoolExplainer(f, depth, n) {
  const fee = "~" + Math.max(1, Math.round(f || 0)) + " sat/vB";
  if (f <= 2) return depth <= 3
    ? "Mempool's nearly empty — the next block isn't even full, so almost any fee gets in. A cheap time to send."
    : `Fees are cheap (${fee}) — the deep backlog is mostly min-fee dust, so even a small fee jumps into the next block.`;
  if (f <= 8) return `Light backlog — a ${fee} fee gets you into the next block or two.`;
  if (f <= 25) return `Backlog building (~${depth} blocks) — nudging the next-block fee to ${fee}; miners take the top bidders first.`;
  if (f <= 70) return `Congested — ~${depth} blocks are queued, so the next block costs ${fee}; cheaper txs wait for it to drain.`;
  return `Jammed — heavy competition for block space is spiking fees to ${fee}; they fall once the ${n.toLocaleString()}-tx backlog clears.`;
}
// squarified treemap (Bruls/Huizing/van Wijk) — pack items {v, fee} into a rect so each AREA ∝ v, keeping
// squarish aspect ratios. This is how mempool.space draws a block: each tx is a tile sized by its vbytes.
function mpWorst(row, side) { let s = 0, mx = 0, mn = Infinity; for (const it of row) { s += it.a; if (it.a > mx) mx = it.a; if (it.a < mn) mn = it.a; } const s2 = s * s, d2 = side * side; return Math.max(d2 * mx / s2, s2 / (d2 * mn)); }
function squarify(items, x, y, w, h) {
  const total = items.reduce((s, it) => s + it.v, 0) || 1, scale = (w * h) / total;
  const a = items.map((it) => ({ a: it.v * scale, fee: it.fee })), out = [];
  let rx = x, ry = y, rw = w, rh = h, i = 0;
  while (i < a.length && rw > 0.5 && rh > 0.5) {
    let row = [a[i]], j = i + 1; const side = Math.min(rw, rh);
    while (j < a.length && mpWorst(row.concat(a[j]), side) <= mpWorst(row, side)) { row.push(a[j]); j++; }
    const sum = row.reduce((s, it) => s + it.a, 0);
    if (rw >= rh) { const cw = sum / rh; let yy = ry; for (const it of row) { const hh = it.a / sum * rh; out.push({ x: rx, y: yy, w: cw, h: hh, fee: it.fee }); yy += hh; } rx += cw; rw -= cw; }
    else { const rwh = sum / rw; let xx = rx; for (const it of row) { const ww = it.a / sum * rw; out.push({ x: xx, y: ry, w: ww, h: rwh, fee: it.fee }); xx += ww; } ry += rwh; rh -= rwh; }
    i = j;
  }
  return out;
}
// fill a block rect with a treemap of (representative) transactions — sized by space, coloured by fee
// (or a muted confirmed colour for mined-history blocks). Deterministic via `seed` for a stable layout.
function mpTreemap(bx, by, bw, bh, fr, seed, confirmed, fillFrac = 1) {
  mpSeed = seed;
  const nItems = Math.min(120, Math.max(12, Math.floor((bw * bh) / 72))), items = [];
  for (let k = 0; k < nItems; k++) { const v = 0.3 + mpRand() * mpRand() * mpRand() * 30; items.push({ v, fee: confirmed ? 0 : (fr[Math.floor(mpRand() * fr.length)] || 1) }); }
  items.sort((p, q) => q.v - p.v);
  const tiles = squarify(items, bx + 2, by + 2, bw - 4, bh - 4), lim = Math.ceil(tiles.length * Math.max(0, Math.min(1, fillFrac))); // fillFrac < 1 → fill in tile by tile (largest first)
  for (let ti = 0; ti < lim; ti++) { const t = tiles[ti]; ctx.fillStyle = confirmed ? "rgba(110,175,135,0.42)" : feeColor(t.fee, 0.9); ctx.fillRect(t.x + 0.4, t.y + 0.4, Math.max(0.7, t.w - 0.8), Math.max(0.7, t.h - 0.8)); }
}
// cover a rect with churning green glyphs — "this block is being mined / validated".
// lock 0→1: the scramble FREEZES and the colour settles bright-green → muted confirmed-green,
// so the glyphs read as the block hardening/locking into place rather than just flickering.
function glyphCover(bx, by, bw, bh, alpha, lock = 0) {
  if (alpha <= 0) return;
  ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cell = 11, cols = Math.max(1, Math.floor((bw - 4) / cell)), rows = Math.max(1, Math.floor((bh - 4) / cell));
  const fr = frame * (1 - lock); // animation slows to a standstill as it locks
  const cr = (90 + 20 * lock) | 0, cg = (235 - 55 * lock) | 0, cb = (150 - 15 * lock) | 0; // scramble-green → confirmed-green
  for (let rr = 0; rr < rows; rr++) for (let c = 0; c < cols; c++) {
    const churn = 0.35 + 0.5 * Math.abs(Math.sin(fr * 0.3 + c * 2 + rr));
    const a = alpha * (churn * (1 - lock) + 0.95 * lock); // settle to a steady, fully-lit grid
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
    ctx.fillText(CYBER[(Math.floor(fr) + c * 5 + rr * 3) % CYBER.length], bx + 4 + c * cell + cell / 2, by + 4 + rr * cell + cell / 2);
  }
}
function drawMempool(r) {
  mempoolHits = []; // rebuilt each frame — hover regions for the mined/next blocks (why some are taller)
  const mp = model.mempool;
  if (!mp || !mp.blocks || !mp.blocks.length) { text("loading the mempool…", r.x + r.w / 2, r.y + r.h / 2, { size: 14, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" }); return; }
  // the API's final entry is usually a giant AGGREGATE of the deep low-fee backlog. Split it out: the priced
  // blocks (≤~1 vMB each) are drawn individually; the aggregate becomes the "dust tail" of the fee-cliff strip.
  const priced = mp.blocks.filter((b) => (b.blockVSize || 0) <= 1_300_000);
  const agg = mp.blocks.find((b) => (b.blockVSize || 0) > 1_300_000) || null; // the deep min-fee dust
  const mem = (priced.length ? priced : mp.blocks.slice(0, 1)).slice(0, 7), nextBlk = mem[0]; // next + priced backlog
  const hist = (model.recentBlocks || []).slice(-3); // recently MINED blocks (history): oldest → newest
  const depth = Math.max(mem.length, Math.round((mp.vsize || mem.length * 1e6) / 1e6));
  text(`${mp.count.toLocaleString()} pending · ~${depth.toLocaleString()} blocks deep · time flows right → left: txs arrive, get mined, fall into history`, r.x + r.w / 2, r.y + 18, { size: 12, weight: 600, color: `rgba(${ACCENT},0.85)`, align: "center", baseline: "middle" });

  const padX = 20, top = r.y + 70, bot = r.y + r.h - 50, maxBH = bot - top, gap = 10; // top pushed down to give the fee explainer its own row under the title; bottom lifted so the dust label + "if you win" get air
  const dividerW = 22, nHist = hist.length, nBlocks = nHist + 1; // history blocks + the single "next" hero; the backlog is the fee-cliff strip
  const bw = Math.max(76, Math.min(108, ((r.w - 2 * padX - dividerW) * 0.46) / nBlocks - gap)); // blocks take ~left half; the strip fills the rest
  const SIZE_REF = 2.6e6, sizeH = (b) => Math.max(0.34, Math.min(1, (b.blockSize || b.size || b.blockVSize || 0) / SIZE_REF)); // height = data (bytes)
  const histW = nHist * (bw + gap), memStartX = r.x + padX + histW + (nHist ? dividerW : 0); // mempool starts after history + the "now" divider
  const stripX = memStartX + bw + gap, stripRight = r.x + r.w - padX, stripW = Math.max(80, stripRight - stripX); // fee-cliff strip spans from behind "next" to the right edge
  // fee-cliff strip metrics (shared so incoming tx particles can settle onto the dust tail)
  const backlog = mem.slice(1); // priced blocks queued behind "next"
  const remaining = Math.max(backlog.length, depth - 1); // total blocks behind "next"
  const dustBlocks = Math.max(0, remaining - backlog.length);
  const maxFee = Math.max(1, nextBlk.medianFee || 0, ...backlog.map((b) => b.medianFee || 0));
  const feeH = (f) => 0.16 + 0.84 * Math.min(1, Math.sqrt((f || 0) / maxFee)); // sqrt: the low-fee tail keeps visible height steps
  let stripSegW, stripPricedW, stripDustW;
  if (dustBlocks > 0 && backlog.length) { stripSegW = Math.min((stripW * 0.5) / backlog.length, Math.max(11, stripW / remaining)); stripPricedW = stripSegW * backlog.length; stripDustW = Math.max(0, stripW - stripPricedW); }
  else { stripSegW = backlog.length ? stripW / backlog.length : 0; stripPricedW = stripW; stripDustW = 0; } // no deep dust → priced blocks fill the strip
  const dustStartX = stripX + stripPricedW, dustFee = (agg && agg.medianFee) || 0.1;
  const dustTopY = bot - maxBH * feeH(dustBlocks > 0 ? dustFee : (backlog.length ? backlog[backlog.length - 1].medianFee : nextBlk.medianFee)); // surface the particles land on

  // #6 fee weather (top-left)
  if (model.fees) { const w = feeWeather(model.fees.fastestFee); ctx.fillStyle = `rgba(${w.col},0.95)`; ctx.beginPath(); ctx.arc(r.x + padX + 4, r.y + 18, 4, 0, 7); ctx.fill(); text(`${w.mood} · ${model.fees.fastestFee} sat/vB`, r.x + padX + 13, r.y + 18, { size: 11, weight: 700, color: `rgba(${w.col},0.95)`, baseline: "middle" }); }
  // plain-English explainer: what the backlog is doing to fees, and why (mechanism, not a prediction)
  { const explF = model.fees ? model.fees.fastestFee : (nextBlk && nextBlk.medianFee) || 0; if (explF && mpHarvestT <= 0) text(mempoolExplainer(explF, depth, mp.count), r.x + r.w / 2, r.y + 36, { size: 10.5, color: "rgba(255,255,255,0.52)", align: "center", baseline: "middle" }); } // hidden while the block-mined banner borrows this row

  // #2 harvest — the next block is mined: it flashes, slides LEFT across "now" into history, txs fly off
  if (!reduceMotion) {
    if ((mpTip !== null && model.tipHeight !== mpTip) || mpPreview) { // block mined → start the glyphs→slide→fill transition
      mpShip = 1; mpHarvestT = 1; mpHarvestTip = (model.tipHeight || 954000) + (mpPreview ? 1 : 0); mpHarvestTx = nextBlk ? nextBlk.nTx : 0;
      mpGhost = { med: (nextBlk && nextBlk.medianFee) || 1, sizeFrac: sizeH(nextBlk), fr: (nextBlk && nextBlk.feeRange) || [1] };
      mpHistSnap = hist.slice(); // freeze the history row so the train slides from a stable state, immune to the async refresh
    }
    mpTip = model.tipHeight;
    if (mpShip > 0) mpShip = Math.max(0, mpShip - (1 / 60) / 3.4); // ~3.4s: churn → harden/set (long hold) → train slides left → refill
    if (mpHarvestT > 0) mpHarvestT = Math.max(0, mpHarvestT - (1 / 60) / 3.8);
  }
  mpPreview = false;
  const slide = 0;
  const tp = mpShip > 0 ? 1 - mpShip : 1; // transition progress 0→1
  // churn (glyphs scramble in) → set (freeze + crystallize to confirmed-green) → long HOLD on the set block → train slide → refill
  const glyphP = clamp01(tp / 0.13);            // glyphs scramble up to full
  const setP = clamp01((tp - 0.13) / 0.16);     // glyphs freeze + block hardens to green; reaches 1 at tp=0.29
  const slideP = clamp01((tp - 0.56) / 0.26);   // after a long hold (0.29→0.56), the set block + history slide left as a train
  const fillP = clamp01((tp - 0.82) / 0.18);    // the next slot refills with fresh mempool
  const sealFlash = mpShip > 0 ? Math.max(0, 1 - Math.abs(tp - 0.29) / 0.08) : 0; // white stamp pulse the instant it sets

  // incoming txs arrive at the BACK of the queue (far right) and rain down to settle onto the dust tail
  const landX = dustBlocks > 0 ? dustStartX : stripX + stripW * 0.6; // left bound of the landing zone
  const landY = dustBlocks > 0 ? dustTopY : bot - maxBH * 0.3;
  if (!reduceMotion) {
    mpFlowAcc += 7 * (1 / 60);
    while (mpFlowAcc >= 1 && mpFlow.length < 70) {
      mpFlowAcc -= 1;
      const rt = model.recentTxs, t = rt && rt.length ? rt[mpFlowIdx++ % rt.length] : null;
      const fee = t ? Math.max(0.1, t.fee / (t.vsize || 200)) : sampleFee(mp.hist), val = t ? (t.value || 0) / 1e8 : 0;
      mpFlow.push({ x: Math.max(landX + 4, stripRight - Math.random() * Math.max(8, stripDustW * 0.7)), y: top + Math.random() * (maxBH * 0.3), vx: -(8 + Math.random() * 14), vy: 0, settled: false, life: 1, land: Math.random() * 6, fee, value: val, whale: val >= 1, sz: val >= 1 ? 7 : 3 + Math.min(3, Math.log10((t && t.vsize || 250) / 110) * 1.6) });
    }
    for (const p of mpFlow) {
      if (!p.settled) {
        p.x += p.vx * (1 / 60); p.vy += 80 * (1 / 60); p.y += p.vy * (1 / 60); // drift left a touch, sink under gravity
        if (p.y >= landY - p.land) { p.y = landY - p.land; p.settled = true; } // land on the dust pile
      } else p.life -= (1 / 60) / 0.7; // absorbed into the backlog — fade out
    }
    mpFlow = mpFlow.filter((p) => p.life > 0 && p.x > landX - 2);
  }

  // --- mined history (left, confirmed). During a block-found transition this becomes a TRAIN:
  //     the snapshot of prior blocks slides one slot left (oldest sliding off the edge) while the
  //     freshly-set block rides in from the "now" line into the vacated newest slot. ---
  const baseX = (i) => r.x + padX + i * (bw + gap);
  const histLines = (blk) => [`✓ Block #${(blk.height || 0).toLocaleString()}`, `${((blk.size || 0) / 1e6).toFixed(2)} MB · ${(blk.tx || 0).toLocaleString()} txs${blk.pool ? " · " + blk.pool : ""}`, "height = its data size — more (or bigger) txs make it taller", "block space is capped (~4M weight); how full varies with demand"];
  const slideEase = 1 - Math.pow(1 - slideP, 3);
  const drawConfirmed = (bx, bh, height, txc, alpha, flash) => {
    if (bx + bw < r.x - 2 || bx > r.x + r.w) return;
    const by = bot - bh;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(90,180,120,0.08)"; roundRect(bx, by, bw, bh, 4); ctx.fill();
    mpTreemap(bx, by, bw, bh, null, 5000 + (height || 0) * 13, true);
    ctx.strokeStyle = flash ? `rgba(90,235,150,${0.5 + 0.5 * mpShip})` : "rgba(90,200,130,0.4)"; ctx.lineWidth = flash ? 2 : 1; roundRect(bx, by, bw, bh, 4); ctx.stroke();
    text(`✓ #${(height || 0).toLocaleString()}`, bx + bw / 2, by - 9, { size: 10, weight: 600, color: "rgba(90,210,140,0.85)", align: "center", baseline: "middle" });
    text(`${txc >= 1000 ? (txc / 1000).toFixed(1) + "k" : (txc || 0)} txs`, bx + bw / 2, bot + 12, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
    ctx.restore();
  };
  if (mpShip > 0 && mpHistSnap) {
    const snap = mpHistSnap, shift = (bw + gap) * slideEase;
    for (let i = 0; i < snap.length; i++) {
      const blk = snap[i], bh = Math.max(20, maxBH * sizeH(blk));
      drawConfirmed(baseX(i) - shift, bh, blk.height, blk.tx, i === 0 ? 1 - slideEase : 1, false); // i===0 = oldest: fades as it leaves
    }
    if (slideP > 0 && mpGhost) { // the set block rides in from the now-line into the newest slot, in lockstep with the train
      const dx = memStartX + (baseX(nHist - 1) - memStartX) * slideEase, dbh = Math.max(20, maxBH * mpGhost.sizeFrac);
      drawConfirmed(dx, dbh, mpHarvestTip, mpHarvestTx, 1, true);
    }
  } else {
    for (let i = 0; i < nHist; i++) { const blk = hist[i], bhc = Math.max(20, maxBH * sizeH(blk)); drawConfirmed(baseX(i), bhc, blk.height, blk.tx, 1, false); mempoolHits.push({ x: baseX(i), y: bot - bhc, w: bw, h: bhc, lines: histLines(blk) }); }
  }
  if (nHist) text("mined · the chain ◂", r.x + padX, top - 22, { size: 10, color: "rgba(90,200,130,0.6)", baseline: "middle" });

  // --- the "now" divider ---
  if (nHist) {
    const divX = r.x + padX + histW + dividerW / 2 - gap / 2 + slide;
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(divX, top - 4); ctx.lineTo(divX, bot + 4); ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.shadowColor = "rgba(6,5,10,0.95)"; ctx.shadowBlur = 4; // soft dark halo (not a box) so "now" reads over the matrix rain without covering the caption
    for (let g = 0; g < 3; g++) text("now", divX, top - 12, { size: 10.5, weight: 700, color: "rgba(255,255,255,0.9)", align: "center", baseline: "middle" });
    ctx.restore();
  }

  // --- the "next" block — your ticket; the hero that hardens + slides into history on a block-found ---
  {
    const blk = nextBlk, med = blk.medianFee || 1, fr = blk.feeRange || [med];
    const bh = Math.max(22, maxBH * sizeH(blk)), bx = memStartX + slide, by = bot - bh;
    ctx.fillStyle = feeColor(med, 0.12); roundRect(bx, by, bw, bh, 4); ctx.fill();
    if (mpShip > 0) { // block-found transition: glyphs churn → freeze + harden to green (held) → slides out as ghost → slot refills
      if (slideP === 0) {
        if (setP < 1) { ctx.save(); ctx.globalAlpha = 1 - setP; mpTreemap(bx, by, bw, bh, fr, 1000, false); ctx.restore(); } // fee-coloured tiles fade out
        if (setP > 0) { ctx.save(); ctx.globalAlpha = setP; ctx.fillStyle = "rgba(90,180,120,0.16)"; roundRect(bx, by, bw, bh, 4); ctx.fill(); mpTreemap(bx, by, bw, bh, fr, 1000, true); ctx.restore(); } // hardened green crystallizes in
        glyphCover(bx, by, bw, bh, glyphP * (1 - 0.45 * setP), setP); // glyphs churn, then freeze + settle as the block sets
      } else if (fillP === 0) { /* the sealed block has slid out (drawn as the ghost); slot momentarily empty */ }
      else mpTreemap(bx, by, bw, bh, fr, 1000, false, fillP);
      const sealing = slideP === 0;
      ctx.strokeStyle = `rgba(90,235,150,${0.55 + 0.45 * Math.max(mpShip, sealFlash)})`; ctx.lineWidth = 2 + 1.6 * sealFlash;
      ctx.setLineDash(fillP > 0 && fillP < 1 ? [4, 4] : []); roundRect(bx, by, bw, bh, 4); ctx.stroke(); ctx.setLineDash([]);
      if (sealing && sealFlash > 0) { ctx.save(); ctx.globalAlpha = sealFlash * 0.85; ctx.strokeStyle = "rgba(225,255,238,0.95)"; ctx.lineWidth = 2.5; roundRect(bx - 1.5, by - 1.5, bw + 3, bh + 3, 5); ctx.stroke(); ctx.restore(); } // the "stamped/set" pulse
    } else {
      mpTreemap(bx, by, bw, bh, fr, 1000, false);
      ctx.strokeStyle = `rgba(${ACCENT},0.9)`; ctx.lineWidth = 1.8; roundRect(bx, by, bw, bh, 4); ctx.stroke();
    }
    text(`~${med < 10 ? med.toFixed(1) : Math.round(med)} sat/vB`, bx + bw / 2, by - 9, { size: 10, weight: 700, color: "rgb(255,206,84)", align: "center", baseline: "middle" });
    text(`${blk.nTx >= 1000 ? (blk.nTx / 1000).toFixed(1) + "k" : blk.nTx} txs · ${((blk.blockSize || 0) / 1e6).toFixed(2)} MB`, bx + bw / 2, bot + 12, { size: 10, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" });
    mempoolHits.push({ x: bx, y: by, w: bw, h: bh, lines: [`Next block · your ticket's target`, `~${med < 10 ? med.toFixed(1) : Math.round(med)} sat/vB · ${(blk.nTx || 0).toLocaleString()} txs · ${((blk.blockSize || 0) / 1e6).toFixed(2)} MB`, "the mempool packs the highest-fee txs into ~one block of space", "height = data size — a fuller block is taller"] });
    text("next · your ticket ▸", bx + bw, by - 22, { size: 10, weight: 700, color: `rgba(${ACCENT},0.9)`, align: "right", baseline: "middle" });
  }

  // --- fee-cliff strip: the backlog as one continuous strip — bar height & colour = fee, width ∝ depth.
  //     The priced blocks step down from the front; the long flat tail is the deep min-fee dust. ---
  {
    // priced blocks: a stepped cliff
    let sx = stripX;
    for (let j = 0; j < backlog.length; j++) { const f = backlog[j].medianFee || 0, h = maxBH * feeH(f), yy = bot - h; ctx.fillStyle = feeColor(f, 0.9); roundRect(sx, yy, Math.max(2, stripSegW - 1.5), h, 2); ctx.fill(); sx += stripSegW; }
    // the dust tail: a long flat low segment fading into the deep backlog
    if (dustBlocks > 0 && stripDustW > 4) {
      const dh = maxBH * feeH(dustFee), dyy = bot - dh;
      const grad = ctx.createLinearGradient(sx, 0, sx + stripDustW, 0); grad.addColorStop(0, feeColor(dustFee, 0.55)); grad.addColorStop(1, feeColor(dustFee, 0.14));
      ctx.fillStyle = grad; roundRect(sx, dyy, stripDustW, dh, 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, bot); ctx.lineTo(sx, bot - maxBH * 0.9); ctx.stroke(); ctx.setLineDash([]); // the "fee cliff" seam
    }
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(stripX, bot + 1); ctx.lineTo(stripRight, bot + 1); ctx.stroke(); // baseline axis
    const fmtFee = (f) => (f || 0) < 10 ? (f || 0).toFixed(1) : Math.round(f).toString();
    const fEnd = (agg && agg.medianFee) || (backlog.length ? backlog[backlog.length - 1].medianFee : nextBlk.medianFee) || 0;
    text(`backlog · ${fmtFee(nextBlk.medianFee)} → ${fmtFee(fEnd)} sat/vB`, stripX, top - 22, { size: 10, color: "rgba(255,255,255,0.55)", baseline: "middle" });
    text(`${mp.count.toLocaleString()} tx · ${depth.toLocaleString()} blocks deep`, stripRight, top - 22, { size: 10, color: "rgba(255,255,255,0.45)", align: "right", baseline: "middle" });
    if (stripPricedW > 24) text(`${backlog.length} priced`, stripX + stripPricedW / 2, bot + 12, { size: 9, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    if (dustBlocks > 0 && stripDustW > 60) text(`~${dustBlocks.toLocaleString()} blocks of min-fee dust · new txs ▸`, sx + stripDustW / 2, bot + 12, { size: 9, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" });
  }
  // incoming tx particles — drawn ON TOP of the strip so they visibly pile onto the dust tail, then fade as absorbed
  for (const p of mpFlow) {
    ctx.save(); ctx.globalAlpha = p.life != null ? Math.max(0, Math.min(1, p.life)) : 1;
    if (p.whale) { ctx.shadowColor = "rgba(255,206,84,0.8)"; ctx.shadowBlur = 8; ctx.fillStyle = feeColor(p.fee, 0.95); ctx.fillRect(p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz); }
    else { ctx.fillStyle = feeColor(p.fee, 0.8); ctx.fillRect(p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz); }
    ctx.restore();
  }
  // (the set block's slide into history is drawn as part of the history train, above)
  if (mpHarvestT > 0) text(`⛏ block #${mpHarvestTip.toLocaleString()} mined — ${mpHarvestTx.toLocaleString()} txs confirmed`, r.x + r.w / 2, r.y + 36, { size: 12, weight: 700, color: `rgba(90,225,140,${Math.min(1, mpHarvestT * 1.6)})`, align: "center", baseline: "middle" }); // sits in the explainer's row (which is hidden meanwhile) — clear of the backlog labels below

  // bottom row: latest-tx ticker (left, gold for a whale) · fee legend (centre) · your payday (right)
  const lt = model.recentTxs && model.recentTxs[0], ltVal = lt ? (lt.value || 0) / 1e8 : 0, whaleLt = ltVal >= 1;
  if (lt && lt.vsize) text(`${whaleLt ? "🐋 " : "↳ "}latest tx: ${ltVal.toFixed(3)} ₿ · ${(lt.fee / lt.vsize).toFixed(1)} sat/vB`, r.x + padX, r.y + r.h - 12, { size: 10, weight: whaleLt ? 700 : 400, color: whaleLt ? "rgb(255,206,84)" : "rgba(255,255,255,0.5)", baseline: "middle" });
  const subsidy = 50 / Math.pow(2, Math.floor((model.tipHeight || 0) / 210000)), fees = (nextBlk.totalFees || 0) / 1e8, reward = subsidy + fees;
  const usd = model.price ? reward * model.price : 0, usdStr = usd >= 1000 ? "$" + Math.round(usd / 1000) + "k" : "$" + Math.round(usd);
  text(`🏆 if you win: ${subsidy.toFixed(3)} + ${fees.toFixed(3)} ₿ fees = ${reward.toFixed(3)} ₿${usd ? " ≈ " + usdStr : ""}`, r.x + r.w - padX, r.y + r.h - 12, { size: 11, weight: 700, color: "rgb(255,206,84)", align: "right", baseline: "middle" });
  const lgW = 120, lgX = r.x + r.w / 2 - lgW / 2, lgY = r.y + r.h - 12;
  for (let i = 0; i < lgW; i++) { ctx.fillStyle = feeColor(Math.pow(10, (i / lgW) * 2.4 - 0.3), 0.9); ctx.fillRect(lgX + i, lgY - 3, 1, 5); }
  text("low", lgX - 5, lgY, { size: 10, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" });
  text("high fee", lgX + lgW + 5, lgY, { size: 10, color: "rgba(255,255,255,0.4)", baseline: "middle" });
}

// THE AVALANCHE — flip one bit of the nonce, and ~half the 256 output bits change, with no predictable pattern.
// The cascade reveals left→right; a counter tallies the flipped bits. Real double-SHA-256, once per block.
function drawAvalanche(r) {
  const x0 = r.x + 16, x1 = r.x + r.w - 16, now = Date.now(), BLUE = "120,200,255", GLD = "255,205,110";
  text("THE AVALANCHE — flip one input bit, and half the hash changes, unpredictably", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("The output has no relationship to the input — so there's no aiming: change the nonce, and the hash leaps somewhere completely new and unforeseeable. Guess-and-check is the only way in.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const av = model.avalanche;
  if (!av || !av.flips || !av.flips.length) { text("computing…", x0, r.y + 66, { size: 12, color: "rgba(255,255,255,0.4)", baseline: "middle" }); return; }
  const PERIOD = 2800, ph = reduceMotion ? 1 : (now % PERIOD) / PERIOD, idx = reduceMotion ? 9 : Math.floor(now / PERIOD) % av.flips.length;
  const flip = av.flips[idx], flipped = reduceMotion || ph > 0.2, reveal = reduceMotion ? 1 : Math.max(0, Math.min(1, (ph - 0.24) / 0.4));
  const bit = (bytes, p) => (bytes[p >> 3] >> (7 - (p & 7))) & 1;

  // nonce (32 bits, all 0) — the one flipping bit lit gold
  const nbY = r.y + 58, nbx0 = x0 + 210, nbw = Math.min(14, (x1 - nbx0 - 130) / 32);
  text("nonce — the number a miner changes", x0, nbY + 5, { size: 9.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  for (let i = 0; i < 32; i++) { const isFlip = (31 - i) === flip.bit;
    ctx.fillStyle = isFlip ? (flipped ? `rgba(${GLD},1)` : `rgba(${GLD},${0.45 + 0.45 * (0.5 + 0.5 * Math.sin(now / 110))})`) : "rgba(255,255,255,0.08)";
    ctx.fillRect(nbx0 + i * nbw, nbY, Math.max(1.5, nbw - 1.5), 12);
    if (isFlip) { ctx.strokeStyle = `rgba(${GLD},0.9)`; ctx.lineWidth = 1.2; ctx.strokeRect(nbx0 + i * nbw - 1.5, nbY - 2, Math.max(1.5, nbw - 1.5) + 3, 16); }
  }
  text(flipped ? "one bit flipped ✓" : "flip 1 bit…", nbx0 + 32 * nbw + 12, nbY + 5, { size: 9.5, weight: 700, color: `rgba(${GLD},0.95)`, baseline: "middle" });

  // the two hashes, 256 bits each — before, then after (changed bits lit gold, cascading in L→R)
  const hbx = x0 + 44, hbw = (x1 - hbx) / 256, baseY = r.y + 90, flipY = r.y + 114;
  text("before", x0, baseY + 5, { size: 8.5, color: "rgba(255,255,255,0.45)", baseline: "middle" });
  text("after", x0, flipY + 5, { size: 8.5, weight: 700, color: `rgba(${GLD},0.75)`, baseline: "middle" });
  let shownDiff = 0;
  for (let p = 0; p < 256; p++) {
    const b0 = bit(av.base, p), b1 = bit(flip.bytes, p), changed = b0 !== b1, revealed = p / 256 <= reveal;
    ctx.fillStyle = b0 ? `rgba(${BLUE},0.65)` : "rgba(255,255,255,0.06)"; ctx.fillRect(hbx + p * hbw, baseY, Math.max(0.8, hbw - 0.35), 11);
    const showCh = changed && revealed; if (showCh) shownDiff++;
    const shownBit = revealed ? b1 : b0;
    ctx.fillStyle = showCh ? `rgba(${GLD},1)` : (shownBit ? `rgba(${BLUE},0.5)` : "rgba(255,255,255,0.05)"); ctx.fillRect(hbx + p * hbw, flipY, Math.max(0.8, hbw - 0.35), 11);
  }
  const total = reveal >= 1 ? flip.diff : shownDiff;
  text(`${total} of 256 bits changed — about half, and no way to predict which`, x0, r.y + 138, { size: 11.5, weight: 700, color: `rgba(${GLD},0.95)`, baseline: "middle" });
  text("Run the same math with one bit different → a totally unrelated result. That's why mining is a lottery, not a puzzle you can outsmart — you can only draw ticket after ticket.", x0, r.y + r.h - 12, { size: 10, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

// VERIFY THIS BLOCK — the three checks a node runs to validate a real block's hash, recomputed live in-browser.
function drawVerify(r) {
  const x0 = r.x + 16, GRN = "90,225,140", RED = "255,95,95";
  text("VERIFY THIS BLOCK — recompute the proof-of-work yourself; no trust required", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("A node takes the 80-byte header, hashes it twice, and checks three things. Finding this hash took ~10²² tries; verifying it takes one — on any laptop or phone.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const v = model.verify;
  if (!v) { text("waiting for the latest block…", x0, r.y + 66, { size: 12, color: "rgba(255,255,255,0.4)", baseline: "middle" }); return; }
  text(`block #${(v.height || 0).toLocaleString()} · ${(v.txCount || 0).toLocaleString()} transactions · header = version ‖ prev hash ‖ merkle root ‖ time ‖ bits ‖ nonce  (80 bytes)`, x0, r.y + 55, { size: 10.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });

  const short = (h) => h ? h.slice(0, 18) + "…" + h.slice(-6) : "—";
  const st = (b) => b == null ? "pending" : (b ? "ok" : "fail");
  const check = (yy, num, title, detail, state) => {
    const c = state === "ok" ? GRN : state === "fail" ? RED : "255,255,255", pend = state === "pending", badge = state === "ok" ? "✓" : state === "fail" ? "✗" : "…";
    ctx.fillStyle = `rgba(${c},${pend ? 0.1 : 0.16})`; roundRect(x0, yy - 9, 19, 19, 5); ctx.fill();
    ctx.strokeStyle = `rgba(${c},${pend ? 0.4 : 0.9})`; ctx.lineWidth = 1.2; roundRect(x0, yy - 9, 19, 19, 5); ctx.stroke();
    text(badge, x0 + 9.5, yy + 0.5, { size: 12, weight: 700, color: `rgba(${c},${pend ? 0.6 : 1})`, align: "center", baseline: "middle" });
    text(`${num} · ${title}`, x0 + 30, yy - 6, { size: 11.5, weight: 700, color: `rgba(${c},${pend ? 0.6 : 0.95})`, baseline: "middle" });
    text(detail, x0 + 30, yy + 9, { size: 10, color: "rgba(255,255,255,0.6)", baseline: "middle", mono: true });
  };
  check(r.y + 84, "1", "RECOMPUTE THE HASH · double-SHA-256 of the 80-byte header",
    v.hashMatch == null ? "hashing…" : `${short(v.recomputed)}  ${v.hashMatch ? "=" : "≠"}  the block's own hash`, st(v.hashMatch));
  check(r.y + 124, "2", "BELOW THE TARGET · this is the proof of work",
    v.belowTarget == null ? "…" : `hash ${short(v.id)}  ${v.belowTarget ? "≤" : ">"}  target ${short(v.targetHex)}  ·  ${v.leadingZeros} leading zeros`, st(v.belowTarget));
  check(r.y + 164, "3", "COMMITS TO THE TRANSACTIONS · rebuild the merkle root",
    v.merkleMatch == null ? `rebuilding the root from ${(v.txCount || 0).toLocaleString()} txids…` : `${short(v.computedMerkle)}  ${v.merkleMatch ? "=" : "≠"}  the header's merkle root`, st(v.merkleMatch));

  const allOk = v.hashMatch && v.belowTarget && v.merkleMatch, anyFail = v.hashMatch === false || v.belowTarget === false || v.merkleMatch === false;
  text(allOk ? "✓ VALID — legit, and you just proved it without trusting the miner, the pool, or anyone else." : (anyFail ? "✗ a check failed — this block would be rejected" : "verifying…"),
    x0, r.y + 206, { size: 12, weight: 700, color: allOk ? `rgba(${GRN},0.97)` : anyFail ? `rgba(${RED},0.95)` : "rgba(255,255,255,0.45)", baseline: "middle" });
  text("Change one transaction → the merkle root changes → the header changes → the hash changes → it no longer beats the target. Tamper-evident, checkable by anyone in microseconds.", x0, r.y + r.h - 14, { size: 10, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

function drawCloseness(r) {
  // LIVE: compare your daemon's real last attempt to a winning block — the leading-zero "wall" tells the story
  const mn = model.node && model.node.miner, at = mn && mn.attempt;
  if (at && at.hash) {
    const winner = (model.block && model.block.id) || "";
    const need = leadingZeroHexChars(at.target || winner || ""), youZ = leadingZeroHexChars(at.hash);
    const tgtBits = at.target ? 256 - bigHex(at.target).toString(2).length : 76; // the win threshold in zero BITS = coin-flips to win
    text("YOUR LIVE ATTEMPT vs THE TARGET & WINNING BLOCK", r.x + 16, r.y + 16, { size: 12, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
    const rowX = r.x + 16, hx0 = rowX + 58, n = 64;
    // Pre-compute the right-side labels + best metadata so we can (a) reserve exactly the widest label's width and
    // (b) size/truncate the hex to never collide with the label or overlap itself on a narrow window / low-res
    // screen. (Before this, a fixed 340px reserve + full 64-hex overran both, garbling the row at small widths.)
    const lastWin = (model.recentBlocks || [])[(model.recentBlocks || []).length - 1], winPool = lastWin && lastWin.pool ? ` · won by ${lastWin.pool}` : "";
    const best = mn.best;
    const bz = best && best.hash ? leadingZeroHexChars(best.hash) : 0, zb = best && typeof best.zero_bits === "number" ? best.zero_bits : bz * 4, rem = zb % 4;
    const subTarget = at.target ? `the bar to beat · ${leadingZeroHexChars(at.target)} zeros · ${tgtBits} heads in a row` : "";
    const subWinner = winner ? `#${(model.tipHeight || 0).toLocaleString()} · ${leadingZeroHexChars(winner)} zeros${winPool}` : "";
    const subYou = `#${(at.height || 0).toLocaleString()} · ${youZ} zero${youZ === 1 ? "" : "s"}`;
    const subBest = best && best.hash ? `#${(best.height || 0).toLocaleString()} · ${bz} zero${bz === 1 ? "" : "s"} · ${zb} bits · ${oddsExact(rarityBits(best.hash))}${rem ? ` (+${rem}/4)` : ""}` : "";
    ctx.font = "600 11px -apple-system, system-ui, sans-serif"; // match the label font for measureText
    let maxSubW = 0; for (const s of [subTarget, subWinner, subYou, subBest]) if (s) maxSubW = Math.max(maxSubW, ctx.measureText(s).width);
    const GAP = 20, MIN_SP = 9; // GAP between hex and its label; MIN_SP keeps mono hex chars from overlapping
    const hexZoneW = Math.max(MIN_SP, (r.x + r.w - 16 - maxSubW - GAP) - hx0); // hx0 → the label's left edge
    const shown = Math.max(1, Math.min(n, Math.floor(hexZoneW / MIN_SP))); // how many hex chars fit legibly
    const sp = hexZoneW / shown, truncated = shown < n;
    const row = (label, hex, y, lit, sub) => {
      text(label, rowX, y, { size: 11, weight: 600, color: "rgba(255,255,255,0.5)", baseline: "middle" });
      const lead = leadingZeroHexChars(hex), cnt = truncated ? shown - 1 : shown;
      for (let i = 0; i < cnt; i++) { const z = i < lead; text(hex[i], hx0 + sp * (i + 0.5), y, { size: 13, weight: z ? 700 : 400, color: z ? lit : "rgba(255,255,255,0.4)", align: "center", baseline: "middle", mono: true }); }
      if (truncated) text("…", hx0 + sp * (shown - 0.5), y, { size: 13, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle", mono: true });
      text(sub, r.x + r.w - 16, y, { size: 11, weight: 600, color: lit, align: "right", baseline: "middle" });
    };
    if (at.target) row("target", at.target, r.y + 42, `rgba(${ACCENT},0.95)`, subTarget);
    if (winner) row("winner", winner, r.y + 70, "rgb(90,225,140)", subWinner);
    row("you", at.hash, r.y + 98, at.won ? "rgb(90,225,140)" : "rgba(255,190,110,0.97)", subYou);
    if (best && best.hash) {
      row("best", best.hash, r.y + 112, "rgba(255,215,90,1)", subBest);
      // NIBBLE GAUGE — bit-level progress into the NEXT leading "0", the resolution hex chars throw away.
      // zb = 4·(full zero chars) + (zero bits of the frontier nibble); rem (= zb % 4) of 4 dots = bits toward
      // the next whole "0". Drawn under the first non-zero char so it lines up with where the next 0 will appear.
      if (bz < (truncated ? shown - 1 : n)) {
        const fx = hx0 + sp * (bz + 0.5), fy = r.y + 122, dr = 1.5, dsp = 3.3;
        for (let i = 0; i < 4; i++) {
          const dx = fx + (i - 1.5) * dsp;
          ctx.beginPath(); ctx.arc(dx, fy, dr, 0, 7);
          if (i < rem) { ctx.fillStyle = "rgba(255,215,90,0.95)"; ctx.fill(); }
          else { ctx.strokeStyle = "rgba(255,215,90,0.4)"; ctx.lineWidth = 1; ctx.stroke(); }
        }
      }
    }
    // ---- ODDS MAP HEAT MAP — every attempt plotted by leading-zero-bits (reversed: WIN = BELOW target = LEFT) ----
    const tBits = tgtBits;
    const youBits = at.leading_zero_bits != null ? at.leading_zero_bits : (256 - bigHex(at.hash).toString(2).length);
    const bestBits = best && best.zero_bits != null ? best.zero_bits : youBits;
    const bestZeros = best && best.hash ? leadingZeroHexChars(best.hash) : youZ;
    const tkX = rowX, tkW = r.w - 32, tkY = r.y + 164, bandH = 24, WIN_FRAC = 0.09, BMAX = 256;
    // plot by leading-zero BITS — the true rarity axis (each extra zero bit = 2× rarer). Two linear scales
    // meet at the target line: the right ~91% is the lose zone (0…target bits, where every attempt lands);
    // the left ~9% is the win zone (target…all-256-zeros) — kept deliberately THIN so it never looks like
    // there's much room to win. Compressed so a real winner (which only just clears the bar) hugs the line.
    const px = (b) => b <= tBits
      ? tkX + tkW * (WIN_FRAC + (1 - WIN_FRAC) * (1 - b / Math.max(1, tBits)))
      : tkX + tkW * WIN_FRAC * (1 - Math.min(1, (b - tBits) / (BMAX - tBits)));
    const winX = px(tBits);
    text("ODDS MAP — placed by zero-bit count; WIN only LEFT of the target (an all-zeros hash = far-left edge)", tkX, r.y + 138, { size: 10, color: "rgba(255,255,255,0.5)", baseline: "middle" });
    const wzg = ctx.createLinearGradient(tkX, 0, winX, 0); // win zone — fade to nothing leftward so it reads as a thin sliver at the line, not winnable space
    wzg.addColorStop(0, "rgba(90,210,140,0.015)"); wzg.addColorStop(1, "rgba(90,210,140,0.2)");
    ctx.fillStyle = wzg; ctx.fillRect(tkX, tkY, winX - tkX, bandH);
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tkX, tkY + bandH); ctx.lineTo(tkX + tkW, tkY + bandH); ctx.stroke(); // baseline
    // heat dots from the leading-zero-bits histogram (amber where common → green as it nears the target)
    const zhist = mn.zhist || {}, loseSlot = tkW * (1 - WIN_FRAC) / Math.max(1, tBits); // px between adjacent zero-bit columns; jitter by ~this so the heat blends into a cloud instead of hard bands
    let total = 0; for (const k in zhist) total += zhist[k];
    const scale = total > 250 ? 250 / total : 1;
    const rnd = (s) => { const x = Math.sin(s * 127.1) * 43758.5453; return x - Math.floor(x); };
    for (const k in zhist) {
      const b = +k, n = Math.max(1, Math.round(zhist[k] * scale)), t = Math.min(1, b / tBits);
      const col = `rgba(${Math.round(255 - 165 * t)},${Math.round(190 + 35 * t)},${Math.round(110 + 30 * t)},0.2)`;
      ctx.fillStyle = col;
      for (let i = 0; i < n; i++) {
        const x = Math.min(tkX + tkW - 2, Math.max(tkX + 2, px(b) + (rnd(b * 97 + i * 1.7) - 0.5) * loseSlot * 1.3));
        const y = tkY + 3 + rnd(b * 131 + i * 3.3) * (bandH - 6);
        ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 7); ctx.fill();
      }
    }
    // #15: past WINNERS — recent winning blocks by their leading-zero bits; they land LEFT of the target
    // (most barely beat it; a lucky few reach much further left)
    const winners = (model.recentBlocks || []).filter((w) => w.id).map((w) => 256 - bigHex(w.id).toString(2).length);
    ctx.fillStyle = "rgba(90,225,140,0.6)";
    winners.forEach((wb, i) => { const x = Math.max(tkX + 2, Math.min(winX - 1, px(wb) + (rnd(wb * 53 + i * 2.3) - 0.5) * 3)), y = tkY + 4 + rnd(wb * 61 + i * 5.1) * (bandH - 8); ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill(); }); // small x-jitter only (de-overlap the pile) so a real beat-by-a-lot still reads as further left
    ctx.strokeStyle = "rgb(90,225,140)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(winX, tkY - 3); ctx.lineTo(winX, tkY + bandH + 3); ctx.stroke(); // target = WIN line
    // #2: highlight the LAST winner (the most recent block) among the winners cloud
    const lw = (model.recentBlocks || [])[(model.recentBlocks || []).length - 1];
    if (lw && lw.id) {
      const lwx = px(256 - bigHex(lw.id).toString(2).length);
      ctx.fillStyle = "rgb(90,235,150)"; ctx.beginPath(); ctx.arc(lwx, tkY + bandH / 2, 4.4, 0, 7); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(lwx, tkY + bandH / 2, 4.4, 0, 7); ctx.stroke();
      text("last win", lwx, tkY - 10, { size: 10, weight: 700, color: "rgb(90,235,150)", align: "center", baseline: "middle" });
    }
    // luckiest recent winner — the block that beat the target by the most extra zero-bits. Only flag it when it
    // sits VISIBLY left of the target line (most barely beat it and pile at the line), otherwise no clutter.
    if (winners.length) {
      const maxWb = Math.max(...winners), luckyX = px(maxWb), beat = Math.round(maxWb - tBits);
      if (beat >= 1 && winX - luckyX >= 6) {
        ctx.save(); ctx.translate(luckyX, tkY + bandH / 2); ctx.beginPath();
        for (let s = 0; s < 10; s++) { const rr = s % 2 ? 2.3 : 5.4, a = -Math.PI / 2 + s * Math.PI / 5; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.closePath(); ctx.fillStyle = "rgba(255,215,90,1)"; ctx.fill(); ctx.strokeStyle = "rgba(10,8,4,0.85)"; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
        text(`★ beat target by +${beat} bits`, luckyX, tkY + bandH + 26, { size: 10, weight: 700, color: "rgba(255,215,90,0.95)", align: "center", baseline: "middle" });
      }
    }
    // best = a DIAMOND (◆, matching the legend) so it's told apart from the round winner/you dots by SHAPE, not just colour
    const bX = px(bestBits), bY = tkY + bandH / 2, bd = 4.4;
    ctx.fillStyle = "rgba(255,215,90,1)"; ctx.strokeStyle = "rgba(10,8,4,0.7)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bX, bY - bd); ctx.lineTo(bX + bd, bY); ctx.lineTo(bX, bY + bd); ctx.lineTo(bX - bd, bY); ctx.closePath(); ctx.fill(); ctx.stroke();
    const bestL2 = best && best.hash ? rarityBits(best.hash) : bestBits, winL2 = at.target ? rarityBits(at.target) : tBits;
    bestHit = { x: bX - 9, y: bY - 11, w: 18, h: 22, lines: [
      "◆ best — your closest hash yet",
      `${bestZeros} leading zero${bestZeros === 1 ? "" : "s"} · ${bestBits} zero bits`,
      `odds of a hash this good: ${oddsExact(bestL2)}`,
      `like ${coinFlips(bestBits)} — 4 per leading zero`,
      `${bestBits} heads in a row turns up ${expectedEvery(bestBits)} here (1 ticket / 10 min)`,
      best && best.height ? `on block #${(best.height || 0).toLocaleString()}` : "this session's record",
      `a win = ${tBits} heads in a row (${leadingZeroHexChars(at.target || "")} zeros) — ${expectedEvery(winL2)} of nonstop mining`,
    ] };
    // #14: YOUR current hash — drawn ON TOP, ringed + ticked + labelled so it's never lost in the cloud
    const yx = px(youBits), yy = tkY + bandH / 2;
    ctx.strokeStyle = "rgba(10,8,4,0.75)"; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(yx, tkY - 7); ctx.lineTo(yx, tkY + bandH + 7); ctx.stroke();
    ctx.strokeStyle = "rgba(255,140,80,0.95)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(yx, tkY - 7); ctx.lineTo(yx, tkY + bandH + 7); ctx.stroke();
    ctx.fillStyle = "rgba(255,140,80,1)"; ctx.beginPath(); ctx.arc(yx, yy, 4.6, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(yx, yy, 4.6, 0, 7); ctx.stroke();
    text("you", yx, tkY - 10, { size: 10, weight: 700, color: "rgb(255,165,95)", align: "center", baseline: "middle" });
    youHit = { x: yx - 10, y: tkY - 12, w: 20, h: bandH + 26, lines: [
      "you — your current live hash",
      `${youBits} leading zero bit${youBits === 1 ? "" : "s"} (absolute)`,
      `odds of a hash this good: ${oddsExact(rarityBits(at.hash))}`,
      `a win = ${tBits} heads in a row (${leadingZeroHexChars(at.target || "")} zeros) · ${oddsExact(winL2)}`,
      `that's ${expectedEvery(winL2)} of nonstop mining`,
    ] };
    text(`◄ BELOW target = WIN · ${tBits} heads in a row · 1 in ~10^${Math.round(tBits * 0.30103)}`, tkX, tkY + bandH + 14, { size: 10, weight: 600, color: "rgba(90,220,140,0.9)", baseline: "middle" });
    text("most hashes land here — above the target ►", tkX + tkW, tkY + bandH + 14, { size: 10, color: "rgba(255,190,110,0.85)", align: "right", baseline: "middle" });
    if (best && best.hash) // the felt version of the best hash: lead with zeros (quickest to grasp), then coin-flips (the doubling), then time at this machine's cadence
      text(`◆ your best hash: ${bestZeros} leading zero${bestZeros === 1 ? "" : "s"} · ${bestBits} bits — that's ${bestBits} coin-flips all landing heads — turns up ${expectedEvery(bestBits)} at 1 ticket every 10 min`,
        tkX + tkW / 2, r.y + r.h - 46, { size: 11, weight: 700, color: "rgba(255,215,90,0.92)", align: "center", baseline: "middle" });
    text("your inputs are fixed — SHA-256 makes the result an unpredictable draw in 2²⁵⁶; there's no way to aim", tkX + tkW / 2, r.y + r.h - 26, { size: 10, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" });
    const att = mn.live_attempts || 0, won = mn.live_wins || 0;
    text(`● LIVE · ${att.toLocaleString()} attempts · ${won} found & submitted · ◆ best ${bestZeros} zero${bestZeros === 1 ? "" : "s"} · ${bestBits} bits · ● last ${youBits} bit${youBits === 1 ? "" : "s"}`, rowX, r.y + r.h - 11, { size: 11, weight: 700, color: "rgba(90,220,140,0.92)", baseline: "middle" });
    return;
  }
  // a node is configured (the desktop app) but there's no live attempt yet — syncing/connecting, not a demo
  if (model.node) {
    const syncing = model.node.reachable !== false && (model.node.initialblockdownload || (model.node.headers || 0) > (model.node.blocks || 0));
    text(syncing ? "your node is syncing — your real closeness shows here once it's caught up and mining"
                 : "connecting to your node — your real closeness shows here once you're mining",
      r.x + r.w / 2, r.y + r.h / 2, { size: 14, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
    return;
  }
  // no node at all (the public web demo) — show the educational draw
  const p = model.ticket?.prox;
  if (!p) { text("waiting for a draw…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  const bw = Math.min(440, r.w * 0.8), bx = r.x + r.w / 2 - bw / 2, by = r.y + 12;
  ctx.fillStyle = "rgba(255,255,255,0.12)"; roundRect(bx, by, bw, 8, 4); ctx.fill();
  const fill = Math.max(0.04, Math.min(1, Math.log10(Math.max(p.percent, 1e-12)) / 2 + 1));
  ctx.fillStyle = `rgba(${ACCENT}, 1)`; roundRect(bx, by, bw * fill, 8, 4); ctx.fill();
  text(p.won ? "TARGET HIT" : `Closeness ${p.label}  ·  ${p.leadingZeroBits} zero bits`, r.x + r.w / 2, by + 26, { size: 16, color: "rgba(255,255,255,0.7)", align: "center", baseline: "middle" });
  // the block hash itself, leading zeros lit
  const hex = model.ticket.hashHex.slice(0, 32), lead = leadingZeroHexChars(model.ticket.hashHex);
  const rowY = r.y + 78, sp = (r.w - 40) / hex.length;
  for (let i = 0; i < hex.length; i++) {
    const isLead = i < lead;
    text(hex[i], r.x + 20 + sp * (i + 0.5), rowY, { size: 16, weight: isLead ? 700 : 400, color: isLead ? `rgb(${ACCENT})` : "rgba(255,255,255,0.5)", align: "center", baseline: "middle", mono: true });
  }
  text(`${lead} leading zero hex · ${p.leadingZeroBits} zero bits`, r.x + r.w / 2, rowY + 24, { size: 14, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
  text("one hash shown per block — your miner searches trillions and submits the instant one wins", r.x + r.w / 2, r.y + r.h - 6, { size: 10, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" });
}

// ---- HASH BUILD ceremony: phased, accurate-but-stylized ----
// Real header fields (to-scale byte widths) assemble one by one, churn through
// the double SHA-256 as matrix-hex, then resolve into your real block hash.
const HEADER_FIELDS = [
  { label: "version", bytes: 4, explain: "which consensus rules this block follows", val: (b) => (b.version >>> 0).toString(16).padStart(8, "0") },
  { label: "prev block", bytes: 32, explain: "the link back to the previous block — this is the chain", val: (b) => b.previousblockhash },
  { label: "merkle root", bytes: 32, explain: "one fingerprint — a single hash — of every transaction in the block", val: (b) => b.merkle_root },
  { label: "time", bytes: 4, explain: "when the block was assembled (UTC)", val: (b) => new Date(b.timestamp * 1000).toISOString().slice(11, 19) },
  { label: "bits", bytes: 4, explain: "the difficulty target — how hard it is to win", val: (b) => "0x" + b.bits.toString(16) },
  { label: "NONCE", bytes: 4, explain: "your lottery number for this block", val: (b, t) => "#" + t.nonce.toLocaleString(), you: true },
];
const PHASES = [["assemble", 86.4], ["pack", 1.0], ["churn", 2.0], ["reveal", 7.0], ["hold", 30.0]];
const CYCLE_LEN = PHASES.reduce((s, p) => s + p[1], 0);
const CYBER = "0123456789abcdefABCDEF#%&*<>/\\=+".split("");
const ceremony = { height: null, t: 0, cycle: -1, order: [] };
function phaseAt(t) { let acc = 0; for (const [name, dur] of PHASES) { if (t < acc + dur) return { name, p: (t - acc) / dur }; acc += dur; } return { name: "hold", p: 1 }; }
function shuffled(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function churnChar(i) { return CYBER[(frame + i * 7) % CYBER.length]; }
const hrand = (s) => { const x = Math.sin(s * 91.7) * 47453.13; return x - Math.floor(x); }; // deterministic 0..1
// random-order reveal: each char i has its own (deterministic) threshold; it resolves once progress passes
// it — so a string decodes in scattered order instead of strictly left-to-right. Capped <1 so all finish.
const revealThresh = (seed, i) => 0.82 * hrand(seed * 53.7 + i * 7.13 + 0.5);
function bitAt(hex, i) { return (parseInt(hex[i >> 2] || "0", 16) >> (3 - (i & 3))) & 1; } // bit i of a hex string (256-bit)
function zeroBits(hex) { return hex ? 256 - bigHex(hex).toString(2).length : 0; }

function drawHashBuild(r) {
  if (!model.block || !model.ticket) { text("waiting for chain data…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  // when the daemon is live, build the EXACT block it's mining (real, verified); else the in-browser demo
  const live = model.liveBuild;
  // a node is configured (desktop) but no live block yet — syncing/connecting, not a demo with a fake prev block
  if (model.node && !live) {
    const syncing = model.node.reachable !== false && (model.node.initialblockdownload || (model.node.headers || 0) > (model.node.blocks || 0));
    text(syncing ? "your node is syncing — the real block you're mining is built here once it's caught up"
                 : "connecting to your node — the block you're mining is built here once you're live",
      r.x + r.w / 2, r.y + r.h / 2, { size: 14, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
    return;
  }
  const b = live ? { version: live.version, previousblockhash: live.prevHash, merkle_root: live.merkleRoot, timestamp: live.timestamp, bits: live.bits } : model.block;
  const tk = live ? { nonce: live.nonce, hash1Hex: live.hash1Display, hashHex: live.hash2Display, prox: { leadingZeroBits: live.leadingZeroBits, won: live.below } } : model.ticket;
  const buildHeight = live ? live.height : model.tipHeight;
  if (ceremony.height !== buildHeight) { ceremony.height = buildHeight; ceremony.t = 0; }
  if (reduceMotion) ceremony.t = CYCLE_LEN - 10; // reduced-motion: hold on the settled result, skip the build/merkle/scan animation
  else ceremony.t += 1 / 60;
  const t = ceremony.t % CYCLE_LEN, cyc = Math.floor(ceremony.t / CYCLE_LEN);
  if (cyc !== ceremony.cycle) { ceremony.cycle = cyc; ceremony.order = shuffled(40); }
  const ph = phaseAt(t);
  const assembling = ph.name === "assemble";
  // weighted assemble slots — the merkle field (idx 2) gets 2× the time so its tree build + root can dwell
  const W = [1, 1, 2, 1, 1, 1], TW = 7;
  const pp = assembling ? ph.p * TW : TW;
  let lockedCount = 0, wAcc = 0;
  while (lockedCount < 6 && pp >= wAcc + W[lockedCount]) { wAcc += W[lockedCount]; lockedCount++; }
  window.__hb = { phase: ph.name, field: assembling ? Math.min(5, lockedCount) : -1 };
  const rawFrac = lockedCount < 6 ? (pp - wAcc) / W[lockedCount] : 1;
  const fillFrac = Math.min(1, rawFrac / 0.45); // fill over the first ~45% of each field's slot, then hold

  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  text(`${live ? "Hashing your block" : "Building your ticket"} — block #${buildHeight.toLocaleString()}`, r.x + r.w / 2, r.y + 20, { size: 14, weight: 700, color: "rgba(255,255,255,0.7)", align: "center", baseline: "middle" });

  // two-row header: column title (row 1) + the data result directly under it (row 2). Widths track byte
  // size, but the small 4-byte fields get a floor so their values (esp. the long decimal nonce) aren't
  // truncated — shaved from prev/merkle, which stay clearly dominant.
  const barX = r.x + 18, barW = r.w - 36, barY = r.y + 32, barH = 22;
  const segWts = HEADER_FIELDS.map((f) => Math.max(f.bytes, 11)), wTotal = segWts.reduce((a, c) => a + c, 0);
  const valY = barY + barH + 17; // row 2 — the value sits under its column
  let bx = barX;
  HEADER_FIELDS.forEach((f, i) => {
    const segW = barW * segWts[i] / wTotal;
    const locked = i < lockedCount, filling = assembling && i === lockedCount;
    let fill = "rgba(255,255,255,0.05)";
    if (f.you && (locked || filling)) fill = `rgba(${ACCENT},0.30)`;
    else if (locked) fill = `rgba(${ACCENT},0.14)`;
    else if (filling) fill = `rgba(${ACCENT},${0.14 * fillFrac})`;
    ctx.fillStyle = fill; roundRect(bx + 1, barY, segW - 2, barH, 3); ctx.fill();
    if (locked || filling) { ctx.strokeStyle = `rgba(${ACCENT},${filling ? 0.9 : 0.4})`; ctx.lineWidth = filling ? 1.4 : 1; roundRect(bx + 1, barY, segW - 2, barH, 3); ctx.stroke(); }
    if (segW > 50) text(f.label, bx + segW / 2, barY + barH / 2, { size: 11, weight: 600, color: locked || filling ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.32)", align: "center", baseline: "middle" });
    // row 2 — the data result, under the column, truncated to fit, scrambling→locking while it fills
    if (locked || filling) {
      const full = f.val(b, tk);
      ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const cw = ctx.measureText("0").width, maxC = Math.max(4, Math.floor((segW - 8) / cw));
      const vv = full.length > maxC ? full.slice(0, maxC - 1) + "…" : full;
      let s = vv;
      if (filling) { s = ""; for (let c = 0; c < vv.length; c++) s += fillFrac > revealThresh(i + 1, c) ? vv[c] : churnChar(c); } // decode in random order as the field fills
      ctx.fillStyle = f.you ? `rgba(${ACCENT},0.95)` : "rgba(255,255,255,0.8)"; ctx.fillText(s, bx + segW / 2, valY);
    }
    bx += segW;
  });
  text("the 6 header fields, in order", barX, valY + 18, { size: 10, weight: 600, color: "rgba(255,255,255,0.38)" });

  // ---- ZONE 2: the REAL 80-byte header — the exact contiguous bytes that get hashed, built in the SAME
  // order as the fields above, as each one locks
  const concatY = valY + 54;
  text("packed into the 80-byte header — the exact bytes that get hashed (little-endian):", r.x + r.w / 2, concatY - 18, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
  drawPreimageRow(r, b, tk, lockedCount, fillFrac, assembling, concatY);

  // caption (phase-aware) — narrates the current step
  let caption = "";
  if (assembling) { const f = HEADER_FIELDS[Math.min(5, lockedCount)]; caption = `${f.label} — ${f.explain}`; }
  else if (ph.name === "pack") caption = "the whole string goes into SHA-256";
  else if (ph.name === "churn") caption = "SHA-256, applied twice — every bit scrambled";
  else if (ph.name === "reveal") caption = "the hash forms, left to right…";
  else caption = live ? "the exact block your node is mining — its real hash is below ↓" : "this is our hash for this block · try again next block";
  text(caption, r.x + r.w / 2, concatY + 22, { size: 13, weight: 500, color: `rgba(${ACCENT},0.88)`, align: "center", baseline: "middle" });

  // ---- ZONE 3: per-field detail while assembling; the hashing → our submission once the header is done
  const detailTop = concatY + 40;
  const dr = { x: r.x + 24, y: detailTop, w: r.w - 48, h: (r.y + r.h - 10) - detailTop };
  if (assembling) drawFieldDetail(Math.min(5, lockedCount), fillFrac, dr, b, tk, buildHeight);
  else drawHashMachine(r, ph, detailTop - 4, b, tk, live, buildHeight);
}

// the real 80-byte header, exactly as it's hashed (from serializeHeader): 160 contiguous hex chars,
// colour-tinted per field so the six fields are still legible inside the one string, resolving
// left-to-right in sync with the fields locking above. Little-endian — so prev block / merkle root read
// byte-reversed vs the human values in zone 1; that's how Bitcoin serializes them.
const FIELD_HEX = [8, 64, 64, 8, 8, 8];        // version, prev, merkle, time, bits, nonce — bytes × 2
const FIELD_OFF = [0, 8, 72, 136, 144, 152];   // start offset of each field within the 160-hex string
const fieldOfChar = (i) => { for (let f = 5; f >= 0; f--) if (i >= FIELD_OFF[f]) return f; return 0; };
function drawPreimageRow(r, b, tk, lockedCount, fillFrac, assembling, y) {
  const hex = bytesToHex(serializeHeader(b, tk.nonce)); // exactly the bytes the node hashes (verified)
  // fit all 160 chars across the panel
  let fs = 11; ctx.font = `${fs}px ui-monospace, monospace`;
  let cw = ctx.measureText("0").width; const maxW = r.w - 72;
  if (cw * 160 > maxW) { fs = Math.max(8, fs * maxW / (cw * 160)); ctx.font = `${fs}px ui-monospace, monospace`; cw = ctx.measureText("0").width; }
  const totalW = cw * 160, x0 = r.x + r.w / 2 - totalW / 2;
  // chars resolved so far (rest churn) — in lockstep with the header fields locking above
  let revealed = 160;
  if (assembling) { revealed = 0; for (let f = 0; f < lockedCount; f++) revealed += FIELD_HEX[f]; if (lockedCount < 6) revealed += Math.ceil(fillFrac * FIELD_HEX[lockedCount]); }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < 160; i++) {
    const on = i < revealed, f = fieldOfChar(i);
    ctx.fillStyle = on ? (f === 5 ? "rgb(255,206,84)" : f % 2 === 0 ? `rgba(${ACCENT},0.9)` : "rgba(255,255,255,0.82)") : "rgba(255,255,255,0.18)"; // nonce = distinct gold (the field you control), not the bits' accent
    ctx.fillText(on ? hex[i] : churnChar(i), x0 + cw * (i + 0.5), y);
  }
  concatBox = { x: x0, w: totalW, y }; // the hash machine sweeps a glyph across this into the 1st hash
}
let concatBox = null;

// concat → 1st SHA-256 → 2nd SHA-256, two aligned rows forming left-to-right. When `live`, these are the
// REAL block's rounds (display order) and the 2nd row IS your node's submitted block hash — verified.
function drawHashMachine(r, ph, headerBottom, b, tk, live, height) {
  const cx = r.x + r.w / 2, grind = ph.name === "pack" || ph.name === "churn";
  const settleP = grind ? 0 : ph.name === "reveal" ? ph.p : 1;
  const h1 = tk.hash1Hex || "", h2 = tk.hashHex || "";
  const p1 = Math.min(1, settleP * 2), p2 = Math.max(0, settleP * 2 - 1); // 1st forms, then 2nd forms from it
  const lz2 = live ? leadingZeroHexChars(h2) : 0; // green leading zeros only on the real (display-order) submission

  const rowX = r.x + 20, rowW = r.w - 40, sp = rowW / 64; // 64 hex chars, full width — rows line up
  const hashRow = (s, p, y, lead, baseCol) => {
    const lit = Math.floor(p * 64);
    for (let i = 0; i < 64; i++) { const on = i < lit, isLead = lead && i < lead;
      text(on ? (s[i] || "0") : churnChar(i), rowX + sp * (i + 0.5), y, { size: 13, weight: on && isLead ? 700 : 400, color: on ? (isLead ? "rgb(90,225,140)" : baseCol) : "rgba(120,170,150,0.5)", align: "center", baseline: "middle", mono: true }); }
  };

  const y1 = headerBottom + 26, y2 = headerBottom + 66;
  // a glyph sweeps the SOURCE line in lockstep with the OUTPUT resolving below it. Source and output are
  // different lengths, but both are driven by the same prog (0→1), so they finish together — the glyph just
  // moves at sourceWidth/phase while the output fills at rowW/phase. A connector links the two.
  const scan = (box, prog, outY) => {
    if (!box || prog <= 0.02 || prog >= 0.995) return;
    const sx = box.x + prog * box.w, ex = rowX + prog * rowW; // glyph on source; resolving edge on output
    ctx.strokeStyle = "rgba(255,205,110,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, box.y + 11); ctx.lineTo(ex, outY - 11); ctx.stroke(); // connector
    ctx.strokeStyle = "rgba(255,205,110,0.5)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, box.y - 12); ctx.lineTo(sx, box.y + 12); ctx.stroke();
    ctx.fillStyle = "rgba(255,205,110,0.18)"; ctx.beginPath(); ctx.arc(sx, box.y, 12, 0, 7); ctx.fill(); // glow
    text(CYBER[(frame >> 2) % CYBER.length], sx, box.y, { size: 18, weight: 700, color: "rgb(255,215,120)", align: "center", baseline: "middle", mono: true });
    ctx.fillStyle = "rgba(255,205,110,0.16)"; ctx.beginPath(); ctx.arc(ex, outY, 10, 0, 7); ctx.fill(); // glow at the output edge
    text(CYBER[((frame >> 2) + 5) % CYBER.length], ex, outY, { size: 15, weight: 700, color: "rgb(255,215,120)", align: "center", baseline: "middle", mono: true }); // resolving glyph at the output edge (was a dot)
  };
  scan(concatBox, p1, y1);                               // concatenation → 1st hash
  scan({ x: rowX, w: rowW, y: y1 }, p2, y2);             // 1st hash → 2nd hash
  // Centred on the panel, like every other caption here. These two row labels were the only left-aligned text
  // in the section, which read as a misalignment against the centred headings above and below them.
  text(grind ? "SHA-256, churning…" : "1st SHA-256 — of the concatenation above", cx, y1 - 14, { size: 10, weight: 600, color: `rgba(${ACCENT},0.7)`, align: "center", baseline: "middle" });
  hashRow(h1, p1, y1, 0, "rgba(255,255,255,0.62)");
  // highlight the finished hash — ONLY once the 2nd SHA-256 has fully completed (the hold phase, after the
  // reveal finishes), never during the reveal. Drawn BEFORE the label + glyphs so its glow sits behind them.
  const done = ph.name === "hold" ? Math.min(1, ph.p / 0.04) : 0;
  if (done > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(frame / 22);
    const hX = rowX - 12, hY = y2 - 9, hW = rowW + 24, hH = 22; // wraps the glyph row, clear of the label above
    ctx.save();
    ctx.shadowColor = `rgba(${ACCENT},${0.5 * done})`; ctx.shadowBlur = 10 + 5 * pulse; // soft accent glow
    ctx.fillStyle = `rgba(${ACCENT},${0.10 * done})`; roundRect(hX, hY, hW, hH, 7); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(${ACCENT},${done * (0.65 + 0.3 * pulse)})`; ctx.lineWidth = 1.8; roundRect(hX, hY, hW, hH, 7); ctx.stroke();
    ctx.restore();
  }
  text(live ? "2nd SHA-256 — your block hash · this is what your node submitted" : "2nd SHA-256 — hash that result AGAIN → a new value (the “double”)", cx, y2 - 16, { size: 10, weight: 700, color: live ? "rgb(90,220,140)" : `rgba(${ACCENT},0.7)`, align: "center", baseline: "middle" });
  hashRow(h2, p2, y2, lz2, live ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.62)");
  text("why hash twice? a lone SHA-256 is open to a “length-extension” trick — hashing the hash again closes it", cx, y2 + 28, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
  // #6: what makes the hash random
  text("the randomness: every input is fixed, yet SHA-256's output is unpredictable — you can't aim, only compute & check", cx, y2 + 44, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });

  const y3 = headerBottom + 122;
  if (live) {
    const v = model.liveBuild;
    text(`${v.verified ? "✓ verified" : "⚠ mismatch"} — our double-SHA256 reproduces your node’s submission for block #${(height || 0).toLocaleString()}`, cx, y3, { size: 11, weight: 700, color: v.verified ? "rgb(90,220,140)" : "rgba(255,150,80,0.95)", align: "center", baseline: "middle" });
    text(`${v.leadingZeroBits} leading zero bit${v.leadingZeroBits === 1 ? "" : "s"}  ·  ${v.below ? "BELOW the target — WIN!" : "above the target (no win this block)"}`, cx, y3 + 18, { size: 11, color: v.below ? "rgb(90,225,140)" : "rgba(255,255,255,0.6)", align: "center", baseline: "middle" });
  } else {
    text("in-browser demo — connect your node to hash the real block you're mining", cx, y3, { size: 10, color: "rgba(255,255,255,0.32)", align: "center", baseline: "middle" });
  }
}

// a row of monospace chars that scramble then lock in left-to-right as p rises (in step with the segment)
function fieldValueRow(strV, p, cx, cy, size, lead = 0) {
  const chars = strV.split("");
  const lock = Math.min(chars.length, Math.ceil(p * chars.length));
  ctx.font = `${size}px ui-monospace, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cw = ctx.measureText("0").width || size * 0.6;
  let x = cx - (cw * chars.length) / 2 + cw / 2;
  for (let i = 0; i < chars.length; i++) {
    const lk = i < lock, isLead = lk && i < lead;
    ctx.fillStyle = lk ? (isLead ? `rgb(${ACCENT})` : "rgba(255,255,255,0.85)") : "rgba(120,165,150,0.6)";
    ctx.fillText(lk ? chars[i] : churnChar(i), x, cy); x += cw;
  }
}

// each header field's own animation in the pane, shown only while that field is being constructed
function drawFieldDetail(idx, p, dr, b, tk, height) {
  const cx = dr.x + dr.w / 2, midY = dr.y + dr.h / 2, h = height || model.tipHeight || 0;
  const cap = (s) => text(s, cx, dr.y + 12, { size: 12, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
  const src = (s) => text("comes from: " + s, cx, dr.y + 28, { size: 10, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" }); // #3: where each part comes from
  if (idx === 0) {
    cap("version — which consensus rules this block follows");
    src("the miner — a few bits signalling which soft-fork rules it supports");
    fieldValueRow("0x" + (b.version >>> 0).toString(16).padStart(8, "0"), p, cx, midY + 8, 26);
  } else if (idx === 1) {
    cap("⛓ the previous block's hash — the literal link that forms the chain");
    src("the current chain tip (block #" + (h - 1).toLocaleString() + ") — copied straight in");
    fieldValueRow(b.previousblockhash.slice(0, 40), p, cx, midY + 8, 15);
    text("you're mining the next block — if your hash wins, it becomes the chain's newest link, what the block after yours points back to", cx, dr.y + dr.h - 16, { size: 11, color: `rgba(${ACCENT},0.7)`, align: "center", baseline: "middle" });
  } else if (idx === 2) {
    drawMerkleTree(dr, p, true); // the merkle tree, building in step with this field
  } else if (idx === 3) {
    cap("time — when the block was assembled (UTC)");
    src("the miner's own clock at build time");
    text(new Date(b.timestamp * 1000).toUTCString().replace("GMT", "UTC"), cx, midY + 4, { size: 15, weight: 600, color: "rgba(255,255,255,0.85)", align: "center", baseline: "middle" });
    fieldValueRow("unix " + b.timestamp, p, cx, midY + 28, 15);
  } else if (idx === 4) {
    cap("bits — your hash must land BELOW this target to win:");
    src("the network — recalculated every 2,016 blocks (~2 weeks) to keep blocks ~10 min apart");
    const tgt = bitsToTarget(b.bits).toString(16).padStart(64, "0").slice(0, 44), tlead = leadingZeroHexChars(tgt);
    fieldValueRow(tgt, Math.max(p, 0.5), cx, midY + 8, 14, tlead);
    text(`${tlead} leading zeros required — that's the difficulty`, cx, dr.y + dr.h - 16, { size: 11, color: `rgba(${ACCENT},0.7)`, align: "center", baseline: "middle" });
  } else {
    cap("nonce — your lottery number; the one field a miner is free to change");
    src("you (the miner) — every other field is fixed by the block, so this is the only knob to vary");
    const seed = machineSeed(), seedShort = seed.length > 24 ? seed.slice(0, 22) + "…" : seed;
    // the nonce is DERIVED: hash "seed:height", take the first 4 bytes → your ticket number for this block
    text(`SHA-256( "${seedShort}  :  ${h.toLocaleString()}" )`, cx, dr.y + 44, { size: 13, color: "rgba(255,255,255,0.7)", align: "center", baseline: "middle", mono: true });
    text("( machine seed  :  block height )", cx, dr.y + 60, { size: 10, color: `rgba(${ACCENT},0.7)`, align: "center", baseline: "middle" }); // #4: label the parts
    text("↓  first 4 bytes", cx, dr.y + 78, { size: 11, color: `rgba(${ACCENT},0.75)`, align: "center", baseline: "middle" });
    fieldValueRow("#" + tk.nonce.toLocaleString(), p, cx, dr.y + 104, 24);
    text("we take ONE deterministic value — a real miner sweeps all ~4 billion of them", cx, dr.y + dr.h - 16, { size: 11, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
  }
}

// Dedicated MERKLE section — makes the step everyone trips on explicit: two hashes are CONCATENATED into ONE
// 64-byte string, then hashed. A small tree on the left for context; the pair being combined, up close, right.
function drawMerkle(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0, GRN = "rgb(90,225,140)", GLD = "255,205,110";
  text("MERKLE TREE — how every transaction in a block folds into ONE hash", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("Hash the transactions in pairs; then hash those hashes in pairs; repeat until one is left — the merkle root, which goes into the block header.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });

  const rt = model.recentTxs || [];
  const leafHex = (k) => (rt[k] && rt[k].txid) ? rt[k].txid : (() => { let s = ""; for (let i = 0; i < 20; i++) s += _HEX[Math.floor(hrand(k * 13.1 + i * 2.7) * 16)]; return s; })();
  const nodeHex = (id) => { let s = ""; for (let i = 0; i < 20; i++) s += _HEX[Math.floor(hrand(id * 91.7 + i * 3.3) * 16)]; return s; };
  const leaves = [0, 1, 2, 3].map(leafHex), P = [nodeHex(101), nodeHex(102)], R = (model.block && model.block.merkle_root) || nodeHex(999);
  const pairs = [
    { a: leaves[0], b: leaves[1], p: P[0], na: "hash of tx 1", nb: "hash of tx 2", np: "parent hash" },
    { a: leaves[2], b: leaves[3], p: P[1], na: "hash of tx 3", nb: "hash of tx 4", np: "parent hash" },
    { a: P[0], b: P[1], p: R, na: "left parent", nb: "right parent", np: "MERKLE ROOT" },
  ];
  const pi = Math.floor(frame / 150) % 3, cur = pairs[pi];

  // ---- left: the tree (4 leaves → 2 → root), active pair highlighted ----
  const tw = w * 0.32, tx = x0, yLeaf = r.y + r.h - 58, yP = r.y + 132, yR = r.y + 82;
  const lpos = (k) => ({ x: tx + tw * (k + 0.5) / 4, y: yLeaf }), ppos = (k) => ({ x: tx + tw * (k + 0.5) / 2, y: yP }), rpos = { x: tx + tw / 2, y: yR };
  const aLeaf = (k) => (pi === 0 && k < 2) || (pi === 1 && k >= 2);
  for (let k = 0; k < 4; k++) { const a = lpos(k), b = ppos(k >> 1), on = aLeaf(k); ctx.strokeStyle = on ? `rgba(${GLD},0.8)` : "rgba(255,255,255,0.16)"; ctx.lineWidth = on ? 1.6 : 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  for (let k = 0; k < 2; k++) { const a = ppos(k), on = pi === 2; ctx.strokeStyle = on ? `rgba(${GLD},0.8)` : "rgba(255,255,255,0.16)"; ctx.lineWidth = on ? 1.6 : 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(rpos.x, rpos.y); ctx.stroke(); }
  for (let k = 0; k < 4; k++) { const p = lpos(k), on = aLeaf(k); ctx.fillStyle = on ? `rgba(${GLD},0.92)` : `rgba(${ACCENT},0.55)`; roundRect(p.x - 13, p.y - 7, 26, 14, 3); ctx.fill(); text(`tx${k + 1}`, p.x, p.y, { size: 9, weight: 700, color: "rgba(10,8,14,0.9)", align: "center", baseline: "middle", mono: true }); text(leaves[k].slice(0, 6), p.x, p.y + 15, { size: 8, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle", mono: true }); }
  for (let k = 0; k < 2; k++) { const p = ppos(k), on = pi < 2 && k === pi; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fillStyle = on ? `rgb(${GLD})` : `rgba(${ACCENT},0.7)`; ctx.fill(); text(P[k].slice(0, 6), p.x, p.y - 11, { size: 8, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle", mono: true }); }
  ctx.beginPath(); ctx.arc(rpos.x, rpos.y, 6, 0, 7); ctx.fillStyle = GRN; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(rpos.x, rpos.y, 9, 0, 7); ctx.stroke();
  text("merkle root", rpos.x, rpos.y - 16, { size: 9, weight: 700, color: GRN, align: "center", baseline: "middle" });

  // ---- right: the active pair, up close (THE teaching) ----
  const dx = x0 + tw + 34, dR = x1;
  text("this step, up close:", dx, r.y + 60, { size: 10.5, weight: 700, color: `rgba(${GLD},0.9)`, baseline: "middle" });
  const hbox = (bx, by, bw2, hex, label, col) => { ctx.fillStyle = "rgba(255,255,255,0.05)"; roundRect(bx, by, bw2, 26, 4); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 1; roundRect(bx, by, bw2, 26, 4); ctx.stroke(); text(hex.slice(0, 13) + "…", bx + 8, by + 10, { size: 10, color: "rgba(255,255,255,0.85)", baseline: "middle", mono: true }); text(label, bx + 8, by + 19, { size: 8, color: col, baseline: "middle" }); text("32 bytes", bx + bw2 - 6, by + 19, { size: 8, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" }); };
  const inW = Math.min(178, (dR - dx) * 0.32), ay = r.y + 78, by2 = r.y + 118;
  hbox(dx, ay, inW, cur.a, cur.na, `rgba(${ACCENT},0.85)`);
  hbox(dx, by2, inW, cur.b, cur.nb, `rgba(${ACCENT},0.85)`);
  const gx = dx + inW + 30, gW = Math.min(232, (dR - dx) * 0.42), gy = r.y + 85;
  ctx.strokeStyle = `rgba(${GLD},0.6)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(dx + inW, ay + 13); ctx.lineTo(gx, gy + 15); ctx.moveTo(dx + inW, by2 + 13); ctx.lineTo(gx, gy + 15); ctx.stroke();
  ctx.fillStyle = `rgba(${GLD},0.13)`; roundRect(gx, gy, gW, 30, 4); ctx.fill(); ctx.strokeStyle = `rgba(${GLD},0.75)`; ctx.lineWidth = 1.2; roundRect(gx, gy, gW, 30, 4); ctx.stroke();
  text(cur.a.slice(0, 7) + " ‖ " + cur.b.slice(0, 7) + "…", gx + gW / 2, gy + 11, { size: 10, weight: 600, color: "rgba(255,235,190,0.95)", align: "center", baseline: "middle", mono: true });
  text("ONE 64-byte string — just glued end-to-end", gx + gW / 2, gy + 22, { size: 8.5, color: `rgba(${GLD},0.95)`, align: "center", baseline: "middle" });
  const arrX = gx + gW, pbx = arrX + 66, pW = Math.min(176, dR - pbx);
  text("SHA-256²", (arrX + pbx) / 2, gy + 7, { size: 9, weight: 700, color: "rgba(255,255,255,0.62)", align: "center", baseline: "middle" });
  text("→", (arrX + pbx) / 2, gy + 20, { size: 15, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  if (pbx + 70 <= dR) hbox(pbx, gy, Math.max(110, pW), cur.p, cur.np, cur.np === "MERKLE ROOT" ? GRN : `rgba(${ACCENT},0.85)`);

  text("Two 32-byte hashes are concatenated into ONE 64-byte string — then hashed back to 32 bytes. The hash only ever sees a single input; concatenation is the whole trick.", x0, r.y + r.h - 24, { size: 11, color: `rgba(${ACCENT},0.8)`, baseline: "middle" });
  text("Odd number of nodes at a level? The last is paired with itself. · Leaves shown are real recent txids; parent hashes are illustrative.", x0, r.y + r.h - 9, { size: 9.5, color: "rgba(255,255,255,0.42)", baseline: "middle" });
}

// The merkle root is the top of a binary tree: every transaction is hashed (SHA-256²) into a txid, then
// txids are hashed together in pairs, level by level, up to one root. Show the HASHING: tx chips emit a
// txid, then each pair's hashes lock into a parent hash, bottom-up as buildP rises; the root is the real one.
const _HEX = "0123456789abcdef";
function drawMerkleTree(dr, buildP, showRoot) {
  // a teaching illustration of how ANY block's root is built — use a realistic full-block tx count so the
  // tree has several levels to climb (a live blocksonly block can be just the coinbase = a 1-leaf tree)
  const real = Math.max(model.txCount || 0, 8);
  const n = Math.min(16, Math.max(2, real)); // representative leaves
  const levels = []; let c = n; while (true) { levels.push(c); if (c <= 1) break; c = Math.ceil(c / 2); }
  const rows = levels.length;
  const topY = dr.y + 24, botY = dr.y + dr.h - 44, gap = (botY - topY) / Math.max(1, rows - 1); // root sits a bit lower so its hash label clears the node; extra bottom room for the captions
  const pos = (L, k) => ({ x: dr.x + dr.w * (k + 0.5) / levels[L], y: botY - L * gap });
  const rootHex = (model.block && model.block.merkle_root) || "";
  const frag = (L, k, len, lockP) => {
    const lit = Math.ceil(Math.max(0, Math.min(1, lockP)) * len);
    let s = ""; for (let i = 0; i < len; i++) s += i < lit ? (L === rows - 1 && rootHex ? rootHex[i] : _HEX[Math.floor(hrand(L * 31.7 + k * 7.3 + i * 1.9) * 16)]) : churnChar(i + L * 5 + k);
    return s;
  };

  // build bottom-up, LEVEL BY LEVEL — ALL nodes at a level hash (as churning glyphs) up to the next, together
  const built = buildP * (rows + 0.7);
  const lvlP = (L) => Math.max(0, Math.min(1, built - L)); // settle progress for a whole level
  const activeL = Math.floor(built);                       // the level hashing up into its parents right now

  ctx.lineWidth = 1;
  for (let L = 0; L < rows - 1; L++) {
    const pe = lvlP(L + 1); if (pe <= 0.03) continue;       // an edge appears as its PARENT level forms
    const hot = L + 1 === activeL;                          // this whole level is hashing up right now
    ctx.strokeStyle = hot ? "rgba(255,205,110,0.7)" : `rgba(${ACCENT},${0.3 * pe})`; ctx.lineWidth = hot ? 1.6 : 1;
    for (let k = 0; k < levels[L]; k++) {
      const A = pos(L, k), P = pos(L + 1, k >> 1);
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(P.x, P.y); ctx.stroke();
      if (hot) for (let s = 0; s < 3; s++) {                 // data streams: glyphs flow UP each edge into the parent being hashed
        const u = (((frame >> 1) + k * 7 + s * 16) % 48) / 48; // 0 (child) → 1 (parent), staggered per edge
        const gx = A.x + (P.x - A.x) * u, gy = A.y + (P.y - A.y) * u;
        text(churnChar(k * 5 + s * 3 + frame), gx, gy, { size: 10, weight: 700, color: `rgba(255,225,150,${0.22 + 0.7 * u})`, align: "center", baseline: "middle", mono: true });
      }
    }
  }
  for (let L = 0; L < rows; L++) {
    const isRoot = L === rows - 1, a = lvlP(L); if (a <= 0.03) continue;
    const fy = L === 0 ? pos(0, 0).y + 13 : isRoot ? pos(L, 0).y - 17 : pos(L, 0).y - 11;
    for (let k = 0; k < levels[L]; k++) {
      const p = pos(L, k);
      if (L === 0) { // leaves are transaction chips + their txid
        ctx.fillStyle = `rgba(${ACCENT},${(0.3 + 0.35 * a) * a})`; roundRect(p.x - 7, p.y - 5, 14, 10, 2); ctx.fill();
        if (a > 0.3) text(frag(0, k, levels[0] > 8 ? 4 : 5, a), p.x, fy, { size: 10, color: `rgba(255,255,255,${0.78 * a})`, align: "center", baseline: "middle", mono: true });
      } else if (a < 0.9) { // BEING HASHED: every node at this level is a churning glyph (enlarged + glowing while it's the active level)
        const hotNode = L === activeL;
        if (hotNode) { ctx.fillStyle = "rgba(255,205,110,0.16)"; ctx.beginPath(); ctx.arc(p.x, p.y, isRoot ? 15 : 12, 0, 7); ctx.fill(); }
        text(churnChar(L * 11 + k * 5 + (frame >> 1)), p.x, p.y, { size: isRoot ? 22 : hotNode ? 18 : 13, weight: 700, color: "rgb(255,215,120)", align: "center", baseline: "middle", mono: true });
      } else { // HASHED: settle to a circle, with its hash
        const rad = isRoot ? 6 : 4;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.fillStyle = isRoot ? "rgb(90,225,140)" : `rgba(${ACCENT},0.62)`; ctx.fill();
        if (isRoot) { ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(p.x, p.y, rad + 3, 0, 7); ctx.stroke(); }
        text(frag(L, k, isRoot ? 6 : levels[L] > 8 ? 4 : 5, 1) + (isRoot ? "…" : ""), p.x, fy, { size: isRoot ? 11 : 9, weight: isRoot ? 700 : 400, color: isRoot ? "rgb(90,225,140)" : "rgba(255,255,255,0.78)", align: "center", baseline: "middle", mono: true });
      }
    }
  }
  // label the operation at the level that's hashing up right now
  if (activeL >= 1 && activeL < rows && lvlP(activeL) > 0.05 && lvlP(activeL) < 0.95)
    text("⊕ SHA-256² — each parent is the hash of the two below it", dr.x + dr.w / 2, pos(activeL, 0).y - 24, { size: 10, weight: 600, color: "rgba(255,205,110,0.78)", align: "center", baseline: "middle" });

  const liveTx = model.liveBuild ? model.liveBuild.txCount : null, example = liveTx != null;
  if (example) text("EXAMPLE — illustrative tree (not your live block)", dr.x, dr.y + 6, { size: 10, weight: 700, color: "rgba(255,180,80,0.85)", baseline: "middle" });
  const cap = built < rows - 0.3
    ? "every pair of hashes hashes up to the next level — bottom to top"
    : ["every node here is a hash — leaves are txids, the top is the merkle root",   // make explicit the node text is a hash
       "every transaction is a leaf — hashed in pairs up to one root",
       "and it re-computes as new transactions arrive — the block isn't frozen while it's mined"][Math.floor(frame / 270) % 3];
  text(cap, dr.x + dr.w / 2, dr.y + dr.h - 18, { size: 11, color: `rgba(${ACCENT},0.72)`, align: "center", baseline: "middle" });
  text(example
    ? `a full block (~${real.toLocaleString()} tx) builds its root like this — your block being mined has ${liveTx.toLocaleString()} tx${liveTx === 1 ? " (coinbase only, so its root IS that hash)" : ""}`
    : `${real.toLocaleString()} transactions → one merkle root`,
    dr.x + dr.w / 2, dr.y + dr.h - 5, { size: 10, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
  if (showRoot && lvlP(rows - 1) > 0.9) { const root = pos(rows - 1, 0); text("← merkle root", root.x + 42, root.y, { size: 11, weight: 600, color: "rgb(90,225,140)", baseline: "middle" }); }
}

// ---- BLOCKCHAIN SYNC: peer arch → centered node → fills the block below → steps left ----
const syncState = { t: 0, shown: null, phase: "fill", fp: 0, sp: 0, disk: 12 };
let syncFlash = 0, syncFlashH = 0; // a "new block mined" pulse for the sync panel (node + newest block + toast)
const mbFmt = (s) => (s / 1e6).toFixed(2) + " MB";

function dataComet(x0, y0, x1, y1, prog, seed, alpha = 1) {
  if (alpha <= 0.01) return;
  const hx = x0 + (x1 - x0) * prog, hy = y0 + (y1 - y0) * prog;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1, nx = (x1 - x0) / len, ny = (y1 - y0) / len;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let tdx = 3; tdx >= 0; tdx--) {
    const bx = hx - nx * tdx * 9, by = hy - ny * tdx * 9;
    if (tdx === 0) { ctx.font = "700 12px ui-monospace, monospace"; ctx.fillStyle = `rgba(255,200,90,${0.95 * alpha})`; ctx.fillText(CYBER[(frame + seed) % CYBER.length], bx, by); }
    else { ctx.font = "11px ui-monospace, monospace"; ctx.fillStyle = `rgba(70,185,140,${Math.max(0.06, 0.6 * (1 - tdx / 4)) * alpha})`; ctx.fillText("0123456789abcdef"[(seed + tdx * 3 + Math.floor(prog * 40)) % 16], bx, by); }
  }
}

// A glyph stream that behaves like water in a pipe. Turn the tap ON: the leading edge (head) travels
// from source to destination — you watch the front of the stream arrive. Turn it OFF: the source stops
// but the water already in the pipe keeps going, so the trailing edge (tail) follows down and drains out
// the bottom. Brightness is uniform along the column (no prominent head); only the two moving edges are
// soft. The in-pipe glyph SPEED scales with the data rate, so the flow visibly speeds up and slows.
function tickStream(store, key, active, scrollSpeed) {
  let st = store[key]; if (!st) st = store[key] = { head: 0, tail: 0, phase: 0 };
  const edge = 1.9 / 60; // leading/trailing edge crosses the whole path in ~0.5s
  st.phase = (st.phase + scrollSpeed / 60) % 1;
  if (active) { st.tail = 0; st.head = Math.min(1, st.head + edge); }
  else if (st.head > 0) { st.tail = Math.min(1, st.tail + edge); if (st.tail >= 1) { st.head = 0; st.tail = 0; } }
  return st;
}
function drawStream(x0, y0, x1, y1, st, alpha) {
  if (alpha <= 0.02 || st.head <= st.tail) return;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1, n = Math.max(3, Math.round(len / 13));
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let g = 0; g < n; g++) {
    const f = (g / n + st.phase) % 1;
    if (f < st.tail || f > st.head) continue;           // only the water currently in the pipe
    const a = alpha * Math.min(1, (f - st.tail) / 0.05, (st.head - f) / 0.05); // crisp but anti-aliased moving edges
    if (a <= 0.02) continue;
    const gx = x0 + (x1 - x0) * f, gy = y0 + (y1 - y0) * f;
    // colour + glyph are a STABLE per-slot hash (no regular bright lattice, no linear char gradient, no
    // per-frame change) so the only motion is the dense field translating down — kills the wagon-wheel /
    // reverse-motion illusion the evenly-spaced bright glyphs created.
    const h = (g * 2654435761) >>> 8;
    if (h % 100 < 38) { ctx.font = "700 12px ui-monospace, monospace"; ctx.fillStyle = `rgba(255,205,95,${a})`; ctx.fillText(CYBER[h % CYBER.length], gx, gy); }
    else { ctx.font = "11px ui-monospace, monospace"; ctx.fillStyle = `rgba(70,190,140,${a * 0.85})`; ctx.fillText("0123456789abcdef"[(h >> 3) % 16], gx, gy); }
  }
}


function drawConveyorBlock(x, cy, bw, bh, height, info, fill, fade, highlight) {
  const a = 1 - fade;
  if (a <= 0.05) {
    for (let d = 0; d < 3; d++) { ctx.globalAlpha = Math.max(0, 0.35 * (a / 0.05)); ctx.beginPath(); ctx.arc(x + 10 + d * 10, cy + (d - 1) * 6, 1.3, 0, 7); ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.fill(); }
    ctx.globalAlpha = 1; return;
  }
  const y = cy - bh / 2, verified = fill >= 1;
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(255,255,255,0.05)"; roundRect(x, y, bw, bh, 4); ctx.fill();
  // visible "filling" level rising as the block downloads — bold liquid + bright surface
  if (fill > 0.001 && !verified) {
    const lh = (bh - 6) * fill, top = y + bh - 3 - lh;
    const grad = ctx.createLinearGradient(0, top, 0, y + bh - 3);
    grad.addColorStop(0, `rgba(${ACCENT},0.35)`); grad.addColorStop(1, `rgba(${ACCENT},0.6)`);
    ctx.fillStyle = grad; roundRect(x + 2, top, bw - 4, lh, 3); ctx.fill();
    ctx.strokeStyle = "rgba(255,215,140,0.95)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 3, top); ctx.lineTo(x + bw - 3, top); ctx.stroke(); // data surface
  }
  const target = info && info.tx ? Math.min(28, Math.max(6, Math.round(info.tx / 200))) : (info && info.size ? Math.min(28, Math.max(6, Math.round(info.size / 75000))) : 12);
  const shown = Math.max(0, Math.floor(target * fill)), dcols = 7;
  for (let d = 0; d < shown; d++) {
    const col = d % dcols, row = Math.floor(d / dcols), dx = x + 11 + col * ((bw - 22) / (dcols - 1)), dy = y + 22 + row * 12;
    ctx.beginPath(); ctx.arc(dx, dy, 1.8, 0, 7); ctx.fillStyle = verified ? "rgba(90,220,140,0.75)" : "rgba(255,200,120,0.85)"; ctx.fill();
  }
  // border: confirmed blocks are GREEN (the newest one a brighter green); a block still filling is neutral white.
  // Orange is reserved exclusively for the mining block (drawn separately) — so only ever ONE orange block.
  ctx.strokeStyle = (verified && highlight) ? "rgba(120,235,150,0.95)" : verified ? "rgba(90,200,130,0.45)" : "rgba(255,255,255,0.3)";
  ctx.lineWidth = (verified && highlight) ? 1.9 : verified ? 1.1 : 1; roundRect(x, y, bw, bh, 4); ctx.stroke();
  if (height) text("#" + height, x + bw / 2, y + 11, { size: 11, weight: 700, color: "rgba(255,255,255,0.78)", align: "center", baseline: "middle" });
  if (info && info.size) text(mbFmt(info.size), x + bw / 2, y + bh - 9, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  if (verified) text("✓", x + bw - 11, y + 11, { size: 13, weight: 700, color: "rgb(90,230,140)", align: "center", baseline: "middle" });
  // pruning: cover the block with churning matrix glyphs — digesting/dissolving it as it fades
  if (fade > 0.02) {
    const cols = Math.max(1, Math.floor((bw - 6) / 11)), rows = Math.max(1, Math.floor((bh - 8) / 13)), total = cols * rows;
    const cover = Math.ceil(total * Math.min(1, fade * 1.15));
    ctx.globalAlpha = 1; ctx.font = "700 11px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let c = 0; c < cover; c++) {
      const col = c % cols, row = Math.floor(c / cols);
      ctx.fillStyle = `rgba(255,150,60,${0.5 + 0.45 * Math.abs(Math.sin(frame * 0.2 + c))})`;
      ctx.fillText(CYBER[(frame + c * 5) % CYBER.length], x + 8 + col * 11, y + 11 + row * 13);
    }
  }
  ctx.globalAlpha = 1;
}

// The assumeutxo catch-up, in the row UNDER the sync status — the same slot the "your computer may warm up"
// note uses while syncing, and the two can't both apply (that one needs blocks-behind > 0; this only runs once
// you're at the tip). The arch below drops to clear it, exactly as it already does for that note. Worded as
// something your node is DOING FOR YOU rather than a wait, and drawn in white: an accent or warning tone here
// would read as a problem, and it isn't one — mining is already running.
function drawBackgroundVerify(r) {
  const bv = backgroundVerify();
  if (!bv) return;
  const left = r.x + 16, right = r.x + r.w - 16, y = r.y + 78;
  text("Your node is checking Bitcoin's history for itself — you're already mining", left, y, { size: 10.5, weight: 600, color: "rgba(255,255,255,0.55)", baseline: "middle" });
  const eta = backgroundVerifyEta(bv);
  text(`${bv.blocks.toLocaleString()} / ${bv.target.toLocaleString()} · ${(bv.progress * 100).toFixed(1)}%${eta ? ` · ${eta}` : ""}`, right, y, { size: 10.5, weight: 600, color: "rgba(255,255,255,0.42)", align: "right", baseline: "middle" });
  const bw = right - left, by = r.y + 90;
  ctx.fillStyle = "rgba(255,255,255,0.10)"; roundRect(left, by, bw, 5, 2.5); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.42)"; roundRect(left, by, Math.max(4, bw * bv.progress), 5, 2.5); ctx.fill();
  // The whole point of saying anything here. The "your computer may warm up" note one row up is gated on
  // blocks-behind, so it stops the moment you reach the tip — which is when THIS starts and runs for hours.
  // Without this line the busiest stretch of the install is the one with no explanation attached to it.
  text("Uses extra CPU and memory while it runs — your computer quiets down to near-idle when it finishes.", left, r.y + 104, { size: 9.5, color: "rgba(255,180,80,0.55)", baseline: "middle" });
}

// The win record, kept where you can always find it. The bridge has published {height, hash, status,
// confirmations, matures_in} on every poll since the feature existed, and the dashboard read it in exactly one
// place — to decide whether to fire the celebration — and never showed it. Dismiss that animation and the
// single most important thing this app can produce left no trace but a marker in the ticket timeline.
function winStatus() {
  const ws = model.node && model.node.miner && model.node.miner.win_status;
  return ws && ws.height ? ws : null;
}
// Coinbase rewards cannot be SPENT until 100 blocks are built on top (~16-17h). Saying CONFIRMED at 6 without
// saying this sent people to a wallet showing an unspendable balance, with nothing anywhere explaining why.
function maturityNote(ws) {
  const need = ws.maturity_needs || 100, have = Math.max(0, ws.confirmations || 0);
  if (have >= need) return { done: true, text: `spendable now — matured past ${need} confirmations` };
  const left = Math.max(0, need - have), mins = left * 10;
  const eta = mins >= 120 ? `~${Math.round(mins / 60)} hours` : `~${mins} min`;
  return { done: false, have, need, text: `spendable after ${need} confirmations · ${have} / ${need} · about ${eta} to go` };
}

function drawWin(r) {
  const ws = winStatus();
  if (!ws) return;
  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  const lost = ws.status === "lost", pending = ws.status === "pending";
  const col = lost ? "255,120,110" : pending ? "255,210,110" : "90,235,150";
  ctx.strokeStyle = `rgba(${col},0.35)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  const cx = r.x + r.w / 2;
  const head = lost ? "This block didn't make it" : pending ? "You found a block — settling" : "You won a block";
  text(head, cx, r.y + 24, { size: 17, weight: 700, color: `rgb(${col})`, align: "center", baseline: "middle" });
  text(`block #${Number(ws.height).toLocaleString()}`, cx, r.y + 46, { size: 12, weight: 600, color: "rgba(255,255,255,0.7)", align: "center", baseline: "middle" });
  text(ws.hash || "", cx, r.y + 64, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle", mono: true });

  if (lost) {
    text("another block reached that height first — a duplicate, or beaten by seconds. Your node kept mining.", cx, r.y + 92, { size: 11, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    return;
  }
  const conf = Math.max(0, ws.confirmations || 0), need = ws.needs || 6;
  text(pending ? `${conf} / ${need} confirmations — not safe from a reorg yet` : `${conf} confirmations — settled`,
    cx, r.y + 88, { size: 11.5, weight: 600, color: "rgba(255,255,255,0.62)", align: "center", baseline: "middle" });

  const m = maturityNote(ws);
  text(m.done ? "3.125 BTC is in your wallet and spendable" : "3.125 BTC was paid to your address by the block itself — nobody sends it to you",
    cx, r.y + 108, { size: 11, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  text(m.text, cx, r.y + 125, { size: 11, weight: 600, color: m.done ? "rgb(120,245,170)" : "rgba(255,210,110,0.9)", align: "center", baseline: "middle" });
  if (!m.done) { // maturity bar — the countdown that makes an unspendable balance make sense
    const bw = Math.min(360, r.w * 0.5), bx = cx - bw / 2, by = r.y + 138;
    ctx.fillStyle = "rgba(255,255,255,0.12)"; roundRect(bx, by, bw, 5, 2.5); ctx.fill();
    ctx.fillStyle = "rgba(255,210,110,0.85)"; roundRect(bx, by, Math.max(3, bw * (m.have / m.need)), 5, 2.5); ctx.fill();
  }
}

function drawSync(r) {
  if (!reduceMotion) syncState.t += 1 / 60; // reduced-motion: freeze the sync particle flow / pulse
  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  text("SYNCING THE CHAIN — peers → node → block", r.x + 16, r.y + 16, { size: 12, weight: 700, color: "rgba(255,255,255,0.55)", baseline: "middle" });

  const node = model.node;
  // no REAL node yet (practice/symbolic mode, not set up, or unreachable) — show a call-to-action, not a
  // fake sync animation. (a real node reports its own headers/blocks; without one we must not pretend.)
  if (!(node && node.reachable !== false && (node.headers || node.blocks))) {
    const sym = node && node.miner && node.miner.mode === "symbolic", cx0 = r.x + r.w / 2, cy0 = r.y + r.h / 2;
    if (!sym && nodeReconnecting()) { // brief drop just after a settings save / engine restart — don't alarm
      text("reconnecting to your node…", cx0, cy0 - 14, { size: 15, weight: 700, color: "rgba(255,210,110,0.85)", align: "center", baseline: "middle" });
      text("the miner restarted (normal after saving settings) — this fills back in a moment", cx0, cy0 + 12, { size: 12, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" });
      return;
    }
    const managed = nodeMode === "managed", dots = ".".repeat(1 + (Math.floor(clock * 1.5) % 3)); // animated ellipsis so a "starting/waiting" state never looks frozen
    const setup = managed ? nodeSetupView() : null;
    if (setup) { // narrate the REAL provisioning phase from the app (download → snapshot → sync), with a live progress bar
      const col = setup.isError ? "rgba(255,120,110,0.95)" : "rgba(255,210,110,0.92)", hasBar = setup.progress != null;
      text(setup.head + (setup.isError ? "" : dots), cx0, cy0 - (hasBar ? 26 : 14), { size: 15, weight: 700, color: col, align: "center", baseline: "middle" });
      text(setup.detail, cx0, cy0 + (hasBar ? -4 : 12), { size: 12, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
      if (hasBar) { const bw2 = Math.min(360, r.w * 0.5), bx2 = cx0 - bw2 / 2, byy = cy0 + 18, bh2 = 6;
        ctx.fillStyle = "rgba(255,255,255,0.12)"; roundRect(bx2, byy, bw2, bh2, 3); ctx.fill();
        ctx.fillStyle = "rgba(255,210,110,0.85)"; roundRect(bx2, byy, bw2 * setup.progress, bh2, 3); ctx.fill(); }
      return;
    }
    text(sym ? "practice mode — no Bitcoin node yet" : managed ? "starting your node" + dots : "waiting for your node" + dots,
      cx0, cy0 - 14, { size: 15, weight: 700, color: sym ? "rgba(255,255,255,0.6)" : "rgba(255,210,110,0.9)", align: "center", baseline: "middle" });
    text(sym ? "set up a node (bitcoind) and this fills with the real chain syncing — then you mine for real"
             : managed ? "Setting up your private Bitcoin node in the background — this can take a few minutes. Nothing for you to do; it fills in on its own."
             : "This fills in automatically once your node is running and reachable — it downloads and verifies the chain, block by block.",
      cx0, cy0 + 12, { size: 12, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" });
    return;
  }
  const tip = (node && node.headers) || model.tipHeight || 0;
  const head = node && node.blocks ? node.blocks : (model.tipHeight || 0);
  if (!head) { text("connecting to the network…", r.x + r.w / 2, r.y + r.h / 2, { size: 14, color: "#888", align: "center", baseline: "middle" }); return; }

  // real aggregate throughput from peers drives how fast the current block fills
  const peersAll = (node && Array.isArray(node.peers)) ? node.peers : [];
  const sumRate = peersAll.reduce((s, p) => s + (p.rate || 0), 0);
  syncState.flow = syncState.flow == null ? sumRate : syncState.flow + (sumRate - syncState.flow) * 0.08; // smooth across 4s polls
  // When caught up we're "mining" the tip. A newly FOUND block (head advances while synced) is animated
  // joining the chain: one quick live cycle (same fill→validate→step→prune), not the IBD bulk download.
  const behind = Math.max(0, tip - Math.floor(head));
  // tip block too old → we're behind even if headers haven't refreshed yet (the post-sleep "false at the tip")
  const stale = node && node.tip_time ? (Date.now() / 1000 - node.tip_time) > 90 * 60 : false;
  const atTip = behind === 0 && !stale; // caught up — the network is mining the tip; your node assembles/receives #tip+1
  const sinceBlock = model.block && model.block.timestamp ? Math.max(0, Date.now() / 1000 - model.block.timestamp) : 0;
  const mineProg = Math.max(0.04, Math.min(1, sinceBlock / 600)); // time since last block vs the ~10-min average
  const fHead = Math.floor(head);
  if (syncState.lastHead != null && fHead > syncState.lastHead && fHead - syncState.lastHead <= 2 && behind === 0) { syncState.pending = Math.min(3, (syncState.pending || 0) + (fHead - syncState.lastHead)); syncFlash = 1; syncFlashH = fHead; } // a real new block
  if (syncPreview && behind === 0) { syncState.pending = Math.min(3, (syncState.pending || 0) + 1); syncFlash = 1; syncFlashH = fHead + 1; syncPreview = false; } // "preview a block" → commit one now
  syncState.lastHead = fHead;
  if (!reduceMotion && syncFlash > 0) syncFlash = Math.max(0, syncFlash - (1 / 60) / 2.6); // the new-block flash decays over ~2.6s
  const minedAnim = behind === 0 && (syncState.pending || 0) > 0; // a freshly mined block is committing, live
  const flowing = minedAnim || peersAll.some((p) => (p.rate || 0) > 15_000); // ≥1 peer sending, or a mined block landing
  syncState.streams = syncState.streams || {};
  // two-stage flow: a peer's water reaches the NODE only when its stream's leading edge is at the node (head≈1).
  const nodeFed = minedAnim || peersAll.some((p, i) => { if ((p.rate || 0) <= 15_000) return false; const st = syncState.streams["peer:" + (p.addr || ("p" + i))]; return st && st.head >= 0.98 && st.head > st.tail; });
  const fillPerSec = !flowing ? 0 : (minedAnim ? 0.5 : Math.max(0.12, Math.min(0.8, syncState.flow / 4_000_000))); // throughput-driven fill rate (kept at a watchable pace)
  const downloading = behind > 0 || minedAnim || stale;

  // geometry (needed by the phase machine to know how many blocks sit left of center)
  const cx = r.x + r.w / 2;
  const m = 22, bh = 74, gap = 16, bw = Math.max(84, Math.min(150, (r.w - 2 * m) / 6 - gap)), spacing = bw + gap;
  const cy = r.y + r.h - 116, nodeY = r.y + 188, birthX = cx - bw / 2, leftExit = r.x + m;
  const L = Math.max(2, Math.floor((birthX - leftExit) / spacing)); // visible blocks between center and the prune slot
  const PRUNE_SEC = 2.0; // how long the leftmost block visibly digests before it's gone

  // fill → prune → step cycle, run at a WATCHABLE pace. The conveyor advances on its own clock
  // (one block per cycle); it deliberately does NOT chase the node's head block-for-block — real
  // IBD adds dozens of blocks per poll, far too fast to follow. Heights are derived from the live
  // head each frame, so labels stay truthful while the in-progress fill is never reset by a head jump.
  // gently scale the cadence toward the node's real sync rate (blocks/sec from head movement), so faster
  // peers visibly sync faster. Clamped, and only the prune/step dead-time scales — the fill stays purely
  // throughput-driven (its varied speeds) — and the prune floor keeps it watchable.
  syncState.rateHist = syncState.rateHist || [];
  const rh = syncState.rateHist;
  if (!rh.length || head !== rh[rh.length - 1].h) rh.push({ t: syncState.t, h: head });
  while (rh.length > 2 && syncState.t - rh[0].t > 12) rh.shift();
  const rr = rh.length >= 2 ? (rh[rh.length - 1].h - rh[0].h) / Math.max(0.5, rh[rh.length - 1].t - rh[0].t) : 0;
  syncState.rateSmooth = syncState.rateSmooth == null ? rr : syncState.rateSmooth + (rr - syncState.rateSmooth) * 0.04;
  const paceMul = Math.max(0.6, Math.min(2.0, syncState.rateSmooth / 4)); // ~4 blk/s → 1×
  const pruneDur = Math.max(1.0, Math.min(2.5, PRUNE_SEC / paceMul)), stepDur = Math.max(0.28, 0.42 / paceMul); // watchable fill/prune cadence
  // The block is a container; its level (fp) only changes as the node→block stream actually delivers water.
  //   arrive : tap open, the stream's leading edge descends to the empty block — level NOT moving yet
  //   fill   : water landing, level rises at the throughput-driven rate up to FP_CUT
  //   topoff : tap closed; the water still in the pipe drains in, level tops off to 1 exactly as the tail lands
  //   prune  : leftmost block digests   ·   step : chain advances
  if (syncState.shown == null) { syncState.shown = 0; syncState.prunedBelow = -L - 1; syncState.phase = "arrive"; syncState.fp = 0; syncState.pruneT = 0; syncState.nh = 0; syncState.nt = 0; syncState.headStart = Math.floor(head); syncState.kHeight = {}; for (let kk = 0; kk >= -(L + 3); kk--) syncState.kHeight[kk] = Math.floor(head) + 1 + kk; }
  const flowRate = Math.min(1, syncState.flow / 2_000_000);
  syncState.nph = ((syncState.nph || 0) + (0.9 + 2.0 * flowRate) / 60) % 1; // glyph scroll along the node→block pipe
  const edgeStep = (1.6 + 1.4 * flowRate) / 60;                            // stream leading/trailing edge travel per frame
  const FP_CUT = 0.7;                                                      // level delivered while the tap is open; the rest tops off as the tail lands
  if (downloading) {
    if (syncState.phase === "arrive") {
      // node → block only starts once the node has actually been fed (peer water reached it)
      if (nodeFed) { syncState.nt = 0; syncState.nh = Math.min(1, syncState.nh + edgeStep); if (syncState.nh >= 1) syncState.phase = "fill"; }
      else if (syncState.nh > 0) { syncState.nt = Math.min(1, syncState.nt + edgeStep); if (syncState.nt >= 1) { syncState.nh = 0; syncState.nt = 0; } } // not fed: drain the partial pipe and wait
    } else if (syncState.phase === "fill") {
      if (nodeFed) {
        syncState.nh = 1; syncState.nt = 0;
        syncState.fp += fillPerSec / 60;
        if (syncState.fp >= FP_CUT) { syncState.fp = FP_CUT; syncState.fpCut = FP_CUT; syncState.phase = "topoff"; }
      } else { // peers stopped mid-fill: hold the level, drain the pipe, fall back to arrive to refill when data returns
        syncState.nt = Math.min(1, syncState.nt + edgeStep);
        if (syncState.nt >= 1) { syncState.nh = 0; syncState.nt = 0; syncState.phase = "arrive"; }
      }
    } else if (syncState.phase === "topoff") {
      syncState.nt = Math.min(1, syncState.nt + edgeStep);
      syncState.fp = syncState.fpCut + (1 - syncState.fpCut) * syncState.nt;
      if (syncState.nt >= 1) { syncState.fp = 1; syncState.nh = 0; syncState.nt = 0; syncState.phase = "wait"; }
    } else if (syncState.phase === "wait") {
      // don't make a duplicate block: only advance once the node's head reaches the block we're showing
      // (a real new tip). If the head hasn't moved, hold here (filled) and wait for the next tip update.
      const cur = syncState.kHeight ? syncState.kHeight[syncState.shown] : null;
      if (cur == null || Math.floor(head) >= cur) { syncState.phase = "prune"; syncState.pruneT = 0; }
    } else if (syncState.phase === "prune") {
      syncState.pruneT += (1 / 60) / pruneDur; if (syncState.pruneT >= 1) { syncState.pruneT = 1; syncState.prunedBelow += 1; syncState.phase = "step"; syncState.sp = 0; }
    } else {
      syncState.sp += (1 / 60) / stepDur; if (syncState.sp >= 1) { syncState.shown += 1; syncState.kHeight[syncState.shown] = Math.floor(head) + 1; delete syncState.kHeight[syncState.shown - L - 6]; syncState.phase = "arrive"; syncState.fp = 0; syncState.nh = 0; syncState.nt = 0; if (syncState.pending > 0) syncState.pending -= 1; } // born: lock its height to the real head (skip-forward), drop the off-screen one
    }
  } else if (atTip) { // caught up: assemble the next block under the node, filling slowly over the ~10-min interval
    // capped below full — the candidate isn't a confirmed block; it only completes (and steps in) when the network finds it
    syncState.phase = "fill"; syncState.fp = Math.min(0.92, mineProg); syncState.nh = 1; syncState.nt = 0;
  } else { syncState.phase = "arrive"; syncState.fp = 0; syncState.nh = 0; syncState.nt = 0; }
  syncState.streams = syncState.streams || {};
  const sp = syncState.sp || 0;
  const stepEase = syncState.phase === "step" ? 1 + 2.70158 * Math.pow(sp - 1, 3) + 1.70158 * Math.pow(sp - 1, 2) : 0;
  const hs = syncState.shown + stepEase;
  const arriving = downloading && flowing && syncState.phase === "arrive";
  const filling = downloading && flowing && (syncState.phase === "fill" || syncState.phase === "topoff");
  const newestFill = (downloading || atTip) ? syncState.fp : 0; // IBD: rises with the water · mining: rises with mining progress
  const blockX = (k) => birthX - (hs - k) * spacing;
  const dispHeight = (k) => (syncState.kHeight && syncState.kHeight[k] != null) ? syncState.kHeight[k] : Math.floor(head) + 1 + (k - syncState.shown); // each block's number locked at birth → smooth, never reverts; tracks the head via skips

  // current synced block vs the block the network is mining right now (tip + 1)
  const mining = tip + 1;
  const prog = node && node.verificationprogress != null ? node.verificationprogress : (tip ? Math.min(1, head / tip) : 1);
  text(`synced #${Math.floor(head).toLocaleString()}`, r.x + 16, r.y + 34, { size: 11, weight: 600, color: "rgba(255,255,255,0.72)", baseline: "middle" });
  text(`mining #${mining.toLocaleString()}`, r.x + r.w - 16, r.y + 34, { size: 11, weight: 700, color: `rgba(${ACCENT},0.85)`, align: "right", baseline: "middle" });
  const spX = r.x + 16, spW = r.w - 32; ctx.fillStyle = "rgba(255,255,255,0.1)"; roundRect(spX, r.y + 44, spW, 6, 3); ctx.fill(); ctx.fillStyle = `rgba(${ACCENT},0.85)`; roundRect(spX, r.y + 44, Math.max(4, spW * prog), 6, 3); ctx.fill();
  // rough ETA from the block-count rate over a ~90s window (verificationprogress sits at ~99% from the
  // snapshot on, so block count is the honest basis for the 880k→tip catch-up). Steadies/“estimating…” early.
  syncState.etaHist = syncState.etaHist || [];
  const eh = syncState.etaHist, nowMs = Date.now();
  if (!eh.length || nowMs - eh[eh.length - 1].ts > 3000) eh.push({ ts: nowMs, h: Math.floor(head) });
  while (eh.length > 2 && nowMs - eh[0].ts > 90000) eh.shift();
  let etaStr = "";
  if (behind > 0 && eh.length >= 2) {
    const bps = (eh[eh.length - 1].h - eh[0].h) / Math.max(1, (eh[eh.length - 1].ts - eh[0].ts) / 1000);
    if (bps > 0.02) { const s = behind / bps; etaStr = s > 172800 ? ` · ~${(s / 86400).toFixed(1)} days left` : s > 3600 ? ` · ~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m left` : s > 90 ? ` · ~${Math.round(s / 60)} min left` : " · almost caught up"; }
    else etaStr = " · estimating time…";
  }
  text(behind > 0 ? `${(prog * 100).toFixed(1)}% · ${behind.toLocaleString()} blocks behind the tip${etaStr}` : stale ? "catching up after sleep — fetching new blocks from peers…" : "at the tip — waiting for the next block to be mined", r.x + r.w / 2, r.y + 63, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  if (behind > 0) text("Syncing uses more CPU and network as your node verifies the chain — your computer may warm up or a fan spin up. A one-time catch-up that quiets down once synced.", r.x + r.w / 2, r.y + 78, { size: 9.5, color: "rgba(255,180,80,0.6)", align: "center", baseline: "middle" });
  else drawBackgroundVerify(r); // same row, mutually exclusive: that note needs blocks-behind; this only runs at the tip

  // ---- peer arch (dome) ----
  const peers = (node && Array.isArray(node.peers)) ? node.peers : [];
  const archBaseY = r.y + (behind > 0 ? 168 : backgroundVerify() ? 190 : 152), Rx = Math.min(r.w / 2 - 48, 340), Ry = 58; // the row under the status is taken while syncing (the "warm up / fan" note) and during the assumeutxo catch-up (line + bar + the CPU/memory note) — drop the arch so the "N peers" label clears whichever is showing; the catch-up needs the most room, hence 190
  ctx.strokeStyle = `rgba(${ACCENT},0.12)`; ctx.lineWidth = 1; ctx.beginPath();
  for (let s = 0; s <= 48; s++) { const th = Math.PI * (s / 48), ax = cx + Rx * Math.cos(th), ay = archBaseY - Ry * Math.sin(th); s === 0 ? ctx.moveTo(ax, ay) : ctx.lineTo(ax, ay); }
  ctx.stroke();
  if (peers.length === 0) {
    text(nodeMode === "managed" ? "connecting to the Bitcoin network…" : "connecting to peers — waiting for your node to find some", cx, archBaseY - Ry - 8, { size: 11, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" });
  } else {
    text(`${peers.length} peers`, cx, archBaseY - Ry - 10, { size: 10, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
    const shown = Math.min(peers.length, 12);
    const maxRate = Math.max(1, ...peers.map((p) => p.rate || 0)); // busiest peer sets the scale
    syncState.peerSmooth = syncState.peerSmooth || {};
    const sm = syncState.peerSmooth;
    for (let i = 0; i < shown; i++) {
      const f = shown > 1 ? i / (shown - 1) : 0.5, th = Math.PI * (1 - f);
      const px = cx + Rx * Math.cos(th), py = archBaseY - Ry * Math.sin(th);
      const addr = peers[i].addr || ("p" + i), tgt = Math.min(1, (peers[i].rate || 0) / maxRate);
      sm[addr] = sm[addr] == null ? tgt : sm[addr] + (tgt - sm[addr]) * 0.06; // taper between 4s polls → fluid
      const intensity = Math.max(0, Math.min(1, sm[addr]));
      ctx.strokeStyle = `rgba(${ACCENT},${0.16 + 0.18 * intensity})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, nodeY); ctx.stroke();
      const gsz = 13 + Math.round(4 * intensity); // busier peers a bit bigger; idle peers stay clearly visible
      ctx.font = `700 ${gsz}px ui-monospace, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = `rgba(${ACCENT},${0.7 + 0.3 * intensity})`; ctx.fillText(CYBER[(frame + i * 9) % CYBER.length], px, py);
      // data stream peer → node: tap opens only while this peer is actually sending bytes (not just the
      // 'downloading' flag — bitcoind marks many peers in-flight). Flow speed/brightness scale with its rate,
      // so you see which peers are really feeding you and how hard.
      const active = (peers[i].rate || 0) > 15_000;
      const st = tickStream(syncState.streams, "peer:" + addr, active, 0.8 + intensity * 2.2);
      drawStream(px, py, cx, nodeY, st, 0.5 + 0.45 * intensity);
      // synced/mining: peers keep exchanging block announcements, headers and pings — a faint heartbeat
      // travelling peer → node shows data is still arriving even when no block body is downloading.
      if (behind === 0) {
        const hp = (syncState.t * 0.4 + i * 0.37) % 1;
        ctx.beginPath(); ctx.arc(px + (cx - px) * hp, py + (nodeY - py) * hp, 1.5, 0, 7);
        ctx.fillStyle = `rgba(${ACCENT},${0.12 + 0.4 * (1 - hp)})`; ctx.fill();
      }
    }
  }

  // ---- your node (centered, above the new block) ----
  if (syncFlash > 0) { ctx.save(); ctx.shadowColor = `rgba(90,235,150,${syncFlash})`; ctx.shadowBlur = 10 + 20 * syncFlash; ctx.strokeStyle = `rgba(90,235,150,${0.4 + 0.6 * syncFlash})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, nodeY, 12 + 8 * syncFlash, 0, 7); ctx.stroke(); ctx.restore(); } // new-block pulse ring
  ctx.font = "700 16px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fillText(CYBER[frame % CYBER.length], cx, nodeY);
  ctx.strokeStyle = syncFlash > 0 ? `rgba(90,235,150,${0.9})` : `rgba(${ACCENT},0.9)`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, nodeY, 12, 0, 7); ctx.stroke();
  text("your node", cx, nodeY + 20, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  if (syncFlash > 0) text(`⛏ new block #${syncFlashH.toLocaleString()} — validated & added to your chain`, cx, r.y + 36, { size: 12, weight: 700, color: `rgba(90,235,150,${Math.min(1, syncFlash * 1.6)})`, align: "center", baseline: "middle" });

  // node → new block: the stream's head/tail are driven by the fill phase machine above, so the water
  // and the block level are one system — the level only moves once the leading edge lands and tops off
  // exactly as the trailing edge lands. Glyphs land on the rising fill surface.
  {
    const dropTop = nodeY + 14, surfaceY = cy + bh / 2 - 3 - (bh - 6) * newestFill;
    const st = { head: syncState.nh, tail: syncState.nt, phase: syncState.nph };
    drawStream(cx, dropTop, cx, surfaceY, st, 0.95);
    if (syncState.phase === "fill" && flowing) { const sp2 = 2 + 1.5 * Math.abs(Math.sin(frame * 0.4)); ctx.beginPath(); ctx.arc(cx, surfaceY, sp2, 0, 7); ctx.fillStyle = "rgba(255,215,140,0.9)"; ctx.fill(); } // splash while water is landing
    else if (atTip && !reduceMotion) { const hp = (syncState.t * 0.5) % 1, py = dropTop + (surfaceY - dropTop) * hp; ctx.beginPath(); ctx.arc(cx, py, 2, 0, 7); ctx.fillStyle = `rgba(${ACCENT},${0.45 * (1 - hp)})`; ctx.fill(); } // idle "assembling" pulse: a soft dot drifts node→block so delivery never looks frozen while waiting at the tip
  }

  // ---- pruner at the far left ----
  const prX = leftExit - 2, pruning = syncState.phase === "prune";
  for (let g = 0; g < 4; g++) { const a = (pruning ? 0.6 : 0.3) + 0.4 * Math.abs(Math.sin(frame * (pruning ? 0.3 : 0.12) + g * 0.9)); ctx.font = "700 13px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = `rgba(255,150,60,${a})`; ctx.fillText(CYBER[(frame + g * 7) % CYBER.length], prX, cy - 20 + g * 13); }
  text(pruning ? "pruning ♻" : "prune ♻", prX, cy + 40, { size: 10, weight: pruning ? 700 : 400, color: `rgba(255,150,60,${pruning ? 0.95 : 0.7})`, align: "center", baseline: "middle" });

  // ---- conveyor: blocks born at center, step left, prune at far left ----
  // (No static dashed slot under the node: the conveyor's own incoming empty block slides in from the
  // right to occupy center — a second static slot here read as a duplicate empty block during the step.)
  const span = Math.ceil((birthX - leftExit) / spacing) + 4, pruneTarget = syncState.prunedBelow + 1;
  for (let k = Math.min(syncState.shown, Math.ceil(hs)); k > Math.floor(hs) - span; k--) { // ≤ shown: the train slides forward first, the new empty block appears at center after the step (no block pushing in from the right)
    const x = blockX(k);
    if (x > cx + bw || x + bw < r.x + m + bw * 0.5) continue; // cull once a block is more than half off the left edge (no clipped-glyph sliver)
    const fill = k < syncState.shown ? 1 : (k === syncState.shown ? newestFill : 0);
    // timed prune: only the leftmost block digests, and only during the prune phase; below it, already gone
    const fade = k <= syncState.prunedBelow ? 1 : (k === pruneTarget && syncState.phase === "prune" ? syncState.pruneT : 0);
    // size/tx keyed to the block's own identity (k), so its dots + MB stay constant as it moves left
    const rbAll = model.recentBlocks; const info = (rbAll && rbAll.length) ? rbAll[((k % rbAll.length) + rbAll.length) % rbAll.length] : null;
    if (fade > 0.12) for (let p = 0; p < 2; p++) { const pp = (syncState.t * 1.8 + p * 0.5 + k * 0.3) % 1, sy = cy + (p - 0.5) * 12; ctx.beginPath(); ctx.arc(x + (prX + 2 - x) * pp, sy + (cy - sy) * pp, 1.6, 0, 7); ctx.fillStyle = `rgba(255,170,80,${0.7 * (1 - pp)})`; ctx.fill(); }
    // chain link drawn only when BOTH this block and its right neighbour are full — so a link appears the
    // moment a block validates (a calm beat), never pops in at the step, and never reaches the empty next block
    const isFull = (j) => j < syncState.shown || (j === syncState.shown && newestFill >= 0.999);
    if (isFull(k) && isFull(k + 1)) { ctx.globalAlpha = 1 - fade; ctx.strokeStyle = `rgba(${ACCENT},0.6)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + bw, cy); ctx.lineTo(x + bw + gap, cy); ctx.stroke(); ctx.globalAlpha = 1; }
    drawConveyorBlock(x, cy, bw, bh, dispHeight(k), info, fill, fade, k === syncState.shown - 1 && syncState.phase !== "step"); // highlight the newest block AFTER it has stepped into the chain (not while still under the node)
  }
  text("← prune", leftExit, cy + bh / 2 + 16, { size: 10, color: "rgba(255,255,255,0.4)", baseline: "middle" });
  if (downloading) {
    const lbl = arriving ? "incoming ▾" : filling ? `filling ▾ ${Math.round(newestFill * 100)}% · ${(syncState.flow / 1e6).toFixed(1)} MB/s` : (!flowing ? "⏸ waiting for data — block held partial" : "");
    if (lbl) text(lbl, cx, cy - bh / 2 - 8, { size: 10, color: `rgba(${ACCENT},${filling ? 0.7 : 0.45})`, align: "center", baseline: "middle" });
  } else if (atTip) {
    // synced and waiting: the candidate fills by elapsed time (capped at 92%), so it can sit still for minutes.
    // Say so explicitly and pulse the label so it reads as "waiting for the next block", not "stuck".
    const pulse = reduceMotion ? 0.6 : 0.5 + 0.2 * Math.abs(Math.sin(syncState.t * 1.6));
    text(`◴ assembling · ${Math.round(newestFill * 100)}%`, cx, cy - bh / 2 - 8, { size: 10, color: `rgba(${ACCENT},${pulse})`, align: "center", baseline: "middle" }); // short: the adjacent "network mining" label sits one block-width right, so a long string overlaps it (esp. wider Windows fonts)
  }
  if (SYNC_DEBUG) text(`DBG phase=${syncState.phase} fp=${(syncState.fp||0).toFixed(2)} fill%=${Math.round(newestFill*100)} nh=${(syncState.nh||0).toFixed(2)} nt=${(syncState.nt||0).toFixed(2)} flow=${Math.round(syncState.flow/1000)}KB/s dl=${downloading} fill=${filling} shown=${Math.floor(syncState.shown)} head=${Math.floor(head)}`, r.x + 16, r.y + r.h - 4, { size: 10, color: "#0f0", baseline: "alphabetic", mono: true });

  // ---- right side: distance from my sync frontier to the block being mined scales with `behind` ----
  // Synced (behind ≈ 0): head+1 == tip+1, so the block being mined IS the center slot — they sit together.
  // During IBD: the mining block is far right, with the upcoming slots + the gap of blocks still to download.
  const my = cy - bh / 2;
  const synced = atTip; // caught up
  // mining block sits to the RIGHT of the node — adjacent when synced (no gap), far right during IBD (the gap holds the
  // blocks still to download). The block directly under the node fills like a sync, sharing the mining block's number.
  const mineX = synced ? birthX + spacing : (r.x + r.w - m - bw), mineCx = mineX + bw / 2;
  if (!synced) {
    const lastX = mineX - spacing, lastCx = lastX + bw / 2; // latest already-mined block (#tip), beside the one being mined
    let fx = birthX + spacing, fh = Math.floor(head) + 2, lastRight = birthX + bw, firstSlot = true;
    while (fx + bw <= lastX - spacing * 0.8) {
      // during a conveyor step the incoming empty block slides through this first slot — don't also draw a
      // dashed "upcoming" box here, or you briefly see two empty blocks at the same spot
      if (!(firstSlot && syncState.phase === "step")) {
        ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lastRight, cy); ctx.lineTo(fx, cy); ctx.stroke(); // neutral: future blocks aren't confirmed
        ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; roundRect(fx, my, bw, bh, 4); ctx.stroke(); ctx.setLineDash([]);
        text("#" + fh, fx + bw / 2, cy, { size: 10, color: "rgba(255,255,255,0.28)", align: "center", baseline: "middle" });
        lastRight = fx + bw;
      }
      fx += spacing; fh += 1; firstSlot = false;
    }
    text("upcoming →", birthX + spacing + 2, my - 8, { size: 10, color: "rgba(255,255,255,0.35)", baseline: "middle" });
    // dashed gap: the blocks between my synced block and the tip (what's left to download)
    ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.setLineDash([2, 5]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lastRight, cy); ctx.lineTo(lastX, cy); ctx.stroke(); ctx.setLineDash([]); // neutral gap, not confirmed-orange
    text(`⋯ ${behind.toLocaleString()} blocks to the tip ⋯`, (lastRight + lastX) / 2, cy - 11, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    // the latest already-mined block (the current tip)
    const lastInfo = (model.recentBlocks && model.recentBlocks.length) ? model.recentBlocks[model.recentBlocks.length - 1] : null;
    drawConveyorBlock(lastX, cy, bw, bh, tip, lastInfo, 1, 0);
    text("last mined", lastCx, my - 8, { size: 10, weight: 700, color: "rgba(90,210,140,0.9)", align: "center", baseline: "middle" });
    text("#" + (tip || 0).toLocaleString(), lastCx, cy + bh / 2 + 14, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    ctx.strokeStyle = `rgba(${ACCENT},0.6)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lastX + bw, cy); ctx.lineTo(mineX, cy); ctx.stroke(); // solid link: tip → tip+1
  }

  // the block the network is mining right now (#tip+1) — always shown to the RIGHT of the node. The block
  // directly under the node (the conveyor center) fills like a sync and shares this number.
  {
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(syncState.t * 2));
    const mp = node && node.mempool; // {count, bytes, rate, relay}
    const relaying = mp && mp.relay !== false && mp.count > 0; // blocksonly (localrelay false) → no tx stream, whole blocks only
    if (!synced) { ctx.fillStyle = "rgba(255,255,255,0.04)"; roundRect(mineX, my, bw, bh, 4); ctx.fill(); }
    const mcols = 7, mrows = Math.max(2, Math.floor((bh - 18) / 12)), grid = mcols * mrows;
    // the network's tip+1 is a FULL block of transactions, regardless of your node's local mempool
    const txFrac = synced ? 0.85 : mineProg;
    const txShown = Math.max(1, Math.round(grid * txFrac));
    for (let d = 0; d < txShown; d++) {
      const col = d % mcols, row = Math.floor(d / mcols);
      ctx.beginPath(); ctx.arc(mineX + 11 + col * ((bw - 22) / (mcols - 1)), my + 16 + row * 12, 1.8, 0, 7);
      ctx.fillStyle = `rgba(90,210,140,${0.35 + 0.4 * Math.abs(Math.sin(frame * 0.12 + d * 1.3))})`; ctx.fill();
    }
    // nonce search — a few churning orange glyphs over the transactions
    ctx.font = "700 11px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let c = 0; c < 4; c++) {
      const col = (frame * 2 + c * 11) % mcols, row = (frame + c * 5) % mrows;
      ctx.fillStyle = `rgba(255,180,80,${0.55 + 0.4 * Math.abs(Math.sin(frame * 0.3 + c))})`;
      ctx.fillText(CYBER[(frame + c * 7) % CYBER.length], mineX + 11 + col * ((bw - 22) / (mcols - 1)), my + 16 + row * 12);
    }
    // dashed pulsing border — "being mined by the network", the only orange block
    ctx.strokeStyle = `rgba(255,150,60,${0.4 + 0.45 * pulse})`; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]); ctx.lineDashOffset = -frame * 0.4; roundRect(mineX, my, bw, bh, 4); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    text(`⛏ network mining · ~${Math.round(mineProg * 100)}%`, mineCx, my - 8, { size: 10, weight: 700, color: "rgba(255,150,60,0.9)", align: "center", baseline: "middle" });
    text("#" + ((tip || 0) + 1).toLocaleString() + " · all miners", mineCx, cy + bh / 2 + 14, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    // readout: a relaying node shows its mempool filling; a blocksonly node receives whole blocks, no tx stream
    if (synced) {
      const note = relaying ? `mempool ${mp.count.toLocaleString()} tx${mp.rate > 0 ? ` · +${mp.rate}/s` : ""}` : "blocksonly · receives whole blocks";
      text(note, mineCx, cy + bh / 2 + 26, { size: 10, color: relaying ? "rgba(90,210,140,0.85)" : "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
    }
    // (no node → mining-block stream: your node doesn't fill the block being mined — the network does,
    //  and your node receives the found block FROM peers. The peer heartbeats above show that inflow.)
  }

  // ---- disk (concise) ----
  let used;
  if (node && node.size_on_disk != null) used = node.size_on_disk / 1e9;
  else { syncState.disk += downloading ? 0.02 : -0.012; syncState.disk = Math.max(9, Math.min(16, syncState.disk)); used = syncState.disk; }
  const dbX = r.x + 16, dbW = r.w - 32, dbY = r.y + r.h - 24, dbH = 9, sMin = node ? 0 : 7, sMax = node ? Math.max(20, used * 1.25) : 17;
  ctx.fillStyle = "rgba(255,255,255,0.08)"; roundRect(dbX, dbY, dbW, dbH, 5); ctx.fill();
  ctx.fillStyle = "rgba(70,205,125,0.9)"; roundRect(dbX, dbY, Math.max(6, dbW * ((used - sMin) / (sMax - sMin))), dbH, 5); ctx.fill();
  text(`disk ~${used.toFixed(1)} GB`, dbX, dbY - 7, { size: 10, weight: 600, color: "rgba(70,210,130,0.95)", baseline: "middle" });

  // live state for the headless probe (scripts/probe.mjs) — cheap object, no canvas effect
  window.__sync = {
    version: VERSION, hasNode: !!node, tip, head: Math.floor(head), behind,
    phase: syncState.phase, fp: +(syncState.fp || 0).toFixed(3), fillPct: Math.round(newestFill * 100),
    flowKBs: Math.round(syncState.flow / 1000), fillPerSec: +fillPerSec.toFixed(3),
    downloading, arriving, filling, flowing, minedAnim, pending: syncState.pending || 0, nh: +(syncState.nh || 0).toFixed(2), nt: +(syncState.nt || 0).toFixed(2),
    shown: Math.floor(syncState.shown), prunedBelow: syncState.prunedBelow,
    pruneT: +(syncState.pruneT || 0).toFixed(2), peers: peersAll.length, sumRateKBs: Math.round(sumRate / 1000),
    block: { x: Math.round(birthX), y: Math.round(cy - bh / 2), w: bw, h: bh }, nodeY: Math.round(nodeY),
  };
}

function sparkline(rect, values, color) {
  if (!values || values.length < 2) { text("collecting…", rect.x + rect.w / 2, rect.y + rect.h / 2, { size: 13, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" }); return; }
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1, padY = 8, ph = rect.h - padY * 2, step = rect.w / (values.length - 1);
  const pts = values.map((v, i) => ({ x: rect.x + i * step, y: rect.y + rect.h - padY - ((v - min) / range) * ph }));
  ctx.beginPath(); ctx.moveTo(pts[0].x, rect.y + rect.h - padY); pts.forEach((p) => ctx.lineTo(p.x, p.y)); ctx.lineTo(pts[pts.length - 1].x, rect.y + rect.h - padY); ctx.closePath();
  ctx.fillStyle = color.replace("rgb(", "rgba(").replace(")", ",0.18)"); ctx.fill();
  ctx.beginPath(); pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
}

function drawHalvingCard(b) {
  if (!model.tipHeight) { text("…", b.x + b.w / 2, b.y + b.h / 2, { size: 13, color: "#666", align: "center", baseline: "middle" }); return; }
  const h = model.tipHeight, era = Math.floor(h / 210000), subsidy = 50 / 2 ** era, next = (era + 1) * 210000, until = next - h, prog = (h - era * 210000) / 210000;
  text(`${subsidy.toFixed(3)} BTC reward`, b.x, b.y + 12, { size: 13, weight: 600, color: `rgb(${ACCENT})` });
  text(`${until.toLocaleString()} blocks left`, b.x, b.y + 30, { size: 12, color: "rgba(255,255,255,0.55)" });
  const barY = b.y + b.h - 12;
  ctx.fillStyle = "rgba(255,255,255,0.12)"; roundRect(b.x, barY, b.w, 8, 4); ctx.fill();
  ctx.fillStyle = `rgb(${ACCENT})`; roundRect(b.x, barY, b.w * Math.min(1, prog), 8, 4); ctx.fill();
}

// the difficulty target the network must mine against, expressed as the hashrate it implies (EH/s)
function diffToEH(difficulty) { return difficulty * 4294967296 / 600 / 1e18; }

// dual-line chart: actual mining power (hashrate) vs the difficulty-implied hashrate. Whether the power
// line sits ABOVE or BELOW the difficulty line is the pending adjustment; a dashed line marks the retarget.
function drawMiningChart(b) {
  const ms = model.miningSeries, da = model.diffAdjust;
  if (!ms || !ms.hr || ms.hr.length < 2) { text("collecting…", b.x + b.w / 2, b.y + b.h / 2, { size: 12, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" }); return; }
  const hr = ms.hr, now = Date.now() / 1000;
  const curDiffV = model.difficulty ? diffToEH(model.difficulty) : (ms.diff[ms.diff.length - 1] || {}).v || hr[hr.length - 1].v;
  const diff = ms.diff && ms.diff.length ? ms.diff : [{ t: hr[0].t, v: curDiffV }];
  const retargetT = da && da.remainingTime ? now + da.remainingTime / 1000 : now;
  const t0 = hr[0].t, t1 = Math.max(now, retargetT);
  const allV = hr.map((p) => p.v).concat(diff.map((p) => p.v), [curDiffV, model.hashrateEh || 0]).filter((v) => v > 0);
  let vmin = Math.min(...allV), vmax = Math.max(...allV); const pv = (vmax - vmin) * 0.2 || vmax * 0.1; vmin -= pv; vmax += pv;
  const X = (t) => b.x + Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) * b.w, Y = (v) => b.y + b.h - (v - vmin) / (vmax - vmin) * b.h;
  const nowX = X(now), rx = X(retargetT), curHash = model.hashrateEh || hr[hr.length - 1].v, above = curHash >= curDiffV, chg = da ? da.difficultyChange || 0 : 0;

  // difficulty step line (held flat to the retarget), then a dashed projected step to the estimated new level
  const step = [[t0, diff[0].v]];
  for (let i = 0; i < diff.length; i++) { if (i > 0) step.push([diff[i].t, diff[i - 1].v]); step.push([diff[i].t, diff[i].v]); }
  step.push([retargetT, curDiffV]);
  const DIFF = "96,165,235"; // cool blue — distinct from the orange mining-power line
  ctx.strokeStyle = `rgba(${DIFF},0.95)`; ctx.lineWidth = 2; ctx.beginPath(); step.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.stroke();
  if (da) { const nv = curDiffV * (1 + chg / 100); ctx.setLineDash([4, 3]); ctx.strokeStyle = `rgba(${DIFF},0.6)`; ctx.beginPath(); ctx.moveTo(rx, Y(curDiffV)); ctx.lineTo(rx, Y(nv)); ctx.stroke(); ctx.setLineDash([]); }
  // actual mining power (hashrate)
  ctx.strokeStyle = "rgba(255,180,90,0.95)"; ctx.lineWidth = 1.6; ctx.beginPath(); hr.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v)))); ctx.stroke();
  // the gap right now = the pending adjustment
  ctx.fillStyle = above ? "rgba(90,225,140,0.3)" : "rgba(255,150,80,0.3)"; ctx.fillRect(nowX - 3, Math.min(Y(curHash), Y(curDiffV)), 6, Math.abs(Y(curHash) - Y(curDiffV)) || 1);
  // now + retarget verticals
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(nowX, b.y); ctx.lineTo(nowX, b.y + b.h); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(rx, b.y); ctx.lineTo(rx, b.y + b.h); ctx.stroke(); ctx.setLineDash([]);
  // labels — on background chips so the chart lines don't bleed through them
  chipText("● mining power", b.x + 2, b.y + 8, { size: 10, weight: 600, color: "rgba(255,180,90,0.95)" });
  chipText("● difficulty", b.x + 2, b.y + 21, { size: 10, weight: 600, color: "rgba(96,165,235,0.95)" });
  if (da) chipText(`retarget ~${(da.remainingTime / 86400000).toFixed(1)}d`, rx - 4, b.y + 8, { size: 10, color: "rgba(255,255,255,0.7)", align: "right" });
  // % badge: the projected change applies AT the retarget, so tuck it right under the "retarget ~Xd" label
  // (top-right, right-aligned to the retarget line) — fully clear of both graph lines.
  const badgeX = da ? rx - 4 : nowX - 6, badgeY = b.y + (da ? 21 : 10);
  chipText(`${above ? "▲" : "▼"} ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`, badgeX, badgeY, { size: 11, weight: 700, color: above ? "rgb(90,225,140)" : "rgb(255,150,80)", align: "right" });
}

// Plain-English "why" for the network panel: the difficulty-adjustment feedback loop — the single most
// misunderstood thing in Bitcoin (more miners ≠ faster blocks). Mechanism only, from the live retarget data.
function networkExplainer(da) {
  if (!da || da.remainingBlocks == null) return null;
  const chg = da.difficultyChange || 0, blocks = da.remainingBlocks, days = (da.remainingTime || 0) / 86400000;
  const when = `~${blocks.toLocaleString()} blocks (~${days.toFixed(1)}d)`, pct = `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`;
  if (chg > 0.5) return `Blocks came faster than 10 min → difficulty rises ${pct} in ${when}. More hashpower = higher difficulty, not faster blocks.`;
  if (chg < -0.5) return `Blocks ran slower than 10 min → difficulty eases ${pct} in ${when}, nudging them back toward the 10-min target.`;
  return `Hashpower ≈ difficulty — blocks are landing near 10 min. Next retarget ${when}, just ${pct}.`;
}
// BROADCAST — the instant you win, your block radiates out to the whole network via your node's peers AND a
// direct P2P push. A sonar wavefront shows it reaching nodes (pools labelled); your directly-connected peers
// light FIRST (instant delivery), then gossip carries it outward. On a real win it flips to a gold "BLOCK
// FOUND" burst. Badges show live readiness.
// VERIFIED UPDATES — animate the trust path: a new version → its hash → committed in a Bitcoin block → your own
// node validates that block. A pulse travels the rail, lighting each stage; the node's ✓ lands at the end.
function drawUpdates(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0;
  const ORANGE = "rgba(247,147,26,1)", GREEN = "rgba(90,220,140,1)", RED = "rgba(255,95,95,1)", DIM = "rgba(255,255,255,0.22)", INK = "rgba(255,255,255,0.82)";
  text("VERIFIED UPDATES — the app checks each update against a hash stamped in the Bitcoin blockchain, confirmed by your own node", x0, r.y + 16, { size: 12.5, weight: 700, color: "rgba(255,255,255,0.6)", baseline: "middle" });

  // real status: a downloaded update's verdict (incoming) wins; otherwise the running version's on-chain badge
  const uv = updateVerification, va = versionAnchor;
  const sv = uv && uv.level ? { level: uv.level, version: uv.version, height: uv.height, incoming: true } : (va && va.level ? { level: va.level, version: va.version, height: va.height, incoming: false } : null);
  const danger = !!(sv && sv.level === "mismatch");
  const nodeTip = model.tipHeight || (model.node && model.node.blocks) || null;
  const confsFor = (h) => (nodeTip && h && nodeTip >= h) ? (nodeTip - h + 1) : null; // confirmations once a version is anchored: chain tip − the anchor block + 1

  // ── verification as two sides meeting at Bitcoin — the app's hash is the constant everything rides on ──
  // (kept platform-neutral: "the app" reads right on mac/Windows/Linux, and sidesteps the mac dmg-vs-zip split)
  const STEPS = [
    { side: "our", ttl: "We hash the release", body: "We SHA-256 the app into one unique fingerprint — the constant everything else rides on." },
    { side: "btc", ttl: "We stamp it on Bitcoin", body: "Our fingerprint streams into a Bitcoin block via OpenTimestamps; the block slides down to be held — immutable, impossible to forge or backdate." },
    { side: "your", ttl: "You download the file", body: "You pull the app from getnotzero.com over HTTPS — but you won't have to trust it." },
    { side: "your", ttl: "You hash it yourself", body: "Your machine SHA-256s the download — producing the exact same fingerprint, if the file is genuine." },
    { side: "btc", ttl: "Your node reads it from the chain", body: "Your own node reads the stamped block straight from Bitcoin and hands YOU the hash — you check against your own node, never a hash from us. Only headers are needed, so a pruned node works." },
    { side: "match", ttl: "Compare the two → verified", body: "The hash your node read from the chain and your own local hash are the same → provably genuine, trusting no one." },
  ];
  const N = STEPS.length, cyc = UPD_CYC, tnow = Date.now(), dph = (tnow % 2400) / 2400;
  const idx = danger ? N - 1 : updPaused ? Math.max(0, Math.min(N - 1, updStep)) : reduceMotion ? N - 1 : updAutoStep(tnow);
  const sub = danger || updPaused || reduceMotion ? 1 : updAutoSub(tnow);
  const blockNum = (versionAnchor && versionAnchor.height) || (sv && sv.height) || (model.node && model.node.blocks) || null;

  { // transport: ‹ step-back · play/pause · step-fwd › (top-right, like THE CHURN)
    const bh = 18, bwd = 24, gp = 4, byy = r.y + 3, s = 4.5, b3 = x1 - bwd, b2 = b3 - bwd - gp, b1 = b2 - bwd - gp, cyy = byy + bh / 2, GI = "rgba(255,228,140,0.98)";
    const box = (bx, on) => { ctx.fillStyle = on ? "rgba(255,215,90,0.28)" : "rgba(255,255,255,0.09)"; roundRect(bx, byy, bwd, bh, 4); ctx.fill(); ctx.strokeStyle = "rgba(255,215,90,0.5)"; ctx.lineWidth = 1; roundRect(bx, byy, bwd, bh, 4); ctx.stroke(); };
    box(b1, false); ctx.fillStyle = GI; { const c = b1 + bwd / 2; ctx.beginPath(); ctx.moveTo(c + s - 1, cyy - s); ctx.lineTo(c + s - 1, cyy + s); ctx.lineTo(c - 2, cyy); ctx.closePath(); ctx.fill(); ctx.fillRect(c - s - 1, cyy - s, 2, 2 * s); }
    box(b2, updPaused); ctx.fillStyle = GI; { const c = b2 + bwd / 2; if (updPaused) { ctx.beginPath(); ctx.moveTo(c - s + 1, cyy - s); ctx.lineTo(c - s + 1, cyy + s); ctx.lineTo(c + s + 1, cyy); ctx.closePath(); ctx.fill(); } else { ctx.fillRect(c - 3, cyy - s, 2, 2 * s); ctx.fillRect(c + 1.2, cyy - s, 2, 2 * s); } }
    box(b3, false); ctx.fillStyle = GI; { const c = b3 + bwd / 2; ctx.beginPath(); ctx.moveTo(c - s + 1, cyy - s); ctx.lineTo(c - s + 1, cyy + s); ctx.lineTo(c + 2, cyy); ctx.closePath(); ctx.fill(); ctx.fillRect(c + s - 1, cyy - s, 2, 2 * s); }
    updBackHit = { x: b1, y: byy, w: bwd, h: bh }; updPlayHit = { x: b2, y: byy, w: bwd, h: bh }; updFwdHit = { x: b3, y: byy, w: bwd, h: bh };
  }

  // ── two sides meeting at the LIVING chain (sync-style) ── miners mine the tip; finished blocks slide left; when WE
  // stamp, our block drops down a row carrying our app's hash; YOUR SIDE re-derives the same hash and your node reaches
  // into that block to verify. Hashes use the matrix effect (hex settling out of a scramble). The app's hash is the constant.
  const BLU = "rgba(150,220,255,1)", GLD = "rgba(255,225,120,1)", DIMB = "rgba(150,220,255,0.4)", HEX = "0123456789abcdef";
  const mhash = (cx, cy, seed, scr, col, wc) => { wc = wc || 54; const n = 8, cw = wc / n, settled = Math.round((1 - Math.max(0, Math.min(1, scr))) * n);
    ctx.save(); ctx.font = "700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let i = 0; i < n; i++) { const set = i < settled; let h = Math.imul(((set ? (seed | 0) * 9 : Math.floor(tnow / 45) * 7 + seed) + i + 1) | 0, 0x45d9f3b) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0; const ch = HEX[(h ^ (h >>> 13)) & 15]; ctx.fillStyle = set ? col : "rgba(120,255,150,0.6)"; ctx.fillText(ch, cx - wc / 2 + i * cw + cw / 2, cy); }
    ctx.restore(); };
  const line = (ax, ay, bx, by, on, col, dash) => { ctx.strokeStyle = `rgba(${col},${on ? 0.85 : 0.13})`; ctx.lineWidth = on ? 1.7 : 1; if (dash) ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]); };
  const dmgBox = (cx, lbl, lit) => { ctx.fillStyle = lit ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)"; roundRect(cx - 30, yDmg - 9, 60, 18, 2); ctx.fill(); ctx.strokeStyle = lit ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.22)"; ctx.lineWidth = 1.1; roundRect(cx - 30, yDmg - 9, 60, 18, 2); ctx.stroke(); text(lbl, cx, yDmg, { size: 8, weight: 600, color: lit ? INK : "rgba(255,255,255,0.45)", align: "center", baseline: "middle" }); };
  const hashCell = (cx, cy, seed, scr, col, box) => { ctx.fillStyle = "rgba(255,255,255,0.05)"; roundRect(cx - 30, cy - 8, 60, 16, 3); ctx.fill(); ctx.strokeStyle = box; ctx.lineWidth = 1.1; roundRect(cx - 30, cy - 8, 60, 16, 3); ctx.stroke(); mhash(cx, cy, seed, scr, col, 54); };
  // a flowing hash-DATA STREAM — water-in-a-pipe (same as the node sync): the tap opens → the leading edge travels
  // A→B and the pipe fills; the tap closes → the trailing edge drains out. `key` gives each its own head/tail/scroll.
  const stream = (ax, ay, bx, by, on, key) => { const st = tickStream(updStreams, key, on && !reduceMotion, 1.6); drawStream(ax, ay, bx, by, st, 1); };
  const lx = x0 + w * 0.13, gx = x0 + w * 0.5, rx = x0 + w * 0.87, xc = x0 + w * 0.5, convY = r.y + 62, nodeY = r.y + 100, ourY = r.y + 100, yHash = r.y + 172, yDmg = r.y + 208; // train below the subtitle; YOUR NODE above your side; roomy rows
  const ourLit = idx <= 1, yourLit = idx >= 3, btcLit = idx === 1 || idx === 4, matchLit = idx === 5, ySeed = danger ? 777 : 500, yourShown = idx >= 3;

  // ── top row: the mining conveyor. It PAUSES during the stamp (step 2); afterwards it resumes, carrying our now-orange block along ──
  const blink4 = (p) => Math.floor(p * 8) % 2 === 0, aboveY = yHash - 36;
  text("⛓ BITCOIN BLOCKCHAIN — mined at the right, slides left" + (idx === 1 ? " · PAUSED — stamping" : ""), x0, r.y + 38, { size: 9, weight: 700, color: btcLit ? ORANGE : "rgba(255,255,255,0.6)", baseline: "middle" });
  const cbw = 56, cgp = 14, cstep = cbw + cgp, headX = x1 - cbw - 78, cycT = 2400; // blocks sized to match the copied/stored block; headX leaves room for the miner box
  const cycleStart = Math.floor(tnow / cyc) * cyc, stampT = cycleStart + UPD_DUR[0], s2End = stampT + UPD_DUR[1], convT = idx === 1 ? stampT : (tnow >= s2End ? tnow - UPD_DUR[1] : tnow); // freeze the train during step 2, resume after
  const gen = Math.floor(convT / cycT), cp = (convT % cycT) / cycT, nCenter = Math.round((headX - xc) / cstep), ourGen = Math.floor(stampT / cycT) - nCenter, trainShift = (xc - cbw / 2) - (headX - nCenter * cstep); // align our block's CENTRE to xc (bx is its left edge) so the stored block lands right under it
  const slideP = idx === 1 ? 0 : (cp < 0.18 ? (1 - Math.pow(1 - cp / 0.18, 3)) : 1); // a new block completes → the chain SNAPS left one notch (start of the cycle), then holds while the miner fills the next
  ctx.save(); ctx.beginPath(); ctx.rect(x0, convY - 13, w, 26); ctx.clip();
  for (let n = -1; n < 32; n++) { const j = gen - n, bx = headX - (n + slideP) * cstep + trainShift; if (bx < x0 - cbw) break; if (bx - cgp > x1) continue;
    // our block first HASHES (matrix scramble→settle to our hash, still neutral) after the stream has reached it, and only THEN turns orange
    const isTarget = idx === 1 && j === ourGen, isOurs = (idx > 1 && j === ourGen) || (isTarget && sub >= 0.4), nowOrange = isOurs && (idx > 1 || sub >= 0.64);
    const scr = isTarget ? Math.max(0, 1 - (sub - 0.4) / 0.2) : 0, mining = false; // chain blocks are settled history; all mining happens in the miner box at the tip
    ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(bx - cgp, convY); ctx.lineTo(bx, convY); ctx.stroke();
    ctx.fillStyle = nowOrange ? "rgba(247,147,26,0.18)" : isOurs ? "rgba(235,245,255,0.08)" : mining ? "rgba(120,255,150,0.07)" : "rgba(255,255,255,0.03)"; roundRect(bx, convY - 10, cbw, 20, 3); ctx.fill();
    ctx.strokeStyle = nowOrange ? ORANGE : isOurs ? "rgba(235,245,255,0.8)" : mining ? "rgba(120,255,150,0.5)" : "rgba(255,255,255,0.2)"; ctx.lineWidth = (nowOrange || isOurs) ? 1.5 : 1; roundRect(bx, convY - 10, cbw, 20, 3); ctx.stroke();
    mhash(bx + cbw / 2, convY, isOurs ? 500 : j, scr, nowOrange ? GLD : isOurs ? "rgba(235,245,255,0.95)" : "rgba(180,255,200,0.85)", cbw - 10); }
  ctx.restore();
  // ── the miners: a block-sized box at the tip where the next block is mined. Cycle: the chain snaps left, this box
  //    goes EMPTY, then the hash FILLS IN (settles left-to-right); when full it becomes the next block to slide in. ──
  { const mbx = headX + cstep + trainShift, fillP = idx === 1 ? 1 : (cp < 0.28 ? 0 : Math.min(1, (cp - 0.28) / 0.62)); // empty just after the slide, then fills
    ctx.strokeStyle = "rgba(120,255,150,0.3)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mbx - cgp, convY); ctx.lineTo(mbx, convY); ctx.stroke(); // link feeding the train
    ctx.fillStyle = "rgba(120,255,150,0.08)"; roundRect(mbx, convY - 10, cbw, 20, 3); ctx.fill(); ctx.strokeStyle = "rgba(120,255,150,0.6)"; ctx.lineWidth = 1.3; roundRect(mbx, convY - 10, cbw, 20, 3); ctx.stroke();
    if (fillP > 0) mhash(mbx + cbw / 2, convY, gen + 1, 1 - fillP, "rgba(140,255,170,0.95)", cbw - 10); // empty box until fill starts, then hash settles in left-to-right
    text("⛏ miners", mbx + cbw / 2, convY + 31, { size: 8.5, weight: 700, color: "rgba(120,255,150,0.85)", align: "center", baseline: "middle" }); }

  // ── the STORED block (row below, directly under our orange chain block): once the stream reaches the block, the
  //    stored copy is HASHED/BUILT in place here (matrix settling to the same hash), then blinks. It stays as our reference. ──
  const storedShow = idx >= 2 || (idx === 1 && sub >= 0.64); let storedScr = 0, storedA = 1; // only after the chain block has hashed + turned orange
  if (idx === 1) { storedScr = Math.max(0, 1 - (sub - 0.64) / 0.16); if (updPaused || sub > 0.84) storedA = blink4(dph) ? 1 : 0.26; }
  if (storedShow) { ctx.globalAlpha = storedA;
    ctx.fillStyle = "rgba(247,147,26,0.14)"; roundRect(xc - 28, ourY - 10, 56, 20, 3); ctx.fill(); ctx.strokeStyle = ORANGE; ctx.lineWidth = 1.5; roundRect(xc - 28, ourY - 10, 56, 20, 3); ctx.stroke();
    mhash(xc, ourY, 500, storedScr, GLD, 46); ctx.globalAlpha = 1;
    if (idx >= 2) { const acf = Math.max(1, gen - Math.floor(stampT / cycT) + 1); // illustrative: each new block sliding in on top adds a confirmation (ticks up as the train advances, resets each loop)
      text("🔒 locked in a block · " + acf + (acf === 1 ? " confirmation" : " confirmations"), xc, ourY + 18, { size: 8, weight: 700, color: "rgba(247,147,26,0.82)", align: "center", baseline: "middle" }); } }
  else if (idx === 0) { ctx.setLineDash([3, 2]); ctx.strokeStyle = "rgba(247,147,26,0.4)"; ctx.lineWidth = 1; roundRect(xc - 28, ourY - 10, 56, 20, 3); ctx.stroke(); ctx.setLineDash([]); }

  // ── YOUR NODE (top of your side) — it reads the stamped block straight from the chain; the hash you check is
  //    DOWNLOADED FROM YOUR OWN NODE (not a hash we hand you). ──
  { const on = idx === 4 || idx === 5; ctx.fillStyle = on ? "rgba(90,220,140,0.1)" : "rgba(255,255,255,0.02)"; roundRect(rx - 33, nodeY - 14, 66, 28, 4); ctx.fill(); ctx.strokeStyle = on ? "rgba(90,220,140,0.7)" : "rgba(255,255,255,0.22)"; ctx.lineWidth = on ? 1.4 : 1; roundRect(rx - 33, nodeY - 14, 66, 28, 4); ctx.stroke();
    text("🖥 your node", rx, nodeY - 4, { size: 8.5, weight: 700, color: on ? GREEN : "rgba(255,255,255,0.5)", align: "center", baseline: "middle" }); text("reads the chain", rx, nodeY + 7, { size: 7.5, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" }); }

  // the hash your node HANDS YOU — after it has read the block from the chain (step 5) it materialises below the node
  const built = idx === 4 ? Math.max(0, Math.min(1, (sub - 0.5) / 0.32)) : idx >= 5 ? 1 : 0;
  if (built > 0.02) { ctx.globalAlpha = built; const on6 = idx === 5 ? (blink4(dph) ? 1 : 0.26) : 1; ctx.globalAlpha = built * on6;
    ctx.fillStyle = "rgba(247,147,26,0.13)"; roundRect(rx - 28, aboveY - 10, 56, 20, 3); ctx.fill(); ctx.strokeStyle = idx >= 4 ? ORANGE : "rgba(247,147,26,0.7)"; ctx.lineWidth = 1.5; roundRect(rx - 28, aboveY - 10, 56, 20, 3); ctx.stroke();
    mhash(rx, aboveY, 500, idx === 4 ? Math.max(0, 1 - (sub - 0.5) / 0.32) : 0, GLD, 46); ctx.globalAlpha = 1;
    if (idx === 4) text("↓ from your node", rx, aboveY + 18, { size: 7.5, weight: 600, color: "rgba(90,220,140,0.8)", align: "center", baseline: "middle" }); }

  // data streams — step 2: our hash → the Bitcoin block (OpenTimestamps) · step 5: the chain → your node (it reads the block), then it hands you the hash
  stream(lx + 8, yHash - 8, xc - 22, convY + 8, idx === 1 && sub < 0.3, "upd:submit");
  stream(xc + 28, ourY, rx - 30, nodeY, idx === 4 && sub < 0.5, "upd:noderead");
  if (idx === 1) text("→ streaming into the Bitcoin block via OpenTimestamps", xc - 34, (yHash + convY) / 2 + 14, { size: 8, weight: 600, color: "rgba(255,225,150,0.9)", align: "center", baseline: "middle" });
  if (idx === 4) text("your node reads the block from the chain →", (xc + rx) / 2 + 4, nodeY - 17, { size: 8, weight: 600, color: "rgba(90,220,140,0.9)", align: "center", baseline: "middle" });

  // step 6: compare the hash your node handed you (above) with your own local hash (below) — blink together, then verdict
  if (idx === 5) { const on = blink4(dph); ctx.strokeStyle = `rgba(${danger ? "255,95,95" : "90,220,140"},${on ? 0.95 : 0.3})`; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(rx - 12, (aboveY + yHash) / 2); ctx.lineTo(rx + 12, (aboveY + yHash) / 2); ctx.stroke();
    text("=", rx, (aboveY + yHash) / 2, { size: 11, weight: 800, color: `rgba(${danger ? "255,95,95" : "90,220,140"},${on ? 1 : 0.4})`, align: "center", baseline: "middle" });
    text(danger ? "✗ mismatch — rejected" : (sub > 0.5 ? "✓ match — verified" : "comparing…"), rx + 44, (aboveY + yHash) / 2, { size: 9, weight: 800, color: danger ? RED : GREEN, baseline: "middle" }); }

  // OUR SIDE (left) — we hash the app; the fingerprint BUILDS up (matrix) into an orange block, exactly like the stored block
  { const bscr = idx === 0 ? Math.max(0, 1 - (sub - 0.12) / 0.5) : 0; ctx.globalAlpha = ourLit ? 1 : 0.45;
    ctx.fillStyle = "rgba(247,147,26,0.14)"; roundRect(lx - 28, yHash - 10, 56, 20, 3); ctx.fill(); ctx.strokeStyle = ourLit ? ORANGE : "rgba(247,147,26,0.5)"; ctx.lineWidth = 1.5; roundRect(lx - 28, yHash - 10, 56, 20, 3); ctx.stroke();
    mhash(lx, yHash, 500, bscr, GLD, 46); ctx.globalAlpha = 1; }
  text("↑ SHA-256", lx, r.y + 190, { size: 8.5, weight: 700, color: ourLit ? "rgba(247,147,26,0.9)" : "rgba(255,255,255,0.35)", align: "center", baseline: "middle" });
  dmgBox(lx, "📦 our app", ourLit); text("☁ OUR SIDE — build + stamp", lx, r.y + 234, { size: 9, weight: 700, color: ourLit ? "rgba(247,147,26,0.9)" : "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });

  // getnotzero.com (center) — the web server: we publish here, you download from here
  { const on = idx === 2 || idx === 3; ctx.fillStyle = on ? "rgba(150,220,255,0.08)" : "rgba(255,255,255,0.02)"; roundRect(gx - 62, yDmg - 15, 124, 30, 5); ctx.fill(); ctx.strokeStyle = on ? BLU : "rgba(255,255,255,0.2)"; ctx.lineWidth = on ? 1.4 : 1; roundRect(gx - 62, yDmg - 15, 124, 30, 5); ctx.stroke();
    text("☁ getnotzero.com", gx, yDmg - 4, { size: 8.5, weight: 700, color: on ? BLU : "rgba(255,255,255,0.55)", align: "center", baseline: "middle" }); text("the app · SHA256SUMS · proof", gx, yDmg + 8, { size: 7.5, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    text("WEB SERVER", gx, r.y + 234, { size: 9, weight: 700, color: on ? BLU : "rgba(255,255,255,0.4)", align: "center", baseline: "middle" }); }
  stream(lx + 32, yDmg, gx - 64, yDmg, idx === 1 && sub < 0.3, "upd:publish");
  stream(gx + 64, yDmg, rx - 32, yDmg, idx === 2 && sub < 0.62, "upd:download");
  if (idx === 1) text("we also publish it →", (lx + gx) / 2, yDmg - 10, { size: 8, color: "rgba(150,220,255,0.85)", align: "center", baseline: "middle" });
  if (idx === 2) text("you download →", (gx + rx) / 2, yDmg - 10, { size: 8, weight: 600, color: "rgba(150,220,255,0.9)", align: "center", baseline: "middle" });

  // YOUR SIDE (right) — download, then hash it yourself (matrix settles)
  if (yourShown) { if (idx === 5) ctx.globalAlpha = blink4(dph) ? 1 : 0.26; hashCell(rx, yHash, ySeed, idx === 3 ? Math.max(0, 1 - sub * 1.4) : 0, yourLit ? (danger ? "rgba(255,110,110,1)" : BLU) : DIMB, yourLit ? (danger ? "rgba(255,95,95,0.7)" : "rgba(150,220,255,0.7)") : "rgba(255,255,255,0.18)"); ctx.globalAlpha = 1; }
  else { ctx.setLineDash([3, 2]); ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; roundRect(rx - 34, yHash - 9, 68, 18, 3); ctx.stroke(); ctx.setLineDash([]); text("— not yet —", rx, yHash, { size: 8, color: "rgba(255,255,255,0.32)", align: "center", baseline: "middle" }); }
  text("↑ SHA-256", rx, r.y + 190, { size: 8.5, weight: 700, color: yourLit ? BLU : "rgba(255,255,255,0.35)", align: "center", baseline: "middle" });
  dmgBox(rx, "📦 your app", idx >= 2); text("🖥 YOUR SIDE — download + check", rx, r.y + 234, { size: 9, weight: 700, color: yourLit ? (danger ? RED : GREEN) : "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });

  // the educational line for the current step
  const st = STEPS[idx], fail6 = danger && idx === N - 1;
  text("STEP " + (idx + 1) + " / " + N + (updPaused ? "  · paused" : ""), x0, r.y + 260, { size: 9, weight: 700, color: fail6 ? RED : "rgba(90,220,140,0.9)", baseline: "middle" });
  text(fail6 ? "Rejected" : st.ttl, x0 + (updPaused ? 108 : 62), r.y + 260, { size: 10.5, weight: 700, color: fail6 ? RED : INK, baseline: "middle" });
  text(fail6 ? "Your fingerprint did NOT match the one stamped on-chain — the download is rejected and never installed." : st.body, x0, r.y + 278, { size: 10, color: "rgba(255,255,255,0.64)", baseline: "middle" });

  // real-status strip — the current/incoming verdict, as a headline above the release history
  if (sv) {
    const who = sv.incoming ? "v" + sv.version + " ready" : "you're on v" + sv.version, whoP = sv.incoming ? "v" + sv.version : "you're on v" + sv.version;
    const M = {
      onchain:    { c: "90,220,140", ic: "✓", t: who + " · verified on-chain" + (sv.height ? " — Bitcoin block " + sv.height.toLocaleString() + (confsFor(sv.height) ? " · " + confsFor(sv.height).toLocaleString() + " confirmations" : "") : "") },
      pending:    { c: "247,190,60", ic: "◷", t: who + " · installed & verified — its Bitcoin timestamp is still confirming (~a few hrs)" },
      checksums:  { c: "120,210,255", ic: "✓", t: who + " · checksums verified" },
      mismatch:   { c: "255,95,95", ic: "⚠", t: "v" + sv.version + " failed verification — not installed" },
      unverified: { c: "255,255,255", ic: "·", t: whoP + " · verification not available yet" },
      unchecked:  { c: "255,255,255", ic: "·", t: whoP + " · on-chain check unavailable (node offline?)" },
    }[sv.level];
    if (M) {
      const by = r.y + 304, bh = 22;
      ctx.fillStyle = `rgba(${M.c},0.1)`; roundRect(x0, by, w, bh, 6); ctx.fill();
      ctx.strokeStyle = `rgba(${M.c},0.5)`; ctx.lineWidth = 1; roundRect(x0, by, w, bh, 6); ctx.stroke();
      text(M.ic + "   " + M.t, x0 + 12, by + bh / 2 + 0.5, { size: 11, weight: 700, color: `rgba(${M.c},1)`, baseline: "middle" });
    }
  }

  // VERIFIED RELEASES — the history, each re-confirmed against your node (newest first)
  const hy = r.y + (sv ? 336 : 322);
  text("VERIFIED RELEASES", x0, hy, { size: 9, weight: 700, color: "rgba(255,255,255,0.4)", baseline: "middle" });
  text("· each re-confirmed against your own node", x0 + 118, hy, { size: 9, color: "rgba(255,255,255,0.3)", baseline: "middle" });
  const LM = {
    onchain:  { c: "90,220,140", ic: "✓", t: (h) => "verified on-chain · block " + (h.height ? h.height.toLocaleString() : "?") + (confsFor(h.height) ? " · " + confsFor(h.height).toLocaleString() + " confs" : "") },
    anchored: { c: "90,220,140", ic: "✓", t: (h) => "anchored on-chain · block " + (h.height ? h.height.toLocaleString() : "?") + (confsFor(h.height) ? " · " + confsFor(h.height).toLocaleString() + " confs" : "") },
    pending:  { c: "247,190,60", ic: "◷", t: () => "installed & verified · Bitcoin timestamp confirming" },
    mismatch: { c: "255,95,95", ic: "⚠", t: () => "verification failed" },
    none:     { c: "255,255,255", ic: "·", t: () => "released before on-chain anchoring" },
    unchecked:{ c: "255,255,255", ic: "·", t: () => "not checked — node offline?" },
  };
  let ry = hy + 18;
  if (updateHistory && updateHistory.length) {
    updateHistory.slice(0, 4).forEach((h) => {
      const m = LM[h.level] || LM.unchecked, faint = h.level === "none" || h.level === "unchecked";
      text("v" + h.version, x0 + 4, ry, { size: 10.5, weight: 700, color: h.current ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.66)", baseline: "middle", mono: true });
      text(m.ic + "  " + m.t(h), x0 + 78, ry, { size: 10, weight: 600, color: `rgba(${m.c},${faint ? 0.5 : 0.95})`, baseline: "middle" });
      if (h.current) text("◀ running now", x1 - 4, ry, { size: 9, weight: 700, color: "rgba(247,147,26,0.95)", align: "right", baseline: "middle" });
      ry += 15;
    });
  } else if (isDesktop && updateHistory === null) {
    // desktop, still fetching + confirming after launch/update — say so plainly, so an empty list never reads as "nothing verified"
    text("Checking recent releases against your node…", x0 + 4, ry, { size: 10.5, weight: 700, color: "rgba(247,190,60,0.95)", baseline: "middle" });
    text("This takes a moment after an update — each release is re-confirmed on-chain, then listed here.", x0 + 4, ry + 16, { size: 9.5, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  } else {
    text("In the app, every release you run is listed here — each re-confirmed against your own node.", x0 + 4, ry, { size: 10, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  }
  text("Only block headers are needed, so your pruned node re-checks every release — the one moment of risk is your first download.", x0, r.y + 434, { size: 10, weight: 600, color: "rgba(90,220,140,0.9)", baseline: "middle" });
}

function drawBroadcast(r) {
  const x0 = r.x + 16, x1 = r.x + r.w - 16, now = Date.now(), GRN = "90,225,140", GLD = "255,205,110";
  const burst = now < broadcastBurstUntil; // a win just landed → intense broadcast burst
  const C = burst ? GLD : GRN;
  text("BROADCAST — the instant you win, your block hits the whole network", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  if (burst) text("★ BLOCK FOUND — BROADCASTING", x1, r.y + 16, { size: 12, weight: 800, color: `rgba(${GLD},${0.7 + 0.3 * Math.sin(now / 120)})`, align: "right", baseline: "middle" });
  text("It goes out two ways at once: through your node to its peers, and a direct P2P push to well-connected nodes. The big miners see it in ~1–2s and start building on top.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });

  const n = model.node, reachable = !!(n && n.reachable !== false);
  const syncing = reachable && (n.initialblockdownload || (n.headers || 0) > (n.blocks || 0));
  const nodeReady = reachable && !syncing;
  const peerCount = (n && Array.isArray(n.peers)) ? n.peers.length : 0;

  const mx = x0 + 80, my = r.y + 118, RB = 22;
  const fx0 = mx + 78, fx1 = x1 - 14, fy0 = r.y + 56, fy1 = r.y + r.h - 54;
  const NN = 46, poolNames = { 4: "Foundry USA", 13: "AntPool", 22: "F2Pool", 33: "ViaBTC", 41: "MARA" };
  const nodes = []; let maxD = 1;
  for (let i = 0; i < NN; i++) {
    const nx = fx0 + hrand(i * 1.73 + 0.2) * (fx1 - fx0), ny = fy0 + hrand(i * 2.91 + 0.7) * (fy1 - fy0), d = Math.hypot(nx - mx, ny - my);
    if (d > maxD) maxD = d;
    nodes.push({ nx, ny, d, pool: poolNames[i] });
  }
  // your directly-connected peers = the nearest nodes; they get the block FIRST (direct), the rest via gossip
  const nPeers = Math.max(6, Math.min(peerCount || 10, 16));
  nodes.slice().sort((a, b) => a.d - b.d).forEach((nd, rank) => { nd.isPeer = rank < nPeers; });

  const PERIOD = 2600, t = reduceMotion ? 0.72 : (now % PERIOD) / PERIOD, R = t * maxD * 1.15;
  const peerFlash = t < 0.22 && !reduceMotion; // the direct-delivery flash at the start of each broadcast

  // links to your peers — always connected (dim), flashing bright at each broadcast
  nodes.forEach((nd) => {
    if (!nd.isPeer) return;
    ctx.strokeStyle = `rgba(${C},${peerFlash ? (burst ? 0.6 : 0.42) : 0.16})`; ctx.lineWidth = peerFlash && burst ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(nd.nx, nd.ny); ctx.stroke();
  });

  // the sonar wavefront — the same gentle ping whether idle (green) or a win (gold), just recoloured
  if (!reduceMotion) { ctx.strokeStyle = `rgba(${C},${0.28 * (1 - t)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx, my, R, 0, 7); ctx.stroke(); }

  nodes.forEach((nd) => {
    const lit = nd.isPeer ? true : nd.d <= R;                       // peers are always connected; others light as the wave passes
    const fresh = nd.isPeer ? peerFlash : (lit && nd.d > R - 42);
    ctx.fillStyle = nd.isPeer ? `rgba(${C},${fresh ? 1 : 0.5})` : (lit ? `rgba(${C},${fresh ? 1 : 0.72})` : "rgba(255,255,255,0.22)");
    ctx.beginPath(); ctx.arc(nd.nx, nd.ny, nd.pool ? 4.5 : 2.6, 0, 7); ctx.fill();
    if (fresh) { ctx.strokeStyle = `rgba(${C},0.5)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(nd.nx, nd.ny, 6.5, 0, 7); ctx.stroke(); }
    if (nd.pool) text(nd.pool, nd.nx, nd.ny + 12, { size: 8, weight: 600, color: lit ? `rgba(${C},0.9)` : "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
  });

  // the miner (you) at the hub
  const hub = burst ? "255,205,110" : "247,147,26";
  ctx.fillStyle = `rgba(${hub},0.16)`; roundRect(mx - RB, my - RB, RB * 2, RB * 2, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${hub},0.9)`; ctx.lineWidth = 1.5; roundRect(mx - RB, my - RB, RB * 2, RB * 2, 8); ctx.stroke();
  text("₿", mx, my, { size: 20, weight: 800, color: `rgba(${hub},1)`, align: "center", baseline: "middle" });
  text("YOU", mx, my + RB + 10, { size: 9, weight: 700, color: "rgba(255,255,255,0.6)", align: "center", baseline: "middle" });
  text("① your node → its peers", mx + RB + 8, my - 9, { size: 9, weight: 600, color: `rgba(${C},0.85)`, baseline: "middle" });
  text("② direct P2P → nodes", mx + RB + 8, my + 9, { size: 9, weight: 600, color: `rgba(${C},0.85)`, baseline: "middle" });

  // readiness badges
  const badge = (bx, ok, label, sub) => {
    const c = ok ? GRN : GLD, by = r.y + r.h - 30;
    ctx.fillStyle = `rgba(${c},0.12)`; roundRect(bx, by, 248, 20, 5); ctx.fill();
    ctx.strokeStyle = `rgba(${c},0.7)`; ctx.lineWidth = 1; roundRect(bx, by, 248, 20, 5); ctx.stroke();
    text(`${ok ? "✓" : "…"} ${label}`, bx + 10, by + 10, { size: 10, weight: 700, color: `rgba(${c},1)`, baseline: "middle" });
    text(sub, bx + 238, by + 10, { size: 9, color: "rgba(255,255,255,0.5)", align: "right", baseline: "middle" });
  };
  badge(x0, nodeReady, nodeReady ? "Your node: ready" : reachable ? "Your node: syncing" : nodeMode === "managed" ? "Your node: starting" : "Your node: offline", peerCount ? `${peerCount} peers` : "relays your block");
  badge(x0 + 258, true, "Direct P2P: armed", "~25 nodes on standby");
  text(burst ? "★ Block found — broadcasting to your peers and the wider network right now." : (nodeReady ? "If you win right now, your block goes out instantly — both paths, no manual step." : "Even while your node syncs, the direct P2P path is armed — a win still gets broadcast."),
    x0 + 520, r.y + r.h - 20, { size: 10, weight: 600, color: burst ? `rgba(${GLD},1)` : (nodeReady ? `rgba(${GRN},0.9)` : `rgba(${GLD},0.9)`), baseline: "middle" });
}

function drawNetwork(r) {
  let y = r.y + 16;
  if (model.difficulty) {
    const hr = model.hashrateEh ? `  ·  ${model.hashrateEh.toFixed(0)} EH/s mining` : "";
    const pr = model.price ? `  ·  BTC $${Math.round(model.price).toLocaleString()}` : "";
    text(`Difficulty ${model.difficulty.toExponential(2)}${hr}${pr}  ·  ~1 in ${(model.difficulty * 4294967296).toExponential(2)} per hash`, r.x + r.w / 2, y, { size: 13, weight: 600, color: `rgba(${ACCENT}, 0.9)`, align: "center", baseline: "middle" });
    y += 19;
  }
  // difficulty-adjustment explainer — its own row under the title (why more miners ≠ faster blocks)
  { const ne = networkExplainer(model.diffAdjust); if (ne) { text(ne, r.x + r.w / 2, y, { size: 10.5, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle" }); y += 17; } }
  // #9: what this miner actually uses — to show it's a lottery ticket, not a power-hungry rig
  const mp = model.node && model.node.miner_proc, dsk = model.node && model.node.size_on_disk;
  // Two lines, because they answer two different questions and one was quietly missing. The miner line makes
  // the "is this a mining rig?" point. The node line answers "why is my computer busy?" — bitcoind is the
  // process that actually holds gigabytes and spins fans, and reporting only the miner (~24 MB) understated
  // what notzero costs a machine by two orders of magnitude.
  if (mp) {
    const disk = dsk ? ` · ${(dsk / 1e9).toFixed(0)} GB disk${model.node.pruned ? " (pruned node)" : ""}` : "";
    text(`⚙ this miner uses ~${mp.cpu}% CPU · ${mp.mem_mb} MB RAM · one SHA-256 per block — a lottery ticket, not a mining rig`, r.x + r.w / 2, y, { size: 11, weight: 500, color: "rgba(90,210,140,0.7)", align: "center", baseline: "middle" }); y += 19;
    if (mp.node) {
      // Say it will DROP, and how far along it is. "higher while it verifies history" described the present
      // and left the obvious question — for how long? — unanswered, which is the whole reason someone reads
      // this line. A number they can watch move is the reassurance; the state on its own isn't.
      const bv = backgroundVerify();
      const ibd = model.node.initialblockdownload ? (model.node.verificationprogress || 0) * 100 : 0;
      const why = bv ? ` — will drop when it finishes verifying history · ${(bv.progress * 100).toFixed(0)}% complete`
        : ibd ? ` — will drop when it finishes syncing · ${ibd.toFixed(0)}% complete` : "";
      const gb = mp.node.mem_mb >= 1024 ? `${(mp.node.mem_mb / 1024).toFixed(1)} GB` : `${Math.round(mp.node.mem_mb)} MB`;
      text(`⛁ your node uses ~${mp.node.cpu}% CPU · ${gb} RAM${disk}${why}`, r.x + r.w / 2, y, { size: 11, weight: 500, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" }); y += 19;
    }
  }
  // which Bitcoin Core is actually running — the node's own subversion via node.json, not the version we pin,
  // so it's right whether the app manages the node or you brought your own (in which case we can't know it).
  // Same source as the line in Settings. Its own row rather than tacked onto the miner line above, which is
  // making a different point ("not a mining rig") and shouldn't be diluted.
  { const cv = model.node && model.node.core_version;
    if (cv) { text(`your node runs Bitcoin Core ${cv}${model.node.initialblockdownload ? " · still syncing" : ""}`, r.x + r.w / 2, y, { size: 10.5, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" }); y += 17; } }
  if (isDesktop && nodeMode === "managed") { const quitHint = (desktopPlatform === "win32" || desktopPlatform === "linux") ? "Quitting from the tray icon" : "Quitting the app (⌘Q)"; text(`Closing this window keeps your node + mining running in the background. ${quitHint} stops your node.`, r.x + r.w / 2, y, { size: 10.5, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" }); y += 18; }
  // all three indicators in one row: BTC price (left) · mining power vs difficulty (middle) · halving (right)
  const gap = 16, ch = r.y + r.h - y - 6;
  const hasBw = !!(model.node && model.node.nettotals); // node bandwidth → add a 4th card (desktop only)
  const cards = hasBw ? [["price", 0.21], ["mining", 0.34], ["halving", 0.21], ["bw", 0.24]] : [["price", 0.27], ["mining", 0.46], ["halving", 0.27]];
  const totW = r.w - gap * (cards.length - 1);
  let cx = r.x;
  for (const [kind, frac] of cards) {
    const w = totW * frac;
    ctx.fillStyle = "rgba(255,255,255,0.05)"; roundRect(cx, y, w, ch, 8); ctx.fill();
    if (kind === "price") { text(model.price ? `BTC $${Math.round(model.price).toLocaleString()}` : "BTC price", cx + 10, y + 15, { size: 13, weight: 600, color: "rgb(70,220,130)" }); sparkline({ x: cx + 10, y: y + 26, w: w - 20, h: ch - 36 }, model.priceHistory, "rgb(70,220,130)"); }
    else if (kind === "mining") { text("Mining power vs difficulty", cx + 10, y + 15, { size: 13, weight: 600, color: "rgba(255,255,255,0.7)" }); drawMiningChart({ x: cx + 14, y: y + 26, w: w - 28, h: ch - 36 }); }
    else if (kind === "halving") { text("Next halving", cx + 10, y + 15, { size: 13, weight: 600, color: "rgba(255,255,255,0.7)" }); drawHalvingCard({ x: cx + 12, y: y + 30, w: w - 24, h: ch - 42 }); }
    else { drawBandwidthCard({ x: cx, y, w, h: ch }); }
    cx += w + gap;
  }
}

// node bandwidth: up/down rate graphed from successive getnettotals samples, with a GB/month estimate
function drawBandwidthCard(b) {
  text("Bandwidth", b.x + 10, b.y + 15, { size: 13, weight: 600, color: "rgba(255,255,255,0.7)" });
  const h = model.bwHistory, kb = (bps) => bps / 1024;
  const cur = h.length ? h[h.length - 1] : null;
  if (cur) {
    text(`↓${kb(cur.down).toFixed(1)} ↑${kb(cur.up).toFixed(1)} KB/s`, b.x + b.w - 10, b.y + 15, { size: 10, color: "rgba(255,255,255,0.6)", align: "right", baseline: "middle" });
    const moGB = (cur.down + cur.up) * 86400 * 30 / 1e9;
    text(`~${moGB < 10 ? moGB.toFixed(1) : Math.round(moGB)} GB/mo`, b.x + b.w - 10, b.y + b.h - 8, { size: 10, weight: 600, color: `rgba(${ACCENT},0.8)`, align: "right", baseline: "middle" });
  }
  const gx = b.x + 10, gy = b.y + 28, gw = b.w - 20, gh = b.h - 44;
  if (h.length < 2) { text("measuring…", b.x + b.w / 2, b.y + b.h / 2, { size: 11, color: "rgba(255,255,255,0.35)", align: "center", baseline: "middle" }); return; }
  const maxR = Math.max(1, ...h.map((s) => Math.max(s.down, s.up)));
  const X = (i) => gx + (i / (h.length - 1)) * gw, Y = (v) => gy + gh - (v / maxR) * gh;
  ctx.fillStyle = "rgba(70,160,230,0.22)"; ctx.beginPath(); ctx.moveTo(gx, gy + gh); h.forEach((s, i) => ctx.lineTo(X(i), Y(s.down))); ctx.lineTo(X(h.length - 1), gy + gh); ctx.closePath(); ctx.fill(); // download area
  ctx.strokeStyle = "rgba(90,180,235,0.95)"; ctx.lineWidth = 1.4; ctx.beginPath(); h.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s.down)) : ctx.moveTo(X(i), Y(s.down)))); ctx.stroke();
  ctx.strokeStyle = "rgba(255,180,90,0.95)"; ctx.lineWidth = 1.2; ctx.beginPath(); h.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s.up)) : ctx.moveTo(X(i), Y(s.up)))); ctx.stroke(); // upload line
  text("↓ down", gx, b.y + b.h - 8, { size: 10, color: "rgba(90,180,235,0.9)", baseline: "middle" });
  text("↑ up", gx + 48, b.y + b.h - 8, { size: 10, color: "rgba(255,180,90,0.9)", baseline: "middle" });
}

// ---- sync preview/demo: fabricate an IBD node so the sync animation can be previewed when caught up ----
let syncDemo = new URLSearchParams(location.search).has("syncdemo");
if (syncDemo) expanded.add("sync"); // ?syncdemo=1 → open the sync panel for the preview
let demoHead = null, demoTip = null, demoStage = "ibd", demoT0 = 0, demoBlkMs = 0, demoMined = 0;
function demoNode() {
  const realTip = model.tipHeight || 900000, now = Date.now();
  if (demoHead == null || demoTip == null || demoTip < realTip - 1 || demoTip > realTip + 60) { demoTip = realTip; demoHead = realTip - 60; demoStage = "ibd"; demoT0 = now; demoBlkMs = now; demoMined = 0; }
  if (demoStage === "ibd") {
    const prog = Math.min(1, (now - demoT0) / 16000); // catch up over ~16 real seconds (time-based, fps-independent)
    demoHead = (demoTip - 60) + prog * 60;
    if (prog >= 1) { demoHead = demoTip; demoStage = "mining"; demoBlkMs = now; } // caught up → mining the tip
  } else { // mining: caught up; the network finds a new block every ~5s (head & tip advance together)
    if (now - demoBlkMs > 5000) { demoTip += 1; demoHead += 1; demoBlkMs = now; demoMined += 1; }
    if (demoMined >= 5) { demoStage = "ibd"; demoTip = realTip; demoHead = realTip - 60; demoT0 = now; demoMined = 0; } // loop back to show IBD again
  }
  const ibd = demoStage === "ibd", sinceBlk = (now - demoBlkMs) / 1000;
  const peers = [];
  for (let i = 0; i < 8; i++) {
    const lively = (i * 3) % 7 < 4, osc = 0.5 + 0.5 * Math.sin(clock * (0.6 + i * 0.13) + i * 1.7);
    const burst = ibd ? 1 : Math.max(0, 1 - sinceBlk * 1.3); // mining: peers spike when a block lands, then quiet
    const rate = lively ? Math.round((30000 + 360000 * osc * osc) * burst) : (i === 7 ? 0 : Math.round(7000 * osc * burst));
    peers.push({ addr: "demo-peer-" + i, inbound: i % 2 === 0, downloading: rate > 8000, rate, subver: "/demo:0.1/" });
  }
  const tip = Math.floor(demoTip);
  // simulated mempool: transactions accumulate while mining, a fresh block clears some
  const mpCount = Math.round(4500 + 2500 * (0.5 + 0.5 * Math.sin(clock * 0.25)) + (ibd ? 0 : sinceBlk * 55));
  const mempool = { count: mpCount, bytes: mpCount * 540, rate: Math.round(7 + 16 * (0.5 + 0.5 * Math.sin(clock * 0.6))), relay: true };
  return { ts: 0, reachable: true, blocks: Math.floor(demoHead), headers: tip, verificationprogress: ibd ? demoHead / tip : 0.99999, initialblockdownload: ibd, size_on_disk: 15.2e9, pruned: true, mempool, peers, miner: { mode: "live" } };
}
window.addEventListener("keydown", (e) => {
  if (hashViz.focused && handleHashKey(e)) return; // typing into the INSIDE THE HASH input
  if (e.key === "d" || e.key === "D") syncDemo = !syncDemo;
  else if (e.key === "Escape" && syncDemo) syncDemo = false;
  else return;
  if (syncDemo) { expanded.add("sync"); saveExpanded(); }
  else { // exit → restore the real node, and drop ?syncdemo so a reload won't re-enter
    demoHead = null; pollNode();
    if (new URLSearchParams(location.search).has("syncdemo")) history.replaceState(null, "", location.pathname);
  }
});

// ---- render loop ----
// the subtle preview affordances (top-right, fixed): "preview a block" (mempool harvest + sync commit) and
// "preview a win" (the celebration) — each registers a hit-region for the click handler
function drawPreviewTrigger() {
  ctx.font = "700 12px -apple-system, system-ui, sans-serif";
  const pulse = 0.5 + 0.18 * Math.sin(clock * 2);
  const rightX = W - PAD - (isDesktop ? 28 : 0); // leave room for the settings gear in the desktop app
  const winLbl = "▶ preview a win", winW = ctx.measureText(winLbl).width;
  winPreviewHit = { x: rightX - winW, y: 10, w: winW, h: 22 };
  text(winLbl, rightX, 21, { size: 12, weight: 700, color: `rgba(${ACCENT},${pulse})`, align: "right", baseline: "middle" });
  const blkLbl = "▶ preview a block", blkRight = rightX - winW - 16, blkW = ctx.measureText(blkLbl).width;
  blockPreviewHit = { x: blkRight - blkW, y: 10, w: blkW, h: 22 };
  text(blkLbl, blkRight, 21, { size: 12, weight: 700, color: `rgba(255,255,255,${0.4 + 0.12 * Math.sin(clock * 2 + 1)})`, align: "right", baseline: "middle" });
}
// persistent "update available" pill (desktop only) — a pending update is visible IN the app, not just a
// missable OS notification. Click → ask the app to check and show the what's-new / install choice.
function drawUpdatePill() {
  updatePillHit = null;
  const downloading = isDesktop && !!updateDownload;
  if (!isDesktop || (!downloading && !updatePendingVer)) return;
  const pct = downloading ? Math.max(0, Math.min(100, Math.round((updateDownload && updateDownload.percent) || 0))) : 0;
  // before the first byte arrives (pct 0 / optimistic "preparing"), say "Preparing update…" so it never looks stuck at 0%
  const label = downloading ? (pct > 0 ? `⬇ Downloading update… ${pct}%` : "⬇ Preparing update…") : `⬆ Update available · v${updatePendingVer}`;
  const col = downloading ? "120,200,255" : "255,205,110"; // blue while working, amber when it's a call to action
  ctx.font = "700 12px -apple-system, system-ui, sans-serif";
  const tw = ctx.measureText(label).width, pw = Math.max(tw + 26, 172), ph = 24, px = W - PAD - pw, py = 40;
  const pulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(clock * 2.4));
  ctx.fillStyle = `rgba(${col},${0.14 + 0.06 * pulse})`; roundRect(px, py, pw, ph, 12); ctx.fill();
  if (downloading) { // progress fill along the pill so you can SEE it working
    ctx.save(); roundRect(px, py, pw, ph, 12); ctx.clip();
    ctx.fillStyle = `rgba(${col},0.26)`; ctx.fillRect(px, py, pw * (pct / 100), ph); ctx.restore();
  }
  ctx.strokeStyle = `rgba(${col},${0.55 + 0.4 * pulse})`; ctx.lineWidth = 1.3; roundRect(px, py, pw, ph, 12); ctx.stroke();
  text(label, px + pw / 2, py + ph / 2, { size: 12, weight: 700, color: downloading ? "rgba(200,230,255,1)" : "rgba(255,218,130,1)", align: "center", baseline: "middle" });
  if (downloading) {
    text("installs & restarts automatically when ready", px + pw / 2, py + ph + 9, { size: 8.5, weight: 600, color: `rgba(${col},0.72)`, align: "center", baseline: "middle" });
    // deliberately NOT clickable while downloading (updatePillHit stays null) → a stray click can't re-trigger it
  } else {
    text("click to update", px + pw / 2, py + ph + 9, { size: 8.5, weight: 600, color: "rgba(255,205,110,0.7)", align: "center", baseline: "middle" });
    updatePillHit = { x: px, y: py, w: pw, h: ph };
  }
}
// desktop-only settings gear (top-right corner) → opens the settings screen (/setup). Drawn as a small
// ring of teeth so it stays crisp/monochrome rather than a colour emoji.
function drawGear() {
  gearHit = null;
  if (!isDesktop) return;
  const gx = W - PAD - 7, gy = 21, hover = inHit(gearHit0(gx, gy), mouseX, mouseY);
  const col = `rgba(${ACCENT},${hover ? 0.95 : 0.6})`;
  ctx.save(); ctx.translate(gx, gy); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.4;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 5, Math.sin(a) * 5); ctx.lineTo(Math.cos(a) * 8, Math.sin(a) * 8); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 1.7, 0, 7); ctx.fill();
  ctx.restore();
  gearHit = gearHit0(gx, gy);
}
const gearHit0 = (gx, gy) => ({ x: gx - 12, y: gy - 12, w: 24, h: 24 });

// animation toggle (top-left) → cycles Full → Calm → Off, for weak machines / personal preference.
const MOTION_UI = { full: { icon: "✦", name: "full" }, calm: { icon: "◐", name: "calm" }, off: { icon: "○", name: "off" } };
function drawMotionToggle() {
  const m = MOTION_UI[motionMode] || MOTION_UI.full;
  const lbl = `${m.icon} motion: ${m.name}`;
  ctx.font = "600 11px ui-monospace, monospace";
  const w = ctx.measureText(lbl).width + 16, h = 20, x = PAD, y = 11;
  const hover = inHit({ x, y, w, h }, mouseX, mouseY);
  ctx.fillStyle = `rgba(255,255,255,${hover ? 0.1 : 0.045})`; roundRect(x, y, w, h, 5); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},${hover ? 0.5 : 0.2})`; ctx.lineWidth = 1; roundRect(x, y, w, h, 5); ctx.stroke();
  text(lbl, x + w / 2, y + h / 2, { size: 11, weight: 600, color: hover ? `rgba(${ACCENT},1)` : "rgba(255,255,255,0.58)", align: "center", baseline: "middle", mono: true });
  if (hover) text("click to cycle motion · full → calm → off (off is lightest on older machines)", x + 2, y + h + 9, { size: 9, color: "rgba(255,255,255,0.42)", baseline: "middle" });
  motionHit = { x, y, w, h };
  window.__motionHit = motionHit; // test hook: lets a test assert the control ROW's layout, not pixel positions
}
// visible text-size control (top-left, next to the motion toggle) so users discover they can enlarge the UI
// without hunting for browser zoom. A−  110%  A+ — click either end; the level is remembered across sessions.
function drawZoomControl() {
  const y = 11, h = 20, bw = 22, gap = 3, startX = (motionHit ? motionHit.x + motionHit.w : PAD) + 12;
  let x = startX;
  const seg = (bx, lbl, enabled) => {
    const hov = enabled && inHit({ x: bx, y, w: bw, h }, mouseX, mouseY);
    ctx.fillStyle = `rgba(255,255,255,${hov ? 0.1 : 0.045})`; roundRect(bx, y, bw, h, 5); ctx.fill();
    ctx.strokeStyle = `rgba(${ACCENT},${hov ? 0.5 : 0.2})`; ctx.lineWidth = 1; roundRect(bx, y, bw, h, 5); ctx.stroke();
    text(lbl, bx + bw / 2, y + h / 2, { size: 13, weight: 700, color: !enabled ? "rgba(255,255,255,0.22)" : hov ? `rgba(${ACCENT},1)` : "rgba(255,255,255,0.6)", align: "center", baseline: "middle" });
    return { x: bx, y, w: bw, h };
  };
  zoomOutHit = seg(x, "A−", userScale > 0.8); x += bw + gap;
  ctx.font = "700 10px ui-monospace, monospace";
  const pct = Math.round(userScale * 100) + "%", pw = Math.max(30, ctx.measureText(pct).width + 10);
  text(pct, x + pw / 2, y + h / 2, { size: 10, weight: 700, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle", mono: true }); x += pw;
  zoomInHit = seg(x, "A+", userScale < 1.6);
  window.__zoomInHit = zoomInHit; // test hook: the right-hand end of the cluster, which the ambient control follows
  if (inHit(zoomOutHit, mouseX, mouseY) || inHit(zoomInHit, mouseX, mouseY)) text("text size — make everything bigger or smaller (remembered)", startX, y + h + 9, { size: 9, color: "rgba(255,255,255,0.42)", baseline: "middle" });
}
// Ambient view launcher (top-left, after the text-size control). Deliberately ICON-ONLY: it sits beside the
// other view controls, where someone looks for this kind of thing, and says what it is on hover in the same
// way the motion toggle does. It replaces a bottom-right floating button that was unlabelled AND parked in
// the one corner nobody scans — the same subtlety, somewhere it can actually be found.
//
// The idle timer opens this view on its own after ambient.idleSeconds; this is the "don't make me wait" path.
// It POSTs the same /ambient-open the old button did, so it lands in openAmbient(manual = true) — which never
// auto-closes and never locks on wake, unlike an idle-triggered one.
function drawAmbientButton() {
  if (!HAS_AMBIENT_BTN) return;
  const y = 11, h = 20, w = 24, x = (zoomInHit ? zoomInHit.x + zoomInHit.w : PAD) + 12;
  const hover = inHit({ x, y, w, h }, mouseX, mouseY);
  ctx.fillStyle = `rgba(255,255,255,${hover ? 0.1 : 0.045})`; roundRect(x, y, w, h, 5); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},${hover ? 0.5 : 0.2})`; ctx.lineWidth = 1; roundRect(x, y, w, h, 5); ctx.stroke();
  text("◉", x + w / 2, y + h / 2, { size: 12, weight: 700, color: hover ? `rgba(${ACCENT},1)` : "rgba(255,255,255,0.58)", align: "center", baseline: "middle" });
  // Anchored at the left margin, like the motion toggle's hint — starting it under the control itself runs the
  // line straight into the BITCOIN LOTTERY title, since this sits at the right-hand end of the cluster.
  if (hover) text("ambient view — full-screen calm mode, now rather than after the idle wait (Esc returns)", PAD + 2, y + h + 9, { size: 9, color: "rgba(255,255,255,0.42)", baseline: "middle" });
  ambientHit = { x, y, w, h };
  window.__ambientHit = ambientHit; // test hook: the control's rect, so a test never hunts for it by pixel
}

// top-center liveness pill — answers "is it actually submitting tickets?" at a glance, so a user never has
// to hunt or wonder. green = synced + a fresh ticket · amber = node still syncing · red = stalled/offline.
function agoStr(sec) {
  if (!isFinite(sec)) return "—";
  if (sec < 45) return "just now";
  if (sec < 5400) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}
// A stale "last ticket" is only a REAL stall if newer blocks have arrived since (the tip is fresh but the
// ticket isn't). A slow block — >20 min with no new block found, which happens for ~8% of blocks — leaves BOTH
// the tip and the ticket stale, and that's normal, not a stall. So compare the ticket's age to the tip's age
// before crying wolf. (No tip_time → can't compare → don't false-alarm.)
function minerStalled(n, ageSec) {
  if (!(ageSec > 1200)) return false;                        // ticket is fresh — fine
  const tipAge = n && n.tip_time ? Date.now() / 1000 - n.tip_time : Infinity;
  return ageSec > tipAge + 600;                              // ticket much older than the last block ⇒ blocks arrived but the miner missed them
}
function drawMinerStatus() {
  const n = model.node;
  if (!isDesktop || !n) return; // real app only — not the public demo (no node; a preview could mislead)
  const reachable = n.reachable !== false;
  const syncing = reachable && (n.initialblockdownload || (n.headers || 0) > (n.blocks || 0));
  const at = n.miner && n.miner.attempt;
  const tMs = at && at.attempted_at ? Date.parse(at.attempted_at) : NaN;
  const haveTs = isFinite(tMs);
  const ageSec = haveTs ? (Date.now() - tMs) / 1000 : Infinity;
  const GREEN = "90,225,140", AMBER = "255,190,70", RED = "255,90,90";
  let dot, label, sub;
  if (!reachable) { if (nodeReconnecting()) { dot = AMBER; label = "reconnecting"; sub = "miner restarting"; } else if (nodeMode === "managed") { const sv = nodeSetupView(); dot = sv && sv.isError ? RED : AMBER; label = sv && sv.isError ? "setup error" : "getting ready"; sub = sv ? sv.head.toLowerCase() : "node starting"; } else { dot = RED; label = "not submitting"; sub = "node offline"; } }
  else if (syncing) { const p = n.verificationprogress != null ? n.verificationprogress : 0; dot = AMBER; label = "getting ready"; sub = `syncing ${Math.floor(p * 100)}%`; }
  else if (!haveTs) { dot = GREEN; label = "submitting tickets"; sub = "mining the current block"; } // synced but no ticket timestamp (older build / first moments) — don't claim a stale time we don't have
  else if (!minerStalled(n, ageSec)) { dot = GREEN; label = "submitting tickets"; sub = `last ticket ${agoStr(ageSec)}`; } // fresh, or just a slow block (no new block yet) — both fine
  else { dot = RED; label = "not submitting"; sub = `last ticket ${agoStr(ageSec)}`; } // genuinely stalled — the tip moved on but the miner didn't log a ticket

  const txt = `${label} · ${sub}`;
  ctx.font = "600 11px ui-monospace, monospace";
  const padL = 22, w = ctx.measureText(txt).width + padL + 12, h = 18, x = (W - w) / 2, y = 5;
  ctx.fillStyle = `rgba(${dot},0.10)`; roundRect(x, y, w, h, 6); ctx.fill();
  ctx.strokeStyle = `rgba(${dot},0.45)`; ctx.lineWidth = 1; roundRect(x, y, w, h, 6); ctx.stroke();
  // the dot gently pulses while green so "live" reads as alive (frozen under reduced-motion)
  const pulse = (dot === GREEN && !reduceMotion) ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(clock * 2.2)) : 0.9;
  ctx.fillStyle = `rgba(${dot},${pulse})`; ctx.beginPath(); ctx.arc(x + 12, y + h / 2, 4, 0, 7); ctx.fill();
  // +0.5: canvas "middle" centres the font's em box, which sits above the optical centre of a lowercase
  // line. Invisible at dpr 1 (measured: ink band already centred) but a whole device pixel on a Retina panel
  // at the desktop's 1.1 UI scale, which is where it reads as sitting high.
  text(txt, x + padL, y + h / 2 + 0.5, { size: 11, weight: 600, color: `rgba(${dot},0.95)`, baseline: "middle", mono: true });
}

// mempool.space unreachable → a small fixed notice in the top-left (under the motion/text-size row), NOT a
// takeover of the screen. It says how stale the public chain data is, so the numbers still on screen are
// honestly labelled rather than silently frozen.
function drawOfflineNotice() {
  if (!model.error) return;
  const age = model.chainOkAt ? (Date.now() - model.chainOkAt) / 1000 : Infinity;
  const lbl = `⚠ ${model.error}${model.chainOkAt ? ` · chain data ${agoStr(age)}` : ""} · retrying…`;
  ctx.font = "600 11px ui-monospace, monospace";
  const w = ctx.measureText(lbl).width + 18, h = 20, x = PAD, y = 37;
  const pulse = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(clock * 2));
  ctx.fillStyle = "rgba(30,16,8,0.94)"; roundRect(x, y, w, h, 5); ctx.fill();
  ctx.strokeStyle = `rgba(255,170,80,${0.35 + 0.3 * pulse})`; ctx.lineWidth = 1; roundRect(x, y, w, h, 5); ctx.stroke();
  text(lbl, x + w / 2, y + h / 2, { size: 11, weight: 600, color: "rgba(255,190,110,0.95)", align: "center", baseline: "middle", mono: true });
}
// persistent network-win notice (fixed, above the footer) — so you know even if you missed the moment
function drawNetWinBadge(wins) {
  netWinHit = null;
  if (!wins.length) return;
  const latest = wins[0];
  const tag = latest.verified ? "solo, verified on your node" : "tagged on a public explorer — unverified";
  const label = `🎉 a lottery miner won block #${latest.height.toLocaleString()}${wins.length > 1 ? ` (${wins.length} total)` : ""} — ${tag} · click to celebrate`;
  ctx.font = "700 12px -apple-system, system-ui, sans-serif";
  const tw = ctx.measureText(label).width;
  netWinHit = { x: W / 2 - tw / 2, y: H - 44, w: tw, h: 20, win: latest };
  text(label, W / 2, H - 34, { size: 12, weight: 700, color: latest.verified ? "rgba(90,228,150,0.92)" : "rgba(255,200,110,0.92)", align: "center", baseline: "middle" });
}

// YOUR block before it's confirmed: 'pending' (found, awaiting the network) or 'lost' (a different block
// reached the chain first). Honest about a found block that didn't make it. Returns true if it drew.
function drawOwnWinStatus(ws) {
  winStatusHit = null;
  if (!ws || (ws.status !== "pending" && ws.status !== "lost")) return false;
  if (ws.status === "lost" && dismissedLost.has(ws.height)) return false;
  const lost = ws.status === "lost", h = (ws.height || 0).toLocaleString();
  const confs = ws.confirmations || 0, needs = ws.needs || 6;
  const label = lost
    ? `⛏ you found block #${h} — but another block reached the chain first. a real find, beaten by seconds`
    : confs >= 1
      ? `⛏ you found block #${h} — in the chain, settling… (${confs}/${needs} confirmations before we celebrate)`
      : `⛏ you found block #${h} — submitted; waiting for the network to confirm…`;
  ctx.font = "700 12px -apple-system, system-ui, sans-serif";
  const tw = ctx.measureText(label).width, pw = tw + (lost ? 44 : 28), ph = 28, px = W / 2 - pw / 2, py = H - 46;
  ctx.fillStyle = "rgba(28,18,6,0.96)"; roundRect(px, py, pw, ph, 8); ctx.fill();
  ctx.strokeStyle = lost ? "rgba(255,150,90,0.85)" : "rgba(255,205,100,0.85)"; ctx.lineWidth = 1.3; roundRect(px, py, pw, ph, 8); ctx.stroke();
  text(label, px + 14 + tw / 2, py + ph / 2, { size: 12, weight: 700, color: lost ? "rgb(255,175,115)" : "rgb(255,215,120)", align: "center", baseline: "middle" });
  if (lost) { text("✕", px + pw - 15, py + ph / 2, { size: 13, weight: 700, color: "rgba(255,175,115,0.6)", align: "center", baseline: "middle" }); winStatusHit = { x: px, y: py, w: pw, h: ph, height: ws.height }; }
  return true;
}

// small "new best" toast (bottom-centre) — slides in, then HOLDS until clicked (you may not be watching
// when it happens), with a ✕ affordance. Not a takeover.
function drawBestToast() {
  if (!bestToast.active) { bestToastHit = null; return; }
  bestToast.t += 1 / 60;
  const t = bestToast.t, inP = Math.min(1, t / 0.3);
  // a "best" is measured in zero BITS (finer-grained than whole hex "0"s, so the record ticks up more
  // often). every 4 bits = one hex "0", so N bits ⇒ ⌊N/4⌋ leading "0" characters (the rest is a partial
  // nibble). Keep the two units from being compared cross-unit: the headline's leading-"0" count and the
  // "needs ~19" target are BOTH hex chars; the zero-bits figure is shown separately and clearly labelled.
  const hz = Math.floor(bestToast.bits / 4);
  const label = `🎯 new best · ${hz} leading “0”${hz === 1 ? "" : "s"} (${bestToast.bits} zero bits)`;
  const sub = `${bestToast.odds ? `${bestToast.odds} tickets get this far · ` : ""}a winning block needs about 19 leading “0”s`;
  ctx.font = "700 13px -apple-system, system-ui, sans-serif"; const tw = ctx.measureText(label).width;
  ctx.font = "600 11px -apple-system, system-ui, sans-serif"; const sw = ctx.measureText(sub).width;
  const pw = Math.max(tw, sw) + 50, ph = 46, slide = reduceMotion ? 0 : (1 - inP) * 18;
  const px = W / 2 - pw / 2, py = H - 92 + slide;
  bestToastHit = { x: px, y: py, w: pw, h: ph };
  ctx.globalAlpha = inP; // fade in, then hold at full
  ctx.fillStyle = "rgba(22,17,8,0.94)"; roundRect(px, py, pw, ph, 9); ctx.fill();
  ctx.strokeStyle = "rgba(255,215,90,0.75)"; ctx.lineWidth = 1.3; roundRect(px, py, pw, ph, 9); ctx.stroke();
  text(label, px + pw / 2, py + 16, { size: 13, weight: 700, color: "rgb(255,228,130)", align: "center", baseline: "middle" });
  text(sub, px + pw / 2, py + 32, { size: 11, weight: 600, color: "rgba(255,228,130,0.62)", align: "center", baseline: "middle" });
  text("✕", px + pw - 15, py + 15, { size: 13, weight: 700, color: "rgba(255,228,130,0.55)", align: "center", baseline: "middle" });
  if (!reduceMotion && t < 1.2) for (let i = 0; i < 8; i++) { // a brief spark on appearance
    const a = (i / 8) * Math.PI * 2, rr = 14 + t * 42;
    ctx.fillStyle = `rgba(255,215,90,${0.5 * (1 - t / 1.2)})`;
    ctx.beginPath(); ctx.arc(px + pw / 2 + Math.cos(a) * rr, py + ph / 2 + Math.sin(a) * rr * 0.55, 1.8, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// full-canvas win celebration — the emotional payoff: the 1-in-10^24 actually landed
function drawCelebration() {
  if (!celebration.active) return;
  if (reduceMotion) celebration.t = 1.2; else celebration.t += 1 / 60; // reduced-motion: show the settled card, no motion
  const t = celebration.t, cx = W / 2, cy = H / 2, scrim = Math.min(0.9, t * 1.8);
  ctx.fillStyle = `rgba(10,7,2,${scrim})`; ctx.fillRect(0, 0, W, H);
  if (!reduceMotion) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 0.12); const R = Math.max(W, H); // slow gold rays
    for (let i = 0; i < 20; i++) { ctx.rotate(Math.PI * 2 / 20); ctx.fillStyle = `rgba(255,190,70,${0.045 * scrim})`; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(46, -R); ctx.lineTo(-46, -R); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    for (let i = 0; i < 80; i++) { // gold/green confetti
      const x = hrand(i * 1.7) * W + Math.sin(t * 0.6 + i) * 22;
      const y = ((t * (60 + (i % 6) * 22) + hrand(i * 3.1) * H) % (H + 30)) - 15;
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 3 + i);
      ctx.fillStyle = i % 3 === 0 ? `rgba(90,225,140,${0.85 * scrim})` : `rgba(255,195,80,${0.9 * scrim})`;
      ctx.fillRect(-2.4, -2.4, 4.8, 4.8); ctx.restore();
    }
  }
  const a = Math.min(1, t * 1.6), you = celebration.mode !== "network"; // content fade-in
  if (celebration.preview) text("PREVIEW — illustrative; this is what winning looks like", cx, cy - 124, { size: 12, weight: 700, color: `rgba(255,180,80,${0.9 * a})`, align: "center", baseline: "middle" });
  text(you ? "★  YOU FOUND A BLOCK  ★" : "★  A LOTTERY MINER WON  ★", cx, cy - 92, { size: 38, weight: 800, color: `rgba(255,200,70,${a})`, align: "center", baseline: "middle" });
  const h = celebration.height || 0;
  text(you ? (h ? `block #${h.toLocaleString()} is yours` : "a block is yours") : (h ? `block #${h.toLocaleString()} — found by someone running this` : "found by someone running this software"), cx, cy - 56, { size: 15, weight: 600, color: `rgba(255,255,255,${0.7 * a})`, align: "center", baseline: "middle" });
  const hash = celebration.hash || "";
  if (hash) {
    const show = hash.slice(0, 48), lead = leadingZeroHexChars(hash);
    ctx.font = "800 14px ui-monospace, monospace"; const cw = ctx.measureText("0").width, x0 = cx - (show.length * cw) / 2 + cw / 2;
    for (let i = 0; i < show.length; i++) { const z = i < lead; text(show[i], x0 + i * cw, cy - 18, { size: 14, weight: z ? 800 : 500, color: z ? `rgba(90,235,150,${a})` : `rgba(255,255,255,${0.5 * a})`, align: "center", baseline: "middle", mono: true }); }
    text(`${lead} leading zeros — below the target`, cx, cy + 4, { size: 11, color: `rgba(90,225,140,${0.85 * a})`, align: "center", baseline: "middle" });
  }
  text(`${celebration.reward.toFixed(3)} BTC`, cx, cy + 40, { size: 30, weight: 800, color: `rgba(90,230,150,${a})`, align: "center", baseline: "middle" });
  text(you ? "it was never zero — and it just landed on you" : "it was never zero — and it just landed on one of us", cx, cy + 74, { size: 14, weight: 600, color: `rgba(255,210,90,${a})`, align: "center", baseline: "middle" });
  text(you ? "any computer, no data center, no fee — this is what a non-zero chance looks like" : (celebration.verified ? "a solo miner on a regular computer just beat the data centers — verified on your node" : "a block carries the /BitcoinLottery/ tag (seen on a public explorer — not verified by your node)"), cx, cy + 98, { size: 12, color: `rgba(255,255,255,${0.55 * a})`, align: "center", baseline: "middle" });
  // your block's journey — animated so the preview shows the whole thing (a real win recaps it, ending confirmed)
  if (you) {
    const sT = reduceMotion ? 7 : t;
    let si2 = 0, confN = 0;
    if (sT < 1.3) si2 = 0; else if (sT < 2.7) si2 = 1; else if (sT < 5.7) { si2 = 2; confN = Math.min(6, Math.floor((sT - 2.7) / 0.5) + 1); } else si2 = 3;
    const labels = ["FOUND", "SUBMITTING", confN ? `CONFIRMING ${confN}/6` : "CONFIRMING", "CONFIRMED"], NS = 4, gap = 156, sy = cy + 136, sx0 = cx - (NS - 1) * gap / 2;
    for (let i = 0; i < NS; i++) {
      const sx = sx0 + i * gap, done = i < si2, cur = i === si2, on = done || cur;
      if (i > 0) { ctx.strokeStyle = `rgba(90,230,150,${(i <= si2 ? 0.75 : 0.16) * a})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(sx0 + (i - 1) * gap + 13, sy); ctx.lineTo(sx - 13, sy); ctx.stroke(); }
      ctx.fillStyle = on ? `rgba(90,230,150,${a})` : `rgba(255,255,255,${0.22 * a})`;
      ctx.beginPath(); ctx.arc(sx, sy, cur && !reduceMotion ? 8 + Math.sin(t * 6) * 1.2 : 6.5, 0, 7); ctx.fill();
      if (done) text("✓", sx, sy, { size: 9, weight: 800, color: `rgba(10,7,2,${a})`, align: "center", baseline: "middle" });
      text(labels[i], sx, sy + 18, { size: 9.5, weight: cur ? 800 : 600, color: on ? `rgba(90,230,150,${a})` : `rgba(255,255,255,${0.42 * a})`, align: "center", baseline: "middle" });
    }
    text(si2 < 3 ? "your block goes out via your node + direct P2P, then the network confirms it" : "settled — the reward is yours and can't be undone", cx, cy + 170, { size: 10, color: `rgba(255,255,255,${0.5 * a})`, align: "center", baseline: "middle" });
    // Ending on "CONFIRMED" sent people to a wallet showing an unspendable balance for most of a day. The
    // reward is real and already theirs; it just cannot MOVE until the coinbase matures at 100 blocks.
    if (si2 >= 3) {
      const wsC = winStatus(), mC = wsC ? maturityNote(wsC) : null;
      text(mC && mC.done ? "spendable now — matured past 100 confirmations"
        : `paid to your address by the block itself — spendable after 100 confirmations (~16 hours)${mC ? ` · ${mC.have} / ${mC.need}` : ""}`,
        cx, cy + 188, { size: 10, weight: 600, color: `rgba(255,210,110,${0.85 * a})`, align: "center", baseline: "middle" });
    }
  }
  text("✕  close", W - 48, 28, { size: 13, weight: 700, color: `rgba(255,255,255,${0.6 * a})`, align: "center", baseline: "middle" });
  text("click anywhere to dismiss", cx, H - 40, { size: 12, color: `rgba(255,255,255,${0.4 * a})`, align: "center", baseline: "middle" });
}

function render(ts) {
  rafId = requestAnimationFrame(render);
  // Lid-open / wake-from-sleep: wall-clock jumped far more than a frame, so every timer-driven poll is late
  // and the wifi has probably only just come back. Refetch immediately instead of showing stale-or-offline
  // data until the next 30s tick. (Runs before the frame-rate governor's early-return so it never gets skipped.)
  { const now = Date.now(); if (lastTickMs && now - lastTickMs > 45_000) recoverNow(); lastTickMs = now; }
  // Frame-rate governor. The loop is always scheduled, but we only actually repaint when enough time has
  // passed for the current mode — the early-return is essentially free, so idle CPU tracks the draw rate:
  //   off      → 1fps heartbeat (a safety net; real changes repaint instantly via requestRender)
  //   reduced  → ~4fps (OS reduce-motion: animations frozen, nothing to draw fast)
  //   unfocused→ ~8fps (B: window visible but in the background)
  //   focused  → 30fps cap (A: was an uncapped ~60fps full-canvas redraw — the original CPU hog)
  const minInterval = motionOff ? 1000 : reduceMotion ? 240 : winFocused ? 33 : 120;
  if (lastDraw && ts && ts - lastDraw < minInterval) return;
  lastDraw = ts || lastDraw;
  if (syncDemo) model.node = demoNode(); // override with the simulated IBD node for preview
  drawRain(); // fixed background

  autoExpandSync();
  checkSyncTransition(); // fire the "caught up — now mining" moment on the syncing→synced edge (also snaps scroll)
  const { frames, total } = layoutSections();
  window.__frames = Object.fromEntries(frames.filter((f) => f.content).map((f) => [f.section, f.content])); // expose panel rects (for snapshot tests to clip exactly)
  maxScroll = Math.max(0, total + FOOTER_PAD - H); // FOOTER_PAD leaves clearance so the last panel's bottom clears the fixed footer
  if (scrollY > maxScroll) scrollY = maxScroll;
  if (scrollToSection) { const tf = frames.find((x) => x.section === scrollToSection); if (tf) scrollY = Math.max(0, Math.min(tf.header.y - 48, maxScroll)); scrollToSection = null; } // bring a requested panel just below the fixed top controls

  ctx.save();
  ctx.translate(0, -scrollY);
  text("₿ITCOIN LOTTERY", W / 2, 44, { size: 28, weight: 800, align: "center", baseline: "middle" }); // y=44 (was 38) so the fixed status pill above it has clearance
  // y=68 (was 62): at 62 the 28px title's descenders nearly touched this line. The quote + attribution + TOP
  // below all moved down by the same 6px, so this only opens up the title gap and leaves the rest as it was.
  text("you almost certainly won't win — but it isn't zero, and zero is what you get if you never play · a real ticket, and a way to learn how Bitcoin works", W / 2, 68, { size: 11, weight: 500, color: "rgba(255,255,255,0.48)", align: "center", baseline: "middle" });
  const quoteAlpha = 0.45 + 0.12 * Math.sin(clock * 1.5);
  // both states render through the same monospace layout (p≥1 = fully resolved) so the text never shifts
  // quoteIdx is still the OUTGOING quote during "decode" — it only becomes quoteNext once the transition ends.
  // hold = the same morph parked at p=0 with from === to, so held and transitioning share one path.
  if (quotePhase === "hold") drawQuoteMorph(quoteText(quoteIdx), quoteText(quoteIdx), 0, quoteAlpha, quoteIdx);
  else drawQuoteMorph(quoteText(quoteIdx), quoteText(quoteNext), Math.min(1, quoteT / Q_DECODE), quoteAlpha, quoteIdx);
  const qsrc = quoteSrc(quoteIdx); // attribution shown once the quote has settled
  if (quotePhase === "hold" && qsrc) text("— " + qsrc, W / 2, 107, { size: 12, weight: 600, color: `rgba(${ACCENT}, 0.72)`, align: "center", baseline: "middle" });

  headerHits = []; ticketHits = []; youHit = null; bestHit = null;
  // NOTE: an unreachable mempool.space (model.error) does NOT gate this loop — it used to replace every panel
  // with a single error line, so a wifi blip blanked the entire app including the panels that never needed
  // that host. Panels keep their last known values (and their own "loading…" placeholders on a cold start);
  // drawOfflineNotice reports the outage in the corner.
  for (const f of frames) {
    // dim the matrix rain behind each section so its content reads clearly
    const top = f.header.y - 3;
    const bot = f.content ? f.content.y + f.content.h + 5 : f.header.y + f.header.h + 3;
    ctx.fillStyle = "rgba(6,5,12,0.62)";
    roundRect(f.header.x - 6, top, f.header.w + 12, bot - top, 9); ctx.fill();
    const hov = hoverSection === f.section;
    drawHeader(f.section, f.header, !!f.content, hov);
    headerHits.push(f);
    // never let one panel (e.g. a malformed hash from an untrusted source) freeze the whole loop
    if (f.content) try { drawContent(f.section, f.content); } catch (err) { text("— this panel hit an error —", f.content.x + f.content.w / 2, f.content.y + f.content.h / 2, { size: 13, color: "rgba(255,140,90,0.8)", align: "center", baseline: "middle" }); }
  }
  window.__drawn = headerHits.length; // how many panels this frame actually PAINTED (not just laid out) — the e2e suite asserts an outage never zeroes this
  window.__summarySync = summary("sync");
  window.__winSummary = winStatus() ? summary("win") : null; // test hook // test hook: computed every frame, NOT inside the panel paint — the SYNC panel only repaints while on screen, so hooking it there went stale the moment it scrolled out of view
  ctx.restore();

  // scrollbar indicator (fixed)
  if (maxScroll > 0) {
    const trackH = H - 16, th = Math.max(40, (trackH * H) / (total + FOOTER_PAD)), ty = 8 + (trackH - th) * (scrollY / maxScroll);
    ctx.fillStyle = "rgba(255,255,255,0.16)"; roundRect(W - 7, ty, 4, th, 2); ctx.fill();
  }
  // scrim behind the fixed footer so panel content scrolled to the bottom (e.g. the tall sync panel's
  // disk bar) doesn't bleed through the payout / status line.
  const fGrad = ctx.createLinearGradient(0, H - 34, 0, H);
  fGrad.addColorStop(0, "rgba(5,4,10,0)"); fGrad.addColorStop(0.5, "rgba(5,4,10,0.85)"); fGrad.addColorStop(1, "rgba(5,4,10,0.97)");
  ctx.fillStyle = fGrad; ctx.fillRect(0, H - 34, W, 34);
  // fixed footer — LIVE means everything's good: node reachable, fully synced, miner submitting.
  // anything short of that shows the real status (offline / syncing %) instead of claiming LIVE.
  const node = model.node;
  const reachable = !!(node && node.reachable !== false);
  const headH = node ? Math.floor(node.blocks || 0) : 0, tipH = node ? (node.headers || 0) : 0;
  const behindH = Math.max(0, tipH - headH);
  const prog = node && node.verificationprogress != null ? node.verificationprogress : 0;
  const synced = reachable && headH > 0 && behindH === 0 && !node.initialblockdownload && prog >= 0.9999;
  const minerLive = !!(node && node.miner && node.miner.mode === "live");
  // "symbolic" is the miner's DEFAULT mode (no live node yet). For a MANAGED node it's just the transient state
  // during setup/sync — the app IS setting a node up — so "practice mode · set up a node" would be both wrong and
  // misleading there. Suppress it for managed mode so the footer shows the real setup/sync status instead.
  const symbolic = !!(node && node.miner && node.miner.mode === "symbolic") && nodeMode !== "managed";
  const managedSyncing = nodeMode === "managed" && reachable && !synced; // node present but not yet caught up
  // synced + live but the miner genuinely stalled (tip moved on without a new ticket) → don't claim LIVE.
  // A merely-slow block (tip itself is old) is NOT a stall — minerStalled() distinguishes them.
  const lastTs = node && node.miner && node.miner.attempt ? Date.parse(node.miner.attempt.attempted_at || "") : NaN;
  const stalled = Number.isFinite(lastTs) && minerStalled(node, (Date.now() - lastTs) / 1000);
  let fmsg, fcol;
  const ver = appVersion ? `v${appVersion}` : VERSION; // desktop shows the app release (for support); web demo shows the dashboard version
  if (!node && nodeReconnecting()) { fmsg = `◌ reconnecting to your node… · ${ver}`; fcol = "rgba(255,200,90,0.95)"; }
  else if (!node) { fmsg = `◷ live demo · ${ver}`; fcol = "rgba(255,255,255,0.5)"; }
  else if (symbolic) { fmsg = `◷ practice mode — set up a node to mine for real · ${ver}`; fcol = "rgba(255,255,255,0.5)"; }
  else if (!reachable) { const sv = nodeMode === "managed" ? nodeSetupView() : null; fmsg = nodeReconnecting() ? `◌ reconnecting to your node… · ${ver}` : sv ? `${sv.isError ? "○" : "◌"} ${sv.head}${sv.isError ? "" : "…"} · ${ver}` : nodeMode === "managed" ? `◌ starting your node… · ${ver}` : `○ node unreachable — check your node · ${ver}`; fcol = sv && sv.isError ? "rgba(255,120,110,0.95)" : "rgba(255,150,80,0.95)"; }
  else if (!synced) { fmsg = `◐ syncing blockchain — ${(prog * 100).toFixed(2)}%${behindH ? ` · ${behindH.toLocaleString()} blocks to the tip` : ""} · ${ver}`; fcol = "rgba(255,180,80,0.95)"; }
  else if (!minerLive) { fmsg = `● synced — solo miner not running live · ${ver}`; fcol = "rgba(255,180,80,0.95)"; }
  else if (stalled) { fmsg = `● synced — miner not submitting (last ticket ${agoStr((Date.now() - lastTs) / 1000)}) · ${ver}`; fcol = "rgba(255,180,80,0.95)"; }
  // Mining IS live, and the node is also still verifying pre-snapshot history. Say both. Every other place
  // this appears is inside the BLOCKCHAIN SYNC panel, which is collapsed by default — so the busiest hours of
  // an install had no visible explanation anywhere on screen unless you went looking. Stays green: nothing is
  // wrong and nothing is blocked; the extra clause is the "why is my machine busy" answer, with a time.
  else if (backgroundVerify()) { const bv = backgroundVerify(), eta = backgroundVerifyEta(bv); fmsg = `◉ LIVE solo mining · verifying history ${(bv.progress * 100).toFixed(0)}%${eta ? ` · ${eta}` : ""} · ${ver}`; fcol = "rgba(90,220,140,0.95)"; }
  else { fmsg = `◉ LIVE solo mining — submits a block if it wins · ${ver}`; fcol = "rgba(90,220,140,0.95)"; } // ◉ (not ●) so LIVE differs from the amber 'synced' state by shape, not only colour
  text(fmsg, W - PAD, H - 14, { size: 13, weight: 700, color: fcol, align: "right", baseline: "middle" }); // the bottom-right corner is the version's again now the ambient control moved up beside the other view controls
  window.__footerPill = fmsg; // test hook: the right-hand status string
  let leftMsg = "";
  if (syncDemo) {
    leftMsg = "◉ SYNC DEMO — simulated · press D or Esc to exit (back to your live node)";
    text(leftMsg, PAD, H - 14, { size: 13, weight: 700, color: "rgba(90,210,140,0.95)", baseline: "middle" });
  } else if (managedSyncing) {
    // Managed node mid-setup: the SYNC panel already shows progress + disk, and the right pill shows "syncing
    // X%". A second fixed line on the left just overlaps the panel's disk readout, so we draw nothing here until
    // the node is ready — the payout appears once it's actually mining.
  } else if (!node) {
    // public / demo view — nobody is mining here, so DON'T show a payout warning (it reads as "your
    // rewards go to a stranger"). Explain what this is and how to take part.
    leftMsg = "◷ demo — real Bitcoin network · simulated tickets · run the miner to take a real shot";
    text(leftMsg, PAD, H - 14, { size: 13, weight: 700, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  } else if (symbolic) {
    // practice mode — real attempts, but no node and no rewards yet, so don't show a payout warning
    leftMsg = "◷ practice mode — no rewards yet · set up a node to take a real shot at a block";
    text(leftMsg, PAD, H - 14, { size: 13, weight: 700, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  } else {
    // a real local node IS present — show the actual payout (warn only if unset/invalid, where it matters)
    const pay = node.payout;
    const masked = (pay && pay.masked) || DEFAULT_PAYOUT_MASKED;
    const isDefault = pay ? pay.is_default : true;
    const status = pay ? (pay.status || (pay.valid ? "ok" : "invalid")) : "ok";
    let msg = `⛏ payout ${masked}`, col = "rgba(255,255,255,0.5)";
    if (status === "invalid") { msg = `⚠ payout ${masked} — that address looks invalid`; col = "rgba(255,120,90,0.95)"; }
    else if (isDefault) { msg = `⚠ no wallet set — rewards go to the dashboard owner (${masked})`; col = "rgba(255,180,80,0.95)"; }
    leftMsg = msg;
    text(msg, PAD, H - 14, { size: 13, weight: 700, color: col, baseline: "middle" });
  }
  window.__footerLeft = leftMsg; // test hook: the left-hand status string ("" when suppressed)

  // YOUR block → only CELEBRATE once it's confirmed in the chain. ws.status: pending | confirmed | lost.
  // (a found+submitted block is not a win — it can be a duplicate, rejected, or beaten to the chain.)
  const mnW = node && node.miner, ws = mnW && mnW.win_status; // {height, hash, status}
  if (seenConfirmedWin < 0) { if (mnW) seenConfirmedWin = (ws && ws.status === "confirmed") ? ws.height : 0; } // don't celebrate a win that predates this load
  else if (ws && ws.status === "confirmed" && ws.height > seenConfirmedWin) { seenConfirmedWin = ws.height; fireCelebration({ preview: false, mode: "you", verified: true, height: ws.height, hash: ws.hash }); }
  // NEW BEST → a small toast (mid-tier reward; fires once when the leading-zero record improves this session)
  const bestNow = mnW && mnW.best ? (mnW.best.zero_bits || 0) : 0;
  if (seenBest < 0) { if (mnW && mnW.best) seenBest = bestNow; } // wait for data, then remember the standing record
  else if (bestNow > seenBest) { seenBest = bestNow; if (!celebration.active) fireBestToast(bestNow, mnW.best.hash); }
  // NETWORK wins → everyone running this learns of it from the on-chain coinbase tag (no server)
  const netWins = lotteryWins();
  const haveBlocks = (model.recentBlocks && model.recentBlocks.length > 0) || !!(model.node && model.node.lottery_blocks);
  if (seenLottery === null) { if (haveBlocks) seenLottery = new Set(netWins.map((w) => w.height)); } // wait for data, then remember what predates this load — no retroactive celebration
  else for (const w of netWins) if (!seenLottery.has(w.height)) { seenLottery.add(w.height); if (w.verified && !celebration.active) fireCelebration({ mode: "network", verified: true, height: w.height, hash: w.hash }); } // only auto-celebrate locally-verified wins; unverified (mempool) ones just show the badge
  // scrim behind the fixed TOP controls (status pill, preview/motion/size) so scrolled panel content doesn't
  // collide with them once the header has scrolled up out of view. Mirrors the footer scrim. Only when scrolled.
  if (scrollY > 0) { const tGrad = ctx.createLinearGradient(0, 0, 0, 42); tGrad.addColorStop(0, "rgba(5,4,10,0.97)"); tGrad.addColorStop(0.62, "rgba(5,4,10,0.82)"); tGrad.addColorStop(1, "rgba(5,4,10,0)"); ctx.fillStyle = tGrad; ctx.fillRect(0, 0, W, 42); }
  if (!celebration.active) { drawMinerStatus(); drawPreviewTrigger(); drawUpdatePill(); drawGear(); drawMotionToggle(); drawZoomControl(); drawAmbientButton(); drawOfflineNotice(); drawBestToast(); if (!drawOwnWinStatus(ws)) drawNetWinBadge(netWins); } // your own pending/lost block takes priority over a network-win badge
  drawCelebration(); // on top of everything
  drawSyncedBanner(); // the brief "caught up — now mining" banner after sync completes
  drawConsensusBanner(); // persistent "network rule change detected" banner when the node flags unknown consensus rules
  drawHoverTooltip(); // hover details for ticket bars / the "you" marker — on top of everything

  clock += 0.02; if (!reduceMotion) frame = (frame + 1) % 3000000; // wrap (mult. of 32/4/3) so frame-derived phases never drift over a multi-day session; frozen under reduced-motion to still all glyph churn/sweeps
  quoteT += 1 / 60;
  if (quotePhase === "hold") { if (quoteT > Q_HOLD) { quotePhase = "decode"; quoteT = 0; quoteNext = nextQuoteIdx(quoteIdx); } }
  else if (quoteT > Q_DECODE) { quotePhase = "hold"; quoteT = 0; quoteIdx = quoteNext; }
  window.__q = { phase: quotePhase, idx: quoteIdx, next: quoteNext, bag: nextQuoteIdx.remaining() };
  // (the next frame is already scheduled at the top of render so the throttle/early-return path keeps looping)
}

// ---- interaction ----
let hoverSection = null, mouseX = -1, mouseY = -1;
function sectionAt(px, py) {
  for (const f of headerHits) { const r = f.header; if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return f.section; }
  return null;
}
const inHit = (h, x, y) => h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
// hover tooltip for ticket bars + the odds-map "you" marker — reveals each one's actual numbers so the
// relative bar heights (tickets) and the absolute position (odds map) can be reconciled.
function drawHoverTooltip() {
  if (celebration.active || mouseX < 0) return;
  const my = mouseY + scrollY;
  let lines = null;
  for (const h of ticketHits) if (mouseX >= h.x && mouseX <= h.x + h.w && my >= h.y && my <= h.y + h.h) { lines = h.lines; break; }
  if (!lines) for (const h of mempoolHits) if (mouseX >= h.x && mouseX <= h.x + h.w && my >= h.y && my <= h.y + h.h) { lines = h.lines; break; }
  if (!lines && youHit && mouseX >= youHit.x && mouseX <= youHit.x + youHit.w && my >= youHit.y && my <= youHit.y + youHit.h) lines = youHit.lines;
  if (!lines && bestHit && mouseX >= bestHit.x && mouseX <= bestHit.x + bestHit.w && my >= bestHit.y && my <= bestHit.y + bestHit.h) lines = bestHit.lines;
  if (!lines) return;
  const pad = 8, lh = 15;
  ctx.font = "600 11px -apple-system, system-ui, sans-serif";
  let bw = 0; for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
  bw += pad * 2; const bh = lines.length * lh + pad * 2 - 3;
  let bx = mouseX + 15, by = mouseY + 12;
  if (bx + bw > W - 4) bx = mouseX - bw - 15;
  if (by + bh > H - 4) by = mouseY - bh - 12;
  ctx.fillStyle = "rgba(12,10,22,0.96)"; roundRect(bx, by, bw, bh, 5); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; roundRect(bx, by, bw, bh, 5); ctx.stroke();
  lines.forEach((l, i) => text(l, bx + pad, by + pad + 7 + i * lh, { size: 11, weight: i === 0 ? 700 : 500, color: i === 0 ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.72)", baseline: "middle" }));
}
// map a pointer event into the zoom-scaled logical space the UI is laid out in (offsets & wheel deltas ÷ userScale)
function ptr(e) {
  if (userScale === 1) return e;
  const s = userScale;
  return new Proxy(e, { get(t, k) {
    if (k === "offsetX") return t.offsetX / s;
    if (k === "offsetY") return t.offsetY / s;
    if (k === "deltaX") return t.deltaX / s;
    if (k === "deltaY") return t.deltaY / s;
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
}
canvas.addEventListener("click", (ev) => { const e = ptr(ev);
  if (celebration.active) { celebration.active = false; return; } // dismiss
  if (inHit(winStatusHit, e.offsetX, e.offsetY)) { dismissedLost.add(winStatusHit.height); return; } // dismiss the 'lost the race' notice
  if (inHit(bestToastHit, e.offsetX, e.offsetY)) { bestToast.active = false; return; } // dismiss the new-best toast
  if (inHit(motionHit, e.offsetX, e.offsetY)) { cycleMotion(); return; } // cycle motion: full → calm → off
  if (inHit(zoomOutHit, e.offsetX, e.offsetY)) { setUserScale(userScale - 0.1); return; } // text size −
  if (inHit(zoomInHit, e.offsetX, e.offsetY)) { setUserScale(userScale + 0.1); return; } // text size +
  if (inHit(ambientHit, e.offsetX, e.offsetY)) { fetch("/ambient-open", { method: "POST" }).catch(() => {}); return; } // open the ambient view now, rather than waiting for the idle timer
  if (inHit(gearHit, e.offsetX, e.offsetY)) { window.location = "/setup?settings=1"; return; } // settings (desktop app)
  if (inHit(updatePillHit, e.offsetX, e.offsetY)) { fetch("/update/check", { method: "POST" }).catch(() => {}); return; } // "update available" pill → check + show install choice
  if (inHit(consensusHit, e.offsetX, e.offsetY)) { fetch("/update/check", { method: "POST" }).catch(() => {}); return; } // "network rule change" banner → check for an update that handles the new rules
  if (inHit(netWinHit, e.offsetX, e.offsetY)) { const w = netWinHit.win; fireCelebration({ mode: "network", verified: !!w.verified, height: w.height, hash: w.hash }); return; }
  if (inHit(winPreviewHit, e.offsetX, e.offsetY)) { // preview the win with a real winning block hash as illustration
    fireCelebration({ preview: true, height: (model.tipHeight || 0) + 1, hash: (model.block && model.block.id) || "" });
    return;
  }
  if (inHit(blockPreviewHit, e.offsetX, e.offsetY)) { mpPreview = true; syncPreview = true; if (!expanded.has("mempool")) { expanded.add("mempool"); saveExpanded(); refresh(); } scrollToSection = "mempool"; requestRender(); return; } // replay the block-mined animations — always open + scroll to the MEMPOOL harvest so the preview is visible wherever the user is (the sync commit is a bonus when that panel's open + at the tip). refresh() so the harvest has real mempool data even if the panel was collapsed (visibility-gated fetch)
  if (expanded.has("hashInside") && inHit(hashInputHit, e.offsetX, e.offsetY + scrollY)) { hashViz.focused = true; requestRender(); return; } // focus the hash input
  if (expanded.has("churn")) { // THE CHURN transport: speed · pause/play · step ONE mix sub-step at a time
    const cyc = e.offsetY + scrollY;
    const cycOf = (sp) => CHURN_DUP_MS + CHURN_SHIFT_MS + CHURN_MIX_MS / sp, seOf = (sp) => (CHURN_DUP_MS + CHURN_SHIFT_MS) / cycOf(sp);
    const effC = cycOf(churnSpeed), se = seOf(churnSpeed);
    const enter = () => { const p = (churnLiveNow % effC) / effC; churnNow = p >= se ? churnLiveNow : Math.floor(churnLiveNow / effC) * effC + Math.round((se + 0.004) * effC); };
    const boundNow = (rb, s) => rb * effC + (se + (CHURN_STEP_CUM[Math.max(0, Math.min(16, s))] / CHURN_MIX_MS) * (1 - se)) * effC + 3; // churnNow at the start of mix step s
    const stepAt = (now) => { const p = (now % effC) / effC; if (p < se) return -1; const mt = (p - se) / (1 - se) * CHURN_MIX_MS; let s = 0; while (s < 15 && CHURN_STEP_CUM[s + 1] <= mt) s++; return s; };
    if (inHit(churnSpeedHit, e.offsetX, cyc)) { const old = churnSpeed; churnSpeed = churnSpeed === 4 ? 2 : churnSpeed === 2 ? 1 : churnSpeed === 1 ? 0.5 : churnSpeed === 0.5 ? 0.25 : 4;
      if (churnPaused) { const oc = cycOf(old), nc = cycOf(churnSpeed), rb = Math.floor(churnNow / oc), po = (churnNow % oc) / oc, so = seOf(old), sn = seOf(churnSpeed), pn = po >= so ? sn + (po - so) / (1 - so) * (1 - sn) : po * sn / so; churnNow = rb * nc + pn * nc; }
      requestRender(); return; }
    if (inHit(churnPlayHit, e.offsetX, cyc)) { churnPaused = !churnPaused; if (churnPaused) enter(); requestRender(); return; }
    if (inHit(churnBackHit, e.offsetX, cyc)) { if (!churnPaused) { churnPaused = true; enter(); } const rb = Math.floor(churnNow / effC), cs = stepAt(churnNow); churnNow = cs > 0 ? boundNow(rb, cs - 1) : (rb > 0 ? boundNow(rb - 1, 15) : boundNow(rb, 0)); requestRender(); return; }
    if (inHit(churnFwdHit, e.offsetX, cyc)) { if (!churnPaused) { churnPaused = true; enter(); } const rb = Math.floor(churnNow / effC), cs = stepAt(churnNow); churnNow = cs < 0 ? boundNow(rb, 0) : (cs < 15 ? boundNow(rb, cs + 1) : boundNow(rb + 1, 0)); requestRender(); return; }
  }
  if (expanded.has("fold")) { // THE FOLD transport: play/pause · step keyframe by keyframe (stepping pauses)
    const cyc = e.offsetY + scrollY, stepFold = (dir) => { const i = Math.floor(foldT / FOLD_UNIT), ni = ((i + dir) % FOLD_KFS.length + FOLD_KFS.length) % FOLD_KFS.length; foldT = ni * FOLD_UNIT; };
    if (inHit(foldPlayHit, e.offsetX, cyc)) { foldPaused = !foldPaused; if (foldPaused) foldT = Math.floor(foldT / FOLD_UNIT) * FOLD_UNIT; requestRender(); return; }
    if (inHit(foldBackHit, e.offsetX, cyc)) { foldPaused = true; stepFold(-1); requestRender(); return; }
    if (inHit(foldFwdHit, e.offsetX, cyc)) { foldPaused = true; stepFold(1); requestRender(); return; }
  }
  if (expanded.has("updates")) { // VERIFIED UPDATES transport: play/pause · step through the 6 verification steps
    const cyc = e.offsetY + scrollY, curStep = () => updAutoStep(Date.now());
    if (inHit(updPlayHit, e.offsetX, cyc)) { if (!updPaused) updStep = curStep(); updPaused = !updPaused; requestRender(); return; }
    if (inHit(updBackHit, e.offsetX, cyc)) { if (!updPaused) { updStep = curStep(); updPaused = true; } updStep = (updStep + 5) % 6; requestRender(); return; }
    if (inHit(updFwdHit, e.offsetX, cyc)) { if (!updPaused) { updStep = curStep(); updPaused = true; } updStep = (updStep + 1) % 6; requestRender(); return; }
  }
  hashViz.focused = false; // any other click blurs it
  const s = sectionAt(e.offsetX, e.offsetY + scrollY);
  if (s) {
    const wasOpen = expanded.has(s);
    if (wasOpen) expanded.delete(s); else expanded.add(s);
    saveExpanded();
    // Opening MEMPOOL/MERKLE now: their data is fetched only while visible (see refresh's visibility gate), so
    // pull it immediately instead of leaving the just-opened panel empty until the next 30s tick.
    if (!wasOpen && (s === "mempool" || s === "merkle")) refresh();
  }
});
canvas.addEventListener("mousemove", (ev) => { const e = ptr(ev);
  mouseX = e.offsetX; mouseY = e.offsetY;
  hoverSection = sectionAt(e.offsetX, e.offsetY + scrollY);
  const cyc = e.offsetY + scrollY, churnBtn = expanded.has("churn") && (inHit(churnPlayHit, e.offsetX, cyc) || inHit(churnBackHit, e.offsetX, cyc) || inHit(churnFwdHit, e.offsetX, cyc)), foldBtn = expanded.has("fold") && (inHit(foldPlayHit, e.offsetX, cyc) || inHit(foldBackHit, e.offsetX, cyc) || inHit(foldFwdHit, e.offsetX, cyc)), updBtn = expanded.has("updates") && (inHit(updPlayHit, e.offsetX, cyc) || inHit(updBackHit, e.offsetX, cyc) || inHit(updFwdHit, e.offsetX, cyc));
  canvas.classList.toggle("clickable", !!hoverSection || churnBtn || foldBtn || updBtn || celebration.active || inHit(winPreviewHit, e.offsetX, e.offsetY) || inHit(blockPreviewHit, e.offsetX, e.offsetY) || inHit(gearHit, e.offsetX, e.offsetY) || inHit(motionHit, e.offsetX, e.offsetY) || inHit(zoomOutHit, e.offsetX, e.offsetY) || inHit(zoomInHit, e.offsetX, e.offsetY) || inHit(ambientHit, e.offsetX, e.offsetY) || inHit(netWinHit, e.offsetX, e.offsetY) || inHit(bestToastHit, e.offsetX, e.offsetY) || inHit(winStatusHit, e.offsetX, e.offsetY) || inHit(updatePillHit, e.offsetX, e.offsetY) || inHit(consensusHit, e.offsetX, e.offsetY));
});
canvas.addEventListener("wheel", (ev) => { const e = ptr(ev);
  if (maxScroll <= 0) return;
  e.preventDefault();
  scrollY = Math.max(0, Math.min(scrollY + e.deltaY, maxScroll));
}, { passive: false });
// In "motion: off" the loop idles at 1fps, so poke an immediate repaint on any interaction — hover
// highlights, scrolling, clicks and key handling stay instant without keeping the animation loop hot.
["mousemove", "wheel", "click", "pointerdown"].forEach((ev) => canvas.addEventListener(ev, requestRender, { passive: true }));
window.addEventListener("keydown", requestRender);
window.addEventListener("resize", requestRender);

// ---- boot ----
window.__model = model; window.__refresh = refresh; // test hooks (like __frames above) — let the e2e suite read live state / force a refetch
// Test hook: place the quote rotation at a chosen point in its cycle and repaint. A test cannot simply WAIT for
// a transition — headless Chromium reports the page hidden, which cancels the rAF loop (see requestRender), so
// quoteT never advances and the 11s hold never elapses. This drives the frame directly instead.
window.__quoteJump = (phase, t, next) => { quotePhase = phase; quoteT = t; if (next != null) quoteNext = next; requestRender(); };
window.__expand = (s) => { if (!expanded.has(s)) { expanded.add(s); saveExpanded(); if (s === "mempool" || s === "merkle") refresh(); requestRender(); } }; // e2e: simulate opening a panel (fires the on-open fetch)
resize();
pollNode();
refresh();
loadHistory();
setInterval(pollNode, 3_000);
setInterval(refresh, REFRESH_MS);
setInterval(loadHistory, 300_000);
pollBlockTimes();
setInterval(pollBlockTimes, 120_000);
render();
