// EPUB 导出（阅读页当前书，原文+释义对照）。
// - 输入：Book（章节结构保留）+ 每章 AnnotatedParagraph[][]（已注出，调用方决定纯词典/LLM回填）。
// - gloss 落为小字括号：`<small class="gloss">（gloss）</small>` + 内联 CSS，不依赖 JS。
// - 标准 EPUB（JSZip 复用，动态 import，首屏不打包）：mimetype(STORE) + container.xml +
//   content.opf + toc.ncx + OEBPS/chN.xhtml + style.css。
// - 文件名含语言：`<title>-<lang>-<target>.epub`。
// - 无 key 时调用方只传纯词典 annotated；有 key 时调用方先做 LLM 回填再传（本模块不调网，不碰 key）。

import type { AnnotatedParagraph } from '../reader/render.js';
import type { Book, TargetLang, Token } from '../types.js';

export function escapeXml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!
  ));
}

export function sanitizeFilename(s: string): string {
  const t = String(s ?? '').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  return t || 'book';
}

/** 文件名含语言：`<title>-<lang>-<target>.epub` */
export function epubFilename(title: string, lang: string, target: TargetLang): string {
  return `${sanitizeFilename(title)}-${lang}-${target}.epub`;
}

/** 单 token -> EPUB 内联：有 gloss 落小字括号，无 gloss 只留原文（缺词不编造）。 */
export function renderTokenEpub(t: Token): string {
  if (!t.isWord) return escapeXml(t.surface);
  const surf = escapeXml(t.surface);
  if (!t.gloss) return surf;
  return `${surf}<small class="gloss">（${escapeXml(t.gloss)}）</small>`;
}

/** 单段 -> EPUB <p>（token 顺序拼接；空格/标点由非词 token 原样保留）。 */
export function renderParagraphEpub(para: AnnotatedParagraph): string {
  const inner = para.tokens.map(renderTokenEpub).join('');
  return `<p>${inner}</p>`;
}

const EPUB_CSS = `.gloss{font-size:.72em;color:#555;margin:0 .1em;}\n` +
  `p{line-height:2;margin:.6em 0;}\n` +
  `h2{font-size:1.2em;margin:.8em 0 .4em;}\n`;

export function buildChapterXhtml(chTitle: string, paras: AnnotatedParagraph[], uid: string): string {
  const body = paras.map(renderParagraphEpub).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(chTitle)}</title>` +
    `<link rel="stylesheet" type="text/css" href="style.css"/></head>` +
    `<body><h2 id="${escapeXml(uid)}">${escapeXml(chTitle)}</h2>\n${body}\n</body></html>`;
}

export function buildContainerXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>` +
    `</rootfiles></container>`;
}

export function buildContentOpf(book: Book, target: TargetLang): string {
  const items = book.chapters.map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = book.chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:title>${escapeXml(book.title)}</dc:title>` +
    `<dc:language>${escapeXml(book.lang)}-${escapeXml(target)}</dc:language>` +
    `<dc:identifier id="bookid">ilr-${escapeXml(book.lang)}-${Date.now()}</dc:identifier>` +
    `<meta name="ilr-target" content="${escapeXml(target)}"/>` +
    `</metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
    `<item id="css" href="style.css" media-type="text/css"/>${items}</manifest>` +
    `<spine toc="ncx">${spine}</spine></package>`;
}

export function buildTocNcx(book: Book): string {
  const points = book.chapters.map((c, i) =>
    `<navPoint id="np${i + 1}" playOrder="${i + 1}">` +
    `<navLabel><text>${escapeXml(c.title)}</text></navLabel>` +
    `<content src="ch${i + 1}.xhtml"/></navPoint>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
    `<head><meta name="dtb:uid" content="ilr"/></head>` +
    `<docTitle><text>${escapeXml(book.title)}</text></docTitle>` +
    `<navMap>${points}</navMap></ncx>`;
}

/**
 * 纯函数：Book + 每章 annotated -> 文件表（不碰 zip，单测直接断言）。
 * annotatedByChapter[i] 对应 book.chapters[i]（长度不足时按原文无注兜底）。
 */
export function buildEpubFiles(
  book: Book,
  annotatedByChapter: AnnotatedParagraph[][],
  target: TargetLang,
): Map<string, string> {
  const files = new Map<string, string>();
  files.set('mimetype', 'application/epub+zip');
  files.set('META-INF/container.xml', buildContainerXml());
  files.set('OEBPS/content.opf', buildContentOpf(book, target));
  files.set('OEBPS/toc.ncx', buildTocNcx(book));
  files.set('OEBPS/style.css', EPUB_CSS);
  book.chapters.forEach((ch, i) => {
    const ann = annotatedByChapter[i] ?? ch.paragraphs.map((text) => ({ text, tokens: [] as Token[] }));
    // 无 annotated tokens 时（兜底）退化为原文段落，保证章节结构不丢。
    const paras: AnnotatedParagraph[] = ann.length
      ? ann
      : ch.paragraphs.map((text) => ({ text, tokens: [] as Token[] }));
    const htmlParas: AnnotatedParagraph[] = paras.map((p) =>
      p.tokens.length ? p : { text: p.text, tokens: [{ surface: p.text, lemma: p.text, isWord: false, gloss: null, glossSource: null, known: false, stopword: false } as Token] },
    );
    files.set(`OEBPS/ch${i + 1}.xhtml`, buildChapterXhtml(ch.title, htmlParas, `ch${i + 1}`));
  });
  return files;
}

type ZipLike = {
  file(path: string, data: string | Uint8Array | Blob, opts?: Record<string, unknown>): unknown;
  generateAsync(opts: Record<string, unknown>): Promise<Blob>;
};

/** 打包为标准 EPUB Blob（JSZip 复用；zipImpl 可注入便于单测，默认动态 import）。 */
export async function buildEpubBlob(
  book: Book,
  annotatedByChapter: AnnotatedParagraph[][],
  target: TargetLang,
  zipImpl?: new () => ZipLike,
): Promise<{ blob: Blob; filename: string }> {
  const files = buildEpubFiles(book, annotatedByChapter, target);
  let ZipCtor: new () => ZipLike;
  if (zipImpl) {
    ZipCtor = zipImpl;
  } else {
    const mod = await import('jszip') as unknown as { default: new () => ZipLike };
    ZipCtor = mod.default;
  }
  const zip = new ZipCtor();
  for (const [path, content] of files) {
    // EPUB 规范：mimetype 必须首个且不压缩。
    if (path === 'mimetype') zip.file(path, content, { compression: 'STORE' });
    else zip.file(path, content, { compression: 'DEFLATE' });
  }
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
  return { blob, filename: epubFilename(book.title, book.lang, target) };
}
