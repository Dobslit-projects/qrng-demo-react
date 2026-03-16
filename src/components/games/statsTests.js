/**
 * Statistical tests for randomness quality assessment.
 * Based on NIST SP800-22 simplified versions.
 * Each test returns { passed, value, label }.
 */

/**
 * Monobit Frequency Test
 * Counts 1s vs 0s in the bit representation of bytes.
 * True random should be ~50/50.
 */
export function monobitTest(bytes) {
  if (bytes.length < 20) return { passed: null, value: "-", label: "Monobit" };

  let ones = 0;
  let total = 0;
  for (const b of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      if ((b >> bit) & 1) ones++;
      total++;
    }
  }

  const ratio = ones / total;
  // z-score: deviation from 0.5
  const s = (ones - total / 2) / Math.sqrt(total / 4);
  const pValue = Math.exp(-s * s / 2); // simplified p-value approximation
  const passed = Math.abs(ratio - 0.5) < 0.03; // within 3% of 50/50

  return {
    passed,
    value: `${(ratio * 100).toFixed(1)}%`,
    label: "Monobit",
  };
}

/**
 * Runs Test
 * Counts consecutive sequences of same bit value.
 * Random data should have a predictable number of runs.
 */
export function runsTest(bytes) {
  if (bytes.length < 20) return { passed: null, value: "-", label: "Runs" };

  // Extract bits
  const bits = [];
  for (const b of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      bits.push((b >> bit) & 1);
    }
  }

  const n = bits.length;
  const ones = bits.filter((b) => b === 1).length;
  const pi = ones / n;

  // Pre-test: if proportion is too far from 0.5, fail
  if (Math.abs(pi - 0.5) > 0.05) {
    return { passed: false, value: `${pi.toFixed(2)}`, label: "Runs" };
  }

  // Count runs
  let runs = 1;
  for (let i = 1; i < n; i++) {
    if (bits[i] !== bits[i - 1]) runs++;
  }

  const expectedRuns = 1 + 2 * n * pi * (1 - pi);
  const variance = 2 * n * pi * (1 - pi) * (2 * pi * (1 - pi) - 1 / n);
  const zScore = variance > 0 ? (runs - expectedRuns) / Math.sqrt(variance) : 0;
  const passed = Math.abs(zScore) < 2.58; // 99% confidence

  return {
    passed,
    value: `z=${zScore.toFixed(1)}`,
    label: "Runs",
  };
}

/**
 * Chi-Square Uniformity Test
 * Tests if byte values 0-255 are uniformly distributed.
 */
export function chiSquareTest(bytes) {
  if (bytes.length < 100) return { passed: null, value: "-", label: "Chi²" };

  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;

  const expected = bytes.length / 256;
  let chiSq = 0;
  for (let i = 0; i < 256; i++) {
    const diff = counts[i] - expected;
    chiSq += (diff * diff) / expected;
  }

  // Degrees of freedom = 255
  // For df=255, critical value at p=0.01 is ~310
  // For df=255, expected chi-sq is 255, std dev ~22.6
  const zScore = (chiSq - 255) / 22.6;
  const passed = chiSq < 310;

  return {
    passed,
    value: `${chiSq.toFixed(0)}`,
    label: "Chi²",
  };
}

/**
 * Shannon Entropy per byte
 * Maximum is 8.0 bits (perfectly random).
 */
export function shannonEntropy(bytes) {
  if (bytes.length < 20) return { passed: null, value: "-", label: "Entropia" };

  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;

  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] > 0) {
      const p = counts[i] / bytes.length;
      entropy -= p * Math.log2(p);
    }
  }

  // Max entropy = 8.0 for 256 possible values
  const passed = entropy > 7.5;

  return {
    passed,
    value: `${entropy.toFixed(2)}`,
    label: "Entropia",
  };
}
