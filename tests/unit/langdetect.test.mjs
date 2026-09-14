import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectParaLang, normalizeLangTag } from "../../packages/web/src/reader/langdetect.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fx = (l) => readFileSync(join(root, "tests/fixtures", `${l}.txt`), "utf8");

const DE = [
  "Die Walküre reitet durch die Nacht und das Schwert liegt im Baum.",
  "Siegmund zieht das Schwert aus dem Stamm der Esche im Frühling.",
  "Brünnhilde schützt den Helden vor dem Zorn des Göttervaters.",
  "Weia! Waga! Woge, du Welle, walle zur Wiege!",
];
const EN = [
  "Time flies like an arrow and the quiet river runs through the valley.",
  "Siegmund draws the sword from the tree while the hero rides at night.",
  "She protects the hero from the wrath of the father of gods.",
  "The ring brings curse and death upon the whole world.",
];

describe("detectParaLang (de/en adaptive routing)", () => {
  it("routes German libretto lines to de", () => {
    for (const t of DE) assert.equal(detectParaLang(t), "de", t.slice(0, 40));
  });
  it("routes English lines to en (even with German proper nouns)", () => {
    for (const t of EN) assert.equal(detectParaLang(t), "en", t.slice(0, 40));
  });
  it("abstains on short/ambiguous text", () => {
    assert.equal(detectParaLang("Hi!"), null);
    assert.equal(detectParaLang("Ring Ring Ring"), null);
    assert.equal(detectParaLang(""), null);
  });
  it("routes fixture texts correctly-or-abstains (never confidently wrong)", () => {
    // en fixture 只有一个停用词（and），按设计弃权；其余应判对。
    for (const l of ["de", "en", "fr", "it", "es", "ru", "ja"]) {
      const r = detectParaLang(fx(l));
      assert.ok(r === l || r === null, `fixture ${l} got ${r}`);
    }
    assert.equal(detectParaLang(fx("en")), null);
  });
  it("routes romance + script languages", () => {
    assert.equal(detectParaLang("La maison et l'homme voient la ville sous le ciel bleu."), "fr");
    assert.equal(detectParaLang("Le président a déclaré que la France soutiendra toujours la liberté."), "fr");
    assert.equal(detectParaLang("La casa e l'uomo vedono la città sotto il cielo azzurro."), "it");
    assert.equal(detectParaLang("Il governo ha detto che l'Italia sarà sempre libera e unita."), "it");
    assert.equal(detectParaLang("La casa y el hombre ven la ciudad bajo el cielo azul."), "es");
    assert.equal(detectParaLang("El gobierno dijo que España siempre defenderá la libertad."), "es");
    assert.equal(detectParaLang("Дом и человек видят город под голубым небом."), "ru");
    assert.equal(detectParaLang("家と人は青い空の下で町を見る。"), "ja");
  });
  it("does not flip on foreign quotes inside a paragraph", () => {
    assert.equal(detectParaLang("Time is precious, and we move on with quiet hearts every day."), "en");
    assert.equal(detectParaLang("Der alte Mann sagte leise Goodbye und ging in die Nacht."), "de");
  });
  it("catches short libretto lines via strong spelling signals", () => {
    assert.equal(detectParaLang("Brünnhilde"), "de");
    assert.equal(detectParaLang("Straße"), "de");
    assert.equal(detectParaLang("Weia! Waga!"), null);
    assert.equal(detectParaLang("¿Qué pasa?"), "es");
  });
});

describe("normalizeLangTag", () => {
  it("folds bcp47 and names", () => {
    assert.equal(normalizeLangTag("de-DE"), "de");
    assert.equal(normalizeLangTag("German"), "de");
    assert.equal(normalizeLangTag("EN"), "en");
    assert.equal(normalizeLangTag(""), "");
  });
});
