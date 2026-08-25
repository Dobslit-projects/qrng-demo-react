import { useContext } from "react";
import { theme } from "../../theme";
import { getApiPrefix } from "../../qrngApi";
import { AppContext, SOURCE_LABELS } from "../../contexts/AppContext";

export default function Footer() {
  // Item 5 da auditoria: isOnline é um flag de "seguro habilitar UI", TAMBÉM
  // true para a fonte pré-coletada -- não pode decidir a alegação "conectado
  // ao hardware / dados em tempo real" abaixo. isLiveData só é true quando
  // uma checagem de rede real confirmou sucesso.
  const { isLiveData, qrngSource } = useContext(AppContext);
  const sourceLabel = SOURCE_LABELS[qrngSource] || qrngSource;

  return (
    <>
      <div
        style={{
          padding: "16px 20px",
          borderRadius: 12,
          background: theme.surface,
          border: `1px solid ${isLiveData ? theme.success : theme.border}`,
          fontSize: 11,
          lineHeight: 1.8,
          color: theme.textMuted,
          fontFamily: "'IBM Plex Mono', monospace",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {isLiveData ? (
          <>
            <strong style={{ color: theme.success }}>Conectado ao hardware:</strong>{" "}
            Os dados QRNG nesta demo vem diretamente da fonte{" "}
            <strong style={{ color: theme.quantum }}>{sourceLabel}</strong>.
            A entropia e gerada por medicoes de fenomenos quanticos reais,
            nao por algoritmos deterministicos.
          </>
        ) : (
          <>
            <strong style={{ color: theme.warning }}>Modo offline:</strong>{" "}
            O backend QRNG esta indisponivel. Os dados QRNG exibidos sao de uma{" "}
            <strong style={{ color: theme.quantum }}>amostra pre-coletada</strong>{" "}
            (10.000 bytes do Red Pitaya). Embora sejam dados quanticos genuinos,
            nao estao sendo gerados em tempo real. Conecte ao backend para dados ao vivo.
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          marginTop: 24,
          paddingBottom: 20,
        }}
      >
        <img src="/LOGOMARCA_DOBSLIT.PNG" alt="DOBSLIT" style={{ height: 22, opacity: 0.5 }} />
        <span
          style={{
            fontSize: 10,
            color: theme.textMuted,
            fontFamily: "'IBM Plex Mono', monospace",
            letterSpacing: "0.06em",
          }}
        >
          Desenvolvido por DOBSLIT
        </span>
      </div>
    </>
  );
}
