import { useContext, useState, useCallback } from "react";
import { AppContext, SOURCE_LABELS } from "../../contexts/AppContext";
import { fetchHealth, API_ROUTES } from "../../qrngApi";
import { theme, formatBytes } from "../../theme";
import { QRNG_PRECOLLECTED } from "../../qrngFallbackData";

const SOURCES = [
  {
    key: "remote",
    icon: "\u{1F4E1}",
    title: "Servidor Remoto (SP)",
    desc: "Backend principal via proxy Nginx",
    route: "/api",
  },
  {
    key: "fpga",
    icon: "\u{1F52C}",
    title: "FPGA (Hardware)",
    desc: "Hardware via SSH tunnel reverso",
    route: "/api-fpga",
  },
  {
    key: "pre-collected",
    icon: "\u{1F4BE}",
    title: "Fallback Local",
    desc: "Dados pre-coletados em memoria",
    route: null,
  },
];

function StatusDot({ online }) {
  return (
    <span style={{
      display: "inline-block",
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: online ? theme.success : theme.danger,
      marginRight: 8,
      boxShadow: online ? `0 0 6px ${theme.success}40` : "none",
    }} />
  );
}

function SourceCard({ source, isActive, health, latency, onSelect, onTest }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const isFallback = source.key === "pre-collected";
  const online = isFallback ? true : health !== null;

  const handleTest = useCallback(async () => {
    if (isFallback) return;
    setTesting(true);
    setTestResult(null);
    const prefix = API_ROUTES[source.key];
    const h = await fetchHealth(prefix);
    setTestResult(h ? "ok" : "fail");
    setTesting(false);
  }, [source.key, isFallback]);

  return (
    <div
      onClick={() => onSelect(source.key)}
      style={{
        border: `2px solid ${isActive ? theme.quantum : theme.border}`,
        borderRadius: 12,
        padding: 20,
        background: isActive ? `${theme.quantum}08` : theme.surface,
        cursor: "pointer",
        transition: "all 0.2s",
        position: "relative",
      }}
    >
      {/* Selo "ATIVA" */}
      {isActive && (
        <span style={{
          position: "absolute",
          top: 12,
          right: 12,
          background: theme.quantum,
          color: "#fff",
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: 6,
          fontFamily: "IBM Plex Mono, monospace",
          letterSpacing: 1,
        }}>
          ATIVA
        </span>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 24 }}>{source.icon}</span>
        <div>
          <div style={{
            fontFamily: "Space Grotesk, sans-serif",
            fontWeight: 600,
            fontSize: 16,
            color: theme.text,
          }}>
            {source.title}
          </div>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 12,
            color: theme.textMuted,
          }}>
            {source.desc}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 13,
        color: theme.textDim,
      }}>
        <span>
          <StatusDot online={online} />
          {online ? "Online" : "Offline"}
        </span>

        {!isFallback && source.route && (
          <span style={{ color: theme.textMuted }}>
            Rota: {source.route}
          </span>
        )}

        {!isFallback && latency !== null && (
          <span style={{
            color: latency < 100 ? theme.success : latency < 500 ? theme.warning : theme.danger,
          }}>
            {latency}ms
          </span>
        )}

        {isFallback && (
          <span>{QRNG_PRECOLLECTED.length} bytes disponiveis</span>
        )}
      </div>

      {/* Buffer info */}
      {!isFallback && health && (
        <div style={{
          marginTop: 12,
          display: "flex",
          gap: 16,
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 12,
          color: theme.textMuted,
        }}>
          <span>Buffer: {formatBytes(health.buffer_bytes_available)} / {formatBytes(health.buffer_capacity)}</span>
          <span>Gerado: {formatBytes(health.total_pushed)}</span>
          <span>Consumido: {formatBytes(health.total_popped)}</span>
        </div>
      )}

      {/* Testar conexao */}
      {!isFallback && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={(e) => { e.stopPropagation(); handleTest(); }}
            disabled={testing}
            style={{
              background: "transparent",
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "4px 12px",
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 12,
              color: theme.textDim,
              cursor: testing ? "wait" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {testing ? "Testando..." : "Testar Conexao"}
          </button>
          {testResult && (
            <span style={{
              marginLeft: 10,
              fontSize: 12,
              fontFamily: "IBM Plex Mono, monospace",
              color: testResult === "ok" ? theme.success : theme.danger,
            }}>
              {testResult === "ok" ? "Conectado!" : "Falhou"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function SettingsSection() {
  const {
    qrngSource, setQrngSource,
    remoteHealth, remoteLatency,
    fpgaHealth, fpgaLatency,
  } = useContext(AppContext);

  const getHealth = (key) => {
    if (key === "remote") return remoteHealth;
    if (key === "fpga") return fpgaHealth;
    return null;
  };

  const getLatency = (key) => {
    if (key === "remote") return remoteLatency;
    if (key === "fpga") return fpgaLatency;
    return null;
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{
          fontFamily: "Space Grotesk, sans-serif",
          fontWeight: 700,
          fontSize: 24,
          color: theme.text,
          margin: 0,
        }}>
          Configuracoes
        </h2>
        <p style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 13,
          color: theme.textMuted,
          margin: "6px 0 0",
        }}>
          Selecione a fonte de dados QRNG utilizada nas analises e visualizacoes.
        </p>
      </div>

      {/* Fonte ativa label */}
      <div style={{
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 12,
        color: theme.textMuted,
        marginBottom: 12,
        textTransform: "uppercase",
        letterSpacing: 1,
      }}>
        Fonte ativa: <span style={{ color: theme.quantum, fontWeight: 600 }}>
          {SOURCE_LABELS[qrngSource]}
        </span>
      </div>

      {/* Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {SOURCES.map((src) => (
          <SourceCard
            key={src.key}
            source={src}
            isActive={qrngSource === src.key}
            health={getHealth(src.key)}
            latency={getLatency(src.key)}
            onSelect={setQrngSource}
          />
        ))}
      </div>

      {/* Info box */}
      <div style={{
        marginTop: 24,
        padding: 16,
        background: theme.surfaceAlt,
        borderRadius: 8,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 12,
        color: theme.textMuted,
        lineHeight: 1.6,
      }}>
        <strong style={{ color: theme.textDim }}>Como funciona:</strong>
        <br />
        A fonte <strong>Remota</strong> conecta ao backend em SP via proxy Nginx.
        <br />
        A fonte <strong>FPGA</strong> conecta ao hardware via SSH tunnel reverso (porta 18002).
        <br />
        O <strong>Fallback</strong> usa {QRNG_PRECOLLECTED.length} bytes pre-coletados que funcionam offline.
        <br />
        Se a fonte ativa ficar offline, o app usa automaticamente o fallback.
      </div>
    </div>
  );
}
