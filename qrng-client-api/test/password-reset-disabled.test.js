"use strict";
// Modo PADRÃO sem e-mail (doc 155): a recuperação self-service das contas
// legadas fica explicitamente indisponível. Nada é gerado nem enfileirado,
// a resposta é a mesma para qualquer e-mail e o resto da conta legada
// (login, chave de API) segue funcionando.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const request = require("supertest");
const { execFileSync } = require("node:child_process");
const { createFakeBongo } = require("../test-support/fake-bongo");

const SERVICE_TOKEN = "test-internal-service-token-reset-off";
const testDbPath = path.join(os.tmpdir(), `qrng-reset-off-${Date.now()}.db`);
const bongo = createFakeBongo({ serviceToken: SERVICE_TOKEN });
let app, db, waitForBackgroundJobs;

before(async () => {
  const url = await bongo.listen();
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-for-ci";
  process.env.BONGO_INTERNAL_URL = url;
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.RATE_LIMIT_PER_IP_PER_MINUTE = "100000";
  process.env.QRNG_UPSTREAM = "http://127.0.0.1:9";
  delete process.env.QRNG_PASSWORD_RESET_ENABLED; // padrão = desligado
  ({ app, db, waitForBackgroundJobs } = require("../server"));
});
after(async () => {
  try { db.close(); } catch (_) {}
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(path.basename(testDbPath)))) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
  }
  await bongo.close();
});

test("padrão sem e-mail: status self_service=false; pedido → 503 igual para qualquer e-mail; nada gerado nem enfileirado", async () => {
  const email = "legado-sem-email@test.com";
  const password = "senhaLegada123456";
  const reg = await request(app).post("/v1/auth/register").send({ email, password });
  assert.equal(reg.status, 200);

  const st = await request(app).get("/v1/auth/password-reset/status");
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { self_service: false });
  assert.equal(st.headers["cache-control"], "no-store");

  const mailsBefore = bongo.state.calls.mail;
  const a = await request(app).post("/v1/auth/password-reset/request").send({ email });
  const b = await request(app).post("/v1/auth/password-reset/request").send({ email: "ninguem@test.com" });
  await waitForBackgroundJobs();
  assert.equal(a.status, 503);
  assert.equal(a.body.error, "PASSWORD_RESET_UNAVAILABLE");
  assert.deepEqual(b.body, a.body, "não enumera");
  assert.equal(/enviamos|enviaremos/i.test(a.body.message), false, "não promete envio");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM password_reset_tokens").get().n, 0);
  assert.equal(bongo.state.calls.mail, mailsBefore, "nada enfileirado no Bongo");

  // verificar/confirmar continuam respondendo (sem token válido possível)
  const chk = await request(app).post("/v1/auth/password-reset/check").send({ token: crypto.randomBytes(32).toString("base64url") });
  assert.deepEqual(chk.body, { valid: false });

  // o resto da conta legada segue igual
  const login = await request(app).post("/v1/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const tok = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${login.body.token}`);
  assert.equal(tok.status, 200);
  assert.equal((await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${tok.body.token}`)).status, 200);
});

test("suporte com a recuperação desligada: o script gera um link de uso único que a página pública confirma", async () => {
  const email = "legado-suporte@test.com";
  const password = "senhaAntigaSuporte123";
  assert.equal((await request(app).post("/v1/auth/register").send({ email, password })).status, 200);
  const env = { ...process.env, DB_PATH: testDbPath, QRNG_PASSWORD_RESET_URL: "https://portal.test/redefinir-senha-api" };
  const script = path.join(__dirname, "..", "scripts", "issue-legacy-reset-link.js");
  const out1 = execFileSync(process.execPath, [script, email], { env }).toString();
  const out2 = execFileSync(process.execPath, [script, email], { env }).toString();
  const link1 = out1.match(/https:\/\/portal\.test\/redefinir-senha-api#token=([A-Za-z0-9_-]{43})/);
  const link2 = out2.match(/https:\/\/portal\.test\/redefinir-senha-api#token=([A-Za-z0-9_-]{43})/);
  assert.ok(link1 && link2, "o script imprime o link");
  assert.match(out2, /1 link\(s\) anterior\(es\) invalidado\(s\)/);
  // só o hash no banco
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM password_reset_tokens").all()).includes(link2[1]), false);
  // o primeiro link morreu com o segundo
  assert.deepEqual((await request(app).post("/v1/auth/password-reset/check").send({ token: link1[1] })).body, { valid: false });
  const newPassword = "senhaNovaPeloSuporte456";
  const ok = await request(app).post("/v1/auth/password-reset/confirm").send({ token: link2[1], password: newPassword });
  assert.equal(ok.status, 200);
  assert.equal((await request(app).post("/v1/auth/login").send({ email, password })).status, 401);
  assert.equal((await request(app).post("/v1/auth/login").send({ email, password: newPassword })).status, 200);
  assert.equal((await request(app).post("/v1/auth/password-reset/confirm").send({ token: link2[1], password: "outraSenha789xyz" })).status, 400, "uso único");
  const ev = db.prepare("SELECT event_type, metadata FROM audit_events WHERE event_type = 'admin.password_reset.manual_link'").all();
  assert.equal(ev.length, 2);
  assert.equal(JSON.stringify(ev).includes(link2[1]), false, "o link não vai para a auditoria");
  // conta inexistente / criada pelo portal: nada feito
  assert.throws(() => execFileSync(process.execPath, [script, "ninguem@test.com"], { env, stdio: "pipe" }));
  // a recuperação self-service continua desligada
  assert.deepEqual((await request(app).get("/v1/auth/password-reset/status")).body, { self_service: false });
});
