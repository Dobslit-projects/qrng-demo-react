import { useRef, useEffect, useState, useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGBytes, CLIENT_API } from "../../qrngApi";

const mono = "'IBM Plex Mono', monospace";
const sans = "'Outfit', sans-serif";

/* ── Particle canvas ────────────────────────────────────────── */

function QuantumParticles() {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);
  const particles = useRef([]);
  const W = useRef(0);
  const H = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext("2d");

    const resize = () => {
      W.current = canvas.offsetWidth;
      H.current = canvas.offsetHeight;
      canvas.width  = W.current * devicePixelRatio;
      canvas.height = H.current * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
      init();
    };

    const init = () => {
      const n = Math.floor((W.current * H.current) / 4000);
      particles.current = Array.from({ length: Math.max(n, 60) }, () => ({
        x:   Math.random() * W.current,
        y:   Math.random() * H.current,
        r:   Math.random() * 2.2 + 0.4,
        vx:  (Math.random() - 0.5) * 0.35,
        vy:  (Math.random() - 0.5) * 0.35,
        a:   Math.random() * 0.7 + 0.15,
        hue: 200 + Math.random() * 40,
      }));
    };

    const draw = () => {
      const w = W.current, h = H.current;
      ctx.clearRect(0, 0, w, h);

      // Faint radial glow in centre
      const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.55);
      grad.addColorStop(0,   "rgba(12,140,233,0.08)");
      grad.addColorStop(0.5, "rgba(12,140,233,0.03)");
      grad.addColorStop(1,   "rgba(12,140,233,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Particles
      for (const p of particles.current) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -5) p.x = w + 5;
        if (p.x > w + 5) p.x = -5;
        if (p.y < -5) p.y = h + 5;
        if (p.y > h + 5) p.y = -5;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 85%, 60%, ${p.a})`;
        ctx.fill();
      }

      // Connecting lines between nearby particles
      const ps = particles.current;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const dx = ps[i].x - ps[j].x;
          const dy = ps[i].y - ps[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 90) {
            ctx.beginPath();
            ctx.moveTo(ps[i].x, ps[i].y);
            ctx.lineTo(ps[j].x, ps[j].y);
            ctx.strokeStyle = `rgba(12,140,233,${0.08 * (1 - dist / 90)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
    />
  );
}

/* ── Server Hardware 3D ─────────────────────────────────────── */

function ServerHardware3D() {
  const ledStyle = (color, delay = "0s") => ({
    width: 7, height: 7, borderRadius: "50%",
    background: color,
    boxShadow: `0 0 6px ${color}`,
    animation: `qled 2s ${delay} ease-in-out infinite`,
  });

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "10px 0 0" }}>
      <style>{`
        @keyframes qled { 0%,100%{opacity:.5} 50%{opacity:1} }
        @keyframes qledFast { 0%,100%{opacity:.3} 50%{opacity:1} }
      `}</style>
      <div style={{
        perspective: "1100px", perspectiveOrigin: "50% 35%",
        width: "100%", maxWidth: 520,
      }}>
        <div style={{
          width: "100%", maxWidth: 480,
          margin: "0 auto",
          position: "relative",
          transformStyle: "preserve-3d",
          transform: "rotateX(28deg) rotateY(-36deg)",
          filter: "drop-shadow(0 18px 36px rgba(0,0,0,0.7))",
        }}>
          {/* Top face */}
          <div style={{
            position: "absolute",
            width: "100%", height: 190,
            background: "linear-gradient(135deg, #1c1c2e 0%, #12121e 60%, #0d0d18 100%)",
            transformOrigin: "0% 100%",
            transform: "rotateX(90deg)",
            borderTop: "1px solid #333355",
            borderLeft: "1px solid #333355",
            borderRight: "1px solid #222235",
            display: "flex", alignItems: "center",
            padding: "0 20px", gap: 0, overflow: "hidden",
          }}>
            {/* DOBSLIT brand area */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
                  <path d="M50 10 C20 10 10 30 10 50 C10 70 25 85 50 90 C75 85 90 70 90 50 C90 30 80 10 50 10Z" fill="#0c8ce9" opacity="0.9"/>
                  <path d="M35 45 L50 25 L65 45 L55 45 L55 70 L45 70 L45 45Z" fill="white"/>
                </svg>
                <span style={{
                  fontSize: 20, fontWeight: 800, letterSpacing: "0.12em",
                  fontFamily: "'IBM Plex Mono', monospace", color: "#fff",
                  textShadow: "0 0 20px rgba(12,140,233,0.6)",
                }}>DOBSLIT</span>
              </div>
              <div style={{ fontSize: 9, color: "#4466aa", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.15em" }}>
                KUAPOÃ QRNG · FPGA HARDWARE
              </div>
            </div>
            {/* Vent grid */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingRight: 10 }}>
              {Array.from({length: 9}).map((_, i) => (
                <div key={i} style={{ display: "flex", gap: 3 }}>
                  {Array.from({length: 18}).map((_, j) => (
                    <div key={j} style={{ width: 5, height: 3, background: "#0a0a14", borderRadius: 1 }} />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Front face */}
          <div style={{
            width: "100%", height: 56,
            background: "linear-gradient(180deg, #161625 0%, #0e0e1c 100%)",
            border: "1px solid #282840",
            borderTop: "1px solid #3a3a5a",
            display: "flex", alignItems: "center",
            padding: "0 16px", gap: 12,
            position: "relative", zIndex: 2,
          }}>
            {/* Rack ear left */}
            <div style={{ width: 18, height: 36, background: "#1a1a2e", border: "1px solid #333355", borderRadius: 3, flexShrink: 0 }} />
            {/* LEDs */}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={ledStyle("#0fa968", "0s")} />
              <div style={ledStyle("#0fa968", "0.3s")} />
              <div style={ledStyle("#0c8ce9", "0.6s")} />
              <div style={{ ...ledStyle("#e8a317", "0.9s"), animation: "qledFast 0.8s 0.9s ease-in-out infinite" }} />
            </div>
            {/* USB / ports */}
            <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
              {[0,1].map(i => <div key={i} style={{ width: 12, height: 8, background: "#0a0a14", border: "1px solid #333", borderRadius: 1 }} />)}
            </div>
            <div style={{ flex: 1 }} />
            {/* QRNG label */}
            <div style={{ fontSize: 8, color: "#0c8ce9", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.1em", opacity: 0.7 }}>
              QRNG
            </div>
            {/* Rack ear right */}
            <div style={{ width: 18, height: 36, background: "#1a1a2e", border: "1px solid #333355", borderRadius: 3, flexShrink: 0 }} />
          </div>

          {/* Right face */}
          <div style={{
            position: "absolute",
            right: -38, top: 0,
            width: 38, height: 56,
            background: "linear-gradient(180deg, #0a0a14 0%, #080810 100%)",
            transformOrigin: "0% 50%",
            transform: "rotateY(90deg)",
            borderTop: "1px solid #222235",
            display: "flex", flexDirection: "column",
            justifyContent: "center", padding: "0 4px", gap: 3,
          }}>
            {Array.from({length: 6}).map((_, i) => (
              <div key={i} style={{ height: 2, background: "#1a1a28", borderRadius: 1 }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Feature cards ──────────────────────────────────────────── */

const FEATURE_CARDS = [
  {
    icon: "⚡",
    title: "Fonte QRNG / FPGA",
    desc: "Entropia gerada por fenômenos quânticos em hardware FPGA dedicado.",
  },
  {
    icon: "🔬",
    title: "Entropia Física",
    desc: "Aleatoriedade fundamentalmente imprevisível, não algoritmos.",
  },
  {
    icon: "🎲",
    title: "Geração de Números",
    desc: "Números e bytes aleatórios com distribuição uniforme comprovada.",
  },
  {
    icon: "📦",
    title: "Download de Dados Brutos",
    desc: "Exporte bytes quânticos para uso em simulações, pesquisa e análise.",
  },
  {
    icon: "🧪",
    title: "Testes Estatísticos NIST",
    desc: "Validação de entropia via suíte SP 800-90B com resultados detalhados.",
  },
];

/* ── Main Section ───────────────────────────────────────────── */

export default function KapuaSection() {
  const { isOnline, qrngSource, setActivePage } = useContext(AppContext);

  const [randHex,     setRandHex]     = useState(null);
  const [generating,  setGenerating]  = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dlError,     setDlError]     = useState(null);
  const [genError,    setGenError]    = useState(null);

  /* ── Generate a quick 4-byte random number ── */
  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      const r = await fetchQRNGBytes(4, null);
      const n = ((r.bytes[0] << 24) | (r.bytes[1] << 16) | (r.bytes[2] << 8) | r.bytes[3]) >>> 0;
      setRandHex({ value: n, hex: Array.from(r.bytes).map(b => b.toString(16).padStart(2, "0")).join(""), latency: r.latencyMs });
    } catch {
      // Local fallback
      const buf = new Uint8Array(4);
      crypto.getRandomValues(buf);
      const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
      setRandHex({ value: n, hex: Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join(""), latency: null, local: true });
      setGenError("Backend offline — usando CSPRNG local.");
    } finally {
      setGenerating(false);
    }
  };

  /* ── Download 1 MiB QRNG data ── */
  const handleDownload = async () => {
    const bytes = 1048576;
    setDownloading(true);
    setDlError(null);
    try {
      const jwt = localStorage.getItem("qrng_auth_jwt");
      if (!jwt) {
        setDlError("Faça login na aba Desenvolvedor para baixar dados quânticos.");
        return;
      }
      const response = await fetch(`${CLIENT_API}/random?bytes=${bytes}&format=hex`, {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(60000),
      });
      if (response.status === 401 || response.status === 403) {
        setDlError("Sessão expirada. Faça login novamente na aba Desenvolvedor.");
        return;
      }
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const json = await response.json();
      const hex  = json.random || "";
      const raw  = new Uint8Array(hex.length / 2);
      for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.substr(i * 2, 2), 16);
      const blob = new Blob([raw], { type: "application/octet-stream" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `qrng_1MiB.bin`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch {
      setDlError("Erro ao baixar. Verifique conexão ou acesse a aba Dados para opções.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 16px 40px" }}>

        {/* ── Hero ──────────────────────────────────────────── */}
        <div style={{
          position: "relative",
          borderRadius: 20,
          overflow: "hidden",
          background: "linear-gradient(135deg, #0a1628 0%, #0d1f3c 50%, #071220 100%)",
          border: `1px solid ${theme.quantum}30`,
          boxShadow: `0 0 60px ${theme.quantum}18`,
          marginBottom: 24,
          minHeight: 260,
        }}>
          <QuantumParticles />
          <div style={{
            position: "relative", zIndex: 1,
            padding: "40px 36px",
            display: "flex", flexDirection: "column", gap: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, fontFamily: mono,
                letterSpacing: "0.18em", textTransform: "uppercase",
                color: theme.quantum + "cc",
              }}>
                DOBSLIT · QRNG
              </div>
              <div style={{
                fontSize: 10, fontFamily: mono, fontWeight: 700,
                color: isOnline ? theme.success : theme.warning,
                background: (isOnline ? theme.success : theme.warning) + "18",
                border: `1px solid ${(isOnline ? theme.success : theme.warning)}40`,
                borderRadius: 20, padding: "2px 10px",
              }}>
                {isOnline ? "● ONLINE" : "○ OFFLINE"}
              </div>
            </div>

            <div>
              <h1 style={{
                margin: 0, fontSize: 46, fontWeight: 800, fontFamily: sans,
                color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.1,
              }}>
                Kuapoã
              </h1>
              <div style={{
                fontSize: 13, color: theme.quantum,
                fontFamily: mono, fontWeight: 600, marginTop: 4,
              }}>
                Gerador Quântico de Números Aleatórios
              </div>
            </div>

            <ServerHardware3D />

            <p style={{
              margin: 0, fontSize: 14, color: "#aac4e8", lineHeight: 1.75,
              maxWidth: 580, fontFamily: sans,
            }}>
              O Kuapoã é o sistema de geração de números aleatórios quânticos da Dobslit.
              Ele utiliza dados provenientes de uma fonte física quântica baseada em FPGA
              para gerar entropia real, permitindo aplicações em criptografia, simulações,
              autenticação, pesquisa e testes estatísticos.
            </p>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <button
                onClick={handleGenerate}
                disabled={generating}
                style={{
                  padding: "12px 24px", borderRadius: 10, border: "none",
                  background: theme.quantum, color: "#fff",
                  fontSize: 14, fontWeight: 700, fontFamily: sans,
                  cursor: generating ? "not-allowed" : "pointer",
                  opacity: generating ? 0.7 : 1,
                  boxShadow: `0 4px 18px ${theme.quantum}50`,
                  transition: "all 0.15s",
                }}
              >
                {generating ? "Gerando..." : "🎲 Gerar número aleatório"}
              </button>

              <button
                onClick={handleDownload}
                disabled={downloading}
                style={{
                  padding: "12px 24px", borderRadius: 10,
                  border: `1.5px solid ${theme.quantum}60`, background: "transparent",
                  color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: sans,
                  cursor: downloading ? "not-allowed" : "pointer",
                  opacity: downloading ? 0.7 : 1,
                  transition: "all 0.15s",
                }}
              >
                {downloading ? "Baixando..." : "⬇ Baixar dados QRNG"}
              </button>
            </div>

            {/* Result display */}
            {randHex && (
              <div style={{
                background: "rgba(12,140,233,0.08)", border: `1px solid ${theme.quantum}30`,
                borderRadius: 10, padding: "14px 18px", fontFamily: mono, marginTop: 4,
              }}>
                <div style={{ fontSize: 11, color: theme.quantum + "99", marginBottom: 4 }}>
                  NÚMERO ALEATÓRIO {randHex.local ? "(CSPRNG local)" : "(QRNG quântico)"}
                  {randHex.latency != null && ` · ${randHex.latency}ms`}
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#fff", letterSpacing: "0.02em" }}>
                  {randHex.value.toLocaleString("pt-BR")}
                </div>
                <div style={{ fontSize: 12, color: "#5b96cc", marginTop: 4 }}>
                  0x{randHex.hex.toUpperCase()}
                </div>
              </div>
            )}

            {genError && (
              <div style={{ fontSize: 11, color: theme.warning, fontFamily: mono }}>{genError}</div>
            )}
            {dlError && (
              <div style={{ fontSize: 11, color: theme.warning, fontFamily: mono }}>
                {dlError}{" "}
                <span
                  onClick={() => setActivePage("developer")}
                  style={{ color: theme.quantum, cursor: "pointer", textDecoration: "underline" }}
                >
                  Ir para Desenvolvedor
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Feature cards ─────────────────────────────────── */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 12, marginBottom: 24,
        }}>
          {FEATURE_CARDS.map((c) => (
            <div
              key={c.title}
              style={{
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 12, padding: "16px 16px 14px",
                display: "flex", flexDirection: "column", gap: 8,
              }}
            >
              <span style={{ fontSize: 24 }}>{c.icon}</span>
              <div style={{
                fontSize: 13, fontWeight: 700,
                fontFamily: "'Space Grotesk', sans-serif",
                color: theme.text,
              }}>
                {c.title}
              </div>
              <div style={{ fontSize: 12, color: theme.textDim, lineHeight: 1.55, fontFamily: sans }}>
                {c.desc}
              </div>
            </div>
          ))}
        </div>

        {/* ── Quick-nav strip ───────────────────────────────── */}
        <div style={{
          background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 12, padding: "14px 18px",
          display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, marginRight: 4 }}>
            EXPLORAR:
          </span>
          {[
            { page: "visuals",      label: "Representações Visuais" },
            { page: "data",         label: "Dados QRNG" },
            { page: "applications", label: "Aplicações" },
            { page: "nist",         label: "Teste NIST" },
            { page: "developer",    label: "Desenvolvedor" },
          ].map(({ page, label }) => (
            <button
              key={page}
              onClick={() => setActivePage(page)}
              style={{
                padding: "5px 14px", borderRadius: 20,
                border: `1px solid ${theme.border}`,
                background: "transparent", color: theme.textDim,
                fontSize: 11, fontWeight: 600, fontFamily: mono,
                cursor: "pointer", transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = theme.quantum; e.currentTarget.style.color = theme.quantum; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border; e.currentTarget.style.color = theme.textDim; }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
