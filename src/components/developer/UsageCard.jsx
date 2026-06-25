import { theme, formatBytes } from "../../theme";

const mono = "'IBM Plex Mono', monospace";

const card = {
  background: theme.surface,
  borderRadius: 12,
  border: `1px solid ${theme.border}`,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

function StatBox({ label, value, sub }) {
  return (
    <div
      style={{
        flex: "1 1 120px",
        minWidth: 110,
        background: theme.surfaceAlt,
        borderRadius: 10,
        border: `1px solid ${theme.border}`,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span style={{ fontSize: 22, fontWeight: 700, color: theme.quantum, fontFamily: mono, lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      {sub && (
        <span style={{ fontSize: 10, color: theme.textDim, fontFamily: mono }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function QuotaBar({ used, total }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color = pct >= 90 ? theme.danger : pct >= 70 ? theme.warning : theme.success;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: theme.textDim, fontFamily: mono }}>
          Cota diária — {used.toLocaleString("pt-BR")} / {total.toLocaleString("pt-BR")} requests
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: mono }}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: theme.surfaceAlt,
          border: `1px solid ${theme.border}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            borderRadius: 3,
            transition: "width 0.4s ease",
          }}
        />
      </div>
    </div>
  );
}

export default function UsageCard({ usage }) {
  if (!usage) return null;

  const {
    quota_daily,
    requests_today,
    bytes_today,
    requests_7d,
    bytes_7d,
    requests_30d,
    bytes_30d,
    last_used_at,
  } = usage;

  return (
    <div style={card}>
      <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
        Uso do Token
      </span>

      {/* Stats hoje */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatBox
          label="Requests hoje"
          value={requests_today.toLocaleString("pt-BR")}
        />
        <StatBox
          label="Bytes hoje"
          value={formatBytes(bytes_today)}
        />
        <StatBox
          label="Requests 7 dias"
          value={requests_7d.toLocaleString("pt-BR")}
          sub={formatBytes(bytes_7d)}
        />
        <StatBox
          label="Requests 30 dias"
          value={requests_30d.toLocaleString("pt-BR")}
          sub={formatBytes(bytes_30d)}
        />
      </div>

      {/* Barra de cota */}
      <QuotaBar used={requests_today} total={quota_daily} />

      {/* Último uso */}
      {last_used_at && (
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
          Última chamada: {new Date(last_used_at).toLocaleString("pt-BR")}
        </span>
      )}
    </div>
  );
}
