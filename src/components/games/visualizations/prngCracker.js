/**
 * LCG PRNG Cracker — visualização interativa.
 *
 * Fases:
 *  0  OBSERVAÇÃO  (0-89)   — coleta 3 saídas do LCG, mostra orbs brilhantes
 *  1  QUEBRANDO   (90-149) — animação da matemática, revela a e c
 *  2  PREDIÇÃO    (150+)   — prediz cada byte futuro, tile grid Prev→Real
 *
 * O módulo mantém um shadow LCG interno (seed 42) sincronizado com o
 * prngSeedRef do QuantumVisualizer. Na Fase 2 compara a predição do shadow
 * contra os bytes REAIS recebidos (bytes[0]):
 *   - Canvas PRNG: bytes vêm do mesmo LCG → 100% acerto
 *   - Canvas QRNG: bytes são quânticos → ~0.4% acerto
 */

import { LCG_A, LCG_C } from "../../../prng";

// ── LCG helpers ──────────────────────────────────────────────

const M = 0x100000000; // 2^32
const BM = BigInt(M);

function lcgRaw(seed) {
  return (Math.imul(seed, LCG_A) + LCG_C) >>> 0;
}

function modInverseBig(a, m) {
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

function crackLCG(x0, x1, x2) {
  const bx0 = BigInt(x0), bx1 = BigInt(x1), bx2 = BigInt(x2);
  const d1 = ((bx1 - bx0) % BM + BM) % BM;
  const d2 = ((bx2 - bx1) % BM + BM) % BM;
  const inv = modInverseBig(d1, BM);
  const a = (d2 * inv) % BM;
  const c = ((bx1 - a * bx0) % BM + BM) % BM;
  return { a: Number(a), c: Number(c) };
}

// ── Quantize (replica exata de generatePrngBytes) ────────────
const PRNG_LEVELS = 8;
const STEP = 255 / (PRNG_LEVELS - 1);

function rawToByte(rawSeed) {
  const value = (rawSeed >>> 16) / 65536;
  return Math.round(Math.floor(value * PRNG_LEVELS) * STEP);
}

// ── Visualização ─────────────────────────────────────────────

const PHASE_OBSERVE_END = 90;
const PHASE_CRACK_END = 150;
const NOTE_INTERVAL = 8; // frames entre notas

// Prediction grid tile constants
const TILE_W = 36;
const TILE_H = 22;
const TILE_GAP = 2;
const GRID_TOP = 62;   // below banner
const GRID_BOT = 28;   // space for accuracy bar
const MAX_PREDICTIONS = 700;

export function init(w, h, bytes) {
  const state = {
    frame: 0,
    bytesNeeded: 2,
    phase: 0,

    // Shadow LCG — synced with QuantumVisualizer's LCG
    shadowSeed: 42,
    rawStates: [], // raw 32-bit states coletados para cracking

    // Cracking
    crackedA: null,
    crackedC: null,
    crackProgress: 0,

    // Prediction — matchCount/missCount
    matchCount: 0,
    missCount: 0,

    // Visual
    orbs: [],         // { byte, rawState, alpha, pulse }
    equationAlpha: 0,
    showCrackedParams: false,

    // Prediction grid (Phase 2)
    predGrid: [],     // { predicted, actual, matched }
    concluded: false,

    // Audio
    audioEvents: [],
  };

  // Advance shadow LCG to sync with prngSeedRef
  // (QuantumVisualizer's generatePrngBytes already advanced by bytes.length)
  const count = bytes ? bytes.length : 0;
  for (let i = 0; i < count; i++) {
    state.shadowSeed = lcgRaw(state.shadowSeed);
  }

  return state;
}

export function update(state, bytes) {
  state.frame++;
  state.audioEvents = [];

  // Advance shadow LCG in lockstep and store intermediate raw states
  const rawSteps = [];
  for (let i = 0; i < bytes.length; i++) {
    state.shadowSeed = lcgRaw(state.shadowSeed);
    rawSteps.push(state.shadowSeed);
  }

  // ── Phase 0: Observation ──
  if (state.phase === 0) {
    // Collect one raw state every 25 frames for dramatic pacing
    if (state.orbs.length < 3 && state.frame % 25 === 15) {
      const raw = state.shadowSeed;
      const byte = rawToByte(raw);
      state.rawStates.push(raw);
      state.orbs.push({ byte, rawState: raw, alpha: 0, pulse: 0 });
      state.audioEvents.push({ type: "note", byte });
    }

    // Fade in orbs
    for (const o of state.orbs) {
      o.alpha = Math.min(1, o.alpha + 0.04);
      o.pulse = (o.pulse + 0.05) % (Math.PI * 2);
    }

    // Fade in equations after 2nd orb
    if (state.orbs.length >= 2) {
      state.equationAlpha = Math.min(1, state.equationAlpha + 0.015);
    }

    if (state.frame >= PHASE_OBSERVE_END && state.rawStates.length >= 3) {
      state.phase = 1;
    }
  }

  // ── Phase 1: Cracking ──
  if (state.phase === 1) {
    state.crackProgress = Math.min(1, (state.frame - PHASE_OBSERVE_END) / (PHASE_CRACK_END - PHASE_OBSERVE_END));

    if (state.crackProgress >= 1 && state.crackedA === null) {
      const result = crackLCG(state.rawStates[0], state.rawStates[1], state.rawStates[2]);
      state.crackedA = result.a;
      state.crackedC = result.c;
      state.showCrackedParams = true;
    }

    if (state.frame >= PHASE_CRACK_END) {
      state.phase = 2;
    }
  }

  // ── Phase 2: Prediction ──
  if (state.phase === 2 && !state.concluded && state.frame % NOTE_INTERVAL === 0 && rawSteps.length > 0) {
    const predictedByte = rawToByte(rawSteps[0]);
    const actualByte = bytes[0];
    const matched = predictedByte === actualByte;

    if (matched) state.matchCount++;
    else state.missCount++;

    // Add to prediction grid
    state.predGrid.push({ predicted: predictedByte, actual: actualByte, matched });

    // Check if experiment concluded
    if (state.predGrid.length >= MAX_PREDICTIONS) {
      state.concluded = true;
    }

    // Audio: match/mismatch feedback
    state.audioEvents.push({ type: matched ? "match" : "mismatch" });
  }

  state.bytesNeeded = 2;
  return state;
}

export function draw(ctx, state, w, h, color) {
  const cr = parseInt(color.slice(1, 3), 16);
  const cg = parseInt(color.slice(3, 5), 16);
  const cb = parseInt(color.slice(5, 7), 16);

  // Background
  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, w, h);

  // Conclusion screen — draw and return early
  if (state.concluded) {
    drawConclusion(ctx, state, w, h, cr, cg, cb);
    return;
  }

  const phases = ["OBSERVACAO", "QUEBRANDO O LCG...", "PREDICAO EM TEMPO REAL"];

  // ── Top label ──
  ctx.font = "bold 9px 'IBM Plex Mono', monospace";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.9)`;
  ctx.textAlign = "left";
  const phaseLabel = state.phase === 2
    ? `FASE 3: PREDICAO (${state.predGrid.length}/${MAX_PREDICTIONS})`
    : `FASE ${state.phase + 1}: ${phases[state.phase]}`;
  ctx.fillText(phaseLabel, 10, 16);

  // ── Phase 0: Orbs + Equations ──
  if (state.phase <= 1) {
    drawOrbs(ctx, state, w, h, cr, cg, cb);
    drawEquations(ctx, state, w, h, cr, cg, cb);
  }

  // ── Phase 1: Progress bar ──
  if (state.phase === 1) {
    drawCrackProgress(ctx, state, w, cr, cg, cb);
  }

  // ── Phase 2: Prediction grid + accuracy bar ──
  if (state.phase === 2) {
    drawCrackedBanner(ctx, state, w, cr, cg, cb);
    drawPredictionGrid(ctx, state, w, h, cr, cg, cb);
    drawAccuracyBar(ctx, state, w, h, cr, cg, cb);
  }
}

// ── Phase 2: Prediction Tile Grid ──

function drawPredictionGrid(ctx, state, w, h, cr, cg, cb) {
  const gridX = 4;
  const gridY = GRID_TOP;
  const gridW = w - 8;
  const gridH = h - GRID_TOP - GRID_BOT;

  const cols = Math.max(1, Math.floor(gridW / (TILE_W + TILE_GAP)));
  const rows = Math.max(1, Math.floor(gridH / (TILE_H + TILE_GAP)));
  const maxVisible = cols * rows;

  // Center grid horizontally
  const totalGridW = cols * (TILE_W + TILE_GAP) - TILE_GAP;
  const ox = gridX + (gridW - totalGridW) / 2;

  // Determine which tiles to show (scroll when full)
  const startIdx = Math.max(0, state.predGrid.length - maxVisible);
  const visibleTiles = state.predGrid.slice(startIdx);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const x = ox + col * (TILE_W + TILE_GAP);
      const y = gridY + row * (TILE_H + TILE_GAP);

      if (idx < visibleTiles.length) {
        const tile = visibleTiles[idx];
        const isNew = idx === visibleTiles.length - 1 && state.predGrid.length > 0;

        // Tile background — green for match, red for mismatch
        if (tile.matched) {
          ctx.fillStyle = isNew ? "rgba(15,169,104,0.45)" : "rgba(15,169,104,0.25)";
        } else {
          ctx.fillStyle = isNew ? "rgba(220,53,69,0.45)" : "rgba(220,53,69,0.25)";
        }
        roundRect(ctx, x, y, TILE_W, TILE_H, 3);
        ctx.fill();

        // Predicted value (top line)
        const hexPred = tile.predicted.toString(16).toUpperCase().padStart(2, "0");
        const hexActual = tile.actual.toString(16).toUpperCase().padStart(2, "0");

        ctx.font = "bold 8px 'IBM Plex Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = tile.matched
          ? `rgba(15,169,104,${isNew ? 0.95 : 0.8})`
          : `rgba(220,53,69,${isNew ? 0.95 : 0.8})`;
        ctx.fillText(hexPred, x + TILE_W / 2, y + 9);

        // Actual value (bottom line)
        ctx.fillStyle = `rgba(255,255,255,${isNew ? 0.7 : 0.5})`;
        ctx.fillText(hexActual, x + TILE_W / 2, y + 19);
      } else {
        // Empty placeholder tile
        ctx.fillStyle = `rgba(${cr},${cg},${cb},0.04)`;
        roundRect(ctx, x, y, TILE_W, TILE_H, 3);
        ctx.fill();
      }
    }
  }
}

function drawAccuracyBar(ctx, state, w, h, cr, cg, cb) {
  const total = state.matchCount + state.missCount;
  if (total === 0) return;

  const pct = state.matchCount / total;
  const isGood = pct > 0.8;
  const y = h - 24;

  // Progress bar background
  const barX = 8;
  const barW = w - 16;
  const barH = 8;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.08)`;
  roundRect(ctx, barX, y, barW, barH, 4);
  ctx.fill();

  // Progress bar fill
  ctx.fillStyle = isGood ? "rgba(15,169,104,0.65)" : "rgba(220,53,69,0.65)";
  roundRect(ctx, barX, y, Math.max(0, barW * pct), barH, 4);
  ctx.fill();

  // Left: accuracy
  ctx.font = "bold 9px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = isGood ? "rgba(15,169,104,0.9)" : "rgba(220,53,69,0.9)";
  ctx.fillText(`${state.matchCount}/${total} (${(pct * 100).toFixed(1)}%)`, barX, y - 5);

  // Right: progress to conclusion
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.45)`;
  ctx.fillText(`${total}/${MAX_PREDICTIONS}`, barX + barW, y - 5);
}

// ── Phase 0/1 visuals (unchanged) ──

function drawOrbs(ctx, state, w, h, cr, cg, cb) {
  for (let i = 0; i < state.orbs.length; i++) {
    const o = state.orbs[i];
    const cx = w * (0.2 + i * 0.3);
    const cy = h * 0.3;
    const pulse = 1 + Math.sin(o.pulse) * 0.15;
    const r = 18 * pulse;

    // Glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.5);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${o.alpha * 0.6})`);
    grad.addColorStop(0.4, `rgba(${cr},${cg},${cb},${o.alpha * 0.2})`);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r * 3, cy - r * 3, r * 6, r * 6);

    // Core
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${o.alpha * 0.9})`;
    ctx.fill();

    // Ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${o.alpha * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label
    ctx.font = "bold 8px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${o.alpha})`;
    ctx.fillText(`X${i}`, cx, cy + r + 14);
    ctx.font = "7px 'IBM Plex Mono', monospace";
    ctx.fillStyle = `rgba(255,255,255,${o.alpha * 0.6})`;
    ctx.fillText(`0x${o.rawState.toString(16).toUpperCase().padStart(8, "0")}`, cx, cy + r + 24);
  }
}

function drawEquations(ctx, state, w, h, cr, cg, cb) {
  const a = state.equationAlpha;
  if (a < 0.01) return;

  ctx.textAlign = "center";
  const cx = w * 0.5;
  let y = h * 0.58;

  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},${a * 0.8})`;
  ctx.fillText("X(n+1) = a \u00B7 X(n) + c  mod 2\u00B3\u00B2", cx, y);

  if (state.phase === 1) {
    y += 18;
    ctx.font = "9px 'IBM Plex Mono', monospace";
    const revealA = state.crackProgress > 0.5;
    const revealC = state.crackProgress > 0.8;
    ctx.fillStyle = `rgba(255,255,255,${Math.min(a, state.crackProgress) * 0.7})`;
    ctx.fillText("a = (X2\u2212X1) \u00B7 (X1\u2212X0)\u207B\u00B9 mod 2\u00B3\u00B2", cx, y);

    if (revealA) {
      y += 16;
      ctx.fillStyle = `rgba(80,255,120,${(state.crackProgress - 0.5) * 2})`;
      ctx.font = "bold 10px 'IBM Plex Mono', monospace";
      ctx.fillText(`a = ${LCG_A}`, cx, y);
    }
    if (revealC) {
      y += 16;
      ctx.fillStyle = `rgba(80,255,120,${(state.crackProgress - 0.8) * 5})`;
      ctx.fillText(`c = ${LCG_C}`, cx, y);
    }
  }
}

function drawCrackProgress(ctx, state, w, cr, cg, cb) {
  const bx = w * 0.15, by = w * 0.78 > 200 ? 200 : w * 0.6, bw = w * 0.7, bh = 5;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.15)`;
  roundRect(ctx, bx, by, bw, bh, 3);
  ctx.fill();
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.8)`;
  roundRect(ctx, bx, by, bw * state.crackProgress, bh, 3);
  ctx.fill();
  ctx.font = "8px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.6)`;
  ctx.fillText(`${Math.floor(state.crackProgress * 100)}%`, bx + bw, by - 4);
}

function drawCrackedBanner(ctx, state, w, cr, cg, cb) {
  const bannerH = 38;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.06)`;
  ctx.fillRect(0, 22, w, bannerH);

  ctx.font = "8px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.5)`;
  ctx.fillText("X(n+1) = a \u00B7 X(n) + c  mod 2\u00B3\u00B2", w / 2, 35);

  if (state.crackedA !== null) {
    ctx.font = "bold 8px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "rgba(80,255,120,0.85)";
    ctx.fillText(`a=${state.crackedA}  c=${state.crackedC}`, w / 2, 50);
  }
}

function drawConclusion(ctx, state, w, h, cr, cg, cb) {
  const total = state.matchCount + state.missCount;
  const pct = total > 0 ? state.matchCount / total : 0;
  const isGood = pct > 0.8;
  const cx = w / 2;

  // Decorative glow
  const pulse = 0.5 + Math.sin(state.frame * 0.03) * 0.2;
  const gr = isGood ? 15 : 220, gg = isGood ? 169 : 53, gb = isGood ? 104 : 69;
  const grad = ctx.createRadialGradient(cx, h * 0.36, 0, cx, h * 0.36, w * 0.4);
  grad.addColorStop(0, `rgba(${gr},${gg},${gb},${pulse * 0.12})`);
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Header
  ctx.font = `bold ${Math.min(9, w * 0.025)}px 'IBM Plex Mono', monospace`;
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.6)`;
  ctx.fillText("EXPERIMENTO CONCLUIDO", cx, 20);

  // Big percentage
  ctx.font = `bold ${Math.min(42, w * 0.12)}px 'Space Grotesk', sans-serif`;
  ctx.fillStyle = isGood ? "rgba(15,169,104,0.95)" : "rgba(220,53,69,0.95)";
  ctx.fillText(`${(pct * 100).toFixed(1)}%`, cx, h * 0.36);

  // "ACURACIA" label
  ctx.font = `bold ${Math.min(10, w * 0.028)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillText("ACURACIA", cx, h * 0.42);

  // Status subtitle
  ctx.font = `bold ${Math.min(14, w * 0.038)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = isGood ? "rgba(80,255,120,0.85)" : "rgba(220,53,69,0.85)";
  ctx.fillText(isGood ? "LCG QUEBRADO" : "IMPREVISIVEL", cx, h * 0.53);

  // Match count
  ctx.font = `${Math.min(10, w * 0.028)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillText(`${state.matchCount}/${total} predicoes corretas`, cx, h * 0.61);

  // Formula
  ctx.font = `${Math.min(9, w * 0.024)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.3)`;
  ctx.fillText("X(n+1) = a \u00B7 X(n) + c  mod 2\u00B3\u00B2", cx, h * 0.73);

  if (state.crackedA !== null) {
    ctx.fillStyle = isGood ? "rgba(80,255,120,0.4)" : `rgba(${cr},${cg},${cb},0.2)`;
    ctx.fillText(`a=${state.crackedA}  c=${state.crackedC}`, cx, h * 0.79);
  }

  // Bottom accuracy bar
  const barX = w * 0.15, barW = w * 0.7, barH = 8, barY = h * 0.88;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.08)`;
  roundRect(ctx, barX, barY, barW, barH, 4);
  ctx.fill();
  ctx.fillStyle = isGood ? `rgba(15,169,104,${0.5 + pulse * 0.3})` : `rgba(220,53,69,${0.5 + pulse * 0.3})`;
  roundRect(ctx, barX, barY, Math.max(0, barW * pct), barH, 4);
  ctx.fill();
}

function roundRect(ctx, x, y, rw, rh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + rw - r, y);
  ctx.quadraticCurveTo(x + rw, y, x + rw, y + r);
  ctx.lineTo(x + rw, y + rh - r);
  ctx.quadraticCurveTo(x + rw, y + rh, x + rw - r, y + rh);
  ctx.lineTo(x + r, y + rh);
  ctx.quadraticCurveTo(x, y + rh, x, y + rh - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function bytesPerFrame() {
  return 2;
}
