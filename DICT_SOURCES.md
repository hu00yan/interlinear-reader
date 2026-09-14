# DICT_SOURCES — Track B 词典来源、License 与构建命令

流水线：`packages/dict-tools/` 抓取/清洗 → 统一分片 JSON `{lemma:{zh:[],en:[]}}`
→ `public/dict/{lang}/{shard}.json(.br/.gz)` → R2/静态托管。
消费端：`packages/dict-loader/`（`getGloss`）→ 缺词标 `miss` → Track C 接 LLM
（缺词直走 LLM、不经英语中转：zh 缺词永不回退 en，反之亦然）。

## 构建命令（可复现）

```bash
# 只构建 en/ja（验收命令；两种写法等价）
npm run build:dict --lang=en,ja
npm run build:dict -- --lang=en,ja

# 全量 7 语言
npm run build:dict -- --lang=en,de,fr,it,es,ru,ja

# 使用本地 raw dumps（见下表 raw/ 路径；缺 dumps 时自动回退到 seeds/，离线可复现）
# .gz 自动 gunzip（含 JMdict_e.gz / *.xml.gz）；*wiktionary.xml 走 parseWiktionary，
# 永不误走 parseFreedictTei（见 sources.mjs + sources.test.mjs）。
npm run build:dict -- --lang=en --raw=packages/dict-tools/raw --out=public/dict

# 词频裁剪（SIZES 预算超限时）：按词频只保留 Top N（freq 文件 tsv lemma\tcount
# 或 json；缺省用 corpus 词频；并列按字母序保证确定性）
npm run build:dict -- --lang=en --maxEntries=150000
npm run build:dict -- --lang=en --freq=packages/dict-tools/freq/en.tsv --maxEntries=150000

# 严格模式：raw/ 中出现 VERIFY 许可来源（de-zh.tsv / ru-en.tsv / JMdict_zh.gz）
# 直接非零退出，拒绝上线（上线前必须逐文件确认 license）
npm run build:dict -- --lang=de --strict

# 14 方向覆盖率表（7 源 × zh/en）+ public/dict/coverage.json
# （corpus 覆盖率用 原形+词干双试，与 getGloss 运行时一致）
npm run report:coverage

# 单测（loader 命中/缺失/缓存命中三态 + 双试 roundtrip + lang-packs + sources）
node --test packages/dict-loader/test/*.test.mjs packages/lang-packs/test/*.test.mjs
node --test packages/dict-tools/test/*.test.mjs
```

输出是确定性的：key 排序 + 稳定序列化 + 固定 brotli(q9)/gzip(9) 参数；
构建会先清理本语言目录下的过期分片（只碰 `public/dict/{lang}/`，不动其它目录）。

## 分片格式（契约，勿改 — 单源 `packages/dict-loader/src/shard.mjs`）

- 文件：`public/dict/{lang}/{shard}.json` + `.br` + `.gz`，另有 `manifest.json`（列出 shards）。
- shard 规则 = lemma 首 2 字符（`packages/dict-loader/src/shard.mjs`，dict-tools 经
  `packages/dict-tools/src/shard.mjs` 复用同一文件；`TRACK_B_LANGS/SHARD_RULE`
  为 LANGS 单源，`build.mjs/coverage.mjs/scripts` 均从此 import，禁止各处手写
  `["en",…]` 分叉）：
  `a-z` 双字母分片照直写，数字开头并入 `0-9`，其余（CJK/西里尔/重音等）按码点 hex 编为 `u…`。
- 归一化：latin 小写+去重音，de `ß→ss`，ru `ё→е`，ja 原样保留。
- 每条 gloss 上限 6 个；静态托管对 `.json` 自动做 `Content-Encoding: br`（R2/Pages 行为），
  loader 永远请求 `.json` URL。
- manifest 字段：`{lang,entries,shards,sources,builtWith,format,shardRule}`；
  `coverage.mjs` 只合并 manifest 列出的 shards（外来文件忽略）。

## §契约分叉（B1：Track B vs CONTRACT.md/Track D — 按 track 分流）

| | Track B（本流水线，`packages/dict-*`） | Track D（`CONTRACT.md`，别轨拥有） |
|---|---|---|
| langs | `en,de,fr,it,es,ru,ja`（`TRACK_B_LANGS`） | `en,zh,ja,es,fr,de,el` |
| shard | 首 2 字符（本文件上一节） | `fnv1a(term)%2 → 00/01` |
| R2 key | `dict/{trackB-lang}/{首2字符}.json.br`（261 objects 量级） | `dict/{lang}/00.json.br,01.json.br`（14 objects） |
| loader | `packages/dict-loader`（`shardFor/normalizeLemma`） | `src/lib/loader.mjs`（别轨实现） |

- `public/dict/{el,zh}` 归属：**不归 Track B** — `build:dict` 只写 7 个 Track B
  目录；`deploy-dict.mjs` 只上传 Track B langs 并 `skip` 外来目录/文件
 （`sizes.json/coverage.json/el/zh`，见 dry-run 尾行）；`budget.mjs` 只 gate
  Track B langs。`el/zh` 由其它轨道按 CONTRACT.md 自行构建/上传，Track B
  脚本永不读取 `00.json`、永不因外来目录 ENOENT。
- web 侧 `packages/web/src/dict/dict-loader.ts` 接线留给 A 路；Track B 只保证
  manifest/shard 契约单源 + 本文档 + `roundtrip.test.mjs` 双试契约。

## 来源与 License

| lang | 来源 | 用途 | License | raw 路径 / 获取方式 |
|---|---|---|---|---|
| en | ECDICT（skywind3000/ECDICT） | en→zh 主力 | MIT | `raw/en/ecdict.csv`：`curl -L https://github.com/skywind3000/ECDICT/raw/master/ecdict.csv`（解析器 `parseEcdictCsv`） |
| en | Wiktionary EN dump | en→en 释义补齐 | CC BY-SA 4.0 | `raw/en/enwiktionary.xml`：`https://dumps.wikimedia.org/enwiktionary/`（需署名，见下） |
| en | FreeDict eng-deu | en gloss 校验 | GPL-3.0+ / CC BY-SA（按词典） | `raw/en/freedict-eng-deu.tei`（解析器 `parseFreedictTei`） |
| de | FreeDict deu-eng | de→en 主力 | GPL-3.0+ / CC BY-SA（按词典） | `raw/de/freedict-deu-eng.tei`，`https://freedict.org/` |
| de | Wiktionary DE dump | de→zh/en 补齐 | CC BY-SA 4.0 | `raw/de/dewiktionary.xml` |
| de | 社区 de-zh 表 | de→zh | **VERIFY — 上线前必须逐文件确认** | `raw/de/de-zh.tsv`（`parseTsv`：`lemma\tzh1;zh2\ten1;en2`） |
| fr | FreeDict fra-eng | fr→en 主力 | GPL-3.0+ / CC BY-SA | `raw/fr/freedict-fra-eng.tei` |
| fr | Wiktionary FR dump | fr→zh/en 补齐 | CC BY-SA 4.0 | `raw/fr/frwiktionary.xml` |
| it | FreeDict ita-eng | it→en 主力 | GPL-3.0+ / CC BY-SA | `raw/it/freedict-ita-eng.tei` |
| it | Wiktionary IT dump | it→zh/en 补齐 | CC BY-SA 4.0 | `raw/it/itwiktionary.xml` |
| es | FreeDict spa-eng | es→en 主力 | GPL-3.0+ / CC BY-SA | `raw/es/freedict-spa-eng.tei` |
| es | Wiktionary ES dump | es→zh/en 补齐 | CC BY-SA 4.0 | `raw/es/eswiktionary.xml` |
| ru | FreeDict rus-eng | ru→en 主力 | GPL-3.0+ / CC BY-SA | `raw/ru/freedict-rus-eng.tei` |
| ru | Wiktionary RU dump | ru→zh/en 补齐 | CC BY-SA 4.0 | `raw/ru/ruwiktionary.xml` |
| ru | 社区 ru-en 表 | ru→en 补齐 | **VERIFY — 上线前必须逐文件确认** | `raw/ru/ru-en.tsv` |
| ja | JMdict_e（EDRDG） | ja→en 主力（keb+reb 双 lemma） | CC BY-SA 4.0（EDRDG licence，需署名 EDRDG） | `raw/ja/JMdict_e.gz`：`http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz`（解析器 `parseJmdict(xml,"eng")`） |
| ja | JMdict 中文 fork | ja→zh | **VERIFY — 推定 CC BY-SA，上线前确认 fork 声明** | `raw/ja/JMdict_zh.gz`（解析器 `parseJmdict(xml,"chi")`） |
| ja | Wiktionary JA dump | ja→zh/en 补齐 | CC BY-SA 4.0 | `raw/ja/jawiktionary.xml` |

CC BY-SA 4.0 合规：App 内 About 页署名（Wiktionary / EDRDG / FreeDict 各词典作者），
衍生分片保持 CC BY-SA（源码+分片同发即可满足 ShareAlike）；GPL 仅约束 FreeDict 解析链路，
分片数据以各词典自带 CC BY-SA 为准，GPL 代码不进客户端 bundle（构建脚本仅跑在 CI）。

当前仓库状态：`raw/` 尚无 dumps，构建使用 `packages/dict-tools/seeds/*.seed.json`
（手工核心词 ~40/语言，MIT-equivalent 自有）——`manifest.json` 中 `builtWith` 会如实标注
`seeds (offline)` 或 `seeds+raw(N files)`。

## §JA 日语分词 wasm 二选一实测（2026-09-12，npm registry）

复现：`npm view lindera-wasm dist.unpackedSize` / `npm pack lindera-wasm --dry-run` /
`npm view kuromoji dist.unpackedSize dist.fileCount`。

| 方案 | 版本 | tarball（过线） | unpacked | 词典 | 结论 |
|---|---|---|---|---|---|
| **lindera-wasm（选用）** | 6.0.0 | **708kB** | **1.8MB**（wasm 1.7MB + JS ~75kB，8 文件） | IPADIC 不随包，需运行时从 `lindera/lindera` GitHub Releases 下载一次（如 `lindera-ipadic-3.0.0.zip`），进 OPFS/IndexedDB 常驻 | ✅ 体积可接受，Rust 维护中，v6 API=`TokenizerBuilder`+`loadDictionaryFromBytes`（见 `ja.mjs:loadLindera`，默认 `normal` mode，details[6] 取基本形） |
| kuromoji（备选） | 0.1.2 | — | **41.3MB** / 63 文件（含预置词典） | 随包 | ❌ 大一个数量级，加载 ~1–2s，词典年久失修；仅当 wasm 不可用时经动态 import 兜底 |

体积可接受性：`708kB` 过线 + IPADIC 一次性缓存 < 语言包 5–10MB 懒加载预算的运行时部分
（IPADIC 二进制 zip 量级 ~10MB，首次下载后不再过线；精确值以下载的 release 为准，
`loadLindera({dictFiles})` 抛错信息里写了获取路径）。

## R2 上传

```bash
# 预压缩已生成（.br/.gz 与 .json 同名），上传时带上正确的 Content-Type/Encoding，
# 或直接让 R2 自动协商；按语言前缀分批上传以便懒加载：
#   public/dict/{en,de,fr,it,es,ru,ja}/*  ->  r2://<bucket>/dict/{lang}/*
```

## 覆盖率解读

`npm run report:coverage` 输出 14 行（`{lang}→zh` / `{lang}→en`），两列视角：

- breadth：词典条目中有该目标语 gloss 的比例（种子阶段应为 100%）。
- corpus tok cov：示例语料（`packages/dict-tools/corpus/*.txt`）经
  `segment→lemmatize→查词典`（去停用词）后的命中率——真实 dumps 接入后此列是主要优化目标；
  未命中由 `getGloss` 记为 `miss`，Track C 批量送 LLM（见 `getMisses()`）。
