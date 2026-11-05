import { copy, timestamp, compareTime, POLICY, validateSnapshot, viewAt } from "./state.mjs";

export const POLL_TYPES = ["begin", "progress", "end"].map(stage => "channel.poll." + stage);
const pollFinal = status => ["completed", "terminated", "archived", "moderated", "invalid"].includes(status);
const pollHidden = status => ["archived", "moderated", "invalid"].includes(status);
const pollDate = value => timestamp(value) === null ? null : value;
const pollCount = value => value == null ? null : Number.isSafeInteger(value) && value >= 0 ? value : null;
const pollText = (value, max = 500) => typeof value === "string" && value.length > 0 && value.length <= max;

export function normalizePoll(raw, { type = "helix", previous = null, broadcasterId } = {}) {
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

export function reducePoll(previous, next) {
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
    if (known.votes !== null && (choice.votes === null || choice.votes < known.votes)) choice.votes = known.votes;
  }
  return { accepted: true, poll };
}

export function pollEventTransition(model, payload, broadcasterId) {
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

export function pollViewAt(poll, now) {
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

export function pollWinners(poll) {
  if (!poll || !["completed", "terminated"].includes(poll.status)) return [];
  const highest = Math.max(...poll.choices.map(choice => choice.votes || 0));
  return highest > 0 ? poll.choices.filter(choice => choice.votes === highest).map(choice => choice.id) : [];
}

export function validateInteractionSnapshot(raw, broadcasterId) {
  if (raw?.protocol_version !== 3 || !["ready", "syncing", "degraded", "auth_required", "disabled"].includes(raw.poll_sync?.status)) throw new Error("interaction_snapshot_invalid");
  const base = validateSnapshot({ ...raw, protocol_version: 2 }, broadcasterId);
  return { ...base, protocol_version: 3, poll_sync: copy(raw.poll_sync),
    poll: raw.poll === null ? null : normalizePoll(raw.poll, { broadcasterId }) };
}

export function selectInteraction(snapshot, now) {
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
