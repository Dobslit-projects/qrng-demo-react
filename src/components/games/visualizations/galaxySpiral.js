const STAR_COUNT = 900;
const ARM_COUNT = 3;
const PERTURB_INTERVAL = 360; // frames (~6s at 60fps) — longer between perturbations

function createStars(count, bytes) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    const b1 = bytes[i % bytes.length] || Math.floor(Math.random() * 256);
    const b2 = bytes[(i + count) % bytes.length] || Math.floor(Math.random() * 256);

    // Spread stars across full canvas with mild center bias
    const rawR = b1 / 255;
    const radius = rawR * 0.88 + 0.05; // 0.05 to 0.93 — fills most of the canvas

    // Assign to spiral arm with spread
    const arm = i % ARM_COUNT;
    const armAngle = (arm / ARM_COUNT) * Math.PI * 2;
    const spiralTwist = radius * 4; // tighter spiral
    const spread = ((b2 / 255) - 0.5) * 0.6; // angular spread

    stars.push({
      angle: armAngle + spiralTwist + spread,
      radius,
      angularVel: 0.0005 / (radius + 0.05), // Keplerian-ish, slower rotation
      brightness: 0.3 + (b2 / 255) * 0.7,
      twinklePhase: (b1 / 255) * Math.PI * 2,
      twinkleSpeed: 0.001 + (b2 / 255) * 0.004, // very subtle twinkle, no pulsing feel
      size: 1.0 + (b1 / 255) * 2.0,
    });
  }
  return stars;
}

export function init(w, h, bytes) {
  return {
    stars: createStars(STAR_COUNT, bytes),
    frame: 0,
    bytesNeeded: 0,
  };
}

export function update(state, bytes) {
  state.frame++;

  // Perturb stars with new bytes periodically
  if (bytes.length >= STAR_COUNT && state.frame % PERTURB_INTERVAL === 0) {
    for (let i = 0; i < state.stars.length; i++) {
      const b = bytes[i % bytes.length];
      state.stars[i].twinklePhase += (b / 255) * 0.5;
      // Small positional perturbation
      state.stars[i].angle += ((b - 128) / 128) * 0.02;
    }
  }

  // Advance all stars
  for (const s of state.stars) {
    s.angle += s.angularVel;
    s.twinklePhase += s.twinkleSpeed;
  }

  state.bytesNeeded = state.frame % PERTURB_INTERVAL === PERTURB_INTERVAL - 1 ? STAR_COUNT : 0;
  return state;
}

export function draw(ctx, state, w, h, color) {
  // Dark background
  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) * 0.46;

  // Parse color
  const cr = parseInt(color.slice(1, 3), 16);
  const cg = parseInt(color.slice(3, 5), 16);
  const cb = parseInt(color.slice(5, 7), 16);

  ctx.globalCompositeOperation = "lighter";

  for (const s of state.stars) {
    const r = s.radius * maxR;
    const x = cx + Math.cos(s.angle) * r;
    const y = cy + Math.sin(s.angle) * r;

    const twinkle = 0.75 + 0.25 * Math.sin(s.twinklePhase); // subtle: 75%-100% range
    const alpha = s.brightness * twinkle;
    if (alpha < 0.05) continue;

    // Glow effect
    const grad = ctx.createRadialGradient(x, y, 0, x, y, s.size * 3);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha * 0.9})`);
    grad.addColorStop(0.3, `rgba(${cr},${cg},${cb},${alpha * 0.3})`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

    ctx.beginPath();
    ctx.arc(x, y, s.size * 3, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(x, y, s.size * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.7})`;
    ctx.fill();
  }

  ctx.globalCompositeOperation = "source-over";

  // Center glow
  const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.15);
  centerGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.15)`);
  centerGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = centerGrad;
  ctx.fill();
}

export function bytesPerRebuild() {
  return STAR_COUNT;
}
