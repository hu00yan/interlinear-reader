// Original test content only. Never copies the local reader's real book.
import JSZip from "jszip";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("./fixtures/", import.meta.url));
await mkdir(out, { recursive: true });
const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="orange"/><text x="5" y="40">Original fixture</text></svg>';
async function epub(name, chapters) {
  const z = new JSZip();
  z.file("mimetype", "application/epub+zip", { compression: "STORE" });
  z.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  );
  z.file(
    "OEBPS/content.opf",
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture-${name}</dc:identifier><dc:title>${name}</dc:title><dc:language>ja</dc:language></metadata><manifest>${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}<item id="img" href="original.svg" media-type="image/svg+xml"/></manifest><spine page-progression-direction="rtl">${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`
  );
  z.file("OEBPS/original.svg", image);
  chapters.forEach((body, i) =>
    z.file(
      `OEBPS/c${i}.xhtml`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>章${i + 1}</title><style>body{writing-mode:vertical-rl}</style></head><body>${body}</body></html>`
    )
  );
  await writeFile(
    `${out}/${name}.epub`,
    await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  );
}
await epub("all-image-original", ['<img src="original.svg" alt="Original illustration"/>']);
await epub("vertical-ruby-original", [
  '<h1>第一章</h1><p>始まり。「<ruby>日本<rp>（</rp><rt>にほん</rt><rp>）</rp></ruby>へ行く。」</p><p>絵の前。</p><img src="original.svg" alt="Original illustration"/><p>絵の後。</p><blockquote>外側。<p>内側。</p>終端。</blockquote><div>DIV専用本文。</div>',
  '<img src="original.svg" alt="Second original illustration"/>',
  "<h1>第三章</h1><p>最後の章。</p>",
]);
const paragraphs = Array.from(
  { length: 60 },
  (_, i) => `段落${String(i + 1).padStart(3, "0")}。「赤い鳥は空を飛ぶ。」雨、風、光。終わり。`
);
await epub("continuity-original", [
  paragraphs.map((p) => `<p>${p}</p>`).join(""),
  "<p>第二章の最終文。</p>",
]);
await writeFile(
  `${out}/continuity-expected.json`,
  JSON.stringify([...paragraphs, "第二章の最終文。"], null, 2)
);
for (const ext of ["pdf", "mobi", "azw3", "djvu"])
  await writeFile(
    `${out}/not-a-real-format.${ext}`,
    "Synthetic plain text under an unsupported extension. No real binary format is implied."
  );
console.log(`Created original fixtures in ${out}`);
