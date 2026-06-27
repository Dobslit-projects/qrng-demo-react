import { useState } from "react";
import { theme } from "../../theme";
import { authLogin, authRegister } from "../../qrngApi";

const mono = "'IBM Plex Mono', monospace";

export default function AuthPage({ onAuth }) {
  const [mode, setMode]         = useState("login"); // "login" | "register"
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) return;

    if (mode === "register") {
      if (password !== confirm) return setError("As senhas não coincidem.");
      if (password.length < 8) return setError("A senha deve ter pelo menos 8 caracteres.");
    }

    setLoading(true);
    try {
      const res = mode === "login"
        ? await authLogin(email.trim(), password)
        : await authRegister(email.trim(), password);

      if (res.ok) {
        localStorage.setItem("qrng_auth_jwt", res.data.token);
        onAuth({ email: res.data.email, role: res.data.role });
      } else {
        const msgs = {
          invalid_credentials: "E-mail ou senha incorretos.",
          email_taken:         "Este e-mail já está cadastrado.",
          weak_password:       "A senha deve ter pelo menos 8 caracteres.",
          missing_fields:      "Preencha e-mail e senha.",
        };
        setError(msgs[res.data.error] || res.data.message || "Erro desconhecido.");
      }
    } catch {
      setError("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 420,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 0,
        borderRadius: 14,
        border: `1px solid ${theme.border}`,
        overflow: "hidden",
      }}
    >
      {/* Hero */}
      <div
        style={{
          background: theme.quantum + "08",
          padding: "28px 28px 20px",
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, fontFamily: mono, marginBottom: 6 }}>
          QRNG API — Área do Desenvolvedor
        </div>
        <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>
          {mode === "login"
            ? "Faça login para acessar seu token e os logs de uso."
            : "Crie uma conta para obter acesso à API de aleatoriedade quântica."}
        </div>
      </div>

      {/* Form */}
      <div style={{ background: theme.surface, padding: "24px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Toggle */}
        <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          {["login", "register"].map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              style={{
                flex: 1,
                padding: "7px 0",
                borderRadius: 8,
                border: mode === m ? `1px solid ${theme.quantum}40` : `1px solid ${theme.border}`,
                background: mode === m ? theme.quantum + "12" : "transparent",
                color: mode === m ? theme.quantum : theme.textMuted,
                fontFamily: mono,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {m === "login" ? "Entrar" : "Criar conta"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="E-mail"
            required
            autoComplete="email"
            style={inputStyle}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Senha"
            required
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            style={inputStyle}
          />
          {mode === "register" && (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirmar senha"
              required
              autoComplete="new-password"
              style={inputStyle}
            />
          )}

          {error && (
            <div style={{ fontSize: 11, color: theme.danger, fontFamily: mono, padding: "6px 10px", background: theme.danger + "10", borderRadius: 6, border: `1px solid ${theme.danger}30` }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "9px 0",
              borderRadius: 8,
              border: `1px solid ${theme.quantum}40`,
              background: loading ? "transparent" : theme.quantum + "18",
              color: loading ? theme.textMuted : theme.quantum,
              fontFamily: mono,
              fontSize: 12,
              fontWeight: 700,
              cursor: loading ? "default" : "pointer",
              transition: "all 0.15s",
              marginTop: 4,
            }}
          >
            {loading ? "Aguarde..." : mode === "login" ? "Entrar" : "Criar conta"}
          </button>
        </form>

        {mode === "login" && (
          <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, textAlign: "center", lineHeight: 1.6 }}>
            Sem conta?{" "}
            <span
              onClick={() => { setMode("register"); setError(null); }}
              style={{ color: theme.quantum, cursor: "pointer", textDecoration: "underline" }}
            >
              Cadastre-se
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

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
