import type { Book, SourceLang } from '../types.js';

/** Markdown 预剥离（只处理会污染注出的结构；强调/标题符号本就不是词，无需动）。
 * 去：front-matter、围栏代码块（含内容）、行内代码（只留文字）、图片/链接（只留文字）、
 * 裸 URL、HTML 标签、表格竖线。返回可按 TXT 分段的纯文本。 */
export function stripMarkdown(text: string): string {
  let s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  s = s.replace(/^---\n[\s\S]*?\n---\n/, ''); // front-matter
  s = s.replace(/```[\s\S]*?(```|$)/g, ''); // 围栏代码块
  s = s.replace(/~~~[\s\S]*?(~~~|$)/g, '');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // 图片留 alt
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接留文字
  s = s.replace(/`([^`]+)`/g, '$1'); // 行内代码留文字
  s = s.replace(/https?:\/\/\S+/g, ''); // 裸 URL（注出来全是噪音）
  s = s.replace(/<[^>]+>/g, ''); // 内嵌 HTML
  s = s.replace(/\|/g, ' '); // 表格竖线
  s = s.replace(/^#{1,6}\s+/gm, ''); // 标题标记（# 本就不是词，顺手清）
  s = s.replace(/^>\s?/gm, ''); // 引用标记
  return s;
}

/** TXT/MD 导入：.md 先过 stripMarkdown；按空行分段，单换行并入同段，保留章节（整文件为一章）。 */
export function parseTxt(text: string, name: string, lang: SourceLang): Book {
  const src = /\.md$/i.test(name) ? stripMarkdown(text) : text;
  const clean = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) throw new Error('TXT 为空');
  return {
    title: name.replace(/\.(txt|md)$/i, ''),
    lang,
    source: 'txt',
    chapters: [{ id: 'ch1', title: name, paragraphs }],
  };
}
