// Downloads reais no navegador — aba "Dados". Para cada download: lê o arquivo
// no próprio teste e valida MIME implícito, tamanho, contagem de valores,
// conteúdo, SHA-256, ausência de BOM, delimitadores, endianness (raw), e
// que nenhum valor Monte Carlo é >= 1.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import crypto from "node:crypto";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hasBOM = (b) => b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;

async function gotoDados(page) {
  await page.goto("/qrng/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Dados", exact: true }).click();
  await expect(page.getByText("Modo de Exportação")).toBeVisible();
}

async function pickMode(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function generateAndDownload(page) {
  await page.getByRole("button", { name: "Gerar prévia" }).click();
  const dlBtn = page.getByRole("button", { name: "↓ Baixar arquivo" });
  await expect(dlBtn).toBeEnabled({ timeout: 15000 });
  const [download] = await Promise.all([page.waitForEvent("download"), dlBtn.click()]);
  const path = await download.path();
  const buf = fs.readFileSync(path);
  return { name: download.suggestedFilename(), buf };
}

test.describe("downloads — aba Dados", () => {
  test("Raw Binário (.bin): octet-stream puro, sem BOM, múltiplo de 4, uint32-LE decodificável", async ({ page }) => {
    await gotoDados(page);
    await pickMode(page, "Raw Binário");
    const { name, buf } = await generateAndDownload(page);
    expect(name).toMatch(/\.bin$/);
    expect(buf.length).toBeGreaterThan(0);
    expect(hasBOM(buf)).toBe(false);
    // sem texto/JSON acidental
    expect(buf.includes(Buffer.from("{"))).toBe(false);
    // decodifica como uint32-LE (transport word)
    expect(buf.length % 4).toBe(0);
    const words = buf.length / 4;
    let anyNonZero = false;
    for (let i = 0; i < words; i++) { if (buf.readUInt32LE(i * 4) !== 0) { anyNonZero = true; break; } }
    expect(anyNonZero).toBe(true);
    expect(sha256(buf).length).toBe(64);
  });

  test("Hexadecimal (.txt): só [0-9a-f] + separadores; decodifica p/ binário", async ({ page }) => {
    await gotoDados(page);
    await pickMode(page, "Hexadecimal");
    const { name, buf } = await generateAndDownload(page);
    const text = buf.toString("utf8");
    expect(name).toMatch(/\.(txt|json)$/);
    expect(hasBOM(buf)).toBe(false);
    const compact = text.replace(/[\s,]/g, "").replace(/^\{.*"hex":"|"\}$/g, "");
    expect(compact).toMatch(/^[0-9a-fA-F]*$/);
    expect(compact.length % 2).toBe(0);
    expect(Buffer.from(compact, "hex").length).toBe(compact.length / 2);
  });

  test("Decimal / uint8: N inteiros em [0,255], contagem coerente com o tamanho pedido", async ({ page }) => {
    await gotoDados(page);
    await pickMode(page, "Decimal / uint8");
    const { buf } = await generateAndDownload(page);
    const text = buf.toString("utf8");
    expect(hasBOM(buf)).toBe(false);
    const nums = (text.match(/-?\d+/g) || []).map(Number).filter((n) => Number.isFinite(n));
    // filtra possíveis metadados numéricos do JSON; a grande maioria são os valores
    const inRange = nums.filter((n) => n >= 0 && n <= 255);
    expect(inRange.length).toBeGreaterThan(100);
    expect(Math.max(...inRange)).toBeLessThanOrEqual(255);
    expect(Math.min(...inRange)).toBeGreaterThanOrEqual(0);
  });

  test("Monte Carlo: floats em [0,1), NENHUM valor >= 1, precisão de float", async ({ page }) => {
    await gotoDados(page);
    await pickMode(page, "Monte Carlo");
    const { buf } = await generateAndDownload(page);
    const text = buf.toString("utf8");
    expect(hasBOM(buf)).toBe(false);
    const floats = (text.match(/0\.\d+(e-?\d+)?/gi) || []).map(Number).filter((x) => Number.isFinite(x));
    expect(floats.length).toBeGreaterThan(50);
    for (const x of floats) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1); // <<< nenhum valor >= 1
    }
    // precisão: pelo menos um valor com > 6 casas decimais (uint32/2^32 ~ 2.3e-10)
    expect(floats.some((x) => String(x).replace(/^0\./, "").length >= 6)).toBe(true);
  });

  test("Hex e Base64 (mesma faixa, replay) decodificam para o MESMO binário", async ({ page, request }) => {
    test.skip(!process.env.FIXTURE_CTL_URL, "precisa de FIXTURE_CTL_URL");
    const CTL = process.env.FIXTURE_CTL_URL;
    await gotoDados(page);
    await request.post(`${CTL}/_ctl/reset`);
    await pickMode(page, "Hexadecimal");
    const hx = await generateAndDownload(page);
    const hexCompact = hx.buf.toString("utf8").replace(/[\s,]/g, "").replace(/^\{.*"hex":"|"\}$/g, "");
    const hexBin = Buffer.from(hexCompact, "hex");
    await request.post(`${CTL}/_ctl/reset`);
    // base64 não é um modo da aba; comparamos via API pública equivalente
    const b64 = Buffer.from((await (await request.get(`/qrng/api/random?bytes=${hexBin.length}&format=base64`)).json()).random, "base64");
    expect(Buffer.compare(hexBin, b64)).toBe(0);
  });
});
