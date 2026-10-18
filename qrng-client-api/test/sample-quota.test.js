"use strict";
// Amostra rápida (/v1/public/sample, pool de pré-carga) e cota pública (/v1/public/quota) — 2026-10-18.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const { EntropyPool } = require("../lib/entropyPool");

// ── Unidade: EntropyPool ─────────────────────────────────────────────────────

function counterFetcher() {
  let next = 0;
  const calls = [];
  return {
    calls,
    fetchBlock: async (n) => {
      calls.push(n);
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i++) buf[i] = (next + i) & 0xff;
      next += n;
      return { buf, upHdr: { "x-qrng-capture-id": `cap_${calls.length}` }, discontinuous: false };
    },
  };
}

test("pool: take() consome — os mesmos bytes nunca saem duas vezes, inclusive entre blocos", async () => {
  const f = counterFetcher();
  const pool = new EntropyPool({ fetchBlock: f.fetchBlock, capacityBytes: 300, blockBytes: 100 });
  await pool.refill();
  assert.equal(pool.available(), 300);
  const a = pool.take(150);           // bloco 1 inteiro + metade do 2
  const b = pool.take(150);           // metade do 2 + bloco 3
  assert.equal(a.buf.length, 150);
  assert.equal(a.blocks.length, 2);
  assert.deepEqual([...a.buf.subarray(148, 150)], [148, 149]);
  assert.deepEqual([...b.buf.subarray(0, 2)], [150, 151], "b começa onde a terminou");
  assert.equal(pool.take(1), null, "pool vazio devolve null — nada é inventado");
  assert.equal(pool.stats().served_bytes, 300);
});

test("pool: blocos mais velhos que maxAgeMs são descartados, não servidos", async () => {
  let now = 1_000_000;
  const f = counterFetcher();
  const pool = new EntropyPool({ fetchBlock: f.fetchBlock, capacityBytes: 200, blockBytes: 100, maxAgeMs: 5000, now: () => now });
  await pool.refill();
  now += 6000;
  assert.equal(pool.available(), 0);
  assert.equal(pool.take(10), null);
  assert.equal(pool.stats().discarded_bytes, 200);
});

test("pool: recarga é única (single-flight) e para quando o bloco é recusado ou a busca falha", async () => {
  const f = counterFetcher();
  const pool = new EntropyPool({ fetchBlock: f.fetchBlock, capacityBytes: 200, blockBytes: 100 });
  await Promise.all([pool.refill(), pool.refill(), pool.refill()]);
  assert.equal(f.calls.length, 2, "duas buscas de 100 para encher 200, não seis");
  const refused = new EntropyPool({ fetchBlock: async () => null, capacityBytes: 200, blockBytes: 100 });
  await refused.refill();
  assert.equal(refused.available(), 0);
  const failing = new EntropyPool({ fetchBlock: async () => { throw new Error("túnel caiu"); }, capacityBytes: 200, blockBytes: 100 });
  await failing.refill();
  assert.equal(failing.stats().last_error, "túnel caiu");
});

test("pool: capacityBytes 0 desliga a pré-carga", async () => {
  const f = counterFetcher();
  const pool = new EntropyPool({ fetchBlock: f.fetchBlock, capacityBytes: 0 });
  await pool.refill();
  assert.equal(f.calls.length, 0);
});

// ── Integração: endpoints ────────────────────────────────────────────────────

const testDbPath = path.join(os.tmpdir(), `qrng-sample-${Date.now()}.db`);
let app, db, entropyPool, checkUpstream;
const upstream = { calls: [], next: 0, extraHeaders: {} };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ buffer_bytes_available: 1 << 20, buffer_capacity: 1 << 21, total_pushed: 10, total_popped: 5,
      source_status: "online", source_stall_seconds: 0, stream_format: "uint32-le", sample_width_bytes: 4 }));
  }
  if (u.pathname === "/random") {
    const n = Number(u.searchParams.get("bytes"));
    upstream.calls.push(n);
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (upstream.next + i) & 0xff;
    upstream.next += n;
    res.writeHead(200, {
      "content-type": "application/octet-stream", "content-length": buf.length,
      "x-qrng-source-status": "online", "x-qrng-received-at": new Date().toISOString(),
      "x-qrng-entropy-health": "hw_health_tests_passing", "x-qrng-qualification-status": "verified_active_bitstream",
      "x-qrng-discontinuities": "0", ...upstream.extraHeaders,
    });
    return res.end(buf);
  }
  res.writeHead(404); res.end();
});

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-for-ci";
  process.env.QRNG_UPSTREAM = `http://127.0.0.1:${server.address().port}`;
  process.env.QRNG_REQUEST_TIMEOUT_MS = "1500";
  process.env.PUBLIC_SAMPLE_MAX_BYTES = "4096";
  process.env.ENTROPY_POOL_BYTES = "8192";
  process.env.PUBLIC_SAMPLE_PER_WINDOW = "8";
  ({ app, db, entropyPool, checkUpstream } = require("../server"));
  await checkUpstream();
});
after(() => {
  try { db.close(); } catch (_) {}
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(testDbPath + s); } catch (_) {} }
  server.close();
});

const request = require("supertest");
const binary = (res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); };

test("/public/sample sem pool: busca direto (1 chamada ao broker), entrega N bytes binários e conta na cota", async () => {
  const before = upstream.calls.length;
  const r = await request(app).get("/v1/public/sample?bytes=4096").buffer(true).parse(binary);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.equal(r.body.length, 4096);
  assert.equal(r.headers["x-qrng-delivery"], "direct");
  assert.equal(upstream.calls.length - before >= 1, true);
  assert.equal(upstream.calls[before], 4096, "uma única chamada com o tamanho pedido");
  const q = await request(app).get("/v1/public/quota");
  assert.equal(q.status, 200);
  assert.equal(q.body.scope, "ip");
  assert.equal(q.body.bytes_today, 4096);
  assert.equal(q.body.requests_today, 1);
  assert.equal(q.body.sample_max_bytes, 4096);
  assert.ok(Date.parse(q.body.resets_at) > Date.now());
});

test("/public/sample com pool: entrega do pool, proveniência live verificada, sem repetir bytes entre respostas", async () => {
  await entropyPool.refill();
  assert.ok(entropyPool.available() >= 8192);
  const a = await request(app).get("/v1/public/sample?bytes=3000").buffer(true).parse(binary);
  const b = await request(app).get("/v1/public/sample?bytes=3000").buffer(true).parse(binary);
  assert.equal(a.headers["x-qrng-delivery"], "prefetch-pool");
  assert.equal(b.headers["x-qrng-delivery"], "prefetch-pool");
  assert.ok(Number(a.headers["x-qrng-pool-age-ms"]) >= 0);
  assert.equal(a.headers["x-qrng-provenance"], "live");
  assert.equal(a.headers["x-qrng-live-verified"], "true");
  assert.equal(a.headers["x-qrng-buffer-health"], "healthy");
  // contador do broker falso: b continua exatamente de onde a parou
  assert.equal((a.body[2999] + 1) & 0xff, b.body[0]);
});

test("/public/sample: limites — acima do máximo 413, inválido 422", async () => {
  assert.equal((await request(app).get("/v1/public/sample?bytes=4097")).status, 413);
  assert.equal((await request(app).get("/v1/public/sample?bytes=abc")).status, 422);
  assert.equal((await request(app).get("/v1/public/sample?bytes=0")).status, 422);
});

test("/public/quota não consome cota", async () => {
  const q1 = await request(app).get("/v1/public/quota");
  const q2 = await request(app).get("/v1/public/quota");
  assert.equal(q2.body.requests_today, q1.body.requests_today);
});

test("/public/sample: limite de amostras por janela devolve 429 em JSON", async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await request(app).get("/v1/public/sample?bytes=16").buffer(true).parse(binary);
  assert.equal(last.status, 429);
});
