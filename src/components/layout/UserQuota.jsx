import { useEffect, useRef, useState } from "react";
import { theme, formatBytes } from "../../theme";
import { useLanguage } from "../../contexts/LanguageContext";
import { usePortalUser, useQuota } from "../../lib/usage";
import { useIsMobile } from "../../hooks/useIsMobile";

const mono = "'IBM Plex Mono', monospace";

function Bar({ used, limit }) {
  const pct = limit > 0 ? Math.min(100, (100 * used) / limit) : 0;
  const color = pct >= 90 ? theme.danger : pct >= 70 ? theme.warning : theme.success;
  return (
    <div style={{ height: 6, borderRadius: 3, background: theme.border, overflow: "hidden" }}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width .3s" }} />
    </div>
  );
}

/** Painel com identidade + cota de hoje. Usado no menu da barra e na aba Dados. */
export function QuotaDetails({ compact = false }) {
  const { t, lang } = useLanguage();
  const { user } = usePortalUser();
  const { quota, token, loading } = useQuota();
  const loc = lang === "en" ? "en-US" : "pt-BR";
  const resetLocal = quota?.resets_at
    ? new Date(quota.resets_at).toLocaleString(loc, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })
    : "—";
  const row = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, fontFamily: mono, color: theme.textDim };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {!compact && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("uqSignedInAs")}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>{user ? (user.name || user.email) : t("uqUnknownUser")}</span>
          {user?.email && <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono }}>{user.email}{user.role === "admin" ? " · admin" : ""}</span>}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.text, fontFamily: mono }}>{t("uqPublicTitle")}</span>
        {loading && !quota ? <span style={row}>…</span> : quota ? (
          <>
            <div style={row}><span>{t("uqDataToday")}</span><strong style={{ color: theme.text }}>{formatBytes(quota.bytes_today)} / {formatBytes(quota.quota_daily_bytes)}</strong></div>
            <Bar used={quota.bytes_today} limit={quota.quota_daily_bytes} />
            <div style={row}><span>{t("uqRequestsToday")}</span><span>{quota.requests_today.toLocaleString(loc)} / {quota.quota_daily_requests.toLocaleString(loc)}</span></div>
            <div style={row}><span>{t("uqPerRequest")}</span><span>{formatBytes(quota.max_bytes_per_request)} · {t("uqPerMinute", { n: quota.rate_limit_per_minute })}</span></div>
            <div style={row}><span>{t("uqQuickSample")}</span><span>{formatBytes(quota.sample_max_bytes)} · {t("uqSampleWindow", { n: quota.sample_per_window, m: Math.round(quota.sample_window_seconds / 60) })}</span></div>
            <div style={row}><span>{t("uqResets")}</span><span>{resetLocal}</span></div>
            <span style={{ fontSize: 10, color: theme.textMuted, lineHeight: 1.5 }}>{t("uqPublicNote")}</span>
          </>
        ) : <span style={row}>{t("uqUnavailable")}</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.text, fontFamily: mono }}>{t("uqTokenTitle")}</span>
        {token ? (
          <>
            <div style={row}><span>{t("uqDataToday")}</span><strong style={{ color: theme.text }}>{formatBytes(token.bytes_today)} / {formatBytes(token.quota_daily_bytes)}</strong></div>
            <Bar used={token.bytes_today} limit={token.quota_daily_bytes} />
            <div style={row}><span>{t("uqRequestsToday")}</span><span>{token.requests_today.toLocaleString(loc)} / {token.quota_daily_requests.toLocaleString(loc)}</span></div>
            <div style={row}><span>{t("uqPerRequest")}</span><span>{formatBytes(token.max_bytes_per_request)}</span></div>
          </>
        ) : (
          <span style={{ fontSize: 10, color: theme.textMuted, lineHeight: 1.5 }}>
            {t("uqTokenNone", {
              req: (quota?.token_quota?.daily_requests ?? 10000).toLocaleString(loc),
              bytes: formatBytes(quota?.token_quota?.daily_bytes ?? 104857600),
              per: formatBytes(quota?.token_quota?.max_bytes_per_request ?? 1048576),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

/** Chip na barra de status: quem é o usuário + quanto da cota pública de hoje já foi usado. */
export default function UserQuotaChip() {
  const { t } = useLanguage();
  const { user } = usePortalUser();
  const { quota } = useQuota();
  const isMobile = useIsMobile(640);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const firstName = user?.name ? user.name.split(" ")[0] : user?.email?.split("@")[0];
  const usage = quota ? `${formatBytes(quota.bytes_today)} / ${formatBytes(quota.quota_daily_bytes)}` : "…";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("uqChipTitle")}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 14,
          border: `1px solid ${theme.border}`, background: open ? theme.surfaceAlt : "transparent",
          color: theme.textDim, fontSize: 11, fontFamily: mono, cursor: "pointer", whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden="true">👤</span>
        {!isMobile && <strong style={{ color: theme.text }}>{firstName || t("uqGuest")}</strong>}
        <span style={{ color: theme.border }}>|</span>
        <span>{usage}</span>
      </button>
      {open && (
        <div role="dialog" aria-label={t("uqChipTitle")} style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 1200, width: 320, maxWidth: "calc(100vw - 20px)",
          background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 14,
          boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
        }}>
          <QuotaDetails />
        </div>
      )}
    </div>
  );
}
