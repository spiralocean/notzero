// electron-builder afterSign hook — notarize the signed .app with Apple, then
// staple the ticket so Gatekeeper passes offline on other Macs.
//
// Build-safe: if no Apple credentials are present in the environment, this logs
// a skip and returns, so `npm run dist` still succeeds (the app is signed with
// your Developer ID, just not notarized). Provide EITHER:
//   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//   (app-specific password from appleid.apple.com), OR
//   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER  (App Store Connect API key)
const { notarize } = require("@electron/notarize");
const { execFileSync } = require("node:child_process");

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const byPassword = APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID;
  const byApiKey = APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER;
  if (!byPassword && !byApiKey) {
    console.log("  • notarization: SKIPPED — no Apple credentials in env. Set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (or APPLE_API_KEY + _ID + _ISSUER) to notarize.");
    return;
  }

  console.log(`  • notarizing ${appName}.app with Apple (notarytool)…`);
  await notarize(byApiKey
    ? { tool: "notarytool", appPath, appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER }
    : { tool: "notarytool", appPath, appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID });

  console.log("  • stapling notarization ticket…");
  try { execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" }); }
  catch (e) { console.log("  • staple warning:", e.message); }
  console.log("  • notarization complete");
};
