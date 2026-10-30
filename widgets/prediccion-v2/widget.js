// Generated, self-contained StreamElements JS tab. Run node scripts/build-predictions.mjs.
(() => {
// Shared by the production bridge, the copyable widget and the laboratory.
const PROTOCOL_VERSION = 2;
const POLICY = Object.freeze({ version: 1, lockMs: 15000, resultMs: 10000 });
const terminal = (status) => status === "resolved" || status === "canceled";
const rank = (status) => terminal(status) ? 2 : status === "locked" ? 1 : 0;
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

// Twitch timestamps contain nanoseconds. Date.parse alone loses their ordering.
function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(match[1] + match[3]);
  return Number.isFinite(seconds) ? BigInt(seconds) * 1000000n + BigInt((match[2] || "").padEnd(9, "0")) : null;
}
function compareTime(left, right) {
  const a = timestamp(left), b = timestamp(right);
  if (a === null || b === null) return null;
  return a === b ? 0 : a > b ? 1 : -1;
}
const date = (value) => timestamp(value) === null ? null : value;
const count = (value) => value === null || value === undefined ? null : Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

function normalizePrediction(raw, { type = "helix", previous = null, broadcasterId } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("prediction_missing");
  const same = previous?.id === raw.id ? previous : null;
  const channel = String(raw.broadcaster_id || raw.broadcaster_user_id || broadcasterId || "");
  if (!text(raw.id) || !channel || (broadcasterId && channel !== String(broadcasterId))) throw new Error("prediction_identity");
  const stage = type.replace("channel.prediction.", "");
  const status = ["begin", "progress"].includes(stage) ? "active" : stage === "lock" ? "locked" : String(raw.status || "").toLowerCase();
  if (!["active", "locked", "resolved", "canceled"].includes(status)) throw new Error("prediction_status");
  const createdAt = date(raw.created_at || raw.started_at) || same?.created_at;
  let locksAt = date(raw.locks_at) || same?.locks_at || null;
  if (!locksAt && createdAt && Number.isInteger(raw.prediction_window) && raw.prediction_window > 0) {
    locksAt = new Date(Date.parse(createdAt) + raw.prediction_window * 1000).toISOString();
  }
  const lockedAt = date(raw.locked_at) || same?.locked_at || null;
  const endedAt = date(raw.ended_at) || same?.ended_at || null;
  if (!createdAt || !text(raw.title, 500) || (status === "active" && !locksAt) || (status === "locked" && !lockedAt) || (terminal(status) && !endedAt)) throw new Error("prediction_dates_or_title");
  if ((locksAt && compareTime(locksAt, createdAt) < 0) || (lockedAt && compareTime(lockedAt, createdAt) < 0) || (endedAt && compareTime(endedAt, createdAt) < 0)) throw new Error("prediction_date_order");
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length < 2 || raw.outcomes.length > 10) throw new Error("prediction_outcomes");
  const ids = new Set();
  const outcomes = raw.outcomes.map((outcome) => {
    if (!text(outcome.id) || !text(outcome.title, 500) || ids.has(outcome.id)) throw new Error("prediction_outcome_identity");
    ids.add(outcome.id);
    const known = same?.outcomes.find((item) => item.id === outcome.id);
    return {
      id: outcome.id, title: outcome.title,
      color: String(outcome.color || known?.color || "blue").toLowerCase() === "pink" ? "pink" : "blue",
      users: count(outcome.users) ?? known?.users ?? null,
      channel_points: count(outcome.channel_points) ?? known?.channel_points ?? null,
      top_predictors: Array.isArray(outcome.top_predictors) ? copy(outcome.top_predictors) : copy(known?.top_predictors || [])
    };
  });
  const winner = status === "resolved" ? raw.winning_outcome_id : null;
  if (status === "resolved" && !ids.has(winner)) throw new Error("prediction_winner");
  return { id: raw.id, broadcaster_id: channel, title: raw.title, status,
    created_at: createdAt, locks_at: locksAt, locked_at: lockedAt, ended_at: endedAt,
    winning_outcome_id: winner, outcomes };
}

function reducePrediction(previous, next) {
  if (!previous) return { accepted: true, prediction: copy(next) };
  if (!next) return { accepted: true, prediction: null };
  if (next.id !== previous.id) {
    if (compareTime(next.created_at, previous.created_at) !== 1) return { accepted: false, reason: "older_prediction" };
    return { accepted: true, prediction: copy(next) };
  }
  if (compareTime(next.created_at, previous.created_at) !== 0 || next.title !== previous.title ||
      next.outcomes.map((x) => x.id).join("\n") !== previous.outcomes.map((x) => x.id).join("\n")) {
    return { accepted: false, reason: "immutable_prediction" };
  }
  if (rank(next.status) < rank(previous.status) || (terminal(previous.status) && next.status !== previous.status)) return { accepted: false, reason: "state_regression" };
  if (terminal(previous.status) && (compareTime(next.ended_at, previous.ended_at) !== 0 || next.winning_outcome_id !== previous.winning_outcome_id)) return { accepted: false, reason: "terminal_conflict" };
  const prediction = copy(next);
  prediction.locks_at = previous.locks_at || next.locks_at;
  prediction.locked_at = previous.locked_at || next.locked_at;
  for (const outcome of prediction.outcomes) {
    const known = previous.outcomes.find((x) => x.id === outcome.id);
    for (const key of ["users", "channel_points"]) {
      if (known[key] !== null && (outcome[key] === null || outcome[key] < known[key])) outcome[key] = known[key];
    }
  }
  return { accepted: true, prediction };
}

function presentationFor(prediction) {
  const after = (value, ms) => value ? new Date(Date.parse(value) + ms).toISOString() : null;
  return { policy_version: POLICY.version,
    lock_hide_at: prediction ? after(prediction.locked_at || prediction.locks_at, POLICY.lockMs) : null,
    result_hide_at: prediction && terminal(prediction.status) ? after(prediction.ended_at, POLICY.resultMs) : null };
}

function validateSnapshot(raw, broadcasterId) {
  if (raw?.type !== "bridge.state" || raw.protocol_version !== PROTOCOL_VERSION ||
      raw.broadcaster_id !== String(broadcasterId) || !text(raw.epoch) ||
      !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !date(raw.server_now) ||
      !["ready", "syncing", "degraded", "auth_required"].includes(raw.sync?.status)) throw new Error("snapshot_invalid");
  const prediction = raw.prediction === null ? null : normalizePrediction(raw.prediction, { broadcasterId });
  // The bridge owns this fixed policy; a replay cannot extend a result's lifetime.
  return { type: "bridge.state", protocol_version: PROTOCOL_VERSION, broadcaster_id: String(broadcasterId),
    epoch: raw.epoch, revision: raw.revision, server_now: raw.server_now,
    sync: copy(raw.sync), prediction, presentation: presentationFor(prediction),
    ...(typeof raw.request_id === "string" ? { request_id: raw.request_id } : {}) };
}

function viewAt(snapshot, now) {
  const prediction = snapshot?.prediction;
  if (!prediction) return { visible: false, phase: "idle", seconds: 0, resultStep: 0 };
  if (terminal(prediction.status)) {
    const age = now - Date.parse(prediction.ended_at);
    return { visible: age >= -5000 && age < POLICY.resultMs, phase: prediction.status,
      seconds: 0, resultStep: age >= 5000 ? 2 : age >= 3000 ? 1 : 0,
      hideAt: Date.parse(snapshot.presentation.result_hide_at) };
  }
  const locksAt = Date.parse(prediction.locks_at);
  if (prediction.status === "locked" || now >= locksAt) {
    const hideAt = Date.parse(snapshot.presentation.lock_hide_at);
    return { visible: Number.isFinite(hideAt) && now < hideAt, phase: "locked", seconds: 0, resultStep: 0, hideAt };
  }
  return { visible: true, phase: "active", seconds: Math.max(0, Math.ceil((locksAt - now) / 1000)), resultStep: 0, hideAt: null };
}

// A bounded, persistable reducer. Network I/O and storage commits remain in the bridge.
function eventTransition(model, payload, broadcasterId) {
  const type = payload?.subscription?.type || payload?.type;
  if (!["begin", "progress", "lock", "end"].some((stage) => type === `channel.prediction.${stage}`)) return { accepted: false, reason: "event_type" };
  const id = payload.metadata?.message_id;
  const at = payload.metadata?.message_timestamp;
  if (!text(id) || timestamp(at) === null) return { accepted: false, reason: "event_metadata" };
  if ((model.seen || []).includes(id)) return { accepted: false, reason: "duplicate_event" };
  let prediction;
  try { prediction = normalizePrediction(payload.event, { type, previous: model.prediction, broadcasterId }); }
  catch (error) { return { accepted: false, reason: error.message }; }
  if (model.cursor?.prediction_id === prediction.id && compareTime(at, model.cursor.at) !== 1) return { accepted: false, reason: "older_event" };
  if (!model.prediction && model.watermark && compareTime(prediction.created_at, model.watermark) !== 1) return { accepted: false, reason: "older_prediction" };
  const result = reducePrediction(model.prediction, prediction);
  if (!result.accepted) return result;
  return { accepted: true, model: { ...copy(model), prediction: result.prediction,
    watermark: prediction.created_at, cursor: { prediction_id: prediction.id, at },
    seen: [...(model.seen || []), id].slice(-512) } };
}

// Concatenated with the shared reducer by scripts/build-predictions.mjs.
const DEFAULT_URL = "wss://losbroles.lessergio.workers.dev/ws/v2?broadcaster_id=133649243";
const CHANNEL = "133649243";
const STORE_KEY = "brolesPredictions133649243v2";
const overlay = document.querySelector(".prediction-overlay");
const children = document.querySelector(".prediction-children");
const title = document.querySelector(".prediction-title-text");
const clock = document.querySelector(".prediction-time-text");
const mono = () => performance.now();
let snapshot = null;
let confirmed = false;
let socket = null;
let endpoint = DEFAULT_URL;
let generation = 0;
let retry = null;
let retryAttempt = 0;
let tickTimer = null;
let writeTimer = null;
let pendingWrite = null;
let written = "";
let cacheCandidate = null;
let clockAnchor = null;
let lastMessage = 0;
let lastSync = -Infinity;
let lastView = "";
let loaded = false;
const requests = new Map();
const retiredEpochs = new Set();
const nodes = new Map();
const warn = (code) => console.warn("[Predicciones v2] " + code);
const serverNow = () => clockAnchor ? clockAnchor.server + mono() - clockAnchor.local : Date.now();

function hide() {
  overlay.hidden = true;
  overlay.className = "prediction-overlay";
  overlay.removeAttribute("data-prediction-id");
  title.textContent = "";
  clock.textContent = "";
  children.replaceChildren();
  nodes.clear();
  lastView = "";
}

function createOutcome(outcome) {
  const node = document.createElement("div");
  node.className = "prediction-child";
  node.dataset.outcomeId = outcome.id;
  // Only this fixed template is HTML. All Twitch titles and numbers use textContent.
  node.innerHTML = '<div class="progress-bar-stats"><div class="progress-bar-text"></div></div><div class="progress-bar"><div class="prediction-outcome"></div><div class="progress-bar-percent-text"></div></div><div class="progress-bar-metrics"><span class="progress-bar-users-text"></span><span class="multiplier-text"></span></div>';
  children.append(node);
  nodes.set(outcome.id, node);
  return node;
}

function render() {
  clearTimeout(tickTimer);
  if (!snapshot || !confirmed) { hide(); return; }
  const now = serverNow();
  const view = viewAt(snapshot, now);
  if (!view.visible) { hide(); return; }
  const prediction = snapshot.prediction;
  const key = prediction.id + ":" + view.phase;
  const entering = overlay.hidden || overlay.dataset.predictionId !== prediction.id;
  if (overlay.dataset.predictionId !== prediction.id) { children.replaceChildren(); nodes.clear(); }
  overlay.hidden = false;
  overlay.dataset.predictionId = prediction.id;
  overlay.dataset.phase = view.phase;
  overlay.dataset.revision = String(snapshot.revision);
  overlay.dataset.hideAt = view.hideAt ? String(view.hideAt) : "";
  // A duplicated result updates its data but never restarts its animation or deadline.
  if (entering || key !== lastView) {
    overlay.className = "prediction-overlay";
    if (entering) overlay.classList.add("fadeIn");
  }
  lastView = key;
  overlay.classList.toggle("is-exiting", Boolean(view.hideAt && now >= view.hideAt - 400));
  overlay.classList.toggle("is-many", prediction.outcomes.length > 5);
  const prefix = view.phase === "resolved" ? "🏆 " : view.phase === "canceled" ? "Cancelada: " : view.phase === "locked" ? "🛑 " : "";
  title.textContent = prefix + prediction.title + (view.phase === "resolved" ? " 🏆" : "");
  clock.hidden = view.phase !== "active";
  clock.textContent = String(Math.floor(view.seconds / 60)).padStart(2, "0") + ":" + String(view.seconds % 60).padStart(2, "0");
  const known = prediction.outcomes.every((outcome) => outcome.channel_points !== null);
  const total = prediction.outcomes.reduce((sum, outcome) => sum + (outcome.channel_points || 0), 0);
  const available = Math.max(0, children.clientWidth - (prediction.outcomes.length - 1) * 10);
  const minimum = Math.min(96, available / prediction.outcomes.length);
  const percents = prediction.outcomes.map((outcome) => !known || total === 0 ? 100 / prediction.outcomes.length : outcome.channel_points / total * 100);
  const remaining = Math.max(0, available - minimum * prediction.outcomes.length);
  // Reserved readable minima and a proportional remainder always fit, even with ten options.
  prediction.outcomes.forEach((outcome, index) => {
    const node = nodes.get(outcome.id) || createOutcome(outcome);
    const winning = outcome.id === prediction.winning_outcome_id;
    node.classList.toggle("is-loser", view.phase === "resolved" && view.resultStep >= 1 && !winning);
    node.classList.toggle("is-winner", view.phase === "resolved" && view.resultStep >= 2 && winning);
    node.classList.toggle("is-collapsed", view.phase === "resolved" && view.resultStep >= 2 && !winning);
    node.style.width = (view.phase === "resolved" && view.resultStep >= 2 ? winning ? children.clientWidth : 0 : minimum + remaining * percents[index] / 100) + "px";
    node.querySelector(".progress-bar-text").textContent = outcome.title;
    node.querySelector(".prediction-outcome").style.backgroundColor = ["#ffbb00", "#0f63ff", "#ff0000"][index % 3];
    node.querySelector(".progress-bar-percent-text").textContent = known ? Math.round(percents[index]) + "%" : "…";
    node.querySelector(".progress-bar-users-text").textContent = "♙ " + (outcome.users === null ? "…" : outcome.users.toLocaleString("es-ES"));
    const multiplier = total > 0 && outcome.channel_points > 0 ? total / outcome.channel_points : null;
    node.querySelector(".multiplier-text").textContent = multiplier === null ? "" : "×" + multiplier.toFixed(1);
  });
  // This timer belongs to the renderer, never to a particular socket or CSS animation.
  tickTimer = setTimeout(render, view.hideAt ? Math.max(1, Math.min(250, view.hideAt - now)) : 250);
  if (view.phase === "locked" && prediction.status === "active") requestSync();
}

function writeCache(next, immediate) {
  const identity = next.epoch + ":" + next.revision;
  if (identity === written) return;
  pendingWrite = copy(next);
  clearTimeout(writeTimer);
  const flush = () => {
    writeTimer = null;
    const candidate = pendingWrite;
    pendingWrite = null;
    if (!candidate || !window.SE_API?.store) return;
    written = candidate.epoch + ":" + candidate.revision;
    try {
      const result = window.SE_API.store.set(STORE_KEY, { schemaVersion: 2, snapshot: candidate });
      // set is not an acknowledgement protocol. Some environments return nothing.
      if (result && typeof result.catch === "function") result.catch(() => { written = ""; warn("storage_write_failed"); });
    } catch { written = ""; warn("storage_write_failed"); }
  };
  if (immediate) flush(); else writeTimer = setTimeout(flush, 1000);
}

function receive(raw, activeSocket) {
  if (activeSocket !== socket) return;
  if (raw?.type !== "bridge.state") {
    if (raw?.type === "bridge.error") warn("bridge_degraded");
    return;
  }
  let next;
  try { next = validateSnapshot(raw, CHANNEL); } catch (error) { warn(error.message); requestSync(); return; }
  lastMessage = mono();
  if (snapshot?.epoch === next.epoch && next.revision < snapshot.revision) return;
  if (retiredEpochs.has(next.epoch)) return;
  // The first visible state must be verified by the bridge during this session.
  // Storage provides a shared candidate, never authority to resurrect a result.
  if (next.sync.status === "syncing" || (!confirmed && next.sync.status !== "ready")) return;
  if (snapshot && snapshot.epoch !== next.epoch) {
    if (next.sync.status !== "ready") return;
    retiredEpochs.add(snapshot.epoch);
    if (retiredEpochs.size > 8) retiredEpochs.delete(retiredEpochs.values().next().value);
  }
  let latency = 0;
  const sent = requests.get(next.request_id);
  if (sent !== undefined) {
    const rtt = mono() - sent;
    requests.delete(next.request_id);
    if (rtt >= 0 && rtt <= 10000) latency = rtt / 2;
  }
  clockAnchor = { server: Date.parse(next.server_now) + latency, local: mono() };
  const previous = snapshot;
  snapshot = next;
  confirmed = true;
  cacheCandidate = null;
  render();
  const transition = previous?.prediction?.id !== next.prediction?.id || previous?.prediction?.status !== next.prediction?.status || !previous || previous.epoch !== next.epoch;
  if (next.sync.status === "ready") writeCache(next, transition);
}

function requestSync(force = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN || (!force && mono() - lastSync < 5000)) return;
  const requestId = (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random());
  requests.set(requestId, mono());
  if (requests.size > 8) requests.delete(requests.keys().next().value);
  lastSync = mono();
  socket.send(JSON.stringify({ type: "bridge.sync", protocol_version: 2, request_id: requestId, known_epoch: snapshot?.epoch || cacheCandidate?.epoch || null, known_revision: snapshot?.revision ?? cacheCandidate?.revision ?? null }));
}

function connect() {
  clearTimeout(retry);
  retry = null;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const activeGeneration = generation;
  let activeSocket;
  try { activeSocket = new WebSocket(endpoint); } catch { scheduleReconnect(); return; }
  socket = activeSocket;
  lastMessage = mono();
  activeSocket.addEventListener("open", () => {
    if (activeSocket !== socket || activeGeneration !== generation) return;
    lastMessage = mono();
    lastSync = -Infinity;
    requestSync(true);
  });
  activeSocket.addEventListener("message", (event) => {
    if (activeSocket !== socket || activeGeneration !== generation) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { warn("bridge_json_invalid"); return; }
    receive(payload, activeSocket);
    if (payload.type === "bridge.state" && payload.sync?.status === "ready") retryAttempt = 0;
  });
  activeSocket.addEventListener("close", () => {
    if (activeSocket !== socket || activeGeneration !== generation) return;
    socket = null;
    requests.clear();
    // Keep deadline cleanup alive across a disconnect.
    render();
    scheduleReconnect();
  });
  activeSocket.addEventListener("error", () => {
    if (activeSocket !== socket) return;
    warn("bridge_connection_failed");
    try { activeSocket.close(); } catch { socket = null; scheduleReconnect(); }
  });
}
function scheduleReconnect() {
  if (retry) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(retryAttempt++, 5)) * (0.8 + Math.random() * 0.4);
  retry = setTimeout(connect, delay);
}

function readCache() {
  if (!window.SE_API?.store) return;
  Promise.resolve().then(() => window.SE_API.store.get(STORE_KEY)).then((cached) => {
    if (cached?.schemaVersion !== 2 || confirmed) return;
    try { cacheCandidate = validateSnapshot(cached.snapshot, CHANNEL); } catch { warn("storage_cache_invalid"); }
  }).catch(() => warn("storage_read_failed"));
}
function initialize(fields = {}) {
  let nextUrl;
  try {
    nextUrl = new URL(fields.workerUrl || DEFAULT_URL);
    if (nextUrl.protocol !== "wss:" || nextUrl.username || nextUrl.password) throw new Error("invalid_url");
    nextUrl.searchParams.set("broadcaster_id", CHANNEL);
  } catch { warn("worker_url_invalid"); return; }
  if (loaded && nextUrl.href === endpoint) return;
  loaded = true;
  endpoint = nextUrl.href;
  generation += 1;
  const oldSocket = socket;
  socket = null;
  if (oldSocket) try { oldSocket.close(1000, "configuration_changed"); } catch {}
  clearTimeout(retry);
  retry = null;
  clearTimeout(writeTimer);
  pendingWrite = null;
  requests.clear();
  retiredEpochs.clear();
  snapshot = null;
  confirmed = false;
  clockAnchor = null;
  written = "";
  retryAttempt = 0;
  hide();
  readCache();
  connect();
}
window.addEventListener("onWidgetLoad", (event) => initialize(event.detail?.fieldData));
window.addEventListener("onEventReceived", (event) => {
  const value = event.detail?.event?.data;
  if (event.detail?.listener !== "kvstore:update" || value?.key !== "customWidget." + STORE_KEY || value.value?.schemaVersion !== 2) return;
  let cached;
  try { cached = validateSnapshot(value.value.snapshot, CHANNEL); } catch { return; }
  if (snapshot && (cached.epoch !== snapshot.epoch || cached.revision > snapshot.revision)) requestSync();
  // Never echo a KV event back to storage or let it override a confirmed server revision.
});
function wake() {
  render();
  if (!loaded) return;
  if (!socket || socket.readyState === WebSocket.CLOSED) connect();
  else requestSync(true);
}
window.addEventListener("pageshow", wake);
window.addEventListener("online", wake);
window.addEventListener("obsSourceVisibleChanged", wake);
window.addEventListener("obsSourceActiveChanged", wake);
window.addEventListener("resize", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
setInterval(() => {
  if (!loaded) return;
  if (socket?.readyState === WebSocket.OPEN && mono() - lastMessage > 70000) {
    try { socket.close(1000, "heartbeat_timeout"); } catch {}
  } else if (socket?.readyState === WebSocket.OPEN && mono() - lastSync > 30000) requestSync();
  else if (socket?.readyState === WebSocket.CONNECTING && mono() - lastMessage > 15000) {
    try { socket.close(); } catch {}
  }
}, 5000);
hide();

})();
