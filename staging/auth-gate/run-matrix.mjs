#!/usr/bin/env node
// Matriz de acesso do gate de autorização do QRNG (doc 155 §1.3) — PELO NGINX.
//
// Pré-requisito: `bash up.sh` (kapua-authgate no ar). Node 20+, sem dependências.
//
// Monta os usuários pelas APIs REAIS (login do admin semeado; cadastro; aprovação,
// concessão de serviço e desabilitação pela API de admin) e confere, sempre
// através do nginx com a config de produção corrigida:
//   - /qrng/ (página), /qrng/api{,-fpga}/stream, /qrng/nist/health, /qrng/nist/nist/run
//     para: sem sessão, cookie vazio, lixo, assinatura falsa, expirado, pending,
//     sem o serviço qrng, com qrng, admin, desabilitado;
//   - /edu/ inalterado (só sessão); endpoints públicos inalterados;
//   - chave de API de conta legada; cabeçalhos de identidade forjados sem efeito;
//   - /api/internal/* e /qrng/v1/internal/v1/* → 404 do nginx mesmo com o token interno;
//   - fluxo de identidade (status, provision, link com reauth), recuperação de
//     senha (estado na fila de e-mail pela API de admin — só estado);
//   - páginas de destino dos links de redefinição (portal e legado) abrem pelo
//     nginx SEM sessão e sem o serviço qrng (fora do gate; um 302 perderia o #token=);
//   - Bongo parado → página 503, APIs 503 JSON, nenhum acesso; recuperação.
//   - logs dos containers e trilhas de auditoria sem segredos.
//
// NUNCA imprime senhas, JWTs, tokens de reauth/recuperação, chaves de API nem
// links: a tabela mostra só status HTTP, tipo de conteúdo e códigos de erro.
//
// Variáveis:
//   AUTHGATE_PORT    porta do nginx (padrão 18180, ou a do .env)
//   AUTHGATE_DOCKER  prefixo do docker CLI (padrão "docker"; no Windows com
//                    Docker dentro do WSL: "wsl -d Ubuntu -- docker")
// Opções: --skip-bongo-down  (não para o bongosite-auth)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = readEnvFile(path.join(HERE, ".env"));
const PORT = Number(process.env.AUTHGATE_PORT || ENV.AUTHGATE_PORT || 18180);
const DOCKER = (process.env.AUTHGATE_DOCKER || "docker").split(/\s+/).filter(Boolean);
const C_BONGO = "kapua-authgate-bongosite-auth";
const C_CLIENT = "kapua-authgate-qrng-client-api";
const C_NGINX = "kapua-authgate-nginx";
const SKIP_DOWN = process.argv.includes("--skip-bongo-down");
const RUN = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;

const EDGE_404_MSG = "Rota nao exposta.";
const FORBIDDEN_MSG = "Sua conta não tem acesso ao serviço QRNG.";

// ── segredos e e-mails desta execução (nunca impressos; procurados nos logs) ──
const SECRETS = new Set();
const EMAILS = new Set();
const secret = (v) => { if (v && String(v).length >= 6) SECRETS.add(String(v)); return v; };
for (const k of Object.keys(ENV)) if (k.startsWith("AUTHGATE_") && k !== "AUTHGATE_PORT") secret(ENV[k]);
const redact = (s) => { let o = String(s); for (const x of SECRETS) o = o.split(x).join("[redigido]"); return o; };

function readEnvFile(p) {
  const out = {};
  let txt;
  try { txt = fs.readFileSync(p, "utf8"); } catch { return out; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ── HTTP (node:http: sem seguir redirecionamentos, sem cookies automáticos) ──
function request(method, urlPath, { headers = {}, body, stream = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = { Connection: "close", ...headers };
    if (data) { h["Content-Type"] = h["Content-Type"] || "application/json"; h["Content-Length"] = data.length; }
    const t0 = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ms: Date.now() - t0, ...r }); } };
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      const end = () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch { /* não é JSON */ }
        finish({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), json, bytes: size });
      };
      res.on("data", (c) => {
        chunks.push(c);
        size += c.length;
        if (stream && size >= 64) { end(); req.destroy(); }
      });
      res.on("end", end);
      res.on("error", () => end());
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => finish({ status: 0, headers: {}, text: "", json: null, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}
const evType = (e) => e.event_type ?? e.eventType;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = (jwt) => (jwt === null ? {} : { Cookie: `bongo_session=${jwt}` });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const portal = (t) => ({ "X-Portal-Session": t });

// stream: limit_conn kuapoa_stream_ip 1 — a conexão anterior pode ainda estar
// contando; 429 aqui é o limitador, não o gate: tenta de novo.
async function streamReq(p, headers) {
  for (let i = 0; i < 6; i++) {
    const r = await request("GET", p, { headers, stream: true });
    if (r.status !== 429) return r;
    await sleep(600);
  }
  return request("GET", p, { headers, stream: true });
}

// Variável de ambiente de um contêiner ("" se ausente; null se não deu para ler). Nunca imprime o valor.
function envOf0(c, name) {
  const r = docker(["exec", "-i", c, "node", "-"], `console.log("ENV=" + JSON.stringify(process.env[${JSON.stringify(name)}] || ""))`);
  const m = r.out.match(/^ENV=(".*")$/m);
  return r.code === 0 && m ? JSON.parse(m[1]) : null;
}

// ── docker (parar/iniciar o Bongo, controle positivo na rede privada, logs) ──
function docker(args, input) {
  const r = spawnSync(DOCKER[0], [...DOCKER.slice(1), ...args], { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, err: r.error };
}

// ── resultados ──
const results = [];
function check(group, name, ok, expected, got) {
  results.push({ group, name, ok: Boolean(ok), expected, got: redact(got) });
}
const ctype = (r) => String(r.headers?.["content-type"] || "-").split(";")[0];
const code = (r) => (r.json && (r.json.code || r.json.error)) || "";
const show = (r) => (r.error ? `ERRO ${r.error}` : `${r.status} ${ctype(r)}${code(r) ? " " + code(r) : ""}${r.headers?.location ? " → " + r.headers.location : ""}`);

// O nginx emite `return 302 /x` como Location absoluto (absolute_redirect on, Host
// da requisição; no teste sem a porta publicada). Compara-se o caminho e exige-se
// que o destino seja do próprio host — nunca um redirecionamento para fora.
function samePathRedirect(loc) {
  if (!loc) return null;
  const u = new URL(loc, "http://127.0.0.1/");
  return u.hostname === "127.0.0.1" ? u.pathname + u.search : `EXTERNO ${u.host}`;
}
function expectRedirect(group, name, r, ...locations) {
  check(group, name, r.status === 302 && locations.includes(samePathRedirect(r.headers.location)), `302 → ${locations.join(" | ")}`, show(r));
}
function expectJson(group, name, r, status, error) {
  const ok = r.status === status && ctype(r) === "application/json" && !r.headers.location && r.json !== null &&
    (error === undefined || code(r) === error);
  check(group, name, ok, `${status} application/json${error ? " " + error : ""}`, show(r));
}
// Conta desabilitada = 403 (doc 155 §1.1: "conta desabilitada" está no 403 do
// authorize; o Bongo responde 403 ACCOUNT_DISABLED de forma determinística).
function expectDenied(group, name, r, cls) {
  if (cls === "unauth") return expectJson(group, name, r, 401, "UNAUTHORIZED");
  if (cls === "forbidden" || cls === "disabled") return expectJson(group, name, r, 403, "FORBIDDEN");
  check(group, name, false, "classe conhecida", `classe inesperada: ${cls}`);
}
function expectHtmlStub(group, name, r, marker) {
  const ok = r.status === 200 && ctype(r) === "text/html" && r.text.includes(`data-stub="${marker}"`);
  check(group, name, ok, `200 text/html (${marker})`, show(r));
}

// ── JWT HS256 (só para forjar os casos "assinatura falsa" e "expirado") ──
function signJwt(payload, key) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  return `${head}.${crypto.createHmac("sha256", key).update(head).digest("base64url")}`;
}

// ── preparação pelas APIs reais ──
const newPassword = () => secret(`Tg${crypto.randomBytes(9).toString("base64url")}7a`);
const email = (tag) => { const e = `${tag}-${RUN}@authgate.invalid`; EMAILS.add(e); return e; };

async function bongoLogin(mail, password) {
  const r = await request("POST", "/api/auth/login", { body: { email: mail, password } });
  if (r.json?.token) secret(r.json.token);
  return r;
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    const r = await request("GET", "/api/health");
    if (r.status === 200) return true;
    await sleep(1000);
  }
  return false;
}

function listOf(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const k of ["items", "messages", "outbox", "events", "rows", "data", "results"]) if (Array.isArray(body[k])) return body[k];
  }
  return [];
}

async function main() {
  if (!ENV.AUTHGATE_ADMIN_SEED_PASSWORD) {
    console.error(".env não encontrado ou incompleto — rode `bash up.sh` antes.");
    process.exit(2);
  }
  if (!(await waitHealthy())) {
    console.error(`nginx/Bongo não respondem em http://127.0.0.1:${PORT}/api/health — o ambiente está no ar?`);
    process.exit(2);
  }
  const G0 = "preparo";

  // admin semeado
  const adm = await bongoLogin("admin@dobslit.com", ENV.AUTHGATE_ADMIN_SEED_PASSWORD);
  check(G0, "login do admin semeado", adm.status === 200 && adm.json?.token, "200 + token", show(adm));
  if (!adm.json?.token) return;
  const adminJwt = adm.json.token;
  const A = bearer(adminJwt);

  // usuários do portal
  const plan = {
    pending: { services: null },
    noqrng: { role: "user", services: ["quantum-edu"] },
    qrng: { role: "user", services: ["qrng"] },
    disabled: { role: "user", services: ["qrng"] },
    linker: { role: "user", services: ["qrng"] },
  };
  const U = {};
  for (const [tag, p] of Object.entries(plan)) {
    U[tag] = { email: email(tag), password: newPassword(), ...p };
    const r = await request("POST", "/api/auth/register", {
      body: {
        name: `Teste ${tag}`, institution: "authgate", email: U[tag].email, password: U[tag].password,
        requestedServices: ["qrng"], acceptBongoTerms: true, acceptQrngTerms: true,
      },
    });
    check(G0, `cadastro ${tag}`, r.status === 201, "201", show(r));
  }
  const list = await request("GET", "/api/admin/users", { headers: A });
  const users = listOf(list.json);
  for (const u of Object.values(U)) u.id = users.find((x) => x.email === u.email)?.id;
  check(G0, "admin lista usuários", list.status === 200 && Object.values(U).every((u) => u.id), "200 + ids", show(list));
  for (const [tag, u] of Object.entries(U)) {
    if (!u.role) continue;
    const r = await request("PUT", `/api/admin/users/${u.id}`, { headers: A, body: { role: u.role, services: u.services } });
    check(G0, `admin aprova ${tag} (${u.services.join(",")})`, r.status === 200, "200", show(r));
  }
  for (const [tag, u] of Object.entries(U)) {
    const r = await bongoLogin(u.email, u.password);
    u.jwt = r.json?.token;
    check(G0, `login ${tag}`, r.status === 200 && u.jwt, "200 + token", show(r));
  }
  const dis = await request("PUT", `/api/admin/users/${U.disabled.id}`, { headers: A, body: { disabled: true, disabledReason: "teste do gate" } });
  check(G0, "admin desabilita conta", dis.status === 200, "200", show(dis));
  const disLogin = await bongoLogin(U.disabled.email, U.disabled.password);
  check(G0, "login de conta desabilitada (senha certa)", disLogin.status === 403 && code(disLogin) === "ACCOUNT_DISABLED", "403 ACCOUNT_DISABLED", show(disLogin));
  const wrong = await bongoLogin(U.qrng.email, "SenhaErrada12345");
  check(G0, "login com senha errada (gera evento de falha)", wrong.status === 401, "401", show(wrong));

  const now = Math.floor(Date.now() / 1000);
  const forged = signJwt({ id: U.qrng.id, email: U.qrng.email, role: "user", iat: now }, crypto.randomBytes(32));
  const expired = signJwt({ id: U.qrng.id, email: U.qrng.email, role: "user", iat: now - 8 * 86400, exp: now - 86400 }, ENV.AUTHGATE_BONGO_JWT_SECRET);
  secret(forged); secret(expired);

  // identidade → (cookie, classe esperada)
  const IDS = {
    "sem sessão": [null, "unauth"],
    "cookie vazio": ["", "unauth"],
    "cookie lixo": ["1", "unauth"],
    "assinatura falsa": [forged, "unauth"],
    "expirado": [expired, "unauth"],
    "desabilitado": [U.disabled.jwt, "disabled"],  // §1.1: 403 no authorize (QRNG); §1.2: 401 no requireAuth (/edu/)
    "pending": [U.pending.jwt, "forbidden"],
    "sem qrng": [U.noqrng.jwt, "forbidden"],
    "com qrng": [U.qrng.jwt, "allowed"],
    "admin": [adminJwt, "allowed"],
  };

  // ── matriz pelo nginx ──
  for (const [label, [jwt, cls]] of Object.entries(IDS)) {
    const G = `matriz: ${label}`;
    const H = cookie(jwt);
    for (const p of ["/qrng/", "/qrng/assets/index-stub.js"]) {
      const r = await request("GET", p, { headers: H });
      if (cls === "unauth") expectRedirect(G, `GET ${p}`, r, `/?redirect=${p}`);
      else if (cls === "forbidden" || cls === "disabled") expectRedirect(G, `GET ${p}`, r, "/cards?acesso=qrng");
      else expectHtmlStub(G, `GET ${p}`, r, "qrng-spa-stub");
    }
    for (const p of ["/qrng/api/stream", "/qrng/api-fpga/stream"]) {
      const r = await streamReq(p, H);
      if (cls === "allowed") {
        check(G, `GET ${p}`, r.status === 200 && r.bytes >= 64 && !["text/html", "application/json"].includes(ctype(r)), "200 bytes do broker", show(r));
      } else expectDenied(G, `GET ${p}`, r, cls);
      if (cls === "forbidden" || cls === "disabled") check(G, `GET ${p} mensagem`, r.json?.message === FORBIDDEN_MSG, FORBIDDEN_MSG, r.json?.message || "-");
      await sleep(150);
    }
    const nh = await request("GET", "/qrng/nist/health", { headers: H });
    const nr = await request("POST", "/qrng/nist/nist/run", { headers: H, body: { sample: "stub" } });
    for (const [n, r] of [["GET /qrng/nist/health", nh], ["POST /qrng/nist/nist/run", nr]]) {
      if (cls === "allowed") check(G, n, r.status === 200 && ctype(r) === "application/json" && r.json?.stub === "nist-stub", "200 JSON do NIST", show(r));
      else expectDenied(G, n, r, cls);
    }
    const edu = await request("GET", "/edu/", { headers: H });
    if (cls === "unauth" || cls === "disabled") expectRedirect(G, "GET /edu/ (inalterado: só sessão)", edu, "/?redirect=/edu/");
    else expectHtmlStub(G, "GET /edu/ (inalterado: só sessão)", edu, "quantum-edu-stub");
  }

  // limit_req continua ANTES do gate e responde 429 JSON (zona relaxada no teste)
  {
    const burst = await Promise.all(Array.from({ length: 25 }, () => request("POST", "/qrng/nist/nist/run", { body: {} })));
    const r429 = burst.find((r) => r.status === 429);
    check("limites", "rajada em /qrng/nist/nist/run → algum 429 JSON", r429 && ctype(r429) === "application/json" && code(r429) === "RATE_LIMIT_EXCEEDED",
      "429 application/json RATE_LIMIT_EXCEEDED", r429 ? show(r429) : `sem 429 (${[...new Set(burst.map((r) => r.status))].join(",")})`);
    await sleep(1500);
  }

  // ── públicos inalterados ──
  const GP = "públicos (sem sessão)";
  for (const p of ["/qrng/api/random?bytes=16", "/qrng/api-fpga/random?bytes=16"]) {
    const r = await request("GET", p);
    check(GP, `GET ${p}`, r.status === 200, "200", show(r));
  }
  for (const p of ["/qrng/api/health", "/qrng/api-fpga/health", "/qrng/v1/public/health"]) {
    const r = await request("GET", p);
    check(GP, `GET ${p}`, [200, 503].includes(r.status) && ctype(r) === "application/json", "200|503 application/json", show(r));
  }
  {
    const r = await request("GET", "/qrng/v1/openapi.json");
    check(GP, "GET /qrng/v1/openapi.json", r.status === 200 && r.json?.openapi, "200 OpenAPI", show(r));
    const raw = await request("GET", "/qrng/api/v1/raw?bytes=16");
    expectJson(GP, "GET /qrng/api/v1/raw (catch-all inalterado)", raw, 404, "NOT_FOUND");
    expectHtmlStub(GP, "GET / (front do portal)", await request("GET", "/"), "bongo-front-stub");
    expectHtmlStub(GP, "GET /cards?acesso=qrng (destino do 403)", await request("GET", "/cards?acesso=qrng"), "bongo-front-stub");
    const df = await request("GET", "/dobflight/");
    check(GP, "GET /dobflight/ (inalterado)", df.status === 200 && df.text.startsWith("misc-app-stub"), "200 stub", show(df));
  }

  // ── rotas internas: 404 DO NGINX mesmo com o token interno verdadeiro ──
  const GI = "bordas internas";
  const IT = bearer(ENV.AUTHGATE_INTERNAL_SERVICE_TOKEN);
  const edge404 = (name, r) => {
    const ok = r.status === 404 && ctype(r) === "application/json" && r.json?.message === EDGE_404_MSG;
    check(GI, name, ok, `404 do nginx (“${EDGE_404_MSG}”)`, show(r));
  };
  edge404("POST /api/internal/v1/introspect + token interno", await request("POST", "/api/internal/v1/introspect", { headers: IT, body: { token: U.qrng.jwt } }));
  edge404("POST /api/internal/v1/mail + token interno", await request("POST", "/api/internal/v1/mail", { headers: IT, body: {} }));
  edge404("POST /api/internal/v1/mail/cancel + token interno", await request("POST", "/api/internal/v1/mail/cancel", { headers: IT, body: {} }));
  edge404("POST /api/INTERNAL/v1/introspect (caixa)", await request("POST", "/api/INTERNAL/v1/introspect", { headers: IT, body: { token: U.qrng.jwt } }));
  edge404("POST /api/%69nternal/v1/introspect (codificado)", await request("POST", "/api/%69nternal/v1/introspect", { headers: IT, body: { token: U.qrng.jwt } }));
  edge404("GET /qrng/v1/internal/v1/password-reset/1/status + token", await request("GET", "/qrng/v1/internal/v1/password-reset/1/status", { headers: IT }));
  edge404("GET /qrng/v1/Internal/V1/password-reset/1/status (caixa)", await request("GET", "/qrng/v1/Internal/V1/password-reset/1/status", { headers: IT }));
  edge404("GET /qrng/v1/internal/v1 (sem barra)", await request("GET", "/qrng/v1/internal/v1", { headers: IT }));
  {
    const d = await request("GET", "/qrng/v1/internal/admin-openapi.json");
    check(GI, "GET /qrng/v1/internal/admin-openapi.json continua na client-api", d.status === 401, "401 (autenticação da client-api)", show(d));
    const d2 = await request("GET", "/qrng/v1/internal/docs/");
    check(GI, "GET /qrng/v1/internal/docs/ continua na client-api", d2.status === 401, "401 (autenticação da client-api)", show(d2));
  }
  // controle positivo: na rede privada as rotas existem e respondem
  {
    const js = (url, opts) => `fetch(${JSON.stringify(url)},{...${opts},headers:{"content-type":"application/json",authorization:"Bearer "+process.env.INTERNAL_SERVICE_TOKEN}}).then(r=>console.log("STATUS",r.status)).catch(e=>console.log("STATUS ERR",e.code||e.message))`;
    const a = docker(["exec", "-i", C_CLIENT, "node", "-"], js("http://bongosite-auth:3002/api/internal/v1/introspect", `{method:"POST",body:JSON.stringify({token:"nao-e-um-jwt"})}`));
    check(GI, "controle: client-api → Bongo /api/internal/v1/introspect (rede privada)", /STATUS 200/.test(a.out), "200", (a.out.match(/STATUS \S+/) || [a.err?.message || "sem saída"])[0]);
    const b = docker(["exec", "-i", C_BONGO, "node", "-"], js("http://qrng-client-api:3010/v1/internal/v1/password-reset/999999/status", "{}"));
    check(GI, "controle: Bongo → client-api /v1/internal/v1/... (rede privada)", /STATUS 200/.test(b.out), "200", (b.out.match(/STATUS \S+/) || [b.err?.message || "sem saída"])[0]);
    const c = docker(["exec", "-i", C_CLIENT, "node", "-"], js("http://bongosite-auth:3002/api/internal/v1/mail/cancel", `{method:"POST",body:JSON.stringify({validity:{kind:"qrng_legacy_password_reset",refs:["999999"]}})}`));
    check(GI, "controle: client-api → Bongo /api/internal/v1/mail/cancel (rede privada)", /STATUS 200/.test(c.out), "200", (c.out.match(/STATUS \S+/) || [c.err?.message || "sem saída"])[0]);
    const cb = envOf0(C_BONGO, "QRNG_CLIENT_API_INTERNAL_URL");
    check(GI, "Bongo sem QRNG_CLIENT_API_INTERNAL_URL (como produção: sem consulta de volta)", cb === "", "vazio", cb === null ? "erro ao ler" : (cb ? "definido" : "vazio"));
  }

  // ── conta legada + chave de API ──
  const GL = "conta legada";
  const L = { email: email("legado"), password: newPassword() };
  const reg = await request("POST", "/qrng/v1/auth/register", { body: { email: L.email, password: L.password } });
  L.jwt = secret(reg.json?.token);
  check(GL, "cadastro legado na client-api", [200, 201].includes(reg.status) && L.jwt, "200|201 + token", show(reg));
  const me = await request("GET", "/qrng/v1/auth/me", { headers: bearer(L.jwt) });
  L.id = me.json?.id;
  const tok = await request("POST", "/qrng/v1/tokens", { headers: bearer(L.jwt), body: { name: "authgate" } });
  L.key = secret(tok.json?.token);
  check(GL, "emite chave de API (JWT legado)", [200, 201].includes(tok.status) && L.key, "200|201 + chave", show(tok));
  const rnd = await request("GET", "/qrng/v1/random?bytes=16", { headers: bearer(L.key) });
  check(GL, "GET /qrng/v1/random com chave de API (sem sessão do portal)", rnd.status === 200, "200", show(rnd));

  // ── cabeçalhos de identidade forjados: sem efeito ──
  const GF = "identidade forjada";
  const FAKE = { "X-Bongo-User-Id": U.qrng.id, "X-Bongo-Role": "admin", "X-Portal-User": U.qrng.email };
  expectJson(GF, "GET /qrng/v1/identity/status só com X-Bongo-*/X-Portal-User", await request("GET", "/qrng/v1/identity/status", { headers: FAKE }), 401);
  expectJson(GF, "GET /qrng/v1/me/token só com cabeçalhos forjados", await request("GET", "/qrng/v1/me/token", { headers: FAKE }), 401);
  expectJson(GF, "GET /qrng/v1/admin/users só com X-Bongo-Role: admin", await request("GET", "/qrng/v1/admin/users", { headers: FAKE }), 401);
  {
    const r = await request("GET", "/qrng/v1/auth/me", { headers: { ...bearer(L.jwt), ...FAKE } });
    check(GF, "JWT legado + cabeçalhos forjados → continua o legado", r.status === 200 && r.json?.id === L.id, "200 id do legado", show(r));
    expectJson(GF, "JWT legado (user) + X-Bongo-Role: admin → /v1/admin/users", await request("GET", "/qrng/v1/admin/users", { headers: { ...bearer(L.jwt), ...FAKE } }), 403);
    expectJson(GF, "sessão pending + X-Bongo-Role: admin → identity/status", await request("GET", "/qrng/v1/identity/status", { headers: { ...portal(U.pending.jwt), ...FAKE } }), 403, "QRNG_ACCESS_DENIED");
  }

  // ── identidade integrada (X-Portal-Session) ──
  const GD = "identidade do portal";
  {
    const st = await request("GET", "/qrng/v1/identity/status", { headers: portal(U.qrng.jwt) });
    check(GD, "status (com qrng, sem conta)", st.status === 200 && st.json?.developer_account === null && st.json?.can_provision === true && st.json?.portal?.id === U.qrng.id,
      "200 developer_account=null can_provision", show(st));
    expectJson(GD, "status (pending)", await request("GET", "/qrng/v1/identity/status", { headers: portal(U.pending.jwt) }), 403, "QRNG_ACCESS_DENIED");
    expectJson(GD, "status (sem qrng)", await request("GET", "/qrng/v1/identity/status", { headers: portal(U.noqrng.jwt) }), 403, "QRNG_ACCESS_DENIED");
    expectJson(GD, "status (desabilitado)", await request("GET", "/qrng/v1/identity/status", { headers: portal(U.disabled.jwt) }), 401, "PORTAL_SESSION_INVALID");
    expectJson(GD, "status (expirado)", await request("GET", "/qrng/v1/identity/status", { headers: portal(expired) }), 401, "PORTAL_SESSION_INVALID");
    expectJson(GD, "status (lixo)", await request("GET", "/qrng/v1/identity/status", { headers: portal("1") }), 401, "PORTAL_SESSION_INVALID");
    const adm2 = await request("GET", "/qrng/v1/identity/status", { headers: portal(adminJwt) });
    check(GD, "status (admin do portal)", adm2.status === 200, "200", show(adm2));
    expectJson(GD, "X-Portal-Session + JWT legado de outro usuário", await request("GET", "/qrng/v1/me/token", { headers: { ...portal(U.qrng.jwt), ...bearer(L.jwt) } }), 400, "AMBIGUOUS_CREDENTIALS");
    expectJson(GD, "me/token antes de provisionar", await request("GET", "/qrng/v1/me/token", { headers: portal(U.qrng.jwt) }), 404, "DEVELOPER_ACCOUNT_NOT_PROVISIONED");

    const pv = await request("POST", "/qrng/v1/identity/provision", { headers: portal(U.qrng.jwt) });
    check(GD, "provision", pv.status === 201 && pv.json?.developer_account?.auth_source === "portal", "201 auth_source=portal", show(pv));
    expectJson(GD, "provision de novo", await request("POST", "/qrng/v1/identity/provision", { headers: portal(U.qrng.jwt) }), 409, "PORTAL_ALREADY_LINKED");
    const pt = await request("POST", "/qrng/v1/tokens", { headers: portal(U.qrng.jwt), body: { name: "portal" } });
    const pkey = secret(pt.json?.token);
    check(GD, "emite chave com a sessão do portal", [200, 201].includes(pt.status) && pkey, "200|201 + chave", show(pt));
    const pr = await request("GET", "/qrng/v1/random?bytes=16", { headers: bearer(pkey) });
    check(GD, "chave da conta do portal funciona", pr.status === 200, "200", show(pr));
  }

  // vínculo com conta legada (reauth de uso único + credenciais legadas)
  const GK = "vínculo legado";
  const reauth = async () => {
    const r = await request("POST", "/api/auth/reauth", { headers: bearer(U.linker.jwt), body: { currentPassword: U.linker.password, purpose: "link_qrng_developer" } });
    return { r, t: secret(r.json?.reauthToken) };
  };
  {
    const bad = await request("POST", "/api/auth/reauth", { headers: bearer(U.linker.jwt), body: { currentPassword: "SenhaErrada12345", purpose: "link_qrng_developer" } });
    check(GK, "reauth com senha errada", bad.status === 403 || bad.status === 401, "401|403", show(bad));
    const a = await reauth();
    check(GK, "reauth (senha do portal)", a.r.status === 200 && a.t, "200 + reauthToken", show(a.r));
    const noRe = await request("POST", "/qrng/v1/identity/link", { headers: portal(U.linker.jwt), body: { reauthToken: "invalido-" + RUN, legacyEmail: L.email, legacyPassword: L.password } });
    expectJson(GK, "link com reauth inválido", noRe, 403, "REAUTH_REQUIRED");
    const b = await reauth();
    const wrongPw = await request("POST", "/qrng/v1/identity/link", { headers: portal(U.linker.jwt), body: { reauthToken: b.t, legacyEmail: L.email, legacyPassword: "SenhaErrada12345" } });
    expectJson(GK, "link com senha legada errada", wrongPw, 403, "INVALID_LEGACY_CREDENTIALS");
    const c = await reauth();
    const linkedBefore = new Set(listOf((await request("GET", "/api/admin/mail/outbox", { headers: A })).json).map((m) => m.id));
    const ok = await request("POST", "/qrng/v1/identity/link", { headers: portal(U.linker.jwt), body: { reauthToken: c.t, legacyEmail: L.email, legacyPassword: L.password } });
    check(GK, "link (reauth + credenciais legadas)", ok.status === 200, "200", show(ok));
    {
      let notice = null;
      for (let i = 0; i < 30; i++) {
        const items = listOf((await request("GET", "/api/admin/mail/outbox", { headers: A })).json);
        notice = items.find((m) => !linkedBefore.has(m.id) && m.template === "qrng_legacy_account_linked") || null;
        if (notice && !["pending", "sending"].includes(notice.status)) break;
        await sleep(1000);
      }
      check(GK, "aviso de vínculo ao e-mail da conta antiga aceito pelo transporte simulado",
        notice?.status === "accepted" || notice?.status === "delivered", "accepted", notice ? `status=${notice.status}` : "não enfileirado");
    }
    const again = await request("POST", "/qrng/v1/identity/link", { headers: portal(U.linker.jwt), body: { reauthToken: c.t, legacyEmail: L.email, legacyPassword: L.password } });
    check(GK, "reuso do mesmo reauthToken não vincula de novo", [403, 409].includes(again.status), "403|409", show(again));
    const st = await request("GET", "/qrng/v1/identity/status", { headers: portal(U.linker.jwt) });
    const dev = st.json?.developer_account;
    check(GK, "status após vínculo = mesma conta legada", st.status === 200 && dev?.id === L.id && dev?.auth_source === "legacy" && dev?.linked_at && dev?.has_token === true,
      "200 id legado, auth_source=legacy, has_token", show(st));
    const keyStill = await request("GET", "/qrng/v1/random?bytes=16", { headers: bearer(L.key) });
    check(GK, "chave legada continua válida após vínculo", keyStill.status === 200, "200", show(keyStill));
    const legacyLogin = await request("POST", "/qrng/v1/auth/login", { body: { email: L.email, password: L.password } });
    secret(legacyLogin.json?.token);
    check(GK, "login legado continua funcionando", legacyLogin.status === 200, "200", show(legacyLogin));
    const other = await request("POST", "/qrng/v1/identity/link", { headers: portal(U.qrng.jwt), body: { reauthToken: "x-" + RUN, legacyEmail: L.email, legacyPassword: L.password } });
    check(GK, "outro portal tentando a mesma conta legada", [403, 409].includes(other.status), "403|409", show(other));
  }

  // ── recuperação de senha → fila de e-mail (só ESTADO, pela API de admin) ──
  const GM = "e-mail (simulado)";
  const outboxIds = async () => {
    const r = await request("GET", "/api/admin/mail/outbox", { headers: A });
    return { r, items: listOf(r.json) };
  };
  const before = await outboxIds();
  check(GM, "GET /api/admin/mail/outbox", before.r.status === 200, "200", show(before.r));
  const seen = new Set(before.items.map((m) => m.id));
  {
    const f1 = await request("POST", "/api/auth/forgot-password", { body: { email: U.qrng.email } });
    const f2 = await request("POST", "/api/auth/forgot-password", { body: { email: email("inexistente") } });
    check(GM, "forgot-password (conta existente)", f1.status === 200, "200", show(f1));
    check(GM, "forgot-password: mesma resposta para e-mail inexistente", f2.status === 200 && f1.text === f2.text, "200 corpo idêntico", show(f2));
    const lr = await request("POST", "/qrng/v1/auth/password-reset/request", { body: { email: L.email } });
    check(GM, "password-reset/request legado", lr.status === 202, "202", show(lr));
    const lr2 = await request("POST", "/qrng/v1/auth/password-reset/request", { body: { email: email("inexistente-legado") } });
    check(GM, "password-reset/request: mesma resposta p/ inexistente", lr2.status === 202 && JSON.stringify({ ...lr.json, request_id: 0 }) === JSON.stringify({ ...lr2.json, request_id: 0 }), "202 corpo idêntico", show(lr2));
    const chk = await request("POST", "/qrng/v1/auth/password-reset/check", { body: { token: crypto.randomBytes(32).toString("base64url") } });
    check(GM, "password-reset/check com token aleatório", chk.status === 200 && chk.json?.valid === false, "200 valid=false", show(chk));

    const want = { password_reset: null, qrng_legacy_password_reset: null };
    let last = before;
    for (let i = 0; i < 30; i++) {
      last = await outboxIds();
      for (const m of last.items) if (!seen.has(m.id) && m.template in want) want[m.template] = m;
      const fin = Object.values(want).every((m) => m && !["pending", "sending"].includes(m.status));
      if (fin) break;
      await sleep(1000);
    }
    for (const [tpl, m] of Object.entries(want)) {
      check(GM, `fila: ${tpl} aceito pelo transporte simulado`, m?.status === "accepted" || m?.status === "delivered", "accepted", m ? `status=${m.status}` : "não enfileirado");
    }
    const txt = JSON.stringify(last.r.json || {});
    const leaks = /#token=|redefinir-senha#|secret_ciphertext"\s*:\s*"/.test(txt) || [...SECRETS].some((s) => txt.includes(s)) || [...EMAILS].some((e) => txt.includes(e));
    check(GM, "listagem da fila sem link/token/e-mail completo", !leaks, "mascarada", leaks ? "VAZAMENTO" : "mascarada");
  }

  // ── páginas públicas de redefinição (destino dos links dos e-mails) ──
  // Links: legado = `${QRNG_PASSWORD_RESET_URL}#token=…` (client-api; fallback do
  // Bongo: PUBLIC_BASE_URL + QRNG_LEGACY_RESET_PATH) e portal =
  // `${PUBLIC_BASE_URL}/redefinir-senha#token=…`. O fragmento não chega ao servidor;
  // o que precisa valer é que o CAMINHO abre o front do portal (200, sem
  // redirecionamento) para quem não tem sessão, não tem qrng ou está desabilitado —
  // um 302 para login/cards descartaria o #token= e a redefinição não terminaria.
  // A configuração é lida dos containers (o link em si nunca sai da fila).
  const GR = "redefinição (páginas públicas)";
  const GATED_PROBE_PATH = "/qrng/redefinir-senha"; // caminho sob o gate (controle negativo)
  const RESET_DEFAULT_PATH = "/redefinir-senha-api";  // padrão de server.js / config.js
  const resetPaths = [];
  {
    const envOf = (c, name) => {
      const r = docker(["exec", "-i", c, "node", "-"], `console.log("ENV=" + JSON.stringify(process.env[${JSON.stringify(name)}] || ""))`);
      const m = r.out.match(/^ENV=(".*")$/m);
      return r.code === 0 && m ? JSON.parse(m[1]) : null;
    };
    const base = `http://127.0.0.1:${PORT}`;
    const gated = (p) => /^\/qrng(\/|$)/i.test(p);
    const legacyUrl = envOf(C_CLIENT, "QRNG_PASSWORD_RESET_URL");
    let legacyPath = null;
    try {
      const u = new URL(legacyUrl);
      if (u.origin === base && !u.search && !u.hash) legacyPath = u.pathname;
    } catch { /* ausente ou inválida */ }
    check(GR, "client-api QRNG_PASSWORD_RESET_URL: borda deste ambiente, fora de /qrng/", legacyPath !== null && !gated(legacyPath),
      `${base}/… fora de /qrng/`, legacyUrl ? legacyUrl : `não definido (padrão ${RESET_DEFAULT_PATH})`);
    const fallback = envOf(C_BONGO, "QRNG_LEGACY_RESET_PATH");
    check(GR, "Bongo QRNG_LEGACY_RESET_PATH fora de /qrng/", Boolean(fallback) && fallback.startsWith("/") && !gated(fallback),
      "/… fora de /qrng/", fallback ? fallback : `não definido (padrão ${RESET_DEFAULT_PATH})`);
    const bongoBase = envOf(C_BONGO, "PUBLIC_BASE_URL");
    check(GR, "Bongo PUBLIC_BASE_URL = borda deste ambiente", bongoBase === base, base, bongoBase || "-");
    // caminhos efetivos (com o padrão do código quando a variável falta → o FAIL aparece abaixo também)
    for (const p of ["/redefinir-senha", legacyPath || RESET_DEFAULT_PATH, fallback || RESET_DEFAULT_PATH]) if (!resetPaths.includes(p)) resetPaths.push(p);
    const who = {
      "sem sessão": null, "cookie lixo": "1", "expirado": expired, "pending": U.pending.jwt,
      "sem qrng": U.noqrng.jwt, "desabilitado": U.disabled.jwt, "com qrng": U.qrng.jwt,
    };
    for (const p of resetPaths) {
      for (const [label, jwt] of Object.entries(who)) {
        expectHtmlStub(GR, `GET ${p} (${label})`, await request("GET", p, { headers: cookie(jwt) }), "bongo-front-stub");
      }
    }
    // controle negativo: sob /qrng/ o gate redireciona (por isso o link não pode morar lá)
    expectRedirect(GR, `controle: GET ${GATED_PROBE_PATH} sem sessão → login (o #token= se perderia)`,
      await request("GET", GATED_PROBE_PATH), `/?redirect=${GATED_PROBE_PATH}`);
  }

  // ── auditoria: sem segredos; falhas sem e-mail completo ──
  const GA = "auditoria";
  {
    const ba = await request("GET", "/api/admin/audit?limit=500", { headers: A });
    const ev = listOf(ba.json);
    check(GA, "GET /api/admin/audit", ba.status === 200 && ev.length > 0, "200 com eventos", show(ba));
    const txt = JSON.stringify(ba.json || {});
    check(GA, "Bongo: nenhum segredo nos eventos", ![...SECRETS].some((s) => txt.includes(s)), "nenhum", "verificado");
    const failMail = ev.filter((e) => e.outcome && e.outcome !== "success").some((e) => [...EMAILS].some((m) => JSON.stringify(e).includes(m)));
    check(GA, "Bongo: eventos de falha sem e-mail completo", !failMail, "nenhum", failMail ? "E-MAIL EM EVENTO DE FALHA" : "nenhum");
    check(GA, "Bongo: falha de login registrada", ev.some((e) => evType(e) === "auth.login" && e.outcome === "failure"), "auth.login failure", "verificado");

    // senha estável por ambiente (derivada de um segredo do .env): reexecuções na mesma stack
    const la = { email: "admin-legado@authgate.invalid", password: secret(`Ad${crypto.createHmac("sha256", ENV.AUTHGATE_CLIENT_API_JWT_SECRET).update("admin-legado").digest("base64url").slice(0, 20)}9z`) };
    let lj = (await request("POST", "/qrng/v1/auth/register", { body: la })).json?.token;
    if (!lj) lj = (await request("POST", "/qrng/v1/auth/login", { body: la })).json?.token;
    secret(lj);
    if (!lj) {
      check(GA, "client-api: admin legado (bootstrap)", false, "token", "cadastro/login falhou (stack reaproveitada? rode down.sh/up.sh)");
    } else {
      const ca = await request("GET", "/qrng/v1/admin/audit", { headers: bearer(lj) });
      const ctxt = JSON.stringify(ca.json || {});
      check(GA, "GET /qrng/v1/admin/audit", ca.status === 200, "200", show(ca));
      check(GA, "client-api: nenhum segredo nos eventos", ![...SECRETS].some((s) => ctxt.includes(s)), "nenhum", "verificado");
      const cev = listOf(ca.json);
      const cFail = cev.filter((e) => e.outcome && e.outcome !== "success").some((e) => [...EMAILS].some((m) => JSON.stringify(e).includes(m)));
      check(GA, "client-api: eventos de falha sem e-mail completo", !cFail, "nenhum", cFail ? "E-MAIL EM EVENTO DE FALHA" : "nenhum");
      check(GA, "client-api: identity.linked registrado", cev.some((e) => evType(e) === "identity.linked" && e.outcome === "success"), "identity.linked success", "verificado");
    }
  }

  // ── Bongo fora do ar: falha fechada ──
  if (!SKIP_DOWN) {
    const GB = "Bongo parado";
    const stop = docker(["stop", C_BONGO]);
    check(GB, "docker stop bongosite-auth", stop.code === 0, "ok", stop.code === 0 ? "parado" : redact(stop.out.slice(0, 120)));
    for (const [label, jwt] of [["com qrng", U.qrng.jwt], ["admin", adminJwt]]) {
      const r = await request("GET", "/qrng/", { headers: cookie(jwt) });
      const ok = r.status === 503 && ctype(r) === "text/html" && /no-store/.test(r.headers["cache-control"] || "") && !r.text.includes("qrng-spa-stub");
      check(GB, `GET /qrng/ (${label})`, ok, "503 text/html no-store", show(r));
      check(GB, `GET /qrng/ (${label}) responde rápido`, r.ms < 8000, "< 8 s", `${r.ms} ms`);
    }
    expectRedirect(GB, "GET /qrng/ sem cookie (atalho do if)", await request("GET", "/qrng/"), "/?redirect=/qrng/");
    for (const [label, jwt] of [["com qrng", U.qrng.jwt], ["sem sessão", null]]) {
      expectJson(GB, `GET /qrng/api/stream (${label})`, await streamReq("/qrng/api/stream", cookie(jwt)), 503, "IDENTITY_UNAVAILABLE");
      expectJson(GB, `GET /qrng/nist/health (${label})`, await request("GET", "/qrng/nist/health", { headers: cookie(jwt) }), 503, "IDENTITY_UNAVAILABLE");
      expectJson(GB, `POST /qrng/nist/nist/run (${label})`, await request("POST", "/qrng/nist/nist/run", { headers: cookie(jwt), body: {} }), 503, "IDENTITY_UNAVAILABLE");
    }
    expectJson(GB, "GET /qrng/v1/identity/status (sessão do portal)", await request("GET", "/qrng/v1/identity/status", { headers: portal(U.qrng.jwt) }), 503, "IDENTITY_UNAVAILABLE");
    expectJson(GB, "GET /qrng/v1/me/token (sessão do portal)", await request("GET", "/qrng/v1/me/token", { headers: portal(U.linker.jwt) }), 503, "IDENTITY_UNAVAILABLE");
    const k = await request("GET", "/qrng/v1/random?bytes=16", { headers: bearer(L.key) });
    check(GB, "chave de API legada continua funcionando", k.status === 200, "200", show(k));
    const ll = await request("POST", "/qrng/v1/auth/login", { body: { email: L.email, password: L.password } });
    secret(ll.json?.token);
    check(GB, "login legado continua funcionando", ll.status === 200, "200", show(ll));
    const pub = await request("GET", "/qrng/api/random?bytes=16");
    check(GB, "público /qrng/api/random continua", pub.status === 200, "200", show(pub));
    const edu = await request("GET", "/edu/", { headers: cookie(U.qrng.jwt) });
    check(GB, "GET /edu/ (inalterado: 500 do nginx, fora do escopo)", edu.status === 500, "500", show(edu));
    for (const p of resetPaths) {
      expectHtmlStub(GB, `GET ${p} sem sessão (não depende do gate)`, await request("GET", p), "bongo-front-stub");
    }

    const start = docker(["start", C_BONGO]);
    // o nginx resolve nomes só ao carregar: recarrega para pegar o IP novo do container
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      await sleep(1000);
      docker(["exec", C_NGINX, "nginx", "-s", "reload"]);
      healthy = (await request("GET", "/api/health")).status === 200;
    }
    check(GB, "docker start bongosite-auth + saúde", start.code === 0 && healthy, "ok", healthy ? "saudável" : "não voltou");
    expectHtmlStub(GB, "GET /qrng/ (com qrng) após a volta", await request("GET", "/qrng/", { headers: cookie(U.qrng.jwt) }), "qrng-spa-stub");
  }

  // ── logs dos containers sem segredos ──
  const GLOG = "logs";
  for (const c of [C_BONGO, C_CLIENT, C_NGINX]) {
    const l = docker(["logs", c]);
    if (l.code !== 0) { check(GLOG, `${c}: docker logs`, false, "ok", redact(l.out.slice(0, 120))); continue; }
    const sec = [...SECRETS].some((s) => l.out.includes(s));
    const mail = [...EMAILS].some((e) => l.out.includes(e));
    const link = /#token=|redefinir-senha#/.test(l.out);
    check(GLOG, `${c}: sem senhas/JWTs/tokens/chaves`, !sec, "nenhum", sec ? "SEGREDO NO LOG" : "nenhum");
    check(GLOG, `${c}: sem e-mail completo dos usuários de teste`, !mail, "nenhum", mail ? "E-MAIL NO LOG" : "nenhum");
    check(GLOG, `${c}: sem link de redefinição`, !link, "nenhum", link ? "LINK NO LOG" : "nenhum");
  }
}

function printTable() {
  const rows = results.map((r) => [r.ok ? "PASS" : "FAIL", r.group, r.name, r.expected, r.got]);
  const head = ["", "grupo", "verificação", "esperado", "obtido"];
  const w = head.map((h, i) => Math.min(70, Math.max(h.length, ...rows.map((r) => String(r[i]).length))));
  const fmt = (r) => r.map((c, i) => String(c).slice(0, w[i]).padEnd(w[i])).join("  ");
  console.log(fmt(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(fmt(r));
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} PASS, ${fail} FAIL  (execução ${RUN}, http://127.0.0.1:${PORT})`);
  return fail;
}

main()
  .catch((e) => check("execução", "exceção", false, "sem exceção", e?.message || String(e)))
  .finally(() => {
    const failures = printTable();
    process.exit(failures > 0 || results.length === 0 ? 1 : 0);
  });
