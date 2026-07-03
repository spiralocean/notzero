// Bitcoin Lottery — browser dashboard (cross-platform port of the macOS viz).
// Self-contained: public chain/price data from mempool.space + a client-side
// SHA-256 hash visualization (Web Crypto). No backend.

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
const SECTIONS = ["nextBlock", "mempool", "closeness", "tickets", "hashBuild", "hashInside", "bitOps", "oneRound", "network", "sync"];
const SECTION_TITLE = { nextBlock: "NEXT BLOCK", mempool: "MEMPOOL", closeness: "YOUR CLOSENESS", tickets: "YOUR TICKETS", hashBuild: "HASH BUILD", hashInside: "INSIDE THE HASH", oneRound: "ONE ROUND", bitOps: "BIT OPERATIONS", network: "NETWORK", sync: "BLOCKCHAIN SYNC" };
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

// ---- model ----
const model = { tipHeight: null, block: null, txCount: null, price: null, hashrateEh: null, difficulty: null, diffAdjust: null, miningSeries: null, ticket: null, error: null, priceHistory: [], hashrateHistory: [], recentBlocks: [], node: null, mempool: null, bwHistory: [], recentTxs: [], fees: null };
let bwLast = null; // last getnettotals sample, to derive the rate between polls

async function loadHistory() {
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

// Same-origin feed from your local node (written by the bridge from bitcoind:
// getpeerinfo / getblockchaininfo). No external query; 404/error → no node data.
// Polled on its own fast cadence so head + per-peer rates stay fresh and the fill flows.
async function pollNode() {
  if (typeof syncDemo !== "undefined" && syncDemo) return; // demo mode supplies model.node itself
  try {
    const r = await fetch("./node.json", { cache: "no-store" });
    model.node = r.ok ? await r.json() : null;
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

async function refresh() {
  try {
    const tipHash = await (await fetch(`${API}/blocks/tip/hash`)).text();
    const blk = await (await fetch(`${API}/block/${tipHash}`)).json();
    model.tipHeight = blk.height;
    model.block = blk;
    model.txCount = blk.tx_count;
    model.difficulty = blk.difficulty;

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

    fetch(`${API}/v1/blocks`).then((r) => r.json()).then((arr) => {
      if (Array.isArray(arr)) model.recentBlocks = arr.slice(0, 8).reverse().map((b) => ({ height: b.height, id: b.id, tx: b.tx_count, size: b.size, pool: b.extras?.pool?.name, lottery: coinbaseHasLotteryTag(b.extras?.coinbaseRaw) }));
    }).catch(() => {});
    fetch(`${API}/v1/prices`).then((r) => r.json()).then((p) => { if (p && p.USD) model.price = p.USD; }).catch(() => {});
    fetch(`${API}/v1/mining/hashrate/3d`).then((r) => r.json()).then((h) => { if (h && h.currentHashrate) model.hashrateEh = h.currentHashrate / 1e18; }).catch(() => {});
    fetch(`${API}/v1/difficulty-adjustment`).then((r) => r.json()).then((d) => { if (d && d.remainingBlocks != null) model.diffAdjust = d; }).catch(() => {}); // #2: next-difficulty estimate + timing
    // mempool: the pending-tx pool the next block is packed from — count, fee distribution, and the
    // projected upcoming blocks (mempool.space's mempool-blocks). Feeds the live tx-flow viz.
    Promise.all([
      fetch(`${API}/mempool`).then((r) => r.json()).catch(() => null),
      fetch(`${API}/v1/fees/mempool-blocks`).then((r) => r.json()).catch(() => null),
    ]).then(([mp, blocks]) => {
      if (mp && mp.count != null) model.mempool = { count: mp.count, vsize: mp.vsize, hist: mp.fee_histogram || [], blocks: Array.isArray(blocks) ? blocks : (model.mempool?.blocks || []) };
    }).catch(() => {});
    // the actual most-recent transactions — real fee/size/value, used to spawn the live particles + spotlight whales
    fetch(`${API}/mempool/recent`).then((r) => r.json()).then((txs) => { if (Array.isArray(txs)) model.recentTxs = txs.filter((t) => t && t.vsize); }).catch(() => {});
    fetch(`${API}/v1/fees/recommended`).then((r) => r.json()).then((f) => { if (f && f.fastestFee != null) model.fees = f; }).catch(() => {}); // next-block fee → "fee weather"
    model.error = null;
  } catch (e) {
    model.error = "Couldn't reach mempool.space — retrying…";
  }
}

// ---- canvas / painter ----
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
let rafId = 0, lastDraw = 0;
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
  { q: "'Impossible'? I do not think it means what you think it means.", src: "Inigo Montoya, The Princess Bride" },
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
const PAD = 36, HEADER_H = 40, GAP = 12, TOP = 116;
const CONTENT_H = { nextBlock: 150, mempool: 224, closeness: 250, tickets: 180, hashBuild: 340, hashInside: 356, oneRound: 340, bitOps: 292, network: 180, sync: 540 };
let headerHits = [];
let hashInputHit = null; // click region for the INSIDE THE HASH typeable input (in scrolled content coords)
// --- WIN celebration: the payoff of "not zero". Auto-fires when a real win lands; previewable on
// demand via the top-right control (you would otherwise never get to see it). ---
const celebration = { active: false, t: 0, preview: false, mode: "you", verified: true, height: 0, hash: "", reward: 3.125 };
let seenConfirmedWin = -1, winPreviewHit = null, netWinHit = null, winStatusHit = null, gearHit = null, blockPreviewHit = null, motionHit = null;
let mpPreview = false, syncPreview = false; // "preview a block" → replay the mempool harvest + the sync's mined-block commit
// the desktop app serves a /config endpoint; the public web build doesn't — so this both detects "are we in
// the desktop app" and gates the settings gear (which navigates to /setup, a desktop-only route).
let isDesktop = false, appVersion = "", nodeMode = "", desktopPlatform = "";
fetch("./config").then((r) => (r.ok ? r.json() : null)).then((c) => { if (c && typeof c.exists === "boolean") { isDesktop = true; if (c.app_version) appVersion = c.app_version; if (c.node_mode) nodeMode = c.node_mode; if (c.platform) desktopPlatform = c.platform; } }).catch(() => {});
const dismissedLost = new Set(); // heights whose 'lost the race' notice the user has dismissed
const blockSubsidy = (h) => 50 / Math.pow(2, Math.floor((h || 0) / 210000));
function fireCelebration({ preview = false, mode = "you", verified = true, height = 0, hash = "", reward } = {}) {
  Object.assign(celebration, { active: true, t: 0, preview, mode, verified, height: height || 0, hash: hash || "", reward: reward != null ? reward : blockSubsidy(height) });
}
// new-best toast: a small, non-intrusive reward when the miner beats its own leading-zero record
// (the mid-tier rung: everyday attempts → new best → a lottery miner wins → you win)
let seenBest = -1, bestToastHit = null;
const bestToast = { t: 0, active: false, bits: 0 };
function fireBestToast(bits) { bestToast.active = true; bestToast.t = 0; bestToast.bits = bits; } // persists until clicked
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
let scrollY = 0, maxScroll = 0;
const FOOTER_PAD = 44; // bottom clearance under the scrollable content so the fixed footer never sits on a panel
let clock = 0, quoteIdx = (Math.random() * QUOTES.length) | 0, quoteT = 0, frame = 0, quoteNext = 1, quotePhase = "hold"; // random start so refresh doesn't always begin at the first quote
const Q_HOLD = 11, Q_DECODE = 1.7; // seconds: show the quote, then decode the next out of glyphs
// shuffle-bag: random order, but every quote is shown once before any repeats
let quoteBag = [];
function nextQuoteIdx(curr) {
  if (!quoteBag.length) {
    quoteBag = QUOTES.map((_, i) => i).filter((i) => i !== curr); // refill (skip the current so it doesn't repeat back-to-back)
    for (let i = quoteBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [quoteBag[i], quoteBag[j]] = [quoteBag[j], quoteBag[i]]; }
  }
  return quoteBag.pop();
}
// render a quote mid-transition: the target resolves left-to-right out of scrambling matrix glyphs
function drawDecodeQuote(to, p, alpha, seed) {
  ctx.font = "600 16px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const total = to.length, charW = ctx.measureText("0").width, startX = W / 2 - (total * charW) / 2 + charW / 2;
  for (let i = 0; i < total; i++) {
    if (to[i] === " ") continue;
    const x = startX + i * charW, th = revealThresh(seed + 1, i); // each char resolves at its own moment → scattered, not left-to-right
    if (p >= th + 0.1) { ctx.fillStyle = `rgba(255,255,255,${alpha})`; ctx.fillText(to[i], x, 80); }                                    // resolved
    else if (p >= th) { ctx.fillStyle = `rgba(${ACCENT},0.9)`; ctx.fillText(CYBER[(frame * 2 + i * 9) % CYBER.length], x, 80); }        // decoding now
    else { ctx.fillStyle = `rgba(70,190,140,${alpha * 0.8})`; ctx.fillText("0123456789abcdef"[(frame + i * 5) % 16], x, 80); }          // not yet decoded
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
// `everSynced` (persisted): has this machine ever caught up to the tip? Gates the focused sync view.
let everSynced = false;
try { everSynced = localStorage.getItem("bl.everSynced") === "1"; } catch {}
function visibleSections() {
  // Hide the mining panels ONLY during the initial sync (or a genuine re-IBD), to focus the view while the
  // chain first downloads. Once the node has synced once, a transient desync (sleep / flush) keeps every panel
  // in place so the dashboard never reflows/jumps — the sync panel just shows "catching up" inline.
  const si = syncInfo(), n = model.node;
  const initialSync = !!(si && si.syncing && (!everSynced || (n && n.initialblockdownload)));
  return initialSync ? ["sync", "network"] : SECTIONS;
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

function layoutSections() {
  let y = TOP; const frames = [];
  for (const s of visibleSections()) {
    const header = { x: PAD, y, w: W - PAD * 2, h: HEADER_H };
    y += HEADER_H;
    let content = null;
    const open = expanded.has(s);
    if (open) { const h = CONTENT_H[s]; content = { x: PAD, y: y + 4, w: W - PAD * 2, h }; y += 4 + h; }
    y += GAP;
    frames.push({ section: s, header, content });
  }
  return { frames, total: y };
}

function summary(s) {
  if (s === "nextBlock") { if (!model.block) return "—"; const e = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp)); return `${Math.floor(e / 60)}:${String(e % 60).padStart(2, "0")} since last`; }
  if (s === "mempool") { const mp = model.mempool; return mp ? `${mp.count.toLocaleString()} pending · ~${(mp.blocks || []).length} blocks deep` : "—"; }
  if (s === "closeness") { const p = model.ticket?.prox; return p ? (p.won ? "TARGET HIT" : `${p.label} · ${p.leadingZeroBits} zero bits`) : "—"; }
  if (s === "tickets") { const h = model.node?.miner?.history; if (!h || !h.length) return "—"; const span = h[0].h - h[h.length - 1].h + 1; const u = h.filter((e) => e.w && !e.s).length; return `${h.length} tickets · ${Math.max(0, span - h.length)} missed${u ? ` · ⚠ ${u}` : ""}`; }
  if (s === "hashBuild") { return model.ticket ? "your ticket 0x" + model.ticket.hashHex.slice(0, 24) + "…" : "—"; }
  if (s === "hashInside") { return "SHA-256 · type to hash live"; }
  if (s === "oneRound") { return "Σ · Ch · Maj → new a, e"; }
  if (s === "bitOps") { return "rotate · XOR · AND · add"; }
  if (s === "sync") { return "gather → verify → link → prune"; }
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
    if (si && si.syncing) {
      const bw2 = 110, bx = r.x + r.w - 14 - bw2, byc = r.y + r.h / 2;
      text(`${(si.prog * 100).toFixed(1)}%`, bx - 8, byc, { size: 12, weight: 600, color: "rgba(255,255,255,0.7)", align: "right", baseline: "middle" });
      ctx.fillStyle = "rgba(255,255,255,0.12)"; roundRect(bx, byc - 3, bw2, 6, 3); ctx.fill();
      ctx.fillStyle = `rgba(${ACCENT},0.85)`; roundRect(bx, byc - 3, Math.max(4, bw2 * si.prog), 6, 3); ctx.fill();
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
  // (downtime) are visible. Cap the span at ~300 blocks (~2 days): enough to show sleep gaps in context, but a
  // long outage can't stretch the strip endlessly — it clamps to the most recent blocks (and says so). Also
  // clamp on narrow windows so bars stay ≥~4px wide rather than compressing the gaps away.
  const MAXSLOTS = Math.min(300, Math.max(40, Math.floor(w / 4)));
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
  for (let i = 0; i < 512; i++) { ctx.fillStyle = i < msgBits ? "rgba(120,200,255,0.7)" : i === msgBits ? "rgba(255,215,90,1)" : i >= 512 - 64 ? "rgba(180,140,255,0.85)" : DIM; ctx.fillRect(x0 + i * cwp, y + 10, Math.max(0.8, cwp - 0.25), 10); }
  text("your message", x0 + (msgBits / 2) * cwp, y + 32, { size: 8, color: "rgba(120,200,255,0.75)", align: "center", baseline: "middle" });
  text("↑ one 1", oneX + 16, y + 32, { size: 8, weight: 700, color: "rgba(255,215,90,0.95)", baseline: "middle" });
  text("just zeros (fill)", x0 + ((msgBits + 448) / 2) * cwp, y + 32, { size: 8, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" });
  text("64-bit length", x0 + (512 - 32) * cwp, y + 32, { size: 8, color: "rgba(180,140,255,0.85)", align: "center", baseline: "middle" });

  // 3 · the engine — 8 registers churning over 64 rounds (changed bits flash gold)
  y = r.y + 178;
  const rnd = reduceMotion ? 40 : (() => { const t = Date.now() % 9000; return t < 6500 ? Math.min(63, Math.floor((t / 6500) * 64)) : 63; })();
  text(`3 · 64 ROUNDS OF MIXING — round ${rnd + 1} / 64`, x0, y, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
  text("just rotate ⟲ · XOR ⊕ · AND ∧ · add ➕ — unpacked in ONE ROUND below", x1, y, { size: 10, weight: 600, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" });
  const regs = d.rounds[rnd], prev = rnd > 0 ? d.rounds[rnd - 1] : null, names = "abcdefgh";
  const barX = x0 + 16, cwr = (w - 16) / 32;
  for (let i = 0; i < 8; i++) {
    const ry = y + 14 + i * 11;
    text(names[i], x0, ry + 4, { size: 10, weight: 700, color: "rgba(255,255,255,0.5)", baseline: "middle", mono: true });
    for (let bit = 0; bit < 32; bit++) {
      const on = (regs[i] >>> (31 - bit)) & 1, changed = prev && ((regs[i] ^ prev[i]) >>> (31 - bit)) & 1;
      ctx.fillStyle = changed ? (on ? "rgba(255,215,90,1)" : "rgba(255,215,90,0.22)") : (on ? "rgba(90,220,140,0.9)" : DIM);
      ctx.fillRect(barX + bit * cwr + 0.5, ry, Math.max(1, cwr - 1), 8);
    }
  }

  // 4 · the hash
  y = r.y + r.h - 30;
  text("4 · THE 256-BIT HASH — every tx, block & address in Bitcoin is one of these", x0, y - 15, { size: 10, weight: 700, color: BLUE, baseline: "middle" });
  const lead = leadingZeroHexChars(d.digest), dcw = w / 64;
  for (let i = 0; i < 64; i++) { const z = i < lead; text(d.digest[i], x0 + dcw * (i + 0.5), y, { size: 11, weight: z ? 700 : 600, color: z ? "rgba(255,215,90,1)" : "rgba(90,235,150,0.92)", align: "center", baseline: "middle", mono: true }); }
}

// ONE ROUND, UNPACKED — the exact fixed recipe each of the 64 rounds runs (Σ0/Σ1, Ch, Maj, +K +W → two new
// registers), with live 32-bit bars. Shows HOW the four ops are arranged into a round — the same every round.
function drawOneRound(r) {
  const pad = 16, x0 = r.x + pad, x1 = r.x + r.w - pad, w = x1 - x0, d = hashViz.data;
  const BL = "rgba(120,200,255,0.85)", GR = "rgba(90,235,150,0.95)", GO = "rgba(255,215,90,0.95)";
  const t = 1; // ONE fixed round, held static and shown in full — every one of the 64 runs this same recipe
  text("ONE ROUND, UNPACKED — the exact recipe every round runs (here: round 1 of 64, held so you can study it)", x0, r.y + 16, { size: 13, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
  text("a–h are the round's 8 “working registers” — 32-bit numbers carried in from the previous round. Two mixes rebuild registers a & e; the other six just shift down a slot.", x0, r.y + 34, { size: 11, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  const keyY = r.y + 52, key = (kx, c, lab) => { ctx.fillStyle = c; ctx.fillRect(kx, keyY - 5, 10, 10); text(lab, kx + 14, keyY, { size: 10, color: "rgba(255,255,255,0.5)", baseline: "middle" }); return kx + 14 + ctx.measureText(lab).width + 22; };
  let kx = x0; kx = key(kx, BL, "mixing step"); kx = key(kx, GO, "T1 / T2 (being built)"); key(kx, GR, "the new register");
  if (!d) return;
  const inp = t === 0 ? _SHA_H0 : d.rounds[t - 1];
  const a = inp[0], b = inp[1], c = inp[2], dd = inp[3], e = inp[4], f = inp[5], g = inp[6], h = inp[7];
  const S1 = (_rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)) >>> 0, ch = ((e & f) ^ (~e & g)) >>> 0;
  const T1 = (h + S1 + ch + _SHA_K[t] + d.W[t]) >>> 0;
  const S0 = (_rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)) >>> 0, maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0, T2 = (S0 + maj) >>> 0;
  const newA = (T1 + T2) >>> 0, newE = (dd + T1) >>> 0;
  // show the 8 registers going IN, so "e", "a", "f"… below aren't mystery letters (a & e — the two rebuilt — in gold)
  const sy = r.y + 68;
  text("INPUT — the round's 8 working registers, carried in from the previous round:", x0, sy, { size: 10, color: "rgba(255,255,255,0.55)", baseline: "middle" });
  { const regs8 = [a, b, c, dd, e, f, g, h], names8 = "abcdefgh", rgap = 10, rbW = (w - rgap * 7) / 8;
    for (let i = 0; i < 8; i++) {
      const rx = x0 + i * (rbW + rgap), hot = (i === 0 || i === 4), rcw = rbW / 32;
      text(names8[i], rx + rbW / 2, sy + 16, { size: 11, weight: 700, color: hot ? GO : "rgba(255,255,255,0.75)", align: "center", baseline: "middle", mono: true });
      for (let q = 0; q < 32; q++) { ctx.fillStyle = ((regs8[i] >>> (31 - q)) & 1) ? (hot ? "rgba(255,215,90,0.85)" : "rgba(150,175,220,0.8)") : "rgba(255,255,255,0.06)"; ctx.fillRect(rx + q * rcw, sy + 23, Math.max(0.8, rcw - 0.3), 8); }
    }
  }
  const lx = x0, barX = x0 + 210, cw = (w - 210) / 32;
  const bar = (by, val, on) => { for (let i = 0; i < 32; i++) { ctx.fillStyle = ((val >>> (31 - i)) & 1) ? on : "rgba(255,255,255,0.06)"; ctx.fillRect(barX + i * cw + 0.5, by, Math.max(1, cw - 1), 10); } };
  // each row: bold left label (what it computes) + a plain-English sub (what it means) + the 32-bit result bar
  const line = (yy, label, val, on, sub) => { text(label, lx, yy + 5, { size: 12.5, weight: 600, color: "rgba(255,255,255,0.85)", baseline: "middle", mono: true }); if (sub) text(sub, lx, yy + 20, { size: 10.5, color: "rgba(255,255,255,0.46)", baseline: "middle" }); bar(yy, val, on); };
  const rows = [
    ["Σ1 = e⟲6 ⊕ e⟲11 ⊕ e⟲25", S1, BL, "scramble register e (rotate + XOR)", 26, false],
    ["Ch = (e∧f) ⊕ (¬e∧g)", ch, BL, "“choose”: each bit of e picks register f or g", 26, false],
    ["T1 = h + Σ1 + Ch + K + W", T1, GO, "brings in constant K + your message word W", 28, false],
    ["Σ0 = a⟲2 ⊕ a⟲13 ⊕ a⟲22", S0, BL, "scramble register a (rotate + XOR)", 26, false],
    ["Maj = maj(a,b,c)", maj, BL, "“majority”: each bit = the majority of registers a, b, c", 26, false],
    ["T2 = Σ0 + Maj", T2, GO, "", 26, true],
    ["new a = T1 + T2", newA, GR, "the round's brand-new register a", 26, false],
    ["new e = d + T1", newE, GR, "old register d, plus T1", 26, false],
  ];
  let y = r.y + 110;
  for (let i = 0; i < rows.length; i++) {
    const [label, val, on, sub, gap, divAfter] = rows[i];
    line(y, label, val, on, sub);
    y += gap;
    if (divAfter) { ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y - 10); ctx.lineTo(x1, y - 10); ctx.stroke(); } // divider before the new registers
  }
  text("…then everything shifts down one — b←a · c←b · d←c · f←e · g←f · h←g. That's the whole round; all 64 run this same recipe.", x0, y, { size: 11, color: "rgba(255,255,255,0.45)", baseline: "middle" });
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
  // ── add — its own box. Carries ACROSS columns, so the zoom shows the carry rule (not one bar column)
  card(top, BIN_H);
  { const hy = top + 11, aa = top + 22, bb = top + 31, ar = top + 41;
    head(hy, "➕ add", "add as numbers; when a column overflows it carries into the next (top carry wraps, mod 2³²)");
    rlbl(aa, "A", IN); row(aa, A, IN);
    rlbl(bb, "+ B", B2); row(bb, B, B2);
    divline(ar - 2); rlbl(ar, "=", OUT); row(ar, (A + B) >>> 0, OUT);
    const my = (aa + ar) / 2 + 3, cy = my - S / 2;
    text("this op, one column:", ex0, aa - 3, { size: 8.5, color: dim, baseline: "middle" });
    cell(ex0, cy, 1, IN); glyph(ex0 + 30, my, "+"); cell(ex0 + 42, cy, 1, B2); glyph(ex0 + 72, my, "=");
    cell(ex0 + 84, cy, 1, OUT); cell(ex0 + 106, cy, 0, OUT);
    text("↑ carry", ex0 + 84, my + 15, { size: 8, color: G, baseline: "middle" });
  }
  top += BIN_H + GAP;
  text("these are the TOOLS, not the order — ONE ROUND (below) shows how they're combined into the recipe, run 64× until it looks random", x0, top + 4, { size: 10, color: "rgba(255,255,255,0.45)", baseline: "middle" });
}

function drawContent(s, r) {
  if (s === "nextBlock") return drawNextBlock(r);
  if (s === "mempool") return drawMempool(r);
  if (s === "closeness") return drawCloseness(r);
  if (s === "tickets") return drawTickets(r);
  if (s === "hashBuild") return drawHashBuild(r);
  if (s === "hashInside") return drawHashInside(r);
  if (s === "oneRound") return drawOneRound(r);
  if (s === "bitOps") return drawBitOps(r);
  if (s === "network") return drawNetwork(r);
  if (s === "sync") return drawSync(r);
}

function drawNextBlock(r) {
  if (!model.block) { text("waiting…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  const cx = r.x + 78, cy = r.y + r.h / 2, rad = 52;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp));
  const over = elapsed > 600; // past the ~10-min estimate — count UP the overrun (long blocks are normal: Poisson)
  const progress = Math.min(1, elapsed / 600);
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = over ? "rgba(255,180,80,0.95)" : `rgba(${ACCENT}, 0.9)`; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); ctx.stroke(); ctx.lineCap = "butt";
  const disp = over ? elapsed - 600 : 600 - elapsed;
  const ringTxt = `${over ? "+" : ""}${Math.floor(disp / 60)}:${String(disp % 60).padStart(2, "0")}`;
  let ringSize = 22; ctx.font = `700 ${ringSize}px ui-monospace, monospace`; // fit inside the ring for unusually long intervals
  while (ctx.measureText(ringTxt).width > rad * 1.7 && ringSize > 12) { ringSize--; ctx.font = `700 ${ringSize}px ui-monospace, monospace`; }
  text(ringTxt, cx, cy, { size: ringSize, weight: 700, color: over ? "rgba(255,190,90,1)" : "#fff", align: "center", baseline: "middle", mono: true });
  text(over ? "over ~10 min est" : "next block (est)", cx, cy + rad + 16, { size: 14, color: over ? "rgba(255,180,80,0.8)" : "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
  const rows = [["Elapsed", `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`], ["Avg block", "~10:00"], ["Last block", "#" + model.tipHeight.toLocaleString()]];
  let sy = cy - 38;
  for (const [l, v] of rows) { text(l, r.x + 200, sy, { size: 15, color: "rgba(255,255,255,0.5)", baseline: "middle" }); text(v, r.x + 340, sy, { size: 15, weight: 600, color: "rgba(255,255,255,0.85)", baseline: "middle" }); sy += 32; }
  if (over) text("long blocks are normal — ~37% run past 10 min, ~5% past 30", r.x + 192, r.y + r.h - 16, { size: 11, color: "rgba(255,180,80,0.72)", baseline: "middle" });
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

  const padX = 20, top = r.y + 54, bot = r.y + r.h - 38, maxBH = bot - top, gap = 10;
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
    for (let i = 0; i < nHist; i++) { const blk = hist[i]; drawConfirmed(baseX(i), Math.max(20, maxBH * sizeH(blk)), blk.height, blk.tx, 1, false); }
  }
  if (nHist) text("mined · the chain ◂", r.x + padX, top - 22, { size: 10, color: "rgba(90,200,130,0.6)", baseline: "middle" });

  // --- the "now" divider ---
  if (nHist) {
    const divX = r.x + padX + histW + dividerW / 2 - gap / 2 + slide;
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(divX, top - 16); ctx.lineTo(divX, bot + 4); ctx.stroke(); ctx.setLineDash([]);
    text("now", divX, top - 26, { size: 10, weight: 700, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
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
  if (mpHarvestT > 0) text(`⛏ block #${mpHarvestTip.toLocaleString()} mined — ${mpHarvestTx.toLocaleString()} txs confirmed`, r.x + r.w / 2, r.y + 38, { size: 12, weight: 700, color: `rgba(90,225,140,${Math.min(1, mpHarvestT * 1.6)})`, align: "center", baseline: "middle" });

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

function drawCloseness(r) {
  // LIVE: compare your daemon's real last attempt to a winning block — the leading-zero "wall" tells the story
  const mn = model.node && model.node.miner, at = mn && mn.attempt;
  if (at && at.hash) {
    const winner = (model.block && model.block.id) || "";
    const need = leadingZeroHexChars(at.target || winner || ""), youZ = leadingZeroHexChars(at.hash);
    text("YOUR LIVE ATTEMPT vs THE TARGET & WINNING BLOCK", r.x + 16, r.y + 16, { size: 12, weight: 700, color: "rgba(255,255,255,0.62)", baseline: "middle" });
    const rowX = r.x + 16, hx0 = rowX + 58, n = 64, rowW = r.w - 340, sp = rowW / n; // full 64-hex so it matches the HASH BUILD final hash exactly; leave room on the right for the "· N zeros · won by …" sub
    const row = (label, hex, y, lit, sub) => {
      text(label, rowX, y, { size: 11, weight: 600, color: "rgba(255,255,255,0.5)", baseline: "middle" });
      const lead = leadingZeroHexChars(hex), show = hex.slice(0, n);
      for (let i = 0; i < show.length; i++) { const z = i < lead; text(show[i], hx0 + sp * (i + 0.5), y, { size: 13, weight: z ? 700 : 400, color: z ? lit : "rgba(255,255,255,0.4)", align: "center", baseline: "middle", mono: true }); }
      text(sub, r.x + r.w - 16, y, { size: 11, weight: 600, color: lit, align: "right", baseline: "middle" });
    };
    if (at.target) row("target", at.target, r.y + 42, `rgba(${ACCENT},0.95)`, `the bar to beat · ${leadingZeroHexChars(at.target)} zeros`);
    const lastWin = (model.recentBlocks || [])[(model.recentBlocks || []).length - 1], winPool = lastWin && lastWin.pool ? ` · won by ${lastWin.pool}` : "";
    if (winner) row("winner", winner, r.y + 70, "rgb(90,225,140)", `#${(model.tipHeight || 0).toLocaleString()} · ${leadingZeroHexChars(winner)} zeros${winPool}`);
    row("you", at.hash, r.y + 98, at.won ? "rgb(90,225,140)" : "rgba(255,190,110,0.97)", `#${(at.height || 0).toLocaleString()} · ${youZ} zero${youZ === 1 ? "" : "s"}`);
    const best = mn.best;
    if (best && best.hash) {
      const bz = leadingZeroHexChars(best.hash), zb = typeof best.zero_bits === "number" ? best.zero_bits : bz * 4, rem = zb % 4;
      row("best", best.hash, r.y + 112, "rgba(255,215,90,1)", `#${(best.height || 0).toLocaleString()} · ${bz} zero${bz === 1 ? "" : "s"} · ${zb} bits${rem ? ` (+${rem}/4 to next)` : ""}`);
      // NIBBLE GAUGE — bit-level progress into the NEXT leading "0", the resolution hex chars throw away.
      // zb = 4·(full zero chars) + (zero bits of the frontier nibble); rem (= zb % 4) of 4 dots = bits toward
      // the next whole "0". Drawn under the first non-zero char so it lines up with where the next 0 will appear.
      if (bz < n) {
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
    const tBits = at.target ? 256 - bigHex(at.target).toString(2).length : 76;
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
    // #14: YOUR current hash — drawn ON TOP, ringed + ticked + labelled so it's never lost in the cloud
    const yx = px(youBits), yy = tkY + bandH / 2;
    ctx.strokeStyle = "rgba(10,8,4,0.75)"; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(yx, tkY - 7); ctx.lineTo(yx, tkY + bandH + 7); ctx.stroke();
    ctx.strokeStyle = "rgba(255,140,80,0.95)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(yx, tkY - 7); ctx.lineTo(yx, tkY + bandH + 7); ctx.stroke();
    ctx.fillStyle = "rgba(255,140,80,1)"; ctx.beginPath(); ctx.arc(yx, yy, 4.6, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(yx, yy, 4.6, 0, 7); ctx.stroke();
    text("you", yx, tkY - 10, { size: 10, weight: 700, color: "rgb(255,165,95)", align: "center", baseline: "middle" });
    text(`◄ BELOW target = WIN · 1 in ~10^${Math.round(tBits * 0.30103)}`, tkX, tkY + bandH + 14, { size: 10, weight: 600, color: "rgba(90,220,140,0.9)", baseline: "middle" });
    text("most hashes land here — above the target ►", tkX + tkW, tkY + bandH + 14, { size: 10, color: "rgba(255,190,110,0.85)", align: "right", baseline: "middle" });
    text("your inputs are fixed — SHA-256 makes the result an unpredictable draw in 2²⁵⁶; there's no way to aim", tkX + tkW / 2, r.y + r.h - 26, { size: 10, color: "rgba(255,255,255,0.42)", align: "center", baseline: "middle" });
    const att = mn.live_attempts || 0, won = mn.live_wins || 0;
    text(`● LIVE · ${att.toLocaleString()} attempts · ${won} found & submitted · ◆ best ${bestZeros} zero${bestZeros === 1 ? "" : "s"} · ${bestBits} bits · ● last ${youBits}`, rowX, r.y + r.h - 11, { size: 11, weight: 700, color: "rgba(90,220,140,0.92)", baseline: "middle" });
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
  const valY = barY + barH + 13; // row 2 — the value sits under its column
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
  text("the 6 header fields, in order", barX, valY + 17, { size: 10, weight: 600, color: "rgba(255,255,255,0.38)" });

  // ---- ZONE 2: the REAL 80-byte header — the exact contiguous bytes that get hashed, built in the SAME
  // order as the fields above, as each one locks
  const concatY = valY + 38;
  text("packed into the 80-byte header — the exact bytes that get hashed (little-endian):", r.x + r.w / 2, concatY - 13, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
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
  text(grind ? "SHA-256, churning…" : "1st SHA-256 — of the concatenation above", rowX, y1 - 14, { size: 10, weight: 600, color: `rgba(${ACCENT},0.7)`, baseline: "middle" });
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
  text(live ? "2nd SHA-256 — your block hash · this is what your node submitted" : "2nd SHA-256 — hash that result AGAIN → a new value (the “double”)", rowX, y2 - 16, { size: 10, weight: 700, color: live ? "rgb(90,220,140)" : `rgba(${ACCENT},0.7)`, baseline: "middle" });
  hashRow(h2, p2, y2, lz2, live ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.62)");
  text("why hash twice? a lone SHA-256 is open to a “length-extension” trick — hashing the hash again closes it", cx, y2 + 20, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
  // #6: what makes the hash random
  text("the randomness: every input is fixed, yet SHA-256's output is unpredictable — you can't aim, only compute & check", cx, y2 + 36, { size: 10, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });

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
    fieldValueRow("#" + tk.nonce.toLocaleString(), p, cx, dr.y + 96, 24);
    text("we take ONE deterministic value — a real miner sweeps all ~4 billion of them", cx, dr.y + dr.h - 16, { size: 11, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
  }
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
  if (height) text("#" + (height % 100000), x + bw / 2, y + 11, { size: 11, weight: 700, color: "rgba(255,255,255,0.78)", align: "center", baseline: "middle" });
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
    text(sym ? "practice mode — no Bitcoin node yet" : "no node connected", cx0, cy0 - 14, { size: 15, weight: 700, color: "rgba(255,255,255,0.6)", align: "center", baseline: "middle" });
    text(sym ? "set up a node (bitcoind) and this fills with the real chain syncing — then you mine for real"
             : "start bitcoind and this shows the blockchain downloading + verifying, block by block",
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
  text(behind > 0 ? `${(prog * 100).toFixed(1)}% · ${behind.toLocaleString()} blocks behind the tip${etaStr}` : stale ? "catching up after sleep — fetching new blocks from peers…" : "at the tip — waiting for the next block to be mined", r.x + r.w / 2, r.y + 56, { size: 10, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
  if (behind > 0) text("Syncing uses more CPU and network as your node verifies the chain — your computer may warm up or a fan spin up. A one-time catch-up that quiets down once synced.", r.x + r.w / 2, r.y + 72, { size: 9.5, color: "rgba(255,180,80,0.6)", align: "center", baseline: "middle" });

  // ---- peer arch (dome) ----
  const peers = (node && Array.isArray(node.peers)) ? node.peers : [];
  const archBaseY = r.y + 152, Rx = Math.min(r.w / 2 - 48, 340), Ry = 58;
  ctx.strokeStyle = `rgba(${ACCENT},0.12)`; ctx.lineWidth = 1; ctx.beginPath();
  for (let s = 0; s <= 48; s++) { const th = Math.PI * (s / 48), ax = cx + Rx * Math.cos(th), ay = archBaseY - Ry * Math.sin(th); s === 0 ? ctx.moveTo(ax, ay) : ctx.lineTo(ax, ay); }
  ctx.stroke();
  if (peers.length === 0) {
    text("no peers connected — start your node (bitcoind) to see them here", cx, archBaseY - Ry - 8, { size: 11, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" });
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
        text("#" + (fh % 100000), fx + bw / 2, cy, { size: 10, color: "rgba(255,255,255,0.28)", align: "center", baseline: "middle" });
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

function drawNetwork(r) {
  let y = r.y + 16;
  if (model.difficulty) {
    const hr = model.hashrateEh ? `  ·  ${model.hashrateEh.toFixed(0)} EH/s mining` : "";
    const pr = model.price ? `  ·  BTC $${Math.round(model.price).toLocaleString()}` : "";
    text(`Difficulty ${model.difficulty.toExponential(2)}${hr}${pr}  ·  ~1 in ${(model.difficulty * 4294967296).toExponential(2)} per hash`, r.x + r.w / 2, y, { size: 13, weight: 600, color: `rgba(${ACCENT}, 0.9)`, align: "center", baseline: "middle" });
    y += 19;
  }
  // #9: what this miner actually uses — to show it's a lottery ticket, not a power-hungry rig
  const mp = model.node && model.node.miner_proc, dsk = model.node && model.node.size_on_disk;
  if (mp) { const disk = dsk ? ` · ${(dsk / 1e9).toFixed(0)} GB disk${model.node.pruned ? " (pruned node)" : ""}` : ""; text(`⚙ this miner uses ~${mp.cpu}% CPU · ${mp.mem_mb} MB RAM${disk} · one SHA-256 per block — a lottery ticket, not a mining rig`, r.x + r.w / 2, y, { size: 11, weight: 500, color: "rgba(90,210,140,0.7)", align: "center", baseline: "middle" }); y += 19; }
  if (isDesktop && nodeMode === "managed") { const quitHint = desktopPlatform === "win32" ? "Quitting from the tray icon" : desktopPlatform === "linux" ? "Quitting the app" : "Quitting the app (⌘Q)"; text(`Closing this window keeps your node + mining running in the background. ${quitHint} stops your node.`, r.x + r.w / 2, y, { size: 10.5, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" }); y += 18; }
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
}

// top-center liveness pill — answers "is it actually submitting tickets?" at a glance, so a user never has
// to hunt or wonder. green = synced + a fresh ticket · amber = node still syncing · red = stalled/offline.
function agoStr(sec) {
  if (!isFinite(sec)) return "—";
  if (sec < 45) return "just now";
  if (sec < 5400) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
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
  if (!reachable) { dot = RED; label = "not submitting"; sub = "node offline"; }
  else if (syncing) { const p = n.verificationprogress != null ? n.verificationprogress : 0; dot = AMBER; label = "getting ready"; sub = `syncing ${Math.floor(p * 100)}%`; }
  else if (!haveTs) { dot = GREEN; label = "submitting tickets"; sub = "mining the current block"; } // synced but no ticket timestamp (older build / first moments) — don't claim a stale time we don't have
  else if (ageSec <= 1200) { dot = GREEN; label = "submitting tickets"; sub = `last ticket ${agoStr(ageSec)}`; }
  else { dot = RED; label = "not submitting"; sub = `last ticket ${agoStr(ageSec)}`; } // genuinely stalled — a real, old timestamp

  const txt = `${label} · ${sub}`;
  ctx.font = "600 11px ui-monospace, monospace";
  const padL = 22, w = ctx.measureText(txt).width + padL + 12, h = 18, x = (W - w) / 2, y = 5;
  ctx.fillStyle = `rgba(${dot},0.10)`; roundRect(x, y, w, h, 6); ctx.fill();
  ctx.strokeStyle = `rgba(${dot},0.45)`; ctx.lineWidth = 1; roundRect(x, y, w, h, 6); ctx.stroke();
  // the dot gently pulses while green so "live" reads as alive (frozen under reduced-motion)
  const pulse = (dot === GREEN && !reduceMotion) ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(clock * 2.2)) : 0.9;
  ctx.fillStyle = `rgba(${dot},${pulse})`; ctx.beginPath(); ctx.arc(x + 12, y + h / 2, 4, 0, 7); ctx.fill();
  text(txt, x + padL, y + h / 2, { size: 11, weight: 600, color: `rgba(${dot},0.95)`, baseline: "middle", mono: true });
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
  const sub = `a winning block needs about 19 leading “0”s`;
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
  text("click anywhere to dismiss", cx, H - 40, { size: 12, color: `rgba(255,255,255,${0.4 * a})`, align: "center", baseline: "middle" });
}

function render(ts) {
  rafId = requestAnimationFrame(render);
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

  ctx.save();
  ctx.translate(0, -scrollY);
  text("₿ITCOIN LOTTERY", W / 2, 44, { size: 28, weight: 800, align: "center", baseline: "middle" }); // y=44 (was 38) so the fixed status pill above it has clearance
  text("you almost certainly won't win — but it isn't zero, and zero is what you get if you never play · a real ticket, and a way to learn how Bitcoin works", W / 2, 62, { size: 11, weight: 500, color: "rgba(255,255,255,0.48)", align: "center", baseline: "middle" });
  const quoteAlpha = 0.45 + 0.12 * Math.sin(clock * 1.5);
  // both states render through the same monospace layout (p≥1 = fully resolved) so the text never shifts
  drawDecodeQuote(quotePhase === "hold" ? quoteText(quoteIdx) : quoteText(quoteNext), quotePhase === "hold" ? 2 : quoteT / Q_DECODE, quoteAlpha, quotePhase === "hold" ? quoteIdx : quoteNext);
  const qsrc = quoteSrc(quoteIdx); // attribution shown once the quote has settled
  if (quotePhase === "hold" && qsrc) text("— " + qsrc, W / 2, 101, { size: 12, weight: 600, color: `rgba(${ACCENT}, 0.72)`, align: "center", baseline: "middle" });

  headerHits = [];
  if (model.error) {
    text(model.error, W / 2, TOP + 40, { size: 16, color: "rgba(255,120,90,0.9)", align: "center", baseline: "middle" });
  } else {
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
  }
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
  const symbolic = !!(node && node.miner && node.miner.mode === "symbolic");
  // synced + live but no ticket in >20 min = actually not submitting (stalled miner) — don't claim LIVE
  const lastTs = node && node.miner && node.miner.attempt ? Date.parse(node.miner.attempt.attempted_at || "") : NaN;
  const stalled = Number.isFinite(lastTs) && (Date.now() - lastTs) / 1000 > 1200;
  let fmsg, fcol;
  const ver = appVersion ? `v${appVersion}` : VERSION; // desktop shows the app release (for support); web demo shows the dashboard version
  if (!node) { fmsg = `◷ live demo · ${ver}`; fcol = "rgba(255,255,255,0.5)"; }
  else if (symbolic) { fmsg = `◷ practice mode — set up a node to mine for real · ${ver}`; fcol = "rgba(255,255,255,0.5)"; }
  else if (!reachable) { fmsg = `○ node unreachable — check your node · ${ver}`; fcol = "rgba(255,150,80,0.95)"; }
  else if (!synced) { fmsg = `◐ syncing blockchain — ${(prog * 100).toFixed(2)}%${behindH ? ` · ${behindH.toLocaleString()} blocks to the tip` : ""} · ${ver}`; fcol = "rgba(255,180,80,0.95)"; }
  else if (!minerLive) { fmsg = `● synced — solo miner not running live · ${ver}`; fcol = "rgba(255,180,80,0.95)"; }
  else if (stalled) { fmsg = `● synced — miner not submitting (last ticket ${agoStr((Date.now() - lastTs) / 1000)}) · ${ver}`; fcol = "rgba(255,180,80,0.95)"; }
  else { fmsg = `◉ LIVE solo mining — submits a block if it wins · ${ver}`; fcol = "rgba(90,220,140,0.95)"; } // ◉ (not ●) so LIVE differs from the amber 'synced' state by shape, not only colour
  text(fmsg, W - PAD, H - 14, { size: 13, weight: 700, color: fcol, align: "right", baseline: "middle" });
  if (syncDemo) {
    text("◉ SYNC DEMO — simulated · press D or Esc to exit (back to your live node)", PAD, H - 14, { size: 13, weight: 700, color: "rgba(90,210,140,0.95)", baseline: "middle" });
  } else if (!node) {
    // public / demo view — nobody is mining here, so DON'T show a payout warning (it reads as "your
    // rewards go to a stranger"). Explain what this is and how to take part.
    text("◷ demo — real Bitcoin network · simulated tickets · run the miner to take a real shot", PAD, H - 14, { size: 13, weight: 700, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  } else if (symbolic) {
    // practice mode — real attempts, but no node and no rewards yet, so don't show a payout warning
    text("◷ practice mode — no rewards yet · set up a node to take a real shot at a block", PAD, H - 14, { size: 13, weight: 700, color: "rgba(255,255,255,0.5)", baseline: "middle" });
  } else {
    // a real local node IS present — show the actual payout (warn only if unset/invalid, where it matters)
    const pay = node.payout;
    const masked = (pay && pay.masked) || DEFAULT_PAYOUT_MASKED;
    const isDefault = pay ? pay.is_default : true;
    const status = pay ? (pay.status || (pay.valid ? "ok" : "invalid")) : "ok";
    let msg = `⛏ payout ${masked}`, col = "rgba(255,255,255,0.5)";
    if (status === "invalid") { msg = `⚠ payout ${masked} — that address looks invalid`; col = "rgba(255,120,90,0.95)"; }
    else if (isDefault) { msg = `⚠ no wallet set — rewards go to the dashboard owner (${masked})`; col = "rgba(255,180,80,0.95)"; }
    text(msg, PAD, H - 14, { size: 13, weight: 700, color: col, baseline: "middle" });
  }

  // YOUR block → only CELEBRATE once it's confirmed in the chain. ws.status: pending | confirmed | lost.
  // (a found+submitted block is not a win — it can be a duplicate, rejected, or beaten to the chain.)
  const mnW = node && node.miner, ws = mnW && mnW.win_status; // {height, hash, status}
  if (seenConfirmedWin < 0) { if (mnW) seenConfirmedWin = (ws && ws.status === "confirmed") ? ws.height : 0; } // don't celebrate a win that predates this load
  else if (ws && ws.status === "confirmed" && ws.height > seenConfirmedWin) { seenConfirmedWin = ws.height; fireCelebration({ preview: false, mode: "you", verified: true, height: ws.height, hash: ws.hash }); }
  // NEW BEST → a small toast (mid-tier reward; fires once when the leading-zero record improves this session)
  const bestNow = mnW && mnW.best ? (mnW.best.zero_bits || 0) : 0;
  if (seenBest < 0) { if (mnW && mnW.best) seenBest = bestNow; } // wait for data, then remember the standing record
  else if (bestNow > seenBest) { seenBest = bestNow; if (!celebration.active) fireBestToast(bestNow); }
  // NETWORK wins → everyone running this learns of it from the on-chain coinbase tag (no server)
  const netWins = lotteryWins();
  const haveBlocks = (model.recentBlocks && model.recentBlocks.length > 0) || !!(model.node && model.node.lottery_blocks);
  if (seenLottery === null) { if (haveBlocks) seenLottery = new Set(netWins.map((w) => w.height)); } // wait for data, then remember what predates this load — no retroactive celebration
  else for (const w of netWins) if (!seenLottery.has(w.height)) { seenLottery.add(w.height); if (w.verified && !celebration.active) fireCelebration({ mode: "network", verified: true, height: w.height, hash: w.hash }); } // only auto-celebrate locally-verified wins; unverified (mempool) ones just show the badge
  if (!celebration.active) { drawMinerStatus(); drawPreviewTrigger(); drawGear(); drawMotionToggle(); drawBestToast(); if (!drawOwnWinStatus(ws)) drawNetWinBadge(netWins); } // your own pending/lost block takes priority over a network-win badge
  drawCelebration(); // on top of everything
  drawSyncedBanner(); // the brief "caught up — now mining" banner after sync completes

  clock += 0.02; if (!reduceMotion) frame = (frame + 1) % 3000000; // wrap (mult. of 32/4/3) so frame-derived phases never drift over a multi-day session; frozen under reduced-motion to still all glyph churn/sweeps
  quoteT += 1 / 60;
  if (quotePhase === "hold") { if (quoteT > Q_HOLD) { quotePhase = "decode"; quoteT = 0; quoteNext = nextQuoteIdx(quoteIdx); } }
  else if (quoteT > Q_DECODE) { quotePhase = "hold"; quoteT = 0; quoteIdx = quoteNext; }
  window.__q = { phase: quotePhase, idx: quoteIdx, next: quoteNext, bag: quoteBag.length };
  // (the next frame is already scheduled at the top of render so the throttle/early-return path keeps looping)
}

// ---- interaction ----
let hoverSection = null, mouseX = -1, mouseY = -1;
function sectionAt(px, py) {
  for (const f of headerHits) { const r = f.header; if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return f.section; }
  return null;
}
const inHit = (h, x, y) => h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
canvas.addEventListener("click", (e) => {
  if (celebration.active) { celebration.active = false; return; } // dismiss
  if (inHit(winStatusHit, e.offsetX, e.offsetY)) { dismissedLost.add(winStatusHit.height); return; } // dismiss the 'lost the race' notice
  if (inHit(bestToastHit, e.offsetX, e.offsetY)) { bestToast.active = false; return; } // dismiss the new-best toast
  if (inHit(motionHit, e.offsetX, e.offsetY)) { cycleMotion(); return; } // cycle motion: full → calm → off
  if (inHit(gearHit, e.offsetX, e.offsetY)) { window.location = "/setup?settings=1"; return; } // settings (desktop app)
  if (inHit(netWinHit, e.offsetX, e.offsetY)) { const w = netWinHit.win; fireCelebration({ mode: "network", verified: !!w.verified, height: w.height, hash: w.hash }); return; }
  if (inHit(winPreviewHit, e.offsetX, e.offsetY)) { // preview the win with a real winning block hash as illustration
    fireCelebration({ preview: true, height: (model.tipHeight || 0) + 1, hash: (model.block && model.block.id) || "" });
    return;
  }
  if (inHit(blockPreviewHit, e.offsetX, e.offsetY)) { mpPreview = true; syncPreview = true; return; } // replay the block-mined animations
  if (expanded.has("hashInside") && inHit(hashInputHit, e.offsetX, e.offsetY + scrollY)) { hashViz.focused = true; requestRender(); return; } // focus the hash input
  hashViz.focused = false; // any other click blurs it
  const s = sectionAt(e.offsetX, e.offsetY + scrollY);
  if (s) { if (expanded.has(s)) expanded.delete(s); else expanded.add(s); saveExpanded(); }
});
canvas.addEventListener("mousemove", (e) => {
  mouseX = e.offsetX; mouseY = e.offsetY;
  hoverSection = sectionAt(e.offsetX, e.offsetY + scrollY);
  canvas.classList.toggle("clickable", !!hoverSection || celebration.active || inHit(winPreviewHit, e.offsetX, e.offsetY) || inHit(blockPreviewHit, e.offsetX, e.offsetY) || inHit(gearHit, e.offsetX, e.offsetY) || inHit(motionHit, e.offsetX, e.offsetY) || inHit(netWinHit, e.offsetX, e.offsetY) || inHit(bestToastHit, e.offsetX, e.offsetY) || inHit(winStatusHit, e.offsetX, e.offsetY));
});
canvas.addEventListener("wheel", (e) => {
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
resize();
pollNode();
refresh();
loadHistory();
setInterval(pollNode, 3_000);
setInterval(refresh, REFRESH_MS);
setInterval(loadHistory, 300_000);
render();
