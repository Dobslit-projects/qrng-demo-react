import { useState, useRef, useContext, useCallback } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGRandInt } from "../../qrngApi";
import { prngRandInt } from "../../prng";

function Coin({ result, color, flipping, landed, size = 70 }) {
  let animStyle = {};
  if (flipping) {
    animStyle = { animation: "coinSpin 1s cubic-bezier(0.4, 0, 0.2, 1)", transformStyle: "preserve-3d" };
  } else if (landed) {
    animStyle = { animation: "coinLand 0.4s ease-out", color };
  }

  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      border: `3px solid ${color}60`,
      background: `radial-gradient(circle at 40% 35%, ${color}30, ${color}10)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.36, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
      color, boxShadow: landed ? `0 0 16px ${color}40` : `0 2px 6px rgba(0,0,0,0.08)`,
      ...animStyle,
    }}>
      {result === "cara" ? "C" : result === "coroa" ? "K" : "?"}
    </div>
  );
}

// Proportion bar
function ProportionBar({ caraCount, total, color, label }) {
  if (total === 0) return null;
  const caraPct = (caraCount / total) * 100;
  const coroaPct = 100 - caraPct;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color, fontWeight: 600, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", background: theme.surfaceAlt }}>
        <div style={{ width: `${caraPct}%`, background: color, transition: "width 0.3s ease", minWidth: caraPct > 0 ? 2 : 0 }} />
        <div style={{ width: `${coroaPct}%`, background: color + "30", transition: "width 0.3s ease", minWidth: coroaPct > 0 ? 2 : 0 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: theme.textDim, marginTop: 2 }}>
        <span>Cara: {caraPct.toFixed(1)}%</span>
        <span>Coroa: {coroaPct.toFixed(1)}%</span>
      </div>
    </div>
  );
}

const batchOptions = [1, 5, 10, 20];

export default function CoinFlip() {
  const { isOnline } = useContext(AppContext);
  const [prngResult, setPrngResult] = useState(null);
  const [qrngResult, setQrngResult] = useState(null);
  const [flipping, setFlipping] = useState(false);
  const [landed, setLanded] = useState(false);
  const [prngCara, setPrngCara] = useState(0);
  const [qrngCara, setQrngCara] = useState(0);
  const [totalFlips, setTotalFlips] = useState(0);
  const seedRef = useRef(42);

  const flipOnce = useCallback(async () => {
    const prng = prngRandInt(seedRef.current, 0, 1);
    seedRef.current = prng.nextSeed;
    const pResult = prng.result === 0 ? "cara" : "coroa";
    let qResult = pResult;
    if (isOnline) {
      try { const q = await fetchQRNGRandInt(0, 1); qResult = q.value === 0 ? "cara" : "coroa"; } catch {}
    }
    return { prng: pResult, qrng: qResult };
  }, [isOnline]);

  const flipBatch = useCallback(async (count) => {
    setFlipping(true);
    setLanded(false);

    for (let i = 0; i < count; i++) {
      setPrngResult(Math.random() > 0.5 ? "cara" : "coroa");
      setQrngResult(Math.random() > 0.5 ? "cara" : "coroa");

      const result = await flipOnce();
      await new Promise((r) => setTimeout(r, count === 1 ? 1000 : 80));

      setPrngResult(result.prng);
      setQrngResult(result.qrng);
      if (result.prng === "cara") setPrngCara((c) => c + 1);
      if (result.qrng === "cara") setQrngCara((c) => c + 1);
      setTotalFlips((t) => t + 1);
    }

    setFlipping(false);
    setLanded(true);
    setTimeout(() => setLanded(false), 400);
  }, [flipOnce]);

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12, fontFamily: "'Outfit', sans-serif" }}>Moeda</div>

      {/* Coins side by side */}
      <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 10 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: theme.classical, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>PRNG</div>
          <Coin result={prngResult} color={theme.classical} flipping={flipping} landed={landed} />
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", color: theme.classical, textTransform: "uppercase", marginTop: 4, animation: flipping ? "pulse 0.1s infinite" : "none" }}>
            {prngResult || "-"}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: theme.quantum, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>QRNG</div>
          <Coin result={qrngResult} color={theme.quantum} flipping={flipping} landed={landed} />
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", color: theme.quantum, textTransform: "uppercase", marginTop: 4, animation: flipping ? "pulse 0.1s infinite" : "none" }}>
            {qrngResult || "-"}
          </div>
        </div>
      </div>

      {/* Batch buttons */}
      <div style={{ display: "flex", gap: 4, justifyContent: "center", marginBottom: 12 }}>
        {batchOptions.map((n) => (
          <button
            key={n}
            onClick={() => flipBatch(n)}
            disabled={flipping}
            style={{
              padding: "6px 12px", borderRadius: 6,
              border: `1px solid ${theme.success}40`, background: theme.success + "10",
              color: theme.success, fontSize: 11, fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace",
              cursor: flipping ? "not-allowed" : "pointer", opacity: flipping ? 0.4 : 1,
            }}
          >
            {n}x
          </button>
        ))}
      </div>

      {/* Proportion bars */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
          Proporcao ({totalFlips} lancamentos)
        </div>
        <ProportionBar caraCount={prngCara} total={totalFlips} color={theme.classical} label="PRNG" />
        <ProportionBar caraCount={qrngCara} total={totalFlips} color={theme.quantum} label="QRNG" />
      </div>
    </>
  );
}
