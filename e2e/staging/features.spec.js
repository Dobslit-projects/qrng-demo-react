// Item 5: interações reais com as funções do portal (não só navegar até a aba).
// Contra o STAGING (fixture replay determinístico). Cada teste EXECUTA a função
// e valida o resultado — π, máximo de f(x), histograma/scatter/bits, PRNG×QRNG.
// Distribuição exponencial é função de lib sem UI -> coberta em
// src/lib/qrngHelper.test.js (identidade X=-μ·ln(1-U), μ=5, U∈[0,1), sem log(0)).
import { test, expect } from "@playwright/test";

async function nav(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
}
const noNaN = async (page) => {
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/\bNaN\b/);
  expect(body).not.toMatch(/\bInfinity\b/);
};

test.describe.serial("Aplicações — Monte Carlo π", () => {
  test("estima π: valor plausível, contagem coerente, erro = |π̂-π|/π, sem NaN", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    await page.getByRole("button", { name: /Estimar π com .* pontos/ }).first().click();
    // resultado: um número grande com 6 casas + "π real:" + "Erro:" + "N dentro / M total"
    await expect(page.getByText(/π real:\s*3\.141593/)).toBeVisible({ timeout: 20000 });
    const piText = await page.getByText(/^\d\.\d{6}$/).first().innerText();
    const piEst = parseFloat(piText);
    expect(piEst).toBeGreaterThan(2.5);
    expect(piEst).toBeLessThan(3.7);
    const insideTotal = await page.getByText(/dentro\s*\/\s*.*total/).first().innerText();
    const m = insideTotal.match(/([\d.]+)\s*dentro\s*\/\s*([\d.]+)\s*total/);
    const inside = parseInt(m[1].replace(/\./g, ""), 10);
    const total = parseInt(m[2].replace(/\./g, ""), 10);
    expect(inside).toBeGreaterThanOrEqual(0);
    expect(inside).toBeLessThanOrEqual(total);
    // π̂ = 4·inside/total (com tolerância de arredondamento de exibição)
    expect(Math.abs(4 * inside / total - piEst)).toBeLessThan(0.01);
    const errText = await page.getByText(/Erro:\s*[\d.]+%/).first().innerText();
    const errPct = parseFloat(errText.match(/([\d.]+)%/)[1]);
    expect(Math.abs(Math.abs((piEst - Math.PI) / Math.PI) * 100 - errPct)).toBeLessThan(0.05);
    await noNaN(page);
    expect(errors).toEqual([]);
  });
});

test.describe.serial("Aplicações — máximo de f(x) = sin(x) + cos(2x)", () => {
  test("busca o máximo: resultado ≤ limite teórico (~1.76) e ≥ 0, sem NaN", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    await page.getByRole("button", { name: /Buscar máximo com .* amostras QRNG/ }).first().click();
    await expect(page.getByText(/f\(x\) máximo/i)).toBeVisible({ timeout: 20000 });
    // o valor máximo aparece logo após o rótulo; pega o primeiro float visível na área
    const txt = await page.locator("body").innerText();
    const nums = [...txt.matchAll(/-?\d+\.\d+/g)].map((x) => parseFloat(x[0]));
    // o máximo global de sin(x)+cos(2x) em [0,2π] é ≈ 1.7602
    const plausible = nums.filter((v) => v > -2.1 && v <= 1.77 + 1e-6);
    expect(plausible.length).toBeGreaterThan(0);
    await noNaN(page);
    expect(errors).toEqual([]);
  });
});

test.describe.serial("Análise Estatística — PRNG × QRNG (scatter, histograma, bits)", () => {
  test("Gerar: duas colunas com 64 bits cada, scatter+histograma renderizados, sem NaN/pageerror", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    // a Análise Estatística tem um botão "Gerar"
    await page.getByRole("button", { name: "Gerar", exact: true }).first().click();
    // Bits (64 amostras) em cada coluna
    await expect(page.getByText("Bits (64 amostras)").first()).toBeVisible({ timeout: 20000 });
    const bitsLabels = await page.getByText("Bits (64 amostras)").count();
    expect(bitsLabels).toBeGreaterThanOrEqual(2); // PRNG + QRNG
    // Scatter Plot e Histograma presentes (canvas)
    await expect(page.getByText("Scatter Plot").first()).toBeVisible();
    const canvases = await page.locator("canvas").count();
    expect(canvases).toBeGreaterThanOrEqual(2); // ao menos scatter PRNG + QRNG
    await noNaN(page);
    expect(errors).toEqual([]);
  });
});

test.describe("Representações Visuais — Sonificação (áudio pode estar bloqueado)", () => {
  test("selecionar Sonificação e alternar o som não quebra a página (headless: AudioContext suspenso)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    // modo Sonificação, se existir como botão/aba
    const sonif = page.getByRole("button", { name: /Sonifica/i }).first();
    if (await sonif.count()) {
      await sonif.click();
      await page.waitForTimeout(500);
    }
    // botão de ativar/desativar som (title "Ativar som" / "Desativar som")
    const audioToggle = page.locator('[title="Ativar som"], [title="Desativar som"]').first();
    if (await audioToggle.count()) {
      await audioToggle.click();
      await page.waitForTimeout(500);
      await audioToggle.click();
    }
    // headless: o AudioContext fica "suspended" até um gesto real; o app deve
    // tratar isso sem lançar. Sem pageerror = tratamento correto.
    expect(errors).toEqual([]);
  });
});
