import type { Book, BookChapter, SourceLang } from "../types.js";
import { extractXhtml } from "./epub.js";

/** Runtime notice: keep the full license in the deployed lazy chunk, not only a stripped comment. */
export const FOLIATE_MOBI_LICENSE = `Vendored mobi.js from foliate-js 1.0.1
Commit: f52d42c6127d0ad981a2c67634113541b17ae01e
Upstream: https://github.com/johnfactotum/foliate-js
Local change: KF8 createDocument uses a tolerant HTML fallback.

MIT License
Copyright (c) 2022 John Factotum

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const invalid = (): Error =>
  new Error("无效 MOBI/AZW3：文件头或记录表损坏（仅支持 BOOKMOBI，不支持 KFX）");

/** Validate before decompression, including the selected KF8 header in combo files.
 * Foliate does not reject PalmDOC encryption itself; never hand it encrypted text.
 */
async function validateMobi(file: File): Promise<void> {
  const header = new DataView(await file.slice(0, 78).arrayBuffer());
  if (
    header.byteLength !== 78 ||
    new TextDecoder().decode(new Uint8Array(header.buffer, 60, 8)) !== "BOOKMOBI"
  )
    throw invalid();
  const count = header.getUint16(76);
  if (!count || 78 + count * 8 > file.size) throw invalid();
  const table = new DataView(await file.slice(78, 78 + count * 8).arrayBuffer());
  const offsets = Array.from({ length: count }, (_, i) => table.getUint32(i * 8));
  offsets.push(file.size);
  for (let i = 0; i < count; i++) {
    if (offsets[i] < 78 + count * 8 || offsets[i] >= offsets[i + 1]) throw invalid();
  }
  const checkRecord = async (index: number): Promise<number | undefined> => {
    if (index < 0 || index >= count) throw invalid();
    const record = new DataView(await file.slice(offsets[index], offsets[index + 1]).arrayBuffer());
    if (record.byteLength < 16) throw invalid();
    if (record.getUint16(12) !== 0)
      throw new Error("此 MOBI/AZW3 文件已加密或受 DRM 保护；仅支持未加密文件，不提供 DRM 解密。");
    if (record.byteLength < 248 || record.getUint32(16) !== 0x4d4f4249) throw invalid();
    const length = record.getUint32(20);
    const version = record.getUint32(36);
    if (length < 232 || length + 16 > record.byteLength || (version >= 8 && length < 248))
      throw invalid();
    if (![1, 2, 17480].includes(record.getUint16(0)))
      throw new Error("MOBI/AZW3 使用了不支持的压缩类型");
    if (record.getUint16(8) === 0 || index + record.getUint16(8) >= count) throw invalid();
    let boundary: number | undefined;
    if (record.getUint32(128) & 0x40) {
      const start = 16 + length;
      if (start + 12 > record.byteLength || record.getUint32(start) !== 0x45585448) throw invalid();
      const end = start + record.getUint32(start + 4);
      if (end > record.byteLength || end < start + 12) throw invalid();
      let pos = start + 12;
      const records = record.getUint32(start + 8);
      for (let i = 0; i < records; i++) {
        if (pos + 8 > end) throw invalid();
        const size = record.getUint32(pos + 4);
        if (size < 8 || pos + size > end) throw invalid();
        if (record.getUint32(pos) === 121) {
          if (size !== 12) throw invalid();
          boundary = record.getUint32(pos + 8);
        }
        pos += size;
      }
    }
    // Do not silently fall back to the legacy half of a damaged combo book.
    if (index !== 0 && version < 8) throw invalid();
    return version < 8 && boundary !== 0xffffffff ? boundary : undefined;
  };
  const boundary = await checkRecord(0);
  if (boundary !== undefined) {
    if (boundary === 0) throw invalid();
    await checkRecord(boundary);
  }
}

/** Text-only import. createDocument avoids resource rewriting, fonts, and blob URLs.
 * MOBI7 pagebreaks and KF8 skeleton/fragment order supply the section boundaries.
 * Language selection intentionally matches EPUB: the caller's choice wins.
 * Images (KF8 recindex / MOBI7 recindex=<record>): intentionally NOT wired. The
 * vendored foliate API exposes loadRecindex, but document order here is already
 * flattened through extractXhtml; threading image blocks through would need a
 * second resource pipeline (recindex→Blob→Book.assets) plus KF8 flow-order
 * verification per book. Left text-only on purpose; see docs/research/image-support.md.
 */
export async function parseMobi(file: File, lang: SourceLang): Promise<Book> {
  await validateMobi(file);
  console.info(FOLIATE_MOBI_LICENSE);
  const { MOBI } = await import("./foliate-mobi.js");
  const parsed = await new MOBI({}).open(file);
  try {
    const chapters: BookChapter[] = [];
    for (const [i, section] of parsed.sections.entries()) {
      if (section.linear === "no" || !section.createDocument) continue;
      const doc = await section.createDocument();
      const { title, paragraphs } = extractXhtml(new XMLSerializer().serializeToString(doc));
      if (paragraphs.length)
        chapters.push({ id: `ch${i + 1}`, title: title || `Chapter ${i + 1}`, paragraphs });
    }
    if (!chapters.length) throw new Error("MOBI/AZW3 未提取到正文段落（不支持图片扫描/OCR）");
    return {
      title: parsed.metadata.title?.trim() || file.name.replace(/\.(mobi|azw3|azw)$/i, ""),
      lang,
      chapters,
      source: "mobi",
    };
  } finally {
    parsed.destroy();
  }
}
