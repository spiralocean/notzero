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
const model = { tipHeight: null, block: null, txCount: null, price: null, hashrateEh: null, difficulty: null, ticket: null, error: null, priceHistory: [], hashrateHistory: [], recentBlocks: [] };

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

// ---- quotes ----
const QUOTES = [
  "So you're tellin' me there's a chance?",
  "Someone wins every block. Why not you?",
  "One ticket per block. One shot at glory.",
  "The lottery is hope with a timestamp.",
  "One in 2²⁵⁶ is still one.",
  "Every hash is a roll of the cosmic dice.",
  "Statistically improbable ≠ impossible.",
  "The hash doesn't know it's supposed to be impossible.",
];

// ---- layout + sections ----
const PAD = 36, HEADER_H = 40, GAP = 12, TOP = 116;
const CONTENT_H = { nextBlock: 150, closeness: 124, hashBuild: 300, network: 180, sync: 430 };
let headerHits = [];
let scrollY = 0, maxScroll = 0;
let clock = 0, quoteIdx = 0, quoteT = 0, frame = 0;
const VERSION = "web v0.9.0";

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

// ---- BLOCKCHAIN SYNC: a continuous conveyor — fill, link, prune, repeat ----
const syncState = { t: 0 };
const mbFmt = (s) => (s / 1e6).toFixed(2) + " MB";

function convBlockInfo(k, kMax) {
  const rb = model.recentBlocks;
  const info = (rb && rb.length) ? rb[((k % rb.length) + rb.length) % rb.length] : {};
  const height = model.tipHeight ? model.tipHeight - (kMax - k) : null;
  return { height, size: info.size, tx: info.tx, pool: info.pool, id: info.id };
}

function drawConveyorBlock(k, kMax, x, cy, bw, bh, fill, fade) {
  const a = 1 - fade;
  if (a <= 0.05) { // pruned away — a few dissolving specks, then nothing
    for (let d = 0; d < 3; d++) { ctx.globalAlpha = Math.max(0, 0.35 * (a / 0.05)); ctx.beginPath(); ctx.arc(x + 10 + d * 10, cy + (d - 1) * 6, 1.3, 0, 7); ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.fill(); }
    ctx.globalAlpha = 1; return;
  }
  const info = convBlockInfo(k, kMax), y = cy - bh / 2, verified = fill >= 1;
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(255,255,255,0.05)"; roundRect(x, y, bw, bh, 4); ctx.fill();
  // transactions filling the block (data pours in as it downloads)
  const target = info.size ? Math.min(18, Math.max(4, Math.round(info.size / 95000))) : 9;
  const shown = Math.max(0, Math.floor(target * fill));
  for (let d = 0; d < shown; d++) {
    const col = d % 6, row = Math.floor(d / 6), dx = x + 9 + col * ((bw - 18) / 5), dy = y + 15 + row * 10;
    ctx.beginPath(); ctx.arc(dx, dy, 1.5, 0, 7); ctx.fillStyle = verified ? "rgba(90,220,140,0.75)" : "rgba(255,200,120,0.8)"; ctx.fill();
  }
  ctx.strokeStyle = verified ? `rgba(${ACCENT},0.85)` : "rgba(255,255,255,0.3)"; ctx.lineWidth = verified ? 1.5 : 1; roundRect(x, y, bw, bh, 4); ctx.stroke();
  if (info.height) text("#" + (info.height % 100000), x + bw / 2, y + 8, { size: 9, weight: 700, color: "rgba(255,255,255,0.72)", align: "center", baseline: "middle" });
  if (info.size) text(mbFmt(info.size), x + bw / 2, y + bh - 7, { size: 8, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
  if (verified) text("✓", x + bw - 9, y + 8, { size: 11, weight: 700, color: "rgb(90,230,140)", align: "center", baseline: "middle" });
  ctx.globalAlpha = 1;
}

// a moving data packet rendered as a bright matrix glyph with a short hash trail
function dataComet(x0, y0, x1, y1, prog, seed) {
  const hx = x0 + (x1 - x0) * prog, hy = y0 + (y1 - y0) * prog;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1, nx = (x1 - x0) / len, ny = (y1 - y0) / len;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let tdx = 3; tdx >= 0; tdx--) {
    const bx = hx - nx * tdx * 9, by = hy - ny * tdx * 9;
    if (tdx === 0) { ctx.font = "700 12px ui-monospace, monospace"; ctx.fillStyle = "rgba(255,200,90,0.95)"; ctx.fillText(CYBER[(frame + seed) % CYBER.length], bx, by); }
    else { ctx.font = "11px ui-monospace, monospace"; ctx.fillStyle = `rgba(70,185,140,${Math.max(0.06, 0.6 * (1 - tdx / 4))})`; ctx.fillText("0123456789abcdef"[(seed + tdx * 3 + Math.floor(prog * 40)) % 16], bx, by); }
  }
}

function drawSync(r) {
  syncState.t += 1 / 60;
  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  text("SYNCING THE CHAIN — fill · link · prune", r.x + 16, r.y + 16, { size: 12, weight: 700, color: "rgba(255,255,255,0.55)", baseline: "middle" });

  // sync progress: where we are vs the chain tip (illustrative climb to 100%)
  const tip = model.tipHeight || 0;
  const syncProg = Math.min(1, (syncState.t % 44) / 40); // ~40s to sync, brief hold, then loop
  const syncedH = Math.floor(tip * syncProg), behind = tip - syncedH;
  text(`synced #${syncedH.toLocaleString()} / tip #${tip.toLocaleString()}`, r.x + 16, r.y + 34, { size: 11, weight: 600, color: "rgba(255,255,255,0.72)", baseline: "middle" });
  text(`${(syncProg * 100).toFixed(1)}%${behind > 0 ? "  ·  " + behind.toLocaleString() + " behind" : "  ·  caught up to tip"}`, r.x + r.w - 16, r.y + 34, { size: 11, weight: 700, color: `rgba(${ACCENT},0.85)`, align: "right", baseline: "middle" });
  const spX = r.x + 16, spW = r.w - 32, spY = r.y + 44;
  ctx.fillStyle = "rgba(255,255,255,0.1)"; roundRect(spX, spY, spW, 6, 3); ctx.fill();
  ctx.fillStyle = `rgba(${ACCENT},0.85)`; roundRect(spX, spY, Math.max(4, spW * syncProg), 6, 3); ctx.fill();

  // ---- peer tree (always visible) ----
  const cx = r.x + r.w / 2, youY = r.y + 136, peerN = 7;
  for (let i = 0; i < peerN; i++) {
    const px = r.x + r.w * (0.13 + 0.74 * (i / (peerN - 1))), py = r.y + 66 + (i % 2) * 12;
    ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, youY); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, 4, 0, 7); ctx.fillStyle = `rgba(${ACCENT},0.8)`; ctx.fill();
    dataComet(px, py, cx, youY, (syncState.t * 0.5 + i * 0.37) % 1, i * 5 + 1); // data flowing in from each peer
  }
  text("peers", r.x + r.w * 0.13, r.y + 56, { size: 10, color: "rgba(255,255,255,0.4)", baseline: "middle" });
  ctx.beginPath(); ctx.arc(cx, youY, 7, 0, 7); ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.9)`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, youY, 10, 0, 7); ctx.stroke();
  text("your node", cx, youY + 20, { size: 10, color: "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });

  // ---- conveyor: blocks fill on the right, slide left, prune at the far left ----
  const m = 22, bh = 54, gap = 14;
  const bw = Math.max(64, Math.min(108, (r.w - 2 * m) / 6 - gap)), spacing = bw + gap;
  const cy = r.y + r.h - 116, rightAnchor = r.x + r.w - m - bw, leftExit = r.x + m;
  const scroll = syncState.t * 17, kMax = Math.floor(scroll / spacing);
  const newestX = rightAnchor - (scroll - kMax * spacing);

  // data comets shooting from your node into the newest (filling) block
  for (let pk = 0; pk < 2; pk++) {
    dataComet(cx, youY, newestX + bw / 2, cy - bh / 2, (syncState.t * 0.6 + pk * 0.5) % 1, pk * 11 + 3);
  }

  // pruner: a little cluster of glyphs at the left edge digesting old blocks
  const prX = leftExit - 2;
  for (let g = 0; g < 4; g++) {
    const a = 0.35 + 0.5 * Math.abs(Math.sin(frame * 0.12 + g * 0.9));
    ctx.font = "700 13px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(255,150,60,${a})`; ctx.fillText(CYBER[(frame + g * 7) % CYBER.length], prX, cy - 20 + g * 13);
  }
  text("prune ♻", prX, cy + 40, { size: 9, color: "rgba(255,150,60,0.75)", align: "center", baseline: "middle" });

  const span = Math.ceil((rightAnchor - leftExit) / spacing) + 2;
  for (let k = kMax + 1; k >= kMax - span; k--) {
    const x = rightAnchor - scroll + k * spacing;
    if (x < r.x + m - bw || x > r.x + r.w) continue;
    const ageSlots = (scroll - k * spacing) / spacing;
    if (ageSlots < 0) continue; // not born yet (just off the right edge)
    const fill = Math.min(1, ageSlots / 1.3);
    const fade = x < leftExit ? 1 : (x < leftExit + spacing ? (leftExit + spacing - x) / spacing : 0);
    if (fade > 0.12) { // being pruned — particles consumed into the pruner
      for (let p = 0; p < 2; p++) {
        const pp = (syncState.t * 1.8 + p * 0.5 + k * 0.3) % 1, sy = cy + (p - 0.5) * 12;
        ctx.beginPath(); ctx.arc(x + (prX + 2 - x) * pp, sy + (cy - sy) * pp, 1.6, 0, 7); ctx.fillStyle = `rgba(255,170,80,${0.7 * (1 - pp)})`; ctx.fill();
      }
    }
    if (fill >= 1) { // chain link to the previous (left) block
      ctx.globalAlpha = 1 - fade; ctx.strokeStyle = `rgba(${ACCENT},0.6)`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - gap, cy); ctx.lineTo(x, cy); ctx.stroke(); ctx.globalAlpha = 1;
    }
    drawConveyorBlock(k, kMax, x, cy, bw, bh, fill, fade);
  }
  text("← old blocks pruned (bodies freed)", leftExit, cy + bh / 2 + 16, { size: 10, color: "rgba(255,255,255,0.4)", baseline: "middle" });
  text("filling from peers →", r.x + r.w - m, cy + bh / 2 + 16, { size: 10, color: `rgba(${ACCENT},0.7)`, align: "right", baseline: "middle" });

  // ---- disk usage (single bar, zoomed): grows as blocks download, shrinks when pruning ----
  const dmin = 6, dmax = 17, cyc = (syncState.t * 0.5) % 1;
  const used = dmin + (dmax - dmin) * (cyc < 0.82 ? cyc / 0.82 : 1 - (cyc - 0.82) / 0.18);
  const dbX = r.x + 16, dbW = r.w - 32, dbY = r.y + r.h - 28, dbH = 12;
  ctx.fillStyle = "rgba(255,255,255,0.08)"; roundRect(dbX, dbY, dbW, dbH, 6); ctx.fill();
  ctx.fillStyle = "rgba(70,205,125,0.9)"; roundRect(dbX, dbY, Math.max(8, dbW * (used - dmin) / (dmax - dmin)), dbH, 6); ctx.fill();
  text(`disk ~${used.toFixed(1)} GB (zoom ${dmin}–${dmax} GB) · ${cyc >= 0.82 ? "pruning ▼" : "downloading ▲"}`, dbX, dbY - 7, { size: 10, weight: 600, color: "rgba(70,210,130,0.95)", baseline: "middle" });
  text("full archival ~640 GB (off-scale)", r.x + r.w - 16, dbY - 7, { size: 9, color: "rgba(255,255,255,0.4)", align: "right", baseline: "middle" });
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

// ---- render loop ----
function render() {
  drawRain(); // fixed background

  const { frames, total } = layoutSections();
  maxScroll = Math.max(0, total + 24 - H);
  if (scrollY > maxScroll) scrollY = maxScroll;

  ctx.save();
  ctx.translate(0, -scrollY);
  text("₿ITCOIN LOTTERY", W / 2, 40, { size: 28, weight: 800, align: "center", baseline: "middle" });
  text(QUOTES[quoteIdx], W / 2, 80, { size: 16, weight: 500, color: `rgba(255,255,255,${0.45 + 0.12 * Math.sin(clock * 1.5)})`, align: "center", baseline: "middle" });

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
  text(`practice mode · ${VERSION}`, W - PAD, H - 14, { size: 13, weight: 700, color: `rgba(${ACCENT}, 0.85)`, align: "right", baseline: "middle" });

  clock += 0.02; frame++;
  quoteT += 1 / 60; if (quoteT > 14) { quoteT = 0; quoteIdx = (quoteIdx + 1) % QUOTES.length; }
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
refresh();
loadHistory();
setInterval(refresh, REFRESH_MS);
setInterval(loadHistory, 300_000);
render();
