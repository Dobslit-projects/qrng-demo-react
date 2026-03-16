export default function Btn({ onClick, color, children, small, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: small ? "6px 14px" : "10px 20px",
        borderRadius: 8,
        border: `1px solid ${color}40`,
        background: color + "10",
        color: color,
        fontSize: small ? 12 : 13,
        fontWeight: 600,
        fontFamily: "'IBM Plex Mono', monospace",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "all 0.2s ease",
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </button>
  );
}
