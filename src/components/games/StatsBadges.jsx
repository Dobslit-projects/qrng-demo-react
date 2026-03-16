import { useMemo } from "react";
import { theme } from "../../theme";
import { monobitTest, runsTest, chiSquareTest, shannonEntropy } from "./statsTests";

function Badge({ test, accentColor }) {
  const bg = test.passed === null
    ? theme.surfaceAlt
    : test.passed
      ? theme.success + "14"
      : theme.danger + "14";
  const border = test.passed === null
    ? theme.border
    : test.passed
      ? theme.success + "50"
      : theme.danger + "50";
  const icon = test.passed === null ? "?" : test.passed ? "\u2713" : "\u2717";
  const iconColor = test.passed === null
    ? theme.textMuted
    : test.passed
      ? theme.success
      : theme.danger;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 5,
      background: bg, border: `1px solid ${border}`,
      fontSize: 9, fontFamily: "'IBM Plex Mono', monospace",
      whiteSpace: "nowrap",
    }}>
      <span style={{ fontWeight: 800, fontSize: 10, color: iconColor }}>{icon}</span>
      <span style={{ color: theme.textDim, fontWeight: 500 }}>{test.label}</span>
      <span style={{ color: accentColor, fontWeight: 700 }}>{test.value}</span>
    </div>
  );
}

function SourceRow({ label, bytes, color }) {
  const tests = useMemo(() => {
    if (!bytes || bytes.length < 20) {
      return [
        { passed: null, value: "-", label: "Monobit" },
        { passed: null, value: "-", label: "Runs" },
        { passed: null, value: "-", label: "Chi\u00B2" },
        { passed: null, value: "-", label: "Entropia" },
      ];
    }
    return [
      monobitTest(bytes),
      runsTest(bytes),
      chiSquareTest(bytes),
      shannonEntropy(bytes),
    ];
  }, [bytes]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{
        fontSize: 8, fontWeight: 700, color,
        fontFamily: "'IBM Plex Mono', monospace",
        minWidth: 32, textAlign: "right",
      }}>
        {label}
      </span>
      {tests.map((t, i) => (
        <Badge key={i} test={t} accentColor={color} />
      ))}
    </div>
  );
}

export default function StatsBadges({ prngBytes, qrngBytes }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 3,
      flexShrink: 0, padding: "5px 8px",
      background: theme.surface, borderRadius: 8,
      border: `1px solid ${theme.border}`,
    }}>
      <SourceRow label="PRNG" bytes={prngBytes} color={theme.classical} />
      <SourceRow label="QRNG" bytes={qrngBytes} color={theme.quantum} />
    </div>
  );
}
