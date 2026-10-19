import { useState } from "react";
import { theme } from "../../theme";
import { useLanguage } from "../../contexts/LanguageContext";
import { identityProvision, identityLink, portalReauth } from "../../qrngApi";
import { errorCode, identityErrorKey } from "../../lib/devIdentity";

const mono = "'IBM Plex Mono', monospace";
const labelStyle = { fontSize: 10, color: theme.textMuted, fontFamily: mono, letterSpacing: "0.06em", textTransform: "uppercase" };

// Página de login do portal Bongo com retorno para o QRNG (mesmo destino do nginx).
const PORTAL_LOGIN_URL = "/?redirect=/qrng/";
// Página do Bongo com a recuperação de senha (inclui a opção da conta antiga da API).
// ?conta=api abre a aba da conta antiga da API; sem ele, a página do Bongo abre
// na recuperação da conta do PORTAL (e redefiniria a senha da conta errada).
const LEGACY_FORGOT_URL = "/esqueci-minha-senha?conta=api";

/**
 * Entrada da área do desenvolvedor em modo portal (doc 155, §2.4/§2.5).
 *
 * props:
 *  - state: "checking" | "no_session" | "session_invalid" | "denied" | "unavailable"
 *           | "error" | "not_provisioned" | "signed_out"
 *  - status: corpo de GET /v1/identity/status (quando houver)
 *  - onReload(): verifica a identidade de novo (após provisionar/vincular ou "tentar novamente")
 *  - onUseLegacy(): abre o login da conta antiga da API
 */
export default function PortalIdentityCard({ state, status, onReload, onUseLegacy }) {
  const { t } = useLanguage();
  const [linkOpen, setLinkOpen] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null); // { key, code }

  async function handleProvision() {
    setError(null);
    setBusy(true);
    try {
      const res = await identityProvision();
      if (res.ok) { onReload(); return; }
      setError({ key: identityErrorKey(res), code: errorCode(res) });
    } catch {
      setError({ key: "devIdUnavailable", code: null });
    } finally {
      setBusy(false);
    }
  }

  const canProvision = status ? status.can_provision !== false : true;
  const canLink      = status ? status.can_link !== false : true;

  let body;
  if (state === "checking") {
    body = <p style={textStyle}>{t("devCheckingSession")}</p>;
  } else if (state === "no_session" || state === "session_invalid") {
    body = (
      <>
        <p style={textStyle}>{t(state === "no_session" ? "devIdNoSession" : "devIdSessionInvalid")}</p>
        <a href={PORTAL_LOGIN_URL} style={primaryLinkStyle}>{t("devIdLoginPortal")}</a>
      </>
    );
  } else if (state === "denied") {
    body = <p role="alert" style={{ ...textStyle, color: theme.danger }}>{t("devIdAccessDenied")}</p>;
  } else if (state === "unavailable" || state === "error") {
    body = (
      <>
        <p role="alert" style={{ ...textStyle, color: theme.warning }}>{t(state === "unavailable" ? "devIdUnavailable" : "devIdUnknownError")}</p>
        <button type="button" onClick={onReload} style={primaryButtonStyle(false)}>{t("devIdRetry")}</button>
      </>
    );
  } else if (state === "signed_out") {
    body = (
      <>
        <p style={textStyle}>{t("devIdSignedOut")}</p>
        <button type="button" onClick={onReload} style={primaryButtonStyle(false)}>{t("devIdContinuePortal")}</button>
      </>
    );
  } else {
    // not_provisioned
    const email = status?.portal?.email;
    body = (
      <>
        {email && <p style={textStyle}>{t("devIdSignedInAs", { email })}</p>}
        <p style={textStyle}>{t("devIdNoDeveloperAccount")}</p>
        {!linkOpen && (
          <>
            {canProvision && (
              <button type="button" onClick={handleProvision} disabled={busy} style={primaryButtonStyle(busy)}>
                {busy ? t("authWait") : t("devIdProvision")}
              </button>
            )}
            {canLink && (
              <button type="button" onClick={() => { setError(null); setLinkOpen(true); }} disabled={busy} style={secondaryButtonStyle}>
                {t("devIdLinkOpen")}
              </button>
            )}
          </>
        )}
        {linkOpen && (
          <LinkLegacyForm onCancel={() => setLinkOpen(false)} onLinked={onReload} />
        )}
        {error && <ErrorBox error={error} onReload={onReload} />}
      </>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", display: "flex", flexDirection: "column", borderRadius: 14, border: `1px solid ${theme.border}`, overflow: "hidden" }}>
      <div style={{ background: theme.quantum + "08", padding: "28px 28px 20px", borderBottom: `1px solid ${theme.border}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, fontFamily: mono, marginBottom: 6 }}>
          {t("devAreaTitle")}
        </div>
        <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>{t("devIdIntro")}</div>
      </div>
      <div style={{ background: theme.surface, padding: "24px 28px", display: "flex", flexDirection: "column", gap: 12 }}>
        {body}
        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: mono, textAlign: "center", lineHeight: 1.6 }}>
          <button type="button" onClick={onUseLegacy} style={textLinkStyle}>{t("devIdUseLegacy")}</button>
          <a href={LEGACY_FORGOT_URL} style={{ color: theme.textMuted }}>{t("devIdForgotLegacy")}</a>
        </div>
      </div>
    </div>
  );
}

function ErrorBox({ error, onReload }) {
  const { t } = useLanguage();
  return (
    <div role="alert" style={{ fontSize: 11, color: theme.danger, fontFamily: mono, padding: "6px 10px", background: theme.danger + "10", borderRadius: 6, border: `1px solid ${theme.danger}30`, display: "flex", flexDirection: "column", gap: 6 }}>
      <span>{t(error.key)}</span>
      {(error.code === "PORTAL_ALREADY_LINKED" || error.key === "devIdUnavailable") && (
        <button type="button" onClick={onReload} style={{ ...textLinkStyle, color: theme.danger, textAlign: "left" }}>
          {error.code === "PORTAL_ALREADY_LINKED" ? t("devIdReload") : t("devIdRetry")}
        </button>
      )}
    </div>
  );
}

// Vínculo explícito com prova de controle das duas contas (doc 155, §0):
// 1) senha do portal → reauthToken de uso único (POST /api/auth/reauth);
// 2) e-mail + senha da conta antiga → POST /v1/identity/link.
// As senhas e o reauthToken vivem só no estado/memória deste formulário —
// nada vai para localStorage/sessionStorage — e as senhas são apagadas
// depois de cada tentativa.
function LinkLegacyForm({ onCancel, onLinked }) {
  const { t, lang } = useLanguage();
  const [portalPassword, setPortalPassword] = useState("");
  const [legacyEmail, setLegacyEmail]       = useState("");
  const [legacyPassword, setLegacyPassword] = useState("");
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!portalPassword || !legacyEmail.trim() || !legacyPassword) {
      setError({ key: "devIdMissingFields", code: "MISSING_FIELDS" });
      return;
    }
    const pPwd = portalPassword;
    const lPwd = legacyPassword;
    setPortalPassword("");
    setLegacyPassword("");
    setLoading(true);
    try {
      const re = await portalReauth(pPwd);
      if (!re.ok || !re.data?.reauthToken) {
        setError({ key: re.ok ? "devIdUnknownError" : identityErrorKey(re), code: errorCode(re) });
        return;
      }
      const res = await identityLink({ reauthToken: re.data.reauthToken, legacyEmail: legacyEmail.trim(), legacyPassword: lPwd, lang });
      if (res.ok) { onLinked(); return; }
      setError({ key: identityErrorKey(res), code: errorCode(res) });
    } catch {
      setError({ key: "devIdUnavailable", code: null });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: theme.text, fontFamily: mono }}>{t("devIdLinkTitle")}</div>
      <p style={textStyle}>{t("devIdLinkHelp")}</p>
      <label htmlFor="dev-link-portal-password" style={labelStyle}>{t("devIdPortalPassword")}</label>
      <input id="dev-link-portal-password" type="password" value={portalPassword} onChange={(e) => setPortalPassword(e.target.value)} autoComplete="current-password" style={inputStyle} />
      <label htmlFor="dev-link-legacy-email" style={labelStyle}>{t("devIdLegacyEmail")}</label>
      <input id="dev-link-legacy-email" type="email" value={legacyEmail} onChange={(e) => setLegacyEmail(e.target.value)} autoComplete="off" style={inputStyle} />
      <label htmlFor="dev-link-legacy-password" style={labelStyle}>{t("devIdLegacyPassword")}</label>
      <input id="dev-link-legacy-password" type="password" value={legacyPassword} onChange={(e) => setLegacyPassword(e.target.value)} autoComplete="off" style={inputStyle} />
      {error && <ErrorBox error={error} onReload={onLinked} />}
      <button type="submit" disabled={loading} style={primaryButtonStyle(loading)}>
        {loading ? t("authWait") : t("devIdLinkSubmit")}
      </button>
      <button type="button" onClick={onCancel} disabled={loading} style={secondaryButtonStyle}>{t("devIdCancel")}</button>
    </form>
  );
}

const textStyle = { margin: 0, fontSize: 12, color: theme.textDim, lineHeight: 1.7 };

const textLinkStyle = {
  background: "none", border: "none", padding: 0, color: theme.quantum, cursor: "pointer",
  textDecoration: "underline", fontFamily: mono, fontSize: 10,
};

function primaryButtonStyle(disabled) {
  return {
    padding: "9px 0", borderRadius: 8, border: `1px solid ${theme.quantum}40`,
    background: disabled ? "transparent" : theme.quantum + "18",
    color: disabled ? theme.textMuted : theme.quantum,
    fontFamily: mono, fontSize: 12, fontWeight: 700,
    cursor: disabled ? "default" : "pointer", transition: "all 0.15s",
  };
}

const secondaryButtonStyle = {
  padding: "8px 0", borderRadius: 8, border: `1px solid ${theme.border}`, background: "transparent",
  color: theme.textDim, fontFamily: mono, fontSize: 11, fontWeight: 600, cursor: "pointer",
};

const primaryLinkStyle = {
  ...primaryButtonStyle(false), display: "block", textAlign: "center", textDecoration: "none",
};

const inputStyle = {
  padding: "9px 12px",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: "#0a0e17",
  color: "#e8eaf6",
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};
