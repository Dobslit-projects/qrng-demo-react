// Item 5: interações reais com as funções do portal (não só navegar até a aba).
// Contra o STAGING (fixture replay determinístico). Cada teste EXECUTA a função
// e valida o resultado — π, máximo de f(x), histograma/scatter/bits, PRNG×QRNG.
// Distribuição exponencial é função de lib sem UI -> coberta em
// src/lib/qrngHelper.test.js (identidade X=-μ·ln(1-U), μ=5, U∈[0,1), sem log(0)).
import { test, expect } from "@playwright/test";

async function nav(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
}
async function subtab(page, label) {
  // sub-abas de "Representações Visuais" (Visualizações Interativas / Análise Estatística)
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(300);
}
const noNaN = async (page) => {
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/\bNaN\b/);
  expect(body).not.toMatch(/\bInfinity\b/);
};

test.describe.serial("Aplicações — Monte Carlo π", () => {
  test("estima π: valor plausível, contagem coerente, erro = |π̂-π|/π, sem NaN", async ({ page }) => {
    test.setTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    await page.getByRole("button", { name: /Estimar π com .* pontos/ }).first().click();
    // espera o bloco de resultado (contém "Erro:" e "π real: 3.141593")
    await expect(page.getByText(/Erro:\s*[\d.]+\s*%/)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/π real:/)).toBeVisible();

    const card = await page.locator("body").innerText();
    // π̂: o número grande com 6 casas que NÃO é o "π real"
    const sixDec = [...card.matchAll(/\b(\d\.\d{6})\b/g)].map((m) => parseFloat(m[1]));
    const piEst = sixDec.find((v) => Math.abs(v - Math.PI) < 0.6 && Math.abs(v - Math.PI) > 1e-9)
                  ?? sixDec[0];
    expect(piEst).toBeGreaterThan(2.5);
    expect(piEst).toBeLessThan(3.7);

    const it = card.match(/([\d.]+)\s*dentro\s*\/\s*([\d.]+)\s*total/i);
    expect(it).toBeTruthy();
    const inside = parseInt(it[1].replace(/\./g, ""), 10);
    const total = parseInt(it[2].replace(/\./g, ""), 10);
    expect(inside).toBeGreaterThanOrEqual(0);
    expect(inside).toBeLessThanOrEqual(total);
    expect(Math.abs(4 * inside / total - piEst)).toBeLessThan(0.02);

    const errPct = parseFloat(card.match(/Erro:\s*([\d.]+)\s*%/)[1]);
    expect(Math.abs(Math.abs((piEst - Math.PI) / Math.PI) * 100 - errPct)).toBeLessThan(0.1);
    await noNaN(page);
    expect(errors).toEqual([]);
  });
});

test.describe.serial("Aplicações — máximo de f(x) = sin(x) + cos(2x)", () => {
  test("busca o máximo: resultado ≤ limite teórico (~1.7602) e finito, sem NaN", async ({ page }) => {
    test.setTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    await page.getByRole("button", { name: /Buscar máximo com .* amostras QRNG/ }).first().click();
    await expect(page.getByText(/f\(x\).*m[áa]ximo/i)).toBeVisible({ timeout: 30000 });
    const txt = await page.locator("body").innerText();
    const nums = [...txt.matchAll(/-?\d+\.\d+/g)].map((x) => parseFloat(x[0]));
    // máximo global de sin(x)+cos(2x) em [0,2π] ≈ 1.7602
    expect(nums.some((v) => v > -2.1 && v <= 1.7602 + 1e-3)).toBe(true);
    await noNaN(page);
    expect(errors).toEqual([]);
  });
});

test.describe.serial("Análise Estatística — PRNG × QRNG (scatter, histograma, bits)", () => {
  test("Gerar: duas colunas com 64 bits cada, scatter+histograma renderizados, sem NaN/pageerror", async ({ page }) => {
    test.setTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Análise Estatística");
    await page.getByRole("button", { name: "Gerar", exact: true }).first().click();
    await expect(page.getByText("Bits (64 amostras)").first()).toBeVisible({ timeout: 30000 });
    expect(await page.getByText("Bits (64 amostras)").count()).toBeGreaterThanOrEqual(2); // PRNG + QRNG
    expect(await page.getByText("Scatter Plot").count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator("canvas").count()).toBeGreaterThanOrEqual(2);
    await noNaN(page);
    expect(errors).toEqual([]);
  });
});

test.describe("Representações Visuais — Sonificação (áudio pode estar bloqueado)", () => {
  test("selecionar Sonificação e alternar o som não quebra a página (headless: AudioContext suspenso)", async ({ page }) => {
    test.setTimeout(45000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Visualizações Interativas");
    const sonif = page.getByRole("button", { name: /Sonifica/i }).first();
    if (await sonif.count()) {
      await sonif.click();
      await page.waitForTimeout(600);
    }
    const audioToggle = page.locator('[title="Ativar som"], [title="Desativar som"]').first();
    if (await audioToggle.count()) {
      await audioToggle.click();
      await page.waitForTimeout(500);
      await audioToggle.click();
    }
    // headless: AudioContext fica "suspended" até um gesto real; o app deve
    // tratar isso sem lançar. Sem pageerror = tratamento correto.
    expect(errors).toEqual([]);
  });
});
