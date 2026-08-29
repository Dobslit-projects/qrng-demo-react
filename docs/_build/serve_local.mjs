// Servidor local para capturar prints fiéis da interface de PRODUÇÃO.
//
// Serve o bundle de produção (dist/ == qrng-web:9e36a90, mesmo hash
// index-GEJGDRrN.js) em http://127.0.0.1:5199/qrng/ e faz proxy reverso dos
// endpoints de dados ABERTOS da produção (nginx expõe /qrng/api, /qrng/api-fpga
// e /qrng/nist sem cookie de sessão — verificado 2026-08-29).
//
// /qrng/v1/random e /qrng/v1/raw são reescritos para /qrng/api/random|raw
// (as Visualizações Interativas chamam a rota autenticada; sem login não há
// JWT — a reescrita dá bytes QRNG REAIS de produção sem credencial alguma).
//
// Nenhum cookie, token ou credencial é usado, lido ou armazenado.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "..", "dist");
const PORT = Number(process.env.PORT || 5199);
const UPSTREAM = "bongo.dobslit.com";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".map": "application/json",
};

function proxy(req, res, upstreamPath) {
  const opts = {
    host: UPSTREAM, port: 443, method: req.method, path: upstreamPath,
    headers: { ...req.headers, host: UPSTREAM },
  };
  delete opts.headers["accept-encoding"]; // evita corpo comprimido no proxy
  const up = https.request(opts, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end("proxy error: " + e.message); });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = url.pathname;

  // ── proxy dos endpoints de dados abertos ──────────────────────────────────
  if (p.startsWith("/qrng/api/") || p.startsWith("/qrng/api-fpga/") || p.startsWith("/qrng/nist/")) {
    return proxy(req, res, p + url.search);
  }
  if (p === "/qrng/v1/random" || p === "/qrng/v1/raw") {
    // rota autenticada -> equivalente aberta (bytes reais de produção, sem token)
    const mapped = p === "/qrng/v1/raw" ? "/qrng/api/random" : "/qrng/api/random";
    const search = p === "/qrng/v1/raw"
      ? (url.search ? url.search + "&format=raw" : "?format=raw")
      : url.search;
    return proxy(req, res, mapped + search);
  }
  if (p.startsWith("/qrng/v1/")) {
    // demais rotas autenticadas: repassa (vão responder 401 sem token; as
    // páginas de visualização não dependem delas)
    return proxy(req, res, p + url.search);
  }

  // ── estáticos do bundle (base "/qrng") ────────────────────────────────────
  if (p === "/" || p === "/qrng" || p === "/qrng/") p = "/qrng/index.html";
  let rel = p.replace(/^\/qrng\//, "");
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end("forbidden"); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, "index.html"); // SPA fallback
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`local prod-bundle server: http://127.0.0.1:${PORT}/qrng/  (proxy -> https://${UPSTREAM})`);
});
