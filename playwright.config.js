// Item 10 da rodada de estabilizacao: Playwright configurado contra o
// ambiente real (nao ha staging separado neste projeto -- ver
// docs/regression-item8.md da rodada anterior). BASE_URL sobrescrevivel
// via variavel de ambiente para permitir, no futuro, apontar para um
// staging de fato isolado quando existir.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "e2e-results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://bongo.dobslit.com",
    trace: "retain-on-failure",
  },
});
