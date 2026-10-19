"use strict";
// Identidade integrada (doc 155, 2.3–2.6 e 5): sessão do portal por
// introspecção no Bongo (falso), provisão, vínculo seguro de conta legada,
// conflitos, falha fechada, auditoria e ausência de segredos em logs/banco.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { createFakeBongo, captureConsole, dumpDatabase } = require("../test-support/fake-bongo");

const SERVICE_TOKEN = "test-internal-service-token-identity";
const JWT_SECRET = "test-jwt-secret-for-ci";
const testDbPath = path.join(os.tmpdir(), `qrng-identity-${Date.now()}.db`);
const bongo = createFakeBongo({ serviceToken: SERVICE_TOKEN });
const consoleLines = captureConsole();
const secrets = new Set([SERVICE_TOKEN]); // tudo que NUNCA pode aparecer em log/auditoria
let app, db, waitForBackgroundJobs;

before(async () => {
  const url = await bongo.listen();
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.BONGO_INTERNAL_URL = url;
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.PORTAL_INTROSPECTION_CACHE_MS = "0";
  process.env.PORTAL_ACCOUNT_STATUS_CACHE_MS = "0";   // estado da conta do portal sempre reconsultado
  process.env.PORTAL_INTROSPECTION_TIMEOUT_MS = "300";
  process.env.AUDIT_PSEUDONYM_KEY = "test-audit-pseudonym-key";
  process.env.RATE_LIMIT_PER_IP_PER_MINUTE = "100000";
  process.env.QRNG_UPSTREAM = "http://127.0.0.1:9"; // nada aqui depende do broker
  process.env.ENABLE_TEST_ROUTES = "1";             // só para /v1/_test/identity-headers
  ({ app, db, waitForBackgroundJobs } = require("../server"));
});
after(async () => {
  try { db.close(); } catch (_) {}
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(testDbPath + s); } catch (_) {} }
  await bongo.close();
});

let seq = 0;
function portalUser(over = {}) {
  seq++;
  const user = { id: `0000000${seq}-aaaa-4bbb-8ccc-${String(seq).padStart(12, "0")}`, email: `portal${seq}@test.com`, ...over };
  const token = bongo.addSession(user, { qrng: over.qrng !== false });
  secrets.add(token);
  return { user, token };
}

async function legacyAccount(email, password = `senhaLegada${++seq}x9`) {
  secrets.add(password);
  const reg = await request(app).post("/v1/auth/register").send({ email, password });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  secrets.add(reg.body.token);
  const tok = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${reg.body.token}`);
  assert.equal(tok.status, 200);
  secrets.add(tok.body.token);
  const id = db.prepare("SELECT id FROM users WHERE email = ?").get(email).id;
  return { id, email, password, jwt: reg.body.token, apiToken: tok.body.token };
}

function reauthFor(user, purpose) {
  const t = bongo.addReauth(user.id, purpose);
  secrets.add(t);
  return t;
}

const P = (token) => ({ "X-Portal-Session": token });

// ── Cabeçalhos de identidade forjados ───────────────────────────────────────

describe("cabeçalhos de identidade vindos do cliente são ignorados", () => {
  test("X-Bongo-User-Id / X-Bongo-Role / X-Portal-User são removidos antes de qualquer rota", async () => {
    const r = await request(app).get("/v1/_test/identity-headers")
      .set("X-Bongo-User-Id", "u-1").set("X-Bongo-Role", "admin").set("X-Portal-User", "x").set("X-Request-Id", "req_probe_1234");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.present, []);
  });

  test("X-Bongo-User-Id / X-Bongo-Role / X-Portal-User sozinhos não autenticam nada", async () => {
    const { user, token } = portalUser();
    assert.equal((await request(app).post("/v1/identity/provision").set(P(token))).status, 201);
    const forged = { "X-Bongo-User-Id": user.id, "X-Bongo-Role": "admin", "X-Portal-User": user.email };
    for (const [method, url] of [["get", "/v1/auth/me"], ["get", "/v1/me/token"], ["get", "/v1/admin/users"], ["get", "/v1/identity/status"]]) {
      const r = await request(app)[method](url).set(forged);
      assert.equal(r.status, 401, `${url} aceitou identidade por cabeçalho: ${JSON.stringify(r.body)}`);
    }
  });

  test("X-Bongo-Role: admin não promove uma sessão legítima de usuário comum", async () => {
    const a = await legacyAccount("forjado@test.com");
    const r = await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${a.jwt}`).set("X-Bongo-Role", "admin");
    assert.equal(r.status, 403);
  });
});

// ── Sessão do portal: status e provisão ─────────────────────────────────────

describe("sessão do portal válida", () => {
  test("status sem conta → provision cria conta 'portal' vinculada, sem e-mail/senha locais", async () => {
    const { user, token } = portalUser({ name: "Ana Portal" });
    const s1 = await request(app).get("/v1/identity/status").set(P(token));
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.deepEqual(s1.body.portal, { id: user.id, email: user.email, name: "Ana Portal" });
    assert.equal(s1.body.developer_account, null);
    assert.equal(s1.body.can_provision, true);
    assert.equal(s1.body.can_link, true);

    const pr = await request(app).post("/v1/identity/provision").set(P(token));
    assert.equal(pr.status, 201, JSON.stringify(pr.body));
    assert.equal(pr.body.developer_account.auth_source, "portal");
    assert.equal(pr.body.developer_account.has_token, false);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(pr.body.developer_account.id);
    assert.equal(row.email, null);
    assert.equal(row.password_hash, null);
    assert.equal(row.bongo_user_id, user.id);
    assert.equal(row.portal_email, user.email);
    assert.equal(row.role, "user");
    assert.ok(row.linked_at && row.last_login_at);

    const s2 = await request(app).get("/v1/identity/status").set(P(token));
    assert.equal(s2.body.developer_account.id, row.id);
    assert.equal(s2.body.can_provision, false);

    const again = await request(app).post("/v1/identity/provision").set(P(token));
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "PORTAL_ALREADY_LINKED");

    // a mesma sessão emite e usa o token de API
    const tk = await request(app).post("/v1/tokens").set(P(token));
    assert.equal(tk.status, 200, JSON.stringify(tk.body));
    secrets.add(tk.body.token);
    const me = await request(app).get("/v1/me/token").set(P(token));
    assert.equal(me.body.has_token, true);
    assert.equal(me.body.token_prefix, tk.body.prefix);
    const am = await request(app).get("/v1/auth/me").set(P(token));
    assert.equal(am.status, 200);
    assert.equal(am.body.id, row.id);
    // a chave funciona sem o Bongo envolvido
    const callsBefore = bongo.state.calls.introspect;
    const u = await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${tk.body.token}`);
    assert.equal(u.status, 200);
    assert.equal(bongo.state.calls.introspect, callsBefore);
  });

  test("admin no portal NÃO vira admin na client-api; o papel é o da linha da client-api", async () => {
    const { token } = portalUser({ role: "admin" });
    const pr = await request(app).post("/v1/identity/provision").set(P(token));
    assert.equal(pr.status, 201);
    assert.equal((await request(app).get("/v1/admin/users").set(P(token))).status, 403);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(pr.body.developer_account.id);
    assert.equal((await request(app).get("/v1/admin/audit").set(P(token))).status, 200);
  });

  test("conta criada pelo portal não tem JWT legado nem login por e-mail", async () => {
    const { user, token } = portalUser();
    const pr = await request(app).post("/v1/identity/provision").set(P(token));
    const forgedJwt = jwt.sign({ sub: pr.body.developer_account.id, email: user.email, role: "user" }, JWT_SECRET, { expiresIn: "1h" });
    secrets.add(forgedJwt);
    const r = await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${forgedJwt}`);
    assert.equal(r.status, 401);
    const r2 = await request(app).get("/v1/me/token").set("Authorization", `Bearer ${forgedJwt}`);
    assert.equal(r2.status, 401);
    const login = await request(app).post("/v1/auth/login").send({ email: user.email, password: "qualquerCoisa123" });
    assert.equal(login.status, 401);
  });

  test("sessão do portal sem conta de desenvolvedor → 404 DEVELOPER_ACCOUNT_NOT_PROVISIONED fora de /identity", async () => {
    const { token } = portalUser();
    for (const url of ["/v1/me/token", "/v1/me/usage", "/v1/auth/me"]) {
      const r = await request(app).get(url).set(P(token));
      assert.equal(r.status, 404, url);
      assert.equal(r.body.error, "DEVELOPER_ACCOUNT_NOT_PROVISIONED");
    }
    assert.equal((await request(app).post("/v1/tokens").set(P(token))).body.error, "DEVELOPER_ACCOUNT_NOT_PROVISIONED");
  });
});

// ── Autorização, revogação e falha fechada ──────────────────────────────────

describe("autorização e indisponibilidade do Bongo", () => {
  test("sem 'qrng' nos serviços → 403 QRNG_ACCESS_DENIED (status, provision e /me/*), negação deduplicada na auditoria", async () => {
    const { user, token } = portalUser({ qrng: false });
    for (const [m, url] of [["get", "/v1/identity/status"], ["post", "/v1/identity/provision"], ["get", "/v1/me/token"]]) {
      const r = await request(app)[m](url).set(P(token));
      assert.equal(r.status, 403, url);
      assert.equal(r.body.error, "QRNG_ACCESS_DENIED");
    }
    const n = db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'identity.denied' AND metadata LIKE ?").get(`%${user.id}%`).n;
    assert.equal(n, 1, "identity.denied deveria ser 1 por usuário+motivo a cada 10 min");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE bongo_user_id = ?").get(user.id).n, 0);
  });

  test("token do portal revogado → 401 já na próxima requisição (cache 0)", async () => {
    const { token } = portalUser();
    assert.equal((await request(app).post("/v1/identity/provision").set(P(token))).status, 201);
    assert.equal((await request(app).get("/v1/me/token").set(P(token))).status, 200);
    bongo.revoke(token);
    const r = await request(app).get("/v1/me/token").set(P(token));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "PORTAL_SESSION_INVALID");
    assert.equal((await request(app).get("/v1/identity/status").set(P(token))).status, 401);
    assert.equal((await request(app).get("/v1/identity/status").set(P("lixo-qualquer"))).status, 401);
  });

  for (const mode of ["down", "error500", "slow", "malformed"]) {
    test(`Bongo '${mode}' → 503 IDENTITY_UNAVAILABLE e nenhum acesso; chave de API e login legado seguem funcionando`, async () => {
      const { token } = portalUser();
      assert.equal((await request(app).post("/v1/identity/provision").set(P(token))).status, 201);
      const k = await request(app).post("/v1/tokens").set(P(token));
      secrets.add(k.body.token);
      const legacy = await legacyAccount(`indisp-${mode}@test.com`);
      bongo.state.mode = mode;
      try {
        const t0 = Date.now();
        for (const [m, url] of [["get", "/v1/identity/status"], ["get", "/v1/me/token"], ["post", "/v1/tokens"], ["get", "/v1/auth/me"], ["get", "/v1/admin/audit"]]) {
          const r = await request(app)[m](url).set(P(token));
          assert.equal(r.status, 503, `${mode} ${url}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.error, "IDENTITY_UNAVAILABLE");
        }
        if (mode === "slow") assert.ok(Date.now() - t0 < 5 * 1000, "timeout da introspecção não foi respeitado");
        assert.equal((await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${k.body.token}`)).status, 200);
        const login = await request(app).post("/v1/auth/login").send({ email: legacy.email, password: legacy.password });
        assert.equal(login.status, 200);
        secrets.add(login.body.token);
        assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${login.body.token}`)).status, 200);
      } finally {
        bongo.reset();
      }
    });
  }
});

// ── Vínculo de conta legada ─────────────────────────────────────────────────

describe("vínculo seguro de conta legada", () => {
  let legacy, portal, snapshot;

  function usageSnapshot(userId) {
    const tokens = db.prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id").all(userId);
    const ids = tokens.map((t) => t.id);
    const q = (sql) => db.prepare(sql.replace("$IDS", ids.map(() => "?").join(",") || "NULL")).all(...ids);
    return JSON.stringify({
      tokens,
      daily: q("SELECT * FROM daily_usage WHERE token_id IN ($IDS) ORDER BY id"),
      logs: q("SELECT * FROM api_usage_logs WHERE token_id IN ($IDS) ORDER BY id"),
    });
  }

  before(async () => {
    legacy = await legacyAccount("legado@test.com");
    // histórico e cota próprios da conta antiga
    const tok = db.prepare("SELECT * FROM api_tokens WHERE user_id = ?").get(legacy.id);
    db.prepare("UPDATE api_tokens SET quota_daily = 4321 WHERE id = ?").run(tok.id);
    db.prepare("INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count) VALUES (?, '2026-10-01', 7, 700, 1)").run(tok.id);
    db.prepare(`INSERT INTO api_usage_logs (request_id, token_id, endpoint, bytes_requested, format, status_code, ip_address, user_agent, duration_ms, created_at)
                VALUES ('req_hist_000000001', ?, '/v1/random', 32, 'hex', 200, '203.0.113.0/24', NULL, 5, '2026-10-01T10:00:00.000Z')`).run(tok.id);
    // portal com o MESMO e-mail da conta antiga
    portal = portalUser({ email: "legado@test.com" });
    snapshot = usageSnapshot(legacy.id);
  });

  test("igualdade de e-mail sozinha NÃO vincula: status não mostra conta e nada muda no banco", async () => {
    const s = await request(app).get("/v1/identity/status").set(P(portal.token));
    assert.equal(s.status, 200);
    assert.equal(s.body.developer_account, null);
    assert.equal(s.body.can_link, true);
    assert.equal((await request(app).get("/v1/me/token").set(P(portal.token))).body.error, "DEVELOPER_ACCOUNT_NOT_PROVISIONED");
    assert.equal(db.prepare("SELECT bongo_user_id FROM users WHERE id = ?").get(legacy.id).bongo_user_id, null);
  });

  test("sem reauth, reauth inválido ou de outra finalidade → 403 REAUTH_REQUIRED", async () => {
    const body = { legacyEmail: legacy.email, legacyPassword: legacy.password };
    const r1 = await request(app).post("/v1/identity/link").set(P(portal.token)).send(body);
    assert.equal(r1.status, 403); assert.equal(r1.body.error, "REAUTH_REQUIRED");
    const r2 = await request(app).post("/v1/identity/link").set(P(portal.token)).send({ ...body, reauthToken: "reauth-inexistente" });
    assert.equal(r2.status, 403); assert.equal(r2.body.error, "REAUTH_REQUIRED");
    const other = reauthFor(portal.user, "change_email");
    const r3 = await request(app).post("/v1/identity/link").set(P(portal.token)).send({ ...body, reauthToken: other });
    assert.equal(r3.status, 403); assert.equal(r3.body.error, "REAUTH_REQUIRED");
    // reauth de OUTRA pessoa do portal
    const someoneElse = portalUser();
    const foreign = reauthFor(someoneElse.user);
    const r4 = await request(app).post("/v1/identity/link").set(P(portal.token)).send({ ...body, reauthToken: foreign });
    assert.equal(r4.status, 403); assert.equal(r4.body.error, "REAUTH_REQUIRED");
    assert.equal(db.prepare("SELECT bongo_user_id FROM users WHERE id = ?").get(legacy.id).bongo_user_id, null);
  });

  test("reauth válido + senha legada errada (ou conta inexistente) → 403 INVALID_LEGACY_CREDENTIALS; reauth é de uso único", async () => {
    const ra = reauthFor(portal.user);
    const wrong = await request(app).post("/v1/identity/link").set(P(portal.token))
      .send({ reauthToken: ra, legacyEmail: legacy.email, legacyPassword: "senhaErrada12345" });
    assert.equal(wrong.status, 403); assert.equal(wrong.body.error, "INVALID_LEGACY_CREDENTIALS");
    const reuse = await request(app).post("/v1/identity/link").set(P(portal.token))
      .send({ reauthToken: ra, legacyEmail: legacy.email, legacyPassword: legacy.password });
    assert.equal(reuse.status, 403); assert.equal(reuse.body.error, "REAUTH_REQUIRED", "reauth já consumido não pode valer de novo");
    const ra2 = reauthFor(portal.user);
    const ghost = await request(app).post("/v1/identity/link").set(P(portal.token))
      .send({ reauthToken: ra2, legacyEmail: "naoexiste@test.com", legacyPassword: legacy.password });
    assert.equal(ghost.status, 403); assert.equal(ghost.body.error, "INVALID_LEGACY_CREDENTIALS");
    assert.equal(db.prepare("SELECT bongo_user_id FROM users WHERE id = ?").get(legacy.id).bongo_user_id, null);
  });

  test("reauth + senha corretos → vinculado: mesmo id, mesma chave, mesma cota e histórico intocado", async () => {
    const ra = reauthFor(portal.user);
    await waitForBackgroundJobs();
    const mailsBefore = bongo.state.mails.length;
    const r = await request(app).post("/v1/identity/link").set(P(portal.token))
      .send({ reauthToken: ra, legacyEmail: legacy.email, legacyPassword: legacy.password });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForBackgroundJobs();
    // Aviso ao e-mail da conta ANTIGA (sem segredo e sem o e-mail do portal).
    const notices = bongo.state.mails.slice(mailsBefore).filter((m) => m.template === "qrng_legacy_account_linked");
    assert.equal(notices.length, 1, "aviso de vínculo não foi enfileirado");
    assert.equal(notices[0].to, legacy.email);
    assert.equal(notices[0].secret, null);
    assert.equal(notices[0].locale, "pt");
    // (aqui o portal usa o MESMO e-mail; o que não pode ir no aviso é a identidade do portal)
    assert.equal(JSON.stringify(notices[0]).includes(portal.user.id), false);
    assert.equal(r.body.linked, true);
    assert.equal(r.body.developer_account.id, legacy.id);
    assert.equal(r.body.developer_account.auth_source, "legacy");
    assert.equal(r.body.developer_account.has_token, true);
    assert.equal(usageSnapshot(legacy.id), snapshot, "tokens/daily_usage/api_usage_logs mudaram com o vínculo");

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(legacy.id);
    assert.equal(row.bongo_user_id, portal.user.id);
    assert.equal(row.email, legacy.email);
    assert.ok(row.linked_at);

    const me = await request(app).get("/v1/auth/me").set(P(portal.token));
    assert.equal(me.body.id, legacy.id);
    assert.equal(me.body.email, legacy.email);
    const usagePortal = await request(app).get("/v1/me/usage").set(P(portal.token));
    assert.equal(usagePortal.status, 200);
    assert.equal(usagePortal.body.quota_daily_requests, 4321);
    const usageKey = await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${legacy.apiToken}`);
    assert.equal(usageKey.status, 200);
    assert.equal(usageKey.body.quota_daily_requests, 4321);
    assert.deepEqual(usageKey.body.daily_history, usagePortal.body.daily_history);
    const reqs = await request(app).get("/v1/me/requests").set(P(portal.token));
    assert.ok(reqs.body.requests.some((x) => x.request_id === "req_hist_000000001"));
  });

  test("login legado continua funcionando depois do vínculo (e o JWT antigo também)", async () => {
    const login = await request(app).post("/v1/auth/login").send({ email: legacy.email, password: legacy.password });
    assert.equal(login.status, 200);
    secrets.add(login.body.token);
    assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${login.body.token}`)).body.id, legacy.id);
    assert.equal((await request(app).get("/v1/me/token").set("Authorization", `Bearer ${legacy.jwt}`)).status, 200);
    assert.ok(db.prepare("SELECT last_login_at FROM users WHERE id = ?").get(legacy.id).last_login_at);
  });

  test("/v1/identity/*: X-Portal-Session + Authorization de OUTRA conta → 400 AMBIGUOUS_CREDENTIALS e nada muda", async () => {
    const outra = await legacyAccount("outra-identity@test.com");
    // identidade já vinculada (portal → legacy): Bearer de outra conta / lixo → 400; da mesma conta → 200
    const s = await request(app).get("/v1/identity/status").set(P(portal.token)).set("Authorization", `Bearer ${outra.jwt}`);
    assert.equal(s.status, 400); assert.equal(s.body.error, "AMBIGUOUS_CREDENTIALS");
    assert.equal((await request(app).get("/v1/identity/status").set(P(portal.token)).set("Authorization", "Bearer lixo")).status, 400);
    assert.equal((await request(app).get("/v1/identity/status").set(P(portal.token)).set("Authorization", `Bearer ${legacy.jwt}`)).status, 200);

    // identidade SEM conta: qualquer Authorization junto é ambíguo (nunca é "a mesma conta")
    const novo = portalUser();
    const pr = await request(app).post("/v1/identity/provision").set(P(novo.token)).set("Authorization", `Bearer ${outra.jwt}`);
    assert.equal(pr.status, 400); assert.equal(pr.body.error, "AMBIGUOUS_CREDENTIALS");
    const ra = reauthFor(novo.user);
    const lk = await request(app).post("/v1/identity/link").set(P(novo.token)).set("Authorization", `Bearer ${outra.apiToken}`)
      .send({ reauthToken: ra, legacyEmail: outra.email, legacyPassword: outra.password });
    assert.equal(lk.status, 400); assert.equal(lk.body.error, "AMBIGUOUS_CREDENTIALS");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE bongo_user_id = ?").get(novo.user.id).n, 0);
    assert.equal(db.prepare("SELECT bongo_user_id FROM users WHERE id = ?").get(outra.id).bongo_user_id, null);
    // o reauth não foi gasto: o mesmo pedido sem o Authorization estranho vincula
    const ok = await request(app).post("/v1/identity/link").set(P(novo.token))
      .send({ reauthToken: ra, legacyEmail: outra.email, legacyPassword: outra.password });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("X-Portal-Session + Authorization de OUTRA conta → 400 AMBIGUOUS_CREDENTIALS; da mesma conta → ok", async () => {
    const outra = await legacyAccount("outra-conta@test.com");
    const amb = await request(app).get("/v1/me/token").set(P(portal.token)).set("Authorization", `Bearer ${outra.jwt}`);
    assert.equal(amb.status, 400); assert.equal(amb.body.error, "AMBIGUOUS_CREDENTIALS");
    const amb2 = await request(app).get("/v1/auth/me").set(P(portal.token)).set("Authorization", `Bearer ${outra.apiToken}`);
    assert.equal(amb2.status, 400);
    const amb3 = await request(app).get("/v1/auth/me").set(P(portal.token)).set("Authorization", "Bearer lixo");
    assert.equal(amb3.status, 400);
    const same = await request(app).get("/v1/me/token").set(P(portal.token)).set("Authorization", `Bearer ${legacy.jwt}`);
    assert.equal(same.status, 200);
    const sameKey = await request(app).get("/v1/me/usage").set(P(portal.token)).set("Authorization", `Bearer ${legacy.apiToken}`);
    assert.equal(sameKey.status, 200);
  });

  test("conflitos: portal já vinculado → 409 PORTAL_ALREADY_LINKED; conta já vinculada → 409 ACCOUNT_ALREADY_LINKED", async () => {
    const outra = await legacyAccount("segunda-legada@test.com");
    const ra = reauthFor(portal.user);
    const r1 = await request(app).post("/v1/identity/link").set(P(portal.token))
      .send({ reauthToken: ra, legacyEmail: outra.email, legacyPassword: outra.password });
    assert.equal(r1.status, 409); assert.equal(r1.body.error, "PORTAL_ALREADY_LINKED");
    assert.equal((await request(app).post("/v1/identity/provision").set(P(portal.token))).body.error, "PORTAL_ALREADY_LINKED");

    const intruso = portalUser();
    const ra2 = reauthFor(intruso.user);
    const r2 = await request(app).post("/v1/identity/link").set(P(intruso.token))
      .send({ reauthToken: ra2, legacyEmail: legacy.email, legacyPassword: legacy.password });
    assert.equal(r2.status, 409); assert.equal(r2.body.error, "ACCOUNT_ALREADY_LINKED");
    // e a mesma conta de portal não foi movida
    assert.equal(db.prepare("SELECT bongo_user_id FROM users WHERE id = ?").get(legacy.id).bongo_user_id, portal.user.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE bongo_user_id = ?").get(intruso.user.id).n, 0);
  });

  test("scripts: identity-report só agrega (sem e-mails/ids); identity-unlink desvincula e audita", async () => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    const env = { ...process.env, DB_PATH: testDbPath };
    const out = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "identity-report.js")], { env }).toString();
    const rep = JSON.parse(out);
    for (const k of ["total", "legacy_unlinked", "legacy_linked", "portal_created", "with_active_key", "legacy_admins"]) {
      assert.equal(typeof rep[k], "number", k);
    }
    assert.equal(rep.total, db.prepare("SELECT COUNT(*) n FROM users").get().n);
    assert.ok(rep.legacy_linked >= 1);
    assert.doesNotMatch(out, /@/, "relatório não pode conter e-mails");
    assert.doesNotMatch(out, /[0-9a-f]{8}-[0-9a-f]{4}-/i, "relatório não pode conter ids do portal");

    const un = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "identity-unlink.js"), String(legacy.id)], { env }).toString();
    assert.match(un, /desvinculad/);
    const row = db.prepare("SELECT bongo_user_id, linked_at FROM users WHERE id = ?").get(legacy.id);
    assert.equal(row.bongo_user_id, null);
    assert.equal(row.linked_at, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'identity.unlinked' AND target_user_id = ?").get(legacy.id).n, 1);
    assert.equal((await request(app).get("/v1/me/token").set(P(portal.token))).body.error, "DEVELOPER_ACCOUNT_NOT_PROVISIONED");
    // sem vínculo para desfazer / conta do portal → erro, nada muda
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "identity-unlink.js"), String(legacy.id)], { env, stdio: "pipe" }));
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "identity-unlink.js"), "abc"], { env, stdio: "pipe" }));
  });
});

// ── Auditoria e ausência de segredos ────────────────────────────────────────

describe("auditoria", () => {
  test("eventos presentes: provisão, vínculo (sucesso e falhas com motivo), negação, login", () => {
    const types = (t, o) => db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = ? AND outcome = ?").get(t, o).n;
    assert.ok(types("identity.provisioned", "success") >= 1);
    assert.ok(types("identity.provisioned", "failure") >= 1);
    assert.ok(types("identity.linked", "success") >= 1);
    assert.ok(types("identity.denied", "denied") >= 1);
    assert.ok(types("auth.login", "success") >= 1);
    assert.ok(types("auth.login", "failure") >= 1);
    const reasons = db.prepare("SELECT metadata FROM audit_events WHERE event_type = 'identity.linked' AND outcome = 'failure'").all()
      .map((r) => JSON.parse(r.metadata).reason);
    for (const reason of ["reauth_missing", "reauth_invalid", "bad_legacy_credentials", "portal_already_linked", "account_already_linked"]) {
      assert.ok(reasons.includes(reason), `motivo ausente: ${reason}`);
    }
    const loginFail = db.prepare("SELECT * FROM audit_events WHERE event_type = 'auth.login' AND outcome = 'failure'").get();
    assert.match(loginFail.subject_hash, /^[0-9a-f]{32}$/);
    assert.match(loginFail.ip_prefix, /\/(24|48)$/);
  });

  test("GET /v1/admin/audit: só admin (401 anônimo, 403 usuário, 200 admin) e filtros", async () => {
    assert.equal((await request(app).get("/v1/admin/audit")).status, 401);
    const u = await legacyAccount("comum-audit@test.com");
    assert.equal((await request(app).get("/v1/admin/audit").set("Authorization", `Bearer ${u.jwt}`)).status, 403);
    const adm = await legacyAccount("admin-audit@test.com");
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adm.id);
    const all = await request(app).get("/v1/admin/audit?limit=500").set("Authorization", `Bearer ${adm.jwt}`);
    assert.equal(all.status, 200);
    assert.ok(all.body.events.length > 5);
    const f = await request(app).get("/v1/admin/audit?type=identity.linked&outcome=success").set("Authorization", `Bearer ${adm.jwt}`);
    assert.ok(f.body.events.length >= 1);
    assert.ok(f.body.events.every((e) => e.event_type === "identity.linked" && e.outcome === "success"));
    const page = await request(app).get(`/v1/admin/audit?before=${all.body.events[0].id}&limit=2`).set("Authorization", `Bearer ${adm.jwt}`);
    assert.equal(page.body.events.length, 2);
    assert.ok(page.body.events[0].id < all.body.events[0].id);
  });

  test("nenhum segredo (senha, JWT, chave de API, token do portal/reauth, token de serviço) na auditoria, no banco ou nos logs; nenhum e-mail na auditoria", () => {
    const auditDump = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    const dbDump = dumpDatabase(db);
    const logs = consoleLines.join("\n");
    for (const s of secrets) {
      assert.ok(!auditDump.includes(s), "segredo na auditoria");
      assert.ok(!dbDump.includes(s), "segredo no banco");
      assert.ok(!logs.includes(s), "segredo nos logs");
    }
    assert.doesNotMatch(auditDump, /@/, "e-mail na auditoria");
    assert.doesNotMatch(logs, /@test\.com/, "e-mail nos logs");
  });
});

describe("chave de API de conta criada pelo portal depende da conta do portal", () => {
  test("ativa → vale; desabilitada / sem qrng / excluída → 403 PORTAL_ACCESS_REVOKED; Bongo fora → último estado conhecido", async () => {
    const { user, token } = portalUser();
    assert.equal((await request(app).post("/v1/identity/provision").set(P(token))).status, 201);
    const tk = await request(app).post("/v1/tokens").set(P(token));
    assert.equal(tk.status, 200);
    secrets.add(tk.body.token);
    const K = { Authorization: `Bearer ${tk.body.token}` };
    const usage = () => request(app).get("/v1/me/usage").set(K);
    const random = () => request(app).get("/v1/random?bytes=8").set(K);

    assert.equal((await usage()).status, 200);
    assert.notEqual((await random()).status, 403, "chave aceita (o broker falso está fora, mas a autorização passou)");

    bongo.setAccount(user.id, { exists: true, active: false, qrng: false });
    const denied = await usage();
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "PORTAL_ACCESS_REVOKED");
    assert.equal((await random()).body.error, "PORTAL_ACCESS_REVOKED");

    // Bongo fora: vale o último estado conhecido (negado)
    bongo.state.accountsMode = "down";
    assert.equal((await usage()).status, 403);
    bongo.state.accountsMode = "ok";

    bongo.setAccount(user.id, { exists: true, active: true, qrng: false });
    assert.equal((await usage()).status, 403, "sem o serviço qrng");
    bongo.setAccount(user.id, { exists: true, active: true, qrng: true });
    assert.equal((await usage()).status, 200, "reabilitada → volta a valer");

    // excluída no portal → negada e o e-mail do portal some daqui
    bongo.setAccount(user.id, { exists: false, active: false, qrng: false });
    assert.equal((await usage()).status, 403);
    assert.equal(db.prepare("SELECT portal_email FROM users WHERE bongo_user_id = ?").get(user.id).portal_email, null);
  });

  test("Bongo fora sem estado conhecido → a chave continua valendo (a API não passa a depender do Bongo)", async () => {
    const { token } = portalUser();
    assert.equal((await request(app).post("/v1/identity/provision").set(P(token))).status, 201);
    const tk = await request(app).post("/v1/tokens").set(P(token));
    secrets.add(tk.body.token);
    bongo.state.accountsMode = "down";
    try {
      assert.equal((await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${tk.body.token}`)).status, 200);
    } finally {
      bongo.state.accountsMode = "ok";
    }
  });

  test("conta LEGADA não consulta o estado do portal", async () => {
    const legacy = await legacyAccount(`legado-gate-${Date.now()}@test.com`);
    const before = bongo.state.calls.accounts;
    assert.equal((await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${legacy.apiToken}`)).status, 200);
    assert.equal(bongo.state.calls.accounts, before);
  });
});
