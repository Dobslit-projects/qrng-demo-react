/**
 * Motor de áudio para sonificação de números aleatórios.
 * Usa Web Audio API nativa — sem dependências externas.
 *
 * Shadow Tone: previsão toca 80ms ANTES do byte real.
 *  - PRNG: mesma frequência = uníssono harmônico
 *  - QRNG: frequência diferente = dissonância
 *
 * Rate-limited: máximo de ~15 nodes ativos por vez para evitar freeze.
 */

// Escala pentatônica (C, D, E, G, A) × 3 oitavas a partir de C4
const PENTATONIC_FREQS = (() => {
  const base = [261.63, 293.66, 329.63, 392.0, 440.0]; // C4 D4 E4 G4 A4
  const freqs = [];
  for (let oct = 0; oct < 3; oct++) {
    const mul = Math.pow(2, oct);
    for (const f of base) freqs.push(f * mul);
  }
  return freqs; // 15 notas: C4..A6
})();

function byteToFreq(byte) {
  const idx = Math.floor((byte / 256) * PENTATONIC_FREQS.length);
  return PENTATONIC_FREQS[Math.min(idx, PENTATONIC_FREQS.length - 1)];
}

const MAX_ACTIVE_NODES = 15;

export function createAudioEngine() {
  let ctx = null;
  let master = null;
  let enabled = false;
  let volume = 0.3;
  let activeNodes = 0;

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
    }
    return ctx;
  }

  function canPlay() {
    return enabled && activeNodes < MAX_ACTIVE_NODES;
  }

  function tone(freq, start, dur, wave, amp) {
    if (!canPlay()) return;
    const c = ensure();
    // Prevent negative or past start times
    const safeStart = Math.max(c.currentTime + 0.001, start);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, safeStart);
    g.gain.setValueAtTime(0.001, safeStart);
    g.gain.linearRampToValueAtTime(amp, safeStart + 0.005);
    g.gain.setValueAtTime(amp, safeStart + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, safeStart + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(safeStart);
    osc.stop(safeStart + dur + 0.02);
    activeNodes++;
    osc.onended = () => { activeNodes = Math.max(0, activeNodes - 1); };
  }

  return {
    resume() {
      const c = ensure();
      if (c.state === "suspended") c.resume();
    },

    setEnabled(v) {
      enabled = v;
      if (master) master.gain.value = v ? volume : 0;
    },

    isEnabled() {
      return enabled;
    },

    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master && enabled) master.gain.value = volume;
    },

    currentTime() {
      return ctx ? ctx.currentTime : 0;
    },

    /** Toca nota mapeada ao byte (escala pentatônica) */
    playNote(byte, time) {
      if (!canPlay()) return;
      const t = time || ensure().currentTime;
      tone(byteToFreq(byte), t, 0.08, "sine", 0.25);
    },

    /** Shadow tone: previsão antes do tempo */
    playPrediction(byte, time) {
      if (!canPlay()) return;
      const c = ensure();
      const t = time || c.currentTime;
      // Schedule slightly before (50ms) but never in the past
      const predTime = Math.max(c.currentTime + 0.001, t - 0.05);
      tone(byteToFreq(byte), predTime, 0.07, "triangle", 0.15);
    },

    /** Bell chime: previsão correta */
    playMatch(time) {
      if (!canPlay()) return;
      const t = time || ensure().currentTime;
      tone(1200, t, 0.12, "sine", 0.12);
    },

    /** Buzz: previsão errada */
    playMismatch(time) {
      if (!canPlay()) return;
      const t = time || ensure().currentTime;
      tone(110, t, 0.06, "sawtooth", 0.08);
    },

    /** Tick curto para coleta */
    playTick(time) {
      if (!canPlay()) return;
      const c = ensure();
      const t = Math.max(c.currentTime + 0.001, time || c.currentTime);
      const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.003), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      const g = c.createGain();
      src.buffer = buf;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.004);
      src.connect(g);
      g.connect(master);
      src.start(t);
      activeNodes++;
      src.onended = () => { activeNodes = Math.max(0, activeNodes - 1); };
    },

    dispose() {
      enabled = false;
      activeNodes = 0;
      if (ctx) {
        ctx.close();
        ctx = null;
        master = null;
      }
    },
  };
}
