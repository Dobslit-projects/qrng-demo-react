import { useState, useContext, useRef, useEffect, useCallback } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import {
  fetchQrngBytes, bytesToHex, bytesToUint32Array,
  uint32ToFloat, uniformIntFromBytes, errorMessage,
} from "../../lib/qrngHelper";
import Btn from "../ui/Btn";
import GlowTag from "../ui/GlowTag";

const mono = "'IBM Plex Mono', monospace";
const sans = "'Outfit', sans-serif";
const grotesk = "'Space Grotesk', sans-serif";

/* ── Shared helpers ───────────────────────────────────────────────────────── */

const card = {
  background: theme.surface,
  borderRadius: 14,
  border: `1px solid ${theme.border}`,
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

function Badge({ children, color }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, fontFamily: mono,
      letterSpacing: "0.12em", textTransform: "uppercase",
      padding: "2px 8px", borderRadius: 10,
      color, background: color + "15", border: `1px solid ${color}30`,
    }}>{children}</span>
  );
}

function SourceBadge({ source, latencyMs }) {
  if (!source && !latencyMs) return null;
  return (
    <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>
      {source ? `⚛ ${source}` : "⚛ Kuapoã QRNG"}
      {latencyMs != null ? ` · ${latencyMs}ms` : ""}
    </span>
  );
}

function ErrMsg({ msg, onLogin }) {
  if (!msg) return null;
  const isAuth = msg.includes("Desenvolvedor");
  return (
    <div style={{
      fontSize: 11, color: theme.warning, fontFamily: mono,
      padding: "8px 12px", borderRadius: 8,
      background: theme.warning + "10", border: `1px solid ${theme.warning}25`,
    }}>
      {msg}
      {isAuth && onLogin && (
        <span onClick={onLogin} style={{ marginLeft: 6, color: theme.quantum, cursor: "pointer", textDecoration: "underline" }}>
          Ir para Desenvolvedor
        </span>
      )}
    </div>
  );
}

function HexBox({ hex, placeholder }) {
  return (
    <div style={{
      fontFamily: mono, fontSize: 12, lineHeight: 1.8,
      color: theme.quantum, background: "#0a0e17",
      padding: "12px 14px", borderRadius: 10,
      border: `1px solid ${theme.border}`,
      wordBreak: "break-all", minHeight: 48, maxHeight: 180, overflow: "auto",
    }}>
      {hex || <span style={{ color: theme.textMuted, fontSize: 11 }}>{placeholder}</span>}
    </div>
  );
}

function SizeBtn({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "4px 12px", borderRadius: 16,
      border: `1.5px solid ${active ? theme.quantum : theme.border}`,
      background: active ? theme.quantum + "12" : "transparent",
      color: active ? theme.quantum : theme.textDim,
      fontSize: 11, fontWeight: 600, fontFamily: mono,
      cursor: "pointer", transition: "all 0.15s",
    }}>{label}</button>
  );
}

/* ── Card 1: Chave Quântica ───────────────────────────────────────────────── */

const keyPresets = [
  { bytes: 16, label: "128-bit" }, { bytes: 32, label: "256-bit" },
  { bytes: 64, label: "512-bit" }, { bytes: 128, label: "128 B" },
  { bytes: 256, label: "256 B" },  { bytes: 512, label: "512 B" },
  { bytes: 1024, label: "1024 B" },
];
const keyTags = {
  16: ["AES-128", "HMAC-SHA256"], 32: ["AES-256", "ChaCha20", "Ed25519"],
  64: ["HMAC-SHA512", "Seed Master"], 128: ["RSA Seed", "KDF Input"],
  256: ["High-Entropy Pool"], 512: ["Multi-Key Derivation"], 1024: ["Bulk Entropy"],
};

function KeyCard({ onGoLogin }) {
  const [size, setSize] = useState(32);
  const [hex, setHex] = useState("");
  const [meta, setMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const animRef = useRef(null);

  const stopAnim = () => { clearInterval(animRef.current); animRef.current = null; };

  const generate = async () => {
    setBusy(true); setErr(""); setMeta(null); setHex("");
    animRef.current = setInterval(() => {
      setHex(Array.from({length: size * 2}, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""));
    }, 40);
    try {
      const r = await fetchQrngBytes(size);
      stopAnim();
      setHex(r.hex.slice(0, size * 2));
      setMeta(r);
    } catch (e) {
      stopAnim(); setHex(""); setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => stopAnim(), []);

  const copy = async () => {
    if (!hex) return;
    await navigator.clipboard.writeText(hex);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>🔑 Gerar Chave Quântica</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
        <div style={{ marginLeft: "auto", display: "flex", gap: 5, flexWrap: "wrap" }}>
          {(keyTags[size] || []).map(t => <GlowTag key={t} color={theme.quantum}>{t}</GlowTag>)}
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Gere chaves e sementes criptográficas a partir de entropia física fornecida pelo Kuapoã.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {keyPresets.map(p => <SizeBtn key={p.bytes} label={p.label} active={size === p.bytes} onClick={() => { setSize(p.bytes); setHex(""); setMeta(null); }} />)}
      </div>
      <Btn onClick={generate} color={theme.quantum} disabled={busy}>{busy ? "Gerando..." : "Gerar chave quântica"}</Btn>
      <HexBox hex={hex} placeholder="Selecione o tamanho e clique em Gerar..." />
      <ErrMsg msg={err} onLogin={onGoLogin} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {hex && !busy && <Btn onClick={copy} color={copied ? theme.success : theme.accent} small>{copied ? "Copiado!" : "Copiar"}</Btn>}
        <SourceBadge source={meta?.source} latencyMs={meta?.latencyMs} />
        {meta?.requestId && <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>id: {meta.requestId}</span>}
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: mono }}>{size * 8} bits · {size} bytes</span>
      </div>
    </div>
  );
}

/* ── Card 2: Seed para IA ─────────────────────────────────────────────────── */

function AISeedCard({ onGoLogin }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const generate = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await fetchQrngBytes(8);
      const u32a = bytesToUint32Array(r.bytes);
      const seed32 = u32a[0];
      const seed64hi = u32a[0]; const seed64lo = u32a[1];
      const seed64 = BigInt(seed64hi) * 4294967296n + BigInt(seed64lo);
      setResult({ seed32, seed64: seed64.toString(), hex: r.hex.slice(0, 16), meta: r });
    } catch (e) {
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  const copy = async (text) => { await navigator.clipboard.writeText(text); };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>🧠 Seed Quântica para IA</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Modelos de IA usam aleatoriedade em inicialização de pesos, divisão de datasets e experimentos.
        O Kuapoã fornece seeds baseadas em entropia física para experimentos mais robustos e reprodutíveis.
      </p>
      <Btn onClick={generate} color={theme.quantum} disabled={busy}>{busy ? "Gerando..." : "Gerar seed para IA"}</Btn>
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 160, background: "#0a0e17", borderRadius: 10, padding: "10px 14px", border: `1px solid ${theme.border}` }}>
              <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: mono, marginBottom: 4 }}>SEED UINT32</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: theme.quantum, fontFamily: mono }}>{result.seed32}</div>
            </div>
            <div style={{ flex: 1, minWidth: 160, background: "#0a0e17", borderRadius: 10, padding: "10px 14px", border: `1px solid ${theme.border}` }}>
              <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: mono, marginBottom: 4 }}>SEED UINT64</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#7ab8f5", fontFamily: mono, wordBreak: "break-all" }}>{result.seed64}</div>
            </div>
          </div>
          <div style={{ background: "#0a0e17", borderRadius: 10, padding: "12px 14px", border: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: mono, marginBottom: 8 }}>EXEMPLOS DE USO</div>
            {[
              `# Python\nrandom.seed(${result.seed32})\nnp.random.seed(${result.seed32})`,
              `# PyTorch\ntorch.manual_seed(${result.seed32})`,
              `# R\nset.seed(${result.seed32})`,
            ].map((snippet, i) => (
              <div key={i} style={{ fontFamily: mono, fontSize: 11, color: "#7ab8f5", marginBottom: 8, lineHeight: 1.6, whiteSpace: "pre" }}>
                {snippet}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Btn onClick={() => copy(String(result.seed32))} color={theme.accent} small>Copiar uint32</Btn>
            <Btn onClick={() => copy(result.seed64)} color={theme.accent} small>Copiar uint64</Btn>
            <SourceBadge source={result.meta?.source} latencyMs={result.meta?.latencyMs} />
          </div>
        </div>
      )}
      <ErrMsg msg={err} onLogin={onGoLogin} />
    </div>
  );
}

/* ── Card 3: Monte Carlo π ────────────────────────────────────────────────── */

function MonteCarloCard({ onGoLogin }) {
  const canvasRef = useRef(null);
  const [nPoints, setNPoints] = useState(1000);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const CANVAS_SIZE = 240;
  const MAX_VISUAL = 4000;

  const run = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const bytesNeeded = nPoints * 8;
      const r = await fetchQrngBytes(bytesNeeded);
      const u32s = bytesToUint32Array(r.bytes);

      let inside = 0;
      const visualPts = [];
      const visualLimit = Math.min(nPoints, MAX_VISUAL);

      for (let i = 0; i < nPoints; i++) {
        const xi = u32s[i * 2]     ?? 0;
        const yi = u32s[i * 2 + 1] ?? 0;
        const x = uint32ToFloat(xi);
        const y = uint32ToFloat(yi);
        const inCircle = x * x + y * y <= 1;
        if (inCircle) inside++;
        if (i < visualLimit) visualPts.push({ x, y, inCircle });
      }

      const piEst = 4 * inside / nPoints;
      const errPct = Math.abs((piEst - Math.PI) / Math.PI * 100);
      setResult({ piEst, inside, total: nPoints, errPct, pts: visualPts, meta: r });

      // Draw canvas
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const S = CANVAS_SIZE;
        ctx.clearRect(0, 0, S, S);
        ctx.fillStyle = "#0a0e17";
        ctx.fillRect(0, 0, S, S);
        ctx.strokeStyle = "#2a3a5a";
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, S, S);
        ctx.beginPath();
        ctx.arc(0, 0, S, 0, Math.PI / 2);
        ctx.strokeStyle = "#0c8ce940";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        for (const p of visualPts) {
          ctx.beginPath();
          ctx.arc(p.x * S, p.y * S, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = p.inCircle ? "#0c8ce9aa" : "#d94a2e88";
          ctx.fill();
        }
      });
    } catch (e) {
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>π Monte Carlo Quântico</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Estime π usando pontos gerados por entropia quântica e visualize o comportamento estatístico da amostragem.
        Cada ponto usa 8 bytes do Kuapoã.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[1000, 10000, 100000].map(n => (
          <SizeBtn key={n} label={n.toLocaleString("pt-BR")} active={nPoints === n} onClick={() => { setNPoints(n); setResult(null); }} />
        ))}
      </div>
      <Btn onClick={run} color={theme.quantum} disabled={busy}>{busy ? "Calculando..." : `Estimar π com ${nPoints.toLocaleString("pt-BR")} pontos`}</Btn>
      {(result || busy) && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE}
            style={{ borderRadius: 8, border: `1px solid ${theme.border}`, flexShrink: 0, background: "#0a0e17" }} />
          {result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontFamily: mono }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: theme.quantum }}>{result.piEst.toFixed(6)}</div>
              <div style={{ fontSize: 11, color: theme.textMuted }}>π real: {Math.PI.toFixed(6)}</div>
              <div style={{ fontSize: 11, color: theme.textDim }}>Erro: {result.errPct.toFixed(3)}%</div>
              <div style={{ fontSize: 10, color: theme.textMuted }}>{result.inside.toLocaleString()} dentro / {result.total.toLocaleString()} total</div>
              <SourceBadge source={result.meta?.source} latencyMs={result.meta?.latencyMs} />
            </div>
          )}
        </div>
      )}
      <ErrMsg msg={err} onLogin={onGoLogin} />
    </div>
  );
}

/* ── Card 4: Sorteio Auditável ────────────────────────────────────────────── */

function RaffleCard({ onGoLogin }) {
  const [names, setNames] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const draw = async () => {
    const list = names.split("\n").map(s => s.trim()).filter(Boolean);
    if (list.length < 2) { setErr("Insira pelo menos 2 participantes."); return; }
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await fetchQrngBytes(32);
      const winner = uniformIntFromBytes(0, list.length - 1, r.bytes);
      setResult({ winner: list[winner], idx: winner, total: list.length, meta: r, ts: new Date().toISOString() });
    } catch (e) {
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  const voucher = result
    ? `Sorteio Kuapoã/Dobslit | Vencedor: ${result.winner} | Participantes: ${result.total} | Timestamp: ${result.ts} | Source: ${result.meta?.source ?? "Kuapoã QRNG"} | Bytes: ${result.meta?.hex?.slice(0, 16)}... | Req: ${result.meta?.requestId ?? "n/a"}`
    : "";

  const copyVoucher = async () => {
    await navigator.clipboard.writeText(voucher);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>🎫 Sorteio Auditável</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Realize sorteios auditáveis usando bytes QRNG, com registro de timestamp, fonte e comprovante.
        Usa rejection sampling para evitar viés de módulo.
      </p>
      <textarea
        placeholder={"Ana Silva\nBruno Costa\nCarla Mendes\n..."}
        value={names}
        onChange={e => setNames(e.target.value)}
        rows={5}
        style={{
          resize: "vertical", fontFamily: mono, fontSize: 12,
          padding: "10px 12px", borderRadius: 8,
          border: `1px solid ${theme.border}`, background: "#fff",
          color: theme.text, outline: "none", width: "100%", boxSizing: "border-box",
        }}
      />
      <Btn onClick={draw} color={theme.quantum} disabled={busy}>{busy ? "Sorteando..." : "Sortear"}</Btn>
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            background: "linear-gradient(135deg, #0a1628, #0d1f3c)",
            borderRadius: 12, padding: "16px 20px",
            border: `1px solid ${theme.quantum}30`,
          }}>
            <div style={{ fontSize: 10, color: theme.quantum, fontFamily: mono, marginBottom: 6 }}>VENCEDOR</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#fff", fontFamily: grotesk }}>{result.winner}</div>
            <div style={{ fontSize: 11, color: "#5b96cc", fontFamily: mono, marginTop: 4 }}>
              #{result.idx + 1} de {result.total} participantes
            </div>
          </div>
          <div style={{ background: "#0a0e17", borderRadius: 10, padding: "10px 14px", border: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: mono, marginBottom: 6 }}>COMPROVANTE</div>
            <div style={{ fontSize: 10, color: "#5b96cc", fontFamily: mono, lineHeight: 1.6, wordBreak: "break-all" }}>
              {`Timestamp: ${result.ts}`}<br />
              {`Source: ${result.meta?.source ?? "Kuapoã QRNG"}`}<br />
              {`Bytes: ${result.meta?.hex?.slice(0, 32)}...`}<br />
              {result.meta?.requestId && `Req-ID: ${result.meta.requestId}`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Btn onClick={copyVoucher} color={copied ? theme.success : theme.accent} small>{copied ? "Copiado!" : "Copiar comprovante"}</Btn>
            <SourceBadge source={result.meta?.source} latencyMs={result.meta?.latencyMs} />
          </div>
        </div>
      )}
      <ErrMsg msg={err} onLogin={onGoLogin} />
    </div>
  );
}

/* ── Card 5: Jogos ────────────────────────────────────────────────────────── */

function GamesCard({ onGoLogin }) {
  const [coin, setCoin] = useState(null);
  const [dice, setDice] = useState(null);
  const [coinMeta, setCoinMeta] = useState(null);
  const [diceMeta, setDiceMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const flipCoin = async () => {
    setBusy(true); setErr(""); setCoin(null); setCoinMeta(null);
    try {
      const r = await fetchQrngBytes(1);
      setCoin((r.bytes[0] & 1) === 0 ? "CARA" : "COROA");
      setCoinMeta(r);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  const rollDice = async () => {
    setBusy(true); setErr(""); setDice(null); setDiceMeta(null);
    try {
      const r = await fetchQrngBytes(16);
      const val = uniformIntFromBytes(1, 6, r.bytes);
      setDice(val);
      setDiceMeta(r);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  const diceFace = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>🎲 Jogos e Educação</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Experimente moeda e dado alimentados por entropia quântica. Cada resultado usa bytes do Kuapoã/backend.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {/* Coin */}
        <div style={{ flex: 1, minWidth: 160, background: theme.surfaceAlt, borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, border: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>Moeda Quântica</div>
          <div style={{ textAlign: "center", fontSize: 40, minHeight: 50 }}>
            {coin === "CARA" ? "🌕" : coin === "COROA" ? "🌑" : "🪙"}
          </div>
          {coin && <div style={{ textAlign: "center", fontSize: 16, fontWeight: 800, fontFamily: mono, color: theme.quantum }}>{coin}</div>}
          <Btn onClick={flipCoin} color={theme.quantum} disabled={busy}>Lançar moeda</Btn>
          {coinMeta && (
            <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: mono }}>
              bit: {coinMeta.bytes[0] & 1} · byte: 0x{coinMeta.bytes[0].toString(16).padStart(2,"0")}<br/>
              <SourceBadge source={coinMeta.source} latencyMs={coinMeta.latencyMs} />
            </div>
          )}
        </div>
        {/* Dice */}
        <div style={{ flex: 1, minWidth: 160, background: theme.surfaceAlt, borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, border: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>Dado Quântico</div>
          <div style={{ textAlign: "center", fontSize: 44, minHeight: 50 }}>
            {dice ? diceFace[dice] : "🎲"}
          </div>
          {dice && <div style={{ textAlign: "center", fontSize: 16, fontWeight: 800, fontFamily: mono, color: theme.quantum }}>{dice}</div>}
          <Btn onClick={rollDice} color={theme.quantum} disabled={busy}>Lançar dado</Btn>
          {diceMeta && (
            <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: mono }}>
              rejection sampling 1–6<br/>
              <SourceBadge source={diceMeta.source} latencyMs={diceMeta.latencyMs} />
            </div>
          )}
        </div>
      </div>
      <ErrMsg msg={err} onLogin={onGoLogin} />
    </div>
  );
}

/* ── Card 6: Random Walk ──────────────────────────────────────────────────── */

function RandomWalkCard({ onGoLogin }) {
  const canvasRef = useRef(null);
  const [steps, setSteps] = useState(256);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const CANVAS = 280;

  const run = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const bytesNeeded = Math.ceil(steps / 4);
      const r = await fetchQrngBytes(bytesNeeded);
      const dirs = []; // 0=up, 1=down, 2=left, 3=right
      for (const byte of r.bytes) {
        dirs.push(byte & 3, (byte >> 2) & 3, (byte >> 4) & 3, (byte >> 6) & 3);
      }

      const path = [{ x: 0, y: 0 }];
      let x = 0, y = 0;
      for (let i = 0; i < steps; i++) {
        const d = dirs[i];
        if (d === 0) y--;
        else if (d === 1) y++;
        else if (d === 2) x--;
        else x++;
        path.push({ x, y });
      }

      // Fit path to canvas
      const xs = path.map(p => p.x), ys = path.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
      const pad = 20;
      const toCanvas = (px, py) => ({
        cx: pad + ((px - minX) / rangeX) * (CANVAS - pad * 2),
        cy: pad + ((py - minY) / rangeY) * (CANVAS - pad * 2),
      });

      setResult({ final: { x, y }, steps, meta: r });

      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, CANVAS, CANVAS);
        ctx.fillStyle = "#0a0e17";
        ctx.fillRect(0, 0, CANVAS, CANVAS);

        // Draw path
        ctx.beginPath();
        for (let i = 0; i < path.length; i++) {
          const { cx, cy } = toCanvas(path[i].x, path[i].y);
          if (i === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        }
        ctx.strokeStyle = theme.quantum + "80";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Start dot
        const { cx: sx, cy: sy } = toCanvas(path[0].x, path[0].y);
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fillStyle = theme.success; ctx.fill();

        // End dot
        const { cx: ex, cy: ey } = toCanvas(x, y);
        ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2);
        ctx.fillStyle = theme.danger; ctx.fill();
      });
    } catch (e) {
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>🚶 Random Walk Quântico</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Cada passo usa 2 bits do Kuapoã: 00=cima, 01=baixo, 10=esquerda, 11=direita.
        Verde = início · Vermelho = posição final.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[64, 256, 1024].map(n => <SizeBtn key={n} label={`${n} passos`} active={steps === n} onClick={() => { setSteps(n); setResult(null); }} />)}
      </div>
      <Btn onClick={run} color={theme.quantum} disabled={busy}>{busy ? "Caminhando..." : `Iniciar walk (${steps} passos)`}</Btn>
      {result && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <canvas ref={canvasRef} width={CANVAS} height={CANVAS}
            style={{ borderRadius: 8, border: `1px solid ${theme.border}`, flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontFamily: mono }}>
            <div style={{ fontSize: 11, color: theme.textDim }}>Posição final</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: theme.quantum }}>({result.final.x}, {result.final.y})</div>
            <div style={{ fontSize: 11, color: theme.textMuted }}>
              {steps} passos · {Math.ceil(steps / 4)} bytes
            </div>
            <SourceBadge source={result.meta?.source} latencyMs={result.meta?.latencyMs} />
          </div>
        </div>
      )}
      <ErrMsg msg={err} onLogin={onGoLogin} />
    </div>
  );
}

/* ── Card 7: Otimização ───────────────────────────────────────────────────── */

function OptimCard({ onGoLogin }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [n, setN] = useState(500);

  // f(x) = sin(x) + cos(2x), x in [0, 2π]
  const f = x => Math.sin(x) + Math.cos(2 * x);

  const run = async () => {
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await fetchQrngBytes(n * 4);
      const u32s = bytesToUint32Array(r.bytes);
      let best = -Infinity, bestX = 0, bestIdx = 0;
      const TWO_PI = Math.PI * 2;
      for (let i = 0; i < Math.min(n, u32s.length); i++) {
        const x = uint32ToFloat(u32s[i]) * TWO_PI;
        const val = f(x);
        if (val > best) { best = val; bestX = x; bestIdx = i; }
      }
      setResult({ bestX, bestF: best, n, sampleIdx: bestIdx, meta: r });
    } catch (e) {
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: grotesk, color: theme.text }}>📈 Otimização Estocástica</span>
        <Badge color={theme.success}>Funcional</Badge>
        <Badge color={theme.quantum}>QRNG</Badge>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: sans }}>
        Algoritmos de otimização estocástica dependem de boas fontes de aleatoriedade.
        Aqui buscamos o máximo de f(x) = sin(x) + cos(2x) em [0, 2π] por amostragem quântica aleatória.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[100, 500, 2000].map(v => <SizeBtn key={v} label={`${v} amostras`} active={n === v} onClick={() => { setN(v); setResult(null); }} />)}
      </div>
      <Btn onClick={run} color={theme.quantum} disabled={busy}>{busy ? "Otimizando..." : `Buscar máximo com ${n} amostras QRNG`}</Btn>
      {result && (
        <div style={{ background: "#0a0e17", borderRadius: 10, padding: "14px 16px", border: `1px solid ${theme.border}`, fontFamily: mono }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 9, color: theme.textMuted, marginBottom: 4 }}>x ótimo (rad)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: theme.quantum }}>{result.bestX.toFixed(5)}</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: theme.textMuted, marginBottom: 4 }}>f(x) máximo</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: theme.success }}>{result.bestF.toFixed(6)}</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: theme.textMuted, marginBottom: 4 }}>Amostras</div>
              <div style={{ fontSize: 14, color: "#7ab8f5" }}>{result.n}</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: theme.textMuted, marginBottom: 4 }}>Melhor amostra #</div>
              <div style={{ fontSize: 14, color: "#7ab8f5" }}>{result.sampleIdx + 1}</div>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <SourceBadge source={result.meta?.source} latencyMs={result.meta?.latencyMs} />
          </div>
        </div>
      )}
      <ErrMsg msg={err} onLogin={onGoLogin} />
    </div>
  );
}

/* ── Main Section ─────────────────────────────────────────────────────────── */

export default function ApplicationsSection() {
  const { setActivePage } = useContext(AppContext);
  const goLogin = useCallback(() => setActivePage("developer"), [setActivePage]);

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Intro */}
        <div style={{ ...card, background: "linear-gradient(135deg, #0a1628, #0d1f3c)", border: `1px solid ${theme.quantum}25` }}>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: grotesk, color: "#fff" }}>Aplicações Kuapoã</div>
          <p style={{ margin: 0, fontSize: 13, color: "#aac4e8", lineHeight: 1.75, fontFamily: sans }}>
            Explore demonstrações práticas da aleatoriedade quântica do Kuapoã. Todas as aplicações
            usam bytes fornecidos pelo QRNG/backend da Dobslit — incluindo o fallback interno quando a
            FPGA não estiver disponível. Nenhuma aplicação usa serviços externos de aleatoriedade.
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge color={theme.success}>7 demos</Badge>
            <Badge color={theme.quantum}>QRNG</Badge>
            <Badge color="#7ab8f5">Sem serviços externos</Badge>
          </div>
        </div>

        <KeyCard onGoLogin={goLogin} />
        <AISeedCard onGoLogin={goLogin} />
        <MonteCarloCard onGoLogin={goLogin} />
        <RaffleCard onGoLogin={goLogin} />
        <GamesCard onGoLogin={goLogin} />
        <RandomWalkCard onGoLogin={goLogin} />
        <OptimCard onGoLogin={goLogin} />
      </div>
    </div>
  );
}
