/**
 * qrng-load-test.js
 *
 * Teste de carga com usuários simultâneos.
 * Simula 10 → 50 → 100 → 200 VUs fazendo requisições contínuas.
 *
 * Métricas separadas por categoria de status:
 *   api_ok_rate         — 200 + 429 (API Node saudável)
 *   upstream_down_rate  — 503 (upstream FPGA indisponível, NÃO é falha da API)
 *   server_error_rate   — 500 + 502 (erro real do servidor — investigar)
 *
 * Execução:
 *   k6 run load-tests/qrng-load-test.js \
 *     -e API_TOKEN=dobslit_qrng_live_xxx \
 *     -e BASE_URL=https://bongo.vps-uni5.net/qrng/v1
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
    { duration: "30s",  target: 10  },
    { duration: "60s",  target: 10  },
    { duration: "30s",  target: 50  },
    { duration: "60s",  target: 50  },
    { duration: "30s",  target: 100 },
    { duration: "60s",  target: 100 },
    { duration: "30s",  target: 200 },
    { duration: "60s",  target: 200 },
    { duration: "30s",  target: 0   },
  ],
  thresholds: {
    "http_req_failed":   ["rate<0.01"],   // < 1% erros de rede
    "req_duration_ok":   ["p(95)<3000"],  // p95 < 3s nas respostas OK
    "req_duration_ok":   ["p(99)<8000"],  // p99 < 8s
    "api_ok_rate":       ["rate>0.98"],   // 200 + 429 ≥ 98% das respostas
    "server_error_rate": ["rate<0.005"],  // 500/502 < 0,5%
  },
};

// ── Métricas ──────────────────────────────────────────────────────────────────

const reqDurationOk    = new Trend("req_duration_ok",    true);
const apiOkRate        = new Rate("api_ok_rate");          // 200 + 429
const upstreamDownRate = new Rate("upstream_down_rate");   // 503
const serverErrorRate  = new Rate("server_error_rate");    // 500 + 502

const count200   = new Counter("load_200");
const count429   = new Counter("load_429");
const count503   = new Counter("load_503");
const countError = new Counter("load_server_error");

// ── Cenário ───────────────────────────────────────────────────────────────────

export default function () {
  const sizes = [32, 64, 128, 256, 512, 1024];
  const bytes = sizes[Math.floor(Math.random() * sizes.length)];

  const res = http.get(`${BASE_URL}/random?bytes=${bytes}&format=hex`, {
    headers,
    tags: { name: "load_random" },
  });

  const isApiOk      = res.status === 200 || res.status === 429;
  const isUpstreamDn = res.status === 503;
  const isServerErr  = res.status === 500 || res.status === 502;

  apiOkRate.add(isApiOk);
  upstreamDownRate.add(isUpstreamDn);
  serverErrorRate.add(isServerErr);

  if (res.status === 200) { reqDurationOk.add(res.timings.duration); count200.add(1); }
  else if (res.status === 429) count429.add(1);
  else if (res.status === 503) count503.add(1);
  else if (isServerErr) countError.add(1);

  check(res, {
    "resposta esperada (200/429/503)": () => isApiOk || isUpstreamDn,
    "sem erros 5xx inesperados":       () => !isServerErr,
    "200: tem request_id":             (r) => {
      if (r.status !== 200) return true;
      try { return JSON.parse(r.body).request_id?.startsWith("req_"); } catch { return false; }
    },
    "200: tem campo random":           (r) => {
      if (r.status !== 200) return true;
      try { return typeof JSON.parse(r.body).random === "string"; } catch { return false; }
    },
    "429: tem error code":             (r) => {
      if (r.status !== 429) return true;
      try {
        return ["RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "QUOTA_BYTES_EXCEEDED"]
          .includes(JSON.parse(r.body).error);
      } catch { return false; }
    },
  });

  sleep(0.1 + Math.random() * 0.4);
}

export function handleSummary(data) {
  const s200  = data.metrics.load_200?.values?.count        || 0;
  const s429  = data.metrics.load_429?.values?.count        || 0;
  const s503  = data.metrics.load_503?.values?.count        || 0;
  const sErr  = data.metrics.load_server_error?.values?.count || 0;
  const total = s200 + s429 + s503 + sErr;
  const p95   = data.metrics.req_duration_ok?.values?.["p(95)"]?.toFixed(0) || "—";
  const p99   = data.metrics.req_duration_ok?.values?.["p(99)"]?.toFixed(0) || "—";
  const okPct = total > 0 ? (((s200 + s429) / total) * 100).toFixed(1) : "—";
  const dnPct = total > 0 ? ((s503 / total) * 100).toFixed(1) : "—";
  const errPct= total > 0 ? ((sErr / total) * 100).toFixed(1) : "—";

  return {
    stdout: `
╔════════════════════════════════════════════════════════════════════╗
║                   QRNG Load Test — Resultados                     ║
╠════════════════════════════════════════════════════════════════════╣
║  Total: ${String(total).padEnd(8)}  200=${s200}  429=${s429}  503=${s503}  erro=${sErr}    ║
║  API saudável (200+429): ${okPct}%                                ║
║  Upstream indisponível (503): ${dnPct}%                           ║
║  Erros de servidor (500/502): ${errPct}%                          ║
║  Latência (reqs OK): p95=${p95}ms  p99=${p99}ms                  ║
╠════════════════════════════════════════════════════════════════════╣
║  INTERPRETAÇÃO:                                                    ║
║  • 503 alto = FPGA saturado (não é problema do Node.js)           ║
║  • 429 alto = rate limit/cota funcionando corretamente            ║
║  • 500/502  = investigar imediatamente                             ║
╚════════════════════════════════════════════════════════════════════╝
`,
  };
}
