import { useState, useEffect, useCallback } from "react";
import { theme } from "../../theme";
import { adminCreateInvite, adminGetInvites, adminGetTokens, adminRevokeToken, adminSetQuota } from "../../qrngApi";

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

function formatDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Login ─────────────────────────────────────────────────────────────────────
function AdminLogin({ onLogin }) {
  const [secret, setSecret] = useState("");
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!secret.trim()) return;
    setLoading(true);
    setError(null);
    localStorage.setItem("qrng_admin_secret", secret.trim());
    const res = await adminGetTokens().catch(() => null);
    if (!res || !res.ok) {
      localStorage.removeItem("qrng_admin_secret");
      setError(res?.data?.message || "Secret inválido ou admin não configurado.");
      setLoading(false);
      return;
    }
    onLogin();
  }

  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
        Acesso ao Painel Admin
      </div>
      <div style={{ fontSize: 11, color: theme.textDim }}>
        Insira o <code style={{ fontFamily: mono, color: theme.quantum }}>ADMIN_SECRET</code> configurado no servidor.
      </div>
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Admin secret..."
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: "#0a0e17",
            color: theme.text,
            fontFamily: mono,
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={loading || !secret.trim()}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: `1px solid ${theme.quantum}40`,
            background: theme.quantum + "14",
            color: theme.quantum,
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 700,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "..." : "Entrar"}
        </button>
      </form>
      {error && (
        <div style={{ fontSize: 11, color: theme.danger, fontFamily: mono }}>{error}</div>
      )}
    </div>
  );
}

// ── Aba: Tokens ───────────────────────────────────────────────────────────────
function TokensTab({ tokens, onRefresh }) {
  const [editingId, setEditingId]   = useState(null);
  const [quotaInput, setQuotaInput] = useState("");
  const [busy, setBusy]             = useState(null);

  async function handleRevoke(id) {
    if (!confirm("Revogar este token?")) return;
    setBusy(id + "-revoke");
    await adminRevokeToken(id);
    setBusy(null);
    onRefresh();
  }

  async function handleQuotaSave(id) {
    const q = parseInt(quotaInput, 10);
    if (!q || q < 1) return;
    setBusy(id + "-quota");
    await adminSetQuota(id, q);
    setBusy(null);
    setEditingId(null);
    onRefresh();
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: mono }}>
        <thead>
          <tr>
            {["prefix", "status", "cota/dia", "req hoje", "bytes hoje", "criado", "ações"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: theme.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10, borderBottom: `1px solid ${theme.border}`, whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.map((t, i) => (
            <tr key={t.id} style={{ background: i % 2 === 0 ? "transparent" : theme.surfaceAlt }}>
              <td style={{ padding: "8px 10px", color: theme.quantum, whiteSpace: "nowrap" }}>{t.token_prefix}</td>
              <td style={{ padding: "8px 10px" }}>
                <span style={{ fontSize: 10, fontWeight: 700, fontFamily: mono, padding: "2px 8px", borderRadius: 12, background: t.status === "active" ? theme.success + "18" : theme.danger + "18", color: t.status === "active" ? theme.success : theme.danger, border: `1px solid ${t.status === "active" ? theme.success + "40" : theme.danger + "40"}` }}>
                  {t.status}
                </span>
              </td>
              <td style={{ padding: "8px 10px", color: theme.textDim }}>
                {editingId === t.id ? (
                  <div style={{ display: "flex", gap: 4 }}>
                    <input
                      type="number"
                      value={quotaInput}
                      onChange={(e) => setQuotaInput(e.target.value)}
                      style={{ width: 60, padding: "2px 6px", borderRadius: 4, border: `1px solid ${theme.border}`, background: "#0a0e17", color: theme.text, fontFamily: mono, fontSize: 11 }}
                    />
                    <button onClick={() => handleQuotaSave(t.id)} disabled={busy === t.id + "-quota"} style={{ padding: "2px 8px", borderRadius: 4, border: `1px solid ${theme.success}40`, background: theme.success + "14", color: theme.success, fontFamily: mono, fontSize: 10, cursor: "pointer" }}>OK</button>
                    <button onClick={() => setEditingId(null)} style={{ padding: "2px 8px", borderRadius: 4, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMuted, fontFamily: mono, fontSize: 10, cursor: "pointer" }}>×</button>
                  </div>
                ) : (
                  <span style={{ cursor: "pointer", textDecoration: "underline dotted" }} onClick={() => { setEditingId(t.id); setQuotaInput(String(t.quota_daily)); }}>{t.quota_daily}</span>
                )}
              </td>
              <td style={{ padding: "8px 10px", color: theme.textDim }}>{t.requests_today}</td>
              <td style={{ padding: "8px 10px", color: theme.textDim }}>{t.bytes_today > 0 ? `${(t.bytes_today / 1024).toFixed(1)} KB` : "—"}</td>
              <td style={{ padding: "8px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>{formatDate(t.created_at)}</td>
              <td style={{ padding: "8px 10px" }}>
                {t.status === "active" && (
                  <button
                    onClick={() => handleRevoke(t.id)}
                    disabled={busy === t.id + "-revoke"}
                    style={{ padding: "3px 10px", borderRadius: 6, border: `1px solid ${theme.danger}40`, background: theme.danger + "12", color: theme.danger, fontFamily: mono, fontSize: 10, cursor: "pointer" }}
                  >
                    Revogar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Aba: Convites ─────────────────────────────────────────────────────────────
function InvitesTab({ invites, onRefresh }) {
  const [loading, setLoading] = useState(false);
  const [newCode, setNewCode] = useState(null);
  const [copied, setCopied]   = useState(false);

  async function handleGenerate() {
    setLoading(true);
    setNewCode(null);
    const res = await adminCreateInvite();
    if (res.ok) { setNewCode(res.data.code); onRefresh(); }
    setLoading(false);
  }

  async function copyCode(code) {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={handleGenerate}
          disabled={loading}
          style={{ padding: "7px 16px", borderRadius: 8, border: `1px solid ${theme.quantum}40`, background: theme.quantum + "14", color: theme.quantum, fontFamily: mono, fontSize: 11, fontWeight: 700, cursor: loading ? "default" : "pointer" }}
        >
          {loading ? "Gerando..." : "Gerar Convite"}
        </button>
        {newCode && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 8, background: theme.success + "10", border: `1px solid ${theme.success}30` }}>
            <span style={{ fontFamily: mono, fontSize: 12, color: theme.success }}>{newCode}</span>
            <button onClick={() => copyCode(newCode)} style={{ padding: "2px 8px", borderRadius: 4, border: `1px solid ${theme.border}`, background: "transparent", color: copied ? theme.success : theme.textDim, fontFamily: mono, fontSize: 10, cursor: "pointer" }}>
              {copied ? "Copiado!" : "Copiar"}
            </button>
          </div>
        )}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: mono }}>
        <thead>
          <tr>
            {["código", "criado em", "status", "usado em"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: theme.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10, borderBottom: `1px solid ${theme.border}`, whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invites.map((inv, i) => (
            <tr key={inv.id} style={{ background: i % 2 === 0 ? "transparent" : theme.surfaceAlt }}>
              <td style={{ padding: "7px 10px", color: inv.used_at ? theme.textMuted : theme.quantum, fontFamily: mono }}>{inv.code}</td>
              <td style={{ padding: "7px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>{formatDate(inv.created_at)}</td>
              <td style={{ padding: "7px 10px" }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12, background: inv.used_at ? theme.textMuted + "18" : theme.success + "18", color: inv.used_at ? theme.textMuted : theme.success, border: `1px solid ${inv.used_at ? theme.textMuted + "40" : theme.success + "40"}` }}>
                  {inv.used_at ? "usado" : "disponível"}
                </span>
              </td>
              <td style={{ padding: "7px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>{formatDate(inv.used_at)}</td>
            </tr>
          ))}
          {invites.length === 0 && (
            <tr><td colSpan={4} style={{ padding: "16px 10px", textAlign: "center", color: theme.textMuted }}>Nenhum convite gerado ainda.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Painel principal ──────────────────────────────────────────────────────────
export default function AdminPage() {
  const [loggedIn, setLoggedIn] = useState(!!localStorage.getItem("qrng_admin_secret"));
  const [activeTab, setActiveTab] = useState("tokens");
  const [tokens, setTokens]     = useState([]);
  const [invites, setInvites]   = useState([]);

  const loadData = useCallback(async () => {
    const [tr, ir] = await Promise.all([adminGetTokens(), adminGetInvites()]);
    if (tr.ok) setTokens(tr.data.tokens);
    if (ir.ok) setInvites(ir.data.invites);
  }, []);

  useEffect(() => {
    if (loggedIn) loadData();
  }, [loggedIn, loadData]);

  function handleLogout() {
    localStorage.removeItem("qrng_admin_secret");
    setLoggedIn(false);
  }

  if (!loggedIn) return <AdminLogin onLogin={() => setLoggedIn(true)} />;

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>Painel Admin</span>
        <button onClick={handleLogout} style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMuted, fontFamily: mono, fontSize: 10, cursor: "pointer" }}>
          Sair
        </button>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 4 }}>
        {[{ id: "tokens", label: `Tokens (${tokens.length})` }, { id: "invites", label: `Convites (${invites.length})` }].map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{ padding: "5px 14px", borderRadius: 7, border: activeTab === t.id ? `1px solid ${theme.border}` : "1px solid transparent", background: activeTab === t.id ? theme.surfaceAlt : "transparent", color: activeTab === t.id ? theme.text : theme.textMuted, fontSize: 11, fontFamily: mono, cursor: "pointer" }}
          >
            {t.label}
          </button>
        ))}
        <button onClick={loadData} style={{ marginLeft: "auto", padding: "5px 10px", borderRadius: 7, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMuted, fontFamily: mono, fontSize: 10, cursor: "pointer" }}>
          Atualizar
        </button>
      </div>

      {activeTab === "tokens"  && <TokensTab  tokens={tokens}   onRefresh={loadData} />}
      {activeTab === "invites" && <InvitesTab invites={invites} onRefresh={loadData} />}
    </div>
  );
}
