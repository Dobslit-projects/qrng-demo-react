import { theme } from "../../theme";

export default function BitStream({ bits, color, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          fontSize: 9,
          fontFamily: "'IBM Plex Mono', monospace",
          color: theme.textMuted,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {bits.map((b, i) => (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 700,
              fontFamily: "'IBM Plex Mono', monospace",
              background: b === 1 ? color + "18" : theme.surfaceAlt,
              color: b === 1 ? color : theme.textMuted,
              border: `1px solid ${b === 1 ? color + "40" : theme.border}`,
            }}
          >
            {b}
          </span>
        ))}
      </div>
    </div>
  );
}
