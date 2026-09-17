# Foliate MOBI parser — distribution notice

`foliate-mobi.js` is vendored from `mobi.js` in **foliate-js 1.0.1**, commit
`f52d42c6127d0ad981a2c67634113541b17ae01e`.
Upstream: <https://github.com/johnfactotum/foliate-js>.
The local modification adds a tolerant HTML fallback in `KF8.createDocument`.

This notice applies to both the source module and its compiled/minified copies
in the web distribution (`packages/web/dist/assets/mobi-*.js`). The complete
notice below is embedded as `FOLIATE_MOBI_LICENSE` in `mobi.ts` and printed with
`console.info` when a validated MOBI/AZW3 file is parsed. It therefore remains
in the deployed lazy JavaScript chunk even when ordinary source comments are
stripped. Distributors must retain that notice; if changing bundling to remove
console calls or the notice string, ship the complete notice with the output
by another means. This Markdown file alone is not the deployed notice.

The web app also lists Foliate.js (MIT), JSZip (MIT option), marked (MIT), and
JSZip's bundled compression/runtime helpers with upstream URLs under
**设置 → 关于 · 第三方代码**. The About block is an attribution summary; the
full Foliate copyright, permission, and warranty notice remains in the parser
chunk described above.

## MIT License

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
SOFTWARE.
