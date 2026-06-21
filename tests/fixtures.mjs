// Deterministic mock data for snapshot tests. Every value is fixed, and the mined block's hash is the
// real double-SHA256 of its header fields, so the HASH BUILD panel shows a clean "✓ verified" baseline.
import crypto from "node:crypto";

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const revHex = (hex) => Buffer.from(hex, "hex").reverse();
const sha = (b) => crypto.createHash("sha256").update(b).digest();

// the exact block the (fake) miner is working on
const ATT = {
  height: 954470,
  version: 0x20000000,
  prev_hash: "00000000000000000000164c0521899c2ace28639352efb1e6f7faa1f1ab0d6fd",
  merkle_root: "f576d43263ff8056c3cfa68d456e059d02d48d09413ead2e58ef020ffd0c3dc0",
  timestamp: 1718901234,
  bits: 0x17028c61,
  nonce: 3550301251,
  tx_count: 1,
};
const header = Buffer.concat([u32le(ATT.version), revHex(ATT.prev_hash), revHex(ATT.merkle_root), u32le(ATT.timestamp), u32le(ATT.bits), u32le(ATT.nonce)]);
const ATT_HASH = Buffer.from(sha(sha(header))).reverse().toString("hex"); // display (big-endian) — what the daemon submits
const ATT_LZ = 256 - BigInt("0x" + ATT_HASH).toString(2).length;
// target from compact "bits"
const exp = ATT.bits >>> 24, mant = ATT.bits & 0xffffff;
const TARGET_HEX = (BigInt(mant) << (8n * BigInt(exp - 3))).toString(16).padStart(64, "0");

const TIP_HASH = "0000000000000000000164c0521899c2ace28639352efb1e6f7faa1f1ab0d6fd".padStart(64, "0");
const PRICE = 62978;

// a winning-style hash for recent blocks / the celebration preview (~19 leading zero hex)
const winHash = (n) => "0000000000000000000" + (BigInt("0x1a2b3c4d5e6f") + BigInt(n)).toString(16).padStart(45, "a");

// fixed leading-zero-bits histogram so the odds-map heat cloud is identical every run
const ZHIST = {}; for (let b = 0; b <= 12; b++) ZHIST[b] = Math.round(1400 * Math.pow(0.55, b));

const NODE = {
  ts: 1718901234, reachable: true, blocks: 954469, headers: 954469, verificationprogress: 0.99999,
  initialblockdownload: false, size_on_disk: 9_800_000_000, pruned: true,
  mempool: { count: 4200, bytes: 2_300_000, rate: 12, relay: false },
  miner: {
    mode: "live", seed: "test-seed", live_attempts: 184213, total_attempts: 184213, live_wins: 0,
    payout: "bc1qxs6dnz2tnnzv8m5nrsw76a53jh25svjsfph2fn",
    attempt: { height: ATT.height, hash: ATT_HASH, target: TARGET_HEX, nonce: ATT.nonce, won: false,
      leading_zero_bits: ATT_LZ, version: ATT.version, prev_hash: ATT.prev_hash, merkle_root: ATT.merkle_root,
      timestamp: ATT.timestamp, bits: ATT.bits, tx_count: ATT.tx_count },
    best: { zero_bits: 24, height: 954001, hash: "000000" + "a3c1f5".padEnd(58, "9"), nonce: 7, at: 1718800000 },
    zhist: ZHIST,
  },
  miner_proc: { cpu: 0.0, mem_mb: 14.9 },
  nettotals: { recv: 31_400_000_000, sent: 8_900_000_000, ms: 1718901234000 },
  lottery_blocks: [],
  payout: { masked: "bc1qxs…fph2fn", is_default: false, valid: true, status: "ok" },
  peers: [],
};

// /block/{hash}
const BLOCK = {
  id: winHash(0), height: 954469, version: ATT.version, previousblockhash: ATT.prev_hash,
  merkle_root: ATT.merkle_root, timestamp: 1718900400, bits: ATT.bits, tx_count: 3120, difficulty: 1.25e14,
};
const POOLS = ["Foundry USA", "AntPool", "ViaBTC", "F2Pool", "Binance Pool", "MARA Pool", "Luxor", "SBI Crypto"];
const RECENT = Array.from({ length: 8 }, (_, i) => ({
  height: 954469 - i, id: winHash(i + 1), tx_count: 2500 + i * 37, size: 1_500_000,
  extras: { pool: { name: POOLS[i] }, coinbaseRaw: "03" + (954469 - i).toString(16) + "2f" + POOLS[i].replace(/\s/g, "") + "2f" },
}));
const now = 1718901234;
const HR1M = {
  hashrates: Array.from({ length: 30 }, (_, i) => ({ timestamp: now - (30 - i) * 86400, avgHashrate: (6.0 + Math.sin(i / 4) * 0.6) * 1e20 })),
  difficulty: Array.from({ length: 6 }, (_, i) => ({ time: now - (6 - i) * 14 * 86400, height: 950000 + i * 2016, difficulty: (8.0 + i * 0.15) * 1e13, adjustment: 1 + i * 0.4 })),
  currentHashrate: 6.4e20, currentDifficulty: 1.25e14,
};
const HISTPRICE = { prices: Array.from({ length: 168 }, (_, i) => ({ time: now - (168 - i) * 3600, USD: Math.round(PRICE + Math.sin(i / 9) * 1800 + i * 6) })) };
const DIFFADJ = { difficultyChange: 4.3, remainingBlocks: 1080, remainingTime: 648000, timeAvg: 580000, progressPercent: 46, previousRetarget: -1.2 };

// mempool: a fixed pending pool + projected blocks for the tx-flow viz
const MEMPOOL = { count: 103683, vsize: 43_240_000, fee_histogram: [[1, 5e6], [2, 8e6], [3, 6e6], [5, 4e6], [8, 3e6], [15, 2e6], [30, 1.5e6], [60, 1e6], [120, 5e5], [300, 2e5]] };
// 7 full single blocks (varying byte size, like real data: witness data makes some heavier) + a giant
// aggregate of the deep backlog as the 8th entry (mempool.space does this; our code filters it out)
const BLK_SIZE = [1_550_000, 1_580_000, 1_630_000, 2_400_000, 1_630_000, 1_820_000, 1_710_000];
const MEMPOOL_BLOCKS = Array.from({ length: 8 }, (_, i) => i < 7
  ? { nTx: 6200 - i * 180, blockSize: BLK_SIZE[i], blockVSize: 1_000_000, medianFee: Math.max(0.5, 9 - i), feeRange: [Math.max(0.4, 7 - i), 8 - i, 9 - i, 10 - i, 13 - i, 22 - i, 250], totalFees: 5_200_000 }
  : { nTx: 61000, blockSize: 112_000_000, blockVSize: 36_000_000, medianFee: 0.1, feeRange: [0.1, 0.1, 0.1, 0.1, 0.1, 0.5, 250], totalFees: 0 });
// real recent txs (mempool.space /mempool/recent shape): fee in sat, vsize, value in sat — incl a whale
const RECENT_TXS = [
  { txid: "a1", fee: 1400, vsize: 200, value: 52_000_000 }, { txid: "a2", fee: 9000, vsize: 560, value: 230_000_000 },
  { txid: "a3", fee: 320, vsize: 140, value: 8_900_000 }, { txid: "a4", fee: 64000, vsize: 1800, value: 1_240_000_000 },
  { txid: "a5", fee: 2100, vsize: 380, value: 71_000_000 }, { txid: "a6", fee: 540, vsize: 220, value: 3_200_000 },
];

export async function installMocks(page) {
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/node.json*", (r) => json(r, NODE));
  await page.route("**/api/mempool", (r) => json(r, MEMPOOL));
  await page.route("**/api/mempool/recent", (r) => json(r, RECENT_TXS));
  await page.route("**/api/v1/fees/recommended", (r) => json(r, { fastestFee: 9, halfHourFee: 5, hourFee: 3, economyFee: 2, minimumFee: 1 }));
  await page.route("**/api/v1/fees/mempool-blocks", (r) => json(r, MEMPOOL_BLOCKS));
  await page.route("**/api/blocks/tip/hash", (r) => r.fulfill({ status: 200, contentType: "text/plain", body: TIP_HASH }));
  await page.route("**/api/block/*", (r) => json(r, BLOCK));
  await page.route("**/api/v1/blocks*", (r) => json(r, RECENT));
  await page.route("**/api/v1/prices", (r) => json(r, { USD: PRICE }));
  await page.route("**/api/v1/mining/hashrate/3d", (r) => json(r, { currentHashrate: 6.4e20 }));
  await page.route("**/api/v1/mining/hashrate/1m", (r) => json(r, HR1M));
  await page.route("**/api/v1/difficulty-adjustment", (r) => json(r, DIFFADJ));
  await page.route("**/api/v1/historical-price*", (r) => json(r, HISTPRICE));
}
