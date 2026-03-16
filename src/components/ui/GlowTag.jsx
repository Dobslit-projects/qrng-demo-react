export default function GlowTag({ color, children }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 10px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "'IBM Plex Mono', monospace",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: color,
        background: color + "12",
        border: `1px solid ${color}25`,
      }}
    >
      {children}
    </span>
  );
}
