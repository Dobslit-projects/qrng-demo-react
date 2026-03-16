import { useState, useRef, useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGBytes } from "../../qrngApi";
import { lcgNext } from "../../prng";
import { qrngBytesToInts } from "../../qrngHelpers";

function NumberBadge({ value, predicted, revealed, color, isMatch }) {
  const bg = !revealed
    ? color + "10"
    : isMatch
    ? theme.success + "18"
    : theme.danger + "18";
  const border = !revealed
    ? color + "30"
    : isMatch
    ? theme.success + "50"
    : theme.danger + "50";
  const textColor = !revealed ? color : isMatch ? theme.success : theme.danger;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 28,
        borderRadius: 6,
        background: bg,
        border: `1.5px solid ${border}`,
        fontSize: 12,
        fontWeight: 700,
        fontFamily: "'IBM Plex Mono', monospace",
        color: textColor,
        position: "relative",
        transition: "all 0.3s ease",
      }}
    >
      {value ?? "?"}
      {revealed && (
        <span
          style={{
            position: "absolute",
            top: -6,
            right: -6,
            fontSize: 10,
            fontWeight: 700,
            color: isMatch ? theme.success : theme.danger,
          }}
        >
          {isMatch ? "✓" : "✗"}
        </span>
      )}
    </div>
  );
}

export default function PredictabilityTest() {
  const { isOnline } = useContext(AppContext);
  const [seed, setSeed] = useState(42);
  const [prngSeq, setPrngSeq] = useState([]);
  const [qrngSeq, setQrngSeq] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [prngNext, setPrngNext] = useState([]);
  const [qrngNext, setQrngNext] = useState([]);
  const [revealed, setRevealed] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle, generated, predicted, revealed
  const [qrngSource, setQrngSource] = useState(null);
  const [totalPrngHits, setTotalPrngHits] = useState(0);
  const [totalQrngHits, setTotalQrngHits] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const seedStateRef = useRef(seed);

  const generateSequence = async () => {
    setRevealed(false);
    setPredictions([]);
    setPrngNext([]);
    setQrngNext([]);

    // PRNG: generate 8 numbers (0-99)
    const pSeq = [];
    let s = seed;
    for (let i = 0; i < 8; i++) {
      const r = lcgNext(s);
      pSeq.push(Math.floor(r.value * 100));
      s = r.nextSeed;
    }
    setPrngSeq(pSeq);
    seedStateRef.current = s; // save seed state after 8 numbers

    // QRNG: fetch 8 bytes, map to 0-99
    let qSeq;
    let source = "fallback";
    if (isOnline) {
      try {
        const result = await fetchQRNGBytes(8);
        qSeq = qrngBytesToInts(result.bytes, 0, 99);
        source = "red-pitaya";
      } catch {}
    }
    if (!qSeq || qSeq.length < 8) {
      qSeq = Array.from({ length: 8 }, () => Math.floor(Math.random() * 100));
      source = "fallback";
    }
    setQrngSeq(qSeq);
    setQrngSource(source);
    setPhase("generated");
  };

  const predict = () => {
    // Calculate what the next 3 PRNG numbers will be using the saved seed state
    const preds = [];
    let s = seedStateRef.current;
    for (let i = 0; i < 3; i++) {
      const r = lcgNext(s);
      preds.push(Math.floor(r.value * 100));
      s = r.nextSeed;
    }
    setPredictions(preds);
    setPhase("predicted");
  };

  const reveal = async () => {
    // Generate actual next 3 for PRNG
    const pNext = [];
    let s = seedStateRef.current;
    for (let i = 0; i < 3; i++) {
      const r = lcgNext(s);
      pNext.push(Math.floor(r.value * 100));
      s = r.nextSeed;
    }
    setPrngNext(pNext);
    seedStateRef.current = s;

    // Generate actual next 3 for QRNG
    let qNext;
    if (isOnline) {
      try {
        const result = await fetchQRNGBytes(3);
        qNext = qrngBytesToInts(result.bytes, 0, 99);
      } catch {}
    }
    if (!qNext || qNext.length < 3) {
      qNext = Array.from({ length: 3 }, () => Math.floor(Math.random() * 100));
    }
    setQrngNext(qNext);

    // Count matches
    const pHits = predictions.filter((p, i) => p === pNext[i]).length;
    const qHits = predictions.filter((p, i) => p === qNext[i]).length;
    setTotalPrngHits((h) => h + pHits);
    setTotalQrngHits((h) => h + qHits);
    setTotalRounds((r) => r + 3);

    setRevealed(true);
    setPhase("revealed");
  };

  const prngPct = totalRounds > 0 ? ((totalPrngHits / totalRounds) * 100).toFixed(0) : "-";
  const qrngPct = totalRounds > 0 ? ((totalQrngHits / totalRounds) * 100).toFixed(0) : "-";

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4, fontFamily: "'Outfit', sans-serif" }}>
        Previsibilidade
      </div>
      <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8, lineHeight: 1.4 }}>
        Conhecendo o seed, prevemos o PRNG. O QRNG e imprevisivel.
      </div>

      {/* Seed input */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <label style={{ fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", textTransform: "uppercase" }}>Seed:</label>
        <input
          type="number"
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value) || 0)}
          disabled={phase !== "idle" && phase !== "revealed"}
          style={{
            width: 56, padding: "3px 6px", borderRadius: 5,
            border: `1px solid ${theme.border}`, background: "#fff",
            color: theme.text, fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", outline: "none",
          }}
        />
      </div>

      {/* Sequences */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {/* PRNG sequence */}
        {prngSeq.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 9, color: theme.classical, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>PRNG (LCG)</div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {prngSeq.map((n, i) => (
                <NumberBadge key={`p${i}`} value={n} color={theme.classical} />
              ))}
              {prngNext.length > 0 && (
                <>
                  <span style={{ color: theme.textMuted, fontSize: 14, alignSelf: "center" }}>→</span>
                  {prngNext.map((n, i) => (
                    <NumberBadge
                      key={`pn${i}`}
                      value={n}
                      predicted={predictions[i]}
                      revealed={revealed}
                      color={theme.classical}
                      isMatch={predictions[i] === n}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {/* QRNG sequence */}
        {qrngSeq.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 9, color: theme.quantum, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>
              QRNG {qrngSource === "red-pitaya" ? "· Red Pitaya" : "· ⚠ Fallback"}
            </div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {qrngSeq.map((n, i) => (
                <NumberBadge key={`q${i}`} value={n} color={theme.quantum} />
              ))}
              {qrngNext.length > 0 && (
                <>
                  <span style={{ color: theme.textMuted, fontSize: 14, alignSelf: "center" }}>→</span>
                  {qrngNext.map((n, i) => (
                    <NumberBadge
                      key={`qn${i}`}
                      value={n}
                      predicted={predictions[i]}
                      revealed={revealed}
                      color={theme.quantum}
                      isMatch={predictions[i] === n}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {/* Predictions row */}
        {predictions.length > 0 && (
          <div style={{ marginBottom: 6, padding: "6px 8px", borderRadius: 6, background: theme.warning + "08", border: `1px solid ${theme.warning}20` }}>
            <div style={{ fontSize: 9, color: theme.warning, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>
              PREVISAO (calculada com seed + LCG)
            </div>
            <div style={{ display: "flex", gap: 3 }}>
              {predictions.map((n, i) => (
                <NumberBadge key={`pred${i}`} value={n} color={theme.warning} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Buttons */}
      <div style={{ display: "flex", gap: 5, flexShrink: 0, marginTop: 6, flexWrap: "wrap" }}>
        {(phase === "idle" || phase === "revealed") && (
          <button
            onClick={generateSequence}
            style={{
              padding: "6px 12px", borderRadius: 6,
              border: `1px solid ${theme.success}40`, background: theme.success + "10",
              color: theme.success, fontSize: 10, fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer",
            }}
          >
            Gerar Sequencia
          </button>
        )}
        {phase === "generated" && (
          <button
            onClick={predict}
            style={{
              padding: "6px 12px", borderRadius: 6,
              border: `1px solid ${theme.warning}40`, background: theme.warning + "10",
              color: theme.warning, fontSize: 10, fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer",
            }}
          >
            Prever Proximos 3
          </button>
        )}
        {phase === "predicted" && (
          <button
            onClick={reveal}
            style={{
              padding: "6px 12px", borderRadius: 6,
              border: `1px solid ${theme.accent}40`, background: theme.accent + "10",
              color: theme.accent, fontSize: 10, fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer",
            }}
          >
            Revelar
          </button>
        )}
      </div>

      {/* Score */}
      {totalRounds > 0 && (
        <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0 }}>
          <span style={{ color: theme.classical }}>
            PRNG: <strong>{prngPct}%</strong> acerto
          </span>
          <span style={{ color: theme.quantum }}>
            QRNG: <strong>{qrngPct}%</strong> acerto
          </span>
          <span style={{ color: theme.textMuted }}>({totalRounds} previsoes)</span>
        </div>
      )}
    </>
  );
}
