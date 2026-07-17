import { createContext, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { fetchHealth, API_ROUTES } from "../qrngApi";

export const AppContext = createContext();

const STORAGE_KEY     = "qrng-source";
const HEALTH_POLL_MS  = 15000; // 15s — reduced load, no more 3s flapping
const FAIL_THRESHOLD  = 3;     // 3 consecutive failures → mark OFFLINE
const OK_THRESHOLD    = 2;     // 2 consecutive successes → recover from OFFLINE

function loadSource() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && ["remote", "pre-collected", "fpga"].includes(saved)) return saved;
  } catch {}
  return "remote";
}

export const SOURCE_LABELS = {
  remote: "Remota (SP)",
  fpga: "FPGA (Hardware)",
  "pre-collected": "Pré-coletado",
};

/**
 * Polls health endpoint with hysteresis:
 * - checking=true until the first poll completes (no false OFFLINE on mount)
 * - First success → immediately ONLINE (isOfflineRef starts false)
 * - After ONLINE: 3 consecutive failures → OFFLINE
 * - After OFFLINE (confirmed): 2 consecutive successes → ONLINE
 * - DEGRADED: health responds 200 but buffer_bytes_available === 0
 */
function useHysteresisHealth(apiPrefix) {
  const [health, setHealth]     = useState(null);
  const [latency, setLatency]   = useState(null);
  const [checking, setChecking] = useState(true); // neutral until first poll completes
  const failsRef     = useRef(0);
  const successRef   = useRef(0);
  const isOfflineRef = useRef(false); // false: first success accepted immediately
  const firstDone    = useRef(false); // guards the one-time setChecking(false)

  useEffect(() => {
    const poll = async () => {
      const h = await fetchHealth(apiPrefix);
      if (h !== null) {
        failsRef.current   = 0;
        successRef.current += 1;
        const wasOffline = isOfflineRef.current;
        if (!wasOffline || successRef.current >= OK_THRESHOLD) {
          isOfflineRef.current = false;
          setHealth(h);
          if (h._latencyMs) setLatency(h._latencyMs);
        }
      } else {
        successRef.current = 0;
        failsRef.current  += 1;
        if (failsRef.current >= FAIL_THRESHOLD || isOfflineRef.current) {
          isOfflineRef.current = true;
          setHealth(null);
        }
      }
      // After any poll completion, leave the checking state
      if (!firstDone.current) {
        firstDone.current = true;
        setChecking(false);
      }
    };
    poll();
    const t = setInterval(poll, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, [apiPrefix]);

  return { health, latency, checking };
}

function computeStatus(qrngSource, health, checking) {
  if (qrngSource === "pre-collected") return "pre-collected";
  if (checking) return "checking";
  if (health === null) return "offline";
  if (typeof health.buffer_bytes_available === "number" && health.buffer_bytes_available === 0)
    return "degraded";
  return "online";
}

export function AppProvider({ children }) {
  const { health: remoteHealth, latency: remoteLatency, checking: remoteChecking } = useHysteresisHealth(API_ROUTES.remote);
  const { health: fpgaHealth,   latency: fpgaLatency,   checking: fpgaChecking   } = useHysteresisHealth(API_ROUTES.fpga);

  const [qrngSource, setQrngSourceRaw] = useState(loadSource);
  const [streamError, setStreamError]  = useState(null);
  const [activePage,  setActivePage]   = useState("kapua");

  const setQrngSource = useCallback((src) => {
    setQrngSourceRaw(src);
    try { localStorage.setItem(STORAGE_KEY, src); } catch {}
  }, []);

  const health    = qrngSource === "remote" ? remoteHealth    : qrngSource === "fpga" ? fpgaHealth    : null;
  const latency   = qrngSource === "remote" ? remoteLatency   : qrngSource === "fpga" ? fpgaLatency   : null;
  const checking  = qrngSource === "remote" ? remoteChecking  : qrngSource === "fpga" ? fpgaChecking  : false;

  const status   = computeStatus(qrngSource, health, checking);
  const isOnline = status === "online" || status === "pre-collected";

  const value = useMemo(() => ({
    health,
    latency,
    qrngSource,
    setQrngSource,
    isOnline,
    status,      // "checking" | "online" | "degraded" | "offline" | "pre-collected"
    checking,
    streamError,
    setStreamError,
    activePage,
    setActivePage,
    remoteHealth,
    remoteLatency,
    fpgaHealth,
    fpgaLatency,
    setLatency: (v) => {
      // kept for backward compat — hysteresis hook manages latency internally
    },
  }), [health, latency, qrngSource, isOnline, status, checking, streamError, activePage,
       remoteHealth, remoteLatency, fpgaHealth, fpgaLatency, setQrngSource]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
