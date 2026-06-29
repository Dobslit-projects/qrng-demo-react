import { useState, useContext, useRef, useEffect } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGSeed, getApiPrefix, CLIENT_API } from "../../qrngApi";
import Btn from "../ui/Btn";
import GlowTag from "../ui/GlowTag";

/* ── Seed presets ──────────────────────────────────────────── */

const seedPresets = [
  { bytes: 16, label: "128-bit" },
  { bytes: 32, label: "256-bit" },
  { bytes: 64, label: "512-bit" },
  { bytes: 128, label: "128 B" },
  { bytes: 256, label: "256 B" },
  { bytes: 512, label: "512 B" },
  { bytes: 1024, label: "1024 B" },
];

const useCaseTags = {
  16: ["AES-128", "HMAC-SHA256"],
  32: ["AES-256", "ChaCha20", "Ed25519"],
  64: ["HMAC-SHA512", "Seed Master"],
  128: ["RSA Seed", "KDF Input"],
  256: ["High-Entropy Pool"],
  512: ["Multi-Key Derivation"],
  1024: ["Bulk Entropy"],
};

/* ── Download presets ──────────────────────────────────────── */

const dlPresets = [
  { label: "1 KB",   value: 1024 },
  { label: "10 KB",  value: 10 * 1024 },
  { label: "100 KB", value: 100 * 1024 },
  { label: "1 MiB",  value: 1048576 },
];

/* ── Shared styles ─────────────────────────────────────────── */

const mono = "'IBM Plex Mono', monospace";
const sectionStyle = {
  background: theme.surface,
  borderRadius: 12,
  border: `1px solid ${theme.border}`,
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const labelStyle = {
  fontSize: 10,
  color: theme.textMuted,
  fontFamily: mono,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

/* ── Component ─────────────────────────────────────────────── */

export default function DataSection() {
  const { isOnline, qrngSource } = useContext(AppContext);
  const apiPrefix = getApiPrefix(qrngSource);

  // Seed state
  const [seedLength, setSeedLength] = useState(32);
  const [generatedHex, setGeneratedHex] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [animHex, setAnimHex] = useState(null);
  const [copied, setCopied] = useState(false);
  const [seedLatency, setSeedLatency] = useState(null);
  const [seedSource, setSeedSource] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const animRef = useRef(null);

  // Download state
  const [downloadSize, setDownloadSize] = useState(1024 * 1024);
  const [customInput, setCustomInput] = useState("");
  const [downloading, setDownloading] = useState(false);

  // Clean up animation interval on unmount
  useEffect(() => {
    return () => { if (animRef.current) clearInterval(animRef.current); };
  }, []);

  /* ── Seed generation with hex animation ──────────────────── */

  const handleGenerate = async () => {
    setGenerating(true);
    setCopied(false);
    setGeneratedHex(null);
    setSeedSource(null);

    animRef.current = setInterval(() => {
      const fake = Array.from({ length: seedLength * 2 }, () =>
        "0123456789abcdef"[Math.floor(Math.random() * 16)]
      ).join("");
      setAnimHex(fake);
    }, 40);

    const stopAnim = () => {
      clearInterval(animRef.current);
      animRef.current = null;
      setAnimHex(null);
    };

    try {
      const result = await fetchQRNGSeed(seedLength, apiPrefix);
      stopAnim();
      setGeneratedHex(result.hex);
      setSeedLatency(result.latencyMs);
      setSeedSource("quantum");
    } catch {
      // Fallback: crypto.getRandomValues (CSPRNG local, não quântico)
      stopAnim();
      const buf = new Uint8Array(seedLength);
      crypto.getRandomValues(buf);
      const hex = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
      setGeneratedHex(hex);
      setSeedLatency(null);
      setSeedSource("local");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedHex) return;
    await navigator.clipboard.writeText(generatedHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ── Download ────────────────────────────────────────────── */

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
      const json = await response.json();
      const hex = json.random || "";
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `qrng_${downloadSize}_bytes.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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

  const tags = useCaseTags[seedLength] || useCaseTags[32];
  const displayHex = animHex || generatedHex;

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      {!isOnline && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: theme.warning + "10", border: `1px solid ${theme.warning}30`, fontSize: 12, color: theme.warning, flexShrink: 0 }}>
          Funcionalidade limitada — backend offline.
        </div>
      )}

      {/* ── Seed Generator ──────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: mono }}>
            Gerar Chave Quântica
          </span>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {tags.map((t) => <GlowTag key={t} color={theme.quantum}>{t}</GlowTag>)}
          </div>
        </div>

        {/* Size presets */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {seedPresets.map((p) => (
            <button
              key={p.bytes}
              onClick={() => { setSeedLength(p.bytes); setGeneratedHex(null); setAnimHex(null); }}
              style={{
                padding: "5px 12px",
                borderRadius: 16,
                border: `1.5px solid ${seedLength === p.bytes ? theme.quantum : theme.border}`,
                background: seedLength === p.bytes ? theme.quantum + "12" : "transparent",
                color: seedLength === p.bytes ? theme.quantum : theme.textDim,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: mono,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Generate button */}
        <Btn onClick={handleGenerate} color={theme.quantum} disabled={generating || !isOnline}>
          {generating ? "Gerando..." : "Gerar Seed"}
        </Btn>

        {/* Hex display with animation */}
        <div style={{ position: "relative" }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 13,
              lineHeight: 2,
              color: animHex ? theme.quantum + "80" : theme.quantum,
              background: "#0a0e17",
              padding: "14px 16px",
              borderRadius: 10,
              border: `1px solid ${animHex ? theme.quantum + "40" : theme.border}`,
              wordBreak: "break-all",
              minHeight: 60,
              maxHeight: 200,
              overflow: "auto",
              transition: "border-color 0.2s",
            }}
          >
            {displayHex || (
              <span style={{ color: theme.textMuted, fontSize: 11 }}>
                Clique em "Gerar Seed" para gerar uma chave criptográfica quântica...
              </span>
            )}
          </div>
        </div>

        {/* Footer: copy + stats */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {generatedHex && (
            <Btn onClick={handleCopy} color={copied ? theme.success : theme.accent} small>
              {copied ? "Copiado!" : "Copiar"}
            </Btn>
          )}
          <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
            {seedLength * 8} bits · {seedLength} bytes
            {seedLatency !== null && ` · ${seedLatency}ms`}
            {seedSource === "quantum" && " · ⚛ quântico"}
            {seedSource === "local" && (
              <span style={{ color: theme.warning }}> · CSPRNG local (faça login para entropia quântica)</span>
            )}
          </span>
        </div>
      </div>

      {/* ── Download ────────────────────────────────────────── */}
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
                padding: "5px 12px",
                borderRadius: 16,
                border: `1.5px solid ${downloadSize === p.value ? theme.quantum : theme.border}`,
                background: downloadSize === p.value ? theme.quantum + "12" : "transparent",
                color: downloadSize === p.value ? theme.quantum : theme.textDim,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: mono,
                cursor: "pointer",
                transition: "all 0.15s",
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
              width: 140,
              padding: "7px 10px",
              borderRadius: 8,
              border: `1px solid ${theme.border}`,
              background: "#ffffff",
              color: theme.text,
              fontSize: 11,
              fontFamily: mono,
              outline: "none",
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
        </span>
      </div>
    </div>
  );
}
