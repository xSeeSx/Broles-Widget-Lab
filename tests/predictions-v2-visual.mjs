import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: "test-results/visual-video", size: { width: 1600, height: 1000 } } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const frame = () => page.frameLocator("#widgetFrame");
const root = () => frame().locator(".prediction-overlay");
const check = async (fn, label, ms = 5000) => {
  const until = Date.now() + ms;
  while (!await fn()) { if (Date.now() > until) throw new Error(label); await page.waitForTimeout(40); }
  console.log("PASS visual " + label);
};
const values = () => frame().locator(".progress-bar-percent-text").allTextContents();
const field = (index, type) => page.locator(`#predictionOutcomes input[data-outcome-index="${index}"][data-outcome-field="${type}"]`);
const enter = async (users, points) => {
  for (let index = 0; index < users.length; index++) {
    await field(index, "users").fill(String(users[index]));
    await field(index, "channelPoints").fill(String(points[index]));
  }
};
const geometry = () => frame().locator(".prediction-children").evaluate((container) => ({
  width: container.clientWidth,
  children: [...container.children].map((node) => ({ left: node.offsetLeft, top: node.offsetTop, width: node.getBoundingClientRect().width, opacity: Number(getComputedStyle(node).opacity),
    percent: node.querySelector(".progress-bar-percent-text").textContent, users: node.querySelector(".progress-bar-users-text").textContent.trim(),
    multiplier: node.querySelector(".multiplier-text").textContent }))
}));
try {
  await page.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
  await check(async () => await page.locator("#workerConnectionCount").textContent() === "1", "ready");
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => await root().isVisible(), "begin");
  assert.deepEqual(await values(), ["50%", "50%"], "Initial percentages retain the equal split");
  assert.deepEqual((await geometry()).children.map(item => item.multiplier), ["x2.0", "x2.0"], "Initial visual multipliers match the 50/50 split");
  assert.equal(await page.locator("#predictionWinningOutcome").inputValue(), "");
  assert(await page.locator("#predictionResolveWinnerButton").isDisabled(), "No automatic result choice");
  await page.waitForTimeout(1600);
  const initial = await geometry();
  const separation = initial.children[1].left - initial.children[0].left - initial.children[0].width;
  assert(Math.abs(separation + 10) < 2, "Original overlapping bounds leave compact slanted gaps");
  await page.screenshot({ path: "test-results/v2-visual-initial.png" });
  // Render the untouched legacy assets with the same begin data as a visual reference.
  const reference = await context.newPage();
  const legacyHtml = await readFile("widgets/prediccion/widget.html", "utf8");
  const legacyCss = await readFile("widgets/prediccion/widget.css", "utf8");
  await reference.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { min-height: 100%; margin: 0; }
    body { display: grid; place-items: center; background: transparent; color: #fff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 0; }
  </style><style>${legacyCss}</style></head><body>${legacyHtml}</body></html>`);
  assert.equal(await reference.evaluate(() => document.compatMode), "CSS1Compat");
  await reference.addScriptTag({ content: `window.WebSocket = class extends EventTarget { constructor() { super(); window.referenceSocket = this; } };` });
  await reference.addScriptTag({ content: await readFile("widgets/prediccion/widget.js", "utf8") });
  await reference.evaluate(() => window.referenceSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "channel.prediction.begin", event: {
    title: "Quien gana la siguiente ronda?", locks_at: new Date(Date.now() + 60000).toISOString(), outcomes: [{ id: "outcome-1", title: "Opcion 1" }, { id: "outcome-2", title: "Opcion 2" }]
  } }) })));
  await reference.waitForTimeout(1800);
  const selectors = [".prediction-title-text", ".prediction-time-text", ".progress-bar", ".progress-bar-text", ".progress-bar-percent-text", ".progress-bar-multiplier", ".progress-bar-users-text", ".prediction-outcome > div"];
  const styles = (body, names) => names.map((selector) => {
    const node = body.querySelector(selector); const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
    return { selector, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle, fontFamily: style.fontFamily, backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor, textShadow: style.textShadow,
      top: rect.top - body.querySelector(".prediction-overlay").getBoundingClientRect().top, height: rect.height };
  });
  const originalStyle = await reference.locator("body").evaluate(styles, selectors);
  const initialRestoredStyle = await frame().locator("body").evaluate(styles, selectors);
  // Compare matching counter text. The begin contract omits users: v2 displays
  // an unknown placeholder until a real progress/sync supplies the zero totals.
  await reference.locator(".progress-bar-users-text").first().evaluate((node) => { node.lastChild.textContent = " …"; });
  const originalUnknownStyle = await reference.locator("body").evaluate(styles, selectors);
  await reference.locator(".progress-bar-users-text").first().evaluate((node) => { node.lastChild.textContent = " 0"; });
  const beforeZeroRevision = Number(await root().getAttribute("data-revision"));
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => Number(await root().getAttribute("data-revision")) > beforeZeroRevision && (await geometry()).children.every((item) => item.users === "0"), "initial zero progress is received");
  const restoredStyle = await frame().locator("body").evaluate(styles, selectors);
  await writeFile("test-results/v2-original-style-comparison.json", JSON.stringify({ originalStyle, originalUnknownStyle, initialRestoredStyle, restoredStyle }, null, 2));
  await reference.screenshot({ path: "test-results/prediction-original-reference.png" });
  for (let index = 0; index < selectors.length; index++) {
    const original = originalStyle[index], restored = restoredStyle[index];
    assert.deepEqual([restored.fontSize, restored.fontWeight, restored.fontStyle, restored.fontFamily], [original.fontSize, original.fontWeight, original.fontStyle, original.fontFamily], selectors[index] + " retains original typography");
    assert.deepEqual([restored.backgroundImage, restored.backgroundColor, restored.textShadow], [original.backgroundImage, original.backgroundColor, original.textShadow], selectors[index] + " retains original gradients, colors and shadows");
    assert(Math.abs(restored.top - original.top) < 2, selectors[index] + " retains original vertical placement: " + JSON.stringify({ original, restored }));
  }
  await reference.close();

  // Use the real numeric fields. Never substitute an internal state assignment.
  await enter([1, 0], [10000, 0]);
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => JSON.stringify((await geometry()).children.map(item => [item.users, item.percent, item.multiplier])) ===
    '[["1","100%","x1.0"],["0","0%","x100.0"]]', "10k against zero shows visual x1/x100 and keeps actual users");
  await page.screenshot({ path: "test-results/v2-visual-zero-percent-odds.png" });
  await enter([1, 1], [10000, 10000]);
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => JSON.stringify((await geometry()).children.map(item => item.multiplier)) === '["x2.0","x2.0"]',
    "visual odds update from zero percent to an even split");
  await enter([25, 75], [10000, 30000]);
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => JSON.stringify(await values()) === '["25%","75%"]', "manual points reach the percentage labels");
  await check(async () => {
    const data = await geometry(); return Math.abs(data.children[0].width / (data.children[0].width + data.children[1].width) - .25) < .015;
  }, "manual 25/75 also reaches bar geometry");
  assert.deepEqual((await geometry()).children.map((item) => item.users), ["25", "75"]);
  assert.deepEqual((await geometry()).children.map((item) => item.multiplier), ["x4.0", "x1.3"]);
  // Progress writes are debounced; the eventual store must contain exactly the edited totals.
  await check(async () => frame().locator("body").evaluate(async () => {
    const saved = await window.SE_API.store.get("brolesPredictions133649243v2");
    return JSON.stringify(saved?.snapshot.prediction.outcomes.map((x) => [x.users, x.channel_points])) === '[[25,10000],[75,30000]]';
  }), "manual counters reach SE storage exactly");
  await enter([1, 1], [10, 10]);
  await page.locator("#predictionNormalProgressButton").click();
  assert((await page.locator("#predictionVoteFeedback").textContent()).includes("No enviado"), "Decreasing cumulative totals cannot silently diverge from the widget");
  assert.deepEqual(await values(), ["25%", "75%"]);
  await enter([75, 75], [30000, 30000]);
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => JSON.stringify(await values()) === '["50%","50%"]', "equal manually entered points stay tied");
  assert.equal(await page.locator("#predictionWinningOutcome").inputValue(), "");
  assert(await page.locator("#predictionResolveWinnerButton").isDisabled());

  // Choose option 2 explicitly and resolve directly during active voting.
  await frame().locator("body").evaluate(() => {
    window.resultMotionSamples = [];
    let start;
    const sample = () => {
      const container = document.querySelector(".prediction-children");
      if (document.querySelector(".prediction-overlay").dataset.phase === "resolved") {
        start ??= performance.now();
        const winner = container.querySelector('[data-outcome-id="outcome-2"]');
        const loser = container.querySelector('[data-outcome-id="outcome-1"]');
        const label = winner.querySelector(".progress-bar-text");
        const labelRect = label.getBoundingClientRect(), winnerRect = winner.getBoundingClientRect();
        const labelStyle = getComputedStyle(label);
        const labelScale = labelStyle.transform === "none" ? 1 : new DOMMatrixReadOnly(labelStyle.transform).a;
        const barMotion = winner.getAnimations().find(animation => animation.animationName === "resultWinner");
        const labelMotion = label.getAnimations().find(animation => animation.animationName === "resultWinnerLabel");
        window.resultMotionSamples.push({ time: performance.now() - start, width: winner.getBoundingClientRect().width,
          target: container.clientWidth, loserOpacity: Number(getComputedStyle(loser).opacity),
          labelScale, labelCenterError: labelRect.left + labelRect.width / 2 - winnerRect.left - winnerRect.width / 2,
          labelAnimation: labelStyle.animationName, barTime: barMotion?.currentTime ?? null, labelTime: labelMotion?.currentTime ?? null,
          animation: getComputedStyle(winner).animationName });
      }
      if (start === undefined || performance.now() - start < 5600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator("#predictionWinningOutcome").selectOption("outcome-2");
  await page.locator("#predictionResolveWinnerButton").click();
  await check(async () => await root().getAttribute("data-phase") === "resolved", "active can resolve directly");
  const deadline = Number(await root().getAttribute("data-hide-at"));
  assert((await frame().locator(".prediction-title-text").textContent()).startsWith("🏆 "));
  assert.equal(await root().evaluate((node) => getComputedStyle(node).animationName), "fadeIn", "Direct result has a new entrance animation");
  await check(async () => {
    const data = await geometry(); return Math.abs(data.children[0].width / (data.children[0].width + data.children[1].width) - .5) < .01;
  }, "immediate resolution finishes the final tied-width transition", 1800);
  await page.waitForTimeout(100);
  const before = await geometry();
  assert(before.children.every((item) => item.opacity > .99), "Both bars settle visible before losing animation");
  await check(async () => (await geometry()).children[0].opacity < .8, "loser really fades", 4200);
  await page.screenshot({ path: "test-results/v2-visual-loser-fading.png" });
  await check(async () => {
    const data = await geometry(); return data.children[1].width > before.children[1].width + 10 && data.children[1].width < data.width - 10;
  }, "winner expansion has intermediate frames", 3500);
  await check(async () => {
    const data = await geometry();
    const settled = await frame().locator('.prediction-child.is-winner').evaluate(node =>
      node.getAnimations().filter(animation => animation.animationName === "resultWinner").every(animation => animation.playState === "finished"));
    return settled && Math.abs(data.children[1].width - data.width) < 2 && Math.abs(data.children[1].left) < 2 && data.children[0].opacity < .01;
  }, "option 2 expands fully to the left edge", 2500);
  await page.screenshot({ path: "test-results/v2-visual-winner-expanded.png" });
  const expanded = await geometry();
  await page.waitForTimeout(600);
  assert.deepEqual(await geometry(), expanded, "Periodic renders cannot restart or freeze the final motion");
  const motionSamples = await frame().locator("body").evaluate(() => window.resultMotionSamples);
  assert(motionSamples.some(sample => sample.animation === "resultWinner" && sample.loserOpacity > .001 && sample.loserOpacity < .5 && sample.width > before.children[1].width + 1),
    "Winner expands while the tail of the loser fade is still visible");
  const peak = motionSamples.findIndex(sample => sample.width > sample.target + 5);
  assert(peak >= 0, "The winner visibly overshoots its final width");
  assert(motionSamples.slice(peak + 1).some(sample => sample.width < sample.target - 2), "The bounce returns through the final width before settling");
  const labelSamples = motionSamples.filter(sample => sample.labelAnimation === "resultWinnerLabel");
  assert(labelSamples.some(sample => sample.width > before.children[1].width + 10 && sample.width < sample.target - 10 && sample.labelScale > 1.01 && sample.labelCenterError < -1),
    "The label moves toward the center and emphasizes while its bar is expanding");
  assert(labelSamples.every(sample => Math.abs(sample.barTime - sample.labelTime) < 1), "Label and bar share the same animation clock");
  assert(Math.max(...labelSamples.map(sample => sample.labelScale)) > 1.14, "The winner name has a visible emphasis pulse");
  const finalLabel = labelSamples.at(-1);
  assert(Math.abs(finalLabel.labelCenterError) < .5 && Math.abs(finalLabel.labelScale - 1.06) < .005, "The name settles centered with restrained emphasis");
  await writeFile("test-results/v2-result-motion.json", JSON.stringify(motionSamples, null, 2));
  assert.equal(Number(await root().getAttribute("data-hide-at")), deadline);
  await check(async () => await root().evaluate((node) => getComputedStyle(node).animationName === "fadeOut"), "exit animation starts", 5500);
  await page.waitForTimeout(300);
  assert.equal(await frame().locator(".prediction-children").evaluate((node) => getComputedStyle(node).animationName), "slideOut", "Original bar exit is preserved");
  const exitOpacity = await root().evaluate((node) => Number(getComputedStyle(node).opacity));
  assert(exitOpacity > 0 && exitOpacity < 1, "Exit has an actual intermediate visible frame");
  await check(async () => !await root().isVisible(), "exit cleans up title and bars", 1500);
  assert.equal(await frame().locator(".prediction-child").count(), 0);
  assert.equal(await frame().locator(".prediction-title-text").textContent(), "");

  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => await root().getAttribute("data-phase") === "active", "next begin");
  await page.locator("#predictionVotePattern").selectOption("equal");
  await page.locator("#predictionApplyVotePatternButton").click();
  await page.locator("#predictionNormalProgressButton").click();
  await check(async () => JSON.stringify(await values()) === '["50%","50%"]', "equal preset");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: "test-results/v2-visual-tie.png" });
  await enter([1, 1], [1, 1]);
  await page.locator("#predictionLockButton").click();
  await check(async () => await root().getAttribute("data-phase") === "locked", "lock");
  assert.equal(await field(0, "channelPoints").inputValue(), "10000", "Lock preserves sent totals rather than committing an unsent draft");
  assert.deepEqual(await values(), ["50%", "50%"]);
  const title = await frame().locator(".prediction-title-text").textContent();
  assert(title.startsWith("🛑 ") && title.endsWith(" 🛑"), "STOP is present at both ends");
  await page.screenshot({ path: "test-results/v2-visual-lock.png" });
  assert.deepEqual(errors, []);
  await writeFile("test-results/v2-visual-report.json", JSON.stringify({ status: "passed", initial, before, expanded, exitOpacity, errors }, null, 2));
  console.log("Visual sequence and manual vote regressions passed.");
} catch (error) {
  await page.screenshot({ path: "test-results/v2-visual-failure.png" }).catch(() => {});
  await writeFile("test-results/v2-visual-failure.txt", error.stack + "\n" + JSON.stringify(errors) + "\n" + await page.locator("#logList").textContent());
  throw error;
} finally { await context.close(); await browser.close(); }
