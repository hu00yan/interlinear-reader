# raw/ — 真实 dumps + 自有补齐 (Track B)

构建: `npm run build:dict -- --lang=en,de,fr,it,es,ru,ja` (详见 DICT_SOURCES.md)。
缺 dumps 时回退到 `seeds/` (离线可复现); 有 dumps 时 `builtWith` 标注 `seeds+raw(N files)`。

## 上游真实 dumps (license 见 `sources.mjs` + DICT_SOURCES.md)

| lang | 文件 | 来源 | License | 体积/备注 |
|---|---|---|---|---|
| en | `ecdict.csv` | skywind3000/ECDICT `curl -L https://github.com/skywind3000/ECDICT/raw/master/ecdict.csv` | MIT | 65MB, ~70万词条, en→zh主力 |
| en | `enwiktionary.xml` | `scripts/fetch-wiktionary.mjs --lang=en` (en.wiktionary.org API, CC BY-SA) | CC BY-SA 4.0 | 20高频页 (cat/dog/house/hath/empire…), `#` 释义+`{{t\|zh}}` |
| de | `freedict-deu-eng.tei` | `https://download.freedict.org/dictionaries/deu-eng/1.9-fd1/freedict-deu-eng-1.9-fd1.src.tar.xz` (解包 `deu-eng/deu-eng.tei`) | GPL-3.0+ / CC BY-SA | **频率过滤子集**: 全量517k headwords/429MB → 按 `freq/de.tsv` (must-keep+top6k) 保留21764 rows/4338 lemmas, 否则解析OOM且超200KB预算 |
| fr | `freedict-fra-eng.tei` | `.../fra-eng/0.4.1/...src.tar.xz` | GPL-3.0+ / CC BY-SA | 2.6MB, 8504 rows |
| es | `freedict-spa-eng.tei` | `.../spa-eng/0.3.1/...src.tar.xz` | GPL-3.0+ / CC BY-SA | 1.5MB, 4502 rows |
| it | `freedict-ita-eng.tei` | `.../ita-eng/2025.11.23/...src.tar.xz` | GPL-3.0+ / CC BY-SA | 13MB, 29660 rows → `--maxEntries=14000` 裁剪至190KB |
| ru | `freedict-rus-eng.tei` | `.../rus-eng/2025.11.23/...src.tar.xz` | GPL-3.0+ / CC BY-SA | 16MB, 42600 rows → `--maxEntries=12800` 裁剪至198KB |
| ja | `JMdict_e.gz` | `http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz` | CC BY-SA 4.0 (EDRDG) | 10MB gz / 57MB xml, 499091 rows (keb+reb) → `--maxEntries=3500` 裁剪至194KB |
| ja | `*wiktionary.xml` | `scripts/fetch-wiktionary.mjs` (jawiktionary API) | CC BY-SA 4.0 | 高频页切片 (全量dumps为GB级) |
| de/fr/it/es/ru | `*wiktionary.xml` | `scripts/fetch-wiktionary.mjs` (各语言wiktionary API) | CC BY-SA 4.0 | 高频页切片; 解析器支持 `t/trad/T/Ü/l` 多模板 (见 `sources.mjs:parseWiktionary`) |

注: `raw/en/freedict-eng-deu.tei` (eng-deu 343MB) 已排除: quotes 为德语却会被 `parseFreedictTei`
误标为 en, 且体积超预算10倍; en 主力为 ECDICT+Wiktionary+archaic (见 SOURCES 注释)。
`raw/*/de-zh.tsv, ru-en.tsv, JMdict_zh.gz` (VERIFY) 永不入库, `--strict` 门禁 (exit 3)。

## 自有补齐 (MIT, --strict 安全)

- `raw/en/archaic.tsv` — KJV古英表 (hath/doth/saith/thou…): loader双试+古英表保留,
  原形直查即中 (en lemmatizer 对 hath/doth 不变形), browser-2samuel 断言 hath/doth/saith 有中文。
- `raw/{de,fr,it,es,ru,ja}/curated-zh.tsv` — zh补齐+语料变位别名:
  FreeDict/JMdict 仅给 en, 语料inflection (fr aiment→aimer, ru книгу→книга, ja 飲→飲む…)
  需原形别名才能双试命中; 功能词 (fr à/l', it e/della, es a) 需中文才能 corpus zh>95%。
  单词翻译为事实性短语, 自有MIT, 非 VERIFY 文件名故 `--strict` 放行。
- `freq/*.tsv` — `--freq` 排序 (must-keep 20M+ > top50k 5M-): 语料/种子/补齐/cat/Gibbon/KJV 置顶,
  保证 `--maxEntries` 裁剪先保常用词。Top50k 来自 hermitdave/FrequencyWords (2016, 各语言50k)。

## 预算 (SIZES.md 懒加载栏: 单语言≤200KB br)

- de 4340→140KB (过滤子集, 无需裁剪), fr 8219→101KB, es 4497→58KB (无需裁剪)
- it 14000→190KB, ru 12800→198KB, ja 3500→194KB, en (ECDICT全量后复测, `--maxEntries` 裁剪)
- 复测: `npm run build:dict && npm run report:coverage && cat public/dict/sizes.json`

## 解析器修复 (本次回炉)

- `parseFreedictTei`: 支持现行 P5 `<cit type="trans"><quote>` (旧版仅 `<tr>`, 曾致0行)。
- `parseJmdict`: 支持 JMdict_e 裸 `<gloss>` (无 xml:lang, 默认为eng; 旧正则要求 xml:lang="eng"致0行)。
- `parseWiktionary`: 支持 fr `trad/T`, de `Ü/Üt` 等非英模板 (旧版仅 `t/l`, 非英wiktionary 0行)。
