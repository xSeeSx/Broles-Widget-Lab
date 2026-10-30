import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { normalizePrediction, presentationFor } from "../src/predictions/state.mjs";
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const a = () => page.frameLocator('iframe[data-overlay-id="A"]');
const b = () => page.frameLocator('iframe[data-overlay-id="B"]');
const check = async (fn, label, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!await fn()) { if (Date.now() > deadline) throw new Error(label); await new Promise((r) => setTimeout(r, 50)); }
  console.log("PASS v2 " + label);
};
const panel = async (name) => {
  const toggle = page.locator('[data-panel-title="' + name + '"] > .panel-toggle');
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
};
const phase = (frame) => frame().locator(".prediction-overlay").getAttribute("data-phase");
const current = () => a().locator(".prediction-overlay").getAttribute("data-prediction-id");
try {
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.locator("#widgetSelect").selectOption("prediccion-v2");
  await check(async () => (await page.locator("#workerConnectionCount").textContent()) === "1", "socket opens");
  assert.equal(await a().locator(".prediction-overlay").isVisible(), false, "Idle starts fully hidden");
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => await a().locator(".prediction-overlay").isVisible(), "begin displays a prediction");
  assert.equal(await phase(a), "active");
  const firstId = await current();
  await page.locator("#predictionApplyVotePatternButton").click();
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => !(await a().locator(".progress-bar-percent-text").allTextContents()).includes("…"), "progress supplies actual totals");
  await panel("Overlay / OBS scenarios");
  await page.locator("#overlayDuplicateButton").click();
  await check(async () => await b().locator(".prediction-overlay").isVisible(), "new B recovers an active prediction without begin");
  assert.equal(await b().locator(".prediction-overlay").getAttribute("data-prediction-id"), firstId);
  await page.locator("#predictionLockButton").click();
  await check(async () => await phase(b) === "locked", "lock reaches B");
  const lockDeadline = await b().locator(".prediction-overlay").getAttribute("data-hide-at");
  await page.locator("#overlayRefreshButton").click();
  await check(async () => await phase(b) === "locked", "B reload reconstructs lock without begin");
  assert.equal(await b().locator(".prediction-overlay").getAttribute("data-hide-at"), lockDeadline, "Reload cannot restart the lock lifetime");
  await page.locator("#predictionEndCanceledButton").click();
  await check(async () => await phase(b) === "canceled", "cancel is reconstructed");
  assert(!(await b().locator(".prediction-title-text").textContent()).includes("🏆"), "Cancel never shows a winner trophy");

  // Full layout and event text are exercised with ten options and literal HTML-shaped titles.
  await page.locator("[data-prediction-count='10']").click();
  await page.locator("#predictionTitle").fill('<img src=x onerror="alert(1)">');
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => await phase(b) === "active", "next prediction replaces cancellation");
  await page.locator("#predictionVotePattern").selectOption("ten-uneven");
  await page.locator("#predictionApplyVotePatternButton").click();
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => await b().locator(".prediction-child").count() === 10, "all ten options render");
  assert.equal(await b().locator(".prediction-title-text img").count(), 0, "Twitch text is never interpreted as HTML");
  assert((await b().locator(".prediction-title-text").textContent()).includes("<img"));
  assert(!/NaN|Infinity/.test(await b().locator(".prediction-overlay").innerText()));
  // Wait for width interpolation before measuring the final fitted layout.
  await check(async () => b().locator(".prediction-children").evaluate((container) => {
    const p = container.getBoundingClientRect(); return [...container.children].every((n) => n.getBoundingClientRect().right <= p.right + 1);
  }), "ten-option layout fits the available width");
  await page.screenshot({ path: "test-results/v2-ten-options.png" });
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => await phase(b) === "resolved", "end works without receiving lock");
  const endedDeadline = await b().locator(".prediction-overlay").getAttribute("data-hide-at");
  await page.locator("#overlayRefreshButton").click();
  await check(async () => await phase(b) === "resolved", "result reload reconstructs without cloned bars");
  assert.equal(await b().locator(".prediction-overlay").getAttribute("data-hide-at"), endedDeadline);
  await panel("Worker WebSocket");
  await page.locator("#workerReplayCurrentButton").click();
  assert.equal(await b().locator(".prediction-overlay").getAttribute("data-hide-at"), endedDeadline, "Replay never extends result display");
  const stored = await b().locator("body").evaluate(async () => window.SE_API.store.get("brolesPredictions133649243v2"));
  assert.equal(stored.schemaVersion, 2); assert.equal(stored.snapshot.prediction.status, "resolved");
  // Inject an older shared-storage write while a server-confirmed result is current.
  const old = structuredClone(stored); old.snapshot.revision = 0; old.snapshot.prediction.title = "Obsoleto";
  await b().locator("body").evaluate((value) => window.SE_API.store.set("brolesPredictions133649243v2", value), old);
  await new Promise((r) => setTimeout(r, 100));
  assert(!(await b().locator(".prediction-title-text").textContent()).includes("Obsoleto"));
  await check(async () => !await b().locator(".prediction-overlay").isVisible(), "result deadline hides title and bars after replay/reload", 12000);
  assert.equal(await b().locator(".prediction-title-text").textContent(), "");
  assert.equal(await b().locator(".prediction-child").count(), 0);
  await b().locator("body").evaluate((value) => window.__LAB_WORKER_MOCK__.broadcast(value), stored.snapshot);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await b().locator(".prediction-overlay").isVisible(), false, "Replaying an old server timestamp cannot rewind the result clock");
  await page.locator("#overlayRefreshButton").click();
  await check(async () => (await page.locator("#workerConnectionCount").textContent()) === "2", "expired result reconnects");
  assert.equal(await b().locator(".prediction-overlay").isVisible(), false, "Expired server snapshot stays hidden");

  // The exact legacy failure scenario now has the opposite expected outcome.
  await page.locator("#predictionTitle").fill("Prueba de cambio de escena");
  await page.locator("[data-prediction-count='2']").click();
  await page.locator("#overlayShowButton").click();
  await page.locator("#overlayResultSceneButton").click();
  await check(async () => (await page.locator("#logList").textContent()).includes("Result scene scenario complete."), "disconnect-during-result scenario completes", 25000);
  assert.equal(await b().locator(".prediction-overlay").isVisible(), false, "Scene switch after result expiry cannot leave trophies stuck");
  assert.equal(await b().locator(".prediction-title-text").textContent(), "");
  await page.screenshot({ path: "test-results/v2-scene-switch-cleared.png" });

  // Starting from shared storage alone must not show an unverified recent result.
  const offline = await browser.newContext();
  const offlinePage = await offline.newPage();
  const now = Date.now();
  const cachedPrediction = normalizePrediction({ id: "cached", broadcaster_id: "133649243", title: "No debe aparecer", status: "RESOLVED",
    created_at: new Date(now - 60000).toISOString(), prediction_window: 30, ended_at: new Date(now - 1000).toISOString(), winning_outcome_id: "one",
    outcomes: [{ id: "one", title: "Sí", users: 1, channel_points: 100 }, { id: "two", title: "No", users: 0, channel_points: 0 }] }, { broadcasterId: "133649243" });
  const cachedSnapshot = { type: "bridge.state", protocol_version: 2, broadcaster_id: "133649243", epoch: "cache-only", revision: 100,
    server_now: new Date(now).toISOString(), sync: { status: "ready" }, prediction: cachedPrediction, presentation: presentationFor(cachedPrediction) };
  await offlinePage.addInitScript((value) => {
    try { localStorage.setItem("broles-widget-lab:se-store:v1:mock-channel-id:brolesPredictions133649243v2", JSON.stringify({ schemaVersion: 2, snapshot: value })); } catch {}
  }, cachedSnapshot);
  const harness = await readFile("src/harness/worker-mock.js", "utf8");
  await offlinePage.route("**/src/harness/worker-mock.js", (route) => route.fulfill({ contentType: "text/javascript", body: harness
    .replace('  function replayOnOpen(socket) {', '  function replayOnOpen(socket) { return;')
    .replace('sendToLab("WORKER_V2_SYNC_REQUEST",', 'void ("WORKER_V2_SYNC_REQUEST",') }));
  await offlinePage.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
  await new Promise((r) => setTimeout(r, 1200));
  const offlineFrame = offlinePage.frameLocator("#widgetFrame");
  assert.equal(await offlineFrame.locator(".prediction-overlay").isVisible(), false, "A recent cache cannot resurrect trophies without server confirmation");
  await offlinePage.screenshot({ path: "test-results/v2-cache-unverified-hidden.png" });
  await offline.close();
  assert.deepEqual(errors, [], "No unexpected widget/lab JS errors");
  console.log("Prediction v2 browser acceptance checks passed.");
} catch (error) {
  await page.screenshot({ path: "test-results/v2-failure.png" }).catch(() => {});
  await writeFile("test-results/v2-failure.txt", String(error.stack) + "\n" + JSON.stringify(errors) + "\n" + await page.locator("#logList").textContent());
  throw error;
} finally { await browser.close(); }
