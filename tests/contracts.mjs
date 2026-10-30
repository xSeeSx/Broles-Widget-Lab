import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { runContractTests } from "./contract-suite.mjs";
import { runAppTests } from "./app-suite.mjs";
import { MockEventTarget, makeEvent, evaluate } from "./test-runtime.mjs";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const sources = Object.fromEntries(await Promise.all(Object.entries({
  host: "src/harness/se-store-host.js", contract: "src/harness/prediction-contract.js",
  se: "src/harness/se-mock.js", worker: "src/harness/worker-mock.js", twitch: "src/harness/twitch-eventsub-mock.js"
}).map(async ([key, path]) => [key, await read(path)])));
const results = await runContractTests({
  sources, evaluate, createEventTarget: () => new MockEventTarget(),
  event: (type) => makeEvent(type), customEvent: (type, detail) => makeEvent(type, { detail }),
  messageEvent: (init) => makeEvent("message", init),
  flush: async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); },
  timers: { setTimeout() { return 1; }, clearTimeout() {} }
});
results.push(...await runAppTests({ source: await read("src/app.js"), contract: sources.contract, evaluate, assert }));
for (const name of results) console.log("PASS " + name);
console.log(results.length + " contract checks passed. Browser/OBS validation is separate.");
