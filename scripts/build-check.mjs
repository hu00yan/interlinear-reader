// Build check for Pages: the shippable static dir is packages/web/dist
// (vite build, owned by web track). Track D asserts deployability:
// dist exists + dict shards present + no real secrets in output.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const dist = join(root, "packages/web/dist");
if (!existsSync(join(dist, "index.html"))) fails.push("packages/web/dist/index.html missing — run web build (packages/web/dist/index.html)");
if (!existsSync(join(dist, "assets"))) fails.push("packages/web/dist/assets missing (packages/web/dist/assets)");
for (const lang of ["en", "de", "fr", "it", "es", "ru", "ja"]) {
  let files = [];
  try { files = readdirSync(join(root, "public/dict", lang)); } catch { /* missing */ }
  if (!files.some((f) => f.endsWith(".dict.br"))) fails.push(`public/dict/${lang}/*.dict.br missing`);
}
// secret scan over shipped JS: real-looking keys must never be bundled.
// (sk-test* dev keys are short/hyphenated and won't match {20,} alnum.)
if (existsSync(join(dist, "assets"))) {
  for (const f of readdirSync(join(dist, "assets")).filter((x) => x.endsWith(".js"))) {
    const t = readFileSync(join(dist, "assets", f), "utf8");
    if (/sk-[A-Za-z0-9]{20,}/.test(t)) fails.push(`${f} looks like it embeds a real secret`);
  }
}
if (fails.length) { console.error("BUILD FAIL\n" + fails.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
console.log("BUILD OK: packages/web/dist shippable, 7-lang .br shards present, no secrets in bundle");
