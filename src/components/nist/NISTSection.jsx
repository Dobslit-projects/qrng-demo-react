import { useState, useEffect, useCallback, useRef } from "react";
import { theme } from "../../theme";
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
  if (passed === null || passed === undefined) return <span style={{ color: theme.textMuted, fontSize: 11 }}>—</span>;
  return <span style={badge(passed ? theme.success : theme.danger)}>{passed ? "Passou" : "Falhou"}</span>;
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

const TEST_OPTIONS   = [["both","IID + não-IID"], ["iid","Apenas IID"], ["non_iid","Apenas não-IID"]];
const FORMAT_OPTIONS = [["auto","Auto (detectar)"], ["raw","Raw/binário (.bin)"], ["u32txt","uint32 texto (.txt)"], ["bits","Bits 0/1 (.txt)"]];

/* ── Detail Modal ───────────────────────────────────────────── */
function JobModal({ job, log, onClose }) {
  const [tab, setTab] = useState("resumo");

  if (!job) return null;

  const H = ({ label, value, dim }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${theme.border}` }}>
      <span style={{ fontSize: 11, color: dim ? theme.textMuted : theme.textDim, fontFamily: mono }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: mono, color: theme.text }}>
        {value !== null && value !== undefined ? (typeof value === "number" ? value.toFixed(6) : String(value)) : "—"}
      </span>
    </div>
  );

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
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: mono }}>Job NIST</span>
            <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, marginLeft: 10 }}>
              {job.id?.slice(0, 8)}
            </span>
            <span style={{ marginLeft: 8 }}><StatusBadge status={job.status} /></span>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 18, cursor: "pointer", color: theme.textMuted }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, padding: "8px 16px", borderBottom: `1px solid ${theme.border}`, background: theme.bg }}>
          {[["resumo","Resumo"], ["estimadores","Estimadores"], ["log","Log completo"]].map(([id, label]) => (
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
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>ARQUIVO</div>
                <H label="Nome original"   value={job.original_filename} />
                <H label="Tipo de teste"   value={job.test_type} />
                <H label="Formato"         value={job.format_detected || job.format_requested} />
                <H label="Trigger"         value={job.trigger_type} />
                <H label="Duração"         value={job.duration_seconds ? `${job.duration_seconds.toFixed(1)}s` : null} />
                <H label="SHA-256 original" value={job.sha256_original?.slice(0, 16) + "…"} dim />
              </div>

              {/* IID */}
              {(job.test_type === "iid" || job.test_type === "both") && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>
                    IID — <PassBadge passed={job.iid_passed} />
                  </div>
                  <H label="H_original (IID)"          value={job.h_original_iid} />
                  <H label="H_bitstring (IID)"          value={job.h_bitstring_iid} />
                  <H label="min(H_original, 8×H_bit)"  value={job.h_min_iid} />
                  <H label="Chi-square"                 value={job.chi_square_passed === null ? null : job.chi_square_passed ? "Passou" : "Falhou"} />
                  <H label="LRS"                        value={job.lrs_passed === null ? null : job.lrs_passed ? "Passou" : "Falhou"} />
                  <H label="Permutation"                value={job.permutation_passed === null ? null : job.permutation_passed ? "Passou" : "Falhou"} />
                </div>
              )}

              {/* non-IID */}
              {(job.test_type === "non_iid" || job.test_type === "both") && (
                <div style={{ gridColumn: job.test_type === "non_iid" ? "1" : "1 / -1" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>NÃO-IID</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div>
                      <H label="H_original (non-IID)"         value={job.h_original_non_iid} />
                      <H label="H_bitstring (non-IID)"         value={job.h_bitstring_non_iid} />
                      <H label="min(H_original, 8×H_bit)"      value={job.h_min_non_iid} />
                    </div>
                    <div>
                      <H label="Estimador limitante" value={job.limiting_estimator} />
                    </div>
                  </div>
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
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 12 }}>
                ESTIMADORES non-IID
              </div>
              {job.estimators && Object.keys(job.estimators).length > 0 ? (
                Object.entries(job.estimators)
                  .sort((a, b) => a[1] - b[1])
                  .map(([name, val]) => (
                    <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0",
                      borderBottom: `1px solid ${theme.border}` }}>
                      <span style={{ fontSize: 11, color: theme.textDim, fontFamily: mono }}>{name}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono, color: theme.quantum }}>
                        {val.toFixed(6)} bits
                      </span>
                    </div>
                  ))
              ) : (
                <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: mono }}>
                  {job.status !== "completed" ? "Aguardando conclusão..." : "Nenhum estimador capturado."}
                </span>
              )}
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
                    <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: mono }}>Log ainda não disponível.</span>
                  )}
                </>
              ) : (
                <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: mono }}>Carregando log...</span>
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
      } catch {}
    }, 2500);
    return () => clearInterval(pollRef.current);
  }, [activeJobId, refresh]);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await nistRun(testType, format, "latest");
      if (r.job_id) { setActiveJobId(r.job_id); refresh(); }
      else setError(r.detail || "Erro ao criar job");
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
      else setError(r.detail || "Erro no upload");
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
    } catch {}
    finally { setLoadingLog(false); }
  };

  const fmtTs = (ts) => ts ? new Date(ts).toLocaleString("pt-BR") : "—";
  const fmtN  = (n)  => n != null ? n.toFixed(4) : "—";

  /* ── render ─────────────────────────────────────────────── */
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Service offline banner ── */}
      {serviceDown && (
        <div style={{ ...card, background: theme.warning + "10", border: `1px solid ${theme.warning}30`,
          color: theme.warning, fontSize: 11, fontFamily: mono }}>
          ⚠ Serviço NIST não acessível. Verifique se qrng-nist-api está rodando na VM de Recife.
        </div>
      )}

      {/* ── Status card ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {[
          { label: "Integração",     value: status?.enabled ? "Habilitada" : "Desabilitada", color: status?.enabled ? theme.success : theme.danger },
          { label: "Próx. automático", value: status?.next_periodic ? fmtTs(status.next_periodic) : "—", color: theme.quantum },
          { label: "Intervalo",      value: status ? `${status.interval_seconds}s` : "—", color: theme.accent },
          { label: "Fila",           value: status != null ? `${status.queue_depth} job(s)` : "—", color: status?.queue_depth > 0 ? theme.warning : theme.textMuted },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ ...card, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, fontFamily: mono, textTransform: "uppercase" }}>{label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: mono }}>{value}</span>
          </div>
        ))}
      </div>

      {/* ── Last result summary ── */}
      {status?.last_job && (
        <div style={{ ...card }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, fontFamily: mono, marginBottom: 10 }}>ÚLTIMO RESULTADO</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>Status</div>
              <StatusBadge status={status.last_job.status} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>IID</div>
              <PassBadge passed={status.last_job.iid_passed} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>min-H non-IID</div>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono, color: theme.quantum }}>
                {fmtN(status.last_job.h_min_non_iid)} bits
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>Arquivo</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}>
                {status.last_job.original_filename || "—"}
              </span>
            </div>
            <div>
              <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>Executado em</div>
              <span style={{ fontSize: 11, fontFamily: mono, color: theme.textDim }}>
                {fmtTs(status.last_job.created_at)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Teste sob demanda */}
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono }}>Executar teste agora</span>
          <span style={{ fontSize: 11, color: theme.textDim }}>
            Testa o arquivo mais recente em <code style={{ fontFamily: mono }}>NIST_DATA_DIR</code> (≥ 1 MB).
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Sel value={testType}  onChange={setTestType}  options={TEST_OPTIONS} />
            <Sel value={format}    onChange={setFormat}    options={FORMAT_OPTIONS} />
          </div>
          <Btn onClick={handleRun} disabled={running || !!activeJobId || serviceDown} color={theme.quantum}>
            {running ? "Criando job..." : activeJobId ? "Aguardando job..." : "▶ Executar teste agora"}
          </Btn>
          {activeJobId && (
            <div style={{ fontSize: 10, color: theme.warning, fontFamily: mono, animation: "pulse 1s infinite" }}>
              ● Job {activeJobId.slice(0, 8)} em execução...
            </div>
          )}
        </div>

        {/* Upload */}
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono }}>Upload + teste</span>
          <span style={{ fontSize: 11, color: theme.textDim }}>
            Envie um arquivo <code style={{ fontFamily: mono }}>.csv</code>, <code style={{ fontFamily: mono }}>.txt</code> ou <code style={{ fontFamily: mono }}>.bin</code>.
            Mínimo 1 MB.
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
            <Sel value={uploadTest} onChange={setUploadTest} options={TEST_OPTIONS} />
            <Sel value={uploadFmt}  onChange={setUploadFmt}  options={FORMAT_OPTIONS} />
          </div>
          <Btn
            onClick={handleUpload}
            disabled={!uploadFile || uploading || !!activeJobId || serviceDown}
            color={theme.accent}
          >
            {uploading ? "Enviando..." : "⬆ Enviar e testar"}
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
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: mono }}>Histórico de jobs</span>
          <Btn onClick={refresh} color={theme.accent} small>↺ Atualizar</Btn>
        </div>

        {jobs.length === 0 ? (
          <div style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, textAlign: "center", padding: "20px 0" }}>
            Nenhum job registrado ainda.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: mono }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${theme.border}` }}>
                  {["Data/hora", "Trigger", "Arquivo", "Teste", "Status", "IID", "min-H non-IID", "Duração", ""].map(h => (
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
                    <td style={{ padding: "8px 10px" }}><PassBadge passed={j.iid_passed} /></td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: theme.quantum }}>
                      {j.h_min_non_iid != null ? j.h_min_non_iid.toFixed(4) : "—"}
                    </td>
                    <td style={{ padding: "8px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>
                      {j.duration_seconds != null ? `${j.duration_seconds.toFixed(1)}s` : "—"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <Btn onClick={() => openJob(j)} color={theme.quantum} small>Ver</Btn>
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
