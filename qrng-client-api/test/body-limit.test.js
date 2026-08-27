"use strict";

/**
 * Contrato do limite explícito de corpo de requisição (item 3 da estabilização).
 *
 * JSON_BODY_LIMIT = 8kb (8192 bytes). Cobre: abaixo / exatamente no / acima do
 * limite; JSON inválido; Content-Length incorreto; Transfer-Encoding chunked;
 * resposta 413 estruturada; ausência de HTML / stack trace; e a confirmação de
 * que o upload NIST NÃO passa por este serviço (tem política própria).
 */

const { test, describe, after, before } = require("node:test");
const assert = require("node:assert/strict");
const os   = require("os");
const fs   = require("fs");
const http = require("http");
const path = require("path");

const testDbPath = path.join(os.tmpdir(), `qrng-body-limit-${Date.now()}.db`);
process.env.DB_PATH    = testDbPath;
process.env.NODE_ENV   = "test";
process.env.JWT_SECRET = "test-jwt-secret-for-ci";
// deixa o default (8kb) valer -- não sobrescreve MAX_JSON_BODY_BYTES.

const request = require("supertest");
const { app, db } = require("../server");

const LIMIT_BYTES = 8192; // 8kb

after(() => {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

// helper: monta um JSON de EXATAMENTE `n` bytes: {"email":"a@b.co","password":"<pad>"}
function jsonOfExactBytes(n) {
  const prefix = '{"email":"a@b.co","password":"';
  const suffix = '"}';
  const padLen = n - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(padLen > 0, "n pequeno demais");
  return prefix + "x".repeat(padLen) + suffix;
}

describe("limite de corpo — express.json({ limit: 8kb })", () => {
  test("abaixo do limite: corpo JSON pequeno é processado normalmente (não 413)", async () => {
    const res = await request(app).post("/v1/auth/login")
      .set("Content-Type", "application/json")
      .send({ email: "nobody@example.invalid", password: "whatever0" });
    assert.notEqual(res.status, 413);
    assert.equal(res.status, 401); // INVALID_CREDENTIALS -- chegou na rota
    assert.equal(res.body.error, "INVALID_CREDENTIALS");
  });

  test("exatamente no limite (8192 bytes): aceito, não 413", async () => {
    const body = jsonOfExactBytes(LIMIT_BYTES);
    assert.equal(Buffer.byteLength(body), LIMIT_BYTES);
    const res = await request(app).post("/v1/auth/register")
      .set("Content-Type", "application/json")
      .send(body);
    // registrou (200) ou e-mail já existe de um run anterior no mesmo processo (409);
    // o que importa: NÃO foi 413 nem 400 INVALID_JSON.
    assert.ok([200, 409].includes(res.status), `status inesperado ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test("acima do limite (8193 bytes): 413 REQUEST_BODY_TOO_LARGE estruturado", async () => {
    const body = jsonOfExactBytes(LIMIT_BYTES + 1);
    const res = await request(app).post("/v1/auth/register")
      .set("Content-Type", "application/json")
      .send(body);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "REQUEST_BODY_TOO_LARGE");
    assert.equal(res.body.limit, "8kb");
    assert.match(res.body.request_id, /^req_[0-9a-f]{16}$/);
  });

  test("muito acima do limite (1 MiB): ainda 413, corpo não é bufferizado inteiro", async () => {
    const big = '{"email":"a@b.co","password":"' + "y".repeat(1024 * 1024) + '"}';
    const res = await request(app).post("/v1/auth/register")
      .set("Content-Type", "application/json")
      .send(big);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "REQUEST_BODY_TOO_LARGE");
  });

  test("JSON inválido: 400 INVALID_JSON estruturado", async () => {
    const res = await request(app).post("/v1/auth/register")
      .set("Content-Type", "application/json")
      .send('{"email": "a@b.co", "password": ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "INVALID_JSON");
    assert.match(res.body.request_id, /^req_/);
  });

  test("resposta 413 NÃO contém HTML nem stack trace", async () => {
    const body = jsonOfExactBytes(LIMIT_BYTES + 100);
    const res = await request(app).post("/v1/auth/register")
      .set("Content-Type", "application/json")
      .send(body);
    assert.equal(res.status, 413);
    assert.match(res.headers["content-type"] || "", /application\/json/);
    const raw = res.text || JSON.stringify(res.body);
    assert.doesNotMatch(raw, /<html|<!DOCTYPE|<pre>/i, "não deve devolver HTML");
    assert.doesNotMatch(raw, /\bat \S+ \(.*:\d+:\d+\)/, "não deve devolver stack trace");
    assert.doesNotMatch(raw, /PayloadTooLargeError|Error: request entity too large/, "não deve vazar a classe/mensagem interna do body-parser");
  });

  test("Content-Length incorreto (declara menos do que envia): não passa corpo grande adiante", async () => {
    // raw http: envia 200 bytes mas declara Content-Length: 10 -> o parser lê só 10,
    // JSON truncado -> 400 INVALID_JSON (nunca 200 com corpo completo).
    const payload = '{"email":"a@b.co","password":"' + "z".repeat(200) + '"}';
    const { statusCode, text } = await rawPost("/v1/auth/register", payload, { "Content-Length": "10", "Content-Type": "application/json" });
    assert.ok([400, 413].includes(statusCode), `status ${statusCode}: ${text}`);
  });

  test("Transfer-Encoding: chunked acima do limite -> 413 (limite vale para chunked)", async () => {
    const big = '{"email":"a@b.co","password":"' + "w".repeat(LIMIT_BYTES * 2) + '"}';
    const { statusCode, body } = await rawPost("/v1/auth/register", big, { "Transfer-Encoding": "chunked", "Content-Type": "application/json" }, true);
    assert.equal(statusCode, 413);
    const j = JSON.parse(body);
    assert.equal(j.error, "REQUEST_BODY_TOO_LARGE");
  });

  test("nenhuma rota deste serviço aceita corpo grande — upload NIST é outro serviço", async () => {
    // /v1/random e /v1/raw são GET; não há rota de upload aqui. O upload NIST
    // (arquivos grandes de amostras) vai para :18002 (FastAPI) via nginx
    // /qrng/nist/ e tem política de limite SEPARADA (ver REQUEST_BODY_LIMITS.md).
    const res = await request(app).post("/v1/nist/upload").send({ x: "y" });
    assert.equal(res.status, 404); // rota não existe neste serviço
  });
});

// ── raw HTTP helper (para casos que o supertest/superagent normaliza) ────────
let server;
before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(() => { if (server) server.close(); });

function rawPost(pathname, payload, headers, chunked = false) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const opts = { host: "127.0.0.1", port, method: "POST", path: pathname, headers: { ...headers } };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data, text: data }));
    });
    req.on("error", reject);
    if (chunked) {
      // escreve em pedaços para forçar chunked de verdade
      const buf = Buffer.from(payload);
      for (let i = 0; i < buf.length; i += 4096) req.write(buf.subarray(i, i + 4096));
      req.end();
    } else {
      req.end(payload);
    }
  });
}
