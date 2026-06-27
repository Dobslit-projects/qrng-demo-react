/**
 * qrng-stress-test.js
 *
 * Teste de stress — identifica o ponto de ruptura da API.
 * Sobe gradualmente de 100 → 300 → 600 → 1000 VUs simultâneos.
 * O objetivo não é passar em todos os thresholds, mas mapear onde a latência
 * começa a degradar e qual é o throughput máximo sustentável.
 *
 * Execução:
 *   k6 run load-tests/qrng-stress-test.js \
 *     -e API_TOKEN=dobslit_qrng_live_xxx \
 *     -e BASE_URL=https://bongo.vps-uni5.net/qrng/v1
 *
 * ATENÇÃO: Este teste pode disparar rate limits e cotas.
 * Use um token com cota alta ou rode em ambiente de staging.
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
    // Aquecimento
    { duration: "30s",  target: 50  },
    { duration: "30s",  target: 100 },

    // Nível 1 — 100 VUs por 2 min
    { duration: "120s", target: 100 },

    // Rampa → Nível 2 — 300 VUs
    { duration: "30s",  target: 300 },
    { duration: "120s", target: 300 },

    // Rampa → Nível 3 — 600 VUs
    { duration: "30s",  target: 600 },
    { duration: "120s", target: 600 },

    // Rampa → Nível 4 — 1000 VUs (pico extremo)
    { duration: "30s",  target: 1000 },
    { duration: "60s",  target: 1000 },

    // Descida gradual
    { duration: "60s",  target: 0   },
  ],

  // Thresholds mais lenientes — stress test é exploratório
  thresholds: {
    "http_req_failed":    ["rate<0.05"],  // < 5% erros de rede
    "stress_p95":         ["p(95)<10000"],
    "expected_responses": ["rate>0.90"],  // 90% das respostas são esperadas
  },
};

const stressP95       = new Trend("stress_p95", true);
const expectedRate    = new Rate("expected_responses");
const count200        = new Counter("stress_200");
const count429        = new Counter("stress_429");
const count503        = new Counter("stress_503");
const countError      = new Counter("stress_error");

// ── Cenário ───────────────────────────────────────────────────────────────────

export default function () {
  // Usa bytes pequenos para maximizar throughput e reduzir carga no upstream
  const res = http.get(`${BASE_URL}/random?bytes=32&format=hex`, {
    headers,
    timeout: "15s",
    tags: { name: "stress_random" },
  });

  const isExpected = [200, 429, 503].includes(res.status);
  expectedRate.add(isExpected);

  check(res, {
    "resposta esperada (200/429/503)": () => isExpected,
    "não houve erro 5xx inesperado":   (r) => r.status !== 500 && r.status !== 502,
    "body é JSON":                     (r) => {
      try { JSON.parse(r.body); return true; } catch { return false; }
    },
  });

  if (res.status === 200) {
    stressP95.add(res.timings.duration);
    count200.add(1);
  } else if (res.status === 429) {
    count429.add(1);
  } else if (res.status === 503) {
    count503.add(1);
  } else {
    countError.add(1);
  }

  // Sleep mínimo — queremos máxima pressão
  sleep(0.05 + Math.random() * 0.1);
}

export function handleSummary(data) {
  const s200   = data.metrics.stress_200?.values?.count   || 0;
  const s429   = data.metrics.stress_429?.values?.count   || 0;
  const s503   = data.metrics.stress_503?.values?.count   || 0;
  const sErr   = data.metrics.stress_error?.values?.count || 0;
  const total  = s200 + s429 + s503 + sErr;
  const p50    = data.metrics.stress_p95?.values?.["p(50)"]?.toFixed(0) || "—";
  const p95    = data.metrics.stress_p95?.values?.["p(95)"]?.toFixed(0) || "—";
  const p99    = data.metrics.stress_p95?.values?.["p(99)"]?.toFixed(0) || "—";
  const rps    = data.metrics.http_reqs?.values?.rate?.toFixed(1) || "—";
  const failed = ((data.metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2);

  return {
    stdout: `
╔═══════════════════════════════════════════════════════════════════════╗
║                   QRNG Stress Test — Resultados                      ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Total requisições: ${String(total).padEnd(10)}                               ║
║  200=${s200}  429=${s429}  503=${s503}  erro=${sErr}                    ║
║  Throughput: ${rps} req/s                                          ║
║  Latência (reqs OK):  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms    ║
║  Falhas de rede: ${failed}%                                        ║
╠═══════════════════════════════════════════════════════════════════════╣
║  INTERPRETAÇÃO:                                                       ║
║  • 429 = rate limit funcionando (esperado)                           ║
║  • 503 = upstream down ou sem entropia (não é falha da API)          ║
║  • p95 < 3000ms = saudável  |  > 8000ms = degradação significativa  ║
║  • Erros de rede > 5% indicam que Node.js atingiu limite de conexões ║
╚═══════════════════════════════════════════════════════════════════════╝
`,
  };
}
