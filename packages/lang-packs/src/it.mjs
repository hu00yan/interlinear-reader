// Italian pack: segment / lemmatize / stopwords.
// Clitic split (l', un'…), verb conjugation + noun/adjective endings.

import { segmentLatin, stripSuffixes, applyExceptions } from "./_latin.mjs";

export const lang = "it";

const CLITIC_RE = /^(l|un|dell|dall|nell|sull|coll|quest|quell)['’](.+)$/i;

const EXCEPTIONS = new Map(Object.entries({
  sono: "essere", sei: "essere", è: "essere", siamo: "essere", siete: "essere",
  ero: "essere", eri: "essere", era: "essere", eravamo: "essere", furono: "essere", stato: "essere", sia: "essere",
  ho: "avere", hai: "avere", ha: "avere", abbiamo: "avere", avete: "avere", hanno: "avere",
  avevo: "avere", avuto: "avere", abbia: "avere",
  faccio: "fare", fai: "fare", fa: "fare", facciamo: "fare", fatto: "fare", facevo: "fare",
  vado: "andare", vai: "andare", andiamo: "andare", andato: "andare",
  posso: "potere", puoi: "potere", può: "potere", potuto: "potere",
  devo: "dovere", devi: "dovere", deve: "dovere", dovuto: "dovere",
  voglio: "volere", vuoi: "volere", vuole: "volere", voluto: "volere",
  so: "sapere", sai: "sapere", sa: "sapere", saputo: "sapere",
  vedo: "vedere", vedi: "vedere", vede: "vedere", visto: "vedere",
  dico: "dire", dici: "dire", dice: "dire", detto: "dire",
  diciamo: "dire", dicono: "dire",
  vediamo: "vedere", vedono: "vedere",
  prendiamo: "prendere", prendono: "prendere",
  letto: "leggere", amori: "amore", parleranno: "parlare", diranno: "dire",
  mangiamo: "mangiare", mangiate: "mangiare", mangiano: "mangiare",
  faranno: "fare", daranno: "dare", danno: "dare",
  occhi: "occhio", uomini: "uomo", mogli: "moglie", buoi: "bue",
  migliore: "buono", migliori: "buono", peggiore: "cattivo",
}));

const RULES = [
  ["izzazioni", "izzare", 5], ["izzazione", "izzare", 5],
  ["ificazioni", "ificare", 5], ["ificazione", "ificare", 5],
  ["erebbero", "ere", 4], ["irebbero", "ire", 4], ["arebbero", "are", 4],
  ["evano", "ere", 4], ["ivano", "ire", 4], ["avano", "are", 4],
  ["endo", "ere", 4], ["ando", "are", 4],
  ["iscono", "ire", 3], ["isci", "ire", 3], ["isce", "ire", 3],
  // 现在时 1/2/3 复（-iamo/-ate/-ano 默认 -are 类；-ere/-ire 高频形走例外表）：
  // 必须在名词 -i→-o/-e→-a 之前，否则 parlate→parlata 过剥。
  ["iamo", "are", 3], ["ate", "are", 3], ["ano", "are", 3],
  ["ete", "ere", 3], ["ite", "ire", 3],
  ["eremo", "ere", 4], ["iremo", "ire", 4], ["aremo", "are", 4],
  ["erete", "ere", 4], ["irete", "ire", 4], ["arete", "are", 4],
  ["eranno", "ere", 2], ["iranno", "ire", 2], ["aranno", "are", 4],
  // -ere 动词截干未来（vedr-/dir-/f-/dar- + -anno）：-ranno 通收 -ere，
  // -are/-ire 截干（dar-/far-/dir-）走例外。
  ["ranno", "ere", 2],
  ["ato", "are", 3], ["uto", "ere", 3], ["ito", "ire", 3],
  ["atori", "atore", 4], ["atore", "are", 4],
  ["mente", "", 5],
  ["issimi", "o", 4], ["issime", "a", 4], ["issimo", "o", 4], ["issima", "a", 4],
  ["hezza", "", 4], ["anza", "", 4], ["enza", "", 4],
  ["zione", "", 4], ["sione", "", 4],
  ["ità", "", 3],
  ["ine", "ina", 3], ["ina", "ina", 3], ["oni", "one", 3], ["one", "one", 3],
  ["cci", "ccio", 3], ["chi", "co", 3], ["ghi", "go", 3], ["che", "co", 3],
  ["ci", "ce", 3], ["chi", "co", 3],
  ["i", "o", 3], ["e", "a", 3],
];

function stemNounGuess(s) {
  if (/[aeiou]s$/.test(s)) return s;
  return s;
}

export function segment(text) {
  const raw = segmentLatin(text);
  const out = [];
  for (const t of raw) {
    const m = t.match(CLITIC_RE);
    out.push(...(m ? [m[1] + "'", m[2]] : [t]));
  }
  return out;
}

export function lemmatize(token) {
  if (!token) return token;
  let lower = token.toLowerCase().replace(/['’]$/, "");
  const m = lower.match(CLITIC_RE);
  if (m) lower = m[2];
  const ex = applyExceptions(lower, EXCEPTIONS);
  if (ex) return ex;
  return stemNounGuess(stripSuffixes(lower, RULES));
}

export const stopwords = new Set(
  "il lo la i gli le un uno una di a da in con su per tra fra che chi cui non si ci ne come più meno molto poco tanto troppo anche ancora già solo sino fino dopo prima durante mentre quando dove perché perché se ma ed o anche sono era erano stato essere ho ha hanno aveva avuto fare questo questa questi queste quello quella quelli quelle mio tuo suo nostro vostro loro mi ti si ci vi".split(" ")
);
