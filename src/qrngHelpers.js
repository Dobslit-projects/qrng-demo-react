import { fetchQRNGBytes, getApiPrefix } from "./qrngApi";
import { QRNG_PRECOLLECTED } from "./qrngFallbackData";

let fallbackOffset = 0;

export function bytesToFloats(bytes) {
  return bytes.map((b) => b / 255);
}

export function getFallbackFloats(count) {
  const floats = [];
  for (let i = 0; i < count; i++) {
    floats.push(QRNG_PRECOLLECTED[(fallbackOffset + i) % QRNG_PRECOLLECTED.length] / 255);
  }
  fallbackOffset = (fallbackOffset + count) % QRNG_PRECOLLECTED.length;
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
    const { bytes, latencyMs } = await fetchQRNGBytes(count, apiPrefix);
    return { values: bytesToFloats(bytes), source, latencyMs };
  } catch {
    return { values: getFallbackFloats(count), source: "pre-collected", latencyMs: null };
  }
}
