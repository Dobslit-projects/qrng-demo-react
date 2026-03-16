import { createContext, useState, useEffect, useMemo } from "react";
import { fetchHealth } from "../qrngApi";

export const AppContext = createContext();

export function AppProvider({ children }) {
  const [health, setHealth] = useState(null);
  const [latency, setLatency] = useState(null);
  const [qrngSource, setQrngSource] = useState("pre-collected");
  const [streamError, setStreamError] = useState(null);
  const [activePage, setActivePage] = useState("analysis");

  useEffect(() => {
    const poll = async () => {
      const h = await fetchHealth();
      setHealth(h);
      if (h && h._latencyMs) setLatency(h._latencyMs);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  const value = useMemo(() => ({
    health,
    latency,
    setLatency,
    qrngSource,
    setQrngSource,
    isOnline: health !== null,
    streamError,
    setStreamError,
    activePage,
    setActivePage,
  }), [health, latency, qrngSource, streamError, activePage]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
