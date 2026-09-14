# Track A — web 前端壳（`packages/web`）

纯静态阅读壳：EPUB/TXT/URL 摄入 → 分词/lemma → 词典注出 → 三级过滤 → 分页渲染。
LLM 只走 OpenAI 兼容协议，浏览器直调，无代理、无服务端、无数据库。

```bash
cd packages/web
npm run dev      # 本地开发
npm run verify   # Track A 无头验收（node + jsdom，fixture EPUB→注出→过滤→缓存键→持久化）
npm run build    # tsc + vite build + 首屏体积验收（全过才算修完）
```

## 首屏预算（B1）

- 上限：首屏 JS **<60KB gzip**（`scripts/check-size.mjs`，`LIMIT_KB = 60`）。
- 口径：只计入口 chunk；`lang-dict / epub / llm / url-ingest` 为懒加载块，不计入——但前提是它们**真懒加载**。
- `vite.config.ts` 置 `build.modulePreload = false`。Vite 默认的 `modulepreload`
  会让 `dist/index.html` 首屏就预取懒加载块（实测预取 `epub ~31KB + lang-dict + llm` gzip），
  使“首屏 8KB”失真。`check-size.mjs` 每次构建断言 `dist/index.html` 无 `modulepreload`，
  有即 FAIL 并提示重关预取后重构建。

## 缓存键 sha1（B2）

- 词级：`sha1(lang|target|lemma|)`，句级：`sha1(lang|target||归一化句)`（见 `src/lib/hash.ts`）。
- 归一化：NFKC + 小写（ja 外）+ 去首尾空白 + 连续空白折叠。
- `sha1Hex` 优先 `SubtleCrypto`；`file://` 等非安全上下文不可用时回退**内嵌同步纯 JS SHA1**
  （`sha1Sync`，RFC 3174，无依赖），与 `SubtleCrypto` 同值，恒为 **40 小写 hex**。
  旧的 FNV 回退（`fnv…` 非 40 hex）已删除。
- 参考向量：`sha1('') = da39a3…078909`，`sha1('abc') = a9993e…cd0d89`，
  `wordCacheKey('en','zh','Cat') = sha1('en|zh|cat|')`。

## 存储键：本地键 vs 服务端键对照表（B3）

CONTRACT.md 的主张不动；下表只做口径对照，冲突处以“双写/映射”兼容。

| 用途 | 本地键（Track A 写/读） | 服务端键（Track D 主张，Track A 不写） | 说明 |
|---|---|---|---|
| BYOK | `localStorage["ilr:key"]`（+ 规范 `ilr.settings.v1`.apiKey 双写） | — | 只去 LLM provider 域；同源 `/api/*` 永不带 `apiKey/x-api-key/bearer` |
| 模式 | `localStorage["ilr:mode"]` = `a\|b\|c`（+ `ilr.settings.v1`.mode 双写，内部枚举 `A/B/C`） | — | `saveSettings` 双写；`loadSettings` 以 CONTRACT 键为准迁移，大小写归一 |
| 设置全量 | `ilr.settings.v1`（JSON：baseUrl/model/target/mode/费用上限/过滤/分页） | — | 规范存储；`ilr:key/ilr:mode` 是它的 CONTRACT 镜像 |
| 词释义缓存 | `ilr.gloss-cache.v1`（key = 上述 sha1 词键，localStorage LRU 2000 条） | `/api/cache?key=<sha256hex>`（`sha256(lang\|term\|context)`，TTL 30d，>8KB 413） | 两套键**不互通**：本地 sha1 只读本地，服务端 sha256 只走 `/api/*`；服务端 key 永不含 apiKey 材料 |
| 句缓存（内存） | 会话 Map（key = 句级 sha1） | 同上 | 刷新即失，不持久化 |
| 已认识/生词本 | `ilr.known.v1` / `ilr.vocab.v1`（+ IndexedDB `ilr/vocab` 镜像） | — | 刷新不丢；清空逻辑按 `ilr.` 前缀删，已覆盖 CONTRACT 键 |

Key-hygiene：`ilr:key` 的值只出现在 `Authorization: Bearer …`（LLM 域）；
可用 E2E 嗅探同源 `/api/*` 流量断言无 key 材料（CONTRACT 原文要求，Track A 侧天然满足——根本不发同源 api 请求）。

## 渲染契约（B3/B5）

- Reader root：`[data-testid="reader"]` + `data-mode="a|b|c"`（`renderParagraphs` 写入；
  内部 `Mode.A/B/C` 经 `modeToContract` 映射，CONTRACT.md 不动）。
- Token：`.token[data-term]`（`data-term` = lemma；老 `.tok` 类名保留并存，CSS 双选择器兼容）。
- Gloss：`.gloss`（显隐沿用 `hidden-gloss/missing`；点击选中 `.selected` + `.tapped` 并存，兼容
  CONTRACT 的 `.token.tapped .gloss` 口径）。
- 模式切换器：`select[data-testid="mode-switch"]`，option 值为小写 `a|b|c`
  （阅读页 + 设置页各一个，变更经 `modeFromContractValue` 写回内部枚举并 `saveSettings` 双写）。
- `glossSource` 语义（B5 修正，此前全部误标 `cache`）：
  `dict-loader.getGlossWithSource()` 区分本地缓存命中（`cache`）与词典分片/mock 首命中（`dict`），
  缺词返回 `null`（由调用方送 LLM）；`annotateParagraphs` 经 `getGlossesWithSource` 原样标注，
  `llm` 覆盖仍优先。`getGloss/getGlosses` 保留为薄封装，验收脚本行为不变。

## 目录

- `src/ingest/` — epub/txt/url（fixture：`public/fixtures/hello-en.epub`）
- `src/reader/` — langpack-loader（`langpacks/{lang}.ts` 懒加载约定）/ tokenize / filters / render
- `src/dict/` — dict-loader（`DICTS` 按语言注册，缺省 mock）/ mock-dict / stopwords
- `src/lib/hash.ts` — sha1 + 归一化；`src/lib/cache.ts` — localStorage LRU + 句内存缓存
- `src/llm/provider.ts` — OpenAI 兼容（Response API 不做）
- `src/store/settings.ts` — 设置 + CONTRACT 双写/迁移；`src/vocab/store.ts` — 已认识/生词本
- `src/ui/app.ts` — 书架/阅读/生词/设置四 Tab
- `scripts/verify-track-a.ts` — 无头验收；`scripts/check-size.mjs` — 首屏验收
