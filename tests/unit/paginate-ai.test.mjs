import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupTokensToLines } from "../../packages/web/src/reader/paginate.ts";

// 盒顺序即文档顺序；g 为全局 token 下标（AI 按钮取段尾下一 token 下标）。
describe("groupTokensToLines with ai-btn blocks", () => {
  it("merges a wrapped ai-btn into the previous line (never its own line)", () => {
    const boxes = [
      { top: 0, bottom: 20, para: 0, tok: 0, g: 0 },
      { top: 0, bottom: 20, para: 0, tok: 1, g: 1 },
      // 按钮独占一行（top 24 > 行底 20）：必须并入上一行，而非自成一行
      { top: 24, bottom: 46, para: 0, tok: 2, g: 2, ai: true },
      { top: 50, bottom: 70, para: 1, tok: 0, g: 2 },
    ];
    const geom = groupTokensToLines(boxes, 3);
    assert.equal(geom.lines.length, 2);
    assert.equal(geom.lines[0].bottom, 46);
    assert.equal(geom.lines[0].firstTok, 0);
    assert.equal(geom.lines[0].lastTok, 1);
    assert.equal(geom.lines[1].firstTok, 2);
  });
  it("inline ai-btn is a no-op (already overlapped)", () => {
    const boxes = [
      { top: 0, bottom: 20, para: 0, tok: 0, g: 0 },
      { top: 2, bottom: 18, para: 0, tok: 1, g: 1, ai: true },
      { top: 30, bottom: 50, para: 1, tok: 0, g: 1 },
    ];
    const geom = groupTokensToLines(boxes, 2);
    assert.equal(geom.lines.length, 2);
    assert.equal(geom.lines[0].bottom, 20);
  });
  it("global token indices stay compact with interleaved ai boxes", () => {
    const boxes = [
      { top: 0, bottom: 20, para: 0, tok: 0, g: 0 },
      { top: 24, bottom: 46, para: 0, tok: 1, g: 1, ai: true },
      { top: 50, bottom: 70, para: 1, tok: 0, g: 1 },
      { top: 50, bottom: 70, para: 1, tok: 1, g: 2 },
    ];
    const geom = groupTokensToLines(boxes, 3);
    assert.deepEqual(
      geom.lines.map((l) => [l.firstTok, l.lastTok]),
      [[0, 0], [1, 2]],
    );
    assert.deepEqual(geom.tokenLine, [0, 1, 1]);
  });
});
