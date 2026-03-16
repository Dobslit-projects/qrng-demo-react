import { useState, useEffect, useCallback, useContext, useMemo } from "react";
import { theme } from "../../theme";
import { generatePRNGSequence } from "../../prng";
import { generateQRNGSequence } from "../../qrngHelpers";
import { AppContext } from "../../contexts/AppContext";
import Btn from "../ui/Btn";
import ScatterCanvas from "./ScatterCanvas";
import Histogram from "./Histogram";
import StatsBadges from "../games/StatsBadges";
import StreamPanel from "./StreamPanel";

const mono = "'IBM Plex Mono', monospace";

export default function AnalysisSection() {
  const { qrngSource, setQrngSource, setLatency } = useContext(AppContext);

  const [inputSeed, setInputSeed] = useState("42");
  const [seed, setSeed] = useState(42);
  const [count, setCount] = useState(1000);
  const [busy, setBusy] = useState(false);

  const [prngSeq, setPrngSeq] = useState([]);
  const [qrngSeq, setQrngSeq] = useState([]);
  const [prngBits, setPrngBits] = useState([]);
  const [qrngBits, setQrngBits] = useState([]);

  const generate = useCallback(async () => {
    setBusy(true);
    const s = parseInt(inputSeed) || 42;
    setSeed(s);
    const p = generatePRNGSequence(s, count);
    const qResult = await generateQRNGSequence(count);

    setPrngSeq(p);
    setQrngSeq(qResult.values);
    setQrngSource(qResult.source);
    if (qResult.latencyMs !== null) setLatency(qResult.latencyMs);
    setPrngBits(p.slice(0, 64).map((v) => (v > 0.5 ? 1 : 0)));
    setQrngBits(qResult.values.slice(0, 64).map((v) => (v > 0.5 ? 1 : 0)));
    setBusy(false);
  }, [inputSeed, count, setQrngSource, setLatency]);

  useEffect(() => { generate(); }, []);

  const qrngLabel = qrngSource === "red-pitaya" ? "QRNG · Red Pitaya" : "QRNG · Pré-coletado";

  const prngBytes = useMemo(
    () => new Uint8Array(prngSeq.map((v) => Math.floor(v * 255))),
    [prngSeq]
  );
  const qrngBytes = useMemo(
    () => new Uint8Array(qrngSeq.map((v) => Math.floor(v * 255))),
    [qrngSeq]
  );

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "0 2px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Controls bar */}
        <div style={{
          display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
          background: theme.surface, borderRadius: 10,
          padding: "10px 16px", border: `1px solid ${theme.border}`,
        }}>
          <label style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Seed
          </label>
          <input
            value={inputSeed}
            onChange={(e) => setInputSeed(e.target.value)}
            style={{
              width: 80, padding: "6px 10px", borderRadius: 6,
              border: `1px solid ${theme.border}`, background: "#ffffff",
              color: theme.classical, fontSize: 13, fontWeight: 600,
              fontFamily: mono, outline: "none",
            }}
          />
          <label style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Amostras
          </label>
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            style={{
              padding: "6px 10px", borderRadius: 6,
              border: `1px solid ${theme.border}`, background: "#ffffff",
              color: theme.text, fontSize: 12, fontFamily: mono, outline: "none",
            }}
          >
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1.000</option>
            <option value={5000}>5.000</option>
            <option value={10000}>10.000</option>
          </select>
          <Btn onClick={generate} color={theme.quantum} disabled={busy}>
            {busy ? "Gerando..." : "Gerar"}
          </Btn>
        </div>

        {/* Two-column comparison */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>

          {/* ── PRNG Column ────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Header */}
            <div style={{
              textAlign: "center", fontSize: 15, fontWeight: 700,
              fontFamily: "'Space Grotesk', sans-serif", color: theme.classical,
              padding: "6px 0",
              background: theme.classicalDim,
              borderRadius: 8,
              border: `1px solid ${theme.classical}25`,
            }}>
              PRNG (LCG) · seed={seed}
            </div>

            {/* Scatter */}
            <div style={{
              background: theme.surface, borderRadius: 10,
              border: `1px solid ${theme.border}`,
              overflow: "hidden",
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: theme.textMuted, padding: "6px 12px",
                borderBottom: `1px solid ${theme.border}`,
              }}>
                Scatter Plot
              </div>
              <div style={{ height: 240, padding: 4 }}>
                <ScatterCanvas points={prngSeq} color={theme.classical} label={`seed=${seed}`} />
              </div>
            </div>

            {/* Histogram */}
            <div style={{
              background: theme.surface, borderRadius: 10,
              border: `1px solid ${theme.border}`, padding: 12,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: theme.textMuted, marginBottom: 6,
              }}>
                Distribuição
              </div>
              <div style={{ height: 100 }}>
                <Histogram values={prngSeq} color={theme.classical} />
              </div>
              <div style={{
                display: "flex", justifyContent: "space-between",
                marginTop: 4, fontSize: 9, color: theme.textMuted, fontFamily: mono,
              }}>
                <span>0.0</span><span>0.5</span><span>1.0</span>
              </div>
            </div>

            {/* Bits */}
            <div style={{
              background: theme.surface, borderRadius: 10,
              border: `1px solid ${theme.border}`, padding: 12,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: theme.textMuted, marginBottom: 6,
              }}>
                Bits (64 amostras)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                {prngBits.map((b, i) => (
                  <span key={i} style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, borderRadius: 4,
                    fontSize: 10, fontWeight: 700, fontFamily: mono,
                    background: b === 1 ? theme.classical + "18" : theme.surfaceAlt,
                    color: b === 1 ? theme.classical : theme.textMuted,
                    border: `1px solid ${b === 1 ? theme.classical + "40" : theme.border}`,
                  }}>{b}</span>
                ))}
              </div>
            </div>
          </div>

          {/* ── QRNG Column ────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Header */}
            <div style={{
              textAlign: "center", fontSize: 15, fontWeight: 700,
              fontFamily: "'Space Grotesk', sans-serif", color: theme.quantum,
              padding: "6px 0",
              background: theme.quantumDim,
              borderRadius: 8,
              border: `1px solid ${theme.quantum}25`,
            }}>
              {qrngLabel}
            </div>

            {/* Scatter */}
            <div style={{
              background: theme.surface, borderRadius: 10,
              border: `1px solid ${theme.border}`,
              overflow: "hidden",
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: theme.textMuted, padding: "6px 12px",
                borderBottom: `1px solid ${theme.border}`,
              }}>
                Scatter Plot
              </div>
              <div style={{ height: 240, padding: 4 }}>
                <ScatterCanvas points={qrngSeq} color={theme.quantum} label={qrngLabel} />
              </div>
            </div>

            {/* Histogram */}
            <div style={{
              background: theme.surface, borderRadius: 10,
              border: `1px solid ${theme.border}`, padding: 12,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: theme.textMuted, marginBottom: 6,
              }}>
                Distribuição
              </div>
              <div style={{ height: 100 }}>
                <Histogram values={qrngSeq} color={theme.quantum} />
              </div>
              <div style={{
                display: "flex", justifyContent: "space-between",
                marginTop: 4, fontSize: 9, color: theme.textMuted, fontFamily: mono,
              }}>
                <span>0.0</span><span>0.5</span><span>1.0</span>
              </div>
            </div>

            {/* Bits */}
            <div style={{
              background: theme.surface, borderRadius: 10,
              border: `1px solid ${theme.border}`, padding: 12,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700, fontFamily: mono,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: theme.textMuted, marginBottom: 6,
              }}>
                Bits (64 amostras)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                {qrngBits.map((b, i) => (
                  <span key={i} style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, borderRadius: 4,
                    fontSize: 10, fontWeight: 700, fontFamily: mono,
                    background: b === 1 ? theme.quantum + "18" : theme.surfaceAlt,
                    color: b === 1 ? theme.quantum : theme.textMuted,
                    border: `1px solid ${b === 1 ? theme.quantum + "40" : theme.border}`,
                  }}>{b}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Stats badges — full width */}
        <StatsBadges prngBytes={prngBytes} qrngBytes={qrngBytes} />

        {/* Stream panel */}
        <StreamPanel />

        {/* Bottom spacer for scroll padding */}
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}
