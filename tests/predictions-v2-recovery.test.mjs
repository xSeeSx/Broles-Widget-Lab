import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { normalizePrediction, presentationFor } from "../src/predictions/state.mjs";

const shared = await readFile(new URL("../src/predictions/state.mjs", import.meta.url), "utf8");
const client = await readFile(process.env.RECOVERY_CLIENT_SOURCE || new URL("../src/predictions/client.js", import.meta.url), "utf8");
const START = Date.parse("2026-11-02T12:00:00Z");
const CHANNEL = "133649243";
class Target {
  listeners = new Map();
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); }
}
class Node {
  className = ""; style = { setProperty(name, value) { this[name] = value; } }; dataset = {}; children = []; textContent = "";
  hidden = false; clientWidth = 960; offsetHeight = 70; fields = new Map();
  constructor() {
    const update = (name, on) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); on ? set.add(name) : set.delete(name); this.className = [...set].join(" "); };
    this.classList = { add: (...names) => names.forEach(name => update(name, true)), remove: (...names) => names.forEach(name => update(name, false)),
      contains: name => this.className.split(/\s+/).includes(name), toggle: (name, force) => update(name, force ?? !this.className.split(/\s+/).includes(name)) };
    this.lastChild = { textContent: "" };
  }
  removeAttribute(name) { if (name.startsWith("data-")) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(node) { this.children.push(node); }
  querySelector(selector) { if (!this.fields.has(selector)) this.fields.set(selector, new Node()); return this.fields.get(selector); }
  getAnimations() { return []; }
  get offsetWidth() { return parseFloat(this.style.width) || 40; }
  get offsetLeft() { return parseFloat(this.style.left) || 0; }
  get offsetTop() { return parseFloat(this.style.top) || 50; }
}
function fixture(cached = null) {
  let wall = START, monotonic = 0, identity = 0, timerId = 0;
  const timers = new Map(), intervals = [], sockets = [], writes = [];
  const elements = new Map([".prediction-overlay", ".prediction-children", ".prediction-title-text", ".prediction-time-text"].map(selector => [selector, new Node()]));
  const window = new Target();
  window.SE_API = { store: { get: async () => cached, set: (_key, value) => { writes.push(value); } } };
  const document = Object.assign(new Target(), { querySelector: selector => elements.get(selector), createElement: () => new Node(), hidden: false });
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } static now() { return wall; } }
  class Socket extends Target {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
    readyState = 0; sent = [];
    constructor() { super(); sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent({ type: "open" }); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.dispatchEvent({ type: "close" }); }
  }
  const api = runInNewContext(shared.replace(/^export /gm, "") + "\n" + client + `
    initialize();
    ({ render, requestSync, receive: value => receive(value, socket), get confirmed() { return confirmed; } });
  `, { window, document, performance: { now: () => monotonic }, Date: ClockDate, WebSocket: Socket, URL,
    crypto: { randomUUID: () => "request-" + (++identity) }, console: { warn() {} },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: monotonic + ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: fn => intervals.push(fn), clearInterval() {} });
  const socket = () => sockets.at(-1);
  socket().open();
  const advance = (ms, { freezeMono = false, runTimers = false } = {}) => {
    wall += ms; if (!freezeMono) monotonic += ms;
    if (runTimers) for (const [id, timer] of [...timers]) if (timer.at <= monotonic) { timers.delete(id); timer.fn(); }
  };
  const snapshot = (status = "resolved", { endedAt = wall - 1000, serverNow = wall, requestId, revision = 10, id = "prediction-1" } = {}) => {
    const prediction = normalizePrediction({ id, broadcaster_id: CHANNEL, title: "Resultado de prueba", status: status.toUpperCase(),
      created_at: new Date(START - 60000).toISOString(), locks_at: new Date(START + 300000).toISOString(),
      locked_at: status === "locked" ? new Date(START).toISOString() : null,
      ended_at: ["resolved", "canceled"].includes(status) ? new Date(endedAt).toISOString() : null,
      winning_outcome_id: status === "resolved" ? "one" : null,
      outcomes: [{ id: "one", title: "Uno", users: 2, channel_points: 200 }, { id: "two", title: "Dos", users: 1, channel_points: 100 }] }, { broadcasterId: CHANNEL });
    return { type: "bridge.state", protocol_version: 2, broadcaster_id: CHANNEL, epoch: "epoch-1", revision,
      server_now: new Date(serverNow).toISOString(), sync: { status: "ready" }, prediction, presentation: presentationFor(prediction),
      ...(requestId ? { request_id: requestId } : {}) };
  };
  return { api, window, document, elements, sockets, writes, advance, snapshot, socket, runIntervals: () => intervals.forEach(fn => fn()),
    request: () => socket().sent.at(-1).request_id,
    reply(status, options = {}) { api.receive(snapshot(status, { requestId: socket().sent.at(-1).request_id, ...options })); },
    hidden: () => elements.get(".prediction-overlay").hidden,
    title: () => elements.get(".prediction-title-text").textContent,
    wake: () => window.dispatchEvent({ type: "obsSourceVisibleChanged", detail: { visible: true } }),
    flush: async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); } };
}

test("reload cannot render a queued old result as its first ready packet", () => {
  const f = fixture();
  f.api.receive(f.snapshot("resolved", { endedAt: START - 60000, serverNow: START - 59000 }));
  assert(f.hidden(), "An unsolicited old ready packet must wait for a fresh round trip");
  f.reply("resolved", { endedAt: START - 60000 });
  assert(f.hidden()); assert.equal(f.title(), "");
});
test("a sync reply queued during sleep cannot establish a stale server clock", () => {
  const f = fixture(), oldRequest = f.request();
  f.advance(60000, { freezeMono: true });
  f.api.receive(f.snapshot("resolved", { endedAt: START, serverNow: START + 100, requestId: oldRequest }));
  assert(f.hidden(), "Wall elapsed time must reject the old reply even if performance.now stopped");
  assert.notEqual(f.request(), oldRequest, "Recovery requests a new state");
  f.reply("resolved", { endedAt: START });
  assert(f.hidden());
});
test("returning to a scene does not briefly redraw an active state that missed the end", () => {
  const f = fixture(); f.reply("active"); assert(!f.hidden());
  f.advance(30000); f.wake();
  assert(f.hidden(), "Hide the local copy before waiting for current server state");
  f.api.receive(f.snapshot("active")); assert(f.hidden(), "Uncorrelated ready packets cannot release the wake barrier");
  f.reply("resolved", { endedAt: START + 1000, revision: 11 });
  assert(f.hidden()); assert.equal(f.title(), "");
});
test("a paused monotonic clock cannot strand a visible terminal result", () => {
  const f = fixture(); f.reply("resolved"); assert(!f.hidden());
  f.advance(60000, { freezeMono: true }); f.api.render();
  assert(f.hidden(), "Detect clock divergence and hide until a fresh verification");
  f.reply("resolved", { endedAt: START - 1000 }); assert(f.hidden());
});
test("deadline cleanup runs after a disconnect without CSS events", () => {
  const f = fixture(); f.reply("resolved"); assert(!f.hidden());
  f.socket().close(); f.advance(12000, { runTimers: true });
  assert(f.hidden()); assert.equal(f.title(), "");
  assert.equal(f.elements.get(".prediction-children").children.length, 0);
});
test("a recent verified result resumes the original deadline rather than restarting it", () => {
  const f = fixture(), endedAt = START - 4000;
  f.reply("resolved", { endedAt }); const deadline = f.elements.get(".prediction-overlay").dataset.hideAt;
  f.wake(); f.advance(200); f.reply("resolved", { endedAt });
  assert(!f.hidden()); assert.equal(f.elements.get(".prediction-overlay").dataset.hideAt, deadline);
  f.advance(7500, { runTimers: true }); assert(f.hidden());
});
test("shared storage by itself cannot resurrect a recent result", async () => {
  const producer = fixture(); const cached = { schemaVersion: 2, snapshot: producer.snapshot() };
  const f = fixture(cached); await f.flush();
  assert(f.hidden()); assert.equal(f.title(), "");
});
test("duplicate OBS wake events coalesce into one current verification", () => {
  const f = fixture(); f.reply("active"); const before = f.socket().sent.length;
  f.wake(); f.window.dispatchEvent({ type: "obsSourceActiveChanged", detail: { active: true } });
  assert.equal(f.socket().sent.length, before + 1);
  f.reply("active"); assert(!f.hidden());
});
test("a fresh syncing reply can verify time without making its persisted result visible", () => {
  const f = fixture(); const syncing = f.snapshot("resolved", { requestId: f.request(), endedAt: START - 60000 });
  syncing.sync.status = "syncing"; f.api.receive(syncing); assert(f.hidden());
  f.api.receive(f.snapshot("active", { revision: 11 })); assert(!f.hidden(), "Fresh upstream ready may follow the verified handshake");
});
test("a missing first reply is retried and does not leave the source hidden forever", () => {
  const f = fixture(), firstRequest = f.request();
  f.advance(5001); f.runIntervals();
  assert.notEqual(f.request(), firstRequest);
  f.reply("active"); assert(!f.hidden());
});
test("first verification also retries when the monotonic clock remains paused", () => {
  const f = fixture(), firstRequest = f.request();
  f.advance(60000, { freezeMono: true }); f.runIntervals();
  assert.notEqual(f.request(), firstRequest);
  f.reply("active"); assert(!f.hidden());
});
test("an obsolete slow reply cannot blank a state already verified by a newer reply", () => {
  const f = fixture(); f.reply("active");
  f.api.requestSync(true); const oldRequest = f.request();
  f.advance(6000); f.api.requestSync(true); f.reply("active");
  assert(!f.hidden());
  f.api.receive(f.snapshot("active", { requestId: oldRequest }));
  assert(!f.hidden());
});
test("expired cancellations also stay hidden after source recreation", () => {
  const f = fixture(); f.reply("canceled", { endedAt: START - 60000 });
  assert(f.hidden()); assert.equal(f.title(), "");
});
