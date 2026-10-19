#!/usr/bin/env node
"use strict";
// Atendimento do SUPORTE enquanto a recuperação por e-mail está desligada
// (doc 155). Gera, para UMA conta antiga de desenvolvedor da API, um link de
// redefinição de uso único — o mesmo que o e-mail levaria — e o imprime UMA
// vez no terminal do operador, para entrega por um canal já verificado com a
// pessoa (nunca colar em chat público, ticket ou log).
//
//   docker exec -it qrng-client-api node scripts/issue-legacy-reset-link.js <e-mail-da-conta>
//
// Igual ao fluxo normal: 32 bytes do CSPRNG do sistema, só o SHA-256 no banco,
// validade QRNG_RESET_TOKEN_TTL_MINUTES (30), links anteriores invalidados, uso
// único; a confirmação na página pública /redefinir-senha-api troca a senha,
// revoga os JWTs antigos e desfaz um vínculo com o portal. Registra
// `admin.password_reset.manual_link` na auditoria (sem o link).
// Antes de rodar: confirmar a identidade da pessoa por um canal independente.
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { createAudit } = require("../lib/audit");

const [, , rawEmail] = process.argv;
const email = String(rawEmail || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("uso: node scripts/issue-legacy-reset-link.js <e-mail-da-conta-antiga>");
  process.exit(2);
}
const ttl = (() => {
  const n = parseInt(process.env.QRNG_RESET_TOKEN_TTL_MINUTES || "30", 10);
  return Number.isInteger(n) && n >= 1 && n <= 24 * 60 ? n : 30;
})();
const base = process.env.QRNG_PASSWORD_RESET_URL || "https://bongo.dobslit.com/redefinir-senha-api";

const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "qrng-tokens.db"), { fileMustExist: true });
const user = db.prepare("SELECT id, email FROM users WHERE email = ? AND auth_source = 'legacy' AND password_hash IS NOT NULL").get(email);
if (!user) {
  console.error("nenhuma conta antiga de desenvolvedor (com senha local) com este e-mail — nada feito");
  process.exit(1);
}
const audit = createAudit(db, { pseudonymKey: process.env.AUDIT_PSEUDONYM_KEY || null });
const raw = crypto.randomBytes(32).toString("base64url");
const now = new Date();
const expiresAt = new Date(now.getTime() + ttl * 60 * 1000).toISOString();
let invalidated = 0;
db.transaction(() => {
  invalidated = db.prepare("UPDATE password_reset_tokens SET invalidated_at = ? WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL")
    .run(now.toISOString(), user.id).changes;
  db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at, requested_ip_prefix, sent_to_hash)
              VALUES (?, ?, ?, ?, NULL, ?)`)
    .run(user.id, crypto.createHash("sha256").update(raw).digest("hex"), expiresAt, now.toISOString(), audit.subjectHash(user.email));
  if (!audit.record({ type: "admin.password_reset.manual_link", outcome: "success", targetUserId: user.id,
    metadata: { via: "script", ttl_minutes: ttl, previous_invalidated: invalidated } })) {
    throw new Error("não foi possível registrar a auditoria");
  }
})();
console.log(`conta ${user.id}: link de redefinição válido até ${expiresAt} (uso único; ${invalidated} link(s) anterior(es) invalidado(s)).`);
console.log("Entregue SÓ por canal verificado com a pessoa; não registre em chat, ticket ou log:");
console.log(`${base}#token=${raw}`);
