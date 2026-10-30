import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const shared = await readFile(new URL("../src/predictions/state.mjs", import.meta.url), "utf8");
const origin = JSON.parse(await readFile(new URL("../src/predictions/source.json", import.meta.url), "utf8"));
if (createHash("sha256").update(shared).digest("hex") !== origin.sha256) throw new Error("Shared protocol differs from recorded Worker source");
const client = await readFile(new URL("../src/predictions/client.js", import.meta.url), "utf8");
const generated = '// Generated, self-contained StreamElements JS tab. Run node scripts/build-predictions.mjs.\n(() => {\n' + shared.replace(/^export /gm, "") + "\n" + client + "\n})();\n";
const path = new URL("../widgets/prediccion-v2/widget.js", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== generated) throw new Error("Rebuild prediction widget");
} else await writeFile(path, generated);
