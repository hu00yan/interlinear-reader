import type { Book, SourceLang } from '../types.js';

/** TXT 导入：按空行分段，单换行并入同段，保留章节（整文件为一章）。
 * Markdown 走 ingest/markdown.ts（marked 词法解析，懒加载），不在此处。 */
export function parseTxt(text: string, name: string, lang: SourceLang): Book {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
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
