import { useState, useRef, useEffect, useCallback, useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGBytes } from "../../qrngApi";
import { generatePRNGSequence, lcgNext } from "../../prng";

const GRID = 32;
const TOTAL = GRID * GRID; // 1024

function drawBitmap(canvas, bytes, color, gridSize) {
  if (!canvas || !bytes.length) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssSize = canvas.parentElement?.clientWidth || 160;
  const size = Math.min(cssSize, 180);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const cellSize = size / gridSize;
  // Parse color to RGB
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  for (let i = 0; i < bytes.length && i < gridSize * gridSize; i++) {
    const row = Math.floor(i / gridSize);
    const col = i % gridSize;
    const intensity = bytes[i] / 255;
    // Use color channel with varying alpha for intensity
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.08 + intensity * 0.92})`;
    ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
  }
}

export default function QuantumBitmap() {
  const { isOnline } = useContext(AppContext);
  const [prngBytes, setPrngBytes] = useState([]);
  const [qrngBytes, setQrngBytes] = useState([]);
  const [qrngSource, setQrngSource] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [genCount, setGenCount] = useState(0);
  const prngCanvasRef = useRef(null);
  const qrngCanvasRef = useRef(null);
  const seedRef = useRef(42);
  const autoRef = useRef(null);

  const generate = useCallback(async () => {
    setGenerating(true);

    // PRNG: generate 1024 bytes from LCG
    const pBytes = [];
    let s = seedRef.current;
    for (let i = 0; i < TOTAL; i++) {
      const r = lcgNext(s);
      pBytes.push(Math.floor(r.value * 256));
      s = r.nextSeed;
    }
    seedRef.current = s;
    setPrngBytes(pBytes);

    // QRNG: fetch 1024 bytes in ONE call
    let qBytes;
    let source = "fallback";
    if (isOnline) {
      try {
        const result = await fetchQRNGBytes(TOTAL);
        qBytes = result.bytes;
        source = "red-pitaya";
      } catch {
        // fallback below
      }
    }
    if (!qBytes || qBytes.length < TOTAL) {
      // Fallback: use Math.random (clearly NOT the same as PRNG)
      qBytes = Array.from({ length: TOTAL }, () => Math.floor(Math.random() * 256));
      source = "fallback";
    }
    setQrngBytes(qBytes);
    setQrngSource(source);
    setGenCount((c) => c + 1);
    setGenerating(false);
  }, [isOnline]);

  // Draw canvases when data changes
  useEffect(() => {
    drawBitmap(prngCanvasRef.current, prngBytes, theme.classical, GRID);
  }, [prngBytes, genCount]);

  useEffect(() => {
    drawBitmap(qrngCanvasRef.current, qrngBytes, theme.quantum, GRID);
  }, [qrngBytes, genCount]);

  // Auto mode
  useEffect(() => {
    if (autoMode) {
      generate();
      autoRef.current = setInterval(generate, 2500);
      return () => clearInterval(autoRef.current);
    } else {
      if (autoRef.current) clearInterval(autoRef.current);
    }
  }, [autoMode, generate]);

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4, fontFamily: "'Outfit', sans-serif" }}>
        Bitmap Quantico
      </div>
      <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 10, lineHeight: 1.4 }}>
        Cada pixel = 1 byte aleatorio. Observe os padroes no PRNG.
      </div>

      {/* Canvases side by side */}
      <div style={{ display: "flex", gap: 10, marginBottom: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 9, color: theme.classical, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>PRNG (LCG)</div>
          <canvas ref={prngCanvasRef} style={{ borderRadius: 6, border: `1px solid ${theme.classical}30`, background: theme.classical + "05" }} />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 9, color: theme.quantum, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>
            QRNG {qrngSource === "red-pitaya" ? "· Red Pitaya" : qrngSource === "fallback" ? "· ⚠ Fallback" : ""}
          </div>
          <canvas ref={qrngCanvasRef} style={{ borderRadius: 6, border: `1px solid ${theme.quantum}30`, background: theme.quantum + "05" }} />
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
        <button
          onClick={generate}
          disabled={generating || autoMode}
          style={{
            padding: "6px 14px", borderRadius: 6,
            border: `1px solid ${theme.success}40`, background: theme.success + "10",
            color: theme.success, fontSize: 11, fontWeight: 600,
            fontFamily: "'IBM Plex Mono', monospace",
            cursor: generating || autoMode ? "not-allowed" : "pointer",
            opacity: generating || autoMode ? 0.4 : 1,
          }}
        >
          Gerar
        </button>
        <button
          onClick={() => setAutoMode(!autoMode)}
          style={{
            padding: "6px 14px", borderRadius: 6,
            border: `1px solid ${autoMode ? theme.warning : theme.accent}40`,
            background: autoMode ? theme.warning + "15" : theme.accent + "10",
            color: autoMode ? theme.warning : theme.accent,
            fontSize: 11, fontWeight: 600,
            fontFamily: "'IBM Plex Mono', monospace",
            cursor: "pointer",
          }}
        >
          {autoMode ? "Parar" : "Auto"}
        </button>
        {genCount > 0 && (
          <span style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>
            {genCount}x gerado
          </span>
        )}
      </div>

      {genCount > 0 && (
        <div style={{ fontSize: 9, color: theme.textDim, fontFamily: "'IBM Plex Mono', monospace", marginTop: 6, lineHeight: 1.5, flexShrink: 0 }}>
          ↑ As linhas diagonais no PRNG sao artefatos da estrutura do LCG. O QRNG e ruido puro.
        </div>
      )}
    </>
  );
}
