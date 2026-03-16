import { useContext } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext } from "../../contexts/AppContext";

export default function HardwareStatusBar() {
  const { health, latency, isOnline } = useContext(AppContext);
  const statusColor = isOnline ? theme.success : theme.danger;

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
        <img src="/LOGOMARCA_DOBSLIT.PNG" alt="DOBSLIT" style={{ height: 20 }} />
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
          {isOnline ? "Red Pitaya QRNG" : "Dados Pre-coletados"}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, color: theme.textDim }}>
        {isOnline && health && (
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
        {!isOnline && (
          <span style={{ color: theme.warning }}>
            Usando 10K amostras pre-coletadas do Red Pitaya
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
