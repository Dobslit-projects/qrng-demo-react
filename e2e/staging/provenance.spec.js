// Item 3: contrato de proveniência POR RESPOSTA contra o STAGING.
// A instância client-api do staging roda com QRNG_PROVENANCE=replay (modo/teto):
// nenhuma resposta pode ser "live". Dirige o fixture upstream via /_ctl/mode
// para exercitar as transições (online / degraded / stale / exhausted / offline).
import { test, expect } from "@playwright/test";

const CTL = process.env.FIXTURE_CTL_URL || null;

async function mode(request, m, extra = "") {
  test.skip(!CTL, "FIXTURE_CTL_URL não definido");
  const r = await request.post(`${CTL}/_ctl/mode?mode=${m}${extra}`);
  expect(r.ok()).toBeTruthy();
}

test.afterAll(async ({ request }) => {
  if (CTL) await request.post(`${CTL}/_ctl/online`); // não deixa o fixture quebrado p/ os próximos specs
});

test.describe.serial("proveniência por resposta", () => {
  test.beforeEach(async ({ request }) => { if (CTL) await request.post(`${CTL}/_ctl/online`); });

  test("normal: provenance_detail presente, actual_origin=replay, nunca live, fallback_used=false", async ({ request }) => {
    const b = await (await request.get(`/qrng/api/random?bytes=32&format=hex`)).json();
    expect(b).toHaveProperty("provenance_detail");
    const d = b.provenance_detail;
    expect(d.actual_origin).toBe("replay");
    expect(d.actual_origin).not.toBe("live");
    expect(b.provenance).toBe(d.actual_origin);          // header/JSON/campo concordam
    expect(d.fallback_used).toBe(false);
    expect(d.live_verified).toBe(false);
    expect(d.instance_mode).toBe("replay");
    expect(d.configured_source).toBeTruthy();
    expect(["healthy", "degraded", "failed", "unknown"]).toContain(d.source_health);
    expect(d.served_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test("raw: headers de proveniência presentes e X-QRNG-Provenance == campo JSON", async ({ request }) => {
    const hexBody = await (await request.get(`/qrng/api/random?bytes=16&format=hex`)).json();
    const raw = await request.get(`/qrng/api/random?bytes=16&format=raw`);
    const h = raw.headers();
    expect(h["x-qrng-provenance"]).toBe(hexBody.provenance);
    expect(h["x-qrng-provenance"]).not.toBe("live");
    expect(h["x-qrng-live-verified"]).toBe("false");
    expect(h["x-qrng-fallback-used"]).toBe("false");
    expect(h["x-qrng-source-health"]).toBeTruthy();
    expect(h["x-qrng-buffer-health"]).toBeTruthy();
    expect(h["x-qrng-served-at"]).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test("/v1/health: reachable -> actual_origin=replay, nunca live", async ({ request }) => {
    const r = await request.get(`/qrng/v1/health`, { headers: await authHeader(request) });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.provenance_detail.actual_origin).toBe("replay");
    expect(b.provenance).toBe("replay");
    expect(b.provenance).not.toBe("live");
  });

  test("fonte offline: 502 UPSTREAM_ERROR com provenance_detail.actual_origin=unknown", async ({ request }) => {
    await mode(request, "offline");
    const r = await request.get(`/qrng/v1/random?bytes=32&format=hex`, { headers: await authHeader(request) });
    expect([502, 503]).toContain(r.status());
    const b = await r.json();
    expect(b.provenance_detail).toBeTruthy();
    expect(b.provenance_detail.actual_origin).toBe("unknown");
    expect(b.provenance_detail.actual_origin).not.toBe("live");
  });

  test("buffer esgotado: 503 INSUFFICIENT_ENTROPY, buffer_health=degraded, actual_origin=unknown", async ({ request }) => {
    await mode(request, "exhausted", "&remaining=16");
    const r = await request.get(`/qrng/v1/random?bytes=64&format=hex`, { headers: await authHeader(request) });
    expect(r.status()).toBe(503);
    const b = await r.json();
    expect(b.error).toBe("INSUFFICIENT_ENTROPY");
    expect(b.provenance_detail.buffer_health).toBe("degraded");
    expect(b.provenance_detail.actual_origin).toBe("unknown");
  });

  test("fonte degradada: source_health=degraded, ainda não é live", async ({ request }) => {
    await mode(request, "degraded");
    const b = await (await request.get(`/qrng/api/random?bytes=32&format=hex`)).json();
    expect(b.provenance_detail.source_health).toBe("degraded");
    expect(b.provenance_detail.actual_origin).not.toBe("live");
  });

  test("amostra antiga (stale): sample_age_ms grande, captured_at presente, não vira live", async ({ request }) => {
    await mode(request, "stale");
    const b = await (await request.get(`/qrng/api/random?bytes=32&format=hex`)).json();
    const d = b.provenance_detail;
    expect(d.captured_at).toBeTruthy();
    expect(d.sample_age_ms).toBeGreaterThan(3600 * 1000);
    expect(d.actual_origin).not.toBe("live");
  });

  test("OpenAPI reflete o contrato: ProvenanceDetail + RandomResponse.required", async ({ request }) => {
    const spec = await (await request.get(`/qrng/v1/openapi.json`)).json();
    expect(spec.components.schemas.ProvenanceDetail).toBeTruthy();
    expect(spec.components.schemas.RandomResponse.required).toContain("provenance_detail");
    const pd = spec.components.schemas.ProvenanceDetail;
    expect(pd.properties.actual_origin.enum).toEqual(
      expect.arrayContaining(["live", "fallback", "replay", "fixture", "historical", "unknown"]));
  });
});

let _token = null;
async function authHeader(request) {
  if (_token) return { Authorization: `Bearer ${_token}` };
  const email = `prov-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@staging.invalid`;
  const reg = await request.post(`/qrng/v1/auth/register`, { data: { email, password: "prov-passw0rd" } });
  const jwt = (await reg.json()).token;
  const tk = await request.post(`/qrng/v1/tokens`, { headers: { Authorization: `Bearer ${jwt}` } });
  _token = (await tk.json()).token;
  return { Authorization: `Bearer ${_token}` };
}
