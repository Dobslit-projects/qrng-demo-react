import { useContext, useState } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";

function LogoImg({ height }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: height * 0.7,
        color: theme.quantum,
        letterSpacing: "0.08em",
      }}>
        DOBSLIT
      </span>
    );
  }
  return (
    <img
      src="/LOGOMARCA_DOBSLIT.PNG"
      alt="DOBSLIT"
      style={{ height }}
      onError={() => setBroken(true)}
    />
  );
}

export default function Header() {
  // Item 5 da auditoria: "conectado ao hardware ... em tempo real" é uma
  // alegação de dado AO VIVO -- isOnline é true também para pre-collected
  // e checking, então precisa de isLiveData (só true após uma checagem de
  // rede real confirmar sucesso), não isOnline.
  const { isLiveData } = useContext(AppContext);

  return (
    <div style={{ maxWidth: 800, margin: "0 auto 32px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 16,
        }}
      >
        <LogoImg height={38} />
        <div style={{ width: 1, height: 28, background: theme.border }} />
        <span
          style={{
            fontSize: 11,
            fontFamily: "'IBM Plex Mono', monospace",
            color: theme.textMuted,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Randomness Analysis Lab
        </span>
      </div>
      <h1
        style={{
          margin: "0 0 8px",
          fontSize: 32,
          fontWeight: 700,
          fontFamily: "'Outfit', sans-serif",
          color: theme.text,
          lineHeight: 1.2,
        }}
      >
        PRNG vs QRNG
      </h1>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          color: theme.textDim,
          lineHeight: 1.7,
          maxWidth: 650,
        }}
      >
        Comparacao interativa entre geradores pseudoaleatorios (deterministicos)
        e geradores quanticos (fundamentalmente imprevisíveis).
        {isLiveData && (
          <span style={{ color: theme.success, fontWeight: 500 }}>
            {" "}Conectado ao hardware Red Pitaya QRNG em tempo real.
          </span>
        )}
      </p>
    </div>
  );
}
