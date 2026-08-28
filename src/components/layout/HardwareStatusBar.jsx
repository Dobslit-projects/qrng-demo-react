import { useContext, useState } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext, SOURCE_LABELS } from "../../contexts/AppContext";

function LogoImg({ height }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: height * 0.7,
        color: theme.quantum,
        letterSpacing: "0.08em",
      }}>
        DOBSLIT
      </span>
    );
  }
  return (
    <img
      src="/LOGOMARCA_DOBSLIT.PNG"
      alt="DOBSLIT"
      style={{ height }}
      onError={() => setBroken(true)}
    />
  );
}

// Item 3: origem EFETIVA da última leitura, nunca a config estática da
// instância. Prioridade: provenance_detail.actual_origin (contrato por
// resposta do client-api) > provenance simples > derivada do health.
function effectiveOrigin({ isFallback, isOnline, health }) {
  if (isFallback) return { label: "fallback", color: theme.warning, verified: false };
  const d = health?.provenance_detail;
  if (d?.actual_origin) {
    return {
      label: d.actual_origin,
      color: d.actual_origin === "live" ? theme.success
           : d.actual_origin === "fallback" ? theme.warning
           : theme.textMuted,
      verified: !!d.live_verified,
    };
  }
  const p = health?.provenance;
  if (p) return { label: p, color: p === "live" ? theme.success : theme.textMuted, verified: false };
  // sem contrato de proveniência disponível nesta rota de health
  if (!isOnline) return { label: "indisponível", color: theme.danger, verified: false };
  return { label: "desconhecida", color: theme.textMuted, verified: false };
}

export default function HardwareStatusBar() {
  const { health, latency, isOnline, qrngSource, precollectedRemaining, precollectedLimit } = useContext(AppContext);
  const isFallback = qrngSource === "pre-collected";
  const statusColor = isOnline ? theme.success : theme.danger;
  const origin = effectiveOrigin({ isFallback, isOnline, health });

  return (
    <div
      style={{
        background: theme.surface,
        borderBottom: `1px solid ${theme.border}`,
        padding: "8px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <LogoImg height={20} />
        <div style={{ width: 1, height: 16, background: theme.border }} />
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor,
            boxShadow: `0 0 6px ${statusColor}80`,
          }}
        />
        <span style={{ color: statusColor, fontWeight: 600 }}>
          {isOnline ? "ONLINE" : "OFFLINE"}
        </span>
        <span style={{ color: theme.textMuted }}>
          {SOURCE_LABELS[qrngSource] || qrngSource}
        </span>
        <span style={{ color: theme.border }}>|</span>
        <span style={{ color: theme.textMuted }} data-testid="effective-origin">
          origem&nbsp;efetiva:{" "}
          <strong style={{ color: origin.color }}>{origin.label}</strong>
          {origin.label === "live" && !origin.verified && (
            <span style={{ color: theme.warning }}>&nbsp;(não verificada)</span>
          )}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, color: theme.textDim }}>
        {!isFallback && isOnline && health && (
          <>
            <span>
              Buffer: <strong style={{ color: theme.text }}>{formatBytes(health.buffer_bytes_available)}</strong>
              {" / "}{formatBytes(health.buffer_capacity)}
            </span>
            <span style={{ color: theme.border }}>|</span>
            <span>
              Gerado: <strong style={{ color: theme.text }}>{formatBytes(health.total_pushed)}</strong>
            </span>
            <span style={{ color: theme.border }}>|</span>
            <span>
              Consumido: <strong style={{ color: theme.text }}>{formatBytes(health.total_popped)}</strong>
            </span>
          </>
        )}
        {isFallback && (
          <span style={{ color: theme.warning }}>
            Pré-coletado: {formatBytes(precollectedRemaining)} restantes de {formatBytes(precollectedLimit)}
          </span>
        )}
        {!isFallback && !isOnline && (
          <span style={{ color: theme.warning }}>
            Fonte indisponivel — fallback ativo
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {latency !== null ? (
          <>
            <span style={{ color: theme.textMuted }}>Latencia:</span>
            <strong style={{ color: latency < 100 ? theme.success : latency < 500 ? theme.warning : theme.danger }}>
              {latency}ms
            </strong>
          </>
        ) : (
          <span style={{ color: theme.textMuted }}>--</span>
        )}
      </div>
    </div>
  );
}
