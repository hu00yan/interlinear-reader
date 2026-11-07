// .apkg 核心（纯逻辑，node 可测）：Anki 2（collection.anki2, schema ver 11）。
// 浏览器壳 apkg.ts 负责 sql.js wasm 初始化 + JSZip 打包 + WebCrypto csum；
// 本文件只做纯数据构建，接收 sql.js 的 Database 形状，不 import 浏览器专属模块。
import type { Database } from "sql.js";

/** 生词条目最小形状（与 vocab/store.ts 的 VocabEntry 兼容子集） */
export interface ApkgEntry {
  lemma: string;
  lang: string;
  gloss: null | string;
  sentence?: null | string;
  known?: boolean;
}

export interface ApkgOpts {
  /** 牌组名（Anki 桌面/手机版导入后的牌组名） */
  deckName?: string;
  /** 源语言标签（进牌组名与 tags） */
  langLabel?: string;
  /** notes.csum（Anki 导入去重用）：首字段 sha1 前 8 hex 的整数值，与 entries 同序。
   * 缺省用确定性 FNV 近似（仅影响 Anki 导入时的重复检测键，卡片内容不受影响）。 */
  csums?: number[];
}

export const APKG_DECK_DEFAULT = "Interlinear Reader 生词本";

const MODEL_ID = 1607392319001;
const DECK_ID = 1607392319002;

/** Anki 字段分隔符（ASCII 0x1f） */
export const FIELD_SEP = "\x1f";

/** buildApkgRows 的产物：schema + 三张表的行 + JSON 列文本（col 的 conf/models/decks/dconf）。 */
export interface ApkgRows {
  schema: string;
  col: Array<(number | string)[]>;
  notes: Array<(number | string)[]>;
  cards: Array<(number | string)[]>;
  modelJson: string;
  deckJson: string;
  confJson: string;
  dconfJson: string;
}

/** Anki 2 schema ver 11（collection.anki2），genanki 同款表结构 + 常用索引。 */
export const ANKI2_SCHEMA = `
CREATE TABLE col (
    id integer primary key,
    crt integer not null,
    mod integer not null,
    scm integer not null,
    ver integer not null,
    dty integer not null,
    usn integer not null,
    ls integer not null,
    conf text not null,
    decks text not null,
    models text not null,
    dconf text not null,
    tags text not null
);
CREATE TABLE notes (
    id integer primary key,
    guid text not null,
    mid integer not null,
    mod integer not null,
    usn integer not null,
    tags text not null,
    flds text not null,
    sflg integer not null,
    csum integer not null,
    flags integer not null,
    data text not null
);
CREATE TABLE cards (
    id integer primary key,
    nid integer not null,
    did integer not null,
    ord integer not null,
    mod integer not null,
    usn integer not null,
    type integer not null,
    queue integer not null,
    due integer not null,
    ivl integer not null,
    factor integer not null,
    reps integer not null,
    lapses integer not null,
    left integer not null,
    odue integer not null,
    odid integer not null,
    flags integer not null,
    data text not null
);
CREATE TABLE revlog (
    id integer primary key,
    cid integer not null,
    usn integer not null,
    ease integer not null,
    ivl integer not null,
    lastIvl integer not null,
    factor integer not null,
    time integer not null,
    type integer not null
);
CREATE TABLE graves (
    usn integer not null,
    oid integer not null,
    type integer not null
);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

/** 生成 notes 的 guid（导入去重锚点；Anki 只要求唯一文本）：双 FNV-1a，确定性。 */
export function apkgGuid(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const n = seed.length;
  for (let i = 0; i < n; i++) {
    h1 = (h1 ^ seed.charCodeAt(i)) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 ^ seed.charCodeAt(n - 1 - i)) >>> 0;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(13, "0");
}

/** Anki col/notes/cards 行的纯构建（不触 db，便于单测断言行数据）。 */
export function buildApkgRows(
  entries: ApkgEntry[],
  opts: ApkgOpts = {},
  nowMs = Date.now()
): ApkgRows {
  const nowSec = Math.floor(nowMs / 1000);
  const deckName = opts.deckName ?? APKG_DECK_DEFAULT;
  const deckNameFinal = opts.langLabel ? `${deckName}（${opts.langLabel}）` : deckName;

  const modelJson = {
    [String(MODEL_ID)]: {
      id: MODEL_ID,
      name: "ILR Vocab",
      type: 0,
      mod: nowSec,
      usn: -1,
      sortf: 0,
      did: DECK_ID,
      tmpls: [
        {
          name: "Card 1",
          ord: 0,
          qfmt: "{{Word}}",
          afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Gloss}}{{#Sentence}}<br><br><small>{{Sentence}}</small>{{/Sentence}}",
          bqfmt: "",
          bafmt: "",
          did: null,
          bfont: "",
          bsize: 0,
        },
      ],
      flds: [
        { name: "Word", ord: 0, sticky: false, rtl: false, font: "Arial", media: [], size: 20 },
        { name: "Gloss", ord: 1, sticky: false, rtl: false, font: "Arial", media: [], size: 18 },
        { name: "Sentence", ord: 2, sticky: false, rtl: false, font: "Arial", media: [], size: 16 },
      ],
      css: ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }",
      latexPre:
        "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\parskip=0ex\n",
      latexPost: "\\end{document}",
      latexsvg: false,
      req: [[0, "all", [0]]],
      tags: "",
      vers: [],
    },
  };

  const deckObj = (id: number, name: string): Record<string, unknown> => ({
    id,
    name,
    desc: "",
    conf: 1,
    usn: -1,
    collapsed: false,
    browserCollapsed: false,
    newToday: [0, 0],
    revToday: [0, 0],
    lrnToday: [0, 0],
    timeToday: [0, 0],
    dyn: 0,
    extendNew: 10,
    extendRev: 50,
    mod: nowSec,
  });
  const decks = {
    "1": deckObj(1, "Default"),
    [String(DECK_ID)]: deckObj(DECK_ID, deckNameFinal),
  };
  const conf = {
    nextPos: 1,
    estTimes: true,
    activeDecks: [DECK_ID],
    sortType: "noteFld",
    sortBackwards: false,
    addToCur: false,
    curDeck: DECK_ID,
    newBury: true,
    newSpread: 0,
    dueCounts: true,
    curModel: String(MODEL_ID),
    collapseTime: 1200,
  };
  const dconf = {
    "1": {
      autoplay: true,
      id: 1,
      lapSec: 60,
      maxTaken: 60,
      mod: 0,
      name: "Default",
      replayq: true,
      rev: {
        bury: true,
        ease4: 1.3,
        fuzz: 0.05,
        ivlFct: 1,
        maxIvl: 36500,
        minSpace: 1,
        perDay: 200,
        hardFactor: 1.2,
      },
      new: {
        bury: true,
        delays: [1, 10],
        initialFactor: 2.5,
        ints: [1, 4, 7],
        order: 1,
        perDay: 20,
        separate: true,
      },
      timer: 0,
      usn: 0,
    },
  };

  const notes: Array<(number | string)[]> = [];
  const cards: Array<(number | string)[]> = [];
  entries.forEach((e, i) => {
    const nid = nowMs + i;
    const word = String(e.lemma ?? "");
    const gloss = String(e.gloss ?? "");
    const sentence = String(e.sentence ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const tags = e.lang ? `ilr lang::${e.lang}` : "ilr";
    const csum = opts.csums?.[i] ?? 0;
    notes.push([
      nid,
      apkgGuid(`${e.lang}:${word}:${sentence}`),
      MODEL_ID,
      nowSec,
      -1,
      tags,
      [word, gloss, sentence].join(FIELD_SEP),
      0,
      csum,
      0,
      "",
    ]);
    cards.push([
      nowMs + 1_000_000 + i,
      nid,
      DECK_ID,
      0,
      nowSec,
      -1,
      0,
      0,
      i,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      "",
    ]);
  });

  return {
    schema: ANKI2_SCHEMA,
    col: [
      [
        // 列序与 schema 一致：conf, decks, models, dconf, tags
        1,
        nowSec,
        nowMs,
        nowMs,
        11,
        0,
        0,
        0,
        JSON.stringify(conf),
        JSON.stringify(decks),
        JSON.stringify(modelJson),
        JSON.stringify(dconf),
        "[]",
      ],
    ],
    notes,
    cards,
    modelJson: JSON.stringify(modelJson),
    deckJson: JSON.stringify(decks),
    confJson: JSON.stringify(conf),
    dconfJson: JSON.stringify(dconf),
  };
}

/** 给 db 执行 schema + 插入 col/notes/cards（db 由调用方提供，sql.js Database）。 */
export function populateAnkiDb(db: Database, rows: ApkgRows): void {
  db.run(rows.schema);
  const ins = (sql: string, all: Array<(number | string)[]>): void => {
    if (!all.length) return;
    const stmt = db.prepare(sql);
    for (const row of all) stmt.run(row as never);
    stmt.free();
  };
  ins("INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows.col);
  ins("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows.notes);
  ins("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows.cards);
}
