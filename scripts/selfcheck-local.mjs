// Deploy health probe — no Worker, no server API. Static dict files only:
//   {base}/dict/ja/zh.dict      (small pair, must contain a TAB + 家)
//   {base}/dict/en/en.dict.00   (first chunk of the split oversize pair;
//                                proves split-dict + chunk serving on Pages)
// Usage: node scripts/selfcheck-local.mjs [baseUrl] [--tries=30]
// CI nightly: base=https://interlinear-reader.pages.dev
const base = (process.argv[2] ?? process.env.ILR_BASE ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const tries = Number((process.argv.find((a) => a.startsWith('--tries=')) ?? '--tries=30').split('=')[1]);
const okBody = (t) => t.includes('\t') && t.includes('家');
for (let i = 1; i <= tries; i++) {
  try {
    const [zh, chunk] = await Promise.all([
      fetch(`${base}/dict/ja/zh.dict`, { headers: { Accept: 'text/plain' } }),
      fetch(`${base}/dict/en/en.dict.00`, { headers: { Accept: 'text/plain' } }),
    ]);
    const zhText = zh.ok ? await zh.text() : '';
    if (zh.ok && okBody(zhText) && chunk.ok) {
      console.log(`SELFCHECK OK try=${i} ja/zh=${zhText.split('\n').filter(Boolean).length}entries en-chunk=${chunk.headers.get('content-length') ?? '?'}B`);
      process.exit(0);
    }
    console.log(`try=${i} not-ready: zh=${zh.status} chunk=${chunk.status}`);
  } catch (e) { console.log(`try=${i} err=${e.cause?.code ?? e.message}`); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error('SELFCHECK FAIL');
process.exit(1);
