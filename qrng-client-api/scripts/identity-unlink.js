#!/usr/bin/env node
"use strict";
// Desvincula uma conta LEGADA da identidade do portal (doc 155, 2.6). Uso
// administrativo excepcional — não existe rota HTTP para isso. A conta volta a
// ser só legada: id, e-mail/senha, chaves, cota e histórico continuam iguais.
// Registra o evento `identity.unlinked` na auditoria.
//
//   docker exec qrng-client-api node scripts/identity-unlink.js <id-da-conta-na-client-api>
//
// Contas criadas pelo portal (auth_source=portal) NÃO são desvinculadas: sem
// e-mail/senha locais ficariam sem nenhuma forma de login.
const path = require("path");
const Database = require("better-sqlite3");
const { createAudit } = require("../lib/audit");

const [, , rawId] = process.argv;
const id = Number(rawId);
if (!rawId || !Number.isInteger(id) || id < 1) {
  console.error("uso: node scripts/identity-unlink.js <id-da-conta-na-client-api>");
  process.exit(2);
}
const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "qrng-tokens.db"), { fileMustExist: true });
const row = db.prepare("SELECT id, auth_source, bongo_user_id FROM users WHERE id = ?").get(id);
if (!row) {
  console.error(`conta ${id} não encontrada`);
  process.exit(1);
}
if (row.auth_source !== "legacy") {
  console.error(`conta ${id} foi criada pelo portal (sem login local): desvincular a deixaria inacessível — nada feito`);
  process.exit(1);
}
if (!row.bongo_user_id) {
  console.error(`conta ${id} não está vinculada — nada feito`);
  process.exit(1);
}
const audit = createAudit(db, { pseudonymKey: process.env.AUDIT_PSEUDONYM_KEY || null });
db.transaction(() => {
  const info = db.prepare(`
    UPDATE users SET bongo_user_id = NULL, linked_at = NULL, portal_email = NULL
    WHERE id = ? AND auth_source = 'legacy' AND bongo_user_id IS NOT NULL
  `).run(id);
  if (info.changes !== 1) throw new Error("a conta mudou durante a operação");
  if (!audit.record({ type: "identity.unlinked", outcome: "success", targetUserId: id, metadata: { via: "script" } })) {
    throw new Error("não foi possível registrar a auditoria");
  }
})();
console.log(`ok: conta ${id} desvinculada do portal (login legado, chaves e histórico mantidos)`);
