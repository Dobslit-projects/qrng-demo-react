import { useState, useEffect, useCallback, useRef } from "react";
import { theme } from "../../theme";
import { useLanguage } from "../../contexts/LanguageContext";
import {
  nistStatus, nistJobs, nistJob, nistJobLog, nistRun, nistUpload,
} from "../../qrngApi";

const mono = "'IBM Plex Mono', monospace";

/* ── tiny shared styles ─────────────────────────────────────── */
const card = {
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 12,
  padding: "16px 20px",
};

const badge = (color) => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 6,
  fontSize: 10,
  fontWeight: 700,
  fontFamily: mono,
  background: color + "18",
  color,
  border: `1px solid ${color}40`,
  whiteSpace: "nowrap",
});

function StatusBadge({ status }) {
  const map = {
    queued:    theme.textMuted,
    running:   theme.warning,
    completed: theme.success,
    failed:    theme.danger,
  };
  return <span style={badge(map[status] || theme.textMuted)}>{status}</span>;
}

function PassBadge({ passed }) {
  const { t } = useLanguage();
  if (passed === null || passed === undefined) return <span style={{ color: theme.textMuted, fontSize: 11 }}>—</span>;
  return <span style={badge(passed ? theme.success : theme.danger)}>{passed ? t("nistPassed") : t("nistFailed")}</span>;
}

// Linha rotulo/valor do modal de detalhe. No escopo do modulo (nao dentro de
// JobModal) para nao recriar o componente a cada render -- ver
// react-hooks/static-components.
function H({ label, value, dim }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${theme.border}` }}>
      <span style={{ fontSize: 11, color: dim ? theme.textMuted : theme.textDim, fontFamily: mono }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: mono, color: theme.text }}>
        {value !== null && value !== undefined ? (typeof value === "number" ? value.toFixed(6) : String(value)) : "—"}
      </span>
    </div>
  );
}

// Rotulo humano para sample_origin do job NIST (proveniencia). Forward-compat
// com a taxonomia do servico NIST corrigido: live | historical | unknown.
function sampleOriginLabel(origin, t) {
  const map = {
    periodic_live: t("nistOriginPeriodicLive"),
    live:          t("nistOriginLive"),
    historical:    t("nistOriginHistorical"),
    upload:        t("nistOriginUpload"),
    unknown:       t("nistOriginUnknown"),
  };
  return map[origin] || (origin ? String(origin) : t("nistOriginUnknown"));
}

// Item 4: o serviço está rodando com executor SINTÉTICO (staging fake)?
function isSyntheticEngine(status) {
  const s = status?.service;
  return !!(s && (s.synthetic_result === true || s.assessment_engine === "fake"));
}

// Marcador inline "SINTÉTICO" para valores fake.
function SyntheticTag() {
  const { t } = useLanguage();
  return (
    <span style={{
      marginLeft: 6, padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700,
      fontFamily: "'IBM Plex Mono', monospace", background: theme.danger + "20", color: theme.danger,
      border: `1px solid ${theme.danger}45`,
    }}>{t("nistSyntheticTag")}</span>
  );
}

function Btn({ onClick, disabled, color, small, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: small ? "5px 12px" : "8px 18px",
        borderRadius: 8,
        border: "none",
        background: disabled ? theme.border : color,
        color: disabled ? theme.textMuted : "#fff",
        fontSize: small ? 11 : 12,
        fontWeight: 700,
        fontFamily: mono,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "opacity .15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Sel({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "6px 10px",
        borderRadius: 8,
        border: `1px solid ${theme.border}`,
        background: "#fff",
        color: theme.text,
        fontSize: 11,
        fontFamily: mono,
        cursor: "pointer",
      }}
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

const getTestOptions = (t) => [["both",t("nistTestBoth")], ["iid",t("nistTestIidOnly")], ["non_iid",t("nistTestNonIidOnly")]];
const getFormatOptions = (t) => [["auto",t("nistFmtAuto")], ["raw",t("nistFmtRaw")], ["u32txt",t("nistFmtU32txt")], ["bits",t("nistFmtBits")]];

/* ── Detail Modal ───────────────────────────────────────────── */
function JobModal({ job, log, onClose }) {
  const { t } = useLanguage();
  const [tab, setTab] = useState("resumo");

  if (!job) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: theme.surface, borderRadius: 16, width: "min(820px,95vw)", maxHeight: "90vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        border: `1px solid ${theme.border}`, boxShadow: "0 8px 40px rgba(0,0,0,.25)",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: mono }}>{t("nistJobTitle")}</span>
            <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, marginLeft: 10 }}>
              {job.id?.slice(0, 8)}
            </span>
            <span style={{ marginLeft: 8 }}><StatusBadge status={job.status} /></span>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 18, cursor: "pointer", color: theme.textMuted }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, padding: "8px 16px", borderBottom: `1px solid ${theme.border}`, background: theme.bg }}>
          {[["resumo",t("nistTabSummary")], ["estimadores",t("nistTabEstimators")], ["log",t("nistTabFullLog")]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: "5px 14px", borderRadius: 6, border: "none",
              background: tab === id ? theme.quantum : "transparent",
              color: tab === id ? "#fff" : theme.textMuted,
              fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
          {tab === "resumo" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              {/* Metadata */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>{t("nistFileSection")}</div>
                <H label={t("nistOriginalName")}   value={job.original_filename} />
                <H label={t("nistTestTypeLabel")}   value={job.test_type} />
                <H label={t("nistFormatLabel")}         value={job.format_detected || job.format_requested} />
                <H label={t("nistTriggerLabel")}         value={job.trigger_type} />
                <H label={t("nistDurationLabel")}         value={job.duration_seconds ? `${job.duration_seconds.toFixed(1)}s` : null} />
                <H label={t("nistSha256Label")} value={job.sha256_original?.slice(0, 16) + "…"} dim />
              </div>

              {/* IID */}
              {(job.test_type === "iid" || job.test_type === "both") && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>
                    {t("nistIidLabel")} — <PassBadge passed={job.iid_passed} />
                  </div>
                  <H label="H_original (IID)"          value={job.h_original_iid} />
                  <H label="H_bitstring (IID)"          value={job.h_bitstring_iid} />
                  <H label="min(H_original, 8×H_bit)"  value={job.h_min_iid} />
                  <H label="Chi-square"                 value={job.chi_square_passed === null ? null : job.chi_square_passed ? t("nistPassed") : t("nistFailed")} />
                  <H label="LRS"                        value={job.lrs_passed === null ? null : job.lrs_passed ? t("nistPassed") : t("nistFailed")} />
                  <H label="Permutation"                value={job.permutation_passed === null ? null : job.permutation_passed ? t("nistPassed") : t("nistFailed")} />
                </div>
              )}

              {/* non-IID — trilhas desambiguadas (item 2) */}
              {(job.test_type === "non_iid" || job.test_type === "both") && (
                <div style={{ gridColumn: job.test_type === "non_iid" ? "1" : "1 / -1" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>{t("nistNonIidLabel")}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div>
                      <H label={t("nistHOriginalSymbol")} value={job.h_original_non_iid} />
                      <H label={t("nistLimitingEstimatorOriginal")} value={job.original_limiting_estimator} />
                      <H label={t("nistHBitstringBit")} value={job.h_bitstring_non_iid} />
                      <H label={t("nistLimitingEstimatorBitstring")} value={job.bitstring_limiting_estimator} />
                    </div>
                    <div>
                      <H label={t("nistBitstringConversion")} value={job.bitstring_to_symbol_conversion} />
                      <H label={t("nistHMinNonIid")} value={job.h_min_non_iid} />
                      <H label={t("nistLimitingPath")} value={job.limiting_path} />
                      <H label={t("nistLimitingEstimator")} value={job.limiting_estimator} />
                    </div>
                  </div>
                  {job.iid_passed === false && (
                    <div style={{ marginTop: 8, fontSize: 10, color: theme.warning, fontFamily: mono }}>
                      {t("nistIidFailedWarningPrefix")} <strong>h_min_non_iid</strong>
                      {" "}({job.h_min_non_iid != null ? job.h_min_non_iid.toFixed(4) : "—"} {t("nistIidFailedWarningSuffix")}
                    </div>
                  )}
                  {job.parse_incomplete && (
                    <div style={{ marginTop: 6, fontSize: 10, color: theme.danger, fontFamily: mono }}>
                      {t("nistParseIncomplete")}
                    </div>
                  )}
                </div>
              )}

              {job.error_message && (
                <div style={{ gridColumn: "1 / -1", padding: "10px 14px", borderRadius: 8,
                  background: theme.danger + "10", border: `1px solid ${theme.danger}30`,
                  color: theme.danger, fontSize: 11, fontFamily: mono }}>
                  {job.error_message}
                </div>
              )}
            </div>
          )}

          {tab === "estimadores" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              {[
                [t("nistTrackOriginal"), job.estimators, job.original_limiting_estimator, t("nistBitsPerSymbol")],
                [t("nistTrackBitstring"), job.bitstring_estimators, job.bitstring_limiting_estimator, t("nistBitsPerBit")],
              ].map(([title, est, limName, unit]) => (
                <div key={title}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 12 }}>{title}</div>
                  {est && Object.keys(est).length > 0 ? (
                    Object.entries(est).sort((a, b) => a[1] - b[1]).map(([name, val]) => (
                      <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0",
                        borderBottom: `1px solid ${theme.border}`,
                        background: name === limName ? theme.quantum + "12" : "transparent" }}>
                        <span style={{ fontSize: 11, color: name === limName ? theme.quantum : theme.textDim, fontFamily: mono, fontWeight: name === limName ? 700 : 400 }}>
                          {name}{name === limName ? ` ${t("nistLimits")}` : ""}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono, color: theme.quantum }}>
                          {val.toFixed(6)} {unit}
                        </span>
                      </div>
                    ))
                  ) : (
                    <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: mono }}>
                      {job.status !== "completed" ? t("nistAwaitingCompletion") : "—"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "log" && (
            <div>
              {log ? (
                <>
                  {log.stdout && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 6 }}>STDOUT</div>
                      <pre style={{
                        background: "#0a0e17", color: "#a8d8a0", fontFamily: mono, fontSize: 11,
                        padding: 14, borderRadius: 8, overflow: "auto", maxHeight: 400,
                        margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all",
                      }}>{log.stdout}</pre>
                    </div>
                  )}
                  {log.stderr && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 6 }}>STDERR</div>
                      <pre style={{
                        background: "#17100a", color: "#e8c89a", fontFamily: mono, fontSize: 11,
                        padding: 14, borderRadius: 8, overflow: "auto", maxHeight: 200,
                        margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all",
                      }}>{log.stderr}</pre>
                    </div>
                  )}
                  {!log.stdout && !log.stderr && (
                    <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: mono }}>{t("nistLogNotAvailable")}</span>
                  )}
                </>
              ) : (
                <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: mono }}>{t("nistLoadingLog")}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main Section ───────────────────────────────────────────── */
export default function NISTSection() {
  const { t, lang } = useLanguage();
  const [status,       setStatus]       = useState(null);
  const [jobs,         setJobs]         = useState([]);
  const [selectedJob,  setSelectedJob]  = useState(null);
  const [jobLog,       setJobLog]       = useState(null);
  const [loadingLog,   setLoadingLog]   = useState(false);
  const [running,      setRunning]      = useState(false);
  const [uploading,    setUploading]    = useState(false);
  const [uploadFile,   setUploadFile]   = useState(null);
  const [testType,     setTestType]     = useState("both");
  const [format,       setFormat]       = useState("auto");
  const [uploadTest,   setUploadTest]   = useState("both");
  const [uploadFmt,    setUploadFmt]    = useState("auto");
  const [error,        setError]        = useState(null);
  const [activeJobId,  setActiveJobId]  = useState(null);
  const [serviceDown,  setServiceDown]  = useState(false);
  const pollRef    = useRef(null);
  const fileRef    = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([nistStatus(), nistJobs(30)]);
      setStatus(s);
      setJobs(j.jobs || []);
      setServiceDown(false);
    } catch {
      setServiceDown(true);
    }
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 20000); return () => clearInterval(t); }, [refresh]);

  // Poll active job
  useEffect(() => {
    if (!activeJobId) { clearInterval(pollRef.current); return; }
    pollRef.current = setInterval(async () => {
      try {
        const j = await nistJob(activeJobId);
        if (j.status === "completed" || j.status === "failed") {
          clearInterval(pollRef.current);
          setActiveJobId(null);
          refresh();
        }
      } catch { /* poll transitorio; a proxima iteracao tenta de novo */ }
    }, 2500);
    return () => clearInterval(pollRef.current);
  }, [activeJobId, refresh]);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await nistRun(testType, format, "latest");
      if (r.job_id) { setActiveJobId(r.job_id); refresh(); }
      else setError(r.detail || t("nistCreateJobError"));
    } catch (e) { setError(String(e)); }
    finally { setRunning(false); }
  };

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setError(null);
    try {
      const r = await nistUpload(uploadFile, uploadTest, uploadFmt);
      if (r.job_id) { setActiveJobId(r.job_id); refresh(); setUploadFile(null); if (fileRef.current) fileRef.current.value = ""; }
      else setError(r.detail || t("nistUploadError"));
    } catch (e) { setError(String(e)); }
    finally { setUploading(false); }
  };

  const openJob = async (job) => {
    setSelectedJob(job);
    setJobLog(null);
    setLoadingLog(true);
    try {
      const l = await nistJobLog(job.id);
      setJobLog(l);
    } catch { /* log e opcional; o modal abre mesmo sem ele */ }
    finally { setLoadingLog(false); }
  };

  const fmtTs = (ts) => ts ? new Date(ts).toLocaleString(lang === "en" ? "en-US" : "pt-BR") : "—";
  const fmtN  = (n)  => n != null ? n.toFixed(4) : "—";
  const fmtAge = (seconds) => {
    if (seconds == null) return "—";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)} ${t("nistDaysWord")}`;
  };

  /* ── render ─────────────────────────────────────────────── */
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Service offline banner ── */}
      {serviceDown && (
        <div style={{ ...card, background: theme.warning + "10", border: `1px solid ${theme.warning}30`,
          color: theme.warning, fontSize: 11, fontFamily: mono }}>
          {t("nistServiceDownMsg")}
        </div>
      )}

      {/* ── Item 4: executor SINTÉTICO (staging fake) — banner obrigatório ── */}
      {isSyntheticEngine(status) && (
        <div data-testid="nist-synthetic-banner" style={{ ...card,
          background: theme.danger + "12", border: `2px solid ${theme.danger}55`,
          color: theme.danger, fontSize: 12, fontWeight: 700, fontFamily: mono, lineHeight: 1.6 }}>
          {t("nistSyntheticBanner")}
          <div style={{ fontWeight: 400, fontSize: 11, marginTop: 6, color: theme.textDim }}>
            {t("nistSyntheticBannerPrefix")} <strong>{status?.service?.assessment_engine}</strong>
            {status?.service?.assessment_engine_version ? ` (${status.service.assessment_engine_version})` : ""}.
            {" "}{t("nistSyntheticBannerSuffix")}
          </div>
        </div>
      )}

      {/* ── Status card ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {[
          { label: t("nistIntegration"),     value: status?.enabled ? t("nistEnabled") : t("nistDisabled"), color: status?.enabled ? theme.success : theme.danger },
          { label: t("nistEngine"),          value: status?.service?.assessment_engine || "—", color: isSyntheticEngine(status) ? theme.danger : theme.success },
          { label: t("nistNextAuto"), value: status?.periodic_enabled === false ? t("nistNextAutoDisabled") : (status?.next_periodic ? fmtTs(status.next_periodic) : "—"), color: theme.quantum },
          { label: t("nistInterval"),      value: status ? `${status.interval_seconds}s` : "—", color: theme.accent },
          { label: t("nistQueue"),           value: status != null ? `${status.queue_depth} ${t("nistJobsWord")}` : "—", color: status?.queue_depth > 0 ? theme.warning : theme.textMuted },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ ...card, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase" }}>{label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: mono }}>{value}</span>
          </div>
        ))}
      </div>

      {/* ── Aviso: sem monitoramento periódico ao vivo configurado ── */}
      {status && status.live_capture_configured === false && (
        <div data-testid="nist-live-capture-unavailable" style={{
          padding: "8px 12px", borderRadius: 8,
          background: theme.textMuted + "12", border: `1px solid ${theme.textMuted}30`,
          fontSize: 11, color: theme.textDim, fontFamily: mono,
        }}>
          {t("nistLiveCaptureUnavailablePrefix")} ({status.periodic_enabled === false ? "periodic_enabled=false" : "—"});
          {" "}{t("nistLiveCaptureUnavailableSuffix")}
        </div>
      )}

      {/* ── Last result summary ── */}
      {status?.last_job && (
        <div style={{ ...card }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 4 }}>{t("nistLastResult")}</div>
          <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, marginBottom: 10, lineHeight: 1.6 }}>
            {t("nistOriginPrefix")} <strong>{sampleOriginLabel(status.last_job.sample_origin, t)}</strong>.{" "}
            {status.last_job.sample_origin === "periodic_live"
              ? t("nistOriginPeriodicDetail")
              : t("nistOriginSpecificDetail")}
          </div>

          {/* Aviso destacado quando a amostra testada está desatualizada
              (só se aplica a monitoramento periódico ao vivo -- upload ou
              avaliação manual de um arquivo histórico não "expira"). */}
          {status.last_job.sample_file_is_stale && (
            <div style={{
              padding: "8px 12px", borderRadius: 8, marginBottom: 10,
              background: theme.warning + "12", border: `1px solid ${theme.warning}35`,
              fontSize: 11, color: theme.warning, fontFamily: mono,
            }}>
              {t("nistStaleWarningPrefix")} {fmtAge(status.last_job.sample_captured_age_seconds)}
              {" "}{t("nistStaleWarningMid")} ({status?.interval_seconds}s). {t("nistStaleWarningSuffix")}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistStatusLabel")}</div>
              <StatusBadge status={status.last_job.status} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistIidLabel")}</div>
              <PassBadge passed={status.last_job.iid_passed} />
              {status.last_job.synthetic_result && <SyntheticTag />}
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistMinHLabel")}</div>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono, color: theme.quantum }}>
                {fmtN(status.last_job.h_min_non_iid)} bits
                {status.last_job.synthetic_result && <SyntheticTag />}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistFileLabel")}</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}>
                {status.last_job.original_filename || "—"}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistSubmittedAt")}</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}>
                {fmtTs(status.last_job.submitted_at)}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistSampleAge")}</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: status.last_job.sample_file_is_stale ? theme.warning : theme.textDim }}>
                {fmtAge(status.last_job.sample_captured_age_seconds)}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistTransportOrigin")}</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}>
                {status.last_job.transport_format}
                {status.last_job.source_word_width != null ? ` · ${status.last_job.source_word_width}B/${t("nistPerWord")}` : ""}
                {status.last_job.sample_conditioned != null
                  ? ` · ${status.last_job.sample_conditioned ? t("nistConditioned") : t("nistNotConditioned")}`
                  : ""}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{t("nistEvaluatedSymbol")}</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}>
                {status.last_job.assessment_symbol_width != null
                  ? `${status.last_job.assessment_symbol_width} bit(s) · ${status.last_job.normalization_method}`
                  : "—"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Teste sob demanda */}
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono }}>{t("nistRunNowTitle")}</span>
          <span style={{ fontSize: 11, color: theme.textDim }}>
            {t("nistRunNowDescPrefix")} <code style={{ fontFamily: mono }}>NIST_DATA_DIR</code> {t("nistRunNowDescSuffix")}
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Sel value={testType}  onChange={setTestType}  options={getTestOptions(t)} />
            <Sel value={format}    onChange={setFormat}    options={getFormatOptions(t)} />
          </div>
          <Btn onClick={handleRun} disabled={running || !!activeJobId || serviceDown} color={theme.quantum}>
            {running ? t("nistCreatingJob") : activeJobId ? t("nistAwaitingJob") : t("nistRunNowBtn")}
          </Btn>
          {activeJobId && (
            <div style={{ fontSize: 10, color: theme.warning, fontFamily: mono, animation: "pulse 1s infinite" }}>
              {t("nistJobRunningPrefix")} {activeJobId.slice(0, 8)} {t("nistJobRunningSuffix")}
            </div>
          )}
        </div>

        {/* Upload */}
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono }}>{t("nistUploadTitle")}</span>
          <span style={{ fontSize: 11, color: theme.textDim }}>
            {t("nistUploadDescPrefix")} <code style={{ fontFamily: mono }}>.csv</code>, <code style={{ fontFamily: mono }}>.txt</code> {lang === "en" ? "or" : "ou"} <code style={{ fontFamily: mono }}>.bin</code>.
            {" "}{t("nistUploadDescSuffix")}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,.bin"
            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
            style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}
          />
          {uploadFile && (
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              {uploadFile.name} ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
            </span>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Sel value={uploadTest} onChange={setUploadTest} options={getTestOptions(t)} />
            <Sel value={uploadFmt}  onChange={setUploadFmt}  options={getFormatOptions(t)} />
          </div>
          <Btn
            onClick={handleUpload}
            disabled={!uploadFile || uploading || !!activeJobId || serviceDown}
            color={theme.accent}
          >
            {uploading ? t("nistSending") : t("nistUploadBtn")}
          </Btn>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ ...card, background: theme.danger + "10", border: `1px solid ${theme.danger}30`,
          color: theme.danger, fontSize: 11, fontFamily: mono }}>
          {error}
        </div>
      )}

      {/* ── Jobs history ── */}
      <div style={{ ...card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono }}>{t("nistJobHistory")}</span>
          <Btn onClick={refresh} color={theme.accent} small>{t("nistRefreshBtn")}</Btn>
        </div>

        {jobs.length === 0 ? (
          <div style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, textAlign: "center", padding: "20px 0" }}>
            {t("nistNoJobs")}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: mono }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${theme.border}` }}>
                  {[t("nistThDate"), t("nistThTrigger"), t("nistThFile"), t("nistThTest"), t("nistThStatus"), t("nistThIid"), t("nistThMinH"), t("nistThDuration"), ""].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: theme.textMuted, fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} style={{ borderBottom: `1px solid ${theme.border}`, transition: "background .1s" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = theme.surfaceAlt}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  >
                    <td style={{ padding: "8px 10px", color: theme.textDim, whiteSpace: "nowrap" }}>{fmtTs(j.created_at)}</td>
                    <td style={{ padding: "8px 10px" }}><span style={badge(theme.accent)}>{j.trigger_type}</span></td>
                    <td style={{ padding: "8px 10px", color: theme.textDim, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={j.original_filename}>{j.original_filename || "—"}</td>
                    <td style={{ padding: "8px 10px", color: theme.textDim }}>{j.test_type || "—"}</td>
                    <td style={{ padding: "8px 10px" }}><StatusBadge status={j.status} /></td>
                    <td style={{ padding: "8px 10px" }}>
                      <PassBadge passed={j.iid_passed} />
                      {j.synthetic_result && <SyntheticTag />}
                    </td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: theme.quantum }}>
                      {j.h_min_non_iid != null ? j.h_min_non_iid.toFixed(4) : "—"}
                    </td>
                    <td style={{ padding: "8px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>
                      {j.duration_seconds != null ? `${j.duration_seconds.toFixed(1)}s` : "—"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <Btn onClick={() => openJob(j)} color={theme.quantum} small>{t("nistViewBtn")}</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modal ── */}
      {selectedJob && (
        <JobModal
          job={selectedJob}
          log={loadingLog ? null : jobLog}
          onClose={() => { setSelectedJob(null); setJobLog(null); }}
        />
      )}
    </div>
  );
}
