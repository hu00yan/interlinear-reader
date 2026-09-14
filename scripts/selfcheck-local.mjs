// Poll a deployed /api/selfcheck until healthy (CI post-deploy gate).
// Usage: node scripts/selfcheck-local.mjs [baseUrl] [--tries=30]
const base = process.argv[2] ?? process.env.ILR_BASE ?? "http://127.0.0.1:5173";
const tries = Number((process.argv.find((a) => a.startsWith("--tries=")) ?? "--tries=30").split("=")[1]);
for (let i = 1; i <= tries; i++) {
  try {
    const r = await fetch(`${base}/api/selfcheck`);
    const j = await r.json();
    if (r.ok && j.langs?.length === 7 && j.modes?.length === 3 && (j.shardsOk?.length ?? 0) >= 7) {
      console.log(`SELFCHECK OK try=${i} shardsOk=${j.shardsOk.length} hitRate=${j.cache?.hitRate ?? "?"}`);
      process.exit(0);
    }
    console.log(`try=${i} not-ready: ${JSON.stringify(j).slice(0, 200)}`);
  } catch (e) { console.log(`try=${i} err=${e.cause?.code ?? e.message}`); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("SELFCHECK FAIL");
process.exit(1);
