const express = require("express");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(express.json());

const PORT         = process.env.PORT         || 3010;
const QRNG_UPSTREAM = process.env.QRNG_UPSTREAM || "http://127.0.0.1:18001";
const DB_PATH       = process.env.DB_PATH       || path.join(__dirname, "qrng-tokens.db");
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || null;

// ── Banco de dados ───────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
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

  CREATE TABLE IF NOT EXISTS invite_codes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT    NOT NULL UNIQUE,
    created_at       TEXT    NOT NULL,
    used_at          TEXT,
    used_by_token_id INTEGER
  );
`);

// ── Token helpers ────────────────────────────────────────────────────────────

function generateToken() {
  return `dobslit_qrng_live_${crypto.randomBytes(20).toString("hex")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Primeiros 28 chars: "dobslit_qrng_live_" (18) + 10 hex chars
function tokenPrefix(token) {
  return token.slice(0, 28);
}

function logRequest(tokenId, endpoint, bytesRequested, format, statusCode, ip, userAgent) {
  const requestId = `req_${crypto.randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
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

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// ── Rate limiting — por token (30 req/min) ───────────────────────────────────

const TOKEN_RATE_LIMIT  = 30;
const TOKEN_RATE_WINDOW = 60 * 1000;
const tokenRateMap = new Map(); // tokenId -> { count, resetAt }

// Limpa entradas expiradas a cada 5 minutos para evitar memory leak
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of tokenRateMap) {
    if (now >= entry.resetAt) tokenRateMap.delete(id);
  }
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
    return res.status(429).json({
      error: "rate_limit_exceeded",
      message: `Limite de ${TOKEN_RATE_LIMIT} req/min atingido. Tente novamente em ${retryAfter}s.`,
      retry_after_seconds: retryAfter,
    });
  }

  entry.count++;
  next();
}

// ── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireToken(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token", message: "Use Authorization: Bearer <token>" });
  }
  const raw = auth.slice(7).trim();
  const hash = hashToken(raw);
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hash);
  if (!row) {
    return res.status(403).json({ error: "invalid_token", message: "Token inválido ou revogado." });
  }
  req.tokenRow = row;
  req.rawToken = raw;
  next();
}

// ── Admin middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: "admin_disabled", message: "Painel admin não configurado nesta instância." });
  }
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== ADMIN_SECRET) {
    return res.status(401).json({ error: "unauthorized", message: "Admin secret inválido." });
  }
  next();
}

// ── POST /v1/tokens — Criar token (com ou sem convite) ───────────────────────

app.post("/v1/tokens", (req, res) => {
  const now = new Date().toISOString();

  // Modo multi-usuário: ADMIN_SECRET configurado → exige código de convite
  if (ADMIN_SECRET) {
    const { invite_code } = req.body;
    if (!invite_code) {
      return res.status(400).json({ error: "invite_required", message: "Código de convite obrigatório." });
    }
    const invite = db.prepare("SELECT * FROM invite_codes WHERE code = ?").get(invite_code);
    if (!invite) {
      return res.status(400).json({ error: "invalid_invite", message: "Código de convite inválido." });
    }
    if (invite.used_at) {
      return res.status(400).json({ error: "invite_used", message: "Este código de convite já foi utilizado." });
    }

    const raw = generateToken();
    const result = db.prepare(`
      INSERT INTO api_tokens (token_prefix, token_hash, name, status, quota_daily, created_at)
      VALUES (?, ?, 'Token principal', 'active', 1000, ?)
    `).run(tokenPrefix(raw), hashToken(raw), now);

    db.prepare("UPDATE invite_codes SET used_at = ?, used_by_token_id = ? WHERE id = ?")
      .run(now, result.lastInsertRowid, invite.id);

    return res.json({ message: "Token criado. Guarde-o agora — não será exibido novamente.", token: raw, prefix: tokenPrefix(raw), created_at: now });
  }

  // Modo single-user: sem ADMIN_SECRET → comportamento original (um token por instância)
  const existing = db.prepare("SELECT id FROM api_tokens WHERE status = 'active' LIMIT 1").get();
  if (existing) {
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      const row = db.prepare("SELECT id FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(auth.slice(7).trim()));
      if (row) return res.status(409).json({ error: "token_exists", message: "Você já tem um token ativo. Use POST /v1/me/token/rotate para regenerar." });
    }
    return res.status(409).json({ error: "token_exists", message: "Já existe um token ativo. Faça login com seu token para gerenciá-lo." });
  }

  const raw = generateToken();
  const prefix = tokenPrefix(raw);
  db.prepare(`
    INSERT INTO api_tokens (token_prefix, token_hash, name, status, quota_daily, created_at)
    VALUES (?, ?, 'Token principal', 'active', 1000, ?)
  `).run(prefix, hashToken(raw), now);

  res.json({ message: "Token criado. Guarde-o agora — não será exibido novamente.", token: raw, prefix, created_at: now });
});

// ── Admin: gestão de convites e tokens ───────────────────────────────────────

app.post("/v1/admin/invite", requireAdmin, (req, res) => {
  const code = crypto.randomBytes(16).toString("hex");
  const now  = new Date().toISOString();
  db.prepare("INSERT INTO invite_codes (code, created_at) VALUES (?, ?)").run(code, now);
  res.json({ code, created_at: now });
});

app.get("/v1/admin/invites", requireAdmin, (req, res) => {
  const invites = db.prepare(
    "SELECT id, code, created_at, used_at, used_by_token_id FROM invite_codes ORDER BY created_at DESC LIMIT 100"
  ).all();
  res.json({ invites });
});

app.get("/v1/admin/tokens", requireAdmin, (req, res) => {
  const today  = new Date().toISOString().slice(0, 10);
  const tokens = db.prepare(`
    SELECT t.id, t.token_prefix, t.name, t.status, t.quota_daily, t.created_at, t.last_used_at,
           COALESCE(d.requests_count, 0) AS requests_today,
           COALESCE(d.bytes_count, 0)    AS bytes_today
    FROM api_tokens t
    LEFT JOIN daily_usage d ON d.token_id = t.id AND d.date = ?
    ORDER BY t.created_at DESC
  `).all(today);
  res.json({ tokens });
});

app.post("/v1/admin/tokens/:id/revoke", requireAdmin, (req, res) => {
  const now    = new Date().toISOString();
  const result = db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?")
    .run(now, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ message: "Token revogado.", revoked_at: now });
});

app.patch("/v1/admin/tokens/:id/quota", requireAdmin, (req, res) => {
  const quota  = parseInt(req.body.quota_daily, 10);
  if (!quota || quota < 1) return res.status(400).json({ error: "invalid_quota", message: "quota_daily deve ser >= 1" });
  const result = db.prepare("UPDATE api_tokens SET quota_daily = ? WHERE id = ?").run(quota, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ message: "Cota atualizada.", quota_daily: quota });
});

// ── GET /v1/me/token — Info do token atual ───────────────────────────────────

app.get("/v1/me/token", requireToken, checkTokenRate, (req, res) => {
  const row = req.tokenRow;
  const today = new Date().toISOString().slice(0, 10);
  const usage = db.prepare("SELECT requests_count, bytes_count FROM daily_usage WHERE token_id = ? AND date = ?").get(row.id, today);

  res.json({
    token_prefix: row.token_prefix,
    name: row.name,
    status: row.status,
    quota_daily: row.quota_daily,
    requests_today: usage?.requests_count || 0,
    bytes_today: usage?.bytes_count || 0,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  });
});

// ── POST /v1/me/token/rotate — Regenerar token ──────────────────────────────

app.post("/v1/me/token/rotate", requireToken, checkTokenRate, (req, res) => {
  const old = req.tokenRow;
  const now = new Date().toISOString();

  db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, old.id);

  const raw = generateToken();
  const hash = hashToken(raw);
  const prefix = tokenPrefix(raw);

  db.prepare(`
    INSERT INTO api_tokens (token_prefix, token_hash, name, status, quota_daily, created_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(prefix, hash, old.name, old.quota_daily, now);

  res.json({
    message: "Token regenerado. Guarde-o agora — não será exibido novamente.",
    token: raw,
    prefix,
    created_at: now,
  });
});

// ── POST /v1/me/token/revoke — Revogar token ────────────────────────────────

app.post("/v1/me/token/revoke", requireToken, checkTokenRate, (req, res) => {
  const now = new Date().toISOString();
  db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, req.tokenRow.id);
  res.json({ message: "Token revogado com sucesso.", revoked_at: now });
});

// ── GET /v1/me/usage — Estatísticas de uso ──────────────────────────────────

app.get("/v1/me/usage", requireToken, checkTokenRate, (req, res) => {
  const { id, name, status, quota_daily, last_used_at } = req.tokenRow;
  const today = new Date().toISOString().slice(0, 10);
  const ago7  = new Date(Date.now() -  7 * 86400000).toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const todayRow = db.prepare("SELECT requests_count, bytes_count FROM daily_usage WHERE token_id = ? AND date = ?").get(id, today);
  const row7     = db.prepare("SELECT SUM(requests_count) r, SUM(bytes_count) b FROM daily_usage WHERE token_id = ? AND date >= ?").get(id, ago7);
  const row30    = db.prepare("SELECT SUM(requests_count) r, SUM(bytes_count) b FROM daily_usage WHERE token_id = ? AND date >= ?").get(id, ago30);
  const history  = db.prepare("SELECT date, requests_count, bytes_count, errors_count FROM daily_usage WHERE token_id = ? ORDER BY date DESC LIMIT 30").all(id);

  res.json({
    token_name:      name,
    status,
    quota_daily,
    requests_today:  todayRow?.requests_count || 0,
    bytes_today:     todayRow?.bytes_count    || 0,
    requests_7d:     row7?.r  || 0,
    bytes_7d:        row7?.b  || 0,
    requests_30d:    row30?.r || 0,
    bytes_30d:       row30?.b || 0,
    last_used_at,
    daily_history:   history,
  });
});

// ── GET /v1/me/requests — Histórico de chamadas ──────────────────────────────

app.get("/v1/me/requests", requireToken, checkTokenRate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 10000);
  const logs = db.prepare(`
    SELECT request_id, endpoint, bytes_requested, format, status_code, ip_address, created_at
    FROM api_usage_logs
    WHERE token_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(req.tokenRow.id, limit);
  res.json({ requests: logs });
});

// ── GET /v1/health ───────────────────────────────────────────────────────────

app.get("/v1/health", requireToken, checkTokenRate, async (req, res) => {
  try {
    const r = await fetch(`${QRNG_UPSTREAM}/health`);
    const data = await r.json();
    logRequest(req.tokenRow.id, "/v1/health", 0, null, 200,
      req.ip || req.socket.remoteAddress, req.headers["user-agent"]);
    res.json({ status: "ok", api: "dobslit-qrng-client-api", source: "ufpe-fpga", upstream: data });
  } catch {
    logRequest(req.tokenRow.id, "/v1/health", 0, null, 503,
      req.ip || req.socket.remoteAddress, req.headers["user-agent"]);
    res.status(503).json({ status: "error", message: "QRNG upstream unavailable" });
  }
});

// ── Enforce de cota diária ────────────────────────────────────────────────────

function checkQuota(req, res, next) {
  const { id, quota_daily } = req.tokenRow;
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT requests_count FROM daily_usage WHERE token_id = ? AND date = ?").get(id, today);
  const used = row?.requests_count || 0;
  if (used >= quota_daily) {
    return res.status(429).json({
      error: "quota_exceeded",
      message: `Cota diária de ${quota_daily} requests atingida. Tente novamente amanhã.`,
      quota_daily,
      requests_today: used,
    });
  }
  next();
}

// ── GET /v1/random ───────────────────────────────────────────────────────────

function parseUpstreamRandom(buffer, requestedBytes) {
  const text = buffer.toString("utf8").trim();

  // JSON format
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json.bytes))       return Buffer.from(json.bytes.slice(0, requestedBytes));
    if (typeof json.hex === "string")    return Buffer.from(json.hex, "hex").slice(0, requestedBytes);
    if (typeof json.random === "string") return Buffer.from(json.random, "hex").slice(0, requestedBytes);
  } catch (_) {}

  // Space/comma-separated decimal values: "143 52 187 ..."
  if (/^[0-9,\s]+$/.test(text) && /[\s,]/.test(text)) {
    const values = text
      .split(/[\s,]+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      .slice(0, requestedBytes);
    if (values.length >= requestedBytes) return Buffer.from(values);
  }

  // Packed decimal digit stream — UFPE/FPGA upstream format: "07157403550289211521..."
  // Rejection sampling: consume 3 digits at a time (000-999); keep if <= 255.
  // P(keep) ≈ 25.6%, so caller must request ~20× more upstream digits than output bytes.
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
  const bytes = Math.min(parseInt(req.query.bytes || "32", 10), 4096);
  const format = req.query.format || "hex";
  const ip = req.ip || req.socket.remoteAddress;
  const ua = req.headers["user-agent"];

  if (bytes < 1) {
    return res.status(400).json({ error: "invalid_bytes", message: "bytes deve ser >= 1" });
  }
  if (!["hex", "base64", "uint8"].includes(format)) {
    return res.status(400).json({ error: "invalid_format", message: "Use format=hex, base64 ou uint8" });
  }

  try {
    const upstreamBytes = Math.min(bytes * 20, 50 * 1024 * 1024);
    const r = await fetch(`${QRNG_UPSTREAM}/random?bytes=${upstreamBytes}`);

    if (!r.ok) {
      logRequest(req.tokenRow.id, "/v1/random", bytes, format, 502, ip, ua);
      return res.status(502).json({ error: "upstream_error", status: r.status });
    }

    const upBuf = await r.buffer();
    const buf = parseUpstreamRandom(upBuf, bytes);

    if (buf.length < bytes) {
      logRequest(req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua);
      return res.status(503).json({
        error: "insufficient_entropy", available: buf.length, requested: bytes,
      });
    }

    const random = format === "hex"    ? buf.toString("hex")
                 : format === "base64" ? buf.toString("base64")
                 : Array.from(buf);

    logRequest(req.tokenRow.id, "/v1/random", bytes, format, 200, ip, ua);

    res.json({ source: "dobslit-qrng-ufpe-fpga", bytes, format, random, timestamp: new Date().toISOString() });
  } catch (err) {
    logRequest(req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua);
    res.status(503).json({ error: "qrng_unavailable", detail: err.message });
  }
});

// ── Upstream monitor ─────────────────────────────────────────────────────────

let upstreamState = { status: "unknown", checkedAt: null, responseMs: null };

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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

  const now = new Date().toISOString();
  const prev = upstreamState.status;
  upstreamState = { status, checkedAt: now, responseMs };

  if (prev !== status) {
    db.prepare(
      "INSERT INTO upstream_health_log (status, response_ms, detail, checked_at) VALUES (?, ?, ?, ?)"
    ).run(status, responseMs ?? null, detail ?? null, now);

    console.log(`[upstream] ${prev} → ${status}${detail ? ` (${detail})` : ""}`);

    // Mantém últimas 500 transições
    db.prepare(
      "DELETE FROM upstream_health_log WHERE id NOT IN (SELECT id FROM upstream_health_log ORDER BY id DESC LIMIT 500)"
    ).run();
  }
}

// ── GET /v1/upstream/status ───────────────────────────────────────────────────

app.get("/v1/upstream/status", requireToken, checkTokenRate, (req, res) => {
  const events = db.prepare(
    "SELECT status, response_ms, detail, checked_at FROM upstream_health_log ORDER BY id DESC LIMIT 50"
  ).all();

  // Calcula uptime das últimas 24h com base nas transições
  const ago24h = new Date(Date.now() - 86400000).toISOString();
  const slice = db.prepare(
    "SELECT status, checked_at FROM upstream_health_log WHERE checked_at >= ? ORDER BY checked_at ASC"
  ).all(ago24h);

  let uptimeMs = 0;
  const windowStart = new Date(ago24h).getTime();
  const now = Date.now();

  for (let i = 0; i < slice.length; i++) {
    const from = Math.max(new Date(slice[i].checked_at).getTime(), windowStart);
    const to   = i + 1 < slice.length ? new Date(slice[i + 1].checked_at).getTime() : now;
    if (slice[i].status === "up") uptimeMs += to - from;
  }

  const windowMs   = now - windowStart;
  const uptime24h  = slice.length > 0 ? Math.round((uptimeMs / windowMs) * 1000) / 10 : null;

  res.json({
    current:       upstreamState,
    uptime_24h_pct: uptime24h,
    recent_events: events,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`QRNG client API listening on http://127.0.0.1:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    checkUpstream();
    setInterval(checkUpstream, 60 * 1000);
  });
}

module.exports = { app, db };
