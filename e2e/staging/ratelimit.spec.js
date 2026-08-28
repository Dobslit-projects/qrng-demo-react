// Rate limit no STAGING atrás do nginx real do compose. NOTA: um único IP de
// origem (o runner). Isolamento entre DOIS IPs reais é tratado separadamente em
// physical-layer/RATE_LIMIT_MULTI_IP.md (item 4).
// Este spec ESTOURA de propósito o rate-limit público; o `afterAll` zera o
// contador (rota só-staging) para não envenenar os specs que rodam depois
// (`ui`, `viz-provenance`) — antes, a viz de π pegava 429 no CI.
import { test, expect } from "@playwright/test";

test.afterAll(async ({ request }) => {
  await request.post("/qrng/v1/_test/reset-rate-limit").catch(() => {});
});

test.describe.serial("rate limit — endpoint público por IP", () => {
  test("headers RateLimit-* presentes numa resposta 200", async ({ request }) => {
    const r = await request.get(`/qrng/api/random?bytes=4`);
    expect(r.status()).toBe(200);
    const h = r.headers();
    expect(h["ratelimit-limit"] || h["ratelimit-policy"]).toBeTruthy();
    expect(h["ratelimit-remaining"]).toBeTruthy();
  });

  test("burst excede PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE e retorna 429 estruturado", async ({ request }) => {
    test.setTimeout(60000);
    const codes = [];
    let body429 = null, retryAfter = null;
    for (let i = 0; i < 120; i++) {
      const r = await request.get(`/qrng/api/random?bytes=4`);
      codes.push(r.status());
      if (r.status() === 429 && !body429) { body429 = await r.json(); retryAfter = r.headers()["retry-after"]; }
      if (codes.filter((c) => c === 429).length >= 3) break;
    }
    expect(codes).toContain(200);
    expect(codes).toContain(429);
    expect(body429.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(body429.request_id).toMatch(/^req_/);
    expect(retryAfter).toBeTruthy(); // Retry-After presente no 429
    // após o 429, todas as próximas na mesma janela continuam 429 (não intermitente)
    const firstIdx = codes.indexOf(429);
    expect(codes.slice(firstIdx).every((c) => c === 429)).toBe(true);
  });
});
