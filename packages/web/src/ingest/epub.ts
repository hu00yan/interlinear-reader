import type { Book, BookChapter, SourceLang } from '../types.js';

/**
 * EPUB 解析：JSZip + 自写 XHTML 提取，保留章节段落。
 * 动态 import（首屏不打包 jszip），调用方：`const { parseEpub } = await import('../ingest/epub.js')`。
 */
export async function parseEpub(file: File, lang: SourceLang): Promise<Book> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const getFile = (p: string) => zip.file(p) ?? zip.file(decodeURIComponent(p));

  const containerXml = await getFile('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('无效 EPUB：缺少 META-INF/container.xml');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile')?.getAttribute('full-path') ?? 'OEBPS/content.opf';

  const base = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : '';
  const opfXml = await getFile(rootfile)?.async('text');
  if (!opfXml) throw new Error(`无效 EPUB：缺少 ${rootfile}`);
  const opf = new DOMParser().parseFromString(opfXml, 'application/xml');

  const title =
    opf.querySelector('metadata title')?.textContent?.trim() ||
    file.name.replace(/\.epub$/i, '');

  const manifest = new Map<string, { href: string; props: string; media: string }>();
  opf.querySelectorAll('manifest item').forEach((it) => {
    const id = it.getAttribute('id') ?? '';
    const href = it.getAttribute('href') ?? '';
    manifest.set(id, {
      href: base + decodeURIComponent(href),
      props: (it.getAttribute('properties') ?? '').toLowerCase(),
      media: (it.getAttribute('media-type') ?? '').toLowerCase(),
    });
  });
  const spine: string[] = [];
  opf.querySelectorAll('spine itemref').forEach((r) => {
    // 跳过非线性 spine（linear=no 多为导航/封面）与 EPUB3 nav 文档
    if ((r.getAttribute('linear') ?? '').toLowerCase() === 'no') return;
    const m = manifest.get(r.getAttribute('idref') ?? '');
    if (!m) return;
    if (m.props.includes('nav')) return;
    if (m.media.includes('nav') || m.media.includes('ncx')) return;
    if (/(^|\/)(nav|toc)\.x?html?$/i.test(m.href)) return;
    spine.push(m.href);
  });

  const chapters: BookChapter[] = [];
  for (let i = 0; i < spine.length; i++) {
    const path = spine[i];
    const f = getFile(path) ?? getFile(path.split('/').pop()!);
    if (!f) continue;
    const xhtml = await f.async('text');
    const { title: ct, paragraphs } = extractXhtml(xhtml);
    if (paragraphs.length === 0) continue;
    chapters.push({ id: `ch${i + 1}`, title: ct || `Chapter ${i + 1}`, paragraphs });
  }
  if (chapters.length === 0) throw new Error('EPUB 未提取到正文段落');
  return { title, lang, chapters, source: 'epub' };
}

/** 自写 XHTML 提取：h1-h3 作标题候选，p/h4-li 转段落，去 script/style，保留文本顺序 */
export function extractXhtml(xhtml: string): { title: string; paragraphs: string[] } {
  const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  const err = doc.querySelector('parsererror');
  const root: Document = err
    ? new DOMParser().parseFromString(xhtml, 'text/html')
    : (doc as unknown as Document);
  root.querySelectorAll('script, style, nav, header, footer').forEach((n) => n.remove());
  const title =
    root.querySelector('h1')?.textContent?.trim() ||
    root.querySelector('h2')?.textContent?.trim() ||
    root.querySelector('title')?.textContent?.trim() ||
    '';
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const raw: string[] = [];
  const nodes = root.querySelectorAll('body p, body h2, body h3, body h4, body li, body blockquote');
  const fallback = nodes.length === 0 ? root.querySelectorAll('p') : nodes;
  fallback.forEach((n) => {
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length >= 1) raw.push(t);
  });
  // 去重：首段与标题同文（nav/title/heading 三处同文，z-lib 常见）去首段；
  // 连续同文段（heading+p 双写 Introduction）只留一段。
  const paragraphs: string[] = [];
  const titleNorm = title ? norm(title) : '';
  for (const t of raw) {
    const tn = norm(t);
    if (paragraphs.length === 0 && titleNorm && tn === titleNorm) continue;
    if (paragraphs.length > 0 && norm(paragraphs[paragraphs.length - 1]) === tn) continue;
    paragraphs.push(t);
  }
  return { title, paragraphs };
}
