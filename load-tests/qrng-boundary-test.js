/**
 * qrng-boundary-test.js
 *
 * Teste de limites (boundary) do endpoint /v1/random.
 * Valida que valores inválidos são rejeitados corretamente e que valores
 * válidos passam sem travar a API.
 *
 * Execução:
 *   k6 run load-tests/qrng-boundary-test.js \
 *     -e API_TOKEN=dobslit_qrng_live_xxx \
 *     -e BASE_URL=https://bongo.vps-uni5.net/qrng/v1
 */

import http from "k6/http";
import { check, group } from "k6";
import { Trend, Counter } from "k6/metrics";

// ── Configuração ──────────────────────────────────────────────────────────────

const BASE_URL  = __ENV.BASE_URL  || "https://bongo.vps-uni5.net/qrng/v1";
const API_TOKEN = __ENV.API_TOKEN || "SEU_TOKEN_AQUI";

const headers = {
  Authorization:  `Bearer ${API_TOKEN}`,
  "Content-Type": "application/json",
};

// Cada caso roda uma vez (1 VU, 1 iteração)
export const options = {
  vus:        1,
  iterations: 1,
  thresholds: {
    "http_req_failed":           ["rate<0.05"],   // < 5% erros de rede (TLS loopback tolerado)
    "checks":                    ["rate==1.0"],   // todos os checks funcionais passam
    "boundary_valid_latency":    ["p(95)<30000"], // 1 MiB pode levar até ~15s no upstream FPGA
  },
};

const validLatency = new Trend("boundary_valid_latency");
const status200    = new Counter("boundary_status_200");
const status413    = new Counter("boundary_status_413");
const status422    = new Counter("boundary_status_422");

// ── Casos de teste ────────────────────────────────────────────────────────────

const cases = [
  // bytes válidos → 200 (ou 503 se upstream down)
  { bytes: "1",          expect: [200, 503], label: "bytes=1 (mínimo válido)" },
  { bytes: "32",         expect: [200, 503], label: "bytes=32 (default)" },
  { bytes: "1024",       expect: [200, 503], label: "bytes=1024 (1 KiB)" },
  { bytes: "65536",      expect: [200, 503], label: "bytes=65536 (64 KiB)" },
  { bytes: "1048576",    expect: [200, 503], label: "bytes=1048576 (1 MiB, máximo)" },

  // bytes inválidos → 422
  { bytes: "0",          expect: [422],      label: "bytes=0 → 422 INVALID_BYTES" },
  { bytes: "-1",         expect: [422],      label: "bytes=-1 → 422 INVALID_BYTES" },
  { bytes: "abc",        expect: [422],      label: "bytes=abc → 422 INVALID_BYTES" },
  { bytes: "1.5",        expect: [422],      label: "bytes=1.5 → 422 INVALID_BYTES" },
  { bytes: "",           expect: [200, 503], label: "bytes= (vazio, usa default 32)" },

  // bytes acima do limite → 413
  { bytes: "1048577",    expect: [413],      label: "bytes=1048577 → 413 REQUEST_TOO_LARGE" },
  { bytes: "1000000000", expect: [413],      label: "bytes=1B → 413 REQUEST_TOO_LARGE" },

  // formato inválido → 422
  { bytes: "32", format: "base58", expect: [422], label: "format=base58 → 422 INVALID_FORMAT" },
];

export default function () {
  group("Boundary tests — /v1/random", () => {
    for (const tc of cases) {
      let qs = tc.bytes !== "" ? `bytes=${encodeURIComponent(tc.bytes)}` : "";
      if (tc.format) qs += (qs ? "&" : "") + `format=${encodeURIComponent(tc.format)}`;

      const url = `${BASE_URL}/random${qs ? "?" + qs : ""}`;
      const res = http.get(url, { headers, tags: { name: "boundary" } });

      // Registra métricas por status
      if (res.status === 200) { status200.add(1); validLatency.add(res.timings.duration); }
      if (res.status === 413) status413.add(1);
      if (res.status === 422) status422.add(1);

      const ok = tc.expect.includes(res.status);

      check(res, {
        [`[${tc.label}] status esperado (${tc.expect.join("/")})`]: () => ok,
        [`[${tc.label}] body é JSON válido`]: (r) => {
          try { JSON.parse(r.body); return true; } catch { return false; }
        },
        [`[${tc.label}] 200 inclui request_id`]: (r) => {
          if (r.status !== 200) return true; // só verifica se 200
          const body = JSON.parse(r.body);
          return typeof body.request_id === "string" && body.request_id.startsWith("req_");
        },
        [`[${tc.label}] 413 inclui max_bytes_per_request`]: (r) => {
          if (r.status !== 413) return true;
          const body = JSON.parse(r.body);
          return typeof body.max_bytes_per_request === "number";
        },
        [`[${tc.label}] 413/422 inclui error code`]: (r) => {
          if (r.status !== 413 && r.status !== 422) return true;
          const body = JSON.parse(r.body);
          return ["REQUEST_TOO_LARGE", "INVALID_BYTES", "INVALID_FORMAT"].includes(body.error);
        },
      });
    }
  });
}

export function handleSummary(data) {
  const passed  = data.metrics.checks?.values?.passes || 0;
  const failed  = data.metrics.checks?.values?.fails  || 0;
  const s200    = data.metrics.boundary_status_200?.values?.count || 0;
  const s413    = data.metrics.boundary_status_413?.values?.count || 0;
  const s422    = data.metrics.boundary_status_422?.values?.count || 0;

  return {
    stdout: `
╔══════════════════════════════════════════════════════════════╗
║               QRNG Boundary Test — Resultados               ║
╠══════════════════════════════════════════════════════════════╣
║  Checks:  ${String(passed).padStart(4)} passaram   ${String(failed).padStart(4)} falharam      ║
║  200 OK:  ${String(s200).padStart(4)}   413 LARGE: ${String(s413).padStart(4)}   422 INVALID: ${String(s422).padStart(4)} ║
╚══════════════════════════════════════════════════════════════╝
`,
  };
}
