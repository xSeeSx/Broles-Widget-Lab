import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("test-results/clock", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const frame = id => page.frameLocator(`iframe[data-overlay-id="${id}"]`);
const check = async (fn, label, timeout = 5000) => {
  const until = Date.now() + timeout;
  while (!await fn()) { if (Date.now() > until) throw new Error(label); await page.waitForTimeout(25); }
  console.log("PASS clock " + label);
};
const capture = (id, duration) => frame(id).locator("body").evaluate(async (_body, duration) => {
  const clock = document.querySelector(".prediction-time-text");
  const saved = await window.SE_API.store.get("brolesPredictions133649243v2");
  const deadline = Date.parse(saved.snapshot.prediction.locks_at);
  const originalBeat = clock.getAnimations().find(animation => animation.animationName === "heartbeat");
  const changes = [], samples = [];
  let last = clock.textContent;
  const start = performance.now();
  await new Promise(resolve => {
    const sample = () => {
      const animation = clock.getAnimations().find(animation => animation.animationName === "heartbeat");
      const phase = ((Number(animation?.currentTime) % 1000) + 1000) % 1000;
      const expectedPhase = ((Date.now() - deadline) % 1000 + 1000) % 1000;
      const difference = Math.abs(phase - expectedPhase);
      const [minutes, seconds] = clock.textContent.split(":").map(Number);
      const entry = { time: performance.now(), text: clock.textContent, seconds: minutes * 60 + seconds,
        phase, phaseError: Math.min(difference, 1000 - difference),
        sameAnimation: animation === originalBeat, duration: animation?.effect.getTiming().duration };
      samples.push(entry);
      if (last !== clock.textContent) { changes.push(entry); last = clock.textContent; }
      if (performance.now() - start < duration) requestAnimationFrame(sample); else resolve();
    };
    requestAnimationFrame(sample);
  });
  return { changes, samples };
}, duration);
const assertAligned = (report, minChanges) => {
  assert(report.changes.length >= minChanges, "Enough real countdown changes were captured");
  assert(report.samples.every(sample => sample.duration === 1000), "The heartbeat period is exactly one second");
  assert(report.samples.every(sample => sample.sameAnimation), "Progress and replay cannot restart the animation");
  assert(Math.max(...report.samples.map(sample => sample.phaseError)) < 70, "The beat stays aligned to the absolute countdown clock");
  assert(report.changes.every(change => change.phase < 80), "Each digit change starts at the beat, rather than at a random quarter-second poll");
  for (let index = 1; index < report.changes.length; index++) {
    const previous = report.changes[index - 1], current = report.changes[index];
    assert.equal(previous.seconds - current.seconds, 1, "Exactly one displayed second per normal tick");
    assert(Math.abs(current.time - previous.time - 1000) < 70, "Countdown ticks cannot accumulate polling drift");
  }
};

try {
  await page.goto("http://127.0.0.1:4173/?widget=prediccion-v2", { waitUntil: "networkidle" });
  await check(async () => await page.locator("#workerConnectionCount").textContent() === "1", "socket ready");
  await page.locator("#predictionBeginNormalButton").click();
  await check(async () => frame("A").locator(".prediction-overlay").isVisible(), "active prediction visible");
  const recording = capture("A", 5200);
  await page.waitForTimeout(650);
  await page.locator("#predictionNormalProgressButton").click();
  await frame("A").locator("body").evaluate(async () => {
    const saved = await window.SE_API.store.get("brolesPredictions133649243v2");
    for (let index = 0; index < 30; index++) window.__LAB_WORKER_MOCK__.broadcast(saved.snapshot);
    window.dispatchEvent(new Event("resize"));
  });
  const normal = await recording;
  assertAligned(normal, 5);
  console.log("PASS clock one beat per digit change through progress, duplicate snapshots and resize");

  const panel = page.locator('[data-panel-title="Overlay / OBS scenarios"] > .panel-toggle');
  if (await panel.getAttribute("aria-expanded") === "false") await panel.click();
  await page.locator("#overlayDuplicateButton").click();
  await check(async () => frame("B").locator(".prediction-overlay").isVisible(), "late B joins the running countdown");
  const [a, b] = await Promise.all([capture("A", 3100), capture("B", 3100)]);
  assertAligned(a, 3); assertAligned(b, 3);
  console.log("PASS clock late overlay joins the current beat instead of starting a free-running pulse");

  // Deliberately stall the source thread; this tests recovery, not CEF rendering.
  await frame("B").locator("body").evaluate(() => {
    const until = performance.now() + 1250;
    while (performance.now() < until) { /* emulate a missed browser frame/timer */ }
    window.dispatchEvent(new Event("pageshow"));
  });
  await check(async () => frame("B").locator(".prediction-overlay").isVisible(), "wake state is freshly verified before measuring its beat");
  const recovered = await capture("B", 2200);
  assertAligned(recovered, 2);
  console.log("PASS clock missed seconds are skipped, without queued pulses or lasting drift");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const beforeReduced = await frame("A").locator(".prediction-time-text").textContent();
  await page.waitForTimeout(1100);
  assert.notEqual(await frame("A").locator(".prediction-time-text").textContent(), beforeReduced);
  assert(await frame("A").locator(".prediction-time-text").evaluate(node => !node.getAnimations().some(animation => animation.animationName === "heartbeat")));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#predictionLockButton").click();
  await check(async () => frame("A").locator(".prediction-time-text").evaluate(node => !node.classList.contains("heartbeat")), "lock stops the heartbeat");
  await page.locator("#predictionEndCanceledButton").click();
  assert(await frame("B").locator(".prediction-time-text").evaluate(node => !node.classList.contains("heartbeat")), "End does not retain an invisible looping pulse");
  assert.deepEqual(errors, []);
  await writeFile("test-results/clock/report.json", JSON.stringify({ status: "passed", normal, a, b, recovered, errors }, null, 2));
  console.log("Countdown heartbeat synchronization checks passed.");
} catch (error) {
  await page.screenshot({ path: "test-results/clock/failure.png" }).catch(() => {});
  await writeFile("test-results/clock/failure.txt", error.stack + "\n" + JSON.stringify(errors));
  throw error;
} finally { await context.close(); await browser.close(); }
