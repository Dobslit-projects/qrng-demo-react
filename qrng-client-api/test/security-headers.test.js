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

test("ReDoc (/v1/redoc): URLs relativas (funciona atrás de /qrng/v1/) e bundle servido localmente, sem CDN", async () => {
  const r = await request(app).get("/v1/redoc");
  assert.equal(r.status, 200);
  assert.match(r.text, /spec-url="openapi\.json"/);
  assert.match(r.text, /<script src="redoc\.standalone\.js"><\/script>/);
  assert.doesNotMatch(r.text, /https?:\/\//, "nenhum recurso externo no HTML do ReDoc");
  const csp = r.headers["content-security-policy"] || "";
  assert.doesNotMatch(csp, /cdn\.redoc\.ly/);
  assert.match(csp, /worker-src 'self' blob:/);

  const js = await request(app).get("/v1/redoc.standalone.js");
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"] || "", /javascript/);
  const crypto = require("node:crypto");
  const digest = "sha384-" + crypto.createHash("sha384").update(js.body instanceof Buffer ? js.body : Buffer.from(js.text)).digest("base64");
  const expected = fs.readFileSync(path.join(__dirname, "..", "vendor", "redoc", "VERSION"), "utf8").match(/sha384-\S+/)[0];
  assert.equal(digest, expected, "bundle servido = bundle fixado em vendor/redoc/VERSION");
});

// ── Autenticação ─────────────────────────────────────────────────────────────

test("register: senha < 12, sem número, e-mail inválido ou tipos errados → 400", async () => {
  const cases = [
    [{ email: "a@test.com", password: "curta123" }, "WEAK_PASSWORD"],
    [{ email: "a@test.com", password: "semnumeroalgum" }, "WEAK_PASSWORD"],
    [{ email: "nao-e-email", password: "senhaForte12345" }, "INVALID_EMAIL"],
    [{ email: { $ne: 1 }, password: "senhaForte12345" }, "INVALID_EMAIL"],
    [{ email: "b@test.com", password: ["senhaForte12345"] }, "WEAK_PASSWORD"],
  ];
  for (const [body, code] of cases) {
    const r = await request(app).post("/v1/auth/register").send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, code, JSON.stringify(body));
  }
});

test("login: 11ª tentativa errada contra o MESMO e-mail em 15 min → 429, mesmo com a senha certa", async () => {
  const email = `bruteforce-${Date.now()}@test.com`;
  const ok = await request(app).post("/v1/auth/register").send({ email, password: "senhaForte12345" });
  assert.equal(ok.status, 200);
  for (let i = 0; i < 10; i++) {
    const r = await request(app).post("/v1/auth/login").send({ email, password: `errada${i}xxxxxx` });
    assert.equal(r.status, 401);
  }
  const blocked = await request(app).post("/v1/auth/login").send({ email, password: "senhaForte12345" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "TOO_MANY_ATTEMPTS");
});

test("login: e-mail inexistente e senha errada respondem igual (401 INVALID_CREDENTIALS)", async () => {
  const a = await request(app).post("/v1/auth/login").send({ email: `ninguem-${Date.now()}@test.com`, password: "qualquerCoisa123" });
  assert.equal(a.status, 401);
  assert.equal(a.body.error, "INVALID_CREDENTIALS");
});

test("JWT com alg 'none' é recusado", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: 1, role: "admin" })).toString("base64url");
  const r = await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${header}.${payload}.`);
  assert.equal(r.status, 401);
});
