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
const { buildFullSpec, buildPublicSpec, buildInternalAdminSpec } = require("../openapi/spec");

describe("Especificação OpenAPI — estrutura", () => {
  const spec = buildPublicSpec();

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
      "/me/usage", "/me/requests", "/random", "/public/random",
      "/health", "/health/self",
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

// ─── Item 7 da auditoria: split público × administrativo ──────────────────────
describe("Split público × administrativo (item 7)", () => {
  const full     = buildFullSpec();
  const publicS  = buildPublicSpec();
  const adminS   = buildInternalAdminSpec();

  test("a spec completa (uso interno/teste) de fato contém rotas /admin/* -- prova que o filtro abaixo faz algo", () => {
    assert.ok(Object.keys(full.paths).some((p) => p.startsWith("/admin")));
  });

  test("spec PÚBLICA não contém nenhuma rota /admin/*, nem a tag Admin", () => {
    const adminPaths = Object.keys(publicS.paths).filter((p) => p.startsWith("/admin"));
    assert.deepEqual(adminPaths, [], `rotas admin vazaram na spec pública: ${adminPaths.join(", ")}`);
    assert.ok(!publicS.tags.some((t) => t.name === "Admin"), "tag Admin não deveria aparecer na spec pública");
  });

  test("spec PÚBLICA não referencia o server local de desenvolvimento (127.0.0.1)", () => {
    assert.ok(!publicS.servers.some((s) => s.url.includes("127.0.0.1")));
  });

  test("spec ADMINISTRATIVA contém SÓ rotas /admin/*", () => {
    const nonAdmin = Object.keys(adminS.paths).filter((p) => !p.startsWith("/admin"));
    assert.deepEqual(nonAdmin, [], `rota não-admin vazou na spec administrativa: ${nonAdmin.join(", ")}`);
    assert.ok(Object.keys(adminS.paths).length > 0, "spec administrativa não deveria estar vazia");
  });

  test("spec pública documenta o endpoint público anônimo /public/random com seus limites", () => {
    const op = publicS.paths["/public/random"]?.get;
    assert.ok(op, "/public/random ausente na spec pública");
    assert.doesNotMatch(op.security ? JSON.stringify(op.security) : "", /bearerAuthToken/,
      "/public/random não deveria exigir o mesmo esquema de auth de /random -- é anônimo por design");
    assert.match(op.description, /rate limit|cota/i, "descrição deveria mencionar os limites por IP");
  });
});

// ─── Comparação rotas registradas no Express × paths documentados ─────────────
describe("Drift: rotas do Express vs paths na spec (item 7)", () => {
  // Endpoints deliberadamente fora do escopo de documentação de contrato
  // (meta-rotas da própria documentação, /metrics de operação interna).
  const EXEMPT = new Set([
    "/v1/openapi.json", "/v1/docs", "/v1/redoc",
    "/v1/internal/admin-openapi.json", "/v1/internal/docs",
    "/metrics",
  ]);

  function registeredV1Routes() {
    const out = [];
    for (const layer of app._router.stack) {
      if (!layer.route) continue;
      const p = layer.route.path;
      if (typeof p !== "string" || !p.startsWith("/v1/")) continue;
      if (EXEMPT.has(p) || [...EXEMPT].some((e) => p.startsWith(e + "/"))) continue;
      out.push(p.replace(/^\/v1/, "").replace(/:(\w+)/g, "{$1}"));
    }
    return out;
  }

  test("toda rota /v1/* registrada no Express (exceto meta-rotas) aparece em alguma das duas specs", () => {
    const full = buildFullSpec();
    const routes = registeredV1Routes();
    assert.ok(routes.length > 0, "nenhuma rota /v1/* encontrada -- o teste em si está quebrado");
    const missing = routes.filter((r) => !full.paths[r]);
    assert.deepEqual(missing, [], `rota registrada no Express sem documentação @openapi: ${missing.join(", ")}`);
  });

  test("toda rota documentada na spec completa ainda existe de fato no Express (nenhuma rota fantasma)", () => {
    const full = buildFullSpec();
    const routes = new Set(registeredV1Routes());
    // /metrics é documentado na mesma spec por conveniência histórica, mas
    // não vive sob o prefixo /v1 dos servers desta spec (é uma rota de
    // operação, não parte do contrato versionado /v1) -- por isso não passa
    // pela normalização de registeredV1Routes(). Não é uma rota fantasma
    // real; é a mesma exceção documentada em EXEMPT acima, na direção oposta.
    const phantom = Object.keys(full.paths).filter((p) => !routes.has(p) && p !== "/metrics");
    assert.deepEqual(phantom, [], `path documentado sem rota Express correspondente: ${phantom.join(", ")}`);
  });
});

// ─── Varredura de segredos na spec gerada (item 7) ────────────────────────────
describe("Nenhum segredo real na spec gerada (item 7)", () => {
  test("nenhum valor de exemplo parece um JWT_SECRET/hash real (só placeholders óbvios)", () => {
    const raw = JSON.stringify(buildFullSpec());
    // Um JWT_SECRET real gerado via `openssl rand -hex 32` é hex de 64
    // caracteres; os únicos hex longos esperados na spec são EXEMPLOS de
    // token/request_id claramente rotulados como tal nos schemas (ver
    // spec.js) -- nenhum deveria ter 64 caracteres hex consecutivos.
    const longHex = raw.match(/[0-9a-f]{64}/gi) || [];
    assert.deepEqual(longHex, [], `string hex de 64 caracteres encontrada na spec (possível segredo real): ${longHex.join(", ")}`);
  });

  test("nenhum e-mail real (só o placeholder de exemplo) aparece na spec", () => {
    const raw = JSON.stringify(buildFullSpec());
    const emails = [...new Set(raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])];
    const unexpected = emails.filter((e) => !/^user@example\.com$/i.test(e) && !e.endsWith("@test.com"));
    assert.deepEqual(unexpected, [], `e-mail inesperado na spec: ${unexpected.join(", ")}`);
  });
});

describe("Endpoints de documentação servidos pela aplicação", () => {
  test("GET /v1/openapi.json carrega, é JSON válido, e NÃO inclui rotas admin", async () => {
    const res = await request(app).get("/v1/openapi.json");
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi.startsWith("3."), true);
    assert.ok(res.body.paths["/random"]);
    assert.ok(!Object.keys(res.body.paths).some((p) => p.startsWith("/admin")));
  });

  test("GET /v1/docs carrega o HTML do Swagger UI (spec pública)", async () => {
    const res = await request(app).get("/v1/docs/");
    assert.equal(res.status, 200);
    assert.match(res.text, /swagger-ui/i);
  });

  test("GET /v1/redoc carrega o HTML do ReDoc, apontando para /v1/openapi.json (público)", async () => {
    const res = await request(app).get("/v1/redoc");
    assert.equal(res.status, 200);
    assert.match(res.text, /<redoc/i);
    assert.match(res.text, /\/v1\/openapi\.json/);
  });

  // CSP/ativo externo (item 7): registrado explicitamente, não escondido --
  // ReDoc carrega seu bundle de um CDN externo (cdn.redoc.ly). Isso É uma
  // dependência de terceiro real (supply-chain, e quebra sob uma CSP restrita
  // sem exceção para esse host) -- o teste apenas garante que ela é a ÚNICA
  // dependência externa da página, para não crescer despercebida.
  test("/v1/redoc não referencia nenhum outro host externo além de cdn.redoc.ly", async () => {
    const res = await request(app).get("/v1/redoc");
    const externalUrls = res.text.match(/https?:\/\/[^"'\s)]+/g) || [];
    const unexpected = externalUrls.filter((u) => !u.startsWith("https://cdn.redoc.ly/"));
    assert.deepEqual(unexpected, [], `host externo inesperado em /v1/redoc: ${unexpected.join(", ")}`);
  });

  // Item 7: documentação administrativa NUNCA pública -- sem header de auth,
  // ambas as rotas devem recusar, nunca vazar a forma da API admin.
  test("GET /v1/internal/admin-openapi.json SEM auth retorna 401, não expõe a spec", async () => {
    const res = await request(app).get("/v1/internal/admin-openapi.json");
    assert.equal(res.status, 401);
  });

  test("GET /v1/internal/docs SEM auth retorna 401, não serve o Swagger UI administrativo", async () => {
    const res = await request(app).get("/v1/internal/docs/");
    assert.equal(res.status, 401);
  });
});
