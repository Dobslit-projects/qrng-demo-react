// Renderiza docs/GUIA_DO_USUARIO_KAPUA.html -> docs/GUIA_DO_USUARIO_KAPUA.pdf
// usando o Chromium do Playwright (já instalado). Sem rede.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(here, "..", "GUIA_DO_USUARIO_KAPUA.html");
const pdfPath = path.resolve(here, "..", "GUIA_DO_USUARIO_KAPUA.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
await page.pdf({
  path: pdfPath,
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", bottom: "18mm", left: "15mm", right: "15mm" },
  displayHeaderFooter: true,
  headerTemplate: `<div style="font-size:7px;color:#888;width:100%;padding:0 15mm;text-align:right;">Kapuã — Guia do Usuário</div>`,
  footerTemplate: `<div style="font-size:7px;color:#888;width:100%;padding:0 15mm;display:flex;justify-content:space-between;">
    <span>Revisão 2026-08-29 · frontend qrng-web:9e36a90 · API qrng-client-api:4137bfe</span>
    <span>pág. <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
});
await browser.close();
console.log("PDF ->", pdfPath);
