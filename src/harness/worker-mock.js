(function () {
  const LAB_SOURCE = "losbroles-widget-lab";
  const WIDGET_SOURCE = "losbroles-widget-lab-widget";
  const DEFAULT_SESSION_ID = "mock-session-id";
  const connections = new Map();
  const NativeWebSocket = window.WebSocket;
  let nextConnectionId = 1;
  const initialConfig = window.__LAB_WORKER_INITIAL_CONFIG__ || {};
  let interceptWorkerWebSocket = initialConfig.interceptWebSocket !== false;
  let workerUrl = String(initialConfig.workerUrl || "");
  let replayMode = String(initialConfig.replayMode || "welcome");
  const overlayId = window.__LAB_OVERLAY_ID__ || "A";
  const predictionState = {
    currentPrediction: null,
    predictionHistory: [],
    lastPredictionPayload: null,
    currentPredictionStatus: "idle",
    currentPredictionStage: "idle"
  };

  mergePredictionState(window.__LAB_WORKER_INITIAL_STATE__);

  function log(level, message, data) {
    if (typeof window.__LAB_LOG__ === "function") {
      window.__LAB_LOG__(level, message, data);
    }
  }

  function sendToLab(type, payload = {}) {
    parent.postMessage({ source: WIDGET_SOURCE, type, ...payload }, "*");
  }

  function clone(value) {
    if (typeof value === "undefined") {
      return undefined;
    }

    return JSON.parse(JSON.stringify(value));
  }

  function parseSocketMessage(data) {
    if (typeof data !== "string") {
      return data;
    }

    try {
      return JSON.parse(data);
    } catch (error) {
      return data;
    }
  }

  function stringifySocketMessage(payload) {
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  }

  function isWorkerSocketUrl(url) {
    const value = String(url || "");

    return value.includes("/ws")
      || (workerUrl && (value === workerUrl || value.startsWith(workerUrl)));
  }

  function shouldIntercept(url) {
    return interceptWorkerWebSocket && isWorkerSocketUrl(url);
  }

  function emitWorkerConsole(entry) {
    sendToLab("WORKER_WS_LOG", {
      entry: {
        timestamp: new Date().toISOString(),
        overlayId,
        ...entry
      }
    });
  }

  function isPredictionPayload(payload) {
    return Boolean(payload?.type && String(payload.type).startsWith("channel.prediction."));
  }

  function mergePredictionState(nextState) {
    if (!nextState || typeof nextState !== "object") {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(nextState, "currentPrediction")) {
      predictionState.currentPrediction = clone(nextState.currentPrediction);
    }
    predictionState.predictionHistory = Array.isArray(nextState.predictionHistory)
      ? clone(nextState.predictionHistory)
      : predictionState.predictionHistory;
    if (Object.prototype.hasOwnProperty.call(nextState, "lastPredictionPayload")) {
      predictionState.lastPredictionPayload = clone(nextState.lastPredictionPayload);
    }
    predictionState.currentPredictionStatus = nextState.currentPredictionStatus || predictionState.currentPredictionStatus;
    predictionState.currentPredictionStage = nextState.currentPredictionStage || predictionState.currentPredictionStage;
  }

  function updatePredictionStateFromPayload(payload) {
    if (!isPredictionPayload(payload)) {
      return;
    }

    const stage = String(payload.type).replace("channel.prediction.", "");
    predictionState.lastPredictionPayload = clone(payload);
    predictionState.currentPrediction = clone(payload.event || {});
    predictionState.currentPredictionStage = stage;
    predictionState.currentPredictionStatus = inferPredictionStatus(payload);
    predictionState.predictionHistory.push(clone(payload));

    if (predictionState.predictionHistory.length > 100) {
      predictionState.predictionHistory.shift();
    }
  }

  function inferPredictionStatus(payload) {
    const stage = String(payload.type || "").replace("channel.prediction.", "");
    const event = payload.event || {};

    if (stage === "end") {
      return event.status === "canceled" ? "canceled" : "resolved";
    }

    if (stage === "lock") {
      return "locked_waiting_resolution";
    }

    if ((stage === "begin" || stage === "progress") && event.locks_at && new Date(event.locks_at).getTime() < Date.now()) {
      return "active_expired";
    }

    return "active";
  }

  function buildCurrentPredictionPayload() {
    if (!predictionState.currentPrediction) {
      return predictionState.lastPredictionPayload;
    }

    let stage = predictionState.currentPredictionStage || "progress";

    if (predictionState.currentPredictionStatus === "resolved" || predictionState.currentPredictionStatus === "canceled") {
      stage = "end";
    } else if (predictionState.currentPredictionStatus === "locked" || predictionState.currentPredictionStatus === "locked_waiting_resolution") {
      stage = "lock";
    } else if (stage === "idle") {
      stage = "progress";
    }

    const type = `channel.prediction.${stage}`;

    return {
      type,
      subscription: { type },
      event: clone(predictionState.currentPrediction)
    };
  }

  function emitSocketEvent(socket, event) {
    socket.dispatchEvent(event);

    const handler = socket[`on${event.type}`];

    if (typeof handler === "function") {
      handler.call(socket, event);
    }
  }

  function createCloseEvent(type, options) {
    if (typeof CloseEvent === "function") {
      return new CloseEvent(type, options);
    }

    const event = new Event(type);
    event.code = options.code;
    event.reason = options.reason;
    event.wasClean = options.wasClean;
    return event;
  }

  class LabWorkerMock extends EventTarget {
    constructor(scriptUrl) {
      super();
      this.scriptUrl = String(scriptUrl);
      this.onmessage = null;
      this.onerror = null;
      log("info", "Worker mock created", { scriptUrl: this.scriptUrl });
    }

    postMessage(message) {
      const response = {
        mocked: true,
        scriptUrl: this.scriptUrl,
        echo: message
      };

      queueMicrotask(() => {
        const event = new MessageEvent("message", { data: response });

        if (typeof this.onmessage === "function") {
          this.onmessage(event);
        }

        this.dispatchEvent(event);
      });
    }

    terminate() {
      log("info", "Worker mock terminated", { scriptUrl: this.scriptUrl });
    }
  }

  class LabWebSocketMock extends EventTarget {
    constructor(url, protocols) {
      super();

      if (!shouldIntercept(url) && typeof NativeWebSocket === "function") {
        emitWorkerConsole({
          kind: "connection.native",
          connectionId: "-",
          url: String(url),
          summary: "WebSocket not intercepted; falling back to native WebSocket",
          payload: {
            interceptWebSocket: interceptWorkerWebSocket,
            workerUrl,
            expected: "Mock intercepts URLs containing /ws or the configured Worker URL."
          }
        });
        return typeof protocols === "undefined"
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      }

      this.id = `${overlayId}-mock-ws-${nextConnectionId}`;
      nextConnectionId += 1;
      this.url = String(url);
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.readyState = LabWebSocketMock.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      connections.set(this.id, this);
      emitWorkerConsole({
        kind: "connection.opening",
        connectionId: this.id,
        url: this.url,
        readyState: "CONNECTING",
        summary: "Opening mocked Worker WebSocket"
      });

      queueMicrotask(() => {
        if (this.readyState !== LabWebSocketMock.CONNECTING) {
          return;
        }

        this.readyState = LabWebSocketMock.OPEN;
        emitSocketEvent(this, new Event("open"));
        emitWorkerConsole({
          kind: "connection.open",
          connectionId: this.id,
          url: this.url,
          readyState: "OPEN",
          summary: "Mocked Worker WebSocket open"
        });
        replayOnOpen(this);
      });
    }

    send(data) {
      if (this.readyState !== LabWebSocketMock.OPEN) {
        throw new DOMException("WebSocket is not open", "InvalidStateError");
      }

      emitWorkerConsole({
        kind: "message.from-widget",
        connectionId: this.id,
        url: this.url,
        readyState: readyStateName(this.readyState),
        summary: "Widget sent message to Worker mock",
        payload: parseSocketMessage(data)
      });
      log("info", "Worker WebSocket mock received widget message", {
        connectionId: this.id,
        payload: parseSocketMessage(data)
      });
    }

    close(code = 1000, reason = "mock closed") {
      if (this.readyState === LabWebSocketMock.CLOSED || this.readyState === LabWebSocketMock.CLOSING) {
        return;
      }

      this.readyState = LabWebSocketMock.CLOSING;
      queueMicrotask(() => {
        this.readyState = LabWebSocketMock.CLOSED;
        connections.delete(this.id);
        emitSocketEvent(this, createCloseEvent("close", { code, reason, wasClean: true }));
        emitWorkerConsole({
          kind: "connection.close",
          connectionId: this.id,
          url: this.url,
          readyState: "CLOSED",
          summary: "Mocked Worker WebSocket closed",
          payload: { code, reason }
        });
      });
    }

    receive(payload) {
      if (this.readyState !== LabWebSocketMock.OPEN) {
        return;
      }

      const data = stringifySocketMessage(payload);
      emitSocketEvent(this, new MessageEvent("message", { data }));
      emitWorkerConsole({
        kind: "message.to-widget",
        connectionId: this.id,
        url: this.url,
        readyState: readyStateName(this.readyState),
        summary: summarizePayload(payload),
        payload: clone(payload)
      });
    }
  }

  LabWebSocketMock.CONNECTING = 0;
  LabWebSocketMock.OPEN = 1;
  LabWebSocketMock.CLOSING = 2;
  LabWebSocketMock.CLOSED = 3;

  function readyStateName(value) {
    if (value === LabWebSocketMock.CONNECTING) {
      return "CONNECTING";
    }

    if (value === LabWebSocketMock.OPEN) {
      return "OPEN";
    }

    if (value === LabWebSocketMock.CLOSING) {
      return "CLOSING";
    }

    if (value === LabWebSocketMock.CLOSED) {
      return "CLOSED";
    }

    return String(value);
  }

  function replayOnOpen(socket) {
    if (replayMode === "none") {
      return;
    }

    if (replayMode === "last-payload") {
      if (predictionState.lastPredictionPayload) {
        socket.receive(predictionState.lastPredictionPayload);
      }
      return;
    }

    if (replayMode === "current-snapshot") {
      const payload = buildCurrentPredictionPayload();

      if (payload) {
        socket.receive(payload);
      }
      return;
    }

    if (replayMode === "full-history") {
      for (const payload of predictionState.predictionHistory) {
        socket.receive(payload);
      }
      return;
    }

    socket.receive({
      type: "welcome",
      session_id: DEFAULT_SESSION_ID
    });
  }

  function summarizePayload(payload) {
    if (!payload || typeof payload !== "object") {
      return String(payload);
    }

    if (payload.type === "welcome") {
      return `welcome ${payload.session_id || ""}`.trim();
    }

    if (payload.type === "bridge.error") {
      return `bridge.error ${payload.error?.code || ""}`.trim();
    }

    const event = payload.event || {};
    const outcomes = Array.isArray(event.outcomes) ? event.outcomes : [];
    const points = outcomes.reduce((total, outcome) => total + Number(outcome.channel_points || 0), 0);

    return `${payload.type || "message"} ${event.title || ""} users=${outcomes.reduce((total, outcome) => total + Number(outcome.users || 0), 0)} points=${points}`.trim();
  }

  function broadcast(payload, options = {}) {
    let delivered = 0;
    const openConnections = Array.from(connections.values()).filter((socket) => socket.readyState === LabWebSocketMock.OPEN).length;

    if (options.recordPrediction !== false) {
      updatePredictionStateFromPayload(payload);
    }

    for (const socket of connections.values()) {
      if (socket.readyState === LabWebSocketMock.OPEN) {
        socket.receive(payload);
        delivered += 1;
      }
    }

    if (delivered === 0) {
      log("warn", "No mocked WebSocket connections open. The widget may be hidden, reloading or not connected.", {
        delivered, openConnections, overlayId
      });
    }
    emitWorkerConsole({
      kind: "broadcast",
      connectionId: "*",
      url: workerUrl || "mock",
      summary: `Broadcast delivered to ${delivered} mocked WebSocket connection${delivered === 1 ? "" : "s"}`,
      payload: clone(payload),
      delivered,
      openConnections
    });

    return delivered;
  }

  function sendWelcome() {
    return broadcast({
      type: "welcome",
      session_id: DEFAULT_SESSION_ID
    });
  }

  function sendBridgeError(payload) {
    return broadcast(payload || {
      type: "bridge.error",
      error: {
        code: "mock_bridge_error",
        message: "Simulated Worker bridge error"
      }
    });
  }

  function replayLastPayload() {
    return predictionState.lastPredictionPayload
      ? broadcast(predictionState.lastPredictionPayload, { recordPrediction: false })
      : broadcast({
        type: "bridge.error",
        error: {
          code: "mock_no_last_payload",
          message: "No last prediction payload stored in Worker mock"
        }
      });
  }

  function replayCurrentPrediction() {
    const payload = buildCurrentPredictionPayload();

    return payload
      ? broadcast(payload, { recordPrediction: false })
      : broadcast({
        type: "bridge.error",
        error: {
          code: "mock_no_current_prediction",
          message: "No current prediction snapshot stored in Worker mock"
        }
      });
  }

  function replayFullHistory() {
    let delivered = 0;

    for (const payload of predictionState.predictionHistory) {
      delivered += broadcast(payload, { recordPrediction: false });
    }

    if (predictionState.predictionHistory.length === 0) {
      return broadcast({
        type: "bridge.error",
        error: {
          code: "mock_no_prediction_history",
          message: "No prediction history stored in Worker mock"
        }
      });
    }

    return delivered;
  }

  function closeAll(reason = "mock closed by lab") {
    for (const socket of Array.from(connections.values())) {
      socket.close(1000, reason);
    }
  }

  function configure(nextConfig = {}) {
    interceptWorkerWebSocket = nextConfig.interceptWebSocket !== false;
    workerUrl = String(nextConfig.workerUrl || "");
    replayMode = String(nextConfig.replayMode || "welcome");
    mergePredictionState(nextConfig.predictionState);
    emitWorkerConsole({
      kind: "config",
      connectionId: "-",
      url: workerUrl,
      summary: `WebSocket interception ${interceptWorkerWebSocket ? "enabled" : "disabled"}`,
      payload: {
        interceptWebSocket: interceptWorkerWebSocket,
        workerUrl,
        replayMode,
        predictionState: clone(predictionState)
      }
    });
  }

  window.__LAB_NATIVE_WORKER__ = window.Worker;
  window.__LAB_NATIVE_WEBSOCKET__ = NativeWebSocket;
  window.Worker = LabWorkerMock;
  window.WebSocket = LabWebSocketMock;
  window.WebSocket.CONNECTING = LabWebSocketMock.CONNECTING;
  window.WebSocket.OPEN = LabWebSocketMock.OPEN;
  window.WebSocket.CLOSING = LabWebSocketMock.CLOSING;
  window.WebSocket.CLOSED = LabWebSocketMock.CLOSED;
  window.WorkerMock = LabWorkerMock;
  window.__LAB_WORKER_MOCK__ = {
    create(scriptUrl) {
      return new LabWorkerMock(scriptUrl);
    },
    configure,
    broadcast,
    sendWelcome,
    sendBridgeError,
    replayLastPayload,
    replayCurrentPrediction,
    replayFullHistory,
    closeAll,
    get connections() {
      return Array.from(connections.keys());
    },
    get interceptWebSocket() {
      return interceptWorkerWebSocket;
    }
  };

  window.addEventListener("message", (event) => {
    const data = event.data;

    if (event.source !== parent || !data || data.source !== LAB_SOURCE) {
      return;
    }

    if (data.type === "WORKER_MOCK_CONFIG") {
      configure(data.config);
      return;
    }

    if (data.type === "WORKER_MOCK_WELCOME") {
      sendWelcome();
      return;
    }

    if (data.type === "WORKER_MOCK_BRIDGE_ERROR") {
      sendBridgeError(data.payload);
      return;
    }

    if (data.type === "WORKER_MOCK_BROADCAST") {
      broadcast(data.payload, { recordPrediction: data.recordPrediction !== false });
      return;
    }

    if (data.type === "WORKER_MOCK_REPLAY_LAST") {
      replayLastPayload();
      return;
    }

    if (data.type === "WORKER_MOCK_REPLAY_CURRENT") {
      replayCurrentPrediction();
      return;
    }

    if (data.type === "WORKER_MOCK_REPLAY_HISTORY") {
      replayFullHistory();
      return;
    }

    if (data.type === "WORKER_MOCK_CLOSE") {
      closeAll(data.reason || "mock closed by lab");
    }
  });

  log("info", "Worker mock ready");
})();
