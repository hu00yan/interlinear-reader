import type { Book, SourceLang } from '../types.js';

// Markdown 导入：marked 词法级解析（lexer token walk），替代正则暴力剥离。
// 方言覆盖由 marked 负责（GFM 表格/任务列表/删除线/脚注引用等，默认配置）。
// 取舍（诚实优先，不渲染）：
// - 围栏代码块/缩进代码：整块丢弃（代码逐词注全是噪音）。
// - 行内代码：留文字（术语常值得注，如 `raison d'être`）。
// - 链接/图片：只留文字/alt，URL 永不进正文。
// - 数学公式（$…$/$$…$$）：marked 不解析，原样保留显示；分词器把 $ \ 等当分隔符，
//   公式里的词多半诚实缺词（—），不编造、不渲染。KaTeX 不引入（首屏/懒加载预算）。
// - front-matter：marked 不管，入口处三行去掉（不是语法解析）。
// marked 本体经动态 import 进懒加载分片，首屏不打包（见调用方）。
export async function parseMarkdown(text: string, name: string, lang: SourceLang): Promise<Book> {
  const { marked } = await import('marked');
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const paras: string[] = [];
  const push = (t: string): void => {
    const c = t.replace(/\s+/g, ' ').trim();
    if (c.length > 0) paras.push(c);
  };
  const inline = (toks: Array<{ type?: string; text?: string; tokens?: unknown[] } | string> | undefined): string => {
    if (!toks) return '';
    let out = '';
    for (const t of toks) {
      if (typeof t === 'string') { out += t; continue; }
      switch (t.type) {
        case 'text':
        case 'escape':
          out += inline(t.tokens as never) || t.text || '';
          break;
        case 'strong':
        case 'em':
        case 'del':
        case 'codespan':
          out += inline(t.tokens as never);
          break;
        case 'link': {
          // 裸 URL 自动链接（autolink）直接丢弃；正常链接只留文字。
          const inner = inline(t.tokens as never);
          const href = (t as { href?: string }).href ?? '';
          out += inner && inner !== href ? inner : '';
          break;
        }
        case 'image':
          out += t.text || '';
          break;
        case 'br':
          out += ' ';
          break;
        case 'html':
          out += (t.text || '').replace(/<[^>]+>/g, '');
          break;
        default:
          out += t.text || '';
      }
    }
    return out;
  };
  const block = (toks: Array<{ type: string; text?: string; raw?: string; tokens?: never; items?: never; header?: never; rows?: never }>): void => {
    for (const t of toks) {
      switch (t.type) {
        case 'space':
        case 'hr':
        case 'code':
          break; // 代码块丢弃
        case 'heading':
        case 'paragraph':
          push(inline(t.tokens));
          break;
        case 'blockquote':
          block(t.tokens as never);
          break;
        case 'list':
          for (const it of (t.items ?? []) as Array<{ tokens?: never }>) {
            const parts: string[] = [];
            for (const st of (it.tokens ?? []) as typeof toks) {
              if ((st as { type: string }).type === 'text') parts.push(inline((st as { tokens?: never }).tokens));
              else if ((st as { type: string }).type === 'code') continue;
              else block([st as never]);
            }
            if (parts.length) push(parts.join(' '));
          }
          break;
        case 'table': {
          const tt = t as unknown as { header: Array<{ tokens?: Array<string | { type?: string; text?: string; tokens?: unknown[] }> }>; rows: Array<Array<{ tokens?: Array<string | { type?: string; text?: string; tokens?: unknown[] }> }>> };
          const row = (cells: Array<{ tokens?: Array<string | { type?: string; text?: string; tokens?: unknown[] }> }>): string =>
            cells.map((c) => inline(c.tokens)).join(' ');
          push(row(tt.header));
          for (const r of tt.rows) push(row(r));
          break;
        }
        case 'html':
          push((t.text || '').replace(/<[^>]+>/g, ''));
          break;
        default:
          if (t.text) push(inline((t as { tokens?: Parameters<typeof inline>[0] }).tokens) || t.text);
      }
    }
  };
  block(marked.lexer(src) as never);
  if (paras.length === 0) throw new Error('Markdown 为空');
  return {
    title: name.replace(/\.md$/i, ''),
    lang,
    source: 'txt',
    chapters: [{ id: 'ch1', title: name, paragraphs: paras }],
  };
}
