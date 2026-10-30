// A presentation mode for running this same harness inside a real OBS Browser Source.
// This module observes native events. It never fabricates CEF behavior or changes OBS.
export function initializeOBSView({ onResize, log }) {
  const params = new URLSearchParams(window.location.search);
  const enabled = params.get("view") === "obs";
  const link = document.querySelector("#obsViewLink");
  const toggle = document.querySelector("#obsControlsToggle");
  const output = document.querySelector("#obsDiagnostics");
  const events = [];
  const diagnostics = {
    mode: enabled ? "obs-test-view" : "lab",
    obsAPI: typeof window.obsstudio === "object",
    pluginVersion: window.obsstudio?.pluginVersion || null,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentVisibility: document.visibilityState,
    lastNativeEvent: null,
    rafSample: null,
    note: "rAF mide callbacks de esta página, no los FPS de salida ni fotogramas perdidos de OBS."
  };

  function render() {
    output.textContent = JSON.stringify(diagnostics, null, 2);
  }

  function setControls(open) {
    document.body.classList.toggle("obs-controls-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = "Ocultar controles (F2)";
  }

  function record(type, detail) {
    const entry = { type, detail, at: new Date().toISOString() };
    diagnostics.lastNativeEvent = entry;
    events.push(entry);
    if (events.length > 100) events.shift();
    log("info", "Entorno de render: " + type, entry);
    render();
  }

  // The names below are documented by obsproject/obs-browser. No fake window.obsstudio.
  for (const type of ["obsSourceVisibleChanged", "obsSourceActiveChanged", "obsSceneChanged"]) {
    window.addEventListener(type, (event) => record(type, event.detail ?? null));
  }
  document.addEventListener("visibilitychange", () => {
    diagnostics.documentVisibility = document.visibilityState;
    record("document.visibilitychange", { visibility: document.visibilityState });
  });

  if (enabled) {
    document.body.classList.add("obs-view");
    toggle.hidden = false;
    setControls(params.get("controls") === "1");
    toggle.addEventListener("click", () => setControls(false));
    window.addEventListener("keydown", (event) => {
      if (event.key === "F2") {
        event.preventDefault();
        setControls(!document.body.classList.contains("obs-controls-open"));
      } else if (event.key === "Escape") {
        setControls(false);
      }
    });
    window.addEventListener("resize", () => {
      diagnostics.viewport = { width: window.innerWidth, height: window.innerHeight };
      onResize();
      render();
    });

    // Bounded samples, only while the diagnostics drawer is open. No FPS cap is applied.
    let previous;
    let intervals = [];
    let sampling = false;
    function sample(now) {
      if (!document.body.classList.contains("obs-controls-open")) {
        sampling = false;
        previous = undefined;
        intervals = [];
        return;
      }
      if (previous !== undefined) intervals.push(now - previous);
      previous = now;
      if (intervals.length === 120) {
        const sorted = [...intervals].sort((a, b) => a - b);
        diagnostics.rafSample = {
          callbacks: intervals.length,
          meanIntervalMs: Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length * 10) / 10,
          p95IntervalMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
          maxIntervalMs: Math.round(sorted.at(-1) * 10) / 10
        };
        render();
        intervals = [];
      }
      window.requestAnimationFrame(sample);
    }
    // Restart a bounded sampling loop each time the drawer opens.
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains("obs-controls-open") && !sampling) {
        sampling = true;
        window.requestAnimationFrame(sample);
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (params.get("controls") === "1") {
      sampling = true;
      window.requestAnimationFrame(sample);
    }
  }

  function updateLink(widgetId) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("view", "obs");
    url.searchParams.set("widget", widgetId);
    url.searchParams.set("controls", "1");
    link.href = url.href;
  }
  updateLink(params.get("widget") || "prediccion");
  render();
  return {
    enabled,
    preferredWidgetId: params.get("widget"),
    updateLink,
    report: () => ({ ...diagnostics, nativeEvents: [...events] })
  };
}
