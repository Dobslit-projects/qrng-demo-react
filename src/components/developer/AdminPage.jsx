import { useState, useEffect, useCallback } from "react";
import { theme } from "../../theme";
import { adminGetTokens, adminRevokeToken, adminSetQuota, adminGetUsers } from "../../qrngApi";

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
            {["e-mail", "prefix", "status", "cota/dia", "req hoje", "criado", "ações"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: theme.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10, borderBottom: `1px solid ${theme.border}`, whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.length === 0 && (
            <tr><td colSpan={7} style={{ padding: "16px 10px", textAlign: "center", color: theme.textMuted }}>Nenhum token encontrado.</td></tr>
          )}
          {tokens.map((t, i) => (
            <tr key={t.id} style={{ background: i % 2 === 0 ? "transparent" : theme.surfaceAlt }}>
              <td style={{ padding: "8px 10px", color: theme.textDim, whiteSpace: "nowrap" }}>{t.email || "—"}</td>
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

// ── Aba: Usuários ─────────────────────────────────────────────────────────────
function UsersTab({ users }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: mono }}>
        <thead>
          <tr>
            {["id", "e-mail", "papel", "cadastrado em"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: theme.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10, borderBottom: `1px solid ${theme.border}`, whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr><td colSpan={4} style={{ padding: "16px 10px", textAlign: "center", color: theme.textMuted }}>Nenhum usuário encontrado.</td></tr>
          )}
          {users.map((u, i) => (
            <tr key={u.id} style={{ background: i % 2 === 0 ? "transparent" : theme.surfaceAlt }}>
              <td style={{ padding: "8px 10px", color: theme.textMuted }}>{u.id}</td>
              <td style={{ padding: "8px 10px", color: theme.text }}>{u.email}</td>
              <td style={{ padding: "8px 10px" }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12, background: u.role === "admin" ? theme.quantum + "18" : theme.accent + "10", color: u.role === "admin" ? theme.quantum : theme.textDim, border: `1px solid ${u.role === "admin" ? theme.quantum + "40" : theme.border}` }}>
                  {u.role}
                </span>
              </td>
              <td style={{ padding: "8px 10px", color: theme.textMuted, whiteSpace: "nowrap" }}>{formatDate(u.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Painel principal ──────────────────────────────────────────────────────────
export default function AdminPage() {
  const [activeTab, setActiveTab] = useState("tokens");
  const [tokens, setTokens]       = useState([]);
  const [users, setUsers]         = useState([]);

  const loadData = useCallback(async () => {
    const [tr, ur] = await Promise.all([adminGetTokens(), adminGetUsers()]);
    if (tr.ok) setTokens(tr.data.tokens);
    if (ur.ok) setUsers(ur.data.users);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>Painel Admin</span>
        <button
          onClick={loadData}
          style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMuted, fontFamily: mono, fontSize: 10, cursor: "pointer" }}
        >
          Atualizar
        </button>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 4 }}>
        {[
          { id: "tokens", label: `Tokens (${tokens.length})` },
          { id: "users",  label: `Usuários (${users.length})` },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: "5px 14px",
              borderRadius: 7,
              border: activeTab === t.id ? `1px solid ${theme.border}` : "1px solid transparent",
              background: activeTab === t.id ? theme.surfaceAlt : "transparent",
              color: activeTab === t.id ? theme.text : theme.textMuted,
              fontSize: 11,
              fontFamily: mono,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "tokens" && <TokensTab tokens={tokens} onRefresh={loadData} />}
      {activeTab === "users"  && <UsersTab  users={users} />}
    </div>
  );
}
