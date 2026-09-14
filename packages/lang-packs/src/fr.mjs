// French pack: segment / lemmatize / stopwords.
// Splits elided clitics (l', d', qu'…) for lookup, strips verb/noun endings.

import { segmentLatin, stripSuffixes, applyExceptions } from "./_latin.mjs";

export const lang = "fr";

const CLITIC_RE = /^(l|d|j|m|t|s|y|c|qu|jusqu|quoiqu|lorsqu|puisqu)['’](.+)$/i;

const EXCEPTIONS = new Map(Object.entries({
  suis: "être", est: "être", sommes: "être", êtes: "être", sont: "être",
  étais: "être", était: "être", étions: "être", furent: "être", été: "être", sois: "être", soit: "être",
  ai: "avoir", as: "avoir", avons: "avoir", avez: "avoir", ont: "avoir",
  avais: "avoir", avait: "avoir", auront: "avoir", aura: "avoir", eu: "avoir", eue: "avoir",
  fais: "faire", fait: "faire", font: "faire", faisons: "faire",
  vais: "aller", vas: "aller", va: "aller", allons: "aller", irai: "aller", allé: "aller",
  peux: "pouvoir", peut: "pouvoir", pouvons: "pouvoir", pourrai: "pouvoir", pu: "pouvoir",
  dois: "devoir", doit: "devoir", devons: "devoir", dû: "devoir",
  veux: "vouloir", veut: "vouloir", voulons: "vouloir", voulu: "vouloir",
  sais: "savoir", sait: "savoir", savons: "savoir", su: "savoir",
  vois: "voir", voit: "voir", voyons: "voir", vu: "voir",
  dis: "dire", dit: "dire", disons: "dire",
  prends: "prendre", prend: "prendre", prenons: "prendre", pris: "prendre",
  mets: "mettre", met: "mettre", mettons: "mettre", mis: "mettre",
  vont: "aller",
  prennent: "prendre", prenne: "prendre", prenez: "prendre",
  sont: "être", êtes: "être",
  yeux: "œil", cieux: "ciel", chevaux: "cheval", journaux: "journal",
  meilleurs: "meilleur", meilleure: "meilleur", mieux: "bien", pis: "mal", pire: "mauvais",
}));

const RULES = [
  ["issements", "ir", 4], ["issement", "ir", 4], ["ations", "er", 4], ["ation", "er", 4],
  ["euses", "eux", 3], ["euse", "eux", 3], ["eaux", "eau", 3], ["aux", "al", 3],
  ["ections", "ect", 4], ["ection", "ect", 4],
  ["eraient", "er", 3], ["erions", "er", 3], ["eront", "er", 3], ["erez", "er", 3],
  ["aient", "er", 3], ["geons", "ger", 3], ["çons", "cer", 3],
  ["issiez", "ir", 3], ["issions", "ir", 3], ["ions", "er", 3], ["issez", "ir", 3], ["isses", "ir", 2],
  ["iez", "er", 3], ["ait", "er", 3],
  ["ant", "er", 3],
  ["ées", "er", 3], ["ée", "er", 3], ["és", "er", 3], ["é", "er", 3],
  ["issant", "ir", 4], ["it", "ir", 3],
  ["ira", "ir", 3], ["irai", "ir", 3], ["iront", "ir", 3],
  ["erai", "er", 3], ["era", "er", 3], ["erons", "er", 3],
  ["ons", "er", 3], ["ez", "er", 3], ["ent", "er", 3],
  ["eux", "eux", 3], ["euse", "eux", 3],
  ["s", "", 3], ["x", "", 3],
  ["e", "", 4],
];

export function splitClitic(token) {
  const m = token.match(CLITIC_RE);
  if (m) return [m[1] + "'", m[2]];
  return [token];
}

export function segment(text) {
  const raw = segmentLatin(text);
  const out = [];
  for (const t of raw) {
    const parts = splitClitic(t);
    out.push(...parts);
  }
  return out;
}

export function lemmatize(token) {
  if (!token) return token;
  let lower = token.toLowerCase().replace(/['’]$/, "");
  const parts = splitClitic(lower);
  lower = parts[parts.length - 1];
  const ex = applyExceptions(lower, EXCEPTIONS);
  if (ex) return ex;
  return stripSuffixes(lower, RULES);
}

export const stopwords = new Set(
  "le la les un une des du de la au aux ce cette ces mon ton son ma ta sa mes tes ses notre votre leur nos vos leurs je tu il elle nous vous ils elles on me te se ne pas plus moins très aussi et ou mais donc car ni que qui quoi dont où quand comme si sur sous dans en vers par pour avec sans contre entre chez est sont était étaient été avoir fait plus tout tous toute toutes même autres autre y en".split(" ")
);
