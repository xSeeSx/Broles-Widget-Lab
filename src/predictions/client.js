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
