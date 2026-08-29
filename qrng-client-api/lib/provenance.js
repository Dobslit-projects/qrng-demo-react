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
const ENTROPY_STATES = ["not_assessed", "healthy", "degraded", "failed"];

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

  // ── eixo 2: BUFFER (ring buffer / contiguidade do stream) ──────────────────
  const discontHeader = uh["x-qrng-buffer-discontinuous"] === "true";
  const discontCount = uh["x-qrng-discontinuities"] != null ? Number(uh["x-qrng-discontinuities"]) : null;
  let bufferHealth = "unknown";
  if (o.insufficientEntropy) bufferHealth = "degraded";
  else if (discontHeader || (Number.isFinite(discontCount) && discontCount > 0)) bufferHealth = "discontinuous";
  else if (shaVerified === false) bufferHealth = "discontinuous";  // item 9 regra 6
  else if (o.servedFromUpstream) bufferHealth = "healthy";

  // ── eixo 3: ENTROPIA (RCT/APT). NUNCA inferido dos outros dois. ────────────
  let entropyHealth = String(uh["x-qrng-entropy-health"] || "").toLowerCase();
  if (!ENTROPY_STATES.includes(entropyHealth)) entropyHealth = "not_assessed";
  // "not_assessed" é o padrão: os health tests não rodam no caminho live ainda.

  // compat: source_health == transport_health
  const sourceHealth = transportHealth;

  // ── MODELO FORMAL DE PROVENIÊNCIA LIVE (item 8) ───────────────────────────
  // Separação obrigatória: delivery_mode | transport_origin | actual_origin |
  //   physical_capture_verified | live_verified.
  const sourceSessionId = uh["x-qrng-source-session-id"] || null;
  const connectionGeneration = uh["x-qrng-connection-generation"] != null
    ? Number(uh["x-qrng-connection-generation"]) : null;
  const unknownGapBefore = uh["x-qrng-unknown-gap-before"] === "true";
  const ageOk = sampleAgeMs === null || sampleAgeMs <= maxAgeMs;
  const entropyOk = entropyHealth !== "failed";

  let deliveryMode = "none";
  let transportOrigin = "none";
  if (fallbackUsed) { deliveryMode = "fallback"; transportOrigin = "fallback"; }
  else if (NON_LIVE_MODES.includes(mode)) {
    deliveryMode = "replay"; transportOrigin = mode;
  } else if (mode === "live") {
    // recebendo um stream em tempo real do caminho FPGA→TCP — SEM afirmar
    // captura física verificada.
    deliveryMode = o.servedFromUpstream ? "streaming" : (o.upstreamReachable ? "streaming" : "none");
    transportOrigin = (o.servedFromUpstream || o.upstreamReachable) ? "fpga_tcp" : "none";
  }

  // 8.1 — critérios para actual_origin=live (TODOS obrigatórios)
  const c = {
    source_session_id: sourceSessionId !== null,
    monotonic_sequence: captureSeq !== null && o.sequenceMonotonic !== false,
    acquisition_timestamp: capturedAt !== null || receivedAt !== null,
    block_hash_origin_and_consumer: shaVerified === true,
    producer_identity_and_version: sourceInstance !== null && provVersion !== null && envelopeUsable,
    no_replay_or_historical: mode === "live" && !fallbackUsed,
    no_unknown_discontinuity_in_block: !unknownGapBefore,
    source_status_operational: transportHealth === "healthy",
    response_in_current_session:
      o.currentSessionId ? sourceSessionId === o.currentSessionId : sourceSessionId !== null,
    documented_freshness_policy: ageOk && Number.isFinite(maxAgeMs),
  };
  const liveCriteriaMet = Object.values(c).every(Boolean);

  // 8.2 — critérios ADICIONAIS para live_verified=true
  const v = {
    ...c,
    physical_capture_timestamp: capturedAt !== null,
    metadata_bound_to_block: shaVerified === true && captureId !== null,
    anti_replay_mechanism: o.antiReplayVerified === true,
    producer_identity_validated: o.producerIdentityVerified === true,
    hash_matches_body: shaVerified === true,
    timestamp_in_freshness_window: ageOk,
    not_env_var_only: true, // este ramo NUNCA classifica por env var
  };
  const liveVerifiedCriteriaMet = Object.values(v).every(Boolean);

  const physicalCaptureVerified = capturedAt !== null && shaVerified === true
    && o.producerIdentityVerified === true;

  let actualOrigin = "unknown";
  let liveVerified = false;

  if (fallbackUsed) {
    actualOrigin = "fallback";
  } else if (NON_LIVE_MODES.includes(mode)) {
    actualOrigin = reachable ? mode : "unknown";
  } else if (mode === "live") {
    if (liveCriteriaMet && entropyOk && bufferHealth === "healthy" && shaVerified !== false) {
      actualOrigin = "live";
      liveVerified = liveVerifiedCriteriaMet;
    } else if ((o.servedFromUpstream || o.upstreamReachable) && transportHealth === "healthy"
               && ageOk && entropyOk && o.emitLiveUnverified === true) {
      // o contrato aceita explicitamente "live_unverified": stream em tempo real
      // do caminho FPGA, sem verificação de captura física. NÃO por env var.
      actualOrigin = "live_unverified";
    } else {
      // sem evidência suficiente -> unknown + delivery_mode="streaming" comunica
      // "estamos recebendo um stream ao vivo" sem afirmar captura verificada.
      actualOrigin = "unknown";
    }
  }
  void allowNoEvidence;   // DEPRECATED (item 8): a flag NÃO produz "live".

  // regras duras finais (redundantes de propósito)
  if (fallbackUsed) { actualOrigin = "fallback"; liveVerified = false; }
  if (NON_LIVE_MODES.includes(mode) && (actualOrigin === "live" || actualOrigin === "live_unverified")) actualOrigin = mode;
  if (actualOrigin !== "live") liveVerified = false;

  return {
    configured_source: o.configuredSource || "unknown",
    instance_mode: mode,
    actual_origin: actualOrigin,
    // item 8 — modelo formal
    delivery_mode: deliveryMode,               // streaming | replay | fallback | none
    transport_origin: transportOrigin,         // fpga_tcp | replay | fixture | historical | fallback | none
    physical_capture_verified: physicalCaptureVerified,
    live_criteria: c,                          // 8.1 (10 itens)
    live_verified_criteria: v,                 // 8.2
    source_session_id: sourceSessionId,
    connection_generation: Number.isFinite(connectionGeneration) ? connectionGeneration : null,
    unknown_gap_before: unknownGapBefore,
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

module.exports = { resolveProvenance, MODES, NON_LIVE_MODES, ENTROPY_STATES };
