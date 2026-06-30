import { useState, useContext, useRef, useEffect } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGSeed, getApiPrefix } from "../../qrngApi";
import Btn from "../ui/Btn";
import GlowTag from "../ui/GlowTag";

const mono = "'IBM Plex Mono', monospace";
const sans = "'Outfit', sans-serif";

const seedPresets = [
  { bytes: 16,   label: "128-bit" },
  { bytes: 32,   label: "256-bit" },
  { bytes: 64,   label: "512-bit" },
  { bytes: 128,  label: "128 B"   },
  { bytes: 256,  label: "256 B"   },
  { bytes: 512,  label: "512 B"   },
  { bytes: 1024, label: "1024 B"  },
];

const useCaseTags = {
  16:   ["AES-128", "HMAC-SHA256"],
  32:   ["AES-256", "ChaCha20", "Ed25519"],
  64:   ["HMAC-SHA512", "Seed Master"],
  128:  ["RSA Seed", "KDF Input"],
  256:  ["High-Entropy Pool"],
  512:  ["Multi-Key Derivation"],
  1024: ["Bulk Entropy"],
};

const sectionStyle = {
  background: theme.surface,
  borderRadius: 12,
  border: `1px solid ${theme.border}`,
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

export default function ApplicationsSection() {
  const { isOnline, qrngSource } = useContext(AppContext);
  const apiPrefix = getApiPrefix(qrngSource);

  const [seedLength,    setSeedLength]    = useState(32);
  const [generatedHex,  setGeneratedHex]  = useState(null);
  const [generating,    setGenerating]    = useState(false);
  const [animHex,       setAnimHex]       = useState(null);
  const [copied,        setCopied]        = useState(false);
  const [seedLatency,   setSeedLatency]   = useState(null);
  const [seedSource,    setSeedSource]    = useState(null);
  const animRef = useRef(null);

  useEffect(() => {
    return () => { if (animRef.current) clearInterval(animRef.current); };
  }, []);

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

  const tags = useCaseTags[seedLength] || useCaseTags[32];
  const displayHex = animHex || generatedHex;

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Intro */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: sans, color: theme.text }}>
            Aplicações Criptográficas
          </div>
          <p style={{ margin: 0, fontSize: 13, color: theme.textDim, lineHeight: 1.7, fontFamily: sans }}>
            Use a entropia quântica do Kapuã para gerar sementes e chaves criptográficas
            para aplicações de segurança. Cada byte possui entropia física real, não
            derivada de algoritmos determinísticos.
          </p>
        </div>

        {!isOnline && (
          <div style={{
            padding: "10px 14px", borderRadius: 8,
            background: theme.warning + "10",
            border: `1px solid ${theme.warning}30`,
            fontSize: 12, color: theme.warning,
          }}>
            Backend offline — será usada entropia local (CSPRNG) como fallback.
          </div>
        )}

        {/* Seed Generator */}
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
                  fontSize: 11, fontWeight: 600, fontFamily: mono,
                  cursor: "pointer", transition: "all 0.15s",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <Btn onClick={handleGenerate} color={theme.quantum} disabled={generating}>
            {generating ? "Gerando..." : "Gerar chave quântica"}
          </Btn>

          {/* Hex output */}
          <div
            style={{
              fontFamily: mono, fontSize: 13, lineHeight: 2,
              color: animHex ? theme.quantum + "80" : theme.quantum,
              background: "#0a0e17",
              padding: "14px 16px", borderRadius: 10,
              border: `1px solid ${animHex ? theme.quantum + "40" : theme.border}`,
              wordBreak: "break-all", minHeight: 60, maxHeight: 200,
              overflow: "auto", transition: "border-color 0.2s",
            }}
          >
            {displayHex || (
              <span style={{ color: theme.textMuted, fontSize: 11 }}>
                Selecione o tamanho e clique em "Gerar chave quântica"...
              </span>
            )}
          </div>

          {/* Footer */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
      </div>
    </div>
  );
}
