"use strict";
// Which cookie file do the saved settings point at?
//
// Saving settings writes the cookie's RESOLVED PATH into config.rpc_cookie, and rpc_datadir only when the user
// typed a datadir. An app-managed node never has one typed: its cookie lives under the app's own data folder,
// and rpc_cookie is the only record of where. nodeRpcFromConfig used to treat rpc_cookie as a mere flag and
// re-derive the path from rpc_datadir — blank for a managed node — which fell through to Bitcoin Core's DEFAULT
// folder, where a managed node's cookie never is. So for every managed install (the default setup) the update
// checks had no node: nothing was ever confirmed against "your own node", and a still-pending timestamp was
// never noticed, so the hold in update-hold.js could not fire. Found by testing that hold for real.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
//   exists(path) → bool            fromDatadir(datadir) → a cookie path, or ""  (main.js's resolveCookiePath)
function cookiePathFromConfig(cfg, { exists, fromDatadir }) {
  if (!cfg || !cfg.rpc_cookie) return ""; // not using cookie auth
  if (typeof cfg.rpc_cookie === "string" && exists(cfg.rpc_cookie)) return cfg.rpc_cookie; // the path we saved
  return fromDatadir(cfg.rpc_datadir || ""); // an older config's bare flag, or a cookie that has since moved
}

module.exports = { cookiePathFromConfig };
