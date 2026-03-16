const SYMMETRY = 8;
const POINTS_PER_BURST = 1;
const BURST_EVERY = 8;
const BYTES_PER_FRAME = POINTS_PER_BURST * 2;

// Coverage grid — tracks which cells of the canvas have been drawn on
const COV_GRID = 100; // 100x100 = finer granularity, ~1120 cells in reachable circle
const COV_TOTAL = COV_GRID * COV_GRID;

const RESET_INTERVAL = 3600; // 50% longer run (~25s at 144fps)
const SPARK_SAMPLE_EVERY = 30; // sample coverage % every 30 frames

export function init(w, h) {
  // Precompute which grid cells fall inside the mandala's REACHABLE area
  // Points have radius = rawR² * 0.42 + 0.05, so max reachable = 0.47 * maxR
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) * 0.48;
  const reachableR = maxR * 0.47;
  const cellW = w / COV_GRID;
  const cellH = h / COV_GRID;
  let circularCells = 0;
  for (let row = 0; row < COV_GRID; row++) {
    for (let col = 0; col < COV_GRID; col++) {
      const cellCx = (col + 0.5) * cellW;
      const cellCy = (row + 0.5) * cellH;
      const dx = cellCx - cx;
      const dy = cellCy - cy;
      if (dx * dx + dy * dy <= reachableR * reachableR) circularCells++;
    }
  }

  return {
    frame: 0,
    points: [],
    maxPoints: 1200,
    bytesNeeded: BYTES_PER_FRAME,
    coverageGrid: new Uint8Array(COV_TOTAL),
    coverageCount: 0,
    circularCellCount: Math.max(circularCells, 1),
    sparkline: [], // array of coverage % samples over time
  };
}

function markCoverageArea(state, x, y, w, h, glowR) {
  const cellW = w / COV_GRID;
  const cellH = h / COV_GRID;
  const centerCol = Math.floor((x / w) * COV_GRID);
  const centerRow = Math.floor((y / h) * COV_GRID);
  const rCols = Math.ceil(glowR / cellW);
  const rRows = Math.ceil(glowR / cellH);

  for (let dr = -rRows; dr <= rRows; dr++) {
    for (let dc = -rCols; dc <= rCols; dc++) {
      // Circular distance check — match round glow shape
      const distX = dc * cellW;
      const distY = dr * cellH;
      if (distX * distX + distY * distY > glowR * glowR) continue;

      const col = centerCol + dc;
      const row = centerRow + dr;
      if (col < 0 || col >= COV_GRID || row < 0 || row >= COV_GRID) continue;
      const idx = row * COV_GRID + col;
      if (!state.coverageGrid[idx]) {
        state.coverageGrid[idx] = 1;
        state.coverageCount++;
      }
    }
  }
}

export function update(state, bytes) {
  state.frame++;

  if (state.frame % BURST_EVERY === 0) {
    for (let i = 0; i < POINTS_PER_BURST; i++) {
      const bIdx = (i * 2) % bytes.length;
      const angleByte = bytes[bIdx] || Math.floor(Math.random() * 256);
      const radiusByte = bytes[bIdx + 1] || Math.floor(Math.random() * 256);

      const sectorAngle = (angleByte / 255) * (Math.PI * 2 / SYMMETRY);
      const rawR = radiusByte / 255;
      const radius = rawR * rawR * 0.42 + 0.05;

      state.points.push({
        angle: sectorAngle,
        radius,
        age: 0,
        hue: (state.frame * 0.04 + angleByte * 0.3) % 360,
        size: 1.5 + rawR * 2.0,
      });
    }
  }

  for (const p of state.points) p.age++;
  if (state.points.length > state.maxPoints) {
    state.points = state.points.slice(-state.maxPoints);
  }

  // Sample sparkline data
  if (state.frame % SPARK_SAMPLE_EVERY === 0) {
    const pct = Math.min(100, (state.coverageCount / state.circularCellCount) * 100);
    state.sparkline.push(pct);
  }

  // Reset cycle
  if (state.frame % RESET_INTERVAL === 0) {
    state.points = [];
    state.coverageGrid.fill(0);
    state.coverageCount = 0;
    state.sparkline = [];
  }

  state.bytesNeeded = BYTES_PER_FRAME;
  return state;
}

export function draw(ctx, state, w, h, color) {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) * 0.48;

  const cr = parseInt(color.slice(1, 3), 16);
  const cg = parseInt(color.slice(3, 5), 16);
  const cb = parseInt(color.slice(5, 7), 16);

  // === 1. CLEAR canvas completely each frame ===
  ctx.fillStyle = "#0c0e1a";
  ctx.fillRect(0, 0, w, h);

  // === 2. STAIN layer — subtle tint on all covered grid cells ===
  const cellW = w / COV_GRID;
  const cellH = h / COV_GRID;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.07)`;
  for (let i = 0; i < COV_TOTAL; i++) {
    if (state.coverageGrid[i]) {
      const col = i % COV_GRID;
      const row = Math.floor(i / COV_GRID);
      ctx.fillRect(col * cellW, row * cellH, cellW + 0.5, cellH + 0.5);
    }
  }

  // === 3. ACTIVE POINTS with age-based opacity decay ===
  const MAX_DRAW_AGE = 100;

  for (const p of state.points) {
    if (p.age >= MAX_DRAW_AGE) continue;
    const r = p.radius * maxR;
    const t = p.age / MAX_DRAW_AGE;
    const alpha = (1 - t * t) * 0.7; // quadratic decay
    if (alpha < 0.01) continue;

    const hueShift = p.hue;
    const sr = Math.floor(cr * 0.5 + 127 * (0.5 + 0.5 * Math.sin(hueShift * 0.017)));
    const sg = Math.floor(cg * 0.5 + 127 * (0.5 + 0.5 * Math.sin(hueShift * 0.017 + 2)));
    const sb = Math.floor(cb * 0.5 + 127 * (0.5 + 0.5 * Math.sin(hueShift * 0.017 + 4)));

    for (let s = 0; s < SYMMETRY; s++) {
      const angle = p.angle + (s * Math.PI * 2) / SYMMETRY;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      const mirrorAngle = -p.angle + (s * Math.PI * 2) / SYMMETRY;
      const mx = cx + Math.cos(mirrorAngle) * r;
      const my = cy + Math.sin(mirrorAngle) * r;

      // Glow dot
      const glowR = p.size * 4;

      // Mark coverage using visible core radius only
      const coreR = p.size * 1.0;
      if (p.age <= 1) {
        markCoverageArea(state, x, y, w, h, coreR);
        markCoverageArea(state, mx, my, w, h, coreR);
      }
      const grad = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      grad.addColorStop(0, `rgba(${sr},${sg},${sb},${alpha * 0.8})`);
      grad.addColorStop(0.4, `rgba(${sr},${sg},${sb},${alpha * 0.3})`);
      grad.addColorStop(1, `rgba(${sr},${sg},${sb},0)`);
      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Core
      ctx.beginPath();
      ctx.arc(x, y, p.size * 1.0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.5})`;
      ctx.fill();

      // Mirror
      const mGrad = ctx.createRadialGradient(mx, my, 0, mx, my, glowR);
      mGrad.addColorStop(0, `rgba(${sr},${sg},${sb},${alpha * 0.6})`);
      mGrad.addColorStop(0.4, `rgba(${sr},${sg},${sb},${alpha * 0.2})`);
      mGrad.addColorStop(1, `rgba(${sr},${sg},${sb},0)`);
      ctx.beginPath();
      ctx.arc(mx, my, glowR, 0, Math.PI * 2);
      ctx.fillStyle = mGrad;
      ctx.fill();
    }
  }

  ctx.globalCompositeOperation = "source-over";

  // Center glow
  const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.08);
  centerGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.12)`);
  centerGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = centerGrad;
  ctx.fill();

  // === 4. Subtle halo ring at reachable boundary ===
  const reachableR = maxR * 0.47;
  const haloGrad = ctx.createRadialGradient(cx, cy, reachableR - 6, cx, cy, reachableR + 6);
  haloGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
  haloGrad.addColorStop(0.5, `rgba(${cr},${cg},${cb},0.12)`);
  haloGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.beginPath();
  ctx.arc(cx, cy, reachableR + 6, 0, Math.PI * 2);
  ctx.fillStyle = haloGrad;
  ctx.fill();

  // === 5. SPARKLINE + COVERAGE overlay ===
  const covPct = Math.min(100, (state.coverageCount / state.circularCellCount) * 100);
  const covStr = covPct.toFixed(1);
  const spark = state.sparkline;

  const boxX = 6;
  const boxY = 6;
  const sparkW = 140;
  const sparkH = 36;
  const textH = 20;
  const totalH = sparkH + textH + 4;

  // Background box
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(boxX, boxY, sparkW + 12, totalH);

  // Sparkline chart
  if (spark.length > 1) {
    const chartX = boxX + 6;
    const chartY = boxY + 4;
    const chartW = sparkW;
    const chartH = sparkH;

    // Subtle grid lines at 25%, 50%, 75%
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 0.5;
    for (const pct of [25, 50, 75]) {
      const gy = chartY + chartH - (pct / 100) * chartH;
      ctx.beginPath();
      ctx.moveTo(chartX, gy);
      ctx.lineTo(chartX + chartW, gy);
      ctx.stroke();
    }

    // Coverage line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const maxSamples = Math.floor(RESET_INTERVAL / SPARK_SAMPLE_EVERY);
    for (let i = 0; i < spark.length; i++) {
      const sx = chartX + (i / maxSamples) * chartW;
      const sy = chartY + chartH - (spark[i] / 100) * chartH;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // Glow on the tip
    if (spark.length > 0) {
      const lastI = spark.length - 1;
      const tipX = chartX + (lastI / maxSamples) * chartW;
      const tipY = chartY + chartH - (spark[lastI] / 100) * chartH;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // Coverage text below sparkline
  ctx.fillStyle = color;
  ctx.font = "bold 12px monospace";
  ctx.fillText(`Cobertura: ${covStr}%`, boxX + 6, boxY + sparkH + textH);
}

export function bytesPerFrame() {
  return BYTES_PER_FRAME;
}
