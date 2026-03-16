import { useState, useRef, useEffect, useCallback, useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGBytes } from "../../qrngApi";
import { lcgNext } from "../../prng";

const PI = Math.PI;

function drawPoints(canvas, points, insideColor, outsideColor) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssSize = Math.min(canvas.parentElement?.clientWidth || 160, 180);
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  canvas.style.width = cssSize + "px";
  canvas.style.height = cssSize + "px";
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = "#fafbfc";
  ctx.fillRect(0, 0, cssSize, cssSize);

  // Draw circle outline
  ctx.strokeStyle = "#dfe3ea";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cssSize / 2, cssSize / 2, cssSize / 2 - 2, 0, 2 * PI);
  ctx.stroke();

  // Draw points
  const margin = 2;
  const area = cssSize - margin * 2;
  for (const p of points) {
    const px = margin + p.x * area;
    const py = margin + p.y * area;
    ctx.beginPath();
    ctx.arc(px, py, 1.2, 0, 2 * PI);
    ctx.fillStyle = p.inside ? insideColor + "cc" : outsideColor + "30";
    ctx.fill();
  }
}

export default function MonteCarloPi() {
  const { isOnline } = useContext(AppContext);
  const [prngPoints, setPrngPoints] = useState([]);
  const [qrngPoints, setQrngPoints] = useState([]);
  const [prngInside, setPrngInside] = useState(0);
  const [qrngInside, setQrngInside] = useState(0);
  const [total, setTotal] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [qrngSource, setQrngSource] = useState(null);
  const prngCanvasRef = useRef(null);
  const qrngCanvasRef = useRef(null);
  const seedRef = useRef(42);

  const isInsideCircle = (x, y) => {
    const dx = x - 0.5;
    const dy = y - 0.5;
    return dx * dx + dy * dy <= 0.25;
  };

  const addPoints = useCallback(async (count) => {
    setGenerating(true);

    // PRNG: generate count*2 floats (x, y pairs)
    const newPrng = [];
    let pIn = 0;
    let s = seedRef.current;
    for (let i = 0; i < count; i++) {
      const rx = lcgNext(s);
      const ry = lcgNext(rx.nextSeed);
      s = ry.nextSeed;
      const x = rx.value;
      const y = ry.value;
      const inside = isInsideCircle(x, y);
      if (inside) pIn++;
      newPrng.push({ x, y, inside });
    }
    seedRef.current = s;

    // QRNG: fetch count*2 bytes, pair as (x, y)
    const newQrng = [];
    let qIn = 0;
    let source = "fallback";
    let qBytes;
    if (isOnline) {
      try {
        const result = await fetchQRNGBytes(count * 2);
        qBytes = result.bytes;
        source = "red-pitaya";
      } catch {}
    }
    if (!qBytes || qBytes.length < count * 2) {
      qBytes = Array.from({ length: count * 2 }, () => Math.floor(Math.random() * 256));
      source = "fallback";
    }
    for (let i = 0; i < count; i++) {
      const x = qBytes[i * 2] / 255;
      const y = qBytes[i * 2 + 1] / 255;
      const inside = isInsideCircle(x, y);
      if (inside) qIn++;
      newQrng.push({ x, y, inside });
    }
    setQrngSource(source);

    setPrngPoints((prev) => [...prev, ...newPrng]);
    setQrngPoints((prev) => [...prev, ...newQrng]);
    setPrngInside((prev) => prev + pIn);
    setQrngInside((prev) => prev + qIn);
    setTotal((prev) => prev + count);
    setGenerating(false);
  }, [isOnline]);

  // Redraw on data change
  useEffect(() => {
    drawPoints(prngCanvasRef.current, prngPoints, theme.classical, theme.classical);
  }, [prngPoints]);

  useEffect(() => {
    drawPoints(qrngCanvasRef.current, qrngPoints, theme.quantum, theme.quantum);
  }, [qrngPoints]);

  const reset = () => {
    setPrngPoints([]);
    setQrngPoints([]);
    setPrngInside(0);
    setQrngInside(0);
    setTotal(0);
    seedRef.current = 42;
    // Clear canvases
    [prngCanvasRef, qrngCanvasRef].forEach((ref) => {
      if (ref.current) {
        const ctx = ref.current.getContext("2d");
        ctx.clearRect(0, 0, ref.current.width, ref.current.height);
      }
    });
  };

  const prngPi = total > 0 ? (4 * prngInside) / total : 0;
  const qrngPi = total > 0 ? (4 * qrngInside) / total : 0;
  const prngErr = total > 0 ? (Math.abs(prngPi - PI) / PI) * 100 : 0;
  const qrngErr = total > 0 ? (Math.abs(qrngPi - PI) / PI) * 100 : 0;

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4, fontFamily: "'Outfit', sans-serif" }}>
        Monte Carlo π
      </div>
      <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8, lineHeight: 1.4 }}>
        Pontos aleatorios estimam π. Qualidade da fonte impacta precisao.
      </div>

      {/* Canvases */}
      <div style={{ display: "flex", gap: 10, marginBottom: 6, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 9, color: theme.classical, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>PRNG</div>
          <canvas ref={prngCanvasRef} style={{ borderRadius: 6, border: `1px solid ${theme.classical}30` }} />
          {total > 0 && (
            <div style={{ fontSize: 11, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: theme.classical, marginTop: 4 }}>
              π ≈ {prngPi.toFixed(4)}
            </div>
          )}
          {total > 0 && (
            <div style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: theme.textMuted }}>
              erro: {prngErr.toFixed(2)}%
            </div>
          )}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 9, color: theme.quantum, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>
            QRNG {qrngSource === "red-pitaya" ? "· RP" : qrngSource ? "· ⚠" : ""}
          </div>
          <canvas ref={qrngCanvasRef} style={{ borderRadius: 6, border: `1px solid ${theme.quantum}30` }} />
          {total > 0 && (
            <div style={{ fontSize: 11, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: theme.quantum, marginTop: 4 }}>
              π ≈ {qrngPi.toFixed(4)}
            </div>
          )}
          {total > 0 && (
            <div style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: theme.textMuted }}>
              erro: {qrngErr.toFixed(2)}%
            </div>
          )}
        </div>
      </div>

      {/* Point count */}
      {total > 0 && (
        <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", textAlign: "center", marginBottom: 4, flexShrink: 0 }}>
          {total.toLocaleString()} pontos · π real = 3.14159...
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: "flex", gap: 4, justifyContent: "center", flexShrink: 0, flexWrap: "wrap" }}>
        {[100, 500, 2000].map((n) => (
          <button
            key={n}
            onClick={() => addPoints(n)}
            disabled={generating}
            style={{
              padding: "6px 10px", borderRadius: 6,
              border: `1px solid ${theme.success}40`, background: theme.success + "10",
              color: theme.success, fontSize: 10, fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: generating ? "not-allowed" : "pointer",
              opacity: generating ? 0.4 : 1,
            }}
          >
            +{n}
          </button>
        ))}
        {total > 0 && (
          <button
            onClick={reset}
            style={{
              padding: "6px 10px", borderRadius: 6,
              border: `1px solid ${theme.danger}40`, background: theme.danger + "10",
              color: theme.danger, fontSize: 10, fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer",
            }}
          >
            Reset
          </button>
        )}
      </div>
    </>
  );
}
