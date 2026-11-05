import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const shared = await read("src/predictions/state.mjs");
if (await read("src/interactions/state.mjs") !== shared) throw new Error("Lab poll state copy differs");
const interactions = await read("src/interactions/interactions.mjs");
const origin = JSON.parse(await read("src/interactions/source.json"));
for (const [name, content] of Object.entries({ state: shared, interactions })) {
  if (createHash("sha256").update(content).digest("hex") !== origin.sha256[name]) throw new Error("Worker protocol differs: " + name);
}
const client = await read("src/interactions/client.js");
const generated = '// Generated, self-contained StreamElements JS tab. Run node scripts/build-interactions.mjs.\n(() => {\n' +
  shared.replace(/^export /gm, "") + "\n" + interactions.replace(/^import .*from "\.\/state.mjs";\n/m, "").replace(/^export /gm, "") + "\n" + client + "\n})();\n";
const target = new URL("../widgets/interacciones-v3/widget.js", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== generated) throw new Error("Rebuild interactions widget");
} else await writeFile(target, generated);
