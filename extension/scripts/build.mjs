// Builds the extension into dist/: bundles each entry with esbuild and copies static/ verbatim.
// PKB_DEFAULT_SERVER_URL pre-fills the server address in the login forms (default empty).

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const common = {
  bundle: true,
  target: "chrome120",
  logLevel: "info",
  legalComments: "none",
  charset: "utf8",
  define: {
    __PKB_DEFAULT_SERVER_URL__: JSON.stringify(process.env.PKB_DEFAULT_SERVER_URL ?? ""),
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "static"), dist, { recursive: true });

await Promise.all([
  // MV3 service worker declared with "type": "module".
  build({ ...common, entryPoints: [join(root, "src/background.ts")], outfile: join(dist, "background.js"), format: "esm" }),
  ...["inject", "content", "popup", "options"].map((name) =>
    build({ ...common, entryPoints: [join(root, `src/${name}.ts`)], outfile: join(dist, `${name}.js`), format: "iife" }),
  ),
]);
