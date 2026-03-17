import { useContext } from "react";
import { AppProvider, AppContext } from "./contexts/AppContext";
import { theme, fonts } from "./theme";
import HardwareStatusBar from "./components/layout/HardwareStatusBar";
import SectionNav from "./components/layout/SectionNav";
import AnalysisSection from "./components/analysis/AnalysisSection";
import InteractiveDemos from "./components/games/InteractiveDemos";
import DataSection from "./components/data/DataSection";
import SettingsSection from "./components/settings/SettingsSection";

function AppContent() {
  const { activePage } = useContext(AppContext);

  return (
    <div
      style={{
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: theme.bg,
        color: theme.text,
        fontFamily: "'Outfit', sans-serif",
      }}
    >
      <style>{fonts}</style>
      <HardwareStatusBar />
      <SectionNav />
      <div style={{ flex: 1, overflow: "auto", padding: activePage === "settings" ? 0 : "12px 16px" }}>
        {activePage === "analysis" && <AnalysisSection />}
        {activePage === "games" && <InteractiveDemos />}
        {activePage === "data" && <DataSection />}
        {activePage === "settings" && <SettingsSection />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
