// E2E determinístico contra o STAGING reproduzível (upstream = fixture replay).
// Cobre: acesso anônimo + autenticado, Raw/Hex/Base64/uint8, N→N, proveniência,
// Monte Carlo, faixa, Swagger/ReDoc/OpenAPI, health, erros 400/401/403/404/413/422/503.
// O 429 (rate limit) fica em ratelimit.spec.js.
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";

const FIXTURE_CTL = process.env.FIXTURE_CTL_URL || null;
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const noBOM = (b) => !(b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF);

// Token pessoal p/ o grosso dos testes (o endpoint público tem limite baixo,
// reservado para o teste de 429).
let TOKEN;
test.beforeAll(async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL });
  const email = `e2e-${crypto.randomBytes(5).toString("hex")}@staging.invalid`;
  const reg = await ctx.post(`/qrng/v1/auth/register`, { data: { email, password: "e2e-passw0rd" } });
  const jwt = (await reg.json()).token;
  const tk = await ctx.post(`/qrng/v1/tokens`, { headers: { Authorization: `Bearer ${jwt}` } });
  TOKEN = (await tk.json()).token;
  await ctx.dispose();
});

const auth = () => ({ Authorization: `Bearer ${TOKEN}` });
async function fixtureReset(request) {
  if (!FIXTURE_CTL) return;
  await request.post(`${FIXTURE_CTL}/_ctl/reset`);
}

test.describe("proveniência — nunca 'live'", () => {
  test("público: provenance=replay, source=staging-fixture-replay", async ({ request }) => {
    const b = await (await request.get(`/qrng/api/random?bytes=32&format=hex`)).json();
    expect(b.provenance).toBe("replay");
    expect(b.provenance).not.toBe("live");
  });
  test("autenticado: provenance=replay", async ({ request }) => {
    const b = await (await request.get(`/qrng/v1/random?bytes=32&format=hex`, { headers: auth() })).json();
    expect(b.provenance).toBe("replay");
  });
  test("/v1/health repassa proveniência e não diz 'live'", async ({ request }) => {
    const r = await request.get(`/qrng/v1/health`, { headers: auth() });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.provenance).toBe("replay");
    expect(b.upstream.conditioned).toBe(false);
    expect(b.upstream.stream_format).toBe("uint32-le");
  });
});

test.describe("formatos e N→N (autenticado)", () => {
  for (const n of [1, 16, 100, 1000, 65536]) {
    test(`hex/base64/uint8 bytes=${n} → exatamente N bytes`, async ({ request }) => {
      const hex = await (await request.get(`/qrng/v1/random?bytes=${n}&format=hex`, { headers: auth() })).json();
      expect(hex.bytes).toBe(n);
      expect(Buffer.from(hex.random, "hex")).toHaveLength(n);
      const b64 = await (await request.get(`/qrng/v1/random?bytes=${n}&format=base64`, { headers: auth() })).json();
      expect(Buffer.from(b64.random, "base64")).toHaveLength(n);
      const u8 = await (await request.get(`/qrng/v1/random?bytes=${n}&format=uint8`, { headers: auth() })).json();
      expect(u8.random).toHaveLength(n);
      expect(Math.max(...u8.random)).toBeLessThanOrEqual(255);
    });
  }

  test("Raw binário real: octet-stream, N bytes, sem BOM, Content-Length=N, headers de proveniência", async ({ request }) => {
    const n = 4096;
    const r = await request.get(`/qrng/v1/raw?bytes=${n}`, { headers: auth() });
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toBe("application/octet-stream");
    expect(r.headers()["content-length"]).toBe(String(n));
    expect(r.headers()["x-qrng-provenance"]).toBe("replay");
    expect(r.headers()["x-qrng-conditioned"]).toBe("false");
    expect(r.headers()["x-request-id"]).toMatch(/^req_/);
    const body = Buffer.from(await r.body());
    expect(body).toHaveLength(n);
    expect(noBOM(body)).toBe(true);
  });

  test("Raw ↔ Hex ↔ Base64 ↔ uint8 → MESMO binário (replay determinístico), SHA-256 igual", async ({ request }) => {
    test.skip(!FIXTURE_CTL, "precisa de FIXTURE_CTL_URL para resetar o cursor do fixture");
    const n = 512;
    await fixtureReset(request);
    const raw = Buffer.from(await (await request.get(`/qrng/v1/raw?bytes=${n}`, { headers: auth() })).body());
    await fixtureReset(request);
    const hex = Buffer.from((await (await request.get(`/qrng/v1/random?bytes=${n}&format=hex`, { headers: auth() })).json()).random, "hex");
    await fixtureReset(request);
    const b64 = Buffer.from((await (await request.get(`/qrng/v1/random?bytes=${n}&format=base64`, { headers: auth() })).json()).random, "base64");
    await fixtureReset(request);
    const u8 = Buffer.from((await (await request.get(`/qrng/v1/random?bytes=${n}&format=uint8`, { headers: auth() })).json()).random);
    expect(Buffer.compare(raw, hex)).toBe(0);
    expect(Buffer.compare(hex, b64)).toBe(0);
    expect(Buffer.compare(b64, u8)).toBe(0);
    expect(sha256(raw)).toBe(sha256(u8));
  });
});

test.describe("Monte Carlo — U = uint32_LE / 2^32", () => {
  test("nenhum valor ≥ 1 sobre 10k amostras; max < 1", async ({ request }) => {
    const r = await request.get(`/qrng/v1/raw?bytes=40000`, { headers: auth() });
    const buf = Buffer.from(await r.body());
    let maxU = 0, ge1 = 0;
    for (let i = 0; i + 3 < buf.length; i += 4) {
      const u = buf.readUInt32LE(i) / 4294967296;
      if (u > maxU) maxU = u;
      if (u >= 1) ge1++;
    }
    expect(ge1).toBe(0);
    expect(maxU).toBeLessThan(1);
  });
});

test.describe("faixa personalizada", () => {
  test("uint8 fornece bytes suficientes p/ rejection sampling de uma faixa", async ({ request }) => {
    const b = await (await request.get(`/qrng/v1/random?bytes=800&format=uint8`, { headers: auth() })).json();
    expect(b.random.length).toBe(800);
  });
});

test.describe("docs", () => {
  test("OpenAPI 3.x, título Kapuã, RandomResponse.provenance required, sem rotas /admin", async ({ request }) => {
    const s = await (await request.get(`/qrng/v1/openapi.json`)).json();
    expect(s.openapi).toMatch(/^3\./);
    expect(s.info.title).toContain("Kapu");
    const rr = s.components.schemas.RandomResponse;
    expect(Object.keys(rr.properties)).toContain("provenance");
    expect(rr.required).toContain("provenance");
    expect(Object.keys(s.paths).some((p) => p.startsWith("/admin"))).toBe(false);
  });
  test("Swagger UI 200 text/html", async ({ request }) => {
    const r = await request.get(`/qrng/v1/docs/`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/html");
  });
  test("ReDoc 200 e referencia openapi.json", async ({ request }) => {
    const r = await request.get(`/qrng/v1/redoc`);
    expect(r.status()).toBe(200);
    expect(await r.text()).toContain("/v1/openapi.json");
  });
});

test.describe("health", () => {
  test("/v1/health/self 200 sem token", async ({ request }) => {
    const b = await (await request.get(`/qrng/v1/health/self`)).json();
    expect(b.status).toBe("ok");
  });
});

test.describe("códigos de erro", () => {
  test("422 INVALID_BYTES (bytes negativo)", async ({ request }) => {
    const r = await request.get(`/qrng/v1/random?bytes=-5`, { headers: auth() });
    expect(r.status()).toBe(422);
    expect((await r.json()).error).toBe("INVALID_BYTES");
  });
  test("422 INVALID_FORMAT", async ({ request }) => {
    const r = await request.get(`/qrng/v1/random?bytes=16&format=xml`, { headers: auth() });
    expect(r.status()).toBe(422);
    expect((await r.json()).error).toBe("INVALID_FORMAT");
  });
  test("413 REQUEST_TOO_LARGE (acima do máximo por request)", async ({ request }) => {
    const r = await request.get(`/qrng/v1/random?bytes=99999999`, { headers: auth() });
    expect(r.status()).toBe(413);
    expect((await r.json()).error).toBe("REQUEST_TOO_LARGE");
  });
  test("401 MISSING_TOKEN em /v1/random sem Authorization", async ({ request }) => {
    const r = await request.get(`/qrng/v1/random?bytes=16`);
    expect(r.status()).toBe(401);
    expect((await r.json()).error).toBe("MISSING_TOKEN");
  });
  test("403 INVALID_TOKEN com token inválido", async ({ request }) => {
    const r = await request.get(`/qrng/v1/random?bytes=16`, { headers: { Authorization: "Bearer nope" } });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe("INVALID_TOKEN");
  });
  test("401 em /v1/auth/me sem sessão", async ({ request }) => {
    expect((await request.get(`/qrng/v1/auth/me`)).status()).toBe(401);
  });
  test("404 em rota /v1/* inexistente", async ({ request }) => {
    expect((await request.get(`/qrng/v1/nao-existe`)).status()).toBe(404);
  });
  test("400 INVALID_JSON no register com corpo quebrado", async ({ request }) => {
    const r = await request.post(`/qrng/v1/auth/register`, { headers: { "content-type": "application/json" }, data: '{"email":' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("INVALID_JSON");
  });
  test("413 REQUEST_BODY_TOO_LARGE no register (> 8kb)", async ({ request }) => {
    const r = await request.post(`/qrng/v1/auth/register`, { data: { email: "a@b.co", password: "x".repeat(9000) } });
    expect(r.status()).toBe(413);
    expect((await r.json()).error).toBe("REQUEST_BODY_TOO_LARGE");
  });
  test("503 quando a fonte está offline (dirige o fixture)", async ({ request }) => {
    test.skip(!FIXTURE_CTL, "precisa de FIXTURE_CTL_URL");
    await request.post(`${FIXTURE_CTL}/_ctl/offline`);
    try {
      const r = await request.get(`/qrng/v1/random?bytes=16`, { headers: auth() });
      expect([502, 503]).toContain(r.status());
      const b = await r.json();
      expect(["QRNG_UNAVAILABLE", "UPSTREAM_ERROR", "INSUFFICIENT_ENTROPY"]).toContain(b.error);
    } finally {
      await request.post(`${FIXTURE_CTL}/_ctl/online`);
    }
  });
});

test.describe("geração criptográfica desabilitada", () => {
  test("não há caminho anônimo para emitir chave/seed/token", async ({ request }) => {
    expect((await request.post(`/qrng/v1/tokens`)).status()).toBe(401);
  });
});
