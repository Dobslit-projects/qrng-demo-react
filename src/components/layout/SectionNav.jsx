import { useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { useLanguage } from "../../contexts/LanguageContext";

const pages = [
  { id: "kapua",        key: "navKapua" },
  { id: "visuals",      key: "navVisuals" },
  { id: "data",         key: "navData" },
  { id: "applications", key: "navApplications" },
  { id: "nist",         key: "navNist" },
  { id: "developer",    key: "navDeveloper" },
  { id: "settings",     key: "navSettings" },
];

export default function SectionNav() {
  const { activePage, setActivePage } = useContext(AppContext);
  const { t } = useLanguage();

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
        // Em telas estreitas os 7 rótulos (sem quebra de linha) não cabem na
        // largura visível; sem rolagem horizontal, os botões que ultrapassam
        // a borda ficam fora da área tocável -- pareciam "não responder" no
        // mobile. Agora a barra rola horizontalmente em vez de estourar.
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
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
            flexShrink: 0,
          }}
        >
          {t(p.key)}
        </button>
      ))}
    </div>
  );
}
