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

RPC_PORT = 18449
P2P_PORT = 18450                       # node A's p2p port
RPC_PORT_B = 18452                     # a second node, used to prove the direct P2P fallback works
P2P_PORT_B = 18453                       # off the regtest default so a real regtest node isn't disturbed
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
        f"rpcport={RPC_PORT}\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\nport={P2P_PORT}\nlisten=1\nbind=127.0.0.1\n")
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
        # Set it on OUR environment too, BEFORE importing lottery_miner: the module resolves APP_SUPPORT,
        # STATE_FILE, CONFIG and LOG_FILE at import time, so patching lm.APP_SUPPORT afterwards leaves
        # LOG_FILE pointing at the default. On macOS that path happens to exist and this passed; on Linux CI
        # it does not, and rescue's first log_daemon() call died with FileNotFoundError.
        os.environ["LOTTERY_DATA_DIR"] = str(appdir)

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

        # --- 2b. the coinbase pays OUR script ---------------------------------------------------------------
        # Compared as SCRIPT bytes, not as an address string: this node is regtest, so Core renders the very
        # same script with a bcrt1 prefix and a string comparison would always fail. Whether that script is the
        # right one for a given address is settled offline against Core's mainnet validateaddress, in
        # tests/test_payout_script.py — a regtest node cannot answer it, since this code is mainnet-only.
        say(won["coinbase"]["vout"][0]["scriptPubKey"]["hex"] == our_script,
            "the coinbase pays exactly the script our payout address derives to")

        # --- 2c. THE BLOCK SURVIVES, AND THE RESCUE PATH TERMINATES ----------------------------------------
        # A won block is written to disk BEFORE submitting, so an RPC blip at the one moment that matters can
        # never lose it, and a resubmit loop resumes on the next start. None of that had ever been exercised.
        # The dangerous failure isn't only "never lands" — it's also "retries forever", because a resolved
        # block is only stopped by being renamed off .hex.
        print()
        saved = sorted(appdir.glob("won_block_*"))
        say(bool(saved), f"the block was persisted to disk ({', '.join(f.name for f in saved) or 'nothing'})")
        if saved:
            hexf = saved[0]
            block_hex = hexf.read_text().strip()
            say(lm._block_hash_from_hex(block_hex) == our_hash, "the saved hex is exactly the block that won")
            say(rpc("submitblock", [block_hex]) == "duplicate",
                "re-submitting the saved hex returns 'duplicate' — a complete, valid block, not a fragment")

            # Simulate a crash between finding and resolving: put it back as pending and let rescue run.
            pending = appdir / f"won_block_{h}.hex"
            hexf.rename(pending)
            lm.log_daemon._quiet = True
            lm.rescue_pending_won_blocks(f"http://127.0.0.1:{RPC_PORT}", "t", "t", "", p2p_enabled=False)
            for _ in range(40):                # the resubmit runs on its own thread
                if not pending.exists():
                    break
                time.sleep(0.5)
            resolved = [f.name for f in appdir.glob(f"won_block_{h}.*")]
            say(not pending.exists(),
                f"rescue resolved the pending block and stopped retrying ({', '.join(resolved) or 'still pending'})")
            say(any(n.endswith((".duplicate", ".accepted")) for n in resolved),
                "and recorded the outcome on disk rather than deleting the evidence")

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

        # --- 5. the DIRECT P2P FALLBACK -------------------------------------------------------------------
        # When your own node's submitblock is failing, the block still has to reach the network — the miner
        # pushes it peer-to-peer itself. That path had never been run. Proven here against a second node that
        # is DISCONNECTED, so the only way it can learn of the block is our own broadcast.
        print()
        ddb = work / "nodeB"; ddb.mkdir(parents=True)
        (ddb / "bitcoin.conf").write_text(
            "regtest=1\nserver=1\n[regtest]\nrpcuser=t\nrpcpassword=t\n"
            f"rpcport={RPC_PORT_B}\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\nport={P2P_PORT_B}\nlisten=1\nbind=127.0.0.1\n")
        nodeB = subprocess.Popen([bitcoind, f"-datadir={ddb}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            def rpcB(method, params=None):
                url = f"http://127.0.0.1:{RPC_PORT_B}"
                pl = json.dumps({"jsonrpc": "1.0", "id": "t", "method": method, "params": params or []}).encode()
                rq = urllib.request.Request(url, data=pl, headers={"Content-Type": "application/json",
                                                                   "Authorization": "Basic " + base64.b64encode(b"t:t").decode()})
                with urllib.request.urlopen(rq, timeout=30) as r:
                    body = json.loads(r.read().decode())
                if body.get("error"):
                    raise RuntimeError(body["error"])
                return body["result"]

            for _ in range(60):
                try:
                    rpcB("getblockchaininfo"); break
                except Exception:
                    time.sleep(0.5)

            rpcB("addnode", [f"127.0.0.1:{P2P_PORT}", "onetry"])   # sync B up to A, then cut the link
            target = rpc("getblockcount")
            for _ in range(60):
                if rpcB("getblockcount") >= target: break
                time.sleep(0.5)
            say(rpcB("getblockcount") == target, f"second node synced to height {target}")
            try: rpcB("disconnectnode", [f"127.0.0.1:{P2P_PORT}"])
            except Exception: pass
            for _ in range(20):
                if not rpcB("getpeerinfo"): break
                time.sleep(0.5)
            say(not rpcB("getpeerinfo"), "…then disconnected — it can only learn of a new block from us")

            # Win a block whose PARENT is B's tip. The nonce is deterministic per height, so retrying the
            # same height needs a different --seed; generating filler blocks instead (as the main loop does)
            # would advance A past the disconnected B and the block would arrive as prev-blk-not-found.
            tipT = rpc("getblockcount")
            newwon = None
            for i in range(1, 41):
                rr = subprocess.run([sys.executable, str(REPO / "lottery_miner.py"), "--once", "--mode", "live",
                                     "--seed", f"p2p-test-{i}"], env=env, capture_output=True, text=True, timeout=180)
                if rpc("getblockcount") > tipT:
                    bh2 = rpc("getblockhash", [tipT + 1])
                    if rpc("getblock", [bh2, 2])["tx"][0]["vout"][0]["scriptPubKey"]["hex"] == our_script:
                        newwon = bh2; break
            say(bool(newwon), f"mined a second block at {tipT + 1}, directly on the second node's tip")
            if newwon:
                say(rpcB("getblockcount") < rpc("getblockcount"), "the second node does NOT have it yet (link is cut)")
                block_hex2 = rpc("getblock", [newwon, 0])
                import p2p_broadcast as p2p
                p2p.MAGIC = b"\xfa\xbf\xb5\xda"   # regtest message-start; mainnet bytes wouldn't be understood
                sent = p2p.broadcast_block(block_hex2, log=None, max_peers=1, timeout=8,
                                           extra_peers=[("127.0.0.1", P2P_PORT_B)])
                say(sent >= 1, f"broadcast_block delivered to {sent} peer(s) over raw P2P")
                landed = False
                for _ in range(30):
                    try:
                        rpcB("getblockheader", [newwon]); landed = True; break
                    except Exception:
                        time.sleep(0.5)
                say(landed, "the second node accepted the block — delivered with no RPC, no relay, just P2P")
                if not landed:
                    log = (ddb / "regtest" / "debug.log")
                    if log.exists():
                        print("      node B's own log, last lines mentioning the peer/block:")
                        keep = [l for l in log.read_text(errors="replace").splitlines()
                                if any(k in l.lower() for k in ("block", "peer", "invalid", "reject", "misbehav", "connect"))][-12:]
                        for l in keep: print("       ", l[:150])
        finally:
            try: rpcB("stop"); nodeB.wait(timeout=30)
            except Exception: nodeB.kill()

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
