"use strict";
// Item 3: contrato de proveniência POR RESPOSTA. Testa a função pura
// lib/provenance.resolveProvenance nos 9 cenários exigidos.
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

test("1. live saudável: actual_origin=live, live_verified=true (com captured_at)", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-capture-id": "cap_1", "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, true);
  assert.equal(p.source_health, "healthy");
  assert.equal(p.buffer_health, "healthy");
  assert.equal(p.fallback_used, false);
  assert.equal(p.capture_id, "cap_1");
});

test("2. fonte offline (poller failed, sem bytes): actual_origin=unknown, nunca live", () => {
  const p = resolveProvenance({
    ...base,
    pollerSourceHealth: "failed",
    servedFromUpstream: false,
  });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_verified, false);
  assert.equal(p.source_health, "failed");
});

test("3. buffer ainda contém dados antigos: source failed mas serviu bytes -> estado explícito, não live", () => {
  const p = resolveProvenance({
    ...base,
    pollerSourceHealth: "failed",
    servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-source-status": "offline", "x-qrng-captured-at": fresh },
  });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.source_health, "failed");
  assert.equal(p.buffer_health, "healthy"); // ainda serviu, mas...
  assert.equal(p.live_verified, false);
});

test("4. buffer esgotado (insufficient entropy): buffer_health=degraded, actual_origin=unknown", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: false,
    insufficientEntropy: true,
    upstreamHeaders: { "x-qrng-source-status": "online" },
  });
  assert.equal(p.buffer_health, "degraded");
  assert.equal(p.actual_origin, "unknown");
});

test("5. fallback: fallback_used=true -> actual_origin=fallback, live_verified=false", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true, fallbackUsed: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh } });
  assert.equal(p.actual_origin, "fallback");
  assert.equal(p.fallback_used, true);
  assert.equal(p.live_verified, false);
});

test("6. replay: instância replay nunca reporta live, mesmo com upstream saudável", () => {
  const p = resolveProvenance({
    ...base,
    instanceMode: "replay",
    servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "replay");
  assert.equal(p.live_verified, false);
});

test("7. origem desconhecida: modo live, upstream não alcançado, sem fallback", () => {
  const p = resolveProvenance({ ...base, pollerSourceHealth: "unknown", servedFromUpstream: false });
  assert.equal(p.actual_origin, "unknown");
});

test("8. conflito config x origem efetiva: instância 'live' mas amostra velha -> não live", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": old, "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "unknown", "amostra de 6h não pode ser 'live' com maxAge 5min");
  assert.ok(p.sample_age_ms > 300000);
});

test("9. proibição de live quando fallback_used=true (mesmo com todas as evidências live)", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: true,
    fallbackUsed: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-capture-id": "cap_9", "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "fallback");
  assert.notEqual(p.actual_origin, "live");
  assert.equal(p.live_verified, false);
});

test("item 4: DEFAULT — 'live' EXIGE captured_at. Sem evidência -> actual_origin=unknown", () => {
  // upstream saudável servindo bytes, mas SEM X-QRNG-Captured-At (é o caso do
  // server_api.py de produção hoje).
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-source-status": "online", "x-qrng-capture-id": "cap_x" },
  });
  assert.equal(p.actual_origin, "unknown", "sem captured_at não há evidência suficiente p/ 'live'");
  assert.equal(p.live_verified, false);
  assert.equal(p.source_health, "healthy");
  assert.equal(p.buffer_health, "healthy");
});

test("item 4: com LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE -> upstream saudável basta p/ 'live' (live_verified=false)", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: true,
    allowLiveWithoutCaptureEvidence: true,
    upstreamHeaders: { "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, false);           // sem captured_at -> não verificado
});

test("item 4: /health de instância live saudável (sem bytes) -> unknown por default; 'live' só com allow", () => {
  const strict = resolveProvenance({ ...base, servedFromUpstream: false, upstreamReachable: true,
    upstreamHeaders: { "x-qrng-source-status": "online" } });
  assert.equal(strict.actual_origin, "unknown");
  const lax = resolveProvenance({ ...base, servedFromUpstream: false, upstreamReachable: true,
    allowLiveWithoutCaptureEvidence: true, upstreamHeaders: { "x-qrng-source-status": "online" } });
  assert.equal(lax.actual_origin, "live");
  assert.equal(lax.live_verified, false);
});

test("item 4: served_at NUNCA é usado como captured_at", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-source-status": "online" } });  // sem captured_at
  assert.equal(p.captured_at, null);
  assert.ok(p.served_at, "served_at é preenchido");
  assert.notEqual(p.served_at, p.captured_at);
  assert.equal(p.sample_age_ms, null, "sem captured_at não há idade de amostra");
});

test("bônus: buffer discontinuous propagado do header do upstream", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-buffer-discontinuous": "true", "x-qrng-captured-at": fresh, "x-qrng-source-status": "online" },
  });
  assert.equal(p.buffer_health, "discontinuous");
  assert.equal(p.actual_origin, "unknown", "buffer descontínuo não é 'live'");
});

test("header e JSON concordam: actual_origin é a única fonte de verdade", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-source-status": "online" } });
  // o server usa p.actual_origin tanto no header X-QRNG-Provenance quanto no
  // campo JSON provenance -> não há divergência possível.
  assert.equal(typeof p.actual_origin, "string");
  assert.ok(["live", "fallback", "replay", "fixture", "historical", "unknown"].includes(p.actual_origin));
});

// ── item 9 — envelope de proveniência versionado + SHA-256 de bloco ──────────
const env1 = {
  "x-qrng-provenance-version": "1",
  "x-qrng-source-instance": "dobslit-qrng-ufpe-fpga",
  "x-qrng-captured-at": fresh,
  "x-qrng-capture-id": "cap_4096_deadbeefcafe",
  "x-qrng-sequence": "4096",
  "x-qrng-block-sha256": "a".repeat(64),
  "x-qrng-source-status": "online",
};

test("item 9: envelope v1 + captured_at fresco + sha verificado -> live/live_verified + campos expostos", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, upstreamHeaders: env1, captureSha256Verified: true,
  });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, true);
  assert.equal(p.provenance_version, "1");
  assert.equal(p.envelope_usable, true);
  assert.equal(p.source_instance, "dobslit-qrng-ufpe-fpga");
  assert.equal(p.sequence, 4096);
  assert.equal(p.capture_sha256, "a".repeat(64));
  assert.equal(p.capture_sha256_verified, true);
});

test("item 9 regra 6: X-QRNG-Block-SHA256 DIVERGIU (server.js) -> nunca live, buffer discontinuous", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, upstreamHeaders: env1, captureSha256Verified: false,
  });
  assert.notEqual(p.actual_origin, "live");
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_verified, false);
  assert.equal(p.buffer_health, "discontinuous");
  assert.equal(p.capture_sha256_verified, false);
});

test("item 9 regra 7: envelope de versão DESCONHECIDA -> evidência ignorada, degrada p/ unknown", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, captureSha256Verified: true,
    upstreamHeaders: { ...env1, "x-qrng-provenance-version": "9" },
  });
  assert.equal(p.envelope_usable, false);
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_verified, false);
});

test("item 9: envelope v1 mas instância REPLAY -> actual_origin=replay, NUNCA live (modo é teto)", () => {
  const p = resolveProvenance({
    instanceMode: "replay", configuredSource: "fpga", pollerSourceHealth: "healthy",
    maxSampleAgeMs: 300000, now: NOW,
    servedFromUpstream: true, captureSha256Verified: true, upstreamHeaders: env1,
  });
  assert.equal(p.actual_origin, "replay");
  assert.equal(p.live_verified, false);
});

test("item 9: envelope v1 mas instância HISTORICAL + fallback -> fallback, nunca live", () => {
  const p = resolveProvenance({
    instanceMode: "historical", configuredSource: "fpga", pollerSourceHealth: "healthy",
    now: NOW, servedFromUpstream: true, fallbackUsed: true,
    captureSha256Verified: true, upstreamHeaders: env1,
  });
  assert.equal(p.actual_origin, "fallback");
  assert.equal(p.live_verified, false);
});

test("item 9: envelope v1 + captured_at STALE -> unknown (idade derruba live mesmo com sha ok)", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, captureSha256Verified: true,
    upstreamHeaders: { ...env1, "x-qrng-captured-at": old },
  });
  assert.equal(p.actual_origin, "unknown");
  assert.equal(p.live_verified, false);
  assert.ok(p.sample_age_ms > 300000);
});

test("item 9: sem checagem de sha (null) + captured_at fresco -> live_verified=true, capture_sha256_verified=null", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true, upstreamHeaders: env1 });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, true);
  assert.equal(p.capture_sha256_verified, null);
});

test("item 9: ausência de envelope (server_api.py de produção hoje) -> provenance_version=null, unknown", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true, upstreamHeaders: {} });
  assert.equal(p.provenance_version, null);
  assert.equal(p.envelope_usable, true); // null = legado tolerado, mas sem captured_at...
  assert.equal(p.actual_origin, "unknown"); // ...continua unknown por falta de captured_at
});

// ── item 4 — X-QRNG-Received-At (frescor do broker) vs X-QRNG-Captured-At (físico)
test("item 4: Received-At fresco + allow -> live mas live_verified=false (não é carimbo físico)", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, allowLiveWithoutCaptureEvidence: true,
    upstreamHeaders: { "x-qrng-provenance-version": "1", "x-qrng-received-at": fresh, "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, false, "received_at NÃO é live_verified");
  assert.equal(p.received_at, fresh);
  assert.equal(p.captured_at, null);
  assert.ok(p.sample_age_ms >= 0 && p.sample_age_ms < 5000);
});

test("item 4: Received-At STALE -> unknown por idade (mesmo com allow)", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true, allowLiveWithoutCaptureEvidence: true,
    upstreamHeaders: { "x-qrng-provenance-version": "1", "x-qrng-received-at": old, "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "unknown");
  assert.ok(p.sample_age_ms > 300000);
});

test("item 4: captured_at (físico) prevalece sobre received_at para live_verified", () => {
  const p = resolveProvenance({
    ...base, servedFromUpstream: true,
    upstreamHeaders: {
      "x-qrng-provenance-version": "1",
      "x-qrng-received-at": old,          // broker recebeu há 6h...
      "x-qrng-captured-at": fresh,        // ...mas a FPGA carimbou agora (hipotético)
      "x-qrng-source-status": "online",
    },
  });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, true, "captured_at presente -> verificado");
  assert.ok(p.sample_age_ms < 5000, "idade vem do captured_at, não do received_at");
});

// ── item 5 — saúde em três eixos ortogonais
test("item 5: entropy_health = not_assessed por padrão (RCT/APT não rodam)", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-source-status": "online" } });
  assert.equal(p.entropy_health, "not_assessed");
  assert.equal(p.transport_health, "healthy");
  assert.equal(p.buffer_health, "healthy");
  assert.equal(p.source_health, p.transport_health, "source_health = alias de transport_health");
  assert.equal(p.actual_origin, "live", "not_assessed NÃO bloqueia live (live = proveniência)");
});

test("item 5: transporte OK + buffer OK NUNCA implicam entropy_health healthy", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-source-status": "online" } });
  assert.notEqual(p.entropy_health, "healthy");
});

test("item 5: X-QRNG-Entropy-Health=failed DERRUBA live", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: {
      "x-qrng-provenance-version": "1", "x-qrng-captured-at": fresh,
      "x-qrng-source-status": "online", "x-qrng-entropy-health": "failed",
    } });
  assert.equal(p.entropy_health, "failed");
  assert.notEqual(p.actual_origin, "live");
  assert.equal(p.actual_origin, "unknown");
});

test("item 5: X-QRNG-Entropy-Health=degraded NÃO derruba live (só failed derruba)", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: {
      "x-qrng-provenance-version": "1", "x-qrng-captured-at": fresh,
      "x-qrng-source-status": "online", "x-qrng-entropy-health": "degraded",
    } });
  assert.equal(p.entropy_health, "degraded");
  assert.equal(p.actual_origin, "live");
});

test("item 5: os três eixos são independentes — transporte degraded, buffer discontinuous, entropy failed", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: {
      "x-qrng-source-status": "degraded",
      "x-qrng-buffer-discontinuous": "true",
      "x-qrng-entropy-health": "failed",
      "x-qrng-discontinuities": "3",
      "x-qrng-captured-at": fresh,
    } });
  assert.equal(p.transport_health, "degraded");
  assert.equal(p.buffer_health, "discontinuous");
  assert.equal(p.entropy_health, "failed");
  assert.equal(p.discontinuities, 3);
  assert.notEqual(p.actual_origin, "live");
});

test("item 5: X-QRNG-Discontinuities > 0 -> buffer_health discontinuous", () => {
  const p = resolveProvenance({ ...base, servedFromUpstream: true,
    upstreamHeaders: { "x-qrng-captured-at": fresh, "x-qrng-source-status": "online", "x-qrng-discontinuities": "1" } });
  assert.equal(p.buffer_health, "discontinuous");
  assert.notEqual(p.actual_origin, "live");
});
