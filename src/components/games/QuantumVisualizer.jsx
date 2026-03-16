import { useRef, useEffect, useState, useCallback, useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGBytes } from "../../qrngApi";
import { lcgNext } from "../../prng";
import * as galaxy from "./visualizations/galaxySpiral";
import * as mandala from "./visualizations/mandala";
import * as prngCracker from "./visualizations/prngCracker";
import * as mtClone from "./visualizations/mtClone";
import * as sonification from "./visualizations/sonification";
import DataPipeline from "./DataPipeline";
import StatsBadges from "./StatsBadges";
import InfoModal from "./InfoModal";
import { createAudioEngine } from "../../audioEngine";

const BG = "#0c0e1a";
const MODES = [
  { key: "galaxy", label: "Galaxia", mod: galaxy },
  { key: "mandala", label: "Mandala", mod: mandala },
  { key: "cracker", label: "LCG Cracker", mod: prngCracker },
  { key: "mtclone", label: "MT19937 Clone", mod: mtClone },
  { key: "sonification", label: "Sonifica\u00e7\u00e3o", mod: sonification },
];

const STATS_BUFFER_SIZE = 2000;
const STATS_UPDATE_INTERVAL = 30; // frames
const MAX_AUDIO_EVENTS_PER_FRAME = 6; // prevent audio overload

// Quantize PRNG to 8 levels — makes output visibly "digital/grid-like"
// vs QRNG's smooth 256 levels. Dramatically exposes LCG limitations.
// 8 levels = only values 0, 36, 73, 109, 146, 182, 219, 255
const PRNG_LEVELS = 8;

function generatePrngBytes(count, seedRef) {
  const bytes = new Uint8Array(count);
  let s = seedRef.current;
  const step = 255 / (PRNG_LEVELS - 1);
  for (let i = 0; i < count; i++) {
    const r = lcgNext(s);
    bytes[i] = Math.round(Math.floor(r.value * PRNG_LEVELS) * step);
    s = r.nextSeed;
  }
  seedRef.current = s;
  return bytes;
}

export default function QuantumVisualizer() {
  const { isOnline, latency } = useContext(AppContext);
  const [mode, setMode] = useState("galaxy");
  const [qrngSource, setQrngSource] = useState("...");
  const [bytesUsed, setBytesUsed] = useState(0);
  const [fps, setFps] = useState(0);
  const [prngStatsBytes, setPrngStatsBytes] = useState(null);
  const [qrngStatsBytes, setQrngStatsBytes] = useState(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioVolume, setAudioVolume] = useState(30);
  const [prngMuted, setPrngMuted] = useState(false);
  const [qrngMuted, setQrngMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showInfo, setShowInfo] = useState(false);

  const prngCanvasRef = useRef(null);
  const qrngCanvasRef = useRef(null);
  const containerRef = useRef(null);
  const animRef = useRef(null);
  const prngSeedRef = useRef(42);
  const qrngBufferRef = useRef([]);
  const fetchingRef = useRef(false);
  const prngStateRef = useRef(null);
  const qrngStateRef = useRef(null);
  const modeRef = useRef(mode);
  const sizeRef = useRef({ w: 400, h: 300 });
  const bytesUsedRef = useRef(0);
  const fpsFrames = useRef([]);

  // Stats byte accumulators
  const prngStatsBufRef = useRef([]);
  const qrngStatsBufRef = useRef([]);

  // Audio engine — create lazily on first enable (avoids autoplay issues)
  const audioEngineRef = useRef(null);
  const audioVolumeRef = useRef(audioVolume);

  // Mute refs for animation loop (can't use stale React state)
  const prngMutedRef = useRef(false);
  const qrngMutedRef = useRef(false);
  const speedRef = useRef(1);
  const frameAccRef = useRef(0);

  // Keep refs in sync
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { prngMutedRef.current = prngMuted; }, [prngMuted]);
  useEffect(() => { qrngMutedRef.current = qrngMuted; }, [qrngMuted]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  // Fetch QRNG bytes into buffer
  const refillBuffer = useCallback(async () => {
    if (fetchingRef.current || qrngBufferRef.current.length > 6000) return;
    fetchingRef.current = true;
    try {
      if (isOnline) {
        const { bytes } = await fetchQRNGBytes(8192);
        qrngBufferRef.current.push(...bytes);
        setQrngSource("Red Pitaya");
      } else {
        throw new Error("offline");
      }
    } catch {
      for (let i = 0; i < 4096; i++) {
        qrngBufferRef.current.push(Math.floor(Math.random() * 256));
      }
      setQrngSource("Fallback");
    }
    fetchingRef.current = false;
  }, [isOnline]);

  // Consume N bytes from QRNG buffer
  const consumeQrng = useCallback((count) => {
    const buf = qrngBufferRef.current;
    if (buf.length >= count) {
      return new Uint8Array(buf.splice(0, count));
    }
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      bytes[i] = buf.length > 0 ? buf.shift() : Math.floor(Math.random() * 256);
    }
    return bytes;
  }, []);

  // Get current mode module
  const getMod = useCallback(() => {
    return MODES.find((m) => m.key === modeRef.current)?.mod || galaxy;
  }, []);

  // Initialize states for a mode
  const initMode = useCallback((w, h) => {
    const mod = getMod();
    const pBytes = generatePrngBytes(2400, prngSeedRef);
    const qBytes = consumeQrng(2400);
    prngStateRef.current = mod.init(w, h, pBytes);
    qrngStateRef.current = mod.init(w, h, qBytes);

    // Set _isPrng flag for modules that need it (cracker, mtclone)
    if (prngStateRef.current) prngStateRef.current._isPrng = true;
    if (qrngStateRef.current) qrngStateRef.current._isPrng = false;

    // Clear canvases
    const pc = prngCanvasRef.current;
    const qc = qrngCanvasRef.current;
    if (pc) {
      const ctx = pc.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, pc.width, pc.height);
    }
    if (qc) {
      const ctx = qc.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, qc.width, qc.height);
    }

    // Reset stats buffers on mode change
    prngStatsBufRef.current = [];
    qrngStatsBufRef.current = [];
  }, [getMod, consumeQrng]);

  // Reinitialize on mode change
  useEffect(() => {
    const { w, h } = sizeRef.current;
    if (w > 0 && h > 0) {
      prngSeedRef.current = 42;
      initMode(w, h);
    }
  }, [mode, initMode]);

  // Main setup: resize + animation loop
  useEffect(() => {
    const container = containerRef.current;
    const pc = prngCanvasRef.current;
    const qc = qrngCanvasRef.current;
    if (!container || !pc || !qc) return;

    // Initial buffer fill
    refillBuffer();

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const cw = Math.floor((rect.width - 12) / 2);
      const ch = Math.floor(rect.height);
      if (cw < 10 || ch < 10) return;

      const dpr = window.devicePixelRatio || 1;
      [pc, qc].forEach((c) => {
        c.width = cw * dpr;
        c.height = ch * dpr;
        c.style.width = cw + "px";
        c.style.height = ch + "px";
        const ctx = c.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      });

      sizeRef.current = { w: cw, h: ch };
      prngSeedRef.current = 42; // Reset seed on resize to keep shadow LCG in sync
      initMode(cw, ch);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Animation loop
    let running = true;
    const animate = () => {
      if (!running) return;

      const mod = getMod();
      const { w, h } = sizeRef.current;
      if (w < 10 || h < 10 || !prngStateRef.current || !qrngStateRef.current) {
        animRef.current = requestAnimationFrame(animate);
        return;
      }

      // Speed control — accumulate fractional steps
      frameAccRef.current += speedRef.current;
      const steps = Math.floor(frameAccRef.current);
      frameAccRef.current -= steps;

      for (let step = 0; step < steps; step++) {
        // Determine bytes needed
        const need = prngStateRef.current.bytesNeeded || 50;
        const pBytes = generatePrngBytes(need, prngSeedRef);
        const qBytes = consumeQrng(need);
        bytesUsedRef.current += need;

        // Accumulate bytes for stats
        const pBuf = prngStatsBufRef.current;
        const qBuf = qrngStatsBufRef.current;
        for (let i = 0; i < pBytes.length; i++) pBuf.push(pBytes[i]);
        for (let i = 0; i < qBytes.length; i++) qBuf.push(qBytes[i]);
        // Trim to max size
        if (pBuf.length > STATS_BUFFER_SIZE) prngStatsBufRef.current = pBuf.slice(-STATS_BUFFER_SIZE);
        if (qBuf.length > STATS_BUFFER_SIZE) qrngStatsBufRef.current = qBuf.slice(-STATS_BUFFER_SIZE);

        // Update
        prngStateRef.current = mod.update(prngStateRef.current, pBytes, w, h);
        qrngStateRef.current = mod.update(qrngStateRef.current, qBytes, w, h);
      }

      // Draw
      const pCtx = pc.getContext("2d");
      const qCtx = qc.getContext("2d");
      mod.draw(pCtx, prngStateRef.current, w, h, theme.classical);
      mod.draw(qCtx, qrngStateRef.current, w, h, theme.quantum);

      // Process audio events from visualization modules (rate-limited, per-channel mute)
      const ae = audioEngineRef.current;
      if (ae && ae.isEnabled()) {
        const t = ae.currentTime();
        let eventCount = 0;
        const processEvents = (events) => {
          for (const e of events) {
            if (eventCount >= MAX_AUDIO_EVENTS_PER_FRAME) break;
            if (e.type === "note") ae.playNote(e.byte, t);
            else if (e.type === "prediction") ae.playPrediction(e.byte, t);
            else if (e.type === "match") ae.playMatch(t);
            else if (e.type === "mismatch") ae.playMismatch(t);
            else if (e.type === "tick") ae.playTick(t);
            eventCount++;
          }
        };
        // PRNG channel
        if (prngStateRef.current.audioEvents) {
          if (!prngMutedRef.current) processEvents(prngStateRef.current.audioEvents);
          prngStateRef.current.audioEvents = []; // always clear to prevent burst on unmute
        }
        // QRNG channel
        if (qrngStateRef.current.audioEvents) {
          if (!qrngMutedRef.current) processEvents(qrngStateRef.current.audioEvents);
          qrngStateRef.current.audioEvents = [];
        }
      }

      // FPS calc
      const now = performance.now();
      fpsFrames.current.push(now);
      while (fpsFrames.current.length > 0 && fpsFrames.current[0] < now - 1000) {
        fpsFrames.current.shift();
      }

      // Update React state periodically
      if (prngStateRef.current.frame % STATS_UPDATE_INTERVAL === 0) {
        setFps(fpsFrames.current.length);
        setBytesUsed(bytesUsedRef.current);
        // Update stats bytes for badges
        if (prngStatsBufRef.current.length >= 200) {
          setPrngStatsBytes(new Uint8Array(prngStatsBufRef.current));
          setQrngStatsBytes(new Uint8Array(qrngStatsBufRef.current));
        }
      }

      // Refill buffer if low
      if (qrngBufferRef.current.length < 2000) {
        refillBuffer();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      running = false;
      if (animRef.current) cancelAnimationFrame(animRef.current);
      ro.disconnect();
    };
  }, [refillBuffer, consumeQrng, getMod, initMode]);

  const reset = () => {
    prngSeedRef.current = 42;
    bytesUsedRef.current = 0;
    prngStatsBufRef.current = [];
    qrngStatsBufRef.current = [];
    setPrngStatsBytes(null);
    setQrngStatsBytes(null);
    const { w, h } = sizeRef.current;
    if (w > 0 && h > 0) initMode(w, h);
  };

  const toggleAudio = () => {
    let ae = audioEngineRef.current;
    if (!ae) {
      ae = createAudioEngine();
      audioEngineRef.current = ae;
    }
    if (!ae.isEnabled()) {
      ae.resume();
      ae.setVolume(audioVolumeRef.current / 100);
      ae.setEnabled(true);
      setAudioEnabled(true);
    } else {
      ae.setEnabled(false);
      setAudioEnabled(false);
    }
  };

  const handleVolumeChange = (e) => {
    const v = Number(e.target.value);
    setAudioVolume(v);
    audioVolumeRef.current = v;
    const ae = audioEngineRef.current;
    if (ae) ae.setVolume(v / 100);
  };

  // Cleanup audio engine
  useEffect(() => {
    return () => { if (audioEngineRef.current) audioEngineRef.current.dispose(); };
  }, []);

  const muteButtonStyle = (color, muted) => ({
    background: muted ? "transparent" : color + "30",
    border: `1.5px solid ${color}`,
    borderRadius: "50%",
    width: 16,
    height: 16,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    fontSize: 8,
    fontWeight: 700,
    lineHeight: 1,
    color: color,
    opacity: muted ? 0.3 : 1,
    transition: "all 0.15s",
    fontFamily: "'IBM Plex Mono', monospace",
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
      {/* Pipeline diagram */}
      <DataPipeline source={qrngSource} latency={latency} bytesUsed={bytesUsed} />

      {/* Mode selector — pill-style, centered, (i) on active */}
      <div style={{ display: "flex", justifyContent: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
        {MODES.map((m) => (
          <div key={m.key} style={{ position: "relative", display: "inline-flex" }}>
            <button
              onClick={() => setMode(m.key)}
              style={{
                padding: "7px 20px",
                borderRadius: 20,
                border: `2px solid ${mode === m.key ? theme.accent : theme.border}`,
                background: mode === m.key ? theme.accent + "18" : "transparent",
                color: mode === m.key ? theme.accent : theme.textDim,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "'IBM Plex Mono', monospace",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              {m.label}
            </button>
            {mode === m.key && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowInfo(true); }}
                style={{
                  position: "absolute",
                  top: -6, right: -6,
                  width: 18, height: 18, borderRadius: 9,
                  border: `1.5px solid ${theme.accent}`,
                  background: theme.surface,
                  color: theme.accent,
                  fontSize: 10, fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "'IBM Plex Mono', monospace",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0, zIndex: 1,
                  transition: "all 0.15s",
                }}
                title="Sobre este experimento"
              >
                i
              </button>
            )}
          </div>
        ))}
      </div>

      {/* PRNG vs QRNG labels — centered over each canvas */}
      <div style={{ display: "flex", alignItems: "center", padding: "0 4px", flexShrink: 0 }}>
        <span style={{
          flex: 1, textAlign: "center",
          fontSize: 14, fontWeight: 700, color: theme.classical,
          fontFamily: "'IBM Plex Mono', monospace",
          letterSpacing: "0.06em",
        }}>
          PRNG (LCG)
        </span>
        <div style={{ width: 12 }} />
        <span style={{
          flex: 1, textAlign: "center",
          fontSize: 14, fontWeight: 700, color: theme.quantum,
          fontFamily: "'IBM Plex Mono', monospace",
          letterSpacing: "0.06em",
        }}>
          QRNG {"\u00B7"} {qrngSource}
        </span>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          display: "flex",
          gap: 12,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <canvas
          ref={prngCanvasRef}
          style={{
            flex: 1,
            borderRadius: 10,
            border: `2px solid ${theme.classical}30`,
            background: BG,
          }}
        />
        <canvas
          ref={qrngCanvasRef}
          style={{
            flex: 1,
            borderRadius: 10,
            border: `2px solid ${theme.quantum}30`,
            background: BG,
          }}
        />
      </div>

      {/* Controls row — speed + audio + status, centered */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, flexShrink: 0, flexWrap: "wrap" }}>
        {/* Speed control */}
        <div style={{
          display: "flex", alignItems: "center", gap: 2,
          padding: "2px 4px", borderRadius: 6,
          border: `1.5px solid ${theme.border}`,
        }}>
          {[0.5, 1, 2, 4].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              style={{
                padding: "2px 5px", borderRadius: 4, cursor: "pointer",
                border: speed === s ? `1px solid ${theme.accent}` : "1px solid transparent",
                background: speed === s ? theme.accent + "18" : "transparent",
                color: speed === s ? theme.accent : theme.textDim,
                fontSize: 9, fontWeight: 600,
                fontFamily: "'IBM Plex Mono', monospace",
                transition: "all 0.15s",
              }}
              title={`Velocidade ${s}x`}
            >
              {s === 0.5 ? "\u00BDx" : `${s}x`}
            </button>
          ))}
        </div>

        {/* Audio controls */}
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 6px", borderRadius: 6,
          border: `1.5px solid ${audioEnabled ? theme.accent : theme.border}`,
          background: audioEnabled ? theme.accent + "08" : "transparent",
          transition: "all 0.15s",
        }}>
          <button
            onClick={toggleAudio}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: audioEnabled ? theme.accent : theme.textDim,
              fontSize: 14, padding: "1px 2px", lineHeight: 1,
              transition: "color 0.15s",
            }}
            title={audioEnabled ? "Desativar som" : "Ativar som"}
          >
            {audioEnabled ? "\uD83D\uDD0A" : "\uD83D\uDD07"}
          </button>
          {audioEnabled && (
            <>
              <input
                type="range"
                min="0" max="100" value={audioVolume}
                onChange={handleVolumeChange}
                style={{
                  width: 50, height: 3, cursor: "pointer",
                  accentColor: theme.accent,
                }}
                title={`Volume: ${audioVolume}%`}
              />
              <span style={{
                fontSize: 8, color: theme.textMuted,
                fontFamily: "'IBM Plex Mono', monospace",
                minWidth: 20, textAlign: "right",
              }}>
                {audioVolume}%
              </span>
              <button
                onClick={() => setPrngMuted(m => !m)}
                style={muteButtonStyle(theme.classical, prngMuted)}
                title={prngMuted ? "Ativar PRNG" : "Mutar PRNG"}
              >
                P
              </button>
              <button
                onClick={() => setQrngMuted(m => !m)}
                style={muteButtonStyle(theme.quantum, qrngMuted)}
                title={qrngMuted ? "Ativar QRNG" : "Mutar QRNG"}
              >
                Q
              </button>
            </>
          )}
        </div>

        {/* Status: reset + bytes + fps */}
        <button
          onClick={reset}
          style={{
            padding: "3px 10px",
            borderRadius: 5,
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.textDim,
            fontSize: 9,
            fontFamily: "'IBM Plex Mono', monospace",
            cursor: "pointer",
          }}
        >
          Reiniciar
        </button>
        <span style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>
          {bytesUsed.toLocaleString()} bytes
        </span>
        <span style={{ fontSize: 9, color: fps >= 50 ? theme.success : theme.warning, fontFamily: "'IBM Plex Mono', monospace" }}>
          {fps} fps
        </span>
      </div>

      {/* Statistical test badges */}
      <StatsBadges prngBytes={prngStatsBytes} qrngBytes={qrngStatsBytes} />

      {/* Info modal */}
      {showInfo && <InfoModal mode={mode} onClose={() => setShowInfo(false)} />}
    </div>
  );
}
