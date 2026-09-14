#!/usr/bin/env node
// 生成 public/fixtures/hello-en.epub（最小合法 EPUB，供 `npm run dev` 验收上传/载入）。
// 无第三方依赖：手写 ZIP（stored mimetype + deflate 其余），避免构建期装包。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fixtures');
mkdirSync(root, { recursive: true });

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Morning</title></head><body>
<h1>Morning</h1>
<p>Hello world. The sun shines in the morning.</p>
<p>The small cat drinks milk. The big dog likes fish.</p>
<p>The cat reads a book in the garden. The bird sings a song.</p>
</body></html>`;

const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Night</title></head><body>
<h1>Night</h1>
<p>Hello friend. The day ends and night comes.</p>
<p>The dog drinks water. The cat likes milk and fish.</p>
<p>Read a book at home. The garden tree is big.</p>
</body></html>`;

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Hello Reader</dc:title><dc:language>en</dc:language><dc:identifier id="id">hello-en-fixture</dc:identifier></metadata>
<manifest>
<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="hello-en-fixture"/></head>
<docTitle><text>Hello Reader</text></docTitle>
<navMap><navPoint id="n1" playOrder="1"><navLabel><text>Morning</text></navLabel><content src="ch1.xhtml"/></navPoint>
<navPoint id="n2" playOrder="2"><navLabel><text>Night</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap>
</ncx>`;

// 最小 ZIP 写出：mimetype 必须首个 + stored
import { deflateRawSync } from 'node:zlib';

const files = [
  { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
  { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER) },
  { name: 'OEBPS/content.opf', data: Buffer.from(OPF) },
  { name: 'OEBPS/toc.ncx', data: Buffer.from(NCX) },
  { name: 'OEBPS/ch1.xhtml', data: Buffer.from(CH1) },
  { name: 'OEBPS/ch2.xhtml', data: Buffer.from(CH2) },
];

function dosTime(d = new Date()) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
}
function dosDate(d = new Date()) {
  return ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);
}

const chunks = [];
const central = [];
let offset = 0;
for (const f of files) {
  const raw = f.data;
  const comp = f.method === 0 ? raw : deflateRawSync(raw);
  const crc = crc32(raw) >>> 0;
  const nameBuf = Buffer.from(f.name);
  const localOffset = offset;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(f.method === 0 ? 0 : 8, 8);
  lh.writeUInt16LE(dosTime(), 10);
  lh.writeUInt16LE(dosDate(), 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  chunks.push(lh, nameBuf, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(f.method === 0 ? 0 : 8, 10);
  ch.writeUInt16LE(dosTime(), 12);
  ch.writeUInt16LE(dosDate(), 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30); // extra
  ch.writeUInt16LE(0, 32); // comment
  ch.writeUInt16LE(0, 34); // disk
  ch.writeUInt32LE(0, 38); // ext attr
  ch.writeUInt32LE(localOffset, 42); // local header offset
  central.push(ch, nameBuf);
  offset += lh.length + nameBuf.length + comp.length;
}
const centralSize = central.reduce((a, b) => a + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 8);
end.writeUInt16LE(0, 10);
end.writeUInt16LE(files.length, 12);
end.writeUInt16LE(files.length, 14);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = Buffer.concat([...chunks, ...central, end]);
const dest = join(root, 'hello-en.epub');
writeFileSync(dest, out);
console.log(`fixture written: ${dest} (${out.length} bytes)`);
