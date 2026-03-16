import { theme } from "../../theme";
import GlowTag from "./GlowTag";

export default function Section({ title, tag, tagColor, children, description }) {
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 14,
        padding: "24px 28px",
        marginBottom: 20,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: description ? 8 : 20,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 17,
            fontWeight: 600,
            fontFamily: "'Outfit', sans-serif",
            color: theme.text,
          }}
        >
          {title}
        </h2>
        {tag && <GlowTag color={tagColor || theme.accent}>{tag}</GlowTag>}
      </div>
      {description && (
        <p
          style={{
            margin: "0 0 20px",
            fontSize: 13,
            lineHeight: 1.7,
            color: theme.textDim,
            fontFamily: "'Outfit', sans-serif",
            maxWidth: 700,
          }}
        >
          {description}
        </p>
      )}
      {children}
    </div>
  );
}
