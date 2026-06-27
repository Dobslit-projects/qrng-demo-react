/**
 * qrng-throughput-test.js
 *
 * Mede bytes/s entregues pela API em diferentes tamanhos de payload e formatos.
 * Cada cenário roda isolado com número de VUs adequado ao tamanho do payload.
 *
 * Matriz de teste:
 *   32 B   hex    200 VUs — baseline de latência / RPS máximo
 *   1 KiB  hex    200 VUs — impacto de payload maior no throughput
 *   64 KiB base64 100 VUs — throughput médio
 *   1 MiB  base64  10 VUs — saturação do upstream
 *   1 MiB  hex     10 VUs — comparação hex vs base64 (hex ≈ 2× maior)
 *
 * NOTA SOBRE TAMANHO DE RESPOSTA:
 *   MAX_BYTES_PER_REQUEST limita bytes de *entropia* (não o payload HTTP final).
 *   - format=hex:    resposta ≈ 2× os bytes solicitados (1 byte → 2 chars)
 *   - format=base64: resposta ≈ 1,33× os bytes solicitados
 *   - format=uint8:  resposta ≈ 3-4 bytes por byte (array JSON de inteiros)
 *   Para 1 MiB hex: payload JSON ≈ 2,1 MiB
 *   Para 1 MiB base64: payload JSON ≈ 1,4 MiB
 *
 * Execução:
 *   k6 run load-tests/qrng-throughput-test.js \
 *     -e API_TOKEN=dobslit_qrng_live_xxx \
 *     -e BASE_URL=https://bongo.vps-uni5.net/qrng/v1
 *
 * Duração total: ~12 minutos.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Configuração ──────────────────────────────────────────────────────────────

const BASE_URL  = __ENV.BASE_URL  || "https://bongo.vps-uni5.net/qrng/v1";
const API_TOKEN = __ENV.API_TOKEN || "SEU_TOKEN_AQUI";

const headers = { Authorization: `Bearer ${API_TOKEN}` };

// ── Cenários k6 (execução sequencial via startTime) ───────────────────────────

const SCENARIO_DURATION = "90s"; // duração de cada cenário

export const options = {
  scenarios: {
    "32b_hex_200vus": {
      executor:  "constant-vus",
      vus:       200,
      duration:  SCENARIO_DURATION,
      startTime: "0s",
      env:       { BYTES: "32", FORMAT: "hex", LABEL: "32B_hex" },
      tags:      { scenario: "32b_hex" },
    },
    "1kb_hex_200vus": {
      executor:  "constant-vus",
      vus:       200,
      duration:  SCENARIO_DURATION,
      startTime: "100s",
      env:       { BYTES: "1024", FORMAT: "hex", LABEL: "1KiB_hex" },
      tags:      { scenario: "1kb_hex" },
    },
    "64kb_base64_100vus": {
      executor:  "constant-vus",
      vus:       100,
      duration:  SCENARIO_DURATION,
      startTime: "200s",
      env:       { BYTES: "65536", FORMAT: "base64", LABEL: "64KiB_base64" },
      tags:      { scenario: "64kb_b64" },
    },
    "1mib_base64_10vus": {
      executor:  "constant-vus",
      vus:       10,
      duration:  SCENARIO_DURATION,
      startTime: "300s",
      env:       { BYTES: "1048576", FORMAT: "base64", LABEL: "1MiB_base64" },
      tags:      { scenario: "1mib_b64" },
    },
    "1mib_hex_10vus": {
      executor:  "constant-vus",
      vus:       10,
      duration:  SCENARIO_DURATION,
      startTime: "400s",
      env:       { BYTES: "1048576", FORMAT: "hex", LABEL: "1MiB_hex" },
      tags:      { scenario: "1mib_hex" },
    },
  },
  thresholds: {
    "http_req_failed":           ["rate<0.05"],
    "throughput_ok{scenario:32b_hex}":   ["avg>0"],
    "throughput_ok{scenario:1mib_hex}":  ["avg>0"],
  },
};

// ── Métricas por cenário ──────────────────────────────────────────────────────

// bytes_per_second estimado: (bytes_solicitados / duration_ms) * 1000
const throughputOk  = new Trend("throughput_ok",  true); // bytes/s (entropia)
const latencyOk     = new Trend("latency_ok",     true); // ms
const apiOkRate     = new Rate("throughput_api_ok");
const count200      = new Counter("tp_200");
const count503      = new Counter("tp_503");
const countErr      = new Counter("tp_error");

// ── Cenário ───────────────────────────────────────────────────────────────────

export default function () {
  const bytes  = parseInt(__ENV.BYTES  || "32",  10);
  const format = __ENV.FORMAT || "hex";
  const label  = __ENV.LABEL  || "unknown";

  const res = http.get(`${BASE_URL}/random?bytes=${bytes}&format=${format}`, {
    headers,
    tags:    { scenario: label },
    timeout: "60s",
  });

  const isOk = res.status === 200;
  apiOkRate.add(isOk || res.status === 429);

  if (isOk) {
    // Throughput em bytes de entropia por segundo
    const bps = res.timings.duration > 0
      ? Math.round((bytes / res.timings.duration) * 1000)
      : 0;
    throughputOk.add(bps,           { scenario: label });
    latencyOk.add(res.timings.duration, { scenario: label });
    count200.add(1);
  } else if (res.status === 503) {
    count503.add(1);
  } else {
    countErr.add(1);
  }

  check(res, {
    [`[${label}] status 200 ou 503`]: () => res.status === 200 || res.status === 503 || res.status === 429,
    [`[${label}] sem erro 5xx real`]:  () => res.status !== 500 && res.status !== 502,
    [`[${label}] request_id presente`]:(r) => {
      if (r.status !== 200) return true;
      try { return JSON.parse(r.body).request_id?.startsWith("req_"); } catch { return false; }
    },
  });

  // Payload maior → sleep maior para não esgotar upstream
  const sleepMs = bytes >= 1048576 ? 500 : bytes >= 65536 ? 200 : 50;
  sleep(sleepMs / 1000 + Math.random() * 0.1);
}

export function handleSummary(data) {
  const s200  = data.metrics.tp_200?.values?.count    || 0;
  const s503  = data.metrics.tp_503?.values?.count    || 0;
  const sErr  = data.metrics.tp_error?.values?.count  || 0;
  const total = s200 + s503 + sErr;

  // Para acessar por label precisaríamos de tags; aqui mostramos global
  const avgBps  = data.metrics.throughput_ok?.values?.avg?.toFixed(0) || "—";
  const p50Bps  = data.metrics.throughput_ok?.values?.["p(50)"]?.toFixed(0) || "—";
  const p95Bps  = data.metrics.throughput_ok?.values?.["p(95)"]?.toFixed(0) || "—";
  const p50ms   = data.metrics.latency_ok?.values?.["p(50)"]?.toFixed(0) || "—";
  const p95ms   = data.metrics.latency_ok?.values?.["p(95)"]?.toFixed(0) || "—";
  const rps     = data.metrics.http_reqs?.values?.rate?.toFixed(2) || "—";

  return {
    stdout: `
╔══════════════════════════════════════════════════════════════════════════╗
║                  QRNG Throughput Test — Resultados                      ║
╠══════════════════════════════════════════════════════════════════════════╣
║  Total requisições: ${String(total).padEnd(8)}  200=${s200}  503=${s503}  erro=${sErr}   ║
║  Throughput (reqs OK): ${rps} req/s                                  ║
╠══════════════════════════════════════════════════════════════════════════╣
║  Bytes de entropia/s:                                                   ║
║    avg=${avgBps} B/s   p50=${p50Bps} B/s   p95=${p95Bps} B/s           ║
║  Latência:                                                               ║
║    p50=${p50ms}ms   p95=${p95ms}ms                                      ║
╠══════════════════════════════════════════════════════════════════════════╣
║  NOTAS SOBRE TAMANHO DE RESPOSTA:                                        ║
║  MAX_BYTES_PER_REQUEST limita bytes de *entropia* (não payload HTTP).   ║
║  Tamanho real do corpo da resposta:                                      ║
║    hex    → ~2× os bytes solicitados (1 byte = 2 chars)                 ║
║    base64 → ~1,33× os bytes solicitados                                 ║
║    uint8  → ~3-4× os bytes solicitados (array JSON de inteiros)         ║
║  Para 1 MiB hex: payload JSON ≈ 2,1 MiB                                ║
╚══════════════════════════════════════════════════════════════════════════╝
`,
  };
}
