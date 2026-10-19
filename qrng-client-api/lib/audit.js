"use strict";

/**
 * Trilha de auditoria da client-api (doc 155, seção 5).
 *
 * Tabela `audit_events` (criada pela migração v1). Regras:
 *   - NUNCA entram: senha, JWT, token de recuperação/reauth, link, chave de API
 *     completa, e-mail completo. `metadata` só aceita as chaves de
 *     ALLOWED_METADATA_KEYS, com valores escalares curtos — qualquer outra
 *     chave é descartada em silêncio (defesa contra um chamador descuidado).
 *   - `subject_hash` = HMAC-SHA256(AUDIT_PSEUDONYM_KEY, e-mail normalizado),
 *     32 hex, para correlacionar tentativas anônimas/falhas sem gravar o
 *     endereço. Sem a chave, fica NULL (um SHA-256 puro de e-mail seria
 *     reversível por dicionário).
 *   - `ip_prefix`: IPv4 /24, IPv6 /48 (mesma função dos registros de uso).
 *   - Gravar um evento nunca derruba a requisição: falha de escrita vira uma
 *     linha de log SEM os dados do evento.
 */

const crypto = require("crypto");

const OUTCOMES = new Set(["success", "failure", "denied"]);

const ALLOWED_METADATA_KEYS = new Set([
  "reason", "delivered_to_queue", "auth_mode", "portal_user_id", "token_id",
  "quota_before", "quota_after", "via", "account_found", "auth_source",
]);

function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!ALLOWED_METADATA_KEYS.has(k)) continue;
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ pseudonymKey?: string|null, retentionDays?: number, truncateIp?: (ip:string)=>string|null,
 *           dedupWindowMs?: number }} opts
 */
function createAudit(db, opts = {}) {
  const pseudonymKey = opts.pseudonymKey || null;
  // Só inteiro positivo; qualquer outro valor volta para 365 (um negativo
  // apagaria a auditoria inteira na retenção).
  const retentionDays = Number.isInteger(opts.retentionDays) && opts.retentionDays >= 1 ? opts.retentionDays : 365;
  const truncateIp = opts.truncateIp || (() => null);
  const dedupWindowMs = opts.dedupWindowMs || 10 * 60 * 1000;
  const dedup = new Map(); // chave → expira em (ms)

  const insert = db.prepare(`
    INSERT INTO audit_events
      (occurred_at, event_type, outcome, actor_user_id, target_user_id, request_id, ip_prefix, subject_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function subjectHash(email) {
    if (!pseudonymKey || !email) return null;
    return crypto.createHmac("sha256", pseudonymKey).update(normalizeEmail(email)).digest("hex").slice(0, 32);
  }

  /**
   * @param {{ type: string, outcome: "success"|"failure"|"denied", actorUserId?: number|null,
   *           targetUserId?: number|null, req?: object, subjectEmail?: string|null, metadata?: object }} ev
   */
  function record(ev) {
    try {
      if (!ev || typeof ev.type !== "string" || !OUTCOMES.has(ev.outcome)) throw new Error("evento inválido");
      const req = ev.req || null;
      const ip = req ? (req.ip || (req.socket && req.socket.remoteAddress) || null) : null;
      insert.run(
        new Date().toISOString(),
        ev.type,
        ev.outcome,
        ev.actorUserId ?? null,
        ev.targetUserId ?? null,
        req && typeof req.requestId === "string" ? req.requestId : null,
        ip ? truncateIp(ip) : null,
        subjectHash(ev.subjectEmail),
        sanitizeMetadata(ev.metadata),
      );
      return true;
    } catch (e) {
      // Sem o conteúdo do evento no log: só o tipo e a causa genérica.
      console.error(`[audit] falha ao gravar evento ${ev && typeof ev.type === "string" ? ev.type : "?"}: ${e && e.code ? e.code : "erro"}`);
      return false;
    }
  }

  /** Grava no máximo 1 evento por `key` a cada janela (padrão 10 min). */
  function recordDeduped(key, ev) {
    const now = Date.now();
    const exp = dedup.get(key);
    if (exp && exp > now) return false;
    if (dedup.size > 5000) { for (const [k, e] of dedup) if (e <= now) dedup.delete(k); }
    if (dedup.size > 5000) dedup.clear();
    dedup.set(key, now + dedupWindowMs);
    return record(ev);
  }

  function purge(nowMs = Date.now()) {
    const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare("DELETE FROM audit_events WHERE occurred_at < ?").run(cutoff).changes;
  }

  function list({ type, outcome, before, limit } = {}) {
    const where = [];
    const args = [];
    if (typeof type === "string" && type) { where.push("event_type = ?"); args.push(type); }
    if (typeof outcome === "string" && OUTCOMES.has(outcome)) { where.push("outcome = ?"); args.push(outcome); }
    if (typeof before === "string" && before) {
      if (/^\d+$/.test(before)) { where.push("id < ?"); args.push(Number(before)); }
      else { where.push("occurred_at < ?"); args.push(before); }
    }
    let n = parseInt(limit || "100", 10);
    if (!Number.isInteger(n) || n < 1) n = 100;
    n = Math.min(n, 500);
    const rows = db.prepare(`SELECT * FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, n);
    return rows.map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null }));
  }

  return { record, recordDeduped, purge, list, subjectHash };
}

module.exports = { createAudit, sanitizeMetadata, normalizeEmail, ALLOWED_METADATA_KEYS };
