"use strict";
// Cliente interno do Bongo (lib/bongo-internal.js): cache da introspecção por
// no máximo a TTL, falhas nunca em cache, nada concedido por cache vencido,
// reauth nunca em cache, timeout, token de serviço errado/ausente → falha fechada.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createFakeBongo } = require("../test-support/fake-bongo");
const { createBongoInternalClient, IdentityUnavailableError, MailEnqueueError } = require("../lib/bongo-internal");

const SERVICE_TOKEN = "test-internal-service-token-unit";
const bongo = createFakeBongo({ serviceToken: SERVICE_TOKEN });
let url;

before(async () => { url = await bongo.listen(); });
after(() => bongo.close());
beforeEach(() => bongo.reset());

function client(over = {}) {
  return createBongoInternalClient({ baseUrl: url, serviceToken: SERVICE_TOKEN, timeoutMs: 300, cacheMs: 0, ...over });
}

// Relógio manual: os testes de TTL não dependem do tempo de parede nem da
// latência da ida e volta HTTP (sob carga, uma introspecção podia passar da
// TTL e vencer a entrada antes da 2ª chamada — teste instável).
function manualClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test("cache: dentro da TTL não consulta o Bongo de novo; depois da TTL consulta", async () => {
  const now = manualClock();
  const c = client({ cacheMs: 200, now });
  const tok = bongo.addSession({ id: "u-cache", email: "c@test.com" });
  const n0 = bongo.state.calls.introspect;
  assert.equal((await c.introspect(tok)).active, true);
  now.advance(199);
  assert.equal((await c.introspect(tok)).active, true);
  assert.equal(bongo.state.calls.introspect - n0, 1);
  now.advance(1); // exatamente a TTL: já vencida
  await c.introspect(tok);
  assert.equal(bongo.state.calls.introspect - n0, 2);
});

test("revogação aparece assim que a TTL vence (nunca depois)", async () => {
  const now = manualClock();
  const c = client({ cacheMs: 150, now });
  const tok = bongo.addSession({ id: "u-rev", email: "r@test.com" });
  assert.equal((await c.introspect(tok)).active, true);
  bongo.revoke(tok);
  now.advance(149);
  assert.equal((await c.introspect(tok)).active, true, "dentro da TTL o resultado em cache ainda vale");
  now.advance(1);
  assert.equal((await c.introspect(tok)).active, false);
});

test("sem relógio injetado, o padrão é Date.now (o cache real continua valendo)", async () => {
  const c = client({ cacheMs: 60000 });
  const tok = bongo.addSession({ id: "u-default-clock", email: "dc@test.com" });
  const n0 = bongo.state.calls.introspect;
  await c.introspect(tok);
  await c.introspect(tok);
  assert.equal(bongo.state.calls.introspect - n0, 1);
});

test("cache vencido + Bongo fora → IdentityUnavailableError (nada concedido pelo cache velho)", async () => {
  const now = manualClock();
  const c = client({ cacheMs: 100, now });
  const tok = bongo.addSession({ id: "u-stale", email: "s@test.com" });
  assert.equal((await c.introspect(tok)).active, true);
  now.advance(100);
  bongo.state.mode = "down";
  await assert.rejects(c.introspect(tok), (e) => e instanceof IdentityUnavailableError && e.code === "unreachable");
});

test("falhas nunca entram no cache", async () => {
  const c = client({ cacheMs: 60000 });
  const tok = bongo.addSession({ id: "u-fail", email: "f@test.com" });
  bongo.state.mode = "error500";
  await assert.rejects(c.introspect(tok), (e) => e instanceof IdentityUnavailableError && e.code === "http_500");
  bongo.state.mode = "malformed";
  await assert.rejects(c.introspect(tok), (e) => e.code === "malformed");
  bongo.state.mode = "ok";
  assert.equal((await c.introspect(tok)).active, true);
});

test("reauth nunca usa nem alimenta o cache (é de uso único)", async () => {
  const c = client({ cacheMs: 60000 });
  const tok = bongo.addSession({ id: "u-reauth", email: "ra@test.com" });
  const ra = bongo.addReauth("u-reauth");
  const n0 = bongo.state.calls.introspect;
  const first = await c.introspect(tok, { reauthToken: ra, reauthPurpose: "link_qrng_developer" });
  assert.deepEqual(first.reauth, { verified: true, purpose: "link_qrng_developer" });
  const second = await c.introspect(tok, { reauthToken: ra, reauthPurpose: "link_qrng_developer" });
  assert.equal(second.reauth.verified, false, "o Bongo consome o reauth; o cliente não pode reaproveitar a 1ª resposta");
  assert.equal(bongo.state.calls.introspect - n0, 2);
  const plain = await c.introspect(tok);
  assert.equal(plain.reauth, undefined, "a resposta com reauth não pode ter ido para o cache");
});

test("timeout → IdentityUnavailableError('timeout') dentro do prazo", async () => {
  const c = client({ timeoutMs: 150 });
  const tok = bongo.addSession({ id: "u-slow", email: "sl@test.com" });
  bongo.state.mode = "slow";
  const t0 = Date.now();
  await assert.rejects(c.introspect(tok), (e) => e instanceof IdentityUnavailableError && e.code === "timeout");
  assert.ok(Date.now() - t0 < 1000);
});

test("sem INTERNAL_SERVICE_TOKEN → falha fechada sem nem chamar o Bongo; token errado → Bongo 404 → falha fechada", async () => {
  const n0 = bongo.state.calls.introspect + bongo.state.calls.unauthorized;
  const none = createBongoInternalClient({ baseUrl: url, serviceToken: null, timeoutMs: 300, cacheMs: 0 });
  await assert.rejects(none.introspect("qualquer"), (e) => e.code === "not_configured");
  assert.equal(bongo.state.calls.introspect + bongo.state.calls.unauthorized, n0);
  const wrong = createBongoInternalClient({ baseUrl: url, serviceToken: "errado", timeoutMs: 300, cacheMs: 0 });
  await assert.rejects(wrong.introspect("qualquer"), (e) => e instanceof IdentityUnavailableError && e.code === "http_404");
  await assert.rejects(wrong.enqueueMail({ template: "x" }), (e) => e instanceof MailEnqueueError && e.code === "http_404");
});

test("enqueueMail: 202 → {id}; Bongo fora/500 → MailEnqueueError", async () => {
  const c = client();
  const r = await c.enqueueMail({ template: "qrng_legacy_password_changed", to: "m@test.com", locale: "pt", secret: null,
    secretExpiresAt: null, idempotencyKey: "k-1", validity: { kind: "none", ref: null } });
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(bongo.state.mails.at(-1).idempotencyKey, "k-1");
  bongo.state.mailMode = "down";
  await assert.rejects(c.enqueueMail({ template: "x" }), (e) => e instanceof MailEnqueueError && e.code === "unreachable");
  bongo.state.mailMode = "error500";
  await assert.rejects(c.enqueueMail({ template: "x" }), (e) => e instanceof MailEnqueueError && e.code === "http_500");
});

test("cancelMail: 200 → {cancelled}; corpo {validity:{kind, refs}}; Bongo 500/sem token → MailEnqueueError", async () => {
  const c = client();
  const before = bongo.state.cancels.length;
  const r = await c.cancelMail({ kind: "qrng_legacy_password_reset", refs: ["7", "8"] });
  assert.deepEqual(r, { cancelled: 2 });
  assert.deepEqual(bongo.state.cancels.slice(before), [{ kind: "qrng_legacy_password_reset", refs: ["7", "8"] }]);
  bongo.state.mailMode = "error500";
  await assert.rejects(c.cancelMail({ kind: "qrng_legacy_password_reset", refs: ["9"] }), (e) => e instanceof MailEnqueueError && e.code === "http_500");
  const none = client({ serviceToken: null });
  await assert.rejects(none.cancelMail({ kind: "qrng_legacy_password_reset", refs: ["9"] }), (e) => e instanceof MailEnqueueError && e.code === "not_configured");
});
