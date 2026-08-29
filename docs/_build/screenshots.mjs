// Captura prints da interface (bundle de produção qrng-web:9e36a90 servido
// localmente por serve_local.mjs, consumindo os endpoints QRNG ABERTOS da
// produção). Sem login, sem cookie, sem token.
//
// Uso: node docs/_build/serve_local.mjs &   (deixe rodando)
//      node docs/_build/screenshots.mjs
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..", "images");
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.LOCAL_BASE || "http://127.0.0.1:5199/qrng/";
const PROD = "https://bongo.dobslit.com";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("  [pageerror]", e.message));

async function shot(name, { full = false, clip } = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: full, clip });
  log("  saved", name);
}
async function nav(label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await sleep(700);
}
async function click(name, opts = {}) {
  try {
    const btn = page.getByRole("button", { name, ...opts }).first();
    await btn.click({ timeout: 6000 });
    return true;
  } catch { log("  (botão não encontrado:", name, ")"); return false; }
}

try {
  log("abrindo", BASE);
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await sleep(2500); // 1º health-check + fontes

  // 1 — página inicial
  await nav("Kapuã");
  await sleep(1500);
  await shot("01-home-kapua.png");

  // 3 — barra de hardware (topo) — recorte
  await shot("03-barra-hardware.png", { clip: { x: 0, y: 0, width: 1440, height: 46 } });

  // 2 — Configurações (fontes)
  await nav("⚙ Configurações");
  await sleep(1200);
  await shot("02-config-fonte.png", { full: true });

  // 4-8 — Dados
  await nav("Dados");
  await sleep(800);
  for (const [tab, file] of [
    ["Raw Binário", "04-dados-raw.png"],
    ["Hexadecimal", "05-dados-hex.png"],
    ["Decimal / uint8", "06-dados-uint8.png"],
    ["Faixa Personalizada", "07-dados-faixa.png"],
    ["Monte Carlo", "08-dados-montecarlo.png"],
  ]) {
    try {
      await page.getByRole("button", { name: tab, exact: true }).first().click();
      await sleep(400);
      await click("Gerar prévia");
      await sleep(2500);
      await shot(file, { full: true });
    } catch (e) { log("  Dados/" + tab + " falhou:", e.message); }
  }

  // 9-10 — Representações Visuais / Análise Estatística
  await nav("Representações Visuais");
  await sleep(600);
  try {
    await page.getByRole("button", { name: "Análise Estatística" }).first().click();
    await sleep(600);
    await click("Gerar");
    await sleep(3500);
    await shot("09-analise-scatter-hist-bits.png", { full: true });
    // rola até o fluxo em tempo real
    await page.mouse.wheel(0, 1600);
    await sleep(3000);
    await shot("10-analise-stream.png");
  } catch (e) { log("  Análise Estatística falhou:", e.message); }

  // 11-15 — Visualizações Interativas
  try {
    await page.getByRole("button", { name: "Visualizações Interativas" }).first().click();
    await sleep(1200);
    for (const [mode, file] of [
      ["Galaxia", "11-viz-galaxia.png"],
      ["Mandala", "12-viz-mandala.png"],
      ["LCG Cracker", "13-viz-cracker.png"],
      ["MT19937 Clone", "14-viz-mtclone.png"],
      ["Sonificação", "15-viz-sonificacao.png"],
    ]) {
      try {
        await page.getByRole("button", { name: mode, exact: true }).first().click();
        await sleep(4500); // deixa animar com bytes reais
        await shot(file);
      } catch (e) { log("  viz/" + mode + " falhou:", e.message); }
    }
  } catch (e) { log("  Visualizações Interativas falhou:", e.message); }

  // 16-21 — Aplicações
  await nav("Aplicações");
  await sleep(900);
  try {
    await click("Estimar π com 1.000 pontos");
    await sleep(3500);
    await shot("16-app-montecarlo-pi.png");
  } catch (e) { log("  π falhou:", e.message); }
  try {
    await page.getByPlaceholder(/Ana Silva/).first().fill("Ana Silva\nBruno Costa\nCarla Mendes\nDaniel Rocha");
    await click("Sortear");
    await sleep(2500);
    await shot("17-app-sorteio.png");
  } catch (e) { log("  sorteio falhou:", e.message); }
  try {
    await click("Lançar moeda"); await sleep(1800);
    await click("Lançar dado"); await sleep(2200);
    await shot("18-app-jogos.png");
  } catch (e) { log("  jogos falhou:", e.message); }
  try {
    await click("Iniciar walk (256 passos)");
    await sleep(2500);
    await shot("19-app-randomwalk.png");
  } catch (e) { log("  walk falhou:", e.message); }
  try {
    await click("Buscar máximo com 500 amostras QRNG");
    await sleep(2500);
    await shot("20-app-otimizacao.png");
  } catch (e) { log("  otim falhou:", e.message); }
  try {
    await page.mouse.wheel(0, -4000); // volta ao topo (Chave / Seed)
    await sleep(600);
    await click("Gerar chave quântica"); await sleep(800);
    await shot("21-app-chave-seed-desabilitada.png");
  } catch (e) { log("  chave/seed falhou:", e.message); }

  // 22 — Teste NIST
  await nav("Teste NIST");
  await sleep(3000);
  await shot("22-nist.png", { full: true });

  // 23 — Desenvolvedor (tela de login, campos vazios — não sensível)
  await nav("Desenvolvedor");
  await sleep(1500);
  await shot("23-desenvolvedor-login.png", { full: true });

  // 24-25 — Swagger / ReDoc (endpoints públicos de produção)
  await page.goto(PROD + "/qrng/v1/docs/", { waitUntil: "networkidle", timeout: 30000 });
  await sleep(2500);
  await shot("24-swagger.png");
  await page.goto(PROD + "/qrng/v1/redoc", { waitUntil: "networkidle", timeout: 30000 });
  await sleep(3500);
  await shot("25-redoc.png");

  log("OK — imagens em", OUT);
} catch (e) {
  log("ERRO:", e.message);
  await shot("_erro.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
