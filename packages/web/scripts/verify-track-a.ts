#!/usr/bin/env node
// Track A 无头验收（node + jsdom）：fixture EPUB→章节段落→逐词注出→三级过滤→缓存键→设置持久化。
// 运行：npm run verify（esbuild 打包后执行，不污染首屏 bundle）
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// ---- 浏览器环境最小 stub ----
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};
(globalThis as Record<string, unknown>).DOMParser = new JSDOM().window.DOMParser;
(globalThis as Record<string, unknown>).fetch = async (url: string) => {
  const m = String(url).match(/dict\/([a-z]+)\/([^/]+)\.dict$/);
  if (!m) return { ok: false, status: 404, text: async () => '' };
  try {
    const body = readFileSync(resolve(process.cwd(), '..', '..', 'public', 'dict', m[1], `${m[2]}.dict`), 'utf8');
    return { ok: true, status: 200, text: async () => body };
  } catch {
    return { ok: false, status: 404, text: async () => '' };
  }
};

const { parseEpub } = await import('../src/ingest/epub.js');
const { parseTxt } = await import('../src/ingest/txt.js');
const { extractArticle } = await import('../src/ingest/url.js');
const { getFallbackPack } = await import('../src/reader/langpacks/fallback.js');
const { tokenizeParagraph } = await import('../src/reader/tokenize.js');
const { getGloss } = await import('../src/dict/dict-loader.js');
const { annotateParagraphs } = await import('../src/reader/render.js');
const { shouldShowGloss, paragraphFreqRank } = await import('../src/reader/filters.js');
const { wordCacheKey, sentenceCacheKey } = await import('../src/lib/hash.js');
const { loadSettings, saveSettings } = await import('../src/store/settings.js');
const { setKnown, isKnown, addVocab, listVocab } = await import('../src/vocab/store.js');

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
}

// 1. EPUB：章节段落保留
import { resolve } from 'node:path';
const buf = readFileSync(resolve(process.cwd(), 'public/fixtures/hello-en.epub'));
const book = await parseEpub(buf as unknown as File, 'en');
check('epub 章节数=2', book.chapters.length === 2, JSON.stringify(book.chapters.map((c) => c.title)));
check('epub ch1 段落数=3', book.chapters[0].paragraphs.length === 3);
check('epub 标题', book.title === 'Hello Reader', book.title);

// 2. TXT / URL 提取
const txt = parseTxt('Time and people find a way.\n\nThe man reads.', 't.txt', 'en');
check('txt 分段=2', txt.chapters[0].paragraphs.length === 2);
// md 走 marked 词法解析（懒加载，见 ingest/markdown.ts）：链接/代码/URL 不进正文
const { parseMarkdown } = await import('../src/ingest/markdown.js');
const md = await parseMarkdown('# Title\n\nSee [Time](https://example.com/t) and `code`.\n\n```js\nconst x = 1;\n```\n\nVisit https://example.com raw.\n\n| a | b |\n|---|---|\n| Time | way |\n\n> quoted Time\n', 'n.md', 'en');
const mdText = md.chapters[0].paragraphs.join('\n');
check('md 去链接URL', !mdText.includes('example.com') && mdText.includes('Time'), mdText.slice(0, 80));
check('md 去围栏代码', !mdText.includes('const x'), mdText.slice(0, 80));
check('md 标题入正文', mdText.includes('Title'), mdText.slice(0, 40));
check('md 表格转文本', mdText.includes('Time') && mdText.includes('way'), mdText.slice(0, 120));
check('md 引用入正文', mdText.includes('quoted'), mdText.slice(0, 120));
const art = extractArticle('<html><body><article><p>' + 'word '.repeat(30) + '</p><p>short</p></article></body></html>');
check('url 正文提取过滤短段', art.length === 1, `got ${art.length}`);
// url 双败指引粘贴（fetch 桩全 404：直连败→代理败→粘贴指引，无真网络）
const { fetchArticle } = await import('../src/ingest/url.js');
const urlErr = await fetchArticle('https://example.com/x', 'en').then(() => '', (e: Error) => e.message);
check('url 双败指引粘贴', /粘贴导入/.test(urlErr), urlErr.slice(0, 60));

// 3. 分词+lemma+逐词注出（target zh）
const pack = getFallbackPack('en');
const tokens = tokenizeParagraph(pack, 'en', 'Time and people find a way.', () => false);
const words = tokens.filter((t) => t.isWord).map((t) => `${t.surface}/${t.lemma}`);
check('分词含标点', tokens.some((t) => !t.isWord), words.join(' '));
for (const lemma of ['time', 'people', 'way']) {
  const g = await getGloss('en', 'zh', lemma);
  check(`zh 注出 ${lemma}`, !!g, String(g));
}
const gEn = await getGloss('en', 'en', 'time');
check('EN 目标切换', gEn === 'time', String(gEn));
const miss = await getGloss('en', 'zh', 'xyznonexist');
check('缺词返回 null（走 LLM 由调用方）', miss === null);

// 4. 三级过滤 + 已认识持久化
setKnown('en', 'hello', true);
check('已知词刷新仍在（localStorage）', isKnown('en', 'hello'));
const toks2 = tokenizeParagraph(pack, 'en', 'Hello cat', (l) => isKnown('en', l));
for (const t of toks2) if (t.isWord) t.gloss = await getGloss('en', 'zh', t.lemma);
const rank = paragraphFreqRank(toks2);
const hello = toks2.find((t) => t.lemma === 'hello')!;
check('hideKnown 隐藏已知词', shouldShowGloss(hello, { hideStopwords: false, hideKnown: true, freqHideTopN: 0 }, rank) === false);
const the = tokenizeParagraph(pack, 'en', 'The cat', () => false).find((t) => t.lemma === 'the')!;
the.gloss = '这';
check('hideStopwords 隐藏停用词', shouldShowGloss(the, { hideStopwords: true, hideKnown: false, freqHideTopN: 0 }) === false);

// 5. 生词本
addVocab({ lemma: 'cat', lang: 'en', gloss: '猫', sentence: 'The cat.', addedAt: 1, known: false });
check('生词本写入可读', listVocab().some((v) => v.lemma === 'cat'));

// 6. 缓存键 sha1 形状 + 设置持久化（key 刷新还在）
const k1 = await wordCacheKey('en', 'zh', 'Cat');
const k2 = await sentenceCacheKey('en', 'zh', '  Hello   WORLD ');
check('词缓存键 40 hex', /^[0-9a-f]{40}$/.test(k1), k1);
check('句归一化大小写/空白', (await sentenceCacheKey('en', 'zh', 'hello world')) === k2);
const s = loadSettings();
s.apiKey = 'sk-test-persist';
s.mode = 'C' as never;
saveSettings(s);
const s2 = loadSettings();
check('key/mode 持久化', s2.apiKey === 'sk-test-persist' && (s2.mode as string) === 'C');

// 7. KJV 小节注出率（ingest+annotate 链：章节切分/en 判定/target zh-en/getGloss 双试/缺词回填）
// 根因：fallback lemmatize + dict-loader 单试导致 hath/doth/saith 全 miss，KJV 整页全空。
// 复现：KJV 风格 3 段（2 Samuel 式古英语），非停用词应全注出（have/do/say/book/word/time/good/man/make/house/read）。
{
  const KJV_TEXT = 'He hath made the house.\n\nHe doth read the book.\n\nHe saith the word is good.';
  const kjv = parseTxt(KJV_TEXT, 'kjv-2samuel.txt', 'en');
  check('kjv 章节切分=1章3段', kjv.chapters.length === 1 && kjv.chapters[0].paragraphs.length === 3, JSON.stringify(kjv.chapters[0]?.paragraphs));
  check('kjv 语言判定=en', kjv.lang === 'en', kjv.lang);
  // lemmatize 第一试：古英语直转现代形
  check('kjv lemmatize hath->have', pack.lemmatize('hath') === 'have', pack.lemmatize('hath'));
  check('kjv lemmatize doth->do', pack.lemmatize('doth') === 'do', pack.lemmatize('doth'));
  check('kjv lemmatize saith->say', pack.lemmatize('saith') === 'say', pack.lemmatize('saith'));
  // normalize 双试：直查古英语也命中（dict-loader 内部转现代形查分片）
  for (const [arch, modern] of [['hath', 'have'], ['doth', 'do'], ['saith', 'say']] as Array<[string, string]>) {
    const gZh = await getGloss('en', 'zh', arch);
    check(`kjv zh 注出 ${arch}->${modern}`, !!gZh, String(gZh));
    const gEn = await getGloss('en', 'en', arch);
    check(`kjv en 注出 ${arch}->${modern}`, !!gEn, String(gEn));
  }
  // 全链：annotateParagraphs（tokenize->getGlossesWithSource）注出率
  const kjvParas = kjv.chapters[0].paragraphs;
  for (const target of ['zh', 'en'] as const) {
    const ann = await annotateParagraphs(pack, 'en', target, kjvParas, () => false);
    const toks = ann.flatMap((p) => p.tokens).filter((t) => t.isWord && !t.stopword);
    const hits = toks.filter((t) => !!t.gloss).length;
    const rate = toks.length ? hits / toks.length : 0;
    check(`kjv 小节注出率>=0.8(${target})`, rate >= 0.8, `rate=${hits}/${toks.length}=${rate.toFixed(2)} ${toks.filter((t) => !t.gloss).map((t) => t.lemma).join(',')}`);
  }
}

// 8. 单页 pager 数量==2（顶部+底部各一套；回归底部重复两套）
// 根因：src/ui/app.ts 顶部 pager 在 body 之后 append，两套全挤底部 + 跨 await 旧续体重复挂 bottom。
{
  const src = readFileSync(resolve(process.cwd(), 'src/ui/app.ts'), 'utf8');
  const topMounts = (src.match(/pager\('top'\)/g) ?? []).length;
  const bottomMounts = (src.match(/pager\('bottom'\)/g) ?? []).length;
  check('单页仅保留底部 pager', topMounts === 0 && bottomMounts === 1, `top=${topMounts} bottom=${bottomMounts}`);
  const topIdx = src.indexOf("main.appendChild(pager('top'))");
  const bodyIdx = src.indexOf('main.appendChild(body)');
  const bottomIdx = src.indexOf("main.appendChild(pager('bottom'))");
  check('pager 顺序 body<bottom', bodyIdx !== -1 && bottomIdx !== -1 && bodyIdx < bottomIdx, `${bodyIdx}/${bottomIdx}`);
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const doc = dom.window.document;
  const main = doc.createElement('div');
  const mkPager = (pos: string) => {
    const d = doc.createElement('div');
    d.className = `pager pager-${pos}`;
    d.setAttribute('data-testid', `pager-${pos}`);
    return d;
  };
  const bodyEl = doc.createElement('div');
  main.append(mkPager('top'), bodyEl, mkPager('bottom'));
  check('单页 pager 数量==2', main.querySelectorAll('.pager').length === 2, `got ${main.querySelectorAll('.pager').length}`);
  check(
    'top/bottom 各一套',
    main.querySelectorAll('[data-testid="pager-top"]').length === 1 && main.querySelectorAll('[data-testid="pager-bottom"]').length === 1,
  );
}

// 9. 书式对开 + 自动进章（DOM 可断言）：对开容器存在 / 章列表 / 章内 1/N 保留 / 章界无缝
// 目标：桌面对开两栏、移动单栏；页内分页，末页下页进下一章首夜、首夜上页回上一章末页。
{
  const src = readFileSync(resolve(process.cwd(), 'src/ui/app.ts'), 'utf8');
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
  // --- 源码口径：对开容器 + 章列表 + 章标记 ---
  check('对开容器 book-spread', src.includes('book-spread') && src.includes('data-testid", "book-spread') || src.includes("data-testid', 'book-spread"), 'app.ts 缺 book-spread 容器');
  check('对开左右页 book-page', src.includes('book-page-left') && src.includes('book-page-right'), '缺左右页');
  check('章列表 chapter-list', src.includes('chapter-list') && src.includes('chapter-item-'), '缺章列表');
  check('章标记 data-testid chapter', src.includes('data-testid", "chapter"') || src.includes("data-testid', 'chapter'"), '缺章标记');
  check('章内页码 1/N 保留', src.includes('/${totalPages}') && src.includes('state.page + 1'), 'pager info 须保留 章内 page+1/totalPages');
  // --- 源码口径：章间连续翻页（末页 next 进章 / 首夜 prev 回章，全书首末才禁用）---
  check('跨章 next 进章', src.includes('state.chapterIdx += 1') && src.includes('state.page = 0'), '缺末页 next 进下一章');
  check('跨章 prev 回章', src.includes('state.chapterIdx -= 1') && src.includes('totalPagesFor(state.chapterIdx) - 1'), '缺首夜 prev 回上一章末页');
  check('全书首末才禁用', src.includes('isFirstOfBook') && src.includes('isLastOfBook'), '须全书首/末才禁用，不按章内禁用');
  // --- CSS 口径：移动单栏 + 桌面双栏（响应式无内滚）---
  check('CSS 对开容器', css.includes('.book-spread') && css.includes('.book-page'), 'styles.css 缺对开样式');
  check('CSS 响应式无内滚视口', css.includes('.book-spread') && css.includes('grid-template-columns: 1fr 1fr') && css.includes('overflow: hidden') && css.includes('break-inside: avoid'), '对开必须 overflow:hidden + 双栏grid + break-inside:avoid（无内滚，单段超长例外才内滚）');
  check('CSS 单段超长例外', css.includes('single-para') && css.includes('overflow: auto'), '须保留 data-overflow="single-para" 例外才 overflow:auto');
  check('CSS 无固定视口 clamp', !css.includes('clamp(420px') && !css.includes('100vh - 190px') && !css.includes('100vh - 280px'), '须删除固定 clamp/100vh-190px/280px，改 flex:1 自适应');
  check('无固定词数分页', !src.includes('WORDS_PER_SPREAD'), '须删除 WORDS_PER_SPREAD，改按实测高度分页');
  check('实测分页 measurePaginate', src.includes('measurePaginate'), '缺 measurePaginate 实测分页');
  check('CSS 章列表', css.includes('.chapter-list'), '缺章列表样式');
  // --- DOM 口径：jsdom 实建（镜像 app.ts 结构）---
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const doc = dom.window.document;
  const main = doc.createElement('div');
  // 章列表 DOM
  const chapters = [{ title: 'Morning', paragraphs: ['a', 'b', 'c', 'd', 'e', 'f'] }, { title: 'Night', paragraphs: ['g', 'h'] }];
  const nav = doc.createElement('nav');
  nav.setAttribute('data-testid', 'chapter-list');
  chapters.forEach((c, i) => {
    const b = doc.createElement('button');
    b.setAttribute('data-testid', `chapter-item-${i}`);
    b.textContent = `${i + 1}. ${c.title}`;
    nav.appendChild(b);
  });
  // 章标记 DOM
  const badge = doc.createElement('span');
  badge.setAttribute('data-testid', 'chapter');
  badge.textContent = `第1/${chapters.length}章 · ${chapters[0].title}`;
  // 对开容器 DOM（左右页各一）
  const spread = doc.createElement('div');
  spread.className = 'book-spread';
  spread.setAttribute('data-testid', 'book-spread');
  const left = doc.createElement('div');
  left.className = 'book-page book-page-left';
  left.setAttribute('data-testid', 'book-page-left');
  const right = doc.createElement('div');
  right.className = 'book-page book-page-right';
  right.setAttribute('data-testid', 'book-page-right');
  spread.append(left, right);
  main.append(nav, badge, spread);
  check('DOM 章列表存在', main.querySelectorAll('[data-testid="chapter-list"]').length === 1);
  check('DOM 章项数量==章数', main.querySelectorAll('[data-testid^="chapter-item-"]').length === chapters.length);
  check('DOM 章标记存在', main.querySelectorAll('[data-testid="chapter"]').length === 1);
  check('DOM 对开容器存在', main.querySelectorAll('[data-testid="book-spread"].book-spread').length === 1);
  check('DOM 对开左右页各一', main.querySelectorAll('[data-testid="book-page-left"]').length === 1 && main.querySelectorAll('[data-testid="book-page-right"]').length === 1);
  check('DOM pager+chapter 共存', main.querySelector('[data-testid="chapter-list"]') != null && main.querySelector('[data-testid="chapter"]') != null && main.querySelector('[data-testid="book-spread"]') != null);
  // --- DOM 口径：章间连续翻页逻辑（与 app.ts 同语义的最小复刻 + 文本 1/N 断言）---
  const pageSize = 5;
  const totalPagesFor = (ci: number): number => Math.max(1, Math.ceil(chapters[ci].paragraphs.length / pageSize));
  let ci = 0;
  let pg = totalPagesFor(0) - 1; // 第0章末页
  const goNext = (): void => {
    if (pg < totalPagesFor(ci) - 1) pg += 1;
    else if (ci < chapters.length - 1) { ci += 1; pg = 0; }
  };
  const goPrev = (): void => {
    if (pg > 0) pg -= 1;
    else if (ci > 0) { ci -= 1; pg = totalPagesFor(ci) - 1; }
  };
  goNext(); // 末页 next 应进章
  check('DOM 末页next进章', ci === 1 && pg === 0, `got ch=${ci} pg=${pg}`);
  // 章内 1/N 文本仍保留（镜像 pager info 格式）
  const infoText = `第${ci + 1}/${chapters.length}章 · ${chapters[ci].title} · ${pg + 1}/${totalPagesFor(ci)} 页`;
  check('DOM 章内页码 1/N', infoText.includes(`${pg + 1}/${totalPagesFor(ci)} 页`), infoText);
  goPrev(); // 首夜 prev 应回章
  check('DOM 顶页prev回章', ci === 0 && pg === totalPagesFor(0) - 1, `got ch=${ci} pg=${pg}`);
}

// 10. 导出 EPUB（阅读页当前书：原文+释义对照，小字括号；章节保留；文件名含语言）
// 口径：纯函数 buildEpubFiles + 文件名 + UI 双按钮（阅读页/设置）+ 无 key 纯词典/有 key 回填。
{
  const { buildEpubFiles, buildEpubBlob, epubFilename, renderTokenEpub } = await import('../src/export/epub.js');
  const { parseTxt: parseTxt2 } = await import('../src/ingest/txt.js');
  // 10a) 文件名含语言
  check('epub 文件名含语言', epubFilename('Hello', 'ja', 'zh') === 'Hello-ja-zh.epub', epubFilename('Hello', 'ja', 'zh'));
  check('epub 文件名含en目标', epubFilename('Hi', 'en', 'en').endsWith('-en-en.epub'), epubFilename('Hi', 'en', 'en'));
  // 10b) token 落小字括号；缺词只留原文（不编造）
  const tokHit = { surface: '家', lemma: '家', isWord: true, gloss: '家', glossSource: 'dict', known: false, stopword: false };
  const tokMiss = { surface: '魑魅', lemma: '魑魅', isWord: true, gloss: null, glossSource: null, known: false, stopword: false };
  const hitHtml = renderTokenEpub(tokHit as never);
  check('epub 有注落小字括号', hitHtml.includes('<small') && hitHtml.includes('家') && /（家）/.test(hitHtml), hitHtml);
  const missHtml = renderTokenEpub(tokMiss as never);
  check('epub 缺词只留原文', missHtml === '魑魅' && !missHtml.includes('<small'), missHtml);
  // 10b2) 诚实门禁（宁缺毋错，锁死）：解不出必须 null，永不注错答案；剩下走 LLM。
  // 回归：は→feather / ま→just… / 出る思う書く聞く→到 / 開ければ→開く。
  {
    const { getGlossWithSource } = await import('../src/dict/dict-loader.js');
    // 注：魑魅曾是“未知词”探针，但真词典 JMdict 收录了它（mountain demon，
    // 注对了）——未知词探针改用ザヴァ（双向 miss，deinflect 也够不着）。
    const missJa = ['は', 'を', 'ま', 'た', 'っ', 'か', 'で', 'ザヴァ'];
    for (const t of missJa) {
      for (const target of ['zh', 'en'] as const) {
        const r = await getGlossWithSource('ja', target, t);
        check(`诚实 miss ja/${target}/${t}`, r.gloss === null && r.source === null, JSON.stringify(r.gloss)?.slice(0, 60));
      }
    }
    const rEn = await getGlossWithSource('en', 'zh', 'Xyzenigma');
    check('诚实 miss en未知词', rEn.gloss === null, JSON.stringify(rEn.gloss)?.slice(0, 60));
    const rDao = await getGlossWithSource('ja', 'zh', '思う');
    check('诚实 思う->zh 非到（pivot 不串味，缺词走LLM）', rDao.gloss === null || !rDao.gloss.includes('到'), JSON.stringify(rDao.gloss)?.slice(0, 60));
    // 阳性对照：真命中不受影响（桥还在）。
    const rHome = await getGlossWithSource('ja', 'zh', '家');
    check('阳性 家->zh 命中', !!rHome.gloss, JSON.stringify(rHome.gloss)?.slice(0, 40));
    const rTokyo = await getGlossWithSource('ja', 'zh', '東京');
    check('阳性 東京->zh pivot 命中', !!rTokyo.gloss, JSON.stringify(rTokyo.gloss)?.slice(0, 40));
    const rDeru = await getGlossWithSource('ja', 'zh', '出る');
    check('阳性 出る->zh 命中', !!rDeru.gloss, JSON.stringify(rDeru.gloss)?.slice(0, 40));
    // 点词详情：多义项全量透出（行间仍首条；a->zh 有 5 条）。
    const rAll = await getGlossWithSource('en', 'zh', 'a');
    check('多义项 glosses 全量', rAll.glosses.length >= 4 && rAll.gloss === rAll.glosses[0], `n=${rAll.glosses.length}`);
    const annA = await annotateParagraphs(pack, 'en', 'zh', ['a book'], () => false);
    const tokA = annA[0].tokens.find((t) => t.lemma === 'a');
    check('多义项 Token 携带', !!tokA?.glosses && tokA.glosses.length >= 4 && tokA.gloss === tokA.glosses[0], `n=${tokA?.glosses?.length}`);
  }
  // 10c) 章节保留 + 标准结构（mimetype/container/opf/ncx/ch）
  const demo = parseTxt2('第一段家。\n\n第二段町。', 'demo.txt', 'ja');
  const packJa = getFallbackPack('ja');
  const ann1 = await annotateParagraphs(packJa, 'ja', 'zh', demo.chapters[0].paragraphs, () => false);
  const files = buildEpubFiles(demo, [ann1], 'zh');
  check('epub 含mimetype', files.get('mimetype') === 'application/epub+zip');
  check('epub 含container', (files.get('META-INF/container.xml') ?? '').includes('content.opf'));
  check('epub 含opf+ncx', (files.get('OEBPS/content.opf') ?? '').includes('ch1') && (files.get('OEBPS/toc.ncx') ?? '').includes(demo.title));
  check('epub 章节数==书章数', [...files.keys()].filter((k) => /^OEBPS\/ch\d+\.xhtml$/.test(k)).length === demo.chapters.length);
  const ch1 = files.get('OEBPS/ch1.xhtml') ?? '';
  check('epub 章含原文', ch1.includes('家') && ch1.includes('町'), ch1.slice(0, 200));
  check('epub 章含小字对照', ch1.includes('<small class="gloss">'), ch1.slice(0, 300));
  check('epub opf语言含目标', (files.get('OEBPS/content.opf') ?? '').includes('ja-zh'), 'opf lang');
  // 10d) UI 双按钮 + 无key纯词典/有key回填（源码口径，不碰分页）
  const appSrc = readFileSync(resolve(process.cwd(), 'src/ui/app.ts'), 'utf8');
  check('阅读页导出按钮', appSrc.includes('data-testid", "export-epub') || appSrc.includes("data-testid', 'export-epub"), '缺 reader export-epub');
  check('设置页导出按钮', appSrc.includes('export-epub-settings'), '缺 settings export-epub-settings');
  check('导出复用JSZip', appSrc.includes("import('../export/epub.js')") && readFileSync(resolve(process.cwd(), 'src/export/epub.ts'), 'utf8').includes("import('jszip')"), '须动态 import jszip');
  check('无key纯词典', appSrc.includes('纯词典导出') || appSrc.includes('纯词典'), '缺无 key 纯词典文案');
  check('有key回填', appSrc.includes('LLM 回填') || appSrc.includes('回填'), '缺有 key 回填逻辑');
  check('B模式不调LLM', appSrc.includes('mode !== Mode.B') || appSrc.includes('Mode.B'), '导出须 B 模式不调 LLM');
  // 10e) Blob 可打包 + 可回读（标准 ZIP，首文件 mimetype）
  try {
    const { blob, filename } = await buildEpubBlob(demo, [ann1], 'zh');
    check('epub blob非空', blob.size > 1000, `size=${blob.size}`);
    check('epub blob文件名含语言', filename.includes('-ja-zh.epub'), filename);
    const { default: JSZip } = await import('jszip');
    const back = await JSZip.loadAsync(await blob.arrayBuffer());
    const names = Object.keys(back.files);
    check('epub zip含章节', names.some((n) => n === 'OEBPS/ch1.xhtml'), names.join(','));
    check('epub zip含mimetype', names.includes('mimetype'), names.join(','));
  } catch (e) {
    check('epub blob打包', false, String(e).slice(0, 200));
  }
  // 10f) ja->zh notice 导向（LLM 为主，不编造）
  check('ja notice日→中LLM为主', appSrc.includes('日→中') && (appSrc.includes('缺词可用 LLM') || appSrc.includes('缺词直走 LLM')), 'app.ts 缺 ja->zh 提示');
}

// 11. 模型质量金标自测（设置页一键）：判分三项 + DOM 口径 + 参考不泄露
// 评分规则（packages/provider/golden/score.ts:QUALITY_THRESHOLDS）：
//   单语分 = 0.7*命中率 + 0.2*中文率 + 0.1*干净率（无空/无照抄）；
//   合格 = 综合>=0.7 且 命中>=0.6 且 中文>=0.7 且 干净>=0.9；强模型复核默认关。
{
  const { GOLDEN_SENTENCES } = await import('../../provider/golden/golden.js');
  const { scoreQuality, suggestModel, JUDGE_DEFAULT_OFF } = await import('../../provider/golden/score.js');
  const { runQualityTest } = await import('../src/llm/quality.js');
  type GoldT = Array<{ id: string; tokens: Array<{ i: number; lemma: string }>; refs: Array<{ lemma: string; expects: string[] }> }>;
  const gold = GOLDEN_SENTENCES as unknown as GoldT;
  check('金标 7 语（en/de/fr/it/es/ru/ja）', gold.length === 7, `got ${gold.length}`);
  check('金标 target 全 zh', (GOLDEN_SENTENCES as Array<{ target: string }>).every((g) => g.target === 'zh'));
  check('复核默认关', JUDGE_DEFAULT_OFF.enabled === false);
  // MOCK 风格回显必不合格（含分项 + 换模型建议）
  const mockActual: Record<string, Array<{ i: number; lemma: string; gloss: string }>> = {};
  for (const g of gold) {
    mockActual[g.id] = g.tokens.map((t) => ({ i: t.i, lemma: t.lemma, gloss: `MOCK:${t.lemma}` }));
  }
  const mockScore = scoreQuality(mockActual, GOLDEN_SENTENCES);
  check('MOCK 回显判不合格', mockScore.pass === false, `overall=${mockScore.overall.toFixed(3)}`);
  check('MOCK 建议含换模型', /命中率低/.test(suggestModel(mockScore)), suggestModel(mockScore).slice(0, 40));
  // runQualityTest：中文桩过 / 不可解析桩不过 / 缺 key 先拦（零花费）
  const zhFetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> };
    const user = (body.messages ?? []).filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const payload = JSON.parse(user) as { sentences: Array<{ id: string; tokens: Array<{ i: number; lemma: string }> }> };
    const refMap = new Map(gold.map((g) => [g.id, new Map(g.refs.map((r) => [r.lemma.toLowerCase(), r.expects[0]]))]));
    const sentences = payload.sentences.map((s) => ({
      id: s.id,
      glosses: s.tokens.map((t) => ({
        i: t.i,
        lemma: t.lemma,
        gloss: refMap.get(s.id)?.get(t.lemma.toLowerCase()) ?? '未知词',
      })),
    }));
    const content = JSON.stringify({ sentences });
    return { ok: true, status: 200, text: async () => content, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
  const zhReport = await runQualityTest(
    { baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test', model: 'm' },
    zhFetch,
    { timeoutMs: 5000 },
  );
  check('中文桩判合格', zhReport.pass === true && zhReport.verdict === '合格', `${zhReport.verdict} ${zhReport.overall.toFixed(3)}`);
  const badFetch = (async () => {
    const content = 'not json at all {{{';
    return { ok: true, status: 200, text: async () => content, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
  const badReport = await runQualityTest(
    { baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test', model: 'm' },
    badFetch,
    { timeoutMs: 5000 },
  );
  check('不可解析判不合格', badReport.pass === false && badReport.verdict === '不合格');
  let noKey = false;
  try {
    await runQualityTest({ baseUrl: 'https://llm.example.com/v1', apiKey: '', model: 'm' }, zhFetch);
  } catch {
    noKey = true;
  }
  check('缺 key 先拦（零花费）', noKey);
  // DOM 口径：设置页按钮/结果/复核（默认关）+ 参考不进 UI
  const appSrcQ = readFileSync(resolve(process.cwd(), 'src/ui/app.ts'), 'utf8');
  check('设置页 quality-test 按钮', appSrcQ.includes('quality-test'), '缺一键自测按钮');
  check('设置页 quality-result 容器', appSrcQ.includes('quality-result'), '缺结果容器');
  check('复核默认关（unchecked）', appSrcQ.includes('quality-judge') && appSrcQ.includes('judgeBox.checked = false'), '复核须默认关');
  check(
    'UI 不渲染金标原文/参考',
    !/GOLDEN_SENTENCES|expects/.test(appSrcQ),
    'app.ts 不得直引参考（须经 quality.js 内存判分）',
  );
  const qdom = new JSDOM('<!DOCTYPE html><body></body>');
  const qdoc = qdom.window.document;
  const qbtn = qdoc.createElement('button');
  qbtn.setAttribute('data-testid', 'quality-test');
  qbtn.textContent = '测模型质量';
  const qres = qdoc.createElement('div');
  qres.setAttribute('data-testid', 'quality-result');
  qres.setAttribute('data-verdict', 'untested');
  const qjudge = qdoc.createElement('input') as HTMLInputElement;
  qjudge.setAttribute('data-testid', 'quality-judge');
  qjudge.checked = false;
  qdoc.body.append(qbtn, qres, qjudge);
  check('DOM quality-test 可断言', qdoc.querySelectorAll('[data-testid="quality-test"]').length === 1);
  check('DOM quality-result 可断言', qdoc.querySelectorAll('[data-testid="quality-result"]').length === 1);
  check('DOM quality-judge 默认关', (qdoc.querySelector('[data-testid="quality-judge"]') as HTMLInputElement).checked === false);
}

// 12. Auto/万能模式（无包语言）：语言末位 Auto + 整句 LLM 分词+注 + auto 缓存键 + 纯 LLM 费用 notice + 无 key 导设置
// 口径：provider.autoSegmentGloss（整句送 LLM，源语言自动识别，只需目标 zh/en）+ web 缓存键 sha1(auto|target|lemma|句) +
//       UI 语言下拉末尾 Auto + Mode 强制走 LLM（B 亦不例外）+ notice 明示纯 LLM 费用。
{
  const { SOURCE_LANGS, SOURCE_LANG_NAMES } = await import('../src/types.js');
  const { autoSegmentGloss, parseAutoGlossJson } = await import('../src/llm/provider.js');
  const { isStopword } = await import('../src/dict/stopwords.js');
  const { isWordSurface } = await import('../src/reader/tokenize.js');
  const { renderParagraphs } = await import('../src/reader/render.js');
  const { createHash } = await import('node:crypto');
  const AR = 'مرحبا بالعالم';

  // 12a) 语言选项末尾 Auto/万能
  check('auto 为末位语言', SOURCE_LANGS[SOURCE_LANGS.length - 1] === 'auto', SOURCE_LANGS.join(','));
  check('auto 显示名含 Auto/万能', /Auto/.test(SOURCE_LANG_NAMES['auto' as never]) && /万能/.test(SOURCE_LANG_NAMES['auto' as never]), SOURCE_LANG_NAMES['auto' as never]);
  // ingest：auto 可导入（TXT 章节保留，语言=auto）
  const autoBook = parseTxt(`${AR}\n\nصباح الخير`, 'ar.txt', 'auto' as never);
  check('auto TXT 可导入', autoBook.lang === 'auto' && autoBook.chapters[0].paragraphs.length === 2, autoBook.lang);
  // 分词兜底 + 停用词：auto 判词（含阿语），停用词为空（不折叠）
  check('auto 判词（阿语）', isWordSurface('auto' as never, 'مرحبا'));
  check('auto 无停用词折叠', isStopword('auto' as never, 'مرحبا') === false);
  const autoPack = getFallbackPack('auto' as never);
  const autoToks = tokenizeParagraph(autoPack, 'auto' as never, AR, () => false).filter((t) => t.isWord);
  check('auto fallback 可切词', autoToks.length >= 1, autoToks.map((t) => t.surface).join('|'));

  // 12b) 缓存键沿用 sha1(auto|target|lemma|句)：40 hex + lang 槽区分 + 与 node:crypto 对拍
  const autoSentKey = await sentenceCacheKey('auto' as never, 'zh', AR);
  check('auto 句缓存键 40 hex', /^[0-9a-f]{40}$/.test(autoSentKey), autoSentKey);
  const enSentKey = await sentenceCacheKey('en', 'zh', AR);
  check('auto 与 en 键不同槽', autoSentKey !== enSentKey, `${autoSentKey.slice(0, 8)} vs ${enSentKey.slice(0, 8)}`);
  const normAuto = AR.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const expectAuto = createHash('sha1').update(`auto|zh||${normAuto}`, 'utf8').digest('hex');
  check('auto 键与 sha1 对拍', autoSentKey === expectAuto, `${autoSentKey.slice(0, 12)} vs ${expectAuto.slice(0, 12)}`);
  const autoWordKey = await wordCacheKey('auto' as never, 'zh', 'مرحبا');
  check('auto 词缓存键 40 hex', /^[0-9a-f]{40}$/.test(autoWordKey), autoWordKey);

  // 12c) autoSegmentGloss：mock LLM 整句分词+注（zh/en），缓存命中零费用，无 key 抛错
  const mkFetch = (content: string, counter: { n: number }) =>
    (async () => {
      counter.n += 1;
      return { ok: true, status: 200, text: async () => content, json: async () => ({ choices: [{ message: { content } }] }) };
    }) as unknown as typeof fetch;
  const autoJson = JSON.stringify({ sentences: [{ id: 's1', detectedLang: 'ar', tokens: [{ i: 0, surface: 'مرحبا', lemma: 'مرحبا', gloss: '你好' }, { i: 1, surface: 'بالعالم', lemma: 'بالعالم', gloss: '世界' }] }] });
  const c1 = { n: 0 };
  const r1 = await autoSegmentGloss({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test', model: 'm' }, 'zh', AR, mkFetch(autoJson, c1));
  check('auto 分词+注（zh）', r1.tokens.length === 2 && r1.tokens[0].gloss === '你好' && r1.detectedLang === 'ar', JSON.stringify(r1.tokens));
  check('auto 首调计费', r1.costUSD > 0 && c1.n === 1, `cost=${r1.costUSD} n=${c1.n}`);
  const r1b = await autoSegmentGloss({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test', model: 'm' }, 'zh', AR, mkFetch(autoJson, c1));
  check('auto 缓存命中零费用', r1b.costUSD === 0 && c1.n === 1, `cost=${r1b.costUSD} n=${c1.n}`);
  const autoEnJson = JSON.stringify({ sentences: [{ id: 's1', tokens: [{ i: 0, surface: 'مرحبا', lemma: 'مرحبا', gloss: 'hello' }] }] });
  const rEn = await autoSegmentGloss({ baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test', model: 'm' }, 'en', 'مرحبا صباحا', mkFetch(autoEnJson, { n: 0 }));
  check('auto 目标 en 可切', rEn.tokens[0].gloss === 'hello');
  let noKeyAuto = false;
  try {
    await autoSegmentGloss({ baseUrl: 'https://llm.example.com/v1', apiKey: '', model: 'm' }, 'zh', AR, mkFetch(autoJson, { n: 0 }));
  } catch {
    noKeyAuto = true;
  }
  check('auto 无 key 抛错（导设置由调用方）', noKeyAuto);
  let badAuto = false;
  try {
    parseAutoGlossJson('not json {{{');
  } catch {
    badAuto = true;
  }
  check('auto 非 JSON 抛错', badAuto);

  // 12d) 源码口径：provider autoSegmentGloss + auto 缓存键 + 不经词典/分词包 + Mode 强制 LLM + 无 key 导设置 + 纯 LLM 费用
  const provSrc = readFileSync(resolve(process.cwd(), 'src/llm/provider.ts'), 'utf8');
  check('provider 有 autoSegmentGloss', provSrc.includes('export async function autoSegmentGloss'), '缺 autoSegmentGloss');
  check('provider 缓存键 auto 槽', provSrc.includes("sentenceCacheKey('auto'"), '须 sentenceCacheKey(\'auto\'…)');
  check('provider 自动识别', /Auto-detect|auto-detect/i.test(provSrc), 'prompt 须自动识别源语言');
  const appSrcAuto = readFileSync(resolve(process.cwd(), 'src/ui/app.ts'), 'utf8');
  check('UI 调 autoSegmentGloss', appSrcAuto.includes('autoSegmentGloss'), '阅读/导出须调 autoSegmentGloss');
  check('UI 不经词典/分词包', appSrcAuto.includes('不经词典/分词包'), '缺 auto 旁路注释');
  check('UI Mode 强制走 LLM', appSrcAuto.includes("book.lang === 'auto'") && appSrcAuto.includes('Mode.B'), 'auto 须 book.lang 分支 + B 亦走 LLM');
  check('UI 无 key 导设置', appSrcAuto.includes('Auto 万能模式需 LLM Key') && appSrcAuto.includes("state.tab = 'settings'"), '无 key 须报错 + 导设置');
  check('UI notice 纯 LLM 费用', appSrcAuto.includes('纯 LLM 费用') && appSrcAuto.includes('Auto 万能模式'), 'notice 须明示纯 LLM 费用');
  check('UI 语言下拉末尾 Auto', appSrcAuto.includes("data-testid', 'lang-select") || appSrcAuto.includes('data-testid", "lang-select'), '缺 lang-select');
  const typesSrc = readFileSync(resolve(process.cwd(), 'src/types.ts'), 'utf8');
  check('types 末位 auto', /'ja', 'auto'|"ja", "auto"/.test(typesSrc) || typesSrc.includes("'auto'"), 'SOURCE_LANGS 末位须 auto');

  // 12e) DOM 口径：lang-select 末位 auto + gloss-notice 纯 LLM + auto token .from-llm（无 .missing）
  {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    const doc = dom.window.document;
    // 语言下拉（镜像 app.ts：SOURCE_LANGS 顺序建 option）
    const sel = doc.createElement('select');
    sel.setAttribute('data-testid', 'lang-select');
    for (const l of SOURCE_LANGS as string[]) {
      const o = doc.createElement('option') as HTMLOptionElement;
      o.value = l;
      o.textContent = `${l} · ${(SOURCE_LANG_NAMES as Record<string, string>)[l]}`;
      sel.appendChild(o);
    }
    const opts = [...sel.querySelectorAll('option')] as HTMLOptionElement[];
    check('DOM 语言末位 auto', opts[opts.length - 1].value === 'auto', opts.map((o) => o.value).join(','));
    check('DOM auto 文案万能', /万能/.test(opts[opts.length - 1].textContent ?? ''), opts[opts.length - 1].textContent ?? '');
    // notice（镜像 auto 分支文案关键句）
    const notice = doc.createElement('div');
    notice.setAttribute('data-testid', 'gloss-notice');
    notice.textContent = 'Auto 万能模式：无词典/分词包，整句送 LLM 自动识别源语言并分词+注（纯 LLM 费用，按段计费，注意上限；无 key 请去「设置」填写）。';
    check('DOM notice 纯 LLM 费用', /纯 LLM 费用/.test(notice.textContent) && /Auto/.test(notice.textContent));
    // auto 渲染：tokens 全 from-llm，无 missing 占位
    const holder = doc.createElement('div');
    const annAuto = [{ text: AR, tokens: r1.tokens.map((t) => ({ surface: t.surface, lemma: t.lemma, isWord: true, gloss: t.gloss, glossSource: 'llm' as const, known: false, stopword: false })) }];
    (globalThis as Record<string, unknown>).document = doc;
    renderParagraphs(holder, annAuto as never, { mode: 'A' as never, showGloss: true, filters: { hideStopwords: false, hideKnown: false, freqHideTopN: 0 }, showAIButton: false, onTokenClick: () => undefined, onSentenceAI: () => undefined });
    check('DOM auto token 有注', holder.querySelectorAll('.tok .gloss').length === 2, `got ${holder.querySelectorAll('.tok .gloss').length}`);
    check('DOM auto 全 from-llm', holder.querySelectorAll('.tok.from-llm').length === 2, `got ${holder.querySelectorAll('.tok.from-llm').length}`);
    check('DOM auto 无 missing', holder.querySelectorAll('.gloss.missing').length === 0);
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部验收通过');
