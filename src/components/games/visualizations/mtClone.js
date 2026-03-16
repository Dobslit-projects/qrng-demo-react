/**
 * MT19937 (Mersenne Twister) Clone — visualização interativa.
 *
 * Fases:
 *  0  COLETA       — grid 26×24 = 624 células iluminando conforme saídas são coletadas
 *  1  CLONADO      — flash + wave sweep na grid
 *  2  PREDIÇÃO     — tile grid Prev→Real + mini grid colorida por acertos
 *
 * Usa `state._isPrng` (setado pelo QuantumVisualizer) para saber qual canvas:
 *   - PRNG canvas: comparação interna MT (clone sempre acerta)
 *   - QRNG canvas: compara predição contra bytes[0] (falha)
 */

// ── MT19937 implementation ───────────────────────────────────

const N = 624, MT_M = 397;
const MATRIX_A = 0x9908B0DF;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7FFFFFFF;

function mtCreate(seed) {
  const mt = new Uint32Array(N);
  mt[0] = seed >>> 0;
  for (let i = 1; i < N; i++) {
    const prev = mt[i - 1];
    mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
  }
  return { state: mt, index: N };
}

function mtTwist(gen) {
  const mt = gen.state;
  for (let i = 0; i < N; i++) {
    const y = (mt[i] & UPPER_MASK) | (mt[(i + 1) % N] & LOWER_MASK);
    mt[i] = mt[(i + MT_M) % N] ^ (y >>> 1);
    if (y & 1) mt[i] ^= MATRIX_A;
  }
  gen.index = 0;
}

function mtNext(gen) {
  if (gen.index >= N) mtTwist(gen);
  let y = gen.state[gen.index++];
  y ^= (y >>> 11);
  y ^= (y << 7) & 0x9D2C5680;
  y ^= (y << 15) & 0xEFC60000;
  y ^= (y >>> 18);
  return y >>> 0;
}

function untemper(y) {
  y ^= (y >>> 18);
  y ^= (y << 15) & 0xEFC60000;

  // Undo y ^= (y << 7) & 0x9D2C5680 — iterative, 7 bits per pass
  let z = y;
  for (let i = 0; i < 4; i++) {
    y = z ^ ((y << 7) & 0x9D2C5680);
  }

  // Undo y ^= (y >>> 11) — iterative, 11 bits per pass
  z = y;
  y = z ^ (y >>> 11);
  y = z ^ (y >>> 11);

  return y >>> 0;
}

function mtCloneFrom(outputs) {
  const clone = { state: new Uint32Array(N), index: N };
  for (let i = 0; i < N; i++) {
    clone.state[i] = untemper(outputs[i]);
  }
  return clone;
}

// ── Visualization constants ──────────────────────────────────

const COLS = 26, ROWS = 24; // 26×24 = 624
const CLONE_FLASH_DUR = 30;
const COLLECT_SPEED = 12; // outputs per frame during collection
const NOTE_INTERVAL = 8;

// Prediction grid tile constants
const TILE_W = 36;
const TILE_H = 22;
const TILE_GAP = 2;
const GRID_TOP = 98;   // below mini grid
const GRID_BOT = 28;   // space for accuracy bar
const MAX_PREDICTIONS = 624;

export function init() {
  return {
    frame: 0,
    bytesNeeded: 2,
    phase: 0,

    // MT source generator (produces outputs to be "cloned")
    sourceGen: mtCreate(42),
    collected: [],      // raw 32-bit outputs
    collectedCount: 0,

    // Cloned generator (after 624 outputs)
    clonedGen: null,

    // Prediction
    matchCount: 0,
    missCount: 0,

    // Visual
    gridCells: new Uint8Array(N), // 0=dark, 1=filling, 2=lit
    cloneFlashAge: -1,

    // Prediction grid (Phase 2)
    predGrid: [],                        // { predicted, actual, matched }
    predOutcomes: new Array(N).fill(0),  // 0=neutral, 1=match, -1=miss
    predCount: 0,
    concluded: false,

    // Audio
    audioEvents: [],

    // Flag set by QuantumVisualizer
    _isPrng: false,
  };
}

export function update(state, bytes) {
  state.frame++;
  state.audioEvents = [];

  // ── Phase 0: Collection ──
  if (state.phase === 0) {
    const toCollect = Math.min(COLLECT_SPEED, N - state.collectedCount);
    for (let i = 0; i < toCollect; i++) {
      const val = mtNext(state.sourceGen);
      state.collected.push(val);
      state.gridCells[state.collectedCount] = 2;
      state.collectedCount++;

      if (state.collectedCount % 16 === 0) {
        state.audioEvents.push({ type: "tick" });
      }
    }

    // Mark next cells as "filling"
    for (let i = state.collectedCount; i < Math.min(state.collectedCount + 3, N); i++) {
      if (state.gridCells[i] === 0) state.gridCells[i] = 1;
    }

    if (state.collectedCount >= N) {
      state.phase = 1;
      state.cloneFlashAge = 0;
      state.clonedGen = mtCloneFrom(state.collected);
    }
  }

  // ── Phase 1: Clone animation ──
  if (state.phase === 1) {
    state.cloneFlashAge++;
    if (state.cloneFlashAge >= CLONE_FLASH_DUR) {
      state.phase = 2;
    }
  }

  // ── Phase 2: Prediction ──
  if (state.phase === 2 && !state.concluded && state.frame % NOTE_INTERVAL === 0 && state.clonedGen) {
    const predicted32 = mtNext(state.clonedGen);
    const predictedByte = (predicted32 >>> 24) & 0xFF;

    let actualByte;
    if (state._isPrng) {
      const actual32 = mtNext(state.sourceGen);
      actualByte = (actual32 >>> 24) & 0xFF;
    } else {
      mtNext(state.sourceGen); // advance to stay in sync
      actualByte = bytes[0];
    }

    const matched = predictedByte === actualByte;

    if (matched) state.matchCount++;
    else state.missCount++;

    // Add to prediction grid
    state.predGrid.push({ predicted: predictedByte, actual: actualByte, matched });

    // Update mini grid outcomes
    state.predOutcomes[state.predCount % N] = matched ? 1 : -1;
    state.predCount++;

    // Check if experiment concluded
    if (state.predCount >= MAX_PREDICTIONS) {
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

  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, w, h);

  // Conclusion screen — draw and return early
  if (state.concluded) {
    drawConclusion(ctx, state, w, h, cr, cg, cb);
    return;
  }

  // ── Phase 0 & 1: Collection + Full Grid ──
  if (state.phase <= 1) {
    drawCollectionHeader(ctx, state, w, cr, cg, cb);
    drawGrid(ctx, state, w, h, cr, cg, cb);
  }

  // ── Phase 1: Clone flash ──
  if (state.phase === 1) {
    drawCloneFlash(ctx, state, w, h, cr, cg, cb);
  }

  // ── Phase 2: Mini grid + prediction tile grid + accuracy bar ──
  if (state.phase === 2) {
    drawPhaseLabel(ctx, state, w, cr, cg, cb);
    drawMiniGrid(ctx, state, w, cr, cg, cb);
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

// ── Phase 0/1 visuals ──

function drawCollectionHeader(ctx, state, w, cr, cg, cb) {
  ctx.font = "bold 9px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.9)`;
  ctx.fillText(`COLETANDO SAIDAS: ${state.collectedCount}/${N}`, 10, 16);

  // Progress bar
  const bx = 10, by = 24, bw = w - 20, bh = 5;
  const pct = state.collectedCount / N;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.12)`;
  roundRect(ctx, bx, by, bw, bh, 3);
  ctx.fill();
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.75)`;
  roundRect(ctx, bx, by, Math.max(0, bw * pct), bh, 3);
  ctx.fill();

  ctx.font = "7px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.5)`;
  ctx.fillText(`${(pct * 100).toFixed(1)}%`, bx + bw, by + bh + 10);
}

function drawGrid(ctx, state, w, h, cr, cg, cb) {
  const margin = 12;
  const gy = 46;
  const maxH = h * 0.6;
  const cellMax = 12;

  const gridW = w - margin * 2;
  const cellW = (gridW - (COLS - 1)) / COLS;
  const cellH = (maxH - (ROWS - 1)) / ROWS;
  const cellSize = Math.min(cellW, cellH, cellMax);
  const gap = 1;

  const totalW = COLS * (cellSize + gap) - gap;
  const totalH = ROWS * (cellSize + gap) - gap;
  const ox = (w - totalW) / 2;
  const oy = gy;

  const waveFront = state.phase === 1 ? (state.cloneFlashAge / CLONE_FLASH_DUR) * N : -1;

  for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = ox + col * (cellSize + gap);
    const y = oy + row * (cellSize + gap);
    const cellState = state.gridCells[i];

    let alpha;
    if (cellState === 2) {
      alpha = 0.7;
      if (waveFront >= 0 && i <= waveFront) alpha = 0.95;
    } else if (cellState === 1) {
      alpha = 0.2 + Math.sin(state.frame * 0.1) * 0.1;
    } else {
      alpha = 0.05;
    }

    ctx.fillStyle = cellState === 0
      ? "rgba(26,30,46,0.8)"
      : `rgba(${cr},${cg},${cb},${alpha})`;
    ctx.fillRect(x, y, cellSize, cellSize);
  }

  ctx.font = "7px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.35)`;
  ctx.fillText("ESTADO INTERNO (624 PALAVRAS DE 32 BITS)", w / 2, oy + totalH + 14);

  return oy + totalH;
}

function drawMiniGrid(ctx, state, w, cr, cg, cb) {
  const margin = 6;
  const gy = 22;
  const cellSize = Math.max(2, Math.min(4, (w - margin * 2) / COLS - 1));
  const gap = 1;
  const totalW = COLS * (cellSize + gap) - gap;
  const ox = (w - totalW) / 2;

  for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = ox + col * (cellSize + gap);
    const y = gy + row * (cellSize + gap);

    const outcome = state.predOutcomes[i];
    const pulse = 0.4 + Math.sin(state.frame * 0.02 + i * 0.01) * 0.15;

    if (outcome === 1) {
      // Match — green
      ctx.fillStyle = `rgba(15,169,104,${pulse + 0.15})`;
    } else if (outcome === -1) {
      // Miss — red
      ctx.fillStyle = `rgba(220,53,69,${pulse + 0.15})`;
    } else {
      // Not yet predicted — theme color
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${pulse})`;
    }
    ctx.fillRect(x, y, cellSize, cellSize);
  }
}

function drawCloneFlash(ctx, state, w, h, cr, cg, cb) {
  const progress = state.cloneFlashAge / CLONE_FLASH_DUR;
  const alpha = Math.max(0, 1 - progress * 1.5);

  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.5);
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha * 0.3})`);
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (progress < 0.8) {
    const scale = 1 + (1 - progress) * 0.5;
    ctx.save();
    ctx.translate(w / 2, h * 0.82);
    ctx.scale(scale, scale);
    ctx.font = "bold 24px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(255,255,255,${(1 - progress * 1.2) * 0.95})`;
    ctx.shadowColor = `rgba(${cr},${cg},${cb},0.8)`;
    ctx.shadowBlur = 20;
    ctx.fillText("CLONADO!", 0, 0);
    ctx.shadowBlur = 0;
    ctx.restore();
  }
}

function drawPhaseLabel(ctx, state, w, cr, cg, cb) {
  const total = state.matchCount + state.missCount;
  const pct = total > 0 ? state.matchCount / total : 0;
  const isCloned = pct > 0.8;

  ctx.font = "bold 8px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.6)`;
  ctx.fillText(`PREDICAO ${state.predCount}/${MAX_PREDICTIONS}`, 6, 18);

  ctx.textAlign = "right";
  ctx.fillStyle = isCloned ? "rgba(80,255,120,0.7)" : "rgba(220,53,69,0.7)";
  ctx.fillText(isCloned ? "MT19937 CLONADO" : "CLONE FALHOU", w - 6, 18);
}

function drawConclusion(ctx, state, w, h, cr, cg, cb) {
  const total = state.matchCount + state.missCount;
  const pct = total > 0 ? state.matchCount / total : 0;
  const isCloned = pct > 0.8;
  const cx = w / 2;

  // Header
  ctx.font = "bold 8px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.6)`;
  ctx.fillText("EXPERIMENTO CONCLUIDO", 6, 18);

  // Draw completed mini grid showing all outcomes
  drawMiniGrid(ctx, state, w, cr, cg, cb);

  // Content area below mini grid
  const contentY = GRID_TOP + 4;
  const contentH = h - contentY - 28;

  // Decorative glow
  const pulse = 0.5 + Math.sin(state.frame * 0.03) * 0.2;
  const gr = isCloned ? 15 : 220, gg = isCloned ? 169 : 53, gb = isCloned ? 104 : 69;
  const grad = ctx.createRadialGradient(cx, contentY + contentH * 0.3, 0, cx, contentY + contentH * 0.3, w * 0.4);
  grad.addColorStop(0, `rgba(${gr},${gg},${gb},${pulse * 0.12})`);
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, contentY, w, contentH);

  // Big percentage
  ctx.font = `bold ${Math.min(38, w * 0.11)}px 'Space Grotesk', sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = isCloned ? "rgba(15,169,104,0.95)" : "rgba(220,53,69,0.95)";
  ctx.fillText(`${(pct * 100).toFixed(1)}%`, cx, contentY + contentH * 0.28);

  // "ACURACIA" label
  ctx.font = `bold ${Math.min(10, w * 0.028)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillText("ACURACIA", cx, contentY + contentH * 0.36);

  // Status
  ctx.font = `bold ${Math.min(13, w * 0.035)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = isCloned ? "rgba(80,255,120,0.85)" : "rgba(220,53,69,0.85)";
  ctx.fillText(isCloned ? "MT19937 CLONADO" : "CLONE FALHOU", cx, contentY + contentH * 0.50);

  // Match count
  ctx.font = `${Math.min(10, w * 0.026)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillText(`${state.matchCount}/${total} predicoes corretas`, cx, contentY + contentH * 0.62);

  // Technical info
  ctx.font = `${Math.min(8, w * 0.022)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.3)`;
  ctx.fillText("624 \u00D7 32 bits | Untempering", cx, contentY + contentH * 0.76);

  // Bottom accuracy bar
  const barX = w * 0.15, barW = w * 0.7, barH = 8, barY = h - 20;
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.08)`;
  roundRect(ctx, barX, barY, barW, barH, 4);
  ctx.fill();
  ctx.fillStyle = isCloned ? `rgba(15,169,104,${0.5 + pulse * 0.3})` : `rgba(220,53,69,${0.5 + pulse * 0.3})`;
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
