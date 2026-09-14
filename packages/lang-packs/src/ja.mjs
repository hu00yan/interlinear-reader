// Japanese pack: segment / lemmatize / stopwords.
//
// Backend strategy (static-first, wasm on demand):
// - "builtin" (default, 0 bytes): script-aware chunker — kanji/katakana runs,
//   hiragana particle splitting, longest-match against an optional compact
//   lexicon supplied by the caller (dict shards double as lexicon).
// - "lindera-wasm" (RECOMMENDED professional tokenizer): Lindera + IPADIC,
//   loaded lazily via dynamic import only when requested. See WASM_NOTES below.
// - "kuromoji": legacy option, larger + slower; supported via dynamic import.
//
// Contract is identical for all backends: segment(text)->tokens[],
// lemmatize(token)->lemma (builtin = identity; wasm backends return dictionary
// form via their own morphology), isStopword via particle/aux list.
//
// WASM_NOTES —实测 (npm registry, 2026-09-12;复现:见 DICT_SOURCES.md §JA):
//   lindera-wasm@6.0.0: tarball 708kB / unpacked 1.8MB
//     (lindera_wasm_bg.wasm 1.7MB + JS glue ~75kB, 共8文件).
//     词典(IPADIC)不随包发布,运行时从 GitHub Releases
//     (lindera/lindera, 如 lindera-ipadic-3.0.0.zip)下载一次后进 OPFS/IndexedDB.
//     API:v6 用 TokenizerBuilder + loadDictionaryFromBytes,见下方 loadLindera.
//   kuromoji@0.1.2: unpacked 41.3MB / 63文件(含预置词典,纯JS,无wasm).
//     Pros:无wasm打包烦恼;Cons:体积大一个数量级,加载慢(~1-2s),词典年久失修.
//   DECISION:默认 builtin(零字节,满足 5-10MB/语言预算),JA 页面首次打开时
//   懒加载 lindera-wasm + 缓存版 IPADIC.总预算:builtin包 ~6KB
//   + dict分片(br,见 SIZES) + 可选 lindera运行时 ~1.8MB + IPADIC缓存.

export const lang = "ja";

let backend = "builtin";
let wasmTokenizer = null; // { tokenize(text): string[] , lemmatize?(tok): string }
let lexicon = null; // Set<string> optional longest-match lexicon

export function getBackend() {
  return backend;
}

export function setLexicon(words) {
  lexicon = words ? new Set(words) : null;
}

// Track C / web can inject a loaded wasm tokenizer without this package
// taking a hard dependency (keeps base bundle at ~35KB).
export function setWasmTokenizer(tok, name = "lindera-wasm") {
  wasmTokenizer = tok ?? null;
  backend = tok ? name : "builtin";
}

export async function loadLindera({ importer, dictFiles, mode = "normal" } = {}) {
  // Lazy: `await loadLindera({ dictFiles })` pulls lindera-wasm only on JA pages.
  // Caller must `npm i lindera-wasm` in the web app; lang-packs stays dep-free.
  // dictFiles: IPADIC bytes cached by the app (OPFS/IndexedDB/R2), either an
  //   array of 9 Uint8Arrays in loadDictionaryFromBytes order
  //   [metadata, dictTrie, dictValsIdx, dictVals, dictWordsIdx, dictWords,
  //    matrixMtx, charDef, unk]
  //   or the { metadata, dictTrie, … } object from lindera-wasm/opfs helpers.
  // Matches lindera-wasm v6 API (default __wbg_init + TokenizerBuilder).
  if (!dictFiles) {
    throw new Error(
      "lindera: dictFiles required — download a lindera-ipadic zip once " +
      "(see DICT_SOURCES.md §JA), cache the bytes, and pass them here."
    );
  }
  const imp = importer ?? ((s) => import(s));
  const mod = await imp("lindera-wasm");
  await mod.default?.();
  const { TokenizerBuilder, loadDictionaryFromBytes } = mod;
  if (!TokenizerBuilder || !loadDictionaryFromBytes) {
    throw new Error("lindera-wasm: expected TokenizerBuilder/loadDictionaryFromBytes exports (v6 API)");
  }
  const f = dictFiles;
  const args = Array.isArray(f) ? f : [
    f.metadata, f.dictTrie, f.dictValsIdx, f.dictVals,
    f.dictWordsIdx, f.dictWords, f.matrixMtx, f.charDef, f.unk,
  ];
  const dict = loadDictionaryFromBytes(...args);
  const builder = new TokenizerBuilder();
  if (builder.setDictionaryInstance) builder.setDictionaryInstance(dict);
  if (builder.setMode) builder.setMode(mode);
  const tk = builder.build();
  wasmTokenizer = {
    tokenize: (text) => tk.tokenize(text).map((t) => t.surface ?? String(t)),
    lemmatize: (tok) => {
      try {
        // IPADIC details[6] = 基本形 (dictionary form); "*" = same as surface.
        const d = tk.tokenize(tok)[0]?.details?.[6];
        return d && d !== "*" ? d : tok;
      } catch {
        return tok;
      }
    },
  };
  backend = "lindera-wasm";
  return wasmTokenizer;
}

const HIRAGANA_PARTICLE = new Set(
  ["は", "が", "を", "に", "へ", "と", "で", "の", "も", "や", "か", "ね", "よ", "わ", "ぞ", "ぜ", "な", "さ", "て", "たり", "だり", "から", "まで", "より", "こと", "のち"]
);

// Split a hiragana run: peel known particles/auxiliaries, keep content runs whole.
function splitHiraganaRun(run) {
  if (run.length <= 1) return [run];
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    const two = run.slice(i, i + 2);
    if (HIRAGANA_PARTICLE.has(two) && buf.length > 0) {
      flush();
      out.push(two);
      i += 1;
      continue;
    }
    if (HIRAGANA_PARTICLE.has(ch) && buf.length > 0 && run.length > 2) {
      flush();
      out.push(ch);
      continue;
    }
    buf += ch;
  }
  flush();
  return out.filter(Boolean);
}

// Longest-match split of a kanji run against lexicon (max 4 chars), else whole run.
function splitKanjiRun(run) {
  if (!lexicon || run.length <= 2) return [run];
  const out = [];
  let i = 0;
  while (i < run.length) {
    let hit = null;
    for (let len = Math.min(4, run.length - i); len >= 2; len--) {
      const cand = run.slice(i, i + len);
      if (lexicon.has(cand)) { hit = cand; break; }
    }
    if (hit) { out.push(hit); i += hit.length; }
    else { out.push(run[i]); i += 1; }
  }
  return out;
}

const TOKEN_RE = /[\u4E00-\u9FFF\u3400-\u4DBF]+|[\u30A0-\u30FF\uFF61-\uFF9F]+|[\u3040-\u309F]+|[A-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]+|[^\s]/gu;

function isKanjiRun(s) { return /^[\u4E00-\u9FFF\u3400-\u4DBF]+$/.test(s); }
function isHiraganaRun(s) { return /^[\u3040-\u309F]+$/.test(s); }

export function segmentBuiltin(text) {
  if (!text) return [];
  const chunks = text.match(TOKEN_RE) ?? [];
  const out = [];
  for (const c of chunks) {
    if (isKanjiRun(c)) out.push(...splitKanjiRun(c));
    else if (isHiraganaRun(c)) out.push(...splitHiraganaRun(c));
    else out.push(c);
  }
  return out.filter((t) => t.trim().length > 0);
}

export function segment(text) {
  if (wasmTokenizer) return wasmTokenizer.tokenize(text);
  return segmentBuiltin(text);
}

export function lemmatize(token) {
  if (!token) return token;
  if (wasmTokenizer?.lemmatize) return wasmTokenizer.lemmatize(token);
  return token; // builtin: Japanese is highly inflected; real base-form needs wasm dict
}

export const stopwords = new Set(
  ["は", "が", "を", "に", "へ", "と", "で", "の", "も", "や", "か", "ね", "よ", "わ", "こと", "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "あそこ", "だ", "です", "ます", "である", "する", "した", "して", "される", "いる", "ある", "なる", "れる", "られる", "こと", "もの", "ため", "よう", "そう", "ない", "なく", "から", "まで", "より", "て", "たり", "だり"]
);

// ---------------------------------------------------------------------------
// 和语活用还原 deinflectJa(token) -> 有序候选（不含原形；调用方原形优先）。
// 精度靠“原形优先 + 词典命中”：猜错形在词典里不存在，自然落选；
// 同形歧义（如 した=舌/した，開ける=开/能写）永远先命中原形，不抢答。
// 覆盖：五段/一段/カ変/サ変的否定·过去·て形·推量·命令·可能/被动/使役，
// い形容词（かった/くない/ければ…），な形容词·体言的だ/な/に/だった，
// 進行/完了/受益/尝试/假设等常见助动词链。复合链（〜ざるを得ない等）不管，送 LLM。
// ---------------------------------------------------------------------------

const A_ROW = { か: "く", が: "ぐ", さ: "す", た: "つ", な: "ぬ", ば: "ぶ", ま: "む", ら: "る", わ: "う" };
const E_ROW = { け: "く", げ: "ぐ", せ: "す", て: "つ", ね: "ぬ", べ: "ぶ", め: "む", れ: "る" };
const O_ROW = { こ: "く", ご: "ぐ", そ: "す", と: "つ", の: "ぬ", ぼ: "ぶ", も: "む", ろ: "る" };
// て形语干 -> 辞書形尾：っ/ん 多解并列，词典命中决定。
const TE_MAP = {
  い: ["く"], ち: ["つ"], み: ["む"], び: ["ぶ"], に: ["ぬ"],
  き: ["く"], ぎ: ["ぐ"], し: ["す"],
  っ: ["る", "く", "う"], ん: ["む", "ぬ", "ぶ"],
};
// ます语干 -> 辞書形尾：い行只有洗う类（う）与いる（居る）并列，词典命中决定。
const MASU_MAP = {
  き: ["く"], ぎ: ["ぐ"], し: ["す"], ち: ["つ"], に: ["ぬ"], ひ: ["ふ"],
  び: ["ぶ"], み: ["む"], り: ["る"], い: ["う", "る"],
};

function mapFinal(remainder, table, appendRu) {
  if (!remainder) return [];
  const last = remainder[remainder.length - 1];
  const mapped = table[last];
  if (mapped) return mapped.map((m) => remainder.slice(0, -1) + m);
  if (appendRu && /[\u3041-\u3096\u30A1-\u30FA]/.test(last)) return [remainder + "る"];
  if (!appendRu && /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(remainder)) return [];
  return appendRu ? [remainder + "る"] : [];
}

// a 段尾 -> う段（書か→書く），其他（食べ）直接 +る。
function auCandidates(remainder) {
  if (!remainder) return [];
  const last = remainder[remainder.length - 1];
  if (A_ROW[last]) return [remainder.slice(0, -1) + A_ROW[last]];
  return [remainder + "る"];
}

// 否定/たい链的语干：a 段尾映射，否则 +る；く尾先试形容词（高くなく→高い）。
function naiCandidates(remainder) {
  if (!remainder) return [];
  const out = [];
  const last = remainder[remainder.length - 1];
  if (last === "く" && remainder.length >= 2) out.push(remainder.slice(0, -1) + "い");
  if (A_ROW[last]) out.push(remainder.slice(0, -1) + A_ROW[last]);
  else out.push(remainder + "る");
  return out;
}

// [后缀, 模式]：按后缀长度降序试全部，命中由调用方词典决定。
// 模式：RU(+る) AU(a段映射) MASUU TEU EU(e段映射) OU(お段映射) ADJI(+い) NA(原样)
//   SURU(+する) KURU(来る/くる) SURU_X(X+する/Xます系三连) TOKO(ところ系：原样+た形再展)
const CHAIN_RULES = [
  // 进行/结果存续/受益/尝试/移动目的（附在て形后）
  ["ています", "TEU"], ["でいます", "TEU"], ["ている", "TEU"], ["でいる", "TEU"],
  ["てしまう", "TEU"], ["でしまう", "TEU"], ["ちゃう", "TEU"], ["じゃう", "TEU"],
  ["てみる", "TEU"], ["てみます", "TEU"], ["ておく", "TEU"], ["てくる", "TEU"], ["ていく", "TEU"],
  ["てくれる", "TEU"], ["てもらう", "TEU"], ["てあげる", "TEU"], ["てくださる", "TEU"],
  // 假设/顺接/并列/持续（附在た形·て形·ます语干后）
  ["たら", "TEU"], ["だら", "TEU"], ["たり", "TEU"], ["ながら", "MASUU"],
  ["れば", "EU"], ["なければ", "NAI"], ["なければならない", "NAI"],
  // 否定/过去否定/愿望
  ["なかった", "NAI"], ["なくて", "NAI"], ["なく", "NAI"], ["ない", "NAI"],
  ["たくない", "MASUU"], ["たい", "MASUU"],
  // 过去/持续体/并列
  ["た", "TEU"], ["だ", "TEU"], ["て", "TEU"], ["で", "TEU"],
  // ず（古典否定）：食べず→食べる
  ["ず", "NAI"],
  // 命令/可能系表层：ろ→+る；け→く；ける→く（開ける原形优先已保）
  ["ろ", "RU"], ["け", "EU1"], ["ける", "KU"],
  // 推量：よう→+る；おう→お段映射（書こう→書く，会おう→会う）
  ["よう", "RU"], ["おう", "OU"],
  // 可能/被动/使役：a 段映射（書かれる→書く，食べられる→食べる）
  ["させられる", "AU"], ["させます", "AU"], ["させた", "AU"], ["させない", "AU"],
  ["させよう", "AU"], ["させろ", "AU"], ["させる", "AU"], ["される", "AU"],
  ["られた", "AU"], ["れた", "AU"], ["られる", "AU"], ["れる", "AU"], ["せる", "AU"],
  // すぎる/やすい/にくい/づらい/たがる（附在ます语干后）
  ["すぎる", "MASUU"], ["やすい", "MASUU"], ["にくい", "MASUU"], ["づらい", "MASUU"], ["たがる", "MASUU"],
  // ます系（ます语干映射；い→う/る并列由 MASUU 处理）
  ["ませんでした", "MASUU"], ["ました", "MASUU"], ["ません", "MASUU"], ["ましょう", "MASUU"], ["ます", "MASUU"],
  // い形容词
  ["かったです", "ADJI"], ["くありません", "ADJI"], ["かった", "ADJI"], ["くない", "ADJI"],
  ["ければ", "ADJI"], ["くて", "ADJI"], ["くなくて", "ADJI"], ["くなく", "ADJI"],
  // 体言·な形容词：原样（静かだ→静か）；ところ系另加た形再展
  ["だった", "NA"], ["である", "NA"], ["ならば", "NA"], ["なら", "NA"],
  ["ところ", "TOKO"], ["まま", "TOKO"], ["はず", "TOKO"], ["わけ", "TOKO"], ["もの", "TOKO"], ["こと", "TOKO"],
  // 禁止/终助词式：と/ば + EU/NA
  ["まい", "MAI"],
];

function applyMode(remainder, mode) {
  switch (mode) {
    case "RU":
      return remainder ? [remainder + "る"] : [];
    case "AU":
      return auCandidates(remainder);
    case "MASUU": {
      if (!remainder) return [];
      const last = remainder[remainder.length - 1];
      const mapped = MASU_MAP[last];
      if (mapped) return mapped.map((m) => remainder.slice(0, -1) + m);
      return [remainder + "る"];
    }
    case "TEU": {
      if (!remainder) return [];
      const last = remainder[remainder.length - 1];
      const mapped = TE_MAP[last];
      const teOut = mapped ? mapped.map((m) => remainder.slice(0, -1) + m) : [remainder + "る"];
      // 单字语干（いた→い）：て形映射之外再试 +る（いる/きる/しる…），词典命中决定。
      if (remainder.length === 1 && /[぀-ヿｦ-ﾟ]/.test(remainder) && !teOut.includes(remainder + "る")) teOut.push(remainder + "る");
      return teOut;
    }
    case "EU": {
      if (!remainder) return [];
      const last = remainder[remainder.length - 1];
      if (E_ROW[last]) return [remainder.slice(0, -1) + E_ROW[last]];
      return [remainder + "る"];
    }
    case "EU1": {
      if (!remainder) return [];
      return [remainder.slice(0, -1) + "く"];
    }
    case "KU": {
      if (!remainder) return [];
      return [remainder.slice(0, -2) + "く"];
    }
    case "OU": {
      if (!remainder) return [];
      const last = remainder[remainder.length - 1];
      if (O_ROW[last]) return [remainder.slice(0, -1) + O_ROW[last]];
      return [remainder + "う"];
    }
    case "ADJI":
      return remainder && remainder.length >= 1 ? [remainder + "い"] : [];
    case "NAI":
      return naiCandidates(remainder);
    case "NA":
      return remainder && remainder.length >= 2 ? [remainder] : [];
    case "MAI": {
      if (!remainder) return [];
      const last = remainder[remainder.length - 1];
      if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(last) || "くぐすつぬふぶむるう".includes(last)) return [remainder];
      return [remainder + "る"];
    }
    case "TOKO": {
      const out = [];
      if (remainder && remainder.length >= 2) out.push(remainder);
      // た形 + ところ（食べたところ）：语干再展
      if (/[ただ]/.test(remainder.slice(-1))) {
        const inner = remainder.slice(0, -1);
        if (inner) {
          const last = inner[inner.length - 1];
          const mapped = TE_MAP[last];
          if (mapped) for (const m of mapped) out.push(inner.slice(0, -1) + m);
          else out.push(inner + "る");
        }
      }
      return out;
    }
    default:
      return [];
  }
}

// サ変/カ変：する系（ます系三连：Xする/Xす/X）与来る系。调用方原形优先，本表只产猜测。
const SURU_TAILS = [
  "しませんでした", "しました", "しません", "しましょう", "します",
  "しなかった", "しなければ", "したい", "したら", "すれば", "しよう",
  "しろ", "しず", "してる", "しとる", "してます", "して",
];
const SURU_BARE = new Set(["した", "しない"]);
const KURU_TAILS = [
  "来ます", "来ました", "来ません", "来ましょう",
  "来た", "来て", "来ない", "来なかった", "来なければ", "来たい", "来たら", "来れば", "来よう", "来い", "来させる", "来られる",
  "きます", "きました", "きません", "きました", "きた", "きて", "きない", "きたい", "きたら", "きれば", "きよう",
];

export function deinflectJa(token) {
  const t = String(token ?? "").trim();
  if (!t) return [];
  const out = [];
  const push = (c) => {
    if (c && c !== t && !out.includes(c)) out.push(c);
  };
  // 連用形（ます语干裸形）：Segmenter 常把活用切碎（思った→思|っ|た），
  // 残下的语干本身无后缀可剥。整词按ます语干映射 + う/い补齐，词典命中决定：
  // 思→思う、高→高い、書き→書く、来→来る、待っ→待つ（っ→つ）。
  // 名词（事/本）产出的候选在词典里不存在，自然落选。
  const renyoukei = (stem) => {
    if (!stem) return;
    if (stem.endsWith("っ") && stem.length >= 1) push(stem.slice(0, -1) + "つ");
    for (const c of applyMode(stem, "MASUU")) push(c);
    // 五段未然以外的行：漢字語干补全行尾（聞→聞く、話→話す、立→立つ…），
    // う/い/しい前置（思う/高い/嬉しい常见），词典命中决定一切。
    push(stem + "う");
    push(stem + "い");
    push(stem + "しい");
    const last = stem[stem.length - 1];
    if (/[一-鿿㐀-䶿]/.test(last)) {
      for (const e of ["く", "ぐ", "す", "つ", "ぬ", "ぶ", "む"]) push(stem + e);
    }
  };
  if (t.length < 2) { renyoukei(t); return out.slice(0, 14); }
  // ます系する复合：Xします -> Xする/Xす/X（話します→話す先中，勉強します→勉強兜底；
  // 恰等于后缀时（しました/します…）stem 为空，直接产 する）。
  for (const tail of SURU_TAILS) {
    if (t.length >= tail.length && t.endsWith(tail)) {
      const stem = t.slice(0, t.length - tail.length);
      push(stem + "する");
      for (const c of applyMode(stem + "し", "MASUU")) push(c);
      push(stem);
      break;
    }
  }
  if (SURU_BARE.has(t)) push("する");
  // 来る系
  for (const tail of KURU_TAILS) {
    if (t.length >= tail.length && t.endsWith(tail)) {
      const stem = t.slice(0, t.length - tail.length);
      if (!stem || stem === "お") {
        push("来る");
        push("くる");
        break;
      }
    }
  }
  if (t === "くれ") push("くれる");
  // 通用链：全部匹配都试（去重+截断由调用方做最终控制，这里只保证有序）
  for (const [suffix, mode] of CHAIN_RULES) {
    if (t.length > suffix.length && t.endsWith(suffix)) {
      const remainder = t.slice(0, t.length - suffix.length);
      for (const c of applyMode(remainder, mode)) push(c);
    }
  }
  // 链式无产出（裸语干/单字）才走連用形兜底，保证精确候选永远在前、不被截断。
  // 已像辞書形（う段/る/い结尾：見る/書く/高い）的不猜——原形优先已查过。
  if (!out.length && !/[うくぐすつぬぶむるい]$/.test(t)) renyoukei(t);
  return out.slice(0, 14);
}
