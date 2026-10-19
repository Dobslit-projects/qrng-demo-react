"use strict";
// Migração v1 da client-api (doc 155, 2.3 e 6) a partir do esquema EXATO de
// produção (server.js linha de base = volume /data/qrng-tokens.db): ids com
// lacunas, sqlite_sequence acima do max(id) (contas excluídas), tokens e uso.
// Verifica: ids/hashes/papéis intactos, sequência nunca rebaixada, tokens e
// uso intocados, idempotência e compatibilidade com o código antigo.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const { runMigrations } = require("../lib/migrations");

// DDL de produção (server.js até 6a8d5bc / bcb5052), com quota_daily DEFAULT 10000 já interpolado.
const PRODUCTION_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER,
    token_prefix   TEXT    NOT NULL,
    token_hash     TEXT    NOT NULL UNIQUE,
    name           TEXT    DEFAULT 'Token principal',
    status         TEXT    DEFAULT 'active',
    quota_daily    INTEGER DEFAULT 10000,
    created_at     TEXT    NOT NULL,
    last_used_at   TEXT,
    revoked_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS api_usage_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id      TEXT    NOT NULL,
    token_id        INTEGER,
    endpoint        TEXT,
    bytes_requested INTEGER DEFAULT 0,
    format          TEXT,
    status_code     INTEGER,
    ip_address      TEXT,
    user_agent      TEXT,
    duration_ms     INTEGER,
    created_at      TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_usage (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id       INTEGER,
    date           TEXT    NOT NULL,
    requests_count INTEGER DEFAULT 0,
    bytes_count    INTEGER DEFAULT 0,
    errors_count   INTEGER DEFAULT 0,
    UNIQUE(token_id, date)
  );
  CREATE TABLE IF NOT EXISTS upstream_health_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    status      TEXT    NOT NULL,
    response_ms INTEGER,
    detail      TEXT,
    checked_at  TEXT    NOT NULL
  );
`;

const testDbPath = path.join(os.tmpdir(), `qrng-migr-${Date.now()}.db`);
const PASSWORD = "senhaDeProducao2026";
const RAW_KEY = `dobslit_qrng_live_${"ab".repeat(20)}`;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
let app, db, snapshot;

function snap(d) {
  const all = (sql) => d.prepare(sql).all();
  return {
    users: JSON.stringify(all("SELECT id, email, password_hash, role, created_at FROM users ORDER BY id")),
    tokens: JSON.stringify(all("SELECT * FROM api_tokens ORDER BY id")),
    daily: JSON.stringify(all("SELECT * FROM daily_usage ORDER BY id")),
    logs: JSON.stringify(all("SELECT * FROM api_usage_logs ORDER BY id")),
    health: JSON.stringify(all("SELECT * FROM upstream_health_log ORDER BY id")),
  };
}

before(() => {
  const d = new Database(testDbPath);
  d.pragma("journal_mode = WAL");
  d.exec(PRODUCTION_DDL);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const insUser = d.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)");
  // lacunas (3, 4, 6–8 excluídos) e sequência em 12 (10–12 excluídos)
  insUser.run(1, "dono@test.com", hash, "admin", "2026-08-01T10:00:00.000Z");
  insUser.run(2, "dev-a@test.com", hash, "user", "2026-08-02T10:00:00.000Z");
  insUser.run(5, "dev-b@test.com", bcrypt.hashSync("outraSenha12345", 4), "user", "2026-08-05T10:00:00.000Z");
  insUser.run(9, "dev-c@test.com", hash, "user", "2026-09-09T10:00:00.000Z");
  d.prepare("UPDATE sqlite_sequence SET seq = 12 WHERE name = 'users'").run();
  const insTok = d.prepare("INSERT INTO api_tokens (id, user_id, token_prefix, token_hash, name, status, quota_daily, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insTok.run(3, 2, RAW_KEY.slice(0, 28), sha(RAW_KEY), "Token principal", "active", 777, "2026-08-02T11:00:00.000Z", "2026-10-01T00:00:00.000Z", null);
  insTok.run(4, 5, "dobslit_qrng_live_revoked00", sha("revogado"), "Token principal", "revoked", 10000, "2026-08-05T11:00:00.000Z", null, "2026-09-01T00:00:00.000Z");
  insTok.run(7, null, "dobslit_qrng_live_orfao0000", sha("orfao"), "Token principal", "active", 10000, "2026-07-01T00:00:00.000Z", null, null);
  d.prepare("INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count) VALUES (3, '2026-10-01', 42, 4200, 2)").run();
  d.prepare("INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count) VALUES (3, '2026-10-02', 1, 32, 0)").run();
  d.prepare(`INSERT INTO api_usage_logs (request_id, token_id, endpoint, bytes_requested, format, status_code, ip_address, user_agent, duration_ms, created_at)
             VALUES ('req_prod_00000001', 3, '/v1/random', 32, 'hex', 200, '198.51.100.0/24', NULL, 12, '2026-10-01T12:00:00.000Z')`).run();
  d.prepare("INSERT INTO upstream_health_log (status, response_ms, detail, checked_at) VALUES ('up', 5, NULL, '2026-10-01T00:00:00.000Z')").run();
  snapshot = snap(d);
  d.close();

  process.env.DB_PATH = testDbPath;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-for-ci";
  process.env.RATE_LIMIT_PER_IP_PER_MINUTE = "100000";
  ({ app, db } = require("../server")); // o require aplica a migração
});
after(() => {
  try { db.close(); } catch (_) {}
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(testDbPath + s); } catch (_) {} }
});

describe("migração v1 sobre o banco de produção", () => {
  test("registrada em schema_migrations; users com as colunas novas; tabelas novas existem", () => {
    const m = db.prepare("SELECT * FROM schema_migrations").all();
    assert.deepEqual(m.map((r) => r.version), [1]);
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    assert.deepEqual(cols, ["id", "email", "password_hash", "role", "created_at", "bongo_user_id", "auth_source",
      "linked_at", "portal_email", "password_changed_at", "last_login_at"]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ["password_reset_tokens", "audit_events", "schema_migrations"]) assert.ok(tables.includes(t), t);
    assert.ok(!tables.includes("users__v1"), "tabela temporária ficou para trás");
  });

  test("ids, e-mails, hashes, papéis e datas idênticos; todas as contas legadas e não vinculadas", () => {
    assert.equal(snap(db).users, snapshot.users);
    const rows = db.prepare("SELECT auth_source, bongo_user_id, linked_at, password_changed_at FROM users").all();
    assert.equal(rows.length, 4);
    for (const r of rows) assert.deepEqual(r, { auth_source: "legacy", bongo_user_id: null, linked_at: null, password_changed_at: null });
  });

  test("tokens, cotas, uso e histórico intocados", () => {
    const now = snap(db);
    for (const k of ["tokens", "daily", "logs", "health"]) assert.equal(now[k], snapshot[k], k);
  });

  test("sqlite_sequence não foi rebaixada: próximo cadastro recebe id 13 (nunca reutiliza 10–12)", async () => {
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq, 12);
    const r = await request(app).post("/v1/auth/register").send({ email: "novo-pos-migracao@test.com", password: "senhaNovaConta123" });
    assert.equal(r.status, 200);
    assert.equal(db.prepare("SELECT id FROM users WHERE email = ?").get("novo-pos-migracao@test.com").id, 13);
  });

  test("login, chave de API, cota e histórico continuam funcionando depois da migração", async () => {
    const login = await request(app).post("/v1/auth/login").send({ email: "dev-a@test.com", password: PASSWORD });
    assert.equal(login.status, 200);
    const me = await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${login.body.token}`);
    assert.equal(me.body.id, 2);
    const usage = await request(app).get("/v1/me/usage").set("Authorization", `Bearer ${RAW_KEY}`);
    assert.equal(usage.status, 200);
    assert.equal(usage.body.quota_daily_requests, 777);
    assert.ok(usage.body.daily_history.some((h) => h.date === "2026-10-01" && h.requests_count === 42));
    const reqs = await request(app).get("/v1/me/requests").set("Authorization", `Bearer ${login.body.token}`);
    assert.ok(reqs.body.requests.some((x) => x.request_id === "req_prod_00000001"));
  });

  test("idempotente: reaplicar não muda nada (nem a sequência)", () => {
    const before = { ...snap(db), seq: db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq };
    assert.deepEqual(runMigrations(db), []);
    const after = { ...snap(db), seq: db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq };
    assert.deepEqual(after, before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, 1);
  });

  test("código antigo (bcb5052/6a8d5bc) continua funcionando sobre o esquema novo", () => {
    // mesmas instruções que o server.js antigo executa
    const old = new Database(testDbPath);
    try {
      old.exec(PRODUCTION_DDL); // CREATE TABLE IF NOT EXISTS: no-op
      const info = old.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
        .run("codigo-antigo@test.com", bcrypt.hashSync("x", 4), "user", new Date().toISOString());
      assert.ok(Number(info.lastInsertRowid) > 13);
      const u = old.prepare("SELECT * FROM users WHERE email = ?").get("codigo-antigo@test.com");
      assert.equal(u.auth_source, "legacy");
      assert.ok(old.prepare("SELECT 1 FROM users WHERE id = ?").get(2));
      assert.equal(old.prepare("SELECT * FROM users WHERE email = ?").get(null), undefined);
    } finally { old.close(); }
  });
});

describe("migração v1 — casos de borda da sequência (banco em memória)", () => {
  function freshProd() {
    const d = new Database(":memory:");
    d.exec(PRODUCTION_DDL);
    return d;
  }

  test("tabela vazia com seq=7 (todos excluídos) → seq continua 7, próximo id 8", () => {
    const d = freshProd();
    d.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('x@test.com', 'h', 'user', 'agora')").run();
    d.prepare("DELETE FROM users").run();
    d.prepare("UPDATE sqlite_sequence SET seq = 7 WHERE name = 'users'").run();
    assert.deepEqual(runMigrations(d), [1]);
    assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq, 7);
    const id = d.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('y@test.com', 'h', 'user', 'agora')").run().lastInsertRowid;
    assert.equal(Number(id), 8);
    d.close();
  });

  test("banco novo (sem nenhuma linha) → migra, sem sequência inventada, primeiro id 1", () => {
    const d = freshProd();
    assert.deepEqual(runMigrations(d), [1]);
    const id = d.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES ('z@test.com', 'h', 'user', 'agora')").run().lastInsertRowid;
    assert.equal(Number(id), 1);
    d.close();
  });

  test("seq abaixo de max(id) (sequência danificada) → passa a max(id)", () => {
    const d = freshProd();
    d.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (20, 'w@test.com', 'h', 'user', 'agora')").run();
    d.prepare("UPDATE sqlite_sequence SET seq = 3 WHERE name = 'users'").run();
    runMigrations(d);
    assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq, 20);
    d.close();
  });

  test("contas do portal (email/senha NULL) não colidem entre si nem com legadas; bongo_user_id é único", () => {
    const d = freshProd();
    runMigrations(d);
    const ins = d.prepare("INSERT INTO users (email, password_hash, role, created_at, bongo_user_id, auth_source) VALUES (NULL, NULL, 'user', 'agora', ?, 'portal')");
    ins.run("uuid-1");
    ins.run("uuid-2");
    assert.throws(() => ins.run("uuid-1"), /UNIQUE/);
    assert.throws(() => d.prepare("INSERT INTO users (email, role, created_at, auth_source) VALUES ('a@test.com', 'user', 'agora', 'outro')").run(), /CHECK/);
    d.close();
  });
});

describe("cópia consistente antes de migrar", () => {
  const { backupBeforeMigrations } = require("../lib/migrations");
  function prodFileDb(dir, name) {
    const db = new Database(path.join(dir, name));
    db.pragma("journal_mode = WAL");
    db.exec(PRODUCTION_DDL);
    db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'hash', 'user', '2026-01-01T00:00:00Z')")
      .run(`${name}@example.com`);
    return db;
  }
  const baksIn = (dir, prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.includes(".pre-migration-v1-"));
  const fixed = () => new Date("2026-10-18T12:00:00.000Z");
  const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };

  test("grava a cópia (esquema ANTERIOR) antes de v1; sem pendências, sem cópia nova; memória → nada", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrng-mig-"));
    try {
      const db = prodFileDb(dir, "a.db");
      quiet(() => runMigrations(db, { env: {}, backupNow: fixed }));
      const baks = baksIn(dir, "a.db");
      assert.equal(baks.length, 1);
      const copy = new Database(path.join(dir, baks[0]), { readonly: true });
      assert.equal(copy.prepare("SELECT COUNT(*) AS c FROM users").get().c, 1);
      assert.equal(copy.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "bongo_user_id"), false);
      copy.close();
      assert.deepEqual(quiet(() => runMigrations(db, { env: {}, backupNow: () => new Date("2026-10-18T13:00:00.000Z") })), []);
      assert.equal(baksIn(dir, "a.db").length, 1);
      db.close();
      assert.equal(backupBeforeMigrations(new Database(":memory:"), [1]), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cópia que falha bloqueia a migração; MIGRATION_BACKUP=off pula", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrng-mig-"));
    const ow = console.warn;
    try {
      const db = prodFileDb(dir, "b.db");
      fs.writeFileSync(path.join(dir, `b.db.pre-migration-v1-${fixed().toISOString().replace(/[:.]/g, "-")}.bak`), "ocupado");
      assert.throws(() => runMigrations(db, { env: {}, backupNow: fixed }), /cópia prévia falhou/);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c, 0);
      assert.equal(db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "bongo_user_id"), false);
      db.close();
      const off = prodFileDb(dir, "c.db");
      console.warn = () => {};
      assert.deepEqual(runMigrations(off, { env: { MIGRATION_BACKUP: "off" } }), [1]);
      assert.equal(baksIn(dir, "c.db").length, 0);
      off.close();
    } finally {
      console.warn = ow;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
