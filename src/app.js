import {
  CHAT_USER_PROFILES,
  buildSEChatMessage,
  emitSEChatMessage
} from "./harness/se-chat-mock.js";

import { createSEStoreHost } from "./harness/se-store-host.js";
import { predictionEvent } from "./harness/prediction-contract.js";
import { normalizePrediction, reducePrediction, eventTransition, presentationFor } from "./predictions/state.mjs";
import { initializeOBSView } from "./obs-view.js";

const LAB_SOURCE = "losbroles-widget-lab";
const WIDGET_SOURCE = "losbroles-widget-lab-widget";
const REGISTRY_URL = new URL("../widgets/registry.json", import.meta.url);
const HARNESS_URLS = [
  new URL("./harness/se-mock.js", import.meta.url),
  new URL("./harness/twitch-eventsub-mock.js", import.meta.url),
  new URL("./harness/worker-mock.js", import.meta.url)
];

const SE_FIXTURE_URLS = {
  widgetLoad: new URL("./fixtures/streamelements/widget-load.json", import.meta.url),
  chatMessage: new URL("./fixtures/streamelements/chat-message.json", import.meta.url),
  follow: new URL("./fixtures/streamelements/follow.json", import.meta.url),
  subscriber: new URL("./fixtures/streamelements/subscriber.json", import.meta.url),
  tip: new URL("./fixtures/streamelements/tip.json", import.meta.url),
  cheer: new URL("./fixtures/streamelements/cheer.json", import.meta.url),
  kvstoreUpdate: new URL("./fixtures/streamelements/kvstore-update.json", import.meta.url),
  sessionUpdate: new URL("./fixtures/streamelements/session-update.json", import.meta.url)
};

const TWITCH_PREDICTION_FIXTURE_URLS = {
  begin: new URL("./fixtures/twitch/predictions/begin.json", import.meta.url),
  progress: new URL("./fixtures/twitch/predictions/progress.json", import.meta.url),
  lock: new URL("./fixtures/twitch/predictions/lock.json", import.meta.url),
  end: new URL("./fixtures/twitch/predictions/end.json", import.meta.url)
};

const TWITCH_PREDICTION_TYPES = {
  begin: "channel.prediction.begin",
  progress: "channel.prediction.progress",
  lock: "channel.prediction.lock",
  end: "channel.prediction.end"
};

const PREDICTION_LIMITS = {
  titleMax: 45,
  outcomeTitleMax: 25,
  durationMin: 30,
  durationMax: 1800,
  outcomesMin: 2,
  outcomesMax: 10
};

const PREDICTION_STATE_LABELS = [
  "idle",
  "active",
  "active_expired",
  "locked",
  "locked_waiting_resolution",
  "resolved",
  "canceled",
  "stale"
];

const REQUIRED_WIDGET_FIELDS = [
  "id",
  "name",
  "description",
  "version",
  "author",
  "category",
  "width",
  "height",
  "html",
  "css",
  "js",
  "fields",
  "mocks",
  "notes"
];

const SE_ACTIONS = {
  widgetLoad: {
    label: "onWidgetLoad",
    fixture: "widgetLoad",
    mockAction: "widgetLoad"
  },
  chatMessage: {
    label: "chat message",
    fixture: "chatMessage",
    mockAction: "eventReceived"
  },
  follow: {
    label: "follow",
    fixture: "follow",
    mockAction: "eventReceived"
  },
  subscriber: {
    label: "subscriber",
    fixture: "subscriber",
    mockAction: "eventReceived"
  },
  tip: {
    label: "tip",
    fixture: "tip",
    mockAction: "eventReceived"
  },
  cheer: {
    label: "cheer",
    fixture: "cheer",
    mockAction: "eventReceived"
  },
  kvstoreUpdate: {
    label: "kvstore:update",
    fixture: "kvstoreUpdate",
    mockAction: "eventReceived"
  }
};

const IMPORT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const IMPORT_PREVIEW_OPTION_VALUE = "__import_preview__";
const CRC32_TABLE = createCrc32Table();

const state = {
  widgets: [],
  selectedWidget: null,
  selectedManifest: null,
  selectedManifestUrl: null,
  importPreview: null,
  registry: null,
  fieldsSchema: {},
  fieldData: {},
  validationResults: [],
  debugEntries: [],
  debugMode: true,
  responsive: {
    preset: "1280x720",
    zoom: 0.75,
    background: "gray"
  },
  seFixtures: {},
  twitchPredictionFixtures: {},
  prediction: createDefaultPredictionState(),
  worker: {
    interceptWebSocket: true,
    workerUrl: "",
    replayMode: "welcome",
    connectionLogCount: 0,
    openConnections: new Map(),
    bridgeV2: { epoch: "lab-" + crypto.randomUUID(), revision: 0, prediction: null, seen: [], cursor: null, watermark: null },
    helixV2: null,
    eventClock: 0n
  },
  overlays: {
    activeId: "A",
    deliveryTarget: "all",
    hiddenDeliveryMode: "deliver",
    instances: {
      A: {
        id: "A",
        hidden: false,
        loaded: true
      },
      B: null
    }
  },
  loadedWidgetDocument: null,
  chat: {
    lastPayload: null,
    history: [],
    pending: []
  },
  frameReady: false,
  activePayloadType: "widgetLoad",
  payloadDrafts: {},
  logCount: 0
};

const elements = {};
let seStoreHost;
let predictionWindowTimer = null;
let resultSceneScenarioId = 0;
let obsView;

function initializeSEStore() {
  let storage;
  try { storage = window.localStorage; }
  catch (error) { writeLog("warn", "lab", "Browser storage unavailable", { error: error.message }); }
  seStoreHost = createSEStoreHost({
    getFrames: () => ["A", "B"].map(getOverlayFrame).filter(Boolean),
    storage,
    log: (level, message, data) => writeLog(level, "lab", message, data)
  });
  window.addEventListener("storage", (event) => seStoreHost.handleStorageEvent(event));
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  setupCollapsibleSections();
  bindEvents();
  initializeSEStore();
  obsView = initializeOBSView({
    onResize: applyResponsiveMode,
    log: (level, message, data) => writeLog(level, "lab", message, data)
  });
  writeLog("info", "lab", "Inicializando laboratorio");

  try {
    await Promise.all([
      loadSEFixtures(),
      loadTwitchPredictionFixtures()
    ]);
    renderPredictionControls();
    renderWorkerControls();
    renderOverlayStatus();
    renderChatHistory();
    renderChatPayload();
    applyDebugMode();
    applyResponsiveMode();
    await loadRegistry();
    setStatus("Listo");
  } catch (error) {
    setStatus("Error al cargar");
    writeLog("error", "lab", error.message, error);
  }
}

function bindElements() {
  elements.status = document.querySelector("#appStatus");
  elements.widgetSelect = document.querySelector("#widgetSelect");
  elements.widgetMeta = document.querySelector("#widgetMeta");
  elements.chatMessageInput = document.querySelector("#chatMessageInput");
  elements.chatProfileSelect = document.querySelector("#chatProfileSelect");
  elements.chatSendStreamerButton = document.querySelector("#chatSendStreamerButton");
  elements.chatSendViewerButton = document.querySelector("#chatSendViewerButton");
  elements.chatSendActionButton = document.querySelector("#chatSendActionButton");
  elements.chatEnterToggle = document.querySelector("#chatEnterToggle");
  elements.chatParseEmotesToggle = document.querySelector("#chatParseEmotesToggle");
  elements.chatBroadcastToggle = document.querySelector("#chatBroadcastToggle");
  elements.chatCopyPayloadButton = document.querySelector("#chatCopyPayloadButton");
  elements.chatHistoryCount = document.querySelector("#chatHistoryCount");
  elements.chatHistoryList = document.querySelector("#chatHistoryList");
  elements.chatLastPayload = document.querySelector("#chatLastPayload");
  elements.validateWidgetsButton = document.querySelector("#validateWidgetsButton");
  elements.validationSummary = document.querySelector("#validationSummary");
  elements.validationResults = document.querySelector("#validationResults");
  elements.importWidgetId = document.querySelector("#importWidgetId");
  elements.importWidgetName = document.querySelector("#importWidgetName");
  elements.importWidgetDescription = document.querySelector("#importWidgetDescription");
  elements.importWidgetWidth = document.querySelector("#importWidgetWidth");
  elements.importWidgetHeight = document.querySelector("#importWidgetHeight");
  elements.importWidgetHtml = document.querySelector("#importWidgetHtml");
  elements.importWidgetCss = document.querySelector("#importWidgetCss");
  elements.importWidgetJs = document.querySelector("#importWidgetJs");
  elements.importWidgetFields = document.querySelector("#importWidgetFields");
  elements.importPreviewButton = document.querySelector("#importPreviewButton");
  elements.importDownloadButton = document.querySelector("#importDownloadButton");
  elements.importCopyStructureButton = document.querySelector("#importCopyStructureButton");
  elements.importStatus = document.querySelector("#importStatus");
  elements.debugModeToggle = document.querySelector("#debugModeToggle");
  elements.copyDebugReportButton = document.querySelector("#copyDebugReportButton");
  elements.viewportPresetSelect = document.querySelector("#viewportPresetSelect");
  elements.zoomSelect = document.querySelector("#zoomSelect");
  elements.previewBackgroundSelect = document.querySelector("#previewBackgroundSelect");
  elements.reloadButton = document.querySelector("#reloadWidgetButton");
  elements.seActionButtons = Array.from(document.querySelectorAll("[data-se-action]"));
  elements.clearLogsButton = document.querySelector("#clearLogsButton");
  elements.eventPayload = document.querySelector("#eventPayload");
  elements.payloadError = document.querySelector("#payloadError");
  elements.payloadTypeLabel = document.querySelector("#payloadTypeLabel");
  elements.predictionTwitchValidMode = document.querySelector("#predictionTwitchValidMode");
  elements.predictionStressMode = document.querySelector("#predictionStressMode");
  elements.predictionTitle = document.querySelector("#predictionTitle");
  elements.predictionDuration = document.querySelector("#predictionDuration");
  elements.predictionOutcomeCount = document.querySelector("#predictionOutcomeCount");
  elements.predictionCountButtons = Array.from(document.querySelectorAll("[data-prediction-count]"));
  elements.predictionValidation = document.querySelector("#predictionValidation");
  elements.predictionWinningOutcome = document.querySelector("#predictionWinningOutcome");
  elements.predictionOutcomes = document.querySelector("#predictionOutcomes");
  elements.predictionVotePattern = document.querySelector("#predictionVotePattern");
  elements.predictionVoteFeedback = document.querySelector("#predictionVoteFeedback");
  elements.predictionApplyVotePatternButton = document.querySelector("#predictionApplyVotePatternButton");
  elements.predictionSendProgressButton = document.querySelector("#predictionSendProgressButton");
  elements.predictionNormalProgressButton = document.querySelector("#predictionNormalProgressButton");
  elements.predictionCreateButton = document.querySelector("#predictionCreateButton");
  elements.predictionBeginNormalButton = document.querySelector("#predictionBeginNormalButton");
  elements.predictionBeginTenButton = document.querySelector("#predictionBeginTenButton");
  elements.predictionBeginOneSecondButton = document.querySelector("#predictionBeginOneSecondButton");
  elements.predictionActiveExpiredButton = document.querySelector("#predictionActiveExpiredButton");
  elements.predictionProgressExpiredButton = document.querySelector("#predictionProgressExpiredButton");
  elements.predictionVoteOneButton = document.querySelector("#predictionVoteOneButton");
  elements.predictionVoteTwoButton = document.querySelector("#predictionVoteTwoButton");
  elements.predictionVoteRandomButton = document.querySelector("#predictionVoteRandomButton");
  elements.predictionLockButton = document.querySelector("#predictionLockButton");
  elements.predictionLockNoEndButton = document.querySelector("#predictionLockNoEndButton");
  elements.predictionLockWaitFadeButton = document.querySelector("#predictionLockWaitFadeButton");
  elements.predictionEndLateLockButton = document.querySelector("#predictionEndLateLockButton");
  elements.predictionEndNoLockButton = document.querySelector("#predictionEndNoLockButton");
  elements.predictionEndOneButton = document.querySelector("#predictionEndOneButton");
  elements.predictionEndTwoButton = document.querySelector("#predictionEndTwoButton");
  elements.predictionResolveWinnerButton = document.querySelector("#predictionResolveWinnerButton");
  elements.predictionCancelButton = document.querySelector("#predictionCancelButton");
  elements.predictionEndCanceledButton = document.querySelector("#predictionEndCanceledButton");
  elements.predictionResetButton = document.querySelector("#predictionResetButton");
  elements.predictionResetLabStateButton = document.querySelector("#predictionResetLabStateButton");
  elements.predictionStateSummary = document.querySelector("#predictionStateSummary");
  elements.workerInterceptToggle = document.querySelector("#workerInterceptToggle");
  elements.workerUrlInput = document.querySelector("#workerUrlInput");
  elements.workerReplayMode = document.querySelector("#workerReplayMode");
  elements.workerWelcomeButton = document.querySelector("#workerWelcomeButton");
  elements.workerErrorButton = document.querySelector("#workerErrorButton");
  elements.workerBeginButton = document.querySelector("#workerBeginButton");
  elements.workerProgressButton = document.querySelector("#workerProgressButton");
  elements.workerLockButton = document.querySelector("#workerLockButton");
  elements.workerEndButton = document.querySelector("#workerEndButton");
  elements.workerReplayLastButton = document.querySelector("#workerReplayLastButton");
  elements.workerReplayCurrentButton = document.querySelector("#workerReplayCurrentButton");
  elements.workerReplayHistoryButton = document.querySelector("#workerReplayHistoryButton");
  elements.workerConnectionCount = document.querySelector("#workerConnectionCount");
  elements.workerConnectionList = document.querySelector("#workerConnectionList");
  elements.overlayActiveSelect = document.querySelector("#overlayActiveSelect");
  elements.overlayDeliveryTarget = document.querySelector("#overlayDeliveryTarget");
  elements.overlayHiddenDeliveryMode = document.querySelector("#overlayHiddenDeliveryMode");
  elements.overlayHideButton = document.querySelector("#overlayHideButton");
  elements.overlayShowButton = document.querySelector("#overlayShowButton");
  elements.overlayRefreshButton = document.querySelector("#overlayRefreshButton");
  elements.overlayDeactivateButton = document.querySelector("#overlayDeactivateButton");
  elements.overlayActivateButton = document.querySelector("#overlayActivateButton");
  elements.overlayDuplicateButton = document.querySelector("#overlayDuplicateButton");
  elements.overlayReloadBLockedButton = document.querySelector("#overlayReloadBLockedButton");
  elements.overlayEndHiddenButton = document.querySelector("#overlayEndHiddenButton");
  elements.overlayReconnectExpiredButton = document.querySelector("#overlayReconnectExpiredButton");
  elements.overlayResultSceneButton = document.querySelector("#overlayResultSceneButton");
  elements.overlayStatus = document.querySelector("#overlayStatus");
  elements.fieldsList = document.querySelector("#fieldsList");
  elements.previewShell = document.querySelector("#previewShell");
  elements.iframeViewport = document.querySelector("#iframeViewport");
  elements.frame = document.querySelector("#widgetFrame");
  elements.logList = document.querySelector("#logList");
  elements.logCount = document.querySelector("#logCount");
}

function bindEvents() {
  elements.widgetSelect.addEventListener("change", () => {
    if (elements.widgetSelect.value === IMPORT_PREVIEW_OPTION_VALUE) {
      return;
    }

    loadWidget(elements.widgetSelect.value);
  });

  elements.chatSendStreamerButton.addEventListener("click", () => {
    sendChatMessage("streamer");
  });
  elements.chatSendViewerButton.addEventListener("click", () => {
    sendChatMessage(elements.chatProfileSelect.value || "viewer");
  });
  elements.chatSendActionButton.addEventListener("click", () => {
    sendChatMessage(elements.chatProfileSelect.value || "viewer", { isAction: true });
  });
  elements.chatMessageInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !elements.chatEnterToggle.checked) {
      return;
    }

    event.preventDefault();
    sendChatMessage(elements.chatProfileSelect.value || "viewer");
  });
  elements.chatCopyPayloadButton.addEventListener("click", copyLastChatPayload);

  elements.validateWidgetsButton.addEventListener("click", validateWidgets);
  elements.importPreviewButton.addEventListener("click", previewImportedWidget);
  elements.importDownloadButton.addEventListener("click", downloadImportedWidgetPackage);
  elements.importCopyStructureButton.addEventListener("click", copyImportedFolderStructure);
  elements.debugModeToggle.addEventListener("change", () => {
    state.debugMode = elements.debugModeToggle.checked;
    applyDebugMode();
  });
  elements.copyDebugReportButton.addEventListener("click", copyDebugReport);
  elements.viewportPresetSelect.addEventListener("change", () => {
    state.responsive.preset = elements.viewportPresetSelect.value;
    applyResponsiveMode();
  });
  elements.zoomSelect.addEventListener("change", () => {
    state.responsive.zoom = Number(elements.zoomSelect.value);
    applyResponsiveMode();
  });
  elements.previewBackgroundSelect.addEventListener("change", () => {
    state.responsive.background = elements.previewBackgroundSelect.value;
    applyResponsiveMode();
  });

  elements.reloadButton.addEventListener("click", () => {
    if (state.importPreview) {
      previewImportedWidget();
      return;
    }

    if (state.selectedWidget) {
      loadWidget(state.selectedWidget.id);
    }
  });

  for (const button of elements.seActionButtons) {
    button.addEventListener("click", () => {
      handleSEAction(button.dataset.seAction);
    });
  }

  elements.eventPayload.addEventListener("input", () => {
    state.payloadDrafts[state.activePayloadType] = elements.eventPayload.value;
    validatePayloadEditor();
  });

  elements.predictionTwitchValidMode.addEventListener("change", () => setPredictionMode("twitch"));
  elements.predictionStressMode.addEventListener("change", () => setPredictionMode("stress"));

  elements.predictionTitle.addEventListener("input", () => {
    state.prediction.title = elements.predictionTitle.value;
    renderPredictionValidation();
  });

  elements.predictionDuration.addEventListener("input", () => {
    state.prediction.durationSeconds = clampInteger(elements.predictionDuration.value, 1, 86400);
    renderPredictionValidation();
  });

  elements.predictionOutcomeCount.addEventListener("change", () => {
    setPredictionOutcomeCount(elements.predictionOutcomeCount.value);
  });

  elements.predictionWinningOutcome.addEventListener("change", () => {
    state.prediction.winningOutcomeId = elements.predictionWinningOutcome.value || null;
    renderPredictionStateSummary();
  });

  elements.predictionOutcomes.addEventListener("input", handlePredictionOutcomeInput);
  for (const button of elements.predictionCountButtons) {
    button.addEventListener("click", () => setPredictionOutcomeCount(button.dataset.predictionCount));
  }
  elements.predictionApplyVotePatternButton.addEventListener("click", applySelectedVotePattern);
  elements.predictionSendProgressButton.addEventListener("click", sendPredictionProgressWithCurrentVotes);
  elements.predictionNormalProgressButton.addEventListener("click", sendPredictionProgressWithCurrentVotes);
  elements.predictionCreateButton.addEventListener("click", createPrediction);
  elements.predictionBeginNormalButton.addEventListener("click", beginNormalPrediction);
  elements.predictionBeginTenButton.addEventListener("click", beginTenOutcomePrediction);
  elements.predictionBeginOneSecondButton.addEventListener("click", beginOneSecondStressPrediction);
  elements.predictionActiveExpiredButton.addEventListener("click", forceActiveExpiredPrediction);
  elements.predictionProgressExpiredButton.addEventListener("click", progressExpiredPrediction);
  elements.predictionVoteOneButton.addEventListener("click", () => addVotesToOutcome(0));
  elements.predictionVoteTwoButton.addEventListener("click", () => addVotesToOutcome(1));
  elements.predictionVoteRandomButton.addEventListener("click", addRandomPredictionVotes);
  elements.predictionLockButton.addEventListener("click", lockPrediction);
  elements.predictionLockNoEndButton.addEventListener("click", lockPredictionWithoutEnd);
  elements.predictionLockWaitFadeButton.addEventListener("click", lockPredictionAndWaitFade);
  elements.predictionEndLateLockButton.addEventListener("click", endAfterLateLock);
  elements.predictionEndNoLockButton.addEventListener("click", endWithoutPriorLock);
  elements.predictionEndOneButton.addEventListener("click", () => endPrediction(0));
  elements.predictionEndTwoButton.addEventListener("click", () => endPrediction(1));
  elements.predictionResolveWinnerButton.addEventListener("click", resolvePredictionWithSelectedWinner);
  elements.predictionCancelButton.addEventListener("click", cancelPrediction);
  elements.predictionEndCanceledButton.addEventListener("click", cancelPrediction);
  elements.predictionResetButton.addEventListener("click", resetPrediction);
  elements.predictionResetLabStateButton.addEventListener("click", resetPredictionLabState);

  elements.workerInterceptToggle.addEventListener("change", () => {
    state.worker.interceptWebSocket = elements.workerInterceptToggle.checked;
    sendWorkerConfig();
  });

  elements.workerUrlInput.addEventListener("input", () => {
    state.worker.workerUrl = elements.workerUrlInput.value.trim();
    sendWorkerConfig();
  });

  elements.workerReplayMode.addEventListener("change", () => {
    state.worker.replayMode = elements.workerReplayMode.value;
    sendWorkerConfig();
  });

  elements.workerWelcomeButton.addEventListener("click", sendWorkerWelcome);
  elements.workerErrorButton.addEventListener("click", sendWorkerBridgeError);
  elements.workerBeginButton.addEventListener("click", () => sendWorkerPrediction("begin"));
  elements.workerProgressButton.addEventListener("click", () => sendWorkerPrediction("progress"));
  elements.workerLockButton.addEventListener("click", () => sendWorkerPrediction("lock"));
  elements.workerEndButton.addEventListener("click", () => sendWorkerPrediction("end"));
  elements.workerReplayLastButton.addEventListener("click", replayWorkerLastPayload);
  elements.workerReplayCurrentButton.addEventListener("click", replayWorkerCurrentPrediction);
  elements.workerReplayHistoryButton.addEventListener("click", replayWorkerHistory);

  elements.overlayActiveSelect.addEventListener("change", () => setActiveOverlay(elements.overlayActiveSelect.value));
  elements.overlayDeliveryTarget.addEventListener("change", () => {
    setOverlayDeliveryTarget(elements.overlayDeliveryTarget.value);
  });
  elements.overlayHiddenDeliveryMode.addEventListener("change", () => {
    state.overlays.hiddenDeliveryMode = elements.overlayHiddenDeliveryMode.value;
    renderOverlayStatus();
    writeLog("info", "lab", `Overlay hidden mode: ${state.overlays.hiddenDeliveryMode}`, {
      hiddenDeliveryMode: state.overlays.hiddenDeliveryMode
    });
  });
  elements.overlayHideButton.addEventListener("click", () => hideOverlay(state.overlays.activeId));
  elements.overlayShowButton.addEventListener("click", () => showOverlay(state.overlays.activeId));
  elements.overlayRefreshButton.addEventListener("click", () => refreshOverlay(state.overlays.activeId));
  elements.overlayDeactivateButton.addEventListener("click", deactivateScene);
  elements.overlayActivateButton.addEventListener("click", activateScene);
  elements.overlayDuplicateButton.addEventListener("click", duplicateOverlayInstance);
  elements.overlayReloadBLockedButton.addEventListener("click", runReloadOverlayBWhileLockedScenario);
  elements.overlayEndHiddenButton.addEventListener("click", runEndWhileHiddenScenario);
  elements.overlayReconnectExpiredButton.addEventListener("click", runReconnectWhileActiveExpiredScenario);
  elements.overlayResultSceneButton.addEventListener("click", runResultSceneSwitchScenario);

  elements.clearLogsButton.addEventListener("click", clearLogs);
  attachOverlayFrameLoadHandler(elements.frame, "A");

  window.addEventListener("message", handleWidgetMessage);
}

function attachOverlayFrameLoadHandler(frame, overlayId) {
  if (!frame || frame.dataset.overlayLoadHandler === "true") {
    return;
  }

  frame.dataset.overlayLoadHandler = "true";
  frame.addEventListener("load", () => {
    state.frameReady = true;

    if (state.selectedWidget) {
      writeLog("info", "lab", `Iframe cargado: ${state.selectedWidget.id}`, {
        overlayId
      });
      sendWorkerConfig(overlayId);
      flushPendingChatMessages();
    }
  });
}

function setupCollapsibleSections() {
  const sections = Array.from(document.querySelectorAll(".control-panel > .panel-section"));
  const navigation = document.querySelector("#toolSelect");
  for (const section of sections.slice(1)) {
    const option = document.createElement("option");
    option.value = section.dataset.panelTitle;
    option.textContent = getPanelTitle(section);
    navigation.append(option);
  }
  navigation.addEventListener("change", () => {
    const selected = sections.find((section) => section.dataset.panelTitle === navigation.value);
    if (!selected) return;
    for (const section of sections.slice(1)) {
      const collapsed = section !== selected;
      section.querySelector(".panel-content").hidden = collapsed;
      section.classList.toggle("is-collapsed", collapsed);
      section.querySelector(".panel-toggle").setAttribute("aria-expanded", String(!collapsed));
    }
    selected.scrollIntoView({ block: "start" });
    navigation.value = "";
  });

  sections.forEach((section) => {
    if (section.dataset.collapsibleReady === "true") {
      return;
    }

    const title = getPanelTitle(section);
    const content = document.createElement("div");
    const toggle = document.createElement("button");
    const collapsed = section.dataset.startCollapsed === "true";

    content.className = "panel-content";

    while (section.firstChild) {
      content.append(section.firstChild);
    }

    toggle.type = "button";
    toggle.className = "panel-toggle";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = title;
    content.hidden = collapsed;
    section.classList.toggle("is-collapsed", collapsed);
    section.append(toggle, content);
    section.dataset.collapsibleReady = "true";

    toggle.addEventListener("click", () => {
      const nextCollapsed = !content.hidden;
      content.hidden = nextCollapsed;
      section.classList.toggle("is-collapsed", nextCollapsed);
      toggle.setAttribute("aria-expanded", String(!nextCollapsed));
    });
  });
}

function focusWidgetControls(widgetId) {
  const section = document.querySelector(".prediction-panel");
  const content = section.querySelector(".panel-content");
  const expanded = ["prediccion", "prediccion-v2"].includes(widgetId);
  content.hidden = !expanded;
  section.classList.toggle("is-collapsed", !expanded);
  section.querySelector(".panel-toggle").setAttribute("aria-expanded", String(expanded));
  // A widget change should return to its main actions, even after editing a long form.
  document.querySelector(".control-panel").scrollTop = 0;
}

function getPanelTitle(section) {
  return section.dataset.panelTitle
    || section.querySelector("h2")?.textContent?.trim()
    || section.getAttribute("aria-label")
    || section.querySelector(".field-label")?.textContent?.trim()
    || "Panel";
}

function sendChatMessage(profileKey, options = {}) {
  const text = elements.chatMessageInput.value.trim();

  if (!text) {
    writeLog("warn", "chat", "No se envio chat: mensaje vacio");
    return;
  }

  const profile = CHAT_USER_PROFILES[profileKey] || CHAT_USER_PROFILES.viewer;
  const payload = buildSEChatMessage({
    text,
    profile,
    isAction: options.isAction === true,
    parseEmotes: elements.chatParseEmotesToggle.checked
  });
  const broadcast = elements.chatBroadcastToggle.checked;
  const modes = state.frameReady
    ? deliverChatPayload(payload, broadcast)
    : queueChatPayload(payload, broadcast);

  state.chat.lastPayload = payload;
  state.chat.history.unshift({
    timestamp: new Date().toISOString(),
    profile: profile.label,
    text: payload.detail.event.data.text,
    isAction: payload.detail.event.data.isAction,
    emoteCount: payload.detail.event.data.emotes.length
  });
  state.chat.history = state.chat.history.slice(0, 30);

  renderChatPayload();
  renderChatHistory();
  writeLog("info", "chat", "Chat message emitted as StreamElements onEventReceived", {
    dispatchModes: modes,
    targetCount: modes.length,
    payload
  });
}

function deliverChatPayload(payload, broadcast = false) {
  const frames = broadcast
    ? Array.from(document.querySelectorAll("iframe"))
    : [elements.frame];
  const modes = [];

  for (const frame of frames) {
    if (!frame?.contentWindow) {
      continue;
    }

    modes.push(emitSEChatMessage(frame.contentWindow, payload));
  }

  return modes;
}

function queueChatPayload(payload, broadcast = false) {
  state.chat.pending.push({ payload, broadcast });
  return ["queued-until-iframe-load"];
}

function flushPendingChatMessages() {
  if (state.chat.pending.length === 0) {
    return;
  }

  const pending = state.chat.pending.splice(0);

  for (const item of pending) {
    const modes = deliverChatPayload(item.payload, item.broadcast);
    writeLog("info", "chat", "Queued chat message emitted as StreamElements onEventReceived", {
      dispatchModes: modes,
      targetCount: modes.length,
      payload: item.payload
    });
  }
}

async function copyLastChatPayload() {
  if (!state.chat.lastPayload) {
    writeLog("warn", "chat", "No hay payload de chat para copiar");
    return;
  }

  try {
    await copyTextToClipboard(stringifyPayload(state.chat.lastPayload));
    writeLog("info", "chat", "Ultimo payload de chat copiado");
  } catch (error) {
    window.__LAST_CHAT_PAYLOAD__ = state.chat.lastPayload;
    writeLog("warn", "chat", "Payload de chat generado; copia automatica bloqueada", {
      error: serializeLogData(error),
      payload: state.chat.lastPayload
    });
  }
}

function renderChatPayload() {
  elements.chatLastPayload.value = state.chat.lastPayload
    ? stringifyPayload(state.chat.lastPayload)
    : "";
}

function renderChatHistory() {
  elements.chatHistoryList.replaceChildren();
  elements.chatHistoryCount.textContent = String(state.chat.history.length);

  for (const item of state.chat.history) {
    const row = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");

    row.className = "chat-history-entry";
    title.textContent = `${item.isAction ? "/me " : ""}${item.profile}`;
    meta.textContent = `${item.text}${item.emoteCount ? ` (${item.emoteCount} emotes)` : ""}`;
    row.append(title, meta);
    elements.chatHistoryList.append(row);
  }
}

async function loadSEFixtures() {
  const entries = await Promise.all(
    Object.entries(SE_FIXTURE_URLS).map(async ([key, url]) => [key, await fetchJson(url)])
  );

  state.seFixtures = Object.fromEntries(entries);
}

async function loadTwitchPredictionFixtures() {
  const entries = await Promise.all(
    Object.entries(TWITCH_PREDICTION_FIXTURE_URLS).map(async ([key, url]) => [key, await fetchJson(url)])
  );

  state.twitchPredictionFixtures = Object.fromEntries(entries);
}

async function loadRegistry() {
  setStatus("Cargando registry");
  const registry = await fetchJson(REGISTRY_URL);
  state.registry = registry;
  state.widgets = Array.isArray(registry.widgets) ? registry.widgets : [];

  if (state.widgets.length === 0) {
    throw new Error("widgets/registry.json no contiene widgets");
  }

  renderWidgetOptions();
  const preferredId = obsView?.preferredWidgetId;
  const firstWidget = state.widgets.find((widget) => widget.id === preferredId) || state.widgets[0];
  await loadWidget(firstWidget.id);
}

async function validateWidgets() {
  elements.validationSummary.textContent = "Validando widgets...";
  elements.validationResults.replaceChildren();
  setStatus("Validando widgets");

  try {
    const registry = await fetchJson(REGISTRY_URL);
    state.registry = registry;
    state.widgets = Array.isArray(registry.widgets) ? registry.widgets : [];
    renderWidgetOptions();
    const results = [];

    if (!Array.isArray(registry.widgets)) {
      results.push(createValidationResult("error", "registry", "widgets/registry.json debe contener un array widgets."));
    } else if (registry.widgets.length === 0) {
      results.push(createValidationResult("error", "registry", "widgets/registry.json no contiene widgets."));
    }

    for (const widget of state.widgets) {
      results.push(...await validateWidgetEntry(widget));
    }

    state.validationResults = results;
    renderValidationResults(results);
    setStatus("Validacion completada");
  } catch (error) {
    const results = [createValidationResult("error", "registry", `No se pudo cargar widgets/registry.json: ${error.message}`)];
    state.validationResults = results;
    renderValidationResults(results);
    setStatus("Error de validacion");
  }
}

async function validateWidgetEntry(widget) {
  const widgetId = widget?.id || "sin-id";
  const results = [];

  if (!widget || typeof widget !== "object") {
    return [createValidationResult("error", widgetId, "La entrada del registry no es un objeto.")];
  }

  for (const field of REQUIRED_WIDGET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(widget, field) || widget[field] === "" || typeof widget[field] === "undefined") {
      results.push(createValidationResult("error", widgetId, `Falta el campo obligatorio ${field}.`));
    }
  }

  if (!Number.isFinite(Number(widget.width)) || Number(widget.width) < 1) {
    results.push(createValidationResult("error", widgetId, "width debe ser un numero positivo."));
  }

  if (!Number.isFinite(Number(widget.height)) || Number(widget.height) < 1) {
    results.push(createValidationResult("error", widgetId, "height debe ser un numero positivo."));
  }

  const fileChecks = [
    ["html", "text"],
    ["css", "text"],
    ["js", "text"],
    ["fields", "json"],
    ["mocks", "json"]
  ];

  for (const [field, type] of fileChecks) {
    if (!widget[field]) {
      continue;
    }

    try {
      const url = resolveWidgetUrl(widget[field]);

      if (type === "json") {
        await fetchJson(url);
      } else {
        await fetchText(url);
      }

      results.push(createValidationResult("ok", widgetId, `${field} carga correctamente: ${widget[field]}`));
    } catch (error) {
      results.push(createValidationResult("error", widgetId, `${field} no carga: ${widget[field]} (${error.message})`));
    }
  }

  return results;
}

function createValidationResult(level, widgetId, message) {
  return {
    level,
    widgetId,
    message,
    timestamp: new Date().toISOString()
  };
}

function renderValidationResults(results) {
  const errorCount = results.filter((result) => result.level === "error").length;
  const okCount = results.filter((result) => result.level === "ok").length;
  elements.validationSummary.textContent = `${errorCount} errores, ${okCount} comprobaciones correctas`;
  elements.validationSummary.className = `validation-summary ${errorCount > 0 ? "has-errors" : "is-ok"}`;
  elements.validationResults.replaceChildren();

  for (const result of results) {
    const item = document.createElement("li");
    item.className = `validation-result validation-${result.level}`;
    item.textContent = `[${result.widgetId}] ${result.message}`;
    elements.validationResults.append(item);
  }
}

function renderWidgetOptions() {
  elements.widgetSelect.replaceChildren();

  for (const widget of state.widgets) {
    const option = document.createElement("option");
    option.value = widget.id;
    option.textContent = widget.name || widget.id;
    elements.widgetSelect.append(option);
  }
}

function showImportPreviewOption(manifest) {
  let option = elements.widgetSelect.querySelector(`option[value="${IMPORT_PREVIEW_OPTION_VALUE}"]`);

  if (!option) {
    option = document.createElement("option");
    option.value = IMPORT_PREVIEW_OPTION_VALUE;
    option.disabled = true;
    elements.widgetSelect.prepend(option);
  }

  option.textContent = `Import preview: ${manifest.name || manifest.id}`;
  elements.widgetSelect.value = IMPORT_PREVIEW_OPTION_VALUE;
}

function clearImportPreviewOption() {
  elements.widgetSelect.querySelector(`option[value="${IMPORT_PREVIEW_OPTION_VALUE}"]`)?.remove();
}

async function previewImportedWidget() {
  resultSceneScenarioId += 1;
  let draft;

  try {
    draft = readImportDraft();
  } catch (error) {
    setImportStatus(error.message, "error");
    writeLog("error", "import", "Import widget no valido", error);
    return;
  }

  setImportStatus("Preparando preview sin guardar...", "info");
  setStatus("Preparando import preview");

  try {
    const harnessScripts = await Promise.all(HARNESS_URLS.map((url) => fetchText(url)));
    const fieldData = extractFieldData(draft.fieldsSchema);

    state.frameReady = false;
    state.importPreview = draft;
    state.selectedWidget = draft.manifest;
    state.selectedManifest = draft.manifest;
    state.selectedManifestUrl = null;
    state.fieldsSchema = draft.fieldsSchema;
    state.fieldData = fieldData;
    state.loadedWidgetDocument = {
      manifest: draft.manifest,
      html: draft.html,
      css: draft.css,
      script: draft.script,
      fieldsSchema: draft.fieldsSchema,
      fieldData,
      harnessScripts
    };
    resetOverlayInstancesForWidgetLoad();

    renderWidgetMeta(draft.manifest);
    showImportPreviewOption(draft.manifest);
    renderFields(draft.fieldsSchema, fieldData);
    resetPayloadDrafts();
    renderIframe({ ...state.loadedWidgetDocument, frame: elements.frame, overlayId: "A" });
    applyPreviewDimensions(draft.manifest.width, draft.manifest.height, state.responsive.zoom);

    setStatus(`Import preview: ${draft.manifest.name}`);
    setImportStatus("Preview generado. No se ha guardado nada en GitHub ni en el repo.", "ok");
    writeLog("info", "import", `Preview importado sin guardar: ${draft.manifest.id}`, {
      id: draft.manifest.id,
      size: `${draft.manifest.width}x${draft.manifest.height}`,
      files: draft.files.map((file) => file.path)
    });
  } catch (error) {
    setStatus("Error en import preview");
    setImportStatus(`No se pudo crear el preview: ${error.message}`, "error");
    writeLog("error", "import", "Error al previsualizar widget importado", error);
  }
}

function downloadImportedWidgetPackage() {
  let draft;

  try {
    draft = readImportDraft();
  } catch (error) {
    setImportStatus(error.message, "error");
    writeLog("error", "import", "No se pudo generar el paquete", error);
    return;
  }

  try {
    const blob = createZipBlob(draft.files);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${draft.manifest.id}-widget-package.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    setImportStatus("Paquete descargado. Extraelo en el repo y commitea los archivos para guardarlo de verdad.", "ok");
    writeLog("info", "import", `Paquete generado: ${link.download}`, {
      files: draft.files.map((file) => file.path)
    });
  } catch (error) {
    setImportStatus(`No se pudo descargar el paquete: ${error.message}`, "error");
    writeLog("error", "import", "Error al descargar paquete de widget", error);
  }
}

async function copyImportedFolderStructure() {
  let draft;

  try {
    draft = readImportDraft();
  } catch (error) {
    setImportStatus(error.message, "error");
    writeLog("error", "import", "No se pudo copiar la estructura", error);
    return;
  }

  const structure = buildImportFolderStructure(draft);

  try {
    await copyTextToClipboard(structure);
    setImportStatus("Estructura copiada. Anade esos archivos al repo y commitea para persistir.", "ok");
    writeLog("info", "import", `Estructura copiada: widgets/${draft.manifest.id}/`, {
      registryEntry: draft.manifest
    });
  } catch (error) {
    window.__LAST_IMPORT_FOLDER_STRUCTURE__ = structure;
    setImportStatus("El navegador bloqueo la copia automatica. La estructura queda en __LAST_IMPORT_FOLDER_STRUCTURE__.", "error");
    writeLog("warn", "import", "Estructura generada; copia automatica bloqueada", {
      error: serializeLogData(error),
      structure
    });
  }
}

function readImportDraft() {
  const errors = [];
  const id = elements.importWidgetId.value.trim();
  const name = elements.importWidgetName.value.trim();
  const description = elements.importWidgetDescription.value.trim();
  const width = parseImportDimension(elements.importWidgetWidth.value, "width", errors);
  const height = parseImportDimension(elements.importWidgetHeight.value, "height", errors);
  const html = elements.importWidgetHtml.value;
  const css = elements.importWidgetCss.value;
  const script = elements.importWidgetJs.value;
  const fieldsRaw = elements.importWidgetFields.value.trim() || "{}";
  let fieldsSchema = {};

  if (!id) {
    errors.push("id es obligatorio.");
  } else if (!IMPORT_ID_PATTERN.test(id)) {
    errors.push("id solo puede usar minusculas, numeros y guiones, empezando por letra o numero.");
  }

  if (!name) {
    errors.push("name es obligatorio.");
  }

  try {
    fieldsSchema = JSON.parse(fieldsRaw);

    if (!fieldsSchema || (typeof fieldsSchema !== "object" && !Array.isArray(fieldsSchema))) {
      errors.push("fields JSON debe ser un objeto o array JSON.");
    }
  } catch (error) {
    errors.push(`fields JSON invalido: ${error.message}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const manifest = buildImportedWidgetManifest({
    id,
    name,
    description,
    width,
    height
  });
  const draft = {
    manifest,
    html,
    css,
    script,
    fieldsSchema
  };

  return {
    ...draft,
    files: buildImportedWidgetFiles(draft)
  };
}

function parseImportDimension(value, label, errors) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    errors.push(`${label} debe ser un numero positivo.`);
    return 1;
  }

  return parsed;
}

function buildImportedWidgetManifest({ id, name, description, width, height }) {
  return {
    id,
    name,
    description: description || "Widget importado manualmente.",
    version: "0.1.0",
    author: "manual-import",
    category: "imported",
    width,
    height,
    html: `widgets/${id}/widget.html`,
    css: `widgets/${id}/widget.css`,
    js: `widgets/${id}/widget.js`,
    fields: `widgets/${id}/fields.json`,
    mocks: `widgets/${id}/mocks/index.json`,
    notes: "Generado con Import widget. Para persistirlo, commitea estos archivos y registra la entrada en widgets/registry.json."
  };
}

function buildImportedWidgetFiles(draft) {
  const basePath = `widgets/${draft.manifest.id}`;
  const mocks = {
    events: [],
    notes: "Empty mocks index generated by Import widget."
  };

  return [
    {
      path: `${basePath}/widget.json`,
      content: `${stringifyPayload(draft.manifest)}\n`
    },
    {
      path: `${basePath}/widget.html`,
      content: ensureTrailingNewline(draft.html)
    },
    {
      path: `${basePath}/widget.css`,
      content: ensureTrailingNewline(draft.css)
    },
    {
      path: `${basePath}/widget.js`,
      content: ensureTrailingNewline(draft.script)
    },
    {
      path: `${basePath}/fields.json`,
      content: `${stringifyPayload(draft.fieldsSchema)}\n`
    },
    {
      path: `${basePath}/mocks/index.json`,
      content: `${stringifyPayload(mocks)}\n`
    }
  ];
}

function buildImportFolderStructure(draft) {
  return [
    `widgets/${draft.manifest.id}/`,
    "  widget.json",
    "  widget.html",
    "  widget.css",
    "  widget.js",
    "  fields.json",
    "  mocks/",
    "    index.json",
    "",
    "Registry entry to add in widgets/registry.json:",
    stringifyPayload(draft.manifest),
    "",
    "Real persistence requires committing these files to the repository."
  ].join("\n");
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function setImportStatus(message, level = "info") {
  elements.importStatus.textContent = message;
  elements.importStatus.className = `import-status ${level === "ok" ? "import-ok" : ""} ${level === "error" ? "import-error" : ""}`.trim();
}

async function loadWidget(widgetId) {
  resultSceneScenarioId += 1;
  const widget = state.widgets.find((item) => item.id === widgetId);

  if (!widget) {
    writeLog("error", "lab", `Widget no encontrado: ${widgetId}`);
    return;
  }

  setStatus(`Cargando ${widget.name || widget.id}`);
  state.frameReady = false;
  state.selectedWidget = widget;
  state.selectedManifest = widget;
  state.selectedManifestUrl = REGISTRY_URL;
  state.importPreview = null;
  clearImportPreviewOption();
  elements.widgetSelect.value = widget.id;
  focusWidgetControls(widget.id);

  try {
    const entryUrl = resolveWidgetUrl(widget.html);
    const styleUrl = resolveWidgetUrl(widget.css);
    const scriptUrl = resolveWidgetUrl(widget.js);
    const fieldsUrl = resolveWidgetUrl(widget.fields);

    const [html, css, script, fieldsSchema, ...harnessScripts] = await Promise.all([
      fetchText(entryUrl),
      fetchText(styleUrl),
      fetchText(scriptUrl),
      fetchJson(fieldsUrl),
      ...HARNESS_URLS.map((url) => fetchText(url))
    ]);

    state.fieldsSchema = fieldsSchema;
    state.fieldData = extractFieldData(fieldsSchema);
    state.loadedWidgetDocument = { manifest: widget, html, css, script, fieldsSchema, fieldData: state.fieldData, harnessScripts };
    resetOverlayInstancesForWidgetLoad();

    renderWidgetMeta(widget);
    renderFields(fieldsSchema, state.fieldData);
    resetPayloadDrafts();
    renderIframe({ ...state.loadedWidgetDocument, frame: elements.frame, overlayId: "A" });

    setStatus(`Cargado: ${widget.name || widget.id}`);
    writeLog("info", "lab", `Widget cargado: ${widget.id}`, {
      registry: REGISTRY_URL.pathname,
      entry: entryUrl.pathname,
      css: styleUrl.pathname,
      js: scriptUrl.pathname,
      fields: fieldsUrl.pathname,
      size: `${widget.width}x${widget.height}`
    });
  } catch (error) {
    setStatus("Error al cargar widget");
    writeLog("error", "lab", error.message, error);
  }
}

function renderWidgetMeta(widget) {
  obsView?.updateLink(widget.id);
  elements.widgetMeta.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = widget.name || widget.id;
  elements.widgetMeta.append(title);

  const description = document.createElement("span");
  description.textContent = `${widget.description || "Sin descripcion"} ${widget.version ? `v${widget.version}` : ""} ${widget.category ? `- ${widget.category}` : ""} ${widget.width && widget.height ? `- ${widget.width}x${widget.height}` : ""}`;
  elements.widgetMeta.append(description);
}

function renderFields(fieldsSchema, fieldData) {
  elements.fieldsList.replaceChildren();

  const keys = Object.keys(fieldData);

  if (keys.length === 0) {
    const empty = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = "fields";
    detail.textContent = "{}";
    empty.append(term, detail);
    elements.fieldsList.append(empty);
    return;
  }

  for (const key of keys) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    const schemaItem = Array.isArray(fieldsSchema)
      ? fieldsSchema.find((field) => field.name === key)
      : fieldsSchema[key];

    term.textContent = schemaItem?.label || key;
    detail.textContent = formatFieldValue(fieldData[key]);
    row.append(term, detail);
    elements.fieldsList.append(row);
  }
}

function resetPayloadDrafts() {
  const nextActiveType = SE_ACTIONS[state.activePayloadType] ? state.activePayloadType : "widgetLoad";
  state.payloadDrafts = {};

  for (const key of Object.keys(SE_ACTIONS)) {
    state.payloadDrafts[key] = stringifyPayload(buildSEPayload(key));
  }

  setActivePayload(nextActiveType);
}

function buildSEPayload(actionKey) {
  const action = SE_ACTIONS[actionKey];
  const fixture = cloneJson(state.seFixtures[action.fixture] || {});

  if (actionKey === "widgetLoad") {
    fixture.fieldData = cloneJson(state.fieldData);
    fixture.widget = {
      id: state.selectedManifest?.id || state.selectedWidget?.id || "demo",
      name: state.selectedManifest?.name || state.selectedWidget?.name || "Demo widget",
      version: state.selectedManifest?.version || "0.1.0"
    };
  }

  return fixture;
}

function setActivePayload(actionKey) {
  state.activePayloadType = actionKey;
  elements.eventPayload.value = state.payloadDrafts[actionKey] || stringifyPayload(buildSEPayload(actionKey));
  elements.payloadTypeLabel.textContent = SE_ACTIONS[actionKey].label;

  for (const button of elements.seActionButtons) {
    button.classList.toggle("is-active", button.dataset.seAction === actionKey);
  }

  validatePayloadEditor();
}

function handleSEAction(actionKey) {
  if (!SE_ACTIONS[actionKey]) {
    writeLog("error", "lab", `Accion StreamElements no soportada: ${actionKey}`);
    return;
  }

  state.payloadDrafts[state.activePayloadType] = elements.eventPayload.value;

  if (state.activePayloadType !== actionKey) {
    setActivePayload(actionKey);
  }

  const payload = parsePayloadEditor();

  if (!payload) {
    return;
  }

  state.payloadDrafts[actionKey] = stringifyPayload(payload);
  emitSEPayload(actionKey, payload);
}

function validatePayloadEditor() {
  try {
    JSON.parse(elements.eventPayload.value);
    clearPayloadError();
    return true;
  } catch (error) {
    setPayloadError(`JSON invalido: ${error.message}`);
    return false;
  }
}

function parsePayloadEditor() {
  try {
    clearPayloadError();
    return JSON.parse(elements.eventPayload.value);
  } catch (error) {
    setPayloadError(`JSON invalido: ${error.message}`);
    writeLog("error", "lab", "Payload JSON no valido", error);
    return null;
  }
}

function setPayloadError(message) {
  elements.payloadError.textContent = message;
  elements.payloadError.hidden = false;
}

function clearPayloadError() {
  elements.payloadError.textContent = "";
  elements.payloadError.hidden = true;
}

function applyDebugMode() {
  document.body.classList.toggle("debug-off", !state.debugMode);
  elements.debugModeToggle.checked = state.debugMode;
}

async function copyDebugReport() {
  const report = buildDebugReport();

  try {
    await copyTextToClipboard(report);
    writeLog("info", "lab", "Debug report copiado al portapapeles");
  } catch (error) {
    window.__LAST_DEBUG_REPORT__ = report;
    writeLog("warn", "lab", "Debug report generado; el navegador bloqueo la copia automatica", {
      error: serializeLogData(error),
      report
    });
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      copyTextFallback(text);
      return;
    }
  }

  copyTextFallback(text);
}

function copyTextFallback(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("document.execCommand('copy') no copio el texto");
  }
}

function buildDebugReport() {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    page: window.location.href,
    selectedWidget: state.selectedWidget,
    responsive: state.responsive,
    renderEnvironment: obsView?.report() || null,
    validationResults: state.validationResults,
    logs: state.debugEntries,
    workerConnections: Array.from(elements.workerConnectionList.querySelectorAll(".worker-connection-entry")).map((item) => item.textContent)
  }, null, 2);
}

function applyResponsiveMode() {
  if (obsView?.enabled) {
    applyPreviewDimensions(window.innerWidth, window.innerHeight, 1);
    return;
  }
  const [width, height] = state.responsive.preset.split("x").map((value) => Number.parseInt(value, 10));
  const zoom = Number(state.responsive.zoom) || 1;

  elements.viewportPresetSelect.value = state.responsive.preset;
  elements.zoomSelect.value = String(zoom);
  elements.previewBackgroundSelect.value = state.responsive.background;

  applyPreviewDimensions(width, height, zoom);
  applyPreviewBackground();
}

function applyPreviewDimensions(width, height, zoom) {
  for (const viewport of document.querySelectorAll(".iframe-viewport")) {
    viewport.style.width = `${width * zoom}px`;
    viewport.style.height = `${height * zoom}px`;
  }

  for (const frame of document.querySelectorAll("iframe[data-overlay-id]")) {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.transform = `scale(${zoom})`;
    frame.style.transformOrigin = "top left";
  }
}

function applyPreviewBackground() {
  elements.previewShell.classList.remove("preview-bg-transparent", "preview-bg-gray", "preview-bg-chroma", "preview-bg-dark");
  elements.previewShell.classList.add(`preview-bg-${state.responsive.background}`);
}

function resetOverlayInstancesForWidgetLoad() {
  const overlayB = getOverlayViewport("B");

  if (overlayB) {
    overlayB.remove();
  }

  clearOverlayConnections("A", "widget reload");
  clearOverlayConnections("B", "widget reload");
  state.overlays.activeId = "A";
  state.overlays.hiddenDeliveryMode = state.overlays.hiddenDeliveryMode || "deliver";
  state.overlays.instances = {
    A: {
      id: "A",
      hidden: false,
      loaded: true
    },
    B: null
  };
  elements.iframeViewport.classList.remove("is-overlay-hidden", "is-active-overlay");
  elements.iframeViewport.dataset.overlayId = "A";
  elements.frame.dataset.overlayId = "A";
  elements.frame.title = "Widget preview Overlay A";
  elements.frame.hidden = false;
  elements.iframeViewport.classList.add("is-active-overlay");
  renderOverlayStatus();
}

function getOverlayFrame(overlayId) {
  return document.querySelector(`iframe[data-overlay-id="${overlayId}"]`);
}

function getOverlayViewport(overlayId) {
  return document.querySelector(`.iframe-viewport[data-overlay-id="${overlayId}"]`);
}

function setActiveOverlay(overlayId) {
  if (overlayId === "B" && !state.overlays.instances.B) {
    duplicateOverlayInstance();
  }

  state.overlays.activeId = overlayId === "B" ? "B" : "A";
  document.querySelectorAll(".iframe-viewport").forEach((viewport) => {
    viewport.classList.toggle("is-active-overlay", viewport.dataset.overlayId === state.overlays.activeId);
  });
  elements.overlayActiveSelect.value = state.overlays.activeId;
  renderOverlayStatus();
  writeLog("info", "lab", `Overlay activo: ${state.overlays.activeId}`, {
    activeOverlay: state.overlays.activeId
  });
}

function setOverlayDeliveryTarget(target) {
  state.overlays.deliveryTarget = target;
  elements.overlayDeliveryTarget.value = target;
  renderOverlayStatus();
  writeLog("info", "lab", `Destino Worker cambiado a ${target}`, {
    overlayTarget: target,
    emitsPayload: false,
    replayActions: ["Replay last payload", "Replay current prediction", "Replay full history"]
  });
}

function renderOverlayStatus() {
  const overlays = ["A", "B"].map((id) => {
    const instance = state.overlays.instances[id];
    const connectionCount = countOpenMockConnections(id);

    if (!instance) {
      return `${id}: no creado`;
    }

    return `${id}: ${instance.hidden ? "hidden" : "visible"}, WS ${connectionCount}`;
  });

  elements.overlayActiveSelect.value = state.overlays.activeId;
  elements.overlayDeliveryTarget.value = state.overlays.deliveryTarget;
  elements.overlayHiddenDeliveryMode.value = state.overlays.hiddenDeliveryMode;
  elements.overlayStatus.textContent = `Activo ${state.overlays.activeId} | destino ${state.overlays.deliveryTarget} | hidden ${state.overlays.hiddenDeliveryMode} | ${overlays.join(" | ")}`;
}

function duplicateOverlayInstance() {
  const frame = ensureOverlayFrame("B", { recreate: true });

  if (!frame || !state.loadedWidgetDocument) {
    writeLog("warn", "lab", "No se pudo crear Overlay B: no hay widget cargado");
    return null;
  }

  state.overlays.instances.B = {
    id: "B",
    hidden: false,
    loaded: true
  };
  renderOverlayFromCache("B");
  setActiveOverlay("B");
  writeLog("info", "lab", "Overlay B creado como segunda instancia del widget", {
    selectedWidget: state.selectedWidget?.id || null,
    activeConnections: state.worker.openConnections.size
  });
  return frame;
}

function ensureOverlayFrame(overlayId, options = {}) {
  let viewport = getOverlayViewport(overlayId);
  let frame = getOverlayFrame(overlayId);

  if (!viewport) {
    viewport = document.createElement("div");
    viewport.className = "iframe-viewport overlay-viewport";
    viewport.dataset.overlayId = overlayId;
    elements.previewShell.append(viewport);
  }

  if (!frame || options.recreate) {
    frame?.remove();
    frame = document.createElement("iframe");
    if (overlayId === "A") {
      frame.id = "widgetFrame";
    }
    frame.title = `Widget preview Overlay ${overlayId}`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.dataset.overlayId = overlayId;
    viewport.append(frame);
    attachOverlayFrameLoadHandler(frame, overlayId);

    if (overlayId === "A") {
      elements.frame = frame;
    }
  }

  applyResponsiveMode();
  return frame;
}

function renderOverlayFromCache(overlayId) {
  const frame = ensureOverlayFrame(overlayId);

  if (!frame || !state.loadedWidgetDocument) {
    return;
  }

  state.overlays.instances[overlayId] = {
    id: overlayId,
    hidden: false,
    loaded: true
  };
  clearOverlayConnections(overlayId, "overlay render");
  renderIframe({ ...state.loadedWidgetDocument, frame, overlayId });
}

function refreshOverlay(overlayId) {
  const frame = ensureOverlayFrame(overlayId, { recreate: true });

  if (!frame || !state.loadedWidgetDocument) {
    writeLog("warn", "lab", `No se pudo refrescar Overlay ${overlayId}: no hay widget cargado`);
    return;
  }

  clearOverlayConnections(overlayId, "overlay refresh");
  renderIframe({ ...state.loadedWidgetDocument, frame, overlayId });
  showOverlay(overlayId, { silent: true });
  writeLog("info", "lab", `Overlay ${overlayId} destruido y recreado`, {
    action: "Refresh source",
    currentPredictionStatus: state.prediction.currentPredictionStatus
  });
}

function hideOverlay(overlayId, options = {}) {
  const viewport = getOverlayViewport(overlayId);

  if (!viewport) {
    writeLog("warn", "lab", `Overlay ${overlayId} no existe`);
    return;
  }

  viewport.classList.add("is-overlay-hidden");
  state.overlays.instances[overlayId].hidden = true;

  if (state.overlays.hiddenDeliveryMode === "destroy") {
    destroyOverlayIframe(overlayId, "hidden by overlay mode");
  }

  renderOverlayStatus();

  if (!options.silent) {
    writeLog("info", "lab", `Overlay ${overlayId} ocultado`, {
      action: "Hide source",
      hiddenDeliveryMode: state.overlays.hiddenDeliveryMode,
      receivesEvents: state.overlays.hiddenDeliveryMode === "deliver",
      loaded: state.overlays.instances[overlayId]?.loaded === true
    });
  }
}

function showOverlay(overlayId, options = {}) {
  let viewport = getOverlayViewport(overlayId);

  if (!viewport) {
    ensureOverlayFrame(overlayId);
    viewport = getOverlayViewport(overlayId);
  }

  viewport.classList.remove("is-overlay-hidden");
  if (!state.overlays.instances[overlayId]) {
    state.overlays.instances[overlayId] = {
      id: overlayId,
      hidden: false,
      loaded: false
    };
  }
  state.overlays.instances[overlayId].hidden = false;

  if (!getOverlayFrame(overlayId) || state.overlays.instances[overlayId].loaded === false) {
    renderOverlayFromCache(overlayId);
  } else {
    sendWorkerConfig(overlayId);
  }

  renderOverlayStatus();

  if (!options.silent) {
    writeLog("info", "lab", `Overlay ${overlayId} mostrado`, {
      action: "Show source",
      activeConnections: countOpenMockConnections(overlayId)
    });
  }
}

function deactivateScene() {
  const overlayId = state.overlays.activeId;
  hideOverlay(overlayId);

  writeLog("info", "lab", `Scene deactivated para Overlay ${overlayId}`, {
    hiddenDeliveryMode: state.overlays.hiddenDeliveryMode
  });
}

function activateScene() {
  const overlayId = state.overlays.activeId;
  showOverlay(overlayId);
  writeLog("info", "lab", `Scene activated para Overlay ${overlayId}`, {
    activeConnections: countOpenMockConnections(overlayId)
  });
}

function closeOverlayWebSockets(overlayId, reason) {
  postToWidgetFrames({
    source: LAB_SOURCE,
    type: "WORKER_MOCK_CLOSE",
    reason
  }, { target: overlayId });
  writeLog("info", "lab", `Cierre de WebSocket mock solicitado para Overlay ${overlayId}`, {
    reason,
    openBeforeClose: countOpenMockConnections(overlayId)
  });
}

function destroyOverlayIframe(overlayId, reason) {
  const frame = getOverlayFrame(overlayId);

  frame?.remove();
  clearOverlayConnections(overlayId, reason);

  if (!state.overlays.instances[overlayId]) {
    state.overlays.instances[overlayId] = {
      id: overlayId,
      hidden: true,
      loaded: false
    };
  }

  state.overlays.instances[overlayId].loaded = false;
  writeLog("info", "lab", `Overlay ${overlayId} iframe destruido`, {
    reason,
    replayMode: state.worker.replayMode
  });
}

function clearOverlayConnections(overlayId, reason) {
  for (const [connectionId, connection] of state.worker.openConnections.entries()) {
    if (connection.overlayId === overlayId) {
      state.worker.openConnections.delete(connectionId);
      writeLog("info", "lab", `Conexion mock descartada por ${reason}`, {
        connectionId,
        overlayId
      });
    }
  }

  updateWorkerConnectionCount();
}

function runReloadOverlayBWhileLockedScenario() {
  const previousTarget = state.overlays.deliveryTarget;
  setOverlayDeliveryTarget("A");
  beginNormalPrediction();
  lockPredictionWithoutEnd();
  const predictionId = state.prediction.id;
  const selectedWidget = state.selectedWidget;
  writeLog("info", "lab", "Escenario: Overlay B se recargara tras 16s mientras A esta locked", {
    step: "A begin + A lock"
  });
  window.setTimeout(() => {
    if (state.prediction.id !== predictionId || state.selectedWidget !== selectedWidget ||
        !["locked", "locked_waiting_resolution"].includes(state.prediction.currentPredictionStatus)) {
      writeLog("info", "lab", "Escenario de recarga B cancelado: el widget o la predicción han cambiado");
      return;
    }
    duplicateOverlayInstance();
    refreshOverlay("B");
    if (state.overlays.deliveryTarget === "A") setOverlayDeliveryTarget(previousTarget);
    writeLog("info", "lab", "Escenario: Overlay B recreado; no se ha enviado end todavia", {
      currentPredictionStatus: state.prediction.currentPredictionStatus,
      replayMode: state.worker.replayMode
    });
  }, 16000);
}

function runEndWhileHiddenScenario() {
  beginNormalPrediction();
  lockPredictionWithoutEnd();
  hideOverlay(state.overlays.activeId);
  endPredictionByOutcomeId(state.prediction.winningOutcomeId || state.prediction.outcomes[0]?.id || null, "resolved");
  writeLog("info", "lab", "Escenario End while hidden ejecutado", {
    activeOverlay: state.overlays.activeId,
    currentPredictionStatus: state.prediction.currentPredictionStatus
  });
}

function runReconnectWhileActiveExpiredScenario() {
  if (state.prediction.mode !== "stress") {
    setPredictionMode("stress");
  }

  beginOneSecondStressPrediction();
  forceActiveExpiredPrediction();
  closeOverlayWebSockets(state.overlays.activeId, "reconnect while active expired");
  window.setTimeout(() => {
    refreshOverlay(state.overlays.activeId);
    writeLog("info", "lab", "Escenario Reconnect while active expired: overlay recreado", {
      activeOverlay: state.overlays.activeId,
      replayMode: state.worker.replayMode,
      currentPredictionStatus: state.prediction.currentPredictionStatus
    });
  }, 500);
}

async function runResultSceneSwitchScenario() {
  const token = ++resultSceneScenarioId;
  const widgetId = state.selectedWidget?.id;
  resetPredictionLabState();
  state.overlays.hiddenDeliveryMode = "deliver";
  setOverlayDeliveryTarget("all");
  duplicateOverlayInstance();
  setActiveOverlay("A");
  const isCurrent = () => token === resultSceneScenarioId && state.selectedWidget?.id === widgetId;
  const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  // Wait for both actual mock sockets, not a fixed iframe loading delay.
  const deadline = Date.now() + 5000;
  while (isCurrent() && (countOpenMockConnections("A") === 0 || countOpenMockConnections("B") === 0)) {
    if (Date.now() >= deadline) {
      writeLog("warn", "lab", "Result scene scenario aborted: both overlays must have open mocked WebSockets.");
      return;
    }
    await pause(50);
  }
  if (!isCurrent()) return;
  beginNormalPrediction();
  const predictionId = state.prediction.id;
  const samePrediction = () => isCurrent() && state.prediction.id === predictionId && state.prediction.startedAt !== null;
  applyVotePattern("random");
  sendPredictionProgressWithCurrentVotes();
  lockPrediction();
  await pause(1000);
  if (!samePrediction()) return;
  endPredictionByOutcomeId(state.prediction.outcomes[0]?.id, "resolved");
  await pause(750);
  if (!samePrediction()) return;
  // Explicit fault injection: closing WS may cancel the legacy renderer's cleanup.
  // This is a candidate failure mechanism, not a claim about OBS visibility.
  closeOverlayWebSockets("B", "stress: disconnect during result animation");
  hideOverlay("B");
  writeLog("info", "lab", "Result scene scenario: B disconnected during result; waiting 12s before scene switch.", {
    predictionId, endedAt: state.prediction.endedAt, faultInjection: true, replayMode: state.worker.replayMode
  });
  await pause(12000);
  if (!samePrediction()) return;
  hideOverlay("A");
  showOverlay("B");
  setActiveOverlay("B");
  writeLog("info", "lab", "Result scene scenario complete. Inspect B for a stale title/trophy after result expiry.", {
    predictionId, endedAt: state.prediction.endedAt, expected: "Result must not remain stuck or restart its display lifetime.",
    faultInjection: "B socket close during result", replayMode: state.worker.replayMode
  });
}

function createDefaultPredictionState() {
  return {
    id: "prediction-0001",
    title: "Quien gana la siguiente ronda?",
    durationSeconds: 60,
    mode: "twitch",
    status: "idle",
    currentPredictionStatus: "idle",
    currentPredictionStage: "idle",
    startedAt: null,
    locksAt: null,
    lockedAt: null,
    endedAt: null,
    winningOutcomeId: null,
    currentPrediction: null,
    predictionHistory: [],
    lastPredictionPayload: null,
    lockFadeTimer: null,
    outcomes: [
      createPredictionOutcome(1),
      createPredictionOutcome(2)
    ]
  };
}

function createPredictionOutcome(number) {
  return {
    id: `outcome-${number}`,
    title: `Opcion ${number}`,
    color: "blue",
    users: 0,
    channelPoints: 0
  };
}

function isPredictionSetupLocked() {
  return state.prediction.mode === "twitch" &&
    !["idle", "resolved", "canceled"].includes(state.prediction.currentPredictionStatus);
}

function renderPredictionControls() {
  elements.predictionTwitchValidMode.checked = state.prediction.mode === "twitch";
  elements.predictionStressMode.checked = state.prediction.mode === "stress";
  elements.predictionTitle.value = state.prediction.title;
  elements.predictionDuration.value = String(state.prediction.durationSeconds);
  elements.predictionOutcomeCount.value = String(state.prediction.outcomes.length);
  const setupLocked = isPredictionSetupLocked();
  for (const input of [elements.predictionTitle, elements.predictionDuration, elements.predictionOutcomeCount, ...elements.predictionCountButtons]) {
    input.disabled = setupLocked;
  }
  elements.predictionApplyVotePatternButton.disabled = setupLocked && state.prediction.currentPredictionStage === "lock";
  renderPredictionWinningOptions();
  renderPredictionOutcomeRows();
  renderPredictionValidation();
  renderPredictionStateSummary();
}

function renderPredictionWinningOptions() {
  elements.predictionWinningOutcome.replaceChildren();

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Elige el resultado";
  elements.predictionWinningOutcome.append(emptyOption);

  for (const outcome of state.prediction.outcomes) {
    const option = document.createElement("option");
    option.value = outcome.id;
    option.textContent = `${outcome.id} - ${outcome.title}`;
    elements.predictionWinningOutcome.append(option);
  }

  if (!state.prediction.outcomes.some((outcome) => outcome.id === state.prediction.winningOutcomeId)) {
    state.prediction.winningOutcomeId = null;
  }

  elements.predictionWinningOutcome.value = state.prediction.winningOutcomeId || "";
}

function renderPredictionOutcomeRows() {
  elements.predictionOutcomes.replaceChildren();

  state.prediction.outcomes.forEach((outcome, index) => {
    const row = document.createElement("div");
    row.className = "prediction-outcome-row";
    row.append(
      createPredictionInput(index, "title", `Opcion ${index + 1}`, outcome.title, "text"),
      createPredictionInput(index, "users", "Usuarios", outcome.users, "number"),
      createPredictionInput(index, "channelPoints", "Puntos", outcome.channelPoints, "number")
    );
    elements.predictionOutcomes.append(row);
  });
}

function createPredictionInput(index, field, label, value, type) {
  const wrapper = document.createElement("label");
  const labelNode = document.createElement("span");
  const input = document.createElement("input");

  labelNode.className = "field-label";
  labelNode.textContent = label;
  input.className = "text-input";
  input.type = type;
  input.value = String(value);
  input.dataset.outcomeIndex = String(index);
  input.dataset.outcomeField = field;
  input.disabled = isPredictionSetupLocked() && (field === "title" || state.prediction.currentPredictionStage === "lock");

  if (type === "number") {
    input.min = "0";
    input.step = "1";
  }

  wrapper.append(labelNode, input);
  return wrapper;
}

function setPredictionMode(mode) {
  clearPredictionWindow();
  state.prediction.mode = mode === "stress" ? "stress" : "twitch";

  if (state.prediction.mode === "twitch") {
    applyTwitchPredictionLimits();
  }

  schedulePredictionWindow();
  renderPredictionControls();
  writeLog("info", "lab", `Prediction mode: ${state.prediction.mode}`, {
    limits: PREDICTION_LIMITS
  });
}

function applyTwitchPredictionLimits() {
  state.prediction.title = state.prediction.title.slice(0, PREDICTION_LIMITS.titleMax);
  state.prediction.durationSeconds = clampInteger(
    state.prediction.durationSeconds,
    PREDICTION_LIMITS.durationMin,
    PREDICTION_LIMITS.durationMax
  );
  resizePredictionOutcomes(clampInteger(
    state.prediction.outcomes.length,
    PREDICTION_LIMITS.outcomesMin,
    PREDICTION_LIMITS.outcomesMax
  ));

  for (const outcome of state.prediction.outcomes) {
    outcome.title = String(outcome.title || "").slice(0, PREDICTION_LIMITS.outcomeTitleMax);
  }
}

function renderPredictionValidation() {
  const warnings = [];
  const title = elements.predictionTitle.value || "";
  const duration = Number.parseInt(elements.predictionDuration.value, 10);

  if (title.length > PREDICTION_LIMITS.titleMax) {
    warnings.push(`titulo ${title.length}/${PREDICTION_LIMITS.titleMax}`);
  }

  if (state.prediction.mode === "twitch" && (!Number.isFinite(duration) || duration < PREDICTION_LIMITS.durationMin || duration > PREDICTION_LIMITS.durationMax)) {
    warnings.push(`duracion fuera de ${PREDICTION_LIMITS.durationMin}-${PREDICTION_LIMITS.durationMax}s`);
  }

  state.prediction.outcomes.forEach((outcome, index) => {
    const value = String(outcome.title || "");

    if (value.length > PREDICTION_LIMITS.outcomeTitleMax) {
      warnings.push(`opcion ${index + 1} ${value.length}/${PREDICTION_LIMITS.outcomeTitleMax}`);
    }
  });

  if (warnings.length === 0) {
    elements.predictionValidation.textContent = state.prediction.mode === "twitch"
      ? "Twitch valid mode: 2-10 opciones, titulo <=45, outcome <=25, duracion 30-1800s."
      : "Stress mode: permite duraciones cortas, locks_at en pasado y eventos fuera de orden.";
    elements.predictionValidation.className = "validation-summary is-ok";
    return;
  }

  elements.predictionValidation.textContent = `Warnings: ${warnings.join("; ")}`;
  elements.predictionValidation.className = "validation-summary has-warnings";
}

function renderPredictionStateSummary() {
  const status = state.prediction.currentPredictionStatus || state.prediction.status || "idle";
  const historyCount = state.prediction.predictionHistory.length;
  const openConnections = state.worker.openConnections.size;

  const labels = { idle: "Lista para iniciar", active: "Apuestas abiertas", locked: "Apuestas bloqueadas", locked_waiting_resolution: "Esperando resolución", resolved: "Resuelta", canceled: "Cancelada", active_expired: "Plazo agotado" };
  elements.predictionStateSummary.textContent = `${labels[status] || status} (${status}) · eventos: ${historyCount} · WS: ${openConnections}`;
  const twitch = state.prediction.mode === "twitch";
  const ongoing = !["idle", "resolved", "canceled"].includes(status);
  const acceptingVotes = ["begin", "progress"].includes(state.prediction.currentPredictionStage);
  elements.predictionBeginNormalButton.disabled = twitch && ongoing;
  for (const button of [elements.predictionNormalProgressButton, elements.predictionSendProgressButton, elements.predictionLockButton]) {
    button.disabled = twitch && (!ongoing || !acceptingVotes);
  }
  for (const button of [elements.predictionResolveWinnerButton, elements.predictionEndCanceledButton]) {
    button.disabled = twitch && !ongoing;
  }
  elements.predictionResolveWinnerButton.disabled ||= !state.prediction.winningOutcomeId;
}

function handlePredictionOutcomeInput(event) {
  const input = event.target;
  const index = Number(input.dataset.outcomeIndex);
  const field = input.dataset.outcomeField;

  if (!field || Number.isNaN(index) || !state.prediction.outcomes[index]) {
    return;
  }

  if (field === "title") {
    state.prediction.outcomes[index].title = input.value;
    renderPredictionWinningOptions();
    renderPredictionValidation();
    return;
  }

  state.prediction.outcomes[index][field] = clampInteger(input.value, 0, 999999999);
  renderPredictionStateSummary();
}

function setPredictionOutcomeCount(value) {
  if (isPredictionSetupLocked()) {
    writeLog("warn", "lab", "Prediction setup is immutable after Begin. Use Stress mode to change it.");
    return;
  }
  syncPredictionFromControls();

  const nextCount = clampInteger(value, PREDICTION_LIMITS.outcomesMin, PREDICTION_LIMITS.outcomesMax);
  elements.predictionOutcomeCount.value = String(nextCount);
  resizePredictionOutcomes(nextCount);
  renderPredictionControls();
}

function syncPredictionFromControls() {
  const setupLocked = isPredictionSetupLocked();
  if (!setupLocked) {
    state.prediction.title = elements.predictionTitle.value.trim() || "Prediccion de prueba";
    state.prediction.durationSeconds = clampInteger(elements.predictionDuration.value, 1, 86400);
  }
  state.prediction.winningOutcomeId = elements.predictionWinningOutcome.value || null;

  for (const input of elements.predictionOutcomes.querySelectorAll("[data-outcome-field]")) {
    const index = Number(input.dataset.outcomeIndex);
    const field = input.dataset.outcomeField;

    if (!state.prediction.outcomes[index]) {
      continue;
    }

    if (field === "title" && setupLocked) continue;
    if (field !== "title" && setupLocked && state.prediction.currentPredictionStage === "lock") continue;
    if (field === "title") {
      state.prediction.outcomes[index].title = input.value.trim() || `Opcion ${index + 1}`;
    } else {
      state.prediction.outcomes[index][field] = clampInteger(input.value, 0, 999999999);
    }
  }

  if (!setupLocked) resizePredictionOutcomes(clampInteger(elements.predictionOutcomeCount.value, PREDICTION_LIMITS.outcomesMin, PREDICTION_LIMITS.outcomesMax));

  if (state.prediction.mode === "twitch") {
    applyTwitchPredictionLimits();
  }
}

function resizePredictionOutcomes(nextCount) {
  while (state.prediction.outcomes.length < nextCount) {
    state.prediction.outcomes.push(createPredictionOutcome(state.prediction.outcomes.length + 1));
  }

  state.prediction.outcomes = state.prediction.outcomes.slice(0, nextCount);

  if (!state.prediction.outcomes.some((outcome) => outcome.id === state.prediction.winningOutcomeId)) {
    state.prediction.winningOutcomeId = null;
  }
}

function createPrediction() {
  beginNormalPrediction();
}

function beginNormalPrediction() {
  syncPredictionFromControls();
  if (state.prediction.mode === "twitch" && !["idle", "resolved", "canceled"].includes(state.prediction.currentPredictionStatus)) {
    writeLog("warn", "lab", "Twitch allows only one unresolved prediction. Resolve or cancel it before Begin.");
    return;
  }
  startPredictionWindow();
  if (state.prediction.mode === "twitch") {
    for (const outcome of state.prediction.outcomes) {
      outcome.users = 0;
      outcome.channelPoints = 0;
    }
  }
  setPredictionRuntimeStatus("active", "begin");
  state.prediction.lockedAt = null;
  state.prediction.endedAt = null;
  state.prediction.winningOutcomeId = null;
  if (elements.predictionVoteFeedback) elements.predictionVoteFeedback.hidden = true;
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("begin"));
  schedulePredictionWindow();
}

function beginTenOutcomePrediction() {
  if (isPredictionSetupLocked()) {
    writeLog("warn", "lab", "Prediction setup is immutable after Begin. Use Stress mode to change it.");
    return;
  }
  syncPredictionFromControls();
  resizePredictionOutcomes(PREDICTION_LIMITS.outcomesMax);
  state.prediction.outcomes.forEach((outcome, index) => {
    outcome.title = outcome.title || `Opcion ${index + 1}`;
    outcome.users = 0;
    outcome.channelPoints = 0;
  });
  renderPredictionControls();
  beginNormalPrediction();
}

function beginOneSecondStressPrediction() {
  clearPredictionWindow();
  if (!ensureStressMode("Begin 1s stress")) {
    return;
  }

  syncPredictionFromControls();
  const startedAt = new Date();
  state.prediction.id = "prediction-" + crypto.randomUUID();
  state.prediction.durationSeconds = 1;
  state.prediction.startedAt = startedAt.toISOString();
  state.prediction.locksAt = new Date(startedAt.getTime() + 1000).toISOString();
  state.prediction.lockedAt = null;
  state.prediction.endedAt = null;
  setPredictionRuntimeStatus("active", "begin");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("begin"));
}

function forceActiveExpiredPrediction() {
  if (!ensureStressMode("Active expired")) {
    return;
  }

  syncPredictionFromControls();
  const startedAt = new Date(Date.now() - 60000);
  state.prediction.startedAt = startedAt.toISOString();
  state.prediction.locksAt = new Date(Date.now() - 1000).toISOString();
  state.prediction.lockedAt = null;
  state.prediction.endedAt = null;
  setPredictionRuntimeStatus("active_expired", "begin");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("begin"));
}

function progressExpiredPrediction() {
  if (!ensureStressMode("Progress despues de expirada")) {
    return;
  }

  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  state.prediction.locksAt = new Date(Date.now() - 1000).toISOString();
  setPredictionRuntimeStatus("active_expired", "progress");
  applyVotePattern("random");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("progress"));
}

function sendPredictionProgressWithCurrentVotes() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  if (!allowProgress() || !validatePredictionVoteTotals()) return;
  setPredictionRuntimeStatus(getPredictionExpiredStatus(), "progress");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("progress"));
}

function validatePredictionVoteTotals() {
  const previous = state.prediction.currentPrediction;
  const decreases = previous?.id === state.prediction.id && state.prediction.outcomes.some((outcome) => {
    const known = previous.outcomes?.find((item) => item.id === outcome.id);
    return known && ((known.users != null && outcome.users < known.users) ||
      (known.channel_points != null && outcome.channelPoints < known.channel_points));
  });
  const invalid = state.prediction.mode === "twitch" && decreases;
  if (elements.predictionVoteFeedback) {
    elements.predictionVoteFeedback.hidden = false;
    elements.predictionVoteFeedback.textContent = invalid
      ? "No enviado: los votos son totales acumulados y no pueden bajar en esta predicción. Cancela e inicia otra para probar cifras menores."
      : "Totales enviados: " + state.prediction.outcomes.map((outcome) => outcome.title + ": " + outcome.users + " usuarios, " + outcome.channelPoints + " puntos").join(" · ");
  }
  if (invalid) writeLog("warn", "lab", "No se envían contadores decrecientes. Los datos del formulario siguen sin enviar.");
  return !invalid;
}

function addVotesToOutcome(index) {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  if (!allowProgress()) return;
  addPredictionVote(index, 1, 500);
  setPredictionRuntimeStatus(getPredictionExpiredStatus(), "progress");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("progress"));
}

function addRandomPredictionVotes() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  if (!allowProgress()) return;

  for (let index = 0; index < state.prediction.outcomes.length; index += 1) {
    const users = Math.floor(Math.random() * 4) + 1;
    const points = users * (Math.floor(Math.random() * 9) + 2) * 100;
    addPredictionVote(index, users, points);
  }

  setPredictionRuntimeStatus(getPredictionExpiredStatus(), "progress");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("progress"));
}

function addPredictionVote(index, users, points) {
  const outcome = state.prediction.outcomes[index];

  if (!outcome) {
    writeLog("warn", "lab", `No existe la opcion ${index + 1} para sumar votos`);
    return;
  }

  outcome.users += users;
  outcome.channelPoints += points;
}

function lockPrediction() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  if (state.prediction.mode === "twitch" && !["begin", "progress"].includes(state.prediction.currentPredictionStage)) {
    writeLog("warn", "lab", "Prediction is already locked.");
    return;
  }
  clearPredictionWindow();
  setPredictionRuntimeStatus("locked", "lock");
  state.prediction.lockedAt = new Date().toISOString();
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("lock"));
}

function lockPredictionWithoutEnd() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  if (state.prediction.mode === "twitch" && !["begin", "progress"].includes(state.prediction.currentPredictionStage)) {
    writeLog("warn", "lab", "Prediction is already locked.");
    return;
  }
  clearPredictionWindow();
  setPredictionRuntimeStatus("locked_waiting_resolution", "lock");
  state.prediction.lockedAt = new Date().toISOString();
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("lock"));
}

function lockPredictionAndWaitFade() {
  lockPredictionWithoutEnd();
  writeLog("info", "lab", "Lock enviado; esperando 16 segundos para reproducir fade del widget", {
    currentPredictionStatus: state.prediction.currentPredictionStatus,
    activeOverlay: state.overlays.activeId
  });

  window.clearTimeout(state.prediction.lockFadeTimer);
  state.prediction.lockFadeTimer = window.setTimeout(() => {
    writeLog("info", "lab", "Han pasado 16 segundos desde lock; el widget puede haberse ocultado por su temporizador interno", {
      currentPredictionStatus: state.prediction.currentPredictionStatus,
      activeOverlay: state.overlays.activeId
    });
  }, 16000);
}

function endAfterLateLock() {
  if (!["locked", "locked_waiting_resolution"].includes(state.prediction.currentPredictionStatus)) {
    lockPredictionWithoutEnd();
  }

  setPredictionRuntimeStatus("locked_waiting_resolution", "lock");
  writeLog("info", "lab", "End tardio solicitado despues de lock", {
    currentPredictionStatus: state.prediction.currentPredictionStatus
  });
  endPredictionByOutcomeId(state.prediction.winningOutcomeId || state.prediction.outcomes[0]?.id || null, "resolved");
}

function endWithoutPriorLock() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  setPredictionRuntimeStatus(getPredictionExpiredStatus(), "progress");
  endPredictionByOutcomeId(state.prediction.winningOutcomeId || state.prediction.outcomes[0]?.id || null, "resolved");
}

function endPrediction(winnerIndex) {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;

  const winner = state.prediction.outcomes[winnerIndex];

  if (!winner) {
    writeLog("warn", "lab", `No existe la opcion ${winnerIndex + 1} para finalizar`);
    return;
  }

  endPredictionByOutcomeId(winner.id, "resolved");
}

function resolvePredictionWithSelectedWinner() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  endPredictionByOutcomeId(state.prediction.winningOutcomeId, "resolved");
}

function endPredictionByOutcomeId(winningOutcomeId, status) {
  if (state.prediction.mode === "twitch" && !ensurePredictionStarted()) return;
  if (status === "resolved" && !state.prediction.outcomes.some((outcome) => outcome.id === winningOutcomeId)) {
    writeLog("warn", "lab", "Elige expresamente el resultado o cancela para devolver los puntos. El reparto de apuestas no decide el ganador.");
    return;
  }
  clearPredictionWindow();

  state.prediction.status = status;
  state.prediction.winningOutcomeId = status === "resolved" ? winningOutcomeId : null;
  state.prediction.endedAt = new Date().toISOString();
  setPredictionRuntimeStatus(status === "canceled" ? "canceled" : "resolved", "end");
  renderPredictionControls();
  emitTwitchPredictionPayload(buildPredictionPayload("end"));
}

function cancelPrediction() {
  syncPredictionFromControls();
  if (!ensurePredictionStarted()) return;
  endPredictionByOutcomeId(null, "canceled");
}

function resetPrediction() {
  clearPredictionWindow();
  state.prediction = createDefaultPredictionState();
  resetBridgeV2();
  renderPredictionControls();
  writeLog("info", "lab", "Evento emitido: twitch.prediction.reset", {
    timestamp: new Date().toISOString(),
    summary: summarizePredictionState()
  });
  sendWorkerConfig();
}

function resetPredictionLabState() {
  clearPredictionWindow();
  const keepMode = state.prediction.mode;
  state.prediction.currentPrediction = null;
  state.prediction.predictionHistory = [];
  state.prediction.lastPredictionPayload = null;
  state.prediction.status = "idle";
  state.prediction.currentPredictionStatus = "idle";
  state.prediction.currentPredictionStage = "idle";
  state.prediction.startedAt = null;
  state.prediction.locksAt = null;
  state.prediction.lockedAt = null;
  state.prediction.endedAt = null;
  state.prediction.mode = keepMode;
  resetBridgeV2();
  window.clearTimeout(state.prediction.lockFadeTimer);
  state.prediction.lockFadeTimer = null;
  renderPredictionControls();
  sendWorkerConfig();
  writeLog("info", "lab", "Prediction lab state reset", {
    currentPrediction: null,
    predictionHistory: 0
  });
}

function ensurePredictionStarted() {
  if (!state.prediction.startedAt || ["idle", "resolved", "canceled"].includes(state.prediction.status)) {
    if (state.prediction.mode === "twitch") {
      writeLog("warn", "lab", "Begin a prediction first. Out-of-order injection belongs in Stress mode.");
      return false;
    }
    startPredictionWindow();
    setPredictionRuntimeStatus("active", "begin");
  }
  return true;
}

function clearPredictionWindow() {
  window.clearTimeout(predictionWindowTimer);
  predictionWindowTimer = null;
}

function schedulePredictionWindow() {
  clearPredictionWindow();
  if (state.prediction.mode !== "twitch" || state.prediction.currentPredictionStatus !== "active") return;
  const id = state.prediction.id;
  const locksAt = state.prediction.locksAt;
  predictionWindowTimer = window.setTimeout(() => {
    if (state.prediction.id !== id || state.prediction.mode !== "twitch" ||
        state.prediction.currentPredictionStatus !== "active") return;
    // Preserve the server's scheduled lock time even if this task runs late.
    state.prediction.lockedAt = locksAt;
    setPredictionRuntimeStatus("locked_waiting_resolution", "lock");
    renderPredictionControls();
    emitTwitchPredictionPayload(buildPredictionPayload("lock"));
  }, Math.max(0, Date.parse(locksAt) - Date.now()));
}

function allowProgress() {
  if (state.prediction.mode === "twitch" && state.prediction.currentPredictionStage !== "begin" &&
      state.prediction.currentPredictionStage !== "progress") {
    writeLog("warn", "lab", "A locked prediction no longer accepts progress. Use Stress mode for late events.");
    return false;
  }
  if (state.prediction.mode === "twitch" && Date.parse(state.prediction.locksAt) <= Date.now()) {
    writeLog("warn", "lab", "Prediction window expired; waiting for automatic lock.");
    return false;
  }
  return true;
}

function startPredictionWindow() {
  clearPredictionWindow();
  state.prediction.id = "prediction-" + crypto.randomUUID();
  const startedAt = new Date();
  state.prediction.startedAt = startedAt.toISOString();
  state.prediction.locksAt = new Date(startedAt.getTime() + state.prediction.durationSeconds * 1000).toISOString();
  state.prediction.lockedAt = null;
  state.prediction.endedAt = null;
}

function setPredictionRuntimeStatus(status, stage) {
  if (!PREDICTION_STATE_LABELS.includes(status)) {
    status = "stale";
  }

  state.prediction.status = status === "active_expired" ? "active" : status;
  state.prediction.currentPredictionStatus = status;
  state.prediction.currentPredictionStage = stage || state.prediction.currentPredictionStage || "idle";
  renderPredictionStateSummary();
}

function getPredictionExpiredStatus() {
  if (!state.prediction.locksAt) {
    return "active";
  }

  return new Date(state.prediction.locksAt).getTime() < Date.now()
    ? "active_expired"
    : "active";
}

function ensureStressMode(actionLabel) {
  if (state.prediction.mode === "stress") {
    return true;
  }

  writeLog("warn", "lab", `${actionLabel} requiere Stress mode`, {
    mode: state.prediction.mode
  });
  return false;
}

function applySelectedVotePattern() {
  applyVotePattern(elements.predictionVotePattern.value);
  renderPredictionControls();
  writeLog("info", "lab", `Vote pattern aplicado: ${elements.predictionVotePattern.value}`, {
    summary: summarizePredictionState()
  });
}

function applyVotePattern(pattern) {
  if (isPredictionSetupLocked() && state.prediction.currentPredictionStage === "lock") {
    writeLog("warn", "lab", "Votes are frozen after lock in Twitch valid mode.");
    return;
  }
  syncPredictionFromControls();

  if (pattern === "ten-uneven") {
    resizePredictionOutcomes(PREDICTION_LIMITS.outcomesMax);
  }

  const outcomes = state.prediction.outcomes;
  outcomes.forEach((outcome) => {
    outcome.users = 0;
    outcome.channelPoints = 0;
  });

  if (pattern === "zero") {
    return;
  }

  if (pattern === "all-option-1") {
    outcomes[0].users = 25;
    outcomes[0].channelPoints = 25000;
    return;
  }

  if (pattern === "equal") {
    outcomes.forEach((outcome) => { outcome.users = 10; outcome.channelPoints = 10000; });
    return;
  }

  if (pattern === "close-percentages") {
    outcomes.forEach((outcome, index) => {
      outcome.users = 10 + index;
      outcome.channelPoints = 10000 + index * 250;
    });
    return;
  }

  if (pattern === "tiny-huge") {
    outcomes[0].users = 1;
    outcomes[0].channelPoints = 100;
    const target = outcomes[1] || outcomes[0];
    target.users = 250;
    target.channelPoints = 250000;
    return;
  }

  if (pattern === "ten-uneven") {
    outcomes.forEach((outcome, index) => {
      outcome.users = index === 0 ? 1 : (index + 1) * 3;
      outcome.channelPoints = [100, 9000, 23000, 500, 64000, 12000, 32000, 7000, 98000, 41000][index] || 1000;
    });
    return;
  }

  outcomes.forEach((outcome) => {
    const users = Math.floor(Math.random() * 9) + 1;
    outcome.users = users;
    outcome.channelPoints = users * (Math.floor(Math.random() * 20) + 1) * 100;
  });
}

function buildPredictionPayload(stage) {
  const type = TWITCH_PREDICTION_TYPES[stage];
  const fixture = cloneJson(state.twitchPredictionFixtures[stage] || {
    type,
    subscription: { type },
    event: {}
  });
  const event = {
    ...fixture.event,
    id: state.prediction.id,
    broadcaster_user_id: "133649243",
    broadcaster_user_login: "losbroles",
    broadcaster_user_name: "LosBroles",
    title: state.prediction.title,
    outcomes: buildPredictionOutcomes(stage === "end"),
    started_at: state.prediction.startedAt
  };

  if (stage === "begin" || stage === "progress") {
    event.locks_at = state.prediction.locksAt;
    delete event.locked_at;
    delete event.ended_at;
    delete event.status;
    delete event.winning_outcome_id;
  }

  if (stage === "lock") {
    event.locked_at = state.prediction.lockedAt || new Date().toISOString();
    delete event.locks_at;
    delete event.ended_at;
    delete event.status;
    delete event.winning_outcome_id;
  }

  if (stage === "end") {
    event.status = state.prediction.status === "canceled" ? "canceled" : "resolved";
    event.winning_outcome_id = event.status === "resolved" ? state.prediction.winningOutcomeId : null;
    event.ended_at = state.prediction.endedAt || new Date().toISOString();
    delete event.locks_at;
    delete event.locked_at;
  }

  return {
    ...fixture,
    type,
    subscription: {
      ...fixture.subscription,
      type
    },
    event: state.prediction.mode === "stress" ? event : predictionEvent(stage, event)
  };
}

function buildPredictionOutcomes(includeWinnings) {
  return state.prediction.outcomes.map((outcome, index) => {
    const isWinner = state.prediction.winningOutcomeId === outcome.id;
    const color = state.prediction.mode === "stress"
      ? (outcome.color || (index % 2 === 0 ? "blue" : "pink"))
      : (state.prediction.outcomes.length === 2 && index === 1 ? "pink" : "blue");

    return {
      id: outcome.id,
      title: outcome.title,
      color,
      users: outcome.users,
      channel_points: outcome.channelPoints,
      top_predictors: buildTopPredictors(outcome, index, includeWinnings && isWinner)
    };
  });
}

function buildTopPredictors(outcome, index, includeWinnings) {
  if (outcome.users < 1 || outcome.channelPoints < 1) {
    return [];
  }

  const used = Math.max(1, Math.round(outcome.channelPoints / Math.max(1, outcome.users)));
  const predictor = {
    user_id: `mock-predictor-${String(index + 1).padStart(3, "0")}`,
    user_login: `prediction_user_${index + 1}`,
    user_name: `PredictionUser${index + 1}`,
    channel_points_used: used,
    channel_points_won: null
  };

  if (includeWinnings) {
    predictor.channel_points_won = Math.round(used * 1.6);
  }

  return [predictor];
}

function emitTwitchPredictionPayload(payload) {
  const timestamp = new Date().toISOString();
  const summary = summarizePredictionPayload(payload);
  const frames = getTargetFrames("active");

  if (frames.length === 0) {
    writeLog("warn", "lab", "No hay iframe activo disponible para twitch:eventsub; se mantiene la ruta Worker si aplica", {
      hiddenDeliveryMode: state.overlays.hiddenDeliveryMode,
      activeOverlay: state.overlays.activeId
    });
  }

  for (const frame of frames) {
    frame.contentWindow?.postMessage({
      source: LAB_SOURCE,
      type: "TWITCH_EVENTSUB_EMIT",
      payload
    }, "*");
  }
  recordPredictionPayload(payload, `Twitch Predictions ${payload.type}`);
  mirrorPredictionPayloadToWorkerForActiveWidget(payload, "Twitch Predictions");

  writeLog("info", "lab", `Evento emitido: ${payload.type}`, {
    timestamp,
    channel: "twitch:eventsub",
    overlayTarget: "active",
    summary,
    payload
  });
}

function mirrorPredictionPayloadToWorkerForActiveWidget(payload, sourceLabel) {
  if (!["prediccion", "prediccion-v2"].includes(state.selectedWidget?.id)) {
    return;
  }

  writeLog("info", "lab", "Prediccion compatibility adapter active", {
    source: sourceLabel,
    reason: "El widget prediccion no escucha twitch:eventsub; espera JSON por WebSocket y usa msg.subscription?.type || msg.type junto con msg.event.",
    expectedShape: {
      type: "channel.prediction.*",
      subscription: { type: "channel.prediction.*" },
      event: "{ title, outcomes, locks_at | locked_at | ended_at, status, winning_outcome_id }"
    },
    openMockWebSockets: state.worker.openConnections.size
  });
  postWorkerBroadcast("WORKER_MOCK_BROADCAST", payload, `Prediccion compat ${payload.type}`, {
    recordPrediction: false
  });
}

function buildBridgeV2Snapshot() {
  return { type: "bridge.state", protocol_version: 2, broadcaster_id: "133649243",
    epoch: state.worker.bridgeV2.epoch, revision: state.worker.bridgeV2.revision,
    server_now: new Date().toISOString(),
    sync: { status: "ready", source: "lab-helix-eventsub", last_verified_at: new Date().toISOString(), eventsub_connected: true },
    prediction: cloneJson(state.worker.bridgeV2.prediction), presentation: presentationFor(state.worker.bridgeV2.prediction) };
}

function recordBridgeV2Payload(payload) {
  const ns = BigInt(Date.now()) * 1000000n;
  state.worker.eventClock = ns > state.worker.eventClock ? ns : state.worker.eventClock + 1n;
  const at = new Date(Number(state.worker.eventClock / 1000000n)).toISOString().replace("Z", String(state.worker.eventClock % 1000000n).padStart(6, "0") + "Z");
  const result = eventTransition(state.worker.bridgeV2, { ...payload,
    metadata: payload.metadata || { message_id: crypto.randomUUID(), message_timestamp: at } }, "133649243");
  if (!result.accepted) {
    writeLog("warn", "worker", "Bridge v2 rejected injected event: " + result.reason);
    return;
  }
  state.worker.bridgeV2 = { ...result.model, revision: state.worker.bridgeV2.revision + 1 };
  // The simulated Helix endpoint has its own full dataset. Begin itself still has no vote fields.
  state.worker.helixV2 = cloneJson(result.model.prediction);
  if (payload.type === "channel.prediction.begin") {
    state.worker.helixV2.outcomes.forEach((outcome) => { outcome.users = 0; outcome.channel_points = 0; });
  }
}

function reconcileBridgeV2FromHelix() {
  const result = reducePrediction(state.worker.bridgeV2.prediction, state.worker.helixV2);
  if (result.accepted && JSON.stringify(result.prediction) !== JSON.stringify(state.worker.bridgeV2.prediction)) {
    state.worker.bridgeV2 = { ...state.worker.bridgeV2, prediction: result.prediction, revision: state.worker.bridgeV2.revision + 1 };
  }
}

function resetBridgeV2() {
  state.worker.bridgeV2 = { ...state.worker.bridgeV2, revision: state.worker.bridgeV2.revision + 1, prediction: null, cursor: null, seen: [], watermark: null };
  state.worker.helixV2 = null;
  // A reset is a confirmed, versioned empty state, not merely an erased client timer.
  postToWidgetFrames({ source: LAB_SOURCE, type: "WORKER_V2_STATE", payload: buildBridgeV2Snapshot() });
}

function summarizePredictionPayload(payload) {
  const outcomes = payload.event.outcomes || [];

  return {
    type: payload.type,
    title: payload.event.title,
    status: payload.event.status || state.prediction.status,
    winning_outcome_id: payload.event.winning_outcome_id || null,
    total_users: outcomes.reduce((total, outcome) => total + Number(outcome.users || 0), 0),
    total_channel_points: outcomes.reduce((total, outcome) => total + Number(outcome.channel_points || 0), 0),
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      title: outcome.title,
      users: outcome.users,
      channel_points: outcome.channel_points
    }))
  };
}

function isPredictionPayload(payload) {
  return Boolean(payload?.type && String(payload.type).startsWith("channel.prediction."));
}

function recordPredictionPayload(payload, label = "prediction") {
  if (!isPredictionPayload(payload)) {
    return;
  }

  const stage = String(payload.type).replace("channel.prediction.", "");
  const event = cloneJson(payload.event || {});
  const status = inferPredictionStatusFromPayload(payload);
  recordBridgeV2Payload(payload);
  state.prediction.lastPredictionPayload = cloneJson(payload);
  state.prediction.currentPrediction = event;
  state.prediction.currentPredictionStatus = status;
  state.prediction.currentPredictionStage = stage;
  state.prediction.predictionHistory.push({
    timestamp: new Date().toISOString(),
    label,
    stage,
    status,
    payload: cloneJson(payload)
  });

  if (state.prediction.predictionHistory.length > 100) {
    state.prediction.predictionHistory.shift();
  }

  renderPredictionStateSummary();
  sendWorkerConfig();
}

function inferPredictionStatusFromPayload(payload) {
  const stage = String(payload.type || "").replace("channel.prediction.", "");
  const event = payload.event || {};

  if (stage === "end") {
    return event.status === "canceled" ? "canceled" : "resolved";
  }

  if (stage === "lock") {
    return state.prediction.currentPredictionStatus === "locked_waiting_resolution"
      ? "locked_waiting_resolution"
      : "locked";
  }

  if ((stage === "begin" || stage === "progress") && event.locks_at && new Date(event.locks_at).getTime() < Date.now()) {
    return "active_expired";
  }

  return "active";
}

function buildWorkerPredictionStateSnapshot() {
  return {
    bridgeV2: buildBridgeV2Snapshot(),
    currentPrediction: cloneJson(state.prediction.currentPrediction),
    predictionHistory: cloneJson(state.prediction.predictionHistory.map((item) => item.payload)),
    lastPredictionPayload: cloneJson(state.prediction.lastPredictionPayload),
    currentPredictionStatus: state.prediction.currentPredictionStatus,
    currentPredictionStage: state.prediction.currentPredictionStage
  };
}

function buildCurrentPredictionSnapshotPayload() {
  if (!state.prediction.currentPrediction) {
    return state.prediction.lastPredictionPayload || null;
  }

  const status = state.prediction.currentPredictionStatus;
  let stage = state.prediction.currentPredictionStage || "progress";

  if (status === "resolved" || status === "canceled") {
    stage = "end";
  } else if (status === "locked" || status === "locked_waiting_resolution") {
    stage = "lock";
  } else if (stage === "idle") {
    stage = "progress";
  }

  const type = TWITCH_PREDICTION_TYPES[stage] || TWITCH_PREDICTION_TYPES.progress;

  return {
    type,
    subscription: { type },
    event: cloneJson(state.prediction.currentPrediction)
  };
}

function summarizePredictionState() {
  return {
    title: state.prediction.title,
    status: state.prediction.currentPredictionStatus || state.prediction.status,
    stage: state.prediction.currentPredictionStage,
    outcome_count: state.prediction.outcomes.length,
    winning_outcome_id: state.prediction.winningOutcomeId,
    total_users: state.prediction.outcomes.reduce((total, outcome) => total + outcome.users, 0),
    total_channel_points: state.prediction.outcomes.reduce((total, outcome) => total + outcome.channelPoints, 0)
  };
}

function renderWorkerControls() {
  elements.workerInterceptToggle.checked = state.worker.interceptWebSocket;
  elements.workerUrlInput.value = state.worker.workerUrl;
  elements.workerReplayMode.value = state.worker.replayMode;
  updateWorkerConnectionCount();
}

function sendWorkerConfig(target = "all") {
  postToWidgetFrames({
    source: LAB_SOURCE,
    type: "WORKER_MOCK_CONFIG",
    config: {
      interceptWebSocket: state.worker.interceptWebSocket,
      workerUrl: state.worker.workerUrl,
      replayMode: state.worker.replayMode,
      predictionState: buildWorkerPredictionStateSnapshot()
    }
  }, { target });
}

function sendWorkerWelcome() {
  const payload = {
    type: "welcome",
    session_id: "mock-session-id"
  };

  postWorkerBroadcast("WORKER_MOCK_WELCOME", payload, "Worker welcome");
}

function sendWorkerBridgeError() {
  const payload = {
    type: "bridge.error",
    error: {
      code: "mock_bridge_error",
      message: "Simulated Worker bridge error"
    }
  };

  postWorkerBroadcast("WORKER_MOCK_BRIDGE_ERROR", payload, "Worker bridge.error");
}

function replayWorkerLastPayload() {
  postWorkerBroadcast("WORKER_MOCK_REPLAY_LAST", state.prediction.lastPredictionPayload, "Worker replay last payload", {
    recordPrediction: false
  });
}

function replayWorkerCurrentPrediction() {
  postWorkerBroadcast("WORKER_MOCK_REPLAY_CURRENT", buildCurrentPredictionSnapshotPayload(), "Worker replay current prediction", {
    recordPrediction: false
  });
}

function replayWorkerHistory() {
  postWorkerBroadcast("WORKER_MOCK_REPLAY_HISTORY", {
    type: "lab.history.replay",
    events: state.prediction.predictionHistory.map((item) => item.payload)
  }, "Worker replay full history", {
    recordPrediction: false
  });
}

function sendWorkerPrediction(stage) {
  syncPredictionFromControls();

  if (stage === "begin") {
    startPredictionWindow();
    setPredictionRuntimeStatus("active", "begin");
    state.prediction.lockedAt = null;
    state.prediction.endedAt = null;
  } else {
    if (!ensurePredictionStarted()) return;
  }

  if (stage === "lock") {
    setPredictionRuntimeStatus("locked", "lock");
    state.prediction.lockedAt = new Date().toISOString();
  }

  if (stage === "end") {
    setPredictionRuntimeStatus("resolved", "end");
    state.prediction.endedAt = new Date().toISOString();
    state.prediction.winningOutcomeId = state.prediction.winningOutcomeId || state.prediction.outcomes[0]?.id || null;
  }

  const payload = buildPredictionPayload(stage);
  renderPredictionControls();
  postWorkerBroadcast("WORKER_MOCK_BROADCAST", payload, `Worker ${payload.type}`);
}

function postWorkerBroadcast(type, payload, label, options = {}) {
  const target = options.target || state.overlays.deliveryTarget || "all";
  const targetFrameResult = getTargetFrameResult(target);
  const openConnectionCount = countOpenMockConnections(target, { respectHiddenMode: true });

  if (isPredictionPayload(payload) && options.recordPrediction !== false) {
    recordPredictionPayload(payload, label);
  }

  if (type !== "WORKER_MOCK_CONFIG" && openConnectionCount === 0) {
    writeLog("warn", "lab", "No mocked WebSocket connections open. The widget may be hidden, reloading or not connected.", {
      label,
      activeWidget: state.selectedWidget?.id || null,
      overlayTarget: target,
      skippedHiddenOverlays: targetFrameResult.skippedHidden,
      skippedUnavailableOverlays: targetFrameResult.skippedUnavailable,
      workerUrl: state.worker.workerUrl,
      interceptWebSocket: state.worker.interceptWebSocket,
      expectedIntercept: "Worker mock intercepts WebSocket URLs containing /ws or the configured Worker URL.",
      payloadSummary: summarizeWorkerPayload(payload)
    });
  }

  postToWidgetFrames({
    source: LAB_SOURCE,
    type,
    payload,
    bridgeV2: buildBridgeV2Snapshot(),
    recordPrediction: false
  }, { target });

  writeLog("info", "lab", `${label} broadcast solicitado`, {
    timestamp: new Date().toISOString(),
    channel: "Worker WebSocket",
    overlayTarget: target,
    skippedHiddenOverlays: targetFrameResult.skippedHidden,
    skippedUnavailableOverlays: targetFrameResult.skippedUnavailable,
    summary: summarizeWorkerPayload(payload),
    openMockWebSockets: openConnectionCount,
    currentPredictionStatus: state.prediction.currentPredictionStatus,
    payload
  });
}

function postToWidgetFrames(message, options = {}) {
  const { frames } = getTargetFrameResult(options.target || "all");

  for (const frame of frames) {
    frame.contentWindow?.postMessage(message, "*");
  }
}

function getTargetFrames(target = "all") {
  return getTargetFrameResult(target).frames;
}

function getTargetFrameResult(target = "all") {
  const overlayIds = getTargetOverlayIds(target);
  const frames = [];
  const skippedHidden = [];
  const skippedUnavailable = [];

  for (const overlayId of overlayIds) {
    const instance = state.overlays.instances[overlayId];
    const frame = getOverlayFrame(overlayId);

    if (!frame) {
      skippedUnavailable.push(overlayId);
      continue;
    }

    if (state.overlays.hiddenDeliveryMode === "skip" && instance?.hidden) {
      skippedHidden.push(overlayId);
      continue;
    }

    frames.push(frame);
  }

  return { frames, skippedHidden, skippedUnavailable };
}

function getTargetOverlayIds(target = "all", options = {}) {
  let overlayIds;

  if (target === "all") {
    overlayIds = ["A", "B"].filter((id) => state.overlays.instances[id]);
  } else if (target === "active") {
    overlayIds = [state.overlays.activeId];
  } else {
    overlayIds = [target];
  }

  if (!options.respectHiddenMode || state.overlays.hiddenDeliveryMode !== "skip") {
    return overlayIds;
  }

  return overlayIds.filter((overlayId) => !state.overlays.instances[overlayId]?.hidden);
}

function countOpenMockConnections(target = "all", options = {}) {
  const overlayIds = getTargetOverlayIds(target, options);
  let count = 0;

  for (const connection of state.worker.openConnections.values()) {
    if (overlayIds.includes(connection.overlayId)) {
      count += 1;
    }
  }

  return count;
}

function summarizeWorkerPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return String(payload);
  }

  if (payload.type === "welcome") {
    return {
      type: payload.type,
      session_id: payload.session_id
    };
  }

  if (payload.type === "bridge.error") {
    return {
      type: payload.type,
      code: payload.error?.code,
      message: payload.error?.message
    };
  }

  if (isPredictionPayload(payload)) {
    return summarizePredictionPayload(payload);
  }

  return {
    type: payload.type || "message",
    keys: Object.keys(payload)
  };
}

function appendWorkerConnectionLog(entry) {
  updateWorkerOpenConnections(entry);
  state.worker.connectionLogCount += 1;
  renderWorkerConnectionList();

  if (entry.kind === "connection.opening") {
    writeLog("info", "lab", "Widget created WebSocket", {
      connectionId: entry.connectionId,
      url: entry.url,
      overlayId: entry.overlayId,
      intercepted: true
    });
  }

  if (entry.kind === "connection.open") {
    writeLog("info", "lab", "Mocked WebSocket intercepted and opened", {
      connectionId: entry.connectionId,
      url: entry.url,
      overlayId: entry.overlayId,
      openMockWebSockets: state.worker.openConnections.size
    });
  }

  if (entry.kind === "connection.native") {
    writeLog("warn", "lab", "Worker WebSocket was not intercepted", {
      url: entry.url,
      payload: entry.payload
    });
  }

  if (entry.kind === "message.from-widget") {
    writeLog("info", "worker", "Widget sent message to Worker mock", {
      connectionId: entry.connectionId,
      overlayId: entry.overlayId,
      payload: entry.payload
    });
  }

  if (entry.kind === "broadcast" && Number(entry.delivered || 0) === 0) {
    writeLog("warn", "lab", "No mocked WebSocket connections open. The widget may be hidden, reloading or not connected.", {
      openConnections: entry.openConnections || 0,
      payload: entry.payload
    });
  }
}

function updateWorkerOpenConnections(entry) {
  const connectionId = entry.connectionId;

  if (!connectionId || connectionId === "*" || connectionId === "-") {
    return;
  }

  if (entry.kind === "connection.open" || entry.kind === "connection.opening") {
    const existing = state.worker.openConnections.get(connectionId) || {};
    state.worker.openConnections.set(connectionId, {
      ...existing,
      url: entry.url,
      readyState: entry.readyState || (entry.kind === "connection.open" ? "OPEN" : "CONNECTING"),
      overlayId: entry.overlayId || existing.overlayId || "?",
      connectedAt: existing.connectedAt || entry.timestamp || new Date().toISOString(),
      lastMessageAt: existing.lastMessageAt || null
    });
  }

  if (entry.kind === "message.to-widget" || entry.kind === "message.from-widget") {
    const existing = state.worker.openConnections.get(connectionId);

    if (existing) {
      state.worker.openConnections.set(connectionId, {
        ...existing,
        readyState: entry.readyState || existing.readyState || "OPEN",
        overlayId: entry.overlayId || existing.overlayId,
        lastMessageAt: entry.timestamp || new Date().toISOString()
      });
    }
  }

  if (entry.kind === "connection.close") {
    state.worker.openConnections.delete(connectionId);
  }
}

function updateWorkerConnectionCount() {
  elements.workerConnectionCount.textContent = String(state.worker.openConnections.size);
  renderPredictionStateSummary();
  renderOverlayStatus();
}

function renderWorkerConnectionList() {
  elements.workerConnectionList.replaceChildren();

  if (state.worker.openConnections.size === 0) {
    const empty = document.createElement("li");
    empty.className = "worker-connection-entry is-empty";
    empty.textContent = "No hay conexiones WebSocket mock abiertas.";
    elements.workerConnectionList.append(empty);
    updateWorkerConnectionCount();
    return;
  }

  for (const [connectionId, connection] of state.worker.openConnections.entries()) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("code");
    const activity = document.createElement("code");

    item.className = "worker-connection-entry";
    title.textContent = `${connectionId} | Overlay ${connection.overlayId || "?"} | ${connection.readyState || "OPEN"}`;
    meta.textContent = connection.url || "";
    activity.textContent = `connectedAt=${connection.connectedAt || "-"} | lastMessageAt=${connection.lastMessageAt || "-"}`;
    item.append(title, meta, activity);
    elements.workerConnectionList.append(item);
  }

  updateWorkerConnectionCount();
}

function renderIframe({ manifest, html, css, script, fieldsSchema, fieldData, harnessScripts, frame = elements.frame, overlayId = "A" }) {
  const documentHtml = buildIframeDocument({
    manifest,
    html,
    css,
    script,
    fieldsSchema,
    fieldData,
    harnessScripts,
    overlayId
  });

  if (frame) {
    frame.srcdoc = documentHtml;
  }
}

function buildIframeDocument({ manifest, html, css, script, fieldsSchema, fieldData, harnessScripts, overlayId }) {
  const bridgeScript = `
(() => {
  const source = ${JSON.stringify(WIDGET_SOURCE)};
  const overlayId = ${JSON.stringify(overlayId || "A")};
  const safeValue = (value) => {
    if (typeof value === "undefined") {
      return undefined;
    }

    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return String(value);
    }
  };
  const send = (type, payload = {}) => {
    parent.postMessage({ source, type, overlayId, ...payload }, "*");
  };
  const formatArg = (arg) => {
    if (typeof arg === "string") {
      return arg;
    }

    try {
      return JSON.stringify(safeValue(arg));
    } catch (error) {
      return String(arg);
    }
  };

  window.__LAB_SE_INITIAL_LOAD__ = ${escapeScript(JSON.stringify(state.seFixtures.widgetLoad || {}))};
  window.__LAB_SE_EDITOR_MODE__ = ${JSON.stringify(!obsView?.enabled)};
  window.__LAB_FIELDS_SCHEMA__ = ${escapeScript(JSON.stringify(fieldsSchema))};
  window.__LAB_FIELDS__ = ${escapeScript(JSON.stringify(fieldData))};
  window.__LAB_WIDGET_MANIFEST__ = ${escapeScript(JSON.stringify(manifest))};
  window.__LAB_OVERLAY_ID__ = ${escapeScript(JSON.stringify(overlayId || "A"))};
  window.__LAB_WORKER_INITIAL_CONFIG__ = ${escapeScript(JSON.stringify({
    interceptWebSocket: state.worker.interceptWebSocket,
    workerUrl: state.worker.workerUrl,
    replayMode: state.worker.replayMode
  }))};
  window.__LAB_WORKER_INITIAL_STATE__ = ${escapeScript(JSON.stringify(buildWorkerPredictionStateSnapshot()))};
  window.__LAB_LOG__ = (level, message, data) => {
    send("LOG", { level, message: String(message), data: safeValue(data) });
  };

  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level] ? console[level].bind(console) : console.log.bind(console);
    console[level] = (...args) => {
      send("LOG", { level, message: args.map(formatArg).join(" "), data: safeValue(args) });
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    send("LOG", {
      level: "error",
      message: event.message,
      data: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        error: safeValue(event.error)
      }
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    send("LOG", {
      level: "error",
      message: "Unhandled promise rejection",
      data: safeValue(event.reason)
    });
  });
})();
`;

  const harnessTags = harnessScripts
    .map((content) => `<script>${escapeScript(content)}</script>`)
    .join("\n");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(manifest.name || "Widget preview")}</title>
    <style>
      html,
      body {
        min-height: 100%;
        margin: 0;
      }

      body {
        display: grid;
        place-items: center;
        background: transparent;
        color: #ffffff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 0;
      }
    </style>
    <style>${css}</style>
  </head>
  <body>
    ${html}
    <script>${escapeScript(bridgeScript)}</script>
    ${harnessTags}
    <script>${escapeScript(script)}</script>
  </body>
</html>`;
}

function emitSEPayload(actionKey, payload) {
  if (actionKey === "kvstoreUpdate" && seStoreHost?.injectKVUpdate(payload)) {
    writeLog("info", "lab", "kvstore:update persisted and broadcast to account widgets", payload);
    return;
  }
  const frameWindow = getOverlayFrame(state.overlays.activeId)?.contentWindow;
  const action = SE_ACTIONS[actionKey];

  if (!frameWindow) {
    writeLog("error", "lab", "Iframe no disponible");
    return;
  }

  frameWindow.postMessage({
    source: LAB_SOURCE,
    type: "SE_MOCK_EMIT",
    action: action.mockAction,
    payload
  }, "*");

  writeLog("info", "lab", `Emitido ${action.label}`, payload);
}

function handleWidgetMessage(event) {
  if (seStoreHost?.handle(event)) return;
  if (!["A", "B"].some((id) => getOverlayFrame(id)?.contentWindow === event.source)) return;
  const data = event.data;

  if (!data || data.source !== WIDGET_SOURCE) {
    return;
  }

  if (data.type === "LOG") {
    const prefix = data.overlayId ? `[${data.overlayId}] ` : "";
    writeLog(data.level || "log", "widget", `${prefix}${data.message || ""}`, data.data);
  } else if (data.type === "WORKER_V2_SYNC_REQUEST") {
    const overlayId = ["A", "B"].find((id) => getOverlayFrame(id)?.contentWindow === event.source);
    if (getTargetFrameResult(overlayId).frames.length) {
      reconcileBridgeV2FromHelix();
      postToWidgetFrames({ source: LAB_SOURCE, type: "WORKER_V2_STATE",
        connectionId: data.connectionId, payload: { ...buildBridgeV2Snapshot(), request_id: data.requestId } }, { target: overlayId });
    }
  } else if (data.type === "WORKER_WS_LOG") {
    appendWorkerConnectionLog(data.entry || {});
  }
}

function clearLogs() {
  state.logCount = 0;
  state.debugEntries = [];
  elements.logList.replaceChildren();
  updateLogCount();
}

function writeLog(level, source, message, data) {
  const normalizedLevel = ["log", "info", "warn", "error"].includes(level) ? level : "log";
  const item = document.createElement("li");
  const timestamp = new Date();
  const entry = {
    timestamp: timestamp.toISOString(),
    level: normalizedLevel,
    source,
    message,
    data: serializeLogData(data)
  };
  item.className = `log-entry log-${normalizedLevel} ${source === "widget" ? "log-from-widget" : ""}`;

  const time = document.createElement("time");
  time.dateTime = timestamp.toISOString();
  time.textContent = timestamp.toLocaleTimeString();

  const sourceNode = document.createElement("span");
  sourceNode.className = "log-source";
  sourceNode.textContent = source;

  const messageNode = document.createElement("span");
  messageNode.className = "log-message";
  messageNode.textContent = message;

  item.append(time, sourceNode, messageNode);

  if (typeof data !== "undefined") {
    const detail = document.createElement("pre");
    detail.textContent = stringifyLogData(data);
    item.append(detail);
  }

  elements.logList.append(item);
  state.logCount += 1;
  state.debugEntries.push(entry);

  if (state.debugEntries.length > 500) {
    state.debugEntries.shift();
  }

  updateLogCount();
  elements.logList.scrollTop = elements.logList.scrollHeight;
}

function updateLogCount() {
  elements.logCount.textContent = `${state.logCount} ${state.logCount === 1 ? "log" : "logs"}`;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function extractFieldData(fieldsSchema) {
  if (!fieldsSchema || typeof fieldsSchema !== "object") {
    return {};
  }

  const entries = Array.isArray(fieldsSchema)
    ? fieldsSchema
      .filter((field) => field && field.name)
      .map((field) => [field.name, field])
    : Object.entries(fieldsSchema);

  return Object.fromEntries(entries.map(([key, field]) => [key, getFieldDefault(field)]));
}

function getFieldDefault(field) {
  if (field && typeof field === "object") {
    if ("value" in field) {
      return field.value;
    }

    if ("default" in field) {
      return field.default;
    }

    if (field.type === "checkbox" || field.type === "boolean") {
      return false;
    }

    if (field.type === "number") {
      return 0;
    }
  }

  return "";
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`No se pudo cargar ${url.pathname}: ${response.status}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`No se pudo cargar ${url.pathname}: ${response.status}`);
  }

  return response.text();
}

function formatFieldValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function stringifyPayload(payload) {
  return JSON.stringify(payload, null, 2);
}

function stringifyLogData(data) {
  if (data instanceof Error) {
    return JSON.stringify({
      name: data.name,
      message: data.message,
      stack: data.stack
    }, null, 2);
  }

  try {
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return String(data);
  }
}

function serializeLogData(data) {
  if (typeof data === "undefined") {
    return undefined;
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack
    };
  }

  try {
    return JSON.parse(JSON.stringify(data));
  } catch (error) {
    return String(data);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createZipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const { date, time } = getZipDosDateTime(new Date());
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path.replaceAll("\\", "/"));
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);
    const localOffset = offset;
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);
    offset += localHeader.length + dataBytes.length;

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);

    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const centralOffset = offset;
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, endRecord], {
    type: "application/zip"
  });
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }

    table[index] = value >>> 0;
  }

  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getZipDosDateTime(dateValue) {
  const year = Math.max(1980, dateValue.getFullYear());

  return {
    date: ((year - 1980) << 9) | ((dateValue.getMonth() + 1) << 5) | dateValue.getDate(),
    time: (dateValue.getHours() << 11) | (dateValue.getMinutes() << 5) | Math.floor(dateValue.getSeconds() / 2)
  };
}

function resolveWidgetUrl(path) {
  return new URL(path, window.location.href);
}

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);

  if (Number.isNaN(number)) {
    return min;
  }

  return Math.min(Math.max(number, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeScript(value) {
  return String(value)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
}
