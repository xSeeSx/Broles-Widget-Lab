import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

await mkdir("test-results", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const frameA = () => page.frameLocator('iframe[data-overlay-id="A"]');
const frameB = () => page.frameLocator('iframe[data-overlay-id="B"]');
const check = async (condition, label, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log("PASS " + label);
};
const openPanel = async (title) => {
  const section = page.locator('[data-panel-title="' + title + '"]');
  const button = section.locator(".panel-toggle");
  if (await button.count() && await button.getAttribute("aria-expanded") === "false") await button.click();
};
try {
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await check(async () => (await page.locator("#widgetSelect option").count()) >= 3, "Registry loads");
  await page.locator("#widgetSelect").selectOption("demo");
  await check(async () => (await frameA().locator("#demoMessage").textContent()) === "onWidgetLoad received", "Demo initializes automatically");
  await page.screenshot({ path: "test-results/demo.png", fullPage: true });

  await page.locator("#widgetSelect").selectOption("marco");
  await check(async () => (await frameA().locator("#widgetContainer video").count()) === 4, "Marco DOM loads");
  await page.screenshot({ path: "test-results/marco.png", fullPage: true });

  await page.locator("#widgetSelect").selectOption("prediccion");
  await check(async () => (await page.locator("#appStatus").textContent()).startsWith("Cargado:"), "Prediction document loaded");
  await openPanel("Prediction Lab");
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => (await frameA().locator("body").textContent()).includes("Quien gana"), "Production prediction receives begin over mocked Worker socket");
  await page.screenshot({ path: "test-results/prediccion.png", fullPage: true });

  await openPanel("Overlay / OBS scenarios");
  await page.locator("#overlayResultSceneButton").click();
  await check(async () => (await page.locator("#logList").textContent()).includes("Result scene scenario complete."),
    "Result scene-switch scenario completes", 25000);
  assert((await frameB().locator(".prediction-title-text").textContent()).includes("🏆"), "Legacy trophy title reproduced");
  assert(await frameB().locator(".prediction-overlay").isVisible(), "Legacy result remains visibly stuck");
  console.log("KNOWN LEGACY BUG reproduced: B retains visible trophies after result lifetime and socket interruption.");
  await page.screenshot({ path: "test-results/legacy-stuck-result.png", fullPage: true });

  // Exercise storage through an actual widget iframe and public SE_API.
  // No production widget source files are changed.
  const probeHTML = '<button id="save">Save result</button><output id="value">loading</output><output id="loadCount">0</output>';
  const probeJS = `
    let loads = 0;
    const value = document.querySelector("#value");
    const draw = (data) => { value.textContent = JSON.stringify(data ?? null); };
    window.addEventListener("onWidgetLoad", () => {
      document.querySelector("#loadCount").textContent = String(++loads);
      SE_API.store.get("phaseOneProbe").then(draw);
    });
    window.addEventListener("onEventReceived", (event) => {
      if (event.detail.listener === "kvstore:update" && event.detail.event.data.key === "customWidget.phaseOneProbe") draw(event.detail.event.data.value);
    });
    document.querySelector("#save").onclick = () => SE_API.store.set("phaseOneProbe", {
      id: "ended-prediction", status: "resolved", endedAt: "2000-01-01T00:00:00.000Z"
    });
  `;
  await page.route("**/widgets/demo/widget.html", (route) => route.fulfill({ contentType: "text/html", body: probeHTML }));
  await page.route("**/widgets/demo/widget.js", (route) => route.fulfill({ contentType: "text/javascript", body: probeJS }));
  await page.locator("#widgetSelect").selectOption("demo");
  await check(async () => (await frameA().locator("#loadCount").textContent()) === "1", "A receives exactly one automatic onWidgetLoad");
  await frameA().locator("#save").click();
  const expected = '{"id":"ended-prediction","status":"resolved","endedAt":"2000-01-01T00:00:00.000Z"}';
  await check(async () => (await frameA().locator("#value").textContent()) === expected, "Writer receives canonical kvstore update");

  await openPanel("Overlay / OBS scenarios");
  await page.locator("#overlayDuplicateButton").click();
  await check(async () => (await frameB().locator("#value").textContent()) === expected, "Overlay B reads account storage on first load");
  await page.locator("#overlayHiddenDeliveryMode").selectOption("destroy");
  await page.locator("#overlayHideButton").click();
  await check(async () => (await page.locator('iframe[data-overlay-id="B"]').count()) === 0, "Destroy removes iframe B");
  await page.locator("#overlayShowButton").click();
  await check(async () => (await frameB().locator("#value").textContent()) === expected, "Recreated B restores original absolute end time");
  await check(async () => (await frameB().locator("#loadCount").textContent()) === "1", "Recreated B loads once");
  await page.locator("#overlayActiveSelect").selectOption("A");
  await page.locator("#overlayRefreshButton").click();
  await check(async () => (await frameA().locator("#value").textContent()) === expected, "Refresh A preserves storage");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#widgetSelect").selectOption("demo");
  await check(async () => (await frameA().locator("#value").textContent()) === expected, "Full lab reload preserves SE storage");
  await page.screenshot({ path: "test-results/storage-probe.png", fullPage: true });
  assert.deepEqual(errors, [], "Unexpected browser JavaScript errors");
  console.log("Browser smoke checks passed. StreamElements server/OBS behavior is not certified by these tests.");
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png", fullPage: true }).catch(() => {});
  await writeFile("test-results/failure.txt", String(error.stack) + "\nBrowser errors: " + JSON.stringify(errors));
  throw error;
} finally {
  await browser.close();
}
