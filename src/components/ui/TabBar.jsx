import { theme } from "../../theme";

export default function TabBar({ tabs, activeTab, onTabChange }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        marginBottom: 20,
        background: theme.surfaceAlt,
        borderRadius: 10,
        padding: 4,
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onTabChange(t.id)}
          style={{
            flex: 1,
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: activeTab === t.id ? "#ffffff" : "transparent",
            color: activeTab === t.id ? theme.text : theme.textMuted,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "'IBM Plex Mono', monospace",
            cursor: "pointer",
            transition: "all 0.2s ease",
            boxShadow: activeTab === t.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
