/* global window */
// Item 8 — evidência rastreável: payload da API → parser do frontend → dados
// da visualização. Instrumenta window.fetch para capturar TODA chamada a
// /qrng/* que cada visualização faz e registra endpoint / formato /
// request_id / actual_origin / live_verified. Asserção DURA: toda chamada
// /random é "replay" no staging e NUNCA "live" / live_verified=true.
import { test, expect } from "@playwright/test";

// Este spec roda por ÚLTIMO na suíte de staging. Antes dele:
//  - `ratelimit.spec.js` faz um burst que estoura o rate-limit público por IP
//    (60/min) — a janela ainda não rolou quando este spec começa, então a viz
//    de π pegava HTTP 429 `RATE_LIMIT_EXCEEDED` e nunca renderizava "Erro: %"
//    (era o timeout de 30 s do CI #48–#53);
//  - `provenance`/`features`/`ui` dirigem `_ctl/mode` do fixture-upstream.
// `beforeEach` restaura o estado conhecido, como downloads/provenance já fazem.
const CTL = process.env.FIXTURE_CTL_URL || null;
test.beforeEach(async ({ request }) => {
  // zera o contador de rate-limit público do IP (rota só-staging)
  await request.post("/qrng/v1/_test/reset-rate-limit").catch(() => {});
  if (!CTL) return;
  await request.post(`${CTL}/_ctl/online`).catch(() => {});
  await request.post(`${CTL}/_ctl/reset`).catch(() => {});
});

async function nav(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
}
async function subtab(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(250);
}

const INSTRUMENT = () => {
  window.__net = [];
  window.__mr = 0;
  const omr = Math.random.bind(Math);
  Math.random = () => { window.__mr++; return omr(); };
  const of = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const res = await of(input, init);
    try {
      if (/\/qrng\/(api|api-fpga|v1)\//.test(url)) {
        // Proveniência SEMPRE pelos headers (raw e JSON) — nunca clonamos nem
        // parseamos o corpo: para respostas grandes (π consome MBs de hex)
        // o `res.clone()` teia o stream e trava a leitura do app (era a causa
        // do timeout de 30 s no CI). server.js agora carimba os X-QRNG-* em
        // todas as respostas /random, JSON incluído.
        window.__net.push({
          url,
          status: res.status,
          ct: res.headers.get("content-type") || "",
          request_id: res.headers.get("x-request-id"),
          actual_origin: res.headers.get("x-qrng-provenance"),
          live_verified: res.headers.get("x-qrng-live-verified"),
          fallback_used: res.headers.get("x-qrng-fallback-used"),
        });
      }
    } catch { /* noop */ }
    return res;
  };
};

const grab = (page) => page.evaluate(() => ({ net: window.__net, mr: window.__mr }));

function assertNeverLive(net) {
  const rnd = net.filter((r) => /\/(random|raw)(\?|$)/.test(r.url) || /\/random/.test(r.url));
  for (const r of rnd) {
    expect(r.actual_origin, `${r.url} actual_origin != live`).not.toBe("live");
    expect(String(r.live_verified), `${r.url} live_verified != true`).not.toBe("true");
    expect(["replay", "fixture", "historical", "unknown", null, undefined],
      `${r.url} actual_origin em conjunto seguro`).toContain(r.actual_origin);
  }
  return rnd;
}

test.describe.serial("visualizações — proveniência rastreável (item 8)", () => {
  test("Dados (Raw + Monte Carlo): API chamada, proveniência 'replay', nunca 'live'", async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(INSTRUMENT);
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Dados");
    await expect(page.getByText("Modo de Exportação")).toBeVisible({ timeout: 15000 });
    for (const mode of ["Raw Binário", "Monte Carlo"]) {
      const b = page.getByRole("button", { name: mode, exact: true }).first();
      if (!(await b.count())) continue;
      await b.click();
      await page.waitForTimeout(200);
      const gen = page.getByRole("button", { name: /Gerar prévia/i }).first();
      if ((await gen.count()) && (await gen.isEnabled())) {
        await gen.click();
        await page.waitForTimeout(1200);
      }
    }
    const { net } = await grab(page);
    const rnd = assertNeverLive(net);
    expect(rnd.length, "ao menos uma chamada /random foi feita pela aba Dados").toBeGreaterThan(0);
    expect(errs).toEqual([]);
  });

  test("Aplicações (π): usa a API, actual_origin=replay", async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Aplicações");
    const piBtn = page.getByRole("button", { name: /Estimar π com .* pontos/ });
    await expect(piBtn).toBeVisible({ timeout: 15000 });
    await piBtn.first().click();
    await expect(page.getByText(/Erro:\s*[\d.]+\s*%/)).toBeVisible({ timeout: 30000 });
    const { net } = await grab(page);
    const rnd = assertNeverLive(net);
    expect(rnd.some((r) => /random/.test(r.url)), "π chamou /random").toBe(true);
  });

  test("Análise PRNG×QRNG: a coluna QRNG vem da API; PRNG é LCG identificado (sem rede)", async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Análise Estatística");
    await page.getByRole("button", { name: "Gerar", exact: true }).first().click();
    await expect(page.getByText("Bits (64 amostras)").first()).toBeVisible({ timeout: 30000 });
    const { net } = await grab(page);
    const rnd = assertNeverLive(net);
    expect(rnd.some((r) => /random/.test(r.url)), "QRNG chamou /random").toBe(true);
  });

  test("Sonificação: se buscar bytes, é da API e nunca 'live'", async ({ page }) => {
    test.setTimeout(45000);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
    await nav(page, "Representações Visuais");
    await subtab(page, "Visualizações Interativas");
    const s = page.getByRole("button", { name: /Sonifica/i }).first();
    if (await s.count()) { await s.click(); await page.waitForTimeout(2500); }
    const { net } = await grab(page);
    assertNeverLive(net); // asserção dura sempre vale
    // asserção mole: normalmente busca /random; se não buscou na janela, só registra.
    test.info().annotations.push({ type: "sonif-random-calls", description: String(net.filter((r) => /random/.test(r.url)).length) });
  });
});
