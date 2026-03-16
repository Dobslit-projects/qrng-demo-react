import { theme } from "../../theme";

export default function StatBox({ label, value, color }) {
  return (
    <div
      style={{
        flex: 1,
        padding: "12px 16px",
        borderRadius: 10,
        background: theme.surfaceAlt,
        border: `1px solid ${theme.border}`,
        minWidth: 100,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: theme.textMuted,
          fontFamily: "'IBM Plex Mono', monospace",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          fontFamily: "'IBM Plex Mono', monospace",
          color: color || theme.text,
        }}
      >
        {value}
      </div>
    </div>
  );
}
