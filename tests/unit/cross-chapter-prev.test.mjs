import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { findFlowPage, slicesForTokenRange } from "../../packages/web/src/reader/paginate.ts";

// Exercise the actual reader closure and its measured-plan consumers without
// importing the app's storage/network bootstrap or pretending jsdom measures lines.
const source = readFileSync(new URL("../../packages/web/src/ui/app.ts", import.meta.url), "utf8");
const run = (code, ctx) =>
  vm.runInContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    ctx
  );
const turn = (name) =>
  source.match(new RegExp(`  const ${name} = \\(\\): void => \\{[\\s\\S]*?\\n  \\};`))[0];
const measured = (plan) =>
  source.match(
    new RegExp(
      `      if \\(pendingFlowAnchor != null\\) \\{\\n        state.page = findFlowPage\\(${plan}\\.pages,[\\s\\S]*?state.page = Math.max\\(0, Math.min\\(state.page, totalPages - 1\\)\\);`
    )
  )[0];
const endIntent =
  source.match(/  const landAtChapterEnd = .*;/)?.[0] ?? "const landAtChapterEnd = false;";
// Format-immune extraction: slice from a stable start marker to a stable end
// marker instead of matching exact whitespace (source formatting shifts broke
// single-line regex assumptions before).
const from = (startMarker, endMarker) => {
  const a = source.indexOf(startMarker);
  const b = source.indexOf(endMarker, a);
  if (a < 0 || b < 0) return null;
  return source.slice(a, b + endMarker.length);
};
const stabilize = from(
  "      const anchor = landAtChapterEnd",
  "state.page = Math.max(0, Math.min(findFlowPage(plan2.pages, anchor), totalPages - 1));"
);
if (!stabilize)
  throw new Error("stabilize anchor block not found in app.ts — update this test's source markers");
const autoReflow = (() => {
  const startMarker = "          const anchorFi = pageFlowIdx.length ? pageFlowIdx[0] : 0;";
  const endMarker = "Math.min(findFlowPage(planAuto2.pages, anchorTok), totalPages - 1)";
  const chunk = from(startMarker, endMarker);
  if (!chunk)
    throw new Error(
      "autoReflow anchor block not found in app.ts — update this test's source markers"
    );
  return chunk + "\n}";
})();

function harness(estimate, count) {
  // Ten source paragraphs, ten tokens each. The last paragraph spans pages
  // when count > 10, so anchoring its START would not necessarily reach the end.
  const geom = {
    paraStart: Array.from({ length: 11 }, (_, i) => i * 10),
    paraLens: Array(10).fill(10),
  };
  const pages = Array.from({ length: count }, (_, i) => ({
    startTok: Math.floor((i * 100) / count),
    cutTok: Math.floor(((i + 0.5) * 100) / count),
    endTok: Math.floor(((i + 1) * 100) / count),
  }));
  const ctx = vm.createContext({
    state: { chapterIdx: 1, page: 0 },
    pendingFlowAnchor: null,
    totalPages: 1,
    totalChapters: 2,
    totalPagesFor: () => estimate,
    sync() {},
    findFlowPage,
    plan: { pages },
    planAuto: { pages },
    lastFlowPages: pages,
    paginateChapterFlow: () => ({ pages }),
    rememberFlowPages() {},
    renderFlow: [],
    flowCacheKey: "",
    realCap: 400,
    columnsUsed: 2,
    flowColW: 360,
    flowProbeOpts: {},
  });
  return { ctx, pages, geom };
}

describe("cross-chapter previous page uses the measured chapter end", () => {
  for (const plan of ["plan", "planAuto"]) {
    for (const [estimate, count] of [
      [5, 10],
      [10, 5],
      [2, 20],
      [10, 1],
    ]) {
      it(`${plan}: estimate ${estimate}, measured ${count}, last source paragraph retained`, () => {
        const { ctx, pages, geom } = harness(estimate, count);
        run(`${turn("goPrevPage")}\ngoPrevPage();\n${endIntent}`, ctx);
        assert.equal(ctx.state.chapterIdx, 0);
        ctx.totalPages = count;
        run(measured(plan), ctx);
        assert.equal(ctx.state.page, count - 1);
        assert.equal(ctx.pendingFlowAnchor, null, "one-shot anchor consumed");
        const pg = pages[ctx.state.page];
        assert.equal(slicesForTokenRange(geom, pg.startTok, pg.endTok).at(-1).para, 9);
        // Final chrome measurement can add another page; retain the chapter END,
        // not the first token of the page chosen before stabilization.
        ctx.paginateChapterFlow = () => ({
          pages: Array.from({ length: 25 }, (_, i) => ({ startTok: i * 4, endTok: (i + 1) * 4 })),
        });
        run(`(() => { ${stabilize} })();`, ctx);
        assert.equal(ctx.state.page, 24, "chapter-end intent survives chrome reflow");
      });
    }
  }
  it("keeps chapter-end intent through Auto token-boundary remeasurement", () => {
    const { ctx } = harness(10, 5);
    run(`${turn("goPrevPage")}\ngoPrevPage();\n${endIntent}`, ctx);
    ctx.totalPages = 5;
    run(measured("planAuto"), ctx);
    Object.assign(ctx, {
      pageFlowIdx: [8, 9],
      flowAuto: [],
      cap0: 400,
      colW0: 360,
      probeOptsAuto: {},
      flowIndexOf: () => ({ paraStart: Array.from({ length: 11 }, (_, i) => i * 20) }),
      paginateChapterFlow: () => ({
        pages: Array.from({ length: 20 }, (_, i) => ({ startTok: i * 10, endTok: (i + 1) * 10 })),
      }),
    });
    run(`(() => { ${autoReflow} })();`, ctx);
    assert.equal(ctx.state.page, 19);
  });
  it("retains ordinary resize anchors and page-start stabilization", () => {
    for (const plan of ["plan", "planAuto"]) {
      const { ctx } = harness(10, 5);
      ctx.pendingFlowAnchor = 45;
      ctx.totalPages = 5;
      run(endIntent, ctx);
      run(measured(plan), ctx);
      assert.equal(ctx.state.page, 2);
      assert.equal(ctx.pendingFlowAnchor, null);
      run(`(() => { ${stabilize} })();`, ctx);
      assert.equal(ctx.state.page, 2, "ordinary reflow must not jump to chapter end");
    }
  });
  it("leaves within-chapter previous and forward crossing unchanged", () => {
    const { ctx } = harness(5, 10);
    ctx.state.page = 3;
    ctx.totalPages = 10;
    run(`${turn("goPrevPage")}\ngoPrevPage();`, ctx);
    assert.equal(ctx.state.page, 2);
    assert.equal(ctx.state.chapterIdx, 1);
    assert.equal(ctx.pendingFlowAnchor, null);
    ctx.state.chapterIdx = 0;
    ctx.state.page = 9;
    run(`${turn("goNextPage")}\ngoNextPage();`, ctx);
    assert.equal(ctx.state.chapterIdx, 1);
    assert.equal(ctx.state.page, 0);
    assert.equal(ctx.pendingFlowAnchor, null);
  });
});
