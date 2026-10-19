// Rotas de proxy para cada fonte
export const API_ROUTES = {
  remote: "/qrng/api",
  fpga: "/qrng/api-fpga",
};

// Rota do serviço de gestão de tokens (alinhada com o nginx do servidor: /qrng/v1/ → localhost:3010/v1/)
export const CLIENT_API = "/qrng/v1";

export function getApiPrefix(source) {
  return API_ROUTES[source] || "/api";
}

export async function fetchHealth(apiPrefix = "/api") {
  const t0 = performance.now();
  try {
    const r = await fetch(`${apiPrefix}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    data._latencyMs = Math.round(performance.now() - t0);
    return data;
  } catch {
    return null;
  }
}

// Usado por lib/qrngHelper.js (adaptador canônico) e pelas funções de
// developer/admin abaixo. fetchQRNGBytes/fetchQRNGRandInt/fetchQRNGSeed
// (que viviam aqui) foram consolidadas em lib/qrngHelper.js como
// fetchQrngBytesViaToken/fetchQrngRandIntViaToken/fetchQrngRandIntsViaToken
// -- ver item 3 da auditoria do pipeline QRNG (adaptador único).
//
// Credencial conforme o modo da área do desenvolvedor DESTA aba (doc 155,
// §2.4) — nunca a do outro modo: em modo portal o JWT legado guardado em
// qrng_auth_jwt (resto de uma sessão antiga, talvez de outra pessoa neste
// navegador) NUNCA sai; vai a sessão do portal em X-Portal-Session.
//  - legacy → Authorization: Bearer <qrng_auth_jwt>;
//  - portal → X-Portal-Session: <JWT do portal> (nada se o usuário saiu da
//    área do desenvolvedor nesta aba, ou se não há sessão do portal);
//  - sessão fixada nesta aba trocada por outra aba → nada.
export function getAuthHeaders() {
  if (devSessionChanged()) return {};
  if (getDevSessionMode() === "legacy") {
    const jwt = readLocal("qrng_auth_jwt");
    return jwt ? { Authorization: `Bearer ${jwt}` } : {};
  }
  if (isPortalDevSignedOut()) return {};
  const tok = portalToken();
  return tok ? { "X-Portal-Session": tok } : {};
}

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ── Sessão do portal (Bongo) ───────────────────────────────────────────────────

// JWT do portal: cookie bongo_session (o mesmo que o nginx usa para liberar o
// /qrng/), senão localStorage bongo_token. Só leitura — a SPA do QRNG nunca
// grava nem apaga a sessão do portal.
export function portalToken() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)bongo_session=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch { /* sem document (testes) */ }
  try { return localStorage.getItem("bongo_token"); } catch { return null; }
}

// Modo da área do desenvolvedor (doc 155, §2.4):
//  - "portal" (padrão): a identidade é a sessão do portal, enviada no cabeçalho
//    explícito X-Portal-Session (nunca por cookie → sem CSRF);
//  - "legacy": conta antiga da API (e-mail e senha), JWT em qrng_auth_jwt.
// Desde esta versão o modo é SEMPRE gravado ("portal" ou "legacy"). Dica
// AUSENTE com qrng_auth_jwt presente = navegador vindo da versão anterior,
// que usava esse JWT direto (área do desenvolvedor e chip de cota): a sessão
// legada é retomada UMA vez (grava "legacy"; a página ainda valida o JWT em
// /auth/me e volta a "portal" se ele não valer). Depois de qualquer escolha
// explícita, um JWT que sobrou nunca sai em modo portal.
const DEV_AUTH_MODE_KEY = "qrng_dev_auth_mode";
export function getDevAuthMode() {
  try {
    const v = localStorage.getItem(DEV_AUTH_MODE_KEY);
    if (v === "legacy") return "legacy";
    if (v === "portal") return "portal";
    if (localStorage.getItem("qrng_auth_jwt")) {
      localStorage.setItem(DEV_AUTH_MODE_KEY, "legacy");
      return "legacy";
    }
    return "portal";
  } catch { return "portal"; }
}
export function setDevAuthMode(mode) {
  try {
    localStorage.setItem(DEV_AUTH_MODE_KEY, mode === "legacy" ? "legacy" : "portal");
  } catch { /* localStorage indisponível: fica no padrão (portal) */ }
}

// ── Sessão fixada nesta aba ────────────────────────────────────────────────────
//
// qrng_dev_auth_mode (localStorage) é global ao navegador: qualquer outra aba o
// troca a qualquer momento. Por isso ele é só uma DICA de retomada, lida na
// montagem da página. A credencial que esta aba usa é fixada quando a página
// autentica (bindDevSession): o modo E o valor exato da credencial (JWT legado
// ou JWT do portal). Se a credencial viva deixar de ser a fixada — outra aba
// entrou com outra conta, saiu, ou trocou de modo —, nenhuma chamada sai com
// a credencial nova: devFetch devolve {sessionChanged: true} sem rede e avisa
// os ouvintes (onDevSessionChanged), e a página volta à entrada. Assim um
// "Revogar"/"Rotacionar" nunca age numa conta diferente da que está na tela.
// A variável é do módulo (= desta aba); nada disto vai para o armazenamento.
let boundSession = null; // { mode: "portal" | "legacy", credential: string|null }
const sessionListeners = new Set();

function liveCredential(mode) {
  return mode === "legacy" ? readLocal("qrng_auth_jwt") : portalToken();
}

export function bindDevSession(mode) {
  const m = mode === "legacy" ? "legacy" : "portal";
  boundSession = { mode: m, credential: liveCredential(m) };
}
export function unbindDevSession() {
  boundSession = null;
}
// Modo efetivo desta aba: o da sessão fixada; sem ela, a dica do localStorage.
export function getDevSessionMode() {
  return boundSession ? boundSession.mode : getDevAuthMode();
}
// true quando a credencial viva já não é a fixada nesta aba.
export function devSessionChanged() {
  return !!boundSession && liveCredential(boundSession.mode) !== boundSession.credential;
}
export function onDevSessionChanged(fn) {
  sessionListeners.add(fn);
  return () => { sessionListeners.delete(fn); };
}
function sessionChangedResult() {
  sessionListeners.forEach((fn) => { try { fn(); } catch { /* ouvinte com erro não bloqueia os outros */ } });
  return { ok: false, status: 0, data: { error: "DEV_SESSION_CHANGED" }, sessionChanged: true };
}

// "Sair" da área do desenvolvedor em modo portal (só nesta aba): a sessão do
// portal continua válida — sair do portal é no portal —, mas um recarregamento
// desta aba não reabre o painel até o usuário escolher "Continuar com minha
// conta do portal". sessionStorage = por aba; só um marcador, sem segredo.
const PORTAL_SIGNED_OUT_KEY = "qrng_dev_portal_signed_out";
export function isPortalDevSignedOut() {
  try { return sessionStorage.getItem(PORTAL_SIGNED_OUT_KEY) === "1"; } catch { return false; }
}
export function setPortalDevSignedOut(signedOut) {
  try {
    if (signedOut) sessionStorage.setItem(PORTAL_SIGNED_OUT_KEY, "1");
    else sessionStorage.removeItem(PORTAL_SIGNED_OUT_KEY);
  } catch { /* sessionStorage indisponível: o painel reabre ao recarregar */ }
}

// ── Auth & Developer API ───────────────────────────────────────────────────────

// devFetch: credencial conforme o modo da área do desenvolvedor — NUNCA as duas.
//  - portal → X-Portal-Session: <JWT do portal> (sem Authorization);
//  - legacy → Authorization: Bearer <qrng_auth_jwt> (sem X-Portal-Session);
//  - _auth: "none" → nenhuma credencial (login/cadastro legados).
// `_auth` força um modo para a chamada (ex.: rotas /identity/* são sempre portal).
// Sem `_auth`, o modo é o da sessão fixada nesta aba (getDevSessionMode), não a
// dica global do localStorage; se a credencial fixada foi trocada por outra
// aba, a chamada NÃO sai (ver bindDevSession).
async function devFetch(path, options = {}) {
  const { _auth, ...rest } = options;
  const mode = _auth || getDevSessionMode();
  if (boundSession && mode === boundSession.mode && devSessionChanged()) return sessionChangedResult();
  const headers = { "Content-Type": "application/json", ...rest.headers };
  delete headers["Authorization"];
  delete headers["X-Portal-Session"];
  if (mode === "portal") {
    const tok = portalToken();
    if (tok) headers["X-Portal-Session"] = tok;
  } else if (mode === "legacy") {
    const jwt = readLocal("qrng_auth_jwt");
    if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  }
  const r = await fetch(`${CLIENT_API}${path}`, { ...rest, headers, signal: AbortSignal.timeout(10000) });
  // corpo não-JSON (ex.: página de erro do nginx num 502/503) → {} em vez de exceção,
  // para o chamador decidir pelo status
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Auth (conta antiga da API — e-mail e senha da client-api)
export async function authRegister(email, password) {
  return devFetch("/auth/register", { method: "POST", body: JSON.stringify({ email, password }), _auth: "none" });
}
export async function authLogin(email, password) {
  return devFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }), _auth: "none" });
}
export async function authMe() {
  return devFetch("/auth/me");
}

// Identidade integrada (doc 155, §2.5) — sempre com a sessão do portal
export async function identityStatus() {
  return devFetch("/identity/status", { _auth: "portal" });
}
export async function identityProvision() {
  return devFetch("/identity/provision", { method: "POST", _auth: "portal" });
}
// `lang` (pt|en) = idioma do aviso de vínculo enviado ao e-mail da conta antiga.
export async function identityLink({ reauthToken, legacyEmail, legacyPassword, lang }) {
  const body = { reauthToken, legacyEmail, legacyPassword };
  if (lang === "en" || lang === "pt") body.lang = lang;
  return devFetch("/identity/link", {
    method: "POST",
    body: JSON.stringify(body),
    _auth: "portal",
  });
}

// Reautenticação no portal (Bongo, mesma origem): senha do portal → reauthToken
// de uso único (5 min) com a finalidade link_qrng_developer. O token só vive na
// memória do chamador até ser enviado a /identity/link.
export async function portalReauth(password) {
  if (boundSession && boundSession.mode === "portal" && devSessionChanged()) return sessionChangedResult();
  const tok = portalToken();
  const headers = { "Content-Type": "application/json" };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const r = await fetch("/api/auth/reauth", {
    method: "POST",
    headers,
    body: JSON.stringify({ currentPassword: password, purpose: "link_qrng_developer" }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Token management
export async function devCreateToken() {
  return devFetch("/tokens", { method: "POST" });
}
export async function devGetToken() {
  return devFetch("/me/token");
}
export async function devRotateToken() {
  return devFetch("/me/token/rotate", { method: "POST" });
}
export async function devRevokeToken() {
  return devFetch("/me/token/revoke", { method: "POST" });
}
export async function devGetUsage() {
  return devFetch("/me/usage");
}
export async function devGetRequests(limit = 20) {
  return devFetch(`/me/requests?limit=${limit}`);
}
export async function devGetUpstreamStatus() {
  return devFetch("/upstream/status");
}

// Admin (mesma credencial fixada nesta aba — o servidor valida role=admin)
export async function adminGetTokens()                { return devFetch("/admin/tokens"); }
export async function adminRevokeToken(id)            { return devFetch(`/admin/tokens/${id}/revoke`, { method: "POST" }); }
export async function adminSetQuota(id, quota_daily)  { return devFetch(`/admin/tokens/${id}/quota`, { method: "PATCH", body: JSON.stringify({ quota_daily }) }); }
export async function adminGetUsers()                 { return devFetch("/admin/users"); }

// ── NIST SP 800-90B API ───────────────────────────────────────────────────────

const NIST_API = "/qrng/nist";

async function nistFetch(path, options = {}) {
  const r = await fetch(`${NIST_API}${path}`, {
    ...options,
    signal: AbortSignal.timeout(options._timeout || 30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `NIST API error ${r.status}`);
  return data;
}

export async function nistStatus()         { return nistFetch("/nist/status"); }
export async function nistJobs(limit = 50) { return nistFetch(`/nist/jobs?limit=${limit}`); }
export async function nistJob(id)          { return nistFetch(`/nist/jobs/${id}`); }
export async function nistJobLog(id)       { return nistFetch(`/nist/jobs/${id}/log`); }

export async function nistRun(testType = "both", format = "auto", source = "latest") {
  const body = new FormData();
  body.append("test_type", testType);
  body.append("format",    format);
  body.append("source",    source);
  return nistFetch("/nist/run", { method: "POST", body, _timeout: 60000 });
}

export async function nistUpload(file, testType = "both", format = "auto") {
  const body = new FormData();
  body.append("file",      file);
  body.append("test_type", testType);
  body.append("format",    format);
  return nistFetch("/nist/upload", { method: "POST", body, _timeout: 120000 });
}

// ─────────────────────────────────────────────────────────────────────────────

export function connectQRNGStream(onChunk, onError, onClose, onStall, apiPrefix = "/api") {
  const controller = new AbortController();
  let userAborted = false;
  let stallTimer = null;
  let criticalTimer = null;
  let isStalled = false;

  const cleanup = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (criticalTimer) { clearTimeout(criticalTimer); criticalTimer = null; }
  };

  (async () => {
    try {
      const connectTimeout = setTimeout(() => {
        if (!userAborted) controller.abort();
      }, 10000);

      const response = await fetch(`${apiPrefix}/stream`, { signal: controller.signal });
      clearTimeout(connectTimeout);

      if (!response.ok) {
        onError(new Error(`Stream HTTP ${response.status}`));
        return;
      }

      const reader = response.body.getReader();

      const resetStall = () => {
        cleanup();
        if (isStalled) {
          isStalled = false;
          if (onStall) onStall(false);
        }
        stallTimer = setTimeout(() => {
          if (!userAborted) {
            isStalled = true;
            if (onStall) onStall(true);
            criticalTimer = setTimeout(() => {
              if (!userAborted) {
                cleanup();
                controller.abort();
                onError(new Error("Stream sem dados por 90s — conexao encerrada"));
              }
            }, 45000);
          }
        }, 45000);
      };
      resetStall();

      while (true) {
        const { done, value } = await reader.read();
        if (done) { cleanup(); onClose(); break; }
        resetStall();
        // `value` já é um Uint8Array; `value.buffer` é o ArrayBuffer SUBJACENTE,
        // que o navegador costuma alocar maior que a fatia recebida — usá-lo
        // inflava a contagem de bytes (87 MiB "recebidos" em 12 s com
        // limit_rate de 256 kB/s) e injetava lixo na visualização.
        onChunk(value instanceof Uint8Array ? value : new Uint8Array(value));
      }
    } catch (err) {
      cleanup();
      if (err.name === "AbortError" && !userAborted) {
        onError(new Error("Stream timeout na conexao"));
      } else if (err.name !== "AbortError") {
        onError(err);
      }
    }
  })();

  return () => {
    userAborted = true;
    cleanup();
    controller.abort();
  };
}
