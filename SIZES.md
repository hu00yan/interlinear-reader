# SIZES — Track B 每语言包体积表（2026-09-12 实测，种子词典阶段）

预算三栏（`scripts/budget.mjs` gates，`npm run verify` 卡点）：

| 栏 | 内容 | 预算 | 现状（种子阶段） | 说明 |
|---|---|---|---|---|
| 首屏 | 首屏 JS gzip（`packages/web/dist/assets` 非懒加载部分） | ≤60KB（`BUDGETS.firstScreenJsGzip`，owner 见 `packages/web/scripts/check-size.mjs`） | 见 web 构建产物 | 词典分片/分词包/wasm 均不进首屏 |
| 懒加载 | 单语言包 `.br` 总和（`public/dict/{lang}/`）+ 分词包 JS（按语言动态 import） | 单语言 ≤200KB（`BUDGETS.singleLangPackBr`）；语言包总体 5–10MB/语言（含 wasm 运行时） | 单语言 br ~2KB，分词包源码单语言 ~3–7KB | 运行时按需加载 1–N 个 shard，首屏词典流量可忽略 |
| 缓存 | R2 总量 + 端侧常驻（IndexedDB/OPFS） | R2 ≤50MB（`BUDGETS.r2TotalBr`，free tier 10GB 内） | 全语言 br 总和 ~15KB | 分片 immutable-ish；IPADIC/LLM 溢出走缓存，不计入首屏 |

当前种子阶段全语言 br 总和仅 ~15KB；真实 dumps 接入后以 `public/dict/sizes.json`
（构建自动更新）+ 下表方法复测为准，超预算则按词频裁剪：
`--maxEntries=N [--freq=lemma\tcount.tsv]` 只保留高频 Top N（见 DICT_SOURCES.md）。

## 1. 分词包 JS（懒加载栏；`packages/lang-packs/src/`，未压缩源码体积）

| lang | 文件 | bytes | 说明 |
|---|---|---|---|
| en | en.mjs | 4155 | Porter/Snowball-en 子集 + ~120 不规则形 |
| de | de.mjs | 3657 | 名词复数/动词/形容词尾 + ß/变音处理 + B3 strasse/schule/liebe/sprache/leben 守卫 |
| fr | fr.mjs | 3486 | 省音 clitic 切分 + 动词/名词尾 |
| it | it.mjs | 3543 | clitic 切分 + 变位/性数尾 |
| es | es.mjs | 3510 | 变位/性数尾（查表前去重音） |
| ru | ru.mjs | 5528 | 动词体/格尾（ё→е归一，非 pymorphy） |
| ja | ja.mjs | 7252 | builtin 假名/汉字切分 + wasm 注入点 |
| — | _latin.mjs（共享） | 1240 | latin 系共享 segment/stripSuffixes |
| — | index.mjs（入口/契约） | 1843 | getLangPack/loadLangPack/segment/lemmatize/isStopword |
| 合计 | | 34214 (~33KB) | 按语言懒加载：单语言实际加载 ≈ 本语言文件 + _latin（ja 不需 _latin） |

gzip 后约为源码 ~35%（估算，rollup/esbuild 上线前以产物为准）。
首屏不含以上任何文件（动态 import，JA 页才拉 wasm）。

## 2. 词典分片（懒加载栏；`public/dict/{lang}/`，种子阶段；`npm run build:dict` 输出）

| lang | entries | shards | json(B) | br(B) | gz(B) | 备注 |
|---|---|---|---|---|---|---|
| en | 53 | 43 | 3010 | 2898 | 3152 | |
| de | 41 | 31 | 2054 | 1967 | 2269 | 含 B3 strasse 种子 |
| fr | 40 | 34 | 1917 | 1966 | 2340 | 含 cheval 种子 |
| it | 38 | 35 | 1736 | 1813 | 2249 | |
| es | 40 | 34 | 1859 | 1884 | 2277 | |
| ru | 40 | 35 | 2077 | 2143 | 2560 | |
| ja | 50 | 50 | 2435 | 2610 | 3222 | 单字 lemma 多，shard 最碎 |
| 合计 | 302 | 262 | 15088 | 15281 | 18069 | |

单 shard 均值 <100B（种子阶段）；运行时按需加载 1–N 个 shard + IndexedDB 常驻（缓存栏），
首屏词典流量可忽略不计。

## 3. 缓存栏：端侧常驻 + R2（不进首屏）

| 项 | 体积/策略 |
|---|---|
| IndexedDB（`interlinear-dict`库，`dict-loader/src/cache.mjs`） | 按 shard 常驻 `{lang}/{shard}`，内存 + IDB 双层；miss 记入 Track C LLM 队列（`getMisses`，上限 2000） |
| R2 总量（`dict/{trackB-lang}/*.json.br`） | 种子阶段 ~15KB；预算 ≤50MB（`budget.mjs`） |
| 日语 wasm（可选运行时，不进首屏，实测见 DICT_SOURCES.md §JA） | lindera-wasm@6.0.0 tarball 708kB / unpacked 1.8MB；kuromoji 否决（41.3MB）；IPADIC ~10MB OPFS 缓存 |

| 日语 wasm 项 | 体积 |
|---|---|
| lindera-wasm@6.0.0（选用）tarball / unpacked | 708kB / 1.8MB |
| kuromoji@0.1.2（备选）unpacked | 41.3MB（否决） |
| IPADIC（lindera Releases 按需下载，OPFS 缓存） | ~10MB 量级，以实际 release 为准（未进首屏） |

## 4. 真实词典量级预估（接入 raw dumps 后复测，超预算用 `--maxEntries` 裁剪）

| lang | 主力来源 | 预估 br | 预算内？ |
|---|---|---|---|
| en | ECDICT（~70万词条，取高频子集） | 按词频裁至 ≤8MB | ✅ 需裁剪（只收录 Top ~15万 lemma） |
| de/fr/it/es | FreeDict（各 ~2–5万条）+ Wiktionary 补齐 | 各 ≤3MB | ✅ |
| ru | FreeDict rus-eng（~4万条）+ Wiktionary | ≤3MB | ✅ |
| ja | JMdict_e（~20万 entries，keb+reb 双 lemma） | ≤10MB（高频优先+释义截断至 6 条/已做） | ⚠️ 需词频裁剪，见未决事项 |

复测命令：`npm run build:dict && npm run report:coverage && cat public/dict/sizes.json`。
裁剪命令：`npm run build:dict -- --maxEntries=150000 [--freq=freq.tsv]`。
