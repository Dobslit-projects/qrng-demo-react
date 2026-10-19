"use strict";
// Recuperação de senha das contas LEGADAS da client-api (doc 155, 2.5 + 3):
// resposta genérica, token de uso único (só o hash no banco), invalidação por
// pedido novo, consumo atômico, revogação dos JWTs antigos, e-mail pela fila do
// Bongo (falso), endpoint interno de validade, auditoria e ausência de segredos.
const { test, before, after, beforeEach, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { createFakeBongo, captureConsole, dumpDatabase } = require("../test-support/fake-bongo");

const SERVICE_TOKEN = "test-internal-service-token-reset";
const JWT_SECRET = "test-jwt-secret-for-ci";
const testDbPath = path.join(os.tmpdir(), `qrng-reset-${Date.now()}.db`);
const bongo = createFakeBongo({ serviceToken: SERVICE_TOKEN });
const consoleLines = captureConsole();
const secrets = new Set([SERVICE_TOKEN]);
let app, db, waitForBackgroundJobs, resetIdentityRateLimits;

before(async () => {
  const url = await bongo.listen();
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.BONGO_INTERNAL_URL = url;
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.PORTAL_INTROSPECTION_CACHE_MS = "0";
  process.env.PORTAL_INTROSPECTION_TIMEOUT_MS = "300";
  process.env.AUDIT_PSEUDONYM_KEY = "test-audit-pseudonym-key";
  process.env.RATE_LIMIT_PER_IP_PER_MINUTE = "100000";
  process.env.QRNG_PASSWORD_RESET_URL = "https://portal.test/redefinir-senha-api";
  process.env.QRNG_UPSTREAM = "http://127.0.0.1:9";
  ({ app, db, waitForBackgroundJobs, resetIdentityRateLimits } = require("../server"));
});
after(async () => {
  try { db.close(); } catch (_) {}
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(testDbPath + s); } catch (_) {} }
  await bongo.close();
});
beforeEach(async () => { bongo.reset(); await resetIdentityRateLimits(); });

let seq = 0;
async function legacyAccount(email) {
  const password = `senhaOriginal${++seq}z7`;
  secrets.add(password);
  const reg = await request(app).post("/v1/auth/register").send({ email, password });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  secrets.add(reg.body.token);
  const id = db.prepare("SELECT id FROM users WHERE email = ?").get(email).id;
  return { id, email, password, jwt: reg.body.token };
}

// Pede a recuperação e devolve { res, mail, token } — o token vem do link no e-mail enfileirado.
async function requestReset(email, body = {}) {
  const before = bongo.state.mails.length;
  const res = await request(app).post("/v1/auth/password-reset/request").send({ email, ...body });
  await waitForBackgroundJobs();
  const mail = bongo.state.mails.slice(before).find((m) => m.template === "qrng_legacy_password_reset") || null;
  let token = null;
  if (mail) {
    secrets.add(mail.secret);
    token = new URL(mail.secret).hash.replace(/^#token=/, "");
    secrets.add(token);
  }
  return { res, mail, token };
}

function internalStatus(id, auth = `Bearer ${SERVICE_TOKEN}`) {
  const r = request(app).get(`/v1/internal/v1/password-reset/${id}/status`);
  return auth ? r.set("Authorization", auth) : r;
}

describe("pedido de recuperação", () => {
  test("conta existente e inexistente: MESMA resposta 202; só a existente gera e-mail (token só como hash)", async () => {
    const a = await legacyAccount("reset-existe@test.com");
    const yes = await requestReset(a.email, { lang: "en" });
    const no = await requestReset("reset-nao-existe@test.com");
    assert.equal(yes.res.status, 202);
    assert.equal(no.res.status, 202);
    assert.deepEqual(yes.res.body, no.res.body);
    assert.deepEqual(Object.keys(yes.res.headers).filter((h) => !["date", "x-request-id", "content-length", "etag", "ratelimit-remaining", "ratelimit-reset", "ratelimit-limit"].includes(h)).sort(),
      Object.keys(no.res.headers).filter((h) => !["date", "x-request-id", "content-length", "etag", "ratelimit-remaining", "ratelimit-reset", "ratelimit-limit"].includes(h)).sort());
    assert.equal(no.mail, null);
    assert.ok(yes.mail, "e-mail não foi enfileirado");

    const m = yes.mail;
    assert.equal(m.to, a.email);
    assert.equal(m.locale, "en");
    assert.match(m.secret, /^https:\/\/portal\.test\/redefinir-senha-api#token=[A-Za-z0-9_-]{43}$/);
    assert.equal(m.validity.kind, "qrng_legacy_password_reset");
    const row = db.prepare("SELECT * FROM password_reset_tokens WHERE user_id = ?").get(a.id);
    assert.equal(m.validity.ref, String(row.id));
    assert.ok(m.idempotencyKey && m.idempotencyKey.length >= 16);
    const ttl = Date.parse(m.secretExpiresAt) - Date.now();
    assert.ok(ttl > 29 * 60 * 1000 && ttl <= 30 * 60 * 1000, `TTL inesperado: ${ttl}`);
    assert.equal(row.token_hash, crypto.createHash("sha256").update(yes.token).digest("hex"));
    assert.equal(row.expires_at, m.secretExpiresAt);
    assert.match(row.requested_ip_prefix, /\/(24|48)$/);
    assert.match(row.sent_to_hash, /^[0-9a-f]{32}$/);
    assert.ok(!dumpDatabase(db).includes(yes.token), "token cru gravado no banco");
  });

  test("e-mail inválido → 400 INVALID_EMAIL", async () => {
    const r = await request(app).post("/v1/auth/password-reset/request").send({ email: "nao-e-email" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "INVALID_EMAIL");
  });

  test("limite por e-mail: 2º pedido em 1 min → 429, igual para conta existente e inexistente", async () => {
    const a = await legacyAccount("reset-limite@test.com");
    assert.equal((await requestReset(a.email)).res.status, 202);
    const again = await requestReset(a.email);
    assert.equal(again.res.status, 429);
    assert.equal(again.mail, null);
    assert.equal((await requestReset("fantasma-limite@test.com")).res.status, 202);
    const ghostAgain = await requestReset("fantasma-limite@test.com");
    assert.equal(ghostAgain.res.status, 429);
    assert.deepEqual(again.res.body, ghostAgain.res.body);
  });

  test("limite por IP: 10 pedidos / 15 min", async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await request(app).post("/v1/auth/password-reset/request").send({ email: `ip-limite-${i}@test.com` })).status, 202);
    }
    assert.equal((await request(app).post("/v1/auth/password-reset/request").send({ email: "ip-limite-x@test.com" })).status, 429);
    await waitForBackgroundJobs();
  });

  test("fila de e-mail do Bongo fora do ar: ainda 202 genérico, token mantido, falha auditada, nada vaza", async () => {
    const a = await legacyAccount("reset-bongo-fora@test.com");
    bongo.state.mailMode = "down";
    const before = db.prepare("SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id = ?").get(a.id).n;
    const r = await request(app).post("/v1/auth/password-reset/request").send({ email: a.email });
    await waitForBackgroundJobs();
    assert.equal(r.status, 202);
    const ghost = await request(app).post("/v1/auth/password-reset/request").send({ email: "fantasma-bongo-fora@test.com" });
    await waitForBackgroundJobs();
    assert.deepEqual(r.body, ghost.body);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id = ?").get(a.id).n, before + 1, "token deveria ser mantido");
    const ev = db.prepare("SELECT * FROM audit_events WHERE event_type = 'auth.password_reset.requested' AND target_user_id = ? ORDER BY id DESC").get(a.id);
    assert.equal(ev.outcome, "failure");
    assert.deepEqual(JSON.parse(ev.metadata), { account_found: true, delivered_to_queue: false, reason: "mail_queue_unavailable" });
    assert.ok(consoleLines.some((l) => /fila de e-mail do Bongo indisponível/.test(l)));
  });
});

describe("check / confirm / validade", () => {
  test("check não consome; token lixo → valid:false", async () => {
    const a = await legacyAccount("reset-check@test.com");
    const { token } = await requestReset(a.email);
    for (let i = 0; i < 2; i++) {
      const c = await request(app).post("/v1/auth/password-reset/check").send({ token });
      assert.deepEqual(c.body, { valid: true });
    }
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token: "x".repeat(43) })).body, { valid: false });
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token: 42 })).body, { valid: false });
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({})).body, { valid: false });
  });

  test("senha fraca é recusada ANTES do token, e o token continua valendo", async () => {
    const a = await legacyAccount("reset-fraca@test.com");
    const { token } = await requestReset(a.email);
    const r = await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: "curta" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "WEAK_PASSWORD");
    const r2 = await request(app).post("/v1/auth/password-reset/confirm").send({ token: "lixo", password: "semnumeroaquiok" });
    assert.equal(r2.body.error, "WEAK_PASSWORD");
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token })).body, { valid: true });
  });

  test("sucesso: nova senha vale, antiga não; JWT emitido antes é rejeitado; outros tokens invalidados; aviso enfileirado", async () => {
    const a = await legacyAccount("reset-sucesso@test.com");
    const oldJwt = jwt.sign({ sub: a.id, email: a.email, role: "user", iat: Math.floor(Date.now() / 1000) - 5 }, JWT_SECRET, { expiresIn: "30d" });
    secrets.add(oldJwt);
    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${oldJwt}`)).status, 200);
    const { token } = await requestReset(a.email);
    const newPassword = "senhaNovaDepoisDoReset99";
    secrets.add(newPassword);
    const mailsBefore = bongo.state.mails.length;
    const r = await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: newPassword, lang: "en" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!("token" in r.body), "sem login automático");
    await waitForBackgroundJobs();

    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${oldJwt}`)).status, 401, "JWT anterior à redefinição deveria cair");
    assert.equal((await request(app).post("/v1/auth/login").send({ email: a.email, password: a.password })).status, 401);
    const login = await request(app).post("/v1/auth/login").send({ email: a.email, password: newPassword });
    assert.equal(login.status, 200);
    secrets.add(login.body.token);
    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${login.body.token}`)).status, 200);

    const row = db.prepare("SELECT password_changed_at FROM users WHERE id = ?").get(a.id);
    assert.ok(row.password_changed_at);
    const changed = bongo.state.mails.slice(mailsBefore).find((m) => m.template === "qrng_legacy_password_changed");
    assert.ok(changed, "aviso de senha alterada não foi enfileirado");
    // Cancelamento ativo do token usado (a mensagem com o link morre na fila do Bongo).
    const usedId = String(db.prepare("SELECT id FROM password_reset_tokens WHERE user_id = ? AND used_at IS NOT NULL").get(a.id).id);
    assert.ok(bongo.state.cancels.some((c) => c.kind === "qrng_legacy_password_reset" && c.refs.includes(usedId)),
      "o token usado não foi cancelado na fila do Bongo");
    assert.equal(changed.to, a.email);
    assert.equal(changed.locale, "en");
    assert.equal(changed.secret, null);
    // token já usado → mesma resposta de inválido
    const reuse = await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: "outraSenhaQualquer1" });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, "INVALID_OR_EXPIRED_TOKEN");
  });

  test("inválido, vencido e usado → MESMA resposta 400 INVALID_OR_EXPIRED_TOKEN", async () => {
    const a = await legacyAccount("reset-invalidos@test.com");
    const pw = "senhaValida123456";
    const bodies = [];
    bodies.push((await request(app).post("/v1/auth/password-reset/confirm").send({ token: crypto.randomBytes(32).toString("base64url"), password: pw })).body);
    const { token: expired } = await requestReset(a.email);
    db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(Date.now() - 1000).toISOString(), crypto.createHash("sha256").update(expired).digest("hex"));
    bodies.push((await request(app).post("/v1/auth/password-reset/confirm").send({ token: expired, password: pw })).body);
    await resetIdentityRateLimits();
    const { token: used } = await requestReset(a.email);
    assert.equal((await request(app).post("/v1/auth/password-reset/confirm").send({ token: used, password: pw })).status, 200);
    bodies.push((await request(app).post("/v1/auth/password-reset/confirm").send({ token: used, password: pw })).body);
    for (const b of bodies) assert.deepEqual(b, bodies[0]);
    assert.equal(bodies[0].error, "INVALID_OR_EXPIRED_TOKEN");
  });

  test("dois confirms concorrentes com o mesmo token → exatamente um sucesso", async () => {
    const a = await legacyAccount("reset-concorrente@test.com");
    const { token } = await requestReset(a.email);
    const [r1, r2] = await Promise.all([
      request(app).post("/v1/auth/password-reset/confirm").send({ token, password: "concorrenteUm11111" }),
      request(app).post("/v1/auth/password-reset/confirm").send({ token, password: "concorrenteDois2222" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id = ? AND used_at IS NOT NULL").get(a.id).n, 1);
  });

  test("pedido novo invalida o token anterior (e o endpoint interno reflete isso)", async () => {
    const a = await legacyAccount("reset-novo-pedido@test.com");
    const first = await requestReset(a.email);
    await resetIdentityRateLimits();
    const second = await requestReset(a.email);
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token: first.token })).body, { valid: false });
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token: second.token })).body, { valid: true });
    const old = await request(app).post("/v1/auth/password-reset/confirm").send({ token: first.token, password: "senhaComOToken1Velho" });
    assert.equal(old.status, 400);
    assert.deepEqual((await internalStatus(first.mail.validity.ref)).body, { valid: false });
    assert.deepEqual((await internalStatus(second.mail.validity.ref)).body, { valid: true });
    // O pedido novo cancela, na fila do Bongo, a mensagem do token anterior — e só ela.
    const cancelledRefs = bongo.state.cancels.flatMap((c) => c.refs);
    assert.ok(cancelledRefs.includes(first.mail.validity.ref), "token anterior não foi cancelado na fila");
    assert.equal(cancelledRefs.includes(second.mail.validity.ref), false, "token novo não pode ser cancelado");
  });

  test("cancelamento com a fila do Bongo fora do ar: melhor-esforço, o pedido segue 202 e o token velho morre aqui", async () => {
    const a = await legacyAccount("reset-cancel-down@test.com");
    const first = await requestReset(a.email);
    await resetIdentityRateLimits();
    const cancelsBefore = bongo.state.calls.cancel;
    bongo.state.mailMode = "error500";
    const r = await request(app).post("/v1/auth/password-reset/request").send({ email: a.email });
    await waitForBackgroundJobs();
    assert.equal(r.status, 202);
    assert.ok(bongo.state.calls.cancel > cancelsBefore, "o cancelamento foi tentado");
    bongo.state.mailMode = "ok";
    assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token: first.token })).body, { valid: false });
  });
});

describe("GET /v1/internal/v1/password-reset/:id/status", () => {
  test("sem token de serviço (ou errado) → 404 idêntico ao de rota inexistente", async () => {
    const a = await legacyAccount("reset-interno@test.com");
    const { mail } = await requestReset(a.email);
    const id = mail.validity.ref;
    const inboundId = "req_sondagem_interna_01";
    const none = await internalStatus(id, null).set("X-Request-Id", inboundId);
    const wrong = await internalStatus(id, "Bearer token-errado").set("X-Request-Id", inboundId);
    const jwtAuth = await internalStatus(id, `Bearer ${a.jwt}`).set("X-Request-Id", inboundId);
    const missing = await request(app).get("/v1/internal/v1/nao-existe").set("X-Request-Id", inboundId);
    const volatile = new Set(["date", "content-length", "etag", "ratelimit-remaining", "ratelimit-reset", "ratelimit-limit"]);
    const headerNames = (r) => Object.keys(r.headers).filter((h) => !volatile.has(h)).sort();
    const shape = (r) => ({ ...r.body, request_id: typeof r.body.request_id, message: r.body.message.replace(/\/v1\/\S+$/, "<path>") });
    assert.equal(missing.status, 404);
    assert.ok(!("x-request-id" in missing.headers), "catch-all não ecoa X-Request-Id (pressuposto do teste)");
    for (const r of [none, wrong, jwtAuth]) {
      assert.equal(r.status, 404);
      assert.deepEqual(shape(r), shape(missing));
      assert.deepEqual(headerNames(r), headerNames(missing), "cabeçalhos diferentes revelam a rota");
      assert.ok(!("x-request-id" in r.headers));
      assert.notEqual(r.body.request_id, inboundId, "não pode ecoar o X-Request-Id recebido (o catch-all não ecoa)");
      assert.ok(!("valid" in r.body));
    }
    // com o token de serviço, a mesma rota responde e ecoa o X-Request-Id
    const ok = await internalStatus(id).set("X-Request-Id", inboundId);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["x-request-id"], inboundId);
  });

  test("validade: ativo → true; usado / vencido / inexistente / conta excluída → false", async () => {
    const a = await legacyAccount("reset-interno-2@test.com");
    const { mail, token } = await requestReset(a.email);
    const id = mail.validity.ref;
    assert.deepEqual((await internalStatus(id)).body, { valid: true });
    assert.deepEqual((await internalStatus(999999)).body, { valid: false });
    assert.deepEqual((await internalStatus("abc")).body, { valid: false });
    db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), id);
    assert.deepEqual((await internalStatus(id)).body, { valid: false });
    db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() + 60000).toISOString(), id);
    assert.deepEqual((await internalStatus(id)).body, { valid: true });
    assert.equal((await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: "senhaInterna123456" })).status, 200);
    assert.deepEqual((await internalStatus(id)).body, { valid: false });

    const b = await legacyAccount("reset-interno-3@test.com");
    await resetIdentityRateLimits();
    const rb = await requestReset(b.email);
    assert.deepEqual((await internalStatus(rb.mail.validity.ref)).body, { valid: true });
    const del = await request(app).delete("/v1/auth/me").set("Authorization", `Bearer ${b.jwt}`).send({ password: b.password });
    assert.equal(del.status, 200);
    assert.deepEqual((await internalStatus(rb.mail.validity.ref)).body, { valid: false });
  });
});

// ── Vínculo com o portal × redefinição de senha ─────────────────────────────

let portalSeq = 0;
function portalIdentity(email) {
  portalSeq++;
  const user = { id: `0000154${portalSeq}-aaaa-4bbb-8ccc-${String(portalSeq).padStart(12, "0")}`, email };
  const session = bongo.addSession(user);
  secrets.add(session);
  return { user, session, reauth: () => { const t = bongo.addReauth(user.id); secrets.add(t); return t; } };
}
const P = (session) => ({ "X-Portal-Session": session });

describe("redefinição de senha × vínculo com o portal", () => {
  test("quem vinculou com a senha antiga perde o acesso pela sessão do portal depois da redefinição", async () => {
    const a = await legacyAccount("reset-vinculada@test.com");
    const intruso = portalIdentity("intruso-portal@test.com");
    const link = await request(app).post("/v1/identity/link").set(P(intruso.session))
      .send({ reauthToken: intruso.reauth(), legacyEmail: a.email, legacyPassword: a.password });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal((await request(app).get("/v1/auth/me").set(P(intruso.session))).body.id, a.id);

    // o dono recupera a conta pelo e-mail
    const { token } = await requestReset(a.email);
    const newPassword = "senhaDoDonoDepoisDoReset7";
    secrets.add(newPassword);
    const r = await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: newPassword });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForBackgroundJobs();

    const row = db.prepare("SELECT bongo_user_id, linked_at, portal_email, email, auth_source FROM users WHERE id = ?").get(a.id);
    assert.deepEqual(row, { bongo_user_id: null, linked_at: null, portal_email: null, email: a.email, auth_source: "legacy" });
    for (const [m, url] of [["get", "/v1/auth/me"], ["get", "/v1/me/token"], ["get", "/v1/me/usage"], ["post", "/v1/me/token/rotate"],
      ["post", "/v1/tokens"], ["delete", "/v1/auth/me"]]) {
      const x = await request(app)[m](url).set(P(intruso.session)).send({});
      assert.equal(x.status, 404, `${m} ${url}: ${JSON.stringify(x.body)}`);
      assert.equal(x.body.error, "DEVELOPER_ACCOUNT_NOT_PROVISIONED");
    }
    const st = await request(app).get("/v1/identity/status").set(P(intruso.session));
    assert.equal(st.body.developer_account, null);

    const ev = db.prepare("SELECT * FROM audit_events WHERE event_type = 'identity.unlinked' AND target_user_id = ?").all(a.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].outcome, "success");
    assert.deepEqual(JSON.parse(ev[0].metadata), { via: "password_reset", portal_user_id: intruso.user.id });

    // a senha antiga não serve mais para vincular de novo; a nova serve (para o dono)
    const relinkOld = await request(app).post("/v1/identity/link").set(P(intruso.session))
      .send({ reauthToken: intruso.reauth(), legacyEmail: a.email, legacyPassword: a.password });
    assert.equal(relinkOld.status, 403);
    assert.equal(relinkOld.body.error, "INVALID_LEGACY_CREDENTIALS");
    const dono = portalIdentity("dono-portal@test.com");
    const relink = await request(app).post("/v1/identity/link").set(P(dono.session))
      .send({ reauthToken: dono.reauth(), legacyEmail: a.email, legacyPassword: newPassword });
    assert.equal(relink.status, 200, JSON.stringify(relink.body));
    assert.equal((await request(app).get("/v1/auth/me").set(P(dono.session))).body.id, a.id);
  });

  test("redefinição de conta NÃO vinculada não grava identity.unlinked", async () => {
    const a = await legacyAccount("reset-sem-vinculo@test.com");
    const { token } = await requestReset(a.email);
    assert.equal((await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: "senhaSemVinculo12345" })).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'identity.unlinked' AND target_user_id = ?").get(a.id).n, 0);
  });

  test("login e vínculo dividem o MESMO teto de tentativas de senha por conta antiga (10/15 min)", async () => {
    const a = await legacyAccount("reset-teto-compartilhado@test.com");
    for (let i = 0; i < 6; i++) {
      assert.equal((await request(app).post("/v1/auth/login").send({ email: a.email, password: `errada${i}xxxxxx1` })).status, 401);
    }
    // várias contas do portal (cada uma com o seu próprio limite) contra o mesmo e-mail
    for (let i = 0; i < 4; i++) {
      const p = portalIdentity(`tentativa${i}-portal@test.com`);
      const r = await request(app).post("/v1/identity/link").set(P(p.session))
        .send({ reauthToken: p.reauth(), legacyEmail: ` ${a.email.toUpperCase()} `, legacyPassword: `errada${i}yyyyyy2` });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "INVALID_LEGACY_CREDENTIALS");
    }
    // 10 tentativas somadas: a 11ª é recusada — pelo vínculo (sem gastar o reauth) e pelo login
    const p = portalIdentity("tentativa-final-portal@test.com");
    const ra = p.reauth();
    const blocked = await request(app).post("/v1/identity/link").set(P(p.session))
      .send({ reauthToken: ra, legacyEmail: a.email, legacyPassword: a.password });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "TOO_MANY_ATTEMPTS");
    assert.equal(bongo.state.reauth.get(ra).used, false, "o reauth não pode ser consumido quando o teto já foi atingido");
    assert.equal(db.prepare("SELECT bongo_user_id FROM users WHERE id = ?").get(a.id).bongo_user_id, null);
    assert.equal((await request(app).post("/v1/auth/login").send({ email: a.email, password: a.password })).status, 429);
    const ev = db.prepare("SELECT * FROM audit_events WHERE event_type = 'identity.linked' AND outcome = 'failure' ORDER BY id DESC").get();
    assert.equal(JSON.parse(ev.metadata).reason, "rate_limited");
    assert.match(ev.subject_hash, /^[0-9a-f]{32}$/);

    // vínculo recusado ANTES do bcrypt (reauth inválido) NÃO conta como tentativa
    // de senha legada: depois de 10 deles, o login correto ainda passa (seria o
    // 11º do balde se tivessem contado).
    await resetIdentityRateLimits();
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/v1/identity/link").set(P(p.session))
        .send({ reauthToken: `reauth-inexistente-${i}`, legacyEmail: a.email, legacyPassword: a.password });
      assert.equal(r.status, 403, `tentativa ${i}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "REAUTH_REQUIRED");
    }
    const login = await request(app).post("/v1/auth/login").send({ email: a.email, password: a.password });
    assert.equal(login.status, 200);
    secrets.add(login.body.token);
    const outro = portalIdentity("tentativa-ok-portal@test.com");
    const ok = await request(app).post("/v1/identity/link").set(P(outro.session))
      .send({ reauthToken: outro.reauth(), legacyEmail: a.email, legacyPassword: a.password });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe("auditoria e segredos", () => {
  test("eventos de recuperação presentes, com pseudônimo e sem e-mail", () => {
    const ev = (o) => db.prepare("SELECT * FROM audit_events WHERE event_type = ? AND outcome = ?").all(...o);
    const requested = ev(["auth.password_reset.requested", "success"]);
    assert.ok(requested.some((e) => JSON.parse(e.metadata).account_found === false), "pedido sem conta deveria ser auditado");
    assert.ok(requested.every((e) => /^[0-9a-f]{32}$/.test(e.subject_hash)));
    assert.ok(ev(["auth.password_reset.completed", "success"]).length >= 1);
    const failed = ev(["auth.password_reset.completed", "failure"]);
    assert.ok(failed.length >= 1 && failed.every((e) => JSON.parse(e.metadata).reason === "invalid_or_expired"));
  });

  test("nenhum token, link, senha ou JWT em logs, na auditoria ou no banco; nenhum e-mail na auditoria", () => {
    const logs = consoleLines.join("\n");
    const auditDump = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    const dbDump = dumpDatabase(db);
    assert.ok(secrets.size > 10);
    for (const s of secrets) {
      assert.ok(!logs.includes(s), "segredo nos logs");
      assert.ok(!auditDump.includes(s), "segredo na auditoria");
      assert.ok(!dbDump.includes(s), "segredo no banco");
    }
    assert.doesNotMatch(logs, /#token=/);
    assert.doesNotMatch(auditDump, /@/);
    assert.doesNotMatch(logs, /@test\.com/);
  });
});

describe("revisão final: JWT do mesmo segundo, exclusão de conta e retenção da auditoria", () => {
  test("JWT legado emitido ANTES da redefinição no mesmo segundo é revogado (iat_ms); sem iat_ms, iat <= segundo da redefinição cai", async () => {
    const a = await legacyAccount("reset-mesmo-segundo@test.com");
    const { token } = await requestReset(a.email);
    const login = await request(app).post("/v1/auth/login").send({ email: a.email, password: a.password });
    assert.equal(login.status, 200);
    secrets.add(login.body.token);
    const newPassword = "senhaNovaMesmoSegundo42";
    secrets.add(newPassword);
    assert.equal((await request(app).post("/v1/auth/password-reset/confirm").send({ token, password: newPassword })).status, 200);
    await waitForBackgroundJobs();
    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${login.body.token}`)).status, 401,
      "JWT emitido antes da redefinição (mesmo que no mesmo segundo) deveria cair");
    const changed = db.prepare("SELECT password_changed_at FROM users WHERE id = ?").get(a.id).password_changed_at;
    const sameSecond = jwt.sign({ sub: a.id, email: a.email, role: "user", iat: Math.floor(Date.parse(changed) / 1000) }, JWT_SECRET, { expiresIn: "30d" });
    secrets.add(sameSecond);
    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${sameSecond}`)).status, 401);
    const fresh = await request(app).post("/v1/auth/login").send({ email: a.email, password: newPassword });
    secrets.add(fresh.body.token);
    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${fresh.body.token}`)).status, 200);
  });

  test("excluir a conta legada cancela, na fila do Bongo, o e-mail de redefinição ainda pendente", async () => {
    const a = await legacyAccount("reset-exclusao@test.com");
    const first = await requestReset(a.email);
    const ref = first.mail.validity.ref;
    const del = await request(app).delete("/v1/auth/me").set("Authorization", `Bearer ${a.jwt}`).send({ password: a.password });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    await waitForBackgroundJobs();
    assert.ok(bongo.state.cancels.some((c) => c.kind === "qrng_legacy_password_reset" && c.refs.includes(ref)),
      "o token da conta excluída não foi cancelado na fila");
  });

  test("retenção da auditoria: valor inválido (negativo) volta para 365 e não apaga eventos recentes", () => {
    const Database = require("better-sqlite3");
    const { createAudit } = require("../lib/audit");
    const mem = new Database(":memory:");
    mem.exec(`CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
    mem.exec("DROP TABLE audit_events");
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'").get().sql;
    mem.exec(ddl);
    const au = createAudit(mem, { retentionDays: -1 });
    au.record({ type: "auth.login", outcome: "success", req: { requestId: "r", ip: "203.0.113.9" } });
    au.purge();
    assert.equal(mem.prepare("SELECT COUNT(*) AS c FROM audit_events").get().c, 1);
    mem.close();
  });
});
