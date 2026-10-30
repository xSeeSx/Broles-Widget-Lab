(function () {
  const LAB_SOURCE = "losbroles-widget-lab";
  const FAKE_API_TOKEN = "fake-api-token-never-real";
  const pendingReads = new Map();
  let nextStoreRequestId = 0;

  function storeRequest(action, key, value) {
    const requestId = window.__LAB_OVERLAY_ID__ + "-store-" + (++nextStoreRequestId);
    parent.postMessage({
      source: "losbroles-widget-lab-widget", type: "SE_STORE_REQUEST",
      requestId, action, key, value
    }, "*");
    return requestId;
  }
  const counters = new Map([
    ["follower-total", 1284],
    ["subscriber-total", 76],
    ["tip-total", 435.25],
    ["cheer-total", 18450]
  ]);

  const defaultChannel = {
    id: "mock-channel-id",
    providerId: "mock-twitch-channel-id",
    username: "losbroles",
    displayName: "LosBroles",
    apiToken: FAKE_API_TOKEN,
    avatar: "https://static-cdn.jtvnw.net/jtv_user_pictures/mock-profile_image-70x70.png"
  };

  let sessionState = {
    data: {
      "follower-total": { count: 1284 },
      "subscriber-total": { count: 76 },
      "tip-total": { amount: 435.25, currency: "EUR" },
      "cheer-total": { amount: 18450 }
    }
  };

  let recentsState = [];
  let currencyState = {
    code: "EUR",
    symbol: "EUR",
    name: "Euro"
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

  function sanitize({ message } = {}) {
    // Shape matches SE_API; account-specific profanity settings are not simulated.
    return Promise.resolve({ skip: false, result: { message: String(message ?? "") } });
  }

  function cheerFilter(message) {
    return Promise.resolve(String(message ?? "")
      .replace(/\b(?:cheer|bits|shamrock|cheerwhal)\d+\b/gi, "").replace(/\s+/g, " ").trim());
  }

  function dispatch(eventName, detail) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: clone(detail) }));
    log("info", `StreamElements mock dispatched ${eventName}`, detail);
  }

  function updateCountersFromSession(session) {
    const data = session?.data || {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "number") {
        counters.set(key, value);
      } else if (typeof value?.count === "number") {
        counters.set(key, value.count);
      } else if (typeof value?.amount === "number") {
        counters.set(key, value.amount);
      }
    }
  }

  function normalizeChannel(channel) {
    return {
      ...defaultChannel,
      ...(channel || {}),
      username: channel?.username || defaultChannel.username,
      apiToken: channel?.apiToken || FAKE_API_TOKEN
    };
  }

  function normalizeWidgetLoadPayload(payload = {}) {
    const session = clone(payload.session || sessionState);
    const recents = clone(payload.recents || recentsState);
    const currency = clone(payload.currency || currencyState);

    sessionState = session;
    recentsState = recents;
    currencyState = currency;
    updateCountersFromSession(session);

    return {
      fieldData: clone(payload.fieldData || window.__LAB_FIELDS__ || {}),
      channel: normalizeChannel(payload.channel),
      session,
      recents,
      currency,
      widget: clone(payload.widget || window.__LAB_WIDGET_MANIFEST__ || {})
    };
  }

  function normalizeEventReceivedPayload(payload = {}) {
    return {
      listener: payload.listener || "message",
      event: clone(payload.event || {})
    };
  }

  function getEventDisplayName(event) {
    return event.displayName
      || event.name
      || event.data?.displayName
      || event.data?.nick
      || event.data?.name
      || "Anonymous";
  }

  function rememberRecent(payload) {
    const event = payload.event || {};
    const recent = {
      type: payload.listener,
      name: getEventDisplayName(event),
      createdAt: event.createdAt || event.data?.time || new Date().toISOString(),
      event: clone(event)
    };

    recentsState = [recent, ...recentsState].slice(0, 20);
  }

  function emitSEWidgetLoad(payload = {}) {
    const normalized = normalizeWidgetLoadPayload(payload);
    dispatch("onWidgetLoad", normalized);
    return normalized;
  }

  function emitSEEventReceived(payload = {}) {
    const normalized = normalizeEventReceivedPayload(payload);
    rememberRecent(normalized);
    dispatch("onEventReceived", normalized);
    return normalized;
  }

  function emitSESessionUpdate(payload = {}) {
    const session = clone(payload.session || payload || sessionState);
    sessionState = session;
    updateCountersFromSession(session);

    const normalized = { session };
    dispatch("onSessionUpdate", normalized);
    return normalized;
  }

  function setField(key, value) {
    if (!window.__LAB_FIELDS__ || typeof window.__LAB_FIELDS__ !== "object") {
      window.__LAB_FIELDS__ = {};
    }

    window.__LAB_FIELDS__[key] = value;
    log("info", `StreamElements mock field set: ${key}`, { key, value });
    return value;
  }

  window.SE_API = {
    store: {
      get(key) {
        return new Promise((resolve, reject) => {
          const requestId = storeRequest("get", key);
          const timer = window.setTimeout(() => {
            pendingReads.delete(requestId);
            reject(new Error("SE store mock host did not respond"));
          }, 10000);
          pendingReads.set(requestId, { resolve, reject, timer });
        });
      },
      set(key, value) {
        // No documented Promise/acknowledgment contract for store.set in SE.
        storeRequest("set", key, clone(value));
      }
    },
    counters: {
      get(counter) {
        return Promise.resolve({ id: counter, count: counters.get(counter) ?? 0 });
      }

    },
    getOverlayStatus() {
      return Promise.resolve({ isEditorMode: window.__LAB_SE_EDITOR_MODE__ !== false, muted: false });
    },
    sanitize,
    cheerFilter,
    setField,
    resumeQueue() {
      return undefined;
    }
  };

  window.setField = setField;
  window.emitSEWidgetLoad = emitSEWidgetLoad;
  window.emitSEEventReceived = emitSEEventReceived;
  window.emitSESessionUpdate = emitSESessionUpdate;

  window.__SE_MOCK__ = {
    dispatch,
    emitSEWidgetLoad,
    emitSEEventReceived,
    emitSESessionUpdate,
    setField,
    get fieldData() {
      return window.__LAB_FIELDS__ || {};
    }
  };

  window.addEventListener("message", (event) => {
    const data = event.data;

    if (event.source !== parent || !data || data.source !== LAB_SOURCE) {
      return;
    }

    if (data.type === "SE_STORE_RESPONSE") {
      const pending = pendingReads.get(data.requestId);
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingReads.delete(data.requestId);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(clone(data.value));
      } else if (data.error) {
        log("error", "SE store write failed", { error: data.error });
      }
      return;
    }

    if (data.type === "LAB_EMIT") {
      dispatch(data.eventName, data.detail);
      return;
    }

    if (data.type !== "SE_MOCK_EMIT") {
      return;
    }

    if (data.action === "widgetLoad") {
      emitSEWidgetLoad(data.payload);
    } else if (data.action === "eventReceived") {
      emitSEEventReceived(data.payload);
    } else if (data.action === "sessionUpdate") {
      emitSESessionUpdate(data.payload);
    } else {
      log("warn", `StreamElements mock ignored action: ${data.action}`, data.payload);
    }
  });

  window.addEventListener("load", () => {
    emitSEWidgetLoad({
      ...(window.__LAB_SE_INITIAL_LOAD__ || {}),
      fieldData: window.__LAB_FIELDS__ || {}
    });
  }, { once: true });

  log("info", "StreamElements mock ready");
})();
