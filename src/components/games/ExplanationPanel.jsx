import { useState, useEffect } from "react";
import { theme } from "../../theme";
import { explanations } from "./explanationData";

const STORAGE_KEY = "qdpr-explain-expanded";

/* ── tiny sub-components ─────────────────────────────────── */

function ExplainCard({ heading, text }) {
  return (
    <div
      style={{
        background: theme.surfaceAlt,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          fontFamily: "'IBM Plex Mono', monospace",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: theme.textMuted,
        }}
      >
        {heading}
      </span>
      <span
        style={{
          fontSize: 11,
          lineHeight: 1.55,
          fontFamily: "'Outfit', sans-serif",
          color: theme.textDim,
        }}
      >
        {text}
      </span>
    </div>
  );
}

function DifferencesCard({ heading, prng, qrng }) {
  return (
    <div
      style={{
        background: theme.surfaceAlt,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          fontFamily: "'IBM Plex Mono', monospace",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: theme.textMuted,
        }}
      >
        {heading}
      </span>

      {/* PRNG side */}
      <div
        style={{
          borderLeft: `3px solid ${theme.classical}`,
          background: theme.classicalDim,
          borderRadius: 4,
          padding: "6px 10px",
        }}
      >
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            fontFamily: "'IBM Plex Mono', monospace",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: theme.classical,
            display: "block",
            marginBottom: 3,
          }}
        >
          PRNG (LCG)
        </span>
        <span
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: "'Outfit', sans-serif",
            color: theme.textDim,
          }}
        >
          {prng}
        </span>
      </div>

      {/* QRNG side */}
      <div
        style={{
          borderLeft: `3px solid ${theme.quantum}`,
          background: theme.quantumDim,
          borderRadius: 4,
          padding: "6px 10px",
        }}
      >
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            fontFamily: "'IBM Plex Mono', monospace",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: theme.quantum,
            display: "block",
            marginBottom: 3,
          }}
        >
          QRNG
        </span>
        <span
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: "'Outfit', sans-serif",
            color: theme.textDim,
          }}
        >
          {qrng}
        </span>
      </div>
    </div>
  );
}

function StatsRow({ stats }) {
  if (!stats || stats.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        padding: "6px 0 0",
        borderTop: `1px solid ${theme.border}`,
        marginTop: 4,
      }}
    >
      {stats.map((s) => (
        <span
          key={s.label}
          style={{
            fontSize: 9,
            fontFamily: "'IBM Plex Mono', monospace",
            color: theme.textMuted,
          }}
        >
          <strong style={{ color: theme.textDim }}>{s.label}:</strong> {s.value}
        </span>
      ))}
    </div>
  );
}

/* ── main panel ──────────────────────────────────────────── */

export default function ExplanationPanel({ mode }) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, expanded);
    } catch {
      /* noop */
    }
  }, [expanded]);

  const data = explanations[mode];
  if (!data) return null;

  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* Header (always visible, clickable) */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          cursor: "pointer",
          userSelect: "none",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = theme.surfaceAlt)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            fontFamily: "'IBM Plex Mono', monospace",
            color: theme.textDim,
          }}
        >
          <span style={{ color: theme.accent, marginRight: 6 }}>
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
          Entenda: {data.title}
        </span>
        <span
          style={{
            fontSize: 8,
            fontFamily: "'IBM Plex Mono', monospace",
            color: theme.textMuted,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {expanded ? "recolher" : "expandir"}
        </span>
      </div>

      {/* Collapsible content */}
      <div
        style={{
          maxHeight: expanded ? 500 : 0,
          overflow: "hidden",
          transition: "max-height 0.35s ease",
        }}
      >
        <div style={{ padding: "0 12px 10px" }}>
          {/* 3-column grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 8,
            }}
          >
            <ExplainCard heading={data.algorithm.heading} text={data.algorithm.text} />
            <DifferencesCard
              heading={data.differences.heading}
              prng={data.differences.prng}
              qrng={data.differences.qrng}
            />
            <ExplainCard heading={data.why.heading} text={data.why.text} />
          </div>

          {/* Tech stats */}
          <StatsRow stats={data.stats} />
        </div>
      </div>
    </div>
  );
}
