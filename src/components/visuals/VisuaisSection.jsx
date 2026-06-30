import { useState } from "react";
import { theme } from "../../theme";
import AnalysisSection from "../analysis/AnalysisSection";
import InteractiveDemos from "../games/InteractiveDemos";

const mono = "'IBM Plex Mono', monospace";

const TABS = [
  { id: "interactive", label: "Visualizações Interativas" },
  { id: "analysis",    label: "Análise Estatística" },
];

export default function VisuaisSection() {
  const [activeTab, setActiveTab] = useState("interactive");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Sub-tab bar */}
      <div style={{
        display: "flex",
        gap: 4,
        padding: "8px 12px",
        background: theme.surface,
        borderBottom: `1px solid ${theme.border}`,
        flexShrink: 0,
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: "6px 16px",
              border: "none",
              borderBottom: activeTab === t.id ? `2px solid ${theme.quantum}` : "2px solid transparent",
              borderRadius: 0,
              background: activeTab === t.id ? theme.quantum + "15" : "transparent",
              color: activeTab === t.id ? theme.quantum : theme.textMuted,
              fontSize: 11,
              fontWeight: 700,
              fontFamily: mono,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {activeTab === "interactive" && <InteractiveDemos />}
        {activeTab === "analysis"    && (
          <div style={{ padding: "12px 16px", height: "100%", boxSizing: "border-box" }}>
            <AnalysisSection />
          </div>
        )}
      </div>
    </div>
  );
}
