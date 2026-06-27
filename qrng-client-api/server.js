"use strict";
const express    = require("express");
const rateLimit  = require("express-rate-limit");
const fetch      = require("node-fetch");
const crypto     = require("crypto");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const Database   = require("better-sqlite3");
const path       = require("path");

const app = express();
app.use(express.json());

const PORT          = process.env.PORT          || 3010;
const QRNG_UPSTREAM = process.env.QRNG_UPSTREAM || "http://127.0.0.1:18001";
const DB_PATH       = process.env.DB_PATH       || path.join(__dirname, "qrng-tokens.db");
const JWT_SECRET    = process.env.JWT_SECRET    || crypto.randomBytes(32).toString("hex");
const ADMIN_EMAIL   = (process.env.ADMIN_EMAIL  || "").toLowerCase();

// ── Banco de dados ───────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    token_prefix TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    name         TEXT    DEFAULT 'Token principal',
    status       TEXT    DEFAULT 'active',
    quota_daily  INTEGER DEFAULT 1000,
    created_at   TEXT    NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
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
`);

// Migração: adiciona user_id à tabela existente se não existir
try { db.exec("ALTER TABLE api_tokens ADD COLUMN user_id INTEGER"); } catch (_) {}

// ── Token helpers ────────────────────────────────────────────────────────────

function generateToken() {
  return `dobslit_qrng_live_${crypto.randomBytes(20).toString("hex")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function tokenPrefix(token) {
  return token.slice(0, 28);
}

function logRequest(tokenId, endpoint, bytesRequested, format, statusCode, ip, userAgent) {
  const requestId = `req_${crypto.randomBytes(6).toString("hex")}`;
  const now   = new Date().toISOString();
  const today = now.slice(0, 10);

  db.prepare(`
    INSERT INTO api_usage_logs
      (request_id, token_id, endpoint, bytes_requested, format, status_code, ip_address, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, tokenId, endpoint, bytesRequested, format, statusCode, ip, userAgent, now);

  db.prepare(`
    INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(token_id, date) DO UPDATE SET
      requests_count = requests_count + 1,
      bytes_count    = bytes_count    + excluded.bytes_count,
      errors_count   = errors_count   + excluded.errors_count
  `).run(tokenId, today, bytesRequested, statusCode >= 400 ? 1 : 0);

  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, tokenId);
  return requestId;
}

// ── Rate limiting — global por IP ────────────────────────────────────────────

app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

// ── Rate limiting — por token (30 req/min, só para endpoints de API) ─────────

const TOKEN_RATE_LIMIT  = 30;
const TOKEN_RATE_WINDOW = 60 * 1000;
const tokenRateMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of tokenRateMap) { if (now >= e.resetAt) tokenRateMap.delete(id); }
}, 5 * 60 * 1000);

function checkTokenRate(req, res, next) {
  const tokenId = req.tokenRow.id;
  const now     = Date.now();
  const entry   = tokenRateMap.get(tokenId);
  if (!entry || now >= entry.resetAt) {
    tokenRateMap.set(tokenId, { count: 1, resetAt: now + TOKEN_RATE_WINDOW });
    return next();
  }
  if (entry.count >= TOKEN_RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({ error: "rate_limit_exceeded", message: `Limite de ${TOKEN_RATE_LIMIT} req/min atingido.`, retry_after_seconds: retryAfter });
  }
  entry.count++;
  next();
}

// ── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Middleware de autenticação ────────────────────────────────────────────────

// JWT — para management endpoints e admin
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token", message: "Faça login primeiro." });
  }
  try {
    req.user = jwt.verify(auth.slice(7).trim(), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "session_expired", message: "Sessão expirada. Faça login novamente." });
  }
}

// Requer role admin no JWT
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "Acesso restrito a administradores." });
  }
  next();
}

// API token — para /random e /health (chamadas machine-to-machine)
function requireToken(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token", message: "Use Authorization: Bearer <api_token>" });
  }
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(auth.slice(7).trim()));
  if (!row) return res.status(403).json({ error: "invalid_token", message: "Token inválido ou revogado." });
  req.tokenRow = row;
  next();
}

// Dual auth — para /me/* (aceita JWT ou API token, por compatibilidade com notebooks)
function resolveUser(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized", message: "Autenticação necessária." });
  }
  const raw = auth.slice(7).trim();

  // Tenta JWT primeiro
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    req.user     = payload;
    req.tokenRow = db.prepare("SELECT * FROM api_tokens WHERE user_id = ? AND status = 'active'").get(payload.sub) || null;
    req.authMode = "jwt";
    return next();
  } catch (_) {}

  // Fallback: API token
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(raw));
  if (row) {
    req.tokenRow = row;
    req.authMode = "token";
    return next();
  }

  return res.status(401).json({ error: "unauthorized", message: "Token ou sessão inválidos." });
}

// ── Auth: registro e login ────────────────────────────────────────────────────

app.post("/v1/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields", message: "Email e senha são obrigatórios." });
  if (password.length < 8) return res.status(400).json({ error: "weak_password", message: "Senha mínima: 8 caracteres." });

  const role = ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL ? "admin" : "user";
  const now  = new Date().toISOString();

  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run(email.toLowerCase(), hash, role, now);
    const token  = jwt.sign({ sub: result.lastInsertRowid, email: email.toLowerCase(), role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, email: email.toLowerCase(), role });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "email_taken", message: "Este e-mail já está cadastrado." });
    throw err;
  }
});

app.post("/v1/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." });
  }

  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, email: user.email, role: user.role });
});

app.get("/v1/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(req.user.sub);
  if (!user) return res.status(404).json({ error: "user_not_found" });
  res.json(user);
});

// ── POST /v1/tokens — Criar API token ────────────────────────────────────────

app.post("/v1/tokens", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM api_tokens WHERE user_id = ? AND status = 'active'").get(req.user.sub);
  if (existing) {
    return res.status(409).json({ error: "token_exists", message: "Você já tem um token ativo. Use POST /v1/me/token/rotate para regenerar." });
  }

  const raw = generateToken();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO api_tokens (user_id, token_prefix, token_hash, name, status, quota_daily, created_at)
    VALUES (?, ?, ?, 'Token principal', 'active', 1000, ?)
  `).run(req.user.sub, tokenPrefix(raw), hashToken(raw), now);

  res.json({ message: "Token criado. Guarde-o agora — não será exibido novamente.", token: raw, prefix: tokenPrefix(raw), created_at: now });
});

// ── GET /v1/me/token ─────────────────────────────────────────────────────────

app.get("/v1/me/token", resolveUser, (req, res) => {
  const row = req.tokenRow;
  if (!row) return res.json({ has_token: false });

  const today = new Date().toISOString().slice(0, 10);
  const usage = db.prepare("SELECT requests_count, bytes_count FROM daily_usage WHERE token_id = ? AND date = ?").get(row.id, today);

  res.json({
    has_token:      true,
    token_prefix:   row.token_prefix,
    name:           row.name,
    status:         row.status,
    quota_daily:    row.quota_daily,
    requests_today: usage?.requests_count || 0,
    bytes_today:    usage?.bytes_count    || 0,
    created_at:     row.created_at,
    last_used_at:   row.last_used_at,
  });
});

// ── POST /v1/me/token/rotate ──────────────────────────────────────────────────

app.post("/v1/me/token/rotate", resolveUser, (req, res) => {
  const old = req.tokenRow;
  if (!old) return res.status(404).json({ error: "no_token", message: "Nenhum token ativo encontrado." });

  const now = new Date().toISOString();
  db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, old.id);

  const raw = generateToken();
  db.prepare(`
    INSERT INTO api_tokens (user_id, token_prefix, token_hash, name, status, quota_daily, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(old.user_id, tokenPrefix(raw), hashToken(raw), old.name, old.quota_daily, now);

  res.json({ message: "Token regenerado. Guarde-o agora — não será exibido novamente.", token: raw, prefix: tokenPrefix(raw), created_at: now });
});

// ── POST /v1/me/token/revoke ──────────────────────────────────────────────────

app.post("/v1/me/token/revoke", resolveUser, (req, res) => {
  const row = req.tokenRow;
  if (!row) return res.status(404).json({ error: "no_token" });
  const now = new Date().toISOString();
  db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, row.id);
  res.json({ message: "Token revogado com sucesso.", revoked_at: now });
});

// ── GET /v1/me/usage ─────────────────────────────────────────────────────────

app.get("/v1/me/usage", resolveUser, (req, res) => {
  const row = req.tokenRow;
  if (!row) return res.json({ has_token: false });

  const { id, name, status, quota_daily, last_used_at } = row;
  const today = new Date().toISOString().slice(0, 10);
  const ago7  = new Date(Date.now() -  7 * 86400000).toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const todayRow = db.prepare("SELECT requests_count, bytes_count FROM daily_usage WHERE token_id = ? AND date = ?").get(id, today);
  const row7     = db.prepare("SELECT SUM(requests_count) r, SUM(bytes_count) b FROM daily_usage WHERE token_id = ? AND date >= ?").get(id, ago7);
  const row30    = db.prepare("SELECT SUM(requests_count) r, SUM(bytes_count) b FROM daily_usage WHERE token_id = ? AND date >= ?").get(id, ago30);
  const history  = db.prepare("SELECT date, requests_count, bytes_count, errors_count FROM daily_usage WHERE token_id = ? ORDER BY date DESC LIMIT 30").all(id);

  res.json({ has_token: true, token_name: name, status, quota_daily, requests_today: todayRow?.requests_count || 0, bytes_today: todayRow?.bytes_count || 0, requests_7d: row7?.r || 0, bytes_7d: row7?.b || 0, requests_30d: row30?.r || 0, bytes_30d: row30?.b || 0, last_used_at, daily_history: history });
});

// ── GET /v1/me/requests ───────────────────────────────────────────────────────

app.get("/v1/me/requests", resolveUser, (req, res) => {
  const row = req.tokenRow;
  if (!row) return res.json({ requests: [] });
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 10000);
  const logs  = db.prepare(`
    SELECT request_id, endpoint, bytes_requested, format, status_code, ip_address, created_at
    FROM api_usage_logs WHERE token_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(row.id, limit);
  res.json({ requests: logs });
});

// ── GET /v1/upstream/status ───────────────────────────────────────────────────

app.get("/v1/upstream/status", resolveUser, (req, res) => {
  const events = db.prepare("SELECT status, response_ms, detail, checked_at FROM upstream_health_log ORDER BY id DESC LIMIT 50").all();
  const ago24h = new Date(Date.now() - 86400000).toISOString();
  const slice  = db.prepare("SELECT status, checked_at FROM upstream_health_log WHERE checked_at >= ? ORDER BY checked_at ASC").all(ago24h);

  let uptimeMs = 0;
  const windowStart = new Date(ago24h).getTime();
  const now = Date.now();
  for (let i = 0; i < slice.length; i++) {
    const from = Math.max(new Date(slice[i].checked_at).getTime(), windowStart);
    const to   = i + 1 < slice.length ? new Date(slice[i + 1].checked_at).getTime() : now;
    if (slice[i].status === "up") uptimeMs += to - from;
  }

  res.json({ current: upstreamState, uptime_24h_pct: slice.length > 0 ? Math.round((uptimeMs / (now - windowStart)) * 1000) / 10 : null, recent_events: events });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get("/v1/admin/tokens", requireAuth, requireAdmin, (req, res) => {
  const today  = new Date().toISOString().slice(0, 10);
  const tokens = db.prepare(`
    SELECT t.id, t.user_id, t.token_prefix, t.name, t.status, t.quota_daily,
           t.created_at, t.last_used_at,
           u.email,
           COALESCE(d.requests_count, 0) AS requests_today,
           COALESCE(d.bytes_count, 0)    AS bytes_today
    FROM api_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN daily_usage d ON d.token_id = t.id AND d.date = ?
    ORDER BY t.created_at DESC
  `).all(today);
  res.json({ tokens });
});

app.post("/v1/admin/tokens/:id/revoke", requireAuth, requireAdmin, (req, res) => {
  const now    = new Date().toISOString();
  const result = db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ message: "Token revogado.", revoked_at: now });
});

app.patch("/v1/admin/tokens/:id/quota", requireAuth, requireAdmin, (req, res) => {
  const quota  = parseInt(req.body.quota_daily, 10);
  if (!quota || quota < 1) return res.status(400).json({ error: "invalid_quota" });
  const result = db.prepare("UPDATE api_tokens SET quota_daily = ? WHERE id = ?").run(quota, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ message: "Cota atualizada.", quota_daily: quota });
});

app.get("/v1/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC").all();
  res.json({ users });
});

// ── GET /v1/health ────────────────────────────────────────────────────────────

app.get("/v1/health", requireToken, checkTokenRate, async (req, res) => {
  try {
    const r = await fetch(`${QRNG_UPSTREAM}/health`);
    const data = await r.json();
    logRequest(req.tokenRow.id, "/v1/health", 0, null, 200, req.ip || req.socket.remoteAddress, req.headers["user-agent"]);
    res.json({ status: "ok", api: "dobslit-qrng-client-api", source: "ufpe-fpga", upstream: data });
  } catch {
    logRequest(req.tokenRow.id, "/v1/health", 0, null, 503, req.ip || req.socket.remoteAddress, req.headers["user-agent"]);
    res.status(503).json({ status: "error", message: "QRNG upstream unavailable" });
  }
});

// ── Enforce de cota diária ────────────────────────────────────────────────────

function checkQuota(req, res, next) {
  const { id, quota_daily } = req.tokenRow;
  const today = new Date().toISOString().slice(0, 10);
  const used  = db.prepare("SELECT requests_count FROM daily_usage WHERE token_id = ? AND date = ?").get(id, today)?.requests_count || 0;
  if (used >= quota_daily) {
    return res.status(429).json({ error: "quota_exceeded", message: `Cota diária de ${quota_daily} requests atingida.`, quota_daily, requests_today: used });
  }
  next();
}

// ── GET /v1/random ────────────────────────────────────────────────────────────

function parseUpstreamRandom(buffer, requestedBytes) {
  const text = buffer.toString("utf8").trim();

  try {
    const json = JSON.parse(text);
    if (Array.isArray(json.bytes))       return Buffer.from(json.bytes.slice(0, requestedBytes));
    if (typeof json.hex === "string")    return Buffer.from(json.hex, "hex").slice(0, requestedBytes);
    if (typeof json.random === "string") return Buffer.from(json.random, "hex").slice(0, requestedBytes);
  } catch (_) {}

  if (/^[0-9,\s]+$/.test(text) && /[\s,]/.test(text)) {
    const values = text.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255).slice(0, requestedBytes);
    if (values.length >= requestedBytes) return Buffer.from(values);
  }

  // Packed decimal digit stream — formato UFPE/FPGA
  if (/^[0-9]+$/.test(text)) {
    const result = [];
    for (let i = 0; i + 3 <= text.length && result.length < requestedBytes; i += 3) {
      const val = parseInt(text.slice(i, i + 3), 10);
      if (val <= 255) result.push(val);
    }
    if (result.length >= requestedBytes) return Buffer.from(result.slice(0, requestedBytes));
  }

  return buffer.slice(0, requestedBytes);
}

app.get("/v1/random", requireToken, checkTokenRate, checkQuota, async (req, res) => {
  const bytes  = Math.min(parseInt(req.query.bytes || "32", 10), 4096);
  const format = req.query.format || "hex";
  const ip     = req.ip || req.socket.remoteAddress;
  const ua     = req.headers["user-agent"];

  if (bytes < 1) return res.status(400).json({ error: "invalid_bytes", message: "bytes deve ser >= 1" });
  if (!["hex", "base64", "uint8"].includes(format)) return res.status(400).json({ error: "invalid_format", message: "Use format=hex, base64 ou uint8" });

  try {
    const r = await fetch(`${QRNG_UPSTREAM}/random?bytes=${Math.min(bytes * 20, 50 * 1024 * 1024)}`);
    if (!r.ok) { logRequest(req.tokenRow.id, "/v1/random", bytes, format, 502, ip, ua); return res.status(502).json({ error: "upstream_error", status: r.status }); }

    const buf = parseUpstreamRandom(await r.buffer(), bytes);
    if (buf.length < bytes) { logRequest(req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua); return res.status(503).json({ error: "insufficient_entropy", available: buf.length, requested: bytes }); }

    const random = format === "hex" ? buf.toString("hex") : format === "base64" ? buf.toString("base64") : Array.from(buf);
    logRequest(req.tokenRow.id, "/v1/random", bytes, format, 200, ip, ua);
    res.json({ source: "dobslit-qrng-ufpe-fpga", bytes, format, random, timestamp: new Date().toISOString() });
  } catch (err) {
    logRequest(req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua);
    res.status(503).json({ error: "qrng_unavailable", detail: err.message });
  }
});

// ── Upstream monitor ──────────────────────────────────────────────────────────

let upstreamState = { status: "unknown", checkedAt: null, responseMs: null };

async function fetchWithTimeout(url, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

async function checkUpstream() {
  const t0 = Date.now();
  let status, responseMs, detail;
  try {
    const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/health`, 5000);
    responseMs = Date.now() - t0;
    status = r.ok ? "up" : "down";
    detail = r.ok ? null : `HTTP ${r.status}`;
  } catch (err) {
    responseMs = null;
    status = "down";
    detail = err.name === "AbortError" ? "timeout" : err.message;
  }

  const now  = new Date().toISOString();
  const prev = upstreamState.status;
  upstreamState = { status, checkedAt: now, responseMs };

  if (prev !== status) {
    db.prepare("INSERT INTO upstream_health_log (status, response_ms, detail, checked_at) VALUES (?, ?, ?, ?)").run(status, responseMs ?? null, detail ?? null, now);
    console.log(`[upstream] ${prev} → ${status}${detail ? ` (${detail})` : ""}`);
    db.prepare("DELETE FROM upstream_health_log WHERE id NOT IN (SELECT id FROM upstream_health_log ORDER BY id DESC LIMIT 500)").run();
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`QRNG client API listening on http://127.0.0.1:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log(`Admin email: ${ADMIN_EMAIL || "(não configurado)"}`);
    checkUpstream();
    setInterval(checkUpstream, 60 * 1000);
  });
}

module.exports = { app, db };
