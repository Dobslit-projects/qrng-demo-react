export const fonts = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap');
`;

export const theme = {
  bg: "#f5f7fa",
  surface: "#ffffff",
  surfaceAlt: "#f0f2f5",
  border: "#dfe3ea",
  borderHover: "#c5cbda",
  text: "#1a1f2e",
  textDim: "#5a6278",
  textMuted: "#8c94a8",
  classical: "#d94a2e",
  classicalDim: "#d94a2e20",
  classicalGlow: "#d94a2e10",
  quantum: "#0c8ce9",
  quantumDim: "#0c8ce920",
  quantumGlow: "#0c8ce910",
  accent: "#1a8fc4",
  danger: "#dc3545",
  success: "#0fa968",
  warning: "#e8a317",
};

export function formatBytes(n) {
  if (n === null || n === undefined) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let x = n, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
