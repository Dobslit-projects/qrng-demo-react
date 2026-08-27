// Playwright — duas camadas de teste E2E:
//
//  e2e/staging/**   -> DETERMINÍSTICO, contra o staging reproduzível
//                      (staging/docker-compose.staging.yml, upstream = fixture
//                      de replay). É o que entra no CI (job e2e-staging).
//  e2e/*.spec.js     -> a fatia antiga contra o ambiente real (não-CI).
//
// E2E_BASE_URL aponta para o web do staging (padrão http://127.0.0.1:18080).
// E2E_STAGING_ONLY=1 restringe o testDir a e2e/staging (usado pelo CI).
import { defineConfig } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:18080";
const STAGING_ONLY = process.env.E2E_STAGING_ONLY === "1";

export default defineConfig({
  testDir: STAGING_ONLY ? "./e2e/staging" : "./e2e",
  timeout: 30000,
  expect: { timeout: 10000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "e2e-results.json" }]],
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
