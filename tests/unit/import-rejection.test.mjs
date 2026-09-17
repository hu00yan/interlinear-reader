import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

it("rejects unknown extensions before decoding or replacing a book and clears loading status", async () => {
  const source = await readFile("packages/web/src/ui/app.ts", "utf8");
  const handler = source
    .split('fileInput.addEventListener("change", async () => {')[1]
    .split("const row2 =")[0];
  assert.match(handler, /\["epub", "mobi", "azw3", "azw", "txt", "md"\]\.includes\(extension\)/);
  assert.match(handler, /if \(!mobi &&/);
  assert.match(handler, /slice\(60, 68\).*=== "BOOKMOBI"/);
  assert(handler.indexOf("不支持的文件类型") < handler.indexOf("decodeTextFile(f)"));
  assert(handler.indexOf("不支持的文件类型") < handler.indexOf("replaceBook(book)"));
  assert.match(
    handler,
    /catch \(e\) \{[\s\S]*state\.error = \(e as Error\)\.message;\s*state\.status = "";/
  );
});
