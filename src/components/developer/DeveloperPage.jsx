import { useState, useEffect, useCallback } from "react";
import { theme } from "../../theme";
import { devGetToken, devGetUsage, devGetRequests } from "../../qrngApi";
import TokenCard from "./TokenCard";
import UsageCard from "./UsageCard";
import RequestLogsTable from "./RequestLogsTable";
import NotebookPage from "./NotebookPage";

const mono = "'IBM Plex Mono', monospace";

const TABS = [
  { id: "token",    label: "Token" },
  { id: "notebook", label: "Notebook" },
  { id: "uso",      label: "Uso" },
  { id: "logs",     label: "Chamadas" },
  { id: "docs",     label: "Docs" },
];

const BASE_URL = "https://bongo.vps-uni5.net/qrng/v1";

function DocsCard() {
  const [copied, setCopied] = useState(null);
  const token = localStorage.getItem("qrng_api_token") || "SEU_TOKEN";

  const examples = [
    {
      id: "random",
      label: "Gerar bytes aleatórios (hex)",
      code: `curl "${BASE_URL}/random?bytes=32&format=hex" \\\n  -H "Authorization: Bearer ${token}"`,
    },
    {
      id: "base64",
      label: "Gerar bytes aleatórios (base64)",
      code: `curl "${BASE_URL}/random?bytes=64&format=base64" \\\n  -H "Authorization: Bearer ${token}"`,
    },
    {
      id: "health",
      label: "Status do QRNG",
      code: `curl "${BASE_URL}/health" \\\n  -H "Authorization: Bearer ${token}"`,
    },
    {
      id: "usage",
      label: "Consultar uso do token",
      code: `curl "${BASE_URL}/me/usage" \\\n  -H "Authorization: Bearer ${token}"`,
    },
  ];

  async function copy(id, text) {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Endpoints */}
      <div
        style={{
          background: theme.surface,
          borderRadius: 12,
          border: `1px solid ${theme.border}`,
          padding: "20px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
          Endpoints disponíveis
        </span>

        {[
          ["GET", "/v1/random", "?bytes=N&format=hex|base64|uint8", "Bytes aleatórios (máx. 4096)"],
          ["GET", "/v1/health", "", "Status do QRNG upstream"],
          ["GET", "/v1/me/token", "", "Informações do seu token"],
          ["GET", "/v1/me/usage", "", "Estatísticas de uso"],
          ["GET", "/v1/me/requests", "?limit=20", "Histórico de chamadas"],
          ["POST", "/v1/me/token/rotate", "", "Regenerar token"],
          ["POST", "/v1/me/token/revoke", "", "Revogar token"],
        ].map(([method, path, params, desc]) => (
          <div
            key={path + method}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              flexWrap: "wrap",
              paddingBottom: 10,
              borderBottom: `1px solid ${theme.border}`,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: mono,
                padding: "2px 8px",
                borderRadius: 6,
                background: method === "GET" ? theme.quantum + "14" : theme.accent + "14",
                color: method === "GET" ? theme.quantum : theme.accent,
                border: `1px solid ${method === "GET" ? theme.quantum + "40" : theme.accent + "40"}`,
                whiteSpace: "nowrap",
              }}
            >
              {method}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontFamily: mono, color: theme.text }}>
                {path}
                {params && (
                  <span style={{ color: theme.textMuted }}>{params}</span>
                )}
              </span>
              <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Exemplos curl */}
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
          Exemplos de uso
        </span>

        {examples.map((ex) => (
          <div key={ex.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11, color: theme.textDim, fontFamily: mono }}>
              {ex.label}
            </span>
            <div style={{ position: "relative" }}>
              <pre
                style={{
                  margin: 0,
                  background: "#0a0e17",
                  borderRadius: 8,
                  border: `1px solid ${theme.border}`,
                  padding: "12px 14px",
                  fontSize: 11,
                  fontFamily: mono,
                  color: theme.quantum,
                  overflowX: "auto",
                  lineHeight: 1.7,
                }}
              >
                {ex.code}
              </pre>
              <button
                onClick={() => copy(ex.id, ex.code)}
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  padding: "3px 10px",
                  borderRadius: 6,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: copied === ex.id ? theme.success : theme.textDim,
                  fontSize: 10,
                  fontFamily: mono,
                  cursor: "pointer",
                }}
              >
                {copied === ex.id ? "Copiado!" : "Copiar"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Auth info */}
      <div
        style={{
          background: theme.quantum + "08",
          borderRadius: 10,
          border: `1px solid ${theme.quantum}30`,
          padding: "14px 18px",
          fontSize: 11,
          color: theme.textDim,
          fontFamily: mono,
          lineHeight: 1.7,
        }}
      >
        <strong style={{ color: theme.quantum }}>Autenticação:</strong> Todas as chamadas exigem o header{" "}
        <code style={{ color: theme.quantum, background: theme.quantum + "14", padding: "1px 6px", borderRadius: 4 }}>
          Authorization: Bearer &lt;seu_token&gt;
        </code>
        . O token não expira, mas pode ser revogado a qualquer momento na aba Token.
      </div>
    </div>
  );
}

export default function DeveloperPage() {
  const [activeTab, setActiveTab] = useState("token");
  const [tokenInfo, setTokenInfo] = useState(null);
  const [usage, setUsage] = useState(null);
  const [requests, setRequests] = useState(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(null);

  const hasStoredToken = !!localStorage.getItem("qrng_api_token");

  const loadToken = useCallback(async () => {
    if (!localStorage.getItem("qrng_api_token")) {
      setTokenInfo(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setApiError(null);
    try {
      const res = await devGetToken();
      if (res.ok) {
        setTokenInfo(res.data);
      } else if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("qrng_api_token");
        setTokenInfo(null);
      } else {
        setApiError("Não foi possível carregar informações do token.");
      }
    } catch {
      setApiError("Servidor de tokens indisponível.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    if (!localStorage.getItem("qrng_api_token")) return;
    try {
      const res = await devGetUsage();
      if (res.ok) setUsage(res.data);
    } catch {}
  }, []);

  const loadRequests = useCallback(async () => {
    if (!localStorage.getItem("qrng_api_token")) return;
    try {
      const res = await devGetRequests(20);
      if (res.ok) setRequests(res.data.requests);
    } catch {}
  }, []);

  useEffect(() => {
    loadToken();
  }, [loadToken]);

  useEffect(() => {
    if (activeTab === "uso") loadUsage();
    if (activeTab === "logs") loadRequests();
  }, [activeTab, loadUsage, loadRequests]);

  const [quotaBannerDismissed, setQuotaBannerDismissed] = useState(false);

  function handleTokenChange() {
    setUsage(null);
    setRequests(null);
    setQuotaBannerDismissed(false);
    loadToken();
  }

  const quotaPct = tokenInfo
    ? tokenInfo.requests_today / tokenInfo.quota_daily
    : 0;
  const showQuotaBanner = !quotaBannerDismissed && tokenInfo && quotaPct >= 0.8;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Header */}
      <div
        style={{
          background: theme.surface,
          borderRadius: 12,
          border: `1px solid ${theme.border}`,
          padding: "18px 22px",
          marginBottom: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, fontFamily: mono }}>
              QRNG API — Área do Desenvolvedor
            </div>
            <div style={{ fontSize: 11, color: theme.textDim, marginTop: 3 }}>
              Acesso autenticado à aleatoriedade quântica — Dobslit / UFPE / FPGA
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: mono,
                padding: "4px 12px",
                borderRadius: 20,
                background: theme.success + "14",
                color: theme.success,
                border: `1px solid ${theme.success}40`,
              }}
            >
              ● Fonte: FPGA
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                fontFamily: mono,
                padding: "4px 12px",
                borderRadius: 20,
                background: theme.quantum + "10",
                color: theme.quantum,
                border: `1px solid ${theme.quantum}30`,
              }}
            >
              v1 API
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 12,
          flexShrink: 0,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: "none",
              background: activeTab === t.id ? theme.surface : "transparent",
              color: activeTab === t.id ? theme.text : theme.textMuted,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: mono,
              cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: activeTab === t.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              border: activeTab === t.id ? `1px solid ${theme.border}` : "1px solid transparent",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Conteúdo */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {showQuotaBanner && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 16px",
              borderRadius: 10,
              background: quotaPct >= 0.95 ? theme.danger + "12" : theme.warning + "12",
              border: `1px solid ${quotaPct >= 0.95 ? theme.danger + "40" : theme.warning + "40"}`,
              fontSize: 11,
              color: quotaPct >= 0.95 ? theme.danger : theme.warning,
              fontFamily: mono,
              marginBottom: 12,
              flexShrink: 0,
            }}
          >
            <span>
              {quotaPct >= 0.95
                ? `Cota quase esgotada — ${tokenInfo.requests_today}/${tokenInfo.quota_daily} req hoje (${Math.round(quotaPct * 100)}%). Resetará à meia-noite UTC.`
                : `Atenção: ${Math.round(quotaPct * 100)}% da cota diária utilizada (${tokenInfo.requests_today}/${tokenInfo.quota_daily} req).`}
            </span>
            <button
              onClick={() => setQuotaBannerDismissed(true)}
              style={{
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                padding: "0 2px",
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        )}

        {apiError && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: theme.danger + "10",
              border: `1px solid ${theme.danger}30`,
              fontSize: 12,
              color: theme.danger,
              fontFamily: mono,
              marginBottom: 12,
            }}
          >
            {apiError}
          </div>
        )}

        {loading && (
          <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
            Carregando...
          </div>
        )}

        {!loading && activeTab === "token" && (
          <TokenCard
            tokenInfo={tokenInfo}
            onTokenChange={handleTokenChange}
          />
        )}

        {activeTab === "notebook" && <NotebookPage />}

        {!loading && activeTab === "uso" && (
          tokenInfo ? (
            usage ? (
              <UsageCard usage={usage} />
            ) : (
              <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
                Carregando estatísticas...
              </div>
            )
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
              Gere um token primeiro na aba Token.
            </div>
          )
        )}

        {!loading && activeTab === "logs" && (
          tokenInfo ? (
            requests !== null ? (
              <RequestLogsTable requests={requests} />
            ) : (
              <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
                Carregando chamadas...
              </div>
            )
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
              Gere um token primeiro na aba Token.
            </div>
          )
        )}

        {activeTab === "docs" && <DocsCard />}
      </div>
    </div>
  );
}
