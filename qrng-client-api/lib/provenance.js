"use strict";
// Contrato de proveniência POR RESPOSTA (item 3 da fase de estabilização).
//
// QRNG_PROVENANCE (env) deixa de "carimbar" toda resposta como live. Passa a
// definir só a CAPACIDADE/modo da instância (teto). Cada resposta recebe uma
// origem EFETIVA resolvida a partir do estado real: saúde do upstream, saúde
// do buffer, idade da amostra, uso de fallback.
//
// Regras invioláveis:
//   - actual_origin = "live" só com evidência do caminho live nesta resposta;
//   - fallback_used=true  => actual_origin sempre "fallback" (prevalece sobre a config);
//   - instância replay/fixture/historical NUNCA reporta "live";
//   - amostra antiga (sample_age_ms > maxAgeMs) não continua "live";
//   - fonte indisponível + buffer ainda servindo => estado explícito, não "live";
//   - live_verified só true com captured_at confirmando a captura FÍSICA.
//
// Item 4 (2026-08-29): a fronteira de frescor verificável é `X-QRNG-Received-At`
//   (instante em que o BROKER recebeu os bytes) — NÃO é a detecção física. O
//   `captured_at` fica reservado para um carimbo REAL da FPGA (hoje sempre null,
//   pendente do RTL — ver FPGA_INSPECTION_RESULT.md).
// Item 5 (2026-08-29): saúde separada em TRÊS eixos ortogonais —
//   transport_health (bytes fluindo?), buffer_health (ring buffer / contiguidade),
//   entropy_health (RCT/APT). entropy_health = "not_assessed" por padrão e NUNCA
//   é inferido a partir dos outros dois: transporte OK + buffer OK NÃO implica
//   entropia validada. `source_health` continua como alias de transport_health.

const MODES = ["live", "replay", "fixture", "historical"];
const NON_LIVE_MODES = ["replay", "fixture", "historical"];
// Etapa 89E (Kuapoã doc 139): o broker passa a publicar o estado REAL dos health tests do hardware (RCT/APT no FPGA),
// lido só em leitura do wrapper: hw_health_tests_passing | hw_health_alarm | hw_health_unavailable. "not_assessed"
// continua sendo o padrão (broker antigo, sem sonda). Valores fora desta lista viram "not_assessed" — nada é inventado.
const ENTROPY_STATES = ["not_assessed", "healthy", "degraded", "failed",
                        "hw_health_tests_passing", "hw_health_alarm", "hw_health_unavailable"];
// estados que DERRUBAM o rótulo live (um health test do hardware em alarme)
const ENTROPY_BLOCKING = ["failed", "hw_health_alarm"];

/**
 * @param {object} o
 * @param {string}  o.instanceMode         live | replay | fixture | historical
 * @param {string}  o.configuredSource     ex.: "fpga"
 * @param {string}  o.pollerSourceHealth   healthy | degraded | failed | unknown (poller de fundo)
 * @param {boolean} o.servedFromUpstream   esta resposta entregou bytes do upstream
 * @param {boolean} [o.upstreamReachable]  upstream respondeu (ex.: /health) sem servir bytes
 * @param {boolean} [o.fallbackUsed]       um caminho de fallback forneceu os bytes
 * @param {boolean} [o.insufficientEntropy] buffer sem bytes suficientes
 * @param {object}  [o.upstreamHeaders]    headers do upstream (chaves minúsculas)
 * @param {number}  [o.maxSampleAgeMs]     idade máxima p/ "live" (default 300000)
 * @param {boolean} [o.allowLiveWithoutCaptureEvidence]
 *        default FALSE. Quando FALSE, "live" exige `x-qrng-captured-at` do
 *        upstream — sem ele, `actual_origin` fica "unknown" (a instrução do
 *        item 4: "actual_origin deve ser unknown quando não houver evidência
 *        suficiente"). Quando TRUE, um upstream saudável servindo bytes basta
 *        para "live" (com `live_verified=false`). O `server_api.py` de produção
 *        NÃO emite captured_at hoje -> com o default, produção reporta
 *        `actual_origin="unknown"` em /random até o upstream carimbar a captura.
 * @param {boolean|null} [o.captureSha256Verified]
 *        item 9: resultado de re-hashear o corpo e comparar com
 *        `X-QRNG-Block-SHA256`. `null` = não checado; `false` = DIVERGIU
 *        (integridade quebrada) -> nunca "live"; `true` = confere.
 * @param {number}  [o.now]                Date.now() injetável p/ teste
 * @param {number|null} [o.discontinuitiesBaseline]
 *        2026-10-15: `X-QRNG-Discontinuities` do broker é um contador CUMULATIVO
 *        de realinhamentos desde o boot do broker (não "este bloco tem gap").
 *        Quando o chamador informa o valor visto na resposta ANTERIOR, o bloco
 *        só é "discontinuous" se o contador AVANÇOU desde então; sem baseline,
 *        vale o comportamento antigo (qualquer contador > 0 = discontinuous).
 *
 * Evidência de caminho físico (2026-10-15, Kuapoã doc 139): o broker publica
 * `X-QRNG-Entropy-Health=hw_health_tests_passing` (RCT/APT lidos dos registradores
 * do FPGA) e `X-QRNG-Qualification-Status=verified_active_bitstream` (SHA-256 do
 * bitstream em execução conferido pela sonda da placa). Essa leitura do hardware,
 * combinada ao frescor (`received_at`/stall), passa a valer como evidência de
 * captura física -> actual_origin="live", live_verified=true, live_evidence=
 * "hw_health_probe". `captured_at` (carimbo por bloco do RTL) continua sendo a
 * evidência mais forte quando existir (live_evidence="captured_at").
 */
const KNOWN_ENVELOPE_VERSIONS = ["1"];

function resolveProvenance(o) {
  const now = o.now || Date.now();
  const uh = o.upstreamHeaders || {};
  const mode = MODES.includes(o.instanceMode) ? o.instanceMode : "unknown";
  const fallbackUsed = !!o.fallbackUsed;
  const reachable = !!o.servedFromUpstream || !!o.upstreamReachable;
  const maxAgeMs = Number.isFinite(o.maxSampleAgeMs) ? o.maxSampleAgeMs : 300000;
  const allowNoEvidence = !!o.allowLiveWithoutCaptureEvidence;

  // item 9 — envelope de proveniência versionado
  const provVersion = uh["x-qrng-provenance-version"] || null;
  const envelopeUsable = provVersion === null || KNOWN_ENVELOPE_VERSIONS.includes(provVersion);
  const captureSha256 = uh["x-qrng-block-sha256"] || null;
  const sourceInstance = uh["x-qrng-source-instance"] || null;
  const captureSeq = uh["x-qrng-sequence"] != null ? Number(uh["x-qrng-sequence"]) : null;
  // false = divergência comprovada pelo server.js; null = não checado
  const shaVerified = o.captureSha256Verified === undefined ? null : o.captureSha256Verified;

  // ── eixo 1: TRANSPORTE (bytes fluindo da FPGA ao broker?) ──────────────────
  let transportHealth = ["healthy", "degraded", "failed", "unknown"].includes(o.pollerSourceHealth)
    ? o.pollerSourceHealth : "unknown";
  const hdrStatus = String(uh["x-qrng-source-status"] || "").toLowerCase();
  if (hdrStatus === "offline" || hdrStatus === "failed") transportHealth = "failed";
  else if (hdrStatus === "degraded" && transportHealth === "healthy") transportHealth = "degraded";
  else if ((hdrStatus === "online" || hdrStatus === "healthy") && transportHealth === "unknown") transportHealth = "healthy";

  // ── frescor: X-QRNG-Received-At (broker recebeu) | X-QRNG-Captured-At (FPGA) ──
  // item 4: received_at é a fronteira de frescor verificável HOJE. captured_at
  // (carimbo físico real) é mais forte e fica reservado — hoje null.
  const receivedAt = uh["x-qrng-received-at"] || null;
  const capturedAt = uh["x-qrng-captured-at"] || null;
  const freshnessAt = capturedAt || receivedAt;   // captured_at prevalece se existir
  const captureId = uh["x-qrng-capture-id"] || null;
  let sampleAgeMs = null;
  if (freshnessAt) {
    const t = Date.parse(freshnessAt);
    if (!Number.isNaN(t)) sampleAgeMs = now - t;
  }
  // respostas de STATUS (/health) não trazem received_at por bloco; o broker
  // informa há quantos segundos a fonte parou de empurrar bytes.
  const stallSeconds = uh["x-qrng-source-stall-seconds"] != null ? Number(uh["x-qrng-source-stall-seconds"]) : null;
  const statusFresh = Number.isFinite(stallSeconds) && stallSeconds * 1000 <= maxAgeMs;

  // ── eixo 2: BUFFER (ring buffer / contiguidade do stream) ──────────────────
  const discontHeader = uh["x-qrng-buffer-discontinuous"] === "true";
  const discontCount = uh["x-qrng-discontinuities"] != null ? Number(uh["x-qrng-discontinuities"]) : null;
  const baseline = Number.isFinite(o.discontinuitiesBaseline) ? o.discontinuitiesBaseline : null;
  let bufferHealth = "unknown";
  if (o.insufficientEntropy) bufferHealth = "degraded";
  else if (baseline !== null && Number.isFinite(discontCount)) {
    // contador cumulativo: só é gap NESTE bloco se avançou desde a resposta anterior
    if (discontCount > baseline) bufferHealth = "discontinuous";
    else if (o.servedFromUpstream) bufferHealth = "healthy";
  }
  else if (discontHeader || (Number.isFinite(discontCount) && discontCount > 0)) bufferHealth = "discontinuous";
  else if (shaVerified === false) bufferHealth = "discontinuous";  // item 9 regra 6
  else if (o.servedFromUpstream) bufferHealth = "healthy";

  // ── eixo 3: ENTROPIA (RCT/APT). NUNCA inferido dos outros dois. ────────────
  let entropyHealth = String(uh["x-qrng-entropy-health"] || "").toLowerCase();
  if (!ENTROPY_STATES.includes(entropyHealth)) entropyHealth = "not_assessed";
  // "not_assessed" é o padrão (broker sem sonda do hardware).
  const qualificationStatus = String(uh["x-qrng-qualification-status"] || "").toLowerCase() || null;

  // compat: source_health == transport_health
  const sourceHealth = transportHealth;

  let actualOrigin = "unknown";
  let liveVerified = false;
  let liveEvidence = "none";

  if (fallbackUsed) {
    actualOrigin = "fallback";
  } else if (NON_LIVE_MODES.includes(mode)) {
    actualOrigin = reachable ? mode : "unknown";
  } else if (mode === "live") {
    const ageOk = sampleAgeMs === null || sampleAgeMs <= maxAgeMs;
    // item 9: evidência só conta se o envelope for de versão conhecida (regra 7)
    // e a integridade do bloco não tiver divergido (regra 6).
    // item 4: haveCaptureEvidence exige `captured_at` (carimbo FÍSICO) — o
    //   `received_at` sozinho dá frescor mas NÃO "live_verified".
    // evidência do caminho físico vinda da sonda do hardware (ver cabeçalho):
    // health tests RCT/APT passando no FPGA + bitstream qualificado verificado
    // ativo + amostra/status fresco.
    const hwEvidence = entropyHealth === "hw_health_tests_passing"
      && qualificationStatus === "verified_active_bitstream"
      && ((sampleAgeMs !== null && ageOk) || statusFresh);
    const haveCaptureEvidence = (capturedAt !== null || hwEvidence) && envelopeUsable && shaVerified !== false;
    // item 5: um health test em estado "failed"/"hw_health_alarm" DERRUBA o rótulo
    //   live. "not_assessed"/"healthy"/"degraded" NÃO bloqueiam (live =
    //   proveniência, não é validação de entropia).
    const entropyOk = !ENTROPY_BLOCKING.includes(entropyHealth);
    if (o.servedFromUpstream && transportHealth === "healthy" && bufferHealth === "healthy"
        && ageOk && entropyOk && shaVerified !== false
        && (haveCaptureEvidence || (allowNoEvidence && envelopeUsable))) {
      actualOrigin = "live";
      liveVerified = haveCaptureEvidence;           // só "verificado" com evidência física
      liveEvidence = capturedAt !== null ? "captured_at" : hwEvidence ? "hw_health_probe" : "none";
    } else if (!o.servedFromUpstream && o.upstreamReachable && transportHealth === "healthy"
               && ageOk && entropyOk && (haveCaptureEvidence || allowNoEvidence)) {
      // resposta de STATUS (/health) numa instância live saudável: "live" com a
      // evidência da sonda do hardware, ou quando explicitamente permitido sem ela.
      actualOrigin = "live";
      liveVerified = haveCaptureEvidence;
      liveEvidence = capturedAt !== null ? "captured_at" : hwEvidence ? "hw_health_probe" : "none";
    } else {
      // sem evidência suficiente (broker sem sonda do hardware e sem captured_at)
      actualOrigin = "unknown";
    }
  }

  // regras duras finais (redundantes de propósito)
  if (fallbackUsed) { actualOrigin = "fallback"; liveVerified = false; }
  if (NON_LIVE_MODES.includes(mode) && actualOrigin === "live") actualOrigin = mode;
  if (actualOrigin !== "live") liveVerified = false;
  if (!liveVerified) liveEvidence = "none";

  return {
    configured_source: o.configuredSource || "unknown",
    instance_mode: mode,
    actual_origin: actualOrigin,
    // item 5 — saúde em três eixos ortogonais
    transport_health: transportHealth,
    buffer_health: bufferHealth,
    entropy_health: entropyHealth,          // "not_assessed" até RCT/APT rodarem
    source_health: sourceHealth,            // DEPRECATED: alias de transport_health
    // item 4 — frescor
    received_at: receivedAt,                // instante em que o BROKER recebeu
    captured_at: capturedAt,                // carimbo FÍSICO da FPGA (hoje null)
    served_at: new Date(now).toISOString(),
    sample_age_ms: sampleAgeMs,             // idade por captured_at||received_at
    capture_id: captureId,
    fallback_used: fallbackUsed,
    live_verified: liveVerified,
    live_evidence: liveEvidence,            // captured_at | hw_health_probe | none
    qualification_status: qualificationStatus,
    // item 9 — envelope de proveniência
    provenance_version: provVersion,
    envelope_usable: envelopeUsable,
    source_instance: sourceInstance,
    sequence: Number.isFinite(captureSeq) ? captureSeq : null,
    discontinuities: Number.isFinite(discontCount) ? discontCount : null,
    capture_sha256: captureSha256,
    capture_sha256_verified: shaVerified,
  };
}

module.exports = { resolveProvenance, MODES, NON_LIVE_MODES, ENTROPY_STATES, ENTROPY_BLOCKING };
