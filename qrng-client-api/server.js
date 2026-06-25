const express = require("express");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3010;
const QRNG_UPSTREAM = process.env.QRNG_UPSTREAM || "http://127.0.0.1:18001";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "qrng-tokens.db");

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

// ── Rate limiting ────────────────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

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

// ── POST /v1/tokens — Criar token ────────────────────────────────────────────

app.post("/v1/tokens", (req, res) => {
  const existing = db.prepare("SELECT id FROM api_tokens WHERE status = 'active' LIMIT 1").get();

  if (existing) {
    // Se já tem token, exige que o usuário use /me/token/rotate
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      const raw = auth.slice(7).trim();
      const row = db.prepare("SELECT id FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(raw));
      if (row) {
        return res.status(409).json({
          error: "token_exists",
          message: "Você já tem um token ativo. Use POST /v1/me/token/rotate para regenerar.",
        });
      }
    }
    return res.status(409).json({
      error: "token_exists",
      message: "Já existe um token ativo. Faça login com seu token para gerenciá-lo.",
    });
  }

  const raw = generateToken();
  const hash = hashToken(raw);
  const prefix = tokenPrefix(raw);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO api_tokens (token_prefix, token_hash, name, status, quota_daily, created_at)
    VALUES (?, ?, 'Token principal', 'active', 1000, ?)
  `).run(prefix, hash, now);

  res.json({
    message: "Token criado. Guarde-o agora — não será exibido novamente.",
    token: raw,
    prefix,
    created_at: now,
  });
});

// ── GET /v1/me/token — Info do token atual ───────────────────────────────────

app.get("/v1/me/token", requireToken, (req, res) => {
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

app.post("/v1/me/token/rotate", requireToken, (req, res) => {
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

app.post("/v1/me/token/revoke", requireToken, (req, res) => {
  const now = new Date().toISOString();
  db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, req.tokenRow.id);
  res.json({ message: "Token revogado com sucesso.", revoked_at: now });
});

// ── GET /v1/me/usage — Estatísticas de uso ──────────────────────────────────

app.get("/v1/me/usage", requireToken, (req, res) => {
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

app.get("/v1/me/requests", requireToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
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

app.get("/v1/health", requireToken, async (req, res) => {
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

  try {
    const json = JSON.parse(text);
    if (Array.isArray(json.bytes))      return Buffer.from(json.bytes.slice(0, requestedBytes));
    if (typeof json.hex === "string")   return Buffer.from(json.hex, "hex").slice(0, requestedBytes);
    if (typeof json.random === "string") return Buffer.from(json.random, "hex").slice(0, requestedBytes);
  } catch (_) {}

  if (/^[0-9,\s]+$/.test(text) && /[\s,]/.test(text) && text.length > 0) {
    const values = text
      .split(/[\s,]+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      .slice(0, requestedBytes);
    if (values.length > 0) return Buffer.from(values);
  }

  return buffer.slice(0, requestedBytes);
}

app.get("/v1/random", requireToken, checkQuota, async (req, res) => {
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
    const upstreamBytes = Math.min(bytes * 5, 50 * 1024 * 1024);
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

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
  console.log(`QRNG client API listening on http://127.0.0.1:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
