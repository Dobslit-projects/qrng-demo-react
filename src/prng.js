export const LCG_A = 1103515245;
export const LCG_C = 12345;

export function lcgNext(seed) {
  const next = (Math.imul(seed, LCG_A) + LCG_C) >>> 0;
  return { value: (next >>> 16) / 65536, nextSeed: next };
}

export function generatePRNGSequence(seed, count) {
  const results = [];
  let s = seed;
  for (let i = 0; i < count; i++) {
    const r = lcgNext(s);
    results.push(r.value);
    s = r.nextSeed;
  }
  return results;
}

export function prngRandInt(seed, min, max) {
  const { value, nextSeed } = lcgNext(seed);
  return { result: min + Math.floor(value * (max - min + 1)), nextSeed };
}
