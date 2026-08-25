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
export function getAuthHeaders() {
  const jwt = localStorage.getItem("qrng_auth_jwt");
  return jwt ? { Authorization: `Bearer ${jwt}` } : {};
}

// ── Auth & Developer API ───────────────────────────────────────────────────────

// devFetch envia o JWT (qrng_auth_jwt) — usado para todos os endpoints autenticados da UI
async function devFetch(path, options = {}) {
  const jwt  = localStorage.getItem("qrng_auth_jwt");
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const r = await fetch(`${CLIENT_API}${path}`, { ...options, headers, signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// Auth
export async function authRegister(email, password) {
  return devFetch("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
}
export async function authLogin(email, password) {
  return devFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}
export async function authMe() {
  return devFetch("/auth/me");
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

// Admin (usa o mesmo JWT — o servidor valida role=admin)
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
        onChunk(new Uint8Array(value.buffer || value));
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
