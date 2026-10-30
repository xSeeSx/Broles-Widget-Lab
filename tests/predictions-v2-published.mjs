import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("test-results/published", { recursive: true });
const base = new URL(process.env.LAB_BASE_URL || "http://127.0.0.1:4173/");
base.searchParams.set("widget", "prediccion-v2");
base.searchParams.set("build", process.env.GITHUB_SHA || "local-parity");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const a = () => page.frameLocator('iframe[data-overlay-id="A"]');
const b = () => page.frameLocator('iframe[data-overlay-id="B"]');
const root = () => a().locator(".prediction-overlay");
const check = async (fn, label, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (!await fn()) { if (Date.now() > until) throw new Error(label); await page.waitForTimeout(40); }
  console.log("PASS published " + label);
};
const field = (index, name) => page.locator('#predictionOutcomes input[data-outcome-index="' + index + '"][data-outcome-field="' + name + '"]');
const percentages = () => a().locator(".progress-bar-percent-text").allTextContents();
try {
  await page.goto(base.href, { waitUntil: "networkidle" });
  // A successful Pages deployment is insufficient if the browser serves an older entry module.
  assert((await page.locator('script[type="module"]').getAttribute("src")).includes("visual-parity-2.0.1"), "The published HTML must request the corrected entry module");
  await check(async () => await page.locator("#workerConnectionCount").textContent() === "1", "mock socket ready");
  assert.equal(await page.locator("#predictionWinningOutcome").inputValue(), "");
  assert(await page.locator("#predictionResolveWinnerButton").isDisabled());
  assert((await page.locator("#logList").textContent()).includes('"version": "2.0.1"'), "The loaded widget manifest must identify the corrected release");
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => await root().isVisible(), "prediction starts");
  assert.deepEqual(await percentages(), ["50%", "50%"]);
  assert.deepEqual((await a().locator(".progress-bar-users-text").allTextContents()).map(value => value.trim()), ["0", "0"]);
  const fonts = await a().locator("body").evaluate(() => {
    const faces = [...document.fonts];
    return faces.some(face => face.family.includes("Manrope") && face.status === "loaded") &&
      faces.some(face => face.family.includes("Font Awesome 6 Free") && face.status === "loaded");
  });
  assert(fonts, "The published widget loads its original fonts before becoming visible");
  for (const [index, users, points] of [[0, 25, 10000], [1, 75, 30000]]) {
    await field(index, "users").fill(String(users));
    await field(index, "channelPoints").fill(String(points));
  }
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => JSON.stringify(await percentages()) === '["25%","75%"]', "manual votes apply");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "test-results/published/active.png" });
  await page.locator("#predictionWinningOutcome").selectOption("outcome-2");
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => await root().getAttribute("data-phase") === "resolved", "direct result starts");
  const deadline = Number(await root().getAttribute("data-hide-at"));
  await check(async () => a().locator(".prediction-children").evaluate(container => {
    const winner = container.querySelector('[data-outcome-id="outcome-2"]');
    return winner && Math.abs(winner.getBoundingClientRect().width - container.clientWidth) < .1;
  }), "selected option fully expands", 8000);
  await page.screenshot({ path: "test-results/published/winner.png" });
  await check(async () => await root().evaluate(node => node.hidden && node.querySelector(".prediction-title-text").textContent === "" && node.querySelectorAll(".prediction-child").length === 0), "result cleans up", 6500);
  assert.equal(Number(await root().getAttribute("data-hide-at")), deadline, "Expiry remains absolute");
  const panel = page.locator('[data-panel-title="Overlay / OBS scenarios"] > .panel-toggle');
  if (await panel.getAttribute("aria-expanded") === "false") await panel.click();
  await page.locator("#overlayResultSceneButton").click();
  await check(async () => (await page.locator("#logList").textContent()).includes("Result scene scenario complete."), "scene-switch scenario completes", 25000);
  assert(await page.locator('.iframe-viewport[data-overlay-id="B"]').isVisible(), "The destination source is actually shown");
  assert(await b().locator(".prediction-overlay").evaluate(node => node.hidden && node.querySelector(".prediction-title-text").textContent === "" && node.querySelectorAll(".prediction-child").length === 0), "The destination source has no stuck title or trophies");
  await page.screenshot({ path: "test-results/published/scene-switch-cleared.png" });
  assert.deepEqual(errors, []);
  await writeFile("test-results/published/report.json", JSON.stringify({ status: "passed", url: page.url(), commit: process.env.GITHUB_SHA || null,
    version: "2.0.1", checks: ["versioned entry module", "original fonts loaded before display", "initial percentages and metrics", "manual 25/75 votes", "direct result and selected winner", "absolute cleanup", "scene switch after missed result"], errors }, null, 2));
  console.log("Published prediction smoke checks passed.");
} catch (error) {
  await page.screenshot({ path: "test-results/published/failure.png" }).catch(() => {});
  await writeFile("test-results/published/failure.txt", error.stack + "\n" + JSON.stringify(errors));
  throw error;
} finally { await context.close(); await browser.close(); }
