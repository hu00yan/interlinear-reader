// Stable contract consumed by web / provider (Track C).
//   import { segment, lemmatize, isStopword, getLangPack } from "@interlinear/lang-packs";
// All functions are pure + sync except JA wasm upgrade (ja.loadLindera).
// Per-language entry points are lazy-loadable: import("@interlinear/lang-packs/en").

import * as en from "./en.mjs";
import * as de from "./de.mjs";
import * as fr from "./fr.mjs";
import * as it from "./it.mjs";
import * as es from "./es.mjs";
import * as ru from "./ru.mjs";
import * as ja from "./ja.mjs";

export { en, de, fr, it, es, ru, ja };

export const SUPPORTED_LANGS = ["en", "de", "fr", "it", "es", "ru", "ja"];
export const SUPPORTED_TARGETS = ["zh", "en"];

const PACKS = { en, de, fr, it, es, ru, ja };

export function assertLang(lang) {
  if (!PACKS[lang]) throw new Error(`unsupported lang: ${lang} (expected one of ${SUPPORTED_LANGS.join(",")})`);
  return lang;
}

export function getLangPack(lang) {
  assertLang(lang);
  return PACKS[lang];
}

// Dynamic (lazy) loader for code-splitting: `await loadLangPack("ja")`.
export async function loadLangPack(lang) {
  assertLang(lang);
  switch (lang) {
    case "en": return import("./en.mjs");
    case "de": return import("./de.mjs");
    case "fr": return import("./fr.mjs");
    case "it": return import("./it.mjs");
    case "es": return import("./es.mjs");
    case "ru": return import("./ru.mjs");
    case "ja": return import("./ja.mjs");
    default: throw new Error(`unsupported lang: ${lang}`);
  }
}

export function segment(lang, text) {
  return getLangPack(lang).segment(text);
}

export function lemmatize(lang, token) {
  return getLangPack(lang).lemmatize(token);
}

export function isStopword(lang, token) {
  const p = getLangPack(lang);
  const key = lang === "ja" ? token : token.toLowerCase();
  return p.stopwords.has(key);
}
