// 多语言屈折回归：fr/it/es/ru/de 的常见屈折形必须能通过真实链路（pack lemmatize +
// lookupKeys 候选展开 + 随仓库发布的真实词典分片）查到释义。
// 2026-11-07 用户要求「七种语言都不许词典认不出 s/ing/ed 这类屈折」。en 已有
// en-inflections.test.mjs 锁；本文件锁其余语言。
// 注意词典内容层的现实：fr/it/es/de/ru→zh 与 ja→zh/en 是种子桩（52-101 条），
// 故本测试对有内容的 target（en）断言；zh 向的缺口是内容管道问题（DICT_SOURCES.md），
// 不是规则问题——阅读时这些语言对的缺词由 LLM（BYOK/Auto）兜底。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
};
globalThis.fetch = async (url) => {
  const m = String(url).match(/dict\/([a-z]+)\/([^/]+)\.dict(\.\d+)?$/);
  if (!m) return { ok: false, status: 404, text: async () => "" };
  try {
    const p = join(root, "packages/web/public/dict", m[1], `${m[2]}.dict${m[3] ?? ""}`);
    return { ok: true, status: 200, text: async () => readFileSync(p, "utf8") };
  } catch {
    return { ok: false, status: 404, text: async () => "" };
  }
};

const { getGlossWithSource } = await import("../../packages/web/src/dict/dict-loader.ts");
const packOf = (l) => import(`../../packages/lang-packs/src/${l}.mjs`);

const SPEC = {
  fr: `parle parles parlons parlez parlent parlais parlait parlaient parlera parlant mange mangez mangé mangée
    finis finit finissent vendu vendus vendre prendre prend prennent maison maisons chat chats eau petite petites
    grand grands belle belles nouveau nouveaux beaux vieux nouvelle femmes femme homme hommes enfant enfants livre livres`,
  it: `parlo parli parla parliamo parlate parlano parlava parlavano parlato mangiare mangia mangiano mangiato
    finire finisce finito prendere prende preso casa case acqua piccola piccole piccolo piccoli belle bella grande
    grandi uomini uomo donna donne libro libri giorno giorni`,
  es: `hablo hablas habla hablamos hablan hablaba hablaban hablara hablado comer come comen comido vivir vive
    viven vivido ser es son estar estoy tener tiene tienen hacer hace hecho ir voy va casa casas agua pequeño
    grandes hombre hombres mujer mujeres niño niños libro libros día días`,
  de: `spreche sprichst spricht sprechen sprecht gesprochen lese liest lesen gelesen Bücher Haus Häuser Wasser
    gut gute guten gutes kleiner kleine kleinen groß große großer sprechend lesend Mann Männer Frau Frauen Kinder`,
  ru: `говорю говоришь говорит говорим говорят говорил говорила говорили читать читаю читает читали дом дома
    дому домом домов книга книги книге книгу книг хороший хорошая хорошие вода воды воду женщина женщины мужчина
    человек человека время времени`,
};

describe("fr/it/es/de/ru inflections resolve through the real dict chain", () => {
  for (const [lang, words] of Object.entries(SPEC)) {
    it(`${lang}->en: no inflected surface is left behind`, async () => {
      const pack = await packOf(lang);
      const list = [...new Set(words.split(/\s+/).filter(Boolean))];
      const misses = [];
      for (const surface of list) {
        const lemma = pack.lemmatize(surface);
        const r = await getGlossWithSource(lang, "en", lemma, surface);
        if (!r.gloss) misses.push(`${surface} (lemma=${lemma})`);
      }
      assert.deepEqual(misses, [], `${lang} 屈折形 miss: ${misses.join(", ")}`);
    });
  }

  it("over-strip guard: wrong candidates must not hijack honest misses (fr limerence-class)", async () => {
    // 词典没有的形必须诚实 miss（走 LLM），不许被造出来的候选抢答
    const fr = await packOf("fr");
    const r = await getGlossWithSource("fr", "en", fr.lemmatize("xylotron"), "xylotron");
    assert.equal(r.gloss, null, "生造词应诚实 miss");
  });
});
