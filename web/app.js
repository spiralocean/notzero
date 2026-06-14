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
const SECTIONS = ["nextBlock", "closeness", "hashBuild", "network"];
const SECTION_TITLE = { nextBlock: "NEXT BLOCK", closeness: "YOUR CLOSENESS", hashBuild: "HASH BUILD", network: "NETWORK" };
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
const model = { tipHeight: null, block: null, price: null, hashrateEh: null, difficulty: null, ticket: null, error: null, priceHistory: [], hashrateHistory: [] };

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
    model.difficulty = blk.difficulty;

    const nonce = await pickNonce(machineSeed(), blk.height);
    const hashHex = await hashBlockHeader(blk, nonce);
    const target = bitsToTarget(blk.bits);
    model.ticket = { nonce, hashHex, prox: proximity(hashHex, target) };

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
const HEX = "0123456789abcdef";
let columns = [];
function ensureRain() {
  const spacing = 30, count = Math.ceil(W / spacing);
  if (columns.length === count) return;
  columns = Array.from({ length: count }, (_, i) => ({
    x: i * spacing + spacing / 2,
    y: Math.random() * H,
    speed: 1.5 + Math.random() * 3.5,
    len: 8 + (Math.floor(Math.random() * 16)),
  }));
}
function drawRain() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#06040c"); g.addColorStop(1, "#0a0603");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ensureRain();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const c of columns) {
    c.y += c.speed; if (c.y - c.len * 20 > H) c.y = -Math.random() * 200;
    for (let i = 0; i < c.len; i++) {
      const yy = c.y - i * 20;
      if (yy < -20 || yy > H + 20) continue;
      const ch = HEX[(Math.floor(c.x + yy + i) % 16 + 16) % 16];
      ctx.font = "20px ui-monospace, monospace";
      if (i === 0) ctx.fillStyle = `rgba(255, 183, 51, 0.85)`;
      else { const a = Math.max(0.04, 0.4 * (1 - i / c.len)); ctx.fillStyle = `rgba(40, 150, 120, ${a})`; }
      ctx.fillText(ch, c.x, yy);
    }
  }
  // center scrim so panels read
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
const CONTENT_H = { nextBlock: 150, closeness: 124, hashBuild: 300, network: 180 };
let headerHits = [];
let clock = 0, quoteIdx = 0, quoteT = 0;

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
  return frames;
}

function summary(s) {
  if (s === "nextBlock") { if (!model.block) return "—"; const e = Math.max(0, Math.floor(Date.now() / 1000 - model.block.timestamp)); return `${Math.floor(e / 60)}:${String(e % 60).padStart(2, "0")} since last`; }
  if (s === "closeness") { const p = model.ticket?.prox; return p ? (p.won ? "TARGET HIT" : `${p.label} · ${p.leadingZeroBits} zero bits`) : "—"; }
  if (s === "hashBuild") { return model.ticket ? "0x" + model.ticket.hashHex.slice(0, 10) + "…" : "—"; }
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

// HASH BUILD ceremony — the real 80-byte header fields assembling into your hash.
function drawHashBuild(r) {
  if (!model.block || !model.ticket) { text("waiting for chain data…", r.x + r.w / 2, r.y + r.h / 2, { size: 18, color: "#888", align: "center", baseline: "middle" }); return; }
  const b = model.block, t = model.ticket;
  ctx.fillStyle = "rgba(255,255,255,0.03)"; roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = `rgba(${ACCENT},0.18)`; ctx.lineWidth = 1; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  text("BUILDING THE BLOCK HEADER  ·  80 bytes, 6 fields", r.x + 14, r.y + 22, { size: 13, weight: 700, color: "rgba(255,255,255,0.6)" });

  const fields = [
    ["version", (b.version >>> 0).toString(16).padStart(8, "0")],
    ["prev block", b.previousblockhash.slice(0, 12) + "…"],
    ["merkle root", b.merkle_root.slice(0, 12) + "…"],
    ["time", String(b.timestamp)],
    ["bits", b.bits.toString(16)],
    ["NONCE — your pick", t.nonce.toLocaleString()],
  ];
  const active = Math.floor(clock * 1.2) % (fields.length + 2);
  const cols = 3, cw = (r.w - 28 - 2 * 10) / cols, chh = 46, gy = r.y + 36;
  fields.forEach(([label, val], i) => {
    const x = r.x + 14 + (i % cols) * (cw + 10), y = gy + Math.floor(i / cols) * (chh + 8);
    const isNonce = i === 5, isActive = i === active;
    ctx.fillStyle = isNonce ? `rgba(${ACCENT},0.16)` : "rgba(255,255,255,0.05)"; roundRect(x, y, cw, chh, 6); ctx.fill();
    if (isActive) { ctx.strokeStyle = `rgba(${ACCENT},0.9)`; ctx.lineWidth = 1.4; roundRect(x, y, cw, chh, 6); ctx.stroke(); }
    text(label, x + 8, y + 16, { size: 11, weight: 600, color: isNonce ? `rgba(${ACCENT},0.95)` : "rgba(255,255,255,0.5)" });
    text(val, x + 8, y + 36, { size: 14, weight: 600, color: isNonce ? `rgb(${ACCENT})` : "rgba(255,255,255,0.82)", mono: true });
  });
  const afterGrid = gy + 2 * (chh + 8) + 4;
  text("↓  double SHA-256", r.x + r.w / 2, afterGrid + 8, { size: 13, weight: 600, color: `rgba(${ACCENT},0.85)`, align: "center", baseline: "middle" });
  const hex = t.hashHex.slice(0, 40), lead = leadingZeroHexChars(t.hashHex), hy = afterGrid + 36, sp = (r.w - 40) / hex.length;
  for (let i = 0; i < hex.length; i++) { const isLead = i < lead; text(hex[i], r.x + 20 + sp * (i + 0.5), hy, { size: 15, weight: isLead ? 700 : 400, color: isLead ? `rgb(${ACCENT})` : "rgba(255,255,255,0.55)", align: "center", baseline: "middle", mono: true }); }
  text(t.prox.won ? "🎉 JACKPOT" : `no match · ${t.prox.leadingZeroBits} leading zero bits`, r.x + r.w / 2, hy + 26, { size: 13, weight: 600, color: t.prox.won ? "rgb(70,230,120)" : "rgba(255,255,255,0.5)", align: "center", baseline: "middle" });
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
  drawRain();
  // header
  text("₿ITCOIN LOTTERY", W / 2, 40, { size: 28, weight: 800, align: "center", baseline: "middle" });
  text(QUOTES[quoteIdx], W / 2, 80, { size: 16, weight: 500, color: `rgba(255,255,255,${0.45 + 0.12 * Math.sin(clock * 1.5)})`, align: "center", baseline: "middle" });

  headerHits = [];
  if (model.error) {
    text(model.error, W / 2, TOP + 40, { size: 16, color: "rgba(255,120,90,0.9)", align: "center", baseline: "middle" });
  } else {
    for (const f of layoutSections()) {
      const hov = hoverSection === f.section;
      drawHeader(f.section, f.header, !!f.content, hov);
      headerHits.push(f);
      if (f.content) drawContent(f.section, f.content);
    }
  }
  text("github.com/…  ·  practice mode", W - PAD, H - 16, { size: 13, color: "rgba(255,255,255,0.3)", align: "right", baseline: "middle" });

  clock += 0.02;
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
  const s = sectionAt(e.offsetX, e.offsetY);
  if (s) { if (expanded.has(s)) expanded.delete(s); else expanded.add(s); saveExpanded(); }
});
canvas.addEventListener("mousemove", (e) => {
  hoverSection = sectionAt(e.offsetX, e.offsetY);
  canvas.classList.toggle("clickable", !!hoverSection);
});

// ---- boot ----
resize();
refresh();
loadHistory();
setInterval(refresh, REFRESH_MS);
setInterval(loadHistory, 300_000);
render();
