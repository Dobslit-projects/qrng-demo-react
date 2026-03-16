import { useState, useRef, useEffect, useCallback, useContext } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { connectQRNGStream } from "../../qrngApi";
import Btn from "../ui/Btn";

const mono = "'IBM Plex Mono', monospace";

const VIZ_MODES = [
  { id: "waveform", label: "Waveform" },
  { id: "matrix", label: "Matrix" },
  { id: "particles", label: "Partículas" },
];

export default function StreamPanel() {
  const { isOnline, streamError, setStreamError } = useContext(AppContext);
  const [streaming, setStreaming] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [vizMode, setVizMode] = useState("waveform");
  const [stats, setStats] = useState({ bytes: 0, startTime: null, rate: 0 });

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const bufferRef = useRef(new Uint8Array(2048));
  const bufferPosRef = useRef(0);
  const abortRef = useRef(null);
  const rafRef = useRef(null);
  const statsIntervalRef = useRef(null);
  const totalBytesRef = useRef(0);
  const lastFrameRef = useRef(0);
  const canvasSizeRef = useRef({ w: 800, h: 200 });
  const particlesRef = useRef([]);
  const matrixRowsRef = useRef([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        canvasSizeRef.current = { w: Math.floor(width), h: Math.floor(height) };
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startStream = useCallback(() => {
    if (!isOnline) return;
    setStreamError(null);
    setStalled(false);
    totalBytesRef.current = 0;
    bufferPosRef.current = 0;
    particlesRef.current = [];
    matrixRowsRef.current = [];
    const startTime = Date.now();
    setStats({ bytes: 0, startTime, rate: 0 });
    setStreaming(true);

    const abort = connectQRNGStream(
      (chunk) => {
        if (streamError) setStreamError(null);
        const buf = bufferRef.current;
        for (let i = 0; i < chunk.length; i++) {
          buf[bufferPosRef.current % buf.length] = chunk[i];
          bufferPosRef.current++;
        }
        totalBytesRef.current += chunk.length;
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          particlesRef.current.push({ x: chunk[i] / 255, y: chunk[i + 1] / 255, born: Date.now() });
        }
        if (particlesRef.current.length > 4000) {
          particlesRef.current = particlesRef.current.slice(-4000);
        }
        const row = [];
        for (let i = 0; i < chunk.length; i++) row.push(chunk[i]);
        matrixRowsRef.current.push(...row);
        if (matrixRowsRef.current.length > 2048) {
          matrixRowsRef.current = matrixRowsRef.current.slice(-2048);
        }
      },
      (err) => {
        setStreaming(false);
        setStalled(false);
        if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
        setStreamError(err?.message || "Erro desconhecido");
      },
      () => { setStreaming(false); setStalled(false); },
      (isStalled) => setStalled(isStalled)
    );
    abortRef.current = abort;

    statsIntervalRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      setStats({
        bytes: totalBytesRef.current,
        startTime,
        rate: elapsed > 0 ? Math.round(totalBytesRef.current / elapsed) : 0,
      });
    }, 500);
  }, [isOnline, streamError, setStreamError]);

  const stopStream = useCallback(() => {
    if (abortRef.current) abortRef.current();
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setStreaming(false);
    setStalled(false);
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current();
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Rendering loop
  useEffect(() => {
    if (!streaming) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = (timestamp) => {
      if (timestamp - lastFrameRef.current < 33) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      lastFrameRef.current = timestamp;

      const { w: W, h: H } = canvasSizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + "px";
        canvas.style.height = H + "px";
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      if (vizMode === "waveform") {
        ctx.strokeStyle = theme.border + "30";
        ctx.lineWidth = 0.5;
        for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

        const buf = bufferRef.current;
        const pos = bufferPosRef.current;
        const len = Math.min(pos, buf.length);
        if (len < 2) { rafRef.current = requestAnimationFrame(draw); return; }

        // Glow line
        ctx.save();
        ctx.shadowColor = theme.quantum;
        ctx.shadowBlur = 12;
        ctx.strokeStyle = theme.quantum + "50";
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const x = (i / len) * W;
          const idx = (pos - len + i + buf.length) % buf.length;
          const y = (1 - buf[idx] / 255) * (H - 16) + 8;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();

        // Sharp line
        ctx.strokeStyle = theme.quantum;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const x = (i / len) * W;
          const idx = (pos - len + i + buf.length) % buf.length;
          const y = (1 - buf[idx] / 255) * (H - 16) + 8;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

      } else if (vizMode === "matrix") {
        const data = matrixRowsRef.current;
        const cellW = 16, cellH = 16;
        const cols = Math.floor(W / cellW);
        const rows = Math.floor(H / cellH);
        const startIdx = Math.max(0, data.length - cols * rows);
        ctx.font = "10px " + mono;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const di = startIdx + r * cols + c;
            if (di >= data.length) break;
            const byte = data[di];
            const alpha = 0.15 + (byte / 255) * 0.85;
            ctx.fillStyle = `rgba(12, 140, 233, ${alpha})`;
            ctx.fillText(byte.toString(16).padStart(2, "0").toUpperCase(), c * cellW + cellW / 2, r * cellH + cellH / 2);
          }
        }

      } else if (vizMode === "particles") {
        const now = Date.now();
        const particles = particlesRef.current;
        ctx.fillStyle = "#0a0e17" + "08";
        ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          const age = (now - p.born) / 1000;
          if (age > 4) continue;
          const alpha = Math.max(0, 1 - age / 4);
          ctx.beginPath();
          ctx.arc(p.x * W, p.y * H, 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(12, 140, 233, ${alpha * 0.8})`;
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [streaming, vizMode]);

  const elapsed = stats.startTime ? Math.round((Date.now() - stats.startTime) / 1000) : 0;

  return (
    <div style={{
      background: theme.surface,
      borderRadius: 12,
      border: `1px solid ${theme.border}`,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderBottom: `1px solid ${theme.border}`,
        background: theme.quantumDim,
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700, fontFamily: mono,
          color: theme.quantum, letterSpacing: "0.04em",
        }}>
          STREAM QRNG
        </span>

        <div style={{ width: 1, height: 18, background: theme.border }} />

        <Btn
          onClick={streaming ? stopStream : startStream}
          color={streaming ? theme.danger : theme.quantum}
          disabled={!isOnline}
          small
        >
          {streaming ? "Parar" : "Iniciar Stream"}
        </Btn>

        {/* Viz mode pills */}
        <div style={{ display: "flex", gap: 3 }}>
          {VIZ_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setVizMode(m.id)}
              style={{
                padding: "3px 10px",
                borderRadius: 12,
                border: `1px solid ${vizMode === m.id ? theme.quantum : theme.border}`,
                background: vizMode === m.id ? theme.quantum + "15" : "transparent",
                color: vizMode === m.id ? theme.quantum : theme.textMuted,
                fontSize: 9, fontWeight: 600, fontFamily: mono,
                cursor: "pointer", transition: "all 0.15s",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Stats */}
        {streaming && (
          <div style={{
            display: "flex", gap: 14, fontSize: 10, fontFamily: mono,
            color: theme.textDim, marginLeft: "auto",
          }}>
            <span>
              <strong style={{ color: theme.quantum }}>{formatBytes(stats.bytes)}</strong>
            </span>
            <span>
              <strong style={{ color: theme.quantum }}>{formatBytes(stats.rate)}/s</strong>
            </span>
            <span>
              <strong style={{ color: theme.quantum }}>{elapsed}s</strong>
            </span>
          </div>
        )}

        {!streaming && (
          <span style={{
            fontSize: 10, color: theme.textMuted, fontFamily: mono, marginLeft: "auto",
          }}>
            {isOnline
              ? "Pronto para visualizar bytes quânticos em tempo real"
              : "Backend offline — stream indisponível"
            }
          </span>
        )}
      </div>

      {/* Alerts */}
      {stalled && streaming && (
        <div style={{
          padding: "8px 16px", fontSize: 10, color: theme.warning,
          background: theme.warning + "10",
          borderBottom: `1px solid ${theme.warning}20`,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%", background: theme.warning,
            display: "inline-block", animation: "pulse 1.5s infinite",
          }} />
          Aguardando dados do hardware QRNG...
        </div>
      )}
      {streamError && !streaming && (
        <div style={{
          padding: "8px 16px", fontSize: 10, color: theme.danger,
          background: theme.danger + "10",
          borderBottom: `1px solid ${theme.danger}20`,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span>Desconectado: {streamError}</span>
          <Btn onClick={() => { setStreamError(null); startStream(); }} color={theme.danger} small>
            Reconectar
          </Btn>
        </div>
      )}

      {/* Canvas — always visible */}
      <div
        ref={containerRef}
        style={{
          height: 180,
          background: "#0a0e17",
          position: "relative",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
        {/* Overlay when not streaming */}
        {!streaming && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(10, 14, 23, 0.7)",
          }}>
            <span style={{
              fontSize: 12, color: theme.textMuted, fontFamily: mono,
              letterSpacing: "0.04em",
            }}>
              {isOnline
                ? "Clique em \"Iniciar Stream\" para visualizar"
                : "Backend offline"
              }
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
