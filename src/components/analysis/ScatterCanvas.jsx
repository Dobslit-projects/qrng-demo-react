import { useRef, useEffect, useState } from "react";
import { theme } from "../../theme";

export default function ScatterCanvas({ points, color, label }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 280, h: 280 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        const s = Math.min(width, height);
        setSize({ w: s, h: s });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = size;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "#dfe3ea80";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * (w - 20) + 10;
      ctx.beginPath();
      ctx.moveTo(p, 10);
      ctx.lineTo(p, h - 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(10, p);
      ctx.lineTo(w - 10, p);
      ctx.stroke();
    }

    for (let i = 0; i < points.length - 1; i += 2) {
      const x = points[i] * (w - 20) + 10;
      const y = points[i + 1] * (h - 20) + 10;
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = color + "cc";
      ctx.fill();
    }
  }, [points, color, size]);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: size.w,
          height: size.h,
          borderRadius: 10,
          border: `1px solid ${theme.border}`,
          background: "#ffffff",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 8,
          right: 8,
          fontSize: 9,
          fontFamily: "'IBM Plex Mono', monospace",
          color: theme.textMuted,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}
