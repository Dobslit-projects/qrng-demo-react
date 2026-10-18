"use strict";
// Camada de compatibilidade com o contrato QRNG Open API (Palo Alto Networks e parceiros).
// Implementação PRÓPRIA do contrato: nenhum código ou arquivo do repositório de referência (AGPL-3.0) foi copiado.
// Revisão do contrato implementada: CONTRACT.revision. Ambiguidades e interpretações: docs/qrng-open-api.md.
//
// Este módulo é PURO (sem Express, sem rede, sem banco): valida o pedido, divide os bytes em blocos e monta as
// respostas a partir de dados que o server.js já obteve. Ele nunca gera, completa ou repete bytes.

const CONTRACT = Object.freeze({
  name: "QRNG Open API",
  repository: "https://github.com/PaloAltoNetworks/QRNG-OPENAPI",
  revision: "812e2055dd89362d81ace049ec92df4425f8e699",
  revision_date: "2025-01-22",
  implementation_doc: "docs/qrng-open-api.md",
});

/** Objeto de extensão (interpretação A6): { name, version, data }. */
function ext(name, data) {
  return { name, version: 1, data };
}

/** Inteiro positivo seguro vindo de JSON: nada de strings, booleanos, nulos ou frações (interpretação A10). */
function isPositiveSafeInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * Limites efetivos a partir da configuração em execução. max_block_size nunca passa do limite total
 * (uma resposta de um bloco só não pode furar o limite por requisição).
 */
function resolveLimits({ maxTotalBytes, maxBlockSize, maxBlockCount, entropyTypes }) {
  for (const [k, v] of Object.entries({ maxTotalBytes, maxBlockSize, maxBlockCount })) {
    if (!isPositiveSafeInt(v)) throw new Error(`QRNG Open API: limite inválido ${k}=${v}`);
  }
  if (!Array.isArray(entropyTypes) || entropyTypes.length === 0 || !entropyTypes.every((t) => /^[a-z0-9_.-]{1,64}$/.test(t))) {
    throw new Error("QRNG Open API: entropy_types inválido");
  }
  return Object.freeze({
    minBlockSize: 1,
    maxBlockSize: Math.min(maxBlockSize, maxTotalBytes),
    minBlockCount: 1,
    maxBlockCount,
    maxTotalBytes,
    entropyTypes: Object.freeze([...entropyTypes]),
  });
}

/**
 * Valida o corpo de POST /v1/entropy ANTES de qualquer consumo de entropia.
 * @returns {{ok:true, blockSize:number, blockCount:number, entropyType:string, totalBytes:number}
 *          |{ok:false, error:string, message:string, field?:string}}
 */
function parseEntropyRequest(body, limits) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "INVALID_REQUEST_BODY", message: "O corpo deve ser um objeto JSON, ex.: {\"block_size\": 32}." };
  }
  // block_size: obrigatório
  if (!Object.prototype.hasOwnProperty.call(body, "block_size")) {
    return { ok: false, error: "MISSING_BLOCK_SIZE", field: "block_size", message: "block_size é obrigatório (inteiro, em bytes)." };
  }
  const blockSize = body.block_size;
  if (!isPositiveSafeInt(blockSize)) {
    return { ok: false, error: "INVALID_BLOCK_SIZE", field: "block_size", message: "block_size deve ser um número inteiro positivo (sem aspas)." };
  }
  if (blockSize < limits.minBlockSize || blockSize > limits.maxBlockSize) {
    return { ok: false, error: "BLOCK_SIZE_OUT_OF_RANGE", field: "block_size",
             message: `block_size deve estar entre ${limits.minBlockSize} e ${limits.maxBlockSize} bytes.` };
  }
  // block_count: opcional, padrão 1
  let blockCount = 1;
  if (Object.prototype.hasOwnProperty.call(body, "block_count")) {
    blockCount = body.block_count;
    if (!isPositiveSafeInt(blockCount)) {
      return { ok: false, error: "INVALID_BLOCK_COUNT", field: "block_count", message: "block_count deve ser um número inteiro positivo (sem aspas)." };
    }
    if (blockCount < limits.minBlockCount || blockCount > limits.maxBlockCount) {
      return { ok: false, error: "BLOCK_COUNT_OUT_OF_RANGE", field: "block_count",
               message: `block_count deve estar entre ${limits.minBlockCount} e ${limits.maxBlockCount}.` };
    }
  }
  // entropy_type: opcional, padrão = 1º tipo anunciado
  let entropyType = limits.entropyTypes[0];
  if (Object.prototype.hasOwnProperty.call(body, "entropy_type")) {
    if (typeof body.entropy_type !== "string" || !limits.entropyTypes.includes(body.entropy_type)) {
      return { ok: false, error: "UNSUPPORTED_ENTROPY_TYPE", field: "entropy_type",
               message: `entropy_type não disponível. Tipos aceitos: ${limits.entropyTypes.join(", ")}.` };
    }
    entropyType = body.entropy_type;
  }
  // total: comparação por divisão, sem multiplicar antes (os dois fatores já são limitados; isto é defesa extra
  // contra overflow e alocação excessiva caso os limites sejam reconfigurados)
  if (blockCount > Math.floor(limits.maxTotalBytes / blockSize)) {
    return { ok: false, error: "TOTAL_TOO_LARGE", field: "block_count",
             message: `block_size × block_count não pode passar de ${limits.maxTotalBytes} bytes por requisição.` };
  }
  return { ok: true, blockSize, blockCount, entropyType, totalBytes: blockSize * blockCount };
}

/**
 * Divide exatamente blockSize*blockCount bytes em blocos Base64. Recusa (lança) qualquer outro tamanho: o chamador
 * só chega aqui com o buffer exato, e um erro aqui é um defeito, nunca motivo para completar ou cortar dados.
 */
function splitBlocksBase64(buf, blockSize, blockCount) {
  if (!Buffer.isBuffer(buf) || buf.length !== blockSize * blockCount) {
    throw new Error("QRNG Open API: buffer com tamanho diferente de block_size × block_count");
  }
  const out = new Array(blockCount);
  for (let i = 0; i < blockCount; i++) out[i] = buf.subarray(i * blockSize, (i + 1) * blockSize).toString("base64");
  return out;
}

const HW_STATE_TO_RESULT = Object.freeze({
  hw_health_tests_passing: "passing",
  hw_health_alarm: "alarm",
  hw_health_unavailable: "unavailable",
  not_assessed: "not_assessed",
});
const SAFE_LABEL = /^[a-z_]{1,64}$/;
const TEST_TYPES = Object.freeze({
  hw: "kuapoa_hw_continuous_rct_apt",
  liveness: "kuapoa_source_liveness",
  qualification: "kuapoa_bitstream_qualification",
});

function isoFromEpochSeconds(s) {
  return (typeof s === "number" && Number.isFinite(s) && s > 0) ? new Date(s * 1000).toISOString() : null;
}

/** Rótulo seguro vindo do broker (allowlist de formato); qualquer outro valor vira "unknown". */
function safeLabel(v) {
  return (typeof v === "string" && SAFE_LABEL.test(v)) ? v : "unknown";
}

/**
 * Lê o JSON do /health do broker e separa as quatro categorias pedidas (serviço, prontidão da fonte, testes
 * contínuos observados, avaliação histórica). Nada é inferido: campo ausente vira null / "unknown" / "not_assessed".
 */
function interpretBrokerHealth(h, readAtIso) {
  const b = (h && typeof h === "object") ? h : {};
  const detail = (b.entropy_health_detail && typeof b.entropy_health_detail === "object") ? b.entropy_health_detail : null;
  const hwRaw = typeof b.entropy_health === "string" ? b.entropy_health : null;
  const observedAt = detail ? isoFromEpochSeconds(detail.probed_at_epoch) : null;
  const qualStatus = typeof b.qualification_status === "string" ? safeLabel(b.qualification_status) : "unknown";
  const verified = qualStatus === "verified_active_bitstream";
  const q = (verified && b.qualification && typeof b.qualification === "object") ? b.qualification : null;
  const sourceStatus = typeof b.source_status === "string" ? safeLabel(b.source_status) : "unknown";
  return {
    readAt: readAtIso,
    sourceStatus,
    sourceStallSeconds: typeof b.source_stall_seconds === "number" ? b.source_stall_seconds : null,
    hw: {
      raw: hwRaw === null ? null : safeLabel(hwRaw),
      result: hwRaw === null ? "not_assessed" : (HW_STATE_TO_RESULT[hwRaw] || "unknown"),
      observedAt,
      ageSeconds: detail && typeof detail.age_s === "number" ? detail.age_s : null,
      reason: detail && typeof detail.reason === "string" ? detail.reason : null,
      wrapperState: detail && typeof detail.wrapper_state === "string" ? detail.wrapper_state : null,
      failFlags: detail && Array.isArray(detail.fail_flags) ? detail.fail_flags.filter((f) => typeof f === "string") : null,
      healthTestFlags: detail && Array.isArray(detail.health_test_flags) ? detail.health_test_flags.filter((f) => typeof f === "string") : null,
      measuredBy: detail && typeof detail.source === "string" ? detail.source : null,
    },
    qualification: {
      status: qualStatus,
      conditioned: verified && b.conditioned === true,
      bitstreamSha256: q && typeof q.bitstream_sha256 === "string" && /^[0-9a-f]{64}$/.test(q.bitstream_sha256) ? q.bitstream_sha256 : null,
      healthProfile: q && q.health_profile_detail && typeof q.health_profile_detail === "object" ? q.health_profile_detail : null,
      record: q,
    },
  };
}

// Campos do arquivo de qualificação repassados como AVALIAÇÃO HISTÓRICA (offline). Allowlist: nada é recalculado.
const HISTORICAL_FIELDS = ["status", "bitstream_sha256", "fpga_commit", "conditioner", "health_tests", "health_profile",
  "health_profile_detail", "H_submitter", "H_original_formal", "H_original_formal_repeat", "H_I_pre_restart",
  "h_out_pre_restart", "h_out_pre_restart_bits_per_128", "restart_validated", "restart_status",
  "sp80090b_full_validation", "cryptographic_source_ready", "limitations", "evidence", "assessed_at"];

/** GET /v1/healthtest. */
function buildHealthtest(info, { reportLink }) {
  const hwTime = info.hw.observedAt || info.readAt;
  const test_result = [
    { test_type: TEST_TYPES.hw, test_result: info.hw.result, time_stamp: hwTime, report_link: reportLink },
    { test_type: TEST_TYPES.liveness, test_result: info.sourceStatus, time_stamp: info.readAt },
    { test_type: TEST_TYPES.qualification, test_result: info.qualification.status, time_stamp: info.readAt },
  ];
  const extensions = [
    ext("kuapoa.health_summary", {
      read_at: info.readAt,
      service: { api: "available", broker_reachable: true },
      source_readiness: {
        source_status: info.sourceStatus,
        source_stall_seconds: info.sourceStallSeconds,
        delivery_refused_when: "fonte parada (sem dados novos há mais de 60 s, visto pelo monitor de 60 s) ou broker indisponível",
      },
      continuous_tests: {
        test_type: TEST_TYPES.hw,
        state: info.hw.raw,
        result: info.hw.result,
        observed_at: info.hw.observedAt,
        time_stamp_source: info.hw.observedAt ? "hardware_probe_observation" : "status_read_no_observation",
        observation_age_seconds: info.hw.ageSeconds,
        reason: info.hw.reason,
        wrapper_state: info.hw.wrapperState,
        fail_flags: info.hw.failFlags,
        health_test_flags: info.hw.healthTestFlags,
        measured_by: info.hw.measuredBy,
        validity: "decidida pelo broker: observação vencida é publicada como unavailable (reason=stale_probe), nunca como passing",
        scope: "RCT e APT executados no FPGA sobre cada amostra bruta. Não é validação SP 800-90B nem certificação.",
      },
      qualification: {
        status: info.qualification.status,
        conditioned: info.qualification.conditioned,
        bitstream_sha256: info.qualification.bitstreamSha256,
      },
      test_result_values: {
        [TEST_TYPES.hw]: ["passing", "alarm", "unavailable", "not_assessed", "unknown"],
        [TEST_TYPES.liveness]: ["online", "degraded", "offline", "unknown"],
        [TEST_TYPES.qualification]: ["verified_active_bitstream", "inactive_other_bitstream", "unverified_stale_probe",
          "unverified_no_probe", "none", "unknown", "..."],
      },
    }),
  ];
  if (info.qualification.record) {
    const r = info.qualification.record;
    const data = { kind: "historical_offline_assessment", not_real_time_health: true,
                   note: "Resultados de avaliação offline do bitstream ativo. Não descrevem a saúde atual da fonte." };
    for (const k of HISTORICAL_FIELDS) if (r[k] !== undefined) data[k] = r[k];
    if (data.assessed_at === undefined) data.assessed_at = null;
    extensions.push(ext("kuapoa.historical_assessment", data));
  }
  return { test_result, extensions };
}

/** GET /v1/capabilities. */
function buildCapabilities(limits, info, { reportLink, quotas }) {
  const testTime = info.hw.observedAt || info.readAt;
  const healthExt = { test_type_semantics: "ver GET /v1/healthtest, extensão kuapoa.health_summary" };
  if (info.qualification.healthProfile) healthExt.hw_health_profile = info.qualification.healthProfile;
  return {
    entropy: {
      min_block_size: limits.minBlockSize,
      max_block_size: limits.maxBlockSize,
      min_block_count: limits.minBlockCount,
      max_block_count: limits.maxBlockCount,
      entropy_types: [...limits.entropyTypes],
      extensions: [
        ext("kuapoa.limits", {
          max_total_bytes: limits.maxTotalBytes,
          rule: "block_size × block_count ≤ max_total_bytes",
          combinations_above_total_allowed: false,
          daily_quota_requests: quotas.dailyRequests,
          daily_quota_bytes: quotas.dailyBytes,
          rate_limit_per_token_per_minute: quotas.perTokenPerMinute,
          quotas_shared_with: ["/v1/random", "/v1/raw"],
          note: "Limites e cotas são os mesmos da API atual e valem para o token, qualquer que seja a interface.",
        }),
        ext("kuapoa.entropy_types", {
          [limits.entropyTypes[0]]: {
            description: "Saída do extrator do Kuapoã (fonte física via broker). O estado de condicionamento e qualificação "
              + "de cada resposta vai na extensão kuapoa.response e nos cabeçalhos X-QRNG-*.",
            source_count: 1,
          },
        }),
        ext("kuapoa.contract", { ...CONTRACT }),
      ],
    },
    healthtest: {
      test_threshold: [
        { test_type: TEST_TYPES.hw, time_stamp: testTime, report_link: reportLink },
        { test_type: TEST_TYPES.liveness, time_stamp: info.readAt, report_link: reportLink },
        { test_type: TEST_TYPES.qualification, time_stamp: info.readAt, report_link: reportLink },
      ],
      source_count: 1,
      extensions: [ext("kuapoa.healthtest", healthExt)],
    },
  };
}

module.exports = {
  CONTRACT, TEST_TYPES, ext, isPositiveSafeInt, resolveLimits, parseEntropyRequest, splitBlocksBase64,
  interpretBrokerHealth, buildHealthtest, buildCapabilities,
};
