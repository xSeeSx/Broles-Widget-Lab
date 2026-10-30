import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { normalizePrediction, presentationFor, POLICY } from "../src/predictions/state.mjs";
await mkdir("test-results/parity", { recursive: true });
const browser = await chromium.launch();
const contexts = [];
const newTestPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); contexts.push(context);
  return context.newPage();
};
const errors = [], results = [];
const frame = (page) => page.frameLocator("#widgetFrame");
const root = (page) => frame(page).locator(".prediction-overlay");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = async (fn, label, timeout = 6000) => {
  const until = Date.now() + timeout;
  while (!await fn()) { if (Date.now() > until) throw new Error(label); await wait(25); }
};
const inspect = (page) => frame(page).locator(".prediction-overlay").evaluate((overlay) => {
  const container = overlay.querySelector(".prediction-children"), title = overlay.querySelector(".prediction-title-text");
  return { hidden: overlay.hidden, phase: overlay.dataset.phase, id: overlay.dataset.predictionId, deadline: Number(overlay.dataset.hideAt),
    title: title.textContent, width: container.clientWidth, clockOpacity: Number(getComputedStyle(overlay.querySelector(".prediction-time-text")).opacity),
    overlayAnimation: getComputedStyle(overlay).animationName, overlayOpacity: Number(getComputedStyle(overlay).opacity),
    barsAnimation: getComputedStyle(container).animationName, exitDelay: getComputedStyle(overlay).animationDelay,
    nodes: [...container.children].map((node) => ({ id: node.dataset.outcomeId, left: node.getBoundingClientRect().left - container.getBoundingClientRect().left,
      width: node.getBoundingClientRect().width, opacity: Number(getComputedStyle(node).opacity), animation: getComputedStyle(node).animationName,
      percent: node.querySelector(".progress-bar-percent-text").textContent, users: node.querySelector(".progress-bar-users-text").textContent.trim(),
      color: getComputedStyle(node.querySelector(".prediction-outcome")).backgroundColor,
      multiplier: node.querySelector(".multiplier-text").textContent,
      usersRight: node.querySelector(".progress-bar-users-text").getBoundingClientRect().right,
      multiplierLeft: node.querySelector(".progress-bar-multiplier").getBoundingClientRect().left })) };
});
const pages = [];
try {
  for (const count of [2, 3, 5, 10]) {
    const page = await newTestPage(); pages.push({ page, count });
    page.on("pageerror", (error) => errors.push(error.message));
  }
  await Promise.all(pages.map(async ({ page, count }) => {
    await page.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
    await check(async () => await page.locator("#workerConnectionCount").textContent() === "1", "socket ready");
    await page.locator(`[data-prediction-count="${count}"]`).click();
  }));
  for (const round of [0, 1, 2]) {
    await Promise.all(pages.map(async (test) => {
      const { page, count } = test;
      test.winner = [0, Math.floor(count / 2), count - 1][round];
      await page.locator("#predictionTitle").fill(`${count} opciones, gana ${test.winner + 1}`);
      await page.locator("#predictionBeginNormalButton").click();
      await check(async () => (await inspect(page)).phase === "active" && (await inspect(page)).nodes.length === count, "begin all options");
      assert.equal(await page.locator("#predictionWinningOutcome").inputValue(), "");
      const initial = await inspect(page);
      assert(initial.nodes.every((node) => node.percent === Math.round(100 / count) + "%" && node.users === "0" && node.multiplier === "x1.0"));
      for (let index = 0; index < count; index++) assert.equal(initial.nodes[index].color, ["rgb(255, 187, 0)", "rgb(15, 99, 255)", "rgb(255, 0, 0)"][index % 3]);
      await page.locator("#predictionVotePattern").selectOption(round === 1 ? "all-option-1" : "equal");
      await page.locator("#predictionApplyVotePatternButton").click();
      await page.locator("#predictionNormalProgressButton").click();
      await wait(2700); // Includes the last original staggered entrance with ten options.
      const active = await inspect(page);
      assert(active.nodes.every((node) => node.opacity > .999), "All staggered entrances finish");
      assert(active.nodes.every((node) => node.left >= -1 && node.left + node.width <= active.width + 1), "Bars fit after vote interpolation");
      if (round !== 0) {
        await page.locator("#predictionLockButton").click();
        await check(async () => (await inspect(page)).phase === "locked", "lock");
        await wait(350);
        const locked = await inspect(page);
        assert(locked.title.startsWith("🛑 ") && locked.title.endsWith(" 🛑"));
        assert(locked.clockOpacity < .01, "Original clock fade finishes in 0.3s");
      }
      await page.locator("#predictionWinningOutcome").selectOption("outcome-" + (test.winner + 1));
      await page.locator("#predictionResolveWinnerButton").click();
      await check(async () => (await inspect(page)).phase === "resolved", "resolve reaches every case");
      test.deadline = (await inspect(page)).deadline;
      test.baseWidth = (await inspect(page)).nodes[test.winner].width;
    }));
    await Promise.all(pages.map(async (test) => {
      const { page, count, winner } = test;
      await check(async () => {
        const state = await inspect(page);
        return state.nodes.some((node, index) => index !== winner && node.opacity > .02 && node.opacity < .98);
      }, `${count} options: losers have intermediate frames`, 5000);
      await check(async () => {
        const state = await inspect(page), node = state.nodes[winner];
        return node.width > test.baseWidth + 3 && node.width < state.width - 3;
      }, `${count} options: winner moves through intermediate widths`, 4000);
      if (round === 2) await page.screenshot({ path: `test-results/parity/${count}-winner-last-expanding.png` });
      await check(async () => {
        const state = await inspect(page), node = state.nodes[winner];
        return Math.abs(node.width - state.width) < .01 && Math.abs(node.left) < .01 && state.nodes.every((item, index) => index === winner || item.opacity < .001);
      }, `${count} options: selected winner fully expands`, 2500);
      // A source reloaded after expansion must resume that pose with the same deadline.
      if (count === 5) {
        const previousDocument = await frame(page).locator("body").evaluate(() => performance.timeOrigin);
        await page.locator("#reloadWidgetButton").click();
        await check(async () => {
          try { return await frame(page).locator("body").evaluate(() => performance.timeOrigin) !== previousDocument; }
          catch (error) { if (/context|detached/i.test(error.message)) return false; throw error; }
        }, "reload really creates a new source document");
        await check(async () => (await inspect(page)).nodes.length === count, "reloaded result reconstructs");
        await check(async () => {
          const state = await inspect(page); return state.phase === "resolved" && Math.abs(state.nodes[winner].width - state.width) < .01;
        }, "reloaded winner resumes at full width");
        assert.equal((await inspect(page)).deadline, test.deadline);
      }
      await check(async () => (await inspect(page)).overlayAnimation === "fadeOut", `${count} options: original overlay exit`, 5000);
      const exit = await inspect(page);
      assert.equal(exit.barsAnimation, "slideOut", "Original separate bar exit is preserved");
      await check(async () => (await inspect(page)).hidden, `${count} options: title and bars clean up`, 1800);
      const ended = await inspect(page);
      assert.equal(ended.title, ""); assert.equal(ended.nodes.length, 0);
      results.push({ count, winner: winner + 1, direct: round === 0, deadline: test.deadline, status: "passed" });
    }));
    console.log("PASS parity result matrix round " + (round + 1));
  }

  // Every supported option count also fits a deliberately extreme vote split.
  const page = pages[0].page;
  for (let count = 2; count <= 10; count++) {
    await page.locator(`[data-prediction-count="${count}"]`).click();
    await page.locator("#predictionBeginNormalButton").click();
    await check(async () => (await inspect(page)).phase === "active" && (await inspect(page)).nodes.length === count, "every supported count begins");
    await page.locator("#predictionVotePattern").selectOption("tiny-huge");
    await page.locator("#predictionApplyVotePatternButton").click();
    await page.locator("#predictionNormalProgressButton").click();
    await wait(2700);
    const state = await inspect(page);
    assert(state.nodes.every((node) => node.left >= -1 && node.left + node.width <= state.width + 1), `Extreme split fits ${count} options`);
    assert(state.nodes.every((node) => node.usersRight <= node.multiplierLeft + 1), `Metrics cannot overlap with large multipliers (${count} options)`);
    await page.screenshot({ path: `test-results/parity/${count}-extreme-split.png` });
    await page.locator("#predictionEndCanceledButton").click();
    await check(async () => (await inspect(page)).phase === "canceled", "cancel before next layout case");
  }
  await page.locator('[data-prediction-count="2"]').click();
  // Lock-only exit, followed by a real result after the widget has already hidden.
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => (await inspect(page)).phase === "active", "lock-only begin");
  await page.locator("#predictionLockButton").click();
  await check(async () => (await inspect(page)).phase === "locked", "lock-only state");
  await check(async () => (await inspect(page)).overlayAnimation === "fadeOut", "lock waits fifteen seconds before exit", 17000);
  assert.equal((await inspect(page)).barsAnimation, "slideOut");
  await check(async () => (await inspect(page)).hidden, "lock exit completes", 1500);
  await page.locator("#predictionWinningOutcome").selectOption("outcome-2");
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => !(await inspect(page)).hidden && (await inspect(page)).phase === "resolved", "late result returns after lock exit");
  await check(async () => (await inspect(page)).nodes[1].width > 959, "late result winner animates", 7500);
  await check(async () => (await inspect(page)).hidden, "late result still cleans up", 6000);
  console.log("PASS parity lock-only exit and result after hidden lock");

  // Controlled bridge inputs witness elapsed animation poses without replaying a whole sequence.
  await Promise.all([3800, 5800, 6800, 10750, 12000].map(async (age, index) => {
    const late = await newTestPage(); late.on("pageerror", (error) => errors.push(error.message));
    if (age === 6800) {
      const css = await readFile("widgets/prediccion-v2/widget.css", "utf8");
      await late.route("**/widgets/prediccion-v2/widget.css", (route) => route.fulfill({ contentType: "text/css", body: css + "\n* { animation: none !important; transition: none !important; }" }));
    }
    await late.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
    await check(async () => await late.locator("#workerConnectionCount").textContent() === "1", "late source ready");
    let initial;
    await check(async () => {
      initial = await frame(late).locator("body").evaluate(() => window.SE_API.store.get("brolesPredictions133649243v2"));
      return initial?.schemaVersion === 2 && initial.snapshot.prediction === null;
    }, "late source has consumed initial ready state");
    const now = Date.now();
    const prediction = normalizePrediction({ id: "late-pose-" + age, broadcaster_id: "133649243", title: "Resultado recuperado",
      status: "RESOLVED", created_at: new Date(now - 90000).toISOString(), ended_at: new Date(now - age).toISOString(), prediction_window: 60,
      winning_outcome_id: "two", outcomes: [{ id: "one", title: "Uno", users: 10, channel_points: 10000 }, { id: "two", title: "Dos", users: 10, channel_points: 10000 }] }, { broadcasterId: "133649243" });
    const snapshot = { type: "bridge.state", protocol_version: 2, broadcaster_id: "133649243", epoch: initial.snapshot.epoch, revision: 100,
      server_now: new Date(now).toISOString(), sync: { status: "ready" }, prediction, presentation: presentationFor(prediction) };
    const count = await frame(late).locator("body").evaluate((_node, value) => window.__LAB_WORKER_MOCK__.broadcast(value, { recordPrediction: false }), snapshot);
    assert.equal(count, 1, "The controlled snapshot must actually reach the socket");
    if (age === 3800) await check(async () => { const s = await inspect(late); return s.nodes.length === 2 && s.nodes[0].opacity > .01 && s.nodes[0].opacity < .99; }, "late loser resumes midway", 500);
    if (age === 5800) await check(async () => { const s = await inspect(late); return s.nodes.length === 2 && s.nodes[1].width > 490 && s.nodes[1].width < 950; }, "late winner resumes midway", 500);
    if (age === 6800) {
      await check(async () => { const s = await inspect(late); return s.nodes.length === 2 && s.nodes[1].width > 959 && s.nodes[0].opacity < .001; }, "static winner pose works without CSS motion");
      await check(async () => (await inspect(late)).hidden, "cleanup works without CSS motion or animation events", 6000);
    }
    if (age === 10750) {
      await check(async () => { const s = await inspect(late); return s.overlayAnimation === "fadeOut" && s.overlayOpacity < .99 && s.overlayOpacity > .01; }, "late exit resumes midway", 300);
      assert((await inspect(late)).exitDelay.startsWith("-"));
    }
    if (age === 12000) {
      await check(async () => frame(late).locator("body").evaluate(async () => (await window.SE_API.store.get("brolesPredictions133649243v2"))?.snapshot?.revision === 100), "expired snapshot is actually consumed");
      assert((await inspect(late)).hidden, "Expired snapshots cannot flash trophies");
    }
    await late.screenshot({ path: `test-results/parity/recovered-at-${age}.png` });
    await late.close();
  }));
  assert.deepEqual(errors, []);
  await writeFile("test-results/parity/report.json", JSON.stringify({ status: "passed", policy: POLICY, results, checks: ["original stagger and colors", "first/middle/last winners", "2/3/5/10 options", "direct and locked resolution", "original separate bar exit", "late result after lock exit", "reloaded expanded result", "elapsed loser/winner/exit poses"], errors }, null, 2));
  console.log("Original visual feature matrix passed.");
} catch (error) {
  await Promise.all(pages.map(({ page, count }) => page.screenshot({ path: `test-results/parity/failure-${count}.png` }).catch(() => {})));
  await writeFile("test-results/parity/failure.txt", error.stack + "\n" + JSON.stringify({ results, errors }));
  throw error;
} finally { await Promise.all(contexts.map((context) => context.close())); await browser.close(); }
