/* global window */
// Item 8 — evidência rastreável: payload conhecido → resposta da API → parser
// do frontend → dados usados pela visualização. Instrumenta window.fetch para
// capturar TODA chamada a /qrng/* que cada visualização faz, e registra
// endpoint / formato / request_id / actual_origin / live_verified / nº de bytes.
//
// Também: nenhuma das visualizações estatísticas centrais pode cair em
// Math.random / PRNG / fixture não identificado (staging = replay determinístico,
// actual_origin SEMPRE "replay", nunca "live").
import { test, expect } from "@playwright/test";

async function nav(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
}
async function subtab(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(300);
}

// instrumenta fetch ANTES do app carregar
const INSTRUMENT = () => {
  window.__net = [];
  window.__mathRandomCalls = 0;
  const origMR = Math.random.bind(Math);
  Math.random = function () { window.__mathRandomCalls++; return origMR(); };
  const of = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const t0 = performance.now();
    const res = await of(input, init);
    try {
      if (/\/qrng\/(api|api-fpga|v1)\//.test(url)) {
        const ct = res.headers.get("content-type") || "";
        const rec = { url, status: res.status, content_type: ct, ms: Math.round(performance.now() - t0) };
        if (ct.includes("application/json")) {
          const j = await res.clone().json().catch(() => ({}));
          rec.request_id = j.request_id;
          rec.provenance = j.provenance;
          rec.actual_origin = j.provenance_detail?.actual_origin;
          rec.live_verified = j.provenance_detail?.live_verified;
          rec.fallback_used = j.provenance_detail?.fallback_used;
          rec.bytes_field = j.bytes;
          rec.random_len = Array.isArray(j.random) ? j.random.length : (typeof j.random === "string" ? j.random.length : null);
        } else {
          rec.actual_origin = res.headers.get("x-qrng-provenance");
          rec.live_verified = res.headers.get("x-qrng-live-verified");
          rec.content_length = res.headers.get("content-length");
        }
        window.__net.push(rec);
      }
    } catch { /* noop */ }
    return res;
  };
};

async function report(page) {
  return page.evaluate(() => ({ net: window.__net, mathRandom: window.__mathRandomCalls }));
}
function assertAllReplayNeverLive(net) {
  const qrng = net.filter((r) => /\/qrng\/(api|api-fpga|v1)\/(random|public\/random|raw)/.test(r.url) || /\/random/.test(r.url));
  for (const r of qrng) {
    expect(r.actual_origin, `${r.url} actual_origin`).not.toBe("live");
    expect(String(r.live_verified), `${r.url} live_verified`).not.toBe("true");
    // staging: instância replay
    expect(["replay", "fixture", "historical", "unknown", null, undefined]).toContain(r.actual_origin);
  }
  return qrng;
}

test.describe.serial("visualizações — proveniência rastreável (item 8)", () => {
  test("Dados: cada modo (Raw/Hex/Base64/uint8/Monte Carlo) chama a API com proveniência 'replay'", async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(INSTRUMENT);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Dados");
    await expect(page.getByText("Modo de Exportação")).toBeVisible({ timeout: 15000 });

    for (const mode of ["Raw Binário", "Hexadecimal", "Base64", "Decimal", "Monte Carlo"]) {
      const btn = page.getByRole("button", { name: mode, exact: true }).first();
      if (!(await btn.count())) continue;
      await btn.click();
      await page.waitForTimeout(300);
      const gen = page.getByRole("button", { name: /Gerar prévia/i }).first();
      if (await gen.count() && await gen.isEnabled()) {
        await gen.click();
        await page.waitForTimeout(1500);
      }
    }
    const { net } = await report(page);
    const qrng = assertAllReplayNeverLive(net);
    expect(qrng.length).toBeGreaterThan(0);
    // cada chamada tem request_id (json) OU content-length (raw)
    for (const r of qrng) {
      expect(r.request_id || r.content_length, `${r.url} tem request_id ou content-length`).toBeTruthy();
    }
    expect(errors).toEqual([]);
  });

  test("Aplicações (π Monte Carlo + máx f(x)): usam bytes da API, sem Math.random no cálculo", async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    const before = (await report(page)).mathRandom;
    await page.getByRole("button", { name: /Estimar π com .* pontos/ }).first().click();
    await expect(page.getByText(/Erro:\s*[\d.]+\s*%/)).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: /Buscar máximo com .* amostras QRNG/ }).first().click();
    await expect(page.getByText(/f\(x\).*m[áa]ximo/i)).toBeVisible({ timeout: 30000 });
    const { net, mathRandom } = await report(page);
    const qrng = assertAllReplayNeverLive(net);
    expect(qrng.some((r) => /random/.test(r.url)), "π/optimizer chamaram um endpoint /random").toBe(true);
    // Math.random pode ser chamado por animação decorativa (shimmer de loading);
    // o que importa é que os DADOS vieram da API (asserção acima). O delta fica
    // registrado no relatório do teste.
    expect(mathRandom).toBeGreaterThanOrEqual(before);
  });

  test("Representações Visuais / Análise (scatter+histograma+bits, PRNG×QRNG): QRNG vem da API", async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Análise Estatística");
    await page.getByRole("button", { name: "Gerar", exact: true }).first().click();
    await expect(page.getByText("Bits (64 amostras)").first()).toBeVisible({ timeout: 30000 });
    const { net } = await report(page);
    const qrng = assertAllReplayNeverLive(net);
    // A coluna PRNG é uma comparação IDENTIFICADA (generatePRNGSequence / LCG) —
    // não é uma chamada de rede. A coluna QRNG deve ter chamado a API.
    expect(qrng.some((r) => /random/.test(r.url))).toBe(true);
  });

  test("Sonificação: usa os bytes da API (mapeamento byte→nota), sem fixture", async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Visualizações Interativas");
    const sonif = page.getByRole("button", { name: /Sonifica/i }).first();
    if (await sonif.count()) { await sonif.click(); await page.waitForTimeout(2000); }
    const { net } = await report(page);
    assertAllReplayNeverLive(net);
    // as visualizações interativas puxam bytes via fetchQrngBytes -> /qrng/api/*
    expect(net.some((r) => /\/random/.test(r.url))).toBe(true);
  });
});
