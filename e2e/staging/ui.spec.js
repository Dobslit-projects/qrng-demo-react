// Navegador real: carregamento das páginas e telas-chave do staging.
// NÃO basta HTTP 200 -- Swagger/ReDoc/OpenAPI são carregados numa página real.
import { test, expect } from "@playwright/test";

test.describe("navegação pública", () => {
  test("home / portal carrega sem erro de página", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Dados", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("abas públicas navegáveis (Kapuã, Representações Visuais, Dados, Aplicações, Teste NIST)", async ({ page }) => {
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    for (const name of ["Representações Visuais", "Dados", "Aplicações", "Teste NIST", "Kapuã"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator("body")).toBeVisible();
    }
  });
});

test.describe("Swagger / ReDoc em navegador real", () => {
  test("Swagger UI renderiza a spec (título Kapuã aparece na página)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/v1/docs/", { waitUntil: "networkidle" });
    await expect(page.locator(".swagger-ui")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Kapu.* QRNG/i).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("ReDoc carrega (assets vêm do CDN -- se bloqueado, o teste registra)", async ({ page }) => {
    const resp = await page.goto("/qrng/v1/redoc", { waitUntil: "domcontentloaded" });
    expect(resp.status()).toBe(200);
    const html = await page.content();
    expect(html).toContain("/v1/openapi.json");
  });

  test("OpenAPI JSON abre no navegador e é JSON", async ({ page }) => {
    const resp = await page.goto("/qrng/v1/openapi.json", { waitUntil: "domcontentloaded" });
    expect(resp.status()).toBe(200);
    const txt = await resp.text();
    const spec = JSON.parse(txt);
    expect(spec.openapi).toMatch(/^3\./);
  });
});

test.describe("geração de chave/seed bloqueada (UI)", () => {
  test("aba Aplicações mostra a geração de chave desabilitada", async ({ page }) => {
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Aplicações", exact: true }).click();
    // o texto de bloqueio aparece na UI (ver ApplicationsSection.jsx)
    await expect(page.getByText(/DESABILITADA|desabilitad/i).first()).toBeVisible({ timeout: 15000 });
  });
});

test.describe("NIST indisponível (staging)", () => {
  test("aba Teste NIST lida com o serviço 503 sem quebrar a página", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Teste NIST", exact: true }).click();
    await page.waitForTimeout(2000);
    expect(errors).toEqual([]);
  });
});

test.describe("fallback quando a fonte fica offline", () => {
  test("com o fixture offline, a aba Dados não trava a página", async ({ page, request }) => {
    test.skip(!process.env.FIXTURE_CTL_URL, "precisa de FIXTURE_CTL_URL");
    const CTL = process.env.FIXTURE_CTL_URL;
    await request.post(`${CTL}/_ctl/offline`);
    try {
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Dados", exact: true }).click();
      await page.getByRole("button", { name: "Raw Binário", exact: true }).click();
      await page.getByRole("button", { name: "Gerar prévia" }).click();
      await page.waitForTimeout(4000);
      // ou entra em fallback pré-coletado, ou mostra erro explícito -- nunca trava
      expect(errors).toEqual([]);
    } finally {
      await request.post(`${CTL}/_ctl/online`);
    }
  });
});
