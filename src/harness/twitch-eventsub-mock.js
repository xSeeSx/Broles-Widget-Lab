(function () {
  const LAB_SOURCE = "losbroles-widget-lab";
  const handlers = new Map();

  const PREDICTION_TYPES = {
    begin: "channel.prediction.begin",
    progress: "channel.prediction.progress",
    lock: "channel.prediction.lock",
    end: "channel.prediction.end"
  };

  const predictionFixtures = {
    [PREDICTION_TYPES.begin]: createFixture(PREDICTION_TYPES.begin, {
      started_at: "2026-05-20T10:00:00.000Z",
      locks_at: "2026-05-20T10:01:00.000Z"
    }),
    [PREDICTION_TYPES.progress]: createFixture(PREDICTION_TYPES.progress, {
      started_at: "2026-05-20T10:00:00.000Z",
      locks_at: "2026-05-20T10:01:00.000Z"
    }),
    [PREDICTION_TYPES.lock]: createFixture(PREDICTION_TYPES.lock, {
      started_at: "2026-05-20T10:00:00.000Z",
      locked_at: "2026-05-20T10:00:45.000Z"
    }),
    [PREDICTION_TYPES.end]: createFixture(PREDICTION_TYPES.end, {
      winning_outcome_id: "outcome-1",
      status: "resolved",
      started_at: "2026-05-20T10:00:00.000Z",
      ended_at: "2026-05-20T10:02:00.000Z"
    })
  };

  function log(level, message, data) {
    if (typeof window.__LAB_LOG__ === "function") {
      window.__LAB_LOG__(level, message, data);
    }
  }

  function clone(value) {
    if (typeof value === "undefined") {
      return undefined;
    }

    return JSON.parse(JSON.stringify(value));
  }

  function createFixture(type, extraEventFields) {
    return {
      type,
      subscription: {
        type
      },
      event: {
        id: "prediction-0001",
        broadcaster_user_id: "mock-channel-id",
        broadcaster_user_login: "losbroles",
        broadcaster_user_name: "LosBroles",
        title: "Quien gana la siguiente ronda?",
        outcomes: [
          {
            id: "outcome-1",
            title: "Opcion 1",
            color: "blue",
            users: 0,
            channel_points: 0,
            top_predictors: []
          },
          {
            id: "outcome-2",
            title: "Opcion 2",
            color: "pink",
            users: 0,
            channel_points: 0,
            top_predictors: []
          }
        ],
        ...extraEventFields
      }
    };
  }

  // Match Twitch's begin shape rather than assuming vote fields are present.
  for (const outcome of predictionFixtures[PREDICTION_TYPES.begin].event.outcomes) {
    delete outcome.users;
    delete outcome.channel_points;
    delete outcome.top_predictors;
  }

  function getHandlers(type) {
    if (!handlers.has(type)) {
      handlers.set(type, new Set());
    }

    return handlers.get(type);
  }

  function normalizePayload(typeOrPayload, event) {
    if (typeof typeOrPayload === "object" && typeOrPayload) {
      // Explicit payloads are wire data. Never repair malformed/stress events with fixtures.
      return clone(typeOrPayload);
    }

    const type = typeOrPayload;
    const fixture = predictionFixtures[type] || { type, subscription: { type }, event: {} };

    return {
      ...clone(fixture),
      type,
      subscription: {
        ...clone(fixture.subscription),
        type
      },
      event: {
        ...clone(fixture.event),
        ...clone(event || {})
      }
    };
  }

  function callHandlers(type, payload) {
    for (const handler of getHandlers(type)) {
      handler(clone(payload));
    }

    for (const handler of getHandlers("*")) {
      handler(clone(payload));
    }
  }

  function emit(typeOrPayload, event) {
    const payload = normalizePayload(typeOrPayload, event);

    callHandlers(payload.type, payload);
    window.dispatchEvent(new CustomEvent("twitch:eventsub", { detail: clone(payload) }));
    window.dispatchEvent(new CustomEvent(payload.type, { detail: clone(payload) }));
    log("info", `Twitch EventSub mock emitted ${payload.type}`, {
      timestamp: new Date().toISOString(),
      payload
    });

    return payload;
  }

  function emitPredictionBegin(event) {
    return emit(PREDICTION_TYPES.begin, event);
  }

  function emitPredictionProgress(event) {
    return emit(PREDICTION_TYPES.progress, event);
  }

  function emitPredictionLock(event) {
    return emit(PREDICTION_TYPES.lock, event);
  }

  function emitPredictionEnd(event) {
    return emit(PREDICTION_TYPES.end, event);
  }

  window.TwitchEventSubMock = {
    predictionTypes: { ...PREDICTION_TYPES },
    predictionFixtures: clone(predictionFixtures),
    on(type, handler) {
      getHandlers(type).add(handler);
      return () => this.off(type, handler);
    },
    off(type, handler) {
      if (handlers.has(type)) {
        handlers.get(type).delete(handler);
      }
    },
    emit,
    emitPredictionBegin,
    emitPredictionProgress,
    emitPredictionLock,
    emitPredictionEnd,
    clear() {
      handlers.clear();
    }
  };

  window.emitTwitchPredictionBegin = emitPredictionBegin;
  window.emitTwitchPredictionProgress = emitPredictionProgress;
  window.emitTwitchPredictionLock = emitPredictionLock;
  window.emitTwitchPredictionEnd = emitPredictionEnd;

  window.addEventListener("message", (event) => {
    const data = event.data;

    if (event.source !== parent || !data || data.source !== LAB_SOURCE || data.type !== "TWITCH_EVENTSUB_EMIT") {
      return;
    }

    if (data.payload) {
      emit(data.payload);
      return;
    }

    emit(data.eventType, data.event);
  });

  log("info", "Twitch EventSub mock ready");
})();
