import { useState } from "react";
import { theme, formatBytes } from "../../theme";
import { devGetRequests } from "../../qrngApi";

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

function escapeCell(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function exportCsv(rows) {
  const headers = ["request_id", "endpoint", "bytes", "formato", "status", "ip", "data_utc"];
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.request_id,
        r.endpoint,
        r.bytes_requested,
        r.format ?? "",
        r.status_code,
        r.ip_address ?? "",
        r.created_at,
      ]
        .map(escapeCell)
        .join(",")
    ),
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `qrng-requests-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function RequestLogsTable({ requests }) {
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await devGetRequests(10000);
      if (res.ok) exportCsv(res.data.requests);
    } finally {
      setExporting(false);
    }
  }

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
          Chamadas Recentes
        </span>
        <button
          onClick={handleExport}
          disabled={exporting}
          style={{
            padding: "5px 14px",
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: exporting ? theme.textMuted : theme.textDim,
            fontSize: 10,
            fontWeight: 600,
            fontFamily: mono,
            cursor: exporting ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {exporting ? "Exportando..." : "Exportar CSV"}
        </button>
      </div>

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
