export async function runAppTests({ source, contract, evaluate, assert }) {
  const emitted = [];
  const logs = [];
  const scheduled = new Map();
  let timerId = 0;
  let identity = 0;
  const window = {
    setTimeout(fn) { scheduled.set(++timerId, fn); return timerId; },
    clearTimeout(id) { scheduled.delete(id); }
  };
  const document = { addEventListener() {} };
  const predictionEvent = evaluate(contract.replace("export function", "function") + "\nreturn predictionEvent;");
  const app = evaluate(source.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "").replaceAll("import.meta.url", '"https://example.test/src/app.js"') + `
    writeLog = (...args) => logs.push(args);
    renderPredictionControls = () => {};
    renderPredictionStateSummary = () => {};
    renderOverlayStatus = () => {};
    syncPredictionFromControls = () => {};
    emitTwitchPredictionPayload = (payload) => emitted.push(payload);
    elements.overlayDeliveryTarget = { value: "" };
    const testFrames = new Map();
    getOverlayFrame = (id) => testFrames.get(id);
    return { state, elements, testFrames, beginNormalPrediction, sendPredictionProgressWithCurrentVotes,
      lockPrediction, endPredictionByOutcomeId, setOverlayDeliveryTarget, getTargetFrameResult,
      resetPredictionLabState, buildIframeDocument, startPredictionWindow, beginTenOutcomePrediction };
  `, { window, document, emitted, logs, predictionEvent, crypto: { randomUUID: () => String(++identity) } });
  const results = [];
  const test = (name, action) => { action(); results.push(name); };

  test("normal flow uses unique IDs and rejects a second unresolved prediction", () => {
    app.beginNormalPrediction();
    const id = emitted[0].event.id;
    app.beginNormalPrediction();
    assert(emitted.length === 1, "second Begin must be blocked");
    app.sendPredictionProgressWithCurrentVotes();
    app.lockPrediction();
    app.endPredictionByOutcomeId("outcome-1", "resolved");
    assert(emitted.map((x) => x.type).join(",") === "channel.prediction.begin,channel.prediction.progress,channel.prediction.lock,channel.prediction.end", "normal flow");
    app.beginNormalPrediction();
    assert(emitted.at(-1).event.id !== id, "new prediction ID");
  });
  test("automatic lock timer belongs to the prediction that created it", () => {
    const callback = [...scheduled.values()].at(-1);
    app.endPredictionByOutcomeId("outcome-1", "resolved");
    app.beginNormalPrediction();
    const count = emitted.length;
    callback();
    assert(emitted.length === count, "old callback cannot lock new prediction");
    const nextCallback = [...scheduled.values()].at(-1);
    nextCallback();
    assert(emitted.at(-1).type === "channel.prediction.lock", "auto-lock");
    assert(emitted.at(-1).event.locked_at === app.state.prediction.locksAt, "absolute lock time");
  });
  test("progress after lock is blocked in Twitch valid mode", () => {
    const count = emitted.length;
    app.sendPredictionProgressWithCurrentVotes();
    assert(emitted.length === count, "locked progress blocked");
  });
  test("advanced ten-option shortcut cannot mutate an unresolved prediction", () => {
    const count = app.state.prediction.outcomes.length;
    const id = app.state.prediction.id;
    app.beginTenOutcomePrediction();
    assert(app.state.prediction.outcomes.length === count, "preset must not resize an active prediction");
    assert(app.state.prediction.id === id, "preset must not replace active ID");
  });
  test("target changes are passive; hidden skip and destroyed frames are explicit", () => {
    app.state.overlays.instances.B = { id: "B", hidden: true, loaded: true };
    app.testFrames.set("A", { id: "A" }); app.testFrames.set("B", { id: "B" });
    const count = emitted.length;
    app.setOverlayDeliveryTarget("B");
    assert(emitted.length === count, "target change cannot emit");
    app.state.overlays.hiddenDeliveryMode = "deliver";
    assert(app.getTargetFrameResult("all").frames.length === 2, "deliver hidden");
    app.state.overlays.hiddenDeliveryMode = "skip";
    assert(app.getTargetFrameResult("all").frames.length === 1, "skip hidden");
    assert(app.getTargetFrameResult("all").skippedHidden[0] === "B", "skip log");
    app.testFrames.delete("B");
    assert(app.getTargetFrameResult("all").skippedUnavailable[0] === "B", "destroy log");
  });
  test("new iframe receives initial SE load data and current Worker snapshot before widget code", () => {
    const html = app.buildIframeDocument({ manifest: { id: "demo", name: "demo" }, html: "<p>Test</p>",
      css: "", script: "/* WIDGET */", fieldsSchema: {}, fieldData: {}, harnessScripts: ["/* HARNESS */"], overlayId: "B" });
    assert(html.includes("window.__LAB_SE_INITIAL_LOAD__"), "initial SE data");
    assert(html.indexOf("window.__LAB_SE_INITIAL_LOAD__") < html.indexOf("/* HARNESS */"), "configure before harness");
    assert(html.indexOf("/* HARNESS */") < html.indexOf("/* WIDGET */"), "harness before widget");
  });
  app.resetPredictionLabState();
  return results;
}
