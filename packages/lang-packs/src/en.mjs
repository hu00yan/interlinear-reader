// English pack: segment / lemmatize / stopwords.
// Lemmatizer = irregular map (~120 forms) + Porter/Snowball-english subset.

import { segmentLatin, stripSuffixes, applyExceptions } from "./_latin.mjs";

export const lang = "en";

const EXCEPTIONS = new Map(Object.entries({
  children: "child", men: "man", women: "woman", teeth: "tooth", feet: "foot",
  geese: "goose", mice: "mouse", oxen: "ox",
  went: "go", gone: "go", was: "be", were: "be", been: "be", am: "be", is: "be", are: "be",
  had: "have", has: "have", having: "have",
  did: "do", done: "do", does: "do", doing: "do",
  said: "say", says: "say", made: "make", took: "take", taken: "take",
  came: "come", coming: "come", got: "get", gotten: "get", getting: "get",
  saw: "see", seen: "see", knew: "know", known: "know",
  thought: "think", brought: "bring", bought: "buy", taught: "teach",
  caught: "catch", wrote: "write", written: "write", spoke: "speak", spoken: "speak",
  broke: "break", broken: "break", chose: "choose", chosen: "choose",
  drove: "drive", driven: "drive", ate: "eat", eaten: "eat", fell: "fall", fallen: "fall",
  felt: "feel", found: "find", gave: "give", given: "give", grew: "grow", grown: "grow",
  heard: "hear", held: "hold", kept: "keep", left: "leave", lost: "lose", met: "meet",
  paid: "pay", ran: "run", running: "run", sat: "sit", sitting: "sit", slept: "sleep",
  stood: "stand", standing: "stand", swam: "swim", swimming: "swim", told: "tell",
  wore: "wear", worn: "wear", won: "win", winning: "win",
  better: "good", best: "good", worse: "bad", worst: "bad",
  further: "far", furthest: "far", farther: "far", farthest: "far",
  // plural/3sg regular-ish that stemmers mangle
  lives: "life", wives: "wife", knives: "knife", leaves: "leaf",
  studies: "study", flies: "fly", tries: "try", cries: "cry",
  // 3sg/过去 silent-e 与短词（STEP5 量度保护后仍需显式保底，见 stem）
  goes: "go", dying: "die", lying: "lie", tying: "tie",
  died: "die", lied: "lie", tied: "tie",
  going: "go", making: "make", taking: "take", coming: "come",
}));

// Ordered longest-first. Conservative: only fire with a viable stem left.
// -es 显式规则优先（boxes->box、watches->watch 一步到位，不依赖 STEP5 e 脱落；
// houses->house 走通用 s，保留 e 见 STEP5 严格量度）。
const STEP1 = [
  ["sses", "ss"], ["ies", "y"], ["ss", "ss"],
  ["ches", "ch"], ["shes", "sh"], ["xes", "x"], ["zes", "z"], ["oes", "o"],
  ["s", ""],
];
const STEP2 = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
  ["izer", "ize"], ["bli", "ble"], ["alli", "al"], ["entli", "ent"],
  ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
  ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
  ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
];
const STEP3 = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
  ["ical", "ic"], ["ful", ""], ["ness", ""],
];
const STEP4 = [
  ["al", ""], ["ance", ""], ["ence", ""], ["er", ""], ["ic", ""], ["able", ""],
  ["ible", ""], ["ant", ""], ["ement", ""], ["ment", ""], ["ent", ""],
  ["ion", "", 3], ["ou", ""], ["ism", ""], ["ate", ""], ["iti", ""],
  ["ous", ""], ["ive", ""], ["ize", ""],
];

// Porter 量度 m（VC 序列数）：STEP5 e 脱落必须 m>1（house/time 不脱落），
// 防止 houses->hous、writes->writ、boxes->boxe->box 链中断。
function isVowelAt(w, i) {
  const c = w[i];
  if ("aeiou".includes(c)) return true;
  if (c === "y") return i === 0 ? false : !"aeiou".includes(w[i - 1]);
  return false;
}
function measure(w) {
  let m = 0, i = 0;
  const n = w.length;
  while (i < n && !isVowelAt(w, i)) i++;
  while (i < n) {
    while (i < n && isVowelAt(w, i)) i++;
    if (i >= n) break;
    m++;
    while (i < n && !isVowelAt(w, i)) i++;
  }
  return m;
}
function containsVowel(stem) {
  for (let i = 0; i < stem.length; i++) if (isVowelAt(stem, i)) return true;
  return false;
}
function isDoubleCons(w) {
  return w.length >= 2 && w[w.length - 1] === w[w.length - 2] && !"aeiou".includes(w[w.length - 1]);
}
function isCvc(w) {
  if (w.length < 3) return false;
  const a = w[w.length - 3], b = w[w.length - 2], c = w[w.length - 1];
  const isC = (ch) => {
    if ("aeiou".includes(ch)) return false;
    if (ch === "y") return true; // y 在末位视为辅音（Porter *o 口径简化）
    if ("wx".includes(ch)) return false;
    return true;
  };
  const isV = (ch, idx) => {
    if ("aeiou".includes(ch)) return true;
    if (ch === "y") return idx !== 0 && !"aeiou".includes(w[idx - 1]);
    return false;
  };
  // cvc 且末辅音非 w/x/y
  return isC(a) && isV(b, w.length - 2) && isC(c) && !"wxy".includes(c);
}
// STEP1b2 e 回补（Porter 原意 if-else 链）：at/bl/iz->+e，否则双辅音->单（不再+e，
// stopped->stop 不变 stope），否则 m==1 且 cvc->+e（lik->like）。
function step1b2(t) {
  if (t.endsWith("at") || t.endsWith("bl") || t.endsWith("iz")) return t + "e";
  if (isDoubleCons(t) && !/[lsz]$/.test(t)) return t.slice(0, -1);
  if (measure(t) === 1 && isCvc(t)) return t + "e";
  return t;
}

function stem(w) {
  let s = stripSuffixes(w, STEP1);
  s = stripSuffixes(s, STEP2);
  s = stripSuffixes(s, STEP3);
  s = stripSuffixes(s, STEP4);
  // -ied 过去式：consonant-y 动词 tried->try（died/lied/tied 已进例外表保 ie）
  if (s.endsWith("ied") && s.length > 4) return s.slice(0, -3) + "y";
  // -ying：studying->study（dying/lying/tying 已进例外表保 ie）
  if (s.endsWith("ying") && s.length > 5) return s.slice(0, -4) + "y";
  if (s.endsWith("ing") && s.length > 5) {
    const pre = s.slice(0, -3);
    if (!containsVowel(pre)) return s;
    return step1b2(pre);
  }
  if (s.endsWith("eed") && s.length > 4) {
    if (measure(s.slice(0, -1)) > 0) return s.slice(0, -1);
    return s;
  }
  if (s.endsWith("ed") && s.length > 4) {
    const pre = s.slice(0, -2);
    if (!containsVowel(pre)) return s;
    return step1b2(pre);
  }
  // STEP5：e 脱落仅 m>1（严格 Porter：houses->house/writes->write 保留 e；
  // boxes->box 已由 STEP1 xes->x 一步到位，不依赖此步）。
  // ll->l 仅 m>1。
  if (s.endsWith("e") && s.length > 4) {
    const pre = s.slice(0, -1);
    if (measure(pre) > 1) return pre;
    return s;
  }
  if (s.endsWith("ll") && s.length > 4 && measure(s) > 1) return s.slice(0, -1);
  return s;
}

export function segment(text) {
  return segmentLatin(text);
}

export function lemmatize(token) {
  if (!token) return token;
  const lower = token.toLowerCase().replace(/^['’]+|['’]+$/g, "");
  const ex = applyExceptions(lower, EXCEPTIONS);
  if (ex) return ex;
  return stem(lower);
}

export const stopwords = new Set(
  "a an the and or but if then else when while of at by for with about into through during before after above below to from up down in out on off over under again further once here there all any both each few more most other some such no nor not only own same so than too very can will just don should now".split(" ")
);
