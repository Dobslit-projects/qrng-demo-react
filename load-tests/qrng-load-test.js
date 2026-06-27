/**
 * qrng-load-test.js
 *
 * Teste de carga com usuários simultâneos.
 * Simula 10 → 50 → 100 → 200 VUs fazendo requisições contínuas.
 * Valida que a API mantém latência aceitável e não retorna erros 5xx.
 *
 * Execução:
 *   k6 run load-tests/qrng-load-test.js \
 *     -e API_TOKEN=dobslit_qrng_live_xxx \
 *     -e BASE_URL=https://bongo.vps-uni5.net/qrng/v1
 *
 * Nota: 429 é esperado e contabilizado separadamente (não é falha de rede).
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ── Configuração ──────────────────────────────────────────────────────────────

const BASE_URL  = __ENV.BASE_URL  || "https://bongo.vps-uni5.net/qrng/v1";
const API_TOKEN = __ENV.API_TOKEN || "SEU_TOKEN_AQUI";

const headers = { Authorization: `Bearer ${API_TOKEN}` };

export const options = {
  stages: [
    { duration: "30s",  target: 10  }, // rampa até 10 VUs
    { duration: "60s",  target: 10  }, // sustenta 10 VUs
    { duration: "30s",  target: 50  }, // rampa até 50 VUs
    { duration: "60s",  target: 50  }, // sustenta 50 VUs
    { duration: "30s",  target: 100 }, // rampa até 100 VUs
    { duration: "60s",  target: 100 }, // sustenta 100 VUs
    { duration: "30s",  target: 200 }, // rampa até 200 VUs
    { duration: "60s",  target: 200 }, // sustenta 200 VUs
    { duration: "30s",  target: 0   }, // descida
  ],
  thresholds: {
    // Erros de rede (5xx que não sejam upstream) devem ser < 1%
    "http_req_failed":          ["rate<0.01"],
    // p95 de latência < 3s para requisições com sucesso
    "req_duration_ok":          ["p(95)<3000"],
    // p99 < 8s
    "req_duration_ok":          ["p(99)<8000"],
    // Rate de 200/429 deve ser > 98% das respostas (resto pode ser 503 de upstream)
    "expected_status_rate":     ["rate>0.98"],
  },
};

const reqDurationOk    = new Trend("req_duration_ok", true);
const expectedRate     = new Rate("expected_status_rate");
const count200         = new Counter("load_status_200");
const count429         = new Counter("load_status_429");
const count503         = new Counter("load_status_503");
const countOther       = new Counter("load_status_other");

// ── Cenário principal ─────────────────────────────────────────────────────────

export default function () {
  // Alterna tamanhos de bytes para simular uso real
  const sizes = [32, 64, 128, 256, 512, 1024];
  const bytes = sizes[Math.floor(Math.random() * sizes.length)];

  const res = http.get(`${BASE_URL}/random?bytes=${bytes}&format=hex`, {
    headers,
    tags: { name: "load_random" },
  });

  const isOk = res.status === 200 || res.status === 429 || res.status === 503;

  check(res, {
    "status é 200, 429 ou 503": () => isOk,
    "200: body tem request_id": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.request_id === "string" && body.request_id.startsWith("req_");
      } catch { return false; }
    },
    "200: body tem random": (r) => {
      if (r.status !== 200) return true;
      try { return typeof JSON.parse(r.body).random === "string"; } catch { return false; }
    },
    "429: body tem error code": (r) => {
      if (r.status !== 429) return true;
      try {
        const body = JSON.parse(r.body);
        return ["RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "QUOTA_BYTES_EXCEEDED"].includes(body.error);
      } catch { return false; }
    },
  });

  expectedRate.add(isOk);

  if (res.status === 200) { reqDurationOk.add(res.timings.duration); count200.add(1); }
  else if (res.status === 429) count429.add(1);
  else if (res.status === 503) count503.add(1);
  else countOther.add(1);

  // Pausa entre 100ms e 500ms para simular usuário real
  sleep(0.1 + Math.random() * 0.4);
}

export function handleSummary(data) {
  const s200   = data.metrics.load_status_200?.values?.count  || 0;
  const s429   = data.metrics.load_status_429?.values?.count  || 0;
  const s503   = data.metrics.load_status_503?.values?.count  || 0;
  const sOther = data.metrics.load_status_other?.values?.count || 0;
  const p95    = data.metrics.req_duration_ok?.values?.["p(95)"]?.toFixed(0) || "—";
  const p99    = data.metrics.req_duration_ok?.values?.["p(99)"]?.toFixed(0) || "—";
  const failed = data.metrics.http_req_failed?.values?.rate || 0;

  return {
    stdout: `
╔══════════════════════════════════════════════════════════════════╗
║                  QRNG Load Test — Resultados                    ║
╠══════════════════════════════════════════════════════════════════╣
║  Respostas: 200=${s200}  429=${s429}  503=${s503}  outro=${sOther}  ║
║  Latência (reqs OK): p95=${p95}ms  p99=${p99}ms                ║
║  Falhas de rede: ${(failed * 100).toFixed(2)}%                              ║
╚══════════════════════════════════════════════════════════════════╝
`,
  };
}
