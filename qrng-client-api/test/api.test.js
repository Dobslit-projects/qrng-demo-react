"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const os   = require("os");
const fs   = require("fs");
const path = require("path");

// Temp DB isolado — deve ser definido ANTES de require('../server')
const testDbPath = path.join(os.tmpdir(), `qrng-test-${Date.now()}.db`);
process.env.DB_PATH    = testDbPath;
process.env.NODE_ENV   = "test";
process.env.JWT_SECRET = "test-jwt-secret-for-ci";
process.env.ADMIN_EMAIL = "admin@test.com";

const request = require("supertest");
const { app, db } = require("../server");

// ─── Estado compartilhado ────────────────────────────────────────────────────
let jwt         = null;   // JWT do usuário normal
let adminJwt    = null;   // JWT do admin
let apiToken    = null;   // API token criado via JWT
let rotatedToken = null;

after(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

// ─── Auth: registro e login ───────────────────────────────────────────────────
describe("Auth — registro e login", () => {
  test("POST /v1/auth/register cria conta e retorna JWT", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "user@test.com", password: "password123" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "deve retornar JWT");
    assert.equal(res.body.email, "user@test.com");
    assert.equal(res.body.role, "user");
    jwt = res.body.token;
  });

  test("POST /v1/auth/register com ADMIN_EMAIL promove para admin", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "admin@test.com", password: "adminpass123" });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "admin");
    adminJwt = res.body.token;
  });

  test("POST /v1/auth/register retorna 409 para email duplicado", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "user@test.com", password: "outrasenha" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "email_taken");
  });

  test("POST /v1/auth/register retorna 400 para senha curta", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "novo@test.com", password: "1234" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "weak_password");
  });

  test("POST /v1/auth/login retorna JWT com credenciais corretas", async () => {
    const res = await request(app).post("/v1/auth/login").send({ email: "user@test.com", password: "password123" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  test("POST /v1/auth/login retorna 401 com senha errada", async () => {
    const res = await request(app).post("/v1/auth/login").send({ email: "user@test.com", password: "errada" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "invalid_credentials");
  });

  test("GET /v1/auth/me retorna dados do usuário autenticado", async () => {
    const res = await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email, "user@test.com");
    assert.equal(res.body.role, "user");
  });

  test("GET /v1/auth/me sem token retorna 401", async () => {
    const res = await request(app).get("/v1/auth/me");
    assert.equal(res.status, 401);
  });
});

// ─── Criação de API token (requer JWT) ───────────────────────────────────────
describe("POST /v1/tokens", () => {
  test("retorna 401 sem autenticação", async () => {
    const res = await request(app).post("/v1/tokens");
    assert.equal(res.status, 401);
  });

  test("cria token com JWT válido", async () => {
    const res = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "deve retornar token completo");
    assert.ok(res.body.token.startsWith("dobslit_qrng_live_"), "formato do token");
    apiToken = res.body.token;
  });

  test("retorna 409 se já existe token ativo", async () => {
    const res = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "token_exists");
  });
});

// ─── Dual auth: /me/* aceita JWT e API token ─────────────────────────────────
describe("Dual auth — /me/*", () => {
  test("GET /v1/me/token sem header retorna 401", async () => {
    const res = await request(app).get("/v1/me/token");
    assert.equal(res.status, 401);
  });

  test("GET /v1/me/token com API token funciona", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, true);
    assert.equal(res.body.status, "active");
  });

  test("GET /v1/me/token com JWT funciona", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, true);
  });

  test("GET /v1/me/token sem token ativo retorna has_token=false", async () => {
    // Cria usuário sem token
    await request(app).post("/v1/auth/register").send({ email: "notokens@test.com", password: "senha12345" });
    const loginRes = await request(app).post("/v1/auth/login").send({ email: "notokens@test.com", password: "senha12345" });
    const otherJwt = loginRes.body.token;
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${otherJwt}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, false);
  });
});

// ─── Endpoints de uso ─────────────────────────────────────────────────────────
describe("Endpoints de uso", () => {
  test("GET /v1/me/usage retorna estrutura correta", async () => {
    const res = await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.quota_daily, "number");
    assert.equal(typeof res.body.requests_today, "number");
    assert.ok(Array.isArray(res.body.daily_history));
  });

  test("GET /v1/me/requests retorna array de chamadas", async () => {
    const res = await request(app).get("/v1/me/requests").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.requests));
  });

  test("GET /v1/me/requests respeita parâmetro limit", async () => {
    const res = await request(app).get("/v1/me/requests?limit=5").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.requests.length <= 5);
  });

  test("GET /v1/upstream/status retorna estado do upstream", async () => {
    const res = await request(app).get("/v1/upstream/status").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.current);
    assert.ok(["up", "down", "unknown"].includes(res.body.current.status));
  });
});

// ─── Endpoints machine-to-machine (requireToken) ──────────────────────────────
describe("Endpoints que dependem do upstream", () => {
  test("GET /v1/health retorna 200 ou 503 (depende do upstream)", async () => {
    const res = await request(app).get("/v1/health").set("Authorization", `Bearer ${apiToken}`);
    assert.ok([200, 503].includes(res.status), `status inesperado: ${res.status}`);
  });

  test("GET /v1/random retorna 200 ou 503 (depende do upstream)", async () => {
    const res = await request(app).get("/v1/random?bytes=32&format=hex").set("Authorization", `Bearer ${apiToken}`);
    assert.ok([200, 503].includes(res.status), `status inesperado: ${res.status}`);
  });

  test("GET /v1/random rejeita formato inválido com 400", async () => {
    const res = await request(app).get("/v1/random?bytes=32&format=base58").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_format");
  });

  test("GET /v1/random rejeita bytes=0 com 400", async () => {
    const res = await request(app).get("/v1/random?bytes=0&format=hex").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_bytes");
  });
});

// ─── Enforcement de cota ──────────────────────────────────────────────────────
describe("Enforcement de cota", () => {
  test("retorna 429 quando cota diária está esgotada", async () => {
    const tokenId = db.prepare("SELECT id FROM api_tokens WHERE status = 'active' LIMIT 1").get().id;
    const today   = new Date().toISOString().slice(0, 10);

    db.prepare("UPDATE api_tokens SET quota_daily = 1 WHERE id = ?").run(tokenId);
    db.prepare(`
      INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count)
      VALUES (?, ?, 1, 0, 0)
      ON CONFLICT(token_id, date) DO UPDATE SET requests_count = 1
    `).run(tokenId, today);

    const res = await request(app).get("/v1/random?bytes=32&format=hex").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "quota_exceeded");

    db.prepare("UPDATE api_tokens SET quota_daily = 1000 WHERE id = ?").run(tokenId);
    db.prepare("DELETE FROM daily_usage WHERE token_id = ? AND date = ?").run(tokenId, today);
  });
});

// ─── Admin endpoints ──────────────────────────────────────────────────────────
describe("Admin", () => {
  test("GET /v1/admin/tokens retorna 403 para usuário comum", async () => {
    const res = await request(app).get("/v1/admin/tokens").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
  });

  test("GET /v1/admin/tokens funciona para admin", async () => {
    const res = await request(app).get("/v1/admin/tokens").set("Authorization", `Bearer ${adminJwt}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tokens));
  });

  test("GET /v1/admin/users funciona para admin", async () => {
    const res = await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${adminJwt}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
    assert.ok(res.body.users.length >= 2, "deve ter pelo menos 2 usuários");
  });
});

// ─── Rotação e revogação de token ────────────────────────────────────────────
describe("Rotação e revogação de token", () => {
  test("POST /v1/me/token/rotate retorna novo token", async () => {
    const res = await request(app).post("/v1/me/token/rotate").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "deve retornar novo token");
    assert.notEqual(res.body.token, apiToken, "novo token deve ser diferente");
    rotatedToken = res.body.token;
  });

  test("token antigo é rejeitado após rotação", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 401);
  });

  test("novo token funciona após rotação", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, true);
  });

  test("POST /v1/me/token/revoke revoga token atual", async () => {
    const res = await request(app).post("/v1/me/token/revoke").set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.revoked_at);
  });

  test("token revogado é rejeitado", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 401);
  });
});
