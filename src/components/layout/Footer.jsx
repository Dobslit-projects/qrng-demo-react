import { useContext } from "react";
import { theme } from "../../theme";
import { API_BASE } from "../../qrngApi";
import { AppContext } from "../../contexts/AppContext";

export default function Footer() {
  const { isOnline } = useContext(AppContext);

  return (
    <>
      <div
        style={{
          padding: "16px 20px",
          borderRadius: 12,
          background: theme.surface,
          border: `1px solid ${isOnline ? theme.success : theme.border}`,
          fontSize: 11,
          lineHeight: 1.8,
          color: theme.textMuted,
          fontFamily: "'IBM Plex Mono', monospace",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {isOnline ? (
          <>
            <strong style={{ color: theme.success }}>Conectado ao hardware:</strong>{" "}
            Os dados QRNG nesta demo vem diretamente do{" "}
            <strong style={{ color: theme.quantum }}>Red Pitaya QRNG</strong>{" "}
            via API em <code style={{ color: theme.quantum }}>{API_BASE}</code>.
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
