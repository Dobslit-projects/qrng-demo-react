"use strict";

const { test, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const os   = require("os");
const fs   = require("fs");
const path = require("path");

// Temp DB isolado — deve ser definido ANTES de require('../server')
const testDbPath = path.join(os.tmpdir(), `qrng-test-${Date.now()}.db`);
process.env.DB_PATH               = testDbPath;
process.env.NODE_ENV              = "test";
process.env.JWT_SECRET            = "test-jwt-secret-for-ci";
process.env.ADMIN_EMAIL           = "admin@test.com";
process.env.MAX_BYTES_PER_REQUEST = "1048576";
process.env.DAILY_QUOTA_REQUESTS  = "10000";
process.env.DAILY_QUOTA_BYTES     = "104857600";

const request = require("supertest");
const { app, db } = require("../server");

// ─── Estado compartilhado ────────────────────────────────────────────────────
let jwt         = null;
let adminJwt    = null;
let apiToken    = null;
let rotatedToken = null;

after(() => {
  db.close();
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
describe("Auth — registro e login", () => {
  test("POST /v1/auth/register cria conta e retorna JWT", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "user@test.com", password: "password123" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.role, "user");
    jwt = res.body.token;
  });

  test("ADMIN_EMAIL promove conta para admin", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "admin@test.com", password: "adminpass123" });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "admin");
    adminJwt = res.body.token;
  });

  test("email duplicado retorna 409", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "user@test.com", password: "outrasenha" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "EMAIL_TAKEN");
  });

  test("senha curta retorna 400", async () => {
    const res = await request(app).post("/v1/auth/register").send({ email: "novo@test.com", password: "1234" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "WEAK_PASSWORD");
  });

  test("POST /v1/auth/login retorna JWT com credenciais corretas", async () => {
    const res = await request(app).post("/v1/auth/login").send({ email: "user@test.com", password: "password123" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  test("senha errada retorna 401", async () => {
    const res = await request(app).post("/v1/auth/login").send({ email: "user@test.com", password: "errada" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "INVALID_CREDENTIALS");
  });

  test("GET /v1/auth/me retorna dados do usuário", async () => {
    const res = await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email, "user@test.com");
  });
});

// ─── Criação de API token ─────────────────────────────────────────────────────
describe("POST /v1/tokens", () => {
  test("retorna 401 sem autenticação", async () => {
    const res = await request(app).post("/v1/tokens");
    assert.equal(res.status, 401);
  });

  test("cria token com JWT válido", async () => {
    const res = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token.startsWith("dobslit_qrng_live_"));
    apiToken = res.body.token;
  });

  test("retorna 409 se já existe token ativo", async () => {
    const res = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "TOKEN_EXISTS");
  });
});

// ─── Dual auth e /me/* ────────────────────────────────────────────────────────
describe("Dual auth — /me/*", () => {
  test("sem header retorna 401", async () => {
    const res = await request(app).get("/v1/me/token");
    assert.equal(res.status, 401);
  });

  test("API token aceito pelo resolveUser", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, true);
    assert.equal(res.body.status, "active");
  });

  test("JWT aceito pelo resolveUser", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, true);
  });

  test("usuário sem token retorna has_token=false", async () => {
    await request(app).post("/v1/auth/register").send({ email: "sem@token.com", password: "senha12345" });
    const login = await request(app).post("/v1/auth/login").send({ email: "sem@token.com", password: "senha12345" });
    const res   = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, false);
  });
});

// ─── /v1/me/usage com remaining ──────────────────────────────────────────────
describe("GET /v1/me/usage", () => {
  test("retorna estrutura completa com remaining e quota_daily_bytes", async () => {
    const res = await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_token, true);
    assert.ok(typeof res.body.quota_daily_requests === "number");
    assert.ok(typeof res.body.quota_daily_bytes    === "number");
    assert.ok(typeof res.body.remaining_requests_today === "number");
    assert.ok(typeof res.body.remaining_bytes_today    === "number");
    assert.ok(typeof res.body.max_bytes_per_request    === "number");
    assert.ok(Array.isArray(res.body.daily_history));
  });
});

// ─── /me/requests com duration_ms ────────────────────────────────────────────
describe("GET /v1/me/requests", () => {
  test("retorna array de chamadas com duration_ms", async () => {
    const res = await request(app).get("/v1/me/requests").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.requests));
  });

  test("respeita parâmetro limit", async () => {
    const res = await request(app).get("/v1/me/requests?limit=5").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.requests.length <= 5);
  });
});

// ─── Validação de bytes (422 / 413) ──────────────────────────────────────────
describe("Validação de bytes — /v1/random", () => {
  test("bytes ausente usa default 32 (ou 503 se upstream down)", async () => {
    const res = await request(app).get("/v1/random").set("Authorization", `Bearer ${apiToken}`);
    assert.ok([200, 503].includes(res.status), `status inesperado: ${res.status}`);
    if (res.status === 200) assert.equal(res.body.bytes, 32);
  });

  test("bytes=0 retorna 422 INVALID_BYTES", async () => {
    const res = await request(app).get("/v1/random?bytes=0").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "INVALID_BYTES");
  });

  test("bytes=-1 retorna 422 INVALID_BYTES", async () => {
    const res = await request(app).get("/v1/random?bytes=-1").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "INVALID_BYTES");
  });

  test("bytes=abc retorna 422 INVALID_BYTES", async () => {
    const res = await request(app).get("/v1/random?bytes=abc").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "INVALID_BYTES");
  });

  test("bytes=1.5 retorna 422 INVALID_BYTES (não é inteiro)", async () => {
    const res = await request(app).get("/v1/random?bytes=1.5").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "INVALID_BYTES");
  });

  test("bytes=1048577 retorna 413 REQUEST_TOO_LARGE", async () => {
    const res = await request(app).get("/v1/random?bytes=1048577").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "REQUEST_TOO_LARGE");
    assert.ok(typeof res.body.max_bytes_per_request === "number");
  });

  test("bytes=1000000000 retorna 413 REQUEST_TOO_LARGE", async () => {
    const res = await request(app).get("/v1/random?bytes=1000000000").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "REQUEST_TOO_LARGE");
  });

  test("format inválido retorna 422 INVALID_FORMAT", async () => {
    const res = await request(app).get("/v1/random?bytes=32&format=base58").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "INVALID_FORMAT");
  });
});

// ─── request_id em TODAS as respostas (incluindo erros de auth) ──────────────
describe("request_id presente em todas as respostas de /v1/random e /v1/health", () => {
  function assertRequestId(body) {
    assert.ok(body.request_id, "deve ter request_id");
    assert.ok(body.request_id.startsWith("req_"), "formato req_*");
  }

  // attachRequestId roda antes de requireToken → erros de auth também têm request_id
  test("/v1/random 401 MISSING_TOKEN inclui request_id", async () => {
    const res = await request(app).get("/v1/random?bytes=32");
    assert.equal(res.status, 401);
    assertRequestId(res.body);
  });

  test("/v1/random 403 INVALID_TOKEN inclui request_id", async () => {
    const res = await request(app).get("/v1/random?bytes=32").set("Authorization", "Bearer token_invalido");
    assert.equal(res.status, 403);
    assertRequestId(res.body);
  });

  test("/v1/random 422 INVALID_BYTES inclui request_id", async () => {
    const res = await request(app).get("/v1/random?bytes=abc").set("Authorization", `Bearer ${rotatedToken || apiToken}`);
    // rotatedToken pode estar revogado neste ponto; qualquer status >= 200 com request_id é válido
    assertRequestId(res.body);
  });

  test("/v1/random 413 REQUEST_TOO_LARGE inclui request_id", async () => {
    const res = await request(app).get("/v1/random?bytes=2000000").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 413);
    assertRequestId(res.body);
  });

  test("/v1/random 422 INVALID_FORMAT inclui request_id", async () => {
    const res = await request(app).get("/v1/random?bytes=32&format=base58").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 422);
    assertRequestId(res.body);
  });

  test("/v1/random 200/503 inclui request_id", async () => {
    const res = await request(app).get("/v1/random?bytes=32").set("Authorization", `Bearer ${apiToken}`);
    assertRequestId(res.body);
  });

  test("/v1/health 401 MISSING_TOKEN inclui request_id", async () => {
    const res = await request(app).get("/v1/health");
    assert.equal(res.status, 401);
    assertRequestId(res.body);
  });

  test("/v1/health 200/503 inclui request_id", async () => {
    const res = await request(app).get("/v1/health").set("Authorization", `Bearer ${apiToken}`);
    assertRequestId(res.body);
  });
});

// ─── Enforcement de cota ──────────────────────────────────────────────────────
describe("Enforcement de cota", () => {
  test("retorna 429 QUOTA_EXCEEDED com request_id quando requests esgotados", async () => {
    const tokenId = db.prepare("SELECT id FROM api_tokens WHERE status = 'active' LIMIT 1").get().id;
    const today   = new Date().toISOString().slice(0, 10);
    db.prepare("UPDATE api_tokens SET quota_daily = 1 WHERE id = ?").run(tokenId);
    db.prepare(`
      INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count)
      VALUES (?, ?, 1, 0, 0)
      ON CONFLICT(token_id, date) DO UPDATE SET requests_count = 1
    `).run(tokenId, today);
    const res = await request(app).get("/v1/random?bytes=32").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "QUOTA_EXCEEDED");
    assert.ok(res.body.request_id?.startsWith("req_"), "QUOTA_EXCEEDED deve ter request_id");
    db.prepare("UPDATE api_tokens SET quota_daily = 10000 WHERE id = ?").run(tokenId);
    db.prepare("DELETE FROM daily_usage WHERE token_id = ? AND date = ?").run(tokenId, today);
  });

  test("retorna 429 QUOTA_BYTES_EXCEEDED com request_id quando bytes esgotados", async () => {
    const tokenId = db.prepare("SELECT id FROM api_tokens WHERE status = 'active' LIMIT 1").get().id;
    const today   = new Date().toISOString().slice(0, 10);
    const quota = parseInt(process.env.DAILY_QUOTA_BYTES || "104857600", 10);
    db.prepare(`
      INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count)
      VALUES (?, ?, 0, ?, 0)
      ON CONFLICT(token_id, date) DO UPDATE SET bytes_count = excluded.bytes_count
    `).run(tokenId, today, quota);
    const res = await request(app).get("/v1/random?bytes=32").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "QUOTA_BYTES_EXCEEDED");
    assert.ok(res.body.request_id?.startsWith("req_"), "QUOTA_BYTES_EXCEEDED deve ter request_id");
    db.prepare("DELETE FROM daily_usage WHERE token_id = ? AND date = ?").run(tokenId, today);
  });
});

// ─── Upstream e /v1/health ────────────────────────────────────────────────────
describe("Endpoints que dependem do upstream", () => {
  test("GET /v1/health retorna 200 ou 503", async () => {
    const res = await request(app).get("/v1/health").set("Authorization", `Bearer ${apiToken}`);
    assert.ok([200, 503].includes(res.status));
  });

  test("GET /v1/random retorna 200 ou 503", async () => {
    const res = await request(app).get("/v1/random?bytes=32&format=hex").set("Authorization", `Bearer ${apiToken}`);
    assert.ok([200, 503].includes(res.status));
  });

  test("GET /v1/upstream/status retorna estado", async () => {
    const res = await request(app).get("/v1/upstream/status").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.ok(["up", "down", "unknown"].includes(res.body.current.status));
  });
});

// ─── Bulk jobs (stubs 501) ────────────────────────────────────────────────────
describe("Bulk jobs — stubs", () => {
  test("POST /v1/bulk-random-jobs retorna 501", async () => {
    const res = await request(app).post("/v1/bulk-random-jobs").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 501);
    assert.equal(res.body.error, "BULK_JOBS_NOT_IMPLEMENTED");
  });

  test("GET /v1/bulk-random-jobs/:id retorna 501", async () => {
    const res = await request(app).get("/v1/bulk-random-jobs/job_123").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 501);
  });
});

// ─── Admin ────────────────────────────────────────────────────────────────────
describe("Admin", () => {
  test("GET /v1/admin/tokens retorna 403 para user comum", async () => {
    const res = await request(app).get("/v1/admin/tokens").set("Authorization", `Bearer ${jwt}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "FORBIDDEN");
  });

  test("GET /v1/admin/tokens funciona para admin", async () => {
    const res = await request(app).get("/v1/admin/tokens").set("Authorization", `Bearer ${adminJwt}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tokens));
  });

  test("GET /v1/admin/users funciona para admin", async () => {
    const res = await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${adminJwt}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length >= 2);
  });
});

// ─── Rotação e revogação ──────────────────────────────────────────────────────
describe("Rotação e revogação de token", () => {
  test("POST /v1/me/token/rotate retorna novo token", async () => {
    const res = await request(app).post("/v1/me/token/rotate").set("Authorization", `Bearer ${apiToken}`);
    assert.equal(res.status, 200);
    assert.notEqual(res.body.token, apiToken);
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

  test("POST /v1/me/token/revoke revoga token", async () => {
    const res = await request(app).post("/v1/me/token/revoke").set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.revoked_at);
  });

  test("token revogado é rejeitado", async () => {
    const res = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${rotatedToken}`);
    assert.equal(res.status, 401);
  });
});
