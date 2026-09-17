import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
await build({
  entryPoints: [`${root}src/main.mjs`],
  outfile: `${root}dist/interlinear-reader.user.js`,
  bundle: true,
  format: "iife",
  target: "es2022",
  charset: "utf8",
  banner: { js: await readFile(`${root}header.txt`, "utf8") },
  legalComments: "inline",
});
console.log("Built packages/userscript/dist/interlinear-reader.user.js");
