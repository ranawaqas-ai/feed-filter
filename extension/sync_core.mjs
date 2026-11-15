// Chrome injects a given content-script file only once per frame, even when two
// content_scripts entries (MAIN and ISOLATED world) list it. The MAIN-world bridge
// therefore loads a generated copy of shared/core.js. Run after editing core.js:
//   node extension/sync_core.mjs
// test/core.test.mjs fails if the copy is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "shared");
export const HEADER = "// GENERATED from core.js by extension/sync_core.mjs; do not edit. Loaded in the page's MAIN world.\n";
const src = readFileSync(path.join(dir, "core.js"), "utf8");
writeFileSync(path.join(dir, "core.main.js"), HEADER + src);
console.log("sync_core: wrote src/shared/core.main.js");
