"use strict";

/**
 * Contrato do modo binário explícito (item 2 da rodada de estabilização):
 *
 *  - GET /v1/random?format=raw  e  GET /v1/raw           (autenticado)
 *  - GET /v1/public/random?format=raw  e  GET /v1/public/raw   (anônimo)
 *
 * Prova, com um upstream FALSO determinístico (replay), que:
 *  - o corpo raw são EXATAMENTE N bytes, application/octet-stream, Content-Length = N;
 *  - não há JSON, texto, prefixo nem BOM no corpo;
 *  - request_id e proveniência vão só nos headers;
 *  - raw ↔ hex ↔ base64 ↔ uint8 decodificam para a MESMA sequência de bytes;
 *  - GET /raw é byte-idêntico a GET /random?format=raw;
 *  - omitir `format` continua retornando JSON (compatibilidade preservada);
 *  - limites e erros (0, acima do máximo, sem token) permanecem corretos.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("http");
const crypto = require("crypto");
const os     = require("os");
const fs     = require("fs");
const path   = require("path");

// ── upstream FALSO determinístico ────────────────────────────────────────────
// Pool grande e fixo; a resposta são os primeiros ?bytes= do pool. Assim o
// mesmo bloco lógico é reproduzível em qualquer formato/rota.
const POOL = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < POOL.length; i++) POOL[i] = (i * 73 + 11) & 0xff;

const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (!u.pathname.endsWith("/random")) {
    // /health
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ source_status: "online", stream_format: "uint32-le" }));
  }
  const n = Math.max(1, Math.min(POOL.length, Number(u.searchParams.get("bytes") || "32")));
  const body = POOL.subarray(0, n);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
  res.end(body);
});

const testDbPath = path.join(os.tmpdir(), `qrng-raw-contract-${Date.now()}.db`);
let app, db, agent, apiToken;
const BYTES = 64;
const expectedBlock = POOL.subarray(0, BYTES);
const expectedSha = crypto.createHash("sha256").update(expectedBlock).digest("hex");

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;

  process.env.DB_PATH                            = testDbPath;
  process.env.NODE_ENV                           = "test";
  process.env.JWT_SECRET                         = "test-jwt-secret-for-ci";
  process.env.QRNG_UPSTREAM                      = `http://127.0.0.1:${port}`;
  process.env.MAX_BYTES_PER_REQUEST             = "1048576";
  process.env.DAILY_QUOTA_REQUESTS              = "100000";
  process.env.DAILY_QUOTA_BYTES                 = "1073741824";
  process.env.PUBLIC_MAX_BYTES_PER_REQUEST      = "65536";
  process.env.PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE = "10000";
  process.env.PUBLIC_DAILY_QUOTA_REQUESTS_PER_IP  = "100000";
  process.env.PUBLIC_DAILY_QUOTA_BYTES_PER_IP     = "1073741824";

  ({ app, db } = require("../server"));
  const request = require("supertest");
  agent = request(app);

  const reg = await agent.post("/v1/auth/register").send({ email: `raw-${Date.now()}@qa.invalid`, password: "pw-abcdefgh" });
  const jwt = reg.body.token;
  const tok = await agent.post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
  apiToken = tok.body.token;
});

after(() => {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(testDbPath); } catch (_) {}
  upstream.close();
});

const auth = () => ({ Authorization: `Bearer ${apiToken}` });
const hasBOM = (buf) => buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;

describe("raw — /v1/random?format=raw (autenticado)", () => {
  test("status 200 + Content-Type application/octet-stream + Content-Length exato", async () => {
    const r = await agent.get(`/v1/random?bytes=${BYTES}&format=raw`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "application/octet-stream");
    assert.equal(r.headers["content-length"], String(BYTES));
    assert.equal(r.body.length, BYTES);
  });

  test("corpo = EXATAMENTE os N bytes esperados; SHA-256 confere; sem BOM", async () => {
    const r = await agent.get(`/v1/random?bytes=${BYTES}&format=raw`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    assert.ok(!hasBOM(r.body), "corpo não deve começar com BOM UTF-8");
    assert.deepEqual(r.body, expectedBlock);
    assert.equal(crypto.createHash("sha256").update(r.body).digest("hex"), expectedSha);
  });

  test("request_id e proveniência vão nos headers, NUNCA no corpo binário", async () => {
    const r = await agent.get(`/v1/random?bytes=${BYTES}&format=raw`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    assert.match(r.headers["x-request-id"], /^req_[0-9a-f]{16}$/);
    assert.equal(r.headers["x-qrng-source"], "dobslit-qrng-ufpe-fpga");
    assert.equal(r.headers["x-qrng-conditioned"], "false");
    assert.equal(r.headers["cache-control"], "no-store");
    // corpo não contém "request_id", "{", "source" nem nada textual injetado
    assert.ok(!r.body.includes(Buffer.from("request_id")));
    assert.ok(!r.body.includes(Buffer.from("dobslit-qrng-ufpe-fpga")));
  });
});

describe("raw — equivalência de replay entre formatos (mesmo bloco lógico)", () => {
  test("raw ↔ hex ↔ base64 ↔ uint8 decodificam para a MESMA sequência de bytes", async () => {
    const raw = (await agent.get(`/v1/random?bytes=${BYTES}&format=raw`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    })).body;
    const hexR = await agent.get(`/v1/random?bytes=${BYTES}&format=hex`).set(auth());
    const b64R = await agent.get(`/v1/random?bytes=${BYTES}&format=base64`).set(auth());
    const u8R  = await agent.get(`/v1/random?bytes=${BYTES}&format=uint8`).set(auth());

    const fromHex = Buffer.from(hexR.body.random, "hex");
    const fromB64 = Buffer.from(b64R.body.random, "base64");
    const fromU8  = Buffer.from(u8R.body.random);

    assert.deepEqual(fromHex, expectedBlock);
    assert.deepEqual(fromB64, expectedBlock);
    assert.deepEqual(fromU8, expectedBlock);
    assert.deepEqual(raw, expectedBlock);
    // e todos entre si
    assert.equal(Buffer.compare(raw, fromHex), 0);
    assert.equal(Buffer.compare(fromHex, fromB64), 0);
    assert.equal(Buffer.compare(fromB64, fromU8), 0);
  });

  test("GET /v1/raw é byte-idêntico a GET /v1/random?format=raw", async () => {
    const a = (await agent.get(`/v1/raw?bytes=${BYTES}`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    })).body;
    const b = (await agent.get(`/v1/random?bytes=${BYTES}&format=raw`).set(auth()).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    })).body;
    assert.equal(Buffer.compare(a, b), 0);
    assert.deepEqual(a, expectedBlock);
  });
});

describe("raw — compatibilidade preservada", () => {
  test("omitir format continua retornando JSON (hex), NÃO binário", async () => {
    const r = await agent.get(`/v1/random?bytes=${BYTES}`).set(auth());
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    assert.equal(r.body.format, "hex");
    assert.equal(typeof r.body.random, "string");
    assert.deepEqual(Buffer.from(r.body.random, "hex"), expectedBlock);
  });

  test("format=raw explicitamente NÃO retorna JSON", async () => {
    const r = await agent.get(`/v1/random?bytes=${BYTES}&format=raw`).set(auth());
    assert.equal(r.headers["content-type"], "application/octet-stream");
  });
});

describe("raw — limites e erros", () => {
  test("bytes=0 → 422 INVALID_BYTES (JSON, não binário)", async () => {
    const r = await agent.get(`/v1/raw?bytes=0`).set(auth());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "INVALID_BYTES");
  });
  test("bytes acima do máximo → 413", async () => {
    const r = await agent.get(`/v1/raw?bytes=1048577`).set(auth());
    assert.equal(r.status, 413);
    assert.equal(r.body.error, "REQUEST_TOO_LARGE");
  });
  test("/v1/raw sem token → 401 MISSING_TOKEN", async () => {
    const r = await agent.get(`/v1/raw?bytes=${BYTES}`);
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "MISSING_TOKEN");
  });
  test("format inválido → 422 INVALID_FORMAT", async () => {
    const r = await agent.get(`/v1/random?bytes=${BYTES}&format=xml`).set(auth());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "INVALID_FORMAT");
  });
});

describe("raw — endpoint público", () => {
  test("/v1/public/raw: octet-stream, N bytes exatos, sem BOM, sem token", async () => {
    const r = await agent.get(`/v1/public/raw?bytes=${BYTES}`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "application/octet-stream");
    assert.equal(r.headers["content-length"], String(BYTES));
    assert.ok(!hasBOM(r.body));
    assert.deepEqual(r.body, expectedBlock);
    assert.equal(r.headers["x-qrng-conditioned"], "false");
  });

  test("/v1/public/random?format=raw ↔ /v1/public/raw byte-idênticos e = hex decodificado", async () => {
    const a = (await agent.get(`/v1/public/random?bytes=${BYTES}&format=raw`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    })).body;
    const hexR = await agent.get(`/v1/public/random?bytes=${BYTES}&format=hex`);
    assert.equal(Buffer.compare(a, Buffer.from(hexR.body.random, "hex")), 0);
    assert.deepEqual(a, expectedBlock);
  });
});
