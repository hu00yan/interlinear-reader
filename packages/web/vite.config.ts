import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// 构建指纹 = 所在 commit 短 hash（git 不可用/CI 深拷贝时退化为 unknown）。
// 用途：设置页展示 + scripts/deploy-freshness.mjs 比对「线上部署 vs 本地构建」，
// 防 2026-11 事故重演：源码已修标点丢失，但 Pages 部署停在旧构建，线上用户不可见。
function gitShortHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: {
    __ILR_BUILD__: JSON.stringify(gitShortHash()),
  },
  build: {
    target: "es2020",
    // 懒加载块（lang-dict/epub/llm/url-ingest）必须真懒加载：默认的 modulepreload 会让
    // 首屏就预取它们，导致 check-size 的“首屏口径”失真，故关闭。
    modulePreload: false,
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        // 语言包 / 词典 / EPUB 解析全部懒加载，不计入首屏
        manualChunks(id) {
          // lang-packs：web 直连的 TrackB 真包（reader/langpacks/{en,de,fr,it,es,ru}.ts
          // 静态引入），必须同进 lang-dict 懒加载块，否则首屏 60KB 门炸。
          if (id.includes("reader/langpacks") || id.includes("lang-packs") || id.includes("dict/"))
            return "lang-dict";
          if (id.includes("ingest/epub") || id.includes("jszip")) return "epub";
          if (id.includes("ingest/mobi") || id.includes("foliate-mobi")) return "mobi";
          if (id.includes("ingest/url")) return "url-ingest";
          if (id.includes("/llm/") || id.includes("provider/golden")) return "llm";
          return undefined;
        },
      },
    },
  },
});
