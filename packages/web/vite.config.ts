import { defineConfig } from "vite";

// 注：构建指纹不走 vite define（__ILR_BUILD__ 已废弃）——chunk hash 随构建环境
// （node/路径/module-id 盐）漂移，同一源码本地与 Cloudflare 产物 hash 不同，
// 跨环境比对会假报。现改为构建后写 dist/build.json（scripts/write-build-stamp.mjs），
// 运行时 fetch 展示，scripts/deploy-freshness.mjs 只比这个文件。
export default defineConfig({
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
