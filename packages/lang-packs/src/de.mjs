// German pack: segment / lemmatize / stopwords.
// Handles ß/ss folding, noun plural + verb/adjective endings (Snowball-de subset).

import { segmentLatin, stripSuffixes, applyExceptions } from "./_latin.mjs";

export const lang = "de";

const EXCEPTIONS = new Map(Object.entries({
  // B3 guard: base forms the suffix stripper would otherwise mangle
  // (shard key is `strasse`, stem would give `strass` -> miss).
  straße: "strasse", strasse: "strasse",
  schule: "schule", liebe: "liebe", sprache: "sprache",
  leben: "leben",
  männer: "mann", frauen: "frau", kinder: "kind", häuser: "haus",
  bücher: "buch", städte: "stadt", länder: "land",
  ist: "sein", sind: "sein", war: "sein", waren: "sein", gewesen: "sein", sei: "sein", seid: "sein", bist: "sein", bin: "sein",
  hat: "haben", hatte: "haben", hatten: "haben", habe: "haben", hast: "haben", habt: "haben", gehabt: "haben",
  wird: "werden", wurde: "werden", wurden: "werden", geworden: "werden", werde: "werden", wirst: "werden", werdet: "werden",
  kann: "können", kannst: "können", könnt: "können", konnte: "können",
  muss: "müssen", musst: "müssen", müsst: "müssen", musste: "müssen",
  soll: "sollen", sollst: "sollen", sollte: "sollen",
  will: "wollen", willst: "wollen", wollte: "wollen",
  darf: "dürfen", darfst: "dürfen", durfte: "dürfen",
  weiß: "wissen", wusste: "wissen", geht: "gehen", ging: "gehen", gegangen: "gehen",
  kommt: "kommen", kam: "kommen", gekommen: "kommen",
  macht: "machen", machte: "machen", gemacht: "machen",
  gibt: "geben", gab: "geben", gegeben: "geben",
  sieht: "sehen", sah: "sehen", gesehen: "sehen",
  liest: "lesen", las: "lesen", gelesen: "lesen",
  spricht: "sprechen", sprach: "sprechen", gesprochen: "sprechen",
  trinkt: "trinken", trank: "trinken", getrunken: "trinken",
  // -e 名词复数（*-en 通规则会过剥成 schul/strass，无词典回查则必 miss；
  // lieben/sprachen 不收：与动词 lieben/sprechen 过去式同形，歧义留给双试+LLM）
  schulen: "schule",
  straßen: "strasse", strassen: "strasse",
  bessere: "gut", besten: "gut", bester: "gut", beste: "gut",
}));

// Umlaut de-folding for stem comparison only (dictionary keeps original).
function foldUmlaut(s) {
  return s.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
}

const NOUN_PL = [
  ["innen", "in", 4], ["heiten", "heit", 4], ["keiten", "keit", 4],
  ["ungen", "ung", 4], ["schaften", "schaft", 4],
  ["ern", "", 3], ["en", "", 3], ["em", "", 3], ["er", "", 3],
  ["es", "", 3], ["e", "", 3], ["n", "", 3], ["s", "", 3],
];
const VERB_ADJ = [
  ["ischsten", "isch", 4], ["lichsten", "lich", 4],
  ["estem", "", 4], ["esten", "", 4], ["ester", "", 4], ["este", "", 4], ["est", "", 4],
  ["stem", "", 4], ["sten", "", 4], ["ster", "", 4], ["ste", "", 4], ["st", "", 4],
  ["endem", "en", 4], ["enden", "en", 4], ["ender", "en", 4], ["ende", "en", 4],
  ["em", ""], ["en", ""], ["er", ""], ["es", ""], ["e", ""],
  ["tet", "t", 3], ["ten", "t", 3], ["test", "t", 3], ["tet", "t", 3],
  ["et", "", 3], ["t", "", 3],
];

export function segment(text) {
  return segmentLatin(text);
}

export function lemmatize(token) {
  if (!token) return token;
  const lower = token.toLowerCase();
  const ex = applyExceptions(lower, EXCEPTIONS);
  if (ex) return ex;
  // 查词导向：只做小写 + 变音折叠，不做后缀剥离。
  // 根因：Snowball 式剥离（die->di / oben->ob / Welle->well / Vater->vat / Haus->hau）
  // 把词典原形词也剥坏，德语整段查不到；屈折展开由调用方（dict-loader 多试）负责，
  // 那里原形优先、候选有序，不会错切。
  return foldUmlaut(lower).replace(/ß/g, "ss");
}

export const stopwords = new Set(
  "der die das den dem des ein eine einer einem einen eines und oder aber denn weil wenn als wie auch nicht kein keine keiner keinen keinem nichts sehr schon noch mal doch ja nein zu von mit bei nach aus vor zwischen über unter durch für gegen ohne um am im ins ans aufs beim vom zum zur ich du er sie es wir ihr mich dich sich uns euch mein dein sein ihr unser euer ihr mein meine".split(" ")
);
