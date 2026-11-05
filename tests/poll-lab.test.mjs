import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { pollEventTransition } from "../src/interactions/interactions.mjs";

const source = await readFile(new URL("../src/harness/poll-lab.mjs", import.meta.url), "utf8");
function setup() {
  let now = Date.parse("2026-11-05T12:00:00Z"), identity = 0, timerId = 0;
  const nodes = new Map(), timers = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { value: "", handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return nodes.get(id);
  } };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const create = runInNewContext(source.replace(/^import .*;\n/m, "").replace(/^export /gm, "") + "\ncreatePollLab;", {
    pollEventTransition, Date: ClockDate, crypto: { randomUUID: () => String(++identity) },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id)
  });
  const lab = create({ onChange() {} }); lab.mount(document);
  const set = (id, value) => { document.getElementById(id).value = value; };
  set("pollTitle", "Encuesta"); set("pollChoiceCount", "2"); set("pollDuration", "15");
  for (let i = 0; i < 5; i++) { set("pollName" + i, "Opción " + i); set("pollVotes" + i, "0"); }
  return { lab, timers, set, click: id => document.getElementById(id).handlers.click(), advance: ms => { now += ms; } };
}
test("a throttled automatic poll timer reports Twitch's original end, not the host wake time", () => {
  const f = setup(); f.click("pollBegin"); const end = f.lab.poll.ends_at;
  const timer = [...f.timers.values()][0]; f.advance(60000); timer.fn();
  assert.equal(f.lab.poll.status, "completed"); assert.equal(f.lab.poll.ended_at, end);
});
test("termination uses submitted votes and a callback from an old poll cannot end a new poll", () => {
  const f = setup(); f.click("pollBegin"); const oldTimer = [...f.timers.values()][0];
  f.set("pollVotes0", "7"); f.click("pollSendVotes"); f.set("pollVotes0", "99");
  f.advance(1000); f.click("pollEnd"); assert.equal(f.lab.poll.choices[0].votes, 7);
  f.click("pollBegin"); const id = f.lab.poll.id; oldTimer.fn();
  assert.equal(f.lab.poll.id, id); assert.equal(f.lab.poll.status, "active");
});
