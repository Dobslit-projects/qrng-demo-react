import { useEffect } from "react";
import { theme } from "../../theme";
import { explanations } from "./explanationData";

/* ── modal ───────────────────────────────────────────────── */

export default function InfoModal({ mode, onClose }) {
  const data = explanations[mode];

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!data) return null;

  const headingStyle = {
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'IBM Plex Mono', monospace",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: theme.accent,
    borderLeft: `3px solid ${theme.accent}`,
    paddingLeft: 10,
    marginBottom: 2,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(94vw, 600px)",
          maxHeight: "85vh",
          overflowY: "auto",
          borderRadius: 16,
          padding: "24px 28px 28px",
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{
            fontSize: 18,
            fontWeight: 800,
            fontFamily: "'Space Grotesk', sans-serif",
            color: theme.text,
          }}>
            {data.title}
          </span>
          <button
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: 15,
              border: `1px solid ${theme.border}`,
              background: "transparent", color: theme.textMuted,
              fontSize: 15, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s", flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = theme.surfaceAlt;
              e.currentTarget.style.color = theme.text;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = theme.textMuted;
            }}
          >
            {"\u2715"}
          </button>
        </div>

        {/* Algorithm — bullet points */}
        <div>
          <div style={headingStyle}>{data.algorithm.heading}</div>
          <ul style={{
            margin: "8px 0 0",
            paddingLeft: 20,
            listStyle: "none",
          }}>
            {data.algorithm.bullets.map((b, i) => (
              <li key={i} style={{
                fontSize: 12,
                lineHeight: 1.7,
                fontFamily: "'Outfit', sans-serif",
                color: theme.textDim,
                position: "relative",
                paddingLeft: 12,
              }}>
                <span style={{
                  position: "absolute",
                  left: 0,
                  color: theme.accent,
                  fontWeight: 700,
                }}>
                  ·
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>

        {/* Differences — side by side */}
        <div>
          <div style={headingStyle}>{data.differences.heading}</div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginTop: 8,
          }}>
            {/* PRNG card */}
            <div style={{
              borderLeft: `3px solid ${theme.classical}`,
              background: theme.classicalDim,
              borderRadius: 8,
              padding: "10px 14px",
            }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'IBM Plex Mono', monospace",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: theme.classical,
                display: "block",
                marginBottom: 6,
              }}>
                PRNG (LCG)
              </span>
              <span style={{
                fontSize: 12,
                lineHeight: 1.7,
                fontFamily: "'Outfit', sans-serif",
                color: theme.textDim,
              }}>
                {data.differences.prng}
              </span>
            </div>
            {/* QRNG card */}
            <div style={{
              borderLeft: `3px solid ${theme.quantum}`,
              background: theme.quantumDim,
              borderRadius: 8,
              padding: "10px 14px",
            }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'IBM Plex Mono', monospace",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: theme.quantum,
                display: "block",
                marginBottom: 6,
              }}>
                QRNG
              </span>
              <span style={{
                fontSize: 12,
                lineHeight: 1.7,
                fontFamily: "'Outfit', sans-serif",
                color: theme.textDim,
              }}>
                {data.differences.qrng}
              </span>
            </div>
          </div>
        </div>

        {/* Why — callout with PRNG vs QRNG */}
        <div>
          <div style={headingStyle}>{data.why.heading}</div>
          <div style={{
            marginTop: 8,
            background: theme.accent + "0a",
            border: `1px solid ${theme.accent}25`,
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}>
            <div style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'IBM Plex Mono', monospace",
                color: theme.classical,
                minWidth: 38,
                flexShrink: 0,
              }}>
                PRNG
              </span>
              <span style={{
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: "'Outfit', sans-serif",
                color: theme.textDim,
              }}>
                {data.why.prng}
              </span>
            </div>
            <div style={{ height: 1, background: theme.border }} />
            <div style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'IBM Plex Mono', monospace",
                color: theme.quantum,
                minWidth: 38,
                flexShrink: 0,
              }}>
                QRNG
              </span>
              <span style={{
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: "'Outfit', sans-serif",
                color: theme.textDim,
              }}>
                {data.why.qrng}
              </span>
            </div>
          </div>
        </div>

        {/* Stats — dashboard style */}
        {data.stats && data.stats.length > 0 && (
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${data.stats.length}, 1fr)`,
            gap: 10,
            paddingTop: 4,
            borderTop: `1px solid ${theme.border}`,
          }}>
            {data.stats.map((s) => (
              <div key={s.label} style={{
                textAlign: "center",
                padding: "8px 4px",
              }}>
                <div style={{
                  fontSize: 16,
                  fontWeight: 700,
                  fontFamily: "'Space Grotesk', sans-serif",
                  color: theme.text,
                  lineHeight: 1.2,
                }}>
                  {s.value}
                </div>
                <div style={{
                  fontSize: 8,
                  fontWeight: 600,
                  fontFamily: "'IBM Plex Mono', monospace",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: theme.textMuted,
                  marginTop: 4,
                }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
