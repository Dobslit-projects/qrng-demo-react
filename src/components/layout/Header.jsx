import { useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";

export default function Header() {
  const { isOnline } = useContext(AppContext);

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
        <img src="/LOGOMARCA_DOBSLIT.PNG" alt="DOBSLIT" style={{ height: 38 }} />
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
        {isOnline && (
          <span style={{ color: theme.success, fontWeight: 500 }}>
            {" "}Conectado ao hardware Red Pitaya QRNG em tempo real.
          </span>
        )}
      </p>
    </div>
  );
}
