// Shared by the production bridge, the copyable widget and the laboratory.
export const PROTOCOL_VERSION = 2;
// Original visual sequence: 0.5s entrance, then 3s/5s/10s milestones,
// followed by the 0.7s exit. All milestones stay anchored to Twitch timestamps.
export const POLICY = Object.freeze({ version: 2, entryMs: 500,
  fadeLosersAtMs: 3500, expandWinnerAtMs: 5500,
  lockExitAtMs: 15000, lockMs: 15700, resultExitAtMs: 10500, resultMs: 11200,
  exitMs: 700, barsExitMs: 400 });
const terminal = (status) => status === "resolved" || status === "canceled";
const rank = (status) => terminal(status) ? 2 : status === "locked" ? 1 : 0;
export const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

// Twitch timestamps contain nanoseconds. Date.parse alone loses their ordering.
export function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(match[1] + match[3]);
  return Number.isFinite(seconds) ? BigInt(seconds) * 1000000n + BigInt((match[2] || "").padEnd(9, "0")) : null;
}
export function compareTime(left, right) {
  const a = timestamp(left), b = timestamp(right);
  if (a === null || b === null) return null;
  return a === b ? 0 : a > b ? 1 : -1;
}
const date = (value) => timestamp(value) === null ? null : value;
const count = (value) => value === null || value === undefined ? null : Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

export function normalizePrediction(raw, { type = "helix", previous = null, broadcasterId } = {}) {
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

export function reducePrediction(previous, next) {
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

export function presentationFor(prediction) {
  const after = (value, ms) => value ? new Date(Date.parse(value) + ms).toISOString() : null;
  return { policy_version: POLICY.version,
    lock_hide_at: prediction ? after(prediction.locked_at || prediction.locks_at, POLICY.lockMs) : null,
    result_hide_at: prediction && terminal(prediction.status) ? after(prediction.ended_at, POLICY.resultMs) : null };
}

export function validateSnapshot(raw, broadcasterId) {
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

export function viewAt(snapshot, now) {
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
export function eventTransition(model, payload, broadcasterId) {
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
