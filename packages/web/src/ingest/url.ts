import type { Book, SourceLang } from '../types.js';

/**
 * URL 网页正文提取（自写，无 readability 依赖，保持首屏小）。
 * 两级：浏览器直取（同源/CORS 放行站）→ r.jina.ai 公开代理（免 key 限流，
 * 返回 markdown，正好进 marked 链）。无自建服务端、无 Worker。
 * 代理是第三方（URL 会经过它），状态行明示；双败后指引粘贴/EPUB。
 */
export async function fetchArticle(
  url: string,
  lang: SourceLang,
): Promise<{ book: Book; via: 'direct' | 'proxy' }> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(target);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html: string = await resp.text();
    const paragraphs = extractArticle(html);
    if (paragraphs.length === 0) throw new Error('未提取到正文');
    return {
      book: {
        title: extractTitle(html) || url,
        lang,
        source: 'url',
        chapters: [{ id: 'ch1', title: 'Article', paragraphs }],
      },
      via: 'direct',
    };
  } catch (e) {
    const directErr = (e as Error).message;
    // 直取失败（多为目标站 CORS 拦截）→ 公开代理走 markdown 链。
    try {
      const proxy = await fetch(`https://r.jina.ai/${target}`);
      if (!proxy.ok) throw new Error(`代理 HTTP ${proxy.status}`);
      const md: string = await proxy.text();
      const { parseMarkdown } = await import('./markdown.js');
      // r.jina.ai 头部元数据行（Title:/URL Source:/…）不是正文，去掉。
      const body = md.replace(/^(Title|URL Source|Published Time|Markdown Content|Warning):[^\n]*\n?/gm, '');
      const book = await parseMarkdown(body, url, lang);
      const title = book.chapters[0]?.paragraphs[0]?.slice(0, 40) || url;
      return { book: { ...book, title }, via: 'proxy' };
    } catch {
      throw new Error(
        `抓取失败（直连：${directErr}；代理：r.jina.ai 不可用）。该站可能反爬——复制正文用“粘贴导入”，或下 EPUB 导入。`,
      );
    }
  }
}

export function extractTitle(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('title')?.textContent?.trim() ||
    ''
  );
}

/** 启发式：按 <p> 文本长度打分，取最长连续区块；去 nav/aside/广告 */
export function extractArticle(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, nav, header, footer, aside, form, button, [role="navigation"]').forEach((n) => n.remove());
  const ps = [...doc.querySelectorAll('article p, main p, p')].map((p) =>
    (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
  ).filter((t) => t.length >= 40);
  // 去重 + 截断防爆
  return [...new Set(ps)].slice(0, 500);
}
