import { useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";

const STEPS = [
  { label: "Red Pitaya", sub: "FPGA" },
  { label: "Ruido Q.", sub: "Fotons" },
  { label: "ADC", sub: "14-bit" },
  { label: "API REST", sub: null },
  { label: "Este Demo", sub: "Canvas" },
];

const keyframes = `
@keyframes pipeFlow {
  0% { transform: translateX(-8px); opacity: 0; }
  20% { opacity: 1; }
  80% { opacity: 1; }
  100% { transform: translateX(8px); opacity: 0; }
}
@keyframes pipeGlow {
  0%, 100% { box-shadow: 0 0 4px ${theme.quantum}40; }
  50% { box-shadow: 0 0 10px ${theme.quantum}80; }
}
`;

function Arrow({ online }) {
  const color = online ? theme.quantum : theme.textMuted;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
      <div style={{
        width: 18, height: 2, background: color + "60",
        position: "relative", overflow: "hidden",
      }}>
        {online && (
          <>
            <div style={{
              width: 4, height: 4, borderRadius: "50%", background: color,
              position: "absolute", top: -1,
              animation: "pipeFlow 1.2s linear infinite",
            }} />
            <div style={{
              width: 4, height: 4, borderRadius: "50%", background: color,
              position: "absolute", top: -1,
              animation: "pipeFlow 1.2s linear 0.6s infinite",
            }} />
          </>
        )}
      </div>
      <div style={{
        width: 0, height: 0,
        borderTop: "4px solid transparent",
        borderBottom: "4px solid transparent",
        borderLeft: `5px solid ${color}60`,
      }} />
    </div>
  );
}

export default function DataPipeline({ source, latency, bytesUsed }) {
  const { isOnline } = useContext(AppContext);

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: 0, flexShrink: 0, padding: "6px 8px",
      background: theme.surface, borderRadius: 8,
      border: `1px solid ${theme.border}`,
      overflow: "hidden",
    }}>
      <style>{keyframes}</style>
      {STEPS.map((step, i) => {
        const isApi = step.label === "API REST";
        const isLast = i === STEPS.length - 1;
        const active = isOnline;
        const color = active ? theme.quantum : theme.textMuted;

        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <div style={{
              padding: "3px 10px", borderRadius: 6,
              border: `1.5px solid ${color}40`,
              background: active ? color + "08" : "transparent",
              textAlign: "center", minWidth: 56,
              animation: active && !isLast ? "pipeGlow 3s ease-in-out infinite" : "none",
              animationDelay: `${i * 0.4}s`,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, color,
                fontFamily: "'IBM Plex Mono', monospace",
                whiteSpace: "nowrap",
              }}>
                {step.label}
              </div>
              <div style={{
                fontSize: 7, color: theme.textMuted,
                fontFamily: "'IBM Plex Mono', monospace",
                whiteSpace: "nowrap",
              }}>
                {isApi
                  ? (isOnline ? `${latency || "?"}ms` : "offline")
                  : (step.sub || "")}
              </div>
            </div>
            {!isLast && <Arrow online={active} />}
          </div>
        );
      })}

      <div style={{ width: 1, height: 20, background: theme.border, margin: "0 10px" }} />

      <div style={{
        fontSize: 8, color: isOnline ? theme.success : theme.warning,
        fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600,
        whiteSpace: "nowrap",
      }}>
        {isOnline ? `Fonte: ${source}` : "Fallback: Math.random()"}
      </div>
    </div>
  );
}
