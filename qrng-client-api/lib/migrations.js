"use strict";

/**
 * Migrações versionadas do banco da client-api (doc 155, seção 6).
 *
 * O bloco `CREATE TABLE IF NOT EXISTS` + `try ALTER` de server.js continua
 * sendo a "linha de base" (idempotente, igual ao esquema de produção). As
 * migrações daqui em diante são NUMERADAS, cada uma roda numa transação e é
 * registrada em `schema_migrations` ao final; reaplicar é no-op.
 *
 * v1 — identidade integrada, recuperação de senha legada e auditoria:
 *   - `users` reconstruída (ver doc 155, 2.3) preservando id, email,
 *     password_hash, role, created_at e a sequência AUTOINCREMENT
 *     (sqlite_sequence fica com o MAIOR entre o `seq` antigo e max(id): um id
 *     de conta excluída nunca é reutilizado);
 *   - tabelas novas `password_reset_tokens` e `audit_events`;
 *   - verificação pós-migração DENTRO da transação: mesma contagem de
 *     usuários, mesmas tuplas (id,email,password_hash,role,created_at), e
 *     api_tokens / daily_usage / api_usage_logs com a mesma contagem. Qualquer
 *     divergência lança e a transação inteira é desfeita.
 *
 * Nenhuma migração marca e-mail como verificado. Rollback de CÓDIGO não exige
 * reverter o banco (o código antigo ignora as colunas novas e o login por
 * e-mail não encontra linhas com e-mail NULL); reverter o BANCO só por
 * restauração de backup, nunca automaticamente.
 */

const USERS_V1_DDL = `
  CREATE TABLE users__v1 (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT    UNIQUE,
    password_hash       TEXT,
    role                TEXT    NOT NULL DEFAULT 'user',
    created_at          TEXT    NOT NULL,
    bongo_user_id       TEXT    UNIQUE,
    auth_source         TEXT    NOT NULL DEFAULT 'legacy' CHECK (auth_source IN ('legacy','portal')),
    linked_at           TEXT,
    portal_email        TEXT,
    password_changed_at TEXT,
    last_login_at       TEXT
  )`;

function usersSnapshot(db) {
  return JSON.stringify(db.prepare("SELECT id, email, password_hash, role, created_at FROM users ORDER BY id").all());
}

function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function migrationV1(db) {
  const before = {
    users: usersSnapshot(db),
    count: countOf(db, "users"),
    tokens: countOf(db, "api_tokens"),
    daily: countOf(db, "daily_usage"),
    logs: countOf(db, "api_usage_logs"),
    tokensHash: JSON.stringify(db.prepare("SELECT * FROM api_tokens ORDER BY id").all()),
  };
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get();
  const oldSeq = seqRow ? Number(seqRow.seq) : 0;
  const maxId = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM users").get().m);

  db.exec(USERS_V1_DDL);
  db.exec(`INSERT INTO users__v1 (id, email, password_hash, role, created_at, auth_source)
           SELECT id, email, password_hash, role, created_at, 'legacy' FROM users ORDER BY id`);
  db.exec("DROP TABLE users");
  db.exec("ALTER TABLE users__v1 RENAME TO users");

  // AUTOINCREMENT: o próximo id nunca pode ser menor do que já foi emitido.
  const target = Math.max(oldSeq, maxId);
  if (target > 0) {
    const upd = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'").run(target);
    if (upd.changes === 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)").run(target);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      token_hash          TEXT    NOT NULL UNIQUE,
      expires_at          TEXT    NOT NULL,
      used_at             TEXT,
      invalidated_at      TEXT,
      created_at          TEXT    NOT NULL,
      requested_ip_prefix TEXT,
      sent_to_hash        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id);

    CREATE TABLE IF NOT EXISTS audit_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at    TEXT    NOT NULL,
      event_type     TEXT    NOT NULL,
      outcome        TEXT    NOT NULL CHECK (outcome IN ('success','failure','denied')),
      actor_user_id  INTEGER,
      target_user_id INTEGER,
      request_id     TEXT,
      ip_prefix      TEXT,
      subject_hash   TEXT,
      metadata       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events (event_type);
  `);

  // ── Verificação pós-migração (lança → ROLLBACK da transação inteira) ──
  const after = {
    users: usersSnapshot(db),
    count: countOf(db, "users"),
    tokens: countOf(db, "api_tokens"),
    daily: countOf(db, "daily_usage"),
    logs: countOf(db, "api_usage_logs"),
    tokensHash: JSON.stringify(db.prepare("SELECT * FROM api_tokens ORDER BY id").all()),
  };
  for (const k of Object.keys(before)) {
    if (before[k] !== after[k]) throw new Error(`migração v1: verificação pós-migração falhou (${k} divergente)`);
  }
  const newSeqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get();
  const newSeq = newSeqRow ? Number(newSeqRow.seq) : 0;
  if (newSeq < target) throw new Error("migração v1: sqlite_sequence de users ficou menor que o anterior");
}

const MIGRATIONS = [
  { version: 1, name: "identity_reset_audit", up: migrationV1 },
];

/**
 * Aplica as migrações pendentes, em ordem. Devolve a lista de versões
 * aplicadas nesta chamada ([] quando já estava tudo aplicado).
 */
/**
 * Cópia consistente do banco ANTES de aplicar migrações pendentes
 * (`VACUUM INTO`, funciona com o banco aberto e em WAL). Gravada ao lado do
 * banco como `<arquivo>.pre-migration-v<N>-<data>.bak`. Se a cópia falhar, a
 * migração NÃO roda (o processo não sobe) — melhor parar do que migrar sem
 * volta. Banco em memória: nada a copiar. `MIGRATION_BACKUP=off` desliga
 * (só para quem já fez a cópia por fora). A cópia contém hashes de senha,
 * e-mails e chaves (hash): trate como o próprio banco e apague quando não
 * precisar mais. → caminho da cópia, ou null.
 */
function backupBeforeMigrations(db, pendingVersions, { env = process.env, now = () => new Date() } = {}) {
  if (!pendingVersions.length) return null;
  const file = db.name;
  if (db.memory || !file || file === ":memory:") return null;
  if (String(env.MIGRATION_BACKUP || "").toLowerCase() === "off") {
    console.warn(`[migrações] MIGRATION_BACKUP=off: aplicando v${pendingVersions.join(",v")} SEM cópia prévia.`);
    return null;
  }
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.pre-migration-v${pendingVersions[0]}-${stamp}.bak`;
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } catch (err) {
    throw new Error(`[migrações] cópia prévia falhou (${(err && (err.code || err.message)) || "erro"}); migração NÃO aplicada. Destino: ${dest}`);
  }
  console.log(`[migrações] cópia prévia gravada em ${dest} (antes de v${pendingVersions.join(",v")})`);
  return dest;
}

function runMigrations(db, { now = () => new Date().toISOString(), env = process.env, backupNow } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  )`);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  backupBeforeMigrations(db, MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version),
    { env, now: backupNow });
  const done = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, now());
    })();
    done.push(m.version);
  }
  return done;
}

module.exports = { runMigrations, backupBeforeMigrations, MIGRATIONS };
