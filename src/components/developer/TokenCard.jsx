import { useState } from "react";
import { theme } from "../../theme";
import { useLanguage } from "../../contexts/LanguageContext";
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
  const { t, lang } = useLanguage();
  const [showFull, setShowFull] = useState(false);
  const [newToken, setNewToken] = useState(null);
  const [copied, setCopied]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  const hasToken = tokenInfo?.has_token;
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
        setError(res.data.message || t("tcCreateError"));
      }
    } catch {
      setError(t("tcConnectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRotate() {
    if (!confirm(t("tcRotateConfirm"))) return;
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
        setError(res.data.message || t("tcRotateError"));
      }
    } catch {
      setError(t("tcConnectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke() {
    if (!confirm(t("tcRevokeConfirm"))) return;
    setLoading(true);
    setError(null);
    setNewToken(null);
    try {
      const res = await devRevokeToken();
      if (res.ok) {
        localStorage.removeItem("qrng_api_token");
        onTokenChange();
      } else {
        setError(res.data.message || t("tcRevokeError"));
      }
    } catch {
      setError(t("tcConnectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy(text) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

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
          {t("tcMyApiToken")}
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
            {isActive ? t("tcActive") : t("tcRevoked")}
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
          {t("tcSaveNowWarning")}
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
        <div style={{ borderRadius: 10, border: `1px solid ${theme.border}`, overflow: "hidden" }}>
          <div
            style={{
              background: theme.quantum + "08",
              padding: "20px 22px 16px",
              borderBottom: `1px solid ${theme.border}`,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.text, fontFamily: mono, marginBottom: 6 }}>
              {t("tcGenerateTitle")}
            </div>
            <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>
              {t("tcGenerateDescPrefix")}{" "}
              <code style={{ fontFamily: mono, color: theme.quantum, background: theme.quantum + "14", padding: "1px 5px", borderRadius: 4 }}>
                Authorization: Bearer
              </code>{" "}
              {t("tcGenerateDescSuffix")}
            </div>
          </div>
          <div style={{ padding: "14px 22px 12px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                [t("tcQuota"), t("tcQuotaDesc")],
                [t("tcMaxSize"), t("tcMaxSizeDesc")],
                [t("tcPermanentToken"), t("tcPermanentTokenDesc")],
                [t("tcLogsStats"), t("tcLogsStatsDesc")],
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
        </div>
      )}

      {/* Ações */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!hasToken && (
          <ActionBtn onClick={handleCreate} color={theme.quantum} disabled={loading}>
            {loading ? t("tcGenerating") : t("tcGenerateBtn")}
          </ActionBtn>
        )}
        {hasToken && isActive && (
          <>
            <ActionBtn onClick={() => setShowFull((v) => !v)} color={theme.accent} disabled={loading}>
              {showFull ? t("tcHide") : t("tcShow")}
            </ActionBtn>
            <ActionBtn onClick={() => handleCopy(copyTarget)} color={theme.success} disabled={!copyTarget || loading}>
              {copied ? t("apCopied") : t("apCopy")}
            </ActionBtn>
            <ActionBtn onClick={handleRotate} color={theme.warning} disabled={loading}>
              {loading ? t("tcRegenerating") : t("tcRegenerateBtn")}
            </ActionBtn>
            <ActionBtn onClick={handleRevoke} color={theme.danger} disabled={loading}>
              {t("tcRevokeBtn")}
            </ActionBtn>
          </>
        )}
        {hasToken && !isActive && (
          <ActionBtn onClick={handleCreate} color={theme.quantum} disabled={loading}>
            {loading ? t("tcGenerating") : t("tcGenerateNewBtn")}
          </ActionBtn>
        )}
      </div>

      {/* Info adicional */}
      {tokenInfo?.has_token && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {tokenInfo.created_at && (
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              {t("tcCreatedAt")}: {new Date(tokenInfo.created_at).toLocaleDateString(lang === "en" ? "en-US" : "pt-BR")}
            </span>
          )}
          {tokenInfo.last_used_at && (
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              {t("tcLastUsedAt")}: {new Date(tokenInfo.last_used_at).toLocaleString(lang === "en" ? "en-US" : "pt-BR")}
            </span>
          )}
          {tokenInfo.name && (
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              {t("tcName")}: {tokenInfo.name}
            </span>
          )}
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
