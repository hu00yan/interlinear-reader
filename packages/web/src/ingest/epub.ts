import type { Book, BookBlock, BookChapter, SourceLang } from "../types.js";

/** Resolve archive paths, never fetch remote/data URLs or allow archive-root escape. */
export function resolveEpubPath(baseFile: string, href: string): string | null {
  if (!href || /^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) return null;
  try {
    const path = decodeURIComponent(href.split(/[?#]/)[0]);
    if (path.startsWith("/") || path.includes("\\")) return null;
    const parts = baseFile.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  } catch {
    return null;
  }
}

/**
 * EPUB 解析：JSZip + 自写 XHTML 提取，保留章节段落。
 * 动态 import（首屏不打包 jszip），调用方：`const { parseEpub } = await import('../ingest/epub.js')`。
 */
export async function parseEpub(file: File, lang: SourceLang): Promise<Book> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);
  const getFile = (p: string) => zip.file(p);

  const containerXml = await getFile("META-INF/container.xml")?.async("text");
  if (!containerXml) throw new Error("无效 EPUB：缺少 META-INF/container.xml");
  const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
  const rootfile =
    containerDoc.querySelector("rootfile")?.getAttribute("full-path") ?? "OEBPS/content.opf";

  const opfXml = await getFile(rootfile)?.async("text");
  if (!opfXml) throw new Error(`无效 EPUB：缺少 ${rootfile}`);
  const opf = new DOMParser().parseFromString(opfXml, "application/xml");

  const title =
    opf.querySelector("metadata title")?.textContent?.trim() || file.name.replace(/\.epub$/i, "");

  const manifest = new Map<string, { href: string; props: string; media: string }>();
  opf.querySelectorAll("manifest item").forEach((it) => {
    const id = it.getAttribute("id") ?? "";
    const href = it.getAttribute("href") ?? "";
    manifest.set(id, {
      href: resolveEpubPath(rootfile, href) ?? "",
      props: (it.getAttribute("properties") ?? "").toLowerCase(),
      media: (it.getAttribute("media-type") ?? "").toLowerCase(),
    });
  });
  const spine: string[] = [];
  opf.querySelectorAll("spine itemref").forEach((r) => {
    // 跳过非线性 spine（linear=no 多为导航/封面）与 EPUB3 nav 文档
    if ((r.getAttribute("linear") ?? "").toLowerCase() === "no") return;
    const m = manifest.get(r.getAttribute("idref") ?? "");
    if (!m) return;
    if (m.props.includes("nav")) return;
    if (m.media.includes("nav") || m.media.includes("ncx")) return;
    if (/(^|\/)(nav|toc)\.x?html?$/i.test(m.href)) return;
    spine.push(m.href);
  });

  const mediaByPath = new Map([...manifest.values()].map((m) => [m.href, m.media]));
  const assets: Record<string, Blob> = Object.create(null);
  const chapters: BookChapter[] = [];
  for (let i = 0; i < spine.length; i++) {
    const path = spine[i];
    const f = getFile(path) ?? getFile(path.split("/").pop()!);
    if (!f) continue;
    const xhtml = await f.async("text");
    const { title: ct, paragraphs, blocks: extracted } = extractXhtml(xhtml);
    const blocks: BookBlock[] = [];
    for (const block of extracted) {
      if (block.kind === "p") {
        blocks.push(block);
        continue;
      }
      const src = resolveEpubPath(path, block.src);
      const media = src ? mediaByPath.get(src) : undefined;
      const entry = src ? getFile(src) : null;
      if (!src || !media?.startsWith("image/") || !entry) continue;
      if (!assets[src]) assets[src] = new Blob([await entry.async("arraybuffer")], { type: media });
      blocks.push({ ...block, src });
    }
    if (!blocks.length) continue;
    chapters.push({
      id: `ch${i + 1}`,
      title: ct || (paragraphs.length ? `Chapter ${i + 1}` : `插图 ${i + 1}`),
      paragraphs,
      blocks,
    });
  }
  if (chapters.length === 0) throw new Error("EPUB 未提取到正文段落");
  return { title, lang, chapters, source: "epub", assets };
}

/** 自写 XHTML 提取：h1-h3 作标题候选，p/h4-li 转段落，去 script/style，保留文本顺序 */
export function extractXhtml(xhtml: string): {
  title: string;
  paragraphs: string[];
  blocks: BookBlock[];
} {
  const doc = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  const err = doc.querySelector("parsererror");
  const root: Document = err
    ? new DOMParser().parseFromString(xhtml, "text/html")
    : (doc as unknown as Document);
  root
    .querySelectorAll("script, style, nav, header, footer, rt, rp, rtc")
    .forEach((n) => n.remove());
  const title =
    root.querySelector("h1")?.textContent?.trim() ||
    root.querySelector("h2")?.textContent?.trim() ||
    root.querySelector("title")?.textContent?.trim() ||
    "";
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  const raw: BookBlock[] = [];
  const blocks = new Set(["p", "h2", "h3", "h4", "li", "blockquote"]);
  let pending = "";
  const flush = (): void => {
    const t = pending.replace(/\s+/g, " ").trim();
    if (t) raw.push({ kind: "p", text: t });
    pending = "";
  };
  // 单次按 DOM 顺序遍历；嵌套块前后断段，不能再读取祖先的 textContent。
  const visit = (node: Node, inBlock = false): void => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      // Text or CDATA.
      if (inBlock) pending += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (tag === "img" || tag === "image") {
      flush();
      const src =
        el.getAttribute("src") ||
        el.getAttribute("href") ||
        el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (src)
        raw.push({
          kind: "img",
          src,
          alt: el.getAttribute("alt") || el.getAttribute("aria-label") || "",
        });
      return;
    }
    // h1 仍只作章节标题，不混进正文（包括 div 包裹的 h1）。
    if (tag === "h1") {
      flush();
      return;
    }
    const isBlock = blocks.has(tag);
    if (isBlock) flush();
    node.childNodes.forEach((child) => visit(child, inBlock || isBlock));
    if (isBlock) flush();
  };
  const body = root.querySelector("body");
  if (body) visit(body);
  else root.querySelectorAll("p").forEach((p) => visit(p));
  flush();
  // 去重：首段与标题同文（nav/title/heading 三处同文，z-lib 常见）去首段；
  // 连续同文段（heading+p 双写 Introduction）只留一段。
  const paragraphs: string[] = [];
  const titleNorm = title ? norm(title) : "";
  const ordered: BookBlock[] = [];
  for (const block of raw) {
    if (block.kind === "img") {
      ordered.push(block);
      continue;
    }
    const tn = norm(block.text);
    if (paragraphs.length === 0 && titleNorm && tn === titleNorm) continue;
    const prev = ordered[ordered.length - 1];
    if (prev?.kind === "p" && norm(prev.text) === tn) continue;
    paragraphs.push(block.text);
    ordered.push(block);
  }
  return { title, paragraphs, blocks: ordered };
}
