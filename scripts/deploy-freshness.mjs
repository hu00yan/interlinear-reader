// 部署新鲜度探测：比对「线上部署的 bundle」与「本地 dist」是否同一构建。
// 2026-11 事故：标点丢失修复（0bb0813）早已进 main，但 Pages 部署停在旧构建，
// 线上用户看到的仍是字连着字的旧版本——dict 健康探针（selfcheck）测不出这种落后。
// 用法：node scripts/deploy-freshness.mjs [baseUrl]（默认 https://ilreader.pages.dev）
// 本地无 dist 时 SKIP（退出 0）；hash 不一致即 FAIL（提示重建/重部署）。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = (
  process.argv[2] ??
  process.env.ILR_DEPLOY_BASE ??
  "https://ilreader.pages.dev"
).replace(/\/$/, "");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(root, "packages/web/dist/index.html");

const distHtml = existsSync(distIndex) ? readFileSync(distIndex, "utf8") : "";
const distEntry = distHtml.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? null;
if (!distEntry) {
  console.log("FRESHNESS SKIP — 本地无 packages/web/dist（先 npm run build 再探测）");
  process.exit(0);
}

let servedEntry = null;
let servedHtml = "";
try {
  const resp = await fetch(`${base}/`, { headers: { "Cache-Control": "no-cache" } });
  if (!resp.ok) {
    console.error(`FRESHNESS FAIL — ${base}/ 返回 ${resp.status}`);
    process.exit(1);
  }
  servedHtml = await resp.text();
  servedEntry = servedHtml.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? null;
} catch (e) {
  console.error(`FRESHNESS FAIL — 无法访问 ${base}：${e.cause?.code ?? e.message}`);
  process.exit(1);
}
if (!servedEntry) {
  console.error(`FRESHNESS FAIL — ${base}/ 首页无 index-*.js 引用（非本应用部署？）`);
  process.exit(1);
}
if (servedEntry === distEntry) {
  console.log(`FRESHNESS OK — ${base} 与本地 dist 同构建（index-${servedEntry}.js）`);
  process.exit(0);
}
console.error(
  `FRESHNESS FAIL — 部署落后/不一致：线上 index-${servedEntry}.js ≠ 本地 dist index-${distEntry}.js\n` +
    `  处置：确认 Cloudflare Pages git 集成仍在构建 main；或 wrangler login 后手动部署 packages/web/dist。`
);
process.exit(1);
