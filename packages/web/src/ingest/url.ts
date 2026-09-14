import type { Book, SourceLang } from '../types.js';

/**
 * URL 网页正文提取（自写，无 readability 依赖，保持首屏小）。
 * 浏览器 fetch 受目标站 CORS 限制，失败时提示用户（Track D 可提供 Workers 代理，TODO）。
 */
export async function fetchArticle(url: string, lang: SourceLang): Promise<Book> {
  let html: string;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    throw new Error(`抓取失败（多为目标站 CORS 拦截）：${(e as Error).message}。TODO(依赖TrackD): Workers 代理抓取`);
  }
  const paragraphs = extractArticle(html);
  if (paragraphs.length === 0) throw new Error('未提取到正文');
  return {
    title: extractTitle(html) || url,
    lang,
    source: 'url',
    chapters: [{ id: 'ch1', title: 'Article', paragraphs }],
  };
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
