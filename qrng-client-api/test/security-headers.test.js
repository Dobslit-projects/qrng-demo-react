"use strict";
// Preparação para pentest (2026-09-30): cabeçalhos de segurança do helmet,
// X-Powered-By ausente, CSP estrita nas respostas JSON e CSP própria (com
// inline + cdn.redoc.ly) só nas páginas de documentação. O CORS "*" da API
// pública continua intacto.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");

const testDbPath = path.join(os.tmpdir(), `qrng-sechdr-${Date.now()}.db`);
let app, db;

const upstream = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ source_status: "online" }));
});

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-for-ci";
  process.env.QRNG_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
  ({ app, db } = require("../server"));
});
after(() => {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(testDbPath); } catch (_) {}
  upstream.close();
});

const request = require("supertest");

test("JSON: X-Powered-By ausente, nosniff/frameguard presentes, CSP estrita, sem HSTS (fica no nginx)", async () => {
  const r = await request(app).get("/v1/rota/inexistente");
  assert.equal(r.status, 404);
  assert.equal(r.headers["x-powered-by"], undefined);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  assert.match(r.headers["content-security-policy"] || "", /default-src 'none'/);
  assert.match(r.headers["content-security-policy"] || "", /frame-ancestors 'none'/);
  assert.equal(r.headers["strict-transport-security"], undefined);
});

test("CORS público continua aberto (*) após o helmet", async () => {
  const r = await request(app).get("/v1/rota/inexistente").set("Origin", "https://qualquer.example");
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.headers["cross-origin-resource-policy"], "cross-origin");
});

test("Swagger UI (/v1/docs/) responde 200 com CSP que permite inline, não a estrita", async () => {
  const r = await request(app).get("/v1/docs/");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"] || "", /text\/html/);
  const csp = r.headers["content-security-policy"] || "";
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /default-src 'none'/);
});

test("ReDoc (/v1/redoc) responde 200 e a CSP libera cdn.redoc.ly, Google Fonts e blob: (worker)", async () => {
  const r = await request(app).get("/v1/redoc");
  assert.equal(r.status, 200);
  const csp = r.headers["content-security-policy"] || "";
  assert.match(csp, /https:\/\/cdn\.redoc\.ly/);
  assert.match(csp, /fonts\.googleapis\.com/);
  assert.match(csp, /worker-src 'self' blob:/);
  // Todo recurso externo referenciado pelo HTML precisa estar coberto pela CSP.
  const external = [...r.text.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).origin);
  for (const origin of external) {
    assert.ok(csp.includes(origin), `origem ${origin} referenciada pelo ReDoc não está na CSP`);
  }
});
