// 模型质量金标（私有）：7 源语言各 1 段 Gibbon 式平行难句 + 中文参考释义。
// !!! 私有测试材料：UI 层禁止渲染原文/参考（防用户照抄作弊）。
// 设置页只展示分数/ verdict /换模型建议，绝不展示 text/expects。
// target 锁死 zh（默认目标语言）；判分见 ./score.ts。

export interface GoldenToken {
  i: number;
  surface: string;
  lemma: string;
}

export interface GoldenRef {
  /** 与 tokens[].lemma 对应（大小写不敏感匹配） */
  lemma: string;
  /** 可接受的中文释义子串（命中其一即算命中） */
  expects: string[];
}

export interface GoldenItem {
  id: string;
  lang: "en" | "de" | "fr" | "it" | "es" | "ru" | "ja";
  target: "zh";
  text: string;
  tokens: GoldenToken[];
  refs: GoldenRef[];
}

export const GOLDEN_VERSION = "v1";
export const GOLDEN_TARGET = "zh" as const;

export const GOLDEN_SENTENCES: GoldenItem[] = [
  {
    id: "en-1",
    lang: "en",
    target: "zh",
    text: "The decline of the empire was hastened by the luxury of the court and the venality of the legions.",
    tokens: [
      { i: 0, surface: "decline", lemma: "decline" },
      { i: 1, surface: "empire", lemma: "empire" },
      { i: 2, surface: "hastened", lemma: "hasten" },
      { i: 3, surface: "luxury", lemma: "luxury" },
      { i: 4, surface: "court", lemma: "court" },
      { i: 5, surface: "venality", lemma: "venality" },
      { i: 6, surface: "legions", lemma: "legion" },
    ],
    refs: [
      { lemma: "decline", expects: ["衰落", "衰退", "没落"] },
      { lemma: "empire", expects: ["帝国"] },
      { lemma: "hasten", expects: ["加速", "促使", "加快"] },
      { lemma: "luxury", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "court", expects: ["宫廷", "朝廷"] },
      { lemma: "venality", expects: ["贪腐", "腐败", "卖官", "受贿", "贪赃"] },
      { lemma: "legion", expects: ["军团"] },
    ],
  },
  {
    id: "de-1",
    lang: "de",
    target: "zh",
    text: "Der Verfall des Reiches wurde durch die Üppigkeit des Hofes und die Käuflichkeit der Legionen beschleunigt.",
    tokens: [
      { i: 0, surface: "Verfall", lemma: "Verfall" },
      { i: 1, surface: "Reiches", lemma: "Reich" },
      { i: 2, surface: "Üppigkeit", lemma: "Üppigkeit" },
      { i: 3, surface: "Hofes", lemma: "Hof" },
      { i: 4, surface: "Käuflichkeit", lemma: "Käuflichkeit" },
      { i: 5, surface: "Legionen", lemma: "Legion" },
      { i: 6, surface: "beschleunigt", lemma: "beschleunigen" },
    ],
    refs: [
      { lemma: "Verfall", expects: ["衰落", "衰退", "没落"] },
      { lemma: "Reich", expects: ["帝国"] },
      { lemma: "Üppigkeit", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "Hof", expects: ["宫廷", "朝廷"] },
      { lemma: "Käuflichkeit", expects: ["贪腐", "腐败", "受贿", "卖官"] },
      { lemma: "Legion", expects: ["军团"] },
      { lemma: "beschleunigen", expects: ["加速", "加快", "促使"] },
    ],
  },
  {
    id: "fr-1",
    lang: "fr",
    target: "zh",
    text: "Le déclin de l'empire fut précipité par le luxe de la cour et la vénalité des légions.",
    tokens: [
      { i: 0, surface: "déclin", lemma: "déclin" },
      { i: 1, surface: "empire", lemma: "empire" },
      { i: 2, surface: "précipité", lemma: "précipiter" },
      { i: 3, surface: "luxe", lemma: "luxe" },
      { i: 4, surface: "cour", lemma: "cour" },
      { i: 5, surface: "vénalité", lemma: "vénalité" },
      { i: 6, surface: "légions", lemma: "légion" },
    ],
    refs: [
      { lemma: "déclin", expects: ["衰落", "衰退", "没落"] },
      { lemma: "empire", expects: ["帝国"] },
      { lemma: "précipiter", expects: ["加速", "促使", "加快"] },
      { lemma: "luxe", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "cour", expects: ["宫廷", "朝廷"] },
      { lemma: "vénalité", expects: ["贪腐", "腐败", "受贿", "卖官"] },
      { lemma: "légion", expects: ["军团"] },
    ],
  },
  {
    id: "it-1",
    lang: "it",
    target: "zh",
    text: "Il declino dell'impero fu accelerato dal lusso della corte e dalla venalità delle legioni.",
    tokens: [
      { i: 0, surface: "declino", lemma: "declino" },
      { i: 1, surface: "impero", lemma: "impero" },
      { i: 2, surface: "accelerato", lemma: "accelerare" },
      { i: 3, surface: "lusso", lemma: "lusso" },
      { i: 4, surface: "corte", lemma: "corte" },
      { i: 5, surface: "venalità", lemma: "venalità" },
      { i: 6, surface: "legioni", lemma: "legione" },
    ],
    refs: [
      { lemma: "declino", expects: ["衰落", "衰退", "没落"] },
      { lemma: "impero", expects: ["帝国"] },
      { lemma: "accelerare", expects: ["加速", "加快", "促使"] },
      { lemma: "lusso", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "corte", expects: ["宫廷", "朝廷"] },
      { lemma: "venalità", expects: ["贪腐", "腐败", "受贿", "卖官"] },
      { lemma: "legione", expects: ["军团"] },
    ],
  },
  {
    id: "es-1",
    lang: "es",
    target: "zh",
    text: "La decadencia del imperio fue acelerada por el lujo de la corte y la venalidad de las legiones.",
    tokens: [
      { i: 0, surface: "decadencia", lemma: "decadencia" },
      { i: 1, surface: "imperio", lemma: "imperio" },
      { i: 2, surface: "acelerada", lemma: "acelerar" },
      { i: 3, surface: "lujo", lemma: "lujo" },
      { i: 4, surface: "corte", lemma: "corte" },
      { i: 5, surface: "venalidad", lemma: "venalidad" },
      { i: 6, surface: "legiones", lemma: "legión" },
    ],
    refs: [
      { lemma: "decadencia", expects: ["衰落", "衰退", "没落", "颓废"] },
      { lemma: "imperio", expects: ["帝国"] },
      { lemma: "acelerar", expects: ["加速", "加快", "促使"] },
      { lemma: "lujo", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "corte", expects: ["宫廷", "朝廷"] },
      { lemma: "venalidad", expects: ["贪腐", "腐败", "受贿", "卖官"] },
      { lemma: "legión", expects: ["军团"] },
    ],
  },
  {
    id: "ru-1",
    lang: "ru",
    target: "zh",
    text: "Упадок империи ускорили роскошь двора и продажность легионов.",
    tokens: [
      { i: 0, surface: "Упадок", lemma: "упадок" },
      { i: 1, surface: "империи", lemma: "империя" },
      { i: 2, surface: "ускорили", lemma: "ускорить" },
      { i: 3, surface: "роскошь", lemma: "роскошь" },
      { i: 4, surface: "двора", lemma: "двор" },
      { i: 5, surface: "продажность", lemma: "продажность" },
      { i: 6, surface: "легионов", lemma: "легион" },
    ],
    refs: [
      { lemma: "упадок", expects: ["衰落", "衰退", "没落"] },
      { lemma: "империя", expects: ["帝国"] },
      { lemma: "ускорить", expects: ["加速", "加快", "促使"] },
      { lemma: "роскошь", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "двор", expects: ["宫廷", "朝廷"] },
      { lemma: "продажность", expects: ["贪腐", "腐败", "受贿", "卖官"] },
      { lemma: "легион", expects: ["军团"] },
    ],
  },
  {
    id: "ja-1",
    lang: "ja",
    target: "zh",
    text: "帝国の衰亡は宮廷の奢侈と軍団の腐敗によって早められた。",
    tokens: [
      { i: 0, surface: "帝国", lemma: "帝国" },
      { i: 1, surface: "衰亡", lemma: "衰亡" },
      { i: 2, surface: "宮廷", lemma: "宮廷" },
      { i: 3, surface: "奢侈", lemma: "奢侈" },
      { i: 4, surface: "軍団", lemma: "軍団" },
      { i: 5, surface: "腐敗", lemma: "腐敗" },
      { i: 6, surface: "早められた", lemma: "早める" },
    ],
    refs: [
      { lemma: "帝国", expects: ["帝国"] },
      { lemma: "衰亡", expects: ["衰落", "衰退", "灭亡", "没落"] },
      { lemma: "宮廷", expects: ["宫廷", "朝廷"] },
      { lemma: "奢侈", expects: ["奢华", "奢侈", "奢靡"] },
      { lemma: "軍団", expects: ["军团"] },
      { lemma: "腐敗", expects: ["腐败", "贪腐", "堕落"] },
      { lemma: "早める", expects: ["加速", "加快", "促使", "提前"] },
    ],
  },
];
