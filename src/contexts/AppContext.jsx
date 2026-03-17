import { createContext, useState, useEffect, useMemo, useCallback } from "react";
import { fetchHealth, API_ROUTES } from "../qrngApi";

export const AppContext = createContext();

const STORAGE_KEY = "qrng-source";

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

export function AppProvider({ children }) {
  const [remoteHealth, setRemoteHealth] = useState(null);
  const [remoteLatency, setRemoteLatency] = useState(null);
  const [fpgaHealth, setFpgaHealth] = useState(null);
  const [fpgaLatency, setFpgaLatency] = useState(null);
  const [qrngSource, setQrngSourceRaw] = useState(loadSource);
  const [streamError, setStreamError] = useState(null);
  const [activePage, setActivePage] = useState("analysis");

  // Persistir fonte selecionada
  const setQrngSource = useCallback((src) => {
    setQrngSourceRaw(src);
    try { localStorage.setItem(STORAGE_KEY, src); } catch {}
  }, []);

  // Poll remote health
  useEffect(() => {
    const poll = async () => {
      const h = await fetchHealth(API_ROUTES.remote);
      setRemoteHealth(h);
      if (h && h._latencyMs) setRemoteLatency(h._latencyMs);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  // Poll FPGA health
  useEffect(() => {
    const poll = async () => {
      const h = await fetchHealth(API_ROUTES.fpga);
      setFpgaHealth(h);
      if (h && h._latencyMs) setFpgaLatency(h._latencyMs);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  // Derivados: health/latency da fonte ativa
  const health = qrngSource === "remote" ? remoteHealth
    : qrngSource === "fpga" ? fpgaHealth
    : null;

  const latency = qrngSource === "remote" ? remoteLatency
    : qrngSource === "fpga" ? fpgaLatency
    : null;

  const isOnline = qrngSource === "pre-collected" ? true : health !== null;

  const value = useMemo(() => ({
    // Fonte ativa
    health,
    latency,
    qrngSource,
    setQrngSource,
    isOnline,
    streamError,
    setStreamError,
    activePage,
    setActivePage,
    // Status de todas as fontes (para SettingsSection)
    remoteHealth,
    remoteLatency,
    fpgaHealth,
    fpgaLatency,
    setLatency: (v) => {
      if (qrngSource === "remote") setRemoteLatency(v);
      else if (qrngSource === "fpga") setFpgaLatency(v);
    },
  }), [health, latency, qrngSource, isOnline, streamError, activePage,
       remoteHealth, remoteLatency, fpgaHealth, fpgaLatency, setQrngSource]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
