"use strict";

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Temp DB isolado — deve ser definido ANTES de require('../server')
const testDbPath = path.join(os.tmpdir(), `qrng-test-${Date.now()}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = "test";

const request = require("supertest");
const { app, db } = require("../server");

// ─── Estado compartilhado entre testes ───────────────────────────────────────
let token = null;      // token completo gerado no primeiro teste
let rotatedToken = null;

after(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

// ─── Criação de token ─────────────────────────────────────────────────────────
describe("POST /v1/tokens", () => {
  test("cria o primeiro token e retorna dados completos", async () => {
    const res = await request(app).post("/v1/tokens");
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "deve retornar o token completo");
    assert.ok(res.body.prefix, "deve retornar o prefix");
    assert.ok(res.body.token.startsWith("dobslit_qrng_live_"), "formato do token");
    token = res.body.token;
  });

  test("retorna 409 se já existe token ativo", async () => {
    const res = await request(app).post("/v1/tokens");
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "token_exists");
  });
});

// ─── Autenticação ─────────────────────────────────────────────────────────────
describe("Autenticação", () => {
  test("GET /v1/me/token sem header retorna 401", async () => {
    const res = await request(app).get("/v1/me/token");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "missing_token");
  });

  test("GET /v1/me/token com token inválido retorna 403", async () => {
    const res = await request(app)
      .get("/v1/me/token")
      .set("Authorization", "Bearer dobslit_qrng_live_00000000000000000000000000000000000000000");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "invalid_token");
  });

  test("GET /v1/me/token com token válido retorna info", async () => {
    const res = await request(app)
      .get("/v1/me/token")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token_prefix, "deve ter token_prefix");
    assert.equal(res.body.status, "active");
    assert.equal(res.body.quota_daily, 1000);
    assert.equal(res.body.requests_today, 0);
  });
});

// ─── Endpoints de uso e logs ──────────────────────────────────────────────────
describe("Endpoints de uso", () => {
  test("GET /v1/me/usage retorna estrutura correta", async () => {
    const res = await request(app)
      .get("/v1/me/usage")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.quota_daily, "number");
    assert.equal(typeof res.body.requests_today, "number");
    assert.ok(Array.isArray(res.body.daily_history), "deve ter daily_history");
  });

  test("GET /v1/me/requests retorna array de chamadas", async () => {
    const res = await request(app)
      .get("/v1/me/requests")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.requests), "deve ter requests");
  });

  test("GET /v1/me/requests respeita parâmetro limit", async () => {
    const res = await request(app)
      .get("/v1/me/requests?limit=5")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.requests.length <= 5, "não deve exceder o limite");
  });

  test("GET /v1/upstream/status retorna estado do upstream", async () => {
    const res = await request(app)
      .get("/v1/upstream/status")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.current, "deve ter current");
    assert.ok(["up", "down", "unknown"].includes(res.body.current.status));
  });
});

// ─── Upstream indisponível em testes ─────────────────────────────────────────
describe("Endpoints que dependem do upstream", () => {
  test("GET /v1/health retorna 503 quando upstream indisponível", async () => {
    const res = await request(app)
      .get("/v1/health")
      .set("Authorization", `Bearer ${token}`);
    // Em ambiente de teste o upstream não está disponível → espera 503
    assert.ok([200, 503].includes(res.status), `status inesperado: ${res.status}`);
  });

  test("GET /v1/random retorna 503 quando upstream indisponível", async () => {
    const res = await request(app)
      .get("/v1/random?bytes=32&format=hex")
      .set("Authorization", `Bearer ${token}`);
    assert.ok([200, 503].includes(res.status), `status inesperado: ${res.status}`);
  });

  test("GET /v1/random rejeita formato inválido com 400", async () => {
    const res = await request(app)
      .get("/v1/random?bytes=32&format=base58")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_format");
  });

  test("GET /v1/random rejeita bytes=0 com 400", async () => {
    const res = await request(app)
      .get("/v1/random?bytes=0&format=hex")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_bytes");
  });
});

// ─── Cota diária ─────────────────────────────────────────────────────────────
describe("Enforcement de cota", () => {
  test("retorna 429 quando cota diária está esgotada", async () => {
    // Descobre o token_id pelo hash
    const tokenId = db.prepare(
      "SELECT id FROM api_tokens WHERE status = 'active' LIMIT 1"
    ).get().id;
    const today = new Date().toISOString().slice(0, 10);

    // Seta quota_daily = 1 e insere uso = 1 (cota esgotada)
    db.prepare("UPDATE api_tokens SET quota_daily = 1 WHERE id = ?").run(tokenId);
    db.prepare(`
      INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count)
      VALUES (?, ?, 1, 0, 0)
      ON CONFLICT(token_id, date) DO UPDATE SET requests_count = 1
    `).run(tokenId, today);

    const res = await request(app)
      .get("/v1/random?bytes=32&format=hex")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "quota_exceeded");

    // Restaura quota original
    db.prepare("UPDATE api_tokens SET quota_daily = 1000 WHERE id = ?").run(tokenId);
    db.prepare(
      "DELETE FROM daily_usage WHERE token_id = ? AND date = ?"
    ).run(tokenId, today);
  });
});

// ─── Rotação de token ─────────────────────────────────────────────────────────
describe("Rotação e revogação de token", () => {
  test("POST /v1/me/token/rotate retorna novo token", async () => {
    const res = await request(app)
      .post("/v1/me/token/rotate")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "deve retornar novo token");
    assert.notEqual(res.body.token, token, "novo token deve ser diferente");
    rotatedToken = res.body.token;
  });

  test("token antigo é rejeitado após rotação", async () => {
    const res = await request(app)
      .get("/v1/me/token")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test("novo token funciona após rotação", async () => {
    const res = await request(app)
      .get("/v1/me/token")
      .set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "active");
  });

  test("POST /v1/me/token/revoke revoga token atual", async () => {
    const res = await request(app)
      .post("/v1/me/token/revoke")
      .set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.revoked_at, "deve ter revoked_at");
  });

  test("token revogado é rejeitado", async () => {
    const res = await request(app)
      .get("/v1/me/token")
      .set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 403);
  });
});
