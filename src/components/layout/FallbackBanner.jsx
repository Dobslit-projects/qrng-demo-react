import { useContext, useState } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";

/**
 * Item 4 da auditoria: banner global de fallback, visível em TODAS as
 * telas (montado em App.jsx, acima da navegação — não dentro de uma
 * página específica) sempre que a fonte pré-coletada estiver selecionada.
 *
 * Cobre os requisitos do item 4 que faltavam:
 *  - quantidade restante (sem wraparound, ver qrngHelper.js/AppContext.jsx)
 *  - erro de esgotamento já é lançado pelo cursor; aqui só avisamos antes
 *    de chegar a zero
 *  - botão explícito "Reiniciar demonstração", com confirmação e aviso de
 *    que reinicia reaproveitando os MESMOS bytes (não é amostra nova)
 *  - proveniência (aqui: não registrada — ver
 *    docs/entropy-source-characterization.md e qrngFallbackData.js)
 *
 * A restrição de geração de chave/seed operacional durante fallback já é
 * aplicada localmente em cada card (ApplicationsSection.jsx); a NIST
 * assessment nunca consome este buffer (roda contra arquivos no backend
 * NIST, não contra a fonte selecionada no frontend) — não há caminho para
 * "avaliação NIST ao vivo" usar dados de fallback, então nada a bloquear
 * ali além do que já existe.
 */
export default function FallbackBanner() {
  const { isFallbackSelected, precollectedRemaining, precollectedLimit, restartPrecollectedDemo } =
    useContext(AppContext);
  const [confirming, setConfirming] = useState(false);

  if (!isFallbackSelected) return null;

  const exhausted = precollectedRemaining <= 0;
  const low = !exhausted && precollectedRemaining < precollectedLimit * 0.1;

  return (
    <div
      style={{
        background: exhausted ? theme.danger + "18" : theme.warning + "14",
        borderBottom: `1px solid ${exhausted ? theme.danger : theme.warning}40`,
        padding: "6px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: exhausted ? theme.danger : theme.warning, fontWeight: 700 }}>
          {exhausted ? "⚠ BUFFER PRÉ-COLETADO ESGOTADO" : "MODO DEMONSTRAÇÃO — DADOS PRÉ-COLETADOS"}
        </span>
        <span style={{ color: theme.textMuted }}>
          {precollectedRemaining} / {precollectedLimit} bytes restantes
          {low && !exhausted ? " (quase esgotado)" : ""}
        </span>
        <span style={{ color: theme.border }}>|</span>
        <span style={{ color: theme.textMuted }}>
          Proveniência: <strong style={{ color: theme.textDim }}>não registrada</strong> — não é uma medida ao vivo do hardware
        </span>
        <span style={{ color: theme.border }}>|</span>
        <span style={{ color: theme.textMuted }}>
          Geração de chaves/seed operacional bloqueada nesta fonte
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {confirming ? (
          <>
            <span style={{ color: theme.warning }}>
              Isso reaproveita os mesmos {precollectedLimit} bytes desde o início — não gera uma amostra nova.
            </span>
            <button
              onClick={() => { restartPrecollectedDemo(); setConfirming(false); }}
              style={{
                background: theme.warning, color: theme.bg, border: "none", borderRadius: 6,
                padding: "4px 10px", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              Confirmar reinício
            </button>
            <button
              onClick={() => setConfirming(false)}
              style={{
                background: "transparent", color: theme.textMuted, border: `1px solid ${theme.border}`,
                borderRadius: 6, padding: "4px 10px", fontFamily: "inherit", fontSize: 11, cursor: "pointer",
              }}
            >
              Cancelar
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            style={{
              background: "transparent", color: theme.warning, border: `1px solid ${theme.warning}60`,
              borderRadius: 6, padding: "4px 10px", fontFamily: "inherit", fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}
          >
            Reiniciar demonstração
          </button>
        )}
      </div>
    </div>
  );
}
