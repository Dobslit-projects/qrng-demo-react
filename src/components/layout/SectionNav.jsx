import { useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";

const pages = [
  { id: "analysis", label: "An\u00e1lise" },
  { id: "games", label: "Representa\u00e7\u00f5es Visuais" },
  { id: "data", label: "Dados" },
  { id: "settings", label: "\u2699 Configura\u00e7\u00f5es" },
];

export default function SectionNav() {
  const { activePage, setActivePage } = useContext(AppContext);

  return (
    <div
      style={{
        background: theme.bg,
        borderBottom: `1px solid ${theme.border}`,
        padding: "6px 20px",
        display: "flex",
        gap: 4,
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {pages.map((p) => (
        <button
          key={p.id}
          onClick={() => setActivePage(p.id)}
          style={{
            padding: "6px 16px",
            borderRadius: 8,
            border: "none",
            background: activePage === p.id ? theme.surface : "transparent",
            color: activePage === p.id ? theme.text : theme.textMuted,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "'IBM Plex Mono', monospace",
            cursor: "pointer",
            transition: "all 0.2s ease",
            boxShadow: activePage === p.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
            whiteSpace: "nowrap",
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
