import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "artifacts/playwright.json" }]],
  use: { baseURL: process.env.ILR_BASE ?? "http://127.0.0.1:5173" },
  webServer: undefined, // verify.mjs starts scripts/stub-server.mjs itself
});
