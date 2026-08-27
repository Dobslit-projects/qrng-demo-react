// Rate limit no STAGING atrás do nginx real do compose. Roda por ÚLTIMO
// (nome > api/downloads) para não estourar a cota dos outros specs.
// NOTA: um único IP de origem (o runner). Isolamento entre DOIS IPs reais é
// tratado separadamente em physical-layer/RATE_LIMIT_MULTI_IP.md (item 4).
import { test, expect } from "@playwright/test";

test.describe.serial("rate limit — endpoint público por IP", () => {
  test("burst excede PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE e retorna 429 estruturado", async ({ request }) => {
    const codes = [];
    let body429 = null;
    for (let i = 0; i < 90; i++) {
      const r = await request.get(`/qrng/api/random?bytes=4`);
      codes.push(r.status());
      if (r.status() === 429 && !body429) body429 = await r.json();
      if (codes.filter((c) => c === 429).length >= 3) break;
    }
    expect(codes).toContain(200);
    expect(codes).toContain(429);
    expect(body429.error).toBe("RATE_LIMIT_EXCEEDED");
    // headers padrão de rate limit presentes em alguma resposta 200
  });

  test("headers RateLimit-* presentes nas respostas do endpoint público", async ({ request }) => {
    test.setTimeout(90000);
    // espera a janela (60s) reabrir parcialmente
    await new Promise((r) => setTimeout(r, 61000));
    const r = await request.get(`/qrng/api/random?bytes=4`);
    const h = r.headers();
    // express-rate-limit standardHeaders: true
    expect(h["ratelimit-limit"] || h["ratelimit-policy"]).toBeTruthy();
    expect(h["ratelimit-remaining"]).toBeTruthy();
  });
});
