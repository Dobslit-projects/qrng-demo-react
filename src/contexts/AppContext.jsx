import { createContext, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { fetchHealth, API_ROUTES } from "../qrngApi";
import {
  PRECOLLECTED_LIMIT,
  precollectedRemaining,
  resetPrecollectedCursor,
  onPrecollectedChange,
} from "../lib/qrngHelper";

export const AppContext = createContext();

const STORAGE_KEY      = "qrng-source";
const HEALTH_POLL_MS   = 15000; // 15s — cadência normal em regime (online/offline confirmados)
const CHECKING_POLL_MS = 2000;  // 2s — retry curto enquanto o primeiro check ainda não confirmou nada
const FAIL_THRESHOLD   = 3;     // 3 falhas consecutivas → confirma OFFLINE
const OK_THRESHOLD     = 2;     // 2 sucessos consecutivos → recupera de um OFFLINE confirmado

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
 * - Estado inicial é "checking" (nunca "offline") — evita o falso OFFLINE
 *   ao carregar/atualizar a página, antes de qualquer verificação real.
 * - Enquanto "checking": retry curto (CHECKING_POLL_MS) até confirmar.
 * - Primeiro sucesso, vindo de "checking" → ONLINE imediato (não espera
 *   OK_THRESHOLD; esse gate é só para recuperar de um OFFLINE já confirmado).
 * - A partir de ONLINE: só confirma OFFLINE após FAIL_THRESHOLD falhas
 *   consecutivas — uma falha isolada não derruba o status.
 * - A partir de OFFLINE confirmado: precisa de OK_THRESHOLD sucessos
 *   consecutivos para voltar a ONLINE (evita flapping).
 * - DEGRADED: health responde 200 mas buffer_bytes_available === 0.
 */
function useHysteresisHealth(apiPrefix) {
  const [health, setHealth]   = useState(null);
  const [latency, setLatency] = useState(null);
  const [status, setStatus]   = useState("checking"); // "checking" | "online" | "offline"
  const [lastSuccessAt, setLastSuccessAt] = useState(null); // epoch ms do último poll bem-sucedido
  const failsRef     = useRef(0);
  const successRef   = useRef(0);
  const statusRef     = useRef("checking");
  const inFlightRef   = useRef(false);

  useEffect(() => {
    // apiPrefix é constante em toda a vida do app (API_ROUTES.remote /
    // API_ROUTES.fpga nunca mudam) — os refs e o useState("checking")
    // inicial já cobrem o estado de partida; nada a resetar aqui.
    let mounted = true;
    let timer;

    const scheduleNext = () => {
      if (!mounted) return;
      const delay = statusRef.current === "checking" ? CHECKING_POLL_MS : HEALTH_POLL_MS;
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (inFlightRef.current) { scheduleNext(); return; } // evita requisições simultâneas
      inFlightRef.current = true;
      const h = await fetchHealth(apiPrefix);
      inFlightRef.current = false;
      if (!mounted) return; // não atualiza estado após unmount

      if (h !== null) {
        failsRef.current   = 0;
        successRef.current += 1;
        const wasConfirmedOffline = statusRef.current === "offline";
        if (!wasConfirmedOffline || successRef.current >= OK_THRESHOLD) {
          statusRef.current = "online";
          setStatus("online");
          setHealth(h);
          setLastSuccessAt(Date.now());
          if (h._latencyMs) setLatency(h._latencyMs);
        }
      } else {
        successRef.current = 0;
        failsRef.current  += 1;
        if (failsRef.current >= FAIL_THRESHOLD) {
          statusRef.current = "offline";
          setStatus("offline");
          setHealth(null);
        }
        // menos que FAIL_THRESHOLD: mantém o status atual (checking ou
        // online) — uma falha curta/transitória não derruba nada.
      }
      scheduleNext();
    };

    poll();
    return () => { mounted = false; clearTimeout(timer); };
  }, [apiPrefix]);

  return { health, latency, status, lastSuccessAt };
}

function computeStatus(qrngSource, health, hookStatus) {
  if (qrngSource === "pre-collected") return "pre-collected";
  if (hookStatus === "checking") return "checking";
  if (hookStatus === "offline") return "offline";
  if (typeof health?.buffer_bytes_available === "number" && health.buffer_bytes_available === 0)
    return "degraded";
  return "online";
}

export function AppProvider({ children }) {
  const { health: remoteHealth, latency: remoteLatency, status: remoteHookStatus, lastSuccessAt: remoteLastSuccessAt } = useHysteresisHealth(API_ROUTES.remote);
  const { health: fpgaHealth,   latency: fpgaLatency,   status: fpgaHookStatus,   lastSuccessAt: fpgaLastSuccessAt   } = useHysteresisHealth(API_ROUTES.fpga);

  const [qrngSource, setQrngSourceRaw] = useState(loadSource);
  const [streamError, setStreamError]  = useState(null);
  const [activePage,  setActivePage]   = useState("kapua");

  // Item 4 da auditoria: cursor do fallback pré-coletado, sem wraparound.
  // Vive como estado de módulo em qrngHelper.js (compartilhado por todos os
  // consumidores, não por página) -- aqui só assinamos as mudanças para que
  // o banner global e o indicador da status bar sejam reativos.
  const [precollectedRemainingCount, setPrecollectedRemainingCount] = useState(precollectedRemaining);
  useEffect(() => {
    setPrecollectedRemainingCount(precollectedRemaining());
    return onPrecollectedChange(setPrecollectedRemainingCount);
  }, []);
  const restartPrecollectedDemo = useCallback(() => {
    resetPrecollectedCursor();
  }, []);

  const setQrngSource = useCallback((src) => {
    setQrngSourceRaw(src);
    try { localStorage.setItem(STORAGE_KEY, src); } catch {}
  }, []);

  const health        = qrngSource === "remote" ? remoteHealth        : qrngSource === "fpga" ? fpgaHealth        : null;
  const latency        = qrngSource === "remote" ? remoteLatency       : qrngSource === "fpga" ? fpgaLatency       : null;
  const hookStatus      = qrngSource === "remote" ? remoteHookStatus    : qrngSource === "fpga" ? fpgaHookStatus    : null;
  const lastSuccessAt = qrngSource === "remote" ? remoteLastSuccessAt : qrngSource === "fpga" ? fpgaLastSuccessAt : null;

  const status = computeStatus(qrngSource, health, hookStatus);
  // "checking" conta como online: a 1ª verificação real ainda não terminou,
  // então não há motivo pra travar botões nem mostrar "offline"/fallback.
  // ATENÇÃO (auditoria item 4): isOnline É INTENCIONALMENTE true também para
  // "checking" e "pre-collected" -- é um flag de "seguro habilitar botões/
  // não mostrar banner de erro assustador", não um flag de proveniência dos
  // dados. Ele NÃO diz se os dados vieram de uma fonte QRNG ao vivo. Use
  // isLiveData (abaixo) sempre que a distinção real importar -- geração de
  // chaves/seeds operacionais, avaliação NIST da "amostra atual", ou
  // qualquer alegação de "isto veio do hardware agora".
  const isOnline = status === "online" || status === "pre-collected" || status === "checking";

  // true SOMENTE quando uma checagem de rede real confirmou sucesso.
  // false para "checking" (ainda não confirmado), "pre-collected" (fonte
  // local finita, nunca é "ao vivo"), "degraded" e "offline".
  const isLiveData = status === "online";

  // true quando o usuário selecionou explicitamente a fonte pré-coletada
  // em Configurações — distinto de uma falha de rede que force fallback.
  const isFallbackSelected = qrngSource === "pre-collected";

  const value = useMemo(() => ({
    health,
    latency,
    qrngSource,
    setQrngSource,
    isOnline,
    isLiveData,
    isFallbackSelected,
    lastSuccessAt,
    status,      // "checking" | "online" | "degraded" | "offline" | "pre-collected"
    streamError,
    setStreamError,
    activePage,
    setActivePage,
    remoteHealth,
    remoteLatency,
    fpgaHealth,
    fpgaLatency,
    precollectedLimit: PRECOLLECTED_LIMIT,
    precollectedRemaining: precollectedRemainingCount,
    restartPrecollectedDemo,
    setLatency: () => {
      // kept for backward compat — hysteresis hook manages latency internally
    },
  }), [health, latency, qrngSource, isOnline, isLiveData, isFallbackSelected, lastSuccessAt,
       status, streamError, activePage,
       remoteHealth, remoteLatency, fpgaHealth, fpgaLatency, setQrngSource,
       precollectedRemainingCount, restartPrecollectedDemo]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
