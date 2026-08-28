"use strict";
// Item 5: contrato de erro — 404 catch-all e 500 SEMPRE JSON estruturado,
// nunca HTML nem stack trace, request_id preservado/gerado.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");

const testDbPath = path.join(os.tmpdir(), `qrng-errctr-${Date.now()}.db`);
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
  process.env.ENABLE_TEST_ROUTES = "1";
  ({ app, db } = require("../server"));
});
after(() => {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(testDbPath); } catch (_) {}
  upstream.close();
});

const request = require("supertest");

test("404: rota desconhecida -> JSON NOT_FOUND, nunca 'Cannot GET' HTML", async () => {
  const r = await request(app).get("/v1/rota/inexistente");
  assert.equal(r.status, 404);
  assert.match(r.headers["content-type"] || "", /application\/json/);
  assert.ok(!/Cannot GET/.test(r.text));
  assert.equal(r.body.error, "NOT_FOUND");
  assert.ok(r.body.request_id, "request_id presente");
});

test("500: /v1/_test/boom -> INTERNAL_ERROR, sem HTML/stack, request_id do cliente preservado", async () => {
  const rid = "req_client_supplied_abc123";
  const r = await request(app).get("/v1/_test/boom").set("X-Request-Id", rid);
  assert.equal(r.status, 500);
  assert.match(r.headers["content-type"] || "", /application\/json/);
  assert.ok(!/<html|<!DOCTYPE|node_modules|\bat \//i.test(r.text), "sem HTML nem stack no corpo");
  assert.equal(r.body.error, "INTERNAL_ERROR");
  assert.equal(r.body.message, "Erro interno.");
  assert.equal(r.body.request_id, rid, "request_id do cliente preservado");
  assert.ok(!("stack" in r.body));
});

test("500 sem request_id do cliente -> um request_id é gerado", async () => {
  const r = await request(app).get("/v1/_test/boom");
  assert.equal(r.status, 500);
  assert.match(r.body.request_id || "", /^req_/);
});
