"use strict";
require("dotenv").config();

const express    = require("express");
const rateLimit  = require("express-rate-limit");
const fetch      = require("node-fetch");
const http       = require("http");
const crypto     = require("crypto");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const Database   = require("better-sqlite3");
const path       = require("path");

const app = express();

// Item 10 da rodada de estabilizacao (2026-08-26): sem isto, req.ip do
// Express sempre resolvia para 127.0.0.1 -- nginx roda no mesmo host e
// conecta via loopback (network_mode host), e sem "trust proxy" o Express
// ignora X-Forwarded-For/X-Real-IP e usa o socket de conexao direta, que
// é sempre o nginx local. Na prática, TODO rate limit e cota por IP
// (RATE_LIMIT_PER_IP_MIN, publicIpRateLimiter, publicIpDailyUsage) estava
// compartilhando um unico balde "127.0.0.1" entre todos os clientes reais
// -- nao isolamento por cliente, e um cliente abusivo esgotava a cota de
// todo mundo. "loopback" confia em X-Forwarded-For/X-Real-IP apenas
// quando a conexao direta vem de 127.0.0.1/::1 (exatamente o nginx local
// deste deploy) -- um cliente externo nao consegue falsificar o cabecalho
// para pular essa checagem, porque a conexao dele nunca chega direto do
// loopback.
//
// Configuravel via TRUST_PROXY (item da fase de staging). DEFAULT "loopback"
// -- produção INALTERADA (nginx no mesmo host, network_mode host). Um staging
// em rede bridge (nginx em outro container) precisa confiar tambem na subnet
// privada do bridge: TRUST_PROXY="loopback, uniquelocal".
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");

// ── Limite explícito do corpo da requisição (item 3 da estabilização) ─────────
//
// Todo endpoint que lê `req.body` neste serviço recebe JSON pequeno:
//   POST /v1/auth/register|login  -> { email, password }
//   PATCH /v1/admin/tokens/:id/quota -> { quota_daily }
//   POST /v1/tokens|/me/token/* -> corpo vazio
// Maior request legítimo: register com e-mail no máximo da RFC 5321 (254
// chars) + senha (o bcrypt só usa os primeiros 72 bytes; 256 chars é um teto
// generoso) + overhead JSON  ≈  ~0,6 KiB.
// Limite = 8 KiB  ≈  13× esse pior caso — folga para qualquer endpoint
// JSON pequeno futuro, e ainda pequeno o bastante para limitar abuso.
// Configurável por env; nenhum valor arbitrário sem documentação.
//
// NÃO há `express.urlencoded`, `express.raw`, `express.text` nem multipart
// montados: nenhuma rota consome esses formatos. Um corpo form/multipart
// simplesmente não é parseado (`req.body` fica vazio) e a rota devolve seu
// 400 normal — não existe parser sem limite aqui.
// Upload NIST (arquivos grandes de amostras) é outro serviço (FastAPI em
// :18002, via nginx /qrng/nist/) e tem POLÍTICA DE LIMITE SEPARADA — ver
// physical-layer/REQUEST_BODY_LIMITS.md.
const JSON_BODY_LIMIT = process.env.MAX_JSON_BODY_BYTES || "8kb";

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// ── Configuração ──────────────────────────────────────────────────────────────

const PORT                     = process.env.PORT                          || 3010;
const QRNG_UPSTREAM            = process.env.QRNG_UPSTREAM                 || "http://127.0.0.1:18001";
const DB_PATH                  = process.env.DB_PATH                       || path.join(__dirname, "qrng-tokens.db");
const JWT_SECRET               = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[qrng-client-api] FATAL: JWT_SECRET não definido. Defina uma variável de ambiente segura antes de iniciar (ex.: openssl rand -hex 32).");
  process.exit(1);
}
const ADMIN_EMAIL              = (process.env.ADMIN_EMAIL                  || "").toLowerCase();
const MAX_BYTES_PER_REQUEST    = parseInt(process.env.MAX_BYTES_PER_REQUEST    || "1048576", 10); // 1 MiB
const RATE_LIMIT_PER_IP_MIN    = parseInt(process.env.RATE_LIMIT_PER_IP_PER_MINUTE  || "120", 10);
const RATE_LIMIT_PER_TOKEN_MIN = parseInt(process.env.RATE_LIMIT_PER_TOKEN_PER_MINUTE || "60", 10);
const DAILY_QUOTA_REQUESTS     = parseInt(process.env.DAILY_QUOTA_REQUESTS    || "10000", 10);
const DAILY_QUOTA_BYTES        = parseInt(process.env.DAILY_QUOTA_BYTES       || "104857600", 10); // 100 MiB
const QRNG_TIMEOUT_MS          = parseInt(process.env.QRNG_REQUEST_TIMEOUT_MS || "10000", 10);
// Número de falhas consecutivas do poller para marcar upstream como DOWN
const UPSTREAM_FAIL_THRESHOLD  = parseInt(process.env.UPSTREAM_FAIL_THRESHOLD || "2", 10);

// Rótulo da fonte, dirigido por env (item 2 da fase de staging). O DEFAULT
// reproduz o comportamento anterior de produção.
const QRNG_SOURCE_LABEL = process.env.QRNG_SOURCE_LABEL || "dobslit-qrng-ufpe-fpga";

// ── Proveniência por RESPOSTA (item 3 da fase) ───────────────────────────────
// QRNG_PROVENANCE deixa de "carimbar" toda resposta. Agora define apenas a
// CAPACIDADE/modo da instância (teto): uma instância "replay"/"fixture"/
// "historical" NUNCA pode rotular uma resposta como "live", e uma instância
// "live" só rotula "live" quando HÁ evidência do caminho live NAQUELA resposta
// (upstream saudável, buffer saudável, amostra recente). O default "live"
// preserva produção, mas produção também passa a precisar da evidência.
const QRNG_CONFIGURED_SOURCE = process.env.QRNG_CONFIGURED_SOURCE || "fpga";
const QRNG_INSTANCE_MODE     = (process.env.QRNG_PROVENANCE || "live").toLowerCase();
// modos: live | replay | fixture | historical   (fallback/unknown são só resultados)
const LIVE_SAMPLE_MAX_AGE_MS = parseInt(process.env.LIVE_SAMPLE_MAX_AGE_MS || "300000", 10); // 5 min
// item 4: por padrão "live" EXIGE evidência de captura (header X-QRNG-Captured-At
// do upstream). Sem ela, actual_origin fica "unknown". Defina
// LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1 para aceitar "upstream saudável servindo
// bytes" como live (com live_verified=false) -- necessário enquanto o
// server_api.py de produção não carimbar captured_at.
const LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE = process.env.LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE === "1";

const { resolveProvenance: _resolveProvenance } = require("./lib/provenance");

function upstreamHealthLabel() {
  // healthy | degraded | failed | unknown -- do poller de fundo (checkUpstream)
  if (!upstreamState || upstreamState.status === "unknown") return "unknown";
  if (upstreamState.status === "up") return consecutiveFailures > 0 ? "degraded" : "healthy";
  return "failed"; // "down"
}

/**
 * Wrapper: injeta o estado da instância (modo, fonte configurada, saúde do
 * poller, idade máxima) na função pura de ./lib/provenance.
 * @param {object} o  ver lib/provenance.resolveProvenance (sem os campos de instância)
 */
function resolveProvenance(o) {
  return _resolveProvenance({
    ...o,
    instanceMode: QRNG_INSTANCE_MODE,
    configuredSource: QRNG_CONFIGURED_SOURCE,
    pollerSourceHealth: upstreamHealthLabel(),
    maxSampleAgeMs: LIVE_SAMPLE_MAX_AGE_MS,
    allowLiveWithoutCaptureEvidence: LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE,
  });
}

/** Escreve a proveniência nos headers de uma resposta binária (raw). */
function setProvenanceHeaders(res, prov) {
  res.setHeader("X-QRNG-Provenance", prov.actual_origin);
  res.setHeader("X-QRNG-Live-Verified", String(prov.live_verified));
  res.setHeader("X-QRNG-Fallback-Used", String(prov.fallback_used));
  res.setHeader("X-QRNG-Source-Health", prov.source_health);
  res.setHeader("X-QRNG-Buffer-Health", prov.buffer_health);
  res.setHeader("X-QRNG-Served-At", prov.served_at);
  if (prov.captured_at) res.setHeader("X-QRNG-Captured-At", prov.captured_at);
  if (prov.capture_id)  res.setHeader("X-QRNG-Capture-Id", prov.capture_id);
  if (prov.sample_age_ms !== null) res.setHeader("X-QRNG-Sample-Age-Ms", String(prov.sample_age_ms));
}

/** Objeto plano de headers do upstream em minúsculas (node-fetch Headers). */
function lowerHeaders(h) {
  const o = {};
  if (h && typeof h.forEach === "function") h.forEach((v, k) => { o[k.toLowerCase()] = v; });
  return o;
}

// ── Agente HTTP sem keep-alive para upstream ──────────────────────────────────
// Evita ECONNRESET em sockets reaproveitados quando o SSH tunnel reinicia.
// Cada request cria uma nova conexão TCP — overhead mínimo para esta carga.
const upstreamAgent = new http.Agent({ keepAlive: false });

// ── Banco de dados ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
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
    quota_daily    INTEGER DEFAULT ${DAILY_QUOTA_REQUESTS},
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
`);

// Migrações não-destrutivas
try { db.exec("ALTER TABLE api_tokens ADD COLUMN user_id INTEGER"); }         catch (_) {}
try { db.exec("ALTER TABLE api_usage_logs ADD COLUMN duration_ms INTEGER"); } catch (_) {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function newRequestId()  { return `req_${crypto.randomBytes(8).toString("hex")}`; }
function generateToken() { return `dobslit_qrng_live_${crypto.randomBytes(20).toString("hex")}`; }
function hashToken(t)    { return crypto.createHash("sha256").update(t).digest("hex"); }
function tokenPrefix(t)  { return t.slice(0, 28); }

function logRequest(requestId, tokenId, endpoint, bytesRequested, format, statusCode, ip, userAgent, durationMs) {
  const now   = new Date().toISOString();
  const today = now.slice(0, 10);

  db.prepare(`
    INSERT INTO api_usage_logs
      (request_id, token_id, endpoint, bytes_requested, format, status_code, ip_address, user_agent, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, tokenId, endpoint, bytesRequested, format, statusCode, ip, userAgent, durationMs ?? null, now);

  db.prepare(`
    INSERT INTO daily_usage (token_id, date, requests_count, bytes_count, errors_count)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(token_id, date) DO UPDATE SET
      requests_count = requests_count + 1,
      bytes_count    = bytes_count    + excluded.bytes_count,
      errors_count   = errors_count   + excluded.errors_count
  `).run(tokenId, today, bytesRequested, statusCode >= 400 ? 1 : 0);

  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, tokenId);
}

// ── CORS ──────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── OpenAPI / Swagger (item 9, spec dividida no item 7 da auditoria) ──────────
// Especificação GERADA a partir dos comentários @openapi acima de cada rota
// deste arquivo (swagger-jsdoc) — nunca escrita manualmente à parte do
// código, para não divergir dele. Cópias estáticas versionadas em
// openapi/qrng-public-v1.yaml e openapi/qrng-internal-admin-v1.yaml
// (regenerar com `npm run openapi:generate`; o CI falha se os arquivos
// commitados divergirem do gerado).
//
// Item 7: a spec pública NUNCA inclui as rotas /admin/* nem o server local
// de desenvolvimento -- ver openapi/spec.js (buildPublicSpec filtra a tag
// "Admin" e remove o server 127.0.0.1). A spec administrativa
// (buildInternalAdminSpec) só documenta essas rotas, e só é servida atrás
// de requireAuth+requireAdmin -- nunca num caminho anônimo.
//
// Montados ANTES do rate limiting global de propósito — documentação não
// deve competir por cota com tráfego de produção, e os limites de
// requisição do serviço em si não fazem sentido aplicados à própria UI de
// docs (mantém as respostas do QRNG protegidas pelo rate limit normal,
// que continua abaixo, aplicado só a partir daqui). O rate limiting global
// por IP AINDA se aplica aos endpoints internos abaixo -- só a autenticação
// é que é adicional a eles.

const swaggerUi = require("swagger-ui-express");
const { buildPublicSpec, buildInternalAdminSpec } = require("./openapi/spec");
const publicOpenapiSpec       = buildPublicSpec();
const internalAdminOpenapiSpec = buildInternalAdminSpec();

app.get("/v1/openapi.json", (_req, res) => res.json(publicOpenapiSpec));

app.use("/v1/docs", swaggerUi.serve, swaggerUi.setup(publicOpenapiSpec, {
  customSiteTitle: "Kapuã QRNG API — Docs",
}));

app.get("/v1/redoc", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <title>Kapuã QRNG API — ReDoc</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body>
    <redoc spec-url="/v1/openapi.json"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
});

// ── Item 7: documentação da API administrativa, SÓ para admins autenticados ───
// Rotas próprias, fora de /v1/openapi.json e /v1/docs públicos, para que um
// scanner anônimo não consiga descobrir a forma da API admin sem antes ter
// uma sessão JWT com role=admin.
//
// LIMITAÇÃO CONHECIDA (auth por header Bearer, não por cookie de sessão):
// requireAuth exige o header Authorization em toda requisição, incluindo o
// carregamento inicial do HTML/JS estático do Swagger UI -- um navegador
// comum não anexa esse header sozinho ao navegar direto para a URL. Um
// admin precisa de uma ferramenta que anexe o header (curl, Postman,
// extensão de REST client) para efetivamente ver /v1/internal/docs; o JSON
// em /v1/internal/admin-openapi.json funciona normalmente via
// `curl -H "Authorization: Bearer <jwt>"`. Preferível a deixar sem
// autenticação nenhuma, mas não é uma UI "clique e veja" para humanos --
// registrado aqui em vez de fingir que é transparente.
app.get("/v1/internal/admin-openapi.json", requireAuth, requireAdmin, (_req, res) => {
  res.json(internalAdminOpenapiSpec);
});

app.use("/v1/internal/docs", requireAuth, requireAdmin, swaggerUi.serve, swaggerUi.setup(internalAdminOpenapiSpec, {
  customSiteTitle: "Kapuã QRNG API — Docs Internas (Admin)",
}));

// ── Rate limiting — global por IP ─────────────────────────────────────────────

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_PER_IP_MIN,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Geração antecipada de request_id ─────────────────────────────────────────

// Aceita o X-Request-Id do cliente para correlação ponta a ponta, SÓ se ele
// tiver um formato seguro (evita injeção em logs). Caso contrário, gera um.
const _SAFE_REQ_ID = /^[A-Za-z0-9_-]{8,64}$/;
function attachRequestId(req, res, next) {
  const inbound = req.headers["x-request-id"];
  req.requestId = (typeof inbound === "string" && _SAFE_REQ_ID.test(inbound))
    ? inbound : newRequestId();
  // ecoa no header da resposta (mesmo em erros) para rastreio em qualquer camada
  if (res && typeof res.setHeader === "function") res.setHeader("X-Request-Id", req.requestId);
  next();
}

// ── Contadores in-memory para métricas (resetam no restart) ──────────────────

const metricsCounters = {
  rate_limited_total:         0,
  quota_requests_exceeded:    0,
  quota_bytes_exceeded:       0,
  // Item 6 da auditoria — endpoint público anônimo: contadores separados dos
  // acima (que só cobrem /v1/random autenticado), para observabilidade
  // independente do tráfego sem token.
  public_requests_total:            0,
  public_rate_limited_total:        0,
  public_quota_requests_exceeded:   0,
  public_quota_bytes_exceeded:      0,
};

// ── Rate limiting — por token (in-memory) ─────────────────────────────────────

const tokenRateMap = new Map(); // tokenId → { count, resetAt }

// .unref(): não impede o processo de encerrar naturalmente quando nada mais
// mantém o event loop vivo. Sem isso, `node --test` (que não força saída por
// padrão) trava indefinidamente após os testes terminarem, porque este
// timer nunca para de se reagendar — mesmo com todas as asserções passando.
// Em produção não muda nada: app.listen() já mantém o processo vivo por
// outro motivo.
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of tokenRateMap) { if (now >= e.resetAt) tokenRateMap.delete(id); }
}, 5 * 60 * 1000).unref();

function checkTokenRate(req, res, next) {
  const tokenId = req.tokenRow.id;
  const now     = Date.now();
  const entry   = tokenRateMap.get(tokenId);
  const window  = 60 * 1000;

  if (!entry || now >= entry.resetAt) {
    tokenRateMap.set(tokenId, { count: 1, resetAt: now + window });
    return next();
  }
  if (entry.count >= RATE_LIMIT_PER_TOKEN_MIN) {
    metricsCounters.rate_limited_total++;
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({
      request_id: req.requestId,
      error: "RATE_LIMIT_EXCEEDED",
      message: `Limite de ${RATE_LIMIT_PER_TOKEN_MIN} req/min por token atingido.`,
      retry_after_seconds: retryAfter,
    });
  }
  entry.count++;
  next();
}

// ── Validação e parsing de bytes ──────────────────────────────────────────────

function parseBytes(req, res, next) {
  const raw = req.query.bytes;
  if (raw === undefined) { req.requestedBytes = 32; return next(); }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return res.status(422).json({
      request_id: req.requestId,
      error: "INVALID_BYTES",
      message: "bytes must be a positive integer",
    });
  }
  if (n > MAX_BYTES_PER_REQUEST) {
    return res.status(413).json({
      request_id: req.requestId,
      error: "REQUEST_TOO_LARGE",
      message: `Maximum allowed size is ${MAX_BYTES_PER_REQUEST} bytes per request.`,
      max_bytes_per_request: MAX_BYTES_PER_REQUEST,
    });
  }
  req.requestedBytes = n;
  next();
}

// ── Cota diária (requests + bytes) ───────────────────────────────────────────

function checkQuota(req, res, next) {
  const { id, quota_daily } = req.tokenRow;
  const today = new Date().toISOString().slice(0, 10);
  const usage = db.prepare("SELECT requests_count, bytes_count FROM daily_usage WHERE token_id = ? AND date = ?").get(id, today);
  const usedRequests = usage?.requests_count || 0;
  const usedBytes    = usage?.bytes_count    || 0;

  if (usedRequests >= quota_daily) {
    metricsCounters.quota_requests_exceeded++;
    return res.status(429).json({
      request_id: req.requestId,
      error: "QUOTA_EXCEEDED",
      message: `Cota diária de ${quota_daily} requests atingida. Resetará à meia-noite UTC.`,
      quota_daily_requests: quota_daily,
      requests_today: usedRequests,
    });
  }

  const requestedBytes = req.requestedBytes || 0;
  if (requestedBytes > 0 && usedBytes + requestedBytes > DAILY_QUOTA_BYTES) {
    metricsCounters.quota_bytes_exceeded++;
    return res.status(429).json({
      request_id: req.requestId,
      error: "QUOTA_BYTES_EXCEEDED",
      message: `Cota diária de ${DAILY_QUOTA_BYTES} bytes atingida. Resetará à meia-noite UTC.`,
      quota_daily_bytes: DAILY_QUOTA_BYTES,
      bytes_today: usedBytes,
      bytes_requested: requestedBytes,
    });
  }

  next();
}

// ── Middleware de autenticação ────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "MISSING_TOKEN", message: "Faça login primeiro." });
  }
  try {
    req.user = jwt.verify(auth.slice(7).trim(), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "SESSION_EXPIRED", message: "Sessão expirada. Faça login novamente." });
  }
}

// Reconsulta o papel no banco em vez de confiar no claim do JWT — mesma
// razão do bongosite-auth: um token só carrega o papel de quando foi
// assinado, não o atual.
function requireAdmin(req, res, next) {
  const dbUser = db.prepare("SELECT role FROM users WHERE id = ?").get(req.user?.sub);
  if (!dbUser || dbUser.role !== "admin") {
    return res.status(403).json({ error: "FORBIDDEN", message: "Acesso restrito a administradores." });
  }
  next();
}

// API token — para /random e /health (machine-to-machine)
function requireToken(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ request_id: req.requestId, error: "MISSING_TOKEN", message: "Use Authorization: Bearer <api_token>" });
  }
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(auth.slice(7).trim()));
  if (!row) return res.status(403).json({ request_id: req.requestId, error: "INVALID_TOKEN", message: "Token inválido ou revogado." });
  req.tokenRow = row;
  next();
}

// Dual auth — para /me/* (aceita JWT ou API token)
function resolveUser(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Autenticação necessária." });
  }
  const raw = auth.slice(7).trim();
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    req.user     = payload;
    req.tokenRow = db.prepare("SELECT * FROM api_tokens WHERE user_id = ? AND status = 'active'").get(payload.sub) || null;
    req.authMode = "jwt";
    return next();
  } catch (_) {}
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(raw));
  if (row) { req.tokenRow = row; req.authMode = "token"; return next(); }
  return res.status(401).json({ error: "UNAUTHORIZED", message: "Token ou sessão inválidos." });
}

// ── Upstream helper ───────────────────────────────────────────────────────────

async function fetchWithTimeout(url, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // keepAlive: false → nova conexão TCP por request
    // Evita ECONNRESET em sockets reaproveitados quando o SSH tunnel reinicia.
    return await fetch(url, { signal: ctrl.signal, agent: upstreamAgent });
  } finally {
    clearTimeout(timer);
  }
}

// ── Auth: registro e login ────────────────────────────────────────────────────

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Cria uma conta de usuário e retorna um JWT de sessão.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Conta criada.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400:
 *         description: Campos ausentes, senha curta (< 8), ou JSON inválido (error=INVALID_JSON).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: E-mail já cadastrado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 */
app.post("/v1/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "MISSING_FIELDS", message: "Email e senha são obrigatórios." });
  if (password.length < 8) return res.status(400).json({ error: "WEAK_PASSWORD", message: "Senha mínima: 8 caracteres." });
  const role = ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL ? "admin" : "user";
  const now  = new Date().toISOString();
  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run(email.toLowerCase(), hash, role, now);
    const token  = jwt.sign({ sub: result.lastInsertRowid, email: email.toLowerCase(), role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, email: email.toLowerCase(), role });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "EMAIL_TAKEN", message: "Este e-mail já está cadastrado." });
    throw err;
  }
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Autentica com e-mail/senha e retorna um JWT de sessão.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login bem-sucedido.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AuthResponse' } } }
 *       401:
 *         description: E-mail ou senha incorretos.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 */
app.post("/v1/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "MISSING_FIELDS" });
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "E-mail ou senha incorretos." });
  }
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, email: user.email, role: user.role });
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Retorna os dados da conta autenticada.
 *     security: [{ bearerAuthJWT: [] }]
 *     responses:
 *       200:
 *         description: Dados do usuário.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer }
 *                 email: { type: string, format: email }
 *                 role: { type: string, enum: [user, admin] }
 *                 created_at: { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
app.get("/v1/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(req.user.sub);
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  res.json(user);
});

// ── POST /v1/tokens ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /tokens:
 *   post:
 *     tags: [Tokens]
 *     summary: Emite o token de API pessoal (um por usuário).
 *     description: >
 *       O valor completo do token só é retornado nesta chamada -- apenas o
 *       prefixo fica recuperável depois via GET /me/token. Use
 *       /me/token/rotate para gerar um novo se perdê-lo.
 *     security: [{ bearerAuthJWT: [] }]
 *     responses:
 *       200:
 *         description: Token criado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TokenIssued' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409:
 *         description: Usuário já tem um token ativo.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/tokens", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT id FROM api_tokens WHERE user_id = ? AND status = 'active'").get(req.user.sub);
  if (existing) {
    return res.status(409).json({ error: "TOKEN_EXISTS", message: "Você já tem um token ativo. Use POST /v1/me/token/rotate para regenerar." });
  }
  const raw = generateToken();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO api_tokens (user_id, token_prefix, token_hash, name, status, quota_daily, created_at)
    VALUES (?, ?, ?, 'Token principal', 'active', ?, ?)
  `).run(req.user.sub, tokenPrefix(raw), hashToken(raw), DAILY_QUOTA_REQUESTS, now);
  res.json({ message: "Token criado. Guarde-o agora — não será exibido novamente.", token: raw, prefix: tokenPrefix(raw), created_at: now });
});

// ── GET /v1/me/token ──────────────────────────────────────────────────────────

/**
 * @openapi
 * /me/token:
 *   get:
 *     tags: [Tokens]
 *     summary: Retorna metadados do token ativo (nunca o valor completo).
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Metadados do token, ou { has_token false } se nenhum existir.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TokenInfo' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
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

/**
 * @openapi
 * /me/token/rotate:
 *   post:
 *     tags: [Tokens]
 *     summary: Revoga o token atual e emite um novo (mesma cota/nome).
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Novo token emitido.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TokenIssued' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Nenhum token ativo encontrado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/me/token/rotate", resolveUser, (req, res) => {
  const old = req.tokenRow;
  if (!old) return res.status(404).json({ error: "NO_TOKEN", message: "Nenhum token ativo encontrado." });
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

/**
 * @openapi
 * /me/token/revoke:
 *   post:
 *     tags: [Tokens]
 *     summary: Revoga o token ativo (sem emitir um novo).
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Token revogado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 revoked_at: { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Nenhum token ativo encontrado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/me/token/revoke", resolveUser, (req, res) => {
  const row = req.tokenRow;
  if (!row) return res.status(404).json({ error: "NO_TOKEN" });
  const now = new Date().toISOString();
  db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, row.id);
  res.json({ message: "Token revogado com sucesso.", revoked_at: now });
});

// ── GET /v1/me/usage ──────────────────────────────────────────────────────────

/**
 * @openapi
 * /me/usage:
 *   get:
 *     tags: [Usage]
 *     summary: Cota diária, uso hoje/7d/30d e histórico diário do token.
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Resumo de uso.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UsageResponse' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
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

  const requestsToday = todayRow?.requests_count || 0;
  const bytesToday    = todayRow?.bytes_count    || 0;

  res.json({
    has_token: true,
    token_name: name,
    status,
    quota_daily_requests:      quota_daily,
    quota_daily_bytes:         DAILY_QUOTA_BYTES,
    max_bytes_per_request:     MAX_BYTES_PER_REQUEST,
    requests_today:            requestsToday,
    bytes_today:               bytesToday,
    remaining_requests_today:  Math.max(0, quota_daily - requestsToday),
    remaining_bytes_today:     Math.max(0, DAILY_QUOTA_BYTES - bytesToday),
    requests_7d:               row7?.r  || 0,
    bytes_7d:                  row7?.b  || 0,
    requests_30d:              row30?.r || 0,
    bytes_30d:                 row30?.b || 0,
    last_used_at,
    daily_history: history,
  });
});

// ── GET /v1/me/requests ───────────────────────────────────────────────────────

/**
 * @openapi
 * /me/requests:
 *   get:
 *     tags: [Usage]
 *     summary: Histórico das últimas chamadas feitas com o token.
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }]
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 20, maximum: 10000 }
 *         description: Máximo de entradas a retornar.
 *     responses:
 *       200:
 *         description: Lista de requisições (mais recentes primeiro).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requests:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/RequestLogEntry' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
app.get("/v1/me/requests", resolveUser, (req, res) => {
  const row = req.tokenRow;
  if (!row) return res.json({ requests: [] });
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 10000);
  const logs  = db.prepare(`
    SELECT request_id, endpoint, bytes_requested, format, status_code, ip_address, duration_ms, created_at
    FROM api_usage_logs WHERE token_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(row.id, limit);
  res.json({ requests: logs });
});

// ── GET /v1/upstream/status ───────────────────────────────────────────────────

/**
 * @openapi
 * /upstream/status:
 *   get:
 *     tags: [Health]
 *     summary: Histórico de disponibilidade do upstream FPGA (últimas 500 transições, uptime 24h).
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Status atual, uptime estimado nas últimas 24h e eventos recentes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current:
 *                   type: object
 *                   properties:
 *                     status: { type: string, enum: [up, down, unknown] }
 *                     checkedAt: { type: string, format: date-time, nullable: true }
 *                     responseMs: { type: integer, nullable: true }
 *                 uptime_24h_pct: { type: number, nullable: true }
 *                 recent_events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       status: { type: string }
 *                       response_ms: { type: integer, nullable: true }
 *                       detail: { type: string, nullable: true }
 *                       checked_at: { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
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

  res.json({
    current:        upstreamState,
    uptime_24h_pct: slice.length > 0 ? Math.round((uptimeMs / (now - windowStart)) * 1000) / 10 : null,
    recent_events:  events,
  });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /admin/tokens:
 *   get:
 *     tags: [Admin]
 *     summary: Lista todos os tokens de todos os usuários (requer role=admin).
 *     security: [{ bearerAuthJWT: [] }]
 *     responses:
 *       200:
 *         description: Lista de tokens com uso de hoje.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokens:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       user_id: { type: integer }
 *                       token_prefix: { type: string }
 *                       name: { type: string }
 *                       status: { type: string }
 *                       quota_daily: { type: integer }
 *                       created_at: { type: string, format: date-time }
 *                       last_used_at: { type: string, format: date-time, nullable: true }
 *                       email: { type: string, format: email }
 *                       requests_today: { type: integer }
 *                       bytes_today: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
app.get("/v1/admin/tokens", requireAuth, requireAdmin, (req, res) => {
  const today  = new Date().toISOString().slice(0, 10);
  const tokens = db.prepare(`
    SELECT t.id, t.user_id, t.token_prefix, t.name, t.status, t.quota_daily,
           t.created_at, t.last_used_at, u.email,
           COALESCE(d.requests_count, 0) AS requests_today,
           COALESCE(d.bytes_count, 0)    AS bytes_today
    FROM api_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN daily_usage d ON d.token_id = t.id AND d.date = ?
    ORDER BY t.created_at DESC
  `).all(today);
  res.json({ tokens });
});

/**
 * @openapi
 * /admin/tokens/{id}/revoke:
 *   post:
 *     tags: [Admin]
 *     summary: Revoga o token de qualquer usuário (requer role=admin).
 *     security: [{ bearerAuthJWT: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Token revogado.
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: Token não encontrado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/admin/tokens/:id/revoke", requireAuth, requireAdmin, (req, res) => {
  const now    = new Date().toISOString();
  const result = db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ message: "Token revogado.", revoked_at: now });
});

/**
 * @openapi
 * /admin/tokens/{id}/quota:
 *   patch:
 *     tags: [Admin]
 *     summary: Ajusta a cota diária de requisições de um token (requer role=admin).
 *     security: [{ bearerAuthJWT: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quota_daily]
 *             properties:
 *               quota_daily: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Cota atualizada.
 *       400:
 *         description: quota_daily ausente ou inválida.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: Token não encontrado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 */
app.patch("/v1/admin/tokens/:id/quota", requireAuth, requireAdmin, (req, res) => {
  const quota  = parseInt(req.body.quota_daily, 10);
  if (!quota || quota < 1) return res.status(400).json({ error: "INVALID_QUOTA" });
  const result = db.prepare("UPDATE api_tokens SET quota_daily = ? WHERE id = ?").run(quota, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ message: "Cota atualizada.", quota_daily: quota });
});

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: Lista todos os usuários (requer role=admin).
 *     security: [{ bearerAuthJWT: [] }]
 *     responses:
 *       200:
 *         description: Lista de usuários.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       email: { type: string, format: email }
 *                       role: { type: string }
 *                       created_at: { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
app.get("/v1/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC").all();
  res.json({ users });
});

// ── GET /v1/health ────────────────────────────────────────────────────────────

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Saúde do client-api e do upstream FPGA (requer token).
 *     description: >
 *       Diferente de /health/self (liveness do processo Node), esta rota
 *       consulta o upstream FPGA de verdade -- reflete se a fonte física
 *       está acessível AGORA, não apenas se a API está no ar.
 *     security: [{ bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Upstream respondeu.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/HealthResponse' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       503: { $ref: '#/components/responses/UpstreamError' }
 */
app.get("/v1/health", attachRequestId, requireToken, checkTokenRate, async (req, res) => {
  const requestId = req.requestId;
  const t0        = Date.now();
  const ip        = req.ip || req.socket.remoteAddress;
  const ua        = req.headers["user-agent"];
  try {
    const r    = await fetchWithTimeout(`${QRNG_UPSTREAM}/health`, QRNG_TIMEOUT_MS);
    const data = await r.json();
    const upHdr = lowerHeaders(r.headers);
    // /health não entrega bytes de amostra -> não há evidência de caminho live
    // NESTA resposta; a proveniência aqui reflete a CAPACIDADE + saúde atual,
    // com actual_origin nunca "live" (só /random pode provar live).
    const srcStatus = (data && data.source_status) || upHdr["x-qrng-source-status"];
    const prov = resolveProvenance({
      servedFromUpstream: false,
      upstreamReachable: true,
      upstreamHeaders: { ...upHdr, ...(srcStatus ? { "x-qrng-source-status": String(srcStatus) } : {}) },
    });
    logRequest(requestId, req.tokenRow.id, "/v1/health", 0, null, 200, ip, ua, Date.now() - t0);
    res.json({ request_id: requestId, status: "ok", api: "dobslit-qrng-client-api", source: QRNG_SOURCE_LABEL, provenance: prov.actual_origin, provenance_detail: prov, upstream: data });
  } catch {
    logRequest(requestId, req.tokenRow.id, "/v1/health", 0, null, 503, ip, ua, Date.now() - t0);
    const prov = resolveProvenance({ servedFromUpstream: false });
    res.status(503).json({ request_id: requestId, status: "error", message: "QRNG upstream unavailable", provenance: prov.actual_origin, provenance_detail: prov });
  }
});

// ── Contrato do upstream FPGA ────────────────────────────────────────────────
//
// O upstream (QRNG_UPSTREAM) é interpretado por CONTRATO EXPLÍCITO baseado no
// header Content-Type que ele declara — nunca por inspeção heurística do
// conteúdo do corpo. Um payload binário que, por coincidência, contenha
// bytes que parecem JSON, decimal ou dígitos ASCII NUNCA é reinterpretado:
// só o Content-Type decide qual parser roda.
//
// Suportado no caminho normal (sem flag):
//   application/octet-stream → bytes brutos, pass-through estrito, sem parsing.
//   application/json         → { bytes: [...] } | { hex: "..." } | { random: "..." }
//
// Desativado por padrão (formatos históricos "UFPE/FPGA" — texto decimal
// separado por vírgula/espaço, ou dígitos decimais empacotados de 3 em 3):
//   text/plain → só é aceito com ALLOW_LEGACY_TEXT_UPSTREAM=true na env.
//
// Qualquer Content-Type ausente, desconhecido, ou corpo que não bate com o
// Content-Type declarado → falha explícita (UpstreamFormatError), nunca
// fallback silencioso para pass-through binário.

const ALLOW_LEGACY_TEXT_UPSTREAM = process.env.ALLOW_LEGACY_TEXT_UPSTREAM === "true";

class UpstreamFormatError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UpstreamFormatError";
    this.code = code || "UPSTREAM_FORMAT_ERROR";
  }
}

// Só é chamado quando Content-Type: text/plain E ALLOW_LEGACY_TEXT_UPSTREAM=true.
// Nunca faz parte do caminho normal nem é usado por sniffing de conteúdo.
function parseLegacyTextUpstream(text, _requestedBytes) {
  if (/^[0-9,\s]+$/.test(text) && /[\s,]/.test(text)) {
    const values = text.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
    if (values.length > 0) return Buffer.from(values);
  }
  if (/^[0-9]+$/.test(text)) {
    const result = [];
    for (let i = 0; i + 3 <= text.length; i += 3) {
      const val = parseInt(text.slice(i, i + 3), 10);
      if (val <= 255) result.push(val);
    }
    if (result.length > 0) return Buffer.from(result);
  }
  throw new UpstreamFormatError(
    "Upstream declarou text/plain (formato legado habilitado via ALLOW_LEGACY_TEXT_UPSTREAM), mas o corpo não é decimal reconhecível (nem 'n,n,n...' nem dígitos empacotados de 3 em 3).",
    "UPSTREAM_LEGACY_TEXT_UNPARSEABLE"
  );
}

/**
 * Interpreta o corpo do upstream por contrato de Content-Type. Lança
 * UpstreamFormatError para qualquer situação ambígua, incompleta ou não
 * suportada — nunca adivinha a partir do conteúdo.
 *
 * NÃO trunca nem preenche o resultado para `requestedBytes`: apenas decodifica
 * o que o Content-Type promete. A checagem de "bytes suficientes para atender
 * o pedido do cliente" acontece no chamador (rota /v1/random), que já sabe
 * quanto pediu ao upstream (upBytes, sobre-provisionado) versus quanto o
 * cliente final pediu (requestedBytes).
 */
function interpretUpstreamResponse(contentType, rawBuffer, requestedBytes) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();

  if (ct === "") {
    throw new UpstreamFormatError(
      "Upstream não declarou Content-Type. O contrato exige application/octet-stream ou application/json explícitos — nenhuma heurística de conteúdo é aplicada.",
      "UPSTREAM_MISSING_CONTENT_TYPE"
    );
  }

  if (ct === "application/octet-stream") {
    // Pass-through estrito: os bytes recebidos SÃO o resultado, sem nenhuma
    // tentativa de reinterpretação — mesmo que, por coincidência, pareçam
    // texto ASCII decimal, JSON, etc.
    return rawBuffer;
  }

  if (ct === "application/json") {
    let json;
    try {
      json = JSON.parse(rawBuffer.toString("utf8"));
    } catch (e) {
      throw new UpstreamFormatError(
        `Upstream declarou application/json mas o corpo não é JSON válido: ${e.message}`,
        "UPSTREAM_INVALID_JSON"
      );
    }
    if (Array.isArray(json.bytes)) {
      if (!json.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        throw new UpstreamFormatError("Upstream JSON: campo 'bytes' contém valores fora de [0,255] ou não inteiros.", "UPSTREAM_JSON_SCHEMA_MISMATCH");
      }
      return Buffer.from(json.bytes);
    }
    if (typeof json.hex === "string")    return Buffer.from(json.hex, "hex");
    if (typeof json.random === "string") return Buffer.from(json.random, "hex");
    throw new UpstreamFormatError(
      "Upstream declarou application/json mas nenhum campo reconhecido (bytes[] | hex | random) foi encontrado.",
      "UPSTREAM_JSON_SCHEMA_MISMATCH"
    );
  }

  if (ct === "text/plain") {
    if (!ALLOW_LEGACY_TEXT_UPSTREAM) {
      throw new UpstreamFormatError(
        "Upstream declarou text/plain (formato legado de dígitos decimais), mas ALLOW_LEGACY_TEXT_UPSTREAM não está habilitado nesta instância. " +
        "Formatos de texto decimal ficam desativados por padrão — habilite a env var explicitamente somente se o upstream atual realmente usa esse formato.",
        "UPSTREAM_LEGACY_FORMAT_DISABLED"
      );
    }
    return parseLegacyTextUpstream(rawBuffer.toString("utf8").trim(), requestedBytes);
  }

  throw new UpstreamFormatError(
    `Upstream declarou Content-Type não suportado pelo contrato: '${contentType}'.`,
    "UPSTREAM_UNSUPPORTED_CONTENT_TYPE"
  );
}

// ── GET /v1/random ────────────────────────────────────────────────────────────

/**
 * @openapi
 * /random:
 *   get:
 *     tags: [Random]
 *     summary: Gera bytes aleatórios da fonte QRNG (FPGA Red Pitaya, uint32-LE, sem conditioning).
 *     description: >
 *       Confirmado no código-fonte de todo o pipeline físico (auditoria 2026-08-25):
 *       o upstream lê um registrador AXI FIFO diretamente via mmap na Red Pitaya e
 *       grava exatamente 4 bytes little-endian por amostra, sem nenhum processamento
 *       (whitening/debiasing/conditioning). Esta rota entrega esses bytes brutos --
 *       nenhuma avaliação de entropia é feita aqui; ver a suíte NIST SP 800-90B
 *       separadamente para isso.
 *     security: [{ bearerAuthToken: [] }]
 *     parameters:
 *       - name: bytes
 *         in: query
 *         schema: { type: integer, minimum: 1, default: 32 }
 *         description: Quantidade de bytes a gerar. Limite por requisição = MAX_BYTES_PER_REQUEST (padrão 1 MiB).
 *       - name: format
 *         in: query
 *         schema: { type: string, enum: [hex, base64, uint8, raw] }
 *         description: >
 *           hex (default — inclusive quando o parâmetro é OMITIDO): JSON RandomResponse
 *           com `random` = string hexadecimal de 2N caracteres.
 *           base64: JSON RandomResponse com `random` = string base64 dos N bytes.
 *           uint8: JSON RandomResponse com `random` = array de N inteiros [0,255].
 *           raw: corpo application/octet-stream com EXATAMENTE os N bytes brutos —
 *           sem JSON, sem texto, sem prefixo, sem BOM; request_id e proveniência vão
 *           nos headers X-Request-Id / X-QRNG-Source / X-QRNG-Conditioned.
 *           COMPATIBILIDADE: omitir `format` retorna JSON (hex), NÃO binário — o binário
 *           exige `format=raw` explícito, ou a rota dedicada GET /raw.
 *     responses:
 *       200:
 *         description: >
 *           Bytes gerados. format=hex|base64|uint8 (ou omitido) → application/json
 *           (RandomResponse). format=raw → application/octet-stream com N bytes exatos.
 *         headers:
 *           X-Request-Id:
 *             schema: { type: string }
 *             description: Identificador da requisição (também no corpo quando a resposta é JSON).
 *           X-QRNG-Source:
 *             schema: { type: string }
 *             description: "Proveniência da fonte (ex.: dobslit-qrng-ufpe-fpga). Presente em format=raw."
 *           X-QRNG-Conditioned:
 *             schema: { type: string, enum: ['false'] }
 *             description: "Sempre 'false' — bytes não condicionados. Presente em format=raw."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/RandomResponse' }
 *           application/octet-stream:
 *             schema: { type: string, format: binary }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       413:
 *         description: bytes acima de MAX_BYTES_PER_REQUEST.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       422:
 *         description: bytes ou format inválidos.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       429_quota:
 *         description: (usa código 429) Cota diária de requisições ou bytes excedida.
 *       502:
 *         description: >
 *           Upstream retornou erro OU o Content-Type declarado não é
 *           suportado pelo contrato (UPSTREAM_UNSUPPORTED_CONTENT_TYPE,
 *           UPSTREAM_MISSING_CONTENT_TYPE, UPSTREAM_INVALID_JSON,
 *           UPSTREAM_JSON_SCHEMA_MISMATCH, UPSTREAM_LENGTH_MISMATCH,
 *           UPSTREAM_LEGACY_FORMAT_DISABLED) -- ver interpretUpstreamResponse().
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503:
 *         description: Upstream indisponível, timeout, ou buffer com menos bytes que o pedido (INSUFFICIENT_ENTROPY).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
const RANDOM_FORMATS = ["hex", "base64", "uint8", "raw"];

// GET /raw é um alias explícito de GET /random?format=raw (mesma cadeia de
// middleware). res.locals.forceRawFormat força o modo binário mesmo sem a query.
async function randomHandler(req, res) {
  const bytes     = req.requestedBytes;
  const format    = res.locals.forceRawFormat ? "raw" : (req.query.format || "hex");
  const ip        = req.ip || req.socket.remoteAddress;
  const ua        = req.headers["user-agent"];
  const requestId = req.requestId;
  const t0        = Date.now();

  if (!RANDOM_FORMATS.includes(format)) {
    return res.status(422).json({
      request_id: requestId,
      error: "INVALID_FORMAT",
      message: "Use format=hex, base64, uint8 ou raw",
    });
  }

  try {
    const upBytes = Math.min(bytes * 20, 50 * 1024 * 1024);
    const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/random?bytes=${upBytes}`, QRNG_TIMEOUT_MS);

    if (!r.ok) {
      logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 502, ip, ua, Date.now() - t0);
      const prov = resolveProvenance({ servedFromUpstream: false, upstreamHeaders: lowerHeaders(r.headers) });
      return res.status(502).json({ request_id: requestId, error: "UPSTREAM_ERROR", status: r.status, provenance: prov.actual_origin, provenance_detail: prov });
    }

    const contentType        = r.headers.get("content-type");
    const contentLengthHeader = r.headers.get("content-length");
    const rawBuffer          = await r.buffer();

    // Content-Length é validado ANTES de qualquer interpretação: se o
    // transporte já mente sobre o tamanho, não há por que confiar no corpo.
    if (contentLengthHeader !== null && Number(contentLengthHeader) !== rawBuffer.length) {
      logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 502, ip, ua, Date.now() - t0);
      return res.status(502).json({
        request_id: requestId,
        error: "UPSTREAM_LENGTH_MISMATCH",
        message: `Content-Length declarado (${contentLengthHeader}) não bate com bytes efetivamente recebidos (${rawBuffer.length}).`,
      });
    }

    let buf;
    try {
      buf = interpretUpstreamResponse(contentType, rawBuffer, bytes);
    } catch (err) {
      if (err instanceof UpstreamFormatError) {
        logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 502, ip, ua, Date.now() - t0);
        return res.status(502).json({ request_id: requestId, error: err.code, message: err.message });
      }
      throw err;
    }

    const upHdr = lowerHeaders(r.headers);

    if (buf.length < bytes) {
      logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua, Date.now() - t0);
      const prov = resolveProvenance({ servedFromUpstream: false, upstreamHeaders: upHdr, insufficientEntropy: true });
      return res.status(503).json({ request_id: requestId, error: "INSUFFICIENT_ENTROPY", available: buf.length, requested: bytes, provenance: prov.actual_origin, provenance_detail: prov });
    }
    buf = buf.slice(0, bytes); // upBytes é sobre-provisionado; entrega exatamente o pedido

    logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 200, ip, ua, Date.now() - t0);

    const prov = resolveProvenance({ servedFromUpstream: true, upstreamHeaders: upHdr });

    if (format === "raw") {
      // Corpo = EXATAMENTE os N bytes brutos, nada mais. request_id e
      // proveniência só nos headers -- nunca dentro do corpo binário.
      res.status(200);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Request-Id", requestId);
      res.setHeader("X-QRNG-Source", QRNG_SOURCE_LABEL);
      res.setHeader("X-QRNG-Conditioned", "false");
      setProvenanceHeaders(res, prov);
      return res.end(buf); // res.end (não res.send): zero transformação do Buffer
    }

    const random = format === "hex"    ? buf.toString("hex")
                 : format === "base64" ? buf.toString("base64")
                 : Array.from(buf);

    // Proveniência também nos headers nas respostas JSON (paridade com raw):
    // consumidores — inclusive instrumentação de teste — podem lê-la sem
    // baixar/parsear o corpo. O corpo continua trazendo `provenance_detail`.
    setProvenanceHeaders(res, prov);
    res.json({ request_id: requestId, source: QRNG_SOURCE_LABEL, provenance: prov.actual_origin, provenance_detail: prov, bytes, format, random, timestamp: new Date().toISOString() });

  } catch (err) {
    logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua, Date.now() - t0);
    const prov = resolveProvenance({ servedFromUpstream: false });
    res.status(503).json({ request_id: requestId, error: "QRNG_UNAVAILABLE", detail: err.message, provenance: prov.actual_origin, provenance_detail: prov });
  }
}

const randomChain = [attachRequestId, requireToken, checkTokenRate, parseBytes, checkQuota];
app.get("/v1/random", ...randomChain, randomHandler);

/**
 * @openapi
 * /raw:
 *   get:
 *     tags: [Random]
 *     summary: Alias binário explícito de GET /random?format=raw — application/octet-stream com N bytes exatos.
 *     description: >
 *       Idêntico a GET /random?format=raw. Rota própria para consumidores que
 *       só querem os bytes crus sem lidar com o parâmetro format. NUNCA retorna
 *       JSON: o corpo são EXATAMENTE os N bytes (Content-Length = N), sem
 *       prefixo, texto ou BOM. request_id e proveniência vão nos headers
 *       X-Request-Id / X-QRNG-Source / X-QRNG-Conditioned.
 *     security: [{ bearerAuthToken: [] }]
 *     parameters:
 *       - name: bytes
 *         in: query
 *         schema: { type: integer, minimum: 1, default: 32 }
 *         description: Quantidade de bytes. Limite = MAX_BYTES_PER_REQUEST (padrão 1 MiB).
 *     responses:
 *       200:
 *         description: N bytes brutos (application/octet-stream, Content-Length = N).
 *         headers:
 *           X-Request-Id: { schema: { type: string }, description: Identificador da requisição. }
 *           X-QRNG-Source: { schema: { type: string }, description: Proveniência da fonte. }
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['false'] }, description: Sempre 'false'. }
 *         content:
 *           application/octet-stream:
 *             schema: { type: string, format: binary }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       413: { description: bytes acima de MAX_BYTES_PER_REQUEST., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       422: { description: bytes inválido., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       502: { description: Upstream com erro ou formato inesperado., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       503: { description: Upstream indisponível ou entropia insuficiente., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
app.get("/v1/raw", ...randomChain, (req, res) => { res.locals.forceRawFormat = true; return randomHandler(req, res); });

// ── GET /v1/public/random — endpoint público anônimo (item 6 da auditoria) ────
//
// STAGING ONLY até autorização explícita de produção (ver relatório da
// auditoria). Este endpoint existe para substituir o bypass direto do Nginx
// para o broker QRNG (proxy_pass para 127.0.0.1:18001 em nginx.conf, sem
// nenhuma autenticação/rate-limit/cota) por um caminho controlado dentro
// desta API: rate limit por IP dedicado (mais restrito que o limite global
// de RATE_LIMIT_PER_IP_MIN acima), cota diária por IP (mais restrita que a
// cota por token), tamanho máximo por requisição menor, Cache-Control:
// no-store, request_id em corpo E header, e log/métricas próprios. Usuários
// autenticados continuam usando /v1/random (token pessoal) para cotas
// maiores -- este endpoint nunca eleva privilégio, só abre um caminho mais
// estreito para acesso sem conta.
//
// Nginx deve apontar o caminho público EXCLUSIVAMENTE para esta rota, nunca
// para o app inteiro -- isso é o que efetivamente "bloqueia rotas internas"
// (admin/auth/tokens/me/upstream-status continuam inacessíveis a quem entra
// por esse caminho, porque o proxy nunca encaminha para elas).

const PUBLIC_MAX_BYTES_PER_REQUEST   = parseInt(process.env.PUBLIC_MAX_BYTES_PER_REQUEST        || "65536", 10);            // 64 KiB
const PUBLIC_RATE_LIMIT_PER_IP_MIN   = parseInt(process.env.PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE  || "20", 10);
const PUBLIC_DAILY_QUOTA_REQUESTS_IP = parseInt(process.env.PUBLIC_DAILY_QUOTA_REQUESTS_PER_IP   || "500", 10);
const PUBLIC_DAILY_QUOTA_BYTES_IP    = parseInt(process.env.PUBLIC_DAILY_QUOTA_BYTES_PER_IP      || String(10 * 1024 * 1024), 10); // 10 MiB

const publicIpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PUBLIC_RATE_LIMIT_PER_IP_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    metricsCounters.public_rate_limited_total++;
    res.status(429).json({
      request_id: req.requestId,
      error: "RATE_LIMIT_EXCEEDED",
      message: `Limite de ${PUBLIC_RATE_LIMIT_PER_IP_MIN} req/min por IP neste endpoint público. Para limites maiores, crie uma conta e use um token pessoal em /v1/random.`,
    });
  },
});

// Cota diária por IP, em memória (reseta em restart -- aceitável para uma
// cota de acesso anônimo, ao contrário da cota por token que é persistida
// em SQLite). Limpa entradas de dias anteriores periodicamente para não
// crescer sem limite com IPs distintos ao longo do tempo.
const publicIpDailyUsage = new Map(); // ip → { date, requests, bytes }

setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [ip, entry] of publicIpDailyUsage) {
    if (entry.date !== today) publicIpDailyUsage.delete(ip);
  }
}, 60 * 60 * 1000).unref();

function checkPublicQuota(req, res, next) {
  const ip    = req.ip || req.socket.remoteAddress;
  const today = new Date().toISOString().slice(0, 10);
  let entry = publicIpDailyUsage.get(ip);
  if (!entry || entry.date !== today) {
    entry = { date: today, requests: 0, bytes: 0 };
    publicIpDailyUsage.set(ip, entry);
  }

  if (entry.requests >= PUBLIC_DAILY_QUOTA_REQUESTS_IP) {
    metricsCounters.public_quota_requests_exceeded++;
    return res.status(429).json({
      request_id: req.requestId,
      error: "QUOTA_EXCEEDED",
      message: `Cota diária pública de ${PUBLIC_DAILY_QUOTA_REQUESTS_IP} requests por IP atingida. Resetará à meia-noite UTC. Para cotas maiores, crie uma conta e use um token pessoal em /v1/random.`,
      quota_daily_requests: PUBLIC_DAILY_QUOTA_REQUESTS_IP,
      requests_today: entry.requests,
    });
  }

  const requestedBytes = req.requestedBytes || 0;
  if (requestedBytes > 0 && entry.bytes + requestedBytes > PUBLIC_DAILY_QUOTA_BYTES_IP) {
    metricsCounters.public_quota_bytes_exceeded++;
    return res.status(429).json({
      request_id: req.requestId,
      error: "QUOTA_BYTES_EXCEEDED",
      message: `Cota diária pública de ${PUBLIC_DAILY_QUOTA_BYTES_IP} bytes por IP atingida. Resetará à meia-noite UTC. Para cotas maiores, crie uma conta e use um token pessoal em /v1/random.`,
      quota_daily_bytes: PUBLIC_DAILY_QUOTA_BYTES_IP,
      bytes_today: entry.bytes,
      bytes_requested: requestedBytes,
    });
  }

  next();
}

function recordPublicUsage(ip, bytesRequested) {
  const entry = publicIpDailyUsage.get(ip);
  if (!entry) return; // checkPublicQuota sempre roda antes e cria a entrada
  entry.requests++;
  entry.bytes += bytesRequested;
}

function parsePublicBytes(req, res, next) {
  const raw = req.query.bytes;
  if (raw === undefined) { req.requestedBytes = 32; return next(); }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return res.status(422).json({
      request_id: req.requestId,
      error: "INVALID_BYTES",
      message: "bytes must be a positive integer",
    });
  }
  if (n > PUBLIC_MAX_BYTES_PER_REQUEST) {
    return res.status(413).json({
      request_id: req.requestId,
      error: "REQUEST_TOO_LARGE",
      message: `Endpoint público: máximo de ${PUBLIC_MAX_BYTES_PER_REQUEST} bytes por requisição. Para lotes maiores, use um token pessoal em /v1/random (limite ${MAX_BYTES_PER_REQUEST} bytes).`,
      max_bytes_per_request: PUBLIC_MAX_BYTES_PER_REQUEST,
    });
  }
  req.requestedBytes = n;
  next();
}

/**
 * @openapi
 * /public/random:
 *   get:
 *     tags: [Random]
 *     summary: Gera bytes aleatórios da fonte QRNG sem autenticação (acesso público, cota reduzida).
 *     description: >
 *       Mesma fonte física de /random (FPGA Red Pitaya via broker QRNG, uint32-LE,
 *       sem conditioning) -- ver descrição completa em /random. Este caminho NÃO
 *       exige token, mas aplica limites bem mais restritos por IP (rate limit,
 *       cota diária de requisições e bytes, tamanho máximo por requisição). Para
 *       cotas maiores, crie uma conta e use um token pessoal em /random.
 *       Resposta sempre com Cache-Control: no-store (nunca cacheie entropia).
 *       SEM fallback: se o broker físico não responder ou responder em
 *       formato inesperado, a requisição falha explicitamente (502/503) --
 *       nunca substitui a resposta por dados pré-coletados ou gerados
 *       localmente rotulados como se fossem esta fonte. `request_id` vem
 *       tanto no corpo quanto no header `X-Request-Id` da resposta, útil
 *       para correlacionar com os logs do servidor em caso de suporte.
 *       Versão do contrato desta API: ver `info.version` nesta spec.
 *     parameters:
 *       - name: bytes
 *         in: query
 *         schema: { type: integer, minimum: 1, default: 32 }
 *         description: Quantidade de bytes a gerar. Limite por requisição = PUBLIC_MAX_BYTES_PER_REQUEST (padrão 64 KiB).
 *       - name: format
 *         in: query
 *         schema: { type: string, enum: [hex, base64, uint8, raw] }
 *         description: >
 *           hex (default, inclusive quando omitido), base64, uint8 (array JSON de
 *           inteiros 0-255) → JSON RandomResponse. raw → application/octet-stream com
 *           EXATAMENTE os N bytes brutos (sem JSON/texto/prefixo/BOM); request_id e
 *           proveniência nos headers X-Request-Id / X-QRNG-Source / X-QRNG-Conditioned.
 *           Omitir `format` retorna JSON (hex), NÃO binário — use `format=raw` ou GET /public/raw.
 *     responses:
 *       200:
 *         description: >
 *           Bytes gerados. hex|base64|uint8 (ou omitido) → application/json;
 *           raw → application/octet-stream com N bytes exatos.
 *         headers:
 *           X-Request-Id: { schema: { type: string }, description: Identificador da requisição (sempre presente). }
 *           X-QRNG-Source: { schema: { type: string }, description: "Proveniência (presente em format=raw)." }
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['false'] }, description: "Sempre 'false' (presente em format=raw)." }
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/RandomResponse' } }
 *           application/octet-stream: { schema: { type: string, format: binary } }
 *       413:
 *         description: bytes acima de PUBLIC_MAX_BYTES_PER_REQUEST.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       422:
 *         description: bytes ou format inválidos.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       429:
 *         description: Rate limit por IP OU cota diária pública (requests/bytes) excedida.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       502:
 *         description: Upstream retornou erro ou formato inesperado -- ver interpretUpstreamResponse().
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503:
 *         description: Upstream indisponível, timeout, ou entropia insuficiente no buffer.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
async function publicRandomHandler(req, res) {
  const bytes     = req.requestedBytes;
  const format    = res.locals.forceRawFormat ? "raw" : (req.query.format || "hex");
  const ip        = req.ip || req.socket.remoteAddress;
  const ua        = req.headers["user-agent"];
  const requestId = req.requestId;
  const t0        = Date.now();

  // Nunca cacheável -- e o request_id vai como header também, não só no
  // corpo, para permitir correlação em qualquer camada intermediária
  // (proxy/CDN) sem precisar decodificar o corpo da resposta.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Request-Id", requestId);

  if (!RANDOM_FORMATS.includes(format)) {
    recordPublicUsage(ip, 0);
    return res.status(422).json({ request_id: requestId, error: "INVALID_FORMAT", message: "Use format=hex, base64, uint8 ou raw" });
  }

  try {
    const upBytes = Math.min(bytes * 20, PUBLIC_MAX_BYTES_PER_REQUEST * 20);
    const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/random?bytes=${upBytes}`, QRNG_TIMEOUT_MS);

    if (!r.ok) {
      // token_id NULL agrega todo o tráfego público anônimo numa única linha
      // de daily_usage (esperado -- a cota real deste caminho é aplicada por
      // IP via publicIpDailyUsage acima, não por essa tabela).
      logRequest(requestId, null, "/v1/public/random", bytes, format, 502, ip, ua, Date.now() - t0);
      recordPublicUsage(ip, bytes);
      const prov = resolveProvenance({ servedFromUpstream: false, upstreamHeaders: lowerHeaders(r.headers) });
      return res.status(502).json({ request_id: requestId, error: "UPSTREAM_ERROR", status: r.status, provenance: prov.actual_origin, provenance_detail: prov });
    }

    const contentType         = r.headers.get("content-type");
    const contentLengthHeader = r.headers.get("content-length");
    const rawBuffer           = await r.buffer();

    if (contentLengthHeader !== null && Number(contentLengthHeader) !== rawBuffer.length) {
      logRequest(requestId, null, "/v1/public/random", bytes, format, 502, ip, ua, Date.now() - t0);
      recordPublicUsage(ip, bytes);
      return res.status(502).json({
        request_id: requestId,
        error: "UPSTREAM_LENGTH_MISMATCH",
        message: `Content-Length declarado (${contentLengthHeader}) não bate com bytes efetivamente recebidos (${rawBuffer.length}).`,
      });
    }

    let buf;
    try {
      buf = interpretUpstreamResponse(contentType, rawBuffer, bytes);
    } catch (err) {
      if (err instanceof UpstreamFormatError) {
        logRequest(requestId, null, "/v1/public/random", bytes, format, 502, ip, ua, Date.now() - t0);
        recordPublicUsage(ip, bytes);
        return res.status(502).json({ request_id: requestId, error: err.code, message: err.message });
      }
      throw err;
    }

    const upHdr = lowerHeaders(r.headers);

    if (buf.length < bytes) {
      logRequest(requestId, null, "/v1/public/random", bytes, format, 503, ip, ua, Date.now() - t0);
      recordPublicUsage(ip, bytes);
      const prov = resolveProvenance({ servedFromUpstream: false, upstreamHeaders: upHdr, insufficientEntropy: true });
      return res.status(503).json({ request_id: requestId, error: "INSUFFICIENT_ENTROPY", available: buf.length, requested: bytes, provenance: prov.actual_origin, provenance_detail: prov });
    }
    buf = buf.slice(0, bytes);

    logRequest(requestId, null, "/v1/public/random", bytes, format, 200, ip, ua, Date.now() - t0);
    recordPublicUsage(ip, bytes);
    metricsCounters.public_requests_total++;

    const prov = resolveProvenance({ servedFromUpstream: true, upstreamHeaders: upHdr });

    if (format === "raw") {
      res.status(200);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("X-QRNG-Source", QRNG_SOURCE_LABEL);
      res.setHeader("X-QRNG-Conditioned", "false");
      setProvenanceHeaders(res, prov);
      return res.end(buf); // corpo = EXATAMENTE N bytes, sem JSON/BOM/prefixo
    }

    const random = format === "hex"    ? buf.toString("hex")
                 : format === "base64" ? buf.toString("base64")
                 : Array.from(buf);

    // Paridade com raw: proveniência nos headers também nas respostas JSON.
    setProvenanceHeaders(res, prov);
    res.json({ request_id: requestId, source: QRNG_SOURCE_LABEL, provenance: prov.actual_origin, provenance_detail: prov, bytes, format, random, timestamp: new Date().toISOString() });

  } catch (err) {
    logRequest(requestId, null, "/v1/public/random", bytes, format, 503, ip, ua, Date.now() - t0);
    recordPublicUsage(ip, bytes);
    const prov = resolveProvenance({ servedFromUpstream: false });
    res.status(503).json({ request_id: requestId, error: "QRNG_UNAVAILABLE", detail: err.message, provenance: prov.actual_origin, provenance_detail: prov });
  }
}

const publicRandomChain = [attachRequestId, publicIpRateLimiter, parsePublicBytes, checkPublicQuota];
app.get("/v1/public/random", ...publicRandomChain, publicRandomHandler);

/**
 * @openapi
 * /public/raw:
 *   get:
 *     tags: [Random]
 *     summary: Alias binário explícito de GET /public/random?format=raw (anônimo, cota reduzida).
 *     description: >
 *       Idêntico a GET /public/random?format=raw. Corpo = EXATAMENTE os N bytes
 *       (application/octet-stream, Content-Length = N), sem JSON/texto/prefixo/BOM.
 *       Mesmos limites por IP do /public/random. request_id e proveniência nos
 *       headers X-Request-Id / X-QRNG-Source / X-QRNG-Conditioned.
 *     parameters:
 *       - name: bytes
 *         in: query
 *         schema: { type: integer, minimum: 1, default: 32 }
 *         description: Quantidade de bytes. Limite = PUBLIC_MAX_BYTES_PER_REQUEST (padrão 64 KiB).
 *     responses:
 *       200:
 *         description: N bytes brutos.
 *         headers:
 *           X-Request-Id: { schema: { type: string } }
 *           X-QRNG-Source: { schema: { type: string } }
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['false'] } }
 *         content:
 *           application/octet-stream: { schema: { type: string, format: binary } }
 *       413: { description: bytes acima de PUBLIC_MAX_BYTES_PER_REQUEST., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       422: { description: bytes inválido., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { description: Rate limit por IP ou cota pública excedida., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       502: { description: Upstream com erro ou formato inesperado., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       503: { description: Upstream indisponível ou entropia insuficiente., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
app.get("/v1/public/raw", ...publicRandomChain, (req, res) => { res.locals.forceRawFormat = true; return publicRandomHandler(req, res); });

// ── Bulk jobs — stub (não implementado) ───────────────────────────────────────

const BULK_NOT_IMPLEMENTED = {
  error:   "BULK_JOBS_NOT_IMPLEMENTED",
  message: "Large requests must use the asynchronous bulk random generation API, planned for a future release.",
  docs:    "See /docs/scalability.md for the roadmap.",
};

/**
 * @openapi
 * /bulk-random-jobs:
 *   post:
 *     tags: [Random]
 *     summary: "NÃO IMPLEMENTADO — stub reservado para geração assíncrona em lote (retorna 501)."
 *     security: [{ bearerAuthToken: [] }]
 *     responses:
 *       501:
 *         description: Não implementado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 * /bulk-random-jobs/{job_id}:
 *   get:
 *     tags: [Random]
 *     summary: "NÃO IMPLEMENTADO (retorna 501)."
 *     security: [{ bearerAuthToken: [] }]
 *     parameters:
 *       - name: job_id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       501:
 *         description: Não implementado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 * /bulk-random-jobs/{job_id}/download:
 *   get:
 *     tags: [Random]
 *     summary: "NÃO IMPLEMENTADO (retorna 501)."
 *     security: [{ bearerAuthToken: [] }]
 *     parameters:
 *       - name: job_id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       501:
 *         description: Não implementado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/bulk-random-jobs",                 requireToken, (_req, res) => res.status(501).json(BULK_NOT_IMPLEMENTED));
app.get ("/v1/bulk-random-jobs/:job_id",         requireToken, (_req, res) => res.status(501).json(BULK_NOT_IMPLEMENTED));
app.get ("/v1/bulk-random-jobs/:job_id/download",requireToken, (_req, res) => res.status(501).json(BULK_NOT_IMPLEMENTED));

// ── GET /v1/health/self — liveness sem autenticação ──────────────────────────

/**
 * @openapi
 * /health/self:
 *   get:
 *     tags: [Health]
 *     summary: Liveness do processo Node — não consulta o upstream FPGA. Sem autenticação.
 *     description: >
 *       Só confirma que o processo qrng-client-api está no ar. Para saber se a
 *       fonte FPGA está acessível, use GET /health (requer token).
 *     responses:
 *       200:
 *         description: Processo vivo.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/HealthSelfResponse' } } }
 */
app.get("/v1/health/self", (_req, res) => {
  res.json({
    status: "ok",
    service: "qrng-client-api",
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── GET /metrics — formato Prometheus ─────────────────────────────────────────

const METRICS_TOKEN = process.env.METRICS_TOKEN || null;

/**
 * @openapi
 * /metrics:
 *   get:
 *     tags: [Health]
 *     summary: Métricas no formato Prometheus (requests/bytes/erros por status_code em /v1/random).
 *     description: >
 *       Fora do prefixo /v1 -- não é versionada como o resto da API pública.
 *       Protegida por METRICS_TOKEN (env var) quando definida; sem
 *       autenticação quando METRICS_TOKEN não está configurada.
 *     security: [{ bearerAuthToken: [] }]
 *     responses:
 *       200:
 *         description: Métricas em texto, formato Prometheus (Content-Type text/plain).
 *         content: { text/plain: { schema: { type: string } } }
 *       401:
 *         description: METRICS_TOKEN configurada e não enviada/incorreta.
 */
app.get("/metrics", (req, res) => {
  if (METRICS_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth.slice(7).trim() !== METRICS_TOKEN) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
  }

  const byStatus = db.prepare(`
    SELECT status_code, COUNT(*) as n, COALESCE(SUM(bytes_requested),0) as b
    FROM api_usage_logs WHERE endpoint = '/v1/random' GROUP BY status_code
  `).all();

  const totalBytes  = byStatus.find(r => r.status_code === 200)?.b || 0;
  const totalErrors = byStatus.filter(r => r.status_code >= 400).reduce((a, r) => a + r.n, 0);

  // Item 6: mesmas métricas, separadas para o endpoint público -- não somar
  // com as de /v1/random acima, são superfícies de risco/observabilidade
  // distintas (anônimo vs autenticado).
  const publicByStatus = db.prepare(`
    SELECT status_code, COUNT(*) as n, COALESCE(SUM(bytes_requested),0) as b
    FROM api_usage_logs WHERE endpoint = '/v1/public/random' GROUP BY status_code
  `).all();
  const publicTotalBytes  = publicByStatus.find(r => r.status_code === 200)?.b || 0;
  const publicTotalErrors = publicByStatus.filter(r => r.status_code >= 400).reduce((a, r) => a + r.n, 0);

  const activeTokens = db.prepare("SELECT COUNT(*) as n FROM api_tokens WHERE status='active'").get().n;
  const totalUsers   = db.prepare("SELECT COUNT(*) as n FROM users").get().n;

  const upstreamUp     = upstreamState.status === "up" ? 1 : 0;
  const upstreamLatMs  = upstreamState.responseMs ?? 0;

  const lines = [
    "# HELP qrng_requests_total Total requests to /v1/random (desde a criação do banco)",
    "# TYPE qrng_requests_total counter",
    ...byStatus.map(r => `qrng_requests_total{status="${r.status_code}"} ${r.n}`),
    "",
    "# HELP qrng_random_bytes_total Total bytes de entropia entregues (status=200)",
    "# TYPE qrng_random_bytes_total counter",
    `qrng_random_bytes_total ${totalBytes}`,
    "",
    "# HELP qrng_errors_total Total erros registrados em /v1/random",
    "# TYPE qrng_errors_total counter",
    `qrng_errors_total ${totalErrors}`,
    "",
    "# HELP qrng_rate_limited_total Eventos de rate limit desde o último restart",
    "# TYPE qrng_rate_limited_total counter",
    `qrng_rate_limited_total ${metricsCounters.rate_limited_total}`,
    "",
    "# HELP qrng_quota_exceeded_total Eventos de cota esgotada desde o último restart",
    "# TYPE qrng_quota_exceeded_total counter",
    `qrng_quota_exceeded_total{type="requests"} ${metricsCounters.quota_requests_exceeded}`,
    `qrng_quota_exceeded_total{type="bytes"}    ${metricsCounters.quota_bytes_exceeded}`,
    "",
    "# HELP qrng_public_requests_total Total requests a /v1/public/random (desde a criação do banco)",
    "# TYPE qrng_public_requests_total counter",
    ...publicByStatus.map(r => `qrng_public_requests_total{status="${r.status_code}"} ${r.n}`),
    "",
    "# HELP qrng_public_random_bytes_total Total bytes de entropia entregues via /v1/public/random (status=200)",
    "# TYPE qrng_public_random_bytes_total counter",
    `qrng_public_random_bytes_total ${publicTotalBytes}`,
    "",
    "# HELP qrng_public_errors_total Total erros registrados em /v1/public/random",
    "# TYPE qrng_public_errors_total counter",
    `qrng_public_errors_total ${publicTotalErrors}`,
    "",
    "# HELP qrng_public_rate_limited_total Eventos de rate limit no endpoint público desde o último restart",
    "# TYPE qrng_public_rate_limited_total counter",
    `qrng_public_rate_limited_total ${metricsCounters.public_rate_limited_total}`,
    "",
    "# HELP qrng_public_quota_exceeded_total Eventos de cota pública por IP esgotada desde o último restart",
    "# TYPE qrng_public_quota_exceeded_total counter",
    `qrng_public_quota_exceeded_total{type="requests"} ${metricsCounters.public_quota_requests_exceeded}`,
    `qrng_public_quota_exceeded_total{type="bytes"}    ${metricsCounters.public_quota_bytes_exceeded}`,
    "",
    "# HELP qrng_upstream_status 1=up, 0=down, -1=unknown",
    "# TYPE qrng_upstream_status gauge",
    `qrng_upstream_status ${upstreamState.status === "unknown" ? -1 : upstreamUp}`,
    "",
    "# HELP qrng_upstream_latency_ms Latência da última verificação do upstream (ms)",
    "# TYPE qrng_upstream_latency_ms gauge",
    `qrng_upstream_latency_ms ${upstreamLatMs}`,
    "",
    "# HELP qrng_active_tokens Tokens de API ativos",
    "# TYPE qrng_active_tokens gauge",
    `qrng_active_tokens ${activeTokens}`,
    "",
    "# HELP qrng_registered_users Usuários registrados",
    "# TYPE qrng_registered_users gauge",
    `qrng_registered_users ${totalUsers}`,
    "",
    "# HELP qrng_process_uptime_seconds Uptime do processo Node.js em segundos",
    "# TYPE qrng_process_uptime_seconds gauge",
    `qrng_process_uptime_seconds ${Math.floor(process.uptime())}`,
    "",
  ];

  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(lines.join("\n"));
});

// ── Upstream monitor ──────────────────────────────────────────────────────────
// Poller: a cada 60s verifica a saúde do upstream.
// Requer UPSTREAM_FAIL_THRESHOLD falhas CONSECUTIVAS para marcar DOWN.
// Uma única falha transitória não derruba a API.

let upstreamState = { status: "unknown", checkedAt: null, responseMs: null };
let consecutiveFailures = 0;

async function checkUpstream() {
  const t0 = Date.now();
  let status, responseMs, detail;
  try {
    const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/health`, 5000);
    responseMs = Date.now() - t0;
    status = r.ok ? "up" : "down";
    detail = r.ok ? null : `HTTP ${r.status}`;
  } catch (err) {
    responseMs = Date.now() - t0;
    status = "down";
    detail = err.name === "AbortError" ? "timeout" : err.message;
  }

  if (status === "up") {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    // Não marca DOWN até atingir o threshold
    if (consecutiveFailures < UPSTREAM_FAIL_THRESHOLD) {
      // Mantém estado anterior; loga a falha sem mudar estado
      console.log(
        `[upstream-health] status=${upstreamState.status} warning=consecutive_failure ` +
        `failures=${consecutiveFailures}/${UPSTREAM_FAIL_THRESHOLD} ` +
        `latency_ms=${responseMs} error=${JSON.stringify(detail)}`
      );
      return;
    }
  }

  const now  = new Date().toISOString();
  const prev = upstreamState.status;
  upstreamState = { status, checkedAt: now, responseMs };

  if (prev !== status) {
    db.prepare("INSERT INTO upstream_health_log (status, response_ms, detail, checked_at) VALUES (?, ?, ?, ?)").run(status, responseMs ?? null, detail ?? null, now);
    console.log(
      `[upstream-health] status=${status} previous=${prev} ` +
      `latency_ms=${responseMs ?? "N/A"} ` +
      `consecutive_failures=${consecutiveFailures} ` +
      `${detail ? `error=${JSON.stringify(detail)}` : ""}`
    );
    db.prepare("DELETE FROM upstream_health_log WHERE id NOT IN (SELECT id FROM upstream_health_log ORDER BY id DESC LIMIT 500)").run();
  }
}

// Rota de teste guardada por env (só staging/CI). Permite exercitar o handler
// de erro 500 de forma determinística. NUNCA habilitada em produção.
if (process.env.ENABLE_TEST_ROUTES === "1") {
  app.get("/v1/_test/boom", attachRequestId, (_req, _res) => {
    throw new Error("boom (rota de teste ENABLE_TEST_ROUTES)");
  });
}

// ── 404 catch-all estruturado ───────────────────────────────────────────────
// Sem isto, uma rota desconhecida cai no default do Express ("Cannot GET /x"
// em HTML). Aqui devolve sempre { request_id, error, message } em JSON.
app.use((req, res) => {
  const requestId = req.requestId || newRequestId();
  res.status(404).json({
    request_id: requestId,
    error: "NOT_FOUND",
    message: `Rota não encontrada: ${req.method} ${req.path}`,
  });
});

// ── Handler de erro estruturado (item 3) ─────────────────────────────────────
// Erros do parser de corpo (express.json/body-parser) acontecem ANTES de
// qualquer middleware de rota, então precisam de um handler de erro global no
// fim da cadeia. Garante:
//   - 413 estruturado (JSON) quando o corpo excede JSON_BODY_LIMIT;
//   - 400 estruturado quando o JSON é inválido / Content-Length não bate;
//   - 500 estruturado (INTERNAL_ERROR) para qualquer throw não tratado;
//   - NUNCA HTML nem stack trace no corpo da resposta (o default do Express
//     em modo dev vaza o stack) -- só { request_id, error, message }.
// A assinatura de 4 args (err, req, res, next) é o que faz o Express tratar
// isto como error handler; `next` é usado no caminho `!err`.
app.use((err, req, res, next) => {
  if (!err) return next();
  const requestId = req.requestId || newRequestId();

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      request_id: requestId,
      error: "REQUEST_BODY_TOO_LARGE",
      message: `Request body excede o limite de ${JSON_BODY_LIMIT}. Este serviço só aceita corpos JSON pequenos (auth/admin).`,
      limit: JSON_BODY_LIMIT,
    });
  }
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({
      request_id: requestId,
      error: "INVALID_JSON",
      message: "O corpo da requisição não é JSON válido.",
    });
  }
  if (err.type === "request.size.invalid" || err.type === "encoding.unsupported") {
    return res.status(400).json({
      request_id: requestId,
      error: "INVALID_REQUEST_BODY",
      message: "Corpo da requisição inválido (tamanho declarado ou codificação).",
    });
  }
  // Qualquer outro erro não tratado: 500 genérico, sem stack no corpo.
  console.error(`[qrng-client-api] unhandled error request_id=${requestId}:`, err && err.stack ? err.stack : err);
  return res.status(500).json({ request_id: requestId, error: "INTERNAL_ERROR", message: "Erro interno." });
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Endereço de bind. DEFAULT "127.0.0.1" -- reproduz o deploy de produção
// (host network + nginx no mesmo host). Em rede bridge de container (staging),
// defina BIND_ADDR=0.0.0.0 para o nginx de outro container alcançar o serviço.
const BIND_ADDR = process.env.BIND_ADDR || "127.0.0.1";

if (require.main === module) {
  app.listen(PORT, BIND_ADDR, () => {
    console.log(`QRNG client API  → http://${BIND_ADDR}:${PORT}`);
    console.log(`Database         → ${DB_PATH}`);
    console.log(`Admin email      → ${ADMIN_EMAIL || "(não configurado)"}`);
    console.log(`Max bytes/req    → ${MAX_BYTES_PER_REQUEST.toLocaleString()} bytes`);
    console.log(`Rate limit IP    → ${RATE_LIMIT_PER_IP_MIN} req/min`);
    console.log(`Rate limit token → ${RATE_LIMIT_PER_TOKEN_MIN} req/min`);
    console.log(`Daily quota req  → ${DAILY_QUOTA_REQUESTS.toLocaleString()} requests`);
    console.log(`Daily quota bytes→ ${DAILY_QUOTA_BYTES.toLocaleString()} bytes`);
    console.log(`Upstream timeout → ${QRNG_TIMEOUT_MS}ms`);
    console.log(`Upstream fail threshold → ${UPSTREAM_FAIL_THRESHOLD} consecutive failures`);
    checkUpstream();
    setInterval(checkUpstream, 60 * 1000);
  });
}

module.exports = { app, db, interpretUpstreamResponse, UpstreamFormatError };
