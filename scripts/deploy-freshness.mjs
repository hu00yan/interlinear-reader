// 部署新鲜度探测：比对「线上部署」与「本地构建」的 build.json 戳（所在 commit）。
// 2026-11 事故：标点丢失修复（0bb0813）早已进 main，但 Pages 部署停在旧构建，
// 线上用户看到的仍是字连着字的旧版本——dict 健康探针（selfcheck）测不出这种落后。
// 设计：不比 chunk hash——vite 产物 hash 随构建环境（node/路径/module-id 盐）漂移，
// 同一源码本地与 Cloudflare 产物 hash 不同（2026-11-05 实测两环境 hash 必不一致）。
// 只比构建后写出的 dist/build.json（scripts/write-build-stamp.mjs），与构建环境无关。
// 用法：node scripts/deploy-freshness.mjs [baseUrl]（默认 https://ilreader.pages.dev）
// 本地无 dist 时 SKIP（退出 0）；线上落后或超前本地 commit 即 FAIL（提示重建/重部署）。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = (
  process.argv[2] ??
  process.env.ILR_DEPLOY_BASE ??
  "https://ilreader.pages.dev"
).replace(/\/$/, "");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localStampPath = join(root, "packages/web/dist/build.json");

function readStampFile(p) {
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return typeof j.commit === "string" ? { commit: j.commit, builtAt: j.builtAt ?? "" } : null;
  } catch {
    return null;
  }
}
function readStampObj(j) {
  return j && typeof j.commit === "string" ? { commit: j.commit, builtAt: j.builtAt ?? "" } : null;
}

const local = existsSync(localStampPath) ? readStampFile(localStampPath) : null;
if (!local) {
  console.log("FRESHNESS SKIP — 本地无 packages/web/dist/build.json（先 npm run build 再探测）");
  process.exit(0);
}

let served = null;
try {
  const resp = await fetch(`${base}/build.json`, { headers: { "Cache-Control": "no-cache" } });
  if (resp.status === 404) {
    console.error(
      `FRESHNESS FAIL — ${base}/build.json 404：线上是「写 build.json 之前」的旧部署（无指纹），视为落后。\n` +
        `  处置：确认 Cloudflare Pages git 集成仍在构建 main，等新部署完成后再探。`
    );
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`FRESHNESS FAIL — ${base}/build.json 返回 ${resp.status}`);
    process.exit(1);
  }
  served = readStampObj(await resp.json());
} catch (e) {
  console.error(`FRESHNESS FAIL — 无法访问 ${base}：${e.cause?.code ?? e.message}`);
  process.exit(1);
}
if (!served) {
  console.error(`FRESHNESS FAIL — ${base}/build.json 形状不对（无 commit 字段）`);
  process.exit(1);
}
if (served.commit === local.commit) {
  console.log(
    `FRESHNESS OK — ${base} 与本地同 commit（${served.commit}${
      served.builtAt ? `，构建于 ${served.builtAt.slice(0, 16).replace("T", " ")}` : ""
    }）`
  );
  process.exit(0);
}
console.error(
  `FRESHNESS FAIL — 部署与本地不同 commit：线上 ${served.commit}（${served.builtAt.slice(0, 10)}） ≠ 本地 ${local.commit}\n` +
    (served.commit === "unknown"
      ? `  线上构建环境拿不到 git 指纹（unknown）：确认 Pages 构建命令跑在 git checkout 目录内。\n`
      : `  处置：确认 Cloudflare Pages git 集成仍在构建 main；或手动部署 packages/web/dist。\n`)
);
process.exit(1);
