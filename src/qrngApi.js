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

export async function fetchQRNGBytes(count, apiPrefix = "/api") {
  const t0 = performance.now();
  const requestBytes = Math.min(count * 5, 50 * 1024 * 1024);
  const r = await fetch(`${apiPrefix}/random?bytes=${requestBytes}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`QRNG error: ${r.status}`);
  const buf = await r.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const bytes = text.split("\n").filter(s => s.trim()).map(Number).filter(n => !isNaN(n) && n >= 0 && n <= 255);
  return { bytes: bytes.slice(0, count), latencyMs: Math.round(performance.now() - t0) };
}

export async function fetchQRNGRandInt(min, max, apiPrefix = "/api") {
  const t0 = performance.now();
  const r = await fetch(`${apiPrefix}/randint?min=${min}&max=${max}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`QRNG randint error: ${r.status}`);
  const data = await r.json();
  return { value: data.value, latencyMs: Math.round(performance.now() - t0) };
}

export async function fetchQRNGSeed(bytes, apiPrefix = "/api") {
  const t0 = performance.now();
  const r = await fetch(`${apiPrefix}/seed?bytes=${bytes}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`QRNG seed error: ${r.status}`);
  const data = await r.json();
  return { bytes: data.bytes, hex: data.hex, latencyMs: Math.round(performance.now() - t0) };
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
