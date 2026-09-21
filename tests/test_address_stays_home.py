#!/usr/bin/env python3
"""The payout address never leaves the machine.

getnotzero.com/verify invites people to point an AI at this repo and ask: "Does this ever send my payout
address, or anything else about me, off my machine?" For a long time the honest answer was "there is code that
would": fetch_wallet_balance() looked the address up at mempool.space/api/address/<addr> — handing a third party
the address together with the IP address mining to it. It sat behind a config flag the desktop app never set,
so it never ran there, but "never runs" and "cannot run" are different answers. It was deleted 2026-09-21.

The only place a payout address belongs is the coinbase of a block this machine builds for its own node. This
test keeps it that way, at the source level: no file that talks to an outside API may build an address lookup.
The dashboard, the bridge and the desktop shell are checked too — the rule is the project's, not one file's.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["lottery_miner.py", "scripts/node_bridge.py", "web/app.js", "desktop/main.js"]
# address lookups as the public explorers spell them (mempool.space / esplora / blockstream / blockchain.info)
LOOKUP = re.compile(r"/(address|addr|scripthash|rawaddr|balance)/", re.I)

fails = []
for rel in FILES:
    src = (ROOT / rel).read_text(encoding="utf-8")
    hits = [f"{rel}:{n}: {line.strip()[:110]}" for n, line in enumerate(src.splitlines(), 1) if LOOKUP.search(line)]
    print(f"  {'✗' if hits else '✓'} {rel}: {'no address lookups' if not hits else ''}")
    for h in hits:
        print("      " + h)
    fails += hits

import importlib  # noqa: E402
sys.path.insert(0, str(ROOT))
m = importlib.import_module("lottery_miner")
for name in ("fetch_wallet_balance", "update_wallet_balance_state"):
    gone = not hasattr(m, name)
    print(f"  {'✓' if gone else '✗'} lottery_miner.{name} is gone")
    if not gone:
        fails.append(name)

if fails:
    print(f"\n{len(fails)} problem(s): something looks an address up at an outside service.")
    sys.exit(1)
print("\nthe payout address stays on this machine.")
