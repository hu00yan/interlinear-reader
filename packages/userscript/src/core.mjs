export const SKIP =
  'input,textarea,select,button,form,[contenteditable]:not([contenteditable="false"]),code,pre,script,style,noscript,template,svg,math,iframe,ruby,[hidden],[inert],[aria-hidden="true"],[data-ilr-owned]';

export function eligible(node, view = node.ownerDocument.defaultView, ownOriginal = false) {
  if (!node.isConnected || !node.parentElement || !node.data?.trim()) return false;
  if (node.parentElement.closest(ownOriginal ? SKIP.replace(",[data-ilr-owned]", "") : SKIP))
    return false;
  for (let el = node.parentElement; el; el = el.parentElement) {
    const css = view.getComputedStyle(el);
    if (
      css.display === "none" ||
      css.visibility === "hidden" ||
      css.visibility === "collapse" ||
      css.opacity === "0" ||
      css.contentVisibility === "hidden"
    )
      return false;
  }
  return true;
}

export function tokenize(text, Segmenter = Intl.Segmenter) {
  const segments = Segmenter
    ? [...new Segmenter("ja", { granularity: "word" }).segment(text)].map((s) => ({
        text: s.segment,
        word: s.isWordLike,
      }))
    : (
        text.match(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[A-Za-z]+(?:['’][A-Za-z]+)?|[^\p{L}]+|\p{L}+/gu
        ) ?? []
      ).map((text) => ({ text, word: /\p{L}/u.test(text) }));
  return segments.map((s) => ({
    ...s,
    lang: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s.text) ? "ja" : "en",
    key: normalize(s.text),
    word:
      s.word &&
      /\p{L}/u.test(s.text) &&
      !/^[\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(s.text),
  }));
}

// Exactly the web loader normalization, including Japanese voiced-kana marks.
export function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function parseDict(text) {
  if (typeof text !== "string" || /^\s*</.test(text) || text.includes("\ufffd"))
    throw new Error("Invalid dictionary text");
  const map = new Map();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const gloss = line
      .slice(tab + 1)
      .split("\x1f")[0]
      .trim();
    if (gloss) map.set(line.slice(0, tab), gloss.slice(0, 60));
  }
  if (!map.size) throw new Error("Empty dictionary");
  return map;
}

export function endpointURL(raw) {
  const url = new URL(raw.trim());
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("Use HTTPS (HTTP allowed only on loopback).");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("No credentials, query, or fragment in endpoint URL.");
  return url.href.replace(/\/+$/, "");
}

export function annotate(node, tokens) {
  const doc = node.ownerDocument;
  const host = doc.createElement("span");
  host.dataset.ilrOwned = "annotation";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent =
    ":host{display:inline!important} .ilr-word{display:inline-flex;flex-direction:column;vertical-align:baseline;text-align:center;line-height:1.35;margin:0 .08em} .ilr-gloss{font:normal 0.65em/1.3 sans-serif;color:#365c80;max-width:10em;overflow-wrap:anywhere}";
  shadow.append(style);
  const glossNodes = new Map();
  for (const token of tokens) {
    if (!token.word) {
      shadow.append(doc.createTextNode(token.text));
      continue;
    }
    const word = doc.createElement("span");
    word.className = "ilr-word";
    const source = doc.createElement("span");
    source.textContent = token.text;
    const gloss = doc.createElement("span");
    gloss.className = "ilr-gloss";
    gloss.textContent = "\u00a0";
    word.append(source, gloss);
    shadow.append(word);
    glossNodes.set(token, gloss);
  }
  const text = node.data;
  node.replaceWith(host);
  // Keep the exact original node in light DOM (not projected), not an HTML snapshot.
  host.append(node);
  return { host, node, text, tokens, glossNodes };
}

export function intact(record) {
  return (
    record.host.isConnected &&
    record.node.parentNode === record.host &&
    record.host.childNodes.length === 1 &&
    record.node.data === record.text
  );
}

export function restore(records) {
  for (const { host } of records) {
    // Unwrap current children, including site edits; never overwrite with old text.
    if (host.parentNode) host.replaceWith(...host.childNodes);
  }
}

export function batches(items, budget = 6000) {
  const out = [];
  let group = [],
    size = 0;
  for (const item of items) {
    const n = JSON.stringify(item).length;
    if (group.length && (size + n > budget || group.length >= 20)) {
      out.push(group);
      group = [];
      size = 0;
    }
    group.push(item);
    size += n;
  }
  if (group.length) out.push(group);
  return out;
}
