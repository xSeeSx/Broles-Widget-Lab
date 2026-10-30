import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { runControlTests } from "./controls-suite.mjs";

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

  await runControlTests({ page, frameA, check });

  await page.locator("#widgetSelect").selectOption("marco");
  await check(async () => (await frameA().locator("#widgetContainer video").count()) === 4, "Marco DOM loads");
  await page.screenshot({ path: "test-results/marco.png", fullPage: true });

  await page.locator("#widgetSelect").selectOption("prediccion");
  await check(async () => (await page.locator("#appStatus").textContent()).startsWith("Cargado:"), "Prediction document loaded");
  await page.setViewportSize({ width: 1366, height: 768 });
  assert.equal(await page.locator('.prediction-panel .panel-toggle').getAttribute("aria-expanded"), "true", "Selecting prediction opens its controls automatically");
  const startBox = await page.locator("#predictionBeginNormalButton").boundingBox();
  assert(startBox.y >= 0 && startBox.y + startBox.height < 768, "Start is on screen without scrolling at 1366x768");
  assert(await page.locator("#predictionLockButton").isDisabled(), "Lock is disabled before start");
  await page.screenshot({ path: "test-results/compact-prediction-ready.png" });
  await page.locator("#predictionBeginNormalButton").click();
  assert(await page.locator("#predictionBeginNormalButton").isDisabled(), "Second start is visibly blocked");
  assert(await page.locator("#predictionLockButton").isEnabled(), "Lock becomes available after start");
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
  const probeHTML = '<button id="save">Save result</button><output id="value">loading</output><output id="loadCount">0</output><output id="wireCount">0</output><pre id="wire">null</pre><output id="overlayEditor">unknown</output>';
  const probeJS = `
    let loads = 0;
    const value = document.querySelector("#value");
    const draw = (data) => { value.textContent = JSON.stringify(data ?? null); };
    let wireCount = 0;
    const socket = new WebSocket("wss://worker.mock/ws");
    socket.addEventListener("message", (event) => {
      document.querySelector("#wire").textContent = event.data;
      document.querySelector("#wireCount").textContent = String(++wireCount);
    });
    window.addEventListener("onWidgetLoad", () => {
      document.querySelector("#loadCount").textContent = String(++loads);
      SE_API.store.get("phaseOneProbe").then(draw);
      SE_API.getOverlayStatus().then((status) => document.querySelector("#overlayEditor").textContent = String(status.isEditorMode));
    });
    window.addEventListener("onEventReceived", (event) => {
      if (event.detail.listener === "kvstore:update" && event.detail.event.data.key === "customWidget.phaseOneProbe") draw(event.detail.event.data.value);
    });
    document.querySelector("#save").onclick = () => SE_API.store.set("phaseOneProbe", {
      id: "ended-prediction", status: "resolved", endedAt: "2000-01-01T00:00:00.000Z"
    });
  `;
  await page.route("**/widgets/prediccion/widget.html", (route) => route.fulfill({ contentType: "text/html", body: probeHTML }));
  await page.route("**/widgets/prediccion/widget.js", (route) => route.fulfill({ contentType: "text/javascript", body: probeJS }));
  await page.locator("#widgetSelect").selectOption("prediccion");
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

  const wire = async (frame) => JSON.parse(await frame().locator("#wire").textContent());
  await page.locator("#overlayActiveSelect").selectOption("B");
  await page.locator("#overlayHiddenDeliveryMode").selectOption("deliver");
  await page.locator("[data-prediction-count='10']").click();
  await page.locator('#predictionOutcomes input[data-outcome-index="9"][data-outcome-field="channelPoints"]').scrollIntoViewIfNeeded();
  const pinned = await page.locator("#predictionBeginNormalButton").evaluate((node) => {
    const r = node.getBoundingClientRect();
    return r.top >= 0 && r.bottom < innerHeight && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  assert(pinned, "Start remains usable while editing the tenth option");
  await page.screenshot({ path: "test-results/compact-ten-options.png" });
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => (await wire(frameA)).event?.outcomes.length === 10 && (await wire(frameB)).event?.outcomes.length === 10,
    "Ten-option begin broadcasts to A and B");
  await page.locator("#predictionApplyVotePatternButton").click();
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => (await wire(frameB)).type === "channel.prediction.progress", "Ten-option progress reaches B");
  assert.equal((await wire(frameB)).event.outcomes.length, 10);
  assert((await wire(frameB)).event.outcomes.every((outcome) => outcome.color === "blue"));
  const countA = await frameA().locator("#wireCount").textContent();
  const countB = await frameB().locator("#wireCount").textContent();
  await page.locator("#overlayDeliveryTarget").selectOption("B");
  assert.equal(await frameB().locator("#wireCount").textContent(), countB, "Changing target is passive");
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => (await frameB().locator("#wireCount").textContent()) !== countB, "Only B receives targeted progress");
  assert.equal(await frameA().locator("#wireCount").textContent(), countA, "A is excluded from targeted progress");
  await page.locator("#overlayDeliveryTarget").selectOption("all");
  await page.locator("#overlayHideButton").click();
  await page.locator("#predictionLockButton").click();
  assert(await page.locator('#predictionOutcomes input[data-outcome-field="users"]').first().isDisabled(), "Twitch valid mode freezes vote inputs after lock");
  await page.locator("#predictionWinningOutcome").selectOption("outcome-1");
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => (await wire(frameB)).type === "channel.prediction.end", "Deliver while hidden receives end");

  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => (await wire(frameB)).type === "channel.prediction.begin", "Hidden live B receives next begin");
  await page.locator("#overlayHiddenDeliveryMode").selectOption("skip");
  await page.locator("#predictionLockButton").click();
  await page.locator("#predictionWinningOutcome").selectOption("outcome-1");
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => (await wire(frameA)).type === "channel.prediction.end", "Visible A receives end while B is skipped");
  assert.equal((await wire(frameB)).type, "channel.prediction.begin", "Hidden B missed end as configured");
  await page.locator("#overlayShowButton").click();
  await openPanel("Worker WebSocket");
  await page.locator("#workerReplayCurrentButton").click();
  await check(async () => (await wire(frameB)).type === "channel.prediction.end", "Manual replay restores B's missing end");
  assert.equal((await wire(frameB)).event.ended_at, (await wire(frameA)).event.ended_at, "Replay preserves absolute end time");

  await page.locator("#predictionBeginNormalButton").click();
  await page.locator("#predictionApplyVotePatternButton").click();
  await page.locator("#predictionNormalProgressButton").click();
  await page.locator("#predictionLockButton").click();
  await page.locator("#workerReplayMode").selectOption("current-snapshot");
  await page.locator("#overlayRefreshButton").click();
  await check(async () => (await wire(frameB)).type === "channel.prediction.lock", "Reloaded B receives locked snapshot");
  assert.equal(await frameB().locator("#wireCount").textContent(), "1", "Snapshot does not fabricate begin/history");
  await page.locator("#predictionEndCanceledButton").click();
  await check(async () => (await wire(frameB)).event?.status === "canceled", "Cancellation payload reaches B");
  assert.equal((await wire(frameB)).event.winning_outcome_id, null);
  const canceledPredictors = (await wire(frameB)).event.outcomes.flatMap((outcome) => outcome.top_predictors);
  assert(canceledPredictors.length > 0, "Cancellation check has actual participants");
  assert(canceledPredictors.every((predictor) => predictor.channel_points_won === 0), "Canceled predictions award zero points, not null");

  await page.locator("#predictionStressMode").check();
  await page.locator("#predictionStressScenarios > summary").click();
  await page.locator("#predictionBeginOneSecondButton").click();
  await page.locator("#predictionActiveExpiredButton").click();
  await check(async () => (await page.locator("#predictionStateSummary").textContent()).includes("active_expired"), "Stress mode can force active_expired");
  await page.locator("#predictionResetLabStateButton").click();
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#widgetSelect").selectOption("prediccion");
  await check(async () => (await frameA().locator("#value").textContent()) === expected, "Full lab reload preserves SE storage");
  await page.screenshot({ path: "test-results/storage-probe.png", fullPage: true });

  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("http://127.0.0.1:4173/?view=obs&widget=prediccion", { waitUntil: "networkidle" });
  await check(async () => (await frameA().locator("#loadCount").textContent()) === "1", "OBS view loads the requested widget with the same harness");
  assert.equal(await page.locator(".control-panel").isVisible(), false, "Clean OBS view has no controls drawn");
  assert.equal(await page.locator(".app-header").isVisible(), false, "Clean OBS view has no app header");
  const viewport = await page.locator('iframe[data-overlay-id="A"]').boundingBox();
  assert.deepEqual({ x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height }, { x: 0, y: 0, width: 1600, height: 1100 });
  assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.keyboard.press("F2");
  await check(async () => page.locator(".control-panel").isVisible(), "F2 opens OBS test controls");
  // Test only the diagnostic listener; this synthetic event does not simulate CEF rendering.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("obsSourceVisibleChanged", { detail: { visible: false } })));
  const environment = JSON.parse(await page.locator("#obsDiagnostics").textContent());
  assert.equal(environment.lastNativeEvent.type, "obsSourceVisibleChanged");
  assert.equal(environment.obsAPI, false, "The lab never fabricates window.obsstudio");
  assert.equal(await frameA().locator("#overlayEditor").textContent(), "false", "OBS test view emulates a published SE overlay, not editor mode");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".control-panel").isVisible(), false);
  await page.setViewportSize({ width: 1280, height: 720 });
  await check(async () => (await page.locator('iframe[data-overlay-id="A"]').boundingBox()).width === 1280, "OBS test canvas follows source viewport without CSS scaling");
  await page.screenshot({ path: "test-results/obs-clean-view.png", fullPage: true });
  assert.deepEqual(errors, [], "Unexpected browser JavaScript errors");
  console.log("Browser smoke checks passed. StreamElements server/OBS behavior is not certified by these tests.");
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png", fullPage: true }).catch(() => {});
  await writeFile("test-results/failure.txt", String(error.stack) + "\nBrowser errors: " + JSON.stringify(errors));
  throw error;
} finally {
  await browser.close();
}
