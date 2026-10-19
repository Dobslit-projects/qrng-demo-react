// Orquestra o teste de rollback/roll-forward (ver run.sh). Saída: tabela
// PASS/FAIL sem segredos. Código de saída 1 se algo falhar.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const W = process.argv[2];
if (!W || !fs.existsSync(W)) {
  console.error("uso: node rollback-compat.mjs <diretório preparado pelo run.sh>");
  process.exit(2);
}
const Database = createRequire(path.join(W, "qrng-cand", "package.json"))("better-sqlite3");

const results = [];
function check(group, name, ok, detail = "") {
  results.push({ group, name, ok: Boolean(ok), detail: String(detail).slice(0, 160) });
}

const rand = (n = 12) => crypto.randomBytes(n).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(port, method, p, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* não é JSON */ }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: "", error: e.message };
  }
}

async function start(label, dir, port, env, healthPath) {
  const out = [];
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => out.push(String(d)));
  proc.stderr.on("data", (d) => out.push(String(d)));
  let exited = null;
  proc.on("exit", (c) => { exited = c; });
  for (let i = 0; i < 120; i++) {
    if (exited !== null) break;
    const r = await http(port, "GET", healthPath);
    if (r.status === 200) return { proc, out, label };
    await sleep(250);
  }
  proc.kill("SIGKILL");
  throw new Error(`${label} não subiu (saída: ${out.join("").slice(-600)})`);
}
async function stop(s) {
  if (s.proc.exitCode !== null) return;
  await new Promise((resolve) => {
    s.proc.once("exit", resolve);
    s.proc.kill("SIGTERM");
    setTimeout(() => s.proc.kill("SIGKILL"), 5000);
  });
}
const backups = (db) => fs.readdirSync(path.dirname(db)).filter((f) => f.startsWith(path.basename(db) + ".pre-migration-v"));

// ── client-api do QRNG ───────────────────────────────────────────────
async function qrng() {
  const G = "client-api";
  const db = path.join(W, "qrng.db");
  const port = 39110;
  const env = {
    DB_PATH: db,
    JWT_SECRET: `rollback-compat-${rand()}`,
    QRNG_UPSTREAM: "http://127.0.0.1:9",
    NODE_ENV: "production",
    RATE_LIMIT_PER_IP_PER_MINUTE: "100000",
    BIND_ADDR: "127.0.0.1",
  };
  const legacy = { email: `legado-${rand(4)}@rc.invalid`, password: `Senha${rand(6)}9` };
  let portalKey = null;

  // 0. produção cria o banco e recebe dados
  let s = await start("produção (0)", path.join(W, "qrng-prod"), port, env, "/v1/health/self");
  const reg = await http(port, "POST", "/v1/auth/register", { body: legacy });
  const jwt0 = reg.json?.token;
  const key = (await http(port, "POST", "/v1/tokens", { token: jwt0 })).json?.token;
  check(G, "produção: cadastro legado + chave de API", reg.status === 200 && jwt0 && key, reg.status);
  await stop(s);
  const before = new Database(db, { readonly: true });
  const snap = JSON.stringify(before.prepare("SELECT id, email, password_hash, role, created_at FROM users ORDER BY id").all());
  const tokensBefore = before.prepare("SELECT COUNT(*) AS n FROM api_tokens").get().n;
  before.close();

  // 1. candidata: migração v1 com cópia prévia
  s = await start("candidata (1)", path.join(W, "qrng-cand"), port, env, "/v1/health/self");
  check(G, "candidata: cópia prévia gravada antes da migração", backups(db).length === 1, backups(db).join(","));
  check(G, "candidata: login legado após a migração", (await http(port, "POST", "/v1/auth/login", { body: legacy })).status === 200);
  check(G, "candidata: JWT emitido pela produção continua valendo", (await http(port, "GET", "/v1/auth/me", { token: jwt0 })).status === 200);
  check(G, "candidata: chave de API anterior continua valendo", (await http(port, "GET", "/v1/me/usage", { token: key })).status === 200);
  const jwt1 = (await http(port, "POST", "/v1/auth/login", { body: legacy })).json?.token;
  await stop(s);
  {
    const d = new Database(db);
    const after = JSON.stringify(d.prepare("SELECT id, email, password_hash, role, created_at FROM users ORDER BY id").all());
    check(G, "migração preserva usuários (ids, e-mails, hashes, papéis, datas)", after === snap);
    check(G, "migração preserva chaves", d.prepare("SELECT COUNT(*) AS n FROM api_tokens").get().n === tokensBefore);
    // conta criada pelo portal (e-mail e senha locais nulos) com chave própria
    const now = new Date().toISOString();
    const uid = d.prepare(`INSERT INTO users (email, password_hash, role, created_at, bongo_user_id, auth_source, linked_at, portal_email)
                           VALUES (NULL, NULL, 'user', ?, ?, 'portal', ?, ?)`).run(now, crypto.randomUUID(), now, `portal-${rand(4)}@rc.invalid`).lastInsertRowid;
    const pkey = `dobslit_qrng_live_${rand(20)}`;
    d.prepare(`INSERT INTO api_tokens (user_id, token_prefix, token_hash, name, status, quota_daily, created_at)
               VALUES (?, ?, ?, 'portal', 'active', 10000, ?)`).run(uid, pkey.slice(0, 28), crypto.createHash("sha256").update(pkey).digest("hex"), now);
    d.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(legacy.email);
    d.close();
    portalKey = pkey; // só usado abaixo, nunca impresso
  }

  // 2. ROLLBACK: produção sobre o banco migrado
  s = await start("produção (2, rollback)", path.join(W, "qrng-prod"), port, env, "/v1/health/self");
  check(G, "rollback: produção sobe sobre o banco migrado", true);
  check(G, "rollback: login legado", (await http(port, "POST", "/v1/auth/login", { body: legacy })).status === 200);
  check(G, "rollback: JWT emitido pela candidata (iat_ms) aceito", (await http(port, "GET", "/v1/auth/me", { token: jwt1 })).status === 200);
  check(G, "rollback: chave de API legada", (await http(port, "GET", "/v1/me/usage", { token: key })).status === 200);
  const pk = await http(port, "GET", "/v1/me/usage", { token: portalKey });
  check(G, "rollback: chave de conta criada pelo portal continua valendo (produção não consulta o portal)", pk.status === 200, pk.status);
  const adminJwt = (await http(port, "POST", "/v1/auth/login", { body: legacy })).json?.token;
  const list = await http(port, "GET", "/v1/admin/users", { token: adminJwt });
  check(G, "rollback: lista de usuários do admin com conta de e-mail nulo", list.status === 200, list.status);
  const novo = { email: `novo-${rand(4)}@rc.invalid`, password: `Senha${rand(6)}9` };
  check(G, "rollback: cadastro novo", (await http(port, "POST", "/v1/auth/register", { body: novo })).status === 200);
  await stop(s);

  // 3. roll-forward: candidata de novo
  s = await start("candidata (3)", path.join(W, "qrng-cand"), port, env, "/v1/health/self");
  check(G, "roll-forward: nada a migrar (sem cópia nova)", backups(db).length === 1, backups(db).join(","));
  check(G, "roll-forward: conta criada durante o rollback entra", (await http(port, "POST", "/v1/auth/login", { body: novo })).status === 200);
  check(G, "roll-forward: chave legada", (await http(port, "GET", "/v1/me/usage", { token: key })).status === 200);
  await stop(s);
  const d = new Database(db, { readonly: true });
  check(G, "schema_migrations com a v1 uma única vez", d.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n === 1);
  d.close();
}

// ── Bongo (auth-api) ─────────────────────────────────────────────────
async function bongo() {
  const G = "Bongo";
  const db = path.join(W, "bongo.db");
  const port = 39120;
  const env = {
    DB_PATH: db,
    JWT_SECRET: `rollback-compat-${rand(16)}`,
    ADMIN_SEED_PASSWORD: `Admin${rand(6)}9`,
    NODE_ENV: "production",
    TRUST_PROXY: "0",
  };
  const admin = { email: "admin@dobslit.com", password: env.ADMIN_SEED_PASSWORD };
  const mk = () => ({ name: "Rollback", institution: "rc", email: `u-${rand(4)}@rc.invalid`, password: `Senha${rand(6)}9`, acceptBongoTerms: true });
  const u1 = mk();
  const u2 = mk();

  // 0. produção
  let s = await start("produção (0)", path.join(W, "bongo-prod"), port, env, "/api/health");
  for (const u of [u1, u2]) check(G, "produção: cadastro", (await http(port, "POST", "/api/auth/register", { body: u })).status === 201);
  await stop(s);

  // 1. candidata
  s = await start("candidata (1)", path.join(W, "bongo-cand"), port, env, "/api/health");
  check(G, "candidata: cópia prévia gravada antes da migração", backups(db).length === 1, backups(db).join(","));
  const l1 = await http(port, "POST", "/api/auth/login", { body: { email: u1.email, password: u1.password } });
  check(G, "candidata: login de conta criada na produção", l1.status === 200);
  const adm = (await http(port, "POST", "/api/auth/login", { body: admin })).json?.token;
  const users = (await http(port, "GET", "/api/admin/users", { token: adm })).json || [];
  const id2 = users.find((u) => u.email === u2.email)?.id;
  const dis = await http(port, "PUT", `/api/admin/users/${id2}`, { token: adm, body: { disabled: true } });
  check(G, "candidata: admin desabilita conta", dis.status === 200, dis.status);
  check(G, "candidata: conta desabilitada não entra", (await http(port, "POST", "/api/auth/login", { body: { email: u2.email, password: u2.password } })).status === 403);
  const tokTv = l1.json?.token;
  check(G, "candidata: status de recuperação (sem e-mail → indisponível)", (await http(port, "GET", "/api/auth/password-reset/status")).json?.selfService === false);
  await stop(s);

  // 2. ROLLBACK
  s = await start("produção (2, rollback)", path.join(W, "bongo-prod"), port, env, "/api/health");
  check(G, "rollback: produção sobe sobre o banco migrado", true);
  check(G, "rollback: login normal", (await http(port, "POST", "/api/auth/login", { body: { email: u1.email, password: u1.password } })).status === 200);
  check(G, "rollback: sessão emitida pela candidata (claim tv) aceita", (await http(port, "GET", "/api/auth/me", { token: tokTv })).status === 200);
  const l2 = await http(port, "POST", "/api/auth/login", { body: { email: u2.email, password: u2.password } });
  check(G, "rollback (RISCO DOCUMENTADO): conta desabilitada volta a entrar, o código anterior ignora disabled_at", l2.status === 200, l2.status);
  const u3 = mk();
  check(G, "rollback: cadastro novo", (await http(port, "POST", "/api/auth/register", { body: u3 })).status === 201);
  await stop(s);

  // 3. roll-forward
  s = await start("candidata (3)", path.join(W, "bongo-cand"), port, env, "/api/health");
  check(G, "roll-forward: nada a migrar (sem cópia nova)", backups(db).length === 1, backups(db).join(","));
  check(G, "roll-forward: conta desabilitada continua desabilitada", (await http(port, "POST", "/api/auth/login", { body: { email: u2.email, password: u2.password } })).status === 403);
  check(G, "roll-forward: conta criada durante o rollback entra", (await http(port, "POST", "/api/auth/login", { body: { email: u3.email, password: u3.password } })).status === 200);
  await stop(s);
}

try {
  await qrng();
  await bongo();
} catch (e) {
  check("execução", "erro inesperado", false, e.message);
}
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.group.padEnd(10)} ${r.name.padEnd(w)}  ${r.ok ? "" : r.detail}`);
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
