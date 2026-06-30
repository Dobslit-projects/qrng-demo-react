import { useContext } from "react";
import { AppProvider, AppContext } from "./contexts/AppContext";
import { theme, fonts } from "./theme";
import HardwareStatusBar from "./components/layout/HardwareStatusBar";
import SectionNav from "./components/layout/SectionNav";
import KapuaSection from "./components/kapua/KapuaSection";
import VisuaisSection from "./components/visuals/VisuaisSection";
import DataSection from "./components/data/DataSection";
import ApplicationsSection from "./components/applications/ApplicationsSection";
import SettingsSection from "./components/settings/SettingsSection";
import DeveloperPage from "./components/developer/DeveloperPage";
import NISTSection from "./components/nist/NISTSection";

const NO_PADDING_PAGES = new Set(["kapua", "visuals", "data", "applications", "settings"]);

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
      <div style={{ flex: 1, overflow: "auto", padding: NO_PADDING_PAGES.has(activePage) ? 0 : "12px 16px" }}>
        {activePage === "kapua"        && <KapuaSection />}
        {activePage === "visuals"      && <VisuaisSection />}
        {activePage === "data"         && <DataSection />}
        {activePage === "applications" && <ApplicationsSection />}
        {activePage === "nist"         && <NISTSection />}
        {activePage === "developer"    && <DeveloperPage />}
        {activePage === "settings"     && <SettingsSection />}
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
