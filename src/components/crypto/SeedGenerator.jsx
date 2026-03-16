import { useState, useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGSeed } from "../../qrngApi";
import Btn from "../ui/Btn";
import StatBox from "../ui/StatBox";
import GlowTag from "../ui/GlowTag";

const presets = [
  { bytes: 16, label: "16 B (128-bit)" },
  { bytes: 32, label: "32 B (256-bit)" },
  { bytes: 64, label: "64 B (512-bit)" },
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

export default function SeedGenerator() {
  const { isOnline } = useContext(AppContext);
  const [seedLength, setSeedLength] = useState(32);
  const [generatedHex, setGeneratedHex] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [latency, setLatency] = useState(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setCopied(false);
    try {
      const result = await fetchQRNGSeed(seedLength);
      setGeneratedHex(result.hex);
      setLatency(result.latencyMs);
    } catch {
      setGeneratedHex(null);
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

  const tags = useCaseTags[seedLength] || useCaseTags[32];

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {/* Left: controls */}
      <div style={{ background: theme.surface, borderRadius: 12, border: `1px solid ${theme.border}`, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: theme.text, fontFamily: "'Outfit', sans-serif" }}>
          Gerador de Chaves Criptograficas
        </div>

        {!isOnline && (
          <div style={{ padding: "10px 14px", borderRadius: 8, background: theme.warning + "10", border: `1px solid ${theme.warning}30`, fontSize: 12, color: theme.warning }}>
            Gerador indisponivel — backend offline.
          </div>
        )}

        <div>
          <label style={{ display: "block", fontSize: 10, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
            Tamanho
          </label>
          <select
            value={seedLength}
            onChange={(e) => { setSeedLength(Number(e.target.value)); setGeneratedHex(null); }}
            style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${theme.border}`, background: "#ffffff", color: theme.text, fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", outline: "none", width: "100%" }}
          >
            {presets.map((p) => (
              <option key={p.bytes} value={p.bytes}>{p.label}</option>
            ))}
          </select>
        </div>

        <Btn onClick={handleGenerate} color={theme.quantum} disabled={generating || !isOnline}>
          {generating ? "Gerando..." : "Gerar Seed"}
        </Btn>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <StatBox label="Tamanho" value={`${seedLength} B (${seedLength * 8} bits)`} color={theme.quantum} />
          <StatBox label="Entropia" value={`${seedLength * 8} bits`} color={theme.success} />
          {latency !== null && <StatBox label="Latencia" value={`${latency}ms`} color={theme.accent} />}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tags.map((t) => (
            <GlowTag key={t} color={theme.quantum}>{t}</GlowTag>
          ))}
        </div>

        <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.7 }}>
          Gere seeds criptograficos com entropia maxima derivada de fenomenos quanticos. Ideal para chaves AES, nonces, IVs e derivacao de chaves.
        </div>
      </div>

      {/* Right: hex display */}
      <div style={{ background: theme.surface, borderRadius: 12, border: `1px solid ${theme.border}`, padding: 20, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Seed Hex
          </div>
          {generatedHex && (
            <Btn onClick={handleCopy} color={copied ? theme.success : theme.accent} small>
              {copied ? "Copiado!" : "Copiar"}
            </Btn>
          )}
        </div>
        <div
          style={{
            flex: 1,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            lineHeight: 2,
            color: theme.quantum,
            background: "#0a0e17",
            padding: 16,
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            wordBreak: "break-all",
            overflow: "auto",
          }}
        >
          {generatedHex || (
            <span style={{ color: theme.textMuted, fontSize: 11 }}>
              Clique em "Gerar Seed" para gerar uma chave criptografica quantica...
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
