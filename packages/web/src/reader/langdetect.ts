/**
 * 段级语言自适应检测（纯函数，无 DOM，可 node 单测）。
 * 只看与词典覆盖无关的拼写信号（停用词 + 文字/变音符号），因为小词典包
 * （如 de）按命中率投票会把原文误判给大词典包。
 * 返回 'de' | 'en' | 'fr' | 'it' | 'es' | 'ru' | 'ja' | null
 * （信号不足不断言，调用方保留主语言）。
 */

const DE = 'der die das den dem des und oder nicht ein eine einer einem einen eines ist sind war waren wird werden mit von vom zum zur im am an auf aus bei nach über durch für als auch nur schon sehr mehr mein meine dein sein seine ihr ihre uns euch sie er es wir Sie ich du man dass weil wenn aber denn doch hier dort wo wie was wer wen wem alle alles kein keine jede jeder jedes diesen diese dieser dieses solchen';
const EN = 'the an and or not of to in on at is are was were be been being have has had do does did will would shall should can could may might must with for from by about into over after before between through under again once here there when where which who whom whose what this that these those then than too very your you your he she it we they them his her its our their my me him us yours theirs myself himself herself itself ourselves themselves am as but if into nor off out so up yet';
const FR = 'le la les des du de un une et est sont était étaient sera seront avec sans sous sur dans pour par plus tout tous toute toutes mais donc dont quand comment pourquoi parce quoi qui que quoi celui celle ceux celles ceci cela même très aussi peu beaucoup bon bonne toujours déjà voici voilà chez vers pendant contre entre avant après depuis jusque tant jour nuit homme femme enfant ville maison monde temps vie main yeux cœur être avoir faire dire voir savoir vouloir pouvoir aller venir mettre prendre donner grand petit nouveau jeune vieux premier dernier autre autres chaque aucun aucune lequel laquelle lesquels lesquelles auquel auxquels dont où comme si oui non pas ne ni se te me nous vous leur leurs mon ma mes ton ta tes son sa ses notre votre mien mienne quel quelle quels quelles combien trop tellement ainsi alors cependant pourtant car puisque lorsque voilà ici';
const IT = 'il lo la gli che di da con su per tra fra una uno sono sei siamo siete ha ho hai hanno stato stata essere avere fare dire vedere sapere volere potere andare venire mettere prendere dare questo questa questi queste quello quella quelli quelle molto poco più meno senza sopra sotto dentro fuori prima dopo durante mentre quando dove come perché quale quali quanto tanta tanto così anche ancora già mai sempre tutto tutti tutta tutte altro altri altra altre ogni nessuno nessuna alcuno non ne si ti ci vi mio mia miei mie tuo tua suoi sue nostro nostra vostro vostra loro poiché siccome infatti dunque quindi però troppo tanto tale tali stesso stessa buono buona giorno notte uomo donna bambino città casa mondo tempo vita mano occhi cuore grande piccolo nuovo giovane vecchio primo ultimo';
const ES = 'el la los las del lo que una uno unas unos está están estoy estás estamos hay muy más también solo sólo donde cuando porque hasta desde qué cómo cuál cuánto tanta tanto así también aún ya nunca siempre todo todos toda todas otro otros otra otras cada ningún ninguna alguno esta este estos estas ese esa esos esas aquel aquella esto eso aquello muy poco más menos sin sobre bajo dentro fuera antes después durante mientras cuando donde como porque cual cuales cuanto cuanta tanto tales mismo misma bueno buena día noche hombre mujer niño ciudad casa mundo tiempo vida mano ojos corazón grande pequeño nuevo joven viejo primero último otro ser estar tener hacer decir ver saber querer poder ir venir poner tomar dar soy sois tengo tiene tienen puedo puede pueden quiero quiere quieren hace hacen dice dicen veo fue fueron hay mis tus sus nuestro nuestra vuestro vuestra pero sino aunque porque pues ya entonces luego después antes también tampoco nada algo alguien nadie quien quienes cuyo cuya aquí allí ahí adonde entonces así tanto tal tales mismo cada uno dos tres';

function toSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter((w) => w.length >= 2));
}

const STOPS: Record<string, Set<string>> = {
  de: toSet(DE),
  en: toSet(EN),
  fr: toSet(FR),
  it: toSet(IT),
  es: toSet(ES),
};

const WORD_RE = /[\p{L}\p{N}]+/gu;
const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const KANA_RE = /[\u3040-\u30FF]/g;
// 变音/特殊符号加权（英语几乎不用变音符号，出现即显著信号）
const DE_ACCENT = /[äöüÄÖÜß]/g;
const ES_ACCENT = /[ñ¿¡áíóúÁÍÓÚÑ]/g;
const FR_ACCENT = /[éêçâîôûÉÊÇÂÎÔÛ]/g;
const GRAVE_ACCENT = /[àèìòùÀÈÌÒÙ]/g;

/** 段落文本 -> 语言或 null。短文本（<4 词）直接 null（无空格文字先走文字快道）。 */
export function detectParaLang(text: string): 'de' | 'en' | 'fr' | 'it' | 'es' | 'ru' | 'ja' | null {
  // 强拼写快道（先于词数门限：歌词式短行也敢判）：ß 仅德语；
  // äöü/ñ¿¡ 同样独特，配 ≥1 词即判（“Brünnhilde”独占一行也能抓住）。
  const wordsEarly = text.match(WORD_RE) ?? [];
  if (/ß/.test(text)) return 'de';
  if (wordsEarly.length >= 1 && (text.match(DE_ACCENT) ?? []).length > 0) return 'de';
  if (wordsEarly.length >= 1 && (text.match(/[ñ¿¡]/) ?? []).length > 0) return 'es';
  // 文字快道（先于词数门限：无空格文字按“词”计数天然吃亏）。
  // 假名 >=3 即定（真实日文句几乎必有助词/活用假名；“I love すし”式孤例放行给拉丁评分）。
  // 西里尔按含西里尔词的比例定（德语段落夹单个 Достоевский 式人名不翻车）。
  const kana = (text.match(KANA_RE) ?? []).length;
  if (kana >= 3) return 'ja';
  const words = wordsEarly;
  if (words.length < 4) return null;
  let rusWords = 0;
  for (const w of words) {
    if (CYRILLIC_RE.test(w)) rusWords += 1;
  }
  CYRILLIC_RE.lastIndex = 0;
  if (rusWords >= 2 && rusWords / words.length > 0.3) return 'ru';

  const score: Record<string, number> = { de: 0, en: 0, fr: 0, it: 0, es: 0 };
  // 高 distinctive 单字母词（各语言的 and/is/to；一般停用词匹配跳过 len<2）
  for (const w of words) {
    if (w.length === 1) {
      if (w === 'e' || w === 'è') score.it += 1;
      else if (w === 'à') score.fr += 1;
      else if (w === 'y') score.es += 1;
      continue;
    }
    const lw = w.toLowerCase();
    for (const lang of Object.keys(STOPS)) {
      if (STOPS[lang].has(lw)) score[lang] += 1;
    }
  }
  score.de += ((text.match(DE_ACCENT) ?? []).length) * 3;
  score.es += ((text.match(ES_ACCENT) ?? []).length) * 2;
  score.fr += (text.match(FR_ACCENT) ?? []).length;
  const grave = (text.match(GRAVE_ACCENT) ?? []).length;
  score.fr += grave;
  score.it += grave;

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const runner = ranked[1][1];
  // 短文本用小 margin（8 词左右一句也敢判），长文本按比例防误伤；胜者至少 2 分。
  const margin = Math.max(1, Math.round(words.length * 0.12));
  if (topScore >= 2 && topScore - runner >= margin) {
    return top as 'de' | 'en' | 'fr' | 'it' | 'es';
  }
  return null;
}

/** LLM 返回的语言标记归一化到 bcp47 主子标签（'de-DE'->'de'，'German'->'de'，未知原样小写）。 */
export function normalizeLangTag(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  const names: Record<string, string> = {
    german: 'de',
    deutsch: 'de',
    english: 'en',
    french: 'fr',
    francais: 'fr',
    français: 'fr',
    italian: 'it',
    italiano: 'it',
    spanish: 'es',
    espanol: 'es',
    español: 'es',
    russian: 'ru',
    japanese: 'ja',
  };
  if (names[s]) return names[s];
  const m = s.match(/^[a-z]{2,3}/);
  return m ? m[0] : s;
}
