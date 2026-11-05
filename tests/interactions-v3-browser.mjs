import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("test-results/interactions", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
const frame = () => page.frameLocator('iframe[data-overlay-id="A"]');
const root = () => frame().locator(".prediction-overlay");
const wait = async (fn, label, timeout = 6000) => {
  const deadline = Date.now() + timeout;
  while (!await fn()) { if (Date.now() > deadline) throw new Error(label); await page.waitForTimeout(30); }
  checks.push(label); console.log("PASS interactions " + label);
};
const panel = async name => {
  const button = page.locator(`[data-panel-title="${name}"] > .panel-toggle`);
  if (await button.getAttribute("aria-expanded") === "false") await button.click();
};
try {
  await page.goto("http://127.0.0.1:4173/?widget=interacciones-v3", { waitUntil: "networkidle" });
  await wait(async () => await page.locator("#workerConnectionCount").textContent() === "1", "v3 socket opens");
  await page.locator("#pollChoiceCount").selectOption("3");
  await page.locator("#pollDuration").fill("15");
  await page.locator("#pollBegin").click();
  await page.locator("#pollVotes0").fill("20"); await page.locator("#pollVotes1").fill("20");
  await page.locator("#pollSendVotes").click();
  await wait(async () => await root().getAttribute("data-kind") === "poll" && await frame().locator(".prediction-child").count() === 3, "poll options render");
  assert.equal(await frame().locator(".progress-bar-multiplier:visible").count(), 0);
  assert.equal(await frame().locator(".progress-bar-users").first().getAttribute("title"), "Votos");
  await wait(async () => (await frame().locator(".progress-bar-users-text").first().textContent()).trim() === "20", "submitted total votes arrive");
  await wait(async () => frame().locator(".prediction-child").evaluateAll(nodes => nodes.every(node => Number(getComputedStyle(node).opacity) >= .999)), "poll entrance completes before measuring geometry");
  assert.equal(await frame().locator(".vote-check").count(), 3);
  const heading = await root().evaluate(node => {
    const center = selector => {
      const range = document.createRange();
      range.selectNodeContents(node.querySelector(selector));
      const rect = range.getBoundingClientRect();
      return rect.left + rect.width / 2;
    };
    document.documentElement.style.background = "white";
    return { offset: center(".prediction-time-text") - center(".prediction-title-text"), glow: getComputedStyle(node.parentElement).filter,
      width: node.clientWidth, bodyWidth: document.body.clientWidth };
  });
  assert(Math.abs(heading.offset) < 2, "Timer and question share a center");
  assert(heading.glow.includes("drop-shadow"), "The widget has one shared contrast halo");
  assert.equal(heading.width, heading.bodyWidth, "The shared halo does not shrink the bars");
  const metricGeometry = await frame().locator(".prediction-child").first().evaluate(node => {
    const metric = node.querySelector(".progress-bar-users").getBoundingClientRect();
    const bar = node.querySelector(".progress-bar").getBoundingClientRect();
    const name = node.querySelector(".progress-bar-text").getBoundingClientRect();
    return { metricBottom: metric.bottom, barTop: bar.top, nameTop: name.top };
  });
  assert(metricGeometry.metricBottom <= metricGeometry.barTop + 2, "Vote counter stays above its bar");
  assert(metricGeometry.metricBottom < metricGeometry.nameTop, "Vote counter cannot overlap option name");
  await page.screenshot({ path: "test-results/interactions/poll-active.png" });
  await wait(async () => await root().getAttribute("data-phase") === "resolved", "poll automatically resolves at deadline without a lock phase", 17000);
  const deadline = await root().getAttribute("data-hide-at");
  await wait(async () => await frame().locator(".is-winner").count() === 2, "tied winners both expand", 6000);
  await page.waitForTimeout(1100);
  const widths = await frame().locator(".prediction-children").evaluate(container => {
    const winners = [...container.querySelectorAll(".is-winner")].map(node => node.getBoundingClientRect());
    return { parent: container.clientWidth, widths: winners.map(rect => rect.width), distance: winners[1].left - winners[0].left };
  });
  assert(Math.abs(widths.widths[0] - (widths.parent + 10) / 2) < 2);
  assert(Math.abs(widths.distance - (widths.widths[0] - 10)) < 2);
  await page.screenshot({ path: "test-results/interactions/poll-tie.png" });
  await panel("Overlay / OBS scenarios");
  await page.locator("#overlayRefreshButton").click();
  await wait(async () => await root().getAttribute("data-hide-at") === deadline && await root().isVisible(), "reload preserves final poll deadline");
  await wait(async () => !await root().isVisible(), "final poll disappears at original deadline", 7000);

  await page.locator("#pollDuration").fill("120"); await page.locator("#pollBegin").click();
  await wait(async () => await root().getAttribute("data-kind") === "poll", "second poll is visible before preemption");
  await root().evaluate(node => {
    const stage = node.parentElement;
    window.handoffs = [];
    new MutationObserver(() => {
      if (stage.classList.contains("is-switching")) window.handoffs.push("out:" + node.dataset.kind);
      if (node.classList.contains("interaction-enter")) window.handoffs.push("in:" + node.dataset.kind);
    }).observe(stage, { attributes: true, subtree: true, attributeFilter: ["class", "data-kind"] });
  });
  await page.locator("#predictionBeginNormalButton").click();
  await wait(async () => await root().getAttribute("data-kind") === "prediction", "prediction preempts running poll");
  await wait(async () => await frame().locator(".progress-bar-multiplier:visible").count() > 0, "prediction keeps its multipliers after entrance");
  await page.locator("#predictionLockButton").click();
  await wait(async () => await root().getAttribute("data-phase") === "locked", "prediction lock remains visible first");
  await wait(async () => await root().getAttribute("data-kind") === "poll", "hidden prediction yields to poll", 18000);
  const remaining = await frame().locator(".prediction-time-text").textContent();
  assert.notEqual(remaining, "02:00", "Suppression cannot restart the poll countdown");
  await page.locator("#predictionWinningOutcome").selectOption("outcome-1");
  await page.locator("#predictionResolveWinnerButton").click();
  await wait(async () => await root().getAttribute("data-kind") === "prediction" && await root().getAttribute("data-phase") === "resolved", "prediction final preempts poll again");
  await wait(async () => await root().getAttribute("data-kind") === "poll", "poll returns after prediction final expires", 13000);
  const handoffs = await root().evaluate(() => window.handoffs);
  assert(handoffs.includes("out:poll"), "Poll fades out before prediction replaces it");
  assert(handoffs.includes("in:poll"), "Poll fades in after prediction finishes its exit");
  await page.locator("#pollVotes0").fill("30"); await page.locator("#pollVotes1").fill("10"); await page.locator("#pollSendVotes").click();
  await page.locator("#pollEnd").click();
  await wait(async () => await frame().locator(".is-winner").count() === 1, "single poll winner uses final animation", 6000);
  assert.match(await frame().locator(".prediction-title-text").textContent(), /^🏆 .+ 🏆$/u);
  await page.waitForTimeout(1100);
  const winner = await frame().locator(".is-winner").evaluate(node => ({ width: node.getBoundingClientRect().width, parent: node.parentElement.clientWidth,
    label: getComputedStyle(node.querySelector(".progress-bar-text")).transform }));
  assert(Math.abs(winner.width - winner.parent) < 2); assert.notEqual(winner.label, "none");
  await page.screenshot({ path: "test-results/interactions/poll-winner.png" });

  const bundle = await readFile("widgets/interacciones-v3/widget.js", "utf8");
  assert(!/^import /m.test(bundle)); assert(!bundle.includes("__LAB_"), "Copyable JS contains no lab dependency");
  assert.deepEqual(errors, []);
  await writeFile("test-results/interactions/report.json", JSON.stringify({ checks, errors, widths, winner }, null, 2));
} catch (error) {
  await page.screenshot({ path: "test-results/interactions/failure.png" }).catch(() => {});
  await writeFile("test-results/interactions/failure.json", JSON.stringify({ error: error.stack, errors, checks }, null, 2));
  throw error;
} finally { await browser.close(); }
