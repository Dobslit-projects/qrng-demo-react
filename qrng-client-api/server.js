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

// ── Identidade NUNCA por cabeçalho do cliente (doc 155, 2.4) ─────────────────
// O gate do nginx (auth_request) devolve X-Bongo-User-Id / X-Bongo-Role ao
// próprio nginx; um cliente pode tentar enviá-los (ou X-Portal-User) direto.
// A client-api nunca confia em identidade por cabeçalho: eles são REMOVIDOS
// aqui, antes de qualquer outro middleware. A sessão do portal só vale via
// X-Portal-Session + introspecção no Bongo.
const UNTRUSTED_IDENTITY_HEADERS = ["x-bongo-user-id", "x-bongo-role", "x-portal-user"];
app.use((req, _res, next) => {
  for (const h of UNTRUSTED_IDENTITY_HEADERS) delete req.headers[h];
  next();
});

// ── Cabeçalhos de segurança (preparação para pentest, 2026-09-30) ────────────
// helmet: nosniff, frameguard, Referrer-Policy, COOP etc. Ajustes:
//  - hsts: false — TLS termina no nginx do host, que envia o HSTS uma vez
//    para o domínio inteiro; repetir aqui duplicaria o cabeçalho.
//  - CSP estrita para as respostas JSON (nada pode ser carregado/enquadrado);
//    as páginas de documentação recebem uma CSP própria logo abaixo.
//  - crossOriginResourcePolicy "cross-origin": a API pública é consumida de
//    outras origens por desenho (CORS "*" mais abaixo).
const helmet = require("helmet");
app.disable("x-powered-by");
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src":     ["'none'"],
      "frame-ancestors": ["'none'"],
      "base-uri":        ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));

// Swagger UI e ReDoc precisam de script/estilo inline; o ReDoc (servido
// daqui, vendor/redoc) usa Google Fonts e um web worker (blob:). Só estas rotas.
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");
app.use(["/v1/docs", "/v1/internal/docs", "/v1/redoc"], (_req, res, next) => {
  res.setHeader("Content-Security-Policy", DOCS_CSP);
  next();
});

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

// Quantos bytes pedir ao broker por byte entregue. Com upstream binário
// (application/octet-stream) 1 byte pedido = 1 byte entregue, então o padrão
// é 1: tudo que se pede a mais é entropia física retirada do buffer e
// descartada (antes era 20x fixo — 95% jogado fora, e um único IP dentro da
// cota pública drenava ~150 MiB/min). Só o formato legado de texto decimal,
// que perde bytes no parsing, mantém 20 por padrão.
const UPSTREAM_OVERPROVISION = Math.max(1, parseInt(
  process.env.UPSTREAM_OVERPROVISION_FACTOR || (process.env.ALLOW_LEGACY_TEXT_UPSTREAM === "true" ? "20" : "1"), 10));

// Fail-closed de fonte parada: quando o /health do broker diz
// source_status=offline (sem dados novos há > 60 s), a API recusa (503
// SOURCE_OFFLINE) em vez de servir o que sobrou no buffer sem nenhuma
// evidência de que a fonte está viva. Desligável com =0.
const REFUSE_WHEN_SOURCE_OFFLINE = process.env.REFUSE_WHEN_SOURCE_OFFLINE !== "0";

// Promoção a admin pelo e-mail no CADASTRO: desligada por padrão (quem
// adivinhasse ADMIN_EMAIL antes do dono criava a conta admin). Só staging/CI
// ligam (=1). Em produção o papel é dado por `node scripts/set-role.js`.
const ALLOW_ADMIN_EMAIL_BOOTSTRAP = process.env.ALLOW_ADMIN_EMAIL_BOOTSTRAP === "1";

// Retenção de registros de uso (LGPD — minimização): linhas apagadas após N
// dias; IP truncado (/24 ou /48) e user-agent removido após M dias.
const USAGE_LOG_RETENTION_DAYS         = parseInt(process.env.USAGE_LOG_RETENTION_DAYS || "90", 10);
const USAGE_LOG_IP_TRUNCATE_AFTER_DAYS = parseInt(process.env.USAGE_LOG_IP_TRUNCATE_AFTER_DAYS || "7", 10);

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

// ── Identidade integrada, recuperação de senha legada e auditoria (doc 155) ──
// Bongo = autoridade de identidade e dono da fila de e-mail. A client-api fala
// com ele só pelas APIs internas, autenticada por INTERNAL_SERVICE_TOKEN (o
// mesmo valor configurado nos dois serviços). Sem o token, a sessão do portal
// falha FECHADA (503 IDENTITY_UNAVAILABLE) e os e-mails de recuperação não
// são enfileirados; chaves de API e login legado continuam funcionando.
const BONGO_INTERNAL_URL              = process.env.BONGO_INTERNAL_URL || "http://127.0.0.1:3101";
const INTERNAL_SERVICE_TOKEN          = process.env.INTERNAL_SERVICE_TOKEN || null;
// O mesmo prazo vale para a chamada de enfileiramento de e-mail.
const PORTAL_INTROSPECTION_TIMEOUT_MS = parseInt(process.env.PORTAL_INTROSPECTION_TIMEOUT_MS || "3000", 10);
const PORTAL_INTROSPECTION_CACHE_MS   = parseInt(process.env.PORTAL_INTROSPECTION_CACHE_MS || "30000", 10);
const QRNG_RESET_TOKEN_TTL_MINUTES    = parseInt(process.env.QRNG_RESET_TOKEN_TTL_MINUTES || "30", 10);
// Recuperação self-service das contas legadas: DESLIGADA por padrão. Liga só
// depois de o envio real de e-mail do Bongo estar ativo e testado (doc 155).
// Desligada: POST /v1/auth/password-reset/request → 503 PASSWORD_RESET_UNAVAILABLE
// (igual para todo e-mail) e nenhum token é gerado.
const QRNG_PASSWORD_RESET_ENABLED     = process.env.QRNG_PASSWORD_RESET_ENABLED === "1";
// Página PÚBLICA do portal (fora de /qrng/, que passa pelo gate de autorização
// no nginx) que lê o token do FRAGMENTO (#token=...): o fragmento não vai ao
// servidor, então fica fora de logs de acesso, proxies e Referer.
const QRNG_PASSWORD_RESET_URL         = process.env.QRNG_PASSWORD_RESET_URL || "https://bongo.dobslit.com/redefinir-senha-api";
const AUDIT_PSEUDONYM_KEY             = process.env.AUDIT_PSEUDONYM_KEY || null;
// 1..3650; qualquer outro valor (negativo, "1e3", texto) volta para 365 — um
// valor negativo jogaria o corte para o futuro e apagaria a auditoria inteira.
const AUDIT_RETENTION_DAYS            = (() => {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  const n = raw === undefined || raw === "" ? 365 : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 365;
})();
// Estado da conta do portal por trás das chaves de API das contas CRIADAS PELO
// PORTAL (auth_source='portal'): consultado no Bongo e guardado por este tempo.
const PORTAL_ACCOUNT_STATUS_CACHE_MS  = parseInt(process.env.PORTAL_ACCOUNT_STATUS_CACHE_MS || "60000", 10);

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
// `X-QRNG-Discontinuities` do broker é cumulativo desde o boot do broker; sem
// isto, UM realinhamento antigo rotularia todos os blocos seguintes como
// "discontinuous" (foi o que aconteceu em produção: 256 desde 14/10 em todas as
// respostas). Guardamos o último valor visto e só marcamos gap quando ele avança.
let lastUpstreamDiscontinuities = null;
function discontinuitiesBaselineFrom(uh) {
  if (!uh || uh["x-qrng-discontinuities"] == null) return undefined;
  const c = Number(uh["x-qrng-discontinuities"]);
  if (!Number.isFinite(c)) return undefined;
  // contador zerou (broker reiniciou) ou primeira resposta: a baseline é o próprio valor
  const baseline = (lastUpstreamDiscontinuities === null || c < lastUpstreamDiscontinuities) ? c : lastUpstreamDiscontinuities;
  lastUpstreamDiscontinuities = c;
  return baseline;
}

// Respostas de STATUS (/health do broker) trazem a sonda do hardware no JSON,
// não em headers: traduz os campos para o mesmo contrato que /random usa.
function statusHeadersFromHealthJson(data, upHdr) {
  const h = { ...(upHdr || {}) };
  if (!data || typeof data !== "object") return h;
  if (data.source_status != null)        h["x-qrng-source-status"]        = String(data.source_status);
  if (data.entropy_health != null)       h["x-qrng-entropy-health"]       = String(data.entropy_health);
  if (data.qualification_status != null) h["x-qrng-qualification-status"] = String(data.qualification_status);
  if (data.source_stall_seconds != null) h["x-qrng-source-stall-seconds"] = String(data.source_stall_seconds);
  return h;
}

function resolveProvenance(o) {
  return _resolveProvenance({
    ...o,
    // baseline explícito: blocos do pool de pré-carga já foram classificados na
    // chegada (ordem temporal correta); não reprocessar o contador cumulativo.
    discontinuitiesBaseline: o.discontinuitiesBaseline !== undefined
      ? o.discontinuitiesBaseline
      : discontinuitiesBaselineFrom(o.upstreamHeaders),
    instanceMode: QRNG_INSTANCE_MODE,
    configuredSource: QRNG_CONFIGURED_SOURCE,
    pollerSourceHealth: upstreamHealthLabel(),
    maxSampleAgeMs: LIVE_SAMPLE_MAX_AGE_MS,
    allowLiveWithoutCaptureEvidence: LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE,
  });
}

/** Escreve a proveniência nos headers da resposta (raw e JSON). */
function setProvenanceHeaders(res, prov) {
  res.setHeader("X-QRNG-Provenance", prov.actual_origin);
  res.setHeader("X-QRNG-Live-Verified", String(prov.live_verified));
  res.setHeader("X-QRNG-Fallback-Used", String(prov.fallback_used));
  // item 5 — saúde em três eixos ortogonais
  res.setHeader("X-QRNG-Transport-Health", prov.transport_health || prov.source_health);
  res.setHeader("X-QRNG-Buffer-Health", prov.buffer_health);
  res.setHeader("X-QRNG-Entropy-Health", prov.entropy_health || "not_assessed");
  res.setHeader("X-QRNG-Source-Health", prov.source_health); // DEPRECATED: = transport
  res.setHeader("X-QRNG-Served-At", prov.served_at);
  // item 4 — frescor
  if (prov.received_at) res.setHeader("X-QRNG-Received-At", prov.received_at);
  if (prov.captured_at) res.setHeader("X-QRNG-Captured-At", prov.captured_at);
  if (prov.capture_id)  res.setHeader("X-QRNG-Capture-Id", prov.capture_id);
  if (prov.sample_age_ms !== null) res.setHeader("X-QRNG-Sample-Age-Ms", String(prov.sample_age_ms));
  if (prov.discontinuities !== null && prov.discontinuities !== undefined) {
    res.setHeader("X-QRNG-Discontinuities", String(prov.discontinuities));
  }
}

// ── Qualificação da fonte por RESPOSTA (Kuapoã Etapa 89E, doc 139) ───────────
// A fonte de verdade é o BROKER: ele só diz conditioned=true enquanto uma sonda recente da placa confirma que o
// bitstream qualificado (formal, Toeplitz no FPGA) está ATIVO e passou no hash-gate deste boot. Aqui só se REPASSA,
// com allowlist de formato. Broker antigo (sem os headers): X-QRNG-Conditioned mantém o "false" conservador de
// sempre e os demais ficam AUSENTES — nenhuma qualificação é inventada.
const QUAL_STATUS_RX = /^[a-z_]{1,64}$/;
const SHA256_HEX_RX = /^[0-9a-f]{64}$/;
// Mesma regra para cabeçalhos (rotas atuais) e para a extensão kuapoa.response (QRNG Open API).
function sourceQualificationFrom(upHdr) {
  const uh = upHdr || {};
  const qs = String(uh["x-qrng-qualification-status"] || "");
  // "true" só com as DUAS afirmações do broker: conditioned=true E bitstream qualificado verificado ativo
  const verified = qs === "verified_active_bitstream";
  const sha = String(uh["x-qrng-bitstream-sha256"] || "").toLowerCase();
  return {
    conditioned: String(uh["x-qrng-conditioned"] || "").toLowerCase() === "true" && verified,
    qualificationStatus: QUAL_STATUS_RX.test(qs) ? qs : null,
    bitstreamSha256: (verified && SHA256_HEX_RX.test(sha)) ? sha : null,
  };
}
function setSourceQualificationHeaders(res, upHdr) {
  const q = sourceQualificationFrom(upHdr);
  res.setHeader("X-QRNG-Conditioned", q.conditioned ? "true" : "false");
  if (q.qualificationStatus) res.setHeader("X-QRNG-Qualification-Status", q.qualificationStatus);
  if (q.bitstreamSha256) res.setHeader("X-QRNG-Bitstream-SHA256", q.bitstreamSha256);
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

// Migrações versionadas (doc 155, seção 6): o bloco acima é a linha de base;
// daqui em diante cada versão roda numa transação e fica em schema_migrations.
const { runMigrations } = require("./lib/migrations");
runMigrations(db);

const { createAudit } = require("./lib/audit");
const { createBongoInternalClient, IdentityUnavailableError } = require("./lib/bongo-internal");
const audit = createAudit(db, {
  pseudonymKey: AUDIT_PSEUDONYM_KEY,
  retentionDays: AUDIT_RETENTION_DAYS,
  truncateIp: (ip) => truncateIp(ip),
});
const bongo = createBongoInternalClient({
  baseUrl: BONGO_INTERNAL_URL,
  serviceToken: INTERNAL_SERVICE_TOKEN,
  timeoutMs: PORTAL_INTROSPECTION_TIMEOUT_MS,
  cacheMs: PORTAL_INTROSPECTION_CACHE_MS,
});

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

  // Tráfego anônimo (tokenId null) não tem cota em daily_usage — a cota
  // pública é por IP, em memória. Além disso UNIQUE(token_id, date) não
  // deduplica NULL: cada requisição anônima criava uma linha nova.
  if (tokenId == null) return;

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

// ── Retenção / minimização dos registros de uso ──────────────────────────────

function truncateIp(ip) {
  if (typeof ip !== "string" || ip === "") return null;
  const v4 = ip.replace(/^::ffff:/i, "");
  const o = v4.split(".");
  if (o.length === 4 && o.every((p) => /^\d{1,3}$/.test(p))) return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  return null;
}

function purgeUsageLogs(nowMs = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const cutoff   = new Date(nowMs - USAGE_LOG_RETENTION_DAYS * day).toISOString();
  const ipCutoff = new Date(nowMs - USAGE_LOG_IP_TRUNCATE_AFTER_DAYS * day).toISOString();
  const rows = db.prepare(
    "SELECT id, ip_address FROM api_usage_logs WHERE created_at < ? AND (user_agent IS NOT NULL OR (ip_address IS NOT NULL AND ip_address NOT LIKE '%/%'))"
  ).all(ipCutoff);
  const upd = db.prepare("UPDATE api_usage_logs SET ip_address = ?, user_agent = NULL WHERE id = ?");
  let deleted = 0;
  db.transaction(() => {
    deleted = db.prepare("DELETE FROM api_usage_logs WHERE created_at < ?").run(cutoff).changes;
    for (const r of rows) upd.run(truncateIp(r.ip_address), r.id);
    db.prepare("DELETE FROM daily_usage WHERE date < ?").run(cutoff.slice(0, 10));
    db.prepare("DELETE FROM daily_usage WHERE token_id IS NULL").run();
  })();
  return { deleted, anonymized: rows.length };
}

// Remove a conta e tudo que a identifica: tokens e cotas são apagados; os
// registros de uso ficam só como estatística anônima (sem token, IP ou UA).
function deleteUserData(userId) {
  let resetTokenIds = [];
  db.transaction(() => {
    resetTokenIds = db.prepare("SELECT id FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL")
      .all(userId).map((r) => r.id);
    const tokenIds = db.prepare("SELECT id FROM api_tokens WHERE user_id = ?").all(userId).map((t) => t.id);
    for (const id of tokenIds) {
      db.prepare("UPDATE api_usage_logs SET token_id = NULL, ip_address = NULL, user_agent = NULL WHERE token_id = ?").run(id);
      db.prepare("DELETE FROM daily_usage WHERE token_id = ?").run(id);
      tokenRateMap.delete(id);
    }
    db.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(userId);
    // Tokens de recuperação também; as mensagens deles ainda na fila do Bongo
    // são canceladas logo abaixo (cancelamento ativo — o Bongo, em contêiner,
    // não consulta a client-api em produção).
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();
  portalAccountStatusCache.clear();
  cancelLegacyResetMails(resetTokenIds);
}

// ── CORS ──────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  // X-API-Key: forma alternativa de enviar o MESMO token pessoal, aceita só nas rotas QRNG Open API (contrato).
  // X-Portal-Session: JWT do portal Bongo em cabeçalho EXPLÍCITO (nunca cookie → sem CSRF), validado por introspecção.
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key, X-Portal-Session");
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
  customSiteTitle: "Kuapoã QRNG API — Docs",
}));

// URLs RELATIVAS: em produção a API fica atrás de /qrng/v1/ no nginx do
// host; "/v1/openapi.json" absoluto caía no SPA do portal e o ReDoc não
// carregava. O bundle do ReDoc é servido daqui (versão fixa, vendor/redoc),
// não do cdn.redoc.ly "latest", que não permite verificação de integridade.
app.get("/v1/redoc", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <title>Kuapoã QRNG API — ReDoc</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body>
    <redoc spec-url="openapi.json"></redoc>
    <script src="redoc.standalone.js"></script>
  </body>
</html>`);
});

const REDOC_BUNDLE = path.join(__dirname, "vendor", "redoc", "redoc.standalone.js");
app.get("/v1/redoc.standalone.js", (_req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.type("application/javascript").sendFile(REDOC_BUNDLE);
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
  customSiteTitle: "Kuapoã QRNG API — Docs Internas (Admin)",
}));

// ── GET /v1/public/health — saúde da fonte, sem bytes e sem autenticação ─────
//
// Substitui o proxy direto do nginx para o broker (/qrng/api/health →
// 127.0.0.1:18001/health), que obrigava a manter TODO o prefixo do broker
// exposto sem autenticação (/stream, /v1/raw de 50 MiB, /random_hex…). O SPA
// só precisa destes campos para a barra de status. Não devolve `source_file`
// (caminho interno) e nunca consome bytes. Fica ANTES do rate limit global
// (tem o próprio) para o polling de status não disputar cota com /random;
// um cache curto limita a carga no broker a 1 consulta a cada 3 s, por mais
// clientes que haja.
const PUBLIC_HEALTH_TTL_MS = parseInt(process.env.PUBLIC_HEALTH_TTL_MS || "3000", 10);
const PUBLIC_HEALTH_FIELDS = [
  "buffer_bytes_available", "buffer_capacity", "total_pushed", "total_popped",
  "source_status", "source_stall_seconds", "stream_format", "sample_width_bytes", "conditioned",
  // Qualificação da fonte (Kuapoã doc 135): o broker só envia um objeto não-nulo enquanto uma sonda recente da placa
  // confirma que o bitstream qualificado está ATIVO; caso contrário null + qualification_status explicativo.
  "qualification", "qualification_status",
  // health REAL da fonte (Etapa 89E, doc 139): estado RCT/APT do hardware; só o rótulo, sem o detalhe dos registos
  "entropy_health",
];
let publicHealthCache = { at: 0, status: 0, body: null };

const publicHealthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_HEALTH_RATE_LIMIT_PER_IP_PER_MINUTE || "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "RATE_LIMIT_EXCEEDED", message: "Muitas consultas de status. Tente novamente em instantes." }),
});

/**
 * @openapi
 * /public/health:
 *   get:
 *     tags: [Health]
 *     summary: Saúde da fonte QRNG (buffer, estado da fonte) — sem autenticação e sem consumir bytes.
 *     description: >
 *       Resumo do /health do broker físico, para painéis de status. Não
 *       entrega entropia. Resposta com cache de poucos segundos no servidor.
 *     responses:
 *       200:
 *         description: Broker acessível.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 request_id: { type: string }
 *                 buffer_bytes_available: { type: integer }
 *                 buffer_capacity: { type: integer }
 *                 total_pushed: { type: integer }
 *                 total_popped: { type: integer }
 *                 source_status: { type: string, enum: [online, degraded, offline] }
 *                 source_stall_seconds: { type: number, nullable: true }
 *                 stream_format: { type: string }
 *                 sample_width_bytes: { type: integer }
 *                 conditioned: { type: boolean }
 *                 qualification: { type: object, nullable: true, description: "Qualificação da fonte (bitstream, perfil de health tests, H_original, h_out pré-restart, restart_validated=false, sp80090b_full_validation=false, operational_ready). Não-nulo só com o bitstream qualificado ativo e verificado." }
 *                 qualification_status: { type: string, description: "verified_active_bitstream | inactive_other_bitstream | unverified_stale_probe | unverified_no_probe | none | ..." }
 *                 entropy_health: { type: string, description: "hw_health_tests_passing | hw_health_alarm | hw_health_unavailable | not_assessed — estado dos health tests RCT/APT do hardware (wrapper lido só em leitura). Não é validação SP 800-90B." }
 *                 provenance: { type: string, description: "Origem efetiva: 'live' só com a sonda do hardware (entropy_health=hw_health_tests_passing + qualification_status=verified_active_bitstream + fonte fresca); senão 'unknown'." }
 *                 provenance_detail: { $ref: '#/components/schemas/ProvenanceDetail' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       503:
 *         description: Broker inacessível (QRNG_UNAVAILABLE).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.get("/v1/public/health", publicHealthLimiter, attachRequestId, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  if (!publicHealthCache.body || now - publicHealthCache.at > PUBLIC_HEALTH_TTL_MS) {
    try {
      const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/health`, Math.min(QRNG_TIMEOUT_MS, 5000));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const body = {};
      for (const k of PUBLIC_HEALTH_FIELDS) if (data && data[k] !== undefined) body[k] = data[k];
      // Mesma regra de /v1/health: sem bytes nesta resposta, "live" só com a
      // evidência da sonda do hardware (entropy_health + qualification_status
      // + frescor) vinda do JSON do broker.
      const upHdr = lowerHeaders(r.headers);
      const prov = resolveProvenance({
        servedFromUpstream: false,
        upstreamReachable: true,
        upstreamHeaders: statusHeadersFromHealthJson(data, upHdr),
      });
      body.provenance = prov.actual_origin;
      body.provenance_detail = prov;
      publicHealthCache = { at: now, status: 200, body };
    } catch {
      const prov = resolveProvenance({ servedFromUpstream: false });
      publicHealthCache = { at: now, status: 503, body: { error: "QRNG_UNAVAILABLE", message: "Fonte QRNG indisponível no momento.", provenance: prov.actual_origin, provenance_detail: prov } };
    }
  }
  res.status(publicHealthCache.status).json({ request_id: req.requestId, ...publicHealthCache.body });
});

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

// Ordem aceita (doc 155, 2.4): X-Portal-Session (introspecção no Bongo) →
// Authorization: Bearer <JWT legado> → (só resolveUser) chave de API.
// Os dois juntos só passam se apontarem para o MESMO usuário; senão 400
// AMBIGUOUS_CREDENTIALS (nunca "escolher um" em silêncio).

function portalSessionToken(req) {
  const v = req.headers["x-portal-session"];
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^Bearer\s+/i, "");
  return t || null;
}

function bearerToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? (auth.slice(7).trim() || null) : null;
}

// JWT legado → { payload, row } ou null. Rejeita: assinatura/validade
// inválidas, conta excluída (o JWT vale 30 dias), conta criada pelo portal
// (não tem JWT legado) e JWT emitido ANTES da última redefinição de senha.
// A comparação usa `iat_ms` (milissegundos, gravado no login desde o pacote 1):
// um JWT emitido no mesmo segundo, mas antes, da redefinição também cai. JWT
// sem `iat_ms` (emitido antes deste código) cai se iat <= segundo da redefinição.
function signLegacyJwt(claims) {
  return jwt.sign({ ...claims, iat_ms: Date.now() }, JWT_SECRET, { expiresIn: "30d" });
}
function legacyJwtUser(raw) {
  let payload;
  try { payload = jwt.verify(raw, JWT_SECRET, { algorithms: ["HS256"] }); } catch { return null; }
  const row = db.prepare("SELECT id, role, auth_source, password_changed_at FROM users WHERE id = ?").get(payload.sub);
  if (!row || row.auth_source !== "legacy") return null;
  if (row.password_changed_at) {
    const changedMs = Date.parse(row.password_changed_at);
    if (typeof payload.iat_ms === "number") {
      if (payload.iat_ms < changedMs) return null;
    } else if (typeof payload.iat !== "number" || payload.iat <= Math.floor(changedMs / 1000)) {
      return null;
    }
  }
  return { payload, row };
}

// Usuário (id da client-api) por trás de um Authorization: Bearer, só para
// comparar com o da sessão do portal: JWT legado válido ou chave de API ativa.
function bearerUserId(raw) {
  const j = legacyJwtUser(raw);
  if (j) return j.row.id;
  const t = lookupActiveToken(raw);
  return t && t.user_id != null ? t.user_id : null;
}

function identityError(status, error, message) {
  return { error: { status, body: { error, message } } };
}

// Valida X-Portal-Session no Bongo. Não exige conta de desenvolvedor.
// Devolve { error } ou { portal, devUser }.
async function resolvePortalSession(req, token) {
  let info;
  try {
    info = await bongo.introspect(token);
  } catch (e) {
    if (!(e instanceof IdentityUnavailableError)) throw e;
    console.warn(`[identity] introspecção no Bongo indisponível (${e.code}) — acesso negado (falha fechada)`);
    return identityError(503, "IDENTITY_UNAVAILABLE", "Serviço de identidade do portal indisponível. Tente novamente em instantes.");
  }
  if (!info.active) {
    return identityError(401, "PORTAL_SESSION_INVALID", "Sessão do portal inválida ou expirada. Entre novamente no portal.");
  }
  const u = info.user;
  if (!info.authorization || info.authorization.qrng !== true) {
    audit.recordDeduped(`identity.denied:${u.id}:qrng_not_granted`, {
      type: "identity.denied", outcome: "denied", req, metadata: { reason: "qrng_not_granted", portal_user_id: u.id },
    });
    return identityError(403, "QRNG_ACCESS_DENIED", "Sua conta do portal não tem acesso ao QRNG.");
  }
  const portal = {
    id: u.id,
    email: typeof u.email === "string" ? u.email : null,
    name: typeof u.name === "string" ? u.name : null,
  };
  const devUser = db.prepare("SELECT * FROM users WHERE bongo_user_id = ?").get(portal.id) || null;
  return { portal, devUser };
}

// portal_email = cópia de exibição (nunca usada para autenticar), gravada só
// quando muda; last_login_at no primeiro uso da sessão do portal a cada hora
// (sem escrita por requisição).
const PORTAL_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
function touchPortalUse(devUser, portal) {
  if (portal.email && portal.email !== devUser.portal_email) {
    db.prepare("UPDATE users SET portal_email = ? WHERE id = ?").run(portal.email, devUser.id);
  }
  const last = devUser.last_login_at ? Date.parse(devUser.last_login_at) : 0;
  if (!(Date.now() - last < PORTAL_TOUCH_INTERVAL_MS)) {
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), devUser.id);
  }
}

// Sessão do portal que PRECISA de conta de desenvolvedor (todas as rotas
// exceto /v1/identity/*). `bearer` = Authorization presente junto, se houver.
// X-Portal-Session junto com um Authorization: Bearer só passa se o Bearer for
// da MESMA conta de desenvolvedor da sessão (sem conta ainda → nunca é a
// mesma). Vale também para /v1/identity/*. Devolve { error } ou null.
function ambiguousCredentials(req, r, bearer) {
  if (!bearer || (r.devUser && bearerUserId(bearer) === r.devUser.id)) return null;
  audit.recordDeduped(`identity.denied:${r.portal.id}:ambiguous_credentials`, {
    type: "identity.denied", outcome: "denied", req, actorUserId: r.devUser ? r.devUser.id : null,
    metadata: { reason: "ambiguous_credentials", portal_user_id: r.portal.id },
  });
  return identityError(400, "AMBIGUOUS_CREDENTIALS",
    "X-Portal-Session e Authorization apontam para contas diferentes. Envie só uma credencial.");
}

async function authenticatePortalDeveloper(req, portalTok, bearer) {
  const r = await resolvePortalSession(req, portalTok);
  if (r.error) return r;
  const amb = ambiguousCredentials(req, r, bearer);
  if (amb) return amb;
  if (!r.devUser) {
    return identityError(404, "DEVELOPER_ACCOUNT_NOT_PROVISIONED",
      "Sua conta do portal ainda não tem conta de desenvolvedor do QRNG. Crie uma (POST /v1/identity/provision) ou vincule a conta antiga (POST /v1/identity/link).");
  }
  touchPortalUse(r.devUser, r.portal);
  return {
    portal: r.portal,
    devUser: r.devUser,
    // Mesmo formato do payload do JWT legado; o papel efetivo é SEMPRE o da
    // linha da client-api (requireAdmin relê do banco) — nunca o do portal.
    user: { sub: r.devUser.id, email: r.devUser.email || r.devUser.portal_email || null, role: r.devUser.role, via: "portal" },
  };
}

// Express 4 não captura rejeições de middlewares async: encaminha ao handler de erro.
function requireAuth(req, res, next) {
  requireAuthAsync(req, res, next).catch(next);
}
async function requireAuthAsync(req, res, next) {
  const portalTok = portalSessionToken(req);
  const bearer = bearerToken(req);
  if (portalTok) {
    const r = await authenticatePortalDeveloper(req, portalTok, bearer);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    req.user = r.user;
    req.portal = r.portal;
    req.authMode = "portal";
    return next();
  }
  if (!bearer) {
    return res.status(401).json({ error: "MISSING_TOKEN", message: "Faça login primeiro." });
  }
  const j = legacyJwtUser(bearer);
  if (!j) {
    return res.status(401).json({ error: "SESSION_EXPIRED", message: "Sessão expirada. Faça login novamente." });
  }
  req.user = j.payload;
  req.authMode = "jwt";
  next();
}

// Só a sessão do portal, SEM exigir conta de desenvolvedor (rotas /v1/identity/*).
function requirePortalSession(req, res, next) {
  requirePortalSessionAsync(req, res, next).catch(next);
}
async function requirePortalSessionAsync(req, res, next) {
  const tok = portalSessionToken(req);
  if (!tok) {
    return res.status(401).json({ error: "PORTAL_SESSION_INVALID", message: "Envie a sessão do portal no cabeçalho X-Portal-Session." });
  }
  const r = await resolvePortalSession(req, tok);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  const amb = ambiguousCredentials(req, r, bearerToken(req));
  if (amb) return res.status(amb.error.status).json(amb.error.body);
  req.portal = r.portal;
  req.devUser = r.devUser;
  req.portalToken = tok;
  if (r.devUser) touchPortalUse(r.devUser, r.portal);
  next();
}

// Fail-closed de fonte parada (ver REFUSE_WHEN_SOURCE_OFFLINE). O estado vem
// do poller de fundo, que lê source_status do /health do broker a cada 60 s.
function refuseIfSourceOffline(req, res, next) {
  if (REFUSE_WHEN_SOURCE_OFFLINE && upstreamState.status === "up" && upstreamState.sourceStatus === "offline") {
    const prov = resolveProvenance({ servedFromUpstream: false });
    return res.status(503).json({
      request_id: req.requestId,
      error: "SOURCE_OFFLINE",
      message: "A fonte física está parada (sem dados novos há mais de 60 s). Os bytes que restam no buffer não são servidos enquanto ela não voltar.",
      source_stall_seconds: upstreamState.sourceStallSeconds ?? null,
      provenance: prov.actual_origin,
      provenance_detail: prov,
    });
  }
  next();
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

function lookupActiveToken(raw) {
  return db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND status = 'active'").get(hashToken(raw));
}

// Contas de desenvolvedor CRIADAS PELO PORTAL (auth_source='portal') existem
// por causa da autorização do portal: se a conta do portal for desabilitada,
// perder o serviço qrng ou for excluída, a chave de API dela para de valer.
// O estado vem do Bongo (POST /api/internal/v1/accounts/status) e fica em
// cache por PORTAL_ACCOUNT_STATUS_CACHE_MS. Bongo fora do ar: vale o último
// estado conhecido e, sem nenhum, a chave continua valendo — a disponibilidade
// das chaves de API não passa a depender do Bongo. Contas legadas (vinculadas
// ou não) não são afetadas.
const portalAccountStatusCache = new Map(); // bongo_user_id → { at, allowed }
async function apiKeyAllowed(tokenRow) {
  if (!tokenRow || tokenRow.user_id == null) return true;
  const u = db.prepare("SELECT id, auth_source, bongo_user_id FROM users WHERE id = ?").get(tokenRow.user_id);
  if (!u || u.auth_source !== "portal" || !u.bongo_user_id) return true;
  const now = Date.now();
  const hit = portalAccountStatusCache.get(u.bongo_user_id);
  if (hit && now - hit.at < PORTAL_ACCOUNT_STATUS_CACHE_MS) return hit.allowed;
  let status;
  try {
    status = await bongo.accountStatus(u.bongo_user_id);
  } catch (e) {
    if (!(e instanceof IdentityUnavailableError)) throw e;
    return hit ? hit.allowed : true;
  }
  const allowed = Boolean(status && status.exists && status.active && status.qrng);
  if (portalAccountStatusCache.size > 10000) portalAccountStatusCache.clear();
  portalAccountStatusCache.set(u.bongo_user_id, { at: now, allowed });
  if (status && status.exists === false) {
    // Conta do portal excluída: o e-mail dela não fica guardado aqui.
    db.prepare("UPDATE users SET portal_email = NULL WHERE id = ? AND portal_email IS NOT NULL").run(u.id);
  }
  return allowed;
}
function portalAccessRevoked(req, res) {
  return res.status(403).json({ request_id: req.requestId, error: "PORTAL_ACCESS_REVOKED",
    message: "A conta do portal dona desta chave está desabilitada, sem acesso ao QRNG ou foi excluída." });
}

// API token — para /random e /health (machine-to-machine)
function requireToken(req, res, next) {
  requireTokenAsync(req, res, next).catch(next);
}
async function requireTokenAsync(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ request_id: req.requestId, error: "MISSING_TOKEN", message: "Use Authorization: Bearer <api_token>" });
  }
  const row = lookupActiveToken(auth.slice(7).trim());
  if (!row) return res.status(403).json({ request_id: req.requestId, error: "INVALID_TOKEN", message: "Token inválido ou revogado." });
  if (!(await apiKeyAllowed(row))) return portalAccessRevoked(req, res);
  req.tokenRow = row;
  next();
}

// Rotas QRNG Open API: o MESMO token pessoal, em Authorization: Bearer (como as rotas atuais) ou em X-API-Key
// (forma também prevista pelo contrato). Não há contas nem chaves próprias desta interface.
function requireApiCredential(req, res, next) {
  requireApiCredentialAsync(req, res, next).catch(next);
}
async function requireApiCredentialAsync(req, res, next) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const xkey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : null;
  if (bearer && xkey && bearer !== xkey) {
    return res.status(400).json({ request_id: req.requestId, error: "AMBIGUOUS_CREDENTIALS",
      message: "Envie o token em Authorization: Bearer OU em X-API-Key, não dois valores diferentes." });
  }
  const raw = bearer || xkey;
  if (!raw) {
    return res.status(401).json({ request_id: req.requestId, error: "MISSING_TOKEN",
      message: "Use Authorization: Bearer <api_token> ou X-API-Key: <api_token>" });
  }
  const row = lookupActiveToken(raw);
  if (!row) return res.status(403).json({ request_id: req.requestId, error: "INVALID_TOKEN", message: "Token inválido ou revogado." });
  if (!(await apiKeyAllowed(row))) return portalAccessRevoked(req, res);
  req.tokenRow = row;
  next();
}

// Dual auth — para /me/* (aceita sessão do portal, JWT legado ou API token)
function resolveUser(req, res, next) {
  resolveUserAsync(req, res, next).catch(next);
}
async function resolveUserAsync(req, res, next) {
  const portalTok = portalSessionToken(req);
  const raw = bearerToken(req);
  if (portalTok) {
    const r = await authenticatePortalDeveloper(req, portalTok, raw);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    req.user     = r.user;
    req.portal   = r.portal;
    req.tokenRow = db.prepare("SELECT * FROM api_tokens WHERE user_id = ? AND status = 'active'").get(r.devUser.id) || null;
    req.authMode = "portal";
    return next();
  }
  if (!raw) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Autenticação necessária." });
  }
  const j = legacyJwtUser(raw);
  if (j) {
    req.user     = j.payload;
    req.tokenRow = db.prepare("SELECT * FROM api_tokens WHERE user_id = ? AND status = 'active'").get(j.row.id) || null;
    req.authMode = "jwt";
    return next();
  }
  const row = lookupActiveToken(raw);
  if (row) {
    if (!(await apiKeyAllowed(row))) return portalAccessRevoked(req, res);
    req.tokenRow = row; req.authMode = "token"; return next();
  }
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

// Política de senha (2026-09-30): >= 12 caracteres, letra e número, <= 256.
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function passwordProblem(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) return `Senha mínima: ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Senha máxima: ${PASSWORD_MAX_LENGTH} caracteres.`;
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return "A senha precisa ter letras e números.";
  return null;
}

// Limites específicos de autenticação, além do global por IP (120/min):
// sem eles, 120 tentativas de senha por minuto contra a MESMA conta passavam.
function authLimitHandler(req, res) {
  res.status(429).json({ error: "TOO_MANY_ATTEMPTS", message: "Muitas tentativas. Tente novamente mais tarde." });
}
// Login bloqueado pelo limitador também vira evento (auth.login failure
// rate_limited), com o e-mail só como pseudônimo (subject_hash).
function loginLimitHandler(req, res) {
  const email = (req.body || {}).email;
  audit.record({ type: "auth.login", outcome: "failure", req, subjectEmail: typeof email === "string" ? email : null,
    metadata: { reason: "rate_limited" } });
  authLimitHandler(req, res);
}
const loginLimiterByIp = rateLimit({
  windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false, handler: loginLimitHandler,
});
// Teto de tentativas de senha por conta legada, em UM balde só (store próprio)
// para o login e para o vínculo (POST /v1/identity/link também confere a senha
// legada com bcrypt): várias contas do portal ou vários IPs não somam
// tentativas extras contra o mesmo e-mail.
const LOGIN_EMAIL_MAX_PER_WINDOW = 10;
const legacyEmailGuessStore = new rateLimit.MemoryStore();
const legacyEmailGuessKey = (email) => `email:${String(email || "").trim().toLowerCase()}`;
const loginLimiterByEmail = rateLimit({
  windowMs: 15 * 60 * 1000, max: LOGIN_EMAIL_MAX_PER_WINDOW, standardHeaders: true, legacyHeaders: false, handler: loginLimitHandler,
  store: legacyEmailGuessStore,
  keyGenerator: (req) => legacyEmailGuessKey((req.body || {}).email),
});
const registerLimiterByIp = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, handler: authLimitHandler,
});
// bcrypt de um usuário inexistente, para o login levar o mesmo tempo com ou
// sem conta (a latência não pode revelar e-mails cadastrados).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomUUID(), 12);

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
 *               password: { type: string, minLength: 12, maxLength: 256, description: "Letras e números." }
 *     responses:
 *       200:
 *         description: Conta criada.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400:
 *         description: Campos ausentes, e-mail inválido, senha fraca (< 12, sem letra/número), ou JSON inválido (error=INVALID_JSON).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: E-mail já cadastrado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 *       429:
 *         description: Muitos cadastros deste IP (20/hora). error=TOO_MANY_ATTEMPTS.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/auth/register", registerLimiterByIp, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "MISSING_FIELDS", message: "Email e senha são obrigatórios." });
  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: "INVALID_EMAIL", message: "E-mail inválido." });
  }
  const pwdProblem = passwordProblem(password);
  if (pwdProblem) return res.status(400).json({ error: "WEAK_PASSWORD", message: pwdProblem });
  const role = ALLOW_ADMIN_EMAIL_BOOTSTRAP && ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL ? "admin" : "user";
  const now  = new Date().toISOString();
  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run(email.toLowerCase(), hash, role, now);
    const token  = signLegacyJwt({ sub: result.lastInsertRowid, email: email.toLowerCase(), role });
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
 *       429:
 *         description: Muitas tentativas (50/15 min por IP, 10/15 min por e-mail). error=TOO_MANY_ATTEMPTS.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/auth/login", attachRequestId, loginLimiterByIp, loginLimiterByEmail, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }
  // Só contas LEGADAS têm e-mail/senha aqui (as do portal têm email NULL e nunca casam).
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND auth_source = 'legacy' AND password_hash IS NOT NULL").get(email.toLowerCase());
  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    audit.record({ type: "auth.login", outcome: "failure", req, subjectEmail: email, metadata: { reason: "bad_credentials" } });
    return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "E-mail ou senha incorretos." });
  }
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
  audit.record({ type: "auth.login", outcome: "success", req, actorUserId: user.id, metadata: { auth_mode: "legacy" } });
  const token = signLegacyJwt({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, email: user.email, role: user.role });
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Retorna os dados da conta autenticada.
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
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
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.get("/v1/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(req.user.sub);
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  res.json(user);
});

/**
 * @openapi
 * /auth/me:
 *   delete:
 *     tags: [Auth]
 *     summary: Exclui a própria conta (exige a senha). Tokens são apagados; registros de uso ficam anônimos.
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Conta excluída.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Senha incorreta (INVALID_PASSWORD). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.delete("/v1/auth/me", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  const user = db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(req.user.sub);
  // Conta criada pelo portal não tem senha local: não há o que conferir aqui
  // (bcrypt.compare com hash NULL lançaria). A exclusão dela é pelo administrador.
  if (!user.password_hash) {
    return res.status(403).json({ error: "INVALID_PASSWORD", message: "Conta criada pelo portal: peça a exclusão ao administrador." });
  }
  if (typeof password !== "string" || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(403).json({ error: "INVALID_PASSWORD", message: "Senha incorreta." });
  }
  deleteUserData(user.id);
  res.json({ deleted: true });
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
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
 *     responses:
 *       200:
 *         description: Token criado.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TokenIssued' } } }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       409:
 *         description: Usuário já tem um token ativo.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }, { portalSession: [] }]
 *     responses:
 *       200:
 *         description: Metadados do token, ou { has_token false } se nenhum existir.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TokenInfo' } } }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }, { portalSession: [] }]
 *     responses:
 *       200:
 *         description: Novo token emitido.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TokenIssued' } } }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404:
 *         description: Nenhum token ativo encontrado. Com X-Portal-Session, também DEVELOPER_ACCOUNT_NOT_PROVISIONED (identidade do portal sem conta de desenvolvedor).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }, { portalSession: [] }]
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
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404:
 *         description: Nenhum token ativo encontrado. Com X-Portal-Session, também DEVELOPER_ACCOUNT_NOT_PROVISIONED (identidade do portal sem conta de desenvolvedor).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }, { portalSession: [] }]
 *     responses:
 *       200:
 *         description: Resumo de uso.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UsageResponse' } } }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }, { portalSession: [] }]
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
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { bearerAuthToken: [] }, { portalSession: [] }]
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
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
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
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Sem permissão (FORBIDDEN, rota de admin sem role=admin). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
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
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Token revogado.
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Sem permissão (FORBIDDEN, rota de admin sem role=admin). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: Token não encontrado. Com X-Portal-Session, também DEVELOPER_ACCOUNT_NOT_PROVISIONED (identidade do portal sem conta de desenvolvedor).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.post("/v1/admin/tokens/:id/revoke", requireAuth, requireAdmin, (req, res) => {
  const now    = new Date().toISOString();
  const result = db.prepare("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "NOT_FOUND" });
  const owner = db.prepare("SELECT user_id FROM api_tokens WHERE id = ?").get(req.params.id);
  audit.record({ type: "admin.token.revoked", outcome: "success", req, actorUserId: Number(req.user.sub),
    targetUserId: owner ? owner.user_id : null, metadata: { token_id: Number(req.params.id) } });
  res.json({ message: "Token revogado.", revoked_at: now });
});

/**
 * @openapi
 * /admin/tokens/{id}/quota:
 *   patch:
 *     tags: [Admin]
 *     summary: Ajusta a cota diária de requisições de um token (requer role=admin).
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
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
 *         description: quota_daily ausente ou inválida. Com X-Portal-Session, também AMBIGUOUS_CREDENTIALS (Authorization de outra conta junto).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Sem permissão (FORBIDDEN, rota de admin sem role=admin). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: Token não encontrado. Com X-Portal-Session, também DEVELOPER_ACCOUNT_NOT_PROVISIONED (identidade do portal sem conta de desenvolvedor).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.patch("/v1/admin/tokens/:id/quota", requireAuth, requireAdmin, (req, res) => {
  const quota  = parseInt(req.body.quota_daily, 10);
  if (!quota || quota < 1) return res.status(400).json({ error: "INVALID_QUOTA" });
  const prev = db.prepare("SELECT user_id, quota_daily FROM api_tokens WHERE id = ?").get(req.params.id);
  const result = db.prepare("UPDATE api_tokens SET quota_daily = ? WHERE id = ?").run(quota, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "NOT_FOUND" });
  audit.record({ type: "admin.token.quota_changed", outcome: "success", req, actorUserId: Number(req.user.sub),
    targetUserId: prev ? prev.user_id : null,
    metadata: { token_id: Number(req.params.id), quota_before: prev ? prev.quota_daily : null, quota_after: quota } });
  res.json({ message: "Cota atualizada.", quota_daily: quota });
});

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: Lista todos os usuários (requer role=admin).
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
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
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Sem permissão (FORBIDDEN, rota de admin sem role=admin). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.get("/v1/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC").all();
  res.json({ users });
});

/**
 * @openapi
 * /admin/users/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Exclui a conta de um usuário (atendimento a pedido de exclusão). Requer role=admin.
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Conta excluída.
 *       400:
 *         description: Tentativa de excluir a própria conta de administrador (CANNOT_DELETE_SELF). Com X-Portal-Session, também AMBIGUOUS_CREDENTIALS (Authorization de outra conta junto).
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Sem permissão (FORBIDDEN, rota de admin sem role=admin). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: Usuário não encontrado. Com X-Portal-Session, também DEVELOPER_ACCOUNT_NOT_PROVISIONED (identidade do portal sem conta de desenvolvedor).
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.delete("/v1/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "USER_NOT_FOUND" });
  if (id === Number(req.user.sub)) {
    return res.status(400).json({ error: "CANNOT_DELETE_SELF", message: "Use outro administrador para remover esta conta." });
  }
  const target = db.prepare("SELECT auth_source FROM users WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "USER_NOT_FOUND" });
  deleteUserData(id);
  audit.record({ type: "admin.user.deleted", outcome: "success", req, actorUserId: Number(req.user.sub), targetUserId: id,
    metadata: { auth_source: target.auth_source } });
  res.json({ deleted: true });
});

/**
 * @openapi
 * /admin/audit:
 *   get:
 *     tags: [Admin]
 *     summary: Eventos de auditoria da client-api (requer role=admin).
 *     description: >
 *       Login legado, recuperação de senha, provisão/vínculo de identidade,
 *       negações e ações administrativas. Nunca contém senha, JWT, token de
 *       recuperação/reauth, link nem e-mail (falhas e eventos anônimos só têm
 *       subject_hash, um pseudônimo HMAC). Mais recentes primeiro.
 *     security: [{ bearerAuthJWT: [] }, { portalSession: [] }]
 *     parameters:
 *       - { name: type, in: query, schema: { type: string }, description: "Filtra por event_type (ex.: auth.login)." }
 *       - { name: outcome, in: query, schema: { type: string, enum: [success, failure, denied] } }
 *       - { name: before, in: query, schema: { type: string }, description: "Paginação: id numérico (eventos com id menor) ou data ISO (eventos anteriores)." }
 *       - { name: limit, in: query, schema: { type: integer, default: 100, maximum: 500 } }
 *     responses:
 *       200:
 *         description: Lista de eventos.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/AuditEvent' }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: Sem permissão (FORBIDDEN, rota de admin sem role=admin). Com X-Portal-Session, também QRNG_ACCESS_DENIED (conta do portal sem acesso ao QRNG).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404: { $ref: '#/components/responses/DeveloperAccountNotProvisioned' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.get("/v1/admin/audit", requireAuth, requireAdmin, (req, res) => {
  const q = req.query || {};
  res.setHeader("Cache-Control", "no-store");
  res.json({ events: audit.list({ type: q.type, outcome: q.outcome, before: q.before, limit: q.limit }) });
});

// ── Tarefas em segundo plano (respostas que não podem depender do resultado) ──
// O pedido de recuperação responde 202 ANTES de procurar a conta e falar com a
// fila de e-mail do Bongo: o tempo de resposta é o mesmo exista a conta ou não
// (sem enumeração por latência). Os testes esperam com waitForBackgroundJobs().
const backgroundJobs = new Set();
function runInBackground(fn) {
  const p = Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[background] tarefa falhou: ${e && e.code ? e.code : (e && e.name) || "erro"}`))
    .finally(() => backgroundJobs.delete(p));
  backgroundJobs.add(p);
}
async function waitForBackgroundJobs() {
  while (backgroundJobs.size > 0) await Promise.allSettled([...backgroundJobs]);
}

// ── Identidade integrada: sessão do portal ↔ conta de desenvolvedor ──────────
// (doc 155, 2.5). Autenticação = X-Portal-Session (introspecção). Vínculo de
// uma conta legada só com prova de controle das DUAS contas: reauth recente no
// Bongo (reauthToken de uso único, finalidade link_qrng_developer) E e-mail +
// senha da conta legada. NUNCA por igualdade de e-mail.

const LINK_REAUTH_PURPOSE = "link_qrng_developer";

function developerAccountView(row) {
  if (!row) return null;
  const tok = db.prepare("SELECT 1 FROM api_tokens WHERE user_id = ? AND status = 'active'").get(row.id);
  return { id: row.id, auth_source: row.auth_source, linked_at: row.linked_at, has_token: Boolean(tok) };
}

function newRateStore() { return new rateLimit.MemoryStore(); }
const identityRateStores = [legacyEmailGuessStore];
function identityLimiter(opts) {
  const store = newRateStore();
  identityRateStores.push(store);
  return rateLimit({ standardHeaders: true, legacyHeaders: false, handler: authLimitHandler, store, ...opts });
}

// Tentativas de vínculo: só FALHAS contam (como o limitador de senha do Bongo).
const linkLimiterByIp = identityLimiter({ windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true });
const linkLimiterByPortalUser = identityLimiter({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  keyGenerator: (req) => `portal:${req.portal ? req.portal.id : "?"}`,
});

/**
 * @openapi
 * /identity/status:
 *   get:
 *     tags: [Identity]
 *     summary: Identidade do portal e a conta de desenvolvedor do QRNG ligada a ela (se houver).
 *     description: >
 *       Autentica pela sessão do portal (cabeçalho X-Portal-Session), validada
 *       no Bongo por introspecção. Não cria nem vincula nada: uma conta antiga
 *       com o MESMO e-mail não é vinculada automaticamente (use /identity/link).
 *     security: [{ portalSession: [] }]
 *     responses:
 *       200:
 *         description: Estado da identidade.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/IdentityStatus' } } }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/PortalSessionInvalid' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.get("/v1/identity/status", attachRequestId, requirePortalSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const dev = developerAccountView(req.devUser);
  res.json({
    portal: { id: req.portal.id, email: req.portal.email, name: req.portal.name },
    developer_account: dev,
    can_provision: !dev,
    can_link: !dev,
  });
});

/**
 * @openapi
 * /identity/provision:
 *   post:
 *     tags: [Identity]
 *     summary: Cria a conta de desenvolvedor do QRNG para a identidade do portal (sem senha local).
 *     description: >
 *       A conta nasce vinculada (auth_source=portal), sem e-mail/senha locais —
 *       não colide com uma conta antiga de mesmo e-mail e não tem login legado.
 *       Papel sempre "user" (o papel de administrador da client-api não vem do portal).
 *       Depois, emita o token de API com POST /tokens usando a mesma sessão do portal.
 *     security: [{ portalSession: [] }]
 *     responses:
 *       201:
 *         description: Conta criada.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 developer_account: { $ref: '#/components/schemas/DeveloperAccount' }
 *       400: { $ref: '#/components/responses/AmbiguousPortalCredentials' }
 *       401: { $ref: '#/components/responses/PortalSessionInvalid' }
 *       403: { $ref: '#/components/responses/QrngAccessDenied' }
 *       409:
 *         description: A identidade do portal já tem conta de desenvolvedor (PORTAL_ALREADY_LINKED).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.post("/v1/identity/provision", attachRequestId, requirePortalSession, (req, res) => {
  const portal = req.portal;
  if (req.devUser) {
    audit.record({ type: "identity.provisioned", outcome: "failure", req, actorUserId: req.devUser.id,
      metadata: { reason: "portal_already_linked", portal_user_id: portal.id } });
    return res.status(409).json({ error: "PORTAL_ALREADY_LINKED", message: "Esta conta do portal já tem conta de desenvolvedor." });
  }
  const now = new Date().toISOString();
  let id;
  try {
    id = Number(db.prepare(`
      INSERT INTO users (email, password_hash, role, created_at, bongo_user_id, auth_source, linked_at, portal_email, last_login_at)
      VALUES (NULL, NULL, 'user', ?, ?, 'portal', ?, ?, ?)
    `).run(now, portal.id, now, portal.email, now).lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "PORTAL_ALREADY_LINKED", message: "Esta conta do portal já tem conta de desenvolvedor." });
    }
    throw err;
  }
  audit.record({ type: "identity.provisioned", outcome: "success", req, actorUserId: id, targetUserId: id,
    metadata: { portal_user_id: portal.id } });
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  res.status(201).json({ developer_account: developerAccountView(row) });
});

/**
 * @openapi
 * /identity/link:
 *   post:
 *     tags: [Identity]
 *     summary: Vincula uma conta de desenvolvedor ANTIGA (e-mail e senha da client-api) à identidade do portal.
 *     description: >
 *       Exige prova de controle das duas contas: (1) sessão do portal +
 *       reautenticação recente no portal (reauthToken de uso único, finalidade
 *       link_qrng_developer, obtido em POST /api/auth/reauth do portal) e (2)
 *       e-mail + senha da conta antiga. Igualdade de e-mail não basta. O vínculo
 *       mantém id, token de API, cota e histórico; o login antigo continua
 *       funcionando. Desvinculação só por script administrativo ou pela
 *       redefinição de senha da conta antiga (POST /auth/password-reset/confirm).
 *       Não envie Authorization de outra conta junto (400 AMBIGUOUS_CREDENTIALS).
 *     security: [{ portalSession: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reauthToken, legacyEmail, legacyPassword]
 *             properties:
 *               reauthToken: { type: string }
 *               legacyEmail: { type: string, format: email }
 *               legacyPassword: { type: string }
 *               lang: { type: string, enum: [pt, en], description: Idioma do aviso de vínculo enviado ao e-mail da conta antiga (padrão pt). }
 *     responses:
 *       200:
 *         description: Conta vinculada. Um aviso (sem link) é enfileirado para o e-mail da conta antiga.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 linked: { type: boolean }
 *                 developer_account: { $ref: '#/components/schemas/DeveloperAccount' }
 *       400:
 *         description: Campos ausentes (MISSING_FIELDS) ou Authorization de outra conta junto com X-Portal-Session (AMBIGUOUS_CREDENTIALS).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       401: { $ref: '#/components/responses/PortalSessionInvalid' }
 *       403:
 *         description: >
 *           REAUTH_REQUIRED (reauthToken ausente, inválido, vencido, já usado ou de outra finalidade),
 *           INVALID_LEGACY_CREDENTIALS (e-mail/senha da conta antiga incorretos) ou QRNG_ACCESS_DENIED.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: PORTAL_ALREADY_LINKED (esta identidade já tem conta) ou ACCOUNT_ALREADY_LINKED (a conta antiga já está vinculada).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 *       429:
 *         description: >
 *           Muitas tentativas de vínculo malsucedidas (TOO_MANY_ATTEMPTS): por IP, por conta do portal e
 *           por conta antiga — este último no MESMO limite do login por e-mail (10/15 min somando login e vínculo).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503: { $ref: '#/components/responses/IdentityUnavailable' }
 */
app.post("/v1/identity/link", attachRequestId, linkLimiterByIp, requirePortalSession, linkLimiterByPortalUser, (req, res, next) => {
  identityLink(req, res).catch(next);
});
async function identityLink(req, res) {
  const portal = req.portal;
  const { reauthToken, legacyEmail, legacyPassword } = req.body || {};
  const fail = (status, error, message, reason, extra = {}) => {
    audit.record({ type: "identity.linked", outcome: "failure", req, metadata: { reason, portal_user_id: portal.id }, ...extra });
    return res.status(status).json({ error, message });
  };
  if (typeof legacyEmail !== "string" || typeof legacyPassword !== "string" || !legacyEmail || !legacyPassword) {
    return res.status(400).json({ error: "MISSING_FIELDS", message: "Informe reauthToken, legacyEmail e legacyPassword." });
  }
  if (req.devUser) {
    return fail(409, "PORTAL_ALREADY_LINKED", "Esta conta do portal já tem conta de desenvolvedor.", "portal_already_linked",
      { actorUserId: req.devUser.id });
  }
  if (typeof reauthToken !== "string" || !reauthToken) {
    return fail(403, "REAUTH_REQUIRED", "Confirme sua senha do portal antes de vincular a conta.", "reauth_missing");
  }
  // Mesmo balde do limite de login por e-mail: checado antes de gastar o
  // reauth; só tentativas com senha legada ERRADA somam (abaixo).
  const guessKey = legacyEmailGuessKey(legacyEmail);
  const guesses = await legacyEmailGuessStore.get(guessKey);
  if (guesses && guesses.totalHits >= LOGIN_EMAIL_MAX_PER_WINDOW) {
    return fail(429, "TOO_MANY_ATTEMPTS", "Muitas tentativas. Tente novamente mais tarde.", "rate_limited",
      { subjectEmail: legacyEmail });
  }

  // (1) Reautenticação no Bongo: uso único, mesma pessoa, mesma finalidade.
  let info;
  try {
    info = await bongo.introspect(req.portalToken, { reauthToken, reauthPurpose: LINK_REAUTH_PURPOSE });
  } catch (e) {
    if (!(e instanceof IdentityUnavailableError)) throw e;
    console.warn(`[identity] introspecção no Bongo indisponível (${e.code}) — vínculo recusado (falha fechada)`);
    return res.status(503).json({ error: "IDENTITY_UNAVAILABLE", message: "Serviço de identidade do portal indisponível. Tente novamente em instantes." });
  }
  if (!info.active) return res.status(401).json({ error: "PORTAL_SESSION_INVALID", message: "Sessão do portal inválida ou expirada. Entre novamente no portal." });
  if (!info.authorization || info.authorization.qrng !== true) {
    return res.status(403).json({ error: "QRNG_ACCESS_DENIED", message: "Sua conta do portal não tem acesso ao QRNG." });
  }
  const reauthOk = info.user && info.user.id === portal.id && info.reauth && info.reauth.verified === true
    && info.reauth.purpose === LINK_REAUTH_PURPOSE;
  if (!reauthOk) {
    audit.record({ type: "auth.reauth", outcome: "failure", req, metadata: { reason: "reauth_invalid", portal_user_id: portal.id } });
    return fail(403, "REAUTH_REQUIRED", "Confirmação de senha do portal inválida ou vencida. Confirme de novo.", "reauth_invalid");
  }

  // (2) Credenciais da conta legada (bcrypt contra hash fictício se não existir:
  // mesma latência com ou sem conta).
  const legacy = db.prepare("SELECT * FROM users WHERE email = ? AND auth_source = 'legacy' AND password_hash IS NOT NULL")
    .get(legacyEmail.trim().toLowerCase());
  const valid = await bcrypt.compare(legacyPassword, legacy ? legacy.password_hash : DUMMY_PASSWORD_HASH);
  if (!legacy || !valid) {
    await legacyEmailGuessStore.increment(guessKey);
    return fail(403, "INVALID_LEGACY_CREDENTIALS", "E-mail ou senha da conta de desenvolvedor incorretos.", "bad_legacy_credentials",
      { subjectEmail: legacyEmail });
  }
  if (legacy.bongo_user_id) {
    return fail(409, "ACCOUNT_ALREADY_LINKED", "Esta conta de desenvolvedor já está vinculada a outra conta do portal.",
      "account_already_linked", { targetUserId: legacy.id });
  }

  const now = new Date().toISOString();
  let changes;
  try {
    changes = db.prepare(`
      UPDATE users SET bongo_user_id = ?, linked_at = ?, portal_email = ?
      WHERE id = ? AND auth_source = 'legacy' AND bongo_user_id IS NULL
    `).run(portal.id, now, portal.email, legacy.id).changes;
  } catch (err) {
    // UNIQUE(bongo_user_id): a mesma identidade do portal foi vinculada/provisionada em paralelo.
    if (String(err.message).includes("UNIQUE")) {
      return fail(409, "PORTAL_ALREADY_LINKED", "Esta conta do portal já tem conta de desenvolvedor.", "portal_already_linked",
        { targetUserId: legacy.id });
    }
    throw err;
  }
  if (changes !== 1) {
    return fail(409, "ACCOUNT_ALREADY_LINKED", "Esta conta de desenvolvedor já está vinculada a outra conta do portal.",
      "account_already_linked", { targetUserId: legacy.id });
  }
  audit.record({ type: "identity.linked", outcome: "success", req, actorUserId: legacy.id, targetUserId: legacy.id,
    metadata: { portal_user_id: portal.id } });
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(legacy.id);
  res.json({ linked: true, developer_account: developerAccountView(row) });
  // Aviso ao e-mail da conta ANTIGA: um vínculo feito por quem soube a senha
  // legada não passa despercebido (o dono redefine a senha, o que desfaz o
  // vínculo). Sem segredo e sem o e-mail do portal no corpo.
  const locale = (req.body || {}).lang === "en" ? "en" : "pt";
  runInBackground(async () => {
    try {
      await bongo.enqueueMail({
        template: "qrng_legacy_account_linked", to: legacy.email, locale, secret: null, secretExpiresAt: null,
        idempotencyKey: `qrng-legacy-linked-${crypto.randomUUID()}`, validity: { kind: "none", ref: null },
      });
    } catch (e) {
      console.warn(`[identity] aviso de vínculo NÃO enfileirado (${e && e.code ? e.code : "erro"})`);
    }
  });
}

// ── Recuperação de senha das contas LEGADAS (doc 155, 2.5 + 3) ────────────────
// Token: 32 bytes do CSPRNG do SO (crypto.randomBytes — nunca o QRNG), base64url;
// só o SHA-256 fica no banco. Pedido novo invalida os anteriores. O link vai
// para a fila central de e-mail do Bongo (secret cifrado lá, apagado quando a
// mensagem é aceita/cancelada/expira) e NUNCA para log, auditoria ou resposta.
//
// Bongo inacessível no pedido: a resposta continua o 202 genérico, o token é
// MANTIDO (expira sozinho em QRNG_RESET_TOKEN_TTL_MINUTES), a falha fica na
// auditoria (auth.password_reset.requested, outcome=failure,
// reason=mail_queue_unavailable) e o e-mail simplesmente não sai — o usuário
// pede de novo. Não há fila local: o Bongo é a única trilha de envio.
//
// Cancelamento ativo: ao invalidar (pedido novo) ou usar (confirmação) um
// token, a client-api avisa o Bongo (POST /api/internal/v1/mail/cancel) para
// que uma mensagem ainda não enviada com aquele link morra na fila. É
// melhor-esforço: se falhar, o link já está morto aqui (quem valida o token é
// a client-api) e o segredo expira no prazo do lado do Bongo.
function cancelLegacyResetMails(tokenIds) {
  const refs = [...new Set(tokenIds.map(String))];
  if (refs.length === 0) return;
  runInBackground(async () => {
    try {
      await bongo.cancelMail({ kind: "qrng_legacy_password_reset", refs });
    } catch (e) {
      console.warn(`[password-reset] cancelamento na fila do Bongo falhou (${e && e.code ? e.code : "erro"}); o token já está invalidado aqui`);
    }
  });
}

const RESET_TOKEN_RX = /^[A-Za-z0-9_-]{43}$/;
const RESET_GENERIC_MESSAGE = "Se houver uma conta de desenvolvedor com este e-mail, enviaremos um link para redefinir a senha.";
const resetEmailKey = (req) => `reset:${String((req.body || {}).email || "").trim().toLowerCase()}`;
const resetRequestLimiterByIp = identityLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const resetRequestLimiterByEmailMinute = identityLimiter({ windowMs: 60 * 1000, max: 1, keyGenerator: resetEmailKey });
const resetRequestLimiterByEmailDay = identityLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 5, keyGenerator: resetEmailKey });
const resetTokenLimiterByIp = identityLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

function findUsableResetToken(token) {
  if (typeof token !== "string" || !RESET_TOKEN_RX.test(token)) return null;
  return db.prepare(`
    SELECT t.* FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id AND u.auth_source = 'legacy'
    WHERE t.token_hash = ? AND t.used_at IS NULL AND t.invalidated_at IS NULL AND t.expires_at > ?
  `).get(hashToken(token), new Date().toISOString()) || null;
}

// Contexto mínimo para a auditoria fora do ciclo da requisição (sem o corpo).
function auditCtx(req) {
  return { requestId: req.requestId, ip: req.ip || (req.socket && req.socket.remoteAddress) || null };
}

async function processLegacyResetRequest(email, locale, ctx) {
  const user = db.prepare("SELECT id, email FROM users WHERE email = ? AND auth_source = 'legacy' AND password_hash IS NOT NULL").get(email);
  if (!user) {
    audit.record({ type: "auth.password_reset.requested", outcome: "success", req: ctx, subjectEmail: email,
      metadata: { account_found: false, delivered_to_queue: false } });
    return;
  }
  const raw = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + QRNG_RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
  let tokenId;
  let previousIds = [];
  db.transaction(() => {
    previousIds = db.prepare("SELECT id FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL")
      .all(user.id).map((r) => r.id);
    db.prepare("UPDATE password_reset_tokens SET invalidated_at = ? WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL")
      .run(nowIso, user.id);
    tokenId = Number(db.prepare(`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at, requested_ip_prefix, sent_to_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, hashToken(raw), expiresAt, nowIso, ctx.ip ? truncateIp(ctx.ip) : null, audit.subjectHash(user.email)).lastInsertRowid);
  })();
  cancelLegacyResetMails(previousIds);
  let delivered = false;
  try {
    await bongo.enqueueMail({
      template: "qrng_legacy_password_reset",
      to: user.email,
      locale,
      secret: `${QRNG_PASSWORD_RESET_URL}#token=${raw}`,
      secretExpiresAt: expiresAt,
      idempotencyKey: `qrng-legacy-reset-${crypto.randomUUID()}`,
      validity: { kind: "qrng_legacy_password_reset", ref: String(tokenId) },
    });
    delivered = true;
  } catch (e) {
    console.warn(`[password-reset] fila de e-mail do Bongo indisponível (${e && e.code ? e.code : "erro"}); token mantido até expirar, e-mail NÃO enfileirado`);
  }
  audit.record({ type: "auth.password_reset.requested", outcome: delivered ? "success" : "failure", req: ctx,
    targetUserId: user.id, subjectEmail: user.email,
    metadata: { account_found: true, delivered_to_queue: delivered, reason: delivered ? undefined : "mail_queue_unavailable" } });
}

/**
 * @openapi
 * /auth/password-reset/status:
 *   get:
 *     tags: [Auth]
 *     summary: Diz se a recuperação de senha por e-mail das contas antigas está disponível.
 *     description: >
 *       Público e sem dados de conta. Com self_service=false, o pedido de
 *       recuperação responde 503 PASSWORD_RESET_UNAVAILABLE e a interface
 *       orienta o contato com o suporte.
 *     responses:
 *       200:
 *         description: Disponibilidade.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 self_service: { type: boolean }
 */
app.get("/v1/auth/password-reset/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ self_service: QRNG_PASSWORD_RESET_ENABLED });
});

/**
 * @openapi
 * /auth/password-reset/request:
 *   post:
 *     tags: [Auth]
 *     summary: Pede o link de redefinição de senha de uma conta de desenvolvedor antiga (e-mail e senha).
 *     description: >
 *       Com a recuperação ligada: resposta SEMPRE 202 genérica, exista a conta
 *       ou não (o processamento é feito depois da resposta). O link chega por
 *       e-mail, vale 30 minutos e é de uso único; um pedido novo invalida os
 *       anteriores. Com a recuperação desligada (padrão, enquanto o envio de
 *       e-mail não está ativo): 503 PASSWORD_RESET_UNAVAILABLE para qualquer
 *       e-mail e nenhum token é gerado. Contas criadas pelo portal não têm
 *       senha local — use a recuperação de senha do portal.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *               lang: { type: string, enum: [pt, en], default: pt }
 *     responses:
 *       202:
 *         description: Pedido recebido (mensagem genérica).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: E-mail ausente ou inválido (INVALID_EMAIL).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 *       429:
 *         description: Muitos pedidos (10/15 min por IP; 1/min e 5/dia por e-mail). error=TOO_MANY_ATTEMPTS.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       503:
 *         description: Recuperação por e-mail desligada neste ambiente (PASSWORD_RESET_UNAVAILABLE). Fale com o suporte.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
function legacyResetEnabled(req, res, next) {
  if (QRNG_PASSWORD_RESET_ENABLED) return next();
  return res.status(503).json({ error: "PASSWORD_RESET_UNAVAILABLE",
    message: "A recuperação de senha por e-mail não está disponível no momento. Fale com o suporte para redefinir a senha da conta de desenvolvedor." });
}
app.post("/v1/auth/password-reset/request", attachRequestId, legacyResetEnabled, resetRequestLimiterByIp, resetRequestLimiterByEmailMinute,
  resetRequestLimiterByEmailDay, (req, res) => {
    const { email, lang } = req.body || {};
    if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "INVALID_EMAIL", message: "E-mail inválido." });
    }
    const locale = lang === "en" ? "en" : "pt";
    const ctx = auditCtx(req);
    res.status(202).json({ message: RESET_GENERIC_MESSAGE });
    runInBackground(() => processLegacyResetRequest(email.trim().toLowerCase(), locale, ctx));
  });

/**
 * @openapi
 * /auth/password-reset/check:
 *   post:
 *     tags: [Auth]
 *     summary: Diz se um token de redefinição ainda vale, SEM consumi-lo.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: Resultado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid: { type: boolean }
 *       429:
 *         description: Muitas consultas deste IP (30/15 min). error=TOO_MANY_ATTEMPTS.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/auth/password-reset/check", attachRequestId, resetTokenLimiterByIp, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ valid: Boolean(findUsableResetToken((req.body || {}).token)) });
});

/**
 * @openapi
 * /auth/password-reset/confirm:
 *   post:
 *     tags: [Auth]
 *     summary: Define a nova senha com o token do e-mail (consumo atômico, uso único).
 *     description: >
 *       A regra de senha é verificada ANTES do token. Sucesso revoga todas as
 *       sessões (JWT) emitidas antes da redefinição, invalida os outros tokens
 *       de redefinição da conta, DESFAZ o vínculo com uma conta do portal (se
 *       houver — quem soube a senha antiga pode tê-la vinculado; para vincular
 *       de novo use POST /identity/link com a senha nova) e envia um aviso por
 *       e-mail. Não faz login automático: entre de novo com a nova senha. O
 *       token de API NÃO muda: se suspeitar de acesso indevido, gere outro em
 *       POST /me/token/rotate.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token: { type: string }
 *               password: { type: string, minLength: 12, maxLength: 256, description: "Letras e números." }
 *               lang: { type: string, enum: [pt, en], default: pt }
 *     responses:
 *       200:
 *         description: Senha redefinida.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: >
 *           WEAK_PASSWORD (regra de senha) ou INVALID_OR_EXPIRED_TOKEN (token inválido,
 *           vencido ou já usado — mesma resposta para os três).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       413: { $ref: '#/components/responses/PayloadTooLarge' }
 *       429:
 *         description: Muitas tentativas deste IP (30/15 min). error=TOO_MANY_ATTEMPTS.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
app.post("/v1/auth/password-reset/confirm", attachRequestId, resetTokenLimiterByIp, (req, res, next) => {
  confirmLegacyReset(req, res).catch(next);
});
async function confirmLegacyReset(req, res) {
  const { token, password, lang } = req.body || {};
  const pwdProblem = passwordProblem(password);
  if (pwdProblem) return res.status(400).json({ error: "WEAK_PASSWORD", message: pwdProblem });
  const invalid = () => {
    audit.record({ type: "auth.password_reset.completed", outcome: "failure", req, metadata: { reason: "invalid_or_expired" } });
    return res.status(400).json({ error: "INVALID_OR_EXPIRED_TOKEN", message: "Link de redefinição inválido, vencido ou já usado. Peça um novo." });
  };
  // Pré-checagem só para não gastar bcrypt com token inválido; quem decide é o UPDATE atômico abaixo.
  if (!findUsableResetToken(token)) return invalid();
  const newHash = await bcrypt.hash(password, 12);
  const tokenHash = hashToken(token);
  let user = null;
  let unlinkedPortalId = null;
  let deadTokenIds = [];
  const consume = db.transaction(() => {
    const nowIso = new Date().toISOString();
    const consumed = db.prepare(`
      UPDATE password_reset_tokens SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > ?
    `).run(nowIso, tokenHash, nowIso);
    if (consumed.changes !== 1) return; // outro pedido concorrente consumiu primeiro
    const t = db.prepare("SELECT user_id FROM password_reset_tokens WHERE token_hash = ?").get(tokenHash);
    const before = db.prepare("SELECT bongo_user_id FROM users WHERE id = ? AND auth_source = 'legacy'").get(t.user_id);
    // A redefinição (prova de controle do e-mail da conta) também DESFAZ um
    // vínculo com o portal: quem soube a senha antiga podia ter vinculado a
    // conta à própria identidade do portal e continuaria entrando por
    // X-Portal-Session depois da redefinição. O dono vincula de novo se quiser
    // (sessão do portal + reautenticação + a senha nova).
    const upd = db.prepare(`
      UPDATE users SET password_hash = ?, password_changed_at = ?, bongo_user_id = NULL, linked_at = NULL, portal_email = NULL
      WHERE id = ? AND auth_source = 'legacy'
    `).run(newHash, nowIso, t.user_id);
    if (upd.changes !== 1 || !before) throw Object.assign(new Error("conta legada ausente"), { code: "RESET_USER_GONE" });
    deadTokenIds = db.prepare("SELECT id FROM password_reset_tokens WHERE user_id = ? AND (token_hash = ? OR (used_at IS NULL AND invalidated_at IS NULL))")
      .all(t.user_id, tokenHash).map((r) => r.id);
    db.prepare("UPDATE password_reset_tokens SET invalidated_at = ? WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL")
      .run(nowIso, t.user_id);
    unlinkedPortalId = before.bongo_user_id || null;
    user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(t.user_id);
  });
  try {
    consume();
  } catch (e) {
    // Conta excluída entre a pré-checagem e o consumo: a transação foi desfeita.
    if (e && e.code === "RESET_USER_GONE") return invalid();
    throw e;
  }
  if (!user) return invalid();
  audit.record({ type: "auth.password_reset.completed", outcome: "success", req, actorUserId: user.id, targetUserId: user.id });
  if (unlinkedPortalId) {
    audit.record({ type: "identity.unlinked", outcome: "success", req, actorUserId: user.id, targetUserId: user.id,
      metadata: { via: "password_reset", portal_user_id: unlinkedPortalId } });
  }
  res.json({ message: "Senha redefinida. Entre novamente com a nova senha." });
  cancelLegacyResetMails(deadTokenIds);
  const locale = lang === "en" ? "en" : "pt";
  runInBackground(async () => {
    try {
      await bongo.enqueueMail({
        template: "qrng_legacy_password_changed", to: user.email, locale, secret: null, secretExpiresAt: null,
        idempotencyKey: `qrng-legacy-changed-${crypto.randomUUID()}`, validity: { kind: "none", ref: null },
      });
    } catch (e) {
      console.warn(`[password-reset] aviso de senha alterada NÃO enfileirado (${e && e.code ? e.code : "erro"})`);
    }
  });
}

// ── API interna para o worker de e-mail do Bongo ──────────────────────────────
// Antes de enviar um e-mail de recuperação legado, o worker pergunta se o token
// ainda vale (não usado, não invalidado, não vencido, conta ainda existe) — para
// não mandar um link morto. Só com INTERNAL_SERVICE_TOKEN (comparação em tempo
// constante); sem ele, 404 idêntico ao de uma rota inexistente. Na borda, o
// nginx devolve 404 para /qrng/v1/internal/v1/ (a rota nunca sai do host).
function internalServiceAuthorized(req) {
  const got = bearerToken(req);
  if (!INTERNAL_SERVICE_TOKEN || !got) return false;
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(INTERNAL_SERVICE_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @openapi
 * /internal/v1/password-reset/{id}/status:
 *   get:
 *     tags: [Internal]
 *     summary: (Interno, serviço↔serviço) Validade de um token de redefinição legado, pelo id.
 *     description: >
 *       Usado só pelo worker de e-mail do Bongo, com Authorization Bearer
 *       INTERNAL_SERVICE_TOKEN. Fora das duas specs publicadas (tag Internal).
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Resultado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid: { type: boolean }
 *       404:
 *         description: Sem credencial de serviço válida (indistinguível de rota inexistente).
 */
// Sem credencial de serviço a rota "não existe": next("route") cai no MESMO
// 404 catch-all de uma rota desconhecida (sem X-Request-Id, request_id novo),
// por isso a checagem vem ANTES de attachRequestId.
function internalServiceOnly(req, res, next) {
  if (!internalServiceAuthorized(req)) return next("route");
  next();
}
app.get("/v1/internal/v1/password-reset/:id/status", internalServiceOnly, attachRequestId, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.json({ valid: false });
  const row = db.prepare(`
    SELECT t.used_at, t.invalidated_at, t.expires_at FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id AND u.auth_source = 'legacy'
    WHERE t.id = ?
  `).get(id);
  const valid = Boolean(row && !row.used_at && !row.invalidated_at && row.expires_at > new Date().toISOString());
  res.json({ valid });
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
    // /health não entrega bytes de amostra: "live" aqui só com a evidência da
    // sonda do hardware (entropy_health + qualification_status + frescor) que o
    // broker publica no JSON.
    const prov = resolveProvenance({
      servedFromUpstream: false,
      upstreamReachable: true,
      upstreamHeaders: statusHeadersFromHealthJson(data, upHdr),
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
 *             schema: { type: string, enum: ['true', 'false'] }
 *             description: "'true' só quando o broker afirma conditioned=true E qualification_status=verified_active_bitstream (bitstream formal com extrator Toeplitz 256→128 no FPGA, verificado ATIVO por sonda da placa); 'false' em qualquer outro caso, inclusive broker antigo. Presente em todos os formatos."
 *           X-QRNG-Qualification-Status:
 *             schema: { type: string }
 *             description: "Repassado do broker quando presente: verified_active_bitstream | inactive_other_bitstream | unverified_stale_probe | unverified_no_probe | none | ..."
 *           X-QRNG-Bitstream-SHA256:
 *             schema: { type: string }
 *             description: "SHA-256 do bitstream qualificado verificado ativo. Ausente salvo verified_active_bitstream."
 *           X-QRNG-Entropy-Health:
 *             schema: { type: string, enum: [hw_health_tests_passing, hw_health_alarm, hw_health_unavailable, not_assessed, healthy, degraded, failed] }
 *             description: "Estado dos health tests RCT/APT do HARDWARE (registos do wrapper lidos só em leitura pela sonda do broker). Não é validação SP 800-90B."
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

/**
 * Serviço comum de aquisição: UMA chamada GET /random ao broker para exatamente `bytes` bytes, com o contrato de
 * transporte (Content-Length, Content-Type) validado. Usado por /v1/random, /v1/raw, /v1/public/* e pela camada
 * QRNG Open API, que diferem só em autenticação, contabilização e formato da resposta.
 *
 * Retorna { ok: true, buf, upHdr } com buf.length === bytes EXATOS, ou { ok: false, status, body } (corpo sem
 * request_id; o chamador registra o uso e responde). Erros de rede/timeout são LANÇADOS, como antes, e cada rota os
 * trata no próprio catch. Nunca completa, repete, corta para menos nem troca de fonte: menos bytes que o pedido é 503.
 * A região entregue sai do buffer do broker de forma destrutiva e atômica (pop sob trava): nada aqui guarda ou reusa
 * bytes entre requisições.
 */
async function acquireUpstreamBytes(bytes) {
  const upBytes = Math.min(bytes * UPSTREAM_OVERPROVISION, 50 * 1024 * 1024);
  const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/random?bytes=${upBytes}`, QRNG_TIMEOUT_MS);

  if (!r.ok) {
    const prov = resolveProvenance({ servedFromUpstream: false, upstreamHeaders: lowerHeaders(r.headers) });
    return { ok: false, status: 502, body: { error: "UPSTREAM_ERROR", status: r.status, provenance: prov.actual_origin, provenance_detail: prov } };
  }

  const contentType         = r.headers.get("content-type");
  const contentLengthHeader = r.headers.get("content-length");
  const rawBuffer           = await r.buffer();

  // Content-Length é validado ANTES de qualquer interpretação: se o
  // transporte já mente sobre o tamanho, não há por que confiar no corpo.
  if (contentLengthHeader !== null && Number(contentLengthHeader) !== rawBuffer.length) {
    return { ok: false, status: 502, body: {
      error: "UPSTREAM_LENGTH_MISMATCH",
      message: `Content-Length declarado (${contentLengthHeader}) não bate com bytes efetivamente recebidos (${rawBuffer.length}).`,
    } };
  }

  let buf;
  try {
    buf = interpretUpstreamResponse(contentType, rawBuffer, bytes);
  } catch (err) {
    if (err instanceof UpstreamFormatError) return { ok: false, status: 502, body: { error: err.code, message: err.message } };
    throw err;
  }

  const upHdr = lowerHeaders(r.headers);

  if (buf.length < bytes) {
    const prov = resolveProvenance({ servedFromUpstream: false, upstreamHeaders: upHdr, insufficientEntropy: true });
    return { ok: false, status: 503, body: { error: "INSUFFICIENT_ENTROPY", available: buf.length, requested: bytes, provenance: prov.actual_origin, provenance_detail: prov } };
  }
  return { ok: true, buf: buf.slice(0, bytes), upHdr }; // upBytes é sobre-provisionado; entrega exatamente o pedido
}

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
    const acq = await acquireUpstreamBytes(bytes);
    if (!acq.ok) {
      logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, acq.status, ip, ua, Date.now() - t0);
      return res.status(acq.status).json({ request_id: requestId, ...acq.body });
    }
    const { buf, upHdr } = acq;

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
      setSourceQualificationHeaders(res, upHdr);
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
    setSourceQualificationHeaders(res, upHdr);
    res.json({ request_id: requestId, source: QRNG_SOURCE_LABEL, provenance: prov.actual_origin, provenance_detail: prov, bytes, format, random, timestamp: new Date().toISOString() });

  } catch (err) {
    logRequest(requestId, req.tokenRow.id, "/v1/random", bytes, format, 503, ip, ua, Date.now() - t0);
    // O motivo real (URL interna do broker, erro de socket) fica só no log.
    console.error(`[qrng-client-api] upstream indisponível request_id=${requestId}: ${err.message}`);
    const prov = resolveProvenance({ servedFromUpstream: false });
    res.status(503).json({ request_id: requestId, error: "QRNG_UNAVAILABLE", message: "Fonte QRNG indisponível no momento.", provenance: prov.actual_origin, provenance_detail: prov });
  }
}

const randomChain = [attachRequestId, requireToken, checkTokenRate, parseBytes, checkQuota, refuseIfSourceOffline];
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
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['true', 'false'] }, description: "'true' só com conditioned=true E verified_active_bitstream do broker; 'false' caso contrário. Ver também X-QRNG-Qualification-Status, X-QRNG-Bitstream-SHA256, X-QRNG-Entropy-Health." }
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

// ── QRNG Open API (contrato Palo Alto Networks e parceiros) ──────────────────
// Camada de compatibilidade AO LADO das rotas atuais: mesmo token, mesmos limites por token/IP, mesma cota diária,
// mesma aquisição de bytes (acquireUpstreamBytes), mesmo bloqueio de fonte parada e mesma proveniência.
// Lógica do contrato em lib/qrng-open-api.js; avaliação, ambiguidades e exemplos em docs/qrng-open-api.md.
// Endereço público: https://bongo.dobslit.com/qrng/v1/{capabilities,entropy,healthtest} (nginx: /qrng/v1/ → :3010/v1/).
const qoa = require("./lib/qrng-open-api");
const OPENAPI_LIMITS = qoa.resolveLimits({
  maxTotalBytes: MAX_BYTES_PER_REQUEST,   // o MESMO limite por requisição de /v1/random
  maxBlockSize:  parseInt(process.env.QRNG_OPENAPI_MAX_BLOCK_SIZE  || String(MAX_BYTES_PER_REQUEST), 10),
  maxBlockCount: parseInt(process.env.QRNG_OPENAPI_MAX_BLOCK_COUNT || "1024", 10),
  entropyTypes:  [process.env.QRNG_OPENAPI_ENTROPY_TYPE || "kuapoa_qrng"],
});
const QRNG_PUBLIC_BASE_URL = (process.env.QRNG_PUBLIC_BASE_URL || "https://bongo.dobslit.com/qrng/v1").replace(/\/+$/, "");

// Leitura do /health do broker para /capabilities e /healthtest (status, não entropia). Cache curto: no máximo uma
// consulta ao broker a cada BROKER_STATUS_TTL_MS. Este cache NUNCA libera bytes: /v1/entropy decide pelo próprio pop no
// broker e pelo mesmo bloqueio de fonte parada das rotas atuais.
const BROKER_STATUS_TTL_MS = parseInt(process.env.QRNG_OPENAPI_STATUS_TTL_MS || "3000", 10);
let brokerStatusCache = { at: 0, ok: false, data: null, readAt: null };
async function readBrokerStatus() {
  const now = Date.now();
  if (brokerStatusCache.data !== null && now - brokerStatusCache.at <= BROKER_STATUS_TTL_MS) return brokerStatusCache;
  try {
    const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/health`, Math.min(QRNG_TIMEOUT_MS, 5000));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("JSON inesperado");
    brokerStatusCache = { at: now, ok: true, data, readAt: new Date(now).toISOString() };
  } catch (err) {
    console.error(`[qrng-open-api] /health do broker indisponível: ${err.message}`);
    brokerStatusCache = { at: now, ok: false, data: {}, readAt: new Date(now).toISOString() };
  }
  return brokerStatusCache;
}

// Toda resposta das rotas do contrato, inclusive os erros de token, limite, cota e fonte parada, é marcada no-store.
function qoaNoStore(_req, res, next) { res.setHeader("Cache-Control", "no-store"); next(); }

function qoaError(res, status, requestId, error, message, extra) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ request_id: requestId, error, message, ...(extra || {}) });
}

/**
 * @openapi
 * /capabilities:
 *   get:
 *     tags: [QRNG Open API]
 *     summary: "QRNG Open API — capacidades da plataforma: limites de bloco, tipos de entropia e testes de saúde."
 *     description: >
 *       Contrato QRNG Open API (revisão 812e2055 do repositório PaloAltoNetworks/QRNG-OPENAPI), implementado de forma
 *       própria. Os limites publicados são os que POST /entropy aplica. Como max_block_size × max_block_count pode
 *       passar do limite total por requisição, o limite total vai na extensão `kuapoa.limits` (max_total_bytes).
 *       Nenhuma taxa de produção é anunciada. Não consome entropia. Conta como 1 requisição na cota diária do token
 *       (mesma política de GET /health).
 *     security: [{ bearerAuthToken: [] }, { apiKeyHeader: [] }]
 *     responses:
 *       200:
 *         description: Capacidades.
 *         headers:
 *           X-Request-Id: { schema: { type: string } }
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QoaCapabilitiesResponse' } } }
 *       400: { description: "AMBIGUOUS_CREDENTIALS (Bearer e X-API-Key com valores diferentes).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: "INVALID_TOKEN, ou PORTAL_ACCESS_REVOKED (a conta do portal dona da chave foi desabilitada, perdeu o QRNG ou foi excluída).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       503: { description: "Fonte indisponível (broker inacessível ou fonte parada) — código do contrato.", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
app.get("/v1/capabilities", attachRequestId, qoaNoStore, requireApiCredential, checkTokenRate, async (req, res) => {
  const t0 = Date.now();
  const ip = req.ip || req.socket.remoteAddress;
  const st = await readBrokerStatus();
  const info = qoa.interpretBrokerHealth(st.data, st.readAt);
  if (!st.ok || info.sourceStatus === "offline") {
    logRequest(req.requestId, req.tokenRow.id, "/v1/capabilities", 0, null, 503, ip, req.headers["user-agent"], Date.now() - t0);
    return qoaError(res, 503, req.requestId, st.ok ? "SOURCE_OFFLINE" : "QRNG_UNAVAILABLE",
      st.ok ? "A fonte física está parada; nenhuma entropia está disponível agora." : "Fonte QRNG indisponível no momento.");
  }
  logRequest(req.requestId, req.tokenRow.id, "/v1/capabilities", 0, null, 200, ip, req.headers["user-agent"], Date.now() - t0);
  res.setHeader("Cache-Control", "no-store");
  res.json(qoa.buildCapabilities(OPENAPI_LIMITS, info, {
    reportLink: `${QRNG_PUBLIC_BASE_URL}/healthtest`,
    quotas: { dailyRequests: req.tokenRow.quota_daily, dailyBytes: DAILY_QUOTA_BYTES, perTokenPerMinute: RATE_LIMIT_PER_TOKEN_MIN },
  }));
});

// Valida o corpo de POST /v1/entropy ANTES de consumir entropia e define req.requestedBytes = total, para que a cota
// diária (checkQuota) avalie o total da chamada — com qualquer número de blocos, a chamada conta 1 requisição.
function parseOpenApiEntropy(req, res, next) {
  if (!req.is("application/json")) {
    return qoaError(res, 415, req.requestId, "UNSUPPORTED_MEDIA_TYPE", "Envie o corpo como JSON (Content-Type: application/json).");
  }
  const p = qoa.parseEntropyRequest(req.body, OPENAPI_LIMITS);
  if (!p.ok) {
    return qoaError(res, 422, req.requestId, p.error, p.message, p.field ? { field: p.field } : undefined);
  }
  req.openApiEntropy = p;
  req.requestedBytes = p.totalBytes;
  next();
}

/**
 * @openapi
 * /entropy:
 *   post:
 *     tags: [QRNG Open API]
 *     summary: "QRNG Open API — entrega entropia em blocos Base64 (block_size × block_count bytes)."
 *     description: >
 *       Mesma fonte, mesma aquisição e mesmas cotas de GET /random: a chamada retira do broker EXATAMENTE
 *       block_size × block_count bytes, divide em block_count blocos e codifica cada bloco em Base64. Nunca completa
 *       com zeros, PRNG ou repetição: se a fonte não entregar o total, a resposta é 503 e nenhum bloco é devolvido.
 *       Contabilização: 1 requisição e block_size × block_count bytes na cota diária do token (compartilhada com
 *       /random e /raw); falhas do upstream contam como nas rotas atuais. Proveniência e qualificação vão na extensão
 *       `kuapoa.response` e nos cabeçalhos X-QRNG-*. Nada da entropia é registrado em logs.
 *     security: [{ bearerAuthToken: [] }, { apiKeyHeader: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/QoaEntropyRequest' }
 *           examples:
 *             umBloco: { summary: "Um bloco de 32 bytes", value: { block_size: 32 } }
 *             variosBlocos: { summary: "Quatro blocos de 64 bytes", value: { block_size: 64, block_count: 4, entropy_type: kuapoa_qrng } }
 *     responses:
 *       200:
 *         description: block_count strings Base64, cada uma com block_size bytes depois de decodificada.
 *         headers:
 *           X-Request-Id: { schema: { type: string } }
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['true', 'false'] }, description: "Mesma regra de GET /random." }
 *           X-QRNG-Entropy-Health: { schema: { type: string }, description: "Estado dos health tests RCT/APT do hardware nesta resposta." }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QoaEntropyResponse' } } }
 *       400: { description: "AMBIGUOUS_CREDENTIALS ou INVALID_JSON (corpo que não é JSON válido).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: "INVALID_TOKEN, ou PORTAL_ACCESS_REVOKED (a conta do portal dona da chave foi desabilitada, perdeu o QRNG ou foi excluída).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       413: { description: "REQUEST_BODY_TOO_LARGE (corpo JSON acima de 8 KiB).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       415: { description: "UNSUPPORTED_MEDIA_TYPE (corpo sem Content-Type application/json).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       422: { description: "Parâmetro inválido — código do contrato. error: INVALID_REQUEST_BODY | MISSING_BLOCK_SIZE | INVALID_BLOCK_SIZE | BLOCK_SIZE_OUT_OF_RANGE | INVALID_BLOCK_COUNT | BLOCK_COUNT_OUT_OF_RANGE | UNSUPPORTED_ENTROPY_TYPE | TOTAL_TOO_LARGE. Nenhuma entropia é consumida.", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { description: "RATE_LIMIT_EXCEEDED, QUOTA_EXCEEDED ou QUOTA_BYTES_EXCEEDED (mesmos limites e cotas de /random).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       502: { description: "Upstream com erro (exceto 503/504) ou fora do contrato de transporte (mesmos códigos de /random).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       503: { description: "Fonte indisponível — código do contrato. error: QRNG_UNAVAILABLE (broker inacessível, timeout ou broker sem os bytes: upstream_status 503/504) | INSUFFICIENT_ENTROPY | SOURCE_OFFLINE.", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
async function openApiEntropyHandler(req, res) {
  const { blockSize, blockCount, entropyType, totalBytes } = req.openApiEntropy;
  const ip        = req.ip || req.socket.remoteAddress;
  const ua        = req.headers["user-agent"];
  const requestId = req.requestId;
  const t0        = Date.now();
  const FORMAT    = "qrng-openapi";
  res.setHeader("Cache-Control", "no-store");
  try {
    const acq = await acquireUpstreamBytes(totalBytes);
    if (!acq.ok) {
      let { status, body } = acq;
      // Contrato: 503 = fonte de entropia indisponível. O broker responde 503 quando não tem os bytes dentro do
      // timeout; aqui isso é 503 (as rotas atuais continuam com o 502 UPSTREAM_ERROR de sempre).
      if (body.error === "UPSTREAM_ERROR" && (body.status === 503 || body.status === 504)) {
        status = 503;
        body = { error: "QRNG_UNAVAILABLE", message: "Fonte QRNG indisponível no momento.", upstream_status: body.status,
                 provenance: body.provenance, provenance_detail: body.provenance_detail };
      }
      logRequest(requestId, req.tokenRow.id, "/v1/entropy", totalBytes, FORMAT, status, ip, ua, Date.now() - t0);
      return res.status(status).json({ request_id: requestId, ...body });
    }
    const entropy = qoa.splitBlocksBase64(acq.buf, blockSize, blockCount);
    logRequest(requestId, req.tokenRow.id, "/v1/entropy", totalBytes, FORMAT, 200, ip, ua, Date.now() - t0);
    const prov = resolveProvenance({ servedFromUpstream: true, upstreamHeaders: acq.upHdr });
    const q = sourceQualificationFrom(acq.upHdr);
    setProvenanceHeaders(res, prov);
    setSourceQualificationHeaders(res, acq.upHdr);
    res.json({
      entropy,
      extensions: [qoa.ext("kuapoa.response", {
        request_id: requestId,
        entropy_type: entropyType,
        block_size: blockSize,
        block_count: blockCount,
        total_bytes: totalBytes,
        encoding: "base64",
        source: QRNG_SOURCE_LABEL,
        conditioned: q.conditioned,
        qualification_status: q.qualificationStatus,
        bitstream_sha256: q.bitstreamSha256,
        entropy_health: prov.entropy_health || "not_assessed",
        provenance: prov.actual_origin,
        provenance_detail: prov,
        served_at: prov.served_at,
      })],
    });
  } catch (err) {
    logRequest(requestId, req.tokenRow.id, "/v1/entropy", totalBytes, FORMAT, 503, ip, ua, Date.now() - t0);
    // Só a mensagem do erro de transporte (sem URL do broker no corpo e nunca bytes de entropia).
    console.error(`[qrng-client-api] upstream indisponível request_id=${requestId}: ${err.message}`);
    const prov = resolveProvenance({ servedFromUpstream: false });
    res.status(503).json({ request_id: requestId, error: "QRNG_UNAVAILABLE", message: "Fonte QRNG indisponível no momento.", provenance: prov.actual_origin, provenance_detail: prov });
  }
}

app.post("/v1/entropy", attachRequestId, qoaNoStore, requireApiCredential, checkTokenRate, parseOpenApiEntropy, checkQuota, refuseIfSourceOffline, openApiEntropyHandler);

/**
 * @openapi
 * /healthtest:
 *   get:
 *     tags: [QRNG Open API]
 *     summary: "QRNG Open API — estado observado dos testes de saúde da fonte (somente leitura, sem consumir entropia)."
 *     description: >
 *       test_result traz SÓ observações atuais, cada uma com o instante em que foi feita:
 *       kuapoa_hw_continuous_rct_apt (health tests RCT/APT executados no FPGA sobre cada amostra bruta, lidos pela sonda
 *       da placa; time_stamp = instante da leitura da sonda), kuapoa_source_liveness (fonte enviando dados) e
 *       kuapoa_bitstream_qualification (bitstream qualificado verificado ativo). Os valores de test_result são texto
 *       (passing, alarm, unavailable, not_assessed, online, offline…): nenhum número é inventado para representar
 *       aprovação. Observação vencida aparece como unavailable, nunca como passing. Resultados de avaliações offline
 *       (H_original, h_out pré-restart, limitações) vão só na extensão `kuapoa.historical_assessment`, marcada como não
 *       sendo saúde em tempo real. Nada aqui é validação SP 800-90B ou certificação. Leitura do broker com cache de até
 *       3 s; conta como 1 requisição na cota diária do token (mesma política de GET /health).
 *     security: [{ bearerAuthToken: [] }, { apiKeyHeader: [] }]
 *     responses:
 *       200:
 *         description: Estado observado (inclusive alarme — um alarme é um resultado, não uma falha desta rota).
 *         headers:
 *           X-Request-Id: { schema: { type: string } }
 *           Cache-Control: { schema: { type: string, example: no-store } }
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QoaHealthtestResponse' } } }
 *       400: { description: "AMBIGUOUS_CREDENTIALS.", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: "INVALID_TOKEN, ou PORTAL_ACCESS_REVOKED (a conta do portal dona da chave foi desabilitada, perdeu o QRNG ou foi excluída).", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       503: { description: "Fonte dos testes de saúde indisponível (broker inacessível) — código do contrato.", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
app.get("/v1/healthtest", attachRequestId, qoaNoStore, requireApiCredential, checkTokenRate, async (req, res) => {
  const t0 = Date.now();
  const ip = req.ip || req.socket.remoteAddress;
  const st = await readBrokerStatus();
  if (!st.ok) {
    logRequest(req.requestId, req.tokenRow.id, "/v1/healthtest", 0, null, 503, ip, req.headers["user-agent"], Date.now() - t0);
    return qoaError(res, 503, req.requestId, "HEALTH_TEST_SOURCE_UNAVAILABLE", "Não foi possível ler o estado da fonte agora.");
  }
  logRequest(req.requestId, req.tokenRow.id, "/v1/healthtest", 0, null, 200, ip, req.headers["user-agent"], Date.now() - t0);
  res.setHeader("Cache-Control", "no-store");
  res.json(qoa.buildHealthtest(qoa.interpretBrokerHealth(st.data, st.readAt), { reportLink: `${QRNG_PUBLIC_BASE_URL}/health` }));
});

// Método errado nas rotas do contrato: 405 com Allow, em vez do 404 genérico.
for (const [route, allow] of [["/v1/capabilities", "GET"], ["/v1/entropy", "POST"], ["/v1/healthtest", "GET"]]) {
  app.all(route, attachRequestId, (req, res) => {
    res.setHeader("Allow", allow);
    return qoaError(res, 405, req.requestId, "METHOD_NOT_ALLOWED", `Use ${allow} ${route}.`);
  });
}

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

// Limites do endpoint público elevados (2026-09-19): 20 req/min e 10 MiB/dia
// eram baixos demais para o uso real do site -- a aba Representações
// Visuais sozinha reabastece 8192 bytes a cada poucos segundos enquanto
// aberta, e qualquer sessão de alguns minutos já estourava ambas as cotas
// mesmo sem uso abusivo. Segue mais generoso que antes mas ainda abaixo do
// limite autenticado (RATE_LIMIT_PER_IP_MIN=120/min, DAILY_QUOTA=10000
// req · 100 MiB), preservando a proteção contra abuso que este endpoint
// dedicado foi criado para substituir (ver comentário acima).
const PUBLIC_MAX_BYTES_PER_REQUEST   = parseInt(process.env.PUBLIC_MAX_BYTES_PER_REQUEST        || "65536", 10);            // 64 KiB
const PUBLIC_RATE_LIMIT_PER_IP_MIN   = parseInt(process.env.PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE  || "120", 10);
const PUBLIC_DAILY_QUOTA_REQUESTS_IP = parseInt(process.env.PUBLIC_DAILY_QUOTA_REQUESTS_PER_IP   || "5000", 10);
const PUBLIC_DAILY_QUOTA_BYTES_IP    = parseInt(process.env.PUBLIC_DAILY_QUOTA_BYTES_PER_IP      || String(50 * 1024 * 1024), 10); // 50 MiB

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
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['true', 'false'] }, description: "'true' só com conditioned=true E verified_active_bitstream do broker; 'false' caso contrário. Ver também X-QRNG-Qualification-Status, X-QRNG-Bitstream-SHA256, X-QRNG-Entropy-Health." }
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
    const acq = await acquireUpstreamBytes(bytes);
    if (!acq.ok) {
      // token_id NULL agrega todo o tráfego público anônimo numa única linha
      // de daily_usage (esperado -- a cota real deste caminho é aplicada por
      // IP via publicIpDailyUsage acima, não por essa tabela).
      logRequest(requestId, null, "/v1/public/random", bytes, format, acq.status, ip, ua, Date.now() - t0);
      recordPublicUsage(ip, bytes);
      return res.status(acq.status).json({ request_id: requestId, ...acq.body });
    }
    const { buf, upHdr } = acq;

    logRequest(requestId, null, "/v1/public/random", bytes, format, 200, ip, ua, Date.now() - t0);
    recordPublicUsage(ip, bytes);
    metricsCounters.public_requests_total++;

    const prov = resolveProvenance({ servedFromUpstream: true, upstreamHeaders: upHdr });

    if (format === "raw") {
      res.status(200);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("X-QRNG-Source", QRNG_SOURCE_LABEL);
      setSourceQualificationHeaders(res, upHdr);
      setProvenanceHeaders(res, prov);
      return res.end(buf); // corpo = EXATAMENTE N bytes, sem JSON/BOM/prefixo
    }

    const random = format === "hex"    ? buf.toString("hex")
                 : format === "base64" ? buf.toString("base64")
                 : Array.from(buf);

    // Paridade com raw: proveniência nos headers também nas respostas JSON.
    setProvenanceHeaders(res, prov);
    setSourceQualificationHeaders(res, upHdr);
    res.json({ request_id: requestId, source: QRNG_SOURCE_LABEL, provenance: prov.actual_origin, provenance_detail: prov, bytes, format, random, timestamp: new Date().toISOString() });

  } catch (err) {
    logRequest(requestId, null, "/v1/public/random", bytes, format, 503, ip, ua, Date.now() - t0);
    recordPublicUsage(ip, 0); // nenhum byte entregue: não desconta da cota de bytes
    console.error(`[qrng-client-api] upstream indisponível request_id=${requestId}: ${err.message}`);
    const prov = resolveProvenance({ servedFromUpstream: false });
    res.status(503).json({ request_id: requestId, error: "QRNG_UNAVAILABLE", message: "Fonte QRNG indisponível no momento.", provenance: prov.actual_origin, provenance_detail: prov });
  }
}

const publicRandomChain = [attachRequestId, publicIpRateLimiter, parsePublicBytes, checkPublicQuota, refuseIfSourceOffline];
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
 *           X-QRNG-Conditioned: { schema: { type: string, enum: ['true', 'false'] }, description: "'true' só com conditioned=true E verified_active_bitstream do broker; 'false' caso contrário. Ver também X-QRNG-Qualification-Status, X-QRNG-Bitstream-SHA256, X-QRNG-Entropy-Health." }
 *         content:
 *           application/octet-stream: { schema: { type: string, format: binary } }
 *       413: { description: bytes acima de PUBLIC_MAX_BYTES_PER_REQUEST., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       422: { description: bytes inválido., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { description: Rate limit por IP ou cota pública excedida., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       502: { description: Upstream com erro ou formato inesperado., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       503: { description: Upstream indisponível ou entropia insuficiente., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
app.get("/v1/public/raw", ...publicRandomChain, (req, res) => { res.locals.forceRawFormat = true; return publicRandomHandler(req, res); });

// ── Amostra rápida + cota pública (2026-10-18) ──────────────────────────────
//
// Medido em produção: o botão "Baixar dados QRNG" fazia 16 chamadas de 64 KiB
// em sequência; cada uma paga a ida e volta usuário → VM → túnel → Recife
// (≈1,3–1,5 s), total de 24 s a ~1 min. O broker entrega 1 MiB numa única
// chamada em ≈1,1 s. /v1/public/sample entrega até 1 MiB numa só resposta,
// de preferência a partir de um pool pré-carregado em memória (bytes
// recém-chegados do hardware, entregues uma única vez, descartados após
// ENTROPY_POOL_MAX_AGE_MS). Sem pool, busca direto no broker (1 chamada).
const { EntropyPool } = require("./lib/entropyPool");
const PUBLIC_SAMPLE_MAX_BYTES     = parseInt(process.env.PUBLIC_SAMPLE_MAX_BYTES || "1048576", 10);           // 1 MiB
const PUBLIC_SAMPLE_PER_WINDOW    = parseInt(process.env.PUBLIC_SAMPLE_PER_WINDOW || "10", 10);
const PUBLIC_SAMPLE_WINDOW_MS     = parseInt(process.env.PUBLIC_SAMPLE_WINDOW_MS || String(10 * 60 * 1000), 10); // 10 min
const ENTROPY_POOL_BYTES          = parseInt(process.env.ENTROPY_POOL_BYTES ?? (process.env.NODE_ENV === "test" ? "0" : String(2 * 1024 * 1024)), 10);
const ENTROPY_POOL_MAX_AGE_MS     = parseInt(process.env.ENTROPY_POOL_MAX_AGE_MS || String(Math.max(30000, LIVE_SAMPLE_MAX_AGE_MS - 60000)), 10);

/** Busca n bytes no broker numa única chamada e classifica o bloco (ordem temporal). */
async function fetchUpstreamBlock(n) {
  const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/random?bytes=${n}`, Math.max(QRNG_TIMEOUT_MS, 15000));
  if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
  const contentLengthHeader = r.headers.get("content-length");
  const rawBuffer = await r.buffer();
  if (contentLengthHeader !== null && Number(contentLengthHeader) !== rawBuffer.length) throw new Error("UPSTREAM_LENGTH_MISMATCH");
  const buf = interpretUpstreamResponse(r.headers.get("content-type"), rawBuffer, n);
  if (buf.length < n) throw new Error("INSUFFICIENT_ENTROPY");
  const upHdr = lowerHeaders(r.headers);
  const prov = resolveProvenance({ servedFromUpstream: true, upstreamHeaders: upHdr });
  return { buf: buf.slice(0, n), upHdr, prov, discontinuous: prov.buffer_health === "discontinuous" };
}

const entropyPool = new EntropyPool({
  capacityBytes: ENTROPY_POOL_BYTES,
  blockBytes: Math.min(PUBLIC_SAMPLE_MAX_BYTES, 1024 * 1024),
  maxAgeMs: ENTROPY_POOL_MAX_AGE_MS,
  // só guarda blocos íntegros: transporte saudável, sem gap NESTE bloco, sem
  // alarme dos health tests do hardware. Bloco recusado => pool não cresce.
  fetchBlock: async (n) => {
    const blk = await fetchUpstreamBlock(n);
    const ok = blk.prov.transport_health === "healthy" && blk.prov.buffer_health === "healthy"
      && !["failed", "hw_health_alarm"].includes(blk.prov.entropy_health);
    return ok ? blk : null;
  },
});

const publicSampleLimiter = rateLimit({
  windowMs: PUBLIC_SAMPLE_WINDOW_MS,
  max: PUBLIC_SAMPLE_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    metricsCounters.public_rate_limited_total++;
    res.status(429).json({
      request_id: req.requestId,
      error: "RATE_LIMIT_EXCEEDED",
      message: `Limite de ${PUBLIC_SAMPLE_PER_WINDOW} amostras rápidas a cada ${Math.round(PUBLIC_SAMPLE_WINDOW_MS / 60000)} min por IP. Use a aba Dados (lotes de 64 KiB) ou um token pessoal.`,
    });
  },
});

function parseSampleBytes(req, res, next) {
  const raw = req.query.bytes;
  const n = raw === undefined ? PUBLIC_SAMPLE_MAX_BYTES : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return res.status(422).json({ request_id: req.requestId, error: "INVALID_BYTES", message: "bytes deve ser um inteiro ≥ 1." });
  }
  if (n > PUBLIC_SAMPLE_MAX_BYTES) {
    return res.status(413).json({ request_id: req.requestId, error: "REQUEST_TOO_LARGE", message: `Amostra rápida: máximo de ${PUBLIC_SAMPLE_MAX_BYTES} bytes.`, max_bytes_per_request: PUBLIC_SAMPLE_MAX_BYTES });
  }
  req.requestedBytes = n;
  next();
}

/**
 * @openapi
 * /public/sample:
 *   get:
 *     tags: [Random]
 *     summary: Amostra rápida de até 1 MiB numa única resposta (anônimo, binário).
 *     description: >
 *       Entrega N bytes brutos (application/octet-stream) numa só resposta, de
 *       preferência a partir de um pool em memória com bytes recém-recebidos do
 *       hardware (cada byte é entregue uma única vez; blocos expiram em poucos
 *       minutos). Sem pool, busca direto na fonte. Conta na cota diária pública
 *       por IP (bytes e requisições) e tem limite próprio de amostras por janela.
 *       Cabeçalhos de proveniência iguais aos de /public/raw, mais
 *       X-QRNG-Delivery (prefetch-pool | direct) e X-QRNG-Pool-Age-Ms.
 *     parameters:
 *       - name: bytes
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 1048576, default: 1048576 }
 *     responses:
 *       200:
 *         description: N bytes brutos.
 *         headers:
 *           X-Request-Id: { schema: { type: string } }
 *           X-QRNG-Delivery: { schema: { type: string, enum: [prefetch-pool, direct] } }
 *           X-QRNG-Pool-Age-Ms: { schema: { type: integer }, description: Idade, em ms, do bloco mais antigo usado na resposta. }
 *         content:
 *           application/octet-stream: { schema: { type: string, format: binary } }
 *       413: { description: bytes acima do máximo da amostra rápida., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       422: { description: bytes inválido., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       429: { description: Limite de amostras por janela ou cota pública diária excedida., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       503: { description: Fonte indisponível., content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
app.get("/v1/public/sample", attachRequestId, publicSampleLimiter, parseSampleBytes, checkPublicQuota, refuseIfSourceOffline, async (req, res) => {
  const bytes = req.requestedBytes;
  const ip = req.ip || req.socket.remoteAddress;
  const ua = req.headers["user-agent"];
  const requestId = req.requestId;
  const t0 = Date.now();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Request-Id", requestId);
  try {
    let taken = entropyPool.take(bytes);
    let delivery = "prefetch-pool";
    if (!taken) {
      const blk = await fetchUpstreamBlock(bytes);
      taken = { buf: blk.buf, blocks: [{ upHdr: blk.upHdr, discontinuous: blk.discontinuous, receivedAt: Date.now() }] };
      delivery = "direct";
    }
    entropyPool.refill().catch(() => {});

    const oldest = taken.blocks[0];
    const anyGap = taken.blocks.some((b) => b.discontinuous);
    const count = Number(oldest.upHdr["x-qrng-discontinuities"]);
    const prov = resolveProvenance({
      servedFromUpstream: true,
      upstreamHeaders: oldest.upHdr,
      discontinuitiesBaseline: Number.isFinite(count) ? (anyGap ? count - 1 : count) : undefined,
    });

    logRequest(requestId, null, "/v1/public/sample", bytes, "raw", 200, ip, ua, Date.now() - t0);
    recordPublicUsage(ip, bytes);
    metricsCounters.public_requests_total++;

    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", taken.buf.length);
    res.setHeader("Content-Disposition", `attachment; filename="kuapoa_qrng_${bytes}B.bin"`);
    res.setHeader("X-QRNG-Source", QRNG_SOURCE_LABEL);
    res.setHeader("X-QRNG-Delivery", delivery);
    res.setHeader("X-QRNG-Pool-Age-Ms", String(Math.max(0, Date.now() - oldest.receivedAt)));
    setSourceQualificationHeaders(res, oldest.upHdr);
    setProvenanceHeaders(res, prov);
    return res.end(taken.buf);
  } catch (err) {
    console.error(`[sample] ${requestId}: ${err.message}`);
    logRequest(requestId, null, "/v1/public/sample", bytes, "raw", 503, ip, ua, Date.now() - t0);
    recordPublicUsage(ip, 0);
    return res.status(503).json({ request_id: requestId, error: "QRNG_UNAVAILABLE", message: "Fonte QRNG indisponível no momento." });
  }
});

/**
 * @openapi
 * /public/quota:
 *   get:
 *     tags: [Health]
 *     summary: Cota pública de hoje para o endereço de rede (IP) que faz a chamada.
 *     description: >
 *       Uso e limites do acesso sem token (contados por IP, zeram à meia-noite
 *       UTC). Não consome cota. Para limites maiores, use um token pessoal
 *       (ver /me/usage).
 *     responses:
 *       200:
 *         description: Uso e limites.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 scope: { type: string, enum: [ip] }
 *                 resets_at: { type: string, format: date-time }
 *                 requests_today: { type: integer }
 *                 quota_daily_requests: { type: integer }
 *                 bytes_today: { type: integer }
 *                 quota_daily_bytes: { type: integer }
 *                 max_bytes_per_request: { type: integer }
 *                 rate_limit_per_minute: { type: integer }
 *                 sample_max_bytes: { type: integer }
 *                 sample_per_window: { type: integer }
 *                 sample_window_seconds: { type: integer }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
app.get("/v1/public/quota", publicHealthLimiter, attachRequestId, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ip = req.ip || req.socket.remoteAddress;
  const today = new Date().toISOString().slice(0, 10);
  const e = publicIpDailyUsage.get(ip);
  const used = e && e.date === today ? e : { requests: 0, bytes: 0 };
  const resets = new Date(); resets.setUTCHours(24, 0, 0, 0);
  res.json({
    request_id: req.requestId,
    scope: "ip",
    date: today,
    resets_at: resets.toISOString(),
    requests_today: used.requests,
    quota_daily_requests: PUBLIC_DAILY_QUOTA_REQUESTS_IP,
    remaining_requests_today: Math.max(0, PUBLIC_DAILY_QUOTA_REQUESTS_IP - used.requests),
    bytes_today: used.bytes,
    quota_daily_bytes: PUBLIC_DAILY_QUOTA_BYTES_IP,
    remaining_bytes_today: Math.max(0, PUBLIC_DAILY_QUOTA_BYTES_IP - used.bytes),
    max_bytes_per_request: PUBLIC_MAX_BYTES_PER_REQUEST,
    rate_limit_per_minute: PUBLIC_RATE_LIMIT_PER_IP_MIN,
    sample_max_bytes: PUBLIC_SAMPLE_MAX_BYTES,
    sample_per_window: PUBLIC_SAMPLE_PER_WINDOW,
    sample_window_seconds: Math.round(PUBLIC_SAMPLE_WINDOW_MS / 1000),
    token_quota: { daily_requests: DAILY_QUOTA_REQUESTS, daily_bytes: DAILY_QUOTA_BYTES, max_bytes_per_request: MAX_BYTES_PER_REQUEST },
  });
});

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

  // QRNG Open API (POST /v1/entropy): mesma fonte e mesmas cotas de /v1/random, contada à parte para observabilidade.
  const qoaByStatus = db.prepare(`
    SELECT status_code, COUNT(*) as n, COALESCE(SUM(bytes_requested),0) as b
    FROM api_usage_logs WHERE endpoint = '/v1/entropy' GROUP BY status_code
  `).all();
  const qoaTotalBytes = qoaByStatus.find(r => r.status_code === 200)?.b || 0;

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
    "# HELP qrng_openapi_entropy_requests_total Total requests a POST /v1/entropy (QRNG Open API), por status",
    "# TYPE qrng_openapi_entropy_requests_total counter",
    ...qoaByStatus.map(r => `qrng_openapi_entropy_requests_total{status="${r.status_code}"} ${r.n}`),
    "",
    "# HELP qrng_openapi_entropy_bytes_total Total bytes de entropia entregues via POST /v1/entropy (status=200)",
    "# TYPE qrng_openapi_entropy_bytes_total counter",
    `qrng_openapi_entropy_bytes_total ${qoaTotalBytes}`,
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

let upstreamState = { status: "unknown", checkedAt: null, responseMs: null, sourceStatus: null, sourceStallSeconds: null };
let consecutiveFailures = 0;

async function checkUpstream() {
  const t0 = Date.now();
  let status, responseMs, detail, sourceStatus = null, sourceStallSeconds = null;
  try {
    const r = await fetchWithTimeout(`${QRNG_UPSTREAM}/health`, 5000);
    responseMs = Date.now() - t0;
    status = r.ok ? "up" : "down";
    detail = r.ok ? null : `HTTP ${r.status}`;
    if (r.ok) {
      const data = await r.json().catch(() => null);
      if (data && typeof data.source_status === "string") sourceStatus = data.source_status;
      if (data && typeof data.source_stall_seconds === "number") sourceStallSeconds = data.source_stall_seconds;
    }
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
  const prevSource = upstreamState.sourceStatus;
  upstreamState = { status, checkedAt: now, responseMs, sourceStatus, sourceStallSeconds };
  if (status === "up" && prevSource !== sourceStatus) {
    console.log(`[upstream-health] source_status=${sourceStatus} previous=${prevSource} stall_s=${sourceStallSeconds ?? "N/A"}`);
  }

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
  // Zera o contador de rate-limit público do IP chamador. Só staging/CI: deixa
  // os specs sensíveis a rate-limit (ratelimit.spec.js) hermeticos, sem que o
  // burst deles envenene os specs seguintes (viz-provenance rodava por último e
  // pegava 429 na viz de π). NUNCA habilitada em produção.
  app.post("/v1/_test/reset-rate-limit", attachRequestId, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress;
    try { publicIpRateLimiter.resetKey(ip); } catch { /* store sem resetKey */ }
    publicIpDailyUsage.delete(ip);
    res.json({ request_id: req.requestId, reset: true, ip });
  });
  // Prova (só CI) de que os cabeçalhos de identidade do cliente foram REMOVIDOS
  // antes de chegar às rotas — não apenas ignorados por elas.
  app.get("/v1/_test/identity-headers", attachRequestId, (req, res) => {
    res.json({ present: UNTRUSTED_IDENTITY_HEADERS.filter((h) => h in req.headers) });
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
    console.log(`Admin bootstrap  → ${ALLOW_ADMIN_EMAIL_BOOTSTRAP ? `LIGADO (${ADMIN_EMAIL || "sem e-mail"}) — só staging/CI` : "desligado (use scripts/set-role.js)"}`);
    console.log(`Upstream factor  → ${UPSTREAM_OVERPROVISION}x | recusa com fonte parada: ${REFUSE_WHEN_SOURCE_OFFLINE}`);
    if (!process.env.DB_PATH) console.warn("AVISO: DB_PATH não definido — usando banco local ao lado do código; num container isso é EFÊMERO.");
    const purge = purgeUsageLogs();
    console.log(`Retenção de logs → ${USAGE_LOG_RETENTION_DAYS} d (apagados agora: ${purge.deleted}; anonimizados: ${purge.anonymized})`);
    setInterval(() => { try { purgeUsageLogs(); } catch (e) { console.error("[purge]", e.message); } }, 24 * 60 * 60 * 1000).unref();
    // Auditoria: expurgo por AUDIT_RETENTION_DAYS na inicialização e a cada 24 h.
    try { console.log(`Auditoria        → retenção ${AUDIT_RETENTION_DAYS} d (expurgados agora: ${audit.purge()})`); } catch (e) { console.error("[audit-purge]", e.message); }
    setInterval(() => { try { audit.purge(); } catch (e) { console.error("[audit-purge]", e.message); } }, 24 * 60 * 60 * 1000).unref();
    console.log(`Identidade portal→ ${INTERNAL_SERVICE_TOKEN ? `introspecção em ${BONGO_INTERNAL_URL} (cache ${PORTAL_INTROSPECTION_CACHE_MS} ms)` : "DESLIGADA (INTERNAL_SERVICE_TOKEN ausente: sessão do portal → 503)"}`);
    console.log(`Max bytes/req    → ${MAX_BYTES_PER_REQUEST.toLocaleString()} bytes`);
    console.log(`Rate limit IP    → ${RATE_LIMIT_PER_IP_MIN} req/min`);
    console.log(`Rate limit token → ${RATE_LIMIT_PER_TOKEN_MIN} req/min`);
    console.log(`Daily quota req  → ${DAILY_QUOTA_REQUESTS.toLocaleString()} requests`);
    console.log(`Daily quota bytes→ ${DAILY_QUOTA_BYTES.toLocaleString()} bytes`);
    console.log(`Upstream timeout → ${QRNG_TIMEOUT_MS}ms`);
    console.log(`Upstream fail threshold → ${UPSTREAM_FAIL_THRESHOLD} consecutive failures`);
    checkUpstream();
    setInterval(checkUpstream, 60 * 1000);
    if (ENTROPY_POOL_BYTES > 0) {
      console.log(`Pool de amostra  → ${ENTROPY_POOL_BYTES.toLocaleString()} bytes, idade máx ${ENTROPY_POOL_MAX_AGE_MS} ms`);
      entropyPool.refill();
      setInterval(() => { entropyPool.refill().catch(() => {}); }, 30 * 1000).unref();
    }
  });
}

module.exports = {
  app, db, interpretUpstreamResponse, UpstreamFormatError, checkUpstream, purgeUsageLogs, truncateIp, entropyPool,
  audit, waitForBackgroundJobs,
  // Só testes: zera os limitadores das rotas de identidade/recuperação.
  resetIdentityRateLimits: () => Promise.all(identityRateStores.map((s) => s.resetAll())),
};
