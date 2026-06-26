import { useState } from "react";
import { theme } from "../../theme";
import { devCreateToken, devRotateToken, devRevokeToken } from "../../qrngApi";

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

function ActionBtn({ onClick, color, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "7px 14px",
        borderRadius: 8,
        border: `1.5px solid ${color}`,
        background: disabled ? "transparent" : color + "14",
        color: disabled ? theme.textMuted : color,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: mono,
        cursor: disabled ? "default" : "pointer",
        transition: "all 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

export default function TokenCard({ tokenInfo, onTokenChange }) {
  const [showFull, setShowFull] = useState(false);
  const [newToken, setNewToken] = useState(null); // token completo exibido uma única vez
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const hasToken = !!tokenInfo;
  const isActive = tokenInfo?.status === "active";

  async function handleCreate() {
    setLoading(true);
    setError(null);
    try {
      const res = await devCreateToken();
      if (res.ok) {
        localStorage.setItem("qrng_api_token", res.data.token);
        setNewToken(res.data.token);
        onTokenChange();
      } else {
        setError(res.data.message || "Erro ao criar token.");
      }
    } catch {
      setError("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRotate() {
    if (!confirm("Regenerar o token irá invalidar o token atual. Continuar?")) return;
    setLoading(true);
    setError(null);
    setNewToken(null);
    setShowFull(false);
    try {
      const res = await devRotateToken();
      if (res.ok) {
        localStorage.setItem("qrng_api_token", res.data.token);
        setNewToken(res.data.token);
        onTokenChange();
      } else {
        setError(res.data.message || "Erro ao regenerar token.");
      }
    } catch {
      setError("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke() {
    if (!confirm("Revogar o token irá desativar permanentemente o acesso. Continuar?")) return;
    setLoading(true);
    setError(null);
    setNewToken(null);
    try {
      const res = await devRevokeToken();
      if (res.ok) {
        localStorage.removeItem("qrng_api_token");
        onTokenChange();
      } else {
        setError(res.data.message || "Erro ao revogar token.");
      }
    } catch {
      setError("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy(text) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Token display: se acabou de ser criado/rotacionado, mostra completo; senão, mascarado
  const displayToken = newToken
    ? (showFull ? newToken : `${newToken.slice(0, 28)}••••••••••••••••`)
    : tokenInfo
    ? (showFull
        ? localStorage.getItem("qrng_api_token") || `${tokenInfo.token_prefix}••••••••••••••••`
        : `${tokenInfo.token_prefix}••••••••••••••••`)
    : null;

  const copyTarget = newToken || localStorage.getItem("qrng_api_token") || "";

  return (
    <div style={card}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
          Meu Token
        </span>
        {hasToken && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: mono,
              padding: "3px 10px",
              borderRadius: 20,
              background: isActive ? theme.success + "18" : theme.danger + "18",
              color: isActive ? theme.success : theme.danger,
              border: `1px solid ${isActive ? theme.success + "40" : theme.danger + "40"}`,
            }}
          >
            {isActive ? "● Ativo" : "● Revogado"}
          </span>
        )}
      </div>

      {/* Aviso de novo token */}
      {newToken && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: theme.warning + "12",
            border: `1px solid ${theme.warning}40`,
            fontSize: 11,
            color: theme.warning,
            fontFamily: mono,
          }}
        >
          Guarde seu token agora — ele não será exibido novamente após sair desta página.
        </div>
      )}

      {/* Token display / Onboarding */}
      {hasToken ? (
        <div
          style={{
            background: "#0a0e17",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            padding: "12px 16px",
            fontFamily: mono,
            fontSize: 13,
            color: theme.quantum,
            wordBreak: "break-all",
            lineHeight: 1.7,
            minHeight: 48,
          }}
        >
          {displayToken}
        </div>
      ) : (
        <div
          style={{
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            overflow: "hidden",
          }}
        >
          {/* Hero */}
          <div
            style={{
              background: theme.quantum + "08",
              padding: "20px 22px 16px",
              borderBottom: `1px solid ${theme.border}`,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.text, fontFamily: mono, marginBottom: 6 }}>
              Acesso à aleatoriedade quântica real
            </div>
            <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>
              A API QRNG da Dobslit/UFPE fornece bytes gerados por ruído quântico em hardware FPGA —
              imprevisíveis por construção física, não por algoritmo.
            </div>
          </div>

          {/* O que você recebe */}
          <div style={{ padding: "14px 22px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 10, letterSpacing: 1 }}>
              O QUE VOCÊ RECEBE
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                ["1 000 req/dia", "Cota diária para chamadas autenticadas"],
                ["Até 4 096 bytes", "Por requisição — formatos hex, base64 ou uint8"],
                ["Token permanente", "Não expira; pode ser regenerado ou revogado a qualquer momento"],
                ["Logs e estatísticas", "Histórico completo de chamadas e uso agregado"],
              ].map(([label, desc]) => (
                <div key={label} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ color: theme.quantum, fontFamily: mono, fontSize: 11, flexShrink: 0 }}>→</span>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: theme.text, fontFamily: mono }}>{label}</span>
                    <span style={{ fontSize: 11, color: theme.textDim }}> — {desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Como usar */}
          <div style={{ padding: "14px 22px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 10, letterSpacing: 1 }}>
              COMO COMEÇAR
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {["1. Clique em Gerar Token", "2. Copie e guarde o token", "3. Use no header Authorization: Bearer"].map((step, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 10,
                    fontFamily: mono,
                    color: theme.textDim,
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: theme.quantum + "08",
                    border: `1px solid ${theme.border}`,
                  }}
                >
                  {step}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Ações */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!hasToken && (
          <ActionBtn onClick={handleCreate} color={theme.quantum} disabled={loading}>
            {loading ? "Gerando..." : "Gerar Token"}
          </ActionBtn>
        )}
        {hasToken && isActive && (
          <>
            <ActionBtn onClick={() => setShowFull((v) => !v)} color={theme.accent} disabled={loading}>
              {showFull ? "Ocultar" : "Mostrar"}
            </ActionBtn>
            <ActionBtn onClick={() => handleCopy(copyTarget)} color={theme.success} disabled={!copyTarget || loading}>
              {copied ? "Copiado!" : "Copiar"}
            </ActionBtn>
            <ActionBtn onClick={handleRotate} color={theme.warning} disabled={loading}>
              {loading ? "Aguarde..." : "Regenerar"}
            </ActionBtn>
            <ActionBtn onClick={handleRevoke} color={theme.danger} disabled={loading}>
              Revogar
            </ActionBtn>
          </>
        )}
        {hasToken && !isActive && (
          <ActionBtn onClick={handleCreate} color={theme.quantum} disabled={loading}>
            {loading ? "Gerando..." : "Gerar Novo Token"}
          </ActionBtn>
        )}
      </div>

      {/* Info adicional */}
      {tokenInfo && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {tokenInfo.created_at && (
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              Criado: {new Date(tokenInfo.created_at).toLocaleDateString("pt-BR")}
            </span>
          )}
          {tokenInfo.last_used_at && (
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              Último uso: {new Date(tokenInfo.last_used_at).toLocaleString("pt-BR")}
            </span>
          )}
          <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
            Nome: {tokenInfo.name}
          </span>
        </div>
      )}

      {/* Erro */}
      {error && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: theme.danger + "12",
            border: `1px solid ${theme.danger}30`,
            fontSize: 11,
            color: theme.danger,
            fontFamily: mono,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
