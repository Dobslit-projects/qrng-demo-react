import { useState, useEffect, useCallback } from "react";
import { theme } from "../../theme";
import { useLanguage } from "../../contexts/LanguageContext";
import {
  authMe, devGetToken, devGetUsage, devGetRequests, devGetUpstreamStatus,
  identityStatus, getDevAuthMode, setDevAuthMode, portalToken,
  bindDevSession, unbindDevSession, getDevSessionMode, devSessionChanged, onDevSessionChanged,
  isPortalDevSignedOut, setPortalDevSignedOut,
} from "../../qrngApi";
import { identityFailureState } from "../../lib/devIdentity";
import AuthPage from "./AuthPage";
import PortalIdentityCard from "./PortalIdentityCard";
import TokenCard from "./TokenCard";
import UsageCard from "./UsageCard";
import RequestLogsTable from "./RequestLogsTable";
import NotebookPage from "./NotebookPage";
import AdminPage from "./AdminPage";

const mono = "'IBM Plex Mono', monospace";

const BASE_URL = "https://bongo.dobslit.com/qrng/v1";

function DocsCard() {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(null);
  const token = localStorage.getItem("qrng_api_token") || "SEU_TOKEN";

  const examples = [
    {
      id: "random",
      label: t("devExRandomHex"),
      code: `curl "${BASE_URL}/random?bytes=32&format=hex" \\\n  -H "Authorization: Bearer ${token}"`,
    },
    {
      id: "base64",
      label: t("devExRandomBase64"),
      code: `curl "${BASE_URL}/random?bytes=64&format=base64" \\\n  -H "Authorization: Bearer ${token}"`,
    },
    {
      id: "health",
      label: t("devExHealth"),
      code: `curl "${BASE_URL}/health" \\\n  -H "Authorization: Bearer ${token}"`,
    },
    {
      id: "usage",
      label: t("devExUsage"),
      code: `curl "${BASE_URL}/me/usage" \\\n  -H "Authorization: Bearer ${token}"`,
    },
  ];

  async function copy(id, text) {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
          {t("devEndpointsAvailable")}
        </span>
        {[
          ["GET",  "/v1/random",          "?bytes=N&format=hex|base64|uint8", t("devEpRandomDesc")],
          ["GET",  "/v1/health",          "", t("devEpHealthDesc")],
          ["GET",  "/v1/me/token",        "", t("devEpTokenDesc")],
          ["GET",  "/v1/me/usage",        "", t("devEpUsageDesc")],
          ["GET",  "/v1/me/requests",     "?limit=20", t("devEpRequestsDesc")],
          ["POST", "/v1/me/token/rotate", "", t("devEpRotateDesc")],
          ["POST", "/v1/me/token/revoke", "", t("devEpRevokeDesc")],
        ].map(([method, path, params, desc]) => (
          <div
            key={path + method}
            style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap", paddingBottom: 10, borderBottom: `1px solid ${theme.border}` }}
          >
            <span
              style={{
                fontSize: 10, fontWeight: 700, fontFamily: mono, padding: "2px 8px", borderRadius: 6,
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
                {path}{params && <span style={{ color: theme.textMuted }}>{params}</span>}
              </span>
              <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

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
          {t("devUsageExamplesTitle")}
        </span>
        {examples.map((ex) => (
          <div key={ex.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11, color: theme.textDim, fontFamily: mono }}>{ex.label}</span>
            <div style={{ position: "relative" }}>
              <pre
                style={{
                  margin: 0, background: "#0a0e17", borderRadius: 8, border: `1px solid ${theme.border}`,
                  padding: "12px 14px", fontSize: 11, fontFamily: mono, color: theme.quantum,
                  overflowX: "auto", lineHeight: 1.7,
                }}
              >
                {ex.code}
              </pre>
              <button
                onClick={() => copy(ex.id, ex.code)}
                style={{
                  position: "absolute", top: 8, right: 8, padding: "3px 10px", borderRadius: 6,
                  border: `1px solid ${theme.border}`, background: theme.surface,
                  color: copied === ex.id ? theme.success : theme.textDim,
                  fontSize: 10, fontFamily: mono, cursor: "pointer",
                }}
              >
                {copied === ex.id ? t("apCopied") : t("apCopy")}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: theme.quantum + "08", borderRadius: 10, border: `1px solid ${theme.quantum}30`,
          padding: "14px 18px", fontSize: 11, color: theme.textDim, fontFamily: mono, lineHeight: 1.7,
        }}
      >
        <strong style={{ color: theme.quantum }}>{t("devAuthTitle")}</strong> {t("devAuthDescPrefix")}{" "}
        <code style={{ color: theme.quantum, background: theme.quantum + "14", padding: "1px 6px", borderRadius: 4 }}>
          Authorization: Bearer &lt;api_token&gt;
        </code>
        . {t("devAuthDescSuffix")}
      </div>
    </div>
  );
}

export default function DeveloperPage() {
  const { t } = useLanguage();
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser]               = useState(null); // { id, email, role, portal? }
  // Entrada sem usuário: "portal" (padrão — conta do portal, sem segunda senha)
  // ou "legacy" (login da conta antiga da API, caminho secundário)
  const [view, setView]               = useState("portal");
  const [identity, setIdentity]       = useState({ state: "checking", status: null });
  const [activeTab, setActiveTab]     = useState("token");
  const [tokenInfo, setTokenInfo]     = useState(null);
  const [usage, setUsage]             = useState(null);
  const [requests, setRequests]       = useState(null);
  const [loading, setLoading]         = useState(false);
  const [apiError, setApiError]       = useState(null);
  const [upstreamStatus, setUpstreamStatus] = useState(null);
  const [quotaBannerDismissed, setQuotaBannerDismissed] = useState(false);

  // Modo portal (doc 155, §2.4): GET /v1/identity/status com X-Portal-Session.
  // Conta de desenvolvedor existente → painel direto (sem segunda senha);
  // sem conta → cartão de escolha (criar ou vincular a conta antiga).
  // A credencial do portal é fixada nesta aba (bindDevSession): as chamadas
  // seguintes do painel (token, admin) só saem com ESTA sessão.
  const checkPortalIdentity = useCallback(async () => {
    setPortalDevSignedOut(false);
    setDevAuthMode("portal");
    setIdentity((cur) => ({ state: "checking", status: cur.status }));
    if (!portalToken()) {
      unbindDevSession();
      setIdentity({ state: "no_session", status: null });
      setAuthChecked(true);
      return;
    }
    bindDevSession("portal");
    try {
      const r = await identityStatus();
      if (r.sessionChanged) return; // outra aba trocou a sessão: o ouvinte refaz a entrada
      if (r.ok && r.data?.developer_account) {
        // papel (admin/user) vem da conta de desenvolvedor: /v1/auth/me em modo portal
        const me = await authMe();
        if (me.sessionChanged) return;
        if (me.ok) {
          setUser({
            id: me.data.id ?? r.data.developer_account.id,
            email: r.data.portal?.email || me.data.email,
            role: me.data.role,
            portal: true,
          });
          setIdentity({ state: "ready", status: r.data });
        } else {
          setIdentity({ state: identityFailureState(me), status: r.data });
        }
      } else if (r.ok) {
        setIdentity({ state: "not_provisioned", status: r.data });
      } else {
        setIdentity({ state: identityFailureState(r), status: null });
      }
    } catch {
      setIdentity({ state: "unavailable", status: null });
    } finally {
      setAuthChecked(true);
    }
  }, []);

  // Conta antiga da API: JWT em qrng_auth_jwt validado em /v1/auth/me (e
  // fixado nesta aba).
  const checkLegacySession = useCallback(async () => {
    setDevAuthMode("legacy");
    bindDevSession("legacy");
    try {
      const r = await authMe();
      if (r.sessionChanged) return;
      if (r.ok) { setUser(r.data); return; }
      localStorage.removeItem("qrng_auth_jwt");
      localStorage.removeItem("qrng_api_token");
      unbindDevSession();
      setDevAuthMode("portal");
    } catch {
      unbindDevSession();
      setDevAuthMode("portal");
    } finally {
      setAuthChecked(true);
    }
  }, []);

  // Entrada: sessão legada só se ela foi a última usada neste navegador
  // (qrng_dev_auth_mode é só a dica de retomada); se o usuário saiu da área do
  // desenvolvedor nesta aba, o painel não reabre sozinho; caso contrário, o
  // padrão é a conta do portal.
  const enter = useCallback(() => {
    if (getDevAuthMode() === "legacy" && localStorage.getItem("qrng_auth_jwt")) {
      setView("legacy");
      checkLegacySession();
    } else if (isPortalDevSignedOut()) {
      unbindDevSession();
      setView("portal");
      setIdentity({ state: "signed_out", status: null });
      setAuthChecked(true);
    } else {
      setView("portal");
      checkPortalIdentity();
    }
  }, [checkPortalIdentity, checkLegacySession]);

  useEffect(() => { enter(); }, [enter]);

  // Outra aba trocou a credencial fixada nesta (entrou com outra conta, saiu,
  // mudou de modo): limpa o painel — sem apagar a sessão nova da outra aba —
  // e refaz a entrada com o que está guardado agora.
  useEffect(() => {
    function resetForSessionChange() {
      setUser(null);
      setTokenInfo(null);
      setUsage(null);
      setRequests(null);
      setUpstreamStatus(null);
      setApiError(null);
      setQuotaBannerDismissed(false);
      setActiveTab("token");
      unbindDevSession();
      enter();
    }
    const off = onDevSessionChanged(resetForSessionChange);
    function onStorage() { if (devSessionChanged()) resetForSessionChange(); }
    window.addEventListener("storage", onStorage);
    return () => { off(); window.removeEventListener("storage", onStorage); };
  }, [enter]);

  function handleUseLegacy() {
    setView("legacy");
    // retoma uma sessão legada ainda guardada neste navegador, sem pedir a senha de novo
    if (localStorage.getItem("qrng_auth_jwt")) checkLegacySession();
  }

  function handleBackToPortal() {
    setView("portal");
    checkPortalIdentity();
  }

  const loadToken = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const res = await devGetToken();
      if (res.sessionChanged) return;
      if (res.ok) {
        setTokenInfo(res.data);
        // Upstream status só carrega se autenticado
        devGetUpstreamStatus().then((r) => { if (r.ok) setUpstreamStatus(r.data); }).catch(() => {});
      } else if (getDevSessionMode() === "portal" && [401, 403, 404, 503].includes(res.status)) {
        // sessão do portal expirada/negada, conta não provisionada ou identidade
        // indisponível: volta à entrada do portal (a sessão do portal nunca é apagada aqui)
        localStorage.removeItem("qrng_api_token");
        setUser(null);
        setTokenInfo(null);
        checkPortalIdentity();
      } else if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("qrng_auth_jwt");
        localStorage.removeItem("qrng_api_token");
        unbindDevSession();
        setDevAuthMode("portal");
        setUser(null);
        setTokenInfo(null);
      } else {
        setApiError(t("devTokenLoadError"));
      }
    } catch {
      setApiError(t("devTokenServerDown"));
    } finally {
      setLoading(false);
    }
  }, [t, checkPortalIdentity]);

  const loadUsage = useCallback(async () => {
    try {
      const res = await devGetUsage();
      if (res.ok) setUsage(res.data);
    } catch { /* uso e informativo; falha nao bloqueia a pagina */ }
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      const res = await devGetRequests(20);
      if (res.ok) setRequests(res.data.requests);
    } catch { /* historico e informativo; falha nao bloqueia a pagina */ }
  }, []);

  // Carrega token depois que user é definido
  useEffect(() => {
    if (user) loadToken();
  }, [user, loadToken]);

  useEffect(() => {
    if (!user) return;
    if (activeTab === "uso")  loadUsage();
    if (activeTab === "logs") loadRequests();
  }, [activeTab, user, loadUsage, loadRequests]);

  // login/cadastro da conta antiga (AuthPage já gravou qrng_auth_jwt)
  function handleAuth(userInfo) {
    setDevAuthMode("legacy");
    bindDevSession("legacy");
    setUser(userInfo);
    setActiveTab("token");
  }

  // Sair: apaga só as chaves do QRNG. Em modo portal a sessão do portal
  // (cookie bongo_session / bongo_token) NUNCA é tocada — sair do portal é no
  // portal —, mas esta aba marca a saída (sessionStorage) para o painel não
  // reabrir ao recarregar; o cartão avisa que a sessão do portal continua ativa.
  function handleLogout() {
    const wasPortal = user?.portal === true;
    localStorage.removeItem("qrng_auth_jwt");
    localStorage.removeItem("qrng_api_token");
    unbindDevSession();
    setDevAuthMode("portal");
    if (wasPortal) {
      setPortalDevSignedOut(true);
      setIdentity({ state: "signed_out", status: null });
    }
    setUser(null);
    setTokenInfo(null);
    setUsage(null);
    setRequests(null);
    setUpstreamStatus(null);
    setQuotaBannerDismissed(false);
  }

  function handleTokenChange() {
    setUsage(null);
    setRequests(null);
    setQuotaBannerDismissed(false);
    loadToken();
  }

  const TABS = [
    { id: "token",    label: "Token" },
    { id: "notebook", label: "Notebook" },
    { id: "uso",      label: t("devTabUsage") },
    { id: "logs",     label: t("devTabCalls") },
    { id: "docs",     label: "Docs" },
    ...(user?.role === "admin" ? [{ id: "admin", label: "Admin" }] : []),
  ];

  const quotaPct = tokenInfo?.has_token ? tokenInfo.requests_today / tokenInfo.quota_daily : 0;
  const showQuotaBanner = !quotaBannerDismissed && tokenInfo?.has_token && quotaPct >= 0.8;

  // Auth gate
  if (!authChecked) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 12, color: theme.textMuted, fontFamily: mono }}>{t("devCheckingSession")}</div>
      </div>
    );
  }

  if (!user) {
    // documentação pública ANTES do login (3º revisor: o visitante só via um formulário)
    const code = { fontFamily: mono, fontSize: 11, background: "#0a0e17", color: "#8fc4f0", padding: "10px 12px", borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 };
    return (
      <div className="kq-two-col" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 20, alignItems: "start", maxWidth: 1100, margin: "0 auto", padding: "20px 0" }}>
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: mono, color: theme.text }}>{t("devDocsTitle")}</div>
          <p style={{ margin: 0, fontSize: 12, color: theme.textDim, lineHeight: 1.7 }}>{t("devDocsIntro")}</p>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase" }}>{t("devDocsStep1")}</div>
          <pre style={code}>{`curl "https://bongo.dobslit.com/qrng/v1/public/random?bytes=16&format=hex"`}</pre>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase" }}>{t("devDocsStep2")}</div>
          <pre style={code}>{`curl -H "Authorization: Bearer SEU_TOKEN" \\\n  "https://bongo.dobslit.com/qrng/v1/random?bytes=1048576&format=raw" -o kuapoa.bin`}</pre>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase" }}>{t("devDocsStep3")}</div>
          <p style={{ margin: 0, fontSize: 12, color: theme.textDim, lineHeight: 1.7 }}>{t("devDocsHeaders")}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a href="/qrng/v1/redoc" target="_blank" rel="noopener" style={{ padding: "7px 14px", borderRadius: 8, background: theme.quantum, color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>{t("devDocsRedoc")}</a>
            <a href="/qrng/v1/docs/" target="_blank" rel="noopener" style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${theme.border}`, color: theme.textDim, fontSize: 12, fontWeight: 600, textDecoration: "none" }}>{t("devDocsSwagger")}</a>
          </div>
        </div>
        {view === "legacy"
          ? <AuthPage onAuth={handleAuth} onBack={handleBackToPortal} />
          : (
            <PortalIdentityCard
              state={identity.state}
              status={identity.status}
              onReload={checkPortalIdentity}
              onUseLegacy={handleUseLegacy}
            />
          )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
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
              {t("devAreaTitle")}
            </div>
            <div style={{ fontSize: 11, color: theme.textDim, marginTop: 3 }}>
              {user.email}
              {user.portal && (
                <span style={{ marginLeft: 8, fontSize: 10, color: theme.textMuted, fontFamily: mono, padding: "1px 6px", borderRadius: 4, border: `1px solid ${theme.border}` }}>
                  {t("devIdPortalBadge")}
                </span>
              )}
              {user.role === "admin" && (
                <span style={{ marginLeft: 8, fontSize: 10, color: theme.quantum, fontFamily: mono, background: theme.quantum + "14", padding: "1px 6px", borderRadius: 4, border: `1px solid ${theme.quantum}30` }}>
                  admin
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {(() => {
              const s     = upstreamStatus?.current?.status;
              const color = s === "up" ? theme.success : s === "down" ? theme.danger : theme.textMuted;
              const label = s === "up"
                ? `${t("devFpgaOnline")}${upstreamStatus.current.responseMs != null ? ` (${upstreamStatus.current.responseMs}ms)` : ""}`
                : s === "down" ? t("devFpgaOffline") : t("devFpgaChecking");
              const title = s === "up" && upstreamStatus.uptime_24h_pct != null
                ? `${t("devUptime24h")}: ${upstreamStatus.uptime_24h_pct}%`
                : undefined;
              return (
                <span
                  title={title}
                  style={{
                    fontSize: 10, fontWeight: 700, fontFamily: mono,
                    padding: "4px 12px", borderRadius: 20,
                    background: color + "14", color,
                    border: `1px solid ${color}40`,
                    cursor: title ? "help" : "default",
                  }}
                >
                  {label}
                </span>
              );
            })()}
            <span
              style={{
                fontSize: 10, fontWeight: 600, fontFamily: mono,
                padding: "4px 12px", borderRadius: 20,
                background: theme.quantum + "10", color: theme.quantum,
                border: `1px solid ${theme.quantum}30`,
              }}
            >
              v1 API
            </span>
            <button
              onClick={handleLogout}
              style={{
                padding: "4px 12px", borderRadius: 8,
                border: `1px solid ${theme.border}`, background: "transparent",
                color: theme.textMuted, fontFamily: mono, fontSize: 10, cursor: "pointer",
              }}
            >
              {t("devLogout")}
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexShrink: 0 }}>
        {TABS.map((tabItem) => (
          <button
            key={tabItem.id}
            onClick={() => setActiveTab(tabItem.id)}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: activeTab === tabItem.id ? `1px solid ${theme.border}` : "1px solid transparent",
              background: activeTab === tabItem.id ? theme.surface : "transparent",
              color: activeTab === tabItem.id ? theme.text : theme.textMuted,
              fontSize: 11, fontWeight: 600, fontFamily: mono,
              cursor: "pointer", transition: "all 0.15s",
              boxShadow: activeTab === tabItem.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
            }}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {/* Conteúdo (a rolagem é do <main>) */}
      <div style={{ flex: 1 }}>
        {showQuotaBanner && (
          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              padding: "10px 16px", borderRadius: 10,
              background: quotaPct >= 0.95 ? theme.danger + "12" : theme.warning + "12",
              border: `1px solid ${quotaPct >= 0.95 ? theme.danger + "40" : theme.warning + "40"}`,
              fontSize: 11, color: quotaPct >= 0.95 ? theme.danger : theme.warning,
              fontFamily: mono, marginBottom: 12, flexShrink: 0,
            }}
          >
            <span>
              {quotaPct >= 0.95
                ? t("devQuotaCritical", { n: tokenInfo.requests_today, m: tokenInfo.quota_daily, pct: Math.round(quotaPct * 100) })
                : t("devQuotaWarning", { n: tokenInfo.requests_today, m: tokenInfo.quota_daily, pct: Math.round(quotaPct * 100) })}
            </span>
            <button
              onClick={() => setQuotaBannerDismissed(true)}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
            >
              ×
            </button>
          </div>
        )}

        {apiError && (
          <div
            style={{
              padding: "10px 14px", borderRadius: 8, background: theme.danger + "10",
              border: `1px solid ${theme.danger}30`, fontSize: 12, color: theme.danger,
              fontFamily: mono, marginBottom: 12,
            }}
          >
            {apiError}
          </div>
        )}

        {loading && (
          <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
            {t("devLoadingGeneric")}
          </div>
        )}

        {!loading && activeTab === "token" && (
          <TokenCard tokenInfo={tokenInfo} onTokenChange={handleTokenChange} />
        )}

        {activeTab === "notebook" && <NotebookPage />}

        {!loading && activeTab === "uso" && (
          tokenInfo?.has_token ? (
            usage ? <UsageCard usage={usage} /> : (
              <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
                {t("devLoadingStats")}
              </div>
            )
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
              {t("devGenerateTokenFirst")}
            </div>
          )
        )}

        {!loading && activeTab === "logs" && (
          tokenInfo?.has_token ? (
            requests !== null ? <RequestLogsTable requests={requests} /> : (
              <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
                {t("devLoadingCalls")}
              </div>
            )
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, fontFamily: mono }}>
              {t("devGenerateTokenFirst")}
            </div>
          )
        )}

        {activeTab === "docs"  && <DocsCard />}
        {activeTab === "admin" && user?.role === "admin" && <AdminPage />}
      </div>
    </div>
  );
}
