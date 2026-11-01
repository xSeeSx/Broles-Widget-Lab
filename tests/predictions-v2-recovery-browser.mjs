import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { normalizePrediction, presentationFor } from "../src/predictions/state.mjs";

await mkdir("test-results/recovery", { recursive: true });
const browser = await chromium.launch();
const contexts = [], errors = [], checks = [];
const base = new URL(process.env.LAB_BASE_URL || "http://127.0.0.1:4173/");
base.searchParams.set("widget", "prediccion-v2");
base.searchParams.set("build", process.env.GITHUB_SHA || "recovery-review");
const fixtureUrl = base.href;
const frame = page => page.frameLocator("#widgetFrame");
const root = page => frame(page).locator(".prediction-overlay");
const waitFor = async (fn, label, ms = 6000) => {
  const until = Date.now() + ms;
  while (!await fn()) { if (Date.now() > until) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 25)); }
  console.log("PASS recovery " + label);
};
async function pageForTest() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); contexts.push(context);
  await context.addInitScript(() => {
    window.__RECOVERY_SHOWS__ = 0;
    new MutationObserver(records => {
      records.forEach((record, index) => {
        if (!record.target.classList?.contains("prediction-overlay")) return;
        // Reassigning hidden=true also produces a mutation. Reconstruct each
        // intermediate value, so only actual removals count as an appearance.
        const following = records.slice(index + 1).find(next => next.target === record.target);
        const after = following ? following.oldValue : record.target.getAttribute("hidden");
        if (record.oldValue !== null && after === null) window.__RECOVERY_SHOWS__++;
      });
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message)); return page;
}
async function holdSync(page) {
  await frame(page).locator("body").evaluate(() => {
    window.__RECOVERY_HELD__ = [];
    window.__RECOVERY_SHOWS__ = 0;
    const send = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function(value) {
      const message = JSON.parse(value);
      if (message.type === "bridge.sync") { window.__RECOVERY_HELD__.push({ socket: this, message }); return; }
      return send.call(this, value);
    };
  });
}
async function reply(page, value) {
  return frame(page).locator("body").evaluate((_body, value) => {
    const held = window.__RECOVERY_HELD__.at(-1);
    if (!held) throw new Error("No current sync request was observed");
    held.socket.receive({ ...value, request_id: held.message.request_id });
  }, value);
}
const cache = page => frame(page).locator("body").evaluate(() => window.SE_API.store.get("brolesPredictions133649243v2"));
const empty = page => root(page).evaluate(node => node.hidden && node.querySelector(".prediction-title-text").textContent === "" && node.querySelectorAll(".prediction-child").length === 0);

try {
  // A first WebSocket packet may have waited in the source's queue for a minute.
  const first = await pageForTest();
  const now = Date.now();
  const prediction = normalizePrediction({ id: "queued-before-reload", broadcaster_id: "133649243", title: "No debe resucitar",
    status: "RESOLVED", created_at: new Date(now - 120000).toISOString(), ended_at: new Date(now - 60000).toISOString(),
    prediction_window: 30, winning_outcome_id: "one", outcomes: [{ id: "one", title: "Uno", users: 1, channel_points: 100 }, { id: "two", title: "Dos", users: 0, channel_points: 0 }] }, { broadcasterId: "133649243" });
  const stale = { type: "bridge.state", protocol_version: 2, broadcaster_id: "133649243", epoch: "old-queue", revision: 10,
    server_now: new Date(now - 59000).toISOString(), sync: { status: "ready" }, prediction, presentation: presentationFor(prediction) };
  const harness = await readFile("src/harness/worker-mock.js", "utf8");
  const original = 'if (bridgeV2) socket.receive({ ...clone(bridgeV2), server_now: new Date().toISOString() });';
  const originalSend = 'sendToLab("WORKER_V2_SYNC_REQUEST", { connectionId: this.id, requestId: request.request_id });';
  assert(harness.includes(original), "The replay injection must change the actual first packet");
  assert(harness.includes(originalSend), "The first sync reply must actually be held");
  const queuedHarness = harness.replace(originalSend, 'window.__RECOVERY_FIRST_SYNC__ = { connectionId: this.id, requestId: request.request_id };')
    .replace(original, `setTimeout(() => {
      socket.receive(${JSON.stringify(stale)});
      setTimeout(() => sendToLab("WORKER_V2_SYNC_REQUEST", window.__RECOVERY_FIRST_SYNC__), 100);
    }, 2100);`);
  await first.route("**/src/harness/worker-mock.js", route => route.fulfill({ contentType: "text/javascript", body: queuedHarness }));
  await first.goto(fixtureUrl, { waitUntil: "networkidle" });
  await waitFor(async () => (await cache(first))?.schemaVersion === 2, "fresh empty state follows the queued old result");
  assert(await empty(first));
  assert.equal(await frame(first).locator("body").evaluate(() => window.__RECOVERY_SHOWS__), 0, "No temporary trophy or title was shown before verification");
  await first.screenshot({ path: "test-results/recovery/queued-first-result-hidden.png" });
  checks.push("first queued old ready packet never removes hidden");

  // Return to an active local copy even though the actual end was missed.
  const returning = await pageForTest(); await returning.goto(fixtureUrl, { waitUntil: "networkidle" });
  await returning.locator("#predictionBeginNormalButton").click();
  await waitFor(async () => await root(returning).isVisible(), "active state exists before the scene switch");
  const oldActive = (await cache(returning)).snapshot;
  await holdSync(returning);
  await frame(returning).locator("body").evaluate(() => {
    window.dispatchEvent(new CustomEvent("obsSourceVisibleChanged", { detail: { visible: false } }));
    window.dispatchEvent(new CustomEvent("obsSourceVisibleChanged", { detail: { visible: true } }));
    window.dispatchEvent(new CustomEvent("obsSourceActiveChanged", { detail: { active: true } }));
  });
  assert(await empty(returning), "Returning hides the unverified old local copy synchronously");
  assert.equal(await frame(returning).locator("body").evaluate(() => window.__RECOVERY_HELD__.length), 1, "Duplicate lifecycle events share a sync request");
  await frame(returning).locator("body").evaluate((_body, value) => window.__LAB_WORKER_MOCK__.broadcast(value), oldActive);
  assert(await empty(returning), "An uncorrelated packet cannot release the wake barrier");
  const expiredPrediction = { ...oldActive.prediction, status: "resolved", winning_outcome_id: oldActive.prediction.outcomes[0].id,
    ended_at: new Date(Date.parse(oldActive.prediction.created_at) + 1000).toISOString() };
  const expired = { ...oldActive, revision: oldActive.revision + 10,
    server_now: new Date(Date.parse(expiredPrediction.ended_at) + 30000).toISOString(), prediction: expiredPrediction, presentation: presentationFor(expiredPrediction) };
  await reply(returning, expired); assert(await empty(returning));
  assert.equal(await frame(returning).locator("body").evaluate(() => window.__RECOVERY_SHOWS__), 0);
  await returning.screenshot({ path: "test-results/recovery/missed-end-on-return-hidden.png" });
  checks.push("returning after a missed end stays hidden until fresh verification");

  // A live result is valid for only the remainder of its original lifetime.
  const recent = await pageForTest(); await recent.goto(fixtureUrl, { waitUntil: "networkidle" });
  await recent.locator("#predictionBeginNormalButton").click();
  await recent.locator("#predictionWinningOutcome").selectOption("outcome-1");
  await recent.locator("#predictionResolveWinnerButton").click();
  await waitFor(async () => await root(recent).getAttribute("data-phase") === "resolved", "real result starts");
  const saved = (await cache(recent)).snapshot;
  const deadline = Number(await root(recent).getAttribute("data-hide-at"));
  await holdSync(recent);
  await frame(recent).locator("body").evaluate(() => window.dispatchEvent(new CustomEvent("obsSourceVisibleChanged", { detail: { visible: true } })));
  assert(await empty(recent));
  await reply(recent, { ...saved, server_now: new Date().toISOString() });
  await waitFor(async () => await root(recent).isVisible(), "a recent verified result resumes");
  assert.equal(Number(await root(recent).getAttribute("data-hide-at")), deadline);
  await waitFor(async () => await empty(recent), "the original result deadline still clears the source", Math.max(0, deadline - Date.now()) + 2000);
  checks.push("recent result resumes without a renewed deadline");

  // Deterministic clock discontinuity, not a claim to emulate CEF or GPU sleep.
  const sleeping = await pageForTest(); await sleeping.goto(fixtureUrl, { waitUntil: "networkidle" });
  await sleeping.locator("#predictionBeginNormalButton").click();
  await sleeping.locator("#predictionWinningOutcome").selectOption("outcome-1");
  await sleeping.locator("#predictionResolveWinnerButton").click();
  await waitFor(async () => await root(sleeping).getAttribute("data-phase") === "resolved", "result exists before the clock pause");
  const beforeSleep = (await cache(sleeping)).snapshot;
  await holdSync(sleeping);
  await frame(sleeping).locator("body").evaluate(() => {
    const realNow = Date.now.bind(Date), frozen = performance.now();
    Date.now = () => realNow() + 60000;
    Object.defineProperty(performance, "now", { value: () => frozen });
    window.dispatchEvent(new Event("resize"));
  });
  assert(await empty(sleeping), "A stopped monotonic clock cannot keep the result visible");
  await reply(sleeping, { ...beforeSleep, server_now: new Date(Date.now() + 60000).toISOString() });
  assert(await empty(sleeping));
  await sleeping.screenshot({ path: "test-results/recovery/paused-clock-hidden.png" });
  checks.push("paused clock requires fresh time and cannot strand trophies");
  assert.deepEqual(errors, []);
  await writeFile("test-results/recovery/report.json", JSON.stringify({ status: "passed", checks, errors }, null, 2));
  console.log("Recovery browser regressions passed.");
} catch (error) {
  await writeFile("test-results/recovery/failure.txt", error.stack + "\n" + JSON.stringify(errors)); throw error;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
