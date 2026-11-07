// .apkg 浏览器壳：sql.js wasm 初始化（?url 资产，懒加载）+ JSZip 打包（动态 import，
// 与 epub 共用其 chunk）。纯构建逻辑在 apkg-core.ts（node 可测）。导出与 TSV 同一 License 门。
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { buildApkgRows, populateAnkiDb, type ApkgEntry, type ApkgOpts } from "./apkg-core.ts";
import { sha1Hex } from "../lib/hash.ts";

/** 生成 .apkg（zip: collection.anki2 + media）。Anki 桌面/手机版直接导入。 */
export async function buildApkgBlob(entries: ApkgEntry[], opts: ApkgOpts = {}): Promise<Blob> {
  if (!entries.length) throw new Error("生词本为空：先在阅读时把生词加入生词本，再导出。");
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  try {
    // notes.csum = 首字段（Word）sha1 前 8 hex 的整数（Anki 导入去重口径，genanki 同款）
    const csums: number[] = [];
    for (const e of entries) {
      const hex = await sha1Hex(String(e.lemma ?? ""));
      csums.push(Number.parseInt(hex.slice(0, 8), 16) >>> 0);
    }
    const rows = buildApkgRows(entries, opts, Date.now());
    rows.notes = rows.notes.map((row, i) => {
      const next = [...row];
      next[8] = csums[i] ?? next[8];
      return next;
    });
    populateAnkiDb(db, rows);
    const bytes = db.export();
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("collection.anki2", bytes);
    zip.file("media", "{}");
    const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return new Blob([out.buffer as ArrayBuffer], { type: "application/zip" });
  } finally {
    db.close();
  }
}
