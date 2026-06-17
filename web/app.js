// Bitcoin Lottery — browser dashboard (cross-platform port of the macOS viz).
// Self-contained: public chain/price data from mempool.space + client-side
// SHA-256 practice ticket (Web Crypto). No backend.

const API = "https://mempool.space/api";
const ACCENT = "255, 153, 26";          // brand orange
const REFRESH_MS = 30_000;

// ---- machine seed (your lottery identity on this device) ----
function machineSeed() {
  let s = localStorage.getItem("bl.seed");
  if (!s) {
    s = "web-" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("bl.seed", s);
  }
  return s;
}

// ---- section expand/collapse (persisted) ----
const SECTIONS = ["nextBlock", "closeness", "hashBuild", "network", "sync"];
const SECTION_TITLE = { nextBlock: "NEXT BLOCK", closeness: "YOUR CLOSENESS", hashBuild: "HASH BUILD", network: "NETWORK", sync: "BLOCKCHAIN SYNC" };
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
const dsha256 = async (b) => sha256(await sha256(b));

async function pickNonce(seed, height) {
  const d = await sha256(enc.encode(`${seed}:${height}`));
  return new DataView(d.buffer).getUint32(0, true);
}

async function hashBlockHeader(blk, nonce) {
  const header = concat(
    u32le(blk.version),
    hexToBytes(blk.previousblockhash).reverse(),
    hexToBytes(blk.merkle_root).reverse(),
    u32le(blk.timestamp),
    u32le(blk.bits),
    u32le(nonce),
  );
  return bytesToHex(await dsha256(header));
}

function bitsToTarget(bits) {
  const exp = bits >>> 24, mant = BigInt(bits & 0xffffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

function proximity(hashHex, target) {
  const hashInt = BigInt("0x" + hashHex);
  if (hashInt <= target) return { won: true, percent: 100, leadingZeroBits: 256, label: "JACKPOT" };
  const leading = 256 - hashInt.toString(2).length;
  const ratio = Number(target) / Number(hashInt);
  const percent = Math.max(0, Math.min(99.999999, ratio * 100));
  return { won: false, percent, leadingZeroBits: leading, label: percent.toFixed(8) + "%" };
}
function leadingZeroHexChars(hashHex) { let n = 0; for (const c of hashHex) { if (c === "0") n++; else break; } return n; }

// ---- model ----
const model = { tipHeight: null, block: null, txCount: null, price: null, hashrateEh: null, difficulty: null, ticket: null, error: null, priceHistory: [], hashrateHistory: [], recentBlocks: [], node: null };

async function loadHistory() {
  try {
    const hr = await (await fetch(`${API}/v1/mining/hashrate/1m`)).json();
    if (hr?.hashrates) model.hashrateHistory = hr.hashrates.map((p) => p.avgHashrate / 1e18);
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

    const nonce = await pickNonce(machineSeed(), blk.height);
    const hashHex = await hashBlockHeader(blk, nonce);
    const target = bitsToTarget(blk.bits);
    model.ticket = { nonce, hashHex, prox: proximity(hashHex, target) };

    fetch(`${API}/v1/blocks`).then((r) => r.json()).then((arr) => {
      if (Array.isArray(arr)) model.recentBlocks = arr.slice(0, 8).reverse().map((b) => ({ height: b.height, id: b.id, tx: b.tx_count, size: b.size, pool: b.extras?.pool?.name }));
    }).catch(() => {});
    fetch(`${API}/v1/prices`).then((r) => r.json()).then((p) => { if (p && p.USD) model.price = p.USD; }).catch(() => {});
    fetch(`${API}/v1/mining/hashrate/3d`).then((r) => r.json()).then((h) => { if (h && h.currentHashrate) model.hashrateEh = h.currentHashrate / 1e18; }).catch(() => {});
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

function text(s, x, y, { size = 16, weight = 400, color = "#fff", align = "left", baseline = "alphabetic", mono = false } = {}) {
  ctx.font = `${weight} ${size}px ${mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "-apple-system, system-ui, sans-serif"}`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

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
  { q: "So you're tellin' me there's a chance?", src: "Dumb and Dumber" },
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
  { q: "Never tell me the odds.", src: "Star Wars" },
  { q: "May the odds be ever in your favor.", src: "The Hunger Games" },
  { q: "Hope is a good thing, maybe the best of things.", src: "The Shawshank Redemption" },
  { q: "If you build it, it will come.", src: "Field of Dreams" },
  { q: "Life is like a box of chocolates.", src: "Forrest Gump" },
  { q: "Carpe diem. Seize the block.", src: "Dead Poets Society" },
  { q: "We are the music makers, and we are the dreamers of dreams.", src: "Willy Wonka" },
  { q: "If you want to view paradise, simply look around and view it.", src: "Willy Wonka" },
  { q: "A little nonsense now and then is relished by the wisest men.", src: "Willy Wonka" },
  { q: "So shines a good deed in a weary world.", src: "Willy Wonka" },
  { q: "The suspense is terrible — I hope it'll last.", src: "Willy Wonka" },
  { q: "Come with me, and you'll be in a world of pure imagination.", src: "Willy Wonka" },
];
const quoteText = (i) => (typeof QUOTES[i] === "string" ? QUOTES[i] : QUOTES[i].q);
const quoteSrc = (i) => (typeof QUOTES[i] === "string" ? "" : QUOTES[i].src);

// ---- layout + sections ----
const PAD = 36, HEADER_H = 40, GAP = 12, TOP = 116;
const CONTENT_H = { nextBlock: 150, closeness: 124, hashBuild: 300, network: 180, sync: 540 };
let headerHits = [];
let scrollY = 0, maxScroll = 0;
let clock = 0, quoteIdx = 0, quoteT = 0, frame = 0, quoteNext = 1, quotePhase = "hold";
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
function drawDecodeQuote(to, p, alpha) {
  ctx.font = "600 16px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const total = to.length, charW = ctx.measureText("0").width, startX = W / 2 - (total * charW) / 2 + charW / 2;
  const reveal = p * (total + 5); // resolve front sweeps across (and a little past the end)
  for (let i = 0; i < total; i++) {
    if (to[i] === " ") continue;
    const x = startX + i * charW;
    if (i < reveal - 1) { ctx.fillStyle = `rgba(255,255,255,${alpha})`; ctx.fillText(to[i], x, 80); }                                   // resolved
    else if (i < reveal + 1) { ctx.fillStyle = `rgba(${ACCENT},0.9)`; ctx.fillText(CYBER[(frame * 2 + i * 9) % CYBER.length], x, 80); } // decoding front
    else { ctx.fillStyle = `rgba(70,190,140,${alpha * 0.8})`; ctx.fillText("0123456789abcdef"[(frame + i * 5) % 16], x, 80); }          // not yet decoded
  }
}
const VERSION = "web v0.25.1";
const SYNC_DEBUG = false; // flip to true to print live fill/phase state at the bottom of the sync panel

function layoutSections() {
  let y = TOP; const frames = [];
  for (const s of SECTIONS) {
    const header = { x: PAD, y, w: W - PAD * 2, h: HEADER_H };
    y += HEADER_H;
    let content = null;
    if (expanded.has(s)) { const h = CONTENT_H[s]; content = { x: PAD, y: y + 4, w: W - PAD * 2, h }; y += 4 + h; }
    y += GAP;
    frames.push({ section: s, header, content });
  }
  return { frames, total: y };
}

function summary(s) {
  if (s === "nextBlock") { if (!model.block) return "—"; const e = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp)); return `${Math.floor(e / 60)}:${String(e % 60).padStart(2, "0")} since last`; }
  if (s === "closeness") { const p = model.ticket?.prox; return p ? (p.won ? "TARGET HIT" : `${p.label} · ${p.leadingZeroBits} zero bits`) : "—"; }
  if (s === "hashBuild") { return model.ticket ? "0x" + model.ticket.hashHex.slice(0, 10) + "…" : "—"; }
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
  if (!isExpanded) text(summary(s), r.x + r.w - 14, r.y + r.h / 2, { size: 14, color: "rgba(255,255,255,0.62)", align: "right", baseline: "middle" });
}

function drawContent(s, r) {
  if (s === "nextBlock") return drawNextBlock(r);
  if (s === "closeness") return drawCloseness(r);
  if (s === "hashBuild") return drawHashBuild(r);
  if (s === "network") return drawNetwork(r);
  if (s === "sync") return drawSync(r);
}

function drawNextBlock(r) {
  if (!model.block) { text("waiting…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  const cx = r.x + 78, cy = r.y + r.h / 2, rad = 52;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp));
  const progress = Math.min(1, elapsed / 600);
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = `rgba(${ACCENT}, 0.9)`; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); ctx.stroke(); ctx.lineCap = "butt";
  const rem = Math.max(0, 600 - elapsed);
  text(`${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}`, cx, cy, { size: 20, weight: 700, align: "center", baseline: "middle", mono: true });
  text("next block (est)", cx, cy + rad + 16, { size: 14, color: "rgba(255,255,255,0.55)", align: "center", baseline: "middle" });
  const rows = [["Elapsed", `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`], ["Avg block", "~10:00"], ["Last block", "#" + model.tipHeight.toLocaleString()]];
  let sy = cy - 36;
  for (const [l, v] of rows) { text(l, r.x + 192, sy, { size: 14, color: "rgba(255,255,255,0.5)", baseline: "middle" }); text(v, r.x + 320, sy, { size: 14, weight: 600, color: "rgba(255,255,255,0.85)", baseline: "middle" }); sy += 30; }
}

function drawCloseness(r) {
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
  text("one practice hash per block — real mining searches trillions, and submits to the network", r.x + r.w / 2, r.y + r.h - 6, { size: 10, color: "rgba(255,255,255,0.38)", align: "center", baseline: "middle" });
}

// ---- HASH BUILD ceremony: phased, accurate-but-stylized ----
// Real header fields (to-scale byte widths) assemble one by one, churn through
// the double SHA-256 as matrix-hex, then resolve into your real block hash.
const HEADER_FIELDS = [
  { label: "version", bytes: 4, explain: "which consensus rules this block follows", val: (b) => (b.version >>> 0).toString(16).padStart(8, "0") },
  { label: "prev block", bytes: 32, explain: "the link back to the previous block — this is the chain", val: (b) => b.previousblockhash.slice(0, 24) + "…" },
  { label: "merkle root", bytes: 32, explain: "one fingerprint of every transaction in the block", val: (b) => b.merkle_root.slice(0, 24) + "…" },
  { label: "time", bytes: 4, explain: "when the block was assembled", val: (b) => new Date(b.timestamp * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC" },
  { label: "bits", bytes: 4, explain: "the difficulty target — how hard it is to win", val: (b) => "0x" + b.bits.toString(16) },
  { label: "NONCE", bytes: 4, explain: "your lottery number for this block", val: (b, t) => "#" + t.nonce.toLocaleString(), you: true },
];
const PHASES = [["assemble", 7.8], ["pack", 1.0], ["churn", 3.0], ["reveal", 3.4], ["hold", 3.4]];
const CYCLE_LEN = PHASES.reduce((s, p) => s + p[1], 0);
const CYBER = "0123456789abcdefABCDEF#%&*<>/\\=+".split("");
const ceremony = { height: null, t: 0, cycle: -1, order: [] };
function phaseAt(t) { let acc = 0; for (const [name, dur] of PHASES) { if (t < acc + dur) return { name, p: (t - acc) / dur }; acc += dur; } return { name: "hold", p: 1 }; }
function shuffled(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function churnChar(i) { return CYBER[(frame + i * 7) % CYBER.length]; }

function drawHashBuild(r) {
  if (!model.block || !model.ticket) { text("waiting for chain data…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  const b = model.block, tk = model.ticket;
  if (ceremony.height !== model.tipHeight) { ceremony.height = model.tipHeight; ceremony.t = 0; }
  ceremony.t += 1 / 60;
  const t = ceremony.t % CYCLE_LEN, cyc = Math.floor(ceremony.t / CYCLE_LEN);
  if (cyc !== ceremony.cycle) { ceremony.cycle = cyc; ceremony.order = shuffled(40); }
  const ph = phaseAt(t);
  const assembling = ph.name === "assemble";
  const lockedCount = assembling ? Math.min(6, Math.floor(ph.p * 6)) : 6;
  const fillFrac = assembling ? ph.p * 6 - lockedCount : 1;

  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  text(`Building your ticket — block #${model.tipHeight.toLocaleString()}`, r.x + r.w / 2, r.y + 20, { size: 14, weight: 700, color: "rgba(255,255,255,0.7)", align: "center", baseline: "middle" });

  // byte-proportional header bar (structure, to scale)
  const barX = r.x + 18, barW = r.w - 36, barY = r.y + 40, barH = 30, total = 80;
  let bx = barX;
  HEADER_FIELDS.forEach((f, i) => {
    const segW = barW * f.bytes / total;
    const locked = i < lockedCount, filling = assembling && i === lockedCount;
    let fill = "rgba(255,255,255,0.05)";
    if (f.you && (locked || filling)) fill = `rgba(${ACCENT},0.30)`;
    else if (locked) fill = `rgba(${ACCENT},0.14)`;
    else if (filling) fill = `rgba(${ACCENT},${0.14 * fillFrac})`;
    ctx.fillStyle = fill; roundRect(bx + 1, barY, segW - 2, barH, 3); ctx.fill();
    if (locked || filling) { ctx.strokeStyle = `rgba(${ACCENT},${filling ? 0.9 : 0.4})`; ctx.lineWidth = filling ? 1.4 : 1; roundRect(bx + 1, barY, segW - 2, barH, 3); ctx.stroke(); }
    if (segW > 58) text(f.label, bx + segW / 2, barY + barH / 2, { size: 11, weight: 600, color: locked || filling ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.32)", align: "center", baseline: "middle" });
    bx += segW;
  });
  text("80-byte block header", barX, barY + barH + 13, { size: 11, weight: 600, color: "rgba(255,255,255,0.4)" });

  // caption (phase-aware) + per-field detail animation while assembling
  let caption = "";
  if (assembling) { const f = HEADER_FIELDS[Math.min(5, lockedCount)]; caption = `${f.label} — ${f.explain}`; }
  else if (ph.name === "pack") caption = "header complete — now hash it";
  else if (ph.name === "churn") caption = "SHA-256, applied twice — every bit scrambled";
  else if (ph.name === "reveal") caption = "the one and only result emerges…";
  else caption = tk.prox.won ? "a winning hash — you beat the target!" : "this block's hash · try again next block";
  text(caption, r.x + r.w / 2, barY + barH + 36, { size: 13, weight: 500, color: `rgba(${ACCENT},0.88)`, align: "center", baseline: "middle" });
  if (assembling) {
    const dr = { x: r.x + 24, y: barY + barH + 50, w: r.w - 48, h: (r.y + r.h - 70) - (barY + barH + 50) };
    drawFieldDetail(Math.min(5, lockedCount), fillFrac, dr, b, tk);
  }

  // output row: churn → reveal → hold
  const hex = tk.hashHex.slice(0, 40), lead = leadingZeroHexChars(tk.hashHex);
  const rowY = r.y + r.h - 52, sp = (r.w - 40) / hex.length;
  if (ph.name === "pack" || ph.name === "churn") {
    for (let i = 0; i < hex.length; i++) text(churnChar(i), r.x + 20 + sp * (i + 0.5), rowY, { size: 15, color: `rgba(${ACCENT},${0.45 + 0.45 * Math.random()})`, align: "center", baseline: "middle", mono: true });
  } else if (ph.name === "reveal" || ph.name === "hold") {
    const lockN = ph.name === "hold" ? hex.length : Math.floor(ph.p * hex.length);
    for (let i = 0; i < hex.length; i++) {
      const lk = ceremony.order.indexOf(i) < lockN, isLead = i < lead;
      text(lk ? hex[i] : churnChar(i), r.x + 20 + sp * (i + 0.5), rowY,
        { size: 15, weight: lk && isLead ? 700 : 400, color: lk ? (isLead ? `rgb(${ACCENT})` : "rgba(255,255,255,0.72)") : "rgba(120,165,150,0.55)", align: "center", baseline: "middle", mono: true });
    }
    if (ph.name === "hold") text(tk.prox.won ? "🎉 JACKPOT" : `${tk.prox.leadingZeroBits} leading zero bits`, r.x + r.w / 2, rowY + 24, { size: 13, weight: 600, color: tk.prox.won ? "rgb(70,230,120)" : "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  }
}

// a row of monospace chars that scramble then lock in left-to-right as p rises
function fieldValueRow(strV, p, cx, cy, size, lead = 0) {
  const chars = strV.split("");
  const lock = Math.min(chars.length, Math.floor(p * chars.length * 1.25));
  ctx.font = `${size}px ui-monospace, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cw = ctx.measureText("0").width || size * 0.6;
  let x = cx - (cw * chars.length) / 2 + cw / 2;
  for (let i = 0; i < chars.length; i++) {
    const lk = i < lock, isLead = lk && i < lead;
    ctx.fillStyle = lk ? (isLead ? `rgb(${ACCENT})` : "rgba(255,255,255,0.85)") : "rgba(120,165,150,0.6)";
    ctx.fillText(lk ? chars[i] : churnChar(i), x, cy); x += cw;
  }
}

function drawMerkleMini(p, dr) {
  const n = Math.min(8, Math.max(2, model.txCount || 4));
  const levels = []; let c = n; while (true) { levels.push(c); if (c <= 1) break; c = Math.ceil(c / 2); }
  const rows = levels.length, lv = Math.floor(p * rows);
  text(`${(model.txCount || n).toLocaleString()} transactions → 1 merkle root`, dr.x + dr.w / 2, dr.y + 8, { size: 11, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
  for (let row = 0; row < rows; row++) {
    const cnt = levels[row], built = row <= lv, yy = dr.y + dr.h - 10 - row * (dr.h - 26) / Math.max(1, rows - 1);
    for (let k = 0; k < cnt; k++) {
      const xx = dr.x + dr.w * (k + 0.5) / cnt;
      ctx.beginPath(); ctx.arc(xx, yy, 5, 0, 7);
      ctx.fillStyle = built ? (row === rows - 1 ? `rgb(${ACCENT})` : `rgba(${ACCENT},0.55)`) : "rgba(255,255,255,0.14)"; ctx.fill();
    }
  }
}

function drawFieldDetail(idx, p, dr, b, tk) {
  const cx = dr.x + dr.w / 2, midY = dr.y + dr.h / 2;
  if (idx === 0) {
    text("4 bytes · the block format", cx, dr.y + 8, { size: 11, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
    fieldValueRow("0x" + (b.version >>> 0).toString(16).padStart(8, "0"), p, cx, midY + 4, 22);
  } else if (idx === 1) {
    text(`⛓ links back to block #${(model.tipHeight - 1).toLocaleString()}`, cx, dr.y + 8, { size: 12, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    fieldValueRow(b.previousblockhash.slice(0, 32), p, cx, midY + 6, 14);
  } else if (idx === 2) {
    drawMerkleMini(p, dr);
  } else if (idx === 3) {
    text(new Date(b.timestamp * 1000).toUTCString().replace("GMT", "UTC"), cx, dr.y + 12, { size: 13, weight: 600, color: "rgba(255,255,255,0.8)", align: "center", baseline: "middle" });
    fieldValueRow(String(b.timestamp), p, cx, midY + 14, 16);
  } else if (idx === 4) {
    text("your hash must land BELOW this target:", cx, dr.y + 8, { size: 11, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
    const tgt = bitsToTarget(b.bits).toString(16).padStart(64, "0").slice(0, 40), tlead = leadingZeroHexChars(tgt);
    fieldValueRow(tgt, 1, cx, midY + 6, 13, tlead);
    text(`${tlead} leading zeros required`, cx, dr.y + dr.h - 6, { size: 11, color: "rgba(255,255,255,0.4)", align: "center", baseline: "middle" });
  } else {
    text(`"${machineSeed()}:${model.tipHeight}"`, cx, dr.y + 10, { size: 12, color: "rgba(255,255,255,0.6)", align: "center", baseline: "middle", mono: true });
    text("↓  SHA-256  ↓", cx, midY, { size: 11, color: `rgba(${ACCENT},0.7)`, align: "center", baseline: "middle" });
    fieldValueRow("#" + tk.nonce.toLocaleString(), Math.max(p, 0.4), cx, dr.y + dr.h - 12, 20);
  }
}

// ---- BLOCKCHAIN SYNC: peer arch → centered node → fills the block below → steps left ----
const syncState = { t: 0, shown: null, phase: "fill", fp: 0, sp: 0, disk: 12 };
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
  if (info && info.size) text(mbFmt(info.size), x + bw / 2, y + bh - 9, { size: 9, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
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
  syncState.t += 1 / 60;
  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  text("SYNCING THE CHAIN — peers → node → block", r.x + 16, r.y + 16, { size: 12, weight: 700, color: "rgba(255,255,255,0.55)", baseline: "middle" });

  const node = model.node;
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
  const fHead = Math.floor(head);
  if (syncState.lastHead != null && fHead > syncState.lastHead && fHead - syncState.lastHead <= 2 && behind === 0) syncState.pending = Math.min(3, (syncState.pending || 0) + (fHead - syncState.lastHead)); // a real new block is +1; ignore big catch-up jumps
  syncState.lastHead = fHead;
  const minedAnim = behind === 0 && (syncState.pending || 0) > 0; // a freshly mined block is committing, live
  const flowing = minedAnim || peersAll.some((p) => (p.rate || 0) > 15_000); // ≥1 peer sending, or a mined block landing
  syncState.streams = syncState.streams || {};
  // two-stage flow: a peer's water reaches the NODE only when its stream's leading edge is at the node (head≈1).
  const nodeFed = minedAnim || peersAll.some((p, i) => { if ((p.rate || 0) <= 15_000) return false; const st = syncState.streams["peer:" + (p.addr || ("p" + i))]; return st && st.head >= 0.98 && st.head > st.tail; });
  const fillPerSec = !flowing ? 0 : (minedAnim ? 0.5 : Math.max(0.12, Math.min(0.8, syncState.flow / 4_000_000))); // rate-driven; mined block commits briskly
  const downloading = behind > 0 || minedAnim;

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
  const pruneDur = Math.max(1.0, Math.min(2.5, PRUNE_SEC / paceMul)), stepDur = Math.max(0.28, 0.42 / paceMul); // variable with sync rate, capped 1–2.5s so it's always visible
  // The block is a container; its level (fp) only changes as the node→block stream actually delivers water.
  //   arrive : tap open, the stream's leading edge descends to the empty block — level NOT moving yet
  //   fill   : water landing, level rises at the throughput-driven rate up to FP_CUT
  //   topoff : tap closed; the water still in the pipe drains in, level tops off to 1 exactly as the tail lands
  //   prune  : leftmost block digests   ·   step : chain advances
  if (syncState.shown == null) { syncState.shown = 0; syncState.prunedBelow = -L - 1; syncState.phase = "arrive"; syncState.fp = 0; syncState.pruneT = 0; syncState.nh = 0; syncState.nt = 0; }
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
      if (syncState.nt >= 1) { syncState.fp = 1; syncState.nh = 0; syncState.nt = 0; syncState.phase = "prune"; syncState.pruneT = 0; }
    } else if (syncState.phase === "prune") {
      syncState.pruneT += (1 / 60) / pruneDur; if (syncState.pruneT >= 1) { syncState.pruneT = 1; syncState.prunedBelow += 1; syncState.phase = "step"; syncState.sp = 0; }
    } else {
      syncState.sp += (1 / 60) / stepDur; if (syncState.sp >= 1) { syncState.shown += 1; syncState.phase = "arrive"; syncState.fp = 0; syncState.nh = 0; syncState.nt = 0; if (syncState.pending > 0) syncState.pending -= 1; } // one mined block committed
    }
  } else { syncState.phase = "arrive"; syncState.fp = 0; syncState.nh = 0; syncState.nt = 0; }
  syncState.streams = syncState.streams || {};
  const sp = syncState.sp || 0;
  const stepEase = syncState.phase === "step" ? 1 + 2.70158 * Math.pow(sp - 1, 3) + 1.70158 * Math.pow(sp - 1, 2) : 0;
  const hs = syncState.shown + stepEase;
  const arriving = downloading && flowing && syncState.phase === "arrive";
  const filling = downloading && flowing && (syncState.phase === "fill" || syncState.phase === "topoff");
  const newestFill = !downloading ? 0 : syncState.fp; // 0 until the leading edge lands, then rises with the water
  const blockX = (k) => birthX - (hs - k) * spacing;
  const dispHeight = (k) => Math.floor(head) + 1 - (syncState.shown - k); // center (k=shown) = head+1, the block being obtained; left = head, head-1 …

  // current synced block vs the block the network is mining right now (tip + 1)
  const mining = tip + 1;
  const prog = node && node.verificationprogress != null ? node.verificationprogress : (tip ? Math.min(1, head / tip) : 1);
  text(`synced #${Math.floor(head).toLocaleString()}`, r.x + 16, r.y + 34, { size: 11, weight: 600, color: "rgba(255,255,255,0.72)", baseline: "middle" });
  text(`mining #${mining.toLocaleString()}`, r.x + r.w - 16, r.y + 34, { size: 11, weight: 700, color: `rgba(${ACCENT},0.85)`, align: "right", baseline: "middle" });
  const spX = r.x + 16, spW = r.w - 32; ctx.fillStyle = "rgba(255,255,255,0.1)"; roundRect(spX, r.y + 44, spW, 6, 3); ctx.fill(); ctx.fillStyle = `rgba(${ACCENT},0.85)`; roundRect(spX, r.y + 44, Math.max(4, spW * prog), 6, 3); ctx.fill();
  text(behind > 0 ? `${(prog * 100).toFixed(1)}% · ${behind.toLocaleString()} blocks behind the tip` : "at the tip — waiting for the next block to be mined", r.x + r.w / 2, r.y + 56, { size: 9, color: "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });

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
    }
  }

  // ---- your node (centered, above the new block) ----
  ctx.font = "700 16px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fillText(CYBER[frame % CYBER.length], cx, nodeY);
  ctx.strokeStyle = `rgba(${ACCENT},0.9)`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, nodeY, 12, 0, 7); ctx.stroke();
  text("your node", cx, nodeY + 20, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });

  // node → new block: the stream's head/tail are driven by the fill phase machine above, so the water
  // and the block level are one system — the level only moves once the leading edge lands and tops off
  // exactly as the trailing edge lands. Glyphs land on the rising fill surface.
  {
    const dropTop = nodeY + 14, surfaceY = cy + bh / 2 - 3 - (bh - 6) * newestFill;
    const st = { head: syncState.nh, tail: syncState.nt, phase: syncState.nph };
    drawStream(cx, dropTop, cx, surfaceY, st, 0.95);
    if (syncState.phase === "fill" && flowing) { const sp2 = 2 + 1.5 * Math.abs(Math.sin(frame * 0.4)); ctx.beginPath(); ctx.arc(cx, surfaceY, sp2, 0, 7); ctx.fillStyle = "rgba(255,215,140,0.9)"; ctx.fill(); } // splash while water is landing
  }

  // ---- pruner at the far left ----
  const prX = leftExit - 2, pruning = syncState.phase === "prune";
  for (let g = 0; g < 4; g++) { const a = (pruning ? 0.6 : 0.3) + 0.4 * Math.abs(Math.sin(frame * (pruning ? 0.3 : 0.12) + g * 0.9)); ctx.font = "700 13px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = `rgba(255,150,60,${a})`; ctx.fillText(CYBER[(frame + g * 7) % CYBER.length], prX, cy - 20 + g * 13); }
  text(pruning ? "pruning ♻" : "prune ♻", prX, cy + 40, { size: 9, weight: pruning ? 700 : 400, color: `rgba(255,150,60,${pruning ? 0.95 : 0.7})`, align: "center", baseline: "middle" });

  // ---- conveyor: blocks born at center, step left, prune at far left ----
  // persistent empty slot directly under the node — kept neutral so the next-to-fill block isn't highlighted
  { const fy = cy - bh / 2; ctx.setLineDash([4, 3]); ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; roundRect(birthX, fy, bw, bh, 4); ctx.stroke(); ctx.setLineDash([]); }
  const span = Math.ceil((birthX - leftExit) / spacing) + 4, pruneTarget = syncState.prunedBelow + 1;
  for (let k = Math.ceil(hs); k > Math.floor(hs) - span; k--) {
    const x = blockX(k);
    if (x > cx + bw || x < r.x + m - bw) continue;
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
    if (lbl) text(lbl, cx, cy - bh / 2 - 8, { size: 9, color: `rgba(${ACCENT},${filling ? 0.7 : 0.45})`, align: "center", baseline: "middle" });
  }
  if (SYNC_DEBUG) text(`DBG phase=${syncState.phase} fp=${(syncState.fp||0).toFixed(2)} fill%=${Math.round(newestFill*100)} nh=${(syncState.nh||0).toFixed(2)} nt=${(syncState.nt||0).toFixed(2)} flow=${Math.round(syncState.flow/1000)}KB/s dl=${downloading} fill=${filling} shown=${Math.floor(syncState.shown)} head=${Math.floor(head)}`, r.x + 16, r.y + r.h - 4, { size: 9, color: "#0f0", baseline: "alphabetic", mono: true });

  // ---- right side: distance from my sync frontier to the block being mined scales with `behind` ----
  // Synced (behind ≈ 0): head+1 == tip+1, so the block being mined IS the center slot — they sit together.
  // During IBD: the mining block is far right, with the upcoming slots + the gap of blocks still to download.
  const my = cy - bh / 2;
  const synced = behind <= 2;
  const mineX = synced ? birthX : (r.x + r.w - m - bw), mineCx = mineX + bw / 2;
  if (!synced) {
    const lastX = mineX - spacing, lastCx = lastX + bw / 2; // latest already-mined block (#tip), beside the one being mined
    let fx = birthX + spacing, fh = Math.floor(head) + 2, lastRight = birthX + bw;
    while (fx + bw <= lastX - spacing * 0.8) {
      ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lastRight, cy); ctx.lineTo(fx, cy); ctx.stroke(); // neutral: future blocks aren't confirmed
      ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; roundRect(fx, my, bw, bh, 4); ctx.stroke(); ctx.setLineDash([]);
      text("#" + (fh % 100000), fx + bw / 2, cy, { size: 9, color: "rgba(255,255,255,0.28)", align: "center", baseline: "middle" });
      lastRight = fx + bw; fx += spacing; fh += 1;
    }
    text("upcoming →", birthX + spacing + 2, my - 8, { size: 9, color: "rgba(255,255,255,0.35)", baseline: "middle" });
    // dashed gap: the blocks between my synced block and the tip (what's left to download)
    ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.setLineDash([2, 5]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lastRight, cy); ctx.lineTo(lastX, cy); ctx.stroke(); ctx.setLineDash([]); // neutral gap, not confirmed-orange
    text(`⋯ ${behind.toLocaleString()} blocks to the tip ⋯`, (lastRight + lastX) / 2, cy - 11, { size: 9, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    // the latest already-mined block (the current tip)
    const lastInfo = (model.recentBlocks && model.recentBlocks.length) ? model.recentBlocks[model.recentBlocks.length - 1] : null;
    drawConveyorBlock(lastX, cy, bw, bh, tip, lastInfo, 1, 0);
    text("last mined", lastCx, my - 8, { size: 9, weight: 700, color: "rgba(90,210,140,0.9)", align: "center", baseline: "middle" });
    text("#" + (tip || 0).toLocaleString(), lastCx, cy + bh / 2 + 14, { size: 9, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    ctx.strokeStyle = `rgba(${ACCENT},0.6)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lastX + bw, cy); ctx.lineTo(mineX, cy); ctx.stroke(); // solid link: tip → tip+1
  }

  // the block the network is mining right now (#tip+1). When synced it IS the center slot; its churn shows
  // only while waiting — when a freshly-found block is streaming in, the center shows the fill instead.
  if (!synced || !downloading) {
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(syncState.t * 2));
    // "mining progress" ≈ time since the last block vs the ~10-min average. PoW has no real progress (it's a
    // random search), so elapsed time is the honest proxy.
    const sinceBlock = model.block && model.block.timestamp ? Math.max(0, Date.now() / 1000 - model.block.timestamp) : 0;
    const mineProg = Math.max(0.04, Math.min(1, sinceBlock / 600));
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
    text(`⛏ mining · ~${Math.round(mineProg * 100)}%`, mineCx, my - 8, { size: 9, weight: 700, color: "rgba(255,150,60,0.9)", align: "center", baseline: "middle" });
    text("#" + ((tip || 0) + 1).toLocaleString(), mineCx, cy + bh / 2 + 14, { size: 9, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
    // readout: a relaying node shows its mempool filling; a blocksonly node receives whole blocks, no tx stream
    if (synced) {
      const note = relaying ? `mempool ${mp.count.toLocaleString()} tx${mp.rate > 0 ? ` · +${mp.rate}/s` : ""}` : "blocksonly · receives whole blocks";
      text(note, mineCx, cy + bh / 2 + 26, { size: 9, color: relaying ? "rgba(90,210,140,0.85)" : "rgba(255,255,255,0.45)", align: "center", baseline: "middle" });
    }
    // tx relay stream into the block — only on a relaying node (a blocksonly node gets nothing until the block lands)
    if (synced && relaying) {
      const st = tickStream(syncState.streams, "__mine", true, 0.7 + Math.min(1.6, Math.max(0, mp.rate) / 6));
      drawStream(cx, nodeY + 14, mineCx, my - 1, st, 0.7);
    }
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

function drawNetwork(r) {
  let y = r.y + 16;
  if (model.difficulty) {
    const odds = model.difficulty * 4294967296;
    text(`Difficulty ${model.difficulty.toExponential(2)}  ·  ~1 in ${odds.toExponential(2)} per hash`, r.x + r.w / 2, y, { size: 14, weight: 600, color: `rgba(${ACCENT}, 0.9)`, align: "center", baseline: "middle" });
    y += 26;
  }
  const gap = 24, cw = (r.w - gap * 2) / 3, ch = r.y + r.h - y - 6;
  const cards = [
    { title: model.price ? `BTC $${Math.round(model.price).toLocaleString()}` : "BTC price", spark: model.priceHistory, color: "rgb(70,220,130)" },
    { title: model.hashrateEh ? `${model.hashrateEh.toFixed(0)} EH/s` : "Hashrate", spark: model.hashrateHistory, color: `rgb(${ACCENT})` },
    { title: "Next halving", halving: true },
  ];
  cards.forEach((c, i) => {
    const cx = r.x + i * (cw + gap);
    ctx.fillStyle = "rgba(255,255,255,0.05)"; roundRect(cx, y, cw, ch, 8); ctx.fill();
    text(c.title, cx + 10, y + 18, { size: 13, weight: 600, color: "rgba(255,255,255,0.7)" });
    const body = { x: cx + 10, y: y + 28, w: cw - 20, h: ch - 38 };
    if (c.halving) drawHalvingCard(body); else sparkline(body, c.spark, c.color);
  });
}

// ---- sync preview/demo: fabricate an IBD node so the sync animation can be previewed when caught up ----
let syncDemo = new URLSearchParams(location.search).has("syncdemo");
if (syncDemo) expanded.add("sync"); // ?syncdemo=1 → open the sync panel for the preview
let demoHead = null, demoTip = null, demoStage = "ibd", demoT0 = 0, demoBlkMs = 0, demoMined = 0;
function demoNode() {
  const realTip = model.tipHeight || 900000, now = Date.now();
  if (demoHead == null || demoTip == null || demoTip < realTip - 1 || demoTip > realTip + 60) { demoTip = realTip; demoHead = realTip - 48000; demoStage = "ibd"; demoT0 = now; demoBlkMs = now; demoMined = 0; }
  if (demoStage === "ibd") {
    const prog = Math.min(1, (now - demoT0) / 12000); // catch up over ~12 real seconds (time-based, fps-independent)
    demoHead = (demoTip - 48000) + prog * 48000;
    if (prog >= 1) { demoHead = demoTip; demoStage = "mining"; demoBlkMs = now; } // caught up → mining the tip
  } else { // mining: caught up; the network finds a new block every ~5s (head & tip advance together)
    if (now - demoBlkMs > 5000) { demoTip += 1; demoHead += 1; demoBlkMs = now; demoMined += 1; }
    if (demoMined >= 5) { demoStage = "ibd"; demoTip = realTip; demoHead = realTip - 48000; demoT0 = now; demoMined = 0; } // loop back to show IBD again
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
  return { ts: 0, reachable: true, blocks: Math.floor(demoHead), headers: tip, verificationprogress: ibd ? demoHead / tip : 0.99999, initialblockdownload: ibd, size_on_disk: 15.2e9, pruned: true, mempool, peers };
}
window.addEventListener("keydown", (e) => {
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
function render() {
  if (syncDemo) model.node = demoNode(); // override with the simulated IBD node for preview
  drawRain(); // fixed background

  const { frames, total } = layoutSections();
  maxScroll = Math.max(0, total + 24 - H);
  if (scrollY > maxScroll) scrollY = maxScroll;

  ctx.save();
  ctx.translate(0, -scrollY);
  text("₿ITCOIN LOTTERY", W / 2, 40, { size: 28, weight: 800, align: "center", baseline: "middle" });
  const quoteAlpha = 0.45 + 0.12 * Math.sin(clock * 1.5);
  // both states render through the same monospace layout (p≥1 = fully resolved) so the text never shifts
  drawDecodeQuote(quotePhase === "hold" ? quoteText(quoteIdx) : quoteText(quoteNext), quotePhase === "hold" ? 2 : quoteT / Q_DECODE, quoteAlpha);
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
      if (f.content) drawContent(f.section, f.content);
    }
  }
  ctx.restore();

  // scrollbar indicator (fixed)
  if (maxScroll > 0) {
    const trackH = H - 16, th = Math.max(40, (trackH * H) / (total + 24)), ty = 8 + (trackH - th) * (scrollY / maxScroll);
    ctx.fillStyle = "rgba(255,255,255,0.16)"; roundRect(W - 7, ty, 4, th, 2); ctx.fill();
  }
  // fixed footer — accent-tinted so the version is easy to read but still understated
  text(`practice — 1 hash/block, not submitted to the network · ${VERSION}`, W - PAD, H - 14, { size: 13, weight: 700, color: `rgba(${ACCENT}, 0.85)`, align: "right", baseline: "middle" });
  if (syncDemo) text("◉ SYNC DEMO — simulated · press D or Esc to exit (back to your live node)", PAD, H - 14, { size: 13, weight: 700, color: "rgba(90,210,140,0.95)", baseline: "middle" });

  clock += 0.02; frame++;
  quoteT += 1 / 60;
  if (quotePhase === "hold") { if (quoteT > Q_HOLD) { quotePhase = "decode"; quoteT = 0; quoteNext = nextQuoteIdx(quoteIdx); } }
  else if (quoteT > Q_DECODE) { quotePhase = "hold"; quoteT = 0; quoteIdx = quoteNext; }
  window.__q = { phase: quotePhase, idx: quoteIdx, next: quoteNext, bag: quoteBag.length };
  requestAnimationFrame(render);
}

// ---- interaction ----
let hoverSection = null;
function sectionAt(px, py) {
  for (const f of headerHits) { const r = f.header; if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return f.section; }
  return null;
}
canvas.addEventListener("click", (e) => {
  const s = sectionAt(e.offsetX, e.offsetY + scrollY);
  if (s) { if (expanded.has(s)) expanded.delete(s); else expanded.add(s); saveExpanded(); }
});
canvas.addEventListener("mousemove", (e) => {
  hoverSection = sectionAt(e.offsetX, e.offsetY + scrollY);
  canvas.classList.toggle("clickable", !!hoverSection);
});
canvas.addEventListener("wheel", (e) => {
  if (maxScroll <= 0) return;
  e.preventDefault();
  scrollY = Math.max(0, Math.min(scrollY + e.deltaY, maxScroll));
}, { passive: false });

// ---- boot ----
resize();
pollNode();
refresh();
loadHistory();
setInterval(pollNode, 3_000);
setInterval(refresh, REFRESH_MS);
setInterval(loadHistory, 300_000);
render();
