import { useState, useRef, useContext, useCallback } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGRandInt } from "../../qrngApi";
import { prngRandInt } from "../../prng";
import Btn from "../ui/Btn";

const dotPositions = {
  1: [[50, 50]],
  2: [[25, 25], [75, 75]],
  3: [[25, 25], [50, 50], [75, 75]],
  4: [[25, 25], [75, 25], [25, 75], [75, 75]],
  5: [[25, 25], [75, 25], [50, 50], [25, 75], [75, 75]],
  6: [[25, 25], [75, 25], [25, 50], [75, 50], [25, 75], [75, 75]],
};

function DiceFace({ value, color, size = 70, rolling, settled }) {
  const dots = value ? dotPositions[value] || [] : [];
  let animStyle = {};
  if (rolling) {
    animStyle = { animation: "diceTumble 0.8s infinite cubic-bezier(0.4, 0, 0.2, 1)", transformStyle: "preserve-3d" };
  } else if (settled) {
    animStyle = { animation: "diceSettle 0.5s ease-out", color };
  }

  return (
    <div style={{ width: size, height: size, borderRadius: 10, border: `2px solid ${color}60`, background: `radial-gradient(circle at 35% 35%, ${color}15, ${color}05)`, position: "relative", ...animStyle }}>
      {dots.map(([x, y], i) => (
        <div key={i} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)", width: size * 0.16, height: size * 0.16, borderRadius: "50%", background: `radial-gradient(circle at 40% 40%, ${color}, ${color}aa)`, boxShadow: settled ? `0 0 6px ${color}60` : "none" }} />
      ))}
    </div>
  );
}

// Mini bar chart for dice distribution
function DiceChart({ prngFreq, qrngFreq, total }) {
  if (total === 0) return null;
  const max = Math.max(...prngFreq, ...qrngFreq, 1);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 80 }}>
      {[1, 2, 3, 4, 5, 6].map((face) => (
        <div key={face} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <div style={{ display: "flex", gap: 1, alignItems: "flex-end", height: 55, width: "100%" }}>
            <div style={{ flex: 1, height: `${(prngFreq[face - 1] / max) * 100}%`, background: theme.classical + "60", borderRadius: "2px 2px 0 0", minHeight: prngFreq[face - 1] > 0 ? 2 : 0 }} />
            <div style={{ flex: 1, height: `${(qrngFreq[face - 1] / max) * 100}%`, background: theme.quantum + "60", borderRadius: "2px 2px 0 0", minHeight: qrngFreq[face - 1] > 0 ? 2 : 0 }} />
          </div>
          <div style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: theme.textMuted }}>{face}</div>
        </div>
      ))}
    </div>
  );
}

const batchOptions = [1, 5, 10, 20];

export default function DiceRoll() {
  const { isOnline } = useContext(AppContext);
  const [prngResult, setPrngResult] = useState(null);
  const [qrngResult, setQrngResult] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [settled, setSettled] = useState(false);
  const [prngFreq, setPrngFreq] = useState([0, 0, 0, 0, 0, 0]);
  const [qrngFreq, setQrngFreq] = useState([0, 0, 0, 0, 0, 0]);
  const [totalRolls, setTotalRolls] = useState(0);
  const seedRef = useRef(42);

  const rollOnce = useCallback(async () => {
    const prng = prngRandInt(seedRef.current, 1, 6);
    seedRef.current = prng.nextSeed;
    let qVal = prng.result;
    if (isOnline) {
      try { const q = await fetchQRNGRandInt(1, 6); qVal = q.value; } catch {}
    }
    return { prng: prng.result, qrng: qVal };
  }, [isOnline]);

  const rollBatch = useCallback(async (count) => {
    setRolling(true);
    setSettled(false);

    for (let i = 0; i < count; i++) {
      // Flicker during each roll
      setPrngResult(Math.floor(Math.random() * 6) + 1);
      setQrngResult(Math.floor(Math.random() * 6) + 1);

      const result = await rollOnce();
      await new Promise((r) => setTimeout(r, count === 1 ? 800 : 80));

      setPrngResult(result.prng);
      setQrngResult(result.qrng);
      setPrngFreq((f) => { const n = [...f]; n[result.prng - 1]++; return n; });
      setQrngFreq((f) => { const n = [...f]; n[result.qrng - 1]++; return n; });
      setTotalRolls((t) => t + 1);
    }

    setRolling(false);
    setSettled(true);
    setTimeout(() => setSettled(false), 500);
  }, [rollOnce]);

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12, fontFamily: "'Outfit', sans-serif" }}>Dados</div>

      {/* Dice faces side by side */}
      <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 10 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: theme.classical, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>PRNG</div>
          <DiceFace value={prngResult} color={theme.classical} rolling={rolling} settled={settled} />
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: theme.classical, marginTop: 4, animation: rolling ? "pulse 0.15s infinite" : "none" }}>
            {prngResult || "-"}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: theme.quantum, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>QRNG</div>
          <DiceFace value={qrngResult} color={theme.quantum} rolling={rolling} settled={settled} />
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: theme.quantum, marginTop: 4, animation: rolling ? "pulse 0.15s infinite" : "none" }}>
            {qrngResult || "-"}
          </div>
        </div>
      </div>

      {/* Batch buttons */}
      <div style={{ display: "flex", gap: 4, justifyContent: "center", marginBottom: 12 }}>
        {batchOptions.map((n) => (
          <button
            key={n}
            onClick={() => rollBatch(n)}
            disabled={rolling}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${theme.success}40`,
              background: theme.success + "10",
              color: theme.success,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: rolling ? "not-allowed" : "pointer",
              opacity: rolling ? 0.4 : 1,
            }}
          >
            {n}x
          </button>
        ))}
      </div>

      {/* Distribution chart */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>
          Distribuicao ({totalRolls} lancamentos)
        </div>
        <DiceChart prngFreq={prngFreq} qrngFreq={qrngFreq} total={totalRolls} />
        <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 9, fontFamily: "'IBM Plex Mono', monospace" }}>
          <span style={{ color: theme.classical }}>■ PRNG</span>
          <span style={{ color: theme.quantum }}>■ QRNG</span>
        </div>
      </div>
    </>
  );
}
