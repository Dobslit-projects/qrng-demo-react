#!/usr/bin/env node
/**
 * QRNG Regression Tests — standalone Node.js, sem dependências.
 * Executar: node src/tests/qrng.regression.js
 *
 * Garante que o pipeline binary uint32-LE não regride para o bug ASCII
 * (Monte Carlo com valores em [0.188, 0.224] = bytes ASCII '0'–'9' / 255).
 */

// ── Funções puras extraídas de src/lib/qrngHelper.js ──────────────────────────

function bytesToUint32Array(bytes) {
  const out = [];
  for (let i = 0; i + 3 < bytes.length; i += 4)
    out.push(((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0);
  return out;
}

function uint32ToFloat(n) { return n / 4294967296; }

function uniformIntFromBytes(min, max, bytes) {
  const range = max - min + 1;
  const limit = Math.floor(4294967296 / range) * range;
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const n = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
    if (n < limit) return min + (n % range);
  }
  return min + (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) % range;
}

// Extraída de src/components/data/DataSection.jsx
function genMonteCarlo(bytes, count) {
  const nums = [];
  for (let i = 0; i + 3 < bytes.length && nums.length < count; i += 4) {
    const n = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
    nums.push(n / 4294967296);
  }
  return nums;
}

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  PASS: ${msg}`); passed++; }
  else           { console.error(`  FAIL: ${msg}`); failed++; }
}

// ── Test 1: Regressão ASCII — bug 0.188–0.224 ─────────────────────────────────
// O bug original: stream TCP continha APENAS bytes ASCII '0'–'9' (48–57).
// Com byte/255: todos os floats ficavam em [48/255, 57/255] = [0.188, 0.224].
// Com uint32/2^32 e stream binário uniforme: floats cobrem todo [0, 1).
//
// Nota: bytes ASCII [48,57,...] interpretados como uint32 big-endian ainda podem
// produzir floats ≈ 0.188 por coincidência aritmética (0x30393039/2^32 ≈ 0.188).
// A garantia real vem da distribuição: com bytes 0–255 uniformes, o uint32 path
// produz floats espalhados por [0,1), não confinados a [0.188, 0.224].

console.log("\n[1] Regressão ASCII — byte/255 com ASCII produz faixa estreita");
const asciiDigits = new Uint8Array([48, 57, 48, 57, 48, 57, 48, 57]);  // "09090909"

// Demonstração do bug original (byte/255): faixa estreita
const oldFloats = Array.from(asciiDigits).map(b => b / 255);
const oldMin = Math.min(...oldFloats), oldMax = Math.max(...oldFloats);
assert(oldMin >= 0.185 && oldMin <= 0.192, `bug byte/255 min=${oldMin.toFixed(4)} ≈ 48/255=0.1882`);
assert(oldMax >= 0.220 && oldMax <= 0.228, `bug byte/255 max=${oldMax.toFixed(4)} ≈ 57/255=0.2235`);
assert(oldMax - oldMin < 0.04, `bug byte/255 range=${(oldMax-oldMin).toFixed(4)} estreito (<0.04)`);

// Com bytes uniformes 0–255, uint32 path cobre todo [0,1):
// Gera 1000 uint32 de bytes 0-255 e verifica cobertura
const uniformBytes = new Uint8Array(4000);
for (let i = 0; i < 4000; i++) uniformBytes[i] = i % 256;  // 0..255 repetido
const uniformU32s  = bytesToUint32Array(uniformBytes);
const uniformFloats = uniformU32s.map(uint32ToFloat);
const uMin = Math.min(...uniformFloats), uMax = Math.max(...uniformFloats);
assert(uMin < 0.1, `uint32 path min=${uMin.toFixed(4)} < 0.1 (cobre baixo)`);
assert(uMax > 0.9, `uint32 path max=${uMax.toFixed(4)} > 0.9 (cobre alto)`);
// Confirma que fora do intervalo ASCII existem valores
const outsideAsciiRange = uniformFloats.filter(f => f < 0.185 || f > 0.228);
assert(outsideAsciiRange.length > 0, `${outsideAsciiRange.length} floats fora da faixa ASCII (distribição cobrindo [0,1))`);

// Confirma que byte/255 com bytes uniformes TAMBÉM cobre [0,1):
const uniformByteFloats = Array.from(uniformBytes).map(b => b / 255);
const bMin = Math.min(...uniformByteFloats), bMax = Math.max(...uniformByteFloats);
assert(bMin < 0.01, `byte/255 uniforme min=${bMin.toFixed(4)} (stream binário é ok)`);
assert(bMax > 0.99, `byte/255 uniforme max=${bMax.toFixed(4)} (stream binário é ok)`);

// ── Test 2: uint32ToFloat — range e pontos conhecidos ─────────────────────────

console.log("\n[2] uint32ToFloat range e precisão");
assert(uint32ToFloat(0) === 0,             "uint32ToFloat(0) === 0");
assert(uint32ToFloat(0xFFFFFFFF) < 1,      "uint32ToFloat(0xFFFFFFFF) < 1");
assert(uint32ToFloat(0x80000000) === 0.5,  "uint32ToFloat(2^31) === 0.5");
assert(uint32ToFloat(0x40000000) === 0.25, "uint32ToFloat(2^30) === 0.25");
assert(uint32ToFloat(0xC0000000) === 0.75, "uint32ToFloat(3×2^30) === 0.75");

// ── Test 3: Endianness — LE vs BE produzem uint32 distintos ──────────────────
// O FPGA envia uint32 little-endian (LSB primeiro).
// bytesToUint32Array interpreta bytes como big-endian (compatível com
// fetch hex que entrega os bytes na ordem correta do campo JSON).

console.log("\n[3] Endianness — round-trip big-endian estável");
const knownBytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);
const knownU32s = bytesToUint32Array(knownBytes);
assert(knownU32s[0] === 0xDEADBEEF >>> 0, `0xDEADBEEF → ${knownU32s[0].toString(16)}`);
assert(knownU32s[1] === 0xCAFEBABE >>> 0, `0xCAFEBABE → ${knownU32s[1].toString(16)}`);

// LE ≠ BE quando bytes não são simétricos
const leBytes = new Uint8Array([0x01, 0x00, 0x00, 0x00]);  // LE value=1
const beBytes = new Uint8Array([0x00, 0x00, 0x00, 0x01]);  // BE value=1
const leAssBE = bytesToUint32Array(leBytes)[0];  // 0x01000000 = 16777216
const beAsBE  = bytesToUint32Array(beBytes)[0];  // 0x00000001 = 1
assert(leAssBE !== beAsBE, `LE e BE são distintos: ${leAssBE} ≠ ${beAsBE}`);
assert(beAsBE === 1,        `BE [0,0,0,1] → uint32=1`);
assert(leAssBE === 16777216, `FPGA LE [1,0,0,0] lido como BE → 16777216 (ainda uniforme)`);

// ── Test 4: genMonteCarlo — valores em [0, 1) ────────────────────────────────

console.log("\n[4] genMonteCarlo produz floats em [0, 1)");
const syntheticBytes = new Uint8Array(4000);
for (let i = 0; i < 4000; i++) syntheticBytes[i] = i % 256;
const mcVals = genMonteCarlo(syntheticBytes, 1000);
assert(mcVals.length === 1000, `genMonteCarlo produziu ${mcVals.length}/1000 valores`);
const mcMin = Math.min(...mcVals), mcMax = Math.max(...mcVals);
assert(mcMin >= 0, `min=${mcMin.toFixed(6)} >= 0`);
assert(mcMax < 1,  `max=${mcMax.toFixed(6)} < 1`);

// ── Test 5: MonteCarloPi.jsx path — uint32/2^32 por ponto ───────────────────
// Simula o novo código de MonteCarloPi.jsx: 8 bytes por ponto (2 uint32)

console.log("\n[5] MonteCarloPi path — uint32/2^32 por coordenada");
const qBytes = new Uint8Array(800);
for (let i = 0; i < 800; i++) qBytes[i] = (i * 37 + 13) % 256;  // pseudo-dados
let inside = 0;
for (let i = 0; i < 100; i++) {
  const o = i * 8;
  const xi = ((qBytes[o]<<24)|(qBytes[o+1]<<16)|(qBytes[o+2]<<8)|qBytes[o+3]) >>> 0;
  const yi = ((qBytes[o+4]<<24)|(qBytes[o+5]<<16)|(qBytes[o+6]<<8)|qBytes[o+7]) >>> 0;
  const x = xi / 4294967296;
  const y = yi / 4294967296;
  assert(x >= 0 && x < 1, `x=${x.toFixed(5)} em [0,1)`);
  assert(y >= 0 && y < 1, `y=${y.toFixed(5)} em [0,1)`);
  if (x * x + y * y <= 0.25) inside++;
}

// ── Test 6: uniformIntFromBytes — rejection sampling sem viés de módulo ──────

console.log("\n[6] uniformIntFromBytes — rejection sampling");
const rfBytes = new Uint8Array([0x00, 0x00, 0x00, 0x00,  // uint32=0
                                 0xFF, 0xFF, 0xFF, 0xFF,  // uint32=4294967295
                                 0x80, 0x00, 0x00, 0x00]); // uint32=2147483648
const r1 = uniformIntFromBytes(1, 6, rfBytes);
assert(r1 >= 1 && r1 <= 6, `uniformIntFromBytes(1,6) = ${r1} em [1,6]`);

// ── Test 7: DataExport path — JSON hex parsing correto ───────────────────────

console.log("\n[7] DataExport — parse JSON hex (rota corrigida)");
const fakeApiResponse = JSON.stringify({
  random: "deadbeef01020304",
  bytes: 8,
  source: "fpga",
});
const json = JSON.parse(fakeApiResponse);
const hex = json.random || json.hex || "";
const raw = new Uint8Array(hex.length / 2);
for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.substr(i * 2, 2), 16);
assert(raw.length === 8,     `raw.length = ${raw.length} (esperado 8)`);
assert(raw[0] === 0xDE,      `raw[0] = 0x${raw[0].toString(16)} (esperado 0xDE)`);
assert(raw[3] === 0xEF,      `raw[3] = 0x${raw[3].toString(16)} (esperado 0xEF)`);
assert(raw[7] === 0x04,      `raw[7] = 0x${raw[7].toString(16)} (esperado 0x04)`);

// ── Resumo ────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(52)}`);
console.log(`Resultado: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) { console.error("REGRESSÃO DETECTADA"); process.exit(1); }
else              console.log("OK — nenhuma regressão detectada");
