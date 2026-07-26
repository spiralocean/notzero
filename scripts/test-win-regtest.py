#!/usr/bin/env python3
"""End-to-end test of the thing this app exists for: finding a block, and everything that happens after.

    python3 scripts/test-win-regtest.py

verify-block.py already proves the block the miner BUILDS would be accepted (getblocktemplate proposal mode).
Nothing tested what happens once it actually is: submitblock landing, the win being recorded, win_status
resolving pending -> confirmed, and the coinbase maturity countdown the dashboard now shows. That path runs
once in a user's lifetime, cannot be exercised in production, and a bug in it costs someone a block reward.

On regtest the proof-of-work target is ~2^255, so roughly half of all hashes win — the miner's one-hash-per-
block finds a block within a few attempts. Everything else (template construction, coinbase, merkle root,
serialization, submitblock, state.json, win_status) is the same code mainnet runs.

Exit 0 = the whole path works. Anything else prints what broke.
"""
import base64
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO))

RPC_PORT = 18449                       # off the regtest default so a real regtest node isn't disturbed
PAYOUT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"  # BIP-173 test vector; a coinbase may pay any script
FAIL = []


def say(ok, msg):
    print(f"  {'✓' if ok else '✗'} {msg}")
    if not ok:
        FAIL.append(msg)


def rpc(method, params=None, wallet=None):
    url = f"http://127.0.0.1:{RPC_PORT}" + (f"/wallet/{wallet}" if wallet else "")
    payload = json.dumps({"jsonrpc": "1.0", "id": "t", "method": method, "params": params or []}).encode()
    auth = "Basic " + base64.b64encode(b"t:t").decode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", "Authorization": auth})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:   # Core puts the useful message in the BODY of a 500
        raw = e.read().decode(errors="replace")
        try:
            body = json.loads(raw)
        except Exception:
            raise RuntimeError(f"HTTP {e.code} from {method}: {raw[:200]}") from None
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


def find_bitcoind():
    managed = pathlib.Path.home() / "Library/Application Support/bitcoin-lottery-desktop/node/core"
    if managed.is_dir():
        for c in sorted(managed.glob("bitcoin-*/bin/bitcoind"), reverse=True):
            return str(c)
    return shutil.which("bitcoind")


def main():
    bitcoind = find_bitcoind()
    if not bitcoind:
        print("no bitcoind found (looked in the managed node dir and $PATH)")
        return 2
    print(f"bitcoind: {bitcoind}\n")

    work = pathlib.Path(tempfile.mkdtemp(prefix="notzero-regtest-"))
    datadir, appdir = work / "node", work / "app"
    datadir.mkdir(parents=True), appdir.mkdir(parents=True)
    (datadir / "bitcoin.conf").write_text(
        "regtest=1\nserver=1\nfallbackfee=0.0001\n[regtest]\nrpcuser=t\nrpcpassword=t\n"
        f"rpcport={RPC_PORT}\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\nlisten=0\n")
    node = subprocess.Popen([bitcoind, f"-datadir={datadir}"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    try:
        for _ in range(60):                       # wait for RPC
            try:
                rpc("getblockchaininfo"); break
            except Exception:
                if node.poll() is not None:
                    print("bitcoind exited:", (node.stderr.read() or b"").decode()[-400:]); return 2
                time.sleep(0.5)
        else:
            print("bitcoind never became reachable"); return 2

        rpc("createwallet", ["t"])
        addr = rpc("getnewaddress", [], wallet="t")
        rpc("generatetoaddress", [110, addr])     # a chain deep enough for getblocktemplate
        print(f"regtest chain at height {rpc('getblockcount')}\n")

        cfg = {"version": 1, "mode": "live", "payout_address": PAYOUT, "coinbase_tag": "",
               "rpc_url": f"http://127.0.0.1:{RPC_PORT}", "rpc_user": "t", "rpc_pass": "t", "rpc_cookie": ""}
        (appdir / "config.json").write_text(json.dumps(cfg))
        env = {**os.environ, "LOTTERY_DATA_DIR": str(appdir)}

        # --- 1. mine until the one-hash-per-block ticket actually wins -------------------------------------
        # `--once` runs the real path (getblocktemplate -> coinbase -> merkle -> header hash -> check_win ->
        # submitblock) but does NOT record state; only the daemon does. So the win is confirmed the way that
        # actually matters: by asking the node whether a block carrying OUR coinbase script landed.
        import lottery_miner as lm
        our_script = lm.address_to_script_pubkey(PAYOUT).hex()
        print("mining (regtest target ≈ 2^255, so ~1 in 2 per hash)…")
        won = None
        for attempt in range(1, 41):
            before = rpc("getblockcount")
            r = subprocess.run([sys.executable, str(REPO / "lottery_miner.py"), "--once", "--mode", "live"],
                               env=env, capture_output=True, text=True, timeout=180)
            after = rpc("getblockcount")
            if after > before:
                bh = rpc("getblockhash", [after])
                cb = rpc("getblock", [bh, 2])["tx"][0]
                if cb["vout"][0]["scriptPubKey"]["hex"] == our_script:
                    won = {"height": after, "hash_hex": bh, "coinbase": cb, "out": (r.stdout or "") + (r.stderr or "")}
                    print(f"  won on attempt {attempt}: block {after}")
                    break
            if "high-hash" in ((r.stdout or "") + (r.stderr or "")):
                say(False, "submitblock rejected a block the miner thought it won (high-hash) — check_win disagrees with consensus")
                return 1
            rpc("generatetoaddress", [1, addr])   # move the tip so the next attempt gets a fresh template
        say(bool(won), "the miner found a block and the node accepted it")
        if not won:
            return 1
        say("WON and submitted" in won["out"], "the miner reported it as submitted")

        # --- 2. the block is really ours, in the real chain ------------------------------------------------
        h, our_hash = won["height"], won["hash_hex"]
        say(rpc("getblockhash", [h]) == our_hash, f"block {h} in the chain IS our hash")
        say(won["coinbase"]["vout"][0]["value"] > 0, f"its coinbase pays {won['coinbase']['vout'][0]['value']} BTC to our address")

        # --- 2b. THE PAYOUT ADDRESS ROUND-TRIP --------------------------------------------------------------
        # address_to_script_pubkey is hand-rolled bech32 + base58. If it derives the wrong script, you win a
        # block, the network accepts it, and the reward goes somewhere you don't control — silently, and only
        # ever discovered by winning. Comparing our derivation to itself proves nothing, so Core decodes it
        # back: give it OUR bytes and ask which address they pay. It must be the one we started from.
        print()
        for kind in ("bech32", "bech32m", "p2sh-segwit", "legacy"):
            try:
                a = rpc("getnewaddress", ["", kind], wallet="t")
            except Exception:
                print(f"  – {kind}: not offered by this Core build, skipped")
                continue
            try:
                ours = lm.address_to_script_pubkey(a).hex()
            except Exception as e:
                say(False, f"{kind}: our derivation raised {type(e).__name__} for {a}")
                continue
            back = rpc("decodescript", [ours])
            got = back.get("address") or (back.get("addresses") or [None])[0]
            say(got == a, f"{kind}: our script decodes back to the same address ({a[:18]}…)")
            if got != a:
                print(f"      ours -> {ours}")
                print(f"      Core reads that as {got}")
        # and the address the block actually paid, checked the same way
        paid = won["coinbase"]["vout"][0]["scriptPubKey"]
        say((paid.get("address") or "") == PAYOUT,
            f"the block's coinbase pays exactly the configured payout address ({PAYOUT[:18]}…)")

        # --- 3. win_status through settling, confirmation and maturity -------------------------------------
        import node_bridge as nb
        st = {"last_attempt": {"won": True, "mode": "live", "height": h, "hash_hex": our_hash}, "history": []}
        seen = lambda: nb.win_status(f"http://127.0.0.1:{RPC_PORT}", "t", "t", st, rpc("getblockcount"))

        ws = seen()
        say(ws and ws["status"] == "pending", f"right after submitting: status={ws and ws['status']} ({ws and ws['confirmations']} confs) — not yet safe")
        say(ws and ws["maturity_needs"] == 100, "it reports the 100-block maturity requirement")

        rpc("generatetoaddress", [nb.WIN_CONFIRMATIONS - 1, addr])
        ws = seen()
        say(ws and ws["status"] == "confirmed", f"at {ws and ws['confirmations']} confirmations: status={ws and ws['status']} — reorg-safe")
        say(ws and 0 < ws["matures_in"] < 100, f"but NOT yet spendable — {ws and ws['matures_in']} blocks to maturity")

        before = ws["confirmations"]
        rpc("generatetoaddress", [10, addr])
        ws = seen()
        say(ws and ws["confirmations"] == before + 10,
            f"confirmations keep counting after settling ({before} → {ws and ws['confirmations']}) — the maturity countdown needs this")

        rpc("generatetoaddress", [100, addr])
        ws = seen()
        say(ws and ws["matures_in"] == 0, f"past 100 confirmations: matures_in={ws and ws['matures_in']} — spendable")

        # --- 4. and the node agrees the coins are actually spendable now -----------------------------------
        say(rpc("gettxoutsetinfo")["height"] >= h + 100, "the chain is deep enough that the reward has matured")

    finally:
        try:
            rpc("stop"); node.wait(timeout=30)
        except Exception:
            node.kill()
        shutil.rmtree(work, ignore_errors=True)

    print()
    if FAIL:
        print(f"FAILED — {len(FAIL)} check(s):")
        for f in FAIL:
            print("  -", f)
        return 1
    print("ALL CHECKS PASSED — a found block is submitted, recorded, settles, and matures correctly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
