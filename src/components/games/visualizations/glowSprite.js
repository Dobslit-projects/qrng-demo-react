// Sprites de brilho em cache (2º revisor, 2026-10-16): Galáxia e Mandala
// criavam um `createRadialGradient` + `arc` + `fill` POR estrela/ponto POR
// quadro (900 estrelas, ou 1200 pontos × 8 simetrias × 2 espelhos) — o custo
// de construir gradientes derrubava o quadro para 4–8 fps. Agora cada
// combinação (cor quantizada, raio) é rasterizada UMA vez num canvas
// offscreen e desenhada com drawImage + globalAlpha.
const cache = new Map();
const MAX_CACHE = 512;

function quantize(c) { return Math.round(c / 16) * 16; }

/**
 * @param {number} r,g,b  cor 0–255
 * @param {number} radius raio do brilho em px (quantizado para inteiro)
 * @param {number[][]} stops  [[offset, alphaMultiplier], ...]
 * @returns {HTMLCanvasElement}
 */
export function getGlowSprite(r, g, b, radius, stops = [[0, 0.9], [0.3, 0.3], [1, 0]]) {
  const rad = Math.max(1, Math.round(radius));
  const qr = quantize(r), qg = quantize(g), qb = quantize(b);
  const key = `${qr},${qg},${qb},${rad},${stops.map((s) => s.join(":")).join("|")}`;
  let sprite = cache.get(key);
  if (sprite) return sprite;
  sprite = document.createElement("canvas");
  sprite.width = sprite.height = rad * 2;
  const ctx = sprite.getContext("2d");
  const grad = ctx.createRadialGradient(rad, rad, 0, rad, rad, rad);
  for (const [off, a] of stops) grad.addColorStop(off, `rgba(${qr},${qg},${qb},${a})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(rad, rad, rad, 0, Math.PI * 2);
  ctx.fill();
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, sprite);
  return sprite;
}

/** Desenha o sprite centrado em (x, y) com a opacidade dada. */
export function drawGlow(ctx, sprite, x, y, alpha) {
  const rad = sprite.width / 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - rad, y - rad);
  ctx.globalAlpha = 1;
}
