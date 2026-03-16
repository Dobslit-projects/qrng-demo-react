import { useState, useRef, useContext, useEffect } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { fetchQRNGRandInt } from "../../qrngApi";
import { prngRandInt } from "../../prng";
import Btn from "../ui/Btn";

function SlotBall({ finalNumber, color, revealed, index, maxNum, spinning }) {
  const [displayNum, setDisplayNum] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (spinning && !revealed) {
      // Slot machine spinning effect
      intervalRef.current = setInterval(() => {
        setDisplayNum(Math.floor(Math.random() * maxNum) + 1);
      }, 60);
      return () => clearInterval(intervalRef.current);
    }
    if (revealed) {
      // Staggered stop: each ball stops after index * 150ms
      const timer = setTimeout(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setDisplayNum(finalNumber);
      }, index * 150);
      return () => clearTimeout(timer);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [spinning, revealed, finalNumber, index, maxNum]);

  const isSettled = revealed && displayNum === finalNumber;

  return (
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 21,
        background: isSettled ? `radial-gradient(circle at 35% 35%, ${color}30, ${color}15)` : spinning ? color + "12" : color + "08",
        border: `2px solid ${isSettled ? color + "60" : color + "20"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        fontWeight: 700,
        fontFamily: "'IBM Plex Mono', monospace",
        color: (spinning || isSettled) ? color : "transparent",
        animation: isSettled ? `ballBounceIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both` : "none",
        boxShadow: isSettled ? `0 0 10px ${color}30` : "none",
        overflow: "hidden",
      }}
    >
      {displayNum ?? finalNumber}
    </div>
  );
}

export default function LotteryGenerator() {
  const { isOnline } = useContext(AppContext);
  const [numCount, setNumCount] = useState(6);
  const [maxNum, setMaxNum] = useState(60);
  const [prngNumbers, setPrngNumbers] = useState([]);
  const [qrngNumbers, setQrngNumbers] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const seedRef = useRef(42);
  const genKeyRef = useRef(0);

  const generate = async () => {
    setGenerating(true);
    setRevealed(false);
    setSpinning(true);
    genKeyRef.current++;

    // PRNG
    const pNums = new Set();
    let s = seedRef.current;
    let attempts = 0;
    while (pNums.size < numCount && attempts < 200) {
      const r = prngRandInt(s, 1, maxNum);
      pNums.add(r.result);
      s = r.nextSeed;
      attempts++;
    }
    seedRef.current = s;
    const pSorted = [...pNums].sort((a, b) => a - b);
    setPrngNumbers(pSorted);

    // QRNG
    const qNums = new Set();
    if (isOnline) {
      attempts = 0;
      while (qNums.size < numCount && attempts < 200) {
        try { const q = await fetchQRNGRandInt(1, maxNum); qNums.add(q.value); } catch { break; }
        attempts++;
      }
    }
    if (qNums.size < numCount) {
      let fs = seedRef.current + 7919;
      while (qNums.size < numCount) {
        const r = prngRandInt(fs, 1, maxNum);
        qNums.add(r.result);
        fs = r.nextSeed;
      }
    }
    const qSorted = [...qNums].sort((a, b) => a - b);
    setQrngNumbers(qSorted);

    // Minimum spin time before reveal
    await new Promise((r) => setTimeout(r, 600));
    setRevealed(true);

    // Wait for all balls to settle
    setTimeout(() => {
      setSpinning(false);
      setGenerating(false);
    }, numCount * 150 + 500);
  };

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12, fontFamily: "'Outfit', sans-serif" }}>Loteria</div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <label style={{ display: "block", fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>Qtd</label>
          <input type="number" min={1} max={15} value={numCount}
            onChange={(e) => setNumCount(Math.min(15, Math.max(1, Number(e.target.value))))}
            style={{ width: 48, padding: "5px 8px", borderRadius: 6, border: `1px solid ${theme.border}`, background: "#fff", color: theme.text, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", outline: "none" }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 9, color: theme.textMuted, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>Max</label>
          <input type="number" min={2} max={100} value={maxNum}
            onChange={(e) => setMaxNum(Math.min(100, Math.max(2, Number(e.target.value))))}
            style={{ width: 48, padding: "5px 8px", borderRadius: 6, border: `1px solid ${theme.border}`, background: "#fff", color: theme.text, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", outline: "none" }}
          />
        </div>
        <Btn onClick={generate} color={theme.success} disabled={generating} small>
          {generating ? "..." : "Gerar"}
        </Btn>
      </div>

      {/* PRNG balls */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: theme.classical, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>PRNG</div>
        <div key={`p-${genKeyRef.current}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {prngNumbers.map((n, i) => (
            <SlotBall key={i} finalNumber={n} color={theme.classical} revealed={revealed} index={i} maxNum={maxNum} spinning={spinning} />
          ))}
        </div>
      </div>

      {/* QRNG balls */}
      <div>
        <div style={{ fontSize: 9, color: theme.quantum, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>QRNG</div>
        <div key={`q-${genKeyRef.current}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {qrngNumbers.map((n, i) => (
            <SlotBall key={i} finalNumber={n} color={theme.quantum} revealed={revealed} index={i} maxNum={maxNum} spinning={spinning} />
          ))}
        </div>
      </div>
    </>
  );
}
