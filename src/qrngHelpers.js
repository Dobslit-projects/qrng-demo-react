import { fetchQRNGBytes, getApiPrefix } from "./qrngApi";
import { QRNG_PRECOLLECTED } from "./qrngFallbackData";

let fallbackOffset = 0;

export function bytesToFloats(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const floats = [];
  for (let i = 0; i + 3 < arr.length; i += 4) {
    const n = ((arr[i+3] << 24) | (arr[i+2] << 16) | (arr[i+1] << 8) | arr[i]) >>> 0;
    floats.push(n / 4294967296);
  }
  return floats;
}

export function getFallbackFloats(count) {
  const floats = [];
  for (let i = 0; i < count; i++) {
    const off = (fallbackOffset + i * 4) % QRNG_PRECOLLECTED.length;
    const b0 = QRNG_PRECOLLECTED[off % QRNG_PRECOLLECTED.length];
    const b1 = QRNG_PRECOLLECTED[(off + 1) % QRNG_PRECOLLECTED.length];
    const b2 = QRNG_PRECOLLECTED[(off + 2) % QRNG_PRECOLLECTED.length];
    const b3 = QRNG_PRECOLLECTED[(off + 3) % QRNG_PRECOLLECTED.length];
    const n = ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
    floats.push(n / 4294967296);
  }
  fallbackOffset = (fallbackOffset + count * 4) % QRNG_PRECOLLECTED.length;
  return floats;
}

export function qrngBytesToInts(bytes, min, max) {
  const range = max - min + 1;
  return bytes.map((b) => min + (b % range));
}

/**
 * Gera sequência QRNG usando a fonte especificada.
 * @param {number} count - Quantidade de floats desejados
 * @param {string} source - "remote" | "fpga" | "pre-collected"
 */
export async function generateQRNGSequence(count, source = "remote") {
  if (source === "pre-collected") {
    return { values: getFallbackFloats(count), source: "pre-collected", latencyMs: null };
  }

  const apiPrefix = getApiPrefix(source);
  try {
    const { bytes, latencyMs } = await fetchQRNGBytes(count * 4, apiPrefix);
    return { values: bytesToFloats(bytes), source, latencyMs };
  } catch {
    return { values: getFallbackFloats(count), source: "pre-collected", latencyMs: null };
  }
}
