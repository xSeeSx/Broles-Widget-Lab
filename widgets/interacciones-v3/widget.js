// Generated, self-contained StreamElements JS tab. Run node scripts/build-interactions.mjs.
(() => {
// Shared by the production bridge, the copyable widget and the laboratory.
const PROTOCOL_VERSION = 2;
// Original visual sequence: 0.5s entrance, then 3s/5s/10s milestones,
// followed by the 0.7s exit. All milestones stay anchored to Twitch timestamps.
const POLICY = Object.freeze({ version: 2, entryMs: 500,
  fadeLosersAtMs: 3500, expandWinnerAtMs: 5500,
  lockExitAtMs: 15000, lockMs: 15700, resultExitAtMs: 10500, resultMs: 11200,
  exitMs: 700, barsExitMs: 400 });
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
      seconds: 0, resultStep: age >= POLICY.expandWinnerAtMs ? 2 : age >= POLICY.fadeLosersAtMs ? 1 : 0,
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


const POLL_TYPES = ["begin", "progress", "end"].map(stage => "channel.poll." + stage);
const pollFinal = status => ["completed", "terminated", "archived", "moderated", "invalid"].includes(status);
const pollHidden = status => ["archived", "moderated", "invalid"].includes(status);
const pollDate = value => timestamp(value) === null ? null : value;
const pollCount = value => value == null ? null : Number.isSafeInteger(value) && value >= 0 ? value : null;
const pollText = (value, max = 500) => typeof value === "string" && value.length > 0 && value.length <= max;

function normalizePoll(raw, { type = "helix", previous = null, broadcasterId } = {}) {
  if (!raw || !pollText(raw.id)) throw new Error("poll_identity");
  const same = previous?.id === raw.id ? previous : null;
  const channel = String(raw.broadcaster_id || raw.broadcaster_user_id || broadcasterId || "");
  if (!channel || (broadcasterId && channel !== String(broadcasterId))) throw new Error("poll_channel");
  const status = ["channel.poll.begin", "channel.poll.progress"].includes(type) ? "active" : String(raw.status || "").toLowerCase();
  if (!["active", "completed", "terminated", "archived", "moderated", "invalid"].includes(status)) throw new Error("poll_status");
  const startedAt = pollDate(raw.started_at) || same?.started_at;
  const endedAt = pollDate(raw.ended_at) || same?.ended_at || null;
  let endsAt = pollDate(raw.ends_at) || same?.ends_at || null;
  if (!endsAt && startedAt && Number.isInteger(raw.duration) && raw.duration > 0) endsAt = new Date(Date.parse(startedAt) + raw.duration * 1000).toISOString();
  // EventSub end omits ends_at and duration. It must also work after a cold start.
  if (!endsAt && pollFinal(status)) endsAt = endedAt;
  if (!startedAt || !endsAt || !pollText(raw.title) || (pollFinal(status) && !endedAt) ||
      compareTime(endsAt, startedAt) < 0 || (endedAt && compareTime(endedAt, startedAt) < 0)) throw new Error("poll_dates_or_title");
  if (!Array.isArray(raw.choices) || raw.choices.length < 2 || raw.choices.length > 5) throw new Error("poll_choices");
  const choices = raw.choices.map(choice => {
    if (!pollText(choice.id) || !pollText(choice.title)) throw new Error("poll_choice");
    return { id: choice.id, title: choice.title, votes: pollCount(choice.votes) };
  });
  if (new Set(choices.map(choice => choice.id)).size !== choices.length || (pollFinal(status) && !pollHidden(status) && choices.some(choice => choice.votes === null))) throw new Error("poll_counts_or_ids");
  return { id: raw.id, broadcaster_id: channel, title: raw.title, status, started_at: startedAt, ends_at: endsAt, ended_at: endedAt, choices };
}

function reducePoll(previous, next) {
  if (!next) return { accepted: true, poll: null };
  if (!previous || previous.id !== next.id) {
    if (previous && compareTime(next.started_at, previous.started_at) !== 1) return { accepted: false, reason: "older_poll" };
    return { accepted: true, poll: copy(next) };
  }
  if (compareTime(next.started_at, previous.started_at) !== 0 || next.title !== previous.title ||
      next.choices.map(x => x.id + ":" + x.title).join("\n") !== previous.choices.map(x => x.id + ":" + x.title).join("\n")) return { accepted: false, reason: "immutable_poll" };
  if ((pollFinal(previous.status) && !pollFinal(next.status)) || (pollHidden(previous.status) && !pollHidden(next.status))) return { accepted: false, reason: "poll_regression" };
  if (pollFinal(previous.status) && !pollHidden(next.status) && (next.status !== previous.status || compareTime(next.ended_at, previous.ended_at) !== 0)) return { accepted: false, reason: "poll_terminal_conflict" };
  const poll = copy(next);
  poll.ends_at = previous.ends_at;
  poll.ended_at = previous.ended_at || next.ended_at;
  for (const choice of poll.choices) {
    const known = previous.choices.find(x => x.id === choice.id);
    // Confirmed final totals are authoritative, including any Twitch corrections.
    if (!pollFinal(poll.status) && known.votes !== null && (choice.votes === null || choice.votes < known.votes)) choice.votes = known.votes;
  }
  return { accepted: true, poll };
}

function pollEventTransition(model, payload, broadcasterId) {
  const type = payload?.subscription?.type || payload?.type;
  if (!POLL_TYPES.includes(type)) return { accepted: false, reason: "event_type" };
  const id = payload.metadata?.message_id, at = payload.metadata?.message_timestamp;
  if (!pollText(id) || timestamp(at) === null) return { accepted: false, reason: "event_metadata" };
  if ((model.poll_seen || []).includes(id)) return { accepted: false, reason: "duplicate_event" };
  let poll;
  try { poll = normalizePoll(payload.event, { type, previous: model.poll, broadcasterId }); }
  catch (error) { return { accepted: false, reason: error.message }; }
  if (model.poll_cursor?.poll_id === poll.id && compareTime(at, model.poll_cursor.at) !== 1) return { accepted: false, reason: "older_event" };
  if (!model.poll && model.poll_watermark && compareTime(poll.started_at, model.poll_watermark) !== 1) return { accepted: false, reason: "older_poll" };
  const result = reducePoll(model.poll, poll);
  if (!result.accepted) return result;
  return { accepted: true, model: { ...copy(model), poll: result.poll, poll_watermark: poll.started_at,
    poll_cursor: { poll_id: poll.id, at }, poll_seen: [...(model.poll_seen || []), id].slice(-512) } };
}

function pollViewAt(poll, now) {
  if (!poll || pollHidden(poll.status)) return { visible: false, phase: "idle", seconds: 0, resultStep: 0 };
  if (pollFinal(poll.status)) {
    const age = now - Date.parse(poll.ended_at), hideAt = Date.parse(poll.ended_at) + POLICY.resultMs;
    return { visible: age >= -5000 && now < hideAt, phase: "resolved", seconds: 0,
      resultStep: age >= POLICY.expandWinnerAtMs ? 2 : age >= POLICY.fadeLosersAtMs ? 1 : 0, hideAt };
  }
  const end = Date.parse(poll.ends_at);
  // Wait briefly for confirmed final counts, never turn provisional votes into a winner.
  return { visible: now < end + 5000, phase: now >= end ? "awaiting" : "active",
    seconds: Math.max(0, Math.ceil((end - now) / 1000)), resultStep: 0, hideAt: null };
}

function pollWinners(poll) {
  if (!poll || !["completed", "terminated"].includes(poll.status)) return [];
  const highest = Math.max(...poll.choices.map(choice => choice.votes || 0));
  return highest > 0 ? poll.choices.filter(choice => choice.votes === highest).map(choice => choice.id) : [];
}

function validateInteractionSnapshot(raw, broadcasterId) {
  if (raw?.protocol_version !== 3 || !["ready", "syncing", "degraded", "auth_required", "disabled"].includes(raw.poll_sync?.status)) throw new Error("interaction_snapshot_invalid");
  const base = validateSnapshot({ ...raw, protocol_version: 2 }, broadcasterId);
  return { ...base, protocol_version: 3, poll_sync: copy(raw.poll_sync),
    poll: raw.poll === null ? null : normalizePoll(raw.poll, { broadcasterId }) };
}

function selectInteraction(snapshot, now) {
  const predictionView = viewAt(snapshot, now);
  if (snapshot?.sync?.last_verified_at && snapshot?.sync?.status !== "syncing" && snapshot?.sync?.status !== "auth_required" && predictionView.visible) {
    return { kind: "prediction", entity: snapshot.prediction, view: predictionView, winners: [snapshot.prediction.winning_outcome_id].filter(Boolean) };
  }
  const view = pollViewAt(snapshot?.poll, now);
  if (!snapshot?.poll_sync?.last_verified_at || ["syncing", "auth_required", "disabled"].includes(snapshot?.poll_sync?.status) || !view.visible) return null;
  const poll = snapshot.poll;
  return { kind: "poll", view, winners: pollWinners(poll), entity: {
    ...poll, locks_at: poll.ends_at, outcomes: poll.choices.map(choice => ({ ...choice, users: choice.votes, channel_points: choice.votes }))
  } };
}

// Concatenated with the shared reducer by scripts/build-predictions.mjs.
const DEFAULT_URL = "wss://losbroles.lessergio.workers.dev/ws/v3?broadcaster_id=133649243";
const CHANNEL = "133649243";
const STORE_KEY = "brolesInteractions133649243v3";
const MAX_SYNC_AGE_MS = 5000;
// Local choreography, independent of the bridge protocol and absolute expiry.
const RESULT_MOTION = Object.freeze({ fadeMs: 800, overlapMs: 250, expandMs: 1000 });
const winnerStartsAtMs = POLICY.fadeLosersAtMs + RESULT_MOTION.fadeMs - RESULT_MOTION.overlapMs;
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
let fontsReady = !document.fonts?.load;
const requests = new Map();
const retiredEpochs = new Set();
const nodes = new Map();
const warn = code => { if (typeof console !== "undefined") console.warn?.("[Interacciones v3] " + code); };
const serverNow = () => clockAnchor ? clockAnchor.server + mono() - clockAnchor.local : Date.now();

function requestAge(sent) {
  if (!sent) return Infinity;
  const elapsed = mono() - sent.local, wallElapsed = Date.now() - sent.wall;
  return elapsed < 0 || wallElapsed < 0 ? Infinity : Math.max(elapsed, wallElapsed);
}
function clockDiscontinuity() {
  return clockAnchor && Math.abs((Date.now() - clockAnchor.wall) - (mono() - clockAnchor.local)) > 1000;
}
function verifyCurrentState() {
  const pending = [...requests.values()].some(sent => requestAge(sent) <= MAX_SYNC_AGE_MS);
  // A wake-up never paints the old local copy first. Keep one current request
  // when OBS emits visibility and activity events together.
  if (confirmed || clockAnchor || !pending) {
    confirmed = false;
    clockAnchor = null;
    requests.clear();
    hide();
  }
  if (!loaded) return;
  if (!socket || [WebSocket.CLOSED, WebSocket.CLOSING].includes(socket.readyState)) connect();
  else if (![...requests.values()].some(sent => requestAge(sent) <= MAX_SYNC_AGE_MS)) requestSync(true);
}

function prepareFonts() {
  if (fontsReady) return;
  const finish = () => {
    if (fontsReady) return;
    fontsReady = true;
    clearTimeout(timeout);
    render();
  };
  const timeout = setTimeout(() => { warn("fonts_loading_timeout"); finish(); }, 2000);
  // Loading before the first visible snapshot also makes recovery geometry
  // use Manrope and the original icons, rather than freezing a fallback font.
  Promise.allSettled([
    document.fonts.load('600 18px Manrope'),
    document.fonts.load('800 16px Manrope'),
    document.fonts.load('400 12px "Font Awesome 6 Free"', "\uf005\uf007")
  ]).then((results) => {
    if (fontsReady) return;
    if (results.some((item) => item.status === "rejected" || !item.value?.length)) warn("fonts_unavailable");
    finish();
  });
}

function hide() {
  overlay.hidden = true;
  overlay.className = "prediction-overlay";
  overlay.removeAttribute("data-prediction-id");
  title.textContent = "";
  clock.textContent = "";
  clock.classList.remove("heartbeat");
  children.replaceChildren();
  nodes.clear();
  children.style.height = "";
  children.classList.remove("slideOut");
  delete children.dataset.frozen;
  lastView = "";
}

function renderClock(view, prediction, now) {
  const active = view.phase === "active";
  clock.classList.toggle("is-inactive", !active);
  clock.classList.toggle("heartbeat", active);
  const text = String(Math.floor(view.seconds / 60)).padStart(2, "0") + ":" + String(view.seconds % 60).padStart(2, "0");
  if (clock.textContent !== text) clock.textContent = text;
  if (!active) return;
  // One pulse per countdown second, on the same absolute clock as the digit.
  // Seeking the existing animation compensates late frames, replay and wake-up
  // without restarting it or replaying pulses missed while the source was paused.
  const beat = clock.getAnimations?.().find(animation => animation.animationName === "heartbeat");
  if (beat) beat.currentTime = ((now - Date.parse(prediction.locks_at)) % 1000 + 1000) % 1000;
}

function createOutcome(outcome, index, animate) {
  const node = document.createElement("div");
  node.className = "prediction-child";
  node.dataset.outcomeId = outcome.id;
  // Only this fixed template is HTML. All Twitch titles and numbers use textContent.
  node.innerHTML = '<div class="progress-bar-stats"><div class="progress-bar-stats-child"><div class="progress-bar-text"></div></div></div><div class="progress-bar"><div class="prediction-outcome progress-bar-foreground-1"><div class="outcome-shade"></div></div><div class="progress-bar-percent-text"></div></div><div class="progress-bar-multiplier"><i class="fa-regular fa-star" aria-hidden="true"></i> <span class="multiplier-text"></span></div><div class="progress-bar-users"><span class="progress-bar-users-text"><i class="fa-regular fa-user" aria-hidden="true"></i> </span></div>';
  if (animate) {
    node.classList.add("slideIn");
    node.style.animationDelay = (POLICY.entryMs + (index + 1) * 150) + "ms";
  }
  children.append(node);
  nodes.set(outcome.id, node);
  return node;
}

function render() {
  clearTimeout(tickTimer);
  if (clockDiscontinuity()) { verifyCurrentState(); return; }
  if (!snapshot || !confirmed || !fontsReady) { hide(); return; }
  const now = serverNow();
  const selected = selectInteraction(snapshot, now);
  if (!selected) { hide(); return; }
  const { kind, view, entity: prediction, winners } = selected;
  const identity = kind + ":" + prediction.id;
  const key = identity + ":" + view.phase;
  const entering = overlay.hidden || overlay.dataset.predictionId !== identity;
  if (overlay.dataset.predictionId !== identity) {
    children.replaceChildren(); nodes.clear(); children.style.height = ""; delete children.dataset.frozen;
  }
  overlay.hidden = false;
  overlay.dataset.predictionId = identity;
  overlay.dataset.kind = kind;
  overlay.dataset.phase = view.phase;
  overlay.dataset.revision = String(snapshot.revision);
  overlay.dataset.hideAt = view.hideAt ? String(view.hideAt) : "";
  // A result re-enters once, but a lock preserves any original entrance
  // already running. Repeated snapshots cannot restart either animation.
  const terminalView = view.phase === "resolved" || view.phase === "canceled";
  if (entering || (key !== lastView && terminalView)) {
    overlay.className = "prediction-overlay";
    overlay.style.animationDelay = "0s";
    const age = terminalView ? Math.max(0, now - Date.parse(prediction.ended_at)) : 0;
    if (age < POLICY.entryMs) {
      void overlay.offsetWidth;
      overlay.style.animationDelay = -age + "ms";
      overlay.classList.add("fadeIn");
    }
  }
  lastView = key;
  const exiting = Boolean(view.hideAt && now >= view.hideAt - POLICY.exitMs);
  if (exiting && !overlay.classList.contains("is-exiting")) {
    overlay.style.setProperty("--exit-delay", -Math.max(0, now - (view.hideAt - POLICY.exitMs)) + "ms");
  }
  overlay.classList.toggle("is-exiting", exiting);
  children.classList.toggle("slideOut", exiting);
  overlay.classList.toggle("is-many", prediction.outcomes.length > 5);
  const prefix = view.phase === "resolved" ? "🏆 " : view.phase === "canceled" ? "Cancelada: " : view.phase === "locked" ? "🛑 " : "";
  title.textContent = kind === "poll" && view.phase === "resolved"
    ? (winners.length > 1 ? "Empate: " : winners.length === 0 ? "Sin votos: " : "🏆 ") + prediction.title
    : prefix + prediction.title + (view.phase === "resolved" ? " 🏆" : view.phase === "locked" ? " 🛑" : "");
  // Keep the clock's original space while fading it on lock/end.
  renderClock(view, prediction, now);
  const known = prediction.outcomes.every((outcome) => outcome.channel_points !== null);
  const total = prediction.outcomes.reduce((sum, outcome) => sum + (outcome.channel_points || 0), 0);
  // Original bars overlap their rectangular bounds by 10px. The slanted
  // edges leave the same compact 5px visible separation as the legacy widget.
  const available = children.clientWidth + (prediction.outcomes.length - 1) * 10;
  const minimum = Math.min(96, available / prediction.outcomes.length);
  const percents = prediction.outcomes.map((outcome) => !known || total === 0 ? 100 / prediction.outcomes.length : outcome.channel_points / total * 100);
  const ideals = percents.map((percent) => available * percent / 100);
  const widths = ideals.map((width) => Math.max(minimum, width));
  const overflow = Math.max(0, widths.reduce((sum, width) => sum + width, 0) - available);
  const capacity = widths.reduce((sum, width) => sum + Math.max(0, width - minimum), 0);
  // Preserve real proportions. Only borrow width where a small option needs
  // a readable minimum; adding a minimum to every option distorted 25/75 splits.
  if (capacity > 0) widths.forEach((width, index) => { widths[index] -= overflow * Math.max(0, width - minimum) / capacity; });
  prediction.outcomes.forEach((outcome, index) => {
    const node = nodes.get(outcome.id) || createOutcome(outcome, index, entering && view.phase === "active");
    if (view.phase !== "active") {
      node.classList.remove("slideIn");
      node.style.animationDelay = "";
    }
    if (!children.dataset.frozen) node.style.width = widths[index] + "px";
    if (children.dataset.frozen) {
      const left = widths.slice(0, index).reduce((sum, width) => sum + width - 10, 0);
      node.style.left = left + "px";
      node.style.width = widths[index] + "px";
      node.style.setProperty("--result-left", left + "px");
      node.style.setProperty("--result-width", widths[index] + "px");
    }
    node.querySelector(".progress-bar-text").textContent = outcome.title;
    node.querySelector(".prediction-outcome").style.backgroundColor = ["#ffbb00", "#0f63ff", "#ff0000"][index % 3];
    // Before Twitch supplies totals, retain the original equal initial split.
    // This is a presentation fallback; unknown counters stay null in state/storage.
    node.querySelector(".progress-bar-percent-text").textContent = Math.round(percents[index]) + "%";
    node.querySelector(".progress-bar-users-text").lastChild.textContent = " " + (outcome.users === null ? view.phase === "active" ? "0" : "…" : outcome.users.toLocaleString("en-US"));
    // Visual odds follow the percentage, including the initial equal split.
    // A 10% floor keeps empty/tiny outcomes at a restrained x10 ceiling.
    const multiplier = 100 / Math.max(10, percents[index]);
    node.querySelector(".multiplier-text").textContent = "x" + multiplier.toFixed(1);
    // Keep the original 45px offset for normal values, and reserve more room
    // only when a long multiplier would collide with the user metric.
    const multiplierWidth = node.querySelector(".progress-bar-multiplier").offsetWidth;
    node.querySelector(".progress-bar-users").style.marginRight = kind === "poll" ? "0px" : Math.max(45, multiplierWidth - 8) + "px";
    node.querySelector(".progress-bar-users").title = kind === "poll" ? "Votos" : "Usuarios";
    node.querySelector(".progress-bar-users-text i").className = kind === "poll" ? "fa-regular fa-square-check" : "fa-regular fa-user";
  });
  if (view.phase === "resolved" && !children.dataset.frozen) {
    // Freeze existing nodes in place instead of requiring clones made by lock.
    // Read all positions before mutating layout. offsetTop ignores entrance transforms.
    const positions = [...nodes.values()].map((node) => ({ node, left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth }));
    children.style.height = children.offsetHeight + "px";
    children.dataset.frozen = "true";
    for (const { node, left, top, width } of positions) {
      Object.assign(node.style, { position: "absolute", margin: "0", left: left + "px", top: top + "px", width: width + "px" });
    }
    // Finish any in-flight vote-width transition using the final totals. Freezing
    // measured widths alone would strand a 50/50 result at an earlier 25/75 frame.
    void children.offsetWidth;
    let left = 0;
    prediction.outcomes.forEach((outcome, index) => {
      const node = nodes.get(outcome.id);
      node.style.left = left + "px";
      node.style.width = widths[index] + "px";
      node.style.setProperty("--result-left", left + "px");
      node.style.setProperty("--result-width", widths[index] + "px");
      left += widths[index] - 10;
    });
  }
  if (view.phase === "resolved") {
    const age = Math.max(0, now - Date.parse(prediction.ended_at));
    for (const outcome of prediction.outcomes) {
      const node = nodes.get(outcome.id);
      const losing = winners.length > 0 && !winners.includes(outcome.id) && view.resultStep >= 1;
      const winning = winners.includes(outcome.id) && age >= winnerStartsAtMs;
      const targetWidth = (children.clientWidth + (winners.length - 1) * 10) / Math.max(1, winners.length);
      const targetLeft = Math.max(0, winners.indexOf(outcome.id)) * (targetWidth - 10);
      node.style.setProperty("--winner-left", targetLeft + "px");
      node.style.setProperty("--winner-width", targetWidth + "px");
      // Set the negative delay only when entering the phase. Replays keep the
      // same CSS animation; a late source resumes its elapsed pose without flashing.
      if (losing && !node.classList.contains("is-loser")) node.style.setProperty("--loser-delay", -Math.max(0, age - POLICY.fadeLosersAtMs) + "ms");
      if (winning && !node.classList.contains("is-winner")) node.style.setProperty("--winner-delay", -Math.max(0, age - winnerStartsAtMs) + "ms");
      node.classList.toggle("is-loser", losing);
      node.classList.toggle("is-winner", winning);
      // Keep a static final pose as well: frame loss or unavailable CSS motion
      // must not prevent the right winner or the hard cleanup from being shown.
      node.style.opacity = losing && age >= POLICY.fadeLosersAtMs + RESULT_MOTION.fadeMs ? "0" : "";
      if (winning && age >= winnerStartsAtMs + RESULT_MOTION.expandMs) {
        node.style.left = targetLeft + "px";
        node.style.width = targetWidth + "px";
      }
    }
  }
  // This timer belongs to the renderer, never to a particular socket or CSS animation.
  // Wake exactly at sequence boundaries as well as the hard cleanup deadline.
  const boundaries = view.hideAt ? [view.hideAt - POLICY.exitMs, view.hideAt] : [];
  if (view.phase === "active") boundaries.push(Date.parse(prediction.locks_at) - (view.seconds - 1) * 1000);
  if (view.phase === "resolved") boundaries.push(...[POLICY.fadeLosersAtMs, POLICY.fadeLosersAtMs + RESULT_MOTION.fadeMs, winnerStartsAtMs, winnerStartsAtMs + RESULT_MOTION.expandMs].map((offset) => Date.parse(prediction.ended_at) + offset));
  const nextBoundary = Math.min(...boundaries.filter((time) => time > now));
  tickTimer = setTimeout(render, Math.max(1, Math.min(250, nextBoundary - now)));
  if ((view.phase === "locked" || view.phase === "awaiting") && prediction.status === "active") requestSync();
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
      const result = window.SE_API.store.set(STORE_KEY, { schemaVersion: 3, snapshot: candidate });
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
  try { next = validateInteractionSnapshot(raw, CHANNEL); } catch (error) { warn(error.message); requestSync(); return; }
  lastMessage = mono();
  if (clockDiscontinuity()) { verifyCurrentState(); return; }
  if (snapshot?.epoch === next.epoch && next.revision < snapshot.revision) return;
  if (retiredEpochs.has(next.epoch)) return;
  const sent = requests.get(next.request_id);
  const age = requestAge(sent);
  if (sent) {
    requests.delete(next.request_id);
    if (age > MAX_SYNC_AGE_MS) {
      if (!clockAnchor) verifyCurrentState();
      return;
    }
  }
  // Only a recent correlated round trip can establish the first server clock,
  // including after waking. An old queued ready packet cannot do that.
  if (!clockAnchor && !sent) { requestSync(); return; }
  const measuredServer = Date.parse(next.server_now) + (sent ? age / 2 : 0);
  const estimatedServer = clockAnchor ? Math.max(serverNow(), measuredServer) : measuredServer;
  clockAnchor = { server: estimatedServer, local: mono(), wall: Date.now() };
  // A syncing response verifies time, but never authorizes the persisted state.
  // A later ready broadcast can then use that verified clock without delay.
  const ready = next.sync.status === "ready" || next.poll_sync.status === "ready";
  if (!ready && !confirmed) return;
  if (snapshot && snapshot.epoch !== next.epoch) {
    if (!ready) return;
    retiredEpochs.add(snapshot.epoch);
    if (retiredEpochs.size > 8) retiredEpochs.delete(retiredEpochs.values().next().value);
  }
  const previous = snapshot;
  snapshot = next;
  confirmed = true;
  cacheCandidate = null;
  render();
  const transition = previous?.prediction?.id !== next.prediction?.id || previous?.prediction?.status !== next.prediction?.status || !previous || previous.epoch !== next.epoch;
  if (ready) writeCache(next, transition || previous?.poll?.id !== next.poll?.id || previous?.poll?.status !== next.poll?.status);
}

function requestSync(force = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN || (!force && mono() - lastSync < 5000)) return;
  const requestId = (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random());
  requests.set(requestId, { local: mono(), wall: Date.now() });
  if (requests.size > 8) requests.delete(requests.keys().next().value);
  lastSync = mono();
  socket.send(JSON.stringify({ type: "bridge.sync", protocol_version: 3, request_id: requestId, known_epoch: snapshot?.epoch || cacheCandidate?.epoch || null, known_revision: snapshot?.revision ?? cacheCandidate?.revision ?? null }));
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
    verifyCurrentState();
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
    if (cached?.schemaVersion !== 3 || confirmed) return;
    try { cacheCandidate = validateInteractionSnapshot(cached.snapshot, CHANNEL); } catch { warn("storage_cache_invalid"); }
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
  if (event.detail?.listener !== "kvstore:update" || value?.key !== "customWidget." + STORE_KEY || value.value?.schemaVersion !== 3) return;
  let cached;
  try { cached = validateInteractionSnapshot(value.value.snapshot, CHANNEL); } catch { return; }
  if (snapshot && (cached.epoch !== snapshot.epoch || cached.revision > snapshot.revision)) requestSync();
  // Never echo a KV event back to storage or let it override a confirmed server revision.
});
function wake() {
  verifyCurrentState();
}
window.addEventListener("pageshow", wake);
window.addEventListener("online", wake);
window.addEventListener("obsSourceVisibleChanged", event => event.detail?.visible === false ? render() : wake());
window.addEventListener("obsSourceActiveChanged", event => event.detail?.active === false ? render() : wake());
window.addEventListener("resize", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
setInterval(() => {
  if (!loaded) return;
  if (socket?.readyState === WebSocket.OPEN && mono() - lastMessage > 70000) {
    try { socket.close(1000, "heartbeat_timeout"); } catch {}
  } else if (socket?.readyState === WebSocket.OPEN && !confirmed && ![...requests.values()].some(sent => requestAge(sent) <= MAX_SYNC_AGE_MS)) requestSync(true);
  else if (socket?.readyState === WebSocket.OPEN && confirmed && snapshot?.poll?.status === "active" && serverNow() >= Date.parse(snapshot.poll.ends_at)) requestSync();
  else if (socket?.readyState === WebSocket.OPEN && confirmed && mono() - lastSync >= 30000) requestSync();
  else if (socket?.readyState === WebSocket.CONNECTING && mono() - lastMessage > 15000) {
    try { socket.close(); } catch {}
  }
}, 5000);
hide();
prepareFonts();

})();
