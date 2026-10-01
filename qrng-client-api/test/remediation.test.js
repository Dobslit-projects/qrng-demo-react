"use strict";
// Remediação da auditoria de 2026-10-01: saúde pública sem expor o broker,
// fim do sobre-provisionamento 20x, admin só por script, recusa com fonte
// parada, erro sem URL interna, retenção/anonimização de logs e exclusão de
// conta.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const testDbPath = path.join(os.tmpdir(), `qrng-remed-${Date.now()}.db`);
let app, db, checkUpstream, purgeUsageLogs, truncateIp;

// Broker de mentira: registra o que foi pedido e muda de comportamento por modo.
const upstream = { mode: "online", randomCalls: [], sourceStatus: "online" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (upstream.mode === "dead") return req.socket.destroy();
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      buffer_bytes_available: 1000, buffer_capacity: 2000, total_pushed: 10, total_popped: 5,
      source_file: "/tmp/fifo_qrng", source_status: upstream.sourceStatus, source_stall_seconds: upstream.sourceStatus === "offline" ? 120.5 : 0.1,
      stream_format: "uint32-le", sample_width_bytes: 4, conditioned: false,
    }));
  }
  if (u.pathname === "/random") {
    const n = Number(u.searchParams.get("bytes"));
    upstream.randomCalls.push(n);
    const buf = Buffer.alloc(n, 0xab);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": buf.length });
    return res.end(buf);
  }
  res.writeHead(404); res.end();
});

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-for-ci";
  process.env.QRNG_UPSTREAM = `http://127.0.0.1:${server.address().port}`;
  process.env.QRNG_REQUEST_TIMEOUT_MS = "1500";
  process.env.ADMIN_EMAIL = "boss@test.com";        // SEM ALLOW_ADMIN_EMAIL_BOOTSTRAP
  process.env.PUBLIC_HEALTH_TTL_MS = "0";            // sem cache, para alternar modos no teste
  ({ app, db, checkUpstream, purgeUsageLogs, truncateIp } = require("../server"));
});
after(() => {
  try { db.close(); } catch (_) {}
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(testDbPath + s); } catch (_) {} }
  server.close();
});

const request = require("supertest");

async function newAccount(email, password = "senhaForte12345") {
  const reg = await request(app).post("/v1/auth/register").send({ email, password });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const jwt = reg.body.token;
  const tok = await request(app).post("/v1/tokens").set("Authorization", `Bearer ${jwt}`);
  return { jwt, role: reg.body.role, apiToken: tok.body.token, email };
}

// ── Admin só por script ─────────────────────────────────────────────────────

test("cadastro com ADMIN_EMAIL NÃO vira admin sem ALLOW_ADMIN_EMAIL_BOOTSTRAP", async () => {
  const a = await newAccount("boss@test.com");
  assert.equal(a.role, "user");
  const r = await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${a.jwt}`);
  assert.equal(r.status, 403);
});

test("scripts/set-role.js promove uma conta existente; requireAdmin passa a aceitar o MESMO JWT", async () => {
  const a = await newAccount("promovido@test.com");
  db.pragma("wal_checkpoint(TRUNCATE)");
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "set-role.js"), "promovido@test.com", "admin"], { env: { ...process.env, DB_PATH: testDbPath } }).toString();
  assert.match(out, /agora é admin/);
  const r = await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${a.jwt}`);
  assert.equal(r.status, 200);
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "set-role.js"), "naoexiste@test.com", "admin"], { env: { ...process.env, DB_PATH: testDbPath }, stdio: "pipe" }));
});

// ── Saúde pública ───────────────────────────────────────────────────────────

test("/v1/public/health: campos do broker sem source_file, sem auth, no-store", async () => {
  upstream.mode = "online";
  const r = await request(app).get("/v1/public/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.buffer_bytes_available, 1000);
  assert.equal(r.body.source_status, "online");
  assert.equal(r.body.conditioned, false);
  assert.equal("source_file" in r.body, false, "caminho interno não pode vazar");
  assert.match(r.body.request_id, /^req_/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(r.body.provenance_detail, "proveniência presente, como em /v1/health");
  assert.notEqual(r.body.provenance, "live", "sem bytes não há evidência de live");
});

test("/v1/public/health com o broker fora: 503 estruturado, sem URL interna", async () => {
  upstream.mode = "dead";
  const r = await request(app).get("/v1/public/health");
  upstream.mode = "online";
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "QRNG_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(r.body), /127\.0\.0\.1|ECONN|http:\/\//);
});

// ── Sem sobre-provisionamento ───────────────────────────────────────────────

test("public/random e /v1/random pedem ao broker EXATAMENTE o que entregam (fator 1)", async () => {
  upstream.mode = "online"; upstream.randomCalls.length = 0;
  const pub = await request(app).get("/v1/public/random?bytes=64");
  assert.equal(pub.status, 200);
  const a = await newAccount("consumo@test.com");
  const auth = await request(app).get("/v1/random?bytes=128").set("Authorization", `Bearer ${a.apiToken}`);
  assert.equal(auth.status, 200);
  assert.deepEqual(upstream.randomCalls, [64, 128]);
});

// ── Erro sem detalhe interno ────────────────────────────────────────────────

test("503 QRNG_UNAVAILABLE não expõe URL do broker nem erro de socket", async () => {
  upstream.mode = "dead";
  const r = await request(app).get("/v1/public/random?bytes=16");
  upstream.mode = "online";
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "QRNG_UNAVAILABLE");
  assert.equal("detail" in r.body, false);
  assert.doesNotMatch(JSON.stringify(r.body), /127\.0\.0\.1|ECONN|socket|http:\/\//i);
  assert.equal(r.body.provenance_detail.fallback_used, false);
});

// ── Fail-closed de fonte parada ─────────────────────────────────────────────

test("fonte offline segundo o /health do broker → 503 SOURCE_OFFLINE sem consumir bytes; volta quando a fonte volta", async () => {
  upstream.mode = "online"; upstream.sourceStatus = "offline";
  await checkUpstream();
  upstream.randomCalls.length = 0;
  const r = await request(app).get("/v1/public/random?bytes=16");
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "SOURCE_OFFLINE");
  assert.equal(r.body.source_stall_seconds, 120.5);
  assert.notEqual(r.body.provenance, "live");
  assert.deepEqual(upstream.randomCalls, [], "nenhum byte pode ser retirado do buffer");

  upstream.sourceStatus = "degraded"; // parada curta (< 60 s) continua servindo
  await checkUpstream();
  assert.equal((await request(app).get("/v1/public/random?bytes=16")).status, 200);
  upstream.sourceStatus = "online";
  await checkUpstream();
});

// ── Retenção / minimização ──────────────────────────────────────────────────

test("truncateIp: IPv4 → /24, IPv4 mapeado → /24, IPv6 → /48", () => {
  assert.equal(truncateIp("203.0.113.77"), "203.0.113.0/24");
  assert.equal(truncateIp("::ffff:198.51.100.9"), "198.51.100.0/24");
  assert.equal(truncateIp("2804:14d:1:0:181:213:132:4"), "2804:14d:1::/48");
  assert.equal(truncateIp(""), null);
});

test("purgeUsageLogs: apaga > 90 d, anonimiza IP/UA > 7 d, mantém o recente", () => {
  const ins = db.prepare("INSERT INTO api_usage_logs (request_id, token_id, endpoint, bytes_requested, format, status_code, ip_address, user_agent, created_at) VALUES (?,NULL,'/v1/public/random',8,'hex',200,?,?,?)");
  const day = 86400000, now = Date.now();
  ins.run("req_old", "203.0.113.77", "ua-old", new Date(now - 100 * day).toISOString());
  ins.run("req_mid", "203.0.113.77", "ua-mid", new Date(now - 10 * day).toISOString());
  ins.run("req_new", "203.0.113.77", "ua-new", new Date(now - 1 * day).toISOString());
  const r = purgeUsageLogs(now);
  assert.ok(r.deleted >= 1 && r.anonymized >= 1);
  const get = (id) => db.prepare("SELECT ip_address, user_agent FROM api_usage_logs WHERE request_id = ?").get(id);
  assert.equal(get("req_old"), undefined);
  assert.deepEqual(get("req_mid"), { ip_address: "203.0.113.0/24", user_agent: null });
  assert.deepEqual(get("req_new"), { ip_address: "203.0.113.77", user_agent: "ua-new" });
  assert.equal(purgeUsageLogs(now).anonymized, 0, "idempotente");
});

test("tráfego anônimo não cria linhas em daily_usage", async () => {
  const before = db.prepare("SELECT COUNT(*) c FROM daily_usage WHERE token_id IS NULL").get().c;
  await request(app).get("/v1/public/random?bytes=8");
  await request(app).get("/v1/public/random?bytes=8");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM daily_usage WHERE token_id IS NULL").get().c, before);
});

// ── Exclusão de conta ───────────────────────────────────────────────────────

test("DELETE /v1/auth/me: exige a senha; apaga conta e tokens, anonimiza os logs, invalida JWT e token", async () => {
  const a = await newAccount("apagar@test.com");
  await request(app).get("/v1/random?bytes=8").set("Authorization", `Bearer ${a.apiToken}`);
  const uid = db.prepare("SELECT id FROM users WHERE email = 'apagar@test.com'").get().id;
  const tid = db.prepare("SELECT id FROM api_tokens WHERE user_id = ?").get(uid).id;

  const wrong = await request(app).delete("/v1/auth/me").set("Authorization", `Bearer ${a.jwt}`).send({ password: "errada123456" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, "INVALID_PASSWORD");

  const ok = await request(app).delete("/v1/auth/me").set("Authorization", `Bearer ${a.jwt}`).send({ password: "senhaForte12345" });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE id = ?").get(uid).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM api_tokens WHERE user_id = ?").get(uid).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM api_usage_logs WHERE token_id = ?").get(tid).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM daily_usage WHERE token_id = ?").get(tid).c, 0);

  assert.equal((await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${a.jwt}`)).status, 401);
  assert.equal((await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${a.jwt}`)).status, 401);
  assert.equal((await request(app).get("/v1/random?bytes=8").set("Authorization", `Bearer ${a.apiToken}`)).status, 403);
  assert.equal((await request(app).post("/v1/auth/login").send({ email: "apagar@test.com", password: "senhaForte12345" })).status, 401);
});

test("DELETE /v1/admin/users/:id: só admin; não apaga a si mesmo; 404 para inexistente", async () => {
  const admin = await newAccount("chefe@test.com");
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'chefe@test.com'").run();
  const adminId = db.prepare("SELECT id FROM users WHERE email = 'chefe@test.com'").get().id;
  const victim = await newAccount("alvo@test.com");
  const victimId = db.prepare("SELECT id FROM users WHERE email = 'alvo@test.com'").get().id;

  assert.equal((await request(app).delete(`/v1/admin/users/${adminId}`).set("Authorization", `Bearer ${victim.jwt}`)).status, 403);
  assert.equal((await request(app).delete(`/v1/admin/users/${adminId}`).set("Authorization", `Bearer ${admin.jwt}`)).status, 400);
  assert.equal((await request(app).delete("/v1/admin/users/999999").set("Authorization", `Bearer ${admin.jwt}`)).status, 404);
  assert.equal((await request(app).delete(`/v1/admin/users/${victimId}`).set("Authorization", `Bearer ${admin.jwt}`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE id = ?").get(victimId).c, 0);
});
