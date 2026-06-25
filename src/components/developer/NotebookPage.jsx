import { useState, useCallback, useRef } from "react";
import { theme } from "../../theme";
import { CLIENT_API } from "../../qrngApi";

const mono = "'IBM Plex Mono', monospace";

// ── Endpoints disponíveis ────────────────────────────────────────────────────

const ENDPOINTS = [
  {
    id: "random",
    method: "GET",
    path: "/random",
    label: "GET /v1/random — Bytes aleatórios",
    params: [
      { key: "bytes",  type: "number", default: 32,    label: "Bytes", min: 1, max: 4096 },
      { key: "format", type: "select", default: "hex", label: "Formato", options: ["hex", "base64", "uint8"] },
    ],
  },
  {
    id: "health",
    method: "GET",
    path: "/health",
    label: "GET /v1/health — Status do QRNG",
    params: [],
  },
  {
    id: "me_token",
    method: "GET",
    path: "/me/token",
    label: "GET /v1/me/token — Informações do token",
    params: [],
  },
  {
    id: "me_usage",
    method: "GET",
    path: "/me/usage",
    label: "GET /v1/me/usage — Estatísticas de uso",
    params: [],
  },
  {
    id: "me_requests",
    method: "GET",
    path: "/me/requests",
    label: "GET /v1/me/requests — Histórico de chamadas",
    params: [
      { key: "limit", type: "number", default: 10, label: "Limite", min: 1, max: 100 },
    ],
  },
];

let nextId = 2;

function makeCell(endpointId = "random") {
  const ep = ENDPOINTS.find((e) => e.id === endpointId) || ENDPOINTS[0];
  const params = Object.fromEntries(ep.params.map((p) => [p.key, p.default]));
  return { id: nextId++, endpointId, params, response: null, status: "idle", ms: null, executedAt: null };
}

// ── Célula individual ────────────────────────────────────────────────────────

function Cell({ cell, onChange, onRun, onRemove, canRemove }) {
  const ep = ENDPOINTS.find((e) => e.id === cell.endpointId);
  const [copied, setCopied] = useState(false);

  function buildUrl() {
    const qs = ep.params.length > 0
      ? "?" + ep.params.map((p) => `${p.key}=${cell.params[p.key] ?? p.default}`).join("&")
      : "";
    return `${CLIENT_API}${ep.path}${qs}`;
  }

  async function handleCopy() {
    const token = localStorage.getItem("qrng_api_token") || "SEU_TOKEN";
    const curl = `curl -s "${window.location.origin}${CLIENT_API}${ep.path}${
      ep.params.length > 0
        ? "?" + ep.params.map((p) => `${p.key}=${cell.params[p.key] ?? p.default}`).join("&")
        : ""
    }" -H "Authorization: Bearer ${token}"`;
    await navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const statusColor =
    cell.status === "running" ? theme.warning
    : cell.status === "ok"    ? theme.success
    : cell.status === "error" ? theme.danger
    : theme.textMuted;

  const statusLabel =
    cell.status === "running" ? "Executando..."
    : cell.status === "ok"    ? `200 OK · ${cell.ms}ms`
    : cell.status === "error" ? `Erro · ${cell.ms}ms`
    : "Não executado";

  return (
    <div
      style={{
        background: theme.surface,
        borderRadius: 12,
        border: `1px solid ${cell.status === "ok" ? theme.success + "40" : cell.status === "error" ? theme.danger + "40" : theme.border}`,
        overflow: "hidden",
        transition: "border-color 0.2s",
      }}
    >
      {/* Header da célula */}
      <div
        style={{
          padding: "10px 16px",
          background: theme.surfaceAlt,
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {/* Selector de endpoint */}
        <select
          value={cell.endpointId}
          onChange={(e) => onChange(cell.id, "endpointId", e.target.value)}
          style={{
            flex: 1,
            minWidth: 200,
            padding: "5px 10px",
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: theme.surface,
            color: theme.text,
            fontSize: 11,
            fontFamily: mono,
            cursor: "pointer",
          }}
        >
          {ENDPOINTS.map((e) => (
            <option key={e.id} value={e.id}>{e.label}</option>
          ))}
        </select>

        {/* Parâmetros */}
        {ep.params.map((p) => (
          <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{p.label}:</span>
            {p.type === "select" ? (
              <select
                value={cell.params[p.key] ?? p.default}
                onChange={(e) => onChange(cell.id, "param", p.key, e.target.value)}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: theme.text,
                  fontSize: 11,
                  fontFamily: mono,
                }}
              >
                {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type="number"
                min={p.min}
                max={p.max}
                value={cell.params[p.key] ?? p.default}
                onChange={(e) => onChange(cell.id, "param", p.key, Number(e.target.value))}
                style={{
                  width: 70,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: theme.text,
                  fontSize: 11,
                  fontFamily: mono,
                  textAlign: "right",
                }}
              />
            )}
          </div>
        ))}

        {/* Ações */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: statusColor, fontFamily: mono, whiteSpace: "nowrap" }}>
            {statusLabel}
          </span>
          <button
            onClick={handleCopy}
            title="Copiar como curl"
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${theme.border}`,
              background: "transparent",
              color: copied ? theme.success : theme.textMuted,
              fontSize: 10,
              fontFamily: mono,
              cursor: "pointer",
            }}
          >
            {copied ? "✓ curl" : "curl"}
          </button>
          <button
            onClick={() => onRun(cell.id)}
            disabled={cell.status === "running"}
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              background: cell.status === "running" ? theme.quantum + "40" : theme.quantum,
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: mono,
              cursor: cell.status === "running" ? "default" : "pointer",
            }}
          >
            {cell.status === "running" ? "..." : "▶ Run"}
          </button>
          {canRemove && (
            <button
              onClick={() => onRemove(cell.id)}
              title="Remover célula"
              style={{
                padding: "4px 8px",
                borderRadius: 6,
                border: `1px solid ${theme.danger}30`,
                background: "transparent",
                color: theme.danger,
                fontSize: 11,
                fontFamily: mono,
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* URL da chamada */}
      <div
        style={{
          padding: "6px 16px",
          background: "#0a0e17",
          borderBottom: `1px solid ${theme.border}`,
          fontSize: 10,
          color: theme.quantum + "90",
          fontFamily: mono,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: theme.textMuted }}>$ </span>
        {buildUrl()}
      </div>

      {/* Resposta */}
      {cell.response !== null && (
        <div
          style={{
            padding: "14px 16px",
            background: "#0a0e17",
            fontFamily: mono,
            fontSize: 12,
            color: cell.status === "error" ? theme.danger : "#e2e8f0",
            overflowX: "auto",
            maxHeight: 320,
            overflowY: "auto",
            lineHeight: 1.7,
            whiteSpace: "pre",
          }}
        >
          {typeof cell.response === "string"
            ? cell.response
            : JSON.stringify(cell.response, null, 2)}
        </div>
      )}

      {cell.response === null && cell.status === "idle" && (
        <div
          style={{
            padding: "20px 16px",
            background: "#0a0e17",
            fontFamily: mono,
            fontSize: 11,
            color: theme.textMuted,
            textAlign: "center",
          }}
        >
          Pressione ▶ Run para executar
        </div>
      )}
    </div>
  );
}

// ── NotebookPage ─────────────────────────────────────────────────────────────

export default function NotebookPage() {
  const [cells, setCells] = useState([
    { id: 1, endpointId: "random", params: { bytes: 32, format: "hex" }, response: null, status: "idle", ms: null, executedAt: null },
  ]);
  const [tokenInput, setTokenInput] = useState(localStorage.getItem("qrng_api_token") || "");
  const [runningAll, setRunningAll] = useState(false);

  const token = tokenInput.trim() || localStorage.getItem("qrng_api_token") || "";

  function handleChange(id, field, key, value) {
    setCells((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (field === "endpointId") {
          const ep = ENDPOINTS.find((e) => e.id === key) || ENDPOINTS[0];
          const params = Object.fromEntries(ep.params.map((p) => [p.key, p.default]));
          return { ...c, endpointId: key, params, response: null, status: "idle", ms: null };
        }
        if (field === "param") {
          return { ...c, params: { ...c.params, [key]: value } };
        }
        return c;
      })
    );
  }

  const runCell = useCallback(async (id) => {
    const cell = cells.find((c) => c.id === id);
    if (!cell) return;
    const ep = ENDPOINTS.find((e) => e.id === cell.endpointId);

    const qs = ep.params.length > 0
      ? "?" + ep.params.map((p) => `${p.key}=${cell.params[p.key] ?? p.default}`).join("&")
      : "";
    const url = `${CLIENT_API}${ep.path}${qs}`;

    setCells((prev) => prev.map((c) => c.id === id ? { ...c, status: "running", response: null } : c));

    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      const ms = Math.round(performance.now() - t0);
      let data;
      try { data = await res.json(); } catch { data = await res.text(); }
      setCells((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, status: res.ok ? "ok" : "error", response: data, ms, executedAt: new Date().toISOString() }
            : c
        )
      );
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      setCells((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, status: "error", response: { error: err.message }, ms, executedAt: new Date().toISOString() }
            : c
        )
      );
    }
  }, [cells, token]);

  async function runAll() {
    setRunningAll(true);
    for (const cell of cells) {
      await runCell(cell.id);
    }
    setRunningAll(false);
  }

  function addCell() {
    setCells((prev) => [...prev, makeCell("random")]);
  }

  function removeCell(id) {
    setCells((prev) => prev.filter((c) => c.id !== id));
  }

  function clearAll() {
    setCells((prev) => prev.map((c) => ({ ...c, response: null, status: "idle", ms: null })));
  }

  const hasToken = !!token;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Token bar */}
      <div
        style={{
          background: theme.surface,
          borderRadius: 10,
          border: `1px solid ${hasToken ? theme.success + "40" : theme.warning + "40"}`,
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, whiteSpace: "nowrap" }}>
          Token:
        </span>
        <input
          type="password"
          placeholder="dobslit_qrng_live_... (ou deixe em branco para usar o do localStorage)"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          style={{
            flex: 1,
            minWidth: 200,
            padding: "5px 10px",
            borderRadius: 7,
            border: `1px solid ${theme.border}`,
            background: "#0a0e17",
            color: theme.quantum,
            fontSize: 11,
            fontFamily: mono,
            outline: "none",
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: mono,
            padding: "3px 10px",
            borderRadius: 12,
            background: hasToken ? theme.success + "14" : theme.warning + "14",
            color: hasToken ? theme.success : theme.warning,
            border: `1px solid ${hasToken ? theme.success + "40" : theme.warning + "40"}`,
            whiteSpace: "nowrap",
          }}
        >
          {hasToken ? "● Token pronto" : "⚠ Sem token"}
        </span>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={addCell}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: `1.5px solid ${theme.quantum}`,
            background: theme.quantum + "12",
            color: theme.quantum,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: mono,
            cursor: "pointer",
          }}
        >
          + Nova Célula
        </button>
        <button
          onClick={runAll}
          disabled={runningAll}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: "none",
            background: runningAll ? theme.success + "40" : theme.success,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: mono,
            cursor: runningAll ? "default" : "pointer",
          }}
        >
          {runningAll ? "Executando..." : "▶▶ Executar Todas"}
        </button>
        <button
          onClick={clearAll}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.textMuted,
            fontSize: 11,
            fontFamily: mono,
            cursor: "pointer",
          }}
        >
          Limpar resultados
        </button>
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, marginLeft: "auto" }}>
          {cells.length} {cells.length === 1 ? "célula" : "células"}
          {" · "}
          {cells.filter((c) => c.status === "ok").length} OK
          {cells.filter((c) => c.status === "error").length > 0 && (
            <span style={{ color: theme.danger }}>
              {" · "}{cells.filter((c) => c.status === "error").length} erro
            </span>
          )}
        </span>
      </div>

      {/* Células */}
      {cells.map((cell) => (
        <Cell
          key={cell.id}
          cell={cell}
          onChange={handleChange}
          onRun={runCell}
          onRemove={removeCell}
          canRemove={cells.length > 1}
        />
      ))}

      {/* Rodapé */}
      <div
        style={{
          padding: "10px 14px",
          borderRadius: 8,
          background: theme.quantum + "06",
          border: `1px solid ${theme.quantum}20`,
          fontSize: 10,
          color: theme.textMuted,
          fontFamily: mono,
          lineHeight: 1.7,
        }}
      >
        Todas as chamadas vão para{" "}
        <span style={{ color: theme.quantum }}>bongo.vps-uni5.net/qrng/v1</span>
        {" "}com seu token Bearer.
        O botão <strong style={{ color: theme.textDim }}>curl</strong> copia o comando equivalente para o terminal.
      </div>
    </div>
  );
}
