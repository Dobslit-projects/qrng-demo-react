// Identidade do usuário e cota de uso visíveis no site (2026-10-18).
//
// - Usuário: a sessão do portal Bongo (JWT no cookie bongo_session, ou
//   bongo_token no localStorage) consultada em /api/auth/me — o mesmo que o
//   nginx usa para liberar o /qrng/. Só leitura; nada é gravado.
// - Cota pública: GET /qrng/v1/public/quota (por endereço de rede, zera à
//   meia-noite UTC). Atualizada a cada minuto e logo após cada download.
// - Conta de desenvolvedor (token pessoal): /v1/me/usage, quando há sessão
//   da área do Desenvolvedor neste navegador.
import { useSyncExternalStore, useEffect } from "react";
import { CLIENT_API, getAuthHeaders } from "../qrngApi";

function makeStore(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set: (v) => { value = v; subs.forEach((f) => f()); },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}

const userStore = makeStore({ loading: true, user: null });
const quotaStore = makeStore({ loading: true, quota: null, token: null, error: null });

function portalToken() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)bongo_session=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch { /* sem document (testes) */ }
  try { return localStorage.getItem("bongo_token"); } catch { return null; }
}

let userRequested = false;
export async function loadPortalUser() {
  userRequested = true;
  const tok = portalToken();
  if (!tok) { userStore.set({ loading: false, user: null }); return; }
  try {
    const r = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(8000) });
    const u = r.ok ? await r.json() : null;
    userStore.set({ loading: false, user: u ? { name: u.name, email: u.email, role: u.role, institution: u.institution } : null });
  } catch {
    userStore.set({ loading: false, user: null });
  }
}

let inflight = null;
export function refreshQuota() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(`${CLIENT_API}/public/quota`, { signal: AbortSignal.timeout(8000) });
      const quota = r.ok ? await r.json() : null;
      let token = null;
      if (getAuthHeaders().Authorization) {
        const t = await fetch(`${CLIENT_API}/me/usage`, { headers: getAuthHeaders(), signal: AbortSignal.timeout(8000) }).catch(() => null);
        const body = t && t.ok ? await t.json() : null;
        token = body && body.has_token ? body : null;
      }
      quotaStore.set({ loading: false, quota, token, error: r.ok ? null : `HTTP ${r.status}` });
    } catch (e) {
      quotaStore.set({ ...quotaStore.get(), loading: false, error: e.message });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function usePortalUser() {
  useEffect(() => { if (!userRequested) loadPortalUser(); }, []);
  return useSyncExternalStore(userStore.subscribe, userStore.get);
}

let pollers = 0;
let pollTimer = null;
export function useQuota() {
  useEffect(() => {
    pollers++;
    if (pollers === 1) {
      refreshQuota();
      pollTimer = setInterval(refreshQuota, 60000);
    }
    return () => { pollers--; if (pollers === 0) { clearInterval(pollTimer); pollTimer = null; } };
  }, []);
  return useSyncExternalStore(quotaStore.subscribe, quotaStore.get);
}
