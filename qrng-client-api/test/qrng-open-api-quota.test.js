"use strict";

/**
 * QRNG Open API — cotas e limites COMPARTILHADOS com a API atual, e contabilização.
 * Arquivo separado porque usa limites baixos (cada arquivo de teste roda em processo próprio).
 *
 * Política verificada (a mesma das rotas atuais, sem mudança):
 *  - uma chamada POST /v1/entropy = 1 requisição e block_size × block_count bytes, com qualquer número de blocos;
 *  - a cota de bytes e de requisições do token é a MESMA de /v1/random: alternar interfaces não contorna nada;
 *  - o limite por token por minuto é o mesmo balde;
 *  - falha do upstream conta como em /v1/random (requisição, bytes pedidos e erro);
 *  - erro de validação (422) e recusa por cota (429) não contam;
 *  - /capabilities e /healthtest contam 1 requisição com 0 bytes (mesma política de GET /v1/health).
 * Broker FALSO, só deste teste.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("http");
const crypto = require("crypto");
const os     = require("os");
const fs     = require("fs");
const path   = require("path");

let mode = "normal";
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ source_status: "online", entropy_health: "not_assessed", qualification_status: "none" }));
  }
  const n = Number(u.searchParams.get("bytes"));
  const body = crypto.randomBytes(mode === "short" ? n - 1 : n); // conteúdo irrelevante aqui: só tamanhos e contagens
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
  res.end(body);
});

const testDbPath = path.join(os.tmpdir(), `qrng-openapi-quota-${Date.now()}.db`);
let app, db, agent;

async function newToken(tag) {
  const reg = await agent.post("/v1/auth/register").send({ email: `qoaq-${tag}-${Date.now()}@qa.invalid`, password: "pw-abcdefgh12" });
  const tok = await agent.post("/v1/tokens").set("Authorization", `Bearer ${reg.body.token}`);
  const raw = tok.body.token;
  const id = db.prepare("SELECT id FROM api_tokens WHERE token_hash = ?").get(crypto.createHash("sha256").update(raw).digest("hex")).id;
  return { raw, id };
}
function usage(id) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT requests_count AS r, bytes_count AS b, errors_count AS e FROM daily_usage WHERE token_id = ? AND date = ?").get(id, today)
    || { r: 0, b: 0, e: 0 };
}
const entropy = (t, body) => agent.post("/v1/entropy").set("Authorization", `Bearer ${t.raw}`).send(body);
const random  = (t, n) => agent.get(`/v1/random?bytes=${n}`).set("Authorization", `Bearer ${t.raw}`);

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    DB_PATH: testDbPath, NODE_ENV: "test", JWT_SECRET: "test-jwt-secret-for-ci",
    QRNG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    MAX_BYTES_PER_REQUEST: "4096", QRNG_OPENAPI_MAX_BLOCK_COUNT: "64", QRNG_OPENAPI_STATUS_TTL_MS: "0",
    DAILY_QUOTA_REQUESTS: "1000", DAILY_QUOTA_BYTES: "1024",
    RATE_LIMIT_PER_TOKEN_PER_MINUTE: "8", RATE_LIMIT_PER_IP_PER_MINUTE: "100000",
  });
  ({ app, db } = require("../server"));
  agent = require("supertest")(app);
});
after(() => {
  upstream.close();
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

describe("contabilização de POST /v1/entropy", () => {
  test("vários blocos = 1 requisição e block_size × block_count bytes", async () => {
    const t = await newToken("multi");
    const r = await entropy(t, { block_size: 16, block_count: 4 });
    assert.equal(r.status, 200);
    assert.deepEqual(usage(t.id), { r: 1, b: 64, e: 0 });
    // GET /v1/me/usage enxerga o mesmo total
    const u = await agent.get("/v1/me/usage").set("Authorization", `Bearer ${t.raw}`);
    assert.equal(u.status, 200);
    assert.ok(JSON.stringify(u.body).includes("64"));
  });

  test("422 e 429 não contam; /capabilities e /healthtest contam 1 requisição com 0 bytes", async () => {
    const t = await newToken("acct");
    assert.equal((await entropy(t, { block_size: "16" })).status, 422);
    assert.deepEqual(usage(t.id), { r: 0, b: 0, e: 0 });
    assert.equal((await agent.get("/v1/capabilities").set("Authorization", `Bearer ${t.raw}`)).status, 200);
    assert.equal((await agent.get("/v1/healthtest").set("X-API-Key", t.raw)).status, 200);
    assert.deepEqual(usage(t.id), { r: 2, b: 0, e: 0 });
  });

  test("falha do upstream conta igual nas duas interfaces (política existente preservada)", async () => {
    const a = await newToken("fail-a");
    const b = await newToken("fail-b");
    mode = "short";
    try {
      assert.equal((await random(a, 40)).status, 503);
      assert.equal((await entropy(b, { block_size: 8, block_count: 5 })).status, 503);
    } finally { mode = "normal"; }
    assert.deepEqual(usage(a.id), usage(b.id));
    assert.deepEqual(usage(b.id), { r: 1, b: 40, e: 1 });
  });
});

describe("cotas e limites compartilhados com a API atual", () => {
  test("cota diária de bytes: alternar /random e /entropy não contorna", async () => {
    const t = await newToken("bytes");
    assert.equal((await random(t, 600)).status, 200);
    const over = await entropy(t, { block_size: 256, block_count: 2 }); // 600 + 512 > 1024
    assert.equal(over.status, 429);
    assert.equal(over.body.error, "QUOTA_BYTES_EXCEEDED");
    assert.equal(over.headers["cache-control"], "no-store");
    assert.equal((await entropy(t, { block_size: 100, block_count: 4 })).status, 200); // 1000
    const r = await random(t, 32); // 1032 > 1024
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "QUOTA_BYTES_EXCEEDED");
  });

  test("cota diária de requisições do token vale para as duas interfaces", async () => {
    const t = await newToken("reqs");
    db.prepare("UPDATE api_tokens SET quota_daily = 3 WHERE id = ?").run(t.id);
    assert.equal((await random(t, 4)).status, 200);
    assert.equal((await entropy(t, { block_size: 4 })).status, 200);
    assert.equal((await random(t, 4)).status, 200);
    const r = await entropy(t, { block_size: 4 });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "QUOTA_EXCEEDED");
  });

  test("limite por token por minuto é o mesmo balde", async () => {
    const t = await newToken("rate");
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? await random(t, 4) : await entropy(t, { block_size: 4 });
      assert.equal(r.status, 200, `chamada ${i + 1}`);
    }
    const e = await entropy(t, { block_size: 4 });
    assert.equal(e.status, 429);
    assert.equal(e.body.error, "RATE_LIMIT_EXCEEDED");
    assert.equal((await random(t, 4)).status, 429);
  });
});
