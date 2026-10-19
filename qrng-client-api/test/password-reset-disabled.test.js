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
