import { useRef, useEffect, useState, useContext, useCallback } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQrngBytes, errorMessage } from "../../lib/qrngHelper";
import { getApiPrefix } from "../../qrngApi";

const mono  = "'IBM Plex Mono', monospace";
const sans  = "'Outfit', sans-serif";
const grotesk = "'Space Grotesk', sans-serif";

/* ── Component catalogue ──────────────────────────────────────────────────── */

const COMPONENTS = [
  { id: 0, step: 1, shortName: "Fonte Quântica", icon: "⚛",
    name: "Fonte de Entropia Quântica",
    desc: "A origem da aleatoriedade vem de um processo físico quântico. O sinal capturado carrega flutuações imprevisíveis que não são geradas por algoritmo determinístico.",
    badge: "Entropia física", color: "#8b5cf6", cx: 138, cy: 124, face: "top" },
  { id: 1, step: 2, shortName: "ADC", icon: "📡",
    name: "Conversão Analógico-Digital",
    desc: "O sinal físico é convertido para dados digitais por um estágio de aquisição. Essa etapa transforma o ruído quântico em amostras digitais que podem ser processadas.",
    badge: "Amostragem", color: "#06b6d4", cx: 213, cy: 107, face: "top" },
  { id: 2, step: 3, shortName: "FPGA", icon: "🔧",
    name: "FPGA / Processamento em Hardware",
    desc: "A FPGA realiza a captura e o processamento inicial dos dados, permitindo baixa latência e fluxo contínuo de bytes aleatórios.",
    badge: "Hardware", color: "#3b82f6", cx: 298, cy: 97, face: "top" },
  { id: 3, step: 4, shortName: "Extrator", icon: "🔀",
    name: "Extração de Entropia",
    desc: "O pós-processamento remove vieses e organiza os bits para produzir uma sequência adequada para aplicações criptográficas, simulações e testes estatísticos.",
    badge: "Pós-processamento", color: "#10b981", cx: 375, cy: 107, face: "top" },
  { id: 4, step: 5, shortName: "Buffer", icon: "💾",
    name: "Buffer de Dados",
    desc: "Os bytes gerados são armazenados em um buffer para consumo pelas aplicações, APIs e interfaces do sistema.",
    badge: "Buffer", color: "#f59e0b", cx: 448, cy: 120, face: "top" },
  { id: 5, step: 6, shortName: "API REST", icon: "🔌",
    name: "API QRNG",
    desc: "A API disponibiliza os dados aleatórios para aplicações externas, download, geração de chaves, sorteios, simulações e testes.",
    badge: "Integração", color: "#0c8ce9", cx: 415, cy: 210, face: "front" },
  { id: 6, step: 7, shortName: "Testes NIST", icon: "🧪",
    name: "Validação Estatística",
    desc: "O sistema pode executar análises estatísticas e testes NIST para avaliar a qualidade dos dados gerados.",
    badge: "Teste NIST", color: "#e11d48", cx: 295, cy: 275, face: "below" },
  { id: 7, step: 8, shortName: "Aplicações", icon: "🚀",
    name: "Aplicações",
    desc: "Os números aleatórios podem ser usados em criptografia, autenticação, Monte Carlo, IA, otimização, jogos, educação e pesquisa.",
    badge: "Uso prático", color: "#0fa968", cx: 495, cy: 275, face: "below" },
];

/* ── Particle canvas (unchanged) ─────────────────────────────────────────── */

function QuantumParticles() {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);
  const particles = useRef([]);
  const W = useRef(0), H = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext("2d");

    const resize = () => {
      W.current = canvas.offsetWidth;
      H.current = canvas.offsetHeight;
      canvas.width  = W.current * devicePixelRatio;
      canvas.height = H.current * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
      particles.current = Array.from({ length: Math.max(Math.floor((W.current * H.current) / 4500), 50) }, () => ({
        x: Math.random() * W.current, y: Math.random() * H.current,
        r: Math.random() * 1.8 + 0.3,
        vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28,
        a: Math.random() * 0.5 + 0.1, hue: 205 + Math.random() * 30,
      }));
    };

    const draw = () => {
      const w = W.current, h = H.current;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles.current) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -5) p.x = w + 5; if (p.x > w + 5) p.x = -5;
        if (p.y < -5) p.y = h + 5; if (p.y > h + 5) p.y = -5;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},80%,62%,${p.a})`; ctx.fill();
      }
      const ps = particles.current;
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < 80) { ctx.beginPath(); ctx.moveTo(ps[i].x, ps[i].y); ctx.lineTo(ps[j].x, ps[j].y);
          ctx.strokeStyle = `rgba(12,140,233,${0.07*(1-d/80)})`; ctx.lineWidth = 0.4; ctx.stroke(); }
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas); resize(); rafRef.current = requestAnimationFrame(draw);
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />;
}

/* ── SVG Device with interactive hotspots ────────────────────────────────── */

function KapuaDeviceSVG({ selected, onSelect, flowStep, genFlowStep }) {
  // Flow lines between consecutive hotspots
  const flowLines = COMPONENTS.slice(0, -1).map((c, i) => ({
    x1: c.cx, y1: c.cy, x2: COMPONENTS[i + 1].cx, y2: COMPONENTS[i + 1].cy,
    color: c.color,
  }));

  return (
    <svg viewBox="0 0 560 310" width="100%" style={{ display: "block", overflow: "visible" }}>
      <defs>
        {/* Face gradients */}
        <linearGradient id="kq-grad-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#1e1e32" />
          <stop offset="55%"  stopColor="#131320" />
          <stop offset="100%" stopColor="#0c0c18" />
        </linearGradient>
        <linearGradient id="kq-grad-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#1a1a28" />
          <stop offset="100%" stopColor="#0d0d1a" />
        </linearGradient>
        <linearGradient id="kq-grad-right" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#0c0c18" />
          <stop offset="100%" stopColor="#070710" />
        </linearGradient>

        {/* Glow filters */}
        <filter id="kq-glow-strong" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="kq-glow-soft" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>

        {/* Clip paths */}
        <clipPath id="kq-clip-top">
          <polygon points="100,70 520,70 480,176 60,176" />
        </clipPath>
        <clipPath id="kq-clip-front">
          <polygon points="60,176 480,176 480,247 60,247" />
        </clipPath>
        <clipPath id="kq-clip-right">
          <polygon points="480,176 520,70 520,141 480,247" />
        </clipPath>
      </defs>

      {/* ── Right face (rendered first, behind other faces) ── */}
      <polygon points="480,176 520,70 520,141 480,247" fill="url(#kq-grad-right)" stroke="#18182a" strokeWidth="1" />
      <g clipPath="url(#kq-clip-right)">
        {[0,1,2,3,4,5].map(i =>
          <line key={i} x1="483" y1={190+i*9} x2="517" y2={190+i*9} stroke="#161626" strokeWidth="1.5" />
        )}
      </g>

      {/* ── Top face ── */}
      <polygon points="100,70 520,70 480,176 60,176" fill="url(#kq-grad-top)" stroke="#2a2a45" strokeWidth="1" />

      {/* Top face content (clipped) */}
      <g clipPath="url(#kq-clip-top)">
        {/* Top edge shine */}
        <line x1="100" y1="71" x2="520" y2="71" stroke="#3a3a6a" strokeWidth="1" opacity="0.7" />

        {/* DOBSLIT logo icon */}
        <g transform="translate(72,95)">
          <ellipse cx="14" cy="14" rx="13" ry="13" fill="#0c8ce9" opacity="0.15" />
          <path d="M14 4 C8 4 5 8 5 14 C5 18 8 22 14 23 C20 22 23 18 23 14 C23 8 20 4 14 4Z"
                fill="#0c8ce9" opacity="0.85" />
          <path d="M10 13 L14 6 L18 13 L16 13 L16 20 L12 20 L12 13Z" fill="white" opacity="0.9" />
        </g>

        {/* DOBSLIT text */}
        <text x="100" y="115" fill="white" fontSize="13" fontWeight="800"
              fontFamily="IBM Plex Mono, monospace" letterSpacing="2">DOBSLIT</text>
        <text x="100" y="128" fill="#3d5fa0" fontSize="6.5"
              fontFamily="IBM Plex Mono, monospace" letterSpacing="1.5">KUAPOÃ QRNG · FPGA</text>

        {/* Subtle circuit trace lines */}
        <g stroke="#0c8ce9" strokeWidth="0.4" opacity="0.12">
          <line x1="195" y1="118" x2="460" y2="98" />
          <line x1="195" y1="125" x2="460" y2="105" />
          <line x1="195" y1="132" x2="460" y2="112" />
          <line x1="195" y1="139" x2="460" y2="120" />
        </g>

        {/* Vent grid (right portion) */}
        {Array.from({ length: 8 }).map((_, row) =>
          Array.from({ length: 13 }).map((_, col) => (
            <rect key={`${row}-${col}`}
              x={338 + col * 11} y={84 + row * 11}
              width="7" height="7" rx="1" fill="#080812" />
          ))
        )}

        {/* Zone highlight for selected top-face component */}
        {selected >= 0 && COMPONENTS[selected].face === "top" && (
          <ellipse
            cx={COMPONENTS[selected].cx} cy={COMPONENTS[selected].cy}
            rx="52" ry="30"
            fill={COMPONENTS[selected].color} opacity="0.18"
            filter="url(#kq-glow-soft)"
          />
        )}

        {/* genFlowStep highlight on top face */}
        {genFlowStep >= 0 && genFlowStep <= 4 && (
          <ellipse
            cx={COMPONENTS[genFlowStep].cx} cy={COMPONENTS[genFlowStep].cy}
            rx="48" ry="27"
            fill={COMPONENTS[genFlowStep].color} opacity="0.22"
            filter="url(#kq-glow-soft)"
          />
        )}
      </g>

      {/* ── Front face ── */}
      <polygon points="60,176 480,176 480,247 60,247" fill="url(#kq-grad-front)" stroke="#1e1e36" strokeWidth="1" />
      {/* Front-top bright edge */}
      <line x1="60" y1="176" x2="480" y2="176" stroke="#353560" strokeWidth="1.5" opacity="0.8" />

      <g clipPath="url(#kq-clip-front)">
        {/* Left rack ear */}
        <rect x="63" y="180" width="24" height="63" rx="3" fill="#16162a" stroke="#2e2e50" strokeWidth="0.5" />
        <rect x="67" y="192" width="16" height="10" rx="2" fill="#0a0a14" />

        {/* LED cluster */}
        {[
          { x: 103, color: "#0fa968", delay: "0s" },
          { x: 115, color: "#0fa968", delay: "0.4s" },
          { x: 127, color: "#0c8ce9", delay: "0.8s" },
          { x: 139, color: "#f59e0b", delay: "1.2s" },
        ].map(({ x, color, delay }) => (
          <circle key={x} cx={x} cy={212} r="4.5" fill={color} opacity="0.9">
            <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" begin={delay} repeatCount="indefinite" />
          </circle>
        ))}

        {/* USB slots */}
        <rect x="156" y="205" width="16" height="11" rx="1" fill="#0a0a14" stroke="#2a2a3e" strokeWidth="0.5" />
        <rect x="176" y="205" width="16" height="11" rx="1" fill="#0a0a14" stroke="#2a2a3e" strokeWidth="0.5" />

        {/* KUAPOÃ label */}
        <text x="210" y="215" fill="#0c8ce9" fontSize="9"
              fontFamily="IBM Plex Mono, monospace" letterSpacing="1.5" opacity="0.75">KUAPOÃ</text>

        {/* SFP ports */}
        {[0,1,2].map(i => (
          <rect key={i} x={315 + i * 22} y={203} width="17" height="13" rx="1"
                fill="#0a0a14" stroke="#2a2a3e" strokeWidth="0.5" />
        ))}

        {/* API zone highlight */}
        {selected === 5 && (
          <ellipse cx={415} cy={210} rx="50" ry="22"
            fill="#0c8ce9" opacity="0.18" filter="url(#kq-glow-soft)" />
        )}
        {genFlowStep === 5 && (
          <ellipse cx={415} cy={210} rx="48" ry="20"
            fill="#0c8ce9" opacity="0.25" filter="url(#kq-glow-soft)" />
        )}

        {/* Right rack ear */}
        <rect x="453" y="180" width="24" height="63" rx="3" fill="#16162a" stroke="#2e2e50" strokeWidth="0.5" />
        <rect x="457" y="192" width="16" height="10" rx="2" fill="#0a0a14" />
      </g>

      {/* ── Flow lines (between consecutive hotspots) ── */}
      {flowLines.map((l, i) => {
        const active = flowStep >= i || genFlowStep > i;
        return (
          <line key={i}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke={l.color} strokeWidth={active ? 1.8 : 0.8}
            strokeDasharray={active ? "none" : "4 5"}
            opacity={active ? 0.65 : 0.2}
          />
        );
      })}

      {/* ── "Below" zone labels ── */}
      <text x="295" y="295" textAnchor="middle" fill="#e11d48"
            fontSize="7.5" fontFamily="IBM Plex Mono, monospace" opacity="0.55">Testes NIST</text>
      <text x="495" y="295" textAnchor="middle" fill="#0fa968"
            fontSize="7.5" fontFamily="IBM Plex Mono, monospace" opacity="0.55">Aplicações</text>

      {/* ── Hotspots ── */}
      {COMPONENTS.map((c) => {
        const isSel    = selected === c.id;
        const isFlow   = flowStep  >= c.id;
        const isGen    = genFlowStep === c.id;
        const isActive = isSel || isGen;
        return (
          <g key={c.id} onClick={() => onSelect(c.id)} style={{ cursor: "pointer" }}>
            <title>{`${c.step}. ${c.name}`}</title>

            {/* Outer glow (selection or flow complete) */}
            {(isSel || isFlow) && (
              <circle cx={c.cx} cy={c.cy} r="24" fill={c.color} opacity="0.08"
                filter="url(#kq-glow-soft)" />
            )}

            {/* Pulsing ring */}
            <circle cx={c.cx} cy={c.cy} r={isActive ? 13 : 9}
              fill="none" stroke={c.color}
              strokeWidth={isActive ? 2 : 1}
              opacity={isActive ? 0.9 : isFlow ? 0.55 : 0.35}
              filter={isActive ? "url(#kq-glow-strong)" : undefined}>
              {!isSel && (
                <animate attributeName="r" values={`${isActive?13:9};${isActive?17:13};${isActive?13:9}`}
                  dur="2s" repeatCount="indefinite" />
              )}
              <animate attributeName="opacity"
                values={isActive ? "0.9;0.5;0.9" : "0.35;0.6;0.35"}
                dur="2s" repeatCount="indefinite" />
            </circle>

            {/* Center dot */}
            <circle cx={c.cx} cy={c.cy} r={isActive ? 6 : 4}
              fill={c.color} opacity={isActive ? 1 : 0.75}
              filter={isActive ? "url(#kq-glow-strong)" : undefined} />

            {/* Step number */}
            <text x={c.cx} y={c.cy + (c.face === "below" ? -16 : c.face === "top" ? -16 : -16)}
              textAnchor="middle" fill={c.color} fontSize="8"
              fontFamily="IBM Plex Mono, monospace" opacity={isActive ? 1 : 0.6}
              fontWeight={isSel ? "700" : "400"}>
              {c.step}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── Flow Pipeline (mini step bar) ────────────────────────────────────────── */

function FlowPipeline({ selected, onSelect, flowStep }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 0,
      overflowX: "auto", paddingBottom: 2,
    }}>
      {COMPONENTS.map((c, i) => {
        const isSel    = selected === c.id;
        const isActive = flowStep >= i;
        return (
          <div key={c.id} style={{ display: "flex", alignItems: "center" }}>
            <button
              onClick={() => onSelect(c.id)}
              title={c.name}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 2, padding: "5px 8px", borderRadius: 8, border: "none",
                background: isSel ? c.color + "20" : isActive ? c.color + "10" : "transparent",
                cursor: "pointer", transition: "all 0.15s",
                outline: isSel ? `1.5px solid ${c.color}60` : "none",
                flexShrink: 0,
              }}>
              <span style={{ fontSize: 14 }}>{c.icon}</span>
              <span style={{
                fontSize: 8, fontFamily: mono, fontWeight: 700,
                color: isSel ? c.color : isActive ? c.color + "99" : theme.textMuted,
                letterSpacing: "0.05em",
              }}>{c.step}</span>
            </button>
            {i < COMPONENTS.length - 1 && (
              <div style={{
                width: 14, height: 1, flexShrink: 0,
                background: flowStep > i ? COMPONENTS[i].color + "80" : theme.border,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Component Info Panel ─────────────────────────────────────────────────── */

function ComponentPanel({ selected, onSelect, flowStep, onPlayFlow, isFlowPlaying }) {
  const c = COMPONENTS[selected];
  if (!c) return null;
  return (
    <div style={{
      background: "rgba(10,14,23,0.92)", backdropFilter: "blur(12px)",
      border: `1px solid ${c.color}30`, borderRadius: 14,
      padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 20 }}>{c.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: grotesk }}>{c.name}</div>
          <div style={{ fontSize: 9, color: c.color, fontFamily: mono, letterSpacing: "0.1em" }}>
            Etapa {c.step} de {COMPONENTS.length}
          </div>
        </div>
        <span style={{
          fontSize: 9, fontWeight: 700, fontFamily: mono, letterSpacing: "0.1em",
          padding: "3px 8px", borderRadius: 8,
          color: c.color, background: c.color + "18", border: `1px solid ${c.color}30`,
        }}>{c.badge}</span>
      </div>

      {/* Description */}
      <p style={{ margin: 0, fontSize: 12, color: "#8ba8cc", lineHeight: 1.65, fontFamily: sans }}>{c.desc}</p>

      {/* Navigation */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => onSelect(Math.max(0, selected - 1))} disabled={selected === 0}
          style={{ padding: "5px 12px", borderRadius: 8, border: `1px solid ${theme.border}40`,
            background: "transparent", color: "#7a90b0", fontSize: 11, fontFamily: mono,
            cursor: selected === 0 ? "not-allowed" : "pointer", opacity: selected === 0 ? 0.4 : 1 }}>
          ◀ Anterior
        </button>
        <button onClick={() => onSelect(Math.min(COMPONENTS.length - 1, selected + 1))}
          disabled={selected === COMPONENTS.length - 1}
          style={{ padding: "5px 12px", borderRadius: 8, border: `1px solid ${theme.border}40`,
            background: "transparent", color: "#7a90b0", fontSize: 11, fontFamily: mono,
            cursor: selected === COMPONENTS.length - 1 ? "not-allowed" : "pointer",
            opacity: selected === COMPONENTS.length - 1 ? 0.4 : 1 }}>
          Próximo ▶
        </button>
        <button onClick={onPlayFlow}
          style={{ padding: "5px 14px", borderRadius: 8, border: `1px solid ${theme.quantum}50`,
            background: isFlowPlaying ? theme.quantum + "20" : "transparent",
            color: theme.quantum, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>
          {isFlowPlaying ? "⏹ Parar" : "▶ Ver fluxo completo"}
        </button>
      </div>
    </div>
  );
}

/* ── Feature cards ────────────────────────────────────────────────────────── */

const FEATURE_CARDS = [
  { icon: "⚡", title: "Fonte QRNG / FPGA",       desc: "Entropia gerada por fenômenos quânticos em hardware FPGA dedicado." },
  { icon: "🔬", title: "Entropia Física",           desc: "Aleatoriedade fundamentalmente imprevisível, não algoritmos." },
  { icon: "🎲", title: "Geração de Números",        desc: "Números e bytes aleatórios com distribuição uniforme comprovada." },
  { icon: "📦", title: "Download de Dados Brutos",  desc: "Exporte bytes quânticos para uso em simulações, pesquisa e análise." },
  { icon: "🧪", title: "Testes Estatísticos NIST",  desc: "Validação de entropia via suíte SP 800-90B com resultados detalhados." },
];

/* ── Helper: source display text ──────────────────────────────────────────── */

function sourceLabel(source) {
  if (!source) return "Kuapoã QRNG";
  const s = source.toLowerCase();
  if (s.includes("fpga") || s.includes("hardware")) return "FPGA/Hardware";
  if (s.includes("fallback")) return "Fallback interno";
  return source;
}

/* ── Main Section ─────────────────────────────────────────────────────────── */

export default function KapuaSection() {
  const { isOnline, setActivePage, qrngSource } = useContext(AppContext);

  /* Device explorer state */
  const [selected,      setSelected]      = useState(0);
  const [flowStep,      setFlowStep]      = useState(-1);
  const [isFlowPlaying, setIsFlowPlaying] = useState(false);
  const flowTimerRef = useRef(null);

  /* Generate / download state */
  const [randHex,      setRandHex]      = useState(null);
  const [generating,   setGenerating]   = useState(false);
  const [genFlowStep,  setGenFlowStep]  = useState(-1);
  const [genError,     setGenError]     = useState(null);
  const [downloading,  setDownloading]  = useState(false);
  const [dlError,      setDlError]      = useState(null);
  const genFlowRef = useRef(null);
  const exploreRef = useRef(null);

  /* ── Flow animation ── */
  const stopFlow = useCallback(() => {
    clearInterval(flowTimerRef.current);
    setIsFlowPlaying(false);
    setFlowStep(-1);
  }, []);

  const playFlow = useCallback(() => {
    if (isFlowPlaying) { stopFlow(); return; }
    setIsFlowPlaying(true);
    setFlowStep(0);
    setSelected(0);
    let step = 0;
    flowTimerRef.current = setInterval(() => {
      step++;
      if (step >= COMPONENTS.length) { clearInterval(flowTimerRef.current); setIsFlowPlaying(false); return; }
      setFlowStep(step);
      setSelected(step);
    }, 700);
  }, [isFlowPlaying, stopFlow]);

  useEffect(() => () => { clearInterval(flowTimerRef.current); clearInterval(genFlowRef.current); }, []);

  /* ── Generate number (QRNG backend only) ── */
  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    setRandHex(null);

    // Animate flow through device
    let step = 0;
    setGenFlowStep(0);
    genFlowRef.current = setInterval(() => {
      step++;
      setGenFlowStep(step);
      if (step >= COMPONENTS.length - 1) clearInterval(genFlowRef.current);
    }, 220);

    try {
      const r = await fetchQrngBytes(4, getApiPrefix(qrngSource));
      const b = r.bytes;
      const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      setRandHex({ value: n, hex: r.hex.slice(0, 8), latency: r.latencyMs, source: r.source });
    } catch (e) {
      setGenError(errorMessage(e));
    } finally {
      setGenerating(false);
      setTimeout(() => setGenFlowStep(-1), 800);
    }
  };

  /* ── Download 1 MiB ── */
  const handleDownload = async () => {
    setDownloading(true); setDlError(null);
    try {
      const apiPrefix = getApiPrefix(qrngSource);
      const response = await fetch(`${apiPrefix}/random?bytes=1048576&format=hex`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const json = await response.json();
      const hex  = json.random || json.hex || "";
      const raw  = new Uint8Array(hex.length / 2);
      for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.substr(i * 2, 2), 16);
      const blob = new Blob([raw], { type: "application/octet-stream" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a"); a.href = url; a.download = "qrng_1MiB.bin";
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch { setDlError("Backend QRNG offline ou indisponível. Acesse a aba Dados para mais opções.");
    } finally { setDownloading(false); }
  };

  const handleExplore = () => {
    exploreRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setSelected(0); setFlowStep(-1); setIsFlowPlaying(false);
  };

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 40px" }}>

        {/* ── Hero (2-column layout) ──────────────────────────────────────── */}
        <div style={{
          position: "relative", borderRadius: 20, overflow: "hidden",
          background: "linear-gradient(135deg, #090e1a 0%, #0c1830 50%, #060d18 100%)",
          border: `1px solid ${theme.quantum}25`,
          boxShadow: `0 0 80px ${theme.quantum}12`,
          marginBottom: 20,
        }}>
          <QuantumParticles />
          <div style={{
            position: "relative", zIndex: 1,
            display: "flex", flexWrap: "wrap", gap: 24,
            padding: "32px 28px 28px",
            alignItems: "flex-start",
          }}>

            {/* ── Left column ── */}
            <div style={{ flex: "0 0 300px", minWidth: 240, display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Brand + status */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 10, fontWeight: 700, fontFamily: mono,
                  letterSpacing: "0.18em", color: theme.quantum + "cc" }}>DOBSLIT · QRNG</span>
                <span style={{
                  fontSize: 9, fontFamily: mono, fontWeight: 700,
                  color: isOnline ? theme.success : theme.warning,
                  background: (isOnline ? theme.success : theme.warning) + "18",
                  border: `1px solid ${(isOnline ? theme.success : theme.warning)}40`,
                  borderRadius: 20, padding: "2px 9px",
                }}>{isOnline ? "● ONLINE" : "○ OFFLINE"}</span>
              </div>

              {/* Title */}
              <div>
                <h1 style={{ margin: 0, fontSize: 44, fontWeight: 800, fontFamily: sans,
                  color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.1 }}>Kuapoã</h1>
                <div style={{ fontSize: 12, color: theme.quantum, fontFamily: mono,
                  fontWeight: 600, marginTop: 4 }}>Gerador Quântico de Números Aleatórios</div>
              </div>

              {/* Description */}
              <p style={{ margin: 0, fontSize: 13, color: "#8aaecc", lineHeight: 1.75, fontFamily: sans }}>
                O Kuapoã é o sistema de geração de números aleatórios quânticos da Dobslit.
                Ele utiliza uma fonte física quântica, aquisição em hardware e processamento
                dedicado para gerar entropia real para criptografia, simulações, autenticação,
                pesquisa e testes estatísticos.
              </p>

              {/* Action buttons */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button onClick={handleGenerate} disabled={generating} style={{
                  padding: "11px 22px", borderRadius: 10, border: "none",
                  background: theme.quantum, color: "#fff",
                  fontSize: 13, fontWeight: 700, fontFamily: sans,
                  cursor: generating ? "not-allowed" : "pointer", opacity: generating ? 0.7 : 1,
                  boxShadow: `0 4px 18px ${theme.quantum}45`, transition: "all 0.15s", textAlign: "left",
                }}>{generating ? "⏳ Gerando..." : "🎲 Gerar número aleatório"}</button>

                <button onClick={handleDownload} disabled={downloading} style={{
                  padding: "10px 22px", borderRadius: 10,
                  border: `1.5px solid ${theme.quantum}50`, background: "transparent",
                  color: "#c0d8f0", fontSize: 13, fontWeight: 600, fontFamily: sans,
                  cursor: downloading ? "not-allowed" : "pointer", opacity: downloading ? 0.7 : 1,
                  transition: "all 0.15s", textAlign: "left",
                }}>{downloading ? "⬇ Baixando..." : "⬇ Baixar dados QRNG"}</button>

                <button onClick={handleExplore} style={{
                  padding: "10px 22px", borderRadius: 10,
                  border: `1px solid #ffffff18`, background: "transparent",
                  color: "#7a90b0", fontSize: 13, fontFamily: sans,
                  cursor: "pointer", transition: "all 0.15s", textAlign: "left",
                }}>🔍 Explorar componentes</button>
              </div>

              {/* Number result */}
              {randHex && (
                <div style={{
                  background: "rgba(12,140,233,0.07)", border: `1px solid ${theme.quantum}25`,
                  borderRadius: 10, padding: "12px 14px", fontFamily: mono,
                }}>
                  <div style={{ fontSize: 9, color: theme.quantum + "99", marginBottom: 4, letterSpacing: "0.1em" }}>
                    NÚMERO ALEATÓRIO · Fonte: {sourceLabel(randHex.source)}
                    {randHex.latency != null && ` · ${randHex.latency}ms`}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#fff" }}>
                    {randHex.value.toLocaleString("pt-BR")}
                  </div>
                  <div style={{ fontSize: 11, color: "#4d80b8", marginTop: 3 }}>
                    0x{randHex.hex.toUpperCase()}
                  </div>
                </div>
              )}
              {genError && (
                <div style={{ fontSize: 11, color: theme.warning, fontFamily: mono,
                  padding: "8px 10px", borderRadius: 8, background: theme.warning + "0d",
                  border: `1px solid ${theme.warning}25` }}>
                  {genError}
                </div>
              )}
              {dlError && (
                <div style={{ fontSize: 11, color: theme.warning, fontFamily: mono,
                  padding: "8px 10px", borderRadius: 8, background: theme.warning + "0d",
                  border: `1px solid ${theme.warning}25` }}>
                  {dlError}
                </div>
              )}
            </div>

            {/* ── Right column: interactive device ── */}
            <div ref={exploreRef} style={{ flex: 1, minWidth: 300, display: "flex", flexDirection: "column", gap: 12 }}>
              <KapuaDeviceSVG
                selected={selected}
                onSelect={(id) => { setSelected(id); if (isFlowPlaying) stopFlow(); }}
                flowStep={flowStep}
                genFlowStep={genFlowStep}
              />
              <FlowPipeline
                selected={selected}
                onSelect={(id) => { setSelected(id); if (isFlowPlaying) stopFlow(); }}
                flowStep={flowStep}
              />
              <ComponentPanel
                selected={selected}
                onSelect={(id) => { setSelected(id); if (isFlowPlaying) stopFlow(); }}
                flowStep={flowStep}
                onPlayFlow={playFlow}
                isFlowPlaying={isFlowPlaying}
              />
            </div>
          </div>
        </div>

        {/* ── Feature cards ── */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 12, marginBottom: 20,
        }}>
          {FEATURE_CARDS.map((c) => (
            <div key={c.title} style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 12, padding: "16px 16px 14px",
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <span style={{ fontSize: 22 }}>{c.icon}</span>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>{c.title}</div>
              <div style={{ fontSize: 12, color: theme.textDim, lineHeight: 1.55, fontFamily: sans }}>{c.desc}</div>
            </div>
          ))}
        </div>

        {/* ── Quick-nav strip ── */}
        <div style={{
          background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 12, padding: "14px 18px",
          display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: mono, marginRight: 4 }}>EXPLORAR:</span>
          {[
            { page: "visuals",      label: "Representações Visuais" },
            { page: "data",         label: "Dados QRNG" },
            { page: "applications", label: "Aplicações" },
            { page: "nist",         label: "Teste NIST" },
            { page: "developer",    label: "Desenvolvedor" },
          ].map(({ page, label }) => (
            <button key={page} onClick={() => setActivePage(page)} style={{
              padding: "5px 14px", borderRadius: 20,
              border: `1px solid ${theme.border}`, background: "transparent",
              color: theme.textDim, fontSize: 11, fontWeight: 600, fontFamily: mono,
              cursor: "pointer", transition: "all 0.15s",
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = theme.quantum; e.currentTarget.style.color = theme.quantum; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border; e.currentTarget.style.color = theme.textDim; }}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
