import assert from "node:assert/strict";

export async function runControlTests({ page, frameA, check }) {
  const navigate = (title) => page.locator("#toolSelect").selectOption(title);
  await navigate("Chat simulator");
  await page.locator("#chatMessageInput").fill("Control de chat Kappa");
  await page.locator("#chatSendViewerButton").click();
  await check(async () => (await frameA().locator("#demoEvents").textContent()).includes("Control de chat Kappa"), "Chat controls deliver the entered message");
  assert.equal(await page.locator("#chatHistoryCount").textContent(), "1");
  await page.locator("#chatMessageInput").fill("Mensaje por Enter");
  await page.locator("#chatMessageInput").press("Enter");
  await check(async () => (await frameA().locator("#demoEvents").textContent()).includes("Mensaje por Enter"), "Chat Enter shortcut works");

  await navigate("StreamElements events");
  for (const [id, listener] of [["emitFollowButton", "follower-latest"], ["emitSubscriberButton", "subscriber-latest"], ["emitTipButton", "tip-latest"], ["emitCheerButton", "cheer-latest"], ["emitKvStoreButton", "kvstore:update"]]) {
    await page.locator("#" + id).click();
    await check(async () => (await frameA().locator("#demoEvents").textContent()).includes(listener), "Event control delivers " + listener);
  }
  await page.locator("#emitWidgetLoadButton").click();
  await check(async () => (await frameA().locator("#demoMessage").textContent()) === "onWidgetLoad received", "Manual widget load works");
  await navigate("StreamElements payload JSON");
  await page.locator("#eventPayload").fill("{");
  // Opening another panel preserves the draft; malformed JSON must not reach the iframe.
  await navigate("StreamElements events");
  await page.locator("#emitWidgetLoadButton").click();
  await navigate("StreamElements payload JSON");
  assert(await page.locator("#payloadError").isVisible(), "Invalid JSON has visible feedback");

  await navigate("Responsive");
  await page.locator("#viewportPresetSelect").selectOption("800x200");
  await page.locator("#zoomSelect").selectOption("0.5");
  await page.locator("#previewBackgroundSelect").selectOption("chroma");
  const size = await page.locator("#iframeViewport").evaluate((node) => ({ width: node.style.width, height: node.style.height }));
  assert.deepEqual(size, { width: "800px", height: "200px" });
  assert((await page.locator("#previewShell").getAttribute("class")).includes("preview-bg-chroma"));
  await page.locator("#viewportPresetSelect").selectOption("1280x720");
  await page.locator("#zoomSelect").selectOption("0.75");
  await page.locator("#previewBackgroundSelect").selectOption("gray");

  await navigate("Widget Store");
  await page.locator("#validateWidgetsButton").click();
  await check(async () => (await page.locator("#validationResults > li").count()) >= 3, "Registry validation control produces results");
  await navigate("Fields");
  assert((await page.locator("#fieldsList").textContent()).includes("title"), "Fields panel shows the selected widget schema");

  await navigate("Import widget");
  await page.locator("#importWidgetId").fill("control-probe");
  await page.locator("#importWidgetName").fill("Control probe");
  await page.locator("#importWidgetHtml").fill('<output id="importProof">Waiting</output>');
  await page.locator("#importWidgetJs").fill('window.addEventListener("onWidgetLoad", () => document.querySelector("#importProof").textContent = "Import loaded");');
  await page.locator("#importPreviewButton").click();
  await check(async () => (await frameA().locator("#importProof").textContent()) === "Import loaded", "Import preview initializes an isolated widget");
  await page.locator("#widgetSelect").selectOption("demo");
  await check(async () => await frameA().locator("#demoTitle").count() === 1, "Registry widget can be restored after import");
  await page.locator("#reloadWidgetButton").click();
  await check(async () => await frameA().locator("#demoTitle").count() === 1, "Quick reload restores selected widget");
  // The navigation must reach every tool with one selection, including long panels.
  for (const title of await page.locator('#toolSelect option:not([value=""])').allTextContents()) {
    await navigate(title);
    const section = page.locator('[data-panel-title="' + title + '"]');
    assert.equal(await section.locator(".panel-toggle").getAttribute("aria-expanded"), "true");
    assert(await section.locator(".panel-content").isVisible());
    const overflow = await section.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false, title + " fits the compact sidebar");
  }
  console.log("PASS all tools are reachable through compact navigation");
}
