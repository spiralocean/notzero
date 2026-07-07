// Tests for ots-verify.js — run: node --test desktop/ots-verify.test.js  (no network, no live node)
//
// Fixture: a real, complete OpenTimestamps proof from the OTS project (examples/hello-world.txt.ots), anchored in
// Bitcoin block 358391 whose real merkle root is 8a1b66ec…e47e00. We verify the parser reconstructs that root and
// that the node-check returns the right verdict against mock RPC responses.

const test = require("node:test");
const assert = require("node:assert");
const { parseProof, verifyAgainstNode } = require("./ots-verify.js");

const PROOF = Buffer.from(
  "AE9wZW5UaW1lc3RhbXBzAABQcm9vZgC/ieLohOiSlAEIA7ogTlDRJuRnTABeBNguhMITZngK8fQ71Uo3gWtqs0AD8cgBAQAAAAHkgvnTLsw7ple2nYmAEIV7VEV6kEl5gv9W+XxOxY5vmAEAAABrSDBFAiEAslOt0dHPkIRDOKR1oE/xP8nnvSQrB3Yt6gf1YIst42cCIACyaMqcM0KzdpzdBiiRMXzc74eqwxC2hV6dk4mOu+jsASECDY5NEH0rM5sAUO/dS0oJJFqgVgSPElOWN06moqsHCcb/////AmUz5gUAAAAAGXapFAvwV9QPu6Z0SGJRX1tVojEN5XcviKyghgEAAAAAABl2qRTwBoisAAAAAAgI8SCph/cWxTORPDFMeONdNYhMrJQ/pCysSdKyxp9AA/hfiAgI8SDexVs0h+Hj9yKkm1WneDIVhieF9KOss5KEYBn3HcZKnQgI8SCyyhj0heCAR44CXas9RktBbA4ey2Ypya786MghTQQkMggI8CARsOkGYRlv9LCBPD7aFBurXpFgSDe996DJ3zfbDjoRmAgI8CDDS8GkoQk//RSMAWseZkdCkU6Tnvq+TT01ZRWRSybZ4ggI8CDD5ufDjGn2ryTCvjTrrEglft5h7AohuVNeREMne+MGRggI8SAHmL+GBuAAJOXV1UvwyWD2Kd+52taRV0VbbyZSwOjegQgI8CA/mtptYLqiRABrsKrVFEitL6+51LZIegmZz/JrkfD1NggI8SDHAwGelZqN0/rvdIm7MoukhVdHWOcJHwFGTrZYcsl1yAgI8CDL/v/1E/+EuRXj/tb515lnZjD4Nk6ipsdVf62UpbXXiAgI8SAL4jcJhZkTur1EYLvd+O0hPnyHc6Sx+s4w+Kz98JO3BQgIAAWIlg1z1xkBA/fvFQ==",
  "base64"
);
const FILE_DIGEST = "03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340";
const REAL_ROOT = "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00";
const BLOCK_HASH = "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319";

test("parses the file digest and the Bitcoin attestation", () => {
  const p = parseProof(PROOF);
  assert.equal(p.fileDigest, FILE_DIGEST);
  assert.equal(p.bitcoin.length, 1);
  assert.equal(p.bitcoin[0].height, 358391);
  assert.equal(p.bitcoin[0].merkleRoot, REAL_ROOT, "reconstructs block 358391's real merkle root");
});

const nodeReturning = (merkleroot) => async (m, params) => {
  if (m === "getblockhash") return params[0] === 358391 ? { ok: true, result: BLOCK_HASH } : { ok: false };
  if (m === "getblockheader") return { ok: true, result: { merkleroot, time: 1432827678 } };
  return { ok: false };
};

test("verified when the node's block matches the proof", async () => {
  const v = await verifyAgainstNode(PROOF, FILE_DIGEST, nodeReturning(REAL_ROOT));
  assert.equal(v.status, "verified");
  assert.equal(v.height, 358391);
  assert.equal(v.blockhash, BLOCK_HASH);
});

test("mismatch when the node's merkle root differs (tampering / wrong block)", async () => {
  const v = await verifyAgainstNode(PROOF, FILE_DIGEST, nodeReturning("00".repeat(32)));
  assert.equal(v.status, "mismatch");
});

test("mismatch when the proof is for a different file", async () => {
  const v = await verifyAgainstNode(PROOF, "ff".repeat(32), nodeReturning(REAL_ROOT));
  assert.equal(v.status, "mismatch");
});

test("inconclusive (not blocking) when the node lacks the block", async () => {
  const v = await verifyAgainstNode(PROOF, FILE_DIGEST, async () => ({ ok: false, error: "behind" }));
  assert.equal(v.status, "inconclusive");
});

test("inconclusive on unreadable proof (caller falls back, never blocks)", async () => {
  const v = await verifyAgainstNode(Buffer.from("not a proof"), null, nodeReturning(REAL_ROOT));
  assert.equal(v.status, "inconclusive");
});
