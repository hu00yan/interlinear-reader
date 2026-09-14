// 设置页模型质量自测 e2e（真机构建 + harness mock-LLM，零花费）。
// 口径：data-testid=quality-test 一键 → quality-result 出 不合格+分项+换模型建议；
// mock 回显 MOCK:<lemma> 中文/命中双低，本地规则必判不合格；复核默认关。
import { test, expect } from "@playwright/test";

test("settings: quality-test runs golden 7-lang and reports verdict", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /设置/ }).click();

  // DOM 口径存在且复核默认关
  await expect(page.getByTestId("quality-test")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("quality-result")).toBeVisible();
  await expect(page.getByTestId("quality-judge")).not.toBeChecked();
  await expect(page.getByTestId("quality-result")).toContainText("未测试");

  // 指向 harness mock-LLM + device key（与 reader.spec 同口径）
  const origin = new URL(page.url()).origin;
  const baseUrl = page.locator(".card input[type='url']");
  await baseUrl.fill(`${origin}/mock-llm`);
  await baseUrl.dispatchEvent("change");
  const keyInput = page.locator(".card input[type='password']");
  await keyInput.fill("sk-test-quality");
  await keyInput.dispatchEvent("change");

  // 一键自测（key 填写触发重渲染，重新定位按钮）
  await page.getByTestId("quality-test").click();
  const result = page.getByTestId("quality-result");
  await expect(result).toHaveAttribute("data-verdict", "fail", { timeout: 90000 });
  await expect(result).toContainText("不合格");
  // 分项：综合/命中/中文/干净 + 7 语行
  await expect(result).toContainText("综合");
  await expect(result).toContainText("命中");
  await expect(result).toContainText("建议");
  for (const lang of ["en", "de", "fr", "it", "es", "ru", "ja"]) {
    await expect(result).toContainText(`${lang} 命中`);
  }
  // 参考原文/释义永不展示（防抄）：结果区不得出现金标英文难句关键词
  await expect(result).not.toContainText("venality");
  await expect(result).not.toContainText("Käuflichkeit");
});
