// Item 10 da rodada de estabilizacao: cobertura E2E real, contra o ambiente
// real (nao ha staging separado -- ver nota em playwright.config.js).
//
// ESCOPO DESTA PRIMEIRA FATIA (honesto, nao a lista completa pedida):
// endpoint publico anonimo (todos os formatos, N solicitado==entregue,
// erros 422/413/429), OpenAPI/Swagger/ReDoc, e o gate de sessao do portal.
// NAO coberto ainda: fluxos autenticados dentro do SPA (Monte Carlo,
// histogramas, NIST upload/live, comparacao PRNG x QRNG, sonificacao) --
// exigem uma sessao valida do bongosite-auth (app separada, fora deste
// repositorio) que nao foi possivel provisionar nesta rodada. Ver relatorio
// final para o plano de completar essa cobertura.
import { test, expect } from "@playwright/test";

test.describe("Endpoint público anônimo — /qrng/v1/public/random", () => {
  test("hex: N solicitado == N entregue, decodifica para o tamanho certo", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=32&format=hex");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.bytes).toBe(32);
    expect(body.random).toHaveLength(64);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["x-request-id"]).toBeTruthy();
    expect(res.headers()["x-request-id"]).toBe(body.request_id);
  });

  test("base64: decodifica para o tamanho certo", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=32&format=base64");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const decoded = Buffer.from(body.random, "base64");
    expect(decoded.length).toBe(32);
  });

  test("uint8: array de N inteiros em [0,255]", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=32&format=uint8");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.random).toHaveLength(32);
    for (const v of body.random) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  test("bytes acima do limite público retorna 413, não 500", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=999999999");
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("REQUEST_TOO_LARGE");
  });

  test("bytes inválido retorna 422", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=abc");
    expect(res.status()).toBe(422);
  });

  test("format inválido retorna 422", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=32&format=nope");
    expect(res.status()).toBe(422);
  });

  test("Monte Carlo: U=uint32/2^32 nunca >= 1 sobre uma amostra real", async ({ request }) => {
    const res = await request.get("/qrng/v1/public/random?bytes=4000&format=hex");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const raw = Buffer.from(body.random, "hex");
    for (let i = 0; i + 3 < raw.length; i += 4) {
      const u32 = raw.readUInt32LE(i);
      const u = u32 / 4294967296;
      expect(u).toBeLessThan(1);
      expect(u).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe("Rate limit por IP — resistência a spoofing de X-Forwarded-For", () => {
  test("21ª requisição no minuto, mesmo com X-Forwarded-For diferente a cada vez, retorna 429", async ({ request }) => {
    let lastStatus = 200;
    for (let i = 0; i < 22; i++) {
      const res = await request.get("/qrng/v1/public/random?bytes=4", {
        headers: { "X-Forwarded-For": `198.51.100.${i}` },
      });
      lastStatus = res.status();
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

test.describe("OpenAPI, Swagger, ReDoc", () => {
  test("openapi.json é JSON válido, OpenAPI 3.x, sem rotas /admin", async ({ request }) => {
    const res = await request.get("/qrng/v1/openapi.json");
    expect(res.status()).toBe(200);
    const spec = await res.json();
    expect(spec.openapi.startsWith("3.")).toBe(true);
    expect(spec.paths["/random"]).toBeTruthy();
    expect(spec.paths["/public/random"]).toBeTruthy();
    expect(Object.keys(spec.paths).some((p) => p.startsWith("/admin"))).toBe(false);
  });

  test("Swagger UI carrega sem erro de console e mostra o título correto", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/qrng/v1/docs/");
    await expect(page).toHaveTitle(/Kapuã/);
    expect(errors).toEqual([]);
  });

  test("ReDoc carrega e referencia openapi.json", async ({ page }) => {
    await page.goto("/qrng/v1/redoc");
    const html = await page.content();
    expect(html).toContain("/v1/openapi.json");
  });

  test("admin OpenAPI JSON sem autenticação retorna 401, não vaza o schema", async ({ request }) => {
    const res = await request.get("/qrng/v1/internal/admin-openapi.json");
    expect(res.status()).toBe(401);
  });
});

test.describe("Portal — gate de sessão", () => {
  test("acessar o portal sem cookie de sessão redireciona (302) para login", async ({ request }) => {
    const res = await request.get("/qrng/", { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(res.status());
  });
});

test.describe("Health", () => {
  test("/v1/health/self responde 200 com estrutura esperada", async ({ request }) => {
    const res = await request.get("/qrng/v1/health/self");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.service).toBeTruthy();
  });
});
