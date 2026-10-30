// Account-scoped storage broker. The sandboxed widget never accesses localStorage.
export function createSEStoreHost({ getFrames, storage, log = () => {}, accountId = "mock-channel-id" }) {
  const prefix = "broles-widget-lab:se-store:v1:" + accountId + ":";
  const memory = new Map();
  const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  function read(key) {
    if (storage) {
      const serialized = storage.getItem(prefix + key);
      return serialized === null ? undefined : JSON.parse(serialized);
    }
    return copy(memory.get(key));
  }

  function notify(key, value) {
    const payload = { listener: "kvstore:update", event: { data: {
      key: "customWidget." + key, value: copy(value)
    } } };
    // Hidden but live widgets still belong to the account. Worker routing is separate.
    for (const frame of getFrames()) {
      frame.contentWindow?.postMessage({
        source: "losbroles-widget-lab", type: "SE_MOCK_EMIT",
        action: "eventReceived", payload
      }, "*");
    }
  }

  function write(key, value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Store value must be JSON serializable");
    if (storage) storage.setItem(prefix + key, serialized);
    else memory.set(key, JSON.parse(serialized));
    notify(key, JSON.parse(serialized));
  }

  function handle(event) {
    const data = event.data;
    if (data?.source !== "losbroles-widget-lab-widget" || data.type !== "SE_STORE_REQUEST") return false;
    // An opaque srcdoc origin is expected; authenticate the actual iframe WindowProxy.
    const frame = getFrames().find((item) => item.contentWindow === event.source);
    if (!frame) return true;
    const response = {
      source: "losbroles-widget-lab", type: "SE_STORE_RESPONSE", requestId: data.requestId
    };
    try {
      if (typeof data.key !== "string" || !data.key) throw new TypeError("Store key must be a nonempty string");
      if (data.action === "get") response.value = read(data.key);
      else if (data.action === "set") write(data.key, data.value);
      else throw new TypeError("Unsupported store operation");
      log("info", "SE store " + data.action, { key: data.key, persistent: Boolean(storage) });
    } catch (error) {
      response.error = error.message;
      log("error", "SE store operation failed", { key: data.key, error: error.message });
    }
    event.source.postMessage(response, "*");
    return true;
  }

  function handleStorageEvent(event) {
    if (!event.key?.startsWith(prefix) || event.newValue === null) return;
    try { notify(event.key.slice(prefix.length), JSON.parse(event.newValue)); }
    catch (error) { log("error", "Invalid persisted SE store value", { error: error.message }); }
  }

  function injectKVUpdate(payload) {
    const data = payload?.event?.data;
    if (payload?.listener !== "kvstore:update" || !data?.key?.startsWith("customWidget.")) return false;
    write(data.key.slice("customWidget.".length), data.value);
    return true;
  }

  if (!storage) log("warn", "Persistent SE store unavailable; account storage is in memory until the lab closes");
  return { handle, handleStorageEvent, injectKVUpdate };
}
