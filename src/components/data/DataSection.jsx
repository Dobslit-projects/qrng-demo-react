import { useState, useContext } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { CLIENT_API } from "../../qrngApi";
import Btn from "../ui/Btn";

const mono = "'IBM Plex Mono', monospace";
const sans = "'Outfit', sans-serif";

const dlPresets = [
  { label: "1 KB",   value: 1024 },
  { label: "10 KB",  value: 10 * 1024 },
  { label: "100 KB", value: 100 * 1024 },
  { label: "1 MiB",  value: 1048576 },
];

const sectionStyle = {
  background: theme.surface,
  borderRadius: 12,
  border: `1px solid ${theme.border}`,
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

export default function DataSection() {
  const { isOnline } = useContext(AppContext);

  const [downloadSize,  setDownloadSize]  = useState(1048576);
  const [customInput,   setCustomInput]   = useState("");
  const [downloading,   setDownloading]   = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const jwt = localStorage.getItem("qrng_auth_jwt");
      if (!jwt) {
        setDownloadError("Faça login na aba Desenvolvedor para baixar dados quânticos.");
        return;
      }
      const response = await fetch(`${CLIENT_API}/random?bytes=${downloadSize}&format=hex`, {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(60000),
      });
      if (response.status === 401 || response.status === 403) {
        setDownloadError("Sessão expirada. Faça login novamente na aba Desenvolvedor.");
        return;
      }
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const json  = await response.json();
      const hex   = json.random || "";
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `qrng_${downloadSize}_bytes.bin`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError("Erro ao baixar dados. Verifique sua conexão e tente novamente.");
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  const handleCustom = () => {
    const val = parseInt(customInput);
    if (val > 0 && val <= 1048576) { setDownloadSize(val); setDownloadError(null); }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Intro */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: sans, color: theme.text }}>
            Dados QRNG
          </div>
          <p style={{ margin: 0, fontSize: 13, color: theme.textDim, lineHeight: 1.7, fontFamily: sans }}>
            Exporte bytes de entropia quântica bruta para uso em simulações, pesquisas,
            testes estatísticos e aplicações que exigem aleatoriedade física.
          </p>
        </div>

        {!isOnline && (
          <div style={{
            padding: "10px 14px", borderRadius: 8,
            background: theme.warning + "10",
            border: `1px solid ${theme.warning}30`,
            fontSize: 12, color: theme.warning,
          }}>
            Funcionalidade limitada — backend offline.
          </div>
        )}

        {/* Download */}
        <div style={sectionStyle}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
            Baixar Dados QRNG
          </span>

          {/* Size presets */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {dlPresets.map((p) => (
              <button
                key={p.value}
                onClick={() => { setDownloadSize(p.value); setDownloadError(null); }}
                style={{
                  padding: "5px 12px", borderRadius: 16,
                  border: `1.5px solid ${downloadSize === p.value ? theme.quantum : theme.border}`,
                  background: downloadSize === p.value ? theme.quantum + "12" : "transparent",
                  color: downloadSize === p.value ? theme.quantum : theme.textDim,
                  fontSize: 11, fontWeight: 600, fontFamily: mono,
                  cursor: "pointer", transition: "all 0.15s",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom + Download */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="Bytes (máx. 1 MiB)"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCustom()}
              style={{
                width: 140, padding: "7px 10px", borderRadius: 8,
                border: `1px solid ${theme.border}`, background: "#ffffff",
                color: theme.text, fontSize: 11, fontFamily: mono, outline: "none",
              }}
            />
            <Btn onClick={handleCustom} color={theme.accent} small>Aplicar</Btn>
            <Btn onClick={handleDownload} color={theme.quantum} disabled={downloading || !isOnline}>
              {downloading ? "Baixando..." : `Baixar ${formatBytes(downloadSize)} QRNG`}
            </Btn>
            <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
              {downloadSize.toLocaleString()} bytes
            </span>
          </div>

          {downloadError && (
            <span style={{ fontSize: 11, color: theme.warning, lineHeight: 1.6 }}>
              {downloadError}
            </span>
          )}
          <span style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.6 }}>
            Formato binário raw (.bin) — cada byte possui 8 bits de entropia quântica.
            Requer autenticação na aba <strong>Desenvolvedor</strong>.
          </span>
        </div>
      </div>
    </div>
  );
}
