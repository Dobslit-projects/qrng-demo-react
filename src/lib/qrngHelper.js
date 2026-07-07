import { API_ROUTES } from "../qrngApi";
import { QRNG_PRECOLLECTED } from "../qrngFallbackData";

/** Total bytes available in the pre-collected fallback buffer. */
export const PRECOLLECTED_LIMIT = QRNG_PRECOLLECTED.length;

let fallbackOffset = 0;

function getPrecollectedBytes(byteCount) {
  const t0 = performance.now();
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    bytes[i] = QRNG_PRECOLLECTED[(fallbackOffset + i) % PRECOLLECTED_LIMIT];
  }
  fallbackOffset = (fallbackOffset + byteCount) % PRECOLLECTED_LIMIT;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return {
    bytes, hex,
    source: "pré-coletado",
    requestId: null,
    timestamp: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - t0),
  };
}

/**
 * Fetch N bytes from the active QRNG source.
 * source: "remote" | "fpga" | "pre-collected"
 * When source is "pre-collected", reads from local QRNG_PRECOLLECTED — no network call.
 */
export async function fetchQrngBytes(byteCount, source = "remote") {
  if (source === "pre-collected") {
    return getPrecollectedBytes(byteCount);
  }
  const apiPrefix = API_ROUTES[source] || API_ROUTES.remote;
  const t0 = performance.now();
  const r = await fetch(`${apiPrefix}/random?bytes=${byteCount}&format=hex`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.error || body.message || `QRNG API error ${r.status}`);
  }
  const json = await r.json();
  const hex = json.random || json.hex || "";
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
  return err?.message || "Backend QRNG indisponível. Verifique a conexão e tente novamente.";
}
