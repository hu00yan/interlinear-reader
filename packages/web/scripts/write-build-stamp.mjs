// 构建后写 dist/build.json（所在 commit + 时间）。设计原因见 vite.config.ts 注释：
// 指纹不进 bundle（chunk hash 随构建环境漂移，跨环境比对必假报），只写元数据文件，
// 供设置页运行时 fetch 展示 + scripts/deploy-freshness.mjs 环境无关地比对。
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
function gitShortHash() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
const commit = gitShortHash() ?? "unknown";
writeFileSync(
  join(dist, "build.json"),
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2) + "\n"
);
console.log(`build.json: ${commit}`);
