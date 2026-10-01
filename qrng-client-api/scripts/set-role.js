#!/usr/bin/env node
"use strict";
// Define o papel de uma conta existente (admin | user). É o único caminho de
// promoção em produção — o cadastro nunca concede admin.
//
//   docker exec qrng-client-api node scripts/set-role.js alguem@exemplo.com admin
//
// Usa o mesmo DB_PATH do serviço.
const path = require("path");
const Database = require("better-sqlite3");

const [, , email, role] = process.argv;
if (!email || !["admin", "user"].includes(role)) {
  console.error("uso: node scripts/set-role.js <email> <admin|user>");
  process.exit(2);
}
const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "qrng-tokens.db"), { fileMustExist: true });
const info = db.prepare("UPDATE users SET role = ? WHERE email = ?").run(role, email.toLowerCase());
if (info.changes !== 1) {
  console.error(`conta não encontrada: ${email} (cadastre-a primeiro pela API)`);
  process.exit(1);
}
console.log(`ok: ${email.toLowerCase()} agora é ${role}`);
