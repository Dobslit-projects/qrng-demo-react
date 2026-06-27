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

function QuotaBar({ used, total, label, formatValue }) {
  const pct   = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color = pct >= 90 ? theme.danger : pct >= 70 ? theme.warning : theme.success;
  const fmt   = formatValue || ((v) => v.toLocaleString("pt-BR"));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: theme.textDim, fontFamily: mono }}>
          {label} — {fmt(used)} / {fmt(total)}
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
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
          {fmt(Math.max(0, total - used))} restantes hoje
        </span>
      </div>
    </div>
  );
}

export default function UsageCard({ usage }) {
  if (!usage) return null;

  const {
    quota_daily_requests,
    quota_daily_bytes,
    max_bytes_per_request,
    requests_today,
    bytes_today,
    remaining_requests_today,
    remaining_bytes_today,
    requests_7d,
    bytes_7d,
    requests_30d,
    bytes_30d,
    last_used_at,
  } = usage;

  // Compatibilidade com resposta antiga (sem quota_daily_requests)
  const quotaReqs  = quota_daily_requests  ?? usage.quota_daily ?? 10000;
  const quotaBytes = quota_daily_bytes     ?? 104857600;
  const remReqs    = remaining_requests_today ?? Math.max(0, quotaReqs - (requests_today || 0));
  const remBytes   = remaining_bytes_today    ?? Math.max(0, quotaBytes - (bytes_today || 0));

  return (
    <div style={card}>
      <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
        Uso do Token
      </span>

      {/* Stats de hoje */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatBox label="Requests hoje" value={(requests_today || 0).toLocaleString("pt-BR")} />
        <StatBox label="Bytes hoje"    value={formatBytes(bytes_today || 0)} />
        <StatBox label="Requests 7d"   value={(requests_7d || 0).toLocaleString("pt-BR")} sub={formatBytes(bytes_7d || 0)} />
        <StatBox label="Requests 30d"  value={(requests_30d || 0).toLocaleString("pt-BR")} sub={formatBytes(bytes_30d || 0)} />
      </div>

      {/* Barra de cota de requests */}
      <QuotaBar
        label="Cota diária — requests"
        used={requests_today || 0}
        total={quotaReqs}
      />

      {/* Barra de cota de bytes */}
      <QuotaBar
        label="Cota diária — bytes"
        used={bytes_today || 0}
        total={quotaBytes}
        formatValue={formatBytes}
      />

      {/* Info adicional */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", paddingTop: 4, borderTop: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
          Limite por req: {formatBytes(max_bytes_per_request || 1048576)}
        </span>
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
          Restam hoje: {remReqs.toLocaleString("pt-BR")} req · {formatBytes(remBytes)}
        </span>
        {last_used_at && (
          <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
            Último uso: {new Date(last_used_at).toLocaleString("pt-BR")}
          </span>
        )}
      </div>
    </div>
  );
}
