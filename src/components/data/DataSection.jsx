import { useState, useContext } from "react";
import { theme, formatBytes } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { getApiPrefix } from "../../qrngApi";
import Btn from "../ui/Btn";

const MONO = "'IBM Plex Mono', monospace";
const SANS = "'Outfit', sans-serif";
const MAX_BYTES = 1_048_576; // 1 MiB hard cap por request

// ─── Algoritmos de aleatoriedade (fontes: bytes QRNG) ─────────────
//
// Todos os números gerados neste módulo derivam exclusivamente de bytes
// recebidos da API QRNG (/qrng/v1/random).
// NÃO há uso de Math.random(), WebCrypto, random.org ou qualquer PRNG.

/**
 * Rejection-sampling para inteiro uniforme em [min, max].
 * Usa uint32 para eliminar viés em intervalos que não dividem 256.
 * Retorna { value, nextOffset } onde nextOffset é o próximo byte a consumir.
 */
function pickInt(bytes, offset, min, max) {
  const range = max - min + 1;
  // Maior múltiplo de range que cabe em uint32
  const limit = Math.floor(4294967296 / range) * range;
  let i = offset;
  while (i + 3 < bytes.length) {
    const n = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    i += 4;
    if (n < limit) return { value: min + (n % range), nextOffset: i };
  }
  // Fallback (buffer subdimensionado — shouldn't happen com bytesNeeded() correto)
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return { value: min + (n % range), nextOffset: offset + 4 };
}

/** Gera `count` números em [min, max] COM repetição usando rejection sampling. */
function genWithRepeats(bytes, min, max, count) {
  const nums = [];
  let off = 0;
  for (let i = 0; i < count; i++) {
    if (off + 3 >= bytes.length) throw new Error("Buffer QRNG insuficiente. Tente reduzir a quantidade.");
    const { value, nextOffset } = pickInt(bytes, off, min, max);
    nums.push(value);
    off = nextOffset;
  }
  return { nums, bytesConsumed: off };
}

/**
 * Algoritmo de Floyd F2: k amostras de {min, …, max} SEM repetição.
 * O(k) tempo e espaço, distribuição uniforme sobre todos os k-subconjuntos.
 * Usa rejection sampling por iteração (faixa cresce de pool-k até pool-1).
 */
function genWithoutRepeats(bytes, min, max, count) {
  const pool = max - min + 1;
  const S = new Set();
  let off = 0;
  for (let i = pool - count; i < pool; i++) {
    if (off + 3 >= bytes.length) throw new Error("Buffer QRNG insuficiente. Tente reduzir a quantidade.");
    const { value: j, nextOffset } = pickInt(bytes, off, 0, i);
    off = nextOffset;
    const candidate = j + min;
    S.has(candidate) ? S.add(i + min) : S.add(candidate);
  }
  return { nums: [...S], bytesConsumed: off };
}

/** Converte cada uint32 QRNG em float de [0, 1) via divisão por 2^32. */
function genMonteCarlo(bytes, count) {
  const nums = [];
  for (let i = 0; i + 3 < bytes.length && nums.length < count; i += 4) {
    const n = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    nums.push(n / 4294967296);
  }
  return nums;
}

/** Formata Uint8Array em string hexadecimal com separadores. */
function fmtHex(bytes, sep, bpl) {
  const pairs = Array.from(bytes).map(b => b.toString(16).padStart(2, "0"));
  if (sep === "none")  return pairs.join("");
  if (sep === "space") return pairs.join(" ");
  const lines = [];
  for (let i = 0; i < pairs.length; i += bpl) lines.push(pairs.slice(i, i + bpl).join(" "));
  return lines.join("\n");
}

/** Estatísticas básicas de um array numérico. */
function calcStats(nums) {
  if (!nums?.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const mean = (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4);
  return { count: nums.length, min, max, mean };
}

/** Dispara download de arquivo no browser. */
function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ─── Presets de aplicação ─────────────────────────────────────────

const PRESETS = [
  { id: "byte-array",   icon: "📦", label: "Byte Array",     desc: "uint8 · 0–255 · 1 KB",
    cfg: { mode: "uint8",  dlSize: 1024, u8Fmt: "csv" } },
  { id: "lottery",      icon: "🎰", label: "Loteria 6/60",   desc: "6 num · 1–60 · sem rep.",
    cfg: { mode: "range",  rMin: 1, rMax: 60,  rCount: 6,    rAllowRepeats: false, rSort: true,  rFmt: "json" } },
  { id: "dice",         icon: "🎲", label: "Dado (1d6)",     desc: "1 número · 1–6",
    cfg: { mode: "range",  rMin: 1, rMax: 6,   rCount: 1,    rAllowRepeats: true,  rSort: false, rFmt: "txt" } },
  { id: "monte-carlo",  icon: "📊", label: "Monte Carlo",    desc: "1000 floats · [0, 1)",
    cfg: { mode: "montecarlo", mcCount: 1000, mcFmt: "csv" } },
  { id: "ai-dataset",   icon: "🤖", label: "IA / Dataset",   desc: "uint8 · 4 KB · JSON",
    cfg: { mode: "uint8",  dlSize: 4096, u8Fmt: "json" } },
  { id: "shuffle-ids",  icon: "🔀", label: "Sorteio IDs",    desc: "sem rep. · faixa livre",
    cfg: { mode: "range",  rMin: 1, rMax: 100, rCount: 10,   rAllowRepeats: false, rSort: false, rFmt: "csv" } },
];

// ─── Estilos reutilizáveis ────────────────────────────────────────

const cardStyle = {
  background: theme.surface, borderRadius: 12,
  border: `1px solid ${theme.border}`, padding: "18px 20px",
  display: "flex", flexDirection: "column", gap: 14,
};

function ModeTab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 14px", borderRadius: 20, fontFamily: MONO, fontSize: 12, fontWeight: 600,
      cursor: "pointer", transition: "all 0.15s",
      border: `1.5px solid ${active ? theme.quantum : theme.border}`,
      background: active ? theme.quantum + "15" : "transparent",
      color: active ? theme.quantum : theme.textDim,
    }}>{children}</button>
  );
}

function FieldRow({ lbl, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: theme.textDim, fontFamily: MONO, minWidth: 130 }}>{lbl}</span>
      {children}
    </div>
  );
}

function NumInput({ value, onChange, min, max, w = 90 }) {
  return (
    <input type="number" value={value} onChange={onChange} min={min} max={max} style={{
      width: w, padding: "5px 10px", borderRadius: 6, outline: "none",
      border: `1px solid ${theme.border}`, background: "#fff",
      color: theme.text, fontSize: 12, fontFamily: MONO,
    }} />
  );
}

function Chk({ checked, onChange, children }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
      fontSize: 12, color: theme.textDim, fontFamily: SANS, userSelect: "none" }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: theme.quantum }} />
      {children}
    </label>
  );
}

function StatChip({ lbl, val }) {
  if (val === null || val === undefined) return null;
  return (
    <div style={{ padding: "3px 10px", borderRadius: 6,
      background: theme.quantumGlow, border: `1px solid ${theme.quantumDim}` }}>
      <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: MONO }}>{lbl}: </span>
      <span style={{ fontSize: 11, fontWeight: 700, color: theme.quantum, fontFamily: MONO }}>{val}</span>
    </div>
  );
}

const DL_SIZES = [
  { label: "1 KB",   value: 1024 },
  { label: "10 KB",  value: 10240 },
  { label: "100 KB", value: 102400 },
  { label: "1 MiB",  value: MAX_BYTES },
];

// ─── Componente principal ─────────────────────────────────────────

export default function DataSection() {
  const { isOnline, health, latency, qrngSource } = useContext(AppContext);

  // Modo de exportação
  const [mode, setMode] = useState("raw");

  // Tamanho comum (raw / hex / uint8)
  const [dlSize,      setDlSize]      = useState(1024);
  const [customSzIn,  setCustomSzIn]  = useState("");

  // Hex
  const [hexSep, setHexSep] = useState("space"); // "none" | "space" | "line"
  const [hexBpl, setHexBpl] = useState(16);      // bytes por linha
  const [hexFmt, setHexFmt] = useState("txt");   // "txt" | "json"

  // Decimal / uint8
  const [u8Fmt, setU8Fmt] = useState("csv"); // "csv" | "txt" | "json"

  // Faixa personalizada
  const [rMin,          setRMin]          = useState(1);
  const [rMax,          setRMax]          = useState(60);
  const [rCount,        setRCount]        = useState(6);
  const [rAllowRepeats, setRAllowRepeats] = useState(false);
  const [rSort,         setRSort]         = useState(true);
  const [rFmt,          setRFmt]          = useState("json"); // "json" | "csv" | "txt"

  // Monte Carlo
  const [mcCount, setMcCount] = useState(1000);
  const [mcFmt,   setMcFmt]   = useState("csv"); // "csv" | "json"

  // Estado do resultado
  const [status,     setStatus]     = useState("idle"); // "idle" | "generating" | "done" | "error"
  const [errorMsg,   setErrorMsg]   = useState("");
  const [resultData, setResultData] = useState(null);
  const [copied,     setCopied]     = useState(false);

  // ── Helpers de estado ───────────────────────────────────────────

  function resetResult() { setResultData(null); setStatus("idle"); setErrorMsg(""); }
  function changeMode(m) { setMode(m); resetResult(); }
  function applyPreset(cfg) {
    resetResult();
    if (cfg.mode   !== undefined) setMode(cfg.mode);
    if (cfg.dlSize !== undefined) setDlSize(cfg.dlSize);
    if (cfg.u8Fmt  !== undefined) setU8Fmt(cfg.u8Fmt);
    if (cfg.rMin   !== undefined) setRMin(cfg.rMin);
    if (cfg.rMax   !== undefined) setRMax(cfg.rMax);
    if (cfg.rCount !== undefined) setRCount(cfg.rCount);
    if (cfg.rAllowRepeats !== undefined) setRAllowRepeats(cfg.rAllowRepeats);
    if (cfg.rSort  !== undefined) setRSort(cfg.rSort);
    if (cfg.rFmt   !== undefined) setRFmt(cfg.rFmt);
    if (cfg.mcCount !== undefined) setMcCount(cfg.mcCount);
    if (cfg.mcFmt  !== undefined) setMcFmt(cfg.mcFmt);
  }

  // ── Validação ───────────────────────────────────────────────────

  function validate() {
    if (!isOnline)  return "Backend QRNG offline. Não é possível gerar dados reais agora.";
    if (mode === "raw" || mode === "hex" || mode === "uint8") {
      if (dlSize < 1 || dlSize > MAX_BYTES)
        return `Tamanho inválido. Use entre 1 e ${formatBytes(MAX_BYTES)}.`;
    }
    if (mode === "range") {
      if (rMax < rMin) return "Intervalo inválido: o valor máximo deve ser ≥ ao mínimo.";
      if (rCount < 1)  return "Quantidade deve ser ao menos 1.";
      if (rCount > 100_000) return "Quantidade máxima é 100 000.";
      if (!rAllowRepeats) {
        const pool = rMax - rMin + 1;
        if (rCount > pool)
          return `Quantidade inválida para modo sem repetição: intervalo [${rMin}–${rMax}] tem apenas ${pool} valores distintos.`;
      }
    }
    if (mode === "montecarlo") {
      if (mcCount < 1 || mcCount > 100_000) return "Quantidade deve ser entre 1 e 100 000.";
    }
    return null;
  }

  // ── Quantos bytes pedir à API ───────────────────────────────────

  function bytesNeeded() {
    if (mode === "raw" || mode === "hex" || mode === "uint8") return dlSize;
    // Para range/montecarlo: 4 bytes por número + margem 1.5× para rejection
    if (mode === "range")       return Math.min(MAX_BYTES, Math.ceil(rCount * 6));
    if (mode === "montecarlo")  return Math.min(MAX_BYTES, mcCount * 4 + 16);
    return 1024;
  }

  // ── Geração principal ───────────────────────────────────────────

  const handleGenerate = async () => {
    const err = validate();
    if (err) { setErrorMsg(err); setStatus("error"); return; }

    setStatus("generating");
    setErrorMsg("");
    setResultData(null);

    // Captura estado atual para armazenar no meta (evita inconsistência após download)
    const snap = {
      mode, dlSize, hexSep, hexBpl, hexFmt, u8Fmt,
      rMin, rMax, rCount, rAllowRepeats, rSort, rFmt,
      mcCount, mcFmt,
    };

    try {
      const needed    = bytesNeeded();
      const t0        = performance.now();
      const apiPrefix = getApiPrefix(qrngSource);

      const r = await fetch(`${apiPrefix}/random?bytes=${needed}&format=hex`, {
        signal: AbortSignal.timeout(90_000),
      });

      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `API QRNG retornou erro ${r.status}`);
      }

      const json = await r.json();
      const hex  = json.random || "";
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);

      const latencyMs = Math.round(performance.now() - t0);
      const source    = json.source ?? json.generator ?? "qrng";

      // ── Processamento por modo ────────────────────────────────
      let numbers = null;
      let bytesConsumed = bytes.length;
      let filename;

      if (snap.mode === "raw") {
        filename = `kuapua_qrng_raw_${formatBytes(snap.dlSize).replace(" ", "")}.bin`;

      } else if (snap.mode === "hex") {
        filename = `kuapua_qrng_hex_${snap.dlSize}bytes.${snap.hexFmt}`;

      } else if (snap.mode === "uint8") {
        numbers = Array.from(bytes);
        bytesConsumed = bytes.length;
        filename = `kuapua_qrng_uint8_${snap.dlSize}bytes.${snap.u8Fmt}`;

      } else if (snap.mode === "range") {
        const res = snap.rAllowRepeats
          ? genWithRepeats(bytes, snap.rMin, snap.rMax, snap.rCount)
          : genWithoutRepeats(bytes, snap.rMin, snap.rMax, snap.rCount);
        numbers = snap.rSort ? [...res.nums].sort((a, b) => a - b) : res.nums;
        bytesConsumed = res.bytesConsumed;
        filename = `kuapua_qrng_range_${snap.rMin}_${snap.rMax}_${snap.rCount}nums.${snap.rFmt}`;

      } else if (snap.mode === "montecarlo") {
        numbers = genMonteCarlo(bytes, snap.mcCount);
        bytesConsumed = numbers.length * 4;
        filename = `kuapua_qrng_montecarlo_${snap.mcCount}.${snap.mcFmt}`;
      }

      setResultData({ bytes, numbers, meta: { ...snap, bytesConsumed, source, latencyMs, filename } });
      setStatus("done");

    } catch (e) {
      setErrorMsg(e.message || "Erro ao gerar dados QRNG. Verifique sua conexão.");
      setStatus("error");
    }
  };

  // ── Download ─────────────────────────────────────────────────────

  function handleDownload() {
    if (!resultData) return;
    const { bytes, numbers, meta } = resultData;
    const m = meta.mode;

    if (m === "raw") {
      triggerDownload(bytes, meta.filename, "application/octet-stream");

    } else if (m === "hex") {
      const content = fmtHex(bytes, meta.hexSep, meta.hexBpl);
      if (meta.hexFmt === "json") {
        triggerDownload(
          JSON.stringify({ source: meta.source, bytes: bytes.length, hex: content }),
          meta.filename, "application/json"
        );
      } else {
        triggerDownload(content, meta.filename, "text/plain");
      }

    } else if (m === "uint8") {
      if (meta.u8Fmt === "csv") {
        triggerDownload(numbers.join(","), meta.filename, "text/csv");
      } else if (meta.u8Fmt === "json") {
        triggerDownload(
          JSON.stringify({ source: meta.source, count: numbers.length, data: numbers }),
          meta.filename, "application/json"
        );
      } else {
        triggerDownload(numbers.join("\n"), meta.filename, "text/plain");
      }

    } else if (m === "range") {
      if (meta.rFmt === "csv") {
        triggerDownload(numbers.join(","), meta.filename, "text/csv");
      } else if (meta.rFmt === "json") {
        triggerDownload(
          JSON.stringify({
            source: meta.source, min: meta.rMin, max: meta.rMax,
            count: meta.rCount, allowRepeats: meta.rAllowRepeats,
            sorted: meta.rSort, data: numbers,
          }),
          meta.filename, "application/json"
        );
      } else {
        triggerDownload(numbers.join("\n"), meta.filename, "text/plain");
      }

    } else if (m === "montecarlo") {
      if (meta.mcFmt === "csv") {
        triggerDownload(numbers.map(n => n.toFixed(15)).join("\n"), meta.filename, "text/csv");
      } else {
        triggerDownload(
          JSON.stringify({ source: meta.source, count: numbers.length, data: numbers }),
          meta.filename, "application/json"
        );
      }
    }
  }

  // ── Copiar ───────────────────────────────────────────────────────

  function handleCopy() {
    if (!resultData) return;
    const { bytes, numbers, meta } = resultData;
    let text = "";
    if (meta.mode === "raw" || meta.mode === "hex") {
      text = fmtHex(bytes.slice(0, 64), meta.hexSep, meta.hexBpl);
    } else if (meta.mode === "montecarlo") {
      text = numbers.slice(0, 50).map(n => n.toFixed(10)).join(", ");
    } else if (numbers) {
      text = numbers.slice(0, 200).join(", ");
    }
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  // ── Preview ──────────────────────────────────────────────────────

  const preview = (() => {
    if (!resultData) return null;
    const { bytes, numbers, meta } = resultData;
    if (meta.mode === "raw") {
      return {
        label: "Primeiros 32 bytes (hex):",
        text: fmtHex(bytes.slice(0, 32), "space", 16),
        stats: null,
      };
    }
    if (meta.mode === "hex") {
      return {
        label: `Primeiros 64 bytes (sep: ${meta.hexSep}):`,
        text: fmtHex(bytes.slice(0, 64), meta.hexSep, meta.hexBpl),
        stats: null,
      };
    }
    if (meta.mode === "uint8") {
      return {
        label: `Primeiros 32 de ${numbers.length} valores:`,
        text: numbers.slice(0, 32).join(", "),
        stats: calcStats(numbers),
      };
    }
    if (meta.mode === "range") {
      const preview50 = numbers.slice(0, 50);
      return {
        label: `${numbers.length} número(s) gerado(s) [${meta.rMin}–${meta.rMax}]:`,
        text: preview50.join(", ") + (numbers.length > 50 ? " ..." : ""),
        stats: calcStats(numbers),
      };
    }
    if (meta.mode === "montecarlo") {
      return {
        label: `${numbers.length} pontos Monte Carlo [0, 1):`,
        text: numbers.slice(0, 20).map(n => n.toFixed(10)).join("\n"),
        stats: calcStats(numbers),
      };
    }
    return null;
  })();

  // ── Render ───────────────────────────────────────────────────────

  const canGenerate = isOnline && status !== "generating";
  const hasDone     = status === "done" && !!resultData;
  const bufferInfo  = health?.buffer_level ?? health?.buffer ?? null;

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* ── Card 1: Status da fonte QRNG ──────────────────────── */}
        <div style={cardStyle}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: MONO }}>
            Fonte QRNG
          </span>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                width: 9, height: 9, borderRadius: "50%", display: "inline-block",
                background: isOnline ? theme.success : theme.danger,
                boxShadow: `0 0 6px ${isOnline ? theme.success : theme.danger}`,
              }} />
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO,
                color: isOnline ? theme.success : theme.danger }}>
                {isOnline ? "Backend QRNG online. Dados prontos para exportação." : "Backend QRNG offline. Não é possível gerar dados reais agora."}
              </span>
            </div>
            {latency && (
              <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: MONO }}>
                latência: {latency} ms
              </span>
            )}
            <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: MONO }}>
              fonte: {qrngSource}
            </span>
            {bufferInfo !== null && (
              <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: MONO }}>
                buffer: {typeof bufferInfo === "number" ? formatBytes(bufferInfo) : bufferInfo}
              </span>
            )}
          </div>
        </div>

        {/* ── Card 2: Modo de exportação ─────────────────────────── */}
        <div style={cardStyle}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: MONO }}>
            Modo de Exportação
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              ["raw",         "Raw Binário"],
              ["hex",         "Hexadecimal"],
              ["uint8",       "Decimal / uint8"],
              ["range",       "Faixa Personalizada"],
              ["montecarlo",  "Monte Carlo"],
            ].map(([id, lbl]) => (
              <ModeTab key={id} active={mode === id} onClick={() => changeMode(id)}>{lbl}</ModeTab>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: theme.textDim, fontFamily: SANS, lineHeight: 1.65 }}>
            {mode === "raw"        && "Exporta bytes QRNG brutos (.bin). Cada byte possui 8 bits de entropia quântica."}
            {mode === "hex"        && "Converte os bytes QRNG para representação hexadecimal. Útil para criptografia e depuração."}
            {mode === "uint8"      && "Exporta cada byte como inteiro 0–255 (uint8). Prático para ML, datasets e análise estatística."}
            {mode === "range"      && "Gera inteiros em intervalo [min, max] arbitrário. Usa rejection sampling (uint32) para eliminar viés."}
            {mode === "montecarlo" && "Gera floats em [0, 1) a partir de uint32 QRNG ÷ 2³². Resolução ≈ 2.3×10⁻¹⁰. Ideal para simulações."}
          </p>
        </div>

        {/* ── Card 3: Configurações do modo ──────────────────────── */}
        <div style={cardStyle}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: MONO }}>
            Configurações
          </span>

          {/* RAW */}
          {mode === "raw" && <>
            <FieldRow lbl="Tamanho:">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DL_SIZES.map(p => (
                  <ModeTab key={p.value} active={dlSize === p.value} onClick={() => setDlSize(p.value)}>
                    {p.label}
                  </ModeTab>
                ))}
              </div>
            </FieldRow>
            <FieldRow lbl="Personalizado (bytes):">
              <input
                type="number" value={customSzIn} placeholder="ex: 8192"
                onChange={e => setCustomSzIn(e.target.value)} min={1} max={MAX_BYTES}
                style={{ width: 110, padding: "5px 10px", borderRadius: 6, border: `1px solid ${theme.border}`,
                  background: "#fff", color: theme.text, fontSize: 12, fontFamily: MONO, outline: "none" }}
              />
              <Btn small color={theme.accent} onClick={() => {
                const v = parseInt(customSzIn);
                if (v >= 1 && v <= MAX_BYTES) { setDlSize(v); setCustomSzIn(""); }
              }}>Aplicar</Btn>
              <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: MONO }}>
                {formatBytes(dlSize)}
              </span>
            </FieldRow>
            <span style={{ fontSize: 11, color: theme.textDim, fontFamily: SANS }}>
              Formato binário puro (.bin). Arquivo de {formatBytes(dlSize)} = {dlSize.toLocaleString()} bytes.
            </span>
          </>}

          {/* HEX */}
          {mode === "hex" && <>
            <FieldRow lbl="Tamanho:">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DL_SIZES.map(p => (
                  <ModeTab key={p.value} active={dlSize === p.value} onClick={() => setDlSize(p.value)}>
                    {p.label}
                  </ModeTab>
                ))}
              </div>
            </FieldRow>
            <FieldRow lbl="Separador:">
              <div style={{ display: "flex", gap: 6 }}>
                {[["none","contínuo"],["space","espaços"],["line","por linha"]].map(([v,l]) => (
                  <ModeTab key={v} active={hexSep === v} onClick={() => setHexSep(v)}>{l}</ModeTab>
                ))}
              </div>
            </FieldRow>
            {hexSep === "line" && (
              <FieldRow lbl="Bytes por linha:">
                <NumInput value={hexBpl} onChange={e => setHexBpl(parseInt(e.target.value)||16)} min={1} max={256} w={70} />
              </FieldRow>
            )}
            <FieldRow lbl="Arquivo:">
              <div style={{ display: "flex", gap: 6 }}>
                {[["txt",".txt"],["json",".json"]].map(([v,l]) => (
                  <ModeTab key={v} active={hexFmt === v} onClick={() => setHexFmt(v)}>{l}</ModeTab>
                ))}
              </div>
            </FieldRow>
            <span style={{ fontSize: 11, color: theme.textDim, fontFamily: SANS }}>
              {dlSize.toLocaleString()} bytes → {(dlSize * 2).toLocaleString()} chars hex
              {hexSep === "space" ? ` (+${dlSize - 1} espaços)` : ""}
            </span>
          </>}

          {/* UINT8 */}
          {mode === "uint8" && <>
            <FieldRow lbl="Tamanho:">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DL_SIZES.map(p => (
                  <ModeTab key={p.value} active={dlSize === p.value} onClick={() => setDlSize(p.value)}>
                    {p.label}
                  </ModeTab>
                ))}
              </div>
            </FieldRow>
            <FieldRow lbl="Arquivo:">
              <div style={{ display: "flex", gap: 6 }}>
                {[["csv",".csv"],["txt",".txt"],["json",".json"]].map(([v,l]) => (
                  <ModeTab key={v} active={u8Fmt === v} onClick={() => setU8Fmt(v)}>{l}</ModeTab>
                ))}
              </div>
            </FieldRow>
            <span style={{ fontSize: 11, color: theme.textDim, fontFamily: SANS }}>
              {dlSize.toLocaleString()} números inteiros no intervalo 0–255, gerados de bytes QRNG brutos.
            </span>
          </>}

          {/* RANGE */}
          {mode === "range" && <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
              <FieldRow lbl="Mínimo:">
                <NumInput value={rMin} onChange={e => setRMin(parseInt(e.target.value)||0)} min={-9_999_999} max={9_999_999} />
              </FieldRow>
              <FieldRow lbl="Máximo:">
                <NumInput value={rMax} onChange={e => setRMax(parseInt(e.target.value)||0)} min={-9_999_999} max={9_999_999} />
              </FieldRow>
              <FieldRow lbl="Quantidade:">
                <NumInput value={rCount} onChange={e => setRCount(Math.max(1,parseInt(e.target.value)||1))} min={1} max={100_000} />
              </FieldRow>
            </div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <Chk checked={rAllowRepeats} onChange={e => setRAllowRepeats(e.target.checked)}>
                Permitir repetição
              </Chk>
              <Chk checked={rSort} onChange={e => setRSort(e.target.checked)}>
                Ordenar resultado
              </Chk>
            </div>
            <FieldRow lbl="Arquivo:">
              <div style={{ display: "flex", gap: 6 }}>
                {[["json",".json"],["csv",".csv"],["txt",".txt"]].map(([v,l]) => (
                  <ModeTab key={v} active={rFmt === v} onClick={() => setRFmt(v)}>{l}</ModeTab>
                ))}
              </div>
            </FieldRow>
            {!rAllowRepeats && rMax >= rMin && rCount > (rMax - rMin + 1) && (
              <div style={{ fontSize: 11, color: theme.danger, fontFamily: SANS }}>
                ✗ Quantidade inválida para modo sem repetição: intervalo [{rMin}–{rMax}] tem apenas {rMax - rMin + 1} valores.
              </div>
            )}
            {rMax >= rMin && rCount <= (rAllowRepeats ? rCount : (rMax - rMin + 1)) && (
              <div style={{ fontSize: 11, color: theme.textDim, fontFamily: SANS }}>
                Gera {rCount} número(s) no intervalo [{rMin}–{rMax}]. Faixa: {(rMax - rMin + 1).toLocaleString()} valores.
                {!rAllowRepeats && " · Algoritmo de Floyd F2 (sem repetição, sem viés)."}
                {rAllowRepeats  && " · Rejection sampling uint32 (sem viés)."}
              </div>
            )}
          </>}

          {/* MONTE CARLO */}
          {mode === "montecarlo" && <>
            <FieldRow lbl="Quantidade:">
              <NumInput value={mcCount} onChange={e => setMcCount(Math.max(1,parseInt(e.target.value)||1))} min={1} max={100_000} w={110} />
            </FieldRow>
            <FieldRow lbl="Arquivo:">
              <div style={{ display: "flex", gap: 6 }}>
                {[["csv",".csv"],["json",".json"]].map(([v,l]) => (
                  <ModeTab key={v} active={mcFmt === v} onClick={() => setMcFmt(v)}>{l}</ModeTab>
                ))}
              </div>
            </FieldRow>
            <span style={{ fontSize: 11, color: theme.textDim, fontFamily: SANS }}>
              Cada uint32 QRNG é mapeado para [0, 1) via n÷2³². Precisão de 15 casas decimais.
              Consome {(mcCount * 4).toLocaleString()} bytes QRNG.
            </span>
          </>}
        </div>

        {/* ── Card 4: Aplicações rápidas ──────────────────────────── */}
        <div style={cardStyle}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: MONO }}>
            Aplicações Rápidas
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
            {PRESETS.map(p => (
              <button
                key={p.id}
                onClick={() => applyPreset(p.cfg)}
                style={{
                  padding: "10px 12px", borderRadius: 10, textAlign: "left",
                  border: `1.5px solid ${theme.border}`, background: theme.surfaceAlt,
                  cursor: "pointer", transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = theme.quantum; e.currentTarget.style.background = theme.quantumGlow; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border;  e.currentTarget.style.background = theme.surfaceAlt; }}
              >
                <div style={{ fontSize: 18, marginBottom: 4 }}>{p.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: theme.text, fontFamily: SANS }}>{p.label}</div>
                <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: MONO, marginTop: 2 }}>{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Card 5: Prévia e Download ────────────────────────────── */}
        <div style={cardStyle}>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text, fontFamily: MONO }}>
            Prévia e Download
          </span>

          {/* Botões de ação */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn color={theme.quantum} disabled={!canGenerate} onClick={handleGenerate}>
              {status === "generating" ? "⏳ Gerando..." : "Gerar prévia"}
            </Btn>
            <Btn color={theme.success} disabled={!hasDone} onClick={handleDownload}>
              ↓ Baixar arquivo
            </Btn>
            <Btn color={theme.accent} disabled={!hasDone} onClick={handleCopy}>
              {copied ? "✓ Copiado!" : "Copiar"}
            </Btn>
            <Btn color={theme.textMuted} disabled={status === "idle"} onClick={resetResult}>
              Limpar
            </Btn>
          </div>

          {/* Mensagem de erro */}
          {(status === "error" || errorMsg) && (
            <div style={{
              padding: "8px 12px", borderRadius: 8, fontSize: 12, fontFamily: SANS,
              background: theme.danger + "10", border: `1px solid ${theme.danger}30`, color: theme.danger,
            }}>
              ✗ {errorMsg}
            </div>
          )}

          {/* Preview */}
          {preview && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 11, color: theme.textDim, fontFamily: MONO, fontWeight: 600 }}>
                {preview.label}
              </span>
              <pre style={{
                background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 8,
                padding: "10px 12px", fontSize: 11, fontFamily: MONO, color: theme.text,
                overflowX: "auto", maxHeight: 180, overflowY: "auto",
                whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0,
              }}>
                {preview.text}
              </pre>

              {/* Estatísticas */}
              {preview.stats && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <StatChip lbl="n"    val={preview.stats.count} />
                  <StatChip lbl="mín"  val={preview.stats.min} />
                  <StatChip lbl="máx"  val={preview.stats.max} />
                  <StatChip lbl="média" val={preview.stats.mean} />
                  {resultData?.meta?.bytesConsumed && (
                    <StatChip lbl="bytes QRNG" val={resultData.meta.bytesConsumed.toLocaleString()} />
                  )}
                </div>
              )}

              {/* Meta */}
              {resultData?.meta && (
                <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: MONO, lineHeight: 1.8 }}>
                  fonte: {resultData.meta.source}
                  {resultData.meta.latencyMs ? ` · latência API: ${resultData.meta.latencyMs} ms` : ""}
                  {` · arquivo: ${resultData.meta.filename}`}
                </div>
              )}

              <span style={{ fontSize: 12, color: theme.success, fontFamily: SANS, fontWeight: 600 }}>
                ✓ Arquivo gerado com sucesso usando entropia QRNG real.
                {resultData?.meta?.bytesConsumed
                  ? ` Foram consumidos ${resultData.meta.bytesConsumed.toLocaleString()} bytes QRNG.`
                  : ""}
              </span>
            </div>
          )}

          {/* Idle hint */}
          {status === "idle" && !errorMsg && (
            <span style={{ fontSize: 12, color: theme.textMuted, fontFamily: SANS }}>
              Configure o modo acima e clique em <strong>Gerar prévia</strong> para visualizar e baixar dados QRNG.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
