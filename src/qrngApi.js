const API_BASE = import.meta.env.VITE_API_BASE || "http://189.126.105.45:3001";

export async function fetchHealth() {
  const t0 = performance.now();
  try {
    const r = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    data._latencyMs = Math.round(performance.now() - t0);
    return data;
  } catch {
    return null;
  }
}

export async function fetchQRNGBytes(count) {
  const t0 = performance.now();
  // The QRNG backend source file has one decimal number (0-255) per line.
  // Both /api/seed and /api/random return the raw text bytes of that file.
  // Each number line averages ~4 bytes of text ("136\n"), so we request ~5x.
  // /api/random supports up to 50MB, /api/seed only 1024 bytes.
  const requestBytes = Math.min(count * 5, 50 * 1024 * 1024);
  const r = await fetch(`${API_BASE}/api/random?bytes=${requestBytes}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`QRNG error: ${r.status}`);
  const buf = await r.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const bytes = text.split("\n").filter(s => s.trim()).map(Number).filter(n => !isNaN(n) && n >= 0 && n <= 255);
  return { bytes: bytes.slice(0, count), latencyMs: Math.round(performance.now() - t0) };
}

export async function fetchQRNGRandInt(min, max) {
  const t0 = performance.now();
  const r = await fetch(`${API_BASE}/api/randint?min=${min}&max=${max}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`QRNG randint error: ${r.status}`);
  const data = await r.json();
  return { value: data.value, latencyMs: Math.round(performance.now() - t0) };
}

export async function fetchQRNGSeed(bytes) {
  const t0 = performance.now();
  const r = await fetch(`${API_BASE}/api/seed?bytes=${bytes}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`QRNG seed error: ${r.status}`);
  const data = await r.json();
  return { bytes: data.bytes, hex: data.hex, latencyMs: Math.round(performance.now() - t0) };
}

export function connectQRNGStream(onChunk, onError, onClose, onStall) {
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
      // 10s timeout for initial connection
      const connectTimeout = setTimeout(() => {
        if (!userAborted) controller.abort();
      }, 10000);

      const response = await fetch(`${API_BASE}/api/stream`, {
        signal: controller.signal,
      });
      clearTimeout(connectTimeout);

      if (!response.ok) {
        onError(new Error(`Stream HTTP ${response.status}`));
        return;
      }

      const reader = response.body.getReader();

      // Two-tier stall detection:
      // - 45s: notify UI "aguardando dados" (soft stall, keep connection)
      // - 90s: kill connection (hard stall, something is really wrong)
      const resetStall = () => {
        cleanup();
        if (isStalled) {
          isStalled = false;
          if (onStall) onStall(false); // clear stall indicator
        }
        stallTimer = setTimeout(() => {
          if (!userAborted) {
            isStalled = true;
            if (onStall) onStall(true); // show "aguardando dados..."
            // Set critical timer - if still no data after 90s total, kill
            criticalTimer = setTimeout(() => {
              if (!userAborted) {
                cleanup();
                controller.abort();
                onError(new Error("Stream sem dados por 90s — conexao encerrada"));
              }
            }, 45000); // 45s more = 90s total
          }
        }, 45000);
      };
      resetStall();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          onClose();
          break;
        }
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

export { API_BASE };
