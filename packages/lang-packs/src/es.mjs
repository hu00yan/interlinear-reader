// Spanish pack: segment / lemmatize / stopwords.
// Verb conjugation endings + noun/adjective gender-number.

import { segmentLatin, stripSuffixes, applyExceptions } from "./_latin.mjs";

export const lang = "es";

const EXCEPTIONS = new Map(Object.entries({
  soy: "ser", eres: "ser", es: "ser", somos: "ser", sois: "ser", son: "ser",
  era: "ser", eras: "ser", éramos: "ser", fueron: "ser", sido: "ser", sea: "ser",
  estoy: "estar", estás: "estar", está: "estar", estamos: "estar", están: "estar",
  estaba: "estar", estado: "estar", esté: "estar",
  he: "haber", has: "haber", ha: "haber", hemos: "haber", han: "haber", había: "haber", habido: "haber",
  tengo: "tener", tienes: "tener", tiene: "tener", tenemos: "tener", tuvieron: "tener", tenido: "tener",
  hago: "hacer", haces: "hacer", hace: "hacer", hicieron: "hacer", hecho: "hacer",
  voy: "ir", vas: "ir", va: "ir", vamos: "ir", fueron: "ir", ido: "ir",
  puedo: "poder", puedes: "poder", puede: "poder", pudieron: "poder", podido: "poder",
  digo: "decir", dices: "decir", dice: "decir", dicho: "decir",
  veo: "ver", ves: "ver", ve: "ver", visto: "ver",
  doy: "dar", das: "dar", da: "dar", dado: "dar",
  sé: "saber", sabes: "saber", sabe: "saber", sabido: "saber",
  quiero: "querer", quieres: "querer", quiere: "querer", querido: "querer",
  dicen: "decir", hacen: "hacer", vienen: "venir", van: "ir",
  tienen: "tener", dan: "dar", son: "ser",
  vemos: "ver", han: "haber", dando: "dar", leyendo: "leer",
  ojos: "ojo", hombres: "hombre",
  mejor: "bueno", mejores: "bueno", peor: "malo", mayor: "grande",
}));

function stripAccents(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const RULES = [
  ["imientos", "ir", 5], ["imiento", "ir", 5], ["amientos", "ar", 5], ["amiento", "ar", 5],
  ["aciones", "ar", 5], ["ación", "ar", 4], ["uciones", "uir", 5], ["ución", "uir", 4],
  ["arían", "ar", 4], ["erían", "er", 4], ["irían", "ir", 4],
  ["arais", "ar", 4], ["erais", "er", 4], ["irais", "ir", 4],
  ["aseis", "ar", 4], ["ieseis", "er", 4],
  ["aron", "ar", 3], ["eron", "er", 3], ["ieron", "ir", 3],
  ["ando", "ar", 4], ["eyendo", "eer", 3], ["iendo", "er", 3], ["yendo", "ir", 3],
  // 现在时（-ar/-er/-ir）：须在复数 -s 之前。注：lemmatize 先 stripAccents，
  // 故带重音的 -arán/-aréis/-ía 等规则永不命中，此处补无重音双生规则。
  ["amos", "ar", 3], ["emos", "er", 3], ["imos", "ir", 3],
  ["ais", "ar", 3], ["eis", "er", 3], ["ois", "ir", 3],
  ["areis", "ar", 3], ["ereis", "er", 3], ["ireis", "ir", 3],
  ["aran", "ar", 3], ["eran", "er", 3], ["iran", "ir", 3],
  ["ian", "er", 3], ["ia", "er", 3],
  ["an", "ar", 3], ["en", "er", 3],
  ["aremos", "ar", 4], ["eremos", "er", 4], ["iremos", "ir", 4],
  ["aréis", "ar", 4], ["eréis", "er", 4], ["iréis", "ir", 4],
  ["arán", "ar", 3], ["erán", "er", 3], ["irán", "ir", 3],
  ["aba", "ar", 3], ["ada", "ar", 3], ["ida", "ir", 3], ["ía", "er", 3],
  ["ado", "ar", 3], ["ido", "er", 3],
  ["mente", "", 5],
  ["idades", "", 4], ["idad", "", 4],
  ["ivas", "ivo", 3], ["iva", "ivo", 3], ["ivos", "ivo", 3], ["ivo", "ivo", 3],
  ["osas", "oso", 3], ["osa", "oso", 3], ["osos", "oso", 3],
  ["adora", "ar", 4], ["ador", "ar", 3],
  ["anza", "", 4], ["ante", "", 4],
  ["es", "", 3], ["s", "", 3],
];

export function segment(text) {
  return segmentLatin(text);
}

export function lemmatize(token) {
  if (!token) return token;
  const lower = token.toLowerCase();
  const ex = applyExceptions(lower, EXCEPTIONS);
  if (ex) return ex;
  const plain = stripAccents(lower);
  const stemmed = stripSuffixes(plain, RULES);
  return stemmed;
}

export const stopwords = new Set(
  "el la los las un una unos unas de del al en y o pero porque como cuando donde que qué quién cuál cuáles este esta estos estas ese esa esos esas aquel aquella aquello mi tu su nuestro vuestro sus mis tus yo tú él ella ello nosotros vosotros ellos ellas me te se nos os le les lo los la las muy más menos mucho poca poco tanto tan ya no sí también solo sólo hasta desde entre sobre tras durante mediante sin con por para haber estar ser es son era eran fue fueron sido estoy está están este".split(" ")
);
