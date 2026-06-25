import { theme, formatBytes } from "../../theme";

const mono = "'IBM Plex Mono', monospace";

function StatusBadge({ code }) {
  const ok = code < 400;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        fontFamily: mono,
        padding: "2px 8px",
        borderRadius: 12,
        background: ok ? theme.success + "18" : theme.danger + "18",
        color: ok ? theme.success : theme.danger,
        border: `1px solid ${ok ? theme.success + "40" : theme.danger + "40"}`,
      }}
    >
      {code}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function RequestLogsTable({ requests }) {
  if (!requests || requests.length === 0) {
    return (
      <div
        style={{
          background: theme.surface,
          borderRadius: 12,
          border: `1px solid ${theme.border}`,
          padding: "20px 22px",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
          Chamadas Recentes
        </span>
        <div
          style={{
            marginTop: 16,
            padding: "20px",
            textAlign: "center",
            color: theme.textMuted,
            fontSize: 12,
            fontFamily: mono,
            border: `1.5px dashed ${theme.border}`,
            borderRadius: 8,
          }}
        >
          Nenhuma chamada registrada ainda.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: theme.surface,
        borderRadius: 12,
        border: `1px solid ${theme.border}`,
        padding: "20px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
        Chamadas Recentes
      </span>

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 11,
            fontFamily: mono,
          }}
        >
          <thead>
            <tr>
              {["request_id", "endpoint", "bytes", "formato", "status", "data"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    color: theme.textMuted,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontSize: 10,
                    borderBottom: `1px solid ${theme.border}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map((r, i) => (
              <tr
                key={r.request_id}
                style={{
                  background: i % 2 === 0 ? "transparent" : theme.surfaceAlt,
                }}
              >
                <td style={{ padding: "7px 10px", color: theme.textDim, whiteSpace: "nowrap" }}>
                  {r.request_id}
                </td>
                <td style={{ padding: "7px 10px", color: theme.text, whiteSpace: "nowrap" }}>
                  {r.endpoint || "-"}
                </td>
                <td style={{ padding: "7px 10px", color: theme.textDim, whiteSpace: "nowrap" }}>
                  {r.bytes_requested > 0 ? formatBytes(r.bytes_requested) : "-"}
                </td>
                <td style={{ padding: "7px 10px", color: theme.textDim }}>
                  {r.format || "-"}
                </td>
                <td style={{ padding: "7px 10px" }}>
                  <StatusBadge code={r.status_code} />
                </td>
                <td style={{ padding: "7px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>
                  {formatDate(r.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
