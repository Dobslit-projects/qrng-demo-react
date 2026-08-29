"use strict";
// Contrato de proveniência POR RESPOSTA — lib/provenance.resolveProvenance.
// Itens 3/4/5/8/9: modelo formal (delivery_mode | transport_origin |
// actual_origin | physical_capture_verified | live_verified), 3 eixos de saúde,
// envelope v1, e os critérios 8.1/8.2 para live / live_verified.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveProvenance } = require("../lib/provenance");

const NOW = Date.parse("2026-08-27T12:00:00Z");
const fresh = new Date(NOW - 1000).toISOString();
const old = new Date(NOW - 6 * 3600 * 1000).toISOString();

const base = {
  instanceMode: "live",
  configuredSource: "fpga",
  pollerSourceHealth: "healthy",
  maxSampleAgeMs: 300000,
  now: NOW,
};

// TODOS os sinais 8.1 presentes no envelope do upstream:
const fullLiveHeaders = {
  "x-qrng-provenance-version": "1",
  "x-qrng-source-instance": "dobslit-qrng-ufpe-fpga",
  "x-qrng-source-session-id": "sess_abc123",
  "x-qrng-connection-generation": "7",
  "x-qrng-sequence": "4096",
  "x-qrng-block-sha256": "a".repeat(64),
  "x-qrng-capture-id": "cap_4096_deadbeefcafe",
  "x-qrng-received-at": fresh,
  "x-qrng-source-status": "online",
  "x-qrng-unknown-gap-before": "false",
};
// opções do caller que completam 8.1 (sessão atual) e 8.2 (identidade/anti-replay):
const callerLiveOpts = {
  servedFromUpstream: true,
  captureSha256Verified: true,
  currentSessionId: "sess_abc123",
  producerIdentityVerified: true,
  antiReplayVerified: true,
};

// ── 8.1 — actual_origin=live só com os 10 critérios ──────────────────────────
test("8.1: envelope COMPLETO + sha verificado + sessão atual + identidade -> actual_origin=live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.delivery_mode, "streaming");
  assert.equal(p.transport_origin, "fpga_tcp");
  assert.equal(Object.values(p.live_criteria).every(Boolean), true, "todos os 10 critérios 8.1");
  assert.equal(p.source_session_id, "sess_abc123");
  assert.equal(p.connection_generation, 7);
});

test("8.1: falta source_session_id -> NÃO é live (unknown + delivery_mode=streaming)", () => {
  const h = { ...fullLiveHeaders }; delete h["x-qrng-source-session-id"];
  const p = resolveProvenance({ ...base, ...callerLiveOpts, currentSessionId: null, upstreamHeaders: h });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.delivery_mode, "streaming");
  assert.equal(p.transport_origin, "fpga_tcp");
  assert.equal(p.live_criteria.source_session_id, false);
});

test("8.1: sha do bloco NÃO verificado (null) -> NÃO é live (critério 4 falha)", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, captureSha256Verified: null, upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_criteria.block_hash_origin_and_consumer, false);
});

test("8.1: sha DIVERGIU -> NÃO é live, buffer discontinuous", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, captureSha256Verified: false, upstreamHeaders: fullLiveHeaders });
  assert.notEqual(p.actual_origin, "live");
  assert.equal(p.buffer_health, "discontinuous");
});

test("8.1: unknown gap DENTRO do bloco -> NÃO é live (critério 7 falha)", () => {
  const h = { ...fullLiveHeaders, "x-qrng-unknown-gap-before": "true" };
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: h });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_criteria.no_unknown_discontinuity_in_block, false);
  assert.equal(p.unknown_gap_before, true);
});

test("8.1: resposta de sessão ANTIGA (session_id != currentSessionId) -> NÃO é live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, currentSessionId: "sess_NEW", upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_criteria.response_in_current_session, false);
});

test("8.1: amostra STALE (fora da janela de frescor) -> NÃO é live", () => {
  const h = { ...fullLiveHeaders, "x-qrng-received-at": old };
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: h });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_criteria.documented_freshness_policy, false);
  assert.ok(p.sample_age_ms > 300000);
});

// ── 8.2 — live_verified=true exige critérios adicionais ──────────────────────
test("8.2: com carimbo FÍSICO (captured_at) + identidade + anti-replay -> live_verified=true", () => {
  const h = { ...fullLiveHeaders, "x-qrng-captured-at": fresh };
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: h });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, true);
  assert.equal(p.physical_capture_verified, true);
  assert.equal(Object.values(p.live_verified_criteria).every(Boolean), true);
});

test("8.2: SEM carimbo físico (só received_at) -> live mas live_verified=FALSE", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, false, "received_at dá frescor, não prova captura física");
  assert.equal(p.physical_capture_verified, false);
  assert.equal(p.live_verified_criteria.physical_capture_timestamp, false);
});

test("8.2: sem anti-replay verificado -> live mas NÃO live_verified", () => {
  const h = { ...fullLiveHeaders, "x-qrng-captured-at": fresh };
  const p = resolveProvenance({ ...base, ...callerLiveOpts, antiReplayVerified: false, upstreamHeaders: h });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, false);
  assert.equal(p.live_verified_criteria.anti_replay_mechanism, false);
});

test("8: live_verified NUNCA por variável de ambiente — a flag legada é inerte", () => {
  // upstream saudável servindo bytes, SEM os sinais 8.1, com a flag legada ligada
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, allowLiveWithoutCaptureEvidence: true,
    upstreamHeaders: { "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "unknown");        // a flag NÃO produz live
  assert.equal(p.live_verified, false);
  assert.equal(p.delivery_mode, "streaming");
});

test("8: live_unverified só quando o contrato opta explicitamente (emitLiveUnverified)", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, emitLiveUnverified: true,
    upstreamHeaders: { "x-qrng-source-status": "online", "x-qrng-received-at": fresh },
  });
  assert.equal(p.actual_origin, "live_unverified");
  assert.equal(p.live_verified, false);
  assert.equal(p.delivery_mode, "streaming");
  assert.equal(p.transport_origin, "fpga_tcp");
});

// ── cenários base preservados ────────────────────────────────────────────────
test("fonte offline (poller failed, sem bytes): actual_origin=unknown, delivery_mode=none", () => {
  const p = resolveProvenance({ ...base, pollerSourceHealth: "failed", servedFromUpstream: false });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.delivery_mode, "none");
  assert.equal(p.transport_origin, "none");
  assert.equal(p.source_health, "failed");
});

test("buffer esgotado (insufficient entropy): buffer_health=degraded, actual_origin=unknown", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: false, insufficientEntropy: true,
    upstreamHeaders: { "x-qrng-source-status": "online" } });
  assert.equal(p.buffer_health, "degraded");
  assert.equal(p.actual_origin, "unknown");
});

test("fallback: fallback_used=true -> actual_origin=fallback, delivery_mode=fallback, live_verified=false", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, fallbackUsed: true, upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "fallback");
  assert.equal(p.delivery_mode, "fallback");
  assert.equal(p.live_verified, false);
});

test("replay: instância replay NUNCA reporta live, mesmo com envelope completo", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, instanceMode: "replay", upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "replay");
  assert.equal(p.delivery_mode, "replay");
  assert.equal(p.transport_origin, "replay");
  assert.equal(p.live_verified, false);
});

test("historical + fallback -> fallback, nunca live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, instanceMode: "historical", fallbackUsed: true, upstreamHeaders: fullLiveHeaders });
  assert.equal(p.actual_origin, "fallback");
});

test("served_at NUNCA é usado como captured_at; sem carimbo -> sample_age via received_at", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-source-status": "online", "x-qrng-received-at": fresh } });
  assert.equal(p.captured_at, null);
  assert.ok(p.served_at);
  assert.notEqual(p.served_at, p.captured_at);
  assert.ok(p.sample_age_ms >= 0 && p.sample_age_ms < 5000);
});

test("header e JSON concordam: actual_origin ∈ conjunto conhecido", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: fullLiveHeaders });
  assert.ok(["live", "live_unverified", "fallback", "replay", "fixture", "historical", "unknown"].includes(p.actual_origin));
});

// ── item 9 — envelope versionado + SHA-256 de bloco ─────────────────────────
test("item 9 regra 7: envelope de versão DESCONHECIDA -> evidência ignorada -> unknown", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts,
    upstreamHeaders: { ...fullLiveHeaders, "x-qrng-provenance-version": "9" } });
  assert.equal(p.envelope_usable, false);
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_criteria.producer_identity_and_version, false);
});

test("item 9: ausência de envelope (server_api.py de produção hoje) -> provenance_version=null, unknown", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true, upstreamHeaders: {} });
  assert.equal(p.provenance_version, null);
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.delivery_mode, "streaming");
});

// ── item 5 — três eixos de saúde ortogonais ─────────────────────────────────
test("item 5: entropy_health = not_assessed por padrão; NÃO bloqueia live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: fullLiveHeaders });
  assert.equal(p.entropy_health, "not_assessed");
  assert.equal(p.transport_health, "healthy");
  assert.equal(p.buffer_health, "healthy");
  assert.equal(p.source_health, p.transport_health);
  assert.equal(p.actual_origin, "live", "not_assessed NÃO bloqueia (live = proveniência)");
});

test("item 5: transporte OK + buffer OK NUNCA implicam entropy_health healthy", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts, upstreamHeaders: fullLiveHeaders });
  assert.notEqual(p.entropy_health, "healthy");
});

test("item 5: X-QRNG-Entropy-Health=failed DERRUBA live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts,
    upstreamHeaders: { ...fullLiveHeaders, "x-qrng-entropy-health": "failed" } });
  assert.equal(p.entropy_health, "failed");
  assert.notEqual(p.actual_origin, "live");
});

test("item 5: X-QRNG-Entropy-Health=degraded NÃO derruba live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts,
    upstreamHeaders: { ...fullLiveHeaders, "x-qrng-entropy-health": "degraded" } });
  assert.equal(p.entropy_health, "degraded");
  assert.equal(p.actual_origin, "live");
});

test("item 5: eixos independentes — transporte degraded + buffer discontinuous + entropy failed", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: {
      "x-qrng-source-status": "degraded", "x-qrng-buffer-discontinuous": "true",
      "x-qrng-entropy-health": "failed", "x-qrng-discontinuities": "3", "x-qrng-received-at": fresh,
    } });
  assert.equal(p.transport_health, "degraded");
  assert.equal(p.buffer_health, "discontinuous");
  assert.equal(p.entropy_health, "failed");
  assert.equal(p.discontinuities, 3);
  assert.notEqual(p.actual_origin, "live");
});

test("item 5: X-QRNG-Discontinuities > 0 -> buffer_health discontinuous -> não live", () => {
  const p = resolveProvenance({ ...base, ...callerLiveOpts,
    upstreamHeaders: { ...fullLiveHeaders, "x-qrng-discontinuities": "1" } });
  assert.equal(p.buffer_health, "discontinuous");
  assert.notEqual(p.actual_origin, "live");
});
