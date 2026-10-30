// Pure contract tests, runnable in Node and in a lightweight JS harness.
// UI/browser tests are a separate acceptance step.
export async function runContractTests({ sources, evaluate, createEventTarget, event, customEvent, messageEvent, flush, timers }) {
  const results = [];
  function equal(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ": " + JSON.stringify(actual));
  }
  function ok(value, label) { if (!value) throw new Error(label); }
  async function test(name, action) { await action(); results.push(name); }

  const makeHost = evaluate(sources.host.replace("export function", "function") + "\nreturn createSEStoreHost;");
  const format = evaluate(sources.contract.replace("export function", "function") + "\nreturn predictionEvent;");
  const database = new Map();
  const storage = { getItem: (key) => database.get(key) ?? null, setItem: (key, value) => database.set(key, value) };
  let host;
  const frames = [];
  function frame(id, withWorker = false, initialState = {}) {
    const win = createEventTarget();
    const parent = { postMessage(data) { Promise.resolve().then(() => host.handle({ source: win, data })); } };
    win.postMessage = (data) => Promise.resolve().then(() => win.dispatchEvent(messageEvent({ data, source: parent })));
    win.__LAB_OVERLAY_ID__ = id;
    win.__LAB_FIELDS__ = { title: "test" };
    win.__LAB_WORKER_INITIAL_STATE__ = initialState;
    win.__LAB_WORKER_INITIAL_CONFIG__ = { replayMode: "welcome" };
    win.__LAB_LOG__ = () => {};
    win.setTimeout = timers.setTimeout;
    win.clearTimeout = timers.clearTimeout;
    evaluate(sources.se, { window: win, parent });
    if (withWorker) evaluate(sources.worker, { window: win, parent });
    frames.push({ contentWindow: win });
    return { win, parent };
  }
  host = makeHost({ getFrames: () => frames, storage });
  const a = frame("A");
  const b = frame("B");

  await test("store.set sends canonical kvstore:update to A and B, including writer", async () => {
    const events = [[], []];
    a.win.addEventListener("onEventReceived", (e) => events[0].push(e.detail));
    b.win.addEventListener("onEventReceived", (e) => events[1].push(e.detail));
    equal(a.win.SE_API.store.set("predictionState", { id: "p1", status: "resolved", endedAt: 10 }), undefined, "set return");
    await flush();
    const expected = { listener: "kvstore:update", event: { data: { key: "customWidget.predictionState", value: { id: "p1", status: "resolved", endedAt: 10 } } } };
    equal(events[0][0], expected, "A event");
    equal(events[1][0], expected, "B event");
    equal(await b.win.SE_API.store.get("predictionState"), expected.event.data.value, "shared read");
  });

  await test("store survives iframe destruction and full host recreation without changing end time", async () => {
    frames.splice(1, 1);
    host = makeHost({ getFrames: () => frames, storage });
    const reloaded = frame("B");
    equal(await reloaded.win.SE_API.store.get("predictionState"), { id: "p1", status: "resolved", endedAt: 10 }, "persisted end");
    // The future renderer must compare this absolute endedAt to now, never restart a result timer.
  });

  await test("store overwrites full object and returns detached copies", async () => {
    a.win.SE_API.store.set("predictionState", { id: "p2" });
    await flush();
    const first = await a.win.SE_API.store.get("predictionState");
    first.extra = true;
    equal(await a.win.SE_API.store.get("predictionState"), { id: "p2" }, "full replacement");
    equal(typeof a.win.SE_API.store.delete, "undefined", "unsupported delete");
    equal(typeof a.win.SE_API.store.clear, "undefined", "unsupported clear");
  });

  await test("manual external kvstore:update changes the shared backend too", async () => {
    host.injectKVUpdate({ listener: "kvstore:update", event: { data: { key: "customWidget.external", value: { count: 9 } } } });
    equal(await a.win.SE_API.store.get("external"), { count: 9 }, "external read");
  });

  await test("host rejects messages from destroyed or unknown iframe", async () => {
    const outsider = { postMessage() { throw new Error("must not reply"); } };
    host.handle({ source: outsider, data: { source: "losbroles-widget-lab-widget", type: "SE_STORE_REQUEST", action: "set", key: "predictionState", value: { bad: true } } });
    equal(await a.win.SE_API.store.get("predictionState"), { id: "p2" }, "authenticated writer");
  });

  await test("host storage failures reject reads instead of reporting success", async () => {
    const goodHost = host;
    host = makeHost({ getFrames: () => frames, storage: { getItem() { throw new Error("offline"); } } });
    let error;
    try { await a.win.SE_API.store.get("predictionState"); } catch (e) { error = e.message; }
    equal(error, "offline", "read failure");
    host = goodHost;
  });

  await test("onWidgetLoad fires automatically once at source load, with fields", async () => {
    const events = [];
    a.win.addEventListener("onWidgetLoad", (e) => events.push(e.detail));
    a.win.dispatchEvent(event("load")); a.win.dispatchEvent(event("load"));
    equal(events.length, 1, "load once");
    equal(events[0].fieldData, { title: "test" }, "fields");
    equal(await a.win.SE_API.counters.get("follower-total"), { id: "follower-total", count: 1284 }, "counter contract");
    equal(await a.win.SE_API.getOverlayStatus(), { isEditorMode: true, muted: false }, "overlay status");
    equal(await a.win.SE_API.sanitize({ message: "hello" }), { skip: false, result: { message: "hello" } }, "sanitize shape");
  });

  await test("cheerFilter removes simulated cheer tokens and returns a Promise", async () => {
    equal(await a.win.SE_API.cheerFilter("shamrock100 This is a cheer message cheer100 cheerwhal100"), "This is a cheer message", "cheer filter");
  });

  await test("EventSub begin has no vote fields; lock/end have correct time fields and nulls", async () => {
    const raw = { id: "p", title: "test", started_at: "2026-01-01T00:00:00Z", locks_at: "2026-01-01T00:01:00Z",
      locked_at: "2026-01-01T00:01:00Z", ended_at: "2026-01-01T00:02:00Z", status: "canceled", winning_outcome_id: "o1",
      outcomes: [{ id: "o1", title: "A", color: "blue", users: 1, channel_points: 100,
        top_predictors: [{ user_id: "u1", channel_points_used: 100 }] }] };
    const begin = format("begin", raw);
    equal(begin.outcomes[0], { id: "o1", title: "A", color: "blue" }, "begin outcome");
    ok(!("locked_at" in begin) && !("status" in begin), "begin fields");
    const lock = format("lock", raw);
    ok(!("locks_at" in lock) && !("ended_at" in lock), "lock fields");
    equal(lock.outcomes[0].top_predictors[0].channel_points_won, null, "lock won null");
    const end = format("end", raw);
    equal(end.winning_outcome_id, null, "cancel has no winner");
    equal(end.outcomes[0].top_predictors[0].channel_points_won, null, "cancel won null");
  });

  await test("explicit Twitch payload is never repaired with default event fields", async () => {
    evaluate(sources.twitch, { window: a.win, parent: a.parent });
    const payload = { type: "channel.prediction.lock", subscription: { type: "channel.prediction.lock" }, event: { id: "broken" } };
    equal(a.win.TwitchEventSubMock.emit(payload), payload, "raw payload");
  });

  const c = frame("C", true, { currentPrediction: { id: "old" }, lastPredictionPayload: { type: "channel.prediction.end", event: { id: "old" } } });
  await test("Worker intercepts production URL, sends welcome and does not replay old result by default", async () => {
    const received = [];
    const socket = new c.win.WebSocket("wss://losbroles.lessergio.workers.dev/ws?broadcaster_id=133649243");
    socket.addEventListener("message", (e) => received.push(JSON.parse(e.data)));
    await flush();
    equal(socket.readyState, 1, "open");
    equal(received.map((x) => x.type), ["welcome"], "no implicit end replay");
    c.socket = socket;
    c.received = received;
  });

  await test("Worker delivery count excludes CONNECTING and CLOSING sockets", async () => {
    const connecting = new c.win.WebSocket("wss://worker.mock/ws");
    equal(c.win.__LAB_WORKER_MOCK__.broadcast({ type: "test" }), 1, "only open A");
    connecting.close();
    c.socket.close();
    equal(c.win.__LAB_WORKER_MOCK__.broadcast({ type: "test" }), 0, "closing excluded");
    await flush();
  });

  await test("Worker reset accepts null state and never resurrects a result on reconnect", async () => {
    c.win.__LAB_WORKER_MOCK__.configure({ replayMode: "last-payload", predictionState: {
      currentPrediction: null, lastPredictionPayload: null, predictionHistory: [], currentPredictionStatus: "idle", currentPredictionStage: "idle"
    } });
    const received = [];
    const socket = new c.win.WebSocket("wss://worker.mock/ws");
    socket.addEventListener("message", (e) => received.push(JSON.parse(e.data)));
    await flush();
    equal(received, [], "old end removed");
  });

  await test("Worker does not append parent-recorded history a second time", async () => {
    const p = { type: "channel.prediction.end", subscription: { type: "channel.prediction.end" }, event: { id: "p1", status: "resolved", ended_at: "2026-01-01T00:00:00Z" } };
    c.win.__LAB_WORKER_MOCK__.configure({ replayMode: "full-history", predictionState: { currentPrediction: p.event, lastPredictionPayload: p, predictionHistory: [p], currentPredictionStatus: "resolved", currentPredictionStage: "end" } });
    c.win.dispatchEvent(messageEvent({ source: c.parent, data: { source: "losbroles-widget-lab", type: "WORKER_MOCK_BROADCAST", payload: p, recordPrediction: false } }));
    const received = [];
    const socket = new c.win.WebSocket("wss://worker.mock/ws");
    socket.addEventListener("message", (e) => received.push(JSON.parse(e.data)));
    await flush();
    equal(received, [p], "one history event");
  });

  return results;
}
