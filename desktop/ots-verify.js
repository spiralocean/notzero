// ots-verify.js — verify an OpenTimestamps proof against the user's own Bitcoin node. No dependencies.
//
// What this proves, and what it doesn't (be honest about the security model):
//   • It confirms a file's hash is committed into a real Bitcoin block — verified against a block that YOUR node
//     independently validated (via RPC), trusting no external calendar or explorer. Because it only reads block
//     HEADERS, a pruned node (like the one notzero runs) is enough.
//   • OpenTimestamps proves a *timestamp* ("this hash existed by block N"), NOT authorship — anyone can timestamp
//     any file. So this is a tamper-evidence + on-chain-provenance layer that rides ALONGSIDE the signed
//     electron-updater feed (which provides authenticity over HTTPS); it is not a replacement for it.
//
// A proof is a chain of operations applied to the file's sha256, ending in an attestation. A Bitcoin attestation
// says "the value at this point IS the merkle root of the block at height H." We replay the ops to that value and
// check it against the node's header for block H. Format ref: github.com/opentimestamps/python-opentimestamps.

const crypto = require("crypto");

const MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex"); // "\x00OpenTimestamps\x00\x00Proof\x00" + 8-byte magic
const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex"); // BitcoinBlockHeaderAttestation
const PENDING_TAG = Buffer.from("83dfe30d2ef90c8e", "hex"); // PendingAttestation (calendar — not yet in a block)
const MAX_PROOF_BYTES = 100 * 1024; // proofs are a few hundred bytes; cap to bound parsing work

function digest(algo, buf) { return crypto.createHash(algo).update(buf).digest(); }

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  u8() { if (this.p >= this.b.length) throw new Error("truncated proof"); return this.b[this.p++]; }
  take(n) { if (this.p + n > this.b.length) throw new Error("truncated proof"); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  varuint() { let x = 0, shift = 0, byte; do { byte = this.u8(); x += (byte & 0x7f) * 2 ** shift; shift += 7; if (shift > 63) throw new Error("varint too long"); } while (byte & 0x80); return x; }
  varbytes() { return this.take(this.varuint()); }
}

// apply one op to the running message (crypto ops shrink/transform; append/prepend concatenate a constant)
function applyOp(r, tag, msg) {
  switch (tag) {
    case 0x08: return digest("sha256", msg);
    case 0x03: return digest("ripemd160", msg);
    case 0x02: return digest("sha1", msg);
    case 0xf0: return Buffer.concat([msg, r.varbytes()]); // append
    case 0xf1: return Buffer.concat([r.varbytes(), msg]); // prepend
    default: throw new Error("unsupported op 0x" + tag.toString(16)); // 0x67 keccak / 0xf2 reverse never appear on a Bitcoin path
  }
}

// A timestamp serializes as: zero-or-more `\xff`-prefixed edges, then one final edge. Each edge is either an
// attestation (\x00) or an op that leads to a nested timestamp. Walk it, collecting every attestation + the
// message value at that point.
function walk(r, msg, out, depth) {
  if (depth > 256) throw new Error("proof nested too deep");
  const edge = (tag) => {
    if (tag === 0x00) {
      const attTag = r.take(8), payload = r.varbytes();
      if (attTag.equals(BITCOIN_TAG)) out.push({ type: "bitcoin", height: new Reader(payload).varuint(), root: Buffer.from(msg) });
      else out.push({ type: attTag.equals(PENDING_TAG) ? "pending" : "other" });
    } else {
      walk(r, applyOp(r, tag, msg), out, depth + 1);
    }
  };
  let tag = r.u8();
  while (tag === 0xff) { edge(r.u8()); tag = r.u8(); }
  edge(tag);
}

// Parse an .ots proof → { fileDigest (hex), bitcoin: [{height, merkleRoot}], pending }.
// merkleRoot is returned in Bitcoin RPC display order (reversed vs the proof's internal byte order).
function parseProof(otsBytes) {
  const buf = Buffer.from(otsBytes);
  if (buf.length > MAX_PROOF_BYTES) throw new Error("proof too large");
  const r = new Reader(buf);
  if (!r.take(MAGIC.length).equals(MAGIC)) throw new Error("not an OpenTimestamps proof");
  if (r.varuint() !== 1) throw new Error("unsupported proof version");
  const fhTag = r.u8();
  const algo = fhTag === 0x08 ? "sha256" : fhTag === 0x03 ? "ripemd160" : fhTag === 0x02 ? "sha1" : null;
  if (!algo) throw new Error("unsupported file-hash op");
  const fileDigest = r.take(algo === "sha256" ? 32 : 20);
  const atts = [];
  walk(r, fileDigest, atts, 0);
  return {
    fileDigest: fileDigest.toString("hex"),
    pending: atts.some((a) => a.type === "pending"),
    bitcoin: atts.filter((a) => a.type === "bitcoin").map((a) => ({ height: a.height, merkleRoot: Buffer.from(a.root).reverse().toString("hex") })),
  };
}

// Verify a proof against the running node.
//   otsBytes            the .ots proof
//   expectedFileDigest  sha256 hex of the file the proof should be for (e.g. sha256(SHA256SUMS)); optional
//   rpc(method, params) async → { ok:true, result } | { ok:false, error }  (main.js's rpcCall)
// Returns { status, ... }:
//   "verified"     the file's hash is committed in a block your node validated  → { height, blockhash, blockTime, merkleRoot }
//   "mismatch"     DANGER — the proof is for a different file, or commits to a root that isn't that block's
//   "pending"      the proof hasn't been confirmed into a Bitcoin block yet (upgrade later)
//   "inconclusive" couldn't check (node unreachable / behind / missing header) — caller should fall back, not block
async function verifyAgainstNode(otsBytes, expectedFileDigest, rpc) {
  let proof;
  try { proof = parseProof(otsBytes); } catch (e) { return { status: "inconclusive", reason: "unreadable proof: " + e.message }; }
  if (expectedFileDigest && proof.fileDigest !== expectedFileDigest) return { status: "mismatch", reason: "proof is for a different file" };
  if (!proof.bitcoin.length) return { status: "pending", reason: "not yet confirmed into a Bitcoin block" };
  for (const att of proof.bitcoin) {
    const bh = await rpc("getblockhash", [att.height]);
    if (!bh.ok || !bh.result) return { status: "inconclusive", reason: "your node has no block at height " + att.height + " yet" };
    const hdr = await rpc("getblockheader", [bh.result]);
    if (!hdr.ok || !hdr.result) return { status: "inconclusive", reason: "couldn't read the block header from your node" };
    if (hdr.result.merkleroot === att.merkleRoot)
      return { status: "verified", height: att.height, blockhash: bh.result, blockTime: hdr.result.time, merkleRoot: att.merkleRoot };
    return { status: "mismatch", reason: "merkle root does not match block " + att.height, height: att.height };
  }
}

module.exports = { parseProof, verifyAgainstNode };
