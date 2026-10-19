#!/usr/bin/env node
"use strict";
// Relatório AGREGADO das contas da client-api por origem de identidade
// (doc 155, 2.6). Só contagens — nunca e-mails, ids da client-api nem ids do
// portal. Somente leitura.
//
//   docker exec qrng-client-api node scripts/identity-report.js
//
// Usa o mesmo DB_PATH do serviço. Exige o banco já migrado (v1): o serviço
// aplica a migração ao iniciar.
const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "qrng-tokens.db"), { fileMustExist: true, readonly: true });
const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!cols.includes("bongo_user_id") || !cols.includes("auth_source")) {
  console.error("banco ainda sem a migração v1 (identidade): inicie o serviço uma vez para migrar");
  process.exit(1);
}
const n = (sql) => db.prepare(sql).get().n;
const report = {
  generated_at: new Date().toISOString(),
  total: n("SELECT COUNT(*) n FROM users"),
  legacy_unlinked: n("SELECT COUNT(*) n FROM users WHERE auth_source = 'legacy' AND bongo_user_id IS NULL"),
  legacy_linked: n("SELECT COUNT(*) n FROM users WHERE auth_source = 'legacy' AND bongo_user_id IS NOT NULL"),
  portal_created: n("SELECT COUNT(*) n FROM users WHERE auth_source = 'portal'"),
  with_active_key: n("SELECT COUNT(DISTINCT t.user_id) n FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.status = 'active'"),
  legacy_admins: n("SELECT COUNT(*) n FROM users WHERE auth_source = 'legacy' AND role = 'admin'"),
};
console.log(JSON.stringify(report, null, 2));
