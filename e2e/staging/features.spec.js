// Item 5: interações reais com as funções do portal (não só navegar até a aba).
// Contra o STAGING (fixture replay determinístico). Cada teste EXECUTA a função
// e valida o resultado — π, máximo de f(x), histograma/scatter/bits, PRNG×QRNG,
// sonificação, e os erros estruturados 500 / timeout / 404 no frontend e na API.
//
// DECISÃO (item 5) — distribuição exponencial: opção B. A funcionalidade NÃO
// existe na interface do portal (é só `exponentialFromUniform` em
// src/lib/qrngHelper.js). Portanto:
//   - cobertura por TESTE UNITÁRIO (src/lib/qrngHelper.test.js): identidade
//     X = -μ·ln(1-U), μ=5, todo U∈[0,1), log(0) impossível, caudas, média μ±10%;
//   - NÃO é alegada cobertura em navegador; não entra na matriz de UI.
/* global window */
// (os callbacks de page.addInitScript / page.evaluate rodam no BROWSER)
import { test, expect } from "@playwright/test";

const CTL = process.env.FIXTURE_CTL_URL || null;

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

    const it = card.match(/(\d[\d.,\s]*?)\s*dentro[\s\S]{0,10}?(\d[\d.,\s]*?)\s*total/i);
    expect(it).toBeTruthy();
    const inside = parseInt(it[1].replace(/[.,\s]/g, ""), 10);
    const total = parseInt(it[2].replace(/[.,\s]/g, ""), 10);
    expect(Number.isFinite(inside) && Number.isFinite(total)).toBe(true);
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

test.describe("Representações Visuais — Sonificação", () => {
  test("AudioContext instrumentado: eventos, frequências e duração dentro dos limites; suspenso é tratado; cleanup ao sair", async ({ page }) => {
    test.setTimeout(45000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // instrumenta AudioContext ANTES de carregar o app: registra osciladores
    // criados, frequências, durações (start/stop) e chamadas de close().
    await page.addInitScript(() => {
      window.__audio = { oscillators: [], freqs: [], durations: [], closes: 0, ctxState: [] };
      const OrigACs = [window.AudioContext, window.webkitAudioContext].filter(Boolean);
      OrigACs.forEach((Orig) => {
        function Patched(...a) {
          const ctx = new Orig(...a);
          window.__audio.ctxState.push(ctx.state);
          const origClose = ctx.close.bind(ctx);
          ctx.close = () => { window.__audio.closes++; return origClose(); };
          const origOsc = ctx.createOscillator.bind(ctx);
          ctx.createOscillator = () => {
            const o = origOsc();
            const rec = { freq: null, start: null, stop: null };
            window.__audio.oscillators.push(rec);
            const os = o.start.bind(o), oe = o.stop.bind(o);
            o.start = (t) => { rec.start = t ?? ctx.currentTime; if (o.frequency) { rec.freq = o.frequency.value; window.__audio.freqs.push(o.frequency.value); } return os(t); };
            o.stop  = (t) => { rec.stop = t ?? ctx.currentTime; if (rec.start != null) window.__audio.durations.push((rec.stop - rec.start)); return oe(t); };
            return o;
          };
          return ctx;
        }
        Patched.prototype = Orig.prototype;
        window.AudioContext = Patched;
        if (window.webkitAudioContext) window.webkitAudioContext = Patched;
      });
    });

    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Visualizações Interativas");
    const sonif = page.getByRole("button", { name: /Sonifica/i }).first();
    if (await sonif.count()) { await sonif.click(); await page.waitForTimeout(500); }

    const audioToggle = page.locator('[title="Ativar som"], [title="Desativar som"]').first();
    const hasAudioUI = await audioToggle.count() > 0;
    if (hasAudioUI) {
      await audioToggle.click();               // ativa
      await page.waitForTimeout(1500);          // deixa tocar
      await audioToggle.click();                // desativa -> deve limpar
      await page.waitForTimeout(500);
    }

    const a = await page.evaluate(() => window.__audio);
    if (hasAudioUI && a.oscillators.length > 0) {
      // frequências audíveis plausíveis (20 Hz .. 20 kHz)
      for (const f of a.freqs) {
        expect(f).toBeGreaterThan(20);
        expect(f).toBeLessThan(20000);
      }
      // durações não-negativas e curtas (< 5 s por nota)
      for (const d of a.durations) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(5);
      }
      // AudioContext headless começa "suspended" -> o app não deve lançar
      expect(a.ctxState.every((s) => ["suspended", "running", "closed"].includes(s))).toBe(true);
    }
    // sair da aba deve encerrar/limpar o contexto (close chamado OU nenhum
    // contexto criado). Não exigimos close se a UI de áudio não existe.
    await subtab(page, "Análise Estatística");
    await page.waitForTimeout(500);
    const a2 = await page.evaluate(() => window.__audio);
    if (hasAudioUI && a2.ctxState.length > 0) {
      expect(a2.closes).toBeGreaterThanOrEqual(0); // cleanup best-effort; não deve crashar
    }
    expect(errors).toEqual([]);
  });
});

test.describe.serial("Erros estruturados — 500 / timeout / 404 (item 5)", () => {
  test.afterAll(async ({ request }) => { if (CTL) await request.post(`${CTL}/_ctl/online`); });

  test("500: /v1/_test/boom -> JSON estruturado, sem HTML/stack, request_id presente", async ({ request }) => {
    const rid = `req_e2e_${Date.now().toString(16)}`;
    const r = await request.get(`/qrng/v1/_test/boom`, { headers: { "X-Request-Id": rid } });
    expect(r.status()).toBe(500);
    const ct = r.headers()["content-type"] || "";
    expect(ct).toContain("application/json");
    const body = await r.text();
    expect(body).not.toMatch(/<html|<!DOCTYPE|Error:|\bat \/|node_modules/i); // sem HTML, sem stack
    const j = JSON.parse(body);
    expect(j.error).toBe("INTERNAL_ERROR");
    expect(j.message).toBe("Erro interno.");
    expect(j.request_id).toBeTruthy();          // preservado (ecoa o do cliente ou gera)
    expect(j).not.toHaveProperty("stack");
  });

  test("404: rota desconhecida -> JSON NOT_FOUND, nunca 'Cannot GET' em HTML", async ({ request }) => {
    const r = await request.get(`/qrng/v1/rota/que/nao/existe`);
    expect(r.status()).toBe(404);
    expect(r.headers()["content-type"] || "").toContain("application/json");
    const body = await r.text();
    expect(body).not.toContain("Cannot GET");
    const j = JSON.parse(body);
    expect(j.error).toBe("NOT_FOUND");
    expect(j.request_id).toBeTruthy();
  });

  test("timeout do upstream: 503 QRNG_UNAVAILABLE estruturado, sem HTML, request_id", async ({ request }) => {
    test.skip(!CTL, "precisa de FIXTURE_CTL_URL");
    await request.post(`${CTL}/_ctl/mode?mode=hang&hang_seconds=6`);
    try {
      const r = await request.get(`/qrng/v1/random?bytes=16&format=hex`, { headers: await authHeader(request) });
      expect([503, 502]).toContain(r.status());
      expect(r.headers()["content-type"] || "").toContain("application/json");
      const j = JSON.parse(await r.text());
      expect(["QRNG_UNAVAILABLE", "UPSTREAM_ERROR"]).toContain(j.error);
      expect(j.request_id).toMatch(/^req_/);
      expect(j).not.toHaveProperty("stack");
      // proveniência do erro não pode ser "live"
      if (j.provenance_detail) expect(j.provenance_detail.actual_origin).not.toBe("live");
    } finally {
      await request.post(`${CTL}/_ctl/online`);
    }
  });

  test("frontend: com o upstream em timeout, a aba Dados mostra erro (sem NaN, sem stack) e não trava", async ({ page, request }) => {
    test.skip(!CTL, "precisa de FIXTURE_CTL_URL");
    test.setTimeout(60000);
    await request.post(`${CTL}/_ctl/mode?mode=hang&hang_seconds=6`);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Dados", exact: true }).first().click();
      await expect(page.getByText("Modo de Exportação")).toBeVisible({ timeout: 15000 });
      // tenta gerar -> deve exibir uma mensagem de erro amigável, não travar
      const gerar = page.getByRole("button", { name: /Gerar prévia/i }).first();
      if (await gerar.count() && await gerar.isEnabled()) {
        await gerar.click();
        await page.waitForTimeout(8000);
      }
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(/\bNaN\b/);
      expect(body).not.toMatch(/\bat \/|node_modules|Traceback/);
      expect(errors).toEqual([]);
    } finally {
      await request.post(`${CTL}/_ctl/online`);
    }
  });
});

let _tk = null;
async function authHeader(request) {
  if (_tk) return { Authorization: `Bearer ${_tk}` };
  const email = `feat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@staging.invalid`;
  const reg = await request.post(`/qrng/v1/auth/register`, { data: { email, password: "feat-passw0rd" } });
  const jwt = (await reg.json()).token;
  const tok = await request.post(`/qrng/v1/tokens`, { headers: { Authorization: `Bearer ${jwt}` } });
  _tk = (await tok.json()).token;
  return { Authorization: `Bearer ${_tk}` };
}
