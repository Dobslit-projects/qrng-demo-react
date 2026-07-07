import { CLIENT_API } from "../qrngApi";

function getAuthHeaders() {
  const jwt = localStorage.getItem("qrng_auth_jwt");
  return jwt ? { Authorization: `Bearer ${jwt}` } : {};
}

/**
 * Fetch N bytes from QRNG backend. NO client-side fallback.
 * Throws "AUTH_REQUIRED" string if 401/403.
 * Throws error message string for other failures.
 */
export async function fetchQrngBytes(byteCount) {
  const t0 = performance.now();
  const r = await fetch(`${CLIENT_API}/random?bytes=${byteCount}&format=hex`, {
    headers: getAuthHeaders(),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new Error("AUTH_REQUIRED");
    throw new Error(body.detail || `QRNG API error ${r.status}`);
  }
  const json = await r.json();
  const hex = json.random || "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return {
    bytes, hex,
    source:    json.source    ?? json.generator ?? null,
    requestId: json.request_id ?? json.id       ?? null,
    timestamp: json.timestamp  ?? new Date().toISOString(),
    latencyMs: Math.round(performance.now() - t0),
  };
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToUint32Array(bytes) {
  const out = [];
  for (let i = 0; i + 3 < bytes.length; i += 4)
    out.push(((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0);
  return out;
}

export function uint32ToFloat(n) { return n / 4294967296; }

/** Rejection-sampling uniform int in [min, max] from Uint8Array */
export function uniformIntFromBytes(min, max, bytes) {
  const range = max - min + 1;
  const limit = (Math.floor(4294967296 / range)) * range;
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const n = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
    if (n < limit) return min + (n % range);
  }
  return min + (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) % range;
}

export function errorMessage(err) {
  if (err?.message === "AUTH_REQUIRED")
    return "Para usar esta funcionalidade, faça login na aba Desenvolvedor.";
  return err?.message || "API QRNG indisponível. Tente novamente.";
}
