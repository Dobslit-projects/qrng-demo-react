/**
 * Sonificação — Piano Roll + Histograma de Frequência.
 *
 * Mapeia cada byte para 1 de 15 notas pentatônicas (C4–A6).
 * PRNG com 8 níveis → apenas 8 das 15 notas tocam (índices pares).
 * QRNG com 256 níveis → todas as 15 notas, distribuição uniforme.
 */

const NOTE_NAMES = [
  "C4","D4","E4","G4","A4",
  "C5","D5","E5","G5","A5",
  "C6","D6","E6","G6","A6",
];
const NUM_NOTES = 15;
const FRAMES_PER_NOTE = 10; // ~6 notas/seg a 60fps
const MAX_HISTORY = 300;    // ~5 segundos visíveis
const LABEL_W = 28;
const HIST_RATIO = 0.18;    // 18% da largura para histograma

export function init() {
  return {
    frame: 0,
    bytesNeeded: 1,
    noteHistory: [],
    noteCounts: new Array(NUM_NOTES).fill(0),
    totalNotes: 0,
    currentNote: -1,
    audioEvents: [],
  };
}

export function update(state, bytes) {
  state.frame++;
  state.audioEvents = [];

  if (state.frame % FRAMES_PER_NOTE === 0 && bytes.length > 0) {
    const byte = bytes[0];
    const noteIndex = Math.min(Math.floor((byte / 256) * NUM_NOTES), NUM_NOTES - 1);

    state.noteHistory.push({ noteIndex, age: 0 });
    state.noteCounts[noteIndex]++;
    state.totalNotes++;
    state.currentNote = noteIndex;

    state.audioEvents.push({ type: "note", byte });
  }

  for (const n of state.noteHistory) n.age++;
  state.noteHistory = state.noteHistory.filter(n => n.age < MAX_HISTORY);

  state.bytesNeeded = 1;
  return state;
}

export function draw(ctx, state, w, h, color) {
  const cr = parseInt(color.slice(1, 3), 16);
  const cg = parseInt(color.slice(3, 5), 16);
  const cb = parseInt(color.slice(5, 7), 16);

  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, w, h);

  const topM = 22;
  const botM = 28;
  const pianoH = h - topM - botM;
  const rowH = pianoH / NUM_NOTES;

  const histW = w * HIST_RATIO;
  const rollW = w - LABEL_W - histW - 8;
  const rollX = LABEL_W;
  const histX = w - histW;

  // Title
  ctx.font = "bold 9px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.9)`;
  ctx.fillText("SONIFICACAO \u2014 ESCALA PENTATONICA", 6, 14);

  // Note labels + guide lines
  ctx.font = "7px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";

  for (let i = 0; i < NUM_NOTES; i++) {
    const row = NUM_NOTES - 1 - i;
    const y = topM + row * rowH + rowH / 2;

    const active = state.currentNote === i;
    ctx.fillStyle = active
      ? "rgba(255,255,255,0.95)"
      : `rgba(${cr},${cg},${cb},0.4)`;
    ctx.fillText(NOTE_NAMES[i], LABEL_W - 4, y + 3);

    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.06)`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(rollX, y);
    ctx.lineTo(rollX + rollW, y);
    ctx.stroke();
  }

  // Piano roll bars
  for (const note of state.noteHistory) {
    const row = NUM_NOTES - 1 - note.noteIndex;
    const y = topM + row * rowH + rowH * 0.15;
    const barH = rowH * 0.7;

    const ageRatio = note.age / MAX_HISTORY;
    const x = rollX + rollW * (1 - ageRatio);
    const barW = Math.max(2, (rollW / MAX_HISTORY) * 3);

    const alpha = Math.max(0, 1 - ageRatio) * 0.7;

    // Glow for recent
    if (note.age < 8) {
      const ga = (1 - note.age / 8) * 0.3;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${ga})`;
      ctx.fillRect(x - 2, y - 2, barW + 4, barH + 4);
    }

    ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
    ctx.fillRect(x, y, barW, barH);
  }

  // Frequency histogram
  const maxCount = Math.max(1, ...state.noteCounts);
  const barMaxW = histW - 8;

  ctx.font = "6px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";

  for (let i = 0; i < NUM_NOTES; i++) {
    const row = NUM_NOTES - 1 - i;
    const y = topM + row * rowH + rowH * 0.2;
    const barH = rowH * 0.6;
    const barW = (state.noteCounts[i] / maxCount) * barMaxW;

    // Background track
    ctx.fillStyle = `rgba(${cr},${cg},${cb},0.08)`;
    ctx.fillRect(histX + 4, y, barMaxW, barH);

    // Fill
    ctx.fillStyle = state.noteCounts[i] > 0
      ? `rgba(${cr},${cg},${cb},0.5)`
      : `rgba(${cr},${cg},${cb},0.02)`;
    ctx.fillRect(histX + 4, y, barW, barH);

    // Count
    if (state.noteCounts[i] > 0) {
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.4)`;
      ctx.fillText(String(state.noteCounts[i]), histX + barW + 8, y + barH - 1);
    }
  }

  // Current note indicator
  if (state.currentNote >= 0) {
    ctx.font = "bold 11px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(${cr},${cg},${cb},0.8)`;
    ctx.fillText(`\u266A ${NOTE_NAMES[state.currentNote]}`, w / 2, h - 8);
  }

  // Total counter
  ctx.font = "7px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${cr},${cg},${cb},0.4)`;
  ctx.fillText(`${state.totalNotes} notas`, w - 6, h - 8);
}

export function bytesPerFrame() {
  return 1;
}
