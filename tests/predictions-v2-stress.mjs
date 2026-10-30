import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("test-results", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const frame = (id) => page.frameLocator(`iframe[data-overlay-id="${id}"]`);
const root = (id) => frame(id).locator(".prediction-overlay");
const key = "brolesPredictions133649243v2";
const counters = { cycles: 0, snapshotsReplayed: 0, staleWrites: 0, reconnects: 0, destroyedSources: 0, socketCuts: 0 };
const check = async (action, label, ms = 12000) => {
  const until = Date.now() + ms;
  while (!await action()) { if (Date.now() > until) throw new Error(label); await new Promise((r) => setTimeout(r, 40)); }
};
const open = async (title) => {
  const button = page.locator(`[data-panel-title="${title}"] > .panel-toggle`);
  if (await button.getAttribute("aria-expanded") === "false") await button.click();
};
const state = (id) => root(id).evaluate((node) => ({ id: node.dataset.predictionId, phase: node.dataset.phase,
  revision: node.dataset.revision, deadline: node.dataset.hideAt, hidden: node.hidden, text: node.innerText }));
const cache = (id) => frame(id).locator("body").evaluate((_node, name) => window.SE_API.store.get(name), key);
const broadcast = (id, snapshots) => frame(id).locator("body").evaluate((_node, values) => {
  let delivered = 0;
  for (const value of values) delivered += window.__LAB_WORKER_MOCK__.broadcast(value, { recordPrediction: false });
  if (delivered !== values.length) throw new Error("Fault injection must reach exactly one open socket per packet");
}, snapshots);
try {
  await page.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
  await check(async () => await page.locator("#workerConnectionCount").textContent() === "1", "first socket");
  await open("Overlay / OBS scenarios");
  await page.locator("#overlayDuplicateButton").click();
  await check(async () => await page.locator("#workerConnectionCount").textContent() === "2", "second socket");
  const previous = [];
  for (let round = 0; round < 32; round++) {
    const options = [2, 3, 5, 10][round % 4];
    await page.locator(`[data-prediction-count="${options}"]`).click();
    await page.locator("#predictionTitle").fill("Prueba intensiva " + (round + 1));
    await page.locator("#predictionBeginNormalButton").click();
    await check(async () => {
      const [a, b] = await Promise.all([state("A"), state("B")]);
      return !a.hidden && !b.hidden && a.phase === "active" && b.phase === "active" && a.id === b.id && a.text.includes("Prueba intensiva " + (round + 1));
    }, "both overlays enter cycle " + round);
    const active = await state("B");
    assert(!previous.some((item) => item.prediction?.id === active.id), "Every prediction has a new ID");
    const pattern = options === 10 ? "ten-uneven" : ["zero", "all-option-1", "close-percentages", "tiny-huge"][round % 4];
    await page.locator("#predictionVotePattern").selectOption(pattern);
    await page.locator("#predictionApplyVotePatternButton").click();
    await page.locator("#predictionNormalProgressButton").click();
    await check(async () => !(await frame("B").locator(".progress-bar-percent-text").allTextContents()).includes("…"), "votes supplied");
    assert.equal(await frame("A").locator(".prediction-child").count(), options);
    assert.equal(await frame("B").locator(".prediction-child").count(), options);
    assert(!/NaN|Infinity/.test((await state("B")).text));
    if (previous.length) {
      // Reorder many old states after a newer prediction is already on screen.
      const old = previous.slice(-6).reverse();
      await broadcast("A", old);
      await broadcast("B", old);
      counters.snapshotsReplayed += old.length * 2;
      const stale = { schemaVersion: 2, snapshot: old[0] };
      await frame("A").locator("body").evaluate((_node, { key, value }) => window.SE_API.store.set(key, value), { key, value: stale });
      counters.staleWrites++;
      const after = await state("B");
      assert.equal(after.id, active.id); assert.equal(after.phase, "active");
      assert(!after.text.includes("🏆"), "Old result must never replace the next active prediction");
    }
    if (round % 2 === 0) {
      await page.locator("#predictionLockButton").click();
      await check(async () => (await state("B")).phase === "locked", "lock");
    }
    if (round % 8 === 3) {
      await page.locator("#overlayRefreshButton").click();
      await check(async () => (await state("B")).id === active.id && !(await state("B")).hidden, "reload restores current ID");
      counters.reconnects++;
    }
    if (round % 8 === 5) {
      await page.locator("#overlayHiddenDeliveryMode").selectOption("destroy");
      await page.locator("#overlayHideButton").click();
      assert.equal(await page.locator('iframe[data-overlay-id="B"]').count(), 0);
      await page.locator("#overlayShowButton").click();
      await check(async () => (await state("B")).id === active.id, "destroy/show restores current prediction");
      await page.locator("#overlayHiddenDeliveryMode").selectOption("deliver");
      counters.destroyedSources++;
    }
    const canceled = round % 3 === 0;
    if (!canceled) await page.locator("#predictionWinningOutcome").selectOption("outcome-" + (round % options + 1));
    await page.locator(canceled ? "#predictionEndCanceledButton" : "#predictionResolveWinnerButton").click();
    await check(async () => (await state("A")).phase === (canceled ? "canceled" : "resolved") && (await state("B")).phase === (canceled ? "canceled" : "resolved"), "end reaches both overlays");
    if (canceled) assert(!(await state("B")).text.includes("🏆"));
    const saved = await cache("B");
    assert(saved?.snapshot?.prediction?.id === active.id, "Store must eventually contain this transition");
    previous.push(saved.snapshot);
    counters.cycles++;
    console.log(`PASS stress cycle ${round + 1}: ${options} options, ${canceled ? "canceled" : "resolved"}`);
  }

  // A sustained burst of duplicate packets must not extend the result lifetime.
  const last = previous.at(-1);
  const deadline = (await state("B")).deadline;
  const duplicates = Array.from({ length: 600 }, () => last);
  await broadcast("A", duplicates);
  await broadcast("B", duplicates);
  counters.snapshotsReplayed += 1200;
  assert.equal((await state("B")).deadline, deadline);
  // Now leave a new prediction open while every old result's timer expires.
  await page.locator("[data-prediction-count='2']").click();
  await page.locator("#predictionTitle").fill("La predicción nueva debe seguir visible");
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => (await state("B")).phase === "active", "new prediction starts after packet burst");
  const survivor = await state("B");
  // Repeated actual socket closures, including duplicate close attempts, must recover once.
  for (let cut = 0; cut < 6; cut++) {
    const before = {};
    for (const id of ["A", "B"]) {
      before[id] = await frame(id).locator("body").evaluate(() => window.__LAB_WORKER_MOCK__.connections[0]);
      await frame(id).locator("body").evaluate(() => {
        window.__LAB_WORKER_MOCK__.closeAll("stress network cut");
        window.__LAB_WORKER_MOCK__.closeAll("stress duplicate close");
      });
      counters.socketCuts++;
    }
    for (const id of ["A", "B"]) {
      await check(async () => frame(id).locator("body").evaluate((_node, old) => {
        const list = window.__LAB_WORKER_MOCK__.connections;
        return list.length === 1 && list[0] !== old;
      }, before[id]), "one replacement connection per overlay");
      assert.equal((await state(id)).id, survivor.id);
      assert.equal((await state(id)).phase, "active");
    }
  }
  await check(async () => await page.locator("#workerConnectionCount").textContent() === "2", "no leaked parent connections");
  console.log("PASS stress twelve socket cuts recover without duplicate connections");
  await new Promise((resolve) => setTimeout(resolve, 11000));
  for (const id of ["A", "B"]) {
    const actual = await state(id);
    assert.equal(actual.id, survivor.id); assert.equal(actual.phase, "active"); assert.equal(actual.hidden, false);
    assert(!actual.text.includes("🏆"));
  }
  console.log("PASS stress old expiry callbacks cannot hide the next prediction");
  await page.screenshot({ path: "test-results/v2-stress-active-survives.png" });

  // Reconnect several times during a result and verify one immutable deadline.
  await page.locator("#predictionWinningOutcome").selectOption("outcome-1");
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => (await state("B")).phase === "resolved", "final result");
  const finalDeadline = (await state("B")).deadline;
  for (let i = 0; i < 4; i++) {
    await page.locator("#overlayRefreshButton").click();
    await check(async () => (await state("B")).phase === "resolved", "result reconstructs on repeated reconnect");
    assert.equal((await state("B")).deadline, finalDeadline);
    counters.reconnects++;
  }
  await check(async () => (await state("A")).hidden && (await state("B")).hidden, "final result expires in both overlays", 12000);
  await broadcast("B", previous.slice().reverse());
  assert.equal((await state("B")).hidden, true, "Old results cannot resurrect an expired result");
  assert.equal(await frame("B").locator(".prediction-title-text").textContent(), "");
  assert.equal(await frame("B").locator(".prediction-child").count(), 0, "No old bars accumulate across cycles");
  await page.screenshot({ path: "test-results/v2-stress-final-cleared.png" });

  // SE store can fail completely while the live widget must still operate.
  const brokenStore = await browser.newContext();
  const brokenPage = await brokenStore.newPage();
  brokenPage.on("pageerror", (error) => errors.push(error.message));
  const seSource = await readFile("src/harness/se-mock.js", "utf8");
  await brokenPage.route("**/src/harness/se-mock.js", (route) => route.fulfill({ contentType: "text/javascript", body: seSource + `
    window.SE_API.store.get = () => Promise.reject(new Error("injected_read_failure"));
    window.SE_API.store.set = () => { throw new Error("injected_write_failure"); };
  ` }));
  await brokenPage.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
  await brokenPage.locator("#predictionBeginNormalButton").click();
  const brokenFrame = brokenPage.frameLocator("#widgetFrame");
  await check(async () => await brokenFrame.locator(".prediction-overlay").isVisible(), "live state works when all store operations fail");
  await brokenPage.locator("#predictionWinningOutcome").selectOption("outcome-2");
  await brokenPage.locator("#predictionResolveWinnerButton").click();
  await check(async () => await brokenFrame.locator(".prediction-overlay").getAttribute("data-phase") === "resolved", "result works without storage");
  await check(async () => !await brokenFrame.locator(".prediction-overlay").isVisible(), "result cleanup works without storage", 12000);
  await brokenStore.close();

  assert.deepEqual(errors, [], "No uncaught browser errors during stress");
  await writeFile("test-results/v2-stress-report.json", JSON.stringify({ status: "passed", ...counters,
    checks: ["new prediction survives all earlier deadlines", "out-of-order snapshots", "stale shared writes", "repeated reconnects", "destroy/recreate", "duplicate packet burst", "store read/write failures"], errors }, null, 2));
  console.log("Prediction v2 stress passed: " + JSON.stringify(counters));
} catch (error) {
  await page.screenshot({ path: "test-results/v2-stress-failure.png" }).catch(() => {});
  await writeFile("test-results/v2-stress-failure.txt", String(error.stack) + "\n" + JSON.stringify({ counters, errors }) + "\n" + await page.locator("#logList").textContent());
  throw error;
} finally { await browser.close(); }
