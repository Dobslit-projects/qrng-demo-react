// Navegador real: carregamento das páginas e telas-chave do staging.
// NÃO basta HTTP 200 -- Swagger/ReDoc/OpenAPI são carregados numa página real.
import { test, expect } from "@playwright/test";

// O portal renderiza nav de desktop E de mobile (useIsMobile) -> alguns rótulos
// aparecem 2x; e há CTAs no conteúdo com o mesmo texto. Sempre .first().
async function nav(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
}

test.describe("navegação pública", () => {
  test("home / portal carrega sem erro de página", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Dados", exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("abas públicas navegáveis (Kapuã, Representações Visuais, Dados, Aplicações, Teste NIST)", async ({ page }) => {
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    for (const name of ["Representações Visuais", "Dados", "Aplicações", "Teste NIST", "Kapuã"]) {
      await nav(page, name);
      await expect(page.locator("body")).toBeVisible();
      await page.waitForTimeout(300);
    }
  });
});

test.describe("Swagger / ReDoc em navegador real", () => {
  test("Swagger UI renderiza a spec (título Kapuã aparece na página)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/v1/docs/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".swagger-ui").first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".swagger-ui .info").first()).toContainText(/Kapu/i, { timeout: 20000 });
    expect(errors).toEqual([]);
  });

  test("ReDoc carrega (assets vêm do CDN -- se bloqueado, o teste registra)", async ({ page }) => {
    const resp = await page.goto("/qrng/v1/redoc", { waitUntil: "domcontentloaded" });
    expect(resp.status()).toBe(200);
    expect(await page.content()).toContain("/v1/openapi.json");
  });

  test("OpenAPI JSON abre no navegador e é JSON 3.x", async ({ page }) => {
    const resp = await page.goto("/qrng/v1/openapi.json", { waitUntil: "domcontentloaded" });
    expect(resp.status()).toBe(200);
    const spec = JSON.parse(await resp.text());
    expect(spec.openapi).toMatch(/^3\./);
  });
});

test.describe("geração de chave/seed bloqueada (UI)", () => {
  test("aba Aplicações mostra a geração de chave desabilitada", async ({ page }) => {
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    await expect(page.getByText(/DESABILITADA|desabilitad/i).first()).toBeVisible({ timeout: 15000 });
  });
});

test.describe("NIST indisponível (staging)", () => {
  test("aba Teste NIST lida com o serviço 503 sem quebrar a página", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Teste NIST");
    await page.waitForTimeout(2500);
    expect(errors).toEqual([]);
  });
});

test.describe("fallback quando a fonte fica offline", () => {
  test("com o fixture offline, a aba Dados não trava a página", async ({ page, request }) => {
    test.skip(!process.env.FIXTURE_CTL_URL, "precisa de FIXTURE_CTL_URL");
    test.setTimeout(60000);
    const CTL = process.env.FIXTURE_CTL_URL;
    await request.post(`${CTL}/_ctl/offline`);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Dados", exact: true }).first().click();
      // com a fonte offline a aba ainda carrega e navega -- não trava (sem pageerror).
      // (o botão "Gerar prévia" pode ficar desabilitado, que é o comportamento correto.)
      await expect(page.getByText("Modo de Exportação")).toBeVisible({ timeout: 15000 });
      await page.getByRole("button", { name: "Raw Binário", exact: true }).first().click();
      await page.waitForTimeout(2000);
      expect(errors).toEqual([]);
    } finally {
      await request.post(`${CTL}/_ctl/online`).catch(() => {});
    }
  });
});
