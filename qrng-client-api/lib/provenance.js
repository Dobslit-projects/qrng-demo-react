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
//   - buffer antigo (sample_age_ms > maxAgeMs) não continua "live";
//   - fonte indisponível + buffer ainda servindo => estado explícito, não "live";
//   - live_verified só true com captured_at confirmando a captura.

const MODES = ["live", "replay", "fixture", "historical"];
const NON_LIVE_MODES = ["replay", "fixture", "historical"];

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

  let sourceHealth = ["healthy", "degraded", "failed", "unknown"].includes(o.pollerSourceHealth)
    ? o.pollerSourceHealth : "unknown";
  const hdrStatus = String(uh["x-qrng-source-status"] || "").toLowerCase();
  if (hdrStatus === "offline" || hdrStatus === "failed") sourceHealth = "failed";
  else if (hdrStatus === "degraded" && sourceHealth === "healthy") sourceHealth = "degraded";
  else if ((hdrStatus === "online" || hdrStatus === "healthy") && sourceHealth === "unknown") sourceHealth = "healthy";

  const capturedAt = uh["x-qrng-captured-at"] || null;
  const captureId = uh["x-qrng-capture-id"] || null;
  let sampleAgeMs = null;
  if (capturedAt) {
    const t = Date.parse(capturedAt);
    if (!Number.isNaN(t)) sampleAgeMs = now - t;
  }

  let bufferHealth = "unknown";
  if (o.insufficientEntropy) bufferHealth = "degraded";
  else if (uh["x-qrng-buffer-discontinuous"] === "true") bufferHealth = "discontinuous";
  else if (shaVerified === false) bufferHealth = "discontinuous";  // item 9 regra 6
  else if (o.servedFromUpstream) bufferHealth = "healthy";

  let actualOrigin = "unknown";
  let liveVerified = false;

  if (fallbackUsed) {
    actualOrigin = "fallback";
  } else if (NON_LIVE_MODES.includes(mode)) {
    actualOrigin = reachable ? mode : "unknown";
  } else if (mode === "live") {
    const ageOk = sampleAgeMs === null || sampleAgeMs <= maxAgeMs;
    // item 9: evidência só conta se o envelope for de versão conhecida (regra 7)
    // e a integridade do bloco não tiver divergido (regra 6).
    const haveCaptureEvidence = capturedAt !== null && envelopeUsable && shaVerified !== false;
    if (o.servedFromUpstream && sourceHealth === "healthy" && bufferHealth === "healthy" && ageOk
        && shaVerified !== false
        && (haveCaptureEvidence || (allowNoEvidence && envelopeUsable))) {
      actualOrigin = "live";
      liveVerified = haveCaptureEvidence;           // só "verificado" com captured_at
    } else if (!o.servedFromUpstream && o.upstreamReachable && sourceHealth === "healthy" && ageOk
               && allowNoEvidence) {
      // resposta de STATUS (/health) numa instância live saudável — só conta
      // como "live" quando explicitamente permitido sem evidência de captura.
      actualOrigin = "live";
      liveVerified = false;
    } else {
      // sem evidência suficiente (ex.: server_api.py não carimba captured_at)
      actualOrigin = "unknown";
    }
  }

  // regras duras finais (redundantes de propósito)
  if (fallbackUsed) { actualOrigin = "fallback"; liveVerified = false; }
  if (NON_LIVE_MODES.includes(mode) && actualOrigin === "live") actualOrigin = mode;
  if (actualOrigin !== "live") liveVerified = false;

  return {
    configured_source: o.configuredSource || "unknown",
    instance_mode: mode,
    actual_origin: actualOrigin,
    source_health: sourceHealth,
    buffer_health: bufferHealth,
    captured_at: capturedAt,
    served_at: new Date(now).toISOString(),
    sample_age_ms: sampleAgeMs,
    capture_id: captureId,
    fallback_used: fallbackUsed,
    live_verified: liveVerified,
    // item 9 — envelope de proveniência
    provenance_version: provVersion,
    envelope_usable: envelopeUsable,
    source_instance: sourceInstance,
    sequence: Number.isFinite(captureSeq) ? captureSeq : null,
    capture_sha256: captureSha256,
    capture_sha256_verified: shaVerified,
  };
}

module.exports = { resolveProvenance, MODES, NON_LIVE_MODES };
