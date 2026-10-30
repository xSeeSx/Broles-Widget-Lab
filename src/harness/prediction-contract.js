// EventSub event bodies. Worker bridge envelope remains {type, subscription, event}.
export function predictionEvent(stage, source) {
  const event = {};
  for (const key of ["id", "broadcaster_user_id", "broadcaster_user_login", "broadcaster_user_name", "title", "started_at"]) {
    event[key] = source[key];
  }
  event.outcomes = (source.outcomes || []).map((outcome) => {
    const result = { id: outcome.id, title: outcome.title, color: outcome.color };
    // Twitch begin does not include counters or top_predictors.
    if (stage !== "begin") {
      result.users = outcome.users;
      result.channel_points = outcome.channel_points;
      result.top_predictors = (outcome.top_predictors || []).map((predictor) => ({
        ...predictor,
        channel_points_won: stage === "end"
          ? (source.status === "resolved" && outcome.id === source.winning_outcome_id ? predictor.channel_points_won : 0)
          : null
      }));
    }
    return result;
  });
  if (stage === "begin" || stage === "progress") event.locks_at = source.locks_at;
  if (stage === "lock") event.locked_at = source.locked_at;
  if (stage === "end") {
    event.status = source.status;
    event.winning_outcome_id = source.status === "canceled" ? null : source.winning_outcome_id;
    event.ended_at = source.ended_at;
  }
  return event;
}
