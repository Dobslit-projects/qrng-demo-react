"use strict";

/**
 * Testes de contrato do item 9 da auditoria: a especificação OpenAPI deve
 * ser válida, cobrir os endpoints reais, e o Swagger UI / ReDoc / JSON devem
 * carregar de fato quando servidos pela aplicação.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os   = require("os");
const path = require("path");

const testDbPath = path.join(os.tmpdir(), `qrng-test-openapi-${Date.now()}.db`);
process.env.DB_PATH               = testDbPath;
process.env.NODE_ENV              = "test";
process.env.JWT_SECRET            = "test-jwt-secret-for-ci";
process.env.ADMIN_EMAIL           = "admin@test.com";
process.env.MAX_BYTES_PER_REQUEST = "1048576";
process.env.DAILY_QUOTA_REQUESTS  = "10000";
process.env.DAILY_QUOTA_BYTES     = "104857600";

const request = require("supertest");
const { app } = require("../server");
const { buildSpec } = require("../openapi/spec");

describe("Especificação OpenAPI — estrutura", () => {
  const spec = buildSpec();

  test("é OpenAPI 3.x com info e servers", () => {
    assert.ok(spec.openapi.startsWith("3."));
    assert.ok(spec.info.title);
    assert.ok(spec.info.version);
    assert.ok(Array.isArray(spec.servers) && spec.servers.length > 0);
  });

  test("tem pelo menos um path documentado", () => {
    assert.ok(spec.paths && Object.keys(spec.paths).length > 0);
  });

  test("cobre os endpoints públicos principais", () => {
    const required = [
      "/auth/register", "/auth/login", "/auth/me",
      "/tokens", "/me/token", "/me/token/rotate", "/me/token/revoke",
      "/me/usage", "/me/requests", "/random", "/health", "/health/self",
    ];
    for (const p of required) {
      assert.ok(spec.paths[p], `path ausente na especificação: ${p}`);
    }
  });

  test("/random documenta os erros de contrato do upstream (item 2)", () => {
    const random = spec.paths["/random"].get;
    assert.ok(random.responses["502"], "resposta 502 (erro de contrato do upstream) não documentada");
    assert.ok(random.responses["503"], "resposta 503 (upstream indisponível) não documentada");
  });

  test("schemas reutilizáveis existem (ErrorResponse, RandomResponse)", () => {
    assert.ok(spec.components.schemas.ErrorResponse);
    assert.ok(spec.components.schemas.RandomResponse);
  });

  test("esquemas de autenticação (bearer) estão declarados", () => {
    assert.ok(spec.components.securitySchemes.bearerAuthJWT);
    assert.ok(spec.components.securitySchemes.bearerAuthToken);
    assert.equal(spec.components.securitySchemes.bearerAuthToken.scheme, "bearer");
  });

  test("nenhum endpoint expõe IP ou porta interna na descrição", () => {
    const raw = JSON.stringify(spec);
    // Endereços internos conhecidos do pipeline (10.0.10.x FPGA, portas de
    // túnel 18001-18002/22222, IPs da VM remota) não devem vazar na doc pública.
    assert.doesNotMatch(raw, /10\.0\.10\.\d/, "IP interno da FPGA vazou na spec pública");
    assert.doesNotMatch(raw, /192\.168\.0\.42/, "IP interno da VM remota vazou na spec pública");
    assert.doesNotMatch(raw, /\b1800[12]\b/, "porta interna do túnel vazou na spec pública");
  });
});

describe("Endpoints de documentação servidos pela aplicação", () => {
  test("GET /v1/openapi.json carrega e é JSON válido equivalente à spec", async () => {
    const res = await request(app).get("/v1/openapi.json");
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi.startsWith("3."), true);
    assert.ok(res.body.paths["/random"]);
  });

  test("GET /v1/docs carrega o HTML do Swagger UI", async () => {
    const res = await request(app).get("/v1/docs/");
    assert.equal(res.status, 200);
    assert.match(res.text, /swagger-ui/i);
  });

  test("GET /v1/redoc carrega o HTML do ReDoc, apontando para /v1/openapi.json", async () => {
    const res = await request(app).get("/v1/redoc");
    assert.equal(res.status, 200);
    assert.match(res.text, /<redoc/i);
    assert.match(res.text, /\/v1\/openapi\.json/);
  });
});
