"use strict";
// Item 4.1 — prova de integridade e serialização na REGIÃO server_api.py → API
// → formatos. Um MESMO payload binário conhecido (identificado por capture_id)
// é servido pelo upstream mockado; a API é consultada em raw/hex/base64/uint8;
// o teste decodifica e exige o MESMO tamanho e SHA-256 do original.
//
// Cobre também as armadilhas: ASCII decimal concatenado, hex interpretado como
// bytes, Base64 duplo, BOM, newline final, truncamento, padding, troca de
// endianness, signed vs unsigned, divisão Monte Carlo por 2^32, e a
// impossibilidade de um valor Monte Carlo == 1.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ── payloads determinísticos (capture_id = sha256) ──────────────────────────
function incremental(n) { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = i & 0xff; return b; }
function pattern(n, seed) { const b = Buffer.alloc(n); let s = (seed >>> 0) || 1; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = s & 0xff; } return b; }
const PAYLOADS = {
  "1B": Buffer.from([0xa5]),
  "3B": Buffer.from([0xde, 0xad, 0xbe]),
  "4B": Buffer.from([0x00, 0x01, 0xfe, 0xff]),
  "7B_nonmult4": Buffer.from([1, 2, 3, 4, 5, 6, 7]),
  "zeros_64": Buffer.alloc(64, 0x00),
  "ff_64": Buffer.alloc(64, 0xff),
  "incremental_256": incremental(256),
  "pattern_1000": pattern(1000, 20260828),
  "ascii_digits": Buffer.from("31323334353637383930313233343536", "hex"), // bytes que "parecem" dígitos ASCII "1234567890123456"
};

// ── upstream mock: serve exatamente o payload pedido via ?bytes= ────────────
// (o client-api sobre-provisiona: pede bytes*20; devolvemos o payload repetido
//  e o handler corta para o tamanho exato)
let CURRENT = PAYLOADS["4B"];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (!u.pathname.endsWith("/random")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ source_status: "online", stream_format: "uint32-le", conditioned: false }));
  }
  const want = Math.max(1, Number(u.searchParams.get("bytes") || "32"));
  const out = Buffer.alloc(want);
  for (let i = 0; i < want; i++) out[i] = CURRENT[i % CURRENT.length];
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(out.length) });
  res.end(out);
});

const testDbPath = path.join(os.tmpdir(), `qrng-serial-${Date.now()}.db`);
let app, db, agent, TOKEN;

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-for-ci";
  process.env.QRNG_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
  process.env.MAX_BYTES_PER_REQUEST = "1048576";
  process.env.DAILY_QUOTA_REQUESTS = "1000000";
  process.env.DAILY_QUOTA_BYTES = "1073741824";
  ({ app, db } = require("../server"));
  const request = require("supertest");
  agent = request(app);
  const reg = await agent.post("/v1/auth/register").send({ email: `serial-${Date.now()}@qa.invalid`, password: "pw-abcdefgh" });
  const jwt = reg.body.token;
  const tok = await agent.post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
  TOKEN = tok.body.token;
});
after(() => { try { db.close(); } catch (_) {} try { fs.unlinkSync(testDbPath); } catch (_) {} upstream.close(); });
const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

async function getRaw(bytes) {
  const r = await agent.get(`/v1/random?bytes=${bytes}&format=raw`).set(auth()).buffer(true)
    .parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
  return r;
}
const getJson = (bytes, fmt) => agent.get(`/v1/random?bytes=${bytes}&format=${fmt}`).set(auth());

// ── round-trip por payload e por formato ────────────────────────────────────
for (const [name, payload] of Object.entries(PAYLOADS)) {
  test(`round-trip preserva bytes: ${name} (${payload.length}B, sha ${sha256(payload).slice(0, 12)})`, async () => {
    CURRENT = payload;
    const N = payload.length;
    const expSha = sha256(payload);

    // RAW: corpo == payload, exato
    const raw = await getRaw(N);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["content-type"], "application/octet-stream");
    assert.equal(raw.headers["content-length"], String(N));
    assert.equal(raw.body.length, N);
    assert.equal(sha256(raw.body), expSha, "raw preserva o SHA-256");
    // sem BOM
    assert.ok(!(raw.body.length >= 3 && raw.body[0] === 0xEF && raw.body[1] === 0xBB && raw.body[2] === 0xBF), "sem BOM");
    // primeiro/último valor
    assert.equal(raw.body[0], payload[0]);
    assert.equal(raw.body[N - 1], payload[N - 1]);

    // HEX -> bytes
    const hx = await getJson(N, "hex");
    assert.equal(hx.status, 200);
    assert.match(hx.body.random, /^[0-9a-f]*$/);
    assert.equal(hx.body.random.length, N * 2, "2 chars por byte");
    const fromHex = Buffer.from(hx.body.random, "hex");
    assert.equal(fromHex.length, N);
    assert.equal(sha256(fromHex), expSha, "hex->bytes preserva o SHA-256");
    // hex NÃO é os bytes ASCII do hex (armadilha)
    if (N > 0) assert.notEqual(sha256(Buffer.from(hx.body.random, "utf8")), expSha);

    // BASE64 -> bytes
    const b64 = await getJson(N, "base64");
    assert.equal(b64.status, 200);
    const fromB64 = Buffer.from(b64.body.random, "base64");
    assert.equal(fromB64.length, N);
    assert.equal(sha256(fromB64), expSha, "base64->bytes preserva o SHA-256");
    // NÃO é base64 duplo: decodificar 1x já dá os bytes originais; decodificar
    // o resultado como base64 de novo NÃO reproduz o payload.
    if (N > 0) {
      assert.equal(sha256(Buffer.from(fromB64.toString("base64"), "base64")), expSha, "re-encode/decode simples é idempotente");
      const asIfDouble = Buffer.from(b64.body.random, "utf8"); // tratar a string b64 como se fosse bytes
      assert.notEqual(sha256(asIfDouble), expSha, "a string base64 não é o payload");
    }

    // UINT8 -> bytes
    const u8 = await getJson(N, "uint8");
    assert.equal(u8.status, 200);
    assert.ok(Array.isArray(u8.body.random));
    assert.equal(u8.body.random.length, N);
    for (const v of u8.body.random) { assert.ok(Number.isInteger(v) && v >= 0 && v <= 255); }
    const fromU8 = Buffer.from(u8.body.random);
    assert.equal(sha256(fromU8), expSha, "uint8->bytes preserva o SHA-256");

    // os quatro caminhos concordam
    assert.equal(sha256(raw.body), sha256(fromHex));
    assert.equal(sha256(fromHex), sha256(fromB64));
    assert.equal(sha256(fromB64), sha256(fromU8));

    // uint32-LE: primeiro/último e endianness (quando múltiplo de 4)
    if (N >= 4 && N % 4 === 0) {
      const w0 = raw.body.readUInt32LE(0);
      const w0be = raw.body.readUInt32BE(0);
      assert.equal(w0, payload.readUInt32LE(0), "uint32 LE do primeiro word");
      if (payload.readUInt32LE(0) !== payload.readUInt32BE(0)) assert.notEqual(w0, w0be, "LE != BE (não há troca)");
      // signed vs unsigned: o valor unsigned nunca é negativo
      assert.ok(w0 >= 0 && w0 <= 0xffffffff);
    }
  });
}

// ── sem newline final, sem truncamento, sem padding ─────────────────────────
test("hex/base64/uint8 não têm newline final nem espaços; raw não tem padding", async () => {
  CURRENT = PAYLOADS.pattern_1000;
  const hx = await getJson(1000, "hex");
  assert.ok(!/\s/.test(hx.body.random), "hex sem whitespace");
  const b64 = await getJson(1000, "base64");
  assert.ok(!/\n|\r|\s/.test(b64.body.random), "base64 sem newline/whitespace");
  const raw = await getRaw(1000);
  assert.equal(raw.body.length, 1000, "raw exatamente N bytes (sem padding)");
});

// ── Monte Carlo: uint32 / 2^32 nunca dá 1; extremos ─────────────────────────
test("Monte Carlo: normalização uint32/2^32 ∈ [0,1), nunca == 1; extremos", async () => {
  // maior uint32 possível
  CURRENT = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const raw = await getRaw(8);
  const wMax = raw.body.readUInt32LE(0);
  assert.equal(wMax, 0xffffffff);
  const uMax = wMax / 4294967296;
  assert.ok(uMax < 1, "0xffffffff / 2^32 < 1");
  assert.ok(uMax > 0.9999999997, "e muito próximo de 1");
  // menor
  CURRENT = Buffer.alloc(8, 0x00);
  const raw0 = await getRaw(8);
  assert.equal(raw0.body.readUInt32LE(0), 0);
  assert.equal(0 / 4294967296, 0);
  // varredura: nenhum u == 1
  CURRENT = pattern(4000, 7);
  const rr = await getRaw(4000);
  for (let i = 0; i + 4 <= rr.body.length; i += 4) {
    const u = rr.body.readUInt32LE(i) / 4294967296;
    assert.ok(u >= 0 && u < 1, `u=${u} fora de [0,1)`);
  }
});

// ── ASCII decimal concatenado: bytes que parecem "123456..." não viram números
test("payload que parece ASCII decimal é tratado como BYTES, não como número", async () => {
  CURRENT = PAYLOADS.ascii_digits; // 0x31 0x32 ... = "12345678..."
  const raw = await getRaw(CURRENT.length);
  assert.equal(sha256(raw.body), sha256(CURRENT));
  const u8 = await getJson(CURRENT.length, "uint8");
  assert.deepEqual(u8.body.random, Array.from(CURRENT), "uint8 = os bytes 0x31.. e NÃO [1,2,3,..]");
});
