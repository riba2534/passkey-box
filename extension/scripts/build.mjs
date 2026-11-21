// Builds the extension into dist/: bundles each entry with esbuild and copies static/ verbatim.
// PKB_DEFAULT_SERVER_URL pre-fills the server address in the login forms (default empty).

import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const common = {
  bundle: true,
  target: "chrome120",
  logLevel: "info",
  legalComments: "eof",
  charset: "utf8",
  loader: { ".png": "dataurl" },
  define: {
    __PKB_DEFAULT_SERVER_URL__: JSON.stringify(process.env.PKB_DEFAULT_SERVER_URL ?? ""),
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "static"), dist, { recursive: true });
await cp(join(root, "..", "LICENSE"), join(dist, "LICENSE"));

const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const notices = await Promise.all(Object.entries(lock.packages)
  .filter(([path, pkg]) => path && !pkg.dev)
  .map(async ([path, pkg]) => {
    const directory = join(root, path);
    const files = (await readdir(directory)).filter((name) => /^(license|notice)(\.|$)/i.test(name));
    const texts = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    return [`${path.split("node_modules/").pop()} ${pkg.version}`, ...texts].join("\n\n");
  }));
await writeFile(join(dist, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"));

await Promise.all([
  // MV3 service worker declared with "type": "module".
  build({
    ...common,
    entryPoints: [join(root, "src/background.ts")],
    outfile: join(dist, "background.js"),
    format: "esm",
  }),
  ...["inject", "content", "popup", "options"].map((name) =>
    build({ ...common, entryPoints: [join(root, `src/${name}.ts`)], outfile: join(dist, `${name}.js`), format: "iife" }),
  ),
]);
