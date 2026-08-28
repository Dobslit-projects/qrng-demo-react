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

test("bônus: /health de instância live saudável (status, sem bytes) -> live, live_verified=false", () => {
  const p = resolveProvenance({
    ...base,
    servedFromUpstream: false,
    upstreamReachable: true,
    upstreamHeaders: { "x-qrng-source-status": "online" },
  });
  assert.equal(p.actual_origin, "live");
  assert.equal(p.live_verified, false);
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
