// Tests for the CDN-derived download count — run: node --test cron/*.test.js  (no network, no Cloudflare)
//
// The number this produces is shown to strangers as social proof, so the property that matters most is that
// it can never be talked UP by how the job happens to run: re-running it, running it across the cutover, or
// reading the same hour a hundred and forty-four times must all land on the same figure.

import test from "node:test";
import assert from "node:assert";
import { foldDownloads, publicTotals } from "./tally.js";
import { run } from "./worker.js";
import { onRequestGet, onRequestPost } from "../site/functions/api/downloads.js";

const row = (hour, path, count) => ({ count, dimensions: { datetimeHour: hour + ":00:00Z", clientRequestPath: path } });
const NOW = Date.parse("2026-09-19T14:25:00Z");

test("the cutover is the next full hour, and it is fixed by the first run", () => {
  const first = foldDownloads(null, [], NOW);
  assert.equal(first.since, "2026-09-19T15");
  const later = foldDownloads(first, [], NOW + 5 * 3600e3);
  assert.equal(later.since, "2026-09-19T15", "a later run must not move the line the legacy count was frozen at");
});

test("hours before the cutover belong to the button counter and are not counted again", () => {
  const s = foldDownloads(null, [row("2026-09-19T13", "/notzero-mac.dmg", 9), row("2026-09-19T14", "/notzero-mac.dmg", 4)], NOW);
  assert.deepEqual(s.hours, {}, "including the half-finished hour the first run lands in");
});

test("an hour is assigned, never added — re-reading it cannot inflate the count", () => {
  const rows = [row("2026-09-19T15", "/notzero-mac.dmg", 3), row("2026-09-19T15", "/notzero-win.exe", 2)];
  let s = foldDownloads(null, [], NOW);
  for (let i = 0; i < 144; i++) s = foldDownloads(s, rows, NOW + 2 * 3600e3);
  assert.deepEqual(s.hours, { "2026-09-19T15": { mac: 3, win: 2, linux: 0 } });
});

test("the current hour grows as it fills, and a platform absent from a later read keeps what it had", () => {
  let s = foldDownloads(null, [], NOW);
  s = foldDownloads(s, [row("2026-09-19T15", "/notzero-mac.dmg", 1), row("2026-09-19T15", "/notzero-linux.AppImage", 1)], NOW + 3600e3);
  s = foldDownloads(s, [row("2026-09-19T15", "/notzero-mac.dmg", 5)], NOW + 3700e3);
  assert.deepEqual(s.hours["2026-09-19T15"], { mac: 5, win: 0, linux: 1 });
});

test("hours that have aged out of the 24h window stay counted", () => {
  let s = foldDownloads(null, [], NOW);
  s = foldDownloads(s, [row("2026-09-19T15", "/notzero-mac.dmg", 7)], NOW + 3600e3);
  s = foldDownloads(s, [row("2026-09-21T09", "/notzero-mac.dmg", 2)], NOW + 48 * 3600e3);
  assert.equal(Object.keys(s.hours).length, 2);
});

test("only the landing page's installers count — an auto-update's versioned file is not a new download", () => {
  const s = foldDownloads({ since: "2026-09-19T15", hours: {} },
    [row("2026-09-19T16", "/notzero-0.1.92-mac-universal.zip", 400), row("2026-09-19T16", "/CHANGELOG.md", 9000)], NOW);
  assert.deepEqual(s.hours, {});
});

test("folding does not mutate the state it was given", () => {
  const before = { since: "2026-09-19T15", hours: { "2026-09-19T15": { mac: 1, win: 0, linux: 0 } } };
  const copy = JSON.parse(JSON.stringify(before));
  foldDownloads(before, [row("2026-09-19T15", "/notzero-mac.dmg", 8)], NOW);
  assert.deepEqual(before, copy);
});

test("the public total is the frozen button count plus everything the CDN has counted since", () => {
  const legacy = { count: 120, mac: 70, win: 40, linux: 6, days: { "2026-09-19": { mac: 2, win: 1, linux: 0, other: 1 } } };   // 4 of the 120 were "other"
  const state = { since: "2026-09-19T15", hours: { "2026-09-19T15": { mac: 3, win: 2, linux: 0 }, "2026-09-20T01": { mac: 0, win: 0, linux: 1 } } };
  const t = publicTotals(legacy, state);
  assert.equal(t.count, 126);
  assert.deepEqual([t.mac, t.win, t.linux], [73, 42, 7]);
  assert.deepEqual(t.days["2026-09-19"], { mac: 5, win: 3, linux: 0, other: 1 }, "the cutover day holds both halves");
  assert.deepEqual(t.days["2026-09-20"], { mac: 0, win: 0, linux: 1, other: 0 });
  assert.equal(t.source, "cdn");
});

// ---- the Worker around it, against an in-memory KV and a stubbed analytics API ----
function fakeKv(init = {}) {
  const m = new Map(Object.entries(init)); let puts = 0;
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { puts++; m.set(k, v); }, puts: () => puts, raw: m };
}
function stubAnalytics(t, rows, status = 200) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(JSON.parse(init.body).query);
    return new Response(JSON.stringify({ data: { viewer: { zones: [{ dl: rows }] } } }), { status });
  });
  return calls;
}
const env = (kv) => ({ STATS: kv, CF_ANALYTICS_TOKEN: "t", CF_ZONE_ID: "z" });

test("a run asks only for complete GETs of the three installers", async (t) => {
  const calls = stubAnalytics(t, []);
  await run(env(fakeKv()), NOW);
  assert.match(calls[0], /clientRequestHTTPMethodName: "GET"/);
  assert.match(calls[0], /edgeResponseStatus: 200/);
  assert.match(calls[0], /clientRequestPath_in: \["\/notzero-mac\.dmg","\/notzero-win\.exe","\/notzero-linux\.AppImage"\]/);
});

test("the first run publishes the legacy total unchanged, which is what retires the button", async (t) => {
  stubAnalytics(t, [row("2026-09-19T14", "/notzero-mac.dmg", 50)]);
  const kv = fakeKv({ downloads: "120", "downloads:mac": "70", "downloads:win": "40", "downloads:linux": "6" });
  const pub = await run(env(kv), NOW);
  assert.equal(pub.count, 120);
  assert.ok(kv.raw.has("dl:public"));
});

test("a run where nothing moved writes nothing", async (t) => {
  stubAnalytics(t, [row("2026-09-19T15", "/notzero-mac.dmg", 3)]);
  const kv = fakeKv({ downloads: "10" });
  await run(env(kv), NOW);                       // fixes the cutover
  await run(env(kv), NOW + 3600e3);              // counts the hour
  const after = kv.puts();
  assert.equal((await run(env(kv), NOW + 3700e3)).count, 13);
  assert.equal(kv.puts(), after);
});

test("an analytics outage leaves the last good figures in place", async (t) => {
  const kv = fakeKv({ "dl:public": '{"count":99}', "dl:byhour": '{"since":"2026-09-19T15","hours":{}}' });
  stubAnalytics(t, [], 522);
  await assert.rejects(run(env(kv), NOW), /HTTP 522/);
  assert.equal(kv.puts(), 0);
  assert.equal(kv.raw.get("dl:public"), '{"count":99}');
});

// ---- the contract with the landing page: the Worker writes dl:public, site/functions/api/downloads.js serves it ----
const site = (kv, method, qs = "") => {
  const ctx = { env: { STATS: kv }, request: new Request("https://getnotzero.com/api/downloads" + qs, { method }) };
  return method === "POST" ? onRequestPost(ctx) : onRequestGet(ctx);
};

test("until the Worker has run, the landing page is still the button counter", async () => {
  const kv = fakeKv({ downloads: "10", "downloads:mac": "10" });
  assert.equal((await (await site(kv, "POST", "?os=mac")).json()).count, 11);
  assert.deepEqual(await (await site(kv, "GET")).json(), { count: 11, mac: 11, win: 0, linux: 0 });
});

test("once it has, the page serves the tally and a click writes nothing", async (t) => {
  stubAnalytics(t, [row("2026-09-19T15", "/notzero-win.exe", 5)]);
  const kv = fakeKv({ downloads: "10", "downloads:mac": "10" });
  await run(env(kv), NOW);
  await run(env(kv), NOW + 3600e3);
  const puts = kv.puts();
  assert.equal((await site(kv, "POST", "?os=mac")).status, 204);
  assert.equal(kv.puts(), puts, "the legacy keys are frozen — the Worker reads them as the pre-cutover total");
  const got = await (await site(kv, "GET")).json();
  assert.deepEqual([got.count, got.mac, got.win], [15, 10, 5]);
  assert.equal(got.days, undefined, "the cheap form stays cheap");
  assert.deepEqual((await (await site(kv, "GET", "?daily=1")).json()).days, { "2026-09-19": { mac: 0, win: 5, linux: 0, other: 0 } });
});

test("a Worker deployed without its bindings says so instead of publishing zeros", async () => {
  await assert.rejects(run({ STATS: fakeKv() }, NOW), /see cron\/README\.md/);
});
