"use strict";
// What to do with an update that has finished downloading: install it, hold it, or refuse it.
//
// Releases are normally not published until their OpenTimestamps proof has confirmed in a Bitcoin block, so an
// update usually arrives already on-chain and installs straight away. The exception is a hotfix pushed early:
// its download matches the published checksums, but the proof is still PENDING (a calendar commitment, hours
// from a block). That one is HELD — the dashboard says so and offers "install now" — and it installs by itself
// the moment the proof confirms. Waiting is the default because most installs are unattended; a question that
// needs a click would leave a tray app on the old version forever.
//
// A third case is neither held nor refused: the release's SIGNED checksum list couldn't be fetched, or doesn't
// name this file ("unsigned"). Promotion guarantees a signed list exists before a release goes live
// (scripts/promote-release.sh), so this is a network blip or someone withholding it — either way the answer is
// the same: don't install, don't alarm, look again at the next check. It deliberately has NO ceiling and no
// "install now": an update that installs unsigned after waiting long enough is an update that needs no signature.
//
// Only a genuinely pending PROOF holds an update. "Couldn't check" (no node, node behind, checksums not
// published yet) installs exactly as it always has: the updater is how a broken node gets fixed, so it must
// never depend on a working one. "pending" is read from the proof file itself, not from the node.
//
// The hold has a ceiling. Proofs confirm because OUR scheduled job upgrades and republishes them; if that job
// breaks, a fleet of unattended machines would sit on a hotfix until someone noticed. Past HOLD_LIMIT_MS the
// update installs on its checksum match, which is what every update did before there was a hold at all.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
const HOLD_LIMIT_MS = 24 * 60 * 60 * 1000;

// verdict: what verifyUpdateArtifact returned ({ level, version }) — null when it couldn't run
// verifyOn: the verify_updates setting — off means never block and never hold
// installNowVer: the version the user chose "Install Now" for, if any
// heldSince: ms timestamp this version was first held (0/undefined if it never was)
function decideInstall({ verdict, verifyOn, installNowVer, heldSince, now = Date.now() }) {
  const level = verdict && verdict.level, version = verdict && verdict.version;
  if (!verifyOn) return "install";
  if (level === "mismatch") return "block"; // never overridable — "install now" skips the timestamp, not the fingerprint
  if (level === "unsigned") return "defer"; // no signed checksum list to check it against (yet) — see above
  if (level !== "pending") return "install";
  if (installNowVer && installNowVer === version) return "install";
  if (heldSince && now - heldSince >= HOLD_LIMIT_MS) return "install";
  return "hold";
}

module.exports = { decideInstall, HOLD_LIMIT_MS };
