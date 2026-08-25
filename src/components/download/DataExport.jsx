import { useState, useContext } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQrngBytes, errorMessage, PRECOLLECTED_LIMIT } from "../../lib/qrngHelper";
import Btn from "../ui/Btn";

const presets = [
  { label: "1 KB", value: 1024, desc: "Testes rapidos" },
  { label: "10 KB", value: 10 * 1024, desc: "Seeds e nonces" },
  { label: "100 KB", value: 100 * 1024, desc: "Simulacoes" },
  { label: "1 MB", value: 1024 * 1024, desc: "Analise estatistica" },
  { label: "10 MB", value: 10 * 1024 * 1024, desc: "Datasets" },
  { label: "50 MB", value: 50 * 1024 * 1024, desc: "Bulk entropy" },
];

export default function DataExport() {
  // Item 5 da auditoria (corrigido aqui): este componente ignorava
  // completamente a fonte pré-coletada -- getApiPrefix("pre-collected")
  // cai no default "/api" (rota que não existe; API_ROUTES só tem
  // remote/fpga), então o download falhava silenciosamente nesse modo em
  // vez de usar o buffer local, e o parsing (texto decimal separado por
  // "\n") era o formato legado ambíguo, não o contrato canônico hex usado
  // pelo resto do app (ver qrngHelper.js). Agora usa fetchQrngBytes, que já
  // trata as três fontes corretamente.
  const { isOnline, qrngSource, precollectedRemaining } = useContext(AppContext);
  const [downloadSize, setDownloadSize] = useState(1024 * 1024);
  const [customInput, setCustomInput] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState(null);

  const handleDownload = async () => {
    setDownloading(true);
    setDlError(null);
    try {
      const { bytes } = await fetchQrngBytes(downloadSize, qrngSource);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `qrng_${downloadSize}.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDlError(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const handleCustom = () => {
    const val = parseInt(customInput);
    if (val > 0 && val <= 50 * 1024 * 1024) {
      setDownloadSize(val);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
      {!isOnline && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: theme.warning + "10", border: `1px solid ${theme.warning}30`, fontSize: 12, color: theme.warning, flexShrink: 0 }}>
          Download indisponivel — backend offline.
        </div>
      )}
      {isOnline && qrngSource === "pre-collected" && downloadSize > precollectedRemaining && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: theme.warning + "10", border: `1px solid ${theme.warning}30`, fontSize: 12, color: theme.warning, flexShrink: 0 }}>
          Fonte pré-coletada: restam apenas {formatBytes(precollectedRemaining)} de {formatBytes(PRECOLLECTED_LIMIT)} nesta sessão. Reduza o tamanho, use "Reiniciar demonstração" no banner acima, ou troque de fonte.
        </div>
      )}
      {dlError && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: theme.danger + "10", border: `1px solid ${theme.danger}30`, fontSize: 12, color: theme.danger, flexShrink: 0 }}>
          {dlError}
        </div>
      )}

      {/* Size cards grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, flexShrink: 0 }}>
        {presets.map((p) => (
          <button
            key={p.value}
            onClick={() => setDownloadSize(p.value)}
            style={{
              padding: "16px 20px",
              borderRadius: 12,
              border: downloadSize === p.value ? `2px solid ${theme.quantum}60` : `1px solid ${theme.border}`,
              background: downloadSize === p.value ? theme.quantum + "08" : theme.surface,
              cursor: "pointer",
              transition: "all 0.2s ease",
              textAlign: "left",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: downloadSize === p.value ? theme.quantum : theme.text, marginBottom: 4 }}>
              {p.label}
            </div>
            <div style={{ fontSize: 11, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>
              {p.desc}
            </div>
          </button>
        ))}
      </div>

      {/* Custom + Download */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexShrink: 0, background: theme.surface, borderRadius: 12, border: `1px solid ${theme.border}`, padding: "12px 16px" }}>
        <input
          placeholder="Bytes customizado"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCustom()}
          style={{ width: 160, padding: "8px 12px", borderRadius: 8, border: `1px solid ${theme.border}`, background: "#ffffff", color: theme.text, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", outline: "none" }}
        />
        <Btn onClick={handleCustom} color={theme.accent} small>Aplicar</Btn>
        <div style={{ width: 1, height: 24, background: theme.border }} />
        <Btn
          onClick={handleDownload}
          color={theme.quantum}
          disabled={downloading || !isOnline || (qrngSource === "pre-collected" && downloadSize > precollectedRemaining)}
        >
          {downloading ? "Baixando..." : `Baixar ${formatBytes(downloadSize)} QRNG`}
        </Btn>
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>
          {downloadSize.toLocaleString()} bytes
        </span>
      </div>

      {/* Info */}
      <div style={{ background: theme.surface, borderRadius: 12, border: `1px solid ${theme.border}`, padding: 20, flex: 1 }}>
        <div style={{ fontSize: 13, color: theme.textDim, lineHeight: 1.8 }}>
          Baixe bytes aleatorios brutos gerados pelo hardware quantico Red Pitaya.
          Os dados sao fornecidos em formato binario puro (.bin), prontos para uso em
          aplicacoes criptograficas, simulacoes Monte Carlo ou pesquisa academica.
          Cada byte possui 8 bits de entropia verdadeira derivada de fenomenos quanticos.
        </div>
      </div>
    </div>
  );
}
