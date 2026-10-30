class MockEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, once: options.once });
  }
  dispatchEvent(e) {
    for (const entry of [...(this.listeners.get(e.type) || [])]) {
      if (entry.once) this.listeners.set(e.type, this.listeners.get(e.type).filter((item) => item !== entry));
      entry.listener.call(this, e);
    }
    return true;
  }
}
class MockEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
const makeEvent = (type, init) => new MockEvent(type, init);
function evaluate(source, globals = {}) {
  const defaults = { EventTarget: MockEventTarget, Event: MockEvent, CustomEvent: MockEvent, MessageEvent: MockEvent,
    CloseEvent: MockEvent, DOMException: Error, queueMicrotask: (callback) => Promise.resolve().then(callback) };
  const scope = { ...defaults, ...globals };
  return new Function(...Object.keys(scope), source)(...Object.values(scope));
}

export { MockEventTarget, makeEvent, evaluate };
